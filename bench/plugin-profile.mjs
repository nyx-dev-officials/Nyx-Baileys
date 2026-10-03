/**
 * Per-plugin cost on the inbound hot path.
 *
 *   node --expose-gc bench/plugin-profile.mjs [messages] [chats] [trials]
 *
 * `message-throughput.mjs` answers "what does the whole chain cost?". This
 * answers "which plugin costs it".
 *
 * Each plugin is measured **in isolation** on its own socket rather than
 * cumulatively down the chain. Cumulative attribution looks natural and is
 * wrong: an attributed delta is a difference between two noisy numbers, so a
 * GC pause in one step shows up as a large negative "saving" in the next. One
 * measurement per plugin, minimum across trials, has no such coupling.
 */

import { EventEmitter } from 'node:events';

import { NyxBaileys } from '../dist/index.js';
import { silentLogger } from '../dist/utils/logger.js';

const TOTAL = Number(process.argv[2] ?? 100_000);
const CHATS = Number(process.argv[3] ?? 500);
const TRIALS = Number(process.argv[4] ?? 7);
const BATCH = 50;

const hasGc = typeof globalThis.gc === 'function';
const settleGc = () => {
  if (hasGc) {
    globalThis.gc();
    globalThis.gc();
  }
};

const fakeSocket = () => {
  const ev = new EventEmitter();
  ev.setMaxListeners(0);
  return {
    ev,
    sent: [],
    sendMessage(jid, content) {
      this.sent.push({ jid, content });
      return { key: { id: `S-${this.sent.length}`, remoteJid: jid } };
    },
    relayMessage: () => ({ key: { id: 'R' } }),
    sendPresenceUpdate() {},
    end() {},
    user: { id: 'bench@s.whatsapp.net' },
    logger: silentLogger,
    authState: { creds: {}, keys: {} },
  };
};

const messages = Array.from({ length: BATCH }, (_, i) => ({
  key: { remoteJid: `chat-${i % CHATS}@s.whatsapp.net`, id: `m${i}`, fromMe: false },
  messageTimestamp: 1_700_000_000,
  message: { conversation: `hello world ${i}` },
}));

const client = new NyxBaileys({ logLevel: 'silent' });
const batches = Math.floor(TOTAL / BATCH);

const makeCtx = (sock) => ({
  sock,
  state: {
    name: 'bench',
    init: async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => {} }),
    get: (_k, fallback) => fallback,
    set: async () => {},
  },
  options: {},
  log: client.log,
  onDispose: () => {},
});

const pass = (sock) => {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < batches; i += 1) sock.ev.emit('messages.upsert', { messages });
  return Number(process.hrtime.bigint() - t0) / 1e6;
};

/** Minimum-of-trials cost of one plugin list, above the bare emitter. */
const measure = (plugins) => {
  const samples = [];
  for (let t = 0; t < TRIALS; t += 1) {
    const sock = fakeSocket();
    for (const plugin of plugins) plugin.apply(makeCtx(sock));
    pass(sock);
    settleGc();
    samples.push(pass(sock));
  }
  return Math.min(...samples);
};

const bare = measure([]);

console.log(
  `${TOTAL.toLocaleString()} messages (${batches} batches x ${BATCH}) across ${CHATS} chats, ${TRIALS} trials each`,
);
console.log(hasGc ? 'gc: forced between trials\n' : 'gc: not forced (use --expose-gc)\n');
console.log(`  bare emitter: ${bare.toFixed(1)} ms (${((bare * 1000) / TOTAL).toFixed(3)} µs/msg)\n`);
console.log('  plugin            own ms   own/message');
console.log('  ' + '-'.repeat(42));

const rows = [];
for (const plugin of client.plugins()) {
  const total = measure([plugin]);
  const own = total - bare;
  rows.push({ name: plugin.name, own, per: (own * 1000) / TOTAL });
  console.log(
    `  ${plugin.name.padEnd(16)} ${own.toFixed(1).padStart(7)} ms ${((own * 1000) / TOTAL).toFixed(3).padStart(11)} µs`,
  );
}

// Everything together, to check the parts do not hide a superlinear interaction.
const all = measure(client.plugins());
console.log('  ' + '-'.repeat(42));
console.log(
  `  ${'sum of parts'.padEnd(16)} ${rows.reduce((s, r) => s + Math.max(0, r.own), 0).toFixed(1).padStart(7)} ms`,
);
console.log(
  `  ${'whole chain'.padEnd(16)} ${(all - bare).toFixed(1).padStart(7)} ms ${(((all - bare) * 1000) / TOTAL).toFixed(3).padStart(11)} µs`,
);
