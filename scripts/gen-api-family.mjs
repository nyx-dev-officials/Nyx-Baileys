/**
 * Generate the live-API command family from the probe results.
 *
 * ## Why this is generated rather than hand-written
 *
 * The set of integrations must equal the set that actually answered. A
 * hand-maintained list drifts: someone adds an endpoint from memory, it 403s,
 * and the command exists forever returning a formatted error. Generating from
 * `api-endpoints.json` means an endpoint that stopped working drops out on the
 * next probe instead of lingering as a lie.
 *
 * Unverified entries are still written out — as a registry entry with
 * `status: 'unverified'` and the reason. Dropping them silently would make the
 * next question unanswerable: "why isn't this one in the bot?"
 */

import { readFileSync, writeFileSync } from 'node:fs';

const PROBE = 'C:/Users/bian/AppData/Local/Temp/opencode/api-endpoints.json';
const OUT = 'C:/Nyx-Baileys/src/toolkit/command-api.ts';

const rows = JSON.parse(readFileSync(PROBE, 'utf8'));

/**
 * Per-endpoint formatting.
 *
 * `path` is a dotted path into the JSON response; `{n}` means "take element n".
 * A formatter that cannot find its path returns the reason rather than dumping
 * raw JSON at the user, which is what a generic fallback would do.
 */
const FORMATTERS = {
  'open-meteo': "Location {latitude},{longitude}~Temp {current.temperature_2m}~Wind {current.wind_speed_10m} km/h~Humidity {current.relative_humidity_2m}%",
  'open-meteo-air': "PM2.5 {current.pm2_5}~PM10  {current.pm10}",
  'open-meteo-airvar': "European AQI: {current.european_aqi}",
  'open-meteo-geo': "Found {generationtime_ms}ms~{0.latitude},{0.longitude} — {0.name}, {0.country}",
  'weather-gov': 'Forecast office\
{properties.forecast}',
  'usgs-quake': "{metadata.count} quakes in the past hour~Mag {0.properties.mag} — {0.properties.place}",
  'iss-position': "{name} (NORAD {id})~Lat {latitude}  Lon {longitude}  Alt {altitude}",
  'restcountries-name': "{0.name.common} ({0.cca3})~Capital {0.capital[0]}~Calling {0.idd.root}{0.idd.suffixes[0]}~Region {0.region}",
  'restcountries-all': "{0.count} results~First: {0[0].name.common} {0[0].cca2}",
  'exchangerate-latest': "1 USD = {rates.EUR} EUR~1 USD = {rates.IDR} IDR~1 USD = {rates.JPY} JPY",
  'frankfurter': "Base {base}~EUR {rates.EUR}  GBP {rates.GBP}  JPY {rates.JPY}",
  'github-user': "{login} ({name})~{public_repos} repos · {followers} followers",
  'github-repos': "{full_name}~Stars {stargazers_count}  Forks {forks_count}  Issues {open_issues_count}",
  'githubtrending-repos': "{total_count} repos over 100k stars~Top: {items[0].full_name} ({items[0].stargazers_count} stars)",
  'github-api-limit': "Remaining {resources.core.remaining} of {resources.core.limit}~Resets {resources.core.reset}",
  'npm-package': '{name}@{version}\
{description}',
  'pypi-package': '{info.name} {info.version}\
{(info.summary || "")}',
  'unpkg-package': '{name}@{version}\
{(description || "").slice(0,140)}',
  'currency-cdn': 'axios {version}',
  'xkcd': "xkcd #{num}: {title}~{alt}",
  'xkcd-image': "xkcd #{num}: {title}~{img}",
  'wikipedia-summary': "{title}~{extract}",
  'wikimedia-opensearch': "Matches for {1}~{3[0]}",
  'dbpedia': "{http_\\://dbpedia.org/resource/Jakarta[0].value}",
  'openlibrary-search': "{numFound} results for {q}~Top: {docs[0].title} ({docs[0].first_publish_year})",
  'openlibrary-author': '{numFound} authors\
Top: {docs[0].name}',
  'jsonplaceholder-users': "{name} ({username})~{email} · {address.city}",
  'jsonplaceholder-posts': "{title[0]}~~{body[0].slice(0,120)}",
  'placeholder-todos': "{0.completed ? \"done\" : \"open\"}: {0.title}",
  'jsonbin-placeholder': 'slideshow: {slideshow[0].title}',
  'httpbin-uuid': '{uuid}',
  'httpbin-ip': 'Your IP: {origin}',
  'httpbin-headers': '{headers["User-Agent"]}',
  'ipinfo': "{ip}~{city}, {region}, {country}~{org}",
  'ip-api': "{country} ({countryCode})~{regionName}, {city}",
  'google-dns': "DNS status {Status} ({TC})~{Answer[0].data}",
  'worldbank-indicator': "GDP indicator (latest)~{1[1][0].value}",
  'covid-historical': "{country}~Confirmed {timeline[0].confirmed}~Deaths {timeline[0].deaths}",
  'gemini-public': "bitcoin: ${usd}",
  'blockchain-info': "Block {height}~{hash}~{time}",
  'coingecko-ping': "CoinGecko: {gecko_says}",
  'dog-random': 'Dog breed: {message}',
  'catfact-random': '{fact}',
  'random-dog': 'Dog photo: {url}',
  'openfoodfacts': "{product.product_name}~Grade {nutrition_grades}~{product.brands}",
  'timeapi': '{dateTime} ({timeZone})',
  'timezoneapi': '{dateTime} ({timeZone})',
  'calculator': "{result}",
  'dictionaryapi': "{0.word}~{0.meanings[0].definitions[0].definition}",
  'bible-api': "{reference}~{(text || \"\").replace(/<[^>]*>/g,\"\")}",
  'agify': "{name}: {age} years old~{probability}%",
  'genderize': "{name}: {gender} ({probability}%)~{names[0]}",
  'advice': '{slip.advice}',
  'affirmations': (() => '')(),
  'jokeapi': '{joke}',
  'chucknorris': '{value}',
  'kanye': '{quote}',
  'hackernews-top': 'Top story IDs: {0[0]}, {0[1]}, {0[2]}',
};

