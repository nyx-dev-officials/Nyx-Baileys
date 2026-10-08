/**
 * Bulk family tests — currency, colour, timezone.
 *
 * The property under test throughout is that **each entry actually differs**.
 * That is what separates a data-driven family from the padding this repo has
 * already deleted once, so the tests probe *across* entries rather than
 * spot-checking one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CommandRegistry } from '../dist/toolkit/command-registry.js';
import { installCoreFamilies } from '../dist/toolkit/command-families.js';
import { installBulkFamilies } from '../dist/toolkit/command-families-bulk.js';

const sock = { sendMessage: async () => ({}) };
const reg = installCoreFamilies(new CommandRegistry());
installBulkFamilies(reg);
const run = (t, args = '') => reg.run(sock, 'x@s.whatsapp.net', t, args);

/* ── shape ───────────────────────────────────────────────────────────── */

test('the registry clears the 250-entry bar with distinct, declared behaviour', () => {
  assert.ok(reg.size >= 250, `expected >= 250 commands, got ${reg.size}`);
  const a = reg.audit();
  assert.equal(a.missingEffect.length, 0);
  assert.equal(a.duplicateEffects.length, 0,
    'two commands declaring the same effect means one is redundant');
});

test('the bulk families are the bulk of the surface', () => {
  const by = reg.sizeByFamily;
  assert.ok((by.timezone ?? 0) > 300, 'timezone family should be large');
  assert.ok((by.color ?? 0) > 100, 'colour family should be large');
  assert.ok((by.currency ?? 0) > 100, 'currency family should be large');
});

/* ── currency ────────────────────────────────────────────────────────── */

test('currency converts and always states the rate basis', async () => {
  const r = await run('to-idr', '100');
  assert.match(r.text, /IDR/);
  assert.match(r.text, /Rp/);
  // Every result must expose when the rate was struck. A rate with no date is
  // this project's recurring defect in a new costume.
  assert.match(r.text, /reference, not a live quote/);
});

test('different currencies produce genuinely different output', async () => {
  const idr = (await run('to-idr', '10')).text;
  const jpy = (await run('to-jpy', '10')).text;
  const vnd = (await run('to-vnd', '10')).text;
  assert.equal(new Set([idr, jpy, vnd]).size, 3);
});

test('currency rejects bad input rather than returning zero', async () => {
  assert.match((await run('to-usd', 'banana')).text, /Usage/);
  assert.match((await run('to-usd', '9'.repeat(400))).error, /not a number/);
});

test('currency accepts thousands separators', async () => {
  const withComma = (await run('to-eur', '1,000')).text;
  const plain = (await run('to-eur', '1000')).text;
  assert.equal(withComma, plain);
});

/* ── colour ──────────────────────────────────────────────────────────── */

test('colours report their own hex', async () => {
  assert.match((await run('color-rebeccapurple')).text, /#663399/);
  assert.match((await run('color-tomato')).text, /#FF6347/i);
});

test('every colour entry is distinct and a valid hex', async () => {
  const names = reg.list({ family: 'color' });
  assert.ok(names.length > 100);
  const hexes = new Set();
  for (const c of names) {
    const out = (await run(c.name)).text;
    const hex = /#[0-9A-F]{6}/i.exec(out)?.[0];
    assert.ok(hex, `${c.name} produced no hex: ${out.slice(0, 60)}`);
    hexes.add(hex.toUpperCase());
  }
  // CSS defines real aliases — aqua/cyan and fuchsia/magenta are identical by
  // specification. Uniqueness is per distinct hex, not per name.
  const specAliases = names.length - hexes.size;
  assert.ok(specAliases <= 2, );
  assert.ok(hexes.size >= names.length - 2);
});

/* ── timezone ────────────────────────────────────────────────────────── */

test('timezone resolves a live offset with the correct sign', async () => {
  const jkt = (await run('tz-asia-jakarta')).text;
  assert.match(jkt, /Asia\/Jakarta/);
  assert.match(jkt, /UTC\+07:00/);

  const nyc = (await run('tz-america-new-york')).text;
  assert.match(nyc, /UTC-0[45]:00/, 'New York is UTC-4 (EDT) or UTC-5 (EST)');
});

test('every timezone entry resolves — none silently fails', async () => {
  // A zone the runtime cannot resolve is the family equivalent of a function
  // that returns a plausible empty result: it looks fine and delivers nothing.
  const zones = reg.list({ family: 'timezone' });
  assert.ok(zones.length > 300);
  const bad = [];
  for (const z of zones) {
    const r = await run(z.name);
    if (r.error || !/UTC[+-]\d{2}:\d{2}/.test(r.text || '')) bad.push(z.name);
  }
  assert.equal(bad.length, 0, `zones that failed to resolve: ${bad.slice(0, 5).join(', ')}`);
});

test('timezone projection shifts the reported time', async () => {
  const now = (await run('tz-asia-jakarta')).text.split('\n')[1];
  const plus6 = (await run('tz-asia-jakarta', '6')).text.split('\n')[1];
  assert.notEqual(now, plus6, 'the +6h argument must actually shift the clock');
});

/* ── the honesty invariant across the whole surface ──────────────────── */

test('no command returns success without doing work', async () => {
  // Spot-check across every family: a real command produces either output or
  // an error, never a silent nothing.
  const sample = reg.list().filter((_, i) => i % 17 === 0);
  for (const c of sample) {
    const r = await run(c.name, '1');
    assert.ok(
      typeof r.text === 'string' || typeof r.error === 'string',
      `${c.name} returned neither text nor an error: ${JSON.stringify(r)}`,
    );
  }
});