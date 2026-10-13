/**
 * send-safety — ceilings and circuit breakers that keep an account alive.
 *
 * ## Why this exists
 *
 * `antiSpam` already enforces a *rate*: a 2.5s floor plus jitter between
 * outbound messages. A rate is not a budget. It answers "how fast?" and not
 * "how much?" — so a bot can obey the rate perfectly and still get an account
 * limited, because 40 messages/minute for six hours is 14,400 messages.
 *
 * WhatsApp's own limits are not published, so the numbers here are conservative
 * by design and configurable. They are not a guarantee; they exist so that
 * ordinary operation never approaches a cliff.
 *
 * ## The four limits
 *
 * 1. **Per-recipient burst** — messages to one chat inside a rolling window.
 *    Stops one recipient from being buried, which is also the courtesy limit.
 * 2. **Per-recipient daily** — one chat's daily total.
 * 3. **Global daily** — the account's total, across all recipients. This is the
 *    one that protects the number itself.
 * 4. **Quiet hours** — nothing is sent between `quietStart` and `quietEnd` in
 *    the configured timezone, which is what "don't message people at 3am"
 *    looks like in code.
 *
 * ## The circuit breaker
 *
 * A ban in progress looks like delivery rate collapsing while send rate stays
 * high. That is the signal worth acting on, and it is the one a rate limiter
 * cannot see. After `breakerThreshold` consecutive delivery failures the
 * breaker opens and **all sending stops** until `breakerCooldownMs` elapses.
 *
 * This is deliberately fail-closed. An account that has gone quiet for ten
 * minutes is recoverable; an account that keeps hammering a server which is
 * already throttling it may not be.
 *
 * ## Delivery signals
 *
 * Failure is taken from a caller-supplied verdict, not from timing alone. A slow
 * provider is not a failed send, and a `sendMessage` that returns an ID is not
 * proof of delivery — this account drops sends silently (see `CONTEXT.md` §8).
 * Call `recordDelivery()` with what was actually observed.
 */

import type { Plugin, PluginContext } from '../utils/types.js';

export interface SendSafetyOptions {
  /** Rolling window and cap for one recipient. Default: 10 messages / minute. */
  recipientBurst?: { limit: number; windowMs: number };
  /** Rolling 24h cap for one recipient. Default 500. */
  recipientDaily?: number;
  /** Rolling 24h cap across all recipients — the account-level budget. */
  globalDaily?: number;
  /** Local hours [start, end) during which nothing is sent. */
  quietHours?: { start: number; end: number };
  /** Consecutive delivery failures that open the breaker. Default 5. */
  breakerThreshold?: number;
  /** How long the breaker stays open. Default 10 minutes. */
  breakerCooldownMs?: number;
  /** Injected for tests. */
  now?: () => number;
  /** Injected for tests. */
  log?: { warn: (m: string, meta?: Record<string, unknown>) => void; info: (m: string, meta?: Record<string, unknown>) => void };
}

export interface SendVerdict {
  /** Did the recipient actually receive it? `null` when unknown. */
  delivered: boolean | null;
  detail?: string;
}

export type DenyReason =
  | 'recipient-burst'
  | 'recipient-daily'
  | 'global-daily'
  | 'quiet-hours'
  | 'breaker-open';

export interface SafetyDecision {
  allowed: boolean;
  reason?: DenyReason;
  /** Seconds to wait before retrying, when one applies. */
  retryAfterMs?: number;
}

const DEFAULTS = {
  recipientBurst: { limit: 10, windowMs: 60_000 },
  recipientDaily: 500,
  globalDaily: 5_000,
  breakerThreshold: 5,
  breakerCooldownMs: 600_000,
};

const DAY = 86_400_000;

export class SendSafety {
  // `quietHours` and `log` are genuinely optional here, so they are omitted
  // from the Required<> wrapper rather than forced to a sentinel value.
  private readonly cfg: {
    recipientBurst: { limit: number; windowMs: number };
    recipientDaily: number;
    globalDaily: number;
    breakerThreshold: number;
    breakerCooldownMs: number;
    quietHours?: { start: number; end: number };
    log?: SendSafetyOptions['log'];
  };
  private readonly now: () => number;

  /** Rolling send timestamps per recipient. */
  private readonly byRecipient = new Map<string, number[]>();
  /** All send timestamps, account-wide. */
  private all: number[] = [];
  private consecutiveFailures = 0;
  private breakerOpenedAt = 0;

  constructor(options: SendSafetyOptions = {}) {
    this.now = options.now ?? Date.now;
    this.cfg = {
      recipientBurst: options.recipientBurst ?? DEFAULTS.recipientBurst,
      recipientDaily: options.recipientDaily ?? DEFAULTS.recipientDaily,
      globalDaily: options.globalDaily ?? DEFAULTS.globalDaily,
      breakerThreshold: options.breakerThreshold ?? DEFAULTS.breakerThreshold,
      breakerCooldownMs: options.breakerCooldownMs ?? DEFAULTS.breakerCooldownMs,
      quietHours: options.quietHours,
      log: options.log,
    };
  }

