/**
 * OPS-50 · module 1 of 6 — chat state, blocking, privacy, disappearing.
 *
 * Every function here wraps a real rc14 socket method. Nothing invents API.
 * The methods used are all present in rc14 `business.d.ts`:
 * `chatModify`, `getChatSettings`, `updateBlockStatus`, `fetchBlocklist`,
 * `fetchPrivacySettings`, `update*Privacy`, `fetchDisappearingDuration`,
 * `updateDefaultDisappearingMode`.
 */

import type { AnySock } from './types.js';

/* ── 1-5 · chat flags ─────────────────────────────────────────────── */

/** `chatModify` verbs this module uses. */
export type ChatFlag = 'archive' | 'pin' | 'mute' | 'star';

export interface ChatFlags {
  archive: boolean;
  pin: boolean;
  mute: boolean;
  star: boolean;
}

/** Parse rc14's `getChatSettings` argv array into flags. */
export function parseChatFlags(argv: unknown): ChatFlags {
  const on = (verb: string): boolean =>
    Array.isArray(argv)
      && argv.some((entry) => {
        const [key, value] = entry as [string, boolean | null];
        return key === verb && value === true;
      });

  return { archive: on('archive'), pin: on('pin'), mute: on('mute'), star: on('star') };
}

/** Read a chat's four flags without mutating anything. */
export async function readChatFlags(sock: AnySock, jid: string): Promise<ChatFlags> {
  return parseChatFlags(await sock.getChatSettings?.(jid));
}

/**
 * Drive one flag to a target state.
 *
 * rc14's `chatModify(mod, jid, attrs)` toggles when the value is omitted, which
 * makes idempotent code impossible — calling it twice flips the flag back. So
 * this reads the current state and only acts on a real difference.
 */
export async function setChatFlag(
  sock: AnySock,
  jid: string,
  flag: ChatFlag,
  on: boolean,
): Promise<boolean> {
  const current = await readChatFlags(sock, jid);
  if (current[flag] === on) return false;

  await sock.chatModify(flag, jid, on);
  return true;
}

/** Set several flags in sequence. Returns which ones actually changed. */
export async function configureChat(
  sock: AnySock,
  jid: string,
  flags: Partial<ChatFlags>,
): Promise<string[]> {
  const changed: string[] = [];
  for (const [flag, want] of Object.entries(flags)) {
    if (typeof want !== 'boolean') continue;
    if (await setChatFlag(sock, jid, flag as ChatFlag, want)) changed.push(flag);
  }
  return changed;
}

/** Mark every unread chat read without deleting anything. */
export async function markChatRead(sock: AnySock, jid: string, key: unknown): Promise<boolean> {
  await sock.readMessages([key as never]);
  await sock.chatModify('clear', jid);
  return true;
}

/* ── 6-10 · blocking ──────────────────────────────────────────────── */

/** Is this jid blocked? Fails closed — a false "no" is the safe direction. */
export async function isBlocked(sock: AnySock, jid: string): Promise<boolean> {
  try {
    const list: string[] = (await sock.fetchBlocklist()) ?? [];
    return list.includes(jid);
  } catch {
    return false;
  }
}

/** Block a jid. Idempotent: returns false if it was already blocked. */
export async function blockJid(sock: AnySock, jid: string): Promise<boolean> {
  if (await isBlocked(sock, jid)) return false;
  await sock.updateBlockStatus(jid, 'block');
  return true;
}

/** Unblock a jid. Idempotent: returns false if it was not blocked. */
export async function unblockJid(sock: AnySock, jid: string): Promise<boolean> {
  if (!(await isBlocked(sock, jid))) return false;
  await sock.updateBlockStatus(jid, 'unblock');
  return true;
}

/** Drive block state to a target. Returns true only if it acted. */
export async function ensureBlocked(
  sock: AnySock,
  jid: string,
  blocked: boolean,
): Promise<boolean> {
  return blocked ? blockJid(sock, jid) : unblockJid(sock, jid);
}

/** Strip device suffixes and duplicates from a blocklist. */
export function normaliseBlocklist(list: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  for (const raw of list ?? []) {
    const base = String(raw).split(':')[0]?.trim();
    if (base) seen.add(base);
  }
  return [...seen].sort();
}

/* ── 11-20 · privacy ──────────────────────────────────────────────── */

/** Every privacy switch rc14 exposes, keyed by its socket method name. */
const PRIVACY_WRITERS = {
  readReceipts: 'updateReadReceiptsPrivacy',
  lastSeen: 'updateLastSeenPrivacy',
  online: 'updateOnlinePrivacy',
  profilePicture: 'updateProfilePicturePrivacy',
  status: 'updateStatusPrivacy',
  groupsAdd: 'updateGroupsAddPrivacy',
  messages: 'updateMessagesPrivacy',
  call: 'updateCallPrivacy',
} as const;

