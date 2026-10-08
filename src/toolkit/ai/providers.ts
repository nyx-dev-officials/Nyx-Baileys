/**
 * AI-2 · provider layer.
 *
 * Multi-provider chat completion over raw `fetch` — no SDK dependency, because
 * adding four vendor SDKs to a library whose whole point is a small dependency
 * surface would be a bad trade. Every provider here is a plain HTTP call.
 *
 * ## The rule this module exists to enforce
 *
 * **A model that claims an action it did not take is worse than no model.**
 *
 * That constraint lives in the system prompt *and* in `ToolRegistry.run()`
 * below, because a system prompt is a request and enforcement is code. A tool
 * result carries `ok: false` on failure, and `assertNoFabrication()` checks
 * returned text against the tools actually invoked.
 *
 * ## Providers
 *
 * `openai` · `anthropic` · `gemini` · `groq` (OpenAI-compatible) · `ollama`
 * · `echo` — a local deterministic provider so the toolkit is fully testable and
 * runnable with no API key at all.
 */

import { estimateMessages, type ChatMessage } from './context.js';
import { OWNER_DISPLAY, FLUX_DESCRIPTION } from './identity.js';

type AnySock = Record<string, any>;

/* ════════════════════════════════════════════════════════════════════════
   Config
   ════════════════════════════════════════════════════════════════════════ */

export type ProviderId =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'groq'
  | 'openrouter'
  | 'ollama'
  | 'echo';

export interface ProviderConfig {
  provider: ProviderId;
  /** Absent for `echo` and local `ollama`. */
  apiKey?: string;
  model: string;
  baseUrl?: string;
  /** Real context limit. Used for window budgeting, not sent to the provider. */
  contextWindow?: number;
  temperature?: number;
  maxTokens?: number;
  /** Milliseconds. Every call is bounded — a hung request must not hang a chat. */
  timeoutMs?: number;
}

/** Defaults that are correct rather than aspirational. */
export const PROVIDER_DEFAULTS: Record<ProviderId, {
  model: string;
  baseUrl: string;
  contextWindow: number;
  maxTokens: number;
  keyless: boolean;
}> = {
  openai: { model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1', contextWindow: 128_000, maxTokens: 4096, keyless: false },
  anthropic: { model: 'claude-sonnet-4-5', baseUrl: 'https://api.anthropic.com/v1', contextWindow: 200_000, maxTokens: 4096, keyless: false },
  gemini: { model: 'gemini-2.0-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', contextWindow: 1_000_000, maxTokens: 4096, keyless: false },
  groq: { model: 'llama-3.3-70b-versatile', baseUrl: 'https://api.groq.com/openai/v1', contextWindow: 128_000, maxTokens: 4096, keyless: false },
  openrouter: { model: 'nvidia/nemotron-3-ultra-550b-a55b:free', baseUrl: 'https://openrouter.ai/api/v1', contextWindow: 1_000_000, maxTokens: 4096, keyless: false },
  ollama: { model: 'llama3.2', baseUrl: 'http://127.0.0.1:11434/v1', contextWindow: 32_768, maxTokens: 2048, keyless: true },
  echo: { model: 'none', baseUrl: '', contextWindow: 4096, maxTokens: 256, keyless: true },
};

/* ════════════════════════════════════════════════════════════════════════
   Tool calling
   ════════════════════════════════════════════════════════════════════════ */

export interface ToolResult {
  tool: string;
  ok: boolean;
  /** What actually happened. The model sees this verbatim — never a summary. */
  detail: string;
  /** Set when the tool was not permitted to run. */
  denied?: boolean;
}

/** A capability the model may invoke. */
export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
  /** Does this change state the user can see? Gates auto-approval. */
  mutating?: boolean;
  run(args: Record<string, any>): Promise<unknown>;
}

export interface RunOutcome {
  results: ToolResult[];
  /** Calls that were not permitted, with why. */
  refused: Array<{ tool: string; reason: string }>;
  /** True when at least one tool actually succeeded. */
  anyOk: boolean;
}

/**
 * A permission gate over the tool set.
 *
 * Auto-approval is opt-in per tool and defaults **off** for anything mutating.
 * A bot that can delete or ban from a model response needs that configured
 * deliberately, not inherited from a convenience default.
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  private approved = new Set<string>();

  private autoApprove = false;

  register(tool: Tool): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  /** Register several at once. */
  registerAll(tools: Tool[]): this {
    for (const t of tools) this.register(t);
    return this;
  }

  /**
   * Permit a tool for this session.
   *
   * A non-mutating tool can be blanket-approved; a mutating one must be named
   * explicitly, so "approve everything" cannot silently include `delete`.
   */
  approve(name: string): this {
    this.approved.add(name);
    return this;
  }

  /** Approve every non-mutating tool. Mutating tools still need naming. */
  approveSafe(): this {
    this.autoApprove = true;
    return this;
  }

  revoke(name: string): this {
    this.approved.delete(name);
    // Only clear `autoApprove` when the named set is empty. Revoking one tool
    // silently switched off blanket approval for every read-only tool as well,
    // which turned one revoke into a registry that refused everything.
    if (this.approved.size === 0) this.autoApprove = false;
    return this;
  }

  get names(): string[] {
    return [...this.tools.keys()];
  }

  /** Tool definitions in OpenAI shape, for providers that support them. */
  describe(): Array<{ type: 'function'; function: Omit<Tool, 'run'> }> {
    return [...this.tools.values()].map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        mutating: t.mutating,
      },
    }));
  }

  /**
   * Invoke tools by name.
   *
   * **Every failure is returned, never thrown.** A rejected tool call that
   * throws takes down the turn, and the model never learns what happened — it
   * just sees a missing reply and guesses. Returning `ok: false` with a reason
   * is what lets it say "I couldn't do that because…".
   */
  async run(calls: Array<{ name: string; args?: Record<string, any> }>): Promise<RunOutcome> {
    const results: ToolResult[] = [];
    const refused: Array<{ tool: string; reason: string }> = [];

    for (const call of calls) {
      const tool = this.tools.get(call.name);

      if (!tool) {
        results.push({ tool: call.name, ok: false, detail: `no such tool: ${call.name}` });
        continue;
      }

      // An explicit approval always wins, checked *first*. The original order
      // was `autoApprove ? !mutating : approved.has(name)` — so once
      // `approveSafe()` was set, a later `approve('send_poll')` was silently
      // ignored, because the ternary never reached the named-approval branch.
      // Per-capability approval is the whole point of this class, so the named
      // set is consulted first.
      const permitted = this.approved.has(tool.name)
        || (this.autoApprove && tool.mutating !== true);
      if (!permitted) {
        const reason = tool.mutating === true
          ? 'not approved (mutating tools need explicit approval)'
          : 'not approved';
        refused.push({ tool: call.name, reason });
        results.push({ tool: call.name, ok: false, detail: reason, denied: true });
        continue;
      }

      try {
        const value = await tool.run(call.args ?? {});
        results.push({
          tool: call.name,
          ok: true,
          detail: typeof value === 'string' ? value : JSON.stringify(value),
        });
      } catch (error) {
        results.push({
          tool: call.name,
          ok: false,
          detail: (error as Error).message,
        });
      }
    }

    return {
      results,
      refused,
      anyOk: results.some((r) => r.ok),
    };
  }

  /** Render results as the tool-result message block providers expect. */
  static renderResults(results: ToolResult[]): ChatMessage[] {
    return results.map((r) => ({
      role: 'user' as const,
      content: `tool_result ${r.tool} ok=${r.ok}\n${r.detail}`,
      tool: r.tool,
    }));
  }
}

