/**
 * helpers.ts — Nyx-Baileys feature helpers.
 *
 * 100+ pure, typed utility functions covering:
 *  - String manipulation and analysis
 *  - Formatting (bytes, numbers, currency, date/time, durations)
 *  - Extraction (URLs, emails, phones, hashtags, mentions)
 *  - Array operations (chunk, zip, intersect, difference, union, …)
 *  - Object helpers (pick, omit, flatten, group, sort, deep-ops, …)
 *  - Async helpers (memoize, debounce, throttle, retry, timeout, …)
 *  - Functional combinators (pipe, compose, partial, curry, …)
 *  - Type guards (isNil, isString, isArray, isEmpty, …)
 *
 * No runtime dependencies outside `node:*` built-ins.
 */

/* ─────────────────────────────────────────────────────────────────
   STRING  HELPERS
   ───────────────────────────────────────────────────────────────── */

/** Convert a string to camelCase. */
export function camelCase(str: string): string {
  return str
    .replace(/[-_\s]+(.)/g, (_, c: string) => c.toUpperCase())
    .replace(/^(.)/, (c) => c.toLowerCase());
}

/** Convert a string to snake_case. */
export function snakeCase(str: string): string {
  return str
    .replace(/([A-Z])/g, '_$1')
    .replace(/[-\s]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase();
}

/** Convert a string to kebab-case. */
export function kebabCase(str: string): string {
  return snakeCase(str).replace(/_/g, '-');
}

/** Title-case each word. */
export function titleCase(str: string): string {
  return str.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

/**
 * Truncate `str` to `max` characters, appending `suffix` (default `'…'`) when cut.
 * Handles Unicode code-points safely via spread.
 */
export function truncate(str: string, max: number, suffix = '…'): string {
  const chars = [...str];
  if (chars.length <= max) return str;
  const suffixLen = [...suffix].length;
  return chars.slice(0, Math.max(0, max - suffixLen)).join('') + suffix;
}

/**
 * Wrap `str` at `width` characters, inserting `newline` (default `'\n'`).
 * Breaks on word boundaries when possible.
 */
export function wrap(str: string, width: number, newline = '\n'): string {
  if (width <= 0) return str;
  const words = str.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line.length === 0) {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line += ' ' + word;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines.join(newline);
}

/** Pad `str` on both sides to `length` using `char` (default `' '`). */
export function pad(str: string, length: number, char = ' '): string {
  const s = String(str);
  if (s.length >= length) return s;
  const total = length - s.length;
  const left = Math.floor(total / 2);
  const right = total - left;
  return char.repeat(left) + s + char.repeat(right);
}

/** Repeat `str` `n` times. */
export function repeat(str: string, n: number): string {
  return n <= 0 ? '' : str.repeat(n);
}

/** Reverse a string (Unicode-safe). */
export function reverse(str: string): string {
  return [...str].reverse().join('');
}

/** Count words (whitespace-delimited). */
export function countWords(str: string): number {
  const trimmed = str.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

/** Count characters (Unicode code-points). */
export function countChars(str: string): number {
  return [...str].length;
}

/** Count lines (split on `\n`). */
export function countLines(str: string): number {
  return str.split('\n').length;
}

/** Extract all HTTP/HTTPS URLs from `str`. */
export function extractUrls(str: string): string[] {
  const re = /https?:\/\/[^\s"'<>)]+/g;
  return str.match(re) ?? [];
}

/** Extract e-mail addresses from `str`. */
export function extractEmails(str: string): string[] {
  const re = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  return str.match(re) ?? [];
}

/** Extract phone numbers (digits, spaces, dashes, plus) from `str`. */
export function extractPhones(str: string): string[] {
  const re = /\+?[\d][\d\s\-().]{6,}/g;
  return str.match(re) ?? [];
}

/** Extract `#hashtag` tokens from `str`. */
export function extractHashtags(str: string): string[] {
  const re = /#[\w\u00C0-\u024F]+/g;
  return str.match(re) ?? [];
}

/** Extract `@mention` tokens from `str`. */
export function extractMentions(str: string): string[] {
  const re = /@[\w.]+/g;
  return str.match(re) ?? [];
}

/** Wrap URLs in `<a href>` tags. */
export function linkify(str: string): string {
  return str.replace(/https?:\/\/[^\s"'<>)]+/g, (url) => `<a href="${url}">${url}</a>`);
}

/**
 * Strip HTML tags from `str`.
 * Not a sanitiser for security purposes — use a dedicated library for that.
 */
export function sanitizeHtml(str: string): string {
  return str.replace(/<[^>]*>/g, '');
}

/** Escape special regex metacharacters so the string is safe to use in `new RegExp(…)`. */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Decode HTML entities (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#039;`). */
export function unescapeHtml(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}

/** Collapse runs of whitespace (including newlines) to a single space, and trim. */
export function compressWhitespace(str: string): string {
  return str.replace(/\s+/g, ' ').trim();
}

/** Apply Unicode NFC normalisation. */
export function normalizeUnicode(str: string): string {
  return str.normalize('NFC');
}

/**
 * Naïve language hint from character ranges.
 * Returns `'arabic'`, `'cyrillic'`, `'cjk'`, `'latin'`, or `'unknown'`.
 */
export function detectLanguage(str: string): string {
  const test = (re: RegExp): boolean => re.test(str);
  if (test(/[\u0600-\u06FF]/)) return 'arabic';
  if (test(/[\u0400-\u04FF]/)) return 'cyrillic';
  if (test(/[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]/)) return 'cjk';
  if (test(/[a-zA-Z]/)) return 'latin';
  return 'unknown';
}

/** Transliterate common accented Latin characters to ASCII. */
export function transliterate(str: string): string {
  return str.normalize('NFD').replace(/[\u0300-\u036F]/g, '');
}

/** URL-safe slug: lowercase, ASCII-only, hyphens, no leading/trailing hyphens. */
export function slugify(str: string): string {
  return transliterate(str)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/* ─────────────────────────────────────────────────────────────────
   FORMAT  HELPERS
   ───────────────────────────────────────────────────────────────── */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/** Format bytes to a human-readable string (`1536` → `'1.5 KB'`). */
export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let val = bytes;
  let unit = 0;
  while (val >= 1024 && unit < BYTE_UNITS.length - 1) { val /= 1024; unit++; }
  return `${val.toFixed(decimals)} ${BYTE_UNITS[unit]}`;
}

/** Format a number with thousands separators (`1234567` → `'1,234,567'`). */
export function formatNumber(n: number, locale = 'en-US'): string {
  return n.toLocaleString(locale);
}

/** Format a number as currency (`1234.5` → `'$1,234.50'`). */
export function formatCurrency(amount: number, currency = 'USD', locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount);
}

/** Format milliseconds as `1h 02m 03s`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p2 = (n: number) => String(n).padStart(2, '0');
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h || parts.length) parts.push(`${parts.length ? p2(h) : h}h`);
  if (m || parts.length) parts.push(`${parts.length ? p2(m) : m}m`);
  parts.push(`${parts.length ? p2(sec) : sec}s`);
  return parts.join(' ');
}

/** Format a `Date` (or timestamp) as a locale date string. */
export function formatDate(date: Date | number, locale = 'en-US'): string {
  return new Date(date).toLocaleDateString(locale);
}

/** Format a `Date` (or timestamp) as a locale time string. */
export function formatTime(date: Date | number, locale = 'en-US'): string {
  return new Date(date).toLocaleTimeString(locale);
}

/** Format a `Date` (or timestamp) as a locale date+time string. */
export function formatDateTime(date: Date | number, locale = 'en-US'): string {
  return new Date(date).toLocaleString(locale);
}

/** Format a `Date` relative to now: `'3 minutes ago'`, `'in 2 hours'`, etc. */
export function formatRelative(date: Date | number): string {
  const diff = Number(new Date(date)) - Date.now();
  const abs = Math.abs(diff);
  const future = diff > 0;
  const thresholds: Array<[number, string]> = [
    [1000, 'just now'],
    [60_000, 'second'],
    [3_600_000, 'minute'],
    [86_400_000, 'hour'],
    [2_592_000_000, 'day'],
    [31_536_000_000, 'month'],
    [Infinity, 'year'],
  ];
  if (abs < 1000) return 'just now';
  for (let i = 1; i < thresholds.length; i++) {
    const [limit, unit] = thresholds[i]!;
    const [prevLimit] = thresholds[i - 1]!;
    if (abs < limit) {
      const n = Math.round(abs / prevLimit);
      const noun = n === 1 ? unit : `${unit}s`;
      return future ? `in ${n} ${noun}` : `${n} ${noun} ago`;
    }
  }
  return future ? 'in the future' : 'long ago';
}

/** Format an array of items as a natural-language list (`'a, b and c'`). */
export function formatList(items: string[], conjunction = 'and'): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  const last = items[items.length - 1]!;
  const rest = items.slice(0, -1);
  return `${rest.join(', ')} ${conjunction} ${last}`;
}

/** Format a number as an ordinal string (`1` → `'1st'`, `22` → `'22nd'`). */
export function formatOrdinal(n: number): string {
  const abs = Math.abs(Math.trunc(n));
  const mod100 = abs % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (abs % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/* ─────────────────────────────────────────────────────────────────
   QUERY  STRING  &  JSON  HELPERS
   ───────────────────────────────────────────────────────────────── */

/** Parse a query string (`?a=1&b=2`) to a plain object. */
export function parseQueryString(qs: string): Record<string, string> {
  const result: Record<string, string> = {};
  const params = new URLSearchParams(qs.startsWith('?') ? qs.slice(1) : qs);
  for (const [k, v] of params.entries()) result[k] = v;
  return result;
}

/** Serialise a plain object to a query string (without leading `?`). */
export function buildQueryString(params: Record<string, string | number | boolean>): string {
  return new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  ).toString();
}

/** Parse JSON, returning `null` on failure instead of throwing. */
export function parseJson<T = unknown>(str: string): T | null {
  try { return JSON.parse(str) as T; } catch { return null; }
}

/** Serialise to JSON, returning `null` on failure (e.g. circular refs). */
export function safeStringify(value: unknown, space?: number): string | null {
  try { return JSON.stringify(value, null, space); } catch { return null; }
}

/* ─────────────────────────────────────────────────────────────────
   DEEP  OBJECT  HELPERS
   ───────────────────────────────────────────────────────────────── */

/** Deep-clone a JSON-serialisable value. */
export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Recursively merge `source` into `target`, preferring source for scalars. */
export function deepMerge<T extends object>(target: T, source: Partial<T>): T {
  const result: Record<string, unknown> = Object.assign({}, target as Record<string, unknown>);
  for (const [k, v] of Object.entries(source) as [string, unknown][]) {
    const existing = result[k];
    if (isPlainObject(v) && isPlainObject(existing)) {
      result[k] = deepMerge(existing as object, v as object);
    } else {
      result[k] = v;
    }
  }
  return result as T;
}

/** Structural equality check (JSON-serialisable values). */
export function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Return the keys that differ between `before` and `after`.
 * Recurses into nested plain objects.
 */
export function deepDiff(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const diffs: string[] = [];
  for (const k of keys) {
    if (!deepEqual(before[k], after[k])) diffs.push(k);
  }
  return diffs;
}

/* ─────────────────────────────────────────────────────────────────
   PICK / OMIT / MAP  HELPERS
   ───────────────────────────────────────────────────────────────── */

/** Return a shallow copy of `obj` containing only the specified `keys`. */
export function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const k of keys) if (k in obj) result[k] = obj[k];
  return result;
}

/** Return a shallow copy of `obj` without the specified `keys`. */
export function omit<T extends object, K extends keyof T>(obj: T, keys: K[]): Omit<T, K> {
  const result = { ...obj };
  for (const k of keys) delete result[k];
  return result as Omit<T, K>;
}

/** Flatten a nested object into dot-notation keys. */
export function flatten(obj: Record<string, unknown>, prefix = '', sep = '.'): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}${sep}${k}` : k;
    if (isPlainObject(v)) {
      Object.assign(result, flatten(v as Record<string, unknown>, key, sep));
    } else {
      result[key] = v;
    }
  }
  return result;
}

/** Expand dot-notation keys back into a nested object. */
export function unflatten(obj: Record<string, unknown>, sep = '.'): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    setNested(result, k.split(sep), v);
  }
  return result;
}

/** Group an array by a key-returning function. */
export function groupBy<T>(arr: T[], keyFn: (item: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of arr) {
    const k = keyFn(item);
    (result[k] ??= []).push(item);
  }
  return result;
}

/** Sort an array by a key-returning function (ascending). */
export function sortBy<T>(arr: T[], keyFn: (item: T) => number | string): T[] {
  return [...arr].sort((a, b) => {
    const ka = keyFn(a), kb = keyFn(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/** Deduplicate an array by a key-returning function, keeping first occurrence. */
export function uniqueBy<T>(arr: T[], keyFn: (item: T) => unknown): T[] {
  const seen = new Set<unknown>();
  return arr.filter((item) => {
    const k = keyFn(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* ─────────────────────────────────────────────────────────────────
   ARRAY  HELPERS
   ───────────────────────────────────────────────────────────────── */

/** Split an array into chunks of at most `size`. */
export function chunkArray<T>(arr: T[], size: number): T[][] {
  if (size <= 0) throw new RangeError('chunkArray: size must be positive');
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
  return result;
}

/** Zip multiple arrays together: `([1,2],[a,b])` → `[[1,a],[2,b]]`. */
export function zipArrays<T extends unknown[][]>(...arrays: T): { [K in keyof T]: T[K] extends (infer U)[] ? U : never }[] {
  const len = Math.min(...arrays.map((a) => a.length));
  return Array.from({ length: len }, (_, i) => arrays.map((a) => a[i])) as { [K in keyof T]: T[K] extends (infer U)[] ? U : never }[];
}

/** Unzip an array of tuples into an array of arrays. */
export function unzipArrays<T extends unknown[]>(arr: T[]): { [K in keyof T]: T[K][] } {
  if (arr.length === 0) return [] as unknown as { [K in keyof T]: T[K][] };
  const width = arr[0]!.length;
  const result = Array.from({ length: width }, () => [] as unknown[]);
  for (const tuple of arr) {
    for (let i = 0; i < width; i++) result[i]!.push(tuple[i]);
  }
  return result as { [K in keyof T]: T[K][] };
}

/** Return the intersection of two arrays (unique values appearing in both). */
export function intersect<T>(a: T[], b: T[]): T[] {
  const setB = new Set(b);
  return [...new Set(a.filter((v) => setB.has(v)))];
}

/** Return elements in `a` that are not in `b`. */
export function difference<T>(a: T[], b: T[]): T[] {
  const setB = new Set(b);
  return a.filter((v) => !setB.has(v));
}

/** Return the union of two arrays (unique values from both). */
export function union<T>(a: T[], b: T[]): T[] {
  return [...new Set([...a, ...b])];
}

/** Fisher–Yates shuffle, returning a new array. */
export function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

/** Pick one random element, or `undefined` for an empty array. */
export function sample<T>(arr: T[]): T | undefined {
  return arr.length === 0 ? undefined : arr[Math.floor(Math.random() * arr.length)];
}

/** Pick `n` distinct random elements from `arr` (without replacement). */
export function sampleN<T>(arr: T[], n: number): T[] {
  return shuffle(arr).slice(0, Math.max(0, n));
}

/** Generate a numeric range `[start, end)` with optional `step`. */
export function range(start: number, end: number, step = 1): number[] {
  if (step === 0) throw new RangeError('range: step cannot be 0');
  const result: number[] = [];
  if (step > 0) for (let i = start; i < end; i += step) result.push(i);
  else for (let i = start; i > end; i += step) result.push(i);
  return result;
}

/** Call `fn(index)` exactly `n` times, collecting results. */
export function times<T>(n: number, fn: (i: number) => T): T[] {
  return Array.from({ length: Math.max(0, n) }, (_, i) => fn(i));
}

/* ─────────────────────────────────────────────────────────────────
   OBJECT  TRANSFORM  HELPERS
   ───────────────────────────────────────────────────────────────── */

/** Map over object values, keeping keys. */
export function mapValues<T, U>(obj: Record<string, T>, fn: (value: T, key: string) => U): Record<string, U> {
  const result: Record<string, U> = {};
  for (const [k, v] of Object.entries(obj)) result[k] = fn(v, k);
  return result;
}

/** Filter object entries by a predicate on values. */
export function filterValues<T>(obj: Record<string, T>, fn: (value: T, key: string) => boolean): Record<string, T> {
  const result: Record<string, T> = {};
  for (const [k, v] of Object.entries(obj)) if (fn(v, k)) result[k] = v;
  return result;
}

/** Swap keys and values of an object. Assumes values are unique strings. */
export function invertObject(obj: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) result[v] = k;
  return result;
}

/** Alias for `invertObject` — returns `Record<string, string>` with keys/values swapped. */
export const flipObject = invertObject;

/** Rename keys of an object according to a `keyMap` (old → new). */
export function renameKeys<T extends object>(obj: T, keyMap: Partial<Record<keyof T, string>>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const newKey = (keyMap as Record<string, string>)[k] ?? k;
    result[newKey] = v;
  }
  return result;
}

/** Remove `null` and `undefined` values from a shallow object copy. */
export function compactObject<T extends object>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) (result as Record<string, unknown>)[k] = v;
  }
  return result;
}

/** Expand an object with dot-notation keys into a nested structure. Same as `unflatten`. */
export function expandDotPaths(obj: Record<string, unknown>): Record<string, unknown> {
  return unflatten(obj);
}

/** Collapse a nested object to dot-notation keys. Same as `flatten`. */
export function collapseDotPaths(obj: Record<string, unknown>): Record<string, unknown> {
  return flatten(obj);
}

/* ─────────────────────────────────────────────────────────────────
   NESTED  PATH  HELPERS
   ───────────────────────────────────────────────────────────────── */

/**
 * Set a value at a nested path (array of keys).
 * Mutates `obj` in place.
 */
export function setNested(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let cursor = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    if (!isPlainObject(cursor[key])) cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  const last = path[path.length - 1];
  if (last !== undefined) cursor[last] = value;
}

/** Get a value from a nested path (array of keys). Returns `undefined` when missing. */
export function getNested(obj: Record<string, unknown>, path: string[]): unknown {
  let cursor: unknown = obj;
  for (const key of path) {
    if (!isPlainObject(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/** Return `true` when a value exists at `path` (even if `undefined`). */
export function hasNested(obj: Record<string, unknown>, path: string[]): boolean {
  let cursor: unknown = obj;
  for (let i = 0; i < path.length; i++) {
    if (!isPlainObject(cursor)) return false;
    const key = path[i]!;
    if (!(key in (cursor as object))) return false;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return true;
}

/** Delete the value at a nested path. Mutates `obj` in place. */
export function deleteNested(obj: Record<string, unknown>, path: string[]): void {
  let cursor: unknown = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (!isPlainObject(cursor)) return;
    cursor = (cursor as Record<string, unknown>)[path[i]!];
  }
  if (isPlainObject(cursor)) {
    const last = path[path.length - 1];
    if (last !== undefined) delete (cursor as Record<string, unknown>)[last];
  }
}

/* ─────────────────────────────────────────────────────────────────
   ASYNC  /  FUNCTIONAL  HELPERS
   ───────────────────────────────────────────────────────────────── */

/**
 * Memoize a function with an optional key-resolver.
 * Cache is unbounded — for production use, add a LRU eviction.
 */
export function memoize<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => TReturn,
  keyFn: (...args: TArgs) => string = (...args) => JSON.stringify(args),
): (...args: TArgs) => TReturn {
  const cache = new Map<string, TReturn>();
  return (...args: TArgs): TReturn => {
    const k = keyFn(...args);
    if (cache.has(k)) return cache.get(k) as TReturn;
    const result = fn(...args);
    cache.set(k, result);
    return result;
  };
}

/** Debounce `fn`: only calls it after `wait` ms of silence. */
export function debounce<TArgs extends unknown[]>(
  fn: (...args: TArgs) => void,
  wait: number,
): (...args: TArgs) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: TArgs): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; fn(...args); }, wait);
  };
}

/** Throttle `fn`: at most once per `interval` ms. */
export function throttle<TArgs extends unknown[]>(
  fn: (...args: TArgs) => void,
  interval: number,
): (...args: TArgs) => void {
  let last = 0;
  return (...args: TArgs): void => {
    const now = Date.now();
    if (now - last >= interval) { last = now; fn(...args); }
  };
}

/** Wrap `fn` so it only executes on the first call. */
export function once<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => TReturn,
): (...args: TArgs) => TReturn {
  let called = false;
  let result: TReturn;
  return (...args: TArgs): TReturn => {
    if (!called) { called = true; result = fn(...args); }
    return result!;
  };
}

/**
 * Retry an async `fn` up to `attempts` times with optional `delayMs` between.
 * Throws the last error when all attempts fail.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  delayMs = 0,
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (err) {
      lastError = err;
      if (i < attempts - 1 && delayMs > 0) await sleep(delayMs);
    }
  }
  throw lastError;
}

/** Wrap `promise` so it rejects with `TimeoutError` after `ms` milliseconds. */
export async function timeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const race = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, race]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Resolve after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Limit concurrency: at most `concurrency` async tasks run simultaneously.
 * Returns an array of results in input order.
 */
export async function pLimit<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]!();
    }
  }

  await Promise.all(times(Math.max(1, concurrency), worker));
  return results;
}

/* ─────────────────────────────────────────────────────────────────
   FUNCTIONAL  COMBINATORS
   ───────────────────────────────────────────────────────────────── */

/** Left-to-right function composition: `pipe(f, g, h)(x)` = `h(g(f(x)))`. */
export function pipe<T>(...fns: Array<(arg: T) => T>): (arg: T) => T {
  return (arg: T) => fns.reduce((v, fn) => fn(v), arg);
}

/** Right-to-left function composition: `compose(f, g, h)(x)` = `f(g(h(x)))`. */
export function compose<T>(...fns: Array<(arg: T) => T>): (arg: T) => T {
  return pipe(...[...fns].reverse());
}

/** Partially apply the first arguments of `fn`. */
export function partial<TArgs extends unknown[], TRest extends unknown[], TReturn>(
  fn: (...args: [...TArgs, ...TRest]) => TReturn,
  ...first: TArgs
): (...rest: TRest) => TReturn {
  return (...rest: TRest) => fn(...first, ...rest);
}

/** Curry a binary function: `curry(f)(a)(b)` = `f(a, b)`. */
export function curry<A, B, C>(fn: (a: A, b: B) => C): (a: A) => (b: B) => C {
  return (a: A) => (b: B) => fn(a, b);
}

/** Flip the first two arguments of a binary function. */
export function flip<A, B, C>(fn: (a: A, b: B) => C): (b: B, a: A) => C {
  return (b: B, a: A) => fn(a, b);
}

/** Identity — returns its argument unchanged. */
export function identity<T>(value: T): T { return value; }

/** Constant — returns a function that always returns `value`. */
export function constant<T>(value: T): () => T { return () => value; }

/** No-op function. */
// eslint-disable-next-line @typescript-eslint/no-empty-function
export function noop(..._args: unknown[]): void {}

/* ─────────────────────────────────────────────────────────────────
   TYPE  GUARDS
   ───────────────────────────────────────────────────────────────── */

/** `true` when `value` is `null` or `undefined`. */
export function isNil(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

/** `true` when `value` is a plain `{}` object (not an array, Date, etc.). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** `true` when `value` is an array. */
export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** `true` when `value` is a string. */
export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** `true` when `value` is a finite number. */
export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && !isNaN(value);
}

/** `true` when `value` is a boolean. */
export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/** `true` when `value` is a function. */
export function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function';
}

/** `true` when `value` is a `Date` object (and not `Invalid Date`). */
export function isDate(value: unknown): value is Date {
  return value instanceof Date && !isNaN(value.getTime());
}

/** `true` when `value` is a `RegExp`. */
export function isRegExp(value: unknown): value is RegExp {
  return value instanceof RegExp;
}

/** `true` when `value` is a `Promise` (duck-typed). */
export function isPromise(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)['then'] === 'function'
  );
}

/**
 * `true` when `value` is empty:
 * - `null` / `undefined`
 * - empty string
 * - empty array
 * - object with no own keys
 * - `Map` / `Set` with no entries
 */
export function isEmpty(value: unknown): boolean {
  if (isNil(value)) return true;
  if (typeof value === 'string') return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (value instanceof Map || value instanceof Set) return value.size === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

/** Inverse of `isEmpty`. */
export function isNotEmpty(value: unknown): boolean {
  return !isEmpty(value);
}

/** `true` when `value` is `null`, `undefined`, or a string containing only whitespace. */
export function isBlank(value: unknown): boolean {
  if (isNil(value)) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  return false;
}

/** Inverse of `isBlank`. */
export function isNotBlank(value: unknown): boolean {
  return !isBlank(value);
}
