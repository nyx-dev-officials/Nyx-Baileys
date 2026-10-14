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
 * ## What is actually required: the `biz` node, with a fixed flow name
 *
 * WhatsApp renders interactive elements from nodes that ride alongside the
 * protobuf message, not from the protobuf itself. `relayMessage` accepts them as
 * `additionalNodes` (`Socket/messages-send.js:491`), and without them the
 * message is silently discarded:
 *
 * ```
 * biz
 * └─ interactive  type=native_flow v=1
 *    └─ native_flow  v=9 name=mixed
 * ```
 *
 * 1:1 chats also get `bot biz_bot=1` here. That node is additive rather than
 * load-bearing: the fork attaches it only to content carrying an `ai` key, so it
 * marks an AI/bot chat rather than enabling rendering.
 *
 * The `native_flow` `name` does **not** match the button actually sent — `quick_reply`,
 * `single_select`, `cta_url` and so on. It is the fixed literal `mixed`, with
 * `v` = `9`, for every interactive send.
 *
 * This file previously asserted the opposite, with tests: that the name had to
 * be the flow, and that a mismatch renders nothing. That is why every
 * interactive message sent from this library arrived without its button on a
 * real phone on 2026-10-09, and why the tests were green throughout. The shape
 * above is not inferred — it is read out of `atexovi-baileys@7.5.6-rc.6`, the
 * fork pinned by `refs/atex-ovi__wabase-button`, whose `relayMessage` hardcodes
 * `{ v: '9', name: 'mixed' }` for every `interactiveMessage`, `buttonsMessage`
 * and `listMessage` it sends, whatever button those carry. That fork injects no
 * `additionalNodes` from user code at all: the node is built inside
 * `relayMessage`, which is why the reference bot never mentions it.
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
 * render and their replies route back**, as do `cta_url`, `cta_call` and
 * `cta_copy`. An earlier revision of this file asserted that `single_select`
 * was dropped by the server on consumer accounts. **That claim was wrong** — it
 * was inferred from a malformed payload rather than observed, and it has been
 * retracted in `docs/VERIFICATION.md`. The real defect was row shape; see
 * `toInteractiveInner`, which normalises rows to `{ header, title, description, id }`.
 *
 * Note the flow-name spelling: it is `cta_copy`. `copy_to_clipboard` is not a
 * WhatsApp flow name and is silently dropped.
 */

