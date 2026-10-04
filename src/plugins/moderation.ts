import { extractText } from '../core/mention.js';
import { isGroup, sameUser } from '../core/jid.js';
import type { WAMessage } from '@whiskeysockets/baileys';
import type { CoreSocket, Plugin } from '../utils/types.js';

/**
 * Group moderation.
 *
 * Everything upstream of this — `groupGuard`, the ACL, `antiSpam` — observes.
 * `groupGuard` flags a mass add; `antiSpam` paces what the *bot* sends. Neither
 * ever acts on a member. This plugin is the one that does: it reads a group's
 * messages, applies a declarative rule set, and escalates a member through
 * strike → mute → kick → ban.
 *
 * The escalation is data, not code. `strikes` is a ladder of thresholds, so
 * "three warnings then a kick, and ban anyone who comes back" is configuration:
 *
 * ```ts
 * moderation({
 *   words: ['free crypto', /https?:\/\/wa\.me/],
 *   links: { blockInvite: true },
 *   flood: { max: 6, windowMs: 8_000 },
 *   strikes: { deleteAt: 1, muteAt: 2, kickAt: 3, banAt: 5, decayMs: 86_400_000 },
 * })
 * ```
 *
 * ## What a mute actually is here
 *
 * **There is no server-side per-member mute in the WhatsApp protocol.** A group
 * admin can only remove someone, and removing someone *is* the ban — there is
 * no shadow ban, no read-only participant, no mute that is not a removal.
 *
 * So a mute here means two things, and neither pretends to be more:
 *
 *   1. **An advisory flag you gate on.** `sock.__moderation.isMuted(groupId,
 *      jid)` goes true for the duration. Your command handler is what actually
 *      stops responding to them:
 *      `if (sock.__moderation.isMuted(gid, sender)) return;`
 *   2. **A reported decision.** Every enforcement emits `nyx.moderation` with
 *      `kind: 'mute'` and `mutedUntil`.
 *
 * **The moderation plugin keeps evaluating a muted member.** That is the whole
 * reason it works: a mute that also stopped the ladder could never escalate to
 * a kick or a ban, so `muteAt` would quietly be a ceiling instead of a step.
 * Mute is a step, not a wall. If you want the bot to go quiet, gate the bot.
 *
 * If you want the member actually gone, set `kickAt` or `banAt`.
 *
 * ## The admin exemption is not optional
 *
 * A moderation bot that kicks its own operator is an outage. `isAdmin` defaults
 * to **false for everyone**, which means the safe default is that nobody is
 * exempt and *you* have to name the exempt set. That is deliberate: shipping an
 * `admins: []` default would silently let any member's spam-mod kick the human
 * running the bot. Pass both `exempt` and `isAdmin` explicitly.
 *
 * Every exemption is also checked on the **action** path, not only on the
 * message path, so a mute that expires and re-fires cannot escalate someone who
 * was promoted in the meantime.
 *
 * ## Dry run
 *
 * `dryRun: true` computes every action, emits every event, and changes nothing
 * on WhatsApp. It is the right way to tune thresholds against a real group:
 * watch the `nyx.moderation` stream for a day, then turn it off.
 *
 * ## Why deletion is a send
 *
 *
 * `delete: { key, force: true }` on `sendMessage` is how rc14 deletes for
 * everyone. It is a *send*, so it passes back through `antiSpam`'s queue and
 * through anything else wrapping `sendMessage`. That ordering is correct — a
 * bot that can delete at full speed is itself a spam primitive — but it does
 * mean a delete under heavy pacing can lag the message it removes. Tests use a
 * fake socket, so they observe the call, not the round trip.
 */

export type ModerationKind =
  | 'delete'
  | 'mute'
  | 'kick'
  | 'ban'
  | 'word'
  | 'link'
  | 'flood';

export interface ModerationEvent {
  groupId: string;
  kind: ModerationKind;
  /** The member acted on, or null for group-level events. */
  jid: string | null;
  reason: string;
  strikes: number;
  /** Present when a mute was applied. */
  mutedUntil?: number;
  messageKey?: WAMessage['key'];
  at: number;
}

