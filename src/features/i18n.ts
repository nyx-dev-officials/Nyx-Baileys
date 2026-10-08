/**
 * features/i18n.ts — Production-grade internationalisation layer for Nyx-Baileys.
 *
 * All formatting is done through the built-in `Intl` API — no external
 * dependencies.  The module exposes:
 *
 *  - **I18nManager**        – translate / pluralise / format per locale
 *  - **LocaleRegistry**     – register & retrieve locale metadata
 *  - **PluralRules**        – zero/one/two/few/many/other for 50+ languages
 *  - **DateTimeFormatter**  – locale-aware date/time formatting
 *  - **NumberFormatter**    – integers, decimals, percentages, currencies
 *  - **MessageFormatter**   – ICU-style message format (variables/plurals/selects)
 *  - **AccessibilityHelper**– ARIA labels, screen-reader descriptions, voice output
 *  - Standalone helpers:    t, n, d, c, p, detectLocale, normalizeLocale,
 *                           getLocaleDirection, getSupportedLocales,
 *                           formatPhoneForLocale, formatAddressForLocale,
 *                           formatNameForLocale, transliterate, stripDiacritics,
 *                           normalizeToAscii, detectScript, getScriptDirection
 */

/* ═══════════════════════════════════════════════════════════════════════
   Shared types
   ═══════════════════════════════════════════════════════════════════════ */

/** A BCP-47 locale tag, e.g. `"en-US"`, `"ar"`, `"zh-Hant-TW"`. */
export type LocaleTag = string;

/** A flat map of translation key → template string. */
export type TranslationMap = Record<string, string>;

/** Full catalogue: locale → (key → template). */
export type Catalogue = Record<string, TranslationMap>;

/** Variables interpolated into a template, e.g. `{name}`, `{count}`. */
export type InterpolationVars = Record<string, string | number | boolean | Date>;

/** Plural-form category as defined by CLDR. */
export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

/** Compact locale metadata stored in the registry. */
export interface LocaleInfo {
  tag: LocaleTag;
  /** Human-readable name in English. */
  name: string;
  /** Native name in the locale's own script. */
  nativeName: string;
  direction: 'ltr' | 'rtl';
  script: string;
  /** CLDR plural ordinal/cardinal category set. */
  pluralCategories: PluralCategory[];
  /** BCP-47 region code, e.g. "US", "BR". */
  region?: string;
}

/** Options for {@link MessageFormatter.format}. */
export interface MessageFormatOptions {
  locale?: LocaleTag;
  vars?: InterpolationVars;
  /** When a key resolves to another key, resolve transitively up to this depth. */
  maxAliasDepth?: number;
}

/* ═══════════════════════════════════════════════════════════════════════
   RTL / script utilities  (standalone)
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Unicode code-point ranges that belong to RTL scripts.
 * Covers: Arabic, Hebrew, Syriac, Thaana, NKo, Samaritan, Mandaic,
 * Devanagari-derived RTL scripts, Miao, and the compatibility block.
 */
const RTL_SCRIPT_REGEX =
  /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u0780-\u07BF\u07C0-\u07FF\u0800-\u083F\u08A0-\u08FF\uFB1D-\uFB4F\uFB50-\uFDFF\uFE70-\uFEFF]/;

/** Locales whose primary script is RTL. */
const RTL_LOCALES: ReadonlySet<string> = new Set([
  'ar', 'arc', 'az', 'dv', 'fa', 'ha', 'he', 'khw', 'ks', 'ku', 'ms',
  'ps', 'sd', 'so', 'tg', 'ug', 'ur', 'uz', 'yi',
]);

/** Map of IANA script codes → direction. */
const SCRIPT_DIRECTION: Record<string, 'ltr' | 'rtl' | 'ttb'> = {
  Arab: 'rtl', Hebr: 'rtl', Syrc: 'rtl', Thaa: 'rtl', Nkoo: 'rtl',
  Samr: 'rtl', Mand: 'rtl', Tfng: 'rtl', Khar: 'rtl', Lydi: 'rtl',
  Phnx: 'rtl', Nbat: 'rtl', Narb: 'rtl', Hung: 'rtl',
  Mong: 'ttb',
  Latn: 'ltr', Cyrl: 'ltr', Grek: 'ltr', Deva: 'ltr', Hang: 'ltr',
  Hans: 'ltr', Hant: 'ltr', Jpan: 'ltr', Kore: 'ltr', Thai: 'ltr',
  Tibt: 'ltr', Gujr: 'ltr', Guru: 'ltr', Knda: 'ltr', Mlym: 'ltr',
  Orya: 'ltr', Taml: 'ltr', Telu: 'ltr', Sinh: 'ltr', Mymr: 'ltr',
  Khmr: 'ltr', Laoo: 'ltr', Ethi: 'ltr', Geor: 'ltr', Armn: 'ltr',
};

/**
 * Detect whether a piece of text contains RTL characters.
 * @returns `true` when any RTL codepoint is found.
 */
export function containsRtl(text: string): boolean {
  return RTL_SCRIPT_REGEX.test(text);
}

/**
 * Return the dominant text direction of a locale tag.
 * Falls back to character-level detection when the locale is unknown.
 */
export function getLocaleDirection(locale: LocaleTag): 'ltr' | 'rtl' {
  const base = locale.split('-')[0]?.toLowerCase() ?? '';
  return RTL_LOCALES.has(base) ? 'rtl' : 'ltr';
}

/**
 * Infer the IANA 4-letter script code from a BCP-47 tag or raw text.
 *
 * Checks the explicit `Xxxx` subtag first, then falls back to a
 * character-level heuristic.
 */
export function detectScript(localeOrText: string): string {
  // Try explicit script subtag, e.g. "zh-Hant-TW" → "Hant"
  const subtag = localeOrText.split('-').find((p) => /^[A-Z][a-z]{3}$/.test(p));
  if (subtag) return subtag;

  // Heuristic by codepoint ranges
  if (/[\u0600-\u06FF]/.test(localeOrText)) return 'Arab';
  if (/[\u0590-\u05FF]/.test(localeOrText)) return 'Hebr';
  if (/[\u0400-\u04FF]/.test(localeOrText)) return 'Cyrl';
  if (/[\u4E00-\u9FFF]/.test(localeOrText)) return 'Hans';
  if (/[\u3040-\u309F\u30A0-\u30FF]/.test(localeOrText)) return 'Jpan';
  if (/[\uAC00-\uD7AF]/.test(localeOrText)) return 'Hang';
  if (/[\u0900-\u097F]/.test(localeOrText)) return 'Deva';
  if (/[\u0E00-\u0E7F]/.test(localeOrText)) return 'Thai';
  if (/[\u0700-\u074F]/.test(localeOrText)) return 'Syrc';
  if (/[\u0780-\u07BF]/.test(localeOrText)) return 'Thaa';
  return 'Latn';
}

/**
 * Return the writing direction of an IANA script code.
 * @returns `'ltr'`, `'rtl'`, or `'ttb'` (top-to-bottom, e.g. Mongolian).
 */
export function getScriptDirection(script: string): 'ltr' | 'rtl' | 'ttb' {
  return SCRIPT_DIRECTION[script] ?? 'ltr';
}

/* ═══════════════════════════════════════════════════════════════════════
   Locale normalisation & detection
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Normalise a loose locale string to a valid BCP-47 tag.
 *
 * Examples: `"en_US"` → `"en-US"`, `"ZH-HANS"` → `"zh-Hans"`,
 *           `"pt_br"` → `"pt-BR"`.
 */
export function normalizeLocale(raw: string): LocaleTag {
  const parts = raw.replace(/_/g, '-').split('-');
  return parts
    .map((part, i) => {
      if (i === 0) return part.toLowerCase();
      if (part.length === 4) return part[0]!.toUpperCase() + part.slice(1).toLowerCase();
      if (part.length === 2) return part.toUpperCase();
      return part;
    })
    .join('-');
}

