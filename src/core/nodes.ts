import { proto } from '@whiskeysockets/baileys';

/**
 * Protobuf node builders.
 *
 * Everything here produces `proto.IWebMessageInfo` using upstream's generated
 * schemas — no hand-rolled wire format, so nothing drifts when WhatsApp adds
 * fields.
 *
 * ## Native flow on rc14
 *
 * Upstream's `INativeFlowMessage` is only three fields:
 *
 *   messageVersion: 1
 *   messageParamsJson: string   ← the UI lives here, as JSON
 *   buttons: [{ name, buttonParamsJson }]
 *
 * The rich section/row schema is *not* in the protobuf — it is the JSON payload
 * the client renders. That is the fork's actual innovation, and it belongs in
 * our layer rather than in `node_modules`. So we build the params object,
 * serialise it, and hand it to upstream for compilation. One schema, one place.
 */

export type WebMessageInfo = proto.IWebMessageInfo;

export interface FlowRow {
  header?: string;
  title: string;
  description?: string;
  /** Selectable row. Without this the client cannot bind a selection. */
  optionName?: string;
}

export interface FlowSection {
  title?: string;
  description?: string;
  highlightLabel?: string;
  rows: FlowRow[];
}

export interface FlowParams {
  title: string;
  body?: Record<string, unknown>;
  footer?: { text: string };
  ctaLabel: string;
  mediaType: string;
  sections: FlowSection[];
}

/** Shorthand for a selectable radio row. */
export function radioRow(title: string, optionName: string, description?: string): FlowRow {
  return { title, optionName, description };
}

/** Shorthand for a labelled, non-selectable row. */
export function infoRow(title: string, description?: string, header?: string): FlowRow {
  return { title, description, header };
}

/** Build the JSON params object the client renders. */
export function buildFlowMessageParams(input: {
  title: string;
  body?: string;
  footer?: string;
  ctaLabel?: string;
  sections: FlowSection[];
  mediaType?: string;
}): FlowParams {
  return {
    title: input.title,
    ...(input.body ? { body: { text: input.body } } : {}),
    ...(input.footer ? { footer: { text: input.footer } } : {}),
    ctaLabel: input.ctaLabel ?? 'Continue',
    mediaType: input.mediaType ?? 'image/jpeg',
    sections: input.sections.map((section) => ({
      ...(section.title ? { title: section.title } : {}),
      ...(section.description ? { description: section.description } : {}),
      ...(section.highlightLabel ? { highlightLabel: section.highlightLabel } : {}),
      rows: section.rows.map((row) => ({
        ...(row.header ? { header: row.header } : {}),
        title: row.title,
        ...(row.description ? { description: row.description } : {}),
        ...(row.optionName ? { optionName: row.optionName } : {}),
      })),
    })),
  };
}

/** Wrap flow params into the wire node upstream expects. */
export function toFlowMessage(params: FlowParams): proto.Message.InteractiveMessage.INativeFlowMessage {
  return proto.Message.InteractiveMessage.NativeFlowMessage.create({
    messageVersion: 1,
    messageParamsJson: JSON.stringify(params),
    buttons: [
      {
        name: 'native_flow_cta',
        buttonParamsJson: JSON.stringify({ displayName: params.ctaLabel }),
      },
    ],
  });
}

/** Alias kept for parity with the JavaScript surface. */
export const toNatives = toFlowMessage;

function interactiveNode(options: {
  title: string;
  body?: string;
  footer?: string;
  ctaLabel?: string;
  sections: FlowSection[];
}): WebMessageInfo {
  const params = buildFlowMessageParams(options);
  const body = options.body ?? options.title;

  return {
    message: {
      interactiveMessage: proto.Message.InteractiveMessage.create({
        body: proto.Message.InteractiveMessage.Body.create({ text: body }),
        footer: proto.Message.InteractiveMessage.Footer.create({
          text: options.footer ?? options.ctaLabel ?? 'Continue',
        }),
        header: proto.Message.InteractiveMessage.Header.create({
          title: options.title,
          subtitle: options.body ?? undefined,
          hasMediaAttachment: false,
        }),
        nativeFlowMessage: toFlowMessage(params),
      }),
    },
  };
}

