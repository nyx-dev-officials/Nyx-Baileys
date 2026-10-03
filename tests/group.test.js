/**
 * Group policy guard.
 *
 * The threshold semantics are the point of this file. An earlier version pushed
 * both jids *and* timestamps into one array and inferred the count by halving
 * its length — wrong arithmetic, and the reason the alert was noisy. The fixed
 * version keeps a per-group list of join timestamps. These tests pin down what
 * that list actually counts (add *events*, not participants) so the regression
 * cannot come back quietly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { groupGuard } from '../dist/plugins/group.js';

import { GROUP, applyPlugin, fakeSocket, lid, pn, sleep } from './helpers.js';

const OTHER_GROUP = '999-888@g.us';

function rig(options = {}) {
  const sock = fakeSocket();
  const seen = [];
  sock.ev.on('super.groupAlert', (alert) => seen.push(alert));
  const harness = applyPlugin(groupGuard(options), sock);
  return { sock, seen, alerts: sock.groupAlerts, admins: sock.groupAdmins, ...harness };
}

const add = (sock, participants, group = GROUP) =>
  sock.ev.emit('group-participants.update', { id: group, participants, action: 'add' });

const promote = (sock, participants, group = GROUP) =>
  sock.ev.emit('group-participants.update', { id: group, participants, action: 'promote' });

const demote = (sock, participants, group = GROUP) =>
  sock.ev.emit('group-participants.update', { id: group, participants, action: 'demote' });

/* ── mass add ────────────────────────────────────────────────────────── */

test('the mass-add alert fires once the threshold is reached', () => {
  const { sock, alerts, seen } = rig({ massAddThreshold: 3 });

  add(sock, [pn(1)]);
  add(sock, [pn(2)]);
  assert.equal(alerts.length, 0, 'fired below the threshold');

  add(sock, [pn(3)]);

  assert.equal(alerts.length, 1);
  assert.equal(seen.length, 1, 'the alert is also emitted on the event bus');
  assert.equal(alerts[0].kind, 'mass-add');
  assert.equal(alerts[0].groupId, GROUP);
  assert.deepEqual(alerts[0].participants, [pn(3)], 'participants come from the triggering event');
  assert.equal(alerts[0].detail, '3 joins within 10m');
  assert.equal(typeof alerts[0].at, 'number');
});

test('a sub-threshold burst produces no alert at all', () => {
  const { sock, alerts } = rig({ massAddThreshold: 5 });

  for (let i = 1; i <= 4; i += 1) add(sock, [pn(i)]);

  assert.equal(alerts.length, 0);
  assert.deepEqual([...sock.groupAlerts], []);
});

test('the threshold counts add EVENTS, not participants in them', () => {
  // This is the exact regression guard. A single `add` event carrying five
  // participants records ONE join timestamp, so it cannot on its own reach a
  // threshold of two — even though five people just joined.
  const { sock, alerts } = rig({ massAddThreshold: 2 });

  add(sock, [pn(1), pn(2), pn(3), pn(4), pn(5)]);
  assert.equal(alerts.length, 0, 'one event is one join');

  add(sock, [pn(6), pn(7)]);
  assert.equal(alerts.length, 1, 'the second event reaches the threshold');
  assert.equal(alerts[0].detail, '2 joins within 10m');
  assert.deepEqual(
    alerts[0].participants,
    [pn(6), pn(7)],
    'the alert lists the participants of the event that crossed it',
    'not all seven',
  );
});

test('the alert keeps firing past the threshold', () => {
  const { sock, alerts } = rig({ massAddThreshold: 2 });

  for (let i = 1; i <= 5; i += 1) add(sock, [pn(i)]);

  assert.equal(alerts.length, 4, 'events 2, 3, 4 and 5 each cross the threshold');
  assert.deepEqual(
    alerts.map((a) => a.detail),
    ['2 joins within 10m', '3 joins within 10m', '4 joins within 10m', '5 joins within 10m'],
  );
});

test('joins older than the window stop counting', async () => {
  const { sock, alerts } = rig({ massAddThreshold: 3, windowMs: 5 });

  add(sock, [pn(1)]);
  add(sock, [pn(2)]);
  await sleep(30);

  // The window has passed, so this is join #1 in the fresh window, not #3.
  add(sock, [pn(3)]);
  assert.equal(alerts.length, 0, 'stale joins were not expired from the window');

  add(sock, [pn(4)]);
  assert.equal(alerts.length, 0);

  add(sock, [pn(5)]);
  assert.equal(alerts.length, 1, 'three joins inside the new window');
  assert.equal(alerts[0].detail, '3 joins within 0m', 'the window is rendered in whole minutes');
});

test('the window is tracked per group', () => {
  const { sock, alerts } = rig({ massAddThreshold: 2 });

  add(sock, [pn(1)], GROUP);
  add(sock, [pn(2)], OTHER_GROUP);
  assert.equal(alerts.length, 0, 'one join each is not two anywhere');

  add(sock, [pn(3)], GROUP);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].groupId, GROUP);
  assert.equal(alerts[0].detail, '2 joins within 10m');
});

test('participant jids are read from both string and object forms', () => {
  const { sock, alerts } = rig({ massAddThreshold: 1 });

  add(sock, [{ id: pn(9) }, { jid: pn(10) }, pn(11)]);

  assert.deepEqual(alerts[0].participants, [pn(9), pn(10), pn(11)]);
});

test('a join event with no participants still counts as one join', () => {
  const { sock, alerts } = rig({ massAddThreshold: 2 });

  add(sock, []);
  assert.equal(alerts.length, 0);
  add(sock, []);
  assert.equal(alerts.length, 1, 'the join was recorded even with nobody attached');
  assert.deepEqual(alerts[0].participants, []);
});

