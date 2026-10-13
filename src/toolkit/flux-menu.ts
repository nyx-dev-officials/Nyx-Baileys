/**
 * The FLUX command catalogue as an interactive menu.
 *
 * `flux menu` used to send the feature-button demo sheet, so the ~1,800 real
 * commands lived nowhere a phone could browse them. This module turns the
 * registry into a two-level menu: a native `single_select` of categories,
 * then a formatted text list per category.
 *
 * Two hard limits shape the design, both protocol-side:
 *
 * - Sections stay at eight or fewer with short titles. Native menus are a
 *   scrollable sheet, so rows can run long — but sections cannot, so the 35
 *   families are bucketed, never listed flat.
 * - A family list caps at fifty commands with an overflow line. `timezone`
 *   alone has 418; one message per tap must stay readable and well under the
 *   message size ceiling.
 *
 * Taps arrive as `messages.upsert` with the row id in
 * `nativeFlowResponseMessage.paramsJson`. `fluxMenuTap()` routes ids in the
 * `flux:cat:` namespace to their family list and ignores everything else, so
 * feature-demo taps and foreign buttons pass through untouched.
 */

import type { WAMessageKey } from '@whiskeysockets/baileys';

import {
  readMenuSelection,
  sendCategoryMenu,
  type MenuCategory,
} from './category-menu.js';
import type { Command, CommandRegistry } from './command-registry.js';
import type { CoreSocket, Plugin } from '../utils/types.js';

/** Row-id namespace for catalogue taps. Anything outside it is not ours. */
export const FLUX_MENU_TAP_PREFIX = 'flux:cat:';

/** How many commands one family page carries. */
export const FAMILY_LIST_CAP = 25;

/** Row-id prefix for a family page tap. */
export const FLUX_PAGE_TAP_PREFIX = 'flux:page:';

/**
 * Classic read-more collapse: LTR marks WhatsApp folds away. Written as an
 * explicit escape, never a pasted invisible character.
 */
const READMORE = '\u200E'.repeat(4000);

const SMALL_CAPS_FROM = 'abcdefghijklmnopqrstuvwxyz1234567890';
const SMALL_CAPS_TO = 'ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘqʀꜱᴛᴜᴠᴡxʏᴢ1234567890';

/**
 * Lowercase alphanumerics into their small-caps lookalikes.
 *
 * Display-only, headings only. Routing keys, counts and command names stay
 * ASCII — a styled id breaks tap matching on-device, and no unit test catches
 * device-only failures.
 */
export function smallCaps(text: string): string {
  return [...text.toLowerCase()]
    .map((ch) => {
      const i = SMALL_CAPS_FROM.indexOf(ch);
      return i >= 0 ? SMALL_CAPS_TO[i]! : ch;
    })
    .join('');
}

/** A registry-shaped source. `CommandRegistry` satisfies this directly. */
export interface CatalogueSource {
  list(filter?: { family?: string; prefix?: string }): Pick<
    Command,
    'name' | 'summary' | 'effect' | 'family' | 'usage'
  >[];
}

interface Bucket {
  readonly title: string;
  readonly families: readonly string[];
}

const BUCKETS: readonly Bucket[] = [
  { title: 'Text & Style', families: ['aesthetic', 'encode', 'decode', 'case'] },
  { title: 'Games & Fun', families: ['game', 'random'] },
  { title: 'Media Studio', families: ['media'] },
  { title: 'Assistant', families: ['assistant'] },
  { title: 'System & Ops', families: ['ops', 'ops2', 'utility', 'http', 'live-api', 'core'] },
  { title: 'Security', families: ['security', 'hash'] },
  { title: 'World & Data', families: ['timezone', 'currency', 'country', 'color'] },
  {
    title: 'Measure & Math',
    families: [
      'unit-data', 'unit-length', 'unit-area', 'unit-volume', 'unit-pressure',
      'unit-energy', 'unit-mass', 'unit-time', 'unit-angle', 'unit-speed',
      'unit-frequency', 'unit-temperature', 'convert', 'math', 'mathfn',
    ],
  },
];

const DISPLAY_NAMES: Record<string, string> = {
  ops2: 'Ops 2',
  mathfn: 'Math Functions',
  'live-api': 'Live API',
  http: 'HTTP',
};

