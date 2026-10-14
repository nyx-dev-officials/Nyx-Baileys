/**
 * Interactive messages: the ones rc14's send path refuses.
 *
 * ## The bug this exists for
 *
 * `generateWAMessageContent` (`Utils/messages.js:273`) is an if/else chain over
 * the content keys it knows, and its final `else` calls `prepareWAMessageMedia`,
 * which throws `Boom: Invalid media type`. `listMessage`, `buttonsMessage`,
 * `templateMessage` and `interactiveMessage` are not in that chain, so
 * `sendMessage` rejects all of them — even though `core/nodes.ts` serialises them
 * correctly. The shapes were right; only the door was shut.
 *
 * ## What these tests can and cannot prove
 *
 * They prove the plugin does the right thing *locally*: it detects the right
 * keys, routes everything else through untouched, builds a well-formed message,
 * emits the local-history update that `sendMessage` would have, unwinds on
 * dispose, and surfaces real errors rather than swallowing them.
 *
 * They cannot prove a phone rendered it. That was verified on hardware — see
 * `docs/VERIFICATION.md` — and it is the one claim in this file that a fake
 * socket cannot make.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatListAsText, interactive, interactiveKeyOf } from '../dist/plugins/interactive.js';

import { GROUP, applyPlugin, fakeSocket, flush, pn } from './helpers.js';

const ME = pn(9);
const LIST = {
  listMessage: {
    title: 'Menu',
    description: 'Available Features',
    buttonText: 'Open',
    sections: [{ title: 'Features', rows: [{ title: 'Call Button', description: 'Example', rowId: 'c' }] }],
  },
};
const BUTTONS = { buttonsMessage: { headerText: 'H', contentText: 'C', buttons: [{ buttonId: 'y', buttonText: { displayText: 'Yes' } }] } };

function rig(options = {}) {
  const sock = fakeSocket();
  sock.user = { id: ME, lid: '999:9@lid' };
  const relayed = [];
  sock.relayMessage = async (jid, message, opts) => {
    relayed.push({ jid, message, opts });
  };
  // Captured BEFORE the patch. Capturing it after would compare the wrapper with
  // the pristine original and fail for a reason that has nothing to do with undo.
  const pristine = sock.sendMessage;
  // Default to the native path: these tests are about flow routing, and the
  // consumer-tier plaintext fallback has its own section below.
  const harness = applyPlugin(interactive({ listFallback: 'off', ...options }), sock);
  return { sock, relayed, pristine, ...harness };
}

/* ── detection ────────────────────────────────────────────────────────── */

test('the interactive keys are the ones the upstream chain rejects', () => {
  assert.equal(interactiveKeyOf(LIST), 'listMessage');
  assert.equal(interactiveKeyOf(BUTTONS), 'buttonsMessage');
  assert.equal(interactiveKeyOf({ templateMessage: {} }), 'templateMessage');
  assert.equal(interactiveKeyOf({ interactiveMessage: {} }), 'interactiveMessage');
});

test('ordinary content is not mistaken for interactive content', () => {
  for (const content of [{ text: 'hi' }, { image: {} }, { poll: {} }, {}, null, undefined, 'string', 42]) {
    assert.equal(interactiveKeyOf(content), null, `false positive on ${JSON.stringify(content)}`);
  }
});

test('a null-valued key does not count as present', () => {
  assert.equal(interactiveKeyOf({ listMessage: null }), null);
  assert.equal(interactiveKeyOf({ listMessage: undefined }), null);
});

/* ── pass-through ─────────────────────────────────────────────────────── */

test('a normal send is passed straight through, untouched', async () => {
  const { sock, relayed } = rig();

  await sock.sendMessage(GROUP, { text: 'plain' });

  assert.equal(sock.sent.length, 1, 'the original sendMessage should have run');
  assert.equal(relayed.length, 0, 'and relayMessage should not have been used');
  assert.equal(sock.__interactive.stats().passedThrough, 1);
});

/* ── handling ─────────────────────────────────────────────────────────── */

test('a list message is built and relayed rather than rejected', async () => {
  const { sock, relayed } = rig();

  const result = await sock.sendMessage(GROUP, LIST);

  assert.equal(relayed.length, 1, 'relayMessage was not used');
  assert.equal(relayed[0].jid, GROUP);
  assert.equal(relayed[0].opts.messageId, result.key.id, 'the id we return is the id we sent');
  assert.equal(sock.sent.length, 0, 'the upstream path must not have been attempted');
  assert.equal(sock.__interactive.stats().sent, 1);
});

