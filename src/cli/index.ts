/**
 * Nyx-Baileys CLI — public surface.
 *
 * The launcher (`bin/nyx-baileys.js`) imports `main` from `./main.js`; this
 * barrel exists so the CLI can be embedded in another program or scripted
 * against a test without reaching into individual modules.
 */

import { pathToFileURL } from 'node:url';

export { main, PARSER, PROGRAM, VERSION } from './main.js';
export { EXIT, type ExitCode, type CliEnv, CliError, Lifecycle, parseLogLevel } from './commands.js';
export {
  UsageError,
  flagBool,
  flagList,
  flagNumber,
  flagString,
  parseArgv,
  renderCommandHelp,
  renderRootHelp,
  type CommandSpec,
  type FlagKind,
  type FlagSpec,
  type FlagValue,
  type ParsedArgs,
  type ParserConfig,
  type PositionalSpec,
} from './args.js';
export {
  Reporter,
  colourEnabled,
  displayWidth,
  formatAgo,
  formatBytes,
  formatDuration,
  renderTable,
  truncate,
  type JsonEnvelope,
  type ReporterOptions,
  type TableOptions,
} from './output.js';

/**
 * Direct execution.
 *
 * This file is a barrel, so `node dist/cli/index.js pair` exits 0 having done
 * nothing at all — a silent no-op that reads exactly like success. It is also the
 * wrong guess often enough to be worth catching, so running it directly hands off
 * to the real entry rather than printing nothing. Importers are unaffected: this
 * branch only fires when the file *is* the process entry.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { main } = await import('./main.js');
  process.exitCode = (await main(process.argv.slice(2))) ?? 0;
}