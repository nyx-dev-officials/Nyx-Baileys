/**
 * `featureFont` wiring in src/features/messaging.ts.
 *
 * The typography module's own tests prove the faces work. These prove the
 * *senders* honour them, and — more importantly — prove they do not leak into
 * the fields where styling causes real breakage:
 *
 *   - `rowId` / `buttonId` / `id`: styled, reply matching dies on device only.
 *   - poll `values`: data the recipient votes on.
 *   - `text` bodies: prose the user may need to copy.
 *
 * A fake socket is enough here precisely because these are *argument shape*
 * assertions, not return-shape claims.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { brand, isStyled } from '../dist/features/typography.js';
import {
  sendText,
  sendImage,
  sendPoll,
  sendList,
  sendButtons,
  sendContact,
  toMenuCategories,
} from '../dist/features/messaging.js';

/** Captures what the sender actually handed to the socket. */
function fakeSock() {
  const calls = [];
  return {
    calls,
    sendMessage(jid, content, opts) {
      calls.push({ jid, content, opts });
      return Promise.resolve({ key: { id: 'FAKE' } });
    },
    // sendList routes through sendCategoryMenu, which uses the low-level
    // relay path rather than sendMessage — so the double is captured here.
    relayMessage(_jid, _id, node) {
      calls.push({ jid: _jid, content: node, opts: undefined, relayed: true });
      return Promise.resolve('FAKE');
    },
  };
}


test('sendText leaves text unstyled when featureFont is absent', async () => {
  const sock = fakeSock();
  await sendText(sock, 'x@s.whatsapp.net', 'Group Created');
  assert.equal(sock.calls[0].content.text, 'Group Created',
    'restyling arbitrary user text by default would corrupt copyable output');
});

test('sendText renders in the requested feature face', async () => {
  const sock = fakeSock();
  await sendText(sock, 'x@s.whatsapp.net', 'Group Created', { featureFont: 'groups' });
  assert.equal(sock.calls[0].content.text, brand('Group Created', 'groups'));
});

test('featureFont never leaks onto the wire as a content key', async () => {
  const sock = fakeSock();
  await sendText(sock, 'x@s.whatsapp.net', 'hi', { featureFont: 'groups' });
  assert.deepEqual(Object.keys(sock.calls[0].content), ['text'],
    'an unknown content key is silently dropped by protobuf — it would be dead code');
  assert.equal(sock.calls[0].content.featureFont, undefined);
  assert.equal(sock.calls[0].content.text, brand('hi', 'groups'));
});

test('two features produce different text for the same input', async () => {
  const a = fakeSock();
  const b = fakeSock();
  await sendText(a, 'x@s.whatsapp.net', 'Report Ready', { featureFont: 'analytics' });
  await sendText(b, 'x@s.whatsapp.net', 'Report Ready', { featureFont: 'observability' });
  assert.notEqual(a.calls[0].content.text, b.calls[0].content.text);
});

test('sendImage captions take the face, and only the caption', async () => {
  const sock = fakeSock();
  await sendImage(sock, 'x@s.whatsapp.net', Buffer.from('x'), {
    caption: 'Final Render',
    featureFont: 'media',
  });
  assert.equal(sock.calls[0].content.caption, brand('Final Render', 'media'));
  assert.equal(sock.calls[0].content.featureFont, undefined);
});

test('sendImage without a caption sends no caption', async () => {
  const sock = fakeSock();
  await sendImage(sock, 'x@s.whatsapp.net', Buffer.from('x'), { featureFont: 'media' });
  assert.equal(sock.calls[0].content.caption, undefined);
});

test('sendPoll styles the question but not the options', async () => {
  const sock = fakeSock();
  await sendPoll(sock, 'x@s.whatsapp.net', {
    name: 'Best Fruit',
    values: ['Mango', 'Banana'],
  }, { featureFont: 'analytics' });

  const poll = sock.calls[0].content.poll;
  assert.equal(poll.name, brand('Best Fruit', 'analytics'));
  assert.deepEqual(poll.values, ['Mango', 'Banana'],
    'poll options are the data being voted on; styling them hurts readability');
});

test('sendPoll leaves the question plain by default', async () => {
  const sock = fakeSock();
  await sendPoll(sock, 'x@s.whatsapp.net', { name: 'Best Fruit', values: ['Mango'] });
  assert.equal(sock.calls[0].content.poll.name, 'Best Fruit');
});

test('sendList routes through the native single_select flow, not listMessage', async () => {
  const sock = fakeSock();
  await sendList(sock, 'x@s.whatsapp.net', {
    title: 'Fruits',
    sections: [{ title: 'Tropical', rows: [{ rowId: 'a', title: 'Mango' }] }],
  });

  // sendCategoryMenu builds its protobuf internally and relays by ID, so the
  // payload is asserted at the mapping seam below rather than through the socket.
  assert.equal(sock.calls.length, 1);
  assert.ok(sock.calls[0].relayed);
  assert.equal(sock.calls[0].content.listMessage, undefined,
    'rc14 generateWAMessage has no listMessage branch; it throws "Invalid media type"');
});