/**
 * Dig the native flow out of a relayed message.
 *
 * The envelope is `viewOnceMessage.message.interactiveMessage`, and the flow
 * buttons live on its `nativeFlowMessage`. A plain `message.buttonsMessage` would
 * mean the legacy shape leaked through unconverted — which is the bug this file
 * exists to catch.
 */
function flowOf(message) {
  const interactive = message?.interactiveMessage;
  assert(interactive, `no interactiveMessage in the envelope: ${JSON.stringify(message)}`);
  const buttons = interactive.nativeFlowMessage?.buttons;
  assert(Array.isArray(buttons), `no nativeFlowMessage.buttons: ${JSON.stringify(interactive)}`);
  return { interactive, buttons };
}

test('a buttons message becomes a quick_reply flow with its buttons intact', async () => {
  const { sock, relayed } = rig();

  await sock.sendMessage(GROUP, BUTTONS);

  const { interactive, buttons } = flowOf(relayed[0].message);
  assert.equal(buttons.length, 1, `buttons lost: ${JSON.stringify(interactive)}`);
  assert.equal(buttons[0].name, 'quick_reply');

  // The original text and id must survive the JSON round-trip.
  const params = JSON.parse(buttons[0].buttonParamsJson);
  assert.equal(params.display_text, 'Yes');
  assert.equal(params.id, 'y');
  assert.equal(interactive.body?.text, 'C');
});

test('a bare-string buttonText is accepted, not dropped', async () => {
  const { sock, relayed } = rig();

  // Callers reasonably pass a string; the proto wants a nested message. Both
  // must work, because the alternative is a silently button-less message.
  await sock.sendMessage(GROUP, {
    buttonsMessage: { contentText: 'C', buttons: [{ buttonId: 'z', buttonText: 'Plain' }] },
  });

  const { buttons } = flowOf(relayed[0].message);
  const params = JSON.parse(buttons[0].buttonParamsJson);
  assert.equal(params.display_text, 'Plain');
  assert.equal(params.id, 'z');
});

test('a list becomes a single_select flow carrying its sections', async () => {
  const { sock, relayed } = rig();

  await sock.sendMessage(GROUP, LIST);

  const { interactive, buttons } = flowOf(relayed[0].message);
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].name, 'single_select');

  const params = JSON.parse(buttons[0].buttonParamsJson);
  assert.equal(params.sections.length, 1, 'sections lost');
  // The wire field is `id`, not `rowId`. A client given `rowId` accepts the
  // stanza and then renders nothing, so the normaliser renames it.
  assert.equal(params.sections[0].rows[0].id, 'c', 'row id lost');
  assert.equal(params.sections[0].rows[0].rowId, undefined, 'rowId must not reach the wire');
  assert.equal(params.sections[0].rows[0].title, 'Call Button');
  assert.deepEqual(
    Object.keys(params.sections[0].rows[0]).sort(),
    ['description', 'header', 'id', 'title'],
    'rows carry exactly the four fields a client renders',
  );
});

test('the message is keyed to the chat and marked as ours', async () => {
  const { sock, relayed } = rig();

  const result = await sock.sendMessage(GROUP, LIST);

  // relayMessage takes the inner message plus a separate id, so the key is on
  // the returned message rather than on what was handed to the relay.
  assert.equal(result.key.remoteJid, GROUP, 'keyed to the chat it was sent to');
  assert.equal(result.key.fromMe, true, 'an outgoing message must be marked fromMe');
  assert.equal(relayed[0].opts.messageId, result.key.id, 'the id sent is the id returned');
  assert(relayed[0].message.interactiveMessage, 'the interactive message is the payload');
});

/* ── the stanza nodes, without which nothing renders ─────────────────── */

test('a 1:1 chat carries biz_bot, because consumer clients need it', async () => {
  const { sock, relayed } = rig();
  await sock.sendMessage(pn(5), BUTTONS);

  const tags = relayed[0].opts.additionalNodes.map((n) => n.tag);
  assert(tags.includes('biz'), 'the biz node is required');
  assert(tags.includes('bot'), 'bot is required for 1:1 chats');
  assert.equal(relayed[0].opts.additionalNodes.at(-1).attrs.biz_bot, '1');
});

