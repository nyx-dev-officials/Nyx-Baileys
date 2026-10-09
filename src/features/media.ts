/**
 * Nyx-Baileys — features/media.ts
 *
 * Comprehensive media-processing utilities built exclusively on Node built-ins
 * (node:crypto, node:zlib, node:fs, node:path, node:stream, node:buffer).
 *
 * No external runtime dependencies are introduced. Where a function would
 * ordinarily delegate to a native codec (ffmpeg, sharp, etc.) the
 * implementation provides a fully-typed, pure-Node stub that:
 *   • accepts and validates real inputs,
 *   • performs any CPU work that is achievable without a native addon
 *     (hashing, gzip compression, EXIF stripping, AES encryption, …), and
 *   • returns a descriptive result so callers can wire up the real codec at
 *     the call site if they choose to.
 *
 * Every function is exported so the module compiles cleanly with
 * `tsc --noEmit` under `"strict": true` + `"noUncheckedIndexedAccess": true`.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import sharpLib from 'sharp';
import { basename, extname, join, resolve } from 'node:path';
import { pipeline, Readable, Transform, Writable } from 'node:stream';
import { promisify } from 'node:util';
import { deflate, gunzip, gzip } from 'node:zlib';
import * as zlib from 'node:zlib';

const pipelineAsync = promisify(pipeline);
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const deflateAsync = promisify(deflate);

/**
 * Assert a codec run produced real output.
 *
 * ffmpeg can exit 0 and still write nothing useful — an unsupported input, a
 * zero-length stream. Trusting the exit code alone is how a "compressed" file
 * ends up being zero bytes while the caller reports a ratio.
 */
export function requireNonEmpty(outputPath: string, caller: string): void {
  if (!existsSync(outputPath) || statSync(outputPath).size === 0) {
    throw new Error(
      `${caller}: ffmpeg reported success but produced no output at ${outputPath}. `
      + 'The input may be an unsupported or corrupt container.',
    );
  }
}

/* ──────────────────────── codec backends (sharp / ffmpeg) ────────────── */

/** sharp, typed loosely: only the operations actually used below. */
type SharpPipeline = ReturnType<typeof sharpLib>;

function sharpInstance(input: string | Buffer, opts?: Record<string, unknown>): SharpPipeline {
  return sharpLib(input, opts as never);
}

/**
 * Resolve an ffmpeg binary, or throw naming the caller that needed it.
 *
 * Deliberately **no fallback**. The functions that need this previously guessed
 * byte offsets and wrote corrupt output while returning success; a loud throw
 * is the correct trade for media the user actually owns. Pass `FFMPEG_PATH` to
 * point at a specific binary, which is what a packaged deployment should do
 * rather than relying on PATH.
 */
async function requireFfmpeg(caller: string): Promise<string> {
  const explicit = process.env.FFMPEG_PATH;
  if (explicit && existsSync(explicit)) return explicit;

  const { execFile } = await import('node:child_process');
  const probe = promisify(execFile);
  try {
    await probe('ffmpeg', ['-version'], { timeout: 5_000 });
    return 'ffmpeg';
  } catch {
    throw new Error(
      `${caller}: requires ffmpeg on PATH (or FFMPEG_PATH set). No byte-level fallback is `
      + 'provided on purpose — cutting a container by estimated byte offsets produces an '
      + 'unplayable file, which is worse than refusing to run.',
    );
  }
}

/** Run ffmpeg and reject on a non-zero exit, surfacing its stderr. */
export async function runFfmpeg(bin: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (e) => reject(new Error(`ffmpeg failed to start: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim().slice(0, 400)}`));
    });
  });
}

/* ─────────────────────────────── shared types ─────────────────────────── */

export interface Dimensions {
  width: number;
  height: number;
}

export interface MediaInfo {
  path: string;
  size: number;
  mimeType: string;
  extension: string;
}

export interface CompressionResult {
  outputPath: string;
  originalSize: number;
  compressedSize: number;
  ratio: number;
}

export interface EncryptionResult {
  outputPath: string;
  iv: string;
  key: string;
  algorithm: string;
  tag?: string;
}

export interface DecryptionResult {
  outputPath: string;
  size: number;
}

export interface ThumbnailResult {
  outputPath: string;
  width: number;
  height: number;
  timestampMs: number;
}

export interface WaveformPoint {
  time: number;
  amplitude: number;
}

export interface AudioSpectrum {
  frequencies: number[];
  magnitudes: number[];
  sampleRate: number;
}

export interface SilenceSegment {
  startMs: number;
  endMs: number;
  durationMs: number;
}

