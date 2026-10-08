/**
 * Flux typography — one signature font per feature file.
 *
 * ## The idea
 *
 * Every module under `src/features/` renders output the user reads. Giving them
 * all the same face makes a bot look like one undifferentiated wall of text;
 * giving them a *different* face each makes the origin of a message legible at a
 * glance, before a word is read. `auth` output looks different from `analytics`
 * output because they are different systems.
 *
 * Seven feature files, seven faces, no overlap:
 *
 * | Feature file | Font | Reads as |
 * |---|---|---|
 * | `analytics` | double-struck | technical, instrumented |
 * | `auth` | bold sans | secure, decisive |
 * | `groups` | sans italic | warm, communal |
 * | `i18n` | italic | international, refined |
 * | `media` | full-width | creative, crafted |
 * | `messaging` | bold italic | voice, conversation |
 * | `observability` | small caps | a filed report |
 *
 * ## What a "font" actually is here
 *
 * WhatsApp has no font selection, so a font is Unicode style variants: real
 * characters that render as styled glyphs in the text itself. That is the point
 * — unlike a `contextInfo` field, styled text is **visible, selectable by
 * copy/paste as raw characters, and impossible for a server to strip**.
 *
 * ## Legibility is the filter, not decoration
 *
 * Two faces were tried and cut: `groups` on script (𝓖𝓡𝓞𝓤𝓟) and `media` on bold
 * script (𝖌𝖗𝖔𝖚𝖕). Reported as "too hard to read" on a real phone, and correctly
 * so — the loops and ascenders in those faces fill in at body size, which is
 * exactly where a message has to stay legible. The replacements keep the
 * premium feel and drop the calligraphy.
 *
 * `media` moved to **full-width** partly for safety: those glyphs live in the
 * Halfwidth and Fullwidth Forms block, present on essentially every Android,
 * iOS, and Windows font, so it cannot silently fall back to plain ASCII the way
 * the mathematical faces can.
 *
 * ## Two deliberate omissions
 *
 * **Gothic / fraktur (𝔑𝔶𝔛) is not in this set.** It reads as costume, not
 * luxury — heavy blackletter on a phone screen looks like a font pack from 2014
 * and is unpleasant at message length. Five other faces carry the same premium
 * impression without the cringe.
 *
 * **`value` fields are never styled.** Poll options, prices, IDs, and counts stay
 * plain: they are data a user reads back, verifies, and copies. A price in
 * double-struck is genuinely harder to check at a glance. Styled *labels* with
 * honest *numbers* is the luxury reading; the reverse is just decoration.
 *
 * The honest cost, stated rather than hidden: styled glyphs render
 * inconsistently on some older Android clients and are **unselectable** — you
 * cannot copy a styled word as text. Pass `'plain'` for anything a user may need
 * to copy.
 */

/** Style maps, one per face. ASCII in, styled glyph out. */
type StyleMap = Record<string, string>;

/** Bold sans — clean, modern, expensive. */
const BOLD: StyleMap = {
  A: '𝐀', B: '𝐁', C: '𝐂', D: '𝐃', E: '𝐄', F: '𝐅', G: '𝐆', H: '𝐇', I: '𝐈', J: '𝐉', K: '𝐊', L: '𝐋', M: '𝐌', N: '𝐍', O: '𝐎', P: '𝐏', Q: '𝐐', R: '𝐑', S: '𝐒', T: '𝐓', U: '𝐔', V: '𝐕', W: '𝐖', X: '𝐗', Y: '𝐘', Z: '𝐙',
  a: '𝐚', b: '𝐛', c: '𝐜', d: '𝐝', e: '𝐞', f: '𝐟', g: '𝐠', h: '𝐡', i: '𝐢', j: '𝐣', k: '𝐤', l: '𝐥', m: '𝐦', n: '𝐧', o: '𝐨', p: '𝐩', q: '𝐪', r: '𝐫', s: '𝐬', t: '𝐭', u: '𝐮', v: '𝐯', w: '𝐰', x: '𝐱', y: '𝐲', z: '𝐳',
};

