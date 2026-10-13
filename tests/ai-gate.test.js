import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { aiGate, AI_BUSY_REPLY } from '../dist/plugins/ai-gate.js';
import { configureAiState, isAwake, isChatPermitted } from '../dist/toolkit/ai-state.js';
import { CommandRegistry } from '../dist/toolkit/command-registry.js';
import { installAiCommands } from '../dist/toolkit/command-ai.js';

const OWNER = '62882017467912@s.whatsapp.net';
const OWNER_SHORT = '62882017467912';
const STRANGER = '999@s.whatsapp.net';
const DM = 'chat1@s.whatsapp.net';
const GROUP = 'chat1@g.us';

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'nyx-ai-gate-'));
  configureAiState(dir);
  return dir;
}

function textMessage(body, { jid = DM, sender = STRANGER, fromMe = false } = {}) {
  return {
    key: { remoteJid: jid, fromMe, participant: sender },
    message: { conversation: body },
  };
}

function mentionMessage(body, { jid = GROUP, sender = STRANGER } = {}) {
  return {
    key: { remoteJid: jid, fromMe: false, participant: sender },
    message: {
      extendedTextMessage: {
        text: body,
        contextInfo: { mentionedJid: ['bot@s.whatsapp.net'] },
      },
    },
  };
}

function gateHarness(options = {}, engineImpl = null) {
  const sent = [];
  const handlers = {};
  const sock = {
    ev: {
      on: (event, fn) => {
        handlers[event] = fn;
        return () => { delete handlers[event]; };
      },
    },
    sendMessage: async (jid, content) => { sent.push([jid, content]); return { key: { id: 'WATEST' } }; },
    user: { id: 'bot@s.whatsapp.net' },
  };
  const calls = [];
  const debugLog = { debug() {}, info() {}, warn() {}, error() {}, child: () => debugLog };
  const plugin = aiGate({
    owners: [OWNER_SHORT],
    prefix: 'flux ',
    sessionDir: sandbox(),
    ...(engineImpl ? { createEngine: engineImpl } : {}),
    ...options,
  });
  plugin.apply({
    sock,
    state: {},
    options: {},
    log: debugLog,
    onDispose: () => {},
  });
  plugin.apply({
    sock,
    state: {},
    options: {},
    log: { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) },
    onDispose: () => {},
  });
  const fire = async (messages) => {
    await handlers['messages.upsert']({ messages });
    await new Promise((r) => setTimeout(r, 30));
  };
  return { sent, fire, calls };
}

const fakeEngine = (calls, result = { sent: true, action: 'reply', text: 'hello human' }) => async () => ({
  respond: async (sock, jid, msg) => {
    calls.push([jid, msg]);
    await sock.sendMessage(jid, { text: result.text });
    return result;
  },
});

test('owner bare word wakes globally, permits the chat, acks once', async () => {
  const { sent, fire } = gateHarness();
  await fire([textMessage('flux', { sender: OWNER })]);
  assert.equal(isAwake(), true);
  assert.equal(isChatPermitted(DM), true);
  assert.equal(sent.length, 1);
  assert.match(sent[0][1].text, /awake/i);
  await fire([textMessage('FLUX', { sender: OWNER })]);
  assert.equal(sent.length, 1, 'repeat wake word stays silent when nothing changed');
});

test('stranger bare word is met with silence, never a denial', async () => {
  const { sent, fire } = gateHarness();
  await fire([textMessage('flux', { sender: STRANGER })]);
  assert.equal(isAwake(), false);
  assert.deepEqual(sent, []);
});

test('prefixed commands pass through untouched for the router', async () => {
  const { sent, fire } = gateHarness();
  await fire([textMessage('flux ai on', { sender: OWNER })]);
  await fire([textMessage('flux menu', { sender: OWNER })]);
  assert.deepEqual(sent, [], 'gate must never answer what the router owns');
  assert.equal(isAwake(), false, 'command-looking text must not wake');
});

test('ambient DM replies when awake and permitted', async () => {
  const calls = [];
  const { sent, fire } = gateHarness({}, fakeEngine(calls));
  await fire([textMessage('flux', { sender: OWNER })]);
  sent.length = 0;
  await fire([textMessage('hello there', { sender: STRANGER })]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], DM);
  assert.equal(sent.length, 1);
});

test('asleep chats and unpermitted chats stay silent', async () => {
  const calls = [];
  const { sent, fire } = gateHarness({}, fakeEngine(calls));
  await fire([textMessage('hello?', { sender: STRANGER })]);
  assert.equal(calls.length, 0);
  assert.deepEqual(sent, []);
});

test('groups answer only when addressed', async () => {
  const calls = [];
  const { sent, fire } = gateHarness({}, fakeEngine(calls));
  await fire([textMessage('flux', { sender: OWNER, jid: GROUP })]);
  sent.length = 0;
  await fire([textMessage('random chatter', { sender: STRANGER, jid: GROUP })]);
  assert.equal(calls.length, 0, 'unaddressed group chatter must not trigger');
  await fire([mentionMessage('@bot hello', { sender: STRANGER })]);
  assert.equal(calls.length, 1);
});

test('model failure answers the exact busy line', async () => {
  const { sent, fire } = gateHarness({}, async () => ({
    respond: async () => ({ sent: false, action: 'error', text: '' }),
  }));
  await fire([textMessage('flux', { sender: OWNER })]);
  sent.length = 0;
  await fire([textMessage('hello?', { sender: STRANGER })]);
  assert.deepEqual(sent.map(([, content]) => content.text), [AI_BUSY_REPLY]);
  assert.equal(AI_BUSY_REPLY, 'flux is busy try again');
});

test('own messages never trigger, even matching ones', async () => {
  const calls = [];
  const { sent, fire } = gateHarness({}, fakeEngine(calls));
  await fire([textMessage('flux', { sender: OWNER, fromMe: true })]);
  assert.equal(isAwake(), false);
  assert.deepEqual(sent, []);
  assert.equal(calls.length, 0);
});

test('ai command: on/off gated to owner, status public', async () => {
  sandbox();
  const reg = new CommandRegistry();
  installAiCommands(reg);
  const run = (args, isOwner) => reg.run({}, 'd@s.whatsapp.net', 'ai', args, {
    state: new Map(), isOwner, sender: 'x',
  });
  let r = await run('on', true);
  assert.match(r.text ?? '', /awake/);
  r = await run('on', false);
  assert.match(r.error ?? '', /owner/i);
  r = await run('status', false);
  assert.match(r.text ?? '', /awake/);
  r = await run('off', false);
  assert.match(r.error ?? '', /owner/i);
  r = await run('off', true);
  assert.match(r.text ?? '', /asleep/);
});

test('ai command: permit cycle is owner-only and exact', async () => {
  sandbox();
  const reg = new CommandRegistry();
  installAiCommands(reg);
  const run = (args, isOwner) => reg.run({}, 'd@s.whatsapp.net', 'ai', args, {
    state: new Map(), isOwner, sender: 'x',
  });
  let r = await run('permit 081234567890', false);
  assert.match(r.error ?? '', /owner/i);
  r = await run('permit 081234567890', true);
  assert.match(r.text ?? '', /Permitted/);
  r = await run('permits', true);
  assert.match(r.text ?? '', /081234567890/);
  r = await run('unpermit 081234567890', true);
  assert.match(r.text ?? '', /Unpermitted/);
  r = await run('permits', true);
  assert.match(r.text ?? '', /No permitted/);
  r = await run('bogus', true);
  assert.match(r.text ?? '', /Usage/);
});
