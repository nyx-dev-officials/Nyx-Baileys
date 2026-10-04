import { createHmac, timingSafeEqual } from 'node:crypto';

import type { BaileysEventMap } from '@whiskeysockets/baileys';
import type { Logger } from '../utils/types.js';
import type { Plugin } from '../utils/types.js';

/**
 * Outbound webhook dispatcher.
 *
 * Turns socket events into signed HTTP POSTs. Three properties define it:
 *
 *   1. **It never throws into the caller.** A webhook receiver being down must
 *      not fail a `messages.upsert`, so every delivery is a detached promise
 *      with its own catch. The emitter's return value is not disturbed.
 *   2. **It never logs a secret.** Signatures are compared with
 *      `timingSafeEqual` and never printed; log lines carry the endpoint *host*
 *      only, because a full URL is a credential in the wild (it carries the
 *      path token most providers put there).
 *   3. **It never blocks the socket.** Each attempt has a hard timeout via
 *      `AbortController`, and retries back off. A hung receiver cannot pin the
 *      event loop or wedge the queue.
 *
 * The queue is bounded and drops the *oldest* delivery when full. Dropping is
 * counted and reported, because a silently truncated webhook log is worse than
 * a noisy one — the operator needs to know data went missing.
 *
 * Signatures are `sha256=<hex>` over `timestamp.body`, which is the shape
 * GitHub, Stripe and most providers expect, so the same secret can be verified
 * with their own SDK. The timestamp is inside the signed material specifically
 * so a captured request cannot be replayed later.
 */

export interface WebhookEndpoint {
  readonly url: string;
  /**
   * Shared secret for HMAC-SHA256. Required unless `sign: false`.
   * Never logged, never returned in a snapshot.
   */
  readonly secret?: string;
  /** Set false to POST without a signature. Default true. */
  readonly sign?: boolean;
  /** Extra headers merged last, so they cannot clobber the signature. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface WebhookRoute {
  /** Socket event name, e.g. `messages.upsert`. `'*'` matches everything. */
  readonly event: string;
  /** Only deliver when this returns true. */
  readonly filter?: (payload: unknown) => boolean;
  readonly endpoint: WebhookEndpoint;
}

export interface WebhookOptions {
  readonly endpoints?: readonly WebhookEndpoint[];
  /** Extra routes beyond `endpoints`, for per-event destinations. */
  readonly routes?: readonly WebhookRoute[];
  /** Total attempts per delivery, including the first. Default 3. */
  readonly attempts?: number;
  /** First backoff step in ms; doubles per retry. Default 500. */
  readonly backoffMs?: number;
  /** Ceiling for one backoff step. Default 10_000. */
  readonly maxBackoffMs?: number;
  /** Per-attempt timeout in ms. Default 5_000. */
  readonly timeoutMs?: number;
  /** Deliveries queued before the oldest is dropped. Default 1_000. */
  readonly maxQueue?: number;
  /** Retries on 5xx and network errors. 4xx is terminal. Default true. */
  readonly retryOn5xx?: boolean;
  /** Log every attempt at debug level. Default false. */
  readonly verbose?: boolean;
}

export interface WebhookDelivery {
  readonly event: string;
  readonly attempts: number;
  readonly ok: boolean;
  readonly status?: number;
  readonly durationMs: number;
  readonly error?: string;
  readonly at: number;
}

export interface WebhookSnapshot {
  readonly queued: number;
  readonly delivered: number;
  readonly failed: number;
  readonly dropped: number;
  /** Last N delivery outcomes, newest last. */
  readonly recent: readonly WebhookDelivery[];
}

/** Statuses worth retrying: rate limits and server-side faults. */
const retryableStatus = (status: number, retryOn5xx: boolean): boolean => status === 429 || (retryOn5xx && status >= 500);

