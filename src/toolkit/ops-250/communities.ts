/**
 * OPS-250 · communities.
 *
 * WhatsApp Communities are the group-adjacent surface with their own namespace.
 * rc14 exposes a full parallel method set — every `group*` call has a
 * `community*` twin — in `communities.d.ts`.
 *
 * Methods used: `communityMetadata`, `communityCreate`, `communityCreateGroup`,
 * `communityLeave`, `communityUpdateSubject`, `communityUpdateDescription`,
 * `communityLinkGroup`, `communityUnlinkGroup`, `communityFetchLinkedGroups`,
 * `communityRequestParticipantsList`, `communityRequestParticipantsUpdate`,
 * `communityParticipantsUpdate`, `communityInviteCode`, `communityRevokeInvite`,
 * `communityAcceptInvite`, `communityGetInviteInfo`, `communityToggleEphemeral`,
 * `communitySettingUpdate`, `communityMemberAddMode`, `communityJoinApprovalMode`,
 * `communityFetchAllParticipating`.
 *
 * **Unverified on hardware.** Communities are gated on account rollout; a call
 * may return cleanly and still be refused. Nothing here has run.
 */

import { assertGroupJid, type AnySock } from '../ops-50/types.js';

/* ── 17-24 · community lifecycle ─────────────────────────────────── */

/** Fetch community metadata. */
export function communityMeta(sock: AnySock, jid: string): Promise<unknown> {
  return sock.communityMetadata(jid);
}

/** Create a community. */
export function createCommunity(sock: AnySock, subject: string): Promise<unknown> {
  return sock.communityCreate(subject);
}

/** Leave a community. */
export function leaveCommunity(sock: AnySock, jid: string): Promise<unknown> {
  return sock.communityLeave(jid);
}

/** Rename a community. */
export function renameCommunity(sock: AnySock, jid: string, subject: string): Promise<unknown> {
  return sock.communityUpdateSubject(jid, subject);
}

/** Set a community's description. */
export function describeCommunity(sock: AnySock, jid: string, description: string): Promise<unknown> {
  return sock.communityUpdateDescription(jid, description);
}

/** Link a group into a community. */
export function linkGroup(sock: AnySock, communityJid: string, groupJid: string): Promise<unknown> {
  assertGroupJid(groupJid);
  return sock.communityLinkGroup(communityJid, groupJid);
}

/** Unlink a group from a community. */
export function unlinkGroup(sock: AnySock, communityJid: string, groupJid: string): Promise<unknown> {
  return sock.communityUnlinkGroup(communityJid, groupJid);
}

/** List every group linked to a community. */
export function linkedGroups(sock: AnySock, communityJid: string): Promise<unknown> {
  return sock.communityFetchLinkedGroups(communityJid);
}

/* ── 25-30 · community membership ────────────────────────────────── */

/** Fetch a community's membership list. */
export function communityMembers(sock: AnySock, jid: string): Promise<unknown> {
  return sock.communityRequestParticipantsList(jid);
}

/** Add members to a community. */
export function addCommunityMembers(
  sock: AnySock,
  jid: string,
  participants: string[],
): Promise<unknown> {
  return sock.communityRequestParticipantsUpdate(jid, participants, 'add');
}

/** Remove members from a community. */
export function removeCommunityMembers(
  sock: AnySock,
  jid: string,
  participants: string[],
): Promise<unknown> {
  return sock.communityRequestParticipantsUpdate(jid, participants, 'remove');
}

/** Promote members. Carries the rank exactly as the group twin does. */
export function promoteCommunityMembers(
  sock: AnySock,
  jid: string,
  participants: string[],
  rank: 'admin' | 'superadmin' = 'admin',
): Promise<unknown> {
  return sock.communityRequestParticipantsUpdate(jid, participants, 'promote', rank);
}

/** Demote members. */
export function demoteCommunityMembers(
  sock: AnySock,
  jid: string,
  participants: string[],
): Promise<unknown> {
  return sock.communityRequestParticipantsUpdate(jid, participants, 'demote');
}

/** Every community this account participates in. */
export function allCommunities(sock: AnySock): Promise<unknown> {
  return sock.communityFetchAllParticipating();
}

/* ── 31-40 · community policy ────────────────────────────────────── */

/** Fetch a community's invite code. */
export function communityInvite(sock: AnySock, jid: string): Promise<string> {
  return sock.communityInviteCode(jid);
}

/** Revoke a community's invite code. */
export function revokeCommunityInvite(sock: AnySock, jid: string): Promise<unknown> {
  return sock.communityRevokeInvite(jid);
}

/** Accept a community invite. */
export function acceptCommunityInvite(sock: AnySock, invite: string): Promise<unknown> {
  return sock.communityAcceptInvite(invite);
}

/** Inspect a community invite before accepting it. */
export function communityInviteInfo(sock: AnySock, invite: string): Promise<unknown> {
  return sock.communityGetInviteInfo(invite);
}

/** Toggle community ephemeral duration. */
export function setCommunityEphemeral(sock: AnySock, jid: string, seconds: number): Promise<unknown> {
  return sock.communityToggleEphemeral(jid, seconds);
}

/** Set a community setting verb. */
export function setCommunitySetting(
  sock: AnySock,
  jid: string,
  setting: 'announce' | 'notAnnounce' | 'restrict' | 'notRestrict',
): Promise<unknown> {
  return sock.communitySettingUpdate(jid, setting);
}

/** Allow or block members adding others. */
export function setCommunityMemberAdd(sock: AnySock, jid: string, on: boolean): Promise<unknown> {
  return sock.communityMemberAddMode(jid, on ? 'on' : 'off');
}

/** Require approval to join. */
export function setCommunityJoinApproval(sock: AnySock, jid: string, on: boolean): Promise<unknown> {
  return sock.communityJoinApprovalMode(jid, on ? 'on' : 'off');
}

/** Read a community's effective policy from live metadata. */
export async function readCommunityPolicy(sock: AnySock, jid: string): Promise<Record<string, unknown>> {
  const meta = (await sock.communityMetadata(jid)) as Record<string, any>;
  return {
    announce: meta.announce === true,
    restrict: meta.restrict === true,
    memberAddMode: meta.memberAddMode !== false,
    joinApprovalMode: meta.joinApprovalMode === true,
    ephemeral: meta.ephemeralDuration ?? 0,
    size: meta.size,
  };
}

/**
 * Is this jid a community?
 *
 * rc14 marks communities in metadata rather than by jid suffix, so this needs a
 * live read. Callers that need a cheap check should look for the explicit
 * `.community` suffix and treat a miss as unknown rather than false.
 */
export async function isCommunity(sock: AnySock, jid: string): Promise<boolean> {
  try {
    const meta = (await sock.communityMetadata(jid)) as Record<string, any>;
    return meta?.isCommunity === true;
  } catch {
    return false;
  }
}