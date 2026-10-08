/**
 * OPS-250 · message construction helpers.
 *
 * These build `AnyMessageContent` objects. Nothing here sends — the caller
 * decides what to do with the shape, which keeps them testable and composable.
 *
 * Every helper is annotated with the rc14 trap it exists to avoid.
 */

import { randomBytes } from 'node:crypto';

import type { AnySock } from '../ops-50/types.js';

/* ── 131-140 · text ──────────────────────────────────────────────── */

/**
 * WhatsApp's own text dialect.
 *
 * Single asterisk is bold, double is italic, triple is monospace, a tilde
 * strikes. These are the characters WhatsApp itself uses — markdown will not
 * render, which is the most common reason a formatted message looks plain.
 */
export interface TextStyle {
  bold?: boolean;
  italic?: boolean;
  mono?: boolean;
  strike?: boolean;
}

export function styleText(text: string, style: TextStyle = {}): string {
  let out = text;
  if (style.strike) out = `~${out}~`;
  if (style.mono) out = `\`\`\`${out}\`\`\``;
  if (style.italic) out = `_${out}_`;
  if (style.bold) out = `*${out}*`;
  return out;
}

/** Collapse newlines to a single space, for one-line surfaces. */
export function oneLine(text: string): string {
  // Collapse every whitespace run — newlines, tabs, or repeated spaces — into
  // a single space. A newline-only rule leaves double spaces behind.
  return text.replace(/\s+/g, ' ').trim();
}

/** Truncate on a word boundary, appending an ellipsis when cut. */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Word count, for length checks before sending. */
export function textWordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** Split long text into chunks under a limit, preferring paragraph breaks. */
export function splitText(text: string, max: number): string[] {
  if (text.length <= max) return [text];

  const out: string[] = [];
  let rest = text;

  while (rest.length > max) {
    const slice = rest.slice(0, max);
    // Prefer a paragraph break, then a space, then a hard cut.
    const para = slice.lastIndexOf('\n\n');
    const space = slice.lastIndexOf(' ');
    const at = para > max * 0.5 ? para : space > max * 0.5 ? space : max;
    out.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).replace(/^\n+/, '');
  }

  if (rest) out.push(rest);
  return out;
}

/** Escape the WhatsApp formatting characters so literal text stays literal. */
export function escapeMarkup(text: string): string {
  return text.replace(/([*_~`])/g, '\\$1');
}

/** A code block, which is the only reliable way to show formatting literally. */
export function codeBlock(text: string, lang = ''): string {
  return `\`\`\`${lang}\n${text}\n\`\`\``;
}

/* ── 141-150 · message payload shapes ────────────────────────────── */

/**
 * A quoted reply.
 *
 * rc14's option is named `quoted`, not `contextInfo`, and the value is the
 * **whole message**, not a key. Passing a bare key produces a quote that
 * renders empty.
 */
export function replyTo(message: unknown): { quoted: unknown } {
  return { quoted: message };
}

/** Mentions, as `sendMessage` wants them — plain jids, not text. */
export function mention(jids: string[]): { mentions: string[] } {
  return { mentions: jids };
}

/** Render the `@` display form for a jid, for use in text. */
export function mentionText(jid: string): string {
  const digits = jid.split('@')[0]?.split(':')[0] ?? jid;
  return `@${digits}`;
}

/**
 * A location pin.
 *
 * `degreesLatitude` and `degreesLongitude` are **required doubles**. Missing
 * either means the pin does not render, and rc14 will not tell you why.
 */
export function location(lat: number, lon: number, name?: string, address?: string): Record<string, unknown> {
  return {
    location: {
      degreesLatitude: lat,
      degreesLongitude: lon,
      ...(name ? { name } : {}),
      ...(address ? { address } : {}),
    },
  };
}

/** A poll. `selectableCount > 1` makes it multi-select. */
export function poll(question: string, options: string[], selectableCount = 1): Record<string, unknown> {
  return {
    poll: {
      name: question,
      values: options,
      selectableCount,
    },
  };
}

/** A reaction stanza payload. `remove` takes the same shape with an empty key. */
export function reaction(emoji: string): Record<string, unknown> {
  return { react: { text: emoji } };
}

/** Remove a reaction. */
export function unreact(): Record<string, unknown> {
  return { react: { text: '' } };
}

/** A vCard contact card. */
export function contactCard(name: string, vcard?: string): Record<string, unknown> {
  return {
    contacts: {
      displayName: name,
      contacts: [{ vcard: vcard ?? `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nEND:VCARD` }],
    },
  };
}

/** Pin a chat. This is `chatModify`, not a content key. */
export function pinChat(sock: AnySock, jid: string, on = true): Promise<void> {
  return sock.chatModify(on ? 'pin' : 'unpin', jid);
}

/** Archive or unarchive a chat. Also `chatModify`. */
export function archiveChat(sock: AnySock, jid: string, on = true): Promise<void> {
  return sock.chatModify(on ? 'archive' : 'unarchive', jid);
}

/** Star or unstar a message. Also `chatModify`. */
export function starSingleMessage(sock: AnySock, jid: string, messageId: string, on = true): Promise<void> {
  return sock.chatModify(on ? 'star' : 'unstar', jid, messageId);
}

/* ── 151-160 · validation ────────────────────────────────────────── */

export interface MessageValidationIssue {
  field: string;
  problem: string;
}

/** Validate a message before sending, so failures are local and explicit. */
export function validateMessage(content: Record<string, any>): MessageValidationIssue[] {
  const issues: MessageValidationIssue[] = [];
  const keys = Object.keys(content ?? {});

  if (keys.length === 0) issues.push({ field: '(none)', problem: 'empty content' });

  if (content.text !== undefined) {
    if (typeof content.text !== 'string') {
      issues.push({ field: 'text', problem: 'must be a string' });
    } else if (content.text.length > 65_536) {
      issues.push({ field: 'text', problem: 'exceeds WhatsApp text limit' });
    }
  }

  for (const key of ['image', 'video', 'audio', 'document', 'sticker'] as const) {
    const value = content[key];
    if (value === undefined) continue;
    if (!Buffer.isBuffer(value)) {
      // The exact shape that silently fails.
      issues.push({ field: key, problem: 'must be a Buffer, not a nested object' });
    } else if (value.length === 0) {
      issues.push({ field: key, problem: 'buffer is empty' });
    }
  }

  for (const key of ['degreesLatitude', 'degreesLongitude'] as const) {
    const loc = content.location;
    if (loc !== undefined && typeof loc[key] !== 'number') {
      issues.push({ field: `location.${key}`, problem: 'must be a number' });
    }
  }

  if (content.poll !== undefined) {
    const values = content.poll?.values;
    if (!Array.isArray(values) || values.length < 2) {
      issues.push({ field: 'poll.values', problem: 'needs at least two options' });
    }
  }

  return issues;
}

/** Throwing wrapper around `validateMessage`. */
export function assertValidMessage(content: Record<string, any>): void {
  const issues = validateMessage(content);
  if (issues.length > 0) {
    const detail = issues.map((i) => `${i.field}: ${i.problem}`).join('; ');
    throw new Error(`invalid message — ${detail}`);
  }
}

/** A random key, for when one is structurally required but carries no meaning. */
export function randomKey(): string {
  return randomBytes(16).toString('hex').toUpperCase();
}