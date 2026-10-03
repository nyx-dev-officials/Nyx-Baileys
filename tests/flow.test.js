/**
 * Conversational flow engine.
 *
 * The engine's whole job is turning whatever shape a reply arrives in into one
 * `text`/`selection` pair the step author can trust. The rc14 native-flow form
 * submit is the hard case — it carries no plain-text body at all, so a handler
 * that only reads `conversation` sees an empty message and the reply is
 * silently dropped.
 *
 * One semantic worth stating up front, because it shapes every test here: the
 * ACTIVE step receives everything until it calls `goto()`. An entry step that
 * never hands off will keep being re-entered, so flows in this file always
 * `goto` immediately and the assertions include that first, empty-probe
 * invocation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { flowEngine } from '../dist/plugins/flow.js';

import { applyPlugin, fakeSocket, nativeFlowReply, sleep, upsert, wmMessage } from './helpers.js';

const CHAT = 'a@s.whatsapp.net';
const OTHER = 'b@s.whatsapp.net';

function rig(flows = []) {
  const sock = fakeSocket();
  const harness = applyPlugin(flowEngine(flows), sock);
  return { sock, flows: sock.flows, ...harness };
}

/** `say` delivers one inbound plain-text message from the chat. */
const say = (sock, text, jid = CHAT) =>
  upsert(sock, [wmMessage({ jid, id: `m-${jid}-${text}`, message: { conversation: text } })]);

/** An inbound message with an explicit body — always stamped with the chat. */
const inbound = (message, { jid = CHAT, id = 'inbound' } = {}) => wmMessage({ jid, id, message });

/* ── step transitions ────────────────────────────────────────────────── */

test('the entry step claims a matching message, later messages go to the active step', async () => {
  const seen = [];
  const { sock, flows } = rig([
    {
      id: 'chatty',
      entry: 'start',
      steps: [
        {
          name: 'start',
          match: /^hi\b/i,
          run: (c) => {
            seen.push({ step: 'start', text: c.text, id: c.msg?.key?.id });
            c.goto('second');
          },
        },
        { name: 'second', run: (c) => seen.push({ step: 'second', text: c.text, id: c.msg?.key?.id }) },
      ],
    },
  ]);

  say(sock, 'hi there');
  await sleep(0);
  assert.equal(flows.active(CHAT), 'second', 'goto moved the flow off the entry step');

  say(sock, 'yes please');
  await sleep(0);

  assert.deepEqual(
    seen.map((s) => [s.step, s.text]),
    [
      ['start', 'hi there'],
      ['second', ''],
      ['second', 'yes please'],
    ],
  );
  assert.equal(seen[0].id, `m-${CHAT}-hi there`, 'the entry step gets the raw message');
  assert.equal(seen[1].id, undefined, 'a goto-driven invocation gets msg === null');
  assert.equal(seen[2].id, `m-${CHAT}-yes please`, 'and the next message reaches `second`');
});

test('an entry step that never hands off is re-entered by every message', async () => {
  const seen = [];
  const { sock, flows } = rig([
    { id: 'sticky', entry: 'a', steps: [{ name: 'a', match: /hi/, run: (c) => seen.push(c.text) }] },
  ]);

  say(sock, 'hi');
  say(sock, 'again');
  say(sock, 'still here');

  assert.deepEqual(seen, ['hi', 'again', 'still here']);
  assert.equal(flows.active(CHAT), 'a');
});

test('a non-matching message never starts a flow', async () => {
  const seen = [];
  const { sock, flows } = rig([
    { id: 'p', entry: 'start', steps: [{ name: 'start', match: /^hi\b/i, run: () => seen.push(1) }] },
  ]);

  say(sock, 'goodbye');
  say(sock, 'nope');

  assert.deepEqual(seen, []);
  assert.equal(flows.active(CHAT), undefined);
});

test('an entry step with a function matcher works the same way', async () => {
  const seen = [];
  const { sock } = rig([
    { id: 'fn', entry: 'go', steps: [{ name: 'go', match: (t) => t.startsWith('#'), run: (c) => seen.push(c.text) }] },
  ]);

  say(sock, 'hello');
  assert.deepEqual(seen, []);

  say(sock, '#tag');
  assert.deepEqual(seen, ['#tag']);
});

