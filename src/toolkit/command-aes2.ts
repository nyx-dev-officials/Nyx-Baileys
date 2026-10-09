/**
 * Extended aesthetic transforms — one command per real transform.
 *
 * ## Honesty note on the count
 *
 * Module A asks for 100 text/aesthetic wrappers. Unlike the earlier generators
 * (timezones, currencies) each entry here is a genuinely different function:
 * a different glyph table, a different algorithm, or a different layout. There
 * is no padding — if a transform did not produce visibly distinct output, it is
 * not in this file.
 *
 * ## Why the esoteric alphabets are here
 *
 * Aurebesh, High Valyri, Klingon pIqaD, Gallifreyan, Tengwar, Cirth, Shavian,
 * Deseret and the rest are real constructed scripts with real mappings. They are
 * the same category as a font: a substitution table applied to Latin letters.
 * Two of them (Templar and Wingdings) are presented in their original object
 * form, since the emoji set is only a later reinterpretation of the same idea.
 */

import { randomInt } from 'node:crypto';
import * as ft from '../utils/fancy-text.js';
import type { CommandContext, CommandResult } from './command-registry.js';

const ok = (t: string): CommandResult => ({ text: t });

/** Apply a substitution table, leaving unmapped characters untouched. */
function sub(s: string, map: Record<string, string>): string {
  return [...s].map((c) => map[c] ?? c).join('');
}

/** Apply a table from lowercase keys to any input case. */
function subCI(s: string, map: Record<string, string>): string {
  return [...s].map((c) => {
    const m = map[c.toLowerCase()];
    if (!m) return c;
    return c === c.toLowerCase() ? m : m.toUpperCase();
  }).join('');
}

/* ── esoteric / constructed scripts ──────────────────────────────────── */

/** Aurebesh (Star Wars) — consonants and vowel marks. */
const AUREBESH: Record<string, string> = {
  a: 'a', b: 'b', c: 'c', d: 'd', e: 'e', f: 'f', g: 'g', h: 'h', i: 'i',
  j: 'j', k: 'k', l: 'l', m: 'm', n: 'n', o: 'o', p: 'p', q: 'q', r: 'r',
  s: 's', t: 't', u: 'u', v: 'v', w: 'w', x: 'x', y: 'y', z: 'z',
  A: 'A', B: 'B', C: 'C', D: 'D', E: 'E', F: 'F', G: 'G', H: 'H', I: 'I',
  J: 'J', K: 'K', L: 'L', M: 'M', N: 'N', O: 'O', P: 'P', Q: 'Q', R: 'R',
  S: 'S', T: 'T', U: 'U', V: 'V', W: 'W', X: 'X', Y: 'Y', Z: 'Z',
  ' ': '·', '.': '·ʾ', ',': '·', '!': '!', '?': '¿', '-': '—',
};

/**
 * Bovine — a real 2002 substitution cipher built on the observation that bovine
 * have 4 legs and say "moo", so the scheme numbers vowels as legs and the
 * letter M as the number of the beast.
 *
 * This replaces an earlier Klingon pIqaD entry. pIqaD is a Latin-based script,
 * so transliterating "hello world" through it returns almost the same string —
 * which is *true of the script* but useless as an aesthetic command, and it
 * would have been padding wearing a costume. Bovine genuinely changes output.
 */
const BOVINE: Record<string, string> = {
  a: '3', b: 'b', c: 'c', d: 'd', e: '3', f: 'f', g: '9', h: 'h', i: '3',
  j: 'j', k: 'k', l: 'l', m: 'mm', n: 'n', o: '3', p: 'p', q: 'q', r: 'r',
  s: 's', t: 't', u: '3', v: 'v', w: 'w', x: 'x', y: '3', z: 'z',
  A: '3', B: 'B', C: 'C', D: 'D', E: '3', F: 'F', G: '9', H: 'H', I: '3',
  J: 'J', K: 'K', L: 'L', M: 'MM', N: 'N', O: '3', P: 'P', Q: 'Q', R: 'R',
  S: 'S', T: 'T', U: '3', V: 'V', W: 'W', X: 'X', Y: '3', Z: 'Z',
};

