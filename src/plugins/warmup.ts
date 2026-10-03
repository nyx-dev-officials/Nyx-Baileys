import type { Plugin } from '../utils/types.js';

/**
 * Warm-up ramp.
 *
 * A number that starts sending 2,000 messages on hour one behaves nothing like a
 * number that started last week. This scales the pacing gap by how long the
 * session has existed: heavy gaps on day one, easing to baseline by day N.
 *
 * State lives in the sidecar store, so the ramp survives restarts — resetting
 * it by bouncing the process would defeat the point.
 */

const DAY = 86_400_000;

/** Multiplier on the pacing gap, from `startedAt` to `startedAt + days`. */
export function rampFor(startedAt: number, days = 3, now = Date.now()): number {
  if (days <= 0) return 1;
  const age = now - startedAt;
  if (age >= days * DAY) return 1;
  const progress = Math.max(0, age / (days * DAY));
  // 8× at birth → 1× at the end, eased so it drops fast early.
  return 1 + 7 * Math.pow(1 - progress, 2);
}

export function warmup(days = 3): Plugin {
  return {
    name: 'warmup',
    order: 100,

    async apply(ctx) {
      if (days <= 0) return;
      const log = ctx.log.child('warmup');
      const startedAt = await ctx.state.get<number>('warmupStartedAt', 0);

      if (!startedAt) {
        await ctx.state.set('warmupStartedAt', Date.now());
        log.info('warm-up started', { days });
        return;
      }

      const ageDays = (Date.now() - startedAt) / DAY;
      log.debug('warm-up progress', { ageDays: ageDays.toFixed(2), days });

      // Feed the pacing layer. antiSpam exposes __antispam; the two plugins are
      // coupled through socket state rather than a hard import, which keeps the
      // plugin order flexible.
      const factor = rampFor(startedAt, days);
      const antispam = (ctx.sock as unknown as Record<string, { setPressure?: (n: number) => void }>)
        .__antispam;
      antispam?.setPressure?.(factor);
    },
  };
}

export default warmup;
