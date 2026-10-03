import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { DisconnectReason } from '@whiskeysockets/baileys';

import type { CoreSocket, Logger } from '../utils/types.js';

/**
 * Clean re-pair.
 *
 * ## What this replaces
 *
 * The earlier proposal — rotate `SignedPreKey`/`OneTimePreKey` in place and
 * trigger a "fresh handshake" via a `keyExchange` node — was wrong twice over:
 *
 *   1. **There is no `keyExchange` node.** Zero occurrences in `lib/`. Signal
 *      pre-key bundles travel *inside* the encrypted message, so there is
 *      nothing to send standalone.
 *   2. **Pre-keys are the ratchet identity, not separate from it.** Rotating
 *      them invalidates every established session and forces re-establishment.
 *      You cannot change the identity and preserve continuity.
 *
 * This approach is correct because it sidesteps both problems: a logout plus a
 * fresh pairing starts from **no prior session**, so there is no ratchet to
 * preserve and nothing to break. The server issues a new device identity.
 *
 * ## On `relayReceipt`
 *
 * That was also removed — it does not exist in rc14, and relaying receipts is
 * about multi-device receipt propagation, never re-linking. A device is
 * re-linked only by scanning a fresh QR.
 *
 * ## What re-pairing does and does not reset
 *
 * It creates a **new device identity** — new device keys, a new device row,
 * old sessions for this device torn down. It does **not** make the account
 * untrackable: the phone number and the account are the durable identifiers,
 * and device identity is one signal among several. Treat this as rotating a
 * device credential, not as anonymity.
 *
 * The correct order matters. `logout()` must complete before the files are
 * removed, because it is what tells the server to tear the device down. If the
 * socket is dead already the server will expire the device on its own, and the
 * local wipe is all that remains — which is why that path is handled explicitly
 * rather than assumed.
 */

export interface RePairOptions {
  /** Directory holding `creds.json` and `app-state-sync-key-*`. */
  sessionDir: string;
  log?: Logger;
  /** Skip `logout()` and wipe locally. Use when the socket is already dead. */
  force?: boolean;
  /** Message shown to linked devices before unlinking. */
  notice?: string;
  /** Timeout for the server round-trip, in ms. Default 15s. */
  timeoutMs?: number;
}

export interface RePairResult {
  ok: boolean;
  /** Why it failed, when `ok` is false. */
  reason?: string;
  /** True when the device was told to unlink before the local wipe. */
  revokedRemotely: boolean;
  /** Files removed from the session directory. */
  filesRemoved: number;
}

/** True when a closed socket means "logged out", not "dropped". */
export const isLoggedOut = (code: number | undefined): boolean => code === DisconnectReason.loggedOut;

/**
 * Unlink this device and wipe its credentials.
 *
 * Does not recreate the socket — pairing needs a QR scan, which is a user
 * action. The caller creates a fresh `SuperBaileys` afterwards.
 */
export async function rePair(
  sock: CoreSocket,
  options: RePairOptions,
): Promise<RePairResult> {
  const log = options.log;
  const timeoutMs = options.timeoutMs ?? 15_000;

  let revokedRemotely = false;

  if (!options.force) {
    try {
      // `logout` sends the unlink node and then clears creds. If it rejects,
      // the server still expires the device on its own schedule.
      await Promise.race([
        sock.logout(options.notice ?? 'Session re-linked from another device'),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`logout timed out after ${timeoutMs}ms`)), timeoutMs).unref?.(),
        ),
      ]);
      revokedRemotely = true;
      log?.info('device unlinked');
    } catch (err) {
      log?.warn('logout did not complete; relying on server-side expiry', {
        err: (err as Error).message,
      });
    }
  }

  // Close before deleting, so nothing rewrites creds after the wipe.
  try {
    sock.end?.(undefined);
  } catch {
    /* already down */
  }

  let filesRemoved = 0;
  try {
    const entries = await readdir(options.sessionDir);
    for (const entry of entries) {
      // Only remove state this framework owns. A stray file in a shared
      // directory is not ours to destroy.
      if (entry === 'creds.json' || entry.startsWith('app-state-sync-key')) {
        await rm(join(options.sessionDir, entry), { force: true, recursive: true });
        filesRemoved += 1;
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      return { ok: false, reason: `session wipe failed: ${(err as Error).message}`, revokedRemotely, filesRemoved };
    }
  }

  log?.info('session cleared', { filesRemoved });
  return { ok: true, revokedRemotely, filesRemoved };
}

/**
 * Re-pair with full teardown: unlink, wipe, and rebuild the client so a fresh
 * QR is printed.
 */
export async function rePairAndReconnect<T extends { dispose(): Promise<void> }>(
  client: T,
  factory: () => T,
  options: RePairOptions,
): Promise<{ ok: boolean; reason?: string; client: T }> {
  const result = await rePair(client as unknown as CoreSocket, options);
  if (!result.ok) return { ...result, client };

  await client.dispose().catch(() => undefined);
  const fresh = factory();
  return { ok: true, client: fresh };
}
