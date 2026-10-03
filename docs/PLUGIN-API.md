# PLUGIN API

How to write, attach, order and dispose a Nyx-Baileys plugin, and what the
eleven built-in plugins add to the socket.

Source of truth: `src/utils/types.ts:16-38` (the interface),
`src/nyxBaileys.ts:164-190` (how it is invoked),
`src/core/intercept.ts` (the primitive everything is built on).

---

## 1. The contract

```ts
export interface Plugin {
  readonly name: string;
  /** Lower runs first. Keep patches ordered and composable. */
  readonly order: number;
  apply(ctx: PluginContext): void | Promise<void>;
}

export interface PluginContext {
  readonly sock: CoreSocket;          // the live upstream socket
  readonly state: SessionStore;       // persisted auth state + sidecar data
  readonly options: SuperOptions;     // the host's options, read-only
  readonly log: Logger;               // already scoped to 'super'
  onDispose(fn: () => void): void;    // register teardown
}
```

`src/utils/types.ts:23-31`. Five fields, all of them useful, none of them a
lifecycle callback you have to remember to fire.

`apply` may be sync or async — `decorate()` awaits it
(`src/nyxBaileys.ts:179`). Returning a promise that rejects does **not** take
the socket down: `decorate()` wraps every call in `try`/`catch`, logs
`plugin failed to apply` with the plugin name and the error message, and moves on
(`:182-188`). A plugin that throws costs you that plugin and nothing else, which
is the behaviour you want when a dependency's method has been renamed upstream.

`ctx.log` arrives already scoped to `super`. Call `ctx.log.child('mine')` for
your own lines, as every built-in plugin does.

### What a plugin must not do

- **Do not return a new socket.** The return value of `apply` is ignored.
  Modify `ctx.sock` in place, or you are not a plugin.
- **Do not touch `node_modules`.** Nothing in this framework does, and the whole
  design rests on it.
- **Do not add a `connection.update` listener.** Use
  `NyxBaileys.onConnection()` (`src/nyxBaileys.ts:229-232`) so there is one
  owner of that event. `#wireConnection()` (`:193-220`) is documented as
  precisely that, and the demo breaks the rule at `src/index.ts:301-306`.
- **Do not use `this`.** `apply` is a closure over your own state. The socket
  methods you patch receive their own `self`, but your plugin object is not
  rebound.

---

## 2. Registering

### Add to the default chain

```ts
import { NyxBaileys, approvalQueue } from 'nyx-baileys';

const client = new NyxBaileys({ sessionDir: './session' });
client.registerPlugin(approvalQueue({ approvers: ['15551234567@s.whatsapp.net'] }));
await client.connect();
```

`registerPlugin()` (`src/nyxBaileys.ts:76-80`) appends to the default chain and
re-sorts by `order`:

```ts
const all = [...this.plugins(), plugin].sort((a, b) => a.order - b.order);
Object.defineProperty(this, 'plugins', { value: () => all, configurable: true });
```

Note what that does: it redefines the instance's own `plugins` method rather than
mutating a shared array, so each `NyxBaileys` instance gets its own chain. Two
instances in one process cannot contaminate each other's plugin lists.

If you register the *same plugin name* twice, both are kept and both apply. Give
distinct names, or drop the built-in you are replacing with
`registerPlugin` + a subclass overriding `plugins()`.

### Replace the chain entirely

`plugins()` is `protected` (`src/nyxBaileys.ts:56`). Override it:

```ts
class Bare extends NyxBaileys {
  protected plugins() {
    return [stealth(), lidRouter(), myPlugin()];
  }
}
```

### Order values in use

| Order | Plugin |
|---|---|
| 10 | `stealth` |
| 20 | `lidRouter` |
| 30 | `mediaStreamer` |
| 40 | `albumHandler` |
| 50 | `memoryGc` |
| 60 | `groupGuard` |
| 65 | `sessionRepair` |
| 70 | `autoReconnect` |
| 80 | `antiSpam` |
| 90 | `flowEngine` |
| 100 | `warmup` |