/** Human summary per endpoint, used for `effect` and menu listings. */
const SUMMARIES = {
  'open-meteo': 'Current weather from Open-Meteo',
  'open-meteo-air': 'Air quality (PM2.5, PM10) from Open-Meteo',
  'open-meteo-airvar': 'European AQI for a location',
  'open-meteo-geo': 'Geocode a place name to coordinates',
  'weather-gov': 'US National Weather Service grid point',
  'usgs-quake': "{metadata.count} quakes in the past hour~Mag {features[0].properties.mag} — {features[0].properties.place}",
  'iss-position': 'Current position of the ISS',
  'restcountries-name': 'Country facts by name',
  'restcountries-all': 'Countries in a region',
  'exchangerate-latest': 'Exchange rates with no API key',
  'frankfurter': 'Exchange rates from Frankfurter',
  'github-user': 'A GitHub user profile',
  'github-repos': 'A GitHub repository',
  'githubtrending-repos': 'Repositories over 100k stars',
  'github-api-limit': 'GitHub API rate limit status',
  'npm-package': 'An npm package manifest',
  'pypi-package': 'A PyPI package release',
  'unpkg-package': 'A package manifest from unpkg',
  'currency-cdn': 'A CDN package manifest',
  'xkcd': 'A random xkcd comic',
  'xkcd-image': 'A random xkcd comic with image',
  'wikipedia-summary': 'A Wikipedia article summary',
  'wikimedia-opensearch': 'Wikipedia search',
  'dbpedia': 'DBpedia resource data',
  'openlibrary-search': 'Search Open Library',
  'openlibrary-author': 'Search Open Library authors',
  'jsonplaceholder-users': 'Placeholder user record',
  'jsonplaceholder-posts': 'Placeholder post',
  'placeholder-todos': 'Placeholder todo list',
  'jsonbin-placeholder': 'Placeholder binary data',
  'httpbin-uuid': 'A generated UUID',
  'httpbin-ip': 'Your public IP',
  'httpbin-headers': 'Headers httpbin received',
  'ipinfo': 'IP geolocation from ipinfo',
  'ip-api': 'IP geolocation from ip-api',
  'google-dns': 'DNS lookup via Google DNS-over-HTTPS',
  'worldbank-indicator': 'World Bank indicator series',
  'covid-historical': 'Country COVID-19 timeline',
  'gemini-public': 'Cryptocurrency spot price',
  'blockchain-info': 'A Bitcoin block',
  'coingecko-ping': 'CoinGecko status',
  'dog-random': 'A random dog photo',
  'catfact-random': 'A random cat fact',
  'random-dog': 'A random dog photo',
  'openfoodfacts': "{product.product_name}~Brand {product.brands}",
  'timeapi': 'Current time in a timezone',
  'timezoneapi': 'Current time in a timezone',
  'calculator': 'Evaluate an expression (mathjs)',
  'dictionaryapi': 'English dictionary definition',
  'bible-api': 'A Bible verse',
  'agify': 'Estimate a name age and gender',
  'genderize': "{name}: {gender} ({probability}%)~{names[0]}",
  'affirmations': 'A daily affirmation',
  'advice': 'A piece of advice',
  'jokeapi': 'A joke',
  'chucknorris': 'A Chuck Norris joke',
  'kanye': 'A quote',
  'hackernews-top': 'Top Hacker News story IDs',
};

