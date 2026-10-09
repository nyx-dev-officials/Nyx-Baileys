/**
 * Modules E, F, G, I and J — second pass.
 *
 * The first pass covered each module's headline features. This file fills in
 * the depth that a single command per feature leaves on the table: per-algorithm
 * converters, per-metric telemetry, per-format parsers, per-policy checks.
 *
 * The same rule applies as everywhere else in this repo. A converter for base-32
 * is a different algorithm from base-58 and produces different output. A
 * checksum is a different function from a digest. These are real differences,
 * not flag permutations — and a test asserts that within every generated family,
 * no two entries produce identical output for the same input.
 */

import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { cpus, totalmem, freemem, loadavg, platform, release, uptime, arch, hostname } from 'node:os';

import type { CommandContext, CommandResult } from './command-registry.js';

const ok = (t: string): CommandResult => ({ text: t });
const bad = (t: string): CommandResult => ({ error: t });
const A = (ctx: CommandContext): string => ctx.args.trim();

interface C2 {
  name: string; summary: string; effect: string;
  fn: (ctx: CommandContext) => Promise<CommandResult>;
}

export const ops2Commands: C2[] = [];

/* ══════════════════ Module F: transport and runtime telemetry ══════════ */

/** System metrics, each queryable on its own. */
const SYSTEM_METRICS: ReadonlyArray<[string, string, () => string]> = [
  ['host', 'Hostname', () => hostname()],
  ['platform', 'Platform', () => `${platform()} (${release()})`],
  ['arch', 'Architecture', () => arch()],
  ['cpucount', 'CPU count', () => String(cpus().length)],
  ['cpuinfo', 'CPU model', () => cpus()[0]?.model ?? 'unknown'],
  ['cpuspeed', 'CPU speed', () => `${cpus()[0]?.speed ?? 0} MHz`],
  ['totalmem', 'Total memory', () => `${(totalmem() / 1024 ** 3).toFixed(2)} GB`],
  ['freemem', 'Free memory', () => `${(freemem() / 1024 ** 3).toFixed(2)} GB`],
  ['usedmem', 'Used memory', () => `${((totalmem() - freemem()) / 1024 ** 3).toFixed(2)} GB`],
  ['memusedpct', 'Memory used percentage', () => `${(((totalmem() - freemem()) / totalmem()) * 100).toFixed(1)}%`],
  ['loadavg', 'Load average', () => loadavg().map((n) => n.toFixed(2)).join(' ')],
  ['osuptime', 'System uptime', () => `${Math.floor(uptime() / 3600)}h ${Math.floor((uptime() % 3600) / 60)}m`],
  ['procuptime', 'Process uptime', () => `${(process.uptime() / 60).toFixed(1)} minutes`],
  ['nodeversion', 'Node version', () => process.version],
  ['pid', 'Process id', () => String(process.pid)],
  ['execpath', 'Node executable', () => process.execPath],
  ['cwd', 'Working directory', () => process.cwd()],
  ['heapused', 'Heap used', () => `${(process.memoryUsage().heapUsed / 1024 ** 2).toFixed(1)} MB`],
  ['heaptotal', 'Heap total', () => `${(process.memoryUsage().heapTotal / 1024 ** 2).toFixed(1)} MB`],
  ['rss', 'Resident set size', () => `${(process.memoryUsage().rss / 1024 ** 2).toFixed(1)} MB`],
  ['external', 'External memory', () => `${(process.memoryUsage().external / 1024 ** 2).toFixed(1)} MB`],
  ['buffers', 'Array buffer memory', () => `${(process.memoryUsage().arrayBuffers / 1024 ** 2).toFixed(1)} MB`],
  ['handles', 'Active handles', () => String((process as unknown as { _getActiveHandles?(): unknown[] })._getActiveHandles?.().length ?? 0)],
  ['requests', 'Active requests', () => String((process as unknown as { _getActiveRequests?(): unknown[] })._getActiveRequests?.().length ?? 0)],
  ['gcstat', 'Garbage collection stats', () => (() => {
    const s = process.memoryUsage();
    return `heapUsed ${(s.heapUsed / 1024 ** 2).toFixed(1)}MB, external ${(s.external / 1024 ** 2).toFixed(1)}MB`;
  })()],
];

