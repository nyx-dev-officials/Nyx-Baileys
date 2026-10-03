/**
 * Command-argument parsing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { firstArg, flagValue, hasFlag, parseArgs, restFrom, tokenizeArgs } from '../dist/utils/args.js';

/* ── tokenizeArgs ────────────────────────────────────────────────────── */

test('tokenizeArgs splits on runs of whitespace', () => {
  assert.deepEqual(tokenizeArgs('a  b\tc\nd'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(tokenizeArgs('   '), []);
  assert.deepEqual(tokenizeArgs(''), []);
});

test('tokenizeArgs keeps quoted spans whole and drops the quotes', () => {
  assert.deepEqual(tokenizeArgs('say "hello world"'), ['say', 'hello world']);
  assert.deepEqual(tokenizeArgs("say 'hello world'"), ['say', 'hello world']);
  assert.deepEqual(tokenizeArgs('a "b c" d'), ['a', 'b c', 'd']);
});

test('tokenizeArgs preserves empty quoted arguments', () => {
  assert.deepEqual(tokenizeArgs('a "" b'), ['a', '', 'b']);
});

test('tokenizeArgs keeps the other quote character literally', () => {
  assert.deepEqual(tokenizeArgs(`"it's" fine`), ["it's", 'fine']);
});

/* ── parseArgs ───────────────────────────────────────────────────────── */

test('parseArgs separates positional words from flags', () => {
  const { positional, flags } = parseArgs('kick 15551234567 --reason rude -f');
  assert.deepEqual(positional, ['kick', '15551234567']);
  assert.equal(flags.reason, 'rude');
  assert.equal(flags.f, true);
});

test('parseArgs supports inline values', () => {
  const { flags } = parseArgs('--name=value --empty=');
  assert.equal(flags.name, 'value');
  assert.equal(flags.empty, '');
});

test('a quoted flag value stays one argument', () => {
  const { flags } = parseArgs('--reason "being very rude"');
  assert.equal(flags.reason, 'being very rude');
});

test('a flag does not swallow the next flag as its value', () => {
  const { flags } = parseArgs('--verbose --dry-run');
  assert.equal(flags.verbose, true);
  assert.equal(flags['dry-run'], true);
});

test('a negative number is positional, but can be a flag value', () => {
  const { positional, flags } = parseArgs('set -5 --level -3');
  assert.deepEqual(positional, ['set', '-5']);
  assert.equal(flags.level, '-3', 'dash-number after a flag is its value');
});

test('a bare dash is positional', () => {
  const { positional, flags } = parseArgs('a - b');
  assert.deepEqual(positional, ['a', '-', 'b']);
  assert.deepEqual(flags, {});
});

test('parseArgs keeps the raw input', () => {
  assert.equal(parseArgs('x --y 1').raw, 'x --y 1');
});

test('parseArgs on an empty body is empty', () => {
  const parsed = parseArgs('');
  assert.deepEqual(parsed.positional, []);
  assert.deepEqual(parsed.flags, {});
});

/* ── accessors ───────────────────────────────────────────────────────── */

test('flagValue returns the string or the fallback', () => {
  const { flags } = parseArgs('--name bob --loud');
  assert.equal(flagValue(flags, 'name'), 'bob');
  assert.equal(flagValue(flags, 'loud'), null, 'a boolean flag has no string value');
  assert.equal(flagValue(flags, 'missing', 'x'), 'x');
});

test('hasFlag is presence, not truthiness', () => {
  const { flags } = parseArgs('--loud --empty=');
  assert.equal(hasFlag(flags, 'loud'), true);
  assert.equal(hasFlag(flags, 'empty'), true);
  assert.equal(hasFlag(flags, 'missing'), false);
});

test('restFrom joins the tail', () => {
  assert.equal(restFrom(['a', 'b', 'c'], 1), 'b c');
  assert.equal(restFrom(['a', 'b', 'c']), 'a b c');
  assert.equal(restFrom([], 2), '');
});

test('firstArg returns the head or null', () => {
  assert.equal(firstArg(['a', 'b']), 'a');
  assert.equal(firstArg([]), null);
});
