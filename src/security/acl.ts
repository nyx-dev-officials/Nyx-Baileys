import { patch } from '../core/intercept.js';
import { silentAuditSink } from './audit.js';
import type { AuditSink } from './audit.js';
import { CAPABILITIES, DEFAULT_ROLE, ROLES, grantMatches, isCapability } from './permissions.js';
import type { Capability, GrantPattern, RoleDefinition } from './permissions.js';
import { isGroupJid, isValidJid, normalizeJid } from './validate.js';
import type { Plugin } from '../utils/types.js';

/**
 * Capability access control.
 *
 * Design commitments, in order of importance:
 *
 *   1. **Every decision carries a reason.** `can()` returns an `AclDecision`
 *      with `reason` set on *both* outcomes. Silent ACLs are the mechanism
 *      behind most bypasses: a check that returns a bare `false` gets
 *      inverted by some caller that cannot tell "denied" apart from "feature
 *      not wired up", and that inversion ships.
 *   2. **Deny overrides allow.** Every deny is gathered before any verdict, so
 *      one `banned` assignment outranks twenty `owner` assignments. Resolution
 *      is never by role rank — a rank tiebreak is exactly how a high-rank role
 *      quietly defeats a deny.
 *   3. **Fail closed on bad input.** An unparseable subject or an unknown
 *      capability is a denial, not a bypass.
 *   4. **Scope resolution is explicit.** Global assignments apply everywhere;
 *      a group assignment applies only in that group. Silently widening a group
 *      grant to the whole bot is how a group moderator becomes a bot-wide one.
 *
 * Scope convention: `'*'` is global, anything else is a group jid.
 */

export const GLOBAL_SCOPE = '*';

export interface AclDecision {
  readonly allowed: boolean;
  readonly capability: Capability | string;
  readonly subject: string;
  readonly scope: string;
  /** Always present. On a denial this is the answer to "why". */
  readonly reason: string;
  readonly roles: readonly string[];
  /** The grant that allowed it, when one did. */
  readonly matchedGrant: GrantPattern | null;
  /** The deny that overrode an allow, when one did. */
  readonly matchedDeny: GrantPattern | null;
}

export interface AclDenial extends AclDecision {
  readonly id: number;
  readonly at: number;
}

export interface RoleAssignment {
  readonly id: string;
  /** A jid, or a subject pattern when patterns are enabled. */
  readonly subject: string;
  readonly role: string;
  readonly scope: string;
  readonly grantedBy: string;
  readonly grantedAt: number;
  /** Unix ms. `null` means permanent. */
  readonly expiresAt: number | null;
}

/** An explicit block. Always outranks every role grant. */
export interface HardDeny {
  readonly id: string;
  readonly subject: string;
  /** Capability, prefix wildcard, or `*`. */
  readonly grant: GrantPattern;
  readonly scope: string;
  readonly reason: string;
  readonly deniedBy: string;
  readonly deniedAt: number;
  readonly expiresAt: number | null;
}

export interface AclStore {
  load(): Promise<{ assignments?: RoleAssignment[]; denies?: HardDeny[] } | undefined>;
  save(state: { assignments: RoleAssignment[]; denies: HardDeny[] }): Promise<void>;
}

export interface AclOptions {
  /** Extra roles, merged over the built-in ladder. */
  readonly roles?: Readonly<Record<string, RoleDefinition>>;
  /** Role for a subject with no assignment. Default `guest`. */
  readonly defaultRole?: string;
  /** Jids that bypass the role ladder entirely. */
  readonly ownerJids?: readonly string[];
  /**
   * Allow a `*` in the user portion of an assignment subject, e.g. `*@g.us`.
   *
   * Off by default. A wildcard assignment is a real privilege-escalation vector
   * — one call granting a capability to everyone in a group that later admits a
   * stranger — so it has to be a deliberate choice, not a default.
   */
  readonly allowSubjectPatterns?: boolean;
  /** Ring-buffer size for the in-memory denial trail. Default 500. */
  readonly maxDenials?: number;
  /** Where denials are recorded. Defaults to dropping them. */
  readonly audit?: AuditSink;
  /** Called on every denial, after the audit sink. */
  readonly onDeny?: (denial: AclDenial) => void;
  /** Injectable clock, for tests. */
  readonly now?: () => number;
  /** Persistence. Defaults to none; the plugin supplies one over `ctx.state`. */
  readonly store?: AclStore;
}

