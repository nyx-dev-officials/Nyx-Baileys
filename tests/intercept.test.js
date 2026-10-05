/**
 * Runtime interception.
 *
 * This file exists because `src/core/intercept.ts` had a real, silent bug: it
 * handed the *pristine* original to every wrapper instead of the *current*
 * implementation, so plugin N never ran while still looking attached. Every
 * stacking test here is a regression test for that.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Disposables,
  invariant,
  listen,
  patch,
  patchAll,
} from '../dist/core/intercept.js';

/** Build a socket-ish object with one method that reports what it is called with. */
function host(original) {
  return {
    tag: 'socket',
    sendMessage: original ?? function (a, b, c) {
      return { from: this?.tag, args: [a, b, c] };
    },
  };
}

test('two patches compose to B(A(original)) — the stacking regression', () => {
  const target = host(function sendMessage() {
    return 'original';
  });

  const a = patch(target, 'sendMessage', (original, self, args) => `A(${Reflect.apply(original, self, args)})`);
  const b = patch(target, 'sendMessage', (original, self, args) => `B(${Reflect.apply(original, self, args)})`);

  assert.equal(a.applied, true);
  assert.equal(b.applied, true);
  assert.equal(target.sendMessage(), 'B(A(original))');
});

test('three patches compose in application order, outermost last', () => {
  const target = host(function sendMessage() {
    return 'original';
  });

  patch(target, 'sendMessage', (o, s, a) => `A(${Reflect.apply(o, s, a)})`);
  patch(target, 'sendMessage', (o, s, a) => `B(${Reflect.apply(o, s, a)})`);
  patch(target, 'sendMessage', (o, s, a) => `C(${Reflect.apply(o, s, a)})`);

  assert.equal(target.sendMessage(), 'C(B(A(original)))');
});

test('each wrapper receives the implementation in place at that moment, not the pristine one', () => {
  const target = host(function sendMessage() {
    return 'original';
  });

  const seen = [];
  patch(target, 'sendMessage', (original, self, args) => {
    seen.push(original);
    return Reflect.apply(original, self, args);
  });
  const second = patch(target, 'sendMessage', (original) => {
    seen.push(original);
    return Reflect.apply(original, null, []);
  });

  target.sendMessage();
  assert.equal(seen.length, 2);
  assert.equal(seen[0].name, 'sendMessage');
  // The second wrapper's `original` is the first wrapper, not the base method.
  assert.notEqual(seen[1], seen[0]);
  const firstWrapper = seen[1];
  assert.equal(typeof firstWrapper, 'function');
  assert.equal(second.applied, true);
});

test('dispose() restores the true original, not a wrapper', () => {
  const original = function sendMessage() {
    return 'original';
  };
  const target = host(original);
  const disposables = new Disposables();

  disposables.addPatch(
    patch(target, 'sendMessage', (o, s, a) => `A(${Reflect.apply(o, s, a)})`),
  );
  disposables.addPatch(
    patch(target, 'sendMessage', (o, s, a) => `B(${Reflect.apply(o, s, a)})`),
  );

  assert.notEqual(target.sendMessage, original);
  assert.equal(target.sendMessage(), 'B(A(original))');
  assert.equal(disposables.size, 2);

  disposables.dispose();

  // Identity, not just behaviour: a wrapper would still be in place.
  assert.equal(target.sendMessage, original);
  assert.equal(target.sendMessage(), 'original');
  assert.equal(disposables.size, 0);
});

test('undo() out of order still lands on the pristine original', () => {
  const original = function sendMessage() {
    return 'original';
  };
  const target = host(original);

  const a = patch(target, 'sendMessage', (o, s, x) => `A(${Reflect.apply(o, s, x)})`);
  const b = patch(target, 'sendMessage', (o, s, x) => `B(${Reflect.apply(o, s, x)})`);

  a.undo();
  assert.equal(target.sendMessage, original, 'undoing the inner patch unwinds the chain');
  b.undo();
  assert.equal(target.sendMessage, original, 'a second undo is idempotent');
  assert.equal(target.sendMessage(), 'original');
});

