/**
 * Nyx-Baileys — entry point.
 *
 *   node dist/index.js --pair          pair a new number, prints the QR
 *   node dist/index.js                 connect and run the demo
 *
 * Exports the public surface plus a small `main()` that exercises the whole
 * stack: stealth identity, an anti-spam paced send, and a native-flow form.
 */

import { existsSync } from 'node:fs';

import { DisconnectReason } from '@whiskeysockets/baileys';

import { createCarouselFlow, createFormFlow, createTableFlow, infoRow, radioRow } from './core/nodes.js';
import { NyxBaileys, createNyxBaileys } from './nyxBaileys.js';
import { flowEngine } from './plugins/flow.js';
import { compose, table } from './utils/compose.js';
import type { Flow } from './plugins/flow.js';
import type { SuperOptions } from './utils/types.js';

/* ── public surface ─────────────────────────────────────────────── */

export { NyxBaileys, createNyxBaileys } from './nyxBaileys.js';

/**
 * Legacy aliases for the pre-rename name. Deprecated, kept for one release —
 * see `src/nyxBaileys.ts`.
 */
export {
  NyxBaileys as SuperBaileys,
  createNyxBaileys as createSuperBaileys,
} from './nyxBaileys.js';

export {
  buildFlowMessageParams,
  createAlbumContainer,
  createCarouselFlow,
  createFormFlow,
  createTableFlow,
  createEdit,
  infoRow,
  proto,
  radioRow,
  toFlowMessage,
  toNatives,
} from './core/nodes.js';

export { createSessionStore, FileSessionStore, MemorySessionStore } from './core/session-store.js';
export { DEFAULT_BROWSER, desktopUserAgent, resolveWebVersion } from './core/socket.js';
export { patch, patchAll, Disposables, type PatchSet } from './core/intercept.js';

/* ── reference-fork features (ported) ────────────────────────────── */
export { ClockSync } from './core/clock.js';
export type { ClockSample, ClockSyncOptions, ClockSyncStats } from './core/clock.js';
export { DeliveryTracker } from './core/delivery.js';
export type { DeliveryStats, DeliveryTrackerOptions } from './core/delivery.js';
export {
  MessageRetryReason,
  MAC_ERROR_CODES,
  parseRetryReason,
  isMacError,
  isRetryable,
  describeRetryReason,
} from './core/retry.js';
export {
  NyxError,
  SessionNotFoundError,
  NotConnectedError,
  InvalidSessionIdError,
  QueueFullError,
  BurstCeilingError,
  PayloadTooLargeError,
  isNyxError,
} from './core/errors.js';
export { buildAlbumParent, inferAlbumCounts, sendAlbum } from './core/album.js';
export type {
  AlbumItemContent,
  AlbumSendSocket,
  SendAlbumOptions,
  SendAlbumResult,
} from './core/album.js';
export {
  bareJid,
  canonicalThreadKey,
  deviceOf,
  isBroadcast,
  isGroup,
  isLid,
  isNewsletter,
  isPn,
  kindOf,
  phoneOf,
  sameUser,
  toLidJid,
  toPnJid,
  userOf,
} from './core/jid.js';
export type { JidKind } from './core/jid.js';

/* ── pure bot primitives (also on `nyx-baileys/lite`) ───────────────── */

export {
  CorruptStoreError,
  JsonStore,
  openStore,
} from './core/store.js';
export type {
  Document,
  JsonStoreOptions,
  JsonStoreStats,
} from './core/store.js';

export {
  CronError,
  Scheduler,
  cronMatches,
  nextCronTime,
  parseCron,
} from './core/tasks.js';
export type {
  CronSchedule,
  ScheduledTask,
  TaskKind,
  TaskOptions,
} from './core/tasks.js';

export { ConversationStore } from './core/conversation.js';
export type {
  ConversationEntry,
  ConversationOptions,
} from './core/conversation.js';

export {
  extractMentions,
  extractQuoted,
  extractText,
  parseCommandArgs,
  parseIncoming,
} from './core/mention.js';
export type {
  ParseOptions,
  ParsedCommand,
  QuotedMessage,
} from './core/mention.js';

