/**
 * How polls interact with anti-spam pacing.
 *
 * The answer is deliberately asymmetric, and these tests are the record of the
 * decision:
 *
 *   - **Creation is a message.** It is built with the native `poll` content key
 *     and sent through `sendMessage`, so anti-spam paces it like any other send.
 *   - **A vote (and a close, which is a withdrawal vote) is an action.** rc14 has
 *     no poll-vote content key, so it is relayed by hand on `relayMessage` —
 *     which anti-spam does not gate, on purpose. A tap must not wait out a
 *     20–51 s warm-up gap.
 *
 * `polls` had no test coverage before this file; these also pin its two outbound
 * paths.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { antiSpam } from '../dist/plugins/antiSpam.js';
import { polls } from '../dist/plugins/poll.js';

import { applyPlugin, fakeSocket, CHAT } from './helpers.js';

/** `polls` and `antiSpam` on one fake socket, with the pacing knobs pinned. */
function rig(overrides = {}) {
  const sock = fakeSocket();
  const spam = applyPlugin(
    antiSpam({ minGapMs: 0, jitterMs: 0, maxPerMinute: 1000, maxQueue: 100, ...overrides }),
    sock,
  );
  const poll = applyPlugin(polls(), sock);

  return {
    sock,
    dispose: () => {
      poll.dispose();
      spam.dispose();
    },
  };
}

test('poll creation goes through sendMessage, so anti-spam paces it', async () => {
  const { sock, dispose } = rig({ minGapMs: 40, maxPerMinute: 1000 });

  const before = Date.now();
  const id = await sock.createPoll(CHAT, 'Lunch?', ['Yes', 'No']);
  const elapsed = Date.now() - before;

  assert.equal(sock.sent.length, 1);
  assert.equal(sock.sent[0].via, 'sendMessage', 'creation must ride the paced send path');
  assert.ok('poll' in sock.sent[0].content, 'creation uses the native poll content key');
  assert.ok(elapsed >= 35, `a 40ms gap should delay the poll, took ${elapsed}ms`);
  assert.equal(id, 'SENT-1', 'the created poll is tracked under the sent message id');

  dispose();
});

test('a poll vote relays straight out — it is an action, not a send', async () => {
  const { sock, dispose } = rig({ minGapMs: 60, maxPerMinute: 1000 });

  const id = await sock.createPoll(CHAT, 'Lunch?', ['Yes', 'No']);

  const before = Date.now();
  await sock.votePoll(id, ['Yes']);
  const elapsed = Date.now() - before;

  assert.equal(sock.sent.at(-1).via, 'relayMessage', 'a vote rides relayMessage');
  assert.ok(elapsed < 30, `a vote must not wait out the send gap, took ${elapsed}ms`);

  dispose();
});

test('closing a poll is a withdrawal vote, so it relays too', async () => {
  const { sock, dispose } = rig({ minGapMs: 60, maxPerMinute: 1000 });

  const id = await sock.createPoll(CHAT, 'Lunch?', ['Yes', 'No']);

  const before = Date.now();
  await sock.closePoll(id);
  const elapsed = Date.now() - before;

  assert.equal(sock.sent.at(-1).via, 'relayMessage');
  assert.ok(elapsed < 30, `a close must not wait out the send gap, took ${elapsed}ms`);
  assert.equal(sock.getPoll(id).closed, true);

  dispose();
});