test('patching a non-existent method reports applied === false and throws nothing', () => {
  const target = {};
  let handle;

  assert.doesNotThrow(() => {
    handle = patch(target, 'notThere', () => 'never');
  });

  assert.equal(handle.applied, false);
  assert.deepEqual(Object.keys(target), [], 'nothing was written onto the target');
  assert.equal(Object.getOwnPropertySymbols(target).length, 0, 'no pristine stash was left behind');
  assert.doesNotThrow(() => handle.undo());
  assert.deepEqual(Object.keys(target), []);
});

test('patching a non-function property is also a no-op with applied === false', () => {
  const target = { port: 443 };
  const handle = patch(target, 'port', () => 'nope');

  assert.equal(handle.applied, false);
  assert.equal(target.port, 443, 'the existing value is untouched');
  assert.doesNotThrow(() => handle.undo());
  assert.equal(target.port, 443);
});

test('the wrapper receives `this` and every argument intact', () => {
  const target = host(function sendMessage(a, b, c) {
    return { from: this.tag, seen: [a, b, c] };
  });
  const third = { three: 3 };
  const extra = { linkPreview: true };

  let captured = null;
  patch(target, 'sendMessage', (original, self, args) => {
    captured = { original, self, args };
    return Reflect.apply(original, self, args);
  });

  const result = target.sendMessage('jid@s.whatsapp.net', { text: 'hi' }, extra);

  assert.equal(captured.self, target, '`this` is the patched object');
  assert.ok(Array.isArray(captured.args));
  assert.equal(captured.args.length, 3);
  assert.equal(captured.args[0], 'jid@s.whatsapp.net');
  assert.deepEqual(captured.args[1], { text: 'hi' });
  assert.equal(captured.args[2], extra, 'the extra options object keeps its identity');
  assert.equal(typeof captured.original, 'function');

  // ...and `this` survives the hop through the wrapper.
  assert.equal(result.from, 'socket');
  assert.equal(result.seen[2], extra);
});

test('the patched function keeps the original method name', () => {
  const target = host(function sendMessage() {});
  patch(target, 'sendMessage', (o, s, a) => Reflect.apply(o, s, a));

  assert.equal(target.sendMessage.name, 'sendMessage');
});

test('repeated apply/undo cycles do not nest wrappers indefinitely', () => {
  const base = function sendMessage() {
    return 'original';
  };
  const target = host(base);

  let depth = 0;
  let maxDepth = 0;
  const probe = (original, self, args) => {
    depth += 1;
    maxDepth = Math.max(maxDepth, depth);
    try {
      return Reflect.apply(original, self, args);
    } finally {
      depth -= 1;
    }
  };

  for (let i = 0; i < 500; i += 1) {
    const handle = patch(target, 'sendMessage', probe);
    assert.equal(handle.applied, true);
    handle.undo();
    assert.equal(target.sendMessage, base, `cycle ${i} left a wrapper behind`);
  }

  assert.equal(target.sendMessage(), 'original');
  assert.equal(maxDepth, 0, 'nothing should have run during the cycles');

  // One live patch after 500 cycles must be a single frame, not 501.
  const handle = patch(target, 'sendMessage', probe);
  target.sendMessage();
  assert.equal(maxDepth, 1);
  handle.undo();
  assert.equal(target.sendMessage, base);
});

test('many patches then reverse-order undo all reach the pristine original', () => {
  const base = function sendMessage() {
    return 'original';
  };
  const target = host(base);

  const handles = [];
  for (let i = 0; i < 25; i += 1) {
    handles.push(
      patch(target, 'sendMessage', (o, s, a) => `${i}(${Reflect.apply(o, s, a)})`),
    );
  }
  // 25 wrappers deep, applied outermost-last.
  let expected = 'original';
  for (let i = 0; i < 25; i += 1) expected = `${i}(${expected})`;
  assert.equal(target.sendMessage(), expected);

  for (let i = handles.length - 1; i >= 0; i -= 1) handles[i].undo();
  assert.equal(target.sendMessage, base);
});

