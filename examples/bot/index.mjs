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

import {
  aiGate,
  buildFullRegistry,
  configureAiState,
  createNyxBot,
  fluxMenuTap,
  installGracefulShutdown,
  registryToSpecs,
  resolveFeatureMenuSelection,
  sendFeatureExample,
} from '../../dist/index.js';

import config from './config.mjs';

const commandsDir = fileURLToPath(new URL('./commands', import.meta.url));

// One registry feeds both the command specs and the catalogue tap router, so a
// tap can never name a family the specs do not have.
const fluxRegistry = buildFullRegistry();
configureAiState(config.sessionDir);

const bot = await createNyxBot({
  sessionDir: config.sessionDir,
  prefix: config.prefix,
  owners: config.owners,
  groups: config.groups,
  logLevel: config.logLevel,
  messages: config.messages,
  commands: registryToSpecs(fluxRegistry),
  plugins: [fluxMenuTap(fluxRegistry), aiGate({ owners: config.owners, prefix: config.prefix, sessionDir: config.sessionDir })],
  commandsDir,
  loader: {
    onError: (err, file) => console.error(`[loader] skipped ${file}: ${err.message}`),
  },
});

console.log(`online as ${bot.sock.user?.id ?? 'unknown'}`);
console.log(`${bot.commands.list().length} commands live (${fluxRegistry.size} registry + ${bot.loaded.length - fluxRegistry.size} from ${commandsDir})`);
console.log(`prefix "${config.prefix}" — try ${config.prefix}menu`);

/**
 * Menu taps.
 *
 * The reference bot (`refs/atex-ovi__wabase-button/src/handler.js`) reads the
 * selection out of `interactiveResponseMessage.nativeFlowResponseMessage.paramsJson`
 * and switches on the row id. This is the same read, minus the switch: the id
 * resolves to a feature, and the feature knows how to send itself.
 *
 * `resolveFeatureMenuSelection` returns null for anything that is not one of our
 * rows, so an unrelated interactive message is ignored rather than mis-dispatched.
 */
bot.sock.ev.on('messages.upsert', async ({ messages }) => {
  const msg = messages?.[0];
  const raw = msg?.message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
  if (!raw) return;

  let id = null;
  try {
    id = JSON.parse(raw)?.id ?? null;
  } catch {
    return; // a malformed echo drops one tap, it does not take the bot down
  }

  const feature = resolveFeatureMenuSelection(id);
  if (!feature) return;

  await sendFeatureExample(bot.sock, msg.key.remoteJid, feature.id);
});

// Stop cleanly on Ctrl-C: unwind patches, close the socket.
installGracefulShutdown(bot, (code) => process.exit(code));
