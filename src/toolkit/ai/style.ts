/**
 * FLUX HOUSE STYLE — deterministic typography.
 *
 * ## What this actually is
 *
 * WhatsApp has no font selection. One sans-serif face, four markers: `*bold*`,
 * `_italic_`, `~strikethrough~`, and triple-backtick monospace. There is no
 * gothic, no size control, no per-message typeface.
 *
 * So "good fonts" can only mean: **who decides which words carry which marker.**
 * Left to the model, formatting is a lottery — it bolds one reply and not the
 * next, half-bolds a list, forgets a code fence mid-message. So this module
 * decides, from rules, so every message comes out looking the same.
 *
 * ## The house rules
 *
 * | Content | Treatment | Why |
 * |---|---|---|
 * | A short leading line | bold | reads as a heading without an unrenderable `#` |
 * | List bullet | `• `, never `- ` | the list title is what the eye needs first |
 * | Inline code, jids, paths, `flux` commands | monospace | the one thing that must not be misread |
 * | A warning or failure line | bold | it should not be scannable-and-missed |
 * | A URL | bare, no markdown link | WhatsApp makes it a tap target itself |
 * | Everything else | plain | — |
 *
 * ## The hard constraints
 *
 * - **Deterministic.** Same input, same output, always. No model call, no
 *   randomness — otherwise the bot looks like it has a personality disorder.
 * - **Never doubles a marker.** Applying bold to already-bold text would produce
 *   `*\*bold\**`, which renders as literal asterisks. Every transform checks the
 *   span is currently unstyled first.
 * - **Never breaks balance.** Every marker it opens, it closes.
 * - **Quiet by default.** A message with nothing to emphasise comes back
 *   unchanged. Restraint is the whole point.
 */

import { sanitizeTypography, checkFormatting } from './identity.js';

type AnySock = Record<string, any>;

/* ════════════════════════════════════════════════════════════════════════
   Span model
   ════════════════════════════════════════════════════════════════════════ */

/**
 * Is this character range already inside a marker?
 *
 * The transform needs this so it never wraps text that is already styled. The
 * naive alternative — regex on the output — is what produces `*\*bold\**`.
 */
function styledSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];

  for (const marker of ['*', '_', '~', MONO]) {
    const width = marker.length;
    let from = 0;

    for (;;) {
      const open = text.indexOf(marker, from);
      if (open === -1) break;
      const close = text.indexOf(marker, open + width);
      if (close === -1) break;

      // Code fences hold no internal markers — treat the whole run as opaque.
      if (marker === '```') {
        spans.push([open, close + width]);
        from = close + width;
        continue;
      }

      spans.push([open, close + width]);
      from = close + width;
    }
  }

  return spans;
}

function isStyled(spans: Array<[number, number]>, start: number, end: number): boolean {
  return spans.some(([from, to]) => start >= from && end <= to);
}

/* ════════════════════════════════════════════════════════════════════════
   Transforms
   ════════════════════════════════════════════════════════════════════════ */

/**
 * WhatsApp's monospace delimiter.
 *
 * **Triple** backticks, never a single one. WhatsApp has no single-backtick
 * inline code — a lone `` `foo` `` renders as *literal backticks around the
 * word*, which is worse than no styling at all. Triple backticks work inline on
 * one line, which is what makes per-term monospace possible here.
 */
const MONO = '```';

/** Lines that should carry weight regardless of their position. */
const URGENT = /\b(failed|failure|error|cannot|can't|couldn't|could not|denied|refused|rejected|warning|urgent|critical|not approved|not permitted|blocked|expired|unavailable)\b/i;

/** Things that are literally code and must not be re-worded. */
const CODEISH = [
  /\b\d[\w.+-]*@s\.whatsapp\.net\b/g,        // jids
  /\b\w[\w.+-]*@[\w.-]+\.\w{2,}\b/g,          // emails, domains
  /\bhttps?:\/\/\S+/g,                          // urls
  /\b[\w./-]+\.(?:js|ts|json|md|txt|log|yml|yaml|png|jpe?g|mp4|mp3|ogg|pdf)\b/gi,
  /\bflux\s+[a-z]+/gi,                          // our own commands
  /\b0x[0-9a-f]{4,}\b/gi,
  /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g,     // addresses, ports
  /\b[1-5]\d\d\b(?=\s|$)/g,                     // HTTP status codes
];

/** Words that read better in monospace than in prose. */
const INLINE_CODE = /\b(sha256|base64|sha1|md5|utf-8|json|yaml|tsx?|jsx?|npm|node|git|env)\b/g;

/** WhatsApp bullet. A hyphen reads as a typo; this is the client's own glyph. */
const BULLET = '• ';

/* ── list handling ───────────────────────────────────────────────── */

/**
 * Normalise list markers and bold the list title.
 *
 * A list whose title is indistinguishable from its items is the single most
 * common unstyled output — the reader scans straight past it.
 */
