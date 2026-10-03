import { jidNormalizedUser } from '@whiskeysockets/baileys';

import type { BaileysEventMap, WAMessage, WAMessageKey } from '@whiskeysockets/baileys';
import type { Logger, Plugin } from '../utils/types.js';

/**
 * A small command router.
 *
 * Deliberately not a framework: a registry, a prefix, a permission hook and
 * help generated from the registry. Anything richer (argument parsers, subcommand
 * trees, middleware chains) belongs to the host, not to a library the host did
 * not ask for.
 *
 * Two decisions worth stating:
 *
 *   - **The registry is the single source of truth for help.** `/help` walks the
 *     same records the dispatcher matches, so a command cannot be reachable and
 *     undocumented, or documented and unreachable. `hidden` is the only opt-out.
 *   - **Commands are matched against the body, not the whole message.** A quoted
 *     reply or a media caption must not silently become a command invocation.
 *     Only a plain conversation or extended-text message with no association is
 *     eligible, which is also why `associationOf` is checked.
 *
 * A permission check that throws is treated as a denial, not as a crash: an
 * authoriser bug must not turn into an unhandled rejection in an event handler.
 */

export interface CommandContext {
  /** Chat the command came from. */
  readonly jid: string;
  /** Normalised sender. */
  readonly sender: string;
  /** Command name as invoked, after alias resolution. */
  readonly name: string;
  /** Body with the command word and prefix removed. */
  readonly args: string;
  /** Raw argv, respecting quotes. Empty when the body is blank. */
  readonly argv: readonly string[];
  readonly isGroup: boolean;
  readonly key: WAMessageKey;
  readonly message: WAMessage;
  readonly log: Logger;
  /** Reply in the same chat. */
  reply(text: string): Promise<void>;
  /** Direct-message the sender, for errors a group should not see. */
  replyPrivate(text: string): Promise<void>;
}

export interface CommandSpec {
  /** Canonical name, matched case-insensitively without the prefix. */
  readonly name: string;
  /** Alternate names. */
  readonly aliases?: readonly string[];
  /**
   * Extra pattern the body must match. A command with a pattern is only reached
   * when both its name and its pattern match, so `pattern` can narrow one verb
   * without registering a second one.
   */
  readonly pattern?: RegExp;
  /** False denies. May be async; a throw counts as a denial. */
  readonly permission?: (ctx: CommandContext) => boolean | Promise<boolean>;
  /** Shown by `/help`. */
  readonly description?: string;
  /** Argument hint, shown after the name. */
  readonly usage?: string;
  /** Excluded from `/help` but still runnable. */
  readonly hidden?: boolean;
  readonly handler: (ctx: CommandContext) => void | Promise<void>;
}

export interface CommandOptions {
  /** Trigger prefix. Default `/`. */
  prefix?: string;
  /** Only handle commands in DMs. Default true — bots in groups get noisy. */
  dmsOnly?: boolean;
  /** Also handle commands in groups. Implied when `dmsOnly` is false. */
  groups?: boolean;
  /** Command used when input matches nothing. */
  fallback?: (ctx: CommandContext) => void | Promise<void>;
  /** Called when a command is found but the permission check denies. */
  onDenied?: (ctx: CommandContext) => void | Promise<void>;
  /** Called when a handler throws. */
  onError?: (err: unknown, ctx: CommandContext) => void | Promise<void>;
  /** Commands registered at apply time. */
  defaults?: readonly CommandSpec[];
}

export interface HelpSection {
  readonly name: string;
  readonly usage: string;
  readonly description: string;
}

/** Split a body into argv, honouring single and double quotes. */
export function tokenize(body: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (const char of body) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) out.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) out.push(current);
  return out;
}

