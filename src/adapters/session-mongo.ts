import { proto } from '@whiskeysockets/baileys';

import { silentLogger } from '../utils/logger.js';
import type { Logger, SessionState, SessionStore } from '../utils/types.js';

import type { KeyStoreData, SignalKeyStoreLike } from './session-sqlite.js';

/**
 * Mongo-backed session store.
 *
 * Two collections, because the two halves of the auth state have completely
 * different shapes:
 *
 *  - **Credentials** — one document per session. Read and written whole, always.
 *    It is small, bounded, and the hot path (`creds.update`).
 *  - **Pre-key keys** — one document per `(sessionId, type, keyId)`. This is the
 *    part that decides whether the adapter scales: the Signal key store holds a
 *    `sender-key` per chat, an `app-state-sync-key` per chat, a `tctoken` per
 *    chat, and grows for the life of the account. Storing it as one blob per
 *    session hits the 16 MB BSON document limit on any real account and makes a
 *    per-key delete a full-document rewrite. Row-per-key gives O(1) deletes and
 *    lets a TTL/index do the pruning.
 *
 * Values are stored **natively**, not JSON-encoded. BSON has a binary type, so
 * `Uint8Array` key material round-trips without base64 inflation (a 32-byte
 * Signal key becomes 32 bytes here, ~48 in JSON). That is the main reason to
 * prefer this adapter over the file store once you outgrow one node.
 *
 * ── Required indexes ──────────────────────────────────────────────────────
 * Create these before first use. They are not optional tuning; without them a
 * fleet degrades into collection scans and, worse, `upsert` on a non-unique
 * filter can insert duplicate key rows on a retry.
 *
 *   // credentials collection (default name: "Session")
 *   db.Session.createIndex({ sessionId: 1 }, { unique: true, name: "sessionId_unq" });
 *
 *   // key collection (default name: "SessionKey")
 *   db.SessionKey.createIndex(
 *     { sessionId: 1, type: 1, keyId: 1 },
 *     { unique: true, name: "sessionId_type_keyId_unq" },
 *   );
 *   // Serves the per-session wipe on logout.
 *   db.SessionKey.createIndex({ sessionId: 1 }, { name: "sessionId_idx" });
 *
 * The compound unique index is what makes "upsert" correct here: the filter
 * `{ sessionId, type, keyId }` is unique, so a concurrent double-write updates
 * one row instead of racing two inserts into it.
 *
 * **Isolation is enforced by the database, not by application discipline.**
 * Every query in this file includes `sessionId`. That is the property worth
 * copying from the reference implementation: a missing filter produces
 * wrong-but-valid rows rather than a silent cross-tenant leak, because the
 * compound key makes a bare `{ keyId }` match at most one session's row.
 */

/** Result of a Mongo write. Only the fields we act on are typed. */
export interface MongoWriteResult {
  matchedCount?: number;
  modifiedCount?: number;
  upsertedCount?: number;
}

/**
 * Minimal collection surface. Satisfied by `mongodb`'s `Collection` and by a
 * Mongoose model, so callers can pass either without this file depending on
 * either.
 */
export interface MongoCollectionLike<T extends object = Record<string, unknown>> {
  findOne(filter: Record<string, unknown>): Promise<T | null>;
  find(filter: Record<string, unknown>): { toArray(): Promise<T[]> };
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: { upsert?: boolean },
  ): Promise<MongoWriteResult | unknown>;
  deleteMany(filter: Record<string, unknown>): Promise<unknown>;
}

/** Minimal database surface: `Db`, `mongoose.connection.db`, or a stub. */
export interface MongoDbLike {
  collection<T extends object = Record<string, unknown>>(name: string): MongoCollectionLike<T>;
}

/** Credential document: `{ sessionId, creds, meta?, updatedAt }`. */
export interface MongoSessionDoc {
  sessionId: string;
  creds: Record<string, unknown>;
  meta?: Record<string, unknown> | null;
  updatedAt?: Date;
}

/** Key document: `{ sessionId, type, keyId, value, updatedAt }`. */
export interface MongoSessionKeyDoc {
  sessionId: string;
  type: string;
  keyId: string;
  value: unknown;
  updatedAt?: Date;
}

export interface MongoSessionStoreOptions {
  /** Unique per account. Present in every filter this store builds. */
  sessionId: string;
  db: MongoDbLike;
  /** Credentials collection name. */
  credsCollection?: string;
  /** Pre-key collection name. */
  keysCollection?: string;
  logger?: Logger;
}

export class MongoSessionStore implements SessionStore {
  readonly name = 'mongo';

  readonly #sessionId: string;
  readonly #creds: MongoCollectionLike<MongoSessionDoc>;
  readonly #keys: MongoCollectionLike<MongoSessionKeyDoc>;
  readonly #log: Logger;

