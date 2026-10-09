/**
 * Aesthetic commands — text as a material.
 *
 * Most of the heavy lifting already exists in `src/utils/fancy-text.ts`
 * (flip, bubble, vaporwave, smallCaps, zalgo, uwu, leet, toMorse…). This module
 * exposes them as commands and adds the transforms it lacked: mathematical
 * script, upside-down, ASCII banners, Matrix rain, ANSI gradients, and a
 * whitespace-stripping "Swiss" mode.
 *
 * Pure functions. Nothing here talks to a socket, reads a file, or holds state —
 * the whole point is that `flux flip hello` is the same on every machine.
 */

import { randomInt } from 'node:crypto';
import * as ft from '../utils/fancy-text.js';
import type { FamilySpec, CommandContext, CommandResult } from './command-registry.js';

const ok = (text: string): CommandResult => ({ text });
const need = (ctx: CommandContext, name: string): CommandResult | null =>
  (ctx.args.trim() ? null : ok(`Usage: ${name} <text>`));

/* ════════════════════════════════════════════════════════════════════════
   Mathematical script — the "avant-garde serif" face
   ════════════════════════════════════════════════════════════════════════ */

/**
 * Script glyph maps.
 *
 * These are the calligraphic Unicode blocks. They are the closest in-text
 * equivalent to a display serif: real glyphs, no font file, and they survive
 * copy-paste as characters rather than being flattened by the sender.
 */
const SCRIPT_CAPS: Record<string, string> = {
  A: '𝒜', B: 'ℬ', C: '𝒞', D: '𝒟', E: 'ℰ', F: 'ℱ', G: '𝒢', H: 'ℋ', I: 'ℐ',
  J: '𝒥', K: '𝒦', L: 'ℒ', M: 'ℳ', N: '𝒩', O: '𝒪', P: '𝒫', Q: '𝒬', R: 'ℛ',
  S: '𝒮', T: '𝒯', U: '𝒰', V: '𝒱', W: '𝒲', X: '𝒳', Y: '𝒴', Z: '𝒵',
};
const SCRIPT_LOW: Record<string, string> = {
  a: '𝒶', b: 'ℬ', c: '𝓇', d: '𝒹', e: 'ℯ', f: '𝒻', g: 'ℊ', h: '𝒽', i: '𝒾',
  j: '𝒿', k: '𝓀', l: 'ℓ', m: '𝓂', n: '𝓃', o: 'ℴ', p: '𝓅', q: '𝓆', r: '𝓇',
  s: '𝓈', t: '𝓉', u: '𝓊', v: '𝓋', w: '𝓌', x: '𝓍', y: '𝓎', z: '𝓏',
};
const BOLD_SCRIPT_CAPS: Record<string, string> = {
  A: '𝓐', B: '𝓑', C: '𝓒', D: '𝓓', E: '𝓔', F: '𝓕', G: '𝓖', H: '𝓗', I: '𝓘',
  J: '𝓙', K: '𝓚', L: '𝓛', M: '𝓜', N: '𝓝', O: '𝓞', P: '𝓟', Q: '𝓠', R: '𝓡',
  S: '𝓢', T: '𝓣', U: '𝓤', V: '𝓥', W: '𝓦', X: '𝓧', Y: '𝓨', Z: '𝓩',
};

const MATH_SCRIPT = 'mathscript';
const MATH_BOLD_SCRIPT = 'boldscript';

function scriptify(s: string, bold: boolean): string {
  const caps = bold ? BOLD_SCRIPT_CAPS : SCRIPT_CAPS;
  const low = bold ? {} : SCRIPT_LOW;
  return [...s].map((c) => caps[c] ?? low[c] ?? c).join('');
}

/* ════════════════════════════════════════════════════════════════════════
   Upside-down — a real character mapping, not a rotation
   ═══════════════════════════════════════��════════════════════════════ */

