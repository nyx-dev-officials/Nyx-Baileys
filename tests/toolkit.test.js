/**
 * Operational toolkit — the twenty functions plus the grouping helpers.
 *
 * These are mostly thin wrappers, so the tests are about the things a wrapper
 * can still get wrong: not perturbing what it wraps, cleaning up after itself,
 * not wedging state on a throw, and refusing to fabricate a value it was never
 * given.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EphemeralMemoryScavenger,
  PriorityMessageQueue,
  auditSessionIntegrity,
  attachOpsToolkit,
  attachStanzaInterceptor,
  extractPairingCode,
  forceSocketHeartbeat,
  getGroupInviteLink,
  rawDecryptMedia,
  sendContactCard,
  sendLocationPin,
  sendMediaWithCaption,
  sessionFingerprint,
  setChatArchive,
  setChatMute,
  setChatPin,
  setupGroupDeltaListener,
  starMessage,
  updateGroupDescription,
  updateGroupSubject,
} from '../dist/toolkit/index.js';

/* ── 1. stanza interceptor ─────────────────────────────────────────────── */

test('the interceptor observes frames without disturbing the send', () => {
  const sent = [];
  const sock = { ws: { send: (d) => { sent.push(d); return 'sent'; } } };

  const seen = [];
  const detach = attachStanzaInterceptor(sock, (n) => seen.push(n));

  assert.equal(sock.ws.send(Buffer.alloc(64)), 'sent', 'return value passes through');
  assert.equal(sock.ws.send('a string'), 'sent', 'non-buffer sends are untouched');
  assert.deepEqual(seen, [64], 'only buffer frames are reported');

  detach();
  assert.equal(sock.ws.send(Buffer.alloc(8)), 'sent');
  assert.equal(seen.length, 1, 'no further observations after detach');
});

test('the interceptor is a no-op without a ws', () => {
  const detach = attachStanzaInterceptor({});
  assert.doesNotThrow(() => detach());
});

/* ── 3. media decryptor reports its own absence ────────────────────────── */

test('rawDecryptMedia explains itself when the export is missing', async () => {
  await assert.rejects(
    () => rawDecryptMedia({}, { message: { imageMessage: { url: 'u' } } }),
    /decryptMediaMessage is not exported/,
    'must name the problem and the alternative, not fail with undefined',
  );
});

test('rawDecryptMedia rejects a node with no media', async () => {
  await assert.rejects(() => rawDecryptMedia({}, { message: {} }), /No media found/);
});

/* ── 4. integrity audit ────────────────────────────────────────────────── */

test('the auditor rejects a half-written session', async () => {
  assert.equal(await auditSessionIntegrity(null), false);
  assert.equal(await auditSessionIntegrity({ me: { id: 'a' } }), false, 'no noiseKey');
  assert.equal(await auditSessionIntegrity({ noiseKey: { private: 'x' } }), false, 'no me.id');
  assert.equal(
    await auditSessionIntegrity({ me: { id: 'a' }, noiseKey: { private: 'x' }, registered: false }),
    false,
    'registered false is a half-finished session',
  );
  assert.equal(
    await auditSessionIntegrity({ me: { id: 'a' }, noiseKey: { private: 'x' }, registered: true }),
    true,
  );
});

test('the fingerprint is stable and does not echo key material', () => {
  const creds = { me: { id: 'a@s.whatsapp.net' }, registered: true, noiseKey: { private: 'SUPERSECRET' } };
  const fp = sessionFingerprint(creds);
  assert.equal(fp, sessionFingerprint({ ...creds }), 'stable for identical input');
  assert.equal(fp.includes('SUPERSECRET'), false, 'must not leak key material');
  assert.notEqual(fp, sessionFingerprint({ ...creds, registered: false }));
});

/* ── 5. heartbeat ──────────────────────────────────────────────────────── */

test('the heartbeat clears itself on close', async () => {
  const handlers = {};
  const pings = [];
  const sock = {
    ws: { readyState: 1, ping: () => pings.push(Date.now()) },
    ev: {
      on: (e, fn) => { handlers[e] = fn; },
      off: (e) => { delete handlers[e]; },
    },
  };

  const stop = forceSocketHeartbeat(sock, 10);
  await new Promise((r) => setTimeout(r, 35));
  const before = pings.length;
  assert.ok(before > 0, 'pings while open');

  handlers['connection.update']?.({ connection: 'close' });
  await new Promise((r) => setTimeout(r, 35));
  assert.equal(pings.length, before, 'no pings after close');

  stop();
});