export function commands(options: CommandOptions = {}): Plugin {
  const prefix = options.prefix ?? '/';
  /** Keyed by lowercased name and alias, so lookup is one map hit. */
  const registry = new Map<string, CommandSpec>();
  const specs: CommandSpec[] = [];

  return {
    name: 'commands',
    order: 170,

    apply(ctx) {
      const log = ctx.log.child('commands');

      const add = (spec: CommandSpec): void => {
        specs.push(spec);
        registry.set(spec.name.toLowerCase(), spec);
        for (const alias of spec.aliases ?? []) registry.set(alias.toLowerCase(), spec);
      };

      const remove = (name: string): boolean => {
        const spec = registry.get(name.toLowerCase());
        if (!spec) return false;
        for (const key of [spec.name, ...(spec.aliases ?? [])]) registry.delete(key.toLowerCase());
        const at = specs.indexOf(spec);
        if (at !== -1) specs.splice(at, 1);
        return true;
      };

      /* ── help ───────────────────────────────────────────────────── */

      const helpSections = (): HelpSection[] =>
        specs
          .filter((s) => !s.hidden)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((s) => ({
            name: s.name,
            usage: `${prefix}${s.name}${s.usage ? ` ${s.usage}` : ''}`,
            description: s.description ?? '',
          }));

      const helpText = (): string => {
        const sections = helpSections();
        if (sections.length === 0) return 'No commands registered.';
        const width = Math.max(...sections.map((s) => s.usage.length));
        return sections
          .map((s) => `${s.usage.padEnd(width)}  ${s.description}`.trimEnd())
          .join('\n');
      };

      const help = async (jid: string): Promise<void> => {
        await ctx.sock.sendMessage(jid, { text: helpText() });
      };

      /* ── dispatch ───────────────────────────────────────────────── */

      /**
       * A command is eligible only from an unquoted, media-free text message.
       * A reaction or a caption carrying `/foo` must not invoke anything.
       */
      const eligible = (msg: WAMessage): { body: string } | null => {
        const m = msg.message as
          | {
              conversation?: string | null;
              extendedTextMessage?: {
                text?: string | null;
                contextInfo?: { messageAssociation?: unknown } | null;
              } | null;
            }
          | null
          | undefined;
        const body = m?.conversation ?? m?.extendedTextMessage?.text ?? '';
        if (!body.startsWith(prefix)) return null;

        // Quoted or album-linked: the text is not addressed to us.
        if (m?.extendedTextMessage?.contextInfo?.messageAssociation) return null;

        return { body: body.slice(prefix.length) };
      };

      const run = async (msg: WAMessage): Promise<void> => {
        const key = msg.key;
        if (!key) return;
        const jid = key.remoteJid ?? '';
        const isGroup = jid.endsWith('@g.us');
        if (options.dmsOnly !== false && isGroup && !options.groups) return;

        const parsed = eligible(msg);
        if (!parsed) return;

        const tokens = tokenize(parsed.body);
        const head = tokens[0];
        if (!head) return;

        const name = head.toLowerCase();
        const spec = name === 'help' ? undefined : registry.get(name);

        // `/help` with no argument lists everything; with a name, details one.
        if (!spec) {
          if (name !== 'help') {
            if (options.fallback) {
              const c = await build(msg, jid, head.toLowerCase(), parsed.body.slice(head.length));
              if (c) await options.fallback(c);
            }
            return;
          }
          await help(jid);
          return;
        }

        const rest = parsed.body.slice(head.length).trim();
        const commandCtx = await build(msg, jid, spec.name, rest);
        if (!commandCtx) return;

        try {
          if (spec.permission) {
            let allowed = false;
            try {
              allowed = await spec.permission(commandCtx);
            } catch (err) {
              // A broken authoriser denies; it does not escape into the emitter.
              log.debug('permission check threw, denying', {
                command: spec.name,
                err: (err as Error).message,
              });
              allowed = false;
            }
            if (!allowed) {
              await options.onDenied?.(commandCtx);
              return;
            }
          }
          await spec.handler(commandCtx);
        } catch (err) {
          log.warn('command failed', { command: spec.name, err: (err as Error).message });
          if (options.onError) await options.onError(err, commandCtx);
        }
      };

      const build = async (
        msg: WAMessage,
        jid: string,
        name: string,
        rest: string,
      ): Promise<CommandContext | null> => {
        const key = msg.key;
        if (!key) return null;

        const reply = async (text: string): Promise<void> => {
          await ctx.sock.sendMessage(jid, { text, ...(key.participant ? { mentions: [key.participant] } : {}) });
        };

        return {
          jid,
          sender: jidNormalizedUser(key.participant ?? key.remoteJid ?? ''),
          name,
          args: rest,
          argv: tokenize(rest),
          isGroup: jid.endsWith('@g.us'),
          key,
          message: msg,
          log,
          reply,
          replyPrivate: async (text: string): Promise<void> => {
            const to = key.participant ?? key.remoteJid ?? jid;
            await ctx.sock.sendMessage(to, { text });
          },
        };
      };

      ctx.sock.ev.on('messages.upsert', (event: BaileysEventMap['messages.upsert']) => {
        for (const msg of event?.messages ?? []) {
          // `void` plus the internal try/catch: the handler already owns every
          // failure path, so nothing can reach the emitter as a rejection.
          void run(msg);
        }
      });

      /* ── surface ────────────────────────────────────────────────── */

      const api = {
        prefix,
        register: add,
        unregister: remove,
        has: (name: string): boolean => registry.has(name.toLowerCase()),
        list: (): readonly CommandSpec[] => [...specs],
        /** Help text, generated from the registry. */
        help: helpText,
        sections: helpSections,
        /**
         * Run a command directly, bypassing prefix and message parsing. Builds
         * a real context, so a permission hook sees the same fields it would
         * from an inbound message rather than a hollow object.
         */
        invoke: async (jid: string, sender: string, line: string): Promise<void> => {
          const tokens = tokenize(line);
          const head = tokens[0];
          if (!head) throw new Error('invoke needs a command name');
          const spec = registry.get(head.toLowerCase());
          if (!spec) throw new Error(`unknown command ${head}`);

          const rest = line.slice(head.length).trim();
          const direct: CommandContext = {
            jid,
            sender,
            name: spec.name,
            args: rest,
            argv: tokenize(rest),
            isGroup: jid.endsWith('@g.us'),
            key: { remoteJid: jid },
            message: {} as WAMessage,
            log,
            reply: async (text: string) => {
              await ctx.sock.sendMessage(jid, { text });
            },
            replyPrivate: async (text: string) => {
              await ctx.sock.sendMessage(sender || jid, { text });
            },
          };

          if (spec.permission) {
            let allowed = false;
            try {
              allowed = await spec.permission(direct);
            } catch (err) {
              log.debug('permission check threw, denying', {
                command: spec.name,
                err: (err as Error).message,
              });
            }
            if (!allowed) throw new Error(`permission denied for ${spec.name}`);
          }
          await spec.handler(direct);
        },
      };

      for (const spec of options.defaults ?? []) add(spec);

      Object.defineProperty(ctx.sock, 'commands', { value: api, enumerable: false, configurable: true });

      ctx.onDispose(() => {
        registry.clear();
        specs.length = 0;
      });

      log.debug('attached', { prefix });
    },
  };
}

export default commands;
