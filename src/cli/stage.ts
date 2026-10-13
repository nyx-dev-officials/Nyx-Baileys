#!/usr/bin/env node
import { colourEnabled, displayWidth, truncate } from './output.js';
import { palette, supportsUnicode } from '../core/flux-intro.js';
import process from 'node:process';

export interface StageSize {
  readonly columns: number;
  readonly rows: number;
}

export interface StageSizeOverride {
  readonly columns?: number;
  readonly rows?: number;
}

export interface StageCapabilities {
  readonly interactive: boolean;
  readonly color: boolean;
  readonly unicode: boolean;
  readonly alternate: boolean;
  readonly pinned: boolean;
}

export interface StageOptions extends StageSizeOverride {
  readonly color?: boolean;
  readonly unicode?: boolean;
  readonly alternate?: boolean;
  readonly pinned?: boolean;
  readonly minColumns?: number;
  readonly minRows?: number;
}

export const ALT_ENTER = '\x1b[?1049h';
export const ALT_LEAVE = '\x1b[?1049l';
export const CURSOR_HIDE = '\x1b[?25l';
export const CURSOR_SHOW = '\x1b[?25h';
export const CURSOR_SAVE = '\x1b[s';
export const CURSOR_RESTORE = '\x1b[u';
export const SCROLL_RESET = '\x1b[r';
export const ERASE_LINE = '\x1b[2K';

export function moveTo(row: number, column: number): string {
  return `\x1b[${row};${column}H`;
}

export function scrollRegion(top: number, bottom: number): string {
  return `\x1b[${top};${bottom}r`;
}

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

export function stripStageAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

export function cellWidth(text: string): number {
  return displayWidth(stripStageAnsi(text));
}

export function fitCell(text: string, width: number): string {
  const clipped = truncate(text.replace(/[\r\n]+/g, ' '), Math.max(0, width));
  const gap = width - cellWidth(clipped);
  return gap > 0 ? `${clipped}${' '.repeat(gap)}` : clipped;
}

export function stageSize(out: NodeJS.WriteStream, override: StageSizeOverride = {}): StageSize {
  const columns = Math.max(20, Math.floor(override.columns ?? out.columns ?? 80));
  const rows = Math.max(10, Math.floor(override.rows ?? out.rows ?? 24));
  return { columns, rows };
}

export function stageCapabilities(
  out: NodeJS.WriteStream,
  options: StageOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): StageCapabilities {
  const size = stageSize(out, options);
  const interactive = out.isTTY === true;
  const color = options.color ?? colourEnabled(out);
  const unicode = options.unicode ?? supportsUnicode();
  const alternate = options.alternate
    ?? (interactive && env.TERM !== 'dumb' && env.FLUX_NO_ALTSCREEN !== '1');
  const pinned = options.pinned
    ?? (interactive
      && env.FLUX_NO_PIN !== '1'
      && size.columns >= (options.minColumns ?? 70)
      && size.rows >= (options.minRows ?? 22));
  return { interactive, color, unicode, alternate, pinned };
}

export function promptPageSize(rows: number, headerHeight: number, choices: number, chrome = 10): number {
  return Math.max(2, Math.min(choices, rows - headerHeight - chrome));
}

export function selectPromptTheme(color: boolean, unicode: boolean) {
  const p = palette(color);
  return {
    prefix: {
      idle: `${p.purple}?${p.reset}`,
      done: `${p.green}${unicode ? '✓' : 'ok'}${p.reset}`,
    },
    indexMode: 'number' as const,
    style: {
      message: (text: string) => `${p.bold}${p.cyan}${text}${p.reset}`,
      answer: (text: string) => `${p.bold}${p.green}${text}${p.reset}`,
      help: (text: string) => `${p.dim}${text}${p.reset}`,
      error: (text: string) => `${p.bold}${p.pink}${text}${p.reset}`,
      highlight: (text: string) => `${p.bold}${p.white}${text}${p.reset}`,
      defaultAnswer: (text: string) => `${p.dim}${text}${p.reset}`,
    },
    icon: {
      cursor: unicode ? `${p.pink}❯${p.reset}` : '>',
    },
  };
}

export function textPromptTheme(color: boolean) {
  const p = palette(color);
  return {
    prefix: {
      idle: `${p.purple}?${p.reset}`,
      done: `${p.green}✓${p.reset}`,
    },
    style: {
      message: (text: string) => `${p.bold}${p.cyan}${text}${p.reset}`,
      answer: (text: string) => `${p.bold}${p.green}${text}${p.reset}`,
      help: (text: string) => `${p.dim}${text}${p.reset}`,
      error: (text: string) => `${p.bold}${p.pink}${text}${p.reset}`,
      defaultAnswer: (text: string) => `${p.dim}${text}${p.reset}`,
    },
  };
}

export function confirmPromptTheme(color: boolean) {
  const p = palette(color);
  return {
    prefix: {
      idle: `${p.purple}?${p.reset}`,
      done: `${p.green}✓${p.reset}`,
    },
    style: {
      message: (text: string) => `${p.bold}${p.cyan}${text}${p.reset}`,
      answer: (text: string) => `${p.bold}${p.green}${text}${p.reset}`,
      help: (text: string) => `${p.dim}${text}${p.reset}`,
      error: (text: string) => `${p.bold}${p.pink}${text}${p.reset}`,
    },
  };
}