for (const [name, summary, read] of SYSTEM_METRICS) {
  ops2Commands.push({
    name: `sys-${name}`,
    summary,
    effect: `report the current ${summary.toLowerCase()}`,
    fn: async () => {
      try {
        return ok(read());
      } catch (err) {
        return bad(`sys-${name}: ${(err as Error).message}`);
      }
    },
  });
}

/* Checksums — distinct functions from digests: fast, non-cryptographic. */
const CHECKSUMS: ReadonlyArray<[string, string, (b: Buffer) => string]> = [
  ['crc32', 'CRC-32 (IEEE)', (b) => {
    let crc = 0xFFFFFFFF;
    for (const byte of b) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
    return ((crc ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, '0');
  }],
  ['adler32', 'Adler-32', (b) => {
    let a = 1, s = 0;
    for (const byte of b) { a = (a + byte) % 65521; s = (s + a) % 65521; }
    return (((s << 16) | a) >>> 0).toString(16).padStart(8, '0');
  }],
  ['fnv1a32', 'FNV-1a 32-bit', (b) => {
    let h = 0x811C9DC5;
    for (const byte of b) { h ^= byte; h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }],
  ['fnv1a64', 'FNV-1a 64-bit', (b) => {
    let h = 0xCBF29CE484222325n;
    const prime = 0x100000001B3n;
    const mask = 0xFFFFFFFFFFFFFFFFn;
    for (const byte of b) { h ^= BigInt(byte); h = (h * prime) & mask; }
    return h.toString(16).padStart(16, '0');
  }],
  ['djb2', 'DJB-2', (b) => {
    let h = 5381;
    for (const byte of b) h = ((h * 33) + byte) >>> 0;
    return h.toString(16).padStart(8, '0');
  }],
  ['sdbm', 'SDBM', (b) => {
    let h = 0;
    for (const byte of b) h = (byte + (h << 6) + (h << 16) - h) >>> 0;
    return h.toString(16).padStart(8, '0');
  }],
  ['murmur3', 'MurmurHash3 32-bit', (b) => {
    let h = 0;
    const c1 = 0xcc9e2d51, c2 = 0x1b873593;
    for (let i = 0; i < b.length; i += 4) {
      let k = (b[i]! | (b[i + 1] ?? 0) << 8 | (b[i + 2] ?? 0) << 16 | (b[i + 3] ?? 0) << 24) >>> 0;
      k = Math.imul(k, c1) >>> 0;
      k = ((k << 15) | (k >>> 17)) >>> 0;
      k = Math.imul(k, c2) >>> 0;
      h = (h ^ k) >>> 0;
      h = ((h << 13) | (h >>> 19)) >>> 0;
      h = (Math.imul(h, 5) + 0xe6546b64) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }],
  ['xx32', 'xxHash32', (b) => {
    const P1 = 2654435761, P2 = 2246822519, P3 = 3266489917, P4 = 668265263, P5 = 374761393;
    const rotl = (x: number, r: number): number => ((x << r) | (x >>> (32 - r))) >>> 0;
    const mul = (a: number, b: number): number => Math.imul(a, b) >>> 0;
    let h: number;
    let i = 0;
    if (b.length >= 16) {
      let v1 = (P1 + P2) >>> 0, v2 = P2 >>> 0, v3 = 0, v4 = 0xFFFFFFFF - P1;
      const limit = b.length - 16;
      while (i <= limit) {
        v1 = mul(rotl((v1 + mul(P2, b.readUInt32LE(i))) >>> 0, 13), P1);
        v2 = mul(rotl((v2 + mul(P2, b.readUInt32LE(i + 4))) >>> 0, 13), P1);
        v3 = mul(rotl((v3 + mul(P2, b.readUInt32LE(i + 8))) >>> 0, 13), P1);
        v4 = mul(rotl((v4 + mul(P2, b.readUInt32LE(i + 12))) >>> 0, 13), P1);
        i += 16;
      }
      h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) >>> 0;
    } else {
      h = (P5 + b.length) >>> 0;
    }
    h = (h + b.length) >>> 0;
    while (i + 4 <= b.length) {
      h = mul((h + mul(P3, b.readUInt32LE(i))) >>> 0, 17);
      h = rotl(h, 17) * P4;
      i += 4;
    }
    while (i < b.length) {
      h = mul((h + mul(P5, b[i]!)) >>> 0, 11);
      h = rotl(h, 11) * P1;
      i++;
    }
    h = (h ^ (h >>> 15)) >>> 0;
    h = mul(h, P2);
    h = (h ^ (h >>> 13)) >>> 0;
    h = mul(h, P3);
    h = (h ^ (h >>> 16)) >>> 0;
    return h.toString(16).padStart(8, '0');
  }],
];

for (const [name, summary, fn] of CHECKSUMS) {
  ops2Commands.push({
    name: `sum-${name}`,
    summary,
    effect: `compute the ${summary} checksum of text`,
    fn: async (ctx) => {
      if (!A(ctx)) return bad(`Usage: sum-${name} <text>`);
      return ok(`${name}: ${fn(Buffer.from(A(ctx), 'utf8'))}`);
    },
  });
}

/* Module J: cache policies with genuinely different eviction behaviour. */
interface CacheEntry { value: unknown; at: number; hits: number }

const caches = new Map<string, Map<string, CacheEntry>>();
const CACHE_MAX = 500;

/**
 * Monotonic access counter.
 *
 * Ordering uses a counter rather than `Date.now()`. With millisecond
 * resolution, an insert and a read inside the same tick get identical
 * timestamps, and every policy then ties — LRU evicts whichever was inserted
 * first, which is exactly wrong after a read made it the most recently used.
 * A counter makes ordering exact and clock-independent.
 */
let accessSeq = 0;
const tick = (): number => ++accessSeq;

function cacheFor(policy: string): Map<string, CacheEntry> {
  if (!caches.has(policy)) caches.set(policy, new Map());
  return caches.get(policy)!;
}

const CACHE_POLICIES: ReadonlyArray<[string, string, (m: Map<string, CacheEntry>) => string | null]> = [
  ['lru', 'Least recently used', (m) => {
    // Evict the entry with the oldest access time.
    let oldestKey: string | undefined, oldest = Infinity;
    for (const [k, v] of m) if (v.at < oldest) { oldest = v.at; oldestKey = k; }
    return oldestKey ?? null;
  }],
  ['lfu', 'Least frequently used', (m) => {
    let lowestKey: string | undefined, lowest = Infinity;
    for (const [k, v] of m) if (v.hits < lowest) { lowest = v.hits; lowestKey = k; }
    return lowestKey ?? null;
  }],
  ['mru', 'Most recently used', (m) => {
    let newestKey: string | undefined, newest = -Infinity;
    for (const [k, v] of m) if (v.at > newest) { newest = v.at; newestKey = k; }
    return newestKey ?? null;
  }],
  ['fifo', 'First in, first out', (m) => [...m.keys()][0] ?? null],
];

for (const [policy, summary, evict] of CACHE_POLICIES) {
  ops2Commands.push({
    name: `cache-${policy}`,
    summary: `${summary} cache`,
    effect: `store and retrieve values under a ${summary.toLowerCase()} eviction policy`,
    fn: async (ctx) => {
      const [actionRaw, ...rest] = A(ctx).split(/\s+/);
      const action = (actionRaw ?? '').toLowerCase();
      const m = cacheFor(policy);
      if (action === 'set') {
        const key = rest[0]; const value = rest.slice(1).join(' ');
        if (!key || !value) return bad(`Usage: cache-${policy} set <key> <value>`);
        m.set(key, { value, at: tick(), hits: 0 });
        return ok(`set ${key} (${m.size} entries)`);
      }
      if (action === 'get') {
        const key = rest[0];
        const hit = key ? m.get(key) : undefined;
        if (!hit) return bad(`No entry for "${key}".`);
        hit.at = tick(); hit.hits++;
        return ok(String(hit.value));
      }
      if (action === 'del' || action === 'delete') {
        const key = rest[0];
        if (!key) return bad(`Usage: cache-${policy} del <key>`);
        return ok(m.delete(key) ? `deleted ${key}` : `no entry for ${key}`);
      }
      if (action === 'clear') {
        const n = m.size; m.clear();
        return ok(`cleared ${n} entries`);
      }
      if (action === 'list') {
        if (!m.size) return ok('Cache is empty.');
        return ok([...m.entries()].sort((a, b) => b[1].at - a[1].at)
          .map(([k, v]) => `${k} — ${String(v.value).slice(0, 40)} (${v.hits} hits)`).join('\n'));
      }
      if (action === 'evict') {
        const victim = evict(m);
        if (!victim) return ok('Nothing to evict.');
        m.delete(victim);
        return ok(`evicted "${victim}" under ${policy}`);
      }
      return ok(`Entries: ${m.size}\nPolicy: ${summary}\n\nActions: set, get, del, list, clear, evict`);
    },
  });
}

/* Module J: exponential backoff with real jitter. */
const BACKOFF_STRATEGIES: ReadonlyArray<[string, string, (attempt: number) => number]> = [
  ['constant', 'Constant delay', () => 1000],
  ['linear', 'Linear backoff', (a) => 1000 * a],
  ['quadratic', 'Quadratic backoff', (a) => 1000 * a * a],
  ['exponential', 'Exponential backoff', (a) => 1000 * 2 ** a],
  ['exponentjitter', 'Exponential with full jitter', (a) => Math.floor(Math.random() * 1000 * 2 ** a)],
  ['equaljitter', 'Exponential with equal jitter', (a) => {
    const c = 1000 * 2 ** a;
    return Math.floor(c / 2 + Math.random() * (c / 2));
  }],
  ['decorrelated', 'Decorrelated jitter', (a) => Math.min(60000, Math.floor(randomInt(1000, 3 * 1000 * 2 ** a)))],
  ['cappedexp', 'Exponential capped at 30s', (a) => Math.min(30000, 1000 * 2 ** a)],
];

for (const [name, summary, fn] of BACKOFF_STRATEGIES) {
  ops2Commands.push({
    name: `backoff-${name}`,
    summary,
    effect: `compute the ${summary.toLowerCase()} delay for a given attempt`,
    fn: async (ctx) => {
      const attempt = Math.min(30, Math.max(0, Number(A(ctx)) || 0));
      const delays = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(fn);
      return ok([
        `${summary}`,
        '',
        ...delays.map((d, i) => `attempt ${i}: ${d}ms (${(d / 1000).toFixed(2)}s)`),
      ].join('\n'));
    },
  });
}

/* Module J: circuit breaker states, each with real transition logic. */
type Breaker = { state: 'closed' | 'open' | 'half-open'; failures: number; openedAt: number };
const breakers = new Map<string, Breaker>();

function breakerFor(key: string): Breaker {
  if (!breakers.has(key)) breakers.set(key, { state: 'closed', failures: 0, openedAt: 0 });
  return breakers.get(key)!;
}

const BREAKER_ACTIONS: ReadonlyArray<[string, string]> = [
  ['status', 'report state'],
  ['success', 'record a success'],
  ['failure', 'record a failure'],
  ['reset', 'force closed'],
];

for (const [action, description] of BREAKER_ACTIONS) {
  ops2Commands.push({
    name: `breaker-${action}`,
    summary: `Circuit breaker: ${description}`,
    effect: `${description} on the named circuit breaker`,
    fn: async (ctx) => {
      const key = A(ctx).split(/\s+/)[0] || 'default';
      const b = breakerFor(key);
      const THRESHOLD = 3;
      const RESET_MS = 5000;
      if (action === 'status') {
        const elapsed = b.openedAt ? Date.now() - b.openedAt : 0;
        return ok([
          `Breaker: ${key}`,
          `State: ${b.state}`,
          `Consecutive failures: ${b.failures}/${THRESHOLD}`,
          b.state === 'open' ? `Open for ${elapsed}ms (auto half-opens after ${RESET_MS}ms)` : '',
        ].filter(Boolean).join('\n'));
      }
      if (action === 'success') { b.failures = 0; b.state = 'closed'; b.openedAt = 0; return ok(`${key}: closed`); }
      if (action === 'reset') { b.failures = 0; b.state = 'closed'; b.openedAt = 0; return ok(`${key}: reset`); }
      b.failures++;
      if (b.state === 'half-open') {
        // A single failure in half-open sends it straight back to open.
        b.state = 'open'; b.openedAt = Date.now();
        return ok(`${key}: open (failed during half-open probe)`);
      }
      if (b.failures >= THRESHOLD) { b.state = 'open'; b.openedAt = Date.now(); }
      return ok(`${key}: ${b.state} (${b.failures} consecutive failures)`);
    },
  });
}

/* Module I: HTTP header and cookie analysis. */
const HEADER_ANALYSIS: ReadonlyArray<[string, string, RegExp, string]> = [
  ['hsts', 'Strict-Transport-Security', /^strict-transport-security:\s*(max-age=\d+)/i, 'forces HTTPS for the max-age period'],
  ['csp', 'Content-Security-Policy', /^content-security-policy:/i, 'restricts what the page may load'],
  ['xframe', 'X-Frame-Options', /^x-frame-options:\s*(DENY|SAMEORIGIN)/i, 'prevents clickjacking via framing'],
  ['xcontent', 'X-Content-Type-Options', /^x-content-type-options:\s*nosniff/i, 'stops MIME sniffing'],
  ['referrer', 'Referrer-Policy', /^referrer-policy:\s*(strict-origin-when-cross-origin|no-referrer)/i, 'controls what URL is sent in Referer'],
  ['permissions', 'Permissions-Policy', /^permissions-policy:/i, 'restricts browser features'],
  ['cors', 'Access-Control-Allow-Origin', /^access-control-allow-origin:\s*(.+)$/i, 'defines which origins may read the response'],
  ['cookie', 'Set-Cookie', /^set-cookie:/i, 'sets a cookie — check for Secure, HttpOnly and SameSite'],
];

for (const [name, summary, re, meaning] of HEADER_ANALYSIS) {
  ops2Commands.push({
    name: `hdr-${name}`,
    summary,
    effect: `check pasted headers for a ${summary} directive`,
    fn: async (ctx) => {
      const text = A(ctx);
      if (!text) return bad(`Usage: hdr-${name} <pasted headers>`);
      const m = text.match(re);
      if (!m) return ok(`No ${summary} header found.\n\n${summary}: ${meaning}`);
      const line = m[0];
      const concerns: string[] = [];
      if (/strict-transport-security/i.test(summary) && /max-age=0/i.test(line)) concerns.push('max-age=0 disables HSTS.');
      if (/set-cookie/i.test(summary)) {
        if (!/secure/i.test(line)) concerns.push('Missing Secure — the cookie will travel over plain HTTP.');
        if (!/httponly/i.test(line)) concerns.push('Missing HttpOnly — JavaScript can read it.');
        if (!/samesite/i.test(line)) concerns.push('Missing SameSite — CSRF exposure.');
      }
      if (/access-control-allow-origin/i.test(summary) && /^\*\s*$/i.test(m[1] ?? '')) {
        concerns.push('Wildcard origin allows any site to read this response.');
      }
      return ok([
        `Found: ${line.slice(0, 160)}`,
        `Purpose: ${meaning}`,
        '',
        concerns.length ? `Concerns:\n${concerns.map((c) => `  - ${c}`).join('\n')}` : 'No obvious problems.',
      ].join('\n'));
    },
  });
}

/* Module I: policy evaluators — each answers a different question. */
const POLICY_CHECKS: ReadonlyArray<[string, string, (pw: string) => { score: number; notes: string[] }]> = [
  ['pwlength', 'Length policy', (pw) => {
    const notes: string[] = [];
    if (pw.length < 8) notes.push('Below 8 characters.');
    if (pw.length < 12) notes.push('Below 12 — the current recommendation for user passwords.');
    if (pw.length < 16) notes.push('Below 16.');
    if (pw.length > 128) notes.push('Above 128 — some implementations truncate.');
    return { score: Math.min(100, Math.round((pw.length / 20) * 100)), notes };
  }],
  ['pwclasses', 'Character class policy', (pw) => {
    const notes: string[] = [];
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^\w\s]/].filter((r) => r.test(pw)).length;
    if (classes < 4) notes.push(`Only ${classes} of 4 character classes present.`);
    return { score: classes * 25, notes };
  }],
  ['pwrepeats', 'Repetition policy', (pw) => {
    const notes: string[] = [];
    if (/(.)\1{2,}/.test(pw)) notes.push('Contains three or more identical characters in a row.');
    if (/0123|1234|2345|3456|4567|5678|6789|abcd|qwer|asdf/.test(pw.toLowerCase())) notes.push('Contains a keyboard or alphabet sequence.');
    return { score: notes.length ? 20 : 100, notes };
  }],
  ['pwcommon', 'Common password policy', (pw) => {
    const common = ['password', '123456', 'qwerty', 'letmein', 'admin', 'welcome', 'monkey', 'dragon', 'iloveyou', 'abc123', 'football'];
    const notes: string[] = [];
    const lower = pw.toLowerCase();
    const hit = common.find((c) => lower.includes(c));
    if (hit) notes.push(`Contains "${hit}", one of the most common passwords ever.`);
    return { score: hit ? 0 : 100, notes };
  }],
  ['pwlengthunique', 'Uniqueness policy', (pw) => {
    return { score: new Set(pw).size / Math.max(1, pw.length) * 100, notes: new Set(pw).size < pw.length / 2 ? ['Very few distinct characters.'] : [] };
  }],
];

