/**
 * Indonesian catalogue tests.
 *
 * The register is the point, and it is the thing that regresses easily: someone
 * reaching for a "friendlier" string puts `kamu` or `nggak` back in, and the whole
 * catalogue drifts toward street slang without a single failing test.
 *
 * So the forbidden forms are pinned as a list. Adding one to the catalogue
 * breaks the build rather than shipping.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ID, t, formatNumber, formatDate, pronoun } from '../dist/toolkit/i18n-id.js';
import { CommandRegistry } from '../dist/toolkit/command-registry.js';
import { installCoreFamilies } from '../dist/toolkit/command-families.js';
import { installBulkFamilies } from '../dist/toolkit/command-families-bulk.js';
import { dispatch } from '../dist/toolkit/command-dispatch.js';

const sock = { sendMessage: async () => ({}) };
const reg = installCoreFamilies(new CommandRegistry());
installBulkFamilies(reg);
const say = (body) => dispatch(reg, sock, 'x@s.whatsapp.net', body, { locale: 'id' });

/**
 * Colloquial forms that must never appear.
 *
 * Every one of these was in an earlier draft. They read as street slang, not as
 * a tool someone is operating.
 */
const FORBIDDEN = [
  /\bga ada\b/i, /\bgak\b/i, /\bnggak\b/i, /\bnya\b/i,
  /\bkayaknya\b/i, /\bmaybe\b/i, /\bbanget\b/i, /\bdong\b/i,
  /\budah\b/i, /\bgimana\b/i, /\byuk\b/i, /\bsih\b/i, /\bdoang\b/i,
  /\bkamu\b/i, /\bgue\b/i, /\bak\b/i,
];

test('no catalogue entry uses colloquial Indonesian', () => {
  for (const [key, value] of Object.entries(ID)) {
    for (const bad of FORBIDDEN) {
      assert.ok(!bad.test(value), `${key} uses colloquial form ${bad}: ${value}`);
    }
  }
});

test('no runtime output uses colloquial Indonesian', async () => {
  for (const body of ['flux convertt x', 'calc 2+2', 'flux zzzzzzzzzz', 'flux', 'chain zz']) {
    const r = await say(body);
    for (const text of [r.text ?? '', ...(r.suggestions ?? []).map((s) => s.summary)]) {
      for (const bad of FORBIDDEN) {
        assert.ok(!bad.test(text), `"${body}" produced colloquial text: ${text}`);
      }
    }
  }
});

test('the catalogue uses the polite pronoun consistently', () => {
  // `saya` for the bot, `Anda` for the user. The `kamu` form exists behind an
  // explicit opt-in and must not be the default.
  assert.deepEqual(pronoun(true), { self: 'saya', user: 'Anda' });
  assert.deepEqual(pronoun(), { self: 'saya', user: 'Anda' });
});

test('the fuzzy header uses the approved wording', async () => {
  // The exact phrasing that was requested, pinned so it does not drift back to
  // "ga ada perintah" / "yang paling mirip".
  const out = (await say('flux convertt 5 kg to lb')).text ?? '';
  assert.match(out, /^Tidak ada perintah `convertt`\. Perintah yang paling mirip:/m);
  assert.ok(!/ga ada/i.test(out));
});

test('the prefix message names the correct form', async () => {
  const out = (await say('calc 2+2')).text ?? '';
  assert.match(out, /awalan `flux`, jadi `flux calc`/);
  assert.match(out, /Ketik `flux help` untuk melihat daftar lengkap\./);
});

test('every key substitutes cleanly or leaves the placeholder visible', () => {
  for (const [key, value] of Object.entries(ID)) {
    const out = t(key, {});
    // No literal "undefined" ever reaches a user.
    assert.ok(!/undefined/.test(out), `${key} rendered undefined`);
    assert.ok(out.length > 0);
  }
});

test('placeholders are substituted', () => {
  assert.match(t('fuzzy.head', { token: 'convertt' }), /`convertt`/);
  assert.match(t('error.badNumber', { value: 'abc' }), /`abc`/);
  assert.match(t('api.needKey', { label: 'X' }), /X/);
});

test('an unknown key falls back rather than throwing', () => {
  assert.equal(t('no.such.key'), 'no.such.key');
});

test('Indonesian number formatting uses dot thousands and comma decimal', () => {
  const out = formatNumber(1234567.891);
  assert.match(out, /1\.234\.567/);
  assert.match(out, /,/);
  assert.ok(!out.includes('  '), 'no stray separators');
});

test('Indonesian date formatting renders in Indonesian', () => {
  const out = formatDate(new Date('2026-10-07T03:00:00Z'));
  // Indonesian month names, not English ones.
  assert.ok(!/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/.test(out),
    `date rendered in English: ${out}`);
});

test('command names stay English while the surrounding text is Indonesian', async () => {
  // A command a user must translate in their head defeats the purpose.
  const out = (await say('flux convertt 5 kg to lb')).text ?? '';
  assert.match(out, /convert/, 'the command name must not be translated');
  assert.match(out, /Tidak ada perintah/, 'the message around it must be Indonesian');
});

test('Indonesian output actually happens — not silently English', async () => {
  const out = (await say('flux zzzzzzzzzz')).text ?? '';
  assert.match(out, /Tidak ditemukan|Perintah yang paling mirip/);
});