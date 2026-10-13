/**
 * Wizard lifecycle.
 *
 * Owns the process-level concerns only: the session gate, constructing the
 * client, the pinned stage, and teardown. The prompts and the pairing attempt
 * live in `./pairing-flow.ts`.
 *
 * The split is one-directional. An earlier revision had these two files import
 * each other's helpers, which is a module cycle that initialises both partially;
 * `wizard.ts` depends on `pairing-flow.ts` and nothing depends back on it.
 *
 * Two constraints shaped the original file and still apply:
 *
 *  - **`printQRInTerminal` is a no-op in rc14.** Baileys dropped the built-in QR
 *    printer, so the ref is rendered by the in-repo encoder instead. Passing the
 *    old flag prints nothing and looks like it worked.
 *  - **The dashboard is pinned with a scroll region**, so prompts and the QR
 *    scroll underneath it without pushing it off screen.
 */

import { rm } from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import process from 'node:process';

import { DisconnectReason } from '@whiskeysockets/baileys';
import { confirm } from '@inquirer/prompts';

import { Stage, confirmPromptTheme } from './stage.js';
import { FileSessionStore } from '../core/session-store.js';
import { commands, type CommandSpec } from '../plugins/commands.js';
import { fluxMenuTap } from '../toolkit/flux-menu.js';
import { installGracefulShutdown } from '../bot/index.js';
import { renderFluxIntro, type FluxMode } from '../core/flux-intro.js';
import { readSession } from './commands.js';
import { createNyxBaileys } from '../nyxBaileys.js';
import { antiDelete } from '../plugins/anti-delete.js';
import type { NyxBaileys } from '../nyxBaileys.js';
import type { SuperOptions } from '../utils/types.js';
import {
  FLUX_PREFIX,
  confirmPurge,
  formatCountdown,
  interactive,
  normaliseNumber,
  PairingDiagnostics,
  parsePhoneFlag,
  runPairingFlow,
  streamText,
  validateIndonesianNumber,
  type PairingFlowContext,
  type PairingFlowOutcome,
} from './pairing-flow.js';
import { buildFullRegistry, registryToSpecs } from '../toolkit/registry-full.js';
import { configureAiState, fluxConfigFile, readFluxFile } from '../toolkit/ai-state.js';
import { aiGate } from '../plugins/ai-gate.js';

export {
  FLUX_PREFIX,
  formatCountdown,
  isLocalNumber,
  normaliseNumber,
  PairingDiagnostics,
  parsePhoneFlag,
  runPairingFlow,
  streamText,
  validateIndonesianNumber,
  waitForLink,
  waitForSettle,
} from './pairing-flow.js';
export type { LinkWatcher, PairingFlowContext, PairingFlowOutcome } from './pairing-flow.js';

const DEFAULT_SESSION_DIR = './session';

interface DashboardState {
  readonly stage: Stage;
  readonly client: NyxBaileys | null;
  readonly sessionDir: string;
  readonly activity: string[];
  readonly frame: number;
  readonly mode?: FluxMode;
  readonly linkedNumber?: string | null;
}

function dashboardLines(state: DashboardState): string[] {
  const size = state.stage.size();
  const capabilities = state.stage.capabilities();
  return renderFluxIntro({
    plugins: state.client?.chain ?? [],
    version: '0.3.1',
    colour: capabilities.color,
    unicode: capabilities.unicode,
    columns: size.columns,
    rows: size.rows,
    mode: state.mode,
    maxWidth: Math.min(Math.max(size.columns - 2, 52), 120),
    frame: state.frame,
    connection: state.client?.connectionState.state ?? null,
    activity: state.activity.slice(-2),
    sessionDir: state.sessionDir,
    linkedNumber: state.linkedNumber ?? null,
  }).split('\n');
}

/**
 * Decide whether pairing should proceed against `dir`, and against what.
 *
 * One directory, always. A registered or half-finished session is wiped in place
 * after one confirmation — never shunted to a `-2` directory. Proliferating
 * session dirs meant stale creds from dead attempts piled up next to live ones,
 * and nobody could tell which directory held the real pairing. A half-finished
 * session is caught before connecting — otherwise the operator sees three
 * silent 401s and a diagnosis that points at auth instead of the files on disk.
 */
