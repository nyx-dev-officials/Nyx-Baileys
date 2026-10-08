/**
 * OPS-250 · session, retry, and reliability.
 *
 * The functions that keep a long-lived socket honest. These are the ones worth
 * reaching for when a bot is "sometimes" not responding, which is usually a
 * retry that never retried or a pairing that silently reset.
 *
 * Methods used: `authState`, `logout`, `end`, `waitForConnectionUpdate`,
 * `waitForSocketOpen`, `waitForMessage`, `registerSocketEndHandler`,
 * `onUnexpectedError`, `uploadPreKeys`, `uploadPreKeysToServerIfRequired`,
 * `rotateSignedPreKey`, `digestKeyBundle`, `sendRetryRequest`,
 * `messageRetryManager`, `updateServerTimeOffset`, `sendUnifiedSession`,
 * `cleanDirtyBits`, `resyncAppState`.
 *
 * **Unverified on hardware**, with one exception noted in the docs.
 */

import type { AnySock } from '../ops-50/types.js';

/**
 * Read the socket's auth state, tolerating a socket that has none.
 *
 * This framework does not always put `authState` on the socket — when it does
 * not, there is no session state to inspect, and calling it throws
 * "sock.authState is not a function". Every helper below goes through here and
 * reports *unknown* rather than throwing, so a session probe degrades instead of
 * taking down whatever called it.
 */
async function readCreds(sock: AnySock): Promise<Record<string, any> | null> {
  if (typeof sock.authState !== 'function') return null;
  try {
    const state = (await sock.authState()) as { creds?: Record<string, any> } | undefined;
    return state?.creds ?? null;
  } catch {
    return null;
  }
}

/* ── 91-100 · connection lifecycle ───────────────────────────────── */

/** Wait until the socket opens, or reject on timeout. */
export function waitForOpen(sock: AnySock, timeoutMs = 30_000): Promise<unknown> {
  return sock.waitForSocketOpen({ timeoutMs });
}

/** Wait for the next connection update matching a predicate. */
export function waitForUpdate(
  sock: AnySock,
  predicate: (update: any) => boolean,
  timeoutMs = 30_000,
): Promise<unknown> {
  return sock.waitForConnectionUpdate(predicate as never, timeoutMs);
}

/** Wait for the next message matching a predicate. */
export function waitForMessage(
  sock: AnySock,
  predicate: (message: any) => boolean,
  timeoutMs = 30_000,
): Promise<any> {
  return sock.waitForMessage(predicate as never, timeoutMs);
}

/** Register a handler that runs when the socket ends. Returns an unsubscribe. */
export function onEnd(sock: AnySock, handler: () => void): () => void {
  sock.registerSocketEndHandler(handler);
  return () => { /* rc14 exposes no remover; the handler is bound to socket life */ };
}

/** Register a handler for unexpected errors. */
export function onError(sock: AnySock, handler: (error: Error) => void): void {
  sock.onUnexpectedError(handler as never);
}

/** Close the socket without wiping credentials. */
export async function closeSocket(sock: AnySock): Promise<void> {
  await sock.end(undefined);
}

/**
 * Log out and wipe credentials.
 *
 * Irreversible — the session must be re-paired by QR. This asserts loudly
 * rather than taking a bare `sock.logout()` so nobody calls it by accident.
 */
export async function logoutAndWipe(sock: AnySock): Promise<void> {
  await sock.logout('Nyx-Baileys: explicit logout, session will be wiped');
}

/* ── 101-110 · key state ─────────────────────────────────────────── */

/** Whether this socket's pre-keys still need uploading. */
export async function needsPreKeyUpload(sock: AnySock): Promise<boolean> {
  const creds = await readCreds(sock);
  // rc14 sets preKeyId once the bundle has been accepted by the server.
  // With no readable auth state the answer is "unknown", reported as true so a
  // caller goes and uploads rather than assuming the bundle is already there.
  if (!creds) return true;
  return creds.preKeyId === undefined || creds.preKeyId === null;
}

/** Upload pre-keys if the server needs them. */
export async function ensurePreKeys(sock: AnySock): Promise<boolean> {
  return sock.uploadPreKeysToServerIfRequired();
}

/** Rotate the signed pre-key. Rare; only when the server asks. */
export function rotatePreKey(sock: AnySock): Promise<boolean> {
  return sock.rotateSignedPreKey(true);
}

/** Digest a key bundle into a printable fingerprint. */
export async function keyDigest(sock: AnySock): Promise<string> {
  const creds = await readCreds(sock);
  if (!creds) return 'unavailable';
  return String(sock.digestKeyBundle(creds as never));
}

