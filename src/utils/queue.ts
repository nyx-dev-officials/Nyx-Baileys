/**
 * Concurrency primitives.
 *
 * A bot fans work out faster than it can finish it — downloads, sends, group
 * updates — and doing all of it at once is how you get rate-limited or run out
 * of file descriptors. These are the three shapes that cover it:
 *
 *   - `TaskQueue`  run at most `concurrency` tasks at once, in submission order
 *   - `Semaphore`  the same limit without the queueing sugar, for a code region
 *   - `withRetry`  retry an async call with capped exponential backoff
 *
 * All three are deterministic: no timers unless the task itself sleeps, so they
 * test with plain `await`.
 */

/* ── TaskQueue ───────────────────────────────────────────────────────── */

export interface TaskQueueOptions {
  /** Maximum tasks in flight. Default 1 (strictly serial). */
  concurrency?: number;
  /** Called when a task throws. Without it, a failure is swallowed. */
  onError?: (error: unknown, task: unknown) => void;
}

export class TaskQueue {
  readonly #concurrency: number;
  readonly #onError: ((error: unknown, task: unknown) => void) | undefined;
  readonly #pending: Array<{ run: () => Promise<void>; task: unknown }> = [];
  #active = 0;
  #paused = false;
  #idleResolvers: Array<() => void> = [];

  constructor(options: TaskQueueOptions = {}) {
    this.#concurrency = Math.max(1, options.concurrency ?? 1);
    this.#onError = options.onError;
  }

  /** Tasks waiting for a slot (not counting those running). */
  get size(): number {
    return this.#pending.length;
  }

  /** Tasks currently running. */
  get active(): number {
    return this.#active;
  }

  /** True when nothing is pending or running. */
  get idle(): boolean {
    return this.#pending.length === 0 && this.#active === 0;
  }

  get paused(): boolean {
    return this.#paused;
  }

  /**
   * Enqueue `task`. Returns a promise that settles when the task itself has run
   * (resolving or rejecting the same way), so callers can await their turn.
   */
  add<T>(task: () => Promise<T> | T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.#pending.push({
        task: task as unknown,
        run: async () => {
          try {
            resolve(await task());
          } catch (error) {
            if (this.#onError) this.#onError(error, task);
            reject(error);
          }
        },
      });
      this.#drain();
    });
  }

  /** Stop starting new tasks. Running ones finish. */
  pause(): void {
    this.#paused = true;
  }

  /** Resume after `pause()`. */
  resume(): void {
    this.#paused = false;
    this.#drain();
  }

  /** Drop everything still waiting. Running tasks are unaffected. */
  clear(): void {
    this.#pending.length = 0;
    this.#settleIdle();
  }

  /** Resolves once the queue is empty, or immediately when it already is. */
  onIdle(): Promise<void> {
    if (this.idle) return Promise.resolve();
    return new Promise((resolve) => this.#idleResolvers.push(resolve));
  }

  #drain(): void {
    if (this.#paused) return;
    while (this.#active < this.#concurrency && this.#pending.length > 0) {
      const next = this.#pending.shift()!;
      this.#active += 1;
      void next
        .run()
        .catch(() => {})
        .finally(() => {
          this.#active -= 1;
          this.#drain();
          this.#settleIdle();
        });
    }
    this.#settleIdle();
  }

  #settleIdle(): void {
    if (!this.idle || this.#idleResolvers.length === 0) return;
    const resolvers = this.#idleResolvers;
    this.#idleResolvers = [];
    for (const resolve of resolvers) resolve();
  }
}

/* ── Semaphore ───────────────────────────────────────────────────────── */

export class Semaphore {
  readonly #limit: number;
  #taken = 0;
  readonly #waiters: Array<() => void> = [];

  constructor(limit = 1) {
    this.#limit = Math.max(1, limit);
  }

  get available(): number {
    return this.#limit - this.#taken;
  }

  get waiting(): number {
    return this.#waiters.length;
  }

  async acquire(): Promise<void> {
    if (this.#taken < this.#limit) {
      this.#taken += 1;
      return;
    }
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
    this.#taken += 1;
  }

  release(): void {
    if (this.#taken === 0) return;
    this.#taken -= 1;
    const next = this.#waiters.shift();
    // The woken waiter increments on its own resume; keep the slot reserved
    // until it does by not decrementing further here.
    next?.();
  }

  /** Run `fn` holding one slot, releasing it even if `fn` throws. */
  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/* ── retry ───────────────────────────────────────────────────────────── */

export interface RetryOptions {
  /** Total attempts, including the first. Default 3. */
  attempts?: number;
  /** First delay in ms. Default 250. */
  baseDelayMs?: number;
  /** Upper bound on a single delay. Default 30 000. */
  maxDelayMs?: number;
  /** Multiplier per attempt. Default 2. */
  factor?: number;
  /** Return false to stop retrying (e.g. a permanent error). */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Sleep injection for tests. Defaults to a real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Watch each failure. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/**
 * The backoff sleep between retries.
 *
 * Deliberately NOT unref'd. This timer is frequently the only thing holding the
 * event loop open — a short-lived script or a CLI that calls `withRetry` and
 * awaits it has nothing else pending — and an unref'd timer lets Node decide the
 * loop is empty and exit. The observable result is that the retry never happens:
 * the process dies mid-backoff with `Warning: Detected unsettled top-level await`
 * and the caller sees no error at all, which is exactly the failure the retry
 * existed to prevent. Measured on 2026-10-04.
 *
 * `sleep` is injectable, so tests still run instantly via `sleep: () => Promise.resolve()`.
 */
const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Call `fn`, retrying on rejection with capped exponential backoff. The final
 * rejection is the last error thrown, so the caller sees the real cause.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T> | T, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const base = Math.max(0, options.baseDelayMs ?? 250);
  const max = Math.max(base, options.maxDelayMs ?? 30_000);
  const factor = options.factor ?? 2;
  const sleep = options.sleep ?? realSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const canRetry = options.shouldRetry ? options.shouldRetry(error, attempt) : true;
      if (attempt === attempts || !canRetry) break;
      const delay = Math.min(max, base * factor ** (attempt - 1));
      options.onRetry?.(error, attempt, delay);
      if (delay > 0) await sleep(delay);
    }
  }
  throw lastError;
}

/** Backoff delay for a given attempt, matching `withRetry`'s schedule. */
export function backoffDelay(attempt: number, options: RetryOptions = {}): number {
  const base = Math.max(0, options.baseDelayMs ?? 250);
  const max = Math.max(base, options.maxDelayMs ?? 30_000);
  const factor = options.factor ?? 2;
  return Math.min(max, base * factor ** (Math.max(1, attempt) - 1));
}
