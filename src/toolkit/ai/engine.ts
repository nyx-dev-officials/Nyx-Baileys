/**
 * AI-6 · the turn pipeline.
 *
 * One function that takes an inbound message and returns what to do about it.
 * This is the seam a bot script plugs into — and it is deliberately a **feature
 * layer, not a script**. Nothing here connects, pairs, or loops; it takes a
 * message and hands back a decision.
 *
 * ## The order of operations is the design
 *
 * ```
 * 1. normalise      strip quoted blocks so a paste does not look like a command
 * 2. classify       rules first — /ping is answered by a regex, not a model
 * 3. extract        entities, tone, language
 * 4. gate           confidence, rate limit, permission, conversation allowlist
 * 5. recall         memory, injected as a system block with provenance
 * 6. act            a command handler, or a model completion
 * 7. render         tagged output → the right WhatsApp content type
 * 8. verify         assert the reply does not narrate an action that failed
 * 9. record         memory and history, so turn N+1 knows about turn N
 * ```
 *
 * Step 8 is why this module exists rather than a 20-line handler. It is the
 * difference between a bot that is helpful and one that lies.
 */

import type { AnySock } from '../ops-50/types.js';

import {
  Conversations, fitWindow, heuristicDigest, renderDigest,
  type ChatMessage, type FactCandidate,
} from './context.js';

import {
  ToolRegistry, assertNoFabrication, complete, completeWithFallback, systemPrompt, fluxTools, freeFallbackChain,
  type Completion, type ProviderConfig, type RunOutcome, type ToolResult,
} from './providers.js';

import { readSelection, render, sendRendered, type OutputType, type RenderResult } from './output.js';
import { asksForOwner, ownerAnswer, ownerCard, sign, footer, sanitizeTypography, checkFormatting, MADE_BY, FLUX_DESCRIPTION, type FooterOptions } from './identity.js';
import { prepareForModel, mediaFromMessage, type MediaInfo } from './vision.js';
import { ScopedMemory, DurableMemory, userKey, sessionKey } from './memory-store.js';

import {
  detectIntent, detectLanguage, extractEntities, fillSlots, readTone,
  DEFAULT_PREFIX, rulesWithPrefix, type Rule,
  PendingFlow, SLOT_SPECS,
  type Entities, type Intent, type Lang, type Tone,
} from './intent.js';

/* ════════════════════════════════════════════════════════════════════════
   Policy
   ════════════════════════════════════════════════════════════════════════ */

export interface Policy {
  /** Chats the bot answers. Empty means every chat — not recommended. */
  allowlist?: string[];
  /** Chats the bot never answers, even if allowlisted. */
  denylist?: string[];
  /** Ignore groups entirely. */
  ignoreGroups?: boolean;
  /** Ignore anyone not in the allowlist, in groups. */
  openToGroups?: boolean;
  /** Minimum intent confidence to act on. Below this, route to the model. */
  minConfidence?: number;
  /** Messages per minute per chat. */
  rateLimitPerMinute?: number;
  /** Skip these intents without a model call. */
  silentIntents?: Array<Intent['kind']>;
}

/** Does policy permit answering this chat at all? */
export function permitted(policy: Policy, jid: string, isGroup: boolean): { ok: boolean; reason?: string } {
  if (isGroup && policy.ignoreGroups) return { ok: false, reason: 'groups ignored' };
  if (isGroup && !policy.openToGroups && policy.allowlist?.length) {
    return { ok: false, reason: 'groups restricted to an allowlist' };
  }
  if (policy.denylist?.includes(jid)) return { ok: false, reason: 'in denylist' };
  if (policy.allowlist?.length && !policy.allowlist.includes(jid)) {
    return { ok: false, reason: 'not in allowlist' };
  }
  return { ok: true };
}

/* ════════════════════════════════════════════════════════════════════════
   Rate limiting
   ════════════════════════════════════════════════════════════════════════ */

/** Fixed-window limiter. Per chat, in memory, deliberately simple. */
export class RateLimiter {
  private windows = new Map<string, number[]>();

  constructor(private readonly perMinute: number) {}

  /** True when the call is allowed. Records it when it is. */
  take(key: string, now = Date.now()): boolean {
    const cutoff = now - 60_000;
    const recent = (this.windows.get(key) ?? []).filter((t) => t > cutoff);

    if (recent.length >= this.perMinute) {
      this.windows.set(key, recent);
      return false;
    }

    recent.push(now);
    this.windows.set(key, recent);
    return true;
  }

