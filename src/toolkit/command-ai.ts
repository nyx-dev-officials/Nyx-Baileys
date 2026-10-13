/**
 * The `ai` switchboard: global sleep/wake and permits.
 *
 * One command, subcommands distinguished by argv: `on`, `off`, `status`,
 * `permit <who>`, `unpermit <who>`, `permits`. State lives in `ai-state.ts` —
 * process-global and persisted beside the session, so waking in one chat
 * authorises every chat and a restart resumes instead of silently sleeping.
 *
 * Ownership is enforced inside the handler, not by the bridge: `on`, `off`,
 * `permit`, `unpermit` and `permits` refuse non-owners, `status` answers
 * anyone. The bridge passes `isOwner` through, so no framework change was
 * needed — and anyone probing the switch learns nothing except that it exists.
 */

import {
  isAwake,
  isChatPermitted,
  permitChat,
  permitPerson,
  permittedPersons,
  setAwake,
  unpermitPerson,
} from './ai-state.js';
import type { CommandContext, CommandResult } from './command-registry.js';

const OWNER_ONLY = 'Only the owner can do that.';

function subcommand(ctx: CommandContext): string[] {
  return (ctx.args ?? '').trim().split(/\s+/).filter(Boolean).map((s) => s.toLowerCase());
}

async function handleAi(ctx: CommandContext): Promise<CommandResult> {
  const [sub, target] = subcommand(ctx);
  switch (sub) {
    case 'on': {
      if (!ctx.isOwner) return { error: OWNER_ONLY };
      const changed = setAwake(true);
      return { text: changed ? 'AI awake — I reply while I am on. `flux off` to sleep.' : 'AI is already awake.' };
    }
    case 'off': {
      if (!ctx.isOwner) return { error: OWNER_ONLY };
      const changed = setAwake(false);
      return { text: changed ? 'AI asleep.' : 'AI is already asleep.' };
    }
    case 'status': {
      const lines = [
        `AI is ${isAwake() ? 'awake' : 'asleep'}.`,
        `This chat is ${isChatPermitted(ctx.jid) ? 'permitted' : 'not permitted'}.`,
      ];
      if (ctx.isOwner) {
        const persons = permittedPersons();
        lines.push(persons.length > 0 ? `Permitted persons: ${persons.join(', ')}` : 'No permitted persons.');
      }
      return { text: lines.join('\n') };
    }
    case 'permit': {
      if (!ctx.isOwner) return { error: OWNER_ONLY };
      if (!target) return { error: 'Usage: `flux ai permit <number>`.' };
      return { text: permitPerson(target) ? `Permitted ${target}.` : `${target} was already permitted.` };
    }
    case 'unpermit': {
      if (!ctx.isOwner) return { error: OWNER_ONLY };
      if (!target) return { error: 'Usage: `flux ai unpermit <number>`.' };
      return { text: unpermitPerson(target) ? `Unpermitted ${target}.` : `${target} was not permitted.` };
    }
    case 'permits': {
      if (!ctx.isOwner) return { error: OWNER_ONLY };
      const persons = permittedPersons();
      return { text: persons.length > 0 ? `Permitted persons: ${persons.join(', ')}` : 'No permitted persons.' };
    }
    default: {
      return { text: 'Usage: `flux ai on|off|status|permit <number>|unpermit <number>|permits`.' };
    }
  }
}

export function installAiCommands(reg: {
  command(c: { name: string; summary: string; effect: string; family?: string; usage?: string; handler: (ctx: CommandContext) => Promise<CommandResult> }): unknown;
}): void {
  reg.command({
    name: 'ai',
    summary: 'Global AI sleep/wake switch and permits.',
    effect: 'flip the process-wide AI gate; owner-only except status',
    family: 'core',
    usage: 'on|off|status|permit <number>|unpermit <number>|permits',
    handler: handleAi,
  });
}
