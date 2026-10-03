/**
 * Super Baileys — entry point.
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
import { SuperBaileys, createSuperBaileys } from './superBaileys.js';
import { flowEngine } from './plugins/flow.js';
import { compose, table } from './utils/compose.js';
import type { Flow } from './plugins/flow.js';
import type { SuperOptions } from './utils/types.js';

/* ── public surface ─────────────────────────────────────────────── */

export { SuperBaileys, createSuperBaileys } from './superBaileys.js';

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
export { patch, patchAll, Disposables } from './core/intercept.js';

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

export { code, compose, preformatted, table } from './utils/compose.js';
export { createLogger, silentLogger } from './utils/logger.js';

/* ── extended surface (added by the module layer) ────────────────── */

export * from './adapters/index.js';
export * from './multi/index.js';
export * from './security/index.js';

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
    title: 'Super Baileys',
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

  const client = new SuperBaileys(options);
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
          { title: 'Live from Super Baileys', rows: ['Session open', 'Plugins applied: see below'] },
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

  // Hold the process open until the socket dies.
  sock.ev.on('connection.update', (u: { connection?: string }) => {
    if (u.connection === 'close') {
      console.error('socket closed');
      void client.dispose();
    }
  });

  return 0;
}

export { supportFlow, demoForm as form, demoCarousel as carousel, demoTable as tableFlowDemo };

// Only run when invoked directly, not when imported.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() ?? '')) {
  main().then((code) => {
    if (code !== 0) process.exit(code);
  });
}

export default main;
export { createSuperBaileys as createClient, DisconnectReason };
