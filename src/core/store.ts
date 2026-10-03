/**
 * Persistent JSON store.
 *
 * Every bot script eventually needs somewhere to put things that must outlive
 * the process — scores, user settings, cooldowns, a whitelist. `lowdb` is the
 * usual answer, and this is the part of it worth having without a dependency:
 * a document loaded once, mutated in memory, and written back atomically.
 *
 * The write is the whole design. `lowdb` rewrites the file on every mutation,
 * which is fine until a bot saves on every inbound message; here mutations are
 * in-memory and the write is *debounced*, so a burst of a hundred saves costs
 * one flush. `flush()` forces it, and `onSave` fires after every completed
 * write so a caller can mirror or back it up.
 *
 * Atomicity is the other half: the document is written to a sibling temp file
 * and then renamed over the target. A crash mid-write leaves the previous
 * document intact instead of a truncated one — the difference between losing
 * the last save and losing everything.
 *
 * Pure Node, no engine import, so it is on the `lite` entry too.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** A document is a flat record so a value can be replaced without a schema. */
export type Document = Record<string, unknown>;

export interface JsonStoreOptions {
  /** Where the document lives. Parent directories are created on first write. */
  file: string;
  /**
   * Debounce window in ms. Mutations inside one window produce a single write.
   * Default 1000. Set 0 to never autosave — every mutation then waits for an
   * explicit `flush()`, which is what you want before an unclean shutdown you
   * cannot intercept.
   */
  autosaveMs?: number;
  /** Seed used when the file does not exist yet. */
  defaults?: Document;
}

export interface JsonStoreStats {
  keys: number;
  file: string;
  bytes: number;
  saves: number;
  lastSavedAt: number | null;
  /** Autosaves skipped by coalescing — the reason the debounce exists. */
  coalesced: number;
}

/** Thrown when the file on disk is not a JSON object. */
export class CorruptStoreError extends Error {
  override readonly name = 'CorruptStoreError';
  constructor(
    readonly file: string,
    readonly reason: string,
  ) {
    super(`${file} is not a usable store: ${reason}`);
  }
}

export class JsonStore {
  #doc: Document;
  readonly #file: string;
  readonly #autosaveMs: number;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #writing: Promise<void> | null = null;
  #bytes = 0;
  #saves = 0;
  #coalesced = 0;
  #lastSavedAt: number | null = null;
  #closed = false;
  /** Set by the first `dispose()`; every later call awaits the same write. */
  #disposed: Promise<void> | null = null;
  readonly #listeners = new Set<(doc: Readonly<Document>) => void>();

  private constructor(doc: Document, options: JsonStoreOptions) {
    this.#doc = doc;
    this.#file = options.file;
    this.#autosaveMs = options.autosaveMs ?? 1000;
  }

  /**
   * Load a store, creating it from `defaults` when the file is absent.
   *
   * A missing file is not an error — a fresh bot starts with an empty document.
   * A file that exists but is unreadable *is* an error, and is reported as one
   * rather than silently reset: quietly starting from an empty document is how
   * a bot loses a whitelist with no trace.
   */
  static async open(options: JsonStoreOptions): Promise<JsonStore> {
    const defaults = options.defaults ?? {};
    let raw: string;
    try {
      raw = await readFile(options.file, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw err;
      return new JsonStore({ ...defaults }, options);
    }

    if (raw.trim() === '') return new JsonStore({ ...defaults }, options);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new CorruptStoreError(options.file, (err as Error).message);
    }
    // An array or a bare scalar parses fine but is not a document — a store
    // whose values cannot be keyed is not a store.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CorruptStoreError(options.file, 'the top level is not an object');
    }

