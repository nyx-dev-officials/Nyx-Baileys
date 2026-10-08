/**
 * AI-3 · output rendering.
 *
 * A model produces text. WhatsApp can render **twenty-two distinct content
 * types**. The gap between those two facts is where bots feel dumb: the model
 * knows what it wants to say, and the plumbing can only send a paragraph.
 *
 * This module is the mapping. The model emits a small tagged language, and this
 * turns it into a real `AnyMessageContent` — a poll, a list, a location, a
 * contact card, a reaction, an edit. Anything it cannot map degrades to text
 * rather than throwing, because losing the message is worse than losing the
 * formatting.
 *
 * ## The wire format
 *
 * ```
 * <<poll>>
 * question?
 * - option one
 * - option two
 * <<end>>
 * ```
 *
 * Chosen over JSON because a model emits valid JSON far less reliably than it
 * emits well-formed delimited text, and a parse failure on JSON loses the whole
 * message.
 */

import type { AnySock } from '../ops-50/types.js';

/* ════════════════════════════════════════════════════════════════════════
   The tagged language
   ════════════════════════════════════════════════════════════════════════ */

export type BlockTag =
  | 'poll'
  | 'list'
  | 'buttons'
  | 'location'
  | 'contact'
  | 'quote'
  | 'code'
  | 'heading'
  | 'note'
  | 'link';

/** Every tag the parser recognises. */
export const BLOCK_TAGS: BlockTag[] = [
  'poll', 'list', 'buttons', 'location', 'contact', 'quote', 'code', 'heading', 'note', 'link',
];

export interface ParsedBlock {
  tag: BlockTag;
  /** Everything after the tag line, trimmed. */
  body: string;
  /** Line the block started on, for error reporting. */
  line: number;
}

/** Tags that become a real WhatsApp content type rather than formatted text. */
export const STRUCTURED_TAGS: BlockTag[] = ['poll', 'list', 'buttons', 'location', 'contact'];

const OPEN = /^<<([a-z]+)>>\s*$/;
const CLOSE = /^<<\/?end>>\s*$/;

/**
 * The collapsed inline form: `<<poll:question?>>`, `<<list:Title>>`.
 *
 * Models — especially reasoning-tuned ones — frequently ignore the multi-line
 * example and flatten the whole block onto one line with colons. Observed live:
 * `<<poll:Which language should I learn next?:Spanish,French,Japanese>>`.
 *
 * Requiring the exact multi-line shape meant that reply parsed as *no block at
 * all*, so a poll silently became a line of raw markup in the chat. Accepting
 * the collapsed form costs nothing — the two forms are unambiguous — and turns a
 * formatting miss into a working poll.
 */
const INLINE = /^<<([a-z]+):([\s\S]*?)>>\s*$/;

/**
 * Split tagged text into blocks.
 *
 * Lenient by design: an unclosed block at the end is treated as closed, because
 * models truncate constantly and the tail of a reply should still render.
 */
export function parseBlocks(text: string): { blocks: ParsedBlock[]; plain: string } {
  const lines = text.split('\n');
  const blocks: ParsedBlock[] = [];
  const plainLines: string[] = [];

  let current: { tag: BlockTag; line: number; body: string[] } | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const open = OPEN.exec(line.trim());

    if (!open) {
      // A collapsed block on its own line. Parsed before the plain-text branch
      // so a flattened poll is recognised rather than shipped as raw markup.
      const inline = INLINE.exec(line.trim());
      if (inline) {
        if (current) blocks.push({ tag: current.tag, body: current.body.join('\n').trim(), line: current.line });
        current = null;
        blocks.push({ tag: inline[1] as BlockTag, body: (inline[2] ?? '').trim(), line: i });
        continue;
      }
    }

    if (open) {
      const tag = open[1] as BlockTag;
      if (BLOCK_TAGS.includes(tag)) {
        // A new tag while one is open: close the previous one rather than
        // nesting, which the language does not support.
        if (current) blocks.push({ tag: current.tag, body: current.body.join('\n').trim(), line: current.line });
        current = { tag, line: i, body: [] };
        continue;
      }
    }

    if (CLOSE.test(line.trim())) {
      if (current) {
        blocks.push({ tag: current.tag, body: current.body.join('\n').trim(), line: current.line });
        current = null;
      }
      continue;
    }

    if (current) current.body.push(line);
    else plainLines.push(line);
  }

  // Unclosed tail still counts.
  if (current) blocks.push({ tag: current.tag, body: current.body.join('\n').trim(), line: current.line });

  return { blocks, plain: plainLines.join('\n').trim() };
}