  /** Remaining allowance without consuming any. */
  remaining(key: string, now = Date.now()): number {
    const cutoff = now - 60_000;
    const recent = (this.windows.get(key) ?? []).filter((t) => t > cutoff);
    return Math.max(0, this.perMinute - recent.length);
  }

  reset(key?: string): void {
    if (key) this.windows.delete(key);
    else this.windows.clear();
  }
}

/* ════════════════════════════════════════════════════════════════════════
   Turn outcome
   ════════════════════════════════════════════════════════════════════════ */

export type TurnAction = 'reply' | 'silent' | 'refuse' | 'error' | 'tool';

export interface TurnResult {
  action: TurnAction;
  /** The text to send, already rendered to WhatsApp's dialect. */
  text: string;
  /** What it will render as. */
  output: OutputType;
  /** Set when a message was actually sent. */
  sentId?: string;
  intent: Intent;
  entities: Entities;
  tone: Tone;
  language: Lang;
  /** True when the model was called. */
  usedModel: boolean;
  /** Tool results, when tools ran. */
  tools?: ToolResult[];
  /** Phrases that look like fabricated actions. Worth surfacing. */
  flags?: Array<{ phrase: string; why: string }>;
  /** Everything that went wrong, in order. Never swallowed. */
  notes: string[];
}

/* ════════════════════════════════════════════════════════════════════════
   The pipeline
   ════════════════════════════════════════════════════════════════════════ */

export interface BotConfig {
  ai: ProviderConfig;
  policy?: Policy;
  /** Commands handled without a model call. */
  commands?: Record<string, CommandHandler>;
  tools?: ToolRegistry;
  /** Injected into every completion. */
  persona?: string;
  purpose?: string;
  /** Slots to collect before running a command. */
  slotSpecs?: Record<string, typeof SLOT_SPECS[keyof typeof SLOT_SPECS]>;
  /**
   * How many times the model may call tools before the turn is abandoned.
   * Default 3. Higher risks a loop where each result prompts another call.
   */
  maxToolRounds?: number;
  /**
   * Send a generic error instead of the provider's message. Default false —
   * the real reason is what makes a bot debuggable, and a generic message hides
   * a retryable outage behind a shrug.
   */
  quietErrors?: boolean;
  /** Command prefix rules. Defaults to the  word prefix. */
  rules?: Rule[];
  /** Scoped memory. When set,  reads and writes through it. */
  memory?: ScopedMemory;
  /** Session id for this chat. Defaults to the jid. */
  sessionId?: string;
  /** Signature footer on replies. Default off. */
  footer?: FooterOptions;
  /** Strip visually-ambiguous glyphs from replies. Default true. */
  sanitize?: boolean;
  /** Download inbound media for a vision model. Default false. */
  vision?: boolean;
  /** Extra models to try when the primary one fails transiently. */
  aiFallbacks?: ProviderConfig[];
  /** The prefix the help text should advertise. */
  prefix?: string;
}

export interface AiCommandContext {
  jid: string;
  isGroup: boolean;
  /** The message being answered, for quoting. */
  message: any;
  args: string;
  entities: Entities;
  conv: Conversations;
  sock: AnySock;
  tools?: ToolRegistry;
}

export interface CommandResult {
  /** Text, possibly in the tagged output language. */
  text?: string;
  /** Structured content, when a handler bypasses the text path. */
  content?: Record<string, unknown>;
  output?: OutputType;
  /** Facts this handler learned. */
  learned?: FactCandidate[];
  /** Set to answer without sending. */
  silent?: boolean;
}

export type CommandHandler = (ctx: AiCommandContext) => Promise<CommandResult | string> | CommandResult | string;

/**
 * Remove unbalanced emphasis markers.
 *
 * An unclosed `*` makes WhatsApp render the rest of the message bold — or, worse,
 * nothing at all. rc14 reports nothing and the client renders nothing, so the
 * damage is invisible from the sending side. Repairing on the way out catches it
 * from any source: the model, a command, a webhook.
 *
 * Only *unmatched* markers are removed. Pairs are left alone, because a deliberate
 * single `*` around a word is exactly what bold looks like.
 */
export function stripDanglingMarkers(text: string): string {
  const pairs: Array<[string, string]> = [['*', '*'], ['_', '_'], ['~', '~']];
  let out = String(text ?? '');

  for (const [open] of pairs) {
    const count = out.split(open).length - 1;
    if (count % 2 === 1) {
      // Odd count: drop the last unmatched one rather than the first, which
      // preserves the pairing of everything earlier in the message.
      out = out.replace(
        new RegExp(`\\${open}(?!([\\s\\S]*\\${open}))`, ''),
        '',
      );
    }
  }

  // An unterminated fence swallows the rest of the message.
  const fences = out.split('```').length - 1;
  if (fences % 2 === 1) out += '\n```';

  return out;
}

