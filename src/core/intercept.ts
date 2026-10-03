/**
 * Composable runtime interception.
 *
 * The one primitive every plugin is built on. It replaces a method on an
 * object with a wrapper that receives the *current* implementation, so plugins
 * stack instead of clobbering each other:
 *
 *   plugin A wraps sendMessage  ->  A(original)
 *   plugin B wraps sendMessage  ->  B(A(original))     ← both apply
 *
 * The pristine function is stashed on a symbol, so repeated application
 * (reconnects, re-apply) can never nest wrappers indefinitely. Every patch
 * registers a disposer, so `NyxBaileys.dispose()` unwinds the object back to
 * exactly what `makeWASocket()` returned.
 */

import type { AnyRecord, Wrapper } from '../utils/types.js';

const STASH = Symbol.for('nyx-baileys.pristine');

export interface Patch<T extends object> {
  /** Restore just this patch. */
  undo(): void;
  /** Was the method actually present to patch? */
  readonly applied: boolean;
}  /**
   * Replace `target[name]` with `wrapper`, chaining onto whatever is already
   * there. Returns an undo handle that is safe to call more than once and that
   * refuses to clobber a newer wrapper it has already been superseded by.
 *
 * The wrapper receives the implementation that was in place *at the moment of
 * this patch* — so applying A then B yields `B(A(original))`, not
 * `B(original)`. Getting this wrong is subtle and catastrophic: plugin N
 * silently stops running while still appearing attached.
 *
 * The pristine function is stashed on a symbol purely so `undo()` restores the
 * true original rather than leaving a wrapper in place.
 *
 * If the method doesn't exist, nothing is patched and `applied` is false —
 * callers decide whether that's fatal.
 */
export function patch<T extends object>(
  target: T,
  name: keyof T & string,
  wrapper: Wrapper<any>,
): Patch<T> {
  const original = (target as AnyRecord)[name];

  if (typeof original !== 'function') {
    return { undo: () => {}, applied: false };
  }

  // Stash the pristine version of *each* method, on first patch of that method.
  // An earlier version stashed only the first method it ever saw, so a second
  // method read `undefined` and `undo()` wrote `undefined` over it — which
  // silently destroyed `relayMessage` for every plugin patching two methods.
  const stashKey = STASH as unknown as string;
  const holder = target as AnyRecord;
  const stash = (holder[stashKey] ??= {}) as Record<string, unknown>;
  if (!(name in stash)) {
    stash[name] = original;
    Object.defineProperty(holder, stashKey, {
      value: stash,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }

  const pristine = stash[name] as (...args: unknown[]) => unknown;

  // `original` — not `pristine` — is what the wrapper chains onto. Each patch
  // wraps the previous one, which is what makes plugins composable.
  const patched = function (this: unknown, ...args: unknown[]) {
    return wrapper(original, this, args);
  };

  Object.defineProperty(patched, 'name', { value: String(name), configurable: true });
  (target as AnyRecord)[name] = patched;

  // Undo restores the true pristine, which unwinds the *whole* chain on that
  // method — so undoing an inner patch first still lands on the original. The
  // flag makes each handle idempotent, so a double undo (a superseded handle
  // run again) is a no-op rather than a second write.
  let undone = false;
  return {
    applied: true,
    undo: () => {
      if (undone) return;
      undone = true;
      (target as AnyRecord)[name] = pristine;
    },
  };
}

/** Patch many methods as one unit. */
export function patchAll<T extends object>(
  target: T,
  wrappers: Partial<Record<keyof T & string, Wrapper<any>>>,
): Patch<T>[] {
  const undoers: Array<() => void> = [];
  const applied: Array<Patch<T>> = [];

  for (const [name, wrapper] of Object.entries(wrappers)) {
    if (!wrapper) continue;
    const p = patch(target, name as keyof T & string, wrapper as Wrapper<any>);
    applied.push(p);
    if (p.applied) undoers.push(() => p.undo());
  }

  // One disposer restores every method this call touched.
  return [
    {
      applied: applied.some((p) => p.applied),
      undo: () => {
        for (const undo of undoers) undo();
      },
    },
    ...applied.slice(1),
  ];
}

/**
 * Event listeners registered by a plugin, collected so they can be detached.
 * Baileys' `.ev` is a small emitter with `off`, so this stays simple.
 */
export interface EventHandle {
  off(): void;
}

export function listen(
  ev: { on(event: string, fn: (...args: any[]) => void): void; off(event: string, fn: (...args: any[]) => void): void },
  event: string,
  fn: (...args: any[]) => void,
): EventHandle {
  ev.on(event, fn);
  return {
    off: () => {
      try {
        ev.off(event, fn);
      } catch {
        /* emitter may already be torn down */
      }
    },
  };
}

/** Collects disposers so plugins and the host share one unwind path. */
export class Disposables {
  #items: Array<() => void> = [];

  add(fn: () => void): void {
    this.#items.push(fn);
  }

  addPatch<T extends object>(p: Patch<T>): void {
    if (p.applied) this.add(() => p.undo());
  }

  addEvent(h: EventHandle): void {
    this.add(() => h.off());
  }

  get size(): number {
    return this.#items.length;
  }

  /**
   * Drop every pending disposer without running it. Used when a socket is being
   * rebuilt and the old one is already gone — running the old unwinds against a
   * dead socket is pointless work, and anything they left behind would leak into
   * the new build.
   */
  reset(): void {
    this.#items.length = 0;
  }

  dispose(): void {
    // Reverse order so later patches unwind before the ones they wrapped.
    while (this.#items.length) {
      const fn = this.#items.pop();
      try {
        fn?.();
      } catch {
        /* a failed disposer must not block the rest */
      }
    }
  }
}

/** Non-null assertion for values we know exist but TS can't narrow. */
export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`invariant: ${message}`);
}