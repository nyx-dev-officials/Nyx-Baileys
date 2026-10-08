import { downloadMediaMessage, proto } from '@whiskeysockets/baileys';

import { createRevokedStore, type RevokedStore, type RevokedStoreOptions } from '../core/revoked-store.js';
import { firstMedia, sizeOf } from '../core/media.js';

import type { WAMessage } from '@whiskeysockets/baileys';
import type { Plugin } from '../utils/types.js';

export interface AntiDeleteOptions extends RevokedStoreOptions {
  store?: RevokedStore;
  /** Also capture ADMIN_REVOKE. Default true. */
  includeAdminRevoke?: boolean;
  /** Chat to forward revoked content into. Defaults to your owner number. */
  archiveJid?: string;
  /** Forward only from these senders/chats. Omit to forward from all chats and groups. */
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

const REVOKE = proto.WebMessageInfo.StubType.REVOKE;

const keyOf = (key: { remoteJid?: string | null; id?: string | null } | undefined): string =>
  `${key?.remoteJid ?? ''}|${key?.id ?? ''}`;

export function antiDelete(options: AntiDeleteOptions = {}): Plugin {
  const maxMediaBytes = Math.max(1024, options.maxMediaBytes ?? 16 * 1024 * 1024);
  const maxBlobs = Math.max(1, options.maxMediaBlobs ?? 50);
  
  // Default archive target set to your WhatsApp number (+62 882-0174-67912)
  const archiveJid = options.archiveJid ?? '62882017467912@s.whatsapp.net';

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

      const live = new Map<string, WAMessage>();
      const maxLive = Math.max(64, options.maxEntries ?? 5_000);

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
        if (!archiveJid) return false;
        if (!options.forwardFrom) return true; // Forward from all chats & groups by default
        const device = jid.split(':')[0] ?? jid;
        return options.forwardFrom.includes(jid) || options.forwardFrom.includes(device);
      };

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
          counters.skipped += 1;
          log.debug('prefetch failed', { key, err: (err as Error).message });
        }
      };

      const forward = async (key: string, msg: WAMessage): Promise<void> => {
        const jid = msg.key?.remoteJid ?? '';
        if (!shouldForward(jid)) return;

        try {
          const blob = blobs.get(key);
          const sender = msg.key.participant || msg.key.remoteJid;
          const captionText = textOf(msg);
          const header = `╭━━━ 「 **ANTIDELETE** 」\n┃ 👤 **From:** @${sender?.split('@')[0]}\n╰━━━━━━━━━━━━━━━━━━━━━━━\n\n${captionText}`.trim();

          if (blob) {
            const mime = blob.mime;
            if (mime.startsWith('image/')) {
              await ctx.sock.sendMessage(archiveJid, {
                image: blob.bytes,
                caption: header,
                mentions: [sender],
              } as never);
            } else if (mime.startsWith('video/')) {
              await ctx.sock.sendMessage(archiveJid, {
                video: blob.bytes,
                caption: header,
                mimetype: mime,
                mentions: [sender],
              } as never);
            } else if (mime.startsWith('audio/')) {
              await ctx.sock.sendMessage(archiveJid, {
                audio: blob.bytes,
                mimetype: mime,
                ptt: mime.includes('ogg'),
              } as never);
              await ctx.sock.sendMessage(archiveJid, {
                text: header,
                mentions: [sender],
              } as never);
            } else {
              await ctx.sock.sendMessage(archiveJid, {
                document: blob.bytes,
                mimetype: mime,
                fileName: blob.fileName,
                caption: header,
                mentions: [sender],
              } as never);
            }
          } else {
// Fallback for text messages or un-prefetched media.
            // Built by concatenation: nesting a quoted string inside a `${...}`
            // substitution is what broke the parse in this file.
            const fallbackBody =
              header + '\n\n*Deleted Content:*\n> ' + (captionText || '[No text content available]');
            await ctx.sock.sendMessage(archiveJid, {
              text: fallbackBody,
              mentions: [sender],
            } as never);
          }
          counters.forwarded += 1;
        } catch (err) {
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
              ctx.sock.ev.emit('nyx.revoked' as never, { key, message: cached } as never);
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
        archiveJid,
      });
    },
  };
}

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