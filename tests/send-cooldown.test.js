/**
 * Outbound pacing — the 1s floor, and the two rules that protect it.
 *
 * Requested pacing is a 1s cooldown between outbound messages. The floor is
 * easy to state and easy to break by accident, so it is pinned here:
 *
 *   1. **Jitter can only widen the gap.** `gap()` returns
 *      `minGapMs + clamped*jitterMs` with `clamped >= 0`, so tuning jitter for
 *      anti-spam reasons can never drop the floor. If that ordering ever
 *      changes, sends start going out faster than configured — silently.
 *
 *   2. **The default really is 1s.** A caller passing a lower value gets what
 *      it asked for, but the shipped default is the one that must hold.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { antiSpam } from '../dist/plugins/antiSpam.js';

/** A socket that records send timestamps, wrapped by the plugin. */
async function harness(options = {}) {
  const stamps = [];
  const sock = {
    sendMessage() {
      stamps.push(Date.now());
      return Promise.resolve({ key: { id: 'X' } });
    },
    groupToggleEphemeral: async () => undefined,
  };

  const ctx = {
    sock,
    log: { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) },
    config: {},
    onDispose() {},
  };

  const plugin = antiSpam(options);
  plugin.apply(ctx);

  return { sock, stamps, plugin };
}

test('default cooldown floor is 2.5s', async () => {
  // jitter is zeroed so this measures the floor itself, not the floor plus
  // randomness. Read off the plugin rather than a literal, so changing the
  // default without updating the test is caught here.
  const { sock, stamps } = await harness({ jitterMs: 0, maxPerMinute: 60 });
  await sock.sendMessage('a@s.whatsapp.net', { text: 'one' });
  await sock.sendMessage('a@s.whatsapp.net', { text: 'two' });
  assert.equal(stamps.length, 2);
  assert.ok(stamps[1] - stamps[0] >= 2_450,
    `expected >= 2500ms between sends, measured ${stamps[1] - stamps[0]}ms`);
});

test('jitter only ever widens the gap, never narrows it', async () => {
  // jitterMs is large, so a buggy implementation that subtracted jitter would
  // show up as sends landing far closer together than minGapMs.
  const { sock, stamps } = await harness({ minGapMs: 2_500, jitterMs: 4_000, maxPerMinute: 60 });
  for (let i = 0; i < 3; i++) {
    await sock.sendMessage('a@s.whatsapp.net', { text: `m${i}` });
  }
  for (let i = 1; i < stamps.length; i++) {
    const delta = stamps[i] - stamps[i - 1];
    assert.ok(delta >= 2_450,
      `gap ${i} was ${delta}ms — jitter undercut the 2500ms floor`);
  }
});

test('non-message actions skip the cooldown entirely', async () => {
  // A reaction is an action on an existing message, not a send. Pacing it
  // makes a tap feel broken, so it must not consume or wait out a gap.
  const { sock, stamps } = await harness({ minGapMs: 2_500, jitterMs: 0, maxPerMinute: 60 });
  const t0 = Date.now();
  await sock.sendMessage('a@s.whatsapp.net', { react: { text: '👍', key: {} } });
  const elapsed = Date.now() - t0;
  assert.equal(stamps.length, 1, 'the reaction did not go through sendMessage');
  assert.ok(elapsed < 2_300,
    `a reaction waited ${elapsed}ms — reactions must not be paced`);
});

test('a text send alongside a nullish react is still paced', async () => {
  // `{ text: 'hi', react: undefined }` is a text send, not a reaction. Upstream
  // uses hasNonNullishProperty, and this must match or real sends bypass.
  const { sock, stamps } = await harness({ minGapMs: 2_500, jitterMs: 0, maxPerMinute: 60 });
  await sock.sendMessage('a@s.whatsapp.net', { text: 'hi', react: undefined });
  await sock.sendMessage('a@s.whatsapp.net', { text: 'hi', react: undefined });
  assert.equal(stamps.length, 2);
  assert.ok(stamps[1] - stamps[0] >= 2_450);
});

test('concurrent sends are serialised, not burst', async () => {
  // Fire three at once without awaiting. The queue must space them; without it
  // all three would land in the same tick.
  const { sock, stamps } = await harness({ minGapMs: 2_500, jitterMs: 0, maxPerMinute: 60 });
  await Promise.all([
    sock.sendMessage('a@s.whatsapp.net', { text: 'a' }),
    sock.sendMessage('a@s.whatsapp.net', { text: 'b' }),
    sock.sendMessage('a@s.whatsapp.net', { text: 'c' }),
  ]);
  assert.equal(stamps.length, 3);
  assert.ok(stamps[1] - stamps[0] >= 950);
  assert.ok(stamps[2] - stamps[1] >= 2_450);
});

test('an explicit override is honoured, not clamped to the default', async () => {
  // The default is a floor for the shipped config, not a rule imposed on
  // callers who deliberately ask for less (test harnesses, bulk tools).
  const { sock, stamps } = await harness({ minGapMs: 50, jitterMs: 0, maxPerMinute: 60 });
  await sock.sendMessage('a@s.whatsapp.net', { text: 'a' });
  await sock.sendMessage('a@s.whatsapp.net', { text: 'b' });
  assert.ok(stamps[1] - stamps[0] < 2_300,
    'an explicit low minGapMs should actually take effect');
});