/**
 * Time helpers.
 *
 * Two things every command ends up needing: parse a human duration (`5m`,
 * `1h30m`, `2 days`) into milliseconds, and render a past timestamp as `3
 * minutes ago`, for an uptime line or a "last seen". Both pure and
 * timezone-naive — they work on epoch milliseconds only, so they are the same
 * in every process and trivially testable.
 */

const UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
  mo: 2_592_000_000,
  month: 2_592_000_000,
  months: 2_592_000_000,
  y: 31_536_000_000,
  year: 31_536_000_000,
  years: 31_536_000_000,
};

/**
 * Parse `"1h30m"` / `"2 days 5 min"` / `"500ms"` into milliseconds.
 *
 * A bare number is read as **seconds** (`parseDuration('90')` → 90 s), which is
 * what a command prefix like `mute 60` means. Returns `null` when nothing
 * parseable is found, and floored at 0.
 */
export function parseDuration(input: string): number | null {
  const text = String(input ?? '').trim().toLowerCase();
  if (!text) return null;

  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1_000);

  const re = /(\d+(?:\.\d+)?)\s*([a-z]+)/g;
  let total = 0;
  let matched = false;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const unit = UNIT_MS[match[2]!];
    if (unit === undefined) continue;
    total += Number(match[1]) * unit;
    matched = true;
  }
  if (!matched) return null;
  return Math.max(0, Math.round(total));
}

/** True when `input` parses as a duration. */
export function isValidDuration(input: string): boolean {
  return parseDuration(input) !== null;
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * `"3 minutes ago"`, `"in 2 hours"`, `"just now"`.
 *
 * `now` defaults to `Date.now()`; pass it in a test to keep the output fixed.
 */
export function formatRelative(timestamp: number, now = Date.now()): string {
  const delta = timestamp - now;
  const abs = Math.abs(delta);
  if (abs < 45 * SECOND) return 'just now';

  const [value, unit] = pickUnit(abs);
  const rounded = Math.max(1, Math.round(value));
  const label = `${rounded} ${unit}${rounded === 1 ? '' : 's'}`;
  return delta < 0 ? `${label} ago` : `in ${label}`;
}

function pickUnit(abs: number): [number, string] {
  const WEEK = 7 * DAY;
  const MONTH = 30 * DAY;
  const YEAR = 365 * DAY;
  if (abs < 45 * MINUTE) return [abs / MINUTE, 'minute'];
  if (abs < 22 * HOUR) return [abs / HOUR, 'hour'];
  if (abs < 7 * DAY) return [abs / DAY, 'day'];
  if (abs < 30 * DAY) return [abs / WEEK, 'week'];
  if (abs < YEAR) return [abs / MONTH, 'month'];
  return [abs / YEAR, 'year'];
}

/** `"3m"`, `"2h"`, `"4d"` — the shortest honest rendering of a span. */
export function formatSpan(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  if (ms < MINUTE) return `${Math.round(ms / SECOND)}s`;
  if (ms < HOUR) return `${Math.round(ms / MINUTE)}m`;
  if (ms < DAY) return `${Math.round(ms / HOUR)}h`;
  return `${Math.round(ms / DAY)}d`;
}

/** Epoch-ms for a Unix-seconds value, or `undefined` when it is already ms. */
export function fromUnixSeconds(seconds: number): number {
  return seconds * 1_000;
}

/** `true` when the timestamp is a plausible millisecond epoch (not seconds). */
export function looksLikeMs(value: number): boolean {
  return value > 1e12;
}

/** Normalise either a seconds or a milliseconds timestamp to milliseconds. */
export function toEpochMs(value: number): number {
  return looksLikeMs(value) ? Math.round(value) : Math.round(value * 1_000);
}

/** Midnight UTC of the day containing `timestamp`. */
export function startOfDay(timestamp: number): number {
  const d = new Date(timestamp);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
