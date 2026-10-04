/**
 * Anti-spam pacing.
 *
 * All timings are real but tiny (tens of milliseconds) and every jitter term is
 * pinned to 0 where an exact assertion is needed, so the suite never sleeps for
 * seconds. Two properties are asserted beyond "it did not throw":
 *
 *   - ordering: the queue is strictly FIFO, so send order survives the wrapper
 *   - pacing:   the gap between two sends really is `minGapMs + jitter`,
 *               multiplied by whatever `setPressure` last set
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { antiSpam } from '../dist/plugins/antiSpam.js';

import { applyPlugin, fakeSocket } from './helpers.js';

const CHAT = '111@s.whatsapp.net';

/** Build a socket with the plugin applied and the config knobs forced off. */
function rig(overrides = {}) {
  const sock = fakeSocket();
  // Captured before patching so tests can assert identity restoration.
  const pristine = { sendMessage: sock.sendMessage, relayMessage: sock.relayMessage };
  const cfg = { minGapMs: 0, jitterMs: 0, maxPerMinute: 1000, maxQueue: 100, ...overrides };
  const harness = applyPlugin(antiSpam(cfg), sock);
  return { sock, pristine, ...harness, api: sock.__antispam, cfg };
}

const texts = (sock) => sock.sent.map((m) => m.content?.text);

/* ── queue ordering ──────────────────────────────────────────────────── */

test('the queue is strictly FIFO — send order survives the wrapper', async () => {
  const { sock } = rig();

  const promises = [
    sock.sendMessage(CHAT, { text: '1' }),
    sock.sendMessage(CHAT, { text: '2' }),
    sock.sendMessage(CHAT, { text: '3' }),
    sock.sendMessage(CHAT, { text: '4' }),
    sock.sendMessage(CHAT, { text: '5' }),
  ];
  const results = await Promise.all(promises);

  assert.deepEqual(texts(sock), ['1', '2', '3', '4', '5']);
  assert.deepEqual(results.map((r) => r.key.remoteJid), Array(5).fill(CHAT));
});

test('every argument reaches the underlying send untouched', async () => {
  const { sock } = rig();
  const content = { text: 'hi' };
  const extra = { linkPreview: { url: 'https://x.invalid' } };

  await sock.sendMessage(CHAT, content, extra);

  assert.equal(sock.sent.length, 1);
  assert.equal(sock.sent[0].jid, CHAT);
  assert.equal(sock.sent[0].content, content, 'the content object keeps its identity');
  assert.equal(sock.sent[0].extra, extra);
});

test('relayMessage is left alone — anti-spam only paces sendMessage', async () => {
  const { sock, pristine } = rig({ minGapMs: 60, maxPerMinute: 1000 });

  assert.equal(sock.relayMessage, pristine.relayMessage, 'relayMessage must not be wrapped');

  // A relay must not wait out the queue gap the way a paced send does.
  const queued = sock.sendMessage(CHAT, { text: 'paced' });
  const before = Date.now();
  await sock.relayMessage(CHAT, 'MSGID1');
  const elapsed = Date.now() - before;
  await queued;

  assert.ok(elapsed < 30, `a relay should go straight out, took ${elapsed}ms`);
  assert.deepEqual(
    sock.sent.map((m) => m.via),
    ['relayMessage', 'sendMessage'],
    'the relay is not queued behind the paced send',
  );
});

/* ── non-message actions ─────────────────────────────────────────────── */

test('reactions, edits, deletes, pins and protocol actions skip the queue', async () => {
  const { sock } = rig({ minGapMs: 60, maxPerMinute: 1000 });

  const before = Date.now();
  await Promise.all([
    sock.sendMessage(CHAT, { react: { text: '👍', key: {} } }),
    sock.sendMessage(CHAT, { edit: {}, text: 'fixed' }),
    sock.sendMessage(CHAT, { delete: {} }),
    sock.sendMessage(CHAT, { pin: {} }),
    sock.sendMessage(CHAT, { disappearingMessagesInChat: true }),
    sock.sendMessage(CHAT, { sharePhoneNumber: true }),
    sock.sendMessage(CHAT, { limitSharing: true }),
  ]);
  const elapsed = Date.now() - before;

  assert.equal(sock.sent.length, 7, 'every action still reached the socket');
  assert.ok(elapsed < 30, `an action must not wait out a gap, took ${elapsed}ms`);
});

test('a nullish action key does not bypass — the content is still a paced send', async () => {
  const { sock } = rig({ minGapMs: 0, maxPerMinute: 1 });

  // `react` is present but undefined. Upstream's own non-nullish rule says this
  // is a text send, so it must be paced and counted like one.
  await sock.sendMessage(CHAT, { text: 'first', react: undefined });
  await assert.rejects(sock.sendMessage(CHAT, { text: 'second' }), /burst ceiling 1\/min/);
});

