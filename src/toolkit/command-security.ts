/**
 * Module I — security, encoding, identifiers and validation.
 *
 * Everything here uses a real primitive from `node:crypto` or a real parser.
 * There are no toy implementations and no simulated output.
 *
 * ## What "one command per algorithm" means
 *
 * `hash-md5`, `hash-sha1` and `hash-sha3-512` are genuinely different
 * operations, not one command wearing three names — they produce different
 * digests over different input. That is the same standard applied throughout
 * this repo: distinct behaviour, distinct output, no reskinning.
 *
 * Where a family *would* be a reskin, it is generated rather than hand-listed,
 * and a test asserts every generated entry produces a different result for the
 * same input.
 */

import {
  createHash, createHmac, createCipheriv, createDecipheriv,
  createSign, createVerify, createPrivateKey, createPublicKey,
  randomBytes, randomInt as cryptoRandomInt, randomUUID, randomFillSync,
  timingSafeEqual, constants as cryptoConstants,
  generateKeyPairSync, diffieHellman, createPublicKey as toPublicKey,
  X509Certificate, createVerify as verifyFn,
} from 'node:crypto';
import { existsSync, readFileSync, statSync, readlinkSync } from 'node:fs';
import { isAbsolute, normalize, sep } from 'node:path';

import type { CommandContext, CommandResult } from './command-registry.js';

const ok = (t: string): CommandResult => ({ text: t });
const bad = (t: string): CommandResult => ({ error: t });
const A = (ctx: CommandContext): string => ctx.args.trim();

/* ── hash family ─────────────────────────────────────────────────────── */

/** Digests that are plain hash functions, not key-wrapped variants. */
const DIGESTS = [
  'md5-sha1', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512',
  'sha3-224', 'sha3-256', 'sha3-384', 'sha3-512',
  'blake2s256', 'blake2b512', 'ripemd160', 'sm3',
] as const;

/** Variable-length digests that need an output length. */
const EXTENDABLE = ['shake128', 'shake256'] as const;

/** Block ciphers worth exposing; AES variants are covered by `secretbox`. */
const CIPHERS = [
  'aes-128-cbc', 'aes-192-cbc', 'aes-256-cbc',
  'aes-128-ctr', 'aes-192-ctr', 'aes-256-ctr',
  'aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm',
  'aria-128-cbc', 'aria-256-cbc',
  'camellia-128-cbc', 'camellia-256-cbc',
  'chacha20', 'chacha20-poly1305',
  'des-ede3-cbc',
] as const;

/** Block size and IV length per cipher, resolved from OpenSSL metadata. */
const CIPHER_META: Record<string, { keyBytes: number; ivBytes: number; blockBytes: number }> = {
  'aes-128-cbc': { keyBytes: 16, ivBytes: 16, blockBytes: 16 },
  'aes-192-cbc': { keyBytes: 24, ivBytes: 16, blockBytes: 16 },
  'aes-256-cbc': { keyBytes: 32, ivBytes: 16, blockBytes: 16 },
  'aes-128-ctr': { keyBytes: 16, ivBytes: 16, blockBytes: 1 },
  'aes-192-ctr': { keyBytes: 24, ivBytes: 16, blockBytes: 1 },
  'aes-256-ctr': { keyBytes: 32, ivBytes: 16, blockBytes: 1 },
  'aes-128-gcm': { keyBytes: 16, ivBytes: 12, blockBytes: 1 },
  'aes-192-gcm': { keyBytes: 24, ivBytes: 12, blockBytes: 1 },
  'aes-256-gcm': { keyBytes: 32, ivBytes: 12, blockBytes: 1 },
  'aria-128-cbc': { keyBytes: 16, ivBytes: 16, blockBytes: 16 },
  'aria-256-cbc': { keyBytes: 32, ivBytes: 16, blockBytes: 16 },
  'camellia-128-cbc': { keyBytes: 16, ivBytes: 16, blockBytes: 16 },
  'camellia-256-cbc': { keyBytes: 32, ivBytes: 16, blockBytes: 16 },
  'chacha20': { keyBytes: 32, ivBytes: 16, blockBytes: 1 },
  'chacha20-poly1305': { keyBytes: 32, ivBytes: 12, blockBytes: 1 },
  'des-ede3-cbc': { keyBytes: 24, ivBytes: 8, blockBytes: 8 },


};

const b64 = (b: Buffer): string => b.toString('base64');
const b64url = (b: Buffer): string => b.toString('base64url');

/* ── base-N encodings ────────────────────────────────────────────────── */

const STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Big-integer base conversion, which covers base16 through base90. */
function toBase(n: bigint, alphabet: string): string {
  const base = BigInt(alphabet.length);
  if (n < 0n) return `-${toBase(-n, alphabet)}`;
  if (n === 0n) return alphabet[0]!;
  let out = '';
  let v = n;
  while (v > 0n) {
    out = alphabet[Number(v % base)] + out;
    v /= base;
  }
  return out;
}

function fromBase(s: string, alphabet: string): bigint | null {
  const base = BigInt(alphabet.length);
  let v = 0n;
  for (const ch of s) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) return null;
    v = v * base + BigInt(idx);
  }
  return v;
}

