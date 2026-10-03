import makeWASocket, { fetchLatestWaWebVersion } from '@whiskeysockets/baileys';

import type { CoreSocket, Logger, SuperOptions } from '../utils/types.js';

/**
 * Desktop Chrome fingerprint — the default identity.
 *
 * This is a *consistent* fingerprint, not a randomised one. Baileys already
 * sends a desktop profile; the only thing that matters is that the tuple is a
 * real, internally-consistent Chrome-on-Windows combination and stays constant
 * for the life of the socket. Churning it per connection is what looks
 * anomalous, because one browser does not change OS mid-session.
 */
export const DEFAULT_BROWSER: readonly [string, string, string] = [
  'Chrome',
  '120',
  '0',
];

/** WebSocket + keepalive tuning. Conservative defaults, high maxPayload. */
export interface SocketTuning {
  connectTimeoutMs: number;
  keepAliveIntervalMs: number;
  /** Large media rides through this; this is the client-side ceiling. */
  maxPayload: number;
  /** Marked false because every caller in this repo handles its own retries. */
  retryRequestDelayMs: number;
  /** Reject self-signed endpoints. Only disable behind a trusted proxy. */
  rejectUnauthorized: boolean;
}

export const DEFAULT_TUNING: SocketTuning = {
  connectTimeoutMs: 20_000,
  keepAliveIntervalMs: 30_000,
  maxPayload: 64 * 1024 * 1024,
  retryRequestDelayMs: 0,
  rejectUnauthorized: true,
};

/**
 * Version negotiation. Waits for WhatsApp's endpoint so the socket always
 * speaks the current web protocol rather than a pinned older one.
 */
export async function resolveWebVersion(timeoutMs = 8_000): Promise<[number, number, number]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // rc14 returns `{ version, isLatest }` rather than a bare tuple.
      const result = await fetchLatestWaWebVersion({ signal: controller.signal });
      const version = result?.version;
      if (Array.isArray(version) && version.length === 3) return version as [number, number, number];
    } finally {
      clearTimeout(timer);
    }
  } catch {
    /* fall through to the pinned default */
  }
  return [2, 3000, 1027565938];
}

/** Baileys' logger contract, declared locally — it is not exported from the package root. */
interface BaileysLogger {
  level: string;
  child(obj: Record<string, unknown>): BaileysLogger;
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/**
 * Bridge our `Logger` onto Baileys' logger contract.
 *
 * This must be a real object. rc14 calls `logger.warn(...)` unconditionally at
 * socket construction (`Socket/socket.js:28`) and `logger.child(...)` from the
 * noise handler, so passing `undefined` makes `makeWASocket` throw before a
 * connection is ever attempted. Baileys' signature is `(obj, msg?)`; ours is
 * `(msg, meta?)`, so the arguments are re-ordered rather than spread.
 */
function toBaileysLogger(log: Logger): BaileysLogger {
  const adapt =
    (kind: 'error' | 'warn' | 'info' | 'debug') =>
    (obj: unknown, msg?: string): void => {
      const meta =
        obj && typeof obj === 'object' && !Array.isArray(obj)
          ? (obj as Record<string, unknown>)
          : msg === undefined && typeof obj === 'string'
            ? undefined
            : undefined;
      const text =
        typeof obj === 'string' && msg !== undefined ? msg : typeof obj === 'string' ? obj : (msg ?? '');
      log[kind](text, meta);
    };

  return {
    level: 'warn',
    trace: () => {},
    debug: adapt('debug'),
    info: adapt('info'),
    warn: adapt('warn'),
    error: adapt('error'),
    child: () => toBaileysLogger(log.child('baileys')),
  };
}

export interface CreateSocketArgs {
  state: { creds: unknown; keys: unknown };
  saveCreds: () => Promise<void>;
  options: SuperOptions;
  tuning?: Partial<SocketTuning>;
  log: Logger;
  /** Let Baileys render the pairing QR itself. */
  printQRInTerminal?: boolean;
}

/**
 * The upstream engine, unmodified. Everything downstream decorates the object
 * this returns; nothing here is Nyx-Baileys-specific except tuning knobs.
 */
export async function createCoreSocket(args: CreateSocketArgs): Promise<CoreSocket> {
  const { state, saveCreds, options, log, tuning = {}, printQRInTerminal = true } = args;
  const t: SocketTuning = { ...DEFAULT_TUNING, ...tuning };
  const browser = options.browser ?? DEFAULT_BROWSER;

  log.debug('creating socket', { browser, maxPayload: t.maxPayload });

  const sock = makeWASocket({
    auth: state as never,
    logger: toBaileysLogger(log) as never,
    printQRInTerminal,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: true,
    browser: browser as unknown as [string, string, string],
    getMessage: async () => undefined,
    cachedGroupMetadata: async () => undefined,
    connectTimeoutMs: t.connectTimeoutMs,
    keepAliveIntervalMs: t.keepAliveIntervalMs,
    maxPayload: t.maxPayload,
    retryRequestDelayMs: t.retryRequestDelayMs,
    emitOwnEvents: true,
    defaultQueryTimeoutMs: 30_000,
    authTimeoutMs: 20_000,
  } as Parameters<typeof makeWASocket>[0]);

  void saveCreds; // wired by the host, see NyxBaileys

  // Persist credentials. rc14 emits `creds.update` from many places and does not
  // write anything itself — without this listener a paired session is lost on
  // every restart and the number has to re-pair each time.
  sock.ev.on('creds.update', () => {
    saveCreds().catch((err: unknown) => {
      log.error('creds save failed', { err: (err as Error).message });
    });
  });

  return sock as CoreSocket;
}

/** Chrome UA string matching the fingerprint tuple. */
export function desktopUserAgent(browser: readonly [string, string, string] = DEFAULT_BROWSER): string {
  const [engine, version] = browser;
  return (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    `(KHTML, like Gecko) ${engine}/${version}.0.0.0 Safari/537.36`
  );
}
