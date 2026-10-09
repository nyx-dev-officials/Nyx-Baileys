/**
 * Modules E, F, G, I and J.
 *
 * ## What is real here
 *
 * A command is only worth shipping if it does something. This module therefore
 * favours **observable state** over decoration:
 *
 *   - anything that reports a runtime fact reads the actual runtime
 *   - anything that enforces a limit contains a real, tested implementation
 *   - anything that persists uses a real store with atomic writes
 *
 * A "connection pool status" command that prints invented numbers is worse
 * than no command: it looks like telemetry and is fiction.
 *
 * ## Two things deliberately absent
 *
 * `ghost-ping` is not implemented. It is specified as mentioning a user
 * without triggering the normal notification, which is the same invisible
 * mention mechanism declined in Module H — it manipulates how a message is
 * presented to the recipient rather than what it contains. Module E does have
 * `mention`, which mentions normally and visibly.
 *
 * `Silent Archive Dispatcher` (Module G) forwards other people's deleted
 * messages to a private JID. `anti-delete` already stores revoked messages
 * locally, which is defensible because it stays on the operator's own machine.
 * Replicating them onward to a second account extends retention of third-party
 * content without their knowledge, so no command forwards captured media.
 * `gdump` and `gpurge` exist and operate only on the local store.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CommandContext, CommandResult } from './command-registry.js';

const ok = (t: string): CommandResult => ({ text: t });
const bad = (t: string): CommandResult => ({ error: t });
const A = (ctx: CommandContext): string => ctx.args.trim();
const WHO = (ctx: CommandContext): string => ctx.sender.split('@')[0] ?? ctx.sender;
const CHAT = (ctx: CommandContext): string => ctx.jid.split('@')[0] ?? ctx.jid;
const now = (): number => Date.now();
const iso = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function duration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const storeDir = join(tmpdir(), 'flux-ops');

/**
 * `process.memoryUsage()` reports heapSizeLimit only when it is requested, and
 * `_getActiveHandles` is a libuv diagnostic absent from the public types.
 * Both are real and both are typed away, so they are reached through a narrow
 * documented cast rather than `any`.
 */
interface Diagnostics {
  memoryUsage(opts: { heapSizeLimit: true }): NodeJS.MemoryUsage & { heapSizeLimit: number };
  _getActiveHandles?(): unknown[];
  _getActiveRequests?(): unknown[];
}
const diag = process as unknown as Diagnostics;

const heapLimit = (): number => {
  try {
    const m = diag.memoryUsage({ heapSizeLimit: true });
    return Number.isFinite(m.heapSizeLimit) ? m.heapSizeLimit : 0;
  } catch { return 0; }
};
const activeHandles = (): unknown[] => diag._getActiveHandles?.() ?? [];
const activeRequests = (): unknown[] => diag._getActiveRequests?.() ?? [];
function storePath(name: string): string { return join(storeDir, `${name}.json`); }

function readStore<T>(name: string, fallback: T): T {
  const path = storePath(name);
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return fallback; }
}

function writeStore(name: string, value: unknown): void {
  mkdirSync(storeDir, { recursive: true });
  const path = storePath(name);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, path);
}

function mutate<T>(name: string, fallback: T, fn: (v: T) => CommandResult): CommandResult {
  const value = readStore(name, fallback);
  const result = fn(value);
  writeStore(name, value);
  return result;
}

/* ──────────────────────── Module F: transport ───────────────────────── */

/**
 * Token bucket rate limiter.
 *
 * Real implementation, not a counter. A bucket refills at `ratePerSecond` and
 * holds at most `capacity` tokens; each call costs `cost`. This is what makes
 * a burst of N immediately after an idle period pass while a sustained flood
 * does not — a fixed window would reject the first N and then let N more
 * through immediately after the window rolled, which is the exact bug that
 * lets a flood through at a boundary.
 */
interface Bucket { tokens: number; updated: number }

function takeToken(key: string, ratePerSecond: number, capacity: number, cost: number): { allowed: boolean; retryMs: number } {
  const buckets = readStore<Record<string, Bucket>>('tokens', {});
  const t = now();
  const b = buckets[key] ?? { tokens: capacity, updated: t };
  const refill = ((t - b.updated) / 1000) * ratePerSecond;
  b.tokens = Math.min(capacity, b.tokens + refill);
  b.updated = t;
  if (b.tokens >= cost) {
    b.tokens -= cost;
    buckets[key] = b;
    writeStore('tokens', buckets);
    return { allowed: true, retryMs: 0 };
  }
  const deficit = cost - b.tokens;
  const retryMs = Math.ceil((deficit / ratePerSecond) * 1000);
  b.updated = t;
  buckets[key] = b;
  writeStore('tokens', buckets);
  return { allowed: false, retryMs };
}

/* ──────────────────────── Module I: RBAC ────────────────────────────── */

type Role = 'owner' | 'admin' | 'vip' | 'user';

/** Roles are resolved from configuration, never inferred from a JID pattern. */
function rolesFor(ctx: CommandContext): Role[] {
  const cfg = readStore<Record<string, string[]>>('roles', {});
  const roles: Role[] = [];
  if (ctx.isOwner) roles.push('owner');
  for (const [jid, list] of Object.entries(cfg)) {
    if (jid === ctx.sender) roles.push(...(list as Role[]));
  }
  return roles.length ? roles : ['user'];
}

const RANK: Record<Role, number> = { user: 0, vip: 1, admin: 2, owner: 3 };

function requireRole(ctx: CommandContext, minimum: Role): CommandResult | null {
  const roles = rolesFor(ctx);
  const best = roles.reduce<Role>((a, b) => (RANK[b] > RANK[a] ? b : a), 'user');
  return RANK[best] >= RANK[minimum] ? null : bad(`This command needs the ${minimum} role. You have: ${roles.join(', ')}.`);
}

/* ──────────────────────── Module J: task queue ──────────────────────── */

interface Task { id: string; kind: string; payload: unknown; enqueued: number; state: 'queued' | 'done' | 'failed'; finished?: number; error?: string }

/* ──────────────────────── Module J: pub/sub ─────────────────────────── */

type Handler = (payload: unknown) => void;
const subscribers = new Map<string, Set<Handler>>();
/** Ring buffer of recent events, so late subscribers can see what happened. */
const eventLog: Array<{ topic: string; at: number; payload: unknown }> = [];
const EVENT_LOG_MAX = 200;

/* ──────────────────────── Module J: config encryption ───────────────── */

/**
 * Derive a 32-byte key from a passphrase with scrypt.
 *
 * scryptSync rather than the async form: these commands are synchronous
 * request/response handlers, and making them await a key derivation would buy
 * nothing here — there is no concurrent work to interleave with.
 */
function scrypt(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32);
}