function styleList(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inList = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const isItem = /^\s*[-*•]\s+\S/.test(line);

    if (isItem) {
      // `- item` → `• item`. Ordered lists keep their numbers; the `1.` after a
      // `•` would render as a literal and read as noise.
      out.push(line.replace(/^(\s*)[-*]\s+/, (_m, indent: string) => `${indent}${BULLET}`)
        .replace(/^(\s*)\d+[.)]\s+/, (_m, indent: string) => `${indent}${BULLET}`));

      if (!inList) {
        inList = true;
        // The line above the first item is the list's title.
        const title = out[out.length - 2];
        if (title && title.trim() && !isStyled(styledSpans(text), 0, 0)) {
          const prev = out[out.length - 2] as string;
          if (!/[*_~`]/.test(prev)) out[out.length - 2] = `*${prev.trim()}*`;
        }
      }
      continue;
    }

    // A non-item line ends the list. A short one after it is a new title.
    if (inList && line.trim() && line.trim().length <= 60 && !URGENT.test(line)) {
      inList = false;
    }

    out.push(line);
  }

  return out.join('\n');
}

/* ── monospace ────────────────────────────────────────────────────── */

/**
 * Wrap code-ish spans in monospace, skipping anything already styled.
 *
 * Spans are recomputed after every pattern. Reusing a stale span list is what
 * produced ``` ``jid`` ``` — the jid pattern re-matched the *inside* of a span it
 * had just wrapped, because the list still said "unstyled".
 */
function styleCode(text: string): string {
  let out = text;

  for (const pattern of [...CODEISH, INLINE_CODE]) {
    out = out.replace(pattern, (match, ...rest) => {
      const offset = typeof rest[rest.length - 2] === 'number' ? rest[rest.length - 2] as number : out.indexOf(match);
      const spans = styledSpans(out);
      if (isStyled(spans, offset, offset + match.length)) return match;
      return `${MONO}${match}${MONO}`;
    });
  }

  return out;
}

/* ── emphasis ─────────────────────────────────────────────────────── */

/** Bold a leading heading line. Short, first, and not already styled. */
function styleHeading(text: string): string {
  const lines = text.split('\n');
  const first = lines[0] ?? '';
  const trimmed = first.trim();

  if (!trimmed) return text;
  // Too long to be a heading, or already marked.
  if (trimmed.length > 60) return text;
  if (/[*_~`]/.test(trimmed)) return text;
  // A bare sentence reads fine without it; a label or a question reads better with.
  if (!(/[:?!]$/.test(trimmed) || /^[A-Z][\w\s'’-]{2,40}$/.test(trimmed))) return text;

  lines[0] = `*${trimmed}*`;
  return lines.join('\n');
}

/** Bold the urgent lines. A failure should not be scannable-and-missed. */
function styleUrgency(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || !URGENT.test(trimmed)) return line;
      if (/[*_~`]/.test(trimmed)) return line;
      // Keep the bullet: the emphasis goes on the text, not the marker.
      const bullet = trimmed.startsWith(BULLET) ? BULLET : '';
      const body = bullet ? trimmed.slice(BULLET.length) : trimmed;
      const lead = line.slice(0, line.indexOf(trimmed));
      return `${lead}${bullet}*${body}*`;
    })
    .join('\n');
}

/** Bold the term in a `Term: value` pair. The label is the scannable part. */
function styleLabels(text: string): string {
  return text.replace(
    /^(\s*(?:[•-]\s*)?)([A-Z][\w /-]{2,24}):(?=\s+\S)/gm,
    (match, lead: string, label: string) => {
      if (label.includes('*')) return match;
      return `${lead}*${label.trim()}*:${match.slice(lead.length + label.length + 1)}`;
    },
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Entry point
   ════════════════════════════════════════════════════════════════════════ */

/**
 * Apply the house style.
 *
 * Order matters and is not arbitrary:
 *
 *  1. lists — so the bullet normalisation happens before anything reads a line
 *  2. code — before emphasis, so a jid inside an already-bold line is caught
 *  3. urgency — after code, so `error` inside monospace is not double-wrapped
 *  4. labels and heading — last, when the text is otherwise final
 *
 * Returns the input unchanged when there was nothing worth styling. A bot that
 * shouts on every message is as unreadable as one that never styles anything.
 */
export function houseStyle(input: string): string {
  let text = sanitizeTypography(String(input ?? ''));
  if (!text.trim()) return text;

  // Never restyle something already authored deliberately — a block that is
  // entirely marked is a code sample or a pre-formatted reply.
  if ((text.match(/[*_~]/g) ?? []).length >= 6) return text;

  text = styleList(text);
  text = styleCode(text);
  text = styleUrgency(text);
  text = styleLabels(text);
  text = styleHeading(text);

  // Whitespace tidy-up. Never more than one blank line between blocks, and no
  // leading or trailing padding.
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Apply the house style and report what changed. */
export function restyle(input: string): {
  text: string;
  changed: boolean;
  problems: string[];
} {
  const styled = houseStyle(input);
  return {
    text: styled,
    changed: styled !== String(input ?? ''),
    problems: checkFormatting(styled),
  };
}

/* ════════════════════════════════════════════════════════════════════════
   Calibration
   ════════════════════════════════════════════════════════════════════════ */

export interface Example {
  before: string;
  after: string;
}

/**
 * The house style, demonstrated.
 *
 * Kept as data rather than prose so it can be asserted in tests and shown to
 * anyone who asks "what does it actually do". These are the exact outputs
 * `houseStyle()` produces for these exact inputs.
 */
export const HOUSE_STYLE_EXAMPLES: Example[] = [
  {
    before: 'Commands:\n- flux ping\n- flux help',
    after: '*Commands:*\n• ```flux ping```\n• ```flux help```',
  },
  {
    before: 'The download failed: 403',
    after: '*The download failed*: ```403```',
  },
  {
    before: 'Sent to 62882017467912@s.whatsapp.net at 20:11',
    after: 'Sent to ```62882017467912@s.whatsapp.net``` at 20:11',
  },
  {
    before: 'Ready.',
    after: 'Ready.',
  },
];

/** Does this reply read as styled, or as a wall of plain text? */
export function styleScore(text: string): { markers: number; styled: boolean } {
  const markers = (text.match(/\*[*]?|_|~|\`\`\`/g) ?? []).length;
  return { markers, styled: markers >= 2 };
}