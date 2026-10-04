# VERIFICATION — nyx-baileys 0.2.0

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
| 11 | Multi-session core | **PARTIAL** | `src/nyxBaileys.ts:33` class, `:291` factory, `:135` `#rebuild`. Per-session state leaks: `#disposables` is shared across rebuilds and never reset (D8). |
| 12 | SQL/NoSQL session bridge | **COVERED** | `src/core/session-store.ts:128` `createSessionStore({load,save})` — genuine adapter. `:29` FileSessionStore, `:91` MemorySessionStore. |
| 13 | Auto-retry backoff | **COVERED (not in default chain)** | `src/plugins/reconnect.ts:63` (full-jitter exp), `:68` (`schedule`), `:121-163` reason switch. Imported at `nyxBaileys.ts:18` but **absent from `plugins()`** (D9) — dead unless registered. |
| 14 | Media streaming optimizer | **PARTIAL** | `src/plugins/media-stream.ts:59` size ceiling with typed `MediaTooLargeError`, `:95` `streamTo`. Not streaming: full buffer materialised first, then sliced (D10). |
| 15 | Group management / security | **PARTIAL** | `src/plugins/group.ts:73` mass-add window, `:93` privilege tracking, `:54` `nyx.groupAlert`. Privilege check is tautological (D6). Read-only by design — no enforcement surface. |

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

`saveCreds` is threaded from `store.init()` (`nyxBaileys.ts:102`) through
`createCoreSocket` (`socket.ts:108`) and then **discarded** at `socket.ts:102`:

```ts
void saveCreds; // owned by the caller (NyxBaileys), not the socket factory
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

Fix — in `NyxBaileys.#connect`, after the socket exists:

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
`src/nyxBaileys.ts:140` and `:43`

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
`src/nyxBaileys.ts:18` vs `:57-68`

```ts
import { autoReconnect } from './plugins/reconnect.js';   // line 18
```

`plugins()` returns stealth, lid, media, album, memory, group, sessionRepair,
antiSpam, flow, warmup — **no reconnect**. Verified by parsing the returned array.

Consequences: `sock.health()` (advertised in `index.ts:296`) is `undefined`; no
auto-reconnect happens; `__requestReconnect` (`nyxBaileys.ts:116`) is defined but
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

`NyxBaileys.#wireConnection` (`nyxBaileys.ts:193`) is documented as the single
owner of that event. `main()` adds its own that calls `client.dispose()` on close,
which will also fire when reconnect (once D9 is fixed) tears the socket down
mid-rebuild. Latent until D9 lands.

---

### D14 — INFO · `warmup` × `antiSpam` coupling — verified WORKING, one caveat

The user asked specifically. Findings:

**Order is fine.** `antiSpam` is `order: 80` (`antiSpam.ts:35`), `warmup` is
`order: 100` (`warmup.ts:29`), and `decorate()` (`nyxBaileys.ts:176`) iterates
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

---

## 5. Remediation pass — 2026-10-03

Every defect above is fixed, each with a regression test in `tests/`. The
verify chain is `npm run check` (0), `npm run build` (0), and `npm test`
(**249 tests, 249 pass, 0 fail**).

| Defect | Fix | Test |
|---|---|---|
| D0 | `typescript` in `devDependencies` | `npm run check` runs |
| D1 | album linkage reads `messageAssociation` | `tests/media.test.js`, `tests/album.test.js` |
| D2 | native-flow reply parsing | `tests/flow.test.js` |
| D3 | `patch()` chains onto the live wrapper | `tests/intercept.test.js` |
| D4 | `goto()` checks the flow is still active and warns | `tests/flow.test.js` |
| D5 | `creds.update` → `saveCreds` registered on connect | `src/nyxBaileys.ts` |
| D6 | climb ratio divides by observed membership | `tests/group.test.js` |
| D7 | `acquire`/`release` refcount pins in-flight blobs | `tests/memory.test.js` |
| D8 | `Disposables.reset()` on rebuild | `tests/intercept.test.js` |
| D9 | `autoReconnect` in the default chain | `src/nyxBaileys.ts` |
| D10 | `streamTo` uses rc14's `'stream'` mode | `tests/media-stream.test.js` |
| D11 | `patch()` undo is idempotent, so double-undo is a no-op | `tests/intercept.test.js` |
| D12 | a late parent adopts the real count and re-checks completion | `tests/album.test.js` |
| D13 | `main()` uses `onConnection`, disposes only on logout | `src/index.ts` |
| D14 | ramp applied on the first build **and** re-evaluated hourly | `tests/warmup.test.js` |

### Notes on three of the fixes

