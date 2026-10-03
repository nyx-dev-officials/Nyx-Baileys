/**
 * Message normaliser.
 *
 * The important one here is the negative test: a `messageParamsJson` string
 * that does not parse must be left byte-identical. Repairing the missing
 * `optionName` is worth doing; corrupting a payload we could not read is not —
 * the client would render something, just not the right thing, and there would
 * be no way to tell from the failure.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFormFlow, radioRow } from '../dist/core/nodes.js';
import { sessionRepair } from '../dist/plugins/session-repair.js';

import { applyPlugin, fakeSocket } from './helpers.js';

const CHAT = '111@s.whatsapp.net';

function rig() {
  const sock = fakeSocket();
  const harness = applyPlugin(sessionRepair({ verbose: true }), sock);
  return { sock, ...harness, normalise: sock.__normalise, repairs: () => sock.__repairStats };
}

/** `{ interactiveMessage: { nativeFlowMessage: { messageParamsJson } } }` */
const flowContent = (params) => ({
  interactiveMessage: {
    nativeFlowMessage: {
      messageVersion: 1,
      messageParamsJson: typeof params === 'string' ? params : JSON.stringify(params),
      buttons: [{ name: 'native_flow_cta', buttonParamsJson: '{"displayName":"Go"}' }],
    },
  },
});

const paramsOf = (content) => JSON.parse(content.interactiveMessage.nativeFlowMessage.messageParamsJson);
const rawOf = (content) => content.interactiveMessage.nativeFlowMessage.messageParamsJson;

/* ── optionName repair ───────────────────────────────────────────────── */

test('rows missing an optionName get one derived from their title', () => {
  const { normalise, repairs } = rig();
  const content = flowContent({
    title: 'Pick',
    sections: [
      {
        rows: [
          { title: 'Small' },
          { title: 'Large', optionName: 'size_l' },
          { title: 'Extra Large' },
        ],
      },
    ],
  });

  const out = normalise(content);
  const rows = paramsOf(out).sections[0].rows;

  assert.deepEqual(
    rows.map((r) => r.optionName),
    ['Small', 'size_l', 'Extra Large'],
    'existing optionName must not be touched',
  );
  assert.equal(repairs().repairs, 2, 'only the two missing ones counted');
});

test('a row with no title falls back to option_<index>, scoped to its section', () => {
  const { normalise } = rig();
  const out = normalise(
    flowContent({
      sections: [
        { rows: [{ description: 'a' }, { description: 'b' }] },
        { rows: [{ description: 'c' }] },
      ],
    }),
  );
  const sections = paramsOf(out).sections;

  assert.deepEqual(
    sections[0].rows.map((r) => r.optionName),
    ['option_0', 'option_1'],
  );
  assert.deepEqual(sections[1].rows.map((r) => r.optionName), ['option_0']);
});

test('a row whose optionName is empty is treated as missing', () => {
  const { normalise, repairs } = rig();
  const out = normalise(
    flowContent({ sections: [{ rows: [{ title: 'A', optionName: '' }, { title: 'B', optionName: 'b' }] }] }),
  );
  const rows = paramsOf(out).sections[0].rows;

  assert.deepEqual(rows.map((r) => r.optionName), ['A', 'b']);
  assert.equal(repairs().repairs, 1);
});

test('the repaired payload is still valid JSON and keeps every other field', () => {
  const { normalise } = rig();
  const original = {
    title: 'Pick',
    ctaLabel: 'Send',
    mediaType: 'image/png',
    body: { text: 'hello' },
    footer: { text: 'bye' },
    sections: [{ title: 'S', description: 'D', highlightLabel: 'H', rows: [{ title: 'A' }] }],
  };

  const out = normalise(flowContent(original));
  const repaired = paramsOf(out);

  assert.deepEqual(repaired.sections[0].rows[0], { title: 'A', optionName: 'A' });
  for (const key of ['title', 'ctaLabel', 'mediaType', 'body', 'footer']) {
    assert.deepEqual(repaired[key], original[key], `${key} was disturbed`);
  }
  assert.deepEqual(
    { title: repaired.sections[0].title, description: repaired.sections[0].description, highlightLabel: repaired.sections[0].highlightLabel },
    { title: 'S', description: 'D', highlightLabel: 'H' },
  );
});

test('a well-formed flow is left completely untouched, byte for byte', () => {
  const { normalise, repairs } = rig();
  // `createFormFlow` returns a WebMessageInfo; the content is its `.message`.
  const content = createFormFlow({
    title: 'Order',
    sections: [{ rows: [radioRow('Small', 'size_s'), radioRow('Large', 'size_l')] }],
  }).message;
  const before = rawOf(content);
  const beforeButtons = JSON.stringify(content.interactiveMessage.nativeFlowMessage.buttons);

  const out = normalise(content);

  assert.equal(rawOf(out), before, 'an already-valid payload must not be re-serialised');
  assert.equal(
    JSON.stringify(out.interactiveMessage.nativeFlowMessage.buttons),
    beforeButtons,
    'buttons are untouched',
  );
  assert.equal(repairs().repairs, 0);
  assert.equal(out, content, 'the same object is returned');
});

