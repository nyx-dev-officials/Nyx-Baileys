import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FLUX_PREFIX } from '../dist/index.js';
import { commands } from '../dist/plugins/commands.js';
import { FileSessionStore } from '../dist/core/session-store.js';
import { CommandRegistry } from '../dist/toolkit/command-registry.js';
import { buildFullRegistry, registryToSpecs } from '../dist/toolkit/registry-full.js';

function fakeLog() {
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  return { ...log, child: () => fakeLog() };
}

function fakeSock() {
  const handlers = {};
  const sent = [];
  const sock = {
    ev: {
      on: (event, fn) => {
        handlers[event] = fn;
        return () => { delete handlers[event]; };
      },
    },
    sendMessage: async (jid, content) => { sent.push([jid, content]); },
    user: { id: 'bot@s.whatsapp.net' },
  };
  return { handlers, sent, sock };
}

async function applyPlugin(specs) {
  const dir = mkdtempSync(join(tmpdir(), 'nyx-handoff-'));
  const { sock, sent, handlers } = fakeSock();
  const plugin = commands({ prefix: FLUX_PREFIX, groups: false, owners: [] });
  await plugin.apply({
    sock,
    state: new FileSessionStore({ dir }),
    options: {},
    log: fakeLog(),
    onDispose: () => {},
  });
  const surface = sock.commands;
  assert.ok(surface, 'commands plugin did not attach a surface');
  for (const spec of specs) surface.register(spec);
  return {
    surface,
    sent,
    handlers,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('the operator prefix is the shared flux default', () => {
  assert.equal(FLUX_PREFIX, 'flux ');
});

test('a bridged registry command answers through the real plugin', async () => {
  const specs = registryToSpecs(buildFullRegistry());
  const ctx = await applyPlugin([specs.find((s) => s.name === 'morsedec')]);
  try {
    await ctx.surface.invoke('g1@g.us', 'u@s.whatsapp.net', 'morsedec ... --- ...');
    assert.deepEqual(ctx.sent, [[ 'g1@g.us', { text: 'sos' } ]]);
  } finally {
    ctx.cleanup();
  }
});

test('plugin-level state isolates chats across invocations', async () => {
  const reg = new CommandRegistry();
  reg.command({
    name: 'handoff-counter',
    summary: 'test double',
    effect: 'counts per chat',
    handler: async (ctx) => {
      const n = Number(ctx.state.get('n') ?? 0) + 1;
      ctx.state.set('n', n);
      return { text: String(n), bare: true };
    },
  });
  const ctx = await applyPlugin(registryToSpecs(reg));
  try {
    await ctx.surface.invoke('a@g.us', 'u@s.whatsapp.net', 'handoff-counter');
    await ctx.surface.invoke('a@g.us', 'u@s.whatsapp.net', 'handoff-counter');
    await ctx.surface.invoke('b@g.us', 'u@s.whatsapp.net', 'handoff-counter');
    assert.deepEqual(ctx.sent.map(([, content]) => content.text), ['1', '2', '1']);
  } finally {
    ctx.cleanup();
  }
});

test('a failing bridged command replies privately through the plugin', async () => {
  const reg = new CommandRegistry();
  reg.command({
    name: 'handoff-failer',
    summary: 'test double',
    effect: 'fails on purpose',
    handler: async () => ({ error: 'nope' }),
  });
  const ctx = await applyPlugin(registryToSpecs(reg));
  try {
    // replyPrivate targets the sender, not the chat.
    await ctx.surface.invoke('g1@g.us', 'sender@s.whatsapp.net', 'handoff-failer');
    assert.deepEqual(ctx.sent, [[ 'sender@s.whatsapp.net', { text: 'nope' } ]]);
  } finally {
    ctx.cleanup();
  }
});
