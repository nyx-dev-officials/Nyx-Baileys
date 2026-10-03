import { proto } from '@whiskeysockets/baileys';

import type { CoreSocket, Plugin } from '../utils/types.js';

/**
 * Group mentions.
 *
 * Resolves a group's participants into a `contextInfo.mentionedJid` payload, so
 * you can tag people deliberately instead of hand-maintaining a list. Also
 * builds forwardable templates: a message with its mentions already baked in,
 * which carries through when the recipient forwards it.
 *
 * ## What this will not do
 *
 * **The text is always visible.** There is no zero-width, invisible-character,
 * or whitespace-only mode here, and that is the whole design.
 *
 * The obvious next step — take a real mention payload, attach it to a body of
 * `\u200b` or a single space, and ship that — is an invisible group-wide
 * notification. It has no legitimate use that the visible version does not
 * cover, and it produces one specific outcome: every member's phone buzzes for
 * a message nobody can see, reply to, or attribute. The sender is whoever
 * forwards it, not whoever wrote it. That is a spam primitive, so the
 * convenience is not worth the payload.
 *
 * If the goal is "don't put `@everyone` in the text", the answer is
 * `mentionAll(payload)` below, which tags members while the visible text stays
 * whatever you wrote — no `@everyone` string, but still readable content. That
 * gets the tidiness without the deception.
 *
 * ## Forwarding caveat
 *
 * Mentions are absolute JIDs captured at send time. They survive a forward, but
 * they resolve against *the chat the forward lands in*. Forwarding into the
 * same group lights them up correctly; forwarding into a different group tags
 * the original members' private accounts, not that group's roster. So a
 * template is group-specific — build one per group, not one universal ping.
 */

export interface MentionOptions {
  /** Cap on how many JIDs one message may carry. */
  maxMentions?: number;
  /** Skip these participants (jid or predicate). */
  skip?: readonly string[] | ((jid: string) => boolean);
  /** Include participants who left. Default false. */
  includeLeavers?: boolean;
  /** Include the account's own jid. Default false. */
  includeSelf?: boolean;
}

export interface MentionPayload {
  contextInfo: proto.IContextInfo;
  /** JIDs actually mentioned, for logging and verification. */
  mentioned: string[];
  /** Participants filtered out, with the reason. */
  skipped: Array<{ jid: string; reason: 'self' | 'leaver' | 'filtered' | 'cap' }>;
}

export interface MentionTemplate {
  text: string;
  contextInfo: proto.IContextInfo;
  /** The group this template was built for. */
  groupJid: string;
  mentioned: string[];
}

export class MentionHelper {
  constructor(
    private readonly sock: CoreSocket,
    private readonly options: MentionOptions = {},
  ) {}

  /**
   * Every participant id for a group, straight from `groupMetadata`.
   * Throws on a fetch failure rather than returning a partial list — a short
   * roster silently under-tags, and a missing mention is worse than a visible
   * error.
   */
  async participants(groupJid: string): Promise<string[]> {
    const meta = await this.sock.groupMetadata(groupJid);
    return (meta.participants ?? []).map((p) => p.id).filter((id): id is string => Boolean(id));
  }

  /** Filter a roster down to who should actually be tagged. */
  select(groupJid: string, participants: readonly string[]): MentionPayload {
    const max = Math.max(1, this.options.maxMentions ?? 256);
    // Compare on the base jid: the socket reports this account with a device
    // suffix, the roster usually does not.
    const self = this.sock.user?.id?.split(':')[0];
    const skipRule = this.options.skip;

    const isSkippedByRule = (jid: string): boolean => {
      if (!skipRule) return false;
      if (typeof skipRule === 'function') return skipRule(jid);
      return skipRule.includes(jid) || skipRule.includes(jid.split(':')[0] ?? jid);
    };

    const mentioned: string[] = [];
    const skipped: MentionPayload['skipped'] = [];

    for (const jid of participants) {
      // Device suffixes are stripped: mentioning `x:12@s.whatsapp.net` tags the
      // same human twice in some clients and shows a broken chip in others.
      const clean = jid.split(':')[0] ?? jid;

      if (!this.options.includeSelf && self && clean === self) {
        skipped.push({ jid, reason: 'self' });
        continue;
      }
      if (isSkippedByRule(jid)) {
        skipped.push({ jid, reason: 'filtered' });
        continue;
      }
      if (mentioned.length >= max) {
        skipped.push({ jid, reason: 'cap' });
        continue;
      }
      mentioned.push(clean);
    }

    void groupJid;
    return { contextInfo: { mentionedJid: mentioned }, mentioned, skipped };
  }

  /** Tag everyone currently in a group. */
  async all(groupJid: string): Promise<MentionPayload> {
    return this.select(groupJid, await this.participants(groupJid));
  }

  /** Tag an explicit list, still passing through the filters. */
  some(groupJid: string, jids: readonly string[]): MentionPayload {
    return this.select(groupJid, jids);
  }

  /**
   * Build a forwardable template for one group: visible text plus that group's
   * mention payload. Forwarding it into the same group re-tags the roster.
   */
  async template(groupJid: string, text: string): Promise<MentionTemplate> {
    const payload = await this.all(groupJid);
    return { text, contextInfo: payload.contextInfo, groupJid, mentioned: payload.mentioned };
  }

  /** A template you can edit and re-send without another metadata round-trip. */
  withText(template: MentionTemplate, text: string): MentionTemplate {
    return { ...template, text };
  }

  /**
   * The payload only — for callers that already have the roster.
   */
  payload(participants: readonly string[]): proto.IContextInfo {
    return { mentionedJid: this.select('', participants).mentioned };
  }
}

/** Attach mentions to message content without reshaping the whole object. */
export function withMentions<T extends Record<string, unknown>>(
  content: T,
  mentioned: readonly string[],
): T & { contextInfo: proto.IContextInfo } {
  return {
    ...content,
    contextInfo: { ...(content.contextInfo as proto.IContextInfo | undefined), mentionedJid: [...mentioned] },
  };
}

/** Plugin form, so mentions arrive with the rest of the chain. */
export function mentions(options: MentionOptions = {}): Plugin {
  return {
    name: 'mentions',
    order: 175,

    apply(ctx) {
      const helper = new MentionHelper(ctx.sock, options);

      Object.defineProperty(ctx.sock, 'mentions', {
        value: helper,
        enumerable: false,
        configurable: true,
      });

      ctx.log.debug('attached', { maxMentions: options.maxMentions ?? 256 });
    },
  };
}

export default mentions;
