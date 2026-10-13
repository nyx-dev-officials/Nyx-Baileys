/**
 * The interactive pairing flow.
 *
 * Split out of `wizard.ts` so the prompts have their own file, but the split is
 * only one-directional on purpose. This module owns the number helpers, the
 * prompt sequence and the pairing attempt; `wizard.ts` owns process lifecycle
 * (session gate, socket construction, teardown) and imports from here. The first
 * draft of this extraction had the two files importing each other's helpers,
 * which is a cycle that initialises both partially — so nothing here imports
 * from `wizard.ts`.
 *
 * Nothing in this file fabricates a pairing. The code comes from
 * `requestPairingCode` and the symbol comes from the ref Baileys emits, both of
 * which are the real wire values.
 */

import process from 'node:process';

import { confirm, input, select } from '@inquirer/prompts';
import { Curve } from '@whiskeysockets/baileys';

import type { FluxMode } from '../core/flux-intro.js';
import type { NyxBaileys } from '../nyxBaileys.js';
import {
  codeFrame,
  eraseTerminalQr,
  qrFitsViewport,
  qrFrameSize,
  qrRowCount,
  renderTerminalQr,
  streamIo,
  type QrViewport,
} from './qr-display.js';
import {
  confirmPromptTheme,
  promptPageSize,
  selectPromptTheme,
  stageSize,
  textPromptTheme,
  type Stage,
  type StageCapabilities,
} from './stage.js';

/**
 * A documentation-format example, never a real subscriber number.
 *
 * There is deliberately **no default input number**. A pairing code is issued by
 * WhatsApp for one specific account: request a code for number A and enter it on
 * a device signed into number B and the app rejects it with "failed to link
 * device", which reads exactly like an expired code and sends you hunting in the
 * wrong place. Pre-filling someone's number made that silent mistake the default
 * path, so the field starts empty and the number is always deliberate.
 */
const EXAMPLE_NUMBER = '081234567890';

/** The operator-facing command prefix. One definition so the wizard handoff and the example bot cannot drift. */
export const FLUX_PREFIX = 'flux ';

/** How long a pairing code stays usable once issued. */
const CODE_TTL_MS = 30_000;

/** Grace past the nominal TTL while the server still honours a code. */
const CODE_GRACE_MS = 5_000;

/** Forced pause between code attempts so retries do not read as abuse. */
const CODE_COOLDOWN_MS = 10_000;

/** Warn about throttling once attempts reach this count. */
const THROTTLE_WARNING_ATTEMPTS = 3;

/** How long one QR watch window lasts before offering retry choices. */
const QR_WINDOW_MS = 180_000;

/** How long to wait for the post-pairing reconnect before giving up. */
const SETTLE_TIMEOUT_MS = 45_000;

/** How long WhatsApp keeps a pairing code usable. */
const PAIRING_CODE_TTL_SECONDS = CODE_TTL_MS / 1000;

/**
 * Wait for the link to settle before tearing down.
 *
 * After the server confirms pairing it sends 515 and both sides must reconnect
 * with the new credentials. Resolving success and disposing immediately strands
 * the phone mid-login: it completed its side and waits for a companion that
 * never returns, which reads as an endless "signing in" loop with
 * registered=true locally. Observed exactly that shape.
 */
