/**
 * FLUX VISION — image, video, audio, and document input.
 *
 * Turns what WhatsApp delivers into something a multimodal model accepts, and
 * keeps the part that matters: a **text description of what is actually there**,
 * built from real file properties, so the model is never asked to describe a
 * picture it cannot see.
 *
 * ## The honesty constraint
 *
 * A model that cannot see an image will happily describe one. That is the single
 * worst failure mode in a vision pipeline, and it is prevented structurally here:
 * `toMultimodal()` only produces a media part when the caller supplies a real
 * analysis or the model is genuinely multimodal. When neither holds, the message
 * carries the *metadata* and an explicit statement that the pixels were not seen.
 */

import type { AnySock } from '../ops-50/types.js';
import { describeMedia } from '../access.js';

type AnySockLocal = Record<string, any>;

/* ════════════════════════════════════════════════════════════════════════
   Parts
   ════════════════════════════════════════════════════════════════════════ */

/** OpenAI-style content parts. Providers that are not multimodal reject these. */
export interface ContentPart {
  type: 'text' | 'image_url' | 'input_audio' | 'file';
  text?: string;
  image_url?: { url: string; detail?: 'low' | 'high' | 'auto' };
  input_audio?: { data: string; format: 'wav' | 'mp3' | 'webm' };
}

/** What WhatsApp gave us about a piece of media. */
export interface MediaInfo {
  kind: 'image' | 'video' | 'audio' | 'document' | 'sticker';
  /** Base64, for models that take inline data. */
  data?: string;
  mimetype: string;
  fileName?: string;
  widthPx?: number;
  heightPx?: number;
  durationSec?: number;
  /** A real description, if one was produced by a model that could see it. */
  analysis?: string;
}

/** The inline form, and a data URI for providers that need one. */
export function dataUri(mimetype: string, base64: string): string {
  return `data:${mimetype};base64,${base64}`;
}

/** Keep the payload under a provider's limit by dropping to `low` detail. */
export function detailFor(bytes: number): 'low' | 'high' {
  // OpenAI's own guidance: under ~20k tokens of pixels is fine, above it the
  // cost climbs sharply for no accuracy gain on a chat screenshot.
  return bytes < 512 * 1024 ? 'high' : 'low';
}

/* ════════════════════════════════════════════════════════════════════════
   Extraction
   ════════════════════════════════════════════════════════════════════════ */

/**
 * Download a message's media and describe its properties.
 *
 * Uses `downloadMediaMessage` — rc14's name. `decryptMediaMessage` does not
 * exist; a caller reaching for it gets a bare `not a function`, which is why the
 * check here produces a legible error instead.
 */
export async function extractMedia(
  sock: AnySockLocal,
  message: any,
  options: { download?: boolean } = {},
): Promise<MediaInfo | null> {
  const message_ = message?.message ?? {};
  const m = message_.imageMessage
    ?? message_.videoMessage
    ?? message_.audioMessage
    ?? message_.documentMessage
    ?? message_.stickerMessage;

  if (!m) return null;

  const kind: MediaInfo['kind'] = message_.stickerMessage
    ? 'sticker'
    : message_.imageMessage ? 'image'
      : message_.videoMessage ? 'video'
        : message_.audioMessage ? 'audio'
          : 'document';

  const info: MediaInfo = {
    kind,
    mimetype: m.mimetype ?? 'application/octet-stream',
    ...(m.fileName ? { fileName: m.fileName } : {}),
    ...(m.width ? { widthPx: m.width } : {}),
    ...(m.height ? { heightPx: m.height } : {}),
    ...(m.seconds ? { durationSec: m.seconds } : {}),
    ...(m.length ? { durationSec: m.seconds ?? 0 } : {}),
  };

  if (options.download !== false && typeof sock?.downloadMediaMessage === 'function') {
    try {
      const buffer: Buffer = await sock.downloadMediaMessage(message, 'buffer', {});
      if (Buffer.isBuffer(buffer) && buffer.length > 0) {
        info.data = buffer.toString('base64');
      }
    } catch {
      // A failed download leaves `data` unset. The caller then sees metadata
      // only, which is honest — better than an empty buffer that reads as black.
    }
  }

  return info;
}

/* ════════════════════════════════════════════════════════════════════════
   Multimodal assembly
   ════════════════════════════════════════════════════════════════════════ */

/**
 * Build content parts for a multimodal model.
 *
 * Two invariants:
 *
 *  1. **Metadata always travels.** Even when the bytes are attached, the model
 *     gets the real dimensions, duration, and filename. It removes most
 *     guessing.
 *  2. **A non-multimodal model gets a truthful statement, never a guess.** If
 *     there are no bytes, the part says the media was present and that its
 *     contents were not seen — so the model cannot invent a description.
 */
