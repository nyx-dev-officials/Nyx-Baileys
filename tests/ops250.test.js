/**
 * OPS-250 — payload-shape tests for the eight new modules.
 *
 * These prove argument order and guard behaviour against a recording socket.
 * They do NOT prove hardware behaviour: every function here is `unverified`
 * on the wire, and docs/VERIFICATION.md says so explicitly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  upsertLabel, createLabel, deleteLabel, addChatLabel, removeChatLabel,
  addMessageLabel, removeMessageLabel, setMemberLabel, setOnlyChatLabel,
  toggleChatLabel, assertLabelBody, setLinkPreviews, stripUrls, hasLink,
} from '../dist/toolkit/ops-250/labels.js';

import {
  communityMeta, createCommunity, leaveCommunity, renameCommunity, linkGroup,
  unlinkGroup, addCommunityMembers, removeCommunityMembers, promoteCommunityMembers,
  demoteCommunityMembers, setCommunitySetting, setCommunityMemberAdd,
  setCommunityJoinApproval, readCommunityPolicy, isCommunity,
} from '../dist/toolkit/ops-250/communities.js';

import {
  fetchHistory, pageHistory, usync, usyncDevices, fetchStatuses, subscribePresence,
  subscribeMany, botList, mediaHost, refreshMedia, nextTag, sendNode, sendRaw,
  sendReceiptFor, sendReceiptsFor, ackMessage, queryNode, serverProperties,
  requestResend, decodeJid, encodeJid, toDigits, looksLikePhone,
} from '../dist/toolkit/ops-250/history-protocol.js';

import {
  inspectInvite, acceptInviteV4, revokeInviteV4, acceptInviteLegacy, joinByInvite,
  inviteCodeFromLink, inviteLink, memberPage, fullRoster, allGroups, leaveGroup,
  createGroup, countAdmins, groupSize, amAdmin, setCoverPhoto, clearCoverPhoto,
  setBusinessProfile, pictureUrl, memberLabels,
} from '../dist/toolkit/ops-250/group-extensions.js';

import {
  waitForOpen, waitForUpdate, waitForMessage, onEnd, onError, closeSocket,
  logoutAndWipe, needsPreKeyUpload, ensurePreKeys, rotatePreKey, keyDigest,
  isFullyPaired, sessionTag, retryWithBackoff, requestRetry, sendWithFallback,
  isTransient, retryIfTransient, applyServerOffset, cleanDirty, resync,
  sendUnifiedSession, reachoutDelay,
} from '../dist/toolkit/ops-250/session-reliability.js';

import {
  styleText, oneLine, truncateText, textWordCount, splitText, escapeMarkup,
  codeBlock, replyTo, mention, mentionText, location, poll, reaction, unreact,
  contactCard, pinChat, archiveChat, starSingleMessage, validateMessage,
  assertValidMessage, randomKey,
} from '../dist/toolkit/ops-250/message-builders.js';

import {
  STUB_TYPES, isRevoke, isAnnounceBounce, isAdminRevoke, isProtocolMessage,
  isOutgoing, senderOf, chatOf, keyOf, MEDIA_MESSAGE_KEYS, mediaKeyOf, firstMedia,
  hasMedia, isVoiceNote, isSticker, isEphemeral, interactiveOf, isQuickReplyReply,
  selectedReply, isListReply, listTitleOf, revokedKeyOf, isEdit, editedText,
  reactionOf, isReactionRemoval, messagesOf, isProcessable, processable,
  onProcessable,
} from '../dist/toolkit/ops-250/inbound-parsing.js';

import {
  fetchNewsletterMessages, subscribeNewsletter, reactNewsletter, newsletterAdmins,
  transferNewsletter, demoteNewsletterAdmin, newsletterRename, newsletterDescribe,
  uploadMedia, ack, upsertLocal, moderate, deleteForEveryone, banParticipant,
  promoteParticipant, demoteParticipant, removeParticipant, confirmDestructive,
} from '../dist/toolkit/ops-250/newsletter-moderation.js';

const GROUP = '120363000000000000@g.us';
const USER = '62882017467912@s.whatsapp.net';

function rig(extra = {}) {
  const calls = [];
  const sock = {
    calls,
    user: { id: '6283831459585:12@s.whatsapp.net' },
    authState: async () => ({ creds: { registered: true, noiseKey: {}, me: { id: '628@s.whatsapp.net' }, preKeyId: 7 } }),
    async chatModify(...a) { calls.push(['chatModify', ...a]); },
    async sendMessage(...a) { calls.push(['sendMessage', ...a]); return { key: { id: 'X' } }; },
    ...extra,
  };
  return sock;
}

/* ══ labels ══════════════════════════════════════════════════════ */

