import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chatOps } from '../dist/plugins/chat-ops.js';

import { applyPlugin, fakeSocket } from './helpers.js';

const GROUP = '120363412414250458@g.us';
const USER = '62882017467912@s.whatsapp.net';

/**
 * `fakeSocket` has no `chatModify`, so the rig supplies one that records the
 * exact modification object. That is the whole point of these tests: rc14's
 * `chatModify` is a discriminated union, and the shape sent is what matters.
 */
function rig(options = {}) {
  const sock = fakeSocket();
  const calls = [];
  sock.chatModify = async (mod, jid) => { calls.push([mod, jid]); };
  sock.groupMetadata = async (jid) => ({
    id: jid,
    subject: 'Nyx-Baileys Test',
    desc: 'a description',
    owner: '6283831459585@s.whatsapp.net',
    participants: [{ id: USER }, { id: '6283831459585@s.whatsapp.net' }],
    creation: 1700000000,
    inviteCode: 'ABC123',
  });
  sock.groupUpdateSubject = async () => {};
  sock.groupUpdateDescription = async () => {};
  sock.groupInviteCode = async () => 'ABC123';
  sock.groupRevokeInvite = async () => {};

  sock.chatModify = Object.assign(sock.chatModify, { calls });
  const harness = applyPlugin(chatOps(options), sock);
  return { sock, calls, ...harness };
}

test('the surface attaches', () => {
  const { sock } = rig();
  assert.ok(sock.chatOps);
  for (const op of ['metadata', 'updateSubject', 'updateDescription', 'inviteLink',
    'revokeInvite', 'setMute', 'setArchive', 'setPin', 'setStar',
    'setLabel', 'clearChat', 'markRead']) {
    assert.equal(typeof sock.chatOps[op], 'function', `${op} is missing`);
  }
});

test('chatOps is non-enumerable', () => {
  const { sock } = rig();
  assert.equal(Object.keys(sock).includes('chatOps'), false);
  assert.equal(Object.getOwnPropertyDescriptor(sock, 'chatOps').enumerable, false);
});

/* -- group operations ----------------------------------------------------- */

test('metadata is summarised, not returned raw', async () => {
  const { sock } = rig();
  const meta = await sock.chatOps.metadata(GROUP);
  assert.equal(meta.subject, 'Nyx-Baileys Test');
  assert.equal(meta.participants, 2);
  assert.equal(meta.inviteCode, 'ABC123');
});

test('metadata is cached, and fresh:true bypasses it', async () => {
  let calls = 0;
  const sock = fakeSocket();
  sock.chatModify = async () => {};
  sock.groupMetadata = async (jid) => { calls += 1; return { id: jid, subject: `s${calls}` }; };
  applyPlugin(chatOps({ metadataCacheMs: 60_000 }), sock);

  assert.equal((await sock.chatOps.metadata(GROUP)).subject, 's1');
  assert.equal((await sock.chatOps.metadata(GROUP)).subject, 's1', 'cached');
  assert.equal(calls, 1);
  assert.equal((await sock.chatOps.metadata(GROUP, true)).subject, 's2', 'fresh bypasses');
  assert.equal(calls, 2);
});

test('a non-group jid is refused before it reaches the socket', async () => {
  const { sock } = rig();
  await assert.rejects(() => sock.chatOps.metadata(USER), /not a group/);
  await assert.rejects(() => sock.chatOps.updateSubject(USER, 'x'), /not a group/);
  await assert.rejects(() => sock.chatOps.inviteLink(USER), /not a group/);
});

test('an empty group subject is refused', async () => {
  const { sock } = rig();
  await assert.rejects(() => sock.chatOps.updateSubject(GROUP, '   '), /subject is required/);
});

test('an invite link is built from the code', async () => {
  const { sock } = rig();
  assert.equal(await sock.chatOps.inviteLink(GROUP), 'https://chat.whatsapp.com/ABC123');
});

test('a missing invite code fails loudly rather than producing /undefined', async () => {
  // The failure this guards: groupInviteCode leaves the code undefined for a
  // group this account cannot invite into, and concatenating that yields a link
  // that looks valid and is not.
  const sock = fakeSocket();
  sock.chatModify = async () => {};
  sock.groupMetadata = async (jid) => ({ id: jid, subject: 'x', participants: [] });
  sock.groupInviteCode = async () => undefined;
  applyPlugin(chatOps(), sock);

  await assert.rejects(() => sock.chatOps.inviteLink(GROUP), /no invite code/);
});

