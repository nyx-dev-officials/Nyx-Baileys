import type { BaileysEventMap, NewsletterMetadata } from '@whiskeysockets/baileys';
import type { Plugin } from '../utils/types.js';

/**
 * Newsletters (Channels).
 *
 * Newsletters are the one part of rc14 that has a proper, purpose-built event
 * family rather than riding `messages.upsert`. All four are exposed here:
 *
 *   `newsletter.reaction`               a reaction on a post — id + server_id + code
 *   `newsletter.view`                   a view count delta for one post
 *   `newsletter-participants.update`    an admin/subscriber role change
 *   `newsletter-settings.update`        a settings change, payload typed `any` upstream
 *
 * Two shapes of identity matter and they are easy to confuse. `id` is the
 * newsletter's own jid and identifies the channel; `server_id` identifies one
 * post inside it. They are **not** interchangeable and they live in different
 * namespaces, so every structure here keys reactions and views by the pair.
 *
 * `NewsletterMetadata` and the `newsletter*` socket methods return `unknown` or
 * nullable results, so everything crossing that boundary is validated or
 * reported as null rather than passed through as if it were sound.
 */

export interface NewsletterOptions {
  /** Distinct posts with tracked reactions. Oldest evicted first. */
  maxReactions?: number;
  /** Distinct newsletters with tracked views. Oldest evicted first. */
  maxViews?: number;
  /** Max role-change records kept. */
  maxParticipantEvents?: number;
  /** Max settings records kept. */
  maxSettings?: number;
}

/** Reaction state for one post. */
export interface NewsletterReactionState {
  readonly newsletterJid: string;
  /** The post's server id, not the message id. */
  readonly serverId: string;
  readonly code: string;
  /** How many reacted, as last reported by the server. */
  count: number;
  removed: boolean;
  readonly updatedAt: number;
}

export interface NewsletterViewState {
  readonly newsletterJid: string;
  readonly serverId: string;
  views: number;
  readonly updatedAt: number;
}

export interface NewsletterParticipantEvent {
  readonly newsletterJid: string;
  readonly author: string;
  readonly user: string;
  readonly role: string;
  readonly action: string;
  readonly at: number;
}

export interface NewsletterSettingsEvent {
  readonly newsletterJid: string;
  readonly update: unknown;
  readonly at: number;
}

export interface NewsletterReactionEvent {
  readonly newsletterJid: string;
  readonly serverId: string;
  readonly code?: string;
  readonly count?: number;
  readonly removed: boolean;
}

const pairKey = (jid: string, serverId: string): string => `${jid}::${serverId}`;

