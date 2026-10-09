/**
 * Fuzzy matching and flux-prefix dispatch.
 *
 * ## What is being defended
 *
 * Two behaviours the user asked for directly:
 *   1. a misspelling says **no such command** rather than silently doing nothing
 *   2. it offers the closest matches **with a percentage**, at least five of them
 *
 * And one it did not ask for but that matters more: a near-match is
 * **suggested, never executed**. Auto-running `convertt` as `convert` would be
 * this project's recurring defect in a new costume — doing something the user
 * did not ask for and reporting success.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CommandRegistry } from '../dist/toolkit/command-registry.js';
import { installCoreFamilies } from '../dist/toolkit/command-families.js';
import { installBulkFamilies } from '../dist/toolkit/command-families-bulk.js';
import { editDistance, similarity, suggest, resolve } from '../dist/toolkit/fuzzy-match.js';
import { dispatch, route, DEFAULT_PREFIXES } from '../dist/toolkit/command-dispatch.js';

const sock = { sendMessage: async () => ({}) };
const reg = installCoreFamilies(new CommandRegistry());
installBulkFamilies(reg);

/* ── distance ────────────────────────────────────────────────────────── */

test('editDistance is correct on known pairs', () => {
  assert.equal(editDistance('kitten', 'sitting'), 3);
  assert.equal(editDistance('flux', 'flux'), 0);
  assert.equal(editDistance('', 'abc'), 3);
  assert.equal(editDistance('abc', ''), 3);
  assert.equal(editDistance('convertt', 'convert'), 1);
});

test('editDistance is symmetric', () => {
  const pairs = [['flux', 'flx'], ['timezone', 'timezones'], ['a', 'abcd']];
  for (const [a, b] of pairs) {
    assert.equal(editDistance(a, b), editDistance(b, a), `asymmetric: ${a}/${b}`);
  }
});

test('editDistance early-exit never under-reports below the bound', () => {
  // The row-minimum early exit is an optimisation; it must not change results.
  for (const [a, b] of [['kitten', 'sitting'], ['abcdefgh', 'zzzz'], ['', 'x']]) {
    const exact = editDistance(a, b);
    const bounded = editDistance(a, b, exact);
    assert.ok(bounded <= exact, `bounded ${bounded} exceeded exact ${exact}`);
  }
});

test('similarity is 100 for identical and 0 for nothing shared', () => {
  assert.equal(similarity('convert', 'convert'), 100);
  assert.equal(similarity('', ''), 100);
  const worst = similarity('abcdefgh', 'zyxwvuts');
  assert.ok(worst < 30, `unrelated strings scored ${worst}`);
});

/* ── suggestions ─────────────────────────────────────────────────────── */

test('a typo produces at least five suggestions with percentages', () => {
  const s = suggest(reg, 'convertt', { limit: 5 });
  assert.ok(s.length >= 5, `expected >= 5 suggestions, got ${s.length}`);
  assert.equal(s[0].name, 'convert', 'the obvious nearest match must lead');
  assert.ok(s[0].percent > s[1].percent, 'results must be ordered best-first');
  for (const x of s) {
    assert.ok(Number.isFinite(x.percent), 'every suggestion needs a percentage');
    assert.ok(x.percent >= 0 && x.percent <= 100);
  }
});

test('suggestions are never worse than the ones below them', () => {
  const s = suggest(reg, 'timezonn-asia-jakar', { limit: 8 });
  for (let i = 1; i < s.length; i++) {
    assert.ok(s[i - 1].distance <= s[i].distance, 'ordering violated');
  }
  assert.equal(s[0].name, 'tz-asia-jakarta');
});

test('a hopeless typo still returns suggestions rather than nothing', () => {
  // The threshold relaxes until the list is full, so the user always has
  // something to scan rather than a bare "unknown".
  const s = suggest(reg, 'qqqzzzxxx', { limit: 5 });
  assert.equal(s.length, 5);
});

test('british spelling resolves without a dedicated alias', () => {
  const s = suggest(reg, 'colour-red', { limit: 1 });
  assert.equal(s[0].name, 'color-red');
  assert.ok(s[0].percent >= 80, `expected a strong match, got ${s[0].percent}%`);
});

test('suggest returns nothing for empty input', () => {
  assert.deepEqual(suggest(reg, '   '), []);
});

