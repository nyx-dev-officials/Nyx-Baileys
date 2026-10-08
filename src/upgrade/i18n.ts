// src/upgrade/i18n.ts
/**
 * Internationalization adapter.
 *
 * The previous body indexed a fixed two-language literal with a `string`, which
 * is a type error under `strict` and a runtime `TypeError` for any locale
 * outside `en`/`es`. It also duplicated functionality that now lives properly in
 * `src/toolkit/i18n.ts` — real locale formatting, bidirectional handling, and
 * per-key coverage reporting.
 *
 * So this is now a thin adapter over that module rather than a second i18n
 * implementation. Two implementations of the same thing drift, and the stub's
 * failure mode (throwing on an unknown locale) is the worst possible one.
 *
 * Nothing imported this file, so the change is safe.
 */

import {
  translate,
  coverage,
  missingLanguages,
  forMessage,
  directionOf,
  number as formatNumber,
  money,
  date,
  time,
  duration,
  type Catalogue,
} from '../toolkit/i18n.js';

export {
  translate, coverage, missingLanguages,
  forMessage, directionOf,
  formatNumber, money, date, time, duration,
};
export type { Catalogue };

/** The shape returned by `initI18n`, unchanged from the stub's signature. */
export interface Translator {
  (key: string, locale?: string, params?: Record<string, string | number>): string;
}

/**
 * Build a translator over a catalogue.
 *
 * A missing locale or key returns the key itself rather than throwing or
 * returning an empty string — so an untranslated string is visible in the UI as
 * `checkout.button.pay` and can be found, instead of rendering as a blank gap
 * that looks like a rendering bug.
 */
export function initI18n(catalogue: Catalogue = {}, fallbackLang = 'en'): Translator {
  return (key, locale = fallbackLang, params = {}) =>
    translate(catalogue, key, locale, params, fallbackLang);
}

/**
 * The two-locale dictionary the stub shipped, kept so existing callers keep
 * working. Real catalogues belong in the caller's own config.
 */
export const DEFAULT_CATALOGUE: Catalogue = {
  en: { welcome: 'Welcome' },
  es: { welcome: 'Bienvenido' },
};