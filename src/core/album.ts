/**
 * Sending albums.
 *
 * rc14 models an album as a **parent plus siblings**, not one message with a
 * media array:
 *
 *   1. the parent carries counts (`expectedImageCount`, `expectedVideoCount`)
 *   2. each media message is sent normally, with `albumParentKey` pointing at
 *      the parent's key
 *
 * Upstream already maps those two send fields to the right protobuf — `album`
 * becomes `albumMessage`, `albumParentKey` becomes a `MEDIA_ALBUM`
 * `messageContextInfo.messageAssociation`. So `sendAlbum` is the glue: send the
 * parent, then send each item linked to it. No protobuf is hand-rolled.
 */

import type { WAMessageKey } from '@whiskeysockets/baileys';

/** The slice of the socket this needs. */
export interface AlbumSendSocket {
  sendMessage: (
    jid: string,
    content: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<{ key: WAMessageKey }>;
}

/** One album item, as the content you would pass to `sendMessage`. */
export type AlbumItemContent = Record<string, unknown>;

export interface SendAlbumOptions {
  /** Override the inferred image count. */
  expectedImageCount?: number;
  /** Override the inferred video count. */
  expectedVideoCount?: number;
  /** Options forwarded to the parent and every item send. */
  messageOptions?: Record<string, unknown>;
  /** Send items in parallel. Default `false` (ordered). */
  concurrent?: boolean;
}

export interface SendAlbumResult {
  /** The parent message key. */
  key: WAMessageKey;
  /** Keys of the item messages, in the order they were sent. */
  items: Array<{ key: WAMessageKey }>;
}

const VIDEO_KEYS = ['video', 'ptv'];
const IMAGE_KEYS = ['image', 'sticker'];

/** Count image- and video-bearing items. Anything else is treated as an image. */
export function inferAlbumCounts(items: readonly AlbumItemContent[]): { images: number; videos: number } {
  let images = 0;
  let videos = 0;
  for (const item of items) {
    if (VIDEO_KEYS.some((k) => k in item)) videos += 1;
    else if (IMAGE_KEYS.some((k) => k in item)) images += 1;
    else images += 1;
  }
  return { images, videos };
}

/** The parent content: `{ album: { expectedImageCount, expectedVideoCount } }`. */
export function buildAlbumParent(images: number, videos = 0): Record<string, unknown> {
  return { album: { expectedImageCount: images, expectedVideoCount: videos } };
}

/**
 * Send an album: the parent first, then each item linked back to it.
 *
 * ```ts
 * await sock.sendAlbum(jid, [
 *   { image: { url: './a.jpg' }, caption: 'one' },
 *   { image: { url: './b.jpg' } },
 *   { video: { url: './c.mp4' } },
 * ]);
 * ```
 */
export async function sendAlbum(
  sock: AlbumSendSocket,
  jid: string,
  items: readonly AlbumItemContent[],
  options: SendAlbumOptions = {},
): Promise<SendAlbumResult> {
  if (items.length === 0) throw new Error('sendAlbum: at least one item is required');

  const inferred = inferAlbumCounts(items);
  const images = options.expectedImageCount ?? inferred.images;
  const videos = options.expectedVideoCount ?? inferred.videos;

  const parent = await sock.sendMessage(
    jid,
    buildAlbumParent(images, videos),
    options.messageOptions,
  );
  const parentKey = parent?.key;

  const sendItem = (content: AlbumItemContent): Promise<{ key: WAMessageKey }> =>
    sock.sendMessage(jid, { ...content, albumParentKey: parentKey }, options.messageOptions);

  let sent: Array<{ key: WAMessageKey }>;
  if (options.concurrent) {
    sent = await Promise.all(items.map(sendItem));
  } else {
    sent = [];
    for (const item of items) sent.push(await sendItem(item));
  }

  return { key: parentKey, items: sent.map((r) => ({ key: r.key })) };
}
