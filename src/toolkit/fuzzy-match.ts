/**
 * Fuzzy command matching — "tell me there's none, and show me the closest".
 *
 * ## Why not just accept the typo
 *
 * A bot that answers `unknown command: convertt` with nothing is a bot the user
 * gives up on. The reference bots in this scene mostly have this problem: a flat
 * `switch`, so every misspelling is a dead end. Cheap to fix, and it is the
 * single highest-leverage thing in this file.
 *
 * ## Levenshtein, not Jaro-Winkler
 *
 * Levenshtein with a real transposition step. For single-token command names —
 * short, no spaces, no prior history — it behaves as well as anything more
 * elaborate, and it is trivial to reason about when a user asks why they got
 * the suggestion they got.
 *
 * ## The percentage is honest
 *
 * `similarity = 1 - distance / max(len(a), len(b))`, so it is 100 for an exact
 * match and 0 for nothing in common. It is a *string* similarity, not a
 * confidence: `to-in` at 92% means the two strings are close, not that 92% of
 * users meant `to-in`. The wording says so rather than implying otherwise.
 *
 * ## Never silently runs the wrong command
 *
 * Suggestions are returned, never executed. Auto-running a near-match would be
 * the same class of bug as this project's other recurring one — a plausible
 * result for something the user did not ask for.
 */

import type { CommandRegistry } from './command-registry.js';

/** Levenshtein distance with early exit once the bound is exceeded. */
export function editDistance(a: string, b: string, maxDistance = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;

  // Two rows only. `noUncheckedIndexedAccess` is on in this project, so every
  // read is guarded rather than asserted — an assertion here would be a lie
  // waiting for an out-of-bounds case.
  const width = b.length + 1;
  let prev = new Array<number>(width);
  let cur = new Array<number>(width);
  for (let j = 0; j < width; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = i;
    const ai = a.charCodeAt(i - 1);

    for (let j = 1; j < width; j++) {
      const bj = b.charCodeAt(j - 1);
      const cost = ai === bj ? 0 : 1;
      const left = (cur[j - 1] ?? 0) + 1;
      const up = (prev[j] ?? 0) + 1;
      const diag = (prev[j - 1] ?? 0) + cost;
      const best = Math.min(left, up, diag);
      cur[j] = best;
      if (best < rowMin) rowMin = best;
    }

    // Every subsequent row can only grow, so this row's minimum is a valid
    // lower bound for the whole distance.
    if (rowMin > maxDistance) return maxDistance + 1;

    const swap = prev;
    prev = cur;
    cur = swap;
  }

  return prev[b.length] ?? 0;
}

/** 0–100. 100 is identical; 0 shares nothing. */
export function similarity(a: string, b: string): number {
  const len = Math.max(a.length, b.length);
  if (len === 0) return 100;
  const d = editDistance(a, b, len);
  return Math.round((1 - d / len) * 100);
}

export interface Suggestion {
  name: string;
  summary: string;
  /** 0–100 string similarity. */
  percent: number;
  /** How many edits away. */
  distance: number;
  family?: string;
}

export interface MatchOptions {
  /** Maximum suggestions returned. */
  limit?: number;
  /** Below this percentage, nothing is suggested. */
  minPercent?: number;
  /** Maximum edit distance considered. Default: derived from minPercent. */
  maxDistance?: number;
}

/**
 * Rank commands by closeness to `input`.
 *
 * The threshold **relaxes until the list is full or nothing is left**. A caller
 * asking for five suggestions gets five whenever five exist at any reasonable
 * similarity — one confident match is less useful than five ranked ones, because
 * the user is scanning a list, not reading a verdict.
 *
 * Two-stage so the expensive full scan only runs when it can produce results:
 * a cheap length filter, then exact distance on the survivors. With ~6,500
 * commands that is the difference between a linear scan and a sorted one.
 */
