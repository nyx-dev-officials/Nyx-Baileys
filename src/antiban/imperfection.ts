/**
 * Content variation and human imperfection.
 *
 * ⚠️ EVASION MODULE. See `docs/ANTIBAN.md`.
 *
 * Three related ideas, all about making outbound activity look less machine-made:
 *
 *   1. **ContentVariator** — the same text sent twice is a flag; this varies it
 *      (zero-width joiner, punctuation, optional synonyms) so each copy differs.
 *   2. **LegitimacySignalInjector** — humans typo and correct, and pause
 *      mid-thought. This models both.
 *   3. **readReceiptVariance** — a Gaussian-jittered delay in front of
 *      `readMessages`, because an instant read is a bot tell.
 *
 * Run any of these only through the opt-in plugins; none is on by default.
 * Ported and adapted from the reference forks.
 */

/* ── content variation ───────────────────────────────────────────────── */

export interface VariatorOptions {
  /** Insert zero-width characters between words. Default `true`. */
  zeroWidthChars?: boolean;
  /** Vary trailing whitespace / punctuation. Default `true`. */
  punctuationVariation?: boolean;
  /** Append a rotating emoji. Default `false`. */
  emojiPadding?: boolean;
  /** Swap in synonyms for common words. Default `false`. */
  synonyms?: boolean;
  /** Take over variation entirely. */
  custom?: (text: string, index: number) => string;
}

const ZERO_WIDTH = ['\u200B', '\u200C', '\u200D', '\uFEFF'];

const SYNONYMS: Record<string, readonly string[]> = {
  hello: ['hi', 'hey', 'howdy'],
  hi: ['hello', 'hey'],
  thanks: ['thank you', 'cheers'],
  please: ['kindly', 'pls'],
  great: ['awesome', 'excellent'],
  good: ['great', 'nice'],
  buy: ['purchase', 'grab'],
  price: ['cost', 'amount'],
  available: ['in stock', 'on offer'],
  check: ['look at', 'view'],
  start: ['begin', 'kick off'],
  end: ['finish', 'wrap up'],
};

/** Produces a slightly different string on every call. */
export class ContentVariator {
  readonly #cfg: Required<Omit<VariatorOptions, 'custom'>> & { custom?: VariatorOptions['custom'] };
  #counter = 0;

