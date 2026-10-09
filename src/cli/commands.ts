/**
 * Commands for the Nyx-Baileys CLI.
 *
 * One rule across all of them: a command either reports what actually happened
 * or it fails. Nothing here prints a success line for work it did not do, and
 * nothing swallows an error to keep an exit code tidy.
 *
 * Exit codes are the contract (see `EXIT`):
 *
 *   0  ok
 *   1  usage error — thrown as {@link UsageError} by the parser
 *   2  connection or session failure
 *   3  not paired
 *
 * Every command that opens a socket registers its disposer on the shared
 * {@link Lifecycle}, so Ctrl-C unwinds patches and closes the socket before the
 * process exits. A killed process that leaves the socket open can leave the
 * saved Signal key state half-written, which costs the user a re-pair.
 */

import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve as resolvePath } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { DisconnectReason } from '@whiskeysockets/baileys';

import { createFormFlow, infoRow, radioRow } from '../core/nodes.js';
import { renderIntro, codeFrame } from './intro.js';
import { moderation } from '../plugins/moderation.js';
import { welcome } from '../plugins/welcome.js';
import { FileSessionStore } from '../core/session-store.js';
import { createNyxBaileys } from '../nyxBaileys.js';
import {
  UsageError,
  flagBool,
  flagList,
  flagNumber,
  flagString,
  type CommandSpec,
  type FlagSpec,
  type ParsedArgs,
} from './args.js';
import { formatAgo, formatBytes, formatDuration, Reporter } from './output.js';
import type { NyxBaileys } from '../nyxBaileys.js';
import type { LogLevel } from '../utils/logger.js';
import type { CoreSocket, HealthReport } from '../utils/types.js';

/* ── exit codes ───────────────────────────────────────────────────── */

export const EXIT = {
  ok: 0,
  usage: 1,
  failure: 2,
  notPaired: 3,
  interrupted: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** A failure with a machine-readable code and a next step for the user. */
export class CliError extends Error {
  readonly code: ExitCode;
  readonly next: string | undefined;

  constructor(code: ExitCode, message: string, next?: string) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.next = next;
  }
}

/* ── environment ──────────────────────────────────────────────────── */

export interface CliEnv {
  /**
   * Session directory. Not readonly because an interactive pairing may switch to
   * a different one when the current directory already holds another account —
   * silently pairing a second number over the first would destroy a session.
   */
  sessionDir: string;
  readonly logLevel: LogLevel;
  /** True when the user set the level rather than inheriting the default. */
  readonly logLevelExplicit: boolean;
  readonly json: boolean;
  readonly cwd: string;
  /** Applied to commands that open a socket, unless they override it. */
  readonly connectTimeoutMs: number;
}

const LOG_LEVELS: readonly LogLevel[] = ['silent', 'error', 'warn', 'info', 'debug'];

export function parseLogLevel(raw: string | undefined, fallback: LogLevel): LogLevel {
  const value = (raw ?? '').toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(value) ? (value as LogLevel) : fallback;
}

/* ── lifecycle ────────────────────────────────────────────────────── */

/** Disposers in reverse order, so the socket unwinds before its store. */
export class Lifecycle {
  readonly #disposers: (() => void | Promise<void>)[] = [];
  #closed = false;

  add(disposer: () => void | Promise<void>): void {
    this.#disposers.push(disposer);
  }

  get size(): number {
    return this.#disposers.length;
  }

  async dispose(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const pending = this.#disposers.splice(0).reverse();
    for (const disposer of pending) {
      try {
        await disposer();
      } catch {
        // Teardown is best effort; one failed disposer must not strand the rest.
      }
    }
  }
}

/* ── command plumbing ─────────────────────────────────────────────── */

export interface CommandContext {
  readonly args: ParsedArgs;
  readonly io: Reporter;
  readonly env: CliEnv;
  readonly lifecycle: Lifecycle;
}

export type Command = (ctx: CommandContext) => Promise<ExitCode>;

/* ── socket extensions ────────────────────────────────────────────── */

/**
 * Runtime decorations the plugins attach to the socket.
 *
 * The framework's own rule applies: plugins define the extension, the host
 * casts to it. Declaring the shapes here keeps every access typed and
 * documented instead of scattered through the commands.
 */
interface MemoryStats {
  chats: number;
  media: number;
  statuses: number;
  heapMb: number;
}

interface PacingStats {
  queued: number;
  sent: number;
  pressure: number;
}

interface SocketIdentity {
  browser: readonly string[];
  userAgent: string;
}

interface SocketExtensions {
  readonly resolveJid?: (target: string) => Promise<string>;
  readonly resolvePn?: (target: string) => Promise<string>;
  readonly store?: { stats: () => MemoryStats };
  readonly health?: () => HealthReport;
  readonly __antispam?: { stats: () => PacingStats };
  readonly __identity?: SocketIdentity;
}

function extensions(client: NyxBaileys): SocketExtensions {
  return client.sock as unknown as SocketExtensions;
}

/* ── session files ────────────────────────────────────────────────── */

interface CredsFile {
  registered?: boolean;
  me?: { id?: string; name?: string } | null;
  /** Handshake material. Only meaningful on a file that never reached `registered`. */
  pairingCode?: string;
  pairingEphemeralKeyPair?: { registered?: boolean };
  signedIdentityKey?: unknown;
  /** Present once WhatsApp has signed this device. */
  account?: { deviceSignature?: string; accountSignature?: string; details?: string };
  routingInfo?: unknown;
}

/**
 * Has WhatsApp actually provisioned this device?
 *
 * `registered` alone is not trustworthy. Baileys sets that flag in exactly one
 * place — the `companion_finish` branch of `messages-recv.js:940` — and on
 * rc14 that notification does not arrive. A device can be fully provisioned and
 * working while the flag reads `false`:
 *
 *   account.details + accountSignature + deviceSignature   ← WhatsApp signed it
 *   me.id, me.lid, routingInfo, platform                   ← it is fully linked
 *   registered: false                                      ← the flag never flipped
 *
 * Verified on 2026-10-04: such a session connects, logs in, passes pre-key
 * validation, reaches Online and reports its own jid — while `status` called it
 * unpaired and every socket-dependent command refused to run.
 *
 * So `paired` is derived from the provisioned state, not the flag. The flag is a
 * client-side bookkeeping detail; the signature is WhatsApp's own statement.
 */
export function isProvisioned(creds: Partial<CredsFile>): boolean {
  if (creds.registered === true) return true;
  return Boolean(creds.me?.id && creds.account?.deviceSignature);
}

/**
 * Handshake material sitting in a creds.json that never reached `registered`.
 *
 * Its presence is the entire diagnosis. A session without it is simply fresh and
 * pairs normally; a session carrying it has a half-negotiated identity that
 * WhatsApp rejects with 401 on every connect, forever. There is no resume and no
 * retry — the file has to go.
 *
 * A `registered` file always reports empty even if it still carries a stale
 * `pairingCode`, because a working session is not a broken one. That check lives
 * here rather than at the call site so no future caller can forget it.
 */
export function partialArtifacts(creds: Partial<CredsFile>): string[] {
  // A provisioned device is not a broken one, whatever the flag says. Without
  // this a working session trips the half-finished-pairing guard on every run.
  if (isProvisioned(creds)) return [];
  const found: string[] = [];
  if (typeof creds.pairingCode === 'string' && creds.pairingCode.length > 0) found.push('pairingCode');
  if (creds.pairingEphemeralKeyPair) found.push('pairingEphemeralKeyPair');
  if (creds.signedIdentityKey) found.push('signedIdentityKey');
  return found;
}

/**
 * Write `registered: true` into a creds.json whose device is provisioned but
 * whose flag never got set.
 *
 * rc14 sets that flag in exactly one place — the `companion_finish` branch of
 * `messages-recv.js:940` — and that notification does not arrive on this path. So
 * a session that paired perfectly still reports itself unpaired, and every
 * socket-dependent command refuses it. `isProvisioned()` works around that by
 * reading the evidence instead of the flag, but the flag is what the rest of the
 * ecosystem reads — including upstream itself — so it is worth correcting once,
 * at the moment we know the pairing succeeded.
 *
 * Only acts on a *provisioned* device. A fresh session has no `me.id` and no
 * device signature, so this is a no-op until WhatsApp has genuinely signed it.
 * Returns what it did so the caller can say so rather than implying it.
 */
