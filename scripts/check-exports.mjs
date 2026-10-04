/**
 * Verify the package `exports` map.
 *
 * The map is a contract: a subpath that points at a file `tsc` never emitted
 * ships a deep import that is broken for everyone who takes it, and nothing else
 * in the build would notice. `tsc` only knows about files it was told to compile;
 * it has no opinion about whether the string in package.json resolves.
 *
 * Two checks:
 *   1. every literal target in `exports` exists on disk after a build
 *   2. wildcard subpaths have at least one matching file, so `./plugins/*` is not
 *      a promise that resolves to nothing
 *
 * Run after `npm run build`. Exits non-zero with a list of what is missing.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

/** All target strings in an exports entry, which may be a string or a condition map. */
function targetsOf(entry, out = []) {
  if (typeof entry === 'string') {
    out.push(entry);
    return out;
  }
  if (entry && typeof entry === 'object') {
    for (const value of Object.values(entry)) targetsOf(value, out);
  }
  return out;
}

/** Expand a `./dist/plugins/*.js` style target against what is on disk. */
function expandWildcard(target) {
  const [prefix, suffix] = target.split('*');
  if (suffix === undefined) return [target];

  const dir = resolve(root, prefix.replace(/\/$/, ''));
  if (!existsSync(dir)) return [];

  const out = [];
  const walk = (current, depth) => {
    if (depth > 4) return;
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full, depth + 1);
      else if (name.endsWith(suffix.replace(/^\./, '.'))) out.push(full);
    }
  };
  walk(dir, 0);
  return out;
}

const problems = [];
let checked = 0;

for (const [subpath, entry] of Object.entries(pkg.exports ?? {})) {
  for (const target of targetsOf(entry)) {
    if (!target.startsWith('./')) continue;

    if (target.includes('*')) {
      const matches = expandWildcard(target);
      checked += 1;
      if (matches.length === 0) {
        problems.push(`${subpath} -> ${target}  (wildcard matches no file)`);
      }
      continue;
    }

    checked += 1;
    if (!existsSync(resolve(root, target))) {
      problems.push(`${subpath} -> ${target}`);
    }
  }
}

// The binary has to exist too, or `npm link` and global installs are broken while
// the exports map looks perfectly fine.
if (pkg.bin) {
  for (const [name, target] of Object.entries(pkg.bin)) {
    checked += 1;
    if (!existsSync(resolve(root, target))) problems.push(`bin.${name} -> ${target}`);
  }
}

if (problems.length > 0) {
  console.error(`${problems.length} of ${checked} export targets are missing:\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error('\nDid you run `npm run build`?');
  process.exit(1);
}

console.log(`all ${checked} export targets resolve`);
