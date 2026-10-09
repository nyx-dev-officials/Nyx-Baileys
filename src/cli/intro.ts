/**
 * The pairing introduction — visual only.
 *
 * ## Design intent
 *
 * No instructions. This screen exists to establish that something substantial
 * just started, and then get out of the way. Everything about how to pair is
 * obvious or is covered by the error messages; what is *not* obvious is what
 * this tool feels like, and that is what this renders.
 *
 * The composition is three bands:
 *
 *   1. a masthead — the name at display size
 *   2. a generated network field — nodes and links, because this is a socket
 *      framework and a graph is what it actually is
 *   3. a thin rule and three facts, small and dim, which is the only text
 *
 * Rules held to:
 *
 *   - Pure ASCII. A Windows console still defaults to a legacy code page, and a
 *     single box-drawing or block character turns the whole screen into
 *     mojibake. ASCII is a hard constraint here, not a stylistic preference.
 *   - Colour carries meaning rather than decoration: cyan for the masthead,
 *     dim grey for everything structural, one accent for the live element.
 *   - The network is seeded deterministically per run via a supplied seed, so
 *     the same terminal produces the same picture and a screenshot is
 *     reproducible.
 *   - Lines never exceed the rule width, so nothing wraps on an 80-column
 *     terminal into an unreadable second row.
 */

const WIDTH = 74;

/** Display font. Each glyph is seven rows tall and a fixed width. */
const GLYPH_W = 23;

const FONT: Record<string, string[]> = {
  N: [
    '#                     #',
    '##                    ##',
    '# #                   # #',
    '#  #                  # #',
    '#   #                 # #',
    '#    #               # #',
    '#     ############## # #',
  ],
  Y: [
    '#                     #',
    ' #                    # ',
    '  #                   # ',
    '   #                  #  ',
    '    #                #   ',
    '     #              #    ',
    '      ###############     ',
  ],
  X: [
    '#                     #',
    ' #                    # ',
    '  #                   # ',
    '   #                 #   ',
    '    #               #    ',
    '     #             #     ',
    '      #############      ',
  ],
  ' ': Array(7).fill(' '.repeat(GLYPH_W)),
};

/** Render text in the display font, glyphs separated by one blank column. */
export function banner(text: string, colour: (s: string) => string): string {
  const glyphs = [...text.toUpperCase()].map((c) => FONT[c] ?? FONT[' ']!);
  const rows: string[] = [];
  for (let r = 0; r < 7; r++) {
    rows.push(glyphs.map((g) => g[r] ?? '').join(' ').replace(/\s+$/, ''));
  }
  return rows.map(colour).join('\n');
}
/**
 * A small deterministic PRNG.
 *
 * mulberry32 — chosen because it is four lines, has no dependencies, and gives
 * good distribution for a purely visual purpose. `Math.random()` would make the
 * screen unreproducible, which matters when someone is comparing screenshots.
 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A generated network field.
 *
 * Nodes are scattered, then each is joined to its nearest few neighbours. The
 * result reads as a network rather than as static because the link pattern is
 * derived from real proximity — a dense cluster looks dense.
 *
 * Renders into a character grid, so links and nodes compose without either one
 * having to know about the other.
 */
export function networkField(
  width: number,
  height: number,
  seed: number,
  nodes: number,
  linksPerNode = 2,
): string[] {
  const rand = rng(seed);
  const grid: string[][] = Array.from({ length: height }, () => Array(width).fill(' '));

  // Place nodes on a jittered grid so they spread evenly instead of clumping.
  const cols = Math.max(3, Math.round(Math.sqrt(nodes * (width / height))));
  const rows = Math.ceil(nodes / cols);
  const pts: Array<[number, number]> = [];
  let placed = 0;
  for (let r = 0; r < rows && placed < nodes; r++) {
    for (let c = 0; c < cols && placed < nodes; c++, placed++) {
      const x = Math.round(((c + 0.5 + (rand() - 0.5) * 0.7) / cols) * (width - 1));
      const y = Math.round(((r + 0.5 + (rand() - 0.5) * 0.7) / rows) * (height - 1));
      if (x >= 0 && x < width && y >= 0 && y < height) pts.push([x, y]);
    }
  }

  // Draw links first so nodes overwrite them at the junctions.
  for (const [x, y] of pts) {
    const near = pts
      .filter(([ox, oy]) => !(ox === x && oy === y))
      .map(([ox, oy]) => ({ x: ox, y: oy, d: (ox - x) ** 2 + (oy - y) ** 2 }))
      .sort((a, b) => a.d - b.d)
      .slice(0, linksPerNode);
    for (const { x: ox, y: oy } of near) {
      drawLine(grid, x, y, ox, oy, width, height);
    }
  }

  for (const [x, y] of pts) {
    if (x >= 0 && x < width && y >= 0 && y < height) grid[y]![x] = '*';
  }

  return grid.map((row) => row.join(''));
}

