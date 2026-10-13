/**
 * The feature menu — the native `single_select` sheet whose rows are the
 * interactive button kinds the library can actually send.
 *
 * The load-bearing test here is not that the rows render. It is that the menu
 * **cannot offer a button nothing can send**. That guarantee comes from deriving
 * the rows out of two registries instead of writing them down:
 *
 *   - `NATIVE_FLOW_NAMES`, exported by the interactive plugin
 *     (`src/plugins/interactive.ts`) — the flows WhatsApp renders.
 *   - `FLOW_SENDERS`, the flows this library sends and the exported functions
 *     that send them.
 *
 * So the suite tests the derivation, not a snapshot of it:
 *
 *   1. every sender name resolves to a real callable (a rename fails here),
 *   2. every menu row's flow has a sender (capability, not vibes),
 *   3. every flow the plugin declares is accounted for — in the menu, excluded,
 *      unlabelled, or reported unsendable — so nothing can be silently dropped,
 *   4. a caller-supplied list cannot smuggle an unsendable flow in.
 *
 * `Location Request` was briefly a row in this menu with no sender behind it.
 * That is the defect these assertions exist to make impossible.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { proto } from '../dist/index.js';
import {
  FEATURE_LABELS,
  FEATURE_MENU_SECTION_TITLE,
  FLOW_SENDERS,
  INTERACTIVE_FEATURES,
  MENU_EXCLUDED_FLOWS,
  NATIVE_FLOW_NAMES,
  SENDER_MODULES,
  canSend,
  featureButton,
  featureById,
  featureMenu,
  featureMenuCategories,
  featureMenuText,
  featureRow,
  isNativeFlowName,
  resolveFeatureId,
  resolveFeatureMenuSelection,
  sendFeatureExample,
  sendFeatureMenu,
  senderRef,
  sendableFeatures,
  unlabelledSendableFlows,
  unsendableFlows,
} from '../dist/toolkit/index.js';
import { interactive } from '../dist/plugins/interactive.js';
import { readMenuSelection } from '../dist/toolkit/category-menu.js';
import { NATIVE_FLOW_NAMES as PLUGIN_FLOWS } from '../dist/plugins/interactive.js';

import { applyPlugin, fakeSocket } from './helpers.js';

const JID = '62882017467912@s.whatsapp.net';

function rig() {
  const sock = fakeSocket();
  sock.user = { id: '6283831459585:12@s.whatsapp.net' };
  const relayed = [];
  sock.relayMessage = async (jid, message, opts) => { relayed.push({ jid, message, opts }); };
  applyPlugin({ name: 'noop', order: 1, apply() {} }, sock);
  return { sock, relayed };
}

/** Pull the opaque single_select payload back out of the built message. */
function paramsOf(entry) {
  const im = entry.message.viewOnceMessage.message.interactiveMessage;
  return {
    buttonName: im.nativeFlowMessage.buttons[0].name,
    payload: JSON.parse(im.nativeFlowMessage.buttons[0].buttonParamsJson),
    body: im.body.text,
    footer: im.footer.text,
  };
}

/** A feature that looks fine except that nothing in the library can send it. */
function unsendableFeature(flow) {
  return { id: 'ghost', title: 'Ghost', description: 'Example: Ghost', flow, senders: [] };
}

/* ── registry 1: derived from the plugin, not restated ─────────────────── */

test('the flow list is the plugin\'s, by identity', () => {
  // Not "deepEqual" — the same array. A copy that merely matched today would
  // drift the first time a flow is added to the plugin.
  assert.equal(NATIVE_FLOW_NAMES, PLUGIN_FLOWS,
    'the menu must read the plugin registry, not keep its own copy');
});

test('every flow the plugin declares is a string name', () => {
  assert.ok(NATIVE_FLOW_NAMES.length >= 5);
  for (const flow of NATIVE_FLOW_NAMES) {
    assert.equal(typeof flow, 'string');
    assert.ok(flow.length > 0);
  }
});

