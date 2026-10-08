/**
 * ACCESS · accessibility for generated content.
 *
 * Scope note, because "accessibility" in a WhatsApp library is not what people
 * expect: there is no screen-reader API here and no component tree. What *is*
 * real is that this library authors the **content** users consume — and content
 * has accessibility obligations.
 *
 * Three that are genuinely live on WhatsApp:
 *
 *  1. **Alt text.** WhatsApp surfaces a media caption as the image's
 *     description for screen readers. A caption of `"IMG_4821.jpg"` is worse
 *     than none — it announces a filename. `describeMedia()` writes one.
 *  2. **Not colour-only.** A poll result summarised as "2 red, 1 blue" is
 *     unreadable to a colour-blind user and to anyone in dark mode.
 *  3. **Plain-text fallbacks.** Every structured block has a text form, and a
 *     screen reader reads that reliably where it reads a rendered poll poorly.
 *
 * Deliberately absent: ARIA, roles, focus management. Those apply to a DOM. A
 * `role="button"` inside a WhatsApp message does nothing and would be a lie in
 * the source.
 */

import { renderAllAsText, render, type OutputType } from './ai/output.js';

/* ════════════════════════════════════════════════════════════════════════
   Alt text
   ════════════════════════════════════════════════════════════════════════ */

/** Descriptions that help nobody. */
const USELESS_CAPTIONS = [
  /^\s*$/,
  /^img[_-]?\d+\.(jpe?g|png|webp|gif)$/i,
  /^image\s*\d*$/i,
  /^(screenshot|screen shot|photo|picture|untitled|dokumen|gambar|foto)\s*\d*$/i,
  /^image \d+ of \d+$/i,
  /^\S+\.(jpe?g|png|webp|gif|mp4|mov|pdf)$/i,
  /^(?:screenshot|screen recording)\s*\d*$/i,
  /^[a-z0-9_-]{20,}$/i, // hash-like
];

/**
 * Is this caption useless as alt text?
 *
 * A default or auto-generated caption is the common case and the one worth
 * catching: it is technically present, so a naive check passes, and it announces
 * a filename to a screen-reader user instead of describing anything.
 */
export function isUselessAlt(caption: string | undefined | null): boolean {
  if (caption === undefined || caption === null) return true;
  const text = String(caption).trim();
  if (text.length < 3) return true;
  return USELESS_CAPTIONS.some((re) => re.test(text));
}

/** How long alt text may be before it stops being alt text. */
export const MAX_ALT_LENGTH = 300;

/**
 * Write alt text for media from its own properties.
 *
 * Built from what is actually known — media kind, dimensions, duration, filename
 * — because inventing a description would be a lie in the one place the user
 * trusts it most. Callers with real knowledge should pass `context`.
 */
export function describeMedia(meta: {
  kind: 'image' | 'video' | 'audio' | 'document' | 'sticker';
  fileName?: string;
  widthPx?: number;
  heightPx?: number;
  durationSec?: number;
  /** What the media *is*, from the user's own words. */
  context?: string;
}): string {
  const parts: string[] = [];

  if (meta.context?.trim()) parts.push(meta.context.trim());

  const shape = meta.widthPx && meta.heightPx
    ? `${meta.widthPx} by ${meta.heightPx} pixels`
    : undefined;

  const duration = meta.durationSec && meta.durationSec > 0
    ? formatMediaDuration(meta.durationSec)
    : undefined;

  switch (meta.kind) {
    case 'image':
      parts.push('image', ...(shape ? [shape] : []));
      break;
    case 'video':
      parts.push('video', ...(duration ? [`duration ${duration}`] : []), ...(shape ? [shape] : []));
      break;
    case 'audio':
      parts.push('audio', ...(duration ? [`duration ${duration}`] : []));
      break;
    case 'document':
      parts.push('document', ...(meta.fileName ? [`named ${meta.fileName}`] : []));
      break;
    case 'sticker':
      parts.push('sticker');
      break;
    default:
      parts.push('attachment');
  }

  return parts.join(', ').slice(0, MAX_ALT_LENGTH);
}

