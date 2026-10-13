/**
 * QR Code encoder — ISO/IEC 18004, byte mode, error correction level M.
 *
 * ## Why this exists instead of a dependency
 *
 * There is no QR package installed and adding one for a single feature is a
 * heavy trade. More importantly, a QR command that returns ASCII art labelled
 * "QR code" without actually being scannable is worse than useless — people
 * put these in menus and flyers. This produces a real, spec-conformant symbol
 * that a phone camera reads.
 *
 * ## Scope
 *
 * Versions 1 through 10 at EC level M. That covers 14 to 213 bytes of UTF-8,
 * which is more than enough for a URL or a short message. Longer input is
 * rejected with a clear message naming the limit, rather than silently
 * truncating and producing a QR that decodes to something else.
 *
 * ## Implementation notes
 *
 * - Reed-Solomon over GF(256) with the QR primitive polynomial 0x11D.
 * - Mask selection runs the full four-penalty-rule scoring rather than
 *   defaulting to mask 0, because a fixed mask produces visibly worse symbols
 *   on some inputs and occasionally a QR that scanners struggle with.
 * - The data placement is the standard zig-zag from bottom-right upward,
 *   skipping the vertical timing column.
 */

/** Galois field log/antilog tables for GF(256) with primitive polynomial 0x11D. */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