test('isNativeFlowName accepts the plugin list and rejects near-misses', () => {
  for (const flow of NATIVE_FLOW_NAMES) assert.equal(isNativeFlowName(flow), true, flow);
  // `copy_to_clipboard` is not a WhatsApp flow name and is silently dropped.
  assert.equal(isNativeFlowName('copy_to_clipboard'), false);
  assert.equal(isNativeFlowName('cta_copy'), true);
  assert.equal(isNativeFlowName(''), false);
  assert.equal(isNativeFlowName('single_select '), false, 'no trimming — a stray space is a different flow');
});

/* ── registry 2: every declared sender actually exists ─────────────────── */

test('FLOW_SENDERS covers exactly the flows the plugin declares', () => {
  assert.deepEqual(
    Object.keys(FLOW_SENDERS).sort(),
    [...NATIVE_FLOW_NAMES].sort(),
    'a flow with no entry is an unanswered question; an entry for an unknown flow is dead code',
  );
});

test('every sender name resolves to a callable export', async () => {
  for (const flow of NATIVE_FLOW_NAMES) {
    for (const name of FLOW_SENDERS[flow]) {
      const ref = senderRef(name);
      assert.ok(ref, `${flow} names sender "${name}" but there is no module for it`);
      assert.ok(SENDER_MODULES[name], `${name} has no SENDER_MODULES entry`);
      const mod = await import(`../dist/${ref.module}.js`);
      assert.equal(
        typeof mod[ref.name], 'function',
        `${flow} advertises "${name}", but ${ref.module} does not export a function by that name`,
      );
    }
  }
});

test('no flow claims a sender it does not name', () => {
  for (const flow of NATIVE_FLOW_NAMES) {
    assert.ok(Array.isArray(FLOW_SENDERS[flow]), `${flow} is not a list`);
    for (const name of FLOW_SENDERS[flow]) {
      assert.equal(typeof name, 'string');
      assert.ok(name.trim().length > 0);
    }
  }
});

test('canSend agrees with the sender lists', () => {
  for (const flow of NATIVE_FLOW_NAMES) {
    assert.equal(canSend(flow), FLOW_SENDERS[flow].length > 0, flow);
  }
});

/* ── the guarantee ─────────────────────────────────────────────────────── */

test('every menu row is backed by a real sender', () => {
  for (const feature of sendableFeatures()) {
    assert.ok(feature.senders.length > 0, `${feature.id} is in the menu with nothing to send it`);
    assert.ok(canSend(feature.flow), `${feature.id} names an unsendable flow`);
    assert.deepEqual(feature.senders, FLOW_SENDERS[feature.flow]);
  }
});

test('every menu row names a flow the plugin can render', () => {
  for (const feature of sendableFeatures()) {
    assert.ok(isNativeFlowName(feature.flow), `${feature.id} advertises an unrenderable flow`);
  }
});

test('the exported catalog is the derived set, unchanged', () => {
  assert.deepEqual(INTERACTIVE_FEATURES, sendableFeatures());
});

test('payment and location_request are sendable by nobody and never menu rows', () => {
  assert.deepEqual(unsendableFlows().sort(), ['location_request', 'payment']);

  const ids = sendableFeatures().map((f) => f.flow);
  for (const flow of unsendableFlows()) {
    assert.equal(ids.includes(flow), false, `${flow} has no sender but reached the menu`);
  }
});

test('a label on an unsendable flow does nothing — capability wins', () => {
  // The registry, not the label table, decides. This is what makes the
  // guarantee structural rather than a convention someone can forget.
  assert.equal(canSend('location_request'), false);
  const derivable = sendableFeatures().some((f) => f.flow === 'location_request');
  assert.equal(derivable, false);
});

test('nothing sendable is silently missing a row', () => {
  // Empty means every sendable flow was either given a row or deliberately
  // excluded. A flow wired up with no label is a decision nobody made.
  assert.deepEqual(unlabelledSendableFlows(), []);
});

