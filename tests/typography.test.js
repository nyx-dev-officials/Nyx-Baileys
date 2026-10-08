/**
 * Flux typography tests — one font per feature file.
 *
 * These exist for the four failure modes that are invisible in a type check and
 * catastrophic in production:
 *
 *   1. Two features sharing a face. The whole point is that a `groups` message
 *      is distinguishable from an `analytics` message. A copy-paste into the
 *      wrong slot in `FEATURE_FONTS` would look correct and defeat the design.
 *   2. A routing key getting styled. A styled `row.id` or `buttonId` breaks
 *      reply matching — and only on device, never in a unit test.
 *   3. Values getting styled. Poll options are data a user reads back and
 *      copies; styled digits are harder to verify at a glance.
 *   4. Gothic creeping back in. Fraktur was explicitly rejected as cringey.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  brand,
  brandContent,
  isStyled,
  FEATURE_FONTS,
  BRAND_SIGNATURE,
} from '../dist/features/typography.js';

const GOTHIC = /[\u{1D504}\u{1D51E}\u{1D52E}\u{1D53E}]/u;
const STYLED = /[\u{1D400}-\u{1D7FF}\u{1D7C0}-\u{1D7FF}]/u;

/** The seven feature files that render to a user, per src/features/. */
const RENDERING_FEATURES = [
  'analytics', 'auth', 'groups', 'i18n', 'media', 'messaging', 'observability',
];

test('every feature file has its own face', () => {
  const rendered = RENDERING_FEATURES.map((f) => brand('Nyx Flux', f));
  const unique = new Set(rendered);
  assert.equal(unique.size, RENDERING_FEATURES.length,
    `features share a face: ${RENDERING_FEATURES.length} features produced ${unique.size} distinct renderings`);
});

test('every rendering feature file is mapped', () => {
  for (const f of RENDERING_FEATURES) {
    assert.ok(FEATURE_FONTS[f], `feature file ${f} has no assigned font`);
  }
});

test('internal-only modules are deliberately unmapped', () => {
  // helpers.ts and index.ts are plumbing. A font for "shared utilities" would be
  // meaningless, and mapping them would imply they render something.
  assert.equal(FEATURE_FONTS.helpers, undefined);
  assert.equal(FEATURE_FONTS.index, undefined);
});

test('no feature uses gothic/fraktur', () => {
  for (const f of RENDERING_FEATURES) {
    const out = brand('Luxury Nyx', f);
    assert.ok(!GOTHIC.test(out), `${f} leaked a gothic glyph: ${out}`);
  }
});

test('brand produces styled output for every feature', () => {
  for (const f of RENDERING_FEATURES) {
    assert.ok(isStyled(brand('Fruits', f)), `${f} did not style anything`);
  }
});

test('every face sits in a range isStyled() actually covers', () => {
  // The failure mode is quiet and compounding: a face outside the detector's
  // ranges is re-styled on every call, so `ɢʀᴜɪᴛs` becomes `ɢɢʀʀᴏᴏᴜᴅᴅ`.
  // It happened for small caps (IPA block) and full-width (FF block), so this
  // asserts the detector agrees with the map rather than trusting the ranges.
  for (const f of RENDERING_FEATURES) {
    const once = brand('Fruits', f);
    assert.ok(isStyled(once), `${f} renders outside isStyled()'s ranges`);
    assert.equal(brand(brand(brand(once, f), f), f), once,
      `${f} grows a glyph per pass — its range is not detected`);
  }
});

test('readable faces only — no calligraphic script in the set', () => {
  // `groups` on script and `media` on bold script were both cut: the loops and
  // ascenders fill in at phone body size and were reported unreadable on device.
  // That is a hardware judgement, so it is pinned here rather than re-tried.
  // Math script lives at U+1D49C..U+1D4CF (small) and U+1D4D0..U+1D4E9 (cap).
  const SCRIPTS = /[\u{1D49C}-\u{1D4E9}]/u;
  for (const f of RENDERING_FEATURES) {
    assert.ok(!SCRIPTS.test(brand('Group Media Report', f)),
      `${f} reintroduced a calligraphic face that was unreadable on a phone`);
  }
});

test('each face holds only its own Unicode block', () => {
  // Hand-typed glyphs drift silently: a terminal's fallback font renders a
  // script letter and an italic letter identically, so `ITALIC` held script
  // codepoints (U+1D4B6) while claiming to be italic. Codepoints are the only
  // reliable check.
  //
  // Only the four approved faces appear here — small caps, bold, bold-italic,
  // italic — plus tracking, which contributes U+200A and no letters at all.
  const ALLOWED = {
    // Tracked bold.
    auth: [[0x1D400, 0x1D433]],
    // Tight bold.
    groups: [[0x1D400, 0x1D433]],
    // Tight italic.
    i18n: [[0x1D434, 0x1D467]],
    // Tracked italic.
    media: [[0x1D434, 0x1D467]],
    // Tight bold-italic.
    messaging: [[0x1D468, 0x1D49B]],
    // Tracked small caps.
    analytics: [[0x0100, 0x02AF], [0x1D00, 0x1D24], [0x0041, 0x007A], [0x0490, 0x04FF]],
    // Tight small caps.
    observability: [[0x0100, 0x02AF], [0x1D00, 0x1D24], [0x0041, 0x007A], [0x0490, 0x04FF]],
  };

  for (const [f, ranges] of Object.entries(ALLOWED)) {
    // Tracking contributes hair spaces (U+200A), which are not letters and so
    // are stripped before the block check.
    const letters = brand('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', f)
      .replace(/[\u200A\s]/g, '');
    for (const ch of letters) {
      const cp = ch.codePointAt(0);
      assert.ok(
        ranges.some(([lo, hi]) => cp >= lo && cp <= hi),
        `${f} rendered U+${cp.toString(16).toUpperCase()} outside its own blocks`,
      );
    }
  }
});

