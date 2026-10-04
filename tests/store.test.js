/**
 * Persistent JSON store.
 *
 * The properties worth pinning are the durability ones: a debounce that
 * actually coalesces, an atomic write that cannot truncate the previous
 * document, and a corrupt file that is reported rather than silently reset.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CorruptStoreError, JsonStore, openStore } from '../dist/core/store.js';

import { sleep } from './helpers.js';

const dir = () => mkdtemp(join(tmpdir(), 'nyx-store-'));

async function scratch(options = {}) {
  const base = await dir();
  const file = join(base, 'db.json');
  const store = await JsonStore.open({ file, autosaveMs: 0, ...options });
  return { base, file, store, cleanup: () => rm(base, { recursive: true, force: true }) };
}

/* ── basics ──────────────────────────────────────────────────────────── */

test('a missing file is not an error — the defaults become the document', async () => {
  const { file, store, cleanup } = await scratch({ defaults: { level: 1 } });
  assert.deepEqual(store.data, { level: 1 });
  assert.equal(store.get('level'), 1);
  await cleanup();
  assert.ok(file);
});

test('an existing file is loaded and defaults fill only the gaps', async () => {
  const base = await dir();
  const file = join(base, 'db.json');
  await writeFile(file, JSON.stringify({ a: 1 }), 'utf8');

  const store = await JsonStore.open({ file, defaults: { a: 99, b: 2 } });
  assert.deepEqual(store.data, { a: 1, b: 2 }, 'the file must win over the default');
  await rm(base, { recursive: true, force: true });
});

test('set / get / has / delete round-trip', async () => {
  const { store, cleanup } = await scratch();

  store.set('user:1', { xp: 10 });
  assert.equal(store.has('user:1'), true);
  assert.deepEqual(store.get('user:1'), { xp: 10 });
  assert.equal(store.size, 1);
  assert.deepEqual(store.keys(), ['user:1']);

  assert.equal(store.delete('user:1'), true);
  assert.equal(store.delete('user:1'), false, 'a second delete reports nothing removed');
  assert.equal(store.get('user:1'), undefined);

  await cleanup();
});

test('a key that looks like a prototype member is still just a key', async () => {
  const { store, cleanup } = await scratch();

  store.set('constructor', 'shadowed');
  store.set('__proto__', { polluted: true });
  store.set('toString', 'also');

  assert.equal(store.get('constructor'), 'shadowed');
  assert.equal(store.get('toString'), 'also');
  assert.equal(store.has('__proto__'), true);
  assert.equal({}.polluted, undefined, 'Object.prototype must be untouched');

  await cleanup();
});

test('ensure seeds once and then reads back', async () => {
  const { store, cleanup } = await scratch();

  const first = store.ensure('counter', 0);
  assert.equal(first, 0);
  store.set('counter', 7);
  assert.equal(store.ensure('counter', 0), 7, 'the fallback must not overwrite');
  assert.equal(store.size, 1);

  await cleanup();
});

test('update derives from the current value and returns it', async () => {
  const { store, cleanup } = await scratch();

  assert.equal(store.update('n', (cur) => (cur ?? 0) + 1), 1);
  assert.equal(store.update('n', (cur) => (cur ?? 0) + 1), 2);
  assert.equal(store.get('n'), 2);

  await cleanup();
});

test('an updater that throws leaves the document untouched', async () => {
  const { store, cleanup } = await scratch();
  store.set('n', 5);
  assert.throws(() => store.update('n', () => {
    throw new Error('boom');
  }), /boom/);
  assert.equal(store.get('n'), 5);
  await cleanup();
});

test('deletePrefix removes a namespace and reports the count', async () => {
  const { store, cleanup } = await scratch();

  store.set('user:1', 1).set('user:2', 2).set('other', 3);
  assert.equal(store.deletePrefix('user:'), 2);
  assert.deepEqual(store.keys(), ['other']);
  assert.equal(store.deletePrefix('user:'), 0);

  await cleanup();
});

test('clear empties the document', async () => {
  const { store, cleanup } = await scratch();
  store.set('a', 1).set('b', 2);
  store.clear();
  assert.equal(store.size, 0);
  await cleanup();
});

test('transact commits the draft and returns the callback result', async () => {
  const { store, cleanup } = await scratch();
  store.set('keep', 'yes');

  const result = store.transact((doc) => {
    doc.added = true;
    return 'done';
  });

  assert.equal(result, 'done');
  assert.equal(store.get('added'), true);
  assert.equal(store.get('keep'), 'yes');

  await cleanup();
});