/* ── malformed payloads — the important negative tests ───────────────── */

test('BUG-GUARD: a malformed messageParamsJson is left byte-identical', () => {
  const { normalise, repairs } = rig();
  const broken = '{"sections":[{"rows":[{"title":"A"';
  const content = flowContent(broken);

  const out = normalise(content);

  assert.equal(
    rawOf(out),
    broken,
    'the payload was rewritten even though it could not be parsed',
  );
  assert.equal(repairs().repairs, 0);
  assert.throws(() => JSON.parse(rawOf(out)), 'the test fixture really is malformed');
});

test('every kind of unparsable payload survives untouched', () => {
  const { normalise, repairs } = rig();
  const broken = [
    '',
    '   ',
    'not json at all',
    '{',
    '[1,2,3]',
    '{"a":}',
    'undefined',
    '{"title":"T",}',
    '<html>error</html>',
    '{"sections":[{"rows":[{"title":"A"',
  ];

  for (const raw of broken) {
    const out = normalise(flowContent(raw));
    assert.equal(rawOf(out), raw, `payload was altered: ${JSON.stringify(raw)}`);
  }
  assert.equal(repairs().repairs, 0, 'nothing was counted as repaired');
});

test('a payload that parses but is not a flow object is left alone', () => {
  const { normalise, repairs } = rig();

  for (const raw of ['{}', '[]', '"a string"', '42', 'true', '{"sections":null}']) {
    const out = normalise(flowContent(raw));
    assert.equal(rawOf(out), raw, `payload was altered: ${raw}`);
  }
  assert.equal(repairs().repairs, 0);
});

/*
 * ---------------------------------------------------------------------------
 * KNOWN BUG — src/plugins/session-repair.ts:93 (see also :86-91)
 *
 * `repairFlow` guards the *string* half of the problem (`typeof raw !==
 * 'string'`, then `JSON.parse` in a try/catch) but never guards the *parsed*
 * shape. `JSON.parse('null')` succeeds and returns `null`, so the very next
 * line, `const sections = params.sections`, throws a TypeError straight out of
 * `normalise`.
 *
 * The socket wrappers swallow it ("normalise failed, sending as-is"), so a
 * message does still go out — but `__normalise` is exported onto the socket as
 * a callable, and the module's own contract is that an unreadable payload is
 * left exactly as it was.
 * ---------------------------------------------------------------------------
 */
test('BUG: a messageParamsJson that parses to null is a no-op, not a TypeError', () => {
  const { normalise, repairs } = rig();
  const content = flowContent('null');

  let threw = null;
  let out = null;
  try {
    out = normalise(content);
  } catch (err) {
    threw = err;
  }

  assert.equal(threw, null, `normalise threw ${threw?.message}`);
  assert.equal(rawOf(out), 'null');
  assert.equal(repairs().repairs, 0);
});

test('a section whose rows are not an array is skipped, siblings still repaired', () => {
  const { normalise, repairs } = rig();
  const out = normalise(
    flowContent({
      sections: [
        { rows: 'nope' },
        { title: 'no rows key' },
        null,
        { rows: [{ title: 'Real' }] },
      ],
    }),
  );

  assert.equal(paramsOf(out).sections.length, 4);
  assert.equal(paramsOf(out).sections[3].rows[0].optionName, 'Real');
  assert.equal(repairs().repairs, 1);
});

test('a missing, non-string or empty messageParamsJson is a no-op', () => {
  const { normalise, repairs } = rig();

  for (const value of [undefined, null, 0, 42, true, {}, []]) {
    const content = { interactiveMessage: { nativeFlowMessage: { messageVersion: 1 } } };
    if (value !== undefined) content.interactiveMessage.nativeFlowMessage.messageParamsJson = value;
    assert.doesNotThrow(() => normalise(content));
  }
  assert.equal(repairs().repairs, 0);
});

/* ── wrapper hoisting ────────────────────────────────────────────────── */

test('an interactive node is hoisted out of a viewOnce wrapper and the wrapper is deleted', () => {
  const { normalise } = rig();
  const inner = {
    message: {
      interactiveMessage: {
        nativeFlowMessage: { messageParamsJson: '{"sections":[{"rows":[{"title":"A"}]}]}' },
      },
    },
  };

  const out = normalise({ viewOnceMessage: inner });

  assert.equal('viewOnceMessage' in out, false, 'the wrapper must be removed, not just ignored');
  assert.ok(out.interactiveMessage, 'the node came to the top level');
  assert.equal(paramsOf(out).sections[0].rows[0].optionName, 'A');
});

test('hoisting works for every wrapper the plugin knows about', () => {
  const { normalise } = rig();
  const wrappers = [
    'viewOnceMessage',
    'documentWithCaptionMessage',
    'editedMessage',
    'ephemeralMessage',
    'viewOnceMessageV2',
    'viewOnceMessageV2Extension',
  ];

  for (const wrapper of wrappers) {
    const out = normalise({
      [wrapper]: {
        message: {
          interactiveMessage: {
            nativeFlowMessage: { messageParamsJson: '{"sections":[{"rows":[{"title":"A"}]}]}' },
          },
        },
      },
    });
    assert.equal(wrapper in out, false, `${wrapper} was not removed`);
    assert.equal(paramsOf(out).sections[0].rows[0].optionName, 'A', `${wrapper} node was lost`);
  }
});

