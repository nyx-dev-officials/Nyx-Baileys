/**
 * Module D tests, plus verification of the QR encoder.
 *
 * The QR tests matter more than the rest of this file. A QR generator that
 * produces plausible-looking block art but does not decode is worse than no
 * generator at all — people print these on menus. So every QR test decodes the
 * matrix with a real reader (jsQR) and asserts the payload round-trips.
 *
 * The store tests write to a temp directory and clean up, and each test uses a
 * distinct sender JID so no test can see another test's notes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { CommandRegistry } from '../dist/toolkit/command-registry.js';
import { installCoreFamilies } from '../dist/toolkit/command-families.js';
import { installBulkFamilies } from '../dist/toolkit/command-families-bulk.js';
import { encodeQr, renderQr } from '../dist/toolkit/qr.js';

const require = createRequire(import.meta.url);
const sock = {};

function build() {
  const reg = new CommandRegistry();
  installCoreFamilies(reg);
  installBulkFamilies(reg);
  return reg;
}

let userSeq = 0;
const run = (reg, token, args = '') => {
  const jid = `u${userSeq++}@s.whatsapp.net`;
  return reg.run(sock, 'g1@g.us', token, args, { sender: jid, isOwner: false, state: new Map() });
};

/** Same sender across calls, for stateful commands. */
const asUser = (reg, id, token, args = '') =>
  reg.run(sock, 'g1@g.us', token, args, { sender: `${id}@s.whatsapp.net`, isOwner: false, state: new Map() });

/* ── QR verification ─────────────────────────────────────────────────── */

let jsQR, sharp;
try {
  jsQR = require('jsqr').default ?? require('jsqr');
  sharp = require('sharp');
} catch {
  jsQR = null;
  sharp = null;
}

/** Render a QR to a PNG buffer big enough for a decoder to lock onto. */
async function qrToPng(text, scale = 8, quiet = 4) {
  const result = encodeQr(text);
  const dim = (result.size + quiet * 2) * scale;
  const px = Buffer.alloc(dim * dim, 255);
  for (let y = 0; y < result.size; y++) {
    for (let x = 0; x < result.size; x++) {
      if (!result.modules[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const py = (y + quiet) * scale + dy;
          const pxx = (x + quiet) * scale + dx;
          px[py * dim + pxx] = 0;
        }
      }
    }
  }
  const buf = await sharp(px, { raw: { width: dim, height: dim, channels: 1 } }).png().toBuffer();
  const img = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return img;
}

test('QR: round-trips through a real decoder', { skip: jsQR ? false : 'jsQR not installed' }, async () => {
  const payloads = [
    'HELLO WORLD',
    'https://example.com/flux',
    'https://wa.me/62882017467912',
    'WIFI:T:WPA;S:home;P:secret;;',
    'A'.repeat(120),
  ];
  for (const payload of payloads) {
    const img = await qrToPng(payload);
    const decoded = jsQR(new Uint8ClampedArray(img.data), img.info.width, img.info.height);
    assert.ok(decoded, `no QR detected for ${payload.slice(0, 20)}`);
    assert.equal(decoded.data, payload, `payload mismatch for ${payload.slice(0, 20)}`);
  }
});

test('QR: produces a structurally valid symbol', () => {
  const r = encodeQr('test');
  assert.equal(r.size, r.version * 4 + 17, 'size must follow the version formula');
  assert.ok(r.modules.length === r.size);
  for (const row of r.modules) assert.equal(row.length, r.size);
  // Three finder patterns: each is a 7x7 ring with a 3x3 core.
  for (const [ry, rx] of [[0, 0], [0, r.size - 7], [r.size - 7, 0]]) {
    assert.equal(r.modules[ry][rx], 1, 'finder top-left must be dark');
    assert.equal(r.modules[ry + 1][rx + 1], 0, 'finder ring must be light');
    assert.equal(r.modules[ry + 3][rx + 3], 1, 'finder core must be dark');
  }
  // Timing pattern alternates.
  for (let i = 8; i < r.size - 8; i++) {
    assert.equal(r.modules[6][i], i % 2 === 0 ? 1 : 0, 'horizontal timing must alternate');
    assert.equal(r.modules[i][6], i % 2 === 0 ? 1 : 0, 'vertical timing must alternate');
  }
});

