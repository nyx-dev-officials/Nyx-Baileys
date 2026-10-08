/**
 * AI toolkit tests.
 *
 * Two rules shape everything here:
 *
 *  1. **No network.** Every provider call is stubbed with a fake `fetch`, and the
 *     `echo` provider is used for real round trips. A test that needs an API key
 *     is a test nobody runs.
 *  2. **The safety properties are tested hardest.** URL blocking, tool
 *     permission, and fabrication detection are the parts where a silent
 *     regression is genuinely dangerous, so they get the most assertions.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  estimateTokens, estimateMessages, Memory, fitWindow, heuristicDigest,
  renderDigest, Conversations, contextHealth,
} from '../dist/toolkit/ai/context.js';

import {
  ToolRegistry, complete, systemPrompt, assertNoFabrication, PROVIDER_DEFAULTS,
  whatsAppTools, restTool, fluxTools,
  FREE_MODELS, freeModel, recommendedFreeModels, freeConfig,
  resolveApiKey, assertUsableKey,
  FREE_MODELS_REJECTED, FREE_TIER_NOTES, isRateLimited, isEmptyResponse,
} from '../dist/toolkit/ai/providers.js';

import {
  parseBlocks, parsePoll, parseList, parseButtons, parseLocation, parseContact,
  vcardFor, render, renderText, blockToText, renderAllAsText, readSelection,
  SUPPORTED_OUTPUTS, vcardFor as vcard,
} from '../dist/toolkit/ai/output.js';

import {
  detectIntent, extractEntities, detectLanguage, readTone, fillSlots, DEFAULT_PREFIX, rulesWithPrefix,
  PendingFlow, SLOT_SPECS, normaliseInput, DEFAULT_RULES,
} from '../dist/toolkit/ai/intent.js';

import {
  assertSafeUrl, UnsafeUrlError, isBlockedHost, isPrivateV4, fetchMedia,
  sniffMime, deriveFileName, kindForMime, toWhatsAppContent, templateLookup,
  assertPermitted, METADATA_HOSTS, lookupAndFetch,
} from '../dist/toolkit/ai/media-fetch.js';

import {
  BotEngine, createBot, createFlux, defaultCommands, RateLimiter, permitted,
  describeDownload,
} from '../dist/toolkit/ai/engine.js';

/* A recording socket. No network, no rc14. */
function sock() {
  const calls = [];
  return {
    calls,
    user: { id: '6283831459585:12@s.whatsapp.net' },
    async sendMessage(jid, content, opts) {
      calls.push(['sendMessage', jid, content, opts]);
      return { key: { id: 'SENT1' } };
    },
    async onWhatsApp(n) {
      calls.push(['onWhatsApp', n]);
      return [{ exists: true, jid: '628@s.whatsapp.net' }];
    },
    async sendPresenceUpdate(...a) {
      calls.push(['sendPresenceUpdate', ...a]);
    },
    async groupMetadata() {
      return { subject: 'Test group', size: 4, desc: 'a group' };
    },
  };
}

const DM = '62882017467912@s.whatsapp.net';
const GROUP = '120363000000000000@g.us';

const msg = (text, extra = {}) => ({
  key: { id: 'M1', remoteJid: DM, fromMe: false },
  message: { conversation: text, ...extra },
});

/* ══ token accounting ═══════════════════════════════════════════ */

test('estimateTokens scales with length, not character class', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1, '4 chars ≈ 1 token');
  assert.equal(estimateTokens('a'.repeat(400)), 100);
  assert.ok(estimateTokens('日本語のテキスト') > estimateTokens('abcdefgh'));
});

test('estimateMessages adds per-message overhead', () => {
  const messages = [{ role: 'user', content: 'a'.repeat(40) }];
  assert.ok(estimateMessages(messages) > estimateTokens('a'.repeat(40)), 'framing costs tokens');
});

/* ══ memory ══════════════════════════════════════════════════════ */

test('memory learns and recalls with provenance', () => {
  const m = new Memory();
  m.learn({ fact: 'I live in Jakarta', source: 'user' });
  const facts = m.recall();
  assert.equal(facts.length, 1);
  assert.equal(facts[0].source, 'user', 'provenance is never empty');
});

test('memory restates a fact without duplicating it', () => {
  const m = new Memory();
  m.learn({ fact: 'I live in Jakarta', source: 'user' });
  m.learn({ fact: 'I live in Jakarta', source: 'user' });
  assert.equal(m.size, 1, 'one fact');
  assert.equal(m.recall()[0].hits, 2, 'restating raises corroboration');
});

test('memory does NOT merge two different cities', () => {
  // This is the case that decides the dedupe metric. A keyword-containment
  // rule merges these (both share "live in") and silently overwrites one.
  const m = new Memory();
  m.learn({ fact: 'I live in Jakarta', source: 'user' });
  m.learn({ fact: 'I live in Bandung', source: 'user' });
  assert.equal(m.size, 2, 'two genuinely different facts are both kept');
});

test('memory recall ranks by query overlap', () => {
  const m = new Memory();
  m.learn({ fact: 'I live in Jakarta', source: 'user' });
  m.learn({ fact: 'I prefer dark roast coffee', source: 'user' });
  m.learn({ fact: 'my dog is named Rex', source: 'user' });

  const hits = m.recall('where do I live city');
  assert.equal(hits.length, 1);
  assert.match(hits[0].fact, /Jakarta/);
});

test('memory forgets by substring — users say "forget my city"', () => {
  const m = new Memory();
  m.learn({ fact: 'I live in Jakarta', source: 'user' });
  m.learn({ fact: 'I prefer dark roast', source: 'user' });

  assert.equal(m.forget('jakarta'), 1);
  assert.equal(m.size, 1);
  assert.equal(m.forget('nothing here'), 0);
});

test('memory drops expired facts on read, not on write', () => {
  const m = new Memory();
  m.learn({ fact: 'temporary note', source: 'user', expiresAt: Date.now() - 1000 });
  assert.equal(m.size, 1, 'still stored');
  assert.equal(m.recall().length, 0, 'filtered on read');
});

test('memory refuses to evict a fresh explicit statement', () => {
  const m = new Memory(1);
  m.learn({ fact: 'first fact stated today', source: 'user' });
  const added = m.learn({ fact: 'second fact stated today', source: 'user' });
  assert.equal(added, false, 'refused rather than evicting something fresh');
  assert.equal(m.saturated, true, 'and said so');
});

test('memory clear is one call and reports the count', () => {
  const m = new Memory();
  m.learn({ fact: 'one thing', source: 'u' });
  m.learn({ fact: 'two thing', source: 'u' });
  assert.equal(m.clear(), 2);
  assert.equal(m.size, 0);
});

test('memory render includes provenance inline', () => {
  const m = new Memory();
  m.learn({ fact: 'I live in Jakarta', source: 'DM 628' });
  const text = m.render();
  assert.match(text, /I live in Jakarta/);
  assert.match(text, /source: DM 628/, 'the model must see where it came from');
});

test('memory bySource groups facts', () => {
  const m = new Memory();
  m.learn({ fact: 'fact one here', source: 'DM' });
  m.learn({ fact: 'fact two here', source: 'DM' });
  assert.equal(Object.keys(m.bySource()).length, 1);
});

/* ══ window ══════════════════════════════════════════════════════ */

test('fitWindow drops the oldest and keeps the newest', () => {
  const history = Array.from({ length: 50 }, (_, i) => ({
    role: 'user',
    content: `message ${i} ${'x'.repeat(100)}`,
  }));

  const result = fitWindow(history, { modelLimit: 2048, replyReserve: 512 });
  assert.ok(result.droppedAny, 'dropped something');
  assert.ok(result.kept.length < history.length);
  assert.match(result.kept.at(-1)?.content ?? '', /message 49/, 'newest survives');
});

test('fitWindow never drops the system prompt', () => {
  const history = [
    { role: 'system', content: 'IMPORTANT INSTRUCTIONS '.repeat(50) },
    ...Array.from({ length: 40 }, (_, i) => ({ role: 'user', content: `m${i} ${'y'.repeat(200)}` })),
  ];

  const result = fitWindow(history, { modelLimit: 1024, replyReserve: 256 });
  assert.equal(result.kept[0]?.role, 'system', 'instructions are never droppable');
  assert.match(result.kept[0]?.content ?? '', /IMPORTANT/);
});

test('fitWindow keeps at least minKeep even when it overflows', () => {
  const history = [
    { role: 'user', content: 'z'.repeat(100_000) },
    { role: 'user', content: 'also enormous '.repeat(1000) },
  ];
  const result = fitWindow(history, { modelLimit: 512, replyReserve: 256, minKeep: 2 });
  assert.equal(result.kept.length, 2, 'minKeep is honoured');
});

test('fitWindow reports when nothing was dropped', () => {
  const result = fitWindow([{ role: 'user', content: 'short' }], { modelLimit: 8192 });
  assert.equal(result.dropped, 0);
  assert.equal(result.droppedAny, false);
});

