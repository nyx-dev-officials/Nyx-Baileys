/**
 * Shared test doubles.
 *
 * Everything here is a fake: no sockets, no timers longer than a few dozen
 * milliseconds, no network. `fakeSocket()` mirrors the shape plugins actually
 * touch — the emitter (`on`/`off`/`emit`) and the outbound methods they patch.
 */

import { EventEmitter } from 'node:events';

import { silentLogger } from '../dist/utils/logger.js';

export { silentLogger };

/* ── emitter ─────────────────────────────────────────────────────────── */

/**
 * Baileys' `.ev` is a small emitter with `on`/`off`/`emit`. Node's
 * EventEmitter is a superset of that contract, which is exactly what we want:
 * anything the framework does to the real emitter has to work here too.
 */
export class FakeEmitter extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
  }
}

export const fakeEv = () => new FakeEmitter();

/* ── socket ──────────────────────────────────────────────────────────── */

/**
 * A stand-in for the Baileys socket.
 *
 * `sendMessage` / `relayMessage` are the two outbound methods every plugin
 * under test patches, so they exist as real (own, writable, configurable)
 * properties — that is what `patch()` requires.
 */
export function fakeSocket(overrides = {}) {
  const sock = {
    ev: fakeEv(),

    /** Every outbound send that made it past the wrappers, in order. */
    sent: [],

    sendMessage(jid, content, extra) {
      sock.sent.push({ jid, content, extra, at: Date.now(), via: 'sendMessage' });
      return { key: { id: `SENT-${sock.sent.length}`, remoteJid: jid }, message: content };
    },

    relayMessage(jid, messageId) {
      sock.sent.push({ jid, messageId, at: Date.now(), via: 'relayMessage' });
      return { key: { id: `RELAY-${sock.sent.length}`, remoteJid: jid } };
    },

    // Returns a promise because the real socket does. A double that returns
    // undefined makes any plugin doing `sendPresenceUpdate(...).then(...)` throw
    // a TypeError that has nothing to do with the plugin under test.
    async sendPresenceUpdate(presence, jid) {
      sock.presence = presence;
      sock.presenceJid = jid;
      return undefined;
    },

    groupParticipantsUpdate(groupId, participants, action) {
      sock.ev.emit('group-participants.update', { id: groupId, participants, action });
    },

    end(error) {
      sock.ended = error ?? null;
      return undefined;
    },

    user: { id: 'test@s.whatsapp.net', name: 'test' },
    logger: silentLogger,
    authState: { creds: {}, keys: {} },

    ...overrides,
  };

  return sock;
}

/* ── plugin context ──────────────────────────────────────────────────── */

/** A logger that records instead of printing. */
export function captureLogger(scope = 'test') {
  const entries = [];
  const make = (name) => {
    const rec = (level) => (msg, meta) => {
      entries.push({ level, scope: name, msg, meta });
    };
    return {
      error: rec('error'),
      warn: rec('warn'),
      info: rec('info'),
      debug: rec('debug'),
      child: (child) => make(`${name}:${child}`),
      entries,
      /** Entries matching a predicate — convenient for asserting on warns. */
      find: (pred) => entries.filter(pred),
      /** True if any entry contains `needle` in its message. */
      has: (needle) => entries.some((e) => String(e.msg).includes(needle)),
    };
  };
  return make(scope);
}

/**
 * A `PluginContext` plus the disposer stack, so a test can assert on the
 * wrapped socket before and after `dispose()`.
 */
export function pluginContext(sock, options = {}) {
  const disposers = [];
  const log = options.log ?? captureLogger();
  const state = options.state ?? {
    name: 'fake-store',
    init: async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => {} }),
    get: (_k, fallback) => fallback,
    set: async () => {},
  };

  const ctx = {
    sock,
    state,
    options: { logLevel: 'silent', ...options.options },
    log,
    onDispose: (fn) => disposers.push(fn),
  };

  return {
    ctx,
    log,
    state,
    get disposerCount() {
      return disposers.length;
    },
    /** Reverse-order unwind, matching `Disposables.dispose()`. */
    dispose() {
      while (disposers.length) {
        const fn = disposers.pop();
        try {
          fn?.();
        } catch {
          /* a failing disposer must not block the rest, same as the real one */
        }
      }
    },
  };
}

