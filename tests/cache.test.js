/**
 * TTL + LRU cache.
 *
 * Time is injected, so expiry is tested without a single real sleep.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { memoize, TtlCache } from '../dist/utils/cache.js';

/** A manual clock. */
function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test('get and set round-trip, missing keys are undefined', () => {
  const cache = new TtlCache();
  assert.equal(cache.get('a'), undefined);
  cache.set('a', 1);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.size, 1);
});

test('entries expire after the ttl', () => {
  const c = clock();
  const cache = new TtlCache({ ttlMs: 100, now: c.now });
  cache.set('a', 'v');

  c.advance(99);
  assert.equal(cache.get('a'), 'v', 'still live one tick before expiry');
  c.advance(1);
  assert.equal(cache.get('a'), undefined, 'expired exactly at the ttl');
  assert.equal(cache.size, 0);
});

test('ttl of zero means never expire', () => {
  const c = clock();
  const cache = new TtlCache({ ttlMs: 0, now: c.now });
  cache.set('a', 1);
  c.advance(10 ** 9);
  assert.equal(cache.get('a'), 1);
});

test('a per-entry ttl overrides the default', () => {
  const c = clock();
  const cache = new TtlCache({ ttlMs: 1000, now: c.now });
  cache.set('short', 1, 50);
  cache.set('long', 2);
  c.advance(100);
  assert.equal(cache.get('short'), undefined);
  assert.equal(cache.get('long'), 2);
});

test('maxSize evicts the least recently used', () => {
  const cache = new TtlCache({ maxSize: 2 });
  cache.set('a', 1);
  cache.set('b', 2);

  // Touch 'a' so 'b' becomes the oldest.
  assert.equal(cache.get('a'), 1);
  cache.set('c', 3);

  assert.equal(cache.size, 2);
  assert.equal(cache.has('b'), false, 'the LRU entry was evicted');
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 3);
});

test('an update to an existing key refreshes its recency', () => {
  const cache = new TtlCache({ maxSize: 2 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('a', 10); // 'a' is now newest
  cache.set('c', 3);
  assert.equal(cache.has('a'), true);
  assert.equal(cache.has('b'), false);
  assert.equal(cache.get('a'), 10);
});

test('has does not count as a hit and prunes expired entries', () => {
  const c = clock();
  const cache = new TtlCache({ ttlMs: 10, now: c.now });
  cache.set('a', 1);
  assert.equal(cache.has('a'), true);
  c.advance(10);
  assert.equal(cache.has('a'), false);
  assert.equal(cache.stats().hits, 0, 'has() is not a read');
});

test('prune removes only the expired entries and reports the count', () => {
  const c = clock();
  const cache = new TtlCache({ ttlMs: 10, now: c.now });
  cache.set('a', 1);
  cache.set('b', 2, 1000);
  c.advance(10);
  assert.equal(cache.prune(), 1);
  assert.equal(cache.size, 1);
  assert.equal(cache.has('b'), true);
});

test('setIfAbsent keeps an existing live value', () => {
  const cache = new TtlCache();
  assert.equal(cache.setIfAbsent('k', 'first'), 'first');
  assert.equal(cache.setIfAbsent('k', 'second'), 'first');
  assert.equal(cache.get('k'), 'first');
});

test('delete and clear remove entries', () => {
  const cache = new TtlCache();
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.delete('a'), true);
  assert.equal(cache.delete('a'), false);
  cache.clear();
  assert.equal(cache.size, 0);
});

test('stats track hits, misses, evictions and expirations', () => {
  const c = clock();
  const cache = new TtlCache({ ttlMs: 10, maxSize: 1, now: c.now });

  cache.get('nope'); // miss
  cache.set('a', 1);
  cache.get('a'); // hit
  c.advance(10);
  cache.get('a'); // miss + expiration
  cache.set('b', 2);
  cache.set('c', 3); // eviction (maxSize 1)

  const stats = cache.stats();
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 2);
  assert.equal(stats.expirations, 1);
  assert.equal(stats.evictions, 1);
  assert.equal(stats.size, 1);
});

test('keys and values reflect current contents', () => {
  const cache = new TtlCache();
  cache.set('a', 1);
  cache.set('b', 2);
  assert.deepEqual(cache.keys().sort(), ['a', 'b']);
  assert.deepEqual(cache.values().sort(), [1, 2]);
});

/* ── memoize ─────────────────────────────────────────────────────────── */

test('memoize computes once per key', () => {
  let calls = 0;
  const fn = memoize((n) => {
    calls += 1;
    return n * 2;
  });

  assert.equal(fn(2), 4);
  assert.equal(fn(2), 4);
  assert.equal(fn(3), 6);
  assert.equal(calls, 2);
  assert.equal(fn.cache.stats().hits, 1);
});

test('memoize caches a rejected promise only until it fails', async () => {
  let calls = 0;
  const fn = memoize(async (n) => {
    calls += 1;
    if (calls === 1) throw new Error('boom');
    return n;
  });

  await assert.rejects(fn(1));
  await assert.doesNotReject(fn(1), 'a transient failure must not be cached');
  assert.equal(calls, 2);
});

test('memoize honours a custom key function', () => {
  let calls = 0;
  const fn = memoize(
    (obj) => {
      calls += 1;
      return obj.id;
    },
    { key: (obj) => obj.id },
  );
  assert.equal(fn({ id: 7 }), 7);
  assert.equal(fn({ id: 7 }), 7, 'a different object with the same key reuses');
  assert.equal(calls, 1);
});
