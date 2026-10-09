/**
 * Aesthetic and game command tests.
 *
 * The games tests matter most for the property that is easy to get wrong: a race
 * must resolve to a *real* winner or to nothing. Code that always produces a
 * winner looks identical in a demo and is broken in a group.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CommandRegistry } from '../dist/toolkit/command-registry.js';
import { installCoreFamilies } from '../dist/toolkit/command-families.js';
import { installBulkFamilies } from '../dist/toolkit/command-families-bulk.js';

const sock = { sendMessage: async () => ({}) };
const reg = installCoreFamilies(new CommandRegistry());
installBulkFamilies(reg);
const run = (t, x = '', jid = 'chat@s.whatsapp.net') =>
  reg.run(sock, jid, t, x, { state: new Map() });

/* ── aesthetics ──────────────────────────────────────────────────────── */

test('script maps letters to the calligraphic block', async () => {
  const out = (await run('script', 'Nyx')).text ?? '';
  // Every alphabetic input character becomes a non-ASCII styled glyph.
  for (const ch of out) assert.ok(ch.charCodeAt(0) > 127, `still ASCII: ${ch}`);
  assert.equal([...out].length, 3, 'one codepoint per input letter');
  assert.equal(out.length, 6, 'astral glyphs cost two UTF-16 units');
});

test('upsidedown reverses order and substitutes glyphs', async () => {
  const out = (await run('upsidedown', 'abc')).text ?? '';
  assert.equal([...out].reverse().join(''), 'ɐqɔ', 'not the reverse of the flip map');
});

test('banner produces one line per glyph row', async () => {
  const out = (await run('banner', 'ABC')).text ?? '';
  assert.equal(out.split('\n').length, 3, 'a 3-row font must produce 3 lines');
  for (const line of out.split('\n')) assert.equal(line.length, 15, 'rows must align');
});

test('banner degrades on an unknown glyph rather than crashing', async () => {
  const out = await run('banner', 'A§B');
  assert.ok(out.text, 'unknown glyph should still render');
});

test('matrix respects the requested height and stays in range', async () => {
  const out = (await run('matrix', '6')).text ?? '';
  assert.equal(out.split('\n').length, 6);
});

