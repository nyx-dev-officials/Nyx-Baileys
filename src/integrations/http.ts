/**
 * HTTP layer for third-party integrations.
 *
 * The integrations in `apis.ts` are ten-line wrappers. This is the part that
 * matters when they run inside a WhatsApp message handler, where a slow or
 * hostile endpoint becomes the user's problem:
 *
 *   - **Timeout on every request.** A hang must not pin a flow step forever.
 *   - **Retry with jittered backoff**, on 429/5xx/network only. Retrying a 400
 *     just burns the rate limit you already exhausted.
 *   - **`Retry-After` is obeyed** on 429. Public APIs publish it; ignoring it
 *     is the fastest way to get a host to block you outright.
 *   - **Per-host rate limiting**, token bucket, because these are shared free
 *     tiers and your bot is not the only caller.
 *   - **TTL cache.** Repeated lookups (`?zip`, `?city`) are the common case and
 *     most of these endpoints have no reason to be hit twice a minute.
 *
 * No dependencies: `fetch` is built in from Node 18.
 */

export interface HttpClientOptions {
  timeoutMs?: number;
  retries?: number;
  baseRetryMs?: number;
  maxRetryMs?: number;
  /** Default cache TTL. 0 disables caching. */
  cacheTtlMs?: number;
  userAgent?: string;
  /** Per-host overrides, e.g. `{ 'nominatim.openstreetmap.org': 1 }`. */
  rateLimits?: Record<string, number>;
  /** Default requests-per-second per host. Default 2. */
  defaultRps?: number;
}

export interface RequestOptions {
  /** Query parameters; undefined values are dropped. */
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  /** Overrides the client default for this call. */
  timeoutMs?: number;
  /** Bypass the cache for this call. */
  fresh?: boolean;
  signal?: AbortSignal;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
    /** Raw `Retry-After` in seconds, when the server sent one. */
    readonly retryAfter?: string,
  ) {
    super(`HTTP ${status} from ${host(url)}: ${truncate(body, 120)}`);
    this.name = 'HttpError';
  }

  /**
   * Milliseconds to wait before retrying, from `Retry-After`, or null.
   *
   * Public APIs publish this header specifically so clients back off instead of
   * hammering them. Ignoring it is the fastest way to get a host to block you.
   * Both the delta-seconds and HTTP-date forms are accepted.
   */
  backoffMs(now = Date.now()): number | null {
    if (!this.retryAfter) return null;

    const seconds = Number(this.retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

    const at = Date.parse(this.retryAfter);
    if (Number.isFinite(at)) return Math.max(0, at - now);

    return null;
  }
}