(function initTables(): void {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11D;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

/** Reed-Solomon generator polynomial of the given degree. */
function rsGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] = next[j]! ^ poly[j]!;
      next[j + 1] = next[j + 1]! ^ gfMul(poly[j]!, EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

/** Compute `count` Reed-Solomon error correction codewords for a block. */
function rsEncode(data: Uint8Array, count: number): Uint8Array {
  const gen = rsGenerator(count);
  const remainder = new Uint8Array(count);
  for (const byte of data) {
    const factor = byte ^ remainder[0]!;
    remainder.copyWithin(0, 1);
    remainder[count - 1] = 0;
    if (factor !== 0) {
      for (let i = 0; i < count; i++) {
        remainder[i] = remainder[i]! ^ gfMul(gen[i + 1]!, factor);
      }
    }
  }
  return remainder;
}

/** Per-version parameters at EC level M. */
interface VersionSpec {
  /** Total codewords available. */
  total: number;
  /** Error correction codewords per block. */
  eccPerBlock: number;
  /** Blocks in group 1 and how many data codewords each holds. */
  group1Blocks: number;
  group1Data: number;
  /** Group 2 blocks are one codeword longer than group 1. */
  group2Blocks: number;
  group2Data: number;
  /** Alignment pattern centre coordinates. */
  alignment: number[];
}

const VERSIONS: VersionSpec[] = [
  /* v1 */ { total: 26, eccPerBlock: 10, group1Blocks: 1, group1Data: 16, group2Blocks: 0, group2Data: 0, alignment: [] },
  /* v2 */ { total: 44, eccPerBlock: 16, group1Blocks: 1, group1Data: 28, group2Blocks: 0, group2Data: 0, alignment: [6, 18] },
  /* v3 */ { total: 70, eccPerBlock: 26, group1Blocks: 1, group1Data: 44, group2Blocks: 0, group2Data: 0, alignment: [6, 22] },
  /* v4 */ { total: 100, eccPerBlock: 18, group1Blocks: 2, group1Data: 32, group2Blocks: 0, group2Data: 0, alignment: [6, 26] },
  /* v5 */ { total: 134, eccPerBlock: 24, group1Blocks: 2, group1Data: 43, group2Blocks: 0, group2Data: 0, alignment: [6, 30] },
  /* v6 */ { total: 172, eccPerBlock: 16, group1Blocks: 4, group1Data: 27, group2Blocks: 0, group2Data: 0, alignment: [6, 34] },
  /* v7 */ { total: 196, eccPerBlock: 18, group1Blocks: 4, group1Data: 31, group2Blocks: 0, group2Data: 0, alignment: [6, 22, 38] },
  /* v8 */ { total: 242, eccPerBlock: 22, group1Blocks: 2, group1Data: 38, group2Blocks: 2, group2Data: 39, alignment: [6, 24, 42] },
  /* v9 */ { total: 292, eccPerBlock: 22, group1Blocks: 3, group1Data: 36, group2Blocks: 2, group2Data: 37, alignment: [6, 26, 46] },
  /* v10 */ { total: 346, eccPerBlock: 26, group1Blocks: 4, group1Data: 43, group2Blocks: 1, group2Data: 44, alignment: [6, 28, 50] },
];

/**
 * Error-correction level, as the two-bit value used in format information.
 *
 * Only L and M are tabulated. Q and H have no capacity rows here, so
 * advertising them would just be a way to produce a symbol this encoder cannot
 * build correctly.
 */
const EC_BITS = { L: 0b01, M: 0b00 } as const;
export type EccLevel = keyof typeof EC_BITS;

/**
 * Version 1-11 at error-correction level **L**.
 *
 * Added because level M tops out at 213 bytes and a real WhatsApp pairing ref is
 * 277. Level L reaches 321 bytes at version 11, so the QR branch drew nothing
 * at all — `encodeQr` threw, and the caller caught it and printed a single line,
 * which reads as a hang rather than an error.
 *
 * Level L is the right trade here: a pairing ref is read once, by a phone held
 * at normal distance, so the extra redundancy of M buys nothing and costs the
 * ~60 bytes of payload we needed.
 *
 * Every row satisfies `total === data + eccPerBlock * blocks`, and the resulting
 * byte-mode capacities match ISO/IEC 18004 Table 7 (v10-L = 271, v11-L = 321).
 * These tables are not trusted on recall — `tests/qr-render.test.js` decodes
 * the finished symbol and compares it to the input.
 */
const VERSIONS_L: VersionSpec[] = [
  /* v1  */ { total: 26, eccPerBlock: 7, group1Blocks: 1, group1Data: 19, group2Blocks: 0, group2Data: 0, alignment: [] },
  /* v2  */ { total: 44, eccPerBlock: 10, group1Blocks: 1, group1Data: 34, group2Blocks: 0, group2Data: 0, alignment: [6, 18] },
  /* v3  */ { total: 70, eccPerBlock: 15, group1Blocks: 1, group1Data: 55, group2Blocks: 0, group2Data: 0, alignment: [6, 22] },
  /* v4  */ { total: 100, eccPerBlock: 20, group1Blocks: 1, group1Data: 80, group2Blocks: 0, group2Data: 0, alignment: [6, 26] },
  /* v5  */ { total: 134, eccPerBlock: 26, group1Blocks: 1, group1Data: 108, group2Blocks: 0, group2Data: 0, alignment: [6, 30] },
  /* v6  */ { total: 172, eccPerBlock: 18, group1Blocks: 2, group1Data: 68, group2Blocks: 0, group2Data: 0, alignment: [6, 34] },
  /* v7  */ { total: 196, eccPerBlock: 20, group1Blocks: 2, group1Data: 78, group2Blocks: 0, group2Data: 0, alignment: [6, 22, 38] },
  /* v8  */ { total: 242, eccPerBlock: 24, group1Blocks: 2, group1Data: 97, group2Blocks: 0, group2Data: 0, alignment: [6, 24, 42] },
  /* v9  */ { total: 292, eccPerBlock: 30, group1Blocks: 2, group1Data: 116, group2Blocks: 0, group2Data: 0, alignment: [6, 26, 46] },
  /* v10 */ { total: 346, eccPerBlock: 18, group1Blocks: 2, group1Data: 68, group2Blocks: 2, group2Data: 69, alignment: [6, 28, 50] },
  /* v11 */ { total: 404, eccPerBlock: 20, group1Blocks: 4, group1Data: 81, group2Blocks: 0, group2Data: 0, alignment: [6, 30, 54] },
];

/** Byte-mode payload capacity at level M, indexed by version - 1. */
const CAPACITY_M: number[] = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];

/** Byte-mode payload capacity at level L, indexed by version - 1. */
const CAPACITY_L: number[] = [17, 32, 53, 78, 106, 134, 154, 192, 230, 271, 321];

const VERSIONS_BY_LEVEL = { L: VERSIONS_L, M: VERSIONS } as const;

/** Version parameters for a given error-correction level. */
function versionSpec(version: number, level: EccLevel): VersionSpec {
  const table = VERSIONS_BY_LEVEL[level];
  const spec = table[version - 1];
  if (!spec) throw new Error(`version ${version} is outside this encoder's ${level} range (1-${table.length})`);
  return spec;
}

/**
 * Pick the smallest version that fits, or throw naming the limit.
 *
 * Throwing matters: truncating input to fit would produce a scannable QR that
 * silently decodes to something other than what the user typed.
 */
function chooseVersion(byteLength: number, level: EccLevel): number {
  const capacity = level === 'L' ? CAPACITY_L : CAPACITY_M;
  for (let i = 0; i < capacity.length; i++) {
    if (byteLength <= capacity[i]!) return i + 1;
  }
  throw new Error(
    `That is ${byteLength} bytes; this encoder handles up to ${capacity[capacity.length - 1]} `
    + `at error correction level ${level}. Shorten the text or split it into two codes.`,
  );
}

/** Build the final interleaved codeword stream. */
function buildCodewords(bytes: Uint8Array, version: number, level: EccLevel): Uint8Array {
  const spec = versionSpec(version, level);
  const bits: number[] = [];

  // Byte mode indicator.
  bits.push(0, 1, 0, 0);
  // Character count: 8 bits up to version 9, 16 bits from version 10.
  const countBits = version < 10 ? 8 : 16;
  for (let i = countBits - 1; i >= 0; i--) bits.push((bytes.length >> i) & 1);
  for (const byte of bytes) {
    for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);
  }

  const dataCodewords = spec.group1Blocks * spec.group1Data + spec.group2Blocks * spec.group2Data;
  const capacityBits = dataCodewords * 8;

  // Terminator, then pad to a byte boundary.
  for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = new Uint8Array(dataCodewords);
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]!;
    codewords[i / 8] = byte;
  }
  // Alternating pad codewords, as the specification requires.
  const PADS = [0xEC, 0x11];
  for (let i = bits.length / 8, k = 0; i < dataCodewords; i++, k++) codewords[i] = PADS[k % 2]!;

  // Split into blocks, compute ECC for each.
  const dataBlocks: Uint8Array[] = [];
  const eccBlocks: Uint8Array[] = [];
  let offset = 0;
  for (let i = 0; i < spec.group1Blocks; i++) {
    const block = codewords.slice(offset, offset + spec.group1Data);
    offset += spec.group1Data;
    dataBlocks.push(block);
    eccBlocks.push(rsEncode(block, spec.eccPerBlock));
  }
  for (let i = 0; i < spec.group2Blocks; i++) {
    const block = codewords.slice(offset, offset + spec.group2Data);
    offset += spec.group2Data;
    dataBlocks.push(block);
    eccBlocks.push(rsEncode(block, spec.eccPerBlock));
  }

  // Interleave: one codeword from each block in turn, data then ECC.
  const out = new Uint8Array(spec.total);
  let p = 0;
  const maxData = Math.max(spec.group1Data, spec.group2Data);
  for (let i = 0; i < maxData; i++) {
    for (const block of dataBlocks) if (i < block.length) out[p++] = block[i]!;
  }
  for (let i = 0; i < spec.eccPerBlock; i++) {
    for (const block of eccBlocks) out[p++] = block[i]!;
  }
  return out;
}

