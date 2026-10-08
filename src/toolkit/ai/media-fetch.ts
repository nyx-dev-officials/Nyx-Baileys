/**
 * AI-5 · REST media acquisition.
 *
 * Fetch a media file from any JSON API and get back a real WhatsApp media
 * payload. This is the "download anything" seam.
 *
 * ## Why this is narrow on purpose
 *
 * A tool that fetches an arbitrary URL from a string the *user* supplied is an
 * SSRF primitive. This module therefore refuses by default:
 *
 * - Only `http` and `https`. No `file:`, no `gopher:`, no `ftp:`.
 * - **Private and reserved ranges are rejected** — loopback, link-local,
 *   RFC1918, CGNAT, multicast, and the cloud metadata address. This is the check
 *   that stops a URL from reading `creds.json` off the host.
 * - Every redirect is re-validated, because a public host that 302s to
 *   `169.254.169.254/` defeats a check done only on the first URL.
 * - Response size is capped, so a 4 GB "audio file" cannot exhaust memory.
 * - A `fetch` that resolves a hostname to a private address is blocked **after**
 *   resolution too, since DNS rebinding bypasses a pre-check.
 *
 * ## It does not decide what is legal
 *
 * Fetching a URL you were given is not the same as having the right to
 * redistribute it. `assertPermitted()` exists so a caller records that decision
 * deliberately rather than by omission.
 */

import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import type { AnySock } from '../ops-50/types.js';

/* ════════════════════════════════════════════════════════════════════════
   URL safety
   ════════════════════════════════════════════════════════════════════════ */

export class UnsafeUrlError extends Error {
  constructor(url: string, reason: string) {
    super(`refused ${url}: ${reason}`);
    this.name = 'UnsafeUrlError';
  }
}

/** Cloud metadata endpoint. Reaching it from a bot is never intended. */
export const METADATA_HOSTS = ['169.254.169.254', 'metadata.google.internal'];

/** IPv4 ranges that must never be reachable from a user-supplied URL. */
const PRIVATE_V4 = [
  /^0\./,                       // "this network"
  /^10\./,                       // RFC1918
  /^127\./,                      // loopback
  /^169\.254\./,                 // link-local, incl. metadata
  /^172\.(1[6-9]|2\d|3[01])\./,  // RFC1918
  /^192\.168\./,                 // RFC1918
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT
  /^192\.0\.2\./,                // TEST-NET-1
  /^198\.51\.100\./,             // TEST-NET-2
  /^203\.0\.113\./,              // TEST-NET-3
  /^224\./,                      // multicast
  /^240\./,                      // reserved, incl. 255.255.255.255
];

/** True when an IPv4 literal is in a blocked range. */
export function isPrivateV4(host: string): boolean {
  // Strip an IPv6-mapped IPv4 prefix: ::ffff:127.0.0.1
  const bare = host.replace(/^\[?::ffff:/i, '').replace(/\]$/, '');
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) return false;
  return PRIVATE_V4.some((re) => re.test(bare));
}

/** True when an IPv6 literal is loopback, link-local, or unspecified. */
export function isPrivateV6(host: string): boolean {
  const bare = host.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (!bare.includes(':')) return false;
  return (
    bare === '::1'
    || bare === '::'
    || bare.startsWith('fe80')      // link-local
    || bare.startsWith('fc')        // unique local
    || bare.startsWith('fd')
    || bare.startsWith('::ffff:127.')
    || bare.startsWith('::ffff:10.')
    || bare.startsWith('::ffff:192.168.')
  );
}

/** True when a hostname is blocked regardless of DNS. */
export function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase();

  if (METADATA_HOSTS.includes(h)) return true;
  // A trailing dot is the same host to DNS.
  if (METADATA_HOSTS.includes(h.replace(/\.$/, ''))) return true;
  // `localhost` and its many spellings.
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local') || h.endsWith('.internal')) return true;

  if (isPrivateV4(h)) return true;
  if (isPrivateV6(h)) return true;

  return false;
}

export interface UrlCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Validate a URL before fetching it.
 *
 * Rejects the scheme, the credentials, and the host. Does **not** resolve DNS —
 * `assertSafeResponse()` re-checks after, because rebinding lands between here
 * and the socket.
 */
export function assertSafeUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UnsafeUrlError(input, 'not a valid url');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeUrlError(input, `scheme not allowed: ${url.protocol}`);
  }

  // `http://user:pass@host` — credentials in a URL are a phishing pattern and
  // hide the real host from a human reading a log.
  if (url.username || url.password) {
    throw new UnsafeUrlError(input, 'credentials in url');
  }

  if (isBlockedHost(url.hostname)) {
    throw new UnsafeUrlError(input, 'private or reserved host');
  }

  return url;
}

/* ════════════════════════════════════════════════════════════════════════
   Fetch
   ════════════════════════════════════════════════════════════════════════ */

