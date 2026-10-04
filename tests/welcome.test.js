/**
 * Join / leave announcements.
 *
 * The thing that actually breaks in production here is *volume*: a mass add, a
 * bot loop, or a cooldown that does not hold. Those are the cases the tests
 * lead with, because "it sends a welcome" is the part that always works.
 *
 * It also pins the rc14 participant shape — participants arrive as
 * `GroupParticipant` objects, not bare jid strings, and getting that wrong
 * silently produces `[object Object]` in the message body.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { welcome } from '../dist/plugins/welcome.js';

import { GROUP, applyPlugin, fakeSocket, flush, pn } from './helpers.js';

const OTHER = '999@g.us';

function rig(options = {}) {
  const sock = fakeSocket();
  applyPlugin(welcome({ cooldownMs: 0, rejoinWindowMs: 0, ...options }), sock);

  const join = (participants, group = GROUP, action = 'add') =>
    sock.ev.emit('group-participants.update', {
      id: group,
      participants: participants.map((id) => ({ id })),
      action,
    });

  const texts = () => sock.sent.map((s) => s.content?.text).filter(Boolean);

  return { sock, join, texts, snapshot: sock.__welcome.snapshot };
}

/* ── the basic announcements ─────────────────────────────────────────── */

test('someone joining produces a welcome with them mentioned', () => {
  const { join, texts, sock } = rig({ templates: { add: 'Welcome, {name}!' } });

  join([pn(1)]);

  assert.equal(sock.sent.length, 1);
  assert.equal(sock.sent[0].jid, GROUP);
  assert.equal(sock.sent[0].content.text, 'Welcome, 1!');
  assert.deepEqual(sock.sent[0].content.mentionedJid, [pn(1)]);
  assert.ok(texts().length === 1);
});

test('leaving, promoting and demoting each have their own event', () => {
  const { join, texts } = rig({
    events: { demote: true },
    templates: {
      remove: '{name} left',
      promote: '{name} promoted',
      demote: '{name} demoted',
    },
  });

  join([pn(1)], GROUP, 'remove');
  join([pn(1)], GROUP, 'promote');
  join([pn(1)], GROUP, 'demote');

  assert.deepEqual(texts(), ['1 left', '1 promoted', '1 demoted']);
});

test('demotion is off by default — it is noisy and rarely wanted', () => {
  const { join, texts } = rig({ templates: { demote: '{name} demoted' } });
  join([pn(1)], GROUP, 'demote');
  assert.equal(texts().length, 0, 'a template alone does not enable the event');
});

test('an event can be switched off explicitly', () => {
  const { join, texts } = rig({ events: { add: false } });
  join([pn(1)]);
  assert.equal(texts().length, 0);
});

/* ── volume, which is the real failure mode ──────────────────────────── */

test('a mass add collapses to a single bundled line, not N welcomes', () => {
  const { join, texts } = rig();

  join([pn(1), pn(2), pn(3), pn(4), pn(5)]);

  assert.equal(texts().length, 1, 'one line for the whole event');
  assert.equal(texts()[0], '5 people joined.');
});

test('maxPerEvent: 0 announces nothing at all for a mass add', () => {
  const { join, texts, snapshot } = rig({ maxPerEvent: 0 });
  join([pn(1), pn(2)]);
  assert.equal(texts().length, 0);
  assert.equal(snapshot().skipped, 1);
});

test('the cooldown suppresses a flood of one-at-a-time joins', () => {
  const { join, texts, snapshot } = rig({ cooldownMs: 60_000 });

  join([pn(1)]);
  join([pn(2)]);
  join([pn(3)]);

  assert.equal(texts().length, 1, 'only the first got through');
  assert.equal(snapshot().skipped, 2);
});

/* ── rejoin suppression ──────────────────────────────────────────────── */

test('someone who rejoins inside the window is not welcomed twice', () => {
  const { join, texts, snapshot } = rig({ rejoinWindowMs: 60_000 });

  join([pn(1)]);
  join([pn(2)]);
  join([pn(1)]);

  assert.equal(texts().length, 2, 'the return trip is silent');
  assert.equal(snapshot().skipped, 1);
});

test('the rejoin window is per group, not global', () => {
  const { join, texts } = rig({ rejoinWindowMs: 60_000 });

  join([pn(1)], GROUP);
  join([pn(1)], OTHER);

  assert.equal(texts().length, 2, 'the same jid in another group is a first arrival');
});

/* ── naming ──────────────────────────────────────────────────────────── */

test('names are off by default, so the local part of the jid is used', () => {
  const { join, texts } = rig({ templates: { add: 'Hi {name}' } });
  join(['15551234567@s.whatsapp.net']);
  assert.equal(texts()[0], 'Hi 15551234567');
});

test('useNames takes the name from the resolver, never from the event', () => {
  const { join, texts } = rig({
    useNames: true,
    nameOf: (jid) => (jid === pn(1) ? 'Alice' : undefined),
    templates: { add: 'Hi {name}' },
  });

  join([pn(1)]);
  assert.equal(texts()[0], 'Hi Alice');
});

/* ── mention modes ───────────────────────────────────────────────────── */

test('mention none sends plain text and tags nobody', () => {
  const { join, sock } = rig({ mention: 'none' });
  join([pn(1)]);
  assert.equal(sock.sent[0].content.mentionedJid, undefined);
});