export async function healRegisteredFlag(dir: string): Promise<{ healed: boolean; jid: string | null }> {
  const file = join(resolvePath(dir), 'creds.json');
  const creds = await readCreds(dir);
  if (!creds) return { healed: false, jid: null };
  if (creds.registered === true) return { healed: false, jid: creds.me?.id ?? null };
  if (!isProvisioned(creds)) return { healed: false, jid: null };

  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    parsed.registered = true;
    await writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    return { healed: true, jid: (parsed.me as { id?: string } | undefined)?.id ?? null };
  } catch (err) {
    // A failed heal is not a failed pairing. The session still works through
    // isProvisioned(), so this must never turn a good result into an error.
    process.stderr.write(`note: could not correct the registered flag: ${messageOf(err)}\n`);
    return { healed: false, jid: null };
  }
}

interface SessionRecord {
  readonly name: string;
  readonly path: string;
  readonly exists: boolean;
  readonly registered: boolean;
  /** Non-empty when the session is a half-finished pairing. See {@link partialArtifacts}. */
  readonly partial: readonly string[];
  readonly jid: string | null;
  readonly pushName: string | null;
  readonly files: number;
  readonly bytes: number;
  readonly modified: number;
  readonly modifiedIso: string | null;
}

async function readCreds(dir: string): Promise<CredsFile | null> {
  try {
    const raw = await readFile(join(dir, 'creds.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as CredsFile) : null;
  } catch {
    return null;
  }
}

/** Walk a session directory. Bounded so a stray mount cannot hang the CLI. */
async function measureDir(dir: string, maxEntries = 20_000): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const queue: string[] = [dir];

  while (queue.length > 0 && files < maxEntries) {
    const current = queue.pop();
    if (current === undefined) break;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files >= maxEntries) break;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      files += 1;
      try {
        bytes += (await stat(full)).size;
      } catch {
        // A file that vanished mid-walk does not change the answer materially.
      }
    }
  }

  return { files, bytes };
}

async function readSession(dir: string, name?: string): Promise<SessionRecord> {
  const absolute = resolvePath(dir);
  let exists = true;
  let modified = 0;
  try {
    modified = (await stat(absolute)).mtimeMs;
  } catch {
    exists = false;
  }

  const creds = await readCreds(absolute);
  const size = exists ? await measureDir(absolute) : { files: 0, bytes: 0 };

  return {
    name: name ?? absolute.split(/[\\/]/).filter(Boolean).pop() ?? absolute,
    path: absolute,
    exists,
    registered: creds ? isProvisioned(creds) : false,
    partial: creds ? partialArtifacts(creds) : [],
    jid: creds?.me?.id ?? null,
    pushName: creds?.me?.name ?? null,
    files: size.files,
    bytes: size.bytes,
    modified,
    modifiedIso: modified ? new Date(modified).toISOString() : null,
  };
}

function sessionSummary(record: SessionRecord): Record<string, unknown> {
  return {
    name: record.name,
    dir: record.path,
    exists: record.exists,
    paired: record.registered,
    partial: [...record.partial],
    number: record.jid,
    pushName: record.pushName,
    files: record.files,
    bytes: record.bytes,
    size: formatBytes(record.bytes),
    modifiedAt: record.modifiedIso,
    modifiedAgo: formatAgo(record.modified),
  };
}

/** Every session directory under `root`, or `[]` when there are none. */
async function discoverSessions(root: string): Promise<{ root: string; exists: boolean; sessions: SessionRecord[] }> {
  const absolute = resolvePath(root);
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch {
    return { root: absolute, exists: false, sessions: [] };
  }

  // The root may itself be one session, or a folder of them.
  if (entries.some((entry) => entry.isFile() && entry.name === 'creds.json')) {
    return { root: absolute, exists: true, sessions: [await readSession(absolute, absolute.split(/[\\/]/).pop() ?? 'session')] };
  }

  const sessions: SessionRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(absolute, entry.name);
    if ((await readCreds(dir)) === null) continue;
    sessions.push(await readSession(dir, entry.name));
  }
  sessions.sort((a, b) => a.name.localeCompare(b.name));
  return { root: absolute, exists: true, sessions };
}

/** Gate for every command that needs credentials. */
async function requirePaired(env: CliEnv): Promise<SessionRecord> {
  const record = await readSession(env.sessionDir);
  if (record.registered) return record;
  throw new CliError(
    EXIT.notPaired,
    `no paired session in ${record.path}`,
    `run \`nyx-baileys pair\` to scan a QR code, or \`--dir\` to point at the right session`,
  );
}

/* ── socket helpers ───────────────────────────────────────────────── */

interface OpenOptions {
  readonly timeoutMs: number;
  /** Print the QR when no credentials exist. Only `pair` wants this. */
  readonly printQR?: boolean;
}

/**
 * Open a socket and wait for the connection to report `open`.
 *
 * Returns the client even when the socket never opens, so the caller can report
 * what state it did reach instead of a bare "timed out".
 */
async function openSocket(ctx: CommandContext, options: OpenOptions): Promise<{ client: NyxBaileys; open: boolean }> {
  const client = createNyxBaileys({
    sessionDir: ctx.env.sessionDir,
    logLevel: ctx.env.logLevel,
    printQRInTerminal: options.printQR ?? true,
  });
  ctx.lifecycle.add(async () => {
    await client.dispose();
  });

  try {
    await client.connect();
  } catch (err) {
const diagnosis = diagnoseConnectError(err);
    throw new CliError(EXIT.failure, diagnosis.message, diagnosis.next);
  }

  const open = await waitForOpen(client, options.timeoutMs);
  if (!open) {
    throw new CliError(
      EXIT.failure,
      `socket did not open within ${formatDuration(options.timeoutMs)} (state: ${client.connectionState.state})`,
      'retry; WhatsApp may be rate limiting this number',
    );
  }
  return { client, open };
}

function waitForOpen(client: NyxBaileys, timeoutMs: number): Promise<boolean> {
  if (client.connectionState.state === 'open') return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    const settle = (opened: boolean): void => {
      clearInterval(poll);
      clearTimeout(deadline);
      resolve(opened);
    };
    const poll = setInterval(() => {
      if (client.connectionState.state === 'open') settle(true);
    }, 250);
    poll.unref?.();
    const deadline = setTimeout(() => settle(false), timeoutMs);
    deadline.unref?.();
  });
}

/**
 * Wait until the socket can take a request.
 *
 * `connection === 'open'` is the documented signal and the right one for a paired
 * session. It never fires on an *unregistered* one, because auth has not
 * completed and there is nothing to be open *to*. Measured against rc14: the
 * socket logs `connected to WA` at ~1.5s, a `connection.update` carrying a `qr`
 * arrives at ~1.9s, and `connection` is still unset at 45s.
 *
 * So a QR counts as ready. It is the proof that the websocket is up *and* the
 * noise handshake finished, which is precisely the precondition
 * `requestPairingCode` fails without — Boom 428 'Connection Closed'. Waiting for
 * `open` instead means never issuing the request at all.
 */
function waitForReady(
  client: NyxBaileys,
  timeoutMs: number,
  pairing: Pairing,
  io: Reporter,
): Promise<boolean> {
  if (client.connectionState.state === 'open') return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    let offUpdate: (() => void) | null = null;
    let offConnection: (() => void) | null = null;

    const settle = (ready: boolean): void => {
      clearTimeout(deadline);
      offUpdate?.();
      offConnection?.();
      resolve(ready);
    };

    offUpdate = client.on('connection.update', (update: ConnectionUpdate) => {
      if (update.qr) {
        // Only announce a ref that is actually new. The QR rotates every ~20s and
        // `cmdPair` holds its own capture listener, so an unconditional announce
        // here would reprint a ref the operator has already read.
        if (update.qr !== pairing.qr) {
          pairing.qr = update.qr;
          announcePairing(io, pairing);
        }
      }
      if (update.connection === 'open' || update.qr) settle(true);
    });
    // A close before readiness is terminal — reconnect may try again, but this
    // command is not going to sit through a backoff ladder waiting for it.
    offConnection = client.onConnection((phase) => {
      if (phase === 'close') settle(false);
    });

    const deadline = setTimeout(() => settle(false), timeoutMs);
    deadline.unref?.();
  });
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}
/**
 * Name the real cause of a socket that would not open.
 *
 * Baileys rc14 calls `logger.warn` unconditionally, so a socket built with an
 * undefined logger throws a TypeError whose message says nothing useful. Saying
 * "check the network" there would send the user somewhere useless, so the known
 * signature is recognised and reported with the file that causes it.
 */
