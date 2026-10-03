import { getContentType } from '@whiskeysockets/baileys';

import { firstMedia, mediaKeyOf, mimeOf, sizeOf } from '../core/media.js';

import type { BaileysEventMap, WAMessage } from '@whiskeysockets/baileys';
import type { Plugin } from '../utils/types.js';

/**
 * Status ("stories") inbox.
 *
 * ## There is no status event in rc14
 *
 * A first instinct is to look for a `status.update` listener. There isn't one —
 * `BaileysEventMap` has no status member at all. Statuses arrive as ordinary
 * messages on the reserved `status@broadcast` jid, so `messages.upsert` is the
 * only intake, and `remoteJid === 'status@broadcast'` is the only way to tell a
 * status from a normal message. The same goes for `IMessage`, which has a
 * `statusAddYours` field but no generic status wrapper to test for.
 *
 * Two consequences shape this file:
 *   - **Text lives in three different places** depending on the variant, and
 *     rc14 has no root `contextInfo` to hide behind. `conversation` for a plain
 *     status, `extendedTextMessage.text` for a quoted/forwarded one, and the
 *     per-media field's own `caption` for a photo or video. Reading only the
 *     first two silently drops every caption.
 *   - **Deletions are keyed, not jid-scoped**, so `messages.delete` arrives as
 *     `{ keys }` and has to be matched against tracked ids. A status removed by
 *     its author is a normal event and must not linger in the index.
 */

export interface StatusEntry {
  readonly id: string;
  /** Normalised author jid. */
  readonly jid: string;
  readonly at: number;
  /** `keyof proto.IMessage` for the payload, e.g. `imageMessage`. */
  readonly kind?: string;
  readonly text: string;
  /** True for a caption on media rather than a text status. */
  readonly caption: boolean;
  readonly mime?: string;
  readonly bytes?: number;
  /** Which media field carried the payload, when any did. */
  readonly mediaKey?: string;
  /** Author-supplied expiry, when present. */
  readonly expiresAt?: number;
  /** Set once the author deletes it. */
  removed?: boolean;
}

export interface StatusOptions {
  /** Max statuses retained. Oldest evicted first. */
  max?: number;
  /** Ignore statuses from these jids. */
  ignore?: (jid: string) => boolean;
}

const STATUS_JID = 'status@broadcast';

const isStatusJid = (jid: string | null | undefined): boolean => jid === STATUS_JID;

/**
 * Text for a status, from whichever field this variant used.
 *
 * The media caption is read through `firstMedia`, because in rc14 the caption
 * lives inside the per-type media field — there is no root `contextInfo` and no
 * `message.media`.
 */
function textOf(msg: WAMessage): { text: string; caption: boolean } {
  const m = msg.message as
    | {
        conversation?: string | null;
        extendedTextMessage?: { text?: string | null } | null;
      }
    | null
    | undefined;

  const conversation = m?.conversation;
  if (conversation) return { text: conversation, caption: false };

  const extended = m?.extendedTextMessage?.text;
  if (extended) return { text: extended, caption: false };

  const mediaCaption = firstMedia(msg)?.caption;
  if (mediaCaption) return { text: mediaCaption, caption: true };

  return { text: '', caption: false };
}

