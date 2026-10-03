/**
 * Capability vocabulary and role definitions.
 *
 * This is the *only* place a permission is named. `acl.ts` holds no string
 * literals of its own, so the permission surface of the whole framework is
 * greppable from one file and adding a capability is a one-line change that
 * every role definition and every `can()` call site immediately understands.
 *
 * Design notes worth keeping:
 *
 *   - Capabilities are dotted and hierarchical (`group.participants.manage`) so
 *     a grant can be expressed as a prefix wildcard (`group.*`) without
 *     enumerating leaves. Prefix wildcards are one-directional on purpose:
 *     `group.*` covers everything under `group.`, never `groupish.*`.
 *   - Roles are *named bundles*, not per-jid permission lists. Assigning a role
 *     to a jid is the operation operators think in; enumerating 22 capabilities
 *     per person is how ACLs rot into unreadable soup.
 *   - Denies live on the role too (`banned`), because deny-overrides-allow only
 *     works if a deny can outrank every grant gathered from every role at once.
 */

/** Runtime capability map. Values are the wire format; keys are for authors. */
export const CAPABILITIES = {
  /* messaging */
  MessageSend: 'message.send',
  MessageBroadcast: 'message.broadcast',
  MessageDelete: 'message.delete',
  MessageReact: 'message.react',

  /* media */
  MediaDownload: 'media.download',
  MediaSend: 'media.send',

  /* groups */
  GroupMetadataRead: 'group.metadata.read',
  GroupParticipantsRead: 'group.participants.read',
  GroupParticipantsManage: 'group.participants.manage',
  GroupSettingsManage: 'group.settings.manage',
  GroupLinkManage: 'group.link.manage',

  /* administration */
  AdminInvite: 'admin.invite',
  AdminRemove: 'admin.remove',
  AdminPromote: 'admin.promote',

  /* automation surface — flows and models are where untrusted text becomes action */
  FlowExecute: 'flow.execute',
  FlowManage: 'flow.manage',
  LlmQuery: 'llm.query',

  /* host configuration */
  ConfigRead: 'config.read',
  ConfigWrite: 'config.write',
  PluginInstall: 'plugin.install',

  /* session material — the highest-value secrets in the process */
  SessionExport: 'session.export',
  SessionReset: 'session.reset',

  /* integrations */
  WebhookPublish: 'webhook.publish',
  WebhookRead: 'webhook.read',

  /* the audit trail itself */
  AuditRead: 'audit.read',
  AuditPurge: 'audit.purge',
} as const;

export type Capability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

/** Every capability, in declaration order. */
export const CAPABILITY_LIST: readonly Capability[] = Object.freeze(
  Object.values(CAPABILITIES) as Capability[],
);

/** The grant that matches everything. */
export const GRANT_ALL = '*';

/**
 * A grant string: an exact capability, `prefix.*`, or `*`.
 *
 * Kept as `string` rather than a template-literal union so operators can pass
 * values from config files without a cast; `grantMatches()` is the validator.
 */
export type GrantPattern = string;

export interface RoleDefinition {
  readonly name: string;
  /** Shown in `acl.explain()` and audit metadata, so it must mean something. */
  readonly description: string;
  readonly grants: readonly GrantPattern[];
  /** Checked before grants. Any match denies, whatever else allows. */
  readonly denies?: readonly GrantPattern[];
  /**
   * Higher outranks lower. Used only for reporting ("who is the most
   * privileged actor that touched this") — never to resolve a permission.
   * Resolving by rank would let a high-rank role silently win a deny.
   */
  readonly rank: number;
}

/**
 * The default ladder. Deliberately small: every role is a real operating
 * decision, and a framework that ships fifteen near-identical roles ships a
 * permission model nobody reads.
 */
export const ROLES = {
  /** Everything, everywhere, including session export and audit purge. */
  owner: {
    name: 'owner',
    description: 'Full control of the bot, its session material and its audit trail.',
    grants: [GRANT_ALL],
    rank: 100,
  },

  /** Everything except the session/audit tail. */
  admin: {
    name: 'admin',
    description: 'Full operational control; cannot export sessions or purge the audit log.',
    grants: [
      'message.*',
      'media.*',
      'group.*',
      'admin.*',
      'flow.*',
      'llm.query',
      'config.read',
      'config.write',
      'plugin.install',
      'webhook.*',
      'audit.read',
    ],
    // Explicit, not implicit: if `session.*` is ever added to grants by a
    // future edit, the deny below still holds. Deny wins over grant, always.
    denies: ['session.export'],
    rank: 80,
  },

  /** Group-shaped power: run flows and moderate, touch nothing global. */
  moderator: {
    name: 'moderator',
    description: 'Moderates one group: participants, metadata, flows, media.',
    grants: [
      'message.send',
      'message.delete',
      'media.download',
      'media.send',
      'group.metadata.read',
      'group.participants.read',
      'group.participants.manage',
      'group.settings.manage',
      'flow.execute',
      'llm.query',
      'audit.read',
    ],
    rank: 60,
  },

  /** Can drive automation, cannot moderate or configure. */
  operator: {
    name: 'operator',
    description: 'Runs flows and talks to models on behalf of a chat.',
    grants: ['message.send', 'media.download', 'flow.execute', 'llm.query'],
    rank: 40,
  },

  /** Default for a recognised but unprivileged participant. */
  member: {
    name: 'member',
    description: 'Read-only participant: can trigger flows and query models.',
    grants: ['flow.execute', 'group.metadata.read'],
    rank: 20,
  },

  /** No grants at all. The default for an unknown jid. */
  guest: {
    name: 'guest',
    description: 'Unprivileged. Can do nothing but be in the room.',
    grants: [],
    rank: 10,
  },

  /** Deny-everything. Deny beats every grant in every other role. */
  banned: {
    name: 'banned',
    description: 'Explicitly denied everything, in every role aggregation.',
    grants: [],
    denies: [GRANT_ALL],
    rank: 0,
  },
} as const satisfies Record<string, RoleDefinition>;

