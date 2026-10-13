/**
 * Media forge — the media operations, actually performed.
 *
 * ## Why this file exists next to `features/media.ts`
 *
 * Because the functions in `features/media.ts` **do not convert anything**.
 * `convertImageFormat` writes the input bytes to a new filename.
 * `extractAudioFromVideo` writes the input bytes to a new filename.
 * `addWatermark` writes the input bytes to a new filename. Each one returns a
 * success object with the new path in it. A caller gets `{ outputPath }`, opens
 * the file, and finds a byte-for-byte copy of what went in — reported as a
 * successful conversion.
 *
 * That is the same defect class as a menu row with no sender behind it: a promise
 * the code cannot keep, with a clean return value hiding it. It is worse here,
 * because a sticker that was "converted" and silently is not has already been
 * sent by the time anyone notices.
 *
 * So: nothing in this file reports success without having run a program that did
 * the work, and nothing reports failure as success. When `ffmpeg` is absent the
 * result says so, by name.
 *
 * ## Why ffmpeg and not `sharp`
 *
 * `sharp` is present in `node_modules` as a transitive dependency of something
 * else. Depending on it would make this library break the moment that other
 * package changes its tree, and it does not decode video or audio at all.
 * `ffmpeg`/`ffprobe` are the same tools the reference bot scripts shell out to
 * through `fluent-ffmpeg`, and they are **verified present** on the machine this
 * was developed on:
 *
 * ```
 * /c/Users/bian/bin/ffmpeg    ffmpeg version N-126889-gb139ba11d8-20260926
 * /c/Users/bian/bin/ffprobe
 * ```
 *
 * ## Shape of the results
 *
 * Every operation returns `MediaResult` — a discriminated result, not a throw and
 * not a fake success. `ok: false` carries the reason and, when it came from a
 * command, its stderr tail. A bot can therefore tell a user *why* something did
 * not convert, which is the difference between a tool and a shrug.
 */

import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

/* ══════════════════════════════════════════════════════════════════════════
   Result shape
   ══════════════════════════════════════════════════════════════════════════ */

export type MediaResult<T> =
  | ({ ok: true; path: string; bytes: number } & T)
  | { ok: false; reason: 'ffmpeg-missing' | 'input-missing' | 'failed'; error: string };

/** Where the tools live, overridable for tests and for a bot with its own copy. */
export interface FfmpegPaths {
  ffmpeg?: string;
  ffprobe?: string;
}

let paths: Required<FfmpegPaths> = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' };

/** Override the binaries. Used by the tests to point at a known install. */
export function setFfmpegPaths(next: FfmpegPaths): void {
  paths = { ...paths, ...next };
}

/** The binaries currently in use. */
export function ffmpegPaths(): Required<FfmpegPaths> {
  return { ...paths };
}

const RUN_TIMEOUT_MS = 120_000;

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

