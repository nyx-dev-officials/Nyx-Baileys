/**
 * send-safety — the limits, and the two ways a limiter is silently useless.
 *
 * ## Why a limiter can look correct and protect nothing
 *
 * 1. **Check-then-send races.** If a caller checks and sends separately, two
 *    concurrent callers both pass the same check and both send. That is what
 *    `consume()` exists to make impossible.
 * 2. **Pruning that never prunes.** A window that does not actually expire is a
 *    counter, not a limiter. These use an injected clock so expiry is provable
 *    rather than assumed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SendSafety } from '../dist/plugins/send-safety.js';

/** Controllable clock. */
function clock(start = 1_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms) { t += ms; },
  };
}

test('permits sends below every limit', () => {
  const c = clock();
  const s = new SendSafety({ now: c.now });
  assert.deepEqual(s.check('a@s.whatsapp.net'), { allowed: true });
});

test('per-recipient burst ceiling blocks with a retry hint', () => {
  const c = clock();
  const s = new SendSafety({ now: c.now, recipientBurst: { limit: 3, windowMs: 60_000 } });

  for (let i = 0; i < 3; i++) assert.equal(s.consume('a').allowed, true, `send ${i} should pass`);
  const denied = s.check('a');
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'recipient-burst');
  assert.ok(denied.retryAfterMs > 0, 'a denial must say when to retry');
});

test('the burst ceiling is per recipient, not global', () => {
  const c = clock();
  const s = new SendSafety({ now: c.now, recipientBurst: { limit: 2, windowMs: 60_000 } });
  s.consume('a'); s.consume('a');
  assert.equal(s.check('a').allowed, false);
  assert.equal(s.check('b').allowed, true, 'a full window on one chat must not block another');
});

test('the burst window actually expires', () => {
  const c = clock();
  const s = new SendSafety({ now: c.now, recipientBurst: { limit: 2, windowMs: 60_000 } });
  s.consume('a'); s.consume('a');
  assert.equal(s.check('a').allowed, false);

  c.advance(60_001);
  assert.equal(s.check('a').allowed, true,
    'window did not expire — this is a counter, not a limiter');
});

test('per-recipient daily ceiling', () => {
  const c = clock();
  const s = new SendSafety({
    now: c.now,
    recipientBurst: { limit: 100, windowMs: 60_000 },
    recipientDaily: 3,
  });
  for (let i = 0; i < 3; i++) s.consume('a');
  const denied = s.check('a');
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'recipient-daily');

  c.advance(86_400_001);
  assert.equal(s.check('a').allowed, true, 'the daily window must roll over');
});

test('the global daily budget caps across every recipient', () => {
  const c = clock();
  const s = new SendSafety({
    now: c.now,
    recipientBurst: { limit: 100, windowMs: 60_000 },
    recipientDaily: 100,
    globalDaily: 5,
  });
  // Spread across five chats — no single chat hits its own ceiling.
  for (const r of ['a', 'b', 'c', 'd', 'e']) s.consume(r);
  assert.equal(s.check('a').allowed, false, 'the account budget must bind even when no chat does');
  assert.equal(s.check('z').allowed, false);
});

test('consume() cannot be raced past', () => {
  // The whole point: check() alone would let both callers through.
  const c = clock();
  const s = new SendSafety({ now: c.now, recipientBurst: { limit: 1, windowMs: 60_000 } });
  const first = s.consume('a');
  const second = s.consume('a');
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false, 'two consumes raced past a limit of 1');
});

test('the circuit breaker opens on consecutive delivery failures', () => {
  const c = clock();
  const s = new SendSafety({ now: c.now, breakerThreshold: 3, breakerCooldownMs: 600_000 });

  s.recordDelivery({ delivered: false });
  s.recordDelivery({ delivered: false });
  assert.equal(s.check('a').allowed, true, 'two failures should not trip a threshold of 3');

  s.recordDelivery({ delivered: false });
  const denied = s.check('a');
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'breaker-open');
});

test('an unknown delivery result does not trip the breaker', () => {
  // `null` means unobserved, which is not evidence of failure. A send that
  // returns an ID proves nothing on this account, so treating it as success
  // would mask a real outage.
  const c = clock();
  const s = new SendSafety({ now: c.now, breakerThreshold: 3 });
  for (let i = 0; i < 10; i++) s.recordDelivery({ delivered: null });
  assert.equal(s.check('a').allowed, true);
});

test('a success resets the failure run', () => {
  const c = clock();
  const s = new SendSafety({ now: c.now, breakerThreshold: 3, breakerCooldownMs: 600_000 });
  s.recordDelivery({ delivered: false });
  s.recordDelivery({ delivered: false });
  s.recordDelivery({ delivered: true });
  s.recordDelivery({ delivered: false });
  s.recordDelivery({ delivered: false });
  assert.equal(s.check('a').allowed, true, 'the run should have restarted after the success');
});

test('the breaker closes after cooldown and lets traffic resume', () => {
  const c = clock();
  const s = new SendSafety({ now: c.now, breakerThreshold: 2, breakerCooldownMs: 600_000 });
  s.recordDelivery({ delivered: false });
  s.recordDelivery({ delivered: false });
  assert.equal(s.check('a').allowed, false);

  c.advance(600_001);
  assert.equal(s.check('a').allowed, true, 'breaker never reopened — sends would stay blocked forever');
});

test('quiet hours block, and only inside the window', () => {
  // Uses a real hour-of-day so the wrap-midnight case is testable.
  const s = new SendSafety({ quietHours: { start: 22, end: 6 } });

  const at = (hour) => {
    const d = new Date();
    d.setHours(hour, 0, 0, 0);
    return new SendSafety({ quietHours: { start: 22, end: 6 }, now: () => d.getTime() });
  };

  assert.equal(at(23).check('a').reason, 'quiet-hours');
  assert.equal(at(3).check('a').reason, 'quiet-hours', 'must wrap across midnight');
  assert.equal(at(12).check('a').allowed, true);
  assert.equal(at(6).check('a').allowed, true, 'the end hour is exclusive');
});


test('a denied check consumes nothing', () => {
  const c = clock();
  const s = new SendSafety({ now: c.now, recipientBurst: { limit: 1, windowMs: 60_000 } });
  s.consume('a');
  const before = s.stats().daily;
  s.check('a');            // denied
  s.consume('a');         // denied
  assert.equal(s.stats().daily, before, 'a denied attempt was counted as a send');
});

test('reset() clears every counter', () => {
  const c = clock();
  const s = new SendSafety({ now: c.now, recipientBurst: { limit: 1, windowMs: 60_000 } });
  s.consume('a');
  s.recordDelivery({ delivered: false });
  s.recordDelivery({ delivered: false });
  s.reset();
  assert.equal(s.check('a').allowed, true);
});