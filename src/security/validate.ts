import type { Plugin } from '../utils/types.js';

/**
 * Input validation for untrusted data.
 *
 * Everything that crosses a trust boundary in this framework arrives as an
 * `unknown`: a webhook body, a native-flow `paramsJson` reply typed by the
 * sender, a `messages.upsert` frame from the socket, a jid scraped out of a
 * participant list. None of it has been through TypeScript, and `unknown` is
 * the honest type for all of it.
 *
 * Why not a schema library: the framework has no runtime dependency budget to
 * spend, and the failure mode of a schema lib (throw on the first mismatch,
 * with no reason string) is exactly the failure mode that makes ACL bypasses
 * hard to debug. So this is a small combinator library where **every failure
 * carries a machine-readable `code` and a human-readable `reason`**.
 *
 * The rule everything else follows: **fail closed.** An unparseable jid is not
 * "probably fine", it is a denial with a reason.
 */

export interface ValidationIssue {
  /** Dotted path to the offending value, e.g. `flowResponse.paramsJson`. */
  readonly path: string;
  /** Stable and greppable. Branch on this, not on `reason`. */
  readonly code: string;
  /** Why it failed, in words an operator can act on. */
  readonly reason: string;
}

export type Validated<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

/** A named validator. The name shows up in composed-validator labels. */
export interface Validator<T> {
  readonly name?: string;
  (input: unknown, path?: string): Validated<T>;
}

export const VALID = <T>(value: T): Validated<T> => ({ ok: true, value });

export const INVALID = (
  path: string,
  code: string,
  reason: string,
): { readonly ok: false; readonly issues: readonly ValidationIssue[] } => ({
  ok: false,
  issues: [{ path, code, reason }],
});

/** Attach a label to a validator so composed names stay readable. */
function withName<T>(name: string, fn: Validator<T>): Validator<T> {
  Object.defineProperty(fn, 'name', { value: name, configurable: true });
  return fn;
}

/** Issues as one readable line. Never silent, including on success. */
export function reasonOf(result: Validated<unknown>): string {
  if (result.ok) return 'valid';
  return result.issues.map((i) => `${i.path || '<root>'}: ${i.reason}`).join('; ');
}

const describeType = (v: unknown): string => {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return 'array';
  return typeof v;
};

/* ── jids ─────────────────────────────────────────────────────────────────
 *
 * A jid is not a string, it is a small structured address, and treating it as
 * a string is how `remoteJid` ends up as the literal `"undefined"` inside a
 * `sendMessage` three layers deep. The server allow-list is closed because the
 * set of real servers is closed: anything outside it is either malformed or an
 * attempt to steer a lookup at a server that does not exist.
 */

export const JID_SERVERS = [
  's.whatsapp.net', // individual user; device suffixed as `1234:12@s.whatsapp.net`
  'lid', // linked identity — rc14's replacement for phone-derived addressing
  'g.us', // group
  'broadcast', // status broadcast, i.e. `status@broadcast`
  'newsletter', // channel / newsletter
] as const;

export type JidServer = (typeof JID_SERVERS)[number];

/** WhatsApp's own wire limit. Anything longer is not a jid. */
export const MAX_JID_LENGTH = 128;
const MAX_USER_LENGTH = 64;

/** Pre-2021 servers. Rejected unless the caller opts in — see `JidOptions`. */
const LEGACY_SERVERS: ReadonlySet<string> = new Set([
  'c.us',
  's.whatsapp.co.uk',
  's.whatsapp.co.in',
  's.whatsapp.co.id',
]);

export interface JidOptions {
  /**
   * Also accept the pre-2021 servers (`c.us`, `s.whatsapp.co.uk`, …).
   *
   * Off by default. A `@c.us` still sitting in stored state is nearly always an
   * unnormalised bug, and silently accepting it defers the failure to a send
   * that fails somewhere with no jid in the error message.
   */
  readonly allowLegacyServers?: boolean;
  /** Accept a `:device` suffix. Only meaningful for user and lid jids. Default true. */
  readonly allowDeviceSuffix?: boolean;
  /** Require a device suffix. Default false. */
  readonly requireDeviceSuffix?: boolean;
}

export interface JidParts {
  readonly user: string;
  readonly server: JidServer;
  readonly device: number | null;
  /** Normalised form, device suffix retained. */
  readonly raw: string;
}