test('setting a key to the value it already holds schedules nothing', async () => {
  const { store, cleanup } = await scratch({ autosaveMs: 20 });
  const value = { same: true };
  store.set('k', value);
  await store.flush();
  const savesAfterFirst = store.stats().saves;

  store.set('k', value);
  assert.equal(store.pending, false, 'an identical write must not queue a save');
  assert.equal(store.stats().saves, savesAfterFirst);

  await cleanup();
});

/* ── durability ──────────────────────────────────────────────────────── */

test('flush writes the document and it reloads', async () => {
  const { file, store, cleanup } = await scratch();
  store.set('answer', 42);
  await store.flush();

  const reopened = await JsonStore.open({ file });
  assert.equal(reopened.get('answer'), 42);

  await cleanup();
});

test('the write is atomic — no temp file is left behind', async () => {
  const base = await dir();
  const file = join(base, 'db.json');
  const store = await JsonStore.open({ file, autosaveMs: 0 });
  store.set('a', 1);
  await store.flush();

  const { readdir } = await import('node:fs/promises');
  const files = await readdir(base);
  assert.deepEqual(files, ['db.json'], `unexpected files: ${files.join(', ')}`);
  await rm(base, { recursive: true, force: true });
});

test('the previous document survives a failed write', async () => {
  const base = await dir();
  const file = join(base, 'db.json');
  const store = await JsonStore.open({ file, autosaveMs: 0 });
  store.set('keep', 'original');
  await store.flush();

  // A value JSON cannot serialise turns the write into a failure *after* the
  // target already holds a good document. Rename-based commit means the good
  // document is still there.
  const cyclic = {};
  cyclic.self = cyclic;
  store.set('bad', cyclic);
  await assert.rejects(() => store.flush());

  const onDisk = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(onDisk.keep, 'original', 'the last good document must be intact');
  assert.equal(onDisk.bad, undefined, 'the failed write must not have landed');

  await rm(base, { recursive: true, force: true });
});

test('a burst of mutations coalesces into one write', async () => {
  const { file, store, cleanup } = await scratch({ autosaveMs: 30 });

  for (let i = 0; i < 200; i += 1) store.set(`k${i}`, i);
  assert.equal(store.pending, true);

  await sleep(120);
  assert.equal(store.pending, false, 'the debounced save never ran');

  const stats = store.stats();
  assert.equal(stats.saves, 1, `expected one save, got ${stats.saves}`);
  assert.ok(stats.coalesced >= 199, `expected the burst to coalesce, got ${stats.coalesced}`);

  const reopened = await JsonStore.open({ file });
  assert.equal(reopened.size, 200, 'every mutation still reached disk');

  await cleanup();
});

test('a continuous stream of mutations still saves without waiting for quiet', async () => {
  // The window is fixed, not sliding: a mutation must not push the deadline
  // out, or a bot receiving a message every 20ms with a 60ms window would never
  // save at all. So saves keep landing *during* the stream rather than after.
  //
  // The assertion has to be sampled *inside* the stream — once the mutations
  // stop, an idle store saves anyway, and the test would pass even if the window
  // were sliding. That makes it a test of timer latency as much as of behaviour,
  // and a fixed 12-iteration loop flakes in CI: under load the 20ms sleeps
  // overrun the 60ms window and no timer gets a chance to fire. So the stream
  // runs for a wall-clock budget long enough that a fixed window *must* fire
  // several times, while a sliding one still never fires at all.
  const { file, store, cleanup } = await scratch({ autosaveMs: 60 });

  const STREAM_MS = 1500;
  const deadline = Date.now() + STREAM_MS;
  let savesDuringStream = 0;
  let i = 0;

  while (Date.now() < deadline) {
    store.set('tick', i);
    i += 1;
    await sleep(20);
    savesDuringStream = Math.max(savesDuringStream, store.stats().saves);
  }

  assert.ok(savesDuringStream >= 1, 'the stream starved the save — the window is sliding');

  await store.flush();
  assert.equal((await JsonStore.open({ file })).get('tick'), i - 1);

  await cleanup();
});

test('autosaveMs 0 disables autosaving until flush', async () => {
  const { file, store, cleanup } = await scratch({ autosaveMs: 0 });
  store.set('k', 'v');
  assert.equal(store.pending, false);

  await store.flush();
  assert.equal((await JsonStore.open({ file })).get('k'), 'v');

  await cleanup();
});

