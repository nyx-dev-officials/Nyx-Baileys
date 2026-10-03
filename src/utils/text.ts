/**
 * Text utilities.
 *
 * String helpers a bot script otherwise writes inline on every command:
 * WhatsApp markup wrappers, safe truncation, chunking to the message-size
 * limit, masking and the small comparisons. All pure.
 */

/** Escape the characters WhatsApp treats as markup. */
export function escapeWhatsApp(text: string): string {
  return text.replace(/([*_~`])/g, '');
}

/** Wrap in WhatsApp bold (`*text*`). */
export const bold = (text: string): string => `*${text}*`;
/** Wrap in WhatsApp italic (`_text_`). */
export const italic = (text: string): string => `_${text}_`;
/** Wrap in WhatsApp strikethrough (`~text~`). */
export const strikethrough = (text: string): string => `~${text}~`;
/** Wrap in WhatsApp monospace (`` ```text``` ``). */
export const monospace = (text: string): string => `\`\`\`${text}\`\`\``;
/** Render as a WhatsApp block quote (`> text`). */
export const quote = (text: string): string => text.split('\n').map((line) => `> ${line}`).join('\n');

/** Remove WhatsApp markup characters. */
export function stripFormatting(text: string): string {
  return text.replace(/[*_~`]/g, '');
}

/** Truncate to `max` characters, appending an ellipsis when cut. */
export function truncate(text: string, max: number, ellipsis = '…'): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  if (ellipsis.length >= max) return text.slice(0, max);
  return text.slice(0, max - ellipsis.length) + ellipsis;
}

/** Collapse runs of whitespace and trim. */
export const normalizeWhitespace = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** True when a string is empty or only whitespace. */
export const isBlank = (text: string | null | undefined): boolean => !text || text.trim().length === 0;

/** Title-case each word. */
export function titleCase(text: string): string {
  return text.replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

/** URL-safe slug. */
export function slugify(text: string): string {
  return normalizeWhitespace(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Word count, whitespace-delimited. */
export const wordCount = (text: string): number => (isBlank(text) ? 0 : normalizeWhitespace(text).split(' ').length);

/**
 * Split text into chunks no longer than `size`, preferring a newline or space
 * boundary. Use before sending so a long body does not exceed the wire limit.
 */
export function chunkText(text: string, size = 4096): string[] {
  if (size <= 0) throw new Error('chunkText: size must be positive');
  if (text.length <= size) return text.length ? [text] : [];

  const chunks: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = rest.lastIndexOf(' ', size);
    if (cut < size * 0.5) cut = size;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length) chunks.push(rest);
  return chunks;
}

/** Dice coefficient over character bigrams, 0..1. Cheap fuzzy match. */
export function similarity(a: string, b: string): number {
  const left = a.toLowerCase().trim();
  const right = b.toLowerCase().trim();
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;

  const bigrams = (s: string): Map<string, number> => {
    const map = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i += 1) {
      const gram = s.slice(i, i + 2);
      map.set(gram, (map.get(gram) ?? 0) + 1);
    }
    return map;
  };

  const aGrams = bigrams(left);
  const bGrams = bigrams(right);
  let intersection = 0;
  for (const [gram, count] of aGrams) {
    const other = bGrams.get(gram);
    if (other) intersection += Math.min(count, other);
  }
  const total = left.length - 1 + (right.length - 1);
  return total === 0 ? 0 : (2 * intersection) / total;
}

/** Up to two initials from a name. */
export function initials(name: string, max = 2): string {
  return normalizeWhitespace(name)
    .split(' ')
    .filter(Boolean)
    .slice(0, max)
    .map((word) => word.charAt(0).toUpperCase())
    .join('');
}

/** Mask the middle of a phone number or id: `1555…4567`. */
export function mask(value: string, keepStart = 4, keepEnd = 4): string {
  const clean = value.trim();
  if (clean.length <= keepStart + keepEnd) return '*'.repeat(clean.length);
  return `${clean.slice(0, keepStart)}…${clean.slice(-keepEnd)}`;
}

/** `1 item`, `2 items` — pluralise without a library. */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Compare ignoring case and surrounding whitespace. */
export const equalsIgnoreCase = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();
