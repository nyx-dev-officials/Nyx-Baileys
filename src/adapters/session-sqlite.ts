import { open, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';

import { silentLogger } from '../utils/logger.js';
import type { Logger, SessionState, SessionStore } from '../utils/types.js';

/**
 * File/single-document session store.
 *
 * Named "sqlite" because that is what it is usually wired to — but the point
 * of this adapter is that the *persistence function is injected*. The store
 * never opens a database; it serialises `{ creds, keys }` to a string and hands
 * that string to whatever you gave it. A real `better-sqlite3` handle, a
 * `node:sqlite` handle, a KV table, or a plain file all satisfy the same
 * three-method interface, so this file carries no native dependency and no
 * driver-specific SQL.
 *
 * The blob shape is deliberate for a file, but it is NOT what you want in a real
 * SQL deployment: creds and the Signal key store both grow without bound, and
 * a single row/column holding every pre-key is what makes a `TEXT` column start
 * failing at scale. Use `session-prisma.ts` (row per `(session, type, id)`) or
 * `session-mongo.ts` once you are past a single node.
 *
 * Two correctness properties are load-bearing here and are why this is not just
 * `writeFile(JSON.stringify(state))`:
 *
 *  1. **Atomic writes.** A truncated auth file is an unrecoverable session —
 *     WhatsApp will not accept a partial key store and the number must re-pair.
 *     We write a temp file, fsync it, then `rename()` over the target, so a
 *     crash at any instant leaves either the old file or the new one, never a
 *     half-written one.
 *  2. **Per-key serialisation.** `creds.update` fires in bursts from many
 *     places inside Baileys. Interleaved read-modify-write on the same document
 *     loses writes. Upstream hit this too (`use-multi-file-auth-state` keeps a
 *     `Map` of mutexes keyed by path — see the linked Node/Baileys issue), so
 *     the lock map below is deliberately *module-level*: two store instances in
 *     one process pointing at the same session must serialise too, and an
 *     instance-level lock would not protect that case.
 */

/** Argument to `SignalKeyStore.set`. Mirrors upstream's `SignalDataSet`. */
export type KeyStoreData = Record<string, Record<string, unknown | null> | undefined>;

/**
 * Structural mirror of upstream `SignalKeyStore`.
 *
 * Declared locally rather than imported so this file has no coupling to Baileys'
 * internal generics; it is assignment-compatible with the upstream type.
 */
export interface SignalKeyStoreLike {
  get(type: string, ids: string[]): Promise<Record<string, unknown>>;
  set(data: KeyStoreData): Promise<void>;
  clear(): Promise<void>;
}

/**
 * The injected persistence function.
 *
 * Strings in, strings out — this adapter owns JSON encoding, so an alternative
 * backend can encrypt or compress without the store knowing.
 */
export interface SqlitePersistence {
  /** Return the stored document, or `null` when the session has no state yet. */
  read(sessionId: string): Promise<string | null>;
  /** Must be atomic: never leave a partially written document behind. */
  write(sessionId: string, payload: string): Promise<void>;
  /** Drop the document entirely (logout). Missing rows are not an error. */
  remove(sessionId: string): Promise<void>;
}

export interface FilePersistenceOptions {
  /** Directory holding one JSON document per session. */
  dir: string;
  /**
   * fsync the temp file before renaming. Costs one fsync per save; on a
   * container with a volatile overlay it buys you nothing, on a real disk it
   * buys you durability across power loss. Defaults to true.
   */
  fsync?: boolean;
  /** Rename retries for Windows `EPERM`/`EBUSY` when a reader holds the file. */
  renameRetries?: number;
  logger?: Logger;
}

export interface SqliteSessionStoreOptions {
  /** Identifies the account. Doubles as the persistence key and file name. */
  sessionId: string;
  /** Where to read/write. Usually `createFilePersistence`. */
  persistence: SqlitePersistence;
  logger?: Logger;
}

/** Shape of the persisted document. */
interface StoredDocument {
  creds: Record<string, unknown>;
  /** Key store material, keyed by Signal data type then key id. */
  keys: Record<string, Record<string, unknown>>;
  /** Free-form sidecar data for `SessionStore.get`/`set`. */
  meta?: Record<string, unknown>;
}

/* ── per-key locking ─────────────────────────────────────────────────────── */

/**
 * Tail of the write queue per persistence key.
 *
 * Module-level on purpose: see the atomicity note in the file header. Entries
 * hold a settled-on-both-branches promise so one failed writer cannot poison
 * the queue for the writers behind it.
 */
const keyLocks = new Map<string, Promise<void>>();

async function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = keyLocks.get(key) ?? Promise.resolve();

  // Run `fn` whether the prior task settled or rejected — a failed write must
  // not strand every later write behind it.
  const run = prior.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  keyLocks.set(key, tail);

  try {
    return await run;
  } finally {
    // Only clear the slot if nothing else queued behind us; otherwise we would
    // drop the chain and let two writers run concurrently.
    if (keyLocks.get(key) === tail) keyLocks.delete(key);
  }
}