/** `95` → `1:35`. Used in alt text and in plain-text fallbacks. */
export function formatMediaDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m === 0 ? `${s}s` : `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Produce a caption that is safe to send as alt text.
 *
 * Returns the original caption when it is already meaningful, a generated one
 * when it is not, and `undefined` when there is nothing honest to say — because
 * no caption is better than `"IMG_0042.jpg"`.
 */
export function safeCaption(
  caption: string | undefined,
  meta: Parameters<typeof describeMedia>[0],
): string | undefined {
  if (caption && !isUselessAlt(caption) && caption.length <= MAX_ALT_LENGTH) {
    return caption;
  }
  const generated = describeMedia(meta);
  return isUselessAlt(generated) ? undefined : generated;
}

/* ════════════════════════════════════════════════════════════════════════
   Colour independence
   ════════════════════════════════════════════════════════════════════════ */

/**
 * Rewrite a colour-only reference so it names the thing, not the paint.
 *
 * "the red one" is unusable in dark mode, to a colour-blind reader, and on a
 * monochrome printout. This is the single highest-value accessibility fix in
 * most chat interfaces and it costs nothing.
 */
export function nameInsteadOfColour(text: string): string {
  const rules: Array<[RegExp, string]> = [
    [/\bthe red (?:one|button|link|tab|item)\b/gi, 'the first one'],
    [/\bthe green (?:one|button|link|tab|item)\b/gi, 'the second one'],
    [/\bthe blue (?:one|button|link|tab|item)\b/gi, 'the third one'],
    [/\bthe yellow (?:one|button|link|tab|item)\b/gi, 'the highlighted one'],
    [/\bclick (?:the )?(red|green|blue|yellow)\b/gi, 'click the matching option'],
    [/\btap (?:the )?(red|green|blue|yellow)\b/gi, 'tap the matching option'],
  ];

  let out = text;
  for (const [re, replacement] of rules) out = out.replace(re, replacement);
  return out;
}

/** Does this text reference a colour as its only identifier? */
export function reliesOnColour(text: string): boolean {
  return /\b(?:red|green|blue|yellow|orange|purple)\s+(?:one|button|link|tab|item|row)\b/i.test(text)
    || /\b(?:click|tap|select|choose)\s+(?:the\s+)?(?:red|green|blue|yellow|orange|purple)\b/i.test(text);
}

/* ════════════════════════════════════════════════════════════════════════
   Text fallbacks
   ════════════════════════════════════════════════════════════════════════ */

/**
 * How well does this content survive a text-only reader?
 *
 * `plain` is what a screen reader gets. Every structured block degrades to it,
 * so the question is never "does it render" but "does the text carry the same
 * information the graphics did".
 */
export function accessibilityOf(content: Record<string, any>): {
  type: OutputType;
  hasTextFallback: boolean;
  /** Alt text, when the content is media. */
  altText?: string;
  issues: string[];
} {
  const issues: string[] = [];
  const type = render(JSON.stringify(content)).type;

  // Media without meaningful alt text.
  let altText: string | undefined;
  for (const key of ['image', 'video', 'audio', 'document', 'sticker']) {
    if (content[key] === undefined) continue;
    if (isUselessAlt(content.caption)) {
      issues.push(`${key} has no useful alt text`);
      altText = describeMedia({ kind: key as never });
    } else {
      altText = String(content.caption);
    }
    break;
  }

  // A poll with no distinguishable options is unusable non-visually.
  if (content.poll) {
    const values = content.poll?.values ?? [];
    if (values.length < 2) issues.push('poll has fewer than two options');
    if (new Set(values).size !== values.length) issues.push('poll has duplicate options');
  }

  // Interactive content needs a text equivalent.
  const interactive = content.listMessage ?? content.buttonsMessage;
  const hasTextFallback = !interactive
    || Boolean(content.text)
    || Boolean(content.listMessage?.description)
    || Boolean(content.buttonsMessage?.contentText);

  if (interactive && !hasTextFallback) {
    issues.push('interactive block has no text equivalent');
  }

  return { type, hasTextFallback, ...(altText ? { altText } : {}), issues };
}

/**
 * Attach alt text to media content before sending.
 *
 * Mutates nothing — returns a new object — so it is safe to call on a content
 * object that is also being logged.
 */
export function withAltText(
  content: Record<string, any>,
  meta: Parameters<typeof describeMedia>[0],
): Record<string, unknown> {
  const alt = safeCaption(content.caption, meta);
  return alt ? { ...content, caption: alt } : { ...content };
}

/**
 * The plain-text twin of a rendered reply.
 *
 * Every accessible surface here ends at this function: the same information,
 * readable by anything.
 */
export function plainTextOf(text: string): string {
  return nameInsteadOfColour(renderAllAsText(text));
}

/* ════════════════════════════════════════════════════════════════════════
   Reading load
   ════════════════════════════════════════════════════════════════════════ */

/**
 * Estimate reading difficulty.
 *
 * A crude, honest proxy: long sentences and long words. Not a validated score —
 * it is a threshold check that says "this needs shorter sentences", which is
 * actionable, rather than a number pretending to measure comprehension.
 */
export function readingLoad(text: string): {
  words: number;
  avgSentenceWords: number;
  longWordRatio: number;
  /** One of: plain, busy, heavy. */
  load: 'plain' | 'busy' | 'heavy';
} {
  const sentences = text.split(/[.!?\n]+/).map((s) => s.trim()).filter(Boolean);
  const words = text.split(/\s+/).filter(Boolean);

  const avgSentenceWords = sentences.length === 0
    ? 0
    : words.length / sentences.length;

  const longWords = words.filter((w) => w.length > 12).length;
  const longWordRatio = words.length === 0 ? 0 : longWords / words.length;

  // Thresholds chosen for chat, where a screen is small and attention is short.
  const load = avgSentenceWords > 28 || longWordRatio > 0.18
    ? 'heavy'
    : avgSentenceWords > 18 || longWordRatio > 0.10
      ? 'busy'
      : 'plain';

  return { words: words.length, avgSentenceWords, longWordRatio, load };
}

/** Should this be split before sending? */
export function needsSplit(text: string, maxWords = 60): boolean {
  return text.split(/\s+/).filter(Boolean).length > maxWords;
}