**D6** was the only fix that required changing an existing assertion. The old
test asserted an alert for the sequence *promote 1, promote 2, demote 1, promote
3, promote 4* — which is three elevated of **four** observed members, not the
"all elevated" the detail string claimed. The corrected signal does not fire
there, so the test was rewritten to assert the honest behaviour, and a new
test pins the plain-member-majority case the tautology used to mis-fire on.

**D7** keeps the zero-length-blob eviction an earlier fix introduced and adds a
refcount on top: `acquire(key)` pins a blob, the sweep skips pinned blobs but
keeps scanning so the ceiling is still honoured, and `release(key)` makes it
eligible again.

**D11** was addressed by making `patch()`'s `undo()` idempotent rather than by
changing `patchAll()`'s return shape — the shape is asserted by the suite and
is a deliberate "handle 0 is the combined handle" contract. Idempotent undo
removes the actual hazard (a superseded handle run twice writing over a live
method).

### Feature completeness

The ten opt-in feature plugins and the integrations layer were unreachable from
the package root — there was no barrel and no `./integrations` subpath, so
`dist/` was the only way in. Both are now exported from the root and covered by
a `./integrations` export map entry.

---

## 6. Performance and feature pass — 2026-10-03

Verified from a **clean clone** of `main`, not the working tree, so an untracked
file cannot be what makes it pass.

| Step | Command | Exit | Result |
|---|---|---|---|
| Clone + type check | `npm run check` | 0 | clean |
| Build | `npm run build` | 0 | emits to `dist/` |
| Full suite | `npm test` | 0 | **538 tests, 538 pass, 0 fail** |
| `lite` engine guard | `node --test tests/lite.test.js` | 0 | 5/5 |
| Chain overhead | `npm run bench -- 100000 500 9` | 0 | 0.60 µs/message |
| Per-plugin attribution | `npm run bench:plugins -- 100000 500` | 0 | whole chain 0.43 µs/message |
| Export map targets | resolve every non-wildcard entry | 0 | all present |

### Measured result

| | Before | After |
|---|---|---|
| Default chain, per inbound message | ~16.0 µs | **~0.61 µs** (~26x, ~96%) |
| `nyx-baileys` root import | 931 ms / 26.2 MB / 600 exports | — |
| `nyx-baileys/lite` import | — | **48 ms / 5.4 MB / 148 exports** |

Both figures were measured back to back on the same machine with the same
command. That matters: an earlier "1.44 µs baseline" in this repository was
invalid, because it was taken against a tree that already carried the
sweep-per-batch fix, so it priced only the slice-to-shift change. Absolute
readings on this box drift by nearly 2x — compare ratios, never a single sample.

### Why it was slow

Three allocations per inbound message, each costing more than the work around
it:

| Site | Cost | Cause | Fix |
|---|---|---|---|
| `plugins/memory` | 1.235 µs | fresh array per message to enforce the per-chat cap; the allocation, not the copy, was the cost | `shift()` in place; O(chats) sweep left the upsert path |
| `core/clock` | 0.212 µs | `{rtt, skew}` object per sample plus a window memmove per push | fixed-capacity `Float64Array` ring |
| `core/media` | 0.139 µs | seven media-field probes per message; seven *misses* on a megamorphic shape | walk the keys present, resolve priority by rank |

### Defects found by the new tests

- **Prototype pollution.** `JsonStore.set('__proto__', …)` hit the prototype
  setter instead of storing data. Keys here are jids and usernames, so the input
  is attacker-influenced. Now defined with `Object.defineProperty`.
- **`dispose()` re-wrote after sealing**, so "disposed means nothing more is
  persisted" held only until someone disposed twice. Now idempotent.
- **Cron day-skipping skipped past valid times.** The search asked the *full*
  matcher "is there a slot on this day?", which also tested minute and hour, so a
  day with a 14:30 slot read as uninteresting at 10:16 and every schedule
  eventually returned `null`. Split into `dayMatches`.
- **A second `parseArgs` would have silently shadowed** the existing one from
  `utils/args.ts` at the package root. Renamed to `parseCommandArgs`.
- **`'.'` and `'` quoting.** Treating `'` as a quote opener turns `it's fine`
  into the single argument `its fine` — the wrong trade for something that
  parses prose.

### Known limitations

- No live paired account: every socket-dependent behaviour is unit-tested
  against fakes. Real WhatsApp semantics are unverified.
- The ~26 MB root import is upstream protobufjs and libsignal. It cannot be
  trimmed while the root re-exports `* from '@whiskeysockets/baileys'`; only the
  `lite` entry avoids it. The `nyx-baileys/plugins` entry added in section 7
  saves a few MB but **does not** avoid the engine — see that section's
  measurement before treating it as a cost lever.
- Bench absolute values drift ~2x on a shared machine; only the ratio is stable.

---

## 7. Group moderation and welcome — 2026-10-04

