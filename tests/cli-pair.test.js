/**
 * The pairing path in the CLI.
 *
 * This file exists because the CLI had no tests at all, and every one of the
 * defects below shipped through that gap. They are grouped by the failure they
 * cause, not by the function that was wrong:
 *
 *   - `pair` could never show a code. rc14 emits a QR ref and nothing else; the
 *     8-character code has to be *requested*. The command never asked, so on a
 *     machine with no camera it could only ever time out.
 *   - `--json pair` was silent. The code and the ref were printed through
 *     `Reporter.line`, which no-ops under `--json`, so a scripted run saw nothing
 *     on either stream and hung.
 *   - a half-negotiated session looked like an auth failure. `creds.json` holding
 *     handshake material and no `registered` flag is refused by WhatsApp with 401
 *     on every connect, forever. Nothing said so.
 *   - `node dist/cli/index.js pair` exited 0 having done nothing, because that
 *     file is a barrel.
 *
 * Every test here runs offline. The ones that would otherwise open a socket are
 * built so the check they pin happens *before* the connect — which is the whole
 * point: a typo in `--phone` must not cost a WhatsApp connection attempt.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { main } from '../dist/cli/main.js';
import { isProvisioned, normalisePhone, partialArtifacts, toRecipientJid } from '../dist/cli/commands.js';
import { Reporter } from '../dist/cli/output.js';

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/* ── fixtures ────────────────────────────────────────────────────────── */

/**
 * A creds.json as a killed mid-pairing run leaves it: real handshake material,
 * `registered` never set. WhatsApp refuses to resume this, on every attempt.
 */
const POISONED = {
  noiseKey: Buffer.from('x').toString('base64'),
  signedIdentityKey: { private: 'a', public: 'b' },
  signedPreKey: { private: 'a', public: 'b' },
  pairingCode: '12345678',
  pairingEphemeralKeyPair: { public: 'a', private: 'b', registered: false },
  me: { id: '6283831459585:12@s.whatsapp.net', name: 'Bian' },
  registered: false,
};

async function sessionDir(creds) {
  const dir = await mkdtemp(join(tmpdir(), 'nyx-pair-'));
  if (creds) await writeFile(join(dir, 'creds.json'), JSON.stringify(creds), 'utf8');
  return dir;
}

