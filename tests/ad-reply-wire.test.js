import test from 'node:test';
import assert from 'node:assert/strict';

import { generateWAMessageContent } from '@whiskeysockets/baileys';
import { adReply } from '../dist/plugins/ad-reply.js';

/**
 * The card is only worth anything if it survives Baileys' own message builder.
 *
 * `adReply` stamps `contextInfo` onto the object handed to `sendMessage`, and
 * everything between that patch and the wire runs through
 * `generateWAMessageContent`. A field that gets dropped there renders as a title
 * with no image — which is exactly the failure this file exists to catch, and it
 * is invisible to any test that only inspects the pre-build object.
 */

/** Drive one message through the real builder with the plugin applied. */
async function buildWithPlugin(content) {
  let captured;
  const sock = {
    sendMessage: async (jid, payload) => {
      captured = payload;
      return { key: { id: 'TEST' } };
    },
  };
  const undos = [];
  adReply({ stateful: false }).apply({ sock, onDispose: (f) => undos.push(f), log: { debug() {}, info() {}, warn() {}, error() {} } });
  await sock.sendMessage('15550001111@s.whatsapp.net', content);
  undos.forEach((f) => f());
  return captured;
}

/**
 * What Baileys would actually put on the wire.
 *
 * Two traps, both hit while writing this. `generateWAMessageContent` is `async`,
 * and it returns the protobuf `Message` itself — the content sits at
 * `built.extendedTextMessage`, not `built.message`. Reading `built.message`
 * yields `undefined` and looks exactly like the card being dropped.
 */
async function toWire(payload) {
  const built = await generateWAMessageContent(payload, { getUrlInfo: async () => null, logger: {} });
  return built?.extendedTextMessage?.contextInfo;
}

test('the ad card survives Baileys message generation', async () => {
  const payload = await buildWithPlugin({ text: 'hello' });
  const info = await toWire(payload);

  assert.ok(info, 'the wire payload has a contextInfo at all');
  assert.ok(info.externalAdReply, 'externalAdReply reached the wire, not just our object');

  const card = info.externalAdReply;
  assert.equal(card.title, '𝓝𝔂𝔁 • 𝓕𝓵𝓾𝔁');
  assert.equal(card.sourceUrl, 'https://nyx-devs.vercel.app');
  assert.match(String(card.mediaUrl), /^https:\/\/videotourl\.com\//);
  assert.equal(card.mediaType, 2, 'VIDEO survives as VIDEO');
  assert.ok(card.thumbnail?.length > 1000, 'the embedded thumbnail survives encoding');
  assert.equal(card.showAdAttribution, true, 'the attribution flag survives as a boolean');
});
