import { isGroup } from '../core/jid.js';
import type { WAMessage } from '@whiskeysockets/baileys';
import type { CoreSocket, Plugin } from '../utils/types.js';

/**
 * Join, leave and role-change announcements.
 *
 * The single most requested thing a group bot does that `groupGuard` cannot do:
 * say something when someone arrives or leaves. It sounds trivial and it is
 * not, for two reasons that are the whole design of this file.
 *
 * ## A mass add is not N welcomes
 *
 * When an admin adds fifty people to sell a course, the well-behaved
 * implementation announces once — or not at all. Fifty separate "welcome
 * @someone" messages is the behaviour that gets a bot removed from a group, so
 * `maxPerEvent` (default 1) collapses any single event larger than that into one
 * bundled line instead of N lines. It is a per-event cap, not a rate limit:
 * `cooldownMs` handles the other case, where fifty people arrive one at a time.
 *
 * `groupGuard` detects the same pattern from the other side and alerts the
 * operator. This plugin's job is not to be the second alarm, it is to not be
 * the amplifier.
 *
 * `maxPerEvent: 0` turns announcements off for this plugin without removing
 * the listener, which is the switch you reach for when a group turns out to be
 * a mass-add farm.
 *
 * ## The name is not trusted, the jid is
 *
 * `pushName` is whatever the sender typed. `participants` is the identity.
 * Every template substitutes from the participant jid and the bot's own copy
 * of the roster; a name is only ever used if you ask for it, and asking for it
 * is opt-in because a name can be a 2 KB string of injection. That is why
 * `useNames` defaults to false.
 *
 * ## Mentioning is a decision, not a default
 *
 * `mention: 'participant'` (default) tags the person who arrived, which is what
 * a welcome should do. `mention: 'none'` sends plain text — no
 * `mentionedJid`, so nobody's phone buzzes. `mention: 'all'` is available and
 * deliberately not the default: tagging every member on every join is a group-
 * wide notification each time someone arrives, which is the invisible-ping
 * problem `mentions.ts` refuses to have. If you want it, you have to name it.
 */

/**
 * Not named `ParticipantAction`: Baileys exports its own type of that name
 * (`'add' | 'remove' | 'promote' | 'demote' | 'modify'`) and the root entry
 * re-exports upstream verbatim, so a collision here would break every
 * consumer's `tsc`.
 */
export type WelcomeAction = 'add' | 'remove' | 'promote' | 'demote';
export type MentionMode = 'participant' | 'none' | 'all';

export interface WelcomeOptions {
  /** Groups to announce in. Default: every group. */
  groups?: (groupId: string) => boolean;
  /** Render `{name}` from the roster. Off by default; see the module docs. */
  useNames?: boolean;
  /** Resolve a participant jid to a display name. */
  nameOf?: (jid: string, groupId: string) => string | undefined;
  mention?: MentionMode;
  /** Minimum gap between announcements in one group. Default 10s. */
  cooldownMs?: number;
  /** Collapse any single event with more participants than this. Default 1. */
  maxPerEvent?: number;
  events?: Partial<Record<WelcomeAction, boolean>>;
  /** Text templates. Empty or undefined disables that event. */
  templates?: Partial<Record<WelcomeAction, string>>;
  /** Skip a participant seen in this group within the window. Default 5 min. */
  rejoinWindowMs?: number;
  /**
   * Decide and report every announcement, but send none.
   *
   * Mirrors `moderation`'s `dryRun`, and exists for the same reason: without it
   * there is no way to exercise this plugin against a live socket without
   * posting to a real group. Cooldown, collapse, rejoin suppression and the
   * snapshot all still apply — only the `sendMessage` is skipped, and the
   * `nyx.welcome` event still fires so the decision is observable.
   */
  dryRun?: boolean;
}

export interface WelcomeSnapshot {
  /** Announcements actually sent. */
  sent: number;
  /** Events that were collapsed by `maxPerEvent` or the cooldown. */
  skipped: number;
  lastAt: number;
  lastGroup: string | null;
}

/**
 * rc14 delivers participants as `GroupParticipant[]` objects, not bare jids.
 * Accept both shapes and keep only the identity — the same normalization
 * `groupGuard` does, for the same reason.
 */
interface UpdateEvent {
  id?: string;
  participants?: Array<string | { id?: string; jid?: string }>;
  action?: string;
}

const jidOf = (p: string | { id?: string; jid?: string }): string =>
  typeof p === 'string' ? p : (p.id ?? p.jid ?? '');

const DEFAULTS = {
  mention: 'participant' as MentionMode,
  cooldownMs: 10_000,
  maxPerEvent: 1,
  rejoinWindowMs: 5 * 60_000,
};