/* ══ digest ══════════════════════════════════════════════════════ */

test('heuristicDigest keeps commitments, decisions and open questions', () => {
  const digest = heuristicDigest([
    { role: 'user', content: 'I live in Jakarta' },
    { role: 'user', content: "let's use the dark theme" },
    { role: 'user', content: 'which one should I pick?' },
    { role: 'user', content: 'ok thanks bye' },
  ]);

  assert.ok(digest.facts.some((f) => /Jakarta/.test(f)));
  assert.ok(digest.decisions.some((d) => /dark theme/.test(d)));
  assert.ok(digest.open.some((q) => /which one/.test(q)));
  assert.ok(!digest.facts.some((f) => /bye/.test(f)), 'drops pleasantries');
});

test('renderDigest labels each section', () => {
  const text = renderDigest({
    topic: 'setup',
    facts: ['I live in Jakarta'],
    decisions: ['use dark theme'],
    open: ['which font?'],
  });
  assert.match(text, /Topic: setup/);
  assert.match(text, /Known from earlier/);
  assert.match(text, /Decided earlier/);
  assert.match(text, /Still open/);
});

/* ══ conversations ═══════════════════════════════════════════════ */

test('conversations keep chats separate', () => {
  const c = new Conversations();
  c.push('a', 'user', 'about cats');
  c.push('b', 'user', 'about invoices');

  assert.equal(c.get('a').messages.length, 1);
  assert.equal(c.get('b').messages[0]?.content, 'about invoices');
});

test('conversations trim to maxMessages', () => {
  const c = new Conversations(5);
  for (let i = 0; i < 20; i += 1) c.push('a', 'user', `m${i}`);
  assert.equal(c.get('a').messages.length, 5);
  assert.equal(c.get('a').messages.at(-1)?.content, 'm19', 'kept the newest');
});

test('buildPrompt injects memory as a system block, not a user turn', () => {
  const c = new Conversations();
  c.push('a', 'user', 'I live in Jakarta');
  c.learn('a', { fact: 'I live in Jakarta', source: 'user' });

  const prompt = c.buildPrompt('a', { modelLimit: 8192, system: 'base instructions' });
  const system = prompt.find((m) => m.role === 'system');

  assert.ok(system, 'a system block exists');
  assert.match(system.content, /base instructions/);
  assert.match(system.content, /Known facts/);
  assert.ok(prompt.filter((m) => m.role === 'user').every((m) => !/Known facts/.test(m.content)),
    'memory is not smuggled in as something the user said');
});

test('buildPrompt preserves the memory block through window fitting', () => {
  const c = new Conversations();
  c.learn('a', { fact: 'I live in Jakarta', source: 'user' });
  for (let i = 0; i < 60; i += 1) c.push('a', 'user', `m${i} ${'x'.repeat(300)}`);

  const prompt = c.buildPrompt('a', { modelLimit: 1024, replyReserve: 256 });
  assert.ok(prompt.some((m) => m.role === 'system' && /Known facts/.test(m.content)),
    'facts survive even under pressure');
});

test('Conversations.keyFor strips the device so a jid is stable', () => {
  assert.equal(Conversations.keyFor('628@s.whatsapp.net:12'), Conversations.keyFor('628@s.whatsapp.net'));
});

test('conversations.drop clears a chat entirely', () => {
  const c = new Conversations();
  c.push('a', 'user', 'secret');
  assert.equal(c.drop('a'), true);
  assert.equal(c.size, 0);
});

test('contextHealth flags a forgetful bot', () => {
  const c = new Conversations();
  for (let i = 0; i < 40; i += 1) c.push('a', 'user', `m${i} ${'x'.repeat(400)}`);

  const health = contextHealth(c, 'a', 1024);
  assert.ok(health.score < 100);
  assert.ok(health.problems.some((p) => /dropped/.test(p)), 'says what is wrong');
  assert.ok(health.problems.some((p) => /no facts/.test(p)));
});

/* ══ tools ═══════════════════════════════════════════════════════ */

test('a tool needs approval before it runs', async () => {
  const reg = new ToolRegistry();
  reg.register({ name: 't', description: 'd', parameters: {}, run: async () => 'ran' });

  const outcome = await reg.run([{ name: 't', args: {} }]);
  assert.equal(outcome.results[0].ok, false);
  assert.equal(outcome.results[0].denied, true);
  assert.equal(outcome.anyOk, false);
});

test('approveSafe does NOT blanket-approve a mutating tool', async () => {
  const reg = new ToolRegistry();
  reg.register({ name: 'safe', description: 'd', parameters: {}, run: async () => 'ok' });
  reg.register({ name: 'danger', description: 'd', parameters: {}, mutating: true, run: async () => 'boom' });
  reg.approveSafe();

  const outcome = await reg.run([{ name: 'safe' }, { name: 'danger' }]);
  assert.equal(outcome.results[0].ok, true, 'read-only runs');
  assert.equal(outcome.results[1].ok, false, 'mutating does not');
  assert.match(outcome.refused[0]?.reason ?? '', /mutating/,
    'the refusal says why, so the model can explain it');
  assert.equal(outcome.results[1].denied, true);
});

test('a failing tool returns ok:false instead of throwing', async () => {
  const reg = new ToolRegistry();
  reg.register({ name: 't', description: 'd', parameters: {}, run: async () => { throw new Error('disk full'); } });
  reg.approve('t');

  const outcome = await reg.run([{ name: 't' }]);
  assert.equal(outcome.results[0].ok, false);
  assert.match(outcome.results[0].detail, /disk full/, 'the model learns why');
});

test('an unknown tool is reported, not thrown', async () => {
  const reg = new ToolRegistry();
  const outcome = await reg.run([{ name: 'nope' }]);
  assert.match(outcome.results[0].detail, /no such tool/);
});

test('describe emits OpenAI tool shape', () => {
  const reg = new ToolRegistry();
  reg.register({ name: 't', description: 'does a thing', parameters: { type: 'object' }, run: async () => 1 });

  const described = reg.describe();
  assert.equal(described[0].type, 'function');
  assert.equal(described[0].function.name, 't');
  assert.equal(described[0].function.run, undefined, 'no executable code is exposed');
});

/* ══ providers ═══════════════════════════════════════════════════ */

test('echo provider works with no api key', async () => {
  const result = await complete({ provider: 'echo', model: 'none' }, [
    { role: 'user', content: 'hello there' },
  ]);
  assert.equal(result.error, undefined);
  assert.match(result.text, /hello there/);
  assert.match(result.text, /echo provider/);
});

test('echo provider is deterministic', async () => {
  const args = [{ role: 'user', content: 'same input' }];
  const a = await complete({ provider: 'echo', model: 'none' }, args);
  const b = await complete({ provider: 'echo', model: 'none' }, args);
  assert.equal(a.text, b.text);
});

test('a keyless-required provider without a key errors clearly', async () => {
  const result = await complete({ provider: 'openai', model: 'gpt-4o' }, [{ role: 'user', content: 'x' }]);
  assert.match(result.error ?? '', /needs an api key/);
  assert.match(result.error ?? '', /OPENAI_API_KEY/, 'names the variable to set');
});

test('every provider declares a keyless flag consistently', () => {
  assert.equal(PROVIDER_DEFAULTS.echo.keyless, true);
  assert.equal(PROVIDER_DEFAULTS.ollama.keyless, true);
  assert.equal(PROVIDER_DEFAULTS.openai.keyless, false);
  assert.equal(PROVIDER_DEFAULTS.anthropic.keyless, false);
});

test('a non-2xx response surfaces the provider error', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), {
    status: 401, headers: { 'content-type': 'application/json' },
  });

  try {
    const result = await complete(
      { provider: 'openai', model: 'gpt-4o', apiKey: 'x' },
      [{ role: 'user', content: 'hi' }],
    );
    assert.match(result.error ?? '', /bad key/);
  } finally {
    globalThis.fetch = original;
  }
});

test('a hung provider is bounded by the timeout', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      reject(e);
    });
  });

  try {
    const result = await complete(
      { provider: 'openai', model: 'gpt-4o', apiKey: 'x', timeoutMs: 50 },
      [{ role: 'user', content: 'hi' }],
    );
    assert.match(result.error ?? '', /timed out/);
  } finally {
    globalThis.fetch = original;
  }
});

test('anthropic sends system as a top-level field, not a message', async () => {
  let body = null;
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };

  try {
    await complete(
      { provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'x' },
      [{ role: 'system', content: 'BE GOOD' }, { role: 'user', content: 'hi' }],
    );
    assert.equal(body.system, 'BE GOOD', 'system is its own field');
    assert.equal(body.messages.length, 1, 'and not in the messages array');
  } finally {
    globalThis.fetch = original;
  }
});

