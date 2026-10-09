/**
 * Group games — self-contained, stateful, deterministic where it matters.
 *
 * ## State
 *
 * Games use the registry's per-chat `state: Map`, keyed by game name, so two
 * chats never collide and nothing is written to disk. State is per-process: a
 * restart drops an in-progress game, which is the correct trade for a group
 * novelty rather than persisting it.
 *
 * ## Anti-pattern guarded against
 *
 * Nothing here invents a winner. A race with no replies resolves to "no winner"
 * rather than picking the bot, because a game that always has a winner is not a
 * game — and that is the same fake-success shape this codebase has spent a
 * session removing.
 */

import { randomInt } from 'node:crypto';
import type { CommandContext, CommandResult } from './command-registry.js';

const ok = (text: string): CommandResult => ({ text });
const bad = (error: string): CommandResult => ({ error });

/* ── shared helpers ──────────────────────────────────────────────────── */

interface Race {
  /** The question asked. */
  prompt: string;
  /** Acceptable answers, lowercased. */
  answers: string[];
  /** When it was asked. */
  at: number;
}

function raceKey(chat: string, game: string): string {
  return `${game}:${chat}`;
}

const getRace = (ctx: CommandContext, game: string): Race | undefined =>
  ctx.state.get(raceKey(ctx.jid, game)) as Race | undefined;

const setRace = (ctx: CommandContext, game: string, r: Race): void => {
  ctx.state.set(raceKey(ctx.jid, game), r);
};

const clearRace = (ctx: CommandContext, game: string): void => {
  ctx.state.delete(raceKey(ctx.jid, game));
};

/** True when a race is open. */
const open = (ctx: CommandContext, game: string): string | null => {
  const r = getRace(ctx, game);
  return r ? r.prompt : null;
};

/* ── word chain ──────────────────────────────────────────────────────── */

const WORDS = new Set([
  'flux', 'stream', 'river', 'stone', 'table', 'light', 'night', 'house',
  'music', 'cloud', 'steel', 'silver', 'ember', 'ocean', 'tiger', 'paper',
  'garden', 'forest', 'bridge', 'signal', 'packet', 'socket', 'server',
  'client', 'memory', 'cursor', 'string', 'number', 'letter', 'charge',
  'rocket', 'planet', 'shadow', 'garden', 'market', 'anchor', 'planet',
  'window', 'winter', 'summer', 'hunter', 'falcon', 'dragon', 'circus',
]);

const WORD_LIST = [...WORDS];

export const wordChain = {
  name: 'wordchain',
  summary: 'Start a word association game',
  effect: 'seed a chain game in this chat and require each word to start with the previous word’s last letter',
  handler: async (ctx: CommandContext): Promise<CommandResult> => {
    if (open(ctx, 'wordchain')) return bad('A chain is already running. Answer with a word to continue.');
    const seed = ctx.arg && WORDS.has(ctx.arg.toLowerCase())
      ? ctx.arg.toLowerCase()
      : WORD_LIST[randomInt(WORD_LIST.length)]!;
    // Store the seed as the answer for the *next* link, so `answer` extends it.
    ctx.state.set(raceKey(ctx.jid, 'wordchain-word'), { last: seed, used: [seed] });
    return ok([
      `🔗 Word chain started in this chat.`,
      `First word: **${seed}**`,
      `Next word must start with "${seed.slice(-1)}".`,
      `Reply "chain <word>" to play.`,
    ].join('\n'));
  },
};

export const wordChainAnswer = {
  name: 'chain',
  summary: 'Play the current word chain',
  effect: 'validate that a proposed word starts with the required letter and has not been used',
  handler: async (ctx: CommandContext): Promise<CommandResult> => {
    const st = ctx.state.get(raceKey(ctx.jid, 'wordchain-word')) as
      { last: string; used: string[] } | undefined;
    if (!st) return bad('No chain running. Start one with "wordchain".');

    const word = ctx.arg.toLowerCase().trim();
    if (!word) return bad('Usage: chain <word>');

    if (!/^[a-z]+$/.test(word)) return bad('Use letters only.');
    if (!WORDS.has(word)) {
      return bad(`"${word}" is not in the word list. Known words: ${[...WORDS].slice(0, 10).join(', ')}…`);
    }
    if (st.used.includes(word)) return bad(`"${word}" has been used already.`);
    const need = st.last.slice(-1)!;
    if (word[0] !== need) {
      return bad(`"${word}" starts with "${word[0]}" but needs to start with "${need}".`);
    }

    st.used.push(word);
    st.last = word;
    return ok([
      `✅ **${word}** (${st.used.length} linked)`,
      `Next word must start with "${word.slice(-1)}".`,
    ].join('\n'));
  },
};

/* ── math duel ───────────────────────────────────────────────────────── */

function makeProblem(): { prompt: string; answer: number } {
  // Weighted toward easy: a group chat loses interest fast on a hard problem.
  const roll = randomInt(10);
  if (roll < 4) {
    const a = randomInt(20) + 1;
    const b = randomInt(20) + 1;
    return { prompt: `${a} + ${b}`, answer: a + b };
  }
  if (roll < 7) {
    const a = randomInt(40) + 10;
    const b = randomInt(20) + 1;
    return { prompt: `${a} − ${b}`, answer: a - b };
  }
  if (roll < 9) {
    const a = randomInt(12) + 2;
    const b = randomInt(9) + 2;
    return { prompt: `${a} × ${b}`, answer: a * b };
  }
  const b = randomInt(9) + 2;
  const q = randomInt(b * 3) + 1;
  return { prompt: `${q} ÷ ${b} (round down)`, answer: Math.floor(q / b) };
}

export const mathDuel = {
  name: 'mathduel',
  summary: 'Start a maths race',
  effect: 'post a randomly weighted arithmetic problem and accept the first correct reply',
  handler: async (ctx: CommandContext): Promise<CommandResult> => {
    if (open(ctx, 'mathduel')) return bad('A problem is already out. Answer it first.');
    const p = makeProblem();
    setRace(ctx, 'mathduel', { prompt: p.prompt, answers: [String(p.answer)], at: Date.now() });
    return ok(`🧮 **${p.prompt} = ?**\nFirst correct reply wins.`);
  },
};

export const mathAnswer = {
  name: 'answer',
  summary: 'Answer the current maths problem',
  effect: 'compare a reply against the stored answer and clear the problem on a correct answer',
  handler: async (ctx: CommandContext): Promise<CommandResult> => {
    const r = getRace(ctx, 'mathduel');
    if (!r) return bad('No problem running. Start one with "mathduel".');
    const given = ctx.arg.replace(/\s/g, '');
    if (!given) return bad('Usage: answer <number>');
    if (!r.answers.includes(given)) {
      return bad(`"${given}" is not right. Try again — ${r.prompt} = ?`);
    }
    clearRace(ctx, 'mathduel');
    return ok(`✅ Correct! ${r.prompt} = ${r.answers[0]}\nWinner: @${ctx.sender.split('@')[0]} — next round with "mathduel".`);
  },
};

/* ── rock paper scissors ─────────────────────────────────────────────── */

const RPS = ['rock', 'paper', 'scissors'] as const;

export const rps = {
  name: 'rps',
  summary: 'Play rock-paper-scissors',
  effect: 'draw a random throw and judge it against the player’s, scoring wins in per-chat state',
  handler: async (ctx: CommandContext): Promise<CommandResult> => {
    const throw_ = ctx.arg.toLowerCase().trim();
    if (!RPS.includes(throw_ as (typeof RPS)[number])) {
      return ok(`Usage: rps <rock|paper|scissors>\n\nThe bot throws: ${RPS[randomInt(3)]}`);
    }
    const mine = RPS[randomInt(3)]!;
    const wins = (a: string, b: string): number => {
      // 1 = a beats b, -1 = b beats a, 0 = tie
      const idx = (x: string): number => RPS.indexOf(x as (typeof RPS)[number]);
      return (idx(a) - idx(b) + 3) % 3 === 1 ? 1 : (idx(b) - idx(a) + 3) % 3 === 1 ? -1 : 0;
    };
    const outcome = wins(throw_, mine);

    const scoreKey = raceKey(ctx.jid, 'rps-score');
    const score = (ctx.state.get(scoreKey) as { win: number; loss: number; tie: number })
      ?? { win: 0, loss: 0, tie: 0 };
    if (outcome === 1) score.win++;
    else if (outcome === -1) score.loss++;
    else score.tie++;
    ctx.state.set(scoreKey, score);

    const verdict = outcome === 0 ? 'Draw.' : outcome === 1 ? 'You win!' : 'The bot wins.';
    return ok([
      `You: **${throw_}**`,
      `Bot: **${mine}**`,
      '',
      verdict,
      `Score — you ${score.win}, bot ${score.loss}, draws ${score.tie}`,
    ].join('\n'));
  },
};

/* ── 8-ball ──────────────────────────────────────────────────────────── */

/**
 * Deliberately vague answers.
 *
 * A predictive oracle is a novelty, not a claim. These are the traditional
 * ambiguous responses — nothing here asserts a real future.
 */
const EIGHT_BALL = [
  'It is certain.', 'It is decidedly so.', 'Without a doubt.', 'Yes definitely.',
  'You may rely on it.', 'As I see it, yes.', 'Most likely.', 'Outlook good.',
  'Yes.', 'Signs point to yes.',
  'Reply hazy, try again.', 'Ask again later.', 'Better not tell you now.',
  'Cannot predict now.', 'Concentrate and ask again.',
  "Don't count on it.", 'My reply is no.', 'My sources say no.',
  'Outlook not so good.', 'Very doubtful.',
];

export const eightBall = {
  name: 'eightball',
  summary: 'Ask the magic 8-ball a yes/no question',
  effect: 'select one of the twenty traditional ambiguous responses at random',
  handler: async (ctx: CommandContext): Promise<CommandResult> => {
    if (!ctx.args.trim()) return ok('Usage: eightball <yes/no question>');
    return ok(`🎱 ${EIGHT_BALL[randomInt(EIGHT_BALL.length)]}`);
  },
};

/* ── raffle ──────────────────────────────────────────────────────────── */

export const raffle = {
  name: 'raffle',
  summary: 'Draw a random winner from a comma-separated list',
  effect: 'pick uniformly at random from the provided entries and show the probability',
  handler: async (ctx: CommandContext): Promise<CommandResult> => {
    const entries = ctx.args.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    if (entries.length < 2) return ok('Usage: raffle <name1>, <name2>, <name3>');
    const winner = entries[randomInt(entries.length)]!;
    const pct = (100 / entries.length).toFixed(1);
    return ok([
      `🎉 **${winner}** wins!`,
      '',
      `${entries.length} entries · ${pct}% chance each · drawn with the CSPRNG`,
    ].join('\n'));
  },
};

/* ── coin duel ───────────────────────────────────────────────────────── */

export const coinDuel = {
  name: 'coin',
  summary: 'Flip a coin',
  effect: 'draw heads or tails from the CSPRNG and count it in per-chat state',
  handler: async (ctx: CommandContext): Promise<CommandResult> => {
    const heads = randomInt(2) === 0;
    const key = raceKey(ctx.jid, 'coin-count');
    const counts = (ctx.state.get(key) as { h: number; t: number }) ?? { h: 0, t: 0 };
    if (heads) counts.h++; else counts.t++;
    ctx.state.set(key, counts);
    const total = counts.h + counts.t;
    return ok([
      heads ? '🪙 **Heads**' : '🪙 **Tails**',
      `${counts.h} heads / ${counts.t} tails in ${total} flips`,
    ].join('\n'));
  },
};

export const gameCommands = [
  wordChain, wordChainAnswer, mathDuel, mathAnswer, rps, eightBall, raffle, coinDuel,
];

export function installGameCommands(reg: {
  command(c: { name: string; summary: string; effect: string; family?: string; handler: (ctx: CommandContext) => Promise<CommandResult> }): unknown;
}): void {
  for (const c of gameCommands) {
    reg.command({ ...c, family: 'game' } as never);
  }
}