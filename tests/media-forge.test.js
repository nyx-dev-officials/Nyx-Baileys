/**
 * Media forge — the conversions, checked by converting real media.
 *
 * This suite does not stub ffmpeg. It **generates** a video and an audio file
 * with ffmpeg, converts them through the functions a bot would call, and then
 * asks `ffprobe` what the output actually is. That is the only way to catch the
 * defect this module exists to fix: `features/media.ts` reports a successful
 * conversion while writing a byte-for-byte copy of its input, and a test that
 * only checks "the file exists" cannot see the difference.
 *
 * Both halves matter, so the suite also asserts the honest failures: a missing
 * input and a missing binary each produce `ok: false` with the reason, rather
 * than a throw or a fake success.
 *
 * `ffmpeg` must be on PATH. When it is not, the conversion tests skip with a
 * message rather than passing — a skipped test that reports success is the
 * failure mode this repository has already been bitten by.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  compressVideo,
  convert,
  ffmpegPaths,
  hasFfmpeg,
  probe,
  resetFfmpegCache,
  setFfmpegPaths,
  silenceWindows,
  toImage,
  toMp3,
  toSticker,
  toVoiceNote,
} from '../dist/toolkit/index.js';

let dir = '';
let ffmpegAvailable = false;

const PIXEL = 'color=c=blue:s=320x240:d=1';

function ffmpeg(args) {
  return execFileSync(ffmpegPaths().ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...args], {
    encoding: 'buffer',
  });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nyx-forge-'));
  ffmpegAvailable = await hasFfmpeg('ffmpeg');
  if (!ffmpegAvailable) return;

  // A one-second video **with an audio track**, and a one-second tone on its own.
  //
  // Two things here are deliberate. The video carries audio because the first
  // version of this fixture did not, and `toMp3` failed on it — correctly, since
  // there is no audio to extract. The test then reported the *conversion* as
  // broken. A fixture that cannot exercise the function proves nothing.
  //
  // And the codecs are named explicitly, so the "is this really a video"
  // assertion does not depend on a build's default codec choice.
  ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    join(dir, 'clip.mp4'),
  ]);
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', join(dir, 'tone.mp3')]);
});

function cleanup() {
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
test.after?.(cleanup);

/* ══════════════════════════════════════════════════════════════════════════
   Honest failure first
   ══════════════════════════════════════════════════════════════════════════ */

test('a missing input is reported as missing, not as a conversion', async () => {
  const result = await probe(join(dir, 'nope-not-here.mp4'));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'input-missing');
  assert.match(result.error, /no such file/);
});

test('a missing ffmpeg is reported by name', async () => {
  const real = ffmpegPaths();
  const input = join(dir, 'tone.mp3');
  if (!existsSync(input)) writeFileSync(input, 'not really audio');

  setFfmpegPaths({ ffmpeg: 'ffmpeg-that-does-not-exist' });
  resetFfmpegCache();
  try {
    const result = await convert(input, 'opus');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'ffmpeg-missing');
    assert.match(result.error, /ffmpeg-that-does-not-exist/);
  } finally {
    setFfmpegPaths(real);
    resetFfmpegCache();
  }
});

/* ══════════════════════════════════════════════════════════════════════════
   The conversions
   ══════════════════════════════════════════════════════════════════════════ */

test('probe reports the real duration and codecs', async (t) => {
  if (!ffmpegAvailable) return t.skip('ffmpeg is not on PATH');

  const result = await probe(join(dir, 'clip.mp4'));
  assert.equal(result.ok, true);
  assert.ok(result.durationMs >= 900 && result.durationMs <= 1100, `duration was ${result.durationMs}ms`);
  assert.ok(result.codecs.includes('h264'), `codecs were ${JSON.stringify(result.codecs)}`);
  assert.equal(result.width, 320);
  assert.equal(result.height, 240);
  assert.ok(result.bytes > 0);
});

test('video to mp3 produces audio, not a copy of the video', async (t) => {
  if (!ffmpegAvailable) return t.skip('ffmpeg is not on PATH');

  const input = join(dir, 'clip.mp4');
  const result = await toMp3(input, join(dir, 'out.mp3'));
  assert.equal(result.ok, true);

  // The load-bearing assertion: ffprobe says the output is audio, while the input
  // is video. A byte-copy stub passes "the file exists" and fails this.
  const source = await probe(input);
  assert.equal(source.ok, true);
  assert.equal(source.codecs.includes('h264'), true, 'the fixture has no video stream');
  assert.equal(source.codecs.includes('aac'), true, 'the fixture has no audio stream to extract');

  const info = await probe(result.path);
  assert.equal(info.ok, true);
  assert.match(info.format, /mp3/);
  assert.ok(info.codecs.includes('mp3'), `codecs were ${JSON.stringify(info.codecs)}`);
  assert.ok(info.codecs.includes('h264') === false, 'the video stream survived into the mp3');
  assert.equal(result.bytes, statSync(result.path).size);
});

test('audio to a voice note is Opus in OGG, which WhatsApp plays as a mic note', async (t) => {
  if (!ffmpegAvailable) return t.skip('ffmpeg is not on PATH');

  const result = await toVoiceNote(join(dir, 'tone.mp3'), join(dir, 'voice.ogg'));
  assert.equal(result.ok, true);

  const info = await probe(result.path);
  assert.equal(info.ok, true);
  assert.ok(info.codecs.includes('opus'), `codecs were ${JSON.stringify(info.codecs)}`);
});

test('a picture becomes a sticker and the sticker becomes a picture again', async (t) => {
  if (!ffmpegAvailable) return t.skip('ffmpeg is not on PATH');

  const png = join(dir, 'still.png');
  ffmpeg(['-f', 'lavfi', '-i', PIXEL, '-frames:v', '1', png]);

  const sticker = await toSticker(png, join(dir, 'still.webp'));
  assert.equal(sticker.ok, true);
  assert.match(sticker.path, /still\.webp$/);

  const back = await toImage(sticker.path, join(dir, 'again.png'));
  assert.equal(back.ok, true);

  const info = await probe(back.path);
  assert.equal(info.ok, true);
  assert.match(info.format, /png/);
});

test('compressing a video reports the size it reached', async (t) => {
  if (!ffmpegAvailable) return t.skip('ffmpeg is not on PATH');

  const result = await compressVideo(join(dir, 'clip.mp4'), {
    targetBytes: 40_000,
    attempts: 3,
    output: join(dir, 'small.mp4'),
  });

  assert.equal(result.ok, true);
  assert.ok(result.attempts >= 1 && result.attempts <= 3);
  assert.equal(result.targetBytes, 40_000);
  // Either it fit, or the report says how big it really is. Both are honest; a
  // silent overshoot is not.
  assert.ok(result.bytes <= 40_000 || result.bytes === statSync(result.path).size);
});

test('silence detection finds the quiet stretch in a file that has one', async (t) => {
  if (!ffmpegAvailable) return t.skip('ffmpeg is not on PATH');

  const gapped = join(dir, 'gap.mp3');
  // Tone, silence, tone.
  ffmpeg([
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.3',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=0.5',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.3',
    '-filter_complex', '[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]',
    '-map', '[out]', gapped,
  ]);

  const result = await silenceWindows(gapped, { noiseDb: -40, minSilenceMs: 300 });
  assert.equal(result.ok, true);
  assert.ok(
    result.windows.length >= 1,
    `expected at least one silent window, got ${JSON.stringify(result.windows)}`,
  );
  const window = result.windows[0];
  assert.ok(window.endMs > window.startMs, 'a window must have a positive length');
});
