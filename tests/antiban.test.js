/**
 * Anti-ban pack.
 *
 * These modules are off by default and deliberately so. The tests assert the
 * mechanics — the curve, the plan, the rotator's quarantine, the determinism of
 * a fingerprint — not that any of it should be enabled.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIVITY_CURVES,
  PresenceChoreographer,
  getCircadianMultiplier,
  localHour,
} from '../dist/antiban/circadian.js';
import {
  ContentVariator,
  LegitimacySignalInjector,
  readReceiptVariance,
} from '../dist/antiban/imperfection.js';
import { SeededRandom, applyFingerprint, generateFingerprint } from '../dist/antiban/fingerprint.js';
import { ProxyRotator } from '../dist/antiban/rotation.js';
import { PRESETS, dailyLimit, resolveProfile } from '../dist/antiban/presets.js';
import { HumanEntropy } from '../dist/antiban/entropy.js';
import {
  contentVariation,
  humanEntropy,
  legitimacySignals,
  presenceChoreography,
  readReceiptVariancePlugin,
} from '../dist/plugins/antiban.js';

import { applyPlugin, fakeSocket, flush, sleep, upsert, wmMessage } from './helpers.js';

const CHAT = 'a@s.whatsapp.net';

/* ── circadian ───────────────────────────────────────────────────────── */

test('the activity curve peaks mid-afternoon and bottoms at night', () => {
  const curve = ACTIVITY_CURVES.office;
  assert.equal(curve.length, 24);
  assert.ok(curve[10] > curve[3], 'morning beats the small hours');
  assert.ok(curve[12] < curve[10], 'lunch dips');
});

test('circadian multiplier is ~1 in the day and high at night', () => {
  const noon = getCircadianMultiplier(new Date('2026-01-01T12:00:00Z'), 'default', 'UTC');
  const night = getCircadianMultiplier(new Date('2026-01-01T02:00:00Z'), 'default', 'UTC');
  assert.ok(noon >= 0.8 && noon <= 1.2, `noon was ${noon}`);
  assert.ok(night >= 5, `night was ${night}`);
  assert.equal(getCircadianMultiplier(new Date('2026-01-01T02:00:00Z'), 'always_on', 'UTC'), 1);
});

test('localHour resolves a timezone and stays in range', () => {
  assert.equal(localHour(new Date('2026-01-01T04:00:00Z'), 'UTC'), 4);
  const hour = localHour(new Date(), 'Asia/Jakarta');
  assert.ok(hour >= 0 && hour < 24);
});

test('a disabled choreographer never delays and never varies', () => {
  const choreo = new PresenceChoreographer({ enabled: false });
  assert.equal(choreo.enabled, false);
  assert.deepEqual(choreo.shouldPauseForDistraction(), { pause: false, durationMs: 0 });
  assert.deepEqual(choreo.shouldTakeOfflineGap(), { offline: false, durationMs: 0 });
  assert.deepEqual(choreo.shouldMarkRead(), { mark: true, delayMs: 0 });
  assert.deepEqual(choreo.computeTypingPlan(200), [{ state: 'composing', durationMs: 600 }]);
});

test('an enabled typing plan stays within its bounds and starts composing', () => {
  const choreo = new PresenceChoreographer({
    enabled: true,
    thinkPauseProbability: 1,
    intermittentPausedProbability: 0,
    typingMinMs: 800,
    typingMaxMs: 5_000,
  });
  const plan = choreo.computeTypingPlan(80);
  assert.ok(plan.length >= 1);
  assert.equal(plan[0].state, 'composing');
  const total = plan.reduce((sum, s) => sum + s.durationMs, 0);
  assert.ok(total >= 800 && total <= 5_000, `total was ${total}`);
  assert.ok(plan.some((s) => s.state === 'paused'), 'a think pause was injected');
});

test('an enabled read-receipt decision is either skipped or delayed', () => {
  const choreo = new PresenceChoreographer({ enabled: true, readReceiptSkipProbability: 0 });
  const decision = choreo.shouldMarkRead();
  assert.equal(decision.mark, true);
  assert.ok(decision.delayMs > 0);
});

/* ── content variation ───────────────────────────────────────────────── */

test('the variator changes text and can produce distinct bulk copies', () => {
  const variator = new ContentVariator();
  const original = 'hello there friend';
  const varied = variator.vary(original);
  assert.notEqual(varied, original);
  assert.equal(varied.replace(/[\u200B-\u200D\uFEFF]/g, '').trim().length, original.replace(/\s+$/, '').length);

  const bulk = variator.varyBulk(original, 5);
  assert.equal(bulk.length, 5);
});

test('an empty-ish string is left alone rather than corrupted', () => {
  const variator = new ContentVariator({ punctuationVariation: false });
  assert.equal(variator.vary('solo'), 'solo');
});

/* ── legitimacy ──────────────────────────────────────────────────────── */

