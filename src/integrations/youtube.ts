import { HttpClient, sharedHttp } from './http.js';

/**
 * YouTube, keyless.
 *
 * The Data API v3 needs a key, so this uses the two endpoints that don't:
 *
 *   - **oEmbed** (`youtube.com/oembed`) — metadata for one known video.
 *   - **Channel RSS** (`youtube.com/feeds/videos.xml`) — the latest uploads for
 *     a channel. Public, documented, and no quota.
 *
 * Both were probed live before being written down. There is no keyless search —
 * that requires the Data API — so `searchVideos` is deliberately absent rather
 * than faked through an Invidious instance whose availability is anyone's
 * guess.
 *
 * The RSS feed accepts a `channel_id` or a legacy `user` name. Modern `@handle`
 * URLs are resolved by reading the channel page for its id, which is scraping
 * and therefore explicitly opt-in and cached — see `resolveChannelId`.
 */

let http: HttpClient = sharedHttp;

export function useYouTubeClient(client: HttpClient): void {
  http = client;
}

/* ── types ─────────────────────────────────────────────────────────── */

export interface VideoInfo {
  videoId: string;
  title: string;
  author: string;
  authorUrl?: string;
  thumbnail: string;
  url: string;
}

export interface Video {
  videoId: string;
  title: string;
  channel: string;
  publishedAt: string;
  url: string;
  thumbnail: string;
}

/* ── helpers ───────────────────────────────────────────────────────── */

const WATCH_ID = /[?&]v=([\w-]{11})/;
const HANDLE = /(?:youtube\.com|youtu\.be)\/@([\w.\-]+)/;
const CHANNEL_PATH = /youtube\.com\/channel\/(UC[\w-]{22})/;
const USER_PATH = /youtube\.com\/(?:user|c|@)\/([\w.\-]+)/;

/**
 * Pull a video id out of any of the shapes YouTube hands out: a watch URL, a
 * youtu.be short link, an embed URL, or a bare id.
 */
export function extractVideoId(input: string): string | null {
  const trimmed = input.trim();

  if (/^[\w-]{11}$/.test(trimmed)) return trimmed;

  // youtu.be/<id>
  const short = /^https?:\/\/youtu\.be\/([\w-]{11})/.exec(trimmed);
  if (short?.[1]) return short[1];

  const watch = WATCH_ID.exec(trimmed);
  if (watch?.[1]) return watch[1];

  // /embed/<id> and /shorts/<id>
  const path = /\/(?:embed|shorts|v|live)\/([\w-]{11})/.exec(trimmed);
  if (path?.[1]) return path[1];

  return null;
}

/** Strip tags and resolve the XML entities YouTube uses in titles. */
function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, '')
    .trim();
}

/* ── 1. oEmbed: metadata for one video ─────────────────────────────── */

export async function video(urlOrId: string): Promise<VideoInfo> {
  const id = extractVideoId(urlOrId);
  if (!id) throw new Error(`not a YouTube video URL or id: ${urlOrUrl(urlOrId)}`);

  const data = await http.get<{
    title?: string;
    author_name?: string;
    author_url?: string;
    thumbnail_url?: string;
  }>('https://www.youtube.com/oembed', {
    query: { url: `https://www.youtube.com/watch?v=${id}`, format: 'json' },
  });

  if (!data.title) {
    // oEmbed answers 400 for private, age-restricted or removed videos. The
    // message reaches the user as-is, which is more useful than "unknown".
    throw new Error(`YouTube metadata unavailable for ${id} (private, restricted, or removed)`);
  }

  return {
    videoId: id,
    title: data.title,
    author: data.author_name ?? 'unknown',
    authorUrl: data.author_url,
    thumbnail: data.thumbnail_url ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    url: `https://www.youtube.com/watch?v=${id}`,
  };
}

/* ── 2. channel RSS: latest uploads ─────────────────────────────────── */

/**
 * Latest uploads for a channel.
 *
 * `target` accepts a channel id (`UC…`), a legacy `user` name, or a channel
 * URL. @handles go through `resolveChannelId`.
 */
export async function latestVideos(target: string, limit = 5): Promise<Video[]> {
  const ref = await resolveChannelRef(target);
  if (!ref) throw new Error(`could not resolve a channel from: ${urlOrUrl(target)}`);

  const feed = await http.get<string>('https://www.youtube.com/feeds/videos.xml', {
    query: { [ref.kind]: ref.id },
  });

  const videos = parseFeed(feed);
  if (videos.length === 0) {
    throw new Error(`no uploads found for ${ref.id} (via ${ref.kind})`);
  }
  return videos.slice(0, Math.max(1, Math.min(limit, 15)));
}

/**
 * Parse the Atom feed into videos.
 *
 * Exported because it is pure and worth testing against a fixture — the regex
 * approach is only safe because the feed shape is fixed and tiny, and that is
 * exactly the kind of assumption a test should pin down.
 */
