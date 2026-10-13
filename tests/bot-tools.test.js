/**
 * Bot tools — the command set the reference scripts ship.
 *
 * The tests fall into three groups, and the grouping is the point:
 *
 *   1. **Protocol shape.** `hidetag` works because `mentions` can carry jids that
 *      do not appear in the text. That is asserted on the payload, because a
 *      version that prints every number looks fine in a chat and defeats the
 *      entire feature.
 *   2. **Pure logic.** AFK durations, template filling and text wrapping have
 *      answers that are either right or wrong, with no network and no clock.
 *   3. **Injected fetches.** `translateText`, `textToSpeech` and `sendEmojiMix`
 *      take their client as a parameter, so they are tested against a stub —
 *      offline, deterministically, including the failure paths a live endpoint
 *      would only show you on a bad day.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_WELCOME,
  afkNotice,
  createAfkStore,
  createAutoPresence,
  emojiMixUrl,
  groupMemberJids,
  hiddenTag,
  humanDuration,
  quoteCardSvg,
  renderTemplate,
  sendEmojiMix,
  sendWatermarkedSticker,
  textToSpeech,
  translateText,
  visibleTag,
  wrapText,
} from '../dist/toolkit/index.js';

const GROUP = '123-456@g.us';

/** A socket that records every call, with group metadata attached. */
function rig(members = [
  { id: '111@s.whatsapp.net', name: 'Ada' },
  { id: '222:3@s.whatsapp.net', notify: 'Borg' },
  { id: '333@s.whatsapp.net', name: 'Cy' },
]) {
  const calls = { sendMessage: [], presence: [], read: [] };
  const sock = {
    user: { id: '6283831459585:12@s.whatsapp.net' },
    groupMetadata: async () => ({ participants: members }),
    sendMessage: async (jid, content, options) => {
      calls.sendMessage.push({ jid, content, options });
      return { key: { id: `MSG${calls.sendMessage.length}` } };
    },
    sendPresenceUpdate: async (type, jid) => { calls.presence.push({ type, jid }); },
    readMessages: async (keys) => { calls.read.push(keys); },
  };
  return { sock, calls };
}

/* ══════════════════════════════════════════════════════════════════════════
   Tagging
   ══════════════════════════════════════════════════════════════════════════ */

test('group members are returned without device suffixes', async () => {
  const { sock } = rig();
  const jids = await groupMemberJids(sock, GROUP);
  assert.deepEqual(jids, ['111@s.whatsapp.net', '222@s.whatsapp.net', '333@s.whatsapp.net']);
});

test('a chat that is not a group yields no members instead of throwing', async () => {
  const sock = { groupMetadata: async () => { throw new Error('not a group'); } };
  assert.deepEqual(await groupMemberJids(sock, '111@s.whatsapp.net'), []);
});

test('hidetag mentions everyone and prints no numbers', async () => {
  const { sock, calls } = rig();
  const result = await hiddenTag(sock, GROUP, 'Server maintenance in 10 minutes.');

  assert.equal(result.mentioned, 3);
  const sent = calls.sendMessage[0].content;
  assert.equal(sent.mentions.length, 3);
  assert.ok(sent.mentions.includes('111@s.whatsapp.net'));
  // The whole point: the body is clean. A number here means the feature is a
  // plain tag-all wearing its name.
  assert.equal(sent.text, 'Server maintenance in 10 minutes.');
  assert.equal(/@\d/.test(sent.text), false, `a number leaked into the text: ${sent.text}`);
});

test('hidetag can mention extra jids, without duplicates', async () => {
  const { sock, calls } = rig();
  const result = await hiddenTag(sock, GROUP, 'heads up', { also: ['444@s.whatsapp.net', '111:9@s.whatsapp.net'] });
  assert.equal(result.mentioned, 4);
  assert.equal(new Set(calls.sendMessage[0].content.mentions).size, 4);
});

test('tagall prints the names, and resolves them', async () => {
  const { sock, calls } = rig();
  const result = await visibleTag(sock, GROUP, '*Meeting*');

  assert.equal(result.mentioned, 3);
  const sent = calls.sendMessage[0].content;
  assert.ok(sent.text.includes('@111 — Ada'), `name chip missing: ${sent.text}`);
  // A participant with no saved name falls back to their push name.
  assert.ok(sent.text.includes('@222 — Borg'), `push-name fallback missing: ${sent.text}`);
  assert.equal(sent.mentions.length, 3);
});

test('tagall in a chat with no members sends the text unchanged', async () => {
  const sock = { groupMetadata: async () => { throw new Error('no'); }, sendMessage: async (j, c) => ({ key: { id: 'x' }, c }) };
  const result = await visibleTag(sock, '111@s.whatsapp.net', 'hello');
  assert.equal(result.mentioned, 0);
});

/* ══════════════════════════════════════════════════════════════════════════
   AFK
   ══════════════════════════════════════════════════════════════════════════ */

