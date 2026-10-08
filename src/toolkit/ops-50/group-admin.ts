/**
 * OPS-50 · module 2 of 6 — group administration.
 *
 * rc14 methods used, all verified present in `groups.d.ts`:
 * `groupRequestParticipantsUpdate`, `groupParticipantsUpdate`,
 * `groupUpdateSubject`, `groupUpdateDescription`, `groupSettingUpdate`,
 * `groupJoinApprovalMode`, `groupMemberAddMode`, `groupToggleEphemeral`,
 * `groupInviteCode`, `groupRevokeInvite`, `groupAcceptInvite`, `groupMetadata`.
 *
 * `ParticipantAction` is the upstream union: `'add' | 'remove' | 'promote' |
 * 'demote' | 'modify'`. Anything outside that is not sent.
 */

import type { AnySock, ParticipantAction } from './types.js';

/** The membership verbs this module will route. */
const ACTIONS: readonly ParticipantAction[] = ['add', 'remove', 'promote', 'demote', 'modify'];

/** The admin/superadmin values rc14's promote and demote accept. */
export type AdminRank = 'admin' | 'superadmin';

/** Group settings rc14 exposes as settable booleans. */
export type GroupSetting =
  | 'announce'
  | 'isAnnounce'
  | 'memberAddMode'
  | 'joinApprovalMode'
  | 'isCommunityAnnounce';

export interface GroupPolicy {
  /** Only admins may post. */
  announce: boolean;
  /** Only admins may change settings. */
  restrict: boolean;
  /** Members may add others. */
  memberAddMode: boolean;
  /** Join requests need approval. */
  joinApprovalMode: boolean;
  /** Auto-remove inactive members. */
  ephemeral: number;
}

export const DEFAULT_GROUP_POLICY: GroupPolicy = {
  announce: false,
  restrict: false,
  memberAddMode: true,
  joinApprovalMode: false,
  ephemeral: 0,
};

/* ── 25-29 · membership ───────────────────────────────────────────── */

/** Add participants to a group. Returns the raw per-participant response. */
export function addParticipants(sock: AnySock, jid: string, participants: string[]): Promise<unknown> {
  return sock.groupRequestParticipantsUpdate(jid, participants, 'add');
}

/** Remove participants from a group. */
export function removeParticipants(sock: AnySock, jid: string, participants: string[]): Promise<unknown> {
  return sock.groupRequestParticipantsUpdate(jid, participants, 'remove');
}

/** Promote participants to admin or superadmin. */
export function promoteParticipants(
  sock: AnySock,
  jid: string,
  participants: string[],
  rank: AdminRank = 'admin',
): Promise<unknown> {
  return sock.groupRequestParticipantsUpdate(jid, participants, 'promote', rank);
}

/** Demote participants back to member. */
export function demoteParticipants(sock: AnySock, jid: string, participants: string[]): Promise<unknown> {
  return sock.groupRequestParticipantsUpdate(jid, participants, 'demote');
}

/** Route one membership change by action name, rejecting unknown verbs. */
export async function participantAction(
  sock: AnySock,
  jid: string,
  action: ParticipantAction,
  participants: string[],
  rank?: AdminRank,
): Promise<unknown> {
  if (!ACTIONS.includes(action)) {
    throw new Error(`unknown participant action: ${action}`);
  }
  return sock.groupRequestParticipantsUpdate(
    jid,
    participants,
    action,
    ...(rank ? [rank] : []),
  );
}

/* ── 30-33 · identity and policy ─────────────────────────────────── */

/** Rename a group. */
export function renameGroup(sock: AnySock, jid: string, subject: string): Promise<void> {
  return sock.groupUpdateSubject(jid, subject);
}

/** Set a group's description. */
export function describeGroup(sock: AnySock, jid: string, description: string): Promise<void> {
  return sock.groupUpdateDescription(jid, description);
}

/**
 * Apply a policy patch, reading current state first so unchanged flags are not
 * re-sent — a redundant `groupSettingUpdate` can still trigger a settings delta
 * for every member.
 */
