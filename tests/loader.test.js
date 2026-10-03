/**
 * Command loader.
 *
 * Builds a throwaway directory of command modules and imports them, covering
 * the export shapes people actually write and the bad-module path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { collectSpecs, loadCommands } from '../dist/bot/loader.js';

const makeDir = () => mkdtempSync(path.join(tmpdir(), 'nyx-cmd-'));

const specModule = (name) =>
  `export default { name: ${JSON.stringify(name)}, category: 'test', handler: (c) => c.reply('ok') };\n`;

test('collectSpecs accepts default, command and commands export shapes', () => {
  assert.equal(collectSpecs({ default: { name: 'a', handler: () => {} } }).length, 1);
  assert.equal(collectSpecs({ command: { name: 'b', handler: () => {} } }).length, 1);
  assert.equal(collectSpecs({ commands: [{ name: 'c', handler: () => {} }, { name: 'd', handler: () => {} }] }).length, 2);
  assert.equal(collectSpecs({ ping: { name: 'e', handler: () => {} } }).length, 1);
  assert.equal(collectSpecs({ nope: 42 }).length, 0);
});

test('loadCommands imports every module in a directory', async () => {
  const dir = makeDir();
  writeFileSync(path.join(dir, 'ping.mjs'), specModule('ping'));
  writeFileSync(path.join(dir, 'pong.mjs'), specModule('pong'));

  const loaded = await loadCommands(dir);
  assert.deepEqual(loaded.map((l) => l.spec.name).sort(), ['ping', 'pong']);
  assert.ok(loaded.every((l) => l.file.endsWith('.mjs')));
});

test('loadCommands recurses into subdirectories', async () => {
  const dir = makeDir();
  mkdirSync(path.join(dir, 'nested'));
  writeFileSync(path.join(dir, 'nested', 'deep.mjs'), specModule('deep'));

  const loaded = await loadCommands(dir);
  assert.deepEqual(loaded.map((l) => l.spec.name), ['deep']);
});

test('a broken module is reported and skipped, the rest still load', async () => {
  const dir = makeDir();
  writeFileSync(path.join(dir, 'good.mjs'), specModule('good'));
  writeFileSync(path.join(dir, 'broken.mjs'), 'export default { name: function(');

  const errors = [];
  const loaded = await loadCommands(dir, { onError: (err, file) => errors.push(path.basename(file)) });

  assert.deepEqual(loaded.map((l) => l.spec.name), ['good']);
  assert.deepEqual(errors, ['broken.mjs']);
});

test('a module with no usable export is reported', async () => {
  const dir = makeDir();
  writeFileSync(path.join(dir, 'empty.mjs'), 'export const nothing = 1;\n');

  const errors = [];
  const loaded = await loadCommands(dir, { onError: (err, file) => errors.push(path.basename(file)) });
  assert.deepEqual(loaded, []);
  assert.deepEqual(errors, ['empty.mjs']);
});

test('a missing directory is reported, not thrown', async () => {
  const errors = [];
  const loaded = await loadCommands(path.join(tmpdir(), 'nyx-does-not-exist-xyz'), {
    onError: (err) => errors.push(err),
  });
  assert.deepEqual(loaded, []);
  assert.equal(errors.length, 1);
});

test('a custom filter is honoured', async () => {
  const dir = makeDir();
  writeFileSync(path.join(dir, 'a.mjs'), specModule('a'));
  writeFileSync(path.join(dir, 'skip.txt'), specModule('b'));

  const loaded = await loadCommands(dir, { filter: (file) => file.endsWith('.mjs') });
  assert.deepEqual(loaded.map((l) => l.spec.name), ['a']);
});