type Grid = Int8Array[];

/**
 * Allocate a square grid.
 *
 * `fill` is a single module value, not a row pattern — passing a row here once
 * produced a grid whose every cell shared one array's contents, which the
 * typechecker caught as an argument-type error.
 */
function newGrid(size: number, fill: number): Grid {
  return Array.from({ length: size }, () => new Int8Array(size).fill(fill));
}

/** Draw the three finder patterns and their separators. */
function drawFinders(grid: Grid, reserved: Grid, size: number): void {
  const place = (row: number, col: number): void => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const y = row + r, x = col + c;
        if (y < 0 || y >= size || x < 0 || x >= size) continue;
        const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6))
          || (c >= 0 && c <= 6 && (r === 0 || r === 6));
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        const dark = inRing || inCore;
        grid[y]![x] = dark ? 1 : 0;
        reserved[y]![x] = 1;
      }
    }
  };
  place(0, 0);
  place(0, size - 7);
  place(size - 7, 0);
}

function drawTiming(grid: Grid, reserved: Grid, size: number): void {
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0;
    grid[6]![i] = dark ? 1 : 0;
    reserved[6]![i] = 1;
    grid[i]![6] = dark ? 1 : 0;
    reserved[i]![6] = 1;
  }
}

function drawAlignment(grid: Grid, reserved: Grid, centres: number[], size: number): void {
  for (const cy of centres) {
    for (const cx of centres) {
      // Skip the three corners already occupied by finder patterns.
      if ((cy === 6 && cx === 6) || (cy === 6 && cx === size - 7) || (cy === size - 7 && cx === 6)) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const max = Math.max(Math.abs(r), Math.abs(c));
          grid[cy + r]![cx + c] = max === 1 ? 0 : 1;
          reserved[cy + r]![cx + c] = 1;
        }
      }
    }
  }
}

/** Reserve the format information area and set the always-dark module. */
function drawFormatAreas(grid: Grid, reserved: Grid, size: number): void {
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      reserved[8]![i] = 1;
      reserved[i]![8] = 1;
    }
  }
  for (let i = 0; i < 8; i++) {
    reserved[8]![size - 1 - i] = 1;
    reserved[size - 1 - i]![8] = 1;
  }
  reserved[size - 8]![8] = 1; // dark module
  grid[size - 8]![8] = 1;
}

