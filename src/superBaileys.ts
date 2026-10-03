import { DisconnectReason } from '@whiskeysockets/baileys';

import { Disposables, invariant } from './core/intercept.js';
import { createCoreSocket, resolveWebVersion, type SocketTuning } from './core/socket.js';
import { FileSessionStore } from './core/session-store.js';
import { createLogger } from './utils/logger.js';
import type { CoreSocket, Logger, Plugin, SuperOptions } from './utils/types.js';

import { antiSpam } from './plugins/antiSpam.js';
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

/**
 * Super Baileys.
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
export class SuperBaileys {
  readonly options: SuperOptions;
  readonly log: Logger;

  /** The live, decorated socket. */
  sock!: CoreSocket;

  /** Plugins that actually applied, in application order. */
  readonly applied: string[] = [];

  #disposables = new Disposables();
  #connecting: Promise<CoreSocket> | null = null;
  #closed = false;
  #lastConnection: { at: number; state: string } = { at: 0, state: 'never' };

  constructor(options: SuperOptions = {}) {
    this.options = options;
    this.log = createLogger(options.logLevel ?? 'info', 'super');
  }

  /* ── lifecycle ─────────────────────────────────────────────────── */

  /** Decorators, lowest order first. Override via `registerPlugin`. */
  protected plugins(): Plugin[] {
    return [
      stealth(),      // 10  identity + tuning
      lidRouter(),    // 20  target resolution
      mediaStreamer(),// 30  download path
      albumHandler(), // 40  incoming containers
      memoryGc(),     // 50  prune state
      groupGuard(),   // 60  admin policy
      sessionRepair(),// 70  message normaliser
      autoReconnect(), // 75  self-healing backoff
      antiSpam(),     // 80  pacing queue
      flowEngine(),   // 90  conversational routing
      warmup(),       // 100 rate ramp
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
    invariant(!this.#closed, 'this SuperBaileys instance was disposed');

    const store = this.options.sessionStore ?? new FileSessionStore({
      dir: this.options.sessionDir ?? './session',
      logger: this.log,
    });
    this.log.debug('session store', { name: store.name });

    const { state, saveCreds } = await store.init();
    await resolveWebVersion().catch(() => undefined);

    const tuning = this.#tuning();
    const sock = await createCoreSocket({
      state,
      saveCreds,
      options: this.options,
      tuning,
      log: this.log.child('socket'),
    });

    // The reconnect plugin asks the host to rebuild rather than swapping the
    // socket itself — one owner of the connect path.
    Object.defineProperty(sock, '__requestReconnect', {
      value: () => this.#rebuild(),
      enumerable: false,
      configurable: true,
    });

    this.sock = sock;
    await this.decorate({ sock, state, saveCreds });
    this.#wireConnection(sock);

    return sock;
  }

  /**
   * Rebuild the socket from persisted state.
   *
   * Unwinds every patch first so the new socket is decorated from a clean
   * object — no wrappers stacking on wrappers across a reconnect cycle.
   */
  async #rebuild(): Promise<boolean> {
    if (this.#closed) return false;
    if (this.#connecting) return true;

    this.log.info('rebuilding socket');
    this.#disposables.dispose();
    this.applied.length = 0;

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
    const state = ctx.state as { creds: unknown; keys: unknown };
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
        this.log.debug('plugin applied', { plugin: plugin.name });
      } catch (err) {
        // One bad plugin must not take the socket down with it.
        this.log.error('plugin failed to apply', {
          plugin: plugin.name,
          err: (err as Error).message,
        });
      }
    }
  }

  /** Watch connection state; hand disconnects to the reconnect plugin. */
  #wireConnection(sock: CoreSocket): void {
    sock.ev.on('connection.update', (update: { connection?: string }) => {
      const phase = update.connection;
      this.#lastConnection = { at: Date.now(), state: phase ?? 'unknown' };

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

  /**
   * Fan a connection event out to plugins. Plugins register here via
   * `onConnection` rather than touching the socket, so there is one owner of
   * the socket's `connection.update` listener.
   */
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

  get ev(): CoreSocket['ev'] {
    return this.sock.ev;
  }

  get user(): CoreSocket['user'] {
    return this.sock.user;
  }

  get connectionState(): { at: number; state: string } {
    return { ...this.#lastConnection };
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
    this.log.debug('disposed');
  }

  get patchCount(): number {
    return this.#disposables.size;
  }
}

/** Factory — one isolated instance per session number. */
export function createSuperBaileys(options: SuperOptions = {}): SuperBaileys {
  return new SuperBaileys(options);
}

export default createSuperBaileys;
