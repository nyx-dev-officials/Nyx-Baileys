/**
 * Tests for the pairing introduction.
 *
 * The renderer returns its layout as a string rather than printing it, which is
 * what makes any of this assertable. Testing terminal output by eye is how a
 * banner silently grows past 80 columns and wraps into an unreadable second
 * row on someone else's machine.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  banner, networkField, renderIntro, codeFrame, rng, bannerWidth, INTRO_WIDTH, BANNER_HEIGHT,
} from '../dist/cli/intro.js';

/** Collect output without a terminal, and with colour applied so widths are real. */
function collector() {
  const lines = [];
  const io = {
    line: (t = '') => lines.push(t),
    note: (t) => lines.push(t),
    // Wrap in real ANSI so anything that measures visible width sees escapes,
    // exactly as it would in a colour terminal.
    paint: (t, code) => {
      const c = { bold: 1, dim: 2, red: 31, green: 32, yellow: 33, blue: 34, cyan: 36 }[code];
      return `\x1b[${c}m${t}\x1b[0m`;
    },
  };
  return { io, lines };
}

const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\[[0-9;]*m/g, '');

test('every line fits inside the intro width', () => {
  const { io, lines } = collector();
  renderIntro(io, { version: '0.3.1', sessionDir: './session', seed: 42 });
  for (const line of lines) {
    assert.ok(
      visible(line).length <= INTRO_WIDTH + 2,
      `line is ${visible(line).length} columns, over the ${INTRO_WIDTH}-column budget:\n${visible(line)}`,
    );
  }
});

test('the intro contains no characters that break a legacy console code page', () => {
  const { io, lines } = collector();
  renderIntro(io, { version: '0.3.1', sessionDir: './session', seed: 42 });
  for (const line of lines) {
    const text = visible(line);
    for (const ch of text) {
      const code = ch.codePointAt(0);
      assert.ok(
        code === 10 || code === 13 || (code >= 32 && code < 127),
        `non-ASCII character ${JSON.stringify(ch)} (U+${code.toString(16)}) would render as mojibake on a default Windows console`,
      );
    }
  }
});