/**
 * Stateless single-turn helper.
 *
 * Useful for a script that manages its own history, and for tests. Most callers
 * want `BotEngine` instead, because this throws away memory on every call —
 * which is precisely the "dumb bot" failure the rest of this module exists to
 * prevent. Prefer the engine.
 */
export async function handleTurn(
  config: BotConfig,
  sock: AnySock,
  jid: string,
  message: any,
): Promise<TurnResult> {
  return createBot(config).think(sock, jid, message);
}

/* ════════════════════════════════════════════════════════════════════════
   Engine
   ════════════════════════════════════════════════════════════════════════ */

/**
 * Stateful bot core.
 *
 * Owns conversations, memory, pending slot flows, and the command table. A bot
 * script is `sock.ev.on('messages.upsert', …) → engine.respond(…)` — the wiring
 * is four lines, and none of the judgement lives there.
 */
export class BotEngine {
  readonly convs: Conversations;

  readonly flows: PendingFlow;

  private limiter: RateLimiter;

  constructor(private readonly config: BotConfig) {
    this.convs = new Conversations();
    this.flows = new PendingFlow();
    this.limiter = new RateLimiter(config.policy?.rateLimitPerMinute ?? 20);
  }

  /** Scoped memory, when configured. */
  private get scoped(): ScopedMemory | undefined {
    return this.config.memory;
  }

  /**
   * The session id for a chat.
   *
   * Defaults to the jid, so a bot with one conversation per chat gets correct
   * isolation for free and the caller only has to supply a session id when a
   * single chat legitimately contains several.
   */
  private sessionOf(jid: string): string {
    return this.config.sessionId ?? sessionKey(jid, 'default');
  }

  /** Remember a fact durably — survives disconnect and re-pairing. */
  rememberDurable(jid: string, candidate: FactCandidate): boolean {
    return this.config.memory?.remember(jid, candidate) ?? false;
  }

  /** Remember a fact for this session only. */
  rememberSession(jid: string, candidate: FactCandidate): boolean {
    return this.config.memory?.learnSession(this.sessionOf(jid), {
      ...candidate,
      source: `session:${candidate.source || 'chat'}`,
    }) ?? false;
  }

  /** Forget across both layers. */
  forgetScoped(jid: string, topic: string): number {
    return this.config.memory?.forget(jid, this.sessionOf(jid), topic) ?? 0;
  }

  /** End a session, dropping its layer. Durable memory is untouched. */
  endSession(jid: string): number {
    return this.config.memory?.endSession(this.sessionOf(jid)) ?? 0;
  }

  /**
   * Attach or replace the tool set.
   *
   * Separate from the constructor because the tools need a socket, and the socket
   * is supplied per call to `think()`/`respond()` rather than at construction.
   */
  useTools(tools: ToolRegistry): this {
    (this.config as { tools?: ToolRegistry }).tools = tools;
    return this;
  }

  /**
   * Approve a mutating tool by name.
   *
   * One capability at a time on purpose: approving `send_poll` must not also
   * approve `download_media`.
   */
  approve(name: string): this {
    this.config.tools?.approve(name);
    return this;
  }

  get tools(): ToolRegistry | undefined {
    return this.config.tools;
  }

