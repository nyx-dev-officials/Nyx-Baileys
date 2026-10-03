/**
 * Conversation state.
 *
 * The leak is the feature under test: a store that only ever grows is a bot
 * that dies on a small VPS after a week, so TTL, the size ceiling and
 * least-recently-used eviction are all asserted on real entries.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConversationStore } from '../dist/core/conversation.js';

import { sleep } from './helpers.js';

/* ── basics ──────────────────────────────────────────────────────────── */

test('state round-trips and is created on demand', () => {
  const conversations = new ConversationStore();

  assert.equal(conversations.get('a'), undefined);
  conversations.set('a', { step: 1 });
  assert.deepEqual(conversations.get('a'), { step: 1 });
  assert.equal(conversations.has('a'), true);
  assert.equal(conversations.size, 1);
});

test('a factory runs only when there is no live entry', () => {
  const conversations = new ConversationStore();
  let calls = 0;
  const make = () => {
    calls += 1;
    return { fresh: true };
  };

  // Nothing was stored, so the factory legitimately runs again.
  conversations.get('a', make);
  assert.equal(calls, 1);
  conversations.get('a', make);
  assert.equal(calls, 2, 'with no stored entry the factory must run again');

  conversations.set('a', { stored: true });
  conversations.get('a', make);
  assert.equal(calls, 2, 'the factory must not run over a live entry');
});

test('a factory result is not saved unless the caller writes it back', () => {
  const conversations = new ConversationStore();
  const first = conversations.get('a', () => ({ n: 0 }));
  first.n = 5;

  assert.equal(conversations.has('a'), false, 'a read must not resurrect the entry');
  assert.deepEqual(conversations.get('a', () => ({ n: 0 })), { n: 0 });
});

test('peek reads without creating or touching', () => {
  const conversations = new ConversationStore();
  assert.deepEqual(conversations.peek('a', 'fallback'), 'fallback');
  assert.equal(conversations.size, 0);

  conversations.set('a', 1);
  assert.equal(conversations.peek('a', 'fallback'), 1);
});

test('patch merges and stores a new object', () => {
  const conversations = new ConversationStore();
  conversations.set('a', { step: 1, name: 'ada' });

  const before = conversations.get('a');
  const merged = conversations.patch('a', { step: 2 });

  assert.deepEqual(merged, { step: 2, name: 'ada' });
  assert.notEqual(before, merged, 'the previous state must not be mutated in place');
  assert.deepEqual(before, { step: 1, name: 'ada' });

  assert.deepEqual(conversations.patch('fresh', { step: 0 }), { step: 0 }, 'patch creates');
});

test('update runs the updater and stores the result', () => {
  const conversations = new ConversationStore();
  const next = (cur) => ({ step: (cur?.step ?? 0) + 1 });

  assert.deepEqual(conversations.update('a', next), { step: 1 });
  assert.deepEqual(conversations.update('a', next), { step: 2 });
  assert.deepEqual(conversations.get('a'), { step: 2 });
});

test('increment counts without the caller writing the arithmetic', () => {
  const conversations = new ConversationStore();
  assert.equal(conversations.increment('a', 'messages'), 1);
  assert.equal(conversations.increment('a', 'messages'), 2);
  assert.equal(conversations.increment('a', 'messages', 5), 7);
  assert.equal(conversations.get('a').messages, 7);
});

test('delete removes an entry and reports whether it was there', () => {
  const conversations = new ConversationStore();
  conversations.set('a', 1);
  assert.equal(conversations.delete('a'), true);
  assert.equal(conversations.delete('a'), false);
  assert.equal(conversations.size, 0);
});

test('clearAll empties the store', () => {
  const conversations = new ConversationStore();
  conversations.set('a', 1);
  conversations.set('b', 2);
  conversations.clearAll();
  assert.equal(conversations.size, 0);
});

/* ── expiry ──────────────────────────────────────────────────────────── */

test('an entry expires once it has been idle past the ttl', async () => {
  const conversations = new ConversationStore({ ttlMs: 25 });
  conversations.set('a', { step: 1 });
  assert.equal(conversations.has('a'), true);

  await sleep(50);
  assert.equal(conversations.has('a'), false);
  assert.equal(conversations.get('a'), undefined);
  assert.equal(conversations.size, 0, 'looking at an expired entry must drop it, not leak it');
});

test('reading an entry keeps it alive, querying does not', async () => {
  const conversations = new ConversationStore({ ttlMs: 60 });
  conversations.set('a', { step: 1 });

  for (let i = 0; i < 4; i += 1) {
    await sleep(30);
    assert.deepEqual(conversations.get('a'), { step: 1 }, `entry expired at touch ${i}`);
  }

  // `has` is a query and must not extend the life of a conversation, or a
  // polling loop would keep every entry alive forever.
  const polling = new ConversationStore({ ttlMs: 40 });
  polling.set('b', 1);
  for (let i = 0; i < 4; i += 1) {
    await sleep(20);
    polling.has('b');
  }
  assert.equal(polling.has('b'), false, 'polling must not keep the entry alive');
});