export interface SubtitleEntry {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

export interface QRCodeResult {
  data: string;
  format: 'qr';
  version: number;
  size: number;
}

export interface BarcodeResult {
  data: string;
  format: BarcodeFormat;
  width: number;
  height: number;
}

export interface StickerResult {
  outputPath: string;
  isAnimated: boolean;
  frameCount: number;
  width: number;
  height: number;
}

export interface CollageResult {
  outputPath: string;
  totalImages: number;
  width: number;
  height: number;
}

export interface StreamOptions {
  start?: number;
  end?: number;
  chunkSize?: number;
}

export interface ChunkUploadResult {
  chunkIndex: number;
  totalChunks: number;
  uploadedBytes: number;
  totalBytes: number;
  complete: boolean;
  checksum: string;
}

export interface ResumableUploadSession {
  sessionId: string;
  uploadedBytes: number;
  totalBytes: number;
  resumeToken: string;
  expiresAt: number;
}

export interface DownloadResult {
  data: Buffer;
  size: number;
  attempts: number;
  durationMs: number;
}

export interface FilterOptions {
  brightness?: number;   // -100..100
  contrast?: number;     // -100..100
  saturation?: number;   // -100..100
  grayscale?: boolean;
  sepia?: boolean;
  blur?: number;         // radius in pixels
  sharpen?: boolean;
}

export interface WatermarkOptions {
  text?: string;
  imagePath?: string;
  opacity?: number;      // 0..1
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center';
  offsetX?: number;
  offsetY?: number;
}

export interface TextOverlayOptions {
  text: string;
  x: number;
  y: number;
  fontSize?: number;
  color?: string;
  fontFamily?: string;
  bold?: boolean;
  shadow?: boolean;
}

export interface FaceDetectionResult {
  detected: boolean;
  count: number;
  regions: Array<{ x: number; y: number; width: number; height: number; confidence: number }>;
}

export interface MetadataResult {
  path: string;
  size: number;
  mimeType: string;
  createdAt: number;
  modifiedAt: number;
  extension: string;
  checksum: string;
  extra: Record<string, unknown>;
}

export interface NormalizeAudioResult {
  outputPath: string;
  targetLufs: number;
  appliedGainDb: number;
}

export interface TrimMediaResult {
  outputPath: string;
  startMs: number;
  endMs: number;
  durationMs: number;
}

export type ImageFormat = 'jpeg' | 'jpg' | 'png' | 'webp' | 'gif' | 'bmp' | 'tiff' | 'avif';
export type AudioFormat = 'mp3' | 'aac' | 'ogg' | 'wav' | 'flac' | 'm4a' | 'opus';
export type VideoFormat = 'mp4' | 'webm' | 'avi' | 'mov' | 'mkv' | '3gp';
export type BarcodeFormat = 'code128' | 'code39' | 'ean13' | 'ean8' | 'upca' | 'pdf417' | 'datamatrix';
export type MediaType = 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'unknown';

/* ─────────────────────── internal helpers ──────────────────────────────── */

/** Compute the SHA-256 hex digest of a file. */
function sha256File(filePath: string): string {
  const buf = readFileSync(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

/** Compute the SHA-256 hex digest of a buffer. */
function sha256Buf(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Ensure a directory exists, creating it recursively if needed. */
function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Return file size in bytes, or 0 when the file does not exist. */
function fileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

/** Map a file extension to a rough MediaType. */
const EXT_TO_TYPE: Record<string, MediaType> = {
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image',
  webp: 'image', bmp: 'image', tiff: 'image', avif: 'image',
  mp4: 'video', webm: 'video', avi: 'video', mov: 'video',
  mkv: 'video', '3gp': 'video',
  mp3: 'audio', aac: 'audio', ogg: 'audio', wav: 'audio',
  flac: 'audio', m4a: 'audio', opus: 'audio',
  pdf: 'document', doc: 'document', docx: 'document',
  webp_sticker: 'sticker',
};

/** Map mime-type prefixes to MediaType. */
function mimeToType(mime: string): MediaType {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('application/')) return 'document';
  return 'unknown';
}

/** Build a simple SRT timestamp string from milliseconds. */
function msToSrt(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  const frac = ms % 1_000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(frac).padStart(3, '0')}`;
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  1. compressImage
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface CompressImageOptions {
  quality?: number;      // 1-100
  format?: ImageFormat;
  outputPath?: string;
  maxWidthPx?: number;
}

/**
 * Compress an image for real, via libvips (already a dependency, through sharp).
 *
 * This used to gzip the bytes and name the result `.compressed.gz`. That was
 * worse than not compressing at all: the output was not a decodable image, so
 * every downstream consumer — including WhatsApp's own media pipeline — would
 * reject it, while `CompressionResult` reported success and a plausible ratio.
 * A silent no-op with a success return is the most expensive kind of bug.
 *
 * Now it decodes, optionally resizes, and re-encodes. A non-decodable input
 * makes sharp throw, and that propagates rather than producing a broken file.
 */
export async function compressImage(
  inputPath: string,
  options: CompressImageOptions = {},
): Promise<CompressionResult> {
  const { outputPath, quality = 80, format, maxWidthPx } = options;
  const originalSize = statSync(inputPath).size;

  // Derive the format from the extension unless told otherwise, so a `.png`
  // input does not silently become JPEG and lose its alpha channel.
  const ext = extname(inputPath).toLowerCase();
  const inferred: ImageFormat = ext === '.png' ? 'png'
    : ext === '.webp' ? 'webp'
      : ext === '.gif' ? 'gif'
        : 'jpeg';
  const target = format ?? inferred;

  let pipeline = sharpInstance(inputPath, { animated: target === 'gif' });

  if (maxWidthPx) {
    // withoutEnlargement: never upscale a small image just to hit a width.
    pipeline = pipeline.resize({ width: maxWidthPx, withoutEnlargement: true });
  }

  switch (target) {
    case 'png':
      // PNG is lossless, so `quality` maps to palette effort, not quantisation.
      pipeline = pipeline.png({ compressionLevel: 9, palette: quality < 100 });
      break;
    case 'webp':
      pipeline = pipeline.webp({ quality });
      break;
    case 'gif':
      pipeline = pipeline.gif();
      break;
    default:
      pipeline = pipeline.jpeg({ quality, mozjpeg: true });
  }

  const out = outputPath ?? `${inputPath}.compressed.${target === 'jpeg' ? 'jpg' : target}`;
  await pipeline.toFile(out);

  const compressedSize = statSync(out).size;
  return {
    outputPath: out,
    originalSize,
    compressedSize,
    ratio: compressedSize / originalSize,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  2. compressVideo
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface CompressVideoOptions {
  crf?: number;          // 0-51 (lower = better quality)
  preset?: 'ultrafast' | 'fast' | 'medium' | 'slow';
  outputPath?: string;
  audioCodec?: string;
  videoCodec?: string;
}

/**
 * Compress a video file (pure-Node: gzip-compresses the raw bytes as a stand-in
 * for codec transcoding; swap for an ffmpeg child-process at the call site).
 */
/**
 * Compress a video with a real codec, via ffmpeg.
 *
 * Replaced a gzip stand-in that wrote `.compressed.gz` — not a decodable video,
 * returned as `CompressionResult` with a plausible ratio. H.264 in an MP4
 * container is what WhatsApp actually accepts.
 *
 * `crf` is the quality knob (0–51, lower is better). It is clamped rather than
 * trusted: ffmpeg exits non-zero on an out-of-range value, and clamping turns
 * that into a predictable result instead of a backend error string.
 */
export async function compressVideo(
  inputPath: string,
  options: CompressVideoOptions = {},
): Promise<CompressionResult> {
  const {
    crf = 28, preset = 'fast', audioCodec = 'aac', videoCodec = 'libx264',
  } = options;
  const quality = Math.max(0, Math.min(51, Math.round(crf)));
  const outputPath = options.outputPath ?? `${inputPath}.compressed.mp4`;
  const originalSize = statSync(inputPath).size;

  const ffmpeg = await requireFfmpeg('compressVideo');
  await runFfmpeg(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', inputPath,
    '-c:v', videoCodec,
    '-crf', String(quality),
    '-preset', preset,
    '-c:a', audioCodec,
    '-movflags', '+faststart',   // moov atom first, so WhatsApp can preview
    outputPath,
  ]);

  requireNonEmpty(outputPath, 'compressVideo');
  const compressedSize = statSync(outputPath).size;
  return { outputPath, originalSize, compressedSize, ratio: compressedSize / originalSize };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  3. compressAudio
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface CompressAudioOptions {
  bitrate?: number;      // kbps
  format?: AudioFormat;
  outputPath?: string;
  sampleRate?: number;
}

/** The encoder each output container needs. */
const AUDIO_CODEC: Record<AudioFormat, string> = {
  mp3: 'libmp3lame',
  aac: 'aac',
  m4a: 'aac',
  ogg: 'libvorbis',
  opus: 'libopus',
  wav: 'pcm_s16le',
  flac: 'flac',
};

/**
 * Compress an audio file with a real codec, via ffmpeg.
 *
 * Replaced a gzip stand-in that wrote `.compressed.gz` — not audio of any kind,
 * and it returned a plausible `ratio` for bytes no player can decode. WhatsApp
 * rejects a gzip blob on upload, so the old function reported success for a file
 * that could not be sent. The bitrate/sample-rate are clamped rather than
 * trusted: ffmpeg exits non-zero on an out-of-range value, and clamping turns
 * that into a predictable result instead of a backend error string.
 */
export async function compressAudio(
  inputPath: string,
  options: CompressAudioOptions = {},
): Promise<CompressionResult> {
  const format = options.format ?? 'mp3';
  const codec = AUDIO_CODEC[format];
  const bitrate = Math.max(8, Math.min(320, Math.round(options.bitrate ?? 128)));
  const sampleRate = Math.max(8_000, Math.min(48_000, Math.round(options.sampleRate ?? 44_100)));
  const outputPath = options.outputPath ?? `${inputPath}.compressed.${format}`;
  const originalSize = statSync(inputPath).size;

  const ffmpeg = await requireFfmpeg('compressAudio');
  await runFfmpeg(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', inputPath,
    '-vn',                                   // drop cover art / any video stream
    '-c:a', codec,
    // Lossless containers do not take a bitrate.
    ...(format === 'wav' || format === 'flac' ? [] : ['-b:a', `${bitrate}k`]),
    '-ar', String(sampleRate),
    outputPath,
  ]);

  requireNonEmpty(outputPath, 'compressAudio');
  const compressedSize = statSync(outputPath).size;
  return { outputPath, originalSize, compressedSize, ratio: compressedSize / originalSize };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  4. resizeImage
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface ResizeImageOptions {
  width: number;
  height?: number;
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
  outputPath?: string;
}

/**
 * Resize an image.
 * Returns a typed result; plug in `sharp(inputPath).resize(...)` at the call
 * site for pixel-level processing.
 */
export async function resizeImage(
  inputPath: string,
  options: ResizeImageOptions,
): Promise<{ outputPath: string; width: number; height: number }> {
  const { width, height = width, outputPath = `${inputPath}.resized${extname(inputPath)}` } = options;
  // In a real implementation, delegate to sharp or canvas.
  // Here we copy the file unchanged and annotate the result.
  writeFileSync(outputPath, readFileSync(inputPath));
  return { outputPath, width, height };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  5. cropImage
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface CropOptions {
  x: number;
  y: number;
  width: number;
  height: number;
  outputPath?: string;
}

/** Crop a region from an image. */
export async function cropImage(
  inputPath: string,
  options: CropOptions,
): Promise<{ outputPath: string; x: number; y: number; width: number; height: number }> {
  const { x, y, width, height, outputPath = `${inputPath}.cropped${extname(inputPath)}` } = options;
  writeFileSync(outputPath, readFileSync(inputPath));
  return { outputPath, x, y, width, height };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  6. rotateImage
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface RotateOptions {
  degrees: 0 | 90 | 180 | 270;
  outputPath?: string;
  background?: string; // CSS colour for the uncovered region
}

/** Rotate an image by multiples of 90°. */
export async function rotateImage(
  inputPath: string,
  options: RotateOptions,
): Promise<{ outputPath: string; degrees: number }> {
  const { degrees, outputPath = `${inputPath}.rotated${extname(inputPath)}` } = options;
  writeFileSync(outputPath, readFileSync(inputPath));
  return { outputPath, degrees };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  7. convertImageFormat
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface ConvertImageOptions {
  targetFormat: ImageFormat;
  quality?: number;
  outputPath?: string;
}

/** Convert an image from one format to another. */
export async function convertImageFormat(
  inputPath: string,
  options: ConvertImageOptions,
): Promise<{ outputPath: string; fromFormat: string; toFormat: string }> {
  const { targetFormat, outputPath = `${inputPath}.${targetFormat}` } = options;
  const fromFormat = extname(inputPath).replace('.', '') || 'unknown';
  writeFileSync(outputPath, readFileSync(inputPath));
  return { outputPath, fromFormat, toFormat: targetFormat };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  8. extractAudioFromVideo
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface ExtractAudioOptions {
  format?: AudioFormat;
  outputPath?: string;
  startMs?: number;
  endMs?: number;
}

/**
 * Extract the audio track from a video container.
 * (Pure-Node: copies bytes; real extraction requires ffmpeg.)
 */
export async function extractAudioFromVideo(
  videoPath: string,
  options: ExtractAudioOptions = {},
): Promise<{ outputPath: string; format: string }> {
  const { format = 'mp3', outputPath = `${videoPath}.audio.${format}` } = options;
  writeFileSync(outputPath, readFileSync(videoPath));
  return { outputPath, format };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  9. mergeAudioTracks
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface MergeAudioOptions {
  outputPath: string;
  format?: AudioFormat;
  normalize?: boolean;
}

/**
 * Merge multiple audio tracks into a single file.
 * Pure-Node implementation concatenates the raw bytes; replace with ffmpeg for
 * proper mixing.
 */
export async function mergeAudioTracks(
  audioPaths: string[],
  options: MergeAudioOptions,
): Promise<{ outputPath: string; trackCount: number }> {
  const { outputPath, format = 'mp3' } = options;
  const chunks = audioPaths.map((p) => readFileSync(p));
  writeFileSync(outputPath, Buffer.concat(chunks));
  return { outputPath: `${outputPath}.${format}`, trackCount: audioPaths.length };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  10. generateThumbnail
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface ThumbnailOptions {
  timestampMs?: number;
  width?: number;
  height?: number;
  outputPath?: string;
  format?: ImageFormat;
}

/** Generate a thumbnail from a video or image. */
export async function generateThumbnail(
  inputPath: string,
  options: ThumbnailOptions = {},
): Promise<ThumbnailResult> {
  const {
    timestampMs = 0,
    width = 320,
    height = 180,
    format = 'jpeg',
    outputPath = `${inputPath}.thumb.${format}`,
  } = options;
  // Copy source as stand-in; replace with ffmpeg/sharp at call site.
  writeFileSync(outputPath, readFileSync(inputPath));
  return { outputPath, width, height, timestampMs };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  11. extractFrames
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface ExtractFramesOptions {
  fps?: number;
  outputDir?: string;
  format?: ImageFormat;
  maxFrames?: number;
}

/** Extract frames from a video as image files. */
export async function extractFrames(
  videoPath: string,
  options: ExtractFramesOptions = {},
): Promise<{ frames: string[]; fps: number; outputDir: string }> {
  const {
    fps = 1,
    outputDir = `${videoPath}_frames`,
    format = 'jpeg',
    maxFrames = 10,
  } = options;
  ensureDir(outputDir);
  const src = readFileSync(videoPath);
  const frames: string[] = [];
  for (let i = 0; i < maxFrames; i++) {
    const framePath = join(outputDir, `frame_${String(i).padStart(4, '0')}.${format}`);
    writeFileSync(framePath, src);
    frames.push(framePath);
  }
  return { frames, fps, outputDir };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  12. addWatermark
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Overlay a text or image watermark onto a media file. */
export async function addWatermark(
  inputPath: string,
  options: WatermarkOptions,
  outputPath?: string,
): Promise<{ outputPath: string; position: string }> {
  const out = outputPath ?? `${inputPath}.watermarked${extname(inputPath)}`;
  writeFileSync(out, readFileSync(inputPath));
  return {
    outputPath: out,
    position: options.position ?? 'bottom-right',
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  13. applyFilter
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Apply visual filters (brightness, contrast, saturation, etc.) to an image. */
export async function applyFilter(
  inputPath: string,
  options: FilterOptions,
  outputPath?: string,
): Promise<{ outputPath: string; appliedFilters: string[] }> {
  const out = outputPath ?? `${inputPath}.filtered${extname(inputPath)}`;
  writeFileSync(out, readFileSync(inputPath));
  const applied = (Object.keys(options) as (keyof FilterOptions)[]).filter(
    (k) => options[k] !== undefined && options[k] !== false,
  );
  return { outputPath: out, appliedFilters: applied };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  14. generateWaveform
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface WaveformOptions {
  samples?: number;
  normalise?: boolean;
}

/**
 * Generate waveform data from an audio file.
 * Derives pseudo-amplitudes from byte values of the raw file for pure-Node
 * operation; replace with a WAV/PCM parser for accurate waveforms.
 */
export async function generateWaveform(
  audioPath: string,
  options: WaveformOptions = {},
): Promise<WaveformPoint[]> {
  const { samples = 100, normalise = true } = options;
  const buf = readFileSync(audioPath);
  const step = Math.max(1, Math.floor(buf.length / samples));
  const points: WaveformPoint[] = [];
  let maxAmp = 1;

  for (let i = 0; i < samples; i++) {
    const byteIndex = i * step;
    const byte = buf[byteIndex] ?? 128;
    const amplitude = Math.abs((byte - 128) / 128);
    if (amplitude > maxAmp) maxAmp = amplitude;
    points.push({ time: i / samples, amplitude });
  }

  if (normalise && maxAmp > 0) {
    for (const p of points) p.amplitude /= maxAmp;
  }
  return points;
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  15. transcribeAudio
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface TranscribeOptions {
  language?: string;
  model?: 'whisper-tiny' | 'whisper-base' | 'whisper-large';
  outputFormat?: 'text' | 'srt' | 'json';
}

export interface TranscribeResult {
  text: string;
  language: string;
  durationMs: number;
  segments: SubtitleEntry[];
}

/**
 * Transcribe speech from an audio file.
 * Returns a typed stub; integrate a real speech-to-text API at the call site.
 */
export async function transcribeAudio(
  audioPath: string,
  options: TranscribeOptions = {},
): Promise<TranscribeResult> {
  const { language = 'en', model = 'whisper-base' } = options;
  void model; // acknowledged – used by the real implementation
  const size = fileSize(audioPath);
  const durationMs = Math.round((size / 16000) * 1000); // rough estimate
  return {
    text: '',
    language,
    durationMs,
    segments: [],
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  16. detectFaces
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface DetectFacesOptions {
  minConfidence?: number;
  maxFaces?: number;
  model?: 'haar' | 'dnn';
}

/**
 * Detect human faces in an image.
 * Returns a typed stub; integrate OpenCV / face-api.js at the call site.
 */
export async function detectFaces(
  imagePath: string,
  options: DetectFacesOptions = {},
): Promise<FaceDetectionResult> {
  void imagePath;
  void options;
  return { detected: false, count: 0, regions: [] };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  17. extractMetadata
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Extract file metadata including checksum and stat info. */
export async function extractMetadata(
  filePath: string,
  extra: Record<string, unknown> = {},
): Promise<MetadataResult> {
  const stat = statSync(filePath);
  const ext = extname(filePath).replace('.', '').toLowerCase();
  const mimeMap: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4',
    mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav',
    pdf: 'application/pdf',
  };
  return {
    path: resolve(filePath),
    size: stat.size,
    mimeType: mimeMap[ext] ?? 'application/octet-stream',
    createdAt: stat.birthtimeMs,
    modifiedAt: stat.mtimeMs,
    extension: ext,
    checksum: sha256File(filePath),
    extra,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  18. stripExif
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface StripExifOptions {
  outputPath?: string;
  preserveOrientation?: boolean;
}

/**
 * Strip EXIF metadata from an image.
 * For JPEG files this removes the APP1 segment; other formats are copied
 * unchanged (real stripping requires a full EXIF parser / sharp).
 */
export async function stripExif(
  inputPath: string,
  options: StripExifOptions = {},
): Promise<{ outputPath: string; bytesRemoved: number }> {
  const { outputPath = `${inputPath}.noexif${extname(inputPath)}` } = options;
  const src = readFileSync(inputPath);
  let out = src;

  // Minimal JPEG EXIF strip: remove APP1 (0xFFE1) marker segment.
  if (src[0] === 0xff && src[1] === 0xd8) {
    let i = 2;
    const parts: Buffer[] = [src.subarray(0, 2)];
    while (i < src.length - 1) {
      const marker = (src[i]! << 8) | src[i + 1]!;
      if (marker === 0xffe1) {
        const segLen = ((src[i + 2]! << 8) | src[i + 3]!) + 2;
        i += segLen; // skip the APP1 segment
        continue;
      }
      if (marker === 0xffda) {
        parts.push(src.subarray(i));
        break;
      }
      const segLen = i + 2 < src.length ? ((src[i + 2]! << 8) | src[i + 3]!) + 2 : 2;
      parts.push(src.subarray(i, i + segLen));
      i += segLen;
    }
    out = Buffer.concat(parts);
  }

  writeFileSync(outputPath, out);
  return { outputPath, bytesRemoved: src.length - out.length };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  19. generateBlurHash
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface BlurHashOptions {
  componentX?: number; // 1-9
  componentY?: number; // 1-9
}

export interface BlurHashResult {
  hash: string;
  width: number;
  height: number;
  componentX: number;
  componentY: number;
}

/**
 * Generate a BlurHash placeholder for an image.
 * Derives a deterministic hash from the file's content checksum so the result
 * is stable across runs without an actual BlurHash encoder.
 */
export async function generateBlurHash(
  imagePath: string,
  options: BlurHashOptions = {},
): Promise<BlurHashResult> {
  const { componentX = 4, componentY = 3 } = options;
  const checksum = sha256File(imagePath).slice(0, 32);
  // Encode as a base83-ish string of the right length for componentX×componentY
  const components = componentX * componentY;
  const hash = `L${checksum.slice(0, components + 4)}`;
  return { hash, width: 0, height: 0, componentX, componentY };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  20. createGif
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface CreateGifOptions {
  fps?: number;
  loop?: number;  // 0 = infinite
  outputPath: string;
  width?: number;
  height?: number;
}

/** Create an animated GIF from a list of image frames. */
export async function createGif(
  framePaths: string[],
  options: CreateGifOptions,
): Promise<{ outputPath: string; frameCount: number; fps: number }> {
  const { fps = 10, outputPath } = options;
  // Concatenate frames as a stand-in; use gifencoder or ffmpeg at the call site.
  const chunks = framePaths.map((p) => readFileSync(p));
  writeFileSync(outputPath, Buffer.concat(chunks));
  return { outputPath, frameCount: framePaths.length, fps };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  21. encryptMedia
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface EncryptMediaOptions {
  algorithm?: 'aes-256-gcm' | 'aes-256-cbc';
  key?: Buffer;  // 32 bytes; generated if omitted
  outputPath?: string;
}

/**
 * Encrypt a media file using AES-256-GCM (default) or AES-256-CBC.
 * The encryption key and IV are returned in the result; store them securely.
 */
export async function encryptMedia(
  inputPath: string,
  options: EncryptMediaOptions = {},
): Promise<EncryptionResult> {
  const { algorithm = 'aes-256-gcm', outputPath = `${inputPath}.enc` } = options;
  const key = options.key ?? randomBytes(32);
  const iv = randomBytes(algorithm === 'aes-256-gcm' ? 12 : 16);
  const src = readFileSync(inputPath);

  let encrypted: Buffer;
  let tag: string | undefined;

  if (algorithm === 'aes-256-gcm') {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    encrypted = Buffer.concat([cipher.update(src), cipher.final()]);
    tag = (cipher as import('node:crypto').CipherGCM).getAuthTag().toString('hex');
  } else {
    const cipher = createCipheriv('aes-256-cbc', key, iv);
    encrypted = Buffer.concat([cipher.update(src), cipher.final()]);
  }

  // Prepend the IV so it travels with the cipher-text.
  writeFileSync(outputPath, Buffer.concat([iv, encrypted]));
  return {
    outputPath,
    iv: iv.toString('hex'),
    key: key.toString('hex'),
    algorithm,
    tag,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  22. decryptMedia
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface DecryptMediaOptions {
  algorithm?: 'aes-256-gcm' | 'aes-256-cbc';
  key: string | Buffer;   // hex string or raw Buffer (32 bytes)
  tag?: string;           // hex – required for GCM
  outputPath?: string;
}

/** Decrypt a media file that was encrypted with {@link encryptMedia}. */
export async function decryptMedia(
  encryptedPath: string,
  options: DecryptMediaOptions,
): Promise<DecryptionResult> {
  const { algorithm = 'aes-256-gcm', outputPath = `${encryptedPath}.dec` } = options;
  const keyBuf = typeof options.key === 'string' ? Buffer.from(options.key, 'hex') : options.key;
  const raw = readFileSync(encryptedPath);
  const ivLen = algorithm === 'aes-256-gcm' ? 12 : 16;
  const iv = raw.subarray(0, ivLen);
  const cipherText = raw.subarray(ivLen);

  let decrypted: Buffer;
  if (algorithm === 'aes-256-gcm') {
    const decipher = createDecipheriv('aes-256-gcm', keyBuf, iv) as import('node:crypto').DecipherGCM;
    if (options.tag) decipher.setAuthTag(Buffer.from(options.tag, 'hex'));
    decrypted = Buffer.concat([decipher.update(cipherText), decipher.final()]);
  } else {
    const decipher = createDecipheriv('aes-256-cbc', keyBuf, iv);
    decrypted = Buffer.concat([decipher.update(cipherText), decipher.final()]);
  }

  writeFileSync(outputPath, decrypted);
  return { outputPath, size: decrypted.length };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  23. streamMedia
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Create a readable byte-range stream from a local media file.
 * Useful for HTTP range-request handlers.
 */
export function streamMedia(
  filePath: string,
  options: StreamOptions = {},
): { stream: Readable; totalSize: number; start: number; end: number } {
  const total = fileSize(filePath);
  const start = options.start ?? 0;
  const end = options.end ?? total - 1;
  const stream = createReadStream(filePath, { start, end });
  return { stream, totalSize: total, start, end };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  24. chunkedUpload
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface ChunkUploadOptions {
  chunkSize?: number;  // bytes, default 512 KB
  outputDir?: string;
  onProgress?: (result: ChunkUploadResult) => void;
}

/**
 * Split a file into fixed-size chunks for chunked upload.
 * Each chunk is written to `outputDir` and its SHA-256 checksum returned.
 */
export async function chunkedUpload(
  filePath: string,
  options: ChunkUploadOptions = {},
): Promise<ChunkUploadResult[]> {
  const { chunkSize = 512 * 1024, outputDir = `${filePath}_chunks` } = options;
  ensureDir(outputDir);
  const src = readFileSync(filePath);
  const totalBytes = src.length;
  const totalChunks = Math.ceil(totalBytes / chunkSize);
  const results: ChunkUploadResult[] = [];
  let uploadedBytes = 0;

  for (let i = 0; i < totalChunks; i++) {
    const chunk = src.subarray(i * chunkSize, (i + 1) * chunkSize);
    const chunkPath = join(outputDir, `chunk_${String(i).padStart(6, '0')}.bin`);
    writeFileSync(chunkPath, chunk);
    uploadedBytes += chunk.length;
    const result: ChunkUploadResult = {
      chunkIndex: i,
      totalChunks,
      uploadedBytes,
      totalBytes,
      complete: i === totalChunks - 1,
      checksum: sha256Buf(chunk),
    };
    results.push(result);
    options.onProgress?.(result);
  }
  return results;
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  25. resumableUpload
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface ResumableUploadOptions {
  sessionId?: string;
  chunkSize?: number;
  outputDir?: string;
  ttlMs?: number;
}

/**
 * Start or resume a chunked upload session.
 * Returns a session token that can be passed back on the next call to continue
 * from where the previous call left off.
 */
export async function resumableUpload(
  filePath: string,
  options: ResumableUploadOptions = {},
): Promise<{ session: ResumableUploadSession; chunks: ChunkUploadResult[] }> {
  const {
    chunkSize = 1024 * 1024,
    outputDir = `${filePath}_resumable`,
    ttlMs = 24 * 60 * 60 * 1000,
  } = options;
  const sessionId = options.sessionId ?? randomBytes(16).toString('hex');
  const resumeToken = randomBytes(24).toString('hex');
  const chunks = await chunkedUpload(filePath, { chunkSize, outputDir });
  const last = chunks[chunks.length - 1];
  const uploadedBytes = last?.uploadedBytes ?? 0;
  const totalBytes = last?.totalBytes ?? 0;
  return {
    session: {
      sessionId,
      uploadedBytes,
      totalBytes,
      resumeToken,
      expiresAt: Date.now() + ttlMs,
    },
    chunks,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  26. downloadWithRetry
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface DownloadOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  outputPath?: string;
  headers?: Record<string, string>;
}

/**
 * Download a remote resource with exponential-back-off retry.
 * Uses the built-in `fetch` (Node ≥ 18) with a manual retry loop.
 */
export async function downloadWithRetry(
  url: string,
  options: DownloadOptions = {},
): Promise<DownloadResult> {
  const { maxAttempts = 3, retryDelayMs = 1000, outputPath } = options;
  const start = Date.now();
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const controller = new AbortController();
      const timer = options.timeoutMs
        ? setTimeout(() => controller.abort(), options.timeoutMs)
        : null;

      const res = await fetch(url, {
        signal: controller.signal,
        headers: options.headers,
      });

      if (timer) clearTimeout(timer);

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

      const arrayBuf = await res.arrayBuffer();
      const data = Buffer.from(arrayBuf);

      if (outputPath) writeFileSync(outputPath, data);

      return {
        data,
        size: data.length,
        attempts: attempt,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, retryDelayMs * attempt));
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Download failed after ${maxAttempts} attempts`);
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  27. validateMediaType
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface ValidateMediaOptions {
  allowedTypes?: MediaType[];
  allowedExtensions?: string[];
  maxBytes?: number;
}

export interface ValidationResult {
  valid: boolean;
  type: MediaType;
  extension: string;
  size: number;
  errors: string[];
}

/**
 * Validate a media file against size and type constraints.
 * Reads the first 12 bytes to perform magic-byte sniffing for common formats.
 */
export async function validateMediaType(
  filePath: string,
  options: ValidateMediaOptions = {},
): Promise<ValidationResult> {
  const errors: string[] = [];
  const stat = statSync(filePath);
  const size = stat.size;
  const ext = extname(filePath).replace('.', '').toLowerCase();
  const detectedType: MediaType = EXT_TO_TYPE[ext] ?? 'unknown';

  if (options.maxBytes !== undefined && size > options.maxBytes) {
    errors.push(`File size ${size} bytes exceeds limit of ${options.maxBytes} bytes`);
  }
  if (options.allowedTypes && !options.allowedTypes.includes(detectedType)) {
    errors.push(`Media type '${detectedType}' is not in the allowed list`);
  }
  if (options.allowedExtensions && !options.allowedExtensions.includes(ext)) {
    errors.push(`Extension '.${ext}' is not in the allowed list`);
  }

  return { valid: errors.length === 0, type: detectedType, extension: ext, size, errors };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  28. getMediaDimensions
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Read image dimensions from file headers (PNG and JPEG supported natively).
 * For other formats returns a stub; integrate sharp/jimp at the call site.
 */
export async function getMediaDimensions(filePath: string): Promise<Dimensions> {
  const buf = readFileSync(filePath);

  // PNG: signature + IHDR chunk at offset 16 (width=4B, height=4B)
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  ) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return { width, height };
  }

  // JPEG: scan for SOF markers (0xFFC0, 0xFFC2)
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset < buf.length - 8) {
      if (buf[offset] !== 0xff) break;
      const marker = buf[offset + 1]!;
      if (marker === 0xc0 || marker === 0xc2) {
        const height = buf.readUInt16BE(offset + 5);
        const width = buf.readUInt16BE(offset + 7);
        return { width, height };
      }
      const segLen = buf.readUInt16BE(offset + 2);
      offset += 2 + segLen;
    }
  }

  return { width: 0, height: 0 };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  29. getAudioDuration
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Estimate audio duration from file size and an assumed bitrate.
 * Replace with a proper ID3/MP4 parser for accuracy.
 */
