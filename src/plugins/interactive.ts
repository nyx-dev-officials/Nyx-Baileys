import { generateWAMessageFromContent, proto } from '@whiskeysockets/baileys';
import { randomBytes } from 'node:crypto';

import { invariant, patch } from '../core/intercept.js';
import type { CoreSocket, Plugin } from '../utils/types.js';

/**
 * Interactive messages — the ones a phone renders as buttons, lists and menus.
 *
 * ## Why this plugin exists
 *
 * rc14 cannot send these. `generateWAMessageContent`
 * (`Utils/messages.js:273`) is an if/else chain over the content keys it knows —
 * `text`, `image`, `video`, `audio`, `document`, `sticker`, `poll`, `album`,
 * `listReply`, `event`, `contacts`, `location`, `react`, `pin`, `buttonReply` and
 * a few more — and its **final `else`** calls `prepareWAMessageMedia`, which
 * throws `Boom: Invalid media type` for anything it does not recognise.
 *
 * `listMessage`, `buttonsMessage`, `templateMessage` and `interactiveMessage` are
 * not in that chain, so `sendMessage` rejects all of them, even though the
 * builders in `core/nodes.ts` serialise them correctly. The shapes were right;
 * only the door was shut.
 *
 * ## Phantom delivery — the thing that actually bites
 *
 * Routing `generateWAMessageFromContent` + `relayMessage` is **not sufficient**.
 * That combination returns a clean message ID and throws nothing, and the message
 * never arrives on the other device. Verified on hardware against
 * `62882017467912`: three variants were sent in one window, each returned an ID,
 * and a phone screenshot showed none of them. Plain text through the same
 * `relayMessage` arrived every time, so the relay path itself was not at fault.
 *
 * Ruled out by live differential, not by reading code:
 *
 *  - **Malformed payloads.** `ListMessage.buttonText` is required and
 *    `IButton.buttonText` is a *nested message* (`{ displayText }`), not a
 *    string. Both were wrong in the first attempt. Adding them changed nothing —
 *    though the correct shapes are still required, and a protobuf round-trip
 *    confirms both now survive encoding intact.
 *  - **The reporting token.** `generateWAMessageContent` attaches
 *    `messageContextInfo.messageSecret` to every message; this path bypasses it.
 *    Adding a random 32-byte secret changed nothing. It is kept below because
 *    the server expects the field, not because it fixes delivery.
 *
 * ## What is actually required: the `biz` / `bot` stanza nodes
 *
 * WhatsApp renders interactive elements from nodes that ride alongside the
 * protobuf message, not from the protobuf itself. `relayMessage` accepts them as
 * `additionalNodes` (`Socket/messages-send.js:1133`), and without them the
 * message is silently discarded:
 *
 * ```
 * biz
 * └─ interactive  type=native_flow v=1
 *    └─ native_flow  name=<flow name>
 * ```
 *
 * 1:1 chats additionally need `bot biz_bot=1`, or consumer clients will not
 * render the flow. Both were confirmed working on a physical phone: a
 * `quick_reply` flow rendered with tappable buttons and its reply came back.
 *
 * The `native_flow` `name` must match the button actually sent — `quick_reply`,
 * `single_select`, `cta_url` and so on. A mismatch renders nothing.
 *
 * ## Why order 66
 *
 * Low numbers apply first (`nyxBaileys.ts:83`), and each patch wraps the one
 * already in place. At 66 this sits above `session-repair` (65) and below every
 * pacing layer — `flow` (90), `antiSpam` (80), `delivery` (85). That matters
 * because those wrap `sendMessage`: sitting above them means an interactive send
 * is intercepted *first* and cannot be delayed, re-ordered or swallowed by a
 * queue that does not understand it.
 *
 * `delivery` (85) still observes these sends, since it wraps the *result* of
 * whatever runs below it. `metrics` (110) attaches no `sendMessage` wrapper at
 * all — it only defines `sock.metrics` — so nothing is lost by the ordering.
 *
 * ## Verified, and what that means
 *
 * Proven on hardware, on a paired consumer account: **quick-reply buttons
 * render and their replies route back.** Also proven: a sectioned `single_select`
 * menu does **not** render, despite arriving through the identical path with the
 * identical nodes. Only `name: 'quick_reply'` is confirmed. Treat `single_select`
 * as unverified rather than working — see `docs/VERIFICATION.md`.
 *
 * Everything else the chain understands passes straight through, untouched.
 */