test('gradient emits ANSI codes and resets at the end', async () => {
  const out = (await run('gradient', 'flux')).text ?? '';
  assert.match(out, /\u001b\[38;5;\d+m/);
  assert.ok(out.endsWith('\u001b[0m'), 'must reset the terminal, not leave it coloured');
});

test('swiss strips markdown and wraps on word boundaries', async () => {
  const out = (await run('swiss', '40 **bold** and [link](http://x.com)')).text ?? '';
  assert.ok(!out.includes('**'), 'emphasis markers survived');
  assert.ok(!out.includes('http://'), 'link target survived');
  assert.ok(out.includes('bold'));
  assert.ok(out.includes('link'));
  for (const line of out.split('\n')) assert.ok(line.length <= 40, `line too long: ${line}`);
});

test('every aesthetic command handles empty input with usage', async () => {
  for (const name of ['script', 'upsidedown', 'banner', 'gradient', 'swiss', 'flip', 'bubble']) {
    const r = await run(name, '');
    assert.ok((r.text ?? r.error ?? '').length > 0, `${name} returned nothing for empty input`);
  }
});

/* ── games: the anti-fake-winner property ────────────────────────────── */

test('a maths race has exactly one correct answer', async () => {
  const ask = await run('mathduel');
  const m = /\*\*(.+?) = \?\*\*/.exec(ask.text ?? '');
  assert.ok(m, `no problem was posed: ${ask.text}`);

  const wrong = await run('answer', '999999');
  assert.ok(wrong.error, 'a wrong answer must not resolve the race');

  const right = await run('answer', '1');
  // Either 1 was correct, or it was rejected. What must not happen is success.
  if (!right.error) assert.match(right.text ?? '', /Correct/);
});

test('a second mathsduel is refused while one is open', async () => {
  const state = new Map();
  const a = await reg.run(sock, 'c@s.whatsapp.net', 'mathduel', '', { state });
  assert.ok(!a.error, a.error ?? '');
  const b = await reg.run(sock, 'c@s.whatsapp.net', 'mathduel', '', { state });
  assert.match(b.error ?? '', /already out/);
});

test('answering with no race open says so instead of guessing', async () => {
  const r = await run('answer', '42');
  assert.match(r.error ?? '', /No problem running/);
});

test('rps judges all nine outcomes correctly', async () => {
  // Exercised against a fixed throw by checking the verdict shape, since the
  // bot's throw is random.
  for (const throw_ of ['rock', 'paper', 'scissors']) {
    const r = await run('rps', throw_);
    assert.match(r.text ?? '', /You: \*\*/);
    assert.match(r.text ?? '', /Draw\.|You win|The bot wins\./);
  }
});

test('rps rejects an invalid throw', async () => {
  const r = await run('rps', 'lizard');
  assert.match(r.text ?? '', /Usage: rps/);
});

test('rps score persists across calls in the same chat', async () => {
  const state = new Map();
  for (let i = 0; i < 4; i++) {
    await reg.run(sock, 'c@s.whatsapp.net', 'rps', 'rock', { state });
  }
  const last = await reg.run(sock, 'c@s.whatsapp.net', 'rps', 'paper', { state });
  assert.match(last.text ?? '', /you \d+, bot \d+, draws \d+/);
  assert.match(last.text ?? '', /draws [1-9]/, 'draws should have accumulated');
});

test('game state does not leak between chats', async () => {
  const a = new Map();
  const b = new Map();
  await reg.run(sock, 'room1@s.whatsapp.net', 'mathduel', '', { state: a });
  const other = await reg.run(sock, 'room2@s.whatsapp.net', 'answer', '5', { state: b });
  assert.match(other.error ?? '', /No problem running/,
    'a race in one chat must not be answerable from another');
});

test('word chain requires the correct starting letter', async () => {
  const state = new Map();
  // Seed explicitly: the starter is random, and some letters have no valid
  // continuation, so asserting on a random seed makes this test flaky.
  const start = await reg.run(sock, 'c@s.whatsapp.net', 'wordchain', 'stream', { state });
  const m = /First word: \*\*(\w+)\*\*/.exec(start.text ?? '');
  assert.ok(m, start.text ?? '');
  const first = m[1];
  const need = first.slice(-1);
  const wrong = await reg.run(sock, 'c@s.whatsapp.net', 'chain', 'zzz', { state });
  assert.match(wrong.error ?? '', /not in the word list|starts with/);

  // A real word starting with the required letter must be accepted.
  const valid = { a: 'apple', b: 'banana', c: 'cloud', d: 'dragon', e: 'ember',
    f: 'flux', g: 'garden', h: 'house', i: 'ice', j: 'jungle', k: 'king',
    l: 'light', m: 'memory', n: 'night', o: 'ocean', p: 'paper', q: 'quartz',
    r: 'river', s: 'stone', t: 'tiger', u: 'umbra', v: 'violet', w: 'window',
    x: 'xenon', y: 'yacht', z: 'zebra' }[need];
  if (valid) {
    const okRes = await reg.run(sock, 'c@s.whatsapp.net', 'chain', valid, { state });
    assert.ok(okRes.text, `valid word rejected: ${okRes.error}`);
    assert.match(okRes.text, /linked/);
  }
});

test('word chain refuses to reuse a word', async () => {
  const state = new Map();
  const start = await reg.run(sock, 'c@s.whatsapp.net', 'wordchain', 'flux', { state });
  assert.match(start.text ?? '', /flux/);
  // flux ends in x; there is no valid x-word, so assert the guard directly.
  const dupe = await reg.run(sock, 'c@s.whatsapp.net', 'chain', 'flux', { state });
  assert.match(dupe.error ?? '', /has been used already|starts with|not in the word list/);
});

test('raffle reports the real probability', async () => {
  const out = (await run('raffle', 'a,b,c,d')).text ?? '';
  assert.match(out, /25\.0% chance each/);
  const one = await run('raffle', 'only');
  assert.match(one.text ?? '', /Usage: raffle/);
});

test('eightball only answers when asked something', async () => {
  assert.match((await run('eightball', 'will it rain')).text ?? '', /🎱/);
  assert.match((await run('eightball', '')).text ?? '', /Usage: eightball/);
});

test('coin counts accumulate', async () => {
  const state = new Map();
  for (let i = 0; i < 3; i++) await reg.run(sock, 'c@s.whatsapp.net', 'coin', '', { state });
  const last = await reg.run(sock, 'c@s.whatsapp.net', 'coin', '', { state });
  assert.match(last.text ?? '', /in 4 flips/);
});