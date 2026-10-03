/**
 * Per-message throughput benchmark.
 *
 *   node --expose-gc bench/message-throughput.mjs [messages] [chats] [trials]
 *
 * Measures the plugin chain's overhead on `messages.upsert` — the one hot path
 * every bot pays on every inbound message. It isolates the framework cost from
 * real I/O by emitting synthetic batches to a fake socket.
 *
 * Method, because the first version of this file reported nonsense:
 *
 *   - A single timed run on a GC'd heap measures the *collector*, not the code.
 *     Each trial therefore runs the full batch set, and the **minimum** across
 *     trials is reported — the minimum is the run that was not interrupted.
 *   - Every trial is preceded by an explicit `global.gc()` when the process was
 *     started with `--expose-gc`, so one trial's garbage cannot inflate the next.
 *   - The bare emitter is measured in the same process under the same conditions
 *     and subtracted, so the number is framework overhead, not emit cost.
 *
 * A deployment sees many chats, not one. That matters because the memory
 * plugin's full sweep is O(chats), which is why the chats count is a parameter
 * rather than a constant.
 */

import { EventEmitter } from 'node:events';

import { NyxBaileys } from '../dist/index.js';
import { silentLogger } from '../dist/utils/logger.js';

const TOTAL = Number(process.argv[2] ?? 100_000);
const CHATS = Number(process.argv[3] ?? 500);
const TRIALS = Number(process.argv[4] ?? 7);
const BATCH = 50;
const batches = Math.floor(TOTAL / BATCH);

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

/**
 * Every message, pre-built, one array per batch.
 *
 * Built up front and outside the timed region so no allocation is charged to
 * the measurement. Note that the jid is derived from a *global* counter: the
 * obvious `i % CHATS` over a per-batch index only ever reaches `BATCH` distinct
 * chats, so asking for 500 chats silently benchmarked 50 — which is exactly the
 * shape that hides a per-chat cost.
 */
const batchesData = Array.from({ length: batches }, (_, b) =>
  Array.from({ length: BATCH }, (_, i) => {
    const n = b * BATCH + i;
    return {
      key: { remoteJid: `chat-${n % CHATS}@s.whatsapp.net`, id: `m${n}`, fromMe: false },
      messageTimestamp: 1_700_000_000,
      message: { conversation: `hello world ${n}` },
    };
  }),
);

const client = new NyxBaileys({ logLevel: 'silent' });

function build(withPlugins) {
  const sock = fakeSocket();
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
  for (const plugin of withPlugins) plugin.apply(ctx);
  return sock;
}

/** Run the full batch set once and return elapsed ms. */
const pass = (sock) => {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < batches; i += 1) sock.ev.emit('messages.upsert', { messages: batchesData[i] });
  return Number(process.hrtime.bigint() - t0) / 1e6;
};

/** Minimum and median of `trials` passes over a freshly built socket. */
const measure = (plugins) => {
  const samples = [];
  for (let t = 0; t < TRIALS; t += 1) {
    const sock = build(plugins);
    pass(sock); // warm-up pass, not recorded
    settleGc();
    samples.push(pass(sock));
  }
  samples.sort((a, b) => a - b);
  return { min: samples[0], median: samples[(samples.length / 2) | 0], max: samples[samples.length - 1] };
};

const plugins = client.plugins();
const bare = measure([]);
const chain = measure(plugins);

const line = (label, r) =>
  `  ${label.padEnd(14)} min ${r.min.toFixed(1).padStart(7)} ms   median ${r.median.toFixed(1).padStart(7)} ms`;

console.log(
  `${TOTAL.toLocaleString()} messages (${batches} batches x ${BATCH}) across ${CHATS} chats, ${TRIALS} trials`,
);
console.log(hasGc ? 'gc: forced between trials' : 'gc: not forced (run with --expose-gc for stable numbers)');
console.log(line('bare emitter', bare));
console.log(line('default chain', chain));
console.log(
  `  overhead      min ${(chain.min - bare.min).toFixed(1).padStart(7)} ms   ` +
    `${(((chain.min - bare.min) * 1000) / TOTAL).toFixed(3)} µs/message (best case)`,
);