export class TimeoutError extends Error {
  constructor(readonly url: string, readonly ms: number) {
    super(`request to ${host(url)} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

interface CacheEntry {
  at: number;
  value: unknown;
}

/** Token bucket, refilled lazily. One bucket per host. */
class Bucket {
  #tokens: number;
  #last = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly perSecond: number,
  ) {
    this.#tokens = capacity;
  }

  /** Milliseconds to wait, or 0 if a token is available now. */
  take(now = Date.now()): number {
    const refill = ((now - this.#last) / 1000) * this.perSecond;
    if (refill > 0) {
      this.#tokens = Math.min(this.capacity, this.#tokens + refill);
      this.#last = now;
    }

    if (this.#tokens >= 1) {
      this.#tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - this.#tokens) / this.perSecond) * 1000);
  }
}

export class HttpClient {
  readonly #timeout: number;
  readonly #retries: number;
  readonly #baseRetry: number;
  readonly #maxRetry: number;
  readonly #cacheTtl: number;
  readonly #ua: string;
  readonly #defaultRps: number;
  readonly #overrides: Record<string, number>;

  #buckets = new Map<string, Bucket>();
  #cache = new Map<string, CacheEntry>();
  #inFlight = new Map<string, Promise<unknown>>();

  constructor(options: HttpClientOptions = {}) {
    this.#timeout = options.timeoutMs ?? 10_000;
    this.#retries = options.retries ?? 2;
    this.#baseRetry = options.baseRetryMs ?? 250;
    this.#maxRetry = options.maxRetryMs ?? 4_000;
    this.#cacheTtl = options.cacheTtlMs ?? 60_000;
    this.#ua = options.userAgent ?? 'nyx-baileys/0.3 (+integration-layer)';
    this.#defaultRps = options.defaultRps ?? 2;
    this.#overrides = options.rateLimits ?? {};
  }

  async get<T>(url: string, options: RequestOptions = {}): Promise<T> {
    return this.#request<T>('GET', url, options);
  }

  /**
   * A single request with timeout, retry, rate limiting and caching. Identical
   * concurrent GETs share one in-flight promise, so a burst of users asking
   * the same question costs one upstream call.
   */
  async #request<T>(method: string, url: string, options: RequestOptions): Promise<T> {
    const full = withQuery(url, options.query);
    const cacheable = method === 'GET' && !options.fresh;

    if (cacheable) {
      const hit = this.#cache.get(full);
      if (hit && Date.now() - hit.at < this.#cacheTtl) return hit.value as T;

      const pending = this.#inFlight.get(full);
      if (pending) return pending as Promise<T>;
    }

    const run = this.#attemptLoop<T>(method, full, options).then((value) => {
      if (cacheable) this.#cache.set(full, { at: Date.now(), value });
      return value;
    });

    if (cacheable) {
      this.#inFlight.set(full, run as Promise<unknown>);
      void run
        .catch(() => undefined)
        .finally(() => this.#inFlight.delete(full));
    }

    return run;
  }

  async #attemptLoop<T>(method: string, url: string, options: RequestOptions): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.#retries; attempt += 1) {
      await this.#throttle(url);

      try {
        return await this.#attempt<T>(method, url, options);
      } catch (err) {
        lastError = err;
        if (!shouldRetry(err) || attempt === this.#retries) throw err;

        // Honour Retry-After ahead of our own backoff when the server sets it.
        const retryAfter = err instanceof HttpError ? err.backoffMs() : null;
        const backoff = Math.min(this.#maxRetry, this.#baseRetry * 2 ** attempt);
        const wait = retryAfter ?? Math.floor(backoff / 2 + Math.random() * (backoff / 2));
        await sleep(Math.min(wait, 30_000));
      }
    }

    throw lastError;
  }

  async #attempt<T>(method: string, url: string, options: RequestOptions): Promise<T> {
    const controller = new AbortController();
    const budget = options.timeoutMs ?? this.#timeout;
    const timer = setTimeout(() => controller.abort(), budget);
    timer.unref?.();

    // Honour an external signal by forwarding its abort.
    const onAbort = (): void => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const res = await fetch(url, {
        method,
        headers: { 'user-agent': this.#ua, accept: 'application/json', ...options.headers },
        signal: controller.signal,
      });

      const text = await res.text();

      if (!res.ok) throw new HttpError(res.status, url, text, res.headers.get('retry-after') ?? undefined);

      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        // Not every endpoint returns JSON despite the Accept header.
        return text as unknown as T;
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (controller.signal.aborted) throw new TimeoutError(url, budget);
      throw err;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  async #throttle(url: string): Promise<void> {
    const h = host(url);
    let bucket = this.#buckets.get(h);
    if (!bucket) {
      const rps = this.#overrides[h] ?? this.#defaultRps;
      bucket = new Bucket(Math.max(1, Math.ceil(rps)), rps);
      this.#buckets.set(h, bucket);
    }

    const wait = bucket.take();
    if (wait > 0) await sleep(wait);
  }

  /** Drop cached responses, e.g. after a config change. */
  clearCache(): void {
    this.#cache.clear();
  }

  stats(): { cached: number; hosts: number; inFlight: number } {
    return { cached: this.#cache.size, hosts: this.#buckets.size, inFlight: this.#inFlight.size };
  }
}

/** Retry only what a retry can fix. A 400 or 404 will never succeed. */
function shouldRetry(err: unknown): boolean {
  if (err instanceof TimeoutError) return true;
  if (err instanceof HttpError) return err.status === 429 || err.status >= 500;
  return true; // network-level failure
}

function withQuery(url: string, query: RequestOptions['query']): string {
  if (!query) return url;
  const entries = Object.entries(query).filter(([, v]) => v !== undefined && v !== '');
  if (!entries.length) return url;

  const params = new URLSearchParams(entries.map(([k, v]) => [k, String(v)]));
  return url.includes('?') ? `${url}&${params}` : `${url}?${params}`;
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 40);
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const sharedHttp = new HttpClient();
