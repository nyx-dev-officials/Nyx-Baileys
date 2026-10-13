/**
 * Bot tools — the command set the reference scripts all ship, without the parts
 * that should not be shipped.
 *
 * Ten WhatsApp bot archives were read for their command inventory (see
 * `docs/BOT-FEATURE-AUDIT.md`). This file implements the features that appear in
 * most of them and that this library did not have, and deliberately does not
 * implement the ones that only work by abusing the platform — the audit lists
 * those by name and says why.
 *
 * ### What is here
 *
 * | Command in the wild | Function | Why it is worth having |
 * |---|---|---|
 * | `hidetag` | `hiddenTag` | Mention a whole group without printing 200 names |
 * | `tagall` | `visibleTag` | The same, with names — for a real announcement |
 * | `afk` | `createAfkStore` | Tell people you are away, and for how long |
 * | `autoread` / `autotyping` / `autorecording` | `createAutoPresence` | Look present without lying about being human |
 * | `qc` | `quoteCardSvg` | A quote card that needs no image library |
 * | `emojimix` | `emojiMixUrl` / `sendEmojiMix` | Two emoji, one picture |
 * | `swm` | `sendWatermarkedSticker` | Sticker with a pack name and author |
 * | `translate` | `translateText` | Provider-agnostic, injectable |
 * | `tts` | `textToSpeech` | Same shape |
 * | `welcome` / `goodbye` | `renderTemplate` | Placeholders that do not break on a missing key |
 *
 * ### What is *not* here, and why
 *
 * `pushkontak`, `bcgc`, `bcall`, `spamcall`, `bug`, `xbug`, `crash`, `muncul`,
 * `spampairing` and `readsw` all appear repeatedly in these archives. They are
 * bulk-messaging, call-spam and crash-payload tools. They get accounts banned and
 * they are aimed at people who did not ask to be messaged, so they are not
 * implemented here at any price. `docs/BOT-FEATURE-AUDIT.md` records each one and
 * the reason, so the omission is a decision on the record rather than a gap.
 *
 * ### Network calls
 *
 * `translate`, `textToSpeech` and `sendEmojiMix` need the internet, so they take
 * their `fetch` as a parameter with the real one as the default. That is not
 * ceremony: it means the tests run offline, and it means a bot behind a proxy can
 * substitute its own client without patching this library.
 */

import { sendSticker, sendImage } from '../features/messaging.js';
import { getGroupMembers } from '../features/groups.js';
import type { CoreSocket } from '../utils/types.js';

/* ══════════════════════════════════════════════════════════════════════════
   Tagging
   ══════════════════════════════════════════════════════════════════════════ */

/** A participant, as `groupMetadata` returns it. */
interface Participant {
  id: string;
  name?: string;
  notify?: string;
  admin?: string | null;
}

/**
 * A participant's jid with the device suffix removed but the domain kept.
 *
 * `split(':')[0]` — the obvious version, and what `isOwner` in
 * `toolkit/ai/identity.ts` still does — returns `222` for `222:3@s.whatsapp.net`,
 * which is not a jid and never matches anything. The device suffix is inside the
 * local part, so it has to be removed there and the domain put back.
 */
const bareJid = (jid: string): string => {
  const [local, domain] = String(jid ?? '').split('@');
  if (!local) return '';
  const user = local.split(':')[0] ?? '';
  return domain ? `${user}@${domain}` : user;
};

/** The name to show for a participant: their saved name, then their push name. */
const label = (p: Participant): string => p.name || p.notify || bareJid(p.id).split('@')[0] || 'member';

/** Everyone in a group, or `[]` when the jid is not a group we can read. */
export async function groupMemberJids(sock: CoreSocket, jid: string): Promise<string[]> {
  try {
    const members = (await getGroupMembers(sock, jid)) as Participant[];
    return members.map((p) => bareJid(p.id)).filter(Boolean);
  } catch {
    // A 1:1 chat has no metadata. Tagging there means tagging the person you are
    // already talking to, which is not what this is for; return empty and let the
    // caller decide.
    return [];
  }
}

export interface TagOptions {
  /** Extra jids to mention beyond the members. */
  also?: string[];
  /** Quote to reply to. */
  quoted?: unknown;
}