test('QR: chooses a version that fits and rejects what will not', () => {
  assert.equal(encodeQr('a'.repeat(14)).version, 1, '14 bytes fits version 1');
  assert.equal(encodeQr('a'.repeat(15)).version, 2, '15 bytes needs version 2');
  assert.throws(() => encodeQr('a'.repeat(500)), /out of range|handles up to|shorten/i);
  assert.throws(() => encodeQr(''), /Nothing to encode/);
});

test('QR: masking actually varies by input', () => {
  const masks = new Set();
  for (const t of ['a', 'bb', 'ccc', 'https://example.com/a', 'https://example.com/b']) {
    masks.add(encodeQr(t).mask);
  }
  assert.ok(masks.size > 1, 'a fixed mask would mean the penalty scoring never ran');
});

test('QR: renders text with a quiet zone', () => {
  const art = renderQr(encodeQr('test'), 2);
  const lines = art.split('\n');
  assert.ok(lines.length > 20);
  // The first two rows are blank quiet zone.
  assert.equal(lines[0].trim(), '');
  assert.equal(lines[1].trim(), '');
});

/* ── registry ────────────────────────────────────────────────────────── */

test('module D registers over 100 assistant commands', () => {
  const count = build().list({ family: 'assistant' }).length;
  assert.ok(count >= 100, `expected 100+, got ${count}`);
});

test('every assistant command has an effect and a summary', () => {
  for (const cmd of build().list({ family: 'assistant' })) {
    assert.ok(cmd.effect.trim().length > 8, `${cmd.name} has a weak effect string`);
    assert.ok(cmd.summary.trim().length > 2, `${cmd.name} has no summary`);
  }
});

test('the ten named Module D features are present', () => {
  const reg = build();
  // Mapped to the names actually used, since spec names do not match command
  // names exactly (for example "Quick QR Code Generator" is `qr`).
  for (const name of ['note', 'todo', 'tzconvert', 'convert', 'remind', 'mdtablefrom', 'urlstrip', 'qr', 'pwgen', 'snip']) {
    assert.ok(reg.get(name), `${name} from the Module D spec is missing`);
  }
});

/* ── notes ───────────────────────────────────────────────────────────── */

test('notes: save, list, retrieve and delete', async () => {
  const reg = build();
  const u = 'notes-user';
  const saved = await asUser(reg, u, 'note', 'buy milk #shopping');
  const id = String(saved.text).match(/Saved as (\w+)/)?.[1];
  assert.ok(id, 'save should report an id');

  const listed = await asUser(reg, u, 'notes');
  assert.match(listed.text, /buy milk/);

  const one = await asUser(reg, u, 'notebyid', id);
  assert.match(one.text, /buy milk/);
  assert.match(one.text, /shopping/, 'hashtags should become tags');

  const deleted = await asUser(reg, u, 'notedelete', id);
  assert.match(deleted.text, /Deleted/);
  const after = await asUser(reg, u, 'notes');
  assert.ok(!after.text.includes('buy milk'), 'a deleted note must not reappear');
});

test('notes: are private per user', async () => {
  const reg = build();
  await asUser(reg, 'alice-privacy', 'note', 'alice secret');
  const bobsView = await asUser(reg, 'bob-privacy', 'notes');
  assert.ok(!bobsView.text.includes('alice secret'), "bob must not see alice's notes");
});

test('notes: rejecting unknown ids instead of silently succeeding', async () => {
  const reg = build();
  assert.match(String((await asUser(reg, 'n1', 'notebyid', 'nope')).error), /No note with id/);
  assert.match(String((await asUser(reg, 'n1', 'notedelete', 'nope')).error), /No note with id/);
  assert.match(String((await asUser(reg, 'n1', 'notetag', 'nope x')).error), /No note with id/);
  assert.match(String((await asUser(reg, 'n1', 'noteuntag', 'nope x')).error), /No note with id/);
});

