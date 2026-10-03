/**
 * Media field traversal.
 *
 * rc14 has no `message.media` and no root `message.contextInfo`. Media lives in
 * a per-type field and the context lives *inside* that field. Every helper here
 * is therefore tested against realistic rc14 shapes, and `sizeOf` is tested
 * against a real protobufjs `Long` (taken from an actual encode/decode round
 * trip, not a hand-rolled stand-in).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { proto, WAProto } from '@whiskeysockets/baileys';

import {
  MEDIA_KEYS,
  associationOf,
  contextOf,
  firstMedia,
  mediaKeyOf,
  mimeOf,
  parentKeyOf,
  sizeOf,
} from '../dist/core/media.js';

import { mediaMessage, wmMessage } from './helpers.js';

const { MEDIA_ALBUM, STATUS_POLL, UNKNOWN } = proto.MessageAssociation.AssociationType;
assert.equal(MEDIA_ALBUM, 1, 'ground truth: MEDIA_ALBUM is association type 1');

/* ── key table ───────────────────────────────────────────────────────── */

test('MEDIA_KEYS lists every rc14 media field in priority order', () => {
  assert.deepEqual([...MEDIA_KEYS], [
    'imageMessage',
    'videoMessage',
    'audioMessage',
    'stickerMessage',
    'documentMessage',
    'ptvMessage',
    'lottieStickerMessage',
  ]);

  // Every key must actually exist as a field on rc14's IMessage.
  const fields = new Set(Object.keys(proto.Message.prototype));
  for (const key of MEDIA_KEYS) {
    assert.ok(fields.has(key), `${key} is not a field on rc14's Message`);
  }
});

/* ── firstMedia / mediaKeyOf ─────────────────────────────────────────── */

test('firstMedia finds the payload for each media type', () => {
  for (const key of MEDIA_KEYS) {
    const msg = mediaMessage({ key, mimetype: 'application/octet-stream' });
    const found = firstMedia(msg);

    assert.ok(found, `${key}: nothing found`);
    assert.equal(found.mimetype, 'application/octet-stream');
    assert.equal(mediaKeyOf(msg), key, `${key}: wrong key reported`);
    assert.equal(mimeOf(msg), 'application/octet-stream');
  }
});

test('firstMedia honours the priority order when several media fields are present', () => {
  const img = mediaMessage({ key: 'imageMessage' });
  img.message.lottieStickerMessage = { mimetype: 'image/lottie' };
  img.message.ptvMessage = { mimetype: 'video/mp4' };

  assert.equal(mediaKeyOf(img), 'imageMessage', 'imageMessage wins over ptv and lottie');
  assert.equal(firstMedia(img).mimetype, 'image/jpeg');
});

test('mediaKeyOf reports videoMessage when only video is present', () => {
  const msg = mediaMessage({ key: 'videoMessage', mimetype: 'video/mp4' });
  assert.equal(mediaKeyOf(msg), 'videoMessage');
  assert.equal(mimeOf(msg), 'video/mp4');
});

test('firstMedia returns null for a message with no media field', () => {
  assert.equal(firstMedia(wmMessage({ message: { conversation: 'hi' } })), null);
  assert.equal(mediaKeyOf(wmMessage({ message: { conversation: 'hi' } })), null);
});

test('firstMedia tolerates a missing message body', () => {
  assert.equal(firstMedia({ key: { id: 'x', remoteJid: 'a@s.whatsapp.net' } }), null);
  assert.equal(firstMedia({ message: null }), null);
  assert.equal(firstMedia({ message: undefined }), null);
});

test('firstMedia skips a null media field rather than returning it', () => {
  const msg = wmMessage({
    message: { imageMessage: null, videoMessage: { mimetype: 'video/mp4' } },
  });
  assert.equal(mediaKeyOf(msg), 'videoMessage');
  assert.equal(firstMedia(msg).mimetype, 'video/mp4');
});

/* ── contextOf / associationOf ───────────────────────────────────────── */

test('contextOf prefers the media field contextInfo over the root one', () => {
  const msg = mediaMessage({
    key: 'imageMessage',
    associationType: MEDIA_ALBUM,
    parentId: 'PARENT1',
    rootContext: { messageAssociation: { associationType: STATUS_POLL } },
  });

  const context = contextOf(msg);
  assert.equal(context.messageAssociation.associationType, MEDIA_ALBUM, 'media context wins');
  assert.equal(parentKeyOf(msg, MEDIA_ALBUM), 'PARENT1');
});