function diagnoseConnectError(err: unknown): { message: string; next: string } {
  const message = messageOf(err);

  if (/reading '(warn|log|info|error|debug)'/.test(message) || /\blogger\b/i.test(message)) {
    return {
      message: `the socket could not be created: ${message}`,
      next: 'src/core/socket.ts passes `logger: undefined` to makeWASocket, and Baileys rc14 calls logger.warn on every socket — pass a real logger there',
    };
  }

  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|getaddrinfo/i.test(message)) {
    return {
      message: `the socket could not reach WhatsApp: ${message}`,
      next: 'check the network and any proxy, then retry',
    };
  }

  return {
    message: `could not open a socket: ${message}`,
    next: 're-run with --level debug for the framework log behind this',
  };
}

/** Connection payload fields this CLI reads. rc14 moves the QR here. */
interface ConnectionUpdate {
  connection?: string;
  qr?: string;
  pairingCode?: string;
}

/**
 * A recipient as a jid.
 *
 * `send` and `form` both document a bare number as valid, but nothing normalised
 * one. The lid router returns non-jid input unchanged (`src/plugins/lid.ts:68`),
 * so the raw digits reached `sendMessage`, whose `jidDecode` returns `undefined`
 * for them — surfacing as
 * `Cannot destructure property 'user' of 'jidDecode(...)' as it is undefined`,
 * which names neither the number nor the cause.
 *
 * Anything already carrying an `@` — a group id, a `@lid`, a device jid — is
 * passed through untouched. Only bare digits are rewritten.
 */
export function toRecipientJid(target: string): string {
  const trimmed = target.trim();
  if (!trimmed || trimmed.includes('@')) return trimmed;
  const digits = trimmed.replace(/\D/g, '');
  return digits ? `${digits}@s.whatsapp.net` : trimmed;
}

/** Send through the framework's own resolution path so `@lid` works. */
async function sendText(client: NyxBaileys, target: string, text: string): Promise<{ target: string; id: string | undefined; timestamp: number | undefined }> {
  const ext = extensions(client);
  const wanted = toRecipientJid(target);
  const resolved = (await ext.resolveJid?.(wanted)) ?? wanted;
  const sent = await client.sock.sendMessage(resolved, { text });
  return {
    target: resolved,
    id: sent?.key?.id ?? undefined,
    timestamp: typeof sent?.messageTimestamp === 'number' ? sent.messageTimestamp : undefined,
  };
}

/* ── command: pair ────────────────────────────────────────────────── */

const pairSpec: CommandSpec = {
  name: 'pair',
  summary: 'Pair a number by QR scan, or by typing an 8-character phone code.',
  positionals: [],
  flags: [
    { name: 'phone', kind: 'string', placeholder: '<number>', describe: 'Number to send the pairing code to, in international form' },
    { name: 'reset', kind: 'boolean', describe: 'Clear a half-finished pairing in the session directory before pairing' },
    { name: 'timeout', kind: 'number', default: 180, placeholder: '<seconds>', describe: 'How long to wait for the pairing to complete' },
    { name: 'connect-timeout', kind: 'number', default: 60, placeholder: '<seconds>', describe: 'How long to wait for the socket to open' },
  ],
  examples: [
    'nyx-baileys pair --phone 6283831459585',
    'nyx-baileys pair',
    'nyx-baileys pair --dir ./session --timeout 300',
    'nyx-baileys pair --dir ./session --reset',
  ],
  notes: [
    'WhatsApp → Linked devices → Link a device, then type the code or scan the QR.',
    'rc14 removed terminal QR rendering, so --phone is the only path that works without a camera. The QR ref is still printed when --phone is absent.',
    'A pairing code expires in roughly 30 seconds — have the phone open before requesting one.',
    'Already paired? This command says so and changes nothing. To pair a different number, run `sessions remove` first.',
  ],
};

/** `+62 838-3145-9585` → `6283831459585`. WhatsApp wants digits, in international form. */
export function normalisePhone(raw: string): string {
  return raw.replace(/\D/g, '');
}

/**
 * Ask WhatsApp for the 8-character phone code and show it.
 *
 * rc14 does not volunteer this. It emits a QR ref on `connection.update` and
 * nothing else, so without an explicit request `pair` can only ever wait for a
 * scan — which never arrives on a headless box. The returned string is the code;
 * `update.pairingCode` is a legacy path kept only as a fallback.
 */
async function requestPhoneCode(io: Reporter, sock: CoreSocket, digits: string): Promise<string> {
  const code = await sock.requestPairingCode(digits);
  // The code is the one thing the operator has, for about half a minute, and
  // the one thing they must not mistype. So it gets the strongest visual
  // treatment available and nothing else sits near it.
  io.line();
  codeFrame(code, (s) => io.c(s, 'cyan'));
  io.line();
  io.pairing([['phone code', formatPairingCode(code)]]);
  io.line();
  io.line(`  ${io.c('sent to', 'dim')}  ${digits}`);
  io.line(`  ${io.c('valid for', 'dim')}  about 30 seconds`);
  io.line();
  return code;
}

/**
 * The introduction shown on a first interactive pairing.
 *
 * Written to answer the three questions someone actually has at this moment —
 * what is about to happen to my account, do I need my phone out, and what do
 * I do when the code appears — rather than to describe the flags.
 */
function printIntroduction(io: Reporter, ctx: CommandContext): void {
  // Visual only. The layout lives in cli/intro.ts and is returned as text, so
  // it can be asserted on rather than eyeballed in terminal output.
  //
  // The Reporter paints with `c()` and the renderer wants `paint()`, so a thin
  // adapter is passed rather than widening Reporter to match the renderer.
  renderIntro({
    line: (t?: string) => io.line(t),
    note: (t: string) => io.note(t),
    paint: (t, code) => io.c(t, code),
  }, {
    version: readVersion(),
    sessionDir: ctx.env.sessionDir,
    // Seeded from the clock so each run differs, but fixed for the life of the
    // run so the picture does not shimmer while the socket opens.
    seed: Date.now() & 0x7fffffff,
  });
}

/** Version string from the installed package, or a placeholder. */
function readVersion(): string {
  try {
    return JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')).version as string;
  } catch {
    return '0.0.0';
  }
}

/** Ask one line, with a dimmed default, on stderr so stdout stays parseable. */

