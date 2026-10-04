/**
 * Nyx-Baileys CLI entry point.
 *
 * Responsibilities, in order: resolve the environment, dispatch, and guarantee
 * teardown. The teardown guarantee is the interesting one — a socket that is
 * killed rather than disposed can leave Signal key material half-written, and
 * the user pays for it with a re-pair. So SIGINT and SIGTERM run the same
 * lifecycle unwind as a normal exit, and the process only ends once it
 * finishes.
 *
 * Exit codes are defined in `./commands.ts`:
 * 0 ok · 1 usage · 2 connection/session failure · 3 not paired · 130 interrupted.
 */

import {
  UsageError,
  flagString,
  parseArgv,
  renderCommandHelp,
  renderRootHelp,
  type ParserConfig,
} from './args.js';
import {
  COMMANDS,
  COMMAND_SPECS,
  CliError,
  EXIT,
  GLOBAL_FLAGS,
  Lifecycle,
  parseLogLevel,
  type CliEnv,
  type ExitCode,
} from './commands.js';
import { Reporter, colourEnabled } from './output.js';

export const PROGRAM = 'nyx-baileys';
export const VERSION = '0.2.0';

/** One source of truth: the command registry declares its own specs. */
export const PARSER: ParserConfig = {
  program: PROGRAM,
  version: VERSION,
  globals: GLOBAL_FLAGS,
  commands: COMMAND_SPECS,
};

/** Session directory: the flag wins, then the environment, then the default. */
const DEFAULT_SESSION_DIR = './session';

function buildEnv(args: ReturnType<typeof parseArgv>['args'], json: boolean): CliEnv {
  const levelFlag = flagString(args, 'level', '');
  const levelEnv = process.env.LOG_LEVEL;
  return {
    sessionDir: flagString(args, 'dir', process.env.SESSION_DIR ?? DEFAULT_SESSION_DIR),
    logLevel: parseLogLevel(levelFlag !== '' ? levelFlag : levelEnv, 'info'),
    logLevelExplicit: levelFlag !== '' || levelEnv !== undefined,
    json,
    cwd: process.cwd(),
    connectTimeoutMs: 60_000,
  };
}

async function run(argv: readonly string[], io: Reporter, lifecycle: Lifecycle): Promise<ExitCode> {
  let parsed: ReturnType<typeof parseArgv>;
  try {
    parsed = parseArgv(argv, PARSER);
  } catch (err) {
    if (err instanceof UsageError) {
      io.fail('', { code: 'usage', message: err.message, ...(err.hint ? { next: err.hint } : {}) });
      return EXIT.usage;
    }
    throw err;
  }

  const { command, args } = parsed;

  if (args.version) {
    if (io.json) io.emit('version', { name: PROGRAM, version: VERSION });
    else io.line(`${PROGRAM} ${VERSION}`);
    return EXIT.ok;
  }

  if (!command) {
    // Bare invocation prints help but is a usage error; `--help` is not.
    io.line(renderRootHelp(PARSER));
    return args.help ? EXIT.ok : EXIT.usage;
  }

  if (args.help) {
    io.line(renderCommandHelp(command, PARSER));
    return EXIT.ok;
  }

  const entry = COMMANDS[command.name];
  if (!entry) {
    // Unreachable while the registry and the specs share one source. Checked
    // anyway: a dispatcher that trusts its own map is a lie waiting to ship.
    io.fail(command.name, { code: 'usage', message: `command \`${command.name}\` has no implementation` });
    return EXIT.usage;
  }

  const env = buildEnv(args, io.json);
  if (io.json && env.logLevelExplicit) {
    io.warn('--json keeps stdout to a single object; framework warn/info logs still go to stdout');
  }

  return entry.run({ args, io, env, lifecycle });
}

interface Failure {
  readonly code: ExitCode;
  readonly slug: string;
  readonly message: string;
  readonly next?: string;
}

/** Turn any thrown value into a code and a message a human can act on. */
function describe(err: unknown): Failure {
  if (err instanceof CliError) {
    const slug = err.code === EXIT.notPaired ? 'not-paired' : err.code === EXIT.usage ? 'usage' : 'failure';
    return { code: err.code, slug, message: err.message, ...(err.next ? { next: err.next } : {}) };
  }
  if (err instanceof UsageError) {
    return {
      code: EXIT.usage,
      slug: 'usage',
      message: err.message,
      ...(err.hint ? { next: err.hint } : {}),
    };
  }
  return {
    code: EXIT.failure,
    slug: 'failure',
    message: err instanceof Error ? err.message : String(err),
    next: 're-run with --level debug for the framework log behind this',
  };
}

/** The command word as typed, for the JSON error envelope. */
function commandOf(argv: readonly string[]): string {
  const known = COMMAND_SPECS.map((spec) => spec.name);
  return argv.find((token) => !token.startsWith('-') && known.includes(token)) ?? '';
}

/**
 * Run the CLI.
 *
 * Resolves with the exit code and never throws. Teardown completes before it
 * resolves, so a caller may exit immediately and know the socket is closed.
 */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  // The reporter exists before parsing so a usage error can report itself.
  // `--json` is recognised here by name; a malformed `--json=…` still gets the
  // human path, and the parser's own error will say so.
  const io = new Reporter({ json: argv.includes('--json'), color: colourEnabled() });

  const lifecycle = new Lifecycle();
  let interrupting = false;

  const onSignal = (signal: NodeJS.Signals): void => {
    if (interrupting) return;
    interrupting = true;
    io.note(`\n${signal} received — closing the socket before exit`);
    // `process.exit` waits on this chain, so the socket is closed first.
    void lifecycle
      .dispose()
      .catch(() => undefined)
      .then(() => {
        process.exit(EXIT.interrupted);
      });
  };

  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  let code: ExitCode = EXIT.failure;
  try {
    code = await run(argv, io, lifecycle);
  } catch (err) {
    const failure = describe(err);
    code = failure.code;
    io.fail(commandOf(argv), {
      code: failure.slug,
      message: failure.message,
      ...(failure.next ? { next: failure.next } : {}),
    });
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await lifecycle.dispose();
  }

  return code;
}

export { EXIT };
export type { ExitCode };