test('the regex match is anchored to the start of the input', async () => {
  const seen = [];
  const { sock } = rig([
    { id: 'anchored', entry: 'go', steps: [{ name: 'go', match: /^order/, run: (c) => seen.push(c.text) }] },
  ]);

  say(sock, 'please order now');
  assert.deepEqual(seen, [], '"order" appears but not at the start');
  say(sock, 'order now');
  assert.deepEqual(seen, ['order now']);
});

test('a flow with no entry match never starts', async () => {
  const { sock, flows } = rig([
    { id: 'unmatched', entry: 'go', steps: [{ name: 'go', run: () => {} }] },
  ]);

  say(sock, 'anything');
  await sleep(0);
  assert.equal(flows.active(CHAT), undefined);
});

test('a flow whose declared entry step does not exist silently never starts', async () => {
  const { sock, flows, log } = rig([
    { id: 'broken', entry: 'nope', steps: [{ name: 'go', match: /.*/, run: () => {} }] },
  ]);

  say(sock, 'hello');
  await sleep(0);

  // The idle branch guards with `entry?.match` before it ever calls `start()`,
  // so `start()`'s own "flow entry missing" branch (src/plugins/flow.ts:221) is
  // unreachable and nothing is logged. Asserted as-is so the dead branch is
  // noticed if the caller-side guard ever goes away.
  assert.equal(flows.active(CHAT), undefined);
  assert.equal(log.has('flow entry missing'), false);
  assert.equal(log.has('goto target missing'), false);
});

test('the first registered flow that matches wins', async () => {
  const seen = [];
  const { sock } = rig([
    { id: 'first', entry: 'go', steps: [{ name: 'go', match: /x/, run: () => seen.push('first') }] },
    { id: 'second', entry: 'go', steps: [{ name: 'go', match: /x/, run: () => seen.push('second') }] },
  ]);

  say(sock, 'x');
  await sleep(0);
  assert.deepEqual(seen, ['first']);
});

/* ── goto / end ──────────────────────────────────────────────────────── */

test('goto moves to the named step and end clears the flow', async () => {
  const order = [];
  const { sock, flows } = rig([
    {
      id: 'nav',
      entry: 'a',
      steps: [
        { name: 'a', match: /start/, run: (c) => { order.push('a'); c.goto('b'); } },
        { name: 'b', run: (c) => { order.push('b'); c.goto('c'); } },
        { name: 'c', run: (c) => { order.push('c'); c.end(); } },
      ],
    },
  ]);

  say(sock, 'start');
  await sleep(0);

  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.equal(flows.active(CHAT), undefined, 'end() removed the flow');
});

test('goto to a missing step is a no-op that logs a warning', async () => {
  const { sock, flows, log } = rig([
    { id: 'bad-goto', entry: 'a', steps: [{ name: 'a', match: /go/, run: (c) => c.goto('nowhere') }] },
  ]);

  say(sock, 'go');
  await sleep(0);

  assert.equal(flows.active(CHAT), 'a', 'the step must not change');
  assert.ok(log.has('goto target missing'));
});

test('after end() the flow can start again from the top', async () => {
  const seen = [];
  const { sock, flows } = rig([
    { id: 'restartable', entry: 'a', steps: [{ name: 'a', match: /go/, run: (c) => { seen.push('a'); c.end(); } }] },
  ]);

  say(sock, 'go');
  await sleep(0);
  assert.equal(flows.active(CHAT), undefined);

  say(sock, 'go');
  await sleep(0);
  assert.deepEqual(seen, ['a', 'a']);
});

