/**
 * Output for the Nyx-Baileys CLI.
 *
 * Two contracts, one implementation:
 *
 *   human   aligned tables, colour when the stream is a TTY
 *   json    exactly one JSON object on stdout, nothing else
 *
 * `--json` is the scripting contract, so nothing decorative may reach stdout
 * in that mode — not headings, not tables, not progress. Diagnostics always go
 * to stderr, where a consumer reading stdout cannot be confused by them.
 *
 * No emoji: they measure as two columns on some terminals and one on others,
 * which turns any aligned layout into a guess.
 */

/* ── colour ───────────────────────────────────────────────────────── */

const CODES = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
} as const;

export type Paint = keyof typeof CODES;

/** Colour is for humans only: TTY, and no NO_COLOR. */
export function colourEnabled(stream: NodeJS.WriteStream = process.stdout): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0') return true;
  return stream.isTTY === true;
}

function paint(text: string, code: Paint, enabled: boolean): string {
  return enabled ? `${CODES[code]}${text}${CODES.reset}` : text;
}

/* ── width ────────────────────────────────────────────────────────── */

/**
 * Terminal columns a string occupies.
 *
 * Local copy of the accounting in `utils/compose.ts` on purpose: that one
 * exists to pad WhatsApp text inside a message, and it is not exported. CJK
 * ideographs, Hangul, full-width forms and pictographs take two columns;
 * combining marks take none.
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) continue; // ZWJ / variation
    if (cp >= 0x0300 && cp <= 0x036f) continue; // combining marks
    if (cp >= 0x1f3fb && cp <= 0x1f3ff) continue; // skin tone
    width += isWide(cp) ? 2 : 1;
  }
  return width;
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

const ELLIPSIS = '…';

/** Cut to `max` columns, marking the cut. Never splits a wide char in half. */
export function truncate(text: string, max: number): string {
  if (max <= 0) return '';
  if (displayWidth(text) <= max) return text;
  const budget = max - 1; // room for the ellipsis
  let width = 0;
  let out = '';
  for (const char of text) {
    const next = width + (isWide(char.codePointAt(0) ?? 0) ? 2 : 1);
    if (next > budget) break;
    out += char;
    width = next;
  }
  return `${out.trimEnd()}${ELLIPSIS}`;
}

function pad(text: string, width: number): string {
  const gap = width - displayWidth(text);
  return gap > 0 ? text + ' '.repeat(gap) : text;
}

/* ── table ────────────────────────────────────────────────────────── */

export interface TableOptions {
  /** Total width budget including gutters. Defaults to the terminal width. */
  readonly maxWidth?: number;
  readonly align?: readonly ('left' | 'right')[];
  /** Skip the header row. */
  readonly headless?: boolean;
}

function terminalWidth(fallback = 100): number {
  const columns = process.stdout.columns;
  return typeof columns === 'number' && columns > 20 ? columns : fallback;
}

/**
 * Fit columns into the width budget by shrinking the widest one first, which
 * keeps narrow columns readable instead of chopping every column equally.
 */
function fitColumns(widths: number[], maxWidth: number): number[] {
  const gutter = Math.max(0, widths.length - 1) * 2;
  const budget = Math.max(widths.length * 4, maxWidth - gutter);
  const out = [...widths];
  let total = out.reduce((sum, w) => sum + w, 0);

  while (total > budget) {
    let widest = 0;
    for (let i = 1; i < out.length; i += 1) {
      if ((out[i] ?? 0) > (out[widest] ?? 0)) widest = i;
    }
    if ((out[widest] ?? 0) <= 6) break;
    out[widest] = (out[widest] ?? 0) - 1;
    total -= 1;
  }
  return out;
}

