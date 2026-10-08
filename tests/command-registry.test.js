/**
 * Command registry and family tests.
 *
 * ## The rule these enforce
 *
 * A command that returns a plausible result without doing the work is worse
 * than one that throws. This repo has already deleted five of those, so the
 * registry refuses to create more: a family whose entries carry identical data
 * is rejected at registration rather than shipped.
 *
 * The validator tests below are the direct consequence. Each one corresponds to
 * a way this surface could lie while still looking complete.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CommandRegistry, FamilyError, validateFamily, expandFamily } from '../dist/toolkit/command-registry.js';
import { installCoreFamilies, mathFamily, unitFamilies } from '../dist/toolkit/command-families.js';

const sock = { sendMessage: async () => ({}) };
const run = (reg, token, args) => reg.run(sock, 'x@s.whatsapp.net', token, args);

/* ── registry integrity ──────────────────────────────────────────────── */

test('a command must declare what it does', () => {
  const reg = new CommandRegistry();
  assert.throws(
    () => reg.command({ name: 'x', summary: 's', effect: '  ', handler: async () => ({}) }),
    /has no effect/,
    'a command with no declared effect is exactly a plausible-looking stub',
  );
});

test('command names must be lowercase kebab-case', () => {
  const reg = new CommandRegistry();
  const mk = (name) => ({ name, summary: 's', effect: 'e', handler: async () => ({}) });
  for (const bad of ['X', 'has space', '1leading', 'has_underscore', '']) {
    assert.throws(() => reg.command(mk(bad)), FamilyError, `accepted "${bad}"`);
  }
});

test('a family with two identical data entries is rejected', () => {
  assert.throws(() => validateFamily({
    id: 'dup', title: 't',
    entries: [
      { name: 'a', summary: 's', data: { same: 1 } },
      { name: 'b', summary: 's', data: { same: 1 } },
    ],
    build: async () => ({ text: 'x' }),
  }), /duplicates another entry/, 'two names for one behaviour is padding, not a feature');
});

test('a family with duplicate command names is rejected', () => {
  assert.throws(() => validateFamily({
    id: 'dupname', title: 't',
    entries: [
      { name: 'a', summary: 's', data: 1 },
      { name: 'a', summary: 's', data: 2 },
    ],
    build: async () => ({ text: 'x' }),
  }), /duplicate command/);
});

test('an empty family is rejected', () => {
  assert.throws(() => validateFamily({
    id: 'empty', title: 't', entries: [], build: async () => ({ text: 'x' }),
  }), /no entries/);
});

test('the built-in families register cleanly', () => {
  const reg = installCoreFamilies(new CommandRegistry());
  assert.ok(reg.size > 80, `expected a real surface, got ${reg.size}`);
  assert.equal(reg.audit().missingEffect.length, 0);
  assert.equal(reg.audit().duplicateEffects.length, 0,
    'two commands claiming the same effect means one is redundant');
});

test('calc is registered once, with math as an alias', () => {
  // Two entries with identical data were rejected at registration; `math` is
  // an alias instead, which is the honest way to have a second name.
  const reg = installCoreFamilies(new CommandRegistry());
  const byFamily = reg.list({ family: 'math' });
  assert.equal(byFamily.length, 1);
  assert.equal(byFamily[0].name, 'calc');
  assert.ok(reg.get('math'), 'math resolves via the alias');
  assert.equal(reg.get('math').family, 'math');
});

/* ── the evaluator, including its tokenizer ──────────────────────────── */

test('calc honours precedence and parentheses', async () => {
  const reg = installCoreFamilies(new CommandRegistry());
  assert.match((await run(reg, 'calc', '2+3*4')).text, /= 14/);
  assert.match((await run(reg, 'calc', '(2+3)*4')).text, /= 20/);
});

test('calc handles ** and sqrt', async () => {
  const reg = installCoreFamilies(new CommandRegistry());
  // Regression: `**` must precede the single-char operator class in the
  // tokenizer, or `pi^2` becomes two `*` tokens and reports "malformed".
  assert.match((await run(reg, 'calc', '2^10')).text, /= 1024/);
  assert.match((await run(reg, 'calc', 'sqrt(144)/5')).text, /= 2\.4/);
  assert.match((await run(reg, 'calc', 'sqrt(16)*2 + pi^2')).text, /= 17\.869/);
});