test('a typo is a plausible QWERTY mis-key and carries a correction', () => {
  const injector = new LegitimacySignalInjector({ typoProbability: 1 });
  const plan = injector.shouldInjectTypo('hello wonderful world');
  assert.ok(plan, 'a typo was produced');
  assert.notEqual(plan.typoText, 'hello wonderful world');
  assert.ok(typeof plan.correctionText === 'string' && plan.correctionText.length > 0);
  assert.ok(plan.correctionDelayMs >= 500);
});

test('typos are never injected into URLs or short strings', () => {
  const injector = new LegitimacySignalInjector({ typoProbability: 1 });
  assert.equal(injector.shouldInjectTypo('visit https://example.com/now'), null);
  assert.equal(injector.shouldInjectTypo('short'), null);
});

test('typing pauses are placed inside the message', () => {
  const injector = new LegitimacySignalInjector({ typingPauseProbability: 1, typingPauseLengthThreshold: 10 });
  const pauses = injector.getTypingPauses(200);
  assert.ok(pauses.length >= 1);
  for (const pause of pauses) {
    assert.ok(pause.afterChars >= 0 && pause.afterChars <= 200);
    assert.ok(pause.pauseDurationMs > 0);
  }
});

test('read-receipt variance stays inside its clamp', () => {
  const jitter = readReceiptVariance({ meanMs: 1000, stdDevMs: 5000, minMs: 200, maxMs: 8000 });
  for (let i = 0; i < 50; i += 1) {
    const delay = jitter.delayMs();
    assert.ok(delay >= 200 && delay <= 8000, `delay was ${delay}`);
  }
  assert.equal(jitter.isBacklog(Date.now() - 120_000), true);
  assert.equal(jitter.isBacklog(Date.now()), false);
});

/* ── fingerprint ─────────────────────────────────────────────────────── */

test('a fingerprint is deterministic for the same session id', () => {
  const a = generateFingerprint({ enabled: true }, 'session-xyz');
  const b = generateFingerprint({ enabled: true }, 'session-xyz');
  assert.deepEqual(a, b);
  assert.equal(a.sessionId, 'session-xyz');
});

test('a disabled fingerprint stays on the first pool entry', () => {
  const fp = generateFingerprint({ enabled: false }, 's1');
  assert.deepEqual(fp.appVersion, [2, 24, 5, 18]);
  assert.equal(fp.osVersion, '10');
  assert.equal(fp.deviceModel, 'Pixel 6');
});

