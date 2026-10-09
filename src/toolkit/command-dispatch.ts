/**
 * Command dispatch — the `flux` prefix, and fuzzy fallback.
 *
 * ## Prefix policy
 *
 * The brand is **Flux**, so the canonical prefix is `flux`. Accepted, because
 * people type these without thinking and a bot that rejects them looks broken:
 *
 *   flux ping          the canonical form
 *   flux/ ping         no space before the slash
 *   flux: ping         colon separator
 *   flux.ai ping       the "flux ai" form
 *   fluxai ping        run together
 *   / ping             legacy, kept so existing users are not broken
 *   ping               bare, when explicitly permitted
 *
 * Anything after the prefix is the command token plus its arguments.
 *
 * ## Why fuzzy is a *reply*, not a silent execution
 *
 * `resolve()` returns candidates and the user picks. Auto-running a near-match
 * is this project's recurring defect in a new costume: doing something the user
 * did not ask for and reporting success. A wrong command that runs is worse
 * than a wrong command that is only suggested.
 */

import type { CommandRegistry, CommandResult } from './command-registry.js';
import { resolve, type MatchOptions } from './fuzzy-match.js';

export interface DispatchOptions {
  /** Also accept the command with no prefix at all. Default false. */
  allowBare?: boolean;
  /** Prefix forms to strip before parsing. */
  prefixes?: string[];
  fuzzy?: MatchOptions;
  /** Called when `resolve` returns status `fuzzy`. Defaults to the built-in text. */
  onFuzzy?: (message: string) => string | Promise<string>;
}

/**
 * Default prefix forms, longest first so `flux.ai` is not truncated to `flux`
 * before the `.ai` can be matched.
 */
export const DEFAULT_PREFIXES = ['flux.ai', 'flux-ai', 'fluxai', 'flux/', 'flux:', 'flux_', 'flux.', 'flux ', 'flux', '/'];

export interface Parsed {
  /** True when a prefix was present. */
  prefixed: boolean;
  /** Which prefix matched, if any. */
  prefix?: string;
  /** Command token. */
  token: string;
  /** Everything after the token. */
  args: string;
}

/** Pull the prefix off, if there is one. */
export function parse(body: string, options: DispatchOptions = {}): Parsed {
  const prefixes = options.prefixes ?? DEFAULT_PREFIXES;
  const raw = body.trim();

  for (const p of prefixes) {
    if (raw.toLowerCase().startsWith(p)) {
      return { prefixed: true, prefix: p, token: '', args: '' };
    }
  }

  // The loop above only proves the prefix is present; split off the first token.
  const m = /^(\S+)\s*([\s\S]*)$/.exec(raw);
  const token = m?.[1] ?? '';
  const args = (m?.[2] ?? '').trim();

  if (!options.allowBare) {
    return { prefixed: false, token, args };
  }
  return { prefixed: false, token, args };
}

/**
 * Resolve a message body to a command token + args, stripping the prefix.
 *
 * Separate from `parse` because the prefix table is shared but the resolution
 * rules differ: `parse` is pure string work, this one consults the registry.
 */
export function route(reg: CommandRegistry, body: string, options: DispatchOptions = {}): Parsed {
  const prefixes = options.prefixes ?? DEFAULT_PREFIXES;
  const raw = body.trim();
  const lower = raw.toLowerCase();

  for (const p of prefixes) {
    if (!lower.startsWith(p)) continue;
    const rest = raw.slice(p.length).trim();
    const m = /^(\S+)\s*([\s\S]*)$/.exec(rest);
    return {
      prefixed: true,
      prefix: p,
      token: (m?.[1] ?? '').toLowerCase(),
      args: (m?.[2] ?? '').trim(),
    };
  }

  // No prefix matched. With `allowBare` the whole line is the command.
  const m = /^(\S+)\s*([\s\S]*)$/.exec(raw);
  return {
    prefixed: false,
    token: (m?.[1] ?? '').toLowerCase(),
    args: (m?.[2] ?? '').trim(),
  };
}

export interface DispatchResult extends CommandResult {
  /** What happened — lets the caller log or branch. */
  outcome: 'ran' | 'fuzzy' | 'unknown' | 'no-prefix';
  /** Suggestions offered, when the token was close but not exact. */
  suggestions?: Array<{ name: string; percent: number; summary: string }>;
}

/**
 * Route and run one message.
 *
 * Never throws: a handler that blows up becomes a user-visible error rather
 * than an unhandled rejection that takes the process with it.
 */
export async function dispatch(
  reg: CommandRegistry,
  sock: Parameters<CommandRegistry['run']>[0],
  jid: string,
  body: string,
  options: DispatchOptions & { sender?: string; isOwner?: boolean } = {},
): Promise<DispatchResult> {
  const parsed = route(reg, body, options);

  if (!parsed.token) {
    return { outcome: 'no-prefix', text: 'Usage: flux <command> [args]' };
  }

  // A bare command is refused by default — the prefix is the contract.
  if (!parsed.prefixed && !options.allowBare) {
    return {
      outcome: 'no-prefix',
      text: `"${parsed.token}" needs the flux prefix.\nTry: flux ${parsed.token}\n\n`
        + 'Commands: flux menu · flux help · flux search <term>',
    };
  }

  const resolution = resolve(reg, parsed.token, options.fuzzy);

  if (resolution.status === 'exact' && resolution.command) {
    const result = await reg.run(sock, jid, resolution.command, parsed.args, {
      sender: options.sender,
      isOwner: options.isOwner,
    });
    return { ...result, outcome: 'ran' };
  }

  if (resolution.status === 'fuzzy') {
    const text = options.onFuzzy
      ? await options.onFuzzy(resolution.message)
      : resolution.message;
    return {
      outcome: 'fuzzy',
      text,
      suggestions: resolution.suggestions.map((s) => ({
        name: s.name, percent: s.percent, summary: s.summary,
      })),
    };
  }

  return { outcome: 'unknown', text: resolution.message };
}