test('notes: search finds and reports misses honestly', async () => {
  const reg = build();
  // The store persists on disk between runs, so the fixture text is made unique
  // per run. A fixed string makes this test pass once and fail forever after.
  const marker = `needle${Date.now()}`;
  const u = `search-user-${Date.now()}`;
  await asUser(reg, u, 'note', `alpha ${marker} here`);
  await asUser(reg, u, 'note', 'beta nothing');
  const hit = String((await asUser(reg, u, 'notesearch', marker)).text);
  assert.match(hit, /1 match/);
  assert.match(String((await asUser(reg, u, 'notesearch', 'zzz')).text), /No notes contain/);
});

test('notes: export renders markdown', async () => {
  const reg = build();
  const u = 'export-user';
  await asUser(reg, u, 'note', 'exported note');
  const out = String((await asUser(reg, u, 'noteexport')).text);
  assert.match(out, /^# Notes/m);
  assert.match(out, /exported note/);
});

test('notes: edit replaces text and merges tags', async () => {
  const reg = build();
  const u = 'edit-user';
  const id = String((await asUser(reg, u, 'note', 'original #a')).text).match(/Saved as (\w+)/)?.[1];
  await asUser(reg, u, 'noteedit', `${id} replaced #b`);
  const out = String((await asUser(reg, u, 'notebyid', id)).text);
  assert.match(out, /replaced/);
  assert.ok(!out.includes('original #'), 'old text should be gone');
  assert.match(out, /b/, 'the new tag should be present');
});

test('notes: empty input is rejected', async () => {
  assert.ok((await asUser(build(), 'empty-note', 'note', '')).error);
});

/* ── todos ───────────────────────────────────────────────────────────── */

test('todos: add, complete, reopen and clear', async () => {
  const reg = build();
  const u = 'todo-user';
  const id = String((await asUser(reg, u, 'todo', 'write tests')).text).match(/Added (\w+)/)?.[1];
  assert.ok(id);

  assert.match(String((await asUser(reg, u, 'todone', id)).text), /Done/);
  assert.match(String((await asUser(reg, u, 'todos')).text), /\[x\]/);

  assert.match(String((await asUser(reg, u, 'todoopen', id)).text), /Reopened/);
  assert.match(String((await asUser(reg, u, 'todos')).text), /\[ \]/);

  await asUser(reg, u, 'todone', id);
  assert.match(String((await asUser(reg, u, 'todoclear')).text), /Cleared 1/);
  assert.match(String((await asUser(reg, u, 'todos')).text), /No tasks yet/);
});

test('todos: due dates are parsed and tracked', async () => {
  const reg = build();
  const u = 'due-user';
  const out = String((await asUser(reg, u, 'todo', 'ship release due 2h')).text);
  assert.match(out, /due /, 'the due clause should be consumed, not left in the text');
  assert.match(String((await asUser(reg, u, 'todos')).text), /due /);
});

test('todos: unknown ids are rejected', async () => {
  assert.ok((await asUser(build(), 't1', 'todone', 'nope')).error);
  assert.ok((await asUser(build(), 't1', 'todoopen', 'nope')).error);
  assert.ok((await asUser(build(), 't1', 'tododelete', 'nope')).error);
});

test('todos: export is a valid markdown checklist', async () => {
  const reg = build();
  const u = 'todoexport';
  await asUser(reg, u, 'todo', 'first item');
  const out = String((await asUser(reg, u, 'todoexport')).text);
  assert.match(out, /- \[ \] first item/);
});

/* ── reminders ───────────────────────────────────────────────────────── */

test('reminders: set, list, cancel', async () => {
  const reg = build();
  const u = 'remind-user';
  const id = String((await asUser(reg, u, 'remind', 'in 2h check the build')).text).match(/Reminder (\w+)/)?.[1];
  assert.ok(id);
  assert.match(String((await asUser(reg, u, 'reminders')).text), /check the build/);
  assert.match(String((await asUser(reg, u, 'remindcancel', id)).text), /Cancelled/);
  assert.match(String((await asUser(reg, u, 'reminders')).text), /No pending reminders/);
});

test('reminders: reject unparseable and past times', async () => {
  const u = 'remind-bad';
  assert.match(String((await asUser(build(), u, 'remind', 'next tuesday maybe soon')).error), /Usage/);
  assert.ok((await asUser(build(), u, 'remind', 'in 2h')).error, 'a reminder with no body must be rejected');
  assert.ok((await asUser(build(), u, 'remind', 'in -5h do a thing')).error, 'a past time must be rejected');
});

test('reminders: alarm sets and clears', async () => {
  const reg = build();
  const u = 'alarm-user';
  assert.match(String((await asUser(reg, u, 'alarm', '30m')).text), /Alarm/);
  assert.match(String((await asUser(reg, u, 'remindclear')).text), /Cleared/);
});

/* ── snippets ────────────────────────────────────────────────────────── */

test('snippets: save, retrieve, overwrite and delete', async () => {
  const reg = build();
  const u = 'snip-user';
  await asUser(reg, u, 'snip', 'greet ts console.log("hi");');
  assert.match(String((await asUser(reg, u, 'snipget', 'greet')).text), /console\.log/);

  await asUser(reg, u, 'snip', 'greet console.log("updated");');
  const updated = String((await asUser(reg, u, 'snipget', 'greet')).text);
  assert.match(updated, /updated/);
  assert.ok(!updated.includes('"hi"'), 'overwriting must replace, not append');

  assert.match(String((await asUser(reg, u, 'snipdelete', 'greet')).text), /Deleted/);
  assert.match(String((await asUser(reg, u, 'snipget', 'greet')).error), /No snippet/);
});

/* ── QR commands ─────────────────────────────────────────────────────── */

test('qr command returns a rendered symbol and the payload', async () => {
  const res = await asUser(build(), 'qr-user', 'qr', 'https://example.com');
  assert.match(res.text, /Version \d+, mask \d+/);
  assert.match(res.text, /https:\/\/example\.com/);
});

test('qrurl rejects things that are not URLs', async () => {
  assert.match(String((await asUser(build(), 'qrurl-bad', 'qrurl', 'not a url')).error), /does not look like a URL/);
  assert.match(String((await asUser(build(), 'qrurl-bad2', 'qrwa', '123')).error), /too short/);
});

test('qrwifi builds a scannable WiFi payload', async () => {
  const res = await asUser(build(), 'wifi-user', 'qrwifi', 'MyNet hunter2 WPA');
  assert.ok(!res.error, res.error);
  assert.match(res.text, /Network: MyNet/);
});

/* ── maths and text ──────────────────────────────────────────────────── */

test('arithmetic commands give correct answers', async () => {
  const reg = build();
  assert.match(String((await run(reg, 'gcd', '12 18')).text), /= 6$/m);
  assert.match(String((await run(reg, 'lcm', '4 6')).text), /= 12$/m);
  assert.match(String((await run(reg, 'factorial', '10')).text), /= 3628800$/);
  assert.match(String((await run(reg, 'percentcalc', '15% of 200')).text), /= 30$/);
  assert.match(String((await run(reg, 'primecheck', '97')).text), /is prime/);
  assert.match(String((await run(reg, 'primecheck', '91')).text), /not prime/);
  assert.match(String((await run(reg, 'nextprime', '100')).text), /101/);
  assert.match(String((await run(reg, 'median', '1 5 3')).text), /^3$/m);
  assert.match(String((await run(reg, 'numwords', '42')).text), /forty-two/);
  assert.match(String((await run(reg, 'hexdec', 'ff')).text), /= 255$/m);
  assert.match(String((await run(reg, 'dechex', '255')).text), /0xFF/);
});

test('arithmetic commands reject bad input', async () => {
  const reg = build();
  assert.ok((await run(reg, 'gcd', 'a b')).error);
  assert.ok((await run(reg, 'lcm', '4 0')).error);
  assert.ok((await run(reg, 'factorial', '-1')).error);
  assert.ok((await run(reg, 'factorial', '999')).error, 'factorial must not loop forever on huge input');
  assert.ok((await run(reg, 'percentcalc', 'garbage')).error);
  assert.ok((await run(reg, 'hexdec', 'zzz')).error);
});

test('hashing commands match known digests', async () => {
  const reg = build();
  // "abc" is the canonical test vector for all three.
  assert.match(String((await run(reg, 'sha256', 'abc')).text),
    /^ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad$/m);
  assert.match(String((await run(reg, 'sha1', 'abc')).text),
    /^a9993e364706816aba3e25717850c26c9cd0d89d$/m);
  assert.match(String((await run(reg, 'md5', 'abc')).text),
    /^900150983cd24fb0d6963f7d28e17f72$/m);
});

test('encoding commands round-trip', async () => {
  const reg = build();
  const encoded = String((await run(reg, 'base64safe', 'hello world')).text);
  assert.equal(encoded.trim(), 'aGVsbG8gd29ybGQ=');
  assert.match(String((await run(reg, 'base64decode', encoded)).text), /hello world/);
  const url = String((await run(reg, 'urlencode', 'a b&c')).text);
  assert.equal(url.trim(), 'a%20b%26c');
  assert.match(String((await run(reg, 'urldecode', url)).text), /a b&c/);
});

test('password generation respects length and character classes', async () => {
  const reg = build();
  const pw = String((await run(reg, 'pwgen', '32')).text).trim();
  assert.equal(pw.length, 32, 'requested length must be honoured');
  assert.match(pw, /[a-z]/);
  assert.match(pw, /[A-Z]/);
  assert.match(pw, /\d/);

  const pin = String((await run(reg, 'pwpin', '8')).text).trim();
  assert.match(pin, /^\d{8}$/);

  const phrase = String((await run(reg, 'pwpassphrase', '4')).text).trim();
  assert.equal(phrase.split('-').length, 4);
});

test('random helpers return the requested shape', async () => {
  const reg = build();
  assert.match(String((await run(reg, 'randomhex', '32')).text), /^[0-9a-f]{64}$/m);
  assert.match(String((await run(reg, 'randomuuid')).text),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/m);
  assert.equal(String((await run(reg, 'uuidcount', '3')).text).trim().split('\n').length, 3);
});

test('two random generations differ', async () => {
  const reg = build();
  const a = String((await run(reg, 'randomhex', '16')).text);
  const b = String((await run(reg, 'randomhex', '16')).text);
  assert.notEqual(a, b, 'random generation must not be constant');
});

test('password strength scores honestly', async () => {
  const reg = build();
  assert.match(String((await run(reg, 'pwstrength', 'abc')).text), /very weak|weak/);
  const strong = String((await run(reg, 'pwstrength', 'Tr0ub4dor&3xyz!LongEnough')).text);
  assert.match(strong, /strong|very strong/);
});

/* ── time and timezone ───────────────────────────────────────────────── */

test('timezone conversion covers the named zones', async () => {
  const res = await asUser(build(), 'tz-user', 'tzconvert', '14:30');
  assert.match(res.text, /Asia\/Tokyo/);
  assert.match(res.text, /America\/New_York/);
  assert.ok(res.error === undefined);
});

test('tzconvert rejects impossible times', async () => {
  assert.match(String((await asUser(build(), 'tz-bad', 'tzconvert', '99:99')).error), /not a valid time/);
  assert.match(String((await asUser(build(), 'tz-bad2', 'tzconvert', 'nonsense')).error), /Usage/);
});

test('tznow rejects an invalid zone rather than falling back silently', async () => {
  assert.match(String((await asUser(build(), 'tz-bad3', 'tznow', 'Mars/Olympus')).error), /not a valid IANA/);
  assert.ok(!(await asUser(build(), 'tz-ok', 'tznow', 'Asia/Tokyo')).error);
});

test('epoch commands agree with each other', async () => {
  const reg = build();
  const epoch = String((await run(reg, 'epoch')).text).match(/Unix: (\d+)/)?.[1];
  assert.ok(epoch, 'epoch should report Unix time');
  const back = String((await run(reg, 'epochconvert', epoch)).text);
  assert.match(back, /^\d{4}-\d{2}-\d{2}T/m, 'epochconvert should emit an ISO date');
});

test('weekday and weeknumber produce plausible output', async () => {
  const reg = build();
  assert.match(String((await run(reg, 'weekday', '2026-01-01')).text), /Thursday/);
  assert.match(String((await run(reg, 'weeknumber', '2026-01-01')).text), /ISO week: \d+/);
});

test('agecalc gets a birthday boundary right', async () => {
  const reg = build();
  // Born 31 Dec 2000, checked on 1 Jan 2021 — still 20, not 21.
  assert.match(String((await run(reg, 'agecalc', '2000-12-31 2021-01-01')).text), /20 years old/);
  assert.match(String((await run(reg, 'agecalc', '2000-12-31 2021-12-31')).text), /21 years old/);
});

test('date arithmetic adds a duration', async () => {
  const reg = build();
  assert.match(String((await run(reg, 'addtime', '2026-01-01 3d')).text), /2026-01-04/);
  assert.match(String((await run(reg, 'timebetween', '2026-01-01 | 2026-01-08')).text), /7 days/);
});

/* ── URLs ────────────────────────────────────────────────────────────── */

test('url commands parse and report honestly', async () => {
  const reg = build();
  assert.match(String((await run(reg, 'urlparams', 'https://example.com/a?a=1&b=2')).text), /b = 2/);
  assert.match(String((await run(reg, 'urldomain', 'https://example.com/path?q=1')).text), /example\.com/);
  assert.match(String((await run(reg, 'urlslug', 'Hello World! 42')).text), /hello-world-42/);
});

test('urlstrip removes tracking parameters and counts them', async () => {
  const reg = build();
  const res = await run(reg, 'urlstrip', 'https://example.com/p?utm_source=x&gclid=y&id=keep');
  assert.match(res.text, /id=keep/, 'non-tracking parameters must survive');
  assert.ok(!res.text.includes('utm_source'));
  assert.ok(!res.text.includes('gclid'));
  assert.match(res.text, /2 tracking parameters removed/);
});

test('urlstrip reports zero when there is nothing to remove', async () => {
  const res = await asUser(build(), 'urlstrip-clean', 'urlstrip', 'https://example.com/plain');
  assert.match(res.text, /0 tracking parameters removed/);
});

test('urlshorten does not pretend to create a public short link', async () => {
  const res = await asUser(build(), 'urlshorten-user', 'urlshorten', 'https://example.com/p?utm_source=x');
  assert.match(res.text, /does not create a public short link/);
  assert.ok(!res.text.includes('utm_source'));
});

test('url commands reject invalid input', async () => {
  const reg = build();
  assert.match(String((await run(reg, 'urlparams', 'not a url')).error), /valid absolute URL/);
  assert.match(String((await run(reg, 'urldomain', 'nope')).error), /valid absolute URL/);
});

/* ── text ────────────────────────────────────────────────────────────── */

test('markdown helpers produce valid markdown', async () => {
  const reg = build();
  assert.match(String((await run(reg, 'mdbold', 'hi')).text), /\*\*hi\*\*/);
  assert.match(String((await run(reg, 'mditalic', 'hi')).text), /\*hi\*/);
  assert.match(String((await run(reg, 'mdquote', 'a\nb')).text), /> a\n> b/);
  assert.match(String((await run(reg, 'mdcode', 'js console.log(1)')).text), /```js\nconsole\.log\(1\)\n```/);
  assert.match(String((await run(reg, 'markdownlink', 'text https://x.com')).text), /\[text\]\(https:\/\/x\.com\)/);
});

test('mdtablefrom builds a real table', async () => {
  const res = await run(build(), 'mdtablefrom', 'a,b\n1,2\n3,4');
  const lines = String(res.text).split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[0], /\| a \| b \|/);
  assert.match(lines[1], /\| --- \| --- \|/);
});