Slots are spaced by ten, which leaves room. The ordering rule in one line:

> **Low `order` = earlier in the chain = outermost wrapper = runs first outbound,
> last inbound.**

Pick a number in the gap you need. Concretely:

| You want to… | Use an order | Because |
|---|---|---|
| Transform a payload before anything else | below 65 | you want to wrap `sendMessage` outside `session-repair` |
| Act after the message is already repaired | 66–79 | between `session-repair` and `anti-spam` |
| Observe or rate-limit sends | 81–89 | you want to run inside the pacing queue's outer wrapper |
| Read state an earlier plugin attaches | above that plugin's order | e.g. `warmup` at 100 reads `__antispam` from 80 |
| Have the final say on a send | 100+ | outermost, sees everything |

The comments in `src/nyxBaileys.ts:64-65` are stale — they claim 70 and 75 for
`sessionRepair` and `autoReconnect`, which actually declare 65 and 70. Read the
`order` field, not the comment. The chain is correctly sorted regardless.

---

## 3. Attaching helpers: `Object.defineProperty` with `enumerable: false`

Anything that is not a socket method gets attached as a non-enumerable property.
This is the framework's answer to a real constraint: `sock` must stay a
`WASocket` in type, so new capabilities cannot be declared on it. They are
attached at runtime, non-enumerably, and consumed through an explicit cast.

```ts
Object.defineProperty(ctx.sock, 'resolveJid', {
  value: resolve,
  enumerable: false,      // invisible to Object.keys / spread / JSON.stringify
  configurable: true,     // a later plugin may redefine it
});
```

Every built-in helper uses exactly this shape. `enumerable: false` is what keeps
it from leaking: an enumerable property on the socket would appear in every
`{...sock}` spread, every `JSON.stringify(sock)` and every log line that dumps the
object. `configurable: true` is what lets a later plugin at a higher `order`
override an earlier one's helper, rather than throwing.

For a computed value, use a getter — `session-repair` does this for its counter
(`src/plugins/session-repair.ts:161-165`):

```ts
Object.defineProperty(ctx.sock, '__repairStats', {
  get: () => ({ repairs }),
  enumerable: false,
  configurable: true,
});
```

Because the type of `sock` is unchanged, call sites cast once:

```ts
const store = (sock as unknown as { store?: { stats(): unknown } }).store;
console.log(store?.stats());
```

That is the pattern at `src/index.ts:285`. It is the deliberate trade: no `any`
in the socket's declared type, and one obvious cast at the boundary rather than
scattered through your call sites.

### Conventions worth following

- Prefix introspection helpers with `__` — `__identity`, `__antispam`,
  `__repairStats`, `__normalise`, `__requestReconnect`. Callers can tell "part of
  the framework's surface" from "a Baileys method" at a glance.
- Keep helper names stable. They are the framework's public API; renaming one is
  a breaking change for every consumer.
- Anything you put on the socket survives until `dispose()`. If it holds memory,
  register a disposer.

---

## 4. Disposal

`ctx.onDispose(fn)` (`src/nyxBaileys.ts:174`) pushes onto the instance's
`Disposables` list. Two things dispose it: `NyxBaileys.dispose()` (`:274-284`)
and `#rebuild()` (`:141`), which is what makes reconnect non-accumulating.

`Disposables.dispose()` (`src/core/intercept.ts:159-169`) pops from the **end**,
so later patches unwind before the ones they wrapped, and `try`/`catch`es each
one so a throwing disposer cannot strand the rest.

### The four things to register

