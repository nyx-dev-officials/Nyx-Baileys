/**
 * Command loader.
 *
 * Classic WhatsApp bot scripts spread commands across a directory and then
 * hand-roll a require loop. This is that loop, done properly: it scans a
 * directory, imports each module, and collects the command specs it exports —
 * accepting the shapes people actually write (`default`, `command`, `commands`,
 * or named spec exports).
 *
 * A module that throws is reported and skipped; one bad file must not stop the
 * bot from starting.
 */

import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

import type { CommandSpec } from '../plugins/commands.js';

export interface LoadedCommand {
  readonly spec: CommandSpec;
  /** Absolute path of the module it came from. */
  readonly file: string;
}

export interface LoadCommandsOptions {
  /** Only files this returns true for are imported. Default: `.js/.mjs/.cjs`. */
  filter?: (file: string, fullPath: string) => boolean;
  /** Called for a module that fails to import or exports nothing usable. */
  onError?: (err: unknown, file: string) => void;
  /** Recurse into subdirectories. Default `true`. */
  recursive?: boolean;
}

const DEFAULT_EXTENSIONS = ['.js', '.mjs', '.cjs'];

const isCommandSpec = (value: unknown): value is CommandSpec => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.name === 'string' && typeof record.handler === 'function';
};

/** Pull every command spec out of a module's exports. */
export function collectSpecs(module: unknown): CommandSpec[] {
  const record = (module ?? {}) as Record<string, unknown>;
  const out: CommandSpec[] = [];

  const consider = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) if (isCommandSpec(item)) out.push(item);
      return;
    }
    if (isCommandSpec(value)) out.push(value);
  };

  // Preferred shapes first, then any other named export that looks like a spec.
  consider(record.default);
  consider(record.command);
  consider(record.commands);

  for (const [key, value] of Object.entries(record)) {
    if (key === 'default' || key === 'command' || key === 'commands') continue;
    consider(value);
  }

  return out;
}

const walk = (root: string, recursive: boolean, filter: (file: string, full: string) => boolean): string[] => {
  const files: string[] = [];
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (recursive) files.push(...walk(full, recursive, filter));
      continue;
    }
    if (filter(entry.name, full)) files.push(full);
  }
  return files.sort();
};

/**
 * Import every command module under `dir`.
 *
 * ```ts
 * const loaded = await loadCommands('./commands');
 * for (const { spec } of loaded) sock.commands.register(spec);
 * ```
 */
export async function loadCommands(dir: string, options: LoadCommandsOptions = {}): Promise<LoadedCommand[]> {
  const recursive = options.recursive ?? true;
  const filter =
    options.filter ??
    ((file: string) => DEFAULT_EXTENSIONS.some((ext) => file.endsWith(ext)));

  let files: string[];
  try {
    files = walk(dir, recursive, filter);
  } catch (err) {
    options.onError?.(err, dir);
    return [];
  }

  const loaded: LoadedCommand[] = [];
  for (const file of files) {
    try {
      const module = (await import(pathToFileURL(file).href)) as unknown;
      const specs = collectSpecs(module);
      if (specs.length === 0) {
        options.onError?.(new Error('module exported no command spec'), file);
        continue;
      }
      for (const spec of specs) loaded.push({ spec, file });
    } catch (err) {
      options.onError?.(err, file);
    }
  }

  return loaded;
}

export default loadCommands;
