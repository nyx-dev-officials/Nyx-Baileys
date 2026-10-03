import { createHash } from 'node:crypto';

import type { Logger, Plugin } from '../utils/types.js';

/**
 * Deep redaction of secrets.
 *
 * Session material is the crown jewel of this process. A single
 * `JSON.stringify(state)` in a debug log, a thrown error object, or a webhook
 * payload hands an attacker a full account takeover: `noiseKey` plus
 * `advSecretKey` is enough to re-authenticate as the paired number. This module
 * is the choke point that stops that from happening by accident.
 *
 * Three properties matter more than cleverness here:
 *
 *   1. **It never returns the input.** Everything is rebuilt into fresh
 *      containers, so redacting a live object cannot mutate the session state
 *      it was handed.
 *   2. **Buffers are never dumped.** A `Buffer` in a log line is a hex/base64
 *      blob of key material, and JSON.stringify will happily emit it. Buffers
 *      become a length-only placeholder.
 *   3. **Every mask has a reason.** `findings[]` says what was masked and why,
 *      so an operator can audit the redaction without ever seeing the secret.
 *      A redactor you cannot inspect is a redactor you cannot trust.
 *
 * What it is not: it is a safety net for *known* secret shapes and *named*
 * keys. It cannot tell you that `notes: "the password is hunter2"` is a
 * secret. Do not write code that depends on it finding novel key formats.
 */

/** Where a redaction happened, expressed as a path into the input. */
export type RedactionPath = string;

export interface RedactionFinding {
  readonly path: RedactionPath;
  /** Which rule fired. Stable string, safe to aggregate on. */
  readonly rule: string;
  readonly kind: 'key' | 'value' | 'buffer' | 'pii' | 'truncated' | 'shape';
  /** Size of the original value where it is safe and useful to record. */
  readonly bytes?: number;
}

/** Replacement for a masked value. Carries no information about the original. */
export const REDACTED = '[redacted]';
export const REDACTED_PII = '[pii]';

/**
 * What a Buffer became. Deliberately a plain object so it survives
 * `JSON.stringify` in a log line instead of throwing or expanding to bytes.
 */
export interface BufferPlaceholder {
  readonly __type: 'redacted-buffer';
  readonly byteLength: number;
}

/**
 * The redacted shape of `T`.
 *
 * Byte arrays become a placeholder, containers recurse, everything else keeps
 * its type. This is a *structural* promise, not a deep one: it cannot express
 * "this string is now shorter", so callers that care about the value must not
 * feed the result back into business logic. Redacted output is for logs,
 * audit records and outbound diagnostics — nothing else.
 */
export type Redacted<T> = T extends Uint8Array
  ? BufferPlaceholder
  : T extends ArrayBuffer
    ? BufferPlaceholder
    : T extends Date
      ? Date
      : T extends RegExp
        ? RegExp
        : T extends Map<infer K, infer V>
          ? Map<K, Redacted<V>>
          : T extends Set<infer V>
            ? Set<Redacted<V>>
            : T extends readonly (infer U)[]
              ? Array<Redacted<U>>
              : T extends object
                ? { [K in keyof T]: Redacted<T[K]> }
                : T;

export interface RedactOptions {
  /** Extra key names to mask, normalised the same way as the built-ins. */
  readonly extraKeys?: readonly string[];
  /** Replacement text. Keep it fixed-length; a length hint leaks. */
  readonly placeholder?: string;
  /**
   * Replace secrets with `sha256:<8 hex>` instead of a flat placeholder.
   *
   * Lets you correlate "the same key appears in two events" without revealing
   * the key. Still a hash of a low-entropy secret, so treat the digest as
   * sensitive when the input was guessable.
   */
  readonly fingerprint?: boolean;
  /** Mask known PII fields (`me`, `pushName`, `notify`, …). Default true. */
  readonly redactPii?: boolean;
  /**
   * Treat high-entropy opaque strings (long base64/hex) as secrets. Default
   * true. Turn it off if you are redacting prose that legitimately contains
   * hashes, and accept the gap.
   */
  readonly scanOpaqueBlobs?: boolean;
  /** Max container depth before the walk gives up. Default 12. */
  readonly maxDepth?: number;
  /** Max array elements kept. Default 1000. Extra elements are dropped. */
  readonly maxArrayLength?: number;
  /** Strings longer than this are truncated. Default 8192. */
  readonly maxStringLength?: number;
  /** Called for every mask, in traversal order. */
  readonly onFinding?: (finding: RedactionFinding) => void;
}