export async function waitForSettle(
  getState: () => string,
  options?: { timeoutMs?: number; onTick?: (remainingMs: number) => void },
): Promise<boolean> {
  const timeoutMs = options?.timeoutMs ?? SETTLE_TIMEOUT_MS;
  const started = Date.now();
  for (;;) {
    if (getState() === 'open') return true;
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) return false;
    options?.onTick?.(remaining);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** How long to wait for a first QR ref when none has been retained. */
const QR_WAIT_MS = 20_000;

/**
 * Block until the socket can carry a message.
 *
 * Measured on this account: requesting a code immediately after `connect()`
 * throws Boom 428 "Connection Closed"; waiting for `connection === 'open'`
 * never returns at all, because an unregistered session has no completed auth;
 * the first `qr` arrives about a second in and a code requested 70ms later
 * succeeds. So the QR ref — not the connection state — is the readiness signal.
 */
async function ensureTransport(ctx: PairingFlowContext): Promise<void> {
  const { client, note } = ctx;
  if (client.lastQr) return;
  const ref = await client.waitForQr(QR_WAIT_MS).catch(() => null);
  if (!ref) throw new Error('The socket never became ready. Check your connection and run flux again.');
  note('socket ready');
}

export interface PairingFlowContext {
  readonly stage: Stage;
  readonly client: NyxBaileys;
  readonly sessionDir: string;
  readonly capabilities: StageCapabilities;
  /** Repaint the pinned dashboard from live state. */
  readonly refresh: () => void;
  /** Append a line to the dashboard's console feed. */
  readonly note: (entry: string) => void;
  /** Force a dashboard density, or pass `undefined` to return to automatic. */
  readonly setMode: (mode: FluxMode | undefined) => void;
  /** A number supplied non-interactively; skips the Identity prompt when set. */
  readonly phoneDigits?: string | null;
  /** Redacted event recorder. Omitted in tests that never touch the wire. */
  readonly diag?: PairingDiagnostics;
}

/**
 * Extract `--phone <number>` or `--phone=<number>` from argv.
 *
 * Returns the raw value for validation upstream — never normalised here, so a
 * typo fails loudly at the flag instead of silently pairing the wrong account.
 */
export function parsePhoneFlag(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--phone' && i + 1 < argv.length) return argv[i + 1] ?? null;
    if (arg.startsWith('--phone=')) {
      const value = arg.slice('--phone='.length);
      return value ? value : null;
    }
  }
  return null;
}

export type PairingFlowOutcome =
  | { readonly kind: 'exit' }
  | { readonly kind: 'config' }
  | { readonly kind: 'purge' }
  | { readonly kind: 'already-linked' }
  | { readonly kind: 'paired'; readonly jid: string; readonly digits: string }
  | { readonly kind: 'failed'; readonly reason: string };

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * True when we may draw cursor-movement and typing effects.
 *
 * A piped stdout is a consumer, not a person: moving the cursor or emitting half
 * a line corrupts whatever is reading it.
 */
export function interactive(out: NodeJS.WriteStream = process.stdout): boolean {
  return Boolean(out.isTTY) && !process.env.FLUX_NO_ANIMATION;
}

/** Type a line out one character at a time. No-op when not interactive. */
export async function streamText(
  text: string,
  speedMs = 25,
  colorCode = '\x1b[36m',
  out: NodeJS.WriteStream = process.stdout,
): Promise<void> {
  if (!interactive(out)) {
    out.write(`${text}\n`);
    return;
  }
  out.write(colorCode);
  for (const char of text) {
    out.write(char);
    await sleep(speedMs);
  }
  out.write('\x1b[0m\n');
}

/** Strip formatting, then rewrite a local `08…` number into `62…`. */
export function normaliseNumber(raw: string): string {
  const digits = raw.replace(/[^0-9]/g, '');
  if (!digits) return '';
  if (digits.startsWith('62')) return digits;
  if (digits.startsWith('0')) return `62${digits.slice(1)}`;
  return digits;
}

/** True when the caller wrote the local form rather than the international one. */
export function isLocalNumber(raw: string): boolean {
  return raw.replace(/[^0-9]/g, '').startsWith('0');
}

/**
 * Indonesian mobile validation.
 *
 * Both forms are accepted — `08…` and `62…` — because the local form is what
 * operators actually type and rejecting it only taught them the rule. Earlier
 * revisions normalised `08…` silently and then told the user to "use the
 * international format", so their own number came back rejected with no
 * explanation of the contradiction.
 *
 * Length is checked after normalisation against the real plan: `62` + area code
 * (2–3 digits) + subscriber (7–10 digits), so 11–15 digits. A local number is
 * therefore 10–14 digits including its leading zero.
 */
export function validateIndonesianNumber(value: string): true | string {
  const digits = value.replace(/[^0-9]/g, '');
  if (!digits) return 'Masukkan nomor WhatsApp Anda.';

  if (!digits.startsWith('0') && !digits.startsWith('62')) {
    return `Gunakan format 08… (contoh: ${EXAMPLE_NUMBER}) atau 62…`;
  }

  const international = normaliseNumber(value);
  if (international.length < 11 || international.length > 15) {
    return `Nomor Indonesia 11–15 digit setelah awalan 62. Contoh: ${EXAMPLE_NUMBER}`;
  }
  return true;
}

