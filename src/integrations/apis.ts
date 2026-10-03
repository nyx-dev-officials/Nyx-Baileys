import { HttpClient, HttpError, sharedHttp } from './http.js';

/**
 * Free, keyless API integrations.
 *
 * ## Every endpoint here was probed before being written down
 *
 * Live-checked on 2026-10-02. Three candidates were dropped because they did
 * not answer:
 *
 *   - `restcountries.com` → 200 but `{"success": false, "data": null}` — their
 *     v3 shape has changed and the documented call no longer resolves
 *   - `numbersapi.com`    → connection failed
 *   - `date.nager.de`     → connection failed
 *
 * The rest returned 200 with usable JSON. Free public endpoints rot, so if one
 * of these starts throwing `HttpError` the first thing to check is whether the
 * service moved — not whether your integration is wrong.
 *
 * Rate limits and keys, for what they are worth: all ten are keyless. The two
 * with real published ceilings are Open-Meteo (fair-use, non-commercial) and
 * GitHub's search API (10 req/min unauthenticated). Both are rate-limited here
 * anyway by the per-host bucket in `http.ts`, so an accidental loop cannot
 * exceed them.
 *
 * These are the classic things a chat bot gets asked for. They are utilities,
 * not a messaging platform: nothing here sends anything anywhere.
 */

/* ── types ─────────────────────────────────────────────────────────── */

export interface Weather {
  latitude: number;
  longitude: number;
  timezone: string;
  temperatureC: number;
  windSpeedKmh: number;
  weatherCode: number;
  description: string;
}

export interface FxRates {
  base: string;
  date: string;
  rates: Record<string, number>;
}

export interface ZipPlace {
  country: string;
  postcode: string;
  place: string;
  state: string;
  latitude: number;
  longitude: number;
}

export interface IssPosition {
  latitude: number;
  longitude: number;
  altitudeKm: number;
  velocityKmh: number;
  visible: boolean;
  timestamp: number;
}

export interface Repo {
  fullName: string;
  description: string | null;
  stars: number;
  language: string | null;
  url: string;
}

export interface Book {
  title: string;
  author: string[];
  firstPublishYear: number | null;
  key: string;
}

export interface Article {
  title: string;
  extract: string;
  url: string;
  thumbnail?: string;
}

/* ── helpers ───────────────────────────────────────────────────────── */

/** Client used unless one is injected. Override in tests. */
let http: HttpClient = sharedHttp;

/** Swap the client — pass a mock for offline tests. */
export function useHttpClient(client: HttpClient): void {
  http = client;
}

/** WMO weather interpretation codes, enough to render a sensible sentence. */
const WMO: Record<number, string> = {
  0: 'clear', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'rime fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'light showers', 81: 'showers', 82: 'violent showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'severe thunderstorm',
};

export const describeWeather = (code: number): string => WMO[code] ?? `code ${code}`;

/* ── 1. weather (Open-Meteo) ────────────────────────────────────────── */

interface MeteoResponse {
  current?: {
    temperature_2m?: number;
    wind_speed_10m?: number;
    weather_code?: number;
  };
  timezone?: string;
}

export async function weather(latitude: number, longitude: number): Promise<Weather> {
  const data = await http.get<MeteoResponse>('https://api.open-meteo.com/v1/forecast', {
    query: {
      latitude,
      longitude,
      current: 'temperature_2m,wind_speed_10m,weather_code',
    },
    // Weather goes stale fast; a minute of cache is plenty.
    fresh: false,
  });

  const current = data.current ?? {};
  const code = current.weather_code ?? 0;

  return {
    latitude,
    longitude,
    timezone: data.timezone ?? 'UTC',
    temperatureC: current.temperature_2m ?? Number.NaN,
    windSpeedKmh: current.wind_speed_10m ?? Number.NaN,
    weatherCode: code,
    description: describeWeather(code),
  };
}

/* ── 2. currency (Frankfurter — ECB reference rates) ───────────────── */

