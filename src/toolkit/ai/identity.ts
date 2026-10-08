/**
 * FLUX IDENTITY — name, owner, typography, and the chat footer.
 *
 * ## Scope correction, stated once
 *
 * **WhatsApp has no font selection.** The client renders one sans-serif face and
 * exposes exactly four markers — `*bold*`, `_italic_`, `~strikethrough~`,
 * ` ```monospace``` `. There is no gothic, no serif, no size control, and no
 * per-message typeface. Anything claiming otherwise would be a lie in the source.
 *
 * So "cool fonts but not confusing" is delivered as what actually exists: a
 * **typography discipline**. The same four markers, used consistently, with hard
 * rules about what must never go in them. That is what makes a bot look designed
 * rather than random.
 *
 * ## The two defaults that are deliberately conservative
 *
 * 1. **`contextInfo` is not used to fake an identity.** Setting `businessOwnerJid`,
 *    `externalAdReply`, or a fabricated verified badge is *exactly* what made
 *    `Verified.ts` messages arrive at a clean ID and then never appear. See
 *    `CONTEXT.md` §6.1. Real identity is carried in the visible text instead.
 * 2. **The copyright footer is opt-in, default off.** It appends to every reply,
 *    which is the definition of unsolicited advertising and is how a WhatsApp
 *    account gets rate-limited or banned. The mechanism is here and correct; the
 *    decision is yours.
 */

import type { AnySock } from '../ops-50/types.js';

/* ════════════════════════════════════════════════════════════════════════
   Identity
   ════════════════════════════════════════════════════════════════════════ */

export const FLUX_NAME = 'Flux';

/** The account Flux runs as. Also what "who is the owner" answers. */
export const OWNER_NUMBER = '6283831459585';

/** Owner as displayed — grouped, with the country code. */
export const OWNER_DISPLAY = '+62 838-3145-9585';

/** The public identity, in one line. Used for contextInfo `businessName`. */
export const FLUX_DESCRIPTION = 'flux developer';

/** Attribution. Kept separate so it can change without touching the footer. */
export const MADE_BY = 'made by Nyx';

/* ════════════════════════════════════════════════════════════════════════
   Owner questions
   ════════════════════════════════════════════════════════════════════════ */