/* ── key rules ─────────────────────────────────────────────────────────────
 *
 * Keys are compared normalised: lowercased with every non-alphanumeric
 * character removed. That collapses `advSecretKey`, `adv_secret_key` and
 * `ADV-SECRET-KEY` onto one rule, which is the point — the shape of a
 * credential name in a config file or a JSON body varies by whoever wrote it,
 * and a rule that only matches one spelling matches none of them in practice.
 *
 * These are **leaf** names on purpose. Container-ish names (`creds`,
 * `credentials`, `signalIdentities`) are deliberately absent: masking a whole
 * `creds` object makes the redacted output useless for debugging while adding
 * nothing, because every secret inside it is already covered by a leaf rule or
 * by the Buffer branch. The exception is a container name a caller supplies via
 * `extraKeys`, where "this whole subtree is secret" is the stated intent.
 */

const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  /* ── Baileys session material: the whole point of this module ── */
  'noisekey',
  'signedidentitykey',
  'signedprekey',
  'prekey',
  'advsecretkey',
  'advencryptkey',
  'enckey',
  'mackey',
  'pairingephemeralkeypair',
  'identifierkey',
  'myappstatekeyid',
  'appstatesynckey',
  'lastprophash',
  'registrationid',
  'advaccountkey',

  /* ── generic key material ── */
  'privatekey',
  'secretkey',
  'signingkey',
  'verifyingkey',
  'sharedsecret',

  /* ── credentials and tokens ── */
  'password',
  'passwd',
  'passphrase',
  'secret',
  'clientsecret',
  'apikey',
  'apisecret',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'sessiontoken',
  'bearertoken',
  'authtoken',
  'apitoken',
  'tctoken',
  'credential',
  'authorization',
  'cookie',
  'setcookie',
  'webhookurl',
  'webhooksecret',
]);

/**
 * PII fields. Masked separately so an operator can tell "we hid a credential"
 * from "we hid a phone number".
 */
const PII_KEYS: ReadonlySet<string> = new Set([
  'me',
  'pushname',
  'notify',
  'vname',
  'about',
  'displayname',
  'fullname',
  'email',
  'phonenumber',
  'phone',
  'address',
  'lid',
]);

/**
 * Keys that are only secret in context.
 *
 * `private` on its own is too broad to mask unconditionally — it appears on
 * half of all config objects meaning "is this private?". It is a secret when
 * it is one half of a key pair, which is detectable from the sibling `public`.
 * Precision here is the difference between a redaction layer people keep
 * enabled and one they turn off in week two.
 */
const CONTEXTUAL_KEYS: ReadonlySet<string> = new Set(['private', 'secret', 'token']);

const normalizeKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Keys masked unless the caller opted out of PII redaction. */
export function isSensitiveKey(key: string, options: RedactOptions = {}): boolean {
  const n = normalizeKey(key);
  if (SENSITIVE_KEYS.has(n)) return true;
  if ((options.redactPii ?? true) && PII_KEYS.has(n)) return true;
  return false;
}

/* ── value-shape rules ────────────────────────────────────────────────────
 *
 * A credential pasted into an innocuously-named field (`description`,
 * `comment`, a chat message) has no sensitive key. These catch the shapes that
 * real tokens have, which is a heuristic and is treated as one: every rule has
 * an id so a false positive is traceable, and `scanOpaqueBlobs: false`
 * disables the widest-net rule.
 */

interface ShapeRule {
  readonly id: string;
  readonly source: string;
  /**
   * Anchored rules only match a *whole* value — a PEM block or a JWT is a
   * secret on its own, whereas "bearer" in prose is not.
   */
  readonly anchored: boolean;
  readonly note: string;
}