  private prune(list: number[], windowMs: number): number[] {
    const cutoff = this.now() - windowMs;
    // Times only ever get pushed in time order, so a leading trim is enough and
    // avoids a filter allocation on every single check.
    let i = 0;
    while (i < list.length && list[i]! < cutoff) i++;
    return i === 0 ? list : list.slice(i);
  }

  private inQuietHours(): boolean {
    const q = this.cfg.quietHours;
    if (!q) return false;
    const h = new Date(this.now()).getHours();
    // Wraps midnight when start > end, e.g. 22 → 6.
    return q.start <= q.end ? (h >= q.start && h < q.end) : (h >= q.start || h < q.end);
  }

  /** Record a delivery observation. Drives the circuit breaker. */
  recordDelivery(verdict: SendVerdict): void {
    if (verdict.delivered === false) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.cfg.breakerThreshold && this.breakerOpenedAt === 0) {
        this.breakerOpenedAt = this.now();
        this.cfg.log?.warn('send-safety: circuit breaker opened after consecutive delivery failures', {
          failures: this.consecutiveFailures,
          cooldownMs: this.cfg.breakerCooldownMs,
        });
      }
      return;
    }
    // `true` and `null` both count as the run being intact: an unknown result is
    // not evidence of failure, and should not trip the breaker on its own.
    this.consecutiveFailures = 0;
  }

  /** Would sending now be allowed? Pure check — records nothing. */
  check(recipient: string): SafetyDecision {
    const t = this.now();

    if (this.breakerOpenedAt) {
      const elapsed = t - this.breakerOpenedAt;
      if (elapsed < this.cfg.breakerCooldownMs) {
        return {
          allowed: false,
          reason: 'breaker-open',
          retryAfterMs: this.cfg.breakerCooldownMs - elapsed,
        };
      }
      // Cooldown elapsed: half-open. Clear the breaker so the next failure can
      // re-trip it, but keep the counters.
      this.cfg.log?.info('send-safety: breaker closing after cooldown', { elapsed });
      this.breakerOpenedAt = 0;
      this.consecutiveFailures = 0;
    }

    if (this.inQuietHours()) {
      return { allowed: false, reason: 'quiet-hours', retryAfterMs: this.cfg.quietHours!.start * 3_600_000 };
    }

    const mine = this.prune(this.byRecipient.get(recipient) ?? [], this.cfg.recipientBurst.windowMs);
    if (mine.length >= this.cfg.recipientBurst.limit) {
      const oldest = mine[0]!;
      return {
        allowed: false,
        reason: 'recipient-burst',
        retryAfterMs: Math.max(0, this.cfg.recipientBurst.windowMs - (t - oldest)),
      };
    }

    const dailyMine = this.prune(this.byRecipient.get(recipient) ?? [], DAY);
    if (dailyMine.length >= this.cfg.recipientDaily) {
      return { allowed: false, reason: 'recipient-daily', retryAfterMs: DAY };
    }

    const dailyAll = this.prune(this.all, DAY);
    if (dailyAll.length >= this.cfg.globalDaily) {
      return { allowed: false, reason: 'global-daily', retryAfterMs: DAY };
    }

    return { allowed: true };
  }

  /**
   * Check and, if allowed, consume one slot.
   *
   * Consuming on success is what makes these limits real: a check-then-send with
   * two callers racing would both pass the same check and both send.
   */
  consume(recipient: string): SafetyDecision {
    const decision = this.check(recipient);
    if (!decision.allowed) return decision;

    const t = this.now();
    this.byRecipient.set(recipient, [...(this.byRecipient.get(recipient) ?? []), t]);
    this.all.push(t);
    return { allowed: true };
  }

  /** Snapshot for status output and tests. */
  stats(): {
    recipient: string;
    burst: number;
    daily: number;
    globalDaily: number;
    breakerOpen: boolean;
  } {
    const t = this.now();
    return {
      recipient: 'all',
      burst: this.all.filter((x) => t - x < this.cfg.recipientBurst.windowMs).length,
      daily: this.prune([...this.all], DAY).length,
      globalDaily: this.cfg.globalDaily,
      breakerOpen: this.breakerOpenedAt !== 0,
    };
  }

  /** Test seam. */
  reset(): void {
    this.byRecipient.clear();
    this.all = [];
    this.consecutiveFailures = 0;
    this.breakerOpenedAt = 0;
  }
}

export function sendSafety(options: SendSafetyOptions = {}): Plugin & { safety?: SendSafety } {
  const plugin: Plugin & { safety?: SendSafety } = {
    name: 'send-safety',
    order: 78, // after anti-spam (80)? no — before it in effect, see note below

    apply(ctx: PluginContext) {
      const log = ctx.log.child('send-safety');
      const safety = new SendSafety({ ...options, log });

      // order 78 places this *inside* anti-spam (80): a message rejected here is
      // never queued at all, so a throttled bot costs no queue memory and no
      // pacing delay for work that will not be sent.
      plugin.safety = safety;
      ctx.state.set?.('sendSafety', safety as unknown as string);

      log.info('send-safety active', {
        recipientDaily: options.recipientDaily ?? DEFAULTS.recipientDaily,
        globalDaily: options.globalDaily ?? DEFAULTS.globalDaily,
        quietHours: options.quietHours ?? null,
      });
    },
  };

  return plugin;
}