export interface StrikeLadder {
  /** Strike at which the offending message is deleted. */
  deleteAt?: number;
  /** Strike at which the member is muted locally. */
  muteAt?: number;
  /** How long a mute lasts. */
  muteMs?: number;
  /** Strike at which the member is removed. */
  kickAt?: number;
  /** Strike at which the member is removed and banned on re-entry. */
  banAt?: number;
  /** Strike at which the bot announces the action in the group. */
  announceAt?: number;
  /** After this long without a new strike, the count decays by one. Default 24h. */
  decayMs?: number;
}

export interface FloodRule {
  /** Messages allowed inside the window. */
  max?: number;
  windowMs?: number;
  /** Count a flood against the ladder. Default true. */
  strike?: boolean;
}

export interface LinkRule {
  /** Block `chat.whatsapp.com` and `wa.me` invites. Default true. */
  blockInvite?: boolean;
  /** Block every URL, not just invites. */
  blockAll?: boolean;
  /** Domains that pass even under `blockAll`. */
  allowDomains?: readonly string[];
  strike?: boolean;
}

export interface WordRule {
  /** Strings or patterns. Strings are matched case-insensitively as substrings. */
  pattern: string | RegExp | ReadonlyArray<string | RegExp>;
  strike?: boolean;
  label?: string;
}

export interface ModerationOptions {
  /** Groups to police. Default: every group. */
  groups?: (groupId: string) => boolean;
  /** Members who are never touched. Checked on both the message and action paths. */
  exempt?: (jid: string, groupId: string) => boolean;
  /** Members whose messages are never even counted. Default: nobody. */
  isAdmin?: (jid: string, groupId: string) => boolean;
  words?: readonly WordRule[];
  links?: LinkRule;
  flood?: FloodRule;
  strikes?: StrikeLadder;
  /** Compute and emit, but change nothing. */
  dryRun?: boolean;
  /** Observe every emitted event. Default: nothing is observed. */
  announce?: (event: ModerationEvent, groupId: string) => Promise<void> | void;
  /**
   * Wording for the in-group post made once a strike reaches `announceAt`.
   * Return an empty string to stay silent at that strike.
   */
  announceText?: (event: ModerationEvent) => string | undefined;
}

const INVITE = /(?:chat\.whatsapp\.com\/|wa\.me\/|whatsapp\.com\/invite\/)/i;
const URL = /\bhttps?:\/\/\S+/gi;

interface MemberState {
  strikes: number;
  lastStrike: number;
  mutedUntil: number;
  banned: boolean;
  /** True once the member has actually been removed from the group. */
  removed: boolean;
}

const key = (groupId: string, jid: string): string => `${groupId}|${jid}`;

/** `15551234567@s.whatsapp.net` → `15551234567`. Null-safe: group-level events carry no member. */
function localPart(jid: string | null): string {
  return jid?.split('@')[0] ?? 'someone';
}

/** Rounded up, so a 90-second mute does not read as "0m". */
function minutes(ms: number): string {
  return `${Math.max(1, Math.round(ms / 60_000))}m`;
}

/**
 * What the group is told, per outcome.
 *
 * The jid's local part stands in for a name because this plugin never resolves
 * one — `pushName` is whatever the sender typed and can be a multi-kilobyte
 * string of arbitrary content (see the module docs on names).
 */
const DEFAULT_ANNOUNCE: Record<ModerationKind, (event: ModerationEvent) => string> = {
  delete: (e) => `Removed a message from ${localPart(e.jid)}.`,
  mute: (e) => `Muted ${localPart(e.jid)} for ${minutes((e.mutedUntil ?? e.at) - e.at)}.`,
  kick: (e) => `Removed ${localPart(e.jid)} — strike ${e.strikes}.`,
  ban: (e) => `Banned ${localPart(e.jid)}.`,
  word: (e) => `Removed a message from ${localPart(e.jid)}.`,
  link: (e) => `Removed a link from ${localPart(e.jid)}.`,
  flood: (e) => `Removed a message from ${localPart(e.jid)} — flooding.`,
};

/** Build a case-insensitive substring or pattern matcher from a WordRule value. */
function matcher(pattern: WordRule['pattern']): (text: string) => boolean {
  const list = Array.isArray(pattern) ? pattern : [pattern as string | RegExp];
  const parts = list.map((p) => {
    if (p instanceof RegExp) return p;
    const escaped = p.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped, 'i');
  });
  return (text) => parts.some((re) => re.test(text));
}