/** Ask one question, with a default, on stderr so stdout stays parseable. */
async function ask(question: string, fallback: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${question}\n  (Enter for ${fallback}): `);
    return answer.trim();
  } finally {
    rl.close();
  }
}

async function cmdPair(ctx: CommandContext): Promise<ExitCode> {
  const { args, io } = ctx;
  const pairTimeout = flagNumber(args, 'timeout', 180) * 1000;
  const connectTimeout = flagNumber(args, 'connect-timeout', 60) * 1000;
  let phone = flagString(args, 'phone', '').trim();

  const interactive = process.stdin.isTTY === true && !io.json;
  const wantsHelp = flagBool(args, 'help-intro', false);

  /**
   * Phone validation runs first, before any session or socket work.
   *
   * A malformed number is a pure argument error. If the session check ran
   * first, `--phone 123` pointed at a poisoned directory would report a
   * half-finished pairing rather than the obvious typo, and pointing it at a
   * live one would cost a connection attempt that WhatsApp counts.
   */
  let digits = '';
  if (phone) {
    digits = normalisePhone(phone);
    if (digits.length < 8) {
      throw new UsageError(
        `--phone needs a full international number, got \`${phone}\``,
        'for example: npm run pair -- --phone 6283831459585',
      );
    }
  }

  /**
   * Session state is checked before the introduction is shown.
   *
   * Showing a full-screen banner and then refusing to pair is worse than either
   * alone: the operator reads a welcome, types nothing, and gets an error about
   * a half-finished pairing they never knew about. A command that is going to
   * refuse should say so first and stay quiet.
   */
  const pre = await readSession(ctx.env.sessionDir);

  if (!phone && !wantsHelp && pre.registered && interactive) {
    // Only a genuine interactive run gets the offer of another directory. In
    // every other case the normal "already paired" report below is correct.
    printIntroduction(io, ctx);
    io.line();
    io.warn(`${ctx.env.sessionDir} already holds ${pre.jid ?? 'another number'}.`);
    io.line('A second number needs its own directory, or it overwrites the first.');
    io.line();
    const suggested = `${ctx.env.sessionDir.replace(/[\\/]+$/, '')}-2`;
    const chosen = await ask('Session directory for the new number', suggested);
    if (!chosen) {
      io.line();
      io.line('Nothing changed.');
      io.emit('pair', { paired: true, alreadyPaired: true, number: pre.jid, dir: pre.path });
      return EXIT.ok;
    }
    ctx.env.sessionDir = chosen;
  }

  const existing = await readSession(ctx.env.sessionDir);
  if (existing.registered) {
    io.status(true, `already paired as ${existing.jid ?? 'unknown number'} (${existing.path})`);
    io.line();
    io.line('To pair a different number: nyx-baileys sessions remove');
    io.emit('pair', { paired: true, alreadyPaired: true, number: existing.jid, dir: existing.path });
    return EXIT.ok;
  }

  // Caught before connecting, because the alternative is three identical silent
  // 401s and a diagnosis that points at auth instead of at the file on disk.
  if (existing.partial.length > 0) {
    if (!flagBool(args, 'reset', false)) {
      throw new CliError(
        EXIT.notPaired,
        `${existing.path} holds a half-finished pairing (${existing.partial.join(', ')}) that cannot be resumed`,
        `run \`nyx-baileys pair --dir ${existing.path} --reset\` to clear it and pair again`,
      );
    }
    io.warn(`clearing the half-finished pairing in ${existing.path} (--reset)`);
    await new FileSessionStore({ dir: existing.path }).clear();
  }

  // Everything below this point is going to open a socket, so now — and only
  // now — is the right moment for the introduction and the prompt.
  if (!phone && !wantsHelp) {
    printIntroduction(io, ctx);
    if (!interactive) {
      io.line();
      io.line('Not a terminal, so there is nothing to prompt on. Pass the number:');
      io.line('  npm run pair -- --phone 628XXXXXXXXX');
      io.emit('pair', { paired: false, reason: 'no-phone', interactive: false });
      return EXIT.usage;
    }
    const answer = await ask('WhatsApp number — country code, digits only', '');
    phone = answer;
    if (!phone) {
      io.line();
      io.line('Nothing entered, so nothing was changed.');
      io.emit('pair', { paired: false, reason: 'cancelled', interactive: true });
      return EXIT.ok;
    }
  }


  io.line(`Session directory: ${existing.path}`);
  io.line('Opening the socket…');
  io.line();

  const client = createNyxBaileys({
    sessionDir: ctx.env.sessionDir,
    logLevel: ctx.env.logLevel,
    printQRInTerminal: true,
  });
  ctx.lifecycle.add(async () => {
    await client.dispose();
  });

  try {
    await client.connect();
  } catch (err) {
    const diagnosis = diagnoseConnectError(err);
    throw new CliError(EXIT.failure, diagnosis.message, diagnosis.next);
  }

  const sock = client.sock;

  // Capture every rotation: only the newest ref is valid. The handler no longer
  // announces on every update — a rotating QR would otherwise reprint the same
  // code on each frame.
  const pairing: Pairing = { qr: null, code: null };
  ctx.lifecycle.add(
    client.on('connection.update', (update: ConnectionUpdate) => {
      if (update.pairingCode && update.pairingCode !== pairing.code) {
        pairing.code = update.pairingCode;
        announcePairing(io, pairing);
      }
      if (update.qr && update.qr !== pairing.qr) {
        pairing.qr = update.qr;
        announcePairing(io, pairing);
      }
    }),
  );

  if (!sock.authState.creds.registered) {
    // `connect()` resolves once the plugins are applied, which is before the
    // socket is open. `requestPairingCode` against a socket that has not
    // finished its handshake throws Boom 428 'Connection Closed', so readiness
    // is awaited first — and only when a code is actually needed. The QR path
    // does not need it, and waiting there would turn a working scan into a
    // timeout.
    if (phone) {
      const ready = await waitForReady(client, connectTimeout, pairing, io);
      if (!ready) {
        throw new CliError(
          EXIT.failure,
          `the socket was not ready within ${formatDuration(connectTimeout)} (state: ${client.connectionState.state})`,
          'retry; WhatsApp may be rate limiting this number',
        );
      }
      await requestPhoneCode(io, sock, digits);
    } else {
      io.line('Scan in WhatsApp → Linked devices → Link a device.');
      io.line('No --phone given, so this waits for a QR scan. Pass --phone <number> for a code to type in.');
      io.line();
    }

    const result = await waitForPairing(client, pairTimeout, pairing, io);
    if (!result.ok) {
      const code = pairing.code ? ` Phone code: ${formatPairingCode(pairing.code)}.` : '';
      if (result.reason === 'unregistered') {
        throw new CliError(
          EXIT.notPaired,
          `WhatsApp closed the connection (401) while the session in ${existing.path} was still unregistered`,
          `the file on disk is now half-negotiated; run \`nyx-baileys pair --dir ${existing.path} --reset\` and pair again`,
        );
      }
      throw new CliError(
        EXIT.notPaired,
        result.reason === 'timeout'
          ? `pairing did not complete within ${formatDuration(pairTimeout)}.${code}`
          : `the socket closed before pairing completed.${code}`,
        'run `nyx-baileys pair` again and finish inside the window',
      );
    }
  }

  const open = await waitForOpen(client, connectTimeout);
  if (!open) {
    throw new CliError(
      EXIT.failure,
      `paired, but the socket did not open within ${formatDuration(connectTimeout)}`,
      'the pairing is saved — run `nyx-baileys status` to check it',
    );
  }

  // Correct the flag rc14 never sets, now that we know the pairing worked.
  // dispose() first so Baileys is not mid-write on the file — it is idempotent,
  // so the shared lifecycle running it again afterwards is harmless.
  await client.dispose();
  const healed = await healRegisteredFlag(ctx.env.sessionDir);
  if (healed.healed && !io.json) {
    io.note(`corrected the \`registered\` flag on disk for ${healed.jid ?? 'this session'}`);
  }

  const number = sock.user?.id ?? null;
  io.status(true, `paired${number ? ` as ${number}` : ''}`);
  io.line();
  io.fields([
    ['number', number ?? 'unknown'],
    ['session', existing.path],
    ['plugins', String(client.applied.length)],
    ['patches', String(client.patchCount)],
  ]);
  io.emit('pair', {
    paired: true,
    alreadyPaired: false,
    number,
    dir: existing.path,
    plugins: [...client.applied],
    patchCount: client.patchCount,
  });
  return EXIT.ok;
}

interface Pairing {
  qr: string | null;
  code: string | null;
}

function announcePairing(io: Reporter, pairing: Pairing): void {
  const rows: (readonly [string, string])[] = [];
  if (pairing.code) rows.push(['phone code', formatPairingCode(pairing.code)]);
  if (pairing.qr) rows.push(['qr ref', pairing.qr]);
  if (rows.length === 0) return;
  io.pairing(rows);
  io.line();
}

/** `12345678` reads badly; group it. */
function formatPairingCode(code: string): string {
  const clean = code.replace(/\D/g, '');
  return clean.length === 8 ? `${clean.slice(0, 4)} ${clean.slice(4)}` : code;
}

async function waitForPairing(
  client: NyxBaileys,
  timeoutMs: number,
  pairing: Pairing,
  io: Reporter,
): Promise<{ ok: boolean; reason: 'timeout' | 'closed' | 'unregistered' | 'paired' }> {
  if (pairing.code || pairing.qr) announcePairing(io, pairing);

  return new Promise<{ ok: boolean; reason: 'timeout' | 'closed' | 'unregistered' | 'paired' }>((resolve) => {
    let offCreds: (() => void) | null = null;
    let offConnection: (() => void) | null = null;

    const settle = (ok: boolean, reason: 'timeout' | 'closed' | 'unregistered' | 'paired'): void => {
      clearTimeout(timer);
      offCreds?.();
      offConnection?.();
      resolve({ ok, reason });
    };

    const timer = setTimeout(() => settle(false, 'timeout'), timeoutMs);

    offCreds = client.on('creds.update', () => {
      if (client.sock.authState.creds.registered) settle(true, 'paired');
    });
    offConnection = client.onConnection((phase, payload) => {
      if (phase !== 'close') return;
      // A 401 on a session that never registered is not a logout. It is the
      // half-negotiated file being refused, and it needs clearing rather than
      // re-authenticating — the reconnect plugin cannot tell the two apart.
      settle(
        false,
        payload === DisconnectReason.loggedOut && !client.sock.authState.creds.registered
          ? 'unregistered'
          : 'closed',
      );
    });
  });
}

/* ── command: status ──────────────────────────────────────────────── */

const statusSpec: CommandSpec = {
  name: 'status',
  summary: 'Report session state, the connected number, plugins, patches and memory.',
  positionals: [],
  flags: [
    { name: 'connect-timeout', kind: 'number', default: 30, placeholder: '<seconds>', describe: 'How long to wait for the socket to open' },
  ],
  examples: ['nyx-baileys status', 'nyx-baileys status --json'],
  notes: [
    'Opening a socket to read live state means this command connects to WhatsApp. Session data is reported even when the socket cannot be opened.',
    'Exit code 3 means the session exists but is not paired.',
  ],
};

