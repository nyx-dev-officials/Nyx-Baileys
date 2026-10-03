import { patch } from '../core/intercept.js';
import type { AntiSpamOptions, Plugin } from '../utils/types.js';

/**
 * Anti-spam pacing.
 *
 * A human does not send 500 messages in a burst, and more importantly a human
 * does not send them on a metronome. This wraps `sendMessage` and
 * `relayMessage` in a queue that spaces sends with a jittered gap and enforces
 * a per-minute ceiling. The delay is drawn from a bounded distribution rather
 * than `random(0, max)` so it doesn't cluster at zero, and it is *widened* when
 * health has been elevated.
 *
 * Scope: outbound pacing. It does not fabricate presence — see `docs/DESIGN-NOTES.md`.
 */

const DEFAULTS: AntiSpamOptions = {
  minGapMs: 2_500,
  jitterMs: 4_000,
  maxPerMinute: 20,
  maxQueue: 500,
};

interface QueueItem {
  run: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

export function antiSpam(user: Partial<AntiSpamOptions> = {}): Plugin {
  const cfg = { ...DEFAULTS, ...user };

  return {
    name: 'anti-spam',
    order: 80,

    apply(ctx) {
      const log = ctx.log.child('antispam');
      const queue: QueueItem[] = [];
      const sentAt: number[] = [];
      let draining = false;
      /** Multiplier on gaps, raised when the health plugin sees bad signals. */
      let pressure = 1;

      /** Box–Muller, clamped. Bounded distribution, not uniform. */
      const gap = (): number => {
        const u = Math.max(Number.EPSILON, Math.random());
        const v = Math.random();
        const normal = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
        const clamped = Math.max(0, Math.min(1, (normal + 2.5) / 5)); // ~±2.5σ
        return (cfg.minGapMs + clamped * cfg.jitterMs) * pressure;
      };

      /** Sliding 60s window; throws when the burst ceiling is reached. */
      const admit = (): void => {
        const now = Date.now();
        while (sentAt.length && now - sentAt[0]! >= 60_000) sentAt.shift();
        if (sentAt.length >= cfg.maxPerMinute) {
          throw new Error(
            `anti-spam: burst ceiling ${cfg.maxPerMinute}/min reached; queueing is the right call here`,
          );
        }
        sentAt.push(now);
      };

      const drain = async (): Promise<void> => {
        if (draining) return;
        draining = true;
        try {
          let previous = Date.now();
          while (queue.length) {
            const item = queue.shift()!;
            try {
              const wait = gap() - (Date.now() - previous);
              if (wait > 0) await sleep(wait);
              admit();
              const result = await item.run();
              previous = Date.now();
              item.resolve(result);
            } catch (err) {
              item.reject(err);
            }
          }
        } finally {
          draining = false;
        }
      };

      /** Wrap a socket method so every call passes the queue. */
      const gate = (name: string, fn: (...args: never[]) => unknown): void => {
        void fn;
        const handle = patch(ctx.sock as never, name, ((
          original: (...args: unknown[]) => unknown,
          self: unknown,
          args: unknown[],
        ): Promise<unknown> => {
          if (queue.length >= cfg.maxQueue) {
            return Promise.reject(new Error(`anti-spam: queue full (${cfg.maxQueue})`));
          }
          return new Promise((resolve, reject) => {
            queue.push({
              run: () => Promise.resolve(Reflect.apply(original, self, args)),
              resolve,
              reject,
            });
            void drain();
          });
        }) as never);
        if (!handle.applied) {
          log.warn('method missing, anti-spam not attached', { method: name });
        } else {
          ctx.onDispose(() => handle.undo());
        }
      };

      gate('sendMessage', ctx.sock.sendMessage as never);
      gate('relayMessage', ctx.sock.relayMessage as never);

      // Widen or tighten pacing from outside (health plugin, admin command).
      (ctx.sock as unknown as Record<string, unknown>).__antispam = {
        setPressure: (n: number) => {
          pressure = Math.max(1, n);
        },
        stats: () => ({ queued: queue.length, sent: sentAt.length, pressure }),
        reset: () => {
          queue.length = 0;
          sentAt.length = 0;
          pressure = 1;
        },
      };

      log.debug('attached', cfg);
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export default antiSpam;