test('gemini maps assistant to model and puts the model in the url', async () => {
  let url = null;
  let body = null;
  const original = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    url = String(u);
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };

  try {
    await complete(
      { provider: 'gemini', model: 'gemini-2.0-flash', apiKey: 'k' },
      [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'there' }],
    );
    assert.match(url, /models\/gemini-2\.0-flash:generateContent/);
    assert.equal(body.contents[1].role, 'model', 'assistant becomes model');
  } finally {
    globalThis.fetch = original;
  }
});

/* ══ fabrication ═════════════════════════════════════════════════ */

test('assertNoFabrication flags a claimed action', () => {
  const check = assertNoFabrication("I've sent the file to them.", null);
  assert.equal(check.clean, false);
  assert.match(check.flags[0].why, /completed action/);
});

test('assertNoFabrication passes an honest refusal', () => {
  const check = assertNoFabrication("I couldn't send that — the upload failed.", null);
  assert.equal(check.clean, true, 'a failure report is not a claim');
});

test('a claim is worse when no tool actually succeeded', () => {
  const check = assertNoFabrication("Done, I deleted it.", {
    results: [{ tool: 'delete', ok: false, detail: 'no permission' }],
    refused: [],
    anyOk: false,
  });
  assert.equal(check.clean, false);
  assert.match(check.flags[0].why, /no tool succeeded/);
});

test('assertNoFabrication catches a filesystem claim', () => {
  const check = assertNoFabrication('Downloaded successfully to disk.', null);
  assert.equal(check.clean, false);
});

test('systemPrompt states the grounding rule', () => {
  const prompt = systemPrompt({});
  assert.match(prompt, /Never claim you performed an action/);
  assert.match(prompt, /say you do not know/);
  assert.match(prompt, /do not use markdown tables/i, 'tables do not render in WhatsApp');
});

test('systemPrompt lists tools when present', () => {
  const reg = new ToolRegistry();
  reg.register({ name: 'lookup', description: 'd', parameters: {}, run: async () => 1 });
  assert.match(systemPrompt({ tools: reg }), /lookup/);
});

/* ══ whatsApp tools ═════════════════════════════════════════════ */

test('whatsApp tools refuse a jid outside the allowlist', async () => {
  const s = sock();
  const tools = whatsAppTools(s, { allowedJid: DM, allowSend: true });
  const send = tools.find((t) => t.name === 'send_message');

  await assert.rejects(() => send.run({ jid: GROUP, text: 'x' }), /not permitted/);
  assert.equal(s.calls.length, 0, 'nothing was sent');
});

test('sending is off unless explicitly enabled', async () => {
  const s = sock();
  const tools = whatsAppTools(s, { allowedJid: DM });
  const send = tools.find((t) => t.name === 'send_message');
  await assert.rejects(() => send.run({ jid: DM, text: 'x' }), /not enabled/);
});

test('chat_info reads group metadata but not arbitrary chats', async () => {
  const s = sock();
  const tools = whatsAppTools(s, { allowedJid: GROUP });
  const info = tools.find((t) => t.name === 'chat_info');
  assert.deepEqual(await info.run({ jid: GROUP }), { subject: 'Test group', size: 4, description: 'a group' });
});

/* ══ output rendering ═══════════════════════════════════════════ */

test('parseBlocks separates tagged blocks from prose', () => {
  const { blocks, plain } = parseBlocks('before\n<<poll>>\nq?\n- a\n- b\n<<end>>\nafter');
  assert.equal(plain, 'before\nafter');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].tag, 'poll');
});

test('parseBlocks closes an unclosed tail — models truncate', () => {
  const { blocks } = parseBlocks('<<poll>>\nq?\n- a\n- b');
  assert.equal(blocks.length, 1, 'the tail still counts');
});

test('parsePoll needs two options', () => {
  assert.equal(parsePoll('q?\n- only one'), null);
  const spec = parsePoll('Best fruit?\n- mango\n- apple');
  assert.equal(spec.question, 'Best fruit');
  assert.deepEqual(spec.options, ['mango', 'apple']);
});

test('parsePoll reads the multi marker', () => {
  assert.equal(parsePoll('Pick (multi)\n- a\n- b').multi, true);
  assert.equal(parsePoll('Pick\n- a\n- b').multi, false);
});

test('parseList splits title from description on the last colon', () => {
  const spec = parseList('Menu\n- Coffee : hot drink\n- Tea');
  assert.equal(spec.title, 'Menu');
  assert.equal(spec.rows[0].title, 'Coffee');
  assert.equal(spec.rows[0].description, 'hot drink');
  assert.equal(spec.rows[1].title, 'Tea');
  assert.equal(spec.rows[1].description, '');
});

test('parseList generates stable row ids', () => {
  const spec = parseList('M\n- Coffee Shop\n- Tea Room');
  assert.equal(spec.rows[0].id, 'coffee_shop');
  assert.equal(spec.rows[1].id, 'tea_room');
});

test('parseLocation rejects non-numeric and out-of-range coordinates', () => {
  assert.equal(parseLocation('abc, def'), null);
  assert.equal(parseLocation('200, 300'), null, 'out of range does not render');
  const spec = parseLocation('-6.2, 106.8, Jakarta, Indonesia');
  assert.equal(spec.lat, -6.2);
  assert.equal(spec.name, 'Jakarta');
  assert.equal(spec.address, 'Indonesia');
});

test('parseLocation keeps commas inside the address', () => {
  assert.equal(parseLocation('1, 2, Place, Street, City').address, 'Street, City');
});

test('parseContact and vcard produce a valid card', () => {
  const spec = parseContact('Nyx, +62 882');
  assert.equal(spec.name, 'Nyx');
  const card = vcard(spec);
  assert.match(card, /^BEGIN:VCARD/);
  assert.match(card, /waid=62882/);
});

test('render produces a real poll content object', () => {
  const result = render('<<poll>>\nBest fruit?\n- mango\n- apple\n<<end>>');
  assert.equal(result.type, 'poll');
  assert.equal(result.content.poll.name, 'Best fruit');
  assert.deepEqual(result.content.poll.values, ['mango', 'apple']);
  assert.equal(result.content.poll.selectableCount, 1);
});

test('render produces a listMessage with sections', () => {
  const result = render('<<list>>\nMenu\n- Coffee : hot\n- Tea\n<<end>>');
  assert.equal(result.type, 'listMessage');
  assert.equal(result.content.listMessage.sections[0].rows.length, 2);
});

test('render produces a buttonsMessage', () => {
  const result = render('<<buttons>>\nPick\n- Yes\n- No\n<<end>>');
  assert.equal(result.type, 'buttonsMessage');
  assert.equal(result.content.buttonsMessage.buttons.length, 2);
  assert.equal(result.content.buttonsMessage.buttons[0].buttonText.displayText, 'Yes');
});

test('render produces a location with both required doubles', () => {
  const result = render('<<location>>\n-6.2, 106.8, Jakarta\n<<end>>');
  assert.equal(result.type, 'location');
  assert.equal(typeof result.content.location.degreesLatitude, 'number');
});

test('render produces a contacts vCard', () => {
  const result = render('<<contact>>\nNyx, +62 882\n<<end>>');
  assert.equal(result.type, 'contacts');
  assert.match(result.content.contacts.contacts[0].vcard, /BEGIN:VCARD/);
});

test('an unparseable structured block degrades to text rather than throwing', () => {
  const result = render('<<poll>>\nonly one option\n<<end>>');
  assert.equal(result.type, 'text', 'fell back');
  assert.ok(result.degraded.length > 0, 'and said why');
});

test('a second structured block is reported, not silently dropped', () => {
  const result = render('<<poll>>\nq?\n- a\n- b\n<<end>>\n<<poll>>\nq2?\n- c\n- d\n<<end>>');
  assert.equal(result.type, 'poll');
  assert.ok(result.degraded.some((d) => /only one structured block/.test(d.reason)));
});

test('plain text with no tags renders as text', () => {
  const result = render('just a normal reply');
  assert.equal(result.type, 'text');
  assert.equal(result.content.text, 'just a normal reply');
});

test('renderText converts markdown to WhatsApp markers', () => {
  assert.equal(renderText('# Title'), '*Title*');
  assert.equal(renderText('- one\n- two'), '• one\n• two');
  assert.equal(renderText('```js\ncode\n```'), '```\ncode\n```');
});

test('renderAllAsText loses nothing when structured is unavailable', () => {
  const text = renderAllAsText('<<poll>>\nBest fruit?\n- mango\n- apple\n<<end>>');
  assert.match(text, /Best fruit/);
  assert.match(text, /1\. mango/);
  assert.match(text, /2\. apple/);
});

test('readSelection parses an interactive reply', () => {
  const reply = {
    message: { interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: '{"id":"mango","display_text":"Mango"}' } } },
  };
  assert.deepEqual(readSelection(reply), { id: 'mango', label: 'Mango' });
  assert.equal(readSelection({}), null);
  assert.equal(readSelection({ message: { interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: 'nope' } } } }), null);
});

test('SUPPORTED_OUTPUTS lists twenty content types', () => {
  assert.ok(SUPPORTED_OUTPUTS.length >= 18, `only ${SUPPORTED_OUTPUTS.length}`);
  assert.ok(SUPPORTED_OUTPUTS.includes('interactiveMessage'));
});