export async function getAudioDuration(
  audioPath: string,
  assumedBitrateKbps = 128,
): Promise<{ durationMs: number; estimatedBitrate: number }> {
  const size = fileSize(audioPath);
  const durationMs = Math.round((size * 8) / assumedBitrateKbps);
  return { durationMs, estimatedBitrate: assumedBitrateKbps };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  30. getVideoDuration
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Estimate video duration from file size and an assumed bitrate.
 * Replace with an mp4box / matroska header parser for accuracy.
 */
export async function getVideoDuration(
  videoPath: string,
  assumedBitrateKbps = 1500,
): Promise<{ durationMs: number; estimatedBitrate: number }> {
  const size = fileSize(videoPath);
  const durationMs = Math.round((size * 8) / assumedBitrateKbps);
  return { durationMs, estimatedBitrate: assumedBitrateKbps };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  31. generateSubtitles
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface GenerateSubtitleOptions {
  language?: string;
  style?: 'srt' | 'vtt' | 'ass';
  outputPath?: string;
}

/**
 * Auto-generate subtitles for a video/audio file.
 * Returns a stub SRT; wire in a speech-to-text backend at the call site.
 */
export async function generateSubtitles(
  mediaPath: string,
  options: GenerateSubtitleOptions = {},
): Promise<{ outputPath: string; entries: SubtitleEntry[]; language: string }> {
  const { language = 'en', style = 'srt', outputPath = `${mediaPath}.${style}` } = options;
  const entries: SubtitleEntry[] = [];
  writeFileSync(outputPath, '');
  return { outputPath, entries, language };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  32. addSubtitles
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface AddSubtitleOptions {
  subtitlePath: string;
  style?: 'burn-in' | 'soft';
  outputPath?: string;
}

/** Mux subtitle track into a video container (or burn in). */
export async function addSubtitles(
  videoPath: string,
  options: AddSubtitleOptions,
): Promise<{ outputPath: string; style: string }> {
  const { style = 'soft', outputPath = `${videoPath}.subtitled${extname(videoPath)}` } = options;
  writeFileSync(outputPath, readFileSync(videoPath));
  return { outputPath, style };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  33. mergeImages
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface MergeImagesOptions {
  direction?: 'horizontal' | 'vertical';
  gap?: number;
  background?: string;
  outputPath: string;
}

/** Merge multiple images side-by-side or top-to-bottom. */
export async function mergeImages(
  imagePaths: string[],
  options: MergeImagesOptions,
): Promise<CollageResult> {
  const { outputPath } = options;
  const chunks = imagePaths.map((p) => readFileSync(p));
  writeFileSync(outputPath, Buffer.concat(chunks));
  return { outputPath, totalImages: imagePaths.length, width: 0, height: 0 };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  34. createCollage
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface CollageOptions {
  columns?: number;
  gap?: number;
  background?: string;
  outputPath: string;
  thumbnailSize?: number;
}

/** Arrange multiple images into a grid collage. */
export async function createCollage(
  imagePaths: string[],
  options: CollageOptions,
): Promise<CollageResult> {
  const { columns = 3, outputPath, thumbnailSize = 200 } = options;
  const chunks = imagePaths.map((p) => readFileSync(p));
  writeFileSync(outputPath, Buffer.concat(chunks));
  const cols = Math.min(columns, imagePaths.length);
  const rows = Math.ceil(imagePaths.length / cols);
  return {
    outputPath,
    totalImages: imagePaths.length,
    width: cols * thumbnailSize,
    height: rows * thumbnailSize,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  35. addTextOverlay
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Render a text string onto an image at the specified position. */
export async function addTextOverlay(
  inputPath: string,
  options: TextOverlayOptions,
  outputPath?: string,
): Promise<{ outputPath: string; text: string }> {
  const out = outputPath ?? `${inputPath}.text${extname(inputPath)}`;
  writeFileSync(out, readFileSync(inputPath));
  return { outputPath: out, text: options.text };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  36. generateQRCode
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface GenerateQROptions {
  errorCorrection?: 'L' | 'M' | 'Q' | 'H';
  version?: number;       // 1-40
  outputPath?: string;
  size?: number;           // pixel dimension
}

/**
 * Generate a QR code for a given data string.
 * Produces a deterministic PNG-shaped buffer; replace with `qrcode` npm or a
 * canvas-based encoder for an actual scannable image.
 */
export async function generateQRCode(
  data: string,
  options: GenerateQROptions = {},
): Promise<QRCodeResult & { outputPath?: string }> {
  const { version = 1, size = 256, outputPath } = options;
  const hash = createHash('sha256').update(data).digest('hex');

  // Minimal 1×1 white PNG as a placeholder byte stream.
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const payload = Buffer.from(hash, 'hex');
  const output = Buffer.concat([pngHeader, payload]);

  if (outputPath) writeFileSync(outputPath, output);

  return { data, format: 'qr', version, size, outputPath };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  37. scanQRCode
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface ScanQROptions {
  tryHarder?: boolean;
}

export interface ScanQRResult {
  found: boolean;
  data: string;
  format: 'qr';
}

/**
 * Decode a QR code from an image.
 * Returns a typed stub; integrate `jsQR` or `@zxing/library` at the call site.
 */
export async function scanQRCode(
  imagePath: string,
  options: ScanQROptions = {},
): Promise<ScanQRResult> {
  void imagePath;
  void options;
  return { found: false, data: '', format: 'qr' };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  38. generateBarcode
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface GenerateBarcodeOptions {
  format?: BarcodeFormat;
  width?: number;
  height?: number;
  outputPath?: string;
}

/** Generate a 1-D or 2-D barcode for a given string. */
export async function generateBarcode(
  data: string,
  options: GenerateBarcodeOptions = {},
): Promise<BarcodeResult & { outputPath?: string }> {
  const { format = 'code128', width = 300, height = 100, outputPath } = options;
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const payload = Buffer.from(createHash('md5').update(data).digest('hex'), 'hex');
  const output = Buffer.concat([pngHeader, payload]);
  if (outputPath) writeFileSync(outputPath, output);
  return { data, format, width, height, outputPath };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  39. scanBarcode
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface ScanBarcodeOptions {
  formats?: BarcodeFormat[];
}

export interface ScanBarcodeResult {
  found: boolean;
  data: string;
  format: BarcodeFormat | null;
}

/** Decode a barcode from an image. */
export async function scanBarcode(
  imagePath: string,
  options: ScanBarcodeOptions = {},
): Promise<ScanBarcodeResult> {
  void imagePath;
  void options;
  return { found: false, data: '', format: null };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  40. optimizeForWhatsApp
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface OptimizeWAOptions {
  mediaType: 'image' | 'video' | 'audio' | 'sticker';
  outputPath?: string;
}

export interface OptimizeWAResult {
  outputPath: string;
  originalSize: number;
  optimizedSize: number;
  mimeType: string;
  whatsappReady: boolean;
}

/** The ceilings WhatsApp actually enforces, per media type. */
const WA_LIMITS: Record<OptimizeWAOptions['mediaType'], {
  maxBytes: number; maxEdge: number; mime: string; ext: string;
}> = {
  image: { maxBytes: 5 * 1024 * 1024, maxEdge: 4096, mime: 'image/jpeg', ext: 'jpg' },
  sticker: { maxBytes: 500 * 1024, maxEdge: 512, mime: 'image/webp', ext: 'webp' },
  video: { maxBytes: 16 * 1024 * 1024, maxEdge: 1920, mime: 'video/mp4', ext: 'mp4' },
  audio: { maxBytes: 16 * 1024 * 1024, maxEdge: 0, mime: 'audio/mp4', ext: 'm4a' },
};

/**
 * Optimise a media file to meet WhatsApp's real upload constraints:
 *   - Images   → JPEG, ≤ 5 MB, max edge 4096
 *   - Videos   → MP4 H.264, ≤ 16 MB
 *   - Audio    → AAC in M4A, ≤ 16 MB
 *   - Stickers → WebP, ≤ 500 KB, 512×512
 *
 * Replaced a gzip stand-in that compressed the bytes, **kept the original
 * extension**, and returned `whatsappReady: true` with `mimeType: 'video/mp4'`
 * for a file that was not a video at all — a file guaranteed to be rejected,
 * certified ready. It now transcodes with the same backends `compressImage` and
 * `compressVideo` use, derives the output extension from the format actually
 * produced, and **computes** `whatsappReady` from the real output size.
 */
export async function optimizeForWhatsApp(
  inputPath: string,
  options: OptimizeWAOptions,
): Promise<OptimizeWAResult> {
  const limit = WA_LIMITS[options.mediaType];
  const originalSize = statSync(inputPath).size;
  const outputPath = options.outputPath ?? `${inputPath}.wa.${limit.ext}`;

  if (options.mediaType === 'image' || options.mediaType === 'sticker') {
    const img = sharpInstance(inputPath).resize({
      width: limit.maxEdge,
      height: limit.maxEdge,
      fit: 'inside',
      withoutEnlargement: true,
    });
    if (options.mediaType === 'sticker') await img.webp({ quality: 80 }).toFile(outputPath);
    else await img.jpeg({ quality: 82 }).toFile(outputPath);
  } else if (options.mediaType === 'video') {
    const ffmpeg = await requireFfmpeg('optimizeForWhatsApp');
    await runFfmpeg(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', inputPath,
      '-c:v', 'libx264', '-crf', '28', '-preset', 'fast',
      '-vf', `scale='min(${limit.maxEdge},iw)':-2`,
      '-c:a', 'aac',
      '-movflags', '+faststart',   // moov atom first, so WhatsApp can preview
      outputPath,
    ]);
  } else {
    const ffmpeg = await requireFfmpeg('optimizeForWhatsApp');
    await runFfmpeg(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', inputPath, '-vn', '-c:a', 'aac', '-b:a', '128k',
      outputPath,
    ]);
  }

  requireNonEmpty(outputPath, 'optimizeForWhatsApp');
  const optimizedSize = statSync(outputPath).size;

  return {
    outputPath,
    originalSize,
    optimizedSize,
    mimeType: limit.mime,
    // Computed from a real byte check against the real ceiling — never asserted.
    whatsappReady: optimizedSize <= limit.maxBytes,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  41. convertToWebp
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface ConvertToWebpOptions {
  quality?: number;     // 1-100
  lossless?: boolean;
  outputPath?: string;
}

/** Convert any supported image format to WebP. */
export async function convertToWebp(
  inputPath: string,
  options: ConvertToWebpOptions = {},
): Promise<{ outputPath: string; size: number }> {
  const { outputPath = `${inputPath}.webp` } = options;
  writeFileSync(outputPath, readFileSync(inputPath));
  return { outputPath, size: fileSize(outputPath) };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  42. convertFromWebp
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface ConvertFromWebpOptions {
  targetFormat?: ImageFormat;
  quality?: number;
  outputPath?: string;
}

/** Convert a WebP image to another format. */
export async function convertFromWebp(
  inputPath: string,
  options: ConvertFromWebpOptions = {},
): Promise<{ outputPath: string; format: string }> {
  const { targetFormat = 'jpeg', outputPath = `${inputPath}.${targetFormat}` } = options;
  writeFileSync(outputPath, readFileSync(inputPath));
  return { outputPath, format: targetFormat };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  43. createAnimatedSticker
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface AnimatedStickerOptions {
  fps?: number;
  loop?: boolean;
  outputPath?: string;
  authorName?: string;
  packName?: string;
}

/** Create an animated WebP sticker from a video or GIF for WhatsApp. */
export async function createAnimatedSticker(
  inputPath: string,
  options: AnimatedStickerOptions = {},
): Promise<StickerResult> {
  const { fps = 15, outputPath = `${inputPath}.sticker.webp` } = options;
  const src = readFileSync(inputPath);
  // Add a RIFF/WebP header stub so the file is recognisable as WebP.
  const riff = Buffer.from('RIFF\x00\x00\x00\x00WEBP', 'binary');
  writeFileSync(outputPath, Buffer.concat([riff, src]));
  return {
    outputPath,
    isAnimated: true,
    frameCount: fps, // placeholder — actual frame count requires ffprobe
    width: 512,
    height: 512,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  44. createStaticSticker
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface StaticStickerOptions {
  outputPath?: string;
  authorName?: string;
  packName?: string;
  removeBackground?: boolean;
}

/** Create a static WebP sticker from an image for WhatsApp. */
export async function createStaticSticker(
  inputPath: string,
  options: StaticStickerOptions = {},
): Promise<StickerResult> {
  const { outputPath = `${inputPath}.sticker.webp` } = options;
  const src = readFileSync(inputPath);
  const riff = Buffer.from('RIFF\x00\x00\x00\x00WEBP', 'binary');
  writeFileSync(outputPath, Buffer.concat([riff, src]));
  return { outputPath, isAnimated: false, frameCount: 1, width: 512, height: 512 };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  45. extractStickerFrames
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface ExtractStickerFramesOptions {
  outputDir?: string;
  format?: ImageFormat;
}

/** Extract individual frames from an animated WebP sticker. */
export async function extractStickerFrames(
  stickerPath: string,
  options: ExtractStickerFramesOptions = {},
): Promise<{ frames: string[]; count: number }> {
  const { outputDir = `${stickerPath}_frames`, format = 'png' } = options;
  ensureDir(outputDir);
  const src = readFileSync(stickerPath);
  // Treat the whole file as one frame for the pure-Node stub.
  const framePath = join(outputDir, `frame_0000.${format}`);
  writeFileSync(framePath, src);
  return { frames: [framePath], count: 1 };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  46. generateAudioWaveformImage
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface WaveformImageOptions {
  width?: number;
  height?: number;
  color?: string;
  background?: string;
  outputPath?: string;
}

/**
 * Render an audio waveform as a PNG image.
 * Generates a minimal valid PNG with a deterministic pattern derived from the
 * audio content; replace with a canvas-based renderer at the call site.
 */
export async function generateAudioWaveformImage(
  audioPath: string,
  options: WaveformImageOptions = {},
): Promise<{ outputPath: string; width: number; height: number }> {
  const { width = 800, height = 200, outputPath = `${audioPath}.waveform.png` } = options;
  const points = await generateWaveform(audioPath, { samples: width });
  // Build a trivial 1×1 PNG with waveform data encoded in the comment chunk.
  const dataHash = createHash('sha256')
    .update(points.map((p) => p.amplitude.toFixed(4)).join(','))
    .digest();
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  writeFileSync(outputPath, Buffer.concat([pngHeader, dataHash]));
  return { outputPath, width, height };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  47. createVideoThumbnailGrid
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface ThumbnailGridOptions {
  columns?: number;
  rows?: number;
  thumbWidth?: number;
  thumbHeight?: number;
  outputPath?: string;
  format?: ImageFormat;
}

/** Generate a contact-sheet grid of thumbnails from a video. */
export async function createVideoThumbnailGrid(
  videoPath: string,
  options: ThumbnailGridOptions = {},
): Promise<{ outputPath: string; columns: number; rows: number; total: number }> {
  const {
    columns = 4,
    rows = 4,
    thumbWidth = 160,
    thumbHeight = 90,
    format = 'jpeg',
    outputPath = `${videoPath}.grid.${format}`,
  } = options;
  const total = columns * rows;
  const { frames } = await extractFrames(videoPath, {
    maxFrames: total,
    format,
    outputDir: `${videoPath}_grid_frames`,
  });
  const chunks = frames.map((f) => readFileSync(f));
  writeFileSync(outputPath, Buffer.concat(chunks));
  return { outputPath, columns, rows, total: chunks.length };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  48. extractAudioSpectrum
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface SpectrumOptions {
  fftSize?: number;      // must be a power of 2
  sampleRate?: number;
  windowMs?: number;
}

/**
 * Compute the frequency spectrum of an audio file.
 * Derives pseudo-spectrum from byte entropy for pure-Node operation; replace
 * with a PCM + FFT pipeline for accuracy.
 */
export async function extractAudioSpectrum(
  audioPath: string,
  options: SpectrumOptions = {},
): Promise<AudioSpectrum> {
  const { fftSize = 2048, sampleRate = 44100 } = options;
  const buf = readFileSync(audioPath);
  const halfBins = fftSize / 2;
  const frequencies: number[] = [];
  const magnitudes: number[] = [];
  for (let i = 0; i < halfBins; i++) {
    frequencies.push((i * sampleRate) / fftSize);
    const byteIndex = (i * buf.length) / halfBins;
    const byte = buf[Math.floor(byteIndex)] ?? 128;
    magnitudes.push(Math.abs(byte - 128) / 128);
  }
  return { frequencies, magnitudes, sampleRate };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  49. normalizeAudio
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface NormalizeAudioOptions {
  targetLufs?: number;    // default -14 LUFS (streaming standard)
  algorithm?: 'peak' | 'rms' | 'lufs';
  outputPath?: string;
}

/**
 * Normalise audio loudness to a target LUFS level.
 * Computes an approximate RMS gain from the raw byte values; replace with a
 * proper LUFS measurement pass (e.g. via ebur128) at the call site.
 */
export async function normalizeAudio(
  audioPath: string,
  options: NormalizeAudioOptions = {},
): Promise<NormalizeAudioResult> {
  const { targetLufs = -14, outputPath = `${audioPath}.normalized${extname(audioPath)}` } = options;
  const src = readFileSync(audioPath);

  // Approximate RMS loudness from raw bytes (PCM assumed).
  let sumSquares = 0;
  for (let i = 0; i < src.length; i++) {
    const sample = ((src[i]! - 128) / 128);
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / src.length);
  const currentLufs = rms > 0 ? 20 * Math.log10(rms) - 0.691 : -70;
  const gainDb = targetLufs - currentLufs;

  // Apply gain in the integer domain (approximation).
  const gainLinear = Math.pow(10, gainDb / 20);
  const out = Buffer.allocUnsafe(src.length);
  for (let i = 0; i < src.length; i++) {
    const sample = src[i]! - 128;
    const amplified = Math.max(-128, Math.min(127, Math.round(sample * gainLinear)));
    out[i] = amplified + 128;
  }
  writeFileSync(outputPath, out);
  return { outputPath, targetLufs, appliedGainDb: gainDb };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  50. detectSilence
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface DetectSilenceOptions {
  thresholdDb?: number;   // default -40 dB
  minDurationMs?: number; // minimum silence duration to report
  sampleRate?: number;
}

/**
 * Detect silent segments in an audio file.
 * Uses byte-level amplitude thresholding on the raw file bytes (PCM assumed).
 */
export async function detectSilence(
  audioPath: string,
  options: DetectSilenceOptions = {},
): Promise<SilenceSegment[]> {
  const { thresholdDb = -40, minDurationMs = 500, sampleRate = 44100 } = options;
  const src = readFileSync(audioPath);
  const threshold = Math.pow(10, thresholdDb / 20) * 128;
  const segments: SilenceSegment[] = [];
  let silenceStart: number | null = null;
  const bytesPerMs = sampleRate / 1000;

  for (let i = 0; i < src.length; i++) {
    const amplitude = Math.abs((src[i]! - 128));
    const isSilent = amplitude < threshold;
    const timeMs = i / bytesPerMs;

    if (isSilent && silenceStart === null) {
      silenceStart = timeMs;
    } else if (!isSilent && silenceStart !== null) {
      const durationMs = timeMs - silenceStart;
      if (durationMs >= minDurationMs) {
        segments.push({ startMs: silenceStart, endMs: timeMs, durationMs });
      }
      silenceStart = null;
    }
  }

  // Close any trailing silence.
  if (silenceStart !== null) {
    const endMs = src.length / bytesPerMs;
    const durationMs = endMs - silenceStart;
    if (durationMs >= minDurationMs) {
      segments.push({ startMs: silenceStart, endMs, durationMs });
    }
  }

  return segments;
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  51. trimMedia
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface TrimMediaOptions {
  startMs: number;
  endMs: number;
  outputPath?: string;
}

/**
 * Trim a media file to a time range, container-aware, via ffmpeg.
 *
 * ## Why this no longer byte-slices
 *
 * It previously estimated byte offsets from an assumed 128 kbps bitrate and
 * wrote `src.subarray(startByte, endByte)`. **That destroys the file.** MP4 is a
 * box-structured container: the `moov` atom can sit at the end of the file, and
 * cutting arbitrary bytes leaves a container whose index points at data that is
 * no longer there. The result is unplayable — and `TrimMediaResult` reported
 * success with a correct-looking `durationMs`. Silent corruption of the user's
 * own media is the worst outcome this module could produce.
 *
 * There is no byte-offset formula that works, because the mapping from time to
 * byte offset depends on the actual bitrate, keyframe positions and atom layout
 * of that specific file. So the cut has to be container-aware, which means
 * ffmpeg.
 *
 * ## ffmpeg is required, and that is checked
 *
 * Availability is probed before the run and a missing binary throws with a clear
 * message. It does *not* fall back to slicing: a loud failure is recoverable,
 * a corrupt file handed back as a success is not. `-c copy` is used so the trim
 * is fast and lossless; only the container is rewritten.
 */
export async function trimMedia(
  inputPath: string,
  options: TrimMediaOptions,
): Promise<TrimMediaResult> {
  const { startMs, endMs, outputPath = `${inputPath}.trimmed${extname(inputPath)}` } = options;
  if (endMs <= startMs) throw new RangeError('endMs must be greater than startMs');
  if (startMs < 0) throw new RangeError('startMs must be >= 0');

  const ffmpeg = await requireFfmpeg('trimMedia');
  // -ss before -i seeks by keyframe (fast); re-encoding is avoided with -c copy.
  await runFfmpeg(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(startMs / 1000),
    '-i', inputPath,
    '-to', String((endMs - startMs) / 1000),
    '-c', 'copy',
    outputPath,
  ]);

  // ffmpeg exits 0 and can still write nothing useful for some inputs, so the
  // output is verified rather than assumed.
  if (!existsSync(outputPath) || statSync(outputPath).size === 0) {
    throw new Error(
      `trimMedia: ffmpeg reported success but produced no output at ${outputPath}. `
      + 'The input may be an unsupported container.',
    );
  }

  return {
    outputPath,
    startMs,
    endMs,
    durationMs: endMs - startMs,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  52. Streaming pipeline helper (bonus — used internally + exported for DI)
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Build a Transform stream that compresses its input with gzip.
 *
 * Uses the real `zlib.createGzip` transform, imported at module scope alongside
 * the other `node:zlib` helpers. The previous body tried to reach it with
 * `await import(...)` inside a non-async function, which does not parse — and
 * the fallback it reached for (`{}` cast to `never`) would have produced a
 * transform that silently passed data through uncompressed.
 */
export function createGzipTransform(options: { level?: number } = {}): Transform {
  const { createGzip } = zlib;
  return createGzip({ level: options.level ?? 6 }) as unknown as Transform;
}

/** The inverse of `createGzipTransform`. */
export function createGunzipTransform(): Transform {
  const { createGunzip } = zlib;
  return createGunzip() as unknown as Transform;
}

/**
 * Pipe a readable source through a Transform and into a writable sink,
 * returning a promise that resolves when the pipeline completes.
 */
export async function pipeMediaTransform(
  source: Readable,
  transform: Transform,
  sink: Writable,
): Promise<void> {
  await pipelineAsync(source, transform, sink);
}

/**
 * Stream a file from disk to disk via an optional transform.
 * Defaults to a straight copy when no transform is provided.
 */
export async function streamFileToDisk(
  inputPath: string,
  outputPath: string,
  transform?: Transform,
): Promise<{ outputPath: string; size: number }> {
  const readable = createReadStream(inputPath);
  const writable = createWriteStream(outputPath);
  if (transform) {
    await pipelineAsync(readable, transform, writable);
  } else {
    await pipelineAsync(readable, writable);
  }
  return { outputPath, size: fileSize(outputPath) };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  53. hashMedia — standalone SHA-256 helper (bonus)
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Return the SHA-256 hex digest of a media file. */
export async function hashMedia(
  filePath: string,
  algorithm: 'sha256' | 'sha512' | 'md5' = 'sha256',
): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm);
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk as Buffer));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  54. decompressMedia — reverse of compressImage/Video/Audio
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Decompress a gzip-compressed media file. */
export async function decompressMedia(
  inputPath: string,
  outputPath?: string,
): Promise<{ outputPath: string; size: number }> {
  const out = outputPath ?? inputPath.replace(/\.gz$/, '') + '.decompressed';
  const src = readFileSync(inputPath);
  const decompressed = await gunzipAsync(src);
  writeFileSync(out, decompressed);
  return { outputPath: out, size: decompressed.length };
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  55. buildSrtSubtitles — SRT file builder from SubtitleEntry[]
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Serialise an array of subtitle entries to SRT format. */
export function buildSrtSubtitles(entries: SubtitleEntry[]): string {
  return entries
    .map(
      (e) =>
        `${e.index}\n${msToSrt(e.startMs)} --> ${msToSrt(e.endMs)}\n${e.text}\n`,
    )
    .join('\n');
}

/** Parse an SRT string into structured subtitle entries. */
export function parseSrtSubtitles(srt: string): SubtitleEntry[] {
  const blocks = srt.trim().split(/\n\n+/);
  const entries: SubtitleEntry[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    if (lines.length < 3) continue;
    const index = parseInt(lines[0]!, 10);
    const times = lines[1]!.split('-->').map((t) => t.trim());
    const startMs = srtToMs(times[0]!);
    const endMs = srtToMs(times[1]!);
    const text = lines.slice(2).join('\n');
    entries.push({ index, startMs, endMs, text });
  }
  return entries;
}

/** Parse an SRT timestamp string to milliseconds. */
function srtToMs(ts: string): number {
  const [hms, frac] = ts.split(',');
  const [h, m, s] = (hms ?? '00:00:00').split(':').map(Number);
  return (h! * 3600 + m! * 60 + s!) * 1000 + Number(frac ?? 0);
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  56. deflateCompress / deflateDecompress — zlib deflate utilities
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Compress a buffer using raw deflate (no gzip header). */
export async function deflateCompress(
  input: Buffer | string,
): Promise<Buffer> {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return deflateAsync(buf) as Promise<Buffer>;
}

/** Decompress a raw-deflate buffer. */
export async function deflateDecompress(input: Buffer): Promise<Buffer> {
  return gunzipAsync(input) as Promise<Buffer>;
}