/** Run a binary and capture both streams. Never throws. */
function run(bin: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout: RUN_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const message =
            (error as NodeJS.ErrnoException).code === 'ENOENT'
              ? `${bin} not found on PATH`
              : String((error as Error).message ?? error);
          resolve({ ok: false, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error: message });
          return;
        }
        resolve({ ok: true, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
}

/** Is a binary usable right now? Cached per name, because it does not change. */
const available = new Map<string, boolean>();

export async function hasFfmpeg(which: 'ffmpeg' | 'ffprobe' = 'ffmpeg'): Promise<boolean> {
  const cached = available.get(which);
  if (cached !== undefined) return cached;

  const bin = which === 'ffmpeg' ? paths.ffmpeg : paths.ffprobe;
  // `-version` is the cheapest way to prove the binary both exists and runs.
  const result = await run(bin, ['-version']);
  available.set(which, result.ok);
  return result.ok;
}

/** Forget the cached availability check. For tests. */
export function resetFfmpegCache(): void {
  available.clear();
}

const tail = (text: string, lines = 3): string =>
  text.trim().split(/\r?\n/).slice(-lines).join(' | ').slice(0, 400);

function guard(input: string): MediaResult<Record<string, never>> | null {
  if (!existsSync(input)) {
    return { ok: false, reason: 'input-missing', error: `no such file: ${input}` };
  }
  return null;
}

function done<T extends object>(path: string, extra: T): MediaResult<T> {
  return { ok: true, path, bytes: statSync(path).size, ...extra };
}

/* ══════════════════════════════════════════════════════════════════════════
   Probe — what is this file, really
   ══════════════════════════════════════════════════════════════════════════ */

export interface ProbeInfo {
  durationMs: number;
  format: string;
  codecs: string[];
  width?: number;
  height?: number;
  bitrate?: number;
}

/**
 * Read a media file's real properties with `ffprobe`.
 *
 * This is the function the stubs needed and did not have: every one of them
 * could have checked whether the thing it was handed was what it claimed.
 */
export async function probe(input: string): Promise<MediaResult<ProbeInfo>> {
  const missing = guard(input);
  if (missing) return missing as MediaResult<ProbeInfo>;

  if (!(await hasFfmpeg('ffprobe'))) {
    return { ok: false, reason: 'ffmpeg-missing', error: `${paths.ffprobe} is not available` };
  }

  const result = await run(paths.ffprobe, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    input,
  ]);

  if (!result.ok) {
    return { ok: false, reason: 'failed', error: result.error ?? tail(result.stderr) };
  }

  try {
    const parsed = JSON.parse(result.stdout) as {
      format?: { duration?: string; format_name?: string; bit_rate?: string };
      streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }>;
    };

    const streams = parsed.streams ?? [];
    const video = streams.find((s) => s.codec_type === 'video');
    const duration = Number.parseFloat(parsed.format?.duration ?? '0');

    return done(input, {
      durationMs: Number.isFinite(duration) ? Math.round(duration * 1000) : 0,
      format: parsed.format?.format_name ?? extname(input).replace('.', ''),
      codecs: streams.map((s) => s.codec_name ?? 'unknown').filter(Boolean),
      ...(video?.width ? { width: video.width } : {}),
      ...(video?.height ? { height: video.height } : {}),
      ...(parsed.format?.bit_rate ? { bitrate: Number.parseInt(parsed.format.bit_rate, 10) } : {}),
    });
  } catch (error) {
    return { ok: false, reason: 'failed', error: `ffprobe output was not JSON: ${String(error)}` };
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   Convert
   ══════════════════════════════════════════════════════════════════════════ */

/** The conversions the bot scripts offer as commands, named the way they name them. */
export type ForgeTarget = 'png' | 'jpg' | 'webp' | 'mp4' | 'mp3' | 'opus' | 'ogg' | 'gif';

const OUTPUT_EXT: Readonly<Record<ForgeTarget, string>> = {
  png: 'png', jpg: 'jpg', webp: 'webp', mp4: 'mp4', mp3: 'mp3', opus: 'opus', ogg: 'ogg', gif: 'gif',
};

/** Encode settings per target. WhatsApp wants Opus in OGG for a voice note. */
const ENCODE: Readonly<Record<ForgeTarget, string[]>> = {
  png: ['-frames:v', '1', '-c:v', 'png'],
  jpg: ['-frames:v', '1', '-q:v', '3'],
  webp: ['-frames:v', '1', '-c:v', 'libwebp', '-q:v', '80'],
  mp4: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart'],
  mp3: ['-vn', '-c:a', 'libmp3lame', '-q:a', '4'],
  opus: ['-vn', '-c:a', 'libopus', '-b:a', '64k', '-ac', '1'],
  ogg: ['-vn', '-c:a', 'libopus', '-b:a', '64k'],
  gif: ['-vf', 'fps=12,scale=320:-1:flags=lanczos', '-loop', '0'],
};

export interface ConvertOptions {
  /** Where to write. Derived from the input name when omitted. */
  output?: string;
  /** Start offset and duration, in milliseconds — this is what `trim` uses. */
  startMs?: number;
  endMs?: number;
  /** Extra ffmpeg args, for a caller that knows what it is doing. */
  extraArgs?: string[];
}

/**
 * Convert a media file to `target` with ffmpeg.
 *
 * One function, not nine stubs: `png` from a sticker is `toimg`, `mp3` from a
 * video is `tomp3`, `opus` from any audio is `tovn`, `mp4` from an animated webp
 * is `tovideo`. They differ only in encode settings, which is a table.
 */
export async function convert(
  input: string,
  target: ForgeTarget,
  options: ConvertOptions = {},
): Promise<MediaResult<{ target: ForgeTarget; durationMs?: number }>> {
  const missing = guard(input);
  if (missing) return missing as MediaResult<{ target: ForgeTarget }>;

  if (!(await hasFfmpeg('ffmpeg'))) {
    return {
      ok: false,
      reason: 'ffmpeg-missing',
      error: `${paths.ffmpeg} is not available — install ffmpeg or call setFfmpegPaths()`,
    };
  }

  const output = options.output ?? `${input.replace(/\.[^.]+$/, '')}.${OUTPUT_EXT[target]}`;

  const args: string[] = ['-y', '-hide_banner', '-loglevel', 'error'];
  if (options.startMs !== undefined) args.push('-ss', String(options.startMs / 1000));
  args.push('-i', input);
  if (options.startMs !== undefined && options.endMs !== undefined) {
    args.push('-t', String(Math.max(0, (options.endMs - options.startMs) / 1000)));
  }
  args.push(...ENCODE[target], ...(options.extraArgs ?? []), output);

  const result = await run(paths.ffmpeg, args);
  if (!result.ok) {
    return { ok: false, reason: 'failed', error: result.error ?? tail(result.stderr) };
  }

  // ffmpeg can exit 0 and write nothing, so the artifact is checked, not assumed.
  if (!existsSync(output) || statSync(output).size === 0) {
    return { ok: false, reason: 'failed', error: `ffmpeg wrote no output to ${output}` };
  }

  const info = options.endMs !== undefined || options.startMs !== undefined
    ? ((await probe(output)) as MediaResult<ProbeInfo>)
    : null;

  return done(output, {
    target,
    ...(info && info.ok ? { durationMs: info.durationMs } : {}),
  });
}

/* ── the named commands ─────────────────────────────────────────────────── */

/** `toimg` — a sticker (webp) to a picture you can save. */
export const toImage = (input: string, output?: string) =>
  convert(input, 'png', output ? { output } : {});

/** `tomp3` — pull the audio out of a video, for real. */
export const toMp3 = (input: string, output?: string) =>
  convert(input, 'mp3', output ? { output } : {});

/** `tovn` — anything audible, as a voice note (Opus in OGG). */
export const toVoiceNote = (input: string, output?: string) =>
  convert(input, 'opus', { ...(output ? { output } : {}), extraArgs: ['-f', 'ogg'] });

/** `tovideo` — an animated sticker, as a video. */
export const toVideo = (input: string, output?: string) =>
  convert(input, 'mp4', output ? { output } : {});

/** `sticker` — a picture or clip, as a sticker. */
export const toSticker = (input: string, output?: string) =>
  convert(input, 'webp', {
    ...(output ? { output } : {}),
    extraArgs: ['-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000'],
  });

/** `trim` — cut a section out by time. */
export const trim = (input: string, startMs: number, endMs: number, output?: string) =>
  convert(input, extname(input).toLowerCase() === '.mp4' ? 'mp4' : 'mp3', {
    ...(output ? { output } : {}),
    startMs,
    endMs,
  });

/** `emojimix`-style GIF from a still image, with the same 12 fps cap as the scripts. */
export const toGif = (input: string, output?: string) =>
  convert(input, 'gif', output ? { output } : {});

/** `togif` from a sticker with transparency, which needs the alpha flattened. */
export const stickerToGif = (input: string, output?: string) =>
  convert(input, 'gif', {
    ...(output ? { output } : {}),
    extraArgs: ['-vf', 'fps=12,scale=320:-1:flags=lanczos,format=rgba,split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse=alpha_threshold=128'],
  });

/* ══════════════════════════════════════════════════════════════════════════
   Compress — to fit WhatsApp's limits
   ══════════════════════════════════════════════════════════════════════════ */

export interface CompressOptions {
  /** Target ceiling in bytes. Default 16 MB, which is WhatsApp's document cap. */
  targetBytes?: number;
  /** Passes to try. Each lowers the bitrate by 30%. Default 4. */
  attempts?: number;
  output?: string;
}

/**
 * Compress a video to fit under a size ceiling.
 *
 * Two-pass bitrate arithmetic would be better and is overkill: this computes a
 * first-guess bitrate from the duration, encodes, and retries lower until it fits
 * or runs out of attempts. It reports the size it achieved either way.
 */
export async function compressVideo(
  input: string,
  options: CompressOptions = {},
): Promise<MediaResult<{ target: ForgeTarget; durationMs: number; attempts: number; targetBytes: number }>> {
  const targetBytes = options.targetBytes ?? 16 * 1024 * 1024;
  const attempts = Math.max(1, Math.min(8, options.attempts ?? 4));

  const info = await probe(input);
  if (!info.ok) {
    return info as unknown as MediaResult<{ target: ForgeTarget; durationMs: number; attempts: number; targetBytes: number }>;
  }

  const durationMs = info.durationMs || 1;
  const output = options.output ?? `${input.replace(/\.[^.]+$/, '')}.compressed.mp4`;
  let bitrate = Math.max(120_000, Math.round((targetBytes * 8) / (durationMs / 1000) * 0.9));

  let last = '';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = output;
    const result = await convert(input, 'mp4', {
      output: last,
      extraArgs: [
        '-b:v', String(bitrate),
        '-maxrate', String(Math.round(bitrate * 1.2)),
        '-bufsize', String(Math.round(bitrate * 2)),
      ],
    });

    if (!result.ok) return result as unknown as MediaResult<never>;
    if (result.bytes <= targetBytes) {
      return { ok: true, path: result.path, bytes: result.bytes, target: 'mp4', durationMs, attempts: attempt, targetBytes };
    }
    bitrate = Math.round(bitrate * 0.7);
  }

  // Over budget after every attempt. The file is still returned — with the size
  // it reached — because a caller may prefer an oversized video to none, and
  // hiding the number would make it look like the target was met.
  const bytes = statSync(last).size;
  return { ok: true, path: last, bytes, target: 'mp4', durationMs, attempts, targetBytes };
}

