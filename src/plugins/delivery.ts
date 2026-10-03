import { DeliveryTracker, type DeliveryStats, type DeliveryTrackerOptions } from '../core/delivery.js';
import { patch } from '../core/intercept.js';

import type { WAMessageUpdate } from '@whiskeysockets/baileys';
import type { Plugin } from '../utils/types.js';

/**
 * Delivery tracking.
 *
 * A soft throttle shows up first as sends that reach nobody, not as an error.
 * This records every outbound message id and marks it delivered when WhatsApp's
 * `messages.update` reports status 3 (delivered) or 4 (read), so a delivery rate
 * is available for a health layer or an operator to act on.
 *
 * `sendMessage` is wrapped to capture the returned id; the wrap composes with
 * the anti-spam queue because `patch()` chains rather than replaces. Ported from
 * the reference forks.
 */
const DELIVERY_ACK = 3;
const READ = 4;

export function delivery(options: DeliveryTrackerOptions = {}): Plugin {
  return {
    name: 'delivery',
    order: 85,

    apply(ctx) {
      const log = ctx.log.child('delivery');
      const tracker = new DeliveryTracker({
        ...options,
        onLowRate: (rate, stats) => {
          log.warn('delivery rate below threshold', {
            rate: Number(rate.toFixed(2)),
            sent: stats.sent,
            delivered: stats.delivered,
          });
          options.onLowRate?.(rate, stats);
        },
      });

      // Capture the id of everything we send. Awaiting the original keeps the
      // id accurate and preserves rejection semantics for the caller.
      const handle = patch(ctx.sock as never, 'sendMessage', (async (
        original: (...args: unknown[]) => unknown,
        self: unknown,
        args: unknown[],
      ): Promise<unknown> => {
        const result = await Reflect.apply(original, self, args);
        const id = (result as { key?: { id?: string | null } | null } | undefined)?.key?.id;
        if (id) tracker.sent(id);
        return result;
      }) as never);

      if (handle.applied) ctx.onDispose(() => handle.undo());
      else log.warn('sendMessage missing; delivery tracking not attached');

      ctx.sock.ev.on('messages.update', (updates: WAMessageUpdate[]) => {
        for (const entry of updates ?? []) {
          const id = entry?.key?.id;
          const status = entry?.update?.status;
          if (id && (status === DELIVERY_ACK || status === READ)) tracker.delivered(id);
        }
      });

      Object.defineProperty(ctx.sock, 'delivery', {
        value: {
          stats: (): DeliveryStats => tracker.stats(),
          reset: () => tracker.reset(),
          tracked: () => tracker.tracked,
          // Manual hooks for callers that send outside `sendMessage`.
          sent: (id: string) => tracker.sent(id),
          delivered: (id: string) => tracker.delivered(id),
        },
        enumerable: false,
        configurable: true,
      });

      log.debug('attached', { ...options });
    },
  };
}

export type { DeliveryStats, DeliveryTrackerOptions };
export default delivery;
