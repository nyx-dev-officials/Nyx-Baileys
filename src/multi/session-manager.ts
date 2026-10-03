import { join } from 'node:path';

import type { AnyMessageContent } from '@whiskeysockets/baileys';

import { NyxBaileys } from '../nyxBaileys.js';
import { createLogger } from '../utils/logger.js';
import type { CoreSocket, Logger, Plugin, SuperOptions } from '../utils/types.js';

/**
 * Multi-session fleet manager.
 *
 * One Node process, N independent WhatsApp accounts. Each `NyxBaileys` gets
 * its own socket, its own session directory, its own plugin instances and its
 * own logger scope, so a fault in one account cannot reach the others. This is
 * what turns the framework from "a single bot" into a fleet you can actually
 * operate: one dead account is restarted on its own, and the rest keep serving.
 *
 * Three properties this file exists to guarantee:
 *
 *  1. **Blast radius.** Every per-session operation is wrapped so a throw is
 *     recorded against that session and nowhere else. `broadcast()` reports
 *     per-session outcomes rather than throwing on the first failure — a batch
 *     where 40 of 50 delivered must not be reported as a failure.
 *  2. **Attribution.** Every session logs under its own id, and a crash records
 *     `lastError` on that session's record. When the process dies at 3am you
 *     need to know *which* account, without reading the whole log.
 *  3. **Self-healing.** A session that cannot reach `open` — because the socket
 *     wedged, or the reconnect plugin exhausted its backoff, or the process
 *     OOM'd — is torn down and rebuilt from persisted auth state, on a bounded
 *     backoff, one session at a time. Rebuilding is a cold start against the
 *     auth store, never an in-memory key transplant: transplanting Signal keys
 *     under a live socket desyncs the ratchet.
 *
 * A note on restarts and logout: if WhatsApp reports the account as logged out
 * (`last.isLoggedIn`), no amount of reconnecting helps — the number was unpaired
 * server-side and needs a human to scan a QR code. Restarting on that signal
 * produces an infinite loop that looks like a network problem and is not, so it
 * is reported as `failed` by default. Set `restartOnLogout` if your threat model
 * says otherwise.
 */

/** Lifecycle of one managed session. */
export type SessionStatus =
  /** Constructed, not yet connected. */
  | 'starting'
  /** Socket reached `open`. */
  | 'live'
  /** Being torn down and rebuilt after a failure. */
  | 'restarting'
  /** Given up; `lastError` says why. A human may be needed. */
  | 'failed'
  /** Removed or disposed. */
  | 'stopped';

/**
 * The surface the manager actually needs from a session.
 *
 * Narrow on purpose. `NyxBaileys` satisfies it structurally, and depending on
 * this instead of the concrete class is what lets the manager be driven by a
 * fake in tests without a network, and by an alternative host later. The event
 * passthroughs are included so a `SessionRecord` is genuinely useful to a
 * caller rather than a dead reference.
 */
export interface ManagedSession {
  readonly log: Logger;
  readonly sock: CoreSocket;
  connect(): Promise<CoreSocket>;
  dispose(): Promise<void>;
  onConnection(fn: (phase: string, payload?: unknown) => void | Promise<void>): () => void;
  registerPlugin(plugin: Plugin): unknown;
  /** Subscribe to a socket event. Returns an unsubscribe function. */
  on<T = unknown>(event: string, handler: (payload: T) => void): () => void;
  readonly ev: CoreSocket['ev'];
  readonly user: CoreSocket['user'];
}

/** Live view of one managed session. */
export interface SessionRecord {
  readonly id: string;
  readonly instance: ManagedSession;
  readonly sock: CoreSocket;
  /** Logger scoped to this session id. */
  readonly log: Logger;
  readonly status: SessionStatus;
  readonly createdAt: number;
  /** Target JID for broadcasts, if configured. */
  readonly jid: string | undefined;
  /** Successful restarts since creation. */
  restarts: number;
  lastConnectedAt: number;
  /** Last failure, for attribution after the fact. */
  lastError: { message: string; at: number } | undefined;
}