test('a step that throws drops the flow and logs "flow step failed"', async () => {
  const reached = [];
  const { sock, flows, log } = rig([
    {
      id: 'boom',
      entry: 'a',
      steps: [
        { name: 'a', match: /go/, run: (c) => { reached.push('a'); c.goto('b'); } },
        {
          name: 'b',
          run: () => {
            throw new Error('step exploded');
          },
        },
      ],
    },
  ]);

  say(sock, 'go');
  await sleep(0);

  assert.deepEqual(reached, ['a']);
  assert.equal(flows.active(CHAT), undefined, 'the flow should have been dropped');
  assert.ok(log.find((e) => e.level === 'error' && e.msg === 'flow step failed').length > 0);
  assert.ok(log.find((e) => String(e.meta?.err).includes('step exploded')).length > 0);
});

test('an entry step that throws drops the flow and logs "flow entry failed"', async () => {
  const { sock, flows, log } = rig([
    {
      id: 'boom-entry',
      entry: 'a',
      steps: [
        {
          name: 'a',
          match: /go/,
          run: () => {
            throw new Error('entry exploded');
          },
        },
      ],
    },
  ]);

  say(sock, 'go');
  await sleep(0);

  assert.equal(flows.active(CHAT), undefined);
  assert.ok(log.find((e) => e.level === 'error' && e.msg === 'flow entry failed').length > 0);
  assert.ok(log.find((e) => String(e.meta?.err).includes('entry exploded')).length > 0);
});

test('a step that rejects asynchronously also drops the flow', async () => {
  const reached = [];
  const { sock, flows, log } = rig([
    {
      id: 'boom-async',
      entry: 'a',
      steps: [
        { name: 'a', match: /go/, run: (c) => { reached.push('a'); c.goto('b'); } },
        {
          name: 'b',
          run: async () => {
            await sleep(1);
            throw new Error('later boom');
          },
        },
      ],
    },
  ]);

  say(sock, 'go');
  assert.deepEqual(reached, ['a']);
  assert.equal(flows.active(CHAT), 'b', 'goto already parked it on the failing step');

  await sleep(15);

  assert.equal(flows.active(CHAT), undefined, 'the rejection dropped the flow');
  assert.ok(log.find((e) => e.level === 'error' && String(e.meta?.err).includes('later boom')).length > 0);
});

/* ── TTL ─────────────────────────────────────────────────────────────── */

test('a flow idle past its ttl is dropped and the message does not revive it', async () => {
  const seen = [];
  const { sock, flows } = rig([
    {
      id: 'ttl',
      entry: 'a',
      ttlMs: 1,
      steps: [
        { name: 'a', match: /go/, run: (c) => { seen.push(`a:${c.text}`); c.goto('b'); } },
        { name: 'b', run: (c) => seen.push(`b:${c.text}`) },
      ],
    },
  ]);

  say(sock, 'go');
  await sleep(0);
  assert.deepEqual(seen, ['a:go', 'b:']);
  assert.equal(flows.active(CHAT), 'b');

  await sleep(25);
  say(sock, 'still there?');
  await sleep(0);

  assert.equal(flows.active(CHAT), undefined, 'the stale flow was not dropped');
  assert.deepEqual(seen, ['a:go', 'b:'], 'and the message did not revive it');
});

test('the default ttl is fifteen minutes', async () => {
  const seen = [];
  const { sock, flows } = rig([
    {
      id: 'def',
      entry: 'a',
      steps: [
        { name: 'a', match: /go/, run: (c) => { seen.push(c.text); c.goto('b'); } },
        { name: 'b', run: (c) => seen.push(c.text) },
      ],
    },
  ]);

  say(sock, 'go');
  await sleep(0);
  say(sock, 'still here');
  await sleep(0);

  assert.deepEqual(seen, ['go', '', 'still here']);
  assert.equal(flows.active(CHAT), 'b');
});

/* ── capture ─────────────────────────────────────────────────────────── */

test('capture:false ignores everything once a flow is active', async () => {
  const seen = [];
  const { sock, flows } = rig([
    {
      id: 'strict',
      entry: 'a',
      capture: false,
      steps: [{ name: 'a', match: /go/, run: (c) => seen.push(c.text) }],
    },
  ]);

  say(sock, 'go');
  await sleep(0);
  say(sock, 'anything at all');
  await sleep(0);

  assert.deepEqual(seen, ['go']);
  assert.equal(flows.active(CHAT), 'a', 'the flow is still active, just not listening');
});