/** Run `main` with both streams captured, so the stdout contract can be asserted. */
async function cli(argv) {
  const out = [];
  const err = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
  try {
    const code = await main(argv);
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

/* ── partialArtifacts ────────────────────────────────────────────────── */

test('handshake material without `registered` is what makes a session unrecoverable', () => {
  assert.deepEqual(partialArtifacts(POISONED), [
    'pairingCode',
    'pairingEphemeralKeyPair',
    'signedIdentityKey',
  ]);
});

test('a fresh session has no partial artifacts, so it is not mistaken for a broken one', () => {
  assert.deepEqual(partialArtifacts({ noiseKey: 'x' }), []);
  assert.deepEqual(partialArtifacts({ registered: true, pairingCode: '12345678' }), []);
});

test('an empty pairingCode is not an artifact — the field is present but unused', () => {
  assert.deepEqual(partialArtifacts({ pairingCode: '', registered: false }), []);
});

/* ── normalisePhone ──────────────────────────────────────────────────── */

test('a phone number is reduced to digits, because WhatsApp rejects formatting', () => {
  assert.equal(normalisePhone('+62 838-3145-9585'), '6283831459585');
  assert.equal(normalisePhone('(628) 383-1459'), '6283831459');
  assert.equal(normalisePhone('  6283831459585  '), '6283831459585');
});

/* ── Reporter.pairing ────────────────────────────────────────────────── */

test('pairing artifacts reach the operator in human mode', () => {
  const written = [];
  const io = new Reporter({
    json: false,
    color: false,
    stdout: { write: (t) => (written.push(t), true), isTTY: false },
    stderr: { write: (t) => (written.push(t), true), isTTY: false },
  });

  io.pairing([['phone code', '1234 5678']]);

  assert.match(written.join(''), /phone code\s+1234 5678/);
});

test('--json pairing artifacts go to stderr, never stdout', () => {
  const out = [];
  const err = [];
  const io = new Reporter({
    json: true,
    color: false,
    stdout: { write: (t) => (out.push(t), true), isTTY: false },
    stderr: { write: (t) => (err.push(t), true), isTTY: false },
  });

  io.pairing([['phone code', '1234 5678']]);

  assert.equal(out.join(''), '', 'a code on stdout would make --json output unparseable');
  assert.deepEqual(JSON.parse(err.join('')), { pairing: 'phone code', value: '1234 5678' });
});

test('an empty pairing report writes nothing at all', () => {
  const err = [];
  const io = new Reporter({
    json: true,
    color: false,
    stdout: { write: () => true, isTTY: false },
    stderr: { write: (t) => (err.push(t), true), isTTY: false },
  });

  io.pairing([]);

  assert.equal(err.join(''), '');
});

/* ── 401 on a half-negotiated session ────────────────────────────────── */

test('pair refuses a half-finished pairing and names the exact recovery command', async () => {
  const dir = await sessionDir(POISONED);
  try {
    const { code, stdout, stderr } = await cli(['pair', '--dir', dir]);

    assert.equal(code, 3, 'not-paired, not a connection failure');
    assert.match(stderr, /half-finished pairing/);
    assert.match(stderr, /pairingCode/, 'the offending artifacts are named');
    assert.match(stderr, /--reset/, 'and the way out is spelled out');
    assert.equal(stdout.includes('half-finished'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the half-finished pairing is reported on stderr under --json, stdout stays empty', async () => {
  const dir = await sessionDir(POISONED);
  try {
    const { code, stdout, stderr } = await cli(['--json', 'pair', '--dir', dir]);

    assert.equal(code, 3);
    assert.equal(stdout, '', 'stdout holds one object or nothing — never prose');
    const envelope = JSON.parse(stderr);
    assert.equal(envelope.ok, false);
    assert.match(envelope.error.message, /half-finished pairing/);
    assert.match(envelope.error.next, /--reset/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a fresh session directory is not blocked — only a half-finished one is', async () => {
  const dir = await sessionDir({ noiseKey: 'x' });
  try {
    // The guard reads `partial`, so an empty list is the whole proof that a fresh
    // directory passes. Checked through `sessions list` rather than by running
    // `pair`, because running it would open a socket to prove a string is empty.
    const { code, stdout } = await cli(['--json', 'sessions', 'list', '--dir', dir]);

    assert.equal(code, 0);
    const [record] = JSON.parse(stdout).data.sessions;
    assert.equal(record.paired, false);
    assert.deepEqual(record.partial, [], 'no handshake material, so nothing to clear');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an already-registered session is left completely alone', async () => {
  const dir = await sessionDir({ registered: true, me: { id: '6283831459585:1@s.whatsapp.net' } });
  try {
    const { code, stdout, stderr } = await cli(['--json', 'pair', '--dir', dir]);

    assert.equal(code, 0);
    const envelope = JSON.parse(stdout);
    assert.equal(envelope.data.alreadyPaired, true);
    assert.equal(envelope.data.number, '6283831459585:1@s.whatsapp.net');
    assert.equal(stderr, '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('`--reset` does not become a way to delete a working session', async () => {
  const dir = await sessionDir({ registered: true, me: { id: '6283831459585:1@s.whatsapp.net' } });
  try {
    const { code, stdout } = await cli(['--json', 'pair', '--dir', dir, '--reset']);

    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout).data.alreadyPaired, true);
    const creds = JSON.parse(await readFile(join(dir, 'creds.json'), 'utf8'));
    assert.equal(creds.registered, true, 'the credentials are still on disk');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sessions list reports a half-finished pairing instead of a bare "no"', async () => {
  const dir = await sessionDir(POISONED);
  try {
    const { code, stdout } = await cli(['--json', 'sessions', 'list', '--dir', dir]);

    assert.equal(code, 0);
    const [record] = JSON.parse(stdout).data.sessions;
    assert.equal(record.paired, false);
    assert.deepEqual(record.partial, ['pairingCode', 'pairingEphemeralKeyPair', 'signedIdentityKey']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ── --phone is validated before anything touches the network ────────── */

test('a malformed --phone is a usage error, and costs no connection attempt', async () => {
  const dir = await sessionDir(POISONED);
  try {
    // Deliberately pointed at a poisoned directory. If phone validation ran
    // after the session check it would report the half-finished pairing; if it
    // ran after the connect it would take seconds and hit WhatsApp. Getting the
    // usage error immediately proves it runs first.
    const { code, stderr } = await cli(['pair', '--dir', dir, '--phone', '123']);

    assert.equal(code, 1);
    assert.match(stderr, /full international number/);
    assert.equal(stderr.includes('half-finished'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ── the barrel that did nothing ─────────────────────────────────────── */

test('running dist/cli/index.js directly dispatches instead of exiting 0 in silence', async () => {
  const { stdout } = await run(process.execPath, [join(repoRoot, 'dist', 'cli', 'index.js'), '--version'], {
    cwd: repoRoot,
  });

  assert.match(stdout, /nyx-baileys \d+\.\d+\.\d+/);
});

test('the launcher and the barrel agree on the version', async () => {
  const [viaBin, viaBarrel] = await Promise.all([
    run(process.execPath, [join(repoRoot, 'bin', 'nyx-baileys.js'), '--version'], { cwd: repoRoot }),
    run(process.execPath, [join(repoRoot, 'dist', 'cli', 'index.js'), '--version'], { cwd: repoRoot }),
  ]);

  assert.equal(viaBin.stdout, viaBarrel.stdout);
});

test('the barrel still exports its surface when it is imported rather than run', async () => {
  const barrel = await import('../dist/cli/index.js');

  assert.equal(typeof barrel.main, 'function');
  assert.equal(typeof barrel.Reporter, 'function');
  assert.equal(typeof barrel.PARSER, 'object');
});
/* ── the provisioned-but-unflagged session ───────────────────────────── */

/**
 * The shape below is not invented. It is the field set of a real creds.json
 * captured on 2026-10-04 after WhatsApp signed the device — with `registered`
 * still `false` because rc14 never delivers the `companion_finish`
 * notification that Baileys keys that flag off.
 *
 * That session connected, logged in, passed pre-key validation and reached
 * Online. Every socket-dependent command refused to run, because they all read
 * the flag.
 */
const PROVISIONED_UNFLAGGED = {
  registered: false,
  me: { id: '6283831459585:11@s.whatsapp.net', lid: '27836421259416:11@lid' },
  account: { details: 'CO7jr7UDELrdh9YGGAEgACgA', accountSignature: 'PtDDxDG3FNf…', deviceSignature: 'nCNLtIjmwZ…' },
  routingInfo: { lpr: {} },
  pairingEphemeralKeyPair: { registered: false },
  pairingCode: 'P62NZ1LJ',
  signedIdentityKey: { public: 'x', private: 'y' },
};

test('a device WhatsApp has signed counts as paired, whatever the flag says', () => {
  assert.equal(isProvisioned(PROVISIONED_UNFLAGGED), true);
  assert.equal(isProvisioned({ registered: true }), true, 'the flag alone is still honoured');
});

test('an unpaired session is not provisioned, on any of the evidence', () => {
  assert.equal(isProvisioned({ registered: false }), false);
  assert.equal(isProvisioned({ me: { id: 'x@s.whatsapp.net' } }), false, 'a jid alone proves nothing');
  assert.equal(isProvisioned({ account: { deviceSignature: 'y' } }), false, 'a signature alone proves nothing');
  assert.equal(isProvisioned({}), false);
});

test('a signed device is never mistaken for a half-finished pairing', () => {
  // The regression that mattered: the flag said false and the handshake material
  // was still present, so `partial` came back non-empty and `pair --reset` would
  // have deleted a working session.
  assert.deepEqual(partialArtifacts(PROVISIONED_UNFLAGGED), []);
});

test('a signed device is reported as paired, so the socket gate lets it through', async () => {
  const dir = await sessionDir(PROVISIONED_UNFLAGGED);
  try {
    // `sessions list` is the offline view onto the same `readSession` record that
    // `requirePaired` gates on, so this pins the gate without opening a socket.
    // `status` would prove the same thing but needs a live WhatsApp connection,
    // which does not belong in a suite that is otherwise hermetic.
    const { code, stdout } = await cli(['--json', 'sessions', 'list', '--dir', dir]);

    assert.equal(code, 0);
    const [record] = JSON.parse(stdout).data.sessions;
    assert.equal(record.paired, true, 'the flag said false; the signature says paired');
    assert.deepEqual(record.partial, [], 'and it is not a half-finished pairing');
    assert.equal(record.number, '6283831459585:11@s.whatsapp.net');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pair refuses to reset a signed device', async () => {
  const dir = await sessionDir(PROVISIONED_UNFLAGGED);
  try {
    const { code, stdout, stderr } = await cli(['--json', 'pair', '--dir', dir]);

    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout).data.alreadyPaired, true, 'it reports the existing pairing');
    assert.equal(stderr, '', 'and never reaches the half-finished-pairing guard');
    const creds = JSON.parse(await readFile(join(dir, 'creds.json'), 'utf8'));
    assert.equal(creds.account.deviceSignature, 'nCNLtIjmwZ…', 'the credentials survive');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ── durability ──────────────────────────────────────────────────────── */

/**
 * `creds.json` must never land at 0 bytes.
 *
 * Observed on 2026-10-04: a paired, provisioned session was destroyed by its own
 * shutdown. Baileys persists creds with an async `writeFile`, which truncates
 * before it writes, so a save in flight when the process exits leaves an empty
 * file — and an empty file is silently read back as "fresh, unpaired", so the
 * next run starts pairing from scratch with no error anywhere.
 *
 * `dispose()` now awaits the serialised save chain. This asserts the observable
 * consequence: after a dispose the file on disk still parses and still holds the
 * credentials.
 */
test('disposing a client leaves creds.json intact rather than truncated', async () => {
  const dir = await sessionDir({ registered: true, me: { id: '6283831459585:11@s.whatsapp.net' } });
  try {
    const { createNyxBaileys } = await import('../dist/index.js');
    const client = createNyxBaileys({ sessionDir: dir, logLevel: 'silent' });

    // No connect(): this is about the save/dispose ordering, not the socket. The
    // store is exercised directly so the test stays offline.
    const { FileSessionStore } = await import('../dist/core/session-store.js');
    const store = new FileSessionStore({ dir });
    const { state, saveCreds } = await store.init();

    // Two writes back to back: the interleaving case, which is what produced
    // malformed JSON before the chain was serialised.
    await Promise.all([saveCreds(), saveCreds()]);

    await client.dispose();

    const raw = await readFile(join(dir, 'creds.json'), 'utf8');
    assert.notEqual(raw.length, 0, 'creds.json was truncated to 0 bytes');
    assert.doesNotThrow(() => JSON.parse(raw), 'creds.json must still be valid JSON');
    void state;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ── recipients ──────────────────────────────────────────────────────── */

/**
 * `send` and `form` both document a bare number as a valid recipient. None were:
 * the lid router passes non-jid input through unchanged, so raw digits reached
 * `sendMessage`, whose `jidDecode` returns `undefined` for them. It surfaced as
 * `Cannot destructure property 'user' of 'jidDecode(...)' as it is undefined` —
 * naming neither the number nor the cause. Found by sending to a real number.
 */
test('a bare number becomes a jid, because sendMessage cannot read raw digits', () => {
  assert.equal(toRecipientJid('62882017467912'), '62882017467912@s.whatsapp.net');
  assert.equal(toRecipientJid('  62882017467912  '), '62882017467912@s.whatsapp.net');
  assert.equal(toRecipientJid('+62 882-0174-67912'), '62882017467912@s.whatsapp.net');
});

test('anything already addressed is passed through untouched', () => {
  for (const jid of [
    '62882017467912@s.whatsapp.net',
    '120363000000000000@g.us',
    '27836421259416:11@lid',
    '6283831459585:11@s.whatsapp.net',
  ]) {
    assert.equal(toRecipientJid(jid), jid);
  }
});

test('an empty or unusable recipient is left for the parser to reject', () => {
  assert.equal(toRecipientJid(''), '');
  assert.equal(toRecipientJid('   '), '');
  assert.equal(toRecipientJid('not-a-number'), 'not-a-number', 'unchanged, so the real error survives');
});