  /**
   * Handle a message and return the decision. Does not send — see `respond`.
   *
   * Never throws for anything a caller could reasonably expect. A provider 503,
   * a denied tool, a parse failure all come back as `action: 'error'` with an
   * honest note. A bot that crashes on a bad message is broken in the only way
   * users notice.
   */
  async think(sock: AnySock, jid: string, message: any): Promise<TurnResult> {
    const policy = this.config.policy ?? {};
    const notes: string[] = [];
    const isGroup = Boolean(jid.endsWith('@g.us'));

    const text = String(message?.message?.conversation
      ?? message?.message?.extendedTextMessage?.text
      ?? message?.message?.imageMessage?.caption
      ?? message?.message?.videoMessage?.caption
      ?? '');

    // A provisional intent, so the owner branch below can return a well-formed
    // result. It is recomputed from the real text immediately after.
    const probe = detectIntent(text, this.config.rules);
    const base = {
      intent: probe,
      entities: extractEntities(text),
      tone: readTone(text),
      language: detectLanguage(text),
      notes,
    };

    // The owner question is answered without the model. A model asked "who made
    // you" without the facts will guess, or say it was made by nobody — and it is
    // the question most likely to be asked, so it must not depend on a round trip.
    if (asksForOwner(text)) {
      this.convs.push(Conversations.keyFor(jid), 'user', text, { from: jid });
      const answer = ownerAnswer();
      this.convs.push(Conversations.keyFor(jid), 'assistant', answer);
      return {
        ...base, action: 'reply', text: answer, output: 'text', usedModel: false,
      };
    }

    const intent = probe;
    const entities = base.entities;
    const tone = base.tone;
    const language = base.language;
    const chatId = Conversations.keyFor(jid);

    // A tap on a poll or menu arrives as a reply, not a new instruction.
    const selection = readSelection(message);
    if (selection) {
      this.convs.push(chatId, 'user', `[selected: ${selection.label}]`, { from: jid });
      const handler = this.config.commands?.selection;
      if (handler) {
        const result = await this.run(handler, {
          jid, isGroup, message, args: selection.id, entities, conv: this.convs, sock,
          tools: this.config.tools,
        });
        return this.finalise(chatId, result, base, false);
      }
      return {
        ...base,
        action: 'reply',
        text: `You picked *${selection.label}*.`,
        output: 'text',
        usedModel: false,
      };
    }

    // 1. permission
    const gate = permitted(policy, jid, isGroup);
    if (!gate.ok) return { ...base, action: 'silent', text: '', output: 'text', usedModel: false, ...gate };

    // 2. rate limit
    if (!this.limiter.take(chatId)) {
      return {
        ...base,
        action: 'refuse',
        text: 'Too many messages — slow down a moment.',
        output: 'text',
        usedModel: false,
      };
    }

    // 3. silent intents
    if (policy.silentIntents?.includes(intent.kind)) {
      return { ...base, action: 'silent', text: '', output: 'text', usedModel: false };
    }

    // 4. record the user's turn *before* deciding, so a reply can quote it
    this.convs.push(chatId, 'user', text, { from: jid });

    // 5. a pending multi-step flow takes priority over a fresh command
    const pending = this.flows.advance(chatId, text);
    if (pending && !pending.complete) {
      return {
        ...base,
        action: 'reply',
        text: pending.asks.join(' '),
        output: 'text',
        usedModel: false,
      };
    }

    // 6. a command, handled without a model
    if (intent.command) {
      const handler = this.config.commands?.[intent.command];
      if (handler) {
        const result = await this.run(handler, {
          jid, isGroup, message, args: intent.args, entities, conv: this.convs, sock,
          tools: this.config.tools,
        });
        return this.finalise(chatId, result, base, false);
      }
      notes.push(`no handler for /${intent.command}`);
    }

    // 7. a command with required slots — ask rather than act on half an input
    const slotSpecs = intent.command ? this.config.slotSpecs?.[intent.command] : undefined;
    if (slotSpecs) {
      const filled = this.flows.start(chatId, slotSpecs, {});
      if (!filled.complete) {
        return {
          ...base,
          action: 'reply',
          text: filled.asks.join(' '),
          output: 'text',
          usedModel: false,
        };
      }
    }

    // 8. the model
    const system = systemPrompt({
      chat: { jid, isGroup: jid.endsWith('@g.us') },
      ...(this.config.persona ? { persona: this.config.persona } : {}),
      ...(this.config.purpose ? { purpose: this.config.purpose } : {}),
      ...(this.config.tools ? { tools: this.config.tools } : {}),
    });

    const window = this.config.ai.contextWindow ?? 8192;
    const history = this.convs.buildPrompt(chatId, {
      modelLimit: window,
      replyReserve: this.config.ai.maxTokens ?? 1024,
      system: this.scoped
        ? [
          system,
          // Durable + session memory, merged, with the layer marked. This is
          // what survives a disconnect or a re-pair.
          this.config.memory?.render(jid, this.sessionOf(jid), text),
        ].filter(Boolean).join('\n\n')
        : system,
    });

    // Media, for a vision model. Downloaded only when a vision model is actually
    // configured — pulling 40 MB of video to hand a text model a string it
    // cannot use is pure waste.
    let media: MediaInfo[] = [];
    if (this.config.vision === true) {
      try {
        media = await mediaFromMessage(sock, message, { download: true });
        if (media.length > 0) notes.push(`media: ${media.map((m) => m.kind).join(', ')}`);
      } catch (error) {
        notes.push(`media download failed: ${(error as Error).message}`);
      }
    }

    /**
     * Run the tool-call loop.
     *
     * The model asks for a tool → the tool runs → the *real* result goes back as
     * a tool-role message → the model answers with that result in hand. Without
     * this, a model that correctly decided to call `send_poll` produced a tool
     * call nobody read and a reply that merely described the poll. The single
     * most important property: **the model sees the tool's real output**, so it
     * cannot claim an action succeeded that did not.
     */
    const maxRounds = this.config.maxToolRounds ?? 3;
    const transcript: ChatMessage[] = [...history];

    // A vision turn carries media in the final user message rather than the whole
    // transcript — rebuilding every historical turn as a parts array would be both
    // expensive and wrong, since only the newest media is relevant.
    let toolResults: RunOutcome | undefined;

    for (let round = 0; round < maxRounds; round += 1) {
      // Fall back across models on a retryable failure. The free tier goes down
      // intermittently, and a bot pinned to one endpoint drops replies at random.
      const chain = this.config.aiFallbacks?.length
        ? [this.config.ai, ...this.config.aiFallbacks]
        : [this.config.ai];

      const round = media.length > 0 && transcript.at(-1)
        ? [
          ...transcript.slice(0, -1),
          {
            ...(transcript.at(-1) as ChatMessage),
            // Kept as a string here; the provider path converts it. This keeps the
            // fallback chain provider-agnostic.
            content: String(
              prepareForModel(
                (transcript.at(-1) as ChatMessage).content,
                media,
                chain[0]?.provider ?? this.config.ai.provider,
                chain[0]?.model ?? this.config.ai.model,
              ),
            ),
          },
        ]
        : transcript;

      const completion: Completion = await completeWithFallback(chain, round, {
        ...(this.config.tools ? { tools: this.config.tools } : {}),
      });

      if (completion.error) {
        notes.push(`provider: ${completion.error}`);
        return {
          ...base,
          action: 'error',
          // Surface the real reason. A generic "I could not reach the model"
          // teaches the user nothing and hides a retryable outage from whoever
          // is debugging the bot.
          text: this.config.quietErrors
            ? 'I could not reach the model. Try again in a moment.'
            : `Model error: ${completion.error}`,
          output: 'text',
          usedModel: true,
          ...(toolResults ? { tools: toolResults.results } : {}),
        };
      }

      const calls = completion.toolCalls ?? [];
      if (calls.length === 0) {
        // Final answer. Check it against what actually happened.
        const check = assertNoFabrication(completion.text, toolResults ?? null);
        if (!check.clean) {
          notes.push(`fabrication flag: ${check.flags.map((f) => f.phrase).join(', ')}`);
        }

        this.convs.push(chatId, 'assistant', completion.text);

        return {
          ...base,
          action: 'reply',
          text: completion.text,
          output: render(completion.text).type,
          usedModel: true,
          ...(toolResults ? { tools: toolResults.results } : {}),
          ...(check.flags.length ? { flags: check.flags } : {}),
        };
      }

      if (!this.config.tools) {
        notes.push('model requested tools but none are registered');
        return {
          ...base,
          action: 'error',
          text: 'I wanted to use a tool but none are available.',
          output: 'text',
          usedModel: true,
        };
      }

      // Record what the model asked for, so the transcript stays coherent.
      transcript.push({
        role: 'assistant',
        content: `[tool call] ${calls.map((c) => c.name).join(', ')}`,
        tool: calls.map((c) => c.name).join(','),
      });

      const outcome = await this.config.tools.run(calls);
      toolResults = outcome;

      for (const refused of outcome.refused) {
        notes.push(`refused ${refused.tool}: ${refused.reason}`);
      }
      for (const result of outcome.results) {
        if (!result.ok && !result.denied) notes.push(`tool ${result.tool} failed: ${result.detail}`);
      }

      // The real results, verbatim. This is what grounds the final answer.
      transcript.push(...ToolRegistry.renderResults(outcome.results));
    }

    notes.push(`tool loop hit its ${maxRounds}-round limit`);
    return {
      ...base,
      action: 'error',
      text: 'That took more steps than I expected — try asking more simply.',
      output: 'text',
      usedModel: true,
      ...(toolResults ? { tools: toolResults.results } : {}),
    };
  }

