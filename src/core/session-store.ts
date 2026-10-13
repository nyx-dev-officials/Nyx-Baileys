import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { useMultiFileAuthState } from '@whiskeysockets/baileys';

import type { Logger } from '../utils/types.js';
import type { SessionState, SessionStore } from '../utils/types.js';

/**
 * Session stores.
 *
 * Upstream hands you `useMultiFileAuthState(dir)`, which scatters creds across
 * loose files. That is fine for one bot and wrong for an enterprise fleet, so
 * the auth mechanism is behind `SessionStore`. Anything that can load and save
 * `{ creds, keys }` fits — including SQL and document stores.
 */

export interface FileStoreOptions {
  /** Directory for the creds bundle. */
  dir: string;
  /** Optional sidecar file for plugin state, defaults to `<dir>/state.json`. */
  stateFile?: string;
  logger?: Logger;
}

/**
 * Serialises async credential writes and exposes the tail for draining.
 *
 * Writes arrive as bursts — `creds.update` can fire several times per second
 * during a handshake — and must land in order. More importantly, lifecycle
 * transitions that re-read state (`rebuild`, `dispose`) must drain first:
 * rebuilding from a creds.json that predates a queued paired-state write
 * resurrects an unregistered socket right after a successful pairing, and the
 * phone reports the link as failed. That exact failure shipped once, hidden
 * inside a closure whose bookkeeping variable never followed the chain.
 */
export class SerialSaver {
  #tail: Promise<void> = Promise.resolve();

  /** Queue a write behind all previous ones. Never rejects. */
  run(task: () => Promise<void>): Promise<void> {
    this.#tail = this.#tail.then(task).catch(() => undefined);
    return this.#tail;
  }

  /** Resolve once every queued write has landed. */
  drain(): Promise<void> {
    return this.#tail;
  }
}

/**
 * Default store: upstream's multi-file auth state, plus a JSON sidecar.
 */
export class FileSessionStore implements SessionStore {
  readonly name = 'file';

  readonly #dir: string;
  readonly #stateFile: string;
  readonly #log?: Logger;
  #cache = new Map<string, unknown>();

  constructor(options: FileStoreOptions) {
    this.#dir = options.dir;
    this.#stateFile = options.stateFile ?? join(options.dir, 'state.json');
    this.#log = options.logger;
  }

  async init(): Promise<{ state: SessionState; saveCreds: () => Promise<void> }> {
    await mkdir(this.#dir, { recursive: true });
    const result = await useMultiFileAuthState(this.#dir);
    return {
      state: result.state as SessionState,
      saveCreds: async () => {
        await result.saveCreds();
      },
    };
  }

  async get<T>(key: string, fallback: T): Promise<T> {
    if (this.#cache.has(key)) return this.#cache.get(key) as T;
    try {
      const raw = await readFile(this.#stateFile, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      this.#cache = new Map(Object.entries(parsed));
    } catch {
      return fallback;
    }
    return (this.#cache.get(key) as T) ?? fallback;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.#cache.set(key, value);
    await this.#persist();
  }

  async #persist(): Promise<void> {
    try {
      await mkdir(dirname(this.#stateFile), { recursive: true });
      await writeFile(this.#stateFile, `${JSON.stringify(Object.fromEntries(this.#cache), null, 2)}\n`, 'utf8');
    } catch (err) {
      this.#log?.warn('sidecar state write failed', { err: (err as Error).message });
    }
  }

  /** Wipe the session. Next start will need a fresh pairing. */
  async clear(): Promise<void> {
    await rm(this.#dir, { recursive: true, force: true });
    this.#cache.clear();
  }
}

/**
 * In-memory store. Fast, and it means a test or a short-lived CLI never touches
 * disk. Not durable — use `FileSessionStore` or a database store in production.
 */
export class MemorySessionStore implements SessionStore {
  readonly name = 'memory';

  #state: SessionState | null = null;
  #save: (() => Promise<void>) | null = null;
  #side = new Map<string, unknown>();

  async init(): Promise<{ state: SessionState; saveCreds: () => Promise<void> }> {
    if (!this.#state || !this.#save) {
      const result = await useMultiFileAuthState(join(process.cwd(), '.nyx-baileys-tmp'));
      this.#state = result.state as SessionState;
      this.#save = async () => {
        await result.saveCreds();
      };
    }
    return { state: this.#state, saveCreds: this.#save };
  }

  async get<T>(key: string, fallback: T): Promise<T> {
    return (this.#side.get(key) as T) ?? fallback;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.#side.set(key, value);
  }
}

/**
 * Wrap any loader/saver pair as a store — the adapter for Mongo, Postgres or
 * Redis clients. `load` and `save` may be sync or async.
 *
 *   const store = createSessionStore({
 *     name: 'mongo',
 *     load: async () => (await sessions.findOne({ _id: id })) ?? {},
 *     save: async (s) => sessions.updateOne({ _id: id }, { $set: s }, { upsert: true }),
 *   })
 */
export function createSessionStore(options: {
  name: string;
  load: () => unknown | Promise<unknown>;
  save: (state: Record<string, unknown>) => unknown | Promise<unknown>;
  logger?: Logger;
}): SessionStore {
  let side = new Map<string, unknown>();

  return {
    name: options.name,

    async init() {
      const loaded = (await options.load()) as Partial<SessionState>;
      const state: SessionState = {
        creds: loaded.creds ?? {},
        keys: loaded.keys ?? {},
      };
      return {
        state,
        saveCreds: async () => {
          try {
            await options.save(state as unknown as Record<string, unknown>);
          } catch (err) {
            options.logger?.error('session save failed', { err: (err as Error).message });
            throw err;
          }
        },
      };
    },

    async get<T>(key: string, fallback: T): Promise<T> {
      return (side.get(key) as T) ?? fallback;
    },

    async set(key: string, value: unknown): Promise<void> {
      side.set(key, value);
    },
  };
}