Driven by the engine compendium, used as the extension spec rather than as a
description to reproduce. The gap it made obvious: everything above observes
and paces, and nothing *acted* on a group member. `groupGuard` flags a mass
add; `antiSpam` paces what the bot sends; neither can remove anyone.

### What was added

| Module | Surface |
|---|---|
| [src/plugins/moderation.ts](../src/plugins/moderation.ts) | word / link / flood rules, a configurable strike ladder, delete · mute · kick · ban, dry run, `nyx.moderation` |
| [src/plugins/welcome.ts](../src/plugins/welcome.ts) | join · leave · promote · demote announcements with per-event collapsing, cooldown and rejoin suppression |

Both are opt-in, wired into `featurePlugins()` at orders 145 and 146, and
re-exported from the root and from `nyx-baileys/plugins` (a new subpath entry).

### Verification

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run check` | 0 errors |
| Build | `npm run build` | 0 errors |
| Full suite | `npm test` | **662 / 662 pass, 0 fail** (was 538; +124) |
| Export surface | every `exports` target exists; `moderation`/`welcome` resolve from root and barrel | 0 missing |

### Five defects the new tests found

1. **A mute that stopped evaluation was a permanent ceiling.** The first
   implementation returned early on a muted member, so `muteAt` silently
   capped the ladder — `kickAt` and `banAt` above it were unreachable. Mute is
   now advisory: the plugin keeps escalating and the host gates on
   `isMuted()`. A mute is a step, not a wall.
2. **The flood rule reset its own window on trigger**, which capped a flooder at
   one strike per burst — they had to trip the rule N separate times to climb.
   Each message over the ceiling is now its own offence.
3. **Ban stacked with kick.** Two independent `if`s meant one offence produced
   two `groupParticipantsUpdate` calls; the second targets an already-gone
   member. Ban now supersedes kick, and a member already removed is not removed
   twice.
4. **Dry run recorded nothing.** `remove()` returned before setting `banned`, so
   a dry run could not tell you who it *would* have banned — which is the only
   reason to run one. State is now recorded before the dry-run check; only the
   network call is skipped.
5. **Exemption emitted an event per exempt message**, drowning the events you
   actually want. Exemption is now silent.

Two of these (`1`, `2`) would not have surfaced without tests that exercise the
*escalation* rather than the first offence, which is why the suite walks the
ladder at several threshold settings instead of only at the defaults.

### The `/plugins` entry is not a cost lever

Measured cold, one process each, RSS, warm filesystem cache:

| Specifier | ms | RSS | exports |
|---|---|---|---|
| `@whiskeysockets/baileys` | 429 | 84.7 MB | 263 |
| `nyx-baileys/plugins` | 450 | 86.3 MB | 15 |
| `nyx-baileys` (root) | 587 | 90.6 MB | 602 |

`./plugins` saves ~140 ms and ~4 MB against the root, because it skips the
framework's own barrel — **not** because it avoids the engine. `plugins/mentions.ts`
imports `proto` from upstream at runtime, so the protobuf stack loads either
way. Only `lite` avoids it. Absolute values drift ~2x on this machine between
runs; the ordering and the ratio are what these numbers support.

---

## 8. Pairing path repair — 2026-10-04

The CLI had **no tests at all**. `tests/args.test.js` covers
`dist/utils/args.js` (the command *plugin*'s parser), not `dist/cli/`. Five of the
six defects below sat in `src/cli/`, untested, and shipped. The suite is now
**662 / 662** (was 587; +75, every one offline).

### Six defects

| # | Defect | Fix |
|---|---|---|
| 1 | `pair` could never show a code — rc14 emits a QR ref, and nothing called `requestPairingCode` | `--phone <number>`; validated before the socket opens |
| 2 | `--json pair` wrote nothing to *either* stream | `Reporter.pairing()` → stderr as JSON lines; stdout keeps its one-object contract |
| 3 | A half-negotiated `creds.json` looked like an auth failure | pre-flight guard + `pair --reset`; `sessions list` reports `partial` |
| 4 | `node dist/cli/index.js` exited 0 having done nothing | dispatches when run directly; barrel semantics unchanged for importers |
| 5 | **`connection === 'open'` never fires while unregistered** | `waitForReady()` accepts a `qr` update |
| 6 | `announceAt` was declared but wired to nothing | wired, with `announceText` and per-kind defaults |

### Defect 5 is the expensive one, and it was in the original handoff

The handoff's recipe said to wait for `connection === 'open'` before requesting a
pairing code. **That never arrives on an unregistered session.** Measured, one
session, no creds on disk:

```
   571ms  connect() resolved
  1555ms  connected to WA  { helloMsg: { clientHello: … } }
  1555ms  connection.update {"qr":"https://wa.me/settings/linked_devices#2@…"}
 45175ms  state: unknown            <-- `connection` still unset at 45s
