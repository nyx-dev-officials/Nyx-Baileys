import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';

import { silentLogger } from '../utils/logger.js';
import type { Logger, SessionState, SessionStore } from '../utils/types.js';

import type { KeyStoreData, SignalKeyStoreLike } from './session-sqlite.js';

/**
 * SQL-backed session store, expressed against a Prisma-shaped client.
 *
 * No generated client is imported. This file declares the exact delegate
 * surface it calls and you hand it a real `PrismaClient` (structurally typed,
 * so no cast at the call site) or any test double. That keeps `@prisma/client`
 * a peer concern instead of a hard dependency, and it keeps this adapter
 * swappable for Drizzle/Knex/TypeORM, which all offer the same upsert shape.
 *
 * ── Required schema ───────────────────────────────────────────────────────
 * Two models. Values are JSON strings in `Text` columns, encoded with
 * Baileys' `BufferJSON` replacer — which is what makes `Uint8Array` Signal key
 * material survive the round trip. Plain `JSON.stringify` would turn a 32-byte
 * key into `{"0":1,"1":2,…}` and silently desync the ratchet. (On Postgres you
 * may prefer `Bytes @db.ByteA` over `String @db.Text` and skip the encoding;
 * the column type is the only thing that changes.)
 *
 *   model Session {
 *     sessionId String   @id @db.VarChar(128)   // isolation lives in this column
 *     creds     String   @db.Text
 *     meta      String?  @db.Text
 *     updatedAt DateTime @updatedAt
 *   }
 *
 *   model SessionKey {
 *     id        String   @id @default(cuid())
 *     sessionId String   @db.VarChar(128)
 *     type      String   @db.VarChar(64)       // 'pre-key' | 'sender-key' | …
 *     keyId     String   @db.VarChar(191)
 *     value     String   @db.Text
 *     updatedAt DateTime @updatedAt
 *
 *     @@unique([sessionId, type, keyId], name: "sessionId_type_keyId_unq")
 *     @@index([sessionId])
 *   }
 *
 * Why a composite unique instead of a global `keyId`: `keyId` is only unique
 * *within* a type and *within* a session — `sender-key:<chat-jid>` repeats per
 * account. A globally unique `keyId` would either collide between two accounts
 * or force invented global prefixes, and it would not give per-tenant isolation
 * for free. With `[sessionId, type, keyId]` unique, every `upsert` below is
 * naturally scoped: a forgotten `sessionId` produces a wrong-but-valid row in
 * the wrong tenant rather than mutating someone else's session. Isolation is
 * enforced by the database, not by application discipline.
 *
 * ── Why the transaction matters ───────────────────────────────────────────
 * Creds and keys are one auth state. If the credential row commits and the key
 * rows do not, the next connect loads new creds against a stale Signal key
 * store, WhatsApp rejects the handshake, and the session is unrecoverable
 * without re-pairing — a self-inflicted logout that no retry can fix. So key
 * mutations are buffered in memory and flushed together with the credential row
 * in a single `$transaction`. Either the whole auth state advances one step, or
 * none of it does.
 */

/** Delegate subset of `prisma.session`. */
export interface PrismaSessionDelegate {
  upsert(args: {
    where: { sessionId: string };
    create: { sessionId: string; creds: string; meta: string | null };
    update: { creds: string; meta: string | null };
  }): Promise<unknown>;
  findUnique(args: { where: { sessionId: string } }): Promise<PrismaSessionRow | null>;
  deleteMany(args: { where: { sessionId: string } }): Promise<unknown>;
}

/** Delegate subset of `prisma.sessionKey`. */
export interface PrismaSessionKeyDelegate {
  upsert(args: {
    where: { sessionId_type_keyId: { sessionId: string; type: string; keyId: string } };
    create: { sessionId: string; type: string; keyId: string; value: string };
    update: { value: string };
  }): Promise<unknown>;
  findMany(args: { where: { sessionId: string; type: string; keyId: { in: string[] } } }): Promise<
    Array<{ keyId: string; value: string }>
  >;
  /**
   * `type`/`keyId` are optional so a logout can wipe every key row for a
   * session in one statement, and a key eviction can stay narrowly scoped.
   */
  deleteMany(args: {
    where: { sessionId: string; type?: string; keyId?: { in: string[] } };
  }): Promise<unknown>;
}

/** The transaction handle Prisma passes to `$transaction`'s callback. */
export interface PrismaTransactionClient {
  session: PrismaSessionDelegate;
  sessionKey: PrismaSessionKeyDelegate;
}

