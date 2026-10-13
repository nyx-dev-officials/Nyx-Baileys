/**
 * self-clean — send, then remove the *sender's* copy only.
 *
 * ## What this does
 *
 * Sends a message to a recipient, then removes it from the sender's own chat
 * using rc14's `deleteForMe`, which is `chatModify`'s delete-for-me branch:
 *
 * ```ts
 * chatModify({ deleteForMe: { deleteMedia: false, key, timestamp } }, jid)
 * ```
 *
 * The recipient keeps their copy. This is deliberately **not** the revoke path:
 * `sendMessage(jid, { delete: key })` compiles to `protocolMessage` type REVOKE
 * (`Utils/messages.js:328-333`), which deletes for everyone. That is a
 * different feature and would destroy the recipient's message — so the two are
 * kept apart here rather than one flag being flipped.
 *
 * Use case: a bot that pushes a lot of content and the operator wants their own
 * chat tidy, without retracting anything anyone received.
 *
 * ## What this is not
 *
 * It is not a way to retract something someone already read. Once delivered, the
 * recipient has it; `deleteForMe` only clears the sender's view. Every send this
 * plugin makes is still visible to its recipient and still paced by the
 * anti-spam plugin, because this plugin sits after it in the chain and simply
 * calls the same `sendMessage`.
 *
 * ## Ordering
 *
 * `order: 90` — after `anti-spam` (80), so every message goes through the pacing
 * queue and the per-minute ceiling. A send that skips pacing is exactly how an
 * account gets rate-limited, and this plugin sends in bulk by design.
 */

import { invariant } from '../core/intercept.js';
import type { CoreSocket, Plugin, PluginContext } from '../utils/types.js';

/** Minimal message key shape rc14 needs for a delete. */
export interface MessageKeyLike {
  id: string;
  remoteJid?: string;
  fromMe?: boolean;
}

export interface SelfCleanOptions {
  /**
   * Delete media from disk too when clearing the sender's copy.
   * Defaults to false: `deleteMedia: true` reclaims the file, but if the
   * recipient still holds the message, they will be left with a dead reference.
   */
  deleteMedia?: boolean;
  /**
   * Do not self-clean when this returns true. Useful to keep an audit trail of
   * what the bot actually sent — recommended while debugging.
   */
  keepWhen?: (content: unknown) => boolean;
  /** Injected for tests. */
  now?: () => number;
}

export interface SelfCleanResult {
  jid: string;
  key: MessageKeyLike;
  /** True when the sender's copy was removed. */
  cleaned: boolean;
  /** Populated when the cleanup failed; the send itself still succeeded. */
  cleanupError?: string;
}

/**
 * Send `content` to `jid`, then clear the sender's own copy.
 *
 * ## Why a cleanup failure is reported, not thrown
 *
 * The message is already delivered at that point. Throwing would tell the caller
 * the send failed when it did not, and a caller that catches-and-retries would
 * send it twice. So cleanup is best-effort: the result carries
 * `cleanupError` and `cleaned: false`, and the send stands.
 */
export async function sendAndClean(
  sock: CoreSocket,
  jid: string,
  content: Record<string, unknown>,
  options: SelfCleanOptions = {},
): Promise<SelfCleanResult> {
  invariant(sock && typeof sock.sendMessage === 'function', 'sock.sendMessage is required');

  const sent = await sock.sendMessage(jid, content as never) as {
    key?: MessageKeyLike;
  } | undefined;

  const key = sent?.key;
  if (!key?.id) {
    throw new Error('sendAndClean: sendMessage returned no message key, cannot self-clean');
  }

  if (options.keepWhen?.(content) === true) {
    return { jid, key, cleaned: false };
  }

  const timestamp = (options.now ?? Date.now)();

  try {
    await sock.chatModify({
      deleteForMe: {
        deleteMedia: options.deleteMedia ?? false,
        key: { ...key, remoteJid: jid, fromMe: true },
        timestamp,
      },
    } as never, jid);
    return { jid, key, cleaned: true };
  } catch (err) {
    return {
      jid,
      key,
      cleaned: false,
      cleanupError: err instanceof Error ? err.message : String(err),
    };
  }
}

export function selfClean(options: SelfCleanOptions = {}): Plugin {
  return {
    name: 'self-clean',
    order: 90,

    apply(ctx: PluginContext) {
      const log = ctx.log.child('self-clean');

      /**
       * Expose the helper on the socket so any sender in the chain can opt in
       * with one call, rather than each feature re-implementing the two-step
       * send-then-delete and getting the `deleteForMe` shape wrong.
       *
       * A distinct property, not an override of `sendMessage`: overwriting
       * `sendMessage` would change behaviour for every caller, including the
       * ones that must not self-clean.
       */
      const sock = ctx.sock as CoreSocket & {
        /** Socket-bound form: no `sock` argument, since the socket is `this`. */
        sendAndClean?: (
          target: string,
          content: Record<string, unknown>,
          opts?: SelfCleanOptions,
        ) => Promise<SelfCleanResult>;
      };

      if (sock.sendAndClean) {
        log.warn('sendAndClean already present — not overriding an existing implementation');
        return;
      }

      sock.sendAndClean = (target: string, content: Record<string, unknown>, opts?: SelfCleanOptions) =>
        sendAndClean(ctx.sock, target, content, opts);

      log.debug('sendAndClean available');
    },
  };
}