async function cmdStatus(ctx: CommandContext): Promise<ExitCode> {
  const { io } = ctx;
  const record = await readSession(ctx.env.sessionDir);

  if (!record.registered) {
    io.heading('Session');
    io.fields([
      ['directory', record.path],
      ['exists', String(record.exists)],
      ['paired', 'false'],
      ['files', `${record.files} (${formatBytes(record.bytes)})`],
      ['modified', formatAgo(record.modified)],
    ]);
    io.line();
    io.warn('this session is not paired — live state is unavailable');
    io.emit('status', { paired: false, session: sessionSummary(record), connection: null, memory: null });
    return EXIT.notPaired;
  }

  const timeoutMs = flagNumber(ctx.args, 'connect-timeout', 30) * 1000;
  const { client } = await openSocket(ctx, { timeoutMs });
  const ext = extensions(client);
  const number = client.sock.user?.id ?? null;

  const memory = ext.store?.stats() ?? null;
  const pacing = ext.__antispam?.stats() ?? null;
  const identity = ext.__identity ?? null;

  const connection = {
    state: client.connectionState.state,
    since: client.connectionState.at ? new Date(client.connectionState.at).toISOString() : null,
    number,
    plugins: [...client.applied],
    patchCount: client.patchCount,
  };

  if (!ctx.env.json) {
    io.heading('Session');
    io.fields([
      ['directory', record.path],
      ['paired', 'true'],
      ['number', record.jid ?? 'unknown'],
      ['push name', record.pushName ?? 'unknown'],
      ['files', `${record.files} (${formatBytes(record.bytes)})`],
      ['modified', formatAgo(record.modified)],
    ]);
    io.line();
    io.heading('Connection');
    io.fields([
      ['state', client.connectionState.state],
      ['live number', number ?? 'unknown'],
      ['plugins applied', String(client.applied.length)],
      ['patches active', String(client.patchCount)],
      ['pacing', pacing ? `queued ${pacing.queued}, sent ${pacing.sent}, pressure ${pacing.pressure.toFixed(2)}` : 'unavailable'],
    ]);
    if (identity) {
      io.fields([['identity', `${identity.browser.join('/')} — ${identity.userAgent}`]]);
    }
    io.line();
    io.heading(`Plugins (${client.applied.length})`);
    io.table(['#', 'plugin'], client.applied.map((name, i) => [String(i + 1), name]));
    io.line();
    io.heading('Memory');
    io.fields([
      ['chats tracked', memory ? String(memory.chats) : 'unavailable'],
      ['media blobs', memory ? String(memory.media) : 'unavailable'],
      ['status entries', memory ? String(memory.statuses) : 'unavailable'],
      ['heap', memory ? `${memory.heapMb} MB` : 'unavailable'],
      ['process rss', `${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`],
      ['node', process.version],
    ]);
  }

  io.emit('status', {
    paired: true,
    session: sessionSummary(record),
    connection,
    memory,
    pacing,
    identity: identity ? { browser: identity.browser, userAgent: identity.userAgent } : null,
    runtime: { node: process.version, platform: process.platform, uptimeSec: Math.round(process.uptime()) },
  });
  return EXIT.ok;
}

/* ── command: send ────────────────────────────────────────────────── */

const sendSpec: CommandSpec = {
  name: 'send',
  summary: 'Send one text message and exit.',
  positionals: [
    { name: '<jid>', describe: 'Recipient — 15551234567@s.whatsapp.net, a group id, or a bare number' },
    { name: '<text>', describe: 'Message body' },
  ],
  flags: [
    { name: 'text', kind: 'string', placeholder: '<string>', describe: 'Message body, as an alternative to the positional' },
    { name: 'timeout', kind: 'number', default: 60, placeholder: '<seconds>', describe: 'How long to wait for the socket to open' },
  ],
  examples: [
    'nyx-baileys send 15551234567@s.whatsapp.net "build green"',
    'nyx-baileys send 120363000000000000@g.us --text "deploy finished"',
  ],
  notes: [
    'Sends are paced by the anti-spam plugin, so this command waits before it returns.',
    'Use `--` when the body starts with a dash: nyx-baileys send <jid> -- --force',
  ],
};

async function cmdSend(ctx: CommandContext): Promise<ExitCode> {
  const { args, io } = ctx;
  const [positionalJid, positionalText] = args.positionals;
  const jid = (positionalJid ?? '').trim();
  const text = flagString(args, 'text', positionalText ?? '');

  if (!jid) throw new UsageError('missing recipient', 'usage: nyx-baileys send <jid> <text>');
  if (!text.trim()) throw new UsageError('refusing to send an empty message', 'pass the body as <text> or `--text "…"`');

  await requirePaired(ctx.env);

  const timeoutMs = flagNumber(args, 'timeout', 60) * 1000;
  const { client } = await openSocket(ctx, { timeoutMs });

  const result = await sendText(client, jid, text);
  io.status(true, `sent to ${result.target}`);
  io.emit('send', {
    sent: true,
    requested: jid,
    target: result.target,
    messageId: result.id ?? null,
    timestamp: result.timestamp ?? null,
    bytes: Buffer.byteLength(text, 'utf8'),
  });
  return EXIT.ok;
}

/* ── command: form ────────────────────────────────────────────────── */

const formSpec: CommandSpec = {
  name: 'form',
  summary: 'Send the native-flow demo form — a real interactive message, not text.',
  positionals: [{ name: '<jid>', describe: 'Recipient' }],
  flags: [
    { name: 'info', kind: 'boolean', describe: 'Include a read-only info section in the form' },
    { name: 'timeout', kind: 'number', default: 60, placeholder: '<seconds>', describe: 'How long to wait for the socket to open' },
  ],
  examples: ['nyx-baileys form 15551234567@s.whatsapp.net', 'nyx-baileys form 15551234567@s.whatsapp.net --info --json'],
  notes: [
    'The form is a nativeFlowMessage: WhatsApp renders the radio rows and the client binds the selection.',
    'Send `--info` to include non-selectable info rows alongside the radio rows.',
  ],
};

/** The demo form. Built here rather than imported from `src/index.ts` so the CLI owns its own demo. */
function demoForm(includeInfo: boolean): ReturnType<typeof createFormFlow> {
  return createFormFlow({
    title: 'Nyx-Baileys',
    body: 'nativeFlowMessage — the client renders this UI, it is not a text template.',
    ctaLabel: 'Submit',
    sections: [
      {
        title: 'Deploy target',
        highlightLabel: 'REQUIRED',
        rows: [
          radioRow('Vercel', 'vercel', 'Serverless — cheapest to run'),
          radioRow('Railway', 'railway', 'Long-lived container, good for websockets'),
          radioRow('Home VPS', 'vps', 'Full control, you own the uptime'),
        ],
      },
      includeInfo
        ? {
            title: 'Runtime',
            rows: [
              infoRow('Pacing', 'Jittered queue with a burst ceiling'),
              infoRow('Plugins', 'Decorators applied over one upstream socket'),
              infoRow('Session', 'Credentials on disk, reloaded on restart'),
            ],
          }
        : {
            title: 'Add-ons',
            rows: [
              radioRow('Postgres session store', 'pg', 'Durable auth state across restarts'),
              radioRow('Flow engine', 'flow', 'Regex-routed conversation trees'),
              radioRow('Anti-spam pacing', 'anti', 'Jittered queue with a burst ceiling'),
            ],
          },
    ],
    footer: 'Reply with any text to add a note to this request.',
  });
}

/**
 * Read the built flow back so the report describes the message that was
 * actually sent, rather than a hand-kept count that drifts from the spec.
 */
interface FlowSectionShape {
  readonly title: string;
  readonly rows: number;
  readonly selectable: number;
}

interface FlowShape {
  readonly title: string;
  readonly cta: string;
  readonly sections: number;
  readonly rows: number;
  readonly selectable: number;
  readonly info: number;
  readonly sectionList: readonly FlowSectionShape[];
}

function inspectFlow(flow: ReturnType<typeof createFormFlow>): FlowShape {
  const json = flow.message?.interactiveMessage?.nativeFlowMessage?.messageParamsJson ?? '{}';
  const params = JSON.parse(json) as {
    title?: string;
    ctaLabel?: string;
    sections?: { title?: string; rows?: { optionName?: string }[] }[];
  };
  const sections = params.sections ?? [];
  const rows = sections.flatMap((section) => section.rows ?? []);
  const selectable = (list: { optionName?: string }[]): number =>
    list.filter((row) => typeof row.optionName === 'string' && row.optionName.length > 0).length;

  return {
    title: params.title ?? '',
    cta: params.ctaLabel ?? '',
    sections: sections.length,
    rows: rows.length,
    selectable: selectable(rows),
    info: rows.length - selectable(rows),
    sectionList: sections.map((section, i) => {
      const list = section.rows ?? [];
      return { title: section.title ?? `section ${i + 1}`, rows: list.length, selectable: selectable(list) };
    }),
  };
}