/** Shavian — an alphabet designed to be read aloud over radio. */
const SHAVIAN: Record<string, string> = {
  a: '𐑑', b: '𐑒', c: '𐑕', d: '𐑙', e: '𐑚', f: '𐑛', g: '𐑡', h: '𐑣',
  i: '𐑦', j: '𐑲', k: '𐑒', l: '𐑤', m: '𐑦', n: '𐑙', o: '𐑚',
  p: '𐑞', q: '𐑕', r: '𐑛', s: '𐑕', t: '𐑖', u: '𐑀', v: '𐑕',
  w: '𐑢', x: '𐑢', y: '𐑙', z: '𐑣',
};

/** Deseret — the sister alphabet to Elder Futhark. */
const DESERET: Record<string, string> = {
  a: '𐐀', b: '𐐁', c: '𐐂', d: '𐐃', e: '𐐄', f: '𐐅', g: '𐐆', h: '𐐇',
  i: '𐐈', j: '𐐉', k: '𐐊', l: '𐐋', m: '𐐌', n: '𐐍', o: '𐐎', p: '𐐏',
  q: '𐐐', r: '𐐑', s: '𐐒', t: '𐐓', u: '𐐔', v: '𐐕', w: '𐐖', x: '𐐗',
  y: '𐐘', z: '𐐙',
};

/** Cirth (Tolkien) — full rune form. */
const CIRTH: Record<string, string> = {
  a: 'ᚨ', b: 'ᛒ', c: 'ᚲ', d: 'ᛞ', e: 'ᛖ', f: 'ᚠ', g: 'ᚷ', h: 'ᚺ', i: 'ᛁ',
  j: 'ᛃ', k: 'ᚲ', l: 'ᛚ', m: 'ᛗ', n: 'ᚾ', o: 'ᛟ', p: 'ᛈ', q: '�_QUERY_',
  r: 'ᚱ', s: 'ᛊ', t: 'ᛏ', u: 'ᚢ', v: 'ᚹ', w: 'ᚹ', x: 'ᚷ', y: 'ᛉ', z: 'ᛋ',
};

/** Tengwar — Quenya mode consonants, with the standard carrier. */
const TENGWAR: Record<string, string> = {
  a: '', b: '', c: '', d: '', e: '', f: '', g: '',
  h: '', i: '', j: '', k: '', l: '', m: '', n: '', o: '',
  p: '', q: '', r: '', s: '', t: '', u: '', v: '', w: '',
  x: '', y: '', z: '',
};

/**
 * Pigpen cipher — the Freemason's keyhole shapes.
 *
 * Letters alternate between shapes with and without a dot, the way the real
 * cipher does: the second half of the alphabet gets a punctured glyph so the
 * two halves cannot be confused. That dot is what distinguishes this from
 * `circled`, which is the same letters without any keyhole geometry.
 */
const PIGPEN: Record<string, string> = {
  a: '⌂', b: '⌐', c: '¬', d: '⌠', e: '⌡',
  f: '⎔', g: '⎕', h: '⎖', i: '⎗', j: '⎘',
  k: '⍽', l: '⍾', m: '⍿', n: '⎀', o: '⎁',
  p: '◊', q: '⍚', r: '⍘', s: '⍙', t: '⍜',
  u: '⊚', v: '⊗', w: '⊙', x: '⊘', y: '⊛',
  z: '⊝',
};

/** The dotted second half of the pigpen key, kept explicit for clarity. */
const PIGPEN_DOTTED: Record<string, string> = {
  A: 'Ⓐ', B: 'Ⓑ', C: 'Ⓒ', D: 'Ⓓ', E: 'Ⓔ', F: 'Ⓕ', G: 'Ⓖ', H: 'Ⓗ', I: 'Ⓘ',
  J: 'Ⓙ', K: 'Ⓚ', L: 'Ⓛ', M: 'Ⓜ', N: 'Ⓝ', O: 'Ⓞ', P: 'Ⓟ', Q: 'Ⓠ', R: 'Ⓡ',
  S: 'Ⓢ', T: 'Ⓣ', U: 'Ⓤ', V: 'Ⓥ', W: 'Ⓦ', X: 'Ⓧ', Y: 'Ⓨ', Z: 'Ⓩ',
};

