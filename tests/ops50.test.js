/**
 * OPS-50 — payload-shape and idempotency tests.
 *
 * These assert the *shape* of what reaches a socket: the right verb, the right
 * argument order, the right guard. They do NOT assert hardware behaviour — every
 * function in this suite is `unverified` on the wire except the ones explicitly
 * marked otherwise in docs/VERIFICATION.md.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseChatFlags, setChatFlag, configureChat, isBlocked, blockJid, unblockJid,
  ensureBlocked, normaliseBlocklist, setPrivacy, getPrivacyAudience, goFullyPrivate,
  resolveAudience, presetToSeconds, disableExpiry, getChatExpiry,
} from '../dist/toolkit/ops-50/chat-control.js';

import {
  addParticipants, removeParticipants, promoteParticipants, demoteParticipants,
  participantAction, applyGroupPolicy, listAdmins, splitRoster,
  removeParticipantsCapped, renameGroup,
} from '../dist/toolkit/ops-50/group-admin.js';

import {
  createNewsletter, updateNewsletter, renameNewsletter, productWrite, isNewsletterJid,
} from '../dist/toolkit/ops-50/newsletter-commerce.js';

import {
  resolveNumber, saveContact, saveQuickReply, buildVCard, setAbout, setDisplayName,
} from '../dist/toolkit/ops-50/contacts-profile.js';

import {
  buildMediaContent, extensionFor, defaultFileName, guessMime, humanBytes,
  isUsableBuffer, chunkBuffer, fetchMediaBytes, sendMedia,
} from '../dist/toolkit/ops-50/media-ops.js';

import {
  messageText, messageFingerprint, isFromMe, receiptKey, markRead, ownJid, deviceId,
  isSelf, connectionHealth, isReady, setTyping, clearTyping, setPresence,
} from '../dist/toolkit/ops-50/diagnostics.js';

/* A recording socket: every call is captured, nothing is sent. */
function rig(initial = {}) {
  const calls = [];
  const sock = {
    calls,
    user: { id: '6283831459585:12@s.whatsapp.net' },
    chatSettings: [['archive', false], ['pin', false], ['mute', false], ['star', false]],
    blocklist: [],
    async getChatSettings() { return sock.chatSettings; },
    async chatModify(...args) { calls.push(['chatModify', ...args]); },
    async fetchBlocklist() { return sock.blocklist; },
    async updateBlockStatus(...args) {
      calls.push(['updateBlockStatus', ...args]);
      const [jid, action] = args;
      sock.blocklist = action === 'block'
        ? [...sock.blocklist, jid]
        : sock.blocklist.filter((j) => j !== jid);
    },
    async fetchPrivacySettings() { return sock.privacy ?? {}; },
    async updateReadReceiptsPrivacy(...a) { calls.push(['updateReadReceiptsPrivacy', ...a]); },
    async updateLastSeenPrivacy(...a) { calls.push(['updateLastSeenPrivacy', ...a]); },
    async updateOnlinePrivacy(...a) { calls.push(['updateOnlinePrivacy', ...a]); },
    async updateProfilePicturePrivacy(...a) { calls.push(['updateProfilePicturePrivacy', ...a]); },
    async updateStatusPrivacy(...a) { calls.push(['updateStatusPrivacy', ...a]); },
    async updateGroupsAddPrivacy(...a) { calls.push(['updateGroupsAddPrivacy', ...a]); },
    async updateMessagesPrivacy(...a) { calls.push(['updateMessagesPrivacy', ...a]); },
    async updateCallPrivacy(...a) { calls.push(['updateCallPrivacy', ...a]); },
    async fetchDisappearingDuration() {
      // Mirrors rc14: a result list, not a scalar.
      return [{ id: USER, disappearing_mode: { duration: sock.expiry ?? 0, setAt: '1970-01-01T00:00:00.000Z' } }];
    },
    async updateDefaultDisappearingMode(...a) { calls.push(['updateDefaultDisappearingMode', ...a]); sock.expiry = a[1]; },
    async groupRequestParticipantsUpdate(...a) { calls.push(['groupRequestParticipantsUpdate', ...a]); },
    async groupMetadata() { return sock.meta; },
    async groupUpdateSubject(...a) { calls.push(['groupUpdateSubject', ...a]); },
    async groupSettingUpdate(...a) { calls.push(['groupSettingUpdate', ...a]); },
    async groupMemberAddMode(...a) { calls.push(['groupMemberAddMode', ...a]); },
    async groupJoinApprovalMode(...a) { calls.push(['groupJoinApprovalMode', ...a]); },
    async groupToggleEphemeral(...a) { calls.push(['groupToggleEphemeral', ...a]); },
    async newsletterCreate(...a) { calls.push(['newsletterCreate', ...a]); return { jid: 'x@newsletter' }; },
    async newsletterUpdate(...a) { calls.push(['newsletterUpdate', ...a]); },
    async productCreate(p) { calls.push(['productCreate', p]); return p; },
    async productUpdate(...a) { calls.push(['productUpdate', ...a]); },
    async productDelete(...a) { calls.push(['productDelete', ...a]); },
    async onWhatsApp(d) { calls.push(['onWhatsApp', d]); return sock.onWhatsAppResult ?? []; },
    async addOrEditContact(...a) { calls.push(['addOrEditContact', ...a]); },
    async addOrEditQuickReply(...a) { calls.push(['addOrEditQuickReply', ...a]); },
    async updateProfileStatus(s) { calls.push(['updateProfileStatus', s]); },
    async updateProfileName(s) { calls.push(['updateProfileName', s]); },
    async sendPresenceUpdate(...a) { calls.push(['sendPresenceUpdate', ...a]); },
    async readMessages(k) { calls.push(['readMessages', k]); },
    async authState() { return { creds: { registered: sock.registered !== false } }; },
    async sendMessage(...a) { calls.push(['sendMessage', ...a]); return { key: { id: 'X' } }; },
    ...initial,
  };
  return sock;
}

