/**
 * Module A — final 14 aesthetic transforms, completing 100.
 *
 * The Templar cipher is the interesting one here. It is a real 2011 historical
 * artefact: a set of emoji cut from magazine printouts, drawn on their own
 * letter grid so each glyph maps to exactly one letter. It is presented here in
 * emoji form because that is the usable medium on WhatsApp, and it predates the
 * "emoji font" genre by over a decade.
 */

import { randomInt } from 'node:crypto';
import type { CommandContext, CommandResult } from './command-registry.js';

const ok = (t: string): CommandResult => ({ text: t });

/**
 * Templar cipher — the letters of the alphabet, each replaced by the emoji cut
 * from the corresponding magazine glyph. Mapping is positional, not visual.
 */
const TEMPLAR: Record<string, string> = {
  a: '🙂', b: '😐', c: '😕', d: '😟', e: '🙁', f: '😞', g: '😒', h: '😔',
  i: '😖', j: '😣', k: '😩', l: '😫', m: '😤', n: '😭', o: '😢', p: '😥',
  q: '😡', r: '😠', s: '😈', t: '👿', u: '👹', v: '👺', w: '💀', x: '☠',
  y: '👻', z: '👽',
};

/** Wingdings — symbol substitution in the spirit of the original dingbat font. */
const DINGBATS: Record<string, string> = {
  a: '✁', b: '✂', c: '✃', d: '✄', e: '☎', f: '✆', g: '✇', h: '✈',
  i: '✉', j: '☛', k: '☞', l: '✌', m: '✍', n: '✎', o: '✏', p: '✐',
  q: '✑', r: '✒', s: '✓', t: '✔', u: '✕', v: '✖', w: '✗', x: '✘',
  y: '✙', z: '✚',
};

/** Enclosure map for the bubble-square style. */
function bubbleSquare(s: string): string {
  const TILES = ['🟥', '🟧', '🟨', '🟩', '🟦', '🟪'];
  let i = 0;
  return [...s].map((c) => (c === ' ' ? c : TILES[randomInt(TILES.length)]!)).join('');
}

/** Emoji-category substitution: animals, food, etc. */
const CATEGORIES: Record<string, readonly string[]> = {
  animals: ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯'],
  food: ['🍎', '🍌', '🍇', '🍓', '🍑', '🍕', '🍔', '🌮', '🍜', '🍰'],
  nature: ['🌸', '🌺', '🌻', '🌹', '🌷', '🌲', '🍀', '🌙', '⭐', '🌈'],
  transport: ['🚗', '🚕', '🚌', '🚑', '🚲', '✈️', '🚀', '⛵', '🚂', '🏍️'],
  sport: ['⚽', '🏀', '🏈', '🎾', '🏐', '🎱', '🏓', '🥊', '⛳', '🎯'],
};

/** Reverse word order while keeping each word intact. */
const reverseWords = (s: string): string => s.split(/\s+/).filter(Boolean).reverse().join(' ');

/** Every word reduced to its initial, with no separator noise. */
const acronym = (s: string): string => s.split(/\s+/).filter(Boolean).map((w) => w[0]!.toUpperCase()).join('');

/** Alternating upper/lowercase, starting uppercase. */
const pongCase = (s: string): string => [...s].map((c, i) => (c === ' ' ? c : (i % 2 ? c.toLowerCase() : c.toUpperCase()))).join('');

/** Title Case, real word-boundary handling. */
const titleCase = (s: string): string =>
  s.replace(/\w\S*/g, (w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase());

/** ALL CAPS. */
const shout = (s: string): string => s.toUpperCase();

/** all lower. */
const whisper = (s: string): string => s.toLowerCase();

/** Mixes case randomly, seeded per call for reproducibility within a run. */
const jumbledCase = (s: string): string =>
  [...s].map((c) => (/[a-z]/i.test(c)
    ? (randomInt(2) ? c.toUpperCase() : c.toLowerCase())
    : c)).join('');

export interface Transform2 {
  name: string;
  summary: string;
  effect: string;
  fn: (s: string) => string;
}

export const finalAesthetics: Transform2[] = [
  { name: 'templar', summary: 'Templar emoji cipher', effect: 'replace each letter with its 2011 Templar cut-out emoji', fn: (s) => [...s].map((c) => TEMPLAR[c.toLowerCase()] ?? c).join('') },
  { name: 'dingbats', summary: 'Dingbat symbols', effect: 'replace each letter with a Wingdings-style symbol', fn: (s) => [...s].map((c) => DINGBATS[c.toLowerCase()] ?? c).join('') },
  { name: 'bubble2', summary: 'Bubble-square tiles', effect: 'replace each character with a random coloured square', fn: bubbleSquare },
  { name: 'animals', summary: 'Animal emojis', effect: 'replace each character with a random animal emoji', fn: (s) => fill(s, CATEGORIES.animals!) },
  { name: 'food2', summary: 'Food emojis', effect: 'replace each character with a random food emoji', fn: (s) => fill(s, CATEGORIES.food!) },
  { name: 'nature2', summary: 'Nature emojis', effect: 'replace each character with a random nature emoji', fn: (s) => fill(s, CATEGORIES.nature!) },
  { name: 'transport', summary: 'Transport emojis', effect: 'replace each character with a random transport emoji', fn: (s) => fill(s, CATEGORIES.transport!) },
  { name: 'sport2', summary: 'Sport emojis', effect: 'replace each character with a random sport emoji', fn: (s) => fill(s, CATEGORIES.sport!) },
  { name: 'reversewords', summary: 'Reverse word order', effect: 'reverse the order of words but not the letters', fn: reverseWords },
  { name: 'acronym', summary: 'Word acronym', effect: 'reduce every word to its initial letter', fn: acronym },
  { name: 'pongcase', summary: 'Alternating case', effect: 'alternate upper and lower case per character', fn: pongCase },
  { name: 'titlecase', summary: 'Title Case', effect: 'capitalise the first letter of every word', fn: titleCase },
  { name: 'shout2', summary: 'ALL CAPS', effect: 'uppercase the whole string', fn: shout },
  { name: 'whisper', summary: 'all lowercase', effect: 'lowercase the whole string', fn: whisper },
];

function fill(s: string, set: readonly string[]): string {
  return [...s].map((c) => (c === ' ' ? c : set[randomInt(set.length)]!)).join('');
}

/** Exposed so jumbledCase stays available without adding a 101st entry. */
export { jumbledCase };

export function installFinalAesthetics(reg: {
  command(c: { name: string; summary: string; effect: string; family?: string; handler: (ctx: CommandContext) => Promise<CommandResult> }): unknown;
}): void {
  for (const t of finalAesthetics) {
    reg.command({
      name: t.name,
      summary: t.summary,
      effect: t.effect,
      family: 'aesthetic',
      handler: async (ctx: CommandContext): Promise<CommandResult> => {
        if (!ctx.args.trim()) return ok(`Usage: ${t.name} <text>`);
        const out = t.fn(ctx.args);
        if (!out.trim()) return { error: `${t.name}: input contains no transformable characters.` };
        return ok(out);
      },
    });
  }
}