async function cmdForm(ctx: CommandContext): Promise<ExitCode> {
  const { io } = ctx;
  const jid = (ctx.args.positionals[0] ?? '').trim();
  if (!jid) throw new UsageError('missing recipient', 'usage: nyx-baileys form <jid>');

  await requirePaired(ctx.env);

  const timeoutMs = flagNumber(ctx.args, 'timeout', 60) * 1000;
  const { client } = await openSocket(ctx, { timeoutMs });

  const includeInfo = flagBool(ctx.args, 'info', false);
  const form = demoForm(includeInfo);
  const shape = inspectFlow(form);
  const ext = extensions(client);

  // rc14 cannot send this. `generateWAMessageContent` is an if/else chain over the
  // content keys it knows (text, image, poll, album, listReply, …) and its final
  // `else` calls `prepareWAMessageMedia`, which throws `Invalid media type` for
  // anything unrecognised — `interactiveMessage` included. Building the message
  // by hand and handing it to `relayMessage` does not work either: that returns a
  // plausible message id and delivers nothing, verified on a physical phone, with
  // and without the group-metadata cache.
  //
  // So this reports the real limitation instead of surfacing a Boom that names
  // neither the cause nor the workaround.
  throw new CliError(
    EXIT.failure,
    'rc14 cannot send native flow messages: `interactiveMessage` is not a content type its send path accepts',
    'plain text, images, polls and albums all work. For flows, either use the WhatsApp Business app on the receiving side or send the form as text',
  );
}

/* ── command: logs ────────────────────────────────────────────────── */

const logsSpec: CommandSpec = {
  name: 'logs',
  summary: 'Stream the framework log for a while.',
  positionals: [],
  flags: [
    { name: 'duration', kind: 'number', default: 60, placeholder: '<seconds>', describe: 'How long to stream before exiting' },
    { name: 'follow', kind: 'boolean', describe: 'Stream until Ctrl-C, ignoring --duration' },
    { name: 'allow-unpaired', kind: 'boolean', describe: 'Connect even without credentials, to watch connection attempts' },
    { name: 'connect-timeout', kind: 'number', default: 30, placeholder: '<seconds>', describe: 'How long to wait for the socket to open' },
  ],
  examples: ['nyx-baileys logs', 'nyx-baileys logs --level debug --duration 120', 'nyx-baileys logs --follow --allow-unpaired'],
  notes: [
    'Log level comes from --level or LOG_LEVEL. The framework logger writes to stdout in human mode.',
    '--json clamps the log stream to error on stderr and prints one summary object on stdout.',
    'With --allow-unpaired an unpaired session prints a QR; the stream is how you watch a failing connect.',
  ],
};

async function cmdLogs(ctx: CommandContext): Promise<ExitCode> {
  const { args, io, env } = ctx;
  const follow = flagBool(args, 'follow', false);
  const allowUnpaired = flagBool(args, 'allow-unpaired', false);
  const durationMs = flagNumber(args, 'duration', 60) * 1000;

  if (!allowUnpaired) await requirePaired(env);

  // In JSON mode stdout must hold exactly one object, so the log stream is
  // clamped to `error`, which the framework logger writes to stderr.
  const level: LogLevel = env.json ? (env.logLevelExplicit ? env.logLevel : 'error') : env.logLevel;

  const record = await readSession(env.sessionDir);
  const client = createNyxBaileys({
    sessionDir: env.sessionDir,
    logLevel: level,
    printQRInTerminal: true,
  });
  ctx.lifecycle.add(async () => {
    await client.dispose();
  });

  const events: { phase: string; at: string }[] = [];
  ctx.lifecycle.add(
    client.onConnection((phase) => {
      events.push({ phase, at: new Date().toISOString() });
    }),
  );

  const started = Date.now();
  try {
    await client.connect();
  } catch (err) {
    const diagnosis = diagnoseConnectError(err);
    throw new CliError(EXIT.failure, diagnosis.message, diagnosis.next);
  }

  if (!io.json) {
    io.note(`streaming ${level} logs for ${follow ? 'until Ctrl-C' : formatDuration(durationMs)}`);
  }

  // Do not unref: this timer is the reason the process stays alive, and the
  // socket's own handles are the only other thing holding the loop open.
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, follow ? 24 * 60 * 60 * 1000 : durationMs);
    ctx.lifecycle.add(() => clearTimeout(timer));
  });

  const elapsed = Date.now() - started;
  const state = client.connectionState.state;

  if (!io.json) {
    io.line();
    io.line(`streamed ${formatDuration(elapsed)} · state ${state} · ${events.length} connection events`);
  }
  io.emit('logs', {
    level,
    durationMs: elapsed,
    state,
    connectionEvents: events,
    plugins: [...client.applied],
    patchCount: client.patchCount,
    paired: record.registered,
  });

  return state === 'open' ? EXIT.ok : EXIT.failure;
}

/* ── command: sessions ────────────────────────────────────────────── */

const sessionsSpec: CommandSpec = {
  name: 'sessions',
  summary: 'Inspect or remove stored sessions.',
  usage: '<action> [name]',
  positionals: [
    { name: '<action>', describe: 'list | remove' },
    { name: '[name]', describe: 'Session to act on — required for remove', required: false },
  ],
  flags: [
    { name: 'filter', kind: 'list', placeholder: '<text>', describe: 'Keep sessions matching this text; repeat for more than one' },
    { name: 'yes', kind: 'boolean', short: 'y', describe: 'Skip the confirmation prompt' },
    { name: 'force', kind: 'boolean', describe: 'Remove even when the directory holds no creds.json' },
  ],
  examples: [
    'nyx-baileys sessions list',
    'nyx-baileys sessions remove alice --yes',
    'nyx-baileys sessions remove alice',
  ],
  notes: [
    'remove deletes credentials. The number must be re-paired afterwards.',
    'Every removal is appended to .nyx-baileys/audit.log in the working directory.',
  ],
};

async function cmdSessions(ctx: CommandContext): Promise<ExitCode> {
  const action = (ctx.args.positionals[0] ?? 'list').toLowerCase();

  if (action === 'list') return sessionsList(ctx);
  if (action === 'remove') return sessionsRemove(ctx);

  throw new UsageError(
    `unknown action \`${action}\``,
    'usage: nyx-baileys sessions <list|remove> [name]',
  );
}

async function sessionsList(ctx: CommandContext): Promise<ExitCode> {
  const { io } = ctx;
  const found = await discoverSessions(ctx.env.sessionDir);

  // Repeatable --filter: match on name or number, OR-ed together.
  const filters = flagList(ctx.args, 'filter');
  const sessions =
    filters.length === 0
      ? found.sessions
      : found.sessions.filter((record) =>
        filters.some((needle) => record.name.includes(needle) || (record.jid ?? '').includes(needle)),
      );

  if (!io.json) {
    io.heading(`Sessions in ${found.root}`);
    io.line();
  }

  if (sessions.length === 0) {
    const reason = filters.length > 0 ? `no session matches ${filters.join(
)}` : null;
    io.warn(reason ?? (found.exists ? `no sessions found in ${found.root}` : `directory does not exist: ${found.root}`));
    if (reason === null) io.line('pair a number to create one: nyx-baileys pair');
    io.emit(
      'sessions',
      { root: found.root, rootExists: found.exists, action: 'list', filters, sessions: [] },
    );
    return EXIT.ok;
  }

  io.table(
    ['name', 'paired', 'number', 'files', 'size', 'modified'],
    sessions.map((record) => [
      record.name,
      record.registered ? 'yes' : 'no',
      record.jid ?? '\u2014',
      String(record.files),
      formatBytes(record.bytes),
      formatAgo(record.modified),
    ]),
    { align: ['left', 'left', 'left', 'right', 'right', 'right'] },
  );

  io.emit('sessions', {
    root: found.root,
    rootExists: found.exists,
    action: 'list',
    filters,
    sessions: sessions.map(sessionSummary),
  });
  return EXIT.ok;
}

