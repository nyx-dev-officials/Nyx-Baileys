/**
 * TESTS · accessibility and i18n.
 *
 * Note the isolation: `npm run check` currently fails on files another session is
 * mid-write (`src/upgrade/*`, `src/toolkit/performance.ts`). These tests import
 * from `dist/`, so they still exercise this module once it is compiled — but a
 * failing `tsc` blocks the build, and that is somebody else's diff to settle.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isUselessAlt, describeMedia, safeCaption, formatMediaDuration,
  nameInsteadOfColour, reliesOnColour, accessibilityOf,
  withAltText, plainTextOf, readingLoad, needsSplit, MAX_ALT_LENGTH,
} from '../dist/toolkit/access.js';

import {
  hasRtl, isRtlLang, directionOf, isolate, embed, anchorTrailingPunctuation,
  forMessage, number, money, date, time, duration, pair, quoted,
  translate, coverage, missingLanguages,
} from '../dist/toolkit/i18n.js';

/* ══ alt text ═════════════════════════════════════════════════════ */

test('a filename is not alt text', () => {
  assert.equal(isUselessAlt('IMG_4821.jpg'), true);
  assert.equal(isUselessAlt('image 2 of 4'), true);
  assert.equal(isUselessAlt('screenshot'), true);
  assert.equal(isUselessAlt('untitled'), true);
  assert.equal(isUselessAlt(''), true);
  assert.equal(isUselessAlt(undefined), true);
  assert.equal(isUselessAlt(null), true);
});

test('a real description is usable alt text', () => {
  assert.equal(isUselessAlt('The invoice from March, showing 1.240 as total'), false);
});

test('describeMedia builds from known facts only', () => {
  const alt = describeMedia({ kind: 'image', widthPx: 1920, heightPx: 1080 });
  assert.match(alt, /image/);
  assert.match(alt, /1920 by 1080 pixels/);

  assert.match(describeMedia({ kind: 'video', durationSec: 95 }), /duration 1:35/);
  assert.match(describeMedia({ kind: 'document', fileName: 'q3.pdf' }), /named q3\.pdf/);
  assert.match(describeMedia({ kind: 'sticker' }), /sticker/);
});

test('describeMedia prefers the caller context over a generic label', () => {
  const alt = describeMedia({ kind: 'image', context: 'the whiteboard from our call', widthPx: 800, heightPx: 600 });
  assert.match(alt, /the whiteboard from our call/);
});

test('describeMedia never exceeds the length cap', () => {
  const alt = describeMedia({ kind: 'document', fileName: 'x'.repeat(500) });
  assert.ok(alt.length <= MAX_ALT_LENGTH, `got ${alt.length}`);
});

test('safeCaption keeps a good one and replaces a bad one', () => {
  const meta = { kind: 'image', widthPx: 100, heightPx: 100 };

  assert.equal(safeCaption('A cat asleep on a keyboard', meta), 'A cat asleep on a keyboard');
  assert.match(String(safeCaption('IMG_1.jpg', meta)), /image/);
  assert.equal(safeCaption(undefined, meta), 'image, 100 by 100 pixels');
});

test('formatDuration handles both scales', () => {
  assert.equal(formatMediaDuration(45), '45s');
  assert.equal(formatMediaDuration(95), '1:35');
  assert.equal(formatMediaDuration(3600), '60:00');
});

/* ══ colour independence ══════════════════════════════════════════ */

test('colour-only references are rewritten to positional ones', () => {
  assert.match(nameInsteadOfColour('Tap the red one'), /the first one/);
  assert.match(nameInsteadOfColour('Click the green button'), /the second one/);
  assert.match(nameInsteadOfColour('press the blue tab'), /the third one/);
});

test('reliesOnColour detects the problem', () => {
  assert.equal(reliesOnColour('tap the red button'), true);
  assert.equal(reliesOnColour('choose the blue one'), true);
  assert.equal(reliesOnColour('choose the first one'), false);
});

test('nameInsteadOfColour leaves normal prose alone', () => {
  const text = 'The red carpet is in room 3.';
  assert.equal(nameInsteadOfColour(text), text, 'a noun, not a UI reference');
});

/* ══ text fallbacks ═══════════════════════════════════════════════ */

test('media without alt text is flagged with a suggestion', () => {
  const result = accessibilityOf({ image: Buffer.from([1]), caption: 'IMG_2.jpg' });
  assert.ok(result.issues.some((i) => /no useful alt text/.test(i)));
  assert.ok(result.altText, 'and supplied one');
});