const GROUP = '120363000000000000@g.us';
const USER = '62882017467912@s.whatsapp.net';

/* ── chat flags ─────────────────────────────────────────────────── */

test('parseChatFlags reads rc14 argv pairs', () => {
  assert.deepEqual(parseChatFlags([['archive', true], ['pin', false]]),
    { archive: true, pin: false, mute: false, star: false });
  assert.deepEqual(parseChatFlags(undefined),
    { archive: false, pin: false, mute: false, star: false });
  assert.equal(parseChatFlags([['pin', null]]).pin, false, 'null is not on');
});

test('setChatFlag is idempotent — a second call at the same value does nothing', async () => {
  const sock = rig();
  assert.equal(await setChatFlag(sock, USER, 'pin', true), true);
  assert.equal(sock.calls.filter((c) => c[0] === 'chatModify').length, 1);
  // rc14 toggles when the value is omitted, so a repeat would flip it back.
  sock.chatSettings = [['archive', false], ['pin', true], ['mute', false], ['star', false]];
  assert.equal(await setChatFlag(sock, USER, 'pin', true), false, 'no-op at target state');
  assert.equal(sock.calls.filter((c) => c[0] === 'chatModify').length, 1);
});

test('setChatFlag passes the value, never a bare toggle', async () => {
  const sock = rig();
  await setChatFlag(sock, USER, 'mute', true);
  assert.deepEqual(sock.calls.at(-1), ['chatModify', 'mute', USER, true]);
});

test('configureChat reports only what actually changed', async () => {
  const sock = rig();
  sock.chatSettings = [['archive', true], ['pin', false], ['mute', false], ['star', false]];
  const changed = await configureChat(sock, USER, { archive: true, pin: true });
  assert.deepEqual(changed, ['pin'], 'archive was already on');
});