let counter = 0;
const nextId = (prefix: string): string => {
  counter += 1;
  return `${prefix}-${counter.toString(36)}`;
};

/** Thrown by `assert()`. Carries the decision so callers can log the reason. */
export class AclDeniedError extends Error {
  readonly decision: AclDecision;

  constructor(decision: AclDecision) {
    super(
      `acl: ${decision.subject} is not permitted ${decision.capability} in ${decision.scope} — ${decision.reason}`,
    );
    this.name = 'AclDeniedError';
    this.decision = decision;
  }
}

/**
 * A subject pattern, compiled once.
 *
 * The grammar is deliberately tiny and anchored: `<user-pattern>@<server>`,
 * where the user pattern is a literal, a single `*`, a `prefix*`, or a
 * `*suffix`. Nothing else — no regex, no alternation, no anchoring tricks. This
 * string reaches an ACL from an operator (or an admin command), and a pattern
 * language in the subject position is a footgun with a security consequence:
 * `.*` or `(?s).*` would be a trivially bypassable "grant everyone" button.
 */
interface CompiledSubject {
  readonly source: string;
  /** Named `pattern`, not `test`: a field called `test` would shadow the method. */
  readonly pattern: RegExp;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Compile a subject pattern, or explain why it is not one.
 *
 * The server half must be a real server. That is the property that stops
 * `*@evil.example` from becoming a pattern that silently matches nothing (or,
 * worse, everything, if the matcher were ever loosened).
 */
function compileSubject(input: string): { ok: true; value: CompiledSubject } | { ok: false; reason: string } {
  if (input === '*') {
    return { ok: true, value: { source: '*', pattern: /^.*$/ } };
  }

  const at = input.lastIndexOf('@');
  if (at <= 0) {
    return { ok: false, reason: `subject pattern "${input}" must be of the form <user-pattern>@<server>` };
  }
  if (at !== input.indexOf('@')) {
    return { ok: false, reason: `subject pattern "${input}" must contain exactly one "@"` };
  }

  const userPattern = input.slice(0, at);
  const server = input.slice(at + 1).toLowerCase();

  // Reuse the jid validator rather than duplicating the server allow-list here;
  // two copies of that list is two lists that drift.
  if (!isValidJid(`1@${server}`, { allowLegacyServers: true })) {
    return {
      ok: false,
      reason: `subject pattern server "@${server}" is not a known jid server`,
    };
  }

  const stars = userPattern.split('*').length - 1;
  if (stars > 1) {
    return { ok: false, reason: `subject pattern "${input}" may contain at most one "*"` };
  }
  if (!/^[0-9a-zA-Z*_-]+$/.test(userPattern)) {
    return {
      ok: false,
      reason: `subject pattern user "${userPattern}" may only contain digits, letters, "-", "_" and one "*"`,
    };
  }

  const source = `${userPattern}@${server}`;
  // `*` becomes a user-part wildcard. Anchored on both ends, so the server can
  // never be widened by the wildcard.
  const body = escapeRe(userPattern).replace(/\\\*/g, '[0-9a-zA-Z_-]*');
  return { ok: true, value: { source, pattern: new RegExp(`^${body}@${escapeRe(server)}$`, 'i') } };
}

/**
 * Exact jid match, or a compiled pattern when patterns are enabled.
 *
 * Pattern compilation is cached on the instance: `can()` runs per capability per
 * message, and recompiling a regex on that path is waste.
 */
function subjectMatches(pattern: string, subject: string, allowPatterns: boolean): boolean {
  if (pattern === subject) return true;
  if (!allowPatterns || !pattern.includes('*')) return false;
  const compiled = compileSubject(pattern);
  return compiled.ok ? compiled.value.pattern.test(subject) : false;
}

/** Scope for a destination: a group is its own scope, everything else global. */
export function scopeFor(target: unknown): string {
  return isGroupJid(target) ? (normalizeJid(target, { allowLegacyServers: true }) ?? GLOBAL_SCOPE) : GLOBAL_SCOPE;
}

export class AccessControl {
  readonly #roles: ReadonlyMap<string, RoleDefinition>;
  readonly #defaultRole: string;
  readonly #owners: ReadonlySet<string>;
  readonly #allowSubjectPatterns: boolean;
  readonly #maxDenials: number;
  readonly #audit: AuditSink;
  readonly #onDeny: ((denial: AclDenial) => void) | undefined;
  readonly #now: () => number;
  readonly #store: AclStore | undefined;

