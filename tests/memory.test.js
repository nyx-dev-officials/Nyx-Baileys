/**
 * Memory GC.
 *
 * Three bounded tables (per-chat history, status timestamps, media blobs) plus
 * the `store` facade the plugins share. The eviction order and the "only when
 * nothing holds it" rule are asserted on real values, and `stats()` is checked
 * for exact shape rather than just presence.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { memoryGc } from '../dist/plugins/memory.js';

import { applyPlugin, fakeSocket, sleep, upsert, wmMessage } from './helpers.js';

const CHAT = 'a@s.whatsapp.net';
const OTHER = 'b@s.whatsapp.net';

function rig(options = {}) {
  const sock = fakeSocket();
  const harness = applyPlugin(memoryGc({ intervalMs: 100_000, ...options }), sock);
  return { sock, store: sock.store, ...harness };
}

const chat = (n) => `${CHAT}`;
const msgId = (n) => `m${n}`;
const texts = (from, to) =>
  Array.from({ length: to - from + 1 }, (_, i) => wmMessage({ id: msgId(from + i), jid: chat(0) }));

/* ── history per chat ────────────────────────────────────────────────── */

test('history per chat is capped, keeping the newest ids', () => {
  const { sock, store } = rig({ keepMessagesPerChat: 3 });

  upsert(sock, texts(1, 5));

  const ids = store.history.get(chat(0));
  assert.equal(ids.length, 3, 'the cap was not enforced');
  assert.deepEqual(ids, ['m3', 'm4', 'm5'], 'the newest ids survive, oldest evicted first');
});

test('each chat is capped independently', () => {
  const { sock, store } = rig({ keepMessagesPerChat: 2 });

  upsert(sock, [
    wmMessage({ id: 'a1', jid: CHAT }),
    wmMessage({ id: 'b1', jid: OTHER }),
    wmMessage({ id: 'a2', jid: CHAT }),
    wmMessage({ id: 'b2', jid: OTHER }),
    wmMessage({ id: 'a3', jid: CHAT }),
  ]);

  assert.deepEqual(store.history.get(CHAT), ['a2', 'a3']);
  assert.deepEqual(store.history.get(OTHER), ['b1', 'b2']);
  assert.equal(store.history.size, 2);
});

test('a cap of 1 keeps exactly the latest message', () => {
  const { sock, store } = rig({ keepMessagesPerChat: 1 });
  upsert(sock, texts(1, 3));
  assert.deepEqual(store.history.get(chat(0)), ['m3']);
});

test('a large cap keeps everything', () => {
  const { sock, store } = rig({ keepMessagesPerChat: 1000 });
  upsert(sock, texts(1, 50));
  assert.equal(store.history.get(chat(0)).length, 50);
});

test('messages without a jid or an id are ignored', () => {
  const { sock, store } = rig({ keepMessagesPerChat: 5 });

  upsert(sock, [
    wmMessage({ id: 'ok', jid: CHAT }),
    { key: { id: 'no-jid' }, message: { conversation: 'x' } },
    { key: { remoteJid: CHAT }, message: { conversation: 'x' } },
    { message: { conversation: 'x' } },
  ]);

  assert.deepEqual(store.history.get(CHAT), ['ok']);
  assert.equal(store.history.size, 1);
});

test('an upsert with no messages array does not throw', () => {
  const { sock } = rig();
  assert.doesNotThrow(() => sock.ev.emit('messages.upsert', {}));
  assert.doesNotThrow(() => sock.ev.emit('messages.upsert', { messages: [] }));
});

test('history is a live map keyed by chat jid', () => {
  const { sock, store } = rig();
  assert.ok(store.history instanceof Map);
  assert.equal(store.history.size, 0);

  upsert(sock, [wmMessage({ jid: CHAT, id: 'x' })]);
  assert.equal(store.history.get(CHAT), store.history.get(CHAT), 'reads are stable');
  assert.deepEqual([...store.history.keys()], [CHAT]);
});

/* ── statuses ────────────────────────────────────────────────────────── */

