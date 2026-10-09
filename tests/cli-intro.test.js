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

import { banner, networkField, renderIntro, codeFrame, rng, INTRO_WIDTH } from '../dist/cli/intro.js';

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
  assert.equal(rows.length, 7, 'the display font is seven rows tall');
  for (const row of rows) assert.ok(row.length > 0);
});

test('the banner handles unknown characters without producing garbage', () => {
  const rows = banner('NY1!', (s) => s).split('\n');
  assert.equal(rows.length, 7);
  assert.ok(rows[0].length > 0);
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