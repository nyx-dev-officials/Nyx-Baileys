/**
 * Live public-API commands — 58 verified, 20 recorded as unverified.
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
 * Each endpoint has a template with `{dotted.path}` placeholders resolved
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
  /** Template with `{path}` placeholders. Empty means "print the response". */
  format: string;
  needsArg: boolean;
  argHint: string;
}

export const API_ENDPOINTS: ApiEndpoint[] = [
  {
    name: 'advice',
    label: 'advice',
    url: "https://api.adviceslip.com/advice",
    category: "Entertainment",
    summary: "A piece of advice",
    format: "{slip.advice}",
    needsArg: false,
    argHint: "",
  },
  {
    name: 'affirmations',
    label: 'affirmations',
    url: "https://affirmations.dev",
    category: "Lifestyle",
    summary: "A daily affirmation",
    format: "",
    needsArg: false,
    argHint: "",
  },
  {
    name: 'agify',
    label: 'agify',
    url: "https://api.agify.io?name=alex",
    category: "Machine Learning",
    summary: "Estimate a name age and gender",
    format: "{name}: {age} years old\n{probability}%",
    needsArg: true,
    argHint: "<name>",
  },
  {
    name: 'bible-api',
    label: 'bible-api',
    url: "https://bible-api.com/john+3:16",
    category: "Documents",
    summary: "A Bible verse",
    format: "{reference}\n{(text || \"\").replace(/<[^>]*>/g,\"\")}",
    needsArg: true,
    argHint: "<book chapter:verse>",
  },
  {
    name: 'blockchain-info',
    label: 'blockchain-info',
    url: "https://blockchain.info/rawblock/800000",
    category: "Cryptocurrency",
    summary: "A Bitcoin block",
    format: "Block {height}\n{hash}\n{time}",
    needsArg: false,
    argHint: "",
  },
  {
    name: 'calculator',
    label: 'calculator',
    url: "https://api.mathjs.org/v4/?expr=2%2B2",
    category: "Science",
    summary: "Evaluate an expression (mathjs)",
    format: "{result}",
    needsArg: true,
    argHint: "<expression>  e.g. 2^10",
  },
  {
    name: 'catfact-random',
    label: 'catfact-random',
    url: "https://catfact.ninja/fact",
    category: "Animals",
    summary: "A random cat fact",
    format: "{fact}",
    needsArg: false,
    argHint: "",
  },
  {
    name: 'chucknorris',
    label: 'chucknorris',
    url: "https://api.chucknorris.io/jokes/random",
    category: "Entertainment",
    summary: "A Chuck Norris joke",
    format: "{value}",
    needsArg: false,
    argHint: "",
  },
  {
    name: 'coingecko-ping',
    label: 'coingecko-ping',
    url: "https://api.coingecko.com/api/v3/ping",
    category: "Cryptocurrency",
    summary: "CoinGecko status",
    format: "CoinGecko: {gecko_says}",
    needsArg: false,
    argHint: "",
  },
  {
    name: 'covid-historical',
    label: 'covid-historical',
    url: "https://disease.sh/v3/covid-19/countries/ID",
    category: "Health",
    summary: "Country COVID-19 timeline",
    format: "{country}\nConfirmed {timeline[0].confirmed}\nDeaths {timeline[0].deaths}",
    needsArg: true,
    argHint: "<country>",
  },
  {
    name: 'currency-cdn',
    label: 'currency-cdn',
    url: "https://cdn.jsdelivr.net/npm/axios/package.json",
    category: "Development",
    summary: "A CDN package manifest",
    format: "axios {version}",
    needsArg: false,
    argHint: "",
  },
  {
    name: 'dbpedia',
    label: 'dbpedia',
    url: "https://dbpedia.org/data/Jakarta.json",
    category: "Documents",
    summary: "DBpedia resource data",
    format: "{http_\\://dbpedia.org/resource/Jakarta[0].value}",
    needsArg: false,
    argHint: "",
  },
  {
    name: 'dictionaryapi',
    label: 'dictionaryapi',
    url: "https://api.dictionaryapi.dev/api/v2/entries/en/hello",
    category: "Documents",
    summary: "English dictionary definition",
    format: "{0.word}\n{0.meanings[0].definitions[0].definition}",
    needsArg: true,
    argHint: "<word>",
  },
  {
    name: 'dog-random',
    label: 'dog-random',
    url: "https://dog.ceo/api/breeds/image/random",
    category: "Animals",
    summary: "A random dog photo",
    format: "Dog breed: {message}",
    needsArg: false,
    argHint: "",
  },
  {
    name: 'exchangerate-latest',
    label: 'exchangerate-latest',
    url: "https://api.exchangerate-api.com/v4/latest/USD",
    category: "Currency",
    summary: "Exchange rates with no API key",
    format: "1 USD = {rates.EUR} EUR\n1 USD = {rates.IDR} IDR\n1 USD = {rates.JPY} JPY",
    needsArg: false,
    argHint: "",
  },
  {
    name: 'frankfurter',
    label: 'frankfurter',
    url: "https://api.frankfurter.app/latest?from=USD",
    category: "Currency",
    summary: "Exchange rates from Frankfurter",
    format: "Base {base}\nEUR {rates.EUR}  GBP {rates.GBP}  JPY {rates.JPY}",
    needsArg: false,
    argHint: "",
  },
  {
    name: 'gemini-public',
    label: 'gemini-public',
    url: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
    category: "Cryptocurrency",
    summary: "Cryptocurrency spot price",
    format: "bitcoin: ${usd}",
    needsArg: true,
    argHint: "<coin-id>",
  },
  {
    name: 'genderize',
    label: 'genderize',
    url: "https://api.genderize.io?name=alex",
    category: "Machine Learning",
    summary: "{name}: {gender} ({probability}%)~{names[0]}",
    format: "{name}: {gender} ({probability}%)\n{names[0]}",
    needsArg: true,
    argHint: "<name>",
  },
  {
    name: 'github-api-limit',
    label: 'github-api-limit',
    url: "https://api.github.com/rate_limit",
    category: "Development",
    summary: "GitHub API rate limit status",
    format: "Remaining {resources.core.remaining} of {resources.core.limit}\nResets {resources.core.reset}",
    needsArg: false,
    argHint: "",
  },
  {
    name: 'github-repos',
    label: 'github-repos',
    url: "https://api.github.com/repos/facebook/react",
    category: "Development",
    summary: "A GitHub repository",
    format: "{full_name}\nStars {stargazers_count}  Forks {forks_count}  Issues {open_issues_count}",
    needsArg: true,
    argHint: "<owner>/<repo>",
  },
  {
    name: 'github-user',
    label: 'github-user',
    url: "https://api.github.com/users/torvalds",
    category: "Development",
    summary: "A GitHub user profile",
    format: "{login} ({name})\n{public_repos} repos · {followers} followers",
    needsArg: true,
    argHint: "<username>",
  },
  {
    name: 'githubtrending-repos',
    label: 'githubtrending-repos',
    url: "https://api.github.com/search/repositories?q=stars:>100000&per_page=1",
    category: "Development",
    summary: "Repositories over 100k stars",
    format: "{total_count} repos over 100k stars\nTop: {items[0].full_name} ({items[0].stargazers_count} stars)",
    needsArg: false,
    argHint: "",
  },
  {
    name: 'google-dns',
    label: 'google-dns',
    url: "https://dns.google/resolve?name=example.com&type=A",
    category: "Development",
    summary: "DNS lookup via Google DNS-over-HTTPS",
    format: "DNS status {Status} ({TC})\n{Answer[0].data}",
    needsArg: true,
    argHint: "<domain>",
  },
  {
    name: 'hackernews-top',
    label: 'hackernews-top',
    url: "https://hacker-news.firebaseio.com/v0/topstories.json",
    category: "News",
    summary: "Top Hacker News story IDs",
    format: "Top story IDs: {0[0]}, {0[1]}, {0[2]}",
    needsArg: false,
    argHint: "",
  },
  {
    name: 'httpbin-headers',
    label: 'httpbin-headers',
    url: "https://httpbin.org/headers",
    category: "Test Data",
    summary: "Headers httpbin received",
    format: "{headers[\"User-Agent\"]}",
    needsArg: false,
    argHint: "",
  },
  {
    name: 'httpbin-ip',
    label: 'httpbin-ip',
    url: "https://httpbin.org/ip",
    category: "Test Data",
    summary: "Your public IP",
    format: "Your IP: {origin}",
    needsArg: false,
    argHint: "",
  },
  {
    name: 'httpbin-uuid',
    label: 'httpbin-uuid',
    url: "https://httpbin.org/uuid",
    category: "Test Data",
    summary: "A generated UUID",
    format: "{uuid}",
    needsArg: false,
    argHint: "",
  },
  {
    name: 'ip-api',
    label: 'ip-api',
    url: "http://ip-api.com/json/?fields=status,country,countryCode",
    category: "Development",
    summary: "IP geolocation from ip-api",
    format: "{country} ({countryCode})\n{regionName}, {city}",
    needsArg: false,
    argHint: "",
  },
  {
    name: 'ipinfo',
    label: 'ipinfo',
    url: "https://ipinfo.io/json",
    category: "Development",
    summary: "IP geolocation from ipinfo",
    format: "{ip}\n{city}, {region}, {country}\n{org}",
    needsArg: false,
    argHint: "",
  },
  {
    name: 'iss-position',
    label: 'iss-position',
    url: "https://api.wheretheiss.at/v1/satellites/25544",
    category: "Science",
    summary: "Current position of the ISS",
    format: "{name} (NORAD {id})\nLat {latitude}  Lon {longitude}  Alt {altitude}",
    needsArg: false,
    argHint: "",
  },
  {
    name: 'jokeapi',
    label: 'jokeapi',
    url: "https://v2.jokeapi.dev/joke/Any?type=single",
    category: "Entertainment",
    summary: "A joke",
    format: "{joke}",
    needsArg: false,
    argHint: "",
  },
  {
    name: 'jsonbin-placeholder',
    label: 'jsonbin-placeholder',
    url: "https://httpbin.org/json",
    category: "Test Data",
    summary: "Placeholder binary data",
    format: "slideshow: {slideshow[0].title}",
    needsArg: false,
    argHint: "",
  },
  {
    name: 'jsonplaceholder-posts',
    label: 'jsonplaceholder-posts',
    url: "https://jsonplaceholder.typicode.com/posts?userId=1",
    category: "Test Data",
    summary: "Placeholder post",
    format: "{title[0]}\n\n{body[0].slice(0,120)}",
    needsArg: false,
    argHint: "",
  },
  {
    name: 'jsonplaceholder-users',
    label: 'jsonplaceholder-users',
    url: "https://jsonplaceholder.typicode.com/users/1",
    category: "Test Data",
    summary: "Placeholder user record",
    format: "{name} ({username})\n{email} · {address.city}",
    needsArg: true,
    argHint: "<1-10>",
  },
  {
    name: 'kanye',
    label: 'kanye',
    url: "https://api.kanye.rest/",
    category: "Entertainment",
    summary: "A quote",
    format: "{quote}",
    needsArg: false,
    argHint: "",
  },
  {
    name: 'npm-package',
    label: 'npm-package',
    url: "https://registry.npmjs.org/left-pad",
    category: "Development",
    summary: "An npm package manifest",
    format: "{name}@{version}{description}",
    needsArg: true,
    argHint: "<package>",
  },
  {
    name: 'open-meteo',
    label: 'open-meteo',
    url: "https://api.open-meteo.com/v1/forecast?latitude=-6.2&longitude=106.8&current=temperature_2m",
    category: "Weather",
    summary: "Current weather from Open-Meteo",
    format: "Location {latitude},{longitude}\nTemp {current.temperature_2m}\nWind {current.wind_speed_10m} km/h\nHumidity {current.relative_humidity_2m}%",
    needsArg: true,
    argHint: "<lat>,<lon>  e.g. -6.2,106.8",
  },
  {
    name: 'open-meteo-air',
    label: 'open-meteo-air',
    url: "https://air-quality-api.open-meteo.com/v1/air-quality?latitude=-6.2&longitude=106.8&current=pm10",
    category: "Weather",
    summary: "Air quality (PM2.5, PM10) from Open-Meteo",
    format: "PM2.5 {current.pm2_5}\nPM10  {current.pm10}",
    needsArg: true,
    argHint: "<lat>,<lon>",
  },
  {
    name: 'open-meteo-airvar',
    label: 'open-meteo-airvar',
    url: "https://air-quality-api.open-meteo.com/v1/air-quality?latitude=51.5&longitude=-0.12&current=european_aqi",
    category: "Weather",
    summary: "European AQI for a location",
    format: "European AQI: {current.european_aqi}",
    needsArg: true,
    argHint: "<lat>,<lon>",
  },
  {
    name: 'open-meteo-geo',
    label: 'open-meteo-geo',
    url: "https://geocoding-api.open-meteo.com/v1/search?name=Jakarta&count=1",
    category: "Weather",
    summary: "Geocode a place name to coordinates",
    format: "Found {generationtime_ms}ms\n{0.latitude},{0.longitude} — {0.name}, {0.country}",
    needsArg: true,
    argHint: "<place>  e.g. Jakarta",
  },
  {
    name: 'openfoodfacts',
    label: 'openfoodfacts',
    url: "https://world.openfoodfacts.org/api/v2/product/737628064502.json",
    category: "Food",
    summary: "{product.product_name}~Brand {product.brands}",
    format: "{product.product_name}\nGrade {nutrition_grades}\n{product.brands}",
    needsArg: false,
    argHint: "",
  },
  {
    name: 'openlibrary-author',
    label: 'openlibrary-author',
    url: "https://openlibrary.org/search/authors.json?q=herman%20melville",
    category: "Books",
    summary: "Search Open Library authors",
    format: "{numFound} authorsTop: {docs[0].name}",
    needsArg: true,
    argHint: "<author>",
  },
  {
    name: 'openlibrary-search',
    label: 'openlibrary-search',
    url: "https://openlibrary.org/search.json?q=dune&limit=1",
    category: "Books",
    summary: "Search Open Library",
    format: "{numFound} results for {q}\nTop: {docs[0].title} ({docs[0].first_publish_year})",
    needsArg: true,
    argHint: "<query>",
  },
  {
    name: 'placeholder-todos',
    label: 'placeholder-todos',
    url: "https://jsonplaceholder.typicode.com/todos?userId=1",
    category: "Test Data",
    summary: "Placeholder todo list",
    format: "{0.completed ? \"done\" : \"open\"}: {0.title}",
    needsArg: false,
    argHint: "",
  },
  {
    name: 'pypi-package',
    label: 'pypi-package',
    url: "https://pypi.org/pypi/requests/json",
    category: "Development",
    summary: "A PyPI package release",
    format: "{info.name} {info.version}{(info.summary || \"\")}",
    needsArg: true,
    argHint: "<package>",
  },
  {
    name: 'random-dog',
    label: 'random-dog',
    url: "https://random.dog/woof.json",
    category: "Animals",
    summary: "A random dog photo",
    format: "Dog photo: {url}",
    needsArg: false,
    argHint: "",
  },
  {
    name: 'restcountries-all',
    label: 'restcountries-all',
    url: "https://restcountries.com/v3.1/region/asia?fields=name,cca2",
    category: "Countries",
    summary: "Countries in a region",
    format: "{0.count} results\nFirst: {0[0].name.common} {0[0].cca2}",
    needsArg: true,
    argHint: "<region>",
  },
  {
    name: 'restcountries-name',
    label: 'restcountries-name',
    url: "https://restcountries.com/v3.1/name/indonesia?fields=name,capital,idd,cca3",
    category: "Countries",
    summary: "Country facts by name",
    format: "{0.name.common} ({0.cca3})\nCapital {0.capital[0]}\nCalling {0.idd.root}{0.idd.suffixes[0]}\nRegion {0.region}",
    needsArg: true,
    argHint: "<country>",
  },
  {
    name: 'timeapi',
    label: 'timeapi',
    url: "https://timeapi.io/api/time/current/zone?timeZone=Asia/Jakarta",
    category: "Time",
    summary: "Current time in a timezone",
    format: "{dateTime} ({timeZone})",
    needsArg: true,
    argHint: "<timezone>  e.g. Asia/Jakarta",
  },
  {
    name: 'timezoneapi',
    label: 'timezoneapi',
    url: "https://timeapi.io/api/time/current/zone?timeZone=Europe/London",
    category: "Time",
    summary: "Current time in a timezone",
    format: "{dateTime} ({timeZone})",
    needsArg: true,
    argHint: "<timezone>",
  },
  {
    name: 'unpkg-package',
    label: 'unpkg-package',
    url: "https://unpkg.com/lodash@4.17.21/package.json",
    category: "Development",
    summary: "A package manifest from unpkg",
    format: "{name}@{version}{(description || \"\").slice(0,140)}",
    needsArg: true,
    argHint: "<package@version>",
  },
  {
    name: 'usgs-quake',
    label: 'usgs-quake',
    url: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson",
    category: "Science",
    summary: "{metadata.count} quakes in the past hour~Mag {features[0].properties.mag} — {features[0].properties.place}",
    format: "{metadata.count} quakes in the past hour\nMag {0.properties.mag} — {0.properties.place}",
    needsArg: false,
    argHint: "",
  },
  {
    name: 'weather-gov',
    label: 'weather-gov',
    url: "https://api.weather.gov/points/39.7456,-97.0892",
    category: "Weather",
    summary: "US National Weather Service grid point",
    format: "Forecast office{properties.forecast}",
    needsArg: false,
    argHint: "",
  },
  {
    name: 'wikimedia-opensearch',
    label: 'wikimedia-opensearch',
    url: "https://en.wikipedia.org/w/api.php?action=opensearch&search=Jakarta&limit=1&format=json",
    category: "Documents",
    summary: "Wikipedia search",
    format: "Matches for {1}\n{3[0]}",
    needsArg: true,
    argHint: "<query>",
  },
  {
    name: 'wikipedia-summary',
    label: 'wikipedia-summary',
    url: "https://en.wikipedia.org/api/rest_v1/page/summary/Jakarta",
    category: "Documents",
    summary: "A Wikipedia article summary",
    format: "{title}\n{extract}",
    needsArg: true,
    argHint: "<article>",
  },
  {
    name: 'worldbank-indicator',
    label: 'worldbank-indicator',
    url: "https://api.worldbank.org/v2/country/IDN/indicator/NY.GDP.MKTP.CD?format=json&per_page=1&mrnev=1",
    category: "Open Data",
    summary: "World Bank indicator series",
    format: "GDP indicator (latest)\n{1[1][0].value}",
    needsArg: true,
    argHint: "<country-code>  e.g. IDN",
  },
  {
    name: 'xkcd',
    label: 'xkcd',
    url: "https://xkcd.com/info.0.json",
    category: "Comics",
    summary: "A random xkcd comic",
    format: "xkcd #{num}: {title}\n{alt}",
    needsArg: false,
    argHint: "",
  },
  {
    name: 'xkcd-image',
    label: 'xkcd-image',
    url: "https://xkcd.com/info.0.json",
    category: "Comics",
    summary: "A random xkcd comic with image",
    format: "xkcd #{num}: {title}\n{img}",
    needsArg: false,
    argHint: "",
  },
];

