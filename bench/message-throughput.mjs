/**
 * Per-message throughput benchmark.
 *
 *   node bench/message-throughput.mjs [messages]
 *
 * Measures the plugin chain's overhead on `messages.upsert` — the one hot path
 * every bot pays on every inbound message. It isolates the framework cost from
 * real I/O by emitting synthetic batches to a fake socket.
 *
 * Baseline to beat (2026-10-03, before the sweep fix): 100k messages cost 192 ms
 * of plugin overhead (~1.9 µs/message), most of it memory GC sweeping the whole
 * history map once per message.
 */

import { EventEmitter } from 'node:events';

import { NyxBaileys } from '../dist/index.js';
import { silentLogger } from '../dist/utils/logger.js';

const TOTAL = Number(process.argv[2] ?? 100_000);
const BATCH = 50;
// A real deployment sees many chats, not one. This matters because memory GC's
// sweep walks every chat, so its cost is O(chats) per call — the whole point of
// running it once per batch rather than once per message.
const CHATS = Number(process.argv[3] ?? 500);

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
    relayMessage() {
      return { key: { id: 'R' } };
    },
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

async function run(withPlugins) {
  const sock = fakeSocket();
  if (withPlugins) {
    const ctx = {
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
    };
    for (const plugin of client.plugins()) await plugin.apply(ctx);
  }

  const batches = TOTAL / BATCH;
  for (let i = 0; i < Math.min(100, batches); i += 1) sock.ev.emit('messages.upsert', { messages });

  const t0 = process.hrtime.bigint();
  for (let i = 0; i < batches; i += 1) sock.ev.emit('messages.upsert', { messages });
  const t1 = process.hrtime.bigint();
  return Number(t1 - t0) / 1e6;
}

const bare = await run(false);
const full = await run(true);
const overhead = full - bare;

console.log(`${TOTAL.toLocaleString()} messages (${TOTAL / BATCH} batches x ${BATCH}) across ${CHATS} chats`);
console.log(`  bare emitter : ${bare.toFixed(0)} ms`);
console.log(`  default chain: ${full.toFixed(0)} ms`);
console.log(`  overhead     : ${overhead.toFixed(0)} ms  (${((overhead * 1000) / TOTAL).toFixed(2)} µs/message)`);
