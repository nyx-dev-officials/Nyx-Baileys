/**
 * src/features/messaging.ts
 *
 * High-level messaging helpers built on top of the upstream Baileys socket.
 * Every function accepts `sock: any` so callers can pass a raw WASocket, a
 * NyxBaileys-decorated socket, or a mock in tests — without forcing a strict
 * import chain on users of this module.
 *
 * All functions return `Promise<unknown>` (or a more-specific Promise) and
 * delegate to `sock.sendMessage` / Baileys APIs so the anti-spam pacing,
 * delivery tracking, and every other plugin applied to the socket stays active.
 */

import { brand } from './typography.js';
import type { FeatureName } from './typography.js';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

/* ── internal helpers ─────────────────────────────────────────────────── */

/** Coerce a Buffer, Uint8Array, Readable, or file-path string into a Buffer. */
async function toBuffer(src: Buffer | Uint8Array | Readable | string): Promise<Buffer> {
  if (Buffer.isBuffer(src)) return src;
  if (src instanceof Uint8Array) return Buffer.from(src);
  if (typeof src === 'string') {
    // File path
    const chunks: Buffer[] = [];
    const stream = createReadStream(src);
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks);
  }
  // Readable stream
  const chunks: Buffer[] = [];
  for await (const chunk of src) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

/* ── shared parameter types ───────────────────────────────────────────── */

export interface SendOptions {
  /** Quoted / replied-to message key. */
  quoted?: Record<string, unknown>;
  /** Ephemeral TTL in seconds (0 = off). */
  ephemeralExpiration?: number;
  /**
   * Render `text`/`caption` in a feature file's signature face.
   *
   * Opt-in, and defaulting to off on purpose. `sendText` is also used for
   * arbitrary user-authored content — error messages, command echoes, pasted
   * text — and silently restyling that would corrupt copyable output and make
   * numbers harder to read. A caller that is *presenting* something (a
   * generated report, a group summary) opts in explicitly.
   *
   * See src/features/typography.ts for the per-feature mapping.
   */
  featureFont?: FeatureName;
  /** Extra arbitrary options forwarded to sock.sendMessage. */
  [key: string]: unknown;
}

export interface MediaSendOptions extends SendOptions {
  caption?: string;
  mimetype?: string;
  fileName?: string;
  ptt?: boolean;
}

export interface LocationParams {
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
  url?: string;
}

export interface LiveLocationParams extends LocationParams {
  /** Duration in seconds for which the live location stays live. */
  accuracyInMeters?: number;
  speedInMps?: number;
  degreesClockwiseFromMagneticNorth?: number;
  /** How often (ms) to update. Used when managing the send loop externally. */
  caption?: string;
}

export interface ContactParams {
  /** Full display name. */
  displayName: string;
  /** vCard string. */
  vcard: string;
}

export interface PollParams {
  name: string;
  values: string[];
  selectableCount?: number;
}

export interface ReactionParams {
  /** The key of the message to react to. */
  key: Record<string, unknown>;
  /** Emoji to react with. Empty string removes the reaction. */
  emoji: string;
}

export interface BulkMessageParams {
  jid: string;
  content: Record<string, unknown>;
  options?: SendOptions;
  /** Delay between sends (ms). Default 1 500. */
  delayMs?: number;
}

export interface ScheduleParams {
  jid: string;
  content: Record<string, unknown>;
  /** Absolute timestamp (ms) or delay (ms from now) at which to send. */
  sendAt: number;
  options?: SendOptions;
}

export interface TemplateButtonParam {
  index: number;
  urlButton?: { displayText: string; url: string };
  callButton?: { displayText: string; phoneNumber: string };
  quickReplyButton?: { displayText: string; id: string };
}

export interface ButtonsParams {
  text: string;
  buttons: Array<{ buttonId: string; buttonText: { displayText: string }; type: number }>;
  footer?: string;
  headerType?: number;
}

export interface ListParams {
  text: string;
  buttonText: string;
  title?: string;
  footer?: string;
  sections: Array<{
    title: string;
    rows: Array<{ title: string; rowId: string; description?: string }>;
  }>;
}

export interface NewsletterMessageParams {
  /** Newsletter JID, e.g. "120363xxxxxx@newsletter". */
  newsletterJid: string;
  content: Record<string, unknown>;
  options?: SendOptions;
}

export interface BroadcastParams {
  /** List of JIDs to broadcast to. */
  jids: string[];
  content: Record<string, unknown>;
  options?: SendOptions;
  delayMs?: number;
}

export interface PinMessageParams {
  /** JID of the chat containing the message. */
  jid: string;
  /** Key of the message to pin. */
  key: Record<string, unknown>;
  /** Unpin instead of pinning. */
  unpin?: boolean;
}

export interface StarMessageParams {
  jid: string;
  messages: Array<{ key: Record<string, unknown>; starred: boolean }>;
}

export interface MuteChatParams {
  jid: string;
  /** Duration in seconds. 0 = unmute. */
  duration?: number;
}

export interface SearchMessagesParams {
  query: string;
  /** Optionally scope to a single JID. */
  jid?: string;
  page?: number;
  count?: number;
}

export interface DownloadMediaParams {
  /** The WAMessage object returned by Baileys. */
  message: Record<string, unknown>;
  /** Media type: 'image' | 'video' | 'audio' | 'document' | 'sticker'. */
  type: 'image' | 'video' | 'audio' | 'document' | 'sticker';
}