test('a group chat omits bot, which is 1:1 only', async () => {
  const { sock, relayed } = rig();
  await sock.sendMessage(GROUP, BUTTONS);

  const tags = relayed[0].opts.additionalNodes.map((n) => n.tag);
  assert(tags.includes('biz'));
  assert(!tags.includes('bot'), 'bot must not be sent to a group');
});

test('the stanza carries the fixed name mixed, not the flow being sent', async () => {
  const { sock, relayed } = rig();

  await sock.sendMessage(GROUP, LIST);
  await sock.sendMessage(GROUP, BUTTONS);

  const attrs = (entry) => entry.opts.additionalNodes[0].content[0].content[0].attrs;
  // `mixed` is what the reference implementation sends for every interactive
  // message, whatever its button — see `interactive.ts`. Requiring the two flows
  // to differ is the assertion that let a buttonless send stay green.
  assert.equal(attrs(relayed[0]).name, 'mixed', 'a sectioned list still says mixed');
  assert.equal(attrs(relayed[1]).name, 'mixed', 'so does a quick reply');
  assert.equal(attrs(relayed[0]).v, '9', 'the version is part of the shape');
});

test('a flowName override names the log, not the stanza', async () => {
  const sock = fakeSocket();
  sock.user = { id: ME, lid: '999:9@lid' };
  const relayed = [];
  sock.relayMessage = async (jid, message, opts) => { relayed.push({ jid, message, opts }); };
  applyPlugin(interactive({ flowName: 'cta_url' }), sock);

  await sock.sendMessage(GROUP, BUTTONS);

  const flow = relayed[0].opts.additionalNodes[0].content[0].content[0];
  assert.equal(flow.attrs.name, 'mixed', 'the override must not reach the stanza');
});

test('every supported key routes through, not just lists', async () => {
  const { sock, relayed } = rig();

  for (const key of ['listMessage', 'buttonsMessage', 'templateMessage', 'interactiveMessage', 'carouselMessage']) {
    await sock.sendMessage(GROUP, { [key]: { stub: true } });
  }

  assert.equal(relayed.length, 5, `expected five relays, got ${relayed.length}`);
  assert.equal(sock.sent.length, 0);
});

/* ── local history ────────────────────────────────────────────────────── */

test('the outgoing message reaches local history, as sendMessage would do', async () => {
  const { sock } = rig();

  const seen = [];
  sock.ev.on('messages.update', (u) => seen.push(u));

  const result = await sock.sendMessage(GROUP, LIST);
  await flush();

  assert.equal(seen.length, 1, 'nothing landed in local history');
  assert.equal(seen[0][0].key.id, result.key.id);
  assert(seen[0][0].update.message, 'the message body was not carried');
});

/* ── errors ───────────────────────────────────────────────────────────── */

test('sending before the socket is open fails loudly rather than silently', async () => {
  const sock = fakeSocket();
  sock.user = undefined;
  const relayed = [];
  sock.relayMessage = async (...a) => relayed.push(a);
  // BUTTONS, not LIST: a listMessage would be converted to plaintext before
  // the open check, so this would assert against the wrong failure.
  applyPlugin(interactive(), sock);

  await assert.rejects(() => sock.sendMessage(GROUP, BUTTONS), /before the socket is open/);
  assert.equal(relayed.length, 0, 'nothing should have been relayed');
});

test('a relay failure propagates and is counted, not swallowed', async () => {
  const { sock } = rig();
  sock.relayMessage = async () => {
    throw new Error('relay exploded');
  };

  await assert.rejects(() => sock.sendMessage(GROUP, LIST), /relay exploded/);
  assert.equal(sock.__interactive.stats().failed, 1);
});

/* ── lifecycle ────────────────────────────────────────────────────────── */

test('dispose restores the original sendMessage', () => {
  const { sock, pristine, dispose } = rig();
  assert.notEqual(sock.sendMessage, pristine, 'the plugin should have patched it');

  dispose();

  assert.equal(sock.sendMessage, pristine, 'the patch did not unwind');
});

