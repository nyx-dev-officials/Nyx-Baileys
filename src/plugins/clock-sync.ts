import { ClockSync, type ClockSample, type ClockSyncOptions } from '../core/clock.js';

import type { WAMessage } from '@whiskeysockets/baileys';
import type { Plugin } from '../utils/types.js';

/**
 * Clock sync.
 *
 * Records a running estimate of the offset between this process's clock and the
 * server's, from the server timestamps WhatsApp stamps onto inbound messages.
 *
 * A one-way sample cannot separate clock skew from network delay, so the
 * estimate is biased by up to one delivery delay — but it is measured against
 * the *median* of the window, so a stalled socket or an NTP step cannot drag it
 * the way it would drag a mean. The result is exposed as `sock.clock`, which a
 * caller can use to order or stamp messages the server will agree with.
 *
 * Ported from the rolling-median clock sync in the reference forks.
 */
export function clockSync(options: ClockSyncOptions = {}): Plugin {
  return {
    name: 'clock-sync',
    order: 15,

    apply(ctx) {
      const log = ctx.log.child('clock');
      const clock = new ClockSync(options);

      ctx.sock.ev.on('messages.upsert', (event: { messages: WAMessage[] }) => {
        const receivedAt = Date.now();
        for (const msg of event.messages ?? []) {
          const seconds = Number(msg.messageTimestamp);
          if (!Number.isFinite(seconds) || seconds <= 0) continue;
          const sample: ClockSample = {
            localSentAt: receivedAt,
            localReceivedAt: receivedAt,
            serverTimestamp: seconds * 1000,
          };
          clock.record(sample);
        }
      });

      Object.defineProperty(ctx.sock, 'clock', {
        value: {
          skewMs: () => clock.skewMs(),
          toServerTime: (localMs: number) => clock.toServerTime(localMs),
          toLocalTime: (serverMs: number) => clock.toLocalTime(serverMs),
          stats: () => clock.stats(),
          reset: () => clock.reset(),
          sampleCount: () => clock.sampleCount,
        },
        enumerable: false,
        configurable: true,
      });

      log.debug('attached', { ...options });
    },
  };
}

export type { ClockSample, ClockSyncOptions };
export default clockSync;
