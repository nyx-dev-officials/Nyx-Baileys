/**
 * I18N · text direction, locale formatting, and message catalogues.
 *
 * Scope: this is about **rendering text correctly**, not translating it. The
 * three problems that actually bite when content crosses a locale boundary on
 * WhatsApp:
 *
 *  1. **Bidirectional text.** A message mixing English and Arabic renders with
 *     punctuation jumping to the wrong end. The fix is invisible Unicode
 *     directional marks, and inserting them wrongly is worse than not at all —
 *     so this module is conservative and explains itself.
 *  2. **Locale formatting.** `1.234,56` read as an English number is off by
 *     three orders of magnitude. Numbers, dates, and durations all differ.
 *  3. **RTL-aware layout rules.** A menu's "title : description" separator sits
 *     on the correct side in LTR and the wrong side in RTL.
 *
 * Deliberately absent: a translation engine. A translator is a product
 * decision, not a formatting one, and a stub would be a promise.
 */

import type { Lang } from './ai/intent.js';

/* ════════════════════════════════════════════════════════════════════════
   Direction
   ════════════════════════════════════════════════════════════════════════ */

/** Scripts written right-to-left. */
const RTL_RANGES = /[֐-׿؀-ۿ܀-ݏހ-޿ࢠ-ࣿיִ-﷿ﹰ-﻿]/;

/** Does this text contain right-to-left script? */
export function hasRtl(text: string): boolean {
  return RTL_RANGES.test(text);
}

/** Languages that lay out right-to-left. */
const RTL_LANGS: ReadonlySet<string> = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'yi', 'dv', 'ku']);

/** Does this language lay out right-to-left? */
export function isRtlLang(lang: string): boolean {
  return RTL_LANGS.has(lang.split('-')[0] ?? '');
}

/**
 * Base direction for a piece of text.
 *
 * RTL script anywhere wins over the language, because the script is what the
 * client actually lays out by — a Persian message tagged `en` still renders RTL.
 */
export function directionOf(text: string, lang?: string): 'ltr' | 'rtl' {
  if (hasRtl(text)) return 'rtl';
  if (lang && isRtlLang(lang)) return 'rtl';
  return 'ltr';
}

/* ── directional marks ────────────────────────────────────────────── */

const LRM = '‎';
const RLM = '‏';
const LRE = '‪';
const RLE = '‫';
const PDF = '‬';
const LRI = '⁦';
const RLI = '⁧';
const FSI = '⁨';
const PDI = '⁩';

/**
 * Isolate an embedded run so it cannot reorder its surroundings.
 *
 * **Prefer this over embedding.** LRE/RLE affect the rest of the line until the
 * paragraph direction is restored; the isolates (U+2066-2069) are scoped to the
 * run and self-terminating. Wrapping user content in LRE and forgetting the PDF
 * silently reverses the punctuation of everything after it.
 */
export function isolate(text: string, direction: 'ltr' | 'rtl' | 'auto' = 'auto'): string {
  const dir = direction === 'auto' ? directionOf(text) : direction;
  const open = dir === 'rtl' ? RLI : LRI;
  return `${open}${text}${PDI}`;
}

/** Legacy embedding, for clients that predate the isolate characters. */
export function embed(text: string, direction: 'ltr' | 'rtl' | 'auto' = 'auto'): string {
  const dir = direction === 'auto' ? directionOf(text) : direction;
  return dir === 'rtl' ? `${RLE}${text}${PDF}` : `${LRE}${text}${PDF}`;
}

/**
 * Keep trailing punctuation beside the text it belongs to.
 *
 * In an RTL paragraph, a sentence ending in `.` or `:` lands visually at the
 * *start* unless it is wrapped. This wraps each line's trailing run.
 */
export function anchorTrailingPunctuation(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const match = /([.,:;!?]+)(\s*)$/.exec(line);
      if (!match) return line;
      return `${line.slice(0, match.index)}${isolate(match[1] ?? '')}`;
    })
    .join('\n');
}

/**
 * Make a message render correctly regardless of the sender's locale.
 *
 * Wraps the whole message in an isolate of the detected direction. This is the
 * one call that fixes a mixed-direction message: without it, a chat set to
 * English sends Arabic that renders with its punctuation at the wrong end.
 */
export function forMessage(text: string, lang?: Lang): string {
  return isolate(anchorTrailingPunctuation(text), directionOf(text, lang));
}

/* ════════════════════════════════════════════════════════════════════════
   Locale formatting
   ════════════════════════════════════════════════════════════════════════ */

export type Locale = string;

/** Locale defaults that differ enough to be worth defining. */
const LOCALE_DEFAULTS: Record<string, {
  decimal: string;
  group: string;
  currencyFirst: boolean;
  dateOrder: 'dmy' | 'mdy' | 'ymd';
}> = {
  en: { decimal: '.', group: ',', currencyFirst: true, dateOrder: 'mdy' },
  id: { decimal: ',', group: '.', currencyFirst: true, dateOrder: 'dmy' },
  de: { decimal: ',', group: '.', currencyFirst: false, dateOrder: 'dmy' },
  fr: { decimal: ',', group: '\u202f', currencyFirst: false, dateOrder: 'dmy' },
  es: { decimal: ',', group: '.', currencyFirst: false, dateOrder: 'dmy' },
  pt: { decimal: ',', group: '.', currencyFirst: true, dateOrder: 'dmy' },
  it: { decimal: ',', group: '.', currencyFirst: true, dateOrder: 'dmy' },
  nl: { decimal: ',', group: '.', currencyFirst: true, dateOrder: 'dmy' },
  ru: { decimal: ',', group: '\u00a0', currencyFirst: false, dateOrder: 'dmy' },
  ja: { decimal: '.', group: ',', currencyFirst: true, dateOrder: 'ymd' },
  zh: { decimal: '.', group: ',', currencyFirst: true, dateOrder: 'ymd' },
  ko: { decimal: '.', group: ',', currencyFirst: true, dateOrder: 'ymd' },
};

