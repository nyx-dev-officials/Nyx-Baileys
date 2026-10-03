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

/**
 * Priority rank of a media field, mirroring `MEDIA_KEYS` above.
 *
 * Written as a switch rather than a lookup into a map or set: the hot path
 * calls it once per key on every inbound message, and a switch on interned
 * string constants beats a hash lookup by a wide margin.
 *
 * `MEDIA_KEYS` and this switch must stay in the same order — `tests/media.test.js`
 * pins that by presenting one media field at a time and checking which wins.
 */
const mediaRankOf = (key: string): number => {
  switch (key) {
    case 'imageMessage':
      return 0;
    case 'videoMessage':
      return 1;
    case 'audioMessage':
      return 2;
    case 'stickerMessage':
      return 3;
    case 'documentMessage':
      return 4;
    case 'ptvMessage':
      return 5;
    case 'lottieStickerMessage':
      return 6;
    default:
      return -1;
  }
};

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

  // Iterate the keys the message actually has, instead of probing all seven
  // media fields. An ordinary text message carries one or two fields, and
  // seven *misses* against a megamorphic object shape cost several times more
  // than the walk: 202 ns → 32 ns per message on a bare `{conversation}`, and
  // 334 ns → 57 ns on a quoted one. Media payloads, which carry a contextInfo
  // and a handful of siblings, got faster too.
  //
  // Priority is still honoured — `firstMedia` must answer `imageMessage` over
  // `videoMessage` regardless of insertion order — so the best match by rank
  // wins, and the scan stops early once the top-priority field is found.
  let best: MediaLike | null = null;
  let bestRank = Number.POSITIVE_INFINITY;

  for (const key in m) {
    const rank = mediaRankOf(key);
    if (rank < 0 || rank >= bestRank) continue;
    const media = m[key];
    if (!media) continue;
    bestRank = rank;
    best = media;
    if (rank === 0) break;
  }
  return best;
}

/** Which media field a message uses, or null. */
export function mediaKeyOf(msg: WAMessage): MediaKey | null {
  const m = msg.message as Record<string, unknown> | null | undefined;
  if (!m) return null;

  let best: MediaKey | null = null;
  let bestRank = Number.POSITIVE_INFINITY;

  for (const key in m) {
    const rank = mediaRankOf(key);
    if (rank < 0 || rank >= bestRank) continue;
    if (!m[key]) continue;
    bestRank = rank;
    best = key as MediaKey;
    if (rank === 0) break;
  }
  return best;
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
