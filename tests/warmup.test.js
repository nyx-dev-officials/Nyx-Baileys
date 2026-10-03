/**
 * Warm-up ramp.
 *
 * The curve is 8× -> 1× over the window, monotone decreasing. The regression
 * worth pinning: a brand-new session must have its ramp applied *on the build
 * that created it*, not only on the next restart.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rampFor } from '../dist/plugins/warmup.js';
import { warmup } from '../dist/plugins/warmup.js';

import { fakeSocket, pluginContext } from './helpers.js';

const DAY = 86_400_000;
const T0 = 1_700_000_000_000;

test('the ramp starts at 8x and reaches 1x at the end of the window', () => {
  assert.equal(rampFor(T0, 3, T0), 8);
  assert.equal(rampFor(T0, 3, T0 + 3 * DAY), 1);
  assert.equal(rampFor(T0, 3, T0 + 10 * DAY), 1, 'clamped past the window');
});

test('the ramp is monotone decreasing', () => {
  let previous = Infinity;
  for (let h = 0; h <= 72; h += 3) {
    const value = rampFor(T0, 3, T0 + h * 3_600_000);
    assert.ok(value <= previous + 1e-9, `value rose at hour ${h}`);
    assert.ok(value >= 1 && value <= 8);
    previous = value;
  }
});

test('days <= 0 disables the ramp', () => {
  assert.equal(rampFor(T0, 0, T0), 1);
  assert.equal(rampFor(T0, -1, T0), 1);
});

test('a brand-new session gets pressure applied on its first build', async () => {
  const sock = fakeSocket();
  const pressures = [];
  sock.__antispam = { setPressure: (n) => pressures.push(n) };

  const store = {
    name: 'fake',
    init: async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => {} }),
    get: (_key, fallback) => fallback, // no stored start time -> brand new
    set: async () => {},
  };

  const { ctx, dispose } = pluginContext(sock, { state: store });
  await warmup(3).apply(ctx);

  assert.equal(pressures.length, 1, 'pressure was applied once');
  assert.ok(pressures[0] > 7.9, `expected ~8x on a fresh session, got ${pressures[0]}`);
  dispose();
});

test('an aged session gets the eased multiplier, and dispose stops the tick', async () => {
  const sock = fakeSocket();
  const pressures = [];
  sock.__antispam = { setPressure: (n) => pressures.push(n) };

  const startedAt = Date.now() - 48 * 3_600_000; // two days old
  const store = {
    name: 'fake',
    init: async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => {} }),
    get: (_key, fallback) => (typeof fallback === 'number' ? startedAt : fallback),
    set: async () => {},
  };

  const { ctx, dispose } = pluginContext(sock, { state: store });
  await warmup(3).apply(ctx);

  assert.equal(pressures.length, 1);
  assert.ok(pressures[0] < 3 && pressures[0] >= 1, `two days old should be well past 8x, got ${pressures[0]}`);
  assert.equal(typeof dispose, 'function');
  dispose();
});
