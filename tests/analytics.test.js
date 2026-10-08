import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  messageSentimentAnalyzer,
  GroupActivityMonitor,
  ConnectionQualityProbe,
  RateLimitShield,
  sessionHealthAudit,
  mediaMetadataExtractor,
  richTextBeautifier,
  webhookDispatcher,
} from '../dist/toolkit/analytics.js';

test('18. Feature 18: messageSentimentAnalyzer evaluates text intent', () => {
  const pos = messageSentimentAnalyzer('This is great and awesome');
  assert.equal(pos.intent, 'positive');
  assert.ok(pos.score > 0);

  const neg = messageSentimentAnalyzer('Terrible bad error');
  assert.equal(neg.intent, 'negative');
  assert.ok(neg.score < 0);
});

test('19. Feature 19: GroupActivityMonitor records messages and top senders', () => {
  const monitor = new GroupActivityMonitor();
  monitor.recordMessage('g1', 'userA');
  monitor.recordMessage('g1', 'userA');
  monitor.recordMessage('g1', 'userB');

  const top = monitor.getTopSenders('g1');
  assert.equal(top[0].jid, 'userA');
  assert.equal(top[0].count, 2);
  assert.equal(top[1].jid, 'userB');
});

test('20. Feature 20: ConnectionQualityProbe records RTT and calculates jitter', () => {
  const probe = new ConnectionQualityProbe();
  probe.recordSample(100);
  probe.recordSample(120);
  probe.recordSample(110);

  const stats = probe.getStats();
  assert.equal(stats.avgRttMs, 110);
  assert.ok(stats.jitterMs > 0);
});

test('21. Feature 21: RateLimitShield adjusts backoff multiplier', () => {
  const shield = new RateLimitShield();
  assert.equal(shield.getMultiplier(), 1.0);

  shield.recordError();
  shield.recordError();
  shield.recordError();
  shield.recordError();

  assert.ok(shield.getMultiplier() > 1.0);

  shield.recordSuccess();
  shield.recordSuccess();
  shield.recordSuccess();
  shield.recordSuccess();

  assert.equal(shield.getMultiplier(), 1.0);
});

test('22. Feature 22: sessionHealthAudit returns missing creds error gracefully', () => {
  const res = sessionHealthAudit('./non_existent_directory_12345');
  assert.equal(res.valid, false);
  assert.equal(res.credsExist, false);
  assert.ok(res.error);
});

test('23. Feature 23: mediaMetadataExtractor extracts mime and size', () => {
  const buf = Buffer.from('hello world');
  const meta = mediaMetadataExtractor(buf, 'image/png');

  assert.equal(meta.estimatedSizeBytes, 11);
  assert.equal(meta.extension, 'png');
});

test('24. Feature 24: richTextBeautifier formats boxed header', () => {
  const boxed = richTextBeautifier('TITLE', 'content here');
  assert.ok(boxed.includes('╔'));
  assert.ok(boxed.includes('TITLE'));
  assert.ok(boxed.includes('╚'));
});

test('25. Feature 25: webhookDispatcher signs payload with HMAC SHA256 header', async () => {
  // Test signature calculation logic
  const secret = 'supersecret';
  const payload = { event: 'ping' };

  // Mock global fetch for unit test
  const originalFetch = globalThis.fetch;
  let sentHeaders = {};
  let sentBody = '';

  globalThis.fetch = async (url, init) => {
    sentHeaders = init?.headers ?? {};
    sentBody = init?.body ?? '';
    return { status: 200, ok: true };
  };

  try {
    const res = await webhookDispatcher('https://example.com/hook', secret, payload);
    assert.equal(res.status, 200);
    assert.equal(res.ok, true);
    assert.ok(sentHeaders['X-Nyx-Signature']);
    assert.ok(sentHeaders['X-Nyx-Signature'].startsWith('sha256='));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