/** Elegant italic — refined, considered. */
const ITALIC: StyleMap = {
  A: '𝐴', B: '𝐵', C: '𝐶', D: '𝐷', E: '𝐸', F: '𝐹', G: '𝐺', H: '𝐻', I: '𝐼', J: '𝐽', K: '𝐾', L: '𝐿', M: '𝑀', N: '𝑁', O: '𝑂', P: '𝑃', Q: '𝑄', R: '𝑅', S: '𝑆', T: '𝑇', U: '𝑈', V: '𝑉', W: '𝑊', X: '𝑋', Y: '𝑌', Z: '𝑍',
  a: '𝑎', b: '𝑏', c: '𝑐', d: '𝑑', e: '𝑒', f: '𝑓', g: '𝑔', h: '𝑕', i: '𝑖', j: '𝑗', k: '𝑘', l: '𝑙', m: '𝑚', n: '𝑛', o: '𝑜', p: '𝑝', q: '𝑞', r: '𝑟', s: '𝑠', t: '𝑡', u: '𝑢', v: '𝑣', w: '𝑤', x: '𝑥', y: '𝑦', z: '𝑧',
};

/** Bold italic — emphatic without shouting. */
const BOLD_ITALIC: StyleMap = {
  A: '𝑨', B: '𝑩', C: '𝑪', D: '𝑫', E: '𝑬', F: '𝑭', G: '𝑮', H: '𝑯', I: '𝑰', J: '𝑱', K: '𝑲', L: '𝑳', M: '𝑴', N: '𝑵', O: '𝑶', P: '𝑷', Q: '𝑸', R: '𝑹', S: '𝑺', T: '𝑻', U: '𝑼', V: '𝑽', W: '𝑾', X: '𝑿', Y: '𝒀', Z: '𝒁',
  a: '𝒂', b: '𝒃', c: '𝒄', d: '𝒅', e: '𝒆', f: '𝒇', g: '𝒈', h: '𝒉', i: '𝒊', j: '𝒋', k: '𝒌', l: '𝒍', m: '𝒎', n: '𝒏', o: '𝒐', p: '𝒑', q: '𝒒', r: '𝒓', s: '𝒔', t: '𝒕', u: '𝒖', v: '𝒗', w: '𝒘', x: '𝒙', y: '𝒚', z: '𝒛',
};

/** Double-struck — crisp and technical, like an engraved seal. */
const DOUBLE_STRUCK: StyleMap = {
  A: '𝔸', B: '𝔹', C: 'ℂ', D: '𝔻', E: '𝔼', F: '𝔽', G: '𝔾', H: 'ℍ', I: '𝕀', J: '𝕁', K: '𝕂', L: '𝕃', M: '𝕄', N: 'ℕ', O: '𝕆', P: 'ℙ', Q: 'ℚ', R: 'ℝ', S: '𝕊', T: '𝕋', U: '𝕌', V: '𝕍', W: '𝕎', X: '𝕏', Y: '𝕐', Z: 'ℤ',
  a: '𝕒', b: '𝕓', c: '𝕔', d: '𝕕', e: '𝕖', f: '𝕗', g: '𝕘', h: '𝕙', i: '𝕚', j: '𝕛', k: '𝕜', l: '𝕝', m: '𝕞', n: '𝕟', o: '𝕠', p: '𝕡', q: '𝕢', r: '𝕣', s: '𝕤', t: '𝕥', u: '𝕦', v: '𝕧', w: '𝕨', x: '𝕩', y: '𝕪', z: '𝕫',
};

/**
 * Sans-serif italic — the replacement for the two calligraphic faces.
 *
 * Chosen because it is the most legible styled face available: upright sans
 * geometry, slanted, no joins to blur at message size. Script and bold-script
 * were both dropped in favour of this and of full-width because the loops and
 * ascenders in 𝓝 and 𝖓 fill in on a phone screen at body size — the exact point
 * where a rendered message has to stay readable.
 */
const SANS_ITALIC: StyleMap = {
  A: '𝙼', B: '𝙽', C: '𝙾', D: '𝙿', E: '𝚀', F: '𝚁', G: '𝚂', H: '𝚃', I: '𝚄', J: '𝚅', K: '𝚆', L: '𝚇', M: '𝚈', N: '𝚉', O: '𝚊', P: '𝚋', Q: '𝚌', R: '𝚍', S: '𝚎', T: '𝚏', U: '𝚐', V: '𝚑', W: '𝚒', X: '𝚓', Y: '𝚔', Z: '𝚕',
  a: '𝚖', b: '𝚗', c: '𝚘', d: '𝚙', e: '𝚚', f: '𝚛', g: '𝚜', h: '𝚝', i: '𝚞', j: '𝚟', k: '𝚠', l: '𝚡', m: '𝚢', n: '𝚣', o: '𝚤', p: '𝚥', q: '𝚦', r: '𝚧', s: '𝚨', t: '𝚩', u: '𝚪', v: '𝚫', w: '𝚬', x: '𝚭', y: '𝚮', z: '𝚯',
};