  /** Think, then send. This is what a bot script actually calls. */
  async respond(sock: AnySock, jid: string, message: any): Promise<TurnResult & { sent: boolean }> {
    const turn = await this.think(sock, jid, message);

    if (turn.action === 'silent' || !turn.text) return { ...turn, sent: false };

    // Formatting hygiene runs here, on the way out, so a bad marker from any
    // source is caught once rather than at every call site.
    let outbound = turn.text;
    const problems = checkFormatting(outbound);

    if (problems.length > 0) {
      // Close a dangling marker rather than shipping text that renders wrong for
      // the rest of the message. This is a repair, not a rewrite.
      outbound = stripDanglingMarkers(outbound);
      turn.notes.push(`formatting repaired: ${problems.join('; ')}`);
    }

    if (this.config.sanitize !== false) {
      const cleaned = sanitizeTypography(outbound);
      if (cleaned !== outbound) turn.notes.push('stripped ambiguous glyphs');
      outbound = cleaned;
    }

    outbound = sign(outbound, this.config.footer ?? {});

    const sent = await sendRendered(sock, jid, outbound, {
      quoted: message,
      fallbackToText: true,
    });

    return { ...turn, text: outbound, output: sent.type, sentId: sent.id, sent: Boolean(sent.id) };
  }