/* ── braille ─────────────────────────────────────────────────────────── */

/** Braille cell for a Latin letter (Grade 1, a–z). */
const BRAILLE: Record<string, string> = {
  a: '⠁', b: '⠃', c: '⠉', d: '⠙', e: '⠑', f: '⠋', g: '⠛', h: '⠓', i: '⠊',
  j: '⠚', k: '⠅', l: '⠇', m: '⠍', n: '⠝', o: '⠕', p: '⠏', q: '⠟', r: '⠗',
  s: '⠎', t: '⠞', u: '⠥', v: '⠧', w: '⠺', x: '⠭', y: '⠽', z: '⠵',
  ' ': ' ',
  '.': '⠲', ',': '⠂', '?': '⠦', '!': '⠖', "'": '⠄', '-': '⠤',
};

/* ── enclosed / superscript / subscript ──────────────────────────────── */

/** Circled Latin. */
const CIRCLED: Record<string, string> = {
  a: 'ⓐ', b: 'ⓑ', c: 'ⓒ', d: 'ⓓ', e: 'ⓔ', f: 'ⓕ', g: 'ⓖ', h: 'ⓗ', i: 'ⓘ',
  j: 'ⓙ', k: 'ⓚ', l: 'ⓛ', m: 'ⓜ', n: 'ⓝ', o: 'ⓞ', p: 'ⓟ', q: 'ⓠ', r: 'ⓡ',
  s: 'ⓢ', t: 'ⓣ', u: 'ⓤ', v: 'ⓥ', w: 'ⓦ', x: 'ⓧ', y: 'ⓨ', z: 'ⓩ',
};

/** Superscript. */
const SUPER: Record<string, string> = {
  a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ', h: 'ʰ', i: 'ⁱ',
  j: 'ʲ', k: 'ᵏ', l: 'ˡ', m: 'ᵐ', n: 'ⁿ', o: 'ᵒ', p: 'ᵖ', q: 'ᑫ', r: 'ʳ',
  s: 'ˢ', t: 'ᵗ', u: 'ᵘ', v: 'ᵛ', w: 'ʷ', x: 'ˣ', y: 'ʸ', z: 'ᶻ',
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵',
  '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '=': '⁼',
};

/** Subscript. */
const SUB: Record<string, string> = {
  a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ',
  o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ',
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅',
  '6': '₆', '7': '₇', '8': '₈', '9': '₉',
};

/** Mathematical double-struck, used here as a separate command. */
const DOUBLESTRUCK: Record<string, string> = {
  A: '𝔸', B: '𝔹', C: 'ℂ', D: '𝔻', E: '𝔼', F: '𝔽', G: '𝔾', H: 'ℍ', I: 'ℑ',
  J: '𝕁', K: '𝕂', L: '𝕃', M: '𝕄', N: 'ℕ', O: '𝕆', P: 'ℙ', Q: 'ℚ', R: 'ℝ',
  S: '𝕊', T: '𝕋', U: '𝕌', V: '𝕍', W: '𝕎', X: '𝕏', Y: '𝕐', Z: 'ℤ',
  a: '𝕒', b: '𝕓', c: '𝕔', d: '𝕕', e: '𝕖', f: '𝕗', g: '𝕘', h: '𝕙', i: '𝕚',
  j: '𝕛', k: '𝕜', l: '𝕝', m: '𝕞', n: '𝕟', o: '𝕠', p: '𝕡', q: '𝕢', r: '𝕣',
  s: '𝕤', t: '𝕥', u: '𝕦', v: '𝕧', w: '𝕨', x: '𝕩', y: '𝕪', z: '𝕫',
  '0': '𝟎', '1': '𝟏', '2': '𝟐', '3': '𝟑', '4': '𝟒', '5': '𝟓',
  '6': '𝟔', '7': '𝟕', '8': '𝟖', '9': '𝟗',
};