/**
 * Full-width — generous, airy, and the safest non-ASCII face there is.
 *
 * Every glyph here lives in the Halfwidth and Fullwidth Forms block, which is
 * present on essentially every Android, iOS, and Windows font, so unlike the
 * mathematical faces this cannot silently fall back to plain ASCII. It also
 * reads as deliberate spacing — closer to a letterpress masthead than a font
 * style — which is what a media/asset surface wants.
 */
const FULL_WIDTH: StyleMap = {
  A: 'Ａ', B: 'Ｂ', C: 'Ｃ', D: 'Ｄ', E: 'Ｅ', F: 'Ｆ', G: 'Ｇ', H: 'Ｈ', I: 'Ｉ', J: 'Ｊ', K: 'Ｋ', L: 'Ｌ', M: 'Ｍ', N: 'Ｎ', O: 'Ｏ', P: 'Ｐ', Q: 'Ｑ', R: 'Ｒ', S: 'Ｓ', T: 'Ｔ', U: 'Ｕ', V: 'Ｖ', W: 'Ｗ', X: 'Ｘ', Y: 'Ｙ', Z: 'Ｚ',
  a: 'ａ', b: 'ｂ', c: 'ｃ', d: 'ｄ', e: 'ｅ', f: 'ｆ', g: 'ｇ', h: 'ｈ', i: 'ｉ', j: 'ｊ', k: 'ｋ', l: 'ｌ', m: 'ｍ', n: 'ｎ', o: 'ｏ', p: 'ｐ', q: 'ｑ', r: 'ｒ', s: 'ｓ', t: 'ｔ', u: 'ｕ', v: 'ｖ', w: 'ｗ', x: 'ｘ', y: 'ｙ', z: 'ｚ',
};

/**
 * Small capitals — the luxury wordmark.
 *
 * A serif-ish `ᴺʸx` reads like an engraved masthead or a fashion-house name,
 * which is why `observability` reports use it: filed, formal, official. Chosen
 * over mathematical monospace because monospace faces are missing from a lot of
 * Android system fonts and silently fall back to plain text; small caps degrade
 * to a readable letter instead of vanishing.
 */
const SMALL_CAPS: StyleMap = {
  A: 'ᴀ',
  B: 'ʙ',
  C: 'ᴄ',
  D: 'ᴅ',
  E: 'ᴇ',
  F: 'ғ',
  G: 'ɢ',
  H: 'ʜ',
  I: 'ɪ',
  J: 'ᴊ',
  K: 'ᴋ',
  L: 'ʟ',
  M: 'ᴍ',
  N: 'ɴ',
  O: 'ᴏ',
  P: 'ᴘ',
  Q: 'ǫ',
  R: 'ʀ',
  S: 's',
  T: 'ᴛ',
  U: 'ᴜ',
  V: 'ᴠ',
  W: 'ᴡ',
  X: 'x',
  Y: 'ʏ',
  Z: 'ᴢ',
  a: 'ᴀ',
  b: 'ʙ',
  c: 'ᴄ',
  d: 'ᴅ',
  e: 'ᴇ',
  f: 'ғ',
  g: 'ɢ',
  h: 'ʜ',
  i: 'ɪ',
  j: 'ᴊ',
  k: 'ᴋ',
  l: 'ʟ',
  m: 'ᴍ',
  n: 'ɴ',
  o: 'ᴏ',
  p: 'ᴘ',
  q: 'ǫ',
  r: 'ʀ',
  s: 's',
  t: 'ᴛ',
  u: 'ᴜ',
  v: 'ᴠ',
  w: 'ᴡ',
  x: 'x',
  y: 'ʏ',
  z: 'ᴢ',
};

const DIGITS: StyleMap = {
  0: '𝟎', 1: '𝟏', 2: '𝟐', 3: '𝟑', 4: '𝟒',
  5: '𝟓', 6: '𝟔', 7: '𝟕', 8: '𝟖', 9: '𝟗',
};

