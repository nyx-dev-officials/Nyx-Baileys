/**
 * Terminal QR rendering.
 *
 * The encoder tests in `tests/module-d-assist.test.js` prove the module matrix
 * is correct. They never proved the *rendered* symbol survives the trip through
 * half-block characters — and it did not: `renderQrCompact` dropped the last
 * module row on every symbol (QR sizes are `17 + 4 * version`, always odd) and
 * under-width the blank quiet-zone rows. Both are invisible to an encoder test
 * and fatal to a camera.
 *
 * So these tests parse the rendered text back into a module matrix and decode
 * it. If a QR cannot be read back out of the terminal, it will not scan.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { encodeQr, renderQrCompact } from '../dist/toolkit/qr.js';
import { qrFitsViewport, qrFrameSize } from '../dist/cli/qr-display.js';

/** Half-block characters back into per-cell [top, bottom] module pairs. */
function parse(rendered) {
  const rows = rendered.split('\n').map((line) => {
    const cells = [];
    for (const ch of line) {
      if (ch === '\u2580') cells.push([1, 0]);
      else if (ch === '\u2584') cells.push([0, 1]);
      else if (ch === '\u2588') cells.push([1, 1]);
      else cells.push([0, 0]);
    }
    return cells;
  });
  const width = Math.max(...rows.map((r) => r.length));
  for (const r of rows) while (r.length < width) r.push([0, 0]);
  return { rows, width, height: rows.length * 2 };
}

/** Upscale to a bitmap with a quiet zone, which is what a camera sees. */
function bitmap({ rows, width, height }, scale = 4, quiet = 4) {
  const w = width * scale + quiet * 2 * scale;
  const h = height * scale + quiet * 2 * scale;
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rows[Math.floor(y / 2)][x][y % 2] !== 1) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = (((y + quiet) * scale + dy) * w + (x + quiet) * scale + dx) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  return { data, w, h };
}

const PAYLOADS = [
  '2@abcDEF123+/xyzQRSTUV==,mnop456PQRST789UVWX0YZ0123456789abcdefghij',
  '2@short',
  `2@${'A'.repeat(200)}`,
  `2${'B'.repeat(180)}`,
  `2${'C'.repeat(205)}`,
];

test('the rendered symbol decodes back to the exact payload', async (t) => {
  // jsQR is a devDependency used only for this proof.
  let jsQR;
  try {
    ({ default: jsQR } = await import('jsqr'));
  } catch {
    t.skip('jsqr not installed');
    return;
  }

  for (const payload of PAYLOADS) {
    const { size } = encodeQr(payload);
    const rendered = renderQrCompact(encodeQr(payload), 4);
    const image = bitmap(parse(rendered));
    const decoded = jsQR(image.data, image.w, image.h);
    assert.equal(
      decoded?.data,
      payload,
      `version for ${size}x${size} did not survive rendering`,
    );
  }
});

test('every module of the symbol survives rendering, in place', () => {
  // The specific regression: an odd size used to lose its final module row, and
  // an encoder-only test cannot see it. Compare the parsed render against the
  // encoder's own matrix so a dropped or shifted row fails loudly.
  const quiet = 4;
  const marginLines = Math.ceil(quiet / 2);
  for (const payload of PAYLOADS) {
    const { modules, size } = encodeQr(payload);
    const parsed = parse(renderQrCompact(encodeQr(payload), quiet));

    assert.equal(
      parsed.height,
      2 * (marginLines * 2 + Math.ceil(size / 2)),
      `size ${size}: wrong module row count`,
    );
    assert.equal(parsed.width, size + quiet * 2, `size ${size}: wrong frame width`);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        assert.equal(
          parsed.rows[marginLines + Math.floor(y / 2)][quiet + x][y % 2],
          modules[y][x] ? 1 : 0,
          `module (${x},${y}) of a ${size}x${size} symbol was altered`,
        );
      }
    }
  }
});

test('the quiet-zone rows are the same width as the data rows', () => {
  for (const payload of PAYLOADS) {
    const rows = renderQrCompact(encodeQr(payload), 4).split('\n');
    const widths = new Set(rows.map((r) => [...r].length));
    assert.equal(widths.size, 1, `ragged frame widths: ${[...widths].join(',')}`);
  }
});

test('a real WhatsApp pairing ref fits and decodes', async (t) => {
  // The regression that made the QR branch look like a hang: a live ref is 277
  // bytes, level M tops out at 213, `encodeQr` threw, and the caller caught it
  // and printed one line. The QR path must render the payload WhatsApp actually
  // sends, at the length it actually sends it.
  let jsQR;
  try {
    ({ default: jsQR } = await import('jsqr'));
  } catch {
    t.skip('jsqr not installed');
    return;
  }

  const ref = `2@${'A'.repeat(275)}`;
  assert.equal(new TextEncoder().encode(ref).length, 277);

  assert.throws(
    () => encodeQr(ref),
    /handles up to 213/,
    'level M should still refuse a 277-byte payload',
  );

  const { size } = encodeQr(ref, 'L');
  assert.equal((size - 17) / 4, 11, 'a 277-byte ref should select version 11 at level L');

  const image = bitmap(parse(renderQrCompact(encodeQr(ref, 'L'), 4)));
  assert.equal(jsQR(image.data, image.w, image.h)?.data, ref, 'the rendered ref did not decode');
});

test('every level-L version decodes back to its input', async (t) => {
  // The L table was written from the spec, and a wrong block-split table yields
  // a symbol that looks perfect and decodes to garbage. Prove each row.
  let jsQR;
  try {
    ({ default: jsQR } = await import('jsqr'));
  } catch {
    t.skip('jsqr not installed');
    return;
  }

  for (const len of [17, 32, 53, 78, 106, 134, 154, 192, 230, 271, 321]) {
    const payload = `2@${'L'.repeat(len - 2)}`;
    assert.equal(new TextEncoder().encode(payload).length, len);
    const image = bitmap(parse(renderQrCompact(encodeQr(payload, 'L'), 4)));
    assert.equal(
      jsQR(image.data, image.w, image.h)?.data,
      payload,
      `level L capacity row ${len} produced a symbol that does not decode`,
    );
  }
});

test('an over-capacity payload throws rather than truncating', () => {
  // Truncating would yield a scannable QR that decodes to something other than
  // what WhatsApp sent — a silent failure at the worst possible moment.
  assert.throws(() => encodeQr(`2@${'x'.repeat(400)}`, 'L'), /handles up to 321/);
});

test('a pairing QR reports whether the terminal viewport can show it whole', () => {
  const ref = `2@${'A'.repeat(275)}`;
  const frame = qrFrameSize(ref);
  assert.deepEqual(frame, { rows: 37, columns: 71 });
  assert.equal(qrFitsViewport(frame, { rows: 60, columns: 80, headerHeight: 15 }), true);
  assert.equal(qrFitsViewport(frame, { rows: 30, columns: 80, headerHeight: 15 }), false);
  assert.equal(qrFitsViewport(frame, { rows: 80, columns: 70, headerHeight: 10 }), false);
  assert.equal(qrFrameSize(''), null);
});