async function sessionsRemove(ctx: CommandContext): Promise<ExitCode> {
  const { args, io } = ctx;
  const name = (args.positionals[1] ?? '').trim();
  if (!name) {
    throw new UsageError(
      '`sessions remove` needs a session name',
      'list them with `nyx-baileys sessions list`, or remove the default session with `--dir <path>`',
    );
  }

  const found = await discoverSessions(ctx.env.sessionDir);
  // The root may itself be the session; otherwise the name must be a child of it.
  const target = found.sessions.find((record) => record.name === name);
  if (!target) {
    throw new UsageError(
      `no session named \`${name}\` under ${found.root}`,
      'list them with `nyx-baileys sessions list`',
    );
  }

  const force = flagBool(args, 'force', false);
  if (!target.registered && !force) {
    throw new UsageError(
      `${target.path} holds no paired credentials`,
      'pass --force to remove it anyway',
    );
  }

  if (!flagBool(args, 'yes', false)) {
    const answer = await confirm(
      `Delete session \`${target.name}\` at ${target.path}? The number must be re-paired.`,
    );
    if (!answer) {
      io.warn('cancelled — nothing was deleted');
      io.emit('sessions', { action: 'remove', removed: null, cancelled: true });
      return EXIT.ok;
    }
  }

  // Destructive: named by the caller, confirmed above, and audited below.
  await new FileSessionStore({ dir: target.path }).clear();
  await audit(ctx.env.cwd, {
    action: 'sessions.remove',
    session: target.name,
    dir: target.path,
    paired: target.registered,
    bytes: target.bytes,
  });

  io.status(true, `removed \`${target.name}\` (${formatBytes(target.bytes)})`);
  io.line(`Pair it again with: nyx-baileys pair --dir ${target.path}`);
  io.emit('sessions', { action: 'remove', removed: sessionSummary(target), cancelled: false });
  return EXIT.ok;
}