/**
 * `hidetag` — mention everyone, print nobody.
 *
 * WhatsApp shows a mention when the mentioned jid's number appears in the text.
 * A message can carry `mentions` **without** naming anyone in the body, and the
 * client still treats every mentioned person as notified. That is the whole
 * trick, it is a documented field, and it is why this produces a clean
 * announcement instead of a wall of numbers.
 *
 * Returns the number of people mentioned, so a caller can report something true.
 */
export async function hiddenTag(
  sock: CoreSocket,
  jid: string,
  text: string,
  options: TagOptions = {},
): Promise<{ mentioned: number; id: string }> {
  const members = await groupMemberJids(sock, jid);
  const mentions = [...new Set([...members, ...(options.also ?? []).map(bareJid)])];

  const sent = (await (sock as unknown as {
    sendMessage: (j: string, c: unknown, o?: unknown) => Promise<{ key?: { id?: string } }>;
  }).sendMessage(
    jid,
    { text, mentions },
    options.quoted ? { quoted: options.quoted } : undefined,
  )) ?? {};

  return { mentioned: mentions.length, id: sent.key?.id ?? '' };
}

/**
 * `tagall` — mention everyone **and** show the names.
 *
 * Built from the same call as `hiddenTag`, with the names in the body. The
 * `@number` tokens are what the client renders as a name chip; the `mentions`
 * list is what makes them resolve, so both halves are present and a client that
 * ignores one still shows something sensible.
 */
export async function visibleTag(
  sock: CoreSocket,
  jid: string,
  text: string,
  options: TagOptions = {},
): Promise<{ mentioned: number; id: string }> {
  let members: Participant[] = [];
  try {
    members = (await getGroupMembers(sock, jid)) as Participant[];
  } catch {
    members = [];
  }

  const lines = members.map((p) => `• @${bareJid(p.id).split('@')[0]} — ${label(p)}`);
  const body = lines.length ? `${text}\n\n${lines.join('\n')}` : text;

  const sent = (await (sock as unknown as {
    sendMessage: (j: string, c: unknown, o?: unknown) => Promise<{ key?: { id?: string } }>;
  }).sendMessage(
    jid,
    { text: body, mentions: members.map((p) => bareJid(p.id)) },
    options.quoted ? { quoted: options.quoted } : undefined,
  )) ?? {};

  return { mentioned: members.length, id: sent.key?.id ?? '' };
}

/* ══════════════════════════════════════════════════════════════════════════
   AFK
   ══════════════════════════════════════════════════════════════════════════ */

export interface AfkEntry {
  /** Why they are away. Shown back to anyone who mentions them. */
  reason: string;
  /** When they went away, epoch ms. */
  since: number;
}

export interface AfkStore {
  set(jid: string, reason?: string, now?: number): AfkEntry;
  clear(jid: string): boolean;
  get(jid: string): AfkEntry | null;
  /** `2h 5m` since they left, or `''` for someone who is not away. */
  duration(jid: string, now?: number): string;
  size(): number;
}

/**
 * Human-readable elapsed time.
 *
 * Kept separate from the store because it is the only part of AFK with arithmetic
 * worth testing, and because a bot may want it for other things.
 */
export function humanDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (!days && !hours && !parts.length) parts.push(`${seconds}s`);
  return parts.join(' ');
}

/**
 * A per-chat away list.
 *
 * In memory, deliberately. An away flag is state about *now*, and a bot that
 * persists it across a restart is a bot that tells people you have been away for
 * three days when you restarted this morning.
 */
export function createAfkStore(clock: () => number = Date.now): AfkStore {
  const entries = new Map<string, AfkEntry>();
  const key = (jid: string): string => bareJid(jid);

  return {
    set(jid, reason = 'away', now = clock()) {
      const entry: AfkEntry = { reason, since: now };
      entries.set(key(jid), entry);
      return entry;
    },
    clear(jid) {
      return entries.delete(key(jid));
    },
    get(jid) {
      return entries.get(key(jid)) ?? null;
    },
    duration(jid, now = clock()) {
      const entry = entries.get(key(jid));
      return entry ? humanDuration(now - entry.since) : '';
    },
    size() {
      return entries.size;
    },
  };
}

