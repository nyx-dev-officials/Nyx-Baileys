import type { BaileysEventMap, WAMessage, WAMessageKey } from '@whiskeysockets/baileys';
import type { Plugin } from '../utils/types.js';

/**
 * Read receipts.
 *
 * ## The rule this plugin holds
 *
 * A read receipt is a statement to a sender: "your message was displayed". So
 * the only thing allowed to produce one is a message this socket genuinely
 * received. There is no timer here that fabricates receipts for messages nobody
 * sent us, no receipt for a message we have not seen, and none replayed after a
 * reconnect for keys that were never delivered.
 *
 * That rules out one tempting shortcut: "mark the whole chat read on a schedule".
 * It looks like a tidy cleanup job and it is a lie — the account claims to have
 * read messages that may never have arrived, and the sender's blue ticks stop
 * carrying information.
 *
 * What it does instead:
 *   - auto-read per incoming message, gated by policy
 *   - an explicit `bulkRead(keys)` for keys the caller supplies — those keys come
 *     from real messages, usually a history-sync batch the caller just handled
 *   - once per message: a receipt is never sent twice for the same key
 *
 * Delays exist because reading in the same millisecond the message lands is
 * itself a tell. `delayMs` is a per-message timer that fires for a real key and
 * then dies — it is a delay, not a generator.
 */

export interface ReadReceiptsOptions {
  /** Mark messages read as they arrive. Default true. */
  autoRead?: boolean;
  /** Also mark group messages read. Default false — most bots want DMs only. */
  groups?: boolean;
  /** Mark read after this delay, so read receipts are not instant. Default 0. */
  delayMs?: number;
  /**
   * Random extra delay on top of `delayMs`, in ms. Default 0.
   *
   * Jitter exists to avoid sending a burst of receipts when many messages
   * arrive together, which spams the sender's phone with notifications. It is
   * *not* a reading-time simulation — if a handler returns in 50ms there is
   * nothing honest to wait for. Hold the receipt with `defer()` until real work
   * finishes instead, and the wait becomes real.
   *
   * Set `delayMs: 2000, jitterMs: 6000` for a 2–8s window.
   */
  jitterMs?: number;
  /**
   * Hold receipts for a message until the returned function is called. Use this
   * to mark read when processing *actually* completes, so the receipt reflects
   * real state rather than a fabricated delay.
   */
  defer?: boolean;
  /** Also mark messages delivered by history sync. Default true. */
  includeHistorySync?: boolean;
  /** Never mark these chats read, whatever the rest says. */
  skip?: (jid: string) => boolean;
  /**
   * Only these senders get a read receipt — everyone else stays double-ticked.
   * Omit for "no restriction".
   */
  allow?: readonly string[] | ((jid: string) => boolean);
  /**
   * Never send a receipt to these senders, whatever the rest says. Takes
   * precedence over `allow` so a deny is always the final answer.
   */
  deny?: readonly string[] | ((jid: string) => boolean);
  /** Cap on remembered message ids, so dedup cannot grow forever. */
  maxRemembered?: number;
}

export interface ReceiptPolicy {
  readonly autoRead: boolean;
  readonly groups: boolean;
  readonly delayMs: number;
  readonly jitterMs: number;
  readonly includeHistorySync: boolean;
  /** Sender lists are reported in the snapshot so a silent policy is visible. */
  readonly allowCount: number;
  readonly denyCount: number;
}

export interface ReadReceiptsSnapshot {
  readonly policy: ReceiptPolicy;
  readonly marked: number;
  readonly skipped: number;
  readonly failed: number;
  /** Pending delayed receipts, which `dispose` abandons. */
  readonly pending: number;
  /** Receipts parked by `deferRead()`, waiting on real work to finish. */
  readonly held: number;
  /** Receipts released by `deferRead()` so far. */
  readonly released: number;
}

const isGroup = (jid: string): boolean => jid.endsWith('@g.us');

/** Status broadcasts are not a chat you "read"; `status.ts` owns those. */
const isStatus = (jid: string): boolean => jid.endsWith('@broadcast');

/** Stable identity for a message key, used for dedup. */
function keyId(key: WAMessageKey): string {
  return `${key.remoteJid ?? ''}|${key.id ?? ''}`;
}

