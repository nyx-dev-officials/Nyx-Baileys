# ARCHITECTURE

Nyx-Baileys 0.2.0 · upstream `@whiskeysockets/baileys@7.0.0-rc14` · Node ≥ 20

Snapshot: 2026-10-03, 51 TypeScript files under `src/`, 21 plugin modules of
which 11 are in the default chain. Measured on the tree as it stood when this was
written; layers under concurrent development are marked where relevant.

---

## 1. The shape of the thing

Three layers, strictly one-directional:

```
  upstream Baileys          our decoration              our plugins
  ────────────────          ──────────────              ────────────
  makeWASocket()      →     patch() on the live    →    11 plugins, ordered,
  (untouched)                socket object                attached in `order`
        │                         │                            │
        └─────────────────────────┴────────────────────────────┘
                                  │
                    caller gets a real WASocket back
```

There is no fork, no vendored copy, and no edit to `node_modules`. That constraint
is the whole architectural premise, and it is enforced by construction rather
than by convention: `src/core/socket.ts:83-100` calls `makeWASocket()` and
returns its result, and every other file in `src/` receives that object and
modifies its methods at runtime.

The consequence worth stating plainly: **the object callers get back is a real
Baileys socket.** Its type is unchanged — `CoreSocket = WASocket`
(`src/utils/types.ts:13`). Every upstream API, every community extension, every
`proto` schema, and every `.d.ts` a consumer relies on still applies. What
changes is that a handful of its methods are now wrappers.

`src/utils/types.ts:5-11` records the rule the whole framework runs under:

> The one rule this framework holds: `sock` is always an upstream Baileys socket.
> We decorate it, we never replace its type. Anything that can't be expressed as
> a runtime wrapper lives behind an extension interface instead of an `any` cast.

That last clause is where the socket helpers come from (§4). Things that cannot be
methods on a socket without lying about its type — a media downloader, an album
registry, a metrics snapshot — are attached as extra properties via
`Object.defineProperty` with `enumerable: false`, which keeps them invisible to
`Object.keys`, spread and `JSON.stringify` while remaining fully typed at the
call site. See `PLUGIN-API.md` §3.

---

## 2. The interception model

`src/core/intercept.ts` is 175 lines and is the foundation everything else stands
on. One function matters:

```ts
export function patch<T extends object>(
  target: T,
  name: keyof T & string,
  wrapper: Wrapper<any>,
): Patch<T>
```

It replaces `target[name]` with a wrapper that receives **the implementation that
was in place at the moment of this patch**, and hands back an undo handle.

### Why it chains onto the *current* implementation

Read `src/core/intercept.ts:48` and `:72-74` together:

```ts
const original = (target as AnyRecord)[name];      // :48  — the CURRENT method
…
const patched = function (this: unknown, ...args: unknown[]) {
  return wrapper(original, this, args);            // :73  — chains onto it
};
```

`original` is read at patch time and captured. So applying A then B yields
`B(A(original))` — both plugins run. That is the property the entire composition
model depends on: `anti-spam` (order 80) and `session-repair` (order 65) both
wrap `sendMessage`, and neither silently replaces the other.

**This was a real bug, and the reason the comment at `intercept.ts:70-71` reads
like a warning.** The original implementation captured `pristine` — the
*stash* value — rather than the current method, and passed that to the wrapper.
The module docstring promised `B(A(original))`; the code delivered
`B(original)`. A second patch therefore discarded the first, and because each
patch still returned an undo handle, the accounting claimed a wrapper was live
when it was not. `VERIFICATION.md` D3 recorded this as a BLOCKER. It is fixed,
and verified:

```
patch A, then patch B on the same method  →  B[A[ORIGINAL(1)]]     both ran
```

### The pristine stash, and the bug still living in it

Separately from `original`, `patch` stashes a copy of the truly-pristine function
on a well-known symbol, `Symbol.for('nyx-baileys.pristine')`
(`src/core/intercept.ts:19`). `undo()` restores from the stash rather than
leaving a wrapper behind, so a full teardown returns the object to exactly what
`makeWASocket()` produced.

