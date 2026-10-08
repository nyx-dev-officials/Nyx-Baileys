/**
 * OPS-250 · inbound event parsing.
 *
 * Everything here is pure: it takes a `messages.upsert` payload and tells you
 * what it is. That makes it the highest-value kind of code to unit test,
 * because the wire is where rc14 surprises you and the pure functions are
 * where you can prove the surprise is handled.
 */

import { proto } from '@whiskeysockets/baileys';

import type { AnySock } from '../ops-50/types.js';

/** Every `StubType` rc14 defines, with the one that is easy to get wrong. */
export const STUB_TYPES = {
  REVOKE: 1,
  CIPHERTEXT: 2,
  GROUP_ANNOUNCE_MODE_MESSAGE_BOUNCE: 44,
} as const;

/**
 * Is this a revoke?
 *
 * `StubType.REVOKE` is **1**. The widely-cited `44` is
 * `GROUP_ANNOUNCE_MODE_MESSAGE_BOUNCE` — matching it caches group announcement
 * bounces and never a revoke, which installs silently and does nothing useful.
 * The enum is read from proto so a bump cannot redirect it.
 */
export function isRevoke(message: any): boolean {
  return message?.messageStubType === STUB_TYPES.REVOKE;
}

/** Is this a group announcement bounce? The mistake people actually make. */
export function isAnnounceBounce(message: any): boolean {
  return message?.messageStubType === STUB_TYPES.GROUP_ANNOUNCE_MODE_MESSAGE_BOUNCE;
}

/**
 * Is this an admin revoke rather than a user one?
 *
 * The stub enum lives on `WebMessageInfo`, not `Message` — `proto.Message.StubType`
 * does not exist in rc14 and referencing it is a compile error, which is the good
 * kind of wrong.
 */
export function isAdminRevoke(message: any): boolean {
  return message?.messageStubType === proto.WebMessageInfo.StubType.REVOKE
    && message?.message?.protocolMessage?.type === proto.Message.ProtocolMessage.Type.REVOKE;
}

/** Is this a plain protocol message? */
export function isProtocolMessage(message: any): boolean {
  return Boolean(message?.message?.protocolMessage);
}

/** Is this a message we sent? */
export function isOutgoing(message: any): boolean {
  return message?.key?.fromMe === true;
}

/** Is this a system/ephemeral notice? */
export function isSystemNotice(message: any): boolean {
  return message?.message?.protocolMessage?.type === proto.Message.ProtocolMessage.Type.REVOKE
    || message?.messageStubType === STUB_TYPES.REVOKE;
}

/** The sender, preferring the participant for groups. */
export function senderOf(message: any): string | undefined {
  return message?.key?.participant ?? message?.key?.remoteJid ?? undefined;
}

/** The chat this message belongs to, with device suffixes stripped. */
export function chatOf(message: any): string | undefined {
  const jid = message?.key?.remoteJid;
  return jid ? jid.split(':')[0] : undefined;
}

/** The unique message key rc14 expects for receipts and revokes. */
export function keyOf(message: any): { remoteJid: string; id: string; fromMe: boolean; participant?: string } | null {
  if (!message?.key?.id || !message?.key?.remoteJid) return null;
  return {
    remoteJid: message.key.remoteJid,
    id: message.key.id,
    fromMe: message.key.fromMe === true,
    ...(message.key.participant ? { participant: message.key.participant } : {}),
  };
}

/* ── content extraction ──────────────────────────────────────────── */

/** Every media type rc14 can deliver, in one list. */
export const MEDIA_MESSAGE_KEYS = [
  'imageMessage',
  'videoMessage',
  'audioMessage',
  'documentMessage',
  'stickerMessage',
] as const;

export type MediaKey = (typeof MEDIA_MESSAGE_KEYS)[number];

/** Which media key is present, if any. */
export function mediaKeyOf(message: any): MediaKey | null {
  const m = message?.message ?? {};
  for (const key of MEDIA_MESSAGE_KEYS) {
    if (m[key] !== undefined) return key;
  }
  return null;
}

/** The `firstMedia` shape the existing toolkit expects. */
export function firstMedia(message: any): { type: string; message: Record<string, any> } | null {
  const key = mediaKeyOf(message);
  if (!key) return null;
  return { type: key, message: message.message[key] };
}

/** Does this message carry retrievable media? */
export function hasMedia(message: any): boolean {
  return mediaKeyOf(message) !== null;
}

/** Is this media voice-note shaped? */
export function isVoiceNote(message: any): boolean {
  const audio = message?.message?.audioMessage;
  return Boolean(audio?.ptt);
}