async function resolveSessionDir(dir: string): Promise<{ dir: string } | { stop: string }> {
  const existing = await readSession(dir);
  const colour = new Stage(process.stdout).capabilities().color;

  if (existing.registered) {
    if (!interactive()) {
      return { stop: `${existing.path} is already paired as ${existing.jid ?? 'unknown'}.` };
    }
    const wipe = await confirm({
      message: `${existing.path} is already paired as ${existing.jid ?? 'unknown'}. Delete it and pair fresh here?`,
      default: true,
      theme: confirmPromptTheme(colour),
    });
    if (!wipe) return { stop: 'kept the existing session.' };
    await rm(dir, { recursive: true, force: true });
    return { dir };
  }

  if (existing.partial.length > 0) {
    if (!interactive()) {
      return { stop: `${existing.path} holds a half-finished pairing (${existing.partial.join(', ')}).` };
    }
    const wipe = await confirm({
      message: `${existing.path} holds a half-finished pairing (${existing.partial.join(', ')}) that cannot be resumed. Clear it?`,
      default: true,
      theme: confirmPromptTheme(colour),
    });
    if (!wipe) return { stop: 'left the half-finished pairing in place.' };
    await rm(dir, { recursive: true, force: true });
  }

  return { dir };
}

/**
 * Report what the running client actually has.
 *
 * These subsystems are configured at construction, so there is nothing to toggle
 * at runtime. Printing live values is honest; a screen of switches that do
 * nothing is not.
 */
function showSecurityState(client: NyxBaileys): string[] {
  const health = client.sock.authState?.creds?.registered;
  return [
    `linked device   ${health === undefined ? 'unknown' : health ? 'registered' : 'not linked'}`,
    `session dir     ${String(client.options.sessionDir)}`,
    `log level       ${String(client.options.logLevel)}`,
    `plugins applied ${client.applied.length}`,
    `patches live    ${client.patchCount}`,
    '',
    'Pacing, identity and warmup are set through SuperOptions at',
    'construction. The plugin chain above shows what actually loaded.',
  ];
}

async function purgeSession(
  capabilities: ReturnType<Stage['capabilities']>,
  sessionDir: string,
): Promise<string> {
  process.stdout.write(`\n  This deletes ${sessionDir} and unlinks the device.\n`);
  const ok = await confirmPurge(capabilities, '  Purge session?');
  if (!ok) return 'left the session in place.';
  await rm(sessionDir, { recursive: true, force: true });
  return `removed ${sessionDir}`;
}

function finish(outcome: PairingFlowOutcome, context: PairingFlowContext, sessionDir: string): {
  code: number;
  lines: string[];
} {
  switch (outcome.kind) {
    case 'exit':
      return { code: 0, lines: ['Wizard exited without changing anything.'] };
    case 'config':
      return { code: 0, lines: showSecurityState(context.client) };
    case 'purge':
      return { code: 0, lines: ['Purge choice complete.'] };
    case 'already-linked':
      return { code: 0, lines: ['Already linked — nothing to pair.'] };
    case 'paired':
      return { code: 0, lines: [`Linked as ${outcome.jid}`, `Session written to ${sessionDir}`] };
    case 'failed':
      return { code: 1, lines: [outcome.reason] };
  }
}

export interface SessionChoice {
  readonly dir: string;
  readonly remember: boolean;
}

/**
 * Pick the session directory by precedence: explicit flag, environment,
 * remembered, built-in fallback. Pure — the filesystem stays out of it so the
 * precedence is unit-testable.
 */
export function chooseSessionDir(options: {
  flag?: string | null;
  env?: string | null;
  remembered?: string | null;
  fallback: string;
}): SessionChoice {
  if (options.flag) return { dir: options.flag, remember: true };
  if (options.env) return { dir: options.env, remember: true };
  if (options.remembered) return { dir: options.remembered, remember: false };
  return { dir: options.fallback, remember: false };
}

export function loadRememberedDir(file: string = fluxConfigFile()): string | null {
  try {
    const dir = (JSON.parse(readFileSync(file, 'utf8')) as { sessionDir?: unknown }).sessionDir;
    return typeof dir === 'string' && dir ? dir : null;
  } catch {
    return null;
  }
}

