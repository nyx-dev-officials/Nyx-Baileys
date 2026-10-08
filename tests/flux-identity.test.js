/**
 * FLUX identity, scoped memory, and vision.
 *
 * Pure logic and a temp directory. No network, no socket.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FLUX_NAME, FLUX_DESCRIPTION, OWNER_DISPLAY, OWNER_NUMBER, MADE_BY,
  asksForOwner, ownerAnswer, ownerCard, isOwner,
  typ, sanitizeTypography, typographyIssues, checkFormatting,
  footer, sign, footerCoverage,
} from '../dist/toolkit/ai/identity.js';

import {
  userKey, sessionKey, DurableMemory, ScopedMemory,
} from '../dist/toolkit/ai/memory-store.js';

import {
  toMultimodal, flattenToText, canSeeImages, prepareForModel,
  dataUri, detailFor,
} from '../dist/toolkit/ai/vision.js';

import {
  stripDanglingMarkers, createBot, defaultCommands,
} from '../dist/toolkit/ai/engine.js';

import { FLUX_TONES, toneForContext } from '../dist/toolkit/ai/providers.js';

const DM = '62882017467912@s.whatsapp.net';
const GROUP = '120363000000000000@g.us';

const sock = () => ({
  calls: [],
  user: { id: '6283831459585:12@s.whatsapp.net' },
  async sendMessage(j, c, o) { this.calls.push([j, c, o]); return { key: { id: 'X' } }; },
  async onWhatsApp() { return [{ exists: true, jid: 'x@s.whatsapp.net' }]; },
  async sendPresenceUpdate() {},
  async groupMetadata() { return { subject: 'g', size: 1 }; },
});

const msg = (t) => ({ key: { id: 'M', remoteJid: DM, fromMe: false }, message: { conversation: t } });

const tmp = () => mkdtempSync(join(tmpdir(), 'flux-mem-'));

/* ══ identity ═════════════════════════════════════════════════════ */

test('the identity constants are what the operator asked for', () => {
  assert.equal(FLUX_NAME, 'Flux');
  assert.equal(FLUX_DESCRIPTION, 'flux developer');
  assert.equal(MADE_BY, 'made by Nyx');
  assert.match(OWNER_DISPLAY, /^\+62 838-3145-9585$/);
  assert.equal(OWNER_DISPLAY.replace(/\D/g, ''), OWNER_NUMBER);
});

test('the owner question is recognised in several languages and forms', () => {
  for (const q of [
    'who is the owner',
    'who made you',
    'who is the developer',
    "what's the owner's number",
    'how do I contact the admin',
    'siapa pemilik',
    'nama pemilik',
  ]) {
    assert.equal(asksForOwner(q), true, `missed: ${q}`);
  }

  assert.equal(asksForOwner('what time is it'), false);
  assert.equal(asksForOwner('the owner of this house'), false, 'about a house, not the bot — correctly not matched');
});

test('the owner answer is complete and needs no model', async () => {
  const answer = ownerAnswer();
  assert.match(answer, /Flux/);
  assert.match(answer, /Nyx/);
  assert.match(answer, new RegExp(OWNER_DISPLAY.replace(/\+/g, '\\+')), 'the number is given exactly');

  const engine = createBot();
  const turn = await engine.think(sock(), DM, msg('who is the owner'));
  assert.equal(turn.usedModel, false, 'answered without a round trip');
  assert.match(turn.text, /Flux/);
});

test('ownerCard carries the number as a waid', () => {
  const card = ownerCard();
  assert.match(card, /BEGIN:VCARD/);
  assert.match(card, new RegExp(`waid=${OWNER_NUMBER}`));
});

test('isOwner matches regardless of device', () => {
  assert.equal(isOwner(`${OWNER_NUMBER}@s.whatsapp.net`), true);
  assert.equal(isOwner(`${OWNER_NUMBER}:12@s.whatsapp.net`), true);
  assert.equal(isOwner(DM), false);
});

/* ══ typography ═══════════════════════════════════════════════════ */

test('typ applies WhatsApp’s four real markers', () => {
  assert.equal(typ('x', 'bold'), '*x*');
  assert.equal(typ('x', 'italic'), '_x_');
  assert.equal(typ('x', 'mono'), '```x```');
  assert.equal(typ('x', 'strike'), '~x~');
  assert.equal(typ('x'), 'x');
});

test('styled letters and box drawing are stripped, not shipped', () => {
  // These render inconsistently and are unselectable. A bot that sends them
  // looks broken rather than stylish.
  assert.equal(sanitizeTypography('𝐅𝐥𝐮𝐱'), 'Flux');
  assert.equal(sanitizeTypography('Ｆｌｕｘ'), 'Flux');
  assert.equal(sanitizeTypography('a─b'), 'a-b');
});