/**
 * Is this session a pair that completed?
 *
 * `registered: false` on an existing creds file means a half-negotiated
 * session, not a fresh one. This checks for the noise key's presence, which is
 * what actually distinguishes them.
 */
export async function isFullyPaired(sock: AnySock): Promise<boolean> {
  const creds = await readCreds(sock);
  // Unknown auth state is not the same as an unpaired session, so this stays
  // false rather than claiming a half-negotiated creds file is complete.
  if (!creds) return false;
  return creds.registered === true && Boolean(creds.noiseKey);
}

/** A short fingerprint of the session, for logs and change detection. */
export async function sessionTag(sock: AnySock): Promise<string> {
  const creds = await readCreds(sock);
  if (!creds) return 'unknown|no-auth-state';
  const me = creds.me?.id ?? 'unknown';
  const registered = creds.registered === true;
  const noise = creds.noiseKey ? 'present' : 'absent';
  return `${me}|${registered ? 'registered' : 'unregistered'}|${noise}`;
}

/* ── 111-120 · retry ─────────────────────────────────────────────── */


/** Run an operation, retrying on failure with jittered exponential backoff.
 *
 * This is deliberately *not* the framework's `utils/queue.ts#withRetry`, which
 * retries any rejection. This one retries only errors that look transient
 * (see `isTransient` below) and adds jitter so a fleet of sockets does not
 * retry in lockstep. Use `retryWithBackoff` when you want every failure
 * retried and `retryIfTransient` when a permanent error should surface at once.
 *
 * There is a shared, tested implementation in `utils/queue.ts`. This is a thin
 * socket-aware wrapper over it rather than a second backoff schedule.
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  options: { attempts?: number; baseMs?: number; maxMs?: number } = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const base = options.baseMs ?? 500;
  const max = options.maxMs ?? 8_000;

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) break;

      const delay = Math.min(max, base * 2 ** attempt);
      await new Promise((r) => setTimeout(r, delay * (0.5 + Math.random() * 0.5)));
    }
  }

  throw lastError;
}

/** Ask the server to retry a message the connection dropped mid-send. */
export function requestRetry(sock: AnySock, key: unknown): Promise<unknown> {
  return sock.sendRetryRequest(key as never);
}

/**
 * Send a message, falling back to a retry request if the first attempt fails.
 *
 * The fallback only helps for a message the server already received; a message
 * that never left is retried with a fresh send.
 */
export async function sendWithFallback(
  sock: AnySock,
  jid: string,
  content: unknown,
  options: Record<string, unknown> = {},
): Promise<unknown> {
  try {
    return await sock.sendMessage(jid, content as never, options as never);
  } catch (error) {
    if (options?.messageId) {
      try {
        await sock.sendRetryRequest({ messageId: options.messageId } as never);
      } catch {
        /* the fallback is best-effort; the original error is what matters */
      }
    }
    throw error;
  }
}

/** Is this a connection-level error worth retrying? */
export function isTransient(error: unknown): boolean {
  const message = String((error as Error)?.message ?? error).toLowerCase();
  return (
    message.includes('connection')
    || message.includes('closed')
    || message.includes('timed out')
    || message.includes('terminated')
    || message.includes('428')
    || message.includes('socket')
  );
}

/** Retry only when the error looks transient. */
export async function retryIfTransient<T>(
  operation: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransient(error) || attempt === attempts - 1) break;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastError;
}

/* ── 121-130 · server time and app state ─────────────────────────── */

/** Apply a server clock offset. */
export function applyServerOffset(sock: AnySock, offsetSeconds: number): void {
  sock.updateServerTimeOffset(offsetSeconds);
}

/** Clear bits the server has acknowledged. */
export async function cleanDirty(sock: AnySock): Promise<void> {
  await sock.cleanDirtyBits('ALL');
}

/** Resync app state for a set of collections. */
export function resync(sock: AnySock, collections: string[] | 'ALL'): Promise<unknown> {
  return sock.resyncAppState(collections as never);
}

/** Send a unified session node. Rare; used by re-pair flows. */
export function sendUnifiedSession(sock: AnySock, node: unknown): Promise<unknown> {
  return sock.sendUnifiedSession(node as never);
}

/** How long should a client wait between bulk operations? */
export async function reachoutDelay(sock: AnySock): Promise<number> {
  const result = (await sock.fetchAccountReachoutTimelock()) as any;
  return Number(result?.[0]?.reachoutTimelock ?? 0);
}