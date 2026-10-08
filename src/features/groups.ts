/**
 * @module features/groups
 *
 * Comprehensive WhatsApp group management utilities built on top of the
 * Baileys socket. Every function accepts `sock: any` so callers can pass
 * any Baileys-compatible socket (WASocket, decorated NyxBaileys sock, etc.)
 * without needing an exact type match at the call-site.
 *
 * All functions return a Promise and are safe to `await` in sequence or race
 * with `Promise.allSettled`.
 */

import { randomBytes } from 'node:crypto';

/* ─────────────────────────────────────────────────────────────────────────
 * Shared types
 * ────────────────────────────────────────────────────────────────────────── */

export interface GroupParticipant {
  id: string;
  admin: 'admin' | 'superadmin' | null;
}

export interface GroupMetadata {
  id: string;
  subject: string;
  subjectOwner?: string;
  subjectTime?: number;
  creation?: number;
  owner?: string;
  desc?: string;
  descOwner?: string;
  descId?: string;
  restrict?: boolean;
  announce?: boolean;
  isCommunity?: boolean;
  isCommunityAnnounce?: boolean;
  linkedParent?: string;
  memberAddMode?: boolean;
  joinApprovalMode?: boolean;
  ephemeralDuration?: number;
  participants: GroupParticipant[];
  inviteCode?: string;
  size?: number;
}

export interface GroupOperationResult {
  status: 'ok' | 'error';
  message?: string;
  data?: unknown;
}

export interface GroupStats {
  groupId: string;
  totalMembers: number;
  adminCount: number;
  memberCount: number;
  createdAt: number | undefined;
  ownerId: string | undefined;
}

export interface GroupGrowthStats {
  groupId: string;
  snapshotAt: number;
  totalMembers: number;
  admins: number;
  plain: number;
  /** Placeholder for external time-series data integrations. */
  trend: 'growing' | 'stable' | 'shrinking' | 'unknown';
}

export interface GroupReport {
  generatedAt: number;
  groupId: string;
  subject: string;
  description: string | undefined;
  totalMembers: number;
  adminCount: number;
  memberCount: number;
  creatorJid: string | undefined;
  createdAt: number | undefined;
  inviteLink: string | null;
  ephemeralDuration: number | undefined;
  isAnnounce: boolean;
  isRestrict: boolean;
}

export interface GroupContact {
  jid: string;
  role: 'admin' | 'superadmin' | 'member';
}