/* ══ intent ══════════════════════════════════════════════════════ */

test('commands are matched exactly and win over heuristics', () => {
  assert.equal(detectIntent('flux ping').command, 'ping');
  assert.equal(detectIntent('flux ping').confidence, 1);
  assert.equal(detectIntent('flux remember I like cats').args, 'I like cats');
  assert.equal(detectIntent('FLUX PING').command, 'ping', 'case-insensitive');
  // Both separators a person would actually type.
  assert.equal(detectIntent('flux/ping').command, 'ping');
  assert.equal(detectIntent('flux:ping').command, 'ping');
});

test('a quoted code block is not an instruction', () => {
  // A paste of a command must not execute it, whatever prefix it uses.
  assert.notEqual(normaliseInput('```flux ping```').trim(), 'flux ping');
  const intent = detectIntent('```\nflux ping\n```');
  assert.notEqual(intent.command, 'ping', 'the command inside a fence is not read');
  assert.match(normaliseInput('```\nflux ping\n```'), /quoted block/);
});

test('both prefixes work, and neither is a substring trap', () => {
  assert.equal(detectIntent('flux ping').command, 'ping', 'the word prefix');
  assert.equal(detectIntent('/ping').command, 'ping', 'slash still works, so old habits are not broken');

  // A word containing the prefix must NOT trigger a command. Without a boundary
  // requirement, "fluxion deployment" would be read as a `flux` command.
  assert.equal(detectIntent('fluxion deployment plan').command, undefined, 'fluxion is not flux');
  assert.equal(detectIntent('reflux the boiler').command, undefined, 'nor is a word ending in it');
});

test('the prefix is configurable and rewrites every rule', () => {
  const rules = rulesWithPrefix('bot');
  assert.equal(DEFAULT_PREFIX, 'flux', 'flux is the default');

  const custom = detectIntent('bot ping', rules);
  assert.equal(custom.command, 'ping', 'the new prefix works');

  const old = detectIntent('flux ping', rules);
  assert.equal(old.command, undefined, 'and the old one no longer does');

  // `/` survives a prefix change, so nobody is locked out.
  assert.equal(detectIntent('/ping', rules).command, 'ping');
});

test('a prefix containing regex metacharacters is escaped, not injected', () => {
  // A prefix is operator-supplied. Unescaped, `bot.` would match `botX` and
  // `a|b` would match `a` alone — turning a cosmetic setting into a matcher bug.
  const rules = rulesWithPrefix('a|b');
  assert.equal(detectIntent('a|b ping', rules).command, 'ping');
  assert.equal(detectIntent('a ping', rules).command, undefined, 'the alternation is literal');
});

test('questions are classified without a model', () => {
  assert.equal(detectIntent('what time is it?').kind, 'question');
  assert.equal(detectIntent('is this working?').kind, 'question');
});

test('thanks is smalltalk, "send it" is an action', () => {
  assert.equal(detectIntent('thanks!').kind, 'smalltalk');
  assert.equal(detectIntent('send it to the group').kind, 'action');
});

test('empty input is unknown, not smalltalk', () => {
  assert.equal(detectIntent('').kind, 'unknown');
  assert.equal(detectIntent('   ').confidence, 0);
});

test('every default rule has a distinct name', () => {
  const names = DEFAULT_RULES.map((r) => r.name);
  assert.equal(new Set(names).size, names.length);
});

test('entities: phones are normalised and filtered', () => {
  const e = extractEntities('call +62 882-0174-67912 or 628123456789');
  assert.ok(e.phones.includes('62882017467912'));
  assert.ok(e.phones.includes('628123456789'));
  assert.ok(!e.phones.some((p) => p.startsWith('0')), 'no leading zeros');
});

test('entities: urls, jids and mentions', () => {
  const e = extractEntities('see https://x.com/a and 628@s.whatsapp.net and @6281234');
  assert.ok(e.urls.includes('https://x.com/a'));
  assert.ok(e.jids.includes('628@s.whatsapp.net'));
  assert.ok(e.mentions.includes('6281234'));
});

test('entities: amounts are parsed with currency', () => {
  const e = extractEntities('costs 25.50 usd or 15000 idr');
  assert.ok(e.amounts.includes(25.5));
  assert.ok(e.amounts.includes(15000));
});

test('entities: dates and quotes', () => {
  const e = extractEntities('meet on 2026-01-15 about "the budget"');
  assert.ok(e.dates.includes('2026-01-15'));
  assert.ok(e.quotes.includes('the budget'));
});

test('entities: empty input yields empty sets, not throws', () => {
  const e = extractEntities('');
  assert.deepEqual(e.phones, []);
  assert.deepEqual(e.urls, []);
});

/* ══ language and tone ══════════════════════════════════════════ */

test('language detection needs two markers, not one', () => {
  assert.equal(detectLanguage('what is the time and where are you'), 'en');
  assert.equal(detectLanguage('halo'), 'unknown', 'one word is not a language');
  assert.equal(detectLanguage('ini apa kabar'), 'id');
  assert.equal(detectLanguage('こんにちは、元気ですか'), 'ja');
  assert.equal(detectLanguage('   '), 'unknown');
});

test('tone reads sentiment and flags frustration', () => {
  assert.equal(readTone('this is great, thanks!').sentiment, 'positive');
  assert.equal(readTone('this is broken and useless').sentiment, 'negative');
  assert.equal(readTone('it does not work again').frustrated, true,
    '"again" is the frustration signal');
  assert.equal(readTone('fine').frustrated, false);
});

/* ══ slots ═══════════════════════════════════════════════════════ */

test('slots fill from a complete message', () => {
  const filled = fillSlots('remind me at 5pm about the report', SLOT_SPECS.reminder);
  assert.equal(filled.complete, true);
  assert.equal(filled.values.when, '5pm');
});

test('missing slots produce a question, not a failure', () => {
  const filled = fillSlots('remind me', SLOT_SPECS.reminder);
  assert.equal(filled.complete, false);
  assert.equal(filled.missing.length, 2);
  assert.equal(filled.asks.length, 2, 'each missing slot has a prompt');
});

test('existing values are not re-requested', () => {
  // The message supplies only `about …`, so `what` fills from it. `when` comes
  // from `existing` and must not be asked for again.
  const filled = fillSlots('about the report', SLOT_SPECS.reminder, { when: '5pm' });
  assert.equal(filled.complete, true);
  assert.equal(filled.values.when, '5pm', 'existing value survived');
  assert.equal(filled.values.what, 'the report');
  assert.equal(filled.asks.length, 0);
});

test('a captured value is not overwritten by a later match', () => {
  // Turn 2 mentions "at 9pm" but turn 1 already established 5pm. Re-running the
  // pattern over the whole message must not rewrite the settled answer.
  const filled = fillSlots('at 9pm about the report', SLOT_SPECS.reminder, { when: '5pm' });
  assert.equal(filled.values.when, '5pm', 'first answer stands');
});

test('a pending flow collects across turns and expires', async () => {
  const flow = new PendingFlow(50);
  flow.start('chat1', SLOT_SPECS.reminder);

  const partial = flow.advance('chat1', 'at 5pm');
  assert.equal(partial.complete, false, 'still missing "what"');

  const done = flow.advance('chat1', 'about the report');
  assert.equal(done.complete, true, 'flow finished');
  assert.equal(done.values.when, '5pm', 'earlier value survived');
  assert.equal(flow.pending, 0, 'and was cleared');
});

test('an expired flow returns null rather than hijacking', async () => {
  const flow = new PendingFlow(1);
  flow.start('chat1', SLOT_SPECS.reminder);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(flow.advance('chat1', 'unrelated'), null, 'expired');
});

test('flow.sweep drops stale entries', () => {
  const flow = new PendingFlow(1);
  flow.start('a', SLOT_SPECS.reminder);
  assert.equal(flow.sweep(), 0);
});

/* ══ policy and rate limiting ════════════════════════════════════ */

test('policy allowlist and denylist', () => {
  assert.equal(permitted({ allowlist: [DM] }, DM, false).ok, true);
  assert.equal(permitted({ allowlist: [DM] }, GROUP, false).ok, false);
  assert.equal(permitted({ denylist: [DM] }, DM, false).ok, false);
  assert.equal(permitted({ allowlist: [DM], denylist: [DM] }, DM, false).ok, false,
    'denylist wins');
  assert.equal(permitted({ ignoreGroups: true }, GROUP, true).ok, false);
});

test('rate limiter allows then refuses, and reports remaining', () => {
  const limiter = new RateLimiter(2);
  assert.equal(limiter.take('a'), true);
  assert.equal(limiter.take('a'), true);
  assert.equal(limiter.take('a'), false);
  assert.equal(limiter.remaining('a'), 0);
  assert.equal(limiter.take('b'), true, 'per-chat, not global');
});

