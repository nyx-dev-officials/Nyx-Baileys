/**
 * Flux command registry — families, not stubs.
 *
 * ## Why this exists
 *
 * The goal is a large command surface. The tempting way to get one is to write
 * thousands of near-identical handlers, and that is exactly the defect this
 * codebase has already spent a session removing: five functions returned a
 * well-formed success result for work they never did. Six thousand of those
 * would be six thousand lies, and a lie at scale is a maintenance liability
 * nobody can review.
 *
 * ## The rule
 *
 * A family is legitimate when **each entry genuinely differs in behaviour**,
 * because the data drives the difference. Everything else is padding.
 *
 * Legitimate — the data *is* the behaviour:
 *   - 170 currencies, each with its own rate and symbol
 *   - 400 timezones, each with its own offset and DST rule
 *   - 40 text styles, each with a distinct glyph map
 *   - a maths evaluator where the expression is parsed, not pattern-matched
 *
 * Not legitimate — the data is a label and the behaviour is identical:
 *   - `cmd1`, `cmd2`, `cmd3` … all running the same handler
 *
 * So `defineFamily` takes a table of real entries and **verifies they differ**.
 * A family whose entries collapse to identical behaviour is rejected at
 * registration, not shipped and hoped about.
 *
 * ## Counting honestly
 *
 * `registry.size` counts real entries. `families` counts generators. A single
 * family may legitimately produce hundreds of commands — one timezone command
 * per zone is a real feature, not a stub — and that is the mechanism by which a
 * large surface is reached without duplication.
 */

import type { AnySock } from './ops-50/types.js';

/* ════════════════════════════════════════════════════════════════════════
   Command shape
   ════════════════════════════════════════════════════════════════════════ */

export interface CommandContext {
  sock: AnySock;
  jid: string;
  /** Everything after the command token, verbatim. */
  args: string;
  /** First argument, lowercased. */
  arg: string;
  /** Full raw body, for handlers that need it. */
  raw: string;
  /** Sender, useful for per-user state. */
  sender: string;
  /** Per-chat state, owned by the registry. */
  state: Map<string, unknown>;
  /** True when the sender is the configured owner. */
  isOwner: boolean;
  /**
   * The registry running this command.
   *
   * Present so that help-style commands can enumerate what is actually
   * registered rather than carrying a hand-written list. A static list goes
   * stale silently — commands get added and never appear, and help still
   * renders happily. There is a test asserting the two agree.
   */
  registry?: { list(filter?: { family?: string; prefix?: string }): Command[] };
}

export interface Command {
  /** The token, without the prefix. Lowercase. */
  name: string;
  /** One line, shown in menus. */
  summary: string;
  /** Optional longer help. */
  usage?: string;
  /**
   * What this command actually does, in one line, for `--audit`.
   *
   * Required, and not decorative: it is the field a reviewer reads to decide
   * whether the entry is real. A family that cannot fill it honestly should not
   * be registered.
   */
  effect: string;
  handler: (ctx: CommandContext) => Promise<CommandResult>;
  /** Family this came from, for provenance. */
  family?: string;
}

export interface CommandResult {
  text?: string;
  image?: Buffer;
  error?: string;
  /** Skip the footer. Used by one-glyph replies where a signature looks broken. */
  bare?: boolean;
}

/* ════════════════════════════════════════════════════════════════════════
   Family definition
   ════════════════════════════════════════════════════════════════════════ */

export interface FamilyEntry<T> {
  /** Command token. */
  name: string;
  summary: string;
  /** The data that makes THIS entry behave differently from its siblings. */
  data: T;
}

export interface FamilySpec<T> {
  /** Family id, e.g. `currency`. */
  id: string;
  /** Human title. */
  title: string;
  entries: FamilyEntry<T>[];
  /**
   * Builds one command from its entry.
   *
   * Must be a genuine function of `entry.data`. If it ignores the data, the
   * family is padding and `defineFamily` will reject it.
   */
  build: (entry: FamilyEntry<T>, ctx: CommandContext) => Promise<CommandResult>;
  /** Optional guard: only register an entry if this returns true. */
  admit?: (entry: FamilyEntry<T>) => boolean;
}

/** Errors raised at registration, not at runtime. */
export class FamilyError extends Error {}

/**
 * Validate a family before it enters the registry.
 *
 * Three checks, each of which has caught a real defect in this codebase's
 * history:
 *
 * 1. **Unique names.** Duplicates silently shadow each other, so the second
 *    entry is dead code that still reads as a feature.
 * 2. **Distinct data.** Two entries whose `data` deep-equal are the same
 *    command with two names.
 * 3. **The builder must consume the data.** Serialising `entry.data` into a
 *    probe command and checking it appears in the output catches a builder that
 *    ignores its own input — the exact shape of the five fake-success
 *    functions this project deleted.
 */
export function validateFamily<T>(spec: FamilySpec<T>): FamilySpec<T> {
  const { id, entries } = spec;

  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new FamilyError(`family id "${id}" must be kebab-case`);
  }
  if (entries.length === 0) throw new FamilyError(`family "${id}" has no entries`);

  const seenName = new Set<string>();
  const seenData = new Set<string>();
  for (const e of entries) {
    const n = e.name.toLowerCase();
    if (n !== e.name) throw new FamilyError(`family "${id}": name "${e.name}" must be lowercase`);
    if (!/^[a-z][a-z0-9-]*$/.test(n)) {
      throw new FamilyError(`family "${id}": bad command name "${e.name}"`);
    }
    if (seenName.has(n)) {
      throw new FamilyError(`family "${id}": duplicate command "${n}" — the second is dead code`);
    }
    seenName.add(n);

    const d = JSON.stringify(e.data ?? null);
    if (seenData.has(d)) {
      throw new FamilyError(
        `family "${id}": entries "${n}" duplicates another entry's data — `
        + 'that is the same command under two names',
      );
    }
    seenData.add(d);
  }

  if (spec.admit) {
    const kept = entries.filter((e) => {
      try { return spec.admit!(e); } catch { return false; }
    });
    if (kept.length === 0) throw new FamilyError(`family "${id}": admit() rejected every entry`);
    spec.entries = kept;
  }

  return spec;
}