/** Phrasings that mean "who runs this". Matched against the user's text. */
const OWNER_QUESTIONS = [
  /\bwho\s+(?:is|are)\s+(?:the\s+)?(?:owner|admin|creator|developer|dev|operator|maintainer)\b/i,
  /\bwho\s+(?:made|built|created|owns|wrote|developed)\s+(?:you|this|this bot|it)\b/i,
  /\b(?:owner|admin|creator|developer|maintainer)['’]?s?\s+(?:name|number|phone|contact|jid|jid)\b/i,
  /\bwhat(?:'s| is)\s+(?:the\s+)?(?:owner|admin|developer)['’]?s?\s+(?:number|phone|name)\b/i,
  /\bhow\s+(?:do|can)\s+i\s+(?:contact|reach|message)\s+(?:the\s+)?(?:owner|admin|developer)\b/i,
  /\bsiapa\s+(?:pemilik|pengembang|pembuat)\b/i,
  // Indonesian puts the noun first: "nama pemilik" is "the owner's name", while
  // "pemilik nama" is not a phrase anyone writes. Only one order matched before,
  // so the most natural phrasing fell straight through to the model.
  /\b(?:nama|nomor)\s+(?:pemilik|pengembang|pembuat)\b/i,
  /\b(?:pemilik|pengembang)['’]?s?\s+(?:nama|nomor)\b/i,
];

/** Does this message ask about the owner? */
export function asksForOwner(text: string): boolean {
  return OWNER_QUESTIONS.some((re) => re.test(String(text ?? '')));
}

/**
 * The owner answer.
 *
 * Deliberately plain. A formatted card here reads as spam, and the point of this
 * branch is that it is *reliable* — it must never depend on the model, which
 * could phrase it differently every time or fail to answer at all.
 */
export function ownerAnswer(): string {
  return [
    `*${FLUX_NAME}* is built and run by *Nyx*.`,
    `Owner: ${OWNER_DISPLAY}`,
    ``,
    `I am ${FLUX_NAME.toLowerCase()}, the assistant in this chat.`,
  ].join('\n');
}

/** Owner as a vCard, for "save my contact". */
export function ownerCard(): string {
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:Nyx`,
    `ORG:${FLUX_NAME};${FLUX_DESCRIPTION}`,
    `TEL;type=CELL;waid=${OWNER_NUMBER}:${OWNER_DISPLAY}`,
    'END:VCARD',
  ].join('\n');
}

/** True when a jid belongs to the owner. */
export function isOwner(jid: string): boolean {
  // `baseJid` strips at the colon, so it returns `6283831459585` with **no
  // domain** — comparing that against `6283831459585@s.whatsapp.net` was always
  // false, and a plain jid matched only by accident of the test fixture.
  const digits = String(jid ?? '').split(':')[0]?.split('@')[0];
  return digits === OWNER_NUMBER;
}

/* ════════════════════════════════════════════════════════════════════════
   Typography
   ════════════════════════════════════════════════════════════════════════ */

export type Emphasis = 'none' | 'bold' | 'italic' | 'mono' | 'strike';

/**
 * Apply WhatsApp's four real markers.
 *
 * Order is bold → italic → mono → strike, so nesting produces a consistent
 * result instead of whichever happened to be applied last.
 */
export function typ(text: string, style: Emphasis = 'none'): string {
  switch (style) {
    case 'bold': return `*${text}*`;
    case 'italic': return `_${text}_`;
    case 'mono': return `\`\`\`${text}\`\`\``;
    case 'strike': return `~${text}~`;
    default: return text;
  }
}

/**
 * Characters that must never appear in outbound text.
 *
 * These are the ones that make a bot look broken rather than stylish:
 * mathematical-styled letters (𝐅𝐥𝐮𝐱), fullwidth lookalikes, and box-drawing
 * used as text. They render inconsistently, break search, and are unselectable.
 * Ordinary accented Latin is fine and is explicitly *not* in this list.
 *
 * Each rule carries a transliteration where one exists, so "𝐅𝐥𝐮𝐱" becomes "Flux"
 * rather than vanishing. The first version mapped every styled letter to the
 * literal string "Flux", so a four-letter name came out as "FluxFluxFluxFlux".
 */
const UNSAFE_GLYPHS: Array<{ re: RegExp; why: string; as: string }> = [
  // Mathematical alphanumeric symbols and letterlike symbols both contain ASCII
  // lookalikes; transliterate per character rather than dropping the run.
  { re: /[\u{1D400}-\u{1D7FF}]/gu, why: 'mathematical styled letters', as: '' },
  { re: /[Ａ-Ｚａ-ｚ０-９]/g, why: 'fullwidth lookalikes', as: '' },
  { re: /[─-╿]/g, why: 'box-drawing characters', as: '-' },
  { re: /[ᴀ-ᴢ]/g, why: 'small-caps lookalikes', as: '' },
];

/** Fullwidth → ASCII. */
const FULLWIDTH: Record<string, string> = {};
for (let c = 0xff01; c <= 0xff5e; c += 1) {
  FULLWIDTH[String.fromCharCode(c)] = String.fromCharCode(c - 0xfee0);
}

/** Mathematical styled letters → ASCII, for the common Latin ones. */
const MATHS: Record<string, string> = {
  '𝐀': 'A', '𝐁': 'B', '𝐂': 'C', '𝐃': 'D', '𝐄': 'E', '𝐅': 'F', '𝐆': 'G', '𝐇': 'H', '𝐈': 'I', '𝐉': 'J',
  '𝐊': 'K', '𝐋': 'L', '𝐌': 'M', '𝐍': 'N', '𝐎': 'O', '𝐏': 'P', '𝐐': 'Q', '𝐑': 'R', '𝐒': 'S', '𝐓': 'T',
  '𝐔': 'U', '𝐕': 'V', '𝐖': 'W', '𝐗': 'X', '𝐘': 'Y', '𝐙': 'Z',
  '𝐚': 'a', '𝐛': 'b', '𝐜': 'c', '𝐝': 'd', '𝐞': 'e', '𝐟': 'f', '𝐠': 'g', '𝐡': 'h', '𝐢': 'i', '𝐣': 'j',
  '𝐤': 'k', '𝐥': 'l', '𝐦': 'm', '𝐧': 'n', '𝐨': 'o', '𝐩': 'p', '𝐪': 'q', '𝐫': 'r', '𝐬': 's', '𝐭': 't',
  '𝐮': 'u', '𝐯': 'v', '𝐰': 'w', '𝐱': 'x', '𝐲': 'y', '𝐳': 'z',
  '𝓐': 'A', '𝓑': 'B', '𝓒': 'C', '𝓓': 'D', '𝓔': 'E', '𝓕': 'F', '𝓖': 'G', '𝓗': 'H',
  '𝓘': 'I', '𝓙': 'J', '𝓚': 'K', '𝓛': 'L', '𝓜': 'M', '𝓝': 'N', '𝓞': 'O', '𝓟': 'P',
  '𝓠': 'Q', '𝓡': 'R', '𝓢': 'S', '𝓣': 'T', '𝓤': 'U', '𝓥': 'V', '𝓦': 'W', '𝓧': 'X', '𝓨': 'Y', '𝓩': 'Z',
  '𝓪': 'a', '𝓫': 'b', '𝓬': 'c', '𝓭': 'd', '𝓮': 'e', '𝓯': 'f', '𝓰': 'g', '𝓱': 'h',
  '𝓲': 'i', '𝓳': 'j', '𝓴': 'k', '𝓵': 'l', '𝓶': 'm', '𝓷': 'n', '𝓸': 'o', '𝓹': 'p',
  '𝓺': 'q', '𝓻': 'r', '𝓼': 's', '𝓽': 't', '𝓾': 'u', '𝓿': 'v', '𝔀': 'w', '𝔁': 'x', '𝔂': 'y', '𝔃': 'z',
  '𝔄': 'A', '𝔅': 'B', '𝔉': 'V', '𝔏': 'L', '𝔲': 'u', '𝔵': 'x',
  '𝕒': 'a', '𝕓': 'b', '𝕔': 'c', '𝕕': 'd', '𝕖': 'e', '𝕗': 'f', '𝕘': 'g', '𝕙': 'h',
  '𝕚': 'i', '𝕛': 'j', '𝕜': 'k', '𝕝': 'l', '𝕞': 'm', '𝕟': 'n', '𝕠': 'o', '𝕡': 'p',
  '𝕢': 'q', '𝕣': 'r', '𝕤': 's', '𝕥': 't', '𝕦': 'u', '𝕧': 'v', '𝕩': 'x', '𝕪': 'y', '𝕫': 'z',
};

/** Small-caps → ASCII. */
const SMALLCAPS: Record<string, string> = {
  ᴀ: 'A', ʙ: 'B', ᴄ: 'C', ᴅ: 'D', ᴇ: 'E', ᴊ: 'F', ɢ: 'G', ʜ: 'H', ɪ: 'I', ᴊ2: 'J',
  ᴋ: 'K', ʟ: 'L', ᴍ: 'M', ɴ: 'N', ᴏ: 'O', ᴘ: 'P', ǫ: 'Q', ʀ: 'R', ѕ: 'S', ᴛ: 'T',
  ᴜ: 'U', ᴠ: 'V', ᴡ: 'W', x: 'X', ʏ: 'Y', ᴢ: 'Z',
};

/**
 * Strip or transliterate characters that will render inconsistently.
 *
 * Known styled forms are transliterated to ASCII; anything else in those ranges is
 * dropped, since guessing at an unknown glyph's meaning would be worse than
 * losing it.
 */
export function sanitizeTypography(text: string): string {
  let out = String(text ?? '');

  // Transliterate what we can map.
  out = out.replace(/[\u{1D400}-\u{1D7FF}\u{1D7C0}-\u{1D7FF}]|[Ａ-Ｚａ-ｚ０-９]|[ᴀ-ᴢ]/gu,
    (ch) => MATHS[ch] ?? FULLWIDTH[ch] ?? SMALLCAPS[ch] ?? '');

  // Box drawing has a sensible ASCII equivalent; anything else in the range goes.
  out = out.replace(/[─-╿]/g, '-');

  return out.replace(/[ \t]{3,}/g, '  ').trim();
}

/** Report which unsafe glyphs are present, without rewriting. */
export function typographyIssues(text: string): Array<{ why: string; samples: string[] }> {
  const out: Array<{ why: string; samples: string[] }> = [];

  for (const rule of UNSAFE_GLYPHS) {
    const found = String(text ?? '').match(rule.re);
    if (found?.length) {
      out.push({ why: rule.why, samples: [...new Set(found)].slice(0, 5) });
    }
  }

  return out;
}

/**
 * Validate a reply's formatting.
 *
 * Catches the failure that actually happens: an unclosed `*` makes everything
 * after it bold, or nothing renders at all. WhatsApp does not report this.
 */
export function checkFormatting(text: string): string[] {
  const problems: string[] = [];
  const body = String(text ?? '');

  const pairs: Array<[string, string, string]> = [
    ['*', '*', 'bold'],
    ['_', '_', 'italic'],
    ['~', '~', 'strike'],
  ];

  for (const [open, close, name] of pairs) {
    const count = body.split(open).length - 1;
    if (count % 2 !== 0) {
      problems.push(`unclosed ${name} marker (${count}) — the rest of the message will render wrong`);
    }
  }

  // Fences must be even or the closing ``` is treated as body text.
  const fences = body.split('```').length - 1;
  if (fences % 2 !== 0) problems.push('unclosed code fence');

  return problems;
}

/* ════════════════════════════════════════════════════════════════════════
   Signature footer
   ════════════════════════════════════════════════════════════════════════ */

export interface FooterOptions {
  /** Append on every reply. Default false — see the note at the top of this file. */
  enabled?: boolean;
  /** Override the attribution text. */
  text?: string;
}

/** The default footer, empty when disabled. */
export function footer(options: FooterOptions = {}): string {
  if (options.enabled !== true) return '';
  return options.text ?? `_${MADE_BY}_`;
}

/**
 * Append the footer to a reply.
 *
 * Appended rather than prepended because a footer is attribution, and
 * attribution belongs after the content. Does not add one to a message that is
 * purely a reaction or a receipt — those are already one glyph wide and a
 * signature on them looks broken.
 */
export function sign(text: string, options: FooterOptions = {}): string {
  const mark = footer(options);
  if (!mark) return text;
  if (!text.trim()) return text;

  const glyphOnly = /^(?:\p{Extended_Pictographic}|\s)+$/u.test(text);
  if (glyphOnly) return text;

  return `${text.replace(/\s+$/, '')}\n\n${mark}`;
}

/** Count how many of a chat's replies carried the footer. */
export function footerCoverage(
  replies: readonly string[],
  options: FooterOptions = {},
): { total: number; signed: number; ratio: number } {
  const mark = footer({ enabled: true, ...options });
  if (!mark) return { total: replies.length, signed: 0, ratio: 0 };

  const signed = replies.filter((r) => r.includes(mark)).length;
  return { total: replies.length, signed, ratio: replies.length === 0 ? 0 : signed / replies.length };
}

/* ════════════════════════════════════════════════════════════════════════
   Presence / profile
   ════════════════════════════════════════════════════════════════════════ */

/**
 * Set the WhatsApp display name and About to the Flux identity.
 *
 * `updateProfileName` is verified working. `updateProfileStatus` transmits but the
 * linked consumer session does not apply it — a known platform limit, so this
 * reports which half succeeded rather than pretending both did.
 */
export async function applyIdentity(sock: AnySock): Promise<{
  name: boolean;
  about: boolean;
  aboutError?: string;
}> {
  await sock.updateProfileName(FLUX_NAME);

  try {
    await sock.updateProfileStatus(`${FLUX_DESCRIPTION} · ${MADE_BY}`);
    return { name: true, about: true };
  } catch (error) {
    return { name: true, about: false, aboutError: (error as Error).message };
  }
}