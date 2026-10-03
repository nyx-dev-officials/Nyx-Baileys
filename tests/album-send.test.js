/**
 * Sending albums.
 *
 * The wire contract is parent-then-siblings: a parent carrying counts, then each
 * media message linked to it through `albumParentKey`. These tests pin that
 * shape on the socket's outbound log.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildAlbumParent, inferAlbumCounts, sendAlbum } from '../dist/core/album.js';
import { albumHandler } from '../dist/plugins/album.js';

import { applyPlugin, fakeSocket } from './helpers.js';

const CHAT = 'a@s.whatsapp.net';

/* ── pure helpers ────────────────────────────────────────────────────── */

test('inferAlbumCounts splits image- and video-like items', () => {
  assert.deepEqual(
    inferAlbumCounts([{ image: {} }, { image: {} }, { video: {} }, { ptv: {} }]),
    { images: 2, videos: 2 },
  );
  assert.deepEqual(inferAlbumCounts([{ document: {} }]), { images: 1, videos: 0 });
  assert.deepEqual(inferAlbumCounts([]), { images: 0, videos: 0 });
});

test('buildAlbumParent produces the count-only parent content', () => {
  assert.deepEqual(buildAlbumParent(3, 1), { album: { expectedImageCount: 3, expectedVideoCount: 1 } });
});

/* ── sendAlbum ───────────────────────────────────────────────────────── */

test('sendAlbum sends the parent first, then links every item to it', async () => {
  const sock = fakeSocket();
  const result = await sendAlbum(sock, CHAT, [
    { image: { url: 'a.jpg' }, caption: 'one' },
    { image: { url: 'b.jpg' } },
    { video: { url: 'c.mp4' } },
  ]);

  assert.equal(sock.sent.length, 4, 'one parent plus three items');
  const parent = sock.sent[0];
  assert.deepEqual(parent.content.album, { expectedImageCount: 2, expectedVideoCount: 1 });
  assert.equal(result.key.id, 'SENT-1');

  for (const entry of sock.sent.slice(1)) {
    assert.ok(entry.content.albumParentKey, 'each item carries albumParentKey');
    assert.equal(entry.content.albumParentKey.id, 'SENT-1');
  }
  assert.equal(sock.sent[1].content.caption, 'one', 'item content is preserved');
  assert.equal(result.items.length, 3);
});

test('counts can be overridden explicitly', async () => {
  const sock = fakeSocket();
  await sendAlbum(sock, CHAT, [{ image: {} }], { expectedImageCount: 5, expectedVideoCount: 2 });
  assert.deepEqual(sock.sent[0].content.album, { expectedImageCount: 5, expectedVideoCount: 2 });
});

test('an empty album is refused', async () => {
  const sock = fakeSocket();
  await assert.rejects(() => sendAlbum(sock, CHAT, []), /at least one item/);
});

test('concurrent mode still links every item', async () => {
  const sock = fakeSocket();
  const result = await sendAlbum(sock, CHAT, [{ image: {} }, { image: {} }], { concurrent: true });
  assert.equal(result.items.length, 2);
  for (const entry of sock.sent.slice(1)) {
    assert.equal(entry.content.albumParentKey.id, 'SENT-1');
  }
});

/* ── socket helper ───────────────────────────────────────────────────── */

test('the album plugin attaches sendAlbum non-enumerably', async () => {
  const sock = fakeSocket();
  applyPlugin(albumHandler(), sock);

  assert.equal(typeof sock.sendAlbum, 'function');
  assert.equal(Object.keys(sock).includes('sendAlbum'), false);
  assert.equal(Object.getOwnPropertyDescriptor(sock, 'sendAlbum').enumerable, false);

  await sock.sendAlbum(CHAT, [{ image: {} }]);
  assert.equal(sock.sent[0].content.album.expectedImageCount, 1);
});