/* ════════════════════════════════════════════════════════════════════════
   Completion
   ════════════════════════════════════════════════════════════════════════ */

export interface Completion {
  text: string;
  provider: ProviderId;
  model: string;
  /** Token accounting from the provider, when it reports it. */
  usage?: { prompt?: number; completion?: number };
  /** Set when the call failed. The caller decides whether to fall back. */
  error?: string;
  /** True when the provider refused rather than errored. */
  refused?: boolean;
  /** How many attempts it took. Greater than 1 means a retry succeeded. */
  attempts?: number;
  /** True when the free tier's per-minute cap was hit. */
  rateLimited?: boolean;
  /** Tool calls the model requested. The engine runs these, not `complete()`. */
  toolCalls?: ToolCall[];
}

/** fetch with a hard timeout. A hung provider must not hang the chat. */
async function fetchTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One completion round trip.
 *
 * `history` is sent as given — window fitting is the caller's job via
 * `fitWindow`, so a caller can see what was dropped rather than having it
 * happen invisibly here.
 */
export async function complete(
  config: ProviderConfig,
  history: ChatMessage[],
  options: { tools?: ToolRegistry; system?: string; /** Attempts on empty or transient failure. Default 2. */ attempts?: number } = {},
): Promise<Completion> {
  const defaults = PROVIDER_DEFAULTS[config.provider];
  const timeoutMs = config.timeoutMs ?? 30_000;

  const base = config.baseUrl ?? defaults.baseUrl;
  const model = config.model || defaults.model;
  const temperature = config.temperature ?? 0.7;
  const maxTokens = config.maxTokens ?? defaults.maxTokens;

  // A key supplied directly wins; otherwise read the environment. Never
  // hardcoded — this is a published package, so a key in source is a key that
  // `npm publish` ships to everyone.
  const apiKey = config.apiKey ?? resolveApiKey({ env: process.env });

  if (!apiKey && !defaults.keyless) {
    return {
      text: '',
      provider: config.provider,
      model,
      // Name the variable, not just "needs an apiKey" — the caller should not
      // have to guess which one to set.
      error: `${config.provider} needs an api key — set ${KEY_ENV[config.provider] ?? 'the provider key'}`,
    };
  }

  const system = options.system;
  const withSystem: ChatMessage[] = system
    ? [{ role: 'system' as const, content: system }, ...history.filter((m) => m.role !== 'system')]
    : history;

  /**
   * One dispatch, no retry.
   *
   * Split out so `complete()` can retry the whole thing without duplicating the
   * provider switch.
   */
  const dispatch = async (): Promise<Completion> => {
    switch (config.provider) {
      case 'echo':
        return echoCompletion(model, withSystem);
      case 'anthropic':
        return anthropic(base, { ...config, apiKey }, withSystem, { temperature, maxTokens, timeoutMs });
      case 'gemini':
        return gemini(base, { ...config, apiKey }, withSystem, { temperature, maxTokens, timeoutMs });
      default:
        return openaiCompatible(base, { ...config, apiKey }, withSystem, {
          temperature, maxTokens, timeoutMs, tools: options.tools,
        });
    }
  };

  // The free tier produces three distinct retryable failures — an empty body, a
  // transient upstream error, and a rate limit — and they need different
  // handling. Verified live across two probe runs of every free model.
  //
  // Default 3 attempts: the most common failure is Nvidia's endpoint returning
  // "Service temporarily unavailable" for a second or two, which a retry clears.
  const maxAttempts = options.attempts ?? 3;
  let last: Completion | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let result: Completion;
    try {
      result = await dispatch();
    } catch (error) {
      const message = (error as Error).name === 'AbortError'
        ? `timed out after ${timeoutMs}ms`
        : (error as Error).message;
      result = { text: '', provider: config.provider, model, error: message };
    }

    const rateLimited = isRateLimited(result.error);
    const transient = isTransientUpstream(result.error);
    const empty = isEmptyResponse(result);

    if (result.attempts === undefined) result.attempts = attempt;
    if (rateLimited) result.rateLimited = true;

    // A refusal is a decision, not a failure. Retrying it burns quota to get
    // the same answer, so stop here and report it.
    if (result.refused) return result;

    if (!result.error && !empty) return result;

    last = result;

    // Do not hammer a rate limiter. It is a hard cap, not a queue — retrying
    // faster cannot help and makes the next window longer.
    if (rateLimited) break;
    if (attempt >= maxAttempts) break;

    // An upstream outage needs seconds, not milliseconds. An empty body is
    // usually fixed by the very next call.
    await sleep(transient ? 1200 * attempt : 400 * attempt);
  }

  // The last error may be a stale transient message while a later attempt would
  // have worked. Say so rather than blaming the model.
  if (last?.error && last.attempts && last.attempts > 1 && isTransientUpstream(last.error)) {
    last.error += ` (after ${last.attempts} attempts — the free tier's endpoint is intermittently unavailable)`;
  }

  return last ?? { text: '', provider: config.provider, model, error: 'no attempt made' };
}

/** Did this failure come from a rate limit rather than a broken request? */
export function isRateLimited(error: string | undefined): boolean {
  if (!error) return false;
  return /rate.?limit|too many requests|\b429\b|quota|free-models-per-min/i.test(error);
}

/**
 * Is this a transient upstream failure that is worth retrying?
 *
 * Verified live against the Nvidia free tier, which intermittently returns
 * `Upstream error from Nvidia: Service temporarily unavailable` — a 200 with an
 * error body and no choices. Two attempts 400 ms apart both failed; the same
 * call seconds later succeeded. This is the single most common real failure on
 * the free tier, and without recognising it a bot drops replies that a retry
 * would have saved.
 */
export function isTransientUpstream(error: string | undefined): boolean {
  if (!error) return false;
  return /temporarily unavailable|upstream error|service unavailable|overloaded|try again|bad gateway|502|503|504|econnreset|etimedout|socket hang up|empty response/i.test(error);
}

/** True when a provider replied successfully but with nothing usable. */
export function isEmptyResponse(result: { text: string; error?: string }): boolean {
  return !result.error && !result.text.trim();
}

/** Small cancellable sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/* ════════════════════════════════════════════════════════════════════════
   Free models
   ════════════════════════════════════════════════════════════════════════ */

