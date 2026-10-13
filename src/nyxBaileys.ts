import { DisconnectReason } from '@whiskeysockets/baileys';

import { Disposables, invariant } from './core/intercept.js';
import { createCoreSocket, resolveWebVersion, type SocketTuning } from './core/socket.js';
import { FileSessionStore, SerialSaver } from './core/session-store.js';
import { createLogger } from './utils/logger.js';
import type { CoreSocket, Logger, Plugin, SuperOptions } from './utils/types.js';

import { antiSpam } from './plugins/antiSpam.js';
import { clockSync } from './plugins/clock-sync.js';
import { delivery } from './plugins/delivery.js';
import { stealth } from './plugins/stealth.js';
import { warmup } from './plugins/warmup.js';
import { lidRouter } from './plugins/lid.js';
import { albumHandler } from './plugins/album.js';
import { groupGuard } from './plugins/group.js';
import { flowEngine } from './plugins/flow.js';
import { memoryGc } from './plugins/memory.js';
import { mediaStreamer } from './plugins/media-stream.js';
import { autoReconnect } from './plugins/reconnect.js';
import { sessionRepair } from './plugins/session-repair.js';
import { verifiedSpoof } from './plugins/Verified.js';
import { adReply } from './plugins/ad-reply.js';
import { selfClean } from './plugins/self-clean.js';

/**
 * Nyx-Baileys.
 *
 * One upstream `makeWASocket()`, then a chain of runtime decorators. The socket
 * that leaves this class is a real Baileys socket with a few of its methods
 * wrapped — the type is unchanged, so every Baileys API and every community
 * extension still works. Nothing under `node_modules` is touched.
 *
 *   createSocket()   → upstream socket
 *   decorate()       → plugins applied in `order`
 *   the returned `this.sock` is what callers use
 */
export class NyxBaileys {
  readonly options: SuperOptions;
  readonly log: Logger;

  /** The live, decorated socket. */
  sock!: CoreSocket;

  /** Plugins that actually applied, in application order. */
  readonly applied: string[] = [];
  /**
   * The same plugins with their execution order, for display.
   *
   * `applied` is only names because that is all the existing callers need. A
   * dashboard wants the order too, and re-calling `plugins()` to get it would
   * construct a *second* set of plugin instances with different closures — so
   * the objects are recorded as they are applied.
   */
  readonly chain: Array<{ name: string; order: number }> = [];

  #disposables = new Disposables();
  #connecting: Promise<CoreSocket> | null = null;
  /** Queued credential writes. Rebuilds and dispose drain it before reading state. */
  #saver = new SerialSaver();
  #closed = false;
  /** Most recent pairing ref from Baileys. Retained so a late subscriber can still draw it. */
  #lastQr: string | null = null;

  #lastConnection: { at: number; state: string } = { at: 0, state: 'never' };

  /** Last observed close code, if any. Instance-level so it survives rebuilds. */
  #lastClose: { code: number | null; at: number } | null = null;

  constructor(options: SuperOptions = {}) {
    this.options = options;
    this.log = createLogger(options.logLevel ?? 'info', 'super');
  }

  /* ── lifecycle ─────────────────────────────────────────────────── */

  /** Decorators, lowest order first. Override via `registerPlugin`. */
  protected plugins(): Plugin[] {
    const o = this.options;
    return [
      stealth(),        // 10  identity + tuning
      // `verifiedSpoof` (12) is OUT of the default chain as of this change. It
      // fabricates a `status@broadcast` quote on every send and `CONTEXT.md` §6.1
      // still has it open on phantom delivery; running the real ad card next to an
      // unexplained drop is how you end up blaming the wrong plugin. It is still
      // exported — register it deliberately with `client.registerPlugin()` if you
      // want the spoof, and expect the caveat.
      //
      // 13  native ad card on every outgoing message. Runs after 12 so it sits
      // outside it and adds `thumbnail` without touching what 12 already set.
      adReply(o.adReply),
      clockSync(),      // 15  server clock estimate
      lidRouter(),      // 20  target resolution
      mediaStreamer(),  // 30  download path
      albumHandler(),   // 40  incoming containers
      memoryGc(),       // 50  prune state
      groupGuard(),     // 60  admin policy
      sessionRepair(),  // 65  message normaliser
      autoReconnect(),  // 70  self-healing backoff
      antiSpam(o.antiSpam),   // 80  pacing queue
      delivery(),       // 85  delivery-rate tracking
      selfClean(),      // 90  sendAndClean: drop the sender-side copy
      flowEngine(),     // 90  conversational routing
      warmup(o.warmupDays),   // 100 rate ramp
    ];
  }