/** Apply a plugin against a fresh socket and return everything to assert on. */
export function applyPlugin(plugin, sock = fakeSocket(), options = {}) {
  const harness = pluginContext(sock, options);
  plugin.apply(harness.ctx);
  return { sock, log: harness.log, ctx: harness.ctx, dispose: harness.dispose };
}

/* ── timing ──────────────────────────────────────────────────────────── */

/** Let pending microtasks and `setImmediate` callbacks run. */
export const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Real, tiny sleep. Kept in one place so the suite's time budget is visible. */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ── message fixtures ────────────────────────────────────────────────── */

export const CHAT = '111@s.whatsapp.net';
export const GROUP = '123-456@g.us';

/** A minimal but structurally faithful `WAMessage`. */
export function wmMessage({
  jid = CHAT,
  id = 'MSG1',
  fromMe = false,
  message = { conversation: 'hi' },
  messageTimestamp = 1_700_000_000_000,
  participant,
} = {}) {
  return {
    key: { remoteJid: jid, id, fromMe, ...(participant ? { participant } : {}) },
    messageTimestamp,
    pushName: 'tester',
    message,
  };
}

/** Emit a `messages.upsert` batch. */
export function upsert(sock, messages) {
  sock.ev.emit('messages.upsert', { messages, type: 'notify' });
}

/** An inbound native-flow form submit, as rc14 delivers it. */
export function nativeFlowReply(jid, paramsJson, id = 'FLOWREPLY') {
  return wmMessage({
    jid,
    id,
    message: {
      interactiveResponseMessage: {
        nativeFlowResponseMessage: { paramsJson, version: 3 },
      },
    },
  });
}

/** A media message with a `messageAssociation`, for `parentKeyOf`. */
export function mediaMessage({
  jid = CHAT,
  id = 'M1',
  key = 'imageMessage',
  associationType,
  parentId,
  fileLength,
  mimetype = 'image/jpeg',
  rootContext,
} = {}) {
  const media = { mimetype };
  if (fileLength !== undefined) media.fileLength = fileLength;
  if (associationType !== undefined || parentId !== undefined) {
    media.contextInfo = {
      messageAssociation: {
        associationType,
        ...(parentId !== undefined ? { parentMessageKey: { id: parentId } } : {}),
      },
    };
  }
  const message = { [key]: media };
  if (rootContext !== undefined) message.messageContextInfo = rootContext;
  return wmMessage({ jid, id, message });
}

/** `{j}@s.whatsapp.net` participants, which is what group.ts filters for. */
export const pn = (n) => `${n}@s.whatsapp.net`;
export const lid = (n) => `${n}@lid`;

/* ── assertions helpers ──────────────────────────────────────────────── */

/** Parse a `messageParamsJson` string, failing loudly if it is not JSON. */
export function parseParams(raw, label = 'messageParamsJson') {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label} did not round-trip through JSON.parse: ${err.message} (${raw})`);
  }
}

/**
 * Display width, deliberately written as an explicit range table so it is not
 * a copy-paste of `src/utils/compose.ts`. Used to check that a rendered table
 * actually lines up.
 */
const WIDE_RANGES = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f9ff],
];

export function displayWidth(s) {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    w += WIDE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi) ? 2 : 1;
  }
  return w;
}

/**
 * Display column at which `cell` starts inside `line`. This is the honest way
 * to ask "are these columns aligned?" when cells are not all the same width.
 */
export function columnOf(line, cell) {
  const index = line.indexOf(cell);
  if (index === -1) {
    throw new Error(`columnOf: ${JSON.stringify(cell)} does not appear in ${JSON.stringify(line)}`);
  }
  return displayWidth(line.slice(0, index));
}