export { antiSpam } from './plugins/antiSpam.js';
export { stealth } from './plugins/stealth.js';
export { warmup, rampFor } from './plugins/warmup.js';
export { lidRouter } from './plugins/lid.js';
export { albumHandler } from './plugins/album.js';
export { groupGuard } from './plugins/group.js';
export { flowEngine } from './plugins/flow.js';
export { memoryGc } from './plugins/memory.js';
export { mediaStreamer } from './plugins/media-stream.js';
export { autoReconnect } from './plugins/reconnect.js';
export { sessionRepair } from './plugins/session-repair.js';
export { clockSync } from './plugins/clock-sync.js';
export { delivery } from './plugins/delivery.js';

/* ── opt-in anti-ban plugin pack (see docs/ANTIBAN.md) ───────────── */
export {
  antibanPlugins,
  contentVariation,
  humanEntropy,
  legitimacySignals,
  presenceChoreography,
  readReceiptVariancePlugin,
} from './plugins/antiban.js';
export * from './antiban/index.js';
export * from './toolkit/index.js';

export { code, compose, preformatted, table } from './utils/compose.js';
export { createLogger, silentLogger } from './utils/logger.js';
export * from './utils/text.js';
export * from './utils/format.js';
export * from './utils/random.js';
export * from './utils/time.js';
export * from './utils/args.js';
export * from './utils/cache.js';
export * from './utils/queue.js';
export * from './utils/validate.js';

/* ── engine surface ────────────────────────────────────────────────────
 *
 * Nyx-Baileys is a **superset** of upstream, not a replacement for it. Every
 * symbol Baileys exports is re-exported here, so an application can depend on
 * `nyx-baileys` alone and still reach `proto`, `useMultiFileAuthState`,
 * `DisconnectReason`, `downloadMediaMessage` and the rest — while the decorated
 * socket, plugins and integrations come from this package.
 *
 * A local export shadows a star export of the same name, so the explicit
 * `proto` and plugin exports above win over upstream's identical `proto`.
 */

export * from '@whiskeysockets/baileys';

/* ── extended surface (added by the module layer) ────────────────── */

export * from './multi/index.js';
export * from './security/index.js';

/* ── opt-in feature plugins + integrations ──────────────────────────
 *
 * Ten feature plugins (polls, reactions, presence, read receipts, status,
 * newsletters, call log, commands, webhooks, metrics) and the keyless
 * integrations layer. None is in the default chain — each encodes a product
 * decision — but all are now reachable from the root instead of only from
 * `dist/`. `featurePlugins()` returns them pre-sorted by `order`.
 */

export * from './plugins/index.js';
export * from './integrations/index.js';

/* ── bot host (script-author surface) ─────────────────────────────── */
export { createNyxBot, loadCommands, collectSpecs, installGracefulShutdown } from './bot/index.js';
export type { NyxBot, NyxBotOptions, LoadedCommand, LoadCommandsOptions } from './bot/index.js';

export {
  firstMedia,
  associationOf,
  contextOf,
  mediaKeyOf,
  mimeOf,
  parentKeyOf,
  sizeOf,
} from './core/media.js';

export { carouselCardWithMedia } from './core/nodes.js';
export type * from './utils/types.js';

/* ── demo flow ──────────────────────────────────────────────────── */

const supportFlow: Flow = {
  id: 'support',
  entry: 'start',
  capture: true,
  steps: [
    {
      name: 'start',
      match: /^(help|menu|support)$/i,
      async run(ctx) {
        await ctx.reply(
          compose({
            sections: [{ title: 'What do you need?', rows: ['Order status', 'Report a bug', 'Talk to a human'] }],
            footer: 'Reply with the words, or use the form.',
          }),
        );
      },
    },
    {
      name: 'order',
      match: /order|track/i,
      async run(ctx) {
        ctx.state.order = `so_${Date.now()}`;
        await ctx.reply(
          compose({
            sections: [{ title: 'Find your order', rows: ['I have an order number', 'I do not have one'] }],
            footer: 'This is the second step of the flow — state survives between steps.',
          }),
        );
        ctx.goto('order.wait');
      },
    },
    {
      name: 'order.wait',
      async run(ctx) {
        // Runs again on the next message while this step is active.
        if (/^\d{4,}$/.test(ctx.text.trim())) {
          await ctx.reply(`Got it — looking up ${ctx.text.trim()}.`);
          ctx.end();
          return;
        }
        await ctx.reply('Send the order number as digits, or reply `cancel` to stop.');
      },
    },
    {
      name: 'human',
      match: /human|agent|person/i,
      async run(ctx) {
        await ctx.reply('Putting you in the queue. Someone will pick this up shortly.');
        ctx.end();
      },
    },
  ],
};