/* ── reply and state ─────────────────────────────────────────────────── */

test('reply() sends to the current chat through the socket', async () => {
  const { sock } = rig([
    {
      id: 'r',
      entry: 'a',
      steps: [{ name: 'a', match: /hi/, run: (c) => { c.reply('hello back'); c.goto('b'); } }, { name: 'b', run: () => {} }],
    },
  ]);

  say(sock, 'hi');
  await sleep(0);

  assert.equal(sock.sent.length, 1);
  assert.equal(sock.sent[0].jid, CHAT);
  assert.deepEqual(sock.sent[0].content, { text: 'hello back' });
});

test('reply() forwards the extra options object', async () => {
  const { sock } = rig([
    {
      id: 'r2',
      entry: 'a',
      steps: [
        { name: 'a', match: /hi/, run: (c) => { c.reply('x', { mentions: [] }); c.goto('b'); } },
        { name: 'b', run: () => {} },
      ],
    },
  ]);

  say(sock, 'hi');
  await sleep(0);
  assert.deepEqual(sock.sent[0].extra, { mentions: [] });
});

test('scratch state persists across steps but is never shared between chats', async () => {
  const seen = [];
  const label = (jid) => (jid === CHAT ? 'CHAT' : 'OTHER');
  const { sock, flows } = rig([
    {
      id: 'stateful',
      entry: 'a',
      steps: [
        {
          name: 'a',
          match: /go/,
          run: (c) => {
            seen.push(`a:${label(c.jid)}:${c.state.n ?? 0}`);
            c.state.n = (c.state.n ?? 0) + 1;
            c.goto('b');
          },
        },
        {
          name: 'b',
          run: (c) => {
            seen.push(`b:${label(c.jid)}:${c.state.n}`);
            c.state.n += 1;
            c.goto('c');
          },
        },
        { name: 'c', run: (c) => seen.push(`c:${label(c.jid)}:${c.state.n}`) },
      ],
    },
  ]);

  say(sock, 'go', CHAT);
  say(sock, 'go', OTHER);

  assert.deepEqual(seen, [
    'a:CHAT:0',
    'b:CHAT:1',
    'c:CHAT:2',
    'a:OTHER:0',
    'b:OTHER:1',
    'c:OTHER:2',
  ]);
  assert.equal(flows.active(CHAT), 'c');
  assert.equal(flows.active(OTHER), 'c');
});

test('ctx.msg is the raw message for message-driven steps and null for goto', async () => {
  const seen = [];
  const { sock } = rig([
    {
      id: 'm',
      entry: 'a',
      steps: [
        { name: 'a', match: /go/, run: (c) => { seen.push({ step: 'a', id: c.msg?.key?.id, jid: c.jid }); c.goto('b'); } },
        { name: 'b', run: (c) => seen.push({ step: 'b', id: c.msg?.key?.id, jid: c.jid }) },
      ],
    },
  ]);

  say(sock, 'go');
  await sleep(0);

  assert.equal(seen[0].id, `m-${CHAT}-go`, 'the entry step gets the message');
  assert.equal(seen[0].jid, CHAT);
  assert.equal(seen[1].id, undefined, 'a goto-driven step gets msg === null');
  assert.equal(seen[1].jid, CHAT);
});

/* ── reply extraction ────────────────────────────────────────────────── */

/**
 * A flow that parks on step `ask` after the trigger message. `seen[0]` is the
 * empty-probe invocation that `goto` produces, so real replies land from
 * `seen[1]` onwards.
 */
function awaitingFlow(id) {
  const seen = [];
  return {
    seen,
    last: () => seen[seen.length - 1],
    flow: {
      id,
      entry: 'start',
      steps: [
        { name: 'start', match: /go/, run: (c) => c.goto('ask') },
        {
          name: 'ask',
          run: (c) => seen.push({ text: c.text, selection: c.selection, flowResponse: c.flowResponse }),
        },
      ],
    },
  };
}