test('media with good alt text is not flagged', () => {
  const result = accessibilityOf({ image: Buffer.from([1]), caption: 'the whiteboard photo' });
  assert.equal(result.issues.length, 0);
  assert.equal(result.altText, 'the whiteboard photo');
});

test('a poll with duplicate options is flagged', () => {
  const result = accessibilityOf({ poll: { name: 'q', values: ['a', 'a'] } });
  assert.ok(result.issues.some((i) => /duplicate/.test(i)));
});

test('a thin poll is flagged', () => {
  const result = accessibilityOf({ poll: { name: 'q', values: ['only'] } });
  assert.ok(result.issues.some((i) => /fewer than two/.test(i)));
});

test('interactive content without a text equivalent is flagged', () => {
  const result = accessibilityOf({
    listMessage: { title: 'Menu', sections: [{ title: 's', rows: [{ title: 'a' }] }] },
  });
  assert.ok(result.issues.some((i) => /no text equivalent/.test(i)));
});

test('withAltText returns a new object and does not mutate', () => {
  const original = { image: Buffer.from([1]), caption: 'IMG_3.jpg' };
  const result = withAltText(original, { kind: 'image', widthPx: 10, heightPx: 10 });

  assert.notEqual(result, original);
  assert.equal(original.caption, 'IMG_3.jpg', 'input untouched');
  assert.match(String(result.caption), /image/);
});

test('plainTextOf strips the markup a screen reader cannot announce', () => {
  const text = plainTextOf('<<poll>>\nBest fruit?\n- mango\n- apple\n<<end>>');
  assert.match(text, /Best fruit/);
  assert.ok(!text.includes('<<'), 'no tags leak through');
});

test('plainTextOf also removes colour-only references', () => {
  assert.match(plainTextOf('tap the red one'), /the first one/);
});

/* ══ reading load ════════════════════════════════════════════════ */

test('reading load classifies simple and heavy text', () => {
  assert.equal(readingLoad('ok').load, 'plain');
  assert.equal(readingLoad('Ship it. Ping me if it breaks.').load, 'plain');

  const heavy = readingLoad(
    'The implementation of the aforementioned functionality necessitates comprehensive '
    + 'consideration of architectural ramifications throughout the organisation.',
  );
  assert.equal(heavy.load, 'heavy');
});

test('reading load counts words and long-word ratio', () => {
  const r = readingLoad('one two three four five');
  assert.equal(r.words, 5);
  assert.ok(r.longWordRatio >= 0 && r.longWordRatio <= 1);
});

test('needsSplit triggers on length, not content', () => {
  assert.equal(needsSplit('a'.repeat(20), 60), false);
  assert.equal(needsSplit(Array.from({ length: 80 }, () => 'w').join(' '), 60), true);
});

/* ══ direction ════════════════════════════════════════════════════ */

test('RTL script is detected', () => {
  assert.equal(hasRtl('مرحبا'), true);
  assert.equal(hasRtl('hello'), false);
  assert.equal(hasRtl('hello مرحبا'), true, 'mixed text counts');
});

test('RTL languages are known', () => {
  assert.equal(isRtlLang('ar'), true);
  assert.equal(isRtlLang('he-IL'), true);
  assert.equal(isRtlLang('en'), false);
});

test('script beats language for direction', () => {
  // A Persian message tagged `en` still lays out RTL, because the client
  // renders by script, not by the language tag we happened to attach.
  assert.equal(directionOf('مرحبا', 'en'), 'rtl');
  assert.equal(directionOf('hello', 'ar'), 'rtl', 'language is a fallback');
  assert.equal(directionOf('hello', 'en'), 'ltr');
});

test('isolate wraps a run and self-terminates', () => {
  const wrapped = isolate('hello');
  assert.equal(wrapped.length > 'hello'.length, true);
  // The PDI at the end is what makes it scoped rather than leaking.
  assert.match(wrapped, /⁩$/);
});

test('embed is available for pre-isolate clients', () => {
  // Assert on the control characters by code point, not by literal glyph — the
  // literals do not survive a copy through a shell heredoc intact.
  const LRE = '‪';
  const PDF = '‬';
  const out = embed('hello');
  assert.equal(out[0], LRE, 'opens with LEFT-TO-RIGHT EMBEDDING');
  assert.equal(out.at(-1), PDF, 'closes with POP DIRECTIONAL FORMATTING');
  assert.equal(out.slice(1, -1), 'hello', 'payload intact');
});