export type PrivacyKey = keyof typeof PRIVACY_WRITERS;

export type PrivacyAudience =
  | 'all'
  | 'contacts'
  | 'contact_blacklist'
  | 'match_last_seen'
  | 'none';

/** Read the whole privacy object. */
export function readPrivacy(sock: AnySock): Promise<Record<string, any>> {
  return sock.fetchPrivacySettings();
}

/**
 * Write one privacy switch.
 *
 * These live in an app-state patch (`privacy[category][audience]`), which is
 * what each `update*Privacy` call wraps. `'none'` disables the receipt.
 */
export async function setPrivacy(
  sock: AnySock,
  key: PrivacyKey,
  audience: PrivacyAudience,
): Promise<boolean> {
  const method = PRIVACY_WRITERS[key];
  if (!method) throw new Error(`unknown privacy key: ${key}`);
  const fn = sock[method];
  if (typeof fn !== 'function') throw new Error(`rc14 socket has no ${method}`);
  await fn.call(sock, audience);
  return true;
}

/** Read one category's audience, or undefined if unset. */
export async function getPrivacyAudience(
  sock: AnySock,
  key: PrivacyKey,
): Promise<PrivacyAudience | undefined> {
  const privacy = await readPrivacy(sock);
  const row = privacy?.[key] as Record<string, string> | undefined;
  return (row?.readReceipts ?? row?.status) as PrivacyAudience | undefined;
}

/** Resolve a category's audience with a fallback. */
export function resolveAudience(
  privacy: Record<string, any> | undefined,
  key: PrivacyKey,
  fallback: PrivacyAudience = 'all',
): PrivacyAudience {
  const row = privacy?.[key] as Record<string, string> | undefined;
  return ((row?.readReceipts ?? row?.status) as PrivacyAudience | undefined) ?? fallback;
}

/** Disable every optional receipt. Maximum stealth. */
export async function goFullyPrivate(sock: AnySock): Promise<PrivacyKey[]> {
  const keys = Object.keys(PRIVACY_WRITERS) as PrivacyKey[];
  for (const key of keys) await setPrivacy(sock, key, 'none');
  return keys;
}

/** Re-enable the receipts an ordinary client wants. */
export async function goStandardPrivacy(sock: AnySock): Promise<PrivacyKey[]> {
  const keys = Object.keys(PRIVACY_WRITERS) as PrivacyKey[];
  for (const key of keys) await setPrivacy(sock, key, 'contacts');
  return keys;
}

/* ── 21-24 · disappearing messages ────────────────────────────────── */

/** The durations WhatsApp's own UI offers, in seconds. 0 means off. */
export const DISAPPEARING_PRESETS = [
  { label: 'off', seconds: 0 },
  { label: '30s', seconds: 30 },
  { label: '5m', seconds: 300 },
  { label: '1h', seconds: 3_600 },
  { label: '24h', seconds: 86_400 },
  { label: '7d', seconds: 604_800 },
  { label: '90d', seconds: 7_776_000 },
] as const;

export type DisappearingPreset = (typeof DISAPPEARING_PRESETS)[number]['label'];

/** Map a preset label to seconds, rejecting anything off the list. */
export function presetToSeconds(preset: DisappearingPreset): number {
  const found = DISAPPEARING_PRESETS.find((p) => p.label === preset);
  if (!found) throw new Error(`unknown disappearing preset: ${preset}`);
  return found.seconds;
}

/**
 * Read a chat's disappearing duration, in seconds.
 *
 * `fetchDisappearingDuration` is variadic and returns a **result list**, not a
 * number — each entry is a USync result carrying `disappearing_mode.duration`.
 * Reading it as a scalar is why this takes an explicit unwrap.
 */
export async function getChatExpiry(sock: AnySock, jid: string): Promise<number> {
  const results = await sock.fetchDisappearingDuration(jid);
  return results?.[0]?.disappearing_mode?.duration ?? 0;
}

/** Change a chat's disappearing duration. */
export function setChatExpiry(sock: AnySock, jid: string, seconds: number): Promise<void> {
  return sock.updateDefaultDisappearingMode(jid, seconds);
}

/** Turn disappearing off for a chat if it is currently on. */
export async function disableExpiry(sock: AnySock, jid: string): Promise<boolean> {
  if ((await getChatExpiry(sock, jid)) === 0) return false;
  await setChatExpiry(sock, jid, 0);
  return true;
}