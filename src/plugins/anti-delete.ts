import { downloadMediaMessage, proto } from '@whiskeysockets/baileys';

import { createRevokedStore, type RevokedStore, type RevokedStoreOptions } from '../core/revoked-store.js';
import { firstMedia, sizeOf } from '../core/media.js';

import type { WAMessage } from '@whiskeysockets/baileys';
import type { Plugin } from '../utils/types.js';

/**
 * Anti-delete cache with media retention.
 *
 * ## Two corrections to the previous spec
 *
 * **1. `messageStubType === 44` is not a revoke.** In rc14 the enum lives at
 * `proto.WebMessageInfo.StubType` and `REVOKE = 1`. Value 44 is
 * `GROUP_ANNOUNCE_MODE_MESSAGE_BOUNCE`. Matching 44 caches group announcement
 * bounces and never a revoke — installed, silent, useless. The constant is read
 * from the enum rather than hardcoded so a protocol bump cannot redirect it.
 *
 * **2. "Download it immediately" at revoke time will not work.** A revoke
 * update carries only the stub — no media body, no `mediaKey`, no `directPath`.
 * There is nothing to hand `downloadMediaMessage`. Worse, by the time a revoke
 * lands the CDN object may already be reaped.
 *
 * So media is **prefetched on `messages.upsert`**, the only point where the
 * key material is present, and the bytes are held bounded until a revoke asks
 * for them. By revoke time the fetch is already paid for.
 *
 * ## Forwarding
 *
 * `{ forward: WAMessage }` is a real `AnyMessageContent` variant
 * (`Types/Message.d.ts:208`), so `sendMessage(jid, { forward })` is correct.
 * Forwarding is **opt-in per chat** and never fires for a group unless that
 * group is named in `forwardFrom` — a revoked message is content someone chose
 * to retract, and quietly relocating it into an unrelated chat is not a
 * retention decision, it is a disclosure one.
 */

export interface AntiDeleteOptions extends RevokedStoreOptions {
  store?: RevokedStore;
  /** Also capture ADMIN_REVOKE. Default true. */
  includeAdminRevoke?: boolean;
  /** Chat to forward revoked content into. Omit to cache only. */
  archiveJid?: string;
  /** Forward only from these senders/chats. Omit for all DMs. */
  forwardFrom?: readonly string[];
  /** Media larger than this is not prefetched; the stub is cached instead. Default 16 MiB. */
  maxMediaBytes?: number;
  /** Cap on retained media blobs across all messages. Default 50. */
  maxMediaBlobs?: number;
  /** Skip media prefetch entirely (text-only cache). */
  textOnly?: boolean;
}

export interface RetainedMedia {
  bytes: Buffer;
  mime: string;
  fileName: string;
  at: number;
}

/** `proto.WebMessageInfo.StubType.REVOKE` — 1, not 44. */
const REVOKE = proto.WebMessageInfo.StubType.REVOKE;

const keyOf = (key: { remoteJid?: string | null; id?: string | null } | undefined): string =>
  `${key?.remoteJid ?? ''}|${key?.id ?? ''}`;

