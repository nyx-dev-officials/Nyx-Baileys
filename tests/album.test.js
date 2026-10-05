/**
 * Album container handling.
 *
 * rc14 splits an album into a parent (counts only) and sibling media messages
 * linked through `messageAssociation`. The case worth guarding is ordering: the
 * siblings often arrive before the parent, and the parent is what carries the
 * expected count.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { proto } from '../dist/index.js';
import { albumHandler } from '../dist/plugins/album.js';

import { applyPlugin, fakeSocket, mediaMessage, upsert, wmMessage } from './helpers.js';

const CHAT = 'a@s.whatsapp.net';
const MEDIA_ALBUM = proto.MessageAssociation.AssociationType.MEDIA_ALBUM;

function rig() {
  const sock = fakeSocket();
  const harness = applyPlugin(albumHandler(), sock);
  return { sock, albums: sock.albums, ...harness };
}

const parent = (id, images, videos = 0) =>
  wmMessage({
    jid: CHAT,
    id,
    message: { albumMessage: { expectedImageCount: images, expectedVideoCount: videos } },
  });

const sibling = (id, parentId, index) =>
  mediaMessage({ jid: CHAT, id, associationType: MEDIA_ALBUM, parentId, fileLength: 10 });

test('siblings assemble under a parent that arrives first', () => {
  const { sock, albums } = rig();

  upsert(sock, [parent('P', 2)]);
  upsert(sock, [sibling('S1', 'P', 0)]);
  upsert(sock, [sibling('S2', 'P', 1)]);

  const album = albums.get('P');
  assert.equal(album.items.length, 2);
  assert.equal(album.expected, 2);
  assert.ok(album.completedAt, 'the album completed once both items arrived');
});

test('a parent arriving AFTER its siblings still resolves the count', async () => {
  // The race the placeholder MAX_SAFE_INTEGER count used to lose: the album is
  // created by the first sibling with an unknown size, so the later parent must
  // be able to correct it and complete.
  const { sock, albums } = rig();

  upsert(sock, [sibling('S1', 'P', 0)]);
  upsert(sock, [sibling('S2', 'P', 1)]);
  assert.equal(albums.get('P').completedAt, undefined, 'not complete before the count is known');

  upsert(sock, [parent('P', 2)]);

  const album = albums.get('P');
  assert.equal(album.expected, 2, 'the parent count replaced the placeholder');
  assert.equal(album.items.length, 2);
  assert.ok(album.completedAt, 'completion was re-evaluated after the parent arrived');

  const waited = await sock.waitForAlbum('P', 50);
  assert.equal(waited?.key, 'P');
  assert.ok(waited.completedAt);
});

test('a lone sibling with no parent yet is not marked complete', () => {
  const { sock, albums } = rig();
  upsert(sock, [sibling('S1', 'P', 0)]);
  assert.equal(albums.get('P').completedAt, undefined);
});

test('an incomplete album times out of waitForAlbum', async () => {
  const { sock } = rig();
  upsert(sock, [parent('P', 3)]);
  upsert(sock, [sibling('S1', 'P', 0)]);
  const waited = await sock.waitForAlbum('P', 20);
  assert.equal(waited?.completedAt, undefined);
});

test('albums, expandAlbum and waitForAlbum are non-enumerable', () => {
  const { sock } = rig();
  for (const key of ['albums', 'expandAlbum', 'waitForAlbum']) {
    assert.equal(Object.keys(sock).includes(key), false);
    assert.equal(Object.getOwnPropertyDescriptor(sock, key).enumerable, false);
  }
});

/*
 * ---------------------------------------------------------------------------
 * D12 — `expected` is `number | null`, not a magic sentinel
 *
 * An album is routinely created by a sibling that arrives before its parent, so
 * it starts life knowing nothing about the total. That used to be recorded as
 * `Number.MAX_SAFE_INTEGER`.
 *
 * A sentinel reads as a real count to every arithmetic path it touches, and
 * nothing in the type said otherwise. `items.length >= expected` was silently
 * false forever, so completion depended on a separate `expected !== MAX_SAFE_INTEGER`
 * guard that had to stay in sync across two files. `null` states the fact, and
 * the compiler now rejects a comparison that forgets to handle it.
 * ---------------------------------------------------------------------------
 */

test('an album created by a lone sibling reports expected: null, not a sentinel', () => {
  const { sock, albums } = rig();
  upsert(sock, [sibling('S1', 'P', 0)]);

  const album = albums.get('P');
  assert.equal(album.expected, null, 'unknown total must be null');
  assert.notEqual(
    album.expected,
    Number.MAX_SAFE_INTEGER,
    'the magic sentinel must be gone from the data model entirely',
  );
});

test('a parent-first album reports its real count', () => {
  const { sock, albums } = rig();
  upsert(sock, [parent('P', 2)]);
  assert.equal(albums.get('P').expected, 2);
});

test('null survives a sibling-heavy arrival without completing', () => {
  const { sock, albums } = rig();
  upsert(sock, [sibling('S1', 'P', 0)]);
  upsert(sock, [sibling('S2', 'P', 1)]);
  upsert(sock, [sibling('S3', 'P', 2)]);

  const album = albums.get('P');
  assert.equal(album.expected, null, 'still unknown');
  assert.equal(album.items.length, 3);
  assert.equal(album.completedAt, undefined, 'no total means no completion');
});

test('the count resolves on the late parent and completion is re-evaluated', () => {
  const { sock, albums } = rig();
  upsert(sock, [sibling('S1', 'P', 0)]);
  upsert(sock, [sibling('S2', 'P', 1)]);
  assert.equal(albums.get('P').expected, null);

  upsert(sock, [parent('P', 2)]);

  const album = albums.get('P');
  assert.equal(album.expected, 2, 'null replaced by the real count');
  assert.ok(album.completedAt, 'completion re-evaluated once the count arrived');
});

test('a parent promising more items than arrived does not complete', () => {
  const { sock, albums } = rig();
  upsert(sock, [sibling('S1', 'P', 0)]);
  upsert(sock, [parent('P', 3)]);

  const album = albums.get('P');
  assert.equal(album.expected, 3);
  assert.equal(album.completedAt, undefined, '1 of 3 is not complete');
});

test('completion is not re-stamped once reached', () => {
  const { sock, albums } = rig();
  upsert(sock, [parent('P', 1)]);
  upsert(sock, [sibling('S1', 'P', 0)]);

  const first = albums.get('P').completedAt;
  assert.ok(first, 'complete after one item against a promise of one');

  // A stray duplicate sibling must not move the stamp.
  upsert(sock, [sibling('S2', 'P', 1)]);
  assert.equal(albums.get('P').completedAt, first, 'completedAt is set once and left alone');
});
