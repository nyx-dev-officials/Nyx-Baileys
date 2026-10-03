import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';

import { silentLogger } from '../utils/logger.js';
import type { Logger, SessionState, SessionStore } from '../utils/types.js';

import type { KeyStoreData, SignalKeyStoreLike } from './session-sqlite.js';

/**
 * Redis-backed session store.
 *
 * Redis is the wrong system of record for auth state — it has no transactions
 * across keys, so a fleet cannot rely on it alone — and it is the right one for
 * a hot read path, because a credential fetch on reconnect is a single O(1)
 * round trip instead of a query. The intended shape is Redis in front of
 * `session-prisma` or `session-mongo` as L1, exactly as the reference
 * implementation's layered auth state does. This adapter is the L1.
 *
 * ── Key layout ────────────────────────────────────────────────────────────
 * Every key is prefixed by namespace **and** session id, so one Redis instance
 * can serve the whole fleet with no chance of one account reading another's
 * creds:
 *
 *   {ns}:{sid}:epoch              → integer, bumped on logout
 *   {ns}:{sid}:{epoch}:creds      → JSON, the credential bundle
 *   {ns}:{sid}:{epoch}:{type}:{keyId} → JSON, one Signal key
 *   {ns}:{sid}:meta               → JSON sidecar
 *
 * ── The epoch trick ───────────────────────────────────────────────────────
 * Logging out has to invalidate every pre-key row, but drivers disagree on
 * `SCAN`/`DEL` variadic signatures and a fleet does not want a `KEYS` scan
 * against production Redis. So key rows live under a per-session *generation*
 * prefix, and logout increments it: every previously written key row becomes
 * unreachable in one O(1) `INCR`, then TTL reclaims the space. Same guarantee
 * as a scan-and-delete, without the scan. (Rows are unreachable rather than
 * deleted, so a session configured with no TTL should set one.)
 *
 * ── TTL default is off, on purpose ────────────────────────────────────────
 * `ttlSeconds: 0` means no expiry. That is the default because the failure
 * mode of the alternative is unacceptable: an auth blob that expires at 3am
 * logs an entire fleet out and forces a human to scan N QR codes. If Redis is
 * a cache in front of a real store, the TTL should be comfortably longer than
 * your worst-case outage. The TTL slides forward on every write, so it measures
 * time since last save, not time since creation.
 */

/** Result of a write. Only the fields we act on are typed. */
export interface RedisWriteResult {
  reply?: string | number | null;
}

/** Write options. `{ EX: seconds }` is the one form both clients accept. */
export interface RedisSetOptions {
  EX?: number;
}

/**
 * Minimal client surface. Satisfied by `ioredis`, `node-redis` v4 (pass
 * `client`), and a stub — so this file imports no Redis driver.
 */
export interface RedisLikeClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: RedisSetOptions): Promise<RedisWriteResult | unknown>;
  del(key: string): Promise<number | unknown>;
  incr(key: string): Promise<number>;
}

export interface RedisSessionStoreOptions {
  /** Unique per account. Part of every key. */
  sessionId: string;
  client: RedisLikeClient;
  /** Key prefix. Defaults to `sb`. */
  namespace?: string;
  /**
   * Expiry in seconds for every key this store writes. 0 = no expiry.
   * See the header for why 0 is the default.
   */
  ttlSeconds?: number;
  logger?: Logger;
}

export class RedisSessionStore implements SessionStore {
  readonly name = 'redis';

  readonly #sessionId: string;
  readonly #client: RedisLikeClient;
  readonly #ns: string;
  readonly #ttl: number;
  readonly #log: Logger;

  /** Generation counter; bumped on logout to orphan old key rows. */
  #epoch = 0;
  #epochLoaded = false;
  #state: SessionState | null = null;
  #meta: Record<string, unknown> = {};

  constructor(options: RedisSessionStoreOptions) {
    if (!options.sessionId) throw new Error('redis session store requires a sessionId');
    this.#sessionId = options.sessionId;
    this.#client = options.client;
    this.#ns = options.namespace ?? 'sb';
    this.#ttl = Math.max(0, Math.floor(options.ttlSeconds ?? 0));
    this.#log = options.logger ?? silentLogger;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  #base(): string {
    return `${this.#ns}:${this.#sessionId}`;
  }