  #assignments: RoleAssignment[] = [];
  #denies: HardDeny[] = [];
  #denials: AclDenial[] = [];
  #denialId = 0;

  constructor(options: AclOptions = {}) {
    const merged = new Map<string, RoleDefinition>();
    for (const [name, role] of Object.entries(ROLES)) merged.set(name, role as RoleDefinition);
    for (const [name, role] of Object.entries(options.roles ?? {})) merged.set(name, role);

    this.#roles = merged;
    this.#defaultRole = options.defaultRole ?? DEFAULT_ROLE;
    this.#owners = new Set(
      (options.ownerJids ?? [])
        .map((j) => normalizeJid(j, { allowLegacyServers: true }))
        .filter((j): j is string => j !== null),
    );
    this.#allowSubjectPatterns = options.allowSubjectPatterns ?? false;
    this.#maxDenials = options.maxDenials ?? 500;
    this.#audit = options.audit ?? silentAuditSink;
    this.#onDeny = options.onDeny;
    this.#now = options.now ?? Date.now;
    this.#store = options.store;

    if (!this.#roles.has(this.#defaultRole)) {
      throw new Error(
        `acl: defaultRole "${this.#defaultRole}" is not a defined role (known: ${[...this.#roles.keys()].join(', ')})`,
      );
    }
  }

  /* ── queries ───────────────────────────────────────────────────────── */