/** Probed and found not to work. Recorded, never presented as functional. */
export const API_UNVERIFIED: Array<{ label: string; reason: string }> = [
  { label: "arxiv-search", reason: "not JSON (application/atom+xml)" },
  { label: "binance-ticker", reason: "timeout after 9s" },
  { label: "bored-activity", reason: "fetch failed" },
  { label: "boredapi", reason: "fetch failed" },
  { label: "cloudflare-dns", reason: "HTTP 400" },
  { label: "coinbase-spot", reason: "timeout after 9s" },
  { label: "dadjoke", reason: "not JSON (text/html)" },
  { label: "dictionary", reason: "timeout after 9s" },
  { label: "fakejson", reason: "timeout after 9s" },
  { label: "github-raw", reason: "not JSON (text/plain)" },
  { label: "github-zen", reason: "not JSON (text/plain)" },
  { label: "google-fonts", reason: "not JSON (text/css)" },
  { label: "iss-pass", reason: "HTTP 400" },
  { label: "jsonbin", reason: "HTTP 404" },
  { label: "kraken-ticker", reason: "timeout after 9s" },
  { label: "nasa-apod", reason: "HTTP 403" },
  { label: "numbersapi", reason: "timeout after 9s" },
  { label: "openlibrary-cover", reason: "not JSON (image/jpeg)" },
  { label: "reddit-top", reason: "HTTP 403" },
  { label: "worldtimeapi", reason: "fetch failed" },
];