const SHAPE_RULES: readonly ShapeRule[] = [
  {
    id: 'pem-private-key',
    source: '-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\\s\\S]*?(?:-----END (?:[A-Z ]+ )?PRIVATE KEY-----|$)',
    anchored: false,
    note: 'PEM private key block',
  },
  {
    id: 'jwt',
    source: 'eyJ[A-Za-z0-9_-]{6,}\\.[A-Za-z0-9_-]{6,}\\.[A-Za-z0-9_-]{4,}',
    anchored: false,
    note: 'JSON Web Token',
  },
  {
    id: 'anthropic-key',
    source: 'sk-ant-[A-Za-z0-9_-]{16,}',
    anchored: false,
    note: 'Anthropic-style API key',
  },
  {
    id: 'openai-key',
    source: 'sk-(?:proj-)?[A-Za-z0-9_-]{16,}',
    anchored: false,
    note: 'OpenAI-style API key',
  },
  {
    id: 'github-token',
    source: '(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}',
    anchored: false,
    note: 'GitHub token',
  },
  {
    id: 'slack-token',
    source: 'xox[baprs]-[A-Za-z0-9-]{10,}',
    anchored: false,
    note: 'Slack token',
  },
  {
    id: 'aws-access-key',
    source: 'AKIA[0-9A-Z]{16}',
    anchored: false,
    note: 'AWS access key id',
  },
  {
    id: 'google-api-key',
    source: 'AIza[0-9A-Za-z_-]{35}',
    anchored: false,
    note: 'Google API key',
  },
  {
    id: 'url-credentials',
    source: '[a-z][a-z0-9+.-]*://[^\\s/:@]+:[^\\s/@]+@[^\\s]+',
    anchored: false,
    note: 'URL with embedded credentials',
  },
  {
    id: 'auth-header',
    source: '\\b(?:basic|bearer)\\s+[A-Za-z0-9._~+/=-]{8,}',
    anchored: false,
    note: 'Authorization header value',
  },
  {
    id: 'whatsapp-session-token',
    source: '\\b\\d{1,5}:[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}',
    anchored: false,
    note: 'WhatsApp session credential fragment',
  },
  {
    id: 'data-uri',
    source: 'data:[\\w.+-]+/[\\w.+-]+;base64,[A-Za-z0-9+/=]{40,}',
    anchored: false,
    note: 'Inline base64 data URI',
  },
  {
    id: 'hex-blob',
    source: '[a-f0-9]{40,}',
    anchored: true,
    note: 'Hex secret (hash, key or digest)',
  },
  {
    id: 'base64-blob',
    source: '[A-Za-z0-9+/=_-]{32,}',
    anchored: true,
    note: 'Base64-looking blob',
  },
];

/** Compiled once; module-level caching beats recompiling on every log line. */
const compiled = SHAPE_RULES.map((rule) => ({
  rule,
  test: new RegExp(rule.anchored ? `^(?:${rule.source})$` : rule.source, 'i'),
  global: new RegExp(rule.source, 'gi'),
}));

/**
 * Cheap "is this an opaque blob rather than a word" test.
 *
 * The `base64-blob` rule is the widest net in the set and the only one likely
 * to mask something benign, so it gets an extra gate: mixed case or digits,
 * plus a character-class transition, plus no whitespace. Without this, a
 * 32-character dictionary word or a ref name would be masked for no reason.
 */
function looksOpaque(s: string): boolean {
  if (s.length < 32 || s.length > 4096) return false;
  if (/\s/.test(s)) return false;
  if (!/[0-9]/.test(s) || !/[a-z]/i.test(s)) return false;
  if (/[^A-Za-z0-9+/=_-]/.test(s)) return false;
  const transitions = s.match(/[a-z][A-Z0-9]|[A-Z][a-z0-9]|[0-9][A-Za-z]|[+/=_-]/g);
  return (transitions?.length ?? 0) >= 3;
}

/** Every shape rule that fires on this whole value. */
function matchSecretShapes(value: string): string[] {
  const hits: string[] = [];
  for (const { rule, test } of compiled) {
    if (rule.id === 'base64-blob' && !looksOpaque(value)) continue;
    if (test.test(value)) hits.push(rule.id);
  }
  return hits;
}

/** Rule ids that will be masked for the *next* walk, honouring options. */
function activeShapeIds(options: RedactOptions): ReadonlySet<string> {
  if (options.scanOpaqueBlobs === false) {
    return new Set(compiled.filter((c) => c.rule.id !== 'base64-blob').map((c) => c.rule.id));
  }
  return new Set(compiled.map((c) => c.rule.id));
}

