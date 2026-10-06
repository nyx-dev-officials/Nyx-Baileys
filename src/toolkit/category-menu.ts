/**
 * A native category menu, built as `single_select`.
 *
 * ## The row key is `id`, not `rowId`
 *
 * This is the whole ballgame, and it is a genuine correction rather than a
 * restatement. An earlier round of testing concluded that sectioned lists were
 * **impossible on consumer accounts** — a server-side Business-tier gate — and
 * that claim was written into `docs/VERIFICATION.md`, the changelog, and the
 * release notes.
 *
 * It was wrong, and the error was ours rather than the platform's.
 *
 * `WAProto`'s `ListMessage.Row` really does call its identifier `rowId` — but
 * that field belongs to the **`listMessage`** message type, which rc14's send
 * path rejects outright. This menu does not go through `listMessage` at all: it
 * goes as a `nativeFlowMessage` button named `single_select`, whose
 * `buttonParamsJson` is an **opaque JSON string the client parses itself**. The
 * schema inside that string is the client's, not protobuf's, and it names the
 * field **`id`**.
 *
 * So the earlier failure was a wrong key in an opaque payload. It encoded
 * cleanly, returned a valid message ID, and was dropped — which is exactly the
 * signature we had already learned to distrust on sight. Concluding "the server
 * refuses this message type" from that evidence was overreach; the correct
 * conclusion was "we have not actually made this one render yet".
 *
 * Everything the original claim listed as ruled out stays ruled out, because they
 * were ruled out for other reasons and still hold: malformed button shapes, the
 * missing `messageSecret` reporting token, message-vs-wrapper shape, and plugin
 * ordering. None of those was ever the problem.
 *
 * ## What this file does *not* contain
 *
 * A second function in the original source spoofed a verified business identity
 * by quoting a fabricated `status@broadcast` message with `fromMe: false` and
 * `participant: '0@s.whatsapp.net'`. That impersonates a sender that never sent
 * anything, and it is not something this library will ship. Quoting a real
 * message you actually received is fine; inventing the provenance of one is not.
 */

import { generateWAMessageFromContent, proto } from '@whiskeysockets/baileys';
import { randomBytes } from 'node:crypto';

import type { CoreSocket } from '../utils/types.js';

/** One selectable row. `id` is what the client echoes back on selection. */
export interface MenuRow {
  id: string;
  title: string;
  description?: string;
}

export interface MenuCategory {
  title: string;
  rows: MenuRow[];
}

export interface CategoryMenuOptions {
  /** Text above the menu button. */
  body?: string;
  /** Text below the menu button. */
  footer?: string;
  /** Menu button label. */
  buttonTitle?: string;
  /** Optional banner above the body. */
  header?: { title: string; subtitle?: string };
}

export interface CategoryMenuResult {
  id: string;
  jid: string;
  /** The `id` values a selection can come back as, for matching on receipt. */
  selectableIds: string[];
}

/**
 * Dispatch a categorised menu.
 *
 * Wrapped in `viewOnceMessage` because that is the envelope rc14 will serialise
 * for an interactive message, and relayed directly because `sendMessage` cannot
 * reach this content type at all — `generateWAMessageContent` has no branch for
 * it and its final `else` throws `Boom: Invalid media type`.
 *
 * No `additionalNodes` are sent. The `biz` / `interactive` / `native_flow` /
 * `bot` nodes are what make a **quick reply** render on consumer clients; this
 * menu shape does not need them, and adding them attaches a `quick_reply`-shaped
 * flow name to a `single_select` button, which is not what we want to send.
 */
export async function sendCategoryMenu(
  sock: CoreSocket,
  jid: string,
  categories: MenuCategory[],
  options: CategoryMenuOptions = {},
): Promise<CategoryMenuResult> {
  if (!Array.isArray(categories) || categories.length === 0) {
    throw new Error('sendCategoryMenu needs at least one category');
  }
  const totalRows = categories.reduce((n, c) => n + (c.rows?.length ?? 0), 0);
  if (totalRows === 0) {
    throw new Error('sendCategoryMenu needs at least one row across all categories');
  }

  const interactiveMessage = proto.Message.InteractiveMessage.create({
    body: proto.Message.InteractiveMessage.Body.create({
      text: options.body ?? 'Choose an option from the menu below:',
    }),
    footer: proto.Message.InteractiveMessage.Footer.create({
      text: options.footer ?? 'Reply with the option you want.',
    }),
    ...(options.header
      ? {
          header: proto.Message.InteractiveMessage.Header.create({
            title: options.header.title,
            subtitle: options.header.subtitle ?? '',
            hasMediaAttachment: false,
          }),
        }
      : {}),
    nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
      buttons: [
        {
          name: 'single_select',
          // NOTE: `id`, not `rowId`. See the file header — this is the key that
          // made an earlier attempt look like an impossible platform limit.
          buttonParamsJson: JSON.stringify({
            title: options.buttonTitle ?? 'Menu',
            sections: categories.map((c) => ({
              title: c.title,
              rows: c.rows.map((r) => ({
                id: r.id,
                title: r.title,
                ...(r.description ? { description: r.description } : {}),
              })),
            })),
          }),
        },
      ],
      messageVersion: 1,
    }),
  });

  const full = generateWAMessageFromContent(
    jid,
    {
      viewOnceMessage: {
        message: {
          messageContextInfo: {
            deviceListMetadata: {},
            deviceListMetadataVersion: 2,
          },
          interactiveMessage,
        },
      },
    },
    { userJid: (sock as unknown as { user?: { id?: string } }).user?.id } as never,
  );

  // `generateWAMessageContent` attaches a reporting secret to every message it
  // builds. This path bypasses that function, so it is supplied here. Not the
  // reason anything renders — the payload shape is — but the server expects the
  // field to be present.
  (full.message as { messageContextInfo?: Record<string, unknown> }).messageContextInfo = {
    messageSecret: randomBytes(32),
  };

  await (sock as unknown as {
    relayMessage: (j: string, m: unknown, o: unknown) => Promise<void>;
  }).relayMessage(jid, full.message, { messageId: full.key.id });

  return {
    id: full.key.id ?? '',
    jid,
    selectableIds: categories.flatMap((c) => c.rows.map((r) => r.id)),
  };
}

/**
 * Read a menu selection back.
 *
 * The client answers with an `interactiveResponseMessage` whose
 * `nativeFlowResponseMessage.paramsJson` is the echo of the sender's own JSON —
 * so the selected `id` comes back verbatim.
 *
 * Returns `null` when the message was not a selection, and on malformed JSON,
 * because a decode failure here should drop one reply rather than take the
 * handler down.
 */
export function readMenuSelection(message: unknown): string | null {
  const response = (message as {
    interactiveResponseMessage?: {
      nativeFlowResponseMessage?: { paramsJson?: string | null } | null;
    };
  })?.interactiveResponseMessage;

  const raw = response?.nativeFlowResponseMessage?.paramsJson;
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as { id?: unknown };
    return typeof parsed.id === 'string' && parsed.id ? parsed.id : null;
  } catch {
    return null;
  }
}