export interface UploadMediaParams {
  data: Buffer | Uint8Array | Readable | string;
  mimetype: string;
  /** 'image' | 'video' | 'audio' | 'document' | 'sticker'. */
  mediaType: 'image' | 'video' | 'audio' | 'document' | 'sticker';
}

export interface TemplateParams {
  /** Text body of the template. */
  text: string;
  footer?: string;
  buttons: TemplateButtonParam[];
  options?: SendOptions;
}

export interface InteractiveParams {
  body: string;
  footer?: string;
  header?: Record<string, unknown>;
  nativeFlowMessage?: Record<string, unknown>;
  collectionMessage?: Record<string, unknown>;
  options?: SendOptions;
}

export interface CarouselParams {
  /** Individual card definitions. */
  cards: Array<{
    header?: Record<string, unknown>;
    body?: string;
    footer?: string;
    buttons?: TemplateButtonParam[];
  }>;
  bodyText?: string;
  options?: SendOptions;
}

export interface CatalogParams {
  /** Product JID or ID. */
  productId: string;
  /** Business JID that owns the catalog. */
  businessJid: string;
  body?: string;
  footer?: string;
  options?: SendOptions;
}

export interface PaymentRequestParams {
  /** Payee note. */
  note: string;
  currency: string;
  /** Amount in minor units (cents). */
  amount: number;
  /** Expiry timestamp (epoch seconds). */
  expiryTimestamp?: number;
  background?: number;
  options?: SendOptions;
}

export interface EphemeralParams {
  jid: string;
  /** Expiration in seconds: 86400 | 604800 | 7776000. */
  expiration: 86400 | 604800 | 7776000;
}

export interface ClearChatParams {
  jid: string;
  /** Delete all messages older than this timestamp. 0 = clear everything. */
  beforeTimestamp?: number;
}

/* ═══════════════════════════════════════════════════════════════════════
   1. sendText
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Send a plain-text message.
 */