export async function applyGroupPolicy(
  sock: AnySock,
  jid: string,
  patch: Partial<GroupPolicy>,
): Promise<string[]> {
  const meta = await sock.groupMetadata(jid);
  const current: GroupPolicy = {
    announce: meta.announce === true,
    restrict: meta.restrict === true,
    memberAddMode: meta.memberAddMode !== false,
    joinApprovalMode: meta.joinApprovalMode === true,
    ephemeral: meta.ephemeralDuration ?? 0,
  };

  const changed: string[] = [];

  if (patch.announce !== undefined && patch.announce !== current.announce) {
    await sock.groupSettingUpdate(jid, patch.announce ? 'announce' : 'notAnnounce');
    changed.push('announce');
  }

  if (patch.restrict !== undefined && patch.restrict !== current.restrict) {
    await sock.groupSettingUpdate(jid, patch.restrict ? 'restrict' : 'notRestrict');
    changed.push('restrict');
  }

  if (patch.memberAddMode !== undefined && patch.memberAddMode !== current.memberAddMode) {
    await sock.groupMemberAddMode(jid, patch.memberAddMode ? 'on' : 'off');
    changed.push('memberAddMode');
  }

  if (patch.joinApprovalMode !== undefined && patch.joinApprovalMode !== current.joinApprovalMode) {
    await sock.groupJoinApprovalMode(jid, patch.joinApprovalMode ? 'on' : 'off');
    changed.push('joinApprovalMode');
  }

  if (patch.ephemeral !== undefined && patch.ephemeral !== current.ephemeral) {
    await sock.groupToggleEphemeral(jid, patch.ephemeral);
    changed.push('ephemeral');
  }

  return changed;
}

/** Read a group's effective policy. */
export async function readGroupPolicy(sock: AnySock, jid: string): Promise<GroupPolicy> {
  const meta = await sock.groupMetadata(jid);
  return {
    announce: meta.announce === true,
    restrict: meta.restrict === true,
    memberAddMode: meta.memberAddMode !== false,
    joinApprovalMode: meta.joinApprovalMode === true,
    ephemeral: meta.ephemeralDuration ?? 0,
  };
}

/* ── 34-37 · invites and roster ───────────────────────────────────── */

/** Fetch or refresh a group's invite code. */
export function groupInviteCode(sock: AnySock, jid: string): Promise<string> {
  return sock.groupInviteCode(jid);
}

/** Revoke and reissue the invite code, invalidating the old link. */
export function revokeGroupInvite(sock: AnySock, jid: string): Promise<void> {
  return sock.groupRevokeInvite(jid);
}

/** List admin jids from live metadata. */
export async function listAdmins(sock: AnySock, jid: string): Promise<string[]> {
  const meta = await sock.groupMetadata(jid);
  return (meta.participants ?? [])
    .filter((p: { isAdmin?: boolean; admin?: string | null }) =>
      p.isAdmin === true || (typeof p.admin === 'string' && p.admin.length > 0))
    .map((p: { id: string }) => p.id);
}

/** Split a roster into admins and members. */
export async function splitRoster(
  sock: AnySock,
  jid: string,
): Promise<{ admins: string[]; members: string[] }> {
  const meta = await sock.groupMetadata(jid);
  const admins: string[] = [];
  const members: string[] = [];

  for (const p of meta.participants ?? []) {
    const isAdmin = p.isAdmin === true || (typeof p.admin === 'string' && p.admin.length > 0);
    (isAdmin ? admins : members).push(p.id);
  }

  return { admins, members };
}

/* ── 38-40 · safety limits ────────────────────────────────────────── */

/** Guard: refuse to remove more participants than this in one call. */
export const REMOVE_BATCH_LIMIT = 50;

/**
 * Remove participants with a hard batch cap.
 *
 * Removing is irreversible and a malformed roster can empty a group in one
 * call, so this refuses to act above the cap rather than chunking silently.
 */
export async function removeParticipantsCapped(
  sock: AnySock,
  jid: string,
  participants: string[],
  limit = REMOVE_BATCH_LIMIT,
): Promise<{ removed: string[]; refused: string[] }> {
  if (participants.length > limit) {
    return { removed: [], refused: participants };
  }
  await removeParticipants(sock, jid, participants);
  return { removed: participants, refused: [] };
}