    return new JsonStore({ ...defaults, ...(parsed as Document) }, options);
  }

  /** Read-only view of the document. Mutating it does not schedule a save. */
  get data(): Readonly<Document> {
    return this.#doc;
  }

  get file(): string {
    return this.#file;
  }

  has(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.#doc, key);
  }

  get<T = unknown>(key: string): T | undefined {
    return this.#doc[key] as T | undefined;
  }

  /** Read a value, writing and returning `fallback` when the key is absent. */
  ensure<T>(key: string, fallback: T): T {
    if (!this.has(key)) this.set(key, fallback);
    return this.#doc[key] as T;
  }

  set(key: string, value: unknown): this {
    if (this.#doc[key] === value) return this;
    // `doc[key] = value` would route `__proto__` to the prototype setter
    // instead of storing data — a silent prototype-pollution hole, since keys
    // here are jids and usernames chosen by whoever is messaging the bot.
    // Defining the property writes an own key whatever it is called.
    Object.defineProperty(this.#doc, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    this.#schedule();
    return this;
  }

  /**
   * Derive the next value from the current one.
   *
   * Returns the value the updater produced, so callers that need it do not
   * have to read it back. An updater that throws leaves the document untouched.
   */
  update<T>(key: string, updater: (current: T | undefined) => T): T {
    const next = updater(this.#doc[key] as T | undefined);
    this.set(key, next);
    return next;
  }

  delete(key: string): boolean {
    if (!this.has(key)) return false;
    delete this.#doc[key];
    this.#schedule();
    return true;
  }

  /** Remove every key whose name starts with `prefix`. Returns the count. */
  deletePrefix(prefix: string): number {
    let removed = 0;
    for (const key of Object.keys(this.#doc)) {
      if (key.startsWith(prefix)) {
        delete this.#doc[key];
        removed += 1;
      }
    }
    if (removed > 0) this.#schedule();
    return removed;
  }

  keys(): string[] {
    return Object.keys(this.#doc);
  }

  get size(): number {
    return Object.keys(this.#doc).length;
  }

  clear(): void {
    for (const key of Object.keys(this.#doc)) delete this.#doc[key];
    this.#schedule();
  }

  /** Run `fn` with the document, then save if it changed anything. */
  transact<T>(fn: (doc: Document) => T): T {
    const before = this.#doc;
    const draft: Document = { ...before };
    const result = fn(draft);
    this.#doc = draft;
    this.#schedule();
    return result;
  }

  /**
   * Write now, cancelling any pending autosave.
   *
   * Concurrent callers share one write: a second `flush()` during an in-flight
   * write awaits that write rather than starting a competing one against the
   * same temp path.
   */
  flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#writing) return this.#writing;

    this.#writing = this.#write().finally(() => {
      this.#writing = null;
    });
    return this.#writing;
  }

  async #write(): Promise<void> {
    const body = `${JSON.stringify(this.#doc, null, 2)}\n`;
    const tmp = join(dirname(this.#file), `.${Date.now()}.tmp`);
    await mkdir(dirname(this.#file), { recursive: true });
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, this.#file);

    this.#bytes = Buffer.byteLength(body);
    this.#saves += 1;
    this.#lastSavedAt = Date.now();
    const snapshot = this.#doc;
    for (const listener of this.#listeners) listener(snapshot);
  }

  #schedule(): void {
    if (this.#closed) return;
    if (this.#autosaveMs <= 0) return;
    if (this.#timer) {
      // Already waiting: coalesce into the pending write rather than pushing
      // the deadline out. Restarting the timer on every mutation would starve
      // the save entirely under a continuous stream of messages.
      this.#coalesced += 1;
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, this.#autosaveMs);
    this.#timer.unref?.();
  }

  /** True while a write is scheduled or in flight. */
  get pending(): boolean {
    return this.#timer !== null || this.#writing !== null;
  }

  /** Notified after every completed write. Returns an unsubscribe function. */
  onSave(listener: (doc: Readonly<Document>) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  stats(): JsonStoreStats {
    return {
      keys: this.size,
      file: this.#file,
      bytes: this.#bytes,
      saves: this.#saves,
      lastSavedAt: this.#lastSavedAt,
      coalesced: this.#coalesced,
    };
  }

  /**
   * Stop autosaving and flush, once.
   *
   * Idempotent by design. After the first call the store is sealed: later
   * mutations stay in memory, so a second `dispose()` must not write them out —
   * otherwise "disposed means nothing more is persisted" would be true only
   * until someone disposes twice.
   */
  async dispose(): Promise<void> {
    this.#disposed ??= (async () => {
      this.#closed = true;
      this.#listeners.clear();
      await this.flush();
    })();
    return this.#disposed;
  }
}

/** Convenience wrapper for the common `open`-then-`use` shape. */
export async function openStore(options: JsonStoreOptions): Promise<JsonStore> {
  return JsonStore.open(options);
}
