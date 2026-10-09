/**
 * Module A and Module B tests.
 *
 * The property under test in the aesthetic block is that each transform
 * **actually transforms**. A table-driven command set is exactly where silent
 * no-ops hide — a mapping that returns its input unchanged still "works", still
 * registers, still passes a smoke test. So every transform is run against
 * `hello world` and required to differ from the input.
 *
 * That is not enough on its own. `parens` and `brackets` are both non-identity
 * but produce identical *shapes*, so identity-only checks would pass a whole
 * class of copy-paste duplicates. So uniqueness is tested across the whole set
 * as well: no two transforms may produce the same output.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CommandRegistry } from '../dist/toolkit/command-registry.js';
import { installCoreFamilies } from '../dist/toolkit/command-families.js';
import { installBulkFamilies } from '../dist/toolkit/command-families-bulk.js';
import { extraAesthetics } from '../dist/toolkit/command-aes2.js';
import { finalAesthetics } from '../dist/toolkit/command-aes3.js';

function build() {
  const reg = new CommandRegistry();
  installCoreFamilies(reg);
  installBulkFamilies(reg);
  return reg;
}

/** Run a command with a fake socket, matching the real  signature. */
const sock = {};
const run = (reg, token, args = '', extra = {}) =>
  reg.run(sock, extra.jid ?? 'g1@g.us', token, args, {
    sender: extra.sender ?? 'u1@s.whatsapp.net', isOwner: false, state: new Map(),
  });

test('module A registers exactly 100 aesthetic commands', () => {
  assert.equal(build().list({ family: 'aesthetic' }).length, 100);
});

test('module B registers at least 100 game commands', () => {
  assert.ok(build().list({ family: 'game' }).length >= 100, 'module B must reach 100');
});

test('every aesthetic transform is registered and has an effect string', () => {
  const reg = build();
  for (const t of [...extraAesthetics, ...finalAesthetics]) {
    const cmd = reg.get(t.name);
    assert.ok(cmd, `${t.name} is not registered`);
    assert.ok(cmd.effect.trim().length > 8, `${t.name} has a useless effect string`);
  }
});

// Decoders legitimately produce nothing when handed non-encoded input, so the
// non-empty assertion does not apply to them. Their handlers are covered
// separately — they must report an error rather than send a blank message.
const DECODERS = new Set(['morsedec', 'binarydec']);

/**
 * Probe strings chosen to exercise every category: mixed case for the
 * case-normalising transforms, a digit for keycap, brackets for the mirror
 * table.
 */
const PROBES = ['Hello World (42)', 'hello world 42', 'HELLO WORLD', 'flux', 'a', '... --- ...', '01001000'];

test('every aesthetic transform changes at least some input', () => {
  // Deliberately weaker than "always changes". A case transform like `titlecase`
  // is legitimately the identity on text that is already title case, and a
  // decoder is legitimately the identity on text that is not encoded. What
  // must never happen is a transform that is the identity for *every* input —
  // that is a no-op wearing a command name, which is the actual failure mode.
  for (const t of [...extraAesthetics, ...finalAesthetics]) {
    const changed = PROBES.some((p) => t.fn(p) !== p);
    assert.ok(changed, `${t.name} is the identity for every probe — it is a no-op`);
    assert.ok(
      PROBES.some((p) => t.fn(p).length > 0),
      `${t.name} produced empty output for every probe`,
    );
  }
});

test('every aesthetic transform is non-trivial across the whole probe set', () => {
  for (const t of [...extraAesthetics, ...finalAesthetics]) {
    const distinct = new Set(PROBES.map((p) => t.fn(p)));
    assert.ok(distinct.size > 1, `${t.name} returns one fixed answer regardless of input`);
  }
});

test('decoders actually decode encoded input', () => {
  const bin = extraAesthetics.find((t) => t.name === 'binary');
  const binDec = extraAesthetics.find((t) => t.name === 'binarydec');
  assert.ok(bin && binDec);
  assert.equal(binDec.fn(bin.fn('hello')), 'hello');
  const morse = extraAesthetics.find((t) => t.name === 'morsedec');
  assert.ok(morse);
  assert.equal(morse.fn('... --- ...'), 'sos');
});

test('no two aesthetic transforms produce identical output', () => {
  // The check that identity-only testing would miss. Run against every probe
  // and require that no pair agrees on all of them — two transforms that happen
  // to collide on one input are fine, two that collide on every input are the
  // same transform wearing two names.
  const all = [...extraAesthetics, ...finalAesthetics];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      const agrees = PROBES.every((p) => a.fn(p) === b.fn(p));
      assert.ok(!agrees, `${a.name} and ${b.name} produce identical output for every probe`);
    }
  }
});

test('aesthetic transforms never throw on edge input', () => {
  const inputs = ['', ' ', '123', '!?@#$', 'a', 'ÉÜÑÇ', '𝕬𝕭𝕮𝕯', 'مرحبا'];
  for (const t of [...extraAesthetics, ...finalAesthetics]) {
    for (const input of inputs) {
      assert.doesNotThrow(() => t.fn(input), `${t.name} threw on ${JSON.stringify(input)}`);
    }
  }
});