/* ── default file persistence ────────────────────────────────────────────── */

/**
 * Session ids reach us as filenames, so they are untrusted input. Reject
 * anything that could traverse or collide rather than sanitising silently into
 * two sessions sharing one file.
 */
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

function assertSafeSessionId(sessionId: string): string {
  if (!SAFE_ID.test(sessionId)) {
    throw new Error(
      `unsafe sessionId ${JSON.stringify(sessionId)}: expected 1-128 chars of [A-Za-z0-9._-]`,
    );
  }
  // `.`/`..` would still resolve outside the session directory.
  if (sessionId === '.' || sessionId === '..') {
    throw new Error(`unsafe sessionId ${JSON.stringify(sessionId)}`);
  }
  return sessionId;
}

function isTransientFsError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  // Windows returns EPERM/EBUSY when a concurrent reader has the file open.
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

/**
 * The default persistence: one JSON file per session, written atomically.
 *
 * Temp file in the *same directory* (so `rename()` stays within one filesystem
 * and is therefore atomic), fsync, then rename.
 */
export function createFilePersistence(options: FilePersistenceOptions): SqlitePersistence {
  const { dir, fsync = true, renameRetries = 5 } = options;
  const log = options.logger ?? silentLogger;

  const pathFor = (sessionId: string): string => join(dir, `${assertSafeSessionId(sessionId)}.json`);

  return {
    async read(sessionId: string): Promise<string | null> {
      try {
        return await readFile(pathFor(sessionId), 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },

    async write(sessionId: string, payload: string): Promise<void> {
      const target = pathFor(sessionId);
      await mkdir(dir, { recursive: true });

      // Same-directory temp file; the random suffix keeps two processes that
      // share a directory from clobbering each other's staging file.
      const tmp = `${target}.${process.pid.toString(36)}.${Math.random().toString(36).slice(2, 10)}.tmp`;

      try {
        const handle = await open(tmp, 'w');
        try {
          await handle.writeFile(payload, 'utf8');
          if (fsync) await handle.sync();
        } finally {
          await handle.close();
        }

        // Retry: on Windows the rename can transiently fail while a reader has
        // the destination open. Exponential-ish backoff, bounded.
        for (let attempt = 0; ; attempt += 1) {
          try {
            await rename(tmp, target);
            break;
          } catch (err) {
            if (!isTransientFsError(err) || attempt >= renameRetries) {
              await rm(tmp, { force: true }).catch(() => {});
              throw err;
            }
            await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 5));
          }
        }
      } catch (err) {
        // Never leave staging garbage behind on a failed save.
        await rm(tmp, { force: true }).catch(() => {});
        log.error('atomic write failed', { sessionId, err: (err as Error).message });
        throw err;
      }
    },

    async remove(sessionId: string): Promise<void> {
      await rm(pathFor(sessionId), { force: true });
    },
  };
}

/* ── the store ───────────────────────────────────────────────────────────── */

/**
 * Session store over an injected persistence function.
 *
 * Implements the framework's `SessionStore`, so it drops into
 * `SuperOptions.sessionStore` like any other.
 */
export class SqliteSessionStore implements SessionStore {
  readonly name = 'sqlite';

  readonly #sessionId: string;
  readonly #persistence: SqlitePersistence;
  readonly #log: Logger;

  /** Authoritative in-memory mirror; Baileys mutates `creds` through it. */
  #doc: StoredDocument = { creds: {}, keys: {} };
  #state: SessionState | null = null;
  #meta: Record<string, unknown> = {};

