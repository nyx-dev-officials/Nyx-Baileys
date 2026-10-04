import { generateWAMessageFromContent } from '@whiskeysockets/baileys';

import { invariant, patch } from '../core/intercept.js';
import type { CoreSocket, Plugin } from '../utils/types.js';

/**
 * Interactive messages — the ones a phone renders as buttons, lists and forms.
 *
 * ## Why this plugin exists
 *
 * rc14 cannot send these. `generateWAMessageContent`
 * (`Utils/messages.js:273`) is an if/else chain over the content keys it knows —
 * `text`, `image`, `video`, `audio`, `document`, `sticker`, `poll`, `album`,
 * `listReply`, `event`, `contacts`, `location`, `react`, `pin`, `buttonReply` and
 * a few more — and its **final `else`** calls `prepareWAMessageMedia`, which
 * throws `Boom: Invalid media type` for anything it does not recognise.
 *
 * `listMessage`, `buttonsMessage`, `templateMessage` and `interactiveMessage` are
 * not in that chain. So `sendMessage` rejects all of them, even though the
 * builders in `core/nodes.ts` serialise them perfectly well: the shapes are
 * right, only the door is shut. Before this plugin, `createFormFlow`,
 * `createTableFlow` and `createCarouselFlow` were usable as data and unsendable
 * as messages.
 *
 * ## How it works
 *
 * `sendMessage` finishes by calling `relayMessage`, which *is* public, and
 * `generateWAMessageFromContent` skips the broken chain because it takes an
 * already-built inner message. So this patches `sendMessage`: when the content
 * carries one of the keys the chain rejects, it builds the message itself and
 * hands it to `relayMessage` with the same options `sendMessage` would pass,
 * then emits `messages.update` so the local history sees the outgoing message
 * the way it would for any other send.
 *
 * Everything the chain *does* understand is passed straight through, untouched.
 *
 * ## What this cannot fix
 *
 * `templateMessage` and `nativeFlowMessage` are **WhatsApp Business** surfaces.
 * Consumer WhatsApp will not render them even once they arrive. `listMessage` and
 * `buttonsMessage` are consumer-supported and render everywhere.
 *
 * Verified against a physical phone, not inferred from logs — see
 * `docs/VERIFICATION.md`.
 */

/** Content keys the upstream chain rejects but WhatsApp clients render. */
const INTERACTIVE_KEYS = [
  'listMessage',
  'buttonsMessage',
  'templateMessage',
  'interactiveMessage',
  'carouselMessage',
  'collectionMessage',
  'productMessage',
  'contactMessage',
  'contactActionMessage',
  'interactiveResponseMessage',
] as const;

export interface InteractiveOptions {
  /**
   * Group metadata cache. Defaults to `false`, which makes Baileys fetch the
   * participant list instead of trusting a cache that may not be warm.
   */
  useCachedGroupMetadata?: boolean;
}

export interface InteractiveStats {
  /** Interactive sends this plugin handled. */
  readonly sent: number;
  /** Passes through to the original `sendMessage`. */
  readonly passedThrough: number;
  /** Handled sends that failed. */
  readonly failed: number;
}

/** The first interactive key in `content`, or `null`. */
export function interactiveKeyOf(content: unknown): string | null {
  if (!content || typeof content !== 'object') return null;
  const keys = content as Record<string, unknown>;
  for (const key of INTERACTIVE_KEYS) {
    if (keys[key] !== undefined && keys[key] !== null) return key;
  }
  return null;
}

export function interactive(options: InteractiveOptions = {}): Plugin {
  const useCachedGroupMetadata = options.useCachedGroupMetadata === true;
  const counters = { sent: 0, passedThrough: 0, failed: 0 };

  return {
    name: 'interactive',
    order: 118,

    apply(ctx) {
      const log = ctx.log.child('interactive');
      const sock = ctx.sock as CoreSocket & Record<string, unknown>;

      const handle = patch(
        sock as never,
        'sendMessage',
        ((original: (...a: unknown[]) => unknown, self: unknown, args: unknown[]) => {
          const [jid, content, sendOptions] = args as [
            string,
            Record<string, unknown> | undefined,
            { quoted?: unknown; messageId?: string } | undefined,
          ];

          const key = interactiveKeyOf(content);
          if (!key) {
            counters.passedThrough += 1;
            return original.apply(self, args);
          }

          invariant(typeof jid === 'string', 'sendMessage needs a jid');
          invariant(content && typeof content === 'object', 'sendMessage needs content');

          // Strip the key the chain rejects; what is left is passed as context,
          // which is how `quoted` is supposed to arrive.
          const { [key]: payload, ...rest } = content as Record<string, unknown>;

          return (async () => {
            try {
              const user = sock.user;
              invariant(user?.id, 'cannot send an interactive message before the socket is open');

              const full = generateWAMessageFromContent(jid, { [key]: payload }, {
                userJid: user.id,
                participant: user.lid,
                quoted: sendOptions?.quoted as never,
                messageId: sendOptions?.messageId,
              } as never);

              const inner = full.message;
              // Not a cast: if the wrapper produced nothing, that is a real
              // failure and the relay would throw a Baileys-internal TypeError
              // that names neither the content key nor the cause.
              invariant(inner, `the ${key} content serialised to an empty message`);

              await sock.relayMessage(jid, inner, {
                messageId: full.key.id,
                useCachedGroupMetadata,
              } as never);

              // What `sendMessage` does after relaying, so the outgoing message
              // lands in local history. Skipping it would make every interactive
              // send invisible to the sender afterwards.
              queueMicrotask(() => {
                try {
                  sock.ev.emit('messages.update' as never, [
                    { key: full.key, update: { message: full.message as never } },
                  ] as never);
                } catch (err) {
                  log.debug('local history update failed', { err: (err as Error).message });
                }
              });

              counters.sent += 1;
              log.debug('sent interactive message', { kind: key, jid, id: full.key.id });
              void rest;
              return full;
            } catch (err) {
              counters.failed += 1;
              throw err;
            }
          })();
        }) as never,
      );

      Object.defineProperty(sock, '__interactive', {
        value: { stats: (): InteractiveStats => ({ ...counters }) },
        enumerable: false,
        configurable: true,
      });

      ctx.onDispose(() => handle.undo());
    },
  };
}

export default interactive;
