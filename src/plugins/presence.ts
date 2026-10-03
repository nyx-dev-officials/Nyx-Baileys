import { jidNormalizedUser } from '@whiskeysockets/baileys';

import type { BaileysEventMap, WAPresence } from '@whiskeysockets/baileys';
import type { Plugin } from '../utils/types.js';

/**
 * Presence — reflecting real state, and manual control of it.
 *
 * ## What this plugin will not do
 *
 * It will not run a timer that emits typing indicators, "online" transitions,
 * or composing/recording pulses while the socket is idle. A chat that shows
 * `composing…` for a bot that is not composing anything is a false statement to
 * a real person, and repeating it on a timer turns a small lie into a habit.
 * Nothing in this file emits a presence that is not caused by one of:
 *
 *   - a real connection state change (`connection.update`)
 *   - real message traffic in either direction, inside a short window
 *   - an explicit operator call (`setPresence`)
 *
 * There is no `setInterval` whose job is to make the account look busy. Two
 * timers exist and neither asserts presence on its own:
 *
 *   - the batching flush, which drains a queue of updates that already exist
 *     and returns immediately when the queue is empty
 *   - a one-shot retraction, armed by real activity and only after `available`
 *     has actually been announced, whose sole job is to *withdraw* that claim
 *     once the busy window lapses
 *
 * Both fire at most once per real event, and neither can introduce a state that
 * is untrue at the moment it is sent.
 *
 * ## What it does do
 *
 * `available` means *connected and actually busy*; `unavailable` means
 * *connected but idle*. That is an honest mapping of the socket's real state,
 * and it is also what the web client does — it does not sit permanently online.
 * `composing` and `recording` are never automatic: they exist only as manual
 * per-chat overrides, because only the operator knows when the bot is really
 * composing something.
 *
 * Per-chat overrides take precedence over the derived state and are explicit
 * about their scope, so `unavailable` on one chat cannot mask the account-wide
 * status, and clearing an override restores the derived value immediately.
 */

export interface PresenceOptions {
  /**
   * How long after real activity the account still counts as "busy", in ms.
   * Default 8s. Zero disables automatic `available` entirely.
   */
  busyMs?: number;
  /**
   * Collapse presence updates requested within this window into one send, in ms.
   * Default 0, which sends immediately. Raise it for high fan-out.
   */
  batchMs?: number;
  /** Per-chat presence the caller wants applied. */
  initial?: Readonly<Record<string, WAPresence>>;
  /** Report inbound presence on the account log at debug level. */
  logInbound?: boolean;
}

export interface PresenceSnapshot {
  /** Account-wide derived presence, or null while disconnected. */
  readonly self: WAPresence | null;
  readonly connected: boolean;
  /** True while inside the `busyMs` window after real traffic. */
  readonly busy: boolean;
  /** Epoch ms of the last real inbound or outbound message. */
  readonly lastActivityAt: number | null;
  /** Explicit per-chat overrides, keyed by normalised jid. */
  readonly overrides: Readonly<Record<string, WAPresence>>;
}

