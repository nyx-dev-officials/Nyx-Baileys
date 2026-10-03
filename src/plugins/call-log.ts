import { jidNormalizedUser } from '@whiskeysockets/baileys';

import type { BaileysEventMap, WACallEvent, WACallUpdateType } from '@whiskeysockets/baileys';
import type { Plugin } from '../utils/types.js';

/**
 * Call log.
 *
 * `call` is the one Baileys event that is not a fact but a *transition*. A
 * single call produces a stream of the same `WACallEvent` shape with `status`
 * moving through `offer → ringing → preaccept → accept → terminate`, and the
 * array can hold updates for several calls at once. So the unit here is the
 * call, not the event: entries are keyed by `chatId`, folded forward as
 * statuses arrive, and only then judged.
 *
 * Judging matters because the terminal states mean opposite things:
 *
 *   - `reject` / `timeout` / `terminate` before `accept` → **missed**
 *   - `terminate` after `accept` → completed, and the duration is real
 *
 * Without that distinction every unanswered call looks identical, which is the
 * one thing a call log exists to tell apart. `durationMs` is therefore measured
 * from the first `offer` to the terminal status, and is `null` — not zero —
 * while a call is still live, because "no duration yet" and "instant" are
 * different facts.
 *
 * Group calls report `isGroup` with a `groupJid` and no single participant, so
 * `with` is only populated for direct calls and stays empty for those.
 */

export interface CallOptions {
  /** Max calls retained. Oldest evicted first. */
  max?: number;
  /** Ignore calls in these chats. */
  ignore?: (chatId: string) => boolean;
}

export interface CallEntry {
  readonly id: string;
  /** Group jid for a group call, otherwise the peer. */
  readonly chatId: string;
  /** Peer for a direct call; empty for group calls. */
  readonly from: string;
  /** Group jid when this is a group call. */
  readonly groupJid?: string;
  readonly isGroup: boolean;
  readonly isVideo: boolean;
  /** Latest status seen. */
  status: WACallUpdateType;
  /** Every status seen, in arrival order. */
  readonly statuses: WACallUpdateType[];
  readonly startedAt: number;
  /** Mutable: folded forward as later frames arrive. */
  updatedAt: number;
  terminalAt?: number;
  /** True once a terminal status arrived. */
  ended: boolean;
  /** True when the call ended before anyone accepted. */
  missed: boolean;
  /** Wall time from first offer to terminal status. Null while live. */
  durationMs: number | null;
  /** Reported latency, when the server supplied it. */
  latencyMs?: number;
  /** True when the call arrived while we were offline. */
  readonly offline: boolean;
}

export function callLog(options: CallOptions = {}): Plugin {
  const max = Math.max(1, options.max ?? 200);

  return {
    name: 'call-log',
    order: 140,

    apply(ctx) {
      const log = ctx.log.child('call');
      /** chatId -> live or most recent call. */
      const calls = new Map<string, CallEntry>();
      /** Insertion order, so eviction is genuinely oldest-first. */
      const order: string[] = [];

      /** Terminal statuses, per `WACallUpdateType`. */
      const TERMINAL: readonly WACallUpdateType[] = ['reject', 'timeout', 'terminate'];

      const evict = (): void => {
        while (order.length > max) {
          const oldest = order.shift();
          if (oldest === undefined) break;
          calls.delete(oldest);
        }
      };

      const fold = (event: WACallEvent): void => {
        const chatId = event.chatId;
        if (!chatId) return;
        if (options.ignore?.(chatId)) return;

        const existing = calls.get(chatId);
        // A new `offer` in the same chat is a new call: same chat, different id.
        const isNewCall = !existing || (event.status === 'offer' && existing.id !== event.id);

        if (isNewCall) {
          const entry: CallEntry = {
            id: event.id,
            chatId,
            from: jidNormalizedUser(event.from),
            ...(event.groupJid ? { groupJid: event.groupJid } : {}),
            isGroup: event.isGroup === true || !!event.groupJid,
            isVideo: event.isVideo === true,
            status: event.status,
            statuses: [event.status],
            startedAt: event.date?.getTime() ?? Date.now(),
            updatedAt: Date.now(),
            ended: false,
            missed: false,
            durationMs: null,
            offline: event.offline === true,
            ...(event.latencyMs !== undefined ? { latencyMs: event.latencyMs } : {}),
          };
          calls.set(chatId, entry);
          order.push(chatId);
          evict();
        }

        const entry = calls.get(chatId);
        if (!entry) return;

        // Replays and out-of-order frames are normal on a flaky link. Only
        // advance on a status we have not already recorded.
        if (entry.statuses[entry.statuses.length - 1] !== event.status) {
          entry.statuses.push(event.status);
        }
        entry.status = event.status;
        entry.updatedAt = Date.now();
        if (event.latencyMs !== undefined) entry.latencyMs = event.latencyMs;

        if (TERMINAL.includes(event.status)) {
          entry.ended = true;
          entry.terminalAt = event.date?.getTime() ?? Date.now();
          // Accepted first, then terminated → a real call with a real length.
          const wasAccepted = entry.statuses.includes('accept') || entry.statuses.includes('preaccept');
          entry.missed = !wasAccepted;
          entry.durationMs = Math.max(0, entry.terminalAt - entry.startedAt);
        }

        log.debug('call update', { chatId, status: event.status, missed: entry.missed });
        ctx.sock.ev.emit('super.call' as never, entry as never);
      };

      ctx.sock.ev.on('call', (event: BaileysEventMap['call']) => {
        for (const item of event ?? []) {
          if (!item) continue;
          fold(item);
        }
      });

      /* ── surface ────────────────────────────────────────────────── */

      const get = (chatId: string): CallEntry | undefined => calls.get(chatId);

      const recent = (limit = 50): CallEntry[] =>
        order
          .slice(-Math.max(0, limit))
          .reverse()
          .map((id) => calls.get(id))
          .filter((e): e is CallEntry => !!e);

      const missed = (): CallEntry[] => recent(1000).filter((e) => e.missed);

      /**
       * Aggregate over ended calls only. Including live ones would report a
       * duration of zero for every call currently ringing.
       */
      const summary = (): {
        total: number;
        ended: number;
        live: number;
        missed: number;
        video: number;
        group: number;
        totalDurationMs: number;
      } => {
        const all = recent(1000);
        const endedCalls = all.filter((e) => e.ended);
        return {
          total: all.length,
          ended: endedCalls.length,
          live: all.length - endedCalls.length,
          missed: endedCalls.filter((e) => e.missed).length,
          video: all.filter((e) => e.isVideo).length,
          group: all.filter((e) => e.isGroup).length,
          totalDurationMs: endedCalls.reduce((n, e) => n + (e.durationMs ?? 0), 0),
        };
      };

      Object.defineProperty(ctx.sock, 'calls', { value: calls, enumerable: false, configurable: true });
      Object.defineProperty(ctx.sock, 'getCall', { value: get, enumerable: false, configurable: true });
      Object.defineProperty(ctx.sock, 'recentCalls', { value: recent, enumerable: false, configurable: true });
      Object.defineProperty(ctx.sock, 'missedCalls', { value: missed, enumerable: false, configurable: true });
      Object.defineProperty(ctx.sock, 'callSummary', { value: summary, enumerable: false, configurable: true });

      log.debug('attached', { max });
    },
  };
}

export default callLog;