test('humanDuration reads the way a person would say it', () => {
  assert.equal(humanDuration(0), '0s');
  assert.equal(humanDuration(45_000), '45s');
  assert.equal(humanDuration(90_000), '1m');
  assert.equal(humanDuration(3_600_000), '1h');
  assert.equal(humanDuration(2 * 3_600_000 + 5 * 60_000), '2h 5m');
  assert.equal(humanDuration(26 * 3_600_000), '1d 2h');
  assert.equal(humanDuration(-5), '0s', 'a clock going backwards must not produce a negative');
});

test('the AFK store tracks who is away, and for how long', () => {
  let now = 1_000_000;
  const store = createAfkStore(() => now);

  store.set('111:5@s.whatsapp.net', 'lunch');
  assert.equal(store.size(), 1);

  // The device suffix is dropped, so the same person matches either form.
  const entry = store.get('111@s.whatsapp.net');
  assert.equal(entry?.reason, 'lunch');

  now += 3 * 60_000;
  assert.equal(store.duration('111@s.whatsapp.net'), '3m');
  assert.equal(afkNotice('111@s.whatsapp.net', store), '*Away* — lunch (3m)');

  assert.equal(store.clear('111@s.whatsapp.net'), true);
  assert.equal(store.get('111@s.whatsapp.net'), null);
  assert.equal(afkNotice('111@s.whatsapp.net', store), null);
  assert.equal(store.clear('111@s.whatsapp.net'), false, 'clearing twice reported success');
});

test('AFK defaults to a reason when none is given', () => {
  const store = createAfkStore(() => 0);
  assert.equal(store.set('111@s.whatsapp.net').reason, 'away');
});

/* ══════════════════════════════════════════════════════════════════════════
   Auto presence
   ══════════════════════════════════════════════════════════════════════════ */

test('auto presence reads the batch, types, then clears itself', async () => {
  const { sock, calls } = rig();
  const presence = createAutoPresence(sock, { holdMs: 20 });

  const handled = await presence.handle([
    { key: { remoteJid: GROUP, id: 'A1' } },
    { key: { remoteJid: GROUP, id: 'A2' } },
    { key: {} },
  ]);

  assert.equal(handled, 2, 'a keyless entry was counted');
  assert.equal(calls.read.length, 1);
  assert.equal(calls.read[0].length, 2);
  assert.deepEqual(calls.presence[0], { type: 'composing', jid: GROUP });

  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(calls.presence.at(-1), { type: 'paused', jid: GROUP }, 'presence was left on');
  assert.equal(presence.stats().cleared >= 1, true);
});

test('auto presence can record instead of typing, and can be turned off', async () => {
  const { sock, calls } = rig();
  const recording = createAutoPresence(sock, { holdMs: 10 });
  await recording.start(GROUP, { recording: true });
  assert.equal(calls.presence[0].type, 'recording');

  const off = createAutoPresence(sock, { read: false, typing: false });
  assert.equal(await off.handle([{ key: { remoteJid: GROUP, id: 'B1' } }]), 0);
  assert.equal((await off.options).read, false);
});

test('a socket without presence support does not take the handler down', async () => {
  const presence = createAutoPresence({ sendMessage: async () => ({}) }, { holdMs: 5 });
  await presence.start('111@s.whatsapp.net');
  await presence.stop('111@s.whatsapp.net');
  assert.equal(typeof presence.stats().started, 'number');
});

/* ══════════════════════════════════════════════════════════════════════════
   Quote card
   ══════════════════════════════════════════════════════════════════════════ */