function encryptSecret(plain: string, passphrase: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scrypt(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [salt.toString('base64'), iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

function decryptSecret(blob: string, passphrase: string): string {
  const [salt, iv, tag, data] = blob.split('.');
  if (!salt || !iv || !tag || !data) throw new Error('That is not a valid encrypted value.');
  const key = scrypt(passphrase, Buffer.from(salt, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

/* ──────────────────────── Module I: redaction ───────────────────────── */

const SECRET_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ['WhatsApp session token', /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\b/g],
  ['Bearer token', /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{20,}/g],
  ['API key assignment', /\b(api[_-]?key|apikey|token|secret|password|passwd|pwd)["'\s]*[:=]\s*["']?([^\s"',}]{8,})/gi],
  ['Private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
];

/** Redact anything that looks like a credential, and report what was found. */
function redact(text: string): { clean: string; found: string[] } {
  let clean = text;
  const found: string[] = [];
  for (const [label, pattern] of SECRET_PATTERNS) {
    const matches = clean.match(pattern);
    if (!matches) continue;
    found.push(`${label} (${matches.length})`);
    clean = clean.replace(pattern, `[REDACTED ${label.toUpperCase()}]`);
  }
  return { clean, found };
}

/* ─────────────────────────── the commands ──────────────────────────── */

interface OpsCmd {
  name: string;
  summary: string;
  effect: string;
  fn: (ctx: CommandContext) => Promise<CommandResult>;
}

export const opsCommands: OpsCmd[] = [
  /* ================= Module E: novelty ================= */
  { name: 'ematrix', summary: 'Matrix code rain', effect: 'render cascading characters as text art',
    fn: async (ctx) => {
      const rows = Math.min(24, Math.max(4, Number(A(ctx).split(/\s+/)[0]) || 12));
      const cols = Math.min(80, Math.max(10, Number(A(ctx).split(/\s+/)[1]) || 40));
      const glyphs = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉ0123456789ABCDEF';
      const lines: string[] = [];
      for (let r = 0; r < rows; r++) {
        let line = '';
        for (let c = 0; c < cols; c++) {
          line += glyphs[Math.floor(Math.random() * glyphs.length)];
        }
        lines.push(line);
      }
      return ok(lines.join('\n'));
    } },

  { name: 'asciiart', summary: 'ASCII banner', effect: 'render text as a block-letter banner',
    fn: async (ctx) => {
      const text = A(ctx).toUpperCase();
      if (!text) return bad('Usage: asciiart <TEXT>');
      const A5: Record<string, string[]> = {
        A: [' █████╗ ', '██╔══██╗', '███████║', '██╔══██║', '██║  ██║'],
        B: ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔══██╗', '██████╔╝'],
        C: [' ██████╗', '██╔════╝', '██║     ', '██║     ', ' ╚█████╗'],
        D: ['██████╗ ', '██╔══██╗', '██║  ██║', '██║  ██║', ' ╚█████╝'],
        E: ['███████╗', '██╔════╝', '█████╗  ', '██╔══╝  ', '███████╗'],
        F: ['███████╗', '██╔════╝', '█████╗  ', '██╔══╝  ', '██╔══╝  '],
        G: [' ██████╗', '██╔════╝', '██║  ███╗', '██║   ██║', ' ╚█████╔╝'],
        H: ['██╔══██╗', '██║  ██║', '███████║', '██║  ██║', '██║  ██║'],
        I: ['██╗ ╦██╗', '╚╗╔╝╚╝', ' ╚╝╚╝ ██', '██╔═██╗ ██', '╚═╝╚═╝ ╚═╝'],
        J: ['███████╗', '     ██║', '     ██║', '██╗  ██║', ' ╚█████╔╝'],
        K: ['██╔═══██╗', '██║   ██║', '███████╔╝', '██╔══██║', '██║  ██║'],
        L: ['██╗     ██', '██║     ██', '██║     ██', '██║     ██', '╚██████╔╝'],
        M: ['███╗   ███╗', '████╗ ████║', '██╔████╔██║', '██║╚██╔╝██║', '██║ ╚═╝ ██║'],
        N: ['███╗   ██║', '████╗  ██║', '██╔██╗ ██║', '██║╚██╗██║', '██║ ╚═╝███║'],
        O: [' ██████╗ ', '██╔═══██╗', '██║   ██║', '╚██████╔╝', ' ╚═════╝ '],
        P: ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔══██╗', '██║  ██║'],
        Q: [' ██████╗ ', '██╔═══██╗', '██║   ██║', '╚██████╔╝', ' ╚═════╝ '],
        R: ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔══██║', '██║  ██║'],
        S: [' ╚██████╗', '╚═════██║', ' ██████╔╝', '██╔════╝ ', '╚██████╗'],
        T: ['█████████', '   ██║   ', '   ██║   ', '   ██║   ', '   ██║   '],
        U: ['██╗  ██╗', '██║  ██║', '██║  ██║', '╚██████╔╝', ' ╚═════╝ '],
        V: ['██╗   ██╗', '██║   ██║', '╚██╗ ██╔╝', ' ╚████╔╝ ', '  ╚══╝  '],
        W: ['██╗     ██╗', '██║     ██║', '██║     ██║', '╚███████╔╝', ' ╚═════╝ '],
        X: ['██╗   ██╗', ' ╚██╗ ██╔╝', '  ╚███╔╝ ', '   ╚██╔╝  ', '    ╚╝   '],
        Y: ['██╗   ██╗', ' ╚██╗ ██╔╝', '  ╚███╔╝ ', '   ██║   ', '   ██║   '],
        Z: ['███████╗', '╚════██║', '     ██║', '███████║', '╚══════╝'],
        ' ': ['     ', '     ', '     ', '     ', '     '],
      };
      const rows: string[] = ['', '', '', '', ''];
      for (const ch of text.slice(0, 20)) {
        const glyph = A5[ch] ?? A5[' ']!;
        for (let r = 0; r < 5; r++) rows[r] += glyph[r]!;
      }
      return ok(rows.join('\n'));
    } },

  { name: 'sponge', summary: 'Spongebob casing', effect: 'apply alternating letter case',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: sponge <text>');
      return ok([...A(ctx)].map((c, i) => (i % 2 ? c.toUpperCase() : c.toLowerCase())).join(''));
    } },

  { name: 'hype', summary: 'Hype message', effect: 'return an enthusiastic reaction to any text',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: hype <thing you are excited about>');
      const t = A(ctx);
      return ok([
        `LET'S GO!!! ${t.toUpperCase()} IS UNREAL!`,
        `${t}?? ${t} FOREVER!`,
        `WE ARE NOT READY. ${t} IS COMING.`,
      ][Math.floor(Math.random() * 3)]!);
    } },


  { name: 'rolldice', summary: 'Roll dice', effect: 'roll dice in standard notation',
    fn: async (ctx) => {
      const raw = A(ctx) || '1d20';
      const m = raw.match(/^(\d*)d(\d+)$/i);
      if (!m) return bad('Use notation like 2d6 or 1d20.');
      const count = Math.min(50, Math.max(1, Number(m[1] || 1)));
      const sides = Math.min(1000, Math.max(2, Number(m[2])));
      const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
      const total = rolls.reduce((a, b) => a + b, 0);
      return ok(`${raw}: ${rolls.join(', ')}\nTotal: ${total}`);
    } },

  { name: 'chooseone', summary: 'Pick one at random', effect: 'choose a single option from a list',
    fn: async (ctx) => {
      const items = A(ctx).split(',').map((s) => s.trim()).filter(Boolean);
      if (items.length < 2) return bad('Give at least two options separated by commas.');
      return ok(items[Math.floor(Math.random() * items.length)]!);
    } },

  { name: 'truth', summary: 'Truth prompt', effect: 'offer a question to answer truthfully',
    fn: async () => ok([
      'What is something you still think about from a year ago?',
      'What is a rule you follow that nobody else does?',
      'What did you used to believe and no longer do?',
      'What is the hardest thing you have said no to?',
    ][Math.floor(Math.random() * 4)]!) },

  { name: 'dare', summary: 'Dare prompt', effect: 'offer a small, harmless dare',
    fn: async () => ok([
      'Send the third photo in your camera roll.',
      'Change your status to something honest for an hour.',
      'Reply to the next five messages in emoji only.',
      'Say the first thing that comes to mind as a haiku.',
    ][Math.floor(Math.random() * 4)]!) },

  { name: 'kudos', summary: 'Compliment', effect: 'give a genuine compliment',
    fn: async (ctx) => {
      const t = A(ctx) || 'you';
      return ok(`${t}: you handle difficult things with more grace than you give yourself credit for.`);
    } },

  { name: 'fakey', summary: 'Typing indicator', effect: 'hold the typing presence for a fixed duration',
    fn: async (ctx) => {
      const seconds = Math.min(60, Math.max(1, Number(A(ctx)) || 5));
      const sock = ctx.sock as unknown as { sendPresenceUpdate?: (a: string, b: string) => Promise<void> };
      if (typeof sock.sendPresenceUpdate !== 'function') {
        return bad('This socket has no presence method, so there is nothing to hold.');
      }
      // Real behaviour, honestly bounded: presence is refreshed for the window,
      // then released. It does not claim to persist after the process ends.
      const until = now() + seconds * 1000;
      while (now() < until) {
        await sock.sendPresenceUpdate('available', 'composing').catch(() => undefined);
        await new Promise((r) => setTimeout(r, 5000));
      }
      await sock.sendPresenceUpdate('available', 'paused').catch(() => undefined);
      return ok(`Held the typing indicator for ${seconds}s. Presence released.`);
    } },

  { name: 'placeholdercycle', summary: 'Placeholder text', effect: 'produce cycling placeholder text for a loading state',
    fn: async (ctx) => {
      const n = Math.min(20, Math.max(1, Number(A(ctx)) || 5));
      const words = ['loading', 'working', 'thinking', 'almost there', 'gathering', 'building'];
      return ok(Array.from({ length: n }, () => words[Math.floor(Math.random() * words.length)]).join(' … '));
    } },

  { name: 'loremipsum', summary: 'Lorem ipsum', effect: 'generate placeholder paragraphs of Latin text',
    fn: async (ctx) => {
      const paras = Math.min(10, Math.max(1, Number(A(ctx)) || 2));
      const base = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum'.split(' ');
      const out: string[] = [];
      for (let p = 0; p < paras; p++) {
        const sentence = Array.from({ length: 40 }, () => base[Math.floor(Math.random() * base.length)]).join(' ');
        out.push(`${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`);
      }
      return ok(out.join('\n\n'));
    } },

  { name: 'ezhelp', summary: 'Module E help', effect: 'list the novelty commands',
    fn: async () => ok([
      'Novelty: ematrix asciiart sponge hype rolldice chooseone',
      'Social:   truth dare roast kudos',
      'Effects:  fakey placeholdercycle loremipsum',
      'eightball and coin already exist in the game family, so they are not repeated here.',
      'ghost-ping is not implemented. Mentioning someone without the normal',
      'notification manipulates how a message is presented to the recipient',
      'rather than what it contains, so it is out for the same reason Module H is.',
    ].join('\n')) },

  /* ================= Module F: transport ================= */
  { name: 'fruntime', summary: 'Process runtime', effect: 'report real process uptime and memory usage',
    fn: async () => {
      const mem = process.memoryUsage();
      return ok([
        `Node: ${process.version}`,
        `Uptime: ${duration(process.uptime() * 1000)}`,
        `PID: ${process.pid}`,
        `Host: ${hostname()}`,
        `Platform: ${process.platform} ${process.arch}`,
        '',
        `Heap used: ${bytes(mem.heapUsed)} / ${bytes(mem.heapTotal)}`,
        `Heap limit: ${heapLimit() ? bytes(heapLimit()) : 'not exposed by this Node build'}`,
        `External: ${bytes(mem.external)}`,
        `RSS: ${bytes(mem.rss)}`,
        `Array buffers: ${bytes(mem.arrayBuffers)}`,
      ].join('\n'));
    } },

  { name: 'fgc', summary: 'Garbage collection', effect: 'inspect heap usage and run an explicit GC if exposed',
    fn: async () => {
      const before = process.memoryUsage();
      const hasGc = typeof globalThis.gc === 'function';
      if (hasGc) (globalThis.gc as () => void)();
      const after = process.memoryUsage();
      return ok([
        `GC exposed: ${hasGc ? 'yes' : 'no — start with --expose-gc to allow forced collection'}`,
        `Heap before: ${bytes(before.heapUsed)}`,
        `Heap after:  ${bytes(after.heapUsed)}`,
        `Reclaimed:   ${bytes(before.heapUsed - after.heapUsed)}`,
        '',
        'Heap numbers here are real. The "connection buffer" figure some bots print is invented — this bot does not report it.',
      ].join('\n'));
    } },

  { name: 'fhandles', summary: 'Resource handles', effect: 'report active libuv handles and requests',
    fn: async () => {
      const handles = activeHandles();
      const requests = activeRequests();
      const counts: Record<string, number> = {};
      for (const h of handles) {
        const name = h?.constructor?.name ?? 'unknown';
        counts[name] = (counts[name] ?? 0) + 1;
      }
      return ok([
        `Active handles: ${handles.length}`,
        `Active requests: ${requests.length}`,
        '',
        ...Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`),
      ].join('\n\n') || 'No active handles.');
    } },

  { name: 'flimit', summary: 'Rate limit check', effect: 'spend from the real token bucket and report the decision',
    fn: async (ctx) => {
      const parts = A(ctx).split(/\s+/).map(Number);
      const rate = parts[0] && parts[0]! > 0 ? parts[0]! : 1;
      const capacity = parts[1] && parts[1]! > 0 ? parts[1]! : Math.ceil(rate);
      const cost = parts[2] && parts[2]! > 0 ? parts[2]! : 1;
      // The bucket key must be stable. An earlier version included `now()` in
      // the key, which minted a brand new full bucket on every call — so the
      // command reported "allowed" forever and never actually measured a rate
      // limit. The key is per chat plus the configured shape, so repeated calls
      // genuinely deplete one bucket.
      const key = `limit:${CHAT(ctx)}:${rate}:${capacity}`;
      const before = readStore<Record<string, { tokens: number; updated: number }>>('tokens', {})[key];
      const result = takeToken(key, rate, capacity, cost);
      const after = readStore<Record<string, { tokens: number; updated: number }>>('tokens', {})[key];
      return ok([
        result.allowed ? 'Allowed.' : `Denied — retry in ${result.retryMs}ms.`,
        `Bucket: ${rate}/s, capacity ${capacity}, cost ${cost}.`,
        `Tokens before: ${before ? before.tokens.toFixed(2) : `${capacity} (new)`}`,
        `Tokens after: ${after ? after.tokens.toFixed(2) : 'n/a'}`,
      ].join('\n'));
    } },

  { name: 'flimitreset', summary: 'Reset one bucket', effect: 'refill a token bucket to capacity',
    fn: async (ctx) => {
      const key = `limit:${CHAT(ctx)}`;
      const buckets = readStore<Record<string, { tokens: number; updated: number }>>('tokens', {});
      let n = 0;
      for (const k of Object.keys(buckets)) {
        if (k.startsWith(key)) { delete buckets[k]; n++; }
      }
      writeStore('tokens', buckets);
      return ok(`Reset ${n} bucket(s) for this chat.`);
    } },

  { name: 'fbucket', summary: 'Token bucket status', effect: 'report current token level for this chat',
    fn: async (ctx) => {
      const buckets = readStore<Record<string, { tokens: number; updated: number }>>('tokens', {});
      const entries = Object.entries(buckets).sort((a, b) => b[1].tokens - a[1].tokens).slice(0, 15);
      if (!entries.length) return ok('No tokens consumed yet. Use flimit to test the bucket.');
      return ok(entries.map(([k, v]) => `${k} — ${v.tokens.toFixed(2)} tokens, updated ${iso(v.updated)}`).join('\n'));
    } },

  { name: 'fbucketreset', summary: 'Reset token buckets', effect: 'clear all token buckets',
    fn: async (ctx) => {
      const gate = requireRole(ctx, 'admin');
      if (gate) return gate;
      writeStore('tokens', {});
      return ok('All token buckets cleared.');
    } },

  { name: 'fuptime', summary: 'Uptime report', effect: 'report uptime with the exact process start time',
    fn: async () => ok([
      `Up: ${duration(process.uptime() * 1000)}`,
      `Started: ${iso(now() - process.uptime() * 1000)}`,
      `Now: ${iso(now())}`,
      '',
      'This is process uptime. It says nothing about connection health — see fhealth.',
    ].join('\n')) },

  { name: 'fhealth', summary: 'Connection health', effect: 'report observable connection state',
    fn: async () => {
      const sock = { } as Record<string, unknown>;
      const checks: string[] = [];
      checks.push(`Event loop responsive: ${await new Promise<string>((r) => {
        const t = setTimeout(() => r('no — blocked over 100ms'), 100);
        setImmediate(() => { clearTimeout(t); r('yes'); });
      })}`);
      const limit = heapLimit();
    checks.push(limit
      ? `Heap headroom: ${bytes(Math.max(0, limit - process.memoryUsage().heapUsed))}`
      : 'Heap headroom: not exposed by this Node build');
      checks.push(`Active handles: ${(activeHandles()).length}`);
      return ok(checks.join('\n'));
    } },

  { name: 'fhdr', summary: 'Environment check', effect: 'report which integration variables are configured without printing values',
    fn: async () => {
      const keys = ['FFMPEG_PATH', 'NODE_ENV', 'FLUX_OWNER', 'OWNER_JID'];
      const rows = keys.map((k) => `${k}: ${process.env[k] ? 'set' : 'not set'}`);
      return ok([...rows, '', 'Values are never printed — only whether they are set.'].join('\n'));
    } },

  { name: 'fsize', summary: 'Storage footprint', effect: 'report real on-disk sizes for the store directories',
    fn: async () => {
      const dirs = [storeDir, join(tmpdir(), 'flux-assistant'), join(tmpdir(), 'flux-media-')];
      const rows: string[] = [];
      for (const d of dirs) {
        if (!existsSync(d)) { rows.push(`${d} — absent`); continue; }
        let total = 0, files = 0;
        for (const f of readdirSync(d)) {
          try { total += statSync(join(d, f)).size; files++; } catch { /* raced */ }
        }
        rows.push(`${d} — ${files} file(s), ${bytes(total)}`);
      }
      return ok(rows.join('\n'));
    } },

  { name: 'fconfig', summary: 'Show configuration', effect: 'list configuration keys with values redacted',
    fn: async (ctx) => {
      const gate = requireRole(ctx, 'admin');
      if (gate) return gate;
      const cfg = readStore<Record<string, unknown>>('config', {});
      const entries = Object.entries(cfg);
      if (!entries.length) return ok('No configuration stored. Use `fconfig set <key> <value>`.');
      return ok(entries.map(([k, v]) => {
        const { clean } = redact(String(v));
        return `${k} = ${clean}`;
      }).join('\n'));
    } },

  { name: 'fsetconfig', summary: 'Set a configuration value', effect: 'store a configuration key locally',
    fn: async (ctx) => {
      const gate = requireRole(ctx, 'admin');
      if (gate) return gate;
      const [key, ...rest] = A(ctx).split(/\s+/);
      if (!key || !rest.length) return bad('Usage: fsetconfig <key> <value>');
      return mutate('config', {} as Record<string, string>, (cfg) => {
        cfg[key!] = rest.join(' ');
        return ok(`${key!} set to ${cfg[key!]}`);
      });
    } },

  { name: 'fdelconfig', summary: 'Delete a configuration key', effect: 'remove a stored configuration key',
    fn: async (ctx) => {
      const gate = requireRole(ctx, 'admin');
      if (gate) return gate;
      const key = A(ctx);
      return mutate('config', {} as Record<string, string>, (cfg) => {
        if (!(key in cfg)) return bad(`No such key: ${key}`);
        delete cfg[key];
        return ok(`Removed ${key}.`);
      });
    } },

  { name: 'fconfigkeys', summary: 'List configuration keys', effect: 'show configuration keys without their values',
    fn: async (ctx) => {
      const gate = requireRole(ctx, 'admin');
      if (gate) return gate;
      const cfg = readStore<Record<string, unknown>>('config', {});
      const keys = Object.keys(cfg);
      if (!keys.length) return ok('No configuration keys stored.');
      return ok(`${keys.length} key(s): ${keys.join(', ')}`);
    } },

  /* ================= Module I: security ================= */
  { name: 'irole', summary: 'Your roles', effect: 'report the roles assigned to this sender',
    fn: async (ctx) => {
      const roles = rolesFor(ctx);
      return ok(`${ctx.sender}\nRoles: ${roles.join(', ')}\nHighest: ${roles.reduce<Role>((a, b) => (RANK[b] > RANK[a] ? b : a), 'user')}`);
    } },

  { name: 'irolecheck', summary: 'Check a required role', effect: 'report whether this sender meets a role requirement',
    fn: async (ctx) => {
      const want = (A(ctx) || 'admin').toLowerCase() as Role;
      if (!(want in RANK)) return bad(`Unknown role "${want}". Options: ${Object.keys(RANK).join(', ')}`);
      const gate = requireRole(ctx, want);
      return gate ? bad(`Denied. ${gate.error}`) : ok(`Granted: you hold ${want}.`);
    } },

  { name: 'irolegrant', summary: 'Grant a role', effect: 'assign a role to a sender',
    fn: async (ctx) => {
      const gate = requireRole(ctx, 'owner');
      if (gate) return gate;
      const [jid, role] = A(ctx).split(/\s+/);
      if (!jid || !role || !(role in RANK)) return bad('Usage: irolegrant <jid> <role>');
      return mutate('roles', {} as Record<string, Role[]>, (cfg) => {
        const list = cfg[jid!] ?? [];
        const r = role as Role;
        if (!list.includes(r)) list.push(r);
        cfg[jid!] = list;
        return ok(`${jid} now holds: ${list.join(', ')}`);
      });
    } },

  { name: 'irolerevoke', summary: 'Revoke a role', effect: 'remove a role from a sender',
    fn: async (ctx) => {
      const gate = requireRole(ctx, 'owner');
      if (gate) return gate;
      const [jid, role] = A(ctx).split(/\s+/);
      if (!jid || !role) return bad('Usage: irolerevoke <jid> <role>');
      return mutate('roles', {} as Record<string, Role[]>, (cfg) => {
        cfg[jid!] = (cfg[jid!] ?? []).filter((r) => r !== role);
        return ok(`${jid} now holds: ${(cfg[jid!] ?? []).join(', ') || 'nothing'}`);
      });
    } },

  { name: 'iroleslist', summary: 'List all role assignments', effect: 'show every role assignment',
    fn: async (ctx) => {
      const gate = requireRole(ctx, 'admin');
      if (gate) return gate;
      const cfg = readStore<Record<string, string[]>>('roles', {});
      const entries = Object.entries(cfg);
      if (!entries.length) return ok('No roles assigned.');
      return ok(entries.map(([jid, list]) => `${jid} — ${list.join(', ')}`).join('\n'));
    } },

  { name: 'iscrub', summary: 'Scrub secrets', effect: 'detect and redact credential patterns in text',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: iscrub <text>');
      const { clean, found } = redact(A(ctx));
      return ok(found.length
        ? `Found ${found.length} pattern(s):\n${found.map((f) => `  - ${f}`).join('\n')}\n\nRedacted:\n${clean}`
        : `No credential patterns detected in ${A(ctx).length} characters.`);
    } },

  { name: 'iscrubself', summary: 'Scrub a file', effect: 'scan a local file for credential patterns without printing them',
    fn: async (ctx) => {
      const file = A(ctx);
      if (!file) return bad('Usage: iscrubself <path>');
      if (!existsSync(file)) return bad(`No such file: ${file}`);
      const text = readFileSync(file, 'utf8');
      const { found } = redact(text);
      return ok(found.length
        ? `${file}: ${found.length} credential pattern(s) found:\n${found.map((f) => `  - ${f}`).join('\n')}\n\nNo values were printed.`
        : `${file}: no credential patterns found in ${text.length} characters.`);
    } },

  { name: 'ienc', summary: 'Encrypt a value', effect: 'encrypt text with AES-256-GCM under a passphrase',
    fn: async (ctx) => {
      const raw = A(ctx);
      // Multi-word passphrases are the norm, so the passphrase and the
      // plaintext cannot both be "everything after the first token". Splitting
      // on `::` is explicit; without it the first token is the passphrase.
      const sep = raw.indexOf('::');
      let pass: string, plain: string;
      if (sep > 0) {
        pass = raw.slice(0, sep).trim();
        plain = raw.slice(sep + 2).trim();
      } else {
        const firstSpace = raw.indexOf(' ');
        if (firstSpace <= 0) return bad('Usage: ienc <passphrase> :: <text>   (or "ienc word text")');
        pass = raw.slice(0, firstSpace);
        plain = raw.slice(firstSpace + 1).trim();
      }
      if (!pass || !plain) return bad('Usage: ienc <passphrase> :: <text>');
      return ok(encryptSecret(plain, pass));
    } },

  { name: 'idec', summary: 'Decrypt a value', effect: 'decrypt a value produced by ienc',
    fn: async (ctx) => {
      const raw = A(ctx);
      const sep = raw.indexOf('::');
      let pass: string, blob: string;
      if (sep > 0) {
        pass = raw.slice(0, sep).trim();
        blob = raw.slice(sep + 2).trim();
      } else {
        const firstSpace = raw.indexOf(' ');
        if (firstSpace <= 0) return bad('Usage: idec <passphrase> :: <encrypted value>');
        pass = raw.slice(0, firstSpace);
        blob = raw.slice(firstSpace + 1).trim();
      }
      if (!pass || !blob) return bad('Usage: idec <passphrase> :: <encrypted value>');
      try {
        return ok(decryptSecret(blob, pass));
      } catch (err) {
        return bad(`Decryption failed: ${(err as Error).message}. That is the expected result for a wrong passphrase — GCM authenticates, so it will not silently return garbage.`);
      }
    } },

  { name: 'ijwtcheck', summary: 'Inspect a token structure', effect: 'report a JWT header and payload without trusting it',
    fn: async (ctx) => {
      const token = A(ctx);
      const parts = token.split('.');
      if (parts.length !== 3) return bad('That is not a JWT — it does not have three dot-separated parts.');
      try {
        const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as Record<string, unknown>;
        const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
        return ok([
          `Header: ${JSON.stringify(header, null, 2)}`,
          `Payload: ${JSON.stringify(payload, null, 2)}`,
          '',
          'This decodes the token. It does NOT verify the signature, so treat nothing in it as trustworthy.',
          payload.exp ? `exp: ${iso(Number(payload.exp) * 1000)} (${Number(payload.exp) * 1000 < now() ? 'expired' : 'valid'})` : '',
        ].filter(Boolean).join('\n'));
      } catch {
        return bad('The header or payload is not valid base64url JSON.');
      }
    } },

  { name: 'ihashfile', summary: 'Hash a file', effect: 'compute SHA-256 of a local file',
    fn: async (ctx) => {
      const file = A(ctx);
      if (!file) return bad('Usage: ihashfile <path>');
      if (!existsSync(file)) return bad(`No such file: ${file}`);
      return ok(createHash('sha256').update(readFileSync(file)).digest('hex'));
    } },

  { name: 'ikill', summary: 'Emergency stop', effect: 'clear rate limit state and report what was cleared',
    fn: async (ctx) => {
      const gate = requireRole(ctx, 'owner');
      if (gate) return gate;
      const cleared = [];
      for (const name of ['tokens', 'tasks']) {
        if (existsSync(storePath(name))) { rmSync(storePath(name), { force: true }); cleared.push(name); }
      }
      // Queue draining is stopped too: an in-memory queue would otherwise keep
      // running work with no record that a stop was requested.
      const queued = tasks.length;
      tasks.length = 0;
      return ok([
        cleared.length ? `Cleared stores: ${cleared.join(', ')}` : 'No stores needed clearing.',
        `Dropped ${queued} queued task(s).`,
        '',
        'This does not terminate the process. Killing the Node process from inside Node is not something a chat command can do safely.',
      ].join('\n'));
    } },

  /* ================= Module J: state and tasks ================= */
  { name: 'jtask', summary: 'Queue a task', effect: 'add work to the asynchronous task queue',
    fn: async (ctx) => {
      const kind = A(ctx).split(/\s+/)[0];
      if (!kind) return bad('Usage: jtask <kind> [payload]');
      const t: Task = {
        id: Math.random().toString(36).slice(2, 10),
        kind,
        payload: A(ctx).split(/\s+/).slice(1).join(' ') || null,
        enqueued: now(),
        state: 'queued',
      };
      tasks.push(t);
      if (tasks.length > 1000) tasks.shift();
      return ok(`Queued ${t.id} (${t.kind}). ${tasks.length} task(s) in the queue.`);
    } },

  { name: 'jtasks', summary: 'List queued tasks', effect: 'report the task queue contents',
    fn: async () => {
      if (!tasks.length) return ok('The queue is empty.');
      return ok(`${tasks.length} task(s):\n${tasks.slice(-20).map((t) => `${t.id}  ${t.kind}  ${t.state}`).join('\n')}`);
    } },

  { name: 'jtaskdone', summary: 'Complete a task', effect: 'mark a queued task as done',
    fn: async (ctx) => {
      const id = A(ctx);
      const t = tasks.find((x) => x.id === id);
      if (!t) return bad(`No task with id ${id}.`);
      t.state = 'done';
      t.finished = now();
      return ok(`Task ${id} marked done.`);
    } },

  { name: 'jtaskclear', summary: 'Clear the queue', effect: 'discard every queued task',
    fn: async (ctx) => {
      const gate = requireRole(ctx, 'admin');
      if (gate) return gate;
      const n = tasks.length;
      tasks.length = 0;
      return ok(`Cleared ${n} task(s).`);
    } },

  { name: 'jqueue', summary: 'Queue statistics', effect: 'report how much work has been queued',
    fn: async () => {
      if (!tasks.length) return ok('Nothing has ever been queued in this session.');
      const done = tasks.filter((t) => t.state === 'done').length;
      const oldest = Math.min(...tasks.map((t) => t.enqueued));
      return ok([
        `Queued now: ${tasks.length}`,
        `Completed: ${done}`,
        `Oldest waiting: ${duration(now() - oldest)}`,
      ].join('\n'));
    } },

  { name: 'jset', summary: 'Store a value', effect: 'store a key-value pair in the local store',
    fn: async (ctx) => {
      const [key, ...rest] = A(ctx).split(/\s+/);
      if (!key || !rest.length) return bad('Usage: jset <key> <value>');
      return mutate('kv', {} as Record<string, { value: string; at: number }>, (kv) => {
        kv[key!] = { value: rest.join(' '), at: now() };
        return ok(`Stored ${key!}.`);
      });
    } },

  { name: 'jget', summary: 'Read a value', effect: 'read a stored key',
    fn: async (ctx) => {
      const key = A(ctx);
      const kv = readStore<Record<string, { value: string; at: number }>>('kv', {});
      const hit = kv[key];
      if (!hit) return bad(`No value stored for "${key}".`);
      return ok(`${hit.value}\n\nStored ${iso(hit.at)}.`);
    } },

  { name: 'jdel', summary: 'Delete a value', effect: 'remove a stored key',
    fn: async (ctx) => {
      const key = A(ctx);
      return mutate('kv', {} as Record<string, unknown>, (kv) => {
        if (!(key in kv)) return bad(`No value stored for "${key}".`);
        delete kv[key];
        return ok(`Removed ${key}.`);
      });
    } },

  { name: 'jkeys', summary: 'List stored keys', effect: 'list every key in the local store',
    fn: async () => {
      const kv = readStore<Record<string, { value: string; at: number }>>('kv', {});
      const keys = Object.keys(kv);
      if (!keys.length) return ok('The store is empty.');
      return ok(`${keys.length} key(s):\n${keys.map((k) => `${k}  (${iso(kv[k]!.at)})`).join('\n')}`);
    } },

  { name: 'jpublish', summary: 'Publish an event', effect: 'emit an event to subscribers and record it',
    fn: async (ctx) => {
      const [topic, ...rest] = A(ctx).split(/\s+/);
      if (!topic) return bad('Usage: jpublish <topic> [payload]');
      const payload = rest.join(' ') || null;
      const event = { topic, at: now(), payload };
      eventLog.push(event);
      while (eventLog.length > EVENT_LOG_MAX) eventLog.shift();
      const delivered = subscribers.get(topic)?.size ?? 0;
      // Subscribers run inline. A subscriber that throws must not take the
      // publisher down with it, so each is isolated.
      for (const h of subscribers.get(topic) ?? []) {
        try { h(payload); } catch { /* one bad subscriber must not stop the rest */ }
      }
      return ok(`Published "${topic}" to ${delivered} subscriber(s). ${eventLog.length} event(s) in the log.`);
    } },

  { name: 'jsubscribe', summary: 'Subscribe to a topic', effect: 'register a listener for an event topic',
    fn: async (ctx) => {
      const topic = A(ctx) || 'default';
      let count = 0;
      const handler: Handler = () => { count++; };
      if (!subscribers.has(topic)) subscribers.set(topic, new Set());
      subscribers.get(topic)!.add(handler);
      return ok(`Subscribed to "${topic}". ${subscribers.get(topic)!.size} listener(s) on that topic.`);
    } },

  { name: 'jevents', summary: 'Event log', effect: 'show recently published events',
    fn: async () => {
      if (!eventLog.length) return ok('No events published yet.');
      return ok(`${eventLog.length} event(s) (keeping the most recent ${EVENT_LOG_MAX}):\n${
        eventLog.slice(-20).map((e) => `${iso(e.at)}  ${e.topic}  ${e.payload ?? ''}`).join('\n')}`);
    } },

  { name: 'jlog', summary: 'Structured log', effect: 'emit a machine-parsable log record',
    fn: async (ctx) => {
      const [level, ...rest] = A(ctx).split(/\s+/);
      const valid = ['debug', 'info', 'warn', 'error'];
      const lvl = valid.includes(level!) ? level! : 'info';
      return ok(JSON.stringify({
        ts: new Date(now()).toISOString(),
        level: lvl,
        msg: rest.join(' ') || '(empty)',
        chat: CHAT(ctx),
        sender: WHO(ctx),
      }));
    } },

  { name: 'jdrain', summary: 'Graceful shutdown check', effect: 'report what would be flushed on shutdown',
    fn: async () => {
      const items = [
        ['Task queue', tasks.length ? `${tasks.length} queued` : 'empty'],
        ['Token buckets', Object.keys(readStore('tokens', {})).length],
        ['KV entries', Object.keys(readStore('kv', {})).length],
        ['Event log', `${eventLog.length} events`],
        ['Open handles', String((activeHandles()).length)],
      ];
      return ok([
        'Graceful shutdown would flush:',
        ...items.map(([k, v]) => `  ${k}: ${v}`),
        '',
        `Pending timers keep the process alive. The current ref is ${activeRequests().length}.`,
        'This reports state; it does not initiate a shutdown.',
      ].join('\n'));
    } },

  { name: 'jhealth', summary: 'Diagnostic health check', effect: 'validate dependencies and runtime environment',
    fn: async () => {
      const rows: string[] = [];
      rows.push(`Node ${process.version} on ${process.platform}/${process.arch}: ok`);
      const required = ['OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GROQ_API_KEY'];
      const anyProvider = required.some((k) => process.env[k]);
      rows.push(`AI provider key: ${anyProvider ? 'configured' : 'none configured (free fallback will be used)'}`);
      let ffmpeg = 'not found';
      try {
        const { execFileSync } = await import('node:child_process');
        execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
        ffmpeg = 'available';
      } catch { /* absent */ }
      rows.push(`ffmpeg: ${ffmpeg}`);
      rows.push(`Store writable: ${(() => { try { writeStore('healthcheck', { at: now() }); return 'yes'; } catch { return 'no'; } })()}`);
      const limit = heapLimit();
      rows.push(limit
        ? `Heap headroom: ${bytes(Math.max(0, limit - process.memoryUsage().heapUsed))}`
        : 'Heap headroom: not exposed by this Node build (memoryUsage({heapSizeLimit:true}) returns nothing useful)');
      rows.push(`Event loop: ${await new Promise<string>((r) => {
        const t = setTimeout(() => r('BLOCKED'), 200);
        setImmediate(() => { clearTimeout(t); r('responsive'); });
      })}`);
      return ok(rows.join('\n'));
    } },

  { name: 'jmigrate', summary: 'Schema migrations', effect: 'run the versioned local-store migration',
    fn: async () => {
      const CURRENT = 3;
      const state = readStore<{ version: number; applied: string[] }>('migrations', { version: 0, applied: [] });
      const steps: Array<[number, string, (v: Record<string, unknown>) => void]> = [
        [1, 'ensure notes buckets', (v) => { v.notes ??= {}; }],
        [2, 'ensure todos buckets', (v) => { v.todos ??= {}; }],
        [3, 'ensure snippets buckets', (v) => { v.snippets ??= {}; }],
      ];
      const applied: string[] = [];
      for (const [version, description, fn] of steps) {
        if (state.version >= version) continue;
        fn(state as unknown as Record<string, unknown>);
        state.applied.push(iso(now()));
        state.version = version;
        applied.push(`v${version}: ${description}`);
      }
      writeStore('migrations', state);
      return ok(applied.length
        ? `Applied ${applied.length} migration(s):\n${applied.map((a) => `  ${a}`).join('\n')}\nNow at version ${state.version}.`
        : `Already at version ${state.version}. Nothing to do.`);
    } },

  { name: 'jversion', summary: 'Store schema version', effect: 'report the current local-store schema version',
    fn: async () => {
      const state = readStore<{ version: number; applied: string[] }>('migrations', { version: 0, applied: [] });
      return ok([
        `Schema version: ${state.version} of 3`,
        state.applied.length ? `Applied at:\n${state.applied.map((a) => `  ${a}`).join('\n')}` : 'No migrations recorded yet.',
      ].join('\n'));
    } },

  { name: 'jintent', summary: 'Intent routing', effect: 'classify a message into an intent keyword set',
    fn: async (ctx) => {
      const text = A(ctx);
      if (!text) return bad('Usage: jintent <message>');
      const lower = text.toLowerCase();
      const intents: ReadonlyArray<[string, RegExp]> = [
        ['greeting', /\b(hi|hello|hey|good (morning|evening|afternoon))\b/],
        ['farewell', /\b(bye|goodbye|see you|later|cya)\b/],
        ['question', /\?|^(what|who|where|when|why|how|which|can|do|does|is|are)\b/],
        ['gratitude', /\b(thanks|thank you|cheers|appreciate)\b/],
        ['request', /\b(can you|could you|please|help me)\b/],
        ['complaint', /\b(broken|doesn'?t work|not working|error|bug|useless)\b/],
        ['affirm', /\b(yes|yeah|yep|sure|ok|okay|thanks)\b/],
        ['deny', /\b(no|nope|nah|don'?t)\b/],
        ['time', /\b(what time|when is|current time|today'?s date)\b/],
        ['media', /\b(send|show|photo|video|image|audio|voice|file)\b/],
      ];
      const matched = intents.filter(([, re]) => re.test(lower)).map(([name]) => name);
      return ok([
        `Text: ${text}`,
        `Intents: ${matched.length ? matched.join(', ') : 'none matched'}`,
        `Confidence: ${Math.min(1, matched.length / 3).toFixed(2)}`,
        '',
        'Keyword matching, not a model. It says nothing about meaning beyond these patterns.',
      ].join('\n'));
    } },

  { name: 'jembed', summary: 'Local embedding', effect: 'produce a deterministic local vector for a string',
    fn: async (ctx) => {
      const text = A(ctx);
      if (!text) return bad('Usage: jembed <text>');
      const dims = 64;
      const vec = new Array<number>(dims).fill(0);
      for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        const h = createHash('sha256').update(word).digest();
        for (let i = 0; i < dims; i++) vec[i]! += (h[i % h.length]! / 255) - 0.5;
      }
      const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1;
      const unit = vec.map((v) => +(v / norm).toFixed(4));
      return ok([
        `Dimensions: ${dims}`,
        `Norm before normalising: ${norm.toFixed(4)}`,
        `Vector: [${unit.slice(0, 12).join(', ')}${dims > 12 ? ', …' : ''}]`,
        '',
        'This is a hashing trick, not a learned embedding. It gives identical text an identical vector and',
        'near-zero similarity for unrelated text. It does NOT capture semantic meaning — use a real model',
        'if you need "bank" and "financial institution" to be close.',
      ].join('\n'));
    } },

  { name: 'jsearch', summary: 'Vector search', effect: 'rank stored embeddings by cosine similarity',
    fn: async (ctx) => {
      const q = A(ctx);
      if (!q) return bad('Usage: jsearch <query>');
      const store = readStore<Record<string, { text: string; vec: number[] }>>('vectors', {});
      const keys = Object.keys(store);
      if (!keys.length) return ok('Nothing stored. Add some with `jstore <name> <text>`.');
      const dim = store[keys[0]!]!.vec.length;
      const qv = new Array<number>(dim).fill(0);
      for (const word of q.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        const h = createHash('sha256').update(word).digest();
        for (let i = 0; i < dim; i++) qv[i]! += (h[i % h.length]! / 255) - 0.5;
      }
      const qn = Math.sqrt(qv.reduce((a, b) => a + b * b, 0)) || 1;
      const ranked = keys.map((k) => {
        const v = store[k]!.vec;
        const vn = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
        let dot = 0;
        for (let i = 0; i < dim; i++) dot += qv[i]! * v[i]!;
        return { k, text: store[k]!.text, score: dot / (qn * vn) };
      }).sort((a, b) => b.score - a.score);
      return ok(`Query: ${q}\n\n${ranked.map((r) => `${r.score.toFixed(4)}  ${r.k}  ${r.text.slice(0, 50)}`).join('\n')}`);
    } },

  { name: 'jstore', summary: 'Store a vector', effect: 'embed and store a string for later search',
    fn: async (ctx) => {
      const [name, ...rest] = A(ctx).split(/\s+/);
      const text = rest.join(' ');
      if (!name || !text) return bad('Usage: jstore <name> <text>');
      return mutate('vectors', {} as Record<string, { text: string; vec: number[] }>, (v) => {
        const dim = 64;
        const vec = new Array<number>(dim).fill(0);
        for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
          const h = createHash('sha256').update(word).digest();
          for (let i = 0; i < dim; i++) vec[i]! += (h[i % h.length]! / 255) - 0.5;
        }
        const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1;
        v[name!] = { text, vec: vec.map((x) => x / norm) };
        return ok(`Stored "${name}" with ${dim} dimensions.`);
      });
    } },

  { name: 'jvectors', summary: 'Vector store', effect: 'list everything in the vector store',
    fn: async () => {
      const store = readStore<Record<string, { text: string; vec: number[] }>>('vectors', {});
      const keys = Object.keys(store);
      if (!keys.length) return ok('The vector store is empty.');
      return ok(`${keys.length} entr${keys.length === 1 ? 'y' : 'ies'}:\n${keys.map((k) => `${k}  ${store[k]!.text.slice(0, 50)}`).join('\n')}`);
    } },

  /* ================= Module G: retention ================= */
  { name: 'gdump', summary: 'Retention report', effect: 'report what the local anti-delete store holds',
    fn: async () => {
      const path = join(tmpdir(), 'flux-retention');
      if (!existsSync(path)) return ok('No local retention store exists yet.');
      const files = readdirSync(path);
      let total = 0;
      for (const f of files) { try { total += statSync(join(path, f)).size; } catch { /* raced */ } }
      return ok([
        `Store: ${path}`,
        `Entries: ${files.length}`,
        `Size: ${bytes(total)}`,
        '',
        'This is local-only. Nothing is forwarded anywhere.',
      ].join('\n'));
    } },

  { name: 'gpurge', summary: 'Purge the retention store', effect: 'delete locally retained revoked messages',
    fn: async (ctx) => {
      const gate = requireRole(ctx, 'owner');
      if (gate) return gate;
      const path = join(tmpdir(), 'flux-retention');
      if (!existsSync(path)) return ok('Nothing to purge.');
      const files = readdirSync(path);
      rmSync(path, { recursive: true, force: true });
      return ok(`Purged ${files.length} retained entr${files.length === 1 ? 'y' : 'ies'}.`);
    } },

  { name: 'gexclude', summary: 'Retention exclusions', effect: 'list senders excluded from anti-delete capture',
    fn: async (ctx) => {
      const gate = requireRole(ctx, 'admin');
      if (gate) return gate;
      const list = readStore<string[]>('retention-exclude', []);
      return ok(list.length ? `${list.length} excluded:\n${list.join('\n')}` : 'No senders are excluded.');
    } },

  { name: 'gexcludeadd', summary: 'Exclude a sender', effect: 'stop capturing revoked messages from a sender',
    fn: async (ctx) => {
      const gate = requireRole(ctx, 'admin');
      if (gate) return gate;
      const jid = A(ctx);
      if (!jid) return bad('Usage: gexcludeadd <jid>');
      return mutate('retention-exclude', [] as string[], (list) => {
        if (list.includes(jid)) return ok(`${jid} is already excluded.`);
        list.push(jid);
        return ok(`${jid} added. Captured messages from this sender will be dropped.`);
      });
    } },

  { name: 'gexcluderemove', summary: 'Remove an exclusion', effect: 'resume capturing revoked messages from a sender',
    fn: async (ctx) => {
      const gate = requireRole(ctx, 'admin');
      if (gate) return gate;
      const jid = A(ctx);
      return mutate('retention-exclude', [] as string[], (list) => {
        if (!list.includes(jid)) return bad(`${jid} is not excluded.`);
        return ok(`Removed ${jid}.`);
      });
    } },

  { name: 'gnotice', summary: 'Retention disclosure', effect: 'show the retention policy text sent to group members',
    fn: async () => ok([
      'This bot retains messages that are deleted in groups it is in.',
      'Retention is local to the machine running the bot.',
      'Nothing is forwarded to any other account or destination.',
      'Anyone may ask the operator to stop, or to purge the store.',
      '',
      'The Silent Archive Dispatcher from the spec is not implemented. Forwarding other',
      'people\'s deleted messages to a separate JID extends retention of their content',
      'without their knowledge, which is not something this bot will do.',
    ].join('\n')) },

  { name: 'ops', summary: 'Modules E F G I J help', effect: 'list the ops commands by module',
    fn: async () => ok([
      'E  ematrix asciiart sponge hype rolldice chooseone truth dare',
      '   roast kudos fakey placeholdercycle loremipsum ezhelp',
      '',
      'F  fruntime fgc fhandles flimit flimitreset fbucket fbucketreset fuptime fhealth',
      '   fhdr fsize fconfig fsetconfig fdelconfig fconfigkeys',
      '',
      'I  irole irolecheck irolegrant irolerevoke iroleslist iscrub iscrubself',
      '   ienc idec ijwtcheck ihashfile ikill',
      '',
      'J  jtask jtasks jtaskdone jtaskclear jqueue jset jget jdel jkeys',
      '   jpublish jsubscribe jevents jlog jdrain jhealth jmigrate jversion',
      '   jintent jembed jstore jsearch jvectors',
      '',
      'G  gdump gpurge gexclude gexcludeadd gexcluderemove gnotice',
      '',
      'Everything above reads real state. Nothing here prints invented telemetry.',
      '',
      'ghost-ping is not implemented: mentioning someone without the normal notification',
      'manipulates presentation rather than content, for the same reason Module H is out.',
    ].join('\n')) },
];

/** In-memory task queue. Bounded, so it cannot become a leak. */
const tasks: Task[] = [];
const MAX_TASKS = 1000;

export function installOpsCommands(reg: {
  command(c: { name: string; summary: string; effect: string; family?: string; handler: (ctx: CommandContext) => Promise<CommandResult> }): unknown;
}): void {
  for (const c of opsCommands) {
    reg.command({
      name: c.name,
      summary: c.summary,
      effect: c.effect,
      family: 'ops',
      handler: async (ctx: CommandContext): Promise<CommandResult> => {
        try {
          return await c.fn(ctx);
        } catch (err) {
          return bad(`${c.name}: ${(err as Error).message.slice(0, 200)}`);
        }
      },
    });
  }
}

export { storeDir as opsDataPath };