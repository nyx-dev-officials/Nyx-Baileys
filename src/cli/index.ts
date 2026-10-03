/**
 * Nyx-Baileys CLI — public surface.
 *
 * The launcher (`bin/nyx-baileys.js`) imports `main` from `./main.js`; this
 * barrel exists so the CLI can be embedded in another program or scripted
 * against a test without reaching into individual modules.
 */

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