test('bypassed actions do not consume the send ceiling', async () => {
  const { sock } = rig({ minGapMs: 0, maxPerMinute: 1 });

  await sock.sendMessage(CHAT, { react: { text: '👍', key: {} } });
  await sock.sendMessage(CHAT, { delete: {} });

  // The window still holds room for exactly one real message.
  await sock.sendMessage(CHAT, { text: 'first' });
  await assert.rejects(sock.sendMessage(CHAT, { text: 'second' }), /burst ceiling 1\/min/);
});

test('polls, events and plain text are messages — still paced and counted', async () => {
  const { sock } = rig({ minGapMs: 0, maxPerMinute: 2 });

  await sock.sendMessage(CHAT, { text: 'hello' });
  await sock.sendMessage(CHAT, { event: { name: 'standup' } });

  await assert.rejects(
    sock.sendMessage(CHAT, { poll: { name: 'lunch?', values: ['yes', 'no'] } }),
    /burst ceiling 2\/min/,
    'a poll is a message and must still be counted',
  );
});

/* ── maxQueue ────────────────────────────────────────────────────────── */

test('sends are rejected once the queue is full, and the survivors still go out in order', async () => {
  const { sock } = rig({ minGapMs: 40, maxQueue: 1 });

  // 1 goes in flight immediately (drain shifts it before yielding), 2 waits in
  // the queue, 3 finds the queue full.
  const first = sock.sendMessage(CHAT, { text: '1' });
  const second = sock.sendMessage(CHAT, { text: '2' });

  await assert.rejects(
    sock.sendMessage(CHAT, { text: '3' }),
    (err) => {
      assert.match(err.message, /queue full \(1\)/);
      return true;
    },
  );

  await Promise.all([first, second]);
  assert.deepEqual(texts(sock), ['1', '2'], 'rejected sends never reach the socket');
});

test('maxQueue 0 rejects every send without queueing it', async () => {
  const { sock } = rig({ maxQueue: 0 });

  await assert.rejects(sock.sendMessage(CHAT, { text: 'x' }), /queue full \(0\)/);
  assert.equal(sock.sent.length, 0);
});

/* ── maxPerMinute ────────────────────────────────────────────────────── */

test('the per-minute ceiling throws, and the excess sends never reach the socket', async () => {
  const { sock } = rig({ maxPerMinute: 2 });

  const settled = await Promise.allSettled([
    sock.sendMessage(CHAT, { text: '1' }),
    sock.sendMessage(CHAT, { text: '2' }),
    sock.sendMessage(CHAT, { text: '3' }),
    sock.sendMessage(CHAT, { text: '4' }),
  ]);

  assert.deepEqual(
    settled.map((r) => r.status),
    ['fulfilled', 'fulfilled', 'rejected', 'rejected'],
  );
  for (const r of settled.slice(2)) {
    assert.match(r.reason.message, /burst ceiling 2\/min reached/);
  }
  assert.deepEqual(texts(sock), ['1', '2']);
});

test('the sliding window admits again after reset()', async () => {
  const { sock, api } = rig({ maxPerMinute: 1 });

  await sock.sendMessage(CHAT, { text: '1' });
  await assert.rejects(sock.sendMessage(CHAT, { text: '2' }), /burst ceiling 1\/min/);

  api.reset();
  await sock.sendMessage(CHAT, { text: '3' });
  assert.deepEqual(texts(sock), ['1', '3']);
});

/* ── pacing and pressure ─────────────────────────────────────────────── */

test('setPressure widens the gap between sends', async () => {
  const { sock, api } = rig({ minGapMs: 40, maxPerMinute: 1000 });

  const t0 = Date.now();
  await sock.sendMessage(CHAT, { text: 'narrow' });
  const narrow = Date.now() - t0;

  assert.equal(api.stats().pressure, 1);
  assert.ok(narrow >= 35, `a 40ms gap should take at least 35ms, took ${narrow}`);

  api.setPressure(5);
  assert.equal(api.stats().pressure, 5);

  const t1 = Date.now();
  await sock.sendMessage(CHAT, { text: 'wide' });
  const wide = Date.now() - t1;

  // 5x the gap, minus whatever the first measurement over-read.
  assert.ok(wide >= narrow * 3, `pressure 5 should widen the gap: ${narrow}ms -> ${wide}ms`);
  assert.ok(wide >= 180, `expected ~200ms under pressure 5, got ${wide}ms`);
  assert.deepEqual(texts(sock), ['narrow', 'wide']);
});

test('setPressure below 1 is clamped — pacing can never be tightened', async () => {
  const { api } = rig({ minGapMs: 20 });

  api.setPressure(0);
  assert.equal(api.stats().pressure, 1);
  api.setPressure(-5);
  assert.equal(api.stats().pressure, 1);
  api.setPressure(1);
  assert.equal(api.stats().pressure, 1);
});