```ts
apply(ctx) {
  const { sock, log } = ctx;
  const scoped = log.child('mine');

  // 1. method patches — only if they applied
  const handle = patch(sock as never, 'sendMessage', myWrapper);
  if (handle.applied) ctx.onDispose(() => handle.undo());

  // 2. event listeners — use listen(), which tolerates a torn-down emitter
  ctx.onDispose(listen(sock.ev, 'messages.upsert', onUpsert).off);

  // 3. timers — clearInterval, and unref so they never hold the process open
  const timer = setInterval(sweep, 60_000);
  timer.unref?.();
  ctx.onDispose(() => clearInterval(timer));

  // 4. closures holding state — if you own one
  ctx.onDispose(() => { cache.clear(); });
}
```

Both `patch()` and `listen()` are exported from the package root
(`src/index.ts:42`). `Disposables.addPatch()` / `.addEvent()`
(`intercept.ts:147-153`) accept them directly if you are building your own
collection.

**On `patch().applied`:** always check it. `patch` returns
`{ applied: false }` and changes nothing when the method is absent
(`intercept.ts:50-52`), so an unconditional `undo()` restores nothing and a
conditional one is correct. `antiSpam` logs a warning naming the missing method
(`antiSpam.ts:109-113`) — do the same, because a silently inert plugin is the
worst outcome.

**Known limitation.** The pristine stash in `patch()` is created once per target
object and holds only the first method patched on it
(`intercept.ts:57-64`), so `undo()` for a *second* method on the same socket
assigns `undefined` rather than the original. Reproduce it with
`patchAll(sock, { a, b })` then `result[0].undo()`. Until that is fixed, prefer
registering one `onDispose` per patch and prefer `patch` over `patchAll` for
multi-method targets. See `ARCHITECTURE.md` §2.

**Listeners you cannot unregister.** Some built-in plugins register listeners
directly on `sock.ev` and leave them, on the reasoning that the listener dies with
the socket: `stealth` (`stealth.ts:53-59`, with a comment saying so),
`album` (`album.ts:90`), `memory` (`memory.ts:89`), `group` (`group.ts:57`),
`flow` (`flow.ts:238`), `reconnect` (`reconnect.ts:102`). That is correct on a
full rebuild, where the socket object is discarded. If your plugin attaches
something that outlives the socket, it must own the disposer.

---

## 5. Worked example: an approval queue

A complete plugin that holds outbound messages for a human to approve. It patches
`sendMessage`, parks the promise, emits an event, and resumes or rejects on
command.

