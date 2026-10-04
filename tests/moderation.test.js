/**
 * Group moderation.
 *
 * Two things this file exists to pin:
 *
 *   1. **The ladder is data.** Every threshold in `strikes` is configuration, so
 *      the tests walk the *same* ladder at different settings rather than
 *      assuming one ladder. A test that only ever runs the defaults cannot tell
 *      a working threshold from a hardcoded one.
 *   2. **Exemptions are checked on both paths.** Not just before a message is
 *      counted, but before an action is taken — including the imperative
 *      `kick()`/`ban()`. A mod bot that removes the human running it is the
 *      outage this design exists to prevent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { moderation } from '../dist/plugins/moderation.js';

import { GROUP, applyPlugin, fakeSocket, flush, pn, upsert } from './helpers.js';

const OTHER = '999@g.us';

function rig(options = {}) {
  const sock = fakeSocket();
  const events = [];
  const actions = [];
  sock.ev.on('nyx.moderation', (e) => events.push(e));

  // Record what actually happened on WhatsApp, as opposed to what was emitted.
  const removes = [];
  sock.groupParticipantsUpdate = (groupId, participants, action) => {
    removes.push({ groupId, participants, action });
  };

  applyPlugin(moderation({ announce: (e) => actions.push(e), ...options }), sock);

  /**
   * The action path is genuinely async: a delete is a send, and a removal is a
   * socket call. `flush()` settles both so assertions can run synchronously
   * against the outcome rather than against a promise.
   */
  const say = async (text, jid = pn(1), group = GROUP, id) => {
    upsert(sock, [
      {
        key: { remoteJid: group, id: id ?? `M-${text}-${Math.random()}`, participant: jid },
        messageTimestamp: 1_700_000_000_000,
        message: { conversation: text },
      },
    ]);
    await flush();
  };

  const deletes = () => sock.sent.filter((s) => s.content?.delete);

  return { sock, events, actions, removes, say, api: sock.__moderation, deletes };
}

/* ── words ───────────────────────────────────────────────────────────── */

test('a word rule strikes and the message is deleted at strike one', async () => {
  const { say, deletes, events } = rig({ words: [{ pattern: 'free crypto' }] });

  await say('get FREE CRYPTO now');

  assert.equal(deletes().length, 1, 'the offending message is deleted');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'word');
  assert.equal(events[0].strikes, 1);
});

test('string rules are substring matches, regex rules are honoured as written', async () => {
  const { say, events } = rig({ words: [{ pattern: ['badword', /spo+t/] }] });

  await say('this is a badword here');
  await say('a spoooot pattern');
  await say('perfectly innocent text');

  assert.equal(events.length, 2, 'the innocent message produces nothing');
  assert.equal(events[0].reason, 'word filter');
});

test('a custom label is what gets reported', async () => {
  const { say, events } = rig({ words: [{ pattern: 'scam', label: 'crypto scam' }] });
  await say('this is a scam');
  assert.equal(events[0].reason, 'crypto scam');
});

test('strike: false reports without escalating', async () => {
  const { say, events, deletes } = rig({ words: [{ pattern: 'scam', strike: false }] });

  await say('scam');
  await say('scam again');

  assert.equal(events.length, 2);
  assert.equal(events.every((e) => e.kind === 'word'), true);
  assert.equal(deletes().length, 0, 'no deletion when the rule does not strike');
  assert.equal(events.every((e) => e.strikes === 0), true);
});

/* ── the ladder ──────────────────────────────────────────────────────── */

test('the ladder escalates delete → kick → ban as strikes accumulate', async () => {
  const { say, removes, events } = rig({
    words: [{ pattern: 'spam' }],
    strikes: { deleteAt: 1, muteAt: 2, kickAt: 3, banAt: 5 },
  });

  await say('spam');
  assert.equal(events[0].kind, 'word', 'strike 1: delete only');

  await say('spam');
  assert.equal(events[1].kind, 'mute', 'strike 2: muted');

  await say('spam');
  assert.equal(events[2].kind, 'kick', 'strike 3: removed');
  assert.equal(removes.length, 1);

  await say('spam');
  assert.equal(events[3].kind, 'kick', 'strike 4 is still over the kick threshold');
  assert.equal(removes.length, 1, 'but an already-removed member is not removed twice');

  await say('spam');
  assert.equal(events[4].kind, 'ban', 'strike 5: banned');
  assert.equal(removes.length, 2);
});

test('mute expiry is carried on the event', async () => {
  const { say, events } = rig({
    words: [{ pattern: 'spam' }],
    strikes: { muteAt: 1, muteMs: 60_000 },
  });

  const before = Date.now();
  await say('spam');

  assert.equal(events[0].kind, 'mute');
  assert.ok(events[0].mutedUntil >= before + 60_000 - 5, 'mute runs for the configured span');
});