  #state: SessionState | null = null;
  #meta: Record<string, unknown> = {};

  constructor(options: MongoSessionStoreOptions) {
    if (!options.sessionId) throw new Error('mongo session store requires a sessionId');
    this.#sessionId = options.sessionId;
    this.#creds = options.db.collection<MongoSessionDoc>(options.credsCollection ?? 'Session');
    this.#keys = options.db.collection<MongoSessionKeyDoc>(options.keysCollection ?? 'SessionKey');
    this.#log = options.logger ?? silentLogger;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  async init(): Promise<{ state: SessionState; saveCreds: () => Promise<void> }> {
    if (this.#state) return { state: this.#state, saveCreds: () => this.save() };

    const doc = await this.#creds.findOne({ sessionId: this.#sessionId }).catch((err: unknown) => {
      // A missing unique index shows up as a write error, not a read error — so
      // a read failure is a real connectivity/auth problem and must surface.
      this.#log.error('credential read failed', {
        sessionId: this.#sessionId,
        err: (err as Error).message,
      });
      throw err;
    });

    const creds = doc?.creds ?? {};
    this.#meta = (doc?.meta as Record<string, unknown> | undefined) ?? {};

    const keys = this.#buildKeyStore();
    this.#state = { creds, keys };
    return { state: this.#state, saveCreds: () => this.save() };
  }

  /** Persist the in-memory credential object. Baileys mutates it in place. */
  async save(): Promise<void> {
    if (!this.#state) throw new Error('mongo session store used before init()');
    await this.#creds.updateOne(
      { sessionId: this.#sessionId },
      { $set: { creds: this.#state.creds, meta: this.#meta, updatedAt: new Date() } },
      { upsert: true },
    );
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
        if (ids.length === 0) return {};

        const docs = await this.#keys
          .find({ sessionId, type, keyId: { $in: ids } })
          .toArray()
          .catch((err: unknown) => {
            this.#log.error('key read failed', { sessionId, type, err: (err as Error).message });
            throw err;
          });

        const found = new Map<string, unknown>();
        for (const doc of docs) found.set(doc.keyId, doc.value);

        const out: Record<string, unknown> = {};
        for (const id of ids) {
          const value = found.get(id) ?? null;
          // Protobuf structs do not survive BSON as plain objects; upstream
          // rehydrates this one type explicitly.
          out[id] =
            value && type === 'app-state-sync-key'
              ? proto.Message.AppStateSyncKeyData.fromObject(value as proto.Message.IAppStateSyncKeyData)
              : value;
        }
        return out;
      },

      set: async (data: KeyStoreData): Promise<void> => {
        // Deletes are batched per type into one `$in` filter rather than one
        // deleteMany per key: logout and cache eviction are bursty, and N round
        // trips for N keys is the difference between fast and a stalled socket.
        const deletes: Array<{ type: string; ids: string[] }> = [];

        const writes: Array<Promise<unknown>> = [];
        for (const type of Object.keys(data)) {
          const entries = data[type];
          if (!entries) continue;

          const doomed: string[] = [];
          for (const keyId of Object.keys(entries)) {
            const value = entries[keyId];
            if (value) {
              writes.push(
                this.#keys.updateOne(
                  { sessionId, type, keyId },
                  { $set: { value, updatedAt: new Date() } },
                  { upsert: true },
                ),
              );
            } else {
              doomed.push(keyId);
            }
          }
          if (doomed.length > 0) deletes.push({ type, ids: doomed });
        }

        const removals = deletes.map((d) =>
          this.#keys.deleteMany({ sessionId, type: d.type, keyId: { $in: d.ids } }),
        );

        const settled = await Promise.allSettled([...writes, ...removals]);
        const failed = settled.filter(
          (r): r is PromiseRejectedResult => r.status === 'rejected',
        );
        if (failed.length > 0) {
          // Report but do not throw: losing one pre-key is recoverable, and
          // throwing here would abort an unrelated in-flight Baileys operation.
          this.#log.warn('key write partially failed', {
            sessionId,
            failed: failed.length,
            err: (failed[0]?.reason as Error | undefined)?.message,
          });
        }
      },

      clear: async (): Promise<void> => {
        await this.#keys.deleteMany({ sessionId });
      },
    };
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

  /** Logout: drop credentials and every key row for this session. */
  async clear(): Promise<void> {
    await Promise.all([
      this.#keys.deleteMany({ sessionId: this.#sessionId }),
      this.#creds.deleteMany({ sessionId: this.#sessionId }),
    ]);
    this.#meta = {};
    this.#state = null;
  }
}

export default MongoSessionStore;