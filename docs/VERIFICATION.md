# VERIFICATION — super-baileys 0.1.0

Date: 2026-10-03 · Upstream: `@whiskeysockets/baileys@7.0.0-rc14` · Node v24.19.0 · TypeScript 7.0.2 (global)

## Verdict

**RED.** Type-check is green, runtime import is green, but the composition layer is
broken in ways that only show up when two plugins touch the same method. 3 blocking
defects, 11 more of medium/high severity. Roles 1, 2, 4, 5, 6 are genuinely covered;
roles 3, 7, 10 are wired against fields that do not exist in rc14 and therefore
silently never fire.

---

## 1. Verify chain

| Step | Command | Exit | Result |
|---|---|---|---|
| Type check | `npm run check` | **1** | `'tsc' is not recognized as an internal or external command` |
| Build | `npm run build` | **1** | same |
| Type check (global tsc) | `npx --no-install tsc -p tsconfig.json --noEmit` | 0 | clean, 20 source files |
| Build (global tsc) | `npx --no-install tsc -p tsconfig.json` | 0 | emits to `dist/` |
| Runtime smoke | `node --input-type=module -e "import('./dist/index.js')..."` | 0 | `51 exports` |
| `npm test` | `node --test tests/` | — | `tests/` is empty; no tests exist |

### Why both npm scripts fail (D0)

`package.json` has **no `devDependencies` at all**. `typescript` is only present as a
global install, so `node_modules/.bin/tsc` does not exist and both scripts die before
`tsc` runs. This is not a TypeScript error — the code type-checks clean under
`strict` + `noUncheckedIndexedAccess` the moment a compiler is reachable.

Fix — `package.json`:

```json
"devDependencies": { "typescript": "^5.6.0" },
"scripts": { "build": "tsc -p tsconfig.json", "check": "tsc -p tsconfig.json --noEmit" }
```

Note the pinned version matters: the code is verified against TS 7.0.2, which is a
different compiler line from 5.x. Pin to whatever CI actually uses.

### Runtime smoke: what it does and does not prove

`import('./dist/index.js')` succeeds and yields 51 exports. What it does **not**
exercise:

- `main()` never runs. `src/index.ts:314` guards on `process.argv[1]`, which is
  `undefined` under `--input-type=module -e` (verified: `argv[1] = undefined`). So
  the guard correctly no-ops — but it also means the smoke test never touches
  `connect()`, `makeWASocket`, or a single plugin.
- No plugin `apply()` runs. All 11 plugins, all 15 roles, zero coverage.

**The smoke test is a syntax check wearing a costume.** It cannot fail on any of the
defects below.

---

## 2. Coverage matrix — the 15 requested roles