export function antiDelete(options: AntiDeleteOptions = {}): Plugin {
  const maxMediaBytes = Math.max(1024, options.maxMediaBytes ?? 16 * 1024 * 1024);
  const maxBlobs = Math.max(1, options.maxMediaBlobs ?? 50);

  return {
    name: 'anti-delete',
    order: 170,

    apply(ctx) {
      const log = ctx.log.child('anti-delete');
      const store =
        options.store ??
        createRevokedStore({
          path: options.path,
          maxEntries: options.maxEntries,
          maxBytes: options.maxBytes,
          logger: log,
        });

      /** message key -> the message as received, so a revoke can be answered. */
      const live = new Map<string, WAMessage>();
      const maxLive = Math.max(64, options.maxEntries ?? 5_000);

      /** message key -> prefetched media. LRU by insertion order. */
      const blobs = new Map<string, RetainedMedia>();

      const counters = { captured: 0, missed: 0, admin: 0, prefetched: 0, skipped: 0, forwarded: 0 };

      const evictBlobs = (): void => {
        while (blobs.size > maxBlobs) {
          const oldest = blobs.keys().next().value;
          if (oldest === undefined) break;
          blobs.delete(oldest);
        }
      };

      const shouldForward = (jid: string): boolean => {
        if (!options.archiveJid) return false;
        if (!options.forwardFrom) return !jid.endsWith('@g.us');
        const device = jid.split(':')[0] ?? jid;
        return options.forwardFrom.includes(jid) || options.forwardFrom.includes(device);
      };

      /**
       * Download now, while the keys are still valid. `sizeOf` lets a declared
       * oversize file be skipped before spending the bandwidth — the declared
       * length is only ever used to refuse early, never to admit.
       */
      const prefetch = async (key: string, msg: WAMessage): Promise<void> => {
        if (options.textOnly || !firstMedia(msg)) return;

        const declared = sizeOf(msg);
        if (declared !== null && declared > maxMediaBytes) {
          counters.skipped += 1;
          log.debug('media over ceiling, caching stub only', { key, declared });
          return;
        }

        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {}, ctx.sock as never);
          if (!buffer.byteLength) return;
          if (buffer.byteLength > maxMediaBytes) {
            counters.skipped += 1;
            return;
          }

          const media = firstMedia(msg);
          blobs.set(key, {
            bytes: Buffer.from(buffer),
            mime: media?.mimetype ?? 'application/octet-stream',
            fileName: media?.fileName ?? `revoked_${key.replace(/[^a-z0-9]+/gi, '_')}`,
            at: Date.now(),
          });
          evictBlobs();
          counters.prefetched += 1;
        } catch (err) {
          // Prefetch is best-effort. A miss costs the media, not the socket.
          counters.skipped += 1;
          log.debug('prefetch failed', { key, err: (err as Error).message });
        }
      };

      const forward = async (key: string, msg: WAMessage): Promise<void> => {
        const jid = msg.key?.remoteJid ?? '';
        if (!shouldForward(jid)) return;

        try {
          const blob = blobs.get(key);
          if (blob) {
            // Re-send the bytes we already hold; the revoked original's media
            // references are no longer usable.
            await ctx.sock.sendMessage(options.archiveJid!, {
              image: blob.mime.startsWith('image/') ? { url: blob.bytes } : undefined,
              video: blob.mime.startsWith('video/') ? { url: blob.bytes } : undefined,
              audio: blob.mime.startsWith('audio/') ? { url: blob.bytes } : undefined,
              caption: `↩︎ revoked\n\n${textOf(msg)}`.trim(),
            } as never);
          } else {
            await ctx.sock.sendMessage(options.archiveJid!, {
              forward: msg as never,
            } as never);
          }
          counters.forwarded += 1;
        } catch (err) {
          // Forwarding is a side effect. Never let it break the cache.
          log.warn('forward failed', { key, err: (err as Error).message });
        }
      };

      ctx.sock.ev.on('messages.upsert', (event: { messages: WAMessage[] }) => {
        for (const msg of event.messages ?? []) {
          const key = keyOf(msg.key);
          if (!key) continue;
          live.set(key, msg);
          while (live.size > maxLive) {
            const oldest = live.keys().next().value;
            if (oldest === undefined) break;
            live.delete(oldest);
          }
          void prefetch(key, msg);
        }
      });

      ctx.sock.ev.on('messages.update', (updates) => {
        for (const update of updates ?? []) {
          const patch = update.update as
            | { messageStubType?: number; protocolMessage?: { type?: number } }
            | undefined;

          const isRevoke = patch?.messageStubType === REVOKE;
          const isAdmin =
            options.includeAdminRevoke !== false &&
            patch?.protocolMessage?.type === proto.Message.ProtocolMessage.Type.REVOKE;

          if (!isRevoke && !isAdmin) continue;
          if (isAdmin) counters.admin += 1;

          const key = keyOf(update.key);
          const cached = live.get(key);
          blobs.delete(key);

          if (!cached) {
            counters.missed += 1;
            log.debug('revoke for an unknown message', { key });
            continue;
          }

          live.delete(key);
          counters.captured += 1;

          void store
            .put(key, cached, {
              jid: update.key?.remoteJid ?? '',
              id: update.key?.id ?? '',
              participant: update.key?.participant ?? undefined,
              timestamp: Number(cached.messageTimestamp ?? 0) || undefined,
            })
            .then(() => {
              ctx.sock.ev.emit('super.revoked' as never, { key, message: cached } as never);
              return forward(key, cached);
            })
            .catch((err: unknown) => {
              log.warn('capture failed', { err: (err as Error).message });
            });
        }
      });

      Object.defineProperty(ctx.sock, 'revoked', {
        value: {
          get: (jid: string, id: string) => {
            const entry = store.get(`${jid}|${id}`);
            if (!entry) return undefined;
            return { jid: entry.jid, id: entry.id, message: entry.message as WAMessage, storedAt: entry.storedAt };
          },
          recent: (limit?: number) => store.recent(limit),
          stats: () => ({ ...counters, ...store.size(), blobs: blobs.size }),
          clear: () => store.clear(),
          live,
        },
        enumerable: false,
        configurable: true,
      });

      log.debug('attached', {
        maxEntries: options.maxEntries ?? 5_000,
        maxMediaBytes,
        forward: options.archiveJid ?? 'disabled',
      });
    },
  };
}

/** Best-effort body text for the archive caption. */
function textOf(msg: WAMessage): string {
  const m = msg.message as Record<string, unknown> | undefined;
  const get = (path: string[]): string | undefined => {
    let node: unknown = m;
    for (const key of path) {
      node = (node as Record<string, unknown> | undefined)?.[key];
      if (node === undefined || node === null) return undefined;
    }
    return typeof node === 'string' ? node : undefined;
  };

  return (
    get(['conversation']) ??
    get(['extendedTextMessage', 'text']) ??
    get(['imageMessage', 'caption']) ??
    get(['videoMessage', 'caption']) ??
    firstMedia(msg)?.caption ??
    ''
  );
}

export default antiDelete;
