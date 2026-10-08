/**
 * OPS-50 · shared helpers.
 *
 * Kept separate so every module can import without creating a cycle.
 */

/** The extended-type socket alias this toolkit uses for upstream sockets. */
export type AnySock = Record<string, any>;

/** Group membership verbs rc14 accepts. Mirrors upstream `ParticipantAction`. */
export type ParticipantAction = 'add' | 'remove' | 'promote' | 'demote' | 'modify';

/** True for a group jid. */
export function isGroupJid(jid: string): boolean {
  return jid.endsWith('@g.us');
}

/** True for a status broadcast jid. */
export function isStatusJid(jid: string): boolean {
  return jid.endsWith('@status@broadcast') || jid === 'status@broadcast';
}

/** True for a newsletter jid. */
export function isNewsletterJid(jid: string): boolean {
  return jid.endsWith('@newsletter');
}

/** True for a community jid. */
export function isCommunityJid(jid: string): boolean {
  return jid.endsWith('.community');
}

/** Strip a device suffix. */
export function baseJid(jid: string): string {
  return jid.split(':')[0] ?? jid;
}

/** Classify a jid in one call. */
export type JidKind = 'group' | 'status' | 'newsletter' | 'community' | 'user';

export function jidKind(jid: string): JidKind {
  if (isGroupJid(jid)) return 'group';
  if (isNewsletterJid(jid)) return 'newsletter';
  if (isCommunityJid(jid)) return 'community';
  if (isStatusJid(jid)) return 'status';
  return 'user';
}

/** Assert a jid targets a group, or throw with the offending value. */
export function assertGroupJid(jid: string): void {
  if (!isGroupJid(jid)) throw new Error(`not a group jid: ${jid}`);
}

/** Dedupe a jid list, preserving order. */
export function uniqueJids(jids: readonly string[]): string[] {
  return [...new Set(jids.map(baseJid))];
}

/**
 * Decode a jid into its parts.
 *
 * rc14 exports `jidDecode`, which returns `null` for a malformed jid rather
 * than throwing. Re-exporting it here keeps the toolkit's jid handling in one
 * place and lets callers import everything from `ops-50`.
 */
export function jidDecode(
  jid: string,
): { user: string; device: number; server: string } | null {
  // Two real shapes in the wild:
  //   user:device@server        62882017467912:12@s.whatsapp.net
  //   user.device:user@server    12345.1:12345@lid      (LID form)
  // The device number is either the part after the colon or the part after the
  // dot — so both are tried before falling back to device 0.
  const text = String(jid).trim();

  // Order matters. A LID is `user.device:user@server`, whose left side carries a
  // dot and whose post-colon segment is the *user* repeated, not the device.
  // Testing the colon form first therefore reads the device as the user id.
  const lid = /^([\w.+-]+)\.(\d+):[\w.+-]+@(.+)$/.exec(text);
  if (lid) {
    return {
      user: lid[1] as string,
      device: Number(lid[2]),
      server: lid[3] as string,
    };
  }

  const colon = /^([\w.+-]+):(\d+)@(.+)$/.exec(text);
  if (colon) {
    return {
      user: colon[1] as string,
      device: Number(colon[2]),
      server: colon[3] as string,
    };
  }

  const bare = /^([\w.+-]+)@(.+)$/.exec(text);
  if (bare) {
    return { user: bare[1] as string, device: 0, server: bare[2] as string };
  }

  return null;
}

/**
 * Encode jid parts back into a jid string.
 *
 * The dotted form `user.device:user@server` is what a LID uses; the plain form
 * is `user:device@server`. Which one is correct depends on the server, so this
 * keeps the plain shape and callers that need a LID build it explicitly.
 */
export function jidEncode(user: string, device: number, server: string): string {
  return device ? `${user}:${device}@${server}` : `${user}@${server}`;
}