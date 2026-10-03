/**
 * Command-argument parsing.
 *
 * Splits a message body after the command into positional words and flags,
 * honouring quoted spans so `/say "hello world"` keeps the phrase together.
 * Small, but it is the difference between a command that feels finished and one
 * that breaks the first time a user types a space inside an argument.
 *
 *   parseArgs('kick 15551234567 --reason "being rude" -f')
 *   // positional: ['kick', '15551234567']
 *   // flags: { reason: 'being rude', f: true }
 */

export interface ParsedArgs {
  /** Non-flag tokens, in order. */
  positional: string[];
  /** `--name value`, `--name=value`, `-f` → `true`. */
  flags: Record<string, string | boolean>;
  /** The raw input, untouched. */
  raw: string;
}

/** Split on whitespace, but keep quoted spans (single or double) whole. */
export function tokenizeArgs(input: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (started) {
        out.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) out.push(current);
  return out;
}

/**
 * Whether a token is a flag rather than a value: long form `--name`, or a short
 * form whose second character is a letter (`-f`). A lone `-`, `--`, or a
 * negative number (`-5`) is not a flag.
 */
function isFlagLike(token: string): boolean {
  if (token.startsWith('--')) return token.length > 2;
  return /^-[A-Za-z]/.test(token);
}

/** Split the text that follows a command into positional and flag arguments. */
export function parseArgs(input: string): ParsedArgs {
  const raw = String(input ?? '');
  const tokens = tokenizeArgs(raw);
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (!isFlagLike(token)) {
      positional.push(token);
      continue;
    }

    const double = token.startsWith('--');
    const body = token.slice(double ? 2 : 1);
    if (!body) {
      positional.push(token);
      continue;
    }

    const eq = body.indexOf('=');
    const inline = eq >= 0;
    const key = inline ? body.slice(0, eq) : body;
    if (!key) {
      positional.push(token);
      continue;
    }

    if (inline) {
      flags[key] = body.slice(eq + 1);
      continue;
    }

    // `--key value` consumes the next token unless it is itself flag-like, so a
    // negative number like `--level -3` is read as the value.
    const next = tokens[i + 1];
    if (next !== undefined && !isFlagLike(next)) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }

  return { positional, flags, raw };
}

/** The value of a flag as a string, or `fallback` when absent or boolean-true. */
export function flagValue(
  flags: Record<string, string | boolean>,
  name: string,
  fallback: string | null = null,
): string | null {
  const value = flags[name];
  return typeof value === 'string' ? value : fallback;
}

/** Whether a flag is present (any form counts). */
export function hasFlag(flags: Record<string, string | boolean>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(flags, name);
}

/** Join positional words back into one string, from `start` onward. */
export function restFrom(positional: readonly string[], start = 0): string {
  return positional.slice(start).join(' ');
}

/** First positional argument, or `null`. */
export function firstArg(positional: readonly string[]): string | null {
  return positional[0] ?? null;
}
