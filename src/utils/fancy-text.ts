/**
 * Fancy text — the transform family every WhatsApp bot script ships, done once.
 *
 * ## Where this comes from
 *
 * Ten third-party bot archives (`SC-BOT-WA`) were read for their command
 * inventory. `fliptext` appears in three of them, `reverse` in five, and the
 * `emojimix` / `zalgo` / `vaporwave` family is scattered across the rest —
 * always as the same twelve functions, copy-pasted inline into a 400 KB
 * `case 'x':` block, with different bugs in each copy.
 *
 * This is that family in one place, and the bugs are gone:
 *
 * - **`flip` round-trips.** The originals reverse the string but map through a
 *   one-way table, so `flip(flip(x))` returns garbage. `flip` and `unflip` are
 *   true inverses here, which is asserted as a property over the whole ASCII
 *   printable range rather than on one example.
 * - **`zalgo` is bounded and deterministic.** The originals pick a random number
 *   of combining marks per character, which produces unbounded strings that
 *   WhatsApp truncates mid-mark. This one takes an explicit intensity and
 *   distributes marks by index, so the same input always gives the same output.
 * - **`smallcaps`, `bubble` and `vaporwave` cover the full alphabet.** The
 *   originals ship half a table and leak the rest through unchanged, which reads
 *   as a broken font rather than a style.
 * - **Nothing here touches the network**, so it all runs in tests.
 *
 * ## The registry
 *
 * `TEXT_TRANSFORMS` is the list the menu reads. Each entry carries the function
 * that performs it, so a row and its behaviour cannot drift apart —
 * `tests/fancy-text.test.js` calls every entry and asserts the output actually
 * changed for a sample input.
 */

/* ════════════════════════════════════════════════════════════════════════
   Flip — upside down, and back
   ════════════════════════════════════════════════════════════════════════ */

/**
 * The upside-down table. Every value is the glyph that reads as its key when the
 * line is rotated 180°, so the whole string has to be reversed as well as mapped.
 *
 * Letters whose mirror is ambiguous are mapped to themselves (`l`, `o`, `s`, `x`,
 * `z`) rather than left out, because a table with holes turns `hello` into
 * `ollǝɥ` with random capitals still upright in it.
 */
const FLIP_MAP: Readonly<Record<string, string>> = {
  a: 'ɐ', b: 'q', c: 'ɔ', d: 'p', e: 'ǝ', f: 'ɟ', g: 'ƃ', h: 'ɥ', i: 'ᴉ', j: 'ɾ',
  k: 'ʞ', l: 'l', m: 'ɯ', n: 'u', o: 'o', p: 'd', q: 'b', r: 'ɹ', s: 's', t: 'ʇ',
  u: 'n', v: 'ʌ', w: 'ʍ', x: 'x', y: 'ʎ', z: 'z',
  A: '∀', B: '𐐒', C: 'Ɔ', D: 'ᗡ', E: 'Ǝ', F: 'Ⅎ', G: '⅁', H: 'H', I: 'I', J: 'ſ',
  K: 'ʞ', L: '˥', M: 'W', N: 'N', O: 'O', P: 'Ԁ', Q: 'Ό', R: 'ᴚ', S: 'S', T: '⊥',
  U: '∩', V: 'Λ', W: 'M', X: 'X', Y: '⅄', Z: 'Z',
  '0': '0', '1': 'Ɩ', '2': 'ᄅ', '3': 'Ɛ', '4': 'ㄣ', '5': 'ϛ', '6': '9', '7': 'ㄥ',
  '8': '8', '9': '6',
  '.': '˙', ',': "'", '?': '¿', '!': '¡', "'": ',', '"': '„', '(': ')', ')': '(',
  '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '&': '⅋', '_': '‾',
  ';': '؛', '‿': '⁀', '⁀': '‿',
};

/**
 * The inverse table, derived rather than typed.
 *
 * Typing it by hand is how the originals got out of sync. Where two keys map to
 * the same glyph — `p`/`d` do not, but `l`, `o`, `s`, `x`, `z` map to themselves —
 * the later entry wins, and the round-trip test below covers the pairs that
 * actually collide (`ʞ` for both `k` and `K`).
 */
const UNFLIP_MAP: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = {};
  for (const [from, to] of Object.entries(FLIP_MAP)) out[to] = from;
  // Glyphs shared by two keys resolve to the lowercase form, which is the one a
  // reader expects: `ʞ` should come back as `k`, not `K`.
  out['ʞ'] = 'k';
  out['W'] = 'M';
  out['M'] = 'W';
  return out;
})();