/* ── the walk ───────────────────────────────────────────────────────────── */

interface WalkState {
  readonly opts: Required<
    Pick<RedactOptions, 'placeholder' | 'maxDepth' | 'maxArrayLength' | 'maxStringLength'>
  > &
    RedactOptions;
  readonly extraKeys: ReadonlySet<string>;
  readonly shapes: ReadonlySet<string>;
  readonly redactPii: boolean;
  readonly seen: WeakSet<object>;
  /**
   * Normalised sibling keys of the container currently being walked.
   *
   * Threaded as state rather than a parameter so `walk` stays a flat recursive
   * function; `walkWithSiblings` sets it before descending and restores the
   * previous value on the way out.
   */
  seenKeys: ReadonlySet<string>;
  /**
   * Set while walking the subtree of a sensitive or PII key.
   *
   * Masking the container wholesale would be simpler, but it throws away the
   * structure an operator needs: knowing that `noiseKey.private` is 32 bytes,
   * or that `me` has three fields, is most of the diagnostic value. Inheriting
   * the sensitivity instead keeps the shape and masks every leaf, which is
   * equally safe — there is no leaf under a sensitive key that gets through.
   */
  inherited: 'key' | 'pii' | null;
  findings: RedactionFinding[];
}

const PLACEHOLDER_DEPTH = '[max-depth]';
const PLACEHOLDER_CIRCULAR = '[circular]';

