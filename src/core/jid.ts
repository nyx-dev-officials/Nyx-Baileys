/**
 * JID canonicalisation.
 *
 * WhatsApp has several address families that all look like `user@server` but
 * mean different things, plus a device suffix that is invisible until it isn't:
 *
 *   `15551234567@s.whatsapp.net`   phone-number address (PN)
 *   `1234567890@lid`               local identifier, not a phone number
 *   `1234567890:12@s.whatsapp.net` the `:12` is a *device* off that user
 *   `123-456@g.us`                 group
 *   `status@broadcast`             status feed
 *   `123@newsletter`               channel
 *
 * Mixing these up silently double-threads a conversation: `x@lid` and the PN it
 * resolves to are the same human, but two different map keys. These helpers are
 * the pure, testable core of that — no I/O, no resolver state.
 */

/** Which address family a jid belongs to. */
export type JidKind = 'pn' | 'lid' | 'group' | 'broadcast' | 'newsletter' | 'bot' | 'unknown';

const at = (jid: string): { user: string; server: string } | null => {
  const i = jid.indexOf('@');
  if (i <= 0 || i === jid.length - 1) return null;
  return { user: jid.slice(0, i), server: jid.slice(i + 1) };
};

/** Split the device suffix (`user:12@server` → user `user`). */
const stripDevice = (user: string): string => {
  const i = user.indexOf(':');
  return i === -1 ? user : user.slice(0, i);
};

/** The device number a jid carries, or 0 when it has none. */
export function deviceOf(jid: string): number {
  const parsed = at(jid);
  if (!parsed) return 0;
  const i = parsed.user.indexOf(':');
  if (i === -1) return 0;
  const n = Number.parseInt(parsed.user.slice(i + 1), 10);
  return Number.isFinite(n) ? n : 0;
}

/** The jid with any device suffix removed. */
export function bareJid(jid: string): string {
  const parsed = at(jid);
  if (!parsed) return jid;
  return `${stripDevice(parsed.user)}@${parsed.server}`;
}

/** Classify a jid by its server. */
export function kindOf(jid: string): JidKind {
  const parsed = at(jid);
  if (!parsed) return 'unknown';
  switch (parsed.server) {
    case 's.whatsapp.net':
      return 'pn';
    case 'lid':
      return 'lid';
    case 'g.us':
      return 'group';
    case 'broadcast':
      return 'broadcast';
    case 'newsletter':
      return 'newsletter';
    case 'bot':
      return 'bot';
    default:
      return 'unknown';
  }
}

export const isPn = (jid: string): boolean => kindOf(jid) === 'pn';
export const isLid = (jid: string): boolean => kindOf(jid) === 'lid';
export const isGroup = (jid: string): boolean => kindOf(jid) === 'group';
export const isNewsletter = (jid: string): boolean => kindOf(jid) === 'newsletter';
export const isBroadcast = (jid: string): boolean => kindOf(jid) === 'broadcast';

/** The user part (no device, no server) of a jid. */
export function userOf(jid: string): string | null {
  const parsed = at(jid);
  return parsed ? stripDevice(parsed.user) : null;
}

/** Digits-only phone number from a PN jid, or null for any other family. */
export function phoneOf(jid: string): string | null {
  if (!isPn(jid)) return null;
  const user = userOf(jid);
  if (!user) return null;
  const digits = user.replace(/\D/g, '');
  return digits.length > 0 ? digits : null;
}

/** Build a bare PN jid from a phone number (strips formatting and `+`). */
export function toPnJid(phone: string): string {
  return `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
}

/** Build a bare LID jid from a lid id. */
export function toLidJid(id: string): string {
  return `${id.replace(/[^0-9]/g, '')}@lid`;
}

/**
 * True when two jids address the same *account*, ignoring device suffix and
 * case. Does not bridge LID↔PN — that needs a resolver, by design.
 */
export function sameUser(a: string, b: string): boolean {
  const ua = userOf(a)?.toLowerCase();
  const ub = userOf(b)?.toLowerCase();
  if (!ua || !ub) return false;
  return ua === ub && kindOf(a) === kindOf(b);
}

/**
 * A stable, collision-free key for threading / DB indexing.
 *
 * The point is that the *same* conversation must map to the *same* key even as
 * a jid gains or loses a device suffix, so a store does not grow a second
 * thread for the same human.
 *
 *   canonicalThreadKey('123:5@s.whatsapp.net') → 'thread:123'
 *   canonicalThreadKey('123-456@g.us')          → 'thread:group:123-456'
 *   canonicalThreadKey('status@broadcast')      → 'thread:broadcast:status'
 *
 * Pass `resolveLid` to map a LID to its PN once that mapping is known:
 *   canonicalThreadKey('999@lid', () => '1555@s.whatsapp.net') → 'thread:1555'
 */
export function canonicalThreadKey(jid: string, resolveLid?: (jid: string) => string | null | undefined): string {
  const clean = String(jid ?? '').trim().toLowerCase();
  if (!clean) return 'thread:invalid';

  const parsed = at(clean);
  if (!parsed) return `thread:unknown:${clean}`;

  const user = stripDevice(parsed.user);
  const bare = `${user}@${parsed.server}`;

  switch (parsed.server) {
    case 's.whatsapp.net':
      return `thread:${user}`;
    case 'lid': {
      const pn = resolveLid?.(bare);
      const pnUser = pn ? userOf(pn) : null;
      return pnUser ? `thread:${pnUser.toLowerCase()}` : `thread:lid:${user}`;
    }
    case 'g.us':
      return `thread:group:${user}`;
    case 'broadcast':
      return `thread:broadcast:${user}`;
    case 'newsletter':
      return `thread:newsletter:${user}`;
    default:
      return `thread:${parsed.server}:${user}`;
  }
}