test('ordinary accented text survives sanitisation', () => {
  assert.equal(sanitizeTypography('café naïve'), 'café naïve');
});

test('typographyIssues reports without rewriting', () => {
  const issues = typographyIssues('𝐅𝐥𝐮𝐱');
  assert.ok(issues.some((i) => /mathematical/.test(i.why)));
  assert.equal(typographyIssues('plain text').length, 0);
});

test('checkFormatting catches an unclosed marker', () => {
  // An unclosed * makes the rest of the message render bold, and rc14 reports
  // nothing. The client just renders it wrong.
  assert.ok(checkFormatting('hello *world').some((p) => /unclosed bold/.test(p)));
  assert.ok(checkFormatting('hello _world').some((p) => /unclosed italic/.test(p)));
  assert.ok(checkFormatting('```code').some((p) => /fence/.test(p)));
  assert.deepEqual(checkFormatting('*bold* and _italic_'), []);
});

test('stripDanglingMarkers repairs only the unmatched marker', () => {
  assert.equal(stripDanglingMarkers('*bold* tail'), '*bold* tail', 'pairs survive');
  assert.equal(stripDanglingMarkers('a *b c'), 'a b c', 'the dangling one goes');
  assert.equal(stripDanglingMarkers('```unclosed'), '```unclosed\n```', 'fence closed');
});

/* ══ footer ═══════════════════════════════════════════════════════ */

test('the footer is on by default and opts out explicitly', () => {
  // Default flipped to ON: the operator asked for the copyright on every reply.
  // The recorded risk (stamping every message is how an account gets
  // rate-limited) is why `enabled: false` must keep working.
  assert.match(footer(), /made by Nyx/, 'default on');
  assert.match(sign('hello'), /made by Nyx/);

  assert.equal(footer({ enabled: false }), '', 'explicit opt-out still works');
  assert.equal(sign('hello', { enabled: false }), 'hello');
});

test('an enabled footer is appended, not prepended', () => {
  const signed = sign('hello', { enabled: true });
  assert.match(signed, /^hello/);
  assert.match(signed, /made by Nyx/);
});

test('a footer is not added to a bare emoji', () => {
  assert.equal(sign('👍', { enabled: true }), '👍', 'a signature on one glyph looks broken');
});

test('footerCoverage measures honestly', () => {
  const mark = '_made by Nyx_';
  const r = footerCoverage([`a

${mark}`, 'b', `c

${mark}`]);
  assert.equal(r.total, 3);
  assert.equal(r.signed, 2);
  assert.equal(Math.round(r.ratio * 100), 67);
});

/* ══ scoped memory ═══════════════════════════════════════════════ */

test('keys are stable and device-stripped', () => {
  assert.equal(userKey(`${OWNER_NUMBER}@s.whatsapp.net`), userKey(`${OWNER_NUMBER}:12@s.whatsapp.net`));
  assert.notEqual(userKey(DM), userKey(GROUP));
});

test('session keys differ per session and per user', () => {
  assert.notEqual(sessionKey(DM, 's1'), sessionKey(DM, 's2'), 's1 ≠ s2');
  assert.notEqual(sessionKey(DM, 's1'), sessionKey(GROUP, 's1'), 'and per user');
  assert.match(sessionKey(DM, 's1'), /^s_[0-9a-f]{24}$/);
});

test('a session id containing path separators cannot escape the store', () => {
  const key = sessionKey(DM, '../../etc/passwd');
  assert.match(key, /^s_[0-9a-f]+$/, 'hashed, so never a path');
});