| # | Role | Status | Implementation |
|---|---|---|---|
| 1 | Upstream protocol engine | **COVERED** | `src/core/socket.ts:83` — `makeWASocket({ auth: state })`, no node_modules edits. Verified socket constructs against rc14 types. |
| 2 | Native flow / interactive layouts | **COVERED** | `src/core/nodes.ts:61` (`buildFlowMessageParams`), `:90` (`toFlowMessage` — correct 3-field rc14 shape), `:151/:162/:185` form/carousel/table. JSON round-trip verified. |
| 3 | Album container decrypt | **PARTIAL — broken linkage** | Parent handled at `src/plugins/album.ts:86-99`. Sibling linkage at `:52-55` reads `mediaMessage.albumParentKey` — **field does not exist in rc14** (D1). Decrypt at `:135` is correct (4-arg cast present). |
| 4 | Anti-spam jitter queue | **COVERED** | `src/plugins/antiSpam.ts:46` (Box–Muller clamped), `:66` (serial drain), `:55` (sliding 60 s window), `:120` (`__antispam`). |
| 5 | Stealth / UA identity | **COVERED** | `src/plugins/stealth.ts:37` (`__identity`), `:53` presence on real state only. `src/core/socket.ts:108` UA builder. |
| 6 | LID↔JID mapping | **COVERED** | `src/plugins/lid.ts:67` (`resolve`), `:97` (`resolvePn`). Correct rc14 call shape (`onWhatsApp(target)` → `{jid,exists}[]`). |
| 7 | Webflow form input parser | **MISSING** | `src/plugins/flow.ts:80-109` — parses `interactiveMessage`, `buttonsResponseMessage`, `listResponseMessage`, `listMessage`. Never reads `interactiveResponseMessage.nativeFlowResponseMessage` (D2). A native-flow form submit extracts to `""` — verified. |
| 8 | Chat flow state machine | **COVERED** | `src/plugins/flow.ts:144` (`run`), `:161` (`start`), `:180` (upsert dispatch), `:229` (`sock.flows`). |
| 9 | Memory GC store | **PARTIAL** | `src/plugins/memory.ts:60` sweep, `:89` upsert hook, `:112` `sock.store`. Media eviction at `:73-79` is inverted (D7). |
| 10 | Multi-device payload normaliser | **PARTIAL — dead code** | `src/plugins/session-repair.ts:55` (`unwrap`) and `:81` (`repairFlow`) are both sound against rc14 and **proven not to run** because patch stacking is broken (D3). |
| 11 | Multi-session core | **PARTIAL** | `src/superBaileys.ts:33` class, `:291` factory, `:135` `#rebuild`. Per-session state leaks: `#disposables` is shared across rebuilds and never reset (D8). |
| 12 | SQL/NoSQL session bridge | **COVERED** | `src/core/session-store.ts:128` `createSessionStore({load,save})` — genuine adapter. `:29` FileSessionStore, `:91` MemorySessionStore. |
| 13 | Auto-retry backoff | **COVERED (not in default chain)** | `src/plugins/reconnect.ts:63` (full-jitter exp), `:68` (`schedule`), `:121-163` reason switch. Imported at `superBaileys.ts:18` but **absent from `plugins()`** (D9) — dead unless registered. |
| 14 | Media streaming optimizer | **PARTIAL** | `src/plugins/media-stream.ts:59` size ceiling with typed `MediaTooLargeError`, `:95` `streamTo`. Not streaming: full buffer materialised first, then sliced (D10). |
| 15 | Group management / security | **PARTIAL** | `src/plugins/group.ts:73` mass-add window, `:93` privilege tracking, `:54` `super.groupAlert`. Privilege check is tautological (D6). Read-only by design — no enforcement surface. |

**Totals: 6 COVERED · 8 PARTIAL · 1 MISSING**

---

## 3. Defects

### D0 — BLOCKER · both npm scripts cannot run
`package.json:19-21` — no `devDependencies`. `tsc` is unresolvable.

`npm run check` → exit 1, `npm run build` → exit 1, both `'tsc' is not recognized`.
Severity **BLOCKER**. Add `typescript` to `devDependencies`.

---

### D1 — HIGH · album sibling linkage reads a field rc14 does not have
`src/plugins/album.ts:52-55`

```ts
return m?.mediaMessage?.albumParentKey?.id ?? m?.documentMessage?.albumParentKey?.id;
```

Verified against installed rc14: `mediaMessage` appears **0 times** in
`WAProto/WAProto.proto` and 0 times in `WAProto/index.d.ts`. There is no
`albumParentKey` field anywhere in the schema either. rc14 carries album association
in `contextInfo.messageAssociation.parentMessageKey` with
`associationType: MEDIA_ALBUM (=1)` — see
`node_modules/@whiskeysockets/baileys/lib/Utils/messages.js:534-540`, which is where
upstream *writes* it, and `WAProto/WAProto.proto:3677-3687` for the shape.

Verified: `parentKey()` returns `undefined` against a realistic rc14 sibling message.

Consequence: `parentKey()` is always falsy → `album.ts:103` `continue`s → sibling
media never joins a parent. Albums only ever contain the legacy inline shape, which
rc14 never sends. **Role 3 is non-functional.**

Fix — read the real field, with the legacy path kept as fallback:

```ts
const parentKey = (msg: WAMessage): string | undefined => {
  const m = msg.message as Record<string, any> | undefined;
  const assoc = m?.messageContextInfo?.messageAssociation
    ?? m?.imageMessage?.contextInfo?.messageAssociation
    ?? m?.videoMessage?.contextInfo?.messageAssociation
    ?? m?.documentMessage?.contextInfo?.messageAssociation;
  return assoc?.parentMessageKey?.id
    ?? m?.mediaMessage?.albumParentKey?.id   // legacy fork shape
    ?? undefined;
};
```

---

### D2 — HIGH · native-flow form submissions are invisible to the flow engine
`src/plugins/flow.ts:80-109` (`extract`)

rc14 delivers a native-flow submit as
`interactiveResponseMessage.nativeFlowResponseMessage = { name, paramsJson, version }`
(confirmed: `WAProto/index.d.ts:6961`, `:7007-7011`). `extract()` reads
`interactiveMessage`, `buttonsResponseMessage`, `listResponseMessage`, `listMessage`,
`extendedTextMessage`, `conversation` — and never `interactiveResponseMessage`.

Verified: a native-flow reply extracts to `{ text: "" }`. `flow.ts:186`
(`if (!probe.text && !probe.selection) continue;`) then drops it silently.

So the form that `createFormFlow()` sends is the one form whose reply the engine
cannot read. **Role 7 is MISSING.**

Fix — add a branch ahead of the existing chain, parsing `paramsJson` defensively:

```ts
const nfr = (m?.interactiveResponseMessage as any)?.nativeFlowResponseMessage;
if (nfr?.paramsJson) {
  try {
    const p = JSON.parse(nfr.paramsJson) as Record<string, any>;
    const value = p.value ?? p.selectedId ?? p.text ?? p.input;
    if (typeof value === 'string') return { text: value.trim(), selection: value.trim() };
  } catch { /* malformed params: fall through */ }
}
```

---

### D3 — BLOCKER · `patch()` does not stack; the second wrapper silently discards the first
`src/core/intercept.ts:58-63`

```ts
const pristine = (holder[stashKey] as Record<string, unknown>)[name] as ...
const patched = function (this: unknown, ...args: unknown[]) {
  return wrapper(pristine, this, args);   // ← always the ORIGINAL, never the current wrapper
};
```

The module docstring (`intercept.ts:8-9`) promises `B(A(original))`. The code delivers
`B(original)`. Verified with a two-patch probe: result was `B(ORIGINAL)`.

This is why **D3 kills role 10**. `session-repair` (order 65) and `antiSpam`
(order 80) both `patch` `sendMessage`. antiSpam applies second, so its wrapper is
live and session-repair's is discarded — but `handle.undo()` for the *discarded*
patch still runs on dispose, so the accounting lies too.

Verified end-to-end against the real plugins: after applying `sessionRepair()` then
`antiSpam()`, `sock.__repairStats.repairs` stayed `0` across a real `sendMessage`
carrying a native flow with a bare `{title}` row, and the row still had **no
`optionName`** after the call. The normaliser never executed.

Fix — chain onto the *current* implementation and keep the pristine copy only for
`undo`:

```ts
const current = (target as AnyRecord)[name] as (...a: unknown[]) => unknown;
const patched = function (this: unknown, ...args: unknown[]) {
  return wrapper(current as never, this, args);
};
```

`undo()` already restores from `pristine`, so it stays correct.

---

### D4 — HIGH · `run()` re-entrancy: `goto()` into a step can be dropped
`src/plugins/flow.ts:137` inside `buildContext`, `:144-147` inside `run`

`goto` calls `void run(jid, next)`. `run` reads `active.get(jid)` and returns early
if absent. If a step calls `ctx.end()` and then `ctx.goto(...)` — or if the flow was
TTL-expired between the two — `goto` silently does nothing. The `log.warn` at `:134`
only fires when the *name* is missing, never when the *flow* is gone, so this is
invisible.

