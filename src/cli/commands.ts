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

import { appendFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { createFormFlow, infoRow, radioRow } from '../core/nodes.js';
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
import type { HealthReport } from '../utils/types.js';

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
  readonly sessionDir: string;
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
}

interface SessionRecord {
  readonly name: string;
  readonly path: string;
  readonly exists: boolean;
  readonly registered: boolean;
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
    registered: creds?.registered === true,
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

/** Send through the framework's own resolution path so `@lid` works. */
async function sendText(client: NyxBaileys, target: string, text: string): Promise<{ target: string; id: string | undefined; timestamp: number | undefined }> {
  const ext = extensions(client);
  const resolved = (await ext.resolveJid?.(target)) ?? target;
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
  summary: 'Pair a number by scanning a QR code.',
  positionals: [],
  flags: [
    { name: 'timeout', kind: 'number', default: 180, placeholder: '<seconds>', describe: 'How long to wait for the QR to be scanned' },
    { name: 'connect-timeout', kind: 'number', default: 60, placeholder: '<seconds>', describe: 'How long to wait for the socket to open' },
  ],
  examples: ['nyx-baileys pair', 'nyx-baileys pair --dir ./session --timeout 300'],
  notes: [
    'WhatsApp → Linked devices → Link a device, then either scan the QR or enter the phone code.',
    'rc14 removed terminal QR rendering: the pairing ref arrives on connection.update and this command prints it. Use the 8-character phone code, which needs no scanner.',
    'Already paired? This command says so and changes nothing. To pair a different number, run `sessions remove` first.',
  ],
};

async function cmdPair(ctx: CommandContext): Promise<ExitCode> {
  const { args, io } = ctx;
  const pairTimeout = flagNumber(args, 'timeout', 180) * 1000;
  const connectTimeout = flagNumber(args, 'connect-timeout', 60) * 1000;

  const existing = await readSession(ctx.env.sessionDir);
  if (existing.registered) {
    io.status(true, `already paired as ${existing.jid ?? 'unknown number'} (${existing.path})`);
    io.line();
    io.line('To pair a different number: nyx-baileys sessions remove');
    io.emit('pair', { paired: true, alreadyPaired: true, number: existing.jid, dir: existing.path });
    return EXIT.ok;
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

  // rc14 stopped rendering the QR in the terminal and emits it here instead.
  // Capture every rotation: only the newest ref is valid, and a plain ref
  // beats a stale matrix.
  const pairing = { qr: null as string | null, code: null as string | null };
  ctx.lifecycle.add(
    client.on('connection.update', (update: ConnectionUpdate) => {
      if (update.pairingCode && update.pairingCode !== pairing.code) {
        pairing.code = update.pairingCode;
      }
      if (update.qr && update.qr !== pairing.qr) {
        pairing.qr = update.qr;
      }
      if (!io.json) announcePairing(io, pairing);
    }),
  );

  if (!io.json) {
    io.line('Scan in WhatsApp → Linked devices → Link a device.');
    io.line('Waiting for the QR to be scanned…');
    io.line();
  }

  if (!sock.authState.creds.registered) {
    const result = await waitForPairing(client, pairTimeout, pairing, io);
    if (!result.ok) {
      const code = pairing.code ? ` Phone code: ${pairing.code}.` : '';
      throw new CliError(
        EXIT.notPaired,
        result.reason === 'timeout'
          ? `no QR scan within ${formatDuration(pairTimeout)}.${code}`
          : `the socket closed before pairing completed.${code}`,
        'run `nyx-baileys pair` again and scan within the window',
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
  if (pairing.code) {
    io.fields([['phone code', formatPairingCode(pairing.code)]]);
  }
  if (pairing.qr) {
    io.fields([['qr ref', pairing.qr]]);
  }
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
): Promise<{ ok: boolean; reason: 'timeout' | 'closed' | 'paired' }> {
  if (pairing.code || pairing.qr) announcePairing(io, pairing);

  return new Promise<{ ok: boolean; reason: 'timeout' | 'closed' | 'paired' }>((resolve) => {
    let offCreds: (() => void) | null = null;
    let offConnection: (() => void) | null = null;

    const settle = (ok: boolean, reason: 'timeout' | 'closed' | 'paired'): void => {
      clearTimeout(timer);
      offCreds?.();
      offConnection?.();
      resolve({ ok, reason });
    };

    const timer = setTimeout(() => settle(false, 'timeout'), timeoutMs);

    offCreds = client.on('creds.update', () => {
      if (client.sock.authState.creds.registered) settle(true, 'paired');
    });
    offConnection = client.onConnection((phase) => {
      if (phase === 'close') settle(false, 'closed');
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
  const target = (await ext.resolveJid?.(jid)) ?? jid;

  // `createFormFlow` returns upstream's generated `IWebMessageInfo`; sendMessage
  // takes a narrower union, so the cast mirrors what the library demo does.
  const sent = await client.sock.sendMessage(target, form as never);
  const messageId = sent?.key?.id ?? null;

  io.status(true, `form sent to ${target}`);
  if (!io.json) {
    io.line();
    io.table(
      ['section', 'rows', 'kind'],
      shape.sectionList.map((section) => [
        section.title,
        String(section.rows),
        section.selectable === section.rows ? 'radio' : section.selectable === 0 ? 'info' : 'mixed',
      ]),
      { align: ['left', 'right', 'left'] },
    );
    io.line();
    io.fields([
      ['kind', 'nativeFlowMessage'],
      ['sections', String(shape.sections)],
      ['rows', `${shape.rows} (${shape.selectable} selectable, ${shape.info} info)`],
      ['cta', shape.cta],
    ]);
  }
  io.emit('form', { sent: true, requested: jid, target, messageId, form: shape });
  return EXIT.ok;
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
};

export const COMMAND_SPECS: readonly CommandSpec[] = Object.values(COMMANDS).map((entry) => entry.spec);

/** Flags every command shares. `--no-color` works because `color` is boolean. */
export const GLOBAL_FLAGS: readonly FlagSpec[] = [
  { name: 'json', kind: 'boolean', describe: 'Print one JSON object on stdout instead of formatted text' },
  { name: 'dir', kind: 'string', short: 'd', placeholder: '<path>', describe: 'Session directory ($SESSION_DIR, default ./session)' },
  { name: 'level', kind: 'string', short: 'l', placeholder: '<level>', describe: `Log level: ${LOG_LEVELS.join(' | ')} ($LOG_LEVEL, default info)` },
  { name: 'color', kind: 'boolean', default: true, describe: 'Colour output; --no-color or NO_COLOR disables it' },
];