export async function sendText(
  sock: any,
  jid: string,
  text: string,
  options: SendOptions = {},
): Promise<unknown> {
  const { quoted, ephemeralExpiration, featureFont, ...rest } = options;
  const body = featureFont ? brand(text, featureFont) : text;
  return sock.sendMessage(
    jid,
    { text: body, ...(ephemeralExpiration ? { ephemeralExpiration } : {}), ...rest },
    quoted ? { quoted } : undefined,
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   2. sendImage
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Send an image message. `image` may be a Buffer, Uint8Array, Readable, a
 * file-system path string, or an `{ url: string }` object.
 */
export async function sendImage(
  sock: any,
  jid: string,
  image: Buffer | Uint8Array | Readable | string | { url: string },
  options: MediaSendOptions = {},
): Promise<unknown> {
  const { quoted, ephemeralExpiration, featureFont, caption, mimetype, ...rest } = options;
  const imageContent =
    typeof image === 'object' && 'url' in image
      ? { url: (image as { url: string }).url }
      : await toBuffer(image as Buffer | Uint8Array | Readable | string);

  return sock.sendMessage(
    jid,
    {
      image: imageContent,
      ...(caption ? { caption: featureFont ? brand(caption, featureFont) : caption } : {}),
      ...(mimetype ? { mimetype } : {}),
      ...(ephemeralExpiration ? { ephemeralExpiration } : {}),
      ...rest,
    },
    quoted ? { quoted } : undefined,
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   3. sendVideo
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Send a video message.
 */
export async function sendVideo(
  sock: any,
  jid: string,
  video: Buffer | Uint8Array | Readable | string | { url: string },
  options: MediaSendOptions = {},
): Promise<unknown> {
  const { quoted, ephemeralExpiration, featureFont, caption, mimetype, ...rest } = options;
  const videoContent =
    typeof video === 'object' && 'url' in video
      ? { url: (video as { url: string }).url }
      : await toBuffer(video as Buffer | Uint8Array | Readable | string);

  return sock.sendMessage(
    jid,
    {
      video: videoContent,
      ...(caption ? { caption: featureFont ? brand(caption, featureFont) : caption } : {}),
      ...(mimetype ? { mimetype } : {}),
      ...(ephemeralExpiration ? { ephemeralExpiration } : {}),
      ...rest,
    },
    quoted ? { quoted } : undefined,
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   4. sendAudio
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Send an audio message (file, not PTT). For voice notes see `sendVoiceNote`.
 */
export async function sendAudio(
  sock: any,
  jid: string,
  audio: Buffer | Uint8Array | Readable | string | { url: string },
  options: MediaSendOptions = {},
): Promise<unknown> {
  const { quoted, ephemeralExpiration, mimetype, ...rest } = options;
  const audioContent =
    typeof audio === 'object' && 'url' in audio
      ? { url: (audio as { url: string }).url }
      : await toBuffer(audio as Buffer | Uint8Array | Readable | string);

  return sock.sendMessage(
    jid,
    {
      audio: audioContent,
      ptt: false,
      mimetype: mimetype ?? 'audio/mpeg',
      ...(ephemeralExpiration ? { ephemeralExpiration } : {}),
      ...rest,
    },
    quoted ? { quoted } : undefined,
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   5. sendDocument
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Send a document / file attachment.
 */
export async function sendDocument(
  sock: any,
  jid: string,
  document: Buffer | Uint8Array | Readable | string | { url: string },
  options: MediaSendOptions & { fileName?: string } = {},
): Promise<unknown> {
  const { quoted, ephemeralExpiration, featureFont, caption, mimetype, fileName, ...rest } = options;
  const docContent =
    typeof document === 'object' && 'url' in document
      ? { url: (document as { url: string }).url }
      : await toBuffer(document as Buffer | Uint8Array | Readable | string);

  return sock.sendMessage(
    jid,
    {
      document: docContent,
      mimetype: mimetype ?? 'application/octet-stream',
      ...(fileName ? { fileName } : {}),
      ...(caption ? { caption: featureFont ? brand(caption, featureFont) : caption } : {}),
      ...(ephemeralExpiration ? { ephemeralExpiration } : {}),
      ...rest,
    },
    quoted ? { quoted } : undefined,
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   6. sendSticker
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Send a sticker message.
 */
export async function sendSticker(
  sock: any,
  jid: string,
  sticker: Buffer | Uint8Array | Readable | string | { url: string },
  options: MediaSendOptions & { packName?: string; author?: string } = {},
): Promise<unknown> {
  const { quoted, ephemeralExpiration, packName, author, ...rest } = options;
  const stickerContent =
    typeof sticker === 'object' && 'url' in sticker
      ? { url: (sticker as { url: string }).url }
      : await toBuffer(sticker as Buffer | Uint8Array | Readable | string);

  return sock.sendMessage(
    jid,
    {
      sticker: stickerContent,
      ...(packName ? { stickerPack: packName } : {}),
      ...(author ? { stickerAuthor: author } : {}),
      ...(ephemeralExpiration ? { ephemeralExpiration } : {}),
      ...rest,
    },
    quoted ? { quoted } : undefined,
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   7. sendContact
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Send a contact card. `contacts` may be a single or array of ContactParams.
 */
export async function sendContact(
  sock: any,
  jid: string,
  contacts: ContactParams | ContactParams[],
  options: SendOptions = {},
): Promise<unknown> {
  const { quoted, featureFont } = options;
  const arr = Array.isArray(contacts) ? contacts : [contacts];
  // displayName is a label and takes the face; the vcard stays verbatim,
  // because it is parsed by the recipient's contacts app, not read.
  const face = (t: string) => (featureFont ? brand(t, featureFont) : t);

  if (arr.length === 1) {
    const c = arr[0]!;
    return sock.sendMessage(
      jid,
      { contacts: { displayName: face(c.displayName), contacts: [{ vcard: c.vcard }] } },
      quoted ? { quoted } : undefined,
    );
  }

  return sock.sendMessage(
    jid,
    {
      contacts: {
        displayName: face(`${arr.length} contacts`),
        contacts: arr.map((c) => ({ vcard: c.vcard })),
      },
    },
    quoted ? { quoted } : undefined,
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   8. sendLocation
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Send a static location pin.
 */
export async function sendLocation(
  sock: any,
  jid: string,
  params: LocationParams,
  options: SendOptions = {},
): Promise<unknown> {
  const { quoted } = options;
  return sock.sendMessage(
    jid,
    {
      location: {
        degreesLatitude: params.latitude,
        degreesLongitude: params.longitude,
        ...(params.name ? { name: params.name } : {}),
        ...(params.address ? { address: params.address } : {}),
        ...(params.url ? { url: params.url } : {}),
      },
    },
    quoted ? { quoted } : undefined,
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   9. sendReaction
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Send (or remove) a reaction on a message. Pass `emoji: ''` to un-react.
 */
export async function sendReaction(
  sock: any,
  jid: string,
  params: ReactionParams,
): Promise<unknown> {
  return sock.sendMessage(jid, {
    react: { text: params.emoji, key: params.key },
  });
}

/* ═══════════════════════════════════════════════════════════════════════
   10. sendPoll
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Send a poll message.
 */
export async function sendPoll(
  sock: any,
  jid: string,
  params: PollParams,
  options: SendOptions = {},
): Promise<unknown> {
  const { quoted, featureFont } = options;
  return sock.sendMessage(
    jid,
    {
      poll: {
        // Styled question; `values` deliberately left plain — they are the
        // answer options, i.e. data the recipient reads back and votes on.
        name: featureFont ? brand(params.name, featureFont) : params.name,
        values: params.values,
        selectableCount: params.selectableCount ?? 1,
      },
    },
    quoted ? { quoted } : undefined,
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   11. editMessage
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Edit a previously sent text message.
 */
export async function editMessage(
  sock: any,
  jid: string,
  /** Key of the message to edit (must be an outgoing message). */
  key: Record<string, unknown>,
  newText: string,
): Promise<unknown> {
  return sock.sendMessage(jid, { text: newText, edit: key });
}

/* ═══════════════════════════════════════════════════════════════════════
   12. deleteMessage
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Delete a message for everyone.
 */
export async function deleteMessage(
  sock: any,
  jid: string,
  key: Record<string, unknown>,
): Promise<unknown> {
  return sock.sendMessage(jid, { delete: key });
}

/* ═══════════════════════════════════════════════════════════════════════
   13. forwardMessage
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Forward a WAMessage to another JID.
 */
export async function forwardMessage(
  sock: any,
  jid: string,
  message: Record<string, unknown>,
  options: SendOptions = {},
): Promise<unknown> {
  const { quoted } = options;
  return sock.sendMessage(
    jid,
    { forward: message, force: true },
    quoted ? { quoted } : undefined,
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   14. quoteReply
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Reply to a message by quoting it.
 */
export async function quoteReply(
  sock: any,
  jid: string,
  quotedMessage: Record<string, unknown>,
  replyText: string,
  options: SendOptions = {},
): Promise<unknown> {
  return sock.sendMessage(
    jid,
    { text: replyText },
    { quoted: quotedMessage, ...options },
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   15. mentionAll
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Send a message that mentions every participant in a group.
 * `participants` should be an array of JIDs (bare or full).
 */
export async function mentionAll(
  sock: any,
  jid: string,
  text: string,
  participants: string[],
  options: SendOptions = {},
): Promise<unknown> {
  const { quoted } = options;
  return sock.sendMessage(
    jid,
    { text, mentions: participants },
    quoted ? { quoted } : undefined,
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   16. sendBulkMessages
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Send an identical or varied message to multiple JIDs with an optional delay.
 */
export async function sendBulkMessages(
  sock: any,
  messages: BulkMessageParams[],
): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const msg of messages) {
    const result = await sock.sendMessage(msg.jid, msg.content, msg.options ?? undefined);
    results.push(result);
    if (msg.delayMs && msg.delayMs > 0) {
      await new Promise<void>((r) => setTimeout(r, msg.delayMs));
    }
  }
  return results;
}

/* ═══════════════════════════════════════════════════════════════════════
   17. scheduleMessage
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Schedule a message to be sent at a future time. Returns a Promise that
 * resolves with the Baileys send result once the message is dispatched.
 *
 * `sendAt` is treated as an absolute epoch-ms timestamp if it is larger than
 * the current time, otherwise as a delay in milliseconds from now.
 */
export async function scheduleMessage(
  sock: any,
  params: ScheduleParams,
): Promise<unknown> {
  const now = Date.now();
  const delay = params.sendAt > now ? params.sendAt - now : params.sendAt;
  await new Promise<void>((r) => setTimeout(r, delay));
  return sock.sendMessage(params.jid, params.content, params.options ?? undefined);
}

/* ═══════════════════════════════════════════════════════════════════════
   18. sendTyping
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Simulate typing presence in a chat for `durationMs` milliseconds, then
 * clear it.
 */
export async function sendTyping(
  sock: any,
  jid: string,
  durationMs = 2_000,
): Promise<void> {
  await sock.sendPresenceUpdate('composing', jid);
  await new Promise<void>((r) => setTimeout(r, durationMs));
  await sock.sendPresenceUpdate('paused', jid);
}

/* ═══════════════════════════════════════════════════════════════════════
   19. sendRead
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Mark one or more messages as read.
 */
export async function sendRead(
  sock: any,
  keys: Array<Record<string, unknown>>,
  /** The JID of the sender (needed for group read receipts). */
  senderJid?: string,
): Promise<void> {
  await sock.readMessages(keys, senderJid);
}

/* ═══════════════════════════════════════════════════════════════════════
   20. sendPresence
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Broadcast your presence state to a JID.
 * type: 'available' | 'unavailable' | 'composing' | 'recording' | 'paused'
 */
export async function sendPresence(
  sock: any,
  jid: string,
  type: 'available' | 'unavailable' | 'composing' | 'recording' | 'paused' = 'available',
): Promise<void> {
  await sock.sendPresenceUpdate(type, jid);
}

/* ═══════════════════════════════════════════════════════════════════════
   21. sendBroadcast
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Broadcast a message to an array of JIDs with an optional inter-message delay.
 */
export async function sendBroadcast(
  sock: any,
  params: BroadcastParams,
): Promise<Array<{ jid: string; result: unknown; error?: unknown }>> {
  const results: Array<{ jid: string; result: unknown; error?: unknown }> = [];
  for (const jid of params.jids) {
    try {
      const result = await sock.sendMessage(jid, params.content, params.options ?? undefined);
      results.push({ jid, result });
    } catch (error) {
      results.push({ jid, result: null, error });
    }
    if (params.delayMs && params.delayMs > 0) {
      await new Promise<void>((r) => setTimeout(r, params.delayMs));
    }
  }
  return results;
}

/* ═══════════════════════════════════════════════════════════════════════
   22. sendNewsletterMessage
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Publish a message to a WhatsApp channel (newsletter).
 */
export async function sendNewsletterMessage(
  sock: any,
  params: NewsletterMessageParams,
): Promise<unknown> {
  return sock.sendMessage(
    params.newsletterJid,
    params.content,
    params.options ?? undefined,
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   23. pinMessage
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Pin or unpin a message in a chat.
 */
export async function pinMessage(
  sock: any,
  params: PinMessageParams,
): Promise<unknown> {
  // Baileys rc14+ exposes sock.pinMessage for this.
  if (typeof sock.pinMessage === 'function') {
    return sock.pinMessage(params.jid, params.key, params.unpin ? 0 : 1);
  }
  // Fallback: send via sendMessage with pin content type.
  return sock.sendMessage(params.jid, {
    pin: { key: params.key, type: params.unpin ? 2 : 1 },
  });
}

/* ═══════════════════════════════════════════════════════════════════════
   24. starMessage
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Star or un-star one or more messages.
 */
export async function starMessage(
  sock: any,
  params: StarMessageParams,
): Promise<void> {
  await sock.chatModify(
    {
      star: {
        messages: params.messages.map((m) => ({ key: m.key, starred: m.starred })),
        star: params.messages[0]?.starred ?? true,
      },
    },
    params.jid,
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   25. muteChat
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Mute a chat for `duration` seconds (0 = unmute).
 */
export async function muteChat(
  sock: any,
  params: MuteChatParams,
): Promise<void> {
  const duration = params.duration ?? 0;
  if (duration === 0) {
    await sock.chatModify({ mute: null }, params.jid);
  } else {
    const muteEndTime = Date.now() + duration * 1_000;
    await sock.chatModify({ mute: muteEndTime }, params.jid);
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   26. archiveChat
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Archive or unarchive a chat.
 */
export async function archiveChat(
  sock: any,
  jid: string,
  archive = true,
): Promise<void> {
  await sock.chatModify({ archive }, jid);
}

/* ═══════════════════════════════════════════════════════════════════════
   27. searchMessages
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Search messages across all chats or within a specific JID.
 */
export async function searchMessages(
  sock: any,
  params: SearchMessagesParams,
): Promise<unknown> {
  if (typeof sock.searchMessages === 'function') {
    return sock.searchMessages(params.query, params.jid, params.count ?? 25, params.page ?? 1);
  }
  // Minimal fallback returning empty
  return { messages: [], count: 0 };
}

/* ═══════════════════════════════════════════════════════════════════════
   28. getMessageInfo
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Fetch delivery/read receipt info for a message.
 */
export async function getMessageInfo(
  sock: any,
  jid: string,
  messageId: string,
): Promise<unknown> {
  if (typeof sock.fetchMessageInfo === 'function') {
    return sock.fetchMessageInfo(jid, messageId);
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════════════════
   29. downloadMedia
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Download media from a WAMessage and return it as a Buffer.
 */
export async function downloadMedia(
  sock: any,
  params: DownloadMediaParams,
): Promise<Buffer> {
  // Baileys exposes downloadMediaMessage as a top-level function.
  // Import dynamically to avoid circular deps when the full index is used.
  const baileys = await import('@whiskeysockets/baileys');
  const dl =
    (baileys as Record<string, unknown>)['downloadMediaMessage'] as
    | ((msg: unknown, type: string, options?: unknown) => Promise<Buffer>)
    | undefined;

  if (dl) {
    return dl(params.message, 'buffer');
  }

  // Fallback: attempt through socket
  if (typeof sock.downloadMediaMessage === 'function') {
    return sock.downloadMediaMessage(params.message);
  }

  throw new Error('downloadMedia: no suitable download implementation found on sock or baileys');
}

/* ═══════════════════════════════════════════════════════════════════════
   30. uploadMedia
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Upload raw media bytes and return the resulting media object (url, mediaKey, etc.).
 * Uses sock.waUploadToServer which is part of the Baileys socket.
 */
export async function uploadMedia(
  sock: any,
  params: UploadMediaParams,
): Promise<unknown> {
  const buffer = await toBuffer(params.data as Buffer | Uint8Array | Readable | string);

  if (typeof sock.waUploadToServer === 'function') {
    return sock.waUploadToServer(buffer, {
      fileEncSha256: Buffer.alloc(32),
      mediaType: params.mediaType,
      mimetype: params.mimetype,
    });
  }

  // If sock doesn't expose waUploadToServer directly, raise a helpful error.
  throw new Error(
    'uploadMedia: sock.waUploadToServer is not available. ' +
    'Make sure you are passing a live Baileys WASocket.',
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   31. sendTemplate
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Send a template message with URL, call, or quick-reply buttons.
 */
export async function sendTemplate(
  sock: any,
  jid: string,
  params: TemplateParams,
): Promise<unknown> {
  const { quoted } = params.options ?? {};
  return sock.sendMessage(
    jid,
    {
      templateMessage: {
        hydratedTemplate: {
          hydratedContentText: params.text,
          ...(params.footer ? { hydratedFooterText: params.footer } : {}),
          hydratedButtons: params.buttons,
        },
      },
    },
    quoted ? { quoted } : undefined,
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   32. sendInteractive
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Send an interactive (native-flow) message.
 */
export async function sendInteractive(
  sock: any,
  jid: string,
  params: InteractiveParams,
): Promise<unknown> {
  const { quoted } = params.options ?? {};
  return sock.sendMessage(
    jid,
    {
      interactiveMessage: {
        body: { text: params.body },
        ...(params.footer ? { footer: { text: params.footer } } : {}),
        ...(params.header ? { header: params.header } : {}),
        ...(params.nativeFlowMessage
          ? { nativeFlowMessage: params.nativeFlowMessage }
          : {}),
        ...(params.collectionMessage
          ? { collectionMessage: params.collectionMessage }
          : {}),
      },
    },
    quoted ? { quoted } : undefined,
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   33. sendCarousel
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Send a carousel (horizontally scrollable cards) interactive message.
 */
export async function sendCarousel(
  sock: any,
  jid: string,
  params: CarouselParams,
): Promise<unknown> {
  const { quoted } = params.options ?? {};
  return sock.sendMessage(
    jid,
    {
      interactiveMessage: {
        ...(params.bodyText ? { body: { text: params.bodyText } } : {}),
        carouselMessage: {
          cards: params.cards.map((card) => ({
            ...(card.header ? { header: card.header } : {}),
            ...(card.body ? { body: { text: card.body } } : {}),
            ...(card.footer ? { footer: { text: card.footer } } : {}),
            ...(card.buttons ? { nativeFlowMessage: { buttons: card.buttons } } : {}),
          })),
        },
      },
    },
    quoted ? { quoted } : undefined,
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   34. sendList
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Send a list message (tap-to-open menu).
 *
 * ## Why this does not send `listMessage`
 *
 * It looks like it should: rc14's `WAProto` *does* define `ListMessage`, and
 * `getContentType()` even returns `'list'` for it. But `generateWAMessage()` has
 * **no `listMessage` branch** — it falls through to `prepareWAMessageMedia()`,
 * which finds no media key and throws `Invalid media type`. So a `listMessage`
 * payload is rejected by rc14 before it reaches the network. Verified against
 * `node_modules/@whiskeysockets/baileys/lib/Utils/messages.js` in rc14.
 *
 * A menu therefore goes as a `nativeFlowMessage` button named `single_select`,
 * whose `buttonParamsJson` is an opaque JSON string the *client* parses. Two
 * consequences that matter to callers:
 *
 *   1. The row key is **`id`**, not `rowId`. `WAProto`'s own `ListMessage.Row`
 *      uses `rowId`, but that type is unreachable here — the schema inside the
 *      opaque string is the client's, not protobuf's.
 *   2. This needs `generateWAMessageFromContent` + an explicit `messageSecret`,
 *      because that path bypasses the reporting token rc14 attaches normally.
 *      It is done by `sendCategoryMenu()` in `src/toolkit/category-menu.ts`.
 *
 * So `sendList` delegates there rather than duplicating the encoding, and the
 * typography is applied to the labels before it hands off.
 */
/**
 * Map `ListParams` onto the `single_select` category schema.
 *
 * Split out from `sendList` so the label/value distinction is directly testable:
 * `sendCategoryMenu` builds its protobuf message internally and only hands
 * `relayMessage` an ID, so nothing about the payload is observable from outside.
 *
 * The rule enforced here is the one that breaks silently on hardware — labels
 * take the feature face, **routing keys and descriptions stay verbatim**.
 */
export function toMenuCategories(
  sections: ListParams['sections'],
  featureFont?: FeatureName,
): Array<{ title: string; rows: Array<{ id: string; title: string; description?: string }> }> {
  const face = (t: string) => (featureFont ? brand(t, featureFont) : t);
  return sections.map((sec) => ({
    title: sec.title ? face(sec.title) : '',
    rows: (sec.rows ?? []).map((row) => ({
      // The key is `id`. See the note above: `rowId` is a WAProto name for a
      // message type rc14 cannot send.
      id: String(row.rowId),
      title: face(row.title),
      ...(row.description ? { description: row.description } : {}),
    })),
  }));
}

export async function sendList(
  sock: any,
  jid: string,
  params: ListParams,
  options: SendOptions = {},
): Promise<unknown> {
  const { featureFont } = options;
  const face = (t: string) => (featureFont ? brand(t, featureFont) : t);

  const { sendCategoryMenu } = await import('../toolkit/category-menu.js');
  return sendCategoryMenu(sock as never, jid, toMenuCategories(params.sections, featureFont) as never, {
    buttonTitle: face(params.title ?? params.buttonText ?? 'Menu'),
    body: params.text,
    footer: params.footer,
  } as never);
}

/* ═══════════════════════════════════════════════════════════════════════
   35. sendButtons
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Send a buttons message (up to 3 quick-reply buttons).
 */
export async function sendButtons(
  sock: any,
  jid: string,
  params: ButtonsParams,
  options: SendOptions = {},
): Promise<unknown> {
  const { quoted, featureFont } = options;
  // Button labels are labels. `text` is prose and `buttonId` is a routing key,
  // so both stay verbatim — a styled id breaks reply matching on device only.
  const face = (t: string) => (featureFont ? brand(t, featureFont) : t);
  return sock.sendMessage(
    jid,
    {
      buttonsMessage: {
        text: params.text,
        footerText: params.footer ?? '',
        buttons: params.buttons.map((b) => ({
          ...b,
          buttonText: { ...b.buttonText, displayText: face(b.buttonText.displayText) },
        })),
        headerType: params.headerType ?? 1,
      },
    },
    quoted ? { quoted } : undefined,
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   36. sendCatalog
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Send a product catalog message.
 */
export async function sendCatalog(
  sock: any,
  jid: string,
  params: CatalogParams,
): Promise<unknown> {
  const { quoted } = params.options ?? {};
  return sock.sendMessage(
    jid,
    {
      productMessage: {
        product: { productImage: null, productId: params.productId },
        businessOwnerJid: params.businessJid,
        ...(params.body ? { body: params.body } : {}),
        ...(params.footer ? { footer: params.footer } : {}),
      },
    },
    quoted ? { quoted } : undefined,
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   37. sendPaymentRequest
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Send a payment request message.
 */
export async function sendPaymentRequest(
  sock: any,
  jid: string,
  params: PaymentRequestParams,
): Promise<unknown> {
  const { quoted } = params.options ?? {};
  return sock.sendMessage(
    jid,
    {
      requestPaymentMessage: {
        noteMessage: { extendedTextMessage: { text: params.note } },
        currencyCodeIso4217: params.currency,
        amount1000: params.amount,
        requestFrom: jid,
        ...(params.expiryTimestamp
          ? { expiryTimestamp: params.expiryTimestamp }
          : {}),
        ...(params.background !== undefined
          ? { background: params.background }
          : {}),
      },
    },
    quoted ? { quoted } : undefined,
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   38. sendLiveLocation
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Send a live location message. The location is sent once; callers should
 * update it periodically by calling this function again with a new key to
 * edit, or by using Baileys' updateLiveLocation if available.
 */
export async function sendLiveLocation(
  sock: any,
  jid: string,
  params: LiveLocationParams,
  options: SendOptions = {},
): Promise<unknown> {
  const { quoted } = options;
  return sock.sendMessage(
    jid,
    {
      liveLocation: {
        degreesLatitude: params.latitude,
        degreesLongitude: params.longitude,
        ...(params.name ? { name: params.name } : {}),
        ...(params.address ? { address: params.address } : {}),
        ...(params.accuracyInMeters !== undefined
          ? { accuracyInMeters: params.accuracyInMeters }
          : {}),
        ...(params.speedInMps !== undefined ? { speedInMps: params.speedInMps } : {}),
        ...(params.caption ? { caption: params.caption } : {}),
      },
    },
    quoted ? { quoted } : undefined,
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   39. sendGif
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Send an animated GIF (sent as video with `gifPlayback: true`).
 */
export async function sendGif(
  sock: any,
  jid: string,
  gif: Buffer | Uint8Array | Readable | string | { url: string },
  options: MediaSendOptions = {},
): Promise<unknown> {
  const { quoted, ephemeralExpiration, featureFont, caption, mimetype, ...rest } = options;
  const gifContent =
    typeof gif === 'object' && 'url' in gif
      ? { url: (gif as { url: string }).url }
      : await toBuffer(gif as Buffer | Uint8Array | Readable | string);

  return sock.sendMessage(
    jid,
    {
      video: gifContent,
      gifPlayback: true,
      mimetype: mimetype ?? 'video/mp4',
      ...(caption ? { caption: featureFont ? brand(caption, featureFont) : caption } : {}),
      ...(ephemeralExpiration ? { ephemeralExpiration } : {}),
      ...rest,
    },
    quoted ? { quoted } : undefined,
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   40. sendVoiceNote
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Send a voice note (PTT — push-to-talk audio).
 */
export async function sendVoiceNote(
  sock: any,
  jid: string,
  audio: Buffer | Uint8Array | Readable | string | { url: string },
  options: MediaSendOptions = {},
): Promise<unknown> {
  const { quoted, ephemeralExpiration, mimetype, ...rest } = options;
  const audioContent =
    typeof audio === 'object' && 'url' in audio
      ? { url: (audio as { url: string }).url }
      : await toBuffer(audio as Buffer | Uint8Array | Readable | string);

  return sock.sendMessage(
    jid,
    {
      audio: audioContent,
      ptt: true,
      mimetype: mimetype ?? 'audio/ogg; codecs=opus',
      ...(ephemeralExpiration ? { ephemeralExpiration } : {}),
      ...rest,
    },
    quoted ? { quoted } : undefined,
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   41. sendVideoNote
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Send a circular video note (PTV — picture-in-picture video).
 */
export async function sendVideoNote(
  sock: any,
  jid: string,
  video: Buffer | Uint8Array | Readable | string | { url: string },
  options: MediaSendOptions = {},
): Promise<unknown> {
  const { quoted, ephemeralExpiration, mimetype, ...rest } = options;
  const videoContent =
    typeof video === 'object' && 'url' in video
      ? { url: (video as { url: string }).url }
      : await toBuffer(video as Buffer | Uint8Array | Readable | string);

  return sock.sendMessage(
    jid,
    {
      ptv: videoContent,
      mimetype: mimetype ?? 'video/mp4',
      ...(ephemeralExpiration ? { ephemeralExpiration } : {}),
      ...rest,
    },
    quoted ? { quoted } : undefined,
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   42. sendEphemeral
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Enable or update the ephemeral (disappearing messages) timer for a chat.
 */
export async function sendEphemeral(
  sock: any,
  params: EphemeralParams,
): Promise<void> {
  await sock.sendMessage(params.jid, {
    disappearingMessagesInChat: params.expiration,
  });
}

/* ═══════════════════════════════════════════════════════════════════════
   43. revoke
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Revoke (delete for everyone) a message you sent.
 */
export async function revoke(
  sock: any,
  jid: string,
  key: Record<string, unknown>,
): Promise<unknown> {
  return sock.sendMessage(jid, { delete: key });
}

/* ═══════════════════════════════════════════════════════════════════════
   44. clearChat
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Clear all messages in a chat from the device (local clear, not server-side delete).
 */
export async function clearChat(
  sock: any,
  params: ClearChatParams,
): Promise<void> {
  await sock.chatModify(
    {
      clear: {
        messages: params.beforeTimestamp
          ? [{ timestamp: params.beforeTimestamp }]
          : true,
      },
    },
    params.jid,
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   45. sendConfirmation
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Send a confirmation acknowledgement text message.
 */
export async function sendConfirmation(
  sock: any,
  jid: string,
  message: string = '✅ Confirmed.',
  options: SendOptions = {},
): Promise<unknown> {
  return sendText(sock, jid, message, options);
}

/* ═══════════════════════════════════════════════════════════════════════
   46. sendReminder
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Send a reminder message at a scheduled time.
 */
export async function sendReminder(
  sock: any,
  jid: string,
  reminderText: string,
  sendAt: number,
  options: SendOptions = {},
): Promise<unknown> {
  return scheduleMessage(sock, { jid, content: { text: reminderText }, sendAt, options });
}

/* ═══════════════════════════════════════════════════════════════════════
   47. sendInvite
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Send a group invite link as a text message.
 */
export async function sendInvite(
  sock: any,
  jid: string,
  groupJid: string,
  options: SendOptions & { inviteCode?: string; groupName?: string } = {},
): Promise<unknown> {
  let inviteCode = options.inviteCode;
  if (!inviteCode) {
  const { quoted, featureFont } = options;
  // Labels take the feature face; ids, prose, and counts stay verbatim.
  const face = (t: string) => (featureFont ? brand(t, featureFont) : t);
    const code: string = await sock.groupInviteCode(groupJid);
    inviteCode = code;
  }
  const link = `https://chat.whatsapp.com/${inviteCode}`;
  const text = options.groupName
    ? `Join *${options.groupName}*:\n${link}`
    : `Group invite link:\n${link}`;
  return sendText(sock, jid, text, options);
}

/* ═══════════════════════════════════════════════════════════════════════
   48. sendWelcome
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Send a welcome message to a newly joined participant.
 */
export async function sendWelcome(
  sock: any,
  jid: string,
  participantJid: string,
  groupName?: string,
  options: SendOptions = {},
): Promise<unknown> {
  const bare = participantJid.split('@')[0] ?? participantJid;
  const name = groupName ? ` to *${groupName}*` : '';
  const text = `👋 Welcome @${bare}${name}! Glad to have you here.`;
  return sock.sendMessage(
    jid,
    { text, mentions: [participantJid] },
    options.quoted ? { quoted: options.quoted } : undefined,
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   49. sendGoodbye
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Send a goodbye message when a participant leaves a group.
 */
export async function sendGoodbye(
  sock: any,
  jid: string,
  participantJid: string,
  options: SendOptions = {},
): Promise<unknown> {
  const bare = participantJid.split('@')[0] ?? participantJid;
  const text = `👋 Goodbye @${bare}, we'll miss you!`;
  return sock.sendMessage(
    jid,
    { text, mentions: [participantJid] },
    options.quoted ? { quoted: options.quoted } : undefined,
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   50. sendAlert
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Send an alert / warning message, formatted with an emoji prefix.
 */
export async function sendAlert(
  sock: any,
  jid: string,
  alertText: string,
  level: 'info' | 'warning' | 'error' = 'info',
  options: SendOptions = {},
): Promise<unknown> {
  const icons = { info: 'ℹ️', warning: '⚠️', error: '🚨' } as const;
  const text = `${icons[level]} ${alertText}`;
  return sendText(sock, jid, text, options);
}

/* ═══════════════════════════════════════════════════════════════════════
   51. sendBroadcastList
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Send a message to a WhatsApp broadcast list JID.
 * Broadcast list JIDs end with `@broadcast`.
 */
export async function sendBroadcastList(
  sock: any,
  broadcastJid: string,
  content: Record<string, unknown>,
  options: SendOptions = {},
): Promise<unknown> {
  if (!broadcastJid.endsWith('@broadcast')) {
    throw new Error(`sendBroadcastList: expected a @broadcast JID, got "${broadcastJid}"`);
  }
  const { quoted } = options;
  return sock.sendMessage(broadcastJid, content, quoted ? { quoted } : undefined);
}

/* ═══════════════════════════════════════════════════════════════════════
   52. sendGroupMention  (bonus — mention specific users)
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Send a message mentioning specific users (subset of participants).
 */
export async function sendGroupMention(
  sock: any,
  jid: string,
  text: string,
  mentions: string[],
  options: SendOptions = {},
): Promise<unknown> {
  const { quoted } = options;
  return sock.sendMessage(
    jid,
    { text, mentions },
    quoted ? { quoted } : undefined,
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   53. sendFileByPath  (bonus)
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Auto-detect media type from file extension and send as the appropriate
 * media message (image / video / audio / document).
 */
export async function sendFileByPath(
  sock: any,
  jid: string,
  filePath: string,
  options: MediaSendOptions = {},
): Promise<unknown> {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';

  const imageExts = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'avif']);
  const videoExts = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm']);
  const audioExts = new Set(['mp3', 'ogg', 'aac', 'm4a', 'flac', 'wav', 'opus']);

  await stat(filePath); // validate path exists

  if (imageExts.has(ext)) return sendImage(sock, jid, filePath, options);
  if (videoExts.has(ext)) return sendVideo(sock, jid, filePath, options);
  if (audioExts.has(ext)) return sendAudio(sock, jid, filePath, options);
  return sendDocument(sock, jid, filePath, options);
}

/* ═══════════════════════════════════════════════════════════════════════
   54. sendTypingAndText  (bonus — human-like send)
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Simulate typing for a realistic duration proportional to text length,
 * then send the text.
 */
export async function sendTypingAndText(
  sock: any,
  jid: string,
  text: string,
  options: SendOptions = {},
  /** Characters-per-second typing speed. Default 12 cps ≈ 70 WPM. */
  cps = 12,
): Promise<unknown> {
  const durationMs = Math.min(Math.max((text.length / cps) * 1_000, 500), 6_000);
  await sendTyping(sock, jid, durationMs);
  return sendText(sock, jid, text, options);
}

/* ═══════════════════════════════════════════════════════════════════════
   55. sendMultipleReactions  (bonus)
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Apply reactions to multiple messages in a single call.
 */
export async function sendMultipleReactions(
  sock: any,
  jid: string,
  reactions: ReactionParams[],
): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const r of reactions) {
    results.push(await sendReaction(sock, jid, r));
  }
  return results;
}
