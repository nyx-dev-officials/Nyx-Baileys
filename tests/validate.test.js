/**
 * Small pure predicates.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  countEmoji,
  extractEmoji,
  hasEmoji,
  isBase64,
  isEmail,
  isEmojiOnly,
  isHex,
  isInteger,
  isNumeric,
  isPhone,
  isUrl,
  normalizePhone,
  stripEmoji,
  toE164,
} from '../dist/utils/validate.js';

test('isUrl accepts only absolute http(s) urls', () => {
  assert.equal(isUrl('https://example.com/a?b=1'), true);
  assert.equal(isUrl('http://localhost:3000'), true);
  assert.equal(isUrl('ftp://example.com'), false);
  assert.equal(isUrl('example.com'), false);
  assert.equal(isUrl('javascript:alert(1)'), false);
  assert.equal(isUrl(''), false);
});

test('isEmail is a shape check', () => {
  assert.equal(isEmail('a@b.co'), true);
  assert.equal(isEmail(' first.last@sub.domain.io '), true);
  assert.equal(isEmail('nope'), false);
  assert.equal(isEmail('a@b'), false);
  assert.equal(isEmail('a b@c.d'), false);
});

test('isPhone accepts common separators and length bounds', () => {
  assert.equal(isPhone('+1 (555) 123-4567'), true);
  assert.equal(isPhone('15551234567'), true);
  assert.equal(isPhone('123456'), false, 'too short');
  assert.equal(isPhone('1234567890123456'), false, 'too long');
  assert.equal(isPhone('call me'), false);
});

test('normalizePhone strips everything but digits', () => {
  assert.equal(normalizePhone('+1 (555) 123-4567'), '15551234567');
  assert.equal(normalizePhone('+1 (555) 123-4567', true), '+15551234567');
  assert.equal(normalizePhone(''), '');
});

test('toE164 normalises or rejects', () => {
  assert.equal(toE164('+1 555 123 4567'), '+15551234567');
  assert.equal(toE164('12'), null);
});

test('isNumeric and isInteger', () => {
  assert.equal(isNumeric('123'), true);
  assert.equal(isNumeric('-1'), false);
  assert.equal(isNumeric('1.2'), false);
  assert.equal(isInteger('-1'), true);
  assert.equal(isInteger('+1'), true);
  assert.equal(isInteger('1.2'), false);
});

test('isHex requires even-length hex', () => {
  assert.equal(isHex('deadbeef'), true);
  assert.equal(isHex('0xDEADBEEF'), true);
  assert.equal(isHex('abc'), false, 'odd length');
  assert.equal(isHex('zz'), false);
});

test('isBase64 requires the alphabet and padding', () => {
  assert.equal(isBase64('aGVsbG8='), true);
  assert.equal(isBase64('YWJj'), true);
  assert.equal(isBase64('abc'), false, 'not a multiple of four');
  assert.equal(isBase64('a b c'), false);
});

test('emoji detection counts and extracts', () => {
  assert.equal(hasEmoji('hi 🎉'), true);
  assert.equal(hasEmoji('plain'), false);
  assert.equal(countEmoji('🎉🎉 ok 👍'), 3);
  assert.deepEqual(extractEmoji('a🎉b👍'), ['🎉', '👍']);
});

test('isEmojiOnly', () => {
  assert.equal(isEmojiOnly('🎉'), true);
  assert.equal(isEmojiOnly('🎉 👍'), true);
  assert.equal(isEmojiOnly('🎉 hi'), false);
  assert.equal(isEmojiOnly(''), false);
  assert.equal(isEmojiOnly('   '), false);
});

test('stripEmoji removes pictographs and tightens whitespace', () => {
  assert.equal(stripEmoji('hello 🎉 world'), 'hello world');
  assert.equal(stripEmoji('🎉🎉'), '');
  assert.equal(stripEmoji('a👍b'), 'ab');
});