/** The client subset this store needs. A real `PrismaClient` satisfies it. */
export interface PrismaLikeClient {
  session: PrismaSessionDelegate;
  sessionKey: PrismaSessionKeyDelegate;
  $transaction<T>(fn: (tx: PrismaTransactionClient) => Promise<T>): Promise<T>;
}

/** Row shape returned by `Session.findUnique`. */
export interface PrismaSessionRow {
  sessionId: string;
  creds: string;
  meta?: string | null;
}

export interface PrismaSessionStoreOptions {
  /** Unique per account. Scopes every query and every key row. */
  sessionId: string;
  client: PrismaLikeClient;
  logger?: Logger;
}

export class PrismaSessionStore implements SessionStore {
  readonly name = 'prisma';

  readonly #sessionId: string;
  readonly #client: PrismaLikeClient;
  readonly #log: Logger;

  /**
   * Write-behind buffer of Signal key mutations, keyed `type` then `keyId`.
   *
   * Presence in the map means "touched" — which is distinct from the value
   * being falsy, since a falsy value means *delete*. Keeping that distinction
   * explicit is what stops `deleteMany` from eating keys that were merely never
   * written.
   */
  readonly #pending = new Map<string, Map<string, unknown | null>>();

  #state: SessionState | null = null;
  #meta: Record<string, unknown> = {};

  constructor(options: PrismaSessionStoreOptions) {
    if (!options.sessionId) throw new Error('prisma session store requires a sessionId');
    this.#sessionId = options.sessionId;
    this.#client = options.client;
    this.#log = options.logger ?? silentLogger;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  async init(): Promise<{ state: SessionState; saveCreds: () => Promise<void> }> {
    if (this.#state) return { state: this.#state, saveCreds: () => this.save() };

    const row = await this.#client.session.findUnique({ where: { sessionId: this.#sessionId } });

    let creds: Record<string, unknown> = {};
    if (row?.creds) {
      try {
        creds = JSON.parse(row.creds, BufferJSON.reviver) as Record<string, unknown>;
      } catch (err) {
        // Do not paper over a corrupt row by writing fresh creds over it: that
        // would destroy a session that might still be recoverable by hand.
        this.#log.error('stored creds are unparseable; refusing to overwrite', {
          sessionId: this.#sessionId,
          err: (err as Error).message,
        });
        throw new Error(`unparseable creds for session ${this.#sessionId}`, { cause: err });
      }
    }
    if (Object.keys(creds).length === 0) {
      creds = initAuthCreds() as unknown as Record<string, unknown>;
    }

    if (row?.meta) {
      try {
        this.#meta = JSON.parse(row.meta, BufferJSON.reviver) as Record<string, unknown>;
      } catch {
        this.#meta = {};
      }
    }

    const keys = this.#buildKeyStore();
    this.#state = { creds, keys };
    return { state: this.#state, saveCreds: () => this.save() };
  }

  /**
   * Commit credentials and any buffered key mutations in one transaction.
   *
   * This is the call Baileys makes from `creds.update`, so it is also the
   * natural flush point for the key store — which is what makes the pair atomic.
   */
  async save(): Promise<void> {
    if (!this.#state) throw new Error('prisma session store used before init()');

    const creds = this.#state.creds;
    const meta = this.#meta;
    const pending = this.#drainPending();

    await this.#client.$transaction(async (tx) => {
      await tx.session.upsert({
        where: { sessionId: this.#sessionId },
        create: {
          sessionId: this.#sessionId,
          creds: JSON.stringify(creds, BufferJSON.replacer),
          meta: JSON.stringify(meta, BufferJSON.replacer),
        },
        update: {
          creds: JSON.stringify(creds, BufferJSON.replacer),
          meta: JSON.stringify(meta, BufferJSON.replacer),
        },
      });

      // Same transaction, so the key store can never lag the creds.
      for (const [type, entries] of pending) {
        await this.#applyPending(tx, type, entries);
      }
    });
  }

  /**
   * Swap the buffer for a fresh one *before* awaiting.
   *
   * Doing it in this order means a `set()` that lands while the transaction is
   * in flight is queued for the next commit instead of being silently dropped
   * when the old buffer is cleared.
   */
  #drainPending(): Array<[string, Map<string, unknown | null>]> {
    const drained: Array<[string, Map<string, unknown | null>]> = [];
    for (const [type, entries] of this.#pending) drained.push([type, entries]);
    this.#pending.clear();
    return drained;
  }

