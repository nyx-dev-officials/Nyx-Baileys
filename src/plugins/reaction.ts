import { generateMessageID, jidNormalizedUser, proto } from '@whiskeysockets/baileys';

import type { BaileysEventMap, WAMessageKey } from '@whiskeysockets/baileys';
import type { Plugin } from '../utils/types.js';

/**
 * Message reactions — outbound, inbound, and a bounded index of who reacted.
 *
 * Outbound goes through `sendMessage({ react })`, so the reaction is built by
 * upstream's own `normalizeMessageContent` and no wire object is hand-rolled
 * here. An empty `text` is the removal, which is the same message type — so
 * `unreact` is not a special case on the wire, only in our API.
 *
 * Inbound arrives on the `messages.reaction` event, one entry per reaction, as
 * `{ key, reaction }` where `key` is the *reacted-to* message. There is no
 * batch-summary event, so an index has to be maintained here.
 *
 * The allowed-emoji set is policy, not protocol: WhatsApp will accept a
 * reaction outside this list and may render it differently per client version.
 * The set exists so a typo like `'thumbsup'` fails loudly instead of sending a
 * reaction nobody sees. Replace or extend it via `allowed` — the default below
 * is the common picker set, not an exhaustive mirror of every client.
 */

export interface ReactionOptions {
  /**
   * Reactions this deployment will send. Replaces the default set entirely.
   * Pass `[]` to allow anything (useful against a server that has grown a
   * reaction the client list here does not know).
   */
  allowed?: readonly string[];
  /** Merge into the default set instead of replacing it. Default false. */
  extend?: boolean;
  /** Max reacted-to messages kept in the index. Oldest evicted first. */
  maxTracked?: number;
  /** Max distinct reactors remembered per message. */
  maxReactorsPerMessage?: number;
}

/** The default allowed set. Overridable; see `allowed`. */
export const DEFAULT_REACTION_EMOJI: readonly string[] = [
  '👍', '👎', '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍',
  '💯', '✅', '❌', '❓', '❗', '🔥', '🎉', '🚀', '💡', '⭐',
  '😂', '🤣', '😍', '🥰', '😎', '🤔', '😢', '😭', '😡', '🙏',
  '👏', '🙌', '🤝', '👀', '💀', '🤡',
];

/** One reaction as observed on a message. */
export interface ObservedReaction {
  /** Normalised jid of the reactor. */
  readonly jid: string;
  /** The emoji. Empty string means the reaction was removed. */
  readonly emoji: string;
  readonly at: number;
  readonly groupingKey?: string;
}

export interface MessageReactions {
  readonly key: string;
  readonly jid: string;
  readonly reactions: ReadonlyMap<string, ObservedReaction>;
  readonly updatedAt: number;
}

/** Stable identity for a message key: chat + author + id. */
function keyId(key: WAMessageKey): string {
  const author = key.participant ?? key.remoteJid ?? '';
  return `${key.remoteJid ?? ''}|${author}|${key.id ?? ''}`;
}

