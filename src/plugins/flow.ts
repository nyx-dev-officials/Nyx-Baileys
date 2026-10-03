import type { WAMessage } from '@whiskeysockets/baileys';

import type { Plugin } from '../utils/types.js';

/**
 * Conversational flow engine.
 *
 * A thin state machine over `messages.upsert`: named steps, each with a match,
 * each able to hand off or end. Developers declare a tree instead of writing
 * `if (state === 2)` chains, and the per-chat state that makes multi-turn
 * conversations work is owned here rather than smeared across handlers.
 *
 * State is per-chat and in memory, so a restart drops in-flight conversations —
 * right for the common case of short flows. Flows that must survive a restart
 * persist into `ctx.state` themselves.
 */

export interface FlowContext {
  /** The raw incoming message, when this step was entered by a message. */
  msg: WAMessage | null;
  /** Chat jid. */
  jid: string;
  /** Text body, or the selected row title for an interactive reply. */
  text: string;
  /** Selected native-flow row title, when the message was an interactive reply. */
  selection?: string;
  /** Parsed payload of a native-flow form reply, when the message was one. */
  flowResponse?: Record<string, unknown>;
  /** Outbound helper bound to this chat. */
  reply(content: unknown, extra?: Record<string, unknown>): Promise<unknown>;
  /** Move to another step in this flow. */
  goto(step: string): void;
  /** End the flow. */
  end(): void;
  /** Scratch state that survives across steps. */
  state: Record<string, unknown>;
}

export interface FlowStep {
  name: string;
  /** Entry condition. Required on the entry step. */
  match?: RegExp | ((text: string) => boolean);
  run(ctx: FlowContext): void | Promise<void>;
}

export interface Flow {
  id: string;
  entry: string;
  steps: FlowStep[];
  /** Consume further messages while a step is active. Default true. */
  capture?: boolean;
  /** Idle this long and the flow drops. Default 15 minutes. */
  ttlMs?: number;
}

interface ActiveFlow {
  flow: Flow;
  step: string;
  state: Record<string, unknown>;
  at: number;
}