test('every flow the plugin declares is accounted for exactly once', () => {
  const accounted = new Set([
    ...sendableFeatures().map((f) => f.flow),
    ...MENU_EXCLUDED_FLOWS,
    ...unsendableFlows(),
    ...unlabelledSendableFlows(),
  ]);
  for (const flow of NATIVE_FLOW_NAMES) {
    assert.ok(accounted.has(flow), `${flow} is in no bucket — it would vanish silently`);
  }
  assert.equal(accounted.size, NATIVE_FLOW_NAMES.length, 'a flow is in two buckets at once');
});

/* ── the catalog ───────────────────────────────────────────────────────── */

test('the catalog is the sheet from the screenshot, minus the row with no sender', () => {
  assert.deepEqual(
    sendableFeatures().map((f) => f.title),
    ['Call Button', 'URL Button', 'Quick Reply Button', 'Copy Button'],
  );
});

test('Location Request is gone from the menu, and only because it had no sender', () => {
  assert.equal(featureById('location_request'), null);
  assert.equal(sendableFeatures().some((f) => f.title === 'Location Request'), false);
  assert.ok(unsendableFlows().includes('location_request'),
    'the flow must be reported, not quietly deleted from the world');
});

test('routing ids are unique and every catalog entry carries copy', () => {
  const ids = sendableFeatures().map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, 'two rows sharing an id route a tap to the wrong feature');
  for (const feature of sendableFeatures()) {
    assert.ok(feature.title.length > 0, `${feature.id} has no title`);
    assert.match(feature.description, /^Example: /, `${feature.id} has no example line`);
    assert.ok(feature.id.length > 0);
  }
});

test('the label table only names flows the plugin declares', () => {
  for (const flow of Object.keys(FEATURE_LABELS)) {
    assert.ok(isNativeFlowName(flow), `label for unknown flow "${flow}"`);
  }
});

test('featureById finds a known id and returns null otherwise', () => {
  assert.equal(featureById('copy_button')?.flow, 'cta_copy');
  assert.equal(featureById('nope'), null);
  assert.equal(featureById('location_request'), null);
});

test('featureRow is the feature\'s own fields', () => {
  for (const feature of sendableFeatures()) {
    const row = featureRow(feature);
    assert.equal(row.rowId, feature.id);
    assert.equal(row.title, feature.title);
    assert.equal(row.description, feature.description);
  }
});

/* ── the builders ──────────────────────────────────────────────────────── */

test('the menu is one section titled Available Features', () => {
  const menu = featureMenu();
  assert.equal(menu.sections.length, 1);
  assert.equal(menu.sections[0].title, FEATURE_MENU_SECTION_TITLE);
});

test('the menu defaults match the rendered sheet', () => {
  const menu = featureMenu();
  assert.equal(menu.title, 'Menu');
  assert.equal(menu.buttonText, 'Menu');
  assert.equal(menu.text, 'Hello! Choose an option from the menu below:');
  assert.match(menu.footer, /MIT License/);
});

test('every derived feature survives into the menu with its id as rowId', () => {
  const rows = featureMenu().sections[0].rows;
  assert.equal(rows.length, sendableFeatures().length);
  for (const feature of sendableFeatures()) {
    const row = rows.find((r) => r.rowId === feature.id);
    assert.ok(row, `${feature.id} is missing from the menu`);
    assert.equal(row.title, feature.title);
    assert.equal(row.description, feature.description);
  }
});

test('options override the body, button, title, footer and section heading', () => {
  const menu = featureMenu({
    text: 'Pick one', buttonTitle: 'Open', title: 'Features',
    footer: 'Bye', sectionTitle: 'Buttons',
  });
  assert.equal(menu.text, 'Pick one');
  assert.equal(menu.buttonText, 'Open');
  assert.equal(menu.title, 'Features');
  assert.equal(menu.footer, 'Bye');
  assert.equal(menu.sections[0].title, 'Buttons');
});