My isolated probe of this exact shape did not reproduce the drop (the flow was still
active), so this is a latent ordering hazard rather than a proven failure — but the
code path is unguarded and the failure mode is silent.

Severity HIGH (silent no-op in a state machine). Fix — check before dispatching:

```ts
goto: (name) => {
  const next = stepByName(running.flow, name);
  if (!next) { log.warn('goto target missing', { flow: running.flow.id, to: name }); return; }
  if (!active.has(jid)) { log.warn('goto with no active flow', { flow: running.flow.id, to: name }); return; }
  void run(jid, next);
},
```

---

### D5 — HIGH · `index.ts` pairing path never awaits credential persistence
`src/index.ts:220-226`, and `src/core/socket.ts:102`

`saveCreds` is threaded from `store.init()` (`superBaileys.ts:102`) through
`createCoreSocket` (`socket.ts:108`) and then **discarded** at `socket.ts:102`:

```ts
void saveCreds; // owned by the caller (SuperBaileys), not the socket factory
```

Grep confirms **no `creds.update` → `saveCreds` listener is registered anywhere** in
`src/`. The only `creds.update` reference is `index.ts:220`, which is a *read*
(waits for `.registered`).

rc14 emits `creds.update` from many places (`lib/Socket/chats.js:778`,
`messages-recv.js:512`, `socket.js:170`, …) and does **not** persist by itself —
`useMultiFileAuthState` returns a `saveCreds` closure that the caller must invoke.
Nothing invokes it.

Consequence: paired credentials are never written to disk. Every restart re-pairs.
This is the single most user-visible defect in the framework and it is entirely
silent.

Fix — in `SuperBaileys.#connect`, after the socket exists:

```ts
const offCreds = sock.ev.on('creds.update', () => { void saveCreds(); });
this.#disposables.add(() => offCreds());
```

---

### D6 — MEDIUM · privilege-climb check is tautological
`src/plugins/group.ts:93-113`

The comment at `:101-102` says "Everyone seen in this group so far has been an
admin. Normal groups have plenty of plain members." But `admins` is **only** ever
populated from `promote`/`demote` events (`:94-99`). Plain members are never added,
so `known` can never include them. `known >= 3` therefore reduces to "3+ promote
events seen in this group", which fires on essentially every active group.

The signal cannot distinguish the pattern it claims to detect. It is a counter, not
a detector.

Fix — track membership population, or narrow the claim:

```ts
const known = admins.get(groupId)?.size ?? 0;
const members = (metadataCache.get(groupId)?.participants?.length) ?? 0;
if (members > 0 && known / members >= 0.8 && known >= 3 && update.action === 'promote') { … }
```

---

### D7 — MEDIUM · media GC deletes exactly the blobs it should keep
`src/plugins/memory.ts:73-79`

```ts
for (const blob of ordered.slice(0, media.size - keepMedia)) {
  if (blob.ref.byteLength === 0) continue; // already released
  media.delete(blob.key);
}
```

Intent (per `:72` comment): evict old media **only when nothing holds it**. Actual
behaviour: it skips already-empty blobs and deletes the ones still holding bytes —
the precise inverse. There is no refcount anywhere, so `blob.ref.byteLength` is
always non-zero for a live blob; the `continue` is unreachable and every over-budget
blob gets deleted regardless of in-flight use.

Combined with `take()` at `:121-126` (which deletes on read), a caller mid-download
loses its entry. Fix — either add a real refcount, or drop the misleading guard and
fix the comment to match what the code does.

---

### D8 — MEDIUM · `#disposables` is never reset across rebuilds
`src/superBaileys.ts:140` and `:43`

`Disposables.dispose()` (`intercept.ts:149-159`) pops every item, so the array does
drain — but `#rebuild()` calls `dispose()` and then `#connect()` → `decorate()` →
each plugin re-registers. Because of D3 the `patch()` `undo()` handles still fire for
patches that were never live (see D3), so the disposal path *does* run — but
`patchCount` (`:285`) counts every handle ever registered minus those disposed, which
across N rebuild cycles is only correct if disposal is perfectly symmetric. It is not
verifiable while D3 stands.

