/**
 * Content-integrity checks for the live-API family.
 *
 * ## What this catches
 *
 * The `genderize` summary was overwritten with a raw response template
 * (`{name}: {gender} ({probability}%)`) by a bulk edit that was meant to touch
 * only the format table. It shipped: the command's help text literally showed
 * users its placeholder syntax.
 *
 * That is the generalisable failure — bulk edits across a generated file bleed
 * into adjacent tables, and nothing in a type check notices because a string is
 * a string. So the invariant is pinned: **human-facing text contains no
 * template syntax**, and the two tables are checked for cross-contamination.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { API_ENDPOINTS, API_UNVERIFIED, readPath, applyFormat } from '../dist/toolkit/command-api.js';
import { CommandRegistry } from '../dist/toolkit/command-registry.js';
import { installCoreFamilies } from '../dist/toolkit/command-families.js';
import { installBulkFamilies } from '../dist/toolkit/command-families-bulk.js';

/** Template syntax that must never appear in prose. */
const TEMPLATE_LEAK = /[{}]|~/;

test('no endpoint summary leaks response-template syntax', () => {
  for (const ep of API_ENDPOINTS) {
    assert.ok(!TEMPLATE_LEAK.test(ep.summary),
      `${ep.label} summary leaks template syntax: ${JSON.stringify(ep.summary)}`);
    assert.ok(ep.summary.trim().length > 0, `${ep.label} has an empty summary`);
  }
});

test('summaries are prose, not reused from another endpoint', () => {
  // A summary identical to another's means a bulk edit crossed two tables.
  const seen = new Map();
  const dupes = [];
  for (const ep of API_ENDPOINTS) {
    if (seen.has(ep.summary)) dupes.push(`${ep.label} and ${seen.get(ep.summary)} share a summary`);
    seen.set(ep.summary, ep.label);
  }
  assert.equal(dupes.length, 0, dupes.join('; '));
});

test('the genderize summary is the intended prose', () => {
  // Regression for the exact leak found in the Indonesian wiring.
  const g = API_ENDPOINTS.find((e) => e.label === 'genderize');
  assert.ok(g, 'genderize endpoint missing');
  assert.match(g.summary, /gender/i);
  assert.ok(!g.summary.includes('{'), 'summary still contains a placeholder');
});

test('every endpoint declares a real URL and a category', () => {
  for (const ep of API_ENDPOINTS) {
    assert.match(ep.url, /^https:\/\//, `${ep.label} is not HTTPS`);
    assert.ok(ep.category.trim().length > 0, `${ep.label} has no category`);
    assert.match(ep.name, /^[a-z0-9-]+$/, `${ep.name} is not a valid command name`);
  }
});

test('unverified endpoints carry a reason, never a blank entry', () => {
  assert.ok(API_UNVERIFIED.length > 0);
  for (const u of API_UNVERIFIED) {
    assert.ok(u.reason.trim().length > 0, `${u.label} has no failure reason recorded`);
    assert.ok(!/^ok$/i.test(u.reason), `${u.label} recorded as ok but is listed unverified`);
  }
});

/* ── path resolution ─────────────────────────────────────────────────── */

test('readPath walks objects and array elements', () => {
  assert.equal(readPath({ a: { b: 2 } }, 'a.b'), 2);
  assert.equal(readPath({ items: [{ id: 'x' }] }, 'items.0.id'), 'x');
  assert.equal(readPath({ n: null }, 'n'), null);
});

test('readPath returns undefined rather than throwing on a bad path', () => {
  // A missing field in a third-party response is normal and must not crash.
  assert.equal(readPath({ a: 1 }, 'a.b.c.d'), undefined);
  assert.equal(readPath(null, 'a'), undefined);
  assert.equal(readPath({ items: [] }, 'items.0.id'), undefined);
});

test('applyFormat substitutes and marks absent paths', () => {
  const out = applyFormat('Name {a.name} Age {a.age}', { a: { name: 'Flux', age: 4 } });
  assert.equal(out, 'Name Flux Age 4');

  const partial = applyFormat('{a} {b} {c} {d}', { a: 1, b: 2, c: 3 });
  assert.match(partial, /\(missing\)/);
});

test('applyFormat falls back to a readable dump when most paths miss', () => {
  // This is what stopped 27 endpoints rendering nothing useful.
  const out = applyFormat('{x.one} {x.two} {x.three} {x.four}', { real: 'value', other: 1 });
  assert.match(out, /---/);
  assert.match(out, /real: value/);
});

test('applyFormat with no template summarises the response', () => {
  const out = applyFormat('', { name: 'Flux', count: 3 });
  assert.match(out, /name: Flux/);
  assert.match(out, /count: 3/);
});

/* ── the family registers cleanly ────────────────────────────────────── */

test('every live-api command registers and declares an effect', () => {
  const reg = installCoreFamilies(new CommandRegistry());
  installBulkFamilies(reg);
  const cmds = reg.list({ family: 'live-api' });
  assert.equal(cmds.length, API_ENDPOINTS.length);
  for (const c of cmds) assert.ok(c.effect.trim(), `${c.name} has no effect`);
});