/**
 * The line to reply with when someone pings a person who is away.
 *
 * The elapsed time comes from the store, not from `Date.now()` here. The store is
 * the thing that owns the clock — it takes one as a parameter — so reading the
 * wall clock in this function made the notice disagree with the store the moment
 * a caller injected a clock, which is exactly what the test does. First version
 * printed `20734d 19h 53m` for a three-minute absence.
 */
export function afkNotice(jid: string, store: AfkStore, now?: number): string | null {
  const entry = store.get(jid);
  if (!entry) return null;
  const elapsed = now === undefined ? store.duration(jid) : humanDuration(now - entry.since);
  return `*Away* — ${entry.reason} (${elapsed})`;
}

/* ══════════════════════════════════════════════════════════════════════════
   Auto-presence
   ══════════════════════════════════════════════════════════════════════════ */

export interface AutoPresenceOptions {
  /** Mark incoming messages read. Default true. */
  read?: boolean;
  /** Show `composing` while the bot works. Default true. */
  typing?: boolean;
  /** Show `recording` instead of typing, for voice replies. Default false. */
  recording?: boolean;
  /** How long to hold the presence before clearing it, in ms. Default 1500. */
  holdMs?: number;
}

export interface AutoPresence {
  start(jid: string, options?: { recording?: boolean }): Promise<void>;
  stop(jid: string): Promise<void>;
  /** Read + start presence for a batch of inbound messages. */
  handle(messages: Array<{ key?: { remoteJid?: string | null; id?: string | null } }>): Promise<number>;
  stats(): { started: number; cleared: number; read: number };
  options: Required<AutoPresenceOptions>;
}

/**
 * `autoread` + `autotyping` + `autorecording`, as one object.
 *
 * The scripts implement these as three separate booleans read at three different
 * places in a 400 KB switch. They are one behaviour — "act like a person is
 * there" — so they are one object with one lifecycle, and `stop()` always runs,
 * because a socket stuck in `composing` is how a bot looks broken.
 */
export function createAutoPresence(
  sock: CoreSocket,
  options: AutoPresenceOptions = {},
): AutoPresence {
  const config: Required<AutoPresenceOptions> = {
    read: options.read ?? true,
    typing: options.typing ?? true,
    recording: options.recording ?? false,
    holdMs: options.holdMs ?? 1500,
  };

  const counters = { started: 0, cleared: 0, read: 0 };
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const presence = async (type: 'composing' | 'recording' | 'paused', jid: string): Promise<void> => {
    const fn = (sock as unknown as { sendPresenceUpdate?: (t: string, j: string) => Promise<void> })
      .sendPresenceUpdate;
    if (typeof fn === 'function') {
      try {
        await fn.call(sock, type, jid);
      } catch {
        // Presence is cosmetic. A failure here must never take down a reply, so it
        // is swallowed on purpose — and only here.
      }
    }
  };

  const stop = async (jid: string): Promise<void> => {
    const timer = timers.get(jid);
    if (timer) {
      clearTimeout(timer);
      timers.delete(jid);
    }
    await presence('paused', jid);
    counters.cleared += 1;
  };

  return {
    options: config,

    async start(jid, startOptions = {}) {
      const wantsRecording = startOptions.recording ?? config.recording;
      if (!config.typing && !wantsRecording) return;

      await presence(wantsRecording ? 'recording' : 'composing', jid);
      counters.started += 1;

      const existing = timers.get(jid);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        void stop(jid);
      }, config.holdMs);
      timer.unref?.();
      timers.set(jid, timer);
    },

    stop,

    async handle(messages) {
      if (!config.read) return 0;

      const keys = messages
        .map((m) => m.key)
        .filter((k): k is { remoteJid: string; id: string } => Boolean(k?.remoteJid && k?.id));

      if (keys.length === 0) return 0;

      const readMessages = (sock as unknown as {
        readMessages?: (k: Array<{ remoteJid: string; id: string }>) => Promise<void>;
      }).readMessages;

      if (typeof readMessages === 'function') {
        try {
          await readMessages.call(sock, keys);
          counters.read += keys.length;
        } catch {
          // Same reasoning as presence: a receipt that fails is not worth a crash.
        }
      }

      const jid = keys[0]?.remoteJid;
      if (jid) await this.start(jid);
      return keys.length;
    },

    stats() {
      return { ...counters };
    },
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   Quote card — no image library
   ══════════════════════════════════════════════════════════════════════════ */