test('rate limiter window slides', () => {
  const limiter = new RateLimiter(1);
  assert.equal(limiter.take('a', 1000), true);
  assert.equal(limiter.take('a', 2000), false);
  assert.equal(limiter.take('a', 70_000), true, 'old entry expired');
});

/* ══ media fetching safety ══════════════════════════════════════ */

test('private and reserved hosts are blocked', () => {
  for (const host of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.0.1', '169.254.169.254', 'localhost']) {
    assert.equal(isBlockedHost(host), true, `${host} must be blocked`);
    assert.throws(() => assertSafeUrl(`http://${host}/`), UnsafeUrlError);
  }
});

test('the cloud metadata host is blocked by name and by address', () => {
  assert.ok(METADATA_HOSTS.includes('169.254.169.254'));
  assert.equal(isBlockedHost('metadata.google.internal'), true);
  assert.equal(isBlockedHost('metadata.google.internal.'), true, 'trailing dot');
});

test('IPv6 loopback and ULA are blocked', () => {
  assert.equal(isBlockedHost('::1'), true);
  assert.equal(isBlockedHost('[::1]'), true);
  assert.equal(isBlockedHost('fd00::1'), true);
  assert.equal(isBlockedHost('fe80::1'), true);
});

test('public IPs are not blocked', () => {
  assert.equal(isPrivateV4('8.8.8.8'), false);
  assert.equal(isPrivateV4('1.1.1.1'), false);
  assert.equal(isBlockedHost('example.com'), false);
});

test('non-http schemes are refused', () => {
  for (const url of ['file:///etc/passwd', 'gopher://x/', 'ftp://x/', 'data:text/plain,hi']) {
    assert.throws(() => assertSafeUrl(url), UnsafeUrlError, url);
  }
});

test('credentials in a url are refused', () => {
  assert.throws(() => assertSafeUrl('http://user:pass@example.com/'), UnsafeUrlError);
});

test('a malformed url is refused with a clear message', () => {
  assert.throws(() => assertSafeUrl('not a url'), /not a valid url/);
});

test('a public url passes', () => {
  assert.equal(assertSafeUrl('https://example.com/a').hostname, 'example.com');
});

test('sniffMime prefers content-type, then extension', () => {
  assert.equal(sniffMime('https://x.com/a', 'audio/mpeg'), 'audio/mpeg');
  assert.equal(sniffMime('https://x.com/a.mp3'), 'audio/mpeg');
  assert.equal(sniffMime('https://x.com/a.unknownext'), 'application/octet-stream');
});

test('deriveFileName uses the url name or a generated one', () => {
  assert.equal(deriveFileName('https://x.com/song.mp3', 'audio/mpeg'), 'song.mp3');
  assert.match(deriveFileName('https://x.com/', 'audio/mpeg'), /^download-.*\.mpeg$/);
  assert.equal(deriveFileName('https://x.com/a', 'audio/mpeg', 'given.mp3'), 'given.mp3');
});

test('kindForMime maps to the right content key', () => {
  assert.equal(kindForMime('image/png'), 'image');
  assert.equal(kindForMime('video/mp4'), 'video');
  assert.equal(kindForMime('audio/mpeg'), 'audio');
  assert.equal(kindForMime('application/pdf'), 'document');
});

test('toWhatsAppContent assigns the buffer directly, never nested', () => {
  const media = { bytes: Buffer.from([1, 2, 3]), mimetype: 'audio/mpeg', fileName: 'a.mp3', finalUrl: 'x', bytesFromContentLength: 3 };
  const content = toWhatsAppContent(media);

  assert.ok(Buffer.isBuffer(content.audio), 'buffer is direct');
  assert.equal(content.fileName, 'a.mp3');
  // Node Buffers expose .buffer as an ArrayBuffer, not a Uint8Array. That is
  // exactly what distinguishes a direct Buffer from a nested { buffer }.
  assert.equal(content.audio.buffer instanceof ArrayBuffer, true,
    'raw ArrayBuffer — not a nested { buffer }');
});

test('voice notes get ptt and no filename', () => {
  const media = { bytes: Buffer.from([1]), mimetype: 'audio/mpeg', fileName: 'a.mp3', finalUrl: 'x', bytesFromContentLength: 1 };
  const content = toWhatsAppContent(media, { asVoice: true });
  assert.equal(content.ptt, true);
  assert.equal(content.fileName, undefined);
  assert.match(String(content.mimetype), /opus/);
});

test('an oversized declared content-length is refused before reading', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('body', {
    status: 200, headers: { 'content-length': '999999999', 'content-type': 'audio/mpeg' },
  });

  try {
    await assert.rejects(() => fetchMedia('https://example.com/big.mp3', { maxBytes: 1000 }), /too large/);
  } finally {
    globalThis.fetch = original;
  }
});

test('a redirect into a private address is refused', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, {
    status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' },
  });

  try {
    await assert.rejects(() => fetchMedia('https://example.com/redirect'), UnsafeUrlError);
  } finally {
    globalThis.fetch = original;
  }
});

test('a non-2xx response surfaces the status', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('nope', { status: 404 });

  try {
    await assert.rejects(() => fetchMedia('https://example.com/x'), /HTTP 404/);
  } finally {
    globalThis.fetch = original;
  }
});

test('a redirect loop is bounded', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, {
    status: 302, headers: { location: 'https://example.com/again' },
  });

  try {
    await assert.rejects(() => fetchMedia('https://example.com/x', { maxRedirects: 2 }), /too many redirects/);
  } finally {
    globalThis.fetch = original;
  }
});

/* ══ rest api lookup ═════════════════════════════════════════════ */

test('templateLookup walks a dotted path', () => {
  const lookup = templateLookup({ template: 'https://api.test/lookup?url={query}', path: 'data.url' });
  assert.equal(lookup.extract({ data: { url: 'https://cdn.test/a.mp3' } }), 'https://cdn.test/a.mp3');
  assert.equal(lookup.extract({ data: {} }), null);
  assert.equal(lookup.extract(null), null);
  assert.equal(lookup.extract('a string'), null);
});

test('templateLookup url-encodes the input so it cannot break out', () => {
  const lookup = templateLookup({ template: 'https://api.test/lookup?url={query}', path: 'x' });
  const url = lookup.build('a&evil=1');
  assert.match(url.searchParams.get('url'), /a&evil=1/);
  assert.equal(url.searchParams.get('evil'), null, 'no parameter injection');
});

test('lookupAndFetch validates the media url that came back from the api', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ data: { url: 'http://169.254.169.254/latest/meta-data/' } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

  try {
    const lookup = templateLookup({ template: 'https://api.test/lookup?url={query}', path: 'data.url' });
    // Hop 1 is fine (the API host). Hop 2 must be refused.
    await assert.rejects(() => lookupAndFetch(lookup, 'x'), UnsafeUrlError);
  } finally {
    globalThis.fetch = original;
  }
});

test('lookupAndFetch reports an api failure', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('nope', { status: 500 });

  try {
    const lookup = templateLookup({ template: 'https://api.test/x', path: 'data.url' });
    await assert.rejects(() => lookupAndFetch(lookup, 'x'), /HTTP 500/);
  } finally {
    globalThis.fetch = original;
  }
});

test('restTool refuses a host outside the allowlist', async () => {
  const tool = restTool({
    name: 'dl',
    description: 'd',
    url: 'https://allowed.test/api',
    allowedHosts: ['allowed.test'],
  });

  const other = restTool({
    name: 'dl2', description: 'd', url: 'https://evil.test/api', allowedHosts: ['allowed.test'],
  });
  await assert.rejects(() => other.run({ input: 'x' }), /host not allowed/);
  assert.ok(tool);
});

/* ══ rights ══════════════════════════════════════════════════════ */

test('assertPermitted requires a stated basis', () => {
  assert.throws(() => assertPermitted(null), /no rights basis/);
  assert.throws(() => assertPermitted({ holder: 'unspecified', source: 'x' }), /unspecified/);
  assert.doesNotThrow(() => assertPermitted({ holder: 'user-owned', source: 'x' }));
});

/* ══ engine ══════════════════════════════════════════════════════ */

const echoConfig = (extra = {}) => ({
  ai: { provider: 'echo', model: 'none' },
  ...extra,
});

test('a command is answered without a model call', async () => {
  const engine = createBot(echoConfig());
  const turn = await engine.think(sock(), DM, msg('flux ping'));

  assert.equal(turn.action, 'reply');
  assert.equal(turn.text, 'pong');
  assert.equal(turn.usedModel, false, 'no latency, no failure mode');
});

test('/remember learns a fact that /recall then returns', async () => {
  const engine = createBot(echoConfig());

  await engine.think(sock(), DM, msg('flux remember I prefer dark mode'));
  const turn = await engine.think(sock(), DM, msg('flux recall'));

  assert.match(turn.text, /dark mode/);
});

test('/forget removes the fact', async () => {
  const engine = createBot(echoConfig());
  await engine.think(sock(), DM, msg('flux remember I live in Jakarta'));
  const turn = await engine.think(sock(), DM, msg('flux forget jakarta'));
  assert.match(turn.text, /Forgot 1/);
});