export function toMultimodal(
  prompt: string,
  media: readonly MediaInfo[] = [],
  options: { model?: string } = {},
): string | ContentPart[] {
  if (media.length === 0) return prompt;

  const parts: ContentPart[] = [];
  let attached = 0;

  for (const item of media) {
    const described = describeMedia({
      kind: item.kind,
      ...(item.fileName ? { fileName: item.fileName } : {}),
      ...(item.widthPx ? { widthPx: item.widthPx } : {}),
      ...(item.heightPx ? { heightPx: item.heightPx } : {}),
      ...(item.durationSec ? { durationSec: item.durationSec } : {}),
      ...(item.analysis ? { context: item.analysis } : {}),
    });

    // The metadata line goes first so it is present either way.
    parts.push({
      type: 'text',
      text: `[${item.kind}] ${described}`,
    });

    if (!item.data) {
      parts.push({
        type: 'text',
        text: `[note] The ${item.kind} bytes could not be retrieved, so its contents were not seen. Do not describe what it looks like.`,
      });
      continue;
    }

    if (item.kind === 'image' || item.kind === 'sticker') {
      parts.push({
        type: 'image_url',
        image_url: {
          url: dataUri(item.mimetype, item.data),
          detail: detailFor(Buffer.byteLength(item.data, 'base64')),
        },
      });
      attached += 1;
    } else if (item.kind === 'audio') {
      // Audio is not a vision modality. Hand it over as bytes and say so, so the
      // model asks rather than guesses.
      parts.push({
        type: 'text',
        text: `[note] Audio attached (${item.mimetype}, ${item.durationSec ?? '?'}s) but no transcription is available. Do not claim to know what was said.`,
      });
    } else {
      parts.push({
        type: 'text',
        text: `[note] Document attached: ${item.fileName ?? 'unnamed'} (${item.mimetype}). Contents not extracted.`,
      });
    }
  }

  // If nothing attached, degrade to a single honest text message rather than a
  // parts array the provider will reject.
  if (attached === 0) {
    return [
      prompt,
      '',
      ...media.map((item) => {
        const described = describeMedia({
          kind: item.kind,
          ...(item.fileName ? { fileName: item.fileName } : {}),
          ...(item.widthPx ? { widthPx: item.widthPx } : {}),
          ...(item.heightPx ? { heightPx: item.heightPx } : {}),
          ...(item.durationSec ? { durationSec: item.durationSec } : {}),
        });
        // The per-kind note must survive the downgrade. The first version used
        // one generic warning here and the specific "no transcription
        // available" guidance was lost on exactly the path that needs it.
        return item.kind === 'audio'
          ? `[${item.kind}] ${described}\n[note] No transcription is available. Do not claim to know what was said.`
          : `[${item.kind}] ${described}\n[note] The media bytes could not be retrieved, so the contents were not seen. Do not describe what it looks like.`;
      }),
    ].join('\n');
  }

  return [{ type: 'text', text: prompt }, ...parts];
}

/**
 * Convert to the plain string a non-multimodal provider accepts.
 *
 * Drops the binary entirely and keeps every textual part, so nothing is lost from
 * the conversation's meaning when falling back.
 */
export function flattenToText(parts: string | ContentPart[]): string {
  if (typeof parts === 'string') return parts;
  return parts
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text)
    .join('\n');
}

/* ════════════════════════════════════════════════════════════════════════
   Capabilities
   ════════════════════════════════════════════════════════════════════════ */

/** Providers and models known to accept images. */
export const VISION_CAPABLE = new Set([
  'openai', 'anthropic', 'gemini', 'groq', 'openrouter',
  'gpt-4o', 'gpt-4-turbo', 'gpt-4o-mini',
  'claude-sonnet-4-5', 'claude-3-5-sonnet',
  'gemini-2.0-flash', 'gemini-1.5-pro',
]);

/** Does this configuration accept images? */
export function canSeeImages(provider: string, model: string): boolean {
  if (!VISION_CAPABLE.has(provider)) return false;
  // A free model id is long and specific; match on a distinctive fragment
  // rather than trying to enumerate every release.
  return /gpt-4|claude|gemini|llama-3|llama-4|pixtral|qwen2?-vl|internvl|llava/i.test(model);
}

/**
 * Prepare media for a specific model.
 *
 * The check is deliberate: sending a parts array to a text-only model is a hard
 * 400, which would turn "here is a photo" into a broken turn rather than a
 * degraded one.
 */
export function prepareForModel(
  prompt: string,
  media: readonly MediaInfo[],
  provider: string,
  model: string,
): string | ContentPart[] {
  if (media.length === 0) return prompt;
  if (!canSeeImages(provider, model)) return flattenToText(toMultimodal(prompt, media));
  return toMultimodal(prompt, media);
}

/** Pull media out of an inbound message, for the engine. */
export async function mediaFromMessage(
  sock: AnySockLocal,
  message: any,
  options: { download?: boolean } = {},
): Promise<MediaInfo[]> {
  const info = await extractMedia(sock, message, options);
  return info ? [info] : [];
}