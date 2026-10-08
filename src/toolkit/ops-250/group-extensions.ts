/**
 * OPS-250 · group extensions.
 *
 * The complements to `ops-50/group-admin.ts`: the v4 invite flow, roster
 * pagination, leaving, cover photos, and the business-profile surface.
 *
 * Methods used, from `business.d.ts`: `groupRevokeInviteV4`,
 * `groupAcceptInviteV4`, `groupGetInviteInfo`, `groupAcceptInvite`,
 * `groupRequestParticipantsList`, `groupFetchAllParticipating`, `groupLeave`,
 * `groupCreate`, `updateCoverPhoto`, `removeCoverPhoto`, `updateBussinesProfile`,
 * `groupParticipantsUpdate`.
 *
 * **Unverified on hardware.** Nothing here has been run.
 */

import { assertGroupJid, type AnySock } from '../ops-50/types.js';



/* ── 61-70 · invites (v4 flow) ───────────────────────────────────── */

/**
 * Fetch an invite's metadata before joining.
 *
 * Inspecting before accepting is the only way to know what you are joining.
 */
export function inspectInvite(sock: AnySock, invite: string): Promise<unknown> {
  return sock.groupGetInviteInfo(invite);
}

/** Accept an invite using the v4 flow. */
export function acceptInviteV4(sock: AnySock, key: string): Promise<unknown> {
  return sock.groupAcceptInviteV4(key);
}

/** Revoke the invite code using the v4 flow. */
export function revokeInviteV4(sock: AnySock, groupJid: string): Promise<unknown> {
  assertGroupJid(groupJid);
  return sock.groupRevokeInviteV4(groupJid);
}

/** Accept an invite using the legacy flow. */
export function acceptInviteLegacy(sock: AnySock, invite: string): Promise<unknown> {
  return sock.groupAcceptInvite(invite);
}

/**
 * Inspect, then accept — refusing to join a group whose invite does not resolve.
 *
 * Returns what it accepted, so the caller can see the subject it joined.
 */
export async function joinByInvite(
  sock: AnySock,
  invite: string,
): Promise<{ info: unknown; result: unknown }> {
  const info = await inspectInvite(sock, invite);
  if (!info) throw new Error(`invite did not resolve: ${invite}`);
  const result = await acceptInviteV4(sock, invite);
  return { info, result };
}

/** Pull the invite code out of a `chat.whatsapp.com` link. */
export function inviteCodeFromLink(link: string): string | null {
  const match = /chat\.whatsapp\.com\/([A-Za-z0-9]+)/.exec(String(link));
  return match?.[1] ?? null;
}

/** Build a shareable invite link from a code. */
export function inviteLink(code: string): string {
  return `https://chat.whatsapp.com/${code}`;
}

/* ── 71-80 · roster and lifecycle ────────────────────────────────── */

/** Fetch a page of a group's roster. */
export function memberPage(
  sock: AnySock,
  jid: string,
  limit = 100,
  cursor?: string,
): Promise<unknown> {
  return sock.groupRequestParticipantsList(jid, limit, cursor);
}

/**
 * Page through a whole roster.
 *
 * Groups cap a single roster request, so a large group needs successive pages.
 * Stops on an empty page rather than looping forever if the cursor repeats.
 */
export async function fullRoster(
  sock: AnySock,
  jid: string,
  limit = 100,
): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | undefined;
  let previous: string | undefined;

  for (;;) {
    const page = (await sock.groupRequestParticipantsList(jid, limit, cursor)) as any[];
    const fresh = (page ?? []).filter((p) => p?.id);
    if (fresh.length === 0) break;
    out.push(...fresh);

    const next = fresh[fresh.length - 1]?.paginationCursors?.after;
    // A repeated cursor means the server is not advancing. Stop rather than
    // appending the same page forever — a roster that grows on every iteration
    // is how this turns into an infinite loop in a long-lived bot.
    if (!next || next === previous) break;
    previous = next;
    cursor = next;
  }

  // Dedupe: a repeated page can contribute the same jid twice before the guard
  // trips, and a caller counting the roster should not have to know that.
  const seen = new Set<string>();
  return out.filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
}

/** Every group this account participates in. */
export function allGroups(sock: AnySock): Promise<unknown> {
  return sock.groupFetchAllParticipating();
}

/** Leave a group. Irreversible from this account's side. */
export function leaveGroup(sock: AnySock, jid: string): Promise<void> {
  assertGroupJid(jid);
  return sock.groupLeave(jid);
}

/** Create a group. */
export function createGroup(sock: AnySock, subject: string, participants: string[]): Promise<unknown> {
  return sock.groupCreate(subject, participants);
}

/**
 * Count admins, optionally by rank.
 *
 * Reads live metadata rather than a cached roster, so it reflects a promotion
 * that has not been pushed to this device yet.
 */
export async function countAdmins(
  sock: AnySock,
  jid: string,
  rank?: 'admin' | 'superadmin',
): Promise<number> {
  const meta = (await sock.groupMetadata(jid)) as {
    participants?: Array<{ isAdmin?: boolean; admin?: string | null }>;
  };
  return (meta.participants ?? []).filter((p) => {
    if (rank === undefined) return p.isAdmin === true || (typeof p.admin === 'string' && p.admin.length > 0);
    return p.admin === rank;
  }).length;
}

/** Group size, from live metadata. */
export async function groupSize(sock: AnySock, jid: string): Promise<number> {
  const meta = (await sock.groupMetadata(jid)) as { size?: number; participants?: unknown[] };
  return meta.size ?? (meta.participants ?? []).length;
}

/** Is this account an admin of the group? */
export async function amAdmin(sock: AnySock, jid: string): Promise<boolean> {
  const meta = (await sock.groupMetadata(jid)) as {
    participants?: Array<{ id: string; isAdmin?: boolean; admin?: string | null }>;
  };
  const me = sock.user?.id?.split(':')[0];
  const row = (meta.participants ?? []).find((p) => p.id?.split(':')[0] === me);
  return row?.isAdmin === true || (typeof row?.admin === 'string' && row.admin.length > 0);
}

/* ── 81-90 · cover photos and business profile ───────────────────── */

/** Set a group's cover photo. Pass an uploaded media handle. */
export function setCoverPhoto(sock: AnySock, jid: string, upload: unknown): Promise<unknown> {
  assertGroupJid(jid);
  return sock.updateCoverPhoto(jid, upload as never);
}

/** Remove a group's cover photo. */
export function clearCoverPhoto(sock: AnySock, jid: string): Promise<unknown> {
  assertGroupJid(jid);
  return sock.removeCoverPhoto(jid);
}

/**
 * Update the business profile.
 *
 * Consumer accounts cannot set most of these fields; the call transmits and the
 * account declines. Read the profile back before reporting success.
 */
export function setBusinessProfile(sock: AnySock, jid: string, args: Record<string, unknown>): Promise<unknown> {
  return sock.updateBussinesProfile(jid, args as never);
}

/** A jid's profile picture URL, or undefined when it has none. */
export async function pictureUrl(sock: AnySock, jid: string): Promise<string | undefined> {
  try {
    return (await sock.profilePictureUrl(jid, 'image')) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Member labels currently set on a group. */
export async function memberLabels(sock: AnySock, jid: string): Promise<Record<string, string>> {
  const meta = (await sock.groupMetadata(jid)) as {
    participants?: Array<{ id: string; memberLabel?: string }>;
  };
  const out: Record<string, string> = {};
  for (const p of meta.participants ?? []) {
    if (p.memberLabel) out[p.id] = p.memberLabel;
  }
  return out;
}