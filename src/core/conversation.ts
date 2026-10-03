/**
 * Conversation state.
 *
 * A bot that asks a question and waits for the answer needs to remember which
 * question — per person, per chat, and only for a while. That is the smallest
 * genuinely stateful thing a script author writes, and the easiest place to leak
 * memory: a map keyed by jid that grows for every stranger who ever says hello.
 *
 * So this store is TTL-first. Every read touches the entry, every entry expires,
 * and the map has a hard size ceiling that evicts the least recently used key
 * rather than growing. A long-running bot on a small VPS needs the leak to be
 * impossible, not merely unlikely.
 *
 * Deliberately not persisted. State that must survive a restart belongs in
 * `JsonStore`; this is the scratchpad for "what was this person doing a minute
 * ago", and writing it out on every keystroke is how a bot ends up with a
 * session file nobody can explain.
 *
 * Pure, so it is on the `lite` entry.
 */

export interface ConversationEntry<T> {
  /** Whatever the caller chose to keep. */
  state: T;
  /** When the entry was created. */
  since: number;
  /** When it was last read or written. */
  touchedAt: number;
  /** Times this key has been written, including the first. */
  writes: number;
}

export interface ConversationOptions {
  /**
   * Idle time before an entry expires, in ms. Default 10 minutes — long enough
   * to finish a form, short enough that someone who walked away is not still
   * mid-flow tomorrow.
   */
  ttlMs?: number;
  /** Hard cap on live entries. Default 5000. The oldest idle key is evicted. */
  maxEntries?: number;
  /** Called with each evicted key, so a caller can persist it if it matters. */
  onEvict?: (key: string, entry: ConversationEntry<unknown>) => void;
}

export class ConversationStore<T = Record<string, unknown>> {
  readonly #entries = new Map<string, ConversationEntry<T>>();
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #onEvict?: (key: string, entry: ConversationEntry<unknown>) => void;
  #expired = 0;
  #evicted = 0;

  constructor(options: ConversationOptions = {}) {
    this.#ttlMs = options.ttlMs ?? 600_000;
    this.#maxEntries = Math.max(1, options.maxEntries ?? 5_000);
    this.#onEvict = options.onEvict;
  }

  get size(): number {
    return this.#entries.size;
  }

  get ttlMs(): number {
    return this.#ttlMs;
  }

  /**
   * Whether a live (unexpired) entry exists for `key`.
   *
   * A query, not a use: `has` and `peek` deliberately do **not** refresh the
   * TTL, so a polling loop cannot keep a conversation alive on its own. Only
   * `get`, `patch`, `update`, `increment` and `set` count as touching it.
   */
  has(key: string): boolean {
    const entry = this.#entries.get(key);
    if (!entry) return false;
    if (this.#isExpired(entry)) {
      this.#drop(key);
      return false;
    }
    return true;
  }

  /**
   * Read the state for `key`, creating it on first use.
   *
   * `factory` runs only when there is no live entry, and its result is not
   * saved — so `get(k, () => ({}))` hands back a fresh object each call unless
   * the caller writes it back. That is intentional: it keeps a read from
   * silently resurrecting an entry the caller only wanted to peek at.
   */
  get(key: string, factory?: () => T): T | undefined {
    const entry = this.#entries.get(key);
    if (entry) {
      if (this.#isExpired(entry)) {
        this.#drop(key);
      } else {
        entry.touchedAt = Date.now();
        return entry.state;
      }
    }
    return factory?.();
  }

  /** Read without creating or refreshing the TTL. Returns `fallback` when absent. */
  peek(key: string, fallback: T): T {
    const entry = this.#entries.get(key);
    if (!entry) return fallback;
    if (this.#isExpired(entry)) {
      this.#drop(key);
      return fallback;
    }
    return entry.state;
  }

  /** Write the whole state for `key`. */
  set(key: string, state: T): T {
    const now = Date.now();
    const existing = this.#entries.get(key);
    if (existing) {
      existing.state = state;
      existing.touchedAt = now;
      existing.writes += 1;
    } else {
      this.#entries.set(key, { state, since: now, touchedAt: now, writes: 1 });
      this.#enforceCeiling();
    }
    return state;
  }

