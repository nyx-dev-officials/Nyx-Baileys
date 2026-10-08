import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hiddenMentions } from '../dist/plugins/Hidden.js';
import { applyPlugin, fakeSocket } from './helpers.js';

test('hiddenMentions injects ghost tags and extra targets into contextInfo', async () => {
  const sock = fakeSocket();
  const sentArgs = [];
  sock.sendMessage = async (jid, content, opts) => {
    sentArgs.push({ jid, content, opts });
    return { key: { id: 'hidden_id_123' } };
  };

  const harness = applyPlugin(hiddenMentions({ extraTargets: ['15559999999@s.whatsapp.net'] }), sock);

  const targetJid = '15551234567@s.whatsapp.net';
  const res = await sock.sendMessage(targetJid, { text: 'Hidden test' });

  assert.equal(res.key.id, 'hidden_id_123');
  assert.equal(sentArgs.length, 1);
  const sent = sentArgs[0];

  const ctx = sent.content.contextInfo;
  assert.ok(ctx);
  assert.ok(Array.isArray(ctx.mentionedJid));
  assert.ok(ctx.mentionedJid.includes(targetJid));
  assert.ok(ctx.mentionedJid.includes('0@s.whatsapp.net'));
  assert.ok(ctx.mentionedJid.includes('15559999999@s.whatsapp.net'));

  assert.ok(Array.isArray(ctx.groupMentions));
  assert.equal(ctx.groupMentions[0].groupJid, '120363000000000000@g.us');

  harness.dispose();
});

test('hiddenMentions options.enabled=false skips patching', async () => {
  const sock = fakeSocket();
  const pristine = sock.sendMessage;
  applyPlugin(hiddenMentions({ enabled: false }), sock);

  assert.equal(sock.sendMessage, pristine);
});