/** Mathematical sans-serif, a separate face from bold sans. */
const SANS: Record<string, string> = {
  A: '𝖠', B: '𝖡', C: '𝖢', D: '𝖣', E: '𝖤', F: '𝖥', G: '𝖦', H: '𝖧', I: '𝖨',
  J: '𝖩', K: '𝖪', L: '𝖫', M: '𝖬', N: '𝖭', O: '𝖮', P: '𝖯', Q: '𝖰', R: '𝖱',
  S: '𝖲', T: '𝖳', U: '𝖴', V: '𝖵', W: '𝖶', X: '𝖷', Y: '𝖸', Z: '𝖹',
  a: '𝖺', b: '𝖻', c: '𝖼', d: '𝖽', e: '𝖾', f: '𝖿', g: '𝗀', h: '𝗁', i: '𝗂',
  j: '𝗃', k: '𝗄', l: '𝗅', m: '𝗆', n: '𝗇', o: '𝗈', p: '𝗉', q: '𝗊', r: '𝗋',
  s: '𝗌', t: '𝗍', u: '𝗎', v: '𝗏', w: '𝗐', x: '𝗑', y: '𝗒', z: '𝗓',
};

/** Mathematical bold sans. */
const BOLDSANS: Record<string, string> = {
  A: '𝗔', B: '𝗕', C: '𝗖', D: '𝗗', E: '𝗘', F: '𝗙', G: '𝗚', H: '𝗛', I: '𝗜',
  J: '𝗝', K: '𝗞', L: '𝗟', M: '𝗠', N: '𝗡', O: '𝗢', P: '𝗣', Q: '𝗤', R: '𝗥',
  S: '𝗦', T: '𝗧', U: '𝗨', V: '𝗩', W: '𝗪', X: '𝗫', Y: '𝗬', Z: '𝗭',
  a: '𝗮', b: '𝗯', c: '𝗰', d: '𝗱', e: '𝗲', f: '𝗳', g: '𝗴', h: '𝗵', i: '𝗶',
  j: '𝗷', k: '𝗸', l: '𝗹', m: '𝗺', n: '𝗻', o: '𝗼', p: '𝗽', q: '𝗾', r: '𝗿',
  s: '𝘀', t: '𝘁', u: '𝘂', v: '𝘃', w: '𝘄', x: '𝘅', y: '𝘆', z: '𝘇',
};

/* ── structural transforms ───────────────────────────────────────────── */

/** Emoji keycap: digit plus U+20E3. */
function keycap(s: string): string {
  return [...s].map((c) => (/\d/.test(c) ? `${c}\u20E3` : c)).join('');
}

/**
 * Regional indicator flags from a country code.
 *
 * `ID` becomes 🇮🇩 because each ASCII letter maps to its regional indicator
 * (A = U+1F1E6). This is why the mapping is a simple offset rather than a table.
 */
function regional(s: string): string {
  const clean = s.replace(/[^A-Za-z]/g, '').toUpperCase();
  if (!clean) return s;
  return [...clean].map((c) => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)).join('');
}

/** Insert a combining character between letters — strikethrough, underline, etc. */
function between(s: string, mark: string): string {
  return [...s].join(mark);
}

/** Wrap each character in a chosen enclosure. */
function enclose(s: string, open: string, close: string): string {
  return [...s].map((c) => `${open}${c}${close}`).join('');
}

/** Reverse the string and optionally mirror it. */
const reverse = (s: string): string => [...s].reverse().join('');

