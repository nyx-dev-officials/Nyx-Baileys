/**
 * Everyday WhatsApp operations — the parts that touch a chat's *settings*
 * rather than its message stream.
 *
 * Sends are already covered elsewhere (`interactive`, `media-stream`, `album`,
 * and plain `sendMessage`). What was missing is the group and chat admin
 * surface: subject, description, invite link, mute, archive, pin, star, label,
 * clear, mark-read.
 *
 * All of it is a thin, typed pass-through to rc14. The value is not the calls —
 * it is that they exist in one place, are typed against the real rc14 surface,
 * and refuse to invent a jid or silently no-op.
 *
 * ## What rc14 actually supports
 *
 * `chatModify` takes a discriminated union, not a bag of booleans. Passing
 * `{ archive: true, pin: true }` matches no member of the union and rc14 picks a
 * branch silently. Every method here therefore sends exactly one shape, so a
 * caller cannot accidentally combine two.
 *
 * Verified against rc14 7.0.0-rc14 (`Types/Chat.d.ts:63`):
 *   archive · pin · mute · clear · star · markRead · deleteForMe · delete
 *   pushNameSetting · contact · disableLinkPreviews
 *   addLabel · addChatLabel · removeChatLabel · addMessageLabel · removeMessageLabel
 *
 * There is no `decryptMediaMessage` in rc14 — that is a v6-era name. The current
 * one is `downloadMediaMessage`, already used by `media-stream`. Anything
 * offering you a `decryptMediaMessage` import is describing an older Baileys.
 */

import { invariant } from '../core/intercept.js';
import type { CoreSocket, Plugin } from '../utils/types.js';

/** Group metadata as returned by `groupMetadata`. */
export interface GroupSummary {
  id: string;
  subject: string;
  description?: string;
  owner?: string;
  participants: number;
  inviteCode?: string;
  creation?: number;
}

export interface ChatOpsOptions {
  /**
   * Cache group metadata for this long. A group invite link costs a round trip,
   * and `groupAdmin` is called often enough that caching matters. `0` disables.
   */
  metadataCacheMs?: number;
}

/**
 * `chatModify` is a discriminated union in rc14. Sending more than one key at a
 * time matches no member, and rc14 does not complain — it just takes a branch.
 * So each operation below sends exactly one shape.
 */
type ChatModification =
  | { archive: boolean; lastMessages: unknown[] }
  | { pin: boolean }
  | { mute: number | null }
  | { clear: boolean; lastMessages: unknown[] }
  | { star: { messages: Array<{ id: string; fromMe?: boolean }>; star: boolean } }
  | { markRead: boolean; lastMessages: unknown[] }
  | { addChatLabel: { labelId: string } };