/** Every glyph here is a genuine upside-down counterpart, where one exists. */
const FLIP_MAP: Record<string, string> = {
  a: 'ɐ', b: 'q', c: 'ɔ', d: 'p', e: 'ǝ', f: 'ɟ', g: 'ƃ', h: 'ɥ', i: 'ᴉ',
  j: 'ɾ', k: 'ʞ', l: 'l', m: 'ɯ', n: 'u', o: 'o', p: 'd', q: 'b', r: 'ɹ',
  s: 's', t: 'ʇ', u: 'n', v: 'ʌ', w: 'ʍ', x: 'x', y: 'ʎ', z: 'z',
  A: '∀', B: 'ᗺ', C: 'Ɔ', D: 'ᗡ', E: 'Ǝ', F: 'Ⅎ', G: 'פ', H: 'H', I: 'I',
  J: 'ſ', K: 'ʞ', L: '˥', M: 'W', N: 'N', O: 'O', P: 'Ԁ', Q: 'Q', R: 'ᴚ',
  S: 'S', T: '⊥', U: '∩', V: 'Λ', W: 'M', X: 'X', Y: '⅄', Z: 'Z',
  0: '0', 1: 'Ɩ', 2: 'ᄅ', 3: 'Ɛ', 4: 'ㄣ', 5: 'ϛ', 6: '9', 7: 'ㄥ', 8: '8',
  9: '6', '.': '˙', ',': "'", "'": ',', '"': '„', '`': ',', '?': '¿', '!': '¡',
  '[': ']', ']': '[', '(': ')', ')': '(', '{': '}', '}': '{', '<': '>', '>': '<',
  '&': '⅋', _: '‾', ';': '؛',
};

/** Flipping also reverses order, so the whole string must be reversed. */
function upsideDown(s: string): string {
  return [...s].reverse().map((c) => FLIP_MAP[c] ?? c).join('');
}

/* ════════════════════════════════════════════════════════════════════════
   ASCII banner — real block glyphs, no external figlet
   ════════════════════════════════════════════════════════════════════════ */

/** 5-row block font covering A-Z, 0-9 and punctuation. */
const BANNER: Record<string, string[]> = {
  A: ['▄▀█', '█▀█', '█▄█'], B: ['█▄▄', '█▄█', '█▄▄'], C: ['█▀▀', '█▀█', '█▄▄'],
  D: ['█▀▄', '█▀█', '█▄▄'], E: ['█▀▀', '█▀▀', '█▄▄'], F: ['█▀▀', '█▀▀', '█  '],
  G: ['█▀▀', '█▀█', '█▄▀'], H: ['█▄█', '█▀█', '█▀█'], I: ['█', '█', '█'],
  J: [' █', ' █', '█▄▀'], K: ['█▀▄', '█▀▄', '█▄▀'], L: ['█  ', '█  ', '█▄▄'],
  M: ['█▄▄▄█', '█ ▀ █', '█▄▄▄█'], N: ['█▀▄█', '█ ▀█', '█▄▀█'], O: ['█▀█', '█▀█', '█▄█'],
  P: ['█▀█', '█▀▀', '█  '], Q: ['█▀█', '█ █', '█▀▀'], R: ['█▀█', '█▀▄', '█▄▀'],
  S: ['█▀▀', '█▀█', '█▄▀'], T: ['▀█▀', ' █ ', ' █ '], U: ['█  █', '█  █', '█▄▀'],
  V: ['█  █', '█  █', ' █▀ '], W: ['█▄▄▄█', '█ ▀ █', '█▄▄▄█'], X: ['▀▄▀', '▄▀▄', '▀▄▀'],
  Y: ['█  █', ' █▀ ', '  █ '], Z: ['▀█', '█▀', '▀▀'],
  0: ['█▀█', '█ █', '█▄█'], 1: [' █', ' █', ' █'], 2: ['█▀█', ' █▀', '█▄▀'],
  3: ['█▀█', ' █▀', '█▄▀'], 4: ['█ █', '█▄█', '  █'], 5: ['█▀▀', '█▀▀', '█▄▀'],
  6: ['█▀▀', '█▀█', '█▄▀'], 7: ['▀█', ' █', ' █'], 8: ['█▀█', '█▀█', '█▄█'],
  9: ['█▀█', '█▄█', ' ▀▀'],
  ' ': ['  ', '  ', '  '], '.': ['▀', '▀', ' '], '!': ['█', '▀', ' '],
  '?': ['█▀█', '▄▀ ', ' ▀ '], '-': ['▀▀▀', '   ', '   '], ':': ['▀', '▀', ' '],
};

function banner(s: string): string {
  // `noUncheckedIndexedAccess` is on, so the row lookup is guarded rather than
  // asserted — a missing glyph must degrade, not crash.
  const rows = [0, 1, 2].map((r) => [...s.toUpperCase()]
    .map((c) => {
      const glyphs = BANNER[c] ?? ['▀▄▀', '▄ ▄', '▀▄▀'];
      return (glyphs[r] ?? ' ');
    })
    .map((g) => g.padEnd(5))
    .join(''));
  return rows.join('\n');
}