/**
 * Models that cost nothing, verified against the live free tier.
 *
 * ## How this list was built
 *
 * Not from documentation — from **two probe runs of two calls each** against the
 * OpenRouter free tier on 2026-10-07. The first draft of this catalogue was
 * written from memory and **11 of its 14 entries turned out to be dead**: four
 * returned "unavailable for free", three returned "Provider returned error", and
 * four returned an empty body. Two — `thinkingmachines/inkling` and
 * `inkling-small` — return an explicit "only available inside a coding harness"
 * refusal, which is why they are absent here despite topping the context table.
 *
 * A free model list is a **moving target**: providers withdraw models weekly. So
 * `verifiedOn` records when each entry was probed, and `reliability` records what
 * happened rather than implying a guarantee.
 */
export interface FreeModel {
  id: string;
  provider: ProviderId;
  contextWindow: number;
  /** Supports OpenAI-style tool calls. Needed for Flux's tools. */
  tools: boolean;
  /** What two live probes actually showed. */
  reliability: 'stable' | 'flaky';
  /** Date the entry was probed against the live tier. */
  verifiedOn: string;
  note: string;
}

export const FREE_MODELS: FreeModel[] = [
  {
    id: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    provider: 'openrouter',
    contextWindow: 1_000_000,
    tools: true,
    reliability: 'stable',
    verifiedOn: '2026-10-07',
    note: 'Best default. 1M context, exact instruction-following, returns the requested token verbatim.',
  },
  {
    id: 'openrouter/free',
    provider: 'openrouter',
    contextWindow: 200_000,
    tools: true,
    reliability: 'stable',
    verifiedOn: '2026-10-07',
    note: 'Router-chosen free model. Changes under you, so treat it as a last-resort fallback.',
  },
  {
    id: 'nvidia/nemotron-3.5-lightning:free',
    provider: 'openrouter',
    contextWindow: 1_000_000,
    tools: true,
    reliability: 'stable',
    verifiedOn: '2026-10-07',
    note: 'Fastest at 1M. Emits "thinking" prose before answering, so raise maxTokens and strip it.',
  },
  {
    id: 'nvidia/nemotron-3-super-120b-a12b:free',
    provider: 'openrouter',
    contextWindow: 262_144,
    tools: true,
    reliability: 'flaky',
    verifiedOn: '2026-10-07',
    note: 'Intermittent empty body with finish_reason "length". Usable only with a retry.',
  },
  {
    id: 'dots-studio/dots-3-note-preview:free',
    provider: 'openrouter',
    contextWindow: 512_000,
    tools: true,
    reliability: 'flaky',
    verifiedOn: '2026-10-07',
    note: 'Strong with notes. Hit the per-minute free cap during probing.',
  },
  {
    id: 'llama3.2',
    provider: 'ollama',
    contextWindow: 32_768,
    tools: false,
    reliability: 'stable',
    verifiedOn: 'n/a — local',
    note: 'Truly local and unmetered. Needs Ollama running, and no tool calls.',
  },
];

/**
 * Confirmed dead on the free tier as of `verifiedOn`.
 *
 * Kept because "we tried it and it does not work" is worth more than silence:
 * it stops someone re-testing the same models, and it is the list to re-check
 * first when the free tier rotates.
 */