/** Is this media a sticker? */
export function isSticker(message: any): boolean {
  return Boolean(message?.message?.stickerMessage);
}

/** Is this an ephemeral message? */
export function isEphemeral(message: any): boolean {
  const ctx = message?.message?.messageContextInfo ?? message?.message;
  return Boolean(ctx?.ephemeralExpiration);
}

/* ── interaction extraction ─────────────────────────────────────── */

/** The interactive or template payload, whatever shape it arrived in. */
export function interactiveOf(message: any): Record<string, any> | null {
  const m = message?.message ?? {};
  return m.interactiveMessage
    ?? m.buttonsMessage
    ?? m.listMessage
    ?? m.templateMessage
    ?? null;
}

/** Is this a quick-reply response? */
export function isQuickReplyReply(message: any): boolean {
  return message?.message?.interactiveResponseMessage?.nativeFlowResponseMessage
    !== undefined;
}

/** The reply a recipient chose, from an interactive response. */
export function selectedReply(message: any): string | null {
  const native = message?.message?.interactiveResponseMessage?.nativeFlowResponseMessage;
  if (!native) return null;

  const params = native.paramsJson;
  if (typeof params !== 'string') return null;

  try {
    const parsed = JSON.parse(params);
    return parsed?.id ?? parsed?.display_text ?? null;
  } catch {
    // `paramsJson` is opaque by design; a non-JSON payload is not an error here.
    return null;
  }
}

/** Is this a list-reply — the row a user picked from a category menu? */
export function isListReply(message: any): boolean {
  const native = message?.message?.interactiveResponseMessage?.nativeFlowResponseMessage;
  const id = selectedReply(message);
  return native !== undefined && id !== null && !native.paramsJson?.includes('cta_');
}

/** The list title a reply came from. */
export function listTitleOf(message: any): string | null {
  const native = message?.message?.interactiveResponseMessage?.nativeFlowMessageTitle;
  return native ?? null;
}

/* ── revokes and edits ───────────────────────────────────────────── */

/** The message id a revoke points at. */
export function revokedKeyOf(message: any): { id: string } | null {
  const key = message?.key;
  return key?.id ? { id: key.id } : null;
}

/** Is this a message edit? */
export function isEdit(message: any): boolean {
  return message?.message?.protocolMessage?.editedMessage !== undefined;
}

/** The new text inside an edit. */
export function editedText(message: any): string | null {
  const edited = message?.message?.protocolMessage?.editedMessage;
  return edited?.message?.extendedTextMessage?.text
    ?? edited?.message?.conversation
    ?? null;
}

/* ── reactions ───────────────────────────────────────────────────── */

/** The reaction on a message, or null. */
export function reactionOf(message: any): string | null {
  const reaction = message?.message?.reactionMessage;
  if (!reaction) return null;
  // rc14 uses an empty text to mean "reaction removed".
  return reaction.text ?? null;
}

/** Is this a reaction removal? */
export function isReactionRemoval(message: any): boolean {
  const reaction = message?.message?.reactionMessage;
  return reaction !== undefined && (reaction.text === '' || reaction.text === undefined);
}

/* ── event routing ───────────────────────────────────────────────── */

/** Split a `messages.upsert` payload into its messages. */
export function messagesOf(event: { messages?: any[] }): any[] {
  return event?.messages ?? [];
}

/**
 * Should this message be processed at all?
 *
 * Filters out our own messages and system stubs by default, which is the
 * starting point most consumers need before their own logic runs.
 */
export function isProcessable(message: any, options: { includeOwn?: boolean; includeStubs?: boolean } = {}): boolean {
  if (!message?.key?.id) return false;
  if (!options.includeOwn && isOutgoing(message)) return false;
  if (!options.includeStubs && (message.messageStubType !== undefined || isProtocolMessage(message))) {
    return false;
  }
  return true;
}

/** Filter an upsert down to processable messages. */
export function processable(
  event: { messages?: any[] },
  options: { includeOwn?: boolean; includeStubs?: boolean } = {},
): any[] {
  return messagesOf(event).filter((m) => isProcessable(m, options));
}

/** Attach a handler that sees only processable messages. */
export function onProcessable(
  sock: AnySock,
  handler: (message: any) => void,
  options: { includeOwn?: boolean; includeStubs?: boolean } = {},
): () => void {
  const wrapped = (event: { messages?: any[] }): void => {
    for (const message of processable(event, options)) handler(message);
  };
  sock.ev.on('messages.upsert', wrapped);
  return () => sock.ev.off('messages.upsert', wrapped);
}