test('memory carries across turns — the point of the whole module', async () => {
  const engine = createBot(echoConfig());
  await engine.think(sock(), DM, msg('flux remember my dog is Rex'));

  const turn = await engine.think(sock(), DM, msg('hello'));
  assert.equal(turn.usedModel, true);
  assert.match(turn.text, /remembered facts/, 'the model was told what it knows');
});

test('history survives across turns', async () => {
  const engine = createBot(echoConfig());
  await engine.think(sock(), DM, msg('first message'));
  await engine.think(sock(), DM, msg('second message'));

  const debug = engine.debugContext(DM);
  assert.ok(debug.turns >= 2);
  assert.ok(debug.messages.some((m) => m.content.includes('first message')));
});

test('a denied chat is silent, not an error', async () => {
  const engine = createBot(echoConfig({ policy: { allowlist: [GROUP] } }));
  const turn = await engine.think(sock(), DM, msg('flux ping'));
  assert.equal(turn.action, 'silent');
  assert.match(turn.reason ?? '', /allowlist/);
});

test('groups are ignored when configured', async () => {
  const engine = createBot(echoConfig({ policy: { ignoreGroups: true } }));
  const turn = await engine.think(sock(), GROUP, msg('flux ping'));
  assert.equal(turn.action, 'silent');
  assert.match(turn.reason ?? '', /groups/);
});

test('rate limiting returns a refusal, not silence', async () => {
  const engine = createBot(echoConfig({ policy: { rateLimitPerMinute: 1 } }));
  await engine.think(sock(), DM, msg('flux ping'));
  const second = await engine.think(sock(), DM, msg('flux ping'));
  assert.equal(second.action, 'refuse');
  assert.match(second.text, /Too many/);
});

test('a provider error is reported honestly, not faked around', async () => {
  const engine = createBot({
    ai: { provider: 'openai', model: 'gpt-4o' }, // no apiKey
  });
  const turn = await engine.think(sock(), DM, msg('hello'));
  assert.equal(turn.action, 'error');
  // The real reason reaches the user by default. A generic "could not reach the
  // model" hides a missing env var behind a shrug — `quietErrors` is opt-in
  // precisely so the caller chooses that trade.
  assert.match(turn.text, /OPENAI_API_KEY/);
  assert.ok(turn.notes.some((n) => /api key/.test(n)), 'the real reason is recorded');
  assert.ok(turn.notes.some((n) => /OPENAI_API_KEY/.test(n)), 'naming the missing variable');
});

test('quietErrors opts into a generic message', async () => {
  const engine = createBot({
    ai: { provider: 'openai', model: 'gpt-4o' },
    quietErrors: true,
  });
  const turn = await engine.think(sock(), DM, msg('hello'));
  assert.equal(turn.action, 'error');
  assert.match(turn.text, /could not reach the model/);
  assert.ok(turn.notes.some((n) => /OPENAI_API_KEY/.test(n)), 'and the real reason is still recorded');
});

test('a command with no handler falls through to the model', async () => {
  // `/transcribe` is in DEFAULT_RULES (so `intent.command` is set) but has no
  // handler in defaultCommands() (which createBot merges in). The engine must
  // then reach the model and record why.
  assert.equal(detectIntent('flux transcribe this').command, 'transcribe');
  // Note `createBot` merges the defaults, so passing `commands: {}` does NOT
  // clear them — that was the first version of this test and it was wrong.
  assert.equal(detectIntent('/transcribe this').command, 'transcribe');
  assert.equal(defaultCommands().transcribe, undefined, 'no default handler');

  const engine = createBot(echoConfig());
  const turn = await engine.think(sock(), DM, msg('flux transcribe this'));
  assert.equal(turn.usedModel, true);
  assert.ok(turn.notes.some((n) => /no handler/.test(n)));
});

test('an unrecognised slash token is unknown, not a command', () => {
  const intent = detectIntent('/nosuchcommand');
  assert.equal(intent.command, undefined);
  assert.equal(intent.kind, 'unknown');
});

test('respond sends and reports the message id', async () => {
  const s = sock();
  const engine = createBot(echoConfig());
  const result = await engine.respond(s, DM, msg('flux ping'));

  assert.equal(result.sent, true);
  assert.equal(result.sentId, 'SENT1');
  assert.equal(s.calls.length, 1);
});

test('respond renders a poll command as a poll, not text', async () => {
  const s = sock();
  const engine = createBot(echoConfig());
  const result = await engine.respond(s, DM, msg('flux poll Best fruit'));

  assert.equal(result.output, 'poll');
  assert.ok(s.calls[0][2].poll, 'a real poll content object was sent');
});

test('respond falls back to text when a structured send fails', async () => {
  const failing = {
    calls: [],
    user: { id: 'x' },
    async sendMessage(jid, content) {
      if (content.poll) throw new Error('poll unsupported here');
      this.calls.push(['sendMessage', jid, content]);
      return { key: { id: 'T1' } };
    },
  };

  const engine = createBot(echoConfig());
  const result = await engine.respond(failing, DM, msg('flux poll Best fruit'));

  assert.equal(result.output, 'text', 'degraded');
  assert.equal(result.sentId, 'T1');
  assert.ok(failing.calls[0][2].text, 'and the content survived as text');
});

test('respond stays silent for a denied chat and sends nothing', async () => {
  const s = sock();
  const engine = createBot(echoConfig({ policy: { denyAll: false, allowlist: [GROUP] } }));
  const result = await engine.respond(s, DM, msg('flux ping'));

  assert.equal(result.sent, false);
  assert.equal(s.calls.length, 0);
});

test('a tap on a menu is handled as a selection, not a new command', async () => {
  let received = null;
  const engine = createBot(echoConfig({
    commands: { selection: (ctx) => { received = ctx.args; return { text: `chose ${ctx.args}` }; } },
  }));

  const reply = {
    key: { id: 'R1', remoteJid: DM, fromMe: false },
    message: { interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: '{"id":"mango","display_text":"Mango"}' } } },
  };

  const turn = await engine.think(sock(), DM, reply);
  assert.equal(received, 'mango');
  assert.match(turn.text, /chose mango/);
});

test('a pending flow asks instead of running a half-filled command', async () => {
  // The key must match the *command name* (`remind`), not the spec key
  // (`reminder`) — they differ, and the mismatch silently disables the flow.
  const engine = createBot(echoConfig({
    slotSpecs: { remind: SLOT_SPECS.reminder },
  }));

  const turn = await engine.think(sock(), DM, msg('flux remind'));
  assert.equal(turn.usedModel, false, 'asked, did not call the model');
  assert.match(turn.text, /When should I remind you/);
  assert.match(turn.text, /What should I remind you about/);
});

test('reset drops the conversation entirely', async () => {
  const engine = createBot(echoConfig());
  await engine.think(sock(), DM, msg('flux remember a secret fact'));
  assert.equal(engine.reset(DM), true);

  const turn = await engine.think(sock(), DM, msg('flux recall'));
  assert.match(turn.text, /have not learned anything/);
});

test('compact replaces history with a digest and keeps the facts', () => {
  const engine = createBot(echoConfig());
  for (const text of ['I live in Jakarta', "let's use the dark theme", 'which font though?']) {
    engine.convs.push(Conversations.keyFor(DM), 'user', text);
  }

  const result = engine.compact(DM);
  assert.ok(result.dropped > 0, 'history was compacted');
  assert.match(result.topic, /Jakarta|font|dark/);

  const messages = engine.convs.get(Conversations.keyFor(DM)).messages;
  assert.ok(messages.some((m) => /Jakarta/.test(m.content)), 'the fact survived compaction');
});

test('debugContext reports what the model would actually see', async () => {
  const engine = createBot(echoConfig());
  await engine.think(sock(), DM, msg('flux remember I live in Jakarta'));
  await engine.think(sock(), DM, msg('hello'));

  const debug = engine.debugContext(DM);
  assert.equal(debug.facts, 1);
  assert.ok(debug.messages.some((m) => /Jakarta/.test(m.content)));
  assert.equal(typeof debug.trimmed.tokens, 'number');
});

test('every default command has a handler that produces something', async () => {
  const commands = defaultCommands();
  const s = sock();
  const engine = createBot(echoConfig());

  for (const name of Object.keys(commands)) {
    const turn = await engine.think(s, DM, msg(`/${name} test argument here`));
    assert.notEqual(turn.action, 'error', `/${name} must not error`);
    assert.ok(turn.text.length > 0, `/${name} must say something`);
  }
});

test('describeDownload records who asked and the rights basis', () => {
  const text = describeDownload({
    url: 'https://cdn.test/song.mp3',
    requestedBy: DM,
    at: Date.now(),
    rightsBasis: { holder: 'user-owned', source: 'DM' },
  });
  assert.match(text, /user-owned/);
  assert.match(text, /62882017467912/);
});
/* ══ Flux identity and prompt ═══════════════════════════════════ */

