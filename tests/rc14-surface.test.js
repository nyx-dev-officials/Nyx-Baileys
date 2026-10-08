/**
 * Every `sock.<method>` that src/features/ calls must exist in the installed
 * Baileys — checked against the package on disk, not against memory.
 *
 * ## Why this exists
 *
 * `sendList` shipped green in every mock-based test and threw on every real
 * send, because rc14's `generateWAMessage` has no `listMessage` branch. A fake
 * socket accepts any object, so no unit test can catch that class of bug. This
 * is the static half of the same hunt: it finds calls that name a method rc14
 * never had.
 *
 * ## The failure it catches
 *
 * A guarded call — `if (typeof sock.pinMessage === 'function')` — does not
 * throw. It silently takes the fallback, or returns a plausible empty result.
 * That is *worse* than a crash: the caller cannot tell "the platform cannot do
 * this" from "there was nothing to find". Three such functions shipped this way
 * (`pinMessage` with the wrong shape, `searchMessages`, `getMessageInfo`) and all
 * three now either work or throw loudly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const FEATURES = 'src/features';
const BAILEYS = 'node_modules/@whiskeysockets/baileys/lib';

/** Every method name the installed package exposes, socket or Utils. */
function collectSurface() {
  const surface = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.name.endsWith('.js')) continue;   // skip .map files
      const src = readFileSync(path, 'utf8');
      // Object-literal members across Socket/ and Utils/.
      for (const m of src.matchAll(/^\s{4,10}([a-zA-Z][A-Za-z0-9_]*)\s*[:,(]/gm)) {
        surface.add(m[1]);
      }
      // Anything assigned onto `sock.`
      for (const m of src.matchAll(/sock\.([a-zA-Z][A-Za-z0-9_]*)\s*=/g)) {
        surface.add(m[1]);
      }
      // Named exports of top-level function/const declarations.
      for (const m of src.matchAll(/^export (?:const|function|async function)\s+([a-zA-Z][A-Za-z0-9_]*)/gm)) {
        surface.add(m[1]);
      }
    }
  };
  walk(BAILEYS);
  return surface;
}

const SURFACE = collectSurface();

/** Methods a wrapper legitimately owns rather than delegates. */
const ALLOWED = new Set([
  // Ours, not Baileys: added by the features wrapper for convenience.
  'sendMessage',
]);

test('the rc14 surface was discovered (guard against a broken audit)', () => {
  assert.ok(SURFACE.size > 150,
    `only ${SURFACE.size} methods discovered — the audit is probably not reading the package`);
  for (const known of ['sendMessage', 'groupMetadata', 'chatModify', 'presenceSubscribe']) {
    assert.ok(SURFACE.has(known), `audit missed the known method ${known}`);
  }
});

test('every sock.* call in src/features resolves in rc14', () => {
  const unknown = new Map();

  for (const f of readdirSync(FEATURES).filter((n) => n.endsWith('.ts'))) {
    const src = readFileSync(`${FEATURES}/${f}`, 'utf8');
    src.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/\b(?:sock|_sock)\.([a-zA-Z][A-Za-z0-9_]*)\s*\(/g)) {
        const name = m[1];
        if (SURFACE.has(name) || ALLOWED.has(name)) continue;
        if (!unknown.has(name)) unknown.set(name, []);
        unknown.get(name).push(`${f}:${i + 1}`);
      }
    });
  }

  assert.equal(unknown.size, 0,
    `socket methods called but absent from rc14:\n`
    + [...unknown].map(([n, s]) => `  ${n} — ${s.slice(0, 3).join(', ')}`).join('\n'));
});

test('functions that cannot work in rc14 do not fake success', () => {
  // A guard that returns a plausible empty value is the dangerous shape: the
  // caller cannot distinguish "unsupported" from "no results". These must throw
  // so the gap is visible at the call site.
  const src = readFileSync(`${FEATURES}/messaging.ts`, 'utf8');

  const search = /export async function searchMessages[\s\S]*?\n}/.exec(src)?.[0] ?? '';
  assert.ok(search.includes('throw'),
    'searchMessages must throw — rc14 has no message-search API');
  assert.ok(!/return\s*\{\s*messages:\s*\[\]/.test(search),
    'searchMessages must not return a fake empty result set');

  const info = /export async function getMessageInfo[\s\S]*?\n}/.exec(src)?.[0] ?? '';
  assert.ok(info.includes('throw'),
    'getMessageInfo must throw — rc14 has no fetchMessageInfo');
  assert.ok(!/return null;/.test(info),
    'getMessageInfo must not return null, which reads as "no receipt exists"');
});

test('pinMessage sends the sibling shape rc14 actually reads', () => {
  // Utils/messages.js assigns `pinInChatMessage.key = message.pin` and
  // `.type = message.type`. The key and the type are therefore siblings at the
  // top level. Nesting them inside `pin` — `{ pin: { key, type } }` — puts an
  // object where a MessageKey belongs and protobuf drops it silently.
  const src = readFileSync(`${FEATURES}/messaging.ts`, 'utf8');
  const body = /export async function pinMessage[\s\S]*?\n}/.exec(src)?.[0] ?? '';

  assert.ok(body.includes('pin: params.key'),
    'pin must be the message key itself');
  assert.ok(/type:\s*params\.unpin/.test(body),
    'type must be a sibling of pin, not nested inside it');
  assert.ok(!/pin:\s*\{\s*key:/.test(body),
    'pin must not be nested — that shape is silently dropped by protobuf');
});