test('a kick threshold of Infinity never removes anyone', async () => {
  const { say, removes } = rig({
    words: [{ pattern: 'spam' }],
    strikes: { deleteAt: 1, kickAt: Number.POSITIVE_INFINITY },
  });

  for (let i = 0; i < 10; i += 1) await say('spam');

  assert.equal(removes.length, 0);
});

test('a ban resets the ladder so re-entry is a fresh offence', async () => {
  const { say, api, removes } = rig({
    words: [{ pattern: 'spam' }],
    strikes: { deleteAt: 1, kickAt: 5, banAt: 6 },
  });

  for (let i = 0; i < 6; i += 1) await say('spam');
  assert.equal(api.isBanned(GROUP, pn(1)), true);
  assert.equal(removes.length, 2, 'one kick at strike 5, one ban at strike 6');
  const before = removes.length;

  await say('spam', pn(1), GROUP, 'AFTER');
  assert.equal(removes.length, before + 1, 'the re-added member is removed again');
  assert.equal(api.strikesOf(GROUP, pn(1)), 0, 'a banned member is not re-struck');
});

/* ── links ───────────────────────────────────────────────────────────── */

test('WhatsApp invite links are blocked by default, plain URLs are not', async () => {
  const { say, events, deletes } = rig({ links: { blockInvite: true } });

  await say('join here https://chat.whatsapp.com/ABCDEF');
  await say('read this https://example.com/article');

  assert.equal(events.length, 1, 'only the invite link is actioned');
  assert.equal(events[0].reason, 'invite link');
  assert.equal(deletes().length, 1);
});

test('wa.me short links count as invites', async () => {
  const { say, events } = rig({ links: {} });
  await say('whatsapp me https://wa.me/abcd1234');
  assert.equal(events[0].reason, 'invite link');
});

test('blockAll catches everything, allowDomains lets the listed ones through', async () => {
  const { say, events } = rig({
    links: { blockAll: true, allowDomains: ['example.com'] },
  });

  await say('see https://example.com/ok');
  await say('see https://spam.example.org/bad');

  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'https://spam.example.org/bad');
});

test('link: strike false reports the URL without touching the ladder', async () => {
  const { say, events, deletes } = rig({ links: { blockInvite: true, strike: false } });

  await say('https://chat.whatsapp.com/ABC');

  assert.equal(events[0].kind, 'link');
  assert.equal(events[0].reason, 'https://chat.whatsapp.com/ABC');
  assert.equal(deletes().length, 0);
});

test('one bad link in a message is one offence, not one per URL', async () => {
  const { say, events } = rig({ links: { blockAll: true } });
  await say('a https://x.test/1 b https://x.test/2 c https://chat.whatsapp.com/Z');
  assert.equal(events.length, 1);
});

/* ── flood ───────────────────────────────────────────────────────────── */

test('each message over the flood ceiling is its own offence', async () => {
  const { say, events } = rig({
    flood: { max: 3, windowMs: 60_000 },
    words: [{ pattern: 'spam' }],
  });

  for (let i = 0; i < 8; i += 1) await say('hello');

  // 8 messages, 3 allowed, 5 offences. An implementation that cleared the
  // window on trigger would report 2 and never climb the ladder.
  assert.equal(events.length, 5);
  assert.equal(events[0].kind, 'flood');
  assert.deepEqual(events.map((e) => e.strikes), [1, 2, 3, 4, 5]);
});

test('the flood window is per member', async () => {
  const { say, events } = rig({ flood: { max: 2, windowMs: 60_000 } });

  await say('a', pn(1));
  await say('a', pn(1));
  await say('a', pn(1));
  await say('a', pn(2));

  assert.equal(events.length, 1);
  assert.equal(events[0].jid, pn(1));
});

test('flood: strike false counts without striking', async () => {
  const { say, events } = rig({ flood: { max: 2, windowMs: 60_000, strike: false } });

  for (let i = 0; i < 5; i += 1) await say('hello');
  assert.equal(events.length, 0);
});

test('an exempt member is not even counted against the flood window', async () => {
  const { say, events } = rig({
    flood: { max: 2, windowMs: 60_000 },
    exempt: (jid) => jid === pn(9),
  });

  for (let i = 0; i < 10; i += 1) await say('hello', pn(9));
  assert.equal(events.length, 0);

  for (let i = 0; i < 10; i += 1) await say('hello', pn(1));
  assert.equal(events.length, 8, 'the ordinary member is not exempted either');
});

/* ── exemptions ──────────────────────────────────────────────────────── */