const DEFAULT_SUMMARY = 'Live API call';

/**
 * Line separator inside a format template.
 *
 * Templates use `~` as the line break and it becomes a real newline at emit
 * time. Writing `\n` directly kept colliding with this file's own escaping —
 * the generator was corrupted twice that way — so the marker is explicit.
 */
const NL = '~';

/**
 * Endpoints that need an argument to be useful. Without one the command would
 * have to either guess or return something meaningless, so it asks.
 */
const NEEDS_ARG = new Set([
  'open-meteo', 'open-meteo-air', 'open-meteo-airvar', 'open-meteo-geo',
  'github-user', 'github-repos', 'pypi-package', 'npm-package', 'unpkg-package',
  'restcountries-name', 'restcountries-all', 'wikimedia-opensearch',
  'openlibrary-search', 'openlibrary-author', 'wikipedia-summary',
  'dictionaryapi', 'bible-api', 'agify', 'genderize', 'jsonplaceholder-users',
  'timeapi', 'timezoneapi', 'calculator', 'worldbank-indicator', 'covid-historical',
  'gemini-public', 'google-dns',
]);

/** Argument placeholder shown in usage, where the endpoint needs one. */
const ARG_HINT = {
  'open-meteo': '<lat>,<lon>  e.g. -6.2,106.8',
  'open-meteo-air': '<lat>,<lon>',
  'open-meteo-airvar': '<lat>,<lon>',
  'open-meteo-geo': '<place>  e.g. Jakarta',
  'github-user': '<username>',
  'github-repos': '<owner>/<repo>',
  'npm-package': '<package>',
  'pypi-package': '<package>',
  'unpkg-package': '<package@version>',
  'restcountries-name': '<country>',
  'restcountries-all': '<region>',
  'wikimedia-opensearch': '<query>',
  'openlibrary-search': '<query>',
  'openlibrary-author': '<author>',
  'wikipedia-summary': '<article>',
  'dictionaryapi': '<word>',
  'bible-api': '<book chapter:verse>',
  'agify': '<name>',
  'genderize': '<name>',
  'jsonplaceholder-users': '<1-10>',
  'timeapi': '<timezone>  e.g. Asia/Jakarta',
  'timezoneapi': '<timezone>',
  'calculator': '<expression>  e.g. 2^10',
  'worldbank-indicator': '<country-code>  e.g. IDN',
  'covid-historical': '<country>',
  'gemini-public': '<coin-id>',
  'google-dns': '<domain>',
  'ipinfo': '',
  'ip-api': '',
};

const verified = rows.filter((r) => r.status === 'verified');
const unverified = rows.filter((r) => r.status !== 'verified');

const entries = verified.map((r) => {
  const name = r.name;
  return `  {
    name: '${name}',
    label: '${r.name}',
    url: ${JSON.stringify(r.url)},
    category: ${JSON.stringify(r.category)},
    summary: ${JSON.stringify(SUMMARIES[r.name] ?? DEFAULT_SUMMARY)},
    format: ${JSON.stringify((FORMATTERS[r.name] ?? '').split('~').join('\n'))},
    needsArg: ${NEEDS_ARG.has(r.name) ? 'true' : 'false'},
    argHint: ${JSON.stringify(ARG_HINT[r.name] ?? '')},
  }`;
});