export interface QuoteCardOptions {
  /** The name shown above the message. */
  name: string;
  /** The message text. Wrapped by the renderer. */
  text: string;
  /** Time label, bottom-right. Default `''`. */
  time?: string;
  /** Bubble background. WhatsApp's own inbound green by default. */
  background?: string;
  /** Text colour. */
  color?: string;
  /** Card width in user units. Default 640. */
  width?: number;
  /** Characters per line before wrapping. Default 34. */
  wrap?: number;
}

const escapeXml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/** Break text into lines of at most `perLine` characters, on word boundaries. */
export function wrapText(text: string, perLine = 34): string[] {
  const lines: string[] = [];
  for (const paragraph of String(text ?? '').split('\n')) {
    let current = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (!current.length) {
        current = word;
      } else if (`${current} ${word}`.length <= perLine) {
        current += ` ${word}`;
      } else {
        lines.push(current);
        current = word;
      }
      // A single word longer than the line is hard-split rather than allowed to
      // run off the card, which is what every naive renderer does.
      while (current.length > perLine) {
        lines.push(current.slice(0, perLine));
        current = current.slice(perLine);
      }
    }
    lines.push(current);
  }
  return lines;
}

/**
 * `qc` — a quote card as SVG.
 *
 * SVG rather than a raster: it needs no image library, it scales, and it is a
 * **string**, so it can be asserted in a test instead of inspected by eye. A bot
 * that wants a PNG runs the SVG through its own renderer; a bot that wants to
 * post it as an image can rasterise it, and the audit records that step as the
 * one thing this function does not do.
 */
export function quoteCardSvg(options: QuoteCardOptions): string {
  const width = options.width ?? 640;
  const background = options.background ?? '#075E54';
  const color = options.color ?? '#ffffff';
  const lines = wrapText(options.text, options.wrap ?? 34);

  const padding = 32;
  const lineHeight = 30;
  const headerHeight = 64;
  const height = padding * 2 + headerHeight + lines.length * lineHeight;

  const body = lines
    .map((line, i) => `<text x="${padding}" y="${padding + headerHeight + i * lineHeight}" font-size="22" fill="${color}">${escapeXml(line)}</text>`)
    .join('\n  ');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `  <rect width="${width}" height="${height}" rx="18" fill="${background}"/>`,
    `  <text x="${padding}" y="${padding + 14}" font-size="20" font-weight="bold" fill="${color}">${escapeXml(options.name)}</text>`,
    `  <line x1="${padding}" y1="${padding + headerHeight - 22}" x2="${width - padding}" y2="${padding + headerHeight - 22}" stroke="${color}" stroke-opacity="0.25"/>`,
    `  ${body}`,
    options.time
      ? `  <text x="${width - padding}" y="${height - 12}" font-size="16" text-anchor="end" fill="${color}" fill-opacity="0.7">${escapeXml(options.time)}</text>`
      : '',
    '</svg>',
  ]
    .filter(Boolean)
    .join('\n');
}

/* ══════════════════════════════════════════════════════════════════════════
   Sticker metadata — `swm`
   ══════════════════════════════════════════════════════════════════════════ */

export interface StickerWatermarkOptions {
  /** Pack name shown in the sticker's info panel. */
  pack: string;
  /** Author shown under it. */
  author: string;
  quoted?: unknown;
}

/**
 * `swm` — send a sticker with a pack name and author.
 *
 * The scripts call this "watermarking", and this is what it actually is: two
 * metadata fields on the sticker, which is the only form of attribution WhatsApp
 * renders for a sticker. Drawing text onto the pixels is a different feature and
 * needs an image library; `addWatermark` in `features/media.ts` claims to do it
 * and returns a byte-for-byte copy of the input instead.
 */
export async function sendWatermarkedSticker(
  sock: CoreSocket,
  jid: string,
  sticker: Buffer | Uint8Array | string | { url: string },
  options: StickerWatermarkOptions,
): Promise<unknown> {
  return sendSticker(sock, jid, sticker, {
    packName: options.pack,
    author: options.author,
    ...(options.quoted ? { quoted: options.quoted } : {}),
  } as never);
}