/* ── blocking ───────────────────────────────────────────────────── */

test('blockJid is idempotent and never double-sends', async () => {
  const sock = rig();
  assert.equal(await blockJid(sock, USER), true);
  assert.equal(await blockJid(sock, USER), false);
  assert.equal(sock.calls.filter((c) => c[0] === 'updateBlockStatus').length, 1);
});

test('unblockJid on an unblocked jid does nothing', async () => {
  const sock = rig();
  assert.equal(await unblockJid(sock, USER), false);
  assert.equal(sock.calls.length, 0);
});

test('ensureBlocked reaches the requested state', async () => {
  const sock = rig();
  await ensureBlocked(sock, USER, true);
  assert.deepEqual(sock.calls.at(-1), ['updateBlockStatus', USER, 'block']);
  await ensureBlocked(sock, USER, false);
  assert.deepEqual(sock.calls.at(-1), ['updateBlockStatus', USER, 'unblock']);
});

test('isBlocked fails closed when the blocklist throws', async () => {
  const sock = rig({ async fetchBlocklist() { throw new Error('offline'); } });
  assert.equal(await isBlocked(sock, USER), false);
});

test('normaliseBlocklist strips devices and dedupes', () => {
  assert.deepEqual(
    normaliseBlocklist(['628@s.whatsapp.net:12', '628@s.whatsapp.net:4', '999@s.whatsapp.net']),
    ['628@s.whatsapp.net', '999@s.whatsapp.net'],
  );
  assert.deepEqual(normaliseBlocklist(undefined), []);
});

/* ── privacy ────────────────────────────────────────────────────── */

test('setPrivacy routes each key to its own rc14 writer', async () => {
  const sock = rig();
  await setPrivacy(sock, 'readReceipts', 'none');
  assert.deepEqual(sock.calls.at(-1), ['updateReadReceiptsPrivacy', 'none']);
  await setPrivacy(sock, 'lastSeen', 'contacts');
  assert.deepEqual(sock.calls.at(-1), ['updateLastSeenPrivacy', 'contacts']);
});

test('setPrivacy refuses a key rc14 has no writer for', async () => {
  const sock = rig();
  await assert.rejects(() => setPrivacy(sock, 'nonsense', 'none'), /unknown privacy key/);
});

test('goFullyPrivate writes all eight switches to none', async () => {
  const sock = rig();
  const keys = await goFullyPrivate(sock);
  assert.equal(keys.length, 8);
  assert.ok(sock.calls.every((c) => c[1] === 'none'), 'every audience is none');
});

test('resolveAudience falls back when a category is unset', () => {
  assert.equal(resolveAudience({ status: { readReceipts: 'contacts' } }, 'status'), 'contacts');
  assert.equal(resolveAudience({}, 'status', 'contacts'), 'contacts');
});

test('getPrivacyAudience reads the current value', async () => {
  const sock = rig({ privacy: { status: { readReceipts: 'contact_blacklist' } } });
  assert.equal(await getPrivacyAudience(sock, 'status'), 'contact_blacklist');
});

/* ── disappearing ───────────────────────────────────────────────── */

test('presetToSeconds maps only known presets', () => {
  assert.equal(presetToSeconds('off'), 0);
  assert.equal(presetToSeconds('30s'), 30);
  assert.equal(presetToSeconds('7d'), 604_800);
  assert.throws(() => presetToSeconds('13h'), /unknown/);
});

test('disableExpiry no-ops when already off', async () => {
  const sock = rig({ expiry: 0 });
  assert.equal(await disableExpiry(sock, USER), false);
  sock.expiry = 86_400;
  assert.equal(await disableExpiry(sock, USER), true);
  assert.deepEqual(sock.calls.at(-1), ['updateDefaultDisappearingMode', USER, 0]);
});

/* ── group admin ────────────────────────────────────────────────── */