/** Content keys the upstream chain rejects but WhatsApp clients can render. */
const INTERACTIVE_KEYS = [
  'listMessage',
  'buttonsMessage',
  'templateMessage',
  'interactiveMessage',
  'carouselMessage',
  'collectionMessage',
  'productMessage',
  'contactMessage',
  'contactActionMessage',
  'interactiveResponseMessage',
] as const;

/** Flow names WhatsApp accepts on a `native_flow` node. */
export type NativeFlowName = 'quick_reply' | 'single_select' | 'cta_url' | 'cta_call' | 'copy_to_clipboard' | 'payment' | 'location_request';

export interface InteractiveRow {
  title: string;
  rowId: string;
  description?: string;
}

export interface InteractiveSection {
  title: string;
  rows: InteractiveRow[];
}

export interface InteractiveOptions {
  /**
   * Group metadata cache. Defaults to `false`, which makes Baileys fetch the
   * participant list instead of trusting a cache that may not be warm.
   */
  useCachedGroupMetadata?: boolean;
  /**
   * Force the flow name. Inferred from the content when omitted.
   * `single_select` is **unverified** on consumer clients — see the file header.
   */
  flowName?: NativeFlowName;
  /**
   * What to do with a `listMessage`.
   *
   * `'text'` (default) renders the sections as a numbered plaintext menu and
   * sends that instead. `'off'` sends the native flow anyway, which a consumer
   * account will silently drop. `'throw'` refuses the send outright.
   *
   * Text is the default because the alternative is a message that reports
   * success and never arrives. The conversion is logged, never silent.
   */
  listFallback?: 'text' | 'off' | 'throw';
}

export interface InteractiveStats {
  /** Interactive sends this plugin handled. */
  readonly sent: number;
  /** Passes through to the original `sendMessage`. */
  readonly passedThrough: number;
  /** Handled sends that failed. */
  readonly failed: number;
  /** listMessage sends rendered as a numbered plaintext menu. */
  readonly fallback: number;
}

/** The first interactive key in `content`, or `null`. */
export function interactiveKeyOf(content: unknown): string | null {
  if (!content || typeof content !== 'object') return null;
  const keys = content as Record<string, unknown>;
  for (const key of INTERACTIVE_KEYS) {
    if (keys[key] !== undefined && keys[key] !== null) return key;
  }
  return null;
}

/**
 * The flow name implied by a content key.
 *
 * A sectioned menu is `single_select`; everything else defaults to
 * `quick_reply`, the only value confirmed to render on consumer clients.
 */
export function interactiveFlowName(key: string, options: InteractiveOptions = {}): NativeFlowName {
  if (options.flowName) return options.flowName;
  return key === 'listMessage' ? 'single_select' : 'quick_reply';
}

/**
 * The stanza nodes WhatsApp needs before it will render an interactive element.
 *
 * Missing these is the whole failure mode: the message returns an ID and never
 * arrives. `biz_bot` is required only for 1:1 chats, which is why this takes the
 * target jid rather than being a constant.
 */
export function interactiveNodes(jid: string, flowName: NativeFlowName): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [
    {
      tag: 'biz',
      attrs: {},
      content: [
        {
          tag: 'interactive',
          attrs: { type: 'native_flow', v: '1' },
          content: [{ tag: 'native_flow', attrs: { name: flowName } }],
        },
      ],
    },
  ];
  if (!jid.endsWith('@g.us')) {
    nodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });
  }
  return nodes;
}

/** One button, in the neutral shape the converter reads. */
interface FlatButton {
  buttonId: string;
  displayText: string;
}

/**
 * Wrap a caller-supplied payload in the envelope rc14 will actually serialise.
 *
 * Two things are required and neither is optional in practice:
 *
 *  - The `viewOnceMessage` wrapper. `generateWAMessageFromContent` passes the
 *    *original* object to `WAProto.Message.create` (`Utils/messages.js:603`), so
 *    the wrapper survives, and without it the stanza does not render.
 *  - `messageContextInfo.deviceListMetadata` with `deviceListMetadataVersion: 2`.
 *
 * The inner message is built with `proto.Message.InteractiveMessage.fromObject`
 * so nested shapes — notably a button's `{ displayText }` — are materialised as
 * real protobuf messages rather than left as plain objects for the encoder to
 * mis-handle.
 */
