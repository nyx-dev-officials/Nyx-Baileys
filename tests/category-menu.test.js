/**
 * The categorised native menu.
 *
 * The load-bearing test here is `id` vs `rowId`. An earlier round of testing
 * built this menu with `rowId`, saw it fail to arrive, and concluded that
 * sectioned lists were impossible on consumer accounts — a conclusion that was
 * written into the docs and the release notes.
 *
 * It was wrong. `WAProto`'s `ListMessage.Row` does use `rowId`, but that belongs
 * to the `listMessage` type, which rc14 refuses to send at all. This menu travels
 * as a `nativeFlowMessage` button whose `buttonParamsJson` is opaque JSON the
 * *client* parses, and that schema names the field `id`.
 *
 * So the test asserts on the serialised JSON, not on intent — a wrong key here
 * produces a clean message ID and a message that never arrives.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { proto } from '../dist/index.js';
import { readMenuSelection, sendCategoryMenu } from '../dist/toolkit/index.js';

import { applyPlugin, fakeSocket } from './helpers.js';

const JID = '62882017467912@s.whatsapp.net';

const CATEGORIES = [
  {
    title: 'Media',
    rows: [
      { id: 'media_photo', title: 'Photo', description: 'Image with a caption' },
      { id: 'media_voice', title: 'Voice note' },
    ],
  },
  {
    title: 'Interactive',
    rows: [
      { id: 'flow_url', title: 'Open a link', description: 'cta_url' },
      { id: 'flow_copy', title: 'Copy a code', description: 'cta_copy' },
    ],
  },
];

function rig() {
  const sock = fakeSocket();
  sock.user = { id: '6283831459585:12@s.whatsapp.net' };
  const relayed = [];
  sock.relayMessage = async (jid, message, opts) => { relayed.push({ jid, message, opts }); };
  applyPlugin({ name: 'noop', order: 1, apply() {} }, sock);
  return { sock, relayed };
}

/** Dig the opaque payload back out of the built message. */
function paramsOf(entry) {
  const im = entry.message.viewOnceMessage.message.interactiveMessage;
  return {
    buttonName: im.nativeFlowMessage.buttons[0].name,
    payload: JSON.parse(im.nativeFlowMessage.buttons[0].buttonParamsJson),
    messageVersion: im.nativeFlowMessage.messageVersion,
    body: im.body.text,
    footer: im.footer.text,
    contextInfo: entry.message.viewOnceMessage.message.messageContextInfo,
  };
}

test('rows are keyed by id, never rowId', async () => {
  const { sock, relayed } = rig();
  await sendCategoryMenu(sock, JID, CATEGORIES);

  const { payload } = paramsOf(relayed[0]);
  const row = payload.sections[0].rows[0];
  assert.equal(row.id, 'media_photo', 'the client schema names this field id');
  assert.equal('rowId' in row, false, 'rowId is the ListMessage field, not the native-flow one');
});

test('the button is named single_select', async () => {
  const { sock, relayed } = rig();
  await sendCategoryMenu(sock, JID, CATEGORIES);
  assert.equal(paramsOf(relayed[0]).buttonName, 'single_select');
});

test('categories survive with their titles and every row', async () => {
  const { sock, relayed } = rig();
  await sendCategoryMenu(sock, JID, CATEGORIES);

  const { payload } = paramsOf(relayed[0]);
  assert.equal(payload.sections.length, 2);
  assert.deepEqual(payload.sections.map((s) => s.title), ['Media', 'Interactive']);
  assert.equal(payload.sections[0].rows.length, 2);
  assert.equal(payload.sections[1].rows.length, 2);
});

test('an omitted description is left out rather than sent as undefined', async () => {
  const { sock, relayed } = rig();
  await sendCategoryMenu(sock, JID, CATEGORIES);

  const { payload } = paramsOf(relayed[0]);
  const voice = payload.sections[0].rows.find((r) => r.id === 'media_voice');
  assert.equal('description' in voice, false);
});

test('it travels in a viewOnceMessage envelope', async () => {
  const { sock, relayed } = rig();
  await sendCategoryMenu(sock, JID, CATEGORIES);
  assert.ok(relayed[0].message.viewOnceMessage,
    'rc14 only serialises interactive messages in this envelope');
});