The stash is created **once per target object**:

```ts
if (!(stashKey in holder)) {                       // :57
  Object.defineProperty(holder, stashKey, {
    value: { [name]: original },                  // :59  — only THIS name
```

So the stash holds a pristine copy of only the **first** method patched on any
given object. Patch a second method on the same target and its `pristine` lookup
(`:66-68`) yields `undefined`; `undo()` then assigns `undefined` over a live
method. Verified directly:

```
patch a, then b  →  stash keys ["a"]   →  undo() leaves  a: function, b: undefined
patch b, then a  →  stash keys ["b"]   →  undo() leaves  a: undefined, b: function
```

The wrappers work. Only the teardown is wrong, and it fails quietly. This is
reproducible in the real chain — `session-repair` patches `sendMessage` and
`relayMessage`, so on `NyxBaileys.dispose()` the second of those two methods is
set to `undefined` rather than restored. (`anti-spam` used to gate the same pair;
it was narrowed to `sendMessage` alone, so it no longer reaches this path.) It is
latent rather than user-visible today only because a disposed socket is discarded
anyway, but `patchAll`'s aggregate undo is affected on any object:

```
patchAll(t, {a, b})  →  returns 2 handles, first is an aggregate
r[0].undo()           →  a restored, b set to undefined
```

`VERIFICATION.md` D11 noted the return shape (`intercept.ts:103-111` returns
`[aggregate, ...applied.slice(1)]`, where `applied[0]` is dropped and the
aggregate's `undo()` supersedes every other handle — easy to double-undo). The
stash scoping is the same defect seen from the other side, and it is the reason
`patchAll` is currently unusable for multi-method targets. Three of the failing
tests in `tests/intercept.test.js` name exactly these behaviours. Fix is one line:
merge into the existing stash object rather than only creating it.

### What happens when `patch` does not apply

If the target method is not a function, `patch` returns
`{ applied: false, undo: noop }` and **changes nothing**
(`src/core/intercept.ts:50-52`). It does not throw. The caller decides whether
that is fatal, and the two existing callers treat it differently:

- `src/plugins/antiSpam.ts:109-113` — logs a warning naming the method that was
  missing, so "anti-spam silently not attached" is visible.
- `src/plugins/session-repair.ts:158` — registers the disposer only when
  `handle.applied`, avoiding an undo that restores nothing.

The design intent is that a plugin built against a different upstream version
degrades one method rather than taking the socket down. Whether a silently
inert plugin should instead be fatal is a genuine open question; `anti-spam`
chooses the loud option and the choice is visible in its log line.

### Unwinding

`Disposables` (`src/core/intercept.ts:140-170`) collects disposers so plugins and
the host share one teardown path. `dispose()` pops from the end
(`:160-168`) — reverse order, so later patches unwind before the ones they
wrapped — and each disposer is individually `try`/`catch`ed, because one throwing
disposer must not strand the rest. `NyxBaileys.patchCount`
(`src/nyxBaileys.ts:286-288`) exposes the outstanding disposer count, which the
demo prints (`src/index.ts:282`) as the cheapest possible assertion that
decoration actually happened.

---

## 3. Plugins and why order matters

`Plugin` is three fields (`src/utils/types.ts:16-21`):

```ts
interface Plugin {
  readonly name: string;
  readonly order: number;   // lower runs first
  apply(ctx: PluginContext): void | Promise<void>;
}
```

`NyxBaileys.plugins()` (`src/nyxBaileys.ts:56-70`) returns the default chain;
`registerPlugin()` (`:76-80`) appends and re-sorts by `order`, so adding a plugin
never requires forking the class.

The live default chain, verified by instantiating and reading `plugins()`:

| `order` | Plugin | File | Owns |
|---|---|---|---|
| 10 | `stealth` | `plugins/stealth.ts` | identity pin, presence on real state |
| 20 | `lid-router` | `plugins/lid.ts` | `resolveJid` / `resolvePn`, LRU cache |
| 30 | `media-stream` | `plugins/media-stream.ts` | `downloadMedia`, `streamMedia` |
| 40 | `album` | `plugins/album.ts` | `albums`, `expandAlbum`, `waitForAlbum` |
| 50 | `memory-gc` | `plugins/memory.ts` | `store` (history / media / statuses) |
| 60 | `group-guard` | `plugins/group.ts` | `groupAlerts`, mass-add detection |
| 65 | `session-repair` | `plugins/session-repair.ts` | `__repairStats`, payload normalisation |
| 70 | `reconnect` | `plugins/reconnect.ts` | `health()`, backoff, rebuild requests |
| 80 | `anti-spam` | `plugins/antiSpam.ts` | `__antispam`, outbound pacing queue |
| 90 | `flow` | `plugins/flow.ts` | `flows`, conversational state machine |
| 100 | `warmup` | `plugins/warmup.ts` | pacing ramp, persisted start time |

`decorate()` (`src/nyxBaileys.ts:164-190`) applies each in order and **isolates
failures per plugin**: a throw is logged with the plugin name and the loop
continues (`:182-188`). One broken plugin costs you that plugin, not the socket.

### Three concrete reasons order is load-bearing

**1. Patch nesting.** Because `patch` chains (§2), application order determines
call order. `session-repair` (65) wraps `sendMessage` before `anti-spam` (80), so
a message is normalised *before* it enters the pacing queue. Reversed, the
normaliser would run after the delay has already been paid — the repair would be
correct but late.

**2. Attach-before-read.** `warmup` (100) reads `sock.__antispam`, which
`anti-spam` (80) assigns during `apply` (`antiSpam.ts:120`). Order 80 < 100 is the
entire contract. The coupling is deliberately soft — `warmup.ts:49-51` reaches
for `__antispam` through an `as unknown as` cast rather than importing the
plugin, and calls `?.setPressure?.()`, so a missing `anti-spam` is a no-op rather
than a crash.

**3. Stable diagnostics.** `client.applied` (`src/nyxBaileys.ts:41`) is
populated in application order (`:180`), so the demo's plugin list
(`src/index.ts:282`) reads in a fixed, meaningful sequence.

**A known wart in the source.** The trailing comments in `plugins()`
(`src/nyxBaileys.ts:64-65`) say `70` for `sessionRepair` and `75` for
`autoReconnect`. The values actually declared are `65`
(`plugins/session-repair.ts:45`) and `70` (`plugins/reconnect.ts:39`). The
comments are stale. The chain is still correctly sorted — 65 < 70 — so behaviour
is correct and only the comments lie. Trust the `order` field, not the comment.

### The plugin ordering rule, stated once

Low `order` = earlier in the chain = **outermost** wrapper = runs **first** on
the way out, **last** on the way back in. Give a plugin a low number when it must
observe or transform a payload before anything else touches it; a high number
when it needs the final say, or when it reads state an earlier plugin attaches.

---

## 4. How connect, rebuild and dispose fit together

### connect

`connect()` (`src/nyxBaileys.ts:86-92`) is concurrency-safe: simultaneous
callers share one in-flight attempt via `#connecting`, which is cleared in a
`finally` (`:88-90`). `#connect()` (`:94-128`) then runs, in order:

1. `invariant(!this.#closed)` — refuse to revive a disposed instance (`:95`).
2. Resolve the `SessionStore`, defaulting to `FileSessionStore` (`:97-100`).
3. `store.init()` → `{ state, saveCreds }` (`:103`).
4. `resolveWebVersion()` — negotiate the current web protocol, with a pinned
   fallback and any failure swallowed (`:104`).
5. `createCoreSocket({ state, saveCreds, … })` — the upstream socket (`:107-113`).
6. Define `sock.__requestReconnect` (`:117-121`).
7. `decorate()` — every plugin, in order.
8. `#wireConnection()` — the single owner of `connection.update`.

Step 6 is an architectural choice worth naming: **the reconnect plugin does not
rebuild sockets.** It asks the host to. `reconnect.ts:82-87` reaches for
`sock.__requestReconnect`, and if the host never defined it, logs
`"host exposes no __requestReconnect; socket left down"` rather than improvising.
One owner of the connect path means reconnect cannot drift from cold start.

### credential persistence

`createCoreSocket` registers the listener rc14 does not provide
(`src/core/socket.ts:107-111`):

```ts
sock.ev.on('creds.update', () => { saveCreds().catch(…); });
```

rc14 emits `creds.update` from many places and writes nothing itself —
`useMultiFileAuthState` returns a `saveCreds` closure the caller must invoke.
Without this listener a paired session is lost on every restart and the number
must re-pair each time. `VERIFICATION.md` D5 recorded this as HIGH; it is fixed.

### rebuild

`#rebuild()` (`src/nyxBaileys.ts:136-161`) is the reconnect path, and the
comment at `:132-135` states the ordering requirement: **unwind every patch
first**, so the new socket is decorated from a clean object rather than stacking
wrappers on wrappers across reconnect cycles.

```ts
this.#disposables.dispose();     // :141  — reverse-order unwinding
this.applied.length = 0;         // :142
this.sock?.end?.(undefined);     // :145
this.#connecting = this.#connect().finally(…)
```

State is never rebuilt from memory — `#connect()` goes back to the store, so a
reconnect and a cold start are the same code path. `Disposables.dispose()`
(`intercept.ts:159-169`) drains its array completely, so no stale handle
accumulates across cycles; `VERIFICATION.md` D8 flagged that the *counting* could
not be trusted while D3 stood, and the stash bug in §2 is the remaining reason
`patchCount` is not a perfect invariant.

### dispose

`dispose()` (`src/nyxBaileys.ts:274-284`) sets `#closed`, ends the socket inside
a `try`/`catch` (the socket may already be down), disposes everything, clears
`applied`. After it, `connect()` throws by way of the `invariant` at `:95`.

### connection events

`#wireConnection()` (`:193-220`) is documented as the single owner of
`connection.update`, and `#lastConnection` (`:196`) records `{ at, state }` for
`NyxBaileys.connectionState`. Plugins that need connection events register via
`onConnection()` (`:229-232`) rather than adding their own listener, and fan-out
(`#closeEvent`, `:234-242`) isolates per-listener throws.

One exception, honestly: `main()` adds its own `connection.update` listener at
`src/index.ts:301-306` that calls `client.dispose()` on close. That is the
second listener `VERIFICATION.md` D13 flagged. It is in the demo entry point
rather than the framework, and it will also fire during a rebuild — which is
latent now that `reconnect` is back in the chain, and would need to move behind
`onConnection`.

---

## 5. rc14 API realities

These are the things that cost the most time. Every one of them is a wall you
will hit on the first attempt, and every older-Baileys tutorial or LLM-generated
snippet will get them wrong.

### 5.1 `makeWASocket` takes `auth`, not spread credentials

```ts
const sock = makeWASocket({
  auth: state as never,     // src/core/socket.ts:84
  …
});
```

`state` is `{ creds, keys }` from the session store, passed as **one `auth`
property**. There is no top-level `creds`, no top-level `keys`, no
`session` — older Baileys forks and most snippets spread them. Also note
`fetchLatestWaWebVersion` returns `{ version, isLatest }` on rc14, not a bare
tuple, which is why `resolveWebVersion()` reads `.version` and validates
`Array.isArray(version) && length === 3` before accepting it
(`src/core/socket.ts:50-52`).

### 5.2 There is no `message.media`

rc14 dropped the generic `mediaMessage`. Media lives in a **per-type field** —
`imageMessage`, `videoMessage`, `audioMessage`, `stickerMessage`,
`documentMessage`, `ptvMessage`, `lottieStickerMessage` — enumerated as
`MEDIA_KEYS` at `src/core/media.ts:18-26`.

Anything that reaches for `msg.message.media` gets `undefined`, forever, with no
error. That is why this traversal is centralised: `firstMedia()`
(`media.ts:57-66`) returns the first populated media field in priority order, and
`mediaKeyOf()` (`:69-77`) reports which one it was.

### 5.3 There is no root `message.contextInfo`

`contextInfo` lives **inside** the per-type media field, plus a separate
root-level `messageContextInfo`. `contextOf()` (`media.ts:83-89`) implements the
two-hop rule in one place:

```ts
if (media?.contextInfo) return media.contextInfo;
return root?.messageContextInfo ?? null;
```

Getting this wrong is the same silent-`undefined` failure as §5.2 — no throw, no
media, just a bug that survives for months.

### 5.4 Albums are a parent plus siblings, not a container with media

This is the one that breaks the most album code.

**The parent** `albumMessage` carries **counts only**
(`src/core/nodes.ts:251-260`):

```ts
proto.Message.AlbumMessage.create({
  expectedImageCount: count - videos,
  expectedVideoCount: videos,
})
```

There is no media array in it. Nothing to decrypt. The receiver needs to know how
many members to expect before any arrive.

**The media arrives as separate sibling messages**, each linked back to the
parent. And here is the second wall: **rc14 has no `albumParentKey` field at
all.** Verified against the installed schema — `mediaMessage` and
`albumParentKey` each appear **0 times** in `WAProto/WAProto.proto`.

The real link is `contextInfo.messageAssociation`, tagged
`AssociationType.MEDIA_ALBUM` (= 1), which is what upstream itself writes at
`node_modules/@whiskeysockets/baileys/lib/Utils/messages.js:538`. So the parent
key is read as:

```ts
parentKeyOf(msg, proto.MessageAssociation.AssociationType.MEDIA_ALBUM)   // plugins/album.ts:62-63
```

Verified against a realistic rc14 sibling: returns `PARENT1`.

`VERIFICATION.md` D1 recorded the original `mediaMessage.albumParentKey` read as a
HIGH defect that made the whole album role non-functional. It is fixed. The
legacy inline shape is still handled as a fallback (`album.ts:70-76`) in case a
client ever ships it.

### 5.5 Native flow is `{messageVersion, messageParamsJson, buttons}`

`INativeFlowMessage` has exactly three fields. Verified against the schema at
`WAProto/WAProto.proto:2730-2737`:

```
message NativeFlowMessage {
    repeated NativeFlowButton buttons = 1;
    optional string messageParamsJson = 2;
    optional int32 messageVersion = 3;
}
```

The section/row UI is **not in the protobuf**. It is the JSON payload the client
parses out of `messageParamsJson`. `src/core/nodes.ts:12-21` puts it directly:

> The rich section/row schema is *not* in the protobuf — it is the JSON payload
> the client renders. That is the fork's actual innovation, and it belongs in our
> layer rather than in `node_modules`.

So building a flow is: construct a params object → `JSON.stringify` → hand it to
upstream for compilation. `buildFlowMessageParams()` (`nodes.ts:61-87`) does the
first half; `toFlowMessage()` (`:90-101`) does the second:

```ts
proto.Message.InteractiveMessage.NativeFlowMessage.create({
  messageVersion: 1,
  messageParamsJson: JSON.stringify(params),
  buttons: [{ name: 'native_flow_cta', buttonParamsJson: JSON.stringify({ displayName: params.ctaLabel }) }],
})
```

Note the asymmetry that makes this confusing: the button **name** is a first-class
proto field, but the button's entire payload is one opaque JSON string.

**Three consequences:**

- Anything written into `messageParamsJson` is outside every schema the framework
  can validate. That is why the sanitisation-bypass request in
  `DESIGN-NOTES.md` §4 has no defensible form.
- A row without `optionName` cannot be bound by the client and degrades to a
  plain text bubble. `session-repair` backfills it by parsing
  `messageParamsJson`, repairing, and re-serialising
  (`plugins/session-repair.ts:81-114`) — and leaves a malformed string untouched
  rather than corrupting it (`:88-91`).
- The **reply** arrives as
  `interactiveResponseMessage.nativeFlowResponseMessage.paramsJson` — the same
  opaque JSON string the sender produced, echoing the flow. Not reading it is why
  a form's own submissions used to extract to `""` and get silently dropped at
  `flow.ts:244`. `parseFlowResponse()` (`flow.ts:95-128`) handles it, scanning
  several plausible key names and then walking the object breadth-first for a
  recognisable value, because the shape varies by flow schema. Verified against a
  real rc14 submit: `{ text: "Railway", selection: "Railway" }`.

### 5.6 `editedMessage` is a `FutureProofMessage`, not a text field

`src/core/nodes.ts:263-265`:

```ts
export function createEdit(text: string): WebMessageInfo {
  return { message: { editedMessage: { text } as proto.IMessage['editedMessage'] } };
}
```

This is **broken**. On rc14 `editedMessage` is
`optional FutureProofMessage editedMessage = 58`, and `FutureProofMessage` holds
`optional Message message = 1` — not a `text` field. The `as` cast silences the
compiler. Verified round-trip:

```
input     : {"message":{"editedMessage":{"text":"hello world"}}}
roundtrip : {"editedMessage":{}}          ← text silently gone
```

Correct shape is `{ editedMessage: { message: { conversation: text } } }`, also
verified. `VERIFICATION.md` recorded this as part of the node-builder contract
rather than a numbered defect; `tests/nodes.test.js` has it as a failing
regression (`"createEdit actually carries the text onto the wire"`). Every other
builder in `nodes.ts` round-trips correctly — `createAlbumContainer` and
`toFlowMessage` were both checked and are correct.

---

## 6. Directory map

```
src/
  index.ts                 public surface (51 exports) + demo main()
  nyxBaileys.ts          the wrapper class: lifecycle, plugin chain, rebuild
  core/
    socket.ts              makeWASocket + tuning + fingerprint + creds persistence
    intercept.ts           patch/patchAll/listen/Disposables — the primitive
    nodes.ts               native-flow, album, edit protobuf builders
    media.ts               rc14 media traversal (the two-hop rule)
    session-store.ts       SessionStore interface + file/memory/adapter factories
  plugins/                 11 plugins, each a {name, order, apply}
    stealth.ts        10    identity pin, presence on real state
    lid.ts            20    resolveJid / resolvePn, TTL cache
    media-stream.ts   30    downloadMedia / streamMedia, size ceiling
    album.ts          40    albums / expandAlbum / waitForAlbum
    memory.ts         50    store: bounded history, media, statuses
    group.ts          60    groupAlerts, mass-add window
    session-repair.ts 65    payload normalisation, __repairStats
    reconnect.ts      70    backoff, health(), rebuild requests
    antiSpam.ts       80    pacing queue, __antispam
    flow.ts           90    flows registry, conversational state machine
    warmup.ts        100    ramp, persisted
    metrics.ts       (new)  dependency-free registry, cardinality-capped
  utils/
    types.ts               Plugin, PluginContext, SessionStore, SuperOptions
    compose.ts             WhatsApp text dialect, monospace tables, CJK widths
    logger.ts              levelled logger, child scopes, NO_COLOR/TTY
  adapters/            (new)  SessionStore impls — none import a driver
    session-sqlite.ts       injected persistence fn; atomic write + fsync
    session-mongo.ts        creds doc + one doc per Signal key, native BSON
    session-prisma.ts       two models, BufferJSON round-trip, no generated client
    session-redis.ts        L1 cache layer, per-session epoch prefix
    index.ts                barrel
  multi/               (new)  one process, N accounts
    session-manager.ts      SessionManager, broadcast, per-session restart
    index.ts                barrel
  security/            (new)  untrusted input, secrets, permissions, audit
    validate.ts            Validated<T> combinators, jid parsing, validationGate
    redact.ts              deep redaction, findings, redactionGuard
    permissions.ts         25 capabilities, 7 roles, grant matching
    acl.ts                 AccessControl: can/allows/assert, scopes, denies
    audit.ts               hash-chained append-only audit log
  cli/                 (new)  zero-import argument parsing and output
    args.ts                parseArgv, specs, help rendering
    output.ts              Reporter (json|human), colour, widths, formatters
tests/                     node:test suites importing from dist/
docs/                      this file, PLUGIN-API, FEATURES, DESIGN-NOTES,
                           plus VERIFICATION.md and REF-FINDINGS.md (inputs)
```

### The newer layers: real, but not yet reachable

`adapters/`, `multi/`, `security/`, `cli/` and `plugins/metrics.ts` are complete
source files and are covered by `tsconfig.json` (`include: ["src/**/*.ts"]`), so
they compile as part of the package. Two packaging gaps are worth knowing before
you plan around them:

1. **`src/index.ts` does not re-export them.** The 51 exports are all core,
   plugins and utils. `SessionManager`, `AccessControl`, `redact`,
   `parseArgv` and `SqliteSessionStore` are not among them.
2. **`package.json` `exports` does not map them.** The map is `.`, `./core/*`,
   `./plugins/*`, `./utils/*` — no `./adapters/*`, `./multi/*`, `./security/*`
   or `./cli/*`. So even though `src/adapters/index.ts:11-13` documents the
   intended `import … from 'nyx-baileys/adapters/session-mongo.js'`, that
   specifier does not resolve against the published `exports` map. Until the map
   is extended, these are reachable only by deep relative import from `dist/`.

Both are one-line changes in files this documentation pass does not own.

---

## 7. Verify chain, as measured

Measured 2026-10-03 against the tree described above.

| Step | Command | Result |
|---|---|---|
| Type check | `npm run check` | **exit 0 — 0 errors** |
| Build | `npm run build` | **exit 0 — 0 errors** |
| Test | `npm test` | **exit 1 — runner cannot load the directory** |
| Test (direct) | `node --test tests/*.test.js` | 195 tests, 186 pass, **9 fail** |
| Runtime import | `import('./dist/index.js')` | exit 0, 51 exports |

The type check and build are **green** under `strict` +
`noUncheckedIndexedAccess`, and `dist/` is current, so the test figures below
do describe `src/`.

`npm test` runs `node --test tests/` and fails with `Cannot find module
'C:\Nyx-Baileys\tests'` — the directory form is resolved as a module path on
this Node build. Invoking the files directly works.

**The 9 failures are genuine defects, not flakes**, and they cluster on the open
items in this document:

| Failing test | Defect |
|---|---|
| `dispose() restores relayMessage, not undefined` | pristine-stash scoping (§2) |
| `undoing a second method on the same target restores the true original` | pristine-stash scoping (§2) |
| `Disposables.dispose() restores every patched method, not just the first` | pristine-stash scoping (§2) / D11 |
| `patchAll — one undo restores every method it patched` | pristine-stash scoping (§2) / D11 |
| `createEdit actually carries the text onto the wire` | §5.6 |
| `a released (zero-length) blob is still evicted by the keepMedia ceiling` | D7 |
| `ctx.flowResponse carries the parsed native-flow payload` | flow engine reply plumbing |
| `a messageParamsJson that parses to null is a no-op, not a TypeError` | `session-repair.ts:88-91` null guard |

All are `BUG:`-prefixed regression tests, so they fail loudly rather than rot.
The count is a moving target — it was 11 when this was written and falls as the
remaining work lands.

`VERIFICATION.md` lists 15 defects (D0–D14) plus a node-builder contract note.
Six are fixed and verified here — **D0, D1, D2, D3, D5, D9**, the same six its own
"fix order" section nominated. Nine remain open: D4 (`goto` re-entrancy, still
unguarded at `plugins/flow.ts:189-196`), D6 (privilege-climb check is still
tautological at `plugins/group.ts:101-112` — `known` counts promotes, so
`known >= 3` means "three promote events", not "all members are admins"), D7
(media GC still evicts the blobs holding bytes at `plugins/memory.ts:73-79`),
D8, D10 (`streamMedia` still materialises the full buffer then slices — the
docstring at `:100-103` now concedes this rather than claiming bounded memory),
D11, D12, D13, D14 (the warm-up ramp is still evaluated once per socket build
rather than on an interval). Plus the stash bug in §2 and `createEdit` in §5.6.