test('wrapText breaks on words and hard-splits a long word', () => {
  assert.deepEqual(wrapText('one two three', 7), ['one two', 'three']);
  assert.deepEqual(wrapText('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
  assert.deepEqual(wrapText('a\nb', 10), ['a', 'b']);
});

test('the quote card is valid SVG with the text escaped', () => {
  const svg = quoteCardSvg({ name: 'Ada', text: '<script>alert(1)</script>', time: '10:04' });

  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<\/svg>$/);
  // Escaped, not stripped: an XML document that carries raw markup is a broken
  // document, and the card is a document before it is a picture.
  assert.equal(svg.includes('<script>'), false, 'markup was not escaped');
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(svg.includes('Ada'));
  assert.ok(svg.includes('10:04'));
});

test('the card grows with the text and honours the colours', () => {
  const short = quoteCardSvg({ name: 'A', text: 'hi' });
  const long = quoteCardSvg({ name: 'A', text: 'word '.repeat(80) });
  const height = (svg) => Number(/height="(\d+)"/.exec(svg)?.[1] ?? 0);

  assert.ok(height(long) > height(short), 'the card did not grow');
  const themed = quoteCardSvg({ name: 'A', text: 'hi', background: '#123456', color: '#abcdef' });
  assert.ok(themed.includes('#123456') && themed.includes('#abcdef'));
});

/* ══════════════════════════════════════════════════════════════════════════
   Templates
   ══════════════════════════════════════════════════════════════════════════ */

test('renderTemplate fills what it knows and leaves the rest alone', () => {
  assert.equal(renderTemplate('Hi {user} in {group}', { user: 'Ada', group: 'Devs' }), 'Hi Ada in Devs');
  // An unknown key stays visible instead of becoming `undefined`, because
  // "Welcome undefined" looks like a broken bot and "{name}" looks like a typo
  // in the group's own template.
  assert.equal(renderTemplate('Hi {user} ({nick})', { user: 'Ada' }), 'Hi Ada ({nick})');
  assert.equal(renderTemplate('{count}', { count: 0 }), '0');
});

test('the default greetings use the placeholders they document', () => {
  const filled = renderTemplate(DEFAULT_WELCOME, { user: 'Ada', group: 'Devs', count: 12 });
  assert.ok(filled.includes('Ada') && filled.includes('Devs') && filled.includes('12'));
  assert.equal(/\{\w+\}/.test(filled), false, `unfilled placeholder: ${filled}`);
});

/* ══════════════════════════════════════════════════════════════════════════
   Sticker watermark
   ══════════════════════════════════════════════════════════════════════════ */

test('swm sends the sticker with its pack name and author', async () => {
  const calls = [];
  const sock = { sendMessage: async (jid, content) => { calls.push({ jid, content }); return { key: { id: 'S1' } }; } };

  await sendWatermarkedSticker(sock, '111@s.whatsapp.net', Buffer.from('webp-bytes'), {
    pack: 'Flux',
    author: 'made by Nyx',
  });

  const content = calls[0].content;
  assert.equal(content.stickerPack, 'Flux');
  assert.equal(content.stickerAuthor, 'made by Nyx');
  assert.ok(Buffer.isBuffer(content.sticker));
});

/* ══════════════════════════════════════════════════════════════════════════
   Emoji mix
   ══════════════════════════════════════════════════════════════════════════ */

test('the mix URL is built from code points, deterministically', () => {
  const url = emojiMixUrl('🍕', '🍔');
  assert.match(url, /^https:\/\/www\.gstatic\.com\/android\/keyboard\/emojikitchen\/15\//);
  assert.ok(url.includes('1f355'), `pizza code point missing: ${url}`);
  assert.ok(url.includes('1f354'), `burger code point missing: ${url}`);
  assert.equal(url, emojiMixUrl('🍕', '🍔'));
  assert.notEqual(url, emojiMixUrl('🍔', '🍕'));
});

test('a mix that does not exist is reported, not thrown', async () => {
  const sock = { sendMessage: async () => ({ key: { id: 'I1' } }) };
  const missing = await sendEmojiMix(sock, '111@s.whatsapp.net', '🍕', '🦄', {
    fetch: async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }),
  });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /404/);

  const sent = await sendEmojiMix(sock, '111@s.whatsapp.net', '🍕', '🍔', {
    fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }),
  });
  assert.equal(sent.ok, true);
  assert.equal(sent.bytes, 3);
});

test('a mix with an empty body is a failure, not a silent empty image', async () => {
  const sock = { sendMessage: async () => ({ key: { id: 'I2' } }) };
  const empty = await sendEmojiMix(sock, '111@s.whatsapp.net', '🍕', '🍔', {
    fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) }),
  });
  assert.equal(empty.ok, false);
});

/* ══════════════════════════════════════════════════════════════════════════
   Translate and TTS, against a stub
   ══════════════════════════════════════════════════════════════════════════ */

test('translate reads the shape the endpoint returns', async () => {
  const fetch = async (url) => {
    assert.ok(url.includes('tl=id'), `target language missing: ${url}`);
    return { ok: true, status: 200, json: async () => [[['halo dunia', 'hello world']], null, 'en'] };
  };

  const result = await translateText('hello world', { to: 'id', fetch });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'halo dunia');
  assert.equal(result.detected, 'en');
});

test('translate reports an outage and an unexpected shape', async () => {
  const down = await translateText('hi', { fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
  assert.equal(down.ok, false);
  assert.match(down.error, /503/);

  const odd = await translateText('hi', { fetch: async () => ({ ok: true, status: 200, json: async () => 'nope' }) });
  assert.equal(odd.ok, false);
  assert.match(odd.error, /unexpected shape/);

  const emptyInput = await translateText('   ', {});
  assert.equal(emptyInput.ok, false);
});

test('text to speech returns audio, and refuses what the endpoint cannot say', async () => {
  const ok = await textToSpeech('hello', {
    fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([0xff, 0xfb]).buffer }),
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.audio.length, 2);

  const tooLong = await textToSpeech('x'.repeat(201));
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.error, /200 characters/);

  const noFetch = await textToSpeech('hello', { fetch: undefined });
  assert.equal(noFetch.ok, true, 'a runtime with fetch should still work'); 
});