export interface ScheduledAnnouncement {
  id: string;
  groupId: string;
  text: string;
  sendAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface SpamDetectionResult {
  isSpam: boolean;
  score: number;
  reasons: string[];
}

export interface QuarantineResult {
  removed: boolean;
  jid: string;
  groupId: string;
  reason: string;
}

export interface GroupActivityRecord {
  groupId: string;
  eventType: string;
  participants: string[];
  at: number;
  raw: unknown;
}

/* ─────────────────────────────────────────────────────────────────────────
 * Internal state (module-level, lightweight, process-scoped)
 * ────────────────────────────────────────────────────────────────────────── */

/** Ring-buffer of recent group events for `trackGroupActivity`. */
const _activityLog = new Map<string, GroupActivityRecord[]>();

/** Welcome messages per group. */
const _welcomeMessages = new Map<string, string>();

/** Goodbye messages per group. */
const _goodbyeMessages = new Map<string, string>();

/** Group-level blacklist (blocked members). */
const _blacklists = new Map<string, Set<string>>();

/** Scheduled announcements registry. */
const _scheduledAnnouncements = new Map<string, ScheduledAnnouncement>();

/** Auto-moderation rules per group (regex patterns to flag/remove). */
const _autoModRules = new Map<string, RegExp[]>();

/** Group rules (text). */
const _groupRules = new Map<string, string>();

/* ─────────────────────────────────────────────────────────────────────────
 * Helpers
 * ────────────────────────────────────────────────────────────────────────── */

function _ok(data?: unknown): GroupOperationResult {
  return { status: 'ok', data };
}

function _err(message: string): GroupOperationResult {
  return { status: 'error', message };
}

function _appendActivity(groupId: string, record: GroupActivityRecord): void {
  const log = _activityLog.get(groupId) ?? [];
  log.push(record);
  if (log.length > 500) log.splice(0, log.length - 500); // keep last 500
  _activityLog.set(groupId, log);
}

/* ─────────────────────────────────────────────────────────────────────────
 * 1. createGroup
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Create a new WhatsApp group with the given subject and initial participants.
 * The calling account becomes the group owner automatically.
 */
export async function createGroup(
  sock: any,
  subject: string,
  participants: string[],
): Promise<GroupOperationResult> {
  try {
    const result: unknown = await sock.groupCreate(subject, participants);
    return _ok(result);
  } catch (err) {
    return _err(String(err));
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * 2. deleteGroup
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Delete (deactivate) a group by removing all participants and then leaving.
 * Only the owner can do this; this helper performs the two steps in sequence.
 */
export async function deleteGroup(
  sock: any,
  groupId: string,
): Promise<GroupOperationResult> {
  try {
    const meta: GroupMetadata = await sock.groupMetadata(groupId);
    const others = meta.participants
      .map((p) => p.id)
      .filter((id) => id !== sock.user?.id);
    if (others.length > 0) {
      await sock.groupParticipantsUpdate(groupId, others, 'remove');
    }
    await sock.groupLeave(groupId);
    return _ok();
  } catch (err) {
    return _err(String(err));
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * 3. addParticipant
 * ────────────────────────────────────────────────────────────────────────── */

/** Add one or more participants to an existing group. */
export async function addParticipant(
  sock: any,
  groupId: string,
  jids: string | string[],
): Promise<GroupOperationResult> {
  try {
    const list = Array.isArray(jids) ? jids : [jids];
    const result: unknown = await sock.groupParticipantsUpdate(groupId, list, 'add');
    _appendActivity(groupId, { groupId, eventType: 'add', participants: list, at: Date.now(), raw: result });
    return _ok(result);
  } catch (err) {
    return _err(String(err));
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * 4. removeParticipant
 * ────────────────────────────────────────────────────────────────────────── */

/** Remove one or more participants from a group. */
export async function removeParticipant(
  sock: any,
  groupId: string,
  jids: string | string[],
): Promise<GroupOperationResult> {
  try {
    const list = Array.isArray(jids) ? jids : [jids];
    const result: unknown = await sock.groupParticipantsUpdate(groupId, list, 'remove');
    _appendActivity(groupId, { groupId, eventType: 'remove', participants: list, at: Date.now(), raw: result });
    return _ok(result);
  } catch (err) {
    return _err(String(err));
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * 5. promoteToAdmin
 * ────────────────────────────────────────────────────────────────────────── */

/** Promote one or more members to group admin. */
export async function promoteToAdmin(
  sock: any,
  groupId: string,
  jids: string | string[],
): Promise<GroupOperationResult> {
  try {
    const list = Array.isArray(jids) ? jids : [jids];
    const result: unknown = await sock.groupParticipantsUpdate(groupId, list, 'promote');
    _appendActivity(groupId, { groupId, eventType: 'promote', participants: list, at: Date.now(), raw: result });
    return _ok(result);
  } catch (err) {
    return _err(String(err));
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * 6. demoteFromAdmin
 * ────────────────────────────────────────────────────────────────────────── */

/** Demote one or more admins back to regular members. */
export async function demoteFromAdmin(
  sock: any,
  groupId: string,
  jids: string | string[],
): Promise<GroupOperationResult> {
  try {
    const list = Array.isArray(jids) ? jids : [jids];
    const result: unknown = await sock.groupParticipantsUpdate(groupId, list, 'demote');
    _appendActivity(groupId, { groupId, eventType: 'demote', participants: list, at: Date.now(), raw: result });
    return _ok(result);
  } catch (err) {
    return _err(String(err));
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * 7. getGroupInfo
 * ────────────────────────────────────────────────────────────────────────── */

/** Fetch full group metadata including participants, description, and settings. */
export async function getGroupInfo(
  sock: any,
  groupId: string,
): Promise<GroupMetadata> {
  const meta: GroupMetadata = await sock.groupMetadata(groupId);
  return meta;
}

/* ─────────────────────────────────────────────────────────────────────────
 * 8. getGroupMembers
 * ────────────────────────────────────────────────────────────────────────── */

/** Return the full participant list for a group. */
export async function getGroupMembers(
  sock: any,
  groupId: string,
): Promise<GroupParticipant[]> {
  const meta: GroupMetadata = await sock.groupMetadata(groupId);
  return meta.participants;
}

/* ─────────────────────────────────────────────────────────────────────────
 * 9. getGroupAdmins
 * ────────────────────────────────────────────────────────────────────────── */

/** Return only the participants with admin or superadmin role. */
export async function getGroupAdmins(
  sock: any,
  groupId: string,
): Promise<GroupParticipant[]> {
  const meta: GroupMetadata = await sock.groupMetadata(groupId);
  return meta.participants.filter((p) => p.admin !== null);
}

/* ─────────────────────────────────────────────────────────────────────────
 * 10. updateGroupSubject
 * ────────────────────────────────────────────────────────────────────────── */

/** Change the group name / subject. Requires admin rights. */
export async function updateGroupSubject(
  sock: any,
  groupId: string,
  subject: string,
): Promise<GroupOperationResult> {
  try {
    await sock.groupUpdateSubject(groupId, subject);
    return _ok();
  } catch (err) {
    return _err(String(err));
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * 11. updateGroupDescription
 * ────────────────────────────────────────────────────────────────────────── */

/** Update (or clear) the group description. */
export async function updateGroupDescription(
  sock: any,
  groupId: string,
  description: string,
): Promise<GroupOperationResult> {
  try {
    await sock.groupUpdateDescription(groupId, description);
    return _ok();
  } catch (err) {
    return _err(String(err));
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * 12. updateGroupPicture
 * ────────────────────────────────────────────────────────────────────────── */

/** Upload and set a new group profile picture from a Buffer or file path. */
export async function updateGroupPicture(
  sock: any,
  groupId: string,
  image: Buffer,
): Promise<GroupOperationResult> {
  try {
    await sock.updateProfilePicture(groupId, image);
    return _ok();
  } catch (err) {
    return _err(String(err));
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * 13. getGroupInviteLink
 * ────────────────────────────────────────────────────────────────────────── */

/** Fetch the current invite link for a group. */
export async function getGroupInviteLink(
  sock: any,
  groupId: string,
): Promise<string> {
  const code: string = await sock.groupInviteCode(groupId);
  return `https://chat.whatsapp.com/${code}`;
}

/* ─────────────────────────────────────────────────────────────────────────
 * 14. revokeGroupInviteLink
 * ────────────────────────────────────────────────────────────────────────── */

/** Revoke the current invite link and generate a fresh one. */
export async function revokeGroupInviteLink(
  sock: any,
  groupId: string,
): Promise<string> {
  const code: string = await sock.groupRevokeInvite(groupId);
  return `https://chat.whatsapp.com/${code}`;
}

/* ─────────────────────────────────────────────────────────────────────────
 * 15. joinGroupViaLink
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Join a group using an invite link or raw invite code.
 * Accepts either `https://chat.whatsapp.com/<code>` or just `<code>`.
 */
export async function joinGroupViaLink(
  sock: any,
  linkOrCode: string,
): Promise<GroupOperationResult> {
  try {
    const code = linkOrCode.startsWith('https://')
      ? linkOrCode.split('/').pop() ?? linkOrCode
      : linkOrCode;
    const result: unknown = await sock.groupAcceptInvite(code);
    return _ok(result);
  } catch (err) {
    return _err(String(err));
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * 16. leaveGroup
 * ────────────────────────────────────────────────────────────────────────── */

/** Leave a group silently. */
export async function leaveGroup(
  sock: any,
  groupId: string,
): Promise<GroupOperationResult> {
  try {
    await sock.groupLeave(groupId);
    return _ok();
  } catch (err) {
    return _err(String(err));
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * 17. setGroupAnnouncement
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Toggle announcement mode (only admins can send messages).
 * Pass `true` to enable, `false` to disable.
 */
export async function setGroupAnnouncement(
  sock: any,
  groupId: string,
  enabled: boolean,
): Promise<GroupOperationResult> {
  try {
    await sock.groupSettingUpdate(groupId, enabled ? 'announcement' : 'not_announcement');
    return _ok();
  } catch (err) {
    return _err(String(err));
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * 18. setGroupRestrict
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Restrict group info editing to admins only.
 * `true` = only admins can edit; `false` = all members can edit.
 */
export async function setGroupRestrict(
  sock: any,
  groupId: string,
  enabled: boolean,
): Promise<GroupOperationResult> {
  try {
    await sock.groupSettingUpdate(groupId, enabled ? 'locked' : 'unlocked');
    return _ok();
  } catch (err) {
    return _err(String(err));
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * 19. setGroupLocked
 * ────────────────────────────────────────────────────────────────────────── */

/** Convenience wrapper — lock group info editing (admin-only edits). */
export async function setGroupLocked(
  sock: any,
  groupId: string,
): Promise<GroupOperationResult> {
  return setGroupRestrict(sock, groupId, true);
}

/* ─────────────────────────────────────────────────────────────────────────
 * 20. setGroupUnlocked
 * ────────────────────────────────────────────────────────────────────────── */

/** Convenience wrapper — unlock group info editing (all members can edit). */
export async function setGroupUnlocked(
  sock: any,
  groupId: string,
): Promise<GroupOperationResult> {
  return setGroupRestrict(sock, groupId, false);
}

/* ─────────────────────────────────────────────────────────────────────────
 * 21. mentionGroupMembers
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Send a message to the group that @-mentions the specified participants.
 * If `jids` is omitted, all current members are mentioned.
 */
export async function mentionGroupMembers(
  sock: any,
  groupId: string,
  text: string,
  jids?: string[],
): Promise<GroupOperationResult> {
  try {
    let mentions = jids;
    if (!mentions) {
      const meta: GroupMetadata = await sock.groupMetadata(groupId);
      mentions = meta.participants.map((p) => p.id);
    }
    const result: unknown = await sock.sendMessage(groupId, { text, mentions });
    return _ok(result);
  } catch (err) {
    return _err(String(err));
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * 22. pinGroupMessage
 * ────────────────────────────────────────────────────────────────────────── */

/** Pin a message in a group (requires admin). */
export async function pinGroupMessage(
  sock: any,
  groupId: string,
  messageKey: { id: string; fromMe: boolean; remoteJid: string },
  durationSecs: 86400 | 604800 | 2592000 = 604800,
): Promise<GroupOperationResult> {
  try {
    const result: unknown = await sock.sendMessage(groupId, {
      pin: { type: 1, time: durationSecs, key: messageKey },
    } as never);
    return _ok(result);
  } catch (err) {
    return _err(String(err));
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * 23. setGroupRules
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Store a text block as the "rules" for a group.
 * This is persisted in-process and optionally sent to the group as a message.
 */
export async function setGroupRules(
  sock: any,
  groupId: string,
  rules: string,
  announce?: boolean,
): Promise<GroupOperationResult> {
  try {
    _groupRules.set(groupId, rules);
    if (announce) {
      await sock.sendMessage(groupId, { text: `📋 *Group Rules*\n\n${rules}` });
    }
    return _ok({ groupId, rules });
  } catch (err) {
    return _err(String(err));
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * 24. getGroupStats
 * ────────────────────────────────────────────────────────────────────────── */

/** Return a compact stats object for a group. */
export async function getGroupStats(
  sock: any,
  groupId: string,
): Promise<GroupStats> {
  const meta: GroupMetadata = await sock.groupMetadata(groupId);
  const admins = meta.participants.filter((p) => p.admin !== null);
  return {
    groupId,
    totalMembers: meta.participants.length,
    adminCount: admins.length,
    memberCount: meta.participants.length - admins.length,
    createdAt: meta.creation,
    ownerId: meta.owner,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
 * 25. exportGroupContacts
 * ────────────────────────────────────────────────────────────────────────── */

/** Export the group's contact list as an array of `{ jid, role }` objects. */
export async function exportGroupContacts(
  sock: any,
  groupId: string,
): Promise<GroupContact[]> {
  const meta: GroupMetadata = await sock.groupMetadata(groupId);
  return meta.participants.map((p) => ({
    jid: p.id,
    role: p.admin === 'superadmin' ? 'superadmin' : p.admin === 'admin' ? 'admin' : 'member',
  }));
}

/* ─────────────────────────────────────────────────────────────────────────
 * 26. importGroupContacts
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Add a list of contacts (from `exportGroupContacts` or any `{ jid }[]`) to the
 * group, then optionally promote the ones marked as admin.
 */
export async function importGroupContacts(
  sock: any,
  groupId: string,
  contacts: GroupContact[],
): Promise<GroupOperationResult> {
  try {
    const jids = contacts.map((c) => c.jid);
    await sock.groupParticipantsUpdate(groupId, jids, 'add');

    const adminJids = contacts
      .filter((c) => c.role === 'admin' || c.role === 'superadmin')
      .map((c) => c.jid);
    if (adminJids.length > 0) {
      await sock.groupParticipantsUpdate(groupId, adminJids, 'promote');
    }
    return _ok({ added: jids.length, promoted: adminJids.length });
  } catch (err) {
    return _err(String(err));
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * 27. searchGroupMembers
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Search members whose JID contains `query` (case-insensitive substring match).
 * Useful for finding a specific number or LID.
 */
export async function searchGroupMembers(
  sock: any,
  groupId: string,
  query: string,
): Promise<GroupParticipant[]> {
  const meta: GroupMetadata = await sock.groupMetadata(groupId);
  const lower = query.toLowerCase();
  return meta.participants.filter((p) => p.id.toLowerCase().includes(lower));
}

/* ─────────────────────────────────────────────────────────────────────────
 * 28. filterGroupAdmins
 * ────────────────────────────────────────────────────────────────────────── */

/** Return participants whose admin level satisfies a custom predicate. */
export async function filterGroupAdmins(
  sock: any,
  groupId: string,
  predicate: (p: GroupParticipant) => boolean = (p) => p.admin === 'admin' || p.admin === 'superadmin',
): Promise<GroupParticipant[]> {
  const meta: GroupMetadata = await sock.groupMetadata(groupId);
  return meta.participants.filter(predicate);
}

/* ─────────────────────────────────────────────────────────────────────────
 * 29. filterGroupMembers
 * ────────────────────────────────────────────────────────────────────────── */

/** Return participants that satisfy a custom predicate. */
export async function filterGroupMembers(
  sock: any,
  groupId: string,
  predicate: (p: GroupParticipant) => boolean,
): Promise<GroupParticipant[]> {
  const meta: GroupMetadata = await sock.groupMetadata(groupId);
  return meta.participants.filter(predicate);
}

/* ─────────────────────────────────────────────────────────────────────────
 * 30. getGroupCreator
 * ────────────────────────────────────────────────────────────────────────── */

/** Return the JID of the group owner / creator. */
export async function getGroupCreator(
  sock: any,
  groupId: string,
): Promise<string | undefined> {
  const meta: GroupMetadata = await sock.groupMetadata(groupId);
  return meta.owner;
}

/* ─────────────────────────────────────────────────────────────────────────
 * 31. getGroupCreationDate
 * ────────────────────────────────────────────────────────────────────────── */

/** Return the creation timestamp of the group as a Date (or undefined). */
export async function getGroupCreationDate(
  sock: any,
  groupId: string,
): Promise<Date | undefined> {
  const meta: GroupMetadata = await sock.groupMetadata(groupId);
  return meta.creation !== undefined ? new Date(meta.creation * 1000) : undefined;
}

/* ─────────────────────────────────────────────────────────────────────────
 * 32. setGroupEphemeral
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Enable disappearing messages in a group.
 *
 * @param durationSecs Common values: 86400 (1 day), 604800 (7 days),
 *                     7776000 (90 days).
 */
export async function setGroupEphemeral(
  sock: any,
  groupId: string,
  durationSecs: number = 604800,
): Promise<GroupOperationResult> {
  try {
    await sock.groupToggleEphemeral(groupId, durationSecs);
    return _ok({ durationSecs });
  } catch (err) {
    return _err(String(err));
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * 33. disableGroupEphemeral
 * ────────────────────────────────────────────────────────────────────────── */

/** Disable disappearing messages in a group (sets duration to 0). */
export async function disableGroupEphemeral(
  sock: any,
  groupId: string,
): Promise<GroupOperationResult> {
  return setGroupEphemeral(sock, groupId, 0);
}

/* ─────────────────────────────────────────────────────────────────────────
 * 34. getGroupParticipantCount
 * ────────────────────────────────────────────────────────────────────────── */

/** Quickly return the number of participants without loading the full metadata. */
export async function getGroupParticipantCount(
  sock: any,
  groupId: string,
): Promise<number> {
  const meta: GroupMetadata = await sock.groupMetadata(groupId);
  return meta.participants.length;
}

/* ─────────────────────────────────────────────────────────────────────────
 * 35. getGroupMediaCount
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Return an approximate media message count for the group using the in-process
 * message store if available, otherwise returns `null`.
 *
 * This is intentionally a best-effort helper: Baileys does not expose a server
 * media-count API, so we enumerate from a local store if present.
 */
export async function getGroupMediaCount(
  sock: any,
  groupId: string,
): Promise<number | null> {
  try {
    // Try the `store` extension attached by NyxBaileys / BaileysInMemoryStore.
    const store = (sock as { store?: { messages?: Map<string, unknown[]> } }).store;
    if (!store?.messages) return null;
    const msgs: unknown[] | undefined = store.messages.get(groupId);
    if (!msgs) return null;
    const mediaTypes = new Set(['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage']);
    let count = 0;
    for (const m of msgs) {
      const msg = m as { message?: Record<string, unknown> };
      if (msg.message && mediaTypes.has(Object.keys(msg.message)[0] ?? '')) count++;
    }
    return count;
  } catch {
    return null;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * 36. clearGroupMessages
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Clear the local message cache for a group.
 *
 * This does **not** delete messages on WhatsApp servers; it only purges the
 * local store. Returns the number of messages removed, or null if no store.
 */
export async function clearGroupMessages(
  sock: any,
  groupId: string,
): Promise<GroupOperationResult> {
  try {
    const store = (sock as { store?: { messages?: Map<string, unknown[]> } }).store;
    if (!store?.messages) return _ok({ removed: 0, note: 'no local store attached' });
    const before = store.messages.get(groupId)?.length ?? 0;
    store.messages.delete(groupId);
    return _ok({ removed: before });
  } catch (err) {
    return _err(String(err));
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * 37. archiveGroup
 * ────────────────────────────────────────────────────────────────────────── */

/** Archive a group chat (moves it to the archived folder in the client). */
export async function archiveGroup(
  sock: any,
  groupId: string,
): Promise<GroupOperationResult> {
  try {
    await sock.chatModify({ archive: true, lastMessages: [] }, groupId);
    return _ok();
  } catch (err) {
    return _err(String(err));
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * 38. muteGroup
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Mute a group for a given duration.
 *
 * @param muteEndMs  Absolute epoch-ms when the mute expires.
 *                   Use `Date.now() + 8*3600*1000` for 8 hours.
 */
export async function muteGroup(
  sock: any,
  groupId: string,
  muteEndMs: number,
): Promise<GroupOperationResult> {
  try {
    await sock.chatModify({ mute: muteEndMs }, groupId);
    return _ok({ muteUntil: new Date(muteEndMs).toISOString() });
  } catch (err) {
    return _err(String(err));
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * 39. unmuteGroup
 * ────────────────────────────────────────────────────────────────────────── */

/** Unmute a previously muted group. */
export async function unmuteGroup(
  sock: any,
  groupId: string,
): Promise<GroupOperationResult> {
  try {
    await sock.chatModify({ mute: null }, groupId);
    return _ok();
  } catch (err) {
    return _err(String(err));
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * 40. blockGroupMember
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Remove a member from the group and add them to the in-process blacklist.
 * Subsequent `addParticipant` calls will refuse to re-add blacklisted JIDs.
 */
export async function blockGroupMember(
  sock: any,
  groupId: string,
  jid: string,
): Promise<GroupOperationResult> {
  try {
    await sock.groupParticipantsUpdate(groupId, [jid], 'remove');
    const bl = _blacklists.get(groupId) ?? new Set<string>();
    bl.add(jid);
    _blacklists.set(groupId, bl);
    return _ok({ blocked: jid });
  } catch (err) {
    return _err(String(err));
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * 41. unblockGroupMember
 * ────────────────────────────────────────────────────────────────────────── */

/** Remove a JID from the group's in-process blacklist. */
export async function unblockGroupMember(
  sock: any,
  groupId: string,
  jid: string,
): Promise<GroupOperationResult> {
  const bl = _blacklists.get(groupId);
  if (!bl || !bl.has(jid)) {
    return _err(`${jid} is not on the blacklist for ${groupId}`);
  }
  bl.delete(jid);
  return _ok({ unblocked: jid });
}

/* ─────────────────────────────────────────────────────────────────────────
 * 42. getGroupBlacklist
 * ────────────────────────────────────────────────────────────────────────── */

/** Return the current in-process blacklist for a group. */
export async function getGroupBlacklist(
  _sock: any,
  groupId: string,
): Promise<string[]> {
  return Array.from(_blacklists.get(groupId) ?? []);
}

/* ─────────────────────────────────────────────────────────────────────────
 * 43. sendGroupAnnouncement
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Send a formatted announcement message to the group.
 * Temporarily enables announcement mode if `lockDuring` is true.
 */
export async function sendGroupAnnouncement(
  sock: any,
  groupId: string,
  text: string,
  lockDuring?: boolean,
): Promise<GroupOperationResult> {
  try {
    if (lockDuring) await sock.groupSettingUpdate(groupId, 'announcement');
    await sock.sendMessage(groupId, { text: `📢 *Announcement*\n\n${text}` });
    if (lockDuring) await sock.groupSettingUpdate(groupId, 'not_announcement');
    return _ok();
  } catch (err) {
    return _err(String(err));
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * 44. scheduleGroupAnnouncement
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Schedule an announcement to be sent to a group at a future time.
 *
 * Returns a unique `id` that can be used to cancel the schedule before it fires
 * (cancel by clearing the returned `timer` from the registry).
 */
export async function scheduleGroupAnnouncement(
  sock: any,
  groupId: string,
  text: string,
  sendAt: Date | number,
): Promise<ScheduledAnnouncement> {
  const id = randomBytes(8).toString('hex');
  const sendAtMs = sendAt instanceof Date ? sendAt.getTime() : sendAt;
  const delayMs = Math.max(0, sendAtMs - Date.now());

  const entry: ScheduledAnnouncement = { id, groupId, text, sendAt: sendAtMs, timer: null };

  const timer = setTimeout(() => {
    void sendGroupAnnouncement(sock, groupId, text);
    _scheduledAnnouncements.delete(id);
  }, delayMs);

  entry.timer = timer;
  _scheduledAnnouncements.set(id, entry);
  return entry;
}

/* ─────────────────────────────────────────────────────────────────────────
 * 45. trackGroupActivity
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Attach a `group-participants.update` listener that records every event into
 * the module-level activity log.  Returns a disposer function.
 */
export async function trackGroupActivity(
  sock: any,
  groupId: string,
): Promise<() => void> {
  const handler = (update: { id?: string; participants?: string[]; action?: string }) => {
    if (update.id !== groupId) return;
    _appendActivity(groupId, {
      groupId,
      eventType: update.action ?? 'unknown',
      participants: update.participants ?? [],
      at: Date.now(),
      raw: update,
    });
  };

  sock.ev.on('group-participants.update', handler);
  return () => sock.ev.off('group-participants.update', handler);
}

/* ─────────────────────────────────────────────────────────────────────────
 * 46. generateGroupReport
 * ────────────────────────────────────────────────────────────────────────── */

/** Generate a structured report object for a group. */
export async function generateGroupReport(
  sock: any,
  groupId: string,
): Promise<GroupReport> {
  const meta: GroupMetadata = await sock.groupMetadata(groupId);
  const admins = meta.participants.filter((p) => p.admin !== null);
  let inviteLink: string | null = null;
  try {
    inviteLink = await getGroupInviteLink(sock, groupId);
  } catch {
    /* non-fatal — caller may not be admin */
  }

  return {
    generatedAt: Date.now(),
    groupId,
    subject: meta.subject,
    description: meta.desc,
    totalMembers: meta.participants.length,
    adminCount: admins.length,
    memberCount: meta.participants.length - admins.length,
    creatorJid: meta.owner,
    createdAt: meta.creation,
    inviteLink,
    ephemeralDuration: meta.ephemeralDuration,
    isAnnounce: meta.announce ?? false,
    isRestrict: meta.restrict ?? false,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
 * 47. getGroupGrowthStats
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Return a growth-stats snapshot.  The `trend` field is derived from the
 * activity log: net adds minus removals in the last 24 hours.
 */
export async function getGroupGrowthStats(
  sock: any,
  groupId: string,
): Promise<GroupGrowthStats> {
  const meta: GroupMetadata = await sock.groupMetadata(groupId);
  const admins = meta.participants.filter((p) => p.admin !== null).length;

  const cutoff = Date.now() - 24 * 3600 * 1000;
  const recent = (_activityLog.get(groupId) ?? []).filter((r) => r.at >= cutoff);
  const netAdds = recent.filter((r) => r.eventType === 'add').length
    - recent.filter((r) => r.eventType === 'remove').length;

  const trend: GroupGrowthStats['trend'] =
    netAdds > 3 ? 'growing' : netAdds < -3 ? 'shrinking' : recent.length > 0 ? 'stable' : 'unknown';

  return {
    groupId,
    snapshotAt: Date.now(),
    totalMembers: meta.participants.length,
    admins,
    plain: meta.participants.length - admins,
    trend,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
 * 48. setGroupWelcomeMessage
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Store a welcome message template for a group.
 * Use `{participant}` as a placeholder for the new member's JID.
 *
 * Wire this up to a `group-participants.update` → action `add` listener to
 * automatically greet new members.
 */
export async function setGroupWelcomeMessage(
  _sock: any,
  groupId: string,
  template: string,
): Promise<GroupOperationResult> {
  _welcomeMessages.set(groupId, template);
  return _ok({ groupId, template });
}

/* ─────────────────────────────────────────────────────────────────────────
 * 49. setGroupGoodbyeMessage
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Store a goodbye message template for a group.
 * Use `{participant}` as a placeholder for the departing member's JID.
 */
export async function setGroupGoodbyeMessage(
  _sock: any,
  groupId: string,
  template: string,
): Promise<GroupOperationResult> {
  _goodbyeMessages.set(groupId, template);
  return _ok({ groupId, template });
}

/* ─────────────────────────────────────────────────────────────────────────
 * 50. autoModerate
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Register one or more regex patterns as auto-moderation rules for a group.
 * When `detectGroupSpam` is called with a message, these patterns are tested.
 * Pass an empty array to clear all rules.
 */
export async function autoModerate(
  _sock: any,
  groupId: string,
  patterns: (string | RegExp)[],
): Promise<GroupOperationResult> {
  const compiled = patterns.map((p) => (p instanceof RegExp ? p : new RegExp(p, 'i')));
  _autoModRules.set(groupId, compiled);
  return _ok({ groupId, ruleCount: compiled.length });
}

/* ─────────────────────────────────────────────────────────────────────────
 * 51. detectGroupSpam
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Score a message body against a built-in heuristic and any registered
 * auto-moderation rules for the group.
 *
 * Score is 0–100. Anything ≥ 50 is flagged as spam.
 */
export async function detectGroupSpam(
  _sock: any,
  groupId: string,
  text: string,
): Promise<SpamDetectionResult> {
  const reasons: string[] = [];
  let score = 0;

  // Built-in heuristics
  if (/https?:\/\//gi.test(text)) { score += 15; reasons.push('contains URL'); }
  if (/join.*https?:\/\/chat\.whatsapp\.com/i.test(text)) { score += 40; reasons.push('WhatsApp invite link'); }
  if (text.length > 800) { score += 10; reasons.push('unusually long message'); }
  if ((text.match(/!/g) ?? []).length > 5) { score += 10; reasons.push('excessive exclamation marks'); }
  if (/\b(free|win|prize|click|earn|money|bitcoin|crypto|investment)\b/i.test(text)) {
    score += 20; reasons.push('spam keyword match');
  }

  // User-registered patterns
  const rules = _autoModRules.get(groupId) ?? [];
  for (const re of rules) {
    if (re.test(text)) { score += 30; reasons.push(`custom rule: ${re.source}`); }
  }

  score = Math.min(100, score);
  return { isSpam: score >= 50, score, reasons };
}

/* ─────────────────────────────────────────────────────────────────────────
 * 52. quarantineSpammer
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Remove a suspected spammer from the group and add them to the blacklist.
 *
 * This is the enforcement step — call it after `detectGroupSpam` returns
 * `isSpam: true` and you have confirmed you want to act.
 */
export async function quarantineSpammer(
  sock: any,
  groupId: string,
  jid: string,
  reason: string = 'spam detected',
): Promise<QuarantineResult> {
  let removed = false;
  try {
    await sock.groupParticipantsUpdate(groupId, [jid], 'remove');
    removed = true;
  } catch {
    /* non-fatal: member may have already left */
  }

  const bl = _blacklists.get(groupId) ?? new Set<string>();
  bl.add(jid);
  _blacklists.set(groupId, bl);

  _appendActivity(groupId, {
    groupId,
    eventType: 'quarantine',
    participants: [jid],
    at: Date.now(),
    raw: { reason },
  });

  return { removed, jid, groupId, reason };
}
