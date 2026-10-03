/**
 * Message retry reasons.
 *
 * When a message fails to decrypt on the receiving side, WhatsApp asks the
 * sender to retry with a reason code. The code says *why*, and the why decides
 * whether a resend helps or makes it worse: a bad MAC is an encryption-session
 * mismatch that a fresh session fixes, while an expired message is simply too
 * old and resending it will not work.
 *
 * Codes follow the Signal protocol error set with WhatsApp's extensions. Adapted
 * from the reference forks.
 */

/** Signal + WhatsApp retry reason codes. */
export enum MessageRetryReason {
  UnknownError = 0,
  GenericError = 1,
  SignalErrorInvalidKeyId = 3,
  SignalErrorInvalidMessage = 4,
  SignalErrorNoSession = 5,
  SignalErrorBadMac = 7,
  MessageExpired = 8,
  DecryptionError = 9,
}

/** Reasons caused by a broken encryption session rather than a bad payload. */
export const MAC_ERROR_CODES: ReadonlySet<MessageRetryReason> = new Set([
  MessageRetryReason.SignalErrorBadMac,
  MessageRetryReason.SignalErrorInvalidMessage,
  MessageRetryReason.SignalErrorNoSession,
  MessageRetryReason.SignalErrorInvalidKeyId,
]);

const VALID = new Set<number>(Object.values(MessageRetryReason).filter((v): v is number => typeof v === 'number'));

/** Parse a retry reason from a string or number, defaulting to UnknownError. */
export function parseRetryReason(code: string | number | null | undefined): MessageRetryReason {
  if (code === null || code === undefined) return MessageRetryReason.UnknownError;
  const n = typeof code === 'string' ? Number.parseInt(code, 10) : code;
  if (!Number.isFinite(n) || !VALID.has(n)) return MessageRetryReason.UnknownError;
  return n as MessageRetryReason;
}

/** True when the reason points at an encryption-session mismatch. */
export function isMacError(reason: MessageRetryReason): boolean {
  return MAC_ERROR_CODES.has(reason);
}

/**
 * Whether a resend has a chance. `MessageExpired` never does — the message is
 * past the retention window and re-sending it only wastes the request budget.
 */
export function isRetryable(reason: MessageRetryReason): boolean {
  return reason !== MessageRetryReason.MessageExpired;
}

/** Human-readable description of a retry reason. */
export function describeRetryReason(reason: MessageRetryReason): string {
  switch (reason) {
    case MessageRetryReason.GenericError:
      return 'Generic error';
    case MessageRetryReason.SignalErrorInvalidKeyId:
      return 'Invalid key ID — peer prekey rotated';
    case MessageRetryReason.SignalErrorInvalidMessage:
      return 'Invalid message format';
    case MessageRetryReason.SignalErrorNoSession:
      return 'No session — peer not initialized';
    case MessageRetryReason.SignalErrorBadMac:
      return 'Bad MAC — encryption session mismatch';
    case MessageRetryReason.MessageExpired:
      return 'Message expired — too old to decrypt';
    case MessageRetryReason.DecryptionError:
      return 'Decryption failed';
    case MessageRetryReason.UnknownError:
    default:
      return 'Unknown error';
  }
}