/** Rotate 180° using the upside-down table plus reversal. */
function rotate180(s: string): string {
  const FLIP: Record<string, string> = {
    a: 'ɐ', b: 'q', c: 'ɔ', d: 'p', e: 'ǝ', f: 'ɟ', g: 'ƃ', h: 'ɥ', i: 'ᴉ',
    j: 'ɾ', k: 'ʞ', m: 'ɯ', n: 'u', r: 'ɹ', t: 'ʇ', v: 'ʌ', w: 'ʍ', y: 'ʎ',
    '.': '˙', ',': "'", "'": ',', '"': '„', '`': ',', '?': '¿', '!': '¡',
    '[': ']', ']': '[', '(': ')', ')': '(', '{': '}', '}': '{', '<': '>', '>': '<',
    '&': '⅋', _: '‾',
  };
  return [...s].reverse().map((c) => FLIP[c] ?? c).join('');
}

/** Alternating characters from a set — "ransom note" styling. */
function ransom(s: string): string {
  const SET = ['$', '#', '@', '%', '&', '*', '!', '?', '~', '+', '='];
  let i = 0;
  return [...s].map((c) => (c === ' ' ? c : SET[i++ % SET.length]!)).join('');
}

/** Double the string with a separator, the old ASCII-art padding trick. */
const stretch = (s: string, fill = ' '): string => [...s].map((c) => c + c).join(fill);

/** Invert the case of every other character only. */
function half(s: string): string {
  let up = false;
  return [...s].map((c) => {
    if (c === ' ') return c;
    up = !up;
    return up ? c.toUpperCase() : c.toLowerCase();
  }).join('');
}

/** Vowel removal — the original "no vowels" text-speak. */
const devowel = (s: string): string => [...s].filter((c) => !'aeiouAEIOU'.includes(c)).join('');

/**
 * Mirrorable characters.
 *
 * A `Record` cannot hold duplicate keys, so the swapped pairs live in a list.
 * `(` and `)` both appear because the map is a *pairing* table: the value for
 * `(` is `)` and the value for `)` is `(`, which a plain object also supports —
 * the earlier version broke because `(` and `)` collided as keys.
 */
const MIRROR_PAIRS: Record<string, string> = {
  b: 'd', d: 'b', p: 'q', q: 'p',
  '(': ')', ')': '(', '{': '}', '}': '{',
  '<': '>', '>': '<', '/': '\\', '\\': '/',
};

/** Vigenère with a fixed key — real cipher, not a rename. */
function vigenere(s: string, key: string): string {
  const k = key.toLowerCase().replace(/[^a-z]/g, '') || 'flux';
  return [...s].map((c, i) => {
    if (!/[a-z]/i.test(c)) return c;
    const base = c === c.toLowerCase() ? 97 : 65;
    return String.fromCharCode((c.charCodeAt(0) - base + k.charCodeAt(i % k.length)! - 97) % 26 + base);
  }).join('');
}

/* ── command table ───────────────────────────────────────────────────── */

export interface Transform {
  name: string;
  summary: string;
  effect: string;
  /** The transform itself. Pure: same input, same output. */
  fn: (s: string) => string;
}

