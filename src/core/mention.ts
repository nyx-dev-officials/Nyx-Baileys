/**
 * Message parsing.
 *
 * Every bot command starts by taking a raw `WAMessage` apart: what did they
 * type, who were they replying to, which command was it, what were the
 * arguments. rc14 spreads that across a dozen fields depending on the message
 * type, and the differences are exactly the kind that fail quietly — a command
 * that runs on plain text and silently stops matching once the reply comes
 * through as an `extendedTextMessage`, with no error anywhere.
 *
 * So the traversal lives in one place. `parseIncoming` answers all of it at
 * once and always returns every field, so a caller never has to know whether a
 * given message happened to be an ephemeral or a view-once.
 *
 * Only `import type` touches Baileys here, so this is on the `lite` entry.
 */

import type { WAMessage } from '@whiskeysockets/baileys';

import { contextOf } from './media.js';

type Dict = Record<string, unknown>;

/**
 * Wrapper fields that hold the real message one level down.
 *
 * `editedMessage` and `documentWithCaptionMessage` nest it under `message`;
 * the rest repeat their own key. Both shapes occur in the wild, so both are
 * listed with the sub-key to descend into.
 */
const WRAPPERS: ReadonlyArray<readonly [string, string]> = [
  ['ephemeralMessage', 'ephemeralMessage'],
  ['viewOnceMessage', 'viewOnceMessage'],
  ['viewOnceMessageV2', 'viewOnceMessage'],
  ['viewOnceMessageV2Extension', 'viewOnceMessage'],
  ['editedMessage', 'message'],
  ['documentWithCaptionMessage', 'message'],
  ['protocolMessage', 'message'],
];

const asDict = (value: unknown): Dict | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Dict) : null;

/**
 * Descend through a wrapper's inner key, tolerating a flat wrapper.
 *
 * `viewOnceMessageV2` holds its payload under `viewOnceMessage`, but a bare
 * `viewOnceMessage` holds it directly — and rc14 emits both shapes depending on
 * version and client. Falling back to the wrapper itself is what keeps
 * `{viewOnceMessage: {conversation}}` from unwrapping to nothing.
 */
const descend = (holder: Dict, inner: string): Dict => asDict(holder[inner]) ?? holder;

/**
 * The display text of a message, or null if it carries none.
 *
 * rc14 wraps a forwarded message in `ephemeralMessage` and a view-once in its
 * own wrapper, with the real content one level down. Those are unwrapped here
 * rather than in every caller — and unwrapped repeatedly, since a forwarded
 * view-once is both.
 */
export function extractText(msg: WAMessage): string | null {
  let body = asDict(msg.message);
  if (!body) return null;

  // Descend through wrappers. Bounded so a hand-crafted message that nests a
  // wrapper inside itself cannot spin here.
  for (let depth = 0; depth < 8; depth += 1) {
    const wrapper = WRAPPERS.find(([field]) => asDict(body?.[field]) !== null);
    if (!wrapper) break;
    const [field, inner] = wrapper;
    body = descend(asDict(body?.[field]) ?? {}, inner);
  }

  if (typeof body.conversation === 'string' && body.conversation !== '') return body.conversation;

  const extended = asDict(body.extendedTextMessage);
  if (typeof extended?.text === 'string' && extended.text !== '') return extended.text;

  for (const field of ['imageMessage', 'videoMessage', 'documentMessage'] as const) {
    const caption = asDict(body[field])?.caption;
    if (typeof caption === 'string' && caption !== '') return caption;
  }

  return null;
}

export interface QuotedMessage {
  /** Message id being replied to. */
  id: string;
  /** Who was replied to, when the sender is known. */
  participant: string | null;
  /** The quoted message's own text. */
  text: string | null;
}

/**
 * The message this one quotes, or null.
 *
 * `parentKeyOf` finds a parent by association, which also covers albums — so the
 * context is checked for `quotedMessage` specifically, not merely for an
 * association being present.
 */
export function extractQuoted(msg: WAMessage): QuotedMessage | null {
  const ctx = asDict(contextOf(msg));
  const quoted = asDict(ctx?.quotedMessage);
  if (!quoted) return null;

  const participant = quoted.participant;
  return {
    id: String(quoted.stanzaId ?? msg.key?.id ?? ''),
    participant: typeof participant === 'string' && participant !== '' ? participant : null,
    text: typeof quoted.text === 'string' ? quoted.text : null,
  };
}

/**
 * Jids mentioned in the body, in order, without duplicates.
 *
 * WhatsApp renders `@1555…` in the UI but delivers the full jid in
 * `contextInfo.mentionedJid`, so the body itself is not parsed for handles —
 * doing that produces false positives on any number in a sentence.
 */