const isDigits = (s: string): boolean => /^[0-9]+$/.test(s);

/**
 * Parse and validate a jid.
 *
 * This proves the string *could* be a jid — structure, not existence. Proving
 * the account is real costs a network round-trip, and is the transport's job,
 * not the validator's.
 */
export function parseJid(input: unknown, options: JidOptions = {}): Validated<JidParts> {
  const fail = (code: string, reason: string): { readonly ok: false; readonly issues: readonly ValidationIssue[] } =>
    INVALID('jid', code, reason);

  if (typeof input !== 'string') {
    return fail('not_a_string', `expected a jid string, received ${describeType(input)}`);
  }
  if (input.length === 0) return fail('empty', 'jid is empty');
  if (input.length > MAX_JID_LENGTH) {
    return fail('too_long', `jid is ${input.length} chars, max is ${MAX_JID_LENGTH}`);
  }
  // Whitespace and C0/C1 controls. Note this runs before any trimming: a jid
  // that merely looks trimmed is a jid somebody built by string concatenation.
  if (/[\s\u0000-\u001F\u007F-\u009F]/.test(input)) {
    return fail('control_or_space', 'jid contains whitespace or a control character');
  }

  const at = input.indexOf('@');
  if (at < 0) return fail('no_server', `jid is missing the "@server" suffix`);
  if (at !== input.lastIndexOf('@')) return fail('multiple_at', 'jid contains more than one "@"');
  if (at === 0) return fail('no_user', 'jid has an empty user part');

  const user = input.slice(0, at);
  const server = input.slice(at + 1).toLowerCase();
  const legacy = LEGACY_SERVERS.has(server);

  if (user.length > MAX_USER_LENGTH) {
    return fail('user_too_long', `jid user part is ${user.length} chars, max is ${MAX_USER_LENGTH}`);
  }

  if (legacy && options.allowLegacyServers !== true) {
    return fail(
      'legacy_server',
      `jid server "@${server}" is legacy; normalise to @s.whatsapp.net first, or pass allowLegacyServers`,
    );
  }
  if (!legacy && !(JID_SERVERS as readonly string[]).includes(server)) {
    return fail('unknown_server', `jid server "@${server}" is not one of ${JID_SERVERS.join(', ')}`);
  }

  /* device suffix */
  let bare = user;
  let device: number | null = null;

  const colon = user.indexOf(':');
  if (colon >= 0) {
    bare = user.slice(0, colon);
    const deviceStr = user.slice(colon + 1);
    const deviceable = server === 's.whatsapp.net' || server === 'lid';

    if (options.allowDeviceSuffix === false || !deviceable) {
      return fail('device_not_allowed', `jid server "@${server}" must not carry a ":device" suffix`);
    }
    if (!isDigits(deviceStr)) {
      return fail('bad_device', `jid device part "${deviceStr}" is not numeric`);
    }
    const parsed = Number(deviceStr);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 255) {
      return fail('device_range', `jid device part ${parsed} is outside 0-255`);
    }
    device = parsed;
  } else if (options.requireDeviceSuffix === true) {
    return fail('device_required', 'jid must carry a ":device" suffix');
  }

  /*
   * Legacy servers are validated with the user grammar but normalised to
   * `@s.whatsapp.net` in the output. Callers get a jid Baileys will actually
   * accept, rather than one that only passed validation.
   */
  if (legacy) {
    if (!isDigits(bare)) {
      return fail('bad_user', `jid user "${bare}" must be digits for legacy server @${server}`);
    }
    return VALID({
      user: bare,
      server: 's.whatsapp.net' as JidServer,
      device,
      raw: device === null ? `${bare}@s.whatsapp.net` : `${bare}:${device}@s.whatsapp.net`,
    });
  }

  /* per-server user grammar */
  switch (server as JidServer) {
    case 's.whatsapp.net':
    case 'lid':
    case 'newsletter':
      if (!isDigits(bare)) {
        return fail('bad_user', `jid user "${bare}" must be digits for server @${server}`);
      }
      break;
    case 'g.us':
      // Group ids are long digit runs. The hyphen form shows up in some
      // community ids and is accepted for interoperability.
      if (!/^[0-9]+(-[0-9]+)?$/.test(bare)) {
        return fail('bad_user', `jid user "${bare}" must be digits for a @g.us group`);
      }
      break;
    case 'broadcast':
      // `status@broadcast` is the real address; any short alphabetic handle is
      // structurally accepted so a future variant does not hard-fail here.
      if (!/^[a-z]{1,16}$/i.test(bare)) {
        return fail(
          'bad_user',
          `jid user "${bare}" must be alphabetic for @broadcast, as in "status"`,
        );
      }
      break;
    default:
      return fail('unknown_server', `jid server "@${server}" is not supported`);
  }

  return VALID({
    user: bare,
    server: server as JidServer,
    device,
    raw: device === null ? `${bare}@${server}` : `${bare}:${device}@${server}`,
  });
}

