/**
 * Delivery tracking — the rate estimator and the plugin that feeds it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DeliveryTracker } from '../dist/core/delivery.js';
import { delivery } from '../dist/plugins/delivery.js';

import { applyPlugin, fakeSocket, flush } from './helpers.js';

/* ── DeliveryTracker ─────────────────────────────────────────────────── */

test('the rate is null until the minimum sample size is reached', () => {
  const tracker = new DeliveryTracker({ minSampleSize: 3 });
  tracker.sent('a');
  tracker.sent('b');
  tracker.delivered('a');

  const stats = tracker.stats();
  assert.equal(stats.sent, 2);
  assert.equal(stats.delivered, 1);
  assert.equal(stats.rate, null, 'two sends is not a meaningful rate');
});

test('the rate is delivered over sent once sampling is meaningful', () => {
  const tracker = new DeliveryTracker({ minSampleSize: 4 });
  for (const id of ['a', 'b', 'c', 'd']) tracker.sent(id);
  tracker.delivered('a');
  tracker.delivered('b');
  tracker.delivered('c');

  assert.equal(tracker.stats().rate, 0.75);
});

test('an unknown delivery receipt is ignored', () => {
  const tracker = new DeliveryTracker({ minSampleSize: 1 });
  tracker.sent('a');
  assert.doesNotThrow(() => tracker.delivered('never-sent'));
  assert.equal(tracker.stats().delivered, 0);
});

test('the low-rate callback fires at most once per window', () => {
  let calls = 0;
  const tracker = new DeliveryTracker({ minSampleSize: 2, lowRateThreshold: 0.9, onLowRate: () => (calls += 1) });

  tracker.sent('a');
  tracker.sent('b');
  tracker.delivered('a'); // 1/2 = 0.5 < 0.9
  tracker.delivered('c'); // still low, but already alerted
  tracker.delivered('d');

  assert.equal(calls, 1, 'the alert is rate-limited to once per window');
});

test('reset clears tracked messages', () => {
  const tracker = new DeliveryTracker({ minSampleSize: 1 });
  tracker.sent('a');
  assert.equal(tracker.tracked, 1);
  tracker.reset();
  assert.equal(tracker.tracked, 0);
});

/* ── plugin ──────────────────────────────────────────────────────────── */

test('the plugin captures every sent message id', async () => {
  const sock = fakeSocket();
  applyPlugin(delivery({ minSampleSize: 1 }), sock);

  await sock.sendMessage('x@s.whatsapp.net', { text: 'hi' });
  assert.equal(sock.delivery.tracked(), 1);
});

test('status 3 and 4 mark delivery, other statuses do not', async () => {
  const sock = fakeSocket();
  applyPlugin(delivery({ minSampleSize: 1 }), sock);

  await sock.sendMessage('x@s.whatsapp.net', { text: 'one' });
  await sock.sendMessage('x@s.whatsapp.net', { text: 'two' });
  await sock.sendMessage('x@s.whatsapp.net', { text: 'three' });
  await flush();

  sock.ev.emit('messages.update', [
    { key: { id: 'SENT-1' }, update: { status: 2 } }, // sent to server — not delivered
  ]);
  sock.ev.emit('messages.update', [
    { key: { id: 'SENT-2' }, update: { status: 3 } }, // delivered
    { key: { id: 'SENT-3' }, update: { status: 4 } }, // read
  ]);

  const stats = sock.delivery.stats();
  assert.equal(stats.sent, 3);
  assert.equal(stats.delivered, 2);
});

test('the delivery helpers are attached non-enumerably', () => {
  const sock = fakeSocket();
  applyPlugin(delivery(), sock);
  assert.equal(Object.keys(sock).includes('delivery'), false);
  assert.equal(typeof sock.delivery.stats, 'function');
});

test('dispose unwinds the sendMessage patch', () => {
  const sock = fakeSocket();
  const original = sock.sendMessage;
  const { dispose } = applyPlugin(delivery(), sock);
  assert.notEqual(sock.sendMessage, original);
  dispose();
  assert.equal(sock.sendMessage, original);
});