export function saveRememberedDir(dir: string, file: string = fluxConfigFile()): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...readFluxFile(file), sessionDir: dir }));
}

function defaultSocketOptions(sessionDir: string): SuperOptions {
  return {
    sessionDir,
    logLevel: 'silent',
    warmupDays: 0,
    antiSpam: { minGapMs: 2_500, jitterMs: 4_000, maxPerMinute: 20 },
  };
}

/**
 * Attach the full bot surface to a live, paired socket: commands plugin for
 * future rebuilds plus an immediate manual apply for this socket, then all
 * registry specs. Returns the live spec count. Shared by the paired-outcome
 * handoff and the already-paired fast path so the two cannot drift.
 */
async function attachBotSurface(
  client: NyxBaileys,
  sessionDir: string,
  digits: string,
): Promise<number> {
  const reg = buildFullRegistry();
  const manualCtx = {
    sock: client.sock,
    state: new FileSessionStore({ dir: sessionDir, logger: client.log }),
    options: client.options,
    log: client.log,
    onDispose: () => {},
  };
  for (const plugin of [
    commands({ prefix: FLUX_PREFIX, groups: false, owners: [digits] }),
    fluxMenuTap(reg),
    aiGate({ owners: [digits], prefix: FLUX_PREFIX, sessionDir }),
  ]) {
    client.registerPlugin(plugin);
    await plugin.apply(manualCtx);
  }
  const surface = (client.sock as unknown as {
    commands?: { register: (spec: CommandSpec) => void };
  }).commands;
  if (!surface) throw new Error('wizard: commands plugin did not attach to the live socket');
  const specs = registryToSpecs(reg);
  for (const spec of specs) surface.register(spec);
  return specs.length;
}

/** Bare digits out of a session JID (`6288…:14@s.whatsapp.net` → `6288…`). */
export function digitsFromJid(jid: string | null | undefined): string {
  if (!jid) return '';
  return jid.split('@')[0]?.split(':')[0] ?? '';
}

export type ConnectionVerdict = 'open' | 'logged-out' | 'timeout';

/**
 * Wait for a fresh socket to declare itself.
 *
 * Polls rather than subscribing: event listeners die with their socket on
 * rebuild, but a verdict must survive the 515 restart that follows every
 * successful pairing. Resolves `logged-out` only on an explicit 401 — any
 * other close is someone else's story (reconnect owns those) and reads as
 * `timeout` here, which the caller treats as "proceed with doubt".
 */
export async function waitForConnection(
  getSnapshot: () => { state: string; lastDisconnectCode: number | null },
  options?: {
    timeoutMs?: number;
    pollMs?: number;
    loggedOutCode?: number;
    onTick?: (remainingMs: number) => void;
  },
): Promise<ConnectionVerdict> {
  const timeoutMs = options?.timeoutMs ?? 15_000;
  const pollMs = options?.pollMs ?? 500;
  const loggedOutCode = options?.loggedOutCode ?? DisconnectReason.loggedOut;
  const started = Date.now();
  for (;;) {
    const snapshot = getSnapshot();
    if (snapshot.state === 'open') return 'open';
    if (snapshot.lastDisconnectCode === loggedOutCode) return 'logged-out';
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) return 'timeout';
    options?.onTick?.(remaining);
    await new Promise((r) => setTimeout(r, Math.min(pollMs, remaining)));
  }
}

/**
 * Watch a running bot for a server-side logout and get out loudly.
 *
 * A logged-out session never recovers by waiting: the reconnect plugin already
 * treats 401 as terminal and stops retrying, so without this the process sits
 * on a dead socket forever — connected-looking, answering nothing. On logout
 * the session dir is wiped (server-proven dead, never a local guess) and the
 * callback runs, typically exiting with a re-pair code. Returns a stopper.
 */