export const FREE_MODELS_REJECTED: Array<{ id: string; reason: string }> = [
  { id: 'thinkingmachines/inkling:free', reason: '403 — only available inside a coding harness' },
  { id: 'thinkingmachines/inkling-small:free', reason: '403 — only available inside a coding harness' },
  { id: 'meta-llama/llama-3.3-70b-instruct:free', reason: 'unavailable for free' },
  { id: 'qwen/qwen-2.5-72b-instruct:free', reason: 'unavailable for free' },
  { id: 'google/gemini-2.0-flash-exp:free', reason: 'no endpoints found' },
  { id: 'google/gemma-4-31b-it:free', reason: 'provider returned error' },
  { id: 'google/gemma-4-26b-a4b-it:free', reason: 'provider returned error' },
  { id: 'poolside/laguna-s-2.1:free', reason: 'provider returned error' },
  { id: 'poolside/laguna-xs-2.1:free', reason: 'provider returned error' },
  { id: 'inclusionai/ling-3.1-flash', reason: 'provider returned error' },
  { id: 'cohere/north-mini-code:free', reason: 'rate limited on every attempt' },
  { id: 'apodex/apodex-1.1-mini:free', reason: 'empty body, finish_reason "length"' },
  { id: 'liquid/lfm-2.5-2.6b:free', reason: 'empty body, finish_reason "length"' },
  { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', reason: 'empty body' },
];

/**
 * The free tier has a hard per-minute request cap.
 *
 * Observed live as `Rate limit exceeded: free-models-per-min.` A bot that bursts
 * will hit it, and the symptom is a confusing empty reply rather than an error —
 * so `complete()` surfaces the message instead of swallowing it.
 */
export const FREE_TIER_NOTES = [
  'The free tier enforces a per-minute request cap. Exceeding it returns a rate-limit error, not a queue.',
  'Some models return an empty body with finish_reason "length" instead of an error. A retry usually succeeds.',
  'Availability rotates. Re-probe before trusting this list.',
];

/**
 * Run a completion against a chain of models, falling back on failure.
 *
 * The free tier is **intermittently unavailable** — verified live, with Nvidia's
 * endpoint returning `Upstream error: Service temporarily unavailable` for
 * stretches of 30-100 seconds while other free models answered fine. A bot pinned
 * to one free model therefore drops replies at random, which looks like the bot
 * being broken rather than the endpoint being down.
 *
 * Only *retryable* failures fall through. A rate limit, a refusal, and a missing
 * key are not fixed by switching models — a missing key is missing on every
 * model from that provider — so they surface immediately.
 */
export async function completeWithFallback(
  configs: ProviderConfig[],
  history: ChatMessage[],
  options: { tools?: ToolRegistry; system?: string; attempts?: number } = {},
): Promise<Completion & { fellBackFrom?: string }> {
  if (configs.length === 0) {
    return { text: '', provider: 'echo', model: 'none', error: 'no models configured' };
  }

  const primary = configs[0] as ProviderConfig;
  const attempts: string[] = [];

  for (const config of configs) {
    const result = await complete(config, history, options);
    attempts.push(`${config.model}: ${result.error ? `failed (${result.error.slice(0, 60)})` : 'ok'}`);

    const retryable = isTransientUpstream(result.error) || result.rateLimited === true
      || isEmptyResponse(result);

    if (!result.error && result.text) {
      return {
        ...result,
        ...(config.model !== primary.model ? { fellBackFrom: primary.model } : {}),
      };
    }

    // A refusal or a missing key is not going to change with a different model.
    if (!retryable || config === configs[configs.length - 1]) {
      return {
        ...result,
        ...(attempts.length > 1 ? { error: `${result.error} (tried ${attempts.join('; ')})` } : {}),
      };
    }
  }

  return { text: '', provider: primary.provider, model: primary.model, error: attempts.join('; ') };
}

/**
 * Build a fallback chain from the verified stable free models.
 *
 * Ordered by context window, then reliability. Ollama is excluded: it is not a
 * hosted model, so a chain that reaches it after three network failures will
 * just fail again locally.
 */
export function freeFallbackChain(
  options: { models?: string[]; env?: NodeJS.ProcessEnv; temperature?: number } = {},
): ProviderConfig[] {
  const ids = options.models ?? recommendedFreeModels().map((m) => m.id);

  return ids
    .map((id) => freeModel(id))
    .filter((m): m is FreeModel => Boolean(m))
    .filter((m) => m.provider !== 'ollama')
    .map((m) => freeConfig(m, {
      ...(options.env ? { env: options.env } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    }));
}

/** Look up a known free model by id. */
export function freeModel(id: string): FreeModel | undefined {
  return FREE_MODELS.find((m) => m.id === id);
}

/**
 * Models that are free, support tools, and have the largest context.
 *
 * Only `reliability: 'stable'` entries by default. Including flaky models here
 * would mean a bot that drops every fourth reply — the exact failure the whole
 * verification effort exists to prevent.
 */
export function recommendedFreeModels(options: { requireTools?: boolean; includeFlaky?: boolean } = {}): FreeModel[] {
  const requireTools = options.requireTools !== false;
  return FREE_MODELS
    .filter((m) => !requireTools || m.tools)
    .filter((m) => options.includeFlaky || m.reliability === 'stable')
    .sort((a, b) => b.contextWindow - a.contextWindow);
}

/** Which environment variable holds each provider's key. */
const KEY_ENV: Partial<Record<ProviderId, string>> = {
  openrouter: 'OPENROUTER_API_KEY',
  groq: 'GROQ_API_KEY',
  gemini: 'GEMINI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

/**
 * Assert a provider has a usable key.
 *
 * Names the missing variable rather than throwing a bare "unauthorised", because
 * the most common cause is a typo'd env var and the fix is obvious once named.
 */
export function assertUsableKey(
  config: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (PROVIDER_DEFAULTS[config.provider].keyless) return;
  if (config.apiKey || resolveApiKey({ env })) return;

  throw new Error(
    `${config.provider} needs an api key — set ${KEY_ENV[config.provider] ?? 'the provider key'} in the environment`,
  );
}

/**
 * Resolve a provider key from the environment.
 *
 * **Keys are never hardcoded.** A key in source is a key in git history, and this
 * is a published package — `npm publish` would ship it to everyone. An explicitly
 * passed key wins; otherwise the environment is read.
 */
export function resolveApiKey(config: {
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  if (config.apiKey) return config.apiKey;

  const env = config.env ?? process.env;
  for (const variable of Object.values(KEY_ENV)) {
    const value = env[variable];
    if (value) return value;
  }
  return undefined;
}

/** Build a provider config for a free model, with the key read from env. */
export function freeConfig(
  model: FreeModel,
  options: { env?: NodeJS.ProcessEnv; apiKey?: string; temperature?: number } = {},
): ProviderConfig {
  return {
    provider: model.provider,
    model: model.id,
    baseUrl: PROVIDER_DEFAULTS[model.provider].baseUrl,
    contextWindow: model.contextWindow,
    // 32k, measured. The full system prompt (~2.3 KB of output-form teaching and
    // grounding rules) reliably produced a correctly-tagged `<<poll>>` block at
    // this size. At 16k the same call intermittently returned nothing — but that
    // turned out to be Nvidia's endpoint returning "Service temporarily
    // unavailable", not a budget problem. Headroom is cheap here because a chat
    // reply is short, so the ceiling costs nothing when it is not used.
    maxTokens: 32_000,
    timeoutMs: 60_000,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    // The key is deliberately *not* copied into the returned object when it came
    // from the environment — `complete()` resolves it again at call time, so a
    // config object logged or serialised cannot leak a credential.
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
  };
}

/** OpenAI and every OpenAI-compatible endpoint (groq, openrouter, ollama, most proxies). */
async function openaiCompatible(
  base: string,
  config: ProviderConfig,
  history: ChatMessage[],
  opts: {
    temperature: number;
    maxTokens: number;
    timeoutMs: number;
    tools?: ToolRegistry;
  },
): Promise<Completion> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages: history.map((m) => ({ role: m.role, content: m.content })),
    temperature: opts.temperature,
    max_tokens: opts.maxTokens,
  };

  if (opts.tools && opts.tools.names.length > 0) {
    body.tools = opts.tools.describe();
    body.tool_choice = 'auto';
  }

  const response = await fetchTimeout(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  }, opts.timeoutMs);

  const json = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        refusal?: string | null;
        /** Present on reasoning models; the answer sometimes lands here. */
        reasoning?: string | null;
      };
      finish_reason?: string | null;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    error?: { message?: string };
  };

  if (!response.ok) {
    return {
      text: '',
      provider: config.provider,
      model: config.model,
      error: json.error?.message ?? `HTTP ${response.status}`,
    };
  }

  const message = json.choices?.[0]?.message;
  const content = message?.content?.trim();
  const reasoning = (message as { reasoning?: string } | undefined)?.reasoning?.trim();

  // **Never send a model's scratchpad to the user.**
  //
  // Some providers put reasoning in `content` rather than a separate field, and
  // the earlier version fell back to `message.reasoning` when content was
  // empty — which shipped a paragraph of "The user wants me to… Let me think…
  // I'll use the send_poll tool" straight into the WhatsApp chat. Observed live.
  //
  // Reasoning is not an answer. If it is all we got, the turn failed; the caller
  // retries or reports, and the user never sees the internals.
  const text = content ?? '';

  const toolCalls = (message as { tool_calls?: unknown[] } | undefined)?.tool_calls ?? [];

  if (!text && toolCalls.length === 0) {
    const reason = json.choices?.[0]?.finish_reason;
    // Distinguish "burned the budget thinking" from "only thought, no answer".
    const thoughtOnly = Boolean(reasoning);
    return {
      text: '',
      provider: config.provider,
      model: config.model,
      refused: Boolean(message?.refusal),
      error: thoughtOnly
        ? `model returned reasoning but no answer (${reasoning?.length ?? 0} chars of scratchpad, finish_reason: ${reason ?? 'unknown'})`
        : `empty response (finish_reason: ${reason ?? 'unknown'})`,
    };
  }

  return {
    text,
    provider: config.provider,
    model: config.model,
    refused: Boolean(message?.refusal),
    ...(toolCalls.length > 0
      ? { toolCalls: toolCalls.map(normaliseToolCall) }
      : {}),
    ...(json.usage
      ? { usage: { prompt: json.usage.prompt_tokens, completion: json.usage.completion_tokens } }
      : {}),
  };
}

/** A tool call, in the shape the engine runs. */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
}

/**
 * Normalise OpenAI's `tool_calls` into `{ id, name, args }`.
 *
 * `function.arguments` is a **JSON string**, not an object — parsing it is the
 * whole point, and a malformed one must not throw, because a tool call that
 * cannot be parsed is a tool call that must be reported as failed rather than
 * crash the turn.
 */
