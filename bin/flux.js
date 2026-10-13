#!/usr/bin/env node
/**
 * `flux` — the Nyx-Baileys launcher.
 *
 * Run with no arguments it starts the bot against the remembered session, no
 * flags and no env needed. A paired session goes straight online; anything
 * else drops into the interactive wizard (pair, inspect, purge):
 *
 *   flux
 *   flux --dir C:\nyx-session --phone 0882017467912
 *   flux --menu            force the wizard even when paired
 *
 * Given a subcommand it forwards to the CLI instead, so nothing is lost:
 *
 *   flux status
 *   flux sessions
 *   flux health
 *
 * Resolves the compiled entry relative to *this file* rather than
 * `process.cwd()`, so it behaves identically from a clone, an `npm link`, or a
 * global install where npm reaches it through a shim.
 *
 *   exit 0    ok
 *   exit 1    not built, or usage error
 *   exit 130  interrupted (Ctrl-C)
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const distEntry = join(here, '..', 'dist', 'index.js');
const cliEntry = join(here, '..', 'dist', 'cli', 'main.js');

const argv = process.argv.slice(2);

// Subcommands that belong to the command surface rather than the wizard.
// `flux` on its own is the wizard; `flux pair` is not a thing any more.
const SUBCOMMANDS = new Set(['status', 'send', 'health', 'sessions', 'help']);

const subcommand = argv.find((a) => SUBCOMMANDS.has(a));

const entry = subcommand ? cliEntry : distEntry;

if (!existsSync(entry)) {
  process.stderr.write(
    `error  flux is not built — ${entry} does not exist\n`
    + '       build it first:  npm run build\n',
  );
  process.exit(1);
}

/** Ctrl-C during a QR scan should not leave a half-written session behind. */
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { process.exitCode = 130; });
}

/**
 * Everything async lives in here rather than at the top level. A top-level
 * await that outlives the event loop's other handles makes Node print
 * "Detected unsettled top-level await" — exactly what a bot holding its socket
 * open looks like — so the entry point stays synchronous and the work floats.
 */
async function main() {
  const mod = await import(pathToFileURL(entry).href);

  const code = subcommand ? await mod.main(argv) : await mod.bootstrap(argv);

  process.exitCode = typeof code === 'number' ? code : 0;

  // Baileys holds sockets and timers open. The socket is disposed before either
  // entry point resolves, but a leaked handle should never hang the shell: if
  // anything is still alive 2s after the work is done, leave anyway. Unref'd,
  // so this cannot keep a healthy process alive on its own. Armed here — after
  // resolution — and never before: a startup grace timer would execute runs
  // still connecting (observed: a healthy boot killed at ~1s, mid-handshake).
  // Hold-forever modes never resolve, so the guard never arms for them.
  const guard = setTimeout(() => {
    process.exit(process.exitCode ?? 0);
  }, 2000);
  guard.unref();
}

void main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error  flux could not start: ${message}\n`);
  process.stderr.write('       if the build is stale, run:  npm run build\n');
  process.exit(1);
});
