/**
 * OPS-250 · newsletter operations and moderation.
 *
 * The remaining unreferenced rc14 surfaces: newsletter admin/react/fetch,
 * moderation verbs, and the send-ack path.
 *
 * Methods used: `newsletterFetchMessages`, `newsletterReactMessage`,
 * `newsletterChangeOwner`, `newsletterDemote`, `newsletterAdminCount`,
 * `newsletterUpdateName`, `newsletterUpdateDescription`,
 * `subscribeNewsletterUpdates`, `groupParticipantsUpdate`, `sendMessageAck`,
 * `waUploadToServer`, `upsertMessage`, `removeChatLabel`.
 *
 * **Unverified on hardware.** Newsletter surfaces are account-gated.
 */

import type { AnySock } from '../ops-50/types.js';

/* ── 161-170 · newsletter reads ──────────────────────────────────── */

/**
 * Fetch newsletter messages.
 *
 * The signature is `(jid, count, since, after)` — four positional arguments, so
 * a two-argument call silently returns nothing rather than the latest page.
 */
export function fetchNewsletterMessages(
  sock: AnySock,
  jid: string,
  count: number,
  since = 0,
  after = 0,
): Promise<unknown> {
  return sock.newsletterFetchMessages(jid, count, since, after);
}

/** Subscribe to live newsletter updates. */
export function subscribeNewsletter(sock: AnySock, jid: string): Promise<unknown> {
  return sock.subscribeNewsletterUpdates(jid);
}

/** React to a newsletter message. Pass no emoji to remove the reaction. */
export function reactNewsletter(
  sock: AnySock,
  jid: string,
  serverId: string,
  emoji?: string,
): Promise<void> {
  return sock.newsletterReactMessage(jid, serverId, emoji);
}

/** How many admins a newsletter has. */
export function newsletterAdmins(sock: AnySock, jid: string): Promise<unknown> {
  return sock.newsletterAdminCount(jid);
}

/** Transfer newsletter ownership. */
export function transferNewsletter(sock: AnySock, jid: string, toJid: string): Promise<unknown> {
  return sock.newsletterChangeOwner(jid, toJid);
}

/** Demote a newsletter admin. */
export function demoteNewsletterAdmin(sock: AnySock, jid: string, adminJid: string): Promise<unknown> {
  return sock.newsletterDemote(jid, adminJid);
}

/** Rename a newsletter through its dedicated verb. */
export function newsletterRename(sock: AnySock, jid: string, name: string): Promise<unknown> {
  return sock.newsletterUpdateName(jid, name);
}

/** Describe a newsletter through its dedicated verb. */
export function newsletterDescribe(sock: AnySock, jid: string, description: string): Promise<unknown> {
  return sock.newsletterUpdateDescription(jid, description);
}

/* ── 171-180 · media upload and acks ─────────────────────────────── */

/**
 * Upload media and return a handle rc14 accepts.
 *
 * `sendMedia` does this implicitly. Call it directly only when you need the
 * handle for something other than an immediate send — a cover photo, a
 * newsletter picture, a profile picture.
 */
export async function uploadMedia(
  sock: AnySock,
  media: { buffer?: Buffer; stream?: unknown; mimetype: string; fileName?: string; files?: unknown },
): Promise<unknown> {
  return sock.waUploadToServer(media as never);
}

/** Acknowledge a stanza that arrived. */
export function ack(sock: AnySock, node: unknown): Promise<unknown> {
  return sock.sendMessageAck(node as never);
}

/**
 * Insert a message into this device's history without sending it.
 *
 * Useful for mirroring an action across linked devices — but it fabricates a
 * local record, so never use it to make something look like it was delivered.
 */
export function upsertLocal(sock: AnySock, message: unknown): void {
  sock.upsertMessage(message as never);
}

/* ── 181-190 · moderation ────────────────────────────────────────── */

export type ModerationAction = 'delete' | 'ban' | 'unban' | 'promote' | 'demote' | 'remove';

/**
 * Run a moderation action.
 *
 * `delete` removes the message for everyone; the rest act on the sender.
 * `ban` is permanent — there is no `unban` reversal on WhatsApp's side, so the
 * caller gets a warning-shaped return rather than a silent delete.
 */
export async function moderate(
  sock: AnySock,
  jid: string,
  action: ModerationAction,
  target: string,
  actor: string,
): Promise<{ ok: boolean; destructive: boolean }> {
  const destructive = action === 'ban' || action === 'delete' || action === 'remove';

  if (action === 'delete') {
    await sock.sendMessage(jid, { delete: { remoteJid: target, id: actor, fromMe: true } } as never);
  } else {
    await sock.groupParticipantsUpdate(jid, [target], action as never);
  }

  return { ok: true, destructive };
}

/** Delete a message for everyone. */
export function deleteForEveryone(sock: AnySock, jid: string, messageId: string, participant?: string): Promise<unknown> {
  return sock.sendMessage(jid, {
    delete: { remoteJid: jid, id: messageId, ...(participant ? { participant } : {}) },
  } as never);
}

/** Ban a participant. **Permanent.** */
export function banParticipant(sock: AnySock, jid: string, participant: string): Promise<unknown> {
  return sock.groupParticipantsUpdate(jid, [participant], 'ban' as never);
}

/** Promote a participant to admin. */
export function promoteParticipant(sock: AnySock, jid: string, participant: string): Promise<unknown> {
  return sock.groupParticipantsUpdate(jid, [participant], 'promote' as never);
}

/** Demote a participant. */
export function demoteParticipant(sock: AnySock, jid: string, participant: string): Promise<unknown> {
  return sock.groupParticipantsUpdate(jid, [participant], 'demote' as never);
}

/** Remove a participant from a group. */
export function removeParticipant(sock: AnySock, jid: string, participant: string): Promise<unknown> {
  return sock.groupParticipantsUpdate(jid, [participant], 'remove' as never);
}

/**
 * Guard for irreversible moderation.
 *
 * Returns false rather than acting, so a caller looping over a roster cannot
 * ban a batch by accident.
 */
export async function confirmDestructive(
  sock: AnySock,
  jid: string,
  action: ModerationAction,
  target: string,
  actor: string,
  confirmed: boolean,
): Promise<boolean> {
  const irreversible = action === 'ban' || action === 'remove' || action === 'delete';
  if (irreversible && !confirmed) return false;
  await moderate(sock, jid, action, target, actor);
  return true;
}