function normaliseToolCall(raw: any): ToolCall {
  const fn = raw?.function ?? {};
  let args: Record<string, any> = {};

  if (typeof fn.arguments === 'string' && fn.arguments.length > 0) {
    try {
      const parsed = JSON.parse(fn.arguments);
      if (parsed && typeof parsed === 'object') args = parsed;
    } catch {
      args = {};
    }
  } else if (fn.arguments && typeof fn.arguments === 'object') {
    args = fn.arguments;
  }

  return { id: String(raw?.id ?? ''), name: String(fn.name ?? ''), args };
}

/**
 * Anthropic.
 *
 * The API takes `system` as a **top-level field**, not a message role — sending
 * it as a message is the single most common integration mistake here, and the
 * model then just ignores your instructions.
 */
async function anthropic(
  base: string,
  config: ProviderConfig,
  history: ChatMessage[],
  opts: { temperature: number; maxTokens: number; timeoutMs: number },
): Promise<Completion> {
  const system = history.find((m) => m.role === 'system')?.content;
  const messages = history
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));

  const response = await fetchTimeout(`${base}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.apiKey ?? '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature,
      ...(system ? { system } : {}),
      messages,
    }),
  }, opts.timeoutMs);

  const json = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { message?: string };
  };

  if (!response.ok) {
    return {
      text: '',
      provider: 'anthropic',
      model: config.model,
      error: json.error?.message ?? `HTTP ${response.status}`,
    };
  }

  const text = (json.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');

  return {
    text,
    provider: 'anthropic',
    model: config.model,
    refused: json.stop_reason === 'refusal',
    ...(json.usage
      ? { usage: { prompt: json.usage.input_tokens, completion: json.usage.output_tokens } }
      : {}),
  };
}

/**
 * Gemini.
 *
 * `contents` uses `user`/`model` roles, not `user`/`assistant`, and the model
 * name goes in the **URL** rather than the body.
 */
async function gemini(
  base: string,
  config: ProviderConfig,
  history: ChatMessage[],
  opts: { temperature: number; maxTokens: number; timeoutMs: number },
): Promise<Completion> {
  const system = history.find((m) => m.role === 'system')?.content;

  const contents = history
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

  const url = `${base}/models/${encodeURIComponent(config.model)}:generateContent`
    + `?key=${encodeURIComponent(config.apiKey ?? '')}`;

  const response = await fetchTimeout(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents,
      generationConfig: { temperature: opts.temperature, maxOutputTokens: opts.maxTokens },
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    }),
  }, opts.timeoutMs);

  const json = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    error?: { message?: string };
  };

  if (!response.ok) {
    return {
      text: '',
      provider: 'gemini',
      model: config.model,
      error: json.error?.message ?? `HTTP ${response.status}`,
    };
  }

  const text = (json.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? '')
    .join('');

  return {
    text,
    provider: 'gemini',
    model: config.model,
    ...(json.usageMetadata
      ? { usage: { prompt: json.usageMetadata.promptTokenCount, completion: json.usageMetadata.candidatesTokenCount } }
      : {}),
  };
}

/**
 * Deterministic local provider.
 *
 * Exists so the toolkit is runnable and testable with no key, and so a
 * deployment can prove the *plumbing* works before anyone enables a paid
 * model. It reflects the last user turn rather than inventing a reply.
 */
function echoCompletion(model: string, history: ChatMessage[]): Completion {
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  const facts = history.find((m) => m.role === 'system')?.content ?? '';

  const hasMemory = /Known facts about this user/.test(facts);
  const lines = [
    lastUser ? `You said: ${lastUser.content}` : 'No user message received.',
    hasMemory ? 'I have remembered facts about you.' : 'I have no remembered facts yet.',
    '(echo provider — deterministic, no model involved.)',
  ];

  return {
    text: lines.join('\n'),
    provider: 'echo',
    model,
    usage: { prompt: estimateMessages(history) },
  };
}

/* ════════════════════════════════════════════════════════════════════════
   Honesty
   ════════════════════════════════════════════════════════════════════════ */

/** Claims that indicate the model narrated an action. */
const FABRICATION_PATTERNS: Array<{ re: RegExp; why: string }> = [
  // Contractions first. "I've sent the file" is how a model phrases this in
  // practice, and a pattern written only for "I have sent" misses it — which
  // is the same as having no check at all.
  { re: /\b(?:i|we)(?:'ve|'ll|'m)?\s+(?:have\s+|has\s+|already\s+|now\s+|just\s+)?(?:sent|deleted|removed|banned|forwarded|paid|saved|uploaded|downloaded|created|posted)\b/i, why: 'claims a completed action' },
  { re: /\b(?:i|we) have\s+(?:sent|deleted|removed|banned|forwarded|paid|saved|uploaded|created)\b/i, why: 'claims a completed action' },
  { re: /\b(?:it|that|this) (?:has been|was|is now)\s+(?:sent|deleted|removed|posted|saved)\b/i, why: 'claims a completed action' },
  { re: /\b(downloaded|saved) (?:it |the file )?(?:successfully|to disk)\b/i, why: 'claims a filesystem write' },
  { re: /\b(i (?:searched|looked) (?:it )?up online)\b/i, why: 'claims a live lookup it may not have made' },
];

/**
 * Flag text that narrates an action without a matching successful tool call.
 *
 * This is a **heuristic check, not a guarantee.** It catches the confident
 * common cases — "I've sent the file", "done, deleted" — which are exactly the
 * responses that destroy trust when they are false. It cannot catch a model
 * that lies in a phrasing nobody anticipated.
 *
 * Return the flagged phrases so a caller can decide. Do not auto-strip: some
 * legitimate replies describe a past action the user already knows about.
 */
export function assertNoFabrication(
  text: string,
  outcome: RunOutcome | null,
): { clean: boolean; flags: Array<{ phrase: string; why: string }> } {
  const flags: Array<{ phrase: string; why: string }> = [];

  for (const { re, why } of FABRICATION_PATTERNS) {
    const match = re.exec(text);
    if (match) flags.push({ phrase: match[0], why });
  }

  // A refusal or a failure means nothing succeeded, so any completion claim is
  // a fabrication regardless of phrasing.
  if (outcome && !outcome.anyOk && flags.length > 0) {
    for (const flag of flags) {
      flag.why += ' — and no tool succeeded';
    }
  }

  return { clean: flags.length === 0, flags };
}

/**
 * Build a system prompt that makes the honesty rule hard to ignore.
 *
 * Kept as a function rather than a constant so callers can extend it. The
 * constraint is stated three ways — positively, negatively, and with the
 * operational rule — because instruction-following degrades on long prompts.
 */
/**
 * Flux's default identity and voice.
 *
 * Kept as exported constants rather than inlined so a caller can extend the
 * persona without replacing the parts that carry the safety rules — the
 * grounding block and the honesty constraint must survive any persona edit.
 */
export const FLUX_PERSONA =
  'You are Flux, a friendly WhatsApp assistant. You are genuinely helpful, direct, and warm. '
  + 'You are the developer of this bot — you built it, you maintain it, and you know it best. '
  + 'Speak like a person who is genuinely glad to help, not like a help desk.';

/**
 * Tone variants, chosen by context.
 *
 * **Deterministic, not random.** The persona is derived from the user's language
 * and the shape of their message, so a user talking to Flux in Indonesian gets a
 * consistently Indonesian-flavoured assistant, and the same user on the next
 * message gets the *same* one. Randomising per turn would make the bot feel like
 * it has a personality disorder — the same person asking two questions gets two
 * different assistants.
 *
 * The safety-relevant parts of the prompt never vary. Only the surface warmth does.
 */
export const FLUX_TONES = [
  { id: 'warm', hint: 'Warm and encouraging. Celebrate the user\'s progress genuinely.' },
  { id: 'brisk', hint: 'Brief and businesslike. Lead with the answer, no preamble.' },
  { id: 'playful', hint: 'Light humour where it fits. Never at the user\'s expense.' },
  { id: 'steady', hint: 'Calm and plain. Best for anything serious or emotional.' },
  { id: 'curious', hint: 'Ask one good follow-up when it would genuinely help.' },
  { id: 'precise', hint: 'Exact and technical. Skip the softening, keep every qualifier.' },
] as const;

/**
 * Pick a tone from context. Same context in, same tone out — every time.
 */
export function toneForContext(input: {
  lang?: string;
  tone?: string;
  isQuestion: boolean;
  wordCount: number;
}): (typeof FLUX_TONES)[number] {
  // An explicit request wins, then language, then the shape of the message.
  if (input.tone) {
    const named = FLUX_TONES.find((t) => t.id === input.tone);
    if (named) return named;
  }

  const lang = input.lang?.split('-')[0] ?? 'en';
  const hash = [...lang, input.isQuestion ? 'q' : 'a', String(Math.min(9, Math.floor(input.wordCount / 8)))]
    .join('');

  // FNV-1a: tiny, stable, and good enough to spread six tones without a dep.
  let h = 0x811c9dc5;
  for (let i = 0; i < hash.length; i += 1) {
    h ^= hash.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }

  return FLUX_TONES[h % FLUX_TONES.length] as (typeof FLUX_TONES)[number];
}

/**
 * How Flux sounds like a person rather than a form.
 *
 * Stated as *guidance with limits*, not as "be emotional". Two reasons:
 *
 *  - A model told only "use emotions" produces confetti — a laughing emoji on a
 *    server outage. The pairing rule below is what stops that.
 *  - Punctuation discipline matters as much as emoji. Two exclamation marks read
 *    as enthusiasm; five read as a bot having a breakdown.
 *
 * The limit is one sentence because an unbounded instruction produces a bot that
 * apologises to bots.
 */
export const FLUX_VOICE = [
  'Voice:',
  '- Write like a person texting a friend, not like documentation. Vary your sentence length; identical structure every reply is what reads as artificial.',
  '- Use 0-2 emoji when they carry meaning. A reaction, a warm close, a "noted". Never decorate every sentence.',
  '- Match the user. If they are terse, be terse. If they are frustrated, acknowledge it directly before fixing anything.',
  '- Emoji must never contradict the content. No celebration on a failure, no joke on a death, no emoji on a serious warning.',
  '- Never more than two consecutive exclamation marks, and never emoji used to paper over a refusal.',
].join('\n');

/**
 * The output language Flux speaks.
 *
 * Placed before the tool list on purpose: a model that has not been told which
 * tagged format to emit will default to plain prose, and every poll and menu
 * then silently degrades to a numbered text list. This is the highest-leverage
 * sentence in the whole prompt — it is why the feature layer is usable at all.
 */
export const FLUX_OUTPUT_FORMS = [
  'Output forms — emit the tagged block when one applies, plain text when none does:',
  '',
  'A poll (add "(multi)" to the question for multi-select):',
  '<<poll>>',
  'Which works better?',
  '- Option one',
  '- Option two',
  '<<end>>',
  '',
  'A selectable menu:',
  '<<list>>',
  'What do you need?',
  '- Reports : weekly numbers',
  '- Invoices : payment history',
  '<<end>>',
  '',
  'Quick-reply buttons (max 3 — WhatsApp renders more poorly):',
  '<<buttons>>',
  'Confirm?',
  '- Yes',
  '- No',
  '<<end>>',
  '',
  'A location:',
  '<<location>>',
  '-6.2088, 106.8456, Jakarta, Indonesia',
  '<<end>>',
  '',
  'A contact card:',
  '<<contact>>',
  'Name, +62 812 3456 7890',
  '<<end>>',
  '',
  'Text styling: <<heading>>Title<<end>> for bold, <<note>>aside<<end>> for italic,',
  '<<code>>block<<end>> for monospace, <<quote>>quoted<<end>>, <<link>>url caption<<end>>.',
  '',
  'Only ONE structured block per message. If you need two, send the first and say',
  'the second is coming. Never put a structured block inside a code fence.',
].join('\n');

/**
 * Build Flux's system prompt.
 *
 * Section order is deliberate: identity → grounding → voice → output forms →
 * tools → format. Grounding sits high because instruction-following degrades as
 * a prompt grows, and the rules that prevent a confident lie must not be the
 * ones that get dropped.
 */
export function systemPrompt(options: {
  persona?: string;
  tools?: ToolRegistry;
  /** What the bot is for. Shown to the model, not the user. */
  purpose?: string;
  /** Set when tools exist, to state the grounding rule. */
  extra?: string;
  /** Omit to use Flux's voice and output-forms sections. */
  voice?: string | false;
  outputForms?: string | false;
  /**
   * The chat this turn is happening in.
   *
   * Without it the model **invents a jid**. Observed live: asked to make a
   * poll, Flux called `send_poll` with a fabricated number, the tool correctly
   * refused, and the bot had to explain the failure instead of just sending the
   * poll. Telling it the jid is the difference between a working tool and a
   * correctly-failing one.
   */
  chat?: { jid: string; isGroup: boolean };
  /** Drives tone selection. Same context in, same tone out. */
  context?: { lang?: string; tone?: string; isQuestion: boolean; wordCount: number };
}): string {
  const parts: string[] = [];

  parts.push(options.persona ?? FLUX_PERSONA);
  if (options.purpose) parts.push(`Your purpose: ${options.purpose}`);

  // The grounding block is not optional and has no override. A caller can
  // replace the persona; they cannot accidentally remove the honesty rule.
  parts.push(
    'Grounding rules, in priority order:\n'
    + '1. Never claim you performed an action you did not perform. If a tool call '
    + 'failed or returned ok:false, say what failed and why.\n'
    + '2. Never state a fact about the user that is not in your known-facts block or '
    + 'this conversation.\n'
    + '3. When you do not know, say you do not know. A correct refusal is a better '
    + 'answer than a confident guess.\n'
    + '4. If a tool you need is missing or denied, name it. Do not silently '
    + 'approximate the action it would have performed.\n'
    + '5. If you were sent an image or a file you could not actually read, say so. '
    + 'Never describe what it looks like — you did not see it.',
  );

  // Identity facts. A model asked "who made you" without these will either guess
  // or say it is an AI made by nobody.
  parts.push(
    'About you:\n'
    + '- Your name is Flux.\n'
    + `- Your role is ${FLUX_DESCRIPTION}.\n`
    + '- You are built and maintained by Nyx.\n'
    + `- If asked for the owner's contact, give ${OWNER_DISPLAY} exactly as written.`,
  );

  if (options.voice !== false) {
    parts.push(`${options.voice ?? FLUX_VOICE}\n\nTone for this turn: ${toneForContext(options.context ?? { isQuestion: false, wordCount: 0 }).hint}`);
  }
  if (options.outputForms !== false) parts.push(options.outputForms ?? FLUX_OUTPUT_FORMS);

  if (options.tools && options.tools.names.length > 0) {
    parts.push(
      `Tools available to you:\n${options.tools.names.map((n) => `- ${n}`).join('\n')}\n`
      + 'Reach for these rather than describing what you would do. Report their real '
      + 'results, including failures — a tool that failed is information, not noise.',
    );
  }

  // The chat jid, placed with the tools because that is when it is needed.
  if (options.chat && options.tools && options.tools.names.length > 0) {
    parts.push(
      `This conversation is with ${options.chat.jid}${options.chat.isGroup ? ' (a group)' : ''}.\n`
      + 'Use exactly that jid for any tool that takes one. Never invent, guess, or '
      + 'reconstruct a jid from a phone number — a wrong jid is rejected, and you '
      + 'will then have to explain a failure instead of doing the thing.',
    );
  }

  parts.push(
    'Format for WhatsApp: short paragraphs, plain text. Use *bold*, _italic_, '
    + '```mono```. Do not use markdown tables or headers — they do not render. '
    + 'Keep replies short unless asked for detail. No preamble: start with the answer.',
  );

  if (options.extra) parts.push(options.extra);
  return parts.join('\n\n');
}

