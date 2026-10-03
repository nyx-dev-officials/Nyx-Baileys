import { proto } from '@whiskeysockets/baileys';

import { patch } from '../core/intercept.js';
import type { Plugin } from '../utils/types.js';

/**
 * Message normaliser.
 *
 * Interactive payloads are the part of the protocol that breaks most often,
 * and the breakage is silent: a button that renders as plain text, or an
 * interactive node stripped to `conversation`. This inspects every outbound
 * message before it is compiled and repairs the two structural problems that
 * account for nearly all of it.
 *
 *   1. A `viewOnceMessage` / `documentWithCaptionMessage` / `editedMessage`
 *      wrapper holding an interactive node. The node has to be moved to the
 *      top level or the client ignores it.
 *   2. A native flow whose rows lack `optionName`. Without it the client
 *      cannot render a selection and falls back to a text bubble.
 *
 * Both are fixes, not bypasses: the message still goes through Baileys' own
 * protobuf compilation and WhatsApp's own validation.
 */

export interface SessionRepairOptions {
  /** Log every repair. */
  verbose?: boolean;
}

type AnyMessage = Record<string, unknown>;

/** Wrappers that legitimately contain an interactive payload. */
const WRAPPERS = [
  'viewOnceMessage',
  'documentWithCaptionMessage',
  'editedMessage',
  'ephemeralMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
];

export function sessionRepair(options: SessionRepairOptions = {}): Plugin {
  return {
    name: 'session-repair',
    order: 65,

    apply(ctx) {
      const log = ctx.log.child('repair');
      let repairs = 0;

      /**
       * Hoist an interactive node out of a wrapper and delete the wrapper, so
       * the node survives to the wire.
       */
      const unwrap = (message: AnyMessage): AnyMessage => {
        for (const wrapper of WRAPPERS) {
          const inner = message[wrapper] as AnyMessage | undefined;
          if (!inner) continue;

          const nested =
            (inner.message as AnyMessage | undefined)?.interactiveMessage ??
            (inner.message as AnyMessage | undefined)?.templateMessage;

          if (nested) {
            log.debug('hoisting interactive out of wrapper', { wrapper });
            delete message[wrapper];
            return inner.message as AnyMessage;
          }
        }
        return message;
      };

      /**
       * Give every selectable row an `optionName` so the UI can bind it.
       *
       * On rc14 the flow schema lives inside `messageParamsJson` as a JSON
       * string, so this parses, repairs, and re-serialises. A malformed string
       * is left exactly as it was — corrupting the payload would be worse than
       * the missing `optionName`.
       */
      const repairFlow = (node: Record<string, unknown>): void => {
        const raw = node.messageParamsJson;
        if (typeof raw !== 'string' || raw.length === 0) return;

        let params: Record<string, unknown>;
        try {
          params = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          log.debug('unparsable messageParamsJson, leaving untouched');
          return;
        }

        // `JSON.parse('null')` succeeds and yields null, so the string guard
        // above is not enough — the parsed shape needs its own check. The
        // contract is that an unreadable payload is left exactly as it was.
        if (!params || typeof params !== 'object') return;

        const sections = (params as Record<string, unknown>).sections;
        if (!Array.isArray(sections)) return;

        let touched = 0;
        for (const section of sections as Array<Record<string, unknown>>) {
          const rows = section?.rows;
          if (!Array.isArray(rows)) continue;

          for (const [i, row] of (rows as Array<Record<string, unknown>>).entries()) {
            if (typeof row?.optionName !== 'string' || !row.optionName) {
              row.optionName = String(row?.title ?? `option_${i}`);
              touched += 1;
            }
          }
        }

        if (touched) {
          node.messageParamsJson = JSON.stringify(params);
          repairs += touched;
          if (options.verbose) log.debug('added optionName to rows', { count: touched });
        }
      };

      /** The normaliser, callable on its own for testing. */
      const normalise = (content: AnyMessage): AnyMessage => {
        if (!content || typeof content !== 'object') return content;

        let message = content;
        const hoisted = unwrap(message);
        if (hoisted !== message) message = hoisted;

        const interactive = message.interactiveMessage as Record<string, unknown> | undefined;
        if (interactive?.nativeFlowMessage) {
          repairFlow(interactive.nativeFlowMessage as Record<string, unknown>);
        }

        // Buttons carry a `contextInfo` that some clients require.
        if (message.buttonsMessage) {
          const context = (message.contextInfo ??= {});
          void context;
        }

        return message;
      };

      // Patch the two compile entry points so normalisation happens before
      // Baileys serialises anything.
      for (const name of ['sendMessage', 'relayMessage'] as const) {
        const handle = patch(ctx.sock as never, name, ((
          original: (...args: unknown[]) => unknown,
          self: unknown,
          args: unknown[],
        ): unknown => {
          // sendMessage(jid, { ...content }, extra)
          const content = args[1];
          if (content && typeof content === 'object') {
            try {
              args[1] = normalise(content as AnyMessage);
            } catch (err) {
              log.warn('normalise failed, sending as-is', { err: (err as Error).message });
            }
          }
          return Reflect.apply(original, self, args);
        }) as never);

        if (handle.applied) ctx.onDispose(() => handle.undo());
      }

      Object.defineProperty(ctx.sock, '__repairStats', {
        get: () => ({ repairs }),
        enumerable: false,
        configurable: true,
      });
      Object.defineProperty(ctx.sock, '__normalise', {
        value: normalise,
        enumerable: false,
        configurable: true,
      });

      log.debug('attached');
    },
  };
}

export { proto };
export default sessionRepair;