  /**
   * Replace or extend the default chain. Use for a session-specific addition
   * (approval queue, AI reply, webhook bridge) without forking the class.
   */
  registerPlugin(plugin: Plugin): this {
    const all = [...this.plugins(), plugin].sort((a, b) => a.order - b.order);
    Object.defineProperty(this, 'plugins', { value: () => all, configurable: true });
    return this;
  }

  /**
   * Create the upstream socket and decorate it. Idempotent per instance and
   * concurrency-safe: simultaneous callers share one connection attempt.
   */
  async connect(): Promise<CoreSocket> {
    if (this.#connecting) return this.#connecting;
    this.#connecting = this.#connect().finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  async #connect(): Promise<CoreSocket> {
    invariant(!this.#closed, 'this NyxBaileys instance was disposed');

    const store = this.options.sessionStore ?? new FileSessionStore({
      dir: this.options.sessionDir ?? './session',
      logger: this.log,
    });
    this.log.debug('session store', { name: store.name });

    const { state, saveCreds } = await store.init();
    await resolveWebVersion().catch(() => undefined);

    // Every save — from this connection and any later rebuild — feeds one
    // shared serial queue, so a rebuild can always drain to the latest write.
    const saveCredsSerialised = (): Promise<void> => this.#saver.run(saveCreds);

    const tuning = this.#tuning();
    const sock = await createCoreSocket({
      state,
      saveCreds: saveCredsSerialised,
      options: this.options,
      tuning,
      log: this.log.child('socket'),
    });

    Object.defineProperty(sock, '__requestReconnect', {
      value: () => this.#rebuild(),
      enumerable: false,
      configurable: true,
    });

    this.sock = sock;
    await this.decorate({ sock, state, saveCreds: saveCredsSerialised });
    this.#wireConnection(sock);

    return sock;
  }

  /**
   * Rebuild the socket from persisted state.
   */
  async #rebuild(): Promise<boolean> {
    if (this.#closed) return false;
    if (this.#connecting) return true;

    // Drain queued credential writes BEFORE re-reading from disk. After a
    // successful pairing the server sends 515 almost immediately; rebuilding
    // from a creds.json that does not yet contain the paired state resurrects
    // an unregistered socket, and the phone — which just completed its side —
    // reports the link as failed. This was observed as: registered=true on the
    // old socket, phone error, and a null user on the rebuilt one.
    await this.#saver.drain();

    this.log.info('rebuilding socket');
    this.#disposables.dispose();
    this.#disposables.reset();
    this.applied.length = 0;
    this.chain.length = 0;
    this.#lastQr = null;

    try {
      this.sock?.end?.(undefined);
    } catch {
      /* already down */
    }

    this.#connecting = this.#connect().finally(() => {
      this.#connecting = null;
    });

    try {
      await this.#connecting;
      return true;
    } catch (err) {
      this.log.error('rebuild failed', { err: (err as Error).message });
      return false;
    }
  }

  /** Apply every plugin, isolating failures to one plugin. */
  private async decorate(ctx: { sock: CoreSocket; state: unknown; saveCreds: () => Promise<void> }): Promise<void> {
    const store = this.options.sessionStore;
    const sessionStore = store ?? new FileSessionStore({ dir: this.options.sessionDir ?? './session' });

    const pluginCtx = {
      sock: ctx.sock,
      state: sessionStore,
      options: this.options,
      log: this.log,
      onDispose: (fn: () => void) => this.#disposables.add(fn),
    };

    for (const plugin of this.plugins()) {
      try {
        await plugin.apply(pluginCtx as never);
        this.applied.push(plugin.name);
        this.chain.push({ name: plugin.name, order: plugin.order });
        this.log.debug('plugin applied', { plugin: plugin.name });
      } catch (err) {
        this.log.error('plugin failed to apply', {
          plugin: plugin.name,
          err: (err as Error).message,
        });
      }
    }
  }

  /** Watch connection state; hand disconnects to the reconnect plugin. */
  #wireConnection(sock: CoreSocket): void {
    sock.ev.on('connection.update', (update: {
      connection?: string;
      qr?: string;
      lastDisconnect?: { error?: unknown; date?: unknown };
    }) => {
      // Capture the pairing ref here rather than letting callers listen for it.
      //
      // The first ref lands about 1.1s after this handler is attached, which is
      // long before an interactive prompt finishes asking for a number and a
      // method. A caller that subscribes later misses it entirely and then waits
      // for the next rotation — roughly 20 seconds of an empty terminal, which
      // reads as a hang. Retaining the ref makes the value available whenever
      // the caller is finally ready to draw it.
      if (update.qr) this.#lastQr = update.qr;

      const phase = update.connection;
      this.#lastConnection = { at: Date.now(), state: phase ?? 'unknown' };
      if (phase === 'close') {
        // Baileys reports the reason nested in lastDisconnect, not in the
        // top-level statusCode the close branch below reads (which is always
        // undefined on real updates). Recorded separately and instance-level so
        // it survives rebuilds, unlike every ev-based listener. Plain Errors
        // carry no code and read as null rather than throwing.
        const output = (update.lastDisconnect?.error as {
          output?: { statusCode?: unknown };
        } | null | undefined)?.output;
        this.#lastClose = {
          code: typeof output?.statusCode === 'number' ? output.statusCode : null,
          at: Date.now(),
        };
      }

      switch (phase) {
        case 'open':
          this.log.info('connection open');
          void this.#closeEvent('open');
          return;
        case 'connecting':
          this.log.debug('connecting…');
          return;
        case 'close': {
          const raw = update as { last?: { isLoggedIn?: boolean }; statusCode?: number };
          const loggedOut = raw.last?.isLoggedIn === true;
          this.log.warn('connection closed', {
            reason: raw.statusCode,
            loggedIn: loggedOut,
          });
          void this.#closeEvent('close', loggedOut ? DisconnectReason.loggedOut : raw.statusCode);
          return;
        }
        default:
          return;
      }
    });
  }

  #connectionListeners = new Set<(phase: string, payload?: unknown) => void | Promise<void>>();

  onConnection(fn: (phase: string, payload?: unknown) => void | Promise<void>): () => void {
    this.#connectionListeners.add(fn);
    return () => this.#connectionListeners.delete(fn);
  }

  async #closeEvent(phase: string, payload?: unknown): Promise<void> {
    for (const fn of this.#connectionListeners) {
      try {
        await fn(phase, payload);
      } catch (err) {
        this.log.warn('connection listener failed', { err: (err as Error).message });
      }
    }
  }

  #tuning(): Partial<SocketTuning> {
    const ms = this.options.antiSpam;
    void ms;
    return {};
  }

  /* ── event passthrough ─────────────────────────────────────────── */

  on<T = unknown>(event: string, handler: (payload: T) => void): () => void {
    this.sock.ev.on(event as never, handler as never);
    return () => {
      this.sock.ev.off(event as never, handler as never);
    };
  }

  /**
   * The most recent pairing ref, or null if none has arrived.
   *
   * Retained because Baileys emits each ref roughly once per rotation. A UI that
   * subscribes after the fact — which an interactive prompt always does — would
   * otherwise wait for the next rotation before it had anything to draw.
   */
  get lastQr(): string | null {
    return this.#lastQr;
  }

  /** Resolves with the current ref, waiting for one if none has arrived yet. */
  async waitForQr(timeoutMs = 30_000): Promise<string> {
    const existing = this.#lastQr;
    if (existing) return existing;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => { off(); reject(new Error(`no pairing ref within ${timeoutMs}ms — is the session already linked?`)); },
        timeoutMs,
      );
      const off = this.on<{ qr?: string }>('connection.update', (u) => {
        if (!u.qr) return;
        clearTimeout(timer);
        off();
        resolve(u.qr);
      });
    });
  }

  get ev(): CoreSocket['ev'] {
    return this.sock.ev;
  }

  get user(): CoreSocket['user'] {
    return this.sock.user;
  }

  get connectionState(): { at: number; state: string } {
    return { ...this.#lastConnection };
  }

  /**
   * Last observed disconnect status code, if any socket has reported one.
   *
   * The reconnect plugin classifies closes from fields Baileys never sends, so
   * nothing else in the codebase can see a 401. This getter is the one place
   * that reads the real nested location, and being instance-level it stays true
   * across rebuilds when every event listener has been destroyed with its socket.
   */
  get lastDisconnectCode(): number | null {
    return this.#lastClose?.code ?? null;
  }

  /* ── teardown ──────────────────────────────────────────────────── */

  /** Unwind every patch and listener, then close the socket. */
  async dispose(): Promise<void> {
    this.#closed = true;
    try {
      this.sock?.end?.(undefined);
    } catch {
      /* socket may already be down */
    }
    this.#disposables.dispose();
    this.applied.length = 0;
    await this.#saver.drain();
    this.log.debug('disposed');
  }

  get patchCount(): number {
    return this.#disposables.size;
  }
}

/** Factory — one isolated instance per session number. */
export function createNyxBaileys(options: SuperOptions = {}): NyxBaileys {
  return new NyxBaileys(options);
}

export { NyxBaileys as SuperBaileys, createNyxBaileys as createSuperBaileys };

export default createNyxBaileys;