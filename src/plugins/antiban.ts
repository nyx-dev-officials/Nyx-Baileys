import { patch } from '../core/intercept.js';
import { PresenceChoreographer, type ChoreographerOptions } from '../antiban/circadian.js';
import { HumanEntropy, type HumanEntropyOptions, type EntropySocket } from '../antiban/entropy.js';
import {
  ContentVariator,
  LegitimacySignalInjector,
  readReceiptVariance,
  type LegitimacyOptions,
  type ReadReceiptVarianceOptions,
  type VariatorOptions,
} from '../antiban/imperfection.js';

import type { Plugin } from '../utils/types.js';

/**
 * Anti-ban plugin pack.
 *
 * ⚠️ EVASION MODULES — NONE IS IN THE DEFAULT CHAIN. Read `docs/ANTIBAN.md`
 * before enabling any of these. They exist to make automated activity less
 * distinguishable from a person's; that is a deliberate choice with real
 * consequences, not a reliability feature, and shipping them off by default is
 * the point.
 *
 * Every factory below attaches its engine to the socket under a well-known name
 * (`sock.choreographer`, `sock.variator`, `sock.legitimacy`, `sock.entropy`)
 * and registers an undo, so `dispose()` leaves the socket exactly as it was.
 */

/** Text-bearing content shapes this pack knows how to mutate. */
interface TextContent {
  text?: unknown;
}