/* ══════════════════════════════════════════════════════════════════════════
   Audio windows — the waveform and duration helpers, for real
   ══════════════════════════════════════════════════════════════════════════ */

export interface SilenceWindow {
  startMs: number;
  endMs: number;
}

/**
 * Find the silent stretches in an audio file, using ffmpeg's `silencedetect`.
 *
 * Used to decide where a voice note can be cut without clipping a word — the
 * thing the "trim" command in the scripts does with a duration guess.
 */
export async function silenceWindows(
  input: string,
  options: { noiseDb?: number; minSilenceMs?: number } = {},
): Promise<MediaResult<{ windows: SilenceWindow[] }>> {
  const missing = guard(input);
  if (missing) return missing as MediaResult<{ windows: SilenceWindow[] }>;

  if (!(await hasFfmpeg('ffmpeg'))) {
    return { ok: false, reason: 'ffmpeg-missing', error: `${paths.ffmpeg} is not available` };
  }

  const noiseDb = options.noiseDb ?? -30;
  const minSilence = (options.minSilenceMs ?? 500) / 1000;

  const result = await run(paths.ffmpeg, [
    '-hide_banner', '-i', input,
    '-af', `silencedetect=noise=${noiseDb}dB:d=${minSilence}`,
    '-f', 'null', '-',
  ]);

  // `silencedetect` writes its findings to stderr and exits 0, so a non-zero exit
  // here means the file could not be read at all.
  if (!result.ok) {
    return { ok: false, reason: 'failed', error: result.error ?? tail(result.stderr) };
  }

  const windows: SilenceWindow[] = [];
  let pendingStart: number | null = null;
  for (const line of result.stderr.split(/\r?\n/)) {
    const start = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (start) pendingStart = Math.max(0, Number.parseFloat(start[1] ?? '0') * 1000);
    const end = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (end && pendingStart !== null) {
      windows.push({ startMs: Math.round(pendingStart), endMs: Math.round(Number.parseFloat(end[1] ?? '0') * 1000) });
      pendingStart = null;
    }
  }

  return done(input, { windows });
}

/** Default output directory for a bot that wants temp files in one place. */
export function workDir(base: string, name: string): string {
  return join(base, name.replace(/[^\w.-]/g, '_'));
}