export function welcome(options: WelcomeOptions = {}): Plugin {
  const mention = options.mention ?? DEFAULTS.mention;
  const cooldownMs = options.cooldownMs ?? DEFAULTS.cooldownMs;
  const maxPerEvent = options.maxPerEvent ?? DEFAULTS.maxPerEvent;
  const rejoinWindowMs = options.rejoinWindowMs ?? DEFAULTS.rejoinWindowMs;
  const dryRun = options.dryRun === true;
  const inGroup = options.groups ?? (() => true);

  const events = {
    add: options.events?.add ?? true,
    remove: options.events?.remove ?? true,
    promote: options.events?.promote ?? true,
    demote: options.events?.demote ?? false,
  } as Record<WelcomeAction, boolean>;

  const templates: Partial<Record<WelcomeAction, string>> = {
    add: 'Welcome to the group, {name}.',
    remove: '{name} has left the group.',
    promote: '{name} is now an admin.',
    ...options.templates,
  };

  return {
    name: 'welcome',
    order: 146,

    apply(ctx) {
      const log = ctx.log.child('welcome');
      const sock = ctx.sock as CoreSocket & Record<string, unknown>;

      const lastAt = new Map<string, number>();
      /** groupId|jid → last time we announced them. */
      const seenAt = new Map<string, number>();
      const snapshot: WelcomeSnapshot = { sent: 0, skipped: 0, lastAt: 0, lastGroup: null };

      const nameFor = (jid: string, groupId: string): string => {
        if (!options.useNames) return jid.split('@')[0] ?? jid;
        return options.nameOf?.(jid, groupId) ?? jid.split('@')[0] ?? jid;
      };

      const render = (template: string, jid: string, groupId: string): string =>
        template
          .replaceAll('{name}', nameFor(jid, groupId))
          .replaceAll('{jid}', jid)
          .replaceAll('{id}', groupId.split('@')[0] ?? groupId);

      const send = async (
        groupId: string,
        jid: string,
        action: WelcomeAction,
        count: number,
      ): Promise<void> => {
        const now = Date.now();

        // Per-event collapse: one announcement for a mass add. `maxPerEvent: 0` is
        // the explicit "announce nothing at all" setting — it is not "collapse
        // to a bundle", because a bundle for a single join would be a worse
        // message than none.
        if (count > maxPerEvent) {
          snapshot.skipped += 1;
          log.debug('collapsed', { groupId, count, maxPerEvent });
          if (maxPerEvent > 0 && count > 1) {
            await announce(groupId, `${count} people joined.`, []);
          }
          return;
        }

        const last = lastAt.get(groupId) ?? 0;
        if (now - last < cooldownMs) {
          snapshot.skipped += 1;
          log.debug('cooldown', { groupId, remaining: cooldownMs - (now - last) });
          return;
        }

        const seen = seenAt.get(`${groupId}|${jid}`) ?? 0;
        if (action === 'add' && now - seen < rejoinWindowMs) {
          snapshot.skipped += 1;
          return;
        }
        seenAt.set(`${groupId}|${jid}`, now);
        lastAt.set(groupId, now);
        snapshot.sent += 1;
        snapshot.lastAt = now;
        snapshot.lastGroup = groupId;

        await announce(groupId, render(templates[action] ?? '{name}', jid, groupId), [jid]);
      };

      const announce = async (
        groupId: string,
        text: string,
        mentioned: string[],
      ): Promise<void> => {
        const payload: Record<string, unknown> = { text };
        if (mention !== 'none' && mentioned.length) {
          payload.mentionedJid = mentioned;
        }
        try {
          // A dry run reports the decision and stays quiet in the group. Posting
          // there is a network call and a visible side effect, so it is the only
          // part skipped — cooldown, collapse and rejoin logic all still ran.
          if (!dryRun) await ctx.sock.sendMessage(groupId, payload as never);
          ctx.sock.ev.emit('nyx.welcome' as never, { groupId, text, mentioned, dryRun } as never);
        } catch (err) {
          // Failing to congratulate someone is not worth taking the bot down.
          log.warn('announce failed', { groupId, error: String(err) });
        }
      };

      ctx.sock.ev.on('group-participants.update', (raw: UpdateEvent) => {
        try {
          const groupId = raw?.id;
          const action = raw?.action as WelcomeAction;
          if (!groupId || !isGroup(groupId)) return;
          if (!inGroup(groupId)) return;
          if (!(action in events) || !events[action]) return;

          const participants = (raw.participants ?? []).map(jidOf).filter(Boolean);
          if (!participants.length) return;

          const first = participants[0]!;
          void send(groupId, first, action, participants.length);
        } catch (err) {
          log.warn('update handling failed', { error: String(err) });
        }
      });

      // No `ev.off` on dispose: the whole socket is discarded on rebuild, and
      // dropping the maps is what `dispose()` is actually responsible for here.
      ctx.onDispose(() => {
        lastAt.clear();
        seenAt.clear();
      });

      sock.__welcome = {
        welcomeSnapshot: snapshot,
        snapshot: () => ({ ...snapshot }),
        reset: () => {
          lastAt.clear();
          seenAt.clear();
          snapshot.sent = 0;
          snapshot.skipped = 0;
        },
      };

      log.debug('attached', { mention, cooldownMs, events });
    },
  };
}

export type { WAMessage };

export default welcome;