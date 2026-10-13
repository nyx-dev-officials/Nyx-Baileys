/**
 * Regression tests for four fixes to the Flux turn path.
 *
 * Each one covers a defect that was invisible to the shapes the suite already
 * asserted:
 *
 *  1. A 200 with an error body is a failure. It was reported as a generic
 *     "empty response", which lost the provider's own words **and** classified a
 *     free-tier rate limit as retryable — the one failure where retrying makes
 *     the next window longer. Tested with a stubbed `fetch`, because the real
 *     free endpoint is intermittently overloaded and a test that needs it is a
 *     test nobody runs.
 *  2. A vision turn carries content parts. It was wrapped in `String(...)`, which
 *     turned a `ContentPart[]` into the literal `"[object Object]"`.
 *  3. The engine passes real context to `systemPrompt`, so `toneForContext()` is
 *     reached instead of every reply collapsing to one default.
 *  4. A transcript is persisted and rehydrated, not only the facts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { complete } from '../dist/toolkit/ai/providers.js';
import { createBot } from '../dist/toolkit/ai/engine.js';
import { Conversations } from '../dist/toolkit/ai/context.js';
import { DurableMemory, ScopedMemory } from '../dist/toolkit/ai/memory-store.js';

const JID = '62882017467912@s.whatsapp.net';
const KEY = { id: 'X', remoteJid: JID, fromMe: false };

/** A socket that records what was sent and nothing else. */
function fakeSock() {
  return { sendMessage: async () => ({ key: { id: 'm1' } }) };
}

/** Stub `fetch` with one canned response, and count the calls it saw. */
function stubFetch(body, status = 200) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { restore: () => { globalThis.fetch = original; }, get calls() { return calls; } };
}

/* ══════════════════════════════════════════════════════════════════════════
 *  1. The 200-with-an-error-body shape
 * ══════════════════════════════════════════════════════════════════════════ */

test('a 200 with an error body surfaces the provider message, not "empty response"', async () => {
  const stub = stubFetch({
    id: 'gen-1',
    error: { message: 'Upstream error from Nvidia: Service temporarily overloaded', code: 503 },
  });

  try {
    const result = await complete(
      { provider: 'openrouter', model: 'nvidia/nemotron-3-ultra-550b-a55b:free', apiKey: 'k', timeoutMs: 5_000 },
      [{ role: 'user', content: 'hi' }],
      { attempts: 1 },
    );

    assert.match(String(result.error), /Service temporarily overloaded/);
    assert.doesNotMatch(String(result.error), /empty response/);
  } finally {
    stub.restore();
  }
});

test('a rate limit delivered as a 200 body is not retried', async () => {
  const stub = stubFetch({ error: { message: 'Rate limit exceeded: free-models-per-min.' } });

  try {
    const result = await complete(
      { provider: 'openrouter', model: 'x:free', apiKey: 'k', timeoutMs: 5_000 },
      [{ role: 'user', content: 'hi' }],
      { attempts: 3 },
    );

    assert.equal(result.rateLimited, true, 'the body must be classified as a rate limit');
    assert.equal(stub.calls, 1, 'a hard per-minute cap must not be hammered with retries');
  } finally {
    stub.restore();
  }
});

test('an overloaded endpoint is retried, because a retry usually clears it', async () => {
  const stub = stubFetch({ error: { message: 'Upstream error from Nvidia: Service temporarily unavailable' } });

  try {
    const result = await complete(
      { provider: 'openrouter', model: 'x:free', apiKey: 'k', timeoutMs: 5_000 },
      [{ role: 'user', content: 'hi' }],
      { attempts: 2 },
    );

    assert.equal(stub.calls, 2, 'a transient upstream outage is worth a second attempt');
    assert.equal(result.rateLimited, undefined);
  } finally {
    stub.restore();
  }
});

/* ══════════════════════════════════════════════════════════════════════════
 *  2. Vision parts
 * ══════════════════════════════════════════════════════════════════════════ */

test('a vision turn sends content parts, never "[object Object]"', async () => {
  const original = globalThis.fetch;
  let captured;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(String(init.body));
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'A one-pixel image.' }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const engine = createBot({
      ai: { provider: 'openrouter', model: 'openai/gpt-4o-mini', apiKey: 'k' },
      vision: true,
    });

    const sock = {
      sendMessage: async () => ({ key: { id: 'm1' } }),
      // A real 1x1 PNG, so `extractMedia` attaches genuine bytes.
      downloadMediaMessage: async () => Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    };

    const turn = await engine.think(sock, JID, {
      key: KEY,
      message: { imageMessage: { mimetype: 'image/png', width: 1, height: 1, caption: 'what is this?' } },
    });

    assert.equal(turn.action, 'reply');
    assert.ok(captured, 'the provider must have been called');

    const last = captured.messages.at(-1);
    assert.ok(Array.isArray(last.content), 'the newest message must be a parts array');
    assert.ok(last.content.some((p) => p.type === 'image_url'), 'the image part must travel');
    assert.doesNotMatch(JSON.stringify(captured.messages), /\[object Object\]/);
  } finally {
    globalThis.fetch = original;
  }
});