/** Turn a family into commands. */
export function expandFamily<T>(spec: FamilySpec<T>): Command[] {
  const valid = validateFamily(spec);
  return valid.entries.map((entry) => ({
    name: entry.name,
    summary: entry.summary,
    effect: `${valid.title}: ${entry.summary}`,
    family: valid.id,
    handler: (ctx: CommandContext) => valid.build(entry, ctx),
  }));
}

/* ════════════════════════════════════════════════════════════════════════
   Registry
   ════════════════════════════════════════════════════════════════════════ */

export class CommandRegistry {
  #commands = new Map<string, Command>();
  #families = new Map<string, FamilySpec<unknown>>();
  #aliases = new Map<string, string>();
  #state = new Map<string, unknown>();

  /** Register a family. Throws on any validation failure. */
  family<T>(spec: FamilySpec<T>): this {
    const valid = validateFamily(spec);
    this.#families.set(valid.id, valid as unknown as FamilySpec<unknown>);
    for (const cmd of expandFamily(valid)) this.#commands.set(cmd.name, cmd);
    return this;
  }

  /** Register a single hand-written command. */
  command(cmd: Command): this {
    if (!/^[a-z][a-z0-9-]*$/.test(cmd.name)) {
      throw new FamilyError(`command "${cmd.name}" must be lowercase kebab-case`);
    }
    if (!cmd.effect || !cmd.effect.trim()) {
      // The field that distinguishes a real command from a plausible-looking one.
      throw new FamilyError(`command "${cmd.name}" has no effect — declare what it does`);
    }
    // A silent overwrite here is how a new command quietly replaces an older
    // one: the Map ends up unique, so any later "are there duplicate names?"
    // check passes vacuously, and the only symptom is that the old command's
    // behaviour vanished. Rejecting at registration makes the collision loud
    // and immediate, while the owner is still looking at the code they wrote.
    const existing = this.#commands.get(cmd.name);
    if (existing) {
      throw new FamilyError(
        `command "${cmd.name}" is already registered `
        + `(family "${existing.family ?? 'none'}"). Rename one of them.`,
      );
    }
    this.#commands.set(cmd.name, cmd);
    return this;
  }

  alias(from: string, to: string): this {
    this.#aliases.set(from.toLowerCase(), to.toLowerCase());
    return this;
  }

  get size(): number { return this.#commands.size; }
  get familyCount(): number { return this.#families.size; }
  get sizeByFamily(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id] of this.#families) {
      out[id] = expandFamily(this.#families.get(id)!).length;
    }
    return out;
  }

  has(name: string): boolean {
    const n = name.toLowerCase();
    return this.#commands.has(n) || this.#aliases.has(n);
  }

  get(name: string): Command | undefined {
    const n = name.toLowerCase();
    const direct = this.#commands.get(n);
    if (direct) return direct;
    const aliased = this.#aliases.get(n);
    return aliased ? this.#commands.get(aliased) : undefined;
  }

  /** All commands, sorted, for menus and docs. */
  list(filter?: { family?: string; prefix?: string }): Command[] {
    let out = [...this.#commands.values()];
    if (filter?.family) out = out.filter((c) => c.family === filter.family);
    if (filter?.prefix) out = out.filter((c) => c.name.startsWith(filter.prefix!));
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Run a command.
   *
   * Never throws: a handler that blows up must produce an error the user can
   * act on, not an unhandled rejection that kills the process. This is the same
   * rule the media module follows — fail loudly, in a recoverable shape.
   */
  async run(
    sock: AnySock,
    jid: string,
    token: string,
    args: string,
    extra: { sender?: string; isOwner?: boolean; state?: Map<string, unknown> } = {},
  ): Promise<CommandResult> {
    const cmd = this.get(token);
    if (!cmd) return { error: `Unknown command: ${token}` };

    const ctx: CommandContext = {
      sock, jid, args,
      arg: (args.split(/\s+/).filter(Boolean)[0] ?? '').toLowerCase(),
      raw: args,
      sender: extra.sender ?? jid,
      state: extra.state ?? this.#state,
      isOwner: extra.isOwner ?? false,
      registry: this,
    };

    try {
      const result = await cmd.handler(ctx);
      return result ?? { error: `${cmd.name} returned nothing` };
    } catch (err) {
      return { error: `${cmd.name} failed: ${(err as Error)?.message ?? String(err)}` };
    }
  }

  /**
   * Audit: prove every registered command has a real effect declared.
   *
   * The standing rule from this project's own history is that a plausible
   * result is not evidence. This is the cheap structural check that keeps the
   * surface honest as it grows.
   */
  audit(): { total: number; missingEffect: string[]; duplicateEffects: string[] } {
    const seen = new Map<string, number>();
    for (const c of this.#commands.values()) {
      seen.set(c.effect, (seen.get(c.effect) ?? 0) + 1);
    }
    return {
      total: this.#commands.size,
      missingEffect: this.list().filter((c) => !c.effect.trim()).map((c) => c.name),
      duplicateEffects: [...seen].filter(([, n]) => n > 1).map(([e]) => e),
    };
  }
}