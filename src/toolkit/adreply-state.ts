/**
 * Whether outgoing messages carry the native ad card.
 *
 * Deliberately NOT on by default. The card is branding the reader did not ask
 * for, and while it was wired into the default chain nothing had yet shown it
 * rendering on a real account — shipping it to every message before that answer
 * arrived would have put an unverified payload on every send.
 *
 * So it is opt-in, one switch, persisted beside the session exactly like the AI
 * state: a file reads identically on every host, and every mutation writes
 * through immediately so a crash cannot lose the flip.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const STATE_FILE = 'adreply-state.json';

let configuredDir: string | null = null;

/** Point state at a session directory. Required before any other call. */
export function configureAdReplyState(dir: string): void {
  configuredDir = dir;
}

/** Forget the configured directory. Tests only. */
export function unconfigureAdReplyState(): void {
  configuredDir = null;
}

function stateFile(): string {
  if (!configuredDir) throw new Error('adreply-state: configureAdReplyState(dir) must run first');
  return join(configuredDir, STATE_FILE);
}

/** Off unless a human turned it on. */
export function isAdReplyEnabled(): boolean {
  try {
    return (JSON.parse(readFileSync(stateFile(), 'utf8')) as { enabled?: unknown }).enabled === true;
  } catch {
    return false;
  }
}

/** @returns the state after the write, so callers can report what actually stuck. */
export function setAdReplyEnabled(enabled: boolean): boolean {
  const file = stateFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ enabled }, null, 2));
  return enabled;
}