export function chatOps(options: ChatOpsOptions = {}): Plugin {
  const cacheMs = options.metadataCacheMs ?? 60_000;

  return {
    name: 'chat-ops',
    // After group-guard (60) and session-repair (65): both normalise the target
    // jid first, so an operator passing a phone number gets the same resolution
    // an outbound send would.
    order: 66,

    apply(ctx) {
      const log = ctx.log.child('chat-ops');
      const sock = ctx.sock as CoreSocket & Record<string, unknown>;

      const isGroup = (jid: string): boolean => jid.endsWith('@g.us');
      const check = (jid: string): void => {
        invariant(typeof jid === 'string' && jid.length > 0, 'a jid is required');
      };
      const checkGroup = (jid: string): void => {
        check(jid);
        invariant(isGroup(jid), `${jid} is not a group — expected a @g.us jid`);
      };

      /** One shape per call. Passing extras is what breaks the union. */
      const modify = async (jid: string, mod: ChatModification): Promise<void> => {
        check(jid);
        await (sock as unknown as {
          chatModify: (m: unknown, j: string) => Promise<void>;
        }).chatModify(mod, jid);
        log.debug('chat modified', { jid, mod });
      };

      // ── group metadata ──────────────────────────────────────────────────
      const metaCache = new Map<string, { at: number; value: GroupSummary }>();

      const summarise = async (jid: string): Promise<GroupSummary> => {
        const meta = (await (sock as unknown as {
          groupMetadata: (j: string) => Promise<{
            id?: string; subject?: string; desc?: string; owner?: string;
            participants?: unknown[]; creation?: number; inviteCode?: string;
          }>;
        }).groupMetadata(jid));

        invariant(meta, `no metadata for group ${jid}`);
        return {
          id: meta.id ?? jid,
          subject: meta.subject ?? '',
          description: meta.desc ?? undefined,
          owner: meta.owner ?? undefined,
          participants: meta.participants?.length ?? 0,
          inviteCode: meta.inviteCode ?? undefined,
          creation: meta.creation ?? undefined,
        };
      };

      const metadata = async (jid: string, fresh = false): Promise<GroupSummary> => {
        checkGroup(jid);
        if (!fresh && cacheMs > 0) {
          const hit = metaCache.get(jid);
          if (hit && Date.now() - hit.at < cacheMs) return hit.value;
        }
        const value = await summarise(jid);
        if (cacheMs > 0) metaCache.set(jid, { at: Date.now(), value });
        return value;
      };

      // ── group administration ─────────────────────────────────────────────
      const updateSubject = async (jid: string, subject: string): Promise<void> => {
        checkGroup(jid);
        invariant(subject.trim().length > 0, 'a subject is required');
        await (sock as unknown as {
          groupUpdateSubject: (j: string, s: string) => Promise<void>;
        }).groupUpdateSubject(jid, subject);
        metaCache.delete(jid); // stale now, and cheap to refetch
        log.debug('group subject updated', { jid, subject });
      };

      const updateDescription = async (jid: string, description: string): Promise<void> => {
        checkGroup(jid);
        // An empty description is how you *clear* it, so this cannot be rejected.
        await (sock as unknown as {
          groupUpdateDescription: (j: string, d: string) => Promise<void>;
        }).groupUpdateDescription(jid, description);
        metaCache.delete(jid);
        log.debug('group description updated', { jid });
      };

      /**
       * The shareable join link.
       *
       * `groupInviteCode` returns just the code, and rc14 leaves it undefined
       * for a group this account cannot invite into — so the invite is requested
       * rather than assumed, and a group the account does not own fails loudly
       * instead of producing `https://chat.whatsapp.com/undefined`.
       */
      const inviteLink = async (jid: string): Promise<string> => {
        checkGroup(jid);
        let code = (await metadata(jid)).inviteCode;
        if (!code) {
          code = await (sock as unknown as {
            groupInviteCode: (j: string) => Promise<string>;
          }).groupInviteCode(jid);
        }
        invariant(code, `no invite code for ${jid} — is this account an admin?`);
        return `https://chat.whatsapp.com/${code}`;
      };

      const revokeInvite = async (jid: string): Promise<void> => {
        checkGroup(jid);
        await (sock as unknown as {
          groupRevokeInvite: (j: string) => Promise<void>;
        }).groupRevokeInvite(jid);
        metaCache.delete(jid);
        log.debug('invite revoked', { jid });
      };

      // ── per-chat settings ────────────────────────────────────────────────
      // Async even where the only work is validation: a synchronous throw from a
      // promise-returning surface breaks a caller's `.catch()` and reads as a
      // different kind of failure than every other method here.
      const setMute = async (jid: string, durationMs: number | null): Promise<void> => {
        invariant(durationMs === null || durationMs > 0, 'a mute needs a positive duration');
        // rc14's `mute` is an absolute expiry timestamp, or null to unmute.
        await modify(jid, { mute: durationMs === null ? null : Date.now() + durationMs });
      };

      const setArchive = (jid: string, archived: boolean): Promise<void> =>
        modify(jid, { archive: archived, lastMessages: [] });

      const setPin = async (jid: string, pinned: boolean): Promise<void> =>
        await modify(jid, { pin: pinned });

      const setStar = async (
        jid: string,
        key: { id: string; fromMe?: boolean },
        starred: boolean,
      ): Promise<void> => {
        invariant(key?.id, 'a message id is required to star');
        // This is a chatModification, not a message content key. Sending it via
        // sendMessage does nothing at all, which is a common mistake.
        await modify(jid, { star: { messages: [{ id: key.id, fromMe: key.fromMe }], star: starred } });
      };

      const setLabel = async (jid: string, labelId: string): Promise<void> => {
        invariant(labelId, 'a labelId is required');
        await modify(jid, { addChatLabel: { labelId } });
      };

      const clearChat = (jid: string): Promise<void> =>
        modify(jid, { clear: true, lastMessages: [] });

      const markRead = (jid: string): Promise<void> =>
        modify(jid, { markRead: true, lastMessages: [] });

      const api = {
        metadata,
        updateSubject,
        updateDescription,
        inviteLink,
        revokeInvite,
        setMute,
        setArchive,
        setPin,
        setStar,
        setLabel,
        clearChat,
        markRead,
      };

      Object.defineProperty(sock, 'chatOps', { value: api, enumerable: false, configurable: true });
      log.debug('attached');
    },
  };
}

export default chatOps;