```ts
import { patch } from 'nyx-baileys';
import type { Plugin, PluginContext } from 'nyx-baileys';

interface Pending {
  id: string;
  jid: string;
  content: unknown;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  at: number;
}

export interface ApprovalQueueOptions {
  /** Who may approve. Empty means anybody who can call `approve()`. */
  approvers?: readonly string[];
  /** Park a message for longer than this and reject it. Default 15 min. */
  timeoutMs?: number;
}

export function approvalQueue(options: ApprovalQueueOptions = {}): Plugin {
  const approvers = new Set(options.approvers ?? []);
  const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;

  return {
    name: 'approval-queue',
    // After session-repair (65) so we queue an already-normalised payload;
    // before warmup (100) but after anti-spam (80) so queued messages are
    // still paced on the way out.
    order: 85,

    apply(ctx: PluginContext) {
      const log = ctx.log.child('approval');
      const pending = new Map<string, Pending>();

      // resolveJid is attached by lid-router at order 20 — we are at 85, so it
      // is guaranteed present. Reach it through a cast: the socket's declared
      // type is still WASocket.
      const sock = ctx.sock as unknown as {
        resolveJid?: (t: string) => Promise<string>;
      };

      const settle = (id: string, err?: Error): Pending | undefined => {
        const item = pending.get(id);
        if (!item) return undefined;
        clearTimeout(item.timer);
        pending.delete(id);
        if (err) item.reject(err);
        else item.resolve({ key: { id: `approved_${id}` } });
        return item;
      };

      // 1 — patch the outbound path
      const handle = patch(ctx.sock as never, 'sendMessage', ((
        original: (...args: unknown[]) => unknown,
        self: unknown,
        args: unknown[],
      ): Promise<unknown> => {
        const rawJid = String(args[0] ?? '');
        const content = args[1];

        // Anything the host itself sends is not gated: a queued message that
        // waited 15 minutes should still be sendable by an operator.
        if (!approvers.size || approvers.has(rawJid)) {
          return Reflect.apply(original, self, args) as Promise<unknown>;
        }

        const id = `aq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            log.warn('approval timed out', { id, jid: rawJid });
            settle(id, new Error(`approval-queue: ${id} timed out`));
          }, timeoutMs);
          timer.unref?.(); // never hold the process open for a pending approval

          pending.set(id, { id, jid: rawJid, content, resolve, reject, at: Date.now(), timer });

          // Re-emit as a normalised event rather than a second emitter name.
          ctx.sock.ev.emit('nyx.approval' as never, {
            id, jid: rawJid, content, at: Date.now(),
          } as never);
        });
      }) as never);

      if (!handle.applied) {
        log.warn('sendMessage missing; approval queue not attached');
      } else {
        ctx.onDispose(() => handle.undo());
      }

      // 2 — attach the control surface, non-enumerably
      Object.defineProperty(ctx.sock, 'approvals', {
        value: {
          list: () => [...pending.values()].map(({ timer, ...rest }) => rest),
          approve: (id: string) => {
            const item = settle(id);
            if (!item) return Promise.reject(new Error(`approval-queue: unknown id ${id}`));
            // Send through the pristine method, bypassing our own gate.
            const target = item.jid;
            return Promise.resolve(
              Reflect.apply(
                (ctx.sock as never as Record<string, (...a: unknown[]) => unknown>)['sendMessage'],
                ctx.sock,
                [target, item.content],
              ),
            );
          },
          reject: (id: string, reason = 'rejected by operator') => {
            if (!settle(id, new Error(reason))) {
              return Promise.reject(new Error(`approval-queue: unknown id ${id}`));
            }
            return Promise.resolve();
          },
          size: () => pending.size,
        },
        enumerable: false,
        configurable: true,
      });

      // 3 — register disposal
      ctx.onDispose(() => {
        for (const [, item] of pending) {
          clearTimeout(item.timer);
          item.reject(new Error('approval-queue: disposed'));
        }
        pending.clear();
      });

      log.debug('attached', { approvers: approvers.size, timeoutMs });

      // 4 — nothing else to do; the plugin is inert until someone sends
      void sock;
    },
  };
}
```

Using it:

```ts
import { createNyxBaileys, approvalQueue } from './approval-queue.js';

const client = createNyxBaileys({ sessionDir: './session' });
client.registerPlugin(approvalQueue({ approvers: ['ops@corp.example'] }));

const sock = await client.connect();

const queue = (sock as unknown as {
  approvals: { list(): unknown[]; approve(id: string): Promise<unknown> };
}).approvals;

// Operator side: every parked message is visible, nothing is sent silently.
sock.ev.on('nyx.approval', (item) => {
  console.log('needs approval:', item);
});
```

### What the example demonstrates

| Concern | How it is handled |
|---|---|
| **Order** | `85` — after `session-repair` (65), after `anti-spam` (80), before `warmup` (100) |
| **Chaining** | `Reflect.apply(original, self, args)` — calls the *current* implementation, so `anti-spam`'s pacing and `session-repair`'s normalisation both still run |
| **`this`** | `self` is forwarded, never rebound |
| **`applied` check** | warns by name if `sendMessage` is absent |
| **Typed helper** | `Object.defineProperty(..., { enumerable: false, configurable: true })` + one cast at the call site |
| **Disposal** | timer cleared, pending promises rejected, cache emptied |
| **Timer hygiene** | `timer.unref?.()` so a pending approval cannot keep the process alive |
| **Read-before-depend** | `resolveJid` exists because order 20 < 85 |

---

## 6. Writing a flow plugin instead of a patcher

Most conversational behaviour does not need `patch` at all. The flow engine at
order 90 is a state machine you can drive by registering flows:

```ts
import { flowEngine } from 'nyx-baileys';
import type { Flow } from 'nyx-baileys';

