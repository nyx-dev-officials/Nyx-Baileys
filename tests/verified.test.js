import { test } from 'node:test';
import assert from 'node:assert/strict';

import { verifiedSpoof } from '../dist/plugins/Verified.js';
import { applyPlugin, fakeSocket } from './helpers.js';

test('verifiedSpoof decorates outgoing message with verified quote and contextInfo', async () => {
  const sock = fakeSocket();
  const sentArgs = [];
  sock.sendMessage = async (jid, content, opts) => {
    sentArgs.push({ jid, content, opts });
    return { key: { id: 'sent_id_123' } };
  };

  const harness = applyPlugin(verifiedSpoof({ displayName: 'TestVerified' }), sock);

  // Trigger send through the patched method
  const res = await sock.sendMessage('15551234567@s.whatsapp.net', { text: 'Hello' });

  assert.equal(res.key.id, 'sent_id_123');
  assert.equal(sentArgs.length, 1);
  const sent = sentArgs[0];

  assert.ok(sent.opts);
  assert.ok(sent.opts.quoted);
  assert.equal(sent.opts.quoted.key.remoteJid, 'status@broadcast');
  assert.equal(sent.opts.quoted.key.participant, '0@s.whatsapp.net');
  assert.equal(sent.opts.quoted.message.contactMessage.displayName, 'TestVerified');

  const ctx = sent.content.contextInfo;
  assert.ok(ctx);
  assert.equal(ctx.isForwarded, true);
  assert.equal(ctx.forwardingScore, 1);
  assert.equal(ctx.forwardedNewsletterMessageInfo.newsletterName, 'TestVerified');
  assert.equal(ctx.businessMessageForwardInfo.businessOwnerJid, '0@s.whatsapp.net');
  assert.equal(ctx.smbClientCampaignId, 'NYX_ENTERPRISE_PROTOCOL');
  assert.ok(ctx.messageSecret);

  harness.dispose();
});

test('verifiedSpoof options.enabled=false skips patching', async () => {
  const sock = fakeSocket();
  const pristine = sock.sendMessage;
  applyPlugin(verifiedSpoof({ enabled: false }), sock);

  assert.equal(sock.sendMessage, pristine);
});