  /** Run a command handler, normalising its string return. */
  private async run(handler: CommandHandler, ctx: AiCommandContext): Promise<CommandResult> {
    const result = await handler(ctx);
    return typeof result === 'string' ? { text: result } : result;
  }

  /** Learn from a command result and push the reply into history. */
  private finalise(
    chatId: string,
    result: CommandResult,
    base: Omit<TurnResult, 'action' | 'text' | 'output' | 'usedModel'>,
    usedModel: boolean,
  ): TurnResult {
    for (const fact of result.learned ?? []) {
      this.convs.learn(chatId, { ...fact, source: fact.source || 'unknown' });
    }

    if (result.silent || !result.text) {
      return { ...base, action: 'silent', text: '', output: 'text', usedModel };
    }

    this.convs.push(chatId, 'assistant', result.text);

    return {
      ...base,
      action: result.content ? 'tool' : 'reply',
      text: result.text,
      output: result.output ?? render(result.text).type,
      usedModel,
    };
  }

  /* ── memory ─────────────────────────────────────────────────── */

  learn(jid: string, candidate: FactCandidate): boolean {
    return this.convs.learn(Conversations.keyFor(jid), candidate);
  }

  forget(jid: string, topic: string): number {
    return this.convs.forget(Conversations.keyFor(jid), topic);
  }

  /** Wipe a chat's history and memory. The `/reset` path. */
  reset(jid: string): boolean {
    return this.convs.drop(Conversations.keyFor(jid));
  }

  /** Drop flows that timed out. Call on an interval. */
  sweep(): number {
    return this.flows.sweep();
  }

  /**
   * Compact a long chat into a digest the model can carry.
   *
   * Heuristic and offline — it cannot hallucinate, because it only returns lines
   * that actually appeared.
   */
  compact(jid: string): { topic: string; kept: number; dropped: number } {
    const chatId = Conversations.keyFor(jid);
    const chat = this.convs.get(chatId);

    const digest = heuristicDigest(chat.messages);
    const summary = renderDigest(digest);
    const before = chat.messages.length;

    chat.messages = summary
      ? [{ role: 'system' as const, content: `Earlier conversation:\n${summary}` }]
      : [];

    return { topic: digest.topic, kept: chat.messages.length, dropped: before - chat.messages.length };
  }

  /** What the model would actually see. For debugging context. */
  debugContext(jid: string): {
    turns: number;
    facts: number;
    messages: ChatMessage[];
    trimmed: { dropped: number; tokens: number };
  } {
    const chatId = Conversations.keyFor(jid);
    const chat = this.convs.get(chatId);
    const window = this.config.ai.contextWindow ?? 8192;
    const trimmed = fitWindow(chat.messages, { modelLimit: window });

    // The system prompt is rebuilt here, exactly as `think()` does. Without it
    // this reports the persona, the grounding rules, the output-forms teaching
    // and the tool list as all absent — which reads as "the prompt is broken"
    // when in fact the caller just was not shown the part that is assembled
    // per-request. That is a debugging tool that misleads while debugging.
    const system = systemPrompt({
      chat: { jid, isGroup: jid.endsWith('@g.us') },
      ...(this.config.persona ? { persona: this.config.persona } : {}),
      ...(this.config.purpose ? { purpose: this.config.purpose } : {}),
      ...(this.config.tools ? { tools: this.config.tools } : {}),
    });

    return {
      turns: chat.turns,
      facts: chat.memory.size,
      messages: this.convs.buildPrompt(chatId, {
        modelLimit: window,
        replyReserve: this.config.ai.maxTokens ?? 1024,
        system,
      }),
      trimmed: { dropped: trimmed.dropped, tokens: trimmed.tokens },
    };
  }
}

/* ════════════════════════════════════════════════════════════════════════
   Default commands
   ════════════════════════════════════════════════════════════════════════ */

/**
 * Commands that need no model and always work.
 *
 * Every entry is a real capability with a real result — none is a stub. A
 * command that exists but does nothing is worse than its absence.
 */