/* ══════════════════════════════════════════════════════════════════════════
   Emoji mix
   ══════════════════════════════════════════════════════════════════════════ */

/** Magic numbers Google's emoji kitchen uses for the transparent-background set. */
const EMOJI_KITCHEN_VERSION = '15';

/**
 * The URL for a mix of two emoji.
 *
 * Pure, so the menu row and the send path cannot disagree about what a mix is.
 * `a` and `b` are code points — `'🍕'`, not `'pizza'`.
 */
export function emojiMixUrl(a: string, b: string, options: { size?: 72 | 128 | 256 } = {}): string {
  const size = options.size ?? 256;
  const left = [...a].map((ch) => (ch.codePointAt(0) ?? 0).toString(16)).join('_');
  const right = [...b].map((ch) => (ch.codePointAt(0) ?? 0).toString(16)).join('_');
  return `https://www.gstatic.com/android/keyboard/emojikitchen/${EMOJI_KITCHEN_VERSION}/${left}/${left}_${right}.png`;
}

export interface EmojiMixResult {
  ok: boolean;
  /** Set on success. */
  bytes?: number;
  /** Set on failure. */
  error?: string;
}

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

/** A client that can also parse JSON. Separate so neither cast has to lie. */
type JsonFetchLike = (
  url: string,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Fetch a mix and send it.
 *
 * Failure is returned, not thrown: a mix that does not exist is one of the two
 * normal outcomes here (Google only ships pairs it drew), and a bot should say
 * "no mix for those two" rather than look crashed.
 */
export async function sendEmojiMix(
  sock: CoreSocket,
  jid: string,
  a: string,
  b: string,
  deps: { fetch?: FetchLike; size?: 72 | 128 | 256 } = {},
): Promise<EmojiMixResult> {
  const doFetch = deps.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (typeof doFetch !== 'function') {
    return { ok: false, error: 'no fetch available in this runtime' };
  }

  const url = emojiMixUrl(a, b, deps.size ? { size: deps.size } : {});
  try {
    const response = await doFetch(url);
    if (!response.ok) {
      return { ok: false, error: `no mix for those two emoji (HTTP ${response.status})` };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) return { ok: false, error: 'the mix came back empty' };

    await sendImage(sock, jid, buffer, {});
    return { ok: true, bytes: buffer.length };
  } catch (error) {
    return { ok: false, error: String((error as Error).message ?? error) };
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   Translate
   ══════════════════════════════════════════════════════════════════════════ */

export interface TranslateOptions {
  /** Target language, ISO 639-1. Default `'en'`. */
  to?: string;
  /** Source language, or `'auto'`. Default `'auto'`. */
  from?: string;
  fetch?: JsonFetchLike;
}

export interface TranslateResult {
  ok: boolean;
  text?: string;
  detected?: string;
  error?: string;
}

const GOOGLE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';

/**
 * Translate text.
 *
 * The endpoint is the one the browser widget uses: no key, no account, no
 * library. It is also undocumented and can change, which is exactly why the
 * result is a discriminated object — an outage produces `{ ok: false }` with the
 * reason, not an exception in the middle of a reply.
 */
export async function translateText(
  text: string,
  options: TranslateOptions = {},
): Promise<TranslateResult> {
  const source = String(text ?? '').trim();
  if (!source) return { ok: false, error: 'nothing to translate' };

  const doFetch = options.fetch ?? (globalThis.fetch as unknown as JsonFetchLike | undefined);
  if (typeof doFetch !== 'function') return { ok: false, error: 'no fetch available in this runtime' };

  const url =
    `${GOOGLE_ENDPOINT}?client=gtx&dt=t` +
    `&sl=${encodeURIComponent(options.from ?? 'auto')}` +
    `&tl=${encodeURIComponent(options.to ?? 'en')}` +
    `&q=${encodeURIComponent(source)}`;

  try {
    const response = await doFetch(url);
    if (!response.ok) return { ok: false, error: `the translator answered ${response.status}` };

    const parsed = (await response.json()) as unknown;
    // Shape: [ [ [translated, original, ...], ... ], ..., detectedLanguage, ... ]
    if (!Array.isArray(parsed)) return { ok: false, error: 'the translator sent an unexpected shape' };

    const chunks = (parsed[0] as Array<unknown> | undefined) ?? [];
    const translated = chunks
      .map((chunk) => (Array.isArray(chunk) ? String((chunk as unknown[])[0] ?? '') : ''))
      .join('');

    if (!translated) return { ok: false, error: 'the translator returned nothing' };

    return {
      ok: true,
      text: translated,
      ...(typeof parsed[2] === 'string' ? { detected: parsed[2] } : {}),
    };
  } catch (error) {
    return { ok: false, error: String((error as Error).message ?? error) };
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   Text to speech
   ══════════════════════════════════════════════════════════════════════════ */

export interface TtsOptions {
  /** Language code. Default `'en'`. */
  lang?: string;
  /** Playback speed, 0.5..2. Default 1. */
  speed?: number;
  fetch?: FetchLike;
}

export interface TtsResult {
  ok: boolean;
  audio?: Buffer;
  error?: string;
}

/**
 * Text to a voice-note-sized MP3.
 *
 * Same reasoning as `translate`: no key, no library, injectable client, and a
 * failure that says what happened. The caller sends the buffer with
 * `sendVoiceNote`, which is where the Opus conversion happens.
 */
export async function textToSpeech(text: string, options: TtsOptions = {}): Promise<TtsResult> {
  const source = String(text ?? '').trim();
  if (!source) return { ok: false, error: 'nothing to say' };
  // The endpoint caps the query at 200 characters. Saying so beats sending half a
  // sentence and letting the user wonder why the voice stops mid-word.
  if (source.length > 200) return { ok: false, error: 'text too long for one voice note (200 characters max)' };

  const doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (typeof doFetch !== 'function') return { ok: false, error: 'no fetch available in this runtime' };

  const speed = Math.min(2, Math.max(0.5, options.speed ?? 1));
  const url =
    'https://translate.google.com/translate_tts?client=tw-ob' +
    `&ie=UTF-8&tl=${encodeURIComponent(options.lang ?? 'en')}` +
    `&ttsspeed=${speed}&q=${encodeURIComponent(source)}`;

  try {
    const response = await doFetch(url);
    if (!response.ok) return { ok: false, error: `the voice service answered ${response.status}` };
    const audio = Buffer.from(await response.arrayBuffer());
    if (!audio.length) return { ok: false, error: 'the voice service sent no audio' };
    return { ok: true, audio };
  } catch (error) {
    return { ok: false, error: String((error as Error).message ?? error) };
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   Templates — welcome and goodbye
   ══════════════════════════════════════════════════════════════════════════ */

export interface TemplateVars {
  /** The person the message is about. */
  user?: string;
  /** The group's subject. */
  group?: string;
  /** Member count after the change. */
  count?: number;
  /** Anything else the bot wants to expose. */
  [key: string]: string | number | undefined;
}

/**
 * Fill `{placeholders}` in a template.
 *
 * Two rules, both learned from what the scripts get wrong:
 *
 * 1. **An unknown placeholder is left as written**, not replaced with `undefined`.
 *    A group greeting that reads `Welcome undefined!` is worse than one that reads
 *    `Welcome {name}!` — the second is visibly a template mistake, the first looks
 *    like the bot is broken.
 * 2. **`{count}` gets a word, not a number**, when it is used next to one: the
 *    caller passes `count` and gets `12`; the scripts render `You are member 12`
 *    with no agreement anywhere. Keep numbers bare here and let the template say
 *    the words.
 */
export function renderTemplate(template: string, vars: TemplateVars = {}): string {
  return String(template ?? '').replace(/\{(\w+)\}/g, (whole, key: string) => {
    const value = vars[key];
    if (value === undefined || value === null) return whole;
    return String(value);
  });
}

/** The default greeting, when a group has not set one. */
export const DEFAULT_WELCOME =
  '*Welcome to {group}*, {user}!\nYou are member #{count}.\n\nSay hello, or send *flux* to see what I can do.';

/** The default farewell. */
export const DEFAULT_GOODBYE = '*{user}* left {group}.\n{count} members left.';