/** Bresenham, so links are straight and complete rather than dotted. */
function drawLine(
  grid: string[][],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  width: number,
  height: number,
): void {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let [x, y] = [x0, y0];
  for (let guard = 0; guard < width * height; guard++) {
    if (x >= 0 && x < width && y >= 0 && y < height && grid[y]![x] === ' ') grid[y]![x] = '.';
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
}

/** A framed code display. Used only for the pairing code itself. */
export function codeFrame(code: string, colour: (s: string) => string): string {
  const inner = WIDTH - 4;
  const grouped = code.length === 8 ? `${code.slice(0, 4)}  ${code.slice(4)}` : code;
  const top = `+${'-'.repeat(inner)}+`;
  const mid = `|${' '.repeat(Math.max(0, inner - grouped.length - 2))}${grouped}  |`;
  const bottom = `+${'-'.repeat(inner)}+`;
  return [top, mid, bottom].map((l) => colour(l)).join('\n');
}

/** The Reporter satisfies this; declared structurally so cli can pass it directly. */
export interface IntroIo {
  line(text?: string): void;
  note(text: string): void;
  paint(text: string, code: 'bold' | 'dim' | 'red' | 'green' | 'yellow' | 'blue' | 'cyan'): string;
}

export interface IntroOptions {
  version: string;
  sessionDir: string;
  /** Any number. Same seed gives the same picture, so screenshots reproduce. */
  seed?: number;
}

/**
 * Render the whole introduction.
 *
 * Returns the text rather than printing it, which keeps the layout testable:
 * asserting on the string is far easier than asserting on terminal output.
 */
export function renderIntro(io: IntroIo, opts: IntroOptions): string {
  const seed = opts.seed ?? 0x4E5859;
  const out: string[] = [];
  const add = (s = ''): void => { out.push(s); io.line(s); };

  const cyan = (s: string): string => io.paint(s, 'cyan');
  const dim = (s: string): string => io.paint(s, 'dim');
  const bold = (s: string): string => io.paint(s, 'bold');

  add();
  add(dim('-'.repeat(WIDTH)));

  // Band 1 — masthead, indented so it does not touch the rule.
  for (const row of banner('NYX', cyan).split('\n')) add(`  ${row}`);

  add();
  const versionLine = `v${opts.version}`;
  const tagline = 'whatsapp framework';
  const gap = Math.max(3, WIDTH - versionLine.length - tagline.length - 4);
  add(`  ${dim(versionLine)}${' '.repeat(gap)}${dim(tagline)}`);
  add(dim('-'.repeat(WIDTH)));

  // Band 2 — the generated field. Dense enough to read as a network rather
  // than as scattered dots.
  add();
  const field = networkField(WIDTH - 4, 9, seed, 26, 3);
  for (const row of field) add(`  ${dim(row)}`);
  add();

  add(dim('-'.repeat(WIDTH)));

  // Band 3 — three facts. The only prose on the screen.
  add();
  add(`  ${dim(pad('session', 12))}${opts.sessionDir}`);
  add(`  ${dim(pad('process', 12))}${bold('node')} ${dim('holding a live socket')}`);
  add();

  return out.join('\n');
}

function pad(text: string, n: number): string {
  return text + ' '.repeat(Math.max(0, n - text.length));
}

export { WIDTH as INTRO_WIDTH };