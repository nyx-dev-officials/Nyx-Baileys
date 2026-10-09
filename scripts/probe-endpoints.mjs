/**
 * Probe specific documented endpoints for well-known keyless APIs.
 *
 * ## Why this pass exists
 *
 * The first probe hit 400 catalogue *homepages* and found 5 usable endpoints.
 * That is a 1.25% hit rate and it is a measurement of the wrong thing: these
 * services publish their endpoint at a path (`/users/1`, `/v3/holiday`), so
 * probing the site root gets a marketing page and answers "reachable but not
 * JSON" for almost everything.
 *
 * So this pass asks the only question that matters — does this *endpoint*
 * return parseable JSON with no credentials — against endpoints with documented
 * routes, rather than guessing paths on arbitrary domains.
 *
 * Each entry records the route that was tried, so a failure is diagnosable
 * instead of being a mystery.
 */

import { writeFileSync } from 'node:fs';

const OUT = 'C:/Users/bian/AppData/Local/Temp/opencode/api-endpoints.json';

/** name, url, category, and what a good response contains. */
const ENDPOINTS = [
  ['jsonplaceholder-users', 'https://jsonplaceholder.typicode.com/users/1', 'Test Data'],
  ['httpbin-uuid', 'https://httpbin.org/uuid', 'Test Data'],
  ['httpbin-ip', 'https://httpbin.org/ip', 'Test Data'],
  ['dog-random', 'https://dog.ceo/api/breeds/image/random', 'Animals'],
  ['catfact-random', 'https://catfact.ninja/fact', 'Animals'],
  ['random-dog', 'https://random.dog/woof.json', 'Animals'],
  ['xkcd', 'https://xkcd.com/info.0.json', 'Comics'],
  ['github-user', 'https://api.github.com/users/torvalds', 'Development'],
  ['github-repos', 'https://api.github.com/repos/facebook/react', 'Development'],
  ['npm-package', 'https://registry.npmjs.org/left-pad', 'Development'],
  ['pypi-package', 'https://pypi.org/pypi/requests/json', 'Development'],
  ['open-meteo', 'https://api.open-meteo.com/v1/forecast?latitude=-6.2&longitude=106.8&current=temperature_2m', 'Weather'],
  ['open-meteo-geo', 'https://geocoding-api.open-meteo.com/v1/search?name=Jakarta&count=1', 'Weather'],
  ['open-meteo-air', 'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=-6.2&longitude=106.8&current=pm10', 'Weather'],
  ['usgs-quake', 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson', 'Science'],
  ['iss-position', 'https://api.wheretheiss.at/v1/satellites/25544', 'Science'],
  ['nasa-apod', 'https://api.nasa.gov/planetary/apod', 'Science'],
  ['coinbase-spot', 'https://api.coinbase.com/v2/prices/BTC-USD/spot', 'Cryptocurrency'],
  ['coingecko-ping', 'https://api.coingecko.com/api/v3/ping', 'Cryptocurrency'],
  ['exchangerate-latest', 'https://api.exchangerate-api.com/v4/latest/USD', 'Currency'],
  ['frankfurter', 'https://api.frankfurter.app/latest?from=USD', 'Currency'],
  ['restcountries-name', 'https://restcountries.com/v3.1/name/indonesia?fields=name,capital,idd,cca3', 'Countries'],
  ['worldbank-indicator', 'https://api.worldbank.org/v2/country/IDN/indicator/NY.GDP.MKTP.CD?format=json&per_page=1&mrnev=1', 'Open Data'],
  ['covid-historical', 'https://disease.sh/v3/covid-19/countries/ID', 'Health'],
  ['openlibrary-search', 'https://openlibrary.org/search.json?q=dune&limit=1', 'Books'],
  ['openlibrary-author', 'https://openlibrary.org/search/authors.json?q=herman%20melville', 'Books'],
  ['githubtrending-repos', 'https://api.github.com/search/repositories?q=stars:>100000&per_page=1', 'Development'],
  ['reddit-top', 'https://www.reddit.com/r/programming/top.json?limit=1', 'Social'],
  ['hackernews-top', 'https://hacker-news.firebaseio.com/v0/topstories.json', 'News'],
  ['arxiv-search', 'http://export.arxiv.org/api/query?search_query=all:electron&max_results=1', 'Science'],
  ['weather-gov', 'https://api.weather.gov/points/39.7456,-97.0892', 'Weather'],
  ['openfoodfacts', 'https://world.openfoodfacts.org/api/v2/product/737628064502.json', 'Food'],
  ['restcountries-all', 'https://restcountries.com/v3.1/region/asia?fields=name,cca2', 'Countries'],
  ['dictionaryapi', 'https://api.dictionaryapi.dev/api/v2/entries/en/hello', 'Documents'],
  ['bible-api', 'https://bible-api.com/john+3:16', 'Documents'],
  ['genderize', 'https://api.genderize.io?name=alex', 'Machine Learning'],
  ['agify', 'https://api.agify.io?name=alex', 'Machine Learning'],
  ['xkcd-image', 'https://xkcd.com/info.0.json', 'Comics'],
  ['github-zen', 'https://api.github.com/zen', 'Development'],
  ['httpbin-headers', 'https://httpbin.org/headers', 'Test Data'],
  ['jsonplaceholder-posts', 'https://jsonplaceholder.typicode.com/posts?userId=1', 'Test Data'],
  ['placeholder-todos', 'https://jsonplaceholder.typicode.com/todos?userId=1', 'Test Data'],
  ['numbersapi', 'http://numbersapi.com/42', 'Science'],
  ['jokeapi', 'https://v2.jokeapi.dev/joke/Any?type=single', 'Entertainment'],
  ['boredapi', 'https://www.boredapi.com/api/activity', 'Entertainment'],
  ['dadjoke', 'https://icanhazdadjoke.com/', 'Entertainment'],
  ['chucknorris', 'https://api.chucknorris.io/jokes/random', 'Entertainment'],
  ['kanye', 'https://api.kanye.rest/', 'Entertainment'],
  ['advice', 'https://api.adviceslip.com/advice', 'Entertainment'],
  ['affirmations', 'https://affirmations.dev', 'Lifestyle'],
  ['fakejson', 'https://fakejson.com/api/v1/user', 'Test Data'],
  ['jsonbin-placeholder', 'https://httpbin.org/json', 'Test Data'],
  ['bored-activity', 'https://www.boredapi.com/api/activity?type=social', 'Entertainment'],
  ['timeapi', 'https://timeapi.io/api/time/current/zone?timeZone=Asia/Jakarta', 'Time'],
  ['worldtimeapi', 'https://worldtimeapi.org/api/timezone/Asia/Jakarta', 'Time'],
  ['timezoneapi', 'https://timeapi.io/api/time/current/zone?timeZone=Europe/London', 'Time'],
  ['open-meteo-airvar', 'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=51.5&longitude=-0.12&current=european_aqi', 'Weather'],
  ['iss-pass', 'https://api.wheretheiss.at/v1/satellites/25544/positions', 'Science'],
  ['gemini-public', 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd', 'Cryptocurrency'],
  ['blockchain-info', 'https://blockchain.info/rawblock/800000', 'Cryptocurrency'],
  ['binance-ticker', 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', 'Cryptocurrency'],
  ['kraken-ticker', 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD', 'Cryptocurrency'],
  ['wikipedia-summary', 'https://en.wikipedia.org/api/rest_v1/page/summary/Jakarta', 'Documents'],
  ['wikimedia-opensearch', 'https://en.wikipedia.org/w/api.php?action=opensearch&search=Jakarta&limit=1&format=json', 'Documents'],
  ['dbpedia', 'https://dbpedia.org/data/Jakarta.json', 'Documents'],
  ['openlibrary-cover', 'https://covers.openlibrary.org/b/isbn/9780441013593-L.jpg', 'Books'],
  ['github-raw', 'https://raw.githubusercontent.com/torvalds/linux/master/README', 'Development'],
  ['google-fonts', 'https://fonts.googleapis.com/css2?family=Roboto', 'Development'],
  ['jsonbin', 'https://api.jsonbin.io/v3/b/5de0e0e2f4e6a1a1b2c3d4e5', 'Test Data'],
  ['calculator', 'https://api.mathjs.org/v4/?expr=2%2B2', 'Science'],
  ['dictionary', 'https://api.dictionaryapi.dev/api/v2/entries/en/python', 'Documents'],
  ['currency-cdn', 'https://cdn.jsdelivr.net/npm/axios/package.json', 'Development'],
  ['unpkg-package', 'https://unpkg.com/lodash@4.17.21/package.json', 'Development'],
  ['github-api-limit', 'https://api.github.com/rate_limit', 'Development'],
  ['ip-api', 'http://ip-api.com/json/?fields=status,country,countryCode', 'Development'],
  ['ipinfo', 'https://ipinfo.io/json', 'Development'],
  ['cloudflare-dns', 'https://cloudflare-dns.com/dns-query?name=example.com&type=A', 'Development'],
  ['google-dns', 'https://dns.google/resolve?name=example.com&type=A', 'Development'],
];

const results = [];
let ok = 0;

async function probe(name, url, category) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 9000);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ac.signal,
      headers: {
        // Some services 403 a default undici User-Agent outright.
        'user-agent': 'Nyx-Flux-Bot/0.3 (+https://github.com/nyx-dev-officials/Nyx-Baileys)',
        accept: 'application/json, text/plain, */*',
      },
    });
    const ctype = res.headers.get('content-type') ?? '';
    const body = await res.text().catch(() => '');

    if (!res.ok) {
      return { name, url, category, status: 'unverified', reason: `HTTP ${res.status}`, sample: body.slice(0, 60) };
    }

    let parsed;
    try { parsed = JSON.parse(body); }
    catch {
      return {
        name, url, category, status: 'unverified',
        reason: `not JSON (${ctype.split(';')[0] || 'no content-type'})`,
        sample: body.slice(0, 60).replace(/\s+/g, ' '),
      };
    }

    ok++;
    // Record the shape so the bot can extract a field rather than dump JSON.
    const keys = parsed && typeof parsed === 'object'
      ? Object.keys(parsed).slice(0, 8)
      : [`<${Array.isArray(parsed) ? 'array' : typeof parsed}>`];
    return {
      name, url, category, status: 'verified', keys,
      sample: JSON.stringify(parsed).slice(0, 200),
    };
  } catch (err) {
    const msg = String(err?.message ?? err);
    return {
      name, url, category, status: 'unverified',
      reason: /abort/i.test(msg) ? 'timeout after 9s' : msg.slice(0, 80),
    };
  } finally {
    clearTimeout(timer);
  }
}

const CONCURRENCY = 10;
let idx = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (idx < ENDPOINTS.length) {
    const e = ENDPOINTS[idx++];
    results.push(await probe(e[0], e[1], e[2]));
  }
}));

results.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(OUT, JSON.stringify(results, null, 1));

console.log(`probed ${results.length} documented endpoints`);
console.log(`  VERIFIED keyless JSON : ${ok}`);
console.log(`  unverified            : ${results.length - ok}`);
console.log('\nverified:');
for (const r of results.filter((x) => x.status === 'verified')) {
  console.log(`  ${r.name.padEnd(24)} ${(r.keys ?? []).slice(0, 4).join(',')}`);
}