  constructor(options: SqliteSessionStoreOptions) {
    this.#sessionId = assertSafeSessionId(options.sessionId);
    this.#persistence = options.persistence;
    this.#log = options.logger ?? silentLogger;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  async init(): Promise<{ state: SessionState; saveCreds: () => Promise<void> }> {
    if (this.#state) {
      return { state: this.#state, saveCreds: () => this.#persist() };
    }

    const raw = await this.#persistence.read(this.#sessionId);
    if (raw) {
      try {
        const parsed = JSON.parse(raw, BufferJSON.reviver) as Partial<StoredDocument>;
        this.#doc = {
          creds: parsed.creds ?? {},
          keys: parsed.keys ?? {},
          meta: parsed.meta,
        };
        this.#meta = parsed.meta ?? {};
      } catch (err) {
        // A corrupt document is not something we can safely patch around: half
        // a Signal key store desyncs the ratchet. Fall back to fresh creds and
        // say so loudly, rather than writing garbage back over the file.
        this.#log.error('stored auth state is unparseable; starting from fresh creds', {
          sessionId: this.#sessionId,
          err: (err as Error).message,
        });
        this.#doc = { creds: {}, keys: {} };
        this.#meta = {};
      }
    }

    if (!this.#doc.creds || Object.keys(this.#doc.creds).length === 0) {
      this.#doc.creds = initAuthCreds() as unknown as Record<string, unknown>;
    }

    const creds = this.#doc.creds;
    const keys = this.#buildKeyStore(creds);

    this.#state = { creds, keys };
    return { state: this.#state, saveCreds: () => this.#persist() };
  }

  /**
   * Build the `SignalKeyStore` Baileys will talk to.
   *
   * Semantics copied from upstream's multi-file store because deviating from
   * them desyncs Signal:
   *  - `get` returns an entry for **every** requested id, `null` when absent.
   *  - `set` treats a falsy value as a **delete**.
   */
  #buildKeyStore(creds: Record<string, unknown>): SignalKeyStoreLike {
    const doc = this.#doc;

    return {
      get: async (type: string, ids: string[]): Promise<Record<string, unknown>> => {
        const bucket = doc.keys[type] ?? {};
        const out: Record<string, unknown> = {};
        for (const id of ids) {
          const value = bucket[id] ?? null;
          if (value && type === 'app-state-sync-key') {
            // Protobuf structs do not survive JSON as plain objects; upstream
            // rehydrates this one type explicitly and we must match it.
            out[id] = proto.Message.AppStateSyncKeyData.fromObject(
              value as proto.Message.IAppStateSyncKeyData,
            );
          } else {
            out[id] = value;
          }
        }
        return out;
      },

      set: async (data: KeyStoreData): Promise<void> => {
        for (const type of Object.keys(data)) {
          const entries = data[type];
          if (!entries) continue;
          const bucket = (doc.keys[type] ??= {});
          for (const id of Object.keys(entries)) {
            const value = entries[id];
            if (value) bucket[id] = value;
            else delete bucket[id];
          }
        }
        // Persisting the key store is just as load-bearing as persisting creds:
        // Signal keys lost here mean a ratchet desync on the next connect.
        await this.#persist();
      },

      clear: async (): Promise<void> => {
        doc.keys = {};
        await this.#persist();
      },
    };
  }

  /**
   * Read-modify-write the document under the per-key lock.
   *
   * The existing document is re-read inside the critical section and merged
   * rather than overwritten, so fields written by another writer of the same
   * session are not clobbered.
   */
  async #persist(): Promise<void> {
    const sessionId = this.#sessionId;
    await withKeyLock(sessionId, async () => {
      const raw = await this.#persistence.read(sessionId);
      let existing: Partial<StoredDocument> = {};
      if (raw) {
        try {
          existing = JSON.parse(raw, BufferJSON.reviver) as Partial<StoredDocument>;
        } catch {
          // Unparseable during merge: our in-memory copy is the best we have.
          this.#log.warn('merge base unparseable; overwriting from memory', { sessionId });
        }
      }

      const merged: StoredDocument = {
        ...existing,
        creds: this.#doc.creds,
        keys: this.#doc.keys,
        meta: { ...(existing.meta ?? {}), ...this.#meta },
      };
      this.#doc.meta = merged.meta;

      await this.#persistence.write(
        sessionId,
        JSON.stringify(merged, BufferJSON.replacer),
      );
    });
  }

  /* ── sidecar ─────────────────────────────────────────────────────────── */

  async get<T>(key: string, fallback: T): Promise<T> {
    const value = this.#meta[key];
    return value === undefined ? fallback : (value as T);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.#meta[key] = value;
    await this.#persist();
  }

  /** Logout: drop credentials and key material. Next start must re-pair. */
  async clear(): Promise<void> {
    await this.#persistence.remove(this.#sessionId);
    this.#doc = { creds: {}, keys: {} };
    this.#meta = {};
    this.#state = null;
  }
}

export default SqliteSessionStore;