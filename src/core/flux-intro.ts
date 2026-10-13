/**
 * FLUX — runtime dashboard.
 *
 * ## Why this introspects instead of hardcoding
 *
 * The first version of this screen listed a fixed plugin table with hardcoded
 * statuses. Three of those lines were false: it labelled a plugin "ONLINE" that
 * is not in the default chain, described `verifiedSpoof` as producing a "Native
 * Green Checkmark" when protobuf strips those fields entirely, and invented two
 * plugins that do not exist. A dashboard is a claim about reality; when the
 * claims are fabricated it is worse than no dashboard, because it looks like
 * evidence.
 *
 * So every row here is read from the live runtime:
 *
 *   - the plugin list comes from `client.chain`, populated as plugins apply
 *   - memory, uptime, pid and platform come from `process` and `os`
 *   - the frame width comes from `process.stdout.columns`
 *
 * Nothing is asserted that the process cannot observe.
 *
 * ## The padding bug this had to fix
 *
 * The straightforward `text.padEnd(inner)` does not work here, because `text`
 * contains ANSI escapes and `padEnd` counts them. A line carrying one 24-bit
 * colour escape (19 characters) pads to 74 and *displays* as 55 columns, so
 * the right-hand border lands 19 columns short of where it belongs. Every
 * coloured line in the box was misaligned. {@link visibleWidth} strips the
 * escapes before measuring.
 *
 * ## Windows encoding
 *
 * Box-drawing characters are U+2500 block, which a default Windows console code
 * page renders as mojibake. Windows Terminal, PowerShell 7 and VS Code's
 * terminal all speak UTF-8 and are detected. Anywhere else the frame falls back
 * to ASCII, which is ugly but legible, rather than pretty and broken.
 */

import os from 'node:os';
import process from 'node:process';

import { displayWidth, truncate } from '../cli/output.js';

/** One applied plugin. Deliberately structural, not the full Plugin type. */
export interface ChainEntry {
  readonly name: string;
  readonly order: number;
}

