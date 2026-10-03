import { patch } from '../core/intercept.js';
import type { Plugin } from '../utils/types.js';

/**
 * Send-time presence.
 *
 * Presence is announced **only while a real message is in flight**. This is
 * what the official client does: it shows "typing…" while composing an actual
 * reply, and "recording…" while an actual voice note is uploading. There is no
 * idle loop here, and `composing` is never emitted without a `sendMessage` call
 * behind it — a chat showing "typing…" for a bot that is not typing is a false
 * statement to a real person.
 *
 * The 0–2s hold before clearing presence varies the *duration of real
 * activity*, which is what makes the indicator readable. It does not create
 * activity that is not happening, and it is bounded by the send completing or
 * failing.
 *
 * The hard guarantee: if the send never resolves, `finally` still clears it,
 * and `dispose()` cancels every pending timer — so a shutdown cannot leave a
 * stuck typing indicator behind.
 */

export interface SendPresenceOptions {
  /** Minimum `composing` hold, in ms. Default 250. */
  holdMinMs?: number;
  /** Maximum `composing` hold, in ms. Default 2000. */
  holdMaxMs?: number;
  /** Emit `recording` instead of `composing` for audio/video sends. Default true. */
  useRecordingForMedia?: boolean;
  /** Cap in-flight announcements, so a fan-out cannot storm the socket. */
  maxConcurrent?: number;
}

const AUDIO_VIDEO = 'audioMessage';
const VIDEO_TYPES = ['videoMessage', 'ptvMessage', 'lottieStickerMessage'];

const isMediaSend = (content: unknown): boolean => {
  const c = content as Record<string, unknown> | undefined;
  if (!c) return false;
  if (c[AUDIO_VIDEO] || c.image || c.video || c.sticker) return true;
  return VIDEO_TYPES.some((key) => key in c);
};

export function sendPresence(options: SendPresenceOptions = {}): Plugin {
  const holdMin = Math.max(0, options.holdMinMs ?? 250);
  const holdMax = Math.max(holdMin, options.holdMaxMs ?? 2_000);
  const useRecording = options.useRecordingForMedia !== false;
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? 8);

  return {
    name: 'send-presence',
    order: 155,

    apply(ctx) {
      const log = ctx.log.child('send-presence');
      const timers = new Set<NodeJS.Timeout>();
      let inFlight = 0;
      const counters = { announced: 0, skipped: 0, cleared: 0 };

      const hold = (): number => holdMin + Math.floor(Math.random() * (holdMax - holdMin + 1));

      const clearPresence = async (jid: string, state: 'available' | 'unavailable'): Promise<void> => {
        try {
          await ctx.sock.sendPresenceUpdate(state, jid);
          counters.cleared += 1;
        } catch (err) {
          log.debug('presence clear failed', { jid, err: (err as Error).message });
        }
      };

      /**
       * Announce, wait out the hold, then clear. Returns a disposer so
       * `dispose()` cannot leave a stuck indicator.
       */
      const announce = (jid: string, type: 'composing' | 'recording'): void => {
        if (!jid || inFlight >= maxConcurrent) {
          counters.skipped += 1;
          return;
        }
        inFlight += 1;

        const timer = setTimeout(() => {
          timers.delete(timer);
          inFlight = Math.max(0, inFlight - 1);
          void clearPresence(jid, 'available');
        }, hold());
        timer.unref?.();
        timers.add(timer);

        void ctx.sock
          .sendPresenceUpdate(type, jid)
          .then(() => {
            counters.announced += 1;
          })
          .catch((err: unknown) => {
            log.debug('presence announce failed', { jid, err: (err as Error).message });
          });
      };

      // sendMessage(jid, { ...content }, extra)
      const handle = patch(ctx.sock as never, 'sendMessage', ((
        original: (...args: unknown[]) => unknown,
        self: unknown,
        args: unknown[],
      ): unknown => {
        const jid = typeof args[0] === 'string' ? args[0] : undefined;
        const content = args[1];

        if (jid) {
          const type = useRecording && isMediaSend(content) ? 'recording' : 'composing';
          announce(jid, type);
        }

        const result = Reflect.apply(original, self, args);

        // A synchronous throw must not leave the indicator up.
        if (result instanceof Promise) {
          return result.catch((err: unknown) => {
            if (jid) void clearPresence(jid, 'available');
            throw err;
          });
        }
        return result;
      }) as never);

      if (handle.applied) ctx.onDispose(() => handle.undo());
      else log.warn('sendMessage missing; send-presence not attached');

      ctx.onDispose(() => {
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
      });

      Object.defineProperty(ctx.sock, 'sendPresenceStats', {
        get: () => ({ ...counters, inFlight, pending: timers.size }),
        enumerable: false,
        configurable: true,
      });

      log.debug('attached', { holdMin, holdMax, useRecording, maxConcurrent });
    },
  };
}

export default sendPresence;