test('sweep drops every expired entry and counts them', async () => {
  const conversations = new ConversationStore({ ttlMs: 25 });
  conversations.set('old', 1);
  await sleep(50);
  conversations.set('new', 2);

  assert.equal(conversations.sweep(), 1);
  assert.equal(conversations.size, 1);
  assert.equal(conversations.get('new'), 2);
  assert.equal(conversations.sweep(), 0, 'a live entry is not swept');
});

test('clear reports presence, even for an expired entry', async () => {
  const conversations = new ConversationStore({ ttlMs: 20 });
  conversations.set('a', 1);
  await sleep(40);

  assert.equal(conversations.clear('a'), true, 'it was present, just expired');
  assert.equal(conversations.size, 0);
  assert.equal(conversations.clear('a'), false, 'nothing left to clear');
});

/* ── bounds ──────────────────────────────────────────────────────────── */

test('the size ceiling evicts the least recently touched entry', async () => {
  const evicted = [];
  const conversations = new ConversationStore({ maxEntries: 3, onEvict: (key) => evicted.push(key) });

  conversations.set('a', 1);
  conversations.set('b', 2);
  conversations.set('c', 3);
  assert.equal(conversations.size, 3);

  // Touch 'a' so it is no longer the oldest by access time. 'b' was inserted
  // after 'a' but has not been read, so 'b' is the one that should go. The
  // sleep matters: touchedAt has millisecond resolution, so a touch in the same
  // tick as the write would not register as newer.
  await sleep(5);
  conversations.get('a');
  await sleep(5);
  conversations.set('d', 4);

  assert.equal(conversations.size, 3, 'the ceiling was not enforced');
  assert.deepEqual(evicted, ['b']);
  assert.equal(conversations.has('b'), false);
  assert.equal(conversations.has('a'), true);
  assert.equal(conversations.has('d'), true);
});

test('the ceiling holds under sustained writes', () => {
  const conversations = new ConversationStore({ maxEntries: 10 });
  for (let i = 0; i < 1000; i += 1) conversations.set(`user-${i}`, { i });
  assert.equal(conversations.size, 10);
  assert.equal(conversations.get('user-999').i, 999, 'the newest entry must survive');
});

test('an eviction hook that throws does not break the store', () => {
  const conversations = new ConversationStore({
    maxEntries: 1,
    onEvict: () => {
      throw new Error('hook exploded');
    },
  });
  conversations.set('a', 1);
  assert.doesNotThrow(() => conversations.set('b', 2));
  assert.equal(conversations.size, 1);
  assert.equal(conversations.has('b'), true);
});

/* ── inspection ──────────────────────────────────────────────────────── */

test('keys and entries are ordered least-recently-touched first', async () => {
  const conversations = new ConversationStore();
  conversations.set('a', 1);
  await sleep(5);
  conversations.set('b', 2);
  await sleep(5);
  conversations.get('a');

  assert.deepEqual(conversations.keys(), ['b', 'a']);

  const entries = conversations.entries();
  assert.deepEqual(entries.map((e) => e.key), ['b', 'a']);
  assert.equal(entries[0].key, 'b');
  assert.equal(typeof entries[0].since, 'number');
  assert.equal(typeof entries[0].touchedAt, 'number');
  assert.equal(typeof entries[0].writes, 'number');
});

test('writes count the first write too', () => {
  const conversations = new ConversationStore();
  conversations.set('a', 1);
  conversations.set('a', 2);
  conversations.set('a', 3);
  assert.equal(conversations.entries()[0].writes, 3);
});

test('stats report the bounds and the counters', async () => {
  const conversations = new ConversationStore({ ttlMs: 20, maxEntries: 2 });
  conversations.set('a', 1);
  await sleep(40);
  conversations.sweep();
  conversations.set('b', 1);
  conversations.set('c', 1);
  await sleep(5);
  conversations.set('d', 1);

  const stats = conversations.stats();
  assert.deepEqual(Object.keys(stats).sort(), [
    'evicted',
    'expired',
    'maxEntries',
    'oldestTouchedAt',
    'size',
    'ttlMs',
  ]);
  assert.equal(stats.size, 2);
  assert.equal(stats.maxEntries, 2);
  assert.equal(stats.ttlMs, 20);
  assert.equal(stats.expired, 1);
  assert.equal(stats.evicted, 1);
  assert.ok(stats.oldestTouchedAt > 0);
});

test('a jid-like key is just a key', () => {
  const conversations = new ConversationStore();
  conversations.set('__proto__', 'x');
  conversations.set('constructor', 'y');

  assert.equal(conversations.get('__proto__'), 'x');
  assert.equal(conversations.get('constructor'), 'y');
  assert.equal({}.x, undefined);
});

test('the default ttl and ceiling are the documented ones', () => {
  const conversations = new ConversationStore();
  assert.equal(conversations.ttlMs, 600_000);
  assert.equal(conversations.stats().maxEntries, 5_000);
});