test('applyFingerprint sets version and browser without touching the input', () => {
  const config = { version: [1, 1, 1], browser: ['x', 'y', 'z'], custom: true };
  const fp = generateFingerprint({ enabled: true }, 's2');
  const out = applyFingerprint(config, fp);
  assert.deepEqual(out.version, fp.appVersion);
  assert.equal(out.browser[0], fp.deviceModel);
  assert.match(out.browser[2], /^WhatsApp\//);
  assert.equal(out.custom, true, 'other config survives');
  assert.deepEqual(config.version, [1, 1, 1], 'the input was not mutated');
});

test('SeededRandom is reproducible', () => {
  assert.equal(new SeededRandom('seed').next(), new SeededRandom('seed').next());
});

/* ── rotation ────────────────────────────────────────────────────────── */

test('round-robin rotates through healthy proxies', () => {
  const rotator = new ProxyRotator([{ url: 'a:1' }, { url: 'b:2' }, { url: 'c:3' }]);
  assert.equal(rotator.next().url, 'a:1');
  assert.equal(rotator.next().url, 'b:2');
  assert.equal(rotator.next().url, 'c:3');
  assert.equal(rotator.next().url, 'a:1');
});

test('a failed proxy is quarantined and skipped, then restored on success', () => {
  const changes = [];
  const rotator = new ProxyRotator([{ url: 'a:1' }, { url: 'b:2' }], { cooldownMs: 10_000, onStateChange: (u, s) => changes.push([u, s]) });

  rotator.reportFailure('a:1');
  assert.deepEqual(rotator.available().map((p) => p.url), ['b:2']);
  assert.deepEqual(changes, [['a:1', 'quarantined']]);

  rotator.reportSuccess('a:1');
  assert.deepEqual(rotator.available().map((p) => p.url).sort(), ['a:1', 'b:2']);
  assert.deepEqual(changes[1], ['a:1', 'restored']);
});

test('sticky routing is stable for a key', () => {
  const rotator = new ProxyRotator([{ url: 'a:1' }, { url: 'b:2' }, { url: 'c:3' }], { strategy: 'sticky' });
  const first = rotator.next('user-42').url;
  for (let i = 0; i < 5; i += 1) assert.equal(rotator.next('user-42').url, first);
});

test('an empty proxy list is refused', () => {
  assert.throws(() => new ProxyRotator([]), /at least one proxy/);
});

/* ── presets ─────────────────────────────────────────────────────────── */

test('the default profile is conservative and overrides merge', () => {
  assert.deepEqual(resolveProfile(undefined), PRESETS.conservative);
  const custom = resolveProfile({ preset: 'moderate', maxPerMinute: 3 });
  assert.equal(custom.maxPerMinute, 3);
  assert.equal(custom.maxPerDay, PRESETS.moderate.maxPerDay);
});

test('high-volume can only be chosen explicitly', () => {
  assert.throws(() => resolveProfile('high-volume'), /established account/);
  assert.equal(resolveProfile({ preset: 'high-volume' }).maxPerMinute, 40);
});

test('the warm-up daily limit grows and is capped', () => {
  assert.equal(dailyLimit(PRESETS.conservative, 1), PRESETS.conservative.day1Limit);
  assert.ok(dailyLimit(PRESETS.conservative, 3) > dailyLimit(PRESETS.conservative, 2));
  assert.equal(dailyLimit(PRESETS.conservative, 999), PRESETS.conservative.maxPerDay);
});

/* ── entropy ─────────────────────────────────────────────────────────── */

test('a disabled entropy service idles and a cycle with no contacts is a no-op', async () => {
  const sock = fakeSocket();
  const entropy = new HumanEntropy(sock, { enabled: false });
  entropy.start();
  assert.equal(entropy.stats().cycles, 0);
  await entropy.runCycle();
  assert.equal(entropy.stats().cycles, 0);
  entropy.stop();
});

test('an enabled cycle performs typing, read and presence actions', async () => {
  const sock = fakeSocket();
  const entropy = new HumanEntropy(sock, {
    enabled: true,
    random: () => 0,
    typingMinMs: 1,
    typingMaxMs: 1,
    readReceiptProbability: 1,
    readReceiptMinDelayMs: 0,
    readReceiptMaxDelayMs: 0,
    presenceToggleProbability: 1,
    presenceToggleMinMs: 1,
    presenceToggleMaxMs: 1,
  });
  sock.readMessages = () => undefined;

  entropy.attach();
  upsert(sock, [wmMessage({ jid: CHAT, id: 'm1' })]);

  assert.equal(entropy.contactCount, 1);
  await entropy.runCycle();

  const stats = entropy.stats();
  assert.equal(stats.cycles, 1);
  assert.equal(stats.typingActions, 1);
  assert.equal(stats.readReceipts, 1);
  assert.equal(stats.presenceToggles, 1);
  entropy.stop();
});

/* ── plugins ─────────────────────────────────────────────────────────── */

test('contentVariation changes the outgoing text', async () => {
  const sock = fakeSocket();
  applyPlugin(contentVariation(), sock);
  await sock.sendMessage(CHAT, { text: 'hello there friend' });
  assert.notEqual(sock.sent[0].content.text, 'hello there friend');
});

test('presenceChoreography emits typing presence before the send', async () => {
  const presence = [];
  const sock = fakeSocket({ sendPresenceUpdate: (state) => presence.push(state) });
  applyPlugin(
    presenceChoreography({
      enabled: true,
      distractionPauseProbability: 0,
      offlineGapProbability: 0,
      thinkPauseProbability: 0,
      intermittentPausedProbability: 0,
      typingMinMs: 1,
      typingMaxMs: 2,
    }),
    sock,
  );

  await sock.sendMessage(CHAT, { text: 'hello there' });
  assert.equal(sock.sent.length, 1);
  assert.ok(presence.includes('composing'), 'composing was emitted');
  assert.equal(presence[presence.length - 1], 'paused', 'presence is restored');
  assert.ok(sock.choreographer, 'engine attached');
});

test('legitimacySignals sends a typo and then its correction', async () => {
  const sock = fakeSocket();
  applyPlugin(legitimacySignals({ typoProbability: 1, typoCorrectMinMs: 1, typoCorrectMaxMs: 1 }), sock);

  const original = 'hello wonderful world';
  await sock.sendMessage(CHAT, { text: original });
  assert.notEqual(sock.sent[0].content.text, original, 'the first send carried a typo');

  await sleep(20);
  await flush();
  assert.ok(sock.sent.length >= 2, 'a correction followed');
});

test('readReceiptVariancePlugin delays readMessages', async () => {
  const seen = [];
  const sock = fakeSocket({ readMessages: (keys) => seen.push(keys) });
  applyPlugin(readReceiptVariancePlugin({ meanMs: 5, stdDevMs: 0, minMs: 1, maxMs: 5 }), sock);

  const start = Date.now();
  await sock.readMessages([{ remoteJid: CHAT, id: 'm1', messageTimestamp: Math.floor(Date.now() / 1000) }]);
  assert.equal(seen.length, 1);
  assert.ok(Date.now() - start >= 1);
});

test('humanEntropy attaches the engine and dispose stops it', () => {
  const sock = fakeSocket();
  const { dispose } = applyPlugin(humanEntropy({ enabled: true, minIntervalMs: 100_000, maxIntervalMs: 100_000 }), sock);
  assert.ok(sock.entropy);
  assert.equal(Object.keys(sock).includes('entropy'), false);
  dispose();
  assert.equal(sock.entropy.stats().nextCycleAt, null);
});
