/**
 * Argument parsing for the Super Baileys CLI.
 *
 * Dependency-free on purpose. The CLI has to be able to load and print help
 * even when the rest of the package is broken or half-built, so this file
 * imports nothing from `src/` and nothing from `node_modules`. The argument
 * surface is its own contract, described by specs the commands declare.
 *
 * Supported forms:
 *
 *   --flag              boolean
 *   --no-flag           boolean negation
 *   --key value         string / number
 *   --key=value         string / number
 *   --key a --key b     repeated → readonly string[]
 *   -h -V               built-in help / version
 *   --                  everything after is positional
 *
 * Unknown flags and stray words are errors, not silent no-ops. A CLI that
 * ignores what it does not understand reports success for work it never did.
 */

/* ── specs ────────────────────────────────────────────────────────── */

export type FlagKind = 'boolean' | 'string' | 'number' | 'list';

export type FlagValue = string | number | boolean | readonly string[];

export interface FlagSpec {
  /** Long name, written `--name`. */
  readonly name: string;
  readonly kind: FlagKind;
  /** Single-character alias, written `-s`. */
  readonly short?: string;
  readonly describe: string;
  /** Value label for help, e.g. `<seconds>`. Defaults per kind. */
  readonly placeholder?: string;
  readonly default?: FlagValue;
}

export interface PositionalSpec {
  readonly name: string;
  readonly describe: string;
  readonly required?: boolean;
}

export interface CommandSpec {
  readonly name: string;
  readonly summary: string;
  readonly positionals: readonly PositionalSpec[];
  readonly flags: readonly FlagSpec[];
  readonly examples?: readonly string[];
  readonly notes?: readonly string[];
  /** Overrides the generated USAGE line. */
  readonly usage?: string;
}

export interface ParserConfig {
  readonly program: string;
  readonly version: string;
  readonly globals: readonly FlagSpec[];
  readonly commands: readonly CommandSpec[];
}

export interface ParsedArgs {
  /** Command name, or `''` when none was given. */
  readonly command: string;
  readonly positionals: readonly string[];
  /** Keyed by long flag name. */
  readonly flags: Readonly<Record<string, FlagValue>>;
  readonly help: boolean;
  readonly version: boolean;
}

/** Bad input from the user. Always exit code 1. */
export class UsageError extends Error {
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'UsageError';
    this.hint = hint;
  }
}

/* ── built-ins ────────────────────────────────────────────────────── */

const HELP: FlagSpec = { name: 'help', kind: 'boolean', short: 'h', describe: 'Show help for this command' };
const VERSION: FlagSpec = { name: 'version', kind: 'boolean', short: 'V', describe: 'Print the version' };
const BUILTINS: readonly FlagSpec[] = [HELP, VERSION];

/* ── lookups ──────────────────────────────────────────────────────── */

class SpecIndex {
  readonly byName = new Map<string, FlagSpec>();
  readonly byShort = new Map<string, FlagSpec>();

  add(spec: FlagSpec): void {
    // Later layers win, so a command can shadow a global.
    this.byName.set(spec.name, spec);
    if (spec.short) this.byShort.set(spec.short, spec);
  }

  addAll(specs: readonly FlagSpec[]): void {
    for (const spec of specs) this.add(spec);
  }

  names(): string[] {
    return [...this.byName.keys()];
  }

  resolve(token: string): FlagSpec | undefined {
    if (token.startsWith('--')) return this.byName.get(token.slice(2));
    return this.byShort.get(token.slice(1));
  }
}

function index(...layers: readonly (readonly FlagSpec[])[]): SpecIndex {
  const out = new SpecIndex();
  for (const layer of layers) out.addAll(layer);
  return out;
}

/* ── parsing ──────────────────────────────────────────────────────── */

export interface ParseResult {
  /** `null` when argv named no command. */
  readonly command: CommandSpec | null;
  readonly args: ParsedArgs;
}

function isFlagToken(token: string): boolean {
  return token.startsWith('-') && token !== '-' && token !== '--';
}