export function extractMentions(msg: WAMessage): string[] {
  const ctx = asDict(contextOf(msg));
  const listed = ctx?.mentionedJid;
  if (!Array.isArray(listed)) return [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of listed) {
    const jid = String(entry);
    if (jid === '' || seen.has(jid)) continue;
    seen.add(jid);
    out.push(jid);
  }
  return out;
}

/**
 * Split a command tail into arguments, honouring double quotes.
 *
 * `kick "Ada Lovelace" twice` → `['Ada Lovelace', 'twice']`. A backslash escapes
 * the next character, so a quote or a space inside a word survives.
 *
 * Only `"` quotes. Single quotes are left literal on purpose: a chat bot
 * parses prose, and treating `'` as a quote opener turns `it's fine` into the
 * single argument `its fine`, because the apostrophe never closes.
 *
 * Named `parseCommandArgs` rather than `parseArgs`: `utils/args.ts` already
 * exports a `parseArgs` that parses process argv, and the package root
 * re-exports both — so a second `parseArgs` here would silently shadow the one
 * callers already use, depending on which import wins.
 */
export function parseCommandArgs(raw: string): string[] {
  const args: string[] = [];
  let current = '';
  let quoted = false;
  let escaped = false;
  let started = false;

  for (const char of raw) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      started = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      // An empty quoted string is still an argument.
      started = true;
      continue;
    }
    if (/\s/.test(char) && !quoted) {
      if (started) args.push(current);
      current = '';
      started = false;
      continue;
    }
    current += char;
    started = true;
  }

  if (started) args.push(current);
  return args;
}

export interface ParseOptions {
  /** Command prefix. Default `'.'`. Set to `''` for prefix-less bots. */
  prefix?: string;
  /** This bot's own jid, so a self-mention can be stripped from the body. */
  selfJid?: string;
  /** Lowercase number the user has set as their command prefix. */
  altPrefix?: string | null;
}

export interface ParsedCommand {
  /** Command name, lowercased and without the prefix. Null when not a command. */
  name: string | null;
  /** Everything after the command name. */
  argString: string;
  /** `argString` split into arguments. */
  args: string[];
  /** The raw body, with any leading mention of the bot removed. */
  body: string;
  /** Whether the body was a command at all. */
  isCommand: boolean;
}

/**
 * Take a message apart into the pieces a command dispatcher needs.
 *
 * The quoted text is stripped from the body so a reply to "run kick" does not
 * re-trigger it, and a leading `@bot` is removed so the same command works
 * whether it is typed in a group or in a DM. `body` is what is left; the
 * untouched text is still available from `text`.
 */
export function parseIncoming(msg: WAMessage, options: ParseOptions = {}): ParsedCommand & { text: string | null; mentions: string[]; quoted: QuotedMessage | null } {
  const prefix = options.prefix ?? '.';
  const text = extractText(msg);
  const mentions = extractMentions(msg);
  const quoted = extractQuoted(msg);

  let body = text ?? '';

  // Drop a quoted line, so replying does not replay the quoted command.
  if (quoted?.text) {
    const quotedText = quoted.text.trim();
    if (quotedText && body.trimStart().startsWith(quotedText)) {
      body = body.trimStart().slice(quotedText.length);
    }
  }

  body = body.trim();

  // Drop a leading mention of this bot, in a group. Only the first token, and
  // only when it is the bot itself, so `@someone run kick` still works.
  if (options.selfJid && mentions.includes(options.selfJid)) {
    const pattern = new RegExp(`^@?\\S+\\s+`);
    body = body.replace(pattern, '');
  }

  const candidates = [prefix, options.altPrefix]
    .filter((p): p is string => typeof p === 'string')
    // Longest first, so a one-character prefix cannot shadow a longer one the
    // user configured. An empty prefix is kept out: it means "no prefix at
    // all", handled below rather than treated as a prefix that always matches.
    .filter((p) => p !== '')
    .sort((a, b) => b.length - a.length);

  let hit: string | null = null;
  if (prefix === '') {
    // A prefix-less bot: every message is a command.
    hit = '';
  } else {
    for (const candidate of candidates) {
      if (body.startsWith(candidate)) {
        hit = candidate;
        break;
      }
    }
  }

  if (hit === null) {
    return { text, mentions, quoted, body, name: null, argString: '', args: [], isCommand: false };
  }

  const rest = body.slice(hit.length).trim();
  if (rest === '') {
    // A bare prefix is a request for help, not a nameless command.
    return { text, mentions, quoted, body, name: '', argString: '', args: [], isCommand: true };
  }

  const spaceAt = rest.search(/\s/);
  const name = (spaceAt === -1 ? rest : rest.slice(0, spaceAt)).toLowerCase();
  const argString = spaceAt === -1 ? '' : rest.slice(spaceAt).trim();

  return {
    text,
    mentions,
    quoted,
    body,
    name,
    argString,
    args: parseCommandArgs(argString),
    isCommand: true,
  };
}