export function flowEngine(flows: Flow[] = []): Plugin {
  return {
    name: 'flow',
    order: 90,

    apply(ctx) {
      const log = ctx.log.child('flow');
      const registry = new Map(flows.map((f) => [f.id, f]));
      const active = new Map<string, ActiveFlow>();

      /** Send bound to a chat — steps never touch the socket. */
      const send = (jid: string, content: unknown, extra?: Record<string, unknown>): Promise<unknown> =>
        ctx.sock.sendMessage(jid, { text: String(content) } as never, extra as never);

      /**
       * What the human actually produced. Interactive replies and list replies
       * carry the choice in a different field than plain text, and reading only
       * `conversation` is why button handlers silently stop firing.
       */
      /**
       * Pull the user's choice out of a native-flow reply.
       *
       * rc14 delivers a form submit as
       * `interactiveResponseMessage.nativeFlowResponseMessage.paramsJson` — a
       * JSON string echoing the flow the sender built. Without reading this,
       * the form we send is the one form whose replies are invisible to us:
       * they arrive and get discarded as empty.
       *
       * The picked row's identifier varies by flow schema, so rather than
       * betting on one shape we scan for the first recognisable value and also
       * hand the parsed object back via `ctx.flowResponse`.
       */
      const parseFlowResponse = (
        paramsJson: string | null | undefined,
      ): { selection?: string; parsed?: Record<string, unknown> } => {
        if (!paramsJson) return {};

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(paramsJson) as Record<string, unknown>;
        } catch {
          return { selection: paramsJson };
        }

        const direct = [
          parsed.selectedDisplayText,
          parsed.selectedRowId,
          parsed.selectedOptionName,
          parsed.value,
          (parsed.values as { value?: string } | undefined)?.value,
        ].find((v): v is string => typeof v === 'string' && v.length > 0);
        if (direct) return { selection: direct, parsed };

        const queue: unknown[] = [parsed];
        while (queue.length) {
          const node = queue.shift();
          if (node && typeof node === 'object') {
            const rec = node as Record<string, unknown>;
            const title = rec.selectedTitle ?? rec.title;
            if (typeof title === 'string' && title.length > 0) return { selection: title, parsed };
            queue.push(...Object.values(rec));
          }
        }

        return { parsed };
      };

      const extract = (msg: WAMessage): { text: string; selection?: string; response?: Record<string, unknown> } => {
        const m = msg.message as Record<string, unknown> | undefined;
        const interactive = m?.interactiveMessage as Record<string, unknown> | undefined;
        const buttons = m?.buttonsResponseMessage as Record<string, unknown> | undefined;
        const list = m?.listResponseMessage as { singleSelectReply?: { selectedRowId?: string } } | undefined;
        const listMsg = m?.listMessage as Record<string, unknown> | undefined;
        const extended = m?.extendedTextMessage as Record<string, unknown> | undefined;

        // A native-flow form submit. Checked first because it is the reply to
        // the richest message we send, and it carries no plain-text body.
        const native = (m?.interactiveResponseMessage as
          | { nativeFlowResponseMessage?: { paramsJson?: string | null } | null }
          | undefined)?.nativeFlowResponseMessage;
        const flowReply = parseFlowResponse(native?.paramsJson);

        const selection =
          flowReply.selection ??
          (typeof interactive?.selectedDisplayText === 'string'
            ? interactive.selectedDisplayText
            : typeof buttons?.selectedDisplayText === 'string'
              ? buttons.selectedDisplayText
              : undefined);

        const text =
          (typeof interactive?.bodyText === 'string' ? interactive.bodyText : undefined) ??
          (typeof buttons?.selectedDisplayText === 'string' ? buttons.selectedDisplayText : undefined) ??
          (typeof list?.singleSelectReply?.selectedRowId === 'string'
            ? list.singleSelectReply.selectedRowId
            : undefined) ??
          (typeof listMsg?.title === 'string' ? listMsg.title : undefined) ??
          (typeof m?.conversation === 'string' ? m.conversation : undefined) ??
          (typeof extended?.text === 'string' ? extended.text : undefined) ??

          selection ??
          '';

        return { text: text.trim(), selection, response: flowReply.parsed };
      };

      const stepByName = (flow: Flow, name: string): FlowStep | undefined =>
        flow.steps.find((s) => s.name === name);

      const matches = (step: FlowStep, probe: string): boolean => {
        if (!step.match) return true;
        return step.match instanceof RegExp ? step.match.test(probe) : step.match(probe);
      };

      const buildContext = (
        running: ActiveFlow,
        jid: string,
        probe: { text: string; selection?: string; response?: Record<string, unknown> },
        msg: WAMessage | null,
      ): FlowContext => ({
        msg,
        jid,
        text: probe.text,
        selection: probe.selection,
        // Carried through so a step can read fields beyond the selected row.
        flowResponse: probe.response,
        state: running.state,
        reply: (content, extra) => send(jid, content, extra),
        goto: (name) => {
          const next = stepByName(running.flow, name);
          if (!next) {
            log.warn('goto target missing', { flow: running.flow.id, to: name });
            return;
          }
          // A step can call `end()` and then `goto()`, or the flow can TTL-expire
          // between the two. `run()` would then return early on a missing entry
          // and drop the jump without a word — surface it instead.
          if (active.get(jid) !== running) {
            log.warn('goto with no active flow', { flow: running.flow.id, to: name });
            return;
          }
          void run(jid, next);
        },
        end: () => {
          active.delete(jid);
        },
      });

      const run = async (jid: string, step: FlowStep): Promise<void> => {
        const running = active.get(jid);
        if (!running) return;
        running.step = step.name;

        try {
          await step.run(buildContext(running, jid, { text: '' }, null));
        } catch (err) {
          log.error('flow step failed', {
            flow: running.flow.id,
            step: step.name,
            err: (err as Error).message,
          });
          active.delete(jid);
        }
      };

      const start = (jid: string, flow: Flow, probe: { text: string; selection?: string }, msg: WAMessage): void => {
        const entry = stepByName(flow, flow.entry);
        if (!entry) {
          log.warn('flow entry missing', { flow: flow.id, entry: flow.entry });
          return;
        }
        const running: ActiveFlow = { flow, step: entry.name, state: {}, at: Date.now() };
        active.set(jid, running);

        void (async () => {
          try {
            await entry.run(buildContext(running, jid, probe, msg));
          } catch (err) {
            log.error('flow entry failed', { flow: flow.id, err: (err as Error).message });
            active.delete(jid);
          }
        })();
      };

      ctx.sock.ev.on('messages.upsert', (event: { messages: WAMessage[] }) => {
        for (const msg of event.messages ?? []) {
          const jid = msg.key?.remoteJid;
          if (!jid || msg.key?.fromMe) continue;

          const probe = extract(msg);
          if (!probe.text && !probe.selection) continue;
          const input = probe.selection ?? probe.text;

          // Expire stale conversations.
          const running = active.get(jid);
          if (running) {
            const ttl = running.flow.ttlMs ?? 15 * 60 * 1000;
            if (Date.now() - running.at > ttl) {
              active.delete(jid);
              continue;
            }
          }

          // In a flow: the active step gets first refusal on anything.
          if (running) {
            if (running.flow.capture === false) continue;
            const step = stepByName(running.flow, running.step);
            if (!step) {
              active.delete(jid);
              continue;
            }
            void (async () => {
              try {
                await step.run(buildContext(running, jid, probe, msg));
              } catch (err) {
                log.error('flow step failed', { step: step.name, err: (err as Error).message });
                active.delete(jid);
              }
            })();
            continue;
          }

          // Idle: find an entry step that claims this input.
          for (const flow of registry.values()) {
            const entry = stepByName(flow, flow.entry);
            if (entry?.match && matches(entry, input)) {
              start(jid, flow, probe, msg);
              break;
            }
          }
        }
      });

      Object.defineProperty(ctx.sock, 'flows', {
        value: {
          add: (flow: Flow) => registry.set(flow.id, flow),
          remove: (id: string) => registry.delete(id),
          list: () => [...registry.keys()],
          active: (jid: string) => active.get(jid)?.step,
          reset: (jid?: string) => {
            if (jid) active.delete(jid);
            else active.clear();
          },
        },
        enumerable: false,
        configurable: true,
      });
    },
  };
}

export default flowEngine;
