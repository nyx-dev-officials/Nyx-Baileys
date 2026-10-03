import type { Plugin } from '../utils/types.js';

/**
 * Group policy guard.
 *
 * Listens to `group-participants.update` and flags two patterns that precede a
 * compromised or spammed group:
 *
 *   1. mass adds      — many participants promoted in from outside within a
 *                       short window
 *   2. privilege climb — a member that appears in the list only ever holding
 *                       `admin`, never a normal user role
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

  return {
    name: 'group-guard',
    order: 60,

    apply(ctx) {
      const log = ctx.log.child('group');
      const recent = new Map<string, number[]>();
      const admins = new Map<string, Set<string>>();
      const alerts: GroupAlert[] = [];

      const alert = (a: GroupAlert): void => {
        alerts.push(a);
        if (alerts.length > 100) alerts.shift();
        log.warn('group policy alert', { kind: a.kind, group: a.groupId, n: a.participants.length });
        ctx.sock.ev.emit('super.groupAlert' as never, a as never);
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

            // Everyone seen in this group so far has been an admin. Normal
            // groups have plenty of plain members, so this is worth surfacing.
            const known = admins.get(groupId)?.size ?? 0;
            if (known >= 3 && update.action === 'promote') {
              alert({
                groupId,
                kind: 'privilege-climb',
                participants: added,
                at: Date.now(),
                detail: `${known} participants observed, all elevated`,
              });
            }
          }
        },
      );

      Object.defineProperty(ctx.sock, 'groupAlerts', { value: alerts, enumerable: false, configurable: true });
      Object.defineProperty(ctx.sock, 'groupAdmins', { value: admins, enumerable: false, configurable: true });
    },
  };
}

export default groupGuard;