test('calc refuses nonsense rather than guessing', async () => {
  const reg = installCoreFamilies(new CommandRegistry());
  assert.match((await run(reg, 'calc', '1/0')).error, /division by zero/);
  assert.match((await run(reg, 'calc', 'sqrt(-1)')).error, /negative/);
  // Unary minus is a prefix operator, not a rewrite to (0-x): the naive rewrite
  // turns 2*-3 into 2*0-3 and returns -3.
  assert.match((await run(reg, 'calc', '2*-3')).text, /= -6/);
  assert.match((await run(reg, 'calc', '-5+8')).text, /= -13/);
  assert.match((await run(reg, 'calc', '--5')).text, /= 5/);
  assert.match((await run(reg, 'calc', 'wat')).error, /unknown name/);
  assert.match((await run(reg, 'calc', '(1+2')).error, /unbalanced/);
});

test('calc with no argument explains itself', async () => {
  const reg = installCoreFamilies(new CommandRegistry());
  const r = await run(reg, 'calc', '');
  assert.match(r.text, /Usage/);
});

/* ── units ───────────────────────────────────────────────────────────── */

test('unit conversion is arithmetically correct', async () => {
  const reg = installCoreFamilies(new CommandRegistry());
  assert.match((await run(reg, 'to-in', '2.5 m to in')).text, /= 98\.425/);
  assert.match((await run(reg, 'to-mib', '1.5 GB to MiB')).text, /= 1430\.51/);
  assert.match((await run(reg, 'to-nmi', '10 km to nmi')).text, /= 5\.3995/);
});

test('temperature uses offsets, not just factors', async () => {
  // A pure factor table cannot express temperature — 0 degC is 273.15 K.
  const reg = installCoreFamilies(new CommandRegistry());
  assert.match((await run(reg, 'to-degf', '0 C to F')).text, /= 32/);
  assert.match((await run(reg, 'to-degf', '100 C to F')).text, /= 212/);
  assert.match((await run(reg, 'to-degf', '-40 C to F')).text, /-40/);   // the fixed point
  assert.match((await run(reg, 'to-degc', '98.6 F to C')).text, /= 37/);
});

test('an unknown unit is reported with the valid set', async () => {
  const reg = installCoreFamilies(new CommandRegistry());
  const r = await run(reg, 'to-inch', '5 parsec to inch');
  // `to-inch` does not exist (the unit is `in`), so this must be an unknown
  // command — and it must not silently succeed as something else.
  assert.match(r.error, /Unknown command/);
});

test('malformed unit input explains the expected form', async () => {
  const reg = installCoreFamilies(new CommandRegistry());
  const r = await run(reg, 'to-in', 'banana');
  assert.match(r.error, /Usage: <value> <from> to in/);
  assert.match(r.error, /Known length units/);
});

/* ── runtime safety ──────────────────────────────────────────────────── */

test('a throwing handler becomes an error, never an unhandled rejection', async () => {
  const reg = new CommandRegistry();
  reg.command({
    name: 'boom', summary: 's', effect: 'throws on purpose',
    handler: async () => { throw new Error('kaboom'); },
  });
  const r = await run(reg, 'boom', '');
  assert.match(r.error, /boom failed: kaboom/);
});

test('a handler returning nothing is reported, not treated as success', async () => {
  const reg = new CommandRegistry();
  reg.command({
    name: 'void', summary: 's', effect: 'returns undefined',
    handler: async () => undefined,
  });
  const r = await run(reg, 'void', '');
  assert.match(r.error, /returned nothing/);
});

test('unknown commands say so', async () => {
  const reg = new CommandRegistry();
  assert.match((await run(reg, 'nope', '')).error, /Unknown command: nope/);
});

test('every unit family has distinct entry data', () => {
  // Guards the honesty property at the source: if a table ever gains a
  // duplicate, expansion stops rather than shipping two names for one command.
  for (const f of unitFamilies) {
    const seen = new Set(f.entries.map((e) => JSON.stringify(e.data)));
    assert.equal(seen.size, f.entries.length, `family ${f.id} has duplicate entries`);
  }
});

test('expanding a family yields that many commands', () => {
  const cmds = expandFamily(mathFamily);
  assert.equal(cmds.length, mathFamily.entries.length);
  for (const c of cmds) assert.ok(c.effect.trim());
});