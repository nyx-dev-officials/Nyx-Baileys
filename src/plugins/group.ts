import type { Plugin } from '../utils/types.js';

/**
 * Group policy guard.
 *
 * Listens to `group-participants.update` and flags two patterns that precede a
 * compromised or spammed group:
 *
 *   1. mass adds      — many participants promoted in from outside within a
 *                       short window
 *   2. privilege climb — an implausible fraction of the group's observed
 *                       membership holds admin at once
 *
 * Both are *reported*, never acted on unilaterally. Auto-kicking on a signal
 * this noisy is how a guard turns into the incident. The hook is where an
 * operator's own action (or a moderation service) decides what to do.
 */

export interface GroupPolicyOptions {
  /** Distinct adds from outside the group before the pattern fires. */
  massAddThreshold?: number;
  /** Window for those adds, in ms. */
  windowMs?: number;
  /** Fraction of observed members that must hold admin to flag a climb. */
  adminRatio?: number;
  /** Minimum admins observed before a climb can be flagged. */
  minAdmins?: number;
  /** Return true to ignore events for groups not on the allowlist. */
  allow?: (groupId: string) => boolean;
}

export interface GroupAlert {
  groupId: string;
  kind: 'mass-add' | 'privilege-climb';
  participants: string[];
  at: number;
  detail: string;
}

export function groupGuard(options: GroupPolicyOptions = {}): Plugin {
  const threshold = options.massAddThreshold ?? 8;
  const windowMs = options.windowMs ?? 10 * 60 * 1000;
  const adminRatio = options.adminRatio ?? 0.8;
  const minAdmins = options.minAdmins ?? 3;

  return {
    name: 'group-guard',
    order: 60,

    apply(ctx) {
      const log = ctx.log.child('group');
      const recent = new Map<string, number[]>();
      /** Participants currently believed to hold admin. */
      const admins = new Map<string, Set<string>>();
      /** Every participant observed in the group, whatever their role. */
      const members = new Map<string, Set<string>>();
      const alerts: GroupAlert[] = [];

      const alert = (a: GroupAlert): void => {
        alerts.push(a);
        if (alerts.length > 100) alerts.shift();
        log.warn('group policy alert', { kind: a.kind, group: a.groupId, n: a.participants.length });
        ctx.sock.ev.emit('nyx.groupAlert' as never, a as never);
      };

      ctx.sock.ev.on(
        'group-participants.update',
        (update: {
          id?: string;
          participants?: Array<string | { id?: string; jid?: string }>;
          action?: string;
        }) => {
          const groupId = update.id;
          if (!groupId) return;
          if (options.allow && !options.allow(groupId)) return;

          // Participants arrive as objects in rc14; we only need the jid.
          const added = (update.participants ?? [])
            .map((p) => (typeof p === 'string' ? p : (p.id ?? p.jid ?? '')))
            .filter((p) => p.endsWith('@s.whatsapp.net') || p.endsWith('@lid'));

          // Population tracker. This is what the climb ratio divides by: an
          // earlier version kept only `admins`, so the denominator was the
          // numerator and "3+ admins" fired on any active group. Plain members
          // seen through add/demote events now count.
          if (update.action === 'add' || update.action === 'promote' || update.action === 'demote') {
            const set = members.get(groupId) ?? new Set<string>();
            for (const p of added) set.add(p);
            members.set(groupId, set);
          } else if (update.action === 'remove') {
            const set = members.get(groupId);
            if (set) for (const p of added) set.delete(p);
          }

          if (update.action === 'add') {
            const now = Date.now();
            // Join timestamps only. The earlier version pushed jids into the
            // same array and inferred a count by halving its length, which was
            // both wrong arithmetic and the actual cause of this being noisy.
            const joins = (recent.get(groupId) ?? []).filter((t) => now - t < windowMs);
            joins.push(now);
            recent.set(groupId, joins);

            if (joins.length >= threshold) {
              alert({
                groupId,
                kind: 'mass-add',
                participants: added,
                at: now,
                detail: `${joins.length} joins within ${Math.round(windowMs / 60000)}m`,
              });
            }
          }

          if (update.action === 'promote' || update.action === 'demote') {
            const set = admins.get(groupId) ?? new Set<string>();
            for (const p of added) {
              if (update.action === 'promote') set.add(p);
              else set.delete(p);
            }
            admins.set(groupId, set);

            // A group where nearly everyone we have ever seen holds admin is
            // anomalous: real groups have a large plain-member majority. The
            // ratio is measured against observed membership, not against the
            // admin set itself, so a demotion genuinely lowers the signal.
            const known = set.size;
            const population = members.get(groupId)?.size ?? 0;
            const elevated = population > 0 ? known / population : 0;
            if (update.action === 'promote' && known >= minAdmins && elevated >= adminRatio) {
              alert({
                groupId,
                kind: 'privilege-climb',
                participants: added,
                at: Date.now(),
                detail:
                  known === population
                    ? `${known} participants observed, all elevated`
                    : `${known}/${population} observed members elevated`,
              });
            }
          } else if (update.action === 'remove') {
            // A removed participant is no longer elevated; drop the admin pin
            // without resurrecting an empty set for an otherwise-unknown group.
            const set = admins.get(groupId);
            if (set) for (const p of added) set.delete(p);
          }
        },
      );

      Object.defineProperty(ctx.sock, 'groupAlerts', { value: alerts, enumerable: false, configurable: true });
      Object.defineProperty(ctx.sock, 'groupAdmins', { value: admins, enumerable: false, configurable: true });
      Object.defineProperty(ctx.sock, 'groupMembers', { value: members, enumerable: false, configurable: true });
    },
  };
}

export default groupGuard;
