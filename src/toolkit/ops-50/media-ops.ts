/**
 * OPS-50 · module 5 of 6 — media handling.
 *
 * Media sent to WhatsApp must be a **direct buffer**, never a nested object.
 * `{ image: buffer, mimetype, fileName }` works; `{ image: { buffer } }` fails
 * silently. Every send helper here builds that shape directly.
 *
 * rc14 method used: `downloadMediaMessage` — there is **no** `decryptMediaMessage`.
 */

import { randomBytes } from 'node:crypto';

import type { AnySock } from './types.js';

export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker';

export interface SendMediaInput {
  kind: MediaKind;
  bytes: Buffer;
  mimetype: string;
  fileName?: string;
  caption?: string;
  ptt?: boolean;
  /** Voice notes get no filename and a ptt flag. */
  asVoice?: boolean;
  /** Stickers must be exactly 96x96 webp. */
  asSticker?: boolean;
}

/* ── 61-68 · media send ───────────────────────────────────────────── */

/** Guess a filename extension from a mimetype. */
export function extensionFor(mimetype: string, kind: MediaKind): string {
  if (mimetype.includes('png')) return 'png';
  if (mimetype.includes('jpeg') || mimetype.includes('jpg')) return 'jpg';
  if (mimetype.includes('webp')) return 'webp';
  if (mimetype.includes('gif')) return 'gif';
  if (mimetype.includes('mp4')) return 'mp4';
  if (mimetype.includes('ogg')) return kind === 'audio' ? 'ogg' : 'oga';
  if (mimetype.includes('mpeg') || mimetype.includes('mp3')) return 'mp3';
  if (mimetype.includes('pdf')) return 'pdf';
  return kind === 'document' ? 'bin' : kind;
}

/** Derive a filename when the caller did not supply one. */
export function defaultFileName(input: SendMediaInput): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return input.fileName ?? `nyx-${stamp}.${extensionFor(input.mimetype, input.kind)}`;
}

/**
 * Build the content object rc14 expects.
 *
 * The buffer is assigned directly to its key — this is the exact shape that
 * works, and the mistake of nesting it under the same key is a silent failure.
 */
export function buildMediaContent(input: SendMediaInput): Record<string, unknown> {
  // Sticker and voice notes pick their own key first; everything else uses the
  // caller's kind. The buffer is always assigned *directly* to that key —
  // nesting it as `{ image: { buffer } }` is the silent failure this avoids.
  let key: MediaKind = input.kind;

  if (input.asSticker) key = 'sticker';
  if (input.asVoice) key = 'audio';

  const content: Record<string, unknown> = {
    [key]: input.bytes,
    mimetype: input.asVoice ? 'audio/ogg; codecs=opus' : input.mimetype,
  };

  if (input.asVoice) content['ptt'] = true;

  if (input.fileName && !input.asVoice && !input.asSticker) {
    content['fileName'] = input.fileName;
  }

  if (input.caption) content['caption'] = input.caption;

  return content;
}

/** Build media content and send it. */
export function sendMedia(
  sock: AnySock,
  jid: string,
  input: SendMediaInput,
  quoted?: unknown,
): Promise<unknown> {
  return sock.sendMessage(
    jid,
    buildMediaContent(input) as never,
    quoted ? { quoted: quoted as never } : {},
  );
}

/* ── 69-74 · media helpers ────────────────────────────────────────── */

/**
 * Download media bytes from a message.
 *
 * The correct rc14 name is `downloadMediaMessage`. If a caller reaches for
 * `decryptMediaMessage` it will be undefined and throw — check first so the
 * error is legible rather than "not a function".
 */
export async function fetchMediaBytes(sock: AnySock, message: unknown): Promise<Buffer> {
  const fn = sock.downloadMediaMessage;
  if (typeof fn !== 'function') {
    throw new Error('socket has no downloadMediaMessage — rc14 renamed this');
  }
  const buf = await fn.call(sock, message, 'buffer', {});
  if (!Buffer.isBuffer(buf)) throw new Error('downloadMediaMessage did not return a Buffer');
  return buf;
}

/** Human-readable byte size. */
export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/** True when a payload is a real, non-empty buffer. */
export function isUsableBuffer(value: unknown): value is Buffer {
  return Buffer.isBuffer(value) && value.length > 0;
}

/** Pick a mimetype from a filename when the caller has none. */
export function guessMime(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  const table: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    mp4: 'video/mp4',
    ogg: 'audio/ogg; codecs=opus',
    mp3: 'audio/mpeg',
    pdf: 'application/pdf',
  };
  return table[ext] ?? 'application/octet-stream';
}

/**
 * Split a buffer into chunks for bounded streaming.
 *
 * This does **not** reduce peak memory — the whole buffer already exists. It is
 * a transport convenience, not a streaming API, and no doc should claim
 * otherwise.
 */
export function chunkBuffer(bytes: Buffer, size = 1024 * 1024): Buffer[] {
  if (size <= 0) throw new Error('chunk size must be positive');
  const out: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size));
  return out;
}

/** Short random id for correlating media operations in logs. */
export function mediaTraceId(): string {
  return randomBytes(4).toString('hex');
}