interface PairingResult {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Redacted pairing diagnostics.
 *
 * Records tags, codes and timings — never refs, pairing codes, keys, JIDs or
 * message content — so the rendered block is safe to paste into a bug report.
 * Redaction is structural, not by review: there is simply no field for a
 * secret, so a future edit cannot leak one by logging "the event".
 */
export class PairingDiagnostics {
  private readonly started = Date.now();
  private readonly events: Array<{ at: string; event: string }> = [];

  record(event: string): void {
    const seconds = (Date.now() - this.started) / 1000;
    this.events.push({ at: `+${seconds.toFixed(1)}s`, event });
  }

  render(): string[] {
    if (this.events.length === 0) return ['(no pairing events recorded)'];
    const width = Math.max(...this.events.map((entry) => entry.at.length));
    return this.events.map((entry) => `  ${entry.at.padStart(width)}  ${entry.event}`);
  }
}

/**
 * Link watcher — the smallest surface `waitForLink` needs.
 *
 * The real client satisfies this structurally; tests use a fake event map.
 * Depending on the whole client here would drag the socket type into every test
 * that wants to prove the wait logic.
 */
export interface LinkWatcher {
  on(event: 'creds.update', handler: () => void): () => void;
  isLinked(): boolean;
}

/** `30000` reads badly on a countdown; `0:30` does not. */
export function formatCountdown(remainingMs: number): string {
  const total = Math.max(0, Math.ceil(remainingMs / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Resolve true the moment the watcher reports a linked session.
 *
 * Resolves false on timeout. Always detaches — a listener left behind fires on
 * every later creds change for a wait that already ended, which is how a stale
 * callback resolves the wrong attempt.
 */
export function waitForLink(
  watcher: LinkWatcher,
  timeoutMs: number,
  onTick?: (remainingMs: number) => void,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const started = Date.now();
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let ticker: NodeJS.Timeout | undefined;
    let off: () => void = () => undefined;
    const settle = (value: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (ticker) clearInterval(ticker);
      off();
      resolve(value);
    };
    off = watcher.on('creds.update', () => {
      if (watcher.isLinked()) settle(true);
    });
    timer = setTimeout(() => settle(false), timeoutMs);
    if (onTick) {
      onTick(timeoutMs);
      ticker = setInterval(() => {
        const remaining = timeoutMs - (Date.now() - started);
        if (remaining <= 0) settle(false);
        else onTick(remaining);
      }, 250);
    }
    if (watcher.isLinked()) settle(true);
  });
}

function linkWatcherFor(client: NyxBaileys): LinkWatcher {
  return {
    on: (event, handler) => client.on(event, handler),
    isLinked: () => client.sock.authState.creds.registered === true,
  };
}

/** Pause between attempts so rapid retries do not read as abuse, with a visible clock. */
async function pauseWithCountdown(ms: number, label: string): Promise<void> {
  const started = Date.now();
  process.stdout.write('\n');
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      const remaining = ms - (Date.now() - started);
      if (remaining <= 0) {
        process.stdout.write('\r\x1b[0K');
        clearInterval(timer);
        resolve();
        return;
      }
      process.stdout.write(`\r\x1b[0K  ${label}… ${formatCountdown(remaining)}`);
    }, 250);
  });
}

type NextStep = 'linked' | 'exit' | 'pairing_code' | 'qr_code';

function rotateEphemeral(sock: NyxBaileys['sock']): void {
  // Fresh ephemeral keys for every attempt.
  //
  // Baileys generates `pairingEphemeralKeyPair` once in `initAuthCreds` and then
  // reuses the stored pair on every `requestPairingCode` call — it is persisted
  // to creds.json, so retries in the same session directory replay the same
  // handshake material indefinitely. A code cryptographically bound to a stale
  // attempt is exactly the kind of thing a server rejects while generating
  // cleanly, which matches this failure shape: codes appear, the phone refuses
  // them. Rotating the pair per attempt makes each request independent of all
  // previous failures in the directory. The creds type marks the field readonly,
  // so this goes through a mutable view — the same mutation `requestPairingCode`
  // itself performs on `pairingCode` and `me`.
  const mutableCreds = sock.authState.creds as { -readonly [K in keyof typeof sock.authState.creds]: (typeof sock.authState.creds)[K] };
  mutableCreds.pairingEphemeralKeyPair = Curve.generateKeyPair();
}

