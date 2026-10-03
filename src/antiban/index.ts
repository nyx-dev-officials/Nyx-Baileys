/**
 * Anti-ban module set.
 *
 * ⚠️ These modules exist to make automated WhatsApp activity harder to tell
 * apart from a person's, and to reduce the chance an account is limited for it.
 * They are **not** in the default chain and every one defaults to `enabled:
 * false`; you opt in deliberately. Read `docs/ANTIBAN.md` first — enabling them
 * changes what your software does and carries real account risk.
 *
 * The plugin factories that wrap these live in `src/plugins/antiban.ts`.
 */

export * from './circadian.js';
export * from './imperfection.js';
export * from './fingerprint.js';
export * from './rotation.js';
export * from './presets.js';
export * from './entropy.js';