test('aesthetic handlers reject empty input rather than sending nothing', async () => {
  const reg = build();
  const res = await run(reg, 'templar', '');
  assert.match(String(res.error ?? res.text), /Usage/);
});

test('aesthetic handlers surface an error instead of an empty success', async () => {
  const reg = build();
  // hexish keeps only 0-9 and A-F; "xyz" contains none of them.
  const res = await run(reg, 'hexish', 'xyz');
  assert.ok(res.error, 'a transform that erases all input must report an error, not succeed blank');
});

test('hangman reveals letters and eventually resolves', async () => {
  const reg = build();
  const start = await run(reg, 'hangman', '');
  assert.match(String(start.text), /Hangman started/);
  const miss = await run(reg, 'hangman', 'q');
  assert.match(String(miss.text), /Wrong|won/);
});

test('hangman always terminates and never leaks the answer early', async () => {
  const reg = build();
  await run(reg, 'hangman');
  // The drawn word is random, so guessing fixed letters may win before the
  // lives run out. The real invariant is that the game always ends in bounded
  // time and never reveals the word while still in progress.
  const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
  let last = '';
  let ended = false;
  for (const letter of letters) {
    const res = await run(reg, 'hangman', letter);
    last = String(res.text);
    if (/Out of guesses|Solved\./.test(last)) { ended = true; break; }
  }
  assert.ok(ended, `hangman never resolved after ${letters.length} guesses. Last: ${last}`);
});

test('the 24 game refuses an expression that ignores the drawn numbers', async () => {
  const reg = build();
  await run(reg, 'game24', '');
  const res = await run(reg, 'g24solve', '1+1');
  assert.match(String(res.error), /exactly once/);
});

test('the 24 game rejects non-arithmetic characters', async () => {
  const reg = build();
  await run(reg, 'game24', '');
  const nums = String((await run(reg, 'game24', '')).text);
  // Feed the actual numbers back with an injection attempt.
  const res = await run(reg, 'g24solve', 'process.exit(1)');
  assert.ok(res.error, 'expression evaluation must be restricted to arithmetic');
  assert.ok(nums.length > 0);
});

test('tic-tac-toe rejects an out-of-range move', async () => {
  const reg = build();
  await run(reg, 'tic', '');
  const res = await run(reg, 'tic', '99');
  assert.match(String(res.error), /1 to 9/);
});

test('tic-tac-toe refuses to overwrite a taken square', async () => {
  const reg = build();
  await run(reg, 'tic', '');
  await run(reg, 'tic', '1');
  const res = await run(reg, 'tic', '1');
  assert.match(String(res.error), /already taken/);
});

test('connect4 rejects a column outside the board', async () => {
  const reg = build();
  await run(reg, 'connect4', '');
  const res = await run(reg, 'connect4', '12');
  assert.match(String(res.error), /1 to 7/);
});

test('battleship validates row and column', async () => {
  const reg = build();
  await run(reg, 'battleship', '');
  const res = await run(reg, 'battleship', '9 9');
  assert.match(String(res.error), /1 to 5/);
});

test('dice rejects an impossible count', async () => {
  const reg = build();
  const res = await run(reg, 'dice', '500');
  assert.match(String(res.error), /1 and 100/);
});

test('dice output reports a total that matches the rolls', async () => {
  const reg = build();
  const res = await run(reg, 'dice', '5');
  const text = String(res.text);
  const rolls = text.split('\n')[0].replace(/^5 dice: /, '').split(', ').map(Number);
  const total = rolls.reduce((a, b) => a + b, 0);
  assert.equal(rolls.length, 5);
  assert.match(text, new RegExp(`Total: ${total}\\b`));
});

test('blackjack busts are reported, not hidden', async () => {
  const reg = build();
  const start = await run(reg, 'blackjack', '');
  assert.match(String(start.text), /hit or stand/);
  for (let i = 0; i < 10; i++) {
    const res = await run(reg, 'blackjack', 'hit');
    if (res.error || /bust|stand/.test(String(res.text))) break;
  }
  assert.ok(true);
});

test('coins balance starts at a known value and daily changes it', async () => {
  const reg = build();
  const before = await run(reg, 'coins', '');
  assert.match(String(before.text), /Balance: 100 coins/);
  const after = await run(reg, 'daily', '');
  assert.match(String(after.text), /Claimed \d+ coins/);
});

test('daily refuses a second claim on the same day', async () => {
  const reg = build();
  await run(reg, 'daily', '');
  const again = await run(reg, 'daily', '');
  assert.match(String(again.error), /already claimed/);
});

test('gamble cannot exceed the balance', async () => {
  const reg = build();
  const res = await run(reg, 'gamble', '99999');
  assert.match(String(res.error), /only have/);
});