/** Boolean form of `parseJid`, for the many places that only need a yes/no. */
export function isValidJid(input: unknown, options: JidOptions = {}): boolean {
  return parseJid(input, options).ok;
}

/** Validated jid as a string, or `null`. Never throws. */
export function normalizeJid(input: unknown, options: JidOptions = {}): string | null {
  const result = parseJid(input, options);
  return result.ok ? result.value.raw : null;
}

/** The user half of a jid, or `null`. Convenient for grouping and keying. */
export function jidUser(input: unknown, options: JidOptions = {}): string | null {
  const result = parseJid(input, options);
  return result.ok ? result.value.user : null;
}

/** Is this jid a group? */
export function isGroupJid(input: unknown): boolean {
  const result = parseJid(input);
  return result.ok && result.value.server === 'g.us';
}

/* ── text ────────────────────────────────────────────────────────────────
 *
 * Invisible characters are stripped rather than rejected because a stray
 * U+200B in a real message is overwhelmingly a paste artefact, and rejecting it
 * breaks real conversations. Length limits are hard rejections, because
 * unbounded text is the one input that reliably takes the process down.
 */

/** C0 controls, DEL, C1 controls, and the Unicode line/paragraph separators. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;

/**
 * Characters that render as nothing but change what a reader — human or model —
 * resolves. This is the reason stripping is not just `[[:cntrl:]]`: text can be
 * hidden inside a message that looks ordinary, which is the cheapest injection
 * bypass there is and the reason `injection-guard.ts` normalises before matching.
 */
const INVISIBLE_CHARS =
  /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u206A-\u206F\uFEFF]/g;

export interface StripOptions {
  /** Keep newlines. Default true. */
  readonly allowNewlines?: boolean;
  /** Keep tabs. Default true. */
  readonly allowTabs?: boolean;
  /** Also drop zero-width and bidi-control characters. Default true. */
  readonly stripInvisible?: boolean;
}

/** Remove control and invisible characters. */
export function stripControlChars(text: string, options: StripOptions = {}): string {
  const allowNewlines = options.allowNewlines ?? true;
  const allowTabs = options.allowTabs ?? true;

  let out = text.replace(CONTROL_CHARS, (ch) => {
    if (allowNewlines && (ch === '\n' || ch === '\r')) return ch;
    if (allowTabs && ch === '\t') return ch;
    return '';
  });

  if (options.stripInvisible !== false) {
    out = out.replace(INVISIBLE_CHARS, '');
  }
  return out;
}

export interface TextOptions extends StripOptions {
  readonly maxLength?: number;
  readonly minLength?: number;
  /** Reject an all-whitespace result. Default true. */
  readonly requireNonEmpty?: boolean;
  /** Trim surrounding whitespace. Default true. */
  readonly trim?: boolean;
  /** Collapse runs of spaces/tabs to one. Default false. */
  readonly collapseWhitespace?: boolean;
  /** Reject, instead of stripping, when control characters are present. Default false. */
  readonly rejectControlChars?: boolean;
}

/** WhatsApp's own text ceiling; a longer send fails server-side anyway. */
export const MAX_MESSAGE_LENGTH = 65_536;

/** Flow inputs become prompts or commands, so they have no business being huge. */
export const DEFAULT_MAX_TEXT_LENGTH = 4_096;