test('patchAll composes every wrapper it is given', () => {
  const target = {
    sendMessage() {
      return 'orig-send';
    },
    relayMessage() {
      return 'orig-relay';
    },
  };

  const patches = patchAll(target, {
    sendMessage: (o, s, a) => `A(${Reflect.apply(o, s, a)})`,
    relayMessage: (o, s, a) => `B(${Reflect.apply(o, s, a)})`,
  });

  assert.equal(target.sendMessage(), 'A(orig-send)');
  assert.equal(target.relayMessage(), 'B(orig-relay)');
  assert.equal(patches.length, 2);
  assert.equal(patches[0].applied, true);
});

/*
 * ---------------------------------------------------------------------------
 * KNOWN BUG — src/core/intercept.ts:57-68 (manifesting at :82)
 *
 * `patch()` writes the pristine stash only on the *first* patch of a given
 * target, and only for that one method name:
 *
 *     if (!(stashKey in holder)) holder[stashKey] = { [name]: original };
 *     const pristine = holder[stashKey][name];   // undefined for every method
 *                                                // patched after the first
 *
 * So the first method patched on an object is restored correctly and every
 * later method is restored as `undefined` — the method is destroyed rather
 * than reinstated.
 *
 * Not hypothetical: `sessionRepair` and `antiSpam` each patch BOTH
 * `sendMessage` AND `relayMessage` on the same socket, and
 * `NyxBaileys.#rebuild()` calls `#disposables.dispose()` before reconnecting
 * (src/nyxBaileys.ts:141). After a rebuild the old socket has no
 * `relayMessage` at all, so `sock.relayMessage(...)` throws
 * "sock.relayMessage is not a function".
 *
 * These assertions are the CORRECT behaviour, so they fail today. They are
 * left failing on purpose — do not weaken them to match current output.
 * ---------------------------------------------------------------------------
 */
test('BUG: undoing a second method on the same target restores the true original', () => {
  const originalSend = function sendMessage() {
    return 'orig-send';
  };
  const originalRelay = function relayMessage() {
    return 'orig-relay';
  };
  const target = { sendMessage: originalSend, relayMessage: originalRelay };

  const first = patch(target, 'sendMessage', (o, s, a) => `A(${Reflect.apply(o, s, a)})`);
  const second = patch(target, 'relayMessage', (o, s, a) => `B(${Reflect.apply(o, s, a)})`);

  // Composition works for both — the bug is only in the undo direction.
  assert.equal(first.applied, true);
  assert.equal(second.applied, true);
  assert.equal(target.sendMessage(), 'A(orig-send)');
  assert.equal(target.relayMessage(), 'B(orig-relay)');

  second.undo();
  assert.equal(
    target.relayMessage,
    originalRelay,
    'relayMessage must be the pristine function, not undefined',
  );
  assert.equal(target.relayMessage(), 'orig-relay');

  first.undo();
  assert.equal(target.sendMessage, originalSend);
});

/*
 * ---------------------------------------------------------------------------
 * KNOWN BUG — same root cause, seen through the dispose path
 * `NyxBaileys.dispose()` / `#rebuild()` actually uses.
 * ---------------------------------------------------------------------------
 */
test('BUG: Disposables.dispose() restores every patched method, not just the first', () => {
  const originalSend = function sendMessage() {
    return 'orig-send';
  };
  const originalRelay = function relayMessage() {
    return 'orig-relay';
  };
  const target = { sendMessage: originalSend, relayMessage: originalRelay };

  const disposables = new Disposables();
  disposables.addPatch(
    patch(target, 'sendMessage', (o, s, a) => Reflect.apply(o, s, a)),
  );
  disposables.addPatch(
    patch(target, 'relayMessage', (o, s, a) => Reflect.apply(o, s, a)),
  );

  disposables.dispose();

  assert.equal(target.sendMessage, originalSend);
  assert.equal(
    target.relayMessage,
    originalRelay,
    'relayMessage was left undefined instead of restored',
  );
  assert.equal(target.relayMessage(), 'orig-relay');
});