test('contextOf falls back to the root messageContextInfo', () => {
  const msg = mediaMessage({
    key: 'documentMessage',
    rootContext: { messageAssociation: { associationType: MEDIA_ALBUM, parentMessageKey: { id: 'ROOT1' } } },
  });

  assert.equal(contextOf(msg).messageAssociation.associationType, MEDIA_ALBUM);
  assert.equal(parentKeyOf(msg, MEDIA_ALBUM), 'ROOT1');
});

test('contextOf returns null when there is no context anywhere', () => {
  assert.equal(contextOf(mediaMessage({ key: 'imageMessage' })), null);
  assert.equal(contextOf(wmMessage()), null);
  assert.equal(associationOf(wmMessage()), null);
});

test('a null media contextInfo falls through to the root context', () => {
  const msg = mediaMessage({
    key: 'audioMessage',
    associationType: MEDIA_ALBUM,
    parentId: 'A',
  });
  msg.message.audioMessage.contextInfo = null;
  msg.message.messageContextInfo = { messageAssociation: { associationType: MEDIA_ALBUM, parentMessageKey: { id: 'B' } } };

  assert.equal(parentKeyOf(msg, MEDIA_ALBUM), 'B');
});

/* ── parentKeyOf ─────────────────────────────────────────────────────── */

test('parentKeyOf returns the parent id for a MEDIA_ALBUM association', () => {
  const msg = mediaMessage({ key: 'imageMessage', associationType: MEDIA_ALBUM, parentId: 'ALBUM_PARENT' });
  assert.equal(parentKeyOf(msg, MEDIA_ALBUM), 'ALBUM_PARENT');
});

test('parentKeyOf returns undefined for a non-album association', () => {
  for (const type of [STATUS_POLL, UNKNOWN, 2, 3, 11, 19]) {
    const msg = mediaMessage({ key: 'imageMessage', associationType: type, parentId: 'SOMETHING' });
    assert.equal(
      parentKeyOf(msg, MEDIA_ALBUM),
      undefined,
      `associationType ${type} must not be mistaken for album membership`,
    );
  }
});

test('parentKeyOf without a type filter accepts any association', () => {
  const msg = mediaMessage({ key: 'videoMessage', associationType: STATUS_POLL, parentId: 'ANY' });
  assert.equal(parentKeyOf(msg), 'ANY');
  assert.equal(parentKeyOf(msg, STATUS_POLL), 'ANY');
});

test('parentKeyOf returns undefined when the association is incomplete', () => {
  // no association at all
  assert.equal(parentKeyOf(mediaMessage({ key: 'imageMessage' })), undefined);
  // association with no parentMessageKey
  const noKey = mediaMessage({ key: 'imageMessage', associationType: MEDIA_ALBUM });
  assert.equal(parentKeyOf(noKey, MEDIA_ALBUM), undefined);
  // parentMessageKey present but id is empty
  const emptyId = mediaMessage({
    key: 'imageMessage',
    associationType: MEDIA_ALBUM,
    parentId: '',
  });
  assert.equal(parentKeyOf(emptyId, MEDIA_ALBUM), undefined, 'an empty id is not a parent');
  // null parentMessageKey
  const nullKey = mediaMessage({ key: 'imageMessage', associationType: MEDIA_ALBUM });
  nullKey.message.imageMessage.contextInfo.messageAssociation.parentMessageKey = null;
  assert.equal(parentKeyOf(nullKey, MEDIA_ALBUM), undefined);
});

test('an album child decoded from real protobuf bytes resolves its parent', () => {
  // On rc14 the media field's `contextInfo` is a `ContextInfo`, which has no
  // `messageAssociation`; upstream therefore hangs the album association off
  // the ROOT `messageContextInfo` (see upstream Utils/messages.js, the
  // `albumParentKey` branch). `contextOf`'s fallback is the path that matters.
  const encoded = WAProto.Message.encode(
    WAProto.Message.fromObject({
      imageMessage: { mimetype: 'image/jpeg' },
      messageContextInfo: {
        messageAssociation: { associationType: MEDIA_ALBUM, parentMessageKey: { id: 'REAL_PARENT' } },
      },
    }),
  ).finish();
  const msg = wmMessage({ message: WAProto.Message.decode(encoded) });

  assert.equal(mediaKeyOf(msg), 'imageMessage');
  assert.equal(associationOf(msg).associationType, MEDIA_ALBUM);
  assert.equal(parentKeyOf(msg, MEDIA_ALBUM), 'REAL_PARENT');
  assert.equal(parentKeyOf(msg, STATUS_POLL), undefined);
  assert.equal(sizeOf(msg), null, 'this one carried no fileLength');
});

