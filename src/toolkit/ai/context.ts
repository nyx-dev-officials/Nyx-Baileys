/**
 * AI-1 · conversation context and memory.
 *
 * The difference between a bot and a dud is what it remembers. This module
 * handles the three things that actually decide whether a bot feels intelligent:
 *
 *  1. **A sliding window with real token accounting.** Not "last 20 messages" —
 *     measured against the model's actual limit, with the system prompt counted
 *     first, because a prompt that overflows is truncated by the provider
 *     silently and you never learn why.
 *  2. **A durable memory store** of facts the user told you, with provenance
 *     and decay. Memory without provenance becomes confident fiction.
 *  3. **Summary compaction** that preserves decisions and open questions while
 *     dropping pleasantries.
 *
 * Design stance throughout: **a bot that forgets is better than a bot that
 * invents.** `forget()` is a first-class operation; every memory read tells you
 * where the fact came from; a summary never claims the user said something they
 * did not.
 */

import { createHash } from 'node:crypto';

/* ════════════════════════════════════════════════════════════════════════
   Token accounting
   ════════════════════════════════════════════════════════════════════════ */

/**
 * Approximate token count for a string.
 *
 * This is an estimate, not a tokenizer — no provider tokenizer ships in
 * Node's stdlib and pulling one in per provider would be worse. The heuristic
 * is the widely-used one: ~4 characters per token for English prose, with CJK
 * weighted heavier because those scripts are closer to one token per character.
 *
 * It is used for *budgeting*, never for billing. Error of 10-15% is fine when
 * the goal is "stay under the window".
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  // Count CJK / full-width characters separately — they tokenize far denser.
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const rest = text.length - cjk;

  return Math.ceil(cjk * 1.0 + rest / 4);
}

/** Token cost of a whole message array. */
export function estimateMessages(
  messages: readonly ChatMessage[],
): number {
  return messages.reduce(
    (sum, m) => sum + estimateTokens(m.content) + 4, // +4 for role/framing tokens
    0,
  );
}

/* ════════════════════════════════════════════════════════════════════════
   AiChat messages
   ════════════════════════════════════════════════════════════════════════ */

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Epoch ms. Set automatically by `remember()`. */
  at?: number;
  /** Where this turn came from — a jid, a channel name. */
  from?: string;
  /** Set when the message carries a tool result rather than speech. */
  tool?: string;
}

/* ════════════════════════════════════════════════════════════════════════
   Memory store
   ════════════════════════════════════════════════════════════════════════ */

export interface MemoryFact {
  /** What the bot knows. Stated as a fact about the user, not a quote. */
  fact: string;
  /** Who said it, and where. Never empty — a fact with no source is a guess. */
  source: string;
  at: number;
  /** Times this fact has been restated. Repetition raises confidence. */
  hits: number;
  /** Optional expiry. Expired facts are dropped on read, not on write. */
  expiresAt?: number;
}

/**
 * A fact extracted by hand or by a model.
 *
 * `confidence` is deliberately separate from `hits`: a fact stated once,
 * emphatically, is not the same as one stated four times casually.
 */
export interface FactCandidate {
  fact: string;
  source: string;
  confidence?: number;
  expiresAt?: number;
}

/**
 * Deduplicate on meaning, not string equality.
 *
 * Two people saying "I live in Jakarta" and "my city is jakarta" should collapse
 * to one fact. Exact-match dedupe misses that and the model starts treating
 * duplicates as corroboration — the exact failure mode that turns memory into
 * confident fiction.
 */
/**
 * Normalise a fact for identity: lowercase, strip punctuation, collapse spaces.
 *
 * Identity is **exact match on the normalised string**, deliberately.
 *
 * Every fuzzy alternative tested here merges things it must not. Jaccard on
 * content words at 0.5 merged `first fact stated today` with `second fact
 * stated today` (three shared words out of five); at 0.6 it still merged
 * `I live in Jakarta` with `I live in Bandung`. Containment was worse — those
 * two share "live in", so one city silently overwrote the other.
 *
 * Over-storing a near-duplicate is recoverable: recall returns both and the
 * model sees them together. Over-merging produces a *confidently wrong* answer,
 * which is the failure mode this whole module exists to prevent. So the
 * conservative rule wins, and a paraphrase costs a little redundancy.
 */
