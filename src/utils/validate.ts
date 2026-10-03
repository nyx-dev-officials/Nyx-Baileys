/**
 * Small pure predicates.
 *
 * `src/security/validate.ts` is a validator *framework* — composable,
 * path-tracking, for gating untrusted inbound payloads. This is the other
 * thing: the one-line checks a command writes inline (`if (!isPhone(arg)) …`),
 * with no allocation and no dependency on the engine. All of it rides the
 * `lite` entry.
 */

/* ── URLs and contacts ───────────────────────────────────────────────── */

/** An absolute `http:`/`https:` URL. */
export function isUrl(input: string): boolean {
  try {
    const url = new URL(String(input ?? '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** A syntactically plausible email address (not a deliverability check). */
export function isEmail(input: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(input ?? '').trim());
}

/**
 * A phone number: an optional `+`, then 7–15 digits with optional spaces,
 * dashes, dots or parentheses between groups. Deliberately permissive — it
 * answers "does this look like a number", not "is this number assigned".
 */
export function isPhone(input: string): boolean {
  const text = String(input ?? '').trim();
  if (!/^\+?[\d\s().-]+$/.test(text)) return false;
  const digits = text.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

/** Digits only. Keep an explicit `+` with `keepPlus`. */
export function normalizePhone(input: string, keepPlus = false): string {
  const digits = String(input ?? '').replace(/\D/g, '');
  return keepPlus && digits ? `+${digits}` : digits;
}

/** `+` and digits, or `null` when the input is not a plausible number. */
export function toE164(input: string): string | null {
  const text = String(input ?? '').trim();
  if (!isPhone(text)) return null;
  return `+${text.replace(/\D/g, '')}`;
}

/* ── simple shapes ───────────────────────────────────────────────────── */

/** A non-empty run of ASCII digits (no sign, no separator). */
export function isNumeric(input: string): boolean {
  return /^\d+$/.test(String(input ?? ''));
}

/** An integer, permitting a leading sign. */
export function isInteger(input: string): boolean {
  return /^[+-]?\d+$/.test(String(input ?? '').trim());
}

/** Lower- or upper-case hex of even length (0x-prefixed also accepted). */
export function isHex(input: string): boolean {
  const text = String(input ?? '').trim().replace(/^0x/i, '');
  return text.length > 0 && text.length % 2 === 0 && /^[0-9a-f]+$/i.test(text);
}

/** A well-formed base64 string (standard alphabet, padded). */
export function isBase64(input: string): boolean {
  const text = String(input ?? '').trim();
  return text.length > 0 && text.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(text);
}

/* ── emoji ───────────────────────────────────────────────────────────── */

// Extended_Pictographic covers the emoji a user actually types; the extra
// ranges catch keycaps, variation selectors and regional-indicator flags.
const EMOJI = /(\p{Extended_Pictographic}|\p{Regional_Indicator}|\u{FE0F}|\u{20E3})/u;
const EMOJI_GLOBAL = /(\p{Extended_Pictographic}|\p{Regional_Indicator})/gu;

/** Whether the string contains at least one emoji. */
export function hasEmoji(input: string): boolean {
  return EMOJI.test(String(input ?? ''));
}

/** Count pictographic emoji (flags count once; modifiers are not double-counted). */
export function countEmoji(input: string): number {
  const matches = String(input ?? '').match(EMOJI_GLOBAL);
  return matches ? matches.length : 0;
}

/** Every emoji in the string, in order. */
export function extractEmoji(input: string): string[] {
  return String(input ?? '').match(EMOJI_GLOBAL) ?? [];
}

/** True when the string is only emoji and whitespace. An empty string is false. */
export function isEmojiOnly(input: string): boolean {
  const text = String(input ?? '').trim();
  if (!text) return false;
  return text.replace(EMOJI_GLOBAL, '').trim().length === 0;
}

/** Strip pictographic emoji and the joiners that hold sequences together. */
export function stripEmoji(input: string): string {
  return String(input ?? '')
    .replace(/(\p{Extended_Pictographic}|\p{Regional_Indicator})[\u{FE0F}\u{200D}\u{20E3}]*/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