  /**
   * Merge into the state for `key`.
   *
   * The merged object is stored, so the previous one is not mutated in place —
   * a caller holding the value from an earlier `get` keeps seeing what it saw.
   */
  patch(key: string, partial: Partial<T>): T {
    const current = this.get(key);
    const merged = { ...(current ?? ({} as T)), ...partial };
    return this.set(key, merged);
  }

  /** Update the state in place, returning what the updater produced. */
  update(key: string, updater: (current: T | undefined) => T): T {
    return this.set(key, updater(this.get(key)));
  }

  /**
   * Advance a counter.
   *
   * `field` names the numeric property to increment, which keeps "count this
   * message" out of every call site.
   */
  increment<K extends keyof T & string>(key: string, field: K, by = 1): number {
    const current = this.get(key);
    const record = (current ?? ({} as T)) as Record<string, unknown>;
    const next = (Number(record[field]) || 0) + by;
    record[field] = next;
    this.set(key, record as T);
    return next;
  }

  delete(key: string): boolean {
    return this.#entries.delete(key);
  }

  /**
   * Forget a key. Returns whether there was anything to forget.
   *
   * Reports presence, not liveness: an entry that has expired is still an
   * entry, and a caller clearing state expects `true` and the key gone rather
   * than a `false` that reads as "there was nothing there".
   */
  clear(key: string): boolean {
    const entry = this.#entries.get(key);
    if (!entry) return false;
    const wasExpired = this.#isExpired(entry);
    this.#entries.delete(key);
    if (wasExpired) {
      this.#expired += 1;
      this.#notify(key, entry as ConversationEntry<unknown>);
    }
    return true;
  }

  /** Live keys, least recently touched first. */
  keys(): string[] {
    return [...this.#entries]
      .sort((a, b) => a[1].touchedAt - b[1].touchedAt)
      .map(([key]) => key);
  }

  /** Every live entry with its metadata, least recently touched first. */
  entries(): Array<ConversationEntry<T> & { key: string }> {
    return [...this.#entries]
      .map(([key, entry]) => ({ key, ...entry }))
      .sort((a, b) => a.touchedAt - b.touchedAt);
  }

  /** Remove expired entries. Returns how many went. */
  sweep(): number {
    let removed = 0;
    for (const [key, entry] of [...this.#entries]) {
      if (this.#isExpired(entry)) {
        this.#drop(key);
        removed += 1;
      }
    }
    return removed;
  }

  clearAll(): void {
    this.#entries.clear();
  }

  stats(): {
    size: number;
    maxEntries: number;
    ttlMs: number;
    expired: number;
    evicted: number;
    oldestTouchedAt: number | null;
  } {
    let oldest: number | null = null;
    for (const entry of this.#entries.values()) {
      if (oldest === null || entry.touchedAt < oldest) oldest = entry.touchedAt;
    }
    return {
      size: this.#entries.size,
      maxEntries: this.#maxEntries,
      ttlMs: this.#ttlMs,
      expired: this.#expired,
      evicted: this.#evicted,
      oldestTouchedAt: oldest,
    };
  }

  /* ── internals ─────────────────────────────────────────────────────── */

  #isExpired(entry: ConversationEntry<T>): boolean {
    return Date.now() - entry.touchedAt > this.#ttlMs;
  }

  #drop(key: string): void {
    const entry = this.#entries.get(key);
    this.#entries.delete(key);
    if (!entry) return;
    this.#expired += 1;
    this.#notify(key, entry);
  }

  #notify(key: string, entry: ConversationEntry<unknown>): void {
    if (!this.#onEvict) return;
    try {
      this.#onEvict(key, entry);
    } catch {
      /* a caller's eviction hook must not break the store */
    }
  }

  /**
   * Evict the least recently touched entry once the ceiling is passed.
   *
   * Map iteration order is insertion order, so the first key is not
   * necessarily the oldest *touched* — an entry created early and read often
   * sits at the front. Scan for the genuine minimum instead, since this only
   * runs on insert and the map is bounded anyway.
   */
  #enforceCeiling(): void {
    if (this.#entries.size <= this.#maxEntries) return;

    let victim: string | null = null;
    let victimAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.#entries) {
      if (entry.touchedAt < victimAt) {
        victimAt = entry.touchedAt;
        victim = key;
      }
    }
    if (victim === null) return;

    const entry = this.#entries.get(victim);
    this.#entries.delete(victim);
    this.#evicted += 1;
    if (entry) this.#notify(victim, entry as ConversationEntry<unknown>);
  }
}
