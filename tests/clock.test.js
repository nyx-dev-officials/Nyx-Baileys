/**
 * Clock sync — the rolling-median estimator and the plugin that feeds it.
 *
 * The property that matters is outlier resistance: a single skewed sample must
 * not move the estimate the way a mean would.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ClockSync } from '../dist/core/clock.js';
import { clockSync } from '../dist/plugins/clock-sync.js';

import { applyPlugin, fakeSocket, upsert, wmMessage } from './helpers.js';

/* ── ClockSync ───────────────────────────────────────────────────────── */

test('no skew is reported before the minimum sample count', () => {
  const clock = new ClockSync({ minSamples: 3 });
  clock.record({ localSentAt: 1000, localReceivedAt: 1100, serverTimestamp: 1050 });
  clock.record({ localSentAt: 2000, localReceivedAt: 2100, serverTimestamp: 2050 });

  assert.equal(clock.skewMs(), 0);
  assert.equal(clock.stats().confidence, 'low');
  assert.equal(clock.sampleCount, 2);
});

test('an exact round trip with a symmetric offset yields that offset', () => {
  const clock = new ClockSync({ minSamples: 3 });
  // Local clock is 5000ms behind the server, zero network delay.
  for (let i = 0; i < 3; i += 1) {
    clock.record({ localSentAt: 10_000, localReceivedAt: 10_000, serverTimestamp: 15_000 });
  }
  assert.equal(clock.skewMs(), 5000);
  assert.equal(clock.toServerTime(10_000), 15_000);
  assert.equal(clock.toLocalTime(15_000), 10_000);
});

test('the median ignores one wildly skewed sample', () => {
  const clock = new ClockSync({ minSamples: 3, sampleWindowSize: 10 });
  for (let i = 0; i < 5; i += 1) {
    clock.record({ localSentAt: 1_000_000, localReceivedAt: 1_000_100, serverTimestamp: 1_000_050 });
  }
  // A one-hour NTP step in the sample. A mean would leap; the median should not.
  clock.record({ localSentAt: 1_000_000, localReceivedAt: 1_000_100, serverTimestamp: 4_600_050 });

  assert.equal(clock.skewMs(), 0, 'the outlier did not move the median');
});

test('the window is bounded and old samples fall out', () => {
  const clock = new ClockSync({ minSamples: 1, sampleWindowSize: 2 });
  clock.record({ localSentAt: 0, localReceivedAt: 0, serverTimestamp: 100 });
  clock.record({ localSentAt: 0, localReceivedAt: 0, serverTimestamp: 100 });
  clock.record({ localSentAt: 0, localReceivedAt: 0, serverTimestamp: 900 });

  assert.equal(clock.sampleCount, 2, 'the window holds exactly sampleWindowSize');
});

test('reset clears the window', () => {
  const clock = new ClockSync({ minSamples: 1 });
  clock.record({ localSentAt: 0, localReceivedAt: 0, serverTimestamp: 100 });
  assert.equal(clock.sampleCount, 1);
  clock.reset();
  assert.equal(clock.sampleCount, 0);
  assert.equal(clock.skewMs(), 0);
});

/* ── plugin ──────────────────────────────────────────────────────────── */

test('the plugin records a sample from each inbound server timestamp', () => {
  const sock = fakeSocket();
  applyPlugin(clockSync({ minSamples: 1 }), sock);

  const stampSeconds = 1_700_000_000;
  upsert(sock, [wmMessage({ messageTimestamp: stampSeconds })]);

  assert.equal(sock.clock.sampleCount(), 1);
  const stats = sock.clock.stats();
  assert.equal(typeof stats.skewMs, 'number');
  assert.ok(Number.isFinite(stats.skewMs));
});

test('messages without a usable timestamp are ignored', () => {
  const sock = fakeSocket();
  applyPlugin(clockSync({ minSamples: 1 }), sock);

  upsert(sock, [
    wmMessage({ messageTimestamp: 0 }),
    wmMessage({ messageTimestamp: null }),
    { key: { remoteJid: 'x@s.whatsapp.net', id: '1' }, message: {} },
  ]);

  assert.equal(sock.clock.sampleCount(), 0);
});

test('clock helpers are attached non-enumerably', () => {
  const sock = fakeSocket();
  applyPlugin(clockSync(), sock);

  assert.equal(Object.keys(sock).includes('clock'), false);
  assert.equal(Object.getOwnPropertyDescriptor(sock, 'clock').enumerable, false);
  assert.equal(typeof sock.clock.toServerTime, 'function');
});