test('createLabel sends a name and colour', async () => {
  const sock = rig({ async addLabel(...a) { sock.calls.push(['addLabel', ...a]); } });
  await createLabel(sock, USER, 'Work', 2);
  assert.deepEqual(sock.calls.at(-1), ['addLabel', USER, { name: 'Work', color: 2 }]);
});

test('deleteLabel carries delete:true with the id', async () => {
  const sock = rig({ async addLabel(...a) { sock.calls.push(['addLabel', ...a]); } });
  await deleteLabel(sock, USER, 'L1');
  assert.deepEqual(sock.calls.at(-1), ['addLabel', USER, { delete: true, id: 'L1' }]);
});

test('chat and message labels pass id and messageId in position', async () => {
  const sock = rig({
    async addChatLabel(...a) { sock.calls.push(['addChatLabel', ...a]); },
    async removeChatLabel(...a) { sock.calls.push(['removeChatLabel', ...a]); },
    async addMessageLabel(...a) { sock.calls.push(['addMessageLabel', ...a]); },
    async removeMessageLabel(...a) { sock.calls.push(['removeMessageLabel', ...a]); },
  });
  await addChatLabel(sock, USER, 'L1');
  await removeChatLabel(sock, USER, 'L1');
  await addMessageLabel(sock, USER, 'M1', 'L2');
  await removeMessageLabel(sock, USER, 'M1', 'L2');
  assert.deepEqual(sock.calls.map((c) => c[0]),
    ['addChatLabel', 'removeChatLabel', 'addMessageLabel', 'removeMessageLabel']);
  assert.deepEqual(sock.calls[2], ['addMessageLabel', USER, 'M1', 'L2']);
});

test('setMemberLabel returns the resulting label string', async () => {
  const sock = rig({ async updateMemberLabel(...a) { sock.calls.push(['updateMemberLabel', ...a]); return 'VIP'; } });
  assert.equal(await setMemberLabel(sock, GROUP, 'VIP'), 'VIP');
  assert.deepEqual(sock.calls.at(-1), ['updateMemberLabel', GROUP, 'VIP']);
});

test('setOnlyChatLabel removes before adding', async () => {
  const sock = rig({
    async addChatLabel(...a) { sock.calls.push(['addChatLabel', ...a]); },
    async removeChatLabel(...a) { sock.calls.push(['removeChatLabel', ...a]); },
  });
  await setOnlyChatLabel(sock, USER, 'L1');
  assert.deepEqual(sock.calls.map((c) => c[0]), ['removeChatLabel', 'addChatLabel']);
});

test('toggleChatLabel picks the verb from the boolean', async () => {
  const sock = rig({
    async addChatLabel(...a) { sock.calls.push(['addChatLabel', ...a]); },
    async removeChatLabel(...a) { sock.calls.push(['removeChatLabel', ...a]); },
  });
  await toggleChatLabel(sock, USER, 'L1', true);
  await toggleChatLabel(sock, USER, 'L1', false);
  assert.deepEqual(sock.calls.map((c) => c[0]), ['addChatLabel', 'removeChatLabel']);
});

test('assertLabelBody rejects a label with no name', () => {
  assert.throws(() => assertLabelBody({}), /name/);
  assert.throws(() => assertLabelBody({ color: 1 }), /name/);
  assert.doesNotThrow(() => assertLabelBody({ delete: true }));
  assert.doesNotThrow(() => assertLabelBody({ name: 'ok' }));
});

test('link previews: disabled means the negated flag', async () => {
  const sock = rig({ async updateDisableLinkPreviewsPrivacy(v) { sock.calls.push(['previews', v]); } });
  await setLinkPreviews(sock, false);
  await setLinkPreviews(sock, true);
  assert.deepEqual(sock.calls.map((c) => c[1]), [true, false]);
});

test('stripUrls removes links and collapses the gap', () => {
  assert.equal(stripUrls('see https://x.com now'), 'see now');
  assert.equal(hasLink('a http://x.com'), true);
  assert.equal(hasLink('no links'), false);
});

/* ══ communities ═════════════════════════════════════════════════ */

test('community members use the community verb, not the group one', async () => {
  const sock = rig({
    async communityRequestParticipantsUpdate(...a) { sock.calls.push(['cUpdate', ...a]); },
  });
  await addCommunityMembers(sock, 'x@community', ['a@s']);
  await removeCommunityMembers(sock, 'x@community', ['a@s']);
  await demoteCommunityMembers(sock, 'x@community', ['a@s']);
  // cUpdate receives (communityJid, participants, action) — index 3 is the verb.
  assert.deepEqual(sock.calls.map((c) => c[3]), ['add', 'remove', 'demote']);
});

