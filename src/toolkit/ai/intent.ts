/**
 * AI-4 · intent, entity extraction, and natural language → tool calls.
 *
 * The layer that decides *what the user wants*, independent of any model. It
 * exists because a model is the wrong tool for some jobs: routing a command
 * should not cost a round trip or be able to fail with a 503.
 *
 * Design stance: **pattern rules for routing, model for everything else.**
 * A regex that matches `/ping` will answer `/ping` with no latency and no
 * failure mode, forever. Handing that to a model would be strictly worse.
 */

import { toDigits } from '../ops-250/history-protocol.js';

/* ════════════════════════════════════════════════════════════════════════
   Intent
   ════════════════════════════════════════════════════════════════════════ */

export type IntentKind =
  | 'command'      // a direct instruction with no ambiguity
  | 'question'     // asks for information
  | 'action'       // asks for something to happen
  | 'smalltalk'    // conversational
  | 'help'
  | 'unknown';

export interface Intent {
  kind: IntentKind;
  /** The matched command name, when there was one. */
  command?: string;
  /** Everything after the command. */
  args: string;
  /** 0-1. Low means "not confident enough to act on". */
  confidence: number;
  /** Which rule matched. Present so behaviour is inspectable. */
  rule?: string;
}

export interface Rule {
  name: string;
  /** Must match the start of the message. */
  pattern: RegExp;
  kind: IntentKind;
  /** Fixed confidence. Manual rules are trusted more than heuristics. */
  confidence?: number;
  /** Skip when the text is inside a quote or a code block. */
  requiresBoundary?: boolean;
}

/**
 * The default command prefix.
 *
 * `flux` rather than `/`, because a bare slash is ambiguous in a shared group —
 * someone asking about a filesystem path, or quoting a URL fragment, would trip
 * the matcher. A word prefix cannot collide with ordinary prose.
 *
 * `/` is still accepted so an existing muscle memory keeps working.
 */
export const DEFAULT_PREFIX = 'flux';

/**
 * Build the prefix matcher.
 *
 * Matches `flux ping`, `flux/ping`, and `/ping`, case-insensitively, with an
 * optional colon. Requiring a boundary means `fluxion` is **not** a `flux`
 * command — without that, a word containing the prefix would be swallowed.
 */