/*
 * ---------------------------------------------------------------------------
 * Regression — src/core/intercept.ts patchAll
 *
 * The combined handle used to be element 0 of the returned array, so
 * `patches.length` was one more than the number of methods patched and
 * `patches[0].undo()` meant "undo everything" while `patches[1].undo()` meant
 * "undo one method". One method, two meanings, decided by position.
 *
 * Undo-everything is a genuine capability and is preserved as `undoAll` on the
 * array. The array itself is now exactly the patches that applied.
 * ---------------------------------------------------------------------------
 */
test('patchAll returns exactly the patches that applied', () => {
  const target = {
    sendMessage() {
      return 'orig-send';
    },
    relayMessage() {
      return 'orig-relay';
    },
  };
  const originalSend = target.sendMessage;
  const originalRelay = target.relayMessage;

  const patches = patchAll(target, {
    sendMessage: (o, s, a) => `A(${Reflect.apply(o, s, a)})`,
    relayMessage: (o, s, a) => `B(${Reflect.apply(o, s, a)})`,
  });

  assert.equal(patches.length, 2, 'length must equal the number of methods patched');
  patches.undoAll();

  assert.equal(target.sendMessage, originalSend);
  assert.equal(target.relayMessage, originalRelay);
  assert.equal(target.relayMessage(), 'orig-relay');
});

test('patchAll length is not inflated by an absent method', () => {
  const target = {
    sendMessage() {
      return 'orig';
    },
  };
  const patches = patchAll(target, {
    sendMessage: (o, s, a) => `A(${Reflect.apply(o, s, a)})`,
    ghostMethod: () => 'never',
  });

  assert.equal(patches.length, 1, 'an absent method must not add an element');
  assert.equal(patches.applied, true);
  patches[0].undo();
  assert.equal(target.sendMessage(), 'orig');
});

test('patchAll reports applied: false when nothing applied', () => {
  const patches = patchAll({}, { ghost: () => 'never' });
  assert.equal(patches.length, 0);
  assert.equal(patches.applied, false);
  assert.doesNotThrow(() => patches.undoAll(), 'undoAll on an empty patch set must be safe');
});

test('Disposables unwinds in reverse order and survives a throwing disposer', () => {
  const order = [];
  const d = new Disposables();
  d.add(() => order.push(1));
  d.add(() => {
    order.push(2);
    throw new Error('boom');
  });
  d.add(() => order.push(3));

  assert.equal(d.size, 3);
  assert.doesNotThrow(() => d.dispose());
  assert.deepEqual(order, [3, 2, 1], 'later registrations unwind first, and a throw does not stop the rest');
  assert.equal(d.size, 0);
});

test('Disposables.addEvent detaches the listener', () => {
  const calls = [];
  const ev = {
    on: (event, fn) => calls.push(['on', event, fn]),
    off: (event, fn) => calls.push(['off', event, fn]),
  };

  const d = new Disposables();
  const handle = listen(ev, 'messages.upsert', () => {});
  d.addEvent(handle);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'on');
  assert.equal(calls[0][1], 'messages.upsert');

  d.dispose();
  assert.equal(calls.length, 2);
  assert.equal(calls[1][0], 'off');
  assert.equal(calls[1][1], 'messages.upsert');
});

test('EventHandle.off survives an emitter that has already been torn down', () => {
  let calls = 0;
  const ev = {
    on: () => {
      calls += 1;
    },
    off: () => {
      throw new Error('emitter gone');
    },
  };

  const handle = listen(ev, 'connection.update', () => {});
  assert.doesNotThrow(() => handle.off());
  assert.equal(calls, 1);
});

test('invariant throws with its message and passes on truthy input', () => {
  assert.throws(() => invariant(false, 'socket missing'), /^Error: invariant: socket missing$/);
  assert.throws(
    () => invariant(undefined, 'no socket'),
    /^Error: invariant: no socket$/,
    'it is a truthiness guard, so undefined fails as well',
  );
  assert.doesNotThrow(() => invariant(true, 'never thrown'));
  assert.doesNotThrow(() => invariant({}, 'an object is truthy'));
  assert.doesNotThrow(() => invariant('sock', 'a non-empty string is truthy'));
});