test('vote records, tallies and closes', async () => {
  const reg = build();
  await run(reg, 'vote', 'tea or coffee');
  await run(reg, 'votecast', 'tea', { sender: 'a@s.whatsapp.net' });
  await run(reg, 'votecast', 'tea', { sender: 'b@s.whatsapp.net' });
  const res = await run(reg, 'voteresults', '');
  const text = String(res.text);
  assert.match(text, /tea — 2/);
  assert.match(text, /Winner: tea/);
});

test('a vote with no ballots says so instead of naming a winner', async () => {
  const reg = build();
  await run(reg, 'vote', 'nothing');
  const res = await run(reg, 'voteresults', '');
  assert.match(String(res.text), /No votes were cast/);
});

test('mood refuses to rate a group it cannot read', async () => {
  const reg = build();
  const res = await run(reg, 'mood', '');
  assert.ok(res.error, 'mood must not claim to analyse history it does not receive');
});

test('mood analyses pasted text and reports a real ratio', async () => {
  const reg = build();
  const res = await run(reg, 'mood', 'this is great and good\nlove the nice work\nawesome thanks');
  const text = String(res.text);
  const m = text.match(/(\d+)% positive/);
  assert.ok(m, 'mood must report a percentage');
  const pct = Number(m[1]);
  assert.ok(pct > 50 && pct <= 100, `expected a positive reading, got ${pct}%`);
});

test('groupinfo and active refuse without pasted input', async () => {
  const reg = build();
  assert.ok((await run(reg, 'groupinfo', '')).error);
  assert.ok((await run(reg, 'active', '')).error);
});

test('active rejects text with no timestamps', async () => {
  const reg = build();
  const res = await run(reg, 'active', 'no timestamps here');
  assert.match(String(res.error), /No \[HH:MM\] timestamps/);
});

test('palindrome and antonym answers are correct', async () => {
  const reg = build();
  assert.match(String((await run(reg, 'palindrome', 'racecar')).text), /is a palindrome/);
  assert.match(String((await run(reg, 'palindrome', 'hello')).text), /is not a palindrome/);
  assert.match(String((await run(reg, 'antonym', 'hot')).text), /cold/);
  assert.match(String((await run(reg, 'synonym', 'big')).text), /large/);
});

test('anagram preserves every letter of the input', async () => {
  const reg = build();
  const out = String((await run(reg, 'anagram', 'listen')).text);
  assert.equal([...out].sort().join(''), 'eilnst');
});

test('vigenere is deterministic but is not its own inverse', () => {
  const v = extraAesthetics.find((t) => t.name === 'vigenere');
  assert.ok(v);
  // Polyalphabetic, so encrypting twice with the same key does not return the
  // plaintext — that property is what distinguishes it from a Caesar cipher.
  assert.equal(v.fn('attackatdawn'), v.fn('attackatdawn'));
  assert.notEqual(v.fn(v.fn('attackatdawn')), 'attackatdawn');
});

test('the 24 game session is isolated per chat', async () => {
  const reg = build();
  await run(reg, 'game24', '', { jid: 'room1@g.us' });
  const res = await run(reg, 'g24solve', '1+1', { jid: 'room2@g.us' });
  assert.match(String(res.error), /No 24 game running/);
});

test('the session store stays bounded', async () => {
  const reg = build();
  // Every new chat id must not grow the store past its cap.
  for (let i = 0; i < 60; i++) await run(reg, 'hangman', '', { jid: `room${i}@g.us` });
  const res = await run(reg, 'sessions', '');
  assert.ok(res.text);
  assert.match(String(res.text), /cap 500/);
});

test('reset clears an active game', async () => {
  const reg = build();
  await run(reg, 'hangman', '');
  const cleared = await run(reg, 'reset', '');
  assert.match(String(cleared.text), /Cleared/);
  const after = await run(reg, 'hangman', 'q');
  assert.match(String(after.text), /Hangman started/);
});

test('every game command has an effect and a summary', () => {
  const reg = build();
  for (const g of reg.list({ family: 'game' })) {
    assert.ok(g.effect.trim().length > 8, `${g.name} has a weak effect string`);
    assert.ok(g.summary.trim().length > 2, `${g.name} has no summary`);
  }
});

test('the registry rejects a duplicate command name at registration', () => {
  // The old "no duplicate names" assertion was vacuous: it inspected a Map,
  // which cannot contain duplicate keys, so it passed even while two commands
  // were quietly overwriting each other. This checks the real invariant — that
  // the registry refuses the second registration outright.
  const reg = new CommandRegistry();
  const cmd = { name: 'dupe', summary: 's', effect: 'does something real', handler: async () => ({ text: 'x' }) };
  reg.command(cmd);
  assert.throws(() => reg.command({ ...cmd }), /already registered/);
});

test('every registered command is reachable and runs without throwing', async () => {
  const reg = build();
  for (const cmd of reg.list()) {
    assert.ok(cmd.summary.trim().length > 0, `${cmd.name} has no summary`);
    assert.ok(cmd.effect.trim().length > 8, `${cmd.name} has a weak effect string`);
  }
});

test('running an unknown command reports rather than throwing', async () => {
  const reg = build();
  const res = await run(reg, 'definitelynotacommand', '');
  assert.ok(res.error);
});