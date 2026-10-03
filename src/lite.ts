/**
 * Lightweight entry point — **zero upstream engine**.
 *
 * The root entry re-exports all of Baileys (`export * from
 * '@whiskeysockets/baileys'`), which is the right call for a bot that needs a
 * socket and the wrong one for a script that only wants `canonicalThreadKey`,
 * `compose`, a clock estimate or the anti-ban engine. Importing the root costs
 * roughly a second and ~22 MB of heap, almost all of it protobufjs, libsignal and
 * the rest of the protocol stack.
 *
 * This entry pulls **none** of that. Everything here is pure: string and number
 * helpers, timing estimators, the interception primitive, the logger, and the
 * anti-ban engines. If your process never opens a socket, import
 * `nyx-baileys/lite` and skip the engine entirely.
 *
 * Rule for keeping it honest: nothing in the transitive import graph of this
 * file may import `@whiskeysockets/baileys` at runtime. `import type` is fine —
 * it is erased. `tests/lite.test.js` enforces the rule.
 */

/* ── identifiers ─────────────────────────────────────────────────────── */
export {
  bareJid,
  canonicalThreadKey,
  deviceOf,
  isBroadcast,
  isGroup,
  isLid,
  isNewsletter,
  isPn,
  kindOf,
  phoneOf,
  sameUser,
  toLidJid,
  toPnJid,
  userOf,
} from './core/jid.js';
export type { JidKind } from './core/jid.js';

/* ── timing and health estimators ────────────────────────────────────── */
export { ClockSync } from './core/clock.js';
export type { ClockSample, ClockSyncOptions, ClockSyncStats } from './core/clock.js';
export { DeliveryTracker } from './core/delivery.js';
export type { DeliveryStats, DeliveryTrackerOptions } from './core/delivery.js';
export {
  MessageRetryReason,
  MAC_ERROR_CODES,
  parseRetryReason,
  isMacError,
  isRetryable,
  describeRetryReason,
} from './core/retry.js';

/* ── errors ──────────────────────────────────────────────────────────── */
export {
  NyxError,
  SessionNotFoundError,
  NotConnectedError,
  InvalidSessionIdError,
  QueueFullError,
  BurstCeilingError,
  PayloadTooLargeError,
  isNyxError,
} from './core/errors.js';

/* ── interception primitive ──────────────────────────────────────────── */
export { patch, patchAll, Disposables } from './core/intercept.js';
export type { Patch } from './core/intercept.js';

/* ── logging ─────────────────────────────────────────────────────────── */
export { createLogger, silentLogger } from './utils/logger.js';

/* ── pure text and display helpers ───────────────────────────────────── */
export * from './utils/text.js';
export * from './utils/format.js';

/* ── engine-free bot primitives ─────────────────────────────────────── */
export * from './core/store.js';
export * from './core/tasks.js';
export * from './core/conversation.js';
export * from './core/mention.js';
export * from './utils/random.js';
export * from './utils/time.js';
export * from './utils/args.js';
export * from './utils/cache.js';
export * from './utils/queue.js';
export * from './utils/validate.js';

/* ── anti-ban engines (pure) ─────────────────────────────────────────── */
export * from './antiban/index.js';
export {
  antibanPlugins,
  contentVariation,
  humanEntropy,
  legitimacySignals,
  presenceChoreography,
  readReceiptVariancePlugin,
} from './plugins/antiban.js';

/* ── types ───────────────────────────────────────────────────────────── */
export type { Logger, Plugin, PluginContext, SuperOptions } from './utils/types.js';