/** Short, stable, non-reversible tag for correlating equal secrets. */
function fingerprint(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 8)}`;
}

function mask(state: WalkState, secret: string): string {
  if (state.opts.fingerprint === true) return fingerprint(secret);
  return state.opts.placeholder;
}

function record(state: WalkState, finding: RedactionFinding): void {
  state.findings.push(finding);
  state.opts.onFinding?.(finding);
}

const join = (path: string, key: string): string => (path ? `${path}.${key}` : key);

/** Is `key` a secret in the context of its container's other keys and its value? */
function keyIsSensitive(
  key: string,
  siblings: ReadonlySet<string>,
  state: WalkState,
  value: unknown,
): boolean {
  const n = normalizeKey(key);
  if (state.extraKeys.has(n)) return true;
  if (isSensitiveKey(key, state.opts)) return true;

  /*
   * `private` only means "the secret half" when it sits next to `public`.
   * Without that check, `{ private: false, public: false }` — a perfectly
   * ordinary visibility flag — gets masked, and a redactor that mangles flags
   * is a redactor people turn off.
   */
  if (CONTEXTUAL_KEYS.has(n) && siblings.has('public')) {
    return typeof value !== 'boolean';
  }
  return false;
}

function isByteArray(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

function walk(
  value: unknown,
  path: string,
  depth: number,
  state: WalkState,
): unknown {
  /* primitives */
  if (value === null || value === undefined) return value;

  const type = typeof value;

  /*
   * Inherited sensitivity covers every primitive, not just strings. A number
   * under `registrationId` or a boolean under `credentials` is still data the
   * caller marked secret, and leaving it intact is the kind of gap that looks
   * fine until someone correlates it across logs.
   */
  if (
    state.inherited !== null &&
    (type === 'string' || type === 'number' || type === 'boolean' || type === 'bigint')
  ) {
    record(state, {
      path,
      rule: `inherited:${state.inherited}`,
      kind: state.inherited === 'pii' ? 'pii' : 'key',
      ...(type === 'string' ? { bytes: (value as string).length } : {}),
    });
    if (state.inherited === 'pii' && state.opts.placeholder === REDACTED) return REDACTED_PII;
    return type === 'string' ? mask(state, value as string) : state.opts.placeholder;
  }

  if (type === 'string') {
    const s = value as string;

    for (const id of matchSecretShapes(s)) {
      if (!state.shapes.has(id)) continue;
      record(state, { path, rule: `shape:${id}`, kind: 'shape', bytes: s.length });
      return mask(state, s);
    }

    if (s.length > state.opts.maxStringLength) {
      record(state, {
        path,
        rule: 'string-truncated',
        kind: 'truncated',
        bytes: s.length,
      });
      return `${s.slice(0, state.opts.maxStringLength)}…[+${s.length - state.opts.maxStringLength} chars]`;
    }

    return s;
  }

  if (type === 'number' || type === 'boolean' || type === 'bigint' || type === 'symbol') {
    return value;
  }

  if (type === 'function') {
    // Not serialisable and not secret. Dropped rather than stringified: a
    // function in a log line is either noise or a stack trace waiting to leak.
    return undefined;
  }

  /* byte containers — never dumped */
  if (value instanceof ArrayBuffer || isByteArray(value)) {
    const bytes = value.byteLength;
    record(state, { path, rule: 'binary', kind: 'buffer', bytes });
    return { __type: 'redacted-buffer', byteLength: bytes } satisfies BufferPlaceholder;
  }

  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) return value;

  if (value instanceof Error) {
    // Errors get flattened rather than stringified: `JSON.stringify(err)` is
    // `{}`, which loses the message that mattered, while `err.stack` may carry
    // paths and arguments that should not leave the process.
    record(state, { path, rule: 'error-flattened', kind: 'value' });
    return { name: value.name, message: redactText(value.message, state.opts) };
  }

  if (value instanceof Map) {
    const out: Array<[unknown, unknown]> = [];
    for (const [k, v] of value) {
      out.push([walk(k, join(path, 'key'), depth + 1, state), walk(v, join(path, 'value'), depth + 1, state)]);
    }
    return { __type: 'redacted-map', entries: out };
  }

  if (value instanceof Set) {
    const out: unknown[] = [];
    let i = 0;
    for (const v of value) {
      if (i++ >= state.opts.maxArrayLength) break;
      out.push(walk(v, join(path, String(i)), depth + 1, state));
    }
    return { __type: 'redacted-set', values: out };
  }

  /* containers */
  if (depth >= state.opts.maxDepth) {
    record(state, { path, rule: 'max-depth', kind: 'truncated' });
    return PLACEHOLDER_DEPTH;
  }

  const obj = value as object;
  if (state.seen.has(obj)) {
    // Also catches the same object referenced twice in a DAG, which keeps a
    // shared `creds` reference from being serialised repeatedly.
    record(state, { path, rule: 'circular', kind: 'truncated' });
    return PLACEHOLDER_CIRCULAR;
  }
  state.seen.add(obj);

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i++) {
      if (i >= state.opts.maxArrayLength) {
        record(state, {
          path,
          rule: 'array-truncated',
          kind: 'truncated',
          bytes: value.length - i,
        });
        out.push(`…[+${value.length - i} items]`);
        break;
      }
      const item = value[i];
      const walked = walk(item, join(path, String(i)), depth + 1, state);
      if (walked !== undefined) out.push(walked);
    }
    return out;
  }

  const record_ = value as Record<string, unknown>;

  const out: Record<string, unknown> = {};
  for (const k of Object.keys(record_)) {
    let raw: unknown;
    try {
      raw = record_[k];
    } catch (err) {
      record(state, { path: join(path, k), rule: 'getter-threw', kind: 'value' });
      raw = `[unreadable: ${err instanceof Error ? err.name : 'unknown'}]`;
    }

    /*
     * Key-driven masking lives here, not in the string branch, because this is
     * where both the key and its sibling keys are known. The decision is
     * inherited by the whole subtree: a key named `me`, `credentials` or
     * `noiseKey` means everything beneath it, and descending into an object
     * because the *leaf* happened to look innocuous is how
     * `{ credentials: { username } }` leaks.
     *
     * Byte arrays are exempt from the subtree walk because the buffer
     * placeholder already carries only a length, and a length is useful
     * diagnostics rather than a leak.
     */
    const n = normalizeKey(k);
    const piiKey = state.redactPii && PII_KEYS.has(n);
    const secretKey = !piiKey && keyIsSensitive(k, state.seenKeys, state, raw);
    const isBytes = raw instanceof ArrayBuffer || isByteArray(raw);

    // Save and restore rather than clearing: a nested sensitive key sets its
    // own marker, and resetting to null instead of to the inherited value would
    // unmask that key's later siblings.
    const previousInherited = state.inherited;
    if ((piiKey || secretKey) && !isBytes) {
      record(state, {
        path: join(path, k),
        rule: `${piiKey ? 'pii' : 'key'}:${n}`,
        kind: piiKey ? 'pii' : 'key',
      });
      state.inherited = piiKey ? 'pii' : 'key';
    }

    try {
      const child = walk(raw, join(path, k), depth + 1, state);
      if (child !== undefined) out[k] = child;
    } finally {
      state.inherited = previousInherited;
    }
  }
  return out;
}

/* ── public API ─────────────────────────────────────────────────────────── */

export interface RedactionResult<T> {
  readonly value: Redacted<T>;
  readonly findings: readonly RedactionFinding[];
}

/**
 * Redact, and report what was masked.
 *
 * The findings list is the auditable half of the operation: it names every
 * masked path and rule while carrying none of the secret, so it is safe to put
 * in an audit record or ship to a SIEM.
 */
export function redactWithFindings<T>(
  value: T,
  options: RedactOptions = {},
): RedactionResult<T> {
  const extraKeys = new Set((options.extraKeys ?? []).map(normalizeKey));
  const state: WalkState = {
    opts: {
      ...options,
      placeholder: options.placeholder ?? REDACTED,
      maxDepth: options.maxDepth ?? 12,
      maxArrayLength: options.maxArrayLength ?? 1000,
      maxStringLength: options.maxStringLength ?? 8192,
    },
    extraKeys,
    shapes: activeShapeIds(options),
    redactPii: options.redactPii ?? true,
    seen: new WeakSet<object>(),
    seenKeys: new Set<string>(),
    inherited: null,
    findings: [],
  };

  const value_ = walkWithSiblings(value, '', 0, state);
  return { value: value_ as Redacted<T>, findings: state.findings };
}

/**
 * `walk`, plus the sibling-key bookkeeping that contextual rules need.
 *
 * Split out so the recursive `walk` body above stays flat: each container sets
 * `seenKeys` before descending and restores it on the way out.
 */
function walkWithSiblings(
  value: unknown,
  path: string,
  depth: number,
  state: WalkState,
): unknown {
  const previous = state.seenKeys;

  if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) && !(value instanceof RegExp) && !(value instanceof Error) && !(value instanceof Map) && !(value instanceof Set)) {
    const keys: string[] = [];
    try {
      for (const k of Object.keys(value as Record<string, unknown>)) keys.push(k);
    } catch {
      /* exotic proxy; fall through with an empty sibling set */
    }
    state.seenKeys = new Set(keys.map(normalizeKey));
  }

  try {
    return walk(value, path, depth, state);
  } finally {
    state.seenKeys = previous;
  }
}

/** Redact a value. See `Redacted<T>` for what the result is allowed to be used for. */
export function redact<T>(value: T, options: RedactOptions = {}): Redacted<T> {
  return redactWithFindings(value, options).value;
}

/**
 * Redact, then stringify. The combination that actually gets logged: string
 * building bypasses every structured-redaction call site if you forget it.
 */
export function redactJson(value: unknown, options: RedactOptions = {}): string {
  const redacted = redact(value, { ...options, maxStringLength: options.maxStringLength ?? 8192 });
  try {
    return JSON.stringify(redacted) ?? 'null';
  } catch (err) {
    // Circular structures are already handled, but a hostile `toJSON` can still
    // throw. A log line that says so beats a log line that kills the process.
    return JSON.stringify({ __type: 'unserializable', error: err instanceof Error ? err.name : 'unknown' });
  }
}

/**
 * Redact a logger `meta` bag. Typed to the `Logger` signature so it can be
 * dropped in without a cast at the call site.
 */
export function redactMeta(
  meta: Record<string, unknown> | undefined,
  options: RedactOptions = {},
): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  return redact(meta, options) as Record<string, unknown>;
}

/**
 * Mask secrets embedded in free text, keeping the prose.
 *
 * For the case where the secret is *inside* a sentence — an error message, an
 * audit reason, a chat body. Distinct from `redact()`, which masks whole
 * values: here the useful part is the text that survives.
 */
export function redactText(text: string, options: RedactOptions = {}): string {
  if (!text) return text;
  const shapes = activeShapeIds(options);
  const placeholder = options.placeholder ?? REDACTED;

  let out = text;
  for (const { rule, global } of compiled) {
    if (!shapes.has(rule.id)) continue;
    if (rule.id === 'base64-blob') continue; // too greedy to apply inside prose
    out = out.replace(global, () => placeholder);
  }
  return out;
}

/** Last `keep` characters, e.g. for operators identifying *which* key leaked. */
export function maskTail(value: string, keep = 4): string {
  if (value.length <= keep) return REDACTED;
  return `${REDACTED}:${value.slice(-keep)}`;
}

/**
 * A `Logger` that redacts every `meta` bag and every message it emits.
 *
 * Prefer this over calling `redact()` at each site: the sites that forget are
 * precisely the ones nobody reviews.
 */
export function redactingLogger(base: Logger, options: RedactOptions = {}): Logger {
  const wrap = (msg: string, meta?: Record<string, unknown>): [string, Record<string, unknown> | undefined] => [
    redactText(msg, options),
    meta ? redactMeta(meta, options) : undefined,
  ];

  return {
    error: (m, x) => {
      const [msg, meta] = wrap(m, x);
      base.error(msg, meta);
    },
    warn: (m, x) => {
      const [msg, meta] = wrap(m, x);
      base.warn(msg, meta);
    },
    info: (m, x) => {
      const [msg, meta] = wrap(m, x);
      base.info(msg, meta);
    },
    debug: (m, x) => {
      const [msg, meta] = wrap(m, x);
      base.debug(msg, meta);
    },
    child: (scope) => redactingLogger(base.child(scope), options),
  };
}

/* ── plugin ──────────────────────────────────────────────────────────────── */

export interface RedactionGuardOptions extends RedactOptions {
  /** Ring-buffer size for collected findings. Default 200. */
  readonly historySize?: number;
}

/**
 * Publishes a redacting logger and a `redact()` helper on the socket.
 *
 * What it cannot do: replace `ctx.log` for the rest of the chain. `PluginContext`
 * declares `log` as readonly, and that is the right call — a plugin silently
 * rewriting the logger of every plugin after it would be a supply-chain
 * problem. So this exposes the redacting logger for callers that have secrets
 * to log, and `audit.ts` redacts by construction at write time.
 */
export function redactionGuard(options: RedactionGuardOptions = {}): Plugin {
  return {
    name: 'redact',
    order: 5,

    apply(ctx) {
      const log = ctx.log.child('redact');
      const historySize = options.historySize ?? 200;
      const history: RedactionFinding[] = [];
      const listeners: Array<(f: RedactionFinding) => void> = [];

      const onFinding = (finding: RedactionFinding): void => {
        history.push(finding);
        while (history.length > historySize) history.shift();
        for (const fn of listeners) {
          try {
            fn(finding);
          } catch {
            /* a broken observer must not break the log line being redacted */
          }
        }
      };

      const redactOptions: RedactOptions = { ...options, onFinding };
      const secureLog = redactingLogger(ctx.log, redactOptions);
      const scrub = (value: unknown): unknown => redact(value, redactOptions);

      Object.defineProperty(ctx.sock, 'redact', {
        value: scrub,
        enumerable: false,
        configurable: true,
      });

      Object.defineProperty(ctx.sock, 'secureLog', {
        value: secureLog,
        enumerable: false,
        configurable: true,
      });

      Object.defineProperty(ctx.sock, 'redactionGuard', {
        value: {
          redact: scrub,
          redactJson: (value: unknown): string => redactJson(value, redactOptions),
          redactText: (text: string): string => redactText(text, redactOptions),
          /** Every mask this process has performed, bounded. */
          findings: (): readonly RedactionFinding[] => history.slice(),
          onRedaction: (fn: (f: RedactionFinding) => void): (() => void) => {
            listeners.push(fn);
            return () => {
              const i = listeners.indexOf(fn);
              if (i >= 0) listeners.splice(i, 1);
            };
          },
        },
        enumerable: false,
        configurable: true,
      });

      log.debug('attached', { pii: options.redactPii !== false, shapes: options.scanOpaqueBlobs !== false });

      ctx.onDispose(() => {
        listeners.length = 0;
        history.length = 0;
      });
    },
  };
}

export default redactionGuard;