test('promoteCommunityMembers carries the rank fourth', async () => {
  const sock = rig({ async communityRequestParticipantsUpdate(...a) { sock.calls.push(['cUpdate', ...a]); } });
  await promoteCommunityMembers(sock, 'x@community', ['a@s'], 'superadmin');
  assert.deepEqual(sock.calls.at(-1), ['cUpdate', 'x@community', ['a@s'], 'promote', 'superadmin']);
});

test('linkGroup refuses a non-group jid', async () => {
  const sock = rig({ async communityLinkGroup(...a) { sock.calls.push(['link', ...a]); } });
  // linkGroup is synchronous, so the throw is immediate — not a rejection.
  assert.throws(() => linkGroup(sock, 'x@community', USER), /not a group jid/);
  assert.equal(sock.calls.length, 0, 'the refused call wrote nothing');
  linkGroup(sock, 'x@community', GROUP);
  assert.deepEqual(sock.calls.at(-1), ['link', 'x@community', GROUP]);
});

test('community policy verbs map to the on/off words rc14 expects', async () => {
  const sock = rig({
    async communityMemberAddMode(...a) { sock.calls.push(['add', ...a]); },
    async communityJoinApprovalMode(...a) { sock.calls.push(['approval', ...a]); },
    async communitySettingUpdate(...a) { sock.calls.push(['setting', ...a]); },
  });
  await setCommunityMemberAdd(sock, 'x@community', true);
  await setCommunityMemberAdd(sock, 'x@community', false);
  await setCommunityJoinApproval(sock, 'x@community', true);
  await setCommunitySetting(sock, 'x@community', 'announce');
  assert.deepEqual(sock.calls.map((c) => [c[0], c[2]]),
    [['add', 'on'], ['add', 'off'], ['approval', 'on'], ['setting', 'announce']]);
});

test('readCommunityPolicy normalises unset memberAddMode to true', async () => {
  const sock = rig({
    async communityMetadata() { return { announce: true, ephemeralDuration: 86_400, size: 12 }; },
  });
  const policy = await readCommunityPolicy(sock, 'x@community');
  assert.equal(policy.announce, true);
  assert.equal(policy.memberAddMode, true, 'absent means allowed');
  assert.equal(policy.ephemeral, 86_400);
  assert.equal(policy.size, 12);
});

test('isCommunity swallows a metadata failure as false', async () => {
  const sock = rig({ async communityMetadata() { throw new Error('not found'); } });
  assert.equal(await isCommunity(sock, 'x@community'), false);
});

/* ══ history and protocol ════════════════════════════════════════ */

test('fetchHistory passes count first, then the optional key', async () => {
  const sock = rig({ async fetchMessageHistory(...a) { sock.calls.push(['history', ...a]); return []; } });
  const key = { id: 'k', remoteJid: USER };
  await fetchHistory(sock, 50, key, 1234);
  assert.deepEqual(sock.calls.at(-1), ['history', 50, key, 1234]);
});

test('pageHistory stops on an empty page instead of looping', async () => {
  let calls = 0;
  const sock = rig({
    async fetchMessageHistory(...a) {
      sock.calls.push(['history', ...a]);
      calls += 1;
      return calls === 1
        ? [{ key: { id: 'm1', remoteJid: USER }, messageTimestamp: 1, paginationCursors: { after: 'C1' } }]
        : [];
    },
  });
  const out = await pageHistory(sock, USER, 100);
  assert.equal(out.length, 1);
  assert.equal(calls, 2);
});

test('pageHistory bounds itself at the requested total', async () => {
  const sock = rig({
    async fetchMessageHistory(size) {
      return Array.from({ length: size }, (_, i) => ({
        key: { id: `m${i}`, remoteJid: USER }, messageTimestamp: i, paginationCursors: { after: `C${i}` },
      }));
    },
  });
  const out = await pageHistory(sock, USER, 30, 10);
  assert.equal(out.length, 30);
});

test('subscribeMany fires one call per jid', async () => {
  const sock = rig({ async presenceSubscribe(j) { sock.calls.push(['sub', j]); return j; } });
  await subscribeMany(sock, ['a@s', 'b@s']);
  assert.deepEqual(sock.calls.map((c) => c[1]), ['a@s', 'b@s']);
});

test('fetchStatuses spreads the jids variadically', async () => {
  const sock = rig({ async fetchStatus(...a) { sock.calls.push(['status', ...a]); return []; } });
  await fetchStatuses(sock, ['a@s', 'b@s']);
  assert.deepEqual(sock.calls.at(-1), ['status', 'a@s', 'b@s']);
});