/** Content keys the upstream chain rejects but WhatsApp clients can render. */
const INTERACTIVE_KEYS = [
  /**
   * The reference API's content key (`refs/atex-ovi__wabase-button`):
   *
   * ```js
   * await sock.sendMessage(jid, {
   *   text: 'Hello!',
   *   subtitle: 'All Button Showcase',
   *   footer: '© … — MIT License',
   *   interactiveButtons: [
   *     { name: 'single_select', buttonParamsJson: JSON.stringify({ … }) },
   *   ],
   * });
   * ```
   *
   * It is `sendMessage`-shaped rather than `generateWAMessageFromContent`-shaped,
   * which is why it belongs in this list: the caller keeps the ordinary send
   * ergonomics and the plugin does the translation. Note the `name` on each
   * button is the flow name, and the `native_flow` stanza node must carry that
   * same name or the client renders nothing — see `interactiveFlowName`, which
   * now reads it off the payload instead of assuming `quick_reply`.
   */
  'interactiveButtons',
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

/**
 * Flow names WhatsApp accepts on a `native_flow` node.
 *
 * A runtime array, not just a type. A hand-written union erases at compile time,
 * so anything that needs to *check* a flow name at runtime has to restate the
 * list and hope it stays in sync — which is exactly how the feature menu ended up
 * duplicating it. Deriving the type from the array means there is one list, and a
 * new flow is available to every consumer the moment it is added here.
 */
export const NATIVE_FLOW_NAMES = [
  'quick_reply',
  'single_select',
  'cta_url',
  'cta_call',
  'cta_copy',
  'payment',
  'location_request',
] as const;

export type NativeFlowName = (typeof NATIVE_FLOW_NAMES)[number];

/**
 * The `native_flow` node's two attributes.
 *
 * Both are fixed values taken from the reference implementation's
 * `relayMessage`, and neither is derived from the button being sent — see the
 * file header. They live here as named constants so no future change can
 * "helpfully" substitute a flow name again.
 */
export const NATIVE_FLOW_STANZA_NAME = 'mixed';
export const NATIVE_FLOW_STANZA_VERSION = '9';

/** True when `name` is a flow WhatsApp renders. */
export function isNativeFlowName(name: string): name is NativeFlowName {
  return (NATIVE_FLOW_NAMES as readonly string[]).includes(name);
}

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
   * Set this to `cta_url`, `cta_call` or `cta_copy` to send a CTA flow.
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
 * Which flow a payload carries — for logs, not for the wire.
 *
 * This used to decide the `native_flow` stanza's `name`, which turned out to be a
 * fixed literal (`mixed`); the stanza does **not** carry the flow. What remains
 * is the useful half: naming the flow in a log line, so "which flow did we just
 * send" is answerable after the fact.
 *
 * A sectioned menu is `single_select`; everything else defaults to
 * `quick_reply`. CTA flows requested through the legacy keys say so via
 * `flowName`.
 */
export function interactiveFlowName(
  key: string,
  options: InteractiveOptions = {},
  payload?: Record<string, unknown>,
): NativeFlowName {
  if (options.flowName) return options.flowName;
  if (key === 'listMessage') return 'single_select';
  if (key === 'interactiveButtons') {
    const buttons = payload?.['interactiveButtons'];
    const first = Array.isArray(buttons)
      ? (buttons[0] as { name?: unknown } | undefined)?.name
      : undefined;
    if (typeof first === 'string' && isNativeFlowName(first)) return first;
    return 'quick_reply';
  }
  return 'quick_reply';
}

/**
 * The stanza nodes WhatsApp needs before it will render an interactive element.
 *
 * Missing these is the whole failure mode: the message returns an ID and never
 * arrives. The node shape is fixed — see the file header for why the flow name
 * does not appear in it — so this takes only the target jid, which decides
 * whether the 1:1-only `bot` node rides along.
 */
export function interactiveNodes(jid: string): Record<string, unknown>[] {
  return [
    {
      tag: 'biz',
      attrs: {},
      content: [
        {
          tag: 'interactive',
          attrs: { type: 'native_flow', v: '1' },
          content: [
            {
              tag: 'native_flow',
              attrs: { v: NATIVE_FLOW_STANZA_VERSION, name: NATIVE_FLOW_STANZA_NAME },
            },
          ],
        },
      ],
    },
    ...(jid.endsWith('@g.us') ? [] : [{ tag: 'bot', attrs: { biz_bot: '1' } }]),
  ];
}

/** One button, in the neutral shape the converter reads. */
interface FlatButton {
  buttonId: string;
  displayText: string;
}

/**
 * Wrap a caller-supplied payload in the envelope rc14 will actually serialise.
 *
 * `messageContextInfo.deviceListMetadata` with `deviceListMetadataVersion: 2` goes
 * on the outer message, which is where the client reads it.
 *
 * There is deliberately NO `viewOnceMessage` wrapper here. The comment that used
 * to claim rc14 "only serialises interactive messages in this envelope" was
 * inherited from a reference bot and never checked. Checked: rc14 serialises a
 * bare `interactiveMessage` and `getContentType` reports it correctly. The
 * wrapper was in fact what stopped interactive stanzas rendering — the relay
 * returned a clean ID and the recipient saw nothing.
 *
 * The inner message is built with `proto.Message.InteractiveMessage.fromObject`
 * so nested shapes — notably a button's `{ displayText }` — are materialised as
 * real protobuf messages rather than left as plain objects for the encoder to
 * mis-handle.
 */
export function wrapInteractive(
  key: string,
  payload: Record<string, unknown>,
  rest: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
    interactiveMessage: proto.Message.InteractiveMessage.fromObject(toInteractiveInner(key, payload, rest)),
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
  rest: Record<string, unknown> = {},
): Record<string, unknown> {
  // Already a native interactive message — nothing to convert.
  if (key === 'interactiveMessage') {
    return payload;
  }

  if (key === 'interactiveButtons') {
    // The reference API (`refs/atex-ovi__wabase-button/src/handler.js`) shape:
    //
    //   { text, title, subtitle, footer, interactiveButtons: [ { name, buttonParamsJson } ] }
    //
    // Note the split: `payload` is the **array** (it is what the key held), and
    // the prose lives in `rest` alongside it. An earlier version of this branch
    // read `payload.text` and silently produced a buttonless message — the exact
    // failure the plugin exists to prevent, so `rest` is threaded in explicitly.
    //
    // Unlike `buttonsMessage` there is nothing to infer here: each entry already
    // carries its real flow name, and the `native_flow` node is named from it.
    const buttons = (Array.isArray(payload) ? payload : []) as Array<{
      name?: string;
      buttonParamsJson?: string;
    }>;

    const title = rest['title'];
    const subtitle = rest['subtitle'];
    const hasHeader = typeof title === 'string' || typeof subtitle === 'string';

    return {
      body: { text: String(rest['text'] ?? (typeof title === 'string' ? title : '')) },
      ...(hasHeader
        ? {
            header: {
              title: typeof title === 'string' ? title : '',
              subtitle: typeof subtitle === 'string' ? subtitle : '',
              hasMediaAttachment: false,
            },
          }
        : {}),
      ...(rest['footer'] ? { footer: { text: String(rest['footer']) } } : {}),
      nativeFlowMessage: {
        buttons: buttons.map((b, i) => ({
          // No fallback flow is invented here: an unnamed button is what the
          // client treats as a `quick_reply`, so say so rather than omitting it.
          name: b.name ?? 'quick_reply',
          buttonParamsJson:
            b.buttonParamsJson ?? JSON.stringify({ display_text: `Button ${i + 1}`, id: `b${i + 1}` }),
        })),
      },
    };
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
    // Rows must be `{ header, title, description, id }`. Callers use `rowId`
    // (and sometimes neither), and passing sections through verbatim produces a
    // stanza the client accepts and then fails to render — the phantom-drop
    // signature. Normalise here rather than trusting the caller.
    const rawSections = (payload.sections ?? []) as Array<{
      title?: string;
      rows?: Array<{ title?: string; rowId?: string; id?: string; description?: string }>;
    }>;

    const sections = rawSections.map((sec) => ({
      title: sec.title ?? '',
      rows: (sec.rows ?? []).map((row, i) => ({
        header: '',
        title: row.title ?? '',
        description: row.description ?? '',
        id: row.id ?? row.rowId ?? `row${i}`,
      })),
    }));

    return {
      body: { text: (payload.description as string) ?? (payload.title as string) ?? 'Select an option' },
      ...(payload.footerText ? { footer: { text: payload.footerText as string } } : {}),
      ...(payload.title ? { header: { title: payload.title as string, subtitle: '' } } : {}),
      nativeFlowMessage: {
        buttons: [
          {
            name: 'single_select',
            buttonParamsJson: JSON.stringify({
              title: (payload.buttonText as string) ?? (payload.title as string) ?? 'Menu',
              sections,
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
 * This is the `listFallback: 'text'` path: a send that works on every client
 * regardless of native-flow support. A numbered list preserves both the
 * grouping and the reply affordance.
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
          // The whole content, not just the payload: `interactiveButtons` carries
          // its flow name inside its own buttons, and the stanza node has to match.
          const flowName = interactiveFlowName(key, options, content as Record<string, unknown>);

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
                  'listFallback is "throw": refusing to send the listMessage. ' +
                    'Use listFallback: "text" to send a numbered menu instead',
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
                wrapInteractive(key, payload as Record<string, unknown>, rest),
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

              // Editing an interactive message needs the protocolMessage wrapper
              // that `generateWAMessageContent` would have added. This plugin
              // calls `generateWAMessageFromContent` instead, which never looks at
              // `edit`, so a caller passing `{ text, edit, interactiveButtons }`
              // had the edit silently dropped and got a brand-new message where
              // they asked for an in-place update.
              const outgoing = rest.edit
                ? {
                  protocolMessage: {
                    key: rest.edit,
                    editedMessage: inner,
                    timestampMs: Date.now(),
                    type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
                  },
                }
                : inner;

              await sock.relayMessage(jid, outgoing, {
                messageId: full.key.id,
                useCachedGroupMetadata,
                additionalNodes: interactiveNodes(jid),
              } as never);

              // What `sendMessage` does after relaying, so the outgoing message
              // lands in local history the way it would for any other send.
              queueMicrotask(() => {
                try {
                  sock.ev.emit('messages.update' as never, [
                    { key: full.key, update: { message: outgoing as never } },
                  ] as never);
                } catch (err) {
                  log.debug('local history update failed', { err: (err as Error).message });
                }
              });

              counters.sent += 1;
              log.debug('sent interactive message', { kind: key, flow: flowName, jid, id: full.key.id, edit: Boolean(rest.edit) });
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