export function prefixPattern(prefix: string = DEFAULT_PREFIX): RegExp {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^(?:${escaped}[:/\\s]+|/)(?=\\S)`, 'i');
}

/**
 * Rewrite the default rules for a different prefix.
 *
 * Rewrites the `flux` literal **in the prefix position only** — the leading
 * `(?:flux[:/\s]+|\/)` group — not the first occurrence of the string in the
 * source. Matching `/^flux/` against `^flux[:/\s]+ping` never fires, because the
 * source begins with `^`, not `f`; that anchored version silently returned the
 * default rules unrewritten and every custom prefix appeared broken.
 */
export function rulesWithPrefix(prefix: string = DEFAULT_PREFIX): Rule[] {
  if (prefix === DEFAULT_PREFIX) return DEFAULT_RULES;

  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const from = '(?:flux[:/\\s]+|\\/)';
  const to = `(?:${escaped}[:/\\s]+|\\/)`;

  return DEFAULT_RULES.map((rule) => ({
    ...rule,
    // Replace only the prefix group; the rest of each pattern is hand-authored
    // and must not be regenerated.
    pattern: new RegExp(rule.pattern.source.replace(from, to), rule.pattern.flags),
  }));
}

/**
 * The default command set.
 *
 * Each entry is a real capability the toolkit supports, not a placeholder. A
 * command that exists but does nothing is worse than no command — the user is
 * told it exists and then it does nothing.
 *
 * Patterns are written against the prefix generically and rewritten by
 * `rulesWithPrefix()`, so changing the prefix does not mean editing 25 regexes.
 */
export const DEFAULT_RULES: Rule[] = [
  // ── meta ──────────────────────────────────────────────────────────
  { name: 'ping', pattern: /^(?:flux[:/\s]+|\/)ping\b/i, kind: 'command', confidence: 1 },
  { name: 'help', pattern: /^(?:flux[:/\s]+|\/)(?:help|commands|list)\b/i, kind: 'command', confidence: 1 },
  { name: 'cancel', pattern: /^(?:flux[:/\s]+|\/)(?:cancel|stop)\b/i, kind: 'command', confidence: 1 },
  { name: 'reset', pattern: /^(?:flux[:/\s]+|\/)reset\b/i, kind: 'command', confidence: 1 },

  // ── memory ────────────────────────────────────────────────────────
  { name: 'remember', pattern: /^(?:flux[:/\s]+|\/)remember\s+(.+)$/is, kind: 'command', confidence: 1 },
  { name: 'forget', pattern: /^(?:flux[:/\s]+|\/)forget\s+(.+)$/is, kind: 'command', confidence: 1 },
  { name: 'recall', pattern: /^(?:flux[:/\s]+|\/)(?:recall|what.*know)\b/i, kind: 'command', confidence: 1 },

  // ── identity ─────────────────────────────────────────────────────
  { name: 'id', pattern: /^(?:flux[:/\s]+|\/)id\b/i, kind: 'command', confidence: 1 },
  { name: 'time', pattern: /^(?:flux[:/\s]+|\/)time\b/i, kind: 'command', confidence: 1 },
  { name: 'whoami', pattern: /^(?:flux[:/\s]+|\/)whoami\b/i, kind: 'command', confidence: 1 },

  // ── lookup ───────────────────────────────────────────────────────
  { name: 'check', pattern: /^(?:flux[:/\s]+|\/)check\s+(.+)$/i, kind: 'command', confidence: 1 },
  { name: 'resolve', pattern: /^(?:flux[:/\s]+|\/)resolve\s+(.+)$/i, kind: 'command', confidence: 1 },

  // ── output ────────────────────────────────────────────────────────
  // These use bare `\b` with no capture group, so `detectIntent` takes the
  // remainder of the line as args. A capture group here would swallow nothing.
  { name: 'poll', pattern: /^(?:flux[:/\s]+|\/)poll\b/i, kind: 'command', confidence: 1 },
  { name: 'list', pattern: /^(?:flux[:/\s]+|\/)list\b/i, kind: 'command', confidence: 1 },
  { name: 'buttons', pattern: /^(?:flux[:/\s]+|\/)buttons\b/i, kind: 'command', confidence: 1 },
  { name: 'note', pattern: /^(?:flux[:/\s]+|\/)note\b/i, kind: 'command', confidence: 1 },

  // ── multi-step ───────────────────────────────────────────────────
  // Present so `slotSpecs` can be attached to them. Without a rule here,
  // `flux remind` classifies as `unknown`, never reaches the slot logic, and the
  // multi-turn flow can never start.
  { name: 'remind', pattern: /^(?:flux[:/\s]+|\/)remind\b/i, kind: 'command', confidence: 1 },
  { name: 'search', pattern: /^(?:flux[:/\s]+|\/)search\b/i, kind: 'command', confidence: 1 },
  { name: 'transfer', pattern: /^(?:flux[:/\s]+|\/)transfer\b/i, kind: 'command', confidence: 1 },

  // ── media ─────────────────────────────────────────────────────────
  { name: 'download', pattern: /^(?:flux[:/\s]+|\/)(?:download|dl|get)\s+(.+)$/is, kind: 'command', confidence: 1 },
  { name: 'transcribe', pattern: /^(?:flux[:/\s]+|\/)(?:transcribe|stt)\b/i, kind: 'command', confidence: 0.8 },

  // ── questions ─────────────────────────────────────────────────────
  { name: 'what', pattern: /^(?:what|who|where|when|why|how)\b/i, kind: 'question', confidence: 0.7 },
  { name: 'is', pattern: /^(?:is|are|does|do|did|can|will|would|should)\b/i, kind: 'question', confidence: 0.6 },
  { name: 'help-request', pattern: /\b(?:help|how do i|what can you)\b/i, kind: 'help', confidence: 0.7 },
];

/**
 * Strip fences and quotes so a pasted code block is not mistaken for a command.
 *
 * A quoted block is replaced with a space rather than deleted. Deleting it made
 * `'```\n/ping\n```'` normalise to an empty string, which then classified as
 * `unknown` — so a paste of `/ping` was neither honoured nor correctly
 * recognised as smalltalk. A space keeps the surrounding text measurable.
 */
export function normaliseInput(text: string): string {
  // Fences are replaced with a marker rather than deleted. Deleting the block
  // left `'```\n/ping\n```'` normalising to an empty string, which then
  // classified as `unknown` — so a paste of `/ping` was neither honoured nor
  // correctly recognised as conversational. The marker keeps the message
  // non-empty and keeps its command words out of the rule matcher.
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' [quoted block] ')
    .trim();
}

/**
 * Classify a message.
 *
 * Order matters: the first matching rule wins, so specific commands must be
 * listed before generic question patterns. `DEFAULT_RULES` is ordered that way.
 */
export function detectIntent(text: string, rules: Rule[] = DEFAULT_RULES): Intent {
  const clean = normaliseInput(text);
  if (!clean) return { kind: 'unknown', args: '', confidence: 0 };

  for (const rule of rules) {
    const match = rule.pattern.exec(clean);
    if (!match) continue;

    // A rule with a capture group names its own args. A rule *without* one —
    // one that only matched the prefix — has no group, and using `match[1]` for
    // those returned an empty string, so `flux poll Best fruit` arrived with
    // nothing after it. Fall back to whatever followed the matched text.
    const args = match[1] !== undefined
      ? match[1]
      : clean.slice(match[0].length).trim();

    return {
      kind: rule.kind,
      command: rule.name,
      args: args.trim(),
      confidence: rule.confidence ?? 0.5,
      rule: rule.name,
    };
  }

  // No rule matched. "send it to X" is an action; "thanks" is smalltalk.
  if (/^\s*(?:thanks|thank you|ok|okay|cool|nice|great|hi|hey|hello|yo)\b/i.test(clean)) {
    return { kind: 'smalltalk', args: clean, confidence: 0.5, rule: 'smalltalk' };
  }

  if (/\b(?:send|make|create|add|delete|remove|find|get|set|do)\b/i.test(clean)) {
    return { kind: 'action', args: clean, confidence: 0.5, rule: 'imperative' };
  }

  if (clean.includes('?')) {
    return { kind: 'question', args: clean, confidence: 0.55, rule: 'question-mark' };
  }

  return { kind: 'unknown', args: clean, confidence: 0.2 };
}

/* ════════════════════════════════════════════════════════════════════════
   Entities
   ════════════════════════════════════════════════════════════════════════ */

export interface Entities {
  /** Phone numbers, normalised to bare digits with the country code included. */
  phones: string[];
  /** URLs, http(s) only. */
  urls: string[];
  /** Jids, if the user pasted one. */
  jids: string[];
  /** @mentions and their numeric ids. */
  mentions: string[];
  /** ISO-ish dates found in the text. */
  dates: string[];
  /** Currency amounts found. */
  amounts: number[];
  /** Quoted spans, for "what did they mean by X". */
  quotes: string[];
}

const PHONE = /(?:\+?\d[\d\s().-]{6,}\d)/g;
const URL = /\bhttps?:\/\/[^\s<>"]+/gi;
const JID = /[\w.+-]+@[\w.-]+/g;
const MENTION = /@(\d{5,})/g;
const DATE = /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2})\b/g;
const AMOUNT = /(?:^|[^\w])(\d+(?:[.,]\d{1,2})?)\s*(?:idr|rp|usd|eur|gbp|sgd|myr|php|thb|try|brl|mxn|zar|aud|cad)\b/gi;
const QUOTED = /["“”']([^"“”']{3,})["“”']/g;

/**
 * Extract entities from text.
 *
 * Everything is normalised so downstream code never re-parses. The phone regex
 * is the risky one — it also matches dates and long numbers — so results are
 * filtered by plausible E.164 length and a non-zero leading digit.
 */
export function extractEntities(text: string): Entities {
  const source = String(text ?? '');

  const phones = [...source.matchAll(PHONE)]
    .map((m) => toDigits(m[0]))
    .filter((d) => d.length >= 8 && d.length <= 15 && d[0] !== '0');

  const amounts = [...source.matchAll(AMOUNT)]
    .map((m) => Number(String(m[1]).replace(',', '.')))
    .filter((n) => Number.isFinite(n));

  return {
    phones: [...new Set(phones)],
    urls: [...new Set([...source.matchAll(URL)].map((m) => m[0]))],
    jids: [...new Set([...source.matchAll(JID)].map((m) => m[0]))],
    mentions: [...new Set([...source.matchAll(MENTION)].map((m) => m[1] ?? ''))].filter(Boolean),
    dates: [...new Set([...source.matchAll(DATE)].map((m) => m[0]))],
    amounts: [...new Set(amounts)],
    quotes: [...new Set([...source.matchAll(QUOTED)].map((m) => m[1] ?? ''))].filter(Boolean),
  };
}

/* ════════════════════════════════════════════════════════════════════════
   Language
   ════════════════════════════════════════════════════════════════════════ */

export type Lang = 'en' | 'id' | 'es' | 'pt' | 'fr' | 'de' | 'zh' | 'ja' | 'unknown';

/** Cheap script and stopword detection. Not a language ID model. */
export function detectLanguage(text: string): Lang {
  const s = String(text ?? '');
  if (!s.trim()) return 'unknown';

  // Script detection is reliable where it applies.
  if (/[\u3040-\u30ff]/.test(s)) return 'ja';
  if (/[\u4e00-\u9fff]/.test(s)) return 'zh';
  if (/[\u0600-\u06ff]/.test(s)) return 'unknown';

  const words = s.toLowerCase().split(/\W+/).filter(Boolean);
  if (words.length === 0) return 'unknown';

  const markers: Record<Lang, string[]> = {
    id: ['yang', 'dan', 'untuk', 'dengan', 'saya', 'apa', 'tidak', 'ini', 'itu', 'dari', 'akan', 'bisa'],
    es: ['el', 'la', 'los', 'las', 'que', 'de', 'para', 'con', 'qué', 'como', 'está'],
    pt: ['o', 'a', 'os', 'as', 'que', 'de', 'para', 'com', 'você', 'não', 'está'],
    fr: ['le', 'la', 'les', 'des', 'pour', 'avec', 'que', 'est', 'une', 'vous'],
    de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'mit', 'für', 'ich', 'sie'],
    en: ['the', 'is', 'and', 'to', 'of', 'in', 'it', 'you', 'that', 'for'],
    zh: [], ja: [], unknown: [],
  };

  let best: Lang = 'unknown';
  let bestScore = 0;

  for (const [lang, list] of Object.entries(markers) as Array<[Lang, string[]]>) {
    if (list.length === 0) continue;
    const score = words.filter((w) => list.includes(w)).length;
    // Require at least two markers — one common word is not a language.
    if (score > bestScore && score >= 2) {
      bestScore = score;
      best = lang;
    }
  }

  return best;
}

/** A locale-aware greeting. Small, but it is what people notice first. */
export function greeting(lang: Lang, hourUtc = new Date().getUTCHours()): string {
  const partOfDay = hourUtc < 5 ? 'night' : hourUtc < 12 ? 'morning' : hourUtc < 18 ? 'afternoon' : 'evening';

  const table: Record<string, Partial<Record<string, string>>> = {
    en: { morning: 'Good morning', afternoon: 'Good afternoon', evening: 'Good evening', night: 'Hello' },
    id: { morning: 'Selamat pagi', afternoon: 'Selamat siang', evening: 'Selamat malam', night: 'Halo' },
    es: { morning: 'Buenos días', afternoon: 'Buenas tardes', evening: 'Buenas noches', night: 'Hola' },
    pt: { morning: 'Bom dia', afternoon: 'Boa tarde', evening: 'Boa noite', night: 'Olá' },
    fr: { morning: 'Bonjour', afternoon: 'Bon après-midi', evening: 'Bonsoir', night: 'Bonsoir' },
    de: { morning: 'Guten Morgen', afternoon: 'Guten Tag', evening: 'Guten Abend', night: 'Hallo' },
    zh: { morning: '早上好', afternoon: '下午好', evening: '晚上好', night: '你好' },
    ja: { morning: 'おはよう', afternoon: 'こんにちは', evening: 'こんばんは', night: 'こんにちは' },
  };

  return table[lang]?.[partOfDay] ?? table.en?.[partOfDay] ?? 'Hello';
}

/* ════════════════════════════════════════════════════════════════════════
   Sentiment and tone
   ════════════════════════════════════════════════════════════════════════ */

export interface Tone {
  sentiment: 'positive' | 'negative' | 'neutral';
  /** 0-1. How strongly the user feels something. */
  intensity: number;
  /** True when frustration is present — worth routing to a human. */
  frustrated: boolean;
}

const POSITIVE = /\b(great|thanks|thank you|perfect|awesome|love|excellent|brilliant|helpful|amazing|good|nice)\b/gi;
const NEGATIVE = /\b(bad|terrible|awful|broken|fails?|failed|wrong|useless|hate|stupid|slow|bug|crash|error)\b/gi;
const FRUSTRATED = /\b(again|still|not working|doesn'?t work|never|always|seriously|for the \w+ time|ridiculous)\b/gi;

/**
 * Cheap tone read.
 *
 * Frustration gets its own flag because it is the one signal worth acting on:
 * a user who says "it doesn't work again" wants a human or a real fix, not a
 * cheerful reply. A model will sometimes paper over that; this will not.
 */
export function readTone(text: string): Tone {
  const s = String(text ?? '');

  const pos = (s.match(POSITIVE) ?? []).length;
  const neg = (s.match(NEGATIVE) ?? []).length;
  const frust = (s.match(FRUSTRATED) ?? []).length;

  const total = pos + neg + frust;
  const intensity = Math.min(1, total / 3);

  const sentiment = neg > pos ? 'negative' : pos > neg ? 'positive' : 'neutral';

  return {
    sentiment,
    intensity,
    frustrated: frust > 0 || (neg >= 2 && neg > pos),
  };
}

/* ════════════════════════════════════════════════════════════════════════
   Slot filling
   ════════════════════════════════════════════════════════════════════════ */

export interface SlotSpec {
  name: string;
  /** Matches a value for this slot. */
  pattern: RegExp;
  required: boolean;
  /** Shown to the user when the slot is missing. */
  prompt: string;
}

export interface FilledSlots {
  values: Record<string, string>;
  missing: string[];
  /** True when everything required was captured. */
  complete: boolean;
  /** Questions to ask, in slot order. */
  asks: string[];
}

/**
 * Fill slots from a message, or work out what to ask for.
 *
 * The alternative — asking the user to rephrase — is the single biggest cause
 * of a bot feeling obtuse. Missing-slot prompting is unglamorous and it is most
 * of the difference.
 */
export function fillSlots(
  message: string,
  specs: SlotSpec[],
  existing: Record<string, string> = {},
): FilledSlots {
  const values: Record<string, string> = { ...existing };

  for (const spec of specs) {
    // An already-captured value is not re-requested, and not overwritten.
    if (values[spec.name]) continue;

    const match = spec.pattern.exec(message);
    if (match) {
      values[spec.name] = (match[1] ?? match[0]).trim();
      continue;
    }
    if (spec.required) values[spec.name] = '';
  }

  const missing = specs
    .filter((s) => s.required && !values[s.name])
    .map((s) => s.name);

  return {
    values,
    missing,
    complete: missing.length === 0,
    asks: specs.filter((s) => s.required && !values[s.name]).map((s) => s.prompt),
  };
}

/** Common slot sets, so callers do not reinvent them. */
export const SLOT_SPECS = {
  // Slot patterns are **non-greedy** and stop before the next clause marker.
  // A greedy `(.+)$` on "at 5pm about the report" captures the whole sentence,
  // so `when` comes back as "5pm about the report" and nothing downstream can
  // use it.
  reminder: [
    { name: 'when', pattern: /\b(?:at|on|by)\s+([^,;]+?)(?=\s+(?:about|to|for)\b|[,;]|$)/i, required: true, prompt: 'When should I remind you?' },
    { name: 'what', pattern: /\babout\s+([^,;]+?)(?=\s+(?:at|on|by)\b|[,;]|$)/i, required: true, prompt: 'What should I remind you about?' },
  ],
  search: [
    { name: 'query', pattern: /\bfor\s+(.+)$/i, required: true, prompt: 'What should I search for?' },
  ],
  transfer: [
    { name: 'amount', pattern: /\b(\d[\d.,]*)\b/, required: true, prompt: 'How much?' },
    { name: 'to', pattern: /\bto\s+([\w.+-]+@[\w.-]+)\b/, required: true, prompt: 'Send it to which number?' },
  ],
} satisfies Record<string, SlotSpec[]>;

/**
 * A tiny state machine for multi-step conversations.
 *
 * Held in memory per chat, expires on its own, and clears on completion. The
 * timeout is the important part: a half-finished slot flow that never expires
 * will hijack a conversation an hour later.
 */
export class PendingFlow {
  private flows = new Map<string, { values: Record<string, string>; specs: SlotSpec[]; at: number }>();

  constructor(private readonly ttlMs = 5 * 60_000) {}

  start(chatId: string, specs: SlotSpec[], existing: Record<string, string> = {}): FilledSlots {
    const filled = fillSlots('', specs, existing);
    this.flows.set(chatId, { values: filled.values, specs, at: Date.now() });
    return filled;
  }

  /** Feed a reply into a pending flow. Null when nothing is pending or it expired. */
  advance(chatId: string, message: string): FilledSlots | null {
    const flow = this.flows.get(chatId);
    if (!flow) return null;

    if (Date.now() - flow.at > this.ttlMs) {
      this.flows.delete(chatId);
      return null;
    }

    const filled = fillSlots(message, flow.specs, flow.values);

    if (filled.complete) {
      this.flows.delete(chatId);
    } else {
      this.flows.set(chatId, { values: filled.values, specs: flow.specs, at: Date.now() });
    }

    return filled;
  }

  cancel(chatId: string): boolean {
    return this.flows.delete(chatId);
  }

  get pending(): number {
    return this.flows.size;
  }

  /** Drop expired flows. Call periodically. */
  sweep(): number {
    const cutoff = Date.now() - this.ttlMs;
    let removed = 0;
    for (const [id, flow] of this.flows) {
      if (flow.at < cutoff) {
        this.flows.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}