test('membership verbs map to rc14 participant actions', async () => {
  const sock = rig();
  await addParticipants(sock, GROUP, ['a@s']);
  await removeParticipants(sock, GROUP, ['a@s']);
  await demoteParticipants(sock, GROUP, ['a@s']);
  assert.deepEqual(sock.calls.map((c) => [c[1], c[2], c[3]]), [
    [GROUP, ['a@s'], 'add'],
    [GROUP, ['a@s'], 'remove'],
    [GROUP, ['a@s'], 'demote'],
  ]);
});

test('promote carries the admin rank as a fourth argument', async () => {
  const sock = rig();
  await promoteParticipants(sock, GROUP, ['a@s'], 'superadmin');
  assert.deepEqual(sock.calls.at(-1), ['groupRequestParticipantsUpdate', GROUP, ['a@s'], 'promote', 'superadmin']);
});

test('participantAction rejects an unknown verb', async () => {
  const sock = rig();
  await assert.rejects(() => participantAction(sock, GROUP, 'explode', ['a@s']), /unknown participant action/);
});

test('applyGroupPolicy only sends settings that actually differ', async () => {
  const sock = rig({
    async groupMetadata() {
      return { announce: false, restrict: true, memberAddMode: true, joinApprovalMode: false, ephemeralDuration: 0 };
    },
  });
  const changed = await applyGroupPolicy(sock, GROUP, { announce: true, restrict: true, memberAddMode: false });
  assert.deepEqual(changed, ['announce', 'memberAddMode'], 'restrict unchanged, not resent');
  assert.ok(sock.calls.some((c) => c[0] === 'groupSettingUpdate' && c[1] === GROUP && c[2] === 'announce'));
  assert.ok(!sock.calls.some((c) => c[2] === 'restrict'));
});

test('listAdmins recognises both isAdmin and the admin string', async () => {
  const sock = rig({
    async groupMetadata() {
      return {
        participants: [
          { id: 'a@s', isAdmin: true },
          { id: 'b@s', admin: 'superadmin' },
          { id: 'c@s' },
          { id: 'd@s', admin: null },
        ],
      };
    },
  });
  assert.deepEqual(await listAdmins(sock, GROUP), ['a@s', 'b@s']);
  const split = await splitRoster(sock, GROUP);
  assert.deepEqual(split.admins, ['a@s', 'b@s']);
  assert.deepEqual(split.members, ['c@s', 'd@s']);
});

test('removeParticipantsCapped refuses to act above the batch cap', async () => {
  const sock = rig();
  const many = Array.from({ length: 51 }, (_, i) => `p${i}@s.whatsapp.net`);
  const out = await removeParticipantsCapped(sock, GROUP, many);
  assert.deepEqual(out.removed, [], 'nothing removed');
  assert.equal(out.refused.length, 51);
  assert.equal(sock.calls.length, 0, 'no socket write at all');
});

test('renameGroup sends subject in the second position', async () => {
  const sock = rig();
  await renameGroup(sock, GROUP, 'New name');
  assert.deepEqual(sock.calls.at(-1), ['groupUpdateSubject', GROUP, 'New name']);
});

/* ── newsletter + commerce ──────────────────────────────────────── */

test('createNewsletter passes name and description, not a picture', async () => {
  const sock = rig();
  await createNewsletter(sock, 'Nyx', 'desc');
  assert.deepEqual(sock.calls.at(-1), ['newsletterCreate', 'Nyx', 'desc']);
  assert.equal(isNewsletterJid('x@newsletter'), true);
  assert.equal(isNewsletterJid(USER), false);
});

test('renameNewsletter goes through newsletterUpdate with a name key', async () => {
  const sock = rig();
  await renameNewsletter(sock, 'x@newsletter', 'Renamed');
  assert.deepEqual(sock.calls.at(-1), ['newsletterUpdate', 'x@newsletter', { name: 'Renamed' }]);
});

