import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  configureAiState,
  defaultAiState,
  fluxConfigFile,
  isAwake,
  isChatPermitted,
  permitChat,
  permitPerson,
  permittedPersons,
  readAiState,
  readFluxFile,
  readOpenRouterKey,
  setAwake,
  unconfigureAiState,
  unpermitPerson,
} from '../dist/toolkit/ai-state.js';

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'nyx-ai-state-'));
  configureAiState(dir);
  return dir;
}

test('unconfigured state throws a clear error, never undefined behavior', () => {
  unconfigureAiState();
  assert.throws(() => readAiState(), /configureAiState/);
  assert.throws(() => setAwake(true), /configureAiState/);
});

test('fresh state sleeps with nothing permitted', () => {
  sandbox();
  assert.deepEqual(readAiState(), defaultAiState());
  assert.equal(isAwake(), false);
  assert.equal(isChatPermitted('g1@g.us'), false);
  assert.deepEqual(permittedPersons(), []);
});

test('wake and sleep persist across re-reads', () => {
  sandbox();
  assert.equal(setAwake(true), true);
  assert.equal(isAwake(), true);
  assert.equal(setAwake(true), false, 'no-op flip reports no change');
  assert.equal(setAwake(false), true);
  assert.equal(isAwake(), false);
});

test('chat permits survive reloads and tolerate device suffixes', () => {
  const dir = sandbox();
  assert.equal(permitChat('g1@g.us'), true);
  assert.equal(permitChat('g1@g.us'), false, 'double permit reports no change');
  assert.equal(isChatPermitted('g1@g.us'), true);
  assert.equal(isChatPermitted('g2@g.us'), false);
  configureAiState(dir);
  assert.equal(isChatPermitted('g1@g.us'), true, 'reload must keep permits');
});

test('persons round-trip with normalization', () => {
  sandbox();
  assert.equal(permitPerson('62882017467912'), true);
  assert.equal(permitPerson('62882017467912@s.whatsapp.net'), false, 'same person, normalized');
  assert.deepEqual(permittedPersons(), ['62882017467912@s.whatsapp.net']);
  assert.equal(unpermitPerson('62882017467912'), true);
  assert.equal(unpermitPerson('62882017467912'), false, 'double removal reports no change');
  assert.deepEqual(permittedPersons(), []);
});

test('corrupt state reads as asleep-with-nothing, empty ids refuse', () => {
  const dir = sandbox();
  fs.writeFileSync(join(dir, 'ai-state.json'), '{broken');
  assert.deepEqual(readAiState(), defaultAiState());
  assert.equal(permitChat(''), false);
  assert.equal(permitPerson(''), false);
});

test('flux config file lives outside the repo in user-private config', () => {
  const file = fluxConfigFile();
  assert.match(file, /nyx-baileys[\\/]flux\.json$/);
  assert.doesNotMatch(file, /Nyx-Baileys/, 'must never resolve inside the checkout');
});

test('openrouter key resolves env first, then file, then nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nyx-ai-key-'));
  const file = join(dir, 'flux.json');
  fs.writeFileSync(file, JSON.stringify({ openRouterApiKey: 'sk-or-v1-FILEKEY' }));
  assert.equal(
    readOpenRouterKey({ OPENROUTER_API_KEY: 'sk-or-v1-ENVKEY' }, file),
    'sk-or-v1-ENVKEY',
  );
  assert.equal(readOpenRouterKey({}, file), 'sk-or-v1-FILEKEY');
  assert.equal(readOpenRouterKey({}, join(dir, 'missing.json')), null);
  assert.equal(readOpenRouterKey({ OPENROUTER_API_KEY: 'not-a-key' }, file), 'sk-or-v1-FILEKEY');
  fs.writeFileSync(file, JSON.stringify({ openRouterApiKey: 'not-a-key-either' }));
  assert.equal(readOpenRouterKey({}, file), null, 'malformed values read as absent');
});

test('readFluxFile tolerates garbage without throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nyx-ai-key-'));
  const file = join(dir, 'flux.json');
  assert.deepEqual(readFluxFile(join(dir, 'missing.json')), {});
  fs.writeFileSync(file, '[1,2');
  assert.deepEqual(readFluxFile(file), {});
});