const textOf = (content: unknown): string | null => {
  if (!content || typeof content !== 'object') return null;
  const text = (content as TextContent).text;
  return typeof text === 'string' ? text : null;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* ── presence choreography ───────────────────────────────────────────── */

/**
 * Model typing before each send. Optionally inject a distraction pause or an
 * offline gap first. Order 105: after the framework's own chain, so the pacing
 * the anti-spam queue applies is already in place.
 */
export function presenceChoreography(options: ChoreographerOptions = {}): Plugin {
  return {
    name: 'presence-choreography',
    order: 105,

    apply(ctx) {
      const log = ctx.log.child('choreography');
      const choreographer = new PresenceChoreographer({ ...options, enabled: options.enabled ?? true });

      const handle = patch(ctx.sock as never, 'sendMessage', (async (
        original: (...args: unknown[]) => unknown,
        self: unknown,
        args: unknown[],
      ): Promise<unknown> => {
        const jid = typeof args[0] === 'string' ? args[0] : '';
        const text = textOf(args[1]) ?? '';

        const distraction = choreographer.shouldPauseForDistraction();
        if (distraction.pause) await sleep(distraction.durationMs);

        const offline = choreographer.shouldTakeOfflineGap();
        if (offline.offline) await sleep(offline.durationMs);

        if (jid && text) {
          try {
            await choreographer.executeTypingPlan(ctx.sock as unknown as { sendPresenceUpdate: (s: string, j: string) => unknown }, jid, choreographer.computeTypingPlan(text.length));
          } catch (err) {
            log.debug('typing plan skipped', { err: (err as Error).message });
          }
        }

        return Reflect.apply(original, self, args);
      }) as never);

      if (handle.applied) ctx.onDispose(() => handle.undo());

      Object.defineProperty(ctx.sock, 'choreographer', { value: choreographer, enumerable: false, configurable: true });
      log.warn('presence choreography enabled');
    },
  };
}

/* ── content variation ───────────────────────────────────────────────── */

/** Vary the text of every outbound message so duplicates differ. Order 106. */
export function contentVariation(options: VariatorOptions = {}): Plugin {
  return {
    name: 'content-variation',
    order: 106,

    apply(ctx) {
      const variator = new ContentVariator(options);

      const handle = patch(ctx.sock as never, 'sendMessage', ((
        original: (...args: unknown[]) => unknown,
        self: unknown,
        args: unknown[],
      ): unknown => {
        const text = textOf(args[1]);
        if (text) {
          const varied = variator.vary(text);
          args = [args[0], { ...(args[1] as object), text: varied }, ...args.slice(2)];
        }
        return Reflect.apply(original, self, args);
      }) as never);

      if (handle.applied) ctx.onDispose(() => handle.undo());
      Object.defineProperty(ctx.sock, 'variator', { value: variator, enumerable: false, configurable: true });
    },
  };
}

/* ── legitimacy signals ──────────────────────────────────────────────── */

/**
 * Occasionally send a typo and then the correction, the way a person does.
 * Order 107. The correction is sent through the decorated socket so pacing
 * still applies; a re-entry guard stops it being "corrected" again.
 */
export function legitimacySignals(options: LegitimacyOptions = {}): Plugin {
  return {
    name: 'legitimacy-signals',
    order: 107,

    apply(ctx) {
      const log = ctx.log.child('legitimacy');
      const injector = new LegitimacySignalInjector(options);
      const correcting = new WeakSet<object>();

      const handle = patch(ctx.sock as never, 'sendMessage', ((
        original: (...args: unknown[]) => unknown,
        self: unknown,
        args: unknown[],
      ): unknown => {
        const text = textOf(args[1]);
        const content = args[1];
        if (!text || (content && typeof content === 'object' && correcting.has(content))) {
          return Reflect.apply(original, self, args);
        }

        const plan = injector.shouldInjectTypo(text);
        if (!plan) return Reflect.apply(original, self, args);

        const jid = typeof args[0] === 'string' ? args[0] : null;
        const typoArgs = [args[0], { ...(content as object), text: plan.typoText }, ...args.slice(2)];
        const result = Reflect.apply(original, self, typoArgs);

        if (jid) {
          const correction = { text: plan.correctionText };
          correcting.add(correction);
          setTimeout(() => {
            void Promise.resolve(ctx.sock.sendMessage(jid as never, correction as never)).catch(
              (err: Error) => log.debug('correction send failed', { err: err.message }),
            );
          }, plan.correctionDelayMs).unref?.();
        }

        return result;
      }) as never);

      if (handle.applied) ctx.onDispose(() => handle.undo());
      Object.defineProperty(ctx.sock, 'legitimacy', { value: injector, enumerable: false, configurable: true });
    },
  };
}

/* ── read-receipt variance ───────────────────────────────────────────── */

/** Delay `readMessages` by a Gaussian jitter. Order 108. */
export function readReceiptVariancePlugin(options: ReadReceiptVarianceOptions = {}): Plugin {
  return {
    name: 'read-receipt-variance',
    order: 108,

    apply(ctx) {
      const jitter = readReceiptVariance(options);
      const pending = new Set<ReturnType<typeof setTimeout>>();

      const handle = patch(ctx.sock as never, 'readMessages', ((
        original: (...args: unknown[]) => unknown,
        self: unknown,
        args: unknown[],
      ): Promise<unknown> => {
        const keys = Array.isArray(args[0]) ? (args[0] as Array<{ messageTimestamp?: unknown }>) : [];
        const now = Date.now();
        const isBacklog = keys.length > 0 && keys.every((key) => {
          const seconds = Number(key?.messageTimestamp);
          return Number.isFinite(seconds) && seconds > 0 && jitter.isBacklog(seconds * 1000, now);
        });

        if (isBacklog) return Promise.resolve(Reflect.apply(original, self, args));

        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(timer);
            try {
              resolve(Reflect.apply(original, self, args));
            } catch (err) {
              reject(err);
            }
          }, jitter.delayMs());
          timer.unref?.();
          pending.add(timer);
        });
      }) as never);

      ctx.onDispose(() => {
        for (const timer of pending) clearTimeout(timer);
        pending.clear();
        if (handle.applied) handle.undo();
      });
    },
  };
}

/* ── human entropy ───────────────────────────────────────────────────── */

/** Run background typing/read/presence activity on a long timer. Order 109. */
export function humanEntropy(options: HumanEntropyOptions = {}): Plugin {
  return {
    name: 'human-entropy',
    order: 109,

    apply(ctx) {
      const entropy = new HumanEntropy(ctx.sock as unknown as EntropySocket, {
        ...options,
        enabled: options.enabled ?? true,
      });
      entropy.attach();
      entropy.start();

      ctx.onDispose(() => entropy.stop());
      Object.defineProperty(ctx.sock, 'entropy', { value: entropy, enumerable: false, configurable: true });
      ctx.log.child('entropy').warn('human entropy enabled');
    },
  };
}

/** All anti-ban plugins, opt-in list, ascending order. */
export function antibanPlugins(): Plugin[] {
  return [presenceChoreography(), contentVariation(), legitimacySignals(), readReceiptVariancePlugin(), humanEntropy()];
}

export default antibanPlugins;
