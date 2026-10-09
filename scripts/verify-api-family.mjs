/**
 * Run every live-API command and report which ones actually work.
 *
 * ## Why this exists
 *
 * An endpoint can pass the probe and still render badly — the probe only checks
 * that JSON parses, not that the format template's paths exist. A template
 * pointing at a field the service does not return produces `(missing)` in the
 * message, which is the same class of defect as the fake-success functions this
 * project has spent a session deleting: the command *runs*, returns cleanly, and
 * shows the user nothing useful.
 *
 * So this executes every command and fails on three conditions:
 *   - the call errors
 *   - the output contains `(missing)`
 *   - the output is trivially short
 *
 * Run with `node verify-api-family.mjs`.
 */

import { API_ENDPOINTS, callApi } from '../dist/toolkit/command-api.js';

/** Arguments needed for endpoints that take one. */
const ARGS = {
  open_meteo: '-6.2,106.8',
  open_meteo_air: '-6.2,106.8',
  open_meteo_airvar: '51.5,-0.12',
  open_meteo_geo: 'Jakarta',
  github_user: 'torvalds',
  github_repos: 'facebook/react',
  githubtrending_repos: '',
  npm_package: 'express',
  pypi_package: 'requests',
  unpkg_package: 'lodash',
  restcountries_name: 'indonesia',
  restcountries_all: 'asia',
  wikimedia_opensearch: 'Jakarta',
  openlibrary_search: 'dune',
  openlibrary_author: 'melville',
  wikipedia_summary: 'Jakarta',
  dictionaryapi: 'ephemeral',
  'bible-api': 'john 3:16',
  agify: 'alex',
  genderize: 'alex',
  jsonplaceholder_users: '1',
  timeapi: 'Asia/Jakarta',
  timezoneapi: 'Asia/Jakarta',
  calculator: '2^10',
  worldbank_indicator: 'IDN',
  covid_historical: 'Indonesia',
  gemini_public: 'bitcoin',
  google_dns: 'example.com',
  weather_gov: '',
  currency_cdn: '',
};

const CONCURRENCY = 6;
const results = [];
let idx = 0;

/**
 * Look the arg up by endpoint name.
 *
 * Endpoint names are hyphenated (`open-meteo`); the table above is keyed with
 * underscores, which is how every one of them missed and reported a spurious
 * "Usage:" error. Both spellings are checked rather than silently defaulting,
 * because a default of `''` here hides a real missing argument.
 */
const argFor = (name) => {
  const byHyphen = ARGS[name];
  if (byHyphen !== undefined) return byHyphen;
  return ARGS[name.replace(/-/g, '_')] ?? '';
};

await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (idx < API_ENDPOINTS.length) {
    const ep = API_ENDPOINTS[idx++];
    const out = await callApi(ep, argFor(ep.name), 12_000);

    let verdict = 'ok';
    let note = '';

    if (out.error) { verdict = 'error'; note = out.error.slice(0, 90); }
    else if ((out.text ?? '').includes('(missing)')) {
      verdict = 'template';
      note = (out.text ?? '').split('\n').filter((l) => l.includes('(missing)')).join(' | ').slice(0, 110);
    } else if ((out.text ?? '').trim().length < 4) {
      verdict = 'empty';
      note = `only ${(out.text ?? '').length} chars`;
    }

    results.push({ name: ep.name, verdict, note, text: out.text });
  }
}));

results.sort((a, b) => a.name.localeCompare(b.name));

const count = (v) => results.filter((r) => r.verdict === v).length;
console.log(`checked ${results.length} live-API commands`);
console.log(`  ok        : ${count('ok')}`);
console.log(`  template  : ${count('template')}  — format paths point at fields that do not exist`);
console.log(`  error     : ${count('error')}`);
console.log(`  empty     : ${count('empty')}\n`);

for (const v of ['template', 'error', 'empty']) {
  const bad = results.filter((r) => r.verdict === v);
  if (!bad.length) continue;
  console.log(`--- ${v} ---`);
  for (const b of bad) console.log(`  ${b.name.padEnd(24)} ${b.note}`);
  console.log('');
}

process.exit(count('template') + count('empty') ? 1 : 0);