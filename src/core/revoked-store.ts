import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Revoked-message store.
 *
 * When someone revokes a message, the only copy left is the one you already
 * received. This keeps it so a later "deleted" lookup has something to return.
 *
 * Design constraints, in priority order:
 *
 *   1. **Bounded.** An anti-delete cache with no ceiling is a disk-exhaustion
 *      bug. `maxEntries` and `maxBytes` are enforced on every write, and the
 *      oldest entry is dropped first.
 *   2. **Pluggable persistence.** The default is a JSON file so it works with
 *      zero dependencies. Hand it `load`/`save` and it becomes SQLite or
 *      Postgres without touching the plugin.
 *   3. **Never throws into an event handler.** A storage failure is counted and
 *      logged, never propagated — losing a cache entry must not take down the
 *      socket.
 */

export interface RevokedEntry {
  /** Stable `remoteJid|id`, so a lookup does not need the full object. */
  key: string;
  jid: string;
  id: string;
  participant?: string;
  timestamp: number;
  /** The message as it was before revocation. */
  message: unknown;
  /** Approximate stored size, for the byte ceiling. */
  bytes: number;
  /** When this entry was captured. */
  storedAt: number;
}

export interface RevokedStoreOptions {
  /** File path for the default JSON store. Omit for memory-only. */
  path?: string;
  maxEntries?: number;
  maxBytes?: number;
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

export interface RevokedStore {
  put(key: string, message: unknown, meta: { jid: string; id: string; participant?: string; timestamp?: number }): Promise<void>;
  get(key: string): RevokedEntry | undefined;
  /** Entries newest first. */
  recent(limit?: number): RevokedEntry[];
  size(): { entries: number; bytes: number };
  clear(): Promise<void>;
}

/** Approximate serialised size, without paying for a full JSON pass twice. */
function approxBytes(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

export function createRevokedStore(options: RevokedStoreOptions = {}): RevokedStore {
  const maxEntries = Math.max(1, options.maxEntries ?? 5_000);
  const maxBytes = Math.max(64 * 1024, options.maxBytes ?? 64 * 1024 * 1024);
  const log = options.logger;

  /** Insertion-ordered; the oldest key is always first. */
  const entries = new Map<string, RevokedEntry>();
  let bytes = 0;
  let dirty = false;
  let flushing: Promise<void> | null = null;

  const evict = (): void => {
    while (entries.size > maxEntries || bytes > maxBytes) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      const victim = entries.get(oldest);
      entries.delete(oldest);
      bytes -= victim?.bytes ?? 0;
    }
  };

  const persist = async (): Promise<void> => {
    if (!options.path || !dirty) return;
    dirty = false;
    try {
      await mkdir(dirname(options.path), { recursive: true });
      await writeFile(options.path, JSON.stringify([...entries.values()]), 'utf8');
    } catch (err) {
      // Losing the cache is survivable. Losing the socket is not.
      log?.warn('revoked cache write failed', { err: (err as Error).message });
    }
  };

  /** Coalesce concurrent flushes so a burst of revokes is one disk write. */
  const scheduleFlush = (): void => {
    if (!options.path) return;
    if (flushing) return;
    flushing = (async () => {
      try {
        await persist();
      } finally {
        flushing = null;
      }
    })();
  };

  const hydrate = async (): Promise<void> => {
    if (!options.path) return;
    try {
      const raw = await readFile(options.path, 'utf8');
      const parsed = JSON.parse(raw) as RevokedEntry[];
      if (!Array.isArray(parsed)) return;
      for (const entry of parsed) {
        if (!entry?.key) continue;
        entries.set(entry.key, entry);
        bytes += entry.bytes ?? approxBytes(entry.message);
      }
      evict();
    } catch {
      /* no cache yet, or unreadable — start empty rather than fail boot */
    }
  };

  const ready = hydrate();

  return {
    async put(key, message, meta) {
      await ready;
      // Re-capturing an existing key replaces it, so bytes cannot double-count.
      const previous = entries.get(key);
      if (previous) bytes -= previous.bytes;

      const size = approxBytes(message);
      const entry: RevokedEntry = {
        key,
        jid: meta.jid,
        id: meta.id,
        participant: meta.participant,
        timestamp: meta.timestamp ?? 0,
        message,
        bytes: size,
        storedAt: Date.now(),
      };

      entries.set(key, entry);
      bytes += size;
      evict();
      dirty = true;
      scheduleFlush();
    },

    get: (key) => entries.get(key),
    recent: (limit = 50) => [...entries.values()].reverse().slice(0, limit),
    size: () => ({ entries: entries.size, bytes }),
    async clear() {
      entries.clear();
      bytes = 0;
      dirty = false;
    },
  };
}