export function wrapInteractive(
  key: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    viewOnceMessage: {
      message: {
        messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
        interactiveMessage: proto.Message.InteractiveMessage.fromObject(
          toInteractiveInner(key, payload),
        ),
      },
    },
  };
}

/**
 * Normalise a content payload into an `InteractiveMessage` inner object.
 *
 * This is the part that is easy to get wrong. `listMessage` and `buttonsMessage`
 * are **not** `InteractiveMessage` shapes — `buttonsMessage` has `contentText`
 * and `buttons[].buttonText` as a nested `{ displayText }`, and `listMessage` has
 * `sections[].rows[]`. Passing either straight into
 * `InteractiveMessage.fromObject` does not throw; it silently discards every
 * field, producing an interactive message with no body and no buttons.
 *
 * So each legacy shape is converted into the one shape that does render: a
 * `nativeFlowMessage` whose buttons carry a JSON `buttonParamsJson` string.
 *
 *  - `buttonsMessage` → `quick_reply`, one button per entry.
 *  - `listMessage`    → `single_select`, sections and rows verbatim.
 *  - `interactiveMessage` → already native; passed through untouched.
 */
export function toInteractiveInner(
  key: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  // Already a native interactive message — nothing to convert.
  if (key === 'interactiveMessage') {
    return payload;
  }

  if (key === 'buttonsMessage') {
    const buttons = (payload.buttons ?? []) as Array<{
      buttonId?: string;
      buttonText?: string | { displayText?: string };
    }>;
    const flat: FlatButton[] = buttons.map((b, i) => ({
      // `buttonText` is a nested message in the proto, but callers reasonably
      // pass a bare string. Accept both rather than dropping the button.
      buttonId: b.buttonId ?? `b${i}`,
      displayText:
        typeof b.buttonText === 'string'
          ? b.buttonText
          : (b.buttonText?.displayText ?? `Button ${i + 1}`),
    }));

    return {
      body: { text: (payload.contentText as string) ?? (payload.headerText as string) ?? '' },
      ...(payload.footerText ? { footer: { text: payload.footerText as string } } : {}),
      ...(payload.headerText ? { header: { title: payload.headerText as string, subtitle: '' } } : {}),
      nativeFlowMessage: {
        buttons: flat.map((b) => ({
          name: 'quick_reply',
          buttonParamsJson: JSON.stringify({ display_text: b.displayText, id: b.buttonId }),
        })),
      },
    };
  }

  if (key === 'listMessage') {
    return {
      body: { text: (payload.description as string) ?? (payload.title as string) ?? '' },
      ...(payload.footerText ? { footer: { text: payload.footerText as string } } : {}),
      nativeFlowMessage: {
        buttons: [
          {
            name: 'single_select',
            buttonParamsJson: JSON.stringify({
              title: payload.buttonText ?? payload.title ?? 'Menu',
              sections: payload.sections ?? [],
            }),
          },
        ],
      },
    };
  }

  // Any other rejected key: build the message as given and let protobuf drop
  // what it does not recognise, rather than inventing a flow for it.
  return payload;
}

/**
 * Render a sectioned menu as a numbered plaintext message.
 *
 * `single_select` is dropped by the server on consumer accounts, so the useful
 * question is not "how do I make the list render" but "what is the best thing to
 * send instead". A numbered list preserves both the grouping and the reply
 * affordance, and it survives being read by any client.
 *
 * WhatsApp's own dialect: `*bold*` for headings, and the box drawing is plain
 * text so it needs no monospace to stay aligned. Rows are numbered across the
 * whole menu, not per section, so "reply 3" is unambiguous.
 */
export function formatListAsText(payload: Record<string, unknown>): string {
  const title = String(payload.title ?? 'Menu');
  const description = String(payload.description ?? '');
  const footer = typeof payload.footerText === 'string' ? payload.footerText : '';
  const sections = Array.isArray(payload.sections) ? (payload.sections as Array<Record<string, unknown>>) : [];

  const lines: string[] = [`*┌── [ ${title.toUpperCase()} ]*`];
  if (description) lines.push(`│ ${description}`);

  let n = 0;
  for (const section of sections) {
    if (section.title) lines.push(`├─ *${String(section.title).toUpperCase()}*`);
    const rows = Array.isArray(section.rows) ? (section.rows as Array<Record<string, unknown>>) : [];
    for (const row of rows) {
      n += 1;
      lines.push(`│  [${n}] *${String(row.title ?? '')}*`);
      if (row.description) lines.push(`│      └─ ${String(row.description)}`);
    }
    lines.push('│');
  }

  if (n === 0) lines.push('│  (no options)');
  if (footer) lines.push(`│ ${footer}`);
  lines.push('*└── Reply with a number to select*');
  return lines.join('\n');
}