function defaultsFor(locale: Locale) {
  return LOCALE_DEFAULTS[locale.split('-')[0] ?? 'en'] ?? LOCALE_DEFAULTS.en ?? {
    decimal: '.', group: ',', currencyFirst: true, dateOrder: 'mdy' as const,
  };
}

/**
 * Format a number the way a locale writes it.
 *
 * `1234567.5` → `1,234,567.5` in `en`, `1.234.567,5` in `de`, `1.234.567,5` in
 * `id`. Misreading `1.234` as a decimal is a three-order-of-magnitude error, so
 * this is not cosmetic.
 */
export function number(value: number, locale: Locale = 'en', maxDecimals = 2): string {
  if (!Number.isFinite(value)) return String(value);

  const d = defaultsFor(locale);
  const fixed = value.toFixed(maxDecimals);

  const [whole, fraction] = fixed.split('.');
  const grouped = (whole ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, d.group);

  const sign = value < 0 ? '-' : '';
  return fraction ? `${sign}${grouped}${d.decimal}${fraction}` : `${sign}${grouped}`;
}

/** Format an amount with its currency symbol. */
export function money(
  value: number,
  currency = 'USD',
  locale: Locale = 'en',
  symbol = '$',
): string {
  const d = defaultsFor(locale);
  const amount = number(Math.abs(value), locale);
  const sign = value < 0 ? '-' : '';
  return d.currencyFirst ? `${sign}${symbol}${amount}` : `${sign}${amount} ${symbol}`;
}

/** Format a date without pulling in a locale library. */
export function date(value: Date | number, locale: Locale = 'en'): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);

  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();

  switch (defaultsFor(locale).dateOrder) {
    case 'dmy': return `${day}/${month}/${year}`;
    case 'ymd': return `${year}-${month}-${day}`;
    default: return `${month}/${day}/${year}`;
  }
}

/** 24-hour clock, which is unambiguous in every locale. */
export function time(value: Date | number): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** A duration, written for a locale. */
export function duration(seconds: number, locale: Locale = 'en'): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  const parts: string[] = [];
  if (h) parts.push(`${number(h, locale, 0)}h`);
  if (m) parts.push(`${number(m, locale, 0)}m`);
  if (s || parts.length === 0) parts.push(`${number(s, locale, 0)}s`);
  return parts.join(' ');
}

/* ════════════════════════════════════════════════════════════════════════
   Layout
   ════════════════════════════════════════════════════════════════════════ */

/**
 * Join a label and a value with a separator that suits the direction.
 *
 * A menu row is `title : description` in LTR. In RTL the same characters put the
 * description first, which reads as a bug to a reader.
 */
export function pair(
  title: string,
  value: string,
  options: { locale?: Locale; separator?: string } = {},
): string {
  const sep = options.separator ?? ':';
  const dir = directionOf(`${title}${value}`, options.locale);
  return dir === 'rtl' ? `${value}${sep} ${title}` : `${title}${sep} ${value}`;
}

/**
 * Wrap the message in the quoting markers a language expects.
 *
 * `>` works everywhere for quoting; `»` is the convention in several European
 * languages. Defaulting to `>` is the safer choice because it is understood
 * even where it is not idiomatic.
 */
export function quoted(text: string, lang?: string): string {
  const marker = lang?.startsWith('fr') || lang?.startsWith('it') || lang?.startsWith('de')
    ? '»'
    : '>';
  return text.split('\n').map((line) => `${marker} ${line}`).join('\n');
}

/* ════════════════════════════════════════════════════════════════════════
   Catalogue
   ════════════════════════════════════════════════════════════════════════ */

export type Catalogue = Record<string, Record<string, string>>;

/**
 * Look up a message, interpolating `{name}` placeholders.
 *
 * Falls back to `fallbackLang`, then to the key itself. Returning the key is
 * intentional: a caller sees `unknown.key` and can fix it, rather than an empty
 * string that looks like a bug in the UI.
 */
export function translate(
  catalogue: Catalogue,
  key: string,
  lang: string,
  params: Record<string, string | number> = {},
  fallbackLang = 'en',
): string {
  const base = lang.split('-')[0] ?? lang;
  const template = catalogue[base]?.[key] ?? catalogue[fallbackLang]?.[key] ?? key;

  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * Which languages does this catalogue actually cover?
 *
 * Returns coverage as a fraction per key, because a catalogue that has
 * `greeting` in ten languages and `error` in one is 10% translated, not 100%.
 */
export function coverage(catalogue: Catalogue): {
  languages: string[];
  perKey: Record<string, number>;
  /** Keys present in every language. */
  complete: string[];
  /** Keys missing from at least one language. */
  partial: string[];
} {
  const languages = Object.keys(catalogue);
  const allKeys = [...new Set(languages.flatMap((l) => Object.keys(catalogue[l] ?? {})))];

  const perKey: Record<string, number> = {};
  for (const key of allKeys) {
    const present = languages.filter((l) => catalogue[l]?.[key] !== undefined).length;
    perKey[key] = languages.length === 0 ? 0 : present / languages.length;
  }

  const complete = allKeys.filter((k) => perKey[k] === 1);
  const partial = allKeys.filter((k) => perKey[k]! < 1);

  return { languages, perKey, complete, partial };
}

/** Languages this catalogue is missing entirely, given a target list. */
export function missingLanguages(catalogue: Catalogue, wanted: string[]): string[] {
  const have = new Set(Object.keys(catalogue));
  return wanted.filter((l) => !have.has(l));
}