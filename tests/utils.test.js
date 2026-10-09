/**
 * Utility command tests.
 *
 * These are the commands a user trusts with real data, so each asserts a known
 * correct value rather than "did not throw". A text utility that quietly returns
 * the wrong number is worse than one that fails.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CommandRegistry } from '../dist/toolkit/command-registry.js';
import { installCoreFamilies } from '../dist/toolkit/command-families.js';
import { installBulkFamilies } from '../dist/toolkit/command-families-bulk.js';

const sock = { sendMessage: async () => ({}) };
const reg = installCoreFamilies(new CommandRegistry());
installBulkFamilies(reg);
const run = (t, x = '') => reg.run(sock, 'x@s.whatsapp.net', t, x);
const text = async (t, x = '') => {
  const r = await run(t, x);
  if (r.error) throw new Error(`${t}: ${r.error}`);
  return r.text ?? '';
};

/* ── case conversion ─────────────────────────────────────────────────── */

test('case conversion is correct in both directions', async () => {
  assert.equal(await text('case-snake', 'Hello World'), 'hello_world');
  assert.equal(await text('case-camel', 'hello-world foo'), 'helloWorldFoo');
  assert.equal(await text('case-kebab', 'HelloWorld'), 'hello-world');
  assert.equal(await text('case-pascal', 'hello_world'), 'HelloWorld');
  assert.equal(await text('case-screaming', 'hello world'), 'HELLO_WORLD');
  assert.equal(await text('case-title', 'hello world'), 'Hello World');
});

test('case conversion handles acronyms and digits', async () => {
  // The split must not mangle HTTPServer or v2Api.
  assert.equal(await text('case-snake', 'HTTPServer'), 'http_server');
  assert.equal(await text('case-camel', 'user_id-2fa'), 'userId2fa');
});

test('invert and alternating swap case without changing letters', async () => {
  assert.equal(await text('case-invert', 'Flux AI'), 'fLUX ai');
  const alt = await text('case-alternating', 'flux');
  assert.equal(alt, 'fLuX');
});

/* ── encoding ────────────────────────────────────────────────────────── */

test('base64 round-trips', async () => {
  const enc = await text('enc-base64', 'Flux AI');
  assert.equal(await text('dec-base64', enc), 'Flux AI');
});

test('hex round-trips including non-ASCII', async () => {
  const enc = await text('enc-hex', 'flux✓');
  assert.match(enc, /^[0-9a-f]+$/);
  assert.equal(await text('dec-hex', enc), 'flux✓');
});

test('url encoding round-trips a query string', async () => {
  const enc = await text('enc-url', 'a=1&b=two words');
  assert.match(enc, /%26/);
  assert.equal(await text('dec-url', enc), 'a=1&b=two words');
});

test('rot13 is its own inverse', async () => {
  const once = await text('enc-rot13', 'Flux');
  assert.notEqual(once, 'Flux');
  assert.equal(await text('enc-rot13', once), 'Flux');
});

test('decoding invalid input errors rather than emitting mojibake', async () => {
  const r = await run('dec-url', '%E0%A4%A');
  assert.ok(r.error, 'malformed percent-encoding must not return garbage');
});

/* ── text utilities ──────────────────────────────────────────────────── */

test('slugify strips diacritics and punctuation', async () => {
  assert.equal(await text('slugify', 'Héllo Wörld! Ünicode'), 'hello-world-unicode');
  assert.equal(await text('slugify', '  --A  B--  '), 'a-b');
});

test('clean-url removes tracking but keeps real parameters', async () => {
  const out = await text('clean-url', 'https://x.com/a?utm_source=n&id=7&fbclid=z');
  const [url] = out.split('\n');
  assert.match(url, /id=7/);
  assert.ok(!url.includes('utm_source'), 'tracking param survived in the URL');
  assert.ok(!url.includes('fbclid'), 'fbclid survived in the URL');
  assert.match(out, /Removed: utm_source, fbclid/);
});

test('clean-url reports when there is nothing to strip', async () => {
  assert.match(await text('clean-url', 'https://x.com/a?id=1'), /No tracking parameters/);
});