const FLAVORS: Record<string, string> = {
  aesthetic: 'styles & ciphers',
  encode: 'text encodings',
  decode: 'decoders',
  case: 'case tools',
  game: 'games & social',
  random: 'generators',
  media: 'audio, video & image',
  assistant: 'notes, reminders, utils',
  ops: 'system operations',
  ops2: 'telemetry & reliability',
  utility: 'everyday helpers',
  core: 'catalogue itself',
  http: 'status codes',
  'live-api': 'live web data',
  security: 'crypto & validation',
  hash: 'checksums & digests',
  timezone: 'world clocks',
  currency: 'money & rates',
  country: 'country data',
  color: 'palettes & converters',
  convert: 'quick convert',
  math: 'calculator',
  mathfn: 'math functions',
};

/** One emoji per family, so a sheet is recognisable before it is read. */
const FAMILY_EMOJI: Record<string, string> = {
  aesthetic: '🎨', encode: '🔒', decode: '🔓', case: '🔤',
  game: '🎮', random: '🎲', media: '🎬', assistant: '🤖',
  ops: '🛠', ops2: '📡', utility: '🔧', http: '🌐', 'live-api': '📊', core: '◈',
  security: '🛡', hash: '#️⃣',
  timezone: '🕰', currency: '💱', country: '🌍', color: '🎨',
  'unit-data': '📦', 'unit-length': '📏', 'unit-area': '🟫', 'unit-volume': '🧊',
  'unit-pressure': '💥', 'unit-energy': '⚡', 'unit-mass': '⚖️', 'unit-time': '⏱',
  'unit-angle': '📐', 'unit-speed': '🏎', 'unit-frequency': '📻',
  'unit-temperature': '🌡', convert: '🔄', math: '🧮', mathfn: '📈',
};

/** The family emoji, or a neutral dot for anything unmapped. */
export function familyEmoji(family: string): string {
  return FAMILY_EMOJI[family.toLowerCase()] ?? '•';
}

/** `unit-data` → `Unit Data`; explicit map wins for the odd ids. */
export function displayFamily(family: string): string {
  const named = DISPLAY_NAMES[family];
  if (named) return named;
  return family
    .split('-')
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(' ');
}

/** Short flavor line per family; unit families derive it from the id. */
export function familyFlavor(family: string): string {
  const known = FLAVORS[family];
  if (known) return known;
  if (family.startsWith('unit-')) return `${family.slice('unit-'.length)} units`;
  return 'commands';
}

