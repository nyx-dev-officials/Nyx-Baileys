/**
 * OPS-250 · history, USync queries, and raw protocol access.
 *
 * These are the methods that reach past the message API into the query surface.
 * They are lower-level and more useful than they look: `executeUSyncQuery` is
 * how you ask WhatsApp structured questions (contact metadata, group rosters,
 * device lists) without scraping formatted messages.
 *
 * Methods used: `fetchMessageHistory`, `executeUSyncQuery`, `getUSyncDevices`,
 * `fetchAccountReachoutTimelock`, `fetchNewChatMessageCap`, `fetchStatus`,
 * `presenceSubscribe`, `getBotListV2`, `getMediaHost`, `refreshMediaConn`,
 * `generateMessageTag`, `sendNode`, `sendRawMessage`, `sendReceipt`,
 * `sendReceipts`, `sendMessageAck`, `query`, `serverProps`, `requestPlaceholderResend`,
 * `placeholderResendCache`, `messageRetryManager`.
 *
 * **Unverified on hardware.** `fetchMessageHistory` and `presenceSubscribe` in
 * particular depend on server-side state this account may not have.
 */

import { jidDecode, jidEncode } from '../ops-50/types.js';

type AnySock = Record<string, any>;

/* ── 41-50 · history and queries ─────────────────────────────────── */

/**
 * Fetch historical messages for a chat.
 *
 * rc14's shape is `(count, oldestMsgKey?, oldestMsgTimestamp?)`. The key must be
 * a real message from that chat — an invented key returns nothing rather than
 * erroring, so a bad key looks exactly like an empty chat.
 */
export function fetchHistory(
  sock: AnySock,
  count: number,
  oldestKey?: unknown,
  oldestTimestamp?: number,
): Promise<unknown> {
  return sock.fetchMessageHistory(count, oldestKey, oldestTimestamp);
}

/** Page backwards through a chat, collecting up to `total` messages. */
export async function pageHistory(
  sock: AnySock,
  jid: string,
  total: number,
  pageSize = 50,
): Promise<any[]> {
  const out: any[] = [];
  let oldestKey: unknown;
  let oldestTimestamp: number | undefined;

  while (out.length < total) {
    const size = Math.min(pageSize, total - out.length);
    const batch = (await sock.fetchMessageHistory(size, oldestKey, oldestTimestamp)) as
      | any[]
      | undefined;

    const fresh = (batch ?? []).filter((m) => m?.key?.id);
    if (fresh.length === 0) break;

    out.push(...fresh);
    const tail = fresh[fresh.length - 1];
    oldestKey = tail.key;
    oldestTimestamp = tail.messageTimestamp;
  }

  return out;
}

/** Run a USync query — the structured-query entry point. */
export function usync(sock: AnySock, query: unknown): Promise<unknown> {
  return sock.executeUSyncQuery(query as never);
}

/** List devices for a set of jids. */
export function usyncDevices(sock: AnySock, jids: string[]): Promise<unknown> {
  return sock.getUSyncDevices(jids);
}

/** The account's reach-out timelock, which gates some bulk operations. */
export function reachoutTimelock(sock: AnySock): Promise<unknown> {
  return sock.fetchAccountReachoutTimelock();
}

/** Cap on how many new chats this account may open. */
export function newChatCap(sock: AnySock): Promise<unknown> {
  return sock.fetchNewChatMessageCap();
}

/** Fetch status/story broadcasts for jids. */
export function fetchStatuses(sock: AnySock, jids: string[]): Promise<unknown> {
  return sock.fetchStatus(...jids);
}

/** Subscribe to a contact's presence. Takes a jid, not a list. */
export function subscribePresence(sock: AnySock, jid: string): Promise<unknown> {
  return sock.presenceSubscribe(jid);
}

/** Subscribe to many contacts' presence concurrently. */
export async function subscribeMany(sock: AnySock, jids: string[]): Promise<unknown[]> {
  return Promise.all(jids.map((j) => sock.presenceSubscribe(j)));
}

/** The account's bot list. */
export function botList(sock: AnySock): Promise<unknown> {
  return sock.getBotListV2();
}

/** The media host currently in use. */
export function mediaHost(sock: AnySock): Promise<unknown> {
  return sock.getMediaHost();
}

/** Force a media-connection refresh, optionally bypassing cache. */
export function refreshMedia(sock: AnySock, force = false): Promise<void> {
  return sock.refreshMediaConn(force);
}

/* ── 51-60 · raw protocol ────────────────────────────────────────── */

/** Generate a message tag — the id a sent message will carry. */
export function nextTag(sock: AnySock, userJid?: string): string {
  return sock.generateMessageTag() as string;
}

/** Send a raw binary node. */
export function sendNode(sock: AnySock, node: unknown, timeoutMs?: number): Promise<unknown> {
  return sock.sendNode(node as never, timeoutMs);
}

/** Send a pre-encoded message frame. */
export function sendRaw(sock: AnySock, frame: unknown, options: Record<string, unknown>): Promise<unknown> {
  return sock.sendRawMessage(frame as never, options as never);
}

/** Send a receipt for messages. */
export function sendReceiptFor(sock: AnySock, keys: unknown[]): Promise<unknown> {
  return sock.sendReceipt(keys as never);
}

/** Send receipts for many keys at once. */
export function sendReceiptsFor(sock: AnySock, keys: unknown[]): Promise<unknown> {
  return sock.sendReceipts(keys as never);
}

/** Acknowledge a message without a receipt stanza. */
export function ackMessage(sock: AnySock, node: unknown): Promise<unknown> {
  return sock.sendMessageAck(node as never);
}

/** Query a node. */
export function queryNode(sock: AnySock, tag: string, node: unknown): Promise<unknown> {
  return sock.query(tag, node as never);
}

/** Server properties advertised at connect. */
export async function serverProperties(sock: AnySock): Promise<unknown> {
  return sock.serverProps();
}

/** Ask the server to resend a message we only have a placeholder for. */
export function requestResend(sock: AnySock, key: unknown, node?: unknown): Promise<unknown> {
  return sock.requestPlaceholderResend(key as never, node as never);
}

/* ── jid helpers ─────────────────────────────────────────────────── */

/**
 * Decode a jid into its user / device / server parts.
 *
 * Thin alias over the shared `jidDecode` in `ops-50/types.ts`, which handles
 * the colon form, the LID form, and bare jids. The name differs only so this
 * module reads naturally at the call site.
 */
export function decodeJid(jid: string): { user: string; device: number; server: string } | null {
  return jidDecode(jid);
}

/** Encode parts back into a jid. Delegates to the shared encoder. */
export function encodeJid(user: string, device: number, server: string): string {
  return jidEncode(user, device, server);
}

/** Normalise a phone number to bare digits, as `onWhatsApp` expects. */
export function toDigits(input: string): string {
  return String(input).replace(/\D/g, '');
}

/**
 * Is this a plausible E.164 number?
 *
 * Not a validation guarantee — WhatsApp decides reachability — but it catches
 * the common paste errors before they become a silent lookup miss.
 */
export function looksLikePhone(input: string): boolean {
  const digits = toDigits(input);
  // E.164: up to 15 digits, first digit non-zero. The minimum is 8 rather than
  // the shortest real country code, because a shorter bound passes fragments
  // that look valid and then miss on lookup.
  return digits.length >= 8 && digits.length <= 15 && digits[0] !== '0';
}