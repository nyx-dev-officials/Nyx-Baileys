/**
 * Example WhatsApp bot on nyx-baileys.
 *
 *   node examples/bot/index.mjs
 *
 * Pair on first run with `NYX_PAIR=true` (or scan the QR the socket prints),
 * then send `/ping`, `/menu`, `/whoami`.
 *
 * It is thin on purpose — everything it does, a script can do directly with
 * `createNyxBaileys`. The bot host only wires the socket, the command plugin and
 * the command directory together.
 */

import { fileURLToPath } from 'node:url';

import { createNyxBot, installGracefulShutdown } from '../../dist/index.js';

import config from './config.mjs';

const commandsDir = fileURLToPath(new URL('./commands', import.meta.url));

const bot = await createNyxBot({
  sessionDir: config.sessionDir,
  prefix: config.prefix,
  owners: config.owners,
  groups: config.groups,
  logLevel: config.logLevel,
  messages: config.messages,
  commandsDir,
  loader: {
    onError: (err, file) => console.error(`[loader] skipped ${file}: ${err.message}`),
  },
});

console.log(`online as ${bot.sock.user?.id ?? 'unknown'}`);
console.log(`${bot.loaded.length} commands loaded from ${commandsDir}`);
console.log(`prefix "${config.prefix}" — try ${config.prefix}menu`);

// Stop cleanly on Ctrl-C: unwind patches, close the socket.
installGracefulShutdown(bot, (code) => process.exit(code));