export function renderTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  options: TableOptions = {},
): string[] {
  if (headers.length === 0) return [];

  const align = options.align ?? [];
  const cell = (value: string | undefined): string => (value ?? '').replace(/[\r\n\t]+/g, ' ').trim();

  const natural = headers.map((header, column) =>
    Math.max(displayWidth(header), ...rows.map((row) => displayWidth(cell(row[column]))), 1),
  );
  const widths = fitColumns(natural, options.maxWidth ?? terminalWidth());
  const line = (cells: readonly (string | undefined)[], colour: Paint | null, enabled: boolean): string =>
    cells
      .map((value, i) => {
        const width = widths[i] ?? 0;
        const text = truncate(cell(value), width);
        const padded = align[i] === 'right' ? ' '.repeat(Math.max(0, width - displayWidth(text))) + text : pad(text, width);
        return colour ? paint(padded, colour, enabled) : padded;
      })
      .join('  ')
      .trimEnd();

  const lines: string[] = [];
  if (!options.headless) {
    lines.push(line(headers, 'bold', colourEnabled()));
    lines.push(paint(widths.map((w) => '─'.repeat(w)).join('  '), 'dim', colourEnabled()));
  }
  for (const row of rows) lines.push(line(row, null, colourEnabled()));
  return lines;
}

/* ── values ───────────────────────────────────────────────────────── */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? String(Math.round(value)) : value.toFixed(value < 10 ? 1 : 0);
  return `${rounded} ${units[unit]}`;
}

export function formatAgo(timestamp: number): string {
  if (!timestamp || !Number.isFinite(timestamp)) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/* ── reporter ─────────────────────────────────────────────────────── */

export interface ReporterOptions {
  readonly json: boolean;
  readonly color?: boolean;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
}

export interface JsonEnvelope {
  readonly ok: boolean;
  readonly command: string;
  readonly data?: unknown;
  readonly error?: { readonly code: string; readonly message: string; readonly next?: string };
}

/**
 * The only writer a command is allowed to use. Commands never touch
 * `process.stdout` directly, which is what keeps `--json` output parseable.
 */
export class Reporter {
  readonly json: boolean;
  readonly color: boolean;
  readonly #out: NodeJS.WriteStream;
  readonly #err: NodeJS.WriteStream;

  constructor(options: ReporterOptions) {
    this.json = options.json;
    this.color = options.color ?? colourEnabled();
    this.#out = options.stdout ?? process.stdout;
    this.#err = options.stderr ?? process.stderr;
  }

  /** One line to stdout, human mode only — it would corrupt JSON output. */
  line(text = ''): void {
    if (this.json) return;
    this.#out.write(`${text}\n`);
  }

  /** Always allowed: stderr is never part of the stdout contract. */
  note(text: string): void {
    this.#err.write(`${text}\n`);
  }

  heading(text: string): void {
    this.line(this.c(text, 'bold'));
  }

  /** Aligned `key  value` block for single-instance reports. */
  fields(rows: readonly (readonly [string, string])[]): void {
    if (this.json || rows.length === 0) return;
    const width = Math.max(...rows.map(([key]) => displayWidth(key)));
    for (const [key, value] of rows) {
      this.line(`  ${this.c(pad(key, width), 'dim')}  ${value}`);
    }
  }

  table(headers: readonly string[], rows: readonly (readonly string[])[], options: TableOptions = {}): void {
    if (this.json || rows.length === 0) return;
    for (const line of renderTable(headers, rows, options)) this.line(line);
  }

  /** Success/failure marker line. Text only — the exit code carries the verdict. */
  status(ok: boolean, text: string): void {
    this.line(`${ok ? this.c('ok', 'green') : this.c('failed', 'red')}  ${text}`);
  }

  warn(text: string): void {
    this.note(`${this.c('warning', 'yellow')}  ${text}`);
  }

  c(text: string, code: Paint): string {
    return paint(text, code, this.color);
  }

  /** The single JSON object a `--json` run prints on stdout. */
  emit(command: string, data: unknown): void {
    if (!this.json) return;
    const envelope: JsonEnvelope = { ok: true, command, data };
    this.#out.write(`${JSON.stringify(envelope, null, 2)}\n`);
  }

  /** A structured failure. JSON on stderr so stdout stays clean. */
  fail(command: string, error: { code: string; message: string; next?: string }): void {
    if (this.json) {
      const envelope: JsonEnvelope = { ok: false, command, error };
      this.#err.write(`${JSON.stringify(envelope, null, 2)}\n`);
      return;
    }
    this.#err.write(`${this.c('error', 'red')}  ${error.message}\n`);
    if (error.next) this.#err.write(`${' '.repeat(7)}${this.c(error.next, 'dim')}\n`);
  }
}