const ESC = /\x1b\[[0-9;]*m/g;

/** Printable width of a string, ignoring ANSI escape sequences. */
export function visibleWidth(text: string): number {
  return displayWidth(text.replace(ESC, ''));
}

/** Pad to `width` printable columns, ignoring the escapes when measuring. */
export function padVisible(text: string, width: number): string {
  const visible = displayWidth(text.replace(ESC, ''));
  return visible >= width ? text : text + ' '.repeat(width - visible);
}

/** Right-align to `width` printable columns. */
export function padLeft(text: string, width: number): string {
  const visible = displayWidth(text.replace(ESC, ''));
  return visible >= width ? text : ' '.repeat(width - visible) + text;
}

export function fitAnsi(text: string, width: number, reset = ''): string {
  if (width <= 0) return reset;
  let output = '';
  let used = 0;
  let open = false;
  const token = /\x1b\[[0-9;]*m|./gsu;
  let match: RegExpExecArray | null;
  while ((match = token.exec(text)) !== null) {
    const chunk = match[0];
    if (chunk.startsWith('\x1b')) {
      output += chunk;
      open = !chunk.endsWith('m') || chunk !== '\x1b[0m' ? true : false;
      continue;
    }
    const chunkWidth = displayWidth(chunk);
    if (used + chunkWidth > width) break;
    output += chunk;
    used += chunkWidth;
  }
  const gap = width - used;
  return `${output}${gap > 0 ? ' '.repeat(gap) : ''}${open ? reset : ''}`;
}

/**
 * Compact elapsed time.
 *
 * A fixed `0.00 h` is what a dashboard shows for the entire duration of a
 * `pair` command, because the process seconds old. Rendering seconds until the
 * number stops being trivial keeps the field meaningful.
 */
export function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

/**
 * True when the terminal can be trusted with box-drawing characters.
 *
 * Windows Terminal sets `WT_SESSION`, PowerShell 7 sets `TERM_PROGRAM`, and
 * VS Code's integrated terminal sets `TERM_PROGRAM=vscode`. Anything else on
 * win32 is assumed to be a legacy console with a non-UTF-8 code page.
 */
export function supportsUnicode(): boolean {
  if (process.platform !== 'win32') return true;
  return process.env.WT_SESSION !== undefined
    || process.env.TERM_PROGRAM !== undefined
    || process.env.FORCE_UNICODE === '1';
}

/**
 * Glyphs.
 *
 * `bar` is the vertical trunk of the tree, `branch`/`lastBranch` are the two
 * fork shapes. These must be distinct: reusing the horizontal rule for the
 * vertical produced a tree that read as `──└` on every row.
 */
const GLYPH_UNICODE = {
  tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║', vl: '╠', vr: '╣',
  bar: '│', branch: '├', lastBranch: '└', dash: '─', dot: '●',
} as const;

const GLYPH_ASCII = {
  tl: '+', tr: '+', bl: '+', br: '+', h: '=', v: '|', vl: '+', vr: '+',
  bar: '|', branch: '|', lastBranch: '`', dash: '-', dot: '*',
} as const;

/** Three-cell tree stem: vertical rule, then the fork, then its arm. */
const stem = (fork: string, dash: string): string => `${fork}${dash}${dash}`;

export interface FluxPalette {
  reset: string; bold: string; dim: string;
  pink: string; cyan: string; purple: string; green: string;
  yellow: string; blue: string; gray: string; white: string;
}

/**
 * 24-bit truecolour where supported.
 *
 * When colour is off every entry is an **empty string**, not a 16-colour code.
 * A 16-colour fallback looks reasonable in a test and still corrupts output that
 * a consumer is parsing for plain text.
 */
export function palette(color: boolean): FluxPalette {
  const c = (r: number, g: number, b: number): string =>
    color ? `\x1b[38;2;${r};${g};${b}m` : '';
  return {
    reset: color ? '\x1b[0m' : '',
    bold: color ? '\x1b[1m' : '',
    dim: color ? '\x1b[2m' : '',
    pink: c(255, 45, 120),
    cyan: c(0, 229, 255),
    purple: c(147, 51, 234),
    green: c(57, 255, 20),
    yellow: c(255, 204, 0),
    blue: c(59, 130, 246),
    gray: c(110, 118, 129),
    white: c(240, 246, 252),
  };
}

type Rgb = readonly [number, number, number];

const HERO_STOPS: readonly Rgb[] = [
  [255, 45, 120],
  [147, 51, 234],
  [0, 229, 255],
];

function mixChannel(first: number, second: number, amount: number): number {
  return Math.round(first + (second - first) * amount);
}

function gradientEscape(position: number, color: boolean): string {
  if (!color) return '';
  const clamped = Math.min(0.9999, Math.max(0, position));
  const scaled = clamped * (HERO_STOPS.length - 1);
  const index = Math.min(HERO_STOPS.length - 2, Math.floor(scaled));
  const amount = scaled - index;
  const first = HERO_STOPS[index]!;
  const second = HERO_STOPS[index + 1]!;
  return `\x1b[38;2;${mixChannel(first[0], second[0], amount)};${mixChannel(first[1], second[1], amount)};${mixChannel(first[2], second[2], amount)}m`;
}

function gradientText(text: string, offset: number, color: boolean): string {
  if (!color) return text;
  const glyphs = [...text].filter((character) => character !== ' ');
  const total = Math.max(1, glyphs.length - 1);
  let shown = 0;
  let output = '';
  for (const character of text) {
    if (character === ' ') {
      output += ' ';
      continue;
    }
    const band = (shown + offset) % Math.max(8, glyphs.length + 8);
    const position = shown / total;
    if (band < 3) output += '\x1b[1m\x1b[97m';
    else output += gradientEscape(position, true);
    output += character;
    shown += 1;
  }
  return `${output}\x1b[0m`;
}

function orderHeat(order: number, minimum: number, maximum: number, color: boolean): string {
  if (!color || maximum <= minimum) return palette(color).cyan;
  const amount = (order - minimum) / (maximum - minimum);
  if (amount < 0.45) return palette(color).green;
  if (amount < 0.8) return palette(color).yellow;
  return palette(color).pink;
}

function centeredLine(line: string, width: number, color: boolean, frame: number): string {
  const lineWidth = displayWidth(line.replace(ESC, ''));
  const left = Math.max(0, Math.floor((width - lineWidth) / 2));
  return `${' '.repeat(left)}${gradientText(line, frame, color)}`;
}

export type FluxMode = 'cinematic' | 'standard' | 'compact' | 'minimal';

export interface FluxIntroOptions {
  readonly plugins?: readonly ChainEntry[];
  readonly version?: string;
  readonly colour?: boolean;
  readonly unicode?: boolean;
  readonly columns?: number;
  readonly maxWidth?: number;
  readonly mode?: FluxMode;
  readonly rows?: number;
  readonly reserveRows?: number;
  readonly frame?: number;
  readonly connection?: string | null;
  readonly activity?: readonly string[];
  readonly sessionDir?: string;
  /** Overwrite the session path with the real number once it is known. */
  readonly linkedNumber?: string | null;
}

/**
 * Render the dashboard and return it as a string.
 *
 * Returning rather than printing is deliberate: the layout can then be asserted
 * on directly, which is the only way to catch a border that has drifted one
 * column out of alignment.
 */
export function renderFluxIntro(options: FluxIntroOptions = {}): string {
  const {
    plugins = [],
    version = '0.3.1',
    colour = true,
    unicode = supportsUnicode(),
    columns = process.stdout.columns ?? 80,
    maxWidth = 78,
    mode,
    rows,
    reserveRows = 8,
    frame = 0,
    connection = null,
    activity = [],
    sessionDir,
    linkedNumber = null,
  } = options;

  const p = palette(colour);
  const g = unicode ? GLYPH_UNICODE : GLYPH_ASCII;

  /**
   * `NyxBaileys` seeds its connection state as `never` and only replaces it once
   * Baileys actually emits an update. Printing that verbatim reads as a failed
   * socket rather than a socket that has not reported yet, which is the first
   * thing on screen for the whole connect.
   */
  const socketLabel = !connection || connection === 'never' ? 'connecting' : connection;
  const starting = socketLabel === 'connecting';

  // Fit the window, but never let a narrow terminal force a box that is too
  // small to hold a plugin name. 78 is the widest an 80-column PowerShell
  // window can show without wrapping.
  const boxWidth = Math.min(Math.max(columns - 2, 52), Math.max(52, maxWidth));
  const innerWidth = boxWidth - 4;
  const budget = rows === undefined ? Number.MAX_SAFE_INTEGER : Math.max(11, rows - reserveRows);
  const selectedMode = mode ?? (rows === undefined ? 'standard' : budget >= 34 ? 'cinematic' : budget >= 28 ? 'standard' : budget >= 18 ? 'compact' : 'minimal');
  const out: string[] = [];
  const put = (s = ''): void => { out.push(s); };

  const rule = (l: string, r: string): string =>
    `${p.purple}${l}${g.h.repeat(boxWidth - 2)}${r}${p.reset}`;

  /** Wrap a row in the side borders, padding by printable width. */
  const row = (body = ''): string => {
    const fitted = fitAnsi(body, innerWidth, p.reset);
    return `${p.purple}${g.v}${p.reset} ${fitted} ${p.purple}${g.v}${p.reset}`;
  };

  put(rule(g.tl, g.tr));
  put(row(`${p.bold}${p.cyan}FLUX${p.reset} ${p.dim}v${version} // linked device runtime${p.reset}`));
  put(rule(g.vl, g.vr));

  if (selectedMode === 'minimal') {
    put(row(centeredLine('FLUX', innerWidth, colour, frame)));
  } else if (selectedMode === 'compact') {
    put(row(centeredLine('FLUX', innerWidth, colour, frame)));
    put(row(centeredLine(`v${version} // linked device runtime`, innerWidth, colour, frame)));
  } else {
    put(row(''));
    for (const line of fluxMark(unicode)) put(row(centeredLine(line, innerWidth, colour, frame)));
    put(row(''));
  }

  put(rule(g.vl, g.vr));

  // Telemetry — every value read from the live process.
  const mem = process.memoryUsage();
  const metrics = [
    { label: 'node', value: process.version, detail: `${os.arch()} ${os.platform()}` },
    { label: 'heap', value: `${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`, detail: `of ${(mem.heapTotal / 1024 / 1024).toFixed(1)} MB` },
    { label: 'rss', value: `${(mem.rss / 1024 / 1024).toFixed(1)} MB`, detail: `of ${(os.totalmem() / 1024 ** 3).toFixed(1)} GB` },
    { label: 'elapsed', value: formatUptime(process.uptime()), detail: `pid ${process.pid}` },
    { label: 'terminal', value: `${columns}x${rows ?? process.stdout.rows ?? 24}`, detail: selectedMode },
    { label: 'chain', value: starting ? 'loading' : `${plugins.length} applied`, detail: `socket ${socketLabel}` },
    { label: 'session', value: sessionDir ?? 'default session', detail: linkedNumber ? `linked ${linkedNumber}` : 'unlinked' },
  ];
  const shownMetrics = selectedMode === 'compact' ? metrics.slice(0, 6) : selectedMode === 'minimal' ? metrics.slice(0, 3) : metrics;
  const metricColumns = selectedMode === 'minimal' ? 1 : innerWidth >= 100 ? 3 : innerWidth >= 68 ? 2 : 1;
  const metricGutter = 3;
  const metricPrefix = 3;
  const metricWidth = Math.max(20, Math.floor((innerWidth - metricPrefix - (metricColumns - 1) * metricGutter) / metricColumns));
  put(row(`${p.bold}${p.white}:: RUNTIME${p.reset}`));
  for (let index = 0; index < shownMetrics.length; index += metricColumns) {
    const cells = shownMetrics.slice(index, index + metricColumns).map((metric) => {
      const label = `${p.gray}${metric.label}${p.reset}`;
      const valueShown = truncate(metric.value, Math.max(4, metricWidth - displayWidth(metric.label) - 1));
      const detailBudget = metric.detail
        ? Math.max(0, metricWidth - displayWidth(metric.label) - 1 - displayWidth(valueShown) - 1)
        : 0;
      const detail = metric.detail && detailBudget > 0
        ? ` ${p.gray}${truncate(metric.detail, detailBudget)}${p.reset}`
        : '';
      return padVisible(`${label} ${p.white}${valueShown}${p.reset}${detail}`, metricWidth);
    });
    while (cells.length < metricColumns) cells.push(' '.repeat(metricWidth));
    put(row(`${' '.repeat(metricPrefix)}${cells.join(' '.repeat(metricGutter))}`));
  }

  put(rule(g.vl, g.vr));

  // The plugin chain, exactly as applied.
  const sorted = [...plugins].sort((a, b) => a.order - b.order);
  const orders = sorted.map((entry) => entry.order);
  const minimumOrder = orders.length > 0 ? Math.min(...orders) : 0;
  const maximumOrder = orders.length > 0 ? Math.max(...orders) : 0;
  put(row(`${p.bold}${p.white}:: PLUGIN CHAIN${p.reset} ${p.gray}(${sorted.length} applied)${p.reset}`));
  if (sorted.length === 0) {
    put(row(`   ${p.gray}${stem(g.lastBranch, g.dash)} ${starting ? 'applying plugin chain…' : 'none applied yet'}${p.reset}`));
  } else if (selectedMode === 'minimal') {
    const names = sorted.slice(0, 3).map((entry) => truncate(entry.name, 18)).join(', ');
    const remainder = sorted.length > 3 ? ` +${sorted.length - 3} more` : '';
    put(row(`   ${p.cyan}${truncate(names + remainder, innerWidth - 3)}${p.reset}`));
  } else {
    const colWidth = unicode ? 33 : 30;
    const perRow = Math.max(1, Math.floor((innerWidth + 2) / colWidth));
    const nameWidth = Math.min(16, Math.floor((colWidth - 9) / 1));
    const maxPluginRows = selectedMode === 'compact' ? 2 : selectedMode === 'standard' ? 8 : 10;
    const shown = sorted.slice(0, Math.max(1, maxPluginRows * perRow));
    const cell = (entry: ChainEntry, isLast: boolean): string => {
      const fork = stem(isLast ? g.lastBranch : g.branch, g.dash);
      const ord = padLeft(String(entry.order), 3);
      const heat = orderHeat(entry.order, minimumOrder, maximumOrder, colour);
      return `${p.gray}${fork}${p.reset} ${heat}${padVisible(truncate(entry.name, nameWidth), nameWidth)}${p.reset} ${p.dim}${ord}${p.reset} ${p.green}${g.dot}${p.reset}`;
    };
    for (let i = 0; i < shown.length; i += perRow) {
      const parts: string[] = [];
      for (let c = 0; c < perRow && i + c < shown.length; c++) {
        const idx = i + c;
        parts.push(padVisible(cell(shown[idx]!, idx === sorted.length - 1), colWidth));
      }
      put(row(`   ${parts.join('')}`));
    }
    if (shown.length < sorted.length) {
      put(row(`   ${p.gray}   ...and ${sorted.length - shown.length} more${p.reset}`));
    }
  }

  const feed = activity
    .filter((entry) => entry.trim().length > 0)
    .slice(selectedMode === 'cinematic' ? -4 : -2);
  if (feed.length > 0 && selectedMode !== 'compact' && selectedMode !== 'minimal') {
    put(rule(g.vl, g.vr));
    put(row(`${p.bold}${p.white}:: CONSOLE${p.reset}`));
    for (const entry of feed) {
      const marker = unicode ? '▸' : '>';
      put(row(`   ${p.cyan}${marker}${p.reset} ${p.white}${truncate(entry, innerWidth - 6)}${p.reset}`));
    }
  }

  put(rule(g.vl, g.vr));

  const shownNumber = linkedNumber ? truncate(linkedNumber, Math.max(4, innerWidth - 24)) : null;
  const status = shownNumber
    ? `${p.green}linked${p.reset} ${p.white}${shownNumber}${p.reset}`
    : `${p.yellow}awaiting pairing${p.reset}`;
  const socket = `${p.dim}socket ${socketLabel}${p.reset}`;
  put(row(`${p.dim}status:${p.reset} ${status}   ${socket}`));
  put(rule(g.bl, g.br));
  put();

  return out.join('\n');
}

/**
 * The FLUX mark.
 *
 * The ASCII arm is a real transliteration of the same bitmap, not a partial
 * `replace()` over four characters — that left `█` and `║` mixed with `#` and
 * produced something unreadable on a legacy console.
 */
function fluxMark(unicode: boolean): string[] {
  if (unicode) {
    return [
      '███████╗██╗     ██╗   ██╗██╗  ██╗',
      '██╔════╝██║     ██║   ██║╚██╗██╔╝',
      '█████╗  ██║     ██║   ██║ ╚███╔╝ ',
      '██╔══╝  ██║     ██║   ██║ ██╔██╗ ',
      '██║     ███████╗╚██████╔╝██╔╝ ██╗',
      '╚═╝     ╚══════╝ ╚═════╝ ╚═╝  ╚═╝',
    ];
  }
  return [
    '####### # #     # #   # ## #  # #',
    '##===; ## #     # #   # #;; # #=;',
    '#### #  ## #     # #   # # ;;## ;  ',
    '##==;  ## #     # #   # # # ## #   ',
    '##     ######### ###### # #=;  # #',
    '===     =======  =====  ===   ===',
  ];
}

/** Print the dashboard. */
export function printFluxIntro(options: FluxIntroOptions = {}): void {
  process.stdout.write(`${renderFluxIntro(options)}\n`);
}
