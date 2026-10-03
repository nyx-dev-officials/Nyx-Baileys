/**
 * Command router.
 *
 * Guards, cooldowns, scoping and the category menu. Dispatch is async (the
 * plugin runs handlers with `void`), so every assertion flushes a tick first.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { commands, tokenize, toUser } from '../dist/plugins/commands.js';

import { applyPlugin, fakeSocket, flush, upsert, wmMessage } from './helpers.js';

const DM = '15551234567@s.whatsapp.net';
const GROUP = '123-456@g.us';
const MEMBER = '999@s.whatsapp.net';

function rig(options = {}) {
  const sock = fakeSocket();
  const harness = applyPlugin(commands({ dmsOnly: true, ...options }), sock);
  return { sock, commands: sock.commands, ...harness };
}

const say = (sock, text, { jid = DM, participant } = {}) =>
  upsert(sock, [wmMessage({ jid, id: `m-${text}-${jid}`, message: { conversation: text }, ...(participant ? { participant } : {}) })]);

const lastText = (sock) => sock.sent[sock.sent.length - 1]?.content?.text;

/* ── basics ──────────────────────────────────────────────────────────── */

test('a command is dispatched by name and can reply', async () => {
  const { sock } = rig();
  sock.commands.register({ name: 'ping', handler: (c) => c.reply('pong') });

  say(sock, '/ping');
  await flush();

  assert.equal(sock.sent.length, 1);
  assert.equal(lastText(sock), 'pong');
});

test('aliases resolve to the same command', async () => {
  const { sock } = rig();
  sock.commands.register({ name: 'ping', aliases: ['p', 'pg'], handler: (c) => c.reply('pong') });

  say(sock, '/p');
  await flush();
  assert.equal(lastText(sock), 'pong');
});

test('tokenize honours quotes and toUser normalises numbers', () => {
  assert.deepEqual(tokenize('a "b c" \'d e\''), ['a', 'b c', 'd e']);
  assert.equal(toUser('+1 (555) 123-4567'), '15551234567@s.whatsapp.net');
  assert.equal(toUser('15551234567@s.whatsapp.net'), '15551234567@s.whatsapp.net');
});

test('an unknown command falls through to the fallback', async () => {
  const seen = [];
  const { sock } = rig({ fallback: (c) => seen.push(c.name) });
  say(sock, '/nope');
  await flush();
  assert.deepEqual(seen, ['nope']);
});

test('names and handlers are surfaced from the registry', async () => {
  const { sock } = rig();
  sock.commands.register({ name: 'alpha', category: 'tools', description: 'a', handler: () => {} });
  sock.commands.register({ name: 'beta', hidden: true, handler: () => {} });

  assert.equal(sock.commands.has('alpha'), true);
  assert.equal(sock.commands.get('beta')?.name, 'beta');
  assert.deepEqual(sock.commands.categories().sort(), ['general', 'tools']);
  assert.equal(sock.commands.help().includes('alpha'), true);
  assert.equal(sock.commands.help().includes('beta'), false, 'hidden commands stay out of help');
});

/* ── menu ────────────────────────────────────────────────────────────── */

test('/menu renders commands grouped by category', async () => {
  const { sock } = rig();
  sock.commands.register({ name: 'ping', category: 'tools', description: 'health check', handler: () => {} });
  sock.commands.register({ name: 'hi', category: 'social', description: 'greet', handler: () => {} });

  say(sock, '/menu');
  await flush();

  const text = lastText(sock);
  assert.match(text, /TOOLS/);
  assert.match(text, /SOCIAL/);
  assert.match(text, /ping/);
  assert.match(text, /hi/);

  const sections = sock.commands.menuSections();
  assert.deepEqual(sections.map((s) => s.category), ['social', 'tools']);
});

/* ── guards ──────────────────────────────────────────────────────────── */

test('ownerOnly admits the owner and rejects everyone else', async () => {
  const { sock } = rig({ owners: ['15551234567'] });
  sock.commands.register({ name: 'secret', ownerOnly: true, handler: (c) => c.reply('ok') });

  say(sock, '/secret');
  await flush();
  assert.equal(lastText(sock), 'ok', 'owner admitted');

  say(sock, '/secret', { jid: '300@s.whatsapp.net' });
  await flush();
  const texts = sock.sent.map((e) => e.content.text);
  assert.ok(texts.some((t) => /owner-only/i.test(t)), 'non-owner denied with the owner message');
});

test('groupOnly is refused in a private chat', async () => {
  const { sock } = rig();
  sock.commands.register({ name: 'everyone', groupOnly: true, handler: (c) => c.reply('guarded') });

  say(sock, '/everyone');
  await flush();
  assert.match(lastText(sock), /only works in a group/i);
});

test('adminsOnly resolves group metadata', async () => {
  const { sock } = rig({ dmsOnly: false, groups: true });
  sock.groupMetadata = async () => ({ participants: [{ id: MEMBER, admin: 'admin' }] });
  sock.commands.register({ name: 'kick', adminsOnly: true, handler: (c) => c.reply('kicked') });

  say(sock, '/kick', { jid: GROUP, participant: MEMBER });
  await flush();
  assert.equal(lastText(sock), 'kicked', 'admin admitted');

  say(sock, '/kick', { jid: GROUP, participant: '777@s.whatsapp.net' });
  await flush();
  assert.match(lastText(sock), /group admins/i, 'plain member denied');
});

/* ── cooldown ────────────────────────────────────────────────────────── */

test('a per-command cooldown blocks a rapid second call', async () => {
  let clock = 1_000_000;
  const { sock } = rig({ now: () => clock });
  let runs = 0;
  sock.commands.register({ name: 'slow', cooldownMs: 5_000, handler: (c) => { runs += 1; return c.reply('ran'); } });

  say(sock, '/slow');
  await flush();
  assert.equal(runs, 1);

  clock += 100;
  say(sock, '/slow');
  await flush();
  assert.equal(runs, 1, 'still on cooldown');
  assert.match(lastText(sock), /cooldown/i);

  clock += 6_000;
  say(sock, '/slow');
  await flush();
  assert.equal(runs, 2, 'cooldown expired');
});

/* ── invoke ──────────────────────────────────────────────────────────── */

test('invoke runs a command directly, bypassing the prefix', async () => {
  const { sock } = rig();
  sock.commands.register({ name: 'echo', handler: (c) => c.reply(c.args) });

  await sock.commands.invoke(DM, DM, 'echo hello world');
  assert.equal(lastText(sock), 'hello world');
});

test('invoke refuses an owner-only command for a non-owner', async () => {
  const { sock } = rig({ owners: ['15551234567'] });
  sock.commands.register({ name: 'secret', ownerOnly: true, handler: (c) => c.reply('ok') });

  await assert.rejects(() => sock.commands.invoke(DM, '300@s.whatsapp.net', 'secret'), /permission denied/);
});
