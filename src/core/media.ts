import type { WAMessage } from '@whiskeysockets/baileys';

/**
 * Media field access.
 *
 * rc14 dropped the generic `mediaMessage` and the root-level `contextInfo` that
 * older Baileys had. There is no `message.media` and no `message.contextInfo`:
 *
 *   - media lives in a per-type field (`imageMessage`, `videoMessage`, …)
 *   - `contextInfo` lives *inside* that field, plus a root `messageContextInfo`
 *
 * So every plugin that touches media needs the same two hops, and getting them
 * wrong fails silently — `undefined` forever, no error, no media. Centralised
 * here so there is exactly one correct traversal.
 */

/** Every media-bearing field in rc14's `IMessage`, in priority order. */
export const MEDIA_KEYS = [
  'imageMessage',
  'videoMessage',
  'audioMessage',
  'stickerMessage',
  'documentMessage',
  'ptvMessage',
  'lottieStickerMessage',
] as const;

export type MediaKey = (typeof MEDIA_KEYS)[number];

/** protobufjs emits `Long` for 64-bit fields; treat it as string-convertible. */
export type ByteLength = number | { toString(): string } | null;

/** The shape shared by all media fields. */
export interface MediaLike {
  mimetype?: string | null;
  caption?: string | null;
  fileName?: string | null;
  fileLength?: ByteLength;
  mediaKey?: Uint8Array | null;
  directPath?: string | null;
  url?: string | null;
  contextInfo?: ContextLike | null;
}

export interface AssociationLike {
  associationType?: number | null;
  parentMessageKey?: { id?: string | null } | null;
  messageIndex?: number | null;
}

export interface ContextLike {
  messageAssociation?: AssociationLike | null;
  [key: string]: unknown;
}

/** The media payload on a message, or null if it carries none. */
export function firstMedia(msg: WAMessage): MediaLike | null {
  const m = msg.message as Record<string, MediaLike | null> | null | undefined;
  if (!m) return null;

  for (const key of MEDIA_KEYS) {
    const media = m[key];
    if (media) return media;
  }
  return null;
}

/** Which media field a message uses, or null. */
export function mediaKeyOf(msg: WAMessage): MediaKey | null {
  const m = msg.message as Record<string, unknown> | null | undefined;
  if (!m) return null;

  for (const key of MEDIA_KEYS) {
    if (m[key]) return key;
  }
  return null;
}

/**
 * The contextInfo that applies to this message: the media field's own if it has
 * one, otherwise the root-level `messageContextInfo`.
 */
export function contextOf(msg: WAMessage): ContextLike | null {
  const media = firstMedia(msg);
  if (media?.contextInfo) return media.contextInfo;

  const root = msg.message as { messageContextInfo?: ContextLike | null } | null | undefined;
  return root?.messageContextInfo ?? null;
}

/** The association record linking this message to a parent, if any. */
export function associationOf(msg: WAMessage): AssociationLike | null {
  return contextOf(msg)?.messageAssociation ?? null;
}

/**
 * Parent message id when this message is an album sibling or similar child.
 *
 * `type` filters on `associationType` so a quoted-message link isn't mistaken
 * for an album membership. Omit it to accept any association.
 */
export function parentKeyOf(msg: WAMessage, type?: number): string | undefined {
  const association = associationOf(msg);
  if (!association?.parentMessageKey?.id) return undefined;
  if (type !== undefined && association.associationType !== type) return undefined;
  return association.parentMessageKey.id;
}

/** A message's declared size in bytes, when the sender supplied it. */
export function sizeOf(msg: WAMessage): number | null {
  const length = firstMedia(msg)?.fileLength;
  if (length === undefined || length === null) return null;
  // protobufjs emits Long for 64-bit fields, which stringifies to the integer.
  return typeof length === 'number' ? length : Number(length.toString());
}

/** A message's mime type. */
export function mimeOf(msg: WAMessage): string | undefined {
  return firstMedia(msg)?.mimetype ?? undefined;
}
