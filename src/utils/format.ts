/**
 * Display formatting.
 *
 * Human-readable sizes, durations and numbers — the `formatBytes`,
 * `formatDuration` helpers every bot menu ends up needing. Pure and locale-free
 * so output is deterministic and testable.
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/** `1536` → `1.5 KB`. Binary units, one decimal above bytes. */
export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(decimals)} ${UNITS[unit]}`;
}

const pad = (n: number): string => String(Math.floor(n)).padStart(2, '0');

/**
 * Milliseconds → `1h 02m 03s`.
 *
 * Leading zero units are dropped, the first shown unit is unpadded and every
 * later one is padded to two digits, so the tail always aligns:
 * `59s`, `1m 30s`, `1h 00m 00s`, `1d 02h 03m 04s`.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours || parts.length) parts.push(`${parts.length ? pad(hours) : hours}h`);
  if (minutes || parts.length) parts.push(`${parts.length ? pad(minutes) : minutes}m`);
  // Seconds are always shown: they are either the only unit (`45s`) or the
  // zero-padded tail of a longer form (`1m 00s`).
  parts.push(`${parts.length ? pad(seconds) : seconds}s`);
  return parts.join(' ');
}

/** Compact duration for a timer: `1.2s`, `340ms`. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return formatDuration(ms);
}

/** Thousands separators: `1234567` → `1,234,567`. */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const [int, frac] = n.toString().split('.');
  const sign = int!.startsWith('-') ? '-' : '';
  const digits = sign ? int!.slice(1) : int!;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${grouped}${frac ? `.${frac}` : ''}`;
}

/** `0.1234` → `12.3%`. Set `alreadyPercent` when the value is 12.34. */
export function formatPercent(value: number, decimals = 1, alreadyPercent = false): string {
  const percent = alreadyPercent ? value : value * 100;
  return `${percent.toFixed(decimals)}%`;
}

/** `1` → `1st`, `22` → `22nd`. */
export function ordinal(n: number): string {
  const abs = Math.abs(Math.trunc(n));
  const mod100 = abs % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (abs % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/** Compact large counts: `1200` → `1.2k`, `3400000` → `3.4M`. */
export function formatCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1000) return String(n);
  const tiers: Array<[number, string]> = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'k']];
  for (const [size, suffix] of tiers) {
    if (abs >= size) {
      const value = n / size;
      return `${value.toFixed(Math.abs(value) < 10 ? 1 : 0).replace(/\.0$/, '')}${suffix}`;
    }
  }
  return String(n);
}

/** Left-pad to a minimum width. */
export const padStart = (value: string | number, width: number, char = ' '): string =>
  String(value).padStart(width, char);

/** Right-pad to a minimum width. */
export const padEnd = (value: string | number, width: number, char = ' '): string =>
  String(value).padEnd(width, char);