/* ════════════════════════════════════════════════════════════════════════
   Tool factories
   ════════════════════════════════════════════════════════════════════════ */

/** Wrap a socket so the model can read and send without bespoke plumbing. */
export function whatsAppTools(sock: AnySock, options: {
  /** Restrict the model to this jid. Strongly recommended. */
  allowedJid?: string;
  /** Allow it to send. Off by default — sending is visible to a human. */
  allowSend?: boolean;
  maxTextLength?: number;
}): Tool[] {
  const maxLength = options.maxTextLength ?? 4096;

  const guard = (jid: string): string => {
    if (options.allowedJid && jid !== options.allowedJid) {
      throw new Error(`jid not permitted: ${jid}`);
    }
    return jid;
  };

  const tools: Tool[] = [
    {
      name: 'send_message',
      description: 'Send a WhatsApp text message to the permitted chat.',
      mutating: true,
      parameters: {
        type: 'object',
        properties: {
          jid: { type: 'string', description: 'Recipient jid.' },
          text: { type: 'string', description: 'Message text.' },
        },
        required: ['jid', 'text'],
      },
      run: async (args) => {
        if (!options.allowSend) throw new Error('sending is not enabled');
        const result = await sock.sendMessage(guard(args.jid), {
          text: String(args.text ?? '').slice(0, maxLength),
        } as never);
        return { messageId: result?.key?.id ?? null };
      },
    },
    {
      name: 'send_poll',
      description: 'Send a poll. Set multi:true for a multi-select poll.',
      mutating: true,
      parameters: {
        type: 'object',
        properties: {
          jid: { type: 'string' },
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 12 },
          multi: { type: 'boolean', description: 'Allow selecting more than one option.' },
        },
        required: ['jid', 'question', 'options'],
      },
      run: async (args) => {
        const list = (Array.isArray(args.options) ? args.options : []).map(String);
        if (list.length < 2) throw new Error('a poll needs at least two options');

        const result = await sock.sendMessage(guard(args.jid), {
          poll: {
            name: String(args.question ?? ''),
            values: list,
            selectableCount: args.multi === true ? list.length : 1,
          },
        } as never);
        return { messageId: result?.key?.id ?? null };
      },
    },
    {
      name: 'send_list_menu',
      description: 'Send a selectable list menu. Rows are "title : description".',
      mutating: true,
      parameters: {
        type: 'object',
        properties: {
          jid: { type: 'string' },
          title: { type: 'string' },
          rows: {
            type: 'array',
            minItems: 1,
            maxItems: 10,
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                description: { type: 'string' },
              },
              required: ['title'],
            },
          },
        },
        required: ['jid', 'title', 'rows'],
      },
      run: async (args) => {
        const raw = Array.isArray(args.rows) ? args.rows : [];
        // Rows must carry `id` on the wire. `rowId` yields a stanza the client
        // accepts and then renders nothing, so it is derived here.
        const rows = raw.map((row: Record<string, any>, i: number) => ({
          header: '',
          title: String(row?.title ?? ''),
          description: String(row?.description ?? ''),
          id: String(row?.id ?? row?.rowId ?? String(row?.title ?? `row${i}`))
            .toLowerCase().replace(/\W+/g, '_').slice(0, 40),
        }));

        if (rows.length === 0) throw new Error('a menu needs at least one row');

        const title = String(args.title ?? 'Menu');
        const result = await sock.sendMessage(guard(args.jid), {
          listMessage: {
            title,
            description: '',
            buttonText: rows[0]?.title ?? 'Select',
            sections: [{ title, rows }],
          },
        } as never);
        return { messageId: result?.key?.id ?? null };
      },
    },
    {
      name: 'send_buttons',
      description: 'Send quick-reply buttons. WhatsApp renders at most three well.',
      mutating: true,
      parameters: {
        type: 'object',
        properties: {
          jid: { type: 'string' },
          text: { type: 'string', description: 'Body text above the buttons.' },
          buttons: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 },
        },
        required: ['jid', 'text', 'buttons'],
      },
      run: async (args) => {
        const labels = (Array.isArray(args.buttons) ? args.buttons : []).map(String);
        if (labels.length === 0) throw new Error('no buttons given');

        const result = await sock.sendMessage(guard(args.jid), {
          buttonsMessage: {
            contentText: String(args.text ?? ''),
            footerText: '',
            headerText: String(args.text ?? ''),
            buttons: labels.map((label) => ({
              buttonId: label.toLowerCase().replace(/\W+/g, '_').slice(0, 40),
              buttonText: { displayText: label },
            })),
          },
        } as never);
        return { messageId: result?.key?.id ?? null };
      },
    },
    {
      name: 'send_location',
      description: 'Send a location pin. Both coordinates are required.',
      mutating: true,
      parameters: {
        type: 'object',
        properties: {
          jid: { type: 'string' },
          lat: { type: 'number' },
          lon: { type: 'number' },
          name: { type: 'string' },
          address: { type: 'string' },
        },
        required: ['jid', 'lat', 'lon'],
      },
      run: async (args) => {
        const lat = Number(args.lat);
        const lon = Number(args.lon);
        // A pin with a missing coordinate does not render and rc14 will not
        // say why, so refuse rather than send something invisible.
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          throw new Error('lat and lon must be numbers');
        }
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('coordinates out of range');

        const result = await sock.sendMessage(guard(args.jid), {
          location: {
            degreesLatitude: lat,
            degreesLongitude: lon,
            ...(args.name ? { name: String(args.name) } : {}),
            ...(args.address ? { address: String(args.address) } : {}),
          },
        } as never);
        return { messageId: result?.key?.id ?? null };
      },
    },
    {
      name: 'send_contact_card',
      description: 'Send a contact card (vCard).',
      mutating: true,
      parameters: {
        type: 'object',
        properties: {
          jid: { type: 'string' },
          name: { type: 'string' },
          phone: { type: 'string' },
        },
        required: ['jid', 'name'],
      },
      run: async (args) => {
        const name = String(args.name ?? '');
        const phone = String(args.phone ?? '');
        const digits = phone.replace(/\D/g, '');

        const result = await sock.sendMessage(guard(args.jid), {
          contacts: {
            displayName: name,
            contacts: [{
              vcard: ['BEGIN:VCARD', 'VERSION:3.0', `FN:${name}`,
                ...(digits ? [`TEL;type=CELL;waid=${digits}:${phone}`] : []),
                'END:VCARD'].join('\n'),
            }],
          },
        } as never);
        return { messageId: result?.key?.id ?? null };
      },
    },
    {
      name: 'react_to_message',
      description: 'React to a message in this chat. Pass an empty reaction to remove it.',
      mutating: true,
      parameters: {
        type: 'object',
        properties: {
          jid: { type: 'string' },
          messageId: { type: 'string' },
          emoji: { type: 'string' },
        },
        required: ['jid', 'messageId'],
      },
      run: async (args) => {
        await sock.sendMessage(guard(args.jid), {
          react: { text: String(args.emoji ?? '') },
        } as never);
        return { reacted: true };
      },
    },
    {
      name: 'set_typing',
      description: 'Show or clear the typing indicator for a chat.',
      mutating: false,
      parameters: {
        type: 'object',
        properties: { jid: { type: 'string' }, typing: { type: 'boolean' } },
        required: ['jid'],
      },
      run: async (args) => {
        // The target jid is required here — omitting it is a silent no-op.
        await sock.sendPresenceUpdate(args.typing === false ? 'paused' : 'composing', guard(args.jid));
        return { typing: args.typing !== false };
      },
    },
    {
      name: 'check_number',
      description: 'Check whether a phone number has a WhatsApp account.',
      parameters: {
        type: 'object',
        properties: { number: { type: 'string' } },
        required: ['number'],
      },
      run: async (args) => {
        const digits = String(args.number ?? '').replace(/\D/g, '');
        const results = (await sock.onWhatsApp(digits)) as Array<{ exists?: boolean; jid?: string }>;
        const hit = results?.find((r) => r.exists);
        return hit ? { exists: true, jid: hit.jid } : { exists: false };
      },
    },
    {
      name: 'chat_info',
      description: 'Read metadata about a chat.',
      parameters: {
        type: 'object',
        properties: { jid: { type: 'string' } },
        required: ['jid'],
      },
      run: async (args) => {
        const jid = guard(args.jid);
        if (jid.endsWith('@g.us')) {
          const meta = (await sock.groupMetadata(jid)) as Record<string, unknown>;
          return { subject: meta.subject, size: meta.size, description: meta.desc ?? null };
        }
        return { type: 'direct', jid };
      },
    },
    {
      name: 'download_media',
      description: 'Download a file from an http(s) URL and send it as media.',
      mutating: true,
      parameters: {
        type: 'object',
        properties: {
          jid: { type: 'string' },
          url: { type: 'string' },
          caption: { type: 'string' },
          asVoice: { type: 'boolean', description: 'Send as a voice note.' },
        },
        required: ['jid', 'url'],
      },
      run: async (args) => {
        const { downloadAndSend } = await import('./media-fetch.js');
        return downloadAndSend(sock, guard(args.jid), String(args.url ?? ''), {
          caption: args.caption ? String(args.caption) : undefined,
          asVoice: args.asVoice === true,
        });
      },
    },
  ];

  return tools;
}