/** One line per real command, used to generate `/help`. */
const COMMAND_HELP: Record<string, string> = {
  ping: 'liveness',
  id: 'this chat jid',
  whoami: 'who you are here',
  time: 'server time',
  remember: '<fact> — save a fact about you',
  forget: '<topic> — drop matching facts',
  recall: 'what is remembered',
  reset: 'forget this conversation',
  check: '<number> — is it on WhatsApp',
  poll: '<question> — make a poll',
  list: '<title> — make a menu',
  buttons: '<title> — quick replies',
  note: '<text> — italic note',
  download: '<url> — fetch a file',
  cancel: 'stop what is in progress',
};

export function defaultCommands(prefix: string = DEFAULT_PREFIX): Record<string, CommandHandler> {
  return {
    ping: () => ({ text: 'pong' }),

    id: (ctx) => ({ text: `Chat: ${ctx.jid}` }),

    whoami: (ctx) => ({ text: `Your jid here: ${ctx.jid}${ctx.isGroup ? '\nYou are in a group.' : ''}` }),

    time: () => ({ text: `Server time: ${new Date().toISOString()}` }),

    help: () => ({
      // Generated from the prefix so the help text can never disagree with the
      // matcher. A help listing `/poll` while the rule reads `flux poll` is how
      // a user wastes five minutes typing something that silently does nothing.
      text: [
        `*Flux — commands*`,
        ...Object.entries(COMMAND_HELP).map(([name, help]) =>
          `• ${prefix} ${name}${help ? ` — ${help}` : ''}`),
        '',
        `_Type "${prefix} help" any time._`,
        `_"/" also works: /ping_`,
        `_*${MADE_BY} · ${FLUX_DESCRIPTION}_*`,
      ].join('\n'),
    }),

    remember: (ctx) => {
      const fact = ctx.args.trim();
      if (!fact) return { text: 'Usage: /remember <fact about you>' };
      return { text: `Noted: *${fact}*`, learned: [{ fact, source: 'user request' }] };
    },

    forget: (ctx) => {
      const topic = ctx.args.trim();
      if (!topic) return { text: 'Usage: /forget <topic>' };
      const removed = ctx.conv.forget(Conversations.keyFor(ctx.jid), topic);
      return { text: removed > 0 ? `Forgot ${removed} fact(s).` : 'Nothing matched that.' };
    },

    recall: (ctx) => {
      const facts = ctx.conv.get(Conversations.keyFor(ctx.jid)).memory.recall(undefined, 20);
      if (facts.length === 0) return { text: 'I have not learned anything about you yet.' };
      return {
        text: `*Remembered*\n${facts.map((f) => `• ${f.fact}\n  _${f.source}_`).join('\n')}`,
      };
    },

    check: async (ctx) => {
      const number = ctx.args.trim();
      if (!number) return { text: 'Usage: /check <number>' };

      const results = (await ctx.sock.onWhatsApp(number.replace(/\D/g, ''))) as
        | Array<{ exists?: boolean; jid?: string }>
        | undefined;
      const hit = results?.find((r) => r.exists);

      return {
        text: hit?.jid
          ? `*${number}* is on WhatsApp.\n\`${hit.jid}\``
          : `*${number}* is not on WhatsApp.`,
      };
    },

    poll: (ctx) => {
      const question = ctx.args.trim();
      if (!question) return { text: 'Usage: /poll <question>' };
      return { text: `<<poll>>\n${question}\n- Yes\n- No\n- Maybe\n<<end>>` };
    },

    list: (ctx) => {
      const title = ctx.args.trim() || 'Menu';
      return { text: `<<list>>\n${title}\n- Option one\n- Option two\n- Option three\n<<end>>` };
    },

    buttons: (ctx) => {
      const title = ctx.args.trim() || 'Choose';
      return { text: `<<buttons>>\n${title}\n- Yes\n- No\n<<end>>` };
    },

    note: (ctx) => ({ text: `<<note>>\n${ctx.args.trim() || 'note'}\n<<end>>` }),

    reset: (ctx) => {
      // Listed in help, so it needs a handler. The previous version advertised
      // `/reset` and did nothing — which is exactly the "command exists but is a
      // no-op" failure the help table is supposed to make impossible.
      const key = Conversations.keyFor(ctx.jid);
      const chat = ctx.conv.get(key);
      const had = chat.turns + chat.memory.size;

      ctx.conv.drop(key);
      return {
        text: had > 0
          ? `Cleared. ${had} turn(s) and any remembered facts from this chat.`
          : 'Nothing to clear — this chat had no history.',
      };
    },

    download: async (ctx) => {
      const url = ctx.args.trim();
      if (!url) return { text: 'Usage: flux download <https url>' };

      // Deliberately does not fetch here. A command that pulls bytes off the
      // open internet from a chat message needs the SSRF guards in
      // `media-fetch` and a stated rights basis, and it needs to be an approved
      // tool rather than an unguarded command. Saying so beats a silent success.
      return {
        text: [
          `I can fetch *${url}*, but not from a plain command.`,
          '',
          'Ask me in normal chat and I will use the download tool — it asks for',
          'permission first and refuses private or internal addresses.',
        ].join('\n'),
      };
    },

    cancel: () => ({ text: 'Cancelled.' }),
  };
}