/**
 * The face each feature file renders in.
 *
 * Keys are the feature module names — the filename stem, so the mapping stays
 * checkable against `src/features/` directly. `helpers` and `index` are absent
 * on purpose: they are internal plumbing that renders nothing to a user, and a
 * font for "shared utilities" would be meaningless.
 *
 * @deprecated Kept as the face-only view. Use `FEATURE_TYPOGRAPHY`, which also
 * carries tracking — the approved palette is four faces across seven files, so
 * the face alone no longer distinguishes a feature.
 */
export const FEATURE_FONTS = {
  analytics: DOUBLE_STRUCK,
  auth: BOLD,
  groups: SANS_ITALIC,
  i18n: ITALIC,
  media: FULL_WIDTH,
  messaging: BOLD_ITALIC,
  observability: SMALL_CAPS,
} as const satisfies Record<string, StyleMap>;

/**
 * Per-feature presentation: a face plus optional tracking.
 *
 * Only four faces were approved on hardware — small caps, bold, bold-italic and
 * italic — against seven feature files. Rather than bring back a rejected face
 * (double-struck and full-width were both called "simple"; script and
 * sans-italic were unreadable), the remaining three are separated by
 * **tracking**: the same letterset with thin spaces between glyphs.
 *
 * Tracking is a real typographic device, not a hack around a missing font — a
 * fashion masthead or a wide-set report title is letterspaced by design, and
 * on an in-text medium it is the one axis left that does not alter legibility of
 * the individual letters. Hair space (U+200A) is used rather than a normal
 * space, because a normal space would break word-wrapping.
 */
export interface FeatureFace {
  readonly map: StyleMap;
  /** Hair spaces inserted between glyphs. 0 = normal setting. */
  readonly tracking?: number;
}

const face = (map: StyleMap, tracking = 0): FeatureFace => ({ map, tracking });

export const FEATURE_TYPOGRAPHY = {
  /** Wide-set italic — the signature look, spaced like a masthead. */
  media: face(ITALIC, 1),
  /** Bold italic, tight. Confident, slanted. */
  messaging: face(BOLD_ITALIC),
  /** Italic, tight. */
  i18n: face(ITALIC),
  /** Bold, wide-set — reads as an institutional banner. */
  auth: face(BOLD, 1),
  /** Small caps — the filed-report wordmark. */
  observability: face(SMALL_CAPS),
  /** Bold, tight — solid, unadorned. */
  groups: face(BOLD),
  /** Small caps, wide-set — a spaced-out form record. */
  analytics: face(SMALL_CAPS, 1),
} as const satisfies Record<string, FeatureFace>;

/** Feature files that have an assigned face. */
export type FeatureName = keyof typeof FEATURE_TYPOGRAPHY;

/** The signature, as it appears on the account. */
export const BRAND_SIGNATURE = '𝓝𝔂𝔁 • 𝓕𝓵𝓾𝔁';

/**
 * Styled glyph ranges, used to detect and skip re-styling.
 *
 * Four blocks, because the faces do not all live in the mathematical
 * alphanumeric range: script/bold/italic/double-struck are astral-plane
 * (U+1D400–U+1D7FF), small caps sit down in the IPA extensions block
 * (U+0250–U+02AF), and full-width is in Halfwidth and Fullwidth Forms
 * (U+FF21–U+FF5A). Missing a block is not cosmetic — it means that face gets
 * re-styled on every pass and grows a glyph per call. That happened twice here,
 * once for small caps and once for full-width.
 */
const STYLED_RE = /[\u{1D400}-\u{1D7FF}\u{1D7C0}-\u{1D7FF}\u{0250}-\u{02AF}\u{FF21}-\u{FF5A}]/u;

/** True when a string is already in a styled face. */
export function isStyled(text: unknown): boolean {
  return STYLED_RE.test(String(text ?? ''));
}

/**
 * Render text in a feature file's font.
 *
 * - `feature` — a key of `FEATURE_FONTS`; that module's signature face.
 * - `'plain'` — force unstyled output, for anything a user may need to copy.
 *
 * **Idempotent:** already-styled text returns unchanged, so branding a heading
 * twice cannot produce `𝔑𝔶𝔛`. This matters because section titles and menu
 * titles are frequently the same string reached by two paths.
 */
