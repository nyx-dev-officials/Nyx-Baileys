import { jidNormalizedUser } from '@whiskeysockets/baileys';

import type { BaileysEventMap, WAMessage, WAMessageKey } from '@whiskeysockets/baileys';
import type { CoreSocket, Logger, Plugin } from '../utils/types.js';

/**
 * Command router for bot scripts.
 *
 * A registry, a prefix, permissions, cooldowns and a menu generated from the
 * registry itself. It is deliberately not an application framework — argument
 * parsers, sub-command trees and middleware belong to the host — but it carries
 * the things every WhatsApp bot re-implements and gets subtly wrong:
 *
 *   - **owner / group-admin / bot-admin guards**, resolved rather than assumed
 *   - **per-command cooldowns**, so a spammer cannot pin the process
 *   - **group-only / private-only** scoping
 *   - **a menu grouped by category**, generated from the same records the
 *     dispatcher matches, so a command cannot be reachable-but-undocumented
 *   - **message templates**, the `global.mess` object every script hand-rolls
 *
 * Two invariants hold throughout:
 *
 *   - **The registry is the single source of truth for help.** `hidden` is the
 *     only opt-out.
 *   - **Commands are matched against the body, not the whole message.** A quoted
 *     reply or a media caption carrying `/foo` must not invoke anything.
 *
 * A permission check that throws is a denial, not a crash: an authoriser bug
 * must not become an unhandled rejection in an event handler.
 */

export interface CommandContext {
  /** Chat the command came from. */
  readonly jid: string;
  /** Normalised sender. */
  readonly sender: string;
  /** Command name as invoked, after alias resolution. */
  readonly name: string;
  /** Category the command declares. */
  readonly category: string;
  /** Body with the command word and prefix removed. */
  readonly args: string;
  /** Raw argv, respecting quotes. Empty when the body is blank. */
  readonly argv: readonly string[];
  readonly isGroup: boolean;
  /** True when the sender is on the configured owner list. */
  readonly isOwner: boolean;
  readonly key: WAMessageKey;
  readonly message: WAMessage;
  readonly log: Logger;
  /**
   * The live socket, so a command can send media, manage groups or reach any
   * other API. Exposed deliberately: a bot author should not have to stash the
   * socket in a module-level variable to send more than text.
   */
  readonly sock: CoreSocket;
  /** Reply in the same chat. */
  reply(text: string): Promise<void>;
  /** Direct-message the sender, for errors a group should not see. */
  replyPrivate(text: string): Promise<void>;
  /** Is the sender an admin of the current group? False outside a group. */
  isGroupAdmin(): Promise<boolean>;
  /** Is the bot itself an admin of the current group? False outside a group. */
  isBotAdmin(): Promise<boolean>;
}

export interface CommandSpec {
  /** Canonical name, matched case-insensitively without the prefix. */
  readonly name: string;
  /** Alternate names. */
  readonly aliases?: readonly string[];
  /** Grouping in the menu. Default `general`. */
  readonly category?: string;
  /** Extra pattern the body must match. */
  readonly pattern?: RegExp;
  /** False denies. May be async; a throw counts as a denial. */
  readonly permission?: (ctx: CommandContext) => boolean | Promise<boolean>;
  /** Sender must be an owner. */
  readonly ownerOnly?: boolean;
  /** Sender must be a group admin. */
  readonly adminsOnly?: boolean;
  /** The bot must be a group admin. */
  readonly botAdminOnly?: boolean;
  /** Only in groups / only in DMs. */
  readonly groupOnly?: boolean;
  readonly privateOnly?: boolean;
  /** Minimum gap between this command's invocations by one sender. */
  readonly cooldownMs?: number;
  /** Shown by the menu. */
  readonly description?: string;
  /** Argument hint, shown after the name. */
  readonly usage?: string;
  /** Excluded from the menu but still runnable. */
  readonly hidden?: boolean;
  readonly handler: (ctx: CommandContext) => void | Promise<void>;
}

/** Messages a rejection replies with. Every key has an English default. */
export interface CommandMessages {
  owner: string;
  admin: string;
  botAdmin: string;
  group: string;
  private: string;
  wait: string;
  denied: string;
  error: string;
  notFound: string;
}

export interface CommandOptions {
  /** Trigger prefix. Default `/`. */
  prefix?: string;
  /** Owner numbers or jids. Bare numbers are normalised. */
  owners?: readonly string[];
  /** Default per-command cooldown. Default 0 (off). */
  cooldownMs?: number;
  /** Override any rejection message. */
  messages?: Partial<CommandMessages>;
  /** Only handle commands in DMs. Default true — bots in groups get noisy. */
  dmsOnly?: boolean;
  /** Also handle commands in groups. Implied when `dmsOnly` is false. */
  groups?: boolean;
  /** Command used when input matches nothing. */
  fallback?: (ctx: CommandContext) => void | Promise<void>;
  /** Called when a command is found but a guard denies. */
  onDenied?: (ctx: CommandContext) => void | Promise<void>;
  /** Called when a handler throws. */
  onError?: (err: unknown, ctx: CommandContext) => void | Promise<void>;
  /** Commands registered at apply time. */
  defaults?: readonly CommandSpec[];
  /** Injectable clock, for tests. */
  now?: () => number;
}