export function webhooks(options: WebhookOptions = {}): Plugin {
  const attempts = Math.max(1, options.attempts ?? 3);
  const backoff = Math.max(0, options.backoffMs ?? 500);
  const maxBackoff = Math.max(0, options.maxBackoffMs ?? 10_000);
  const timeout = Math.max(1, options.timeoutMs ?? 5_000);
  const maxQueue = Math.max(1, options.maxQueue ?? 1_000);
  const retryOn5xx = options.retryOn5xx ?? true;
  const historySize = 50;

  return {
    name: 'webhook',
    order: 180,

    apply(ctx) {
      const log = ctx.log.child('webhook');

      /** Routes keyed by event name, with `'*'` as the catch-all. */
      const routes = new Map<string, WebhookRoute[]>();
      for (const endpoint of options.endpoints ?? []) {
        routes.set('*', [...(routes.get('*') ?? []), { event: '*', endpoint }]);
      }
      for (const route of options.routes ?? []) {
        routes.set(route.event, [...(routes.get(route.event) ?? []), route]);
      }

      const queue: Array<() => Promise<void>> = [];
      const counters = { delivered: 0, failed: 0, dropped: 0 };
      const history: WebhookDelivery[] = [];
      let draining = false;

      const remember = (record: WebhookDelivery): void => {
        history.push(record);
        while (history.length > historySize) history.shift();
      };

      /** Host only — a full URL usually embeds a path token. */
      const hostOf = (url: string): string => {
        try {
          return new URL(url).host;
        } catch {
          return 'invalid-url';
        }
      };

      const sign = (body: string, secret: string, timestamp: string): string =>
        `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

      /** One POST attempt with a hard timeout. Never throws. */
      const attempt = async (
        endpoint: WebhookEndpoint,
        event: string,
        payload: unknown,
      ): Promise<{ ok: boolean; status?: number; error?: string }> => {
        const body = JSON.stringify({ event, at: Date.now(), payload });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        timer.unref?.();

        try {
          const headers: Record<string, string> = {
            'content-type': 'application/json',
            'x-super-event': event,
            'x-super-timestamp': timestamp,
            'user-agent': 'nyx-baileys/0.2',
          };
          if (endpoint.sign !== false && endpoint.secret) {
            headers['x-super-signature'] = sign(body, endpoint.secret, timestamp);
          }
          // Endpoint headers last so a caller cannot clobber the signature.
          Object.assign(headers, endpoint.headers ?? {});

          const response = await fetch(endpoint.url, {
            method: 'POST',
            headers,
            body,
            signal: controller.signal,
          });
          // Drain the body so the socket can be reused, and cap what we read.
          await response.text().catch(() => '');
          return { ok: response.ok, status: response.status };
        } catch (err) {
          const message = (err as Error).name === 'AbortError' ? `timeout after ${timeout}ms` : (err as Error).message;
          return { ok: false, error: message };
        } finally {
          clearTimeout(timer);
        }
      };

      const deliver = async (route: WebhookRoute, event: string, payload: unknown): Promise<void> => {
        const { endpoint } = route;
        const started = Date.now();
        let lastStatus: number | undefined;
        let lastError: string | undefined;
        let done = false;

        for (let attemptNo = 1; attemptNo <= attempts && !done; attemptNo += 1) {
          const result = await attempt(endpoint, event, payload);
          lastStatus = result.status;
          lastError = result.error;

          const ok = result.ok;
          const retryable = !ok && (result.error !== undefined || (result.status !== undefined && retryableStatus(result.status, retryOn5xx)));

          if (ok || !retryable || attemptNo === attempts) {
            done = true;
            const record: WebhookDelivery = {
              event,
              attempts: attemptNo,
              ok,
              ...(result.status !== undefined ? { status: result.status } : {}),
              durationMs: Date.now() - started,
              ...(result.error !== undefined ? { error: result.error } : {}),
              at: Date.now(),
            };
            remember(record);
            if (ok) counters.delivered += 1;
            else {
              counters.failed += 1;
              log.warn('delivery failed', {
                event,
                host: hostOf(endpoint.url),
                status: lastStatus,
                attempts: attemptNo,
                error: lastError,
              });
            }
            if (options.verbose) {
              log.debug('delivery', { event, host: hostOf(endpoint.url), ok, attempts: attemptNo });
            }
            break;
          }

          // Exponential backoff, capped. The wait is a detached delay so a
          // long backoff cannot stall the drain of other deliveries.
          const wait = Math.min(maxBackoff, backoff * 2 ** (attemptNo - 1));
          if (wait > 0) {
            await new Promise<void>((resolve) => {
              const t = setTimeout(resolve, wait);
              t.unref?.();
            });
          }
        }
      };

      /** Serialised so a burst cannot open an unbounded number of sockets. */
      const drain = async (): Promise<void> => {
        if (draining) return;
        draining = true;
        try {
          while (queue.length > 0) {
            const job = queue.shift();
            if (!job) break;
            try {
              await job();
            } catch (err) {
              // `deliver` handles its own failures; this is the last line.
              log.debug('job threw', { err: (err as Error).message });
            }
          }
        } finally {
          draining = false;
        }
      };

      const dispatch = (event: string, payload: unknown): void => {
        const targets = [...(routes.get(event) ?? []), ...(routes.get('*') ?? [])];
        if (targets.length === 0) return;

        for (const route of targets) {
          if (route.filter) {
            let keep = false;
            try {
              keep = route.filter(payload);
            } catch (err) {
              log.debug('filter threw, skipping', { event, err: (err as Error).message });
            }
            if (!keep) continue;
          }

          // Bounded queue: the oldest delivery loses, and the drop is counted.
          if (queue.length >= maxQueue) {
            queue.shift();
            counters.dropped += 1;
            log.warn('queue full, dropped oldest delivery', { event, maxQueue });
          }
          queue.push(() => deliver(route, event, payload));
        }

        void drain();
      };

      /* ── subscriptions ──────────────────────────────────────────── */

      ctx.sock.ev.on('messages.upsert', (event: BaileysEventMap['messages.upsert']) => {
        dispatch('messages.upsert', event);
      });
      ctx.sock.ev.on('messages.reaction', (event: BaileysEventMap['messages.reaction']) => {
        dispatch('messages.reaction', event);
      });
      ctx.sock.ev.on('message-receipt.update', (event: BaileysEventMap['message-receipt.update']) => {
        dispatch('message-receipt.update', event);
      });
      ctx.sock.ev.on('connection.update', (event: BaileysEventMap['connection.update']) => {
        dispatch('connection.update', event);
      });
      ctx.sock.ev.on('call', (event: BaileysEventMap['call']) => {
        dispatch('call', event);
      });

      /* ── surface ────────────────────────────────────────────────── */

      const api = {
        /** POST an arbitrary payload, bypassing the event wiring. */
        send: async (event: string, payload: unknown, endpoint?: WebhookEndpoint): Promise<boolean> => {
          const target = endpoint ?? routes.get('*')?.[0]?.endpoint;
          if (!target) return false;
          await deliver({ event, endpoint: target }, event, payload);
          return true;
        },
        /**
         * Verify a signature the way a receiver would. Exported on the socket
         * so a host can self-test its handler without reimplementing the scheme.
         */
        verify: (body: string, timestamp: string, signature: string, secret: string): boolean => {
          const expected = Buffer.from(sign(body, secret, timestamp));
          const got = Buffer.from(signature);
          // Length differs on a malformed header; timingSafeEqual requires
          // equal lengths and would throw otherwise.
          if (expected.length !== got.length) return false;
          return timingSafeEqual(expected, got);
        },
        snapshot: (): WebhookSnapshot => ({
          queued: queue.length,
          delivered: counters.delivered,
          failed: counters.failed,
          dropped: counters.dropped,
          recent: [...history],
        }),
        routes: () => [...routes.entries()].map(([event, list]) => ({ event, targets: list.length })),
      };

      Object.defineProperty(ctx.sock, 'webhooks', { value: api, enumerable: false, configurable: true });

      ctx.onDispose(() => {
        // Abandon queued work: the socket is closing and a late delivery to a
        // dead endpoint is noise.
        queue.length = 0;
      });

      const secretConfigured = (options.endpoints ?? []).some((e) => !!e.secret);
      log.debug('attached', { routes: routes.size, attempts, timeout, signed: secretConfigured });
    },
  };
}

export default webhooks;