  #credsKey(): string {
    return `${this.#base()}:${this.#epoch}:creds`;
  }

  #metaKey(): string {
    return `${this.#base()}:meta`;
  }

  #keyRowKey(type: string, keyId: string): string {
    // `type` and `keyId` are attacker-influenced (they arrive from the network)
    // and contain `:` and `@`, so they are percent-encoded. This is injective,
    // unlike replacing `:` with a fixed sentinel, which would let `a:b` and
    // `a__b` collide on one row — a cross-key read inside a single session.
    return `${this.#base()}:${this.#epoch}:${encodeURIComponent(type)}:${encodeURIComponent(keyId)}`;
  }

  async #loadEpoch(): Promise<void> {
    if (this.#epochLoaded) return;
    const raw = await this.#client.get(`${this.#base()}:epoch`);
    const parsed = raw === null ? 0 : Number.parseInt(raw, 10);
    this.#epoch = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    this.#epochLoaded = true;
  }

  async init(): Promise<{ state: SessionState; saveCreds: () => Promise<void> }> {
    if (this.#state) return { state: this.#state, saveCreds: () => this.save() };

    await this.#loadEpoch();

    const [rawCreds, rawMeta] = await Promise.all([
      this.#client.get(this.#credsKey()),
      this.#client.get(this.#metaKey()),
    ]);

    let creds: Record<string, unknown> = {};
    if (rawCreds) {
      try {
        creds = JSON.parse(rawCreds, BufferJSON.reviver) as Record<string, unknown>;
      } catch (err) {
        this.#log.error('stored creds are unparseable; starting from fresh creds', {
          sessionId: this.#sessionId,
          err: (err as Error).message,
        });
        creds = {};
      }
    }
    if (Object.keys(creds).length === 0) {
      creds = initAuthCreds() as unknown as Record<string, unknown>;
    }

    if (rawMeta) {
      try {
        this.#meta = JSON.parse(rawMeta, BufferJSON.reviver) as Record<string, unknown>;
      } catch {
        this.#meta = {};
      }
    }

    const keys = this.#buildKeyStore();
    this.#state = { creds, keys };
    return { state: this.#state, saveCreds: () => this.save() };
  }

  async save(): Promise<void> {
    if (!this.#state) throw new Error('redis session store used before init()');
    const payload = JSON.stringify(this.#state.creds, BufferJSON.replacer);
    await this.#client.set(this.#credsKey(), payload, this.#ttl > 0 ? { EX: this.#ttl } : undefined);
  }

  /**
   * The `SignalKeyStore` Baileys talks to.
   *
   * Semantics copied from upstream's multi-file store because deviating
   * desyncs Signal: `get` returns an entry for **every** requested id (`null`
   * when absent), and `set` treats a falsy value as a **delete**.
   *
   * Reads are parallel `GET`s rather than an `MGET`/pipeline: the variadic and
   * pipeline signatures differ between `ioredis` and `node-redis`, and a batch
   * of parallel single-key reads is both portable and fast enough at the sizes
   * Baileys asks for.
   */
  #buildKeyStore(): SignalKeyStoreLike {
    return {
      get: async (type: string, ids: string[]): Promise<Record<string, unknown>> => {
        if (ids.length === 0) return {};

        // Pair each id with its value instead of indexing two parallel arrays:
        // under `noUncheckedIndexedAccess` that pairing cannot silently drift.
        const rows = await Promise.all(
          ids.map(async (id) => {
            try {
              return { id, raw: await this.#client.get(this.#keyRowKey(type, id)) };
            } catch (err) {
              this.#log.warn('key read failed', {
                sessionId: this.#sessionId,
                type,
                keyId: id,
                err: (err as Error).message,
              });
              return { id, raw: null };
            }
          }),
        );

        const out: Record<string, unknown> = {};
        for (const { id, raw } of rows) {
          if (raw === null) {
            out[id] = null;
            continue;
          }
          try {
            const value = JSON.parse(raw, BufferJSON.reviver);
            out[id] =
              type === 'app-state-sync-key' && value
                ? proto.Message.AppStateSyncKeyData.fromObject(value as proto.Message.IAppStateSyncKeyData)
                : value;
          } catch {
            // A single unreadable row must cost that key, not the session.
            out[id] = null;
          }
        }
        return out;
      },

      set: async (data: KeyStoreData): Promise<void> => {
        const tasks: Array<Promise<unknown>> = [];

        for (const type of Object.keys(data)) {
          const entries = data[type];
          if (!entries) continue;

          for (const keyId of Object.keys(entries)) {
            const value = entries[keyId];
            const key = this.#keyRowKey(type, keyId);

            if (value) {
              tasks.push(
                this.#client.set(
                  key,
                  JSON.stringify(value, BufferJSON.replacer),
                  this.#ttl > 0 ? { EX: this.#ttl } : undefined,
                ),
              );
            } else {
              tasks.push(this.#client.del(key));
            }
          }
        }

        const settled = await Promise.allSettled(tasks);
        const failed = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (failed.length > 0) {
          // Losing a pre-key is recoverable; throwing here would abort an
          // unrelated in-flight operation inside Baileys.
          this.#log.warn('key write partially failed', {
            sessionId: this.#sessionId,
            failed: failed.length,
            err: (failed[0]?.reason as Error | undefined)?.message,
          });
        }
      },

      clear: async (): Promise<void> => {
        // Orphan this generation; the rows themselves expire.
        this.#epoch = await this.#client.incr(`${this.#base()}:epoch`);
        this.#epochLoaded = true;
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
    await this.#client.set(
      this.#metaKey(),
      JSON.stringify(this.#meta, BufferJSON.replacer),
      this.#ttl > 0 ? { EX: this.#ttl } : undefined,
    );
  }

  /**
   * Logout: bump the epoch so every key row is orphaned, then drop creds and
   * sidecar. Deliberately not a single transaction — Redis has no multi-key
   * transaction here, and the ordering makes the failure mode safe: if the
   * `INCR` fails nothing is deleted, and if the deletes fail the state is still
   * unreachable because the epoch moved.
   */
  async clear(): Promise<void> {
    await this.#client.incr(`${this.#base()}:epoch`);
    await Promise.all([
      this.#client.del(this.#credsKey()),
      this.#client.del(this.#metaKey()),
    ]);
    this.#epoch += 1;
    this.#epochLoaded = true;
    this.#meta = {};
    this.#state = null;
  }
}

export default RedisSessionStore;