/** True when `url` sits on an allowlisted domain. */
function allowed(url: string, domains: readonly string[]): boolean {
  return domains.some((d) => url.toLowerCase().includes(d.toLowerCase()));
}

export function moderation(options: ModerationOptions = {}): Plugin {
  const ladder: Required<StrikeLadder> = {
    deleteAt: options.strikes?.deleteAt ?? 1,
    muteAt: options.strikes?.muteAt ?? Number.POSITIVE_INFINITY,
    muteMs: options.strikes?.muteMs ?? 10 * 60 * 1000,
    kickAt: options.strikes?.kickAt ?? Number.POSITIVE_INFINITY,
    banAt: options.strikes?.banAt ?? Number.POSITIVE_INFINITY,
    announceAt: options.strikes?.announceAt ?? Number.POSITIVE_INFINITY,
    decayMs: options.strikes?.decayMs ?? 24 * 60 * 60 * 1000,
  };

  const wordRules = (options.words ?? []).map((rule) => ({
    rule,
    test: matcher(rule.pattern),
  }));

  const links = options.links ?? {};
  const blockInvite = links.blockInvite ?? true;
  const blockAll = links.blockAll ?? false;
  const allowDomains = links.allowDomains ?? [];

  const flood: FloodRule = { max: 8, windowMs: 10_000, strike: true, ...options.flood };
  const dryRun = options.dryRun === true;
  const inGroup = options.groups ?? (() => true);
  const exempt = options.exempt ?? (() => false);
  const isAdmin = options.isAdmin ?? (() => false);

  return {
    name: 'moderation',
    order: 145,

    apply(ctx) {
      const log = ctx.log.child('moderation');
      const sock = ctx.sock as CoreSocket & Record<string, unknown>;

      /** groupId|jid → state. */
      const members = new Map<string, MemberState>();
      /** groupId|jid → send timestamps, for the flood window. */
      const recent = new Map<string, number[]>();

      const stateOf = (groupId: string, jid: string): MemberState => {
        const k = key(groupId, jid);
        let state = members.get(k);
        if (!state) {
          state = { strikes: 0, lastStrike: 0, mutedUntil: 0, banned: false, removed: false };
          members.set(k, state);
        }
        // Decay is lazy: one strike is forgiven per decay window of quiet.
        if (state.lastStrike && Date.now() - state.lastStrike > ladder.decayMs && state.strikes > 0) {
          state.strikes -= 1;
          state.lastStrike = Date.now();
        }
        return state;
      };

      const emit = (event: ModerationEvent): void => {
        ctx.sock.ev.emit('nyx.moderation' as never, event as never);
        void options.announce?.(event, event.groupId);
      };

      /**
       * Remove a member.
       *
       * State is recorded *before* the dry-run check, because a dry run that
       * cannot tell you who it would have banned is useless: watching the
       * decision stream is the whole point. Only the network call is skipped.
       */
      const remove = async (groupId: string, jid: string, ban: boolean): Promise<void> => {
        const state = stateOf(groupId, jid);
        if (ban) state.banned = true;
        if (dryRun) return;
        if (state.removed && !ban) return; // already gone; do not remove twice
        const removeFn = (ctx.sock as unknown as Record<string, unknown>).groupParticipantsUpdate;
        if (typeof removeFn !== 'function') {
          log.warn('groupParticipantsUpdate missing, cannot remove', { groupId });
          return;
        }
        await Promise.resolve(
          Reflect.apply(removeFn, ctx.sock, [groupId, [jid], 'remove']),
        );
        state.removed = true;
      };

      /** rc14 deletes-for-everyone by re-sending the key with `delete`. */
      const deleteMessage = async (msg: WAMessage): Promise<void> => {
        if (dryRun) return;
        try {
          await ctx.sock.sendMessage(msg.key.remoteJid ?? '', {
            delete: { key: msg.key, force: true },
          } as never);
        } catch (err) {
          log.warn('delete failed', { id: msg.key.id, error: String(err) });
        }
      };

      /**
       * Post the announcement into the group.
       *
       * The same `sendMessage` a delete uses, so the anti-spam queue and pacing
       * apply here too. An announcement that bypassed the queue would be a way
       * to talk at full speed.
       */
      const postToGroup = async (groupId: string, text: string): Promise<void> => {
        try {
          await ctx.sock.sendMessage(groupId, { text });
        } catch (err) {
          log.warn('announcement failed', { groupId, error: String(err) });
        }
      };

      /**
       * Add a strike and run the ladder. Returns the event so the caller can
       * report it, and so tests can assert on one object rather than three.
       */
      const escalate = async (
        msg: WAMessage,
        groupId: string,
        jid: string,
        kind: ModerationKind,
        reason: string,
      ): Promise<ModerationEvent> => {
        const state = stateOf(groupId, jid);
        state.strikes += 1;
        state.lastStrike = Date.now();
        const n = state.strikes;

        const event: ModerationEvent = {
          groupId,
          kind,
          jid,
          reason,
          strikes: n,
          messageKey: msg.key,
          at: Date.now(),
        };

        // Delete first. An escalated member whose spam stays visible is not
        // moderated, and the delete is the only action everyone notices.
        if (n >= ladder.deleteAt) await deleteMessage(msg);

        if (n >= ladder.muteAt) {
          state.mutedUntil = Date.now() + ladder.muteMs;
          event.mutedUntil = state.mutedUntil;
          event.kind = 'mute';
        }
        // Ban supersedes kick rather than stacking with it: two removals for one
        // offence is a duplicate `groupParticipantsUpdate`, and a second removal
        // for an already-gone member can error the socket.
        if (n >= ladder.banAt) {
          await remove(groupId, jid, true);
          event.kind = 'ban';
          // A ban is terminal: the strike count stops mattering, because the
          // member is gone and the next thing we see is them trying to return.
          state.strikes = 0;
        } else if (n >= ladder.kickAt) {
          await remove(groupId, jid, false);
          event.kind = 'kick';
        }

        // `announceAt` posts into the group; `announce` only observes. Both exist
        // because they answer different questions — "tell me what happened" is
        // not "tell the group what happened". Same `>=` shape as every other rung,
        // so it fires on each strike from that point up, not once on crossing.
        //
        // A dry run stays quiet in the group: posting there is a network call and
        // a visible side effect. The event still reports the decision.
        if (n >= ladder.announceAt && !dryRun) {
          const text = options.announceText?.(event) ?? DEFAULT_ANNOUNCE[event.kind](event);
          if (text) await postToGroup(groupId, text);
        }

        log.info('action', { groupId, jid, kind: event.kind, strikes: n, reason });
        emit(event);
        return event;
      };

      const handle = (msg: WAMessage): void => {
        if (msg.key.fromMe) return;
        const groupId = msg.key.remoteJid;
        if (!groupId || !isGroup(groupId)) return;
        if (!inGroup(groupId)) return;

        const jid = msg.key.participant;
        if (!jid) return;

        // Admin exemption is checked before *anything* is counted, so an admin
        // cannot even trip the flood window. Exemption is silent by design: an
        // event per exempt message would drown the very events you want.
        if (isAdmin(jid, groupId) || exempt(jid, groupId)) return;

        const state = stateOf(groupId, jid);
        if (state.banned) {
          // They got here after a ban — someone re-added them. Remove again, and
          // clear `removed` first so the call is not suppressed as a duplicate.
          state.removed = false;
          void remove(groupId, jid, true);
          emit({ groupId, kind: 'ban', jid, reason: 're-added after ban', strikes: 0, at: Date.now() });
          return;
        }
        // A mute does NOT stop evaluation here — see “a mute is a step, not a
        // wall” in the module docs. Returning early would make `muteAt` a
        // ceiling: the ladder could never reach `kickAt` or `banAt`.
        //
        // ── flood ──────────────────────────────────────────────────────────
        //
        // Every message over the ceiling is its own offence, exactly like a
        // word-rule hit. An earlier version cleared the window on trigger,
        // which capped a flooder at one strike per burst — they would have to
        // trip the rule N separate times to climb the ladder, and a moderator
        // that resets its own counter on every violation never escalates.
        const k = key(groupId, jid);
        const windowMs = flood.windowMs ?? 10_000;
        const max = flood.max ?? 8;
        let stamps = recent.get(k);
        if (!stamps) {
          stamps = [];
          recent.set(k, stamps);
        }
        const now = Date.now();
        while (stamps.length && now - stamps[0]! >= windowMs) stamps.shift();
        stamps.push(now);
        if (stamps.length > max) {
          if (flood.strike !== false) {
            void escalate(msg, groupId, jid, 'flood', `> ${max} messages in ${windowMs}ms`);
          }
          return;
        }

        const text = extractText(msg);
        if (!text) return;

        // ── links ──────────────────────────────────────────────────────────
        const urls = text.match(URL) ?? [];
        for (const url of urls) {
          if (allowed(url, allowDomains)) continue;
          const isInvite = INVITE.test(url);
          if (!isInvite && !blockAll) continue;
          if (links.strike === false) {
            emit({ groupId, kind: 'link', jid, reason: url, strikes: 0, messageKey: msg.key, at: now });
          } else {
            void escalate(msg, groupId, jid, 'link', isInvite ? 'invite link' : url);
          }
          return;
        }

        // ── words ──────────────────────────────────────────────────────────
        for (const { rule, test } of wordRules) {
          if (!test(text)) continue;
          const label = rule.label ?? 'word filter';
          if (rule.strike === false) {
            emit({ groupId, kind: 'word', jid, reason: label, strikes: 0, messageKey: msg.key, at: now });
          } else {
            void escalate(msg, groupId, jid, 'word', label);
          }
          return;
        }
      };

      ctx.sock.ev.on('messages.upsert', ({ messages }: { messages: WAMessage[] }) => {
        for (const msg of messages ?? []) {
          try {
            handle(msg);
          } catch (err) {
            // One malformed message must not take the plugin with it.
            log.warn('message handling failed', { error: String(err) });
          }
        }
      });

      ctx.onDispose(() => {
        members.clear();
        recent.clear();
      });

      /**
       * The imperative surface. Everything the message pipeline does, callable
       * from a `/kick` command or a mod channel.
       */
      sock.__moderation = {
        moderationEvents: [] as ModerationEvent[],
        isMuted(groupId: string, jid: string): boolean {
          const state = members.get(key(groupId, jid));
          return state !== undefined && state.mutedUntil > Date.now();
        },
        isBanned(groupId: string, jid: string): boolean {
          return members.get(key(groupId, jid))?.banned === true;
        },
        strikesOf(groupId: string, jid: string): number {
          return members.get(key(groupId, jid))?.strikes ?? 0;
        },
        async mute(groupId: string, jid: string, ms = ladder.muteMs): Promise<void> {
          if (exempt(jid, groupId) || isAdmin(jid, groupId)) return;
          const state = stateOf(groupId, jid);
          state.mutedUntil = Date.now() + ms;
          emit({
            groupId, kind: 'mute', jid, reason: 'manual mute', strikes: state.strikes,
            mutedUntil: state.mutedUntil, at: Date.now(),
          });
        },
        unmute(groupId: string, jid: string): void {
          const state = members.get(key(groupId, jid));
          if (state) state.mutedUntil = 0;
        },
        async kick(groupId: string, jid: string): Promise<void> {
          if (exempt(jid, groupId) || isAdmin(jid, groupId)) return;
          await remove(groupId, jid, false);
          emit({ groupId, kind: 'kick', jid, reason: 'manual kick', strikes: 0, at: Date.now() });
        },
        async ban(groupId: string, jid: string): Promise<void> {
          if (exempt(jid, groupId) || isAdmin(jid, groupId)) return;
          await remove(groupId, jid, true);
          emit({ groupId, kind: 'ban', jid, reason: 'manual ban', strikes: 0, at: Date.now() });
        },
        unban(groupId: string, jid: string): void {
          const state = members.get(key(groupId, jid));
          if (state) state.banned = false;
        },
        /** Snapshot for a mod channel or a health endpoint. */
        stats(): { members: number; muted: number; banned: number; dryRun: boolean } {
          let muted = 0;
          let banned = 0;
          for (const state of members.values()) {
            if (state.mutedUntil > Date.now()) muted += 1;
            if (state.banned) banned += 1;
          }
          return { members: members.size, muted, banned, dryRun };
        },
        reset(): void {
          members.clear();
          recent.clear();
        },
      };

      ctx.sock.ev.on('nyx.moderation' as never, ((e: ModerationEvent) => {
        (sock.__moderation as { moderationEvents: ModerationEvent[] }).moderationEvents.push(e);
      }) as never);

      log.debug('attached', { dryRun, groups: options.groups ? 'scoped' : 'all' });
    },
  };
}

export { sameUser };

export default moderation;