test('participants that are neither @s.whatsapp.net nor @lid are filtered out', () => {
  const { sock, alerts } = rig({ massAddThreshold: 1 });

  add(sock, ['1555@g.us', pn(1), 'old@c.us', lid(2), 'garbage']);

  assert.deepEqual(
    alerts[0].participants,
    [pn(1), lid(2)],
    'group and legacy jids must not be reported as new participants',
  );
});

test('the alert history is capped at 100 entries', () => {
  const { sock, alerts } = rig({ massAddThreshold: 1 });
  for (let i = 0; i < 105; i += 1) add(sock, [pn(i)]);

  assert.equal(alerts.length, 100);
  assert.deepEqual(alerts[0].participants, [pn(5)], 'the oldest alerts were shifted off');
});

/* ── privilege climb ─────────────────────────────────────────────────── */

test('the privilege-climb alert fires on the third all-admin promotion', () => {
  const { sock, alerts } = rig();

  promote(sock, [pn(1)]);
  promote(sock, [pn(2)]);
  assert.equal(alerts.length, 0, 'two admins is not a pattern');

  promote(sock, [pn(3)]);

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'privilege-climb');
  assert.equal(alerts[0].detail, '3 participants observed, all elevated');
  assert.deepEqual(alerts[0].participants, [pn(3)]);
  assert.equal(alerts[0].groupId, GROUP);
});

test('a demotion removes the participant from the all-admin set', () => {
  const { sock, alerts } = rig();

  promote(sock, [pn(1)]);
  promote(sock, [pn(2)]);
  demote(sock, [pn(1)]);
  assert.equal(alerts.length, 0);

  promote(sock, [pn(3)]);
  assert.equal(alerts.length, 0, 'the set is still only 2 strong');

  promote(sock, [pn(4)]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].detail, '3 participants observed, all elevated');
});

test('the admin set is exposed and only holds elevated participants', () => {
  const { sock, admins } = rig();

  promote(sock, [{ id: pn(1) }, pn(2)]);
  assert.deepEqual([...admins.get(GROUP)].sort(), [pn(1), pn(2)].sort());

  demote(sock, [pn(1)]);
  assert.deepEqual([...admins.get(GROUP)], [pn(2)]);

  demote(sock, [pn(2)]);
  assert.equal(admins.get(GROUP).size, 0);
});

test('privilege climbing is tracked per group', () => {
  const { sock, alerts } = rig();

  promote(sock, [pn(1)], GROUP);
  promote(sock, [pn(2)], GROUP);
  promote(sock, [pn(3)], OTHER_GROUP);
  assert.equal(alerts.length, 0, 'two in each group is not three in either');

  promote(sock, [pn(4)], GROUP);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].groupId, GROUP);
});

/* ── allowlist and ignored events ────────────────────────────────────── */

test('groups off the allowlist are ignored entirely', () => {
  const { sock, alerts, admins } = rig({
    massAddThreshold: 1,
    allow: (g) => g === OTHER_GROUP,
  });

  add(sock, [pn(1)], GROUP);
  promote(sock, [pn(1), pn(2), pn(3)], GROUP);

  assert.equal(alerts.length, 0, 'the disallowed group produced nothing');
  assert.equal(admins.has(GROUP), false, 'and was not tracked');

  add(sock, [pn(9)], OTHER_GROUP);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].groupId, OTHER_GROUP);
});

test('an event with no group id is ignored', () => {
  const { sock, alerts } = rig({ massAddThreshold: 1 });

  sock.ev.emit('group-participants.update', { participants: [pn(1)], action: 'add' });
  sock.ev.emit('group-participants.update', {});

  assert.equal(alerts.length, 0);
});

test('an unrecognised action is ignored', () => {
  const { sock, alerts, admins } = rig({ massAddThreshold: 1 });

  sock.ev.emit('group-participants.update', {
    id: GROUP,
    participants: [pn(1)],
    action: 'remove',
  });

  assert.equal(alerts.length, 0);
  assert.equal(admins.has(GROUP), false);
});

test('a promote with no participants key changes nothing', () => {
  const { sock, alerts, admins } = rig();

  promote(sock, [pn(1)]);
  sock.ev.emit('group-participants.update', { id: GROUP, action: 'promote' });
  sock.ev.emit('group-participants.update', { id: GROUP, action: 'promote' });

  assert.equal(alerts.length, 0);
  assert.deepEqual([...admins.get(GROUP)], [pn(1)], 'the empty promotes added nobody');
});

/* ── wiring ──────────────────────────────────────────────────────────── */

test('groupAlerts and groupAdmins are attached non-enumerably', () => {
  const { sock } = rig();
  assert.ok(Array.isArray(sock.groupAlerts));
  assert.equal(Object.keys(sock).includes('groupAlerts'), false);
  assert.equal(Object.keys(sock).includes('groupAdmins'), false);
  assert.equal(Object.getOwnPropertyDescriptor(sock, 'groupAlerts').enumerable, false);
  assert.equal(Object.getOwnPropertyDescriptor(sock, 'groupAdmins').enumerable, false);
});

test('alerts are reported, never acted on — the socket is untouched', () => {
  const { sock } = rig({ massAddThreshold: 1 });

  add(sock, [pn(1)]);
  promote(sock, [pn(1), pn(2), pn(3)]);

  assert.equal(sock.sent.length, 0, 'the guard must not send anything');
  assert.equal(sock.ended, undefined, 'nor disconnect');
  assert.equal(typeof sock.groupParticipantsUpdate, 'function', 'nor reach out to the API');
});