  #applyPending(
    tx: PrismaTransactionClient,
    type: string,
    entries: Map<string, unknown | null>,
  ): Promise<unknown> {
    const writes: Array<Promise<unknown>> = [];
    const doomed: string[] = [];

    for (const [keyId, value] of entries) {
      if (value) {
        writes.push(
          tx.sessionKey.upsert({
            where: { sessionId_type_keyId: { sessionId: this.#sessionId, type, keyId } },
            create: {
              sessionId: this.#sessionId,
              type,
              keyId,
              value: JSON.stringify(value, BufferJSON.replacer),
            },
            update: { value: JSON.stringify(value, BufferJSON.replacer) },
          }),
        );
      } else {
        doomed.push(keyId);
      }
    }

    const tasks: Array<Promise<unknown>> = [...writes];
    if (doomed.length > 0) {
      tasks.push(
        tx.sessionKey.deleteMany({
          where: { sessionId: this.#sessionId, type, keyId: { in: doomed } },
        }),
      );
    }
    return Promise.all(tasks).then(() => undefined);
  }

  /**
   * The `SignalKeyStore` Baileys talks to.
   *
   * Semantics copied from upstream's multi-file store because deviating
   * desyncs Signal: `get` returns an entry for **every** requested id (`null`
   * when absent), and `set` treats a falsy value as a **delete**.
   */
  #buildKeyStore(): SignalKeyStoreLike {
    const sessionId = this.#sessionId;

    return {
      get: async (type: string, ids: string[]): Promise<Record<string, unknown>> => {
        const out: Record<string, unknown> = {};
        const overlay = this.#pending.get(type);
        const missing: string[] = [];

        // Pending mutations win over the database: they are newer, and reading
        // through them keeps a get-after-set in the same tick consistent.
        for (const id of ids) {
          if (overlay?.has(id)) {
            out[id] = overlay.get(id) ?? null;
          } else {
            missing.push(id);
          }
        }

        if (missing.length > 0) {
          const rows = await this.#client.sessionKey.findMany({
            where: { sessionId, type, keyId: { in: missing } },
          });
          const found = new Map(rows.map((row) => [row.keyId, row.value]));
          for (const id of missing) {
            const raw = found.get(id);
            if (raw === undefined) {
              out[id] = null;
              continue;
            }
            let value: unknown = null;
            try {
              value = JSON.parse(raw, BufferJSON.reviver);
            } catch (err) {
              // One unreadable key row should cost that key, not the session.
              this.#log.warn('key row unparseable; treating as absent', {
                sessionId,
                type,
                keyId: id,
                err: (err as Error).message,
              });
              out[id] = null;
              continue;
            }
            out[id] =
              type === 'app-state-sync-key' && value
                ? proto.Message.AppStateSyncKeyData.fromObject(value as proto.Message.IAppStateSyncKeyData)
                : value;
          }
        }

        return out;
      },

      set: async (data: KeyStoreData): Promise<void> => {
        // Buffered, not written. `creds.update` follows within the same tick and
        // carries the commit; `flush()` covers the case where it does not.
        for (const type of Object.keys(data)) {
          const entries = data[type];
          if (!entries) continue;
          let bucket = this.#pending.get(type);
          if (!bucket) {
            bucket = new Map<string, unknown | null>();
            this.#pending.set(type, bucket);
          }
          for (const keyId of Object.keys(entries)) {
            const value = entries[keyId];
            bucket.set(keyId, value ? value : null);
          }
        }
      },

      clear: async (): Promise<void> => {
        // Drop persisted rows and the buffer together, so a key re-written
        // after this point cannot be resurrected from memory.
        await this.#client.$transaction((tx) =>
          tx.sessionKey.deleteMany({ where: { sessionId } }).then(() => undefined),
        );
        this.#pending.clear();
      },
    };
  }

  /** Force a key-store commit without waiting for the next `creds.update`. */
  async flush(): Promise<void> {
    if (this.#pending.size === 0) return;
    const pending = this.#drainPending();
    await this.#client.$transaction(async (tx) => {
      for (const [type, entries] of pending) {
        await this.#applyPending(tx, type, entries);
      }
    });
  }

  /* ── sidecar ─────────────────────────────────────────────────────────── */

  async get<T>(key: string, fallback: T): Promise<T> {
    const value = this.#meta[key];
    return value === undefined ? fallback : (value as T);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.#meta[key] = value;
    await this.save();
  }

  /** Logout: drop the credential row and every key row for this session. */
  async clear(): Promise<void> {
    // One transaction so a logout cannot half-apply: either the account is
    // fully forgotten, or nothing is. A partial wipe leaves creds without keys,
    // which reads as "signed out" to the user but still occupies the identity.
    await this.#client.$transaction(async (tx) => {
      await tx.session.deleteMany({ where: { sessionId: this.#sessionId } });
      await tx.sessionKey.deleteMany({ where: { sessionId: this.#sessionId } });
    });
    this.#pending.clear();
    this.#meta = {};
    this.#state = null;
  }
}

export default PrismaSessionStore;