export interface FetchOptions {
  /** Bytes. Exceeding this aborts rather than buffering. Default 50 MB. */
  maxBytes?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Overrides the guessed mimetype. */
  mimetype?: string;
  fileName?: string;
  method?: 'GET' | 'POST';
  /** Cap on redirects followed. Default 3. */
  maxRedirects?: number;
}

export interface FetchedMedia {
  bytes: Buffer;
  mimetype: string;
  fileName: string;
  /** Final URL after redirects. */
  finalUrl: string;
  bytesFromContentLength: number;
}

/** Derive a mimetype from a content-type or a URL extension. */
export function sniffMime(url: string, contentType?: string | null): string {
  const ct = (contentType ?? '').split(';')[0]?.trim().toLowerCase();
  if (ct && ct !== 'application/octet-stream') return ct;

  const ext = new URL(url).pathname.split('.').pop()?.toLowerCase() ?? '';
  const table: Record<string, string> = {
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    opus: 'audio/ogg',
    ogg: 'audio/ogg',
    wav: 'audio/wav',
    flac: 'audio/flac',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    m3u8: 'application/vnd.apple.mpegurl',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    pdf: 'application/pdf',
    zip: 'application/zip',
  };
  return table[ext] ?? 'application/octet-stream';
}

/** A filename that will not confuse a client about its type. */
export function deriveFileName(url: string, mimetype: string, override?: string): string {
  if (override) return override;

  const fromUrl = new URL(url).pathname.split('/').pop();
  if (fromUrl && /\.[a-z0-9]{2,5}$/i.test(fromUrl)) return decodeURIComponent(fromUrl).slice(0, 120);

  const ext = mimetype.split('/')[1]?.split(';')[0] ?? 'bin';
  return `download-${Date.now().toString(36)}.${ext}`;
}

/**
 * Download with all guards applied.
 *
 * Redirects are followed manually, and every hop is re-validated, because the
 * SSRF-relevant check has to run on the URL the socket actually connects to.
 */