function splitInline(token: string): { name: string; inline: string | undefined } {
  const eq = token.indexOf('=');
  return eq < 0 ? { name: token, inline: undefined } : { name: token.slice(0, eq), inline: token.slice(eq + 1) };
}

/** `--limit -1` is a value, not a flag. Everything else starting with `-` is. */
function usableAsValue(token: string | undefined): token is string {
  if (token === undefined) return false;
  if (!isFlagToken(token)) return true;
  return /^-\d+(\.\d+)?$/.test(token);
}

/**
 * Find the command word. Globals may precede it (`--json pair`), so the scan
 * skips values declared by global specs and stops at the first bare word that
 * is not a known command name.
 */
function findCommand(argv: readonly string[], config: ParserConfig): { at: number; spec: CommandSpec | null } {
  const byName = new Map(config.commands.map((c) => [c.name, c] as const));
  const globals = index(BUILTINS, config.globals);

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;

    if (token === '--') return { at: -1, spec: null };

    if (!isFlagToken(token)) {
      const hit = byName.get(token);
      if (hit) return { at: i, spec: hit };
      const near = closest(token, [...byName.keys()]);
      throw new UsageError(
        `unknown command \`${token}\``,
        near
          ? `did you mean \`${near}\`?`
          : `run \`${config.program} --help\` for the command list`,
      );
    }

    const { name, inline } = splitInline(token);
    const spec = globals.resolve(name);
    if (!spec || inline !== undefined) continue;
    if (spec.kind === 'string' || spec.kind === 'number') {
      if (usableAsValue(argv[i + 1])) i += 1;
    }
  }

  return { at: -1, spec: null };
}

function coerce(spec: FlagSpec, raw: string, token: string): FlagValue {
  if (spec.kind !== 'number') return raw;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new UsageError(`\`${token}\` expects a number`, `received \`${raw}\``);
  return n;
}

function placeholderFor(spec: FlagSpec): string {
  if (spec.placeholder) return spec.placeholder;
  return spec.kind === 'number' ? '<n>' : '<value>';
}

/**
 * Parse `argv` against the resolved command.
 *
 * Throws {@link UsageError} on anything it cannot honour.
 */
export function parseArgv(argv: readonly string[], config: ParserConfig): ParseResult {
  const { at: commandAt, spec: command } = findCommand(argv, config);
  const specs = index(BUILTINS, config.globals, command?.flags ?? []);

  const flags: Record<string, FlagValue> = {};
  for (const layer of [BUILTINS, config.globals, command?.flags ?? []]) {
    for (const spec of layer) if (spec.default !== undefined) flags[spec.name] = spec.default;
  }

  const positionals: string[] = [];
  let passthrough = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;

    if (passthrough) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      passthrough = true;
      continue;
    }
    if (i === commandAt) continue;

    if (!isFlagToken(token)) {
      positionals.push(token);
      continue;
    }

    const { name: bare, inline } = splitInline(token);
    const negated = bare.startsWith('--no-');
    // `--no-json` has to be looked up as `json`, everything else as written:
    // resolve() distinguishes long from short by the leading dashes.
    const lookupToken = negated ? `--${bare.slice(5)}` : bare;
    const wanted = lookupToken.startsWith('--') ? lookupToken.slice(2) : lookupToken.slice(1);
    const spec = specs.resolve(lookupToken);

    if (!spec) {
      const near = closest(wanted, specs.names().filter((n) => n.length > 1));
      const usage = usageLine(command, config.program);
      throw new UsageError(
        `unknown flag \`${token}\``,
        near ? `did you mean \`--${near}\`?` : `usage: ${usage}`,
      );
    }

    if (negated) {
      if (spec.kind !== 'boolean') {
        throw new UsageError(`\`--no-${spec.name}\` only applies to boolean flags`, `\`--${spec.name}\` takes a value`);
      }
      flags[spec.name] = false;
      continue;
    }

    if (spec.kind === 'boolean') {
      if (inline === undefined) {
        flags[spec.name] = true;
        continue;
      }
      if (inline === 'true' || inline === 'false') {
        flags[spec.name] = inline === 'true';
        continue;
      }
      throw new UsageError(
        `\`${token}\` is a boolean flag`,
        `use \`--${spec.name}\` or \`--no-${spec.name}\``,
      );
    }

    let raw = inline;
    if (raw === undefined) {
      const next = argv[i + 1];
      if (!usableAsValue(next)) {
        throw new UsageError(
          `\`${token}\` expects a value`,
          `example: \`${token} ${placeholderFor(spec)}\``,
        );
      }
      raw = next;
      i += 1;
    }

    if (spec.kind === 'list') {
      const prev = flags[spec.name];
      const base = typeof prev === 'object' && Array.isArray(prev) ? [...prev] : [];
      base.push(raw);
      flags[spec.name] = base;
      continue;
    }

    flags[spec.name] = coerce(spec, raw, token);
  }

  const args: ParsedArgs = {
    command: command?.name ?? '',
    positionals,
    flags,
    help: flags.help === true,
    version: flags.version === true,
  };

  if (command && !args.help) validatePositionals(args, command, config.program);

  return { command, args };
}