test('a template node is hoisted too', () => {
  const { normalise } = rig();
  const out = normalise({ ephemeralMessage: { message: { templateMessage: { hydratedTemplate: {} } } } });
  assert.equal('ephemeralMessage' in out, false);
  assert.ok(out.templateMessage);
});

test('a wrapper holding ordinary media is NOT hoisted', () => {
  const { normalise } = rig();
  const content = { viewOnceMessage: { message: { imageMessage: { mimetype: 'image/jpeg' } } } };
  const out = normalise(content);
  assert.ok(out.viewOnceMessage, 'media wrappers are left alone');
  assert.equal(out.viewOnceMessage.message.imageMessage.mimetype, 'image/jpeg');
});

test('a message with no wrapper is returned by identity', () => {
  const { normalise } = rig();
  const content = { conversation: 'hello' };
  assert.equal(normalise(content), content);
  assert.equal(normalise(null), null);
  assert.equal(normalise(undefined), undefined);
  assert.equal(normalise('a string'), 'a string');
  assert.equal(normalise(42), 42);
});

test('a buttons message is given a contextInfo', () => {
  const { normalise } = rig();
  const out = normalise({ buttonsMessage: { buttons: [] } });
  assert.deepEqual(out.contextInfo, {});
});

/* ── the socket path ─────────────────────────────────────────────────── */

test('sendMessage is normalised on the way out, before Baileys compiles it', async () => {
  const { sock } = rig();

  await sock.sendMessage(CHAT, flowContent({ sections: [{ rows: [{ title: 'Pick me' }] }] }));

  assert.equal(sock.sent.length, 1);
  const sent = sock.sent[0].content;
  assert.equal(paramsOf(sent).sections[0].rows[0].optionName, 'Pick me');
  assert.equal(sock.__repairStats.repairs, 1);
});

test('relayMessage forwards its message id unchanged', async () => {
  const { sock } = rig();

  // relayMessage re-sends an existing message; its second argument is a
  // message id, not content, so there is nothing to normalise.
  await sock.relayMessage(CHAT, 'SOME_MESSAGE_ID');

  assert.equal(sock.sent.length, 1);
  assert.equal(sock.sent[0].jid, CHAT);
  assert.equal(sock.sent[0].messageId, 'SOME_MESSAGE_ID');
  assert.equal(sock.sent[0].via, 'relayMessage');
  assert.equal(sock.__repairStats.repairs, 0);
});

test('sendMessage forwards jid and the extra options unchanged', async () => {
  const { sock } = rig();
  const extra = { linkPreview: { url: 'https://x.invalid' } };

  await sock.sendMessage(CHAT, { conversation: 'hi' }, extra);

  assert.equal(sock.sent[0].jid, CHAT);
  assert.equal(sock.sent[0].extra, extra);
  assert.deepEqual(sock.sent[0].content, { conversation: 'hi' });
});

test('a content value that is not an object is passed through untouched', async () => {
  const { sock } = rig();
  await sock.sendMessage(CHAT, 'just a string');
  assert.equal(sock.sent[0].content, 'just a string');
  assert.equal(sock.sent.length, 1, 'the send still happened');
});

test('a malformed payload on the socket path still goes out, unaltered', async () => {
  const { sock } = rig();
  const broken = '{"sections":[{"rows":[';

  await sock.sendMessage(CHAT, flowContent(broken));

  assert.equal(rawOf(sock.sent[0].content), broken);
  assert.equal(sock.__repairStats.repairs, 0);
});

/*
 * ---------------------------------------------------------------------------
 * KNOWN BUG — src/core/intercept.ts:57-68, reached through sessionRepair.
 *
 * `sessionRepair` gates `sendMessage` then `relayMessage` on the same socket
 * and registers a disposer for both (src/plugins/session-repair.ts:158). The
 * pristine stash only records the first method patched on an object, so
 * teardown restores `relayMessage` as `undefined` rather than the original
 * function. Same root cause as the intercept / antiSpam / patchAll failures.
 * ---------------------------------------------------------------------------
 */
test('BUG: dispose() restores relayMessage, not undefined', () => {
  const sock = fakeSocket();
  const pristine = { sendMessage: sock.sendMessage, relayMessage: sock.relayMessage };
  const harness = applyPlugin(sessionRepair(), sock);

  assert.notEqual(sock.sendMessage, pristine.sendMessage, 'sanity: sendMessage was patched');
  assert.notEqual(sock.relayMessage, pristine.relayMessage, 'sanity: relayMessage was patched');

  harness.dispose();

  assert.equal(sock.sendMessage, pristine.sendMessage);
  assert.equal(sock.relayMessage, pristine.relayMessage, 'relayMessage was left undefined');
  assert.equal(typeof sock.relayMessage, 'function');
});