test('the heartbeat never touches a socket that is not OPEN', async () => {
  let pings = 0;
  const sock = {
    ws: { readyState: 3, ping: () => { pings += 1; } },
    ev: { on() {}, off() {} },
  };
  const stop = forceSocketHeartbeat(sock, 10);
  await new Promise((r) => setTimeout(r, 35));
  stop();
  assert.equal(pings, 0);
});

/* ── 6. priority queue ─────────────────────────────────────────────────── */

test('higher priority drains first', async () => {
  const order = [];
  const sock = { sendMessage: async (_jid, content) => { order.push(content); } };

  const q = new PriorityMessageQueue();
  q.enqueue('a', 'low', 1);
  q.enqueue('a', 'high', 10);
  q.enqueue('a', 'mid', 5);

  await q.processQueue(sock, 0);
  assert.deepEqual(order, ['high', 'mid', 'low']);
});

test('a throw mid-drain does not wedge the queue shut', async () => {
  // The bug this guards: a plain `isProcessing = false` at the end of the loop
  // is skipped when a send rejects, and the queue is then permanently dead.
  let calls = 0;
  const sock = {
    sendMessage: async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
    },
  };

  const q = new PriorityMessageQueue();
  q.enqueue('a', 'one', 1);
  q.enqueue('a', 'two', 1);
  await assert.rejects(() => q.processQueue(sock, 0), /boom/);

  assert.equal(q.size, 1, 'the untried item survives');
  q.enqueue('a', 'three', 1);
  await q.processQueue(sock, 0);
  assert.ok(calls > 1, 'the queue still processes after a failure');
});

/* ── 2. pairing extractor ──────────────────────────────────────────────── */

test('the pairing extractor waits for a qr and then cleans up', async () => {
  const handlers = {};
  const sock = {
    requestPairingCode: async (phone) => `CODE-${phone}`,
    ev: {
      on: (e, fn) => { handlers[e] = fn; },
      off: (e) => { delete handlers[e]; },
    },
  };

  const p = extractPairingCode(sock, '628123');
  await Promise.resolve();
  handlers['connection.update']?.({ qr: 'ignored-until-present' });
  assert.equal(await p, 'CODE-628123');
  assert.equal(handlers['connection.update'], undefined, 'listener removed after resolving');
});

test('the pairing extractor rejects when the socket cannot request a code', async () => {
  await assert.rejects(() => extractPairingCode({}, '628123'), /unavailable/);
});

/* ── 8. group delta listener ───────────────────────────────────────────── */

test('the delta listener reports each change kind and detaches', () => {
  const handlers = {};
  const sock = {
    ev: { on: (e, fn) => { handlers[e] = fn; }, off: (e) => { delete handlers[e]; } },
  };

  const seen = [];
  const detach = setupGroupDeltaListener(sock, (e) => seen.push(e));

  handlers['groups.update']([{ subject: 'new', desc: 'd', participants: [] }]);
  assert.deepEqual(seen, ['SUBJECT_CHANGE', 'DESCRIPTION_CHANGE', 'PARTICIPANTS_CHANGE']);

  seen.length = 0;
  detach();
  assert.equal(handlers['groups.update'], undefined, 'detached');
});

/* ── 10. scavenger ─────────────────────────────────────────────────────── */

test('the scavenger clears a tracked timer exactly once', async () => {
  const s = new EphemeralMemoryScavenger();
  let fired = false;
  s.track('a', setTimeout(() => { fired = true; }, 20));
  assert.equal(s.size, 1);

  s.clear('a');
  assert.equal(s.size, 0);
  s.clear('a'); // idempotent

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(fired, false, 'the handle was actually cleared, not just dropped');
});

/* ── Part 2 ────────────────────────────────────────────────────────────── */

test('a vCard carries a waid the phone can save', async () => {
  let sent;
  const sock = { sendMessage: async (_j, c) => { sent = c; } };
  await sendContactCard(sock, 'a@s.whatsapp.net', 'Bian', '628123');
  assert.equal(sent.contacts.displayName, 'Bian');
  const vcard = sent.contacts.contacts[0].vcard;
  assert.match(vcard, /^BEGIN:VCARD/);
  assert.match(vcard, /waid=628123/);
  assert.match(vcard, /END:VCARD$/);
});