test('a caller can restrict the menu to a subset, keeping the given order', () => {
  const all = sendableFeatures();
  const subset = [all[3], all[0]];
  const rows = featureMenu({ features: subset }).sections[0].rows;
  assert.deepEqual(rows.map((r) => r.rowId), [all[3].id, all[0].id]);
});

test('an empty list is refused rather than sent as a dead button', () => {
  assert.throws(() => featureMenu({ features: [] }), /at least one feature/);
});

test('an unsendable flow is refused at build time, even from the caller', () => {
  // The guarantee has to hold for the override path too, otherwise it is a
  // property of the default list rather than of the menu.
  assert.throws(
    () => featureMenu({ features: [unsendableFeature('location_request')] }),
    /no sender in this library/,
  );
  assert.throws(
    () => featureMenu({ features: [unsendableFeature('payment')] }),
    /no sender in this library/,
  );
});

test('an unrenderable flow is refused at build time', () => {
  assert.throws(
    () => featureMenu({ features: [unsendableFeature('copy_to_clipboard')] }),
    /not a native flow WhatsApp renders/,
  );
});

test('a feature with no title is refused', () => {
  assert.throws(
    () => featureMenu({ features: [{ ...sendableFeatures()[0], title: '   ' }] }),
    /has no title/,
  );
});

test('featureMenuCategories keys rows by id, the client schema', () => {
  const [section] = featureMenuCategories();
  assert.equal(section.rows[0].id, sendableFeatures()[0].id);
  assert.equal(section.rows[0].rowId, undefined,
    'rowId belongs to listMessage, which rc14 cannot send');
});

test('the category builder rejects an id that is not a feature', () => {
  assert.throws(() => resolveFeatureId('ghost'), /unknown row id/);
  assert.throws(() => resolveFeatureId('location_request'), /unknown row id/);
});

/* ── the text fallback ─────────────────────────────────────────────────── */

test('the text fallback contains every feature, numbered', () => {
  const text = featureMenuText();
  for (const feature of sendableFeatures()) {
    assert.ok(text.includes(feature.title), `${feature.title} missing from the fallback`);
    assert.ok(text.includes(feature.description), `${feature.description} missing from the fallback`);
  }
  assert.ok(text.includes('[1]'));
  assert.ok(text.includes(`[${sendableFeatures().length}]`));
  assert.ok(text.includes(FEATURE_MENU_SECTION_TITLE.toUpperCase()));
  assert.match(text, /Reply with a number/);
});

test('the text fallback cannot mention an unsendable button either', () => {
  const text = featureMenuText();
  assert.equal(text.includes('Location Request'), false);
  assert.equal(text.includes('Payment Request'), false);
});

test('the text fallback numbers the restricted subset, not the whole catalog', () => {
  const text = featureMenuText({ features: [sendableFeatures()[0]] });
  assert.ok(text.includes('[1]'));
  assert.equal(text.includes('[2]'), false);
});

/* ── the send ──────────────────────────────────────────────────────────── */

test('sendFeatureMenu relays a single_select payload, not a listMessage', async () => {
  const { sock, relayed } = rig();
  await sendFeatureMenu(sock, JID);

  assert.equal(relayed.length, 1);
  assert.equal(sock.sent.length, 0, 'sendMessage cannot reach this content type');
  assert.equal(paramsOf(relayed[0]).buttonName, 'single_select');
});

test('the sent rows are keyed by id and carry the catalog titles', async () => {
  const { sock, relayed } = rig();
  await sendFeatureMenu(sock, JID);

  const { payload } = paramsOf(relayed[0]);
  assert.equal(payload.title, 'Menu');
  assert.equal(payload.sections[0].title, FEATURE_MENU_SECTION_TITLE);
  const row = payload.sections[0].rows[0];
  assert.equal(row.id, sendableFeatures()[0].id);
  assert.equal('rowId' in row, false);
});

test('the send reports every selectable id', async () => {
  const { sock } = rig();
  const result = await sendFeatureMenu(sock, JID);
  assert.deepEqual(result.selectableIds, sendableFeatures().map((f) => f.id));
});