export function presence(options: PresenceOptions = {}): Plugin {
  const busyMs = Math.max(0, options.busyMs ?? 8_000);
  const batchMs = Math.max(0, options.batchMs ?? 0);

  return {
    name: 'presence',
    order: 150,

    apply(ctx) {
      const log = ctx.log.child('presence');

      /** jid -> explicit override set by the operator. */
      const overrides = new Map<string, WAPresence>();
      /** Inbound presence last seen per jid, bounded. */
      const seen = new Map<string, { presence: WAPresence; lastSeen?: number; at: number }>();
      const maxSeen = 500;

      let connected = false;
      let lastActivityAt: number | null = null;
      /** Latest presence requested per target; `undefined` means "everyone". */
      const pending = new Map<string, WAPresence>();
      let flushTimer: NodeJS.Timeout | null = null;
      /**
       * One-shot retraction timer. Armed by real activity, only once we have
       * actually announced `available`, so it can only ever *withdraw* a
       * presence we really did report — never assert one that is not true. It
       * is disarmed by further activity and by dispose.
       */
      let revertTimer: NodeJS.Timeout | null = null;
      /** Last account-wide presence actually sent, or null if none. */
      let announced: WAPresence | null = null;

      const busy = (): boolean => lastActivityAt !== null && Date.now() - lastActivityAt < busyMs;

      /**
       * The honest account-wide value: online-and-busy, or online-and-idle.
       * Null means the socket is down and no presence can be sent at all.
       */
      const derived = (): WAPresence | null => {
        if (!connected) return null;
        return busy() ? 'available' : 'unavailable';
      };

      const disarmRevert = (): void => {
        if (!revertTimer) return;
        clearTimeout(revertTimer);
        revertTimer = null;
      };

      const announce = (value: WAPresence): void => {
        if (announced === value) return;
        announced = value;
        request(value);
      };

      /**
       * Arm the retraction. Fires once, `busyMs` after the activity that made us
       * announce `available`, and only if no new activity has arrived since.
       */
      const armRevert = (): void => {
        disarmRevert();
        if (busyMs === 0) return;
        revertTimer = setTimeout(() => {
          revertTimer = null;
          // Busy again in the meantime — the retraction is no longer true.
          if (!busy() && connected && announced === 'available') announce('unavailable');
        }, busyMs);
        revertTimer.unref?.();
      };

      const send = async (target: string | undefined, value: WAPresence): Promise<void> => {
        try {
          await ctx.sock.sendPresenceUpdate(value, target);
          log.debug('presence sent', { value, scope: target ?? 'global' });
        } catch (err) {
          // Presence is cosmetic. A failure must never surface to a caller.
          log.debug('presence send failed', { err: (err as Error).message });
        }
      };

      /** Drain the queue. Never called with an empty queue. */
      const flush = (): void => {
        flushTimer = null;
        if (pending.size === 0) return;
        for (const [target, value] of pending) {
          void send(target === '' ? undefined : target, value);
        }
        pending.clear();
      };

      /**
       * Request a presence. With `batchMs` > 0 this queues and coalesces: only
       * the last request per target survives, which is the point of batching —
       * twenty intermediate states are not information.
       */
      const request = (value: WAPresence, target?: string): void => {
        const scope = target ? jidNormalizedUser(target) : '';
        if (batchMs === 0) {
          void send(scope || undefined, value);
          return;
        }
        pending.set(scope, value);
        if (flushTimer) return;
        flushTimer = setTimeout(flush, batchMs);
        flushTimer.unref?.();
      };

      /**
       * Pin a chat to a specific presence. This is the only path that can send
       * `composing`/`recording`, and it is always operator-initiated.
       */
      const setPresence = (target: string, value: WAPresence | null): void => {
        const jid = jidNormalizedUser(target);
        if (value === null) {
          overrides.delete(jid);
          log.debug('override cleared', { jid, restored: derived() });
          return;
        }
        overrides.set(jid, value);
        request(value, jid);
      };

      /** The presence in force for a chat right now. */
      const of = (target: string): WAPresence | null =>
        overrides.get(jidNormalizedUser(target)) ?? derived();

      /* ── real state only ────────────────────────────────────────── */

      // Real activity: something actually arrived. Not a heartbeat.
      const markActivity = (): void => {
        lastActivityAt = Date.now();
        const value = derived();
        if (value) announce(value);
        armRevert();
      };

      ctx.sock.ev.on('messages.upsert', (event: BaileysEventMap['messages.upsert']) => {
        if ((event?.messages?.length ?? 0) > 0) markActivity();
      });

      ctx.sock.ev.on('connection.update', (event: BaileysEventMap['connection.update']) => {
        const phase = event?.connection;
        if (phase === 'open') {
          connected = true;
          // Only speak if there is something true to say. A freshly connected
          // socket with no traffic is genuinely idle, and announcing
          // `unavailable` to every contact on every reconnect is noise, not
          // information — so the first announcement waits for real activity.
          if (busy()) announce('available');
          return;
        }
        if (phase === 'close') {
          connected = false;
          lastActivityAt = null;
          // The socket is down: sending presence is impossible, and a queue
          // full of stale requests must not fire on reconnect.
          disarmRevert();
          pending.clear();
          announced = null;
          log.debug('disconnected, presence suspended');
          return;
        }
        // 'connecting' is not a state a peer can observe, so it changes nothing.
      });

      ctx.sock.ev.on('presence.update', (event: BaileysEventMap['presence.update']) => {
        for (const [jid, data] of Object.entries(event?.presences ?? {})) {
          const normalised = jidNormalizedUser(jid);
          seen.set(normalised, {
            presence: data?.lastKnownPresence ?? 'unavailable',
            ...(data?.lastSeen !== undefined ? { lastSeen: data.lastSeen } : {}),
            at: Date.now(),
          });
          if (options.logInbound) log.debug('peer presence', { jid: normalised, value: data?.lastKnownPresence });
          ctx.sock.ev.emit('super.presence' as never, { jid: normalised, ...data } as never);
        }
        while (seen.size > maxSeen) {
          const oldest = seen.keys().next().value;
          if (oldest === undefined) break;
          seen.delete(oldest);
        }
      });

      /* ── surface ────────────────────────────────────────────────── */

      const snapshot = (): PresenceSnapshot => ({
        self: derived(),
        connected,
        busy: busy(),
        lastActivityAt,
        overrides: Object.fromEntries(overrides),
      });

      Object.defineProperty(ctx.sock, 'setPresence', { value: setPresence, enumerable: false, configurable: true });
      Object.defineProperty(ctx.sock, 'presenceOf', { value: of, enumerable: false, configurable: true });
      Object.defineProperty(ctx.sock, 'presenceSnapshot', { value: snapshot, enumerable: false, configurable: true });
      Object.defineProperty(ctx.sock, 'peerPresence', { value: seen, enumerable: false, configurable: true });

      for (const [jid, value] of Object.entries(options.initial ?? {})) overrides.set(jidNormalizedUser(jid), value);

      ctx.onDispose(() => {
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = null;
        disarmRevert();
      });

      log.debug('attached', { busyMs, batchMs });
    },
  };
}

export default presence;