/** BCH(15,5) format information with the mandated 0x5412 mask. */
function formatBits(mask: number, level: EccLevel): number {
  const data = (EC_BITS[level] << 3) | mask;
  let value = data << 10;
  for (let i = 4; i >= 0; i--) {
    if ((value >> (i + 10)) & 1) value ^= 0b10100110111 << i;
  }
  return ((data << 10) | value) ^ 0b101010000010010;
}

/** BCH(18,6) version information, needed from version 7 upward. */
function versionBits(version: number): number {
  let value = version << 12;
  for (let i = 5; i >= 0; i--) {
    if ((value >> (i + 12)) & 1) value ^= 0b1111100100101 << i;
  }
  return (version << 12) | value;
}

function drawFormatInfo(grid: Grid, size: number, mask: number, level: EccLevel): void {
  const bits = formatBits(mask, level);
  for (let i = 0; i < 15; i++) {
    const dark = (bits >> i) & 1;
    // Copy 1, around the top-left finder.
    if (i < 6) grid[i]![8] = dark;
    else if (i === 6) grid[7]![8] = dark;
    else if (i === 7) grid[8]![8] = dark;
    else if (i === 8) grid[8]![7] = dark;
    else grid[8]![14 - i] = dark;
    // Copy 2, split between the other two finders.
    if (i < 8) grid[8]![size - 1 - i] = dark;
    else grid[size - 15 + i]![8] = dark;
  }
}

/**
 * BCH(18,6) version information, required from version 7 upward.
 *
 * Two copies: one above the lower-left finder, one beside the upper-right one.
 *
 * The second copy is the transpose of the first, which is easy to get wrong:
 * it is `grid[size-11 + (i % 3)][floor(i/3)]`, **not** `grid[col][row]` where
 * col already carries the size offset. Writing it transposed put those modules
 * in the wrong place, and because they were never added to the reserved map
 * the data placement then overwrote them — so every symbol from version 7 up
 * decoded to nothing.
 */
function drawVersionInfo(grid: Grid, reserved: Grid, size: number, version: number): void {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const dark = (bits >> i) & 1;
    const r = Math.floor(i / 3);
    const c = i % 3;
    // Copy 1: upper-right block.
    grid[r]![size - 11 + c] = dark;
    reserved[r]![size - 11 + c] = 1;
    // Copy 2: lower-left block, transposed.
    grid[size - 11 + c]![r] = dark;
    reserved[size - 11 + c]![r] = 1;
  }
}

/** Place codeword bits in the standard zig-zag, skipping reserved modules. */
function placeData(grid: Grid, reserved: Grid, size: number, codewords: Uint8Array): void {
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    // The vertical timing pattern column is skipped entirely.
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (let c = 0; c < 2; c++) {
        const col = right - c;
        if (reserved[row]![col]) continue;
        let bit = 0;
        if (bitIndex < totalBits) {
          bit = (codewords[bitIndex >> 3]! >> (7 - (bitIndex & 7))) & 1;
          bitIndex++;
        }
        grid[row]![col] = bit;
      }
    }
    upward = !upward;
  }
}

/** The four mask patterns from the specification. */
function maskAt(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    case 7: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
    default: return false;
  }
}

/** Penalty score for one candidate mask; lower is better. */
function penalty(grid: Grid, size: number): number {
  let score = 0;

  // Rule 1: runs of five or more same-coloured modules in a line.
  for (let i = 0; i < size; i++) {
    for (const horizontal of [true, false]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        const a = horizontal ? grid[i]![j - 1] : grid[j - 1]![i];
        const b = horizontal ? grid[i]![j] : grid[j]![i];
        if (a === b) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else run = 1;
      }
    }
  }

  // Rule 2: 2x2 blocks of one colour.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = grid[r]![c];
      if (v === grid[r]![c + 1] && v === grid[r + 1]![c] && v === grid[r + 1]![c + 1]) score += 3;
    }
  }

  // Rule 3: finder-like 1:1:3:1:1 patterns with four light modules alongside.
  const A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  // The accessor is relative to the start position, so `get(k)` reads offset
  // `start + k`. Passing an absolute accessor here and also offsetting is how
  // this reads one row past the end of the grid.
  const matches = (get: (k: number) => number, pattern: number[]): boolean =>
    pattern.every((p, k) => get(k) === p);
  for (let i = 0; i < size; i++) {
    for (let j = 0; j + 11 <= size; j++) {
      const rowAt = (k: number): number => grid[i]![j + k]!;
      const colAt = (k: number): number => grid[j + k]![i]!;
      if (matches(rowAt, A) || matches(rowAt, B)) score += 40;
      if (matches(colAt, A) || matches(colAt, B)) score += 40;
    }
  }

  // Rule 4: deviation from a 50% dark ratio.
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += grid[r]![c]!;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