const survey: Flow = {
  id: 'survey',
  entry: 'start',
  capture: true,
  ttlMs: 10 * 60 * 1000,
  steps: [
    {
      name: 'start',
      match: /^(feedback|survey)$/i,
      async run(c) {
        await c.reply('Rate us 1-5.');
        c.goto('await');          // hand off; state survives in c.state
      },
    },
    {
      name: 'await',
      async run(c) {
        if (/^[1-5]$/.test(c.text.trim())) {
          c.state.score = c.text.trim();
          await c.reply(`Noted: ${c.state.score}.`);
          c.end();
          return;
        }
        await c.reply('Just the digit, 1 to 5.');
      },
    },
  ],
};

client.registerPlugin(flowEngine([survey]));
```

`FlowContext` (`src/plugins/flow.ts:18-37`) gives a step `msg`, `jid`, `text`,
`selection`, `flowResponse`, a chat-bound `reply()`, `goto()`, `end()`, and
`state` — a scratch object that persists across steps within one flow. Steps never
touch the socket; `reply` is already bound to the chat and already paced, because
it goes through `ctx.sock.sendMessage` and therefore through the `anti-spam` queue.

Control the registry at runtime via `sock.flows`
(`src/plugins/flow.ts:287-300`): `add`, `remove`, `list`, `active(jid)`,
`reset(jid?)`.

One caveat from `src/plugins/flow.ts:14-16`: flow state is per-chat and in memory,
so a restart drops in-flight conversations. That is right for short flows; flows
that must survive a restart persist into `ctx.state` themselves. And note that
`goto()` is not yet guarded against a flow that ended or expired between the call
and the dispatch (`flow.ts:189-196`) — `VERIFICATION.md` D4, still open. If you
call `ctx.end()` and then `ctx.goto(...)`, the `goto` is a silent no-op.

---

## 7. Socket helpers, by plugin

Everything the eleven plugins attach. Non-enumerably, per §3.

### `stealth` — order 10

| Helper | Type | What it is |
|---|---|---|
| `__identity` | `{ browser: readonly string[]; userAgent: string }` | The pinned fingerprint and the UA derived from it |

Also drives presence from real connection state (`available` on `open`,
`unavailable` on `close`) — it does not fabricate presence. See
`DESIGN-NOTES.md` §2–§3.

### `lid-router` — order 20

| Helper | Type | What it is |
|---|---|---|
| `resolveJid(target)` | `(t: string) => Promise<string>` | Canonical JID for sending; resolves `@lid` → `@s.whatsapp.net` via `onWhatsApp`, TTL-cached. Non-JID strings pass through untouched |
| `resolvePn(pn)` | `(t: string) => Promise<string>` | Reverse lookup, for lid-based group fan-out |
| `lidCache` | `Map<string, JidCacheEntry>` | The live cache, for inspection or manual invalidation |

Cache: 6-hour TTL, 5 000 entries, oldest evicted on overflow
(`src/plugins/lid.ts:35-36`, `:46-52`). A failed lookup falls back to the supplied
JID rather than throwing.

### `media-stream` — order 30

| Helper | Type | What it is |
|---|---|---|
| `downloadMedia(msg, opts?)` | `(m: WAMessage, o?: { maxBytes?: number }) => Promise<DownloadResult>` | Guarded download. Returns `{ buffer, mime, fileName, bytes }`. Throws `MediaTooLargeError` with both numbers attached; throws on an empty decrypt rather than returning an empty buffer |
| `streamMedia(msg, write)` | `(m: WAMessage, w: (c: Buffer) => void \| Promise<void>) => Promise<DownloadResult>` | Decrypts once, then hands out 64 KB chunks |

`DownloadResult` and `MediaTooLargeError` are exported types. Defaults: 32 MiB
ceiling, 64 KB chunks (`media-stream.ts:51-52`). A sender-declared
`fileLength` above the ceiling is rejected *before* the RAM is spent
(`:84-87`) — untrusted input, so it can only reject early, never approve.

Honest limitation: `streamMedia` materialises the whole buffer and then slices it.
The peak is the full asset plus one chunk, not one chunk. The docstring says so
(`:100-103`). See `FEATURES.md` Tier 2.

### `album` — order 40

| Helper | Type | What it is |
|---|---|---|
| `albums` | `Map<string, Album>` | Keyed by parent message id. Bounded at 200, oldest evicted |
| `expandAlbum(album, index?)` | `(a: Album, i?: number) => Promise<{ buffer; mime; fileName }>` | Decrypt one item on demand. Throws rather than returning empty |
| `waitForAlbum(key, timeoutMs?)` | `(k: string, t?: number) => Promise<Album \| undefined>` | Resolves when the album completes, or on timeout |

`Album` is `{ key, jid, expected, items, completedAt? }`; `AlbumItem` is
`{ index, caption, message, kind? }`. Emits `nyx.album` on every change.

Two rc14 facts that make this work, both documented in `ARCHITECTURE.md` §5.4:
the parent carries counts only, and sibling linkage is
`contextInfo.messageAssociation` with `AssociationType.MEDIA_ALBUM` — there is no
`albumParentKey` field.

### `memory-gc` — order 50

| Helper | Type | What it is |
|---|---|---|
| `store` | object | See below |

`store` has `history` (`Map<jid, string[]>`), `media` (`Map<string, MediaBlob>`),
`statuses` (`number[]`), `put(key, buffer)`, `take(key)`, `stats()`, `sweep()`.
Defaults: 200 messages per chat, 100 statuses, 100 media blobs, 60 s interval
(`memory.ts:39-43`). `stats()` returns `{ chats, media, statuses, heapMb }`.

Two honest caveats. Media eviction at `memory.ts:73-79` currently removes the
blobs **holding** bytes and skips the already-empty ones — the inverse of what
its own comment says, and there is no refcount, so an in-flight download can lose
its entry (`VERIFICATION.md` D7, open). And `take()` deletes on read, so it is a
consume-once accessor, not a cache.

### `group-guard` — order 60

| Helper | Type | What it is |
|---|---|---|
| `groupAlerts` | `GroupAlert[]` | Bounded at 100. `{ groupId, kind, participants, at, detail }` |
| `groupAdmins` | `Map<string, Set<string>>` | Observed admin set per group |
| `nyx.groupAlert` | event | Emitted on every alert |

`kind` is `'mass-add'` (8+ joins inside 10 minutes by default) or
`'privilege-climb'`. **Read-only by design** — alerts are reported, never acted
on. The privilege-climb check is currently a counter, not a detector: `known`
counts promote events, so `known >= 3` means "three promotes seen", not "every
member is an admin" (`VERIFICATION.md` D6, open).

### `session-repair` — order 65

| Helper | Type | What it is |
|---|---|---|
| `__repairStats` | `{ repairs: number }` (getter) | Live count of repaired rows |
| `__normalise` | `(content: unknown) => unknown` | The normaliser, callable standalone |

Patches `sendMessage` and `relayMessage`. Two repairs: hoisting an interactive
node out of a wrapper (`viewOnceMessage`, `documentWithCaptionMessage`,
`editedMessage`, `ephemeralMessage`, `viewOnceMessageV2`,
`viewOnceMessageV2Extension`), and backfilling `optionName` on native-flow rows
by parsing `messageParamsJson`. A malformed `paramsJson` is left untouched.

### `reconnect` — order 70

| Helper | Type | What it is |
|---|---|---|
| `health()` | `() => HealthReport` | `{ level, since, pausedFor, signals }` |

`level` is `'low' | 'elevated' | 'paused'` at 0/3/10 accumulated bad signals
(`reconnect.ts:48-53`). Backoff is exponential with full jitter, doubling from
1 s to a 60 s ceiling, reset after 5 healthy minutes. The reason switch is
explicit: `loggedOut` and `multideviceMismatch` stop the loop rather than looping
forever, because both need a human with a phone. Also consumes
`sock.__requestReconnect`, which `NyxBaileys` defines at connect time — a host
that does not define it gets a logged warning and a socket left down.

### `anti-spam` — order 80

| Helper | Type | What it is |
|---|---|---|
| `__antispam` | `{ setPressure(n); stats(); reset() }` | Queue controls |

Patches `sendMessage` and `relayMessage` behind a serial queue. Gaps are
Box–Muller, clamped to ±2.5σ (`antiSpam.ts:46-52`) — a bounded distribution, not
`random(0, max)`, which clusters at zero. Defaults: 2 500 ms minimum gap, 4 000 ms
jitter, 20/minute ceiling, 500-message queue cap; over the cap, sends are
rejected rather than queued. `setPressure(n)` multiplies the gap (clamped to
`≥ 1`, so it can widen but never tighten — `warmup` depends on that).
`stats()` → `{ queued, sent, pressure }`.

Scope is outbound pacing only. It does not fabricate presence — see
`DESIGN-NOTES.md` §3 and the closing table.

### `flow` — order 90

| Helper | Type | What it is |
|---|---|---|
| `flows` | `{ add; remove; list; active(jid); reset(jid?) }` | Runtime registry |
| `nyx.album` etc. | — | (see `album`, order 40) |

`active(jid)` returns the current step name or `undefined`. See §6 for authoring.

### `warmup` — order 100

No socket helpers. It reads `warmupStartedAt` from `ctx.state`, computes
`rampFor(startedAt, days)` (8× → 1×, `1 + 7·(1-progress)²`, exported as
`rampFor`), and pushes it into `__antispam.setPressure`.

Two caveats: the ramp is evaluated **once per socket build**, never on an
interval, so a long-lived process holds its day-one multiplier for the socket's
life (`VERIFICATION.md` D14, open); and on the first run it only records
`warmupStartedAt` and returns, so the first session is not throttled.

### `metrics` — newer layer, not in the default chain

| Helper | Type | What it is |
|---|---|---|
| `metrics` | registry object | Counter / gauge / histogram with a hard cardinality ceiling |

Not registered by `plugins()` — add it with
`client.registerPlugin(metrics())`. `snapshot()` is a plain serialisable object.
The design point worth knowing: past the per-metric series ceiling, new label
combinations fold into a single `__other__` series and `droppedSeries` counts it,
because a registry that discards data without saying so is a lie
(`src/plugins/metrics.ts:11-21`). Do not label by `jid` without raising the
ceiling.

---

## 8. Quick checklist

- [ ] `name` is unique and kebab-case.
- [ ] `order` is in a gap, and you can state in one sentence why it sits there.
- [ ] `apply` is idempotent-safe: it will run once per socket build, and a build
      can be a reconnect.
- [ ] Patches use `patch()` and check `.applied`; the wrapper calls
      `original` via `Reflect.apply(original, self, args)`.
- [ ] Helpers are attached with `enumerable: false, configurable: true`.
- [ ] Timers are `unref()`'d.
- [ ] Every patch, listener, timer and owned closure has an `onDispose`.
- [ ] You did not add a `connection.update` listener.
- [ ] You did not mutate `ctx.options` or return a socket.
- [ ] Anything you print goes through the redactor if it could contain session
      material.