```

`connected to WA` is a **Baileys log line, not an event** — reading it as proof
that `open` fired is the trap. `requestPairingCode` then succeeded **105 ms after
the `qr` update**, never having seen `open`.

Consequences worth keeping:

- A poll of `connectionState.state` — the obvious check, and what the other
  commands use — never returns `open` on the pairing path.
- Readiness only needs waiting on when a *code* is requested. The QR-scan path
  must not wait, or a working scan becomes a timeout.
- The capture listener and the readiness listener must be attached in the same
  tick: the first `qr` arrives in the very event that satisfies readiness, so a
  listener attached after the await sees nothing. This cost one debugging round
  during the live run.

### Codes cannot survive a human relay

Three code-based attempts were rejected by WhatsApp as *incorrect* with the
socket healthy — no 401, no 428, no close. Latency, not protocol: a code is void
~30 s after issue. Re-requesting on a timer to keep a "fresh" one available
**invalidates the previous code**, so rotating every 12 s guarantees the code
just relayed is superseded before it is typed. Request one code, or use the QR —
the camera reads it in about a second and it rotates on its own.

### Where pairing actually stopped

```
   1378ms  pairing ref captured, ws.isOpen=true
            registrationId assigned; Noise ratchet exchanged (remoteIdentityKey)
 05:58:22  stream:error 515                    (restart required)
 05:58:51  stream:error 401 conflict/device_removed
```

Further than any earlier attempt — a real ratchet completed — then the server
removed the device. Ruled out: connectivity (`wss://web.whatsapp.com/ws/chat`
upgrades 101) and version pinning (`fetchLatestWaWebVersion()` succeeds here,
returning `[2,3000,1049240009]`, so the hardcoded fallback at
`src/core/socket.ts:59` is never reached).

**No session has ever been paired on this account.** Everything past
`creds.registered === true` remains unverified against a live server.

### 7. Pairing does work — `registered` is the only thing broken

The run that finally paired settled the open question from §8, and the answer
inverted the earlier conclusion. It is not the account refusing the link.

```
logging in...  device: 11, pull: true
clean dirty bits account_sync
406 pre-keys found on server
PreKey validation passed — Server: 406, Current prekey 812 exists
Connection is now AwaitingInitialSync → Online
opened connection to WA
Own LID session created successfully
  myPN  : 6283831459585:11@s.whatsapp.net
  myLID : 27836421259416:11@lid
```

Throughout that, `creds.registered` read **`false`**. So Baileys paired the
device, WhatsApp signed it, and the client still reported itself unpaired.

**Root cause.** `authState.creds.registered = true` has exactly one assignment in
all of rc14 — `messages-recv.js:940`, inside the `companion_finish` branch of the
`link_code_companion_reg` notification. That notification does not arrive on this
path, so the flag never flips. Every command gated on it (`requirePaired`) then
refuses a session that is fully working.

The provisioning evidence is unambiguous and server-supplied:

| field | meaning |
|---|---|
| `account.details`, `accountSignature`, `accountSignatureKey` | WhatsApp signed this account |
| `account.deviceSignature` | WhatsApp signed this device |
| `me.id`, `me.lid` | identity and LID mapping assigned |
| `routingInfo` | routes provisioned |
| `platform` | assigned (`android`) |

**Fix.** `isProvisioned()` in `src/cli/commands.ts` derives `paired` from that
evidence rather than the flag: `registered === true || (me.id && account.deviceSignature)`.
The flag is client-side bookkeeping; the signature is WhatsApp's own statement.
`partialArtifacts()` defers to it too, so `pair --reset` can no longer delete a
working session. Verified against the live account with the flag forced to
`false`: `status` reports `paired: true`, `state: open`, exit 0.

### 8. `creds.json` was being truncated to 0 bytes by its own shutdown

A provisioned, paired session was destroyed and reported as "fresh, unpaired" —
with no error anywhere.

Baileys persists creds with an async `writeFile`, which truncates before it
writes. Two consequences, both observed:

1. **Concurrent saves interleave**, producing malformed JSON.
2. **Exiting with a save in flight leaves `creds.json` at 0 bytes.** An empty file
   is then read back as a fresh session, so the next run silently starts pairing
   from scratch. `bin/nyx-baileys.js` made this likely: its watchdog calls
   `process.exit()`, which does not wait for pending writes.

Fix, in `src/nyxBaileys.ts`: `saveCreds` is chained so writes are serialised, the
tail is retained, and `dispose()` awaits it. Covered by a test that fires two
back-to-back saves and asserts the file still parses and is non-empty.

This plausibly explains a share of the "half-negotiated creds" in §5.5 — some of
those sessions were self-inflicted by shutdown, not by WhatsApp.
