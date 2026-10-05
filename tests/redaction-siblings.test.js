/**
 * The sibling set has to follow the recursion, not stop at the root.
 *
 * `walkWithSiblings` set `state.seenKeys` once, at the top-level object, and then
 * handed off to `walk`. Every recursive step inside `walk` called `walk` directly
 * — never `walkWithSiblings` — so no nested object ever got its own sibling set.
 *
 * The visible effect: `CONTEXTUAL_KEYS` (currently just `private`) is resolved
 * against the *root's* keys. At the root, `{ private, public }` masked correctly.
 * One level down, `{ key: { private, public } }` did not, and a private key
 * passed through in plaintext.
 *
 * Depth here is unbounded — a config nested five levels down was never covered.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { redact } from '../dist/security/index.js';

const leaks = (out) => /SECRET-\d/.test(JSON.stringify(out));

test('private beside public is masked at the root', () => {
  const out = redact({ private: 'SECRET-1', public: 'pub' });
  assert.equal(out.private, '[redacted]');
  assert.equal(out.public, 'pub', 'the public half is not a secret');
});

test('private beside public is masked one level down', () => {
  // This is the shape that leaked: a nested object never got its own sibling set.
  const out = redact({ key: { private: 'SECRET-2', public: 'x' } });
  assert.equal(leaks(out), false, `nested private leaked: ${JSON.stringify(out)}`);
});

test('and at every depth, not just one', () => {
  const deep = { a: { b: { c: { private: 'SECRET-3', public: 'x' } } } };
  const out = redact(deep);
  assert.equal(leaks(out), false, `deeply nested private leaked: ${JSON.stringify(out)}`);
});

test('inside arrays too', () => {
  const out = redact({ items: [{ private: 'SECRET-4', public: 'x' }] });
  assert.equal(leaks(out), false, `private in an array leaked: ${JSON.stringify(out)}`);
});

test('private alone stays a visibility flag at every depth', () => {
  // The precision half of the contract. If this regresses, the fix above is just
  // "mask everything named private", which would mangle ordinary config flags.
  assert.equal(redact({ private: 'flag' }).private, 'flag');
  assert.equal(redact({ a: { private: 'flag' } }).a.private, 'flag');
  assert.equal(redact({ a: { b: { private: 'flag' } } }).a.b.private, 'flag');
});

test('a public sibling anywhere in the same object is what counts', () => {
  const out = redact({ private: 'SECRET-5', other: 1, public: 'y' });
  assert.equal(out.private, '[redacted]', 'order must not matter');
});

test('token masking is unaffected by the sibling logic', () => {
  for (const shape of [
    { token: 'SECRET-6' },
    { a: { token: 'SECRET-7' } },
    { a: { b: { token: 'SECRET-8' } } },
    { list: [{ token: 'SECRET-9' }] },
  ]) {
    assert.equal(leaks(redact(shape)), false, `token leaked: ${JSON.stringify(shape)}`);
  }
});