test('raw protocol calls pass nodes through untouched', async () => {
  const sock = rig({
    async sendNode(...a) { sock.calls.push(['node', ...a]); },
    async sendRawMessage(...a) { sock.calls.push(['raw', ...a]); },
    async query(...a) { sock.calls.push(['query', ...a]); },
    async sendMessageAck(...a) { sock.calls.push(['ack', ...a]); },
    generateMessageTag: () => 'TAG1',
    async serverProps() { return { props: 1 }; },
  });
  await sendNode(sock, { tag: 'iq' }, 5000);
  await sendRaw(sock, Buffer.from([1]), { query: false });
  await queryNode(sock, 'T1', { tag: 'iq' });
  await ackMessage(sock, { tag: 'ack' });
  assert.equal(nextTag(sock), 'TAG1');
  assert.deepEqual(sock.calls[0], ['node', { tag: 'iq' }, 5000]);
  assert.deepEqual((await serverProperties(sock)), { props: 1 });
});

test('jid decode handles the colon form, the LID form, and bare jids', () => {
  // user:device@server
  assert.deepEqual(decodeJid('62882017467912:12@s.whatsapp.net'),
    { user: '62882017467912', device: 12, server: 's.whatsapp.net' });
  // user.device:user@server — the LID form. The device must not leak into
  // `user`, and a bare @server must not be read as device 0 for everything.
  assert.deepEqual(decodeJid('12345.1:12345@lid'),
    { user: '12345', device: 1, server: 'lid' });
  assert.deepEqual(decodeJid('a@s.whatsapp.net'),
    { user: 'a', device: 0, server: 's.whatsapp.net' });
  assert.deepEqual(decodeJid('x@newsletter'),
    { user: 'x', device: 0, server: 'newsletter' });
  assert.equal(decodeJid('nonsense'), null);
});

test('jidEncode emits the colon form, or bare with device 0', () => {
  assert.equal(encodeJid('628', 12, 's.whatsapp.net'), '628:12@s.whatsapp.net');
  assert.equal(encodeJid('628', 0, 's.whatsapp.net'), '628@s.whatsapp.net');
});

test('phone normalisation strips everything non-numeric', () => {
  assert.equal(toDigits('+62 882-0174-67912'), '62882017467912');
  assert.equal(looksLikePhone('+62 882-0174-67912'), true, 'full number');
  assert.equal(looksLikePhone('+62 882'), false, 'too short');
  assert.equal(looksLikePhone('123'), false, 'too short');
  assert.equal(looksLikePhone('+620000000000000000000'), false, 'too long');
  assert.equal(looksLikePhone('0123'), false, 'leading zero');
  assert.equal(looksLikePhone('62882017467912'), true, 'bare digits are fine');
});

/* ══ group extensions ════════════════════════════════════════════ */

test('invite links parse and rebuild', () => {
  assert.equal(inviteCodeFromLink('https://chat.whatsapp.com/AbC123'), 'AbC123');
  assert.equal(inviteCodeFromLink('nope'), null);
  assert.equal(inviteLink('AbC123'), 'https://chat.whatsapp.com/AbC123');
});

test('joinByInvite refuses an invite that does not resolve', async () => {
  const sock = rig({ async groupGetInviteInfo() { return null; } });
  await assert.rejects(() => joinByInvite(sock, 'BAD'), /did not resolve/);
});

test('joinByInvite inspects before accepting', async () => {
  const sock = rig({
    async groupGetInviteInfo(i) { sock.calls.push(['info', i]); return { subject: 'Group' }; },
    async groupAcceptInviteV4(i) { sock.calls.push(['accept', i]); return { gid: GROUP }; },
  });
  const out = await joinByInvite(sock, 'KEY');
  assert.deepEqual(sock.calls.map((c) => c[0]), ['info', 'accept']);
  assert.deepEqual(out.info, { subject: 'Group' });
});

test('leaveGroup refuses a non-group jid before writing', async () => {
  const sock = rig({ async groupLeave(j) { sock.calls.push(['leave', j]); } });
  assert.throws(() => leaveGroup(sock, USER), /not a group jid/, 'synchronous guard');
  assert.equal(sock.calls.length, 0, 'nothing written');
});

test('fullRoster stops when the cursor repeats', async () => {
  const sock = rig({
    async groupRequestParticipantsList() {
      return [{ id: 'a@s', paginationCursors: { after: 'SAME' } }];
    },
  });
  const roster = await fullRoster(sock, GROUP);
  assert.equal(roster.length, 1, 'did not loop on a repeated cursor');
});

test('countAdmins filters by rank when asked', async () => {
  const sock = rig({
    async groupMetadata() {
      return {
        size: 4,
        participants: [
          { id: 'a@s', admin: 'superadmin' },
          { id: 'b@s', isAdmin: true },
          { id: 'c@s' },
        ],
      };
    },
  });
  assert.equal(await countAdmins(sock, GROUP), 2, 'any admin');
  assert.equal(await countAdmins(sock, GROUP, 'superadmin'), 1);
  assert.equal(await groupSize(sock, GROUP), 4);
});