/** Sanitize text, reporting how much was stripped. */
export function sanitizeText(input: unknown, options: TextOptions = {}): Validated<{
  text: string;
  stripped: number;
}> {
  const limit = options.maxLength ?? DEFAULT_MAX_TEXT_LENGTH;

  if (typeof input !== 'string') {
    return INVALID('text', 'not_a_string', `expected text, received ${describeType(input)}`);
  }
  if (input.length > limit * 4) {
    // Cheap pre-check. Regex-replacing a 300 KB string in order to produce a
    // rejection message is waste, and the verdict is already determined.
    return INVALID('text', 'too_long', `text is ${input.length} chars, over the ${limit} char limit`);
  }

  const before = input;
  let out = stripControlChars(input, options);

  if (options.rejectControlChars === true && out !== before) {
    return INVALID('text', 'control_chars', 'text contains control or invisible characters');
  }

  if (options.collapseWhitespace === true) out = out.replace(/[ \t]{2,}/g, ' ');
  if (options.trim !== false) out = out.trim();

  const min = options.minLength ?? 0;
  if (out.length < min) {
    return INVALID('text', 'too_short', `text is ${out.length} chars, minimum is ${min}`);
  }
  if (out.length === 0 && (options.requireNonEmpty ?? true)) {
    return INVALID('text', 'empty', 'text is empty after sanitization');
  }

  return VALID({ text: out, stripped: before.length - out.length });
}

/* ── combinators ─────────────────────────────────────────────────────────
 *
 * `all` accumulates every issue instead of failing fast. That costs a little
 * on the happy path and buys a lot on a rejection: the caller gets everything
 * that is wrong with the payload, not just the first thing.
 */

/** AND. Every validator must pass; issues from all failures are returned. */
export function all<T>(...validators: readonly Validator<unknown>[]): Validator<T> {
  return withName(`all(${validators.map((v) => v.name ?? '?').join(', ')})`, (input, path = '') => {
    const issues: ValidationIssue[] = [];
    let last: unknown = input;

    for (const v of validators) {
      const result = v(last, path);
      if (!result.ok) {
        issues.push(...result.issues);
        continue;
      }
      last = result.value;
    }

    if (issues.length > 0) return { ok: false, issues };
    return VALID(last as T);
  });
}

/** OR. First success wins; every failure is reported if none succeed. */
export function any<T>(...validators: readonly Validator<unknown>[]): Validator<T> {
  return withName(`any(${validators.map((v) => v.name ?? '?').join(', ')})`, (input, path = '') => {
    const issues: ValidationIssue[] = [];
    for (const v of validators) {
      const result = v(input, path);
      if (result.ok) return VALID(result.value as T);
      issues.push(...result.issues);
    }
    return { ok: false, issues };
  });
}

/** Refine an already-valid value. Return an issue to reject it. */
export function refine<T>(
  base: Validator<T>,
  check: (value: T) => ValidationIssue | null,
  label: string,
): Validator<T> {
  return withName(`${base.name ?? label}>${label}`, (input, path = '') => {
    const result = base(input, path);
    if (!result.ok) return result;
    const issue = check(result.value);
    if (issue) return INVALID(path || label, issue.code, issue.reason);
    return result;
  });
}

/** Wrap a validator so `undefined` and `null` pass through as `undefined`. */
export function optional<T>(base: Validator<T>): Validator<T | undefined> {
  return withName(`optional(${base.name ?? '?'})`, (input, path = '') => {
    if (input === undefined || input === null) return VALID(undefined);
    return base(input, path);
  });
}

/** One of a closed set of literal values. */
export function oneOf<const T extends readonly string[]>(
  values: T,
  label = 'value',
): Validator<T[number]> {
  return withName(`oneOf(${label})`, (input, path = '') => {
    if (typeof input === 'string' && (values as readonly string[]).includes(input)) {
      return VALID(input as T[number]);
    }
    return INVALID(
      path,
      'not_in_set',
      `${label} must be one of ${values.join(', ')}; received ${JSON.stringify(input) ?? describeType(input)}`,
    );
  });
}

export interface RecordOptions {
  readonly maxKeys?: number;
  /** Reject arrays as well as non-objects. Default true. */
  readonly rejectArrays?: boolean;
}

/**
 * A plain object, with a key cap and a copy-into-plain-object step.
 *
 * The copy matters: a value arriving from a deserialiser can be a class
 * instance or a null-prototype object carrying getters. Copying own enumerable
 * keys behind a try/catch means downstream code only ever touches plain data.
 */