Fix after D3 lands: add `this.#disposables.reset()` semantics — clear the array
explicitly in `#rebuild` after `dispose()` so a throwing disposer cannot leave stale
entries.

---

### D9 — MEDIUM · `autoReconnect` is imported but never in the default chain
`src/superBaileys.ts:18` vs `:57-68`

```ts
import { autoReconnect } from './plugins/reconnect.js';   // line 18
```

`plugins()` returns stealth, lid, media, album, memory, group, sessionRepair,
antiSpam, flow, warmup — **no reconnect**. Verified by parsing the returned array.

Consequences: `sock.health()` (advertised in `index.ts:296`) is `undefined`; no
auto-reconnect happens; `__requestReconnect` (`superBaileys.ts:116`) is defined but
never invoked. Role 13 is dead code in the default configuration.

Fix — add `autoReconnect()` to the chain. Note it declares `order: 70`
(`reconnect.ts:39`), colliding with sessionRepair's 70 (`session-repair.ts:45`);
give it 75 or move sessionRepair to 65.

---

### D10 — MEDIUM · `streamMedia` is not streaming
`src/plugins/media-stream.ts:95-105`

`streamTo` calls `fetch()` — which materialises the **entire** decrypted buffer at
`:68-70` — then slices it into 64 KB chunks. The docstring at `:19-20` claims "the
peak is bounded by the chunk, not by the asset". It is not: peak memory is the full
asset plus one chunk. For the 300 MB video the module was written to protect against,
this is the same peak as the naive call.

