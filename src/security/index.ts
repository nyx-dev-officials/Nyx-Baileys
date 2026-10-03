/**
 * Security layer.
 *
 * Seven modules, ordered by what they sit in front of:
 *
 *   permissions.ts     the capability vocabulary every other module agrees on
 *   redact.ts          secrets stop here on their way to a log or a webhook
 *   validate.ts        untrusted input stops here on its way into the process
 *   audit.ts           decisions stop here on their way to evidence
 *   acl.ts             who may do what, with a reason attached to every answer
 *   injection-guard.ts naive prompt-injection grammar in inbound text
 *
 * The plugins are independent and each attaches at its own `order`, so a host
 * takes only the ones it wants. `auditTrail` is order 1 and `redactionGuard`
 * is order 5, which puts the log and the redactor in place before anything
 * that wants to write to them.
 *
 * What this layer is not: a substitute for authorization inside your own tool
 * handlers. `acl.ts` answers "may this jid do X"; it cannot answer "should
 * this specific action be taken right now". See the header of
 * `injection-guard.ts` for the same honesty applied to pattern matching.
 */

/* ── redaction ─────────────────────────────────────────────────────────── */

export {
  REDACTED,
  REDACTED_PII,
  isSensitiveKey,
  maskTail,
  redact,
  redactJson,
  redactMeta,
  redactText,
  redactWithFindings,
  redactionGuard,
} from './redact.js';
export type {
  BufferPlaceholder,
  Redacted,
  RedactOptions,
  RedactionFinding,
  RedactionGuardOptions,
  RedactionPath,
  RedactionResult,
} from './redact.js';

/* ── validation ────────────────────────────────────────────────────────── */

export {
  DEFAULT_MAX_TEXT_LENGTH,
  INVALID,
  JID_SERVERS,
  MAX_JID_LENGTH,
  MAX_MESSAGE_LENGTH,
  VALID,
  all,
  any,
  arrayOf,
  booleanValidator,
  gateInbound,
  integerValidator,
  isGroupJid,
  isValidJid,
  jidUser,
  jidValidator,
  jsonObject,
  normalizeJid,
  oneOf,
  optional,
  parseJid,
  reasonOf,
  record,
  refine,
  sanitizeText,
  stringValidator,
  stripControlChars,
  textValidator,
  validationGate,
} from './validate.js';
export type {
  InboundGateOptions,
  InboundGateResult,
  InboundMessageShape,
  JidOptions,
  JidParts,
  JidServer,
  RecordOptions,
  StripOptions,
  TextOptions,
  Validated,
  ValidationGateOptions,
  ValidationIssue,
  Validator,
} from './validate.js';

/* ── permissions ───────────────────────────────────────────────────────── */

export {
  CAPABILITIES,
  CAPABILITY_LIST,
  DEFAULT_ROLE,
  GRANT_ALL,
  ROLE_NAMES,
  ROLES,
  capabilitiesOf,
  defineRole,
  describeGrant,
  expandGrants,
  getRole,
  grantMatches,
  isCapability,
  matchingDeny,
  matchingGrant,
  roleVerdict,
} from './permissions.js';
export type {
  Capability,
  GrantPattern,
  RoleDefinition,
  RoleName,
  RoleVerdict,
} from './permissions.js';

/* ── acl ───────────────────────────────────────────────────────────────── */

export { GLOBAL_SCOPE, AclDeniedError, AccessControl, accessControl, scopeFor } from './acl.js';
export type {
  AclDecision,
  AclDenial,
  AclOptions,
  AclPluginOptions,
  AclStore,
  HardDeny,
  RoleAssignment,
} from './acl.js';

/* ── audit ─────────────────────────────────────────────────────────────── */

export {
  AuditLog,
  auditSink,
  auditTrail,
  canonicalize,
  hashEntry,
  silentAuditSink,
} from './audit.js';
export type {
  AuditAction,
  AuditEntry,
  AuditEvent,
  AuditLogOptions,
  AuditOutcome,
  AuditPluginOptions,
  AuditSink,
  VerificationReport,
} from './audit.js';

/* ── injection guard ───────────────────────────────────────────────────── */

export { InjectionGuard, Quarantine, injectionGuard } from './injection-guard.js';
export type {
  InjectionAction,
  InjectionCategory,
  InjectionGuardOptions,
  InjectionGuardPluginOptions,
  InjectionMatch,
  InjectionRule,
  InjectionVerdict,
  QuarantinedMessage,
} from './injection-guard.js';

/* ── composition ───────────────────────────────────────────────────────── */

import { accessControl } from './acl.js';
import { auditTrail } from './audit.js';
import { injectionGuard } from './injection-guard.js';
import { redactionGuard } from './redact.js';
import { validationGate } from './validate.js';
import type { Plugin } from '../utils/types.js';
import type { AclPluginOptions } from './acl.js';
import type { AuditPluginOptions } from './audit.js';
import type { InjectionGuardPluginOptions } from './injection-guard.js';
import type { RedactOptions } from './redact.js';
import type { ValidationGateOptions } from './validate.js';

export interface SecurityLayerOptions {
  /** Audit-log settings. */
  readonly audit?: AuditPluginOptions;
  /** Redaction settings, shared by the guard and by audit writes. */
  readonly redact?: RedactOptions;
  readonly acl?: AclPluginOptions;
  readonly validate?: ValidationGateOptions;
  readonly injection?: InjectionGuardPluginOptions;
}

/**
 * The five security plugins, in the order they must be applied.
 *
 * A convenience, not a requirement: each plugin is independent, and a host that
 * only wants the ACL should construct `accessControl()` on its own. The returned
 * order matches the `order` field on each plugin, so passing this array to the
 * chain is equivalent to listing them individually.
 */
export function securityLayer(options: SecurityLayerOptions = {}): Plugin[] {
  return [
    auditTrail(options.audit ?? {}),
    redactionGuard(options.redact ?? {}),
    validationGate(options.validate ?? {}),
    accessControl(options.acl ?? {}),
    injectionGuard(options.injection ?? {}),
  ];
}