export interface RestartPolicy {
  /** First restart delay. Doubles each attempt, with jitter. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Give up after this many consecutive failures. 0 = never give up. */
  maxAttempts?: number;
  /**
   * How long a session may stay down before we stop trusting the reconnect
   * plugin and rebuild the instance ourselves. Defaults to 60s.
   */
  openTimeoutMs?: number;
}

export interface SessionManagerOptions {
  /** Hard cap on concurrently managed sessions. Default 16. */
  maxSessions?: number;
  /**
   * Root directory for per-session auth state. Each session gets
   * `<sessionRoot>/<id>`. Default `./session`.
   */
  sessionRoot?: string;
  /** Options applied to every session unless `create` overrides them. */
  defaultOptions?: SuperOptions;
  /** Extra plugins registered on every session. */
  plugins?: readonly Plugin[];
  restart?: RestartPolicy;
  /** Restart even when the account was logged out. Default false. */
  restartOnLogout?: boolean;
  logLevel?: 'silent' | 'error' | 'warn' | 'info' | 'debug';
  logger?: Logger;
  /**
   * How a session is constructed. Defaults to `new NyxBaileys(options)`.
   * The seam that lets the fleet be driven by a fake in tests, without a
   * network or a QR scan.
   */
  factory?: (options: SuperOptions) => ManagedSession;
}

export interface CreateSessionOptions extends SuperOptions {
  /** Plugins for this session only, appended to the manager's set. */
  plugins?: readonly Plugin[];
}

export interface BroadcastOptions {
  /** Send to this JID from every session. Overrides `to`. */
  jid?: string;
  /** Per-session target. A function returning undefined skips that session. */
  to?: string | ((record: SessionRecord) => string | undefined);
  /** Only broadcast to these session ids. */
  only?: readonly string[];
  /** Skip these session ids. */
  skip?: readonly string[];
  /** Build the full message content, for anything beyond plain text. */
  content?: (text: string, record: SessionRecord) => AnyMessageContent;
}

/** Per-session result. A failure here never affects another session. */
export interface BroadcastOutcome {
  id: string;
  ok: boolean;
  /** `not-live`: session had no socket. `no-target`: no JID to send to. */
  skipped?: 'not-live' | 'no-target';
  error?: string;
  messageId?: string;
}

export interface BroadcastReport {
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
  results: BroadcastOutcome[];
  durationMs: number;
}

/** Fleet-level events, for metrics and dashboards. */
export type FleetEvent =
  | { type: 'added'; id: string }
  | { type: 'removed'; id: string }
  | { type: 'status'; id: string; status: SessionStatus; error?: string };

export type FleetListener = (event: FleetEvent) => void;

/** Ids become directory names and log scopes, so they are untrusted input. */
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

function assertSafeId(id: string): string {
  if (!SAFE_ID.test(id) || id === '.' || id === '..') {
    throw new Error(
      `unsafe session id ${JSON.stringify(id)}: expected 1-128 chars of [A-Za-z0-9._-]`,
    );
  }
  return id;
}

/**
 * Re-scope an existing logger under a session id.
 *
 * `NyxBaileys` builds its own logger and exposes no injection point, and
 * adding one is not this file's call. Decorating the instance property instead
 * is exactly the technique this framework is built on, and it must happen
 * *before* `connect()` because the socket and plugin loggers are derived from
 * `this.log` at that point.
 */
function scopeLogger(log: Logger, id: string): Logger {
  const scoped: Logger = {
    error: (msg, meta) => log.error(`[${id}] ${msg}`, meta),
    warn: (msg, meta) => log.warn(`[${id}] ${msg}`, meta),
    info: (msg, meta) => log.info(`[${id}] ${msg}`, meta),
    debug: (msg, meta) => log.debug(`[${id}] ${msg}`, meta),
    child: () => scoped,
  };
  return scoped;
}