async function confirm(question: string): Promise<boolean> {
  if (process.stdin.isTTY !== true) {
    throw new UsageError(
      'refusing to delete without confirmation',
      're-run with --yes to confirm non-interactively',
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function audit(cwd: string, entry: Record<string, unknown>): Promise<void> {
  const file = join(cwd, '.nyx-baileys', 'audit.log');
  const line = `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry })}\n`;
  try {
    await mkdir(join(cwd, '.nyx-baileys'), { recursive: true });
    await appendFile(file, line, 'utf8');
  } catch (err) {
    // Never fail a completed command because the audit write failed — but say so.
    process.stderr.write(`warning  could not write audit log ${file}: ${messageOf(err)}\n`);
  }
}

/* ── command: health ──────────────────────────────────────────────── */

const healthSpec: CommandSpec = {
  name: 'health',
  summary: 'Report disconnect counters and the current pacing pressure.',
  positionals: [],
  flags: [
    { name: 'timeout', kind: 'number', default: 60, placeholder: '<seconds>', describe: 'How long to wait for the socket to open' },
  ],
  examples: ['nyx-baileys health', 'nyx-baileys health --json'],
  notes: [
    'Counters are per-process: they start at zero when the CLI launches and say nothing about history.',
    'level is low below 3 bad signals, elevated below 10, paused at 10 or more.',
  ],
};

async function cmdHealth(ctx: CommandContext): Promise<ExitCode> {
  const { io } = ctx;
  await requirePaired(ctx.env);

  const timeoutMs = flagNumber(ctx.args, 'timeout', 60) * 1000;
  const { client } = await openSocket(ctx, { timeoutMs });

  const ext = extensions(client);
  const report = ext.health?.() ?? null;
  const pacing = ext.__antispam?.stats() ?? null;

  const signals = report?.signals ?? { rateLimited: 0, dead: 0, server: 0, ok: 0 };
  const level = report?.level ?? 'unknown';
  const bad = signals.rateLimited + signals.dead + signals.server;

  if (!ctx.env.json) {
    io.heading('Health');
    io.fields([
      ['level', level === 'low' ? ctx.io.c(level, 'green') : ctx.io.c(level, level === 'paused' ? 'red' : 'yellow')],
      ['state', client.connectionState.state],
      ['bad signals', String(bad)],
      ['healthy for', report?.since ? formatAgo(report.since) : 'unknown'],
      ['pacing pressure', pacing ? pacing.pressure.toFixed(2) : 'unavailable'],
    ]);
    io.line();
    io.heading('Disconnect counters');
    io.table(
      ['signal', 'count'],
      [
        ['ok', String(signals.ok)],
        ['rate limited', String(signals.rateLimited)],
        ['timed out', String(signals.dead)],
        ['server rejection', String(signals.server)],
      ],
      { align: ['left', 'right'] },
    );
  }

  io.emit('health', {
    level,
    state: client.connectionState.state,
    healthySince: report?.since ?? null,
    healthyFor: report?.since ? formatAgo(report.since) : null,
    badSignals: bad,
    signals,
    pacing,
  });
  return EXIT.ok;
}

/* ── command: selftest ──────────────────────────────────────────────────── */

/**
 * Exercise the engine against the live socket without risking the account.
 *
 * The ban-safety rule is that **this command sends nothing unless told to.**
 * Everything is verified one of three ways:
 *
 *   read      observed off the live socket or the host (state, plugins, patches,
 *             health, pacing, memory, jid resolution)
 *   synthetic a fabricated event is emitted into the real socket's emitter and
 *             the real plugin reacts to it. The wire is never touched, so this
 *             exercises the genuine code path rather than a stand-in — the
 *             moderation and welcome plugins are the opt-in ones, and they are
 *             the ones most worth proving here.
 *   local     pure functions and serialisation, checked in-process
 *
 * `--send` is the only path that puts a message on the wire, it targets Note to
 * Self, and it sends exactly one. `--group` is the only path that mutates
 * anything, and it only creates a group and reads its invite code.
 */
const selftestSpec: CommandSpec = {
  name: 'selftest',
  summary: 'Check the engine against a live session. Sends nothing unless asked.',
  positionals: [],
  flags: [
    { name: 'timeout', kind: 'number', default: 60, placeholder: '<seconds>', describe: 'How long to wait for the socket to open' },
    { name: 'send', kind: 'boolean', describe: 'Also send one message to Note to Self' },
    { name: 'group', kind: 'boolean', describe: 'Also create a test group and report its invite link' },
    { name: 'member', kind: 'string', placeholder: '<number>', describe: 'Number to add to the group created by --group' },
  ],
  examples: [
    'nyx-baileys selftest --dir ./session',
    'nyx-baileys selftest --dir ./session --send',
    'nyx-baileys selftest --dir ./session --group --member 62882017467912',
  ],
  notes: [
    'Sends nothing to any contact unless --send or --group is passed.',
    'Moderation and welcome are checked in dry run against synthetic events, so no message is deleted and no member is touched.',
    'Exit code 0 means every check passed.',
  ],
};

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  /** 'read' | 'synthetic' | 'local' — surfaced so the evidence class is visible. */
  readonly via: 'read' | 'synthetic' | 'local';
}

const SELF_GROUP = 'Nyx-Baileys Test';

/** A group id the plugins will accept, without needing a real group. */
const FAKE_GROUP = '120363000000000000@g.us';
const FAKE_MEMBER = '628999000111@s.whatsapp.net';

/** Build the message the moderation plugin will see. Never leaves the process. */
function syntheticSpam(id: string, participant = FAKE_MEMBER): WAMessageShape {
  return {
    key: { remoteJid: FAKE_GROUP, id, participant, fromMe: false },
    messageTimestamp: 1_700_000_000_000,
    message: { conversation: 'free crypto guaranteed returns, join https://wa.me/abc123' },
  };
}

interface WAMessageShape {
  key: { remoteJid: string; id: string; participant: string; fromMe: boolean };
  messageTimestamp: number;
  message: { conversation: string };
}

async function cmdSelftest(ctx: CommandContext): Promise<ExitCode> {
  const { args, io } = ctx;
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string, via: Check['via']): void => {
    checks.push({ name, ok, detail, via });
  };

  await requirePaired(ctx.env);

  // The two opt-in plugins, in dry run. Registering them here is the point:
  // neither is in the default chain, so this is the only place they run.
  const client = createNyxBaileys({
    sessionDir: ctx.env.sessionDir,
    logLevel: ctx.env.logLevel,
    printQRInTerminal: false,
  });
  client.registerPlugin(
    moderation({
      dryRun: true,
      words: [{ pattern: 'free crypto' }],
      links: { blockInvite: true },
      flood: { max: 3, windowMs: 10_000 },
      strikes: { deleteAt: 1, muteAt: 2, kickAt: 3, decayMs: 86_400_000 },
    }),
  );
  client.registerPlugin(welcome({ cooldownMs: 0, rejoinWindowMs: 0, dryRun: true }));
  ctx.lifecycle.add(async () => {
    await client.dispose();
  });

  const timeoutMs = flagNumber(args, 'timeout', 60) * 1000;
  const { open } = await openSocketClient(ctx, client, timeoutMs);
  if (!open) throw new CliError(EXIT.failure, 'socket did not open, cannot self-test');

  const ext = extensions(client);
  const sock = client.sock;

  /* ── read: the live socket ─────────────────────────────────────────── */

  add('connection', client.connectionState.state === 'open', `state ${client.connectionState.state}`, 'read');
  add('identity', Boolean(sock.user?.id), String(sock.user?.id ?? 'no jid'), 'read');
  add('plugins applied', client.applied.length > 0, `${client.applied.length} · ${client.applied.join(', ')}`, 'read');
  add('runtime patches', client.patchCount > 0, `${client.patchCount} active`, 'read');

  const health = ext.health?.() ?? null;
  add('health reporter', health !== null, health ? `level ${health.level}` : 'not attached', 'read');

  const pacing = ext.__antispam?.stats() ?? null;
  add(
    'anti-spam pacing',
    pacing !== null,
    pacing ? `queued ${pacing.queued}, sent ${pacing.sent}, pressure ${pacing.pressure.toFixed(2)}` : 'not attached',
    'read',
  );

  const memory = ext.store?.stats() ?? null;
  add('memory store', memory !== null, memory ? `${memory.chats} chats, ${memory.heapMb} MB heap` : 'not attached', 'read');

  /* ── synthetic: real socket, fabricated events, zero wire traffic ─── */

  const moderationEvents: { kind: string; strikes: number; jid: string | null }[] = [];
  ctx.lifecycle.add(
    client.on('nyx.moderation', (e: { kind: string; strikes: number; jid: string | null }) => {
      moderationEvents.push({ kind: e.kind, strikes: e.strikes, jid: e.jid });
    }),
  );

  const sentBefore = memory ? ext.store!.stats().media : 0;
  for (let i = 1; i <= 4; i += 1) {
    sock.ev.emit('messages.upsert' as never, { messages: [syntheticSpam(`selftest-${i}`)] } as never);
  }
  // The plugin is async internally (a delete is a send), so let it settle.
  await new Promise((r) => setTimeout(r, 250));

  add(
    'moderation · word rule',
    moderationEvents.length >= 1,
    `${moderationEvents.length} events, first kind ${moderationEvents[0]?.kind ?? 'none'}`,
    'synthetic',
  );
  add(
    'moderation · strike ladder climbs',
    moderationEvents.length >= 3 && (moderationEvents[2]?.strikes ?? 0) >= 3,
    `strikes seen: ${moderationEvents.map((e) => e.strikes).join(',') || 'none'}`,
    'synthetic',
  );
  add(
    'moderation · dry run sent nothing',
    sentBefore === (memory ? ext.store!.stats().media : 0),
    'no media written, no delete issued',
    'synthetic',
  );

  const welcomes: string[] = [];
  ctx.lifecycle.add(
    client.on('nyx.welcome', (e: { text: string }) => {
      welcomes.push(e.text);
    }),
  );
  sock.ev.emit(
    'group-participants.update' as never,
    { id: FAKE_GROUP, participants: [FAKE_MEMBER], action: 'add' } as never,
  );
  await new Promise((r) => setTimeout(r, 150));
  add(
    'welcome · join announcement',
    welcomes.length >= 1 && Boolean(welcomes[0]?.includes('628999000111')),
    welcomes[0] ?? 'no event',
    'synthetic',
  );

  /* ── local: pure code, no socket ───────────────────────────────────── */

  try {
    const shape = inspectFlow(demoForm(true));
    add(
      'native flow serialises',
      shape.sections > 0 && shape.rows > 0,
      `${shape.sections} sections, ${shape.rows} rows (${shape.selectable} selectable)`,
      'local',
    );
  } catch (err) {
    add('native flow serialises', false, messageOf(err), 'local');
  }

  const recipient = toRecipientJid('+62 882-0174-67912');
  add(
    'recipient normalisation',
    recipient === '62882017467912@s.whatsapp.net',
    `+62 882-0174-67912 → ${recipient}`,
    'local',
  );

  /* ── optional: the only paths that touch the wire ──────────────────── */

  const selfJid = sock.user?.id;
  let sentMessageId: string | null = null;
  if (flagBool(args, 'send', false)) {
    if (!selfJid) {
      add('send to Note to Self', false, 'no own jid available', 'read');
    } else {
      const result = await sendText(client, selfJid, 'Nyx-Baileys selftest — one message, as expected.');
      sentMessageId = result.id ?? null;
      add('send to Note to Self', true, `delivered as ${result.id ?? 'unknown id'}`, 'read');
    }
  }

  let group: { id: string; invite: string } | null = null;
  if (flagBool(args, 'group', false)) {
    const member = flagString(args, 'member', '').trim();
    const memberJid = member ? toRecipientJid(member) : '';
    const participants = memberJid ? [memberJid] : [];
    const created = (await sock.groupCreate(SELF_GROUP, participants)) as { id: string };
    const code = await sock.groupInviteCode(created.id);
    group = { id: created.id, invite: `https://chat.whatsapp.com/${code}` };
    add('group created', true, `${created.id} · ${group.invite}`, 'read');

    if (memberJid) {
      // Send the invite to the member so they can actually join.
      const sent = await sendText(client, memberJid, `Join the Nyx-Baileys test group: ${group.invite}`);
      add('invite sent', Boolean(sent.id), `to ${memberJid}`, 'read');
    }
  }

  /* ── report ────────────────────────────────────────────────────────── */

  const failed = checks.filter((c) => !c.ok);
  if (!io.json) {
    io.heading(`Self-test — ${checks.length - failed.length}/${checks.length} passed`);
    io.line();
    io.table(
      ['', 'check', 'via', 'result'],
      checks.map((c) => [c.ok ? 'ok' : 'FAIL', c.name, c.via, c.detail]),
      { align: ['left', 'left', 'left', 'left'] },
    );
    io.line();
    if (group) {
      io.heading('Test group');
      io.fields([
        ['id', group.id],
        ['invite', group.invite],
      ]);
      io.line();
    }
    if (!flagBool(args, 'send', false) && !flagBool(args, 'group', false)) {
      io.note('nothing was sent to any contact. pass --send or --group to change that.');
    }
  }

  io.emit('selftest', {
    passed: checks.length - failed.length,
    total: checks.length,
    failed: failed.map((c) => ({ name: c.name, detail: c.detail })),
    checks,
    sentMessageId,
    group,
    outbound: { send: flagBool(args, 'send', false), group: flagBool(args, 'group', false) },
    number: sock.user?.id ?? null,
  });

  return failed.length === 0 ? EXIT.ok : EXIT.failure;
}

/** `openSocket` for a caller that built and configured the client itself. */
async function openSocketClient(
  ctx: CommandContext,
  client: NyxBaileys,
  timeoutMs: number,
): Promise<{ open: boolean }> {
  try {
    await client.connect();
  } catch (err) {
    const diagnosis = diagnoseConnectError(err);
    throw new CliError(EXIT.failure, diagnosis.message, diagnosis.next);
  }
  return { open: await waitForOpen(client, timeoutMs) };
}

/* ── registry ─────────────────────────────────────────────────────── */

/**
 * Command table. `main.ts` dispatches on these names, so the order here is the
 * order of `--help`.
 */
export const COMMANDS: Readonly<Record<string, { spec: CommandSpec; run: Command }>> = {
  pair: { spec: pairSpec, run: cmdPair },
  status: { spec: statusSpec, run: cmdStatus },
  send: { spec: sendSpec, run: cmdSend },
  form: { spec: formSpec, run: cmdForm },
  logs: { spec: logsSpec, run: cmdLogs },
  sessions: { spec: sessionsSpec, run: cmdSessions },
  health: { spec: healthSpec, run: cmdHealth },
  selftest: { spec: selftestSpec, run: cmdSelftest },
};

export const COMMAND_SPECS: readonly CommandSpec[] = Object.values(COMMANDS).map((entry) => entry.spec);

/** Flags every command shares. `--no-color` works because `color` is boolean. */
export const GLOBAL_FLAGS: readonly FlagSpec[] = [
  { name: 'json', kind: 'boolean', describe: 'Print one JSON object on stdout instead of formatted text' },
  { name: 'dir', kind: 'string', short: 'd', placeholder: '<path>', describe: 'Session directory ($SESSION_DIR, default ./session)' },
  { name: 'level', kind: 'string', short: 'l', placeholder: '<level>', describe: `Log level: ${LOG_LEVELS.join(' | ')} ($LOG_LEVEL, default info)` },
  { name: 'color', kind: 'boolean', default: true, describe: 'Colour output; --no-color or NO_COLOR disables it' },
];