test('amAdmin matches on device-stripped jid', async () => {
  const sock = rig({
    async groupMetadata() {
      return { participants: [{ id: '6283831459585:4@s.whatsapp.net', isAdmin: true }] };
    },
  });
  assert.equal(await amAdmin(sock, GROUP), true, 'own account is admin');
});

test('pictureUrl returns undefined instead of throwing', async () => {
  const sock = rig({ async profilePictureUrl() { throw new Error('no picture'); } });
  assert.equal(await pictureUrl(sock, USER), undefined);
});

test('memberLabels collects only labelled participants', async () => {
  const sock = rig({
    async groupMetadata() {
      return { participants: [{ id: 'a@s', memberLabel: 'Boss' }, { id: 'b@s' }] };
    },
  });
  assert.deepEqual(await memberLabels(sock, GROUP), { 'a@s': 'Boss' });
});

/* ══ session and reliability ═════════════════════════════════════ */

test('session probes tolerate a socket with no authState', async () => {
  // This framework does not always put authState on the socket. Every probe
  // must degrade to "unknown" rather than throwing and taking the caller down.
  const bare = { user: { id: '628@s.whatsapp.net' } };
  const withDigest = { authState: async () => ({ creds: {} }), digestKeyBundle: () => 'DIGEST' };
  assert.equal(await keyDigest(withDigest), 'DIGEST', 'real digest when available');
  assert.equal(await isFullyPaired(bare), false, 'not the same as unpaired, but not paired');
  assert.equal(await sessionTag(bare), 'unknown|no-auth-state');
  assert.equal(await needsPreKeyUpload(bare), true, 'assume upload is needed');
  assert.equal(await keyDigest(bare), 'unavailable');
});

test('isFullyPaired needs both registered and a noise key', async () => {
  const paired = rig();
  assert.equal(await isFullyPaired(paired), true);

  const half = rig({ authState: async () => ({ creds: { registered: false, noiseKey: {} } }) });
  assert.equal(await isFullyPaired(half), false, 'registered false');

  const keyless = rig({ authState: async () => ({ creds: { registered: true } }) });
  assert.equal(await isFullyPaired(keyless), false, 'noise key missing');
});

test('sessionTag summarises registration and key presence', async () => {
  const sock = rig();
  assert.match(await sessionTag(sock), /registered\|present/);
});

test('needsPreKeyUpload is false once the server accepted a bundle', async () => {
  const sock = rig();
  assert.equal(await needsPreKeyUpload(sock), false);
  const fresh = rig({ authState: async () => ({ creds: {} }) });
  assert.equal(await needsPreKeyUpload(fresh), true);
});

test('retryWithBackoff succeeds on a later attempt', async () => {
  let n = 0;
  const out = await retryWithBackoff(async () => {
    n += 1;
    if (n < 3) throw new Error('boom');
    return 'ok';
  }, { attempts: 3, baseMs: 1 });
  assert.equal(out, 'ok');
  assert.equal(n, 3);
});

test('retryWithBackoff rethrows after exhausting attempts', async () => {
  await assert.rejects(
    () => retryWithBackoff(async () => { throw new Error('always'); }, { attempts: 2, baseMs: 1 }),
    /always/,
  );
});

test('isTransient recognises connection-level errors', () => {
  assert.equal(isTransient(new Error('Connection closed')), true);
  assert.equal(isTransient(new Error('socket timeout')), true);
  assert.equal(isTransient(new Error('428 precondition')), true);
  assert.equal(isTransient(new Error('validation failed')), false);
});

test('retryIfTransient does not retry a permanent error', async () => {
  let n = 0;
  await assert.rejects(() => retryIfTransient(async () => {
    n += 1;
    throw new Error('validation failed');
  }, 4), /validation/);
  assert.equal(n, 1, 'gave up immediately');
});

test('sendWithFallback rethrows the original error', async () => {
  const sock = rig({
    async sendMessage() { throw new Error('Connection terminated'); },
    async sendRetryRequest() { sock.calls.push(['retryReq']); },
  });
  await assert.rejects(() => sendWithFallback(sock, USER, { text: 'x' }, { messageId: 'M1' }), /terminated/);
  assert.ok(sock.calls.some((c) => c[0] === 'retryReq'), 'asked for a server retry');
});

test('cleanDirty passes ALL', async () => {
  const sock = rig({ async cleanDirtyBits(b) { sock.calls.push(['clean', b]); } });
  await cleanDirty(sock);
  assert.deepEqual(sock.calls.at(-1), ['clean', 'ALL']);
});

test('reachoutDelay reads the first entry and defaults to zero', async () => {
  const withLock = rig({ async fetchAccountReachoutTimelock() { return [{ reachoutTimelock: 42 }]; } });
  assert.equal(await reachoutDelay(withLock), 42);
  const empty = rig({ async fetchAccountReachoutTimelock() { return []; } });
  assert.equal(await reachoutDelay(empty), 0);
});