test('the reporting secret is attached', async () => {
  const { sock, relayed } = rig();
  await sendCategoryMenu(sock, JID, CATEGORIES);

  // On the *outer* message, alongside the viewOnce wrapper — not the inner one.
  // `generateWAMessageContent` attaches it at the top level, and this path
  // bypasses that function, so it is supplied in the same place.
  assert.ok(relayed[0].message.messageContextInfo?.messageSecret,
    'generateWAMessageContent is bypassed, so supply the secret here');
  assert.equal(relayed[0].message.messageContextInfo.messageSecret.length, 32);

  // The device-list metadata belongs to the inner message, where the client
  // reads it.
  const inner = paramsOf(relayed[0]).contextInfo;
  assert.equal(inner.deviceListMetadataVersion, 2);
  assert.deepEqual(inner.deviceListMetadata, {});
});

test('no additionalNodes — this shape must not carry a quick_reply flow name', async () => {
  const { sock, relayed } = rig();
  await sendCategoryMenu(sock, JID, CATEGORIES);
  assert.equal(relayed[0].opts.additionalNodes, undefined,
    'attaching biz/bot nodes here would label a single_select as quick_reply');
});

test('the menu goes through relayMessage, not sendMessage', async () => {
  // sendMessage cannot reach this content type at all — generateWAMessageContent
  // has no branch for it and throws `Boom: Invalid media type`.
  const { sock, relayed } = rig();
  await sendCategoryMenu(sock, JID, CATEGORIES);
  assert.equal(relayed.length, 1);
  assert.equal(sock.sent.length, 0);
});

test('options override the body, footer and button title', async () => {
  const { sock, relayed } = rig();
  await sendCategoryMenu(sock, JID, CATEGORIES, {
    body: 'Pick one', footer: 'Any time', buttonTitle: 'Open',
  });

  const p = paramsOf(relayed[0]);
  assert.equal(p.body, 'Pick one');
  assert.equal(p.footer, 'Any time');
  assert.equal(p.payload.title, 'Open');
});

test('an empty menu is refused rather than sent as a dead button', async () => {
  const { sock, relayed } = rig();
  await assert.rejects(() => sendCategoryMenu(sock, JID, []), /at least one category/);
  await assert.rejects(() => sendCategoryMenu(sock, JID, [{ title: 'x', rows: [] }]), /at least one row/);
  assert.equal(relayed.length, 0, 'nothing should have gone out');
});

test('selectableIds lists everything the client can echo back', async () => {
  const { sock } = rig();
  const r = await sendCategoryMenu(sock, JID, CATEGORIES);
  assert.deepEqual(r.selectableIds, ['media_photo', 'media_voice', 'flow_url', 'flow_copy']);
});

/* ── reading a selection back ──────────────────────────────────────────── */

test('a selection is read back by id', () => {
  const got = readMenuSelection({
    interactiveResponseMessage: {
      nativeFlowResponseMessage: { paramsJson: JSON.stringify({ id: 'flow_copy' }) },
    },
  });
  assert.equal(got, 'flow_copy');
});

test('a non-selection message yields null', () => {
  assert.equal(readMenuSelection({ conversation: 'hello' }), null);
  assert.equal(readMenuSelection({}), null);
  assert.equal(readMenuSelection(null), null);
});

test('malformed params JSON yields null rather than throwing', () => {
  // A decode failure here should drop one reply, not kill the handler.
  assert.equal(readMenuSelection({
    interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: '{not json' } },
  }), null);
});

test('a selection with no id yields null', () => {
  assert.equal(readMenuSelection({
    interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: JSON.stringify({ title: 'x' }) } },
  }), null);
});

test('the round trip holds: sent id comes back verbatim', async () => {
  // The contract that makes a menu useful — what we send is what we can match.
  const { sock, relayed } = rig();
  const sent = await sendCategoryMenu(sock, JID, CATEGORIES);
  const { payload } = paramsOf(relayed[0]);

  for (const id of sent.selectableIds) {
    const echoed = readMenuSelection({
      interactiveResponseMessage: {
        nativeFlowResponseMessage: { paramsJson: JSON.stringify({ id }) },
      },
    });
    assert.equal(echoed, id);
    assert.ok(
      payload.sections.some((s) => s.rows.some((r) => r.id === id)),
      `${id} was reported selectable but is not in the payload`,
    );
  }
});

test('the built message is real protobuf, not a loose object', async () => {
  const { sock, relayed } = rig();
  await sendCategoryMenu(sock, JID, CATEGORIES);

  const bytes = proto.Message.encode(relayed[0].message).finish();
  const back = proto.Message.toObject(proto.Message.decode(bytes));
  const im = back.viewOnceMessage.message.interactiveMessage;
  assert.ok(im, 'must survive a protobuf round trip');
  assert.equal(im.nativeFlowMessage.buttons[0].name, 'single_select');
});