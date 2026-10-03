/**
 * Text utilities.
 *
 * Markup wrappers, safe truncation, chunking to the wire limit, masking and the
 * cheap fuzzy match. Every helper is pure, so each assertion is on an exact
 * value rather than a shape.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bold,
  chunkText,
  equalsIgnoreCase,
  escapeWhatsApp,
  initials,
  isBlank,
  italic,
  mask,
  monospace,
  normalizeWhitespace,
  pluralize,
  quote,
  similarity,
  slugify,
  strikethrough,
  stripFormatting,
  titleCase,
  truncate,
  wordCount,
} from '../dist/utils/text.js';

/* ── markup ──────────────────────────────────────────────────────────── */

test('markup wrappers produce the exact WhatsApp syntax', () => {
  assert.equal(bold('hi'), '*hi*');
  assert.equal(italic('hi'), '_hi_');
  assert.equal(strikethrough('hi'), '~hi~');
  assert.equal(monospace('hi'), '```hi```');
});

test('quote prefixes every line, including blank ones', () => {
  assert.equal(quote('a\nb'), '> a\n> b');
  assert.equal(quote('single'), '> single');
  assert.equal(quote('a\n\nb'), '> a\n> \n> b');
});

test('escapeWhatsApp removes the markup characters', () => {
  assert.equal(escapeWhatsApp('a*b_c~d`e'), 'abcde');
  assert.equal(escapeWhatsApp('plain text'), 'plain text');
});

test('stripFormatting removes markup characters but keeps text', () => {
  assert.equal(stripFormatting('*bold* and _italic_'), 'bold and italic');
  assert.equal(stripFormatting('a~b`c'), 'abc');
});

/* ── truncate ────────────────────────────────────────────────────────── */

test('truncate leaves short strings untouched', () => {
  assert.equal(truncate('hello', 10), 'hello');
  assert.equal(truncate('hello', 5), 'hello', 'exactly at the limit is not a cut');
});

test('truncate appends an ellipsis and never exceeds max', () => {
  assert.equal(truncate('hello world', 8), 'hello w…');
  assert.equal(truncate('hello world', 8).length, 8);
  assert.equal(truncate('hello world', 10, '...'), 'hello w...');
});

test('truncate handles degenerate max and ellipsis', () => {
  assert.equal(truncate('hello', 0), '');
  assert.equal(truncate('hello', -3), '');
  assert.equal(truncate('hello', 2, '...'), 'he', 'ellipsis longer than max is dropped');
});

/* ── whitespace and blanks ───────────────────────────────────────────── */

test('normalizeWhitespace collapses runs and trims', () => {
  assert.equal(normalizeWhitespace('  a \n\t b  '), 'a b');
  assert.equal(normalizeWhitespace('\n\n'), '');
});

test('isBlank recognises empty, whitespace and nullish', () => {
  assert.equal(isBlank(''), true);
  assert.equal(isBlank('   '), true);
  assert.equal(isBlank(null), true);
  assert.equal(isBlank(undefined), true);
  assert.equal(isBlank('x'), false);
});

/* ── case and slug ───────────────────────────────────────────────────── */

test('titleCase capitalises each word', () => {
  assert.equal(titleCase('hello WORLD'), 'Hello World');
  assert.equal(titleCase("it's a test"), "It's A Test");
});

test('slugify produces a URL-safe slug', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
  assert.equal(slugify('  multiple   spaces  '), 'multiple-spaces');
  assert.equal(slugify('a---b'), 'a-b');
  assert.equal(slugify('!!!'), '');
});

/* ── counting and chunking ───────────────────────────────────────────── */

test('wordCount counts whitespace-delimited words', () => {
  assert.equal(wordCount('one two three'), 3);
  assert.equal(wordCount('   '), 0);
  assert.equal(wordCount(''), 0);
  assert.equal(wordCount('a\nb'), 2);
});

test('chunkText returns the whole string when it fits', () => {
  assert.deepEqual(chunkText('short', 100), ['short']);
  assert.deepEqual(chunkText('', 100), []);
});

test('chunkText splits and every chunk is within the limit', () => {
  const text = 'word '.repeat(200).trim();
  const chunks = chunkText(text, 50);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 50, `chunk too long: ${chunk.length}`);
  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), text.replace(/\s+/g, ' '));
});

test('chunkText prefers a newline boundary', () => {
  const text = `${'a'.repeat(30)}\n${'b'.repeat(30)}`;
  const [first, second] = chunkText(text, 40);
  assert.equal(first, 'a'.repeat(30));
  assert.equal(second, 'b'.repeat(30));
});

test('chunkText rejects a non-positive size', () => {
  assert.throws(() => chunkText('x', 0), /must be positive/);
  assert.throws(() => chunkText('x', -1), /must be positive/);
});

/* ── similarity ──────────────────────────────────────────────────────── */

test('similarity is 1 for identical strings, case-insensitively', () => {
  assert.equal(similarity('Hello', 'hello'), 1);
  assert.equal(similarity('  hi ', 'hi'), 1);
});

test('similarity is 0 for clearly unrelated or too-short inputs', () => {
  assert.equal(similarity('abc', 'xyz'), 0);
  assert.equal(similarity('a', 'b'), 0);
});

test('similarity is between 0 and 1 for partial overlaps and symmetric', () => {
  const score = similarity('night', 'nacht');
  assert.ok(score > 0 && score < 1, `expected 0<${score}<1`);
  assert.equal(similarity('night', 'nacht'), similarity('nacht', 'night'));
});

/* ── initials and mask ───────────────────────────────────────────────── */

test('initials takes up to two initials', () => {
  assert.equal(initials('john doe'), 'JD');
  assert.equal(initials('ada lovelace byron'), 'AL');
  assert.equal(initials('solo'), 'S');
  assert.equal(initials('   '), '');
});

test('mask keeps the ends and hides the middle', () => {
  assert.equal(mask('15551234567'), '1555…4567');
  assert.equal(mask('short'), '*****');
  assert.equal(mask('12345678', 2, 2), '12…78');
});

/* ── misc ────────────────────────────────────────────────────────────── */

test('pluralize handles the singular and plural', () => {
  assert.equal(pluralize(1, 'item'), '1 item');
  assert.equal(pluralize(2, 'item'), '2 items');
  assert.equal(pluralize(0, 'item'), '0 items');
  assert.equal(pluralize(1, 'person', 'people'), '1 person');
});

test('equalsIgnoreCase trims and folds case', () => {
  assert.equal(equalsIgnoreCase(' Yes ', 'yes'), true);
  assert.equal(equalsIgnoreCase('no', 'yes'), false);
});