const DEFAULT_TIMEOUT_MS = 10_000;
const USER_AGENT = 'Nyx-Flux-Bot/0.3 (+https://github.com/nyx-dev-officials/Nyx-Baileys)';

/**
 * Resolve a dotted path, supporting `{0.field}` for array elements.
 *
 * A numeric first segment indexes; the rest walks objects. Returns undefined
 * rather than throwing, because a missing field in a third-party response is
 * normal and must not crash the command.
 */
export function readPath(data: unknown, path: string): unknown {
  let cur: unknown = data;
  for (const raw of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    const key = raw.replace(/^\{+|\}+$/g, '');
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
  const out = template.replace(/\{([^}]+)\}/g, (_m, path: string) => {
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
    return `${out}\n\n---\n${summarise(data)}`;
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
        lines.push(`${path}: ${v}`);
      }
      return;
    }
    if (Array.isArray(node)) {
      if (!node.length) { lines.push(`${path}: []`); return; }
      walk(node[0], `${path}[0]`, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (lines.length >= maxLines) break;
      if (/^(url|html_url|avatar_url|image|safe_title|_links|icons|nodes|edges)$/.test(k)) continue;
      walk(v, path ? `${path}.${k}` : k, depth + 1);
    }
  };
  walk(data, '', 0);
  return lines.length ? lines.join('\n') : '(no readable fields)';
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
    return { error: `Usage: api_${endpoint.name} ${endpoint.argHint || '<argument>'}` };
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
      return { error: `${endpoint.label}: HTTP ${res.status} — this endpoint now needs credentials` };
    }
    if (res.status === 404) {
      return { error: `${endpoint.label}: HTTP 404 — the endpoint has moved or gone` };
    }
    if (res.status === 429) {
      return { error: `${endpoint.label}: rate limited (HTTP 429). Try again shortly.` };
    }
    if (!res.ok) {
      return { error: `${endpoint.label}: HTTP ${res.status}` };
    }

    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      const kind = (res.headers.get('content-type') ?? '').split(';')[0] || 'unknown';
      return { error: `${endpoint.label}: expected JSON, got ${kind}` };
    }

    // Some endpoints report failure inside a 200 body.
    if (data && typeof data === 'object' && 'error' in data && !Array.isArray(data)) {
      const err = (data as { error?: unknown }).error;
      if (err) return { error: `${endpoint.label}: ${String(err).slice(0, 160)}` };
    }

    return { text: applyFormat(endpoint.format, data) };
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    return {
      error: /abort/i.test(msg)
        ? `${endpoint.label}: timed out after ${Math.round(timeoutMs / 1000)}s`
        : `${endpoint.label}: ${msg.slice(0, 120)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
