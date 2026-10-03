import type { Plugin } from '../utils/types.js';

/**
 * LID / JID routing.
 *
 * WhatsApp has been migrating accounts to opaque Local List Identifiers
 * (`@lid`). A `pn` (phone-number jid) and the `@lid` for the same human are
 * different entities on the wire, and messaging one without resolving the other
 * either fails or — worse — succeeds against a stale cached mapping.
 *
 * This resolves `@lid` → `@s.whatsapp.net` through the same store WhatsApp's
 * web client uses, and caches the answer. Every send goes through `resolve()`,
 * so callers never have to care which identifier type they were handed.
 *
 * The cache is per-instance and bounded; it is the memory-GC plugin's job to
 * prune it, this plugin's job to fill it correctly.
 */

export interface JidCacheEntry {
  /** Alternate JID to use when sending to `lid`. */
  alt?: string;
  /** Device jid, when we know it. */
  device?: string;
  at: number;
}

export interface LidRouterOptions {
  /** How long a mapping is trusted before re-checking. */
  ttlMs?: number;
  /** Max cached mappings before the oldest are dropped. */
  max?: number;
}

export function lidRouter(options: LidRouterOptions = {}): Plugin {
  const ttl = options.ttlMs ?? 6 * 60 * 60 * 1000;
  const max = options.max ?? 5_000;

  return {
    name: 'lid-router',
    order: 20,

    apply(ctx) {
      const log = ctx.log.child('lid');
      const cache = new Map<string, JidCacheEntry>();

      const remember = (jid: string, entry: JidCacheEntry): void => {
        cache.set(jid, entry);
        if (cache.size > max) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
      };

      /** True for the opaque LID namespace. */
      const isLid = (jid: string): boolean => jid.endsWith('@lid');
      const isPn = (jid: string): boolean => jid.endsWith('@s.whatsapp.net');

      /**
       * Canonical JID for sending. Non-JID strings (phone numbers, `lid:` URIs)
       * are returned untouched — Baileys does its own normalisation there.
       *
       * rc14's `onWhatsApp` is varargs and returns `{jid, exists}[] | undefined`,
       * where the returned `jid` is already the canonical identifier — so the
       * answer to "which one do I send to" comes back from the server rather
       * than being derived here.
       */
      const resolve = async (target: string): Promise<string> => {
        if (!target.includes('@')) return target;
        if (isPn(target)) return target;
        if (!isLid(target)) return target;

        const cached = cache.get(target);
        if (cached && Date.now() - cached.at < ttl && cached.alt) return cached.alt;

        try {
          const probe = await ctx.sock.onWhatsApp(target);
          const found = probe?.find((r) => r.exists) ?? probe?.[0];
          if (found?.exists && found.jid && found.jid !== target) {
            remember(target, { alt: found.jid, at: Date.now() });
            log.debug('resolved', { from: target, to: found.jid });
            return found.jid;
          }
          remember(target, { at: Date.now() });
        } catch (err) {
          log.debug('lid lookup failed, using supplied jid', {
            jid: target,
            err: (err as Error).message,
          });
        }
        return target;
      };

      /**
       * Reverse lookup — "which lid do I send to for this person", used by group
       * fan-out where the membership list is lid-based.
       */
      const resolvePn = async (pn: string): Promise<string> => {
        for (const [lid, entry] of cache) {
          if (entry.alt === pn) return lid;
        }
        try {
          const probe = await ctx.sock.onWhatsApp(pn);
          const found = probe?.find((r) => r.exists) ?? probe?.[0];
          if (found?.exists && found.jid !== pn) {
            remember(found.jid, { alt: pn, at: Date.now() });
            return found.jid;
          }
        } catch {
          /* fall through */
        }
        return pn;
      };

      Object.defineProperty(ctx.sock, 'resolveJid', {
        value: resolve,
        enumerable: false,
        configurable: true,
      });
      Object.defineProperty(ctx.sock, 'resolvePn', {
        value: resolvePn,
        enumerable: false,
        configurable: true,
      });
      Object.defineProperty(ctx.sock, 'lidCache', {
        value: cache,
        enumerable: false,
        configurable: true,
      });

      log.debug('attached', { ttl, max });
    },
  };
}

export default lidRouter;