test('the reporting secret is attached to the relayed message', async () => {
  const { sock, relayed } = rig();
  await sendFeatureMenu(sock, JID);
  assert.equal(relayed[0].message.messageContextInfo.messageSecret.length, 32);
});

test('what is sent is what can be matched back', async () => {
  const { sock, relayed } = rig();
  const sent = await sendFeatureMenu(sock, JID);
  const { payload } = paramsOf(relayed[0]);

  for (const id of sent.selectableIds) {
    const echoed = readMenuSelection({
      interactiveResponseMessage: {
        nativeFlowResponseMessage: { paramsJson: JSON.stringify({ id }) },
      },
    });
    assert.equal(echoed, id);
    assert.ok(payload.sections.some((s) => s.rows.some((r) => r.id === id)),
      `${id} was reported selectable but is not in the payload`);
  }
});

test('a selection id resolves back to the feature that was picked', async () => {
  const { sock } = rig();
  const { selectableIds } = await sendFeatureMenu(sock, JID);

  for (const id of selectableIds) {
    const echoed = readMenuSelection({
      interactiveResponseMessage: {
        nativeFlowResponseMessage: { paramsJson: JSON.stringify({ id }) },
      },
    });
    assert.equal(resolveFeatureMenuSelection(echoed)?.id, id);
  }
});

test('resolveFeatureMenuSelection tolerates null, empty and unknown ids', () => {
  assert.equal(resolveFeatureMenuSelection(null), null);
  assert.equal(resolveFeatureMenuSelection(''), null);
  assert.equal(resolveFeatureMenuSelection('ghost'), null);
});

test('the built menu survives a protobuf round trip', async () => {
  const { sock, relayed } = rig();
  await sendFeatureMenu(sock, JID);

  const bytes = proto.Message.encode(relayed[0].message).finish();
  const back = proto.Message.toObject(proto.Message.decode(bytes));
  const im = back.viewOnceMessage.message.interactiveMessage;
  assert.ok(im, 'the menu must be real protobuf, not a loose object');
  assert.equal(im.nativeFlowMessage.buttons[0].name, 'single_select');
});

/* ── the reference menu it is modelled on ─────────────────────────────── */

/**
 * `refs/atex-ovi__wabase-button/src/handler.js` is the source of the screenshot.
 *
 * Its menu is four rows — Call, URL, Quick Reply, Copy — with ids `call`, `url`,
 * `quick`, `copy`, under a section titled `Available Features`, behind a button
 * titled `Menu`. Its four feature files are one sender per flow.
 *
 * The derivation is checked against that shape, because the reference is the only
 * version of this menu that has been seen working on a phone. Where we differ it
 * should be a decision, not an accident: our row ids are descriptive rather than
 * one word, and the footer carries our licence rather than the reference's.
 */

test('the derived rows are the reference menu, in the reference order', () => {
  assert.deepEqual(
    sendableFeatures().map((f) => f.title),
    ['Call Button', 'URL Button', 'Quick Reply Button', 'Copy Button'],
    'the reference shows exactly four rows, in this order',
  );
});

test('the section heading and button title match the reference', () => {
  const menu = featureMenu();
  assert.equal(menu.sections[0].title, 'Available Features');
  assert.equal(menu.buttonText, 'Menu');
});

test('every feature carries a display order, and no two share one', () => {
  const orders = sendableFeatures().map((f) => f.order);
  assert.equal(new Set(orders).size, orders.length, 'a duplicate order makes the menu order unstable');
  for (const order of orders) assert.equal(typeof order, 'number');
});

test('the menu order does not follow the plugin declaration order', () => {
  // The plugin lists `quick_reply` first; the reference menu does not. If these
  // ever coincide by accident the sort has stopped doing anything.
  const derived = sendableFeatures().map((f) => f.flow);
  const pluginOrder = NATIVE_FLOW_NAMES.filter((f) => derived.includes(f));
  assert.notDeepEqual(derived, pluginOrder,
    'the rows are the plugin order again — the explicit order field is not being applied');
});