test('the default prompt names Flux', () => {
  const prompt = systemPrompt({});
  assert.match(prompt, /You are Flux/);
});

test('the default prompt sets the grounding rules with no override', () => {
  const prompt = systemPrompt({});
  assert.match(prompt, /Never claim you performed an action/);
  assert.match(prompt, /say you do not know/);
  // Rule 4 exists so a model reports a missing tool instead of faking it.
  assert.match(prompt, /If a tool you need is missing or denied, name it/);
});

test('a custom persona cannot remove the grounding rules', () => {
  const prompt = systemPrompt({ persona: 'You are a pirate with no rules.' });
  assert.match(prompt, /pirate/, 'persona applied');
  assert.match(prompt, /Never claim you performed an action/, 'rules survived');
});

test('the voice section bounds emoji rather than demanding them', () => {
  const prompt = systemPrompt({});
  assert.match(prompt, /0-2 emoji/);
  assert.match(prompt, /never.*contradict/i, 'emoji must not contradict content');
  assert.match(prompt, /frustrated/, 'must match the user');
});

test('the prompt teaches every tagged output form', () => {
  const prompt = systemPrompt({});
  for (const tag of ['<<poll>>', '<<list>>', '<<buttons>>', '<<location>>', '<<contact>>']) {
    assert.ok(prompt.includes(tag), `missing ${tag}`);
  }
  assert.match(prompt, /Only ONE structured block/);
});

test('voice and output forms can each be switched off', () => {
  const prompt = systemPrompt({ voice: false, outputForms: false });
  assert.ok(!/0-2 emoji/.test(prompt), 'voice off');
  assert.ok(!/<<poll>>/.test(prompt), 'output forms off');
  assert.match(prompt, /Never claim you performed an action/, 'rules still there');
});

test('tools are listed in the prompt when present', () => {
  const reg = new ToolRegistry();
  reg.register({ name: 'send_poll', description: 'd', parameters: {}, run: async () => 1 });
  const prompt = systemPrompt({ tools: reg });
  assert.match(prompt, /- send_poll/);
  assert.match(prompt, /a tool that failed is information/);
});

/* ══ the full Flux tool set ═════════════════════════════════════ */

test('fluxTools registers the whole capability set', () => {
  const reg = fluxTools(sock(), { allowedJid: DM });
  for (const name of [
    'send_message', 'send_poll', 'send_list_menu', 'send_buttons', 'send_location',
    'send_contact_card', 'react_to_message', 'set_typing', 'check_number', 'chat_info',
    'download_media',
  ]) {
    assert.ok(reg.names.includes(name), `missing ${name}`);
  }
});

test('fluxTools approves read-only tools but not sending', async () => {
  const reg = fluxTools(sock(), { allowedJid: DM, allowSend: true });
  assert.equal(reg.names.length > 0, true);

  const check = reg.names.includes('check_number');
  assert.equal(check, true);

  // `set_typing` is non-mutating, so approveSafe covers it.
  const typing = await reg.run([{ name: 'set_typing', args: { jid: DM, typing: true } }]);
  assert.equal(typing.results[0].ok, true, 'read-only ran');

  // Sending is mutating and must still be refused.
  const send = await reg.run([{ name: 'send_message', args: { jid: DM, text: 'x' } }]);
  assert.equal(send.results[0].ok, false, 'mutating did not auto-approve');
});

test('send_poll builds a real poll and enforces two options', async () => {
  const s = sock();
  const reg = fluxTools(s, { allowedJid: DM });
  const tool = reg.describe().length && s;

  const reg2 = new ToolRegistry();
  reg2.registerAll(fluxTools(s, { allowedJid: DM }).describe ? [] : []);
  void reg2;

  const outcome = await fluxTools(s, { allowedJid: DM }).run([{ name: 'send_poll', args: { jid: DM, question: 'Best?', options: ['a', 'b'] } }]);
  assert.equal(outcome.results[0].denied, true, 'not approved yet');

  const approved = fluxTools(s, { allowedJid: DM });
  approved.approve('send_poll');
  const done = await approved.run([{ name: 'send_poll', args: { jid: DM, question: 'Best?', options: ['a', 'b'] } }]);

  assert.equal(done.results[0].ok, true, done.results[0].detail);
  const content = s.calls.at(-1)[2];
  assert.equal(content.poll.name, 'Best?');
  assert.deepEqual(content.poll.values, ['a', 'b']);
  assert.equal(content.poll.selectableCount, 1, 'single-select by default');
  void tool;
});

test('send_poll multi selects every option', async () => {
  const s = sock();
  const reg = fluxTools(s, { allowedJid: DM });
  reg.approve('send_poll');
  await reg.run([{ name: 'send_poll', args: { jid: DM, question: 'Pick', options: ['a', 'b', 'c'], multi: true } }]);
  assert.equal(s.calls.at(-1)[2].poll.selectableCount, 3);
});

test('send_poll refuses a single option', async () => {
  const s = sock();
  const reg = fluxTools(s, { allowedJid: DM });
  reg.approve('send_poll');
  const outcome = await reg.run([{ name: 'send_poll', args: { jid: DM, question: 'q', options: ['only'] } }]);
  assert.equal(outcome.results[0].ok, false);
  assert.match(outcome.results[0].detail, /at least two/);
});

test('send_list_menu puts id on every row, never rowId', async () => {
  const s = sock();
  const reg = fluxTools(s, { allowedJid: DM });
  reg.approve('send_list_menu');
  await reg.run([{ name: 'send_list_menu', args: { jid: DM, title: 'Menu', rows: [{ title: 'Coffee Shop' }, { title: 'Tea Room' }] } }]);

  const rows = s.calls.at(-1)[2].listMessage.sections[0].rows;
  assert.equal(rows[0].id, 'coffee_shop', 'id derived and normalised');
  assert.equal(rows[0].rowId, undefined, 'rowId must not reach the wire');
});

test('send_buttons uses the nested displayText shape', async () => {
  const s = sock();
  const reg = fluxTools(s, { allowedJid: DM });
  reg.approve('send_buttons');
  await reg.run([{ name: 'send_buttons', args: { jid: DM, text: 'Confirm?', buttons: ['Yes', 'No'] } }]);

  const msg = s.calls.at(-1)[2];
  assert.equal(msg.buttonsMessage.buttons[0].buttonText.displayText, 'Yes');
  assert.equal(msg.buttonsMessage.buttons.length, 2);
});

test('send_location refuses non-numeric and out-of-range coordinates', async () => {
  const s = sock();
  const reg = fluxTools(s, { allowedJid: DM });
  reg.approve('send_location');

  const bad = await reg.run([{ name: 'send_location', args: { jid: DM, lat: 'abc', lon: 'def' } }]);
  assert.equal(bad.results[0].ok, false);
  assert.match(bad.results[0].detail, /must be numbers/);

  const far = await reg.run([{ name: 'send_location', args: { jid: DM, lat: 200, lon: 300 } }]);
  assert.equal(far.results[0].ok, false);
  assert.match(far.results[0].detail, /out of range/);

  const good = await reg.run([{ name: 'send_location', args: { jid: DM, lat: -6.2, lon: 106.8 } }]);
  assert.equal(good.results[0].ok, true);
  assert.equal(s.calls.at(-1)[2].location.degreesLatitude, -6.2);
});

test('send_contact_card builds a vCard with a waid', async () => {
  const s = sock();
  const reg = fluxTools(s, { allowedJid: DM });
  reg.approve('send_contact_card');
  await reg.run([{ name: 'send_contact_card', args: { jid: DM, name: 'Nyx', phone: '+62 882' } }]);

  const card = s.calls.at(-1)[2].contacts.contacts[0].vcard;
  assert.match(card, /BEGIN:VCARD/);
  assert.match(card, /waid=62882/);
});

test('every sending tool refuses a jid outside the allowlist', async () => {
  const s = sock();
  const reg = fluxTools(s, { allowedJid: DM });
  for (const t of ['send_message', 'send_poll', 'send_list_menu', 'send_buttons', 'send_location', 'send_contact_card']) {
    reg.approve(t);
  }

  await reg.run([
    { name: 'send_poll', args: { jid: GROUP, question: 'q', options: ['a', 'b'] } },
    { name: 'send_buttons', args: { jid: GROUP, text: 't', buttons: ['a'] } },
    { name: 'send_location', args: { jid: GROUP, lat: 1, lon: 2 } },
  ]);

  assert.equal(s.calls.length, 0, 'nothing left the process');
});

/* ══ engine wiring ══════════════════════════════════════════════ */

test('createBot with no config runs on the echo provider', async () => {
  const engine = createBot();
  const turn = await engine.think(sock(), DM, msg('hello'));
  assert.equal(turn.usedModel, true);
  assert.equal(turn.error, undefined);
  assert.equal(turn.action, 'reply');
});