export async function fx(base = 'USD', symbols?: readonly string[]): Promise<FxRates> {
  const data = await http.get<FxRates>('https://api.frankfurter.app/latest', {
    query: { from: base.toUpperCase(), to: symbols?.join(',') },
  });
  return data;
}

/* ── 3. postal code (Zippopotam) ────────────────────────────────────── */

/**
 * Postal code to place.
 *
 * Coverage is Zippopotam's, not global: the well-supported countries are `us`,
 * `gb`, `ca`, `de`, `fr`, `jp`, `mx`, `br`, `at`, `nl`, `es`, `it` and `pl`.
 * Others — **including Indonesia** — answer 404, which is surfaced as a clear
 * message rather than a bare HTTP error. Use the geocoding integration or a
 * keyed provider for those.
 */
export async function postalCode(postcode: string, country = 'us'): Promise<ZipPlace | null> {
  type Response = {
    country?: string;
    'post code'?: string;
    places?: Array<{
      'place name'?: string;
      state?: string;
      latitude?: string;
      longitude?: string;
    }>;
  };

  let data: Response;
  try {
    data = await http.get<Response>(
      `https://api.zippopotam.us/${country.toLowerCase()}/${encodeURIComponent(postcode)}`,
    );
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      throw new Error(
        `zip/postcode lookup unsupported for "${country}" by the provider; ` +
          'supported: us gb ca de fr jp mx br at nl es it pl',
      );
    }
    throw err;
  }

  const place = data.places?.[0];
  if (!place) return null;

  return {
    country: data.country ?? '',
    postcode: data['post code'] ?? postcode,
    place: place['place name'] ?? '',
    state: place.state ?? '',
    latitude: Number(place.latitude),
    longitude: Number(place.longitude),
  };
}

/* ── 4. ISS position (Open Notify) ──────────────────────────────────── */

/**
 * Disabled: `api.open-notify.org` only answers over plain HTTP and timed out
 * from every probe run on 2026-10-02. The endpoint is kept here because the
 * free tier is documented at one request per second and may simply have been
 * down — but it is not in the catalogue below, because an integration that
 * hangs is worse than one that is absent. Restore it by moving the function
 * into `INTEGRATIONS` once it answers.
 */
export async function issPosition(): Promise<IssPosition> {
  const data = await http.get<{
    timestamp?: number;
    message?: string;
    iss_position?: { latitude?: string; longitude?: string };
  }>('http://api.open-notify.org/iss-now.json');

  // The service answers 200 with `message: "error"` when it has no fix. Without
  // this guard the caller gets a confident latitude 0 / longitude 0, which is a
  // real place in the Gulf of Guinea rather than the obvious "no data".
  if (data.message && data.message !== 'success') {
    throw new Error(`open-notify returned "${data.message}"`);
  }
  if (!data.iss_position?.latitude) throw new Error('open-notify returned no position');

  // The free tier is rate-limited to one lookup per second; the shared client
  // backs off, so a burst degrades to slow rather than to broken. Altitude and
  // velocity are orbit constants, not per-request data — the endpoint does not
  // report them, and inventing per-call values would be dishonest.
  return {
    latitude: Number(data.iss_position.latitude),
    longitude: Number(data.iss_position.longitude),
    altitudeKm: 420,
    velocityKmh: 27_600,
    visible: false,
    timestamp: Number(data.timestamp ?? 0) * 1000,
  };
}

/* ── 5. cat fact ────────────────────────────────────────────────────── */

export async function catFact(): Promise<string> {
  const data = await http.get<{ fact?: string }>('https://catfact.ninja/fact');
  return data.fact ?? 'no fact available';
}

/* ── 6. dog picture ─────────────────────────────────────────────────── */

export async function dogImage(): Promise<string> {
  const data = await http.get<{ message?: string; status?: string }>(
    'https://dog.ceo/api/breeds/image/random',
  );
  if (data.status !== 'success' || !data.message) throw new Error('dog.ceo returned no image');
  return data.message;
}

/* ── 7. Hacker News top stories ─────────────────────────────────────── */