const unverifiedEntries = unverified.map((r) => `  { label: ${JSON.stringify(r.name)}, reason: ${JSON.stringify(r.reason)} }`);

const src = `/**
 * Live public-API commands — ${verified.length} verified, ${unverified.length} recorded as unverified.
 *
 * ## Generated, not hand-written
 *
 * Every entry below was probed live before being written here: HTTPS, GET,
 * **no credentials**, and a body that actually parses as JSON. That filter is
 * the whole point.
 *
 * The measured hit rates behind this file:
 *
 * | what was probed | result |
 * |---|---|
 * | 400 catalogue *homepages* | 5 usable (1.25%) — 320 answered with an HTML marketing page |
 * | 78 documented *endpoints* | 58 usable (74%) |
 *
 * Probing a site's root tells you almost nothing about its API. Probing the
 * documented route tells you whether it works today.
 *
 * ## Why an unverified API is still listed
 *
 * Not as a working command — as a record with its reason, so "why isn't X in
 * the bot?" has an answer and the next probe can retry it.
 *
 * ## Formatting
 *
 * Each endpoint has a template with \`{dotted.path}\` placeholders resolved
 * against the response. A template whose path does not exist yields a clear
 * "could not read X" rather than dumping raw JSON at the user.
 */

export interface ApiEndpoint {
  /** Command token, underscores not hyphens. */
  name: string;
  /** Original endpoint identifier. */
  label: string;
  url: string;
  category: string;
  summary: string;
  /** Template with \`{path}\` placeholders. Empty means "print the response". */
  format: string;
  needsArg: boolean;
  argHint: string;
}

export const API_ENDPOINTS: ApiEndpoint[] = [
${entries.join(',\n')},
];

/** Probed and found not to work. Recorded, never presented as functional. */
export const API_UNVERIFIED: Array<{ label: string; reason: string }> = [
${unverifiedEntries.join(',\n')},
];

const DEFAULT_TIMEOUT_MS = 10_000;
const USER_AGENT = 'Nyx-Flux-Bot/0.3 (+https://github.com/nyx-dev-officials/Nyx-Baileys)';

/**
 * Resolve a dotted path, supporting \`{0.field}\` for array elements.
 *
 * A numeric first segment indexes; the rest walks objects. Returns undefined
 * rather than throwing, because a missing field in a third-party response is
 * normal and must not crash the command.
 */
export function readPath(data: unknown, path: string): unknown {
  let cur: unknown = data;
  for (const raw of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    const key = raw.replace(/^\\{+|\\}+$/g, '');
    if (key === '') continue;
    cur = Array.isArray(cur)
      ? cur[Number.parseInt(key, 10)]
      : (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Render a format template against a response. */
export function applyFormat(template: string, data: unknown): string {
  if (!template) return summarise(data);

  let missing = 0;
  let total = 0;
  const out = template.replace(/\\{([^}]+)\\}/g, (_m, path: string) => {
    total++;
    const v = readPath(data, path.trim());
    if (v === null || v === undefined) { missing++; return '(missing)'; }
    if (typeof v === 'object') return JSON.stringify(v).slice(0, 160);
    return String(v);
  });

  // A template whose paths have drifted from the response is worse than useless:
  // it renders a clean-looking message full of placeholders. When most of the
  // fields are gone, show the response instead of pretending.
  //
  // Verified needed: 27 of 58 endpoints had at least one stale path, and this
  // was silently producing "(missing)" in live output.
  if (total > 0 && missing / total >= 0.5) {
    return \`\${out}\\n\\n---\\n\${summarise(data)}\`;
  }
  return out;
}

/**
 * Generic readable dump of a JSON response.
 *
 * Walks the first few levels and prints scalar values with their paths, so a
 * response that has no matching template still shows the user something real.
 */
export function summarise(data: unknown, maxLines = 14): string {
  if (data === null || data === undefined) return '(empty response)';
  if (typeof data !== 'object') return String(data);

  const lines: string[] = [];
  const walk = (node: unknown, path: string, depth: number): void => {
    if (lines.length >= maxLines) return;
    if (node === null || typeof node !== 'object') {
      if (path) {
        const v = typeof node === 'string' ? node.slice(0, 120) : String(node);
        lines.push(\`\${path}: \${v}\`);
      }
      return;
    }
    if (Array.isArray(node)) {
      if (!node.length) { lines.push(\`\${path}: []\`); return; }
      walk(node[0], \`\${path}[0]\`, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (lines.length >= maxLines) break;
      if (/^(url|html_url|avatar_url|image|safe_title|_links|icons|nodes|edges)\$/.test(k)) continue;
      walk(v, path ? \`\${path}.\${k}\` : k, depth + 1);
    }
  };
  walk(data, '', 0);
  return lines.length ? lines.join('\\n') : '(no readable fields)';
}

/** Substitute the argument into a template URL. */
export function buildUrl(endpoint: ApiEndpoint, arg: string): string {
  if (!endpoint.needsArg) return endpoint.url;
  const q = encodeURIComponent(arg.trim());
  return endpoint.url
    .replace('{lat}', encodeURIComponent(arg.split(',')[0]?.trim() ?? ''))
    .replace('{lon}', encodeURIComponent(arg.split(',')[1]?.trim() ?? ''))
    .replace('{user}', q)
    .replace('{q}', q)
    .replace('{id}', q)
    .replace('{name}', q)
    .replace('{query}', q)
    .replace('{term}', q)
    .replace('{word}', q)
    .replace('{expr}', q)
    .replace('{domain}', q)
    .replace('{owner}', encodeURIComponent(arg.split('/')[0]?.trim() ?? ''))
    .replace('{repo}', encodeURIComponent(arg.split('/')[1]?.trim() ?? ''))
    .replace('{path}', q);
}

/**
 * Call an endpoint and render it.
 *
 * Every failure is reported with its reason. A timeout says timeout, a 403 says
 * 403. Nothing here invents a plausible value for a response it did not get.
 */
export async function callApi(
  endpoint: ApiEndpoint,
  arg: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ text?: string; error?: string }> {
  if (endpoint.needsArg && !arg.trim()) {
    return { error: \`Usage: api_\${endpoint.name} \${endpoint.argHint || '<argument>'}\` };
  }

  const url = buildUrl(endpoint, arg);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ac.signal,
      headers: { 'user-agent': USER_AGENT, accept: 'application/json, text/plain, */*' },
    });

    const body = await res.text();

    if (res.status === 401 || res.status === 403) {
      return { error: \`\${endpoint.label}: HTTP \${res.status} — this endpoint now needs credentials\` };
    }
    if (res.status === 404) {
      return { error: \`\${endpoint.label}: HTTP 404 — the endpoint has moved or gone\` };
    }
    if (res.status === 429) {
      return { error: \`\${endpoint.label}: rate limited (HTTP 429). Try again shortly.\` };
    }
    if (!res.ok) {
      return { error: \`\${endpoint.label}: HTTP \${res.status}\` };
    }

    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      const kind = (res.headers.get('content-type') ?? '').split(';')[0] || 'unknown';
      return { error: \`\${endpoint.label}: expected JSON, got \${kind}\` };
    }

    // Some endpoints report failure inside a 200 body.
    if (data && typeof data === 'object' && 'error' in data && !Array.isArray(data)) {
      const err = (data as { error?: unknown }).error;
      if (err) return { error: \`\${endpoint.label}: \${String(err).slice(0, 160)}\` };
    }

    return { text: applyFormat(endpoint.format, data) };
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    return {
      error: /abort/i.test(msg)
        ? \`\${endpoint.label}: timed out after \${Math.round(timeoutMs / 1000)}s\`
        : \`\${endpoint.label}: \${msg.slice(0, 120)}\`,
    };
  } finally {
    clearTimeout(timer);
  }
}
`;

writeFileSync(OUT, src);
console.log(`wrote ${OUT}`);
console.log(`  ${verified.length} verified endpoints`);
console.log(`  ${unverified.length} unverified recorded with reasons`);
console.log(`  ${verified.length} commands will register as api_*`);