export function parseFeed(xml: string): Video[] {
  const entries = xml.split(/<entry[\s>]/).slice(1);
  const videos: Video[] = [];

  for (const block of entries) {
    const id = /<yt:videoId>([\w-]+)<\/yt:videoId>/.exec(block)?.[1];
    if (!id) continue;

    const title = /<title>([\s\S]*?)<\/title>/.exec(block)?.[1] ?? '';
    const channel = /<author>[\s\S]*?<name>([\s\S]*?)<\/name>/.exec(block)?.[1] ?? '';
    const published = /<published>([^<]+)<\/published>/.exec(block)?.[1] ?? '';
    const thumb =
      /<media:thumbnail[^>]*url="([^"]+)"/.exec(block)?.[1] ??
      `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

    videos.push({
      videoId: id,
      title: decodeXml(title),
      channel: decodeXml(channel),
      publishedAt: published,
      url: `https://www.youtube.com/watch?v=${id}`,
      thumbnail: thumb,
    });
  }

  return videos;
}

/* ── 3. channel resolution ──────────────────────────────────────────── */

/**
 * Resolve any channel reference to a feed-identifying tuple.
 *
 * The RSS endpoint distinguishes its two parameters: a `UC…` id goes in
 * `channel_id`, a legacy username goes in `user`. They are not interchangeable —
 * passing a username as `channel_id` returns an empty feed, which looks like a
 * channel with no uploads. So the resolved *kind* travels with the value.
 *
 * @handles are not accepted by the endpoint at all, so the channel page is read
 * and the id pulled from its bootstrap JSON. That is scraping a public page:
 * it works today, it is cached by the shared client, and it is behind an
 * explicit switch rather than a default.
 */
export interface ChannelRef {
  id: string;
  kind: 'channel_id' | 'user';
}

export async function resolveChannelRef(
  target: string,
  options: { allowHandleLookup?: boolean } = {},
): Promise<ChannelRef | null> {
  const trimmed = target.trim();

  if (/^UC[\w-]{22}$/.test(trimmed)) return { id: trimmed, kind: 'channel_id' };

  const fromPath = CHANNEL_PATH.exec(trimmed)?.[1];
  if (fromPath) return { id: fromPath, kind: 'channel_id' };

  // A legacy username only counts if it is not itself a @handle.
  const user = USER_PATH.exec(trimmed)?.[1];
  if (user && !user.startsWith('@')) return { id: user, kind: 'user' };

  const handle = HANDLE.exec(trimmed)?.[1] ?? (trimmed.startsWith('@') ? trimmed.slice(1) : null);
  if (!handle) {
    // A bare token that is not a channel id and not a URL: try it as a legacy
    // username. Those are the only bare identifiers YouTube still resolves, and
    // the RSS endpoint answers `user=` for them. If the feed comes back empty
    // the caller gets "no uploads found", which is the honest answer.
    if (/^[\w.\-]{3,}$/.test(trimmed) && !trimmed.includes('/')) {
      return { id: trimmed, kind: 'user' };
    }
    return null;
  }
  if (options.allowHandleLookup === false) return null;

  try {
    const page = await http.get<string>(`https://www.youtube.com/@${encodeURIComponent(handle)}`);
    // Present in the page's bootstrap JSON; the alternate `channelId` key is
    // checked because the layout has carried both spellings.
    const id =
      /"channelId"\s*:\s*"(UC[\w-]{22})"/.exec(page)?.[1] ??
      /"externalId"\s*:\s*"(UC[\w-]{22})"/.exec(page)?.[1];
    return id ? { id, kind: 'channel_id' } : null;
  } catch {
    // A handle we cannot resolve is a normal outcome, not an error worth
    // propagating — the caller reports "channel not found".
    return null;
  }
}

/** Convenience wrapper for callers that only want the id. */
export async function resolveChannelId(
  target: string,
  options: { allowHandleLookup?: boolean } = {},
): Promise<string | null> {
  return (await resolveChannelRef(target, options))?.id ?? null;
}

function urlOrUrl(s: string): string {
  return s.length <= 60 ? s : `${s.slice(0, 60)}…`;
}

/* ── catalogue ─────────────────────────────────────────────────────── */

export interface YoutubeIntegration {
  id: string;
  label: string;
  call: (...args: never[]) => Promise<unknown>;
}

export const YOUTUBE_INTEGRATIONS: readonly YoutubeIntegration[] = [
  { id: 'yt:video', label: 'Video metadata via oEmbed (no key)', call: video },
  { id: 'yt:latest', label: 'Latest channel uploads via RSS (no key)', call: latestVideos },
  { id: 'yt:channel', label: 'Resolve a channel/handle to its id', call: resolveChannelId },
];