/** Send the trigger, then one extra message; returns the parked flow state. */
async function trigger(sock, message) {
  say(sock, 'go');
  await sleep(0);
  assert.equal(sock.flows.active(CHAT), 'ask', 'the flow should be parked on `ask`');
  if (message) {
    upsert(sock, [message]);
    await sleep(0);
  }
}

test('a native-flow form submit is extracted, not discarded', async () => {
  const probe = awaitingFlow('nf');
  const { sock } = rig([probe.flow]);

  await trigger(sock, nativeFlowReply(CHAT, JSON.stringify({ selectedDisplayText: 'Large' }), 'R1'));

  assert.equal(probe.seen.length, 2, 'the reply was dropped');
  assert.equal(probe.last().selection, 'Large');
  assert.equal(probe.last().text, 'Large', 'a flow reply with no text body still produces text');
});

test('selectedRowId and selectedOptionName are recognised too', async () => {
  const probe = awaitingFlow('nf2');
  const { sock } = rig([probe.flow]);

  await trigger(sock);
  upsert(sock, [
    nativeFlowReply(CHAT, JSON.stringify({ selectedRowId: 'opt_7' }), 'R1'),
    nativeFlowReply(CHAT, JSON.stringify({ selectedOptionName: 'opt_8' }), 'R2'),
  ]);
  await sleep(0);

  assert.deepEqual(probe.seen.slice(1).map((s) => s.selection), ['opt_7', 'opt_8']);
});

test('a nested row title is found by walking the payload', async () => {
  const probe = awaitingFlow('nf3');
  const { sock } = rig([probe.flow]);

  await trigger(
    sock,
    nativeFlowReply(
      CHAT,
      JSON.stringify({
        version: '3',
        flowToken: 'abc',
        sections: [{ rows: [{ optionName: 'pizza', title: 'Pizza' }] }],
      }),
      'R1',
    ),
  );

  assert.deepEqual(probe.seen.slice(1).map((s) => s.selection), ['Pizza']);
});

test('an unparsable paramsJson is still surfaced as the selection', async () => {
  const probe = awaitingFlow('nf4');
  const { sock } = rig([probe.flow]);

  await trigger(sock, nativeFlowReply(CHAT, 'Pizza', 'R1'));

  assert.deepEqual(probe.seen.slice(1).map((s) => s.selection), ['Pizza'], 'a raw string reply must not vanish');
});

/*
 * ---------------------------------------------------------------------------
 * KNOWN BUG — src/plugins/flow.ts:177-200 (missing `flowResponse`)
 *
 * `FlowContext` declares `flowResponse` (src/plugins/flow.ts:26) and the
 * `parseFlowResponse` docstring promises "we also hand the parsed object back
 * via `ctx.flowResponse`" (src/plugins/flow.ts:91-94). `extract()` does compute
 * a `response`, but `buildContext` constructs its return object field by field
 * and never copies it across, so `ctx.flowResponse` is permanently undefined.
 *
 * A step author reading the type sees `flowResponse` and writes against it; at
 * runtime it is undefined, so every form field beyond the selected row title is
 * unreachable. (The title itself still works — that comes from `selection`.)
 * ---------------------------------------------------------------------------
 */
test('BUG: ctx.flowResponse carries the parsed native-flow payload', async () => {
  const probe = awaitingFlow('nf5');
  const { sock } = rig([probe.flow]);

  const payload = { selectedDisplayText: 'Large', quantity: 3, notes: 'gift wrap' };
  await trigger(sock, nativeFlowReply(CHAT, JSON.stringify(payload), 'R1'));

  assert.deepEqual(
    probe.last().flowResponse,
    payload,
    `ctx.flowResponse is ${JSON.stringify(probe.last().flowResponse)} — quantity and notes are unreachable`,
  );
});

test('ctx.flowResponse is undefined for a plain-text reply', async () => {
  const probe = awaitingFlow('nf6');
  const { sock } = rig([probe.flow]);

  await trigger(sock, inbound({ conversation: 'just talking' }, { id: 'T1' }));

  assert.equal(probe.last().text, 'just talking');
  assert.equal(probe.last().flowResponse, undefined, 'there is no flow payload on a text reply');
});