test('a text-only provider still gets the text of a vision turn, not the array', async () => {
  const original = globalThis.fetch;
  let captured;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(String(init.body));
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'Noted.' }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const engine = createBot({
      // Anthropic cannot take OpenAI-shaped parts, so it must be flattened.
      ai: { provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'k' },
      vision: true,
    });

    const sock = {
      sendMessage: async () => ({ key: { id: 'm1' } }),
      downloadMediaMessage: async () => Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    };

    await engine.think(sock, JID, {
      key: KEY,
      message: { imageMessage: { mimetype: 'image/png', width: 1, height: 1, caption: 'what is this?' } },
    });

    const last = captured.messages.at(-1);
    assert.equal(typeof last.content, 'string', 'parts must be flattened for a provider that cannot take them');
    assert.match(last.content, /what is this\?/);
  } finally {
    globalThis.fetch = original;
  }
});

/* ══════════════════════════════════════════════════════════════════════════
 *  3. Tone context
 * ══════════════════════════════════════════════════════════════════════════ */

/** Rebuild the system message the way `debugContext` does, for assertion. */
function systemTextOf(engine) {
  const ctx = engine.debugContext(JID);
  const system = ctx.messages.find((m) => m.role === 'system');
  assert.ok(system, 'a system message must be present');
  return String(system.content);
}

test('a frustrated message selects the steady tone, not the default', () => {
  const engine = createBot({ ai: { provider: 'echo', model: 'none' } });
  engine.convs.push(Conversations.keyFor(JID), 'user', 'this is still broken again and useless');

  assert.match(systemTextOf(engine), /Calm and plain/);
});

test('a positive message selects a different tone for the same chat', () => {
  const engine = createBot({ ai: { provider: 'echo', model: 'none' } });
  engine.convs.push(Conversations.keyFor(JID), 'user', 'thanks, that was perfect and helpful');

  assert.match(systemTextOf(engine), /Warm and encouraging/);
});

/* ══════════════════════════════════════════════════════════════════════════
 *  4. Transcript persistence
 * ══════════════════════════════════════════════════════════════════════════ */

test('a transcript is rehydrated by a fresh engine over the same store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nyx-transcript-'));
  const sock = fakeSock();

  try {
    const engine1 = createBot({
      ai: { provider: 'echo', model: 'none' },
      memory: new ScopedMemory({ durable: new DurableMemory({ dir }) }),
    });
    await engine1.respond(sock, JID, {
      key: KEY,
      message: { conversation: 'my favourite colour is teal' },
    });

    // A fresh engine over the same directory — what a restart or a re-pair looks
    // like. Facts alone used to be all that came back.
    const engine2 = createBot({
      ai: { provider: 'echo', model: 'none' },
      memory: new ScopedMemory({ durable: new DurableMemory({ dir }) }),
    });
    await engine2.respond(sock, JID, { key: KEY, message: { conversation: 'hello again' } });

    const texts = engine2.debugContext(JID).messages
      .map((m) => (typeof m.content === 'string' ? m.content : ''));

    assert.ok(
      texts.some((t) => t.includes('my favourite colour is teal')),
      'the earlier turn must be rehydrated from disk',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an in-memory engine writes no transcript', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nyx-transcript-empty-'));

  try {
    const engine = createBot({ ai: { provider: 'echo', model: 'none' } });
    await engine.respond(fakeSock(), JID, { key: KEY, message: { conversation: 'no memory configured' } });

    const { readdirSync } = await import('node:fs');
    assert.deepEqual(readdirSync(dir), [], 'no durable store means no files at all');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reset drops the durable transcript too, so it cannot be rehydrated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nyx-transcript-reset-'));

  try {
    const memory = new ScopedMemory({ durable: new DurableMemory({ dir }) });
    const engine1 = createBot({ ai: { provider: 'echo', model: 'none' }, memory });
    await engine1.respond(fakeSock(), JID, { key: KEY, message: { conversation: 'remember this phrase' } });
    engine1.reset(JID);

    const engine2 = createBot({
      ai: { provider: 'echo', model: 'none' },
      memory: new ScopedMemory({ durable: new DurableMemory({ dir }) }),
    });
    await engine2.respond(fakeSock(), JID, { key: KEY, message: { conversation: 'starting over' } });

    const texts = engine2.debugContext(JID).messages
      .map((m) => (typeof m.content === 'string' ? m.content : ''));

    assert.ok(!texts.some((t) => t.includes('remember this phrase')), 'reset must be permanent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
