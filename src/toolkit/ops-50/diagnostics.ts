/**
 * OPS-50 · module 6 of 6 — presence, message utilities, diagnostics.
 *
 * Mostly pure functions over data the socket already exposes. Nothing here
 * writes to the account except the three presence calls.
 */

import { createHash } from 'node:crypto';

import type { AnySock } from './types.js';

/* ── 75-78 · presence ─────────────────────────────────────────────── */

/** Presence types rc14 accepts on `sendPresenceUpdate`. */
export type PresenceKind = 'available' | 'unavailable' | 'composing' | 'recording' | 'paused';

/** Available or unavailable. No target jid needed. */
export function setPresence(sock: AnySock, kind: 'available' | 'unavailable'): Promise<void> {
  return sock.sendPresenceUpdate(kind);
}

/**
 * Typing or recording indicator.
 *
 * The target jid is **required** here — omitting it is a silent no-op, not a
 * default. This is one of the easiest rc14 calls to get wrong.
 */
export function setTyping(sock: AnySock, jid: string, recording = false): Promise<void> {
  return sock.sendPresenceUpdate(recording ? 'recording' : 'composing', jid);
}

/** Clear the typing indicator. */
export function clearTyping(sock: AnySock, jid: string): Promise<void> {
  return sock.sendPresenceUpdate('paused', jid);
}

/* ── 79-84 · message utilities ────────────────────────────────────── */

/** Text of a message, or an empty string. Never throws on odd shapes. */
export function messageText(message: any): string {
  const m = message?.message ?? {};
  return (
    m.conversation
    ?? m.extendedTextMessage?.text
    ?? m.imageMessage?.caption
    ?? m.videoMessage?.caption
    ?? m.audioMessage?.caption
    ?? m.documentMessage?.caption
    ?? m.buttonsMessage?.contentText
    ?? m.listMessage?.description
    ?? ''
  );
}

/** Stable short hash of a message, for dedupe and change detection. */
export function messageFingerprint(message: any): string {
  const from = message?.key?.remoteJid ?? '';
  const id = message?.key?.id ?? '';
  return createHash('sha256').update(`${from}|${id}`).digest('hex').slice(0, 16);
}

/** True when a message came from this account. */
export function isFromMe(message: any): boolean {
  return message?.key?.fromMe === true;
}

/**
 * Extract a usable read-receipt key.
 *
 * `readMessages` needs an **inbound** key (`fromMe: false`). Handing it one of
 * your own outgoing keys returns nothing at all, so this refuses rather than
 * returning an empty receipt that looks like success.
 */
export function receiptKey(
  message: any,
): { remoteJid: string; id: string; fromMe: false } | null {
  if (!message?.key?.id || !message?.key?.remoteJid) return null;
  if (message.key.fromMe === true) return null;
  return { remoteJid: message.key.remoteJid, id: message.key.id, fromMe: false };
}

/** Mark one inbound message read. False means the key was not receivable. */
export async function markRead(sock: AnySock, message: any): Promise<boolean> {
  const key = receiptKey(message);
  if (!key) return false;
  await sock.readMessages([key as never]);
  return true;
}

/* ── 85-88 · identity ─────────────────────────────────────────────── */

/** This account's jid, or undefined if the socket is not open. */
export function ownJid(sock: AnySock): string | undefined {
  return sock.user?.id;
}

/**
 * This account's device id — the `12` in `6283831459585:12@s.whatsapp.net`.
 *
 * A jid is `user:device@domain`, so the device segment is what follows the first
 * colon and stops at the `@`.
 */
export function deviceId(sock: AnySock): string | undefined {
  const jid = ownJid(sock);
  if (!jid) return undefined;
  const afterColon = jid.split(':')[1];
  if (!afterColon) return undefined;
  return afterColon.split('@')[0] || undefined;
}

/** Strip the device suffix from a jid. */
export function baseJid(jid: string): string {
  return jid.split(':')[0] ?? jid;
}

/** True when a jid belongs to this account, ignoring device. */
export function isSelf(sock: AnySock, jid: string): boolean {
  const me = ownJid(sock);
  return Boolean(me && baseJid(jid) === baseJid(me));
}

/* ── 89-95 · connection health ────────────────────────────────────── */

export interface ConnectionHealth {
  connected: boolean;
  /** `undefined` when the socket exposes no auth state to read. */
  registered?: boolean;
  jid?: string;
}

/**
 * Read current connection health. Purely observational — writes nothing.
 *
 * `registered` is reported as `undefined` rather than `false` when the socket
 * carries no auth state. This framework does not always put `authState` on the
 * socket, and guessing `false` there would look like a broken session.
 */
export async function connectionHealth(sock: AnySock): Promise<ConnectionHealth> {
  const connected = sock.user?.id !== undefined;

  let registered: boolean | undefined;
  if (typeof sock.authState === 'function') {
    try {
      const state = await sock.authState();
      registered = state?.creds?.registered === true;
    } catch {
      registered = undefined;
    }
  }

  return { connected, registered, jid: ownJid(sock) };
}

/**
 * True when the socket is connected and — if it exposes auth state — registered.
 *
 * With no readable auth state this answers on connection alone rather than
 * failing closed, because a false negative here would block a healthy session.
 */
export async function isReady(sock: AnySock): Promise<boolean> {
  const health = await connectionHealth(sock);
  return health.connected && health.registered !== false;
}

/**
 * Milliseconds for one `onWhatsApp` round trip.
 *
 * This measures API latency, **not** message delivery. Delivery is separate,
 * and this account has dropped messages that returned clean ids.
 */
export async function measureLatency(sock: AnySock, number: string): Promise<number> {
  const started = Date.now();
  await sock.onWhatsApp(number.replace(/\D/g, ''));
  return Date.now() - started;
}

/** Assert the socket is usable, with an error that says what to do. */
export function assertReady(sock: AnySock): void {
  if (!sock.user?.id) {
    throw new Error('socket is not open — await connect() before calling this');
  }
}