test('admins and exempt members are never actioned by the message path', async () => {
  const { say, deletes, removes } = rig({
    words: [{ pattern: 'spam' }],
    flood: { max: 1, windowMs: 60_000 },
    exempt: (jid) => jid === pn(2),
    isAdmin: (jid) => jid === pn(3),
  });

  await say('spam', pn(2));
  await say('spam', pn(3));

  assert.equal(deletes().length, 0);
  assert.equal(removes.length, 0);
});

test('the exemption is also honoured on the imperative path', async () => {
  const { api, removes } = rig({ exempt: (jid) => jid === pn(2), isAdmin: (jid) => jid === pn(3) });

  await api.kick(GROUP, pn(2));
  await api.ban(GROUP, pn(3));
  await api.mute(GROUP, pn(2));

  assert.equal(removes.length, 0);
  assert.equal(api.isMuted(GROUP, pn(2)), false);
});

test('the imperative path works on an ordinary member', async () => {
  const { api, removes, events } = rig();

  await api.kick(GROUP, pn(1));
  assert.equal(removes[0].action, 'remove');
  assert.equal(events.at(-1).kind, 'kick');

  await api.ban(GROUP, pn(4));
  assert.equal(api.isBanned(GROUP, pn(4)), true);

  api.unban(GROUP, pn(4));
  assert.equal(api.isBanned(GROUP, pn(4)), false);
});

/* ── scope ───────────────────────────────────────────────────────────── */

test('out-of-scope groups, direct chats and own messages are all ignored', async () => {
  const { say, events } = rig({
    words: [{ pattern: 'spam' }],
    groups: (id) => id === GROUP,
  });

  await say('spam', pn(1), OTHER);
  await say('spam', pn(1), '15551234567@s.whatsapp.net');
  assert.equal(events.length, 0);
});

test('a message sent by the account itself is not moderated', async () => {
  const sock = fakeSocket();
  const events = [];
  sock.ev.on('nyx.moderation', (e) => events.push(e));
  applyPlugin(moderation({ words: [{ pattern: 'spam' }] }), sock);

  upsert(sock, [
    {
      key: { remoteJid: GROUP, id: 'MINE', fromMe: true, participant: 'me@s.whatsapp.net' },
      messageTimestamp: 1,
      message: { conversation: 'spam spam spam' },
    },
  ]);

  assert.equal(events.length, 0);
});

/* ── muted members ───────────────────────────────────────────────────── */

test('a mute is advisory: the ladder keeps running past it', async () => {
  const { say, events, api } = rig({
    words: [{ pattern: 'spam' }],
    strikes: { muteAt: 1, muteMs: 10_000, kickAt: 3 },
  });

  await say('spam');
  assert.equal(api.isMuted(GROUP, pn(1)), true, 'the advisory flag is set');
  assert.equal(events[0].kind, 'mute');

  // The whole reason the plugin does not return early on a mute: a mute that
  // stopped evaluation would make muteAt a permanent ceiling, and the member
  // could never be kicked or banned.
  await say('spam');
  await say('spam');
  assert.equal(events[2].kind, 'kick', 'the ladder reached the kick');
  assert.equal(api.isMuted(GROUP, pn(1)), true, 'still muted — kicking does not clear it');
});

test('unmute puts a member back under the rules', async () => {
  const { say, events, api } = rig({
    words: [{ pattern: 'spam' }],
    strikes: { muteAt: 1, muteMs: 60_000 },
  });

  await say('spam');
  api.unmute(GROUP, pn(1));
  await say('spam');

  assert.equal(events.length, 2);
});

test('someone re-added after a ban is removed again', async () => {
  const { say, removes, events, api } = rig({
    words: [{ pattern: 'spam' }],
    strikes: { deleteAt: 5, banAt: 5 },
  });

  for (let i = 0; i < 5; i += 1) await say('spam');
  assert.equal(api.isBanned(GROUP, pn(1)), true);
  const before = removes.length;

  await say('spam', pn(1), GROUP, 'RETURN');

  assert.equal(removes.length, before + 1, 'the re-add is removed');
  assert.equal(events.at(-1).reason, 're-added after ban');
});

/* ── dry run ─────────────────────────────────────────────────────────── */

test('dry run emits every event and changes nothing on WhatsApp', async () => {
  const { say, deletes, removes, events, api } = rig({
    dryRun: true,
    words: [{ pattern: 'spam' }],
    strikes: { deleteAt: 1, kickAt: 2, banAt: 3 },
  });

  for (let i = 0; i < 5; i += 1) await say('spam');

  assert.equal(deletes().length, 0, 'no deletes');
  assert.equal(removes.length, 0, 'no removals');
  assert.ok(events.length >= 3, 'but every decision is still reported');
  assert.equal(api.stats().dryRun, true);
});