/* ── demo UI ────────────────────────────────────────────────────── */

/** A native-flow form: radio selection plus free text plus a footer. */
export function demoForm(): ReturnType<typeof createFormFlow> {
  return createFormFlow({
    title: 'Nyx-Baileys',
    body: 'This is a nativeFlowMessage — data entry rendered by the client, not a template.',
    ctaLabel: 'Submit',
    sections: [
      {
        title: 'Deploy target',
        highlightLabel: 'REQUIRED',
        rows: [
          radioRow('Vercel', 'vercel', 'Serverless — cheapest to run'),
          radioRow('Railway', 'railway', 'Long-lived container, good for websockets'),
          radioRow('Home VPS', 'vps', 'Full control, you own the uptime'),
        ],
      },
      {
        title: 'Add-ons',
        rows: [
          radioRow('Postgres session store', 'pg', 'Durable auth state across restarts'),
          radioRow('Flow engine', 'flow', 'Regex-routed conversational trees'),
          radioRow('Anti-spam pacing', 'anti', 'Jittered queue with a burst ceiling'),
        ],
      },
    ],
    footer: 'Send your note as a reply — any text works.',
  });
}

/** A horizontally scrolling carousel. */
export function demoCarousel(): ReturnType<typeof createCarouselFlow> {
  return createCarouselFlow({
    title: 'Pick a region',
    body: 'Each card is a native flow row with a horizontal scroll.',
    ctaLabel: 'Deploy there',
    cards: [
      { id: 'sg', title: 'Singapore', description: 'Lowest RTT to WA servers', footer: '$5/mo' },
      { id: 'de', title: 'Frankfurt', description: 'EU data residency', footer: '$7/mo' },
      { id: 'us', title: 'Oregon', description: 'US West coast', footer: '$6/mo' },
      { id: 'id', title: 'Jakarta', description: 'Local peering to ID nodes', footer: '$4/mo' },
    ],
  });
}

/** A read-only data sheet — renders as a native table, not monospace text. */
export function demoTable(): ReturnType<typeof createTableFlow> {
  return createTableFlow({
    title: 'Package comparison',
    columns: ['Package', 'Sessions', 'RAM', 'Price'],
    rows: [
      ['starter', '1', '512 MB', '$4'],
      ['team', '10', '2 GB', '$18'],
      ['fleet', '100', '8 GB', '$120'],
    ],
  });
}

/* ── main ───────────────────────────────────────────────────────── */

