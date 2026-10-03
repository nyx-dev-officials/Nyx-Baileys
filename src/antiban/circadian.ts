/**
 * Presence choreography and circadian rhythm.
 *
 * ⚠️ EVASION MODULE — OFF BY DEFAULT. See `docs/ANTIBAN.md`.
 *
 * Robotic timing is a detection signal: an account that reads in 0 ms, types at
 * a constant rate, and is equally active at 04:00 and 14:00 does not look human.
 * This models the temporal variation a person actually has — a circadian activity
 * curve, distraction and offline gaps, a words-per-minute typing model with think
 * pauses, and jittered read receipts.
 *
 * Nothing here is enabled unless you turn it on. Ported and adapted from the
 * reference forks' `presenceChoreographer` / `readReceiptVariance`.
 */

export type CircadianProfile = 'default' | 'nightOwl' | 'earlyBird' | 'always_on';
export type ActivityCurve = 'office' | 'social' | 'global';

export interface CircadianOptions {
  /** Master switch. Default `false`. */
  enabled?: boolean;
  /** IANA timezone used for local-hour math. Default `UTC`. */
  timezone?: string;
  /** Shape of the daily activity curve. Default `office`. */
  activityCurve?: ActivityCurve;
  /** Circadian timing profile. Default `default`. */
  profile?: CircadianProfile;
  /** Apply the circadian multiplier to delays. Default `true` when enabled. */
  circadian?: boolean;
}

export interface ChoreographerOptions extends CircadianOptions {
  /** Chance per send of a distraction pause. Default 0.05. */
  distractionPauseProbability?: number;
  distractionPauseMinMs?: number;
  distractionPauseMaxMs?: number;
  /** Chance per send of going offline for a while. Default 0.03. */
  offlineGapProbability?: number;
  offlineGapMinMs?: number;
  offlineGapMaxMs?: number;
  /** Read-receipt delay window. Default 3s–45s. */
  readReceiptDelayMinMs?: number;
  readReceiptDelayMaxMs?: number;
  /** Chance of skipping a read receipt entirely. Default 0.15. */
  readReceiptSkipProbability?: number;
  /** Model typing duration from message length. Default `true`. */
  enableTypingModel?: boolean;
  /** Mean typing speed, words per minute. Default 45. */
  typingWPM?: number;
  /** Std-dev around the mean. Default 15. */
  typingWPMStdDev?: number;
  /** Chance of a think pause per 10-char chunk. Default 0.08. */
  thinkPauseProbability?: number;
  thinkPauseMinMs?: number;
  thinkPauseMaxMs?: number;
  /** Chance of a brief pause just before send. Default 0.4. */
  intermittentPausedProbability?: number;
  /** Hard cap on one typing plan. Default 90s. */
  typingMaxMs?: number;
  /** Floor on one typing plan. Default 0.6s. */
  typingMinMs?: number;
}

export interface TypingPlanStep {
  state: 'composing' | 'paused';
  durationMs: number;
}

/** 24 activity multipliers per curve; higher means more active (shorter delays). */
export const ACTIVITY_CURVES: Record<ActivityCurve, readonly number[]> = {
  office: [
    0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1,
    0.5, 0.5, 0.95, 0.95,
    0.6,
    0.9, 0.9, 0.9, 0.9,
    0.6, 0.6,
    0.4, 0.4,
    0.2, 0.2, 0.2,
  ],
  social: [
    0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1,
    0.3, 0.4,
    0.7, 0.8,
    0.5,
    0.7, 0.7,
    0.4,
    0.8, 0.9, 0.9,
    0.6,
    0.8, 0.85, 0.9, 0.95,
  ],
  global: [
    0.5, 0.5, 0.5, 0.5, 0.5, 0.5,
    0.4, 0.4,
    0.6, 0.7, 0.8, 0.8,
    0.6,
    0.8, 0.8, 0.8, 0.8,
    0.7, 0.7,
    0.6, 0.5, 0.5, 0.5, 0.5,
  ],
};

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));
const randomBetween = (min: number, max: number): number => Math.floor(Math.random() * (max - min + 1)) + min;

/** Box–Muller sample from N(mean, stdDev). */
const gaussian = (mean: number, stdDev: number): number => {
  const u1 = Math.max(Number.EPSILON, Math.random());
  const u2 = Math.random();
  return mean + Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * stdDev;
};

/** Local hour (0–23) for a date in an IANA timezone, falling back to UTC. */
export function localHour(date: Date = new Date(), timezone = 'UTC'): number {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hour12: false });
    const part = formatter.formatToParts(date).find((p) => p.type === 'hour');
    const hour = part ? Number.parseInt(part.value, 10) : NaN;
    // Intl renders midnight as "24" in some engines; normalise.
    if (Number.isFinite(hour)) return hour % 24;
  } catch {
    /* unknown timezone */
  }
  return date.getUTCHours();
}

/**
 * Delay multiplier for the hour of day. Floors at 0.8 during the day and peaks
 * around 6.0 in the small hours, with smooth cosine transitions rather than
 * steps (a step is itself a fingerprint).
 */
