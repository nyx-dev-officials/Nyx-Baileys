/**
 * Interactive messages: the ones rc14's send path refuses.
 *
 * ## The bug this exists for
 *
 * `generateWAMessageContent` (`Utils/messages.js:273`) is an if/else chain over
 * the content keys it knows, and its final `else` calls `prepareWAMessageMedia`,
 * which throws `Boom: Invalid media type`. `listMessage`, `buttonsMessage`,
 * `templateMessage` and `interactiveMessage` are not in that chain, so
 * `sendMessage` rejects all of them — even though `core/nodes.ts` serialises them
 * correctly. The shapes were right; only the door was shut.
 *
 * ## What these tests can and cannot prove
 *
 * They prove the plugin does the right thing *locally*: it detects the right
 * keys, routes everything else through untouched, builds a well-formed message,
 * emits the local-history update that `sendMessage` would have, unwinds on
 * dispose, and surfaces real errors rather than swallowing them.
 *
 * They cannot prove a phone rendered it. That was verified on hardware — see
 * `docs/VERIFICATION.md` — and it is the one claim in this file that a fake
 * socket cannot make.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { interactive, interactiveKeyOf } from '../dist/plugins/interactive.js';

import { GROUP, applyPlugin, fakeSocket, flush, pn } from './helpers.js';

const ME = pn(9);
const LIST = {
  listMessage: {
    title: 'Menu',
    description: 'Available Features',
    buttonText: 'Open',
    sections: [{ title: 'Features', rows: [{ title: 'Call Button', description: 'Example', rowId: 'c' }] }],
  },
};
const BUTTONS = { buttonsMessage: { headerText: 'H', contentText: 'C', buttons: [{ buttonId: 'y', buttonText: { displayText: 'Yes' } }] } };

function rig(options = {}) {
  const sock = fakeSocket();
  sock.user = { id: ME, lid: '999:9@lid' };
  const relayed = [];
  sock.relayMessage = async (jid, message, opts) => {
    relayed.push({ jid, message, opts });
  };
  // Captured BEFORE the patch. Capturing it after would compare the wrapper with
  // the pristine original and fail for a reason that has nothing to do with undo.
  const pristine = sock.sendMessage;
  const harness = applyPlugin(interactive(options), sock);
  return { sock, relayed, pristine, ...harness };
}

/* ── detection ────────────────────────────────────────────────────────── */

test('the interactive keys are the ones the upstream chain rejects', () => {
  assert.equal(interactiveKeyOf(LIST), 'listMessage');
  assert.equal(interactiveKeyOf(BUTTONS), 'buttonsMessage');
  assert.equal(interactiveKeyOf({ templateMessage: {} }), 'templateMessage');
  assert.equal(interactiveKeyOf({ interactiveMessage: {} }), 'interactiveMessage');
});

test('ordinary content is not mistaken for interactive content', () => {
  for (const content of [{ text: 'hi' }, { image: {} }, { poll: {} }, {}, null, undefined, 'string', 42]) {
    assert.equal(interactiveKeyOf(content), null, `false positive on ${JSON.stringify(content)}`);
  }
});

test('a null-valued key does not count as present', () => {
  assert.equal(interactiveKeyOf({ listMessage: null }), null);
  assert.equal(interactiveKeyOf({ listMessage: undefined }), null);
});

/* ── pass-through ─────────────────────────────────────────────────────── */

test('a normal send is passed straight through, untouched', async () => {
  const { sock, relayed } = rig();

  await sock.sendMessage(GROUP, { text: 'plain' });

  assert.equal(sock.sent.length, 1, 'the original sendMessage should have run');
  assert.equal(relayed.length, 0, 'and relayMessage should not have been used');
  assert.equal(sock.__interactive.stats().passedThrough, 1);
});

/* ── handling ─────────────────────────────────────────────────────────── */

test('a list message is built and relayed rather than rejected', async () => {
  const { sock, relayed } = rig();

  const result = await sock.sendMessage(GROUP, LIST);

  assert.equal(relayed.length, 1, 'relayMessage was not used');
  assert.equal(relayed[0].jid, GROUP);
  assert.equal(relayed[0].opts.messageId, result.key.id, 'the id we return is the id we sent');
  assert.equal(sock.sent.length, 0, 'the upstream path must not have been attempted');
  assert.equal(sock.__interactive.stats().sent, 1);
});