export function interactive(options: InteractiveOptions = {}): Plugin {
  const useCachedGroupMetadata = options.useCachedGroupMetadata === true;
  const counters = { sent: 0, passedThrough: 0, failed: 0, fallback: 0 };

  return {
    name: 'interactive',
    order: 66,

    apply(ctx) {
      const log = ctx.log.child('interactive');
      const sock = ctx.sock as CoreSocket & Record<string, unknown>;

      const handle = patch(
        sock as never,
        'sendMessage',
        ((original: (...a: unknown[]) => unknown, self: unknown, args: unknown[]) => {
          const [jid, content, sendOptions] = args as [
            string,
            Record<string, unknown> | undefined,
            { quoted?: unknown; messageId?: string } | undefined,
          ];

          const key = interactiveKeyOf(content);
          if (!key) {
            counters.passedThrough += 1;
            return original.apply(self, args);
          }

          invariant(typeof jid === 'string', 'sendMessage needs a jid');
          invariant(content && typeof content === 'object', 'sendMessage needs content');

          const { [key]: payload, ...rest } = content as Record<string, unknown>;
          const flowName = interactiveFlowName(key, options);

          // A sectioned menu cannot leave a consumer account, so do not send one.
          // The alternative is a send that resolves and never arrives.
          if (key === 'listMessage' && options.listFallback !== 'off') {
            const mode = options.listFallback;
            const menu = payload as Record<string, unknown>;
            // Async even though nothing awaits: the rest of this wrapper always
            // returns a promise, and a synchronous throw here would bypass a
            // caller's `.catch()` and look like a different failure entirely.
            return (async () => {
              if (mode === 'throw') {
                throw new Error(
                  'listMessage is dropped by the server on consumer accounts; ' +
                    'use listFallback: "text" to send a numbered menu instead',
                );
              }
              const text = formatListAsText(menu);
              counters.fallback += 1;
              log.info('listMessage sent as a numbered plaintext menu', { jid, flow: flowName });
              return Reflect.apply(original, self, [jid, { ...rest, text }, sendOptions]);
            })();
          }

          return (async () => {
            try {
              const user = sock.user as { id?: string } | undefined;
              invariant(user?.id, 'cannot send an interactive message before the socket is open');

              const full = generateWAMessageFromContent(
                jid,
                wrapInteractive(key, payload as Record<string, unknown>),
                {
                  userJid: user.id,
                  quoted: sendOptions?.quoted as never,
                  messageId: sendOptions?.messageId,
                } as never,
              );

              const inner = full.message;
              // Not a cast: an empty message is a real failure, and relaying it
              // would produce exactly the silent phantom this plugin exists to
              // avoid.
              invariant(inner, `the ${key} content serialised to an empty message`);

              // `generateWAMessageContent` attaches this to every message it
              // builds; bypassing that function means supplying it here. Not the
              // fix for delivery — the stanza nodes are — but the server expects
              // the field to be present.
              if (!inner.messageContextInfo) inner.messageContextInfo = {};
              if (!inner.messageContextInfo.messageSecret) {
                inner.messageContextInfo.messageSecret = randomBytes(32);
              }

              await sock.relayMessage(jid, inner, {
                messageId: full.key.id,
                useCachedGroupMetadata,
                additionalNodes: interactiveNodes(jid, flowName),
              } as never);

              // What `sendMessage` does after relaying, so the outgoing message
              // lands in local history the way it would for any other send.
              queueMicrotask(() => {
                try {
                  sock.ev.emit('messages.update' as never, [
                    { key: full.key, update: { message: full.message as never } },
                  ] as never);
                } catch (err) {
                  log.debug('local history update failed', { err: (err as Error).message });
                }
              });

              counters.sent += 1;
              log.debug('sent interactive message', { kind: key, flow: flowName, jid, id: full.key.id });
              void rest;
              return full;
            } catch (err) {
              counters.failed += 1;
              throw err;
            }
          })();
        }) as never,
      );

      Object.defineProperty(sock, '__interactive', {
        value: { stats: (): InteractiveStats => ({ ...counters }) },
        enumerable: false,
        configurable: true,
      });

      ctx.onDispose(() => handle.undo());
    },
  };
}

export default interactive;