/** `<jid>` → `jid`, so commands can name a positional in errors. */
export function positionalName(spec: PositionalSpec): string {
  return spec.name.replace(/^<|>$/g, '');
}

function usageLine(spec: CommandSpec | null, program: string): string {
  if (!spec) return `${program} <command> [flags]`;
  if (spec.usage) {
    return `${program} ${spec.name} ${spec.usage} [flags]`.replace(/\s+/g, ' ').trimEnd();
  }
  const required = spec.positionals.filter((p) => p.required !== false).map((p) => p.name);
  const optional = spec.positionals.filter((p) => p.required === false).map((p) => p.name);
  const parts = [...required];
  if (optional.length > 0) parts.push(`[${optional.join(' ')}]`);
  parts.push('[flags]');
  return `${program} ${spec.name} ${parts.join(' ')}`.replace(/\s+/g, ' ').trimEnd();
}

function validatePositionals(args: ParsedArgs, spec: CommandSpec, program: string): void {
  if (args.positionals.length < spec.positionals.length) {
    const missing = spec.positionals[args.positionals.length];
    if (missing?.required === false) return;
    throw new UsageError(
      `missing required argument <${missing ? positionalName(missing) : 'argument'}>`,
      `usage: ${usageLine(spec, program)}`,
    );
  }
  if (args.positionals.length > spec.positionals.length) {
    const extra = args.positionals[spec.positionals.length] ?? '';
    throw new UsageError(`unexpected argument \`${extra}\``, `usage: ${usageLine(spec, program)}`);
  }
}

/* ── typed accessors ──────────────────────────────────────────────── */

export function flagString(args: ParsedArgs, key: string, fallback: string): string {
  const value = args.flags[key];
  return typeof value === 'string' ? value : fallback;
}