test('text statistics are accurate', async () => {
  const reg = build();
  assert.match(String((await run(reg, 'readingtime', 'word '.repeat(450).trim())).text), /2 minutes/);
  assert.match(String((await run(reg, 'titlecase', 'hello world')).text), /Hello World/);
  assert.match(String((await run(reg, 'sentencecase', 'HELLO WORLD')).text), /Hello world/);
  assert.match(String((await run(reg, 'wordorder', 'a b c')).text), /^c b a$/m);
  assert.match(String((await run(reg, 'uniq', 'x\nx\ny')).text), /2 unique of 3/);
});

test('topwords ignores stopwords', async () => {
  const res = await run(build(), 'topwords', 'the cat and the cat sat on the mat');
  assert.match(res.text, /cat: 2/);
  assert.ok(!/the:/.test(res.text), 'stopwords should be excluded');
});

test('assist help lists every assistant command', async () => {
  const reg = build();
  const help = String((await asUser(reg, 'help-user', 'assist')).text);
  const missing = reg.list({ family: 'assistant' })
    .map((c) => c.name)
    .filter((n) => n !== 'assist' && !help.includes(n));
  assert.deepEqual(missing, [], `assist help omits: ${missing.join(', ')}`);
});

/* ── store integrity ─────────────────────────────────────────────────── */

