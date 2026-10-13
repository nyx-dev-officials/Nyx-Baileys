/**
 * Pairing code and QR rendering.
 *
 * Split out of `cli/commands.ts` so the interactive wizard and the command
 * surface draw identical output. Two copies of a QR renderer is two chances to
 * ship one that does not scan.
 */

import { encodeQr, renderQrCompact } from '../toolkit/qr.js';
import { displayWidth } from './output.js';

/** Anything that can write a line. Structurally satisfied by the CLI Reporter. */
export interface LineIo {
  line(text?: string): void;
  readonly color: boolean;
}

/**
 * Box an 8-digit pairing code.
 *
 * `12345678` is easy to mistype, so it is grouped `1234 5678`. An over-long code
 * is truncated rather than allowed to overflow: a frame with ragged sides looks
 * correct in a test and broken in a terminal.
 */
export function codeFrame(code: string, colour: (s: string) => string): string {
  const inner = 40;
  const grouped = code.replace(/\D/g, '').length === 8
    ? `${code.replace(/\D/g, '').slice(0, 4)}  ${code.replace(/\D/g, '').slice(4)}`
    : code;
  const shown = grouped.length > inner - 2 ? `${grouped.slice(0, inner - 5)}...` : grouped;
  const top = `+${'-'.repeat(inner)}+`;
  const mid = `|${' '.repeat(Math.max(0, inner - shown.length - 2))}${shown}  |`;
  const bottom = `+${'-'.repeat(inner)}+`;
  return [top, mid, bottom].map((l) => colour(l)).join('\n');
}

/**
 * Render a pairing ref as a scannable QR.
 *
 * Half-block characters are load-bearing: a terminal cell is roughly twice as
 * tall as it is wide, so one character per module draws the symbol at twice the
 * correct height and phone cameras reject it.
 *
 * Nothing is drawn when colour is unavailable, because a QR that cannot be
 * scanned is worse than one line saying why.
 */
export interface QrFrameSize {
  readonly rows: number;
  readonly columns: number;
}

export interface QrViewport {
  readonly rows: number;
  readonly columns: number;
  readonly headerHeight: number;
  readonly reserve?: number;
}

export function qrFrameSize(ref: string): QrFrameSize | null {
  try {
    const lines = renderQrCompact(encodeQr(ref, 'L'), 4).split('\n');
    return {
      rows: lines.length + 2,
      columns: Math.max(...lines.map((line) => displayWidth(line))) + 2,
    };
  } catch {
    return null;
  }
}

export function qrFitsViewport(frame: QrFrameSize, viewport: QrViewport): boolean {
  const reserve = viewport.reserve ?? 8;
  return frame.rows + viewport.headerHeight + reserve <= viewport.rows
    && frame.columns + 4 <= viewport.columns;
}

export function qrRowCount(io: LineIo, ref: string): number {
  return qrFrameSize(ref)?.rows ?? 0;
}

/** Erase the block a previous `renderTerminalQr` call left on screen. */
export function eraseTerminalQr(io: LineIo, rows: number): void {
  if (!io.color || rows <= 0) return;
  io.line(`[${rows}A[0J`);
}

export function renderTerminalQr(io: LineIo, ref: string): void {
  if (!io.color) {
    io.line('  (terminal QR needs colour; set FORCE_COLOR=1 to force it)');
    return;
  }
  try {
    const rows = renderQrCompact(encodeQr(ref, 'L'), 4).split('\n');
    // Dark modules on a light field: WhatsApp expects dark-on-light.
    io.line();
    for (const row of rows) io.line(`  \x1b[47m\x1b[30m${row}\x1b[0m`);
    io.line();
  } catch (err) {
    io.line(`  could not render the QR: ${(err as Error).message}`);
  }
}

/** Minimal `LineIo` over a raw stream, for callers outside the Reporter. */
export function streamIo(out: NodeJS.WriteStream, color: boolean): LineIo {
  return {
    color,
    line: (text = '') => { out.write(`${text}\n`); },
  };
}