test('productWrite omits jid — rc14 derives identity from creds', async () => {
  const sock = rig();
  await productWrite(sock, 'create', { title: 'T' });
  assert.deepEqual(sock.calls.at(-1), ['productCreate', { title: 'T' }]);
  await productWrite(sock, 'update', { title: 'T2' }, 'prod-1');
  assert.deepEqual(sock.calls.at(-1), ['productUpdate', 'prod-1', { title: 'T2' }]);
  await productWrite(sock, 'delete', null, 'prod-1');
  assert.deepEqual(sock.calls.at(-1), ['productDelete', ['prod-1']], 'delete takes an array');
});

test('productWrite demands an id for update and delete', async () => {
  const sock = rig();
  await assert.rejects(() => productWrite(sock, 'update', {}), /productId/);
  await assert.rejects(() => productWrite(sock, 'delete', null), /productId/);
});

test('updateNewsletter is the single update entry point', async () => {
  const sock = rig();
  await updateNewsletter(sock, 'x@newsletter', { description: 'd' });
  assert.deepEqual(sock.calls.at(-1), ['newsletterUpdate', 'x@newsletter', { description: 'd' }]);
});

/* ── contacts ───────────────────────────────────────────────────── */

test('resolveNumber strips formatting before calling onWhatsApp', async () => {
  const sock = rig({ onWhatsAppResult: [{ exists: true, jid: '628@s.whatsapp.net' }] });
  const out = await resolveNumber(sock, '+62 882-0174-67912');
  assert.deepEqual(out, { exists: true, jid: '628@s.whatsapp.net' });
  assert.equal(sock.calls.at(-1)[1], '62882017467912', 'digits only');
});

test('resolveNumber reports absent rather than throwing', async () => {
  const sock = rig({ onWhatsAppResult: [{ exists: false }] });
  assert.deepEqual(await resolveNumber(sock, '628000000000'), { exists: false });
  assert.deepEqual(await resolveNumber(sock, 'abc'), { exists: false }, 'non-numeric input');
});

test('saveContact and saveQuickReply forward verbatim', async () => {
  const sock = rig();
  await saveContact(sock, USER, 'Name', '+62 882');
  assert.deepEqual(sock.calls.at(-1), ['addOrEditContact', USER, { name: 'Name', lid: undefined, phoneNumber: '+62 882' }]);
  await saveQuickReply(sock, 'hi', 'hello there');
  assert.deepEqual(sock.calls.at(-1), ['addOrEditQuickReply', 'hi', 'hello there']);
});

test('buildVCard emits a valid card and a waid when given a phone', () => {
  const bare = buildVCard('Nyx');
  assert.match(bare, /^BEGIN:VCARD\nVERSION:3\.0\nFN:Nyx\nEND:VCARD$/);
  assert.match(buildVCard('Nyx', '+62 882-0174-67912'), /waid=62882017467912/);
});

test('profile writes hit their own rc14 methods', async () => {
  const sock = rig();
  await setDisplayName(sock, 'Nyx');
  await setAbout(sock, 'about text');
  assert.deepEqual(sock.calls.at(-2), ['updateProfileName', 'Nyx']);
  assert.deepEqual(sock.calls.at(-1), ['updateProfileStatus', 'about text']);
});

/* ── media ──────────────────────────────────────────────────────── */

test('media content assigns the buffer directly — never nested', () => {
  const bytes = Buffer.from([1, 2, 3]);
  const content = buildMediaContent({ kind: 'image', bytes, mimetype: 'image/png', fileName: 'a.png' });
  assert.ok(Buffer.isBuffer(content.image), 'image is a Buffer, not an object');
  assert.deepEqual(content.image, bytes);
  assert.equal(content.mimetype, 'image/png');
  assert.equal(content.fileName, 'a.png');
  // A Node Buffer has a deprecated `.buffer` pointing at its ArrayBuffer, so
// assert on shape instead: the value at the media key is the Buffer we passed.
assert.equal(content.image.byteLength, bytes.byteLength);
assert.deepEqual(Buffer.isBuffer(content.image), true);
assert.equal(typeof content.image.buffer, 'object', 'raw ArrayBuffer, not a nested { buffer }');
});

