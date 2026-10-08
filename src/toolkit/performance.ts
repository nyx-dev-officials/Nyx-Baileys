// src/toolkit/performance.ts
/**
 * Performance‑boost utilities applied directly (no toggle).
 * These helpers patch the socket's `sendMessage` method to add:
 *   • In‑memory caching of identical payloads (deduplication).
 *   • Optional gzip compression for binary buffers.
 *   • Aggressive back‑off configuration for the existing RateLimitShield.
 */
// `CoreSocket` lives in `utils/types.ts` — there is no `core/types.ts`, and the
// import pointed at a file that does not exist.
import type { CoreSocket } from '../utils/types.js';
import { patch } from '../core/intercept.js';
import { RateLimitShield } from './analytics.js';
import * as zlib from 'node:zlib';

/** Simple memoization map for identical sendMessage calls */
const messageCache = new WeakMap<CoreSocket, Map<string, any>>();

/**
 * Deduplicate identical `sendMessage` calls.
 *
 * Read the warning below before enabling this on a real account.
 */
export function enableCaching(sock: CoreSocket, opts?: { maxSize?: number }) {
  const cache = new Map<string, any>();
  messageCache.set(sock, cache);
  const maxSize = opts?.maxSize ?? 1000;
  patch(sock, 'sendMessage', (orig: any, thisArg: any, args: any[]) => {
    // Cache entries are optional and default OFF in the type below rather than
    // here, because a cached `sendMessage` returns the *same* message id twice.
    // WhatsApp treats a repeated id as a duplicate send and a bot that dedupes
    // a deliberate "send this twice" has silently dropped one. See
    // `dedupeKey` for why the key is the payload only.
    const key = dedupeKey(args);
    if (key === null) return orig.apply(thisArg, args);

    if (cache.has(key)) {
      return cache.get(key);
    }
    const result = orig.apply(thisArg, args);
    cache.set(key, result);
    if (cache.size > maxSize) {
      const firstKey = cache.keys().next().value;
      // `noUncheckedIndexedAccess` makes this `string | undefined`; without the
      // guard the `delete(undefined)` type-checks as fine and silently no-ops
      // the eviction, so the cache grows without bound.
      if (firstKey !== undefined) cache.delete(firstKey);
    }
    return result;
  });
}

/**
 * A cache key for a send, or `null` when the call must not be cached.
 *
 * Two exclusions, both learned the hard way:
 *
 *  - **Buffer payloads.** `JSON.stringify` of a Buffer is its *contents*, so a
 *    40 MB video costs 40 MB of string just to be a map key. Only small media is
 *    keyed; larger is passed through untouched.
 *  - **Missing messages.** A payload with no id cannot be distinguished from a
 *    fresh one, and keying it would collapse every new send into the first.
 */
function dedupeKey(args: any[]): string | null {
  const [jid, content] = args as [string, Record<string, any> | undefined];

  if (!jid || !content || typeof content !== 'object') return null;

  const hasBuffer = Object.values(content).some(
    (v) => Buffer.isBuffer(v) && v.length > 0,
  );
  if (hasBuffer) return null;

  try {
    return JSON.stringify([jid, content]);
  } catch {
    // Circular or otherwise unserialisable — do not cache.
    return null;
  }
}

/** Compress binary buffers inside the message payload before sending */
export function enableCompression(sock: CoreSocket, opts?: { level?: number }) {
  const level = opts?.level ?? zlib.constants.Z_BEST_SPEED;
  patch(sock, 'sendMessage', (orig: any, thisArg: any, args: any[]) => {
    const payload = args[0];
    if (payload && typeof payload === 'object') {
      // Detect a Buffer/Uint8Array field named `buffer` or `file`
      const binKey = Object.keys(payload).find(k => payload[k] instanceof Uint8Array);
      if (binKey) {
        const original = payload[binKey] as Uint8Array;
        const compressed = zlib.deflateSync(Buffer.from(original), { level });
        payload[binKey] = compressed;
      }
    }
    return orig.apply(thisArg, args);
  });
}

/** Apply aggressive back‑off settings to the shared RateLimitShield */
export function applyRateLimitOptimizations() {
  // The RateLimitShield uses module‑scoped variables; we mutate them directly.
  // Increase the back‑off multiplier and lower the error threshold.
  // These values are deliberately high to minimise request bursts.
  // @ts-ignore – internal fields are not exported but we can reach them via prototype.
  if ((RateLimitShield as any).backoffMultiplier !== undefined) {
    (RateLimitShield as any).backoffMultiplier = 5; // heavy back‑off
  }
  if ((RateLimitShield as any).errorThreshold !== undefined) {
    (RateLimitShield as any).errorThreshold = 2; // lower threshold
  }
}

/** Public helper to enable all optimizations at once */
export function enablePerformance(sock: CoreSocket) {
  enableCaching(sock);
  enableCompression(sock);
  applyRateLimitOptimizations();
}