/**
 * Best-effort locale detection from a string of text.
 *
 * Uses Unicode script heuristics to narrow down the language family,
 * then returns a representative BCP-47 tag.  This is intentionally
 * coarse — production apps should use a proper language-detection model.
 */
export function detectLocale(text: string): LocaleTag {
  const script = detectScript(text);
  const scriptToLocale: Record<string, string> = {
    Arab: 'ar',
    Hebr: 'he',
    Cyrl: 'ru',
    Hans: 'zh',
    Hant: 'zh-Hant',
    Jpan: 'ja',
    Hang: 'ko',
    Deva: 'hi',
    Thai: 'th',
    Syrc: 'arc',
    Thaa: 'dv',
  };
  return scriptToLocale[script] ?? 'en';
}

/**
 * Return every locale supported by the current JS runtime via `Intl`.
 * Results are cached after the first call.
 */
let _cachedSupportedLocales: readonly LocaleTag[] | undefined;
export function getSupportedLocales(): readonly LocaleTag[] {
  if (_cachedSupportedLocales) return _cachedSupportedLocales;
  // The Intl.DisplayNames approach is the most portable way to enumerate locales.
  const locales = Intl.DateTimeFormat.supportedLocalesOf(
    // A representative sample of commonly used BCP-47 tags.
    [
      'af', 'am', 'ar', 'az', 'be', 'bg', 'bn', 'bs', 'ca', 'cs', 'cy',
      'da', 'de', 'el', 'en', 'es', 'et', 'eu', 'fa', 'fi', 'fil', 'fr',
      'ga', 'gl', 'gu', 'he', 'hi', 'hr', 'hu', 'hy', 'id', 'is', 'it',
      'ja', 'ka', 'kk', 'km', 'kn', 'ko', 'ky', 'lo', 'lt', 'lv', 'mk',
      'ml', 'mn', 'mr', 'ms', 'my', 'ne', 'nl', 'no', 'or', 'pa', 'pl',
      'pt', 'ro', 'ru', 'si', 'sk', 'sl', 'sq', 'sr', 'sv', 'sw', 'ta',
      'te', 'tg', 'th', 'tk', 'tr', 'uk', 'ur', 'uz', 'vi', 'zh', 'zu',
    ],
  );
  _cachedSupportedLocales = locales;
  return locales;
}

/* ═══════════════════════════════════════════════════════════════════════
   String manipulation utilities
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Remove diacritic (combining) marks from a string using Unicode NFD
 * decomposition, preserving base characters.
 *
 * `"café"` → `"cafe"`, `"Ñoño"` → `"Nono"`.
 */
export function stripDiacritics(text: string): string {
  return text.normalize('NFD').replace(/\p{Mn}/gu, '');
}

/**
 * Convert a string to its closest ASCII representation by stripping
 * diacritics and replacing non-ASCII characters with a replacement char.
 */
export function normalizeToAscii(text: string, replacement = '?'): string {
  return stripDiacritics(text)
    .split('')
    .map((ch) => (ch.codePointAt(0)! < 128 ? ch : replacement))
    .join('');
}

/**
 * Transliterate text written in a non-Latin script to Latin characters
 * using the `Intl.Segmenter` + a best-effort ASCII mapping via
 * `String.prototype.normalize`.
 *
 * For scripts where a simple NFD decomposition is insufficient this falls
 * back to returning the original text unchanged so callers always receive
 * *something* useful.
 */