export function newsletters(options: NewsletterOptions = {}): Plugin {
  const maxReactions = Math.max(1, options.maxReactions ?? 500);
  const maxViews = Math.max(1, options.maxViews ?? 500);
  const maxParticipantEvents = Math.max(1, options.maxParticipantEvents ?? 200);
  const maxSettings = Math.max(1, options.maxSettings ?? 200);

  /** Bounded list that drops the oldest entry past its cap. */
  const ring = <T>(cap: number) => {
    const list: T[] = [];
    return {
      list,
      push: (item: T): void => {
        list.push(item);
        while (list.length > cap) list.shift();
      },
    };
  };

  return {
    name: 'newsletter',
    order: 135,

    apply(ctx) {
      const log = ctx.log.child('newsletter');

      const reactions = new Map<string, NewsletterReactionState>();
      const views = new Map<string, NewsletterViewState>();
      const participantEvents = ring<NewsletterParticipantEvent>(maxParticipantEvents);
      const settingsEvents = ring<NewsletterSettingsEvent>(maxSettings);

      const evict = <T>(map: Map<string, T>, cap: number): void => {
        while (map.size > cap) {
          const oldest = map.keys().next().value;
          if (oldest === undefined) break;
          map.delete(oldest);
        }
      };

      /* ── typed wrappers over upstream's untyped methods ────────── */

      /** `null` on any failure or malformed payload — never a throw. */
      const metadata = async (jid: string): Promise<NewsletterMetadata | null> => {
        try {
          return (await ctx.sock.newsletterMetadata('jid', jid)) ?? null;
        } catch (err) {
          log.debug('newsletterMetadata failed', { jid, err: (err as Error).message });
          return null;
        }
      };

      const follow = async (jid: string): Promise<boolean> => {
        try {
          await ctx.sock.newsletterFollow(jid);
          return true;
        } catch (err) {
          log.debug('newsletterFollow failed', { jid, err: (err as Error).message });
          return false;
        }
      };

      const unfollow = async (jid: string): Promise<boolean> => {
        try {
          await ctx.sock.newsletterUnfollow(jid);
          return true;
        } catch (err) {
          log.debug('newsletterUnfollow failed', { jid, err: (err as Error).message });
          return false;
        }
      };

      const setMuted = async (jid: string, muted: boolean): Promise<boolean> => {
        try {
          await (muted ? ctx.sock.newsletterMute(jid) : ctx.sock.newsletterUnmute(jid));
          return true;
        } catch (err) {
          log.debug('newsletter mute toggle failed', { jid, muted, err: (err as Error).message });
          return false;
        }
      };

      /** React to a post. Passing no code clears the reaction upstream. */
      const react = async (jid: string, serverId: string, code?: string): Promise<boolean> => {
        try {
          await ctx.sock.newsletterReactMessage(jid, serverId, code);
          return true;
        } catch (err) {
          log.debug('newsletterReactMessage failed', { jid, serverId, err: (err as Error).message });
          return false;
        }
      };

      const subscriberCount = async (jid: string): Promise<number | null> => {
        try {
          const result = await ctx.sock.newsletterSubscribers(jid);
          return result?.subscribers ?? null;
        } catch (err) {
          log.debug('newsletterSubscribers failed', { jid, err: (err as Error).message });
          return null;
        }
      };

      /* ── events ────────────────────────────────────────────────── */

      ctx.sock.ev.on('newsletter.reaction', (event: BaileysEventMap['newsletter.reaction']) => {
        if (!event?.id || !event.server_id) return;
        const key = pairKey(event.id, event.server_id);
        const code = event.reaction?.code ?? '';

        const existing = reactions.get(key);
        // `removed: true` means the reaction was taken back, so drop it rather
        // than keeping a zero-count ghost in the index.
        if (event.reaction?.removed) {
          if (existing) reactions.delete(key);
          ctx.sock.ev.emit('nyx.newsletterReaction' as never, {
            newsletterJid: event.id,
            serverId: event.server_id,
            code,
            removed: true,
          } as never);
          return;
        }

        const state: NewsletterReactionState = {
          newsletterJid: event.id,
          serverId: event.server_id,
          code,
          count: event.reaction?.count ?? existing?.count ?? 0,
          removed: false,
          updatedAt: Date.now(),
        };
        reactions.set(key, state);
        evict(reactions, maxReactions);
        ctx.sock.ev.emit('nyx.newsletterReaction' as never, state as never);
      });

      ctx.sock.ev.on('newsletter.view', (event: BaileysEventMap['newsletter.view']) => {
        if (!event?.id || !event.server_id) return;
        const key = pairKey(event.id, event.server_id);
        const state = views.get(key);
        // The event carries a count, not a delta, so it replaces rather than
        // accumulates — adding to it would double-count on every re-report.
        views.set(key, {
          newsletterJid: event.id,
          serverId: event.server_id,
          views: event.count,
          updatedAt: Date.now(),
        });
        evict(views, maxViews);
        ctx.sock.ev.emit('nyx.newsletterView' as never, views.get(key) as never);
        if (state) log.debug('newsletter view', { serverId: event.server_id, views: event.count });
      });

      ctx.sock.ev.on(
        'newsletter-participants.update',
        (event: BaileysEventMap['newsletter-participants.update']) => {
          if (!event?.id) return;
          const record: NewsletterParticipantEvent = {
            newsletterJid: event.id,
            author: event.author,
            user: event.user,
            role: event.new_role,
            action: event.action,
            at: Date.now(),
          };
          participantEvents.push(record);
          ctx.sock.ev.emit('nyx.newsletterParticipants' as never, record as never);
        },
      );

      ctx.sock.ev.on('newsletter-settings.update', (event: BaileysEventMap['newsletter-settings.update']) => {
        if (!event?.id) return;
        // Upstream types this payload as `any`, so it is stored verbatim and
        // re-exposed as `unknown` — the host decides how to read it.
        const record: NewsletterSettingsEvent = {
          newsletterJid: event.id,
          update: event.update,
          at: Date.now(),
        };
        settingsEvents.push(record);
        ctx.sock.ev.emit('nyx.newsletterSettings' as never, record as never);
      });

      /* ── surface ────────────────────────────────────────────────── */

      const topReactions = (newsletterJid?: string, limit = 50): NewsletterReactionState[] =>
        [...reactions.values()]
          .filter((r) => (newsletterJid ? r.newsletterJid === newsletterJid : true))
          .sort((a, b) => b.count - a.count)
          .slice(0, Math.max(0, limit));

      Object.defineProperty(ctx.sock, 'newsletterReactions', { value: reactions, enumerable: false, configurable: true });
      Object.defineProperty(ctx.sock, 'newsletterViews', { value: views, enumerable: false, configurable: true });
      Object.defineProperty(ctx.sock, 'newsletterParticipantEvents', {
        value: participantEvents.list,
        enumerable: false,
        configurable: true,
      });
      Object.defineProperty(ctx.sock, 'newsletterSettingsEvents', {
        value: settingsEvents.list,
        enumerable: false,
        configurable: true,
      });
      Object.defineProperty(ctx.sock, 'newsletterMetadata', { value: metadata, enumerable: false, configurable: true });
      Object.defineProperty(ctx.sock, 'newsletterFollow', { value: follow, enumerable: false, configurable: true });
      Object.defineProperty(ctx.sock, 'newsletterUnfollow', { value: unfollow, enumerable: false, configurable: true });
      Object.defineProperty(ctx.sock, 'newsletterSetMuted', { value: setMuted, enumerable: false, configurable: true });
      Object.defineProperty(ctx.sock, 'newsletterReact', { value: react, enumerable: false, configurable: true });
      Object.defineProperty(ctx.sock, 'newsletterSubscriberCount', {
        value: subscriberCount,
        enumerable: false,
        configurable: true,
      });
      Object.defineProperty(ctx.sock, 'newsletterTopReactions', {
        value: topReactions,
        enumerable: false,
        configurable: true,
      });

      log.debug('attached', { maxReactions, maxViews });
    },
  };
}

export default newsletters;
