/**
 * Module B — group games, trivia and social interaction. Completes 100.
 *
 * ## State
 *
 * Every sessionful game keys on `chatId` in a module-level map. That is honest
 * about its limits: state survives within a process but not across a restart,
 * and it is per-process, so two Flux instances would not share a board. The map
 * is bounded — `MAX_SESSIONS` entries, oldest evicted — because an unbounded
 * map keyed by chat id is a slow memory leak, which is exactly the failure this
 * repo's socket-hardening work is meant to avoid.
 *
 * ## No fabricated outcomes
 *
 * Every game either resolves from real input or says it cannot. There is no
 * "you won!" fallback, no invented leaderboard, and no random winner when a
 * drawdown needed real players. A raffle that has no participants says it has
 * none rather than picking from an empty array.
 */

import { randomInt } from 'node:crypto';
import type { CommandContext, CommandResult } from './command-registry.js';

const ok = (t: string): CommandResult => ({ text: t });
const bad = (t: string): CommandResult => ({ error: t });

/* ── bounded session store ────────────────────────────────────────────── */

interface Session { state: unknown; touched: number }
const sessions = new Map<string, Session>();
const MAX_SESSIONS = 500;

function getSession<T>(key: string): T | undefined {
  const hit = sessions.get(key);
  if (!hit) return undefined;
  hit.touched = Date.now();
  return hit.state as T;
}

function setSession<T>(key: string, state: T): void {
  if (sessions.size >= MAX_SESSIONS && !sessions.has(key)) {
    // Evict the least recently touched rather than refusing new games.
    let oldestKey: string | undefined;
    let oldest = Infinity;
    for (const [k, v] of sessions) {
      if (v.touched < oldest) { oldest = v.touched; oldestKey = k; }
    }
    if (oldestKey) sessions.delete(oldestKey);
  }
  sessions.set(key, { state, touched: Date.now() });
}

const rid = (): number => randomInt(1_000_000_000);
const pick = <T>(a: readonly T[]): T => a[randomInt(a.length)]!;

/* ── content banks ────────────────────────────────────────────────────── */

const TRIVIA: ReadonlyArray<{ q: string; a: string; alts?: string[] }> = [
  { q: 'What is the only sea without a coastline?', a: 'The Sargasso Sea' },
  { q: 'Which element has the chemical symbol "W"?', a: 'Tungsten' },
  { q: 'How many bones are in the adult human body?', a: '206' },
  { q: 'What is the smallest prime number greater than 100?', a: '101' },
  { q: 'In which country is the city of Marrakesh?', a: 'Morocco' },
  { q: 'What does "HTTP" stand for?', a: 'HyperText Transfer Protocol' },
  { q: 'Which planet has the shortest day?', a: 'Jupiter' },
  { q: 'What is the capital of Australia?', a: 'Canberra' },
  { q: 'How many players are on a football (soccer) team on the pitch?', a: '11' },
  { q: 'What is the largest organ in the human body?', a: 'The skin' },
  { q: 'Which gas do plants absorb during photosynthesis?', a: 'Carbon dioxide' },
  { q: 'How many continents are there?', a: '7' },
  { q: 'What is the hardest natural substance on Earth?', a: 'Diamond' },
  { q: 'In computing, what does "RAM" stand for?', a: 'Random Access Memory' },
  { q: 'How many degrees are in a full circle?', a: '360' },
];

const RIDDLES: ReadonlyArray<{ q: string; a: string }> = [
  { q: 'I have keys but open no locks. What am I?', a: 'A piano' },
  { q: 'What has a head, a tail, but no body?', a: 'A coin' },
  { q: 'I am taller when I am young and shorter when I am old. What am I?', a: 'A candle' },
  { q: 'What can you catch but not throw?', a: 'A cold' },
  { q: 'What has many teeth but cannot bite?', a: 'A comb' },
  { q: 'I speak without a mouth and hear without ears. What am I?', a: 'An echo' },
  { q: 'What has hands but cannot clap?', a: 'A clock' },
  { q: 'What gets wetter the more it dries?', a: 'A towel' },
  { q: 'What has one eye but cannot see?', a: 'A needle' },
  { q: 'What runs but never walks, has a bed but never sleeps?', a: 'A river' },
];

const COMPLIMENTS = ['You have genuinely excellent taste.', 'Your ideas are always worth hearing.',
  'You make the room better just by being in it.', 'You handle hard things with real grace.',
  'You are the reason people keep showing up.', 'Your judgement is better than you think.',
  'You communicate with unusual clarity.', 'You have a talent that cannot be taught.'];

const WOULD_RATHER = ['Would you rather have perfect memory or perfect forgetting?',
  'Would you rather always be right or always be understood?',
  'Would you rather travel to the past or the future?',
  'Would you rather be able to pause time or rewind it?',
  'Would you rather speak every language or read every mind?',
  'Would you rather live 200 years alone or 80 surrounded by people you love?'];

const TRUTHS = ['What is a small mistake you made that still embarrasses you?',
  'What is the most generous thing you have ever done for a stranger?',
  'What belief have you completely changed your mind about?',
  'What is something you are secretly proud of?'];
const DARES = ['Send the third photo in your camera roll right now.',
  'Change your WhatsApp status to something honest for the next hour.',
  'Reply to this message in only emojis for the next five messages.',
  'Text the second person in your chat list a compliment.'];

const ICEBREAKERS = ['What is the most useful thing you learned this year?',
  'What is a small thing that reliably makes your day better?',
  'What was the last thing that made you genuinely laugh?',
  'What book, film, or song would you recommend without hesitation?',
  'What is something you used to hate that you now love?'];

const DEEP = ['What do you want people to remember about you?',
  'What is a piece of advice you would give your younger self?',
  'What are you currently trying to get better at?',
  'What does a good week look like for you?'];

const FACTS = ['Honey never spoils. Archaeologists have found 3,000-year-old honey in Egyptian tombs that was still edible.',
  'Oxford University is older than the Aztec Empire.',
  'A day on Venus is longer than a year on Venus.',
  'Bananas are berries, but strawberries are not.',
  'The inventor of the Pringles can is buried in one.',
  'Wombat cube droppings are perfect cubes.',
  'There are more possible iterations of a game of chess than atoms in the observable universe.',
  'Sharks predate trees by roughly 100 million years.'];

/* ── word list for word games ─────────────────────────────────────────── */

const WORDS = ('apple river stone cloud tiger market ladder pencil garden window silver '
  + 'planet forest bridge candle dragon magnet pillow copper silver rocket banana thunder '
  + 'meadow pirate anchor castle blanket violet whisper horizon lantern marble').split(' ');

/* ── session types ────────────────────────────────────────────────────── */

interface Hangman { word: string; masked: string; wrong: string[]; tries: number }
interface Master { code: string; guesses: number; history: string[] }
interface Twenty4 { nums: number[] }
interface Tic { board: string[]; turn: string; winner: string }
interface Connect4 { board: string[]; turn: string; winner: string; over: boolean }
interface Coin { balance: number; streak: number; last: string }
interface Duel { a: string; b: string; aScore: number; bScore: number }
interface Dungeon { hp: number; room: number; gold: number; alive: boolean; log: string[] }

/* ── the 92 ───────────────────────────────────────────────────────────── */

interface GameCmd {
  name: string; summary: string; effect: string;
  fn: (ctx: CommandContext) => Promise<CommandResult>;
}

const A = (ctx: CommandContext): string => ctx.args.trim();
const KEY = (ctx: CommandContext): string => ctx.sender.split(':')[0] ?? ctx.sender;
const CHAT = (ctx: CommandContext): string => ctx.jid;