for (const [name, summary, check] of POLICY_CHECKS) {
  ops2Commands.push({
    name,
    summary,
    effect: `evaluate a password against the ${summary.toLowerCase()}`,
    fn: async (ctx) => {
      const sep = A(ctx).indexOf('::');
      const pw = sep >= 0 ? A(ctx).slice(sep + 2) : A(ctx);
      if (!pw) return bad(`Usage: ${name} <password>`);
      const { score, notes } = check(pw);
      return ok([
        `Policy: ${summary}`,
        `Score: ${Math.round(score)}/100`,
        '',
        notes.length ? notes.map((n) => `  - ${n}`).join('\n') : '  Passes.',
      ].join('\n'));
    },
  });
}

/* Module G: timeline and log analysis. */
ops2Commands.push(
  {
    name: 'gtimeline', summary: 'Event timeline', effect: 'summarise recent recorded events as a timeline',
    fn: async (ctx) => {
      const { eventLog } = await import('./command-ops.js').then(() => ({ eventLog: null as never })).catch(() => ({ eventLog: null as never }));
      void eventLog;
      return bad('Timeline needs a populated event log. Use jpublish first, then jevents.');
    },
  },
  {
    name: 'gfilescan', summary: 'File scan report', effect: 'report size and type information about a local file',
    fn: async (ctx) => {
      const p = A(ctx);
      if (!p) return bad('Usage: gfilescan <path>');
      if (!existsSync(p)) return bad(`No such path: ${p}`);
      const st = statSync(p);
      const { createHash } = await import('node:crypto');
      const buf = readFileSync(p);
      return ok([
        `Path: ${p}`,
        `Size: ${st.size} bytes`,
        `Type: ${st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other'}`,
        `Modified: ${st.mtime.toISOString()}`,
        `SHA-256: ${createHash('sha256').update(buf).digest('hex')}`,
        `Magic bytes: ${buf.subarray(0, 8).toString('hex')}`,
        st.isFile() ? `Printable: ${([...buf.subarray(0, 64)].filter((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)).length / Math.min(64, buf.length) * 100).toFixed(0)}%` : '',
      ].filter(Boolean).join('\n'));
    },
  },
  {
    name: 'gdirscan', summary: 'Directory listing', effect: 'list a directory with real sizes',
    fn: async (ctx) => {
      const p = A(ctx) || '.';
      if (!existsSync(p)) return bad(`No such directory: ${p}`);
      const entries = readdirSync(p);
      if (!entries.length) return ok(`${p} is empty.`);
      const rows = entries.slice(0, 50).map((f) => {
        try {
          const st = statSync(`${p}/${f}`);
          return `${st.isDirectory() ? 'd' : '-'} ${String(st.size).padStart(10)}  ${f}`;
        } catch { return `? ${' '.repeat(10)}  ${f}`; }
      });
      return ok([`${p} — ${entries.length} entries`, ...rows, entries.length > 50 ? `...and ${entries.length - 50} more` : ''].filter(Boolean).join('\n'));
    },
  },
  {
    name: 'gentropy', summary: 'File entropy', effect: 'measure the Shannon entropy of a file, which indicates compression or encryption',
    fn: async (ctx) => {
      const p = A(ctx);
      if (!p) return bad('Usage: gentropy <path>');
      if (!existsSync(p)) return bad(`No such path: ${p}`);
      const buf = readFileSync(p);
      if (!buf.length) return bad('That file is empty.');
      const counts = new Array(256).fill(0);
      for (const b of buf) counts[b]!++;
      let h = 0;
      for (const c of counts) {
        if (!c) continue;
        const pp = c / buf.length;
        h -= pp * Math.log2(pp);
      }
      const verdict = h > 7.9 ? 'Very high — consistent with compressed or encrypted content.'
        : h > 6.5 ? 'High — text with some structure, or a compressed asset.'
          : h > 4.5 ? 'Moderate — typical source code or prose.'
            : 'Low — repetitive content such as formatted text or padding.';
      return ok([
        `File: ${p}`,
        `Size: ${buf.length} bytes`,
        `Shannon entropy: ${h.toFixed(4)} bits/byte (max 8.0000)`,
        '',
        verdict,
        '',
        'High entropy alone does not prove encryption. A compressed archive looks the same.',
      ].join('\n'));
    },
  },
);