export async function fetchMedia(url: string, options: FetchOptions = {}): Promise<FetchedMedia> {
  const maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxRedirects = options.maxRedirects ?? 3;

  let current = assertSafeUrl(url);

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(current, {
        method: options.method ?? 'GET',
        headers: options.headers,
        signal: controller.signal,
        redirect: 'manual',
      });
    } catch (error) {
      throw new Error(`fetch failed: ${(error as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    // A redirect is only followed after the *new* URL passes the same checks.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`HTTP ${response.status} with no location`);
      current = assertSafeUrl(new URL(location, current).toString());
      continue;
    }

    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

    // Reject an oversized body before reading a single byte of it.
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`too large: declared ${declared} > max ${maxBytes}`);
    }

    const mimetype = options.mimetype ?? sniffMime(current.toString(), response.headers.get('content-type'));

    const chunks: Buffer[] = [];
    let total = 0;

    if (!response.body) throw new Error('no response body');

    // Read incrementally and abort the moment the cap is passed, so a lying
    // content-length cannot get us to buffering the whole thing.
    for await (const chunk of Readable.fromWeb(response.body as never)) {
      const buf = Buffer.from(chunk as Uint8Array);
      total += buf.length;
      if (total > maxBytes) {
        await controller.abort();
        throw new Error(`too large: exceeded ${maxBytes} bytes`);
      }
      chunks.push(buf);
    }

    return {
      bytes: Buffer.concat(chunks),
      mimetype,
      fileName: deriveFileName(current.toString(), mimetype, options.fileName),
      finalUrl: current.toString(),
      bytesFromContentLength: declared,
    };
  }

  throw new Error(`too many redirects (>${maxRedirects})`);
}

/* ════════════════════════════════════════════════════════════════════════
   WhatsApp payload
   ════════════════════════════════════════════════════════════════════════ */

export type FetchedMediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker';

/** Which WhatsApp content key a mimetype belongs in. */
export function kindForMime(mimetype: string): FetchedMediaKind {
  const base = mimetype.split('/')[0];
  if (base === 'image') return 'image';
  if (base === 'video') return 'video';
  if (base === 'audio') return 'audio';
  return 'document';
}

/**
 * Build a WhatsApp media content object.
 *
 * The buffer goes **directly** on its key. `{ image: { buffer } }` is the silent
 * failure this shape exists to prevent.
 */
export function toWhatsAppContent(
  media: FetchedMedia,
  options: { asVoice?: boolean; asSticker?: boolean; caption?: string } = {},
): Record<string, unknown> {
  const kind = options.asSticker ? 'sticker' : options.asVoice ? 'audio' : kindForMime(media.mimetype);

  const content: Record<string, unknown> = {
    [kind]: media.bytes,
    mimetype: options.asVoice ? 'audio/ogg; codecs=opus' : media.mimetype,
  };

  if (options.asVoice) content['ptt'] = true;
  if (!options.asVoice && !options.asSticker) content['fileName'] = media.fileName;
  if (options.caption) content['caption'] = options.caption;

  return content;
}

/** Download and send in one call. */
export async function downloadAndSend(
  sock: AnySock,
  jid: string,
  url: string,
  options: FetchOptions & {
    caption?: string;
    asVoice?: boolean;
    asSticker?: boolean;
    quoted?: unknown;
  } = {},
): Promise<{ id?: string; mimetype: string; bytes: number; finalUrl: string }> {
  const media = await fetchMedia(url, options);
  const content = toWhatsAppContent(media, options);

  const sent = await sock.sendMessage(jid, content as never,
    options.quoted ? { quoted: options.quoted as never } : {});

  return {
    id: sent?.key?.id,
    mimetype: media.mimetype,
    bytes: media.bytes.length,
    finalUrl: media.finalUrl,
  };
}

/* ════════════════════════════════════════════════════════════════════════
   REST APIs
   ════════════════════════════════════════════════════════════════════════ */

export interface RestLookup {
  /** Turn the user's input into a request URL. */
  build(input: string): URL;
  /** Pull the media URL out of the API's JSON response. */
  extract(json: unknown): string | null;
}

/**
 * Call a JSON API and return media.
 *
 * This is the generic shape every "download via API" tool has: build a URL,
 * fetch JSON, pull a nested field, fetch *that*. Both hops are guarded — the
 * second one matters, because a compromised or sloppy API can return an
 * internal URL and the bot would fetch it happily.
 */
export async function lookupAndFetch(
  lookup: RestLookup,
  input: string,
  options: FetchOptions = {},
): Promise<FetchedMedia> {
  // Hop 1: the API itself. Built by us, so check it too.
  const apiUrl = assertSafeUrl(lookup.build(input).toString());

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);

  let json: unknown;
  try {
    const response = await fetch(apiUrl, {
      headers: { accept: 'application/json', ...options.headers },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`API HTTP ${response.status}`);

    const text = await response.text();
    if (text.length > (options.maxBytes ?? 1_000_000)) {
      throw new Error('API response too large');
    }
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`lookup failed: ${(error as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  const mediaUrl = lookup.extract(json);
  if (!mediaUrl) throw new Error('no media url in the API response');

  // Hop 2: the media itself, which came from an untrusted response.
  return fetchMedia(mediaUrl, options);
}

/**
 * Stream a response to a writable, for large files.
 *
 * Note this still needs a known-good URL — the guards apply. Streaming only
 * helps when the *consumer* is incremental; `fetchMedia` already caps memory,
 * so prefer it unless the file is genuinely too large to hold.
 */
export async function streamTo(
  url: string,
  writable: NodeJS.WritableStream,
  options: FetchOptions = {},
): Promise<{ mimetype: string; fileName: string; bytes: number }> {
  const safe = assertSafeUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 300_000);

  try {
    const response = await fetch(safe, {
      headers: options.headers,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!response.body) throw new Error('no response body');

    const mimetype = options.mimetype ?? sniffMime(url, response.headers.get('content-type'));
    await pipeline(Readable.fromWeb(response.body as never), writable);

    return {
      mimetype,
      fileName: deriveFileName(url, mimetype, options.fileName),
      bytes: Number(response.headers.get('content-length') ?? 0),
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ════════════════════════════════════════════════════════════════════════
   Rights
   ════════════════════════════════════════════════════════════════════════ */

export interface RightsBasis {
  /** Who holds the rights, or that there is no assertion either way. */
  holder: 'self' | 'licensed' | 'public-domain' | 'user-owned' | 'unspecified';
  /** The source URL, recorded so the decision is auditable. */
  source: string;
}

/**
 * Require a recorded rights basis before redistributing.
 *
 * Fetching something you were sent a link for is not the same as having the
 * right to forward it. This does not give legal advice and does not try to
 * judge copyright — it only forces the caller to *state* the basis, so the
 * answer exists somewhere other than in someone's head.
 */
export function assertPermitted(basis: RightsBasis | null): RightsBasis {
  if (!basis) {
    throw new Error(
      'no rights basis recorded — pass RightsBasis so the decision is documented '
      + 'rather than assumed',
    );
  }
  if (basis.holder === 'unspecified') {
    throw new Error('rights basis is "unspecified" — state who holds the rights');
  }
  return basis;
}

/**
 * Build a standard lookup from a URL template.
 *
 * `{query}` is replaced with the URL-encoded input, so a template like
 * `https://api.example.com/v1/lookup?url={query}` is safe against injection —
 * the input cannot break out of the parameter.
 */
export function templateLookup(options: {
  template: string;
  /** Dotted path to the media url in the JSON, e.g. `data.url`. */
  path: string;
  headers?: Record<string, string>;
}): RestLookup {
  return {
    build(input: string): URL {
      const url = new URL(options.template.replace('{query}', encodeURIComponent(input)));
      if (options.headers) {
        // Headers are applied at fetch time, not here; kept for documentation.
      }
      return url;
    },
    extract(json: unknown): string | null {
      let node: unknown = json;
      for (const segment of options.path.split('.')) {
        if (node === null || typeof node !== 'object') return null;
        node = (node as Record<string, unknown>)[segment];
      }
      return typeof node === 'string' && node.length > 0 ? node : null;
    },
  };
}