The comment at `:90-94` half-concedes this ("the full buffer exists briefly because
the socket delivers it that way"), which makes the `:19-20` claim a documentation
defect on top of a design gap.

Fix — either use the socket's real streaming path
(`downloadMediaMessage(msg, 'stream', …)` is exported and typed, per
`lib/Utils/messages.d.ts:87`) or correct the docstring to say "chunked handoff, not
bounded memory".

---

### D11 — LOW · `patchAll` returns a redundant first element
`src/core/intercept.ts:93-101`

Returns `[aggregate, ...applied.slice(1)]`. The aggregate's `undo()` already unwinds
everything, and `applied[0]` is silently dropped from the returned array. A caller
iterating the result gets `N` handles where the first is a superset of the rest —
easy to double-undo. Not currently called anywhere in `src/`, so latent.

Fix — return just the aggregate, or return `applied` unmodified.

---

### D12 — LOW · `album` uses a magic sentinel as a real expected-count
`src/plugins/album.ts:105`, `:113`

`ensure(parent, jid, Number.MAX_SAFE_INTEGER)` when no parent is known yet, then
`album.expected !== Number.MAX_SAFE_INTEGER` gates completion. If the parent message
arrives *after* its siblings, `ensure` returns the existing entry at `:67-68` and
never updates `expected`, so `completedAt` is never set and `waitFor` times out
(`:151`). Race is order-dependent and unresolved.

---

### D13 — LOW · `main()` installs a second `connection.update` listener
`src/index.ts:301-306`

`SuperBaileys.#wireConnection` (`superBaileys.ts:193`) is documented as the single
owner of that event. `main()` adds its own that calls `client.dispose()` on close,
which will also fire when reconnect (once D9 is fixed) tears the socket down
mid-rebuild. Latent until D9 lands.

---

### D14 — INFO · `warmup` × `antiSpam` coupling — verified WORKING, one caveat

The user asked specifically. Findings:

**Order is fine.** `antiSpam` is `order: 80` (`antiSpam.ts:35`), `warmup` is
`order: 100` (`warmup.ts:29`), and `decorate()` (`superBaileys.ts:176`) iterates
`this.plugins()` in array order. `__antispam` is assigned at `antiSpam.ts:120`
during `apply`, which completes before `warmup.apply` reads it at `warmup.ts:49-51`.
The coupling holds.

**`rampFor` curve — verified correct.** Computed values:

```
age   0h -> 8.000x     age 36h -> 2.750x
age   1h -> 7.807x     age 48h -> 1.778x
age  12h -> 5.861x     age 60h -> 1.194x
age  24h -> 4.111x     age 72h -> 1.000x  (clamped)
```

8× → 1× over 3 days, monotone decreasing, continuous at both ends. The
`(1-progress)^2` easing gives a fast early drop, matching the comment. `days <= 0`
returns 1 (disabled). Correct.

**One caveat — the ramp is applied once, never re-evaluated.** `warmup.apply` runs
exactly once per socket build. A long-lived process connecting on day 1 computes
`8.000x` and holds that multiplier for the socket's entire life; it never decays to
1× as the session ages. The docstring at `:10-11` claims "the ramp survives
restarts", which is true, but the ramp only *advances* on restart.

Fix — re-evaluate on an interval:

```ts
const tick = setInterval(() => {
  void ctx.state.get<number>('warmupStartedAt', 0).then((s) => {
    if (s) antispam?.setPressure?.(rampFor(s, days));
  });
}, 60 * 60 * 1000);
ctx.onDispose(() => clearInterval(tick));
```

**Second caveat — `setPressure` clamps to `Math.max(1, n)`** (`antiSpam.ts:122`),
which is right for a widening-only multiplier, but it means the framework can never
*tighten* pacing via this channel despite `reconnect.ts` describing a health signal
that would. Not a bug; worth documenting.

---

### Non-issues (checked, verified clean)

- **`createAlbumContainer`** (`nodes.ts:251`) — round-trips through
  `proto.Message.encode/decode` with counts intact. Correct for rc14.
- **`createEdit`** (`nodes.ts:263`) — **is** broken, but not the way it looks. The
  input `{message:{editedMessage:{text}}}` loses `text` on protobuf round-trip
  (verified: output is `{"editedMessage":{}}`) because rc14's `editedMessage` is
  `IFutureProofMessage` (`WAProto:6343`) with a `message` field, not a `text` field.
  The cast at `nodes.ts:264` hides this. Correct shape is
  `{ editedMessage: { message: { conversation: text } } }`. Reporting as part of the
  node-builder contract rather than a separate entry.
- **`toFlowMessage`** (`nodes.ts:90`) — verified the exact 3-field rc14 shape against
  `WAProto:6886-6890`. Correct.
- **`downloadMediaMessage(msg,'buffer',{},ctx.sock as never)`** — 4-arg cast present
  and correct at `media-stream.ts:69` and `album.ts:135`. Matches rc14 signature.
- **`makeWASocket({auth: state})`** — correct, `socket.ts:84`. Socket constructs OK
  against rc14 types with a mock key store.
- **`fetchLatestWaWebVersion`** — `socket.ts:50` reads `.version` off the object
  return. Correct for rc14.
- **`onWhatsApp(target)`** — `lid.ts:76`, `:102`. Single vararg is valid for a
  varargs signature. Return handling (`find(r=>r.exists) ?? probe?.[0]`) is right.
- **`flow.ts:114-117` `matches`** — handles both RegExp and function. Fine.
- **`logger.ts`** — level gate, TTY/NO_COLOR detection, child scoping all correct.
- **`compose.ts` `table()`** — CJK/emoji width accounting correct.

---

## 4. Summary

Fix order:

1. **D0** — add `typescript` to devDependencies. Nothing else is verifiable until
   `npm run check` runs.
2. **D3** — one-line fix in `intercept.ts:62-63`. Unblocks role 10 and makes the
   disposal path honest.
3. **D5** — register `creds.update` → `saveCreds`. Without it the framework cannot
   persist a pairing.
4. **D1** — album linkage against the real rc14 field.
5. **D2** — native-flow response parsing.
6. **D9** — add `autoReconnect` to the chain.

D0–D3 are the difference between "type-checks" and "works".