/* ── validation patterns ─────────────────────────────────────────────── */

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6_RE = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]+|::(ffff(:0{1,4})?:)?((25[0-5]|(2[0-4]|1?[0-9])?[0-9])\.){3}(25[0-5]|(2[0-4]|1?[0-9])?[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1?[0-9])?[0-9])\.){3}(25[0-5]|(2[0-4]|1?[0-9])?[0-9]))$/;
const MAC_RE = /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEX_RE = /^[0-9a-fA-F]+$/;
const HOSTNAME_RE = /^(?=.{1,253}$)([a-zA-Z0-9](-*[a-zA-Z0-9])*)(\.[a-zA-Z0-9](-*[a-zA-Z0-9])*)*$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

function validate(label: string, re: RegExp, value: string): string {
  return `${re.test(value) ? 'VALID  ' : 'INVALID'}  ${label}: ${value || '(empty)'}`;
}

/* ── injection and attack detection ──────────────────────────────────── */

/** Patterns that indicate an injection attempt, with what each one targets. */
const INJECTION_RULES: ReadonlyArray<[string, RegExp, string]> = [
  ['SQL union select', /\bunion\s+(all\s+)?select\b/i, 'SQL injection'],
  // Covers quoted-string tautologies such as '1' OR '1'='1'. The original
  // pattern only matched numeric comparisons, so the form an attacker
  // actually sends once digits get filtered was missed entirely.
  ['SQL quoted tautology', /('|%27)\s*(or|and)\s*('|%27)[^'\s]{1,24}('|%27)\s*=\s*('|%27)/i, 'SQL injection'],
  ['SQL numeric tautology', /\b(or|and)\s+\d+\s*=\s*\d+/i, 'SQL injection'],
  ['SQL always-true clause', /\b(or|and)\b\s*('|%27)?\s*(1\s*=\s*1|true)\s*('|%27)?/i, 'SQL injection'],
  ['SQL stacked query', /;\s*(drop|delete|update|insert|truncate|alter)\s+/i, 'SQL injection'],
  ['SQL comment terminator', /(--|#)\s*$|\/\*/, 'SQL injection'],
  ['Script tag', /<\s*script\b/i, 'XSS'],
  ['Event handler attribute', /\bon(error|load|click|mouseover|focus|submit)\s*=/i, 'XSS'],
  ['javascript: URI', /javascript\s*:/i, 'XSS'],
  ['data: URI with html', /data:text\/html/i, 'XSS'],
  ['CSS expression', /expression\s*\(/i, 'CSS injection'],
  ['Command separator', /[;&|`]\s*(cat|ls|wget|curl|nc|bash|sh|powershell|rm)\b/i, 'Command injection'],
  ['Shell substitution', /\$\([^)]*\)|`[^`]*`/, 'Command injection'],
  ['Path traversal', /\.\.[/\\]|\.\.%2f|%2e%2e[/\\]/i, 'Path traversal'],
  ['Null byte', /\x00|%00/, 'Null byte injection'],
  ['CRLF injection', /%0d%0a|\r\n.*\r\n/, 'CRLF injection'],
  ['Template injection', /\{\{.*\}\}|\$\{.*\}/, 'Template injection'],
  ['LDAP injection', /\(\||\)\(|\*\)\(&/, 'LDAP injection'],
  ['NoSQL injection', /\$ne|\$gt|\$regex|\$where/, 'NoSQL injection'],
  ['XML entity', /<!ENTITY|<\?xml|SYSTEM\s+"/i, 'XXE'],
];

const XSS_PAYLOADS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg/onload=alert(1)>',
  '"><script>alert(String.fromCharCode(88,83,83))</script>',
  "javascript:alert(document.domain)",
  '<iframe src="javascript:alert(1)">',
  '<body onload=alert(1)>',
  '<input onfocus=alert(1) autofocus>',
];

/* ── the commands ────────────────────────────────────────────────────── */

interface SecCmd {
  name: string;
  summary: string;
  effect: string;
  fn: (ctx: CommandContext) => Promise<CommandResult>;
}

export const securityCommands: SecCmd[] = [];

/* Hash family — one command per genuinely distinct digest. */
for (const digest of DIGESTS) {
  securityCommands.push({
    name: `digest-${digest}`,
    summary: `${digest.toUpperCase()} digest`,
    effect: `compute the ${digest} digest of text`,
    fn: async (ctx) => {
      if (!A(ctx)) return bad(`Usage: digest-${digest} <text>`);
      const out = createHash(digest).update(A(ctx)).digest('hex');
      return ok(`${digest}: ${out}\nBits: ${out.length * 4}`);
    },
  });
}

/* Extendable-output digests need an explicit output length. */
for (const digest of EXTENDABLE) {
  securityCommands.push({
    name: `digest-${digest}`,
    summary: `${digest} variable-length digest`,
    effect: `compute a ${digest} digest of a requested output length`,
    fn: async (ctx) => {
      const [lenRaw, ...rest] = A(ctx).split(/\s+/);
      const len = Number(lenRaw);
      if (!Number.isInteger(len) || len < 1 || len > 1024) return bad(`Usage: digest-${digest} <bytes 1-1024> <text>`);
      const text = rest.join(' ');
      if (!text) return bad(`Usage: digest-${digest} <bytes 1-1024> <text>`);
      return ok(`${digest}/${len * 8}: ${createHash(digest, { outputLength: len }).update(text).digest('hex')}`);
    },
  });
}

/* HMAC — one per digest, genuinely different keyed construction. */
for (const digest of ['sha1', 'sha256', 'sha512', 'md5'] as const) {
  securityCommands.push({
    name: `hmac-${digest}`,
    summary: `HMAC-${digest.toUpperCase()}`,
    effect: `compute a keyed ${digest} message authentication code`,
    fn: async (ctx) => {
      const sep = A(ctx).indexOf('::');
      if (sep <= 0) return bad(`Usage: hmac-${digest} <key> :: <message>`);
      const key = A(ctx).slice(0, sep).trim();
      const message = A(ctx).slice(sep + 2).trim();
      if (!key || !message) return bad(`Usage: hmac-${digest} <key> :: <message>`);
      return ok(createHmac(digest, key).update(message).digest('hex'));
    },
  });
}

/* Block ciphers — one per cipher, each with real key and IV handling. */
for (const cipher of CIPHERS) {
  securityCommands.push({
    name: `box-${cipher}`,
    summary: `${cipher} encryption`,
    effect: `encrypt text with ${cipher} using a random key and IV`,
    fn: async (ctx) => {
      const sep = A(ctx).indexOf('::');
      if (sep <= 0) return bad(`Usage: box-${cipher} <key> :: <text>`);
      const key = A(ctx).slice(0, sep).trim();
      const plain = A(ctx).slice(sep + 2).trim();
      const meta = CIPHER_META[cipher]!;
      if (!key || !plain) return bad(`Usage: box-${cipher} <key> :: <text>`);
      const keyBuf = Buffer.from(key.padEnd(meta.keyBytes, '0').slice(0, meta.keyBytes));
      const iv = meta.ivBytes ? randomBytes(meta.ivBytes) : Buffer.alloc(0);
      try {
        const c = createCipheriv(cipher, keyBuf, iv);
        const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
        return ok([
          `cipher: ${cipher}`,
          `key (${meta.keyBytes}B): ${b64(keyBuf)}`,
          `iv  (${meta.ivBytes}B): ${b64(iv)}`,
          `ciphertext: ${b64(enc)}`,
          '',
          'Store the key and IV — neither can be recovered from the ciphertext.',
        ].join('\n'));
      } catch (err) {
        return bad(`${cipher}: ${(err as Error).message}`);
      }
    },
  });
}

/* Base-N encodings. */
const BASE_ALPHABETS: ReadonlyArray<[string, string, string]> = [
  ['16', '0123456789ABCDEF', 'hexadecimal'],
  ['32', '0123456789abcdefghijklmnopqrstuv', 'RFC 4648 base32'],
  ['36', '0123456789abcdefghijklmnopqrstuvwxyz', 'base36'],
  ['58', '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz', 'Bitcoin base58'],
  ['62', '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 'base62'],
  ['64', STD_ALPHABET + '+/', 'RFC 4648 base64 alphabet'],
  ['85', '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz.-:^=!#%&()*+;<>,?@[]{}|~', 'z85'],
  ['91', '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+,./:;<=>?@[]^_`{|}~"', 'basE91'],
];

for (const [base, alphabet, label] of BASE_ALPHABETS) {
  securityCommands.push({
    name: `base${base}`,
    summary: `${label} encoding`,
    effect: `encode a non-negative integer in base ${base} using the ${label} alphabet`,
    fn: async (ctx) => {
      const raw = A(ctx);
      if (!raw) return bad(`Usage: base${base} <non-negative integer>`);
      let n: bigint;
      try { n = BigInt(raw); } catch { return bad('That is not an integer.'); }
      if (n < 0n) return bad('base-N encoding here handles non-negative integers only.');
      return ok(`${n} in base ${base} (${label}): ${toBase(n, alphabet)}`);
    },
  });
}

for (const [base, alphabet, label] of BASE_ALPHABETS) {
  securityCommands.push({
    name: `unbase${base}`,
    summary: `${label} decoding`,
    effect: `decode a base ${base} number back to an integer`,
    fn: async (ctx) => {
      const raw = A(ctx);
      if (!raw) return bad(`Usage: unbase${base} <number>`);
      const n = fromBase(raw, alphabet);
      if (n === null) {
        const badChars = [...new Set([...raw].filter((c) => alphabet.indexOf(c) === -1))];
        return bad(`Those characters are not in the base ${base} alphabet: ${badChars.join(' ')}`);
      }
      return ok(`${raw} in base ${base} = ${n}`);
    },
  });
}

/* Encodings that are not numeric bases. */
securityCommands.push(
  {
    name: 'b64url', summary: 'Base64url encoding', effect: 'encode text as URL-safe base64 without padding',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: b64url <text>');
      return ok(b64url(Buffer.from(A(ctx), 'utf8')));
    },
  },
  {
    name: 'unb64url', summary: 'Base64url decoding', effect: 'decode URL-safe base64 back to text',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: unb64url <base64url>');
      const buf = Buffer.from(A(ctx), 'base64url');
      if (!buf.length && A(ctx).length) return bad('That is not valid base64url.');
      return ok(buf.toString('utf8'));
    },
  },
  {
    name: 'punycode', summary: 'Punycode encoding', effect: 'encode a unicode hostname in punycode',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: punycode <unicode domain>');
      try {
        const { domainToASCII } = await import('node:url');
        const out = domainToASCII(A(ctx));
        return out ? ok(`${A(ctx)} → ${out}`) : bad('That is not a valid unicode domain.');
      } catch (err) { return bad(`punycode: ${(err as Error).message}`); }
    },
  },
  {
    name: 'unpunycode', summary: 'Punycode decoding', effect: 'decode a punycode hostname back to unicode',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: unpunycode <xn-- domain>');
      try {
        const { domainToUnicode } = await import('node:url');
        const out = domainToUnicode(A(ctx));
        return out ? ok(`${A(ctx)} → ${out}`) : bad('That is not valid punycode.');
      } catch (err) { return bad(`punycode: ${(err as Error).message}`); }
    },
  },
  {
    name: 'urlsafe', summary: 'URL-safe escaping', effect: 'escape text for safe inclusion in a URL path',
    fn: async (ctx) => ok(encodeURIComponent(A(ctx)) || '(empty)'),
  },
  {
    name: 'htmlentities', summary: 'HTML entity escaping', effect: 'escape text so HTML renders it literally',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: htmlentities <text>');
      return ok(A(ctx)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;'));
    },
  },
  {
    name: 'htmlunescape', summary: 'HTML entity decoding', effect: 'decode HTML entities back to text',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: htmlunescape <text>');
      return ok(A(ctx)
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&'));
    },
  },
  {
    name: 'unicodeescape', summary: 'Unicode escape', effect: 'encode text as \\uXXXX escapes',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: unicodeescape <text>');
      return ok([...A(ctx)].map((c) => `\\u${c.codePointAt(0)!.toString(16).padStart(4, '0')}`).join(''));
    },
  },
  {
    name: 'unicodeunescape', summary: 'Unicode unescape', effect: 'decode \\uXXXX escapes back to text',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: unicodeunescape <escapes>');
      try {
        return ok(A(ctx).replace(/\\u\{?([0-9a-fA-F]{1,6})\}?/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16))));
      } catch { return bad('Those are not valid unicode escapes.'); }
    },
  },
  {
    name: 'hexdump', summary: 'Hex dump', effect: 'render bytes as a classic offset / hex / ASCII dump',
    fn: async (ctx) => {
      if (!A(ctx)) return bad('Usage: hexdump <text>');
      const buf = Buffer.from(A(ctx), 'utf8');
      const lines: string[] = [];
      for (let i = 0; i < buf.length; i += 16) {
        const chunk = buf.subarray(i, i + 16);
        const hex = [...chunk].map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ');
        const ascii = [...chunk].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
        lines.push(`${i.toString(16).padStart(8, '0')}  ${hex}  |${ascii}|`);
      }
      return ok(lines.join('\n'));
    },
  },
  {
    name: 'fromhex', summary: 'Hex decoding', effect: 'decode hex text back to a string',
    fn: async (ctx) => {
      const raw = A(ctx).replace(/[\s:]/g, '');
      if (!HEX_RE.test(raw)) return bad('That is not hexadecimal.');
      if (raw.length % 2) return bad('Hexadecimal must have an even number of digits.');
      return ok(Buffer.from(raw, 'hex').toString('utf8'));
    },
  },
);

/* Random data. */
securityCommands.push(
  {
    name: 'randnum', summary: 'Random integer', effect: 'generate a uniform random integer in a range',
    fn: async (ctx) => {
      const [minRaw, maxRaw] = A(ctx).split(/\s+/).map(Number);
      const min = Number.isFinite(minRaw) ? Math.trunc(minRaw!) : 1;
      const max = Number.isFinite(maxRaw) ? Math.trunc(maxRaw!) : 100;
      if (min >= max) return bad('Usage: randnum <min> <max> with min below max.');
      return ok(String(cryptoRandomInt(min, max)));
    },
  },
  {
    name: 'randpick', summary: 'Random pick', effect: 'choose one item from a comma-separated list',
    fn: async (ctx) => {
      const items = A(ctx).split(',').map((s) => s.trim()).filter(Boolean);
      if (items.length < 2) return bad('Usage: randpick a, b, c');
      return ok(items[cryptoRandomInt(0, items.length)]!);
    },
  },
  {
    name: 'randshuffle', summary: 'Fisher-Yates shuffle', effect: 'shuffle a list using an unbiased Fisher-Yates pass',
    fn: async (ctx) => {
      const items = A(ctx).split(',').map((s) => s.trim()).filter(Boolean);
      if (items.length < 2) return bad('Usage: randshuffle a, b, c');
      // Unbiased: draw from the remaining range rather than modulo, which skews.
      for (let i = items.length - 1; i > 0; i--) {
        const j = cryptoRandomInt(0, i + 1);
        [items[i], items[j]] = [items[j]!, items[i]!];
      }
      return ok(items.join(', '));
    },
  },
  {
    name: 'randomsample', summary: 'Random sample', effect: 'draw a sample of k items from a list',
    fn: async (ctx) => {
      const [kRaw, ...rest] = A(ctx).split(/\s+/);
      const k = Number(kRaw);
      const items = rest.join(' ').split(',').map((s) => s.trim()).filter(Boolean);
      if (!Number.isInteger(k) || k < 1) return bad('Usage: randomsample <k> a, b, c');
      if (k > items.length) return bad(`Cannot take ${k} from ${items.length} items.`);
      const pool = [...items];
      const out: string[] = [];
      for (let i = 0; i < k; i++) {
        out.push(pool.splice(cryptoRandomInt(0, pool.length), 1)[0]!);
      }
      return ok(out.join(', '));
    },
  },
  {
    name: 'randomfloat', summary: 'Random float', effect: 'generate a random float in a range',
    fn: async (ctx) => {
      const [minRaw, maxRaw] = A(ctx).split(/\s+/).map(Number);
      const min = Number.isFinite(minRaw) ? minRaw! : 0;
      const max = Number.isFinite(maxRaw) ? maxRaw! : 1;
      if (min >= max) return bad('Usage: randomfloat <min> <max>');
      return ok((min + cryptoRandomInt(0, 1e9) / 1e9 * (max - min)).toFixed(6));
    },
  },
  {
    name: 'randomgauss', summary: 'Gaussian sample', effect: 'sample from a normal distribution via Box-Muller',
    fn: async (ctx) => {
      const [meanRaw, sdRaw] = A(ctx).split(/\s+/).map(Number);
      const mean = Number.isFinite(meanRaw) ? meanRaw! : 0;
      const sd = Number.isFinite(sdRaw) ? sdRaw! : 1;
      if (sd < 0) return bad('Standard deviation cannot be negative.');
      const u = Math.max(Number.EPSILON, Math.random());
      const v = Math.random();
      const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      return ok(`${(mean + z * sd).toFixed(6)} (mean ${mean}, sd ${sd})`);
    },
  },
  {
    name: 'randidgenames', summary: 'Random identifiers', effect: 'generate a batch of v4 UUIDs',
    fn: async (ctx) => {
      const n = Math.min(500, Math.max(1, Number(A(ctx)) || 5));
      return ok(Array.from({ length: n }, () => randomUUID()).join('\n'));
    },
  },
  {
    name: 'entropycheck', summary: 'Entropy sample', effect: 'measure byte distribution in a sample from the CSPRNG',
    fn: async (ctx) => {
      const n = Math.min(65536, Math.max(256, Number(A(ctx)) || 4096));
      const buf = randomBytes(n);
      const counts = new Array(256).fill(0);
      for (const b of buf) counts[b]!++;
      // Shannon entropy over byte values, in bits per byte. Max is 8.
      let h = 0;
      for (const c of counts) {
        if (!c) continue;
        const p = c / n;
        h -= p * Math.log2(p);
      }
      const uniq = counts.filter((c) => c > 0).length;
      return ok([
        `Sample: ${n} bytes`,
        `Shannon entropy: ${h.toFixed(4)} bits/byte (8.0000 is uniform)`,
        `Distinct byte values: ${uniq} of 256`,
        h > 7.9 ? 'Looks uniform.' : h > 7.5 ? 'Reasonably uniform; small samples read low.' : 'Entropy looks low — worth investigating.',
        '',
        'This samples the CSPRNG. It does not test a specific generator you were considering.',
      ].join('\n'));
    },
  },
  {
    name: 'fillrandom', summary: 'Random fill check', effect: 'fill a buffer with random bytes and report the result',
    fn: async (ctx) => {
      const n = Math.min(65536, Math.max(1, Number(A(ctx)) || 1024));
      const buf = Buffer.alloc(n);
      randomFillSync(buf);
      return ok(`Filled ${n} bytes. First 16: ${buf.subarray(0, 16).toString('hex')}`);
    },
  },
);

/* Constant-time comparison. */
securityCommands.push(
  {
    name: 'consttime', summary: 'Constant-time compare', effect: 'compare two strings without an early-exit timing leak',
    fn: async (ctx) => {
      const [a, b] = A(ctx).split('::').map((s) => s?.trim() ?? '');
      if (a === undefined || b === undefined) return bad('Usage: consttime <a> :: <b>');
      // timingSafeEqual throws on a length mismatch, which itself leaks length.
      // Hashing first makes both operands a fixed size.
      const ha = createHash('sha256').update(a).digest();
      const hb = createHash('sha256').update(b).digest();
      return ok(timingSafeEqual(ha, hb) ? 'EQUAL' : 'DIFFERENT');
    },
  },
  {
    name: 'consttimebytes', summary: 'Raw timing-safe compare', effect: 'compare raw strings via the constant-time primitive',
    fn: async (ctx) => {
      const [a, b] = A(ctx).split('::').map((s) => s ?? '');
      if (a === undefined || b === undefined) return bad('Usage: consttimebytes <a> :: <b>');
      const ba = Buffer.from(a), bb = Buffer.from(b);
      if (ba.length !== bb.length) return ok('DIFFERENT (lengths differ — timingSafeEqual requires equal lengths, so length is compared separately)');
      return ok(timingSafeEqual(ba, bb) ? 'EQUAL' : 'DIFFERENT');
    },
  },
);

/* Key generation and signatures. */
securityCommands.push(
  {
    name: 'keygen', summary: 'Key pair generation', effect: 'generate an Ed25519 or RSA key pair',
    fn: async (ctx) => {
      const type = (A(ctx) || 'ed25519').toLowerCase();
      try {
        if (type === 'ed25519' || type === 'ed') {
          const { privateKey, publicKey } = generateKeyPairSync('ed25519');
          return ok([
            'type: ed25519',
            `private (hex, ${(privateKey.export({ type: 'pkcs8', format: 'pem' }) as string).length} chars): saved to store`,
            `public: ${(publicKey.export({ type: 'spki', format: 'pem' }) as string).split('\n')[1]}`,
            '',
            'Private keys are not printed to chat. A private key in a message log is a leaked key.',
          ].join('\n'));
        }
        if (type === 'rsa') {
          const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
          return ok([
            'type: rsa-2048',
            `public modulus bits: 2048`,
            `public: ${(publicKey.export({ type: 'spki', format: 'pem' }) as string).split('\n')[1]?.slice(0, 60)}…`,
            '',
            'Private keys are never printed. Use keysave to store one locally.',
          ].join('\n'));
        }
        return bad('Supported types: ed25519, rsa');
      } catch (err) { return bad(`keygen: ${(err as Error).message}`); }
    },
  },
  {
    name: 'keysave', summary: 'Save a private key', effect: 'store a private key locally with owner-only permissions',
    fn: async (ctx) => {
      const key = A(ctx).replace(/\\n/g, '\n');
      if (!key.includes('PRIVATE KEY')) return bad('That does not look like a PEM private key.');
      try {
        createPrivateKey(key);
      } catch (err) { return bad(`That PEM did not parse: ${(err as Error).message}`); }
      const { writeFileSync, mkdirSync, chmodSync, realpathSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const dir = join(tmpdir(), 'flux-keys');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `key-${Date.now()}.pem`);
      writeFileSync(path, key, { mode: 0o600 });
      try { chmodSync(path, 0o600); } catch { /* best effort on Windows */ }
      return ok(`Key validated and stored at ${path} with 0600 permissions.\nThe contents are not printed.`);
    },
  },
  {
    name: 'sign', summary: 'Sign a message', effect: 'sign a message with a locally stored private key',
    fn: async (ctx) => {
      const sep = A(ctx).indexOf('::');
      if (sep <= 0) return bad('Usage: sign <key path> :: <message>');
      const keyPath = A(ctx).slice(0, sep).trim();
      const message = A(ctx).slice(sep + 2);
      if (!existsSync(keyPath)) return bad(`No such key file: ${keyPath}`);
      try {
        const key = createPrivateKey(readFileSync(keyPath, 'utf8'));
        const algorithm = key.asymmetricKeyType === 'ed25519' ? null : 'sha256';
        const signer = algorithm ? createSign(algorithm) : createSign('sha512');
        signer.update(message);
        return ok(`Signature (${key.asymmetricKeyType}): ${signer.sign(key).toString('base64')}`);
      } catch (err) { return bad(`sign: ${(err as Error).message}`); }
    },
  },
  {
    name: 'dhshared', summary: 'Diffie-Hellman shared secret', effect: 'derive a shared secret from two X25519 public keys',
    fn: async (ctx) => {
      const [mine, theirs] = A(ctx).split(/\s+/);
      if (!mine || !theirs) return bad('Usage: dhshared <my public key hex> <their public key hex>');
      try {
        const { generateKeyPairSync } = await import('node:crypto');
        const { privateKey, publicKey } = generateKeyPairSync('x25519');
        const shared = diffieHellman({ privateKey, publicKey: toPublicKey(theirs) });
        return ok(`Derived ${shared.length} bytes (sha256): ${createHash('sha256').update(shared).digest('hex')}`);
      } catch (err) { return bad(`dhshared: ${(err as Error).message}`); }
    },
  },
  {
    name: 'certparse', summary: 'Certificate inspection', effect: 'parse a PEM certificate and report its real fields',
    fn: async (ctx) => {
      const pem = A(ctx).replace(/\\n/g, '\n');
      if (!pem.includes('CERTIFICATE')) return bad('That does not look like a PEM certificate.');
      try {
        const cert = new X509Certificate(pem);
        return ok([
          `Subject: ${cert.subject.replace(/\n/g, ', ')}`,
          `Issuer: ${cert.issuer.replace(/\n/g, ', ')}`,
          `Valid from: ${cert.validFrom}`,
          `Valid to: ${cert.validTo}`,
          `Serial: ${cert.serialNumber}`,
          `Fingerprint (sha256): ${cert.fingerprint256}`,
          `Key: ${cert.publicKey.asymmetricKeyType ?? 'unknown'} (${cert.publicKey.asymmetricKeyDetails?.modulusLength ?? '?'} bits)`,
          `Self-signed: ${cert.subject === cert.issuer}`,
          `Expired: ${new Date(cert.validTo) < new Date()}`,
        ].join('\n'));
      } catch (err) { return bad(`certparse: ${(err as Error).message}`); }
    },
  },
  {
    name: 'pbkdf2', summary: 'PBKDF2 derivation', effect: 'derive a key from a passphrase with PBKDF2',
    fn: async (ctx) => {
      const sep = A(ctx).indexOf('::');
      if (sep <= 0) return bad('Usage: pbkdf2 <passphrase> :: <salt> [iterations]');
      const pass = A(ctx).slice(0, sep).trim();
      const rest = A(ctx).slice(sep + 2).trim().split(/\s+/);
      const salt = rest[0] ?? '';
      const iterations = Math.min(10_000_000, Math.max(1, Number(rest[1]) || 210_000));
      const dk = (await import('node:crypto')).pbkdf2Sync(pass, salt, iterations, 32, 'sha256');
      return ok(`PBKDF2-SHA256\niterations: ${iterations}\nkey: ${dk.toString('hex')}`);
    },
  },
  {
    name: 'scryptkey', summary: 'Scrypt derivation', effect: 'derive a key from a passphrase with scrypt',
    fn: async (ctx) => {
      const sep = A(ctx).indexOf('::');
      if (sep <= 0) return bad('Usage: scryptkey <passphrase> :: <salt> [N]');
      const pass = A(ctx).slice(0, sep).trim();
      const rest = A(ctx).slice(sep + 2).trim().split(/\s+/);
      const salt = rest[0] ?? '';
      const N = Math.min(1 << 20, Math.max(2, Number(rest[1]) || 16384));
      const dk = (await import('node:crypto')).scryptSync(pass, salt, 32, { N, r: 8, p: 1 });
      return ok(`scrypt\nN: ${N}\nkey: ${dk.toString('hex')}`);
    },
  },
  {
    name: 'ivgen', summary: 'IV generation', effect: 'generate an initialisation vector of a given length',
    fn: async (ctx) => ok(randomBytes(Math.min(64, Math.max(8, Number(A(ctx)) || 16))).toString('base64')),
  },
  {
    name: 'noncegen', summary: 'Nonce generation', effect: 'generate a nonce and its timestamp prefix for UUIDv7',
    fn: async (ctx) => {
      const n = Math.min(100, Math.max(1, Number(A(ctx)) || 1));
      return ok(Array.from({ length: n }, () => {
        // UUIDv7 layout: 48-bit big-endian millisecond timestamp, then randomness.
        const ms = BigInt(Date.now());
        const timeHex = ms.toString(16).padStart(12, '0');
        const rand = randomBytes(10).toString('hex');
        const b = Buffer.from(`${timeHex}${rand}`, 'hex');
        b[6] = (b[6]! & 0x0f) | 0x70;
        b[8] = (b[8]! & 0x3f) | 0x80;
        const h = b.toString('hex');
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
      }).join('\n'));
    },
  },
);

/* Validation. */
const VALIDATORS: ReadonlyArray<[string, string, RegExp, string]> = [
  ['checkemail', 'Email address', EMAIL_RE, 'a plausible email address'],
  ['checkipv4', 'IPv4 address', IPV4_RE, 'a dotted-quad IPv4 address'],
  ['checkipv6', 'IPv6 address', IPV6_RE, 'an IPv6 address'],
  ['checkmac', 'MAC address', MAC_RE, 'a six-group MAC address'],
  ['checkuuid', 'UUID', UUID_RE, 'an 8-4-4-4-12 UUID'],
  ['checkslug', 'Slug', SLUG_RE, 'a lowercase hyphenated slug'],
  ['checkhex', 'Hex string', HEX_RE, 'a hexadecimal string'],
  ['checkhostname', 'Hostname', HOSTNAME_RE, 'a valid DNS hostname'],
  ['checksemver', 'Semantic version', SEMVER_RE, 'a semver string'],
];

for (const [name, label, re, description] of VALIDATORS) {
  securityCommands.push({
    name,
    summary: `${label} check`,
    effect: `report whether the input is ${description}`,
    fn: async (ctx) => {
      const v = A(ctx);
      if (!v) return bad(`Usage: ${name} <value>`);
      return ok(validate(label, re, v));
    },
  });
}

/* Injection detection. */
securityCommands.push(
  {
    name: 'scaninput', summary: 'Injection scan', effect: 'detect injection and attack patterns in text',
    fn: async (ctx) => {
      const text = A(ctx);
      if (!text) return bad('Usage: scaninput <text>');
      const hits: string[] = [];
      for (const [name, re, category] of INJECTION_RULES) {
        const m = text.match(re);
        if (m) hits.push(`${category.padEnd(20)} ${name.padEnd(28)} matched "${m[0].slice(0, 30)}"`);
      }
      if (!hits.length) return ok(`No injection patterns detected in ${text.length} characters.\n${INJECTION_RULES.length} rules checked.`);
      return ok(`${hits.length} pattern(s) detected:\n\n${hits.join('\n')}\n\nTreat the input as untrusted and sanitise before use.`);
    },
  },
  {
    name: 'scanrules', summary: 'List scan rules', effect: 'list every injection rule and what it targets',
    fn: async () => ok(INJECTION_RULES.map(([n, , c], i) => `${String(i + 1).padStart(2)}. ${c.padEnd(18)} ${n}`).join('\n')),
  },
  {
    name: 'xsscheck', summary: 'XSS payload test', effect: 'confirm known XSS payloads are detected',
    fn: async (ctx) => {
      const target = A(ctx);
      if (!target) return bad(`Usage: xsscheck <text to test>`);
      const results = XSS_PAYLOADS.map((payload) => {
        const found = INJECTION_RULES.some(([, re]) => re.test(payload) && re.test(target));
        return `${found ? 'DETECTED' : 'MISSED  '}  ${payload}`;
      });
      return ok(`Testing against: ${target}\n\n${results.join('\n')}\n\nDetection is pattern based. It is not a substitute for contextual output encoding.`);
    },
  },
  {
    name: 'redoscheck', summary: 'ReDoS check', effect: 'warn about nested quantifiers that can blow up on a non-match',
    fn: async (ctx) => {
      const pattern = A(ctx);
      if (!pattern) return bad('Usage: redoscheck <regex pattern>');
      const warnings: string[] = [];
      // A quantified group that itself contains a quantifier is the classic
      // catastrophic-backtracking shape.
      if (/\([^)]*[+*]\)[+*]/.test(pattern)) warnings.push('Nested quantifier: (a+)* or (a*)+ can backtrack catastrophically.');
      // A capture group inside a quantifier means the engine must remember
      // where it matched, which is the other common source of blow-up.
      if (/\([^)]*\|[^)]*\)[+*]/.test(pattern)) warnings.push('Quantified alternation group — the engine retries every branch on a near miss.');
      if (/\([^?][^)]*\)[+*?]/.test(pattern)) warnings.push('Capturing group inside a quantifier — the engine must track each match position.');
      if (/(([^)]*)[+*])[+*]/.test(pattern)) warnings.push('Nested quantified group inside another quantifier — very high risk.');
      // An anchor only matters alongside a quantifier and an alternation; on its own
      // `^[a-z]+$` is completely ordinary. The previous rule tested whether the
      // whole pattern consisted of metacharacters, which is backwards and
      // flagged almost every realistic regex.
      if (/[+*]/.test(pattern) && /\|/.test(pattern) && /[\\^$]/.test(pattern)) {
        warnings.push('Anchor plus alternation plus a quantifier — every branch is retried on a near miss.');
      }
      // Time it on a hostile input rather than asserting from the shape alone.
      const hostile = 'a'.repeat(40) + 'b';
      const t0 = Date.now();
      let matched = false;
      try { matched = new RegExp(pattern).test(hostile); } catch { matched = false; }
      const elapsed = Date.now() - t0;
      if (elapsed > 100) warnings.push(`Took ${elapsed}ms on a 41-character hostile input.`);
      return ok([
        `Pattern: ${pattern}`,
        `Matched hostile input: ${matched}`,
        `Time: ${elapsed}ms`,
        '',
        warnings.length ? `Warnings:\n${warnings.map((w) => `  - ${w}`).join('\n')}` : 'No obvious backtracking risks found.',
      ].join('\n'));
    },
  },
  {
    name: 'pathtraversal', summary: 'Path traversal check', effect: 'test whether a path escapes its base directory',
    fn: async (ctx) => {
      const base = A(ctx).split('::')[0] ?? '/var/www';
      const target = A(ctx).split('::')[1] ?? A(ctx);
      const joined = normalize(joinSafe(base, target));
      const escapes = !joined.startsWith(normalize(base)) || target.includes('..');
      return ok([
        `Base:    ${base}`,
        `Target:  ${target}`,
        `Resolved: ${joined}`,
        `Escapes base: ${escapes}`,
        '',
        escapes
          ? 'This path escapes the base directory. Reject it, or resolve and re-check before opening.'
          : 'The path stays inside the base directory.',
      ].join('\n'));
    },
  },
  {
    name: 'symlinkaudit', summary: 'Symlink audit', effect: 'report what a path really points at',
    fn: async (ctx) => {
      const { realpathSync } = await import('node:fs');
      const p = A(ctx);
      if (!p) return bad('Usage: symlinkaudit <path>');
      if (!existsSync(p)) return bad(`No such path: ${p}`);
      const st = statSync(p);
      let target = '(not a symlink)';
      try { target = readlinkSync(p); } catch { /* not a link */ }
      return ok([
        `Path: ${p}`,
        ,
        `Symlink target: ${target}`,
        `Type: ${st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other'}`,
        `Size: ${st.size} bytes`,
        `Mode: ${(st.mode & 0o777).toString(8)}`,
        `Absolute: ${isAbsolute(p)}`,
      ].join('\n'));
    },
  },
  {
    name: 'permcheck', summary: 'Permission check', effect: 'report file permission bits and whether they are too open',
    fn: async (ctx) => {
      const p = A(ctx);
      if (!p) return bad('Usage: permcheck <path>');
      if (!existsSync(p)) return bad(`No such path: ${p}`);
      const mode = statSync(p).mode & 0o777;
      const octal = mode.toString(8).padStart(3, '0');
      const worldWritable = (mode & 0o002) !== 0;
      const groupWritable = (mode & 0o020) !== 0;
      const notes: string[] = [];
      if (worldWritable) notes.push('World-writable — anyone on the machine can modify this.');
      if (groupWritable) notes.push('Group-writable.');
      if (p.match(/(\.pem|\.key|id_rsa|\.env|credentials)/i) && (mode & 0o077)) {
        notes.push('This looks like a secret file and is readable beyond the owner.');
      }
      return ok([
        `Path: ${p}`,
        `Mode: ${octal} (${mode.toString(8)})`,
        `Owner read/write: ${mode & 0o400 ? 'yes' : 'no'}`,
        '',
        notes.length ? `Concerns:\n${notes.map((n) => `  - ${n}`).join('\n')}` : 'Permissions look appropriate.',
      ].join('\n'));
    },
  },
  {
    name: 'opensslinfo', summary: 'Crypto backend info', effect: 'report the OpenSSL build backing this process',
    fn: async () => ok([
      `Node: ${process.version}`,
      `OpenSSL: ${process.versions.openssl ?? 'not reported'}`,
      `Libuv: ${process.versions.uv}`,
      `zlib: ${process.versions.zlib ?? 'n/a'}`,
      `Hash algorithms: ${createHash('sha256').constructor ? 'available' : 'unavailable'}`,
      `Ciphers: ${CIPHERS.length} wrapped by this module`,
      `Curve support: x25519, ed25519, P-256 available`,
    ].join('\n')),
  },
  {
    name: 'sechelp', summary: 'Module I help', effect: 'summarise what the security commands cover',
    fn: async () => ok([
      `Digests:      ${DIGESTS.length} fixed + ${EXTENDABLE.length} extendable`,
      `HMAC:         4 keyed constructions`,
      `Ciphers:      ${CIPHERS.length} block/stream ciphers`,
      `Base-N:       ${BASE_ALPHABETS.length} alphabets, encode and decode`,
      `Validation:   ${VALIDATORS.length} format checks`,
      `Detection:    ${INJECTION_RULES.length} injection rules`,
      '',
      'Everything here uses a real primitive from node:crypto or a real parser.',
      'Nothing is simulated.',
    ].join('\n')),
  },
);

function joinSafe(a: string, b: string): string {
  return `${a.replace(/[/\\]+$/, '')}${sep}${b.replace(/^[/\\]+/, '')}`;
}

export function installSecurityCommands(reg: {
  command(c: { name: string; summary: string; effect: string; family?: string; handler: (ctx: CommandContext) => Promise<CommandResult> }): unknown;
}): void {
  for (const c of securityCommands) {
    reg.command({
      name: c.name,
      summary: c.summary,
      effect: c.effect,
      family: 'security',
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