export interface FormFlowOptions {
  title: string;
  body?: string;
  ctaLabel?: string;
  sections: FlowSection[];
  footer?: string;
}

export interface CarouselCard {
  id: string;
  title: string;
  description?: string;
  footer?: string;
  image?: string;
}

/** A native-flow data-entry form. */
export function createFormFlow(options: FormFlowOptions): WebMessageInfo {
  return interactiveNode({
    title: options.title,
    body: options.body,
    footer: options.footer,
    ctaLabel: options.ctaLabel,
    sections: options.sections,
  });
}

/** A horizontally scrolling carousel — one section per card. */
export function createCarouselFlow(options: {
  title: string;
  body?: string;
  ctaLabel?: string;
  cards: CarouselCard[];
}): WebMessageInfo {
  return interactiveNode({
    title: options.title,
    body: options.body,
    ctaLabel: options.ctaLabel,
    sections: options.cards.map((card) => ({
      rows: [
        {
          title: card.title,
          description: [card.description, card.footer].filter(Boolean).join('\n'),
          optionName: card.id,
        },
      ],
    })),
  });
}

/** A read-only data sheet. */
export function createTableFlow(options: {
  title: string;
  body?: string;
  ctaLabel?: string;
  columns: string[];
  rows: string[][];
}): WebMessageInfo {
  return interactiveNode({
    title: options.title,
    body: options.body ?? options.columns.join('  ·  '),
    ctaLabel: options.ctaLabel ?? 'Close',
    sections: [
      {
        rows: options.rows.map((row) => {
          const [first = '', ...rest] = row;
          return infoRow(
            options.columns[0] ? `${options.columns[0]}: ${first}` : first,
            rest.join('  ·  '),
          );
        }),
      },
    ],
  });
}

/**
 * A carousel card that carries an image. Media is attached by the caller through
 * `sendMessage`'s media handling; this is the UI half.
 */
export function carouselCardWithMedia(card: CarouselCard): WebMessageInfo {
  const params = buildFlowMessageParams({
    title: card.title,
    body: card.description,
    sections: [
      {
        rows: [
          {
            title: card.title,
            description: card.footer,
            optionName: card.id,
          },
        ],
      },
    ],
  });

  return {
    message: {
      interactiveMessage: proto.Message.InteractiveMessage.create({
        body: proto.Message.InteractiveMessage.Body.create({ text: card.description ?? card.title }),
        header: proto.Message.InteractiveMessage.Header.create({
          title: card.title,
          hasMediaAttachment: Boolean(card.image),
        }),
        nativeFlowMessage: toFlowMessage(params),
      }),
    },
  };
}

/**
 * Album *container*. Upstream sends the parent node separately and links each
 * media message back with `albumParentKey` — the container itself carries no
 * media array, so there is nothing to decrypt here. See `plugins/album.ts` for
 * the receiving side.
 */
export function createAlbumContainer(count: number, videos = 0): WebMessageInfo {
  return {
    message: {
      albumMessage: proto.Message.AlbumMessage.create({
        expectedImageCount: count - videos,
        expectedVideoCount: videos,
      }),
    },
  };
}

/**
 * Silent edit of an existing message.
 *
 * `editedMessage` is a `FutureProofMessage` wrapper — `{ message: { … } }` — not
 * a message with a `text` field. Passing `{ text }` makes protobufjs drop the
 * unknown key and the edit encodes to a 3-byte empty wrapper, which arrives at
 * the other end as an empty edit. The wrapper shape is what makes edits survive
 * future message-type additions.
 */
export function createEdit(text: string): WebMessageInfo {
  return {
    message: {
      editedMessage: proto.Message.FutureProofMessage.create({
        message: proto.Message.create({ conversation: text }),
      }),
    },
  };
}

/**
 * Re-exported so consumers can reach every generated schema without importing
 * Baileys directly.
 */
export { proto };
