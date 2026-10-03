import { DEFAULT_BROWSER, desktopUserAgent } from '../core/socket.js';
import type { Plugin } from '../utils/types.js';

/**
 * Identity layer.
 *
 * Baileys already identifies as a desktop client. This plugin's whole job is to
 * keep that identity *consistent*: one browser tuple, one UA, per socket, and
 * presence that matches real connection state rather than a random heartbeat.
 *
 * What it deliberately does not do is rotate the fingerprint per connection or
 * fire synthetic typing indicators / read receipts while idle. Both make the
 * account look machine-generated to the platform and are visible to the human
 * on the other end. Rationale in `docs/DESIGN-NOTES.md`.
 */

export const DEFAULT_IDENTITY = {
  browser: DEFAULT_BROWSER,
  /** Presence pushed on connect and cleared on disconnect. */
  online: 'available' as const,
  offline: 'unavailable' as const,
};

export function stealth(identity: Partial<typeof DEFAULT_IDENTITY> = {}): Plugin {
  const id = { ...DEFAULT_IDENTITY, ...identity };

  return {
    name: 'stealth',
    order: 10,

    apply(ctx) {
      const log = ctx.log.child('stealth');
      const sock = ctx.sock;

      // Expose the fingerprint in one place so nothing else invents a second
      // one. Consistency is the entire product here.
      Object.defineProperty(sock, '__identity', {
        value: { browser: id.browser, userAgent: desktopUserAgent(id.browser) },
        enumerable: false,
        configurable: true,
      });

      // Presence tracks real state: available while connected, unavailable once
      // we go away. No fake "warmth" traffic.
      const setPresence = async (state: 'available' | 'unavailable'): Promise<void> => {
        try {
          await sock.sendPresenceUpdate(state);
        } catch (err) {
          log.debug('presence update failed', { err: (err as Error).message });
        }
      };

      sock.ev.on('connection.update', (update: { connection?: string }) => {
        if (update.connection === 'open') void setPresence(id.online);
        if (update.connection === 'close') void setPresence(id.offline);
      });
      ctx.onDispose(() => {
        /* ev listener dies with the socket */
      });

      log.debug('identity pinned', { browser: id.browser });
    },
  };
}

export default stealth;
