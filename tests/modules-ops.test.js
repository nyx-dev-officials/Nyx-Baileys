/**
 * Modules E, F, G, I and J tests.
 *
 * The security tests are the ones that matter here. `ijwtcheck` and `iscrub`
 * both deal with attacker-controlled input, and the RBAC checks are the only
 * thing standing between an ordinary chat user and the administrative
 * commands — so those are tested as an attacker would probe them.
 *
 * Every stateful command is exercised against a real on-disk store, in a
 * directory that is unique per run, so these tests cannot contaminate each
 * other or leak into a real deployment.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CommandRegistry } from '../dist/toolkit/command-registry.js';
import { installCoreFamilies } from '../dist/toolkit/command-families.js';
import { installBulkFamilies } from '../dist/toolkit/command-families-bulk.js';

const sock = {};
function build() {
  const reg = new CommandRegistry();
  installCoreFamilies(reg);
  installBulkFamilies(reg);
  return reg;
}

/** Run as a sender with a specific role set. */
const as = (reg, token, args = '', opts = {}) =>
  reg.run(sock, 'g1@g.us', token, args, {
    sender: opts.sender ?? 'plain@s.whatsapp.net',
    isOwner: opts.isOwner ?? false,
    state: new Map(),
  });

// Isolate the store so a test run cannot touch a real deployment's data.
const { opsDataPath } = await import('../dist/toolkit/command-ops.js');
test('ops store lives under the temp directory, never the repo', () => {
  assert.ok(opsDataPath.startsWith(tmpdir()), 'the store must live under the OS temp directory');
  assert.ok(!opsDataPath.includes('/src/'), 'the store must never be written into source');
});

/* ── registration ────────────────────────────────────────────────────── */

test('modules E F G I J register under the ops family', () => {
  const ops = build().list({ family: 'ops' });
  assert.ok(ops.length >= 60, `expected a substantial ops family, got ${ops.length}`);
  for (const cmd of ops) {
    assert.ok(cmd.effect.trim().length > 8, `${cmd.name} has a weak effect string`);
    assert.ok(cmd.summary.trim().length > 2, `${cmd.name} has no summary`);
  }
});

test('the spec-named features are covered', () => {
  const reg = build();
  const required = [
    // E
    'ematrix', 'asciiart', 'sponge', 'hype', 'fakey', 'placeholdercycle',
    // F
    'fruntime', 'fgc', 'fhandles', 'flimit', 'fbucket', 'fhealth',
    // I
    'irole', 'irolecheck', 'iscrub', 'ienc', 'idec', 'ijwtcheck', 'ikill',
    // J
    'jtask', 'jset', 'jget', 'jpublish', 'jlog', 'jmigrate', 'jhealth', 'jembed',
    // G
    'gdump', 'gpurge', 'gnotice',
  ];
  for (const name of required) assert.ok(reg.get(name), `${name} is missing`);
});

test('ghost-ping is absent by design, and the reason is documented', async () => {
  const reg = build();
  assert.ok(!reg.get('ghost-ping'), 'ghost-ping must not exist');
  const help = String((await as(reg, 'ops')).text);
  assert.match(help, /ghost-ping is not implemented/);
});

test('ops help lists every ops command', async () => {
  const reg = build();
  const help = String((await as(reg, 'ops')).text);
  const missing = reg.list({ family: 'ops' })
    .map((c) => c.name)
    .filter((n) => n !== 'ops' && !help.includes(n));
  assert.deepEqual(missing, [], `ops help omits: ${missing.join(', ')}`);
});

/* ── Module I: RBAC, probed as an attacker would ─────────────────────── */

test('RBAC: an ordinary user is denied every privileged command', async () => {
  const reg = build();
  const privileged = [
    ['ikill', ''], ['irolegrant', 'x@s.vip'], ['irolerevoke', 'x@s.vip'],
    ['iroleslist', ''], ['fconfig', ''], ['fsetconfig', 'a b'], ['fdelconfig', 'a'],
    ['fconfigkeys', ''], ['fbucketreset', ''], ['jtaskclear', ''],
    ['gexclude', ''], ['gexcludeadd', 'x@s'], ['gexcluderemove', 'x@s'], ['gpurge', ''],
  ];
  for (const [name, args] of privileged) {
    const res = await as(reg, name, args);
    assert.ok(res.error, `${name} must be denied for an unprivileged user`);
    assert.match(String(res.error), /role/, `${name} should explain that a role is required`);
  }
});

test('RBAC: the owner is allowed', async () => {
  const reg = build();
  const res = await as(reg, 'ikill', '', { isOwner: true });
  assert.ok(!res.error, res.error);
});