test('a location pin carries coordinates and a name', async () => {
  let sent;
  await sendLocationPin({ sendMessage: async (_j, c) => { sent = c; } }, 'a@s', -6.2, 106.8, 'Jakarta');
  assert.equal(sent.location.degreesLatitude, -6.2);
  assert.equal(sent.location.name, 'Jakarta');
});

test('group subject and description pass straight through', async () => {
  const calls = [];
  const sock = {
    groupUpdateSubject: async (...a) => calls.push(['subject', ...a]),
    groupUpdateDescription: async (...a) => calls.push(['desc', ...a]),
  };
  await updateGroupSubject(sock, 'g@g.us', 'New Title');
  await updateGroupDescription(sock, 'g@g.us', 'New Description');
  assert.deepEqual(calls, [
    ['subject', 'g@g.us', 'New Title'],
    ['desc', 'g@g.us', 'New Description'],
  ]);
});

test('the invite link refuses to fabricate /undefined', async () => {
  await assert.rejects(() => getGroupInviteLink({ groupInviteCode: async () => undefined }, 'g@g.us'), /no invite code/);
  assert.equal(
    await getGroupInviteLink({ groupInviteCode: async () => 'ABC' }, 'g@g.us'),
    'https://chat.whatsapp.com/ABC',
  );
});

test('mute sends an absolute expiry, and unmute sends null', async () => {
  const calls = [];
  const sock = { chatModify: async (m, j) => calls.push([m, j]) };
  await setChatMute(sock, 'a@s', 60_000);
  assert.ok(calls[0][0].mute > Date.now(), 'timestamp, not duration');
  await setChatMute(sock, 'a@s', null);
  assert.equal(calls[1][0].mute, null);
});

test('archive and pin each send a single union member', async () => {
  const calls = [];
  const sock = { chatModify: async (m) => calls.push(m) };
  await setChatArchive(sock, 'a@s', true);
  await setChatPin(sock, 'a@s', true);
  assert.deepEqual(Object.keys(calls[0]).sort(), ['archive', 'lastMessages']);
  assert.deepEqual(Object.keys(calls[1]), ['pin'], 'pin alone — the union has no extras');
});

test('star routes through chatModify, not sendMessage', async () => {
  const mods = [];
  let sends = 0;
  const sock = { chatModify: async (m) => mods.push(m), sendMessage: async () => { sends += 1; } };
  await starMessage(sock, 'a@s', { id: 'M1', fromMe: true }, true);
  assert.equal(mods[0].star.star, true);
  assert.deepEqual(mods[0].star.messages, [{ id: 'M1', fromMe: true }]);
  assert.equal(sends, 0, 'sendMessage would do nothing at all');
});

test('media with a caption puts the buffer as the media value', async () => {
  // rc14's getStream checks Buffer.isBuffer(item) first, then 'stream' in item,
  // then item.url. `{ image: { buffer } }` matches none and dies on undefined.url.
  let sent;
  const sock = { sendMessage: async (_j, c) => { sent = c; } };
  const buf = Buffer.from('bytes');

  await sendMediaWithCaption(sock, 'a@s', buf, 'cap', 'image');
  assert.equal(Buffer.isBuffer(sent.image), true, 'buffer must be the value, not wrapped');

  await sendMediaWithCaption(sock, 'a@s', buf, 'cap', 'document', 'text/plain', 'a.txt');
  assert.equal(sent.mimetype, 'text/plain');
  assert.equal(sent.fileName, 'a.txt');
  assert.equal(sent.caption, 'cap');
});

/* ── grouping ──────────────────────────────────────────────────────────── */

test('the toolkit attaches and detaches cleanly', () => {
  const handlers = {};
  const sock = {
    ws: { send: () => {}, readyState: 1, ping: () => {} },
    ev: { on: (e, fn) => { handlers[e] = fn; }, off: (e) => { delete handlers[e]; } },
  };

  const detach = attachOpsToolkit(sock);
  assert.ok(handlers['connection.update'], 'heartbeat listener attached');
  assert.doesNotThrow(() => detach());
  assert.equal(handlers['connection.update'], undefined);
});