export function reactions(options: ReactionOptions = {}): Plugin {
  const allowed = options.extend
    ? [...DEFAULT_REACTION_EMOJI, ...(options.allowed ?? [])]
    : (options.allowed ?? DEFAULT_REACTION_EMOJI);
  const maxTracked = Math.max(1, options.maxTracked ?? 500);
  const maxReactors = Math.max(1, options.maxReactorsPerMessage ?? 64);

  return {
    name: 'reactions',
    order: 125,

    apply(ctx) {
      const log = ctx.log.child('reaction');

      /**
       * The reaction index. Entries carry a mutable map behind a readonly
       * field, which is exactly the shape `MessageReactions` promises while
       * letting a removal update in place without reallocating the outer map.
       */
      const tracked = new Map<string, { key: string; jid: string; reactions: Map<string, ObservedReaction>; updatedAt: number }>();

      const evict = (): void => {
        while (tracked.size > maxTracked) {
          const oldest = tracked.keys().next().value;
          if (oldest === undefined) break;
          tracked.delete(oldest);
        }
      };

      const ensure = (key: WAMessageKey): { key: string; jid: string; reactions: Map<string, ObservedReaction>; updatedAt: number } => {
        const id = keyId(key);
        const hit = tracked.get(id);
        if (hit) return hit;
        const created = {
          key: id,
          jid: key.remoteJid ?? '',
          reactions: new Map<string, ObservedReaction>(),
          updatedAt: Date.now(),
        };
        tracked.set(id, created);
        evict();
        return created;
      };

      /**
       * Validate before sending. An empty emoji is the removal and is always
       * legal; anything else must be in the set.
       */
      const assertAllowed = (emoji: string): void => {
        if (emoji === '') return;
        if (allowed.length > 0 && !allowed.includes(emoji)) {
          throw new Error(
            `reaction ${emoji} is not in the allowed set — pass ReactionOptions.allowed to widen it`,
          );
        }
      };

      const react = async (jid: string, key: WAMessageKey, emoji: string): Promise<void> => {
        assertAllowed(emoji);
        // `proto.Message.IReactionMessage` is the documented content type for
        // `sendMessage({ react })`; upstream fills in the timestamp itself.
        const content: proto.Message.IReactionMessage = proto.Message.ReactionMessage.create({
          key,
          text: emoji,
          groupingKey: generateMessageID(),
        });
        await ctx.sock.sendMessage(jid, { react: content });
        log.debug('reacted', { jid, message: key.id, emoji });
      };

      /** Removal: the same message with an empty `text`. */
      const unreact = async (jid: string, key: WAMessageKey): Promise<void> => {
        await react(jid, key, '');
      };

      /** `null` emoji removes; otherwise toggles only if it differs. */
      const setReaction = async (
        jid: string,
        key: WAMessageKey,
        emoji: string | null,
      ): Promise<void> => {
        if (emoji === null) return unreact(jid, key);
        return react(jid, key, emoji);
      };

      ctx.sock.ev.on('messages.reaction', (event: BaileysEventMap['messages.reaction']) => {
        for (const entry of event ?? []) {
          if (!entry?.key) continue;
          const bucket = ensure(entry.key);
          const jid = jidNormalizedUser(entry.reaction?.key?.participant ?? entry.reaction?.key?.remoteJid ?? '');

          // A reactor already in the map means this is a change or a removal.
          // Overwriting is correct for both — WhatsApp keeps one reaction per
          // person per message, and `text: ''` is how a removal arrives.
          if (!bucket.reactions.has(jid) && bucket.reactions.size >= maxReactors) {
            const oldest = bucket.reactions.keys().next().value;
            if (oldest !== undefined) bucket.reactions.delete(oldest);
          }

          const observed: ObservedReaction = {
            jid,
            emoji: entry.reaction?.text ?? '',
            at: Number(entry.reaction?.senderTimestampMs ?? Date.now()),
            ...(entry.reaction?.groupingKey ? { groupingKey: entry.reaction.groupingKey } : {}),
          };
          bucket.reactions.set(jid, observed);
          bucket.updatedAt = Date.now();

          ctx.sock.ev.emit('nyx.reaction' as never, { ...observed, key: entry.key } as never);
        }
      });

      /* ── surface ────────────────────────────────────────────────── */

      /** Current reactions on a message, excluding removals. */
      const of = (key: WAMessageKey): readonly ObservedReaction[] => {
        const bucket = tracked.get(keyId(key));
        if (!bucket) return [];
        return [...bucket.reactions.values()].filter((r) => r.emoji !== '');
      };

      Object.defineProperty(ctx.sock, 'trackedReactions', { value: tracked, enumerable: false, configurable: true });
      Object.defineProperty(ctx.sock, 'react', { value: react, enumerable: false, configurable: true });
      Object.defineProperty(ctx.sock, 'unreact', { value: unreact, enumerable: false, configurable: true });
      Object.defineProperty(ctx.sock, 'setReaction', { value: setReaction, enumerable: false, configurable: true });
      Object.defineProperty(ctx.sock, 'reactionsOf', { value: of, enumerable: false, configurable: true });
      Object.defineProperty(ctx.sock, 'allowedReactions', {
        value: [...allowed],
        enumerable: false,
        configurable: true,
      });

      log.debug('attached', { allowed: allowed.length, maxTracked });
    },
  };
}

export default reactions;