test('a collapsed event carries no mentions', () => {
  const { join, sock } = rig();
  join([pn(1), pn(2), pn(3)]);
  assert.equal(sock.sent[0].content.mentionedJid, undefined);
});

/* ── scope and shape ─────────────────────────────────────────────────── */

test('groups outside the scope are silent', () => {
  const { join, texts } = rig({ groups: (id) => id === GROUP });
  join([pn(1)], OTHER);
  assert.equal(texts().length, 0);
});

test('rc14 participant objects are understood', () => {
  const sock = fakeSocket();
  applyPlugin(welcome({ cooldownMs: 0 }), sock);

  sock.ev.emit('group-participants.update', {
    id: GROUP,
    participants: [{ id: pn(1), isAdmin: true }],
    action: 'add',
  });

  assert.equal(sock.sent.length, 1);
  assert.ok(!String(sock.sent[0].content.text).includes('object'));
});

test('bare string participants still work', () => {
  const sock = fakeSocket();
  applyPlugin(welcome({ cooldownMs: 0 }), sock);

  sock.ev.emit('group-participants.update', {
    id: GROUP,
    participants: [pn(1)],
    action: 'add',
  });

  assert.equal(sock.sent.length, 1);
});

test('an empty participant list produces nothing', () => {
  const { join, texts } = rig();
  join([]);
  assert.equal(texts().length, 0);
});

test('a non-group update produces nothing', () => {
  const sock = fakeSocket();
  applyPlugin(welcome({ cooldownMs: 0 }), sock);
  sock.ev.emit('group-participants.update', {
    id: '15551234567@s.whatsapp.net',
    participants: [{ id: pn(1) }],
    action: 'add',
  });
  assert.equal(sock.sent.length, 0);
});

/* ── snapshot ────────────────────────────────────────────────────────── */

test('the snapshot counts sends and skips', () => {
  const { join, snapshot } = rig({ cooldownMs: 60_000, rejoinWindowMs: 60_000 });

  join([pn(1)]);
  join([pn(2)]);
  join([pn(1)]);

  const s = snapshot();
  assert.equal(s.sent, 1);
  assert.equal(s.skipped, 2);
  assert.equal(s.lastGroup, GROUP);
  assert.ok(s.lastAt > 0);
});

test('reset clears the counters', () => {
  const { join, snapshot, sock } = rig();
  join([pn(1)]);
  sock.__welcome.reset();
  assert.equal(snapshot().sent, 0);
});
/* ── dry run ─────────────────────────────────────────────────────────── */

/**
 * `dryRun` exists because this plugin had no way to be exercised against a live
 * socket without posting to a real group. That is not hypothetical: the first
 * version of `nyx-baileys selftest` emitted a synthetic join into a live socket,
 * and the plugin tried to send to a group id that does not exist. The send failed
 * so nothing reached WhatsApp, but an attempted send is exactly what the command
 * promises not to do.
 *
 * These pin the contract: every decision still happens and is still reported, and
 * the only thing skipped is the network call.
 */
test('a dry run reports the announcement and sends nothing', async () => {
  const sock = fakeSocket();
  applyPlugin(welcome({ cooldownMs: 0, rejoinWindowMs: 0, dryRun: true }), sock);

  const events = [];
  sock.ev.on('nyx.welcome', (e) => events.push(e));

  sock.ev.emit('group-participants.update', {
    id: GROUP,
    participants: [{ id: pn(1) }],
    action: 'add',
  });
  await flush();

  assert.equal(sock.sent.length, 0, 'nothing was sent into the group');
  assert.equal(events.length, 1, 'but the decision was still reported');
  assert.equal(events[0].dryRun, true);
  assert.match(events[0].text, /Welcome to the group/);
});

test('a dry run still counts the announcement in the snapshot', async () => {
  const sock = fakeSocket();
  applyPlugin(welcome({ cooldownMs: 0, rejoinWindowMs: 0, dryRun: true }), sock);

  sock.ev.emit('group-participants.update', {
    id: GROUP,
    participants: [{ id: pn(1) }],
    action: 'add',
  });
  await flush();

  // The snapshot is what an operator watches to confirm the plugin is deciding
  // correctly, so a dry run that reported nothing would be useless — the same
  // reasoning as moderation's dry run recording state before the check.
  assert.equal(sock.__welcome.snapshot().sent, 1);
});

test('a dry run still applies cooldown and rejoin suppression', async () => {
  const sock = fakeSocket();
  applyPlugin(welcome({ cooldownMs: 0, rejoinWindowMs: 60_000, dryRun: true }), sock);

  const join = (id) =>
    sock.ev.emit('group-participants.update', { id: GROUP, participants: [{ id }], action: 'add' });

  join(pn(1));
  await flush();
  join(pn(1));
  await flush();

  const snap = sock.__welcome.snapshot();
  assert.equal(snap.sent, 1, 'the repeat was suppressed, not announced twice');
  assert.equal(snap.skipped, 1);
});

test('without dryRun the message really is sent', async () => {
  const sock = fakeSocket();
  applyPlugin(welcome({ cooldownMs: 0, rejoinWindowMs: 0 }), sock);

  sock.ev.emit('group-participants.update', {
    id: GROUP,
    participants: [{ id: pn(1) }],
    action: 'add',
  });
  await flush();

  assert.equal(sock.sent.length, 1, 'the default path is unchanged');
  assert.equal(sock.sent[0].jid, GROUP);
});