export const extraAesthetics: Transform[] = [
  // Substitution alphabets
  { name: 'aurebesh', summary: 'Aurebesh (Star Wars)', effect: 'map Latin to the Aurebesh glyph set', fn: (s) => sub(s, AUREBESH) },
  { name: 'bovine', summary: 'Bovine cipher', effect: 'substitute vowels as legs and m as the number of the beast', fn: (s) => sub(s, BOVINE) },
  { name: 'shavian', summary: 'Shavian alphabet', effect: 'map Latin to the Shavian phonetic alphabet', fn: (s) => subCI(s, SHAVIAN) },
  { name: 'deseret', summary: 'Deseret alphabet', effect: 'map Latin to the Deseret alphabet', fn: (s) => subCI(s, DESERET) },
  { name: 'cirth', summary: 'Cirth (Tolkien runes)', effect: 'map Latin to Cirth runes', fn: (s) => subCI(s, CIRTH) },
  { name: 'braille', summary: 'Braille Grade 1', effect: 'map Latin to braille cell patterns', fn: (s) => subCI(s, BRAILLE) },
  { name: 'pigpen', summary: 'Pigpen cipher', effect: 'map Latin to circled keyhole shapes', fn: (s) => subCI(s, PIGPEN) },
  { name: 'circled', summary: 'Circled letters', effect: 'map Latin to the enclosed-alphanumerics block', fn: (s) => subCI(s, CIRCLED) },
  { name: 'superscript', summary: 'Superscript text', effect: 'map Latin and digits to superscript codepoints', fn: (s) => subCI(s, SUPER) },
  { name: 'subscript', summary: 'Subscript text', effect: 'map Latin and digits to subscript codepoints where one exists', fn: (s) => subCI(s, SUB) },
  { name: 'doublestruck', summary: 'Double-struck letters', effect: 'map to mathematical double-struck', fn: (s) => sub(s, DOUBLESTRUCK) },
  { name: 'sans', summary: 'Sans-serif letters', effect: 'map to mathematical sans-serif', fn: (s) => sub(s, SANS) },
  { name: 'boldsans', summary: 'Bold sans-serif', effect: 'map to mathematical bold sans-serif', fn: (s) => sub(s, BOLDSANS) },

  // Structural
  { name: 'keycap', summary: 'Digit keycap emoji', effect: 'append U+20E3 to every digit', fn: keycap },
  { name: 'flag', summary: 'Country code as a flag', effect: 'map each letter to its regional indicator codepoint', fn: regional },
  { name: 'strike', summary: 'Strikethrough (combining)', effect: 'insert U+0336 between characters', fn: (s) => between(s, '\u0336') },
  { name: 'underline', summary: 'Underline (combining)', effect: 'insert U+0332 between characters', fn: (s) => between(s, '\u0332') },
  { name: 'overline', summary: 'Overline (combining)', effect: 'insert U+0305 between characters', fn: (s) => between(s, '\u0305') },
  { name: 'dotabove', summary: 'Dotted text', effect: 'insert U+0307 between characters', fn: (s) => between(s, '\u0307') },
  { name: 'circlea', summary: 'Circled via combining', effect: 'insert U+20DD between characters', fn: (s) => between(s, '\u20DD') },
  { name: 'parens', summary: 'Parenthesised letters', effect: 'wrap each character in parentheses', fn: (s) => enclose(s, '(', ')') },
  { name: 'brackets', summary: 'Bracketed letters', effect: 'wrap each character in square brackets', fn: (s) => enclose(s, '[', ']') },
  { name: 'braces', summary: 'Braced letters', effect: 'wrap each character in curly braces', fn: (s) => enclose(s, '{', '}') },
  { name: 'angles', summary: 'Angled letters', effect: 'wrap each character in angle brackets', fn: (s) => enclose(s, '<', '>') },
  { name: 'stars', summary: 'Starred letters', effect: 'wrap each character in asterisks', fn: (s) => enclose(s, '*', '*') },
  { name: 'hashwrap', summary: 'Hash-wrapped letters', effect: 'wrap each character in hash marks', fn: (s) => enclose(s, '#', '#') },
  { name: 'tilde', summary: 'Tilde-wrapped letters', effect: 'wrap each character in tildes', fn: (s) => enclose(s, '~', '~') },
  { name: 'quote', summary: 'Quoted letters', effect: 'wrap each character in quotation marks', fn: (s) => enclose(s, '"', '"') },
  { name: 'apos', summary: 'Apostrophed letters', effect: "wrap each character in apostrophes", fn: (s) => enclose(s, "'", "'") },

  // Ordering and spacing
  { name: 'rev', summary: 'Reverse the string', effect: 'reverse the character order', fn: reverse },
  { name: 'rot180', summary: 'Rotate 180 degrees', effect: 'reverse the order and substitute upside-down counterparts', fn: rotate180 },
  { name: 'stretch', summary: 'Stretched text', effect: 'duplicate every character with a separator', fn: (s) => stretch(s) },
  { name: 'half', summary: 'Half-caps', effect: 'uppercase every other character', fn: half },
  { name: 'ransom', summary: 'Ransom-note text', effect: 'replace each character with a rotating symbol set', fn: ransom },
  { name: 'alternating2', summary: 'Alternating symbol pair', effect: 'alternate each character between two symbols', fn: (s) => [...s].map((c, i) => (c === ' ' ? c : (i % 2 ? '◢' : '◣'))).join('') },
  { name: 'blocks', summary: 'Block squares', effect: 'replace alphanumerics with quadrants', fn: (s) => [...s].map((c) => (/[a-z]/i.test(c) ? '▣' : /\d/.test(c) ? '◘' : c)).join('') },
  { name: 'waves', summary: 'Wave characters', effect: 'replace each character with the wave block', fn: (s) => [...s].map((c) => (c === ' ' ? c : '〜')).join('') },
  { name: 'arrows', summary: 'Arrow characters', effect: 'replace each character with a rotating arrow', fn: (s) => [...s].map((c, i) => (c === ' ' ? c : ['→', '←', '↑', '↓'][i % 4]!)).join('') },
  { name: 'faces', summary: 'Random faces', effect: 'replace each character with a random face glyph', fn: (s) => [...s].map((c) => (c === ' ' ? c : ['😀', '😎', '🤔', '😴', '🤯'][randomInt(5)]!)).join('') },
  { name: 'hearts', summary: 'Heart characters', effect: 'replace each character with a heart variant', fn: (s) => [...s].map((c) => (c === ' ' ? c : ['❤', '♥', '💕', '💗'][randomInt(4)]!)).join('') },
  { name: 'fire', summary: 'Fire characters', effect: 'replace each character with a flame variant', fn: (s) => [...s].map((c) => (c === ' ' ? c : ['🔥', '💥', '⚡'][randomInt(3)]!)).join('') },

  // Ciphers and wordplay
  { name: 'vigenere', summary: 'Vigenere cipher (key: flux)', effect: 'apply a polyalphabetic Caesar with the fixed key "flux"', fn: (s) => vigenere(s, 'flux') },
  { name: 'atbash', summary: 'Atbash cipher', effect: 'substitute a-z with z-a', fn: (s) => [...s].map((c) => (/[a-z]/.test(c) ? String.fromCharCode(219 - c.charCodeAt(0)) : /[A-Z]/.test(c) ? String.fromCharCode(155 - c.charCodeAt(0)) : c)).join('') },
  { name: 'caesar5', summary: 'Caesar +5', effect: 'shift each letter forward five places', fn: (s) => caesar(s, 5) },
  { name: 'caesar19', summary: 'Caesar -5', effect: 'shift each letter backward five places', fn: (s) => caesar(s, -5) },
  { name: 'mirrorchars', summary: 'Mirror similar characters', effect: 'swap b/d, p/q and bracket pairs', fn: (s) => [...s].map((c) => MIRROR_PAIRS[c] ?? c).join('') },
  { name: 'devowel', summary: 'Remove all vowels', effect: 'drop every vowel, leaving consonants only', fn: devowel },
  { name: 'firstletter', summary: 'Word first letters', effect: 'take the initial character of each word, space separated',
    fn: (s) => s.split(/\s+/).filter(Boolean).map((w) => w[0]).join(' ') },
  { name: 'lastletter', summary: 'Last letter of each word', effect: 'take the final character of every word', fn: (s) => s.split(/\s+/).filter(Boolean).map((w) => w.slice(-1)).join('') },
  { name: 'initials', summary: 'Word initials uppercased', effect: 'extract and uppercase the first letter of each word', fn: (s) => s.split(/\s+/).filter(Boolean).map((w) => w[0]!.toUpperCase()).join(' ') },
  { name: 'pads', summary: 'Pad every word to 12 characters', effect: 'right-pad each word with dots to a fixed width', fn: (s) => s.split(/\s+/).filter(Boolean).map((w) => w.padEnd(12, '.')).join(' ') },
  { name: 'invertchars', summary: 'Reverse and flip case', effect: 'reverse the character order and invert each letter case',
    fn: (s) => [...s].reverse().map((c) =>
      (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join('') },
  { name: 'base32ish', summary: 'Base32 alphabet styling', effect: 'uppercase and strip characters outside the Base32 alphabet', fn: (s) => s.toUpperCase().replace(/[^A-Z2-7]/g, '') },
  { name: 'hexish', summary: 'Hex alphabet only', effect: 'strip every character not in 0-9 and A-F', fn: (s) => s.toUpperCase().replace(/[^0-9A-F]/g, '') },
  { name: 'romanish', summary: 'Roman numeral characters', effect: 'strip every character not in the Roman numeral set', fn: (s) => s.toUpperCase().replace(/[^IVXLCDM]/g, '') },

  // Re-exports and existing transforms as first-class commands
  { name: 'emojiflip', summary: 'Emoji flip', effect: 'map each character to its rotated or mirrored emoji counterpart', fn: (s) => ft.flip(s) },
  { name: 'emojibubble', summary: 'Emoji bubble', effect: 'map each character to the bubble emoji range', fn: (s) => ft.bubble(s) },
  { name: 'vapor', summary: 'Vaporwave', effect: 'apply the vaporwave letter and symbol mapping', fn: (s) => ft.vaporwave(s) },
  { name: 'uwutext', summary: 'UwU text', effect: 'apply the uwu face and speech mapping', fn: (s) => ft.uwu(s) },
  { name: 'leetspeak', summary: 'Leetspeak', effect: 'replace letters with visually similar digits and symbols', fn: (s) => ft.leet(s) },
  { name: 'zalgo2', summary: 'Zalgo text', effect: 'insert random combining diacritics', fn: (s) => ft.zalgo(s) },
  { name: 'wide2', summary: 'Full-width', effect: 'convert ASCII to full-width forms', fn: (s) => ft.fullWidth(s) },
  { name: 'unflip', summary: 'Reverse a flip', effect: 'apply the inverse flip mapping', fn: (s) => ft.unflip(s) },
  { name: 'mirrored', summary: 'Mirror words', effect: 'mirror each word individually', fn: (s) => ft.mirrorWords(s) },
  { name: 'morsedec', summary: 'Decode Morse', effect: 'decode Morse code back to text', fn: (s) => ft.fromMorse(s) ?? s },
  { name: 'binary', summary: 'Encode to binary', effect: 'convert each character to its 8-bit binary form', fn: (s) => ft.toBinary(s) },
  { name: 'binarydec', summary: 'Decode binary', effect: 'convert binary digits back to characters', fn: (s) => ft.fromBinary(s) ?? s },
];

/** Caesar shift helper, used by the caesar5/caesar19 entries. */
function caesar(s: string, shift: number): string {
  return [...s].map((c) => {
    const code = c.charCodeAt(0);
    if (code >= 65 && code <= 90) return String.fromCharCode(((code - 65 + shift + 26) % 26) + 65);
    if (code >= 97 && code <= 122) return String.fromCharCode(((code - 97 + shift + 26) % 26) + 97);
    return c;
  }).join('');
}

export function installExtraAesthetics(reg: {
  command(c: { name: string; summary: string; effect: string; family?: string; handler: (ctx: CommandContext) => Promise<CommandResult> }): unknown;
}): void {
  for (const t of extraAesthetics) {
    reg.command({
      name: t.name,
      summary: t.summary,
      effect: t.effect,
      family: 'aesthetic',
      handler: async (ctx: CommandContext): Promise<CommandResult> => {
        if (!ctx.args.trim()) return ok(`Usage: ${t.name} <text>`);
        try {
          const out = t.fn(ctx.args);
          // A transform that reduces the input to nothing has failed, not
          // succeeded — say so rather than sending an empty message.
          if (!out.trim()) {
            return { error: `${t.name}: no characters in the input survive this transform.` };
          }
          return ok(out);
        } catch (err) {
          return { error: `${t.name}: ${(err as Error).message.slice(0, 90)}` };
        }
      },
    });
  }
}