test('media is wide-set italic, per the approved palette', () => {
  // The approved faces on hardware were small caps, bold, bold-italic and
  // italic. Seven files, four faces — so tracking separates the rest. `media`
  // takes tracked italic, the closest in-text analogue of the Liberation Serif
  // Italic / Exo Italic reference the user supplied.
  const out = brand('Report', 'media');
  assert.ok(out.includes('\u200A'), 'media must be tracked');
  const onlyLetters = out.replace(/[\u200A\s]/g, '');
  // Italic capital R is U+1D45E; italic small r is U+1D48F.
  for (const ch of onlyLetters) {
    const cp = ch.codePointAt(0);
    assert.ok((cp >= 0x1D434 && cp <= 0x1D467),
      `media rendered U+${cp.toString(16).toUpperCase()}, not italic`);
  }
});

test('every feature is distinguishable, using tracking where faces repeat', () => {
  const rendered = RENDERING_FEATURES.map((f) => brand('Group Media Report', f));
  assert.equal(new Set(rendered).size, RENDERING_FEATURES.length,
    'features collided — a feature needs its own presentation');
});

test('tracking inserts hair space between letters only', () => {
  // U+200A is the thin/hair space. A normal space would be indistinguishable
  // from a word break, which is wrong here: tracking is a letter-level
  // treatment and must not masquerade as a word boundary in the payload.
  const out = brand('Group Created', 'media');
  assert.ok(out.includes('\u200A'), 'media must be tracked');
  assert.ok(!out.includes(' \u200A'), 'a wide space leaked beside the hair spaces');
  // The original word boundary is still the only real space.
  assert.equal(out.replace(/\u200A/gu, '').split(' ').length, 2,
    'word count changed once tracking was removed');
});

test('single characters are not tracked', () => {
  // Tracking a one-character string adds nothing but a stray space.
  assert.equal(brand('A', 'media'), brand('A', 'media').replace('\u200A', ''));
  assert.ok(!brand('A', 'media').includes('\u200A'));
});

test('plain forces unstyled output', () => {
  assert.equal(brand('Mango', 'plain'), 'Mango');
  assert.equal(brand('12345', 'plain'), '12345');
  assert.equal(brand(BRAND_SIGNATURE, 'plain'), BRAND_SIGNATURE,
    'plain returns input verbatim; it does not transliterate back to ASCII');
});

test('styling is idempotent for every feature', () => {
  for (const f of RENDERING_FEATURES) {
    const once = brand('Fruits', f);
    assert.equal(brand(once, f), once, `${f} is not idempotent`);
  }
});

test('empty and whitespace input pass through', () => {
  for (const f of RENDERING_FEATURES) {
    assert.equal(brand('', f), '');
    assert.equal(brand('   ', f), '   ');
  }
});

test('non-string input is coerced, not thrown on', () => {
  for (const f of RENDERING_FEATURES) {
    assert.equal(brand(null, f), '');
    assert.equal(brand(undefined, f), '');
    assert.equal(brand(42, f), brand('42', f));
  }
});

test('isStyled detects and only detects styled faces', () => {
  assert.equal(isStyled(BRAND_SIGNATURE), true);
  assert.equal(isStyled('Nyx'), false);
  assert.equal(isStyled(''), false);
});

test('signature is styled and gothic-free', () => {
  assert.ok(isStyled(BRAND_SIGNATURE));
  assert.ok(!GOTHIC.test(BRAND_SIGNATURE));
  assert.ok(BRAND_SIGNATURE.includes('•'), 'the separator is brand identity');
});

