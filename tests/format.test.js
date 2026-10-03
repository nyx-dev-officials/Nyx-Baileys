/**
 * Display formatting.
 *
 * Deterministic, locale-free output for sizes, durations and numbers — the
 * helpers a menu footer ends up using. Assertions are on exact strings.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatBytes,
  formatCompact,
  formatDuration,
  formatElapsed,
  formatNumber,
  formatPercent,
  ordinal,
  padEnd,
  padStart,
} from '../dist/utils/format.js';

/* ── bytes ───────────────────────────────────────────────────────────── */

test('formatBytes renders each unit', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1024 * 1024), '1.0 MB');
  assert.equal(formatBytes(1024 ** 4), '1.0 TB');
});

test('formatBytes honours decimals and rejects nonsense', () => {
  assert.equal(formatBytes(1536, 0), '2 KB');
  assert.equal(formatBytes(-5), '0 B');
  assert.equal(formatBytes(NaN), '0 B');
});

/* ── duration ────────────────────────────────────────────────────────── */

test('formatDuration drops leading zero units', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(1000), '1s');
  assert.equal(formatDuration(59_000), '59s');
  assert.equal(formatDuration(60_000), '1m 00s');
  assert.equal(formatDuration(3_600_000), '1h 00m 00s');
  assert.equal(formatDuration(90_000), '1m 30s');
  assert.equal(formatDuration(86_400_000), '1d 00h 00m 00s');
});

test('formatDuration pads every unit after the first', () => {
  assert.equal(formatDuration(3_661_000), '1h 01m 01s');
  assert.equal(formatDuration(90_061_000), '1d 01h 01m 01s');
});

test('formatDuration rejects negative and non-finite', () => {
  assert.equal(formatDuration(-1), '0s');
  assert.equal(formatDuration(Infinity), '0s');
});

test('formatElapsed picks a compact form', () => {
  assert.equal(formatElapsed(340), '340ms');
  assert.equal(formatElapsed(1200), '1.2s');
  assert.equal(formatElapsed(12_000), '12s');
  assert.equal(formatElapsed(90_000), '1m 30s');
  assert.equal(formatElapsed(-5), '0ms');
});

/* ── numbers ─────────────────────────────────────────────────────────── */

test('formatNumber inserts thousands separators', () => {
  assert.equal(formatNumber(0), '0');
  assert.equal(formatNumber(999), '999');
  assert.equal(formatNumber(1000), '1,000');
  assert.equal(formatNumber(1_234_567), '1,234,567');
  assert.equal(formatNumber(-1234), '-1,234');
  assert.equal(formatNumber(1234.5), '1,234.5');
});

test('formatNumber passes non-finite values through', () => {
  assert.equal(formatNumber(Infinity), 'Infinity');
  assert.equal(formatNumber(NaN), 'NaN');
});

test('formatPercent scales by default and can take a pre-scaled value', () => {
  assert.equal(formatPercent(0.5), '50.0%');
  assert.equal(formatPercent(0.1234), '12.3%');
  assert.equal(formatPercent(12.34, 1, true), '12.3%');
  assert.equal(formatPercent(1, 0), '100%');
});

test('ordinal adds the right suffix including the teens exception', () => {
  assert.equal(ordinal(1), '1st');
  assert.equal(ordinal(2), '2nd');
  assert.equal(ordinal(3), '3rd');
  assert.equal(ordinal(4), '4th');
  assert.equal(ordinal(11), '11th');
  assert.equal(ordinal(12), '12th');
  assert.equal(ordinal(13), '13th');
  assert.equal(ordinal(21), '21st');
  assert.equal(ordinal(112), '112th');
  assert.equal(ordinal(-3), '-3rd');
});

test('formatCompact abbreviates large counts', () => {
  assert.equal(formatCompact(999), '999');
  assert.equal(formatCompact(1000), '1k');
  assert.equal(formatCompact(1200), '1.2k');
  assert.equal(formatCompact(3_400_000), '3.4M');
  assert.equal(formatCompact(2_000_000_000), '2B');
  assert.equal(formatCompact(-1500), '-1.5k');
});

/* ── padding ─────────────────────────────────────────────────────────── */

test('padStart and padEnd pad to a minimum width', () => {
  assert.equal(padStart('7', 3, '0'), '007');
  assert.equal(padStart('abcd', 2), 'abcd');
  assert.equal(padEnd('ab', 4, '.'), 'ab..');
  assert.equal(padStart(42, 4, '0'), '0042');
});