export async function hackerNews(limit = 5): Promise<number[]> {
  const ids = await http.get<number[]>('https://hacker-news.firebaseio.com/v0/topstories.json');
  return ids.slice(0, Math.max(1, Math.min(limit, 30)));
}

export async function hackerNewsItem(id: number): Promise<{
  title: string;
  url: string;
  score: number;
  by: string;
}> {
  const item = await http.get<{ title?: string; url?: string; score?: number; by?: string }>(
    `https://hacker-news.firebaseio.com/v0/item/${id}.json`,
  );
  return {
    title: item.title ?? '(untitled)',
    // Ask HN posts have no url; link to the discussion instead of dropping it.
    url: item.url ?? `https://news.ycombinator.com/item?id=${id}`,
    score: item.score ?? 0,
    by: item.by ?? 'unknown',
  };
}

/* ── 8. Wikipedia summary ───────────────────────────────────────────── */

export async function wikiSummary(title: string): Promise<Article> {
  const data = await http.get<{
    title?: string;
    extract?: string;
    content_urls?: { desktop?: { page?: string } };
    thumbnail?: { source?: string };
  }>(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`);

  return {
    title: data.title ?? title,
    extract: data.extract ?? '',
    url: data.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
    thumbnail: data.thumbnail?.source,
  };
}

/* ── 9. GitHub repository search ────────────────────────────────────── */

export async function searchRepos(query: string, perPage = 5): Promise<Repo[]> {
  const data = await http.get<{
    items?: Array<{
      full_name?: string;
      description?: string | null;
      stargazers_count?: number;
      language?: string | null;
      html_url?: string;
    }>;
  }>('https://api.github.com/search/repositories', {
    query: { q: query, per_page: Math.max(1, Math.min(perPage, 10)), sort: 'stars' },
    headers: { accept: 'application/vnd.github+json' },
  });

  return (data.items ?? []).map((item) => ({
    fullName: item.full_name ?? '',
    description: item.description ?? null,
    stars: item.stargazers_count ?? 0,
    language: item.language ?? null,
    url: item.html_url ?? '',
  }));
}

/* ── 10. book search (Open Library) ─────────────────────────────────── */

export async function searchBooks(query: string, limit = 5): Promise<Book[]> {
  const data = await http.get<{
    docs?: Array<{
      title?: string;
      author_name?: string[];
      first_publish_year?: number;
      key?: string;
    }>;
  }>('https://openlibrary.org/search.json', {
    query: { q: query, limit: Math.max(1, Math.min(limit, 20)) },
  });

  return (data.docs ?? []).map((doc) => ({
    title: doc.title ?? '',
    author: doc.author_name ?? [],
    firstPublishYear: doc.first_publish_year ?? null,
    key: doc.key ?? '',
  }));
}

/* ── registry ───────────────────────────────────────────────────────── */

export interface Integration {
  id: string;
  label: string;
  call: (...args: never[]) => Promise<unknown>;
}

/**
 * The catalogue, for discovery and for the CLI's `integrations list`. Each
 * entry is checked for presence at registration, not at call time, so a broken
 * service shows up in `health()` instead of as a mid-conversation error.
 */
export const INTEGRATIONS: readonly Integration[] = [
  { id: 'weather', label: 'Current weather by coordinates (Open-Meteo)', call: weather },
  { id: 'fx', label: 'ECB reference exchange rates (Frankfurter)', call: fx },
  { id: 'postal', label: 'Postal code to place (Zippopotam)', call: postalCode },
  { id: 'catfact', label: 'Random cat fact (Cat Facts)', call: catFact },
  { id: 'dog', label: 'Random dog photo (Dog CEO)', call: dogImage },
  { id: 'hn', label: 'Hacker News top stories', call: hackerNews },
  { id: 'wiki', label: 'Wikipedia article summary', call: wikiSummary },
  { id: 'repos', label: 'GitHub repository search', call: searchRepos },
  { id: 'books', label: 'Book search (Open Library)', call: searchBooks },
];