async function askCodeRetry(ctx: PairingFlowContext, attempts: number): Promise<NextStep> {
  const { stage, capabilities } = ctx;
  stage.section('Code expired', [`Attempt ${attempts} produced no link.`]);
  const choice = await select({
    message: 'The code expired. What next?',
    choices: [
      { name: 'New code', value: 'fresh' as const, description: 'Request a fresh 8-digit code' },
      { name: 'QR instead', value: 'qr' as const, description: 'Switch to QR scan' },
      { name: 'Exit', value: 'exit' as const, description: 'Leave without pairing' },
    ],
    pageSize: promptPageSize(stage.size().rows, stage.headerHeightValue(), 3),
    loop: true,
    theme: selectPromptTheme(capabilities.color, capabilities.unicode),
  });
  if (choice === 'exit') return 'exit';
  return choice === 'qr' ? 'qr_code' : 'pairing_code';
}

async function askQrRetry(ctx: PairingFlowContext): Promise<NextStep> {
  const { stage, capabilities } = ctx;
  stage.section('Still waiting', ['No link yet. The QR keeps rotating on its own.']);
  const choice = await select({
    message: 'Keep waiting?',
    choices: [
      { name: 'Keep waiting', value: 'wait' as const, description: 'Watch for another 3 minutes' },
      { name: 'Code instead', value: 'code' as const, description: 'Switch to an 8-digit code' },
      { name: 'Exit', value: 'exit' as const, description: 'Leave without pairing' },
    ],
    pageSize: promptPageSize(stage.size().rows, stage.headerHeightValue(), 3),
    loop: true,
    theme: selectPromptTheme(capabilities.color, capabilities.unicode),
  });
  if (choice === 'exit') return 'exit';
  return choice === 'code' ? 'pairing_code' : 'qr_code';
}