test('the manual API still records state in dry run', async () => {
  const { api } = rig({ dryRun: true });

  await api.mute(GROUP, pn(1));
  await api.ban(GROUP, pn(2));

  assert.equal(api.isMuted(GROUP, pn(1)), true);
  assert.equal(api.isBanned(GROUP, pn(2)), true);
});

/* ── stats and disposal ──────────────────────────────────────────────── */

test('stats reflect live state', async () => {
  const { api } = rig();

  await api.mute(GROUP, pn(1));
  await api.ban(GROUP, pn(2));

  assert.deepEqual(api.stats(), { members: 2, muted: 1, banned: 1, dryRun: false });

  api.reset();
  assert.deepEqual(api.stats(), { members: 0, muted: 0, banned: 0, dryRun: false });
});

test('dispose clears the moderation state', async () => {
  const sock = fakeSocket();
  sock.groupParticipantsUpdate = () => {};
  const harness = applyPlugin(moderation(), sock);

  await sock.__moderation.mute(GROUP, pn(1));
  assert.equal(sock.__moderation.stats().muted, 1);

  harness.dispose();
  assert.equal(sock.__moderation.stats().muted, 0);
});
/* ── announceAt ───────────────────────────────────────────────────────── */

/** Sends into the group that are announcements rather than deletes. */
const posts = (sock) => sock.sent.filter((s) => s.content?.text);

test('nothing is posted into the group unless announceAt is configured', async () => {
  const { sock, say } = rig({ words: [{ pattern: 'scam' }], strikes: { kickAt: 2 } });

  await say('scam');
  await say('scam');

  assert.equal(posts(sock).length, 0, 'Infinity means off, not "very high"');
});

test('announceAt posts into the group from that strike upward', async () => {
  const { sock, say } = rig({
    words: [{ pattern: 'scam' }],
    strikes: { announceAt: 2, kickAt: 3 },
  });

  await say('scam');
  assert.equal(posts(sock).length, 0, 'below the rung, nothing is said');

  await say('scam');
  assert.equal(posts(sock).length, 1);

  await say('scam');
  assert.equal(posts(sock).length, 2, 'the same >= shape as every other rung, so it keeps firing');
});

test('the announcement names the outcome, not the rule that fired', async () => {
  const { sock, say } = rig({
    words: [{ pattern: 'scam' }],
    strikes: { announceAt: 1, muteAt: 1, muteMs: 600_000 },
  });

  await say('scam');

  const [post] = posts(sock);
  assert.match(post.content.text, /^Muted 1 for 10m\.$/);
});

test('a kick announcement reports the strike that caused it', async () => {
  const { sock, say } = rig({ words: [{ pattern: 'scam' }], strikes: { announceAt: 2, kickAt: 2 } });

  await say('scam');
  await say('scam');

  const post = posts(sock).at(-1);
  assert.match(post.content.text, /^Removed 1 — strike 2\.$/);
});

test('announceText replaces the wording, and an empty string silences it', async () => {
  const withText = rig({
    words: [{ pattern: 'scam' }],
    strikes: { announceAt: 1 },
    announceText: (e) => `custom line for strike ${e.strikes}`,
  });
  await withText.say('scam');
  assert.match(posts(withText.sock).at(-1).content.text, /custom line for strike 1/);

  const silenced = rig({
    words: [{ pattern: 'scam' }],
    strikes: { announceAt: 1 },
    announceText: () => '',
  });
  await silenced.say('scam');
  assert.equal(posts(silenced.sock).length, 0);
});

test('a dry run decides the announcement but does not post it', async () => {
  const { sock, say, events } = rig({
    words: [{ pattern: 'scam' }],
    strikes: { announceAt: 1, banAt: 1 },
    dryRun: true,
  });

  await say('scam');

  assert.equal(posts(sock).length, 0, 'posting into a group is a visible side effect');
  assert.equal(events.length, 1, 'but the decision is still reported');
  assert.equal(events[0].kind, 'ban');
});

test('the announcement goes out after the removal, not before', async () => {
  const order = [];
  const sock = fakeSocket();
  sock.ev.on('nyx.moderation', () => order.push('event'));
  sock.groupParticipantsUpdate = () => order.push('remove');
  const original = sock.sendMessage.bind(sock);
  sock.sendMessage = (jid, content, extra) => {
    if (content?.text) order.push('post');
    return original(jid, content, extra);
  };

  const harness = applyPlugin(
    moderation({ words: [{ pattern: 'scam' }], strikes: { announceAt: 1, kickAt: 1 } }),
    sock,
  );

  upsert(sock, [
    {
      key: { remoteJid: GROUP, id: 'M-order', participant: pn(1) },
      messageTimestamp: 1_700_000_000_000,
      message: { conversation: 'scam' },
    },
  ]);
  await flush();
  harness.dispose();

  assert.deepEqual(order, ['remove', 'post', 'event']);
});
