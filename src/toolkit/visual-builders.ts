/**
 * Visual Builders — Rich interactive node compilers for WhatsApp.
 */

import { proto } from '@whiskeysockets/baileys';

export interface CarouselCard {
  title: string;
  body: string;
  footer?: string;
  ctaLabel: string;
  ctaUrl?: string;
  ctaCopy?: string;
}

export interface GridSection {
  title: string;
  rows: Array<{ id: string; title: string; description?: string }>;
}

export interface CatalogOptions {
  businessJid: string;
  title: string;
  description?: string;
  items: Array<{ id: string; name: string; price: number; currency: string }>;
}

export interface PaymentOptions {
  currency: string;
  amount1000: number;
  recipientJid: string;
  note?: string;
}

export interface LocationOptions {
  degreesLatitude: number;
  degreesLongitude: number;
  name?: string;
  address?: string;
}

export interface QuizOptions {
  question: string;
  options: string[];
  correctIndex: number;
}

export interface EventOptions {
  title: string;
  description?: string;
  location?: string;
  startTime: number;
  endTime?: number;
}

// 1. Feature 1: Infinite Carousel Builder
export function createInfiniteCarousel(cards: CarouselCard[]) {
  const sections = cards.map((card, idx) => ({
    title: card.title,
    highlightLabel: `CARD ${idx + 1}/${cards.length}`,
    rows: [
      {
        header: card.title,
        title: card.body,
        description: card.footer ?? `Item ${idx + 1}`,
        id: card.ctaCopy ? `copy_${card.ctaCopy}` : `card_${idx}`,
      },
    ],
  }));

  const messageParamsJson = JSON.stringify({
    title: 'Featured Carousel',
    sections,
  });

  return proto.Message.InteractiveMessage.create({
    body: proto.Message.InteractiveMessage.Body.create({ text: 'Swipe cards below:' }),
    nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
      messageVersion: 1,
      messageParamsJson,
      buttons: cards.map((c, i) => ({
        name: 'cta_url',
        buttonParamsJson: JSON.stringify({
          displayName: c.ctaLabel,
          url: c.ctaUrl ?? 'https://whatsapp.com',
        }),
      })),
    }),
  });
}

// 2. Feature 2: Interactive Card Grid Builder
export function createInteractiveCardGrid(sections: GridSection[]) {
  const messageParamsJson = JSON.stringify({
    title: 'Select an Option',
    sections: sections.map((s) => ({
      title: s.title,
      rows: s.rows.map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description ?? '',
      })),
    })),
  });

  return proto.Message.InteractiveMessage.create({
    body: proto.Message.InteractiveMessage.Body.create({ text: 'Grid Options:' }),
    nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
      messageVersion: 1,
      messageParamsJson,
      buttons: [
        {
          name: 'single_select',
          buttonParamsJson: JSON.stringify({ title: 'Open Grid' }),
        },
      ],
    }),
  });
}

// 3. Feature 3: Product Catalog Compiler
export function createProductCatalogNode(catalog: CatalogOptions) {
  return proto.Message.create({
    productMessage: proto.Message.ProductMessage.create({
      product: {
        productId: catalog.items[0]?.id ?? 'prod_1',
        title: catalog.title,
        description: catalog.description ?? catalog.title,
        currencyCode: catalog.items[0]?.currency ?? 'USD',
        priceAmount1000: (catalog.items[0]?.price ?? 10) * 1000,
        retailerId: catalog.businessJid,
      },
      businessOwnerJid: catalog.businessJid,
    }),
  });
}

// 4. Feature 4: Payment Request Node Generator
export function createPaymentRequestNode(payment: PaymentOptions) {
  return proto.Message.create({
    requestPaymentMessage: proto.Message.RequestPaymentMessage.create({
      currencyCodeIso4217: payment.currency,
      amount1000: payment.amount1000,
      requestFrom: payment.recipientJid,
      noteMessage: proto.Message.create({
        extendedTextMessage: proto.Message.ExtendedTextMessage.create({ text: payment.note ?? 'Payment Request' }),
      }),
    }),
  });
}

// 5. Feature 5: Live Location Node Compiler
export function createLiveLocationNode(loc: LocationOptions) {
  return proto.Message.create({
    liveLocationMessage: proto.Message.LiveLocationMessage.create({
      degreesLatitude: loc.degreesLatitude,
      degreesLongitude: loc.degreesLongitude,
      caption: loc.name ? `${loc.name}\n${loc.address ?? ''}` : 'Live Location',
      degreesClockwiseFromMagneticNorth: 0,
    }),
  });
}

// 6. Feature 6: Poll Quiz Node Generator
export function createPollQuizNode(quiz: QuizOptions) {
  return proto.Message.create({
    pollCreationMessage: proto.Message.PollCreationMessage.create({
      name: `[QUIZ] ${quiz.question}`,
      options: quiz.options.map((opt, idx) => ({
        optionName: idx === quiz.correctIndex ? `✓ ${opt}` : opt,
      })),
      selectableOptionsCount: 1,
    }),
  });
}

// 7. Feature 7: Event Card Node Compiler
export function createEventCardNode(event: EventOptions) {
  return proto.Message.create({
    eventMessage: proto.Message.EventMessage.create({
      name: event.title,
      description: event.description ?? '',
      startTime: event.startTime,
      endTime: event.endTime ?? event.startTime + 3600,
      location: proto.Message.LocationMessage.create({
        name: event.location ?? 'Online Event',
      }),
    }),
  });
}