/** Everything the manager tracks privately for one session. */
interface SessionInternals {
  readonly id: string;
  options: CreateSessionOptions;
  log: Logger;
  status: SessionStatus;
  restarts: number;
  createdAt: number;
  lastConnectedAt: number;
  lastError: { message: string; at: number } | undefined;
  /** Consecutive restart attempts, reset on a successful `open`. */
  attempts: number;
  instance: ManagedSession;
  sock: CoreSocket;
  restartTimer: NodeJS.Timeout | null;
  watchdogTimer: NodeJS.Timeout | null;
  unsubscribe: (() => void) | null;
}

export class SessionManager {
  readonly #sessions = new Map<string, SessionInternals>();
  readonly #max: number;
  readonly #root: string;
  readonly #defaults: SuperOptions;
  readonly #plugins: readonly Plugin[];
  readonly #restart: Required<RestartPolicy>;
  readonly #restartOnLogout: boolean;
  readonly #log: Logger;
  readonly #factory: (options: SuperOptions) => ManagedSession;
  readonly #listeners = new Set<FleetListener>();

  constructor(options: SessionManagerOptions = {}) {
    this.#max = Math.max(1, Math.floor(options.maxSessions ?? 16));
    this.#root = options.sessionRoot ?? './session';
    this.#defaults = options.defaultOptions ?? {};
    this.#plugins = options.plugins ?? [];
    this.#restartOnLogout = options.restartOnLogout ?? false;
    this.#restart = {
      baseDelayMs: options.restart?.baseDelayMs ?? 1_000,
      maxDelayMs: options.restart?.maxDelayMs ?? 60_000,
      maxAttempts: Math.max(0, Math.floor(options.restart?.maxAttempts ?? 5)),
      openTimeoutMs: Math.max(1_000, Math.floor(options.restart?.openTimeoutMs ?? 60_000)),
    };
    this.#log = options.logger ?? createLogger(options.logLevel ?? 'info', 'fleet');
    this.#factory = options.factory ?? ((opts) => new NyxBaileys(opts));
  }

  /* ── fleet events ────────────────────────────────────────────────────── */

  /** Subscribe to lifecycle events. Returns an unsubscribe function. */
  on(listener: FleetListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #emit(event: FleetEvent): void {
    for (const listener of this.#listeners) {
      // A metrics sink must not be able to break session supervision.
      try {
        listener(event);
      } catch (err) {
        this.#log.warn('fleet listener threw', { err: (err as Error).message });
      }
    }
  }

  #setStatus(id: string, status: SessionStatus, error?: string): void {
    const session = this.#sessions.get(id);
    if (!session) return;
    session.status = status;
    if (error) session.lastError = { message: error, at: Date.now() };
    this.#emit({ type: 'status', id, status, ...(error ? { error } : {}) });
  }

  /* ── reads ───────────────────────────────────────────────────────────── */

  get(id: string): SessionRecord | undefined {
    const s = this.#sessions.get(id);
    return s ? this.#toRecord(s) : undefined;
  }

  /** Every managed session, ordered by id for stable output. */
  list(): SessionRecord[] {
    return [...this.#sessions.keys()]
      .sort()
      .map((id) => this.#toRecord(this.#sessions.get(id)!));
  }

  get size(): number {
    return this.#sessions.size;
  }

  get maxSessions(): number {
    return this.#max;
  }

  #toRecord(s: SessionInternals): SessionRecord {
    return {
      id: s.id,
      instance: s.instance,
      sock: s.sock,
      log: s.log,
      status: s.status,
      createdAt: s.createdAt,
      jid: s.options.jid,
      restarts: s.restarts,
      lastConnectedAt: s.lastConnectedAt,
      lastError: s.lastError,
    };
  }

  /* ── create ──────────────────────────────────────────────────────────── */

  /**
   * Create, connect, and start supervising one session.
   *
   * Throws if the id is taken, unsafe, or the fleet is at `maxSessions`. The
   * cap is enforced here rather than by evicting: silently disposing a running
   * account to make room for a new one is not a decision a library should make.
   */
  async create(id: string, options: CreateSessionOptions = {}): Promise<SessionRecord> {
    assertSafeId(id);

    if (this.#sessions.has(id)) {
      throw new Error(`session ${JSON.stringify(id)} already exists`);
    }
    if (this.#sessions.size >= this.#max) {
      throw new Error(
        `maxSessions reached (${this.#max}); remove a session before adding another`,
      );
    }

    const merged: CreateSessionOptions = { ...this.#defaults, ...options };
    const internals = this.#build(id, merged);

    // Register before connecting so a connect-time failure still lands in the
    // record and can be attributed, then roll back on failure.
    this.#sessions.set(id, internals);
    this.#emit({ type: 'added', id });

    try {
      await this.#connect(internals);
      return this.#toRecord(internals);
    } catch (err) {
      const message = (err as Error).message;
      await this.#teardown(internals);
      this.#sessions.delete(id);
      this.#emit({ type: 'removed', id });
      internals.log.error('initial connect failed', { err: message });
      throw err;
    }
  }

  /** Build the instance and wire supervision, without connecting. */
  #build(id: string, options: CreateSessionOptions): SessionInternals {
    const log = scopeLogger(this.#log, id);

    const instance = this.#factory({
      ...options,
      // Per-session auth directory: the single most important isolation
      // property here. Two accounts sharing one directory will fight over the
      // same creds file and both will be logged out.
      sessionDir: options.sessionDir ?? join(this.#root, id),
      jid: options.jid ?? id,
      logLevel: options.logLevel ?? 'info',
    });

    for (const plugin of [...this.#plugins, ...(options.plugins ?? [])]) {
      instance.registerPlugin(plugin);
    }

    // Must precede connect(): the socket and plugin loggers are derived from
    // `instance.log` when the socket is built.
    Object.defineProperty(instance, 'log', {
      value: log,
      enumerable: false,
      configurable: true,
      writable: true,
    });

    const internals: SessionInternals = {
      id,
      options,
      log,
      status: 'starting',
      restarts: 0,
      createdAt: Date.now(),
      lastConnectedAt: 0,
      lastError: undefined,
      attempts: 0,
      instance,
      sock: undefined as unknown as CoreSocket,
      restartTimer: null,
      watchdogTimer: null,
      unsubscribe: null,
    };

    internals.unsubscribe = instance.onConnection((phase, payload) => {
      // Connection events arrive on Baileys' emitter, which has no idea what a
      // rejected supervisor callback means — it would surface as an unhandled
      // rejection and take the process down. Swallow it into the record.
      void this.#onConnection(internals, phase, payload).catch((err: unknown) => {
        internals.log.error('connection handler failed', { err: (err as Error).message });
        this.#setStatus(internals.id, 'failed', (err as Error).message);
      });
    });

    return internals;
  }

  /** Connect the built instance and arm supervision. */
  async #connect(internals: SessionInternals): Promise<void> {
    await internals.instance.connect();
    internals.sock = internals.instance.sock;
    // `connect()` resolves before WhatsApp confirms the handshake, so status
    // stays `starting` until an `open` actually arrives.
    this.#armWatchdog(internals);
  }

  async #onConnection(
    internals: SessionInternals,
    phase: string,
    payload?: unknown,
  ): Promise<void> {
    const { id } = internals;

    if (phase === 'open') {
      this.#clearWatchdog(internals);
      internals.attempts = 0;
      internals.lastConnectedAt = Date.now();
      internals.lastError = undefined;
      this.#setStatus(id, 'live');
      internals.log.info('session live', { restarts: internals.restarts });
      return;
    }

    if (phase !== 'close') return;

    const detail = payload as { isLoggedIn?: boolean } | undefined;

    if (detail?.isLoggedIn === true) {
      // Server-side logout: needs a human, so do not spin.
      this.#setStatus(id, 'failed', 'logged out — re-pairing required');
      internals.log.error('account logged out; not restarting', {});
      if (this.#restartOnLogout) this.#scheduleRestart(internals, 'logged out');
      return;
    }

    this.#setStatus(id, 'restarting', 'connection closed');
    // The reconnect plugin rebuilds the socket in place. If it cannot get back
    // to `open` within the timeout, the session is wedged and we rebuild the
    // whole instance from the auth store.
    this.#armWatchdog(internals);
  }

  /* ── restart ─────────────────────────────────────────────────────────── */

  /** Rebuild one session now, from persisted auth state. */
  async restart(id: string): Promise<SessionRecord> {
    const internals = this.#sessions.get(id);
    if (!internals) throw new Error(`unknown session ${JSON.stringify(id)}`);

    this.#clearRestart(internals);
    await this.#teardown(internals);

    const replacement = this.#build(id, internals.options);
    // Carry the identity of the session forward; only the instance is new.
    replacement.createdAt = internals.createdAt;
    replacement.restarts = internals.restarts + 1;
    replacement.attempts = internals.attempts;
    replacement.lastConnectedAt = internals.lastConnectedAt;
    replacement.lastError = internals.lastError;
    this.#sessions.set(id, replacement);
    this.#setStatus(id, 'restarting');

    try {
      await this.#connect(replacement);
      return this.#toRecord(replacement);
    } catch (err) {
      const message = (err as Error).message;
      replacement.log.error('restart failed', { err: message });
      this.#setStatus(id, 'failed', message);
      this.#scheduleRestart(replacement, message);
      return this.#toRecord(replacement);
    }
  }

  /** Exponential backoff with jitter, bounded by `maxAttempts`. */
  #scheduleRestart(internals: SessionInternals, reason: string): void {
    const { id } = internals;

    if (internals.restartTimer) return;
    if (this.#restart.maxAttempts > 0 && internals.attempts >= this.#restart.maxAttempts) {
      this.#setStatus(id, 'failed', `${reason} — restart budget exhausted`);
      internals.log.error('restart budget exhausted; manual intervention needed', {
        attempts: internals.attempts,
      });
      return;
    }

    internals.attempts += 1;
    const ceiling = Math.min(this.#restart.maxDelayMs, this.#restart.baseDelayMs * 2 ** internals.attempts);
    // Full jitter: without it, N sessions dropped by one network blip come
    // back in lockstep and knock the account over again.
    const delay = Math.floor(Math.random() * ceiling);

    internals.log.warn('scheduling restart', { attempt: internals.attempts, delayMs: delay, reason });

    const timer = setTimeout(() => {
      internals.restartTimer = null;
      void this.restart(id).catch((err: unknown) => {
        internals.log.error('restart invocation failed', { err: (err as Error).message });
        this.#scheduleRestart(internals, (err as Error).message);
      });
    }, delay);
    timer.unref?.();
    internals.restartTimer = timer;
  }

  /** Rebuild the instance if the socket has not returned to `open` in time. */
  #armWatchdog(internals: SessionInternals): void {
    const { id } = internals;

    this.#clearWatchdog(internals);
    const timer = setTimeout(() => {
      internals.watchdogTimer = null;
      // Re-read: `open` may have arrived and been cleared already.
      const current = this.#sessions.get(id);
      if (!current || current.status === 'live') return;
      current.log.warn('session did not return to open; rebuilding instance', {
        timeoutMs: this.#restart.openTimeoutMs,
      });
      void this.restart(id).catch((err: unknown) => {
        current.log.error('watchdog restart failed', { err: (err as Error).message });
        this.#scheduleRestart(current, (err as Error).message);
      });
    }, this.#restart.openTimeoutMs);
    timer.unref?.();
    internals.watchdogTimer = timer;
  }

  #clearWatchdog(internals: SessionInternals): void {
    if (internals.watchdogTimer) {
      clearTimeout(internals.watchdogTimer);
      internals.watchdogTimer = null;
    }
  }

  #clearRestart(internals: SessionInternals): void {
    if (internals.restartTimer) {
      clearTimeout(internals.restartTimer);
      internals.restartTimer = null;
    }
  }

  /* ── remove / dispose ────────────────────────────────────────────────── */

  /** Dispose one session and stop supervising it. Idempotent. */
  async remove(id: string): Promise<boolean> {
    const internals = this.#sessions.get(id);
    if (!internals) return false;

    await this.#teardown(internals);
    this.#sessions.delete(id);
    internals.log.info('session removed', {});
    this.#emit({ type: 'removed', id });
    return true;
  }

  /** Dispose every session. Never rejects; one failure cannot strand the rest. */
  async disposeAll(): Promise<void> {
    const all = [...this.#sessions.entries()];
    // Clear the map first: a concurrent `create()` during teardown must not be
    // able to observe a half-disposed session.
    this.#sessions.clear();

    const results = await Promise.allSettled(all.map(([, s]) => this.#teardown(s)));

    results.forEach((result, index) => {
      const entry = all[index];
      if (!entry) return;
      const [id] = entry;
      if (result.status === 'rejected') {
        this.#log.error('session dispose failed', { id, err: (result.reason as Error).message });
      }
      this.#emit({ type: 'removed', id });
    });
  }

  /** Stop timers, unsubscribe, and dispose the instance. */
  async #teardown(internals: SessionInternals): Promise<void> {
    this.#clearRestart(internals);
    this.#clearWatchdog(internals);

    try {
      internals.unsubscribe?.();
    } catch {
      /* listener set may already be gone */
    }
    internals.unsubscribe = null;

    try {
      await internals.instance.dispose();
    } catch (err) {
      internals.log.warn('dispose threw', { err: (err as Error).message });
    }
    internals.status = 'stopped';
  }

  /* ── broadcast ───────────────────────────────────────────────────────── */

  /**
   * Fan a message out to every session.
   *
   * Deliberately never throws for a per-session failure. The interesting
   * operational case is a partial fan-out, and collapsing that into a single
   * rejected promise destroys the information needed to act on it — so the
   * caller gets a report naming every session that failed and why.
   */
  async broadcast(text: string, options: BroadcastOptions = {}): Promise<BroadcastReport> {
    const startedAt = Date.now();
    const targets = [...this.#sessions.entries()]
      .filter(([id]) => !options.skip?.includes(id))
      .filter(([id]) => !options.only || options.only.includes(id));

    const results = await Promise.all(
      targets.map(([id, session]) => this.#sendTo(id, session, text, options)),
    );

    const report: BroadcastReport = {
      attempted: results.length,
      sent: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok && !r.skipped).length,
      skipped: results.filter((r) => r.skipped !== undefined).length,
      results,
      durationMs: Date.now() - startedAt,
    };
    return report;
  }

  /** One session's slice of a broadcast. Never throws. */
  async #sendTo(
    id: string,
    internals: SessionInternals,
    text: string,
    options: BroadcastOptions,
  ): Promise<BroadcastOutcome> {
    try {
      const sock = internals.sock ?? internals.instance.sock;
      if (!sock) return { id, ok: false, skipped: 'not-live' };

      const to = options.jid
        ?? (typeof options.to === 'function' ? options.to(this.#toRecord(internals)) : options.to);
      const target = to ?? internals.options.jid;
      if (!target) return { id, ok: false, skipped: 'no-target' };

      const content = options.content
        ? options.content(text, this.#toRecord(internals))
        : ({ text } as AnyMessageContent);

      const sent = (await sock.sendMessage(target, content)) as unknown as
        | { key?: { id?: string | null } | null }
        | undefined;

      const messageId = sent?.key?.id ?? undefined;
      return { id, ok: true, ...(messageId ? { messageId } : {}) };
    } catch (err) {
      const message = (err as Error).message;
      internals.log.warn('broadcast to session failed', { err: message });
      return { id, ok: false, error: message };
    }
  }
}

/** Factory, mirroring `createNyxBaileys`. */
export function createSessionManager(options: SessionManagerOptions = {}): SessionManager {
  return new SessionManager(options);
}

export default SessionManager;