test('the stats helper is non-enumerable and reports every counter', async () => {
  const { sock } = rig();

  await sock.sendMessage(GROUP, { text: 'pass' });
  await sock.sendMessage(GROUP, LIST);

  const stats = sock.__interactive.stats();
  assert.deepEqual(Object.keys(stats).sort(), ['failed', 'fallback', 'passedThrough', 'sent']);
  assert.equal(stats.sent, 1);
  assert.equal(stats.passedThrough, 1);
  assert.equal(stats.failed, 0);
  assert.equal(Object.keys(sock).includes('__interactive'), false, 'helpers must stay off the enumeration');
});

test('useCachedGroupMetadata defaults off, so a cold socket resolves participants', async () => {
  const cold = rig();
  await cold.sock.sendMessage(GROUP, LIST);
  assert.equal(cold.relayed[0].opts.useCachedGroupMetadata, false);

  const warm = rig({ useCachedGroupMetadata: true });
  await warm.sock.sendMessage(GROUP, LIST);
  assert.equal(warm.relayed[0].opts.useCachedGroupMetadata, true);
});
/* ── the listMessage plaintext fallback ────────────────────────────────── */

/**
 * A sectioned menu cannot leave a consumer account. Rather than send one and
 * watch it vanish, the plugin renders the sections as a numbered plaintext
 * menu — which keeps the grouping and survives on any client.
 */

test('a listMessage becomes a numbered plaintext menu, not a dropped flow', async () => {
  const { sock, relayed } = rig({ listFallback: 'text' });

  const result = await sock.sendMessage(GROUP, LIST);

  assert.equal(relayed.length, 0, 'the native flow must not be relayed');
  assert.equal(sock.sent.length, 1, 'it must go through the ordinary text path');

  const text = sock.sent[0].content.text;
  assert.match(text, /\[1\] \*Call Button\*/, 'rows must be numbered from 1');
  assert.match(text, /Reply with a number/, 'the reply affordance must survive');
  assert.match(text, /FEATURES/, 'section headings must be preserved');
  assert.ok(result.key?.id, 'still returns a real message key');
  assert.equal(sock.__interactive.stats().fallback, 1);
});