/* ══ message builders ════════════════════════════════════════════ */

test('styleText nests WhatsApp markers with the last style applied outermost', () => {
  assert.equal(styleText('hi', { bold: true }), '*hi*');
  // italic is applied after bold, so it ends up outermost: *_hi_*
  assert.equal(styleText('hi', { bold: true, italic: true }), '*_hi_*');
  assert.equal(styleText('hi', { mono: true }), '```hi```');
  assert.equal(styleText('hi', { strike: true }), '~hi~');
  assert.equal(styleText('hi', {}), 'hi', 'no style leaves the text alone');
});

test('escapeMarkup and codeBlock make literals safe', () => {
  assert.equal(escapeMarkup('a*b_c'), 'a\\*b\\_c');
  assert.equal(codeBlock('x'), '```\nx\n```');
  assert.equal(codeBlock('x', 'js'), '```js\nx\n```');
});

test('splitText never exceeds the limit and loses nothing', () => {
  const src = 'para one here\n\npara two here\n\npara three';
  const parts = splitText(src, 20);
  assert.ok(parts.every((p) => p.length <= 20), 'every chunk fits');
  assert.equal(parts.join(' ').replace(/\s+/g, ' ').trim(),
    src.replace(/\s+/g, ' ').trim(), 'no words lost');
});

test('splitText returns the input untouched when it already fits', () => {
  assert.deepEqual(splitText('short', 100), ['short']);
});

test('truncateText cuts on a word boundary', () => {
  assert.equal(truncateText('hello world again', 12), 'hello world…');
  assert.equal(truncateText('short', 100), 'short');
});

test('oneLine and wordCount normalise whitespace', () => {
  assert.equal(oneLine('a\n\nb  c'), 'a b c');
  assert.equal(textWordCount('a b  c'), 3);
  assert.equal(textWordCount('   '), 0);
});

test('replyTo passes the whole message, not a key', () => {
  const message = { key: { id: 'M' }, message: { conversation: 'hi' } };
  assert.deepEqual(replyTo(message), { quoted: message });
  assert.deepEqual(replyTo(message).quoted.key.id, 'M');
});

test('location carries both required doubles', () => {
  const loc = location(-6.2, 106.8, 'Jakarta', 'Indonesia');
  assert.equal(loc.location.degreesLatitude, -6.2);
  assert.equal(loc.location.degreesLongitude, 106.8);
  assert.equal(loc.location.name, 'Jakarta');
});

test('poll defaults to single-select and supports multi', () => {
  assert.equal(poll('q?', ['a', 'b']).poll.selectableCount, 1);
  assert.equal(poll('q?', ['a', 'b'], 2).poll.selectableCount, 2);
});

test('reaction and unreact use the documented shapes', () => {
  assert.deepEqual(reaction('👍'), { react: { text: '👍' } });
  assert.deepEqual(unreact(), { react: { text: '' } }, 'empty text removes');
});

test('contactCard builds a minimal valid vCard', () => {
  const card = contactCard('Nyx');
  assert.equal(card.contacts.displayName, 'Nyx');
  assert.match(card.contacts.contacts[0].vcard, /^BEGIN:VCARD/);
});

test('chat verbs go through chatModify, not sendMessage', async () => {
  const sock = rig();
  await pinChat(sock, USER, true);
  await archiveChat(sock, USER, false);
  await starSingleMessage(sock, USER, 'M1');
  assert.deepEqual(sock.calls.map((c) => [c[1], c[2]]),
    [['pin', USER], ['unarchive', USER], ['star', USER]]);
  assert.equal(sock.calls[2][3], 'M1', 'star carries the message id');
});

test('validateMessage catches the nested-buffer trap', () => {
  const issues = validateMessage({ image: { buffer: Buffer.from([1]) } });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].field, 'image');
  assert.match(issues[0].problem, /must be a Buffer/);
  assert.deepEqual(validateMessage({ image: Buffer.from([1]) }), []);
});

test('validateMessage catches empty content and empty buffers', () => {
  assert.match(validateMessage({})[0].problem, /empty content/);
  assert.match(validateMessage({ image: Buffer.alloc(0) })[0].problem, /empty/);
});

test('validateMessage catches non-numeric coordinates and thin polls', () => {
  const issues = validateMessage({ location: { degreesLatitude: 'x', degreesLongitude: 'y' }, poll: { values: ['only'] } });
  const fields = issues.map((i) => i.field);
  assert.ok(fields.includes('location.degreesLatitude'));
  assert.ok(fields.includes('poll.values'));
});

test('assertValidMessage throws with every problem listed', () => {
  assert.throws(() => assertValidMessage({}), /invalid message/);
  assert.doesNotThrow(() => assertValidMessage({ text: 'fine' }));
});