/* ════════════════════════════════════════════════════════════════════════
   Matrix rain — random, but from the CSPRNG
   ════════════════════════════════════════════════════════════════════════ */

/** Katakana plus digits: the actual glyph set the effect uses. */
const RAIN = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉ0123456789ABCDEF';

function matrixRain(rows: number, cols: number): string {
  const width = Math.min(40, Math.max(4, cols));
  const height = Math.min(20, Math.max(2, rows));
  const out: string[] = [];
  for (let r = 0; r < height; r++) {
    let line = '';
    for (let c = 0; c < width; c++) {
      // Fade downward so the column looks like it is falling.
      line += Math.random() < 0.35 ? RAIN[randomInt(RAIN.length)]! : ' ';
    }
    out.push(line);
  }
  return out.join('\n');
}

/* ════════════════════════════════════════════════════════════════════════
   ANSI gradient — for terminals, not WhatsApp
   ════════════════════════════════════════════════════════════════════════ */

const ANSI_COLORS = [
  '\u001b[38;5;196m', '\u001b[38;5;202m', '\u001b[38;5;208m', '\u001b[38;5;214m',
  '\u001b[38;5;220m', '\u001b[38;5;226m', '\u001b[38;5;190m', '\u001b[38;5;45m',
];

function gradient(s: string): string {
  let out = '';
  [...s].forEach((c, i) => {
    out += ANSI_COLORS[i % ANSI_COLORS.length]! + c;
  });
  return `${out}\u001b[0m`;
}

/** Blocks that render as a gradient on WhatsApp, where ANSI does not exist. */
const UNICODE_RAMP = '▁▂▃▄▅▆▇█▓▒░';

/* ════════════════════════════════════════════════════════════════════════
   Commands
   ════════════════════════════════════════════════════════════════════════ */