async function runCodeAttempt(
  ctx: PairingFlowContext,
  digits: string,
  attempts: number,
  diag: PairingDiagnostics,
): Promise<NextStep> {
  const { client } = ctx;
  const sock = client.sock;

  if (attempts > 1) {
    diag.record('cooldown');
    await pauseWithCountdown(CODE_COOLDOWN_MS, 'cooling down to avoid throttling');
  }
  if (attempts >= THROTTLE_WARNING_ATTEMPTS) {
    diag.record('throttle-warning');
    process.stdout.write(
      '  Heads up: WhatsApp throttles rapid code requests. If this fails, wait a few minutes before trying again.\n',
    );
  }

  // Wait for the transport before asking. `connect()` resolves once the plugins
  // are applied, not once the WebSocket is usable, so requesting immediately
  // fails with Boom 428 "Connection Closed".
  //
  // Waiting for `connection === 'open'` does NOT work either: on an
  // unregistered session auth has not completed, so `open` never arrives and the
  // wait hangs until it times out. The first `qr` is the reliable signal that
  // the handshake has gone far enough to carry a message.
  //
  // Measured on this account: 428 immediately, `open` never, success 70ms after
  // the first QR.
  await ensureTransport(ctx);

  await streamText(`  requesting 8-digit pairing code for +${digits}… (attempt ${attempts})`, 18, '\x1b[36m');
  rotateEphemeral(sock);
  // The real code from the wire. Never a placeholder: a fabricated code sends
  // the operator to WhatsApp with eight meaningless digits.
  let code: string;
  try {
    diag.record('code-requested');
    code = await sock.requestPairingCode(digits);
  } catch (err) {
    diag.record('code-failed');
    process.stdout.write(`  request failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return askCodeRetry(ctx, attempts);
  }
  diag.record('code-displayed');
  process.stdout.write(`\n${codeFrame(code, (s) => `\x1b[1m${s}\x1b[0m`)}\n\n`);
  process.stdout.write('  WhatsApp → Linked devices → Link with phone number\n');
  process.stdout.write(`  Code for +${digits} — expires in about ${PAIRING_CODE_TTL_SECONDS}s. Enter it promptly.\n\n`);

  const linked = await waitForLink(linkWatcherFor(client), CODE_TTL_MS + CODE_GRACE_MS, (remaining) => {
    process.stdout.write(`\r\x1b[0K  waiting for the phone to link… ${formatCountdown(remaining)}`);
  });
  process.stdout.write('\r\x1b[0K');
  diag.record(linked ? 'link-observed' : 'window-expired');
  if (linked) return 'linked';
  return askCodeRetry(ctx, attempts);
}

async function runQrWindow(
  ctx: PairingFlowContext,
  state: { drawn: string | null; drawnRows: number },
  diag: PairingDiagnostics,
): Promise<NextStep> {
  const { client, stage, capabilities } = ctx;

  // Draw whatever ref is already in hand. Baileys emits its first one about a
  // second after the socket opens, but this point is reached only after the menu,
  // the number and the method — by which time that ref is spent. Waiting for the
  // next rotation means about twenty seconds of blank terminal, which reads as a
  // hang.
  await ensureTransport(ctx);
  const ref = state.drawn ?? client.lastQr;
  if (!ref) throw new Error('No pairing QR arrived. Run flux again.');

  // Validate against the *real* ref. Sizing a stand-in string measures the wrong
  // symbol: a short mock encodes to version 1 (19x35) while a live ref is version
  // 11 (37x71), so a mock always "fits" and the guard never fires.
  const frame = qrFrameSize(ref);
  if (!frame) {
    process.stdout.write('  The pairing QR could not be encoded. Switching to a pairing code.\n');
    return 'pairing_code';
  }
  const viewport = qrViewport(stage);
  if (!qrFitsViewport(frame, viewport)) {
    process.stdout.write(
      `  This terminal is ${viewport.columns}x${viewport.rows}, but the QR needs ${frame.columns}x${frame.rows}. Switching to a pairing code.\n`,
    );
    return 'pairing_code';
  }

  const io = streamIo(process.stdout, capabilities.color);
  if (ref !== state.drawn) {
    renderTerminalQr(io, ref);
    state.drawn = ref;
    state.drawnRows = qrRowCount(io, ref);
    diag.record('qr-drawn');
  }

  // Each ref is a distinct, expiring symbol. Follow rotations and replace the
  // previous block rather than stacking another forty rows under the last.
  const offQr = client.on<{ qr?: string }>('connection.update', (update) => {
    if (!update.qr || update.qr === state.drawn) return;
    const nextFrame = qrFrameSize(update.qr);
    if (!nextFrame || !qrFitsViewport(nextFrame, qrViewport(stage))) return;
    eraseTerminalQr(io, state.drawnRows);
    state.drawn = update.qr;
    renderTerminalQr(io, state.drawn);
    state.drawnRows = qrRowCount(io, state.drawn);
    ctx.note('received a rotated QR');
    diag.record('qr-rotated');
    // No prompt is active while a QR is on screen, so repainting here is safe
    // and keeps the dashboard's console feed truthful mid-scan.
    ctx.refresh();
  });
  try {
    const linked = await waitForLink(linkWatcherFor(client), QR_WINDOW_MS, (remaining) => {
      process.stdout.write(`\r\x1b[0K  watching for the link… ${formatCountdown(remaining)}`);
    });
    process.stdout.write('\r\x1b[0K');
    if (linked) return 'linked';
    return askQrRetry(ctx);
  } finally {
    offQr();
  }
}

/**
 * Run pairing to completion across either method.
 *
 * Both methods resolve on `creds.update` reporting registration, because that —
 * not a clean request return — is what means the device is actually linked. A
 * failed attempt returns to a menu instead of killing the wizard: a fresh code,
 * a method switch, or an exit, all without reconnecting or retyping the number.
 */
async function runPairing(
  ctx: PairingFlowContext,
  digits: string,
  method: 'pairing_code' | 'qr_code',
): Promise<PairingResult> {
  const diag = ctx.diag ?? new PairingDiagnostics();
  // Watch the transport for the whole attempt: connection values and close codes
  // are the only server-side evidence available when the phone rejects a code.
  const offConn = ctx.client.on<{
    connection?: string;
    qr?: string;
    lastDisconnect?: { error?: { output?: { statusCode?: number } } };
  }>('connection.update', (update) => {
    if (update.qr) diag.record(`qr:${update.qr.length}b`);
    if (update.connection === 'close') {
      diag.record(`close:${update.lastDisconnect?.error?.output?.statusCode ?? 'unknown'}`);
    } else if (update.connection) {
      diag.record(`connection:${update.connection}`);
    }
  });
  const report = (): void => {
    process.stdout.write('\n  Pairing diagnostics (tags and timings only — no keys, codes or numbers):\n');
    for (const line of diag.render()) process.stdout.write(`${line}\n`);
    process.stdout.write('\n');
  };
  try {
    let current = method;
    let codeAttempts = 0;
    const qrState = { drawn: null as string | null, drawnRows: 0 };
    for (;;) {
      if (current === 'pairing_code') {
        codeAttempts += 1;
        diag.record(`attempt:${codeAttempts}:code`);
        const next = await runCodeAttempt(ctx, digits, codeAttempts, diag);
        if (next === 'linked') { report(); return { ok: true }; }
        if (next === 'exit') { report(); return { ok: false, reason: 'Pairing cancelled.' }; }
        diag.record(`retry:${next}`);
        current = next;
      } else {
        diag.record('attempt:qr');
        const next = await runQrWindow(ctx, qrState, diag);
        if (next === 'linked') { report(); return { ok: true }; }
        if (next === 'exit') { report(); return { ok: false, reason: 'Pairing cancelled.' }; }
        diag.record(`retry:${next}`);
        current = next;
      }
    }
  } catch (err) {
    report();
    throw err;
  } finally {
    offConn();
  }
}

function qrViewport(stage: Stage): QrViewport {
  const size = stageSize(process.stdout);
  return {
    rows: size.rows,
    columns: size.columns,
    headerHeight: stage.headerHeightValue(),
  };
}

/**
 * Run the prompt sequence.
 *
 * Returns a description of what happened and never exits the process itself —
 * the caller owns teardown, so the socket is always disposed on one code path.
 */
export async function runPairingFlow(ctx: PairingFlowContext): Promise<PairingFlowOutcome> {
  const { stage, client, capabilities } = ctx;

  stage.section('Welcome', ['The dashboard above stays visible while you choose.']);
  await sleep(400);
  await streamText('Initialising secure pipeline…', 20, '\x1b[90m');
  await streamText('Welcome to the FLUX runtime.', 35, '\x1b[1m\x1b[37m');
  stage.receipt(['Runtime ready']);

  stage.section('Action', ['Use arrow keys and Enter.']);
  const action = await select({
    message: 'What are you going to do today?',
    choices: [
      { name: 'Connect FLUX', value: 'connect', description: 'Pair this device with a code or QR' },
      { name: 'Inspect security', value: 'config', description: 'Show live session and security state' },
      { name: 'Purge session', value: 'purge', description: 'Delete the local session after confirmation' },
      { name: 'Exit', value: 'exit', description: 'Leave without changing anything' },
    ],
    pageSize: promptPageSize(stage.size().rows, stage.headerHeightValue(), 4),
    loop: true,
    theme: selectPromptTheme(capabilities.color, capabilities.unicode),
  });
  ctx.note(`Selected ${action}`);
  stage.receipt([`Selected ${action}`]);
  ctx.refresh();

  if (action === 'exit') return { kind: 'exit' };
  if (action === 'config') return { kind: 'config' };
  if (action === 'purge') return { kind: 'purge' };

  stage.section('Identity', [
    'Enter the number of the account on YOUR phone.',
    'WhatsApp issues the code for this exact number.',
  ]);
  let digits: string;
  if (ctx.phoneDigits) {
    // Non-interactive path, validated by the caller before connecting. Re-check
    // defensively: pairing the wrong account fails on the phone in a way that
    // reads exactly like an expired code, so a bad flag must never slide through.
    const verdict = validateIndonesianNumber(ctx.phoneDigits);
    if (verdict !== true) {
      return { kind: 'failed', reason: typeof verdict === 'string' ? verdict : 'Invalid --phone number.' };
    }
    digits = normaliseNumber(ctx.phoneDigits);
    ctx.note(`Using +${digits} (from --phone)`);
    stage.receipt([`Using +${digits} (from --phone)`]);
  } else {
    const raw = await input({
      message: 'WhatsApp number:',
      validate: validateIndonesianNumber,
      // No default and no prefill, on purpose.
      //
      // `prefill: 'editable'` seeds the buffer, so typing appends to it — entering
      // a number over a seeded buffer yields the two concatenated and then fails
      // validation with a message that reads like a typo. A default invites a worse
      // error still: a code requested for one account and entered on another is
      // rejected by WhatsApp as "failed to link device", which is indistinguishable
      // from an expired code. The number must be typed deliberately, every time.
      theme: textPromptTheme(capabilities.color),
    });
    digits = normaliseNumber(raw);
    ctx.note(`Entered +${digits}`);
    stage.receipt([`Entered +${digits}`]);
  }
  ctx.refresh();

  stage.section('Method', ['Choose how you want to link this device.']);
  const method = await select({
    message: 'Select authentication method:',
    choices: [
      { name: '8-digit pairing code', value: 'pairing_code', description: 'Recommended: type it into WhatsApp' },
      {
        name: 'QR code scan',
        value: 'qr_code',
        description: 'Renders a scannable symbol below (needs a tall window)',
        // No upfront disable here, on purpose. The viewport can only be judged
        // once the dashboard has switched to its slim QR density — measuring
        // against the full header wrongly disables QR on terminals where it fits
        // fine. runQrWindow performs the real check against the slim header and
        // auto-switches to a code with an explanation when it truly cannot fit.
      },
    ],
    pageSize: promptPageSize(stage.size().rows, stage.headerHeightValue(), 2),
    loop: true,
    theme: selectPromptTheme(capabilities.color, capabilities.unicode),
  });
  ctx.note(`Selected ${method === 'pairing_code' ? 'pairing code' : 'QR code'}`);
  stage.receipt([`Selected ${method === 'pairing_code' ? 'pairing code' : 'QR code'}`]);
  if (method === 'qr_code') {
    // The QR needs 37 rows; a full dashboard would push it off the screen.
    ctx.setMode(stage.size().rows < 30 ? 'minimal' : 'compact');
  }
  ctx.refresh();

  stage.section('Pairing', [
    'Open WhatsApp → Linked devices → Link with phone number FIRST.',
    `The code is only valid for about ${PAIRING_CODE_TTL_SECONDS} seconds.`,
    `Provisioning socket for +${digits}…`,
  ]);
  if (client.sock.authState.creds.registered) return { kind: 'already-linked' };

  const result = await runPairing(ctx, digits, method);
  if (!result.ok) return { kind: 'failed', reason: result.reason ?? 'Pairing failed.' };

  // Let the post-pairing reconnect land before tearing down. The server sends
  // 515 right after confirming, and only a rebuilt socket reporting open means
  // the phone will see its companion. Disposing first strands the phone in its
  // sign-in loop with a locally-registered session.
  const settled = await waitForSettle(() => client.connectionState.state, {
    timeoutMs: SETTLE_TIMEOUT_MS,
    onTick: (remaining) => {
      process.stdout.write(`\r\x1b[0K  waiting for the link to settle… ${formatCountdown(remaining)}`);
    },
  });
  process.stdout.write('\r\x1b[0K');
  if (!settled) {
    ctx.note('link registered but the socket never reported open');
  }

  const jid = client.sock.user?.id ?? client.sock.authState.creds.me?.id ?? 'unknown';
  ctx.setMode(undefined);
  ctx.note(`Linked ${jid}`);
  ctx.refresh();
  return { kind: 'paired', jid, digits };
}

/** Confirmation used by the destructive session purge. */
export async function confirmPurge(
  capabilities: StageCapabilities,
  message: string,
): Promise<boolean> {
  return confirm({ message, default: false, theme: confirmPromptTheme(capabilities.color) });
}