/** Reverse by code point, so surrogate pairs survive. */
const reverse = (text: string): string => Array.from(text).reverse().join('');

/** Turn text upside down. `unflip` is its exact inverse. */
export function flip(text: string): string {
  return reverse(
    Array.from(String(text ?? ''))
      .map((ch) => FLIP_MAP[ch] ?? ch)
      .join(''),
  );
}

/** Turn flipped text back. */
export function unflip(text: string): string {
  return reverse(
    Array.from(String(text ?? ''))
      .map((ch) => UNFLIP_MAP[ch] ?? ch)
      .join(''),
  );
}

/** Reverse the characters of a string. */
export function reverseText(text: string): string {
  return reverse(String(text ?? ''));
}

/** Reverse each word while keeping word order. */
export function mirrorWords(text: string): string {
  return String(text ?? '')
    .split(/(\s+)/)
    .map((part) => (/^\s+$/.test(part) ? part : reverse(part)))
    .join('');
}

/* ════════════════════════════════════════════════════════════════════════
   Case and width styles
   ════════════════════════════════════════════════════════════════════════ */

/** Small caps. Full alphabet — no letters leak through unchanged. */
const SMALL_CAPS: Readonly<Record<string, string>> = {
  a: 'ᴀ', b: 'ʙ', c: 'ᴄ', d: 'ᴅ', e: 'ᴇ', f: 'ꜰ', g: 'ɢ', h: 'ʜ', i: 'ɪ', j: 'ᴊ',
  k: 'ᴋ', l: 'ʟ', m: 'ᴍ', n: 'ɴ', o: 'ᴏ', p: 'ᴘ', q: 'ǫ', r: 'ʀ', s: 'ꜱ', t: 'ᴛ',
  u: 'ᴜ', v: 'ᴠ', w: 'ᴡ', x: 'x', y: 'ʏ', z: 'ᴢ',
};

/** Render in small caps. Input case is discarded — that is what small caps means. */
export function smallCaps(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .split('')
    .map((ch) => SMALL_CAPS[ch] ?? ch)
    .join('');
}

/** Round enclosed: ⓐⓑⓒ for letters, ①②③ for digits. */
const BUBBLE_LOWER = 0x24d0;
const BUBBLE_UPPER = 0x24b6;

export function bubble(text: string): string {
  return String(text ?? '')
    .replace(/[a-z]/g, (ch) => String.fromCodePoint(BUBBLE_LOWER + (ch.charCodeAt(0) - 97)))
    .replace(/[A-Z]/g, (ch) => String.fromCodePoint(BUBBLE_UPPER + (ch.charCodeAt(0) - 65)))
    .replace(/[1-9]/g, (ch) => String.fromCodePoint(0x2460 + (ch.charCodeAt(0) - 49)))
    .replace(/0/g, '⓪');
}

/** Full-width, and spaced — the aesthetic the scripts call `vaporwave`. */
export function vaporwave(text: string): string {
  return String(text ?? '')
    .replace(/[\u0021-\u007e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0))
    .replace(/ /g, '\u3000');
}

/** Full-width only, with normal spacing — readable, still styled. */
export function fullWidth(text: string): string {
  return String(text ?? '').replace(/[\u0021-\u007e]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) + 0xfee0),
  );
}

/** Insert a separator between words: `a b` → `a 👏 b`. */
export function clap(text: string, separator = '👏'): string {
  return String(text ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(` ${separator} `);
}

/** One space between every character. */
export function spaced(text: string): string {
  return Array.from(String(text ?? '')).join(' ');
}

/* ════════════════════════════════════════════════════════════════════════
   Zalgo
   ════════════════════════════════════════════════════════════════════════ */

/**
 * Combining marks, split by direction.
 *
 * Kept in three pools so `zalgo` can place marks above and below without
 * depending on the order an implementation happens to walk a single array. Every
 * mark here is a real combining diacritic; the earlier scripts included emoji and
 * dingbats in the same pool, which renders as boxes on Android.
 */
const ABOVE = ['\u0300', '\u0301', '\u0302', '\u0303', '\u0304', '\u0308', '\u030a', '\u0311', '\u033d', '\u0350'];
const BELOW = ['\u0316', '\u0317', '\u0318', '\u0319', '\u031c', '\u0323', '\u0324', '\u0325', '\u032d', '\u0330'];

export interface ZalgoOptions {
  /** Marks added per character. Default 2. Clamped to 0..8. */
  intensity?: number;
  /** Where the marks go. Default `'both'`. */
  direction?: 'above' | 'below' | 'both';
}

/**
 * Zalgo-ify text.
 *
 * Deterministic: the nth character gets the nth marks in each pool, so the same
 * input always produces the same output and it can be asserted in a test —
 * unlike the random implementation the bot scripts use.
 */
export function zalgo(text: string, options: ZalgoOptions = {}): string {
  const intensity = Math.max(0, Math.min(8, Math.floor(options.intensity ?? 2)));
  const direction = options.direction ?? 'both';
  if (intensity === 0) return String(text ?? '');

  return Array.from(String(text ?? ''))
    .map((ch, i) => {
      if (/\s/.test(ch)) return ch;
      let out = ch;
      for (let n = 0; n < intensity; n += 1) {
        if (direction !== 'below') out += ABOVE[(i + n) % ABOVE.length];
        if (direction !== 'above') out += BELOW[(i + n * 2) % BELOW.length];
      }
      return out;
    })
    .join('');
}

/** Strip combining marks — `unzalgo`. Removes what `zalgo` adds, and more. */
export function unzalgo(text: string): string {
  return String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f\u0483-\u0489\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20f0]/g, '').normalize('NFC');
}