export function watchForLogout(
  getCode: () => number | null,
  options: {
    intervalMs?: number;
    loggedOutCode?: number;
    onLogout: () => void;
  },
): () => void {
  const loggedOutCode = options.loggedOutCode ?? DisconnectReason.loggedOut;
  const timer = setInterval(() => {
    if (getCode() === loggedOutCode) {
      clearInterval(timer);
      options.onLogout();
    }
  }, options.intervalMs ?? 2000);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Entry point for `flux`.
 *
 * Resolves with an exit code instead of calling `process.exit`, so the socket is
 * always disposed through one path. The one exception is bot mode: after a
 * successful pairing — or when started against an already-paired session — the
 * process holds the live bot until Ctrl-C, and the graceful-shutdown handler
 * owns teardown from there.
 */
export async function bootstrap(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const dirFlag = argv.indexOf('--dir');
  const flagDir = dirFlag >= 0 ? argv[dirFlag + 1] ?? null : null;
  const envDir = process.env.SESSION_DIR ?? null;
  const menuForced = argv.includes('--menu');
  const noRemember = argv.includes('--no-remember');

  const chosen = chooseSessionDir({
    flag: flagDir,
    env: envDir,
    remembered: loadRememberedDir(),
    fallback: DEFAULT_SESSION_DIR,
  });
  if (chosen.remember && !noRemember) {
    try {
      saveRememberedDir(chosen.dir);
    } catch {
      // Memory is best-effort: this run still works, bare flux just asks again.
    }
  }
  const requested = chosen.dir;

  // Fail on a bad --phone before connecting, not three menus deep. A code for
  // the wrong account is rejected by the phone exactly like an expired code.
  const phoneRaw = parsePhoneFlag(argv);
  let phoneDigits: string | null = null;
  if (phoneRaw !== null) {
    const verdict = validateIndonesianNumber(phoneRaw);
    if (verdict !== true) {
      process.stderr.write(`${typeof verdict === 'string' ? verdict : 'Invalid --phone number.'}\n`);
      return 1;
    }
    phoneDigits = normaliseNumber(phoneRaw);
  }

  // Daily-driver path: the session is already paired, so skip the menu and the
  // wipe prompt entirely and go straight to a running bot. An explicit --phone
  // for a *different* account still routes to the wizard (re-pairing over a
  // live session must stay a deliberate, confirmed act).
  if (!menuForced) {
    const existing = await readSession(requested);
    const pairedDigits = digitsFromJid(existing.jid);
    const phoneTargetsThis = phoneDigits !== null && pairedDigits !== '' && phoneDigits === pairedDigits;
    if (existing.registered && (phoneDigits === null || phoneTargetsThis)) {
      let bot: NyxBaileys | null = null;
      try {
        configureAiState(requested);
        bot = createNyxBaileys(defaultSocketOptions(requested));
        await bot.connect();
        // The disk said paired, but the phone may have logged out since — in
        // which case the server answers the handshake with 401 and the only
        // honest move is wiping and re-pairing, not sitting on a dead socket.
        const verdict = await waitForConnection(
          () => ({
            state: bot?.connectionState.state ?? 'unknown',
            lastDisconnectCode: bot?.lastDisconnectCode ?? null,
          }),
          {
            timeoutMs: 15_000,
            onTick: (remaining) => {
              process.stdout.write(`\r\x1b[0K  checking session… ${formatCountdown(remaining)}`);
            },
          },
        );
        process.stdout.write('\r\x1b[0K');
        if (verdict === 'logged-out') {
          await bot.dispose().catch(() => undefined);
          bot = null;
          await rm(requested, { recursive: true, force: true }).catch(() => undefined);
          process.stdout.write(`\n  ${requested} was logged out on the phone — wiped. Pairing fresh instead.\n`);
        } else {
          const count = await attachBotSurface(bot, requested, pairedDigits);
          const who = bot.sock.user?.id ?? existing.jid ?? 'unknown';
          process.stdout.write(`\n  bot online as ${who} — ${count} commands live, prefix "${FLUX_PREFIX.trim()}"\n  Ctrl+C to stop.\n\n`);
          watchForLogout(() => bot?.lastDisconnectCode ?? null, {
            onLogout: () => {
              void rm(requested, { recursive: true, force: true }).catch(() => undefined);
              process.stdout.write('\n  logged out on the phone — session wiped. Run flux again to pair fresh.\n');
              process.exit(3);
            },
          });
          installGracefulShutdown(bot, (code) => process.exit(code));
          await new Promise(() => {});
          return 0;
        }
      } catch (err) {
        await bot?.dispose().catch(() => undefined);
        process.stdout.write(`\n  direct start failed (${err instanceof Error ? err.message : String(err)}); opening the wizard instead.\n`);
      }
    }
  }

  const stage = new Stage(process.stdout);
  const capabilities = stage.capabilities();
  const activity: string[] = [];
  let frame = 0;
  let sessionDir = requested;
  let linkedNumber: string | null = null;
  let dashboardMode: FluxMode | undefined;
  let client: NyxBaileys | null = null;

  const note = (entry: string): void => {
    activity.push(entry);
    if (activity.length > 4) activity.splice(0, activity.length - 4);
  };
  const header = (): string[] => {
    frame += 1;
    return dashboardLines({
      stage,
      client,
      sessionDir,
      activity,
      frame,
      mode: dashboardMode,
      linkedNumber,
    });
  };
  const refresh = (): void => { stage.update(header()); };

  try {
    stage.begin(header());
    stage.section('Prepare session', ['Checking the requested session directory.']);

    const gate = await resolveSessionDir(requested);
    if ('stop' in gate) {
      stage.receipt([gate.stop]);
      stage.stop([gate.stop]);
      return 0;
    }
    sessionDir = gate.dir;
    note(`Using session ${sessionDir}`);
    stage.receipt([`Using session ${sessionDir}`]);
    refresh();
    configureAiState(sessionDir);

    const options: SuperOptions = defaultSocketOptions(sessionDir);

    stage.section('Start runtime', ['Connecting the decorated Baileys socket.']);
    client = createNyxBaileys(options);
    await client.connect();
    note(`Runtime ready with ${client.chain.length} plugins`);
    refresh();

    const context: PairingFlowContext = {
      stage,
      client,
      sessionDir,
      capabilities,
      refresh,
      note,
      setMode: (mode) => { dashboardMode = mode; },
      phoneDigits,
      diag: new PairingDiagnostics(),
    };

    const outcome = await runPairingFlow(context);

    if (outcome.kind === 'purge') {
      stage.section('Purge session', ['This choice requires explicit confirmation.']);
      note(await purgeSession(capabilities, sessionDir));
      refresh();
      stage.stop(['Purge choice complete.']);
      return 0;
    }

    if (outcome.kind === 'exit') {
      stage.section('Exit', ['Closing the wizard safely.']);
      await streamText('Terminating session. Goodbye.', 28, '\x1b[35m');
      stage.stop(['Wizard exited without changing anything.']);
      return 0;
    }

    if (outcome.kind === 'config') {
      stage.section('Security state', ['Values below come from the running client.']);
      stage.receipt(showSecurityState(client));
      note('Inspected live security state');
      refresh();
      stage.stop(['Security inspection complete.']);
      return 0;
    }

    if (outcome.kind === 'paired') {
      linkedNumber = outcome.jid;
      const count = await attachBotSurface(client, sessionDir, outcome.digits);
      stage.stop([
        `Linked as ${outcome.jid}`,
        `Bot online — ${count} commands live, prefix "${FLUX_PREFIX.trim()}"`,
        'Ctrl+C to stop.',
      ]);
      watchForLogout(() => client?.lastDisconnectCode ?? null, {
        onLogout: () => {
          void rm(sessionDir, { recursive: true, force: true }).catch(() => undefined);
          process.stdout.write('\n  logged out on the phone — session wiped. Run flux again to pair fresh.\n');
          process.exit(3);
        },
      });
      installGracefulShutdown(client, (code) => process.exit(code));
      await new Promise(() => {});
      return 0;
    }

    const result = finish(outcome, context, sessionDir);
    stage.receipt(result.lines);
    stage.stop(result.lines);
    return result.code;
  } catch (err) {
    stage.stop();
    if ((err as { name?: unknown } | null)?.name === 'ExitPromptError') {
      process.stdout.write('\nWizard cancelled before changing anything.\n');
      return 130;
    }
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    await client?.dispose();
  }
}