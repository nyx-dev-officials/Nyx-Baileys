/**
 * OPS-50 · module 4 of 6 — contacts, profiles, calls.
 *
 * rc14 methods used, verified in `business.d.ts`:
 * `onWhatsApp`, `addOrEditContact`, `removeContact`, `addOrEditQuickReply`,
 * `removeQuickReply`, `updateProfileName`, `updateProfileStatus`,
 * `updateProfilePicture`, `removeProfilePicture`, `profilePictureUrl`,
 * `updateBussinesProfile`, `removeCoverPhoto`, `updateCoverPhoto`,
 * `createCallLink`, `rejectCall`, `fetchStatus`, `executeUSyncQuery`.
 *
 * **Known live limitation:** `updateProfileStatus` transmits but the linked
 * consumer device cannot set About. Expect a clean return and no change.
 * Every other function here is `unverified`.
 */

import type { AnySock } from './types.js';

export interface OnWhatsAppResult {
  exists: boolean;
  jid?: string;
}

/* ── 51-55 · contact resolution ───────────────────────────────────── */

/**
 * Resolve a phone number to a WhatsApp jid.
 *
 * rc14 wants digits only — no `+`, no spaces, no dashes. Stripping them here
 * means callers can pass whatever a human typed.
 */
export async function resolveNumber(
  sock: AnySock,
  input: string,
): Promise<OnWhatsAppResult> {
  const digits = String(input).replace(/\D/g, '');
  if (!digits) return { exists: false };

  const results = (await sock.onWhatsApp(digits)) as
    | Array<{ exists?: boolean; jid?: string }>
    | undefined;

  const hit = results?.find((r) => r.exists && r.jid);
  return hit ? { exists: true, jid: hit.jid } : { exists: false };
}

/** Add or overwrite a contact. */
export function saveContact(
  sock: AnySock,
  jid: string,
  name: string,
  phone?: string,
): Promise<void> {
  return sock.addOrEditContact(jid, { name, lid: undefined, phoneNumber: phone });
}

/** Delete a contact. */
export function deleteContact(sock: AnySock, jid: string): Promise<void> {
  return sock.removeContact(jid);
}

/** Store a reusable quick-reply snippet. */
export function saveQuickReply(
  sock: AnySock,
  label: string,
  text: string,
): Promise<void> {
  return sock.addOrEditQuickReply(label, text);
}

/** Delete a quick-reply snippet. */
export function deleteQuickReply(sock: AnySock, label: string): Promise<void> {
  return sock.removeQuickReply(label);
}

/* ── 56-58 · profile ──────────────────────────────────────────────── */

/** Set the display name. Verified working. */
export function setDisplayName(sock: AnySock, name: string): Promise<void> {
  return sock.updateProfileName(name);
}

/**
 * Set the About text.
 *
 * **Known broken on this account.** The stanza transmits and the call resolves,
 * but the linked consumer session does not apply it. Treat as best-effort and
 * verify by reading it back before reporting success.
 */
export function setAbout(sock: AnySock, status: string): Promise<void> {
  return sock.updateProfileStatus(status);
}

/** Set the profile picture from an already-uploaded media handle. */
export function setProfilePicture(sock: AnySock, upload: unknown): Promise<void> {
  return sock.updateProfilePicture(upload as never);
}

/** Remove the profile picture. */
export function clearProfilePicture(sock: AnySock): Promise<void> {
  return sock.removeProfilePicture(sock.user?.id);
}

/* ── 59-60 · calls ────────────────────────────────────────────────── */

/** Create a click-to-call link. */
export function createCallLink(sock: AnySock, jid: string, text: string): Promise<unknown> {
  return sock.createCallLink(jid, text);
}

/** Reject an incoming call. */
export function rejectCall(sock: AnySock, callId: string, callCreator: string): Promise<void> {
  return sock.rejectCall(callId, callCreator);
}

/* ── helpers ──────────────────────────────────────────────────────── */

/** Build a vCard for a contact, valid enough for rc14 to render. */
export function buildVCard(name: string, phone?: string): string {
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${name}`];
  if (phone) {
    const digits = phone.replace(/\D/g, '');
    lines.push(`TEL;type=CELL;waid=${digits}:${phone}`);
  }
  lines.push('END:VCARD');
  return lines.join('\n');
}

/** Resolve a status/story id from a `status@broadcast` message key. */
export function statusKey(participant: string, id: string): { remoteJid: string; id: string } {
  return { remoteJid: 'status@broadcast', id: `${participant.split(':')[0]}_${id}` };
}