function countsByFamily(source: CatalogueSource): Map<string, number> {
  const counts = new Map<string, number>();
  for (const cmd of source.list()) {
    const family = cmd.family ?? '?';
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  return counts;
}

/**
 * Build the interactive sheet: one flat section, one row per family.
 *
 * Reference-bot shape (`menulist.js`): a single `sections[0]` holding every row,
 * each row carrying `title`, `description` and the `id` that re-opens it. No
 * nested categories — WhatsApp renders a list one row per line, and grouping them
 * under section headings just adds a header the reader has to scroll past.
 * Families absent from the source are skipped so a removed family degrades to a
 * shorter menu instead of a dead row.
 */
export function fluxMenuCategories(source: CatalogueSource): MenuCategory[] {
  const counts = countsByFamily(source);
  const rows: MenuCategory['rows'] = [];
  for (const bucket of BUCKETS) {
    for (const family of bucket.families) {
      const count = counts.get(family) ?? 0;
      if (count === 0) continue;
      rows.push({
        id: `${FLUX_MENU_TAP_PREFIX}${family}`,
        title: `${familyEmoji(family)} MENU ${displayFamily(family).toUpperCase()}`,
        description: `${familyFlavor(family)} · ${plural(count)}`,
      });
    }
  }
  return rows.length > 0 ? [{ title: 'ꜰʟᴜx ᴍᴇɴᴜ', rows }] : [];
}

/** Every family id the buckets know about, for coverage assertions. */
export function bucketedFamilies(): string[] {
  return BUCKETS.flatMap((bucket) => [...bucket.families]);
}

/** Every family id present in the source, for the same assertions. */
export function sourceFamilies(source: CatalogueSource): string[] {
  return [...new Set(source.list().map((cmd) => cmd.family ?? '?'))].sort();
}

function plural(commands: number): string {
  return `${commands} command${commands === 1 ? '' : 's'}`;
}

/**
 * One family's commands as formatted text.
 *
 * Elaina grammar: framed header, stat rows, `╠➺` rows, framed footer. Routing
 * keys stay ASCII inside backticks; only the decorative headings use
 * small-caps. Pages of fifty; unknown families answer with the valid list
 * rather than silence.
 */
export function formatFamilyMenu(source: CatalogueSource, family: string, page = 1): string {
  const key = family.toLowerCase();
  const cmds = [...source.list({ family: key })].sort((a, b) => a.name.localeCompare(b.name));
  if (cmds.length === 0) {
    const valid = sourceFamilies(source).join(', ');
    return `No category “${family}”. Try one of: ${valid}`;
  }
  const pages = Math.max(1, Math.ceil(cmds.length / FAMILY_LIST_CAP));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const slice = cmds.slice((current - 1) * FAMILY_LIST_CAP, current * FAMILY_LIST_CAP);
  // Reference-bot frame: the title rides inside the top border, every command is
  // a `╠➺` row, the bottom border closes it. Their `menu-downloader.js` shape.
  const lines = [
    `${familyEmoji(key)} *MENU ${smallCaps(displayFamily(key).toUpperCase())}*`,
    '╔═━───╍━╍╍┄',
    `╠➺   ┊⿻ commands :: ${cmds.length}  ·  page :: ${current}/${pages}`,
    ...slice.map((cmd) => `╠➺   \`${cmd.name}\`${cmd.summary ? `  — ${cmd.summary}` : ''}`),
    '╚═─━╍╍━╍╾',
  ];
  if (pages > 1) {
    lines.push(`┊ ${familyFlavor(key)}`);
    lines.push(
      `┊ ${current > 1 ? `◀ \`flux menu ${key} ${current - 1}\`` : ''} ${current < pages ? `\`flux menu ${key} ${current + 1}\` ▶` : ''}`.trim(),
    );
  } else {
    lines.push(`┊ ${familyFlavor(key)}`);
  }
  return lines.join('\n');
}

/** Page count for a family: 0 when unknown, at least 1 otherwise. */
export function familyPageCount(source: CatalogueSource, family: string): number {
  const total = source.list({ family: family.toLowerCase() }).length;
  return total === 0 ? 0 : Math.ceil(total / FAMILY_LIST_CAP);
}

/**
 * Quick-reply buttons for a page: Previous / Next, two at most.
 *
 * First page carries only Next, last page only Previous, a single-page family
 * none — so the row never offers a move that does nothing. Both ids are
 * `flux:page:` taps, which the tap router edits the live message with.
 */
export function familyPageButtons(
  family: string,
  page: number,
  pages: number,
): Array<{ name: 'quick_reply'; buttonParamsJson: string }> {
  const key = family.toLowerCase();
  const button = (label: string, target: number): { name: 'quick_reply'; buttonParamsJson: string } => ({
    name: 'quick_reply',
    buttonParamsJson: JSON.stringify({
      display_text: label,
      id: `${FLUX_PAGE_TAP_PREFIX}${key}:${target}`,
    }),
  });
  const buttons: Array<{ name: 'quick_reply'; buttonParamsJson: string }> = [];
  if (page > 1) buttons.push(button('◀ Previous', page - 1));
  if (page < pages) buttons.push(button('Next ▶', page + 1));
  return buttons;
}

/**
 * Pull a page tap apart: `flux:page:<family>:<n>` → `{ family, page }`.
 *
 * Returns null on anything else, including a non-numeric page, so a stale or
 * malformed tap degrades to no-op instead of editing the wrong message.
 */
export function parseFluxPageTap(id: string): { family: string; page: number } | null {
  if (!id.startsWith(FLUX_PAGE_TAP_PREFIX)) return null;
  const rest = id.slice(FLUX_PAGE_TAP_PREFIX.length);
  const cut = rest.lastIndexOf(':');
  if (cut <= 0) return null;
  const family = rest.slice(0, cut);
  const page = Number.parseInt(rest.slice(cut + 1), 10);
  if (!family || !Number.isFinite(page) || page < 1) return null;
  return { family, page };
}

/** The whole catalogue as text, for clients that cannot take native flow. */
export function formatCatalogueFallback(source: CatalogueSource): string {
  const counts = countsByFamily(source);
  const total = source.list().length;
  const lines = [`*FLUX · ${plural(total)}*`, '_Text catalogue — this client takes no buttons._', ''];
  for (const bucket of BUCKETS) {
    const present = bucket.families.filter((family) => (counts.get(family) ?? 0) > 0);
    if (present.length === 0) continue;
    lines.push(`*${bucket.title}* (${present.reduce((n, f) => n + counts.get(f)!, 0)})`);
    for (const family of present) {
      lines.push(`• ${displayFamily(family)} (${counts.get(family)})`);
    }
    lines.push('');
  }
  lines.push('_Reply `flux menu <family>` for any list above._');
  return lines.join('\n');
}

/**
 * Pull a catalogue tap id apart. Returns the family on a syntactic match,
 * null otherwise — membership is the caller's check, so a family removed
 * after the menu was sent fails safe instead of throwing.
 */
export function parseFluxMenuTap(id: string): string | null {
  if (!id.startsWith(FLUX_MENU_TAP_PREFIX)) return null;
  const family = id.slice(FLUX_MENU_TAP_PREFIX.length);
  return family ? family : null;
}

/**
 * Send the interactive catalogue, falling back to text where native flow
 * cannot render. The fallback is first-class, not an apology: small terminals
 * and old clients get the same inventory.
 */
export async function sendFluxMenu(
  sock: CoreSocket,
  jid: string,
  source: CatalogueSource,
  options: { progress?: boolean; quoted?: unknown } = {},
): Promise<void> {
  const total = source.list().length;
  try {
if (options.progress) await playProgressMeterOn(sock, jid, options.quoted);
    await sendCategoryMenu(sock, jid, fluxMenuCategories(source), {
      header: { title: 'ꜰʟᴜx', subtitle: 'command catalogue' },
      body: `Choose a category`,
      footer: 'Taps reply with that category’s commands.',
      buttonTitle: 'KLIK TOMBOL INI',
    });
  } catch {
    await sock.sendMessage(jid, { text: formatCatalogueFallback(source) });
  }
}

/**
 * The registry's own `menu` command.
 *
 * `flux menu` sends the interactive sheet; `flux menu <family>` answers with
 * that family's list as text, which is also the path small terminals take.
 * Runs through `ctx.registry`, so it always enumerates what is actually
 * registered rather than a hand-written list.
 */
export const menuCommand = {
  name: 'menu',
  summary: 'Browse the command catalogue.',
  effect: 'send the interactive category menu, or one family as text',
  family: 'core',
  usage: '[family [page]]',
  handler: async (ctx: {
    args?: string;
    sock: unknown;
    jid: string;
    registry?: CatalogueSource;
  }): Promise<{ text?: string; error?: string }> => {
    const source = ctx.registry;
    if (!source) return { error: 'menu: catalogue unavailable in this context.' };
    const [family, pageRaw] = (ctx.args ?? '').trim().toLowerCase().split(/\s+/);
    if (!family) {
      try {
        await sendFluxMenu(
          ctx.sock as unknown as CoreSocket,
          ctx.jid,
          source,
          { progress: true },
        );
        return {};
      } catch {
        return { text: formatCatalogueFallback(source) };
      }
    }
    const cmds = source.list({ family });
    if (cmds.length === 0) {
      const valid = sourceFamilies(source).join(', ');
      return { text: `No category “${family}”. Try one of: ${valid}` };
    }
    const page = pageRaw === undefined || pageRaw === '' ? 1 : Number.parseInt(pageRaw, 10);
    // Same paged message the tap router sends — buttons when the client takes
    // them, and the text already carries the "reply for the next page" hint for
    // clients that do not.
    try {
      await sendFluxFamilyPage(ctx.sock as unknown as CoreSocket, ctx.jid, source, family, Number.isFinite(page) ? page : 1, { progress: true });
      return {};
    } catch {
      return { text: formatFamilyMenu(source, family, Number.isFinite(page) ? page : 1) };
    }
  },
};

/**
 * Send or update one family page, with quick-reply nav.
 *
 * No `edit` means a fresh message; an `edit` key updates it in place, so paging
 * replaces the page the reader is looking at instead of stacking a new one under
 * it. Both paths carry the same buttons, because the interactive plugin now
 * wraps an edit in the protocolMessage the edit needs (it silently dropped that
 * before, turning every "edit" into a duplicate send). Returns the sent key so
 * the caller can edit it on the next tap.
 */
/** Width of the meter's bar, in block glyphs. */
const METER_CELLS = 10;
/** Spinner heads, cycling at the bar's leading edge. */
const METER_HEADS = ['◐', '◓', '◑', '◒'] as const;
/** Status lines, revealed as the bar fills. Kept honest: this is real work. */
const METER_STAGES = [
  'resolving registry',
  'indexing commands',
  'bucketing families',
  'paging catalogue',
  'rendering menu',
] as const;

/**
 * Build the meter frames: a filling bar with a cycling head, a percentage, and a
 * status line that advances with it, finishing on a check.
 *
 * A pure function of `steps` so the animation is assertable without a socket —
 * the point of the sequence is that it *looks* like it is doing something, and the
 * only way to keep that honest is to have the bar track the real frame count.
 * One message, edited through every frame.
 */
export function progressMeterFrames(steps = 18): string[] {
  const frames: string[] = [];
  for (let i = 1; i <= steps; i += 1) {
    const done = Math.round((i / steps) * METER_CELLS);
    const head = done < METER_CELLS ? (METER_HEADS[i % METER_HEADS.length] ?? '') : '';
    const bar = `${'▰'.repeat(done)}${head}${'▱'.repeat(Math.max(0, METER_CELLS - done - head.length))}`;
    const pct = String(Math.round((i / steps) * 100)).padStart(3, ' ');
    const stage = METER_STAGES[Math.min(METER_STAGES.length - 1, Math.floor((i / steps) * METER_STAGES.length))] ?? '';
    frames.push(
      [
        `${METER_HEADS[i % METER_HEADS.length]} *ꜰʟᴜx* ᴄᴀᴛᴀʟᴏɢᴜᴇ`,
        `╭──────────────────╮`,
        `│ ${bar} ${pct}% │`,
        `╰──────────────────╯`,
        ` ⌁ ${stage}…`,
      ].join('\n'),
    );
  }
  frames.push('✅ *ꜰʟᴜx* ᴄᴀᴛᴀʟᴏɢᴜᴇ ʀᴇᴀᴅʏ');
  return frames;
}

const METER_FRAME_MS = 90;
/** Random beat between the meter's last frame and the menu landing. */
const METER_SETTLE_MIN = 350;
const METER_SETTLE_MAX = 700;

/**
 * Play the meter on a socket, then revoke it so no scaffolding is left behind.
 *
 * Split out of `sendFluxFamilyPage` because `flux menu` shows the same meter
 * before the category sheet. Revoke rather than edit-into-the-menu: an edited
 * interactive message loses its buttons, which is the whole reason the menu is
 * a fresh message.
 */
async function playProgressMeterOn(
  sock: CoreSocket,
  jid: string,
  quoted?: unknown,
): Promise<void> {
  const send = (payload: Record<string, unknown>): Promise<{ key?: unknown } | undefined> =>
    (sock as unknown as {
      sendMessage: (jid: string, content: unknown, options?: unknown) => Promise<{ key?: unknown }>;
    }).sendMessage(jid, payload, quoted ? { quoted } : undefined);
  const meterKey = await playProgressMeter(send, (ms) => new Promise((r) => setTimeout(r, ms)));
  if (!meterKey) return;
  try {
    await send({ delete: meterKey });
  } catch {
    // Best-effort. A leftover `✅` beats no menu.
  }
}

/**
 * Play the progress meter, then resolve to the key the caller should edit next.
 *
 * Stands alone so a failed send cannot abort the menu: on any error the meter
 * message is just left at `⌛` and the menu still sends. Returns the meter key so
 * the caller can reuse it; the pages keep their own keys.
 */
async function playProgressMeter(
  send: (content: Record<string, unknown>) => Promise<{ key?: unknown } | undefined>,
  wait: (ms: number) => Promise<void>,
): Promise<unknown> {
  try {
    // Every frame edits the one message, so the key to revoke is the one the first
    // send returned — not whatever a later edit echoed back.
    const key = (await send({ text: progressMeterFrames()[0] }))?.key;
    for (const frame of progressMeterFrames().slice(1)) {
      await wait(METER_FRAME_MS);
      await send({ text: frame, edit: key });
    }
    // A beat between the last frame and the real menu, so the check registers as
    // a completion rather than a frame that got cut off.
    await wait(METER_SETTLE_MIN + Math.random() * (METER_SETTLE_MAX - METER_SETTLE_MIN));
    return key;
  } catch {
    // A progress bar that throws must never cost the reader the menu itself.
    return undefined;
  }
}

export async function sendFluxFamilyPage(
  sock: CoreSocket,
  jid: string,
  source: CatalogueSource,
  family: string,
  page: number,
  options: { edit?: unknown; progress?: boolean; quoted?: unknown } = {},
): Promise<{ key?: unknown } | undefined> {
  const pages = familyPageCount(source, family);
  if (pages === 0) return undefined;
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const buttons = familyPageButtons(family, current, pages);
  const content: Record<string, unknown> = {
    text: formatFamilyMenu(source, family, current),
    footer: `${current}/${pages}`,
    ...(options.edit ? { edit: options.edit } : {}),
  };
  if (buttons.length > 0) content.interactiveButtons = buttons;
  const rawSend = (sock as unknown as {
    sendMessage: (jid: string, content: unknown, options?: unknown) => Promise<{ key?: unknown }>;
  }).sendMessage.bind(sock);
  const send = (payload: Record<string, unknown>): Promise<{ key?: unknown } | undefined> =>
    rawSend(jid, payload, options.quoted ? { quoted: options.quoted } : undefined);

  // Meter only on a fresh send. On a page turn the reader already has a page in
  // front of them, and a spinner would only delay the next one.
  if (!options.edit && options.progress) {
    const meterKey = await playProgressMeter(send, (ms) => new Promise((r) => setTimeout(r, ms)));
    // Scaffolding, not something the reader asked for. It cannot be edited into
    // the menu either — an edited interactive message loses its buttons.
    if (meterKey) {
      try {
        await send({ delete: meterKey });
      } catch {
        // Revoke is best-effort. A leftover meter beats no menu.
      }
    }
  }
  return send(content);
}

/**
 * Route catalogue taps to their family list.
 *
 * Watches `messages.upsert`, reads row ids with the shared parser, and answers
 * only taps in the `flux:` namespace for families still present. A `flux:cat:`
 * tap opens page one; a `flux:page:` tap edits the message already on screen
 * (falling back to a fresh send when its key is not remembered, e.g. after a
 * restart). Feature-demo taps, foreign buttons and malformed payloads pass
 * through untouched.
 */
export function fluxMenuTap(reg: CommandRegistryLike): Plugin {
  return {
    name: 'flux-menu-tap',
    order: 171,
    apply(ctx) {
      ctx.sock.ev.on('messages.upsert', (event: { messages?: unknown[] }) => {
        for (const message of event?.messages ?? []) {
          void (async (): Promise<void> => {
            try {
              const id = readMenuSelection((message as { message?: unknown })?.message ?? message);
              if (!id || !id.startsWith('flux:')) return;
              const key = (message as { key?: WAMessageKey })?.key;
              const jid = typeof key?.remoteJid === 'string' && key.remoteJid ? key.remoteJid : null;
              if (!jid) return;

              // Every page is its own message, quoted to the tap that asked for it.
              // An edit is the tidier choice, but WhatsApp does not carry quick-reply
              // buttons across an edit: the page arrived as plain text with no
              // buttons, so there was no Next to press. A fresh interactive message
              // is the only shape that keeps the buttons.
              const pageTap = parseFluxPageTap(id);
              if (pageTap) {
                if (reg.list({ family: pageTap.family }).length === 0) return;
                await sendFluxFamilyPage(ctx.sock, jid, reg, pageTap.family, pageTap.page, {
                  ...(key ? { quoted: key } : {}),
                });
                return;
              }

              const family = parseFluxMenuTap(id);
              if (!family || reg.list({ family }).length === 0) return;
              await sendFluxFamilyPage(ctx.sock, jid, reg, family, 1, {
                progress: true,
                ...(key ? { quoted: key } : {}),
              });
            } catch (err) {
              ctx.log.debug('flux menu tap failed', { err: (err as Error).message });
            }
          })();
        }
      });
    },
  };
}

interface CommandRegistryLike {
  list(filter?: { family?: string; prefix?: string }): Pick<
     Command,
    'name' | 'summary' | 'effect' | 'family' | 'usage'
  >[];
}