  /**
   * Can `subject` do `capability` in `scope`?
   *
   * Never throws. The returned `reason` is a sentence an operator can act on.
   */
  can(subject: unknown, capability: string, scope: string = GLOBAL_SCOPE): AclDecision {
    const asText = typeof subject === 'string' ? subject : String(subject);

    if (!isCapability(capability)) {
      return this.#deny({
        allowed: false,
        capability,
        subject: asText,
        scope,
        reason: `unknown capability "${capability}" — it is not defined in permissions.ts, so no role can grant it`,
        roles: [],
        matchedGrant: null,
        matchedDeny: null,
      });
    }

    const subjectJid = normalizeJid(subject, { allowLegacyServers: true });
    if (subjectJid === null) {
      return this.#deny({
        allowed: false,
        capability,
        subject: asText,
        scope,
        reason: `subject is not a valid jid — malformed subjects are denied rather than ignored`,
        roles: [],
        matchedGrant: null,
        matchedDeny: null,
      });
    }

    const at = this.#now();
    this.#pruneExpired(at);

    const assignments = this.#matching(subjectJid, scope);
    const roles = assignments.map((a) => a.role);

    /* 1. hard denies — outrank everything, owners included.
     *
     * Deliberately checked before the owner bypass. A `deny()` issued during an
     * incident ("lock this number out of session export") has to actually lock
     * it; an owner override that silently ignored it would produce a deny that
     * looks effective in the trail and grants anyway. */
    for (const entry of this.#denies) {
      if (!this.#inScope(entry.scope, scope)) continue;
      if (!subjectMatches(entry.subject, subjectJid, this.#allowSubjectPatterns)) continue;
      if (entry.expiresAt !== null && entry.expiresAt <= at) continue;
      if (!grantMatches(entry.grant, capability)) continue;

      return this.#deny({
        allowed: false,
        capability,
        subject: subjectJid,
        scope,
        reason: `explicit deny on "${entry.grant}" by ${entry.deniedBy}: ${entry.reason}`,
        roles,
        matchedGrant: null,
        matchedDeny: entry.grant,
      });
    }

    /* 2. owner bypass — skips the role ladder, but not the denies above */
    if (this.#owners.has(subjectJid)) {
      return {
        allowed: true,
        capability,
        subject: subjectJid,
        scope,
        reason: 'subject is a configured owner; owners bypass the role ladder',
        roles: ['owner'],
        matchedGrant: '*',
        matchedDeny: null,
      };
    }

    /* 3. role denies */
    for (const assignment of assignments) {
      const role = this.#roles.get(assignment.role);
      if (!role) continue;
      const deny = (role.denies ?? []).find((d) => grantMatches(d, capability));
      if (deny) {
        return this.#deny({
          allowed: false,
          capability,
          subject: subjectJid,
          scope,
          reason: `role "${role.name}" explicitly denies "${deny}", and deny overrides allow`,
          roles,
          matchedGrant: null,
          matchedDeny: deny,
        });
      }
    }

    /* 4. role grants */
    for (const assignment of assignments) {
      const role = this.#roles.get(assignment.role);
      if (!role) {
        return this.#deny({
          allowed: false,
          capability,
          subject: subjectJid,
          scope,
          reason: `assignment references undefined role "${assignment.role}" — an unknown role grants nothing`,
          roles,
          matchedGrant: null,
          matchedDeny: null,
        });
      }

      const grant = role.grants.find((g) => grantMatches(g, capability));
      if (grant) {
        return {
          allowed: true,
          capability,
          subject: subjectJid,
          scope,
          reason: `granted by role "${role.name}" via ${grant === '*' ? '*' : `"${grant}"`}`,
          roles,
          matchedGrant: grant,
          matchedDeny: null,
        };
      }
    }

    if (assignments.length === 0) {
      return this.#deny({
        allowed: false,
        capability,
        subject: subjectJid,
        scope,
        reason:
          this.#defaultRole === 'guest'
            ? `no role assigned in ${scope === GLOBAL_SCOPE ? 'the global scope' : `scope ${scope}`}, and the default role "guest" grants nothing`
            : `no role assigned; default role "${this.#defaultRole}" does not grant ${capability}`,
        roles,
        matchedGrant: null,
        matchedDeny: null,
      });
    }

    return this.#deny({
      allowed: false,
      capability,
      subject: subjectJid,
      scope,
      reason: `roles [${roles.join(', ')}] do not grant ${capability}`,
      roles,
      matchedGrant: null,
      matchedDeny: null,
    });
  }

  /** `can()` as a boolean. Use `can()` when the caller has to explain a refusal. */
  allows(subject: unknown, capability: string, scope: string = GLOBAL_SCOPE): boolean {
    return this.can(subject, capability, scope).allowed;
  }

  /**
   * `can()` or throw.
   *
   * For the guard-clause shape. The error carries the full decision, so a
   * caller that logs it records the reason instead of a bare "denied".
   */
  assert(subject: unknown, capability: string, scope: string = GLOBAL_SCOPE): void {
    const decision = this.can(subject, capability, scope);
    if (!decision.allowed) throw new AclDeniedError(decision);
  }

  /** Role names in effect for a subject in a scope. */
  rolesFor(subject: unknown, scope: string = GLOBAL_SCOPE): string[] {
    const subjectJid = normalizeJid(subject, { allowLegacyServers: true });
    if (subjectJid === null) return [];
    this.#pruneExpired(this.#now());
    return this.#matching(subjectJid, scope).map((a) => a.role);
  }

  /**
   * Every capability the subject holds.
   *
   * Walks the closed `CAPABILITIES` set rather than expanding role grants, so
   * the result can never contain a capability nobody defined.
   */
  grantsFor(subject: unknown, scope: string = GLOBAL_SCOPE): Set<Capability> {
    const out = new Set<Capability>();
    for (const capability of Object.values(CAPABILITIES)) {
      if (this.can(subject, capability, scope).allowed) out.add(capability);
    }
    return out;
  }

  isOwner(subject: unknown): boolean {
    const jid = normalizeJid(subject, { allowLegacyServers: true });
    return jid !== null && this.#owners.has(jid);
  }

  /** Effective policy for a subject, as data. For support and debugging. */
  explain(
    subject: unknown,
    scope: string = GLOBAL_SCOPE,
  ): {
    subject: string;
    scope: string;
    roles: string[];
    capabilities: string[];
    denied: Array<{ capability: string; reason: string }>;
  } {
    const subjectJid = normalizeJid(subject, { allowLegacyServers: true }) ?? String(subject);
    const capabilities: string[] = [];
    const denied: Array<{ capability: string; reason: string }> = [];

    for (const capability of Object.values(CAPABILITIES)) {
      const decision = this.can(subjectJid, capability, scope);
      if (decision.allowed) capabilities.push(capability);
      else denied.push({ capability, reason: decision.reason });
    }

    return {
      subject: subjectJid,
      scope,
      roles: this.rolesFor(subjectJid, scope),
      capabilities,
      denied,
    };
  }

  /* ── mutation ──────────────────────────────────────────────────────── */

  /**
   * Assign a role.
   *
   * Throws on an invalid subject or an unknown role rather than ignoring the
   * call: a mistyped role name that lands nowhere produces an ACL that looks
   * configured and is not.
   */
  assign(
    subject: string,
    role: string,
    scope: string = GLOBAL_SCOPE,
    options: { readonly grantedBy?: string; readonly ttlMs?: number; readonly expiresAt?: number } = {},
  ): RoleAssignment {
    const resolvedSubject = this.#resolveSubject(subject, 'assign');
    if (!this.#roles.has(role)) {
      throw new Error(`acl.assign: unknown role "${role}" (known: ${[...this.#roles.keys()].join(', ')})`);
    }
    const resolvedScope = this.#validateScope(scope);
    const at = this.#now();

    const assignment: RoleAssignment = {
      id: nextId('role'),
      subject: resolvedSubject,
      role,
      scope: resolvedScope,
      grantedBy: options.grantedBy ?? 'system',
      grantedAt: at,
      expiresAt: options.expiresAt ?? (options.ttlMs !== undefined ? at + options.ttlMs : null),
    };

    this.#assignments.push(assignment);
    this.#persist();

    this.#audit.audit({
      action: 'acl.assigned',
      actor: assignment.grantedBy,
      scope: resolvedScope,
      outcome: 'info',
      reason: `granted role "${role}" to ${resolvedSubject}`,
      meta: { subject: resolvedSubject, role, expiresAt: assignment.expiresAt },
    });

    return assignment;
  }

  /**
   * Revoke assignments. Returns how many were removed.
   *
   * Scoped precisely on purpose: dropping every assignment for a jid because
   * you meant to clear one group is a support incident.
   */
  revoke(subject: string, options: { readonly scope?: string; readonly role?: string } = {}): number {
    const resolved = this.#resolveSubject(subject, 'revoke', true);
    if (resolved === null) return 0;

    const before = this.#assignments.length;
    this.#assignments = this.#assignments.filter((a) => {
      const sameSubject = a.subject === resolved;
      const sameScope = options.scope === undefined || a.scope === options.scope;
      const sameRole = options.role === undefined || a.role === options.role;
      return !(sameSubject && sameScope && sameRole);
    });

    const removed = before - this.#assignments.length;
    if (removed > 0) {
      this.#persist();
      this.#audit.audit({
        action: 'acl.revoked',
        actor: 'system',
        scope: options.scope ?? GLOBAL_SCOPE,
        outcome: 'info',
        reason: `revoked ${removed} assignment(s) from ${resolved}`,
        meta: { subject: resolved, removed, role: options.role },
      });
    }
    return removed;
  }

  /**
   * Block a capability outright, outranking every role.
   *
   * The "kick them, and make sure a stale assignment cannot walk them back in"
   * primitive, and the reason the ACL carries a deny list at all.
   */
  deny(
    subject: string,
    grant: GrantPattern,
    reason: string,
    scope: string = GLOBAL_SCOPE,
    options: { readonly deniedBy?: string; readonly ttlMs?: number } = {},
  ): HardDeny {
    const resolvedSubject = this.#resolveSubject(subject, 'deny');
    const resolvedScope = this.#validateScope(scope);
    const at = this.#now();

    const entry: HardDeny = {
      id: nextId('deny'),
      subject: resolvedSubject,
      grant,
      scope: resolvedScope,
      reason,
      deniedBy: options.deniedBy ?? 'system',
      deniedAt: at,
      expiresAt: options.ttlMs !== undefined ? at + options.ttlMs : null,
    };

    this.#denies.push(entry);
    this.#persist();

    this.#audit.audit({
      action: 'acl.denied',
      actor: entry.deniedBy,
      scope: resolvedScope,
      outcome: 'deny',
      reason: `explicit deny of "${grant}" for ${resolvedSubject}: ${reason}`,
      meta: { subject: resolvedSubject, grant },
    });

    return entry;
  }

  /** Lift a hard deny by id. Returns true if one was removed. */
  liftDeny(id: string): boolean {
    const before = this.#denies.length;
    this.#denies = this.#denies.filter((d) => d.id !== id);
    const removed = before - this.#denies.length;
    if (removed > 0) this.#persist();
    return removed > 0;
  }

  /* ── inspection ────────────────────────────────────────────────────── */

  assignments(scope?: string): readonly RoleAssignment[] {
    return scope === undefined
      ? this.#assignments.slice()
      : this.#assignments.filter((a) => a.scope === scope);
  }

  hardDenies(scope?: string): readonly HardDeny[] {
    return scope === undefined ? this.#denies.slice() : this.#denies.filter((d) => d.scope === scope);
  }

  /** The denial trail, oldest first, bounded by `maxDenials`. */
  denials(): readonly AclDenial[] {
    return this.#denials.slice();
  }

  /** Serialisable state, for persistence. */
  snapshot(): { assignments: RoleAssignment[]; denies: HardDeny[] } {
    return {
      assignments: this.#assignments.map((a) => ({ ...a })),
      denies: this.#denies.map((d) => ({ ...d })),
    };
  }

  /** Load persisted state. Bad rows are skipped, never fatal. */
  async hydrate(state: { assignments?: RoleAssignment[]; denies?: HardDeny[] }): Promise<void> {
    for (const a of state.assignments ?? []) {
      if (!a || typeof a.subject !== 'string' || typeof a.role !== 'string') continue;
      if (!this.#roles.has(a.role)) continue;
      this.#assignments.push({
        id: typeof a.id === 'string' ? a.id : nextId('role'),
        subject: a.subject,
        role: a.role,
        scope: typeof a.scope === 'string' ? a.scope : GLOBAL_SCOPE,
        grantedBy: typeof a.grantedBy === 'string' ? a.grantedBy : 'system',
        grantedAt: typeof a.grantedAt === 'number' ? a.grantedAt : this.#now(),
        expiresAt: typeof a.expiresAt === 'number' ? a.expiresAt : null,
      });
    }

    for (const d of state.denies ?? []) {
      if (!d || typeof d.subject !== 'string' || typeof d.grant !== 'string') continue;
      this.#denies.push({
        id: typeof d.id === 'string' ? d.id : nextId('deny'),
        subject: d.subject,
        grant: d.grant,
        scope: typeof d.scope === 'string' ? d.scope : GLOBAL_SCOPE,
        reason: typeof d.reason === 'string' ? d.reason : 'unspecified',
        deniedBy: typeof d.deniedBy === 'string' ? d.deniedBy : 'system',
        deniedAt: typeof d.deniedAt === 'number' ? d.deniedAt : this.#now(),
        expiresAt: typeof d.expiresAt === 'number' ? d.expiresAt : null,
      });
    }
  }

  /** Load from the configured store, if any. */
  async load(): Promise<void> {
    if (!this.#store) return;
    const state = await this.#store.load();
    if (state) await this.hydrate(state);
  }

  /**
   * Push state to the store.
   *
   * Fire-and-forget on purpose: a store failure must not roll back a grant that
   * already took effect in memory, because a half-applied ACL is harder to
   * reason about than a lost write that the caller can retry.
   */
  #persist(): void {
    const store = this.#store;
    if (!store) return;
    void store.save(this.snapshot()).catch(() => {
      /* surfaced by the store's own error handling */
    });
  }

  /* ── internals ─────────────────────────────────────────────────────── */

  /**
   * Validate a subject for a mutation.
   *
   * The `soft` overload returns `null` instead of throwing, for `revoke` where
   * an unmatched subject is a normal outcome rather than a caller bug.
   */
  #resolveSubject(subject: string, context: string, soft: true): string | null;
  #resolveSubject(subject: string, context: string, soft?: false): string;
  #resolveSubject(subject: string, context: string, soft = false): string | null {
    if (typeof subject !== 'string' || subject.length === 0) {
      if (soft) return null;
      throw new Error(`acl.${context}: subject must be a non-empty string`);
    }

    if (subject.includes('*')) {
      if (!this.#allowSubjectPatterns) {
        if (soft) return null;
        throw new Error(
          `acl.${context}: subject patterns require allowSubjectPatterns: true (refused "${subject}")`,
        );
      }
      const compiled = compileSubject(subject);
      if (!compiled.ok) {
        if (soft) return null;
        throw new Error(`acl.${context}: ${compiled.reason}`);
      }
      return compiled.value.source;
    }

    const jid = normalizeJid(subject, { allowLegacyServers: true });
    if (jid === null) {
      if (soft) return null;
      throw new Error(`acl.${context}: "${subject}" is not a valid jid`);
    }
    return jid;
  }

  #validateScope(scope: string): string {
    if (scope === GLOBAL_SCOPE) return scope;
    if (!isValidJid(scope, { allowLegacyServers: true })) {
      throw new Error(`acl: scope "${scope}" must be "${GLOBAL_SCOPE}" or a valid group jid`);
    }
    return scope;
  }

  /**
   * Assignments in effect for (subject, scope).
   *
   * A group assignment applies only in that group. It never widens to the
   * global scope — that single rule is what stops a per-group moderator from
   * becoming a bot-wide one.
   */
  #matching(subject: string, scope: string): RoleAssignment[] {
    const out: RoleAssignment[] = [];
    for (const a of this.#assignments) {
      if (a.scope !== GLOBAL_SCOPE && a.scope !== scope) continue;
      if (!subjectMatches(a.subject, subject, this.#allowSubjectPatterns)) continue;
      out.push(a);
    }
    return out;
  }

  #inScope(entryScope: string, requested: string): boolean {
    return entryScope === GLOBAL_SCOPE || entryScope === requested;
  }

  #pruneExpired(at: number): void {
    const live = (expiry: number | null): boolean => expiry === null || expiry > at;
    this.#assignments = this.#assignments.filter((a) => live(a.expiresAt));
    this.#denies = this.#denies.filter((d) => live(d.expiresAt));
  }

  /**
   * Build, record and return a denial.
   *
   * Every refusal goes through here, so there is no code path that says "no"
   * without leaving a trace. A `can()` that returns `false` with nothing in the
   * trail is indistinguishable from a bug.
   */
  #deny(decision: Omit<AclDenial, 'id' | 'at'>): AclDecision {
    this.#denialId += 1;
    const denial: AclDenial = { ...decision, id: this.#denialId, at: this.#now() };

    this.#denials.push(denial);
    while (this.#denials.length > this.#maxDenials) this.#denials.shift();

    this.#audit.audit({
      action: 'acl.denied',
      actor: decision.subject,
      scope: decision.scope,
      outcome: 'deny',
      reason: decision.reason,
      meta: {
        capability: decision.capability,
        roles: decision.roles,
        matchedDeny: decision.matchedDeny,
      },
    });

    this.#onDeny?.(denial);
    return decision;
  }
}