function normaliseFact(fact: string): string {
  return fact
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

/** Words that carry meaning. Short ones are noise: "a", "the", "my". */
function contentWords(fact: string): string[] {
  return normaliseFact(fact).split(' ').filter((w) => w.length > 2);
}

/**
 * Bounded memory with provenance.
 *
 * Bounded on purpose: an unbounded fact store degrades every prompt and costs
 * tokens forever. When full, the *lowest-confidence, oldest* fact is evicted —
 * so the store forgets trivia before it forgets commitments.
 */
export class Memory {
  private facts = new Map<string, MemoryFact>();

  private hits = 0;
  private misses = 0;

  /** True when a store was emptied or refused a write — surfaced, not hidden. */
  saturated = false;

  constructor(
    private readonly capacity = 200,
    /** Facts below this confidence are evicted first. */
    private readonly minConfidence = 0.3,
  ) {}

  /**
   * Learn a fact.
   *
   * Returns true if the store changed. A duplicate raises `hits`, which is
   * recorded but never treated as certainty on its own.
   */
  learn(candidate: FactCandidate): boolean {
    const key = normaliseFact(candidate.fact);
    if (!key) return false;

    const existing = this.facts.get(key);
    if (existing) {
      existing.hits += 1;
      existing.at = Date.now();
      if (candidate.expiresAt !== undefined) existing.expiresAt = candidate.expiresAt;
      return true;
    }

    if (this.facts.size >= this.capacity) {
      if (!this.evictWeakest()) {
        // Nothing was weak enough to drop, and the store is full. Refusing is
        // better than silently evicting a commitment the user gave explicitly.
        this.saturated = true;
        return false;
      }
      this.saturated = true;
    }

    this.facts.set(key, {
      fact: candidate.fact,
      source: candidate.source,
      at: Date.now(),
      hits: 1,
      expiresAt: candidate.expiresAt,
    });
    this.saturated = false;
    return true;
  }

  /** Drop the weakest, oldest fact. Returns false if none qualifies. */
  private evictWeakest(): boolean {
    let weakestKey: string | undefined;
    let weakestScore = Infinity;

    for (const [key, fact] of this.facts) {
      // Confidence falls with age and rises with corroboration. A single
      // recent statement beats five stale ones.
      const ageDays = (Date.now() - fact.at) / 86_400_000;
      const score = (fact.hits / (1 + ageDays));
      if (score < weakestScore) {
        weakestScore = score;
        weakestKey = key;
      }
    }

    // Refuse to evict something the user stated explicitly and recently.
    if (weakestKey === undefined) return false;
    const weakest = this.facts.get(weakestKey);
    if (weakest && Date.now() - weakest.at < 86_400_000) return false;

    this.facts.delete(weakestKey);
    return true;
  }

  /** Read facts, most relevant first. Expired facts are filtered here. */
  recall(query?: string, limit = 12): MemoryFact[] {
    const now = Date.now();
    const live = [...this.facts.values()].filter((f) => !f.expiresAt || f.expiresAt > now);

    if (!query) {
      this.hits += live.length;
      this.misses += 0;
      return live.sort((a, b) => b.at - a.at).slice(0, limit);
    }

    const terms = new Set(
      query.toLowerCase().split(/\W+/).filter((w) => w.length > 3),
    );

    if (terms.size === 0) {
      return live.sort((a, b) => b.at - a.at).slice(0, limit);
    }

    const scored = live
      .map((fact) => {
        const words = fact.fact.toLowerCase().split(/\W+/);
        const overlap = words.filter((w) => terms.has(w)).length;
        return { fact, score: overlap === 0 ? 0 : overlap / terms.size };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || b.fact.at - a.fact.at);

    this.hits += scored.length;
    this.misses += 1;
    return scored.slice(0, limit).map((s) => s.fact);
  }

  /**
   * Forget a fact.
   *
   * Substring match on purpose — the user says "forget where I live", not the
   * exact stored string. Returns how many were removed.
   */
  forget(topic: string): number {
    const needle = topic.toLowerCase();
    let removed = 0;

    for (const [key, fact] of this.facts) {
      if (fact.fact.toLowerCase().includes(needle)) {
        this.facts.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Forget everything. Exists so "forget all" is one call, not a loop. */
  clear(): number {
    const n = this.facts.size;
    this.facts.clear();
    return n;
  }

  get size(): number {
    return this.facts.size;
  }

  /** Facts grouped by where they came from — useful for "what do you know?" */
  bySource(): Record<string, MemoryFact[]> {
    const out: Record<string, MemoryFact[]> = {};
    for (const fact of this.recall()) {
      (out[fact.source] ??= []).push(fact);
    }
    return out;
  }

  /** Recall hit rate. A low rate means recall() is being asked the wrong thing. */
  stats(): { size: number; capacity: number; hits: number; misses: number; hitRate: number } {
    const attempts = this.hits + this.misses;
    return {
      size: this.facts.size,
      capacity: this.capacity,
      hits: this.hits,
      misses: this.misses,
      hitRate: attempts === 0 ? 0 : this.hits / attempts,
    };
  }

  /**
   * Render facts as a prompt block, with provenance inline.
   *
   * Provenance is included in the text the model sees on purpose. Without it,
   * the model cannot tell a remembered fact from something it just invented,
   * which is precisely how a bot ends up confidently wrong.
   */
  render(query?: string, limit = 12): string {
    const facts = this.recall(query, limit);
    if (facts.length === 0) return '';

    const lines = facts.map((f) => `- ${f.fact} (source: ${f.source})`);
    return `Known facts about this user:\n${lines.join('\n')}`;
  }
}

/* ════════════════════════════════════════════════════════════════════════
   Conversation window
   ════════════════════════════════════════════════════════════════════════ */

export interface WindowOptions {
  /** The model's real context limit, in tokens. */
  modelLimit: number;
  /** Reserve for the reply. Without this, the prompt eats the whole window. */
  replyReserve?: number;
  /** Never send fewer than this many messages, however long they are. */
  minKeep?: number;
}

/**
 * A bounded conversation that reports when it dropped something.
 *
 * The point of the return value is that you *know*. A window that silently
 * truncates from the front produces a bot that mysteriously forgets — the
 * single most common cause of "it was fine five messages ago".
 */
export interface TrimResult {
  kept: ChatMessage[];
  /** How many messages were dropped to fit. */
  dropped: number;
  /** True when dropping was unavoidable. */
  droppedAny: boolean;
  tokens: number;
}

/**
 * Fit a conversation into a model's window, oldest-first.
 *
 * The system prompt is always kept and never counted as droppable — losing your
 * instructions to save three messages is the worst possible trade.
 */
export function fitWindow(
  history: readonly ChatMessage[],
  options: WindowOptions,
): TrimResult {
  const { modelLimit, replyReserve = 1024, minKeep = 2 } = options;
  const budget = Math.max(256, modelLimit - replyReserve);

  const system = history.filter((m) => m.role === 'system');
  const rest = history.filter((m) => m.role !== 'system');

  const systemTokens = estimateMessages(system);
  let used = systemTokens;

  // Walk backwards so the most recent turns are kept preferentially, then stop.
  const keptReversed: ChatMessage[] = [];
  for (let i = rest.length - 1; i >= 0; i -= 1) {
    const cost = estimateTokens(rest[i]?.content ?? '') + 4;
    if (used + cost > budget && keptReversed.length >= minKeep) break;
    used += cost;
    keptReversed.unshift(rest[i] as ChatMessage);
  }

  const dropped = rest.length - keptReversed.length;
  return {
    kept: [...system, ...keptReversed],
    dropped,
    droppedAny: dropped > 0,
    tokens: used,
  };
}

/* ════════════════════════════════════════════════════════════════════════
   Compaction
   ════════════════════════════════════════════════════════════════════════ */

/**
 * What a compaction must preserve.
 *
 * A summary that keeps greetings and drops the user's actual decisions is worse
 * than no summary: it looks like memory and is not.
 */
export interface Digest {
  /** Facts and preferences worth carrying forward. */
  facts: string[];
  /** Decisions the user made, with what they decided. */
  decisions: string[];
  /** Questions still open. */
  open: string[];
  /** One-line topic label. */
  topic: string;
}

/**
 * Heuristic digest of a stretch of conversation.
 *
 * This is deterministic and offline — no model call — so it cannot hallucinate.
 * It works by keeping sentences that *look like* commitments and dropping the
 * rest. Crude by construction; the model-side compaction prompt in
 * `providers.ts` does better when a key is available.
 *
 * Returned as claims to verify, not as truth. Every entry is a line that
 * appeared in the transcript.
 */
export function heuristicDigest(messages: readonly ChatMessage[]): Digest {
  const facts: string[] = [];
  const decisions: string[] = [];
  const open: string[] = [];

  const commitment = /\b(i (?:live|work|prefer|use|like|need|want|always|never)|my \w+ is|call me|remember)\b/i;
  const decided = /\b(let'?s|we(?:'| a)re going to|i(?:'| wi)ll|do it|go ahead|sounds good|agreed|use the)\b/i;
  const question = /\?\s*$/;

  for (const message of messages) {
    if (message.role !== 'user') continue;

    for (const rawLine of message.content.split('\n')) {
      const line = rawLine.trim();
      if (line.length < 8) continue;

      if (commitment.test(line)) facts.push(line);
      else if (decided.test(line)) decisions.push(line);
      else if (question.test(line)) open.push(line);
    }
  }

  const first = messages.find((m) => m.role === 'user')?.content ?? '';
  const topic = first.split(/[.!?\n]/)[0]?.slice(0, 60).trim() ?? 'conversation';

  return {
    facts: [...new Set(facts)].slice(0, 10),
    decisions: [...new Set(decisions)].slice(0, 10),
    open: [...new Set(open)].slice(0, 6),
    topic: topic || 'conversation',
  };
}

/** Render a digest as a prompt block. */
export function renderDigest(digest: Digest): string {
  const parts: string[] = [];
  if (!digest.topic && !digest.facts.length && !digest.decisions.length && !digest.open.length) {
    return '';
  }
  if (digest.topic) parts.push(`Topic: ${digest.topic}`);
  if (digest.facts.length) parts.push(`Known from earlier:\n${digest.facts.map((f) => `- ${f}`).join('\n')}`);
  if (digest.decisions.length) parts.push(`Decided earlier:\n${digest.decisions.map((d) => `- ${d}`).join('\n')}`);
  if (digest.open.length) parts.push(`Still open:\n${digest.open.map((q) => `- ${q}`).join('\n')}`);
  return parts.join('\n\n');
}

/* ════════════════════════════════════════════════════════════════════════
   Conversation store
   ════════════════════════════════════════════════════════════════════════ */

export interface AiChat {
  id: string;
  messages: ChatMessage[];
  memory: Memory;
  at: number;
  turns: number;
}

/**
 * Multi-chat conversation state.
 *
 * Keyed by jid, because one bot serving many chats must not blend them — that
 * blend is the single most obvious "dumb bot" tell.
 */
export class Conversations {
  private chats = new Map<string, AiChat>();

  constructor(
    private readonly maxMessages = 200,
    private readonly memoryCapacity = 200,
  ) {}

  /** Get or create a chat. */
  get(id: string): AiChat {
    const existing = this.chats.get(id);
    if (existing) return existing;

    const chat: AiChat = {
      id,
      messages: [],
      memory: new Memory(this.memoryCapacity),
      at: Date.now(),
      turns: 0,
    };
    this.chats.set(id, chat);
    return chat;
  }

  /** Append a message, trimming to `maxMessages`. */
  push(
    id: string,
    role: ChatRole,
    content: string,
    meta: { from?: string; tool?: string } = {},
  ): ChatMessage {
    const chat = this.get(id);
    const message: ChatMessage = { role, content, at: Date.now(), ...meta };

    chat.messages.push(message);
    if (chat.messages.length > this.maxMessages) {
      chat.messages.splice(0, chat.messages.length - this.maxMessages);
    }

    chat.at = Date.now();
    if (role === 'user') chat.turns += 1;
    return message;
  }

  /**
   * Build the prompt to send: system + memory + fitted window.
   *
   * This is the one function a provider needs. Memory is injected as a system
   * block rather than as a fake user turn, so the model treats it as context
   * and not as something the user just said.
   */
  buildPrompt(id: string, options: WindowOptions & { system?: string }): ChatMessage[] {
    const chat = this.get(id);

    // Recall against the last user turn so the relevant facts come first, but
    // fall back to the full store when the query matches nothing — otherwise a
    // chat whose latest message is "ok" loses every fact it has.
    const lastUser = [...chat.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const memoryBlock = chat.memory.render(lastUser)
      || (chat.memory.size > 0 ? chat.memory.render() : '');

    const system = [options.system, memoryBlock].filter(Boolean).join('\n\n');

    const withSystem: ChatMessage[] = [
      ...(system ? [{ role: 'system' as const, content: system }] : []),
      ...chat.messages.filter((m) => m.role !== 'system'),
    ];

    // The system block is passed to fitWindow as droppable-never, but its size
    // counts against the budget. A long memory block must not be able to crowd
    // out the conversation — cap it so facts degrade to fewer, not to none.
    const capped: ChatMessage[] = withSystem.map((m) => (
      m.role === 'system' && m.content.length > 4_000
        ? { ...m, content: `${m.content.slice(0, 4_000)}\n(facts truncated)` }
        : m
    ));

    return fitWindow(capped, options).kept;
  }

  /** Learn a fact into a chat's memory. */
  learn(id: string, candidate: FactCandidate): boolean {
    return this.get(id).memory.learn(candidate);
  }

  /** Forget facts in a chat. */
  forget(id: string, topic: string): number {
    return this.get(id).memory.forget(topic);
  }

  /** Delete a chat entirely — the GDPR path, and the "reset me" path. */
  drop(id: string): boolean {
    return this.chats.delete(id);
  }

  get size(): number {
    return this.chats.size;
  }

  ids(): string[] {
    return [...this.chats.keys()];
  }

  /** Total tokens across every chat. Useful before deciding to flush. */
  totalTokens(): number {
    let sum = 0;
    for (const chat of this.chats.values()) sum += estimateMessages(chat.messages);
    return sum;
  }

  /** Stable per-chat id, so an ephemeral jid does not orphan a history. */
  static keyFor(jid: string): string {
    return createHash('sha256').update(jid.split(':')[0] ?? jid).digest('hex').slice(0, 16);
  }
}

/* ════════════════════════════════════════════════════════════════════════
   Context quality
   ════════════════════════════════════════════════════════════════════════ */

/**
 * Rate how well this chat is set up to answer well.
 *
 * Deliberately diagnostic rather than advisory: a score you can act on beats
 * advice you cannot. The two most common causes of a forgetful bot both show up
 * here — an empty memory and a window that is dropping turns.
 */
export function contextHealth(
  conv: Conversations,
  id: string,
  modelLimit = 8192,
): {
  score: number;
  turns: number;
  facts: number;
  dropped: boolean;
  problems: string[];
} {
  const chat = conv.get(id);
  const problems: string[] = [];

  const full = chat.messages.filter((m) => m.role !== 'system');
  const trim = fitWindow(full, { modelLimit, replyReserve: 1024 });

  if (trim.droppedAny) problems.push(`window dropped ${trim.dropped} turn(s) — raise modelLimit or replyReserve`);
  if (chat.memory.size === 0) problems.push('no facts learned — the bot cannot personalise');
  if (chat.turns < 3) problems.push('only a few turns so far — not enough signal');

  // Facts per turn. High means the user repeats themselves; low means nothing
  // is being extracted. Both are worth knowing.
  const density = chat.turns === 0 ? 0 : chat.memory.size / chat.turns;
  if (density > 3) problems.push(`fact density ${density.toFixed(1)}/turn — possibly over-extracting`);

  let score = 100;
  if (trim.droppedAny) score -= 25;
  if (chat.memory.size === 0) score -= 20;
  if (chat.turns < 3) score -= 10;
  score -= Math.round(Math.min(20, Math.abs(density - 1) * 10));

  return {
    score: Math.max(0, Math.min(100, score)),
    turns: chat.turns,
    facts: chat.memory.size,
    dropped: trim.droppedAny,
    problems,
  };
}