test('status posts are counted separately and capped', () => {
  const { sock, store } = rig({ keepStatuses: 2 });

  upsert(sock, [
    wmMessage({ id: 's1', jid: CHAT, message: { statusNotificationMessage: { type: 1 } }, messageTimestamp: 111 }),
    wmMessage({ id: 's2', jid: CHAT, message: { statusNotificationMessage: { type: 1 } }, messageTimestamp: 222 }),
    wmMessage({ id: 's3', jid: CHAT, message: { statusNotificationMessage: { type: 1 } }, messageTimestamp: 333 }),
  ]);

  assert.equal(store.statuses.length, 2);
  assert.deepEqual(store.statuses, [222, 333], 'the newest two timestamps survive');
  assert.equal(store.stats().statuses, 2);
});

test('ordinary chat messages do not land in the status counter', () => {
  const { sock, store } = rig();

  upsert(sock, [
    wmMessage({ id: 'c1', jid: CHAT, message: { conversation: 'hi' } }),
    wmMessage({ id: 'c2', jid: CHAT, message: { extendedTextMessage: { text: 'yo' } } }),
    wmMessage({ id: 'c3', jid: CHAT, message: { imageMessage: { mimetype: 'image/jpeg' } } }),
  ]);

  assert.equal(store.statuses.length, 0);
  assert.equal(store.history.get(CHAT).length, 3, 'but they are still chat history');
});

test('every rc14 status-bearing field name is recognised', () => {
  const { sock, store } = rig({ keepMessagesPerChat: 100, keepStatuses: 100 });

  const fields = [
    'statusMentionMessage',
    'statusAddYours',
    'statusNotificationMessage',
    'statusQuestionAnswerMessage',
    'statusQuotedMessage',
    'statusStickerInteractionMessage',
  ];
  upsert(
    sock,
    fields.map((f, i) => wmMessage({ id: `s${i}`, jid: CHAT, message: { [f]: {} }, messageTimestamp: i })),
  );

  assert.equal(store.statuses.length, fields.length, 'all lowercase status* fields count');
});

/* ── media ───────────────────────────────────────────────────────────── */

test('media blobs are evicted oldest-first once past the cap', async () => {
  const { store } = rig({ keepMedia: 2 });

  store.put('k1', Buffer.from('aaaa'));
  await sleep(3);
  store.put('k2', Buffer.from('bbbbbb'));
  await sleep(3);
  store.put('k3', Buffer.from('cccc'));

  assert.equal(store.media.size, 2, 'the keepMedia ceiling was not enforced');
  assert.equal(store.media.has('k1'), false, 'the oldest blob should have been evicted');
  assert.deepEqual([...store.media.keys()], ['k2', 'k3']);
});

test('an evicted blob keeps its bytes, only the map entry goes', async () => {
  const { store } = rig({ keepMedia: 1 });

  store.put('keep', Buffer.from('hello'));
  const bytes = Buffer.from('world');
  store.put('drop', bytes);
  await sleep(3);
  store.put('newest', Buffer.from('!'));

  assert.equal(store.media.has('drop'), false);
  assert.equal(bytes.toString(), 'world', 'the caller still owns its buffer');
  assert.equal(store.take('newest').toString(), '!');
});

test('media below the cap is never touched', () => {
  const { store } = rig({ keepMedia: 10 });
  for (let i = 0; i < 10; i += 1) store.put(`k${i}`, Buffer.from('x'));
  assert.equal(store.media.size, 10);
  assert.equal(store.media.get('k0').at <= store.media.get('k9').at, true);
});

/*
 * ---------------------------------------------------------------------------
 * KNOWN BUG — src/plugins/memory.ts:76
 *
 *     if (blob.ref.byteLength === 0) continue; // already released
 *
 * The skip is meant to avoid re-releasing a buffer, but it never removes the
 * *map entry*, so a zero-length blob is pinned forever: every later sweep walks
 * past it and `media.size` climbs without bound. The documented contract is
 * "Media entries kept in the blob table" (`keepMedia`), and `take()` on such a
 * blob still returns a buffer — so nothing had actually been released either.
 *
 * `put(key, Buffer.alloc(0))` is reachable from any caller of the store facade.
 * ---------------------------------------------------------------------------
 */
test('BUG: a released (zero-length) blob is still evicted by the keepMedia ceiling', () => {
  const { store } = rig({ keepMedia: 2 });

  store.put('empty-1', Buffer.alloc(0));
  store.put('empty-2', Buffer.alloc(0));
  store.put('empty-3', Buffer.alloc(0));
  store.put('empty-4', Buffer.alloc(0));
  store.put('real', Buffer.from('payload'));

  assert.ok(
    store.media.size <= 2,
    `keepMedia=2 was exceeded: media.size=${store.media.size} (${[...store.media.keys()].join(', ')})`,
  );
  assert.equal(store.media.has('real'), true, 'the real blob was evicted instead');
});