export type RoleName = keyof typeof ROLES;

/** Applied to any subject with no assignment. Fail-closed by design. */
export const DEFAULT_ROLE: RoleName = 'guest';

/** All role names. */
export const ROLE_NAMES: readonly RoleName[] = Object.freeze(
  Object.keys(ROLES) as RoleName[],
);

/** Is this a capability we actually define? */
export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && (CAPABILITY_LIST as readonly string[]).includes(value);
}

/**
 * Does `grant` cover `capability`?
 *
 * Exact match, `prefix.*`, or `*`. Deliberately *not* suffix or infix
 * matching: a wildcard that matches in the middle of a name is a wildcard
 * nobody can reason about when the ACL misbehaves.
 */
export function grantMatches(grant: GrantPattern, capability: string): boolean {
  if (grant === GRANT_ALL) return true;
  if (!grant.endsWith('*')) return grant === capability;

  const prefix = grant.slice(0, -1);
  if (prefix === '') return true; // bare `*`
  // `prefix.*` must cover a whole segment, so `group.` is required. This stops
  // `group.*` from silently covering a hypothetical `groupadmin.send`.
  if (grant.endsWith('.*')) return capability.startsWith(prefix);
  return capability.startsWith(prefix);
}

/** First grant in `grants` that covers `capability`, or null. */
export function matchingGrant(
  grants: readonly GrantPattern[],
  capability: string,
): GrantPattern | null {
  for (const grant of grants) {
    if (grantMatches(grant, capability)) return grant;
  }
  return null;
}

/** First deny in `denies` that covers `capability`, or null. */
export function matchingDeny(
  denies: readonly GrantPattern[] | undefined,
  capability: string,
): GrantPattern | null {
  if (!denies) return null;
  return matchingGrant(denies, capability);
}

/**
 * What does this role alone say about this capability?
 *
 * Three-valued on purpose. Collapsing "no opinion" into "denied" would make a
 * `guest` role deny every capability it does not list, which turns a later
 * role's grant into a no-op and is a spectacularly confusing bug to debug.
 */
export type RoleVerdict = 'allow' | 'deny' | 'none';

export function roleVerdict(role: RoleDefinition, capability: string): RoleVerdict {
  if (matchingDeny(role.denies, capability)) return 'deny';
  if (matchingGrant(role.grants, capability)) return 'allow';
  return 'none';
}

/** Resolve a role by name, with a reason-carrying failure for unknown names. */
export function getRole(name: string): RoleDefinition | null {
  const role = (ROLES as Record<string, RoleDefinition | undefined>)[name];
  return role ?? null;
}

/**
 * Expand a role's grants into concrete capabilities.
 *
 * Wildcards resolve against `CAPABILITY_LIST`, so this is a closed set — the
 * ACL can never be talked into inventing a capability that does not exist.
 */
export function capabilitiesOf(role: RoleDefinition): Set<Capability> {
  const out = new Set<Capability>();
  for (const capability of CAPABILITY_LIST) {
    if (roleVerdict(role, capability) === 'allow') out.add(capability);
  }
  return out;
}

/**
 * Expand a raw grant list into concrete capabilities, e.g. to diff two
 * configurations or render them for an operator.
 */
export function expandGrants(grants: readonly GrantPattern[]): Set<Capability> {
  const out = new Set<Capability>();
  for (const capability of CAPABILITY_LIST) {
    if (matchingGrant(grants, capability)) out.add(capability);
  }
  return out;
}

/**
 * Register an application-specific role.
 *
 * Roles are a const object because a static set is easier to audit, but a host
 * application legitimately needs its own vocabulary ("billing", "trial_user").
 * This returns a fresh definition rather than mutating `ROLES`, so a plugin
 * cannot quietly widen the built-in ladder at runtime.
 */
export function defineRole(definition: RoleDefinition): RoleDefinition {
  return Object.freeze({
    ...definition,
    grants: Object.freeze([...definition.grants]),
    ...(definition.denies ? { denies: Object.freeze([...definition.denies]) } : {}),
  });
}

/** Render a grant for humans: `group.*` → `everything under group.`. */
export function describeGrant(grant: GrantPattern): string {
  if (grant === GRANT_ALL) return 'all capabilities';
  if (grant.endsWith('.*')) return `all capabilities under "${grant.slice(0, -2)}."`;
  return grant;
}