/**
 * JID canonicalisation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bareJid,
  canonicalThreadKey,
  deviceOf,
  isBroadcast,
  isGroup,
  isLid,
  isNewsletter,
  isPn,
  kindOf,
  phoneOf,
  sameUser,
  toLidJid,
  toPnJid,
  userOf,
} from '../dist/core/jid.js';

test('kindOf classifies every address family', () => {
  assert.equal(kindOf('1555@s.whatsapp.net'), 'pn');
  assert.equal(kindOf('999@lid'), 'lid');
  assert.equal(kindOf('123-456@g.us'), 'group');
  assert.equal(kindOf('status@broadcast'), 'broadcast');
  assert.equal(kindOf('123@newsletter'), 'newsletter');
  assert.equal(kindOf('43@bot'), 'bot');
  assert.equal(kindOf('garbage'), 'unknown');
  assert.equal(kindOf('@s.whatsapp.net'), 'unknown');
});

test('the family predicates agree with kindOf', () => {
  assert.equal(isPn('1@s.whatsapp.net'), true);
  assert.equal(isLid('1@lid'), true);
  assert.equal(isGroup('1@g.us'), true);
  assert.equal(isNewsletter('1@newsletter'), true);
  assert.equal(isBroadcast('s@broadcast'), true);
  assert.equal(isPn('1@lid'), false);
});

test('device suffix is stripped and reported independently', () => {
  assert.equal(deviceOf('1555:12@s.whatsapp.net'), 12);
  assert.equal(deviceOf('1555@s.whatsapp.net'), 0);
  assert.equal(bareJid('1555:12@s.whatsapp.net'), '1555@s.whatsapp.net');
  assert.equal(bareJid('1555@s.whatsapp.net'), '1555@s.whatsapp.net');
  assert.equal(userOf('1555:12@s.whatsapp.net'), '1555');
});

test('phoneOf only answers for phone-number jids', () => {
  assert.equal(phoneOf('+1 (555) 123-4567@s.whatsapp.net'), '15551234567');
  assert.equal(phoneOf('999@lid'), null);
  assert.equal(phoneOf('123@g.us'), null);
});

test('jid builders normalise their input', () => {
  assert.equal(toPnJid('+1 555-123-4567'), '15551234567@s.whatsapp.net');
  assert.equal(toLidJid('999'), '999@lid');
});

test('sameUser ignores device suffix and case but not family', () => {
  assert.equal(sameUser('1555:1@s.whatsapp.net', '1555:9@s.whatsapp.net'), true);
  assert.equal(sameUser('1555@s.whatsapp.net', '999@s.whatsapp.net'), false);
  assert.equal(sameUser('1555@s.whatsapp.net', '1555@lid'), false, 'families must not be bridged');
});

test('canonicalThreadKey is stable across device drift', () => {
  assert.equal(canonicalThreadKey('1555:1@s.whatsapp.net'), canonicalThreadKey('1555:99@s.whatsapp.net'));
  assert.equal(canonicalThreadKey('1555@s.whatsapp.net'), 'thread:1555');
});

test('canonicalThreadKey namespaces non-user families', () => {
  assert.equal(canonicalThreadKey('123-456@g.us'), 'thread:group:123-456');
  assert.equal(canonicalThreadKey('status@broadcast'), 'thread:broadcast:status');
  assert.equal(canonicalThreadKey('42@newsletter'), 'thread:newsletter:42');
});

test('canonicalThreadKey uses a LID resolver when one is supplied', () => {
  const resolve = (jid) => (jid === '999@lid' ? '1555@s.whatsapp.net' : null);
  assert.equal(canonicalThreadKey('999@lid', resolve), 'thread:1555');
  assert.equal(canonicalThreadKey('999@lid'), 'thread:lid:999', 'without a mapping, keep the LID form');
});

test('canonicalThreadKey never throws on junk', () => {
  assert.equal(canonicalThreadKey(''), 'thread:invalid');
  assert.equal(canonicalThreadKey(null), 'thread:invalid');
  assert.equal(canonicalThreadKey('no-at-sign'), 'thread:unknown:no-at-sign');
});