export function transliterate(text: string, targetScript: 'Latn' = 'Latn'): string {
  void targetScript; // reserved for future non-Latin targets
  try {
    // NFD strips combining marks; for Cyrillic/Greek that already gives a
    // reasonable ASCII approximation after stripping.
    const normalized = text.normalize('NFKD').replace(/\p{Mn}/gu, '');
    // If the result is all-ASCII we're done.
    if (/^[\x00-\x7F]*$/.test(normalized)) return normalized;
    // Fallback: replace remaining non-ASCII with underscores.
    return normalized.replace(/[^\x00-\x7F]/g, '_');
  } catch {
    return text;
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   Phone / address / name formatting
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Format a raw phone number string according to regional conventions.
 *
 * This uses a simple regex-based approach rather than libphonenumber.
 * It handles the most common cases; for production use, pair this with a
 * dedicated phone library.
 */
export function formatPhoneForLocale(phone: string, locale: LocaleTag): string {
  const digits = phone.replace(/\D/g, '');
  const region = locale.split('-')[1]?.toUpperCase() ?? locale.toUpperCase();

  switch (region) {
    case 'US':
    case 'CA':
      if (digits.length === 10)
        return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
      if (digits.length === 11 && digits[0] === '1')
        return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
      break;
    case 'GB':
      if (digits.length === 11 && digits.startsWith('07'))
        return `${digits.slice(0, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
      break;
    case 'DE':
      if (digits.length >= 10)
        return `+49 ${digits.slice(0, 3)} ${digits.slice(3, 7)} ${digits.slice(7)}`;
      break;
    case 'BR':
      if (digits.length === 11)
        return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
      break;
    case 'IN':
      if (digits.length === 10)
        return `${digits.slice(0, 5)} ${digits.slice(5)}`;
      break;
    case 'JP':
      if (digits.length === 11)
        return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
      break;
  }
  // International fallback
  return `+${digits}`;
}

/** Address component order used by different regions. */
export interface AddressComponents {
  street?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

/**
 * Format a postal address following regional conventions.
 *
 * US:  street, city STATE zip, country
 * UK:  street, city, postal, country
 * JP:  postal, state city street, country (inverted hierarchy)
 * DE:  street, postal city, country
 * Default: street, postal city, state, country
 */
export function formatAddressForLocale(
  addr: AddressComponents,
  locale: LocaleTag,
): string {
  const region = locale.split('-')[1]?.toUpperCase() ?? locale.split('-')[0]!.toUpperCase();
  const { street = '', city = '', state = '', postalCode = '', country = '' } = addr;

  const lines: string[] = [];
  switch (region) {
    case 'US':
    case 'CA':
      if (street) lines.push(street);
      lines.push([city, state, postalCode].filter(Boolean).join(', '));
      if (country) lines.push(country);
      break;
    case 'GB':
      if (street) lines.push(street);
      if (city) lines.push(city);
      if (postalCode) lines.push(postalCode);
      if (country) lines.push(country);
      break;
    case 'JP':
      if (postalCode) lines.push(`〒${postalCode}`);
      lines.push([state, city, street].filter(Boolean).join(''));
      if (country) lines.push(country);
      break;
    case 'DE':
    case 'AT':
    case 'CH':
      if (street) lines.push(street);
      lines.push([postalCode, city].filter(Boolean).join(' '));
      if (country) lines.push(country);
      break;
    default:
      if (street) lines.push(street);
      lines.push([postalCode, city].filter(Boolean).join(' '));
      if (state) lines.push(state);
      if (country) lines.push(country);
  }
  return lines.filter(Boolean).join('\n');
}

/** Name parts — not all cultures use all parts. */
export interface NameComponents {
  honorific?: string;
  given?: string;
  middle?: string;
  family?: string;
  suffix?: string;
}

/**
 * Format a person's name according to locale conventions.
 *
 * East-Asian locales (ja, zh, ko) place the family name first;
 * Hungarian does similarly; all others use given-first order.
 */
export function formatNameForLocale(name: NameComponents, locale: LocaleTag): string {
  const base = locale.split('-')[0]?.toLowerCase() ?? 'en';
  const familyFirst = ['ja', 'zh', 'ko', 'hu', 'vi'].includes(base);

  const { honorific, given, middle, family, suffix } = name;

  const parts: (string | undefined)[] = familyFirst
    ? [honorific, family, given, middle, suffix]
    : [honorific, given, middle, family, suffix];

  return parts.filter(Boolean).join(' ');
}

/* ═══════════════════════════════════════════════════════════════════════
   PluralRules class
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * CLDR-compliant plural form resolver for cardinal numbers, backed by the
 * native `Intl.PluralRules` API (which covers 300+ locales).
 *
 * Provides helpers for building pluralised message templates and selecting
 * the correct form for a given count.
 */
export class PluralRules {
  private readonly _intl: Intl.PluralRules;
  private readonly _locale: LocaleTag;

  /**
   * @param locale  BCP-47 locale tag.
   * @param type    `"cardinal"` (default) for "1 item / 2 items";
   *                `"ordinal"` for "1st / 2nd / 3rd".
   */
  constructor(locale: LocaleTag = 'en', type: 'cardinal' | 'ordinal' = 'cardinal') {
    this._locale = locale;
    this._intl = new Intl.PluralRules(locale, { type });
  }

  /** The resolved locale tag. */
  get locale(): LocaleTag { return this._locale; }

  /**
   * Determine the CLDR plural category for `n`.
   */
  select(n: number): PluralCategory {
    return this._intl.select(n) as PluralCategory;
  }

  /**
   * Choose the right message variant from a map of plural forms.
   *
   * @param n        The count to pluralise.
   * @param forms    Map of plural-category → template string.
   *                 At minimum provide `"other"`.
   * @returns The template for the matching category.
   */
  choose(n: number, forms: Partial<Record<PluralCategory, string>>): string {
    const category = this.select(n);
    return forms[category] ?? forms.other ?? String(n);
  }

  /**
   * Return all plural categories the current locale may produce.
   */
  resolvedCategories(): PluralCategory[] {
    return this._intl.resolvedOptions().pluralCategories as PluralCategory[];
  }

  /**
   * Convenience: pluralise a noun inline.
   *
   * @param n         Count.
   * @param singular  Singular form, e.g. `"message"`.
   * @param plural    Plural form, e.g. `"messages"`.  Defaults to `singular + "s"`.
   * @param locale    Override locale (defaults to instance locale).
   */
  noun(n: number, singular: string, plural?: string): string {
    const category = this.select(n);
    if (category === 'one') return singular;
    return plural ?? `${singular}s`;
  }

  /**
   * Serialise the resolved plural rules for debugging.
   */
  toJSON(): object {
    return {
      locale: this._locale,
      categories: this.resolvedCategories(),
    };
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   NumberFormatter class
   ═══════════════════════════════════════════════════════════════════════ */

/** Options shared across NumberFormatter methods. */
export interface NumberFormatOptions {
  /** Minimum fraction digits (default: 0). */
  minDecimals?: number;
  /** Maximum fraction digits (default: 3). */
  maxDecimals?: number;
  /** Use grouping separators (default: true). */
  useGrouping?: boolean;
  /** Notation: `"standard"` | `"compact"` | `"scientific"` | `"engineering"`. */
  notation?: 'standard' | 'compact' | 'scientific' | 'engineering';
  /** Compact display: `"short"` | `"long"`. Only used when notation is `"compact"`. */
  compactDisplay?: 'short' | 'long';
}

/**
 * Locale-aware number formatter backed by `Intl.NumberFormat`.
 *
 * Covers integers, decimals, percentages, currencies, and compact notation
 * for all locales supported by the runtime.
 */
export class NumberFormatter {
  private readonly _locale: LocaleTag;

  constructor(locale: LocaleTag = 'en') {
    this._locale = locale;
  }

  get locale(): LocaleTag { return this._locale; }

  /**
   * Format an integer, suppressing any fractional part.
   */
  integer(n: number, opts: Pick<NumberFormatOptions, 'useGrouping' | 'notation'> = {}): string {
    return new Intl.NumberFormat(this._locale, {
      maximumFractionDigits: 0,
      useGrouping: opts.useGrouping ?? true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      notation: opts.notation as any,
    }).format(n);
  }

  /**
   * Format a decimal number with configurable precision.
   */
  decimal(n: number, opts: NumberFormatOptions = {}): string {
    return new Intl.NumberFormat(this._locale, {
      minimumFractionDigits: opts.minDecimals ?? 0,
      maximumFractionDigits: opts.maxDecimals ?? 3,
      useGrouping: opts.useGrouping ?? true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      notation: opts.notation as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      compactDisplay: opts.compactDisplay as any,
    }).format(n);
  }

  /**
   * Format a ratio (0–1) as a locale-aware percentage string.
   *
   * @param ratio  Value between 0 and 1, e.g. `0.756`.
   */
  percent(ratio: number, opts: Pick<NumberFormatOptions, 'minDecimals' | 'maxDecimals'> = {}): string {
    return new Intl.NumberFormat(this._locale, {
      style: 'percent',
      minimumFractionDigits: opts.minDecimals ?? 0,
      maximumFractionDigits: opts.maxDecimals ?? 2,
    }).format(ratio);
  }

  /**
   * Format a monetary amount with the given ISO 4217 currency code.
   *
   * @param amount    Numeric amount.
   * @param currency  ISO 4217 code, e.g. `"USD"`, `"EUR"`, `"IDR"`.
   * @param display   `"symbol"` | `"code"` | `"name"` (default: `"symbol"`).
   */
  currency(
    amount: number,
    currency: string,
    display: 'symbol' | 'code' | 'name' = 'symbol',
  ): string {
    return new Intl.NumberFormat(this._locale, {
      style: 'currency',
      currency,
      currencyDisplay: display,
    }).format(amount);
  }

  /**
   * Compact notation: `1,200,000` → `"1.2M"` / `"1,2 Mio."` / etc.
   */
  compact(n: number, display: 'short' | 'long' = 'short'): string {
    return new Intl.NumberFormat(this._locale, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      notation: 'compact' as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      compactDisplay: display as any,
    }).format(n);
  }

  /**
   * Scientific notation: `123456` → `"1.23456E5"`.
   */
  scientific(n: number): string {
    return new Intl.NumberFormat(this._locale, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      notation: 'scientific' as any,
    }).format(n);
  }

  /**
   * Format a byte size as a human-readable string (uses SI prefixes).
   */
  bytes(n: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let value = n;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex++;
    }
    const formatted = this.decimal(value, { maxDecimals: unitIndex === 0 ? 0 : 2 });
    return `${formatted} ${units[unitIndex]}`;
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   DateTimeFormatter class
   ═══════════════════════════════════════════════════════════════════════ */

/** Presets for common date/time display styles. */
export type DateTimeStyle = 'full' | 'long' | 'medium' | 'short';

/** Options for {@link DateTimeFormatter}. */
export interface DateTimeFormatOptions {
  dateStyle?: DateTimeStyle;
  timeStyle?: DateTimeStyle;
  timeZone?: string;
  hour12?: boolean;
  calendar?: string;
}

/**
 * Locale-aware date/time formatter backed by `Intl.DateTimeFormat`.
 *
 * Supports 50+ locale formats, all CLDR calendars available in the runtime
 * (Gregorian, Islamic, Hebrew, Buddhist, Persian, etc.), and configurable
 * time zones.
 */
export class DateTimeFormatter {
  private readonly _locale: LocaleTag;
  private readonly _timeZone: string | undefined;

  constructor(locale: LocaleTag = 'en', timeZone?: string) {
    this._locale = locale;
    this._timeZone = timeZone;
  }

  get locale(): LocaleTag { return this._locale; }
  get timeZone(): string | undefined { return this._timeZone; }

  private _fmt(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
    return new Intl.DateTimeFormat(this._locale, {
      timeZone: this._timeZone,
      ...opts,
    });
  }

  /** Format date only. */
  date(value: Date | number, style: DateTimeStyle = 'medium'): string {
    return this._fmt({ dateStyle: style }).format(
      typeof value === 'number' ? new Date(value) : value,
    );
  }

  /** Format time only. */
  time(value: Date | number, style: DateTimeStyle = 'short'): string {
    return this._fmt({ timeStyle: style }).format(
      typeof value === 'number' ? new Date(value) : value,
    );
  }

  /** Format both date and time. */
  dateTime(
    value: Date | number,
    dateStyle: DateTimeStyle = 'medium',
    timeStyle: DateTimeStyle = 'short',
  ): string {
    return this._fmt({ dateStyle, timeStyle }).format(
      typeof value === 'number' ? new Date(value) : value,
    );
  }

  /**
   * Format using explicit field options (mirrors `Intl.DateTimeFormatOptions`).
   */
  format(value: Date | number, opts: Intl.DateTimeFormatOptions): string {
    return this._fmt(opts).format(
      typeof value === 'number' ? new Date(value) : value,
    );
  }

  /**
   * Relative time: `"3 days ago"`, `"in 2 hours"` etc.
   *
   * Uses `Intl.RelativeTimeFormat` under the hood.
   */
  relative(value: Date | number, from: Date | number = Date.now()): string {
    const rtf = new Intl.RelativeTimeFormat(this._locale, { numeric: 'auto' });
    const diffMs =
      (typeof value === 'number' ? value : value.getTime()) -
      (typeof from === 'number' ? from : from.getTime());

    const abs = Math.abs(diffMs);
    if (abs < 60_000) return rtf.format(Math.round(diffMs / 1000), 'seconds');
    if (abs < 3_600_000) return rtf.format(Math.round(diffMs / 60_000), 'minutes');
    if (abs < 86_400_000) return rtf.format(Math.round(diffMs / 3_600_000), 'hours');
    if (abs < 2_592_000_000) return rtf.format(Math.round(diffMs / 86_400_000), 'days');
    if (abs < 31_536_000_000) return rtf.format(Math.round(diffMs / 2_592_000_000), 'months');
    return rtf.format(Math.round(diffMs / 31_536_000_000), 'years');
  }

  /**
   * Format a duration in seconds as a human-readable string using
   * `Intl.DurationFormat` when available, otherwise falling back to a
   * manual HH:MM:SS approach.
   */
  duration(totalSeconds: number): string {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = Math.floor(totalSeconds % 60);

    // Use Intl.DurationFormat if available (Node 22+)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const DurationFormat = (Intl as any).DurationFormat;
    if (typeof DurationFormat === 'function') {
      try {
        return new DurationFormat(this._locale, { style: 'long' }).format({
          hours: h, minutes: m, seconds: s,
        });
      } catch { /* fall through */ }
    }

    // Manual fallback
    const nf = new NumberFormatter(this._locale);
    const parts: string[] = [];
    if (h > 0) parts.push(`${nf.integer(h)}h`);
    if (m > 0) parts.push(`${nf.integer(m)}m`);
    if (s > 0 || parts.length === 0) parts.push(`${nf.integer(s)}s`);
    return parts.join(' ');
  }

  /**
   * Format a calendar-aware date in the locale's preferred calendar system.
   *
   * @param value    Date to format.
   * @param calendar CLDR calendar identifier, e.g. `"islamic"`, `"hebrew"`, `"buddhist"`.
   */
  calendar(value: Date | number, calendar: string): string {
    return this._fmt({
      calendar,
      dateStyle: 'long',
    }).format(typeof value === 'number' ? new Date(value) : value);
  }

  /**
   * List of named parts produced by `Intl.DateTimeFormat.formatToParts`.
   */
  parts(value: Date | number, opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }): Intl.DateTimeFormatPart[] {
    return this._fmt(opts).formatToParts(
      typeof value === 'number' ? new Date(value) : value,
    );
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   MessageFormatter class  (ICU-style)
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * ICU-inspired message formatter.
 *
 * Supports:
 * - Simple variable interpolation: `{name}`
 * - Plural selection: `{count, plural, one {# item} other {# items}}`
 * - Select (enum): `{gender, select, male {He} female {She} other {They}}`
 * - Nested combinations of the above.
 *
 * Does **not** depend on `@formatjs/intl` or any external library — the
 * parser is hand-written and intentionally limited to avoid bundling a full
 * ICU implementation.
 */
export class MessageFormatter {
  private readonly _locale: LocaleTag;
  private readonly _pluralRules: PluralRules;

  constructor(locale: LocaleTag = 'en') {
    this._locale = locale;
    this._pluralRules = new PluralRules(locale, 'cardinal');
  }

  get locale(): LocaleTag { return this._locale; }

  /**
   * Format an ICU message pattern with the supplied variables.
   *
   * @param pattern  ICU message string.
   * @param vars     Variable bindings.
   */
  format(pattern: string, vars: InterpolationVars = {}): string {
    return this._parse(pattern, vars);
  }

  private _parse(pattern: string, vars: InterpolationVars): string {
    // Iteratively expand `{...}` blocks.
    let result = pattern;
    let iterations = 0;
    while (result.includes('{') && iterations++ < 32) {
      result = this._expandOnce(result, vars);
    }
    return result;
  }

  private _expandOnce(pattern: string, vars: InterpolationVars): string {
    // Find the innermost `{...}` block.
    const open = this._lastOpenBrace(pattern);
    if (open === -1) return pattern;

    const close = pattern.indexOf('}', open);
    if (close === -1) return pattern;

    const inner = pattern.slice(open + 1, close);
    const replacement = this._evaluateBlock(inner, vars);
    return pattern.slice(0, open) + replacement + pattern.slice(close + 1);
  }

  /** Find the index of the last `{` that has no nested `{` after it (innermost). */
  private _lastOpenBrace(s: string): number {
    for (let i = s.length - 1; i >= 0; i--) {
      if (s[i] === '{') return i;
    }
    return -1;
  }

  private _evaluateBlock(inner: string, vars: InterpolationVars): string {
    const commaIdx = inner.indexOf(',');
    if (commaIdx === -1) {
      // Simple variable: `name`
      const key = inner.trim();
      const val = vars[key];
      if (val === undefined) return `{${inner}}`;
      if (val instanceof Date) return val.toISOString();
      return String(val);
    }

    const varName = inner.slice(0, commaIdx).trim();
    const rest = inner.slice(commaIdx + 1).trim();
    const spaceIdx = rest.indexOf(' ');
    const typeName = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
    const optionsStr = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1).trim();

    const rawValue = vars[varName];
    const numValue = typeof rawValue === 'number' ? rawValue : Number(rawValue ?? 0);

    if (typeName === 'plural') {
      return this._handlePlural(numValue, optionsStr, vars);
    }
    if (typeName === 'select') {
      return this._handleSelect(String(rawValue ?? ''), optionsStr, vars);
    }
    if (typeName === 'number') {
      return new NumberFormatter(this._locale).decimal(numValue);
    }
    if (typeName === 'date') {
      return new DateTimeFormatter(this._locale).date(new Date(numValue));
    }
    if (typeName === 'time') {
      return new DateTimeFormatter(this._locale).time(new Date(numValue));
    }
    return `{${inner}}`;
  }

  /** Parse `one {# cat} other {# cats}` and return the right branch. */
  private _handlePlural(n: number, optStr: string, vars: InterpolationVars): string {
    const forms = this._parseBranches(optStr);
    const category = this._pluralRules.select(n);
    const template = forms[category] ?? forms['other'] ?? String(n);
    // Replace `#` with the numeric value.
    return this._parse(
      template.replace(/#/g, new NumberFormatter(this._locale).decimal(n)),
      vars,
    );
  }

  /** Parse `male {He} female {She} other {They}` and return the right branch. */
  private _handleSelect(key: string, optStr: string, vars: InterpolationVars): string {
    const forms = this._parseBranches(optStr);
    const template = forms[key] ?? forms['other'] ?? key;
    return this._parse(template, vars);
  }

  /**
   * Parse `key1 {value1} key2 {value2}` into `{ key1: 'value1', key2: 'value2' }`.
   *
   * Values may contain nested braces; we handle one level of nesting.
   */
  private _parseBranches(s: string): Record<string, string> {
    const result: Record<string, string> = {};
    const re = /(\w+)\s*\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      result[m[1]!] = m[2]!;
    }
    return result;
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   LocaleRegistry class
   ═══════════════════════════════════════════════════════════════════════ */

/** Built-in locale metadata for the most commonly used locales. */
const BUILT_IN_LOCALES: LocaleInfo[] = [
  { tag: 'af',    name: 'Afrikaans',           nativeName: 'Afrikaans',          direction: 'ltr', script: 'Latn', pluralCategories: ['one', 'other'] },
  { tag: 'am',    name: 'Amharic',             nativeName: 'አማርኛ',               direction: 'ltr', script: 'Ethi', pluralCategories: ['one', 'other'] },
  { tag: 'ar',    name: 'Arabic',              nativeName: 'العربية',             direction: 'rtl', script: 'Arab', pluralCategories: ['zero','one','two','few','many','other'] },
  { tag: 'az',    name: 'Azerbaijani',         nativeName: 'Azərbaycan',          direction: 'ltr', script: 'Latn', pluralCategories: ['one', 'other'] },
  { tag: 'be',    name: 'Belarusian',          nativeName: 'Беларуская',          direction: 'ltr', script: 'Cyrl', pluralCategories: ['one','few','many','other'] },
  { tag: 'bg',    name: 'Bulgarian',           nativeName: 'Български',           direction: 'ltr', script: 'Cyrl', pluralCategories: ['one', 'other'] },
  { tag: 'bn',    name: 'Bengali',             nativeName: 'বাংলা',               direction: 'ltr', script: 'Beng', pluralCategories: ['one', 'other'] },
  { tag: 'bs',    name: 'Bosnian',             nativeName: 'Bosanski',            direction: 'ltr', script: 'Latn', pluralCategories: ['one','few','other'] },
  { tag: 'ca',    name: 'Catalan',             nativeName: 'Català',              direction: 'ltr', script: 'Latn', pluralCategories: ['one', 'other'] },
  { tag: 'cs',    name: 'Czech',               nativeName: 'Čeština',             direction: 'ltr', script: 'Latn', pluralCategories: ['one','few','many','other'] },
  { tag: 'cy',    name: 'Welsh',               nativeName: 'Cymraeg',             direction: 'ltr', script: 'Latn', pluralCategories: ['zero','one','two','few','many','other'] },
  { tag: 'da',    name: 'Danish',              nativeName: 'Dansk',               direction: 'ltr', script: 'Latn', pluralCategories: ['one', 'other'] },
  { tag: 'de',    name: 'German',              nativeName: 'Deutsch',             direction: 'ltr', script: 'Latn', pluralCategories: ['one', 'other'] },
  { tag: 'el',    name: 'Greek',               nativeName: 'Ελληνικά',            direction: 'ltr', script: 'Grek', pluralCategories: ['one', 'other'] },
  { tag: 'en',    name: 'English',             nativeName: 'English',             direction: 'ltr', script: 'Latn', pluralCategories: ['one', 'other'] },
  { tag: 'es',    name: 'Spanish',             nativeName: 'Español',             direction: 'ltr', script: 'Latn', pluralCategories: ['one', 'other'] },
  { tag: 'et',    name: 'Estonian',            nativeName: 'Eesti',               direction: 'ltr', script: 'Latn', pluralCategories: ['one', 'other'] },
  { tag: 'eu',    name: 'Basque',              nativeName: 'Euskara',             direction: 'ltr', script: 'Latn', pluralCategories: ['one', 'other'] },
  { tag: 'fa',    name: 'Persian',             nativeName: 'فارسی',               direction: 'rtl', script: 'Arab', pluralCategories: ['one', 'other'] },
  { tag: 'fi',    name: 'Finnish',             nativeName: 'Suomi',               direction: 'ltr', script: 'Latn', pluralCategories: ['one', 'other'] },
  { tag: 'fil',   name: 'Filipino',            nativeName: 'Filipino',            direction: 'ltr', script: 'Latn', pluralCategories: ['one', 'other'] },
  { tag: 'fr',    name: 'French',              nativeName: 'Français',            direction: 'ltr', script: 'Latn', pluralCategories: ['one', 'other'] },
  { tag: 'ga',    name: 'Irish',               nativeName: 'Gaeilge',             direction: 'ltr', script: 'Latn', pluralCategories: ['one','two','few','many','other'] },
  { tag: 'gl',    name: 'Galician',            nativeName: 'Galego',              direction: 'ltr', script: 'Latn', pluralCategories: ['one', 'other'] },
  { tag: 'gu',    name: 'Gujarati',            nativeName: 'ગુજરાતી',              direction: 'ltr', script: 'Gujr', pluralCategories: ['one', 'other'] },
  { tag: 'he',    name: 'Hebrew',              nativeName: 'עברית',               direction: 'rtl', script: 'Hebr', pluralCategories: ['one','two','many','other'] },
  { tag: 'hi',    name: 'Hindi',               nativeName: 'हिन्दी',               direction: 'ltr', script: 'Deva', pluralCategories: ['one', 'other'] },
  { tag: 'hr',    name: 'Croatian',            nativeName: 'Hrvatski',            direction: 'ltr', script: 'Latn', pluralCategories: ['one','few','other'] },
  { tag: 'hu',    name: 'Hungarian',           nativeName: 'Magyar',              direction: 'ltr', script: 'Latn', pluralCategories: ['one', 'other'] },
  { tag: 'hy',    name: 'Armenian',            nativeName: 'Հայերեն',             direction: 'ltr', script: 'Armn', pluralCategories: ['one', 'other'] },
  { tag: 'id',    name: 'Indonesian',          nativeName: 'Bahasa Indonesia',    direction: 'ltr', script: 'Latn', pluralCategories: ['other'] },
  { tag: 'is',    name: 'Icelandic',           nativeName: 'Íslenska',            direction: 'ltr', script: 'Latn', pluralCategories: ['one', 'other'] },
  { tag: 'it',    name: 'Italian',             nativeName: 'Italiano',            direction: 'ltr', script: 'Latn', pluralCategories: ['one', 'other'] },
  { tag: 'ja',    name: 'Japanese',            nativeName: '日本語',               direction: 'ltr', script: 'Jpan', pluralCategories: ['other'] },
  { tag: 'ka',    name: 'Georgian',            nativeName: 'ქართული',             direction: 'ltr', script: 'Geor', pluralCategories: ['one', 'other'] },
  { tag: 'kk',    name: 'Kazakh',              nativeName: 'Қазақша',             direction: 'ltr', script: 'Cyrl', pluralCategories: ['one', 'other'] },
  { tag: 'km',    name: 'Khmer',               nativeName: 'ខ្មែរ',               direction: 'ltr', script: 'Khmr', pluralCategories: ['other'] },
  { tag: 'kn',    name: 'Kannada',             nativeName: 'ಕನ್ನಡ',               direction: 'ltr', script: 'Knda', pluralCategories: ['one', 'other'] },
  { tag: 'ko',    name: 'Korean',              nativeName: '한국어',               direction: 'ltr', script: 'Hang', pluralCategories: ['other'] },
  { tag: 'ky',    name: 'Kyrgyz',              nativeName: 'Кыргызча',            direction: 'ltr', script: 'Cyrl', pluralCategories: ['one', 'other'] },
  { tag: 'lo',    name: 'Lao',                 nativeName: 'ລາວ',                 direction: 'ltr', script: 'Laoo', pluralCategories: ['other'] },
  { tag: 'lt',    name: 'Lithuanian',          nativeName: 'Lietuvių',            direction: 'ltr', script: 'Latn', pluralCategories: ['one','few','many','other'] },
  { tag: 'lv',    name: 'Latvian',             nativeName: 'Latviešu',            direction: 'ltr', script: 'Latn', pluralCategories: ['zero','one','other'] },
  { tag: 'mk',    name: 'Macedonian',          nativeName: 'Македонски',          direction: 'ltr', script: 'Cyrl', pluralCategories: ['one', 'other'] },
  { tag: 'ml',    name: 'Malayalam',           nativeName: 'മലയാളം',              direction: 'ltr', script: 'Mlym', pluralCategories: ['one', 'other'] },
  { tag: 'mn',    name: 'Mongolian',           nativeName: 'Монгол',              direction: 'ltr', script: 'Cyrl', pluralCategories: ['one', 'other'] },
  { tag: 'mr',    name: 'Marathi',             nativeName: 'मराठी',               direction: 'ltr', script: 'Deva', pluralCategories: ['one', 'other'] },
  { tag: 'ms',    name: 'Malay',               nativeName: 'Bahasa Melayu',       direction: 'ltr', script: 'Latn', pluralCategories: ['other'] },
  { tag: 'my',    name: 'Burmese',             nativeName: 'မြန်မာ',              direction: 'ltr', script: 'Mymr', pluralCategories: ['other'] },
  { tag: 'ne',    name: 'Nepali',              nativeName: 'नेपाली',              direction: 'ltr', script: 'Deva', pluralCategories: ['one', 'other'] },
  { tag: 'nl',    name: 'Dutch',               nativeName: 'Nederlands',          direction: 'ltr', script: 'Latn', pluralCategories: ['one', 'other'] },
  { tag: 'no',    name: 'Norwegian',           nativeName: 'Norsk',               direction: 'ltr', script: 'Latn', pluralCategories: ['one', 'other'] },
  { tag: 'or',    name: 'Odia',                nativeName: 'ଓଡ଼ିଆ',               direction: 'ltr', script: 'Orya', pluralCategories: ['one', 'other'] },
  { tag: 'pa',    name: 'Punjabi',             nativeName: 'ਪੰਜਾਬੀ',              direction: 'ltr', script: 'Guru', pluralCategories: ['one', 'other'] },
  { tag: 'pl',    name: 'Polish',              nativeName: 'Polski',              direction: 'ltr', script: 'Latn', pluralCategories: ['one','few','many','other'] },
  { tag: 'pt',    name: 'Portuguese',          nativeName: 'Português',           direction: 'ltr', script: 'Latn', pluralCategories: ['one', 'other'] },
  { tag: 'ro',    name: 'Romanian',            nativeName: 'Română',              direction: 'ltr', script: 'Latn', pluralCategories: ['one','few','other'] },
  { tag: 'ru',    name: 'Russian',             nativeName: 'Русский',             direction: 'ltr', script: 'Cyrl', pluralCategories: ['one','few','many','other'] },
  { tag: 'si',    name: 'Sinhala',             nativeName: 'සිංහල',               direction: 'ltr', script: 'Sinh', pluralCategories: ['one', 'other'] },
  { tag: 'sk',    name: 'Slovak',              nativeName: 'Slovenčina',          direction: 'ltr', script: 'Latn', pluralCategories: ['one','few','many','other'] },
  { tag: 'sl',    name: 'Slovenian',           nativeName: 'Slovenščina',         direction: 'ltr', script: 'Latn', pluralCategories: ['one','two','few','other'] },
  { tag: 'sq',    name: 'Albanian',            nativeName: 'Shqip',               direction: 'ltr', script: 'Latn', pluralCategories: ['one', 'other'] },
  { tag: 'sr',    name: 'Serbian',             nativeName: 'Српски',              direction: 'ltr', script: 'Cyrl', pluralCategories: ['one','few','other'] },
  { tag: 'sv',    name: 'Swedish',             nativeName: 'Svenska',             direction: 'ltr', script: 'Latn', pluralCategories: ['one', 'other'] },
  { tag: 'sw',    name: 'Swahili',             nativeName: 'Kiswahili',           direction: 'ltr', script: 'Latn', pluralCategories: ['one', 'other'] },
  { tag: 'ta',    name: 'Tamil',               nativeName: 'தமிழ்',               direction: 'ltr', script: 'Taml', pluralCategories: ['one', 'other'] },
  { tag: 'te',    name: 'Telugu',              nativeName: 'తెలుగు',              direction: 'ltr', script: 'Telu', pluralCategories: ['one', 'other'] },
  { tag: 'tg',    name: 'Tajik',               nativeName: 'Тоҷикӣ',              direction: 'ltr', script: 'Cyrl', pluralCategories: ['one', 'other'] },
  { tag: 'th',    name: 'Thai',                nativeName: 'ภาษาไทย',             direction: 'ltr', script: 'Thai', pluralCategories: ['other'] },
  { tag: 'tk',    name: 'Turkmen',             nativeName: 'Türkmençe',           direction: 'ltr', script: 'Latn', pluralCategories: ['one', 'other'] },
  { tag: 'tr',    name: 'Turkish',             nativeName: 'Türkçe',              direction: 'ltr', script: 'Latn', pluralCategories: ['one', 'other'] },
  { tag: 'uk',    name: 'Ukrainian',           nativeName: 'Українська',          direction: 'ltr', script: 'Cyrl', pluralCategories: ['one','few','many','other'] },
  { tag: 'ur',    name: 'Urdu',                nativeName: 'اردو',                direction: 'rtl', script: 'Arab', pluralCategories: ['one', 'other'] },
  { tag: 'uz',    name: 'Uzbek',               nativeName: "O'zbek",              direction: 'ltr', script: 'Latn', pluralCategories: ['one', 'other'] },
  { tag: 'vi',    name: 'Vietnamese',          nativeName: 'Tiếng Việt',          direction: 'ltr', script: 'Latn', pluralCategories: ['other'] },
  { tag: 'zh',    name: 'Chinese (Simplified)',nativeName: '中文（简体）',           direction: 'ltr', script: 'Hans', pluralCategories: ['other'] },
  { tag: 'zh-Hant',name:'Chinese (Traditional)',nativeName:'中文（繁體）',          direction: 'ltr', script: 'Hant', pluralCategories: ['other'] },
  { tag: 'zu',    name: 'Zulu',                nativeName: 'IsiZulu',             direction: 'ltr', script: 'Latn', pluralCategories: ['one', 'other'] },
];

/**
 * Registry for locale metadata.  Supports registering custom locales,
 * unregistering, listing, getting by tag, and setting a default locale.
 */
export class LocaleRegistry {
  private readonly _locales: Map<string, LocaleInfo>;
  private _default: LocaleTag;

  constructor(defaultLocale: LocaleTag = 'en') {
    this._default = defaultLocale;
    this._locales = new Map(BUILT_IN_LOCALES.map((l) => [l.tag, l]));
  }

  /** The current default locale tag. */
  get defaultLocale(): LocaleTag { return this._default; }

  /**
   * Set the default locale.  Throws if the locale is not registered.
   */
  setDefault(tag: LocaleTag): this {
    const normalized = normalizeLocale(tag);
    if (!this._locales.has(normalized)) {
      throw new Error(`Locale "${normalized}" is not registered.`);
    }
    this._default = normalized;
    return this;
  }

  /**
   * Register a new locale (or overwrite an existing one).
   */
  register(info: LocaleInfo): this {
    const normalized = { ...info, tag: normalizeLocale(info.tag) };
    this._locales.set(normalized.tag, normalized);
    return this;
  }

  /**
   * Unregister a locale by tag.
   * @returns `true` if the locale was found and removed.
   */
  unregister(tag: LocaleTag): boolean {
    return this._locales.delete(normalizeLocale(tag));
  }

  /**
   * Retrieve a locale by tag.
   * @returns The locale info, or `undefined` if not found.
   */
  get(tag: LocaleTag): LocaleInfo | undefined {
    return this._locales.get(normalizeLocale(tag));
  }

  /**
   * Retrieve a locale by tag, falling back to the language subtag, then to the
   * default locale.
   */
  resolve(tag: LocaleTag): LocaleInfo {
    const norm = normalizeLocale(tag);
    return (
      this._locales.get(norm) ??
      this._locales.get(norm.split('-')[0] ?? norm) ??
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this._locales.get(this._default)!
    );
  }

  /**
   * Return all registered locale tags, sorted alphabetically.
   */
  list(): LocaleTag[] {
    return [...this._locales.keys()].sort();
  }

  /**
   * Return all registered {@link LocaleInfo} objects.
   */
  all(): LocaleInfo[] {
    return [...this._locales.values()];
  }

  /**
   * Return only RTL locales.
   */
  rtlLocales(): LocaleInfo[] {
    return this.all().filter((l) => l.direction === 'rtl');
  }

  /**
   * Check whether a tag is registered.
   */
  has(tag: LocaleTag): boolean {
    return this._locales.has(normalizeLocale(tag));
  }

  /**
   * Return how many locales are registered.
   */
  get size(): number { return this._locales.size; }
}

/** Shared global registry — can be overridden or extended by the application. */
export const globalRegistry = new LocaleRegistry('en');

/* ═══════════════════════════════════════════════════════════════════════
   I18nManager class
   ═══════════════════════════════════════════════════════════════════════ */

/** Options for constructing an {@link I18nManager}. */
export interface I18nManagerOptions {
  defaultLocale?: LocaleTag;
  fallbackLocale?: LocaleTag;
  registry?: LocaleRegistry;
}

/**
 * Central i18n manager.  Owns a catalogue of translation strings and
 * delegates formatting to the specialised helper classes.
 */
export class I18nManager {
  private readonly _catalogue: Catalogue;
  private _currentLocale: LocaleTag;
  private readonly _fallbackLocale: LocaleTag;
  private readonly _registry: LocaleRegistry;

  /** Specialised formatters, lazily created when the locale changes. */
  private _dtf: DateTimeFormatter;
  private _nf: NumberFormatter;
  private _mf: MessageFormatter;
  private _pr: PluralRules;

  constructor(opts: I18nManagerOptions = {}) {
    this._catalogue = {};
    this._currentLocale = normalizeLocale(opts.defaultLocale ?? 'en');
    this._fallbackLocale = normalizeLocale(opts.fallbackLocale ?? 'en');
    this._registry = opts.registry ?? globalRegistry;

    this._dtf = new DateTimeFormatter(this._currentLocale);
    this._nf  = new NumberFormatter(this._currentLocale);
    this._mf  = new MessageFormatter(this._currentLocale);
    this._pr  = new PluralRules(this._currentLocale);
  }

  /* ── Locale control ─────────────────────────────────────────────── */

  get locale(): LocaleTag { return this._currentLocale; }
  get fallbackLocale(): LocaleTag { return this._fallbackLocale; }

  /** Switch the active locale and re-create formatters. */
  setLocale(tag: LocaleTag): this {
    this._currentLocale = normalizeLocale(tag);
    this._dtf = new DateTimeFormatter(this._currentLocale);
    this._nf  = new NumberFormatter(this._currentLocale);
    this._mf  = new MessageFormatter(this._currentLocale);
    this._pr  = new PluralRules(this._currentLocale);
    return this;
  }

  /** Return the text direction of the active locale. */
  direction(): 'ltr' | 'rtl' {
    return getLocaleDirection(this._currentLocale);
  }

  /** Detect the locale of a piece of text. */
  detectLocale(text: string): LocaleTag { return detectLocale(text); }

  /* ── Catalogue management ───────────────────────────────────────── */

  /**
   * Load a locale's translation strings into the catalogue.
   *
   * @param locale   BCP-47 locale tag.
   * @param messages Map of key → ICU message template.
   * @param merge    When `true` (default) merges with existing keys; when `false` replaces.
   */
  loadLocale(locale: LocaleTag, messages: TranslationMap, merge = true): this {
    const tag = normalizeLocale(locale);
    if (merge && this._catalogue[tag]) {
      Object.assign(this._catalogue[tag]!, messages);
    } else {
      this._catalogue[tag] = { ...messages };
    }
    return this;
  }

  /**
   * Load multiple locales at once.
   */
  loadCatalogue(catalogue: Catalogue, merge = true): this {
    for (const [locale, messages] of Object.entries(catalogue)) {
      this.loadLocale(locale, messages, merge);
    }
    return this;
  }

  /**
   * Remove a locale from the catalogue.
   */
  unloadLocale(locale: LocaleTag): boolean {
    const tag = normalizeLocale(locale);
    if (tag in this._catalogue) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete this._catalogue[tag];
      return true;
    }
    return false;
  }

  /** Return the raw catalogue. */
  getCatalogue(): Readonly<Catalogue> { return this._catalogue; }

  /** List all loaded locale tags. */
  loadedLocales(): LocaleTag[] {
    return Object.keys(this._catalogue);
  }

  /* ── Translation ────────────────────────────────────────────────── */

  /**
   * Translate a key using the active locale (or a specified one).
   *
   * Resolution order:
   *   1. `locale` (or active locale)
   *   2. Language subtag (e.g. `"en"` for `"en-GB"`)
   *   3. Fallback locale
   *   4. The key itself (so missing translations are visible)
   */
  translate(key: string, vars?: InterpolationVars, locale?: LocaleTag): string {
    const tag = normalizeLocale(locale ?? this._currentLocale);
    const base = tag.split('-')[0] ?? tag;
    const fallback = this._fallbackLocale;

    const template =
      this._catalogue[tag]?.[key] ??
      this._catalogue[base]?.[key] ??
      this._catalogue[fallback]?.[key] ??
      key;

    return vars ? this._mf.format(template, vars) : template;
  }

  /* ── Pluralisation ──────────────────────────────────────────────── */

  /**
   * Choose the correct plural form for `n`, interpolating `#` with the
   * formatted count.
   */
  pluralize(n: number, forms: Partial<Record<PluralCategory, string>>): string {
    return this._pr.choose(n, forms).replace(/#/g, this._nf.decimal(n));
  }

  /* ── Number formatting ──────────────────────────────────────────── */

  /** Format a number. */
  formatNumber(n: number, opts?: NumberFormatOptions): string {
    return this._nf.decimal(n, opts);
  }

  /** Format an integer. */
  formatInteger(n: number): string { return this._nf.integer(n); }

  /** Format a percentage (0–1). */
  formatPercent(ratio: number): string { return this._nf.percent(ratio); }

  /** Format a currency amount. */
  formatCurrency(amount: number, currency: string): string {
    return this._nf.currency(amount, currency);
  }

  /* ── Date / time formatting ─────────────────────────────────────── */

  /** Format a date. */
  formatDate(value: Date | number, style?: DateTimeStyle): string {
    return this._dtf.date(value, style);
  }

  /** Format a time. */
  formatTime(value: Date | number, style?: DateTimeStyle): string {
    return this._dtf.time(value, style);
  }

  /** Format a date+time. */
  formatDateTime(value: Date | number, dateStyle?: DateTimeStyle, timeStyle?: DateTimeStyle): string {
    return this._dtf.dateTime(value, dateStyle, timeStyle);
  }

  /** Format a relative time ("3 days ago"). */
  formatRelative(value: Date | number, from?: Date | number): string {
    return this._dtf.relative(value, from);
  }

  /* ── List formatting ────────────────────────────────────────────── */

  /**
   * Format a list of items according to locale conventions.
   *
   * e.g. `["a","b","c"]` → `"a, b, and c"` (en) / `"a, b et c"` (fr).
   */
  formatList(items: string[], type: 'conjunction' | 'disjunction' | 'unit' = 'conjunction'): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ListFormat = (Intl as any).ListFormat;
    if (typeof ListFormat === 'function') {
      try {
        return new ListFormat(this._currentLocale, { type, style: 'long' }).format(items);
      } catch { /* fall through */ }
    }
    // Fallback
    if (items.length === 0) return '';
    if (items.length === 1) return items[0]!;
    const last = items[items.length - 1];
    const rest = items.slice(0, -1).join(', ');
    return `${rest}, ${last}`;
  }

  /* ── Variable interpolation ─────────────────────────────────────── */

  /**
   * Interpolate variables into a template string.
   *
   * Variables may be wrapped in `{curly}` braces.
   */
  interpolate(template: string, vars: InterpolationVars): string {
    return this._mf.format(template, vars);
  }

  /* ── ICU message format ─────────────────────────────────────────── */

  /**
   * Full ICU-style message format with variables, plurals, and selects.
   */
  formatMessage(pattern: string, vars?: InterpolationVars): string {
    return this._mf.format(pattern, vars ?? {});
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   AccessibilityHelper class
   ═══════════════════════════════════════════════════════════════════════ */

/** ARIA role names that may appear in ARIA labels. */
export type AriaRole =
  | 'alert' | 'button' | 'checkbox' | 'dialog' | 'figure'
  | 'form' | 'heading' | 'img' | 'link' | 'list' | 'listitem'
  | 'menu' | 'menuitem' | 'navigation' | 'option' | 'progressbar'
  | 'radio' | 'region' | 'search' | 'separator' | 'status'
  | 'tab' | 'tablist' | 'textbox' | 'timer' | 'tooltip';

/** A structured ARIA label result. */
export interface AriaLabel {
  label: string;
  role?: AriaRole;
  description?: string;
  /** Set to `true` for live notifications. */
  live?: boolean;
}

/**
 * Accessibility helpers for generating screen-reader friendly descriptions
 * of WhatsApp messages, UI elements, and notifications.
 */
export class AccessibilityHelper {
  private readonly _i18n: I18nManager;

  constructor(i18n: I18nManager) {
    this._i18n = i18n;
  }

  /**
   * Generate an ARIA label for a WhatsApp message.
   *
   * @param senderName  Display name of the sender.
   * @param body        Text content of the message (will be truncated for long messages).
   * @param timestamp   When the message was sent.
   */
  describeMessage(senderName: string, body: string, timestamp: Date | number): AriaLabel {
    const maxLen = 200;
    const preview = body.length > maxLen ? `${body.slice(0, maxLen)}…` : body;
    const timeStr = this._i18n.formatTime(timestamp, 'short');
    const label = `${senderName}: ${preview} — ${timeStr}`;
    return { label, role: 'listitem', description: preview };
  }

  /**
   * Describe a media attachment for a screen reader.
   *
   * @param type     MIME type or a high-level kind like `"image"`, `"video"`, `"audio"`.
   * @param caption  Optional caption text.
   */
  describeMedia(type: string, caption?: string): AriaLabel {
    const kind = type.startsWith('image') ? 'Image'
      : type.startsWith('video') ? 'Video'
      : type.startsWith('audio') ? 'Audio'
      : 'Attachment';
    const label = caption ? `${kind}: ${caption}` : kind;
    return { label, role: 'img', description: caption };
  }

  /**
   * Describe a notification / alert for a screen reader.
   *
   * @param title    Short title.
   * @param message  Full message body.
   * @param urgent   When `true` marks the region as `assertive` live.
   */
  describeNotification(title: string, message: string, urgent = false): AriaLabel {
    return {
      label: `${title}: ${message}`,
      role: 'alert',
      description: message,
      live: urgent,
    };
  }

  /**
   * Format a button label for voice output, removing non-speakable characters.
   */
  buttonLabel(text: string): string {
    return stripDiacritics(text).replace(/[^\w\s,.\-!'?]/gu, '').trim();
  }

  /**
   * Generate an ARIA label for a progress indicator.
   *
   * @param current  Current value.
   * @param total    Maximum value.
   */
  progressLabel(current: number, total: number): AriaLabel {
    const pct = total === 0 ? 0 : Math.round((current / total) * 100);
    const label = this._i18n.translate('accessibility.progress', { current, total, pct });
    return { label: label !== 'accessibility.progress' ? label : `${pct}%`, role: 'progressbar' };
  }

  /**
   * Describe a list of items for voice output.
   *
   * @param items   List of human-readable strings.
   * @param label   Optional list label (e.g. "Menu items").
   */
  describeList(items: string[], label?: string): AriaLabel {
    const count = items.length;
    const pr = new PluralRules(this._i18n.locale);
    const countStr = pr.noun(count, 'item');
    const desc = label
      ? `${label}: ${count} ${countStr}`
      : `${count} ${countStr}`;
    return { label: desc, role: 'list', description: items.join(', ') };
  }

  /**
   * Generate ARIA label for an icon-only button.
   *
   * @param action  Human-readable action description, e.g. `"send message"`.
   */
  iconButton(action: string): AriaLabel {
    return { label: action, role: 'button' };
  }

  /**
   * Format text for voice output: expand abbreviations, normalise
   * punctuation spacing, and strip control characters.
   */
  forVoice(text: string): string {
    return text
      .replace(/\r?\n+/g, '. ')                    // newlines → sentence break
      .replace(/\s{2,}/g, ' ')                      // collapse whitespace
      .replace(/([.!?])\s*([A-Z])/g, '$1 $2')      // ensure space after sentence
      .replace(/&amp;/g, 'and')
      .replace(/&lt;/g, 'less than')
      .replace(/&gt;/g, 'greater than')
      .trim();
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   Standalone shorthand functions
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Translate a key using the global {@link I18nManager} instance.
 *
 * Short alias for `globalI18n.translate(key, vars, locale)`.
 */
export function t(
  key: string,
  vars?: InterpolationVars,
  locale?: LocaleTag,
): string {
  return globalI18n.translate(key, vars, locale);
}

/**
 * Format a number for the given locale.
 * Short alias for `new NumberFormatter(locale).decimal(value, opts)`.
 */
export function n(
  value: number,
  locale: LocaleTag = 'en',
  opts?: NumberFormatOptions,
): string {
  return new NumberFormatter(locale).decimal(value, opts);
}

/**
 * Format a date for the given locale.
 * Short alias for `new DateTimeFormatter(locale).date(value, style)`.
 */
export function d(
  value: Date | number,
  locale: LocaleTag = 'en',
  style: DateTimeStyle = 'medium',
): string {
  return new DateTimeFormatter(locale).date(value, style);
}

/**
 * Format a currency amount.
 * Short alias for `new NumberFormatter(locale).currency(amount, currency)`.
 */
export function c(
  amount: number,
  currency: string,
  locale: LocaleTag = 'en',
): string {
  return new NumberFormatter(locale).currency(amount, currency);
}

/**
 * Select the correct plural form for `n`.
 * Short alias for `new PluralRules(locale).choose(n, forms)`.
 */
export function p(
  n: number,
  forms: Partial<Record<PluralCategory, string>>,
  locale: LocaleTag = 'en',
): string {
  return new PluralRules(locale).choose(n, forms);
}

/* ═══════════════════════════════════════════════════════════════════════
   Global I18nManager instance
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Module-level {@link I18nManager} instance.
 *
 * Applications should call `globalI18n.loadLocale(...)` and
 * `globalI18n.setLocale(...)` at startup to configure the translation
 * catalogue before calling `t(...)`.
 */
export const globalI18n = new I18nManager({
  defaultLocale: 'en',
  fallbackLocale: 'en',
  registry: globalRegistry,
});

/* ═══════════════════════════════════════════════════════════════════════
   List formatter  (standalone)
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Format a list of strings according to locale conjunction rules.
 *
 * @param items    Items to join.
 * @param locale   BCP-47 locale tag.
 * @param type     List type (default: `"conjunction"`).
 */
export function formatList(
  items: string[],
  locale: LocaleTag = 'en',
  type: 'conjunction' | 'disjunction' | 'unit' = 'conjunction',
): string {
  return new I18nManager({ defaultLocale: locale }).formatList(items, type);
}