test('mdtable aligns columns to equal width', async () => {
  const out = await text('mdtable', 'name,city\nbo,KL\nalexander,Bandung');
  const lines = out.split('\n');
  // Header, separator, then one line per row.
  assert.equal(lines.length, 4);
  const width = lines[0].length;
  for (const l of lines) assert.equal(l.length, width, 'table rows are not aligned');
  assert.match(out, /\| -+ \| -+ \|/);
});

test('password respects length and reports entropy', async () => {
  const out = await text('password', '24');
  const pw = out.split('\n')[0];
  assert.equal(pw.length, 24);
  assert.match(out, /Entropy : ~\d+ bits/);
  // Ambiguous glyphs are excluded by default so a read-back is unambiguous.
  assert.ok(!/[0O1lI]/.test(pw), `password contains ambiguous glyphs: ${pw}`);
});

test('two generated passwords differ', async () => {
  const a = (await text('password', '32')).split('\n')[0];
  const b = (await text('password', '32')).split('\n')[0];
  assert.notEqual(a, b);
});

test('luhn validates a known-good and a known-bad number', async () => {
  assert.match(await text('luhn', '4532015112830366'), /Checksum : VALID/);
  assert.match(await text('luhn', '4532015112830367'), /Checksum : INVALID/);
});

test('roman numerals cover the edge cases', async () => {
  assert.match(await text('roman', '4'), /IV$/);
  assert.match(await text('roman', '1994'), /MCMXCIV$/);
  const out = await run('roman', '4000');
  assert.ok(out.error, 'out-of-range must be refused, not approximated');
});

test('ordinal handles the 11/12/13 exception', async () => {
  assert.match(await text('ordinal', '11'), /11th/);
  assert.match(await text('ordinal', '12'), /12th/);
  assert.match(await text('ordinal', '13'), /13th/);
  assert.match(await text('ordinal', '21'), /21st/);
  assert.match(await text('ordinal', '102'), /102nd/);
});

test('contrast reports the correct ratio and verdicts', async () => {
  const white = await text('contrast', '#000000 #ffffff');
  assert.match(white, /21\.00:1/);
  assert.match(white, /AAA text : PASS/);

  // Two near-identical greys fail every threshold.
  const poor = await text('contrast', '#777777 #787878');
  assert.match(poor, /AA text  : FAIL/);
});

test('cron describes each field', async () => {
  const out = await text('cron', '*/5 * * * *');
  assert.match(out, /minute : \*\/\d+/);
  assert.match(out, /hour   : every hour/);
  assert.match(out, /Field order/);
});

test('dedupe preserves order and reports the count', async () => {
  const out = await text('dedupe', 'a\nb\na\nc\nb');
  assert.equal(out.split('\n')[0], 'a');
  assert.equal(out.split('\n')[1], 'b');
  assert.equal(out.split('\n')[2], 'c');
  assert.match(out, /5 lines → 3 unique \(2 removed\)/);
});

test('sortlines detects numeric ordering', async () => {
  assert.equal((await text('sortlines', '10\n9\n100')).split('\n').join(','), '9,10,100');
  assert.equal((await text('sortlines', 'pear\napple\nfig')).split('\n').join(','), 'apple,fig,pear');
});

test('wordcount counts words, not tokens', async () => {
  const out = await text('wordcount', 'Hello world. This is a test.');
  assert.match(out, /Words      : 6/);
  assert.match(out, /Sentences  : 2/);
});

test('tsconvert parses both a unix timestamp and an ISO date', async () => {
  const fromUnix = await text('tsconvert', '1791542393');
  assert.match(fromUnix, /Unix ms  : \d{13}/);
  const fromIso = await text('tsconvert', '2026-10-07T00:00:00Z');
  assert.match(fromIso, /Unix     : \d{10}/);
  const bad = await run('tsconvert', 'not a date at all');
  assert.ok(bad.error);
});

test('every utility declares what it does', () => {
  const utils = reg.list({ family: 'utility' });
  assert.ok(utils.length >= 12, `expected the utility family, found ${utils.length}`);
  for (const c of utils) assert.ok(c.effect.trim(), `${c.name} has no effect`);
});

test('no utility returns empty output for empty input', async () => {
  // Each must show usage rather than an empty bubble.
  for (const name of ['wordcount', 'slugify', 'clean-url', 'json-fmt', 'cron', 'contrast']) {
    const out = await run(name, '');
    assert.ok((out.text ?? out.error ?? '').length > 0, `${name} returned nothing for empty input`);
  }
});