test('an absent code triggers a fetch rather than giving up', async () => {
  let asked = 0;
  const sock = fakeSocket();
  sock.chatModify = async () => {};
  sock.groupMetadata = async (jid) => ({ id: jid, subject: 'x', participants: [] });
  sock.groupInviteCode = async () => { asked += 1; return 'LATE1'; };
  applyPlugin(chatOps(), sock);

  assert.equal(await sock.chatOps.inviteLink(GROUP), 'https://chat.whatsapp.com/LATE1');
  assert.equal(asked, 1, 'the invite must be requested when metadata carries no code');
});

test('updating the subject invalidates the cached metadata', async () => {
  let subject = 'before';
  const sock = fakeSocket();
  sock.chatModify = async () => {};
  sock.groupMetadata = async (jid) => ({ id: jid, subject, participants: [] });
  sock.groupUpdateSubject = async (_jid, s) => { subject = s; };
  applyPlugin(chatOps({ metadataCacheMs: 60_000 }), sock);

  assert.equal((await sock.chatOps.metadata(GROUP)).subject, 'before');
  await sock.chatOps.updateSubject(GROUP, 'after');
  assert.equal((await sock.chatOps.metadata(GROUP)).subject, 'after', 'cache was stale');
});

test('an empty description clears it rather than failing', async () => {
  const { sock } = rig();
  await sock.chatOps.updateDescription(GROUP, '');
  // No assertion on a mock: the point is that it does not throw, because
  // clearing a description is a legitimate operation.
});

/* -- the union: one shape per call --------------------------------------- */

test('mute sends an absolute timestamp, or null to unmute', async () => {
  const { sock, calls } = rig();
  await sock.chatOps.setMute(USER, 60_000);
  const mod = calls.at(-1)[0];
  assert.equal(Object.keys(mod).length, 1, 'exactly one union member');
  assert.ok(mod.mute > Date.now(), 'rc14 takes an absolute expiry, not a duration');

  await sock.chatOps.setMute(USER, null);
  assert.equal(calls.at(-1)[0].mute, null);
});

test('a non-positive mute duration is refused', async () => {
  const { sock } = rig();
  await assert.rejects(() => sock.chatOps.setMute(USER, 0), /positive duration/);
});

test('archive, pin and clear each send one shape', async () => {
  const { sock, calls } = rig();
  await sock.chatOps.setArchive(USER, true);
  assert.deepEqual(Object.keys(calls.at(-1)[0]).sort(), ['archive', 'lastMessages']);

  await sock.chatOps.setPin(USER, true);
  assert.deepEqual(Object.keys(calls.at(-1)[0]), ['pin'], 'pin alone — no lastMessages');

  await sock.chatOps.clearChat(USER);
  assert.equal(calls.at(-1)[0].clear, true);
});

test('two settings are never combined into one call', async () => {
  // The bug this design prevents: `{ archive: true, pin: true }` matches no
  // member of rc14's union and it picks a branch without complaining.
  const { sock, calls } = rig();
  await sock.chatOps.setArchive(USER, true);
  await sock.chatOps.setPin(USER, true);

  for (const [mod] of calls) {
    const keys = Object.keys(mod).filter((k) => k !== 'lastMessages');
    assert.ok(keys.length <= 1, `combined ${keys.join('+')} into one chatModify`);
  }
});

/* -- star: a chatModification, not a message ------------------------------ */

test('star goes through chatModify, not sendMessage', async () => {
  const { sock, calls } = rig();
  await sock.chatOps.setStar(USER, { id: 'MSG1', fromMe: true }, true);

  const mod = calls.at(-1)[0];
  assert.equal(mod.star.star, true);
  assert.deepEqual(mod.star.messages, [{ id: 'MSG1', fromMe: true }]);
  assert.equal(sock.sent.length, 0, 'must not be sent as a message content key');
});

test('starring without a message id is refused', async () => {
  const { sock } = rig();
  await assert.rejects(() => sock.chatOps.setStar(USER, {}, true), /message id is required/);
});

test('a label requires a labelId', async () => {
  const { sock, calls } = rig();
  await assert.rejects(() => sock.chatOps.setLabel(USER, ''), /labelId is required/);
  await sock.chatOps.setLabel(USER, 'lbl-1');
  assert.deepEqual(calls.at(-1)[0].addChatLabel, { labelId: 'lbl-1' });
});

test('an empty jid is refused on every entry point', async () => {
  const { sock } = rig();
  for (const fn of [
    () => sock.chatOps.setArchive('', true),
    () => sock.chatOps.setPin('', true),
    () => sock.chatOps.markRead(''),
  ]) {
    await assert.rejects(fn, /jid is required/);
  }
});