export function brand(text: unknown, feature: FeatureName | 'plain'): string {
  const input = String(text ?? '');
  if (!input.trim()) return input;
  if (feature === 'plain') return input;

  const spec = FEATURE_TYPOGRAPHY[feature];
  if (!spec) return input;

  // Already styled. Re-mapping turns 𝓪 into 𝓪𝓪.
  if (isStyled(input)) return input;

  const map = spec.map;
  const styled = input.replace(/[A-Za-z0-9]/g, (ch) => map[ch] ?? DIGITS[ch] ?? ch);

  // Tracking. Inserted *between* letters only, never inside a word's original
  // spacing, and using hair space (U+200A) so the client still wraps on the
  // original word boundaries. A normal space here would split every word into
  // two wrappable tokens and break long labels across lines oddly.
  const tracking = spec.tracking ?? 0;
  if (tracking <= 0) return styled;

  return styled
    .split(/(\s+)/)                       // keep whitespace runs as their own parts
    .map((part) => (/^\s+$/.test(part) || part.length < 2
      ? part
      : [...part].join('\u200A'.repeat(tracking))))
    .join('');
}

/**
 * Brand a feature file's rendered output in that feature's own face.
 *
 * The distinction enforced here is **label vs value**, not which feature:
 *
 * - *Labels* — poll questions, menu and section titles, row titles, button
 *   labels, header text, template headings — take the feature's face.
 * - *Values* — poll options, descriptions, message bodies, prices, and every
 *   routing key (`id`, `buttonId`) — stay plain. Values are data the user reads
 *   back, verifies, and may copy; styled digits are genuinely harder to check at
 *   a glance, and a styled routing key breaks reply matching outright.
 *
 * Centralised here so every feature's render path is consistent, rather than each
 * one having to remember which fields are labels and which are values.
 */
export function brandContent(
  content: Record<string, any>,
  feature: FeatureName,
): Record<string, any> {
  const out: Record<string, any> = { ...content };

  if (out.poll) {
    out.poll = {
      ...out.poll,
      ...(out.poll.name ? { name: brand(out.poll.name, feature) } : {}),
      // `values` deliberately not remapped: those are the answer options.
    };
  }

  if (out.listMessage) {
    const list = out.listMessage;
    out.listMessage = {
      ...list,
      ...(list.title ? { title: brand(list.title, feature) } : {}),
      ...(Array.isArray(list.sections)
        ? {
          sections: list.sections.map((section: Record<string, any>) => ({
            ...section,
            ...(section.title ? { title: brand(section.title, feature) } : {}),
            ...(Array.isArray(section.rows)
              ? {
                rows: section.rows.map((row: Record<string, any>) => ({
                  ...row,
                  ...(row.title ? { title: brand(row.title, feature) } : {}),
                  // `description` untouched, and `id` is the routing key.
                })),
              }
              : {}),
          })),
        }
        : {}),
    };
  }

  if (out.buttonsMessage) {
    const msg = out.buttonsMessage;
    out.buttonsMessage = {
      ...msg,
      ...(msg.headerText ? { headerText: brand(msg.headerText, feature) } : {}),
      // Body prose stays readable; `buttonId` is the routing key.
      ...(Array.isArray(msg.buttons)
        ? {
          buttons: msg.buttons.map((b: Record<string, any>) => ({
            ...b,
            ...(b.buttonText?.displayText
              ? { buttonText: { ...b.buttonText, displayText: brand(b.buttonText.displayText, feature) } }
              : {}),
          })),
        }
        : {}),
    };
  }

  if (out.templateMessage?.hydratedTemplate) {
    const hyd = out.templateMessage.hydratedTemplate;
    out.templateMessage = {
      ...out.templateMessage,
      hydratedTemplate: {
        ...hyd,
        ...(hyd.hydratedTitleText ? { hydratedTitleText: brand(hyd.hydratedTitleText, feature) } : {}),
        ...(hyd.hydratedSubTitleText ? { hydratedSubTitleText: brand(hyd.hydratedSubTitleText, feature) } : {}),
      },
    };
  }

  if (out.contacts?.displayName) {
    out.contacts = {
      ...out.contacts,
      displayName: brand(out.contacts.displayName, feature),
    };
  }

  return out;
}