export function getCircadianMultiplier(
  date: Date = new Date(),
  profile: CircadianProfile = 'default',
  timezone = 'UTC',
): number {
  if (profile === 'always_on') return 1;

  const hour = localHour(date, timezone);
  const shifted = profile === 'nightOwl' ? (hour - 3 + 24) % 24 : profile === 'earlyBird' ? (hour + 2) % 24 : hour;

  if (shifted >= 9 && shifted < 22) {
    const t = (shifted - 9) / 13;
    return 1 + 0.2 * Math.cos(2 * Math.PI * t);
  }
  if (shifted >= 22) {
    return 1.2 + 1.3 * ((shifted - 22) / 2);
  }
  if (shifted < 2) {
    return 2.5 + 1.5 * (shifted / 2);
  }
  if (shifted < 6) {
    return 5 + Math.cos(Math.PI * ((shifted - 2) / 4));
  }
  return 4 - 3 * ((shifted - 6) / 3);
}

/**
 * The choreographer. Pure timing math: it decides *when*, the caller decides
 * *what*. Feed a plan to `executeTypingPlan` against a real socket, or read the
 * decisions directly.
 */
export class PresenceChoreographer {
  readonly #enabled: boolean;
  readonly #cfg: Required<Omit<ChoreographerOptions, 'profile' | 'circadian'>> & {
    profile: CircadianProfile;
    circadianOn: boolean;
  };

  #distractionPauses = 0;
  #offlineGaps = 0;
  #readReceiptsDelayed = 0;
  #readReceiptsSkipped = 0;
  #typingPlansComputed = 0;
  #typingPlansExecuted = 0;
  #totalTypingTimeMs = 0;

  constructor(options: ChoreographerOptions = {}) {
    this.#enabled = options.enabled ?? false;
    this.#cfg = {
      enabled: this.#enabled,
      timezone: options.timezone ?? 'UTC',
      activityCurve: options.activityCurve ?? 'office',
      profile: options.profile ?? 'default',
      circadianOn: options.circadian ?? true,
      distractionPauseProbability: options.distractionPauseProbability ?? 0.05,
      distractionPauseMinMs: options.distractionPauseMinMs ?? 300_000,
      distractionPauseMaxMs: options.distractionPauseMaxMs ?? 1_200_000,
      offlineGapProbability: options.offlineGapProbability ?? 0.03,
      offlineGapMinMs: options.offlineGapMinMs ?? 300_000,
      offlineGapMaxMs: options.offlineGapMaxMs ?? 900_000,
      readReceiptDelayMinMs: options.readReceiptDelayMinMs ?? 3_000,
      readReceiptDelayMaxMs: options.readReceiptDelayMaxMs ?? 45_000,
      readReceiptSkipProbability: options.readReceiptSkipProbability ?? 0.15,
      enableTypingModel: options.enableTypingModel ?? true,
      typingWPM: options.typingWPM ?? 45,
      typingWPMStdDev: options.typingWPMStdDev ?? 15,
      thinkPauseProbability: options.thinkPauseProbability ?? 0.08,
      thinkPauseMinMs: options.thinkPauseMinMs ?? 800,
      thinkPauseMaxMs: options.thinkPauseMaxMs ?? 3_500,
      intermittentPausedProbability: options.intermittentPausedProbability ?? 0.4,
      typingMaxMs: options.typingMaxMs ?? 90_000,
      typingMinMs: options.typingMinMs ?? 600,
    };
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /** 0.1–1.0 activity factor for the current hour. 1 when disabled. */
  activityFactor(date: Date = new Date()): number {
    if (!this.#enabled) return 1;
    const curve = ACTIVITY_CURVES[this.#cfg.activityCurve];
    return curve[localHour(date, this.#cfg.timezone)] ?? 0.5;
  }

  #circadian(): number {
    return this.#cfg.circadianOn
      ? getCircadianMultiplier(new Date(), this.#cfg.profile, this.#cfg.timezone)
      : 1;
  }

  shouldPauseForDistraction(): { pause: boolean; durationMs: number } {
    if (!this.#enabled || Math.random() >= this.#cfg.distractionPauseProbability) {
      return { pause: false, durationMs: 0 };
    }
    this.#distractionPauses += 1;
    return {
      pause: true,
      durationMs: randomBetween(this.#cfg.distractionPauseMinMs, this.#cfg.distractionPauseMaxMs),
    };
  }

  shouldTakeOfflineGap(): { offline: boolean; durationMs: number } {
    if (!this.#enabled || Math.random() >= this.#cfg.offlineGapProbability) {
      return { offline: false, durationMs: 0 };
    }
    this.#offlineGaps += 1;
    return {
      offline: true,
      durationMs: randomBetween(this.#cfg.offlineGapMinMs, this.#cfg.offlineGapMaxMs),
    };
  }

  /** `{ mark: false }` means skip the receipt; otherwise a jittered delay. */
  shouldMarkRead(): { mark: boolean; delayMs: number } {
    if (!this.#enabled) return { mark: true, delayMs: 0 };
    if (Math.random() < this.#cfg.readReceiptSkipProbability) {
      this.#readReceiptsSkipped += 1;
      return { mark: false, delayMs: 0 };
    }
    const base = randomBetween(this.#cfg.readReceiptDelayMinMs, this.#cfg.readReceiptDelayMaxMs);
    this.#readReceiptsDelayed += 1;
    return { mark: true, delayMs: Math.floor(base * this.#circadian()) };
  }

  /**
   * A typing plan for a message of `length` characters: alternating composing /
   * paused steps whose total duration follows a Gaussian WPM model with think
   * pauses, scaled by the circadian multiplier.
   */
  computeTypingPlan(length: number): TypingPlanStep[] {
    if (!this.#enabled || !this.#cfg.enableTypingModel || length <= 0) {
      return [{ state: 'composing', durationMs: this.#cfg.typingMinMs }];
    }
    this.#typingPlansComputed += 1;

    const wpm = clamp(gaussian(this.#cfg.typingWPM, this.#cfg.typingWPMStdDev), 10, 120);
    const charsPerMs = (wpm * 5) / 60_000;
    const circadian = this.#circadian();
    const target = clamp(length / charsPerMs, this.#cfg.typingMinMs, this.#cfg.typingMaxMs);

    const chunks = Math.max(1, Math.ceil(length / 10));
    const plan: TypingPlanStep[] = [];
    let remaining = target;

    for (let i = 0; i < chunks && remaining > 0; i += 1) {
      const budget = Math.floor(Math.min(remaining / (chunks - i), remaining));
      if (budget <= 0) break;

      if (i > 0 && i < chunks - 1 && Math.random() < this.#cfg.thinkPauseProbability) {
        plan.push({ state: 'composing', durationMs: budget });
        remaining -= budget;
        plan.push({
          state: 'paused',
          durationMs: Math.floor(randomBetween(this.#cfg.thinkPauseMinMs, this.#cfg.thinkPauseMaxMs) * circadian),
        });
      } else {
        const last = plan[plan.length - 1];
        if (last && last.state === 'composing') last.durationMs += budget;
        else plan.push({ state: 'composing', durationMs: budget });
        remaining -= budget;
      }
    }

    if (Math.random() < this.#cfg.intermittentPausedProbability) {
      plan.push({ state: 'paused', durationMs: Math.floor(randomBetween(200, 800) * circadian) });
    }

    if (!plan.some((s) => s.state === 'composing')) {
      return [{ state: 'composing', durationMs: this.#cfg.typingMinMs }];
    }

    // The cap is on the *whole* plan, think pauses included — otherwise a long
    // message with several pauses runs well past `typingMaxMs`. Scale uniformly
    // rather than dropping steps, so the shape survives the cap.
    const total = plan.reduce((sum, step) => sum + step.durationMs, 0);
    if (total > this.#cfg.typingMaxMs && total > 0) {
      const scale = this.#cfg.typingMaxMs / total;
      for (const step of plan) step.durationMs = Math.max(1, Math.floor(step.durationMs * scale));
    }

    return plan;
  }

  /**
   * Run a plan against a socket, emitting each presence state for its duration.
   * Returns early with `paused` restored if the signal aborts.
   */
  async executeTypingPlan(
    sock: { sendPresenceUpdate: (state: string, jid: string) => unknown },
    jid: string,
    plan: TypingPlanStep[],
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    this.#typingPlansExecuted += 1;
    try {
      for (const step of plan) {
        if (options.signal?.aborted) throw new Error('typing plan aborted');
        await Promise.resolve(sock.sendPresenceUpdate(step.state, jid));
        await new Promise((r) => setTimeout(r, step.durationMs));
        this.#totalTypingTimeMs += step.durationMs;
      }
    } finally {
      try {
        await Promise.resolve(sock.sendPresenceUpdate('paused', jid));
      } catch {
        /* socket may be gone mid-plan */
      }
    }
  }

  stats(): Record<string, number> {
    return {
      activityFactor: this.activityFactor(),
      distractionPauses: this.#distractionPauses,
      offlineGaps: this.#offlineGaps,
      readReceiptsDelayed: this.#readReceiptsDelayed,
      readReceiptsSkipped: this.#readReceiptsSkipped,
      typingPlansComputed: this.#typingPlansComputed,
      typingPlansExecuted: this.#typingPlansExecuted,
      totalTypingTimeMs: this.#totalTypingTimeMs,
      currentHourLocal: localHour(new Date(), this.#cfg.timezone),
    };
  }

  reset(): void {
    this.#distractionPauses = 0;
    this.#offlineGaps = 0;
    this.#readReceiptsDelayed = 0;
    this.#readReceiptsSkipped = 0;
    this.#typingPlansComputed = 0;
    this.#typingPlansExecuted = 0;
    this.#totalTypingTimeMs = 0;
  }
}