test('randomKey is 32 hex chars, uppercased', () => {
  assert.match(randomKey(), /^[0-9A-F]{32}$/);
  assert.notEqual(randomKey(), randomKey());
});

/* ══ inbound parsing ═════════════════════════════════════════════ */

test('REVOKE is 1 and 44 is the announce bounce', () => {
  assert.equal(STUB_TYPES.REVOKE, 1);
  assert.equal(STUB_TYPES.GROUP_ANNOUNCE_MODE_MESSAGE_BOUNCE, 44);
});

test('isRevoke does not match the bounce — the classic mistake', () => {
  assert.equal(isRevoke({ messageStubType: 1 }), true);
  assert.equal(isRevoke({ messageStubType: 44 }), false, '44 is not a revoke');
  assert.equal(isAnnounceBounce({ messageStubType: 44 }), true);
});

test('keyOf strips nothing but reports fromMe and participant', () => {
  assert.deepEqual(keyOf({ key: { id: 'M', remoteJid: GROUP, fromMe: false, participant: 'a@s' } }),
    { remoteJid: GROUP, id: 'M', fromMe: false, participant: 'a@s' });
  assert.equal(keyOf({ key: {} }), null);
  assert.equal(keyOf({}), null);
});

test('chatOf strips the device suffix', () => {
  assert.equal(chatOf({ key: { remoteJid: '628@s.whatsapp.net:12' } }), '628@s.whatsapp.net');
});

test('senderOf prefers the participant in groups', () => {
  assert.equal(senderOf({ key: { participant: 'a@s', remoteJid: GROUP } }), 'a@s');
  assert.equal(senderOf({ key: { remoteJid: USER } }), USER);
});

test('mediaKeyOf and firstMedia find every media type', () => {
  for (const key of MEDIA_MESSAGE_KEYS) {
    const message = { message: { [key]: { caption: 'c' } } };
    assert.equal(mediaKeyOf(message), key);
    assert.equal(firstMedia(message).type, key);
    assert.equal(hasMedia(message), true);
  }
  assert.equal(mediaKeyOf({ message: {} }), null);
  assert.equal(firstMedia({ message: {} }), null);
});

test('voice notes and stickers are told apart', () => {
  assert.equal(isVoiceNote({ message: { audioMessage: { ptt: true } } }), true);
  assert.equal(isVoiceNote({ message: { audioMessage: {} } }), false);
  assert.equal(isSticker({ message: { stickerMessage: {} } }), true);
});

test('isEphemeral finds an expiry in contextInfo', () => {
  assert.equal(isEphemeral({ message: { messageContextInfo: { ephemeralExpiration: 15 } } }), true);
  assert.equal(isEphemeral({ message: {} }), false);
});

test('selectedReply parses paramsJson and tolerates garbage', () => {
  const reply = (json) => ({
    message: { interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: json } } },
  });
  assert.equal(selectedReply(reply(JSON.stringify({ id: 'c' }))), 'c');
  assert.equal(selectedReply(reply(JSON.stringify({ display_text: 'Go' }))), 'Go');
  assert.equal(selectedReply(reply('not json')), null, 'opaque payload is not an error');
  assert.equal(selectedReply({}), null);
});

test('isQuickReplyReply and isListReply separate the two response kinds', () => {
  const quick = { message: { interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: '{"id":"b1"}' } } } };
  assert.equal(isQuickReplyReply(quick), true);
  assert.equal(isListReply(quick), true, 'a row id looks like a list reply');

  const cta = { message: { interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: '{"id":"cta_copy"}' } } } };
  assert.equal(isListReply(cta), false, 'a cta_ id is not a list selection');
});

test('listTitleOf reads the response title', () => {
  const m = { message: { interactiveResponseMessage: { nativeFlowMessageTitle: 'Menu' } } };
  assert.equal(listTitleOf(m), 'Menu');
  assert.equal(listTitleOf({}), null);
});

test('edits are detected and their text extracted', () => {
  const edit = { message: { protocolMessage: { editedMessage: { message: { extendedTextMessage: { text: 'new' } } } } } };
  assert.equal(isEdit(edit), true);
  assert.equal(editedText(edit), 'new');
  assert.equal(isEdit({}), false);
  assert.equal(editedText({}), null);
});

test('reaction removal is an empty text, not a missing message', () => {
  assert.equal(reactionOf({ message: { reactionMessage: { text: '👍' } } }), '👍');
  assert.equal(isReactionRemoval({ message: { reactionMessage: { text: '' } } }), true);
  assert.equal(reactionOf({ message: {} }), null);
});

