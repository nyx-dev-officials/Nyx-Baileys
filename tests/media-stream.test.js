/**
 * Media download guards.
 *
 * These exercise the refusal paths, which are deliberately reached *before* any
 * decryption. The success paths call the real socket downloader and are covered
 * by integration use, not here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MediaTooLargeError, mediaStreamer } from '../dist/plugins/media-stream.js';

import { applyPlugin, fakeSocket, mediaMessage, wmMessage } from './helpers.js';

function rig(options = {}) {
  const sock = fakeSocket();
  const harness = applyPlugin(mediaStreamer(options), sock);
  return { sock, ...harness };
}

test('a non-media message is refused before reaching the downloader', async () => {
  const { sock } = rig();
  await assert.rejects(
    () => sock.downloadMedia(wmMessage({ message: { conversation: 'not media' } })),
    /carries no media/,
  );
});

test('an oversized declared asset is refused before decoding', async () => {
  const { sock } = rig({ maxBytes: 100 });
  const msg = mediaMessage({ key: 'imageMessage', fileLength: 1000 });

  await assert.rejects(
    () => sock.downloadMedia(msg),
    (err) => {
      assert.ok(err instanceof MediaTooLargeError);
      assert.equal(err.bytes, 1000);
      assert.equal(err.limit, 100);
      return true;
    },
  );
});

test('streamMedia applies the declared-size guard too', async () => {
  const { sock } = rig({ maxBytes: 100 });
  const msg = mediaMessage({ key: 'videoMessage', fileLength: 5000 });

  await assert.rejects(
    () => sock.streamMedia(msg, () => {}),
    (err) => err instanceof MediaTooLargeError && err.limit === 100,
  );
});

test('downloadMedia and streamMedia are attached non-enumerably', () => {
  const { sock } = rig();
  for (const key of ['downloadMedia', 'streamMedia']) {
    assert.equal(typeof sock[key], 'function');
    assert.equal(Object.keys(sock).includes(key), false);
    assert.equal(Object.getOwnPropertyDescriptor(sock, key).enumerable, false);
  }
});