test('the gap is bounded by minGapMs + jitter and is not a constant', async () => {
  const { sock } = rig({ minGapMs: 20, jitterMs: 15, maxPerMinute: 1000 });

  await Promise.all(
    ['a', 'b', 'c', 'd', 'e', 'f'].map((t) => sock.sendMessage(CHAT, { text: t })),
  );

  const stamps = sock.sent.map((m) => m.at);
  const deltas = stamps.slice(1).map((s, i) => s - stamps[i]);

  assert.equal(deltas.length, 5);
  for (const d of deltas) {
    assert.ok(d >= 18, `gap ${d}ms is below the 20ms floor`);
    assert.ok(d <= 150, `gap ${d}ms is far above the 35ms ceiling`);
  }
  assert.ok(
    new Set(deltas).size > 1,
    `every gap was identical (${deltas.join(',')}) — the jitter term is not being applied`,
  );
});

test('the first send is paced too, not just the gaps between sends', async () => {
  const { sock } = rig({ minGapMs: 35, maxPerMinute: 1000 });

  const before = Date.now();
  await sock.sendMessage(CHAT, { text: 'only' });
  const elapsed = Date.now() - before;

  assert.ok(elapsed >= 30, `the very first send should be paced, took ${elapsed}ms`);
});

/* ── stats and reset ─────────────────────────────────────────────────── */

test('stats() reports queue depth, the live window and the pressure', async () => {
  const { sock, api } = rig({ minGapMs: 30 });

  assert.deepEqual(api.stats(), { queued: 0, sent: 0, pressure: 1 });

  await sock.sendMessage(CHAT, { text: '1' });
  assert.equal(api.stats().sent, 1);
  assert.equal(api.stats().queued, 0);
  assert.equal(api.stats().pressure, 1);

  api.setPressure(3);
  assert.equal(api.stats().pressure, 3);
});

test('reset() clears the queue, the window and the pressure', async () => {
  const { sock, api } = rig({ minGapMs: 20 });

  await Promise.all([sock.sendMessage(CHAT, { text: '1' }), sock.sendMessage(CHAT, { text: '2' })]);
  api.setPressure(4);
  assert.ok(api.stats().sent > 0);

  api.reset();

  assert.deepEqual(api.stats(), { queued: 0, sent: 0, pressure: 1 });
  assert.deepEqual(Object.keys(api.stats()).sort(), ['pressure', 'queued', 'sent']);
});

test('after reset() the plugin keeps pacing normally', async () => {
  const { sock, api } = rig({ minGapMs: 20 });

  await sock.sendMessage(CHAT, { text: 'before' });
  api.reset();

  const t = Date.now();
  await sock.sendMessage(CHAT, { text: 'after' });
  const elapsed = Date.now() - t;

  assert.ok(elapsed >= 15, `pacing should survive reset(), took ${elapsed}ms`);
  assert.deepEqual(texts(sock), ['before', 'after']);
});

/* ── lifecycle ───────────────────────────────────────────────────────── */

test('dispose() restores sendMessage and sends bypass the queue', async () => {
  const { sock, pristine, dispose } = rig({ minGapMs: 0 });

  assert.notEqual(sock.sendMessage, pristine.sendMessage, 'sanity: it was patched');

  dispose();
  assert.equal(sock.sendMessage, pristine.sendMessage, 'the pristine function is back');

  const before = Date.now();
  await sock.sendMessage(CHAT, { text: 'direct' });
  const elapsed = Date.now() - before;

  assert.equal(sock.sent.length, 1);
  assert.ok(elapsed < 15, `an unpatched socket must send immediately, took ${elapsed}ms`);
});

test('teardown restores sendMessage and leaves relayMessage alone', async () => {
  const { sock, pristine, dispose } = rig();

  assert.notEqual(sock.sendMessage, pristine.sendMessage, 'sanity: sendMessage was patched');
  assert.equal(sock.relayMessage, pristine.relayMessage, 'sanity: relayMessage was never patched');

  const relayed = await sock.relayMessage(CHAT, 'M1');
  assert.equal(relayed.key.id, 'RELAY-1', 'relayMessage still works');

  dispose();

  assert.equal(sock.sendMessage, pristine.sendMessage, 'the pristine send function is back');
  assert.equal(sock.relayMessage, pristine.relayMessage);
  assert.equal(typeof sock.relayMessage, 'function');
});

test('a socket missing sendMessage is reported, not silently left unpaced', () => {
  const bare = {
    ev: fakeEvMinimal(),
    relayMessage(jid, messageId) {
      bare.calls.push({ jid, messageId });
      return { key: { id: 'R1', remoteJid: jid } };
    },
    calls: [],
  };

  const harness = applyPlugin(antiSpam({ minGapMs: 0, jitterMs: 0, maxPerMinute: 100, maxQueue: 10 }), bare);

  assert.ok(
    harness.log.has('method missing'),
    'a missing sendMessage should be reported, not silently ignored',
  );
  assert.doesNotThrow(() => harness.dispose());
});

/** Minimal emitter — `fakeSocket()` would add methods we are asserting are absent. */
function fakeEvMinimal() {
  const listeners = new Map();
  return {
    on: (e, f) => listeners.set(e, f),
    off: (e) => listeners.delete(e),
    emit: (e, p) => listeners.get(e)?.(p),
    removeAllListeners: () => listeners.clear(),
  };
}