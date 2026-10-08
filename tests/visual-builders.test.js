import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createInfiniteCarousel,
  createInteractiveCardGrid,
  createProductCatalogNode,
  createPaymentRequestNode,
  createLiveLocationNode,
  createPollQuizNode,
  createEventCardNode,
} from '../dist/toolkit/visual-builders.js';

test('1. Feature 1: createInfiniteCarousel compiles interactive carousel message', () => {
  const node = createInfiniteCarousel([
    { title: 'Card 1', body: 'Body 1', ctaLabel: 'Open 1', ctaUrl: 'https://example.com/1' },
    { title: 'Card 2', body: 'Body 2', ctaLabel: 'Open 2', ctaCopy: 'CODE2' },
  ]);

  assert.ok(node.nativeFlowMessage);
  assert.equal(node.nativeFlowMessage.messageVersion, 1);
  assert.equal(node.nativeFlowMessage.buttons.length, 2);
  const params = JSON.parse(node.nativeFlowMessage.messageParamsJson);
  assert.equal(params.sections.length, 2);
});

test('2. Feature 2: createInteractiveCardGrid formats sections and rows', () => {
  const node = createInteractiveCardGrid([
    {
      title: 'Section A',
      rows: [{ id: 'a1', title: 'Row A1', description: 'Desc A1' }],
    },
  ]);

  assert.ok(node.nativeFlowMessage);
  const params = JSON.parse(node.nativeFlowMessage.messageParamsJson);
  assert.equal(params.sections[0].title, 'Section A');
  assert.equal(params.sections[0].rows[0].id, 'a1');
});

test('3. Feature 3: createProductCatalogNode creates ProductMessage', () => {
  const node = createProductCatalogNode({
    businessJid: '15551234567@s.whatsapp.net',
    title: 'Super Item',
    items: [{ id: 'item_1', name: 'Item 1', price: 99.99, currency: 'USD' }],
  });

  assert.ok(node.productMessage);
  assert.equal(node.productMessage.product.title, 'Super Item');
  assert.equal(node.productMessage.product.priceAmount1000, 99990);
});

test('4. Feature 4: createPaymentRequestNode creates RequestPaymentMessage', () => {
  const node = createPaymentRequestNode({
    currency: 'USD',
    amount1000: 50000,
    recipientJid: '15551234567@s.whatsapp.net',
    note: 'Order #100',
  });

  assert.ok(node.requestPaymentMessage);
  assert.equal(node.requestPaymentMessage.currencyCodeIso4217, 'USD');
  assert.equal(node.requestPaymentMessage.amount1000, 50000);
});

test('5. Feature 5: createLiveLocationNode creates LiveLocationMessage', () => {
  const node = createLiveLocationNode({
    degreesLatitude: -6.2088,
    degreesLongitude: 106.8456,
    name: 'HQ',
    address: 'Jakarta',
  });

  assert.ok(node.liveLocationMessage);
  assert.equal(node.liveLocationMessage.degreesLatitude, -6.2088);
  assert.equal(node.liveLocationMessage.caption, 'HQ\nJakarta');
});

test('6. Feature 6: createPollQuizNode creates PollCreationMessage with checkmark', () => {
  const node = createPollQuizNode({
    question: 'Capital of France?',
    options: ['Berlin', 'Paris', 'Madrid'],
    correctIndex: 1,
  });

  assert.ok(node.pollCreationMessage);
  assert.equal(node.pollCreationMessage.options[1].optionName, '✓ Paris');
  assert.equal(node.pollCreationMessage.options[0].optionName, 'Berlin');
});

test('7. Feature 7: createEventCardNode creates EventMessage', () => {
  const now = Date.now();
  const node = createEventCardNode({
    title: 'Launch Event',
    location: 'Auditorium A',
    startTime: now,
  });

  assert.ok(node.eventMessage);
  assert.equal(node.eventMessage.name, 'Launch Event');
  assert.equal(node.eventMessage.location.name, 'Auditorium A');
});