function parseArgs(argv: readonly string[]): { pair: boolean; target: string | null; runDemo: boolean } {
  const flag = (name: string): boolean => argv.includes(`--${name}`);
  const i = argv.indexOf('--to');
  return {
    pair: flag('pair'),
    target: i >= 0 ? argv[i + 1] ?? null : null,
    runDemo: !flag('pair'),
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const { pair, target, runDemo } = parseArgs(argv);
  const sessionDir = process.env.SESSION_DIR ?? './session';

  const options: SuperOptions = {
    sessionDir,
    logLevel: (process.env.LOG_LEVEL as SuperOptions['logLevel']) ?? 'info',
    warmupDays: Number(process.env.WARMUP_DAYS ?? 0),
    printQRInTerminal: true,
    antiSpam: {
      minGapMs: Number(process.env.MIN_GAP_MS ?? 2_500),
      jitterMs: Number(process.env.JITTER_MS ?? 4_000),
      maxPerMinute: Number(process.env.MAX_PER_MIN ?? 20),
    },
  };

  const client = new NyxBaileys(options);
  // The demo conversation tree rides alongside the defaults.
  client.registerPlugin(flowEngine([supportFlow]));

  await client.connect();
  const sock = client.sock;

  // Pairing. Baileys renders the QR itself when printQRInTerminal is set, so
  // there is no separate printQR export to drive — we just wait for `creds`.
  if (pair || !existsSync(`${sessionDir}/creds.json`)) {
    if (!sock.authState.creds.registered) {
      console.log('\nScan the QR with WhatsApp → Linked devices.\n');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          console.error('\nPairing window closed. Re-run with --pair if it did not scan.');
          resolve();
        }, 180_000);
        const off = client.on('creds.update', () => {
          if (sock.authState.creds.registered) {
            clearTimeout(timer);
            off();
            resolve();
          }
        });
      });
      if (!sock.authState.creds.registered) {
        await client.dispose();
        return 1;
      }
      console.log('\npaired.\n');
    }
  }

  // Wait for the socket to report a live connection before doing any work.
  const ready = await new Promise<boolean>((resolve) => {
    const check = setInterval(() => {
      if (client.connectionState.state === 'open') {
        clearInterval(check);
        resolve(true);
      }
    }, 250);
    setTimeout(() => {
      clearInterval(check);
      resolve(false);
    }, 60_000).unref?.();
  });

  if (!ready) {
    console.error('socket did not open in time');
    await client.dispose();
    return 1;
  }

  const identity = (sock as unknown as { __identity: { browser: string[]; userAgent: string } }).__identity;
  console.log(`\nconnected as ${sock.user?.id ?? 'unknown'}`);
  console.log(`identity: ${identity.browser.join('/')} — ${identity.userAgent}\n`);

  if (runDemo && target) {
    const stats = (sock as unknown as { __antispam?: { stats: () => unknown } }).__antispam?.stats();
    console.log('pacing before send:', stats);

    // 1. Text, paced by the anti-spam queue.
    await sock.sendMessage(target, {
      text: compose({
        sections: [
          { title: 'Live from Nyx-Baileys', rows: ['Session open', 'Plugins applied: see below'] },
        ],
      }),
    });

    // 2. Native-flow form — real data entry UI, not a template.
    await sock.sendMessage(target, demoForm() as never);

    // 3. Carousel and table.
    await sock.sendMessage(target, demoCarousel() as never);
    await sock.sendMessage(target, demoTable() as never);

    // 4. A monospace block, because prose mangles code without it.
    await sock.sendMessage(target, {
      text: `\`\`\`\npatches active: ${client.patchCount}\nplugins:       ${client.applied.join(', ')}\n\`\`\``,
    });

    const store = (sock as unknown as { store?: { stats: () => unknown } }).store;
    console.log('memory:', store?.stats());
    console.log('pacing after send:', (sock as unknown as { __antispam?: { stats: () => unknown } }).__antispam?.stats());
  } else if (runDemo) {
    console.log('ready. pass --to <jid> to run the send demo, or --pair to pair.\n');
    console.log(table(['helper', 'on socket'], [
      ['resolveJid(target)', 'lid/pn resolution'],
      ['flows.add / flows.active', 'conversation trees'],
      ['downloadMedia / streamMedia', 'guarded media fetch'],
      ['albums / expandAlbum', 'multi-media containers'],
      ['groupAlerts', 'group policy signals'],
      ['health()', 'disconnect counters'],
    ]));
  }

  // Hold the process open until the socket dies. This goes through the host's
  // single connection-owner (`onConnection`) rather than adding a second
  // `connection.update` listener: the old duplicate disposed the client on
  // *every* close, tearing the socket out from under the reconnect plugin's
  // rebuild. Only a terminal logout — which no reconnect can fix — ends it.
  client.onConnection((phase, payload) => {
    if (phase === 'close' && payload === DisconnectReason.loggedOut) {
      console.error('logged out; a fresh pairing is required');
      void client.dispose();
    }
  });

  return 0;
}

export { supportFlow, demoForm as form, demoCarousel as carousel, demoTable as tableFlowDemo };

export { createNyxBaileys as createClient, DisconnectReason };

/**
 * Entry point for the bundled demo — exported **by name only**.
 *
 * There is deliberately no default export here. A library whose default export
 * is a demo runner is a trap: an application writing
 * `import makeWASocket from 'nyx-baileys'` gets this function instead of the
 * socket factory, and because it is `async` the assignment yields a Promise —
 * so the failure surfaces far from the cause, as
 * `Cannot read properties of undefined (reading 'on')` when the socket's event
 * emitter is accessed, rather than as an import error.
 *
 * Reach the factory with `import { makeWASocket } from 'nyx-baileys'`.
 */