export function readReceipts(options: ReadReceiptsOptions = {}): Plugin {
  const policy: ReceiptPolicy = {
    autoRead: options.autoRead ?? true,
    groups: options.groups ?? false,
    delayMs: Math.max(0, options.delayMs ?? 0),
    jitterMs: Math.max(0, options.jitterMs ?? 0),
    includeHistorySync: options.includeHistorySync ?? true,
    allowCount: Array.isArray(options.allow) ? options.allow.length : options.allow ? -1 : 0,
    denyCount: Array.isArray(options.deny) ? options.deny.length : options.deny ? -1 : 0,
  };
  const maxRemembered = Math.max(1, options.maxRemembered ?? 2_000);

  return {
    name: 'read-receipts',
    order: 160,

    apply(ctx) {
      const log = ctx.log.child('read');

      /** Message ids already receipted, so we never send a receipt twice. */
      const seen = new Set<string>();
      const pendingTimers = new Map<string, NodeJS.Timeout>();
      /** Receipts parked by `deferRead()`, awaiting a real signal. */
      const held = new Map<string, WAMessageKey>();
      const counters = { marked: 0, skipped: 0, failed: 0, released: 0 };

      /**
       * Delay for one receipt: `delayMs` plus a uniform `[0, jitterMs]`.
       *
       * Drawn per message rather than once, so a chat that delivers ten
       * messages together produces ten receipts spread across the window
       * instead of ten simultaneous writes — which is the actual point of the
       * option, and is why it is worth having at all.
       */
      const drawDelay = (): number =>
        policy.jitterMs > 0
          ? policy.delayMs + Math.floor(Math.random() * (policy.jitterMs + 1))
          : policy.delayMs;

      const remember = (id: string): void => {
        seen.add(id);
        while (seen.size > maxRemembered) {
          const oldest = seen.keys().next().value;
          if (oldest === undefined) break;
          seen.delete(oldest);
        }
      };

      /** Resolve a sender list: array membership or predicate. */
      const matches = (
        rule: readonly string[] | ((jid: string) => boolean) | undefined,
        jid: string,
      ): boolean => {
        if (!rule) return false;
        if (typeof rule === 'function') return rule(jid);
        const device = jid.split(':')[0] ?? jid;
        return rule.includes(jid) || rule.includes(device);
      };

      /**
       * Decide whether a received message may be marked read. Every refusal
       * path increments `skipped` so a policy that never fires is visible in
       * the snapshot instead of looking like an idle socket.
       */
      const allowed = (key: WAMessageKey): boolean => {
        const jid = key.remoteJid ?? '';
        if (!jid) return false;
        // Never a receipt for our own message — WhatsApp does not send one, and
        // sending one would be a protocol error, not a policy choice.
        if (key.fromMe) return false;
        if (isStatus(jid)) return false;
        if (isGroup(jid) && !policy.groups) return false;
        if (options.skip?.(jid)) return false;
        // Selective tick: deny wins, then an allowlist, if present, is exclusive.
        if (matches(options.deny, jid)) return false;
        if (options.allow && !matches(options.allow, jid)) return false;
        return true;
      };

      const fire = async (keys: WAMessageKey[]): Promise<void> => {
        if (keys.length === 0) return;
        try {
          await ctx.sock.readMessages(keys);
          for (const key of keys) remember(keyId(key));
          counters.marked += keys.length;
          log.debug('marked read', { n: keys.length });
        } catch (err) {
          // A failed receipt is retriable by the caller; never propagate into
          // an event handler, where it would surface as an unhandled rejection.
          counters.failed += keys.length;
          for (const key of keys) seen.delete(keyId(key));
          log.debug('readMessages failed', { err: (err as Error).message });
        }
      };

      /**
       * Mark one message read, honouring the configured delay. The timer is
       * keyed by message id and cancelled on dispose, so a shutdown cannot fire
       * receipts against a closed socket.
       */
      const markRead = (key: WAMessageKey): void => {
        const id = keyId(key);
        if (!id || seen.has(id)) return;
        if (!allowed(key)) {
          counters.skipped += 1;
          return;
        }

        if (policy.delayMs === 0 && policy.jitterMs === 0) {
          void fire([key]);
          return;
        }
        if (pendingTimers.has(id)) return;

        const timer = setTimeout(() => {
          pendingTimers.delete(id);
          // Re-check at fire time: policy may have been seen as fine earlier.
          if (!allowed(key)) {
            counters.skipped += 1;
            return;
          }
          void fire([key]);
        }, drawDelay());
        timer.unref?.();
        pendingTimers.set(id, timer);
      };

      ctx.sock.ev.on('messages.upsert', (event: BaileysEventMap['messages.upsert']) => {
        if (!policy.autoRead) return;
        if (event?.type === 'append' && !policy.includeHistorySync) return;
        for (const msg of (event?.messages ?? []) as WAMessage[]) {
          if (!msg.key) continue;

          // With `defer`, arrival parks the receipt instead of sending it. The
          // consumer releases it via `deferRead()` when its own work is done,
          // so the tick reflects processing rather than delivery.
          if (options.defer) {
            const id = keyId(msg.key);
            if (id && !seen.has(id) && allowed(msg.key)) held.set(id, msg.key);
            continue;
          }

          markRead(msg.key);
        }
      });

      /**
       * Mark a message read only when real work finishes. Returns the release
       * function; calling it marks the message read, optionally with the
       * configured delay still applied.
       *
       * This is the honest way to slow a receipt down. A jitter timer makes the
       * wait arbitrary; `defer` makes it correspond to something real — the
       * handler that decided it had read the message actually completing.
       */
      const deferRead = (key: WAMessageKey): (() => void) => {
        const id = keyId(key);

        if (!id || seen.has(id)) return () => {};
        // Park it whether or not it was already parked by `defer` on upsert, so
        // this is usable with `defer: false` too.
        held.set(id, key);

        return () => {
          if (!held.delete(id)) return; // already released, or dropped on dispose
          counters.released += 1;

          // Policy is re-checked at release, not at arrival: a chat may have
          // been denied between the two moments.
          if (!allowed(key)) {
            counters.skipped += 1;
            return;
          }
          markRead(key);
        };
      };

      /* ── surface ────────────────────────────────────────────────── */

      /**
       * Mark an explicit set of keys read, now. The caller owns those keys, so
       * this is for batches the caller has just decided are handled — it still
       * refuses anything that fails `allowed`, so it cannot become a loophole
       * around the policy.
       */
      const bulkRead = async (keys: readonly WAMessageKey[]): Promise<number> => {
        const eligible = keys.filter((k) => {
          if (!allowed(k)) {
            counters.skipped += 1;
            return false;
          }
          return !seen.has(keyId(k));
        });
        await fire(eligible);
        return eligible.length;
      };

      const snapshot = (): ReadReceiptsSnapshot => ({
        policy,
        marked: counters.marked,
        skipped: counters.skipped,
        failed: counters.failed,
        pending: pendingTimers.size,
        held: held.size,
        released: counters.released,
      });

      Object.defineProperty(ctx.sock, 'markRead', { value: markRead, enumerable: false, configurable: true });
      Object.defineProperty(ctx.sock, 'deferRead', { value: deferRead, enumerable: false, configurable: true });
      Object.defineProperty(ctx.sock, 'bulkRead', { value: bulkRead, enumerable: false, configurable: true });
      Object.defineProperty(ctx.sock, 'receiptSnapshot', { value: snapshot, enumerable: false, configurable: true });
      Object.defineProperty(ctx.sock, 'readReceiptKeys', { value: seen, enumerable: false, configurable: true });

      ctx.onDispose(() => {
        // Cancel every delayed receipt: the socket is going away, and firing
        // into a closed socket is exactly the kind of dead write to avoid.
        for (const timer of pendingTimers.values()) clearTimeout(timer);
        pendingTimers.clear();
        // Held receipts are dropped rather than fired — the work that would
        // have released them is gone with the socket. The returned release
        // closures check for their own removal, so a late call is a no-op.
        held.clear();
      });

      log.debug('attached', { ...policy });
    },
  };
}

export default readReceipts;
