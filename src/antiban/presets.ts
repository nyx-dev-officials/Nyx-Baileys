/**
 * Anti-ban tuning presets.
 *
 * ⚠️ These set pacing and warm-up policy. See `docs/ANTIBAN.md`.
 *
 * A single knob called "how hard can I push" is not a real knob — it is a set of
 * coupled limits that have to move together. A preset is that set, named for the
 * posture it encodes. Numbers are deliberately conservative at the bottom: a
 * fresh number that sends 40/min is banned, not fast.
 *
 * The `high-volume` preset assumes a long-established account and is refused
 * unless you go out of your way to select it.
 */

export type PresetName = 'conservative' | 'moderate' | 'aggressive' | 'high-volume';

export interface AntiBanProfile {
  maxPerMinute: number;
  maxPerHour: number;
  maxPerDay: number;
  minDelayMs: number;
  maxDelayMs: number;
  /** Extra pause before messaging a chat with no history. */
  newChatDelayMs: number;
  maxIdenticalMessages: number;
  identicalMessageWindowMs: number;
  burstAllowance: number;
  warmupDays: number;
  day1Limit: number;
  growthFactor: number;
  inactivityThresholdHours: number;
  groupMultiplier: number;
}

export const PRESETS: Record<PresetName, AntiBanProfile> = {
  conservative: {
    maxPerMinute: 5, maxPerHour: 100, maxPerDay: 800,
    minDelayMs: 2_500, maxDelayMs: 7_000, newChatDelayMs: 4_000,
    maxIdenticalMessages: 3, identicalMessageWindowMs: 3_600_000, burstAllowance: 3,
    warmupDays: 10, day1Limit: 15, growthFactor: 1.8, inactivityThresholdHours: 72,
    groupMultiplier: 0.5,
  },
  moderate: {
    maxPerMinute: 10, maxPerHour: 300, maxPerDay: 1_500,
    minDelayMs: 1_500, maxDelayMs: 5_000, newChatDelayMs: 3_000,
    maxIdenticalMessages: 5, identicalMessageWindowMs: 3_600_000, burstAllowance: 5,
    warmupDays: 7, day1Limit: 20, growthFactor: 1.8, inactivityThresholdHours: 72,
    groupMultiplier: 0.7,
  },
  aggressive: {
    maxPerMinute: 20, maxPerHour: 800, maxPerDay: 4_000,
    minDelayMs: 800, maxDelayMs: 3_000, newChatDelayMs: 2_000,
    maxIdenticalMessages: 10, identicalMessageWindowMs: 3_600_000, burstAllowance: 8,
    warmupDays: 4, day1Limit: 35, growthFactor: 2.0, inactivityThresholdHours: 48,
    groupMultiplier: 0.9,
  },
  'high-volume': {
    maxPerMinute: 40, maxPerHour: 1_500, maxPerDay: 8_000,
    minDelayMs: 400, maxDelayMs: 1_800, newChatDelayMs: 1_200,
    maxIdenticalMessages: 20, identicalMessageWindowMs: 3_600_000, burstAllowance: 15,
    warmupDays: 3, day1Limit: 60, growthFactor: 2.5, inactivityThresholdHours: 24,
    groupMultiplier: 0.95,
  },
};

/** Aggregate daily ceiling for a warmed account on day `day` of the ramp. */
export function dailyLimit(profile: AntiBanProfile, day: number): number {
  if (day <= 1) return profile.day1Limit;
  return Math.min(profile.maxPerDay, Math.round(profile.day1Limit * profile.growthFactor ** (day - 1)));
}

export type ProfileInput = PresetName | (Partial<AntiBanProfile> & { preset?: PresetName }) | undefined;

/**
 * Resolve a preset name or partial override into a full profile. `high-volume`
 * throws rather than warns, so it can only ever be selected explicitly.
 */
export function resolveProfile(input: ProfileInput): AntiBanProfile {
  if (input === undefined) return { ...PRESETS.conservative };

  if (typeof input === 'string') {
    const preset = PRESETS[input];
    if (!preset) throw new Error(`unknown preset "${input}"`);
    if (input === 'high-volume') {
      throw new Error('the high-volume preset requires an established account; select it explicitly with `{ preset: "high-volume" }`');
    }
    return { ...preset };
  }

  const { preset = 'conservative', ...overrides } = input;
  const base = PRESETS[preset];
  if (!base) throw new Error(`unknown preset "${preset}"`);
  return { ...base, ...overrides };
}