export function sectionFrame(title: string, detail: readonly string[], width: number, color: boolean, unicode: boolean): string[] {
  const p = palette(color);
  const corners = unicode
    ? { left: '┌', right: '┐', bar: '│', line: '─' }
    : { left: '+', right: '+', bar: '|', line: '-' };
  const top = `${p.purple}${corners.left}${corners.line.repeat(Math.max(2, width - 2))}${corners.right}${p.reset}`;
  const titleLine = `${p.purple}${corners.bar}${p.reset} ${p.bold}${p.white}${fitCell(title, Math.max(0, width - 4))}${p.reset} ${p.purple}${corners.bar}${p.reset}`;
  const detailLines = detail.map((entry) => (
    `${p.purple}${corners.bar}${p.reset} ${p.dim}${fitCell(entry, Math.max(0, width - 4))}${p.reset} ${p.purple}${corners.bar}${p.reset}`
  ));
  return ['', top, titleLine, ...detailLines];
}

export function receiptFrame(lines: readonly string[], width: number, color: boolean, unicode: boolean): string[] {
  const p = palette(color);
  const corners = unicode
    ? { left: '└', right: '┘', bar: '│', line: '─' }
    : { left: '+', right: '+', bar: '|', line: '-' };
  const body = lines.map((entry) => (
    `${p.purple}${corners.bar}${p.reset} ${p.green}${fitCell(entry, Math.max(0, width - 4))}${p.reset} ${p.purple}${corners.bar}${p.reset}`
  ));
  const bottom = `${p.purple}${corners.left}${corners.line.repeat(Math.max(2, width - 2))}${corners.right}${p.reset}`;
  return [...body, bottom, ''];
}

export class Stage {
  private active = false;
  private headerHeight = 0;

  constructor(private out: NodeJS.WriteStream = process.stdout, private options: StageOptions = {}) {}

  size(): StageSize {
    return stageSize(this.out, this.options);
  }

  capabilities(): StageCapabilities {
    return stageCapabilities(this.out, this.options);
  }

  isActive(): boolean {
    return this.active;
  }

  headerHeightValue(): number {
    return this.headerHeight;
  }

  begin(header: readonly string[]): void {
    const size = this.size();
    const capabilities = this.capabilities();
    if (!capabilities.pinned || header.length === 0 || header.length > size.rows - 4) {
      this.active = false;
      this.headerHeight = 0;
      this.write(`${header.join('\n')}\n`);
      return;
    }
    if (capabilities.alternate) this.write(`${ALT_ENTER}${CURSOR_HIDE}`);
    this.write('\x1b[2J\x1b[H');
    this.write(`${header.join('\n')}\n`);
    this.write(scrollRegion(header.length + 1, size.rows));
    this.write(moveTo(header.length + 1, 1));
    this.active = true;
    this.headerHeight = header.length;
  }

  update(header: readonly string[]): void {
    const size = this.size();
    if (!this.active) {
      this.write(`${header.join('\n')}\n`);
      return;
    }
    if (header.length !== this.headerHeight || header.length > size.rows - 4) {
      this.reset(header);
      return;
    }
    this.write(CURSOR_SAVE + SCROLL_RESET + moveTo(1, 1));
    header.forEach((line, index) => {
      this.write(`${ERASE_LINE}${line}`);
      if (index < header.length - 1) this.write('\n');
    });
    this.write(scrollRegion(this.headerHeight + 1, size.rows));
    this.write(CURSOR_RESTORE);
  }

  reset(header: readonly string[]): void {
    const size = this.size();
    const capabilities = this.capabilities();
    this.write(SCROLL_RESET);
    if (!capabilities.pinned || header.length === 0 || header.length > size.rows - 4) {
      this.active = false;
      this.headerHeight = 0;
      this.write(`${header.join('\n')}\n`);
      return;
    }
    if (capabilities.alternate && !this.active) this.write(`${ALT_ENTER}${CURSOR_HIDE}`);
    this.write('\x1b[2J\x1b[H');
    this.write(`${header.join('\n')}\n`);
    this.write(scrollRegion(header.length + 1, size.rows));
    this.write(moveTo(header.length + 1, 1));
    this.active = true;
    this.headerHeight = header.length;
  }

  section(title: string, detail: readonly string[] = []): void {
    const size = this.size();
    const capabilities = this.capabilities();
    for (const line of sectionFrame(title, detail, size.columns, capabilities.color, capabilities.unicode)) {
      this.write(`${line}\n`);
    }
  }

  receipt(lines: readonly string[] = []): void {
    const size = this.size();
    const capabilities = this.capabilities();
    for (const line of receiptFrame(lines, size.columns, capabilities.color, capabilities.unicode)) {
      this.write(`${line}\n`);
    }
  }

  stop(finalLines: readonly string[] = []): void {
    if (!this.active) {
      if (finalLines.length > 0) this.write(`${finalLines.join('\n')}\n`);
      return;
    }
    const capabilities = this.capabilities();
    this.write(`${SCROLL_RESET}${CURSOR_SHOW}`);
    if (capabilities.alternate) this.write(ALT_LEAVE);
    this.active = false;
    this.headerHeight = 0;
    if (finalLines.length > 0) this.write(`${finalLines.join('\n')}\n`);
  }

  private write(chunk: string): void {
    this.out.write(chunk);
  }
}
