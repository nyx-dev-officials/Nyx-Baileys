import { BurstCeilingError, QueueFullError } from '../core/errors.js';
import { patch } from '../core/intercept.js';
import type { AntiSpamOptions, Plugin } from '../utils/types.js';

/**
 * Anti-spam pacing.
 *
 * A human does not send 500 messages in a burst, and more importantly a human
 * does not send them on a metronome. This wraps the outbound `sendMessage`
 * entry point in a queue that spaces sends with a jittered gap and enforces a
 * per-minute ceiling. The delay is drawn from a bounded distribution rather
 * than `random(0, max)` so it doesn't cluster at zero, and it is *widened* when
 * health has been elevated.
 *
 * Only `sendMessage` is gated. `relayMessage` is the lower-level path other
 * layers drive directly — the poll plugin, protocol messages, the
 * interactive-message workaround — and pushing those through a 2.5–6.5 s queue
 * is not anti-spam, it is latency on machinery this plugin does not own. Gating
 * it also meant every such call paid the queue's gap before going out, which
 * looked exactly like the send path hanging.
 *
 * And within `sendMessage`, only real messages are paced. Reactions, edits,
 * revokes, pins and the disappearing-messages toggle go straight out — see
 * `NON_MESSAGE_KEYS` — so they neither wait out a gap nor consume the
 * per-minute ceiling meant for sends.
 *
 * Scope: outbound pacing. It does not fabricate presence — see `docs/DESIGN-NOTES.md`.
 */

const DEFAULTS: AntiSpamOptions = {
  minGapMs: 2_500,
  jitterMs: 4_000,
  maxPerMinute: 20,
  maxQueue: 500,
};

/**
 * `sendMessage` content keys that compile to a reaction or a *protocol* message
 * — an action on an existing message or account, not new chat content.
 *
 *   react                     → `reactionMessage`
 *   edit                      → text plus the edit wire attribute
 *   delete                    → `protocolMessage` REVOKE
 *   pin                       → `pinInChatMessage`
 *   disappearingMessagesInChat→ disappearing-setting protocol message
 *   sharePhoneNumber          → `protocolMessage` SHARE_PHONE_NUMBER
 *   limitSharing              → `protocolMessage` LIMIT_SHARING
 *
 * Every key here was read out of rc14's own content chain
 * (`Utils/messages.js:276-480`, `Socket/messages-send.js:1053-1140`), not
 * guessed. Content that compiles to a real message — `forward`, `poll`,
 * `event`, `album`, `buttonReply`, `listReply`, `groupInvite`, `product`,
 * media, text — deliberately stays paced.
 *
 * Why bypass them: they are not outbound sends, so pacing them is pure stall. A
 * user taps a reaction and it waits out a 2.5–6.5 s gap for no reason, and a
 * burst of revokes while moderating can fill a 500-message queue.
 */
const NON_MESSAGE_KEYS = [
  'react',
  'edit',
  'delete',
  'pin',
  'disappearingMessagesInChat',
  'sharePhoneNumber',
  'limitSharing',
] as const;

/**
 * True when `sendMessage` content is an action, not a message to pace.
 *
 * A key only counts when its value is non-nullish, matching upstream's own
 * `hasNonNullishProperty` test — so `{ text: 'hi', react: undefined }` is still
 * a paced text send, not a bypass.
 */
function isNonMessage(content: unknown): boolean {
  if (!content || typeof content !== 'object') return false;
  const rec = content as Record<string, unknown>;
  return NON_MESSAGE_KEYS.some((key) => rec[key] !== undefined && rec[key] !== null);
}

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
          throw new BurstCeilingError(cfg.maxPerMinute);
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

      /**
       * Wrap a socket method so every call passes the queue, unless `bypass`
       * recognises it as something that is not an outbound message.
       */
      const gate = (name: string, bypass?: (args: unknown[]) => boolean): void => {
        const handle = patch(ctx.sock as never, name, ((
          original: (...args: unknown[]) => unknown,
          self: unknown,
          args: unknown[],
        ): Promise<unknown> => {
          if (bypass?.(args)) {
            // Straight out, uncounted and unqueued — it is not a send.
            return Promise.resolve(Reflect.apply(original, self, args));
          }
          if (queue.length >= cfg.maxQueue) {
            return Promise.reject(new QueueFullError(cfg.maxQueue));
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

      // `sendMessage(jid, content, options)` — content is always argument 1.
      gate('sendMessage', (args) => isNonMessage(args[1]));

      // Widen or tighten pacing from outside (health plugin, admin command).
      (ctx.sock as unknown as Record<string, unknown>).__antispam = {
        setPressure: (n: number) => {
          pressure = Math.max(1, n);
        },
        stats: () => ({ queued: queue.length, sent: sentAt.length, pressure }),
        // The resolved config, not the defaults. `antiSpam` in SuperOptions used
        // to be silently discarded by `plugins()`, and there was no way to see
        // that from outside — the only symptom was pacing nobody had asked for.
        config: () => ({ ...cfg, pressure }),
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