export function record(options: RecordOptions = {}): Validator<Record<string, unknown>> {
  const maxKeys = options.maxKeys ?? 256;
  return withName('record', (input, path = '') => {
    if (typeof input !== 'object' || input === null) {
      return INVALID(path, 'not_an_object', `expected an object, received ${describeType(input)}`);
    }
    if ((options.rejectArrays ?? true) && Array.isArray(input)) {
      return INVALID(path, 'is_array', 'expected an object, received an array');
    }

    const keys = Object.keys(input as Record<string, unknown>);
    if (keys.length > maxKeys) {
      return INVALID(path, 'too_many_keys', `object has ${keys.length} keys, max is ${maxKeys}`);
    }

    const out: Record<string, unknown> = {};
    for (const k of keys) {
      try {
        out[k] = (input as Record<string, unknown>)[k];
      } catch {
        out[k] = '[unreadable]';
      }
    }
    return VALID(out);
  });
}

/** A bounded array whose every element passes `item`. */
export function arrayOf<T>(
  item: Validator<T>,
  options: { readonly maxLength?: number } = {},
): Validator<T[]> {
  const maxLength = options.maxLength ?? 1_000;
  return withName(`arrayOf(${item.name ?? '?'})`, (input, path = '') => {
    if (!Array.isArray(input)) {
      return INVALID(path, 'not_an_array', `expected an array, received ${describeType(input)}`);
    }
    if (input.length > maxLength) {
      return INVALID(path, 'too_many_items', `array has ${input.length} items, max is ${maxLength}`);
    }

    const issues: ValidationIssue[] = [];
    const out: T[] = [];
    input.forEach((element, i) => {
      const result = item(element, `${path}[${i}]`);
      if (result.ok) out.push(result.value);
      else issues.push(...result.issues);
    });

    if (issues.length > 0) return { ok: false, issues };
    return VALID(out);
  });
}

/**
 * Parse JSON from untrusted text under a size and a depth budget.
 *
 * `paramsJson` on a native-flow reply is sender-supplied and goes straight to
 * `JSON.parse` in `flow.ts`. The depth budget is the point: `JSON.parse` has no
 * recursion limit of its own, and a deeply nested payload is cheap to send and
 * expensive to walk.
 */