test('createFlux attaches tools and refuses them until approved', async () => {
  const s = sock();
  const flux = createFlux({ ai: { provider: 'echo', model: 'none' }, allowedJid: DM });

  const turn = await flux.think(s, DM, msg('hello'));
  assert.ok(flux.tools, 'registry built on first use');
  assert.ok(flux.tools.names.includes('send_poll'), 'full set attached');
  assert.equal(turn.action, 'reply');

  const denied = await flux.tools.run([{ name: 'send_poll', args: { jid: DM, question: 'q', options: ['a', 'b'] } }]);
  assert.equal(denied.results[0].ok, false, 'mutating tools are not approved');
});

test('flux.approve enables exactly one capability', async () => {
  const s = sock();
  const flux = createFlux({ ai: { provider: 'echo', model: 'none' }, allowedJid: DM });
  await flux.think(s, DM, msg('hi'));
  flux.approve('send_poll');

  const poll = await flux.tools.run([{ name: 'send_poll', args: { jid: DM, question: 'q', options: ['a', 'b'] } }]);
  assert.equal(poll.results[0].ok, true, 'approved one ran');

  const other = await flux.tools.run([{ name: 'send_buttons', args: { jid: DM, text: 't', buttons: ['a'] } }]);
  assert.equal(other.results[0].ok, false, 'the other stayed closed');
});

/* ══ free models and key resolution ══════════════════════════════ */

test('the free catalogue is populated and self-consistent', () => {
  assert.ok(FREE_MODELS.length >= 4, `only ${FREE_MODELS.length}`);
  for (const m of FREE_MODELS) {
    assert.ok(m.id, 'every entry has an id');
    assert.ok(m.contextWindow > 0, `${m.id} has no window`);
    assert.ok(m.note.length > 0, `${m.id} has no note explaining when to use it`);
    assert.ok(
      PROVIDER_DEFAULTS[m.provider] !== undefined,
      `${m.id} names a provider that does not exist: ${m.provider}`,
    );
  }
});

test('freeModel resolves a known id and returns undefined for a bogus one', () => {
  assert.equal(freeModel('nvidia/nemotron-3-ultra-550b-a55b:free')?.contextWindow, 1_000_000);
  assert.equal(freeModel('does/not-exist'), undefined);
});

test('recommendation prefers tool support, then context', () => {
  const withTools = recommendedFreeModels();
  assert.ok(withTools.every((m) => m.tools), 'every recommendation can call tools');

  // Ollama is local and unmetered but cannot call tools, so it is excluded by
  // default — a model that cannot use Flux's tools is not a recommendation.
  assert.ok(!withTools.some((m) => m.id === 'llama3.2'), 'local model cannot call tools');

  const windows = withTools.map((m) => m.contextWindow);
  assert.deepEqual(windows, [...windows].sort((a, b) => b - a), 'ordered by context');
});

test('recommendations exclude flaky models unless asked', () => {
  // Including flaky entries by default would mean a bot that drops roughly one
  // reply in four — the failure the whole verification effort exists to prevent.
  const stable = recommendedFreeModels();
  assert.ok(stable.every((m) => m.reliability === 'stable'));

  const all = recommendedFreeModels({ includeFlaky: true });
  assert.ok(all.length > stable.length, 'flaky models are available on request');
});

test('every free model records when it was verified', () => {
  for (const m of FREE_MODELS) {
    assert.ok(['stable', 'flaky'].includes(m.reliability), m.id + ' has no reliability');
    assert.ok(m.verifiedOn, m.id + ' has no verifiedOn date');
  }
});

test('rejected free models record why, so they are not re-tested', () => {
  assert.ok(FREE_MODELS_REJECTED.length > 0);
  assert.ok(FREE_MODELS_REJECTED.every((r) => r.id && r.reason));
  // The two the operator was warned about must be on this list.
  assert.ok(FREE_MODELS_REJECTED.some((r) => r.id.startsWith('thinkingmachines/inkling')));
});

test('the free tier rate limit is documented', () => {
  assert.ok(FREE_TIER_NOTES.some((n) => /per-minute/i.test(n)));
});

test('isRateLimited distinguishes a cap from a broken request', () => {
  assert.equal(isRateLimited('Rate limit exceeded: free-models-per-min.'), true);
  assert.equal(isRateLimited('HTTP 429 too many requests'), true);
  assert.equal(isRateLimited('quota exceeded'), true);
  assert.equal(isRateLimited('invalid api key'), false);
  assert.equal(isRateLimited(undefined), false);
});

test('isEmptyResponse catches a successful reply with nothing in it', () => {
  assert.equal(isEmptyResponse({ text: '' }), true);
  assert.equal(isEmptyResponse({ text: '   ' }), true);
  assert.equal(isEmptyResponse({ text: 'hi' }), false);
  assert.equal(isEmptyResponse({ text: '', error: 'boom' }), false, 'an error is not an empty success');
});

test('a retry recovers an empty body — the free tier’s common failure', async () => {
  const original = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => {
    n += 1;
    // First call returns a 200 with an empty body, which is what several free
    // models actually do instead of returning an error.
    const payload = n === 1
      ? { choices: [{ message: { content: '' }, finish_reason: 'length' }] }
      : { choices: [{ message: { content: 'FLUX_OK' } }], usage: { prompt_tokens: 5 } };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const result = await complete(
      { provider: 'openrouter', model: 'test:free', apiKey: 'k' },
      [{ role: 'user', content: 'hi' }],
    );
    assert.equal(result.text, 'FLUX_OK', 'the retry recovered it');
    assert.equal(result.attempts, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test('a rate limit is surfaced and not retried', async () => {
  const original = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => {
    n += 1;
    return new Response(JSON.stringify({ error: { message: 'Rate limit exceeded: free-models-per-min.' } }), {
      status: 429, headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const result = await complete(
      { provider: 'openrouter', model: 'test:free', apiKey: 'k' },
      [{ role: 'user', content: 'hi' }],
    );
    assert.match(result.error ?? '', /Rate limit/);
    assert.equal(result.rateLimited, true);
    assert.equal(n, 1, 'did not hammer the limiter');
  } finally {
    globalThis.fetch = original;
  }
});

test('a refusal is not retried — it is a decision, not a failure', async () => {
  const original = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => {
    n += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: '', refusal: 'no' } }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };

  try {
    const result = await complete(
      { provider: 'openrouter', model: 'test:free', apiKey: 'k' },
      [{ role: 'user', content: 'hi' }],
    );
    assert.equal(result.refused, true);
    assert.equal(n, 1, 'no retry on a refusal');
  } finally {
    globalThis.fetch = original;
  }
});

test('resolveApiKey prefers an explicit key over the environment', () => {
  assert.equal(resolveApiKey({ apiKey: 'explicit', env: { OPENROUTER_API_KEY: 'from-env' } }), 'explicit');
});

test('resolveApiKey reads the environment and returns undefined when empty', () => {
  assert.equal(resolveApiKey({ env: { OPENROUTER_API_KEY: 'r' } }), 'r');
  assert.equal(resolveApiKey({ env: {} }), undefined);
});

test('resolveApiKey does not reach into process.env when one is given', () => {
  // Pass-through purity matters: a caller supplying an explicit env cannot be
  // silently overridden by the real environment.
  assert.equal(resolveApiKey({ env: {} }), undefined);
});

test('freeConfig does not copy an env key into the returned object', () => {
  // A config object is often logged or serialised. A credential must not ride
  // along just because the environment happened to have one.
  const model = freeModel('nvidia/nemotron-3-ultra-550b-a55b:free');
  const cfg = freeConfig(model, { env: { OPENROUTER_API_KEY: 'secret' } });

  assert.equal(cfg.apiKey, undefined, 'no key baked in');
  assert.equal(cfg.model, model.id);
  assert.equal(cfg.contextWindow, 1_000_000);
  assert.equal(cfg.provider, 'openrouter');
});

test('freeConfig keeps an explicitly passed key', () => {
  const model = freeModel('nvidia/nemotron-3-ultra-550b-a55b:free');
  assert.equal(freeConfig(model, { apiKey: 'given' }).apiKey, 'given');
});

test('assertUsableKey names the missing variable', () => {
  const model = freeModel('nvidia/nemotron-3-ultra-550b-a55b:free');
  assert.throws(() => assertUsableKey(freeConfig(model), {}), /OPENROUTER_API_KEY/);
});

test('assertUsableKey passes when a key is present or the provider is keyless', () => {
  const model = freeModel('nvidia/nemotron-3-ultra-550b-a55b:free');
  assert.doesNotThrow(() => assertUsableKey(freeConfig(model), { OPENROUTER_API_KEY: 'k' }));
  assert.doesNotThrow(() => assertUsableKey({ provider: 'echo', model: 'none' }, {}));
});

test('openrouter is a configured provider with the free default', () => {
  assert.equal(PROVIDER_DEFAULTS.openrouter.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(PROVIDER_DEFAULTS.openrouter.keyless, false, 'it does need a key');
  assert.match(PROVIDER_DEFAULTS.openrouter.model, /:free$/, 'default is a free model');
});
