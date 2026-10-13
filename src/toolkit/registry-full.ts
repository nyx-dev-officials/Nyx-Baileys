/**
 * The whole catalogue, executable.
 *
 * Every command module in this directory ends in two things: a data array and
 * an `install*` function that registers it into a `CommandRegistry`. The tests
 * build those registries and prove names, effects and behaviour — but no socket
 * ever saw them, because nothing outside tests called the installers. Roughly
 * 1,800 tested commands sat unreachable behind six example commands.
 *
 * This module is the one call that wires them to a live bot:
 * `buildFullRegistry()` installs every family, and `registryToSpecs()` adapts
 * each entry to the commands plugin's `CommandSpec` surface.
 *
 * Two deliberate choices, both about blast radius:
 *
 * - Every bridged spec carries a 5s per-sender cooldown. Pure-text commands
 *   would not need it; the ffmpeg-backed media family does — without it any
 *   contact can queue CPU-heavy jobs at message rate.
 * - Failures go to `replyPrivate`, not the chat. Handler errors can contain
 *   local paths (ffmpeg especially); the invoker still sees them, the group
 *   does not.
 */

import { CommandRegistry, type Command } from './command-registry.js';
import { installCoreFamilies } from './command-families.js';
import { installBulkFamilies } from './command-families-bulk.js';
import { installAiCommands } from './command-ai.js';
import { menuCommand } from './flux-menu.js';
import type { CommandSpec } from '../plugins/commands.js';

/** Gap between one sender's invocations of the same bridged command. */
export const BRIDGE_COOLDOWN_MS = 5_000;

/**
 * Install every command family into one registry and return it.
 *
 * Composition only: `installBulkFamilies` already aggregates the aesthetic,
 * game, media, assist, ops, security and utility families plus the live-API
 * commands, so listing module installers here again would double-register
 * everything it covers. (That exact mistake threw on `aurebesh` the first
 * time this function was written — the registry's duplicate rejection earning
 * its keep.) Throws on any duplicate name for the same reason.
 */
export function buildFullRegistry(): CommandRegistry {
  const reg = new CommandRegistry();
  installCoreFamilies(reg);
  installBulkFamilies(reg);
  installAiCommands(reg);
  reg.command({ ...menuCommand });
  return reg;
}

/**
 * Adapt registry entries to the commands plugin's spec surface.
 *
 * Per-chat state lives in one map shared by all specs from this call, keyed by
 * chat JID — that is what lets a game keep score across messages in the same
 * chat while isolating chats from each other. `raw` is reconstructed from the
 * parsed argv, so original spacing and quoting are not preserved; handlers that
 * need verbatim input use `args`.
 */
export function registryToSpecs(reg: CommandRegistry): CommandSpec[] {
  const states = new Map<string, Map<string, unknown>>();
  return reg.list().map((cmd: Command): CommandSpec => ({
    name: cmd.name,
    description: cmd.summary,
    usage: cmd.usage,
    category: cmd.family ?? 'flux',
    cooldownMs: BRIDGE_COOLDOWN_MS,
    handler: async (pctx): Promise<void> => {
      let chat = states.get(pctx.jid);
      if (!chat) {
        chat = new Map<string, unknown>();
        states.set(pctx.jid, chat);
      }
      const argv = pctx.argv ?? [];
      const result = await cmd.handler({
        sock: pctx.sock,
        jid: pctx.jid,
        args: pctx.args,
        arg: (argv[0] ?? '').toLowerCase(),
        raw: argv.join(' '),
        sender: pctx.sender,
        state: chat,
        isOwner: pctx.isOwner,
        registry: { list: (filter) => reg.list(filter) },
      });
      if (result.error) {
        await pctx.replyPrivate(result.error);
        return;
      }
      if (result.image) {
        await pctx.sock.sendMessage(pctx.jid, { image: result.image });
        return;
      }
      if (result.text) {
        await pctx.reply(result.text);
      }
    },
  }));
}
