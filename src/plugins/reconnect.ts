import { DisconnectReason } from '@whiskeysockets/baileys';

import { invariant } from '../core/intercept.js';
import type { HealthLevel, HealthReport, Plugin } from '../utils/types.js';

/**
 * Self-healing reconnect.
 *
 * Watches `connection.update`. On a close that is *not* an explicit logout, it
 * backs off exponentially with jitter and asks the host to rebuild the socket
 * from the same persisted state. State is never rebuilt from memory — the auth
 * store is the source of truth, so a reconnect is the same code path as a cold
 * start.
 *
 * It will not hot-swap Signal session keys under a live socket. Credentials
 * that fail to parse are unrecoverable by design, and the honest response is to
 * report that a re-pair is needed rather than to invent a recovery that
 * desyncs the ratchet.
 */

export interface ReconnectOptions {
  /** First retry delay. Doubles each attempt. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Give up after this many consecutive failures. 0 = never give up. */
  maxAttempts?: number;
  /** Reset the backoff after this long without a disconnect. */
  resetAfterMs?: number;
}

export function autoReconnect(options: ReconnectOptions = {}): Plugin {
  const base = options.baseDelayMs ?? 1_000;
  const maxDelay = options.maxDelayMs ?? 60_000;
  const maxAttempts = options.maxAttempts ?? 0;
  const resetAfter = options.resetAfterMs ?? 5 * 60 * 1000;

  return {
    name: 'reconnect',
    order: 70,

    apply(ctx) {
      const log = ctx.log.child('reconnect');
      const signals: HealthReport['signals'] = { rateLimited: 0, dead: 0, server: 0, ok: 0 };
      let attempts = 0;
      let healthySince = Date.now();
      let timer: NodeJS.Timeout | null = null;

      const level = (): HealthLevel => {
        const bad = signals.rateLimited + signals.dead + signals.server;
        if (bad >= 10) return 'paused';
        if (bad >= 3) return 'elevated';
        return 'low';
      };

      const report = (): HealthReport => ({
        level: level(),
        since: healthySince,
        pausedFor: 0,
        signals: { ...signals },
      });

      /** Exponential with full jitter, so retries don't sync up. */
      const backoff = (attempt: number): number => {
        const ceiling = Math.min(maxDelay, base * 2 ** attempt);
        return Math.floor(Math.random() * ceiling);
      };

      const schedule = (): void => {
        if (timer) return;

        if (maxAttempts > 0 && attempts >= maxAttempts) {
          log.error('backoff exhausted; manual intervention needed', { attempts });
          return;
        }

        const delay = backoff(attempts);
        attempts += 1;
        log.info('scheduling reconnect', { attempt: attempts, delayMs: delay });

        timer = setTimeout(() => {
          timer = null;
          const sock = ctx.sock as unknown as { __requestReconnect?: () => Promise<boolean> | boolean };
          if (!sock.__requestReconnect) {
            log.warn('host exposes no __requestReconnect; socket left down');
            return;
          }
          Promise.resolve(sock.__requestReconnect())
            .then((ok) => {
              if (ok) {
                log.info('reconnected', { attempts });
                healthySince = Date.now();
              }
            })
            .catch((err: Error) => {
              log.warn('reconnect attempt failed', { err: err.message });
              schedule();
            });
        }, delay);
        timer.unref?.();
      };

      ctx.sock.ev.on(
        'connection.update',
        (update: { connection?: string; last?: { isLoggedIn?: boolean }; statusCode?: number }) => {
          if (update.connection === 'open') {
            attempts = 0;
            signals.ok += 1;
            healthySince = Date.now();
            // Backoff reset after a stretch of health.
            const timerReset = setTimeout(() => {
              signals.rateLimited = 0;
              signals.dead = 0;
              signals.server = 0;
            }, resetAfter);
            timerReset.unref?.();
            return;
          }

          if (update.connection !== 'close') return;

          const code = update.last?.isLoggedIn ? DisconnectReason.loggedOut : update.statusCode;
          switch (code) {
            case DisconnectReason.loggedOut:
              log.error('logged out — a fresh pairing is required', { code });
              // No reconnect loop can fix this; stopping is the correct move.
              if (timer) {
                clearTimeout(timer);
                timer = null;
              }
              return;
            case DisconnectReason.restartRequired:
              log.info('server asked for restart');
              schedule();
              return;
            case DisconnectReason.multideviceMismatch:
              log.error('multi-device mismatch; scan the QR again', { code });
              if (timer) {
                clearTimeout(timer);
                timer = null;
              }
              return;
            case DisconnectReason.timedOut:
              signals.dead += 1;
              schedule();
              return;
            case DisconnectReason.connectionReplaced:
              log.warn('connection replaced by another session');
              schedule();
              return;
            case DisconnectReason.connectionClosed:
              log.info('closed locally');
              schedule();
              return;
            case DisconnectReason.forbidden:
            case DisconnectReason.unavailableService:
              log.warn('server rejection', { code });
              signals.server += 1;
              schedule();
              return;
            default:
              log.warn('disconnected', { code });
              schedule();
          }
        },
      );

      Object.defineProperty(ctx.sock, 'health', { value: report, enumerable: false, configurable: true });

      ctx.onDispose(() => {
        if (timer) clearTimeout(timer);
        timer = null;
      });

      void invariant;
      log.debug('attached', { base, maxDelay, maxAttempts });
    },
  };
}

export default autoReconnect;
