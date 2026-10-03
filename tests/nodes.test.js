/**
 * Protobuf node builders.
 *
 * The thing that actually matters here is the native-flow payload. rc14's
 * `INativeFlowMessage` is only `{ messageVersion, messageParamsJson, buttons }`
 * — the whole UI lives inside `messageParamsJson` as a JSON *string*. If that
 * string is malformed the client renders a text bubble instead of the form, so
 * every builder is round-tripped through `JSON.parse` and through protobufjs'
 * real encoder/decoder rather than just being inspected.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { proto } from '@whiskeysockets/baileys';

import {
  buildFlowMessageParams,
  carouselCardWithMedia,
  createAlbumContainer,
  createCarouselFlow,
  createEdit,
  createFormFlow,
  createTableFlow,
  infoRow,
  radioRow,
  toFlowMessage,
  toNatives,
} from '../dist/core/nodes.js';

const NativeFlow = proto.Message.InteractiveMessage.NativeFlowMessage;

/** Unwrap the native flow out of an interactive node. */
const flowOf = (node) => node.message.interactiveMessage.nativeFlowMessage;

/** Parse a payload, failing loudly (with the raw string) if it is not JSON. */
function params(raw, label = 'messageParamsJson') {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${err.message}\n  raw: ${raw}`);
  }
}

/** Encode/decode through protobufjs — proves the node is wire-legal. */
function wireRoundTrip(node) {
  const nf = flowOf(node);
  const bytes = NativeFlow.encode(nf).finish();
  assert.ok(bytes.length > 0, 'native flow encoded to zero bytes');
  return NativeFlow.decode(bytes);
}

/* ── buildFlowMessageParams ──────────────────────────────────────────── */

test('buildFlowMessageParams applies the documented defaults', () => {
  const p = buildFlowMessageParams({
    title: 'Pick one',
    sections: [{ rows: [{ title: 'A', optionName: 'a' }] }],
  });

  assert.equal(p.title, 'Pick one');
  assert.equal(p.ctaLabel, 'Continue');
  assert.equal(p.mediaType, 'image/jpeg');
  assert.equal('body' in p, false, 'an absent body must not appear as a key');
  assert.equal('footer' in p, false);
  assert.deepEqual(p.sections, [{ rows: [{ title: 'A', optionName: 'a' }] }]);
});

test('buildFlowMessageParams wraps body and footer into objects and keeps order', () => {
  const p = buildFlowMessageParams({
    title: 'T',
    body: 'B',
    footer: 'F',
    ctaLabel: 'Go',
    mediaType: 'image/png',
    sections: [
      {
        title: 'Sec',
        description: 'D',
        highlightLabel: 'Hi',
        rows: [{ header: 'H', title: 'r', description: 'rd', optionName: 'o' }],
      },
    ],
  });

  assert.deepEqual(p.body, { text: 'B' });
  assert.deepEqual(p.footer, { text: 'F' });
  assert.equal(p.mediaType, 'image/png');
  assert.deepEqual(p.sections[0], {
    title: 'Sec',
    description: 'D',
    highlightLabel: 'Hi',
    rows: [{ header: 'H', title: 'r', description: 'rd', optionName: 'o' }],
  });
  // Nothing undefined leaked into the object graph.
  assert.doesNotThrow(() => JSON.stringify(p));
  assert.equal(JSON.stringify(p).includes('undefined'), false);
});

test('radioRow and infoRow mark selectability explicitly', () => {
  assert.deepEqual(radioRow('Pick', 'opt_1', 'why'), {
    title: 'Pick',
    optionName: 'opt_1',
    description: 'why',
  });
  assert.equal(radioRow('Pick', 'opt_1').optionName, 'opt_1');

  const info = infoRow('Total', '42', 'Numbers');
  assert.equal(info.title, 'Total');
  assert.equal(info.description, '42');
  assert.equal(info.header, 'Numbers');
  assert.equal('optionName' in info, false, 'info rows are deliberately not selectable');
});

/* ── toFlowMessage ───────────────────────────────────────────────────── */

test('toFlowMessage emits messageVersion 1 with parseable buttonParamsJson', () => {
  const p = buildFlowMessageParams({
    title: 'Pick',
    ctaLabel: 'Send',
    sections: [{ rows: [{ title: 'A', optionName: 'a' }] }],
  });
  const nf = toFlowMessage(p);

  assert.equal(nf.messageVersion, 1);
  assert.equal(nf.buttons.length, 1);
  assert.equal(nf.buttons[0].name, 'native_flow_cta');

  const button = params(nf.buttons[0].buttonParamsJson, 'buttonParamsJson');
  assert.deepEqual(button, { displayName: 'Send' });

  const parsed = params(nf.messageParamsJson);
  assert.equal(parsed.title, 'Pick');
  assert.equal(parsed.ctaLabel, 'Send');
});

test('toNatives is an alias of toFlowMessage, not a second implementation', () => {
  assert.equal(toNatives, toFlowMessage);
});

/* ── form flow ───────────────────────────────────────────────────────── */

test('createFormFlow emits a native flow that round-trips through JSON and protobuf', () => {
  const node = createFormFlow({
    title: 'Order',
    body: 'Choose a size',
    footer: 'Free returns',
    ctaLabel: 'Confirm',
    sections: [
      { title: 'Sizes', rows: [radioRow('Small', 'size_s', 'Fits 36-38'), radioRow('Large', 'size_l')] },
    ],
  });

  const nf = flowOf(node);
  assert.equal(nf.messageVersion, 1);

  const decoded = wireRoundTrip(node);
  assert.equal(decoded.messageParamsJson, nf.messageParamsJson, 'payload survived protobuf');

  const p = params(decoded.messageParamsJson);
  assert.equal(p.title, 'Order');
  assert.deepEqual(p.body, { text: 'Choose a size' });
  assert.deepEqual(p.footer, { text: 'Free returns' });
  assert.equal(p.ctaLabel, 'Confirm');
  assert.equal(p.mediaType, 'image/jpeg');

  const rows = p.sections[0].rows;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.optionName), ['size_s', 'size_l']);
  assert.deepEqual(params(nf.buttons[0].buttonParamsJson), { displayName: 'Confirm' });
});

test('every selectable row in a form flow carries a non-empty optionName', () => {
  const node = createFormFlow({
    title: 'Pick',
    sections: [
      { rows: [radioRow('A', 'opt_a'), radioRow('B', 'opt_b'), radioRow('C', 'opt_c')] },
      { rows: [radioRow('D', 'opt_d')] },
    ],
  });

  const p = params(flowOf(node).messageParamsJson);
  const rows = p.sections.flatMap((s) => s.rows);
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(typeof row.optionName, 'string', `row ${row.title} has no optionName`);
    assert.ok(row.optionName.length > 0);
  }
  assert.deepEqual(rows.map((r) => r.optionName), ['opt_a', 'opt_b', 'opt_c', 'opt_d']);
  // optionName must be unique across the whole flow or a selection is ambiguous.
  assert.equal(new Set(rows.map((r) => r.optionName)).size, rows.length);
});

test('a row built by hand without an optionName stays without one (nodes does not invent it)', () => {
  const node = createFormFlow({ title: 'T', sections: [{ rows: [{ title: 'Bare' }] }] });
  const p = params(flowOf(node).messageParamsJson);
  assert.equal('optionName' in p.sections[0].rows[0], false);
});

test('the interactive body/footer/header mirror the flow params', () => {
  const node = createFormFlow({
    title: 'Order',
    body: 'Pick one',
    ctaLabel: 'Confirm',
    sections: [],
  });
  const im = node.message.interactiveMessage;

  assert.equal(im.header.title, 'Order');
  assert.equal(im.header.subtitle, 'Pick one');
  assert.equal(im.header.hasMediaAttachment, false);
  assert.equal(im.body.text, 'Pick one');
  assert.equal(im.footer.text, 'Confirm', 'an absent footer falls back to the cta label');
});

test('a form flow with no body uses the title as the body text', () => {
  const node = createFormFlow({ title: 'Solo', sections: [{ rows: [] }] });
  assert.equal(node.message.interactiveMessage.body.text, 'Solo');
});

test('the whole node survives a JSON stringify/parse round-trip', () => {
  const node = createFormFlow({
    title: 'Round',
    sections: [{ rows: [radioRow('A', 'a')] }],
  });

  const once = JSON.stringify(node);
  const twice = JSON.stringify(JSON.parse(once));
  assert.equal(twice, once, 'the node is pure data with no lossy values');

  const reparsed = JSON.parse(once);
  const originalPayload = flowOf(node).messageParamsJson;
  assert.equal(
    reparsed.message.interactiveMessage.nativeFlowMessage.messageParamsJson,
    originalPayload,
  );
  assert.equal(
    reparsed.message.interactiveMessage.nativeFlowMessage.buttons[0].buttonParamsJson,
    flowOf(node).buttons[0].buttonParamsJson,
  );
  assert.equal(once.includes('undefined'), false);
});

/* ── carousel ────────────────────────────────────────────────────────── */

test('createCarouselFlow makes one section per card, each with its own optionName', () => {
  const node = createCarouselFlow({
    title: 'Browse',
    ctaLabel: 'Shop',
    cards: [
      { id: 'card_1', title: 'One', description: 'first', footer: 'f1' },
      { id: 'card_2', title: 'Two' },
      { id: 'card_3', title: 'Three', description: 'third', image: 'https://x/y.jpg' },
    ],
  });

  const decoded = wireRoundTrip(node);
  const p = params(decoded.messageParamsJson);

  assert.equal(p.title, 'Browse');
  assert.equal(p.sections.length, 3);

  const rows = p.sections.map((s) => s.rows[0]);
  assert.deepEqual(rows.map((r) => r.optionName), ['card_1', 'card_2', 'card_3']);
  assert.deepEqual(rows.map((r) => r.title), ['One', 'Two', 'Three']);
  assert.equal(rows[0].description, 'first\nf1', 'description and footer are joined by a newline');
  assert.equal('description' in rows[1], false, 'a card with neither omits the key entirely');
  assert.equal(rows[2].description, 'third');
});

test('carousel card ids become the selectable option names and stay unique', () => {
  const node = createCarouselFlow({
    title: 'T',
    cards: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }],
  });
  const p = params(flowOf(node).messageParamsJson);
  const names = p.sections.flatMap((s) => s.rows.map((r) => r.optionName));
  assert.deepEqual(names, ['a', 'b', 'c']);
  assert.equal(new Set(names).size, 3);
});

test('carouselCardWithMedia flags the media attachment and still emits a flow', () => {
  const withImage = carouselCardWithMedia({
    id: 'x',
    title: 'Card',
    description: 'desc',
    footer: 'foot',
    image: 'https://example.invalid/i.png',
  });
  const without = carouselCardWithMedia({ id: 'y', title: 'Bare' });

  assert.equal(withImage.message.interactiveMessage.header.hasMediaAttachment, true);
  assert.equal(without.message.interactiveMessage.header.hasMediaAttachment, false);
  assert.equal(without.message.interactiveMessage.header.title, 'Bare');
  assert.equal(withImage.message.interactiveMessage.body.text, 'desc');

  const p = params(wireRoundTrip(withImage).messageParamsJson);
  assert.equal(p.sections[0].rows[0].optionName, 'x');
  assert.equal(p.sections[0].rows[0].description, 'foot');

  const p2 = params(flowOf(without).messageParamsJson);
  assert.equal(p2.sections[0].rows[0].optionName, 'y');
});

/* ── table flow ──────────────────────────────────────────────────────── */

test('createTableFlow renders rows as "col0: first · rest" with a Close cta', () => {
  const node = createTableFlow({
    title: 'Ledger',
    columns: ['Region', 'Q1', 'Q2'],
    rows: [
      ['North', '10', '12'],
      ['South', '7'],
    ],
  });

  const p = params(flowOf(node).messageParamsJson);
  assert.equal(p.title, 'Ledger');
  assert.equal(p.ctaLabel, 'Close');
  assert.deepEqual(p.body, { text: 'Region  ·  Q1  ·  Q2' }, 'columns become the body by default');

  const rows = p.sections[0].rows;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, 'Region: North');
  assert.equal(rows[0].description, '10  ·  12');
  assert.equal(rows[1].title, 'Region: South');
  assert.equal(rows[1].description, '7');
});

test('a table flow is read-only: rows carry no optionName', () => {
  const node = createTableFlow({ title: 'T', columns: ['A', 'B'], rows: [['1', '2']] });
  const rows = params(flowOf(node).messageParamsJson).sections[0].rows;
  assert.equal('optionName' in rows[0], false, 'a data sheet is not selectable');
});

test('an explicit body and ctaLabel win over the table defaults', () => {
  const node = createTableFlow({
    title: 'Ledger',
    body: 'Custom body',
    ctaLabel: 'Export',
    columns: ['A'],
    rows: [['1']],
  });
  const p = params(flowOf(node).messageParamsJson);
  assert.deepEqual(p.body, { text: 'Custom body' });
  assert.equal(p.ctaLabel, 'Export');
  assert.equal(params(flowOf(node).buttons[0].buttonParamsJson).displayName, 'Export');
});

test('an empty table does not throw and still emits a parseable flow', () => {
  const node = createTableFlow({ title: 'Empty', columns: [], rows: [] });
  const p = params(flowOf(node).messageParamsJson);
  assert.deepEqual(p.sections[0].rows, []);
  assert.equal(flowOf(node).messageVersion, 1);
});

/* ── other node kinds ────────────────────────────────────────────────── */

test('createAlbumContainer splits the expected counts by media kind', () => {
  const mixed = createAlbumContainer(5, 2);
  assert.equal(mixed.message.albumMessage.expectedImageCount, 3);
  assert.equal(mixed.message.albumMessage.expectedVideoCount, 2);

  const allImages = createAlbumContainer(4);
  assert.equal(allImages.message.albumMessage.expectedImageCount, 4);
  assert.equal(allImages.message.albumMessage.expectedVideoCount, 0);

  const bytes = proto.Message.encode(mixed.message).finish();
  assert.ok(bytes.length >= 4, 'the container is not an empty node');
  const decoded = proto.Message.decode(bytes);
  assert.equal(decoded.albumMessage.expectedImageCount, 3);
  assert.equal(decoded.albumMessage.expectedVideoCount, 2);
});

/*
 * ---------------------------------------------------------------------------
 * KNOWN BUG — src/core/nodes.ts:263-265
 *
 * rc14's `editedMessage` is a *wrapper* type (`{ message: {...} }`), the same
 * shape as `viewOnceMessage`. It has no `text` field. `createEdit` writes
 * `{ editedMessage: { text } }`, so protobufjs drops the unknown `text` key and
 * the node encodes to an empty wrapper — a "silent edit" that carries no text
 * at all and shows up on WhatsApp as an empty edit.
 *
 * The assertion below encodes the node through real protobufjs and is the
 * behaviour the function's name and doc promise. It fails today; do not weaken
 * it to match the current output.
 * ---------------------------------------------------------------------------
 */
test('BUG: createEdit actually carries the text onto the wire', () => {
  const node = createEdit('new body');
  const bytes = proto.Message.encode(node.message).finish();
  const decoded = proto.Message.decode(bytes);

  assert.ok(
    decoded.editedMessage?.message,
    'editedMessage must wrap a real message; it currently encodes as an empty wrapper',
  );
  const inner = decoded.editedMessage.message;
  assert.equal(inner.conversation ?? inner.extendedTextMessage?.text, 'new body');
});