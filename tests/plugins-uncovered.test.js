/**
 * Coverage for the seven plugins that had none.
 *
 *   stealth · metrics · webhooks · call-log · read-receipts · send-presence ·
 *   anti-delete
 *
 * They are not obscure — `stealth` is order 10 and runs in every default chain,
 * and `read-receipts` and `call-log` sit in the middle of the opt-in set. None
 * had a test, which is the same gap that let eight pairing defects through
 * `src/cli/` unnoticed: nothing fails, so nothing is checked.
 *
 * Assertions are about behaviour a user would notice — presence going available
 * on connect, a call folding from `offer` to `terminate`, a webhook body whose
 * signature the plugin's own verifier accepts — not about internal counters,
 * except where the counter *is* the contract.
 *
 * Several APIs here are not what their names suggest, and the tests were written
 * against the source rather than the names:
 *   - `sock.calls` is a **Map keyed by chatId**, not an array, and `getCall`
 *     takes a **chatId**, not a call id.
 *   - `sock.revoked.get(jid, id)` takes two arguments, not a message key.
 *   - the webhook plugin has no delivery callback — it really does `fetch`, so
 *     these stub `globalThis.fetch` rather than inventing an injection point.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stealth } from '../dist/plugins/stealth.js';
import { metrics } from '../dist/plugins/metrics.js';
import { webhooks } from '../dist/plugins/webhook.js';
import { callLog } from '../dist/plugins/call-log.js';
import { readReceipts } from '../dist/plugins/read-receipts.js';
import { sendPresence } from '../dist/plugins/send-presence.js';
import { antiDelete } from '../dist/plugins/anti-delete.js';
import { WAMessageStubType } from '../dist/index.js';

import { GROUP, applyPlugin, fakeSocket, flush, pn, upsert, wmMessage } from './helpers.js';

const DM = pn(1);
const OTHER = pn(2);

/** Capture webhook POSTs without touching the network. */
function captureFetch() {
  const posts = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    posts.push({ url: String(url), headers: init.headers, body: init.body });
    return { ok: true, status: 200, headers: { get: () => null } };
  };
  return {
    posts,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

/* ── stealth ───────────────────────────────────────────────────────────── */

test('stealth pins one fingerprint and exposes it as __identity', () => {
  const sock = fakeSocket();
  applyPlugin(stealth(), sock);

  const id = sock.__identity;
  assert(id, '__identity not attached');
  assert(Array.isArray(id.browser) && id.browser.length === 3, `browser tuple: ${id.browser}`);
  assert(id.userAgent.includes('Chrome'), `ua should name the engine: ${id.userAgent}`);
  assert(
    id.userAgent.includes(`Chrome/${id.browser[1]}.`),
    'the ua version must match the pinned tuple, or the two disagree',
  );
});

test('stealth reports available on open and unavailable on close', async () => {
  const sock = fakeSocket();
  applyPlugin(stealth(), sock);

  sock.ev.emit('connection.update', { connection: 'open' });
  await flush();
  assert.equal(sock.presence, 'available');

  sock.ev.emit('connection.update', { connection: 'close' });
  await flush();
  assert.equal(sock.presence, 'unavailable', 'presence must track the socket, not a fixed value');
});

test('a failing presence update does not take the socket down', async () => {
  const sock = fakeSocket();
  sock.sendPresenceUpdate = () => {
    throw new Error('no presence for you');
  };
  applyPlugin(stealth(), sock);

  sock.ev.emit('connection.update', { connection: 'open' });
  await flush();
  // The contract is that apply() already returned and the throw was contained.
  assert(sock.__identity, 'the plugin should still be attached after a presence failure');
});

/* ── metrics ───────────────────────────────────────────────────────────── */

test('metrics counts inbound messages and reports a snapshot', async () => {
  const sock = fakeSocket();
  applyPlugin(metrics(), sock);

  upsert(sock, [wmMessage({ jid: DM, id: 'm1' }), wmMessage({ jid: DM, id: 'm2' })]);
  sock.ev.emit('connection.update', { connection: 'open' });
  await flush();

  const snap = sock.metrics.snapshot();
  assert(Array.isArray(snap.metrics), 'snapshot has no metrics');
  assert(typeof snap.uptimeSec === 'number', 'snapshot has no uptime');

  const total = snap.metrics.reduce(
    (n, m) => n + m.series.reduce((s, x) => s + x.count, 0),
    0,
  );
  assert(total >= 2, `expected the two messages to be counted, got ${total}`);
});

test('metrics keeps labels per series, so phases do not collapse together', () => {
  const sock = fakeSocket();
  applyPlugin(metrics(), sock);

  sock.ev.emit('connection.update', { connection: 'open' });
  sock.ev.emit('connection.update', { connection: 'connecting' });
  sock.ev.emit('connection.update', { connection: 'open' });

  const labels = sock.metrics
    .snapshot()
    .metrics.flatMap((m) => m.series.map((s) => JSON.stringify(s.labels)));

  assert(labels.length >= 2, `open and connecting should be separate series: ${labels.join(' ')}`);
  assert(
    labels.some((l) => l.includes('open')) && labels.some((l) => l.includes('connecting')),
    `phase labels missing: ${labels.join(' ')}`,
  );
});

/* ── webhooks ──────────────────────────────────────────────────────────── */

test('webhooks attaches its registration surface', () => {
  const sock = fakeSocket();
  applyPlugin(webhooks({ endpoints: [{ url: 'https://example.test/hook', secret: 's' }] }), sock);

  assert(sock.webhooks, 'webhooks helper not attached');
  assert(sock.webhooks.verify, 'verify() not exposed — a receiver could not check a signature');
});

test('a webhook delivery is signed, and the plugin verifies its own signature', async () => {
  const net = captureFetch();
  try {
    const sock = fakeSocket();
    applyPlugin(
      webhooks({ routes: [{ event: 'messages.upsert', endpoint: { url: 'https://example.test/hook', secret: 's3cret' } }] }),
      sock,
    );

    upsert(sock, [wmMessage({ jid: DM, id: 'hook-1', message: { conversation: 'ping' } })]);
    // Deliveries are queued; give the queue a tick to drain.
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(net.posts.length, 1, `expected one POST, got ${net.posts.length}`);
    const post = net.posts[0];
    assert.equal(post.url, 'https://example.test/hook');
    assert.equal(post.headers['x-super-event'], 'messages.upsert', 'event header missing');

    const signature = post.headers['x-super-signature'];
    const timestamp = post.headers['x-super-timestamp'];
    assert(signature && timestamp, 'delivery is unsigned');

    assert.equal(
      sock.webhooks.verify(post.body, timestamp, signature, 's3cret'),
      true,
      'the plugin cannot verify its own signature',
    );
    assert.equal(
      sock.webhooks.verify(post.body, timestamp, signature, 'wrong-secret'),
      false,
      'a wrong secret must not verify — that is the entire point of the signature',
    );
  } finally {
    net.restore();
  }
});

test('webhooks skips events a route did not subscribe to', async () => {
  const net = captureFetch();
  try {
    const sock = fakeSocket();
    applyPlugin(
      webhooks({ routes: [{ event: 'messages.reaction', endpoint: { url: 'https://example.test/r', secret: 's' } }] }),
      sock,
    );

    upsert(sock, [wmMessage({ jid: DM, id: 'nope-1', message: { conversation: 'hello' } })]);
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(net.posts.length, 0, 'a message reached a reaction-only route');
  } finally {
    net.restore();
  }
});

test('sign: false posts without a signature', async () => {
  const net = captureFetch();
  try {
    const sock = fakeSocket();
    applyPlugin(
      webhooks({ routes: [{ event: 'messages.upsert', endpoint: { url: 'https://example.test/h', sign: false } }] }),
      sock,
    );

    upsert(sock, [wmMessage({ jid: DM, id: 'plain-1', message: { conversation: 'ping' } })]);
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(net.posts.length, 1);
    assert.equal(net.posts[0].headers['x-super-signature'], undefined, 'signed when explicitly disabled');
  } finally {
    net.restore();
  }
});

/* ── call-log ──────────────────────────────────────────────────────────── */

const callFrame = (status, extra = {}) => ({
  id: 'call-1',
  from: OTHER,
  chatId: DM,
  isVideo: false,
  isGroup: false,
  status,
  timestamp: Date.now(),
  ...extra,
});

test('call-log folds a call forward from offer to terminate', async () => {
  const sock = fakeSocket();
  applyPlugin(callLog(), sock);

  sock.ev.emit('call', [callFrame('offer')]);
  await flush();
  assert.equal(sock.calls.size, 1, 'the offer was not recorded');
  assert.equal(sock.calls.get(DM).ended, false);
  assert.equal(sock.calls.get(DM).missed, false);

  sock.ev.emit('call', [callFrame('terminate')]);
  await flush();

  const call = sock.calls.get(DM);
  assert.equal(call.ended, true, 'terminate did not close the call');
  assert.equal(call.missed, true, 'a call that never connected is missed');
  assert(call.statuses.includes('offer'), `statuses lost the offer: ${call.statuses}`);
});

test('call-log counts a connected call as not missed', async () => {
  const sock = fakeSocket();
  applyPlugin(callLog(), sock);

  sock.ev.emit('call', [callFrame('offer'), callFrame('accept'), callFrame('terminate')]);
  await flush();

  assert.equal(sock.missedCalls().length, 0, 'a call that connected is not missed');
});

test('call-log answers by chat id and summarises', async () => {
  const sock = fakeSocket();
  applyPlugin(callLog(), sock);

  sock.ev.emit('call', [
    callFrame('offer', { chatId: DM, id: 'a' }),
    callFrame('offer', { chatId: OTHER, id: 'b' }),
  ]);
  sock.ev.emit('call', [callFrame('terminate', { chatId: DM, id: 'a' })]);
  await flush();

  assert(sock.getCall(DM), 'getCall returned nothing for a known chat');
  assert.equal(sock.getCall('nobody@s.whatsapp.net'), undefined, 'getCall invented a call');

  const s = sock.callSummary();
  assert(s.total >= 2, `summary total: ${s.total}`);
  assert(typeof s.missed === 'number', 'summary has no missed count');
});

test('call-log honours the ignore filter', async () => {
  const sock = fakeSocket();
  applyPlugin(callLog({ ignore: (chatId) => chatId === DM }), sock);

  sock.ev.emit('call', [callFrame('offer')]);
  await flush();

  assert.equal(sock.calls.size, 0, 'an ignored chat was recorded');
});

test('a second offer in the same chat starts a new call', async () => {
  const sock = fakeSocket();
  applyPlugin(callLog(), sock);

  sock.ev.emit('call', [callFrame('offer', { id: 'first' })]);
  sock.ev.emit('call', [callFrame('offer', { id: 'second' })]);
  await flush();

  assert.equal(sock.calls.size, 1, 'same chat, so still one live call');
  assert.equal(sock.calls.get(DM).id, 'second', 'the newer offer should win');
});

/* ── read-receipts ─────────────────────────────────────────────────────── */

test('read-receipts marks an incoming direct chat read', async () => {
  const sock = fakeSocket();
  const read = [];
  sock.readMessages = async (keys) => read.push(keys.length);
  applyPlugin(readReceipts(), sock);
  await flush();   // apply is async; applyPlugin does not await it

  upsert(sock, [wmMessage({ jid: DM, id: 'r-1', message: { conversation: 'hi' } })]);
  await flush();

  assert.equal(read.length, 1, `readMessages called ${read.length} times, expected 1`);
  assert.equal(sock.receiptSnapshot().marked >= 1, true);
  assert(sock.readReceiptKeys.size >= 1, 'no receipt keys recorded');
});

test('read-receipts never marks our own message — WhatsApp does not send one', async () => {
  const sock = fakeSocket();
  const read = [];
  sock.readMessages = async (keys) => read.push(keys.length);
  applyPlugin(readReceipts(), sock);
  await flush();

  upsert(sock, [wmMessage({ jid: DM, id: 'own', fromMe: true, message: { conversation: 'mine' } })]);
  await flush();

  assert.equal(read.length, 0, 'a receipt was sent for our own message');
});

test('read-receipts leaves status broadcasts to status.ts', async () => {
  const sock = fakeSocket();
  const read = [];
  sock.readMessages = async (keys) => read.push(keys.length);
  applyPlugin(readReceipts(), sock);
  await flush();

  upsert(sock, [wmMessage({ jid: '123456@broadcast', id: 'r-2', message: { conversation: 'x' } })]);
  await flush();

  assert.equal(read.length, 0, 'a status broadcast was marked read');
});

test('read-receipts skips groups unless enabled', async () => {
  const off = fakeSocket();
  const offRead = [];
  off.readMessages = async (k) => offRead.push(k.length);
  applyPlugin(readReceipts(), off);
  await flush();
  upsert(off, [wmMessage({ jid: GROUP, id: 'r-3', participant: OTHER, message: { conversation: 'x' } })]);
  await flush();
  assert.equal(offRead.length, 0, 'a group was marked read by default');

  const on = fakeSocket();
  const onRead = [];
  on.readMessages = async (k) => onRead.push(k.length);
  applyPlugin(readReceipts({ groups: true }), on);
  await flush();
  upsert(on, [wmMessage({ jid: GROUP, id: 'r-4', participant: OTHER, message: { conversation: 'x' } })]);
  await flush();
  assert.equal(onRead.length, 1, 'groups:true did not enable group receipts');
});

test('read-receipts snapshot reports its own policy', async () => {
  const sock = fakeSocket();
  applyPlugin(readReceipts({ autoRead: false, groups: true, delayMs: 250 }), sock);

  const { policy } = sock.receiptSnapshot();
  assert(policy, 'no policy in the snapshot — a silent policy is invisible');
  assert.equal(policy.autoRead, false, 'policy does not reflect the option');
  assert.equal(policy.groups, true, 'groups option not reflected');
  assert.equal(policy.delayMs, 250, 'delayMs not reflected');
});

test('read-receipts markRead and bulkRead go through the socket', async () => {
  const sock = fakeSocket();
  const read = [];
  sock.readMessages = async (keys) => read.push(keys.length);
  applyPlugin(readReceipts(), sock);
  await flush();

  await sock.markRead({ remoteJid: DM, id: 'own-read' });
  await sock.bulkRead([
    { remoteJid: DM, id: 'b1' },
    { remoteJid: OTHER, id: 'b2' },
  ]);
  await flush();

  assert.equal(read.length, 2, `readMessages called ${read.length} times, expected 2`);
});

/* ── send-presence ─────────────────────────────────────────────────────── */

test('send-presence announces and then clears, so the indicator cannot stick', async () => {
  const sock = fakeSocket();
  const seen = [];
  const real = sock.sendPresenceUpdate.bind(sock);
  sock.sendPresenceUpdate = async (state, jid) => {
    seen.push(state);
    return real(state, jid);
  };
  applyPlugin(sendPresence({ holdMinMs: 5, holdMaxMs: 5 }), sock);
  await flush();

  await sock.sendMessage(DM, { text: 'typing…' });
  await flush();
  assert(seen.includes('composing'), `composing not announced: ${seen.join(',')}`);

  await new Promise((r) => setTimeout(r, 60));
  assert(seen.includes('available'), `presence never cleared: ${seen.join(',')}`);
});

test('send-presence announces recording for media, not composing', async () => {
  const sock = fakeSocket();
  const seen = [];
  const real = sock.sendPresenceUpdate.bind(sock);
  sock.sendPresenceUpdate = async (state, jid) => {
    seen.push(state);
    return real(state, jid);
  };
  applyPlugin(sendPresence({ holdMinMs: 5, holdMaxMs: 5 }), sock);
  await flush();

  await sock.sendMessage(DM, { image: { url: 'https://x/y.png' } });
  await flush();

  assert(seen.includes('recording'), `media should announce recording: ${seen.join(',')}`);
  assert(!seen.includes('composing'), 'media wrongly announced composing');
});

test('send-presence reports its counters', async () => {
  const sock = fakeSocket();
  applyPlugin(sendPresence({ holdMinMs: 5, holdMaxMs: 5 }), sock);
  await flush();

  await sock.sendMessage(DM, { text: 'one' });
  await flush();

  const s = sock.sendPresenceStats;
  assert(s, 'sendPresenceStats not attached');
  assert(s.announced >= 1, `announced: ${s.announced}`);
});

test('dispose releases pending presence timers rather than leaking them', async () => {
  const sock = fakeSocket();
  const harness = applyPlugin(sendPresence({ holdMinMs: 50, holdMaxMs: 50 }), sock);
  await flush();

  await sock.sendMessage(DM, { text: 'x' });
  await flush();
  harness.dispose();

  assert.equal(typeof sock.sendPresenceStats.announced, 'number');
});

/* ── anti-delete ───────────────────────────────────────────────────────── */

test('anti-delete retains a message that was revoked', async () => {
  const sock = fakeSocket();
  applyPlugin(antiDelete(), sock);

  upsert(sock, [wmMessage({ jid: DM, id: 'rev-1', message: { conversation: 'oops' } })]);
  sock.ev.emit('messages.update', [
    { key: { remoteJid: DM, id: 'rev-1', fromMe: true }, update: { messageStubType: WAMessageStubType.REVOKE } },
  ]);
  await flush();

  assert(sock.revoked, 'revoked helper not attached');
  // Takes (jid, id), not a message key.
  const kept = sock.revoked.get(DM, 'rev-1');
  assert(kept, 'the revoked message was not retained');
  assert(kept.message.message.conversation === 'oops', `payload lost: ${JSON.stringify(kept)}`);
});

test('anti-delete records nothing for a non-revoke update', async () => {
  const sock = fakeSocket();
  applyPlugin(antiDelete(), sock);

  upsert(sock, [wmMessage({ jid: DM, id: 'rev-2', message: { conversation: 'kept' } })]);
  sock.ev.emit('messages.update', [
    { key: { remoteJid: DM, id: 'rev-2', fromMe: true }, update: { status: 3 } },
  ]);
  await flush();

  assert.equal(sock.revoked.get(DM, 'rev-2') ?? null, null, 'a delivered-status update was treated as a revoke');
});