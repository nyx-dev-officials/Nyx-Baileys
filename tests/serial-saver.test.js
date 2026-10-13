import test from 'node:test';
import assert from 'node:assert/strict';

import { SerialSaver } from '../dist/core/session-store.js';

const slow = (ms) => new Promise((r) => setTimeout(r, ms));

test('queued saves land in order even when the first is slow', async () => {
  const saver = new SerialSaver();
  const order = [];
  const a = saver.run(async () => { await slow(50); order.push('a'); });
  const b = saver.run(async () => { order.push('b'); });
  await Promise.all([a, b]);
  assert.deepEqual(order, ['a', 'b']);
});

test('drain waits for writes queued before it', async () => {
  const saver = new SerialSaver();
  let landed = false;
  saver.run(async () => { await slow(80); landed = true; });
  await saver.drain();
  assert.equal(landed, true, 'drain returned before the queued write landed');
});

test('drain on an idle saver resolves immediately', async () => {
  await new SerialSaver().drain();
});

test('a rejecting write neither breaks the chain nor the drain', async () => {
  const saver = new SerialSaver();
  const order = [];
  const failing = saver.run(async () => { order.push('boom'); throw new Error('disk hiccup'); });
  const next = saver.run(async () => { order.push('after'); });
  await failing;
  await next;
  assert.deepEqual(order, ['boom', 'after']);
  await saver.drain();
});

test('run resolves only after its own write', async () => {
  const saver = new SerialSaver();
  let first = false;
  let second = false;
  const a = saver.run(async () => { await slow(40); first = true; });
  const b = saver.run(async () => { second = true; });
  await b;
  assert.equal(first && second, true);
  await a;
});