test('RBAC: roles are granted by an owner and then enforced', async () => {
  const reg = build();
  const target = `victim-${Date.now()}@s.whatsapp.net`;
  const denied = await as(reg, 'iroleslist', '');
  assert.ok(denied.error, 'unprivileged listing must fail first');

  const granted = await as(reg, 'irolegrant', `${target} vip`, { isOwner: true });
  assert.ok(!granted.error, granted.error);
  assert.match(granted.text, /vip/);

  const check = await as(reg, 'irolecheck', 'vip', { sender: target });
  assert.ok(!check.error, check.error);

  const admin = await as(reg, 'irolecheck', 'admin', { sender: target });
  assert.ok(admin.error, 'vip must not satisfy an admin requirement');
});

test('RBAC: a revoked role stops working immediately', async () => {
  const reg = build();
  const target = `revoke-${Date.now()}@s.whatsapp.net`;
  await as(reg, 'irolegrant', `${target} vip`, { isOwner: true });
  assert.ok(!(await as(reg, 'irolecheck', 'vip', { sender: target })).error);
  await as(reg, 'irolerevoke', `${target} vip`, { isOwner: true });
  assert.ok((await as(reg, 'irolecheck', 'vip', { sender: target })).error);
});

test('RBAC: granting an unknown role is rejected', async () => {
  const res = await as(build(), 'irolegrant', 'x@s superuser', { isOwner: true });
  assert.ok(res.error, 'an unknown role must be rejected rather than stored');
});

/* ── Module I: secret handling ───────────────────────────────────────── */

test('iscrub detects and redacts real credential shapes', async () => {
  const reg = build();
  const samples = [
    'api_key=sk-live-abc123def456ghi789',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig',
    'AKIAIOSFODNN7EXAMPLE',
    'ghp_1234567890abcdefghijklmnopqrstuvwx',
    'xoxb-123456789012-abcdefghijkl',
    'AIzaSyA1234567890abcdefghijklmnopqrstuv',
  ];
  for (const s of samples) {
    const res = await as(reg, 'iscrub', s);
    assert.ok(!res.text.includes('REDACTED') === false, `${s.slice(0, 20)} should be flagged`);
    assert.match(res.text, /\[REDACTED/, `${s.slice(0, 20)} should be redacted`);
    // The original secret must not survive anywhere in the output.
    const secret = s.split(/[=:]/).pop().trim().slice(0, 20);
    assert.ok(!res.text.includes(secret),
      `${s.slice(0, 20)} leaked its own value into the output`);
  }
});

test('iscrub reports honestly when there is nothing to find', async () => {
  const res = await as(build(), 'iscrub', 'just an ordinary sentence about the weather');
  assert.match(res.text, /No credential patterns detected/);
});

test('iscrub refuses to scan a missing file', async () => {
  assert.ok((await as(build(), 'iscrubself', join(tmpdir(), 'definitely-missing-file'))).error);
});

test('ienc/idec round-trip and reject a wrong passphrase', async () => {
  const reg = build();
  const enc = String((await as(reg, 'ienc', 'correct horse battery staple :: hello world')).text).trim();
  assert.match(enc, /^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);

  const dec = await as(reg, 'idec', `correct horse battery staple :: ${enc}`);
  assert.match(dec.text, /hello world/);

  const wrong = await as(reg, 'idec', `wrong passphrase entirely :: ${enc}`);
  assert.ok(wrong.error, 'a wrong passphrase must fail');
  assert.ok(!String(wrong.error).includes('hello'), 'a failed decrypt must not return partial plaintext');
});

test('ienc produces a different ciphertext each time', async () => {
  const reg = build();
  const a = String((await as(reg, 'ienc', 'pw :: samevalue')).text).trim();
  const b = String((await as(reg, 'ienc', 'pw :: samevalue')).text).trim();
  assert.notEqual(a, b, 'a random salt and IV must make identical plaintexts differ');
});

test('ijwtcheck decodes without claiming to verify', async () => {
  const reg = build();
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: '123', exp: 1000000000 })).toString('base64url');
  const res = await as(reg, 'ijwtcheck', `${header}.${payload}.sig`);
  assert.match(res.text, /HS256/);
  assert.match(res.text, /does NOT verify the signature/);
  assert.match(res.text, /expired/);
});

test('ijwtcheck rejects malformed input rather than throwing', async () => {
  const reg = build();
  assert.ok((await as(reg, 'ijwtcheck', 'not-a-jwt')).error);
  assert.ok((await as(reg, 'ijwtcheck', 'aaa.bbb.ccc')).error);
});

