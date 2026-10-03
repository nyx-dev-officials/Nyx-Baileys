/**
 * A small TTL + LRU cache.
 *
 * Bots cache the same few things over and over: a group's metadata, a profile
 * picture, an API response, the last result of an expensive command. This is a
 * Map with two rules on top — entries expire after `ttlMs`, and the least
 * recently used entry is evicted once `maxSize` is exceeded — plus a `memoize`
 * wrapper for the common "compute once, reuse for a while" shape.
 *
 * Time is injectable so the expiry behaviour is testable without sleeping.
 */

export interface TtlCacheOptions {
  /** Entry lifetime in milliseconds. `0` or negative means "never expires". */
  ttlMs?: number;
  /** Maximum entries before the least-recently-used is evicted. `0` = unbounded. */
  maxSize?: number;
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  evictions: number;
  expirations: number;
}

interface Entry<V> {
  value: V;
  /** Expiry epoch-ms, or `Infinity` when the entry never expires. */
  expiresAt: number;
}

export class TtlCache<K, V> {
  readonly #store = new Map<K, Entry<V>>();
  readonly #ttlMs: number;
  readonly #maxSize: number;
  readonly #now: () => number;
  #hits = 0;
  #misses = 0;
  #evictions = 0;
  #expirations = 0;

  constructor(options: TtlCacheOptions = {}) {
    this.#ttlMs = options.ttlMs ?? 0;
    this.#maxSize = Math.max(0, options.maxSize ?? 0);
    this.#now = options.now ?? Date.now;
  }

  /** A cache is never full, but it always reports a bound so callers can plan. */
  get size(): number {
    return this.#store.size;
  }

  get(key: K): V | undefined {
    const entry = this.#store.get(key);
    if (!entry) {
      this.#misses += 1;
      return undefined;
    }
    if (this.#expired(entry)) {
      this.#store.delete(key);
      this.#expirations += 1;
      this.#misses += 1;
      return undefined;
    }
    // Re-insert so Map iteration order tracks recency for LRU eviction.
    this.#store.delete(key);
    this.#store.set(key, entry);
    this.#hits += 1;
    return entry.value;
  }

  has(key: K): boolean {
    const entry = this.#store.get(key);
    if (!entry) return false;
    if (!this.#expired(entry)) return true;
    this.#store.delete(key);
    this.#expirations += 1;
    return false;
  }

  set(key: K, value: V, ttlMs = this.#ttlMs): this {
    this.#store.delete(key);
    this.#store.set(key, {
      value,
      expiresAt: ttlMs > 0 ? this.#now() + ttlMs : Number.POSITIVE_INFINITY,
    });
    if (this.#maxSize > 0) {
      while (this.#store.size > this.#maxSize) {
        const oldest = this.#store.keys().next();
        if (oldest.done) break;
        this.#store.delete(oldest.value);
        this.#evictions += 1;
      }
    }
    return this;
  }

  /** Set only when the key is absent (or expired). Returns the live value. */
  setIfAbsent(key: K, value: V, ttlMs = this.#ttlMs): V {
    const existing = this.get(key);
    if (existing !== undefined) return existing;
    this.set(key, value, ttlMs);
    return value;
  }

  delete(key: K): boolean {
    return this.#store.delete(key);
  }

  /** Drop every entry. Counters are kept — this is not a reset. */
  clear(): void {
    this.#store.clear();
  }

  keys(): K[] {
    return [...this.#store.keys()];
  }

  values(): V[] {
    return [...this.#store.values()].map((entry) => entry.value);
  }

  /** Remove every expired entry. Returns how many went. */
  prune(): number {
    let removed = 0;
    for (const [key, entry] of this.#store) {
      if (this.#expired(entry)) {
        this.#store.delete(key);
        removed += 1;
      }
    }
    this.#expirations += removed;
    return removed;
  }

  stats(): CacheStats {
    return {
      size: this.#store.size,
      hits: this.#hits,
      misses: this.#misses,
      evictions: this.#evictions,
      expirations: this.#expirations,
    };
  }

  #expired(entry: Entry<V>): boolean {
    return entry.expiresAt !== Number.POSITIVE_INFINITY && entry.expiresAt <= this.#now();
  }
}

/**
 * Wrap a function so repeated calls with the same first argument reuse the
 * stored result for `ttlMs`. A rejected promise evicts itself, so a transient
 * failure is not cached.
 */
export function memoize<A, R>(
  fn: (arg: A) => R,
  options: TtlCacheOptions & { key?: (arg: A) => unknown } = {},
): ((arg: A) => R) & { cache: TtlCache<unknown, R> } {
  const keyOf = options.key ?? ((arg: A) => arg);
  const cache = new TtlCache<unknown, R>(options);

  const wrapped = (arg: A): R => {
    const key = keyOf(arg);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const result = fn(arg);
    if (result instanceof Promise) {
      result.catch(() => cache.delete(key));
    }
    cache.set(key, result);
    return result;
  };
  wrapped.cache = cache;
  return wrapped;
}
