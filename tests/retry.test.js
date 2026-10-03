/**
 * Retry reasons and the typed error taxonomy.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BurstCeilingError,
  InvalidSessionIdError,
  NotConnectedError,
  NyxError,
  PayloadTooLargeError,
  QueueFullError,
  SessionNotFoundError,
  isNyxError,
} from '../dist/core/errors.js';
import {
  MessageRetryReason,
  describeRetryReason,
  isMacError,
  isRetryable,
  parseRetryReason,
} from '../dist/core/retry.js';

/* ── retry reasons ───────────────────────────────────────────────────── */

test('parseRetryReason accepts numbers and numeric strings', () => {
  assert.equal(parseRetryReason(7), MessageRetryReason.SignalErrorBadMac);
  assert.equal(parseRetryReason('7'), MessageRetryReason.SignalErrorBadMac);
});

test('parseRetryReason maps unknown and malformed input to UnknownError', () => {
  assert.equal(parseRetryReason(undefined), MessageRetryReason.UnknownError);
  assert.equal(parseRetryReason(null), MessageRetryReason.UnknownError);
  assert.equal(parseRetryReason('nonsense'), MessageRetryReason.UnknownError);
  assert.equal(parseRetryReason(999), MessageRetryReason.UnknownError);
});

test('MAC errors are recognised', () => {
  assert.equal(isMacError(MessageRetryReason.SignalErrorBadMac), true);
  assert.equal(isMacError(MessageRetryReason.SignalErrorNoSession), true);
  assert.equal(isMacError(MessageRetryReason.MessageExpired), false);
  assert.equal(isMacError(MessageRetryReason.GenericError), false);
});

test('only an expired message is non-retryable', () => {
  assert.equal(isRetryable(MessageRetryReason.MessageExpired), false);
  assert.equal(isRetryable(MessageRetryReason.SignalErrorBadMac), true);
  assert.equal(isRetryable(MessageRetryReason.UnknownError), true);
});

test('every reason has a description', () => {
  for (const reason of Object.values(MessageRetryReason).filter((v) => typeof v === 'number')) {
    const text = describeRetryReason(reason);
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 0);
  }
  assert.match(describeRetryReason(MessageRetryReason.SignalErrorBadMac), /MAC/);
});

/* ── errors ──────────────────────────────────────────────────────────── */

test('typed errors carry a stable code and their own name', () => {
  const cases = [
    [new SessionNotFoundError('abc'), 'SESSION_NOT_FOUND', 'SessionNotFoundError'],
    [new NotConnectedError(), 'NOT_CONNECTED', 'NotConnectedError'],
    [new InvalidSessionIdError('!!'), 'INVALID_SESSION_ID', 'InvalidSessionIdError'],
    [new QueueFullError(500), 'QUEUE_FULL', 'QueueFullError'],
    [new BurstCeilingError(20), 'BURST_CEILING', 'BurstCeilingError'],
    [new PayloadTooLargeError(10, 5), 'PAYLOAD_TOO_LARGE', 'PayloadTooLargeError'],
  ];

  for (const [err, code, name] of cases) {
    assert.ok(err instanceof NyxError, `${name} extends NyxError`);
    assert.ok(err instanceof Error);
    assert.equal(err.code, code);
    assert.equal(err.name, name);
  }
});

test('carried fields survive on the error', () => {
  assert.equal(new QueueFullError(42).maxSize, 42);
  assert.equal(new BurstCeilingError(7).maxPerMinute, 7);
  const tooLarge = new PayloadTooLargeError(99, 10);
  assert.equal(tooLarge.bytes, 99);
  assert.equal(tooLarge.limit, 10);
});

test('isNyxError distinguishes framework errors from ordinary ones', () => {
  assert.equal(isNyxError(new QueueFullError(1)), true);
  assert.equal(isNyxError(new Error('plain')), false);
  assert.equal(isNyxError(null), false);
});