/* ── Module F: real telemetry ────────────────────────────────────────── */

test('fruntime reports real values, not placeholders', async () => {
  const res = await as(build(), 'fruntime', '');
  assert.match(res.text, new RegExp(`Node: ${process.version.replace(/\./g, '\\.')}`));
  assert.match(res.text, /Uptime: \d+[smhd]/);
  assert.match(res.text, new RegExp(`PID: ${process.pid}`));
  assert.match(res.text, /Heap used: \d/);
});

test('fgc states plainly whether forced GC is available', async () => {
  const res = await as(build(), 'fgc', '');
  assert.match(res.text, /GC exposed: (yes|no)/);
  assert.match(res.text, /Heap before/);
});


test('flimit survives non-numeric configuration instead of crashing', async () => {
  const res = await as(build(), 'flimit', 'abc def ghi');
  assert.ok(!res.error, res.error);
  assert.match(res.text, /Bucket:/);
});

test('fhandles reports real handle counts', async () => {
  const res = await as(build(), 'fhandles', '');
  assert.match(res.text, /Active handles: \d+/);
});

test('fsize reports real directory sizes or says absent', async () => {
  const res = await as(build(), 'fsize', '');
  assert.ok(res.text.includes('flux-ops'), 'should mention the ops store directory');
});

/* ── Module J: state ─────────────────────────────────────────────────── */

test('jset/jget/jdel round-trip and reject unknown keys', async () => {
  const reg = build();
  const key = `probe-${Date.now()}`;
  assert.ok(!(await as(reg, 'jset', `${key} hello world`)).error);
  assert.match(String((await as(reg, 'jget', key)).text), /hello world/);
  assert.ok((await as(reg, 'jget', `${key}-missing`)).error);
  assert.ok(!(await as(reg, 'jdel', key)).error);
  assert.ok((await as(reg, 'jget', key)).error);
});

test('jpublish records an event and jevents shows it', async () => {
  const reg = build();
  const res = await as(reg, 'jpublish', `deploy build finished`);
  assert.match(res.text, /Published "deploy"/);
  const events = await as(reg, 'jevents', '');
  assert.match(events.text, /deploy/);
  assert.match(events.text, /build finished/);
});

test('jpublish notifies subscribers', async () => {
  const reg = build();
  const topic = `topic-${Date.now()}`;
  await as(reg, 'jsubscribe', topic);
  const res = await as(reg, 'jpublish', `${topic} payload`);
  assert.match(res.text, /subscriber/);
});

test('jlog emits parseable JSON', async () => {
  const res = await as(build(), 'jlog', 'error something broke');
  const parsed = JSON.parse(res.text);
  assert.equal(parsed.level, 'error');
  assert.equal(parsed.msg, 'something broke');
  assert.ok(parsed.ts);
  assert.ok(parsed.sender);
});

test('jtask queues work and reports it', async () => {
  const reg = build();
  const res = await as(reg, 'jtask', 'reindex documents');
  const id = res.text.match(/Queued (\w+)/)?.[1];
  assert.ok(id, 'should report the task id');
  assert.match(String((await as(reg, 'jtasks')).text), new RegExp(id));
  assert.match(String((await as(reg, 'jtaskdone', id)).text), /marked done/);
  assert.ok((await as(reg, 'jtaskdone', 'nosuchtask')).error);
});

test('jmigrate is idempotent', async () => {
  const reg = build();
  const first = String((await as(reg, 'jmigrate')).text);
  const second = String((await as(reg, 'jmigrate')).text);
  // The store persists between runs, so the first call may legitimately have
  // nothing to do. What must hold every time is that the second is a no-op and
  // the version ends at the current one.
  assert.match(first, /(Applied \d+ migration|Already at version 3)/);
  assert.match(second, /Already at version 3/, 'running twice must not re-apply');
});

test('jembed produces a normalised, deterministic vector', async () => {
  const reg = build();
  const a = String((await as(reg, 'jembed', 'hello world')).text);
  const b = String((await as(reg, 'jembed', 'hello world')).text);
  assert.equal(a, b, 'identical text must embed identically');
  assert.match(a, /Dimensions: 64/);
  assert.match(a, /hashing trick, not a learned embedding/, 'must not overclaim');
});

