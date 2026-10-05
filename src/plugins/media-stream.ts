import { downloadMediaMessage } from '@whiskeysockets/baileys';

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
 *      to skip or to fetch out of band — and refused from the sender's declared
 *      length before any bytes are decrypted when possible
 *   2. an honest error instead of a silent empty buffer — expired keys and
 *      unsupported media both return empty, and that is how broken media bugs
 *      survive for months
 *   3. `streamTo`, which asks rc14 for a `stream` and forwards it one chunk at a
 *      time, with a size ceiling checked as bytes arrive
 *
 * ## Memory bounds — read this before trusting `streamTo`
 *
 * **Chunked handoff, not bounded memory.** Upstream rc14 materialises the full
 * decrypted buffer before it hands back a `stream`, so peak memory is the whole
 * asset plus one chunk. Chunking changes the *handoff* shape — the caller never
 * needs a second full copy, and the ceiling is enforced incrementally rather than
 * after the fact — but it does not reduce the peak.
 *
 * The distinction matters because a 300 MB download is exactly the case this was
 * written for, and here the peak is the same as the naive `downloadMediaMessage`
 * call. If peak RAM is the constraint, this is the wrong function: decrypt to a
 * file in a separate process, or use a client that supports incremental
 * decryption.
 */

export interface MediaStreamOptions {
  /** Hard ceiling for a single download. Default 32 MiB. */
  maxBytes?: number;
  /** Coalescing size for `streamTo` chunks. Default 64 KiB. */
  chunkSize?: number;
}

export interface DownloadResult {
  buffer: Buffer;
  mime: string;
  fileName: string;
  bytes: number;
}

/** What `streamTo` returns: metadata plus the byte count, but no buffer. */
export interface StreamSummary {
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

      /**
       * Metadata + the declared byte count, shared by both download paths.
       *
       * The presence check asks for an actual media field rather than leaning on
       * `getContentType`, which returns `conversation` for a plain text message
       * and would let a non-media message through to the downloader.
       */
      const guard = (message: WAMessage, limit: number): { mime: string; fileName: string } => {
        const meta = firstMedia(message);
        if (!meta) throw new Error('media-stream: message carries no media');

        // The sender's declared length is untrusted, so it only ever rejects
        // early — never approves. Checking it *before* decoding is the whole
        // point: a 900 MB video should be refused without decrypting it.
        const declared = sizeOf(message);
        if (declared !== null && declared > limit) throw new MediaTooLargeError(declared, limit);

        return {
          mime: meta.mimetype ?? 'application/octet-stream',
          fileName: meta.fileName ?? `media_${Date.now()}`,
        };
      };

      const fetch = async (
        message: WAMessage,
        opts: { maxBytes?: number } = {},
      ): Promise<DownloadResult> => {
        const limit = opts.maxBytes ?? maxBytes;
        const { mime, fileName } = guard(message, limit);

        const buffer = Buffer.from(
          await downloadMediaMessage(message, 'buffer', {}, ctx.sock as never),
        );

        if (buffer.byteLength === 0) {
          throw new Error(
            'media-stream: decrypted to an empty buffer (expired media key or unsupported type)',
          );
        }
        if (buffer.byteLength > limit) throw new MediaTooLargeError(buffer.byteLength, limit);

        return { buffer, mime, fileName, bytes: buffer.byteLength };
      };

      /**
       * Stream the decrypted payload out one chunk at a time.
       *
       * The byte ceiling is enforced *during* the transfer, so an under-declared
       * asset is still stopped — that part is a real improvement on `downloadMedia`,
       * which must materialise the whole buffer before it can check anything.
       *
       * Peak memory is **not** bounded. rc14's `'stream'` mode decrypts the full
       * asset first and then yields pieces of it, so the peak is the asset plus
       * one chunk. See the module docstring.
       */
      const streamTo = async (
        message: WAMessage,
        write: (chunk: Buffer) => void | Promise<void>,
        opts: { maxBytes?: number } = {},
      ): Promise<StreamSummary> => {
        const limit = opts.maxBytes ?? maxBytes;
        const { mime, fileName } = guard(message, limit);

        const stream = (await downloadMediaMessage(
          message,
          'stream',
          {},
          ctx.sock as never,
        )) as unknown as AsyncIterable<Uint8Array>;

        let total = 0;
        let pending: Buffer[] = [];
        let pendingBytes = 0;

        const flush = async (): Promise<void> => {
          if (pendingBytes === 0) return;
          const chunk = pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingBytes);
          pending = [];
          pendingBytes = 0;
          await write(chunk);
        };

        for await (const piece of stream) {
          const chunk = Buffer.from(piece);
          total += chunk.byteLength;
          if (total > limit) throw new MediaTooLargeError(total, limit);

          pending.push(chunk);
          pendingBytes += chunk.byteLength;
          if (pendingBytes >= chunkSize) await flush();
        }
        await flush();

        if (total === 0) {
          throw new Error(
            'media-stream: decrypted to an empty buffer (expired media key or unsupported type)',
          );
        }

        return { mime, fileName, bytes: total };
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
