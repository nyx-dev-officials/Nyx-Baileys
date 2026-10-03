/**
 * Bot host.
 *
 * One call that assembles the pieces every WhatsApp bot script wires by hand:
 * a session, the command plugin configured with the owner list and message
 * templates, commands loaded from a directory, and the socket. It is a thin
 * convenience over `createNyxBaileys` — nothing here is hidden, so a script that
 * outgrows it can drop to the client directly.
 *
 * The order matters and is deliberate:
 *
 *   1. register plugins (including `commands`) before connecting, so every
 *      plugin's `apply` sees the same socket
 *   2. load command modules before connecting, so the menu is complete the
 *      moment the socket opens
 *   3. connect last
 */

import { createNyxBaileys, NyxBaileys } from '../nyxBaileys.js';
import { commands, type CommandMessages, type CommandSpec } from '../plugins/commands.js';
import { featurePlugins } from '../plugins/index.js';
import { loadCommands, type LoadCommandsOptions } from './loader.js';

import type { CoreSocket, Logger, SuperOptions } from '../utils/types.js';

export interface NyxBotOptions extends SuperOptions {
  /** Command prefix. Default `/`. */
  prefix?: string;
  /** Owner numbers or jids. Bare numbers are normalised. */
  owners?: readonly string[];
  /** Directory of command modules to load. */
  commandsDir?: string;
  /** Default per-command cooldown. Default 0. */
  cooldownMs?: number;
  /** Override any rejection message. */
  messages?: Partial<CommandMessages>;
  /** Also answer commands in groups. Default false. */
  groups?: boolean;
  /** Extra commands registered inline. */
  commands?: readonly CommandSpec[];
  /** Include the ten opt-in feature plugins. Default false. */
  features?: boolean;
  /** Loader tuning (filter, onError, recursive). */
  loader?: LoadCommandsOptions;
}

export interface NyxBot {
  readonly client: NyxBaileys;
  readonly sock: CoreSocket;
  readonly log: Logger;
  /** The command surface attached by the `commands` plugin. */
  readonly commands: {
    register: (spec: CommandSpec) => void;
    unregister: (name: string) => boolean;
    list: () => readonly CommandSpec[];
    menu: () => string;
    help: () => string;
    categories: () => string[];
    invoke: (jid: string, sender: string, line: string) => Promise<void>;
  };
  /** Command specs loaded from disk, in load order. */
  readonly loaded: CommandSpec[];
  /** Emit a fresh QR / pairing flow. */
  connect: () => Promise<CoreSocket>;
  dispose: () => Promise<void>;
}

/**
 * Create and connect a bot.
 *
 * ```ts
 * const bot = await createNyxBot({
 *   sessionDir: './session',
 *   owners: ['15551234567'],
 *   commandsDir: './commands',
 * });
 * await bot.sock.sendMessage(jid, { text: 'online' });
 * ```
 */
export async function createNyxBot(options: NyxBotOptions = {}): Promise<NyxBot> {
  const client = createNyxBaileys(options);

  client.registerPlugin(
    commands({
      prefix: options.prefix ?? '/',
      groups: options.groups ?? false,
      owners: options.owners ?? [],
      ...(options.cooldownMs !== undefined ? { cooldownMs: options.cooldownMs } : {}),
      ...(options.messages ? { messages: options.messages } : {}),
    }),
  );

  if (options.features) {
    for (const plugin of featurePlugins()) client.registerPlugin(plugin);
  }

  // Load commands before connecting so the menu is complete on open.
  const loaded: CommandSpec[] = [...(options.commands ?? [])];
  if (options.commandsDir) {
    const fromDisk = await loadCommands(options.commandsDir, options.loader);
    for (const { spec } of fromDisk) loaded.push(spec);
  }

  const sock = await client.connect();

  const surface = (sock as unknown as { commands?: NyxBot['commands'] }).commands;
  if (!surface) throw new Error('createNyxBot: the commands plugin did not attach; is it registered?');

  for (const spec of loaded) surface.register(spec);

  return {
    client,
    sock,
    log: client.log,
    commands: surface,
    loaded,
    connect: () => client.connect(),
    dispose: () => client.dispose(),
  };
}

/**
 * Dispose on SIGINT/SIGTERM, then exit. Returns an uninstall function.
 *
 * Without this a bot leaves its socket and timers behind on Ctrl-C, and the
 * next run may race the old one. `exit` defaults to `process.exit`.
 */
export function installGracefulShutdown(
  target: { dispose: () => Promise<void> },
  exit: (code: number) => void = (code) => process.exit(code),
): () => void {
  let closing = false;
  const handler = (): void => {
    if (closing) return;
    closing = true;
    void Promise.resolve(target.dispose())
      .catch(() => undefined)
      .finally(() => exit(0));
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return () => {
    process.off('SIGINT', handler);
    process.off('SIGTERM', handler);
  };
}

export { loadCommands, collectSpecs } from './loader.js';
export type { LoadedCommand, LoadCommandsOptions } from './loader.js';
export type { CommandSpec, CommandContext, CommandMessages } from '../plugins/commands.js';
export default createNyxBot;