export function flagNumber(args: ParsedArgs, key: string, fallback: number): number {
  const value = args.flags[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function flagBool(args: ParsedArgs, key: string, fallback: boolean): boolean {
  const value = args.flags[key];
  return typeof value === 'boolean' ? value : fallback;
}

export function flagList(args: ParsedArgs, key: string): readonly string[] {
  const value = args.flags[key];
  return Array.isArray(value) ? value : [];
}

/* ── help rendering ───────────────────────────────────────────────── */

const LABEL_WIDTH = 26;
const DESC_WIDTH = 88;

function flagLabel(spec: FlagSpec): string {
  const alias = spec.short ? `-${spec.short}, ` : '';
  const value = spec.kind === 'boolean' ? '' : ` ${placeholderFor(spec)}${spec.kind === 'list' ? '…' : ''}`;
  return `${alias}--${spec.name}${value}`;
}

function renderFlagLines(specs: readonly FlagSpec[]): string[] {
  if (specs.length === 0) return [];
  const labels = specs.map(flagLabel);
  const width = Math.min(LABEL_WIDTH, Math.max(...labels.map((l) => l.length)));

  return specs.map((spec, i) => {
    const first = labels[i] ?? '';
    const gap = ' '.repeat(Math.max(1, width - first.length + 2));
    const suffix = spec.default === undefined ? '' : ` [default: ${String(spec.default)}]`;
    const desc = `${spec.describe}${suffix}`;
    const room = Math.max(24, DESC_WIDTH - (2 + width + 2));
    if (desc.length <= room) return `  ${first}${gap}${desc}`;
    // Wrap under the label column instead of running off the edge.
    const blank = ' '.repeat(first.length);
    const out: string[] = [];
    let rest = desc;
    let label = first;
    while (rest.length > room) {
      let cut = rest.lastIndexOf(' ', room);
      if (cut <= 0) cut = room;
      out.push(`  ${label}${gap}${rest.slice(0, cut)}`);
      rest = rest.slice(cut + 1);
      label = blank;
    }
    out.push(`  ${label}${gap}${rest}`);
    return out.join('\n');
  });
}

function section(title: string, body: readonly string[]): string {
  return body.length === 0 ? '' : `${title}\n${body.join('\n')}`;
}

/** Full help for one command. */
export function renderCommandHelp(spec: CommandSpec, config: ParserConfig): string {
  const argumentWidth = Math.max(6, ...spec.positionals.map((p) => p.name.length));
  const arguments_ = spec.positionals.map((p) => `  ${p.name.padEnd(argumentWidth)}  ${p.describe}`);

  return [
    spec.summary,
    '',
    section('USAGE', [`  ${usageLine(spec, config.program)}`]),
    section('ARGUMENTS', arguments_),
    section('FLAGS', renderFlagLines(spec.flags)),
    section('GLOBAL FLAGS', renderFlagLines(config.globals)),
    section('EXAMPLES', (spec.examples ?? []).map((e) => `  ${e}`)),
    section('NOTES', (spec.notes ?? []).map((n) => `  ${n}`)),
  ].join('\n\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

/** Root help: the command table plus the global contract. */
export function renderRootHelp(config: ParserConfig): string {
  const width = Math.max(...config.commands.map((c) => c.name.length));
  const commands = config.commands.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`);

  return [
    'super-baileys — command line for the Super Baileys WhatsApp framework.',
    '',
    section('USAGE', [
      `  ${config.program} <command> [flags]`,
      `  ${config.program} <command> --help`,
    ]),
    section('COMMANDS', commands),
    section('GLOBAL FLAGS', renderFlagLines(config.globals)),
    section('ENVIRONMENT', [
      '  SESSION_DIR   Session directory used when --dir is not given',
      '  LOG_LEVEL     Default level: silent | error | warn | info | debug',
      '  NO_COLOR      Any value disables ANSI colour',
    ]),
    section('EXIT CODES', [
      '  0    ok',
      '  1    usage error — unknown command or flag, missing argument',
      '  2    connection or session failure',
      '  3    not paired — run `pair` first',
      '  130  interrupted (Ctrl-C)',
    ]),
    '',
    `Run \`${config.program} <command> --help\` for the flags of a single command.`,
  ]
    .filter((part) => part.length > 0)
    .join('\n\n');
}

/* ── suggestions ──────────────────────────────────────────────────── */

/** Levenshtein distance, one row of DP — fine for a flag list this size. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(
        (row[j - 1] ?? 0) + 1,
        (prev[j] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    prev = row;
  }
  return prev[b.length] ?? b.length;
}

/** Closest known name, or `null` when nothing is close enough to suggest. */
function closest(input: string, known: readonly string[]): string | null {
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of known) {
    const distance = editDistance(input, candidate);
    if (distance < bestScore) {
      bestScore = distance;
      best = candidate;
    }
  }
  const budget = Math.max(2, Math.floor(input.length / 3));
  return best !== null && bestScore <= budget ? best : null;
}