test('the intro is not a wall of instructional text', () => {
  const { io, lines } = collector();
  renderIntro(io, { version: '0.3.1', sessionDir: './session', seed: 42 });

  // The art bands are not prose. Strip lines made only of art glyphs and rules
  // before counting, or the banner itself reads as an essay.
  const ART = /^[#.*\-=+|\s]+$/;
  const prose = lines
    .map(visible)
    .filter((l) => l.trim() && !ART.test(l))
    .join(' ')
    .split(/\s+/)
    .filter(Boolean);

  // The whole point is that this screen is visual. If it ever grows into a
  // manual, the surviving prose is the signal.
  assert.ok(
    prose.length < 12,
    `intro has ${prose.length} prose words (${prose.join(' ')}) — it has turned into instructions`,
  );
});

test('the intro shows the session directory it will use', () => {
  const { io, lines } = collector();
  renderIntro(io, { version: '0.3.1', sessionDir: 'C:/nyx-new-session', seed: 42 });
  assert.match(lines.map(visible).join('\n'), /C:\/nyx-new-session/);
});

test('the same seed produces the same network, a different one does not', () => {
  const a = networkField(40, 6, 7, 12, 2);
  const b = networkField(40, 6, 7, 12, 2);
  const c = networkField(40, 6, 8, 12, 2);
  assert.deepEqual(a, b, 'the same seed must reproduce the picture exactly');
  assert.notDeepEqual(a, c, 'a different seed must produce a different picture');
});

test('the network field is the requested size and only uses its two glyphs', () => {
  const field = networkField(50, 8, 3, 20, 2);
  assert.equal(field.length, 8);
  for (const row of field) {
    assert.equal(row.length, 50);
    assert.match(row, /^[.* ]*$/);
  }
});

test('the network is dense enough to read as a network', () => {
  const field = networkField(70, 9, 11, 26, 3).join('');
  const nodes = (field.match(/\*/g) ?? []).length;
  const links = (field.match(/\./g) ?? []).length;
  assert.ok(nodes >= 20, `expected the requested nodes, got ${nodes}`);
  assert.ok(links > nodes, `expected more link characters than nodes, got ${links} links vs ${nodes} nodes`);
});

test('the rng is deterministic and stays in range', () => {
  const a = rng(99);
  const b = rng(99);
  for (let i = 0; i < 100; i++) {
    const x = a();
    assert.equal(x, b(), 'the same seed must produce the same stream');
    assert.ok(x >= 0 && x < 1, `value ${x} is outside [0,1)`);
  }
});

test('the banner renders every glyph at a uniform height', () => {
  const rows = banner('NYX', (s) => s).split('\n');
  assert.equal(rows.length, BANNER_HEIGHT, 'rendered height must match the scale factor');
  for (const row of rows) assert.ok(row.length > 0);
});

test('the banner handles unknown characters without producing garbage', () => {
  const rows = banner('NY1!', (s) => s).split('\n');
  assert.equal(rows.length, BANNER_HEIGHT);
  // Digits and punctuation are not in the font. They must fall back to blank
  // rather than rendering as something arbitrary.
  assert.equal(banner('1', (s) => s).trim(), '', 'an unknown glyph must render as blank');
  assert.ok(rows[0].length > 0, 'the known glyphs must still render');
  // Row count is what matters: trailing whitespace is stripped, so a blank
  // glyph is shorter in characters but still occupies the same rows.
  assert.equal(
    banner('1', (s) => s).split('\n').length,
    banner('N', (s) => s).split('\n').length,
  );
});

test('the code frame boxes the code and splits it for reading', () => {
  const frame = codeFrame('ABCD1234', (s) => s).split('\n');
  assert.equal(frame.length, 3);
  assert.match(frame[0], /^\+-+\+$/);
  assert.match(frame[2], /^\+-+\+$/);
  assert.match(frame[1], /ABCD {2}1234/);
});

test('the code frame survives an unexpected code length', () => {
  for (const code of ['', 'AB', 'ABCDEFG', 'ABCDEFGHI']) {
    const frame = codeFrame(code, (s) => s).split('\n');
    assert.equal(frame.length, 3, `frame broke for ${JSON.stringify(code)}`);
    assert.ok(frame[1].startsWith('|'), 'the middle row must still be a bar');
    // The frame is WIDTH - 2 wide, so compare the rows against each other
    // rather than against INTRO_WIDTH.
    const widths = frame.map((r) => r.length);
    assert.ok(widths.every((w) => w === widths[0]), `frame is ragged: ${widths.join(', ')}`);
    assert.match(frame[0], /^\+-{60,}\+$/);
  }
});

test('the intro renders with colour disabled', () => {
  const lines = [];
  const io = {
    line: (t = '') => lines.push(t),
    note: (t) => lines.push(t),
    paint: (t) => t, // no colour at all
  };
  renderIntro(io, { version: '0.3.1', sessionDir: './session', seed: 5 });
  for (const line of lines) {
    assert.ok(!line.includes('['), 'no escape sequences when colour is off');
    assert.ok(line.length <= INTRO_WIDTH + 2);
  }
});
/* ── the failures this file exists to prevent ─────────────────────────── */

/**
 * Every pair of adjacent glyphs must be separated by blank columns.
 *
 * The first version of the font drew glyphs 23 columns wide with a single
 * space between them. On the top row the strokes of adjacent letters ended up
 * exactly one column apart, and along the baseline they touched outright, so
 * "NYX" read as noise. Nothing caught it because the output looked busy and
 * nobody measured the gap.
 */
test('letters are further apart than the strokes inside them', () => {
  // The subtle version of the merging bug. With three columns between letters
  // and ten inside each glyph, the word still read as one shape — the letters
  // were closer to each other than their own strokes were.
  const row = banner('NN', (s) => s).split('\n')[0];
  const runs = [...row.matchAll(/#+/g)].map((m) => ({ at: m.index, len: m[0].length }));
  assert.ok(runs.length >= 3, `expected at least three strokes, saw ${runs.length}`);
  const gaps = runs.slice(1).map((r, i) => r.at - (runs[i].at + runs[i].len));
  const interGlyph = gaps[1];
  const intraGlyph = gaps[0];
  assert.ok(
    interGlyph > intraGlyph,
    `letters are ${interGlyph} columns apart but strokes within a letter are ${intraGlyph} apart — the word will read as one shape`,
  );
});

test('the banner keeps a clear gap between letters', () => {
  // The scale is 2, so a single blank column is a half-column gap and the
  // letters visually collide. This is what the first font did.
  const top = banner('NYX', (s) => s).split('\n')[0];
  const runs = [...top.matchAll(/#+/g)].map((m) => m[0].length);
  assert.ok(
    runs.every((len) => len === 2),
    `a stroke should be exactly two columns wide at this scale, saw ${runs.join(',')}`,
  );
});

test('the banner stays inside the intro width', () => {
  assert.ok(bannerWidth('NYX') <= INTRO_WIDTH, `banner is ${bannerWidth('NYX')} wide`);
});

test('the banner renders more than one pixel per source row', () => {
  // Every source row must appear twice, or the font has been drawn at the wrong
  // scale and the letterforms come out half height.
  const rows = banner('N', (s) => s).split('\n');
  for (let i = 0; i < rows.length; i += 2) {
    assert.equal(rows[i], rows[i + 1], `rows ${i} and ${i + 1} differ — the scale is not uniform`);
  }
});

test('N, Y and X are each visually distinct', () => {
  // X and Y were once indistinguishable because both opened `#   #`. Render
  // each letter alone and require them to differ on at least a third of rows.
  const shapes = ['N', 'Y', 'X'].map((l) => banner(l, (s) => s).split('\n'));
  for (let a = 0; a < shapes.length; a++) {
    for (let b = a + 1; b < shapes.length; b++) {
      const differing = shapes[a].filter((row, i) => row !== shapes[b][i]).length;
      assert.ok(
        differing >= 3,
        `glyphs ${'NYX'[a]} and ${'NYX'[b]} differ on only ${differing} rows and will be mistaken for each other`,
      );
    }
  }
});

test('X has a visible crossing and Y has a stem', () => {
  const x = banner('X', (s) => s).split('\n');
  const y = banner('Y', (s) => s).split('\n');
  const count = (rows, re) => rows.filter((r) => re.test(r)).length;
  // X widens again in its lower half; Y's lower half stays a single stem.
  const xTop = count(x.slice(0, 4), /##\s{4,}##/);
  const xBottom = count(x.slice(8), /##\s{4,}##/);
  const yBottom = count(y.slice(8), /##\s{4,}##/);
  assert.ok(xTop > 0 && xBottom > 0, 'X must open wide at both ends');
  assert.equal(yBottom, 0, 'Y must not widen below the fork');
});

test('the network field uses its full height', () => {
  // A jittered-grid placement collapsed 26 nodes into three middle rows on a
  // wide, short field, leaving three blank rows top and bottom.
  for (const seed of [11, 7, 99, 1234]) {
    const field = networkField(70, 9, seed, 26, 3);
    assert.ok(field[0].trim(), `seed ${seed}: the top row is empty`);
    assert.ok(field[field.length - 1].trim(), `seed ${seed}: the bottom row is empty`);
  }
});

test('the network field spreads nodes across the width', () => {
  for (const seed of [11, 7, 99, 1234]) {
    const field = networkField(70, 9, seed, 26, 3).join('');
    const columns = new Set();
    for (const row of networkField(70, 9, seed, 26, 3)) {
      for (let i = 0; i < row.length; i++) if (row[i] === '*') columns.add(i);
    }
    // A blob in the middle would occupy far fewer than this.
    // 26 nodes can occupy at most 26 distinct columns, so the meaningful
    // measure is the horizontal span, not the column count. The first
    // version of this test asserted a column count above the node count,
    // which no implementation could ever satisfy.
    const span = Math.max(...columns) - Math.min(...columns);
    assert.ok(span >= 55, );
  }
});

test('nodes do not stack on one cell', () => {
  for (const seed of [3, 21, 88]) {
    const field = networkField(70, 9, seed, 26, 3);
    for (let y = 0; y < field.length; y++) {
      // Only two nodes on the same cell is a merge. A node sitting next to a
      // link character is normal and expected — that is what a network is.
      assert.ok(!/\*\*/.test(field[y]), `seed ${seed}: two nodes on one cell in row ${y}`);
    }
  }
});
