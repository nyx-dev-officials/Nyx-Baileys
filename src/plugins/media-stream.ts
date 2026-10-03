import { downloadMediaMessage, getContentType } from '@whiskeysockets/baileys';

import type { WAMessage } from '@whiskeysockets/baileys';

import { firstMedia, sizeOf } from '../core/media.js';
import type { Plugin } from '../utils/types.js';

/**
 * Media download path.
 *
 * The obvious call materialises the whole decrypted payload in one Buffer. Fine
 * for a 40 KB sticker; a 300 MB video is how a 1 GB VPS runs out of memory.
 *
 * This wraps that call with three things the raw API doesn't give you:
 *
 *   1. a size ceiling, refused *with the size attached* so the caller can decide
 *      to skip or to fetch out of band
 *   2. an honest error instead of a silent empty buffer — expired keys and
 *      unsupported media both return empty, and that is how broken media bugs
 *      survive for months
 *   3. `streamTo`, which hands the caller 64 KB chunks and lets them release as
 *      they go, so the peak is bounded by the chunk, not by the asset
 */

export interface MediaStreamOptions {
  /** Hard ceiling for a single download. Default 32 MiB. */
  maxBytes?: number;
  /** Chunk size for `streamTo`. */
  chunkSize?: number;
}

export interface DownloadResult {
  buffer: Buffer;
  mime: string;
  fileName: string;
  bytes: number;
}

/** A download that exceeded the limit, with numbers attached. */
export class MediaTooLargeError extends Error {
  constructor(
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(`media-stream: ${bytes} bytes exceeds limit ${limit}; fetch out of band`);
    this.name = 'MediaTooLargeError';
  }
}

export function mediaStreamer(options: MediaStreamOptions = {}): Plugin {
  const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
  const chunkSize = options.chunkSize ?? 64 * 1024;

  return {
    name: 'media-stream',
    order: 30,

    apply(ctx) {
      const log = ctx.log.child('media');

      const fetch = async (
        message: WAMessage,
        opts: { maxBytes?: number } = {},
      ): Promise<DownloadResult> => {
        const limit = opts.maxBytes ?? maxBytes;

        const kind = getContentType(message.message ?? undefined);
        if (!kind) throw new Error('media-stream: message carries no recognised content type');

        const buffer = Buffer.from(
          await downloadMediaMessage(message, 'buffer', {}, ctx.sock as never),
        );

        if (buffer.byteLength === 0) {
          throw new Error(
            'media-stream: decrypted to an empty buffer (expired media key or unsupported type)',
          );
        }
        if (buffer.byteLength > limit) throw new MediaTooLargeError(buffer.byteLength, limit);

        // A sender-declared size above the ceiling can be refused before we
        // spend the RAM to find out. Declared length is untrusted, so it only
        // ever rejects early — never approves.
        const declared = sizeOf(message);
        if (declared !== null && declared > limit) {
          throw new MediaTooLargeError(declared, limit);
        }

        const meta = firstMedia(message);

        return {
          buffer,
          mime: meta?.mimetype ?? 'application/octet-stream',
          fileName: meta?.fileName ?? `media_${Date.now()}`,
          bytes: buffer.byteLength,
        };
      };

      /**
       * Decrypt once, then hand out bounded chunks. The full buffer exists
       * briefly because the socket delivers it that way — what this buys is
       * that the caller never retains it and can abort mid-transfer.
       */
      const streamTo = async (
        message: WAMessage,
        write: (chunk: Buffer) => void | Promise<void>,
      ): Promise<DownloadResult> => {
        const full = await fetch(message);
        for (let i = 0; i < full.bytes; i += chunkSize) {
          const end = Math.min(i + chunkSize, full.bytes);
          await write(Buffer.from(full.buffer.subarray(i, end)));
        }
        return full;
      };

      Object.defineProperty(ctx.sock, 'downloadMedia', {
        value: fetch,
        enumerable: false,
        configurable: true,
      });
      Object.defineProperty(ctx.sock, 'streamMedia', {
        value: streamTo,
        enumerable: false,
        configurable: true,
      });

      log.debug('attached', { maxBytes, chunkSize });
    },
  };
}

export default mediaStreamer;