export function statusFeed(options: StatusOptions = {}): Plugin {
  const max = Math.max(1, options.max ?? 200);

  return {
    name: 'status',
    order: 130,

    apply(ctx) {
      const log = ctx.log.child('status');
      /** Author jid -> status ids, newest first. */
      const byAuthor = new Map<string, string[]>();
      /** status id -> entry. */
      const entries = new Map<string, StatusEntry>();

      const evict = (): void => {
        while (entries.size > max) {
          const oldest = entries.keys().next().value;
          if (oldest === undefined) break;
          const entry = entries.get(oldest);
          if (entry) {
            const ids = byAuthor.get(entry.jid);
            if (ids) {
              const at = ids.indexOf(oldest);
              if (at !== -1) ids.splice(at, 1);
              if (ids.length === 0) byAuthor.delete(entry.jid);
            }
          }
          entries.delete(oldest);
        }
      };

      const ingest = (msg: WAMessage): void => {
        const key = msg.key;
        if (!key?.id) return;
        const jid = key.participant ?? key.remoteJid ?? '';
        if (!jid) return;
        if (key.fromMe) return;
        if (options.ignore?.(jid)) return;

        // A history re-delivery must not reset an edited status.
        if (entries.has(key.id)) return;

        const { text, caption } = textOf(msg);
        const kind = getContentType(msg.message ?? undefined);
        const bytes = sizeOf(msg);
        // Hoisted so the null case narrows: `mediaKeyOf(msg)` twice would not.
        const mediaKey = mediaKeyOf(msg);
        const mime = mimeOf(msg);
        const expires = (msg.message as { messageContextInfo?: { expiration?: number | null } | null } | undefined)
          ?.messageContextInfo?.expiration;

        const entry: StatusEntry = {
          id: key.id,
          jid,
          at: Number(msg.messageTimestamp ?? Date.now()),
          ...(kind ? { kind } : {}),
          text,
          caption,
          ...(mime ? { mime } : {}),
          ...(bytes !== null ? { bytes } : {}),
          ...(mediaKey ? { mediaKey } : {}),
          ...(expires ? { expiresAt: Date.now() + expires * 1000 } : {}),
        };

        entries.set(entry.id, entry);
        const ids = byAuthor.get(jid) ?? [];
        ids.unshift(entry.id);
        byAuthor.set(jid, ids);
        evict();

        log.debug('status seen', { jid, kind: entry.kind ?? 'text' });
        ctx.sock.ev.emit('nyx.status' as never, entry as never);
      };

      ctx.sock.ev.on('messages.upsert', (event: BaileysEventMap['messages.upsert']) => {
        for (const msg of event?.messages ?? []) {
          if (!isStatusJid(msg.key?.remoteJid)) continue;
          ingest(msg);
        }
      });

      ctx.sock.ev.on('messages.delete', (event: BaileysEventMap['messages.delete']) => {
        // `{ jid, all: true }` wipes a chat's history; that can name status@broadcast.
        if (!('keys' in event)) return;
        for (const key of event.keys ?? []) {
          const entry = entries.get(key.id ?? '');
          if (!entry) continue;
          const removed: StatusEntry = { ...entry, removed: true };
          entries.set(removed.id, removed);
          ctx.sock.ev.emit('nyx.statusRemoved' as never, removed as never);
        }
      });

      /* ── surface ────────────────────────────────────────────────── */

      const recent = (jid?: string, limit = 50): StatusEntry[] => {
        const all = jid
          ? (byAuthor.get(jid) ?? []).map((id) => entries.get(id)).filter((e): e is StatusEntry => !!e)
          : [...entries.values()];
        return all.slice(0, Math.max(0, limit));
      };

      const stats = (): { authors: number; total: number; removed: number } => ({
        authors: byAuthor.size,
        total: entries.size,
        removed: [...entries.values()].filter((e) => e.removed).length,
      });

      Object.defineProperty(ctx.sock, 'statuses', { value: entries, enumerable: false, configurable: true });
      Object.defineProperty(ctx.sock, 'statusByAuthor', { value: byAuthor, enumerable: false, configurable: true });
      Object.defineProperty(ctx.sock, 'getStatus', {
        value: (id: string): StatusEntry | undefined => entries.get(id),
        enumerable: false,
        configurable: true,
      });
      Object.defineProperty(ctx.sock, 'recentStatuses', { value: recent, enumerable: false, configurable: true });
      Object.defineProperty(ctx.sock, 'statusStats', { value: stats, enumerable: false, configurable: true });

      log.debug('attached', { max });
    },
  };
}

export default statusFeed;