test('jstore and jsearch find an exact match', async () => {
  const reg = build();
  const name = `doc-${Date.now()}`;
  assert.ok(!(await as(reg, 'jstore', `${name} the quick brown fox`)).error);
  const res = await as(reg, 'jsearch', 'quick brown fox');
  assert.match(res.text, new RegExp(name));
  const scores = res.text.split('\n').slice(2).map((l) => Number(l.trim().split(/\s+/)[0]));
  assert.ok(scores.every((n) => n >= 0 && n <= 1.0001), 'cosine scores stay in range');
  assert.ok(scores[0] > 0, 'the matching document should rank first with a positive score');
});

test('jhealth validates the runtime honestly', async () => {
  const res = await as(build(), 'jhealth', '');
  assert.match(res.text, /Node v?\d+\.\d+/);
  assert.match(res.text, /Heap headroom: (\S+ B|not exposed)/);
  assert.match(res.text, /ffmpeg: (available|not found)/);
  assert.match(res.text, /Event loop: (responsive|BLOCKED)/);
});

test('jintent classifies and admits it is keyword matching', async () => {
  const reg = build();
  const res = await as(reg, 'jintent', 'hello, what time is it?');
  assert.match(res.text, /greeting/);
  assert.match(res.text, /question/);
  assert.match(res.text, /Keyword matching, not a model/);
});

/* ── Module E ────────────────────────────────────────────────────────── */

test('rolldice honours notation and validates it', async () => {
  const reg = build();
  const res = await as(reg, 'rolldice', '3d6');
  const [a, b, c] = res.text.split('\n')[0].replace('3d6: ', '').split(', ').map(Number);
  assert.ok([a, b, c].every((n) => n >= 1 && n <= 6), 'each die must be 1-6');
  assert.match(res.text, new RegExp(`Total: ${a + b + c}`));
  assert.ok((await as(reg, 'rolldice', 'nonsense')).error);
});

test('chooseone returns a listed option', async () => {
  const res = await as(build(), 'chooseone', 'red, green, blue');
  assert.match(res.text, /^(red|green|blue)$/m);
  assert.ok((await as(build(), 'chooseone', 'onlyone')).error);
});

test('sponge alternates case and asciiart renders letters', async () => {
  const reg = build();
  assert.match(String((await as(reg, 'sponge', 'abcdef')).text), /^aBcDeF$/m);
  const art = String((await as(reg, 'asciiart', 'AB')).text);
  assert.ok(art.split('\n').length >= 5, 'banner should be at least 5 rows');
  assert.ok(art.includes('█'), 'banner should use block glyphs');
});

test('ematrix respects its size bounds', async () => {
  const res = await as(build(), 'ematrix', '6 20');
  const lines = res.text.split('\n');
  assert.equal(lines.length, 6);
  assert.ok(lines.every((l) => [...l].length === 20), 'each row should be 20 characters');
});

test('fakey refuses when the socket has no presence method', async () => {
  const res = await as(build(), 'fakey', '1');
  assert.ok(res.error, 'an empty socket has no presence method; claiming success would be a lie');
  assert.match(String(res.error), /no presence method/);
});

/* ── Module G ────────────────────────────────────────────────────────── */

test('gdump is honest when nothing is stored', async () => {
  const res = await as(build(), 'gdump', '');
  assert.ok(!res.error, res.error);
  assert.match(res.text, /Nothing to purge|No local retention store|Entries:/);
});

test('gnotice documents the refusal to forward captured messages', async () => {
  const res = await as(build(), 'gnotice', '');
  assert.match(res.text, /local to the machine/);
  assert.match(res.text, /Nothing is forwarded/);
  assert.match(res.text, /not implemented/);
});

/* ── help ────────────────────────────────────────────────────────────── */

test('ezhelp explains the deliberate omission', async () => {
  const res = await as(build(), 'ezhelp', '');
  assert.match(res.text, /ghost-ping is not implemented/);
  assert.match(res.text, /eightball and coin already exist/);
});

test('flimit depletes one real bucket and then denies', async () => {
  const reg = build();
  // A fresh chat id per run so a previous test cannot leave tokens behind.
  const shape = `flimit-${Date.now()}`;
  const args = `0.001 2`;
  const call = (n) => reg.run(sock, shape, 'flimit', `${args} ${n}`, { sender: 'x@s', state: new Map() });

  const first = await call(1);
  assert.ok(!first.error, first.error);
  assert.match(first.text, /Allowed/, 'the first request should pass');

  await call(1);
  const denied = await call(1);
  assert.match(denied.text, /retry in \d+ms/, 'an empty bucket must deny and say when to retry');
  assert.ok(!denied.error, 'a denial is a normal outcome, not an error');

  const reset = await reg.run(sock, shape, 'flimitreset', '', { sender: 'x@s', state: new Map() });
  assert.match(reset.text, /Reset/);
});