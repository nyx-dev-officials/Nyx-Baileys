import { downloadMediaMessage, getContentType, proto } from '@whiskeysockets/baileys';

import { associationOf, firstMedia, mimeOf, parentKeyOf } from '../core/media.js';

import type { WAMessage } from '@whiskeysockets/baileys';
import type { Plugin } from '../utils/types.js';

/**
 * Album container handling.
 *
 * ## How rc14 actually models albums
 *
 * The parent `albumMessage` carries only counts (`expectedImageCount`,
 * `expectedVideoCount`) — no media array, nothing to decrypt. The media arrives
 * as **separate sibling messages**, each with `mediaMessage.albumParentKey`
 * pointing at the parent's key.
 *
 * That is why naive album code ends up with empty buffers: it looks for media
 * inside the container that was never there. This plugin keys off
 * `albumParentKey` instead, so items land in the right album the moment they
 * arrive, and nothing is decrypted until asked for.
 *
 * Falls back to reading `albumMessage.media` / `groupedMediaMessage.media` if a
 * client ever ships that shape, so both wire formats are handled.
 */

export interface AlbumItem {
  index: number;
  caption: string;
  /** The media-bearing message, for deferred download. */
  message: WAMessage;
  kind?: string;
}

export interface Album {
  /** Parent message id. */
  key: string;
  /** Chat the album belongs to. */
  jid: string;
  expected: number;
  items: AlbumItem[];
  completedAt?: number;
}

export function albumHandler(): Plugin {
  return {
    name: 'album',
    order: 40,

    apply(ctx) {
      const log = ctx.log.child('album');
      const albums = new Map<string, Album>();

      /**
       * The parent message key for a sibling media message.
       *
       * rc14 has no `albumParentKey` field at all. The link is a
       * `contextInfo.messageAssociation` tagged `MEDIA_ALBUM`, which is what
       * upstream itself writes (`Utils/messages.js:538`). Reading the wrong path
       * returns undefined forever and albums silently never assemble.
       */
      const parentKey = (msg: WAMessage): string | undefined =>
        parentKeyOf(msg, proto.MessageAssociation.AssociationType.MEDIA_ALBUM);

      /** Sibling index within the album, when the sender supplied one. */
      const siblingIndex = (msg: WAMessage): number | undefined =>
        associationOf(msg)?.messageIndex ?? undefined;

      /** Legacy shape: media nested in the container. */
      const inlineMedia = (msg: WAMessage): WAMessage[] => {
        const m = msg.message as Record<string, { media?: unknown[] } | undefined> | undefined;
        const container =
          (m?.albumMessage as { media?: unknown[] } | undefined) ??
          (m?.groupedMediaMessage as { media?: unknown[] } | undefined);
        return (container?.media ?? []) as WAMessage[];
      };

      const ensure = (key: string, jid: string, expected: number): Album => {
        const existing = albums.get(key);
        if (existing) return existing;
        const album: Album = { key, jid, expected, items: [] };
        albums.set(key, album);
        if (albums.size > 200) {
          const oldest = albums.keys().next().value;
          if (oldest !== undefined) albums.delete(oldest);
        }
        return album;
      };

      ctx.sock.ev.on('messages.upsert', (event: { messages: WAMessage[] }) => {
        for (const msg of event.messages ?? []) {
          const jid = msg.key?.remoteJid;
          if (!jid) continue;

          // Case 1: the parent container.
          const container = (msg.message as { albumMessage?: { expectedImageCount?: number; expectedVideoCount?: number } } | undefined)
            ?.albumMessage;
          if (container) {
            const expected = (container.expectedImageCount ?? 0) + (container.expectedVideoCount ?? 0);
            const id = msg.key?.id ?? `${jid}:${Date.now()}`;
            const album = ensure(id, jid, expected);
            // Siblings can race ahead of the parent, in which case the album was
            // created with a MAX_SAFE_INTEGER placeholder count. Now that the
            // real count is known, adopt it — otherwise `completedAt` is never
            // set and `waitFor` times out on a perfectly healthy album.
            if (album.expected !== expected) {
              album.expected = expected;
              log.debug('album parent arrived late, count resolved', { key: id, expected });
            }
            log.debug('album parent', { key: id, expected });

            // Legacy shape: pull the nested media in directly.
            for (const item of inlineMedia(msg)) {
              album.items.push({ index: album.items.length, caption: '', message: item });
            }
            if (album.items.length >= album.expected) album.completedAt = Date.now();
            ctx.sock.ev.emit('nyx.album' as never, album as never);
            continue;
          }

          // Case 2: a sibling media message claiming a parent.
          const parent = parentKey(msg);
          if (!parent) continue;

          const album = ensure(parent, jid, Number.MAX_SAFE_INTEGER);
          album.items.push({
            index: siblingIndex(msg) ?? album.items.length,
            caption: String(firstMedia(msg)?.caption ?? ''),
            message: msg,
          });
          if (album.expected !== Number.MAX_SAFE_INTEGER && album.items.length >= album.expected) {
            album.completedAt = Date.now();
          }
          log.debug('album item', { parent, total: album.items.length });
          ctx.sock.ev.emit('nyx.album' as never, album as never);
        }
      });

      /**
       * Decrypt one item on demand. Throws rather than returning an empty
       * buffer — an empty buffer is how "album is broken" bugs hide.
       */
      const expand = async (
        album: Album,
        index = 0,
      ): Promise<{ buffer: Buffer; mime: string; fileName: string }> => {
        const item = album.items[index];
        if (!item) throw new Error(`album ${album.key} has no item ${index}`);

        const kind = getContentType(item.message.message ?? undefined);
        if (!kind) throw new Error(`album ${album.key} item ${index} has no recognised content type`);

        const buffer = await downloadMediaMessage(item.message, 'buffer', {}, ctx.sock as never);
        if (!buffer?.byteLength) {
          throw new Error(`album ${album.key} item ${index} decrypted to an empty buffer`);
        }

        const media = firstMedia(item.message);

        return {
          buffer: Buffer.from(buffer),
          mime: mimeOf(item.message) ?? 'application/octet-stream',
          fileName: media?.fileName ?? `album_${album.key}_${index}`,
        };
      };

      /** Wait for an album to fill up, then return it. */
      const waitFor = (key: string, timeoutMs = 15_000): Promise<Album | undefined> =>
        new Promise((resolve) => {
          const existing = albums.get(key);
          if (existing?.completedAt) return resolve(existing);
          const timer = setTimeout(() => resolve(albums.get(key)), timeoutMs);
          timer.unref?.();
          const handler = (album: Album): void => {
            if (album.key === key && album.completedAt) {
              clearTimeout(timer);
              ctx.sock.ev.off('nyx.album' as never, handler as never);
              resolve(album);
            }
          };
          ctx.sock.ev.on('nyx.album' as never, handler as never);
        });

      Object.defineProperty(ctx.sock, 'albums', { value: albums, enumerable: false, configurable: true });
      Object.defineProperty(ctx.sock, 'expandAlbum', { value: expand, enumerable: false, configurable: true });
      Object.defineProperty(ctx.sock, 'waitForAlbum', { value: waitFor, enumerable: false, configurable: true });

      void ({} as proto.IWebMessageInfo);
      log.debug('attached');
    },
  };
}

export default albumHandler;
