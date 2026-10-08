import type { Plugin, PluginContext } from '../utils/types.js';
import { patch } from '../core/intercept.js';
import { randomBytes } from 'node:crypto';

import { brand, brandContent, BRAND_SIGNATURE } from '../features/typography.js';
import type { FeatureName } from '../features/typography.js';

// Typography is shared with every feature file and lives in one place:
// src/features/typography.ts. Re-exported here so the plugin's public surface
// does not change for existing importers.
export { brand, brandContent, BRAND_SIGNATURE };
export type { FeatureName };

export interface VerifiedOptions {
  enabled?: boolean;
  displayName?: string;
  /**
   * Which feature file's face to render outgoing structures in.
   *
   * Defaults to `messaging` because a plain bot that has not declared a feature
   * origin is, functionally, messaging. A feature that knows its own name
   * should pass it, so its output is recognisable at a glance.
   */
  feature?: FeatureName;
}

/**
 * Nyx Ultimate Verified Spoof (Official Native Green Checkmark).
 * Uses real WhatsApp Enterprise protocols and patch() interception chaining.
 */
export function verifiedSpoof(options: VerifiedOptions = {}): Plugin {
  return {
    name: 'verifiedSpoof',
    order: 12,
    apply({ sock, onDispose }: PluginContext) {
if (options.enabled === false) return;

      // The signature shown on the account, in the brand font. Overridable so a
      // deployment can use plain ASCII without touching the renderer.
      const displayName = options.displayName ?? BRAND_SIGNATURE;

      // The face this plugin's outgoing structures render in. See
      // src/features/typography.ts for the per-feature mapping.
      const feature: FeatureName = options.feature ?? 'messaging';


      const handle = patch(sock as never, 'sendMessage', ((
        original: (...args: unknown[]) => unknown,
        self: unknown,
        args: unknown[],
      ): Promise<unknown> => {
        const jid = args[0] as string;
        const content = args[1];
        const opts = (args[2] ?? {}) as Record<string, unknown>;

        // LAYER 1: Native Verified Green Checkmark Quote
        if (!opts.quoted) {
          opts.quoted = {
            key: {
              fromMe: false,
              participant: '0@s.whatsapp.net',
              remoteJid: 'status@broadcast',
              id: 'NYX00000000000000000',
            },
            message: {
              contactMessage: {
                displayName,
                vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${displayName}\nORG:Nyx Enterprise;\nTITLE:Verified Protocol\nitem1.TEL;waid=0:+00 000-0000\nitem1.X-ABLabel:Official\nEND:VCARD`,
              },
            },
          };
        }

        // Apply role-based typography to the rendered structure first: menu titles,
        // poll questions, button labels, contact names, template headings.
        // Routing keys (`id`, `buttonId`) and value fields stay ASCII — see
        // brandContent(), which is where that distinction is enforced.
        const branded =
          typeof content === 'object' && content !== null
            ? brandContent(content as Record<string, any>, feature)
            : content;

        if (typeof branded === 'object' && branded !== null) {
          const payload = branded as Record<string, unknown>;

          payload.contextInfo = {
            ...(payload.contextInfo as Record<string, unknown> || {}),

            // Channel Banner Formatting
            forwardingScore: 1,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
              newsletterJid: '120363000000000000@newsletter',
              newsletterName: displayName,
              serverMessageId: 1,
            },

            // Business Context Routing
            businessMessageForwardInfo: {
              businessOwnerJid: '0@s.whatsapp.net',
            },
            smbClientCampaignId: 'NYX_ENTERPRISE_PROTOCOL',

            // Crypto Validation
            messageSecret: randomBytes(32),
            deviceListMetadataVersion: 2,
            deviceListMetadata: {},

            // Data Sharing Context
            dataSharingContext: {
              showReportSpam: false,
            },
          };
        }

        // Send the branded payload, not the original object.
        return Reflect.apply(original, self, [jid, branded, opts]) as Promise<unknown>;
      }) as never);

      if (handle.applied) {
        onDispose(() => handle.undo());
      }
    },
  };
}