test('no face emits WhatsApp native formatting markers', () => {
  // Explicitly rejected: *bold*, _italic_, ~strike~, ```mono```. Those render
  // through WhatsApp's own font stack, which is crisp — but the decision is
  // Unicode variants only, so the library must never emit the markers itself.
  // Live text formatting is the caller's, not typography's.
  const SAMPLE = 'Group Created 1234';
  for (const f of RENDERING_FEATURES) {
    const out = brand(SAMPLE, f);
    assert.ok(!/[*_~`]/.test(out), `${f} emitted a native marker: ${out}`);
  }
});

test('punctuation and spaces survive styling', () => {
  // The maps only cover [A-Za-z0-9]; everything else must pass through or the
  // text becomes mangled and unreadable.
  for (const f of RENDERING_FEATURES) {
    const out = brand('Flux: rate-limit (hit!) #3 — 50%', f);
    assert.ok(out.includes(':')); assert.ok(out.includes('!'));
    assert.ok(out.includes('#')); assert.ok(out.includes('—'));
    assert.ok(out.includes('%'));
  }
});

test('brandContent styles labels in the requested feature face', () => {
  const out = brandContent({
    listMessage: {
      title: 'Fruits',
      sections: [{ title: 'Tropical', rows: [{ id: 'a', title: 'Mango' }] }],
    },
  }, 'groups');
  assert.equal(out.listMessage.title, brand('Fruits', 'groups'));
  assert.equal(out.listMessage.sections[0].title, brand('Tropical', 'groups'));
  assert.equal(out.listMessage.sections[0].rows[0].title, brand('Mango', 'groups'));
});

test('brandContent keeps routing keys ASCII', () => {
  const out = brandContent({
    listMessage: {
      title: 'Fruits',
      sections: [{ title: 'Tropical', rows: [{ id: 'fruit_mango', title: 'Mango' }] }],
    },
  }, 'messaging');
  assert.equal(out.listMessage.sections[0].rows[0].id, 'fruit_mango',
    'a styled row id breaks reply matching on device only');
});

test('brandContent keeps poll options plain', () => {
  const out = brandContent(
    { poll: { name: 'Best Fruit', values: ['Mango', 'Banana'] } },
    'analytics',
  );
  assert.equal(out.poll.name, brand('Best Fruit', 'analytics'));
  assert.deepEqual(out.poll.values, ['Mango', 'Banana'],
    'poll options are data a user reads back and copies');
});

test('brandContent keeps buttonId ASCII and styles the label', () => {
  const out = brandContent({
    buttonsMessage: {
      headerText: 'Pick one',
      contentText: 'body text',
      buttons: [{ buttonId: 'confirm_yes', buttonText: { displayText: 'Confirm' } }],
    },
  }, 'media');
  const btn = out.buttonsMessage.buttons[0];
  assert.equal(btn.buttonId, 'confirm_yes');
  assert.equal(btn.buttonText.displayText, brand('Confirm', 'media'));
  assert.equal(out.buttonsMessage.headerText, brand('Pick one', 'media'));
  assert.equal(out.buttonsMessage.contentText, 'body text',
    'body prose stays readable, not styled');
});

test('brandContent styles template headings', () => {
  const out = brandContent({
    templateMessage: {
      hydratedTemplate: { hydratedTitleText: 'Done', hydratedSubTitleText: 'Summary' },
    },
  }, 'observability');
  const t = out.templateMessage.hydratedTemplate;
  assert.equal(t.hydratedTitleText, brand('Done', 'observability'));
  assert.equal(t.hydratedSubTitleText, brand('Summary', 'observability'));
});

test('brandContent styles contact display name', () => {
  const out = brandContent(
    { contacts: { displayName: 'Nyx Support', contacts: [{ jid: 'x@s.whatsapp.net' }] } },
    'messaging',
  );
  assert.equal(out.contacts.displayName, brand('Nyx Support', 'messaging'));
  assert.deepEqual(out.contacts.contacts, [{ jid: 'x@s.whatsapp.net' }],
    'nested contact data is untouched');
});

test('brandContent does not mutate its input', () => {
  const original = { poll: { name: 'Best Fruit', values: ['Mango'] } };
  const snapshot = JSON.stringify(original);
  brandContent(original, 'analytics');
  assert.equal(JSON.stringify(original), snapshot, 'input was mutated in place');
});

test('brandContent preserves unrelated fields', () => {
  const out = brandContent({
    poll: { name: 'Best Fruit', values: ['Mango'] },
    contextInfo: { forwardingScore: 1 },
    stanzaId: 'abc123',
  }, 'analytics');
  assert.equal(out.contextInfo.forwardingScore, 1);
  assert.equal(out.stanzaId, 'abc123');
});

test('brandContent leaves text and unknown keys alone', () => {
  const out = brandContent({ text: 'hello', custom: { deep: 1 } }, 'groups');
  assert.equal(out.text, 'hello');
  assert.deepEqual(out.custom, { deep: 1 });
});

test('two features render the same string differently', () => {
  const sample = 'Group Created';
  const a = brand(sample, 'groups');
  const b = brand(sample, 'observability');
  assert.notEqual(a, b);
  // Both are styled, and both are one glyph per input character. Note the length
  // is NOT comparable across faces: script/double-struck glyphs live in the
  // astral plane and cost two UTF-16 units each, while small caps are BMP. That
  // is a property of Unicode, not a bug — but it is exactly why any layout code
  // must measure by codepoint, never by string length.
  assert.equal([...a].length, [...sample].length);
  assert.equal([...b].length, [...sample].length);
  assert.ok(isStyled(a) && isStyled(b));
});