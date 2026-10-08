import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  autoTagAll,
  stealthPresenceChoreographer,
  SmartAutoReplyRouter,
  MessageScheduler,
  RevokedMessageVault,
  autoStickerConverter,
  vcardGenerator,
  GroupSecurityShield,
  newsletterPublisher,
  ChatAutoClear,
} from '../dist/toolkit/advanced-ops.js';
import { fakeSocket } from './helpers.js';

test('8. Feature 8: autoTagAll fetches participants and sends mentions', async () => {
  const sock = fakeSocket();
  sock.groupMetadata = async (gid) => ({
    id: gid,
    participants: [{ id: 'user1@s.whatsapp.net' }, { id: 'user2@s.whatsapp.net' }],
  });

  const sentArgs = [];
  sock.sendMessage = async (jid, content) => {
    sentArgs.push({ jid, content });
    return { key: { id: 'tag_1' } };
  };

  await autoTagAll(sock, '120363000000000000@g.us');
  assert.equal(sentArgs.length, 1);
  assert.equal(sentArgs[0].content.mentions.length, 2);
});

test('9. Feature 9: stealthPresenceChoreographer sends typing update and pauses', async () => {
  const sock = fakeSocket();
  const updates = [];
  sock.sendPresenceUpdate = async (type, jid) => {
    updates.push({ type, jid });
  };

  await stealthPresenceChoreographer(sock, '15551234567@s.whatsapp.net', 10);
  assert.equal(updates.length, 2);
  assert.equal(updates[0].type, 'composing');
  assert.equal(updates[1].type, 'paused');
});

test('10. Feature 10: SmartAutoReplyRouter matches pattern and respects cooldown', async () => {
  const router = new SmartAutoReplyRouter();
  router.addRule({
    pattern: 'hello',
    cooldownMs: 1000,
    handler: async () => 'Hi there!',
  });

  const res1 = await router.process('user1', 'hello bot');
  assert.equal(res1, 'Hi there!');

  // Inside cooldown
  const res2 = await router.process('user1', 'hello bot');
  assert.equal(res2, null);
});

test('11. Feature 11: MessageScheduler schedules, drains and cancels messages', () => {
  const scheduler = new MessageScheduler();
  const id1 = scheduler.schedule('user1', 'msg1', 100);
  const id2 = scheduler.schedule('user2', 'msg2', 500);

  assert.equal(scheduler.pending().length, 2);

  const dueBefore = scheduler.drainDue(Date.now() + 50);
  assert.equal(dueBefore.length, 0);

  const dueAfter = scheduler.drainDue(Date.now() + 200);
  assert.equal(dueAfter.length, 1);
  assert.equal(dueAfter[0].id, id1);

  const cancelled = scheduler.cancel(id2);
  assert.equal(cancelled, true);
  assert.equal(scheduler.pending().length, 0);
});

test('12. Feature 12: RevokedMessageVault saves and lists revoked messages', () => {
  const vault = new RevokedMessageVault();
  vault.save({ id: 'r1', jid: 'user1', sender: 'user2', content: { text: 'deleted' }, revokedAt: Date.now() });

  assert.equal(vault.list().length, 1);
  assert.equal(vault.get('r1')?.sender, 'user2');
});

test('13. Feature 13: autoStickerConverter creates sticker payload', () => {
  const buf = Buffer.from('fake_image');
  const payload = autoStickerConverter(buf, 'MyPack', 'MyAuthor');

  assert.equal(payload.sticker, buf);
  assert.equal(payload.packname, 'MyPack');
  assert.equal(payload.author, 'MyAuthor');
});

test('14. Feature 14: vcardGenerator builds valid VCARD string', () => {
  const vcard = vcardGenerator([{ fn: 'John Doe', tel: '+15551234567', org: 'Nyx' }]);

  assert.ok(vcard.includes('BEGIN:VCARD'));
  assert.ok(vcard.includes('FN:John Doe'));
  assert.ok(vcard.includes('ORG:Nyx'));
  assert.ok(vcard.includes('waid=15551234567'));
});

test('15. Feature 15: GroupSecurityShield triggers lock on thresholds', () => {
  const shield = new GroupSecurityShield();
  let raid = false;

  for (let i = 0; i < 11; i++) {
    raid = shield.recordJoin('g1');
  }
  assert.equal(raid, true);
  assert.equal(shield.getStats('g1').isLocked, true);
});

test('16. Feature 16: newsletterPublisher sends to channel', async () => {
  const sock = fakeSocket();
  const sent = [];
  sock.sendMessage = async (jid, content) => {
    sent.push({ jid, content });
    return { key: { id: 'nl_1' } };
  };

  await newsletterPublisher(sock, '120363000000000000@newsletter', 'Channel update');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].jid, '120363000000000000@newsletter');
});

test('17. Feature 17: ChatAutoClear tracks TTL expiry', () => {
  const autoClear = new ChatAutoClear();
  const now = Date.now();
  autoClear.setTTL('chat1', 1000);

  assert.equal(autoClear.isExpired('chat1', now + 500), false);
  assert.equal(autoClear.isExpired('chat1', now + 1500), true);
});
