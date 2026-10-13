import test from 'node:test';
import assert from 'node:assert/strict';

import { CommandRegistry } from '../dist/toolkit/command-registry.js';
import { BRIDGE_COOLDOWN_MS, buildFullRegistry, registryToSpecs } from '../dist/toolkit/registry-full.js';

function fakePctx(over = {}) {
  const sent = [];
  return {
    sent,
    pctx: {
      jid: 'g1@g.us',
      sender: 'u1@s.whatsapp.net',
      args: '',
      argv: [],
      isOwner: false,
      sock: {},
      reply: async (text) => { sent.push({ to: 'chat', text }); },
      replyPrivate: async (text) => { sent.push({ to: 'dm', text }); },
      ...over,
    },
  };
}

test('the full registry is the documented total, with no duplicates', () => {
  const reg = buildFullRegistry();
  // Exact on purpose: this number is the proof that every module made it in.
  // Adding a command means updating it deliberately, not watching it drift.
  // 1790 module commands + the registry's own `menu` and `ai`.
  assert.equal(reg.size, 1792);
  assert.equal(reg.familyCount, 25);
});

test('every bridged spec is shaped for the commands plugin', () => {
  const specs = registryToSpecs(buildFullRegistry());
  assert.equal(specs.length, 1792);
  assert.equal(new Set(specs.map((s) => s.name.toLowerCase())).size, specs.length);
  for (const spec of specs) {
    assert.ok(spec.name, 'unnamed spec');
    assert.ok(spec.description && spec.description.length > 0, `${spec.name} has no menu text`);
    assert.equal(typeof spec.handler, 'function', `${spec.name} has no handler`);
    assert.equal(spec.cooldownMs, BRIDGE_COOLDOWN_MS);
  }
});

test('a bridged transform executes end to end', async () => {
  const specs = registryToSpecs(buildFullRegistry());
  const morsedec = specs.find((s) => s.name === 'morsedec');
  assert.ok(morsedec, 'morsedec is not in the bridged set');
  const { sent, pctx } = fakePctx({ args: '... --- ...', argv: ['...', '---', '...'] });
  await morsedec.handler(pctx);
  assert.deepEqual(sent, [{ to: 'chat', text: 'sos' }]);
});

test('bridged errors go to the sender privately, never the chat', async () => {
  const reg = new CommandRegistry();
  reg.command({
    name: 'always-fails',
    summary: 'test double',
    effect: 'throws on purpose',
    handler: async () => ({ error: 'boom with /secret/path/creds.json inside' }),
  });
  const [spec] = registryToSpecs(reg);
  const { sent, pctx } = fakePctx();
  await spec.handler(pctx);
  assert.deepEqual(sent, [{ to: 'dm', text: 'boom with /secret/path/creds.json inside' }]);
});

test('bridged images ride sendMessage, not reply', async () => {
  const reg = new CommandRegistry();
  const png = Buffer.from([137, 80, 78, 71]);
  const sent = [];
  reg.command({
    name: 'tiny-image',
    summary: 'test double',
    effect: 'returns a buffer',
    handler: async () => ({ image: png }),
  });
  const [spec] = registryToSpecs(reg);
  const fake = {
    jid: 'g1@g.us',
    sender: 'u@s.whatsapp.net',
    args: '',
    argv: [],
    isOwner: false,
    sock: { sendMessage: async (jid, content) => { sent.push([jid, content]); } },
    reply: async () => { throw new Error('reply must not be used for images'); },
    replyPrivate: async () => { throw new Error('replyPrivate must not be used for images'); },
  };
  await spec.handler(fake);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'g1@g.us');
  assert.deepEqual(sent[0][1].image, png);
});

test('per-chat state is shared within a chat and isolated across chats', async () => {
  const reg = new CommandRegistry();
  reg.command({
    name: 'counter',
    summary: 'test double',
    effect: 'counts per chat',
    handler: async (ctx) => {
      const n = Number(ctx.state.get('n') ?? 0) + 1;
      ctx.state.set('n', n);
      return { text: String(n), bare: true };
    },
  });
  const [spec] = registryToSpecs(reg);
  const first = fakePctx({ jid: 'a@g.us' });
  const second = fakePctx({ jid: 'b@g.us' });
  await spec.handler(first.pctx);
  await spec.handler(first.pctx);
  await spec.handler(second.pctx);
  assert.deepEqual(first.sent.map((s) => s.text), ['1', '2']);
  assert.deepEqual(second.sent.map((s) => s.text), ['1']);
});