  constructor(options: VariatorOptions = {}) {
    this.#cfg = {
      zeroWidthChars: options.zeroWidthChars ?? true,
      punctuationVariation: options.punctuationVariation ?? true,
      emojiPadding: options.emojiPadding ?? false,
      synonyms: options.synonyms ?? false,
      ...(options.custom ? { custom: options.custom } : {}),
    };
  }

  get count(): number {
    return this.#counter;
  }

  vary(text: string): string {
    this.#counter += 1;
    if (this.#cfg.custom) return this.#cfg.custom(text, this.#counter);

    let result = text;
    if (this.#cfg.synonyms) result = this.#applySynonyms(result);
    if (this.#cfg.zeroWidthChars) result = this.#addZeroWidth(result);
    if (this.#cfg.punctuationVariation) result = this.#varyPunctuation(result);
    if (this.#cfg.emojiPadding) result = this.#addEmojiPadding(result);
    return result;
  }

  varyBulk(text: string, count: number): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < count; i += 1) {
      let next = this.vary(text);
      for (let attempts = 0; seen.has(next) && attempts < 10; attempts += 1) next = this.vary(text);
      seen.add(next);
      out.push(next);
    }
    return out;
  }

  #addZeroWidth(text: string): string {
    const words = text.split(' ');
    if (words.length < 2) return text;
    const positions = new Set<number>();
    const wanted = Math.min(2, words.length - 1);
    while (positions.size < wanted) positions.add(Math.floor(Math.random() * (words.length - 1)));
    return words
      .map((word, i) => (positions.has(i) ? word + ZERO_WIDTH[Math.floor(Math.random() * ZERO_WIDTH.length)] : word))
      .join(' ');
  }

  #varyPunctuation(text: string): string {
    const variations: Array<() => string> = [
      () => text + ' ',
      () => text + '  ',
      () => (text.endsWith('.') ? text.slice(0, -1) : text + '.'),
      () => text,
    ];
    return (variations[this.#counter % variations.length] ?? variations[0])!();
  }

  #addEmojiPadding(text: string): string {
    const emojis = ['', ' 👍', ' ✅', ' 📌', ' 💬'];
    return text + (emojis[this.#counter % emojis.length] ?? '');
  }

  #applySynonyms(text: string): string {
    let replaced = false;
    return text
      .split(/(\b)/)
      .map((word) => {
        if (replaced) return word;
        const list = SYNONYMS[word.toLowerCase()];
        if (!list || Math.random() <= 0.5) return word;
        replaced = true;
        const synonym = list[Math.floor(Math.random() * list.length)] ?? word;
        const first = word[0];
        return first && first === first.toUpperCase() ? synonym.charAt(0).toUpperCase() + synonym.slice(1) : synonym;
      })
      .join('');
  }
}

/* ── legitimacy signals ──────────────────────────────────────────────── */

export interface LegitimacyOptions {
  enableTypos?: boolean;
  /** Per-message chance of a typo. Default 0.025. */
  typoProbability?: number;
  typoCorrectMinMs?: number;
  typoCorrectMaxMs?: number;
  enableReadGaps?: boolean;
  /** Per-reply chance of a long read gap. Default 0.15. */
  readGapProbability?: number;
  readGapMinMs?: number;
  readGapMaxMs?: number;
  enableTypingPauses?: boolean;
  /** Length above which pauses may be injected. Default 50. */
  typingPauseLengthThreshold?: number;
  typingPauseProbability?: number;
  typingPauseMinMs?: number;
  typingPauseMaxMs?: number;
}

export interface TypoInjection {
  typoText: string;
  correctionDelayMs: number;
  correctionText: string;
}

export interface TypingPause {
  afterChars: number;
  pauseDurationMs: number;
}

/** QWERTY neighbours, so a typo is a plausible mis-key rather than noise. */
const QWERTY: Record<string, readonly string[]> = {
  a: ['q', 's', 'w', 'z'], b: ['v', 'g', 'h', 'n'], c: ['x', 'd', 'f', 'v'],
  d: ['s', 'e', 'r', 'f', 'c', 'x'], e: ['w', 'r', 'd', 's'], f: ['d', 'r', 't', 'g', 'v', 'c'],
  g: ['f', 't', 'y', 'h', 'b', 'v'], h: ['g', 'y', 'u', 'j', 'n', 'b'], i: ['u', 'o', 'k', 'j'],
  j: ['h', 'u', 'i', 'k', 'n', 'm'], k: ['j', 'i', 'o', 'l', 'm'], l: ['k', 'o', 'p'],
  m: ['n', 'j', 'k'], n: ['b', 'h', 'j', 'm'], o: ['i', 'p', 'l', 'k'], p: ['o', 'l'],
  q: ['w', 'a'], r: ['e', 't', 'f', 'd'], s: ['a', 'w', 'e', 'd', 'x', 'z'], t: ['r', 'y', 'g', 'f'],
  u: ['y', 'i', 'j', 'h'], v: ['c', 'f', 'g', 'b'], w: ['q', 'e', 's', 'a'], x: ['z', 's', 'd', 'c'],
  y: ['t', 'u', 'h', 'g'], z: ['a', 's', 'x'],
};

const randomBetween = (min: number, max: number): number => Math.floor(Math.random() * (max - min + 1)) + min;

/** Decides when to look imperfect. Pure decisions; the caller sends. */
export class LegitimacySignalInjector {
  readonly #cfg: Required<LegitimacyOptions>;
  #typos = 0;
  #readGaps = 0;
  #typingPauses = 0;

  constructor(options: LegitimacyOptions = {}) {
    this.#cfg = {
      enableTypos: options.enableTypos ?? true,
      typoProbability: options.typoProbability ?? 0.025,
      typoCorrectMinMs: options.typoCorrectMinMs ?? 500,
      typoCorrectMaxMs: options.typoCorrectMaxMs ?? 2_000,
      enableReadGaps: options.enableReadGaps ?? true,
      readGapProbability: options.readGapProbability ?? 0.15,
      readGapMinMs: options.readGapMinMs ?? 300_000,
      readGapMaxMs: options.readGapMaxMs ?? 3_600_000,
      enableTypingPauses: options.enableTypingPauses ?? true,
      typingPauseLengthThreshold: options.typingPauseLengthThreshold ?? 50,
      typingPauseProbability: options.typingPauseProbability ?? 0.4,
      typingPauseMinMs: options.typingPauseMinMs ?? 1_500,
      typingPauseMaxMs: options.typingPauseMaxMs ?? 6_000,
    };
  }

  /**
   * A typo plan for `text`, or null. Never touches URLs, mentions or numbers,
   * and only ever changes one word — a message full of typos reads as broken,
   * not human.
   */
  shouldInjectTypo(text: string): TypoInjection | null {
    if (!this.#cfg.enableTypos || text.length <= 10) return null;
    if (Math.random() >= this.#cfg.typoProbability) return null;
    if (/https?:\/\/|www\./i.test(text)) return null;

    const words = text.split(/\s+/);
    const eligible = words.filter((w) => w.length >= 3 && !w.startsWith('@') && !/^\d+$/.test(w));
    if (eligible.length === 0) return null;

    const target = eligible[Math.floor(Math.random() * eligible.length)]!;
    const typo = this.#typoWord(target);
    if (!typo || typo === target) return null;

    this.#typos += 1;
    return {
      typoText: text.replace(target, typo),
      correctionDelayMs: randomBetween(this.#cfg.typoCorrectMinMs, this.#cfg.typoCorrectMaxMs),
      correctionText: text.length < 30 ? text : `*${target}`,
    };
  }

  /** A long pause before replying, or null. */
  shouldInjectReadGap(): number | null {
    if (!this.#cfg.enableReadGaps || Math.random() >= this.#cfg.readGapProbability) return null;
    this.#readGaps += 1;
    return randomBetween(this.#cfg.readGapMinMs, this.#cfg.readGapMaxMs);
  }

  /** Mid-typing pause positions for a long message. */
  getTypingPauses(messageLength: number): TypingPause[] {
    if (!this.#cfg.enableTypingPauses || messageLength < this.#cfg.typingPauseLengthThreshold) return [];
    if (Math.random() >= this.#cfg.typingPauseProbability) return [];

    const count = Math.random() < 0.6 ? 1 : 2;
    const pauses: TypingPause[] = [];
    for (let i = 0; i < count; i += 1) {
      const ratio = i === 0 ? 0.35 + Math.random() * 0.15 : 0.65 + Math.random() * 0.15;
      pauses.push({
        afterChars: Math.floor(messageLength * ratio),
        pauseDurationMs: randomBetween(this.#cfg.typingPauseMinMs, this.#cfg.typingPauseMaxMs),
      });
      this.#typingPauses += 1;
    }
    return pauses.sort((a, b) => a.afterChars - b.afterChars);
  }

  stats(): Record<string, number> {
    return { typos: this.#typos, readGaps: this.#readGaps, typingPauses: this.#typingPauses };
  }

  reset(): void {
    this.#typos = 0;
    this.#readGaps = 0;
    this.#typingPauses = 0;
  }

  #typoWord(word: string): string | null {
    const chars = [...word];
    const indices = chars
      .map((char, idx) => ({ char: char.toLowerCase(), idx }))
      .filter(({ char }) => QWERTY[char] !== undefined);
    if (indices.length === 0) return null;

    const target = indices[Math.floor(Math.random() * indices.length)]!;
    const neighbours = QWERTY[target.char]!;
    const replacement = neighbours[Math.floor(Math.random() * neighbours.length)]!;
    const original = chars[target.idx]!;
    const replacementChar = original === original.toUpperCase() ? replacement.toUpperCase() : replacement;
    const copy = [...chars];
    copy[target.idx] = replacementChar;
    return copy.join('');
  }
}

/* ── read-receipt variance ───────────────────────────────────────────── */

export interface ReadReceiptVarianceOptions {
  meanMs?: number;
  stdDevMs?: number;
  minMs?: number;
  maxMs?: number;
  /** Skip the delay for messages older than this (backlog). Default 60s. */
  skipIfOlderThanMs?: number;
}

const gaussianUnit = (): number => {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

/**
 * Gaussian-jittered delay for read receipts. `delayMs()` gives a sample;
 * `skip(jidTimestampMs)` decides whether a backlog read should go immediately.
 */
export function readReceiptVariance(options: ReadReceiptVarianceOptions = {}): {
  delayMs: () => number;
  isBacklog: (timestampMs: number, now?: number) => boolean;
} {
  const mean = options.meanMs ?? 1_500;
  const stdDev = options.stdDevMs ?? 800;
  const min = options.minMs ?? 200;
  const max = options.maxMs ?? 8_000;
  const skipIfOlderThan = options.skipIfOlderThanMs ?? 60_000;

  return {
    delayMs: () => Math.max(min, Math.min(max, mean + gaussianUnit() * stdDev)),
    isBacklog: (timestampMs, now = Date.now()) => now - timestampMs > skipIfOlderThan,
  };
}