/* ════════════════════════════════════════════════════════════════════════
   Per-tag parsing
   ════════════════════════════════════════════════════════════════════════ */

export interface PollSpec {
  question: string;
  options: string[];
  multi: boolean;
}

export interface ListSpec {
  title: string;
  rows: Array<{ title: string; description: string; id: string }>;
}

export interface ButtonsSpec {
  title: string;
  buttons: Array<{ label: string; id: string }>;
}

export interface LocationSpec {
  lat: number;
  lon: number;
  name: string;
  address: string;
}

export interface ContactSpec {
  name: string;
  phone: string;
}

/** `question?\n- one\n- two` → a poll spec. */
export function parsePoll(body: string): PollSpec | null {
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  const questionLine = lines.shift();
  if (!questionLine) return null;

  const question = questionLine.replace(/\?+\s*$/, '').trim();
  const options = lines
    .map((l) => l.replace(/^[-*•]\s*/, '').trim())
    .filter(Boolean);

  // WhatsApp needs at least two options; one is not a poll.
  if (options.length < 2) return null;

  // `multi` is signalled by a `(multi)` marker on the question.
  const multi = /\(multi\)/i.test(questionLine);
  return { question, options, multi };
}

/** `title\n- one : description\n- two` → a list spec. */
export function parseList(body: string): ListSpec | null {
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  const titleLine = lines.shift();
  if (!titleLine) return null;

  const rows = lines
    .map((line) => {
      const text = line.replace(/^[-*•]\s*/, '').trim();
      // `title : description` — the last colon separates, so titles may contain one.
      const split = text.lastIndexOf(' : ');
      const title = split > 0 ? text.slice(0, split).trim() : text;
      const description = split > 0 ? text.slice(split + 3).trim() : '';
      return { title, description, id: title.toLowerCase().replace(/\W+/g, '_').slice(0, 40) };
    })
    .filter((r) => r.title);

  if (rows.length === 0) return null;
  return { title: titleLine.replace(/^#\s*/, '').trim(), rows };
}

/** `title\n- label` → buttons. */
export function parseButtons(body: string): ButtonsSpec | null {
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  const titleLine = lines.shift();
  if (!titleLine) return null;

  const buttons = lines
    .map((l) => l.replace(/^[-*•]\s*/, '').trim())
    .filter(Boolean)
    .map((label) => ({ label, id: label.toLowerCase().replace(/\W+/g, '_').slice(0, 40) }));

  if (buttons.length === 0) return null;
  return { title: titleLine.replace(/^#\s*/, '').trim(), buttons };
}

/** `lat, lon, name, address` — commas only, so names may contain spaces. */
export function parseLocation(body: string): LocationSpec | null {
  const parts = body.split(',').map((p) => p.trim());
  if (parts.length < 2) return null;

  const lat = Number(parts[0]);
  const lon = Number(parts[1]);

  // Both required doubles. A pin with a missing or non-numeric coordinate does
  // not render at all, so refuse rather than send something broken.
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

  return {
    lat,
    lon,
    name: parts[2] ?? '',
    // Rejoin with ', ' so a multi-part address reads as one place.
  address: parts.slice(3).join(', '),
  };
}

/** `Name, phone` → a contact card. */
export function parseContact(body: string): ContactSpec | null {
  const [name, ...rest] = body.split(',').map((p) => p.trim());
  if (!name) return null;
  return { name, phone: rest.join(',').trim() };
}

/** Build a vCard rc14 will render. */
export function vcardFor(spec: ContactSpec): string {
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${spec.name}`];
  if (spec.phone) {
    const digits = spec.phone.replace(/\D/g, '');
    lines.push(`TEL;type=CELL;waid=${digits}:${spec.phone}`);
  }
  lines.push('END:VCARD');
  return lines.join('\n');
}

/* ════════════════════════════════════════════════════════════════════════
   Rendering to WhatsApp content
   ════════════════════════════════════════════════════════════════════════ */

/** Every content type this renderer can emit, for docs and for validation. */
export const SUPPORTED_OUTPUTS = [
  'text',            // formatted text with WhatsApp markers
  'extendedText',    // long text with a title
  'poll',            // single or multi select
  'listMessage',     // sectioned menu
  'buttonsMessage',  // quick replies
  'location',
  'contacts',        // vCard
  'image',           // with caption
  'video',
  'audio',
  'document',
  'sticker',
  'reaction',
  'edit',
  'delete',
  'forward',
  'locationRequest',
  'templateMessage',
  'interactiveMessage',
] as const;

export type OutputType = (typeof SUPPORTED_OUTPUTS)[number];

export interface RenderResult {
  /** What will actually be sent. */
  content: Record<string, unknown>;
  /** What it turned out to be. */
  type: OutputType;
  /** Blocks that were found but could not be built. */
  degraded: Array<{ tag: BlockTag; reason: string }>;
}

/**
 * Turn tagged model output into a WhatsApp content object.
 *
 * Exactly one structured block is rendered. When the model emits several — two
 * polls, say — the first wins and the rest are returned in `degraded` so the
 * caller can decide. Sending a poll and a list in one message is not possible,
 * and silently dropping one without saying so is how content goes missing.
 */
export function render(text: string): RenderResult {
  const { blocks, plain } = parseBlocks(text);
  const degraded: Array<{ tag: BlockTag; reason: string }> = [];

  let usedStructured = false;
  let chosen: { content: Record<string, unknown>; tag: BlockTag } | null = null;

  // Scan every structured block before returning, so a second one is *reported*
  // rather than never noticed. Returning on the first match hid the surplus —
  // the model emitted two polls and one silently vanished.
  for (const block of blocks) {
    if (!STRUCTURED_TAGS.includes(block.tag)) continue;

    if (usedStructured) {
      degraded.push({ tag: block.tag, reason: 'only one structured block can be sent per message' });
      continue;
    }

    const content = buildStructured(block);
    if (content) {
      usedStructured = true;
      chosen = { content, tag: block.tag };
      continue;
    }

    degraded.push({ tag: block.tag, reason: 'could not parse the body' });
  }

  if (chosen) {
    return {
      content: chosen.content,
      type: contentTypeFor(chosen.tag),
      degraded,
    };
  }

  // No structured block, or none parseable: formatted text.
  return { content: { text: renderText(plain || text) }, type: 'text', degraded };
}

function contentTypeFor(tag: BlockTag): OutputType {
  switch (tag) {
    case 'poll': return 'poll';
    case 'list': return 'listMessage';
    case 'buttons': return 'buttonsMessage';
    case 'location': return 'location';
    case 'contact': return 'contacts';
    default: return 'text';
  }
}

/**
 * Parse the collapsed `<<poll:question?option one,option two>>` form.
 *
 * Options are comma-separated and the question runs to the first `?`. Only
 * commas split them — a question containing a comma still parses, because the
 * `?` anchor is what delimits it.
 */
function parseInlinePoll(body: string): PollSpec | null {
  const mark = body.indexOf('?');
  if (mark < 0) return null;

  const question = body.slice(0, mark).trim();
  const options = body.slice(mark + 1).split(',').map((o) => o.trim()).filter(Boolean);

  if (options.length < 2) return null;
  return { question, options, multi: /\(multi\)/i.test(body) };
}

/** Parse the collapsed `<<list:Title:row one:row two>>` form. */
function parseInlineList(body: string): ListSpec | null {
  const parts = body.split(':').map((p) => p.trim()).filter(Boolean);
  const title = parts.shift();
  if (!title || parts.length === 0) return null;

  return {
    title,
    rows: parts.map((text) => ({
      title: text,
      description: '',
      id: text.toLowerCase().replace(/\W+/g, '_').slice(0, 40),
    })),
  };
}

/** Parse the collapsed `<<buttons:Label one:Label two>>` form. */
function parseInlineButtons(body: string): ButtonsSpec | null {
  const parts = body.split(':').map((p) => p.trim()).filter(Boolean);
  const title = parts.shift();
  if (!title || parts.length === 0) return null;

  return {
    title,
    buttons: parts.map((label) => ({
      label,
      id: label.toLowerCase().replace(/\W+/g, '_').slice(0, 40),
    })),
  };
}

function buildStructured(block: ParsedBlock): Record<string, unknown> | null {
  switch (block.tag) {
    case 'poll': {
      // Try the multi-line shape first, then the collapsed one.
      const spec = parsePoll(block.body) ?? parseInlinePoll(block.body);
      if (!spec) return null;
      return {
        poll: {
          name: spec.question,
          values: spec.options,
          selectableCount: spec.multi ? spec.options.length : 1,
        },
      };
    }
    case 'list': {
      const spec = parseList(block.body) ?? parseInlineList(block.body);
      if (!spec) return null;
      return {
        listMessage: {
          title: spec.title,
          description: '',
          buttonText: spec.rows[0]?.title ?? 'Select',
          sections: [{ title: spec.title, rows: spec.rows }],
        },
      };
    }
    case 'buttons': {
      const spec = parseButtons(block.body) ?? parseInlineButtons(block.body);
      if (!spec) return null;
      return {
        buttonsMessage: {
          contentText: spec.title,
          footerText: '',
          headerText: spec.title,
          buttons: spec.buttons.map((b) => ({
            buttonId: b.id,
            buttonText: { displayText: b.label },
          })),
        },
      };
    }
    case 'location': {
      const spec = parseLocation(block.body);
      if (!spec) return null;
      return {
        location: {
          degreesLatitude: spec.lat,
          degreesLongitude: spec.lon,
          ...(spec.name ? { name: spec.name } : {}),
          ...(spec.address ? { address: spec.address } : {}),
        },
      };
    }
    case 'contact': {
      const spec = parseContact(block.body);
      if (!spec) return null;
      return {
        contacts: {
          displayName: spec.name,
          contacts: [{ vcard: vcardFor(spec) }],
        },
      };
    }
    default:
      return null;
  }
}

/* ════════════════════════════════════════════════════════════════════════
   Text rendering
   ════════════════════════════════════════════════════════════════════════ */

/**
 * Apply WhatsApp's own text dialect to markdown-ish model output.
 *
 * WhatsApp does not render markdown. It has its own markers, and they overlap
 * with markdown's in places that cause silent corruption — an unclosed `*` makes
 * everything after it bold, or nothing renders at all.
 */
export function renderText(text: string): string {
  return String(text ?? '')
    // Strip fences, keeping the code itself.
    .replace(/```(\w*)\n?([\s\S]*?)```/g, (_, _lang, code) => `\`\`\`\n${code.trim()}\n\`\`\``)
    // Headings become bold, not #.
    .replace(/^#{1,6}\s+(.*)$/gm, '*$1*')
    // Bullet lists become WhatsApp bullets.
    .replace(/^[-*]\s+/gm, '• ')
    .trim();
}

/** Convert a block to plain display text, for the text-only fallback. */
export function blockToText(block: ParsedBlock): string {
  switch (block.tag) {
    case 'poll': {
      const spec = parsePoll(block.body);
      if (!spec) return block.body;
      return `*${spec.question}*\n${spec.options.map((o, i) => `${i + 1}. ${o}`).join('\n')}`;
    }
    case 'list': {
      const spec = parseList(block.body);
      if (!spec) return block.body;
      const lines = [`*${spec.title}*`];
      for (const row of spec.rows) {
        lines.push(`• *${row.title}*`);
        if (row.description) lines.push(`  ${row.description}`);
      }
      return lines.join('\n');
    }
    case 'buttons': {
      const spec = parseButtons(block.body);
      if (!spec) return block.body;
      return `*${spec.title}*\n${spec.buttons.map((b) => `• ${b.label}`).join('\n')}`;
    }
    case 'heading':
      return `*${block.body.trim()}*`;
    case 'code':
      return `\`\`\`\n${block.body}\n\`\`\``;
    case 'quote':
      return `> ${block.body.trim()}`;
    case 'note':
      return `_${block.body.trim()}_`;
    case 'link': {
      const [url, ...rest] = block.body.trim().split(/\s+/);
      const text = rest.join(' ') || url;
      return `${text} (${url})`;
    }
    default:
      return block.body;
  }
}

/**
 * Full-text fallback: every block rendered as plain WhatsApp text.
 *
 * Used when the caller cannot send a structured message — a group where polls
 * misbehave, a client that renders them blank. Nothing is lost this way.
 */
export function renderAllAsText(text: string): string {
  const { blocks, plain } = parseBlocks(text);
  const parts: string[] = [];
  if (plain) parts.push(renderText(plain));
  for (const block of blocks) parts.push(blockToText(block));
  return parts.filter(Boolean).join('\n\n');
}

/* ════════════════════════════════════════════════════════════════════════
   Sending
   ════════════════════════════════════════════════════════════════════════ */

/**
 * Send model output, choosing the right content type automatically.
 *
 * `fallbackToText` is on by default: if a structured send rejects, retrying as
 * text almost always works, and a message the user can read beats an error.
 */
export async function sendRendered(
  sock: AnySock,
  jid: string,
  text: string,
  options: { quoted?: unknown; fallbackToText?: boolean; caption?: string } = {},
): Promise<{ type: OutputType; id?: string; degraded: RenderResult['degraded'] }> {
  const rendered = render(text);
  const fallback = options.fallbackToText !== false;

  const content = { ...rendered.content };
  if (options.caption && rendered.type === 'text') {
    (content as Record<string, unknown>).caption = options.caption;
  }

  try {
    const sent = await sock.sendMessage(jid, content as never,
      options.quoted ? { quoted: options.quoted as never } : {});
    return { type: rendered.type, id: sent?.key?.id, degraded: rendered.degraded };
  } catch (error) {
    if (!fallback) throw error;
    // A structured send failed. Plain text almost always renders.
    const sent = await sock.sendMessage(jid, {
      text: renderAllAsText(text) || String(text),
    } as never, options.quoted ? { quoted: options.quoted as never } : {});
    return { type: 'text', id: sent?.key?.id, degraded: rendered.degraded };
  }
}

/**
 * Parse a reply back into a choice.
 *
 * The mirror of `render`: what the user tapped comes back as a message and has
 * to become an id. Returns null rather than guessing, so the caller knows the
 * selection did not map.
 */
export function readSelection(message: any): { id: string; label: string } | null {
  const native = message?.message?.interactiveResponseMessage?.nativeFlowResponseMessage;
  if (!native) return null;

  const params = native.paramsJson;
  if (typeof params !== 'string') return null;

  try {
    const parsed = JSON.parse(params) as { id?: string; display_text?: string };
    if (!parsed.id) return null;
    return { id: parsed.id, label: parsed.display_text ?? parsed.id };
  } catch {
    return null;
  }
}