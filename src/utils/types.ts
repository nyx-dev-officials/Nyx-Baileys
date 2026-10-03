import type { WASocket } from '@whiskeysockets/baileys'

/**
 * Shared types.
 *
 * The one rule this framework holds: `sock` is always an upstream Baileys
 * socket. We decorate it, we never replace its type. Anything that can't be
 * expressed as a runtime wrapper lives behind an extension interface instead
 * of an `any` cast.
 */

/** The upstream socket, unmodified in type. */
export type CoreSocket = WASocket

/** A plugin receives the live socket and may wrap it. */
export interface Plugin {
  readonly name: string;
  /** Lower runs first. Keep patches ordered and composable. */
  readonly order: number;
  apply(ctx: PluginContext): void | Promise<void>;
}

export interface PluginContext {
  readonly sock: CoreSocket;
  /** Persisted auth state, so plugins can survive reconnects. */
  readonly state: SessionStore;
  readonly options: SuperOptions;
  readonly log: Logger;
  /** Register a disposer so `dispose()` can unwind every patch. */
  onDispose(fn: () => void): void;
}

/** What wraps a socket method: original first, then the call arguments. */
export type Wrapper<T extends (...args: never[]) => unknown> = (
  original: T,
  self: unknown,
  args: Parameters<T>,
) => unknown;

/** A socket with unpatched methods. */
export type AnyRecord = Record<string, unknown>;

/* ── session storage ────────────────────────────────────────────────── */

export interface SessionState {
  creds: unknown;
  keys: unknown;
}

export interface SessionStore {
  readonly name: string;
  init(): Promise<{ state: SessionState; saveCreds: () => Promise<void> }>;
  /** Free-form sidecar data (warm-up start, session id, …). May be async. */
  get<T>(key: string, fallback: T): T | Promise<T>;
  set(key: string, value: unknown): Promise<void>;
}

/* ── options ────────────────────────────────────────────────────────── */

export interface SuperOptions {
  /** Folder for the default file-backed session store. */
  sessionDir?: string;
  /** Bring your own store (Mongo, Postgres, Redis…). */
  sessionStore?: SessionStore;
  /** Sidecar store for plugin state. Defaults to the session store's dir. */
  dataDir?: string;

  /** Client fingerprint. Defaults to a desktop Chrome string. */
  browser?: readonly [string, string, string];

  /** Human-paced sending. */
  antiSpam?: Partial<AntiSpamOptions>;
  /** Days to ramp a freshly paired number up to full rate. 0 disables. */
  warmupDays?: number;
  /** Log verbosity. */
  logLevel?: 'silent' | 'error' | 'warn' | 'info' | 'debug';
  /** Let Baileys render the pairing QR in the terminal. */
  printQRInTerminal?: boolean;

  /** Per-JID state, so several numbers can share one process. */
  jid?: string;
}

export interface AntiSpamOptions {
  /** Minimum gap between outbound messages (ms). */
  minGapMs: number;
  /** Extra random gap added on top (ms). */
  jitterMs: number;
  /** Hard ceiling — messages per minute, regardless of the above. */
  maxPerMinute: number;
  /** Queue length before senders are rejected instead of queued. */
  maxQueue: number;
}

/* ── logging ────────────────────────────────────────────────────────── */

export interface Logger {
  error(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

/* ── health / reconnect ─────────────────────────────────────────────── */

export type HealthLevel = 'low' | 'elevated' | 'paused';

export interface HealthReport {
  level: HealthLevel;
  since: number;
  pausedFor: number;
  signals: {
    rateLimited: number;
    dead: number;
    server: number;
    ok: number;
  };
}