test('trailing punctuation is anchored so it cannot jump ends', () => {
  const out = anchorTrailingPunctuation('ends here.');
  assert.match(out, /⁩$/, 'punctuation wrapped');
  assert.match(anchorTrailingPunctuation('no punctuation'), /^no punctuation$/);
});

test('forMessage fixes a mixed-direction line', () => {
  const out = forMessage('hello مرحبا.');
  assert.match(out, /⁩/, 'run isolated');
});

/* ══ locale formatting ═══════════════════════════════════════════ */

test('numbers use the locale separators', () => {
  assert.equal(number(1234567.5, 'en'), '1,234,567.50');
  assert.equal(number(1234567.5, 'de'), '1.234.567,50');
  assert.equal(number(1234567.5, 'id'), '1.234.567,50');
});

test('money follows the locale currency position', () => {
  assert.equal(money(25, 'USD', 'en', '$'), '$25.00');
  assert.equal(money(25, 'EUR', 'de', '€'), '25,00 €');
  assert.equal(money(-25, 'USD', 'en', '$'), '-$25.00');
});

test('dates follow the locale order', () => {
  const d = new Date(Date.UTC(2026, 0, 15));
  assert.equal(date(d, 'en'), '01/15/2026');
  assert.equal(date(d, 'id'), '15/01/2026');
  assert.equal(date(d, 'ja'), '2026-01-15');
});

test('time is always 24-hour, and in local time', () => {
  // Local, not UTC: a chat app shows the user's own clock. Building the Date
  // locally is what makes the assertion timezone-independent.
  const d = new Date(2026, 0, 1, 14, 5, 0);
  assert.equal(time(d), '14:05');
  assert.equal(time(d.getTime()), time(d), 'accepts a timestamp as well as a Date');
});

test('duration omits empty units', () => {
  assert.equal(duration(45, 'en'), '45s');
  assert.equal(duration(95, 'en'), '1m 35s');
  assert.equal(duration(3660, 'en'), '1h 1m', 'zero units omitted');
  assert.equal(duration(0, 'en'), '0s', 'a zero duration still shows something');
});

/* ══ layout ══════════════════════════════════════════════════════ */

test('pair puts the separator on the correct side per direction', () => {
  assert.equal(pair('Coffee', 'hot drink', { locale: 'en' }), 'Coffee: hot drink');
  assert.equal(pair('قهوة', 'ساخن', { locale: 'ar' }), 'ساخن: قهوة');
});

test('quoted uses the convention a language expects', () => {
  assert.equal(quoted('hello'), '> hello');
  assert.match(quoted('bonjour', 'fr'), /^» bonjour/);
});

/* ══ catalogue ═══════════════════════════════════════════════════ */

test('translate interpolates and falls back to the key', () => {
  const catalogue = {
    en: { greeting: 'Hello {name}', bye: 'Bye' },
    id: { greeting: 'Halo {name}' },
  };

  assert.equal(translate(catalogue, 'greeting', 'en', { name: 'Ada' }), 'Hello Ada');
  assert.equal(translate(catalogue, 'greeting', 'id', { name: 'Ada' }), 'Halo Ada');
  assert.equal(translate(catalogue, 'bye', 'id'), 'Bye', 'falls back to en');
  assert.equal(translate(catalogue, 'nope', 'en'), 'nope', 'key, not empty');
});

test('an unresolved placeholder is left visible, not blanked', () => {
  const catalogue = { en: { hi: 'Hello {name}' } };
  assert.equal(translate(catalogue, 'hi', 'en'), 'Hello {name}');
});

test('coverage reports per-key completeness, not a single number', () => {
  const catalogue = {
    en: { a: '1', b: '2', c: '3' },
    id: { a: '1' },
  };

  const c = coverage(catalogue);
  assert.equal(c.perKey.a, 1, 'a is complete');
  assert.equal(c.perKey.b, 0.5, 'b is half translated');
  assert.deepEqual(c.complete, ['a']);
  assert.deepEqual(c.partial.sort(), ['b', 'c']);
});

test('missingLanguages finds gaps against a target list', () => {
  assert.deepEqual(missingLanguages({ en: {}, id: {} }, ['en', 'id', 'ja']), ['ja']);
});