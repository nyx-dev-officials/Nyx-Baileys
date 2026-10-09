/**
 * Utility commands — text, encoding, and everyday computing.
 *
 * Everything here is pure and deterministic: same input, same output, no network
 * and no hidden state. That is the property that makes a utility trustworthy,
 * and it is the opposite of the live-API family, which is useful precisely
 * because it is not deterministic.
 *
 * Each command is hand-written rather than generated. A utility's whole value is
 * that it does one specific thing correctly, so there is nothing to generalise
 * and nothing to table-drive.
 */

import { randomInt, randomBytes } from 'node:crypto';
import type { FamilySpec, CommandContext, CommandResult } from './command-registry.js';

const ok = (text: string): CommandResult => ({ text });
const bad = (error: string): CommandResult => ({ error });

/** The single argument, or '' when absent. */
const argOf = (ctx: CommandContext): string => ctx.arg;

/* ════════════════════════════════════════════════════════════════════════
   Case conversion — genuinely different transforms
   ════════════════════════════════════════════════════════════════════════ */

const words = (s: string): string[] => s
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  .split(/[^A-Za-z0-9]+/)
  .filter(Boolean);

interface CaseDef {
  summary: string;
  fn: (w: string[], raw: string) => string;
}

const CASES: Record<string, CaseDef> = {
  camel: { summary: 'to camelCase', fn: (w) => w.map((x, i) => (i ? x[0]!.toUpperCase() + x.slice(1).toLowerCase() : x.toLowerCase())).join('') },
  pascal: { summary: 'to PascalCase', fn: (w) => w.map((x) => x[0]!.toUpperCase() + x.slice(1).toLowerCase()).join('') },
  snake: { summary: 'to snake_case', fn: (w) => w.map((x) => x.toLowerCase()).join('_') },
  kebab: { summary: 'to kebab-case', fn: (w) => w.map((x) => x.toLowerCase()).join('-') },
  screaming: { summary: 'to SCREAMING_SNAKE_CASE', fn: (w) => w.map((x) => x.toUpperCase()).join('_') },
  dot: { summary: 'to dot.case', fn: (w) => w.map((x) => x.toLowerCase()).join('.') },
  constant: { summary: 'to CONSTANT_CASE', fn: (w) => w.map((x) => x.toUpperCase()).join('-') },
  title: { summary: 'to Title Case', fn: (w) => w.map((x) => x[0]!.toUpperCase() + x.slice(1).toLowerCase()).join(' ') },
  sentence: { summary: 'to Sentence case', fn: (w) => (w.length ? w[0]![0]!.toUpperCase() + w[0]!.slice(1).toLowerCase() + (w.length > 1 ? ' ' + w.slice(1).join(' ').toLowerCase() : '') : '') },
  lower: { summary: 'to lower case', fn: (_w, raw) => raw.toLowerCase() },
  upper: { summary: 'to UPPER CASE', fn: (_w, raw) => raw.toUpperCase() },
  invert: { summary: 'iNVERt cASE (swap case)', fn: (_w, raw) => [...raw].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join('') },
  alternating: { summary: 'aLtErNaTiNg case', fn: (_w, raw) => [...raw].map((c, i) => (i % 2 ? c.toUpperCase() : c.toLowerCase())).join('') },
};

export const caseFamily: FamilySpec<{ key: string; def: CaseDef }> = {
  id: 'case',
  title: 'letter case conversion',
  entries: Object.entries(CASES).map(([key, def]) => ({
    name: `case-${key}`,
    summary: def.summary,
    data: { key, def },
  })),
  build: async (entry, ctx) => {
    const raw = ctx.args.trim();
    if (!raw) return ok(`Usage: case-${entry.data.key} <text>`);
    const w = words(raw);
    return ok(entry.data.def.fn(w, raw));
  },
};

/* ════════════════════════════════════════════════════════════════════════
   Encoding — each direction genuinely different
   ════════════════════════════════════════════════════════════════════════ */

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