test('concurrent flushes share a single write', async () => {
  const { store, cleanup } = await scratch();
  store.set('k', 'v');

  await Promise.all([store.flush(), store.flush(), store.flush()]);
  assert.equal(store.stats().saves, 1);

  await cleanup();
});

test('onSave fires after each write and can be removed', async () => {
  const { store, cleanup } = await scratch();
  const seen = [];
  const off = store.onSave((doc) => seen.push(doc.k));

  store.set('k', 1);
  await store.flush();
  store.set('k', 2);
  await store.flush();
  assert.deepEqual(seen, [1, 2]);

  off();
  store.set('k', 3);
  await store.flush();
  assert.deepEqual(seen, [1, 2], 'the removed listener must stay quiet');

  await cleanup();
});

test('parent directories are created on demand', async () => {
  const base = await dir();
  const file = join(base, 'deep', 'nested', 'db.json');
  const store = await JsonStore.open({ file, autosaveMs: 0 });
  store.set('k', 1);
  await store.flush();

  assert.equal((await JsonStore.open({ file })).get('k'), 1);
  await rm(base, { recursive: true, force: true });
});

test('dispose flushes, seals, and is idempotent', async () => {
  const { file, store, cleanup } = await scratch({ autosaveMs: 20 });
  store.set('k', 'final');
  await store.dispose();

  assert.equal((await JsonStore.open({ file })).get('k'), 'final');

  // Sealed: later mutations are in-memory only, so disposing again must not
  // quietly persist them.
  store.set('k', 'after');
  await sleep(60);
  assert.equal((await JsonStore.open({ file })).get('k'), 'final', 'dispose must stop autosaving');

  const savesAfterFirst = store.stats().saves;
  await store.dispose();
  assert.equal(store.stats().saves, savesAfterFirst, 'a second dispose wrote again');
  assert.equal((await JsonStore.open({ file })).get('k'), 'final');

  await cleanup();
});

/* ── corrupt input ───────────────────────────────────────────────────── */

test('a corrupt file is reported, not silently reset', async () => {
  const base = await dir();
  const file = join(base, 'db.json');
  await writeFile(file, '{ this is not json', 'utf8');

  await assert.rejects(() => JsonStore.open({ file }), (err) => {
    assert.ok(err instanceof CorruptStoreError);
    assert.equal(err.name, 'CorruptStoreError');
    assert.match(err.message, /db\.json/);
    return true;
  });

  // And crucially the bad file is left alone for the operator to inspect.
  assert.equal(await readFile(file, 'utf8'), '{ this is not json');
  await rm(base, { recursive: true, force: true });
});

test('valid JSON that is not an object is still rejected', async () => {
  for (const body of ['[]', '42', '"hello"', 'null', 'true']) {
    const base = await dir();
    const file = join(base, 'db.json');
    await writeFile(file, body, 'utf8');
    await assert.rejects(() => JsonStore.open({ file }), CorruptStoreError, `accepted ${body}`);
    await rm(base, { recursive: true, force: true });
  }
});

test('an empty file is treated as a fresh store', async () => {
  const base = await dir();
  const file = join(base, 'db.json');
  await writeFile(file, '   \n', 'utf8');

  const store = await JsonStore.open({ file, defaults: { fresh: true } });
  assert.equal(store.get('fresh'), true);
  await rm(base, { recursive: true, force: true });
});

test('a directory in place of the file surfaces the real error', async () => {
  const base = await dir();
  await mkdir(join(base, 'db.json'), { recursive: true });
  await assert.rejects(() => JsonStore.open({ file: join(base, 'db.json') }));
  await rm(base, { recursive: true, force: true });
});

/* ── stats and the wrapper ───────────────────────────────────────────── */

test('stats report the written state', async () => {
  const { store, cleanup } = await scratch();
  store.set('a', 1);
  await store.flush();

  const stats = store.stats();
  assert.deepEqual(Object.keys(stats).sort(), [
    'bytes',
    'coalesced',
    'file',
    'keys',
    'lastSavedAt',
    'saves',
  ]);
  assert.equal(stats.keys, 1);
  assert.equal(stats.saves, 1);
  assert.ok(stats.bytes > 0);
  assert.ok(stats.lastSavedAt > 0);

  await cleanup();
});

test('openStore is the same thing under a shorter name', async () => {
  const base = await dir();
  const store = await openStore({ file: join(base, 'db.json'), autosaveMs: 0 });
  assert.ok(store instanceof JsonStore);
  await rm(base, { recursive: true, force: true });
});
