/**
 * SuperOptions that were type-checked, documented, and then discarded.
 *
 * `plugins()` called every factory with no arguments, so `antiSpam` and
 * `warmupDays` never reached the plugins that consume them. Both are declared in
 * `SuperOptions`, so the compiler was satisfied and the values vanished.
 *
 * Measured symptom on hardware: `{ antiSpam: { minGapMs: 300, maxGapMs: 700 } }`
 * still paced every send at roughly 20 seconds, because the plugin was running on
 * DEFAULTS (minGapMs 2.5s + jitterMs 4s). `{ warmupDays: 0 }` likewise left the
 * day-one ramp active. Both looked like "the option is broken"; neither was ever
 * plumbed through.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNyxBaileys } from '../dist/index.js';
import { rampFor } from '../dist/plugins/warmup.js';

import { applyPlugin, fakeSocket } from './helpers.js';

const dir = () => mkdtempSync(join(tmpdir(), 'nyx-opts-'));

/** Apply a plugin from the real default chain and hand back the fake socket. */
function applyFromChain(options) {
  const client = createNyxBaileys({ sessionDir: dir(), ...options });
  const plugin = client.plugins().find((p) => p.name === 'anti-spam');
  assert.ok(plugin, 'anti-spam must be present in the default chain');
  const sock = fakeSocket();
  applyPlugin(plugin, sock);
  return sock;
}

test('antiSpam options reach the plugin instead of being dropped', () => {
  const sock = applyFromChain({
    antiSpam: { minGapMs: 111, jitterMs: 222, maxPerMinute: 7, maxQueue: 33 },
  });

  assert.deepEqual(sock.__antispam.config(), {
    minGapMs: 111,
    jitterMs: 222,
    maxPerMinute: 7,
    maxQueue: 33,
    pressure: 1,
  });
});

test('unset antiSpam options fall back to the documented defaults', () => {
  const sock = applyFromChain({});
  const cfg = sock.__antispam.config();
  // 2.5s floor, requested pacing. `tests/send-cooldown.test.js` proves the
  // behaviour; this one only pins the number.
  assert.equal(cfg.minGapMs, 2500);
  assert.equal(cfg.jitterMs, 4000);
  assert.equal(cfg.maxPerMinute, 20);
});

test('a partial antiSpam override keeps the remaining defaults', () => {
  const sock = applyFromChain({ antiSpam: { minGapMs: 50 } });
  const cfg = sock.__antispam.config();
  assert.equal(cfg.minGapMs, 50, 'the override applies');
  assert.equal(cfg.jitterMs, 4000, 'and the rest still come from DEFAULTS');
});

test('warmupDays: 0 disables the ramp', () => {
  assert.equal(rampFor(Date.now(), 0), 1);
});

test('the default warmup still ramps a fresh session', () => {
  assert.ok(rampFor(Date.now(), 3) > 1, 'a fresh session is still paced up');
  assert.equal(rampFor(Date.now() - 10 * 86_400_000, 3), 1, 'and settles after the window');
});

test('the pacing a caller asks for is the pacing they get', async () => {
  // The behavioural version of the first test: with a tiny gap and no jitter,
  // two sends must not be spaced by the 2.5s default.
  const sock = applyFromChain({ antiSpam: { minGapMs: 1, jitterMs: 0, maxPerMinute: 60 } });

  const t0 = Date.now();
  await sock.sendMessage('a@s.whatsapp.net', { text: 'one' });
  await sock.sendMessage('a@s.whatsapp.net', { text: 'two' });
  const elapsed = Date.now() - t0;

  assert.ok(
    elapsed < 2000,
    `two sends at minGapMs=1 took ${elapsed}ms — the default 2.5s gap is still in effect`,
  );
});
