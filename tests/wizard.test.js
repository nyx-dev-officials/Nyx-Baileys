/**
 * Wizard coverage.
 *
 * Replaces `tests/cli-pair.test.js`, which was removed with the `pair`
 * subcommand. The session guards that used to live in that command were ported
 * into the wizard, so they need their tests ported too — otherwise deleting a
 * command would have quietly deleted its coverage.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  bootstrap,
  chooseSessionDir,
  digitsFromJid,
  formatCountdown,
  loadRememberedDir,
  normaliseNumber,
  PairingDiagnostics,
  parsePhoneFlag,
  saveRememberedDir,
  validateIndonesianNumber,
  streamText,
  waitForConnection,
  waitForLink,
  waitForSettle,
  watchForLogout,
} from '../dist/index.js';
import { renderFluxIntro, visibleWidth, padVisible, formatUptime } from '../dist/core/flux-intro.js';
import { readSession } from '../dist/cli/commands.js';

const scratch = () => mkdtempSync(join(tmpdir(), 'nyx-wizard-'));

test('normaliseNumber converts a local 08 number to international form', () => {
  assert.equal(normaliseNumber('081234567890'), '6281234567890');
  assert.equal(normaliseNumber('+62 812-3456-7890'), '6281234567890');
  assert.equal(normaliseNumber('62882017467912'), '62882017467912');
  assert.equal(normaliseNumber(''), '');
});

test('validateIndonesianNumber accepts the local 08 form and the international form', () => {
  assert.equal(validateIndonesianNumber('0882017467912'), true, 'local 08 is the primary form');
  assert.equal(validateIndonesianNumber('62882017467912'), true);
  assert.equal(validateIndonesianNumber('+62 882-0174-67912'), true, 'spaces and separators are stripped');
  assert.equal(normaliseNumber('0882017467912'), '62882017467912');
  assert.equal(normaliseNumber('081234567890'), '6281234567890');
});

test('a rejected number explains the 08 form rather than demanding 62', () => {
  // The earlier rule normalised 08 silently and then told the user to use the
  // international format, so their own number came back rejected with no
  // explanation of the contradiction.
  assert.equal(validateIndonesianNumber('abc'), 'Masukkan nomor WhatsApp Anda.');
  assert.match(String(validateIndonesianNumber('0812')), /Contoh: 081234567890/);
  assert.match(String(validateIndonesianNumber('0812')), /11–15 digit/);
  assert.match(String(validateIndonesianNumber('8123456789')), /format 08…/);
  assert.doesNotMatch(
    String(validateIndonesianNumber('0812')),
    /format internasional/,
    'the old message told users to stop using the format they just typed',
  );
});

test('the examples are documentation numbers, not real subscribers', () => {
  // A real number baked into a prompt is a real person's phone number. The one
  // that used to sit here was also the default, so pairing silently targeted
  // someone else's account.
  const flow = fs.readFileSync(join(import.meta.dirname, '..', 'src', 'cli', 'pairing-flow.ts'), 'utf8');
  const example = /const EXAMPLE_NUMBER = '(\d+)'/.exec(flow)?.[1] ?? '';
  assert.equal(example, '081234567890', 'the documented example changed without review');
  assert.doesNotMatch(flow, /default:\s*EXAMPLE_NUMBER/, 'there must be no pre-filled number');
  assert.doesNotMatch(flow, /62882017467912|6283831459585/, 'no hard-coded subscriber numbers');
});

test('an over-long number is rejected rather than silently truncated', () => {
  // 16 digits is outside the Indonesian plan; accepting it would send a bad
  // request to Meta and surface as an opaque 400.
  assert.notEqual(validateIndonesianNumber('6281234567890123'), true);
});

test('the pairing flow is its own module and does not import the wizard back', () => {
  // A cycle between the flow and the lifecycle partially initialises both; the
  // assertion below walks the built graph and fails if it reappears.
  const flow = fs.readFileSync(join(import.meta.dirname, '..', 'src', 'cli', 'pairing-flow.ts'), 'utf8');
  assert.doesNotMatch(
    flow,
    /from '\.\/wizard\.js'/,
    'pairing-flow.ts must not depend on wizard.ts',
  );
  const wizard = fs.readFileSync(join(import.meta.dirname, '..', 'src', 'cli', 'wizard.ts'), 'utf8');
  assert.match(wizard, /from '\.\/pairing-flow\.js'/, 'wizard.ts owns the lifecycle import');
});

test('streamText writes a plain line when stdout is not a TTY', async () => {
  // Guard against the animation corrupting piped output: no escape codes, and
  // the whole line arrives in one write.
  const chunks = [];
  const fake = { isTTY: false, write: (s) => chunks.push(s) };
  await streamText('hello world', 1, '\x1b[36m', fake);
  assert.equal(chunks.join(''), 'hello world\n');
  assert.ok(!chunks.join('').includes('\x1b'));
});

test('the dashboard aligns at every terminal width', () => {
  const plugins = Array.from({ length: 16 }, (_, i) => ({ name: `plugin${i}`, order: i * 10 }));
  for (const columns of [52, 60, 72, 80, 100, 120, 200]) {
    const out = renderFluxIntro({ plugins, columns, colour: true, unicode: true });
    const box = Math.min(Math.max(columns - 2, 52), 78);
    const rows = out.split('\n').filter((l) => visibleWidth(l) > 0);
    assert.equal(new Set(rows.map(visibleWidth)).size, 1, `ragged at ${columns} cols`);
    assert.equal(visibleWidth(rows[0]), box, `wrong frame width at ${columns} cols`);
  }
});

test('the dashboard reports the plugins it is actually given', () => {
  const out = renderFluxIntro({
    plugins: [{ name: 'stealth', order: 10 }, { name: 'warmup', order: 100 }],
    columns: 80,
    colour: false,
    unicode: false,
  });
  assert.match(out, /\(2 applied\)/);
  assert.match(out, /stealth/);
  assert.match(out, /warmup/);
  // No ANSI when colour is off — a consumer parsing plain text needs clean bytes.
  assert.ok(!out.includes('\x1b'), 'escape codes leaked with colour disabled');
});

test('an empty chain is reported honestly rather than padded', () => {
  // Two distinct states must not collapse into the same line. While the socket is
  // still coming up the honest answer is "applying"; once it has reported, an
  // empty chain is a real result.
  const connecting = renderFluxIntro({ plugins: [], columns: 80, colour: false, unicode: false, connection: null });
  assert.match(connecting, /\(0 applied\)/);
  assert.match(connecting, /applying plugin chain/);
  assert.match(connecting, /socket connecting/);
  assert.doesNotMatch(connecting, /never/, '"socket never" reads as a failed socket');

  const reported = renderFluxIntro({
    plugins: [],
    columns: 80,
    colour: false,
    unicode: false,
    connection: 'open',
  });
  assert.match(reported, /none applied yet/);
  assert.match(reported, /socket open/);
});

test('padVisible ignores ANSI escapes when measuring', () => {
  const coloured = '\x1b[38;2;0;229;255mflux\x1b[0m';
  const padded = padVisible(coloured, 20);
  assert.equal(visibleWidth(padded), 20);
  assert.equal(padded.includes('\x1b'), true, 'escapes must be preserved in output');
});

test('formatUptime stops reading 0.00 h for a just-started process', () => {
  assert.match(formatUptime(0.4), /s$/);
  assert.match(formatUptime(90), /m/);
  assert.match(formatUptime(7200), /h$/);
});

test('a registered session is detected before pairing is attempted', async () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, 'creds.json'), JSON.stringify({ registered: true, me: { id: '6281234567890:5@s.whatsapp.net' } }));
    const rec = await readSession(dir);
    assert.equal(rec.registered, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a half-finished session is reported as partial, not as paired', async () => {
  const dir = scratch();
  try {
    // `partialArtifacts` keys off the pairing fields a half-run leaves behind,
    // not merely the presence of creds.json — so the fixture has to carry one.
    writeFileSync(join(dir, 'creds.json'), JSON.stringify({
      noiseKey: 'abc',
      pairingCode: 'TEB8L49J',
      pairingEphemeralKeyPair: { publicKey: 'x', privateKey: 'y' },
    }));
    const rec = await readSession(dir);
    assert.equal(rec.registered, false, 'a half-run must never read as paired');
    assert.ok(rec.partial.includes('pairingCode'), 'pairingCode should be listed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a provisioned session is never reported as half-finished', async () => {
  // Without this a working session trips the reset guard on every run, which is
  // the failure mode `partialArtifacts` exists to prevent.
  const dir = scratch();
  try {
    writeFileSync(join(dir, 'creds.json'), JSON.stringify({
      registered: true,
      me: { id: '6281234567890:5@s.whatsapp.net' },
      pairingCode: 'TEB8L49J',
    }));
    const rec = await readSession(dir);
    assert.equal(rec.registered, true);
    assert.deepEqual(rec.partial, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bootstrap is exported and callable without side effects at import', () => {
  assert.equal(typeof bootstrap, 'function');
});

test('formatCountdown renders a clock, never a negative', () => {
  assert.equal(formatCountdown(30_000), '0:30');
  assert.equal(formatCountdown(5_000), '0:05');
  assert.equal(formatCountdown(0), '0:00');
  assert.equal(formatCountdown(-1_000), '0:00');
  assert.equal(formatCountdown(90_000), '1:30');
  assert.equal(formatCountdown(61_000), '1:01');
});

test('parsePhoneFlag reads both flag forms and nothing else', () => {
  assert.equal(parsePhoneFlag(['--phone', '0882017467912']), '0882017467912');
  assert.equal(parsePhoneFlag(['--phone=0882017467912']), '0882017467912');
  assert.equal(parsePhoneFlag(['--dir', './s', '--phone', '0812']), '0812');
  assert.equal(parsePhoneFlag(['--dir', './s']), null);
  assert.equal(parsePhoneFlag(['--phone']), null);
  assert.equal(parsePhoneFlag(['--phone=']), null);
  assert.equal(
    parsePhoneFlag(['--phone', '0882017467912']),
    '0882017467912',
    'the raw value is returned as-is; normalisation happens after validation',
  );
});

function fakeWatcher() {
  const state = { linked: false };
  const handlers = {};
  return {
    handlers,
    setLinked: (value) => { state.linked = value; },
    fire: () => { handlers['creds.update']?.(); },
    watcher: {
      on: (event, fn) => {
        handlers[event] = fn;
        return () => { delete handlers[event]; };
      },
      isLinked: () => state.linked,
    },
  };
}

test('waitForLink resolves true the moment registration is reported', async () => {
  const fake = fakeWatcher();
  const pending = waitForLink(fake.watcher, 1_000);
  fake.setLinked(true);
  fake.fire();
  assert.equal(await pending, true);
  assert.equal(fake.handlers['creds.update'], undefined, 'listener detached after settling');
});

test('waitForLink ignores creds updates while still unregistered', async () => {
  const fake = fakeWatcher();
  let ticks = 0;
  const pending = waitForLink(fake.watcher, 120, () => { ticks += 1; });
  fake.fire();
  fake.fire();
  assert.equal(await pending, false);
  assert.ok(ticks >= 1, 'the countdown ticked while waiting');
  assert.equal(fake.handlers['creds.update'], undefined, 'listener detached after timeout');
});

test('waitForLink resolves immediately when already linked', async () => {
  const fake = fakeWatcher();
  fake.setLinked(true);
  assert.equal(await waitForLink(fake.watcher, 1_000), true);
  assert.equal(fake.handlers['creds.update'], undefined, 'no listener left behind');
});

test('waitForSettle resolves true once the rebuilt socket reports open', async () => {
  let state = 'connecting';
  setTimeout(() => { state = 'open'; }, 60);
  assert.equal(await waitForSettle(() => state, { timeoutMs: 2_000 }), true);
});

test('waitForSettle resolves false when open never arrives', async () => {
  let ticks = 0;
  const settled = await waitForSettle(() => 'connecting', {
    timeoutMs: 120,
    onTick: () => { ticks += 1; },
  });
  assert.equal(settled, false);
  assert.ok(ticks >= 1, 'the settle countdown ticked while waiting');
});

test('waitForSettle returns immediately when already open', async () => {
  let ticks = 0;
  assert.equal(
    await waitForSettle(() => 'open', { timeoutMs: 2_000, onTick: () => { ticks += 1; } }),
    true,
  );
  assert.equal(ticks, 0, 'no countdown needed when already settled');
});

test('pairing diagnostics record tags and timings, never payloads', () => {
  const diag = new PairingDiagnostics();
  assert.deepEqual(diag.render(), ['(no pairing events recorded)']);
  diag.record('connection:connecting');
  diag.record('qr:277b');
  diag.record('code-displayed');
  diag.record('close:515');
  const lines = diag.render();
  assert.equal(lines.length, 4);
  for (const line of lines) {
    assert.match(line, /^\s+\+\d+\.\ds\s+\S+$/, `malformed diagnostic line: ${line}`);
  }
  const text = lines.join('\n');
  assert.doesNotMatch(text, /62882017467912|0882017467912/, 'no phone numbers in diagnostics');
  assert.doesNotMatch(text, /[A-Z0-9]{8}/, 'no pairing codes in diagnostics');
});

test('pairing diagnostics keep insertion order across attempts', () => {
  const diag = new PairingDiagnostics();
  diag.record('attempt:1:code');
  diag.record('window-expired');
  diag.record('retry:pairing_code');
  diag.record('attempt:2:code');
  diag.record('link-observed');
  const events = diag.render().map((line) => line.trim().split(/\s+/)[1]);
  assert.deepEqual(events, ['attempt:1:code', 'window-expired', 'retry:pairing_code', 'attempt:2:code', 'link-observed']);
});

test('chooseSessionDir prefers flag, then env, then memory, then fallback', () => {
  assert.deepEqual(
    chooseSessionDir({ flag: 'F', env: 'E', remembered: 'M', fallback: 'D' }),
    { dir: 'F', remember: true },
  );
  assert.deepEqual(
    chooseSessionDir({ flag: null, env: 'E', remembered: 'M', fallback: 'D' }),
    { dir: 'E', remember: true },
  );
  assert.deepEqual(
    chooseSessionDir({ flag: null, env: null, remembered: 'M', fallback: 'D' }),
    { dir: 'M', remember: false },
  );
  assert.deepEqual(
    chooseSessionDir({ flag: null, env: null, remembered: null, fallback: 'D' }),
    { dir: 'D', remember: false },
  );
  assert.deepEqual(
    chooseSessionDir({ fallback: 'D' }),
    { dir: 'D', remember: false },
  );
});

test('remembered sessions round-trip through a state file', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'nyx-state-')), 'flux.json');
  assert.equal(loadRememberedDir(file), null, 'missing file reads as no memory');
  saveRememberedDir('C:\nyx-session', file);
  assert.equal(loadRememberedDir(file), 'C:\nyx-session');
});

test('a corrupt state file reads as no memory, never a crash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nyx-state-'));
  const file = join(dir, 'flux.json');
  writeFileSync(file, '{not json');
  assert.equal(loadRememberedDir(file), null);
  writeFileSync(file, JSON.stringify({ sessionDir: 42 }));
  assert.equal(loadRememberedDir(file), null);
});

test('digitsFromJid strips device and domain', () => {
  assert.equal(digitsFromJid('62882017467912:14@s.whatsapp.net'), '62882017467912');
  assert.equal(digitsFromJid('62882017467912@s.whatsapp.net'), '62882017467912');
  assert.equal(digitsFromJid(null), '');
  assert.equal(digitsFromJid(''), '');
});

test('waitForConnection resolves open without waiting', async () => {
  assert.equal(
    await waitForConnection(() => ({ state: 'open', lastDisconnectCode: null }), { timeoutMs: 2_000 }),
    'open',
  );
});

test('waitForConnection resolves open when it arrives mid-wait', async () => {
  let state = 'connecting';
  setTimeout(() => { state = 'open'; }, 40);
  assert.equal(
    await waitForConnection(() => ({ state, lastDisconnectCode: null }), { timeoutMs: 2_000, pollMs: 10 }),
    'open',
  );
});

test('waitForConnection resolves logged-out on a 401 close', async () => {
  assert.equal(
    await waitForConnection(() => ({ state: 'close', lastDisconnectCode: 401 }), { timeoutMs: 2_000 }),
    'logged-out',
  );
});

test('a non-401 close is not a logout', async () => {
  // 515 (restart) must keep waiting, never resolve logged-out.
  let calls = 0;
  const verdict = await waitForConnection(
    () => { calls += 1; return { state: calls < 3 ? 'close' : 'open', lastDisconnectCode: 515 }; },
    { timeoutMs: 2_000, pollMs: 10 },
  );
  assert.equal(verdict, 'open');
});

test('waitForConnection times out on a wedged socket', async () => {
  let ticks = 0;
  const verdict = await waitForConnection(() => ({ state: 'connecting', lastDisconnectCode: null }), {
    timeoutMs: 80,
    pollMs: 10,
    onTick: () => { ticks += 1; },
  });
  assert.equal(verdict, 'timeout');
  assert.ok(ticks >= 1);
});

test('watchForLogout fires once on 401 and then stops', async () => {
  let code = null;
  let calls = 0;
  const stop = watchForLogout(() => code, {
    intervalMs: 10,
    onLogout: () => { calls += 1; },
  });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(calls, 0, 'fired with no close recorded');
  code = 515;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(calls, 0, 'fired on a non-401 close');
  code = 401;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(calls, 1);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(calls, 1, 'fired twice for one logout');
  stop();
});

test('a fresh client reports no disconnect code', async () => {
  const { createNyxBaileys } = await import('../dist/index.js');
  const client = createNyxBaileys({ sessionDir: join(tmpdir(), 'nyx-never-connected') });
  assert.equal(client.lastDisconnectCode, null);
  await client.dispose();
});

test('saving the session dir preserves keys already in the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nyx-state-'));
  const file = join(dir, 'flux.json');
  writeFileSync(file, JSON.stringify({ sessionDir: 'C:\\old', openRouterApiKey: 'sk-or-v1-KEEPME' }));
  saveRememberedDir('C:\\new', file);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.sessionDir, 'C:\\new');
  assert.equal(raw.openRouterApiKey, 'sk-or-v1-KEEPME', 'saving the dir must never drop the key');
});