export function jsonObject(
  options: { readonly maxBytes?: number; readonly maxDepth?: number } = {},
): Validator<Record<string, unknown>> {
  const maxBytes = options.maxBytes ?? 64 * 1024;
  const maxDepth = options.maxDepth ?? 12;

  return withName('jsonObject', (input, path = '') => {
    if (typeof input !== 'string') {
      return INVALID(path, 'not_a_string', `expected a JSON string, received ${describeType(input)}`);
    }
    if (Buffer.byteLength(input, 'utf8') > maxBytes) {
      return INVALID(path, 'too_large', `JSON payload exceeds ${maxBytes} bytes`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(input) as unknown;
    } catch (err) {
      return INVALID(
        path,
        'invalid_json',
        `payload is not valid JSON: ${err instanceof Error ? err.message : 'unknown parse error'}`,
      );
    }

    const shape = record({ maxKeys: 512 })(parsed, path);
    if (!shape.ok) return shape;

    let depth = 0;
    const tooDeep = (node: unknown): boolean => {
      if (node === null || typeof node !== 'object') return false;
      depth += 1;
      if (depth > maxDepth) return true;
      const children = Array.isArray(node) ? node : Object.values(node as Record<string, unknown>);
      for (const child of children) {
        if (tooDeep(child)) return true;
      }
      return false;
    };

    if (tooDeep(parsed)) {
      return INVALID(path, 'too_deep', `JSON nesting exceeds depth ${maxDepth}`);
    }
    return VALID(shape.value);
  });
}

/* ── ready-made validators ─────────────────────────────────────────────── */

/** Sanitized text. The default validator for anything a human can send. */
export function textValidator(options: TextOptions = {}): Validator<string> {
  return withName('text', (input, path = '') => {
    const result = sanitizeText(input, options);
    if (!result.ok) {
      return {
        ok: false,
        issues: result.issues.map((i) => ({
          ...i,
          path: i.path || path,
          reason: `[text] ${i.reason}`,
        })),
      };
    }
    return VALID(result.value.text);
  });
}

/** Alias for `textValidator` with an explicit length, for readability at call sites. */
export const stringValidator = (maxLength = DEFAULT_MAX_TEXT_LENGTH): Validator<string> =>
  textValidator({ maxLength });

/** A jid, as a validator. */
export function jidValidator(options: JidOptions = {}): Validator<JidParts> {
  return withName('jid', (input, path = '') => {
    const result = parseJid(input, options);
    if (result.ok) return result;

    // Re-root the issue under the caller's path, so a failure nested at
    // `body.remoteJid` reports where it actually is rather than a bare "jid".
    if (path === '') return { ok: false, issues: result.issues };
    return {
      ok: false,
      issues: result.issues.map((i) => ({
        ...i,
        path: i.path === 'jid' ? path : `${path}.${i.path}`,
      })),
    };
  });
}

/** A bounded integer. */
export function integerValidator(
  options: { readonly min?: number; readonly max?: number } = {},
): Validator<number> {
  const min = options.min ?? Number.NEGATIVE_INFINITY;
  const max = options.max ?? Number.POSITIVE_INFINITY;
  return withName('integer', (input, path = '') => {
    if (typeof input !== 'number' || !Number.isFinite(input)) {
      return INVALID(path, 'not_a_number', `expected a finite number, received ${describeType(input)}`);
    }
    if (!Number.isInteger(input)) {
      return INVALID(path, 'not_an_integer', `expected an integer, received ${input}`);
    }
    if (input < min || input > max) {
      return INVALID(path, 'out_of_range', `value ${input} is outside ${min}..${max}`);
    }
    return VALID(input);
  });
}

/** A boolean, without the `Boolean("false") === true` trap. */
export const booleanValidator: Validator<boolean> = withName('boolean', (input, path = '') => {
  if (typeof input === 'boolean') return VALID(input);
  if (input === 'true') return VALID(true);
  if (input === 'false') return VALID(false);
  return INVALID(path, 'not_a_boolean', `expected a boolean, received ${describeType(input)}`);
});

/* ── the inbound gate ──────────────────────────────────────────────────── */

/** What `messages.upsert` hands us, narrowed to the parts worth validating. */
export interface InboundMessageShape {
  readonly remoteJid?: unknown;
  readonly participant?: unknown;
  readonly fromMe?: unknown;
  readonly text?: unknown;
}

export interface InboundGateResult {
  readonly jid: string;
  readonly participant: string | null;
  readonly text: string;
  readonly issues: readonly ValidationIssue[];
  readonly ok: boolean;
  readonly reason: string;
}

export interface InboundGateOptions {
  readonly maxTextLength?: number;
  readonly allowLegacyServers?: boolean;
}

/**
 * First gate for anything inbound.
 *
 * Returns `ok: false` with a `reason` rather than throwing: the caller is a
 * socket listener, and an unhandled rejection there is a denial of service
 * anyone on WhatsApp can trigger with one malformed message.
 */
export function gateInbound(
  message: InboundMessageShape,
  options: InboundGateOptions = {},
): InboundGateResult {
  const issues: ValidationIssue[] = [];
  const jidOptions: JidOptions = {
    allowLegacyServers: options.allowLegacyServers ?? true,
  };

  const jidResult = parseJid(message.remoteJid, jidOptions);
  if (!jidResult.ok) {
    issues.push(...jidResult.issues);
    return {
      jid: '',
      participant: null,
      text: '',
      ok: false,
      reason: `inbound message dropped: ${reasonOf(jidResult)}`,
      issues,
    };
  }

  let participant: string | null = null;
  if (message.participant !== undefined && message.participant !== null) {
    const p = parseJid(message.participant, jidOptions);
    if (p.ok) participant = p.value.raw;
    else issues.push(...p.issues);
  }

  const textResult = sanitizeText(message.text ?? '', {
    maxLength: options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH,
    requireNonEmpty: false,
  });
  if (!textResult.ok) {
    issues.push(...textResult.issues);
    return {
      jid: jidResult.value.raw,
      participant,
      text: '',
      ok: false,
      reason: `inbound text rejected: ${reasonOf(textResult)}`,
      issues,
    };
  }

  return {
    jid: jidResult.value.raw,
    participant,
    text: textResult.value.text,
    ok: issues.length === 0,
    reason: issues.length === 0 ? 'accepted' : reasonOf({ ok: false, issues }),
    issues,
  };
}

/* ── plugin ──────────────────────────────────────────────────────────────── */

export interface ValidationGateOptions {
  /** Max inbound text length before rejection. Default 4096. */
  readonly maxTextLength?: number;
  /** Emit `super.invalidInput` for rejected messages. Default true. */
  readonly emitRejections?: boolean;
  /** Called for every rejected message, after the event. */
  readonly onReject?: (result: InboundGateResult) => void;
}

/**
 * Observes inbound traffic and reports what is malformed.
 *
 * Being honest about the limit: Baileys' `ev` emitter has no cancellation, so
 * a `messages.upsert` listener cannot stop other listeners from also receiving
 * the message. A plugin that genuinely needs to drop a message has to
 * subscribe to `super.invalidInput` and act itself. So this is an *observer, a
 * source of validated data, and an audit signal* — not an interception point.
 * Better to say that than to imply a chokepoint that does not exist.
 *
 * Concretely it: validates every inbound frame against the jid and text gates
 * above, publishes `sock.validate` so callers reuse the same gate instead of
 * re-deriving it, and emits one `super.invalidInput` per rejection with the
 * reason attached.
 */
export function validationGate(options: ValidationGateOptions = {}): Plugin {
  return {
    name: 'validate',
    order: 8,

    apply(ctx) {
      const log = ctx.log.child('validate');
      const emitRejections = options.emitRejections ?? true;
      const maxTextLength = options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
      let rejected = 0;
      let accepted = 0;

      const handle = (event: { messages?: unknown[] }): void => {
        for (const raw of event.messages ?? []) {
          const frame = raw as { key?: { remoteJid?: unknown; participant?: unknown }; message?: Record<string, unknown> };
          const key = frame?.key ?? {};

          const result = gateInbound(
            {
              remoteJid: key.remoteJid,
              participant: key.participant,
              text: extractText(frame.message),
            },
            { maxTextLength },
          );

          if (result.ok) {
            accepted += 1;
            continue;
          }

          rejected += 1;
          log.debug('inbound rejected', { reason: result.reason });

          if (emitRejections) {
            ctx.sock.ev.emit('super.invalidInput' as never, result as never);
          }
          options.onReject?.(result);
        }
      };

      ctx.sock.ev.on('messages.upsert', handle as never);

      ctx.onDispose(() => {
        try {
          ctx.sock.ev.off('messages.upsert', handle as never);
        } catch {
          /* emitter already torn down */
        }
      });

      Object.defineProperty(ctx.sock, 'validate', {
        value: {
          jid: jidValidator({ allowLegacyServers: true }),
          text: textValidator({ maxLength: maxTextLength }),
          /** The same gate this listener uses. */
          inbound: gateInbound,
          parseJid,
          isValidJid,
          normalizeJid,
          sanitizeText,
          stripControlChars,
          jsonObject: jsonObject(),
          reasonOf,
          stats: () => ({ accepted, rejected }),
        },
        enumerable: false,
        configurable: true,
      });

      log.debug('attached', { maxTextLength });
    },
  };
}

/**
 * Pull displayable text out of a Baileys message body.
 *
 * Deliberately a subset of the exhaustive extraction in `flow.ts`: this is a
 * validation gate, and a gate that must understand every message type in the
 * protocol is a gate that will quietly skip the one type someone needed. Finding
 * nothing is a valid outcome here, not a rejection.
 */
function extractText(message: Record<string, unknown> | undefined): string {
  if (!message) return '';

  const conversation = message.conversation;
  if (typeof conversation === 'string') return conversation;

  const extended = message.extendedTextMessage as { text?: unknown } | undefined;
  if (typeof extended?.text === 'string') return extended.text;

  for (const wrapper of ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2'] as const) {
    const inner = message[wrapper] as { message?: Record<string, unknown> } | undefined;
    if (inner?.message) {
      const nested = extractText(inner.message);
      if (nested) return nested;
    }
  }

  for (const kind of ['documentMessage', 'imageMessage', 'videoMessage'] as const) {
    const caption = (message[kind] as { caption?: unknown } | undefined)?.caption;
    if (typeof caption === 'string') return caption;
  }

  return '';
}

export default validationGate;