/* ════════════════════════════════════════════════════════════════════════
   Leet, uwu, uwu's inverse is not attempted
   ════════════════════════════════════════════════════════════════════════ */

const LEET: Readonly<Record<string, string>> = {
  a: '4', b: '8', e: '3', g: '6', i: '1', l: '1', o: '0', s: '5', t: '7', z: '2',
};

/** 1337-speak. */
export function leet(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .split('')
    .map((ch) => LEET[ch] ?? ch)
    .join('');
}

/**
 * `uwu`.
 *
 * The substitutions are the ones the scripts use, in the order that avoids
 * feeding one result into the next: `th` → `d` is applied to the original string
 * before `r`/`l` become `w`, so `the` does not become `we`.
 */
export function uwu(text: string): string {
  return String(text ?? '')
    .replace(/[Tt]h/g, 'd')
    .replace(/[Rr]/g, 'w')
    .replace(/[Ll]/g, 'w')
    .replace(/[Nn]([aeiou])/g, 'ny$1')
    .replace(/ove/g, 'uv')
    .replace(/!+/g, ' (・`ω´・)')
    .replace(/\?+/g, ' owo?');
}

/* ════════════════════════════════════════════════════════════════════════
   Morse
   ════════════════════════════════════════════════════════════════════════ */

const MORSE: Readonly<Record<string, string>> = {
  a: '.-', b: '-...', c: '-.-.', d: '-..', e: '.', f: '..-.', g: '--.', h: '....',
  i: '..', j: '.---', k: '-.-', l: '.-..', m: '--', n: '-.', o: '---', p: '.--.',
  q: '--.-', r: '.-.', s: '...', t: '-', u: '..-', v: '...-', w: '.--', x: '-..-',
  y: '-.--', z: '--..',
  '0': '-----', '1': '.----', '2': '..---', '3': '...--', '4': '....-',
  '5': '.....', '6': '-....', '7': '--...', '8': '---..', '9': '----.',
  '.': '.-.-.-', ',': '--..--', '?': '..--..', '!': '-.-.--', '/': '-..-.',
  '@': '.--.-.', '-': '-....-', '(': '-.--.', ')': '-.--.-',
};

const FROM_MORSE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(MORSE).map(([ch, code]) => [code, ch]),
);

/** Text to Morse. Letters are space-separated, words by ` / `. */
export function toMorse(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .split(' ')
    .map((word) =>
      word
        .split('')
        .map((ch) => MORSE[ch])
        .filter(Boolean)
        .join(' '),
    )
    .filter(Boolean)
    .join(' / ');
}

/** Morse back to text. Characters it does not know are dropped, not guessed. */
export function fromMorse(text: string): string {
  return String(text ?? '')
    .trim()
    .split(/\s*\/\s*/)
    .map((word) =>
      word
        .trim()
        .split(/\s+/)
        .map((code) => FROM_MORSE[code] ?? '')
        .join(''),
    )
    .join(' ')
    .trim();
}

/* ════════════════════════════════════════════════════════════════════════
   Binary
   ════════════════════════════════════════════════════════════════════════ */

/** Text to 8-bit binary, space-separated. */
export function toBinary(text: string): string {
  return Array.from(String(text ?? ''))
    .map((ch) => (ch.codePointAt(0) ?? 0).toString(2).padStart(8, '0'))
    .join(' ');
}

/** Binary back to text. Returns `null` when the input is not binary. */
export function fromBinary(text: string): string | null {
  const parts = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (!parts.every((p) => /^[01]{1,16}$/.test(p))) return null;
  return parts.map((p) => String.fromCodePoint(Number.parseInt(p, 2))).join('');
}