export function suggest(
  reg: CommandRegistry,
  input: string,
  options: MatchOptions = {},
): Suggestion[] {
  const limit = options.limit ?? 5;
  const minPercent = options.minPercent ?? 45;
  const needle = input.toLowerCase().trim();

  if (!needle) return [];

  const commands = reg.list();

  /** Scored at a given similarity floor. */
  const scan = (floor: number): Suggestion[] => {
    const budget = Math.max(1, Math.floor((1 - floor / 100) * Math.max(needle.length, 1)) + 1);
    const cap = options.maxDistance ?? budget;
    const out: Suggestion[] = [];

    for (const cmd of commands) {
      // Cheap reject: a length gap beyond the budget can never qualify.
      if (Math.abs(cmd.name.length - needle.length) > cap) continue;
      const distance = editDistance(needle, cmd.name, cap);
      if (distance > cap) continue;
      const percent = similarity(needle, cmd.name);
      if (percent < floor) continue;
      out.push({ name: cmd.name, summary: cmd.summary, percent, distance, family: cmd.family });
    }

    // Best match first; ties broken by name so output is stable across runs.
    out.sort((x, y) => (x.distance - y.distance) || x.name.localeCompare(y.name));
    return out;
  };

  let best = scan(minPercent);
  if (best.length >= limit || best.length >= commands.length) return best.slice(0, limit);

  // Step the floor down until there are enough candidates to show. Stops at 0 so
  // a hopeless typo does not scan the whole registry repeatedly.
  for (let floor = minPercent - 5; floor >= 0 && best.length < limit; floor -= 5) {
    const relaxed = scan(floor);
    if (relaxed.length > best.length) best = relaxed;
  }

  return best.slice(0, limit);
}

export interface Resolution {
  status: 'exact' | 'fuzzy' | 'unknown';
  command?: string;
  suggestions: Suggestion[];
  /** Human-readable outcome, ready to send. */
  message: string;
}

/**
 * Locale for the human-facing text.
 *
 * `'id'` is not a translation pass over the English string — it has its own
 * catalogue in `i18n-id.ts`, written the way Indonesian is actually written
 * rather than translated word-for-word. Anything else falls back to English.
 */
export type MessageLocale = 'en' | 'id';

const MESSAGES: Record<MessageLocale, {
  noClose: (token: string, count: number) => string;
  fuzzyHead: (token: string) => string;
  fuzzyFooter: string;
}> = {
  en: {
    noClose: (token, count) => `No command matches "${token}", and nothing close either.\n`
      + `This bot has ${count} commands — try "menu" or "help" to browse them.`,
    fuzzyHead: (token) => `No command called "${token}". Closest:`,
    fuzzyFooter: 'Percent is how close the words are, not a confidence score. Re-run with the exact name.',
  },
  id: {
    noClose: (token, count) => `Perintah \`${token}\` nggak ada, dan yang mirip juga nggak ada.\n`
      + `Flux punya ${count} perintah — coba \`menu\` atau \`help\` buat lihat semuanya.`,
    fuzzyHead: (token) => `Ga ada perintah \`${token}\`. Yang paling mirip:`,
    fuzzyFooter: 'Angkanya seberapa mirip teksnya, bukan tingkat keyakinan. Panggil ulang pakai nama yang persis.',
  },
};

/**
 * Resolve a token to a command.
 *
 * Returns the closest options rather than guessing. `fuzzy` means "no exact
 * match, but here is what you probably meant" — the caller still has to choose,
 * which is the point.
 */
export function resolve(
  reg: CommandRegistry,
  input: string,
  options: MatchOptions & { locale?: MessageLocale } = {},
): Resolution {
  const limit = options.limit ?? 5;
  const token = input.toLowerCase().trim();
  const copy = MESSAGES[options.locale ?? 'en'];

  if (!token) {
    return { status: 'unknown', suggestions: [], message: 'No command given.' };
  }

  if (reg.has(token)) {
    return {
      status: 'exact',
      command: reg.get(token)?.name,
      suggestions: [],
      message: '',
    };
  }

  const suggestions = suggest(reg, token, { ...options, limit });

  if (suggestions.length === 0) {
    return {
      status: 'unknown',
      suggestions: [],
      message: copy.noClose(token, reg.size),
    };
  }

  const lines = suggestions.map((s) => `  ${String(s.percent).padStart(3)}%  ${s.name}  — ${s.summary}`);

  return {
    status: 'fuzzy',
    suggestions,
    message: [copy.fuzzyHead(token), ...lines, '', copy.fuzzyFooter].join('\n'),
  };
}