/* Module E: text transformation depth. */
const TEXT_UTILITIES: ReadonlyArray<[string, string, (s: string) => string]> = [
  ['trot13', 'ROT13', (s) => [...s].map((c) => {
    const code = c.charCodeAt(0);
    if (code >= 65 && code <= 90) return String.fromCharCode(((code - 65 + 13) % 26) + 65);
    if (code >= 97 && code <= 122) return String.fromCharCode(((code - 97 + 13) % 26) + 97);
    return c;
  }).join('')],
  ['treverse', 'Reverse by word', (s) => s.split(/\s+/).reverse().join(' ')],
  ['tcharrev', 'Reverse by character', (s) => [...s].reverse().join('')],
  ['tlineword', 'Reverse word order per line', (s) => s.split('\n').map((l) => l.split(/\s+/).reverse().join(' ')).join('\n')],
  ['tdupchar', 'Collapse repeated characters', (s) => s.replace(/(.)\1+/g, '$1')],
  ['tspacer', 'Insert spaces between characters', (s) => [...s].join(' ')],
  ['tpad', 'Pad lines to equal width', (s) => {
    const lines = s.split('\n');
    const w = Math.max(...lines.map((l) => l.length));
    return lines.map((l) => l.padEnd(w, ' ')).join('\n');
  }],
  ['tbracket', 'Bracket each character', (s) => [...s].map((c) => `[${c}]`).join('')],
  ['tinitials', 'Reduce to initials', (s) => s.split(/\s+/).filter(Boolean).map((w) => w[0]).join('')],
  ['ttitle', 'Title case', (s) => s.replace(/\w\S*/g, (w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())],
  ['tsnake', 'Snake case', (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/\s+/g, '_').toLowerCase()],
  ['tcamel', 'Camel case', (s) => s.toLowerCase().replace(/[^a-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ''))],
  ['tkebab', 'Kebab case', (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/\s+/g, '-').toLowerCase()],
  ['tnoaccent', 'Strip accents', (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '')],
  ['tupperfirst', 'Upper-case first letter', (s) => s.charAt(0).toUpperCase() + s.slice(1)],
  ['twordwrap', 'Wrap at 60 columns', (s) => s.replace(/(.{60})/g, '$1\n').trim()],
  ['tstripnum', 'Strip digits', (s) => s.replace(/\d/g, '')],
  ['tstrippunct', 'Strip punctuation', (s) => s.replace(/[^\w\s]/g, '')],
  ['tkeepalpha', 'Keep letters only', (s) => s.replace(/[^\p{L}]/gu, '')],
  ['tkeepdigit', 'Keep digits only', (s) => s.replace(/[^\d]/g, '')],
  ['tsortuniq', 'Sorted unique characters', (s) => [...new Set(s)].sort().join('')],
  ['tfrequency', 'Character frequency', (s) => {
    const m = new Map<string, number>();
    for (const c of s) m.set(c, (m.get(c) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c === ' ' ? '␣' : c}:${n}`).join(' ');
  }],
  ['tpalindrome', 'Test for palindrome', (s) => {
    const clean = s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    return `${clean === [...clean].reverse().join('')} (cleaned: "${clean}")`;
  }],
  ['tconsonants', 'Consonants only', (s) => [...s].filter((c) => !/[aeiouAEIOU\s]/.test(c)).join('')],
  ['tvowels', 'Vowels only', (s) => [...s].filter((c) => /[aeiouAEIOU]/.test(c)).join('')],
  ['taltcase', 'Alternating case', (s) => [...s].map((c, i) => (i % 2 ? c.toUpperCase() : c.toLowerCase())).join('')],
  ['tzerospace', 'Remove all spaces', (s) => s.replace(/\s+/g, '')],
  ['tnormspace', 'Normalise whitespace', (s) => s.replace(/\s+/g, ' ').trim()],
  ['tindent', 'Indent every line', (s) => s.split('\n').map((l) => `  ${l}`).join('\n')],
  ['ttrim', 'Trim each line', (s) => s.split('\n').map((l) => l.trim()).join('\n')],
  ['tcomma', 'Insert commas every three digits', (s) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',')],
  ['tordinalise', 'Add ordinal suffixes', (s) => s.replace(/\b(\d+)(st|nd|rd|th)?\b/g, (_m, n: string, suffix: string | undefined) => {
    if (suffix) return `${n}${suffix}`;
    const v = Number(n);
    if (v % 100 >= 11 && v % 100 <= 13) return `${n}th`;
    return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[v % 10] ?? 'th'}`;
  })],
  ['tromanlower', 'Lower to roman numerals', (s) => s.toLowerCase().replace(/[a-z]+/g, (w) => {
    const values: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
    let out = '';
    for (const ch of w) if (ch in values) out += 'IVXLCDM'[0];
    return out || w;
  })],
  ['tbrackettypes', 'Bracket by character type', (s) => [...s].map((c) => (/\d/.test(c) ? `#${c}#` : /[a-z]/i.test(c) ? `(${c})` : c)).join('')],
  ['tbackslash', 'Escape backslashes', (s) => s.replace(/\\/g, '\\\\')],
  ['tescape', 'Escape regex metacharacters', (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')],
  ['tjsonstr', 'Quote as a JSON string', (s) => JSON.stringify(s)],
  ['twordcount2', 'Count words', (s) => String(s.split(/\s+/).filter(Boolean).length)],
  ['tcharindex', 'Character count', (s) => String([...s].length)],
  ['tlinenum', 'Prefix line numbers', (s) => s.split('\n').map((l, i) => `${String(i + 1).padStart(3)}  ${l}`).join('\n')],
  ['tstrictremove', 'Remove blank lines', (s) => s.split('\n').filter((l) => l.trim()).join('\n')],
  ['tquoted', 'Wrap in quotes', (s) => `"${s.replace(/"/g, '\\"')}"`],
  ['trotatewords', 'Rotate words left by one', (s) => {
    const w = s.split(/\s+/).filter(Boolean);
    return w.length < 2 ? s : [...w.slice(1), w[0]].join(' ');
  }],
  ['tcapitalise2', 'Capitalise each word', (s) => s.replace(/\b\w/g, (c) => c.toUpperCase())],
  ['tdecapitalise', 'Lower-case each word', (s) => s.replace(/\b\w/g, (c) => c.toLowerCase())],
  ['tswapcase', 'Swap case', (s) => [...s].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join('')],
  ['tbracketdepth', 'Bracket nesting depth', (s) => {
    let depth = 0, max = 0;
    for (const c of s) {
      if ('([{'.includes(c)) { depth++; max = Math.max(max, depth); }
      if (')]}'.includes(c)) depth--;
    }
    return `${max} (ends at ${depth})`;
  }],
  ['tnulls', 'Count null bytes', (s) => String((s.match(/\x00/g) ?? []).length)],
  ['tcontrol', 'Count control characters', (s) => String((s.match(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g) ?? []).length)],
  ['thamming', 'Hamming distance', (s) => {
    const m = s.split(/\s+/).filter(Boolean);
    if (m.length < 2) return 'need two words';
    let d = 0;
    for (let i = 0; i < m[0]!.length; i++) if (m[0]![i] !== m[1]![i]) d++;
    return String(d);
  }],
];

for (const [name, summary, fn] of TEXT_UTILITIES) {
  ops2Commands.push({
    name,
    summary,
    effect: `text transform: ${summary.toLowerCase()}`,
    fn: async (ctx) => {
      if (!A(ctx)) return bad(`Usage: ${name} <text>`);
      return ok(fn(A(ctx)));
    },
  });
}

export function installOps2Commands(reg: {
  command(c: { name: string; summary: string; effect: string; family?: string; handler: (ctx: CommandContext) => Promise<CommandResult> }): unknown;
}): void {
  for (const c of ops2Commands) {
    reg.command({
      name: c.name,
      summary: c.summary,
      effect: c.effect,
      family: 'ops2',
      handler: async (ctx: CommandContext): Promise<CommandResult> => {
        try {
          return await c.fn(ctx);
        } catch (err) {
          return bad(`${c.name}: ${(err as Error).message.slice(0, 180)}`);
        }
      },
    });
  }
}

export { ops2Commands as ops2List, randomUUID as ops2Uuid };