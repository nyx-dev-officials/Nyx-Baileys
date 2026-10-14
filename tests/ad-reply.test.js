import test from 'node:test';
import assert from 'node:assert/strict';

import { adReply } from '../dist/plugins/ad-reply.js';

/** A socket that records what actually reached sendMessage. */
function harness() {
  const sent = [];
  const sock = {
    sendMessage: async (jid, content, ...rest) => {
      sent.push([jid, content, rest]);
      return { key: { id: `K${sent.length}` } };
    },
  };
  const undos = [];
  const ctx = { sock, onDispose: (f) => undos.push(f), log: { warn() {}, info() {}, debug() {}, error() {} } };
  return { sent, ctx, undos, sock };
}

test('every send picks up the card, with the given branding', async () => {
  const { sent, ctx } = harness();
  adReply().apply(ctx);
  const sock = ctx.sock;

  await sock.sendMessage('a@s.whatsapp.net', { text: 'hello' });

  assert.equal(sent.length, 1);
  const card = sent[0][1].contextInfo.externalAdReply;
  assert.equal(card.title, '𝓝𝔂𝔁 • 𝓕𝓵𝓾𝔁');
  assert.equal(card.sourceUrl, 'https://nyx-devs.vercel.app');
  assert.match(card.thumbnailUrl, /^https:\/\/i\.im\.ge\//);
  assert.match(card.mediaUrl, /^https:\/\/videotourl\.com\//);
  assert.equal(card.mediaType, 2, 'mediaType must match the mp4 mediaUrl, or the card renders blank');
  assert.equal(card.showAdAttribution, true);
  assert.equal(card.renderLargerThumbnail, true);
});

test('only real rc14 field names are used', () => {
  const { sent, ctx } = harness();
  adReply().apply(ctx);

  // Every key must exist on the generated type. Protobuf drops the rest silently,
  // which is how a card ends up rendering with a title and nothing else.
  const REAL = new Set([
    'title', 'body', 'mediaType', 'thumbnailUrl', 'mediaUrl', 'thumbnail', 'sourceType',
    'sourceId', 'sourceUrl', 'containsAutoReply', 'renderLargerThumbnail',
    'showAdAttribution', 'ctwaClid', 'ref', 'clickToWhatsappCall',
    'adContextPreviewDismissed', 'sourceApp', 'automatedGreetingMessageShown',
    'greetingMessageBody', 'ctaPayload', 'disableNudge', 'originalImageUrl',
    'automatedGreetingMessageCtaType', 'wtwaAdFormat', 'adType',
  ]);

  return void ctx.sock.sendMessage('a@s.whatsapp.net', { text: 'x' }).then(() => {
    const card = sent[0][1].contextInfo.externalAdReply;
    for (const key of Object.keys(card)) {
      assert.ok(REAL.has(key), `invented field "${key}" would be dropped by protobuf`);
    }
    // The two the reference bots set that do not exist — the exact bug to not copy.
    assert.equal(card.previewType, undefined);
    assert.equal(card.description, undefined);
  });
});

test('a card the caller set is never overwritten', async () => {
  const { sent, ctx } = harness();
  adReply().apply(ctx);

  const mine = { title: 'mine', sourceUrl: 'https://example.com' };
  await ctx.sock.sendMessage('a@s.whatsapp.net', { text: 'x', contextInfo: { externalAdReply: mine } });
  assert.equal(sent[0][1].contextInfo.externalAdReply, mine, 'explicit wins');
});

test('other context fields survive the stamp', async () => {
  const { sent, ctx } = harness();
  adReply().apply(ctx);

  await ctx.sock.sendMessage('a@s.whatsapp.net', { text: 'x', contextInfo: { mentionedJid: ['z@s.whatsapp.net'] } });
  const ctxInfo = sent[0][1].contextInfo;
  assert.deepEqual(ctxInfo.mentionedJid, ['z@s.whatsapp.net']);
  assert.ok(ctxInfo.externalAdReply, 'the card is still added');
});

test('the caller object is not mutated, and extra args pass through', async () => {
  const { sent, ctx } = harness();
  adReply().apply(ctx);

  const content = { text: 'x' };
  await ctx.sock.sendMessage('a@s.whatsapp.net', content, { quoted: { id: 'Q' } });

  assert.equal(content.contextInfo, undefined, 'the caller keeps ownership of its object');
  assert.ok(sent[0][1].contextInfo.externalAdReply);
  assert.deepEqual(sent[0][2][0], { quoted: { id: 'Q' } }, 'options still reach the socket');
});

test('dispose removes the stamp', async () => {
  const { sent, ctx, undos } = harness();
  adReply().apply(ctx);
  await ctx.sock.sendMessage('a@s.whatsapp.net', { text: 'a' });
  assert.ok(sent[0][1].contextInfo.externalAdReply);

  undos.forEach((f) => f());
  await ctx.sock.sendMessage('a@s.whatsapp.net', { text: 'b' });
  assert.equal(sent[1][1].contextInfo, undefined, 'a disposed plugin stops stamping');
});

test('enabled:false is a no-op', async () => {
  const { sent, ctx } = harness();
  adReply({ enabled: false }).apply(ctx);
  await ctx.sock.sendMessage('a@s.whatsapp.net', { text: 'x' });
  assert.equal(sent[0][1].contextInfo, undefined);
});
test('the thumbnail is embedded, so the card never fetches 22MB', async () => {
  const { sent, ctx } = harness();
  adReply().apply(ctx);
  await ctx.sock.sendMessage('a@s.whatsapp.net', { text: 'x' });
  const card = sent[0][1].contextInfo.externalAdReply;

  // The source URL is a 5504x3072 / 22MB PNG. WhatsApp's card fetcher times out
  // on that, so the build ships a 1280x720 / 144KB JPEG and embeds it.
  assert.ok(card.thumbnail instanceof Uint8Array, 'a buffer rides along, not just a URL');
  assert.ok(card.thumbnail.length > 1000, 'and it is not a placeholder');
  assert.ok(card.thumbnail.length < 400_000, `embedded thumbnail is ${card.thumbnail.length} bytes`);
  assert.deepEqual([...card.thumbnail.slice(0, 3)], [0xff, 0xd8, 0xff], 'it is a real JPEG');
});

test('mediaType follows mediaUrl so the card is not asked to lie', async () => {
  const { sent, ctx } = harness();
  adReply().apply(ctx);
  await ctx.sock.sendMessage('a@s.whatsapp.net', { text: 'x' });
  const card = sent[0][1].contextInfo.externalAdReply;

  assert.match(card.mediaUrl, /\.mp4$/);
  assert.equal(card.mediaType, 2, 'mp4 needs VIDEO, not IMAGE');
});

test('the thumbnail is embedded, so the card never fetches 22MB', async () => {
  const { sent, ctx } = harness();
  adReply().apply(ctx);
  await ctx.sock.sendMessage('a@s.whatsapp.net', { text: 'x' });
  const card = sent[0][1].contextInfo.externalAdReply;

  // The source URL is a 5504x3072 / 22MB PNG. WhatsApp's card fetcher times out
  // on that, so the build ships a 1280x720 / 144KB JPEG and embeds it.
  assert.ok(card.thumbnail instanceof Uint8Array, 'a buffer rides along, not just a URL');
  assert.ok(card.thumbnail.length > 1000, 'and it is not a placeholder');
  assert.ok(card.thumbnail.length < 400_000, `embedded thumbnail is ${card.thumbnail.length} bytes`);
  assert.deepEqual([...card.thumbnail.slice(0, 3)], [0xff, 0xd8, 0xff], 'it is a real JPEG');
});

test('mediaType follows mediaUrl so the card is not asked to lie', async () => {
  const { sent, ctx } = harness();
  adReply().apply(ctx);
  await ctx.sock.sendMessage('a@s.whatsapp.net', { text: 'x' });
  const card = sent[0][1].contextInfo.externalAdReply;

  assert.match(card.mediaUrl, /\.mp4$/);
  assert.equal(card.mediaType, 2, 'mp4 needs VIDEO, not IMAGE');
});