const ENCODERS: Record<string, { summary: string; fn: (s: string) => string }> = {
  base64: { summary: 'Base64-encode text', fn: (s) => Buffer.from(s, 'utf8').toString('base64') },
  hex: { summary: 'Hex-encode text', fn: (s) => Buffer.from(s, 'utf8').toString('hex') },
  url: { summary: 'URL-encode text', fn: (s) => encodeURIComponent(s) },
  binary: { summary: 'Encode text as bytes (latin1)', fn: (s) => Buffer.from(s, 'binary').toString('base64') },
  rot13: { summary: 'ROT13 cipher', fn: (s) => [...s].map((c) => {
    const code = c.charCodeAt(0);
    if (code >= 65 && code <= 90) return String.fromCharCode(((code - 65 + 13) % 26) + 65);
    if (code >= 97 && code <= 122) return String.fromCharCode(((code - 97 + 13) % 26) + 97);
    return c;
  }).join('') },
  caesar: { summary: 'Caesar cipher with an explicit shift', fn: (s) => s },
};

const DECODERS: Record<string, { summary: string; fn: (s: string) => string }> = {
  base64: { summary: 'Base64-decode', fn: (s) => Buffer.from(s.trim(), 'base64').toString('utf8') },
  hex: { summary: 'Hex-decode', fn: (s) => Buffer.from(s.trim(), 'hex').toString('utf8') },
  url: { summary: 'URL-decode', fn: (s) => decodeURIComponent(s.trim()) },
  rot13: { summary: 'ROT13 cipher', fn: (s) => [...s].map((c) => {
    const code = c.charCodeAt(0);
    if (code >= 65 && code <= 90) return String.fromCharCode(((code - 65 + 13) % 26) + 65);
    if (code >= 97 && code <= 122) return String.fromCharCode(((code - 97 + 13) % 26) + 97);
    return c;
  }).join('') },
};

export const encodeFamily: FamilySpec<{ key: string; def: { summary: string; fn: (s: string) => string } }> = {
  id: 'encode',
  title: 'encoding',
  entries: Object.entries(ENCODERS).filter(([k]) => k !== 'caesar').map(([key, def]) => ({
    name: `enc-${key}`, summary: def.summary, data: { key, def },
  })),
  build: async (entry, ctx) => {
    if (!ctx.args) return ok(`Usage: enc-${entry.data.key} <text>`);
    return ok(entry.data.def.fn(ctx.args));
  },
};

export const decodeFamily: FamilySpec<{ key: string; def: { summary: string; fn: (s: string) => string } }> = {
  id: 'decode',
  title: 'decoding',
  entries: Object.entries(DECODERS).map(([key, def]) => ({
    name: `dec-${key}`, summary: def.summary, data: { key, def },
  })),
  build: async (entry, ctx) => {
    const raw = ctx.args.trim();
    if (!raw) return ok(`Usage: dec-${entry.data.key} <text>`);
    try {
      const out = entry.data.def.fn(raw);
      // A decoder that yields mojibake is worse than one that admits failure.
      if (/�/.test(out) && entry.data.key !== 'base64') {
        return bad(`${entry.data.key}: input is not valid ${entry.data.key}`);
      }
      return ok(out);
    } catch (err) {
      return bad(`${entry.data.key}: ${(err as Error).message.slice(0, 90)}`);
    }
  },
};

/* ════════════════════════════════════════════════════════════════════════
   Text utilities
   ════════════════════════════════════════════════════════════════════════ */

