/**
 * Time helpers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatRelative,
  formatSpan,
  fromUnixSeconds,
  isValidDuration,
  looksLikeMs,
  parseDuration,
  startOfDay,
  toEpochMs,
} from '../dist/utils/time.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/* ── parseDuration ───────────────────────────────────────────────────── */

test('a bare number is read as seconds', () => {
  assert.equal(parseDuration('90'), 90 * SECOND);
  assert.equal(parseDuration('1.5'), 1500);
  assert.equal(parseDuration('0'), 0);
});

test('unit suffixes parse', () => {
  assert.equal(parseDuration('500ms'), 500);
  assert.equal(parseDuration('30s'), 30 * SECOND);
  assert.equal(parseDuration('5m'), 5 * MINUTE);
  assert.equal(parseDuration('2h'), 2 * HOUR);
  assert.equal(parseDuration('3d'), 3 * DAY);
  assert.equal(parseDuration('1w'), 7 * DAY);
});

test('compound and spaced forms sum', () => {
  assert.equal(parseDuration('1h30m'), 90 * MINUTE);
  assert.equal(parseDuration('2 days 5 min'), 2 * DAY + 5 * MINUTE);
  assert.equal(parseDuration('1 hour, 15 minutes'), 75 * MINUTE);
});

test('full unit names work', () => {
  assert.equal(parseDuration('2 hours'), 2 * HOUR);
  assert.equal(parseDuration('3 seconds'), 3 * SECOND);
});

test('unparseable input yields null', () => {
  assert.equal(parseDuration(''), null);
  assert.equal(parseDuration('   '), null);
  assert.equal(parseDuration('soon'), null);
  assert.equal(parseDuration('5 lightyears'), null, 'unknown unit with a number is not a duration');
  assert.equal(parseDuration(null), null);
});

test('isValidDuration mirrors parseDuration', () => {
  assert.equal(isValidDuration('5m'), true);
  assert.equal(isValidDuration('nonsense'), false);
});

/* ── formatRelative ──────────────────────────────────────────────────── */

test('formatRelative calls the recent past just now', () => {
  const now = 1_700_000_000_000;
  assert.equal(formatRelative(now, now), 'just now');
  assert.equal(formatRelative(now - 30 * SECOND, now), 'just now');
  assert.equal(formatRelative(now + 30 * SECOND, now), 'just now');
});

test('formatRelative picks a unit and a direction', () => {
  const now = 1_700_000_000_000;
  assert.equal(formatRelative(now - 3 * MINUTE, now), '3 minutes ago');
  assert.equal(formatRelative(now + 2 * HOUR, now), 'in 2 hours');
  assert.equal(formatRelative(now - DAY, now), '1 day ago');
  assert.equal(formatRelative(now - 10 * DAY, now), '1 week ago');
  assert.equal(formatRelative(now - 90 * DAY, now), '3 months ago');
  assert.equal(formatRelative(now - 800 * DAY, now), '2 years ago');
});

test('formatRelative singularises exactly one', () => {
  const now = 1_700_000_000_000;
  assert.equal(formatRelative(now - 60 * SECOND, now), '1 minute ago');
  assert.equal(formatRelative(now - HOUR, now), '1 hour ago');
});

/* ── formatSpan ──────────────────────────────────────────────────────── */

test('formatSpan renders the shortest honest unit', () => {
  assert.equal(formatSpan(0), '0s');
  assert.equal(formatSpan(45 * SECOND), '45s');
  assert.equal(formatSpan(3 * MINUTE), '3m');
  assert.equal(formatSpan(5 * HOUR), '5h');
  assert.equal(formatSpan(4 * DAY), '4d');
  assert.equal(formatSpan(-1), '0s');
});

/* ── epoch helpers ───────────────────────────────────────────────────── */

test('looksLikeMs distinguishes seconds from milliseconds', () => {
  assert.equal(looksLikeMs(1_700_000_000), false, 'a seconds timestamp');
  assert.equal(looksLikeMs(1_700_000_000_000), true, 'a millisecond timestamp');
});

test('toEpochMs normalises both input scales', () => {
  assert.equal(toEpochMs(1_700_000_000), 1_700_000_000_000);
  assert.equal(toEpochMs(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(fromUnixSeconds(1_700_000_000), 1_700_000_000_000);
});

test('startOfDay returns UTC midnight', () => {
  const ts = Date.UTC(2026, 9, 3, 15, 30);
  const start = startOfDay(ts);
  assert.equal(start, Date.UTC(2026, 9, 3));
  assert.ok(start <= ts);
  assert.equal(start % DAY, 0);
});