test('isProcessable filters our own messages and stubs by default', () => {
  const own = { key: { id: 'A', fromMe: true }, message: { conversation: 'x' } };
  const stub = { key: { id: 'B', fromMe: false }, messageStubType: 1 };
  const real = { key: { id: 'C', fromMe: false }, message: { conversation: 'hi' } };

  assert.equal(isProcessable(own), false);
  assert.equal(isProcessable(stub), false);
  assert.equal(isProcessable(real), true);
  assert.equal(isProcessable(own, { includeOwn: true }), true);
  assert.equal(isProcessable(stub, { includeStubs: true }), true);
  assert.equal(isProcessable({ key: {} }), false, 'no id is never processable');
});

test('processable and onProcessable filter a whole upsert', async () => {
  const event = {
    messages: [
      { key: { id: 'A', fromMe: true }, message: { conversation: 'mine' } },
      { key: { id: 'B', fromMe: false }, message: { conversation: 'theirs' } },
    ],
  };
  assert.deepEqual(processable(event).map((m) => m.key.id), ['B']);
  assert.equal(messagesOf(event).length, 2, 'raw count is unfiltered');
  assert.deepEqual(messagesOf({}).length, 0);

  const seen = [];
  const handlers = new Map();
  const sock = { ev: { on: (e, h) => handlers.set(e, h), off: (e) => handlers.delete(e) } };
  const off = onProcessable(sock, (m) => seen.push(m.key.id));
  handlers.get('messages.upsert')(event);
  assert.deepEqual(seen, ['B']);
  off();
  assert.equal(handlers.has('messages.upsert'), false, 'unsubscribed cleanly');
});

/* ══ newsletter and moderation ════════════════════════════════════ */

test('fetchNewsletterMessages passes all four positional arguments', async () => {
  const sock = rig({ async newsletterFetchMessages(...a) { sock.calls.push(['nf', ...a]); return []; } });
  await fetchNewsletterMessages(sock, 'x@newsletter', 20);
  assert.deepEqual(sock.calls.at(-1), ['nf', 'x@newsletter', 20, 0, 0], 'defaults are explicit, not undefined');
});

test('reactNewsletter with no emoji removes the reaction', async () => {
  const sock = rig({ async newsletterReactMessage(...a) { sock.calls.push(['react', ...a]); } });
  await reactNewsletter(sock, 'x@newsletter', 'S1', '👍');
  await reactNewsletter(sock, 'x@newsletter', 'S1');
  assert.deepEqual(sock.calls.map((c) => c[3]), ['👍', undefined]);
});

test('deleteForEveryone includes the participant when known', async () => {
  const sock = rig();
  await deleteForEveryone(sock, GROUP, 'M1', 'a@s');
  const content = sock.calls.at(-1)[2];
  assert.equal(content.delete.id, 'M1');
  assert.equal(content.delete.participant, 'a@s');
});

test('participant moderation routes through groupParticipantsUpdate', async () => {
  const sock = rig({ async groupParticipantsUpdate(...a) { sock.calls.push(['gpu', ...a]); } });
  await banParticipant(sock, GROUP, 'a@s');
  await promoteParticipant(sock, GROUP, 'a@s');
  await demoteParticipant(sock, GROUP, 'a@s');
  await removeParticipant(sock, GROUP, 'a@s');
  // gpu receives (groupJid, participants, action) — index 3 is the verb.
  assert.deepEqual(sock.calls.map((c) => c[3]), ['ban', 'promote', 'demote', 'remove']);
});

test('moderate marks destructive actions honestly', async () => {
  const sock = rig({ async groupParticipantsUpdate() {} });
  assert.equal((await moderate(sock, GROUP, 'ban', 'a@s', 'a@s')).destructive, true);
  assert.equal((await moderate(sock, GROUP, 'promote', 'a@s', 'a@s')).destructive, false);
});

test('confirmDestructive refuses irreversible actions without confirmation', async () => {
  const sock = rig({ async groupParticipantsUpdate(...a) { sock.calls.push(['gpu', ...a]); } });
  assert.equal(await confirmDestructive(sock, GROUP, 'ban', 'a@s', 'a@s', false), false);
  assert.equal(sock.calls.length, 0, 'nothing sent');
  assert.equal(await confirmDestructive(sock, GROUP, 'ban', 'a@s', 'a@s', true), true);
  assert.equal(sock.calls.length, 1);
});

test('confirmDestructive lets a reversible action through unconfirmed', async () => {
  const sock = rig({ async groupParticipantsUpdate(...a) { sock.calls.push(['gpu', ...a]); } });
  assert.equal(await confirmDestructive(sock, GROUP, 'promote', 'a@s', 'a@s', false), true);
});

test('upsertLocal writes to history without sending', () => {
  const seen = [];
  const sock = { upsertMessage: (m) => seen.push(m) };
  upsertLocal(sock, { key: { id: 'X' } });
  assert.equal(seen.length, 1);
  assert.equal(sock.calls, undefined, 'no socket call, no send');
});