/* ── plugin ──────────────────────────────────────────────────────────────── */

export interface AclPluginOptions extends AclOptions {
  /**
   * Check `message.send` on every `sendMessage`/`relayMessage`.
   *
   * Off by default: it changes the failure mode of every send from "throws
   * from the socket" to "throws with an ACL reason", which some hosts will not
   * expect. On, the recipient's group is the scope, so a group-scoped
   * `message.send` grant permits sending into that group and nowhere else.
   */
  readonly enforceOutbound?: boolean;
  /** Persist assignments under this key in `ctx.state`. Default `security.acl`. */
  readonly stateKey?: string;
}

/**
 * Attaches the ACL to the socket at order 15 — after the audit log (1) so
 * denials have somewhere to go, and well before `flow` (90) so a flow step can
 * consult it.
 */
export function accessControl(options: AclPluginOptions = {}): Plugin {
  return {
    name: 'acl',
    order: 15,

    async apply(ctx) {
      const log = ctx.log.child('acl');
      const stateKey = options.stateKey ?? 'security.acl';

      // The connected number is an owner by definition: it is the operator's
      // own line, and a bot that locks its operator out cannot be recovered
      // from WhatsApp at all.
      const owners = [
        ...(options.ownerJids ?? []),
        ...(typeof ctx.options.jid === 'string' ? [ctx.options.jid] : []),
      ].filter((j): j is string => typeof j === 'string' && j.length > 0);

      // Reuse the chain's audit log when the host did not supply a sink.
      // `auditTrail` runs at order 1 and this at 15, so `sock.audit` is already
      // there. Without this, denials would land in `silentAuditSink` and the
      // whole point of running both plugins together would be lost.
      const chain = ctx.sock as unknown as {
        audit?: { sink?: AuditSink; denialSink?: AuditSink };
      };
      const audit = options.audit ?? chain.audit?.denialSink ?? chain.audit?.sink ?? silentAuditSink;

      const acl = new AccessControl({
        ...options,
        audit,
        ownerJids: owners,
        store:
          options.store ??
          ({
            load: async () => {
              const loaded = await ctx.state.get<Record<string, unknown>>(stateKey, {});
              return {
                assignments: Array.isArray(loaded.assignments)
                  ? (loaded.assignments as RoleAssignment[])
                  : undefined,
                denies: Array.isArray(loaded.denies) ? (loaded.denies as HardDeny[]) : undefined,
              };
            },
            save: async (snapshot) => {
              await ctx.state.set(stateKey, snapshot);
            },
          } satisfies AclStore),
        onDeny: (denial) => {
          options.onDeny?.(denial);
          log.debug('denied', {
            subject: denial.subject,
            capability: denial.capability,
            scope: denial.scope,
            reason: denial.reason,
          });
          ctx.sock.ev.emit('super.aclDenied' as never, denial as never);
        },
      });

      // Awaited so plugins ordered after this one see a hydrated policy rather
      // than an empty one that quietly denies everything.
      try {
        await acl.load();
      } catch (err) {
        log.warn('acl state could not be loaded; starting from an empty policy', {
          err: err instanceof Error ? err.message : String(err),
        });
      }

      if (options.enforceOutbound === true) {
        const holder = ctx.sock as unknown as Record<string, unknown>;

        const gate = (method: string): void => {
          // Captured before patching, because `undo()` alone is not sufficient
          // today: `patch()` stashes the pristine function only for the first
          // method it sees on a target, so `undo()` writes `undefined` for any
          // method patched afterwards. Capturing here makes this plugin's
          // disposal correct regardless of that, instead of leaving the socket
          // with a missing `relayMessage`.
          const before = holder[method];

          const handle = patch(ctx.sock as never, method, ((
            original: (...args: unknown[]) => unknown,
            self: unknown,
            args: unknown[],
          ): Promise<unknown> => {
            const target = args[0];
            const scope = scopeFor(target);
            const decision = acl.can(target, 'message.send', scope);

            if (!decision.allowed) {
              // Reject rather than drop: a silent no-send is indistinguishable
              // from a network failure and gets retried forever.
              return Promise.reject(new AclDeniedError(decision));
            }
            return Promise.resolve(Reflect.apply(original, self, args));
          }) as never);

          if (!handle.applied) {
            log.warn('method missing, acl send gate not attached', { method });
            return;
          }

          ctx.onDispose(() => {
            handle.undo();
            if (typeof holder[method] !== 'function' && typeof before === 'function') {
              holder[method] = before;
            }
          });
        };

        gate('sendMessage');
        gate('relayMessage');
      }

      Object.defineProperty(ctx.sock, 'acl', {
        value: {
          instance: acl,
          can: (subject: unknown, capability: string, scope?: string): AclDecision =>
            acl.can(subject, capability, scope),
          allows: (subject: unknown, capability: string, scope?: string): boolean =>
            acl.allows(subject, capability, scope),
          assert: (subject: unknown, capability: string, scope?: string): void =>
            acl.assert(subject, capability, scope),
          rolesFor: (subject: unknown, scope?: string): string[] => acl.rolesFor(subject, scope),
          grantsFor: (subject: unknown, scope?: string): Set<Capability> =>
            acl.grantsFor(subject, scope),
          explain: (subject: unknown, scope?: string) => acl.explain(subject, scope),
          assign: (
            subject: string,
            role: string,
            scope?: string,
            opts?: { grantedBy?: string; ttlMs?: number; expiresAt?: number },
          ): RoleAssignment => acl.assign(subject, role, scope, opts),
          revoke: (subject: string, opts?: { scope?: string; role?: string }): number =>
            acl.revoke(subject, opts),
          deny: (
            subject: string,
            grant: GrantPattern,
            reason: string,
            scope?: string,
            opts?: { deniedBy?: string; ttlMs?: number },
          ): HardDeny => acl.deny(subject, grant, reason, scope, opts),
          liftDeny: (id: string): boolean => acl.liftDeny(id),
          denials: (): readonly AclDenial[] => acl.denials(),
          assignments: (scope?: string) => acl.assignments(scope),
          hardDenies: (scope?: string) => acl.hardDenies(scope),
          scopeFor,
        },
        enumerable: false,
        configurable: true,
      });

      log.debug('attached', { owners: owners.length, enforceOutbound: options.enforceOutbound === true });
    },
  };
}

export default accessControl;