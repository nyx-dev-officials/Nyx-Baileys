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
/**
 * Display font.
 *
 * Seven-row letterforms, doubled for weight and presence.
 *
 * Three earlier attempts failed, and the reason is worth recording:
 *
 *   1. Drawn directly at 23 columns wide and 7 rows tall, strokes ended up one
 *      column apart on the top row and touching outright along the baseline.
 *      Wide-and-shallow is the wrong proportion — the diagonal gets so gradual
 *      it reads as a wedge rather than a letter.
 *
 *   2. At 6x6, X and Y became indistinguishable in their upper halves. Both
 *      open `#   #`, so at a glance the word read as three similar glyphs.
 *
 *   3. The fix for both is 7x7 with real diagonals: X now has a visible
 *      crossing cell at row 4 and Y has a distinct open fork, so they differ
 *      from the first row.
 *
 * Glyphs are authored at 7x7 and doubled, so the shapes stay hand-checkable
 * rather than being drawn at double width where the diagonal is easy to get
 * subtly wrong.
 */
const SRC: Record<string, readonly string[]> = {
  N: [
    '#     #',
    '##    #',
    '# #   #',
    '#  #  #',
    '#   # #',
    '#    ##',
    '#     #',
  ],
  Y: [
    '#     #',
    '#     #',
    '#     #',
    ' #   # ',
    '  # #  ',
    '   #   ',
    '   #   ',
  ],
  X: [
    '#     #',
    ' #   # ',
    '  # #  ',
    '   #   ',
    '  # #  ',
    ' #   # ',
    '#     #',
  ],
  ' ': ['       ', '       ', '       ', '       ', '       ', '       ', '       '],
};

/** Scale factor applied to every authored glyph. */
const SCALE = 2;
/**
 * Blank columns between glyphs.
 *
 * This must be *wider than the widest gap inside a glyph*, or the word reads as
 * one shape rather than three letters. The widest intra-glyph gap is five
 * source columns, which doubles to ten; spacing of three made the letters
 * closer to each other than each letter's own strokes are, which is the same
 * merging problem as before at a subtler scale.
 */
const LETTER_SPACING = 12;

/** Doubled height of the rendered banner. */
export const BANNER_HEIGHT = 7 * SCALE;

/** Render text in the display font. */
export function banner(text: string, colour: (s: string) => string): string {
  const glyphs = [...text.toUpperCase()].map((c) => SRC[c] ?? SRC[' ']!);
  const rows: string[] = [];
  for (let r = 0; r < BANNER_HEIGHT; r++) {
    const srcRow = Math.floor(r / SCALE);
    const line = glyphs
      .map((g) => (g[srcRow] ?? '').split('').map((ch) => (ch === '#' ? '#' : ' ').repeat(SCALE)).join(''))
      .join(' '.repeat(LETTER_SPACING));
    rows.push(line.replace(/\s+$/, ''));
  }
  return rows.map(colour).join('\n');
}

/** Width of the rendered banner, in columns. */
export function bannerWidth(text: string): number {
  const glyphs = [...text.toUpperCase()];
  if (glyphs.length === 0) return 0;
  return glyphs.length * 7 * SCALE + (glyphs.length - 1) * LETTER_SPACING;
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
  // Placement is uniform with a minimum separation, not a jittered grid.
  //
  // A jittered grid was the original approach and it fails badly on a wide,
  // short field: with 26 nodes across 70x9 the column count rounds to 14 and the
  // row count collapses to 2, so every node lands inside two horizontal bands
  // and the "network" becomes a blob. Uniform scatter with a minimum separation
  // has no such failure mode — density is set by the count and the separation,
  // independent of the field's aspect ratio.
  //
  // Nodes are kept a third of a cell in from every edge, because nodes landing
  // on the boundary leave the first and last rows completely empty.
  // No inset. An earlier version reserved a cell at every edge, which on a
  // 70x9 field left the first and last rows permanently blank. Minimum
  // separation already prevents the clumping that inset was there to avoid.
  const inset = 0;
  const grid: string[][] = Array.from({ length: height }, () => Array(width).fill(' '));

  const minSep = Math.max(2, Math.round(Math.sqrt((width * height) / Math.max(1, nodes)) * 0.55));
  const pts: Array<[number, number]> = [];
  const attempts = nodes * 40;
  for (let i = 0; i < attempts && pts.length < nodes; i++) {
    const x = Math.floor(rand() * width);
    const y = Math.floor(rand() * height);
    let clear = true;
    for (const [px, py] of pts) {
      if ((px - x) ** 2 + (py - y) ** 2 < minSep * minSep) { clear = false; break; }
    }
    // Two nodes on the same cell read as one blob, so duplicates are dropped.
    if (clear) pts.push([x, y]);
  }
  // Fill by progressively relaxing the minimum separation until every node
  // fits. An earlier version fell back to placing the remainder with no
  // separation at all, which put two nodes on adjacent cells and read as one
  // blob. Loosening the constraint is the honest trade: the picture stays
  // readable and the node count stays what was asked for.
  while (pts.length < nodes) {
    let placedOne = false;
    for (let attempt = 0; attempt < 200 && !placedOne; attempt++) {
      const x = Math.floor(rand() * width);
      const y = Math.floor(rand() * height);
      const clear = pts.every(([px, py]) => (px - x) ** 2 + (py - y) ** 2 >= 4);
      if (clear) { pts.push([x, y]); placedOne = true; }
    }
    if (!placedOne) {
      // Genuinely full. Take the farthest cell from the nearest existing node,
      // which spreads the remainder instead of stacking it in a corner.
      let best: [number, number] = [0, 0];
      let bestDist = -1;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const nearest = Math.min(...pts.map(([px, py]) => (px - x) ** 2 + (py - y) ** 2));
          if (nearest > bestDist) { bestDist = nearest; best = [x, y]; }
        }
      }
      pts.push(best);
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
  // Clamp rather than pad a negative amount. An over-long code would otherwise
  // overflow the border and leave the frame with ragged sides, which is exactly
  // the kind of thing that looks fine in a test and breaks in a terminal.
  const shown = grouped.length > inner - 2 ? grouped.slice(0, inner - 5) + '...' : grouped;
  const top = `+${'-'.repeat(inner)}+`;
  const mid = `|${' '.repeat(Math.max(0, inner - shown.length - 2))}${shown}  |`;
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