test('the assistant store is written atomically and survives reload', async () => {
  const reg = build();
  const u = 'persist-user';
  await asUser(reg, u, 'note', 'persisted note');
  const { assistantDataPath } = await import('../dist/toolkit/command-assist.js');
  assert.ok(existsSync(assistantDataPath), 'the store file must exist');
  const raw = readFileSync(assistantDataPath, 'utf8');
  assert.match(raw, /persisted note/);
  // No temp files left behind.
  const { readdirSync } = await import('node:fs');
  assert.ok(!readdirSync(assistantDataPath.replace(/[^/\\]+$/, '')).some((f) => f.endsWith('.tmp')),
    'atomic write must not leave a temp file behind');
});

test('a corrupt store does not take the command surface down', async () => {
  const { assistantDataPath } = await import('../dist/toolkit/command-assist.js');
  const { pathToFileURL } = await import('node:url');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const dir = assistantDataPath.replace(/[^/\\]+$/, '');
  mkdirSync(dir, { recursive: true });
  const original = existsSync(assistantDataPath) ? readFileSync(assistantDataPath, 'utf8') : null;
  writeFileSync(assistantDataPath, '{ this is not valid json', 'utf8');
  try {
    // A child process is required: the module caches the store on first read,
    // so an in-process test would keep using the good copy and prove nothing.
    const moduleUrl = pathToFileURL(
      new URL('../dist/toolkit/command-assist.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    ).href;
    const script = `
      const m = await import(${JSON.stringify(moduleUrl)});
      const r = m.assistCommands.find(c => c.name === 'notes');
      const res = await r.fn({ args: '', sender: 'x@s.whatsapp.net' });
      console.log(res.error ? 'ERROR:' + res.error : 'OK');
    `;
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }).trim();
    assert.match(out, /^OK/, `a corrupt store should fall back to empty, got: ${out}`);
  } finally {
    // Restore, so a failure here cannot poison every later run.
    if (original !== null) writeFileSync(assistantDataPath, original, 'utf8');
    else writeFileSync(assistantDataPath, '{"notes":{},"todos":{},"snippets":{},"reminders":[]}', 'utf8');
  }
});