test('voice notes carry ptt, opus, and no filename', () => {
  const content = buildMediaContent({
    kind: 'audio', bytes: Buffer.from([1]), mimetype: 'audio/ogg', asVoice: true, fileName: 'x.ogg',
  });
  assert.equal(content.ptt, true);
  assert.match(String(content.mimetype), /opus/);
  assert.equal(content.fileName, undefined);
});

test('stickers move the bytes onto the sticker key', () => {
  const bytes = Buffer.from([9]);
  const content = buildMediaContent({ kind: 'image', bytes, mimetype: 'image/webp', asSticker: true });
  assert.ok(Buffer.isBuffer(content.sticker));
  assert.equal(content.image, undefined, 'image key is cleared');
});

test('extension and mime inference agree', () => {
  assert.equal(extensionFor('image/webp', 'image'), 'webp');
  assert.equal(extensionFor('audio/ogg; codecs=opus', 'audio'), 'ogg');
  assert.equal(extensionFor('application/pdf', 'document'), 'pdf');
  assert.equal(extensionFor('nonsense/nonsense', 'document'), 'bin');
  assert.equal(guessMime('photo.PNG'), 'image/png');
  assert.equal(guessMime('unknown.xyz'), 'application/octet-stream');
});

test('defaultFileName derives an extension from the mimetype', () => {
  const name = defaultFileName({ kind: 'image', bytes: Buffer.alloc(1), mimetype: 'image/jpeg' });
  assert.match(name, /^nyx-.*\.jpg$/);
});

test('humanBytes is readable at every scale', () => {
  assert.equal(humanBytes(512), '512 B');
  assert.equal(humanBytes(2048), '2.0 KB');
  assert.equal(humanBytes(5_242_880), '5.0 MB');
});

test('isUsableBuffer rejects empty and non-buffers', () => {
  assert.equal(isUsableBuffer(Buffer.from([1])), true);
  assert.equal(isUsableBuffer(Buffer.alloc(0)), false);
  assert.equal(isUsableBuffer({ buffer: Buffer.from([1]) }), false);
});

test('chunkBuffer partitions without losing bytes', () => {
  const src = Buffer.alloc(2500, 7);
  const parts = chunkBuffer(src, 1000);
  assert.equal(parts.length, 3);
  assert.equal(Buffer.concat(parts).length, 2500);
  assert.throws(() => chunkBuffer(src, 0), /positive/);
});

test('fetchMediaBytes says what is wrong when rc14 lacks the method', async () => {
  await assert.rejects(() => fetchMediaBytes({}, {}), /rc14 renamed this/);
  const sock = { async downloadMediaMessage() { return Buffer.from([1, 2]); } };
  assert.ok(Buffer.isBuffer(await fetchMediaBytes(sock, {})));
});

test('fetchMediaBytes refuses a non-buffer result', async () => {
  const sock = { async downloadMediaMessage() { return 'not a buffer'; } };
  await assert.rejects(() => fetchMediaBytes(sock, {}), /did not return a Buffer/);
});

test('sendMedia passes built content and a quoted ref', async () => {
  const sock = rig();
  const quoted = { key: { id: 'Q' } };
  await sendMedia(sock, USER, { kind: 'image', bytes: Buffer.from([1]), mimetype: 'image/png' }, quoted);
  assert.deepEqual(sock.calls.at(-1), ['sendMessage', USER, { image: Buffer.from([1]), mimetype: 'image/png' }, { quoted }]);
});

/* ── diagnostics ────────────────────────────────────────────────── */