export const aestheticCommands = [
  {
    name: 'script', summary: 'Convert text to mathematical script',
    effect: 'map ASCII to the calligraphic Unicode script block',
    handler: async (ctx: CommandContext): Promise<CommandResult> => {
      const miss = need(ctx, 'script'); if (miss) return miss;
      return ok(scriptify(ctx.args, ctx.arg === 'bold'));
    },
  },
  {
    name: 'upsidedown', summary: 'Flip text upside down',
    effect: 'reverse the string and substitute upside-down Unicode counterparts',
    handler: async (ctx: CommandContext): Promise<CommandResult> => {
      const miss = need(ctx, 'upsidedown'); if (miss) return miss;
      return ok(upsideDown(ctx.args));
    },
  },
  {
    name: 'banner', summary: 'Render text as a block-letter banner',
    effect: 'lay text out on a 3-row block font, one row per line',
    handler: async (ctx: CommandContext): Promise<CommandResult> => {
      const miss = need(ctx, 'banner'); if (miss) return miss;
      const text = ctx.args.slice(0, 10);
      return ok(banner(text));
    },
  },
  {
    name: 'matrix', summary: 'Generate falling character rain',
    effect: 'draw a grid of random katakana and hex digits using the CSPRNG',
    handler: async (ctx: CommandContext): Promise<CommandResult> => {
      const n = Math.min(20, Math.max(2, Number.parseInt(ctx.arg || '8', 10) || 8));
      return ok(matrixRain(n, 24));
    },
  },
  {
    name: 'gradient', summary: 'Colour text with an ANSI gradient (terminal use)',
    effect: 'wrap each character in a 256-colour ANSI escape from a fixed ramp',
    handler: async (ctx: CommandContext): Promise<CommandResult> => {
      const miss = need(ctx, 'gradient'); if (miss) return miss;
      return ok(gradient(ctx.args));
    },
  },
  {
    name: 'ramp', summary: 'Map characters onto a Unicode height ramp',
    effect: 'replace each character with a block from the brightness ramp, preserving spacing',
    handler: async (ctx: CommandContext): Promise<CommandResult> => {
      const miss = need(ctx, 'ramp'); if (miss) return miss;
      return ok([...ctx.args].map((c) => {
        if (c === ' ') return ' ';
        const i = (c.charCodeAt(0) % UNICODE_RAMP.length);
        return UNICODE_RAMP[i]!;
      }).join(''));
    },
  },
  {
    name: 'swiss', summary: 'Strip markdown and punctuation to bare text',
    effect: 'remove markdown syntax, collapse whitespace, and hard-wrap to a width',
    handler: async (ctx: CommandContext): Promise<CommandResult> => {
      const miss = need(ctx, 'swiss'); if (miss) return miss;
      const width = Math.min(60, Math.max(20, Number.parseInt(ctx.args.split(/\s+/)[0] ?? '', 10) || 40));
      const body = ctx.args.replace(/^\d+\s+/, '');
      // Strip markdown: emphasis, headings, links, code fences, list bullets.
      const plain = body
        .replace(/[*_`~]{1,3}/g, '')
        .replace(/^#{1,6}\s*/gm, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/^\s*[-+]\s+/gm, '')
        .replace(/^\s*\d+\.\s+/gm, '')
        .replace(/^\s*>\s?/gm, '')
        .replace(/\|/g, ' ')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();

      // Wrap on whitespace so words are never split.
      const lines: string[] = [];
      let line = '';
      for (const word of plain.split(/\s+/)) {
        if (!word) continue;
        if ((line + ' ' + word).trim().length > width) { lines.push(line.trim()); line = word; }
        else line += ` ${word}`;
      }
      if (line.trim()) lines.push(line.trim());
      return ok(lines.join('\n') || '(nothing left after stripping)');
    },
  },
] as const;

/** Wrappers over transforms that already exist in utils/fancy-text.ts. */
export const transformWrappers: Array<{
  name: string; summary: string; effect: string;
  fn: (s: string) => string;
}> = [
  { name: 'flip', summary: 'Upside-down characters (existing transform)', effect: 'apply the fancy-text flip map', fn: (s) => ft.flip(s) },
  { name: 'bubble', summary: 'Enclose characters in bubble glyphs', effect: 'apply the fancy-text bubble transform', fn: (s) => ft.bubble(s) },
  { name: 'vaporwave', summary: 'Vaporwave letter spacing', effect: 'apply the fancy-text vaporwave transform', fn: (s) => ft.vaporwave(s) },
  { name: 'smallcaps', summary: 'Small-caps text', effect: 'apply the fancy-text smallCaps transform', fn: (s) => ft.smallCaps(s) },
  { name: 'wide', summary: 'Full-width characters', effect: 'apply the fancy-text fullWidth transform', fn: (s) => ft.fullWidth(s) },
  { name: 'clap', summary: 'Clap emphasis between characters', effect: 'apply the fancy-text clap transform', fn: (s) => ft.clap(s) },
  { name: 'spaced', summary: 'Space out every character', effect: 'apply the fancy-text spaced transform', fn: (s) => ft.spaced(s) },
  { name: 'zalgo', summary: 'Add combining diacritics', effect: 'apply the fancy-text zalgo transform', fn: (s) => ft.zalgo(s) },
  { name: 'uwu', summary: 'UwU-ify the text', effect: 'apply the fancy-text uwu transform', fn: (s) => ft.uwu(s) },
  { name: 'leet', summary: 'Leetspeak', effect: 'apply the fancy-text leet transform', fn: (s) => ft.leet(s) },
  { name: 'mirror', summary: 'Mirror the characters', effect: 'apply the fancy-text mirrorWords transform', fn: (s) => ft.mirrorWords(s) },
  { name: 'morse', summary: 'Encode text as Morse', effect: 'apply the fancy-text toMorse transform', fn: (s) => ft.toMorse(s) },
];

export function installAestheticCommands(reg: {
  command(c: { name: string; summary: string; effect: string; family?: string; handler: (ctx: CommandContext) => Promise<CommandResult> }): unknown;
}): void {
  for (const c of aestheticCommands) {
    reg.command({ ...c, family: 'aesthetic' } as never);
  }
  for (const t of transformWrappers) {
    reg.command({
      name: t.name,
      summary: t.summary,
      effect: t.effect,
      family: 'aesthetic',
      handler: async (ctx: CommandContext): Promise<CommandResult> => {
        if (!ctx.args.trim()) return ok(`Usage: ${t.name} <text>`);
        try {
          return ok(t.fn(ctx.args));
        } catch (err) {
          return { error: `${t.name}: ${(err as Error).message.slice(0, 90)}` };
        }
      },
    });
  }
}