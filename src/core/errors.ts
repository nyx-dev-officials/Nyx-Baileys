/**
 * Typed errors.
 *
 * A caller distinguishing "session gone" from "queue full" from "not connected"
 * should not have to match on a message string. Each error carries a stable
 * `code` so retry logic can branch on identity rather than prose. Adapted from
 * the reference forks' error taxonomies.
 */

/** Base for every error this framework raises deliberately. */
export class NyxError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** The requested session is not registered. */
export class SessionNotFoundError extends NyxError {
  constructor(sessionId: string) {
    super(`session ${sessionId} not found`, 'SESSION_NOT_FOUND');
  }
}

/** An operation needs a live socket and there is none. */
export class NotConnectedError extends NyxError {
  constructor(message = 'not connected') {
    super(message, 'NOT_CONNECTED');
  }
}

/** A session id is malformed (must be alphanumeric, hyphen or underscore). */
export class InvalidSessionIdError extends NyxError {
  constructor(sessionId: string) {
    super(
      `invalid session id: ${sessionId} (expected [A-Za-z0-9_-]+)`,
      'INVALID_SESSION_ID',
    );
  }
}

/** The anti-spam queue is at its ceiling, so the send was rejected outright. */
export class QueueFullError extends NyxError {
  constructor(readonly maxSize: number) {
    super(`anti-spam: queue full (${maxSize})`, 'QUEUE_FULL');
  }
}

/** The per-minute burst ceiling was reached. */
export class BurstCeilingError extends NyxError {
  constructor(readonly maxPerMinute: number) {
    super(
      `anti-spam: burst ceiling ${maxPerMinute}/min reached; queueing is the right call here`,
      'BURST_CEILING',
    );
  }
}

/** A media asset exceeded the configured ceiling. */
export class PayloadTooLargeError extends NyxError {
  constructor(
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(`payload ${bytes} bytes exceeds limit ${limit}`, 'PAYLOAD_TOO_LARGE');
  }
}

/** Type guard for errors raised by this framework. */
export function isNyxError(err: unknown): err is NyxError {
  return err instanceof NyxError;
}