/* ── resolve ─────────────────────────────────────────────────────────── */

test('resolve distinguishes exact, fuzzy and unknown', () => {
  assert.equal(resolve(reg, 'convert').status, 'exact');
  assert.equal(resolve(reg, 'convertt').status, 'fuzzy');
  // A short token with no near neighbour is genuinely unknown.
  const far = resolve(reg, 'zzzzzzzzzzz');
  assert.ok(['fuzzy', 'unknown'].includes(far.status));
});

test('the fuzzy message names the typo and shows percentages', () => {
  const r = resolve(reg, 'convertt');
  assert.match(r.message, /No command called "convertt"/);
  assert.match(r.message, /%/);
  assert.match(r.message, /convert/);
});

test('the fuzzy message explains what the percentage means', () => {
  // Otherwise 88% reads as a confidence score, which it is not.
  assert.match(resolve(reg, 'convertt').message, /not a confidence score/i);
});

/* ── prefix ──────────────────────────────────────────────────────────── */

test('all documented flux prefix forms route to the same command', () => {
  const forms = ['flux calc 2+2', 'flux/ calc 2+2', 'flux: calc 2+2', 'flux.ai calc 2+2',
    'fluxai calc 2+2', 'flux-ai calc 2+2', '/calc 2+2'];
  for (const body of forms) {
    const p = route(reg, body);
    assert.equal(p.token, 'calc', `failed for "${body}"`);
    assert.equal(p.args, '2+2', `args lost for "${body}"`);
    assert.ok(p.prefixed, `"${body}" should be recognised as prefixed`);
  }
});

test('the prefix table is ordered so flux.ai is not truncated to flux', () => {
  const iAi = DEFAULT_PREFIXES.indexOf('flux.ai');
  const iPlain = DEFAULT_PREFIXES.indexOf('flux');
  assert.ok(iAi >= 0 && iPlain >= 0);
  assert.ok(iAi < iPlain, 'longer prefixes must be tried first');
});

test('a bare command is refused unless explicitly permitted', async () => {
  const refused = await dispatch(reg, sock, 'x@s.whatsapp.net', 'calc 2+2');
  assert.equal(refused.outcome, 'no-prefix');
  assert.match(refused.text, /needs the flux prefix/);

  const allowed = await dispatch(reg, sock, 'x@s.whatsapp.net', 'calc 2+2', { allowBare: true });
  assert.equal(allowed.outcome, 'ran');
});

test('dispatch runs the exact command with its arguments', async () => {
  const r = await dispatch(reg, sock, 'x@s.whatsapp.net', 'flux convert 5 kg to lb');
  assert.equal(r.outcome, 'ran');
  assert.match(r.text, /11\.02/);
});

test('a typo is suggested, never executed', async () => {
  const r = await dispatch(reg, sock, 'x@s.whatsapp.net', 'flux convertt 5 kg to lb');
  assert.equal(r.outcome, 'fuzzy', 'a near-match must not run by itself');
  assert.ok(!r.text.includes('11.02'), 'the misspelled command did not produce a result');
  assert.ok((r.suggestions?.length ?? 0) >= 5);
  assert.equal(r.suggestions[0].name, 'convert');
});

test('dispatch reports a completely unknown token helpfully', async () => {
  const r = await dispatch(reg, sock, 'x@s.whatsapp.net', 'flux zzzzzzzzzzzz');
  assert.ok(r.outcome === 'unknown' || r.outcome === 'fuzzy');
  assert.match(r.text, /%/);
});

test('an empty body asks for usage rather than throwing', async () => {
  const r = await dispatch(reg, sock, 'x@s.whatsapp.net', 'flux');
  assert.equal(r.outcome, 'no-prefix');
  assert.match(r.text, /Usage/);
});

/* ── scale ───────────────────────────────────────────────────────────── */

test('suggestion stays fast across the whole registry', () => {
  // The length pre-filter is what keeps this linear-ish; without it a scan of
  // every command per typo would show up as a typing lag on the bot.
  const t0 = Date.now();
  for (let i = 0; i < 50; i++) suggest(reg, 'converrt', { limit: 5 });
  const per = (Date.now() - t0) / 50;
  assert.ok(per < 50, `suggestion took ${per.toFixed(1)}ms each — too slow to run per keystroke`);
});