/**
 * Convenience: an engine with the default commands wired in.
 *
 * With no `ai` supplied this returns Flux against the `echo` provider, so the
 * whole pipeline runs with no API key — useful for proving the plumbing works
 * before anyone enables a paid model.
 */
export function createBot(config: Partial<BotConfig> = {}): BotEngine {
  return new BotEngine({
    ai: config.ai ?? { provider: 'echo', model: 'none' },
    ...config,
    commands: { ...defaultCommands(config.prefix ?? DEFAULT_PREFIX), ...config.commands },
  });
}

/**
 * Create Flux with its full tool set attached.
 *
 * The one-liner for a bot script:
 *
 * ```js
 * const flux = createFlux({
 *   ai: { provider: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY, model: 'claude-sonnet-4-5' },
 *   allowedJid: toRecipientJid('62882017467912'),
 * });
 * await flux.respond(sock, jid, incomingMessage);
 * ```
 *
 * Mutating tools — send, poll, menu, react, download — are **not** approved.
 * Call `flux.approve('send_poll')` per capability so enabling one cannot enable
 * all of them.
 */
export function createFlux(options: {
  ai: ProviderConfig;
  /** Build a fallback chain from the verified stable free models. Default true
   *  when the primary model is a free one. */
  freeFallback?: boolean;
  allowedJid?: string;
  allowSend?: boolean;
  persona?: string;
  purpose?: string;
  policy?: Policy;
  commands?: Record<string, CommandHandler>;
}): BotEngine {
  const config: BotConfig = {
    ai: options.ai,
    ...(options.persona ? { persona: options.persona } : {}),
    ...(options.purpose ? { purpose: options.purpose } : {}),
    ...(options.policy ? { policy: options.policy } : {}),
    ...(options.commands ? { commands: options.commands } : {}),
    // A free primary gets a fallback chain automatically: those endpoints go down
    // intermittently, and a bot pinned to one drops replies at random.
    ...((options.ai.model ?? '').includes(':free') || options.ai.model === 'openrouter/free')
      ? { aiFallbacks: freeFallbackChain().filter((c) => c.model !== options.ai.model) }
      : {},
  };

  const engine = createBot(config);

  // Approvals made before the first `think()` must survive. The registry does not
  // exist yet at that point, so `engine.approve()` was a silent no-op — and
  // "I approved send_poll and it still refused" is an unnerving bug to chase
  // from the outside. Hold them here and apply once the registry is built.
  const pending = new Set<string>();

  // Tools need a socket, and the socket arrives per call rather than at
  // construction. The registry is built on first use and cached, so
  // `systemPrompt()` can list the tools before any socket exists.
  let registry: ToolRegistry | undefined;

  return new Proxy(engine, {
    get(target, prop, receiver) {
      if (prop === 'approve') {
        return (name: string) => {
          pending.add(name);
          registry?.approve(name);
          return receiver;
        };
      }

      if (prop === 'think' || prop === 'respond') {
        return async (s: AnySock, ...rest: unknown[]) => {
          if (!registry) {
            registry = fluxTools(s, {
              ...(options.allowedJid ? { allowedJid: options.allowedJid } : {}),
              ...(options.allowSend !== undefined ? { allowSend: options.allowSend } : {}),
            });
            for (const name of pending) registry.approve(name);
            engine.useTools(registry as ToolRegistry);
          }
          return (target[prop] as (...a: unknown[]) => unknown)(s, ...rest);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** Result of a `download` command, kept for the caller to assert rights on. */
export interface DownloadRequest {
  url: string;
  requestedBy: string;
  at: number;
  rightsBasis?: { holder: string; source: string };
}

export function describeDownload(request: DownloadRequest): string {
  const basis = request.rightsBasis?.holder ?? 'unspecified';
  return `Download ${request.url}\nrequested by ${request.requestedBy}\nrights: ${basis}`;
}

/** Fill a command's slots, exported so scripts can reuse the specs. */
export { fillSlots, SLOT_SPECS };