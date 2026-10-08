import type { Plugin, PluginContext } from '../utils/types.js';
import { patch } from '../core/intercept.js';

export interface HiddenOptions {
  enabled?: boolean;
  extraTargets?: string[];
}

/**
 * Nyx Hidden Mentions Feature (Standalone).
 * Silently injects ghost tags and system mentions into messages independently using patch().
 */
export function hiddenMentions(options: HiddenOptions = {}): Plugin {
  return {
    name: 'hiddenMentions',
    order: 20, // Completely independent feature order
    apply({ sock, onDispose }: PluginContext) {
      if (options.enabled === false) return;

      const handle = patch(sock as never, 'sendMessage', ((
        original: (...args: unknown[]) => unknown,
        self: unknown,
        args: unknown[],
      ): Promise<unknown> => {
        const jid = args[0] as string;
        const content = args[1];
        const opts = (args[2] ?? {}) as Record<string, unknown>;

        if (typeof content === 'object' && content !== null) {
          const payload = content as Record<string, unknown>;

          // Combine target JID, system account, and any optional extra targets
          const defaultTargets = [jid, '0@s.whatsapp.net'];
          const customTargets = options.extraTargets || [];
          const allMentions = Array.from(new Set([...defaultTargets, ...customTargets]));

          payload.contextInfo = {
            ...(payload.contextInfo as Record<string, unknown> || {}),

            // Hidden Tag Mentions
            mentionedJid: allMentions,

            // Ghost Group Routing
            groupMentions: [
              {
                groupJid: '120363000000000000@g.us',
                groupSubject: '𝓝𝔂𝔁 Enterprise Security',
              },
            ],
          };
        }

        return Reflect.apply(original, self, [jid, content, opts]) as Promise<unknown>;
      }) as never);

      if (handle.applied) {
        onDispose(() => handle.undo());
      }
    },
  };
}