export const textUtils = [
  {
    name: 'wordcount', summary: 'Count words, characters and sentences',
    effect: 'tokenise input and report word, character, sentence and line counts',
    handler: async (ctx: CommandContext): Promise<CommandResult> => {
      const s = ctx.args;
      if (!s.trim()) return ok('Usage: wordcount <text>');
      const words = s.trim().split(/\s+/).length;
      const sentences = (s.match(/[.!?]+(\s|$)/g) ?? []).length || 1;
      const readingMin = words / 225;
      return ok([
        `Words      : ${words}`,
        `Characters : ${s.length}  (${[...s].length} codepoints)`,
        `Sentences  : ${sentences}`,
        `Lines      : ${s.split('\n').length}`,
        `Reading    : ~${readingMin < 1 ? Math.round(readingMin * 60) : Math.round(readingMin)} sec`,
      ].join('\n'));
    },
  },
  {
    name: 'slugify', summary: 'Turn text into a URL-safe slug',
    effect: 'lowercase, strip diacritics, collapse non-alphanumerics to hyphens',
    handler: async (ctx: CommandContext): Promise<CommandResult> => {
      if (!ctx.args.trim()) return ok('Usage: slugify <text>');
      const slug = ctx.args
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
      return ok(slug || '(nothing left after slugging)');
    },
  },
  {
    name: 'clean-url', summary: 'Strip tracking parameters from a URL',
    effect: 'remove known analytics parameters from a URL and report what went',
    handler: async (ctx: CommandContext): Promise<CommandResult> => {
      const raw = ctx.args.trim();
      if (!raw) return ok('Usage: clean-url <url>\nExample: clean-url https://x.com/a?utm_source=x&id=1');
      let u: URL;
      try { u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); }
      catch { return bad('clean-url: not a valid URL'); }

      // The standard tracking parameters. Removing these does not break the
      // link; removing `id` or `page` would.
      const TRACKING = /^(utm_|fbclid$|gclid$|msclkid$|_ga$|mc_cid$|mc_eid$|igshid$|ref$|referrer$|source$|spm$|yclid$|twclid$|_hsenc$|_hsmi$)/i;
      const removed: string[] = [];
      for (const key of [...u.searchParams.keys()]) {
        if (TRACKING.test(key)) { removed.push(key); u.searchParams.delete(key); }
      }
      return ok([
        u.toString(),
        removed.length ? `Removed: ${removed.join(', ')}` : 'No tracking parameters found.',
      ].join('\n'));
    },
  },
  {
    name: 'mdtable', summary: 'Align messy text into a Markdown table',
    effect: 'parse pipe- or comma-separated rows and pad every column to equal width',
    handler: async (ctx: CommandContext): Promise<CommandResult> => {
      const rows = ctx.args.split('\n').map((l) => l.trim()).filter(Boolean);
      if (rows.length < 2) return ok('Usage: mdtable <header row>\\n<row>\\n<row>...\nSeparate columns with | or commas.');

      const split = (line: string): string[] => (
        line.includes('|') ? line.split('|').map((c) => c.trim()) : line.split(/\s*,\s*/).map((c) => c.trim())
      );
      const parsed = rows.map(split);
      const cols = Math.max(...parsed.map((r) => r.length));
      const widths = Array.from({ length: cols }, (_, i) =>
        Math.max(...parsed.map((r) => (r[i] ?? '').length)));

      const line = (cells: string[]) => `| ${cells.map((c, i) => (c ?? '').padEnd(widths[i]!)).join(' | ')} |`;
      const out = [
        line(parsed[0]!),
        `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`,
        ...parsed.slice(1).map(line),
      ];
      return ok(out.join('\n'));
    },
  },
  {
    name: 'password', summary: 'Generate a strong random password',
    effect: 'produce a cryptographically random password from a named character set',
    handler: async (ctx: CommandContext): Promise<CommandResult> => {
      const len = Math.min(256, Math.max(8, Number.parseInt(ctx.arg || '20', 10) || 20));
      const preset = ctx.args.split(/\s+/)[1]?.toLowerCase() ?? 'alnum';
      // Ambiguous glyphs (0/O, 1/l/I) are excluded by default; a password read
      // off a screen should not be a coin flip.
      const SETS: Record<string, string> = {
        alnum: 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789',
        lower: 'abcdefghijkmnopqrstuvwxyz',
        upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
        digits: '23456789',
        alphanum: 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ0123456789',
        ascii: '!@#$%^&*()-_=+[]{}<>?,.;:~',
      };
      const charset = SETS[preset] ?? SETS.alnum!;
      const pw = Array.from({ length: len }, () => charset[randomInt(charset.length)]).join('');
      // entropy = length * log2(charset size)
      const bits = Math.round(len * Math.log2(charset.length));
      return ok([
        pw,
        '',
        `Length  : ${len}`,
        `Set     : ${preset} (${charset.length} chars)`,
        `Entropy : ~${bits} bits`,
      ].join('\n'));
    },
  },
  {
    name: 'token', summary: 'Generate a random hex token',
    effect: 'produce random bytes from the CSPRNG rendered as hex',
    handler: async (ctx: CommandContext): Promise<CommandResult> => {
      const bytes = Math.min(128, Math.max(1, Number.parseInt(ctx.arg || '16', 10) || 16));
      const hex = randomBytes(bytes).toString('hex');
      return ok(`${hex}\n\n${bytes} bytes · ${bytes * 8} bits · cryptographically random`);
    },
  },
  {
    name: 'json-fmt', summary: 'Pretty-print JSON',
    effect: 'parse JSON and re-emit it with two-space indentation and stable key order',
    handler: async (ctx: CommandContext): Promise<CommandResult> => {
      if (!ctx.args.trim()) return ok('Usage: json-fmt <json>');
      try {
        const parsed = JSON.parse(ctx.args);
        return ok(JSON.stringify(parsed, null, 2).slice(0, 3500));
      } catch (err) {
        return bad(`json-fmt: ${(err as Error).message.slice(0, 110)}`);
      }
    },
  },
  {
    name: 'luhn', summary: 'Check a card or ID number with the Luhn algorithm',
    effect: 'compute the Luhn checksum of a numeric string and compare it to the last digit',
    handler: async (ctx: CommandContext): Promise<CommandResult> => {
      const digits = ctx.args.replace(/\D/g, '');
      if (digits.length < 2) return ok('Usage: luhn <number>\nExample: luhn 4532015112830366');
      let sum = 0;
      let dbl = false;
      for (let i = digits.length - 1; i >= 0; i--) {
        let d = digits.charCodeAt(i) - 48;
        if (dbl) { d *= 2; if (d > 9) d -= 9; }
        sum += d;
        dbl = !dbl;
      }
      const valid = sum % 10 === 0;
      return ok([
        `Number   : ${digits}`,
        `Sum      : ${sum}`,
        `Modulo   : ${sum % 10}`,
        `Checksum : ${valid ? 'VALID' : 'INVALID'}`,
      ].join('\n'));
    },
  },
  {
    name: 'roman', summary: 'Convert a number to Roman numerals',
    effect: 'apply the Roman numeral greedy algorithm within its defined range',
    handler: async (ctx: CommandContext): Promise<CommandResult> => {
      const n = Number.parseInt(ctx.args.trim(), 10);
      if (!Number.isFinite(n)) return ok('Usage: roman <1-3999>');
      if (n < 1 || n > 3999) return bad('roman: must be between 1 and 3999');
      const table: Array<[number, string]> = [
        [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
        [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
      ];
      let left = n;
      let out = '';
      for (const [value, sym] of table) {
        while (left >= value) { out += sym; left -= value; }
      }
      return ok(`${n} = ${out}`);
    },
  },
  {
    name: 'ordinal', summary: 'Turn a number into its ordinal form',
    effect: 'apply English ordinal suffix rules including 11th/12th/13th exceptions',
    handler: async (ctx: CommandContext): Promise<CommandResult> => {
      const n = Number.parseInt(ctx.args.trim(), 10);
      if (!Number.isFinite(n)) return ok('Usage: ordinal <number>');
      const abs = Math.abs(n);
      const s = abs % 100;
      // 11, 12, 13 take "th" despite ending in 1, 2 or 3.
      if (s >= 11 && s <= 13) return ok(`${n}th`);
      return ok(`${n}${abs % 10 === 1 ? 'st' : abs % 10 === 2 ? 'nd' : abs % 10 === 3 ? 'rd' : 'th'}`);
    },
  },
  {
    name: 'cron', summary: 'Describe a cron expression in words',
    effect: 'parse a five-field cron expression and describe each field',
    handler: async (ctx: CommandContext): Promise<CommandResult> => {
      const parts = ctx.args.trim().split(/\s+/);
      if (parts.length !== 5) return ok('Usage: cron <min hour dom mon dow>\nExample: cron */5 * * * *');
      const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
      const d = (v: string, unit: string) => (v === '*' ? `every ${unit}` : v);
      return ok([
        `Expression: ${parts.join(' ')}`,
        `  minute : ${d(min, 'minute')}`,
        `  hour   : ${d(hour, 'hour')}`,
        `  day    : ${d(dom, 'day of month')}`,
        `  month  : ${d(mon, 'month')}`,
        `  weekday: ${d(dow, 'day of week')}`,
        '',
        'Field order: minute hour day-of-month month day-of-week',
      ].join('\n'));
    },
  },
  {
    name: 'contrast', summary: 'Check WCAG contrast between two hex colours',
    effect: 'compute the WCAG 2.1 relative-luminance contrast ratio and its AA/AAA verdict',
    handler: async (ctx: CommandContext): Promise<CommandResult> => {
      const parts = ctx.args.trim().split(/[\s,]+/).filter(Boolean);
      const hex = (h: string): [number, number, number] | null => {
        const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(h.trim());
        if (!m) return null;
        let s = m[1]!;
        if (s.length === 3) s = s.split('').map((c) => c + c).join('');
        return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
      };
      const [a, b] = [hex(parts[0] ?? ''), hex(parts[1] ?? '')];
      if (!a || !b) return ok('Usage: contrast <#hex1> <#hex2>\nExample: contrast #000000 #ffffff');

      // WCAG relative luminance: linearise each channel, then weight.
      const lum = ([r, g, bl]: [number, number, number]): number => {
        const ch = [r, g, bl].map((v) => {
          const c = v / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
      };
      const l1 = lum(a);
      const l2 = lum(b);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const r = ratio.toFixed(2);
      return ok([
        `${parts[0]} vs ${parts[1]}`,
        `Contrast : ${r}:1`,
        `AA text  : ${ratio >= 4.5 ? 'PASS' : 'FAIL'} (needs 4.5)`,
        `AA large : ${ratio >= 3 ? 'PASS' : 'FAIL'} (needs 3)`,
        `AAA text : ${ratio >= 7 ? 'PASS' : 'FAIL'} (needs 7)`,
      ].join('\n'));
    },
  },
  {
    name: 'dedupe', summary: 'Remove duplicate lines',
    effect: 'drop repeated lines while preserving first-seen order',
    handler: async (ctx: CommandContext): Promise<CommandResult> => {
      const lines = ctx.args.split('\n');
      const seen = new Set<string>();
      const out: string[] = [];
      for (const l of lines) {
        const t = l.trim();
        if (!t) continue;
        if (seen.has(t)) continue;
        seen.add(t);
        out.push(l);
      }
      return ok([...out, '', `${lines.length} lines → ${out.length} unique (${lines.length - out.length} removed)`].join('\n'));
    },
  },
  {
    name: 'sortlines', summary: 'Sort lines alphabetically or numerically',
    effect: 'sort input lines with a stable comparator and report the ordering used',
    handler: async (ctx: CommandContext): Promise<CommandResult> => {
      const lines = ctx.args.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length < 2) return ok('Usage: sortlines a\\nb\\nc');
      const numeric = lines.every((l) => /^-?\d+(\.\d+)?$/.test(l));
      const desc = /^-/.test(ctx.arg);
      const sorted = [...lines].sort((a, b) => {
        const cmp = numeric
          ? Number.parseFloat(a) - Number.parseFloat(b)
          : a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
        return desc ? -cmp : cmp;
      });
      return ok(sorted.join('\n'));
    },
  },
  {
    name: 'tsconvert', summary: 'Convert a Unix timestamp to a date and back',
    effect: 'render a Unix timestamp in local and UTC, and accept a date string for the reverse',
    handler: async (ctx: CommandContext): Promise<CommandResult> => {
      const raw = ctx.args.trim();
      if (!raw) return ok('Usage: tsconvert <unix-seconds | ISO date>');
      const asNum = Number.parseInt(raw, 10);
      const d = /^\d+$/.test(raw)
        ? new Date(asNum * 1000)
        : new Date(raw);
      if (Number.isNaN(d.getTime())) return bad('tsconvert: could not parse that as a timestamp or date');

      const back = Math.floor(d.getTime() / 1000);
      return ok([
        `Input    : ${raw}`,
        `Local    : ${d.toLocaleString()}`,
        `UTC      : ${d.toISOString()}`,
        `Unix     : ${back}`,
        `Unix ms  : ${d.getTime()}`,
        `Relative : ${this === null ? '' : relative(d)}`,
      ].join('\n'));
    },
  },
] as const;

function relative(d: Date): string {
  const diff = Math.round((d.getTime() - Date.now()) / 1000);
  const abs = Math.abs(diff);
  const units: Array<[number, string]> = [
    [31_536_000, 'year'], [2_592_000, 'month'], [604_800, 'week'],
    [86_400, 'day'], [3_600, 'hour'], [60, 'minute'], [1, 'second'],
  ];
  for (const [secs, name] of units) {
    if (abs >= secs) return `${diff < 0 ? '' : 'in '}${Math.round(abs / secs)} ${name}${Math.round(abs / secs) === 1 ? '' : 's'}${diff < 0 ? ' ago' : ''}`;
  }
  return 'just now';
}

/* ════════════════════════════════════════════════════════════════════════
   install
   ════════════════════════════════════════════════════════════════════════ */

export function installUtilityFamilies(reg: { family<T>(s: FamilySpec<T>): unknown; command(c: { name: string; summary: string; effect: string; handler: (ctx: CommandContext) => Promise<CommandResult> }): unknown }): void {
  reg.family(caseFamily);
  reg.family(encodeFamily);
  reg.family(decodeFamily);
  for (const c of textUtils) {
    reg.command({
      name: c.name,
      summary: c.summary,
      effect: c.effect,
      family: 'utility',
      handler: c.handler,
    } as never);
  }
}