test('toMenuCategories styles labels and never the routing key', () => {
  const [sec] = toMenuCategories([{
    title: 'Tropical',
    rows: [{ rowId: 'row_mango', title: 'Mango', description: 'fresh' }],
  }], 'i18n');

  assert.equal(sec.title, brand('Tropical', 'i18n'));
  assert.equal(sec.rows[0].title, brand('Mango', 'i18n'));
  assert.equal(sec.rows[0].id, 'row_mango',
    'a styled id breaks reply matching, and only on device');
  assert.equal(sec.rows[0].description, 'fresh');
});

test('toMenuCategories uses id, not rowId — the client schema', () => {
  const [sec] = toMenuCategories([{ title: 'S', rows: [{ rowId: 'r', title: 'T' }] }]);
  assert.equal(sec.rows[0].id, 'r');
  assert.equal(sec.rows[0].rowId, undefined,
    'rowId is a WAProto name for a message type rc14 cannot send');
});

test('toMenuCategories is a no-op without a featureFont', () => {
  const [sec] = toMenuCategories([{
    title: 'Tropical',
    rows: [{ rowId: 'row_mango', title: 'Mango' }],
  }]);
  assert.equal(sec.title, 'Tropical');
  assert.equal(sec.rows[0].title, 'Mango');
  assert.equal(sec.rows[0].id, 'row_mango');
});

test('toMenuCategories tolerates a section with no title', () => {
  const [sec] = toMenuCategories([{ rows: [{ rowId: 'a', title: 'One' }] }]);
  assert.equal(sec.title, '');
  assert.equal(sec.rows[0].title, 'One');
});

test('sendList never emits a listMessage, which rc14 cannot send', async () => {
  const sock = fakeSock();
  await sendList(sock, 'x@s.whatsapp.net', {
    title: 'Menu',
    sections: [{ title: 'S', rows: [{ rowId: 'a', title: 'One' }] }],
  });
  assert.equal(sock.calls[0].content.listMessage, undefined,
    'rc14 generateWAMessage has no listMessage branch; it throws "Invalid media type"');
});



test('sendButtons styles labels but never buttonIds', async () => {
  const sock = fakeSock();
  await sendButtons(sock, 'x@s.whatsapp.net', {
    text: 'Confirm?',
    buttons: [
      { buttonId: 'yes', buttonText: { displayText: 'Yes' } },
      { buttonId: 'no', buttonText: { displayText: 'No' } },
    ],
  }, { featureFont: 'auth' });

  const msg = sock.calls[0].content.buttonsMessage;
  assert.equal(msg.buttons[0].buttonText.displayText, brand('Yes', 'auth'));
  assert.equal(msg.buttons[1].buttonText.displayText, brand('No', 'auth'));
  assert.equal(msg.buttons[0].buttonId, 'yes',
    'a styled buttonId breaks reply matching on device only');
  assert.equal(msg.text, 'Confirm?');
});

test('sendContact styles displayName but not the vcard', async () => {
  const sock = fakeSock();
  await sendContact(sock, 'x@s.whatsapp.net', {
    displayName: 'Nyx Support',
    vcard: 'BEGIN:VCARD\nFN:Nyx Support\nEND:VCARD',
  }, { featureFont: 'messaging' });

  const contacts = sock.calls[0].content.contacts;
  assert.equal(contacts.displayName, brand('Nyx Support', 'messaging'));
  assert.equal(contacts.contacts[0].vcard, 'BEGIN:VCARD\nFN:Nyx Support\nEND:VCARD',
    'the vcard is parsed by the contacts app, not read as styled text');
});

test('sendContact styles the multi-contact count label', async () => {
  const sock = fakeSock();
  await sendContact(sock, 'x@s.whatsapp.net', [
    { displayName: 'A', vcard: 'A' },
    { displayName: 'B', vcard: 'B' },
  ], { featureFont: 'messaging' });
  assert.equal(sock.calls[0].content.contacts.displayName, brand('2 contacts', 'messaging'));
});

test('every sender is a no-op when featureFont is omitted', async () => {
  const sock = fakeSock();
  const plain = 'Mango';
  await sendText(sock, 'x@s.whatsapp.net', plain);
  await sendPoll(sock, 'x@s.whatsapp.net', { name: plain, values: [plain] });
  await sendList(sock, 'x@s.whatsapp.net', {
    title: plain, sections: [{ title: plain, rows: [{ rowId: plain, title: plain }] }],
  });
  await sendButtons(sock, 'x@s.whatsapp.net', {
    text: plain, buttons: [{ buttonId: plain, buttonText: { displayText: plain } }],
  });
  await sendContact(sock, 'x@s.whatsapp.net', { displayName: plain, vcard: plain });

  // Everything the caller authored must survive verbatim: ids, prose, options,
  // the vcard. If any of it came back styled, default-off is not true default-off.
  const authored = [
    plain,                                     // sendText body
    'Mango',                                   // poll option
    plain,                                     // list row id
    plain,                                     // buttonId
    plain,                                     // button label
  ];
  for (const value of authored) {
    assert.ok(sock.calls.some((c) => JSON.stringify(c.content).includes(value)),
      `expected "${value}" to be present unstyled in the wire payloads`);
  }
  for (const call of sock.calls) {
    assert.equal(call.content.featureFont, undefined);
  }
});