test('a buttons message is relayed with its buttons intact', async () => {
  const { sock, relayed } = rig();

  await sock.sendMessage(GROUP, BUTTONS);

  const inner = relayed[0].message;
  const buttons = inner.buttonsMessage?.buttons;
  assert(Array.isArray(buttons) && buttons.length === 1, `buttons lost: ${JSON.stringify(inner)}`);
  assert.equal(buttons[0].buttonId ?? buttons[0].buttonText?.displayText, 'y', 'button content lost');
});

test('the message is keyed to the chat and marked as ours', async () => {
  const { sock, relayed } = rig();

  const result = await sock.sendMessage(GROUP, LIST);

  // relayMessage takes the inner message plus a separate id, so the key is on
  // the returned message rather than on what was handed to the relay.
  assert.equal(result.key.remoteJid, GROUP, 'keyed to the chat it was sent to');
  assert.equal(result.key.fromMe, true, 'an outgoing message must be marked fromMe');
  assert.equal(relayed[0].opts.messageId, result.key.id, 'the id sent is the id returned');
  assert(relayed[0].message.listMessage, 'the inner message carries the content, not a wrapper');
});

test('every supported key routes through, not just lists', async () => {
  const { sock, relayed } = rig();

  for (const key of ['listMessage', 'buttonsMessage', 'templateMessage', 'interactiveMessage', 'carouselMessage']) {
    await sock.sendMessage(GROUP, { [key]: { stub: true } });
  }

  assert.equal(relayed.length, 5, `expected five relays, got ${relayed.length}`);
  assert.equal(sock.sent.length, 0);
});

/* ── local history ────────────────────────────────────────────────────── */

test('the outgoing message reaches local history, as sendMessage would do', async () => {
  const { sock } = rig();

  const seen = [];
  sock.ev.on('messages.update', (u) => seen.push(u));

  const result = await sock.sendMessage(GROUP, LIST);
  await flush();

  assert.equal(seen.length, 1, 'nothing landed in local history');
  assert.equal(seen[0][0].key.id, result.key.id);
  assert(seen[0][0].update.message, 'the message body was not carried');
});

/* ── errors ───────────────────────────────────────────────────────────── */

test('sending before the socket is open fails loudly rather than silently', async () => {
  const sock = fakeSocket();
  sock.user = undefined;
  const relayed = [];
  sock.relayMessage = async (...a) => relayed.push(a);
  applyPlugin(interactive(), sock);

  await assert.rejects(() => sock.sendMessage(GROUP, LIST), /before the socket is open/);
  assert.equal(relayed.length, 0, 'nothing should have been relayed');
});

test('a relay failure propagates and is counted, not swallowed', async () => {
  const { sock } = rig();
  sock.relayMessage = async () => {
    throw new Error('relay exploded');
  };

  await assert.rejects(() => sock.sendMessage(GROUP, LIST), /relay exploded/);
  assert.equal(sock.__interactive.stats().failed, 1);
});

/* ── lifecycle ────────────────────────────────────────────────────────── */

test('dispose restores the original sendMessage', () => {
  const { sock, pristine, dispose } = rig();
  assert.notEqual(sock.sendMessage, pristine, 'the plugin should have patched it');

  dispose();

  assert.equal(sock.sendMessage, pristine, 'the patch did not unwind');
});

test('the stats helper is non-enumerable and reports all three counters', async () => {
  const { sock } = rig();

  await sock.sendMessage(GROUP, { text: 'pass' });
  await sock.sendMessage(GROUP, LIST);

  const stats = sock.__interactive.stats();
  assert.deepEqual(Object.keys(stats).sort(), ['failed', 'passedThrough', 'sent']);
  assert.equal(stats.sent, 1);
  assert.equal(stats.passedThrough, 1);
  assert.equal(stats.failed, 0);
  assert.equal(Object.keys(sock).includes('__interactive'), false, 'helpers must stay off the enumeration');
});

test('useCachedGroupMetadata defaults off, so a cold socket resolves participants', async () => {
  const cold = rig();
  await cold.sock.sendMessage(GROUP, LIST);
  assert.equal(cold.relayed[0].opts.useCachedGroupMetadata, false);

  const warm = rig({ useCachedGroupMetadata: true });
  await warm.sock.sendMessage(GROUP, LIST);
  assert.equal(warm.relayed[0].opts.useCachedGroupMetadata, true);
});