test('the media field contextInfo wins over the root when both are present', () => {
  const encoded = WAProto.Message.encode(
    WAProto.Message.fromObject({
      videoMessage: {
        mimetype: 'video/mp4',
        // A quote link lives in the media field's own ContextInfo...
        contextInfo: { remoteJid: '999@s.whatsapp.net', isForwarded: true },
      },
      messageContextInfo: {
        messageAssociation: { associationType: MEDIA_ALBUM, parentMessageKey: { id: 'ALBUM' } },
      },
    }),
  ).finish();
  const msg = wmMessage({ message: WAProto.Message.decode(encoded) });

  // ...so `contextOf` returning the media context is correct and the album
  // parent is NOT visible: they are genuinely different objects.
  const context = contextOf(msg);
  assert.equal(context.remoteJid, '999@s.whatsapp.net');
  assert.equal(context.isForwarded, true);
  assert.equal('messageAssociation' in context, false);
});

/* ── sizeOf ──────────────────────────────────────────────────────────── */

test('sizeOf reads a plain number fileLength', () => {
  assert.equal(sizeOf(mediaMessage({ key: 'imageMessage', fileLength: 2048 })), 2048);
  assert.equal(sizeOf(mediaMessage({ key: 'videoMessage', fileLength: 0 })), 0, 'zero is a real size');
});

test('sizeOf handles a protobufjs Long, including one beyond 2^53', () => {
  const small = WAProto.Message.decode(
    WAProto.Message.encode(
      WAProto.Message.fromObject({ imageMessage: { fileLength: 4096 } }),
    ).finish(),
  );
  const raw = small.imageMessage.fileLength;
  assert.equal(raw.constructor.name, 'Long', 'sanity: protobufjs really emitted a Long');
  assert.equal(sizeOf(wmMessage({ message: small })), 4096);

  const big = WAProto.Message.decode(
    WAProto.Message.encode(
      WAProto.Message.fromObject({ imageMessage: { fileLength: 5_000_000_000 } }),
    ).finish(),
  );
  assert.equal(big.imageMessage.fileLength.constructor.name, 'Long');
  const size = sizeOf(wmMessage({ message: big }));
  assert.equal(typeof size, 'number');
  assert.equal(size, 5_000_000_000, 'Long must be read through toString(), not truncated');
  assert.ok(size > 2 ** 32);
});

test('sizeOf returns a number for any stringifiable length', () => {
  const duck = mediaMessage({ key: 'documentMessage' });
  duck.message.documentMessage.fileLength = { toString: () => '12345678901234567890' };
  const size = sizeOf(duck);
  assert.equal(typeof size, 'number');
  assert.equal(size, 12345678901234567000, 'precision loss is expected for values past 2^53');

  duck.message.documentMessage.fileLength = { toString: () => '0' };
  assert.equal(sizeOf(duck), 0);
});

test('sizeOf returns null when the sender declared no length', () => {
  assert.equal(sizeOf(mediaMessage({ key: 'imageMessage' })), null);
  const explicitNull = mediaMessage({ key: 'imageMessage' });
  explicitNull.message.imageMessage.fileLength = null;
  assert.equal(sizeOf(explicitNull), null);
  assert.equal(sizeOf(wmMessage({ message: { conversation: 'hi' } })), null);
});

/* ── mimeOf ──────────────────────────────────────────────────────────── */

test('mimeOf returns the declared mimetype and undefined otherwise', () => {
  assert.equal(mimeOf(mediaMessage({ key: 'stickerMessage', mimetype: 'image/webp' })), 'image/webp');

  const nulled = mediaMessage({ key: 'stickerMessage', mimetype: 'image/webp' });
  nulled.message.stickerMessage.mimetype = null;
  assert.equal(mimeOf(nulled), undefined, 'a null mimetype is reported as undefined');

  assert.equal(mimeOf(wmMessage({ message: { conversation: 'hi' } })), undefined);
});