/* ── the button a row sends ───────────────────────────────────────────── */

test('featureButton names the flow and carries its params', () => {
  const button = featureButton('call_button');
  assert.equal(button.name, 'cta_call');
  const params = JSON.parse(button.buttonParamsJson);
  assert.equal(params.display_text, 'Call the Owner');
  assert.equal(typeof params.phone_number, 'string');
});

test('every feature yields a button named after its own flow', () => {
  for (const feature of sendableFeatures()) {
    const button = featureButton(feature.id);
    assert.equal(button.name, feature.flow,
      'the stanza node is named from this, so a mismatch renders nothing');
    assert.doesNotThrow(() => JSON.parse(button.buttonParamsJson));
  }
});

test('featureButton takes caller params, and refuses an unknown row', () => {
  const button = featureButton('copy_button', { display_text: 'Copy it', copy_code: 'ABC-123' });
  assert.deepEqual(JSON.parse(button.buttonParamsJson), { display_text: 'Copy it', copy_code: 'ABC-123' });
  assert.throws(() => featureButton('ghost'), /unknown row id/);
  assert.throws(() => featureButton('location_request'), /unknown row id/);
});

test('the reference\'s button params are never shipped as our defaults', () => {
  // The reference hardcodes its author's phone number and repo URL. Copying them
  // into a library default would make every user call a stranger.
  const serialised = sendableFeatures().map((f) => featureButton(f.id).buttonParamsJson).join(' ');
  assert.equal(serialised.includes('628xxxxxxx'), false);
  assert.equal(serialised.includes('atex-ovi'), false);
});

/* ── sending one example, the reference's way ─────────────────────────── */

test('sendFeatureExample uses the reference calling convention', async () => {
  // `interactiveButtons` as a content key, not a prebuilt interactiveMessage.
  const calls = [];
  const sock = { sendMessage: async (jid, content) => { calls.push({ jid, content }); return { key: { id: 'X' } }; } };
  await sendFeatureExample(sock, JID, 'url_button');

  assert.equal(calls.length, 1);
  const content = calls[0].content;
  assert.ok(Array.isArray(content.interactiveButtons), 'the reference shape, verbatim');
  assert.equal(content.interactiveButtons[0].name, 'cta_url');
  assert.equal(typeof content.text, 'string');
});

test('a feature example is relayed with the fixed stanza name, not its flow', async () => {
  // Through the real plugin, because that is where the stanza is built.
  //
  // This used to assert the stanza named the feature's flow. It does not: the
  // name is the literal `mixed` for every interactive send, and requiring the
  // flows there is what let a buttonless send pass on hardware.
  const sock = fakeSocket();
  sock.user = { id: '6283831459585:12@s.whatsapp.net' };
  const relayed = [];
  sock.relayMessage = async (jid, message, opts) => { relayed.push({ jid, message, opts }); };
  applyPlugin(interactive(), sock);

  for (const feature of sendableFeatures()) {
    relayed.length = 0;
    await sendFeatureExample(sock, JID, feature.id);

    const inner = relayed[0].message.viewOnceMessage.message.interactiveMessage;
    // The button still declares the real flow — that half is the caller's data.
    assert.equal(inner.nativeFlowMessage.buttons[0].name, feature.flow);

    const node = relayed[0].opts?.additionalNodes?.[0]?.content?.[0]?.content?.[0]?.attrs?.name;
    assert.equal(node, 'mixed', `${feature.id} must not rename the stanza`);
  }
});

test('sendFeatureExample refuses an id that is not a feature', async () => {
  const calls = [];
  const sock = { sendMessage: async (...a) => { calls.push(a); } };
  await assert.rejects(() => sendFeatureExample(sock, JID, 'location_request'), /unknown row id/);
  assert.equal(calls.length, 0, 'nothing may go out for an unknown row');
});