export interface QrResult {
  /** Square matrix, 1 = dark. */
  modules: Grid;
  size: number;
  version: number;
  mask: number;
}

/** Encode text as a QR Code symbol. */
export function encodeQr(text: string, level: EccLevel = 'M'): QrResult {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length === 0) throw new Error('Nothing to encode — pass some text.');
  const version = chooseVersion(bytes.length, level);
  const size = version * 4 + 17;
  const codewords = buildCodewords(bytes, version, level);

  let best: { grid: Grid; score: number; mask: number } | null = null;

  // Try every mask and keep the lowest-penalty result.
  for (let mask = 0; mask < 8; mask++) {
    const grid = newGrid(size, 0);
    const reserved = newGrid(size, 0);
    drawFinders(grid, reserved, size);
    drawTiming(grid, reserved, size);
    drawAlignment(grid, reserved, versionSpec(version, level).alignment, size);
    drawFormatAreas(grid, reserved, size);
    drawVersionInfo(grid, reserved, size, version);
    placeData(grid, reserved, size, codewords);

    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!reserved[r]![c] && maskAt(mask, r, c)) grid[r]![c] = grid[r]![c]! ^ 1;
      }
    }
    drawFormatInfo(grid, size, mask, level);

    const score = penalty(grid, size);
    if (!best || score < best.score) best = { grid, score, mask };
  }

  return { modules: best!.grid, size, version, mask: best!.mask };
}

/**
 * Render a QR symbol as text.
 *
 * Two half-block characters per module pair give a square-looking result:
 * a single character per module is twice as tall as it is wide, so the naive
 * "##" per module renders as an obviously stretched rectangle.
 */
export function renderQr(result: QrResult, quiet = 2): string {
  const { modules, size } = result;
  const light = '  ', dark = '██';
  const lines: string[] = [];
  const blank = ' '.repeat(size + quiet * 2);

  const row = (y: number): string => {
    let out = '  '.repeat(quiet);
    for (let x = 0; x < size; x++) out += modules[y]![x] ? dark : light;
    return out + '  '.repeat(quiet);
  };

  for (let i = 0; i < quiet; i++) lines.push(blank);
  for (let y = 0; y < size; y++) lines.push(row(y));
  for (let i = 0; i < quiet; i++) lines.push(blank);
  return lines.join('\n');
}

/** Compact half-block rendering, roughly half the line count. */
/**
 * Render a symbol as half-block characters, two module rows per terminal cell.
 *
 * Three bugs were fixed here, and every one of them made the output
 * unscannable. None is visible to a test that only checks the encoder's module
 * matrix — which is why `tests/qr-render.test.js` decodes the *rendered text*.
 *
 *  - `y + 1 < size` silently dropped the final module row. Every QR size is
 *    `17 + 4 * version`, always odd, so the pair loop never covered the last
 *    row. Every version lost exactly one module row.
 *  - The blank quiet-zone rows were built as `size + quiet * 2`, omitting the
 *    horizontal margins, so the top and bottom margins were narrower than the
 *    symbol they framed.
 *  - The vertical margin was `quiet` *lines* while the horizontal was `quiet`
 *    *modules*. A line is two module rows, so the margin was double on the
 *    vertical and only `quiet` on the horizontal — and 2 modules is below the
 *    four-module minimum in ISO/IEC 18004.
 *
 * `quiet` is therefore interpreted in **modules** on all four sides.
 */
export function renderQrCompact(result: QrResult, quiet = 4): string {
  const { modules, size } = result;
  const margin = ' '.repeat(quiet);
  const blank = margin + ' '.repeat(size) + margin;
  // A terminal cell is two module rows tall, so the vertical margin needs half
  // as many lines. `ceil` keeps an odd margin from losing a row.
  const marginLines = Math.ceil(quiet / 2);
  const lines: string[] = [];
  for (let i = 0; i < marginLines; i++) lines.push(blank);

  for (let y = 0; y < size; y += 2) {
    const hasBottom = y + 1 < size;
    let out = margin;
    for (let x = 0; x < size; x++) {
      const top = modules[y]![x];
      const bottom = hasBottom ? modules[y + 1]![x] : false;
      out += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(out + margin);
  }

  for (let i = 0; i < marginLines; i++) lines.push(blank);
  return lines.join('\n');
}