export interface HelpSection {
  readonly name: string;
  readonly usage: string;
  readonly description: string;
  readonly category: string;
}

export interface MenuSection {
  readonly category: string;
  readonly commands: HelpSection[];
}

export const DEFAULT_MESSAGES: CommandMessages = {
  owner: 'This command is owner-only.',
  admin: 'This command is for group admins.',
  botAdmin: 'I need to be a group admin to do that.',
  group: 'This command only works in a group.',
  private: 'This command only works in a private chat.',
  wait: 'One moment — that is on cooldown.',
  denied: 'You cannot use that command.',
  error: 'That command failed.',
  notFound: 'Unknown command. Try the menu.',
};

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

/** Normalise a phone number or jid to a comparable bare user id. */
export function toUser(jidOrNumber: string): string {
  const trimmed = String(jidOrNumber).trim();
  if (!trimmed) return '';
  if (trimmed.includes('@')) return jidNormalizedUser(trimmed);
  const digits = trimmed.replace(/\D/g, '');
  return digits ? `${digits}@s.whatsapp.net` : '';
}

export function commands(options: CommandOptions = {}): Plugin {
  const prefix = options.prefix ?? '/';
  const messages: CommandMessages = { ...DEFAULT_MESSAGES, ...options.messages };
  const defaultCooldown = options.cooldownMs ?? 0;
  const now = options.now ?? (() => Date.now());
  const owners = new Set((options.owners ?? []).map(toUser).filter(Boolean));

  /** Keyed by lowercased name and alias, so lookup is one map hit. */
  const registry = new Map<string, CommandSpec>();
  const specs: CommandSpec[] = [];
  /** `${name}:${sender}` → last-run timestamp. */
  const cooldowns = new Map<string, number>();
  /** jid → admin ids, resolved lazily and briefly cached. */
  const adminCache = new Map<string, { at: number; admins: Set<string> }>();

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

      const isOwner = (sender: string): boolean => owners.has(toUser(sender));

      /* ── group-admin resolution ─────────────────────────────────── */

      const groupAdmins = async (jid: string): Promise<Set<string>> => {
        const cached = adminCache.get(jid);
        const at = now();
        if (cached && at - cached.at < 60_000) return cached.admins;

        const admins = new Set<string>();
        try {
          const metadata = await (ctx.sock as unknown as {
            groupMetadata?: (j: string) => Promise<{ participants?: Array<{ id?: string | null; admin?: string | null }> }>;
          }).groupMetadata?.(jid);
          for (const participant of metadata?.participants ?? []) {
            if (participant?.admin && participant.id) admins.add(toUser(participant.id));
          }
        } catch (err) {
          log.debug('group metadata lookup failed', { jid, err: (err as Error).message });
        }
        adminCache.set(jid, { at, admins });
        return admins;
      };

      const botId = (): string => toUser(ctx.sock.user?.id ?? '');

      /* ── menu / help ────────────────────────────────────────────── */

      const helpSections = (): HelpSection[] =>
        specs
          .filter((s) => !s.hidden)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((s) => ({
            name: s.name,
            usage: `${prefix}${s.name}${s.usage ? ` ${s.usage}` : ''}`,
            description: s.description ?? '',
            category: s.category ?? 'general',
          }));

      const menuSections = (): MenuSection[] => {
        const byCategory = new Map<string, HelpSection[]>();
        for (const section of helpSections()) {
          const list = byCategory.get(section.category) ?? [];
          list.push(section);
          byCategory.set(section.category, list);
        }
        return [...byCategory.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([category, list]) => ({ category, commands: list }));
      };

      const helpText = (): string => {
        const sections = helpSections();
        if (sections.length === 0) return 'No commands registered.';
        const width = Math.max(...sections.map((s) => s.usage.length));
        return sections
          .map((s) => `${s.usage.padEnd(width)}  ${s.description}`.trimEnd())
          .join('\n');
      };

      /** Menu grouped by category, the shape every bot menu uses. */
      const menuText = (): string => {
        const sections = menuSections();
        if (sections.length === 0) return 'No commands registered.';
        const lines: string[] = [];
        for (const section of sections) {
          lines.push(`*${section.category.toUpperCase()}*`);
          const width = Math.max(...section.commands.map((c) => c.usage.length));
          for (const command of section.commands) {
            lines.push(`  ${command.usage.padEnd(width)}  ${command.description}`.trimEnd());
          }
          lines.push('');
        }
        return lines.join('\n').trimEnd();
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
        const spec = registry.get(name);

        if (!spec) {
          const commandCtx = await build(msg, jid, name, parsed.body.slice(head.length).trim());
          if (name === 'help' || name === 'menu') {
            await ctx.sock.sendMessage(jid, { text: menuText() });
            return;
          }
          if (options.fallback && commandCtx) await options.fallback(commandCtx);
          return;
        }

        const rest = parsed.body.slice(head.length).trim();
        const commandCtx = await build(msg, jid, spec.name, rest);
        if (!commandCtx) return;

        const deny = async (reason: string): Promise<void> => {
          await commandCtx.reply(reason);
          await options.onDenied?.(commandCtx);
        };

        try {
          // Scope guards first — cheapest and most explanatory.
          if (spec.groupOnly && !isGroup) return void (await deny(messages.group));
          if (spec.privateOnly && isGroup) return void (await deny(messages.private));
          if (spec.ownerOnly && !commandCtx.isOwner) return void (await deny(messages.owner));

          if (spec.adminsOnly || spec.botAdminOnly) {
            if (!isGroup) return void (await deny(messages.group));
            const admins = await groupAdmins(jid);
            if (spec.adminsOnly && !admins.has(toUser(commandCtx.sender))) {
              return void (await deny(messages.admin));
            }
            if (spec.botAdminOnly && !admins.has(botId())) {
              return void (await deny(messages.botAdmin));
            }
          }

          // Cooldown, keyed per sender so one user cannot starve others.
          const cooldown = spec.cooldownMs ?? defaultCooldown;
          if (cooldown > 0) {
            const key2 = `${spec.name}:${commandCtx.sender}`;
            const at = now();
            const last = cooldowns.get(key2) ?? 0;
            if (at - last < cooldown) return void (await commandCtx.reply(messages.wait));
            cooldowns.set(key2, at);
          }

          if (spec.permission) {
            let allowed = false;
            try {
              allowed = await spec.permission(commandCtx);
            } catch (err) {
              log.debug('permission check threw, denying', {
                command: spec.name,
                err: (err as Error).message,
              });
            }
            if (!allowed) return void (await deny(messages.denied));
          }

          await spec.handler(commandCtx);
        } catch (err) {
          log.warn('command failed', { command: spec.name, err: (err as Error).message });
          if (options.onError) await options.onError(err, commandCtx);
          else await commandCtx.reply(messages.error);
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

        const isGroup = jid.endsWith('@g.us');
        const sender = toUser(key.participant ?? key.remoteJid ?? '');

        const reply = async (text: string): Promise<void> => {
          await ctx.sock.sendMessage(jid, { text });
        };

        return {
          jid,
          sender,
          name,
          category: registry.get(name)?.category ?? 'general',
          args: rest,
          argv: tokenize(rest),
          isGroup,
          isOwner: isOwner(sender),
          key,
          message: msg,
          log,
          sock: ctx.sock,
          reply,
          replyPrivate: async (text: string): Promise<void> => {
            const to = key.participant ?? key.remoteJid ?? jid;
            await ctx.sock.sendMessage(to, { text });
          },
          isGroupAdmin: async () => isGroup && (await groupAdmins(jid)).has(sender),
          isBotAdmin: async () => isGroup && (await groupAdmins(jid)).has(botId()),
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
        owners: [...owners],
        messages,
        register: add,
        unregister: remove,
        has: (name: string): boolean => registry.has(name.toLowerCase()),
        get: (name: string): CommandSpec | undefined => registry.get(name.toLowerCase()),
        list: (): readonly CommandSpec[] => [...specs],
        categories: (): string[] => [...new Set(specs.map((s) => s.category ?? 'general'))].sort(),
        help: helpText,
        menu: menuText,
        sections: helpSections,
        menuSections,
        /** Clear every cooldown (admin use). */
        resetCooldowns: (): void => cooldowns.clear(),
        invoke: async (jid: string, sender: string, line: string): Promise<void> => {
          const tokens = tokenize(line);
          const head = tokens[0];
          if (!head) throw new Error('invoke needs a command name');
          const spec = registry.get(head.toLowerCase());
          if (!spec) throw new Error(`unknown command ${head}`);

          const rest = line.slice(head.length).trim();
          const isGroup = jid.endsWith('@g.us');
          const direct: CommandContext = {
            jid,
            sender: toUser(sender),
            name: spec.name,
            category: spec.category ?? 'general',
            args: rest,
            argv: tokenize(rest),
            isGroup,
            isOwner: isOwner(sender),
            key: { remoteJid: jid },
            message: {} as WAMessage,
            log,
            sock: ctx.sock,
            reply: async (text: string) => {
              await ctx.sock.sendMessage(jid, { text });
            },
            replyPrivate: async (text: string) => {
              await ctx.sock.sendMessage(sender || jid, { text });
            },
            isGroupAdmin: async () => isGroup && (await groupAdmins(jid)).has(toUser(sender)),
            isBotAdmin: async () => isGroup && (await groupAdmins(jid)).has(botId()),
          };

          if (spec.ownerOnly && !direct.isOwner) throw new Error(`permission denied for ${spec.name}`);
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
        cooldowns.clear();
        adminCache.clear();
      });

      log.debug('attached', { prefix, owners: owners.size });
    },
  };
}

export default commands;
