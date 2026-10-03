/**
 * The `nyx-baileys/lite` entry.
 *
 * Two properties matter, and both are asserted here rather than trusted:
 *
 *   1. **It never pulls the engine.** The whole point of the entry is to be
 *      importable without paying for protobufjs, libsignal and the rest of the
 *      protocol stack. So the test walks the *built* module graph and fails if
 *      any reachable file imports `@whiskeysockets/baileys` at runtime.
 *   2. **It carries the pure helpers.** The point of being light is useless if
 *      the helpers a script wants are not there. A representative set is
 *      checked from the built output.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '..', 'dist');
const LITE = resolve(dist, 'lite.js');
const ENGINE = '@whiskeysockets/baileys';

/**
 * Specifiers referenced by a module: static `import ... from`, bare
 * `import '...'`, `export ... from`, and dynamic `import('...')`. Good enough
 * for our own compiler output, which has no conditional requires.
 */
function specifiersOf(source) {
  const found = new Set();
  const fromRe = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g;
  const bareRe = /\bimport\s*['"]([^'"]+)['"]/g;
  const dynamicRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [fromRe, bareRe, dynamicRe]) {
    let match;
    while ((match = re.exec(source)) !== null) found.add(match[1]);
  }
  return [...found];
}

/** Every local module reachable from `entry`, plus the foreign imports seen. */
function walk(entry) {
  const visited = new Set();
  const foreign = new Set();
  const queue = [entry];

  while (queue.length) {
    const file = queue.pop();
    if (visited.has(file)) continue;
    visited.add(file);

    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      throw new Error(`lite graph references a missing module: ${file}`);
    }

    for (const spec of specifiersOf(source)) {
      if (spec.startsWith('.')) {
        // Our compiler always emits the `.js` extension already.
        queue.push(resolve(dirname(file), spec));
      } else if (spec.startsWith('node:')) {
        // built-ins are free
      } else {
        foreign.add(spec);
      }
    }
  }

  return { visited, foreign };
}

test('the lite graph never imports the baileys engine', () => {
  const { visited, foreign } = walk(LITE);

  assert.equal(
    [...visited].some((f) => f.endsWith('lite.js')),
    true,
    'the walk did not even start at lite.js',
  );
  assert.ok(visited.size > 10, `expected a real graph, walked only ${visited.size} files`);

  const engineImports = [...visited].filter((file) => {
    const source = readFileSync(file, 'utf8');
    return specifiersOf(source).includes(ENGINE);
  });

  assert.deepEqual(
    engineImports.map((f) => f.replace(`${dist}\\`, '').replace(`${dist}/`, '')),
    [],
    'these modules import the engine and are reachable from lite',
  );

  assert.equal(
    foreign.has(ENGINE),
    false,
    `lite transitively imports ${ENGINE}`,
  );
});

test('the engine is not hidden behind a different spelling', () => {
  const { visited } = walk(LITE);
  for (const file of visited) {
    const source = readFileSync(file, 'utf8');
    for (const spec of specifiersOf(source)) {
      assert.equal(
        /whiskeysockets/i.test(spec),
        false,
        `${file} imports ${spec}`,
      );
    }
  }
});

test('lite exports the identifier, timing and logging surface', async () => {
  const lite = await import('../dist/lite.js');

  for (const name of [
    'canonicalThreadKey',
    'bareJid',
    'isGroup',
    'ClockSync',
    'DeliveryTracker',
    'patch',
    'Disposables',
    'createLogger',
    'silentLogger',
  ]) {
    assert.equal(typeof lite[name] === 'function' || typeof lite[name] === 'object', true, `missing ${name}`);
    assert.ok(name in lite, `lite does not export ${name}`);
  }
});

test('lite exports the text and display helpers', async () => {
  const lite = await import('../dist/lite.js');

  for (const name of [
    'bold',
    'chunkText',
    'truncate',
    'similarity',
    'formatBytes',
    'formatDuration',
    'formatNumber',
    'ordinal',
  ]) {
    assert.equal(typeof lite[name], 'function', `lite does not export ${name}`);
  }

  // And they behave, so this is not just a re-export shell.
  assert.equal(lite.bold('x'), '*x*');
  assert.equal(lite.formatBytes(1024), '1.0 KB');
});

test('lite exposes the anti-ban engines without the socket engine', async () => {
  const lite = await import('../dist/lite.js');
  assert.equal(typeof lite.antibanPlugins, 'function');
  for (const name of [
    'ContentVariator',
    'HumanEntropy',
    'LegitimacySignalInjector',
    'PresenceChoreographer',
    'contentVariation',
    'humanEntropy',
    'legitimacySignals',
    'presenceChoreography',
    'readReceiptVariancePlugin',
  ]) {
    assert.ok(name in lite, `lite does not export ${name}`);
  }
});