test('durable memory survives a new instance — the disconnect case', () => {
  const dir = tmp();
  try {
    const first = new DurableMemory({ dir });
    first.remember(userKey(DM), { fact: 'I live in Jakarta', source: 'user' });

    // A brand new store object, as after a socket teardown or re-pair.
    const second = new DurableMemory({ dir });
    const facts = second.for(userKey(DM)).recall();
    assert.equal(facts.length, 1, 'the fact outlived the object');
    assert.match(facts[0].fact, /Jakarta/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory is written atomically — no truncated file on crash', () => {
  const dir = tmp();
  try {
    const mem = new DurableMemory({ dir });
    mem.remember(userKey(DM), { fact: 'a fact', source: 'user' });

    // Only a completed rename exists: a `.tmp` left behind would mean the write
    // was interrupted mid-way.
    const files = readdirSync(dir);
    assert.ok(files.includes(`${userKey(DM)}.json`), 'final file present');
    assert.ok(!files.some((f) => f.endsWith('.tmp')), 'no partial file left behind');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt file is quarantined, not silently discarded', () => {
  const dir = tmp();
  try {
    const mem = new DurableMemory({ dir });
    mem.remember(userKey(DM), { fact: 'precious', source: 'user' });

    writeFileSync(join(dir, `${userKey(DM)}.json`), '{ truncated', 'utf8');

    const reloaded = new DurableMemory({ dir });
    assert.deepEqual(reloaded.for(userKey(DM)).recall(), [], 'does not crash');
    assert.ok(readdirSync(dir).some((f) => f.endsWith('.corrupt')),
      'and keeps the original for the user');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scoped memory keeps sessions separate', () => {
  const dir = tmp();
  try {
    const scoped = new ScopedMemory({ durable: new DurableMemory({ dir }) });

    scoped.learnSession('s1', { fact: 'm1 only', source: 'chat' });
    scoped.learnSession('s2', { fact: 'm2 only', source: 'chat' });

    const inS1 = scoped.recall(DM, 's1').map((f) => f.fact);
    assert.ok(inS1.includes('m1 only'));
    assert.ok(!inS1.includes('m2 only'), 's1 cannot see m2');
    assert.ok(!scoped.recall(DM, 's2').map((f) => f.fact).includes('m1 only'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('durable memory is shared across sessions for one user', () => {
  const dir = tmp();
  try {
    const scoped = new ScopedMemory({ durable: new DurableMemory({ dir }) });
    scoped.remember(DM, { fact: 'I prefer dark mode', source: 'user' });

    assert.ok(scoped.recall(DM, 's1').map((f) => f.fact).includes('I prefer dark mode'));
    assert.ok(scoped.recall(DM, 's2').map((f) => f.fact).includes('I prefer dark mode'));
    assert.ok(!scoped.recall(GROUP, 's1').map((f) => f.fact).includes('I prefer dark mode'),
      'a different user does not inherit it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recall dedupes across the two layers', () => {
  const dir = tmp();
  try {
    const scoped = new ScopedMemory({ durable: new DurableMemory({ dir }) });
    scoped.remember(DM, { fact: 'I live in Jakarta', source: 'user' });
    scoped.learnSession('s1', { fact: 'I live in Jakarta', source: 'chat' });

    const facts = scoped.recall(DM, 's1');
    assert.equal(facts.filter((f) => f.fact === 'I live in Jakarta').length, 1,
      'returning it twice would make the model overconfident');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the rendered block marks which layer a fact came from', () => {
  const dir = tmp();
  try {
    const scoped = new ScopedMemory({ durable: new DurableMemory({ dir }) });
    scoped.remember(DM, { fact: 'durable fact', source: 'user' });
    scoped.learnSession('s1', { fact: 'session fact', source: 'chat' });

    const text = scoped.render(DM, 's1');
    assert.match(text, /durable fact \(remembered/);
    assert.match(text, /session fact \(this conversation/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ending a session drops only its layer', () => {
  const dir = tmp();
  try {
    const scoped = new ScopedMemory({ durable: new DurableMemory({ dir }) });
    scoped.remember(DM, { fact: 'kept forever', source: 'user' });
    scoped.learnSession('s1', { fact: 'gone with the session', source: 'chat' });

    scoped.endSession('s1');

    const after = scoped.recall(DM, 's1').map((f) => f.fact);
    assert.ok(!after.includes('gone with the session'));
    assert.ok(after.includes('kept forever'), 'durable memory is untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ══ vision ═══════════════════════════════════════════════════════ */

test('a text-only model is never handed a parts array', () => {
  // A parts array to a non-vision model is a hard 400 — a photo would turn the
  // whole turn into an error rather than a degraded reply.
  const media = [{ kind: 'image', mimetype: 'image/png', data: 'AAAA' }];
  const out = prepareForModel('what is this?', media, 'openrouter', 'nvidia/nemotron-3-ultra:free');
  assert.equal(typeof out, 'string', 'degraded to text');
  assert.match(out, /what is this\?/);
});

test('a vision model gets the image plus its real metadata', () => {
  const media = [{
    kind: 'image', mimetype: 'image/png', data: 'AAAA', widthPx: 800, heightPx: 600,
  }];
  const out = prepareForModel('what is this?', media, 'openai', 'gpt-4o');

  assert.ok(Array.isArray(out));
  const text = out.filter((p) => p.type === 'text').map((p) => p.text).join(' ');
  assert.match(text, /800 by 600/, 'metadata travels with the bytes');
  assert.ok(out.some((p) => p.type === 'image_url'), 'and the image is attached');
});

test('unavailable bytes produce a truthful note, never a guess', () => {
  const media = [{ kind: 'image', mimetype: 'image/png' }];
  const out = toMultimodal('what is this?', media);
  assert.match(out, /could not be retrieved/);
  assert.match(out, /Do not describe/, 'explicitly forbidding a guess');
});

test('audio and documents are not treated as vision', () => {
  const audio = toMultimodal('what does it say?', [
    { kind: 'audio', mimetype: 'audio/ogg', data: 'AAAA', durationSec: 12 },
  ]);
  assert.match(audio, /no transcription is available/i);
  assert.match(audio, /do not claim to know what was said/i);

  const doc = toMultimodal('summarise this', [
    { kind: 'document', mimetype: 'application/pdf', data: 'AAAA', fileName: 'q3.pdf' },
  ]);
  assert.match(doc, /q3\.pdf/);
});

test('canSeeImages is conservative', () => {
  assert.equal(canSeeImages('openai', 'gpt-4o'), true);
  assert.equal(canSeeImages('anthropic', 'claude-sonnet-4-5'), true);
  assert.equal(canSeeImages('openrouter', 'nvidia/nemotron-3-ultra-550b:free'), false);
  assert.equal(canSeeImages('echo', 'none'), false);
});

test('detailFor drops to low for large images', () => {
  assert.equal(detailFor(100 * 1024), 'high');
  assert.equal(detailFor(2 * 1024 * 1024), 'low');
});

test('flattenToText keeps every textual part', () => {
  const parts = toMultimodal('question', [{ kind: 'image', mimetype: 'image/png', data: 'AAAA' }]);
  const flat = flattenToText(parts);
  assert.match(flat, /question/);
  assert.match(flat, /image/);
});

test('dataUri builds a valid inline payload', () => {
  assert.equal(dataUri('image/png', 'AAAA'), 'data:image/png;base64,AAAA');
});

/* ══ tone ═════════════════════════════════════════════════════════ */

test('tone selection is deterministic, not random', () => {
  const ctx = { lang: 'id', isQuestion: true, wordCount: 12 };
  const first = toneForContext(ctx).id;
  for (let i = 0; i < 20; i += 1) {
    assert.equal(toneForContext(ctx).id, first,
      'the same context must always give the same tone — otherwise the bot has a personality disorder');
  }
});

test('different contexts do get different tones', () => {
  const ids = new Set(FLUX_TONES.map((t) => t.id));
  const seen = new Set(
    FLUX_TONES.map((_, i) => toneForContext({ lang: ['en', 'id', 'ja'][i % 3], isQuestion: i % 2 === 0, wordCount: i * 8 }).id),
  );
  assert.ok(seen.size > 1, 'variety exists');
  assert.ok(ids.size === 6);
});

test('an explicitly named tone wins', () => {
  assert.equal(toneForContext({ tone: 'brisk', isQuestion: false, wordCount: 1 }).id, 'brisk');
});

/* ══ engine integration ═══════════════════════════════════════════ */

test('the help text is generated from the prefix, never hand-written', () => {
  const commands = defaultCommands('flux');
  const help = commands.help({ jid: DM, isGroup: false, args: '', entities: { phones: [], urls: [], jids: [], mentions: [], dates: [], amounts: [], quotes: [] }, conv: undefined, sock: sock() });
  const text = typeof help === 'string' ? help : help.text;
  assert.match(text, /flux ping/);
  assert.match(text, /made by/i);
});

test('every command in the help table has a handler', () => {
  const commands = defaultCommands('flux');
  // `help` is a *function* on the table, not a value — reading `.text` off it
  // yields undefined, so the regex found nothing and the loop proved nothing.
  const result = commands.help({
    jid: DM, isGroup: false, args: '', sock: sock(),
    entities: { phones: [], urls: [], jids: [], mentions: [], dates: [], amounts: [], quotes: [] },
  });
  const text = typeof result === 'string' ? result : result.text;

  const listed = [...text.matchAll(/• flux ([a-z]+)/g)].map((m) => m[1]);
  assert.ok(listed.length > 5, `the help lists commands — got ${listed.length}`);
  for (const name of listed) {
    assert.ok(typeof commands[name] === 'function', `${name} is listed but has no handler`);
  }
});

test('respond repairs dangling formatting and strips ambiguous glyphs', async () => {
  const s = sock();
  const engine = createBot({ commands: { broken: () => ({ text: 'unclosed *bold here' }) } });

  await engine.respond(s, DM, msg('flux broken'));
  const sent = s.calls.at(-1)?.[1];

  assert.equal(checkFormatting(String(sent?.text ?? '')).length, 0, 'balanced now');
  assert.ok(!String(sent?.text ?? '').includes('𝐅'), 'and no styled letters');
});

test('the footer is on by default and can be turned off', async () => {
  const on = sock();
  await createBot().respond(on, DM, msg('flux ping'));
  assert.match(String(on.calls.at(-1)?.[1]?.text ?? ''), /made by Nyx/,
    'every reply carries the copyright unless disabled');

  const off = sock();
  await createBot({ footer: { enabled: false } }).respond(off, DM, msg('flux ping'));
  assert.ok(!String(off.calls.at(-1)?.[1]?.text ?? '').includes('made by Nyx'));
});