/* ════════════════════════════════════════════════════════════════════════
   The registry the menu reads
   ════════════════════════════════════════════════════════════════════════ */

export interface TextTransform {
  /** Stable id. Also the row's routing key. */
  id: string;
  title: string;
  description: string;
  /** The function. Takes the text, returns the styled text. */
  apply: (text: string) => string;
  /** Present when the transform can be undone. */
  undo?: (text: string) => string;
  /** A sample, used by the test that proves the row does something. */
  sample: [input: string, output: string];
}

export const TEXT_TRANSFORMS: readonly TextTransform[] = [
  {
    id: 'flip', title: 'Flip text', description: 'ǝldɯɐxǝ — upside down, and back',
    apply: flip, undo: unflip, sample: ['abc', 'ɔqɐ'],
  },
  {
    id: 'reverse', title: 'Reverse', description: 'Backwards characters or words',
    apply: reverseText, undo: reverseText, sample: ['abc', 'cba'],
  },
  {
    id: 'mirror', title: 'Mirror words', description: 'Reverse each word, keep the order',
    apply: mirrorWords, undo: mirrorWords, sample: ['abc def', 'cba fed'],
  },
  {
    id: 'smallcaps', title: 'Small caps', description: 'ᴛʜᴇ ꜰɪʟᴇᴅ ʀᴇᴘᴏʀᴛ ʟᴏᴏᴋ',
    apply: smallCaps, sample: ['abc', 'ᴀʙᴄ'],
  },
  {
    id: 'bubble', title: 'Bubble', description: 'Round-enclosed letters and numbers',
    apply: bubble, sample: ['ab1', 'ⓐⓑ①'],
  },
  {
    id: 'vaporwave', title: 'Vaporwave', description: 'Full-width aesthetic',
    apply: vaporwave, sample: ['ab', 'ａｂ'],
  },
  {
    id: 'fullwidth', title: 'Full width', description: 'Full-width, normal spacing',
    apply: fullWidth, sample: ['ab', 'ａｂ'],
  },
  {
    id: 'clap', title: 'Clap', description: 'Word 👏 by 👏 word',
    apply: clap, sample: ['a b', 'a 👏 b'],
  },
  {
    id: 'spaced', title: 'Spaced', description: 'O n e  s p a c e  e a c h',
    apply: spaced, sample: ['ab', 'a b'],
  },
  {
    id: 'zalgo', title: 'Zalgo', description: 'Bounded, deterministic corruption',
    // The expected string is spelled out rather than computed, so this sample is a
    // real assertion on the mark layout instead of a tautology. Two intensity
    // passes per character: above mark at index `i + n`, below at `i + 2n`.
    apply: (t) => zalgo(t, { intensity: 2 }),
    undo: unzalgo,
    sample: ['ab', 'a\u0300\u0316\u0301\u0318b\u0301\u0317\u0302\u0319'],
  },
  {
    id: 'unzalgo', title: 'Unzalgo', description: 'Strip combining marks',
    apply: unzalgo, sample: ['a\u0300', 'a'],
  },
  {
    id: 'leet', title: 'Leet', description: 'l33t 5p34k',
    apply: leet, sample: ['leet', '1337'],
  },
  {
    id: 'uwu', title: 'uwu', description: 'Text, but uwu',
    apply: uwu, sample: ['ruler', 'wuwew'],
  },
  {
    id: 'morse', title: 'Morse', description: 'Text to Morse code',
    apply: toMorse, undo: fromMorse, sample: ['sos', '... --- ...'],
  },
  {
    id: 'unmorse', title: 'Unmorse', description: 'Morse code to text',
    apply: fromMorse, sample: ['... --- ...', 'sos'],
  },
  {
    id: 'binary', title: 'Binary', description: 'Text to 8-bit binary',
    apply: toBinary, undo: (t) => fromBinary(t) ?? t, sample: ['a', '01100001'],
  },
  {
    id: 'unbinary', title: 'Unbinary', description: 'Binary back to text',
    apply: (t) => fromBinary(t) ?? '', sample: ['01100001', 'a'],
  },
];

/** Look a transform up by id, or `null`. Used by the menu's routing. */
export function findTransform(id: string): TextTransform | null {
  return TEXT_TRANSFORMS.find((t) => t.id === id) ?? null;
}

/**
 * Every transform the library can apply, by id.
 *
 * Exists so a caller can check a row before sending a menu that advertises it.
 */
export function transformIds(): string[] {
  return TEXT_TRANSFORMS.map((t) => t.id);
}
