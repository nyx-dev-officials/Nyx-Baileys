/**
 * Global AI sleep/wake state.
 *
 * One process-wide switch, persisted next to the session so a restart resumes
 * instead of silently changing behaviour: awake survives reboots, and only an
 * explicit off flips it. Three independent facts:
 *
 * - `awake` — the master switch. Asleep answers nothing ambient.
 * - `chats` — where the AI may reply. Granted when the owner says the bare
 *   wake word in that chat. A wake in chat A never authorises chat B.
 * - `persons` — non-owners allowed to wake. Everyone may *receive* replies;
 *   only the owner and these persons may flip state.
 *
 * Plain JSON beside the session, not the plugin sidecar: the sidecar lifecycle
 * differs between hosts (initialized store vs constructed-without-init), while
 * a file reads identically everywhere. The configured directory is module
 * state set once at boot; every mutation writes through immediately, so a
 * crash cannot lose a switch flipped seconds earlier.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { toUser } from '../plugins/commands.js';

/**
 * Machine-level flux config: session memory plus operator secrets.
 *
 * Lives outside the repo on purpose — `npm publish` ships the repo to
 * everyone, so a key in source is a key in git history. `%APPDATA%` (Windows)
 * and `~/.config` (elsewhere) are user-private by default, the same trust
 * model as npmrc tokens and AWS creds files.
 */
export function fluxConfigFile(): string {
  const base = process.platform === 'win32'
    ? process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    : process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(base, 'nyx-baileys', 'flux.json');
}

export interface FluxFileConfig {
  sessionDir?: unknown;
  openRouterApiKey?: unknown;
}

export function readFluxFile(file: string = fluxConfigFile()): FluxFileConfig {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as FluxFileConfig;
    return typeof raw === 'object' && raw !== null ? raw : {};
  } catch {
    return {};
  }
}

/**
 * Resolve the OpenRouter key: explicit env first, machine file second.
 * Never throws, never logs the value — callers only learn whether one exists
 * by whether calls authenticate.
 */
export function readOpenRouterKey(
  env: NodeJS.ProcessEnv = process.env,
  file: string = fluxConfigFile(),
): string | null {
  const fromEnv = env.OPENROUTER_API_KEY;
  if (typeof fromEnv === 'string' && fromEnv.startsWith('sk-or-v1-')) return fromEnv;
  const fromFile = readFluxFile(file).openRouterApiKey;
  if (typeof fromFile === 'string' && fromFile.startsWith('sk-or-v1-')) return fromFile;
  return null;
}

export interface AiStateData {
  readonly awake: boolean;
  readonly chats: readonly string[];
  readonly persons: readonly string[];
}

const STATE_FILE = 'ai-state.json';

let configuredDir: string | null = null;

/** Point state at a session directory. Required before any other call. */
export function configureAiState(dir: string): void {
  configuredDir = dir;
}

/** Forget the configured directory. Tests only — production configures once. */
export function unconfigureAiState(): void {
  configuredDir = null;
}

function stateFile(): string {
  if (!configuredDir) throw new Error('ai-state: configureAiState(dir) must run before any state call');
  return join(configuredDir, STATE_FILE);
}

export function defaultAiState(): AiStateData {
  return { awake: false, chats: [], persons: [] };
}

export function readAiState(): AiStateData {
  const file = stateFile();
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<AiStateData>;
    return {
      awake: raw.awake === true,
      chats: Array.isArray(raw.chats) ? raw.chats.filter((c): c is string => typeof c === 'string') : [],
      persons: Array.isArray(raw.persons) ? raw.persons.filter((p): p is string => typeof p === 'string') : [],
    };
  } catch {
    return defaultAiState();
  }
}

function writeAiState(state: AiStateData): void {
  if (!configuredDir) throw new Error('ai-state: configureAiState(dir) must run before any state call');
  mkdirSync(configuredDir, { recursive: true });
  writeFileSync(stateFile(), JSON.stringify(state));
}

export function isAwake(): boolean {
  return readAiState().awake;
}

/** Returns true when the flip changed anything. */
export function setAwake(on: boolean): boolean {
  const state = readAiState();
  if (state.awake === on) return false;
  writeAiState({ ...state, awake: on });
  return true;
}

/**
 * Canonical identity for storage and comparison: device suffixes stripped, so
 * permitting `x@s.whatsapp.net` and hearing from `x:14@s.whatsapp.net` is the
 * same chat — the suffix is routing, not identity. LID↔PN duality is out of
 * scope: no local function maps those.
 */
function keyOf(jid: string): string {
  const bare = toUser(jid);
  return bare !== '' ? bare : jid;
}

function memberOf(list: readonly string[], jid: string): boolean {
  const key = keyOf(jid);
  return key !== '' && list.map(keyOf).includes(key);
}

/** Returns true when the chat is newly permitted. */
export function permitChat(jid: string): boolean {
  const key = keyOf(jid);
  if (key === '') return false;
  const state = readAiState();
  if (memberOf(state.chats, key)) return false;
  writeAiState({ ...state, chats: [...state.chats.map(keyOf), key] });
  return true;
}

export function isChatPermitted(jid: string): boolean {
  return memberOf(readAiState().chats, jid);
}

/** Returns true when the person is newly permitted. */
export function permitPerson(id: string): boolean {
  const key = keyOf(id);
  if (key === '') return false;
  const state = readAiState();
  if (memberOf(state.persons, key)) return false;
  writeAiState({ ...state, persons: [...state.persons.map(keyOf), key] });
  return true;
}

/** Returns true when someone was actually removed. */
export function unpermitPerson(id: string): boolean {
  const state = readAiState();
  const key = keyOf(id);
  const next = state.persons.map(keyOf).filter((p) => p !== key);
  if (next.length === state.persons.length) return false;
  writeAiState({ ...state, persons: next });
  return true;
}

export function permittedPersons(): string[] {
  return [...readAiState().persons];
}