test('take() removes and returns the buffer exactly once', () => {
  const { store } = rig();
  const buf = Buffer.from('payload');
  store.put('k', buf);

  assert.equal(store.take('k'), buf, 'the same Buffer instance is handed back');
  assert.equal(store.media.size, 0);
  assert.equal(store.take('k'), undefined, 'a second take finds nothing');
  assert.equal(store.take('never-existed'), undefined);
});

test('blob metadata records size and insertion time', async () => {
  const { store } = rig();
  await sleep(2);
  const before = Date.now();
  store.put('k', Buffer.from('abcde'));

  const blob = store.media.get('k');
  assert.equal(blob.key, 'k');
  assert.equal(blob.size, 5);
  assert.equal(blob.ref.toString(), 'abcde');
  assert.ok(blob.at >= before);
});

/* ── stats ───────────────────────────────────────────────────────────── */

test('stats() has exactly the documented shape', () => {
  const { sock, store } = rig({ keepMessagesPerChat: 10, keepStatuses: 10, keepMedia: 10 });

  upsert(sock, [
    wmMessage({ id: 'c1', jid: CHAT }),
    wmMessage({ id: 'c2', jid: OTHER }),
    wmMessage({ id: 's1', jid: CHAT, message: { statusNotificationMessage: {} } }),
  ]);
  store.put('m1', Buffer.from('x'));

  const stats = store.stats();
  assert.deepEqual(Object.keys(stats).sort(), ['chats', 'heapMb', 'media', 'statuses']);
  assert.equal(stats.chats, 2);
  assert.equal(stats.media, 1);
  assert.equal(stats.statuses, 1);
  assert.equal(typeof stats.heapMb, 'number');
  assert.ok(Number.isFinite(stats.heapMb));
  assert.ok(stats.heapMb > 0, 'the process is definitely using some heap');
});

test('stats() starts at zero on a fresh socket', () => {
  const { store } = rig();
  assert.deepEqual(
    { chats: store.stats().chats, media: store.stats().media, statuses: store.stats().statuses },
    { chats: 0, media: 0, statuses: 0 },
  );
});

test('sweep() is exposed and is safe to call at any time', () => {
  const { store } = rig({ keepMessagesPerChat: 2 });
  assert.equal(typeof store.sweep, 'function');
  assert.doesNotThrow(() => store.sweep());
  assert.doesNotThrow(() => store.sweep());
});

/* ── wiring ──────────────────────────────────────────────────────────── */

test('store is attached as a non-enumerable property', () => {
  const { sock } = rig();
  assert.ok(sock.store, 'store exists');
  assert.equal(Object.keys(sock).includes('store'), false, 'store must not be enumerable');
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(sock, 'store').enumerable,
    false,
  );
});

test('the history and media tables are the very maps the store exposes', () => {
  const { sock, store } = rig({ keepMessagesPerChat: 2 });
  upsert(sock, texts(1, 4));
  store.put('k', Buffer.from('x'));

  assert.equal(store.history.get(chat(0)).length, 2);
  assert.equal(store.stats().chats, sock.store.history.size);
  assert.equal(store.media.size, sock.store.media.size);
  assert.equal(store.statuses, sock.store.statuses);
});

test('the sweep interval runs on its own, and dispose() stops it', async () => {
  const { store, dispose } = rig({ intervalMs: 5, keepMessagesPerChat: 2 });

  // Written straight into the live map, so only the *timer* can trim this —
  // no upsert, no put, no explicit sweep() call.
  store.history.set(CHAT, ['a', 'b', 'c', 'd', 'e']);
  await sleep(40);
  assert.deepEqual(store.history.get(CHAT), ['d', 'e'], 'the interval sweep did not run');

  // With the disposer run, nothing should trim it any more.
  dispose();
  store.history.set(CHAT, ['x', 'y', 'z']);
  await sleep(40);
  assert.deepEqual(store.history.get(CHAT), ['x', 'y', 'z'], 'the interval outlived dispose()');
});