test('messageText finds text across every common container', () => {
  assert.equal(messageText({ message: { conversation: 'hi' } }), 'hi');
  assert.equal(messageText({ message: { extendedTextMessage: { text: 'yo' } } }), 'yo');
  assert.equal(messageText({ message: { imageMessage: { caption: 'pic' } } }), 'pic');
  assert.equal(messageText({ message: { listMessage: { description: 'menu' } } }), 'menu');
  assert.equal(messageText({}), '');
  assert.equal(messageText(null), '');
});

test('messageFingerprint is stable and collision-free across chats', () => {
  const a = { key: { id: '1', remoteJid: GROUP } };
  const b = { key: { id: '1', remoteJid: USER } };
  assert.equal(messageFingerprint(a), messageFingerprint(a));
  assert.notEqual(messageFingerprint(a), messageFingerprint(b));
});

test('receiptKey refuses an outgoing key — readMessages would return nothing', () => {
  assert.deepEqual(
    receiptKey({ key: { id: 'm1', remoteJid: USER, fromMe: false } }),
    { remoteJid: USER, id: 'm1', fromMe: false },
  );
  assert.equal(receiptKey({ key: { id: 'm1', remoteJid: USER, fromMe: true } }), null);
  assert.equal(receiptKey({ key: {} }), null);
});

test('markRead refuses an outgoing key instead of sending it', async () => {
  const sock = rig();
  assert.equal(await markRead(sock, { key: { id: 'm', remoteJid: USER, fromMe: true } }), false);
  assert.equal(sock.calls.length, 0);
  assert.equal(await markRead(sock, { key: { id: 'm', remoteJid: USER, fromMe: false } }), true);
});

test('identity helpers agree on the device suffix', () => {
  const sock = rig();
  assert.equal(ownJid(sock), '6283831459585:12@s.whatsapp.net');
  assert.equal(deviceId(sock), '12');
  assert.equal(isSelf(sock, '6283831459585:99@s.whatsapp.net'), true, 'same person, other device');
  assert.equal(isSelf(sock, USER), false);
});

test('connectionHealth reflects both connection and registration', async () => {
  const sock = rig();
  assert.deepEqual(await connectionHealth(sock),
    { connected: true, registered: true, jid: '6283831459585:12@s.whatsapp.net' });
  assert.equal(await isReady(sock), true);
  sock.registered = false;
  assert.equal(await isReady(sock), false);
});

test('connectionHealth tolerates a socket with no authState', async () => {
  // This framework does not always put authState on the socket. Reporting a
  // hard `false` there would look like a broken session, so it must be unknown.
  const bare = { user: { id: '628@s.whatsapp.net' } };
  assert.deepEqual(await connectionHealth(bare),
    { connected: true, registered: undefined, jid: '628@s.whatsapp.net' });
  assert.equal(await isReady(bare), true, 'does not fail closed on missing auth state');
});

test('getChatExpiry unwraps rc14 result list, not a scalar', async () => {
  // fetchDisappearingDuration is variadic and returns a USync result list.
  const sock = rig({
    async fetchDisappearingDuration() {
      return [{ id: USER, disappearing_mode: { duration: 604_800, setAt: '2026-01-01T00:00:00.000Z' } }];
    },
  });
  assert.equal(await getChatExpiry(sock, USER), 604_800);
});

test('getChatExpiry is 0 when rc14 returns nothing', async () => {
  const sock = rig({ async fetchDisappearingDuration() { return undefined; } });
  assert.equal(await getChatExpiry(sock, USER), 0);
});

test('typing presence carries the target jid', async () => {
  const sock = rig();
  await setTyping(sock, USER);
  await setTyping(sock, USER, true);
  await clearTyping(sock, USER);
  assert.deepEqual(sock.calls.map((c) => c[1]), ['composing', 'recording', 'paused']);
  assert.ok(sock.calls.every((c) => c[2] === USER), 'jid present on all three');
});

test('available presence needs no jid', async () => {
  const sock = rig();
  await setPresence(sock, 'available');
  assert.deepEqual(sock.calls.at(-1), ['sendPresenceUpdate', 'available']);
});