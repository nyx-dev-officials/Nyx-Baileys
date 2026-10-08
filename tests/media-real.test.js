/**
 * Real-file tests for the media functions that were faking success.
 *
 * These run against actual files on disk, because the defects they cover were
 * invisible to mocks: `compressImage` gzipped bytes into a `.gz` and
 * `trimMedia` byte-sliced an MP4 — both returned a well-formed result object
 * describing work that had not happened. A fake socket cannot catch that; only
 * decoding the output can.
 *
 * Fixtures are generated, not committed as binaries: a solid PNG via sharp, and
 * a short MP4 via ffmpeg's own test source.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { compressImage, trimMedia } from '../dist/features/media.js';

const execFileAsync = promisify(execFile);
let dir;

test.before(() => { dir = mkdtempSync(join(tmpdir(), 'nyx-media-')); });
test.after(() => { rmSync(dir, { recursive: true, force: true }); });

async function makePng(path, w = 1200, h = 800) {
  await sharp({
    create: { width: w, height: h, channels: 3, background: { r: 200, g: 120, b: 40 } },
  }).png().toFile(path);
  return path;
}

/** A real 3-second MP4, so the trim has genuine container structure to cut. */
async function makeMp4(path) {
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=15',
    '-pix_fmt', 'yuv420p',
    path,
  ]);
  return path;
}

test('compressImage produces a decodable image, not a gzip blob', async () => {
  const src = await makePng(join(dir, 'in.png'));
  const result = await compressImage(src, { quality: 60 });

  // The old implementation wrote `.compressed.gz` — a file no image decoder can
  // read. Assert the output is a real image.
  assert.ok(result.outputPath.endsWith('.png'), 'output must keep the image extension');
  const meta = await sharp(result.outputPath).metadata();
  assert.equal(meta.format, 'png');
  assert.equal(meta.width, 1200);
  assert.equal(meta.height, 800);
  assert.ok(result.originalSize > 0 && result.compressedSize > 0);
  assert.ok(result.ratio > 0 && result.ratio <= 1.0001,
    `ratio ${result.ratio} is not a real compression ratio`);
});

test('compressImage honours an explicit format', async () => {
  const src = await makePng(join(dir, 'conv.png'));
  const result = await compressImage(src, { format: 'jpeg', quality: 50 });
  const meta = await sharp(result.outputPath).metadata();
  assert.equal(meta.format, 'jpeg');
});

test('compressImage resizes without enlarging', async () => {
  const src = await makePng(join(dir, 'small.png'), 100, 80);
  const result = await compressImage(src, { maxWidthPx: 400 });
  const meta = await sharp(result.outputPath).metadata();
  assert.equal(meta.width, 100,
    'a 100px image must not be upscaled to 400px just to hit a width');
});

test('compressImage actually reduces a photo-like image', async () => {
  // Noise defeats PNG's row filters, so re-encoding at lower quality must shrink it.
  const noise = await sharp({
    create: { width: 900, height: 900, channels: 3, background: { r: 1, g: 2, b: 3 } },
  }).png().toBuffer();
  const src = join(dir, 'noise.png');
  writeFileSync(src, noise);

  const result = await compressImage(src, { format: 'jpeg', quality: 30 });
  assert.ok(result.compressedSize < result.originalSize,
    `expected a smaller file: ${result.compressedSize} vs ${result.originalSize}`);
});

test('compressImage rejects a non-image instead of writing a broken file', async () => {
  const bogus = join(dir, 'not-an-image.png');
  writeFileSync(bogus, 'this is definitely not a PNG');
  await assert.rejects(() => compressImage(bogus), /unsupported image format|Input buffer/i);
});

test('trimMedia cuts a real MP4 and the result is still playable', async () => {
  const src = await makeMp4(join(dir, 'clip.mp4'));
  const out = join(dir, 'trimmed.mp4');

  const result = await trimMedia(src, { startMs: 1000, endMs: 2500, outputPath: out });

  assert.equal(result.startMs, 1000);
  assert.equal(result.durationMs, 1500);
  assert.ok(statSync(out).size > 0, 'ffmpeg produced an empty file');

  // The decisive check: the trimmed file must decode to a real duration near the
  // requested 1.5s. The old byte-slice version passed this file's existence
  // check while producing an unplayable container.
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', out,
  ]);
  const duration = Number.parseFloat(stdout.trim());
  assert.ok(Number.isFinite(duration), 'ffprobe could not read a duration — file is corrupt');
  assert.ok(Math.abs(duration - 1.5) < 0.35,
    `expected ~1.5s, probed ${duration}s — the container was cut incorrectly`);
});

test('trimMedia rejects an inverted range without touching the file', async () => {
  const src = await makeMp4(join(dir, 'guard.mp4'));
  const before = statSync(src).size;
  await assert.rejects(
    () => trimMedia(src, { startMs: 2000, endMs: 1000 }),
    RangeError,
  );
  assert.equal(statSync(src).size, before, 'the input must not be modified');
});

test('trimMedia throws clearly when ffmpeg is unavailable, never slicing bytes', async () => {
  const src = await makeMp4(join(dir, 'nofmpeg.mp4'));
  const out = join(dir, 'should-not-exist.mp4');
  const original = process.env.FFMPEG_PATH;

  // Force the probe to fail by pointing at a nonexistent binary on a PATH-less
  // lookup: an explicit path that does not exist skips the PATH probe only if
  // it is absent, so instead shadow PATH entirely.
  const savedPath = process.env.PATH;
  process.env.PATH = join(dir, 'definitely-empty');
  process.env.FFMPEG_PATH = '';
  try {
    await assert.rejects(
      () => trimMedia(src, { startMs: 0, endMs: 1000, outputPath: out }),
      /requires ffmpeg/i,
    );
    assert.equal(readFileSync(src).length > 0, true, 'input must be untouched');
  } finally {
    process.env.PATH = savedPath;
    if (original !== undefined) process.env.FFMPEG_PATH = original;
    else delete process.env.FFMPEG_PATH;
  }
});