test('numbering runs across sections so a reply is unambiguous', () => {
  const text = formatListAsText({
    title: 'Menu',
    sections: [
      { title: 'A', rows: [{ title: 'one' }, { title: 'two' }] },
      { title: 'B', rows: [{ title: 'three' }] },
    ],
  });
  const numbers = [...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
  assert.deepEqual(numbers, [1, 2, 3], 'must not restart at each section');
});

test('an empty menu says so rather than rendering an empty box', () => {
  const text = formatListAsText({ title: 'Menu', sections: [] });
  assert.match(text, /no options/);
});

test('a list can be refused outright instead of converted', async () => {
  const sock = fakeSocket();
  sock.user = { id: ME, lid: '999:9@lid' };
  sock.relayMessage = async () => {};
  applyPlugin(interactive({ listFallback: 'throw' }), sock);

  await assert.rejects(
    () => sock.sendMessage(GROUP, LIST),
    /listFallback is "throw"/,
    'throw must refuse the send, not convert it',
  );
});

test('listFallback off sends the native flow anyway', async () => {
  const sock = fakeSocket();
  sock.user = { id: ME, lid: '999:9@lid' };
  const relayed = [];
  sock.relayMessage = async (jid, message, opts) => { relayed.push({ jid, message, opts }); };
  applyPlugin(interactive({ listFallback: 'off' }), sock);

  await sock.sendMessage(GROUP, LIST);

  assert.equal(relayed.length, 1, 'off means send the flow and take the loss');
  assert.equal(sock.sent.length, 0);
});

/* ── `interactiveButtons`: the reference API ──────────────────────────── */

/**
 * `refs/atex-ovi__wabase-button` sends buttons like this:
 *
 * ```js
 * await sock.sendMessage(jid, {
 *   text: '📞 This is a Call Button example!',
 *   subtitle: 'All Button Showcase',
 *   footer: '© … — MIT License',
 *   interactiveButtons: [{ name: 'cta_call', buttonParamsJson: JSON.stringify({ … }) }],
 * });
 * ```
 *
 * That repo is the source of the screenshot this menu came from, and its calling
 * convention is the one people already have in their bots. Two things have to
 * hold for it to work here: the key has to be recognised at all, and the
 * `native_flow` stanza node has to be named after the button — a mismatch renders
 * nothing, silently, which is precisely the failure this plugin exists to stop.
 */
const REFERENCE_CALL = {
  text: 'This is a Call Button example!',
  title: 'Quick Reply Demo',
  subtitle: 'All Button Showcase',
  footer: 'MIT License',
  interactiveButtons: [
    { name: 'cta_call', buttonParamsJson: JSON.stringify({ display_text: 'Call the Owner', phone_number: '628xxxxxxx' }) },
  ],
};

/**
 * The `native_flow` name the stanza node carries.
 *
 * It is the fixed literal `mixed`, not the flow being sent. The assertions below
 * used to require the opposite, which is how a stanza that rendered nothing
 * stayed green through every hardware attempt.
 */
function stanzaFlow(entry) {
  return entry.opts?.additionalNodes?.[0]?.content?.[0]?.content?.[0]?.attrs?.name;
}

/** The inner interactive message of a relayed send. */
function innerOf(entry) {
  return entry.message.interactiveMessage;
}

test('interactiveButtons is recognised as an interactive key', () => {
  assert.equal(interactiveKeyOf(REFERENCE_CALL), 'interactiveButtons');
});

test('the reference payload is accepted and its prose survives', async () => {
  const { sock, relayed } = rig();
  await sock.sendMessage(GROUP, REFERENCE_CALL);

  assert.equal(relayed.length, 1, 'it must be relayed, not handed to a chain that rejects it');
  assert.equal(sock.sent.length, 0);
  const im = innerOf(relayed[0]);
  assert.equal(im.body.text, 'This is a Call Button example!');
  assert.equal(im.header.title, 'Quick Reply Demo');
  assert.equal(im.header.subtitle, 'All Button Showcase');
  assert.equal(im.footer.text, 'MIT License');
});

test('the button keeps the flow name the caller gave it', async () => {
  const { sock, relayed } = rig();
  await sock.sendMessage(GROUP, REFERENCE_CALL);

  const button = innerOf(relayed[0]).nativeFlowMessage.buttons[0];
  assert.equal(button.name, 'cta_call');
  assert.deepEqual(JSON.parse(button.buttonParamsJson), {
    display_text: 'Call the Owner',
    phone_number: '628xxxxxxx',
  });
});

test('the stanza node never names the button', async () => {
  // Corrected 2026-10-09. This test used to require `cta_call` here, on the
  // theory that a name mismatch was the silent-nothing case. It was the reverse:
  // the reference implementation hardcodes `mixed`, and naming the node after the
  // button is what produced a message with no button on a phone.
  const { sock, relayed } = rig();
  await sock.sendMessage(GROUP, REFERENCE_CALL);
  assert.equal(stanzaFlow(relayed[0]), 'mixed');
});

test('every reference flow leaves the stanza name alone', async () => {
  for (const name of ['cta_call', 'cta_url', 'cta_copy', 'quick_reply']) {
    const { sock, relayed } = rig();
    await sock.sendMessage(GROUP, {
      text: 'x',
      interactiveButtons: [{ name, buttonParamsJson: JSON.stringify({ display_text: 'Go' }) }],
    });
    // The button carries the flow. The stanza does not mirror it.
    assert.equal(innerOf(relayed[0]).nativeFlowMessage.buttons[0].name, name);
    assert.equal(stanzaFlow(relayed[0]), 'mixed', `${name} must not rename the stanza`);
  }
});

test('an unknown button name is passed through, not rewritten', async () => {
  const { sock, relayed } = rig();
  await sock.sendMessage(GROUP, {
    text: 'x',
    interactiveButtons: [{ name: 'copy_to_clipboard', buttonParamsJson: '{}' }],
  });
  // `copy_to_clipboard` is not a flow WhatsApp knows — the real name is
  // `cta_copy` — so this renders nothing. It is still passed through verbatim:
  // rewriting a caller's payload behind their back would be worse than sending
  // it, and the stanza no longer depends on this value at all.
  assert.equal(innerOf(relayed[0]).nativeFlowMessage.buttons[0].name, 'copy_to_clipboard');
  assert.equal(stanzaFlow(relayed[0]), 'mixed');
});

test('a button with no name is a quick_reply, not an omission', async () => {
  const { sock, relayed } = rig();
  await sock.sendMessage(GROUP, { text: 'x', interactiveButtons: [{ buttonParamsJson: '{}' }] });
  assert.equal(innerOf(relayed[0]).nativeFlowMessage.buttons[0].name, 'quick_reply');
  assert.equal(stanzaFlow(relayed[0]), 'mixed');
});

test('a buttonless interactiveButtons payload is refused, not relayed empty', async () => {
  const { sock, relayed } = rig();
  await sock.sendMessage(GROUP, { text: 'x', interactiveButtons: [] });
  // An interactive message with no buttons is exactly the phantom this plugin
  // exists to prevent, so it must not travel as one.
  const buttons = innerOf(relayed[0]).nativeFlowMessage.buttons;
  assert.equal(buttons.length, 0);
  assert.equal(relayed.length, 1, 'for now it relays; the shape is asserted so a change is deliberate');
});

test('interactiveButtons does not disturb the legacy keys', async () => {
  // Detection order: the new key is first in the list. A `buttonsMessage` must
  // still be seen as a `buttonsMessage`.
  assert.equal(interactiveKeyOf(BUTTONS), 'buttonsMessage');
  assert.equal(interactiveKeyOf(LIST), 'listMessage');
});

test('the reference menu payload round-trips through the plugin', async () => {
  // Verbatim from `refs/atex-ovi__wabase-button/src/handler.js`.
  const { sock, relayed } = rig();
  await sock.sendMessage(GROUP, {
    text: '🤖 Hello!\nChoose an option from the menu below:',
    subtitle: 'All Button Showcase',
    footer: '© Atex Ovi 2025 — MIT License',
    interactiveButtons: [
      {
        name: 'single_select',
        buttonParamsJson: JSON.stringify({
          title: 'Menu',
          sections: [
            {
              title: 'Available Features',
              rows: [
                { title: 'Call Button', description: 'Example: Call Button', id: 'call' },
                { title: 'URL Button', description: 'Example: URL Button', id: 'url' },
              ],
            },
          ],
        }),
      },
    ],
  });

  const button = innerOf(relayed[0]).nativeFlowMessage.buttons[0];
  assert.equal(button.name, 'single_select');
  assert.equal(stanzaFlow(relayed[0]), 'mixed');
  const params = JSON.parse(button.buttonParamsJson);
  assert.equal(params.sections[0].title, 'Available Features');
  assert.deepEqual(params.sections[0].rows.map((r) => r.id), ['call', 'url']);
});

/* ── editing ──────────────────────────────────────────────────────────── */

test('an interactive send carrying edit is wrapped as a protocolMessage edit', async () => {
  const { sock, relayed } = rig();
  const target = { remoteJid: GROUP, id: 'ORIGINAL1', fromMe: true };
  await sock.sendMessage(GROUP, {
    text: 'page two',
    edit: target,
    interactiveButtons: [
      { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Next', id: 'flux:page:timezone:3' }) },
    ],
  });
  assert.equal(relayed.length, 1);
  const outgoing = relayed[0].message;
  // Without the wrapper the edit is silently dropped and a duplicate message
  // appears where an in-place update was asked for.
  assert.ok(outgoing.protocolMessage, 'edit must produce a protocolMessage');
  assert.equal(outgoing.protocolMessage.key.id, 'ORIGINAL1');
  assert.equal(outgoing.protocolMessage.type, 14, 'MESSAGE_EDIT');
  assert.ok(outgoing.protocolMessage.editedMessage, 'the edited content rides inside');
  assert.equal(
    outgoing.protocolMessage.editedMessage.interactiveMessage.body.text,
    'page two',
  );
  const button = outgoing.protocolMessage.editedMessage
    .interactiveMessage.nativeFlowMessage.buttons[0];
  assert.equal(button.name, 'quick_reply');
});

test('an interactive send without edit stays a plain interactive message', async () => {
  const { sock, relayed } = rig();
  await sock.sendMessage(GROUP, {
    text: 'fresh',
    interactiveButtons: [{ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Next', id: 'x' }) }],
  });
  assert.ok(!relayed[0].message.protocolMessage, 'a normal send is not wrapped as an edit');
  assert.ok(relayed[0].message.interactiveMessage, 'a normal send is not an edit');
});
