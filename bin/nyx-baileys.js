#!/usr/bin/env node
/**
 * Nyx-Baileys CLI launcher.
 *
 * Thin on purpose: resolve the compiled entry point relative to this file —
 * never relative to `process.cwd()` — so the command works the same whether it
 * is run from a clone, linked by `npm link`, or installed globally where npm
 * points at this file through a shim.
 *
 *   exit 0    ok
 *   exit 1    usage error, or the package has not been built
 *   exit 2    connection or session failure
 *   exit 3    not paired
 *   exit 130  interrupted (Ctrl-C)
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'dist', 'cli', 'main.js');

if (!existsSync(entry)) {
  process.stderr.write(
    `error  nyx-baileys is not built — ${entry} does not exist\n` +
      '       build it first:  npm run build\n',
  );
  process.exit(1);
}

/** SIGINT/SIGTERM are handled inside main so the socket is closed first. */
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    // main installs its own handler; this only covers the window before it runs.
    process.exitCode = 130;
  });
}

try {
  const { main } = await import(pathToFileURL(entry).href);
  const code = await main(process.argv.slice(2));

  process.exitCode = typeof code === 'number' ? code : 0;
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error  nyx-baileys could not start: ${message}\n`);
  process.stderr.write('       if the build is stale, run:  npm run build\n');
  process.exit(2);
}

// Baileys keeps timers and sockets alive. main() disposes the socket before it
// resolves, but a leaked handle should still not hang the shell: if the loop is
// still busy 2s after the command finished, leave anyway. Unref'd, so this never
// keeps a healthy process alive on its own.
const guard = setTimeout(() => {
  process.exit(process.exitCode ?? 0);
}, 2000);
guard.unref();