/**
 * The full Flux tool set.
 *
 * Everything `whatsAppTools` provides, pre-registered, with the read-only tools
 * already approved. Mutating tools stay unapproved so "enable everything" cannot
 * silently grant the ability to send, react, or download.
 */
export function fluxTools(sock: AnySock, options: {
  allowedJid?: string;
  allowSend?: boolean;
} = {}): ToolRegistry {
  const registry = new ToolRegistry();

  registry.registerAll(whatsAppTools(sock, options));
  // Only the non-mutating tools. `approveSafe()` already refuses anything
  // flagged mutating, so this cannot widen access by accident.
  registry.approveSafe();

  return registry;
}

/**
 * Wrap any HTTP JSON endpoint as a tool — the seam for "download via REST API".
 *
 * Deliberately narrow: GET only by default, an allowlist of hosts, and a
 * response size cap. A model that can call arbitrary URLs can be walked into
 * reaching internal services, which is a real risk in a bot that reads URLs out
 * of chat messages.
 */
export function restTool(options: {
  name: string;
  description: string;
  url: string;
  /** Extra query parameters merged into the request. */
  params?: Record<string, string | number>;
  /** Hostnames this tool may reach. Everything else is refused. */
  allowedHosts: string[];
  timeoutMs?: number;
  /** Refuse non-GET. Set only when the endpoint is genuinely read-only. */
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  maxBytes?: number;
}): Tool {
  const method = options.method ?? 'GET';
  const maxBytes = options.maxBytes ?? 2_000_000;

  return {
    name: options.name,
    description: options.description,
    mutating: false,
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Primary input, usually an id or url fragment.' },
      },
      required: ['input'],
    },
    run: async (args) => {
      const url = new URL(options.url);

      const host = url.hostname.toLowerCase();
      const permitted = options.allowedHosts.some(
        (h) => host === h.toLowerCase() || host.endsWith(`.${h.toLowerCase()}`),
      );
      if (!permitted) throw new Error(`host not allowed: ${host}`);

      for (const [k, v] of Object.entries(options.params ?? {})) {
        url.searchParams.set(k, String(v));
      }
      if (args.input !== undefined) url.searchParams.set('input', String(args.input));

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);

      try {
        const response = await fetch(url, {
          method,
          headers: options.headers,
          signal: controller.signal,
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const text = await response.text();
        if (text.length > maxBytes) {
          throw new Error(`response too large: ${text.length} > ${maxBytes}`);
        }

        try {
          return JSON.parse(text);
        } catch {
          return { text: text.slice(0, 2000) };
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
}