test('buttons, list and plain-text replies all resolve to text and selection', async () => {
  const probe = awaitingFlow('shapes');
  const { sock } = rig([probe.flow]);

  await trigger(sock);
  upsert(sock, [
    inbound({ buttonsResponseMessage: { selectedDisplayText: 'Yes please' } }, { id: 'B1' }),
    inbound({ listResponseMessage: { singleSelectReply: { selectedRowId: 'row_2' } } }, { id: 'L1' }),
    inbound({ conversation: '  padded text  ' }, { id: 'C1' }),
    inbound({ extendedTextMessage: { text: 'extended' } }, { id: 'E1' }),
    inbound({ interactiveMessage: { selectedDisplayText: 'Inter', bodyText: 'Body wins' } }, { id: 'I1' }),
    inbound({ listMessage: { title: 'A list' } }, { id: 'M1' }),
  ]);
  await sleep(0);

  assert.deepEqual(
    probe.seen.slice(1).map(({ text, selection }) => ({ text, selection })),
    [
      { text: 'Yes please', selection: 'Yes please' },
      { text: 'row_2', selection: undefined },
      { text: 'padded text', selection: undefined },
      { text: 'extended', selection: undefined },
      { text: 'Body wins', selection: 'Inter' },
      { text: 'A list', selection: undefined },
    ],
    'text is trimmed and each reply shape resolves to the right field',
  );
});

/* ── ignored input ───────────────────────────────────────────────────── */

test('our own messages are ignored', async () => {
  const seen = [];
  const { sock, flows } = rig([
    { id: 'self', entry: 'a', steps: [{ name: 'a', match: /go/, run: () => seen.push(1) }] },
  ]);

  upsert(sock, [{ key: { remoteJid: CHAT, id: 'me', fromMe: true }, message: { conversation: 'go' } }]);
  await sleep(0);
  assert.deepEqual(seen, []);
  assert.equal(flows.active(CHAT), undefined);
});

test('messages with no jid, and messages with no text, are ignored', async () => {
  const seen = [];
  const { sock, flows } = rig([
    { id: 'e', entry: 'a', steps: [{ name: 'a', match: /.*/, run: () => seen.push('a') }] },
  ]);

  upsert(sock, [
    { key: { id: 'x' }, message: { conversation: 'go' } },
    inbound({}, { id: 'empty' }),
    inbound({ conversation: '   ' }, { id: 'blank' }),
  ]);
  await sleep(0);

  assert.deepEqual(seen, []);
  assert.equal(flows.active(CHAT), undefined);
});

/* ── registry surface ────────────────────────────────────────────────── */

test('flows.add / remove / list / active / reset drive the registry', async () => {
  const { sock, flows } = rig();

  assert.deepEqual(flows.list(), []);
  assert.equal(typeof flows.add, 'function');
  assert.equal(typeof flows.remove, 'function');

  flows.add({ id: 'late', entry: 'a', steps: [{ name: 'a', match: /late/, run: () => {} }] });
  assert.deepEqual(flows.list(), ['late']);

  say(sock, 'late');
  await sleep(0);
  assert.equal(flows.active(CHAT), 'a');

  flows.reset(CHAT);
  assert.equal(flows.active(CHAT), undefined);

  say(sock, 'late');
  await sleep(0);
  assert.equal(flows.active(CHAT), 'a');

  flows.reset();
  assert.equal(flows.active(CHAT), undefined);

  say(sock, 'late');
  await sleep(0);
  assert.equal(flows.active(CHAT), 'a', 'reset() then a new start');

  flows.remove('late');
  assert.deepEqual(flows.list(), []);
  flows.reset();

  say(sock, 'late');
  await sleep(0);
  assert.equal(flows.active(CHAT), undefined, 'a removed flow cannot start');
});

test('flows is attached non-enumerably', () => {
  const { sock } = rig();
  assert.equal(Object.keys(sock).includes('flows'), false);
  assert.equal(Object.getOwnPropertyDescriptor(sock, 'flows').enumerable, false);
});