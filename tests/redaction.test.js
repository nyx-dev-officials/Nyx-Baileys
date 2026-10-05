/**
 * Redaction must not have holes.
 *
 * The list of masked credential keys covered every compound form — `apitoken`,
 * `accesstoken`, `bearertoken`, `sessiontoken` — and omitted the base word
 * `token`. That is backwards: `{ token }` is the most common credential field of
 * the lot.
 *
 * It leaked because `token` appeared only in `CONTEXTUAL_KEYS`, whose sibling
 * check requires a neighbouring `public` key. Without one, nothing consulted it
 * and the value passed through in plaintext, at any nesting depth.
 *
 * These tests pin the fix and, just as importantly, pin the case that must NOT
 * be masked: `private` on its own is an ordinary visibility flag, and a redactor
 * that mangles flags is a redactor people turn off.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isSensitiveKey, redact, redactJson } from '../dist/security/index.js';

/** Does any of these secret sentinels survive into the output? */
function leaked(out) {
  const text = JSON.stringify(out);
  return /SECRET-\d/.test(text);
}

test('a bare token field is masked', () => {
  const out = redact({ token: 'SECRET-1' });
  assert.equal(leaked(out), false, `token leaked: ${JSON.stringify(out)}`);
  assert.equal(out.token, '[redacted]');
});

test('token is masked at any depth', () => {
  const out = redact({ a: { b: { token: 'SECRET-2' } }, list: [{ token: 'SECRET-3' }] });
  assert.equal(leaked(out), false, `nested token leaked: ${JSON.stringify(out)}`);
});

test('token is masked whatever the casing or separator', () => {
  // `normalizeKey` lowercases and strips non-alphanumerics, so all of these
  // collapse to the same key and must all be masked.
  for (const key of ['token', 'Token', 'TOKEN', 'api_token', 'apiToken']) {
    const out = redact({ [key]: 'SECRET-4' });
    assert.equal(leaked(out), false, `${key} leaked: ${JSON.stringify(out)}`);
    assert.equal(isSensitiveKey(key), true, `${key} should be sensitive`);
  }
});

test('redactJson masks tokens too', () => {
  // `redactJson` takes a *value* and serialises the result — it does not parse a
  // JSON string. Handing it a string means `redact` receives a string it cannot
  // walk into, so nothing is masked.
  const out = redactJson({ token: 'SECRET-5', name: 'ok' });
  assert.equal(out.includes('SECRET-5'), false, `token leaked: ${out}`);
  assert.equal(out.includes('ok'), true, 'non-secret fields must survive');
});

test('a bare token with no public sibling is masked — the original hole', () => {
  // The exact shape that leaked before: no `public` sibling for the contextual
  // check to key off.
  const out = redact({ config: { token: 'SECRET-6' } });
  assert.equal(leaked(out), false, `config.token leaked: ${JSON.stringify(out)}`);
});

test('private alongside public is masked', () => {
  const out = redact({ private: 'SECRET-7', public: 'pubkey' });
  assert.equal(out.private, '[redacted]');
  assert.equal(out.public, 'pubkey', 'the public half is not a secret');
});

test('private on its own is NOT masked — it is a visibility flag', () => {
  // Regression guard on the opposite side: precision is the point. Masking this
  // would break `{ private: false, public: false }`-shaped config everywhere.
  const out = redact({ private: 'just-a-flag' });
  assert.equal(out.private, 'just-a-flag');
  assert.equal(isSensitiveKey('private'), false);
});

test('private alone is still masked when it sits next to a public key', () => {
  const out = redact({ key: { private: 'SECRET-8', public: 'x' } });
  assert.equal(leaked(out), false);
});

test('the other credential names keep working', () => {
  for (const key of ['password', 'secret', 'apiKey', 'accessToken', 'credential', 'authorization']) {
    const out = redact({ [key]: 'SECRET-9' });
    assert.equal(leaked(out), false, `${key} leaked`);
  }
});

test('a token value is never echoed, even in a stringified payload', () => {
  const out = redact({ headers: { authorization: 'Bearer SECRET-10', token: 'SECRET-11' } });
  assert.equal(leaked(out), false, JSON.stringify(out));
});