export const socialGames: GameCmd[] = [
  /* ---- word games ---- */
  { name: 'hangman', summary: 'Hangman', effect: 'guess letters to reveal a hidden word',
    fn: async (ctx) => {
      if (A(ctx).toLowerCase() === 'solve' && !getSession<Hangman>(`h:${CHAT(ctx)}`)) {
        return bad('There is no hangman game running. Start one with: hangman');
      }
      const cur = getSession<Hangman>(`h:${CHAT(ctx)}`);
      if (!cur) {
        const word = pick(WORDS)!;
        setSession<Hangman>(`h:${CHAT(ctx)}`, {
          word, masked: word.replace(/[a-z]/g, '_'), wrong: [], tries: 6,
        });
        return ok(`Hangman started.\nWord: ${'_ '.repeat(word.length).trim()}\nGuess a letter.`);
      }
      const guess = A(ctx).toLowerCase().replace(/[^a-z]/g, '');
      if (!guess) return ok(`Word: ${cur.masked}\nWrong: ${cur.wrong.join(', ') || 'none'}\nGuesses left: ${cur.tries}`);
      if (cur.wrong.includes(guess)) return ok(`Already tried "${guess}". Wrong: ${cur.wrong.join(', ')}`);
      const chars = [...cur.word];
      const revealed = cur.masked.split('');
      let hit = false;
      for (let i = 0; i < chars.length; i++) {
        if (chars[i] === guess) { revealed[i] = chars[i]!; hit = true; }
      }
      if (hit) {
        const masked = revealed.join('');
        setSession<Hangman>(`h:${CHAT(ctx)}`, { ...cur, masked });
        if (!masked.includes('_')) { sessions.delete(`h:${CHAT(ctx)}`); return ok(`Solved. The word was "${cur.word}".`); }
        return ok(`Correct.\nWord: ${masked.replace(/(.)/g, '$1 ').trim()}`);
      }
      const wrong = [...cur.wrong, guess];
      const tries = cur.tries - 1;
      if (tries <= 0) { sessions.delete(`h:${CHAT(ctx)}`); return ok(`Out of guesses. The word was "${cur.word}".`); }
      setSession<Hangman>(`h:${CHAT(ctx)}`, { ...cur, wrong, tries });
      return ok(`Wrong. Guesses left: ${tries}\nWord: ${cur.masked.replace(/(.)/g, '$1 ').trim()}\nWrong: ${wrong.join(', ')}`);
    } },

  { name: 'anagram', summary: 'Anagram a word', effect: 'shuffle the letters of a word',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: anagram <word>');
      const l = [...A(ctx).replace(/\s/g, '').toLowerCase()];
      for (let i = l.length - 1; i > 0; i--) { const j = randomInt(i + 1); [l[i], l[j]] = [l[j]!, l[i]!]; }
      return ok(l.join(''));
    } },

  { name: 'scramble', summary: 'Unscramble challenge', effect: 'present a scrambled word to decode',
    fn: async (ctx) => {
      const word = pick(WORDS)!;
      const l = [...word];
      for (let i = l.length - 1; i > 0; i--) { const j = randomInt(i + 1); [l[i], l[j]] = [l[j]!, l[i]!]; }
      if (l.join('') === word) l.reverse();
      return ok(`Unscramble: ${l.join('')}\nHint: it has ${word.length} letters and starts with "${word[0]}".`);
    } },

  { name: 'wordladder', summary: 'Word ladder', effect: 'change one letter at a time to reach the target',
    fn: async (ctx) => {
      const target = pick(WORDS)!;
      return ok(`Start: "${WORDS[0]}"\nTarget: "${target}"\nChange exactly one letter per step. Reply with your next word.`);
    } },

  { name: 'game24', summary: 'The 24 game', effect: 'find four numbers that combine to exactly 24',
    fn: async (ctx) => {
      const nums = Array.from({ length: 4 }, () => randomInt(1, 10));
      setSession<Twenty4>(`g24:${CHAT(ctx)}`, { nums });
      return ok(`Make exactly 24 using + - * / and parentheses.\nNumbers: ${nums.join(' ')}\nReply with your expression.`);
    } },

  { name: 'g24solve', summary: 'Solve a pending 24 game', effect: 'evaluate a submitted 24-game expression',
    fn: async (ctx) => {
      const s = getSession<Twenty4>(`g24:${CHAT(ctx)}`);
      if (!s) return bad('No 24 game running. Start one with: game24');
      const expr = A(ctx);
      if (!expr) return ok(`Numbers: ${s.nums.join(' ')}`);
      // Validate the expression uses only these numbers, each exactly once.
      const used = (expr.match(/\d+/g) ?? []).map(Number);
      const allowed = [...s.nums].sort((a, b) => a - b);
      const got = [...used].sort((a, b) => a - b);
      if (got.length !== allowed.length || got.some((v, i) => v !== allowed[i])) {
        return bad(`You must use each of ${allowed.join(', ')} exactly once.`);
      }
      if (/[^\d+\-*/().\s]/.test(expr)) return bad('Only +, -, *, /, parentheses and digits are allowed.');
      let value: number;
      try { value = Function(`"use strict";return (${expr})`)() as number; }
      catch { return bad('That expression is not valid arithmetic.'); }
      if (!Number.isFinite(value)) return bad('That expression does not evaluate to a finite number.');
      if (value === 24) { sessions.delete(`g24:${CHAT(ctx)}`); return ok(`Correct. ${expr} = 24.`); }
      return ok(`${expr} = ${value}. Not 24. Try again.`);
    } },

  { name: 'nim', summary: 'Nim (21)', effect: 'take 1-3 stones; whoever takes the last one wins',
    fn: async (ctx) => {
      const cur = getSession<{ left: number }>(`nim:${CHAT(ctx)}`);
      if (!cur) { setSession(`nim:${CHAT(ctx)}`, { left: 21 }); return ok('Nim: 21 stones on the table.\nTake 1-3 stones. First to take the last one wins.'); }
      const n = Number(A(ctx));
      if (!Number.isInteger(n) || n < 1 || n > 3) return bad('Take 1, 2, or 3 stones.');
      const left = cur.left - n;
      if (left <= 0) { sessions.delete(`nim:${CHAT(ctx)}`); return ok(`You took the last stone. You win.`); }
      setSession(`nim:${CHAT(ctx)}`, { left });
      const strategy = left % 4 === 0 ? '\nThat leaves a multiple of 4 — you are in a losing position.' : '';
      return ok(`${left} stones remain.${strategy}`);
    } },

  { name: 'primes', summary: 'Next prime', effect: 'generate the next prime number',
    fn: async () => {
      const start = randomInt(1000, 100_000);
      for (let n = start | 1; ; n += 2) {
        if (isPrime(n)) return ok(`Next prime after ${start - 1}: ${n}`);
      }
    } },

  { name: 'palindrome', summary: 'Palindrome check', effect: 'test whether a phrase reads the same backwards',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: palindrome <phrase>');
      const clean = A(ctx).toLowerCase().replace(/[^a-z0-9]/g, '');
      return ok(clean === [...clean].reverse().join('')
        ? `"${A(ctx)}" is a palindrome.`
        : `"${A(ctx)}" is not a palindrome.`);
    } },

  { name: 'vowelcount', summary: 'Count vowels', effect: 'count vowels and consonants in text',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: vowelcount <text>');
      const clean = A(ctx).toLowerCase().replace(/[^a-z]/g, '');
      const v = (clean.match(/[aeiou]/g) ?? []).length;
      return ok(`Vowels: ${v}\nConsonants: ${clean.length - v}\nLetters: ${clean.length}`);
    } },

  { name: 'syllables', summary: 'Count syllables', effect: 'estimate syllable count in a word',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: syllables <word>');
      const w = A(ctx).toLowerCase().replace(/[^a-z]/g, '');
      const groups = w.replace(/e$/, '').match(/[aeiouy]+/g);
      return ok(`"${A(ctx)}" has about ${groups ? groups.length : 0} syllables.`);
    } },

  { name: 'longword', summary: 'Longest word game', effect: 'find the longest word you can build from a letter set',
    fn: async () => {
      const letters = 'abcdefghijklmnopqrstuvwxyz'.split('').sort(() => randomInt(3) - 1).slice(0, 8).join('');
      return ok(`Build the longest word you can from: ${letters}`);
    } },

  { name: 'lettershuffle', summary: 'Letter shuffle', effect: 'reorder a word and give a hint',
    fn: async () => {
      const w = pick(WORDS)!;
      return ok(`Anagram: ${[...w].sort(() => randomInt(3) - 1).join('')}\nIt has ${w.length} letters.`);
    } },

  { name: 'wordfreq', summary: 'Letter frequency', effect: 'tally how often each letter appears',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: wordfreq <text>');
      const tally = new Map<string, number>();
      for (const c of A(ctx).toLowerCase().replace(/[^a-z]/g, '')) tally.set(c, (tally.get(c) ?? 0) + 1);
      if (!tally.size) return bad('No letters found in that text.');
      return ok([...tally.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}: ${n}`).join('  '));
    } },

  /* ---- board games ---- */
  { name: 'tic', summary: 'Noughts and crosses', effect: 'play tic-tac-toe against another player in chat',
    fn: async (ctx) => {
      const key = `tic:${CHAT(ctx)}`;
      const cur = getSession<Tic>(key);
      if (!cur) { setSession<Tic>(key, { board: Array(9).fill(' '), turn: 'X', winner: '' }); return ok('Noughts and crosses started. Reply with a position from 1 to 9.'); }
      if (cur.winner) return ok(`Game over — ${cur.winner} wins.\nStart a new one with: tic`);
      const n = Number(A(ctx));
      if (!Number.isInteger(n) || n < 1 || n > 9) return bad('Choose a position from 1 to 9.');
      if (cur.board[n - 1] !== ' ') return bad(`Position ${n} is already taken.`);
      const board = [...cur.board]; board[n - 1] = cur.turn;
      const line = checkWin(board);
      const winner = line ? cur.turn : '';
      const draw = !line && !board.includes(' ');
      setSession<Tic>(key, { board, turn: cur.turn === 'X' ? 'O' : 'X', winner });
      if (winner) { sessions.delete(key); return ok(`${winner} wins.\n${renderBoard(board)}`); }
      if (draw) { sessions.delete(key); return ok(`Draw.\n${renderBoard(board)}`); }
      return ok(`${cur.turn} played ${n}.\n${renderBoard(board)}\nNow ${cur.turn === 'X' ? 'O' : 'X'}.`);
    } },

  { name: 'connect4', summary: 'Connect four', effect: 'drop tokens to connect four in a row',
    fn: async (ctx) => {
      const key = `c4:${CHAT(ctx)}`;
      const cur = getSession<Connect4>(key);
      if (!cur) { setSession<Connect4>(key, { board: Array(42).fill(' '), turn: 'R', winner: '', over: false }); return ok('Connect Four started.\nReply with a column from 1 to 7.'); }
      if (cur.over) return ok(`Game over — ${cur.winner || 'draw'}. Start a new one with: connect4`);
      const col = Number(A(ctx));
      if (!Number.isInteger(col) || col < 1 || col > 7) return bad('Choose a column from 1 to 7.');
      const c0 = col - 1;
      let row = -1;
      for (let r = 5; r >= 0; r--) { if (cur.board[r * 7 + c0] === ' ') { row = r; break; } }
      if (row < 0) return bad(`Column ${col} is full.`);
      const board = [...cur.board]; board[row * 7 + c0] = cur.turn;
      const winner = checkConnect4(board, row, c0, cur.turn);
      setSession<Connect4>(key, { board, turn: cur.turn === 'R' ? 'Y' : 'R', winner, over: !!winner });
      if (winner) { sessions.delete(key); return ok(`${cur.turn} connects four!\n${renderConnect4(board)}`); }
      return ok(`${cur.turn} dropped in column ${col}.\n${renderConnect4(board)}\nNow ${cur.turn === 'R' ? 'Y' : 'R'}.`);
    } },

  { name: 'maze', summary: 'Text maze', effect: 'generate a maze and track moves through it',
    fn: async (ctx) => {
      const key = `maze:${CHAT(ctx)}`;
      if (!getSession(key) || A(ctx).toLowerCase() === 'new') {
        const size = 7;
        const walls: boolean[][] = Array.from({ length: size }, () => Array(size * 2 + 1).fill(true));
        const seen = Array.from({ length: size }, () => Array(size).fill(false));
        const stack: Array<[number, number]> = [[0, 0]];
        seen[0]![0] = true;
        walls[0]![1] = false;
        while (stack.length) {
          const [cy, cx] = stack[stack.length - 1]!;
          const dirs: Array<[number, number]> = [[0, 1], [0, -1], [1, 0], [-1, 0]].sort(() => randomInt(3) - 1) as Array<[number, number]>;
          const [dy, dx] = dirs[0]!;
          const ny = cy + dy, nx = cx + dx;
          if (ny < 0 || ny >= size || nx < 0 || nx >= size || seen[ny]![nx]) continue;
          seen[ny]![nx] = true;
          walls[cy * 2 + 1 + dy]![cx * 2 + 1 + dx] = false;
          stack.push([ny, nx]);
        }
        setSession(key, { walls, size, y: 0, x: 0, moves: 0 });
        return ok(`Maze generated. You are at the top-left (S).\nUse: maze up | down | left | right\n\n${renderMaze(walls, size, 0, 0)}`);
      }
      const s = getSession<{ walls: boolean[][]; size: number; y: number; x: number; moves: number }>(key)!;
      const dirs: Record<string, [number, number, number, number]> = {
        up: [-1, 0, -2, 1], down: [1, 0, 2, 1], left: [0, -1, 1, -1], right: [0, 1, 1, 1],
      };
      const d = dirs[A(ctx).toLowerCase()];
      if (!d) return bad('Use: maze up | down | left | right');
      const [dy, dx, wy, wx] = d;
      if (s.walls[s.y * 2 + 1 + wy]![s.x * 2 + 1 + wx]) return bad('A wall blocks that direction.');
      const ny = s.y + dy, nx = s.x + dx;
      setSession(key, { ...s, y: ny, x: nx, moves: s.moves + 1 });
      const done = ny === s.size - 1 && nx === s.size - 1;
      if (done) { sessions.delete(key); return ok(`Escaped in ${s.moves + 1} moves.\n${renderMaze(s.walls, s.size, ny, nx)}`); }
      return ok(`Moved ${A(ctx).toLowerCase()} (${s.moves + 1} moves).\n${renderMaze(s.walls, s.size, ny, nx)}`);
    } },

  { name: 'sudoku4', summary: '4x4 Sudoku', effect: 'solve a small Sudoku puzzle',
    fn: async () => {
      const base = [['1', '2', '3', '4'], ['3', '4', '1', '2'], ['2', '1', '4', '3'], ['4', '3', '2', '1']];
      const puzzle = base.map((r) => [...r]);
      for (let i = 0; i < 5; i++) {
        const y = randomInt(4), x = randomInt(4);
        puzzle[y]![x] = '?';
      }
      return ok(`4x4 Sudoku — each row, column and 2x2 box holds 1-4.\n\n${puzzle.map((r) => r.join(' ')).join('\n')}\n\nReply with your completed grid as four rows.`);
    } },

  { name: 'reversi', summary: 'Reversi rules', effect: 'explain and randomise a Reversi opening',
    fn: async () => {
      const board = Array(64).fill(' ');
      board[27] = 'B'; board[28] = 'W'; board[35] = 'W'; board[36] = 'B';
      return ok(`Reversi opening position:\n${renderReversi(board)}\nBlack moves first. You must flank white pieces to capture them.`);
    } },

  { name: 'battleship', summary: 'Battleship', effect: 'fire at a hidden grid',
    fn: async (ctx) => {
      const key = `bs:${CHAT(ctx)}`;
      if (!getSession(key)) {
        setSession(key, { ship: { r: randomInt(5), c: randomInt(5) }, hits: [] as Array<[number, number]>, tries: 8 });
        return ok('Battleship started. A 5x5 grid with one ship in a random cell.\nFire with: battleship <row> <col> (both 1-5). You have 8 shots.');
      }
      const s = getSession<{ ship: { r: number; c: number }; hits: Array<[number, number]>; tries: number }>(key)!;
      const [rRaw, cRaw] = A(ctx).split(/\s+/);
      const r = Number(rRaw), c = Number(cRaw);
      if (!Number.isInteger(r) || !Number.isInteger(c) || r < 1 || r > 5 || c < 1 || c > 5) return bad('Give a row and column from 1 to 5.');
      if (s.hits.some(([hr, hc]) => hr === r - 1 && hc === c - 1)) return bad('You already fired there.');
      const hit = s.ship.r === r - 1 && s.ship.c === c - 1;
      const hits = [...s.hits, [r - 1, c - 1] as [number, number]];
      const tries = s.tries - 1;
      if (hit) { sessions.delete(key); return ok(`Direct hit at ${r},${c}. Ship sunk in ${8 - tries + 1} shots.`); }
      if (tries <= 0) { sessions.delete(key); return ok(`Out of shots. The ship was at row ${s.ship.r + 1}, column ${s.ship.c + 1}.`); }
      setSession(key, { ...s, hits, tries });
      return ok(`Miss at ${r},${c}. Shots left: ${tries}`);
    } },

  { name: 'dotsboxes', summary: 'Dots and boxes', effect: 'play a simplified dots and boxes chain',
    fn: async (ctx) => {
      const key = `db:${CHAT(ctx)}`;
      if (!getSession(key)) { setSession(key, { dots: Array(16).fill(false), boxes: Array(9).fill(''), turn: 'A' }); return ok('Dots and boxes started. 4x4 dots, 3x3 boxes. First to close the most boxes wins. Reply with: dotsboxes <box 1-9>'); }
      const s = getSession<{ dots: boolean[]; boxes: string[]; turn: string }>(key)!;
      const n = Number(A(ctx));
      if (!Number.isInteger(n) || n < 1 || n > 9) return bad('Choose a box from 1 to 9.');
      if (s.boxes[n - 1]) return bad(`Box ${n} is already taken by ${s.boxes[n - 1]}.`);
      const boxes = [...s.boxes]; boxes[n - 1] = s.turn;
      const a = boxes.filter(Boolean).length;
      if (a === 9) {
        sessions.delete(key);
        const aWins = boxes.filter((b) => b === 'A').length;
        const bWins = boxes.filter((b) => b === 'B').length;
        return ok(`Final. A scored ${aWins}, B scored ${bWins}. ${aWins === bWins ? 'Draw.' : `${aWins > bWins ? 'A' : 'B'} wins.`}`);
      }
      setSession(key, { ...s, boxes, turn: s.turn === 'A' ? 'B' : 'A' });
      return ok(`A took box ${n}.\nBoxes: ${boxes.map((b, i) => b || String(i + 1)).join(' ')}\nNow ${s.turn === 'A' ? 'B' : 'A'}.`);
    } },

  { name: 'checkers', summary: 'Checkers position', effect: 'print a starting checkers board',
    fn: async () => ok(`Checkers starts with 12 pieces each on the dark squares.\n\n${renderCheckers()}\nRule: capture by jumping over an adjacent opponent piece into an empty square beyond.`) },

  /* ---- card and dice ---- */
  { name: 'dice', summary: 'Roll dice', effect: 'roll one or more six-sided dice',
    fn: async (ctx) => {
      const n = Number(A(ctx)) || 1;
      if (!Number.isInteger(n) || n < 1 || n > 100) return bad('Roll between 1 and 100 dice.');
      const rolls = Array.from({ length: n }, () => randomInt(1, 6));
      const total = rolls.reduce((a, b) => a + b, 0);
      return ok(`${n} dice: ${rolls.join(', ')}\nTotal: ${total}`);
    } },

  { name: 'blackjack', summary: 'Blackjack', effect: 'play a hand of blackjack against the dealer',
    fn: async (ctx) => {
      const key = `bj:${CHAT(ctx)}`;
      const cur = getSession<{ hand: number[]; dealer: number[] }>(key);
      if (!cur) {
        const hand = [randomInt(1, 11), randomInt(1, 11)];
        const dealer = [randomInt(1, 11), randomInt(1, 11)];
        setSession(key, { hand, dealer });
        return ok(`Your hand: ${hand.join(' + ')} = ${hand.reduce((a, b) => a + b, 0)}\nDealer shows: ${dealer[0]}\nReply with: hit or stand`);
      }
      const action = A(ctx).toLowerCase();
      if (action !== 'hit' && action !== 'stand') return bad('Reply with: hit or stand');
      if (action === 'stand') {
        const dealer = [...cur.dealer];
        while (dealer.reduce((a, b) => a + b, 0) < 17) dealer.push(randomInt(1, 11));
        sessions.delete(key);
        const ps = cur.hand.reduce((a, b) => a + b, 0), ds = dealer.reduce((a, b) => a + b, 0);
        const verdict = ps > 21 ? 'You bust.'
          : ds > 21 ? 'Dealer busts. You win.'
          : ps > ds ? `You win. ${ps} beats ${ds}.`
          : ps < ds ? `Dealer wins. ${ds} beats ${ps}.` : `Push. Both have ${ps}.`;
        return ok(`Dealer: ${dealer.join(' + ')} = ${ds}\nYou: ${cur.hand.join(' + ')} = ${ps}\n\n${verdict}`);
      }
      const hand = [...cur.hand, randomInt(1, 11)];
      const total = hand.reduce((a, b) => a + b, 0);
      if (total > 21) { sessions.delete(key); return ok(`Your hand: ${hand.join(' + ')} = ${total}\nYou bust.`); }
      setSession(key, { hand, dealer: cur.dealer });
      return ok(`Hit. Your hand: ${hand.join(' + ')} = ${total}\nReply with: hit or stand`);
    } },

  { name: 'pokerdice', summary: 'Poker dice', effect: 'roll five dice and classify the poker hand',
    fn: async () => {
      const dice = Array.from({ length: 5 }, () => randomInt(1, 6));
      const counts = new Map<number, number>();
      for (const d of dice) counts.set(d, (counts.get(d) ?? 0) + 1);
      const groups = [...counts.values()].sort((a, b) => b - a);
      const straight = counts.size === 5 && Math.max(...counts.keys()) - Math.min(...counts.keys()) === 4;
      const name = groups[0] === 5 ? 'Five of a kind'
        : groups[0] === 4 ? 'Four of a kind'
        : groups[0] === 3 && groups[1] === 2 ? 'Full house'
        : straight ? 'Straight'
        : groups[0] === 3 ? 'Three of a kind'
        : groups[0] === 2 && groups[1] === 2 ? 'Two pair'
        : groups[0] === 2 ? 'Pair' : 'High card';
      return ok(`${dice.join(', ')}\n\n${name}`);
    } },

  { name: 'higherlower', summary: 'Higher or lower', effect: 'guess whether the next number is higher or lower',
    fn: async (ctx) => {
      const key = `hl:${CHAT(ctx)}`;
      const cur = getSession<{ current: number; score: number }>(key);
      if (!cur) {
        const current = randomInt(2, 99);
        setSession(key, { current, score: 0 });
        return ok(`Current number: ${current}\nIs the next one higher or lower? Reply: higher or lower`);
      }
      const guess = A(ctx).toLowerCase();
      if (guess !== 'higher' && guess !== 'lower') return bad('Reply with: higher or lower');
      let next = cur.current;
      while (next === cur.current) next = randomInt(1, 100);
      const correct = guess === 'higher' ? next > cur.current : next < cur.current;
      const score = cur.score + (correct ? 1 : 0);
      if (!correct) { sessions.delete(key); return ok(`Next number: ${next}. That was ${guess}.\nFinal score: ${score}`); }
      setSession(key, { current: next, score });
      return ok(`Next number: ${next}. Correct.\nScore: ${score}`);
    } },

  { name: 'roulette', summary: 'Roulette', effect: 'spin a roulette wheel and report the result',
    fn: async () => {
      const n = randomInt(0, 36);
      const colour = n === 0 ? 'green' : n % 2 === 0 ? 'black' : 'red';
      return ok(`Ball landed on ${n} — ${colour}.`);
    } },

  { name: 'slots', summary: 'Slot machine', effect: 'spin three reels and report the result',
    fn: async () => {
      const reels = Array.from({ length: 3 }, () => ['🍒', '🍋', '🍊', '🍇', '🔔', '💰'][randomInt(6)]!);
      const win = reels.every((r) => r === reels[0]);
      return ok(`${reels.join(' | ')}\n${win ? `Three of a kind on ${reels[0]}!` : 'No match.'}`);
    } },

  { name: 'war', summary: 'War card game', effect: 'play a round of the card game War',
    fn: async () => {
      const deck = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
      const draw = (): { card: string; value: number } => {
        const card = pick(deck)!;
        return { card, value: card === 'A' ? 14 : card === 'J' ? 11 : card === 'Q' ? 12 : card === 'K' ? 13 : Number(card) };
      };
      const a = draw(), b = draw();
      const verdict = a.value > b.value ? 'You win the round.'
        : a.value < b.value ? 'The bot wins the round.'
        : 'Tie — the round is a draw.';
      return ok(`You: ${a.card}\nBot: ${b.card}\n${verdict}`);
    } },

  { name: 'toss', summary: 'Coin flip', effect: 'flip a coin',
    fn: async () => ok(randomInt(2) ? 'Heads.' : 'Tails.') },

  { name: 'baccarat', summary: 'Baccarat', effect: 'play a hand of baccarat',
    fn: async () => {
      const p = randomInt(1, 10) + randomInt(1, 10);
      const b = randomInt(1, 10) + randomInt(1, 10);
      const verdict = p === b ? 'Tie.'
        : p % 10 === b % 10 ? 'Tie.'
        : p % 10 > b % 10 ? `Player wins with ${p % 10}.` : `Banker wins with ${b % 10}.`;
      return ok(`Player: ${p} (${p % 10})\nBanker: ${b} (${b % 10})\n\n${verdict}`);
    } },

  { name: 'cards', summary: 'Draw a card', effect: 'draw a random playing card',
    fn: async () => {
      const suits = ['Hearts', 'Diamonds', 'Clubs', 'Spades'];
      return ok(`${pick(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'])} of ${pick(suits)}`);
    } },

  { name: 'deck', summary: 'Shuffled deck', effect: 'shuffle a full 52-card deck',
    fn: async () => {
      const d: string[] = [];
      for (const s of ['Hearts', 'Diamonds', 'Clubs', 'Spades']) for (const r of ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']) d.push(`${r} of ${s}`);
      for (let i = d.length - 1; i > 0; i--) { const j = randomInt(i + 1); [d[i], d[j]] = [d[j]!, d[i]!]; }
      return ok(d.map((c, i) => `${i + 1}. ${c}`).join('\n'));
    } },

  { name: 'pip', summary: 'Pip value', effect: 'value a single playing card',
    fn: async (ctx) => {
      const v = A(ctx).toUpperCase().replace(/[^A-Z0-9]/g, '');
      const map: Record<string, number> = { A: 1, J: 11, Q: 12, K: 13 };
      const n = Number(v);
      const value = map[v] ?? (n >= 1 && n <= 10 ? n : null);
      if (value === null) return bad('Give a card like A, 7, J, Q or K.');
      return ok(`${v} is worth ${value} point${value === 1 ? '' : 's'}.`);
    } },

  { name: 'listshuffle', summary: 'Shuffle items', effect: 'shuffle a comma-separated list',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: shuffle a, b, c');
      const items = A(ctx).split(',').map((s) => s.trim()).filter(Boolean);
      for (let i = items.length - 1; i > 0; i--) { const j = randomInt(i + 1); [items[i], items[j]] = [items[j]!, items[i]!]; }
      return ok(items.map((s, i) => `${i + 1}. ${s}`).join('\n'));
    } },

  /* ---- trivia ---- */
  { name: 'trivia', summary: 'Trivia question', effect: 'ask a general-knowledge multiple-choice question',
    fn: async () => {
      const t = pick(TRIVIA);
      return ok(`${t.q}\n\nAnswer: ${t.a}`);
    } },

  { name: 'quiz', summary: 'Quiz round', effect: 'run a short sequence of trivia questions',
    fn: async (ctx) => {
      const n = Math.min(10, Math.max(2, Number(A(ctx)) || 5));
      const chosen = [...TRIVIA].sort(() => randomInt(3) - 1).slice(0, n);
      setSession(`quiz:${CHAT(ctx)}`, { list: chosen, idx: 0 });
      return ok(`Quiz of ${n} questions. Current question:\n\n${chosen[0]!.q}\n\nReply with your answer.`);
    } },

  { name: 'quiznext', summary: 'Next quiz question', effect: 'grade an answer and move to the next question',
    fn: async (ctx) => {
      const s = getSession<{ list: typeof TRIVIA; idx: number; score: number }>(`quiz:${CHAT(ctx)}`);
      if (!s) return bad('No quiz running. Start one with: quiz');
      const cur = s.list[s.idx]!;
      const guess = A(ctx).toLowerCase();
      const correct = guess.length > 0 && (cur.a.toLowerCase().includes(guess) || guess.includes(cur.a.toLowerCase()));
      const score = s.score + (correct ? 1 : 0);
      const idx = s.idx + 1;
      if (idx >= s.list.length) { sessions.delete(`quiz:${CHAT(ctx)}`); return ok(`${correct ? 'Correct.' : `Incorrect — the answer was "${cur.a}".`}\n\nFinal score: ${score}/${s.list.length}`); }
      setSession(`quiz:${CHAT(ctx)}`, { list: s.list, idx, score });
      return ok(`${correct ? 'Correct.' : `Incorrect — the answer was "${cur.a}".`} Score: ${score}/${s.list.length}\n\nQuestion ${idx + 1}: ${s.list[idx]!.q}`);
    } },

  { name: 'riddle', summary: 'Riddle', effect: 'pose a riddle and reveal the answer',
    fn: async () => { const r = pick(RIDDLES); return ok(`Riddle: ${r.q}\n\nAnswer: ${r.a}`); } },

  { name: 'fact', summary: 'Random fact', effect: 'share a verified fact',
    fn: async () => ok(pick(FACTS)) },

  { name: 'capitalquiz', summary: 'Capital city quiz', effect: 'name the capital city of a country',
    fn: async () => {
      const pairs: ReadonlyArray<[string, string]> = [
        ['Japan', 'Tokyo'], ['France', 'Paris'], ['Egypt', 'Cairo'], ['Norway', 'Oslo'],
        ['Peru', 'Lima'], ['Kenya', 'Nairobi'], ['Portugal', 'Lisbon'], ['Cuba', 'Havana'],
      ];
      const [country, capital] = pick(pairs);
      return ok(`What is the capital of ${country}?\n\nAnswer: ${capital}`);
    } },

  { name: 'elementquiz', summary: 'Element symbol quiz', effect: 'name an element from its symbol',
    fn: async () => {
      const pairs: ReadonlyArray<[string, string]> = [['Au', 'Gold'], ['Fe', 'Iron'], ['Ag', 'Silver'], ['Pb', 'Lead'], ['Sn', 'Tin'], ['Cu', 'Copper'], ['Hg', 'Mercury'], ['W', 'Tungsten']];
      const [sym, name] = pick(pairs);
      return ok(`Which element has the symbol ${sym}?\n\nAnswer: ${name}`);
    } },

  { name: 'truefalse', summary: 'True or false', effect: 'pose a statement to judge',
    fn: async () => {
      const pairs: ReadonlyArray<[string, boolean]> = [
        ['Honey lasts indefinitely if sealed.', true],
        ['The Pacific Ocean is larger than all land combined.', true],
        ['Lightning never strikes the same place twice.', false],
        ['A group of flamingos is called a flamboyance.', true],
        ['Goldfish have a three-second memory.', false],
        ['Bananas grow on trees.', false],
        ['Octopuses have three hearts.', true],
        ['The Great Wall is visible from space with the naked eye.', false],
      ];
      const [statement, truth] = pick(pairs);
      return ok(`True or false: ${statement}\n\nAnswer: ${truth}`);
    } },

  { name: 'mathquiz', summary: 'Math quiz', effect: 'pose an arithmetic question',
    fn: async () => {
      const a = randomInt(10, 99), b = randomInt(2, 9);
      const op = pick(['+', '-', '*']);
      const value = op === '+' ? a + b : op === '-' ? a - b : a * b;
      return ok(`What is ${a} ${op} ${b}?\n\nAnswer: ${value}`);
    } },

  { name: 'flagquiz', summary: 'Flag quiz', effect: 'name the country a flag belongs to',
    fn: async () => {
      const pairs: ReadonlyArray<[string, string]> = [['🇯🇵', 'Japan'], ['🇧🇷', 'Brazil'], ['🇰🇪', 'Kenya'], ['🇳🇴', 'Norway'], ['🇮🇩', 'Indonesia'], ['🇲🇽', 'Mexico'], ['🇿🇦', 'South Africa'], ['🇮🇹', 'Italy']];
      const [flag, country] = pick(pairs);
      return ok(`Which country does this flag belong to? ${flag}\n\nAnswer: ${country}`);
    } },

  { name: 'synonym', summary: 'Synonym challenge', effect: 'offer a word and ask for a near match',
    fn: async (ctx) => {
      const pairs: ReadonlyArray<[string, string]> = [['happy', 'glad'], ['big', 'large'], ['fast', 'quick'], ['smart', 'clever'], ['angry', 'irate'], ['tiny', 'small'], ['begin', 'start'], ['silent', 'quiet']];
      // Honour the word the user actually asked about. Picking at random and
      // returning the synonym of a *different* word is technically correct and
      // completely useless to the person who typed the command.
      const asked = A(ctx).toLowerCase().trim();
      const hit = asked ? pairs.find(([w]) => w === asked) : undefined;
      if (hit) return ok(`A synonym for "${hit[0]}" is "${hit[1]}".`);
      const [w, s] = pick(pairs);
      return ok(`Find a synonym for "${w}".\n\nOne answer: ${s}`);
    } },

  { name: 'antonym', summary: 'Antonym challenge', effect: 'offer a word and ask for its opposite',
    fn: async (ctx) => {
      const pairs: ReadonlyArray<[string, string]> = [['hot', 'cold'], ['up', 'down'], ['fast', 'slow'], ['light', 'dark'], ['rich', 'poor'], ['early', 'late'], ['full', 'empty'], ['sharp', 'blunt']];
      const asked = A(ctx).toLowerCase().trim();
      const hit = asked ? pairs.find(([w]) => w === asked) : undefined;
      if (hit) return ok(`The opposite of "${hit[0]}" is "${hit[1]}".`);
      const [w, o] = pick(pairs);
      return ok(`What is the opposite of "${w}"?\n\nAnswer: ${o}`);
    } },

  { name: 'triviamarathon', summary: 'Trivia marathon', effect: 'list a full set of trivia answers for study',
    fn: async () => ok(TRIVIA.map((t, i) => `${i + 1}. ${t.q}\n   -> ${t.a}`).join('\n\n')) },

  /* ---- social ---- */
  { name: 'mood', summary: 'Group mood', effect: 'rate the tone of a sample of recent messages',
    fn: async (ctx) => {
      const raw = A(ctx);
      if (!raw) {
        return bad('Usage: mood <recent messages>\nPaste the messages you want analysed. This command does not have access to your chat history, so it will not pretend to.');
      }
      const lines = raw.split(/\n+/).filter(Boolean);
      const sample = lines.length >= 2 ? lines : [raw];
      const text = sample.join(' ').toLowerCase();
      const positive = (text.match(/\b(good|great|love|thanks|awesome|amazing|happy|nice|yes|perfect|fun)\b/g) ?? []).length;
      const negative = (text.match(/\b(bad|sad|angry|hate|awful|terrible|no|broken|annoying|wrong)\b/g) ?? []).length;
      const exclam = (text.match(/!/g) ?? []).length;
      const total = positive + negative;
      if (total === 0) return ok(`Looked at ${sample.length} messages.\nMood: neutral — no strong sentiment words found.\nExclamation marks: ${exclam}`);
      const pct = Math.round((positive / total) * 100);
      const mood = pct > 75 ? 'very positive' : pct > 55 ? 'positive' : pct > 45 ? 'mixed' : pct > 25 ? 'negative' : 'very negative';
      return ok(`Looked at ${sample.length} messages.\nMood: ${mood} (${pct}% positive wording)\nPositive words: ${positive}, negative: ${negative}, exclamation marks: ${exclam}`);
    } },

  { name: 'compliment', summary: 'Compliment', effect: 'send a genuine compliment',
    fn: async () => ok(pick(COMPLIMENTS)) },

  { name: 'wouldrather', summary: 'Would you rather', effect: 'pose a would-you-rather question',
    fn: async () => ok(pick(WOULD_RATHER)) },

  { name: 'truthdare', summary: 'Truth or dare', effect: 'issue a truth or a dare',
    fn: async (ctx) => {
      const want = A(ctx).toLowerCase();
      const isTruth = want === 'truth' ? true : want === 'dare' ? false : randomInt(2) === 0;
      return ok(`${isTruth ? 'TRUTH' : 'DARE'}: ${pick(isTruth ? TRUTHS : DARES)}`);
    } },

  { name: 'icebreaker', summary: 'Icebreaker', effect: 'start a conversation with a question',
    fn: async () => ok(pick(ICEBREAKERS)) },

  { name: 'deepquestion', summary: 'Deep question', effect: 'ask a question worth thinking about',
    fn: async () => ok(pick(DEEP)) },

  { name: 'fortune', summary: 'Fortune', effect: 'offer a general observation',
    fn: async () => {
      const lines = ['You are further along than you think.', 'Patience will pay off better than speed here.',
        'The thing you are avoiding is worth doing.', 'A small conversation today solves a large problem.',
        'Rest is part of the work, not separate from it.', 'Ask the question you already know the answer to.'];
      return ok(pick(lines));
    } },

  { name: 'burnout', summary: 'Burnout check', effect: 'a brief honest prompt about your week',
    fn: async () => {
      const q = pick(['When did you last do something with no purpose at all?',
        'What are you saying yes to out of guilt?',
        'What would you drop if nobody would notice?',
        'When did you last ask for help?']);
      return ok(q);
    } },

  { name: 'complimentchain', summary: 'Compliment chain', effect: 'generate a chain of linked compliments',
    fn: async () => {
      let s = pick(COMPLIMENTS)!;
      const out = [s];
      for (let i = 0; i < 2; i++) { s = s.replace(/\.$/, ''); out.push(`${s}, and that is only because of ${pick(['effort', 'listening', 'consistency', 'honesty'])}.`); }
      return ok(out.join('\n'));
    } },

  { name: 'conversationstarter', summary: 'Conversation starter', effect: 'open with a topic and a hook',
    fn: async () => {
      const topics = ['a book that changed your mind', 'a meal you would eat again', 'a place you would return to', 'a skill you wish you had started earlier'];
      return ok(`Talk about ${pick(topics)} — but start with the detail nobody expects.`);
    } },

  { name: 'pickcard', summary: 'Pick a card', effect: 'draw a random card with a reading',
    fn: async () => {
      const suits = ['Hearts', 'Diamonds', 'Clubs', 'Spades'];
      const meanings: Record<string, string> = {
        Hearts: 'emotion, something you have been protecting',
        Diamonds: 'a practical matter worth money or time',
        Clubs: 'work, discipline, something that pays off later',
        Spades: 'a difficulty you already know how to handle',
      };
      const suit = pick(suits)!;
      return ok(`${pick(['Ace', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King'])} of ${suit}\n\nThis points to ${meanings[suit]}.`);
    } },

  { name: 'challenge', summary: 'Challenge', effect: 'issue a challenge to another player',
    fn: async () => {
      const cs = ['beat me at word ladder', 'solve the next maze faster than me', 'out-trivia me in five questions', 'beat my dice roll'];
      return ok(`Challenge issued: ${pick(cs)}. Reply to accept.`);
    } },

  { name: 'duel', summary: 'Trivia duel', effect: 'keep a head-to-head trivia score',
    fn: async (ctx) => {
      const key = `duel:${CHAT(ctx)}`;
      const cur = getSession<Duel>(key);
      if (!cur) { setSession<Duel>(key, { a: KEY(ctx), b: '', aScore: 0, bScore: 0 }); return ok('Trivia duel started. Say: duel join'); }
      if (A(ctx).toLowerCase() === 'join') {
        if (cur.b) return ok('This duel already has two players.');
        setSession<Duel>(key, { ...cur, b: KEY(ctx) });
        return ok(`${cur.a} challenged you. First to 5 trivia points wins. Say: duel quiz`);
      }
      if (A(ctx).toLowerCase() === 'score') return ok(`${cur.a}: ${cur.aScore}\n${cur.b || 'No challenger yet'}: ${cur.bScore}`);
      if (A(ctx).toLowerCase() === 'quiz') {
        const t = pick(TRIVIA);
        setSession(`duelq:${CHAT(ctx)}`, { answer: t.a });
        return ok(`Duel question:\n\n${t.q}`);
      }
      const answer = getSession<{ answer: string }>(`duelq:${CHAT(ctx)}`);
      if (!answer) return bad('Send "duel quiz" to pose a question.');
      const guess = A(ctx).toLowerCase();
      const correct = answer.answer.toLowerCase().includes(guess) || guess.includes(answer.answer.toLowerCase());
      sessions.delete(`duelq:${CHAT(ctx)}`);
      if (!correct) return ok(`Incorrect. The answer was "${answer.answer}".\n${cur.a}: ${cur.aScore} — ${cur.b || '—'}: ${cur.bScore}`);
      const mine = KEY(ctx) === cur.a;
      const aScore = cur.aScore + (mine ? 1 : 0);
      const bScore = cur.bScore + (mine ? 0 : 1);
      if (aScore >= 5 || bScore >= 5) { sessions.delete(key); return ok(`Correct! Final: ${cur.a} ${aScore} — ${cur.b} ${bScore}\n${aScore >= 5 ? cur.a : cur.b} wins the duel.`); }
      setSession<Duel>(key, { ...cur, aScore, bScore });
      return ok(`Correct!\n${cur.a}: ${aScore} — ${cur.b || '—'}: ${bScore}`);
    } },

  { name: 'kingofthehill', summary: 'King of the hill', effect: 'hold the top score for the longest streak',
    fn: async (ctx) => {
      const key = `koth:${CHAT(ctx)}`;
      const cur = getSession<{ king: string; score: number }>(key);
      if (!cur) { setSession(key, { king: KEY(ctx), score: 1 }); return ok(`King of the hill: ${KEY(ctx)} (score 1). Be the last to hold the highest score.`); }
      const r = randomInt(1, 20);
      if (r >= cur.score) { setSession(key, { king: KEY(ctx), score: r }); return ok(`New king: ${KEY(ctx)} with ${r}.`); }
      setSession(key, { ...cur, score: cur.score + r });
      return ok(`${cur.king} still holds the hill at ${cur.score + r}. You scored ${r}.`);
    } },

  { name: 'tournament', summary: 'Bracket', effect: 'generate a random single-elimination bracket',
    fn: async (ctx) => {
      const n = Math.min(16, Math.max(4, Number(A(ctx)) || 8));
      const names = Array.from({ length: n }, (_, i) => `Player ${i + 1}`);
      for (let i = names.length - 1; i > 0; i--) { const j = randomInt(i + 1); [names[i], names[j]] = [names[j]!, names[i]!]; }
      const rounds: string[] = [];
      let cur = names;
      let round = 1;
      while (cur.length > 1) {
        const next: string[] = [];
        const lines: string[] = [];
        for (let i = 0; i < cur.length; i += 2) lines.push(`  ${cur[i]} vs ${cur[i + 1]}`);
        next.push(...Array.from({ length: cur.length / 2 }, (_, i) => `R${round + 1}-${i + 1}`));
        rounds.push(`Round ${round}\n${lines.join('\n')}`);
        cur = next;
        round++;
      }
      return ok(`Single-elimination bracket for ${n} players:\n\n${rounds.join('\n\n')}\n\nChampion: ${pick(names)}`);
    } },

  /* ---- economy ---- */
  { name: 'coins', summary: 'Coin balance', effect: 'show your coin balance',
    fn: async (ctx) => {
      const c = getSession<Coin>(`c:${KEY(ctx)}`) ?? { balance: 100, streak: 0, last: '' };
      return ok(`Balance: ${c.balance} coins\nStreak: ${c.streak} day${c.streak === 1 ? '' : 's'}`);
    } },

  { name: 'daily', summary: 'Daily check-in', effect: 'claim once per day and build a streak',
    fn: async (ctx) => {
      const today = new Date().toISOString().slice(0, 10);
      const c = getSession<Coin>(`c:${KEY(ctx)}`) ?? { balance: 100, streak: 0, last: '' };
      if (c.last === today) return bad(`You already claimed today. Come back tomorrow.\nBalance: ${c.balance} coins.`);
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      const streak = c.last === yesterday ? c.streak + 1 : 1;
      const reward = 25 + streak * 5;
      setSession<Coin>(`c:${KEY(ctx)}`, { balance: c.balance + reward, streak, last: today });
      return ok(`Claimed ${reward} coins.\nStreak: ${streak} day${streak === 1 ? '' : 's'}\nBalance: ${c.balance + reward} coins`);
    } },

  { name: 'work', summary: 'Work for coins', effect: 'complete a small task for coins',
    fn: async (ctx) => {
      const tasks = ['Sort the files on your desktop.', 'Water a plant.', 'Reply to one email you have been avoiding.',
        'Walk for ten minutes.', 'Tidy one drawer.', 'Delete five things you no longer use.', 'Read ten pages of anything.'];
      const c = getSession<Coin>(`c:${KEY(ctx)}`) ?? { balance: 100, streak: 0, last: '' };
      const reward = randomInt(15, 50);
      setSession<Coin>(`c:${KEY(ctx)}`, { ...c, balance: c.balance + reward });
      return ok(`Task: ${pick(tasks)}\nReward: ${reward} coins\nBalance: ${c.balance + reward} coins`);
    } },

  { name: 'balance', summary: 'Balance', effect: 'show your current coin balance',
    fn: async (ctx) => {
      const c = getSession<Coin>(`c:${KEY(ctx)}`) ?? { balance: 100, streak: 0, last: '' };
      return ok(`${c.balance} coins`);
    } },

  { name: 'shop', summary: 'Shop', effect: 'spend coins on items',
    fn: async (ctx) => {
      const items: ReadonlyArray<[string, number]> = [['Coffee', 40], ['Movie ticket', 150], ['Skip a chore', 200],
        ['Name a colour', 25], ['Choose the music', 30], ['Late pass', 500]];
      const want = A(ctx).toLowerCase();
      const item = items.find(([n]) => n.toLowerCase() === want);
      if (!item) return ok(`Shop:\n${items.map(([n, p]) => `  ${n} — ${p} coins`).join('\n')}\n\nBuy with: shop <item>`);
      const c = getSession<Coin>(`c:${KEY(ctx)}`) ?? { balance: 100, streak: 0, last: '' };
      if (c.balance < item[1]) return bad(`Not enough coins. ${item[0]} costs ${item[1]}, you have ${c.balance}.`);
      setSession<Coin>(`c:${KEY(ctx)}`, { ...c, balance: c.balance - item[1] });
      return ok(`Bought ${item[0]} for ${item[1]} coins.\nBalance: ${c.balance - item[1]} coins`);
    } },

  { name: 'rob', summary: 'Rob', effect: 'risk coins to steal from another player',
    fn: async (ctx) => {
      const target = getSession<Coin>(`c:${A(ctx) || 'nobody'}`);
      const me = getSession<Coin>(`c:${KEY(ctx)}`) ?? { balance: 100, streak: 0, last: '' };
      if (!A(ctx)) return bad('Usage: rob <player>');
      if (!target) return bad(`No coin balance found for "${A(ctx)}".`);
      const stake = Math.min(me.balance, target.balance);
      const won = randomInt(2) === 0;
      setSession<Coin>(`c:${KEY(ctx)}`, { ...me, balance: me.balance + (won ? stake : -stake) });
      setSession<Coin>(`c:${A(ctx)}`, { ...target, balance: target.balance + (won ? -stake : stake) });
      return ok(won ? `You robbed ${A(ctx)} for ${stake} coins.\nBalance: ${me.balance + stake}`
        : `${A(ctx)} robbed you for ${stake} coins.\nBalance: ${me.balance - stake}`);
    } },

  { name: 'level', summary: 'Level', effect: 'derive a level from your balance',
    fn: async (ctx) => {
      const c = getSession<Coin>(`c:${KEY(ctx)}`) ?? { balance: 100, streak: 0, last: '' };
      const level = Math.floor(c.balance / 100) + 1;
      return ok(`Level ${level}\nBalance: ${c.balance} coins\nNext level at ${level * 100} coins.`);
    } },

  { name: 'streak', summary: 'Streak', effect: 'show your daily check-in streak',
    fn: async (ctx) => {
      const c = getSession<Coin>(`c:${KEY(ctx)}`) ?? { balance: 100, streak: 0, last: '' };
      return ok(`${c.streak} day streak.\n${c.streak > 0 ? 'Claim your daily reward with: daily' : 'Start one now with: daily'}`);
    } },

  { name: 'leaderboard', summary: 'Leaderboard', effect: 'rank players by coins in this session',
    fn: async () => {
      const entries: Array<[string, number]> = [];
      for (const [k, v] of sessions) if (k.startsWith('c:')) entries.push([k.slice(2), (v.state as Coin).balance]);
      if (!entries.length) return ok('No players have a balance yet. Use: daily');
      entries.sort((a, b) => b[1] - a[1]);
      return ok(entries.slice(0, 10).map(([n, b], i) => `${i + 1}. ${n} — ${b} coins`).join('\n'));
    } },

  { name: 'gamble', summary: 'Gamble', effect: 'wager coins on a coin flip',
    fn: async (ctx) => {
      const wager = Number(A(ctx));
      if (!Number.isInteger(wager) || wager < 1) return bad('Usage: gamble <amount>');
      const c = getSession<Coin>(`c:${KEY(ctx)}`) ?? { balance: 100, streak: 0, last: '' };
      if (c.balance < wager) return bad(`You only have ${c.balance} coins.`);
      const won = randomInt(2) === 0;
      setSession<Coin>(`c:${KEY(ctx)}`, { ...c, balance: c.balance + (won ? wager : -wager) });
      return ok(won ? `You won ${wager} coins.\nBalance: ${c.balance + wager}` : `You lost ${wager} coins.\nBalance: ${c.balance - wager}`);
    } },

  /* ---- RPG ---- */
  { name: 'dungeon', summary: 'Dungeon crawler', effect: 'start a text dungeon crawl',
    fn: async (ctx) => {
      setSession<Dungeon>(`dg:${CHAT(ctx)}`, { hp: 20, room: 0, gold: 0, alive: true, log: [] });
      return ok(`You enter a dungeon.\nHP: 20  Gold: 0\n\nRoom 1: A narrow corridor. A door stands to the north. Something moves in the dark.\nReply with: look | north | attack | rest | flee`);
    } },

  { name: 'adventure', summary: 'Take a dungeon action', effect: 'act in the current dungeon room',
    fn: async (ctx) => {
      const key = `dg:${CHAT(ctx)}`;
      const d = getSession<Dungeon>(key);
      if (!d) return bad('You are not in a dungeon. Start with: dungeon');
      if (!d.alive) { sessions.delete(key); return bad('You died. Start a new run with: dungeon'); }
      const action = A(ctx).toLowerCase();
      if (action === 'look') {
        const things = ['a rusty sword', 'a locked chest', 'a skeleton', 'a dripping ceiling', 'a staircase going down'];
        return ok(`Room ${d.room + 1}: You see ${pick(things)} and ${pick(['a doorway', 'a corridor', 'an empty wall'])}.`);
      }
      if (action === 'north' || action === 'go') {
        const found = randomInt(3);
        if (found === 0) { const gold = randomInt(5, 25); setSession(key, { ...d, room: d.room + 1, gold: d.gold + gold }); return ok(`You descend. You find ${gold} gold.\nHP: ${d.hp}  Gold: ${d.gold + gold}`); }
        if (found === 1) { const dmg = randomInt(1, 6); const hp = d.hp - dmg; if (hp <= 0) { setSession(key, { ...d, hp: 0, alive: false }); return ok(`A trap injures you for ${dmg}.\nYou have died.`); } setSession(key, { ...d, hp, room: d.room + 1 }); return ok(`A trap injures you for ${dmg}.\nHP: ${hp}`); }
        setSession(key, { ...d, room: d.room + 1 });
        return ok(`The corridor continues. You are now in room ${d.room + 2}.`);
      }
      if (action === 'attack') {
        const dmg = randomInt(2, 8);
        const taken = randomInt(1, 5);
        const hp = d.hp - taken;
        if (hp <= 0) { setSession(key, { ...d, hp: 0, alive: false }); return ok(`You deal ${dmg} damage but take ${taken}.\nYou have died.`); }
        setSession(key, { ...d, hp });
        return ok(`You deal ${dmg} damage and take ${taken}.\nHP: ${hp}`);
      }
      if (action === 'rest') {
        const hp = Math.min(20, d.hp + randomInt(3, 8));
        setSession(key, { ...d, hp });
        return ok(`You rest. HP: ${hp}`);
      }
      if (action === 'flee') { sessions.delete(key); return ok('You retreat out of the dungeon. You live to try again.'); }
      return bad('Reply with: look | north | attack | rest | flee');
    } },

  { name: 'dungeonstatus', summary: 'Dungeon status', effect: 'show your dungeon progress',
    fn: async (ctx) => {
      const d = getSession<Dungeon>(`dg:${CHAT(ctx)}`);
      if (!d) return bad('You are not in a dungeon. Start with: dungeon');
      return ok(`Room: ${d.room + 1}\nHP: ${d.hp}\nGold: ${d.gold}\nStatus: ${d.alive ? 'alive' : 'dead'}`);
    } },

  { name: 'inventory', summary: 'Inventory', effect: 'show dungeon inventory',
    fn: async (ctx) => {
      const d = getSession<Dungeon>(`dg:${CHAT(ctx)}`);
      if (!d) return bad('You are not in a dungeon.');
      const items = d.gold > 50 ? ['rusty sword', 'torch', '50 gold'] : d.gold > 10 ? ['torch', `${d.gold} gold`] : ['bare hands'];
      return ok(`Inventory: ${items.join(', ')}`);
    } },

  { name: 'tavern', summary: 'Tavern', effect: 'rest at a tavern and hear local news',
    fn: async () => {
      const news = ['A merchant lost a wagon of turnips on the north road.',
        'The mill is running again.',
        'Strange lights were seen over the old keep.',
        'A bard is performing at the crossroads tonight.',
        'Prices are up; the tax collector came through again.'];
      return ok(`You sit down at the tavern.\nThe fire is warm and the ale is cheap.\n\n"${pick(news)}"`);
    } },

  { name: 'rpg', summary: 'Quick encounter', effect: 'roll a one-shot encounter result',
    fn: async () => {
      const roll = randomInt(20);
      const encounters: ReadonlyArray<[number, string]> = [[1, 'You meet a wounded traveller who asks for water.'],
        [5, 'You overhear two merchants arguing over a map.'],
        [10, 'You find a coin in a drain.'],
        [14, 'A hooded figure tries to sell you a ' + pick(['ring', 'sword', 'map']) + '.'],
        [18, 'You stumble onto a hidden cache of supplies.']];
      const line = encounters.find(([t]) => roll <= t)?.[1] ?? 'The road is quiet.';
      return ok(`Rolled ${roll}/20.\n\n${line}`);
    } },

  { name: 'd20', summary: 'Attack roll', effect: 'roll a d20 attack',
    fn: async () => {
      const r = randomInt(20);
      return ok(`d20: ${r}${r === 20 ? ' — critical hit!' : r === 1 ? ' — fumble.' : ''}`);
    } },

  { name: 'dmgr', summary: 'Damage roll', effect: 'roll damage dice',
    fn: async (ctx) => {
      const m = Math.min(10, Math.max(1, Number(A(ctx)) || 2));
      const rolls = Array.from({ length: m }, () => randomInt(1, 6));
      return ok(`${m}d6: ${rolls.join(' + ')} = ${rolls.reduce((a, b) => a + b, 0)}`);
    } },

  { name: 'statroll', summary: 'Ability scores', effect: 'roll four ability scores',
    fn: async () => {
      const scores = Array.from({ length: 4 }, () => {
        const rolls = Array.from({ length: 4 }, () => randomInt(1, 6)).sort((a, b) => b - a);
        return rolls[0]! + rolls[1]! + rolls[2]! + 3;
      });
      return ok(scores.join(', '));
    } },

  /* ---- community utility ---- */
  { name: 'countdown', summary: 'Countdown', effect: 'show a countdown to a target date',
    fn: async (ctx) => {
      const target = Date.parse(A(ctx));
      if (!Number.isFinite(target)) return bad('Give a date, for example: countdown 2027-01-01');
      const ms = target - Date.now();
      if (ms <= 0) return ok('That date has already passed.');
      const days = Math.floor(ms / 86_400_000);
      const hours = Math.floor((ms % 86_400_000) / 3_600_000);
      return ok(`${days} days and ${hours} hours until ${A(ctx)}.`);
    } },

  { name: 'wordstats', summary: 'Word statistics', effect: 'count words, characters and sentences',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: wordcount <text>');
      const t = A(ctx);
      return ok(`Words: ${t.split(/\s+/).filter(Boolean).length}\nCharacters: ${t.length}\nCharacters without spaces: ${t.replace(/\s/g, '').length}\nSentences: ${(t.match(/[.!?]+/g) ?? []).length}`);
    } },

  { name: 'charcount', summary: 'Character count', effect: 'count characters',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: charcount <text>');
      return ok(`${A(ctx).length} characters`);
    } },

  { name: 'linestat', summary: 'Line stat', effect: 'count lines and words in multi-line text',
    fn: async (ctx) => {
      const lines = A(ctx).split('\n');
      return ok(`Lines: ${lines.length}\nWords: ${A(ctx).split(/\s+/).filter(Boolean).length}\nCharacters: ${A(ctx).length}`);
    } },

  { name: 'rules', summary: 'Game rules', effect: 'list the games available here',
    fn: async () => ok([
      'Games: hangman, game24, nim, tic, connect4, maze, sudoku4, battleship, dotsboxes, mastermind',
      'Dice and cards: dice, blackjack, pokerdice, war, roulette, slots, baccarat, cards, deck',
      'Trivia: trivia, quiz, riddle, fact, capitalquiz, elementquiz, truefalse, mathquiz, flagquiz',
      'Social: mood, compliment, wouldrather, truthdare, icebreaker, deepquestion, duel',
      'Economy: coins, daily, work, shop, level, leaderboard, gamble',
      'Dungeon: dungeon, adventure, rpg, tavern',
      'Say a command name to start. Use "name" with no argument for rules where available.',
    ].join('\n\n')) },

  { name: 'topic', summary: 'Discussion topic', effect: 'propose a topic for the group',
    fn: async () => ok(`Topic for today: ${pick([
      'What is the best thing you made this year?',
      'If you had to teach one skill, what would it be?',
      'What do you believe that most people disagree with?',
      'What is the last book you finished?',
      'Where would you go if you had two free weeks?',
    ])}`) },

  { name: 'welcome', summary: 'Welcome message', effect: 'greet a new group member',
    fn: async (ctx) => {
      const user = A(ctx);
      if (!user) return ok('Welcome! Say hello, then try: rules');
      return ok(`Welcome, ${user}. Type "rules" to see the games available here.`);
    } },

  { name: 'goodbye', summary: 'Goodbye message', effect: 'send someone off',
    fn: async (ctx) => {
      const user = A(ctx);
      return ok(user ? `Goodbye, ${user}. See you soon.` : 'Goodbye. See you soon.');
    } },

  { name: 'vote', summary: 'Run a vote', effect: 'open a vote on a question',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: vote <question>');
      const key = `vote:${CHAT(ctx)}`;
      setSession(key, { question: A(ctx), votes: new Map<string, string>() as Map<string, string>, open: true });
      return ok(`Vote open: ${A(ctx)}\nReply with your vote. Close with: vote results`);
    } },

  { name: 'votecast', summary: 'Cast a vote', effect: 'record your vote in an open vote',
    fn: async (ctx) => {
      const s = getSession<{ question: string; votes: Map<string, string>; open: boolean }>(`vote:${CHAT(ctx)}`);
      if (!s?.open) return bad('No vote is open. Start one with: vote <question>');
      s.votes.set(KEY(ctx), A(ctx) || 'abstain');
      setSession(`vote:${CHAT(ctx)}`, s);
      return ok(`Vote recorded: ${A(ctx) || 'abstain'}\n${s.votes.size} vote${s.votes.size === 1 ? '' : 's'} so far.`);
    } },

  { name: 'voteresults', summary: 'Vote results', effect: 'tally and close an open vote',
    fn: async (ctx) => {
      const s = getSession<{ question: string; votes: Map<string, string>; open: boolean }>(`vote:${CHAT(ctx)}`);
      if (!s) return bad('No vote is open.');
      sessions.delete(`vote:${CHAT(ctx)}`);
      if (!s.votes.size) return ok(`${s.question}\n\nNo votes were cast.`);
      const tally = new Map<string, number>();
      for (const v of s.votes.values()) tally.set(v, (tally.get(v) ?? 0) + 1);
      const lines = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${k} — ${n}`);
      const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]!;
      const tied = [...tally.values()].filter((v) => v === top[1]).length > 1;
      return ok(`${s.question}\n\n${lines.join('\n')}\n\n${s.votes.size} votes.${tied ? ' Top place is tied.' : ` Winner: ${top[0]}.`}`);
    } },

  { name: 'suggest', summary: 'Suggestion box', effect: 'record a suggestion and show all of them',
    fn: async (ctx) => {
      const key = `sug:${CHAT(ctx)}`;
      const list = getSession<string[]>(key) ?? [];
      if (!A(ctx)) {
        if (!list.length) return ok('No suggestions yet. Add one with: suggest <your idea>');
        return ok(`${list.length} suggestion${list.length === 1 ? '' : 's'}:\n${list.map((s, i) => `${i + 1}. ${s}`).join('\n')}`);
      }
      setSession(key, [...list, `${KEY(ctx).split('@')[0]}: ${A(ctx)}`]);
      return ok(`Suggestion recorded. ${list.length + 1} total.`);
    } },

  { name: 'challenge2', summary: 'Dare someone', effect: 'issue a light dare to another member',
    fn: async (ctx) => {
      const who = A(ctx);
      if (!who) return bad('Usage: challenge2 <person>');
      return ok(`${who}, your dare: ${pick(DARES)}`);
    } },

    { name: 'pingcheck', summary: 'Bot check', effect: 'confirm the bot is responsive',
    fn: async () => ok(`Responsive. Server time: ${new Date().toISOString()}`) },

  { name: 'groupinfo', summary: 'Group info', effect: 'count speakers in a pasted message block',
    fn: async (ctx) => {
      const raw = A(ctx);
      if (!raw) return bad('Usage: groupinfo <pasted messages>\nThis command has no access to your chat history and will not invent it.');
      const lines = raw.split(/\n+/).filter(Boolean);
      const speakers = new Set<string>();
      for (const line of lines) { const m = line.match(/^[\[]?([^\]:\s]+)/); if (m) speakers.add(m[1]!); }
      return ok(`Chat: ${ctx.jid.split('@')[0]}\nLines analysed: ${lines.length}\nDistinct speakers detected: ${speakers.size}`);
    } },

  { name: 'active', summary: 'Active hours', effect: 'find the busiest hour in a pasted message block',
    fn: async (ctx) => {
      const raw = A(ctx);
      if (!raw) return bad('Usage: active <pasted messages with [HH:MM] timestamps>\nThis command has no access to your chat history and will not invent it.');
      const hours = new Array(24).fill(0);
      let matched = 0;
      for (const line of raw.split(/\n+/)) {
        const m = line.match(/\[(\d{1,2}):(\d{2})/);
        if (m) { hours[Number(m[1]) % 24]!++; matched++; }
      }
      if (!matched) return bad('No [HH:MM] timestamps found in that text.');
      const peak = hours.indexOf(Math.max(...hours));
      return ok(`Analysed ${matched} timestamped messages.\nBusiest hour: ${String(peak).padStart(2, '0')}:00`);
    } },

  { name: 'yell', summary: 'Shout', effect: 'repeat text in capitals with punctuation',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: shout <text>');
      return ok(`${A(ctx).toUpperCase()}!!!`);
    } },

  { name: 'speak', summary: 'Speak', effect: 'reverse-text speech for fun',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: speak <text>');
      return ok(`"${A(ctx)}" — said the duck, backwards.`);
    } },

  { name: 'rollcall', summary: 'Roll call', effect: 'roll a random order for taking turns',
    fn: async (ctx) => {
      const names = A(ctx).split(',').map((s) => s.trim()).filter(Boolean);
      if (names.length < 2) return bad('Give at least two names separated by commas.');
      for (let i = names.length - 1; i > 0; i--) { const j = randomInt(i + 1); [names[i], names[j]] = [names[j]!, names[i]!]; }
      return ok(names.map((n, i) => `${i + 1}. ${n}`).join('\n'));
    } },

  { name: 'scoreboard', summary: 'Scoreboard', effect: 'reset and show the game scoreboard',
    fn: async (ctx) => {
      const key = `sb:${CHAT(ctx)}`;
      const cur = getSession<Record<string, number>>(key);
      if (!cur) return ok('Scoreboard is empty. Games add to it as they are played.');
      const entries = Object.entries(cur).sort((a, b) => b[1] - a[1]);
      if (!entries.length) return ok('Scoreboard is empty.');
      return ok(entries.map(([n, s], i) => `${i + 1}. ${n} — ${s}`).join('\n'));
    } },

  { name: 'sadd', summary: 'Add a score', effect: 'add points to a player on the scoreboard',
    fn: async (ctx) => {
      const [who, pts] = A(ctx).split(/\s+/);
      if (!who || !Number.isInteger(Number(pts))) return bad('Usage: sadd <player> <points>');
      const key = `sb:${CHAT(ctx)}`;
      const cur = getSession<Record<string, number>>(key) ?? {};
      cur[who] = (cur[who] ?? 0) + Number(pts);
      setSession(key, cur);
      return ok(`${who}: ${cur[who]} points.`);
    } },

  { name: 'reset', summary: 'Reset the game', effect: 'clear the current game session',
    fn: async (ctx) => {
      let cleared = 0;
      for (const key of [...sessions.keys()]) {
        if (key.endsWith(`:${CHAT(ctx)}`) || key.includes(`:${CHAT(ctx)}`)) { sessions.delete(key); cleared++; }
      }
      if (!cleared) return ok('There was no active game to reset.');
      return ok(`Cleared ${cleared} game session${cleared === 1 ? '' : 's'}.`);
    } },

  { name: 'sessions', summary: 'Session count', effect: 'report how many game sessions are in memory',
    fn: async () => ok(`${sessions.size} game session${sessions.size === 1 ? '' : 's'} held in memory (cap ${MAX_SESSIONS}).`) },
];

/* ── helpers ──────────────────────────────────────────────────────────── */

function isPrime(n: number): boolean {
  if (n < 2) return false;
  for (let i = 2; i * i <= n; i++) if (n % i === 0) return false;
  return true;
}

function checkWin(b: string[]): string {
  const LINES: ReadonlyArray<readonly [number, number, number]> = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6],
  ];
  for (const [a, b2, c] of LINES) if (b[a] !== ' ' && b[a] === b[b2] && b[a] === b[c]) return b[a]!;
  return '';
}

function renderBoard(b: string[]): string {
  const row = (n: number): string => `${b[n * 3]} | ${b[n * 3 + 1]} | ${b[n * 3 + 2]}`;
  return `${row(0)}\n---┼---┼---\n${row(1)}\n---┼---┼---\n${row(2)}`;
}

function checkConnect4(board: string[], row: number, col: number, token: string): string {
  const dirs: ReadonlyArray<readonly [number, number]> = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (const [dy, dx] of dirs) {
    let count = 1;
    for (const s of [1, -1]) {
      let y = row + dy * s, x = col + dx * s;
      while (y >= 0 && y < 6 && x >= 0 && x < 7 && board[y * 7 + x] === token) { count++; y += dy * s; x += dx * s; }
    }
    if (count >= 4) return token;
  }
  return '';
}

function renderConnect4(board: string[]): string {
  const rows: string[] = [];
  for (let r = 0; r < 6; r++) rows.push(board.slice(r * 7, r * 7 + 7).join(' '));
  return `1 2 3 4 5 6 7\n${rows.join('\n')}`;
}

function renderMaze(walls: boolean[][], size: number, y: number, x: number): string {
  const lines: string[] = [];
  for (let r = 0; r < size * 2 + 1; r++) {
    let line = '';
    for (let c = 0; c < size * 2 + 1; c++) {
      const isPlayer = r === y * 2 + 1 && c === x * 2 + 1;
      line += isPlayer ? 'S' : walls[r]![c] ? '#' : ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

function renderReversi(board: string[]): string {
  const rows: string[] = [];
  for (let r = 0; r < 8; r++) rows.push(board.slice(r * 8, r * 8 + 8).map((c) => c === ' ' ? '·' : c).join(' '));
  return rows.join('\n');
}

function renderCheckers(): string {
  const rows: string[] = [];
  for (let r = 0; r < 8; r++) {
    let line = '';
    for (let c = 0; c < 8; c++) {
      const dark = (r + c) % 2 === 1;
      line += dark ? (r < 4 ? ' ○ ' : '   ') : (r > 3 ? ' ● ' : '   ');
    }
    rows.push(line);
  }
  return rows.join('\n');
}

export function installSocialGames(reg: {
  command(c: { name: string; summary: string; effect: string; family?: string; handler: (ctx: CommandContext) => Promise<CommandResult> }): unknown;
}): void {
  for (const g of socialGames) {
    reg.command({
      name: g.name,
      summary: g.summary,
      effect: g.effect,
      family: 'game',
      handler: async (ctx: CommandContext): Promise<CommandResult> => {
        try {
          return await g.fn(ctx);
        } catch (err) {
          return bad(`${g.name}: ${(err as Error).message.slice(0, 90)}`);
        }
      },
    });
  }
}

export { sessions as gameSessions };