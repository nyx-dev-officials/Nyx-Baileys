/**
 * Fancy text — the transform family the bot scripts ship inline.
 *
 * Two things are checked here that no inline copy checks:
 *
 *   1. **`flip` and `unflip` are inverses**, asserted as a property over the
 *      whole printable ASCII range rather than on one example. The originals
 *      reverse the string through a one-way table, so `flip(flip(x))` is garbage
 *      and nobody notices, because nobody flips twice.
 *   2. **Every row in the registry changes its sample.** A menu that advertises
 *      `vaporwave` and returns the input unchanged is worse than no row: the user
 *      sees the bot ignore them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TEXT_TRANSFORMS,
  bubble,
  clap,
  findTransform,
  flip,
  fromBinary,
  fromMorse,
  fullWidth,
  leet,
  mirrorWords,
  reverseText,
  smallCaps,
  spaced,
  toBinary,
  toMorse,
  transformIds,
  unflip,
  unzalgo,
  uwu,
  vaporwave,
  zalgo,
} from '../dist/utils/fancy-text.js';

/* ══════════════════════════════════════════════════════════════════════════
   Flip — round trip over the whole printable range
   ══════════════════════════════════════════════════════════════════════════ */

test('flip and unflip are inverses for every printable ASCII character', () => {
  for (let code = 0x20; code <= 0x7e; code += 1) {
    const ch = String.fromCharCode(code);
    const back = unflip(flip(ch));
    // `k` and `K` both map to `ʞ`, whose inverse is lowercase, so that pair is the
    // only exact round trip that cannot be promised. Everything else must return
    // its own character — that is the property the inline copies do not have.
    const shared = { k: 'k', K: 'k' };
    const expected = shared[ch] ?? ch;
    assert.equal(back, expected, `flip round trip broke on ${JSON.stringify(ch)}`);
  }
});

test('flip reverses as well as maps, so a word reads correctly upside down', () => {
  assert.equal(flip('abc'), 'ɔqɐ');
  assert.equal(flip('hello'), 'ollǝɥ');
  assert.equal(flip(''), '');
});

test('flip leaves characters it does not know alone', () => {
  assert.equal(flip('日'), '日');
  assert.equal(unflip('日'), '日');
});

/* ══════════════════════════════════════════════════════════════════════════
   The rest of the family
   ══════════════════════════════════════════════════════════════════════════ */

test('reverse and mirror behave differently on multi-word text', () => {
  assert.equal(reverseText('abc def'), 'fed cba');
  assert.equal(mirrorWords('abc def'), 'cba fed');
});

test('small caps covers the whole alphabet', () => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  const styled = smallCaps(alphabet);
  assert.notEqual(styled, alphabet, 'nothing was styled');
  // `x` is the one letter whose small-cap form is the letter itself — Unicode has
  // no small-cap x. Everything else must be styled: a half-table reads as a broken
  // font rather than a style.
  assert.equal(/[a-wyz]/.test(styled), false, `letters leaked through: ${styled}`);
});

test('bubble styles letters and digits, and nothing else', () => {
  assert.equal(bubble('ab1'), 'ⓐⓑ①');
  assert.equal(bubble('A0'), 'Ⓐ⓪');
  assert.equal(bubble('!'), '!');
});

test('vaporwave is full-width and spaced; fullWidth is not spaced', () => {
  assert.equal(vaporwave('ab cd'), 'ａｂ\u3000ｃｄ');
  assert.equal(fullWidth('ab cd'), 'ａｂ ｃｄ');
});

test('clap and spaced join without leaving doubled separators', () => {
  assert.equal(clap('  a   b  '), 'a 👏 b');
  assert.equal(clap('a b', '🔥'), 'a 🔥 b');
  assert.equal(spaced('abc'), 'a b c');
});

test('zalgo is deterministic and bounded', () => {
  const once = zalgo('hello', { intensity: 3 });
  const twice = zalgo('hello', { intensity: 3 });
  assert.equal(once, twice, 'zalgo is not deterministic');

  // Bounded: five characters, three marks each, at most two marks per character
  // per pass, plus the originals.
  assert.ok(once.length <= 5 + 5 * 3 * 2, `zalgo produced ${once.length} characters`);

  assert.equal(zalgo('hello', { intensity: 0 }), 'hello');
  assert.equal(zalgo('a b', { intensity: 2 }).includes(' '), true, 'spaces must survive');
});

test('unzalgo removes what zalgo adds', () => {
  assert.equal(unzalgo(zalgo('abc', { intensity: 2 })), 'abc');
  assert.equal(unzalgo('plain'), 'plain');
});

test('leet, uwu and the code transforms produce their canonical examples', () => {
  assert.equal(leet('leet'), '1337');
  assert.equal(uwu('the ruler'), 'de wuwew');
  assert.equal(toMorse('sos'), '... --- ...');
  assert.equal(fromMorse('... --- ...'), 'sos');
  assert.equal(toMorse('hi there'), '.... .. / - .... . .-. .');
  assert.equal(toBinary('a'), '01100001');
  assert.equal(fromBinary('01100001'), 'a');
});

test('fromMorse and fromBinary refuse input they cannot read', () => {
  assert.equal(fromBinary('hello'), null);
  assert.equal(fromBinary(''), null);
  assert.equal(fromBinary('01100001 01100010'), 'ab');
  // Unknown Morse codes are dropped rather than guessed at.
  assert.equal(fromMorse('... --- ... xyz'), 'sos');
  assert.equal(fromMorse('.... ..'), 'hi');
});

/* ══════════════════════════════════════════════════════════════════════════
   The registry
   ══════════════════════════════════════════════════════════════════════════ */

test('every transform changes its sample, so no row is a no-op', () => {
  for (const transform of TEXT_TRANSFORMS) {
    const [input, expected] = transform.sample;
    assert.equal(transform.apply(input), expected, `${transform.id} produced the wrong output`);
    assert.notEqual(transform.apply(input), input, `${transform.id} returned its input unchanged`);
  }
});

test('every id in the registry is unique and findable', () => {
  const ids = transformIds();
  assert.equal(new Set(ids).size, ids.length, 'duplicate transform id');
  for (const id of ids) {
    assert.equal(findTransform(id)?.id, id, `findTransform could not find ${id}`);
  }
  assert.equal(findTransform('nope'), null);
});

test('the transforms the menu advertises are the ones that exist', () => {
  // The menu builds its rows from this list, so an empty registry would produce
  // an empty sheet rather than an error elsewhere.
  assert.ok(TEXT_TRANSFORMS.length >= 15, `only ${TEXT_TRANSFORMS.length} transforms`);
  for (const id of ['flip', 'bubble', 'vaporwave', 'zalgo', 'leet', 'morse', 'binary', 'uwu']) {
    assert.ok(findTransform(id), `the menu lists ${id} but the registry does not have it`);
  }
});
