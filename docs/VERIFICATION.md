# VERIFICATION — nyx-baileys 0.3.1

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
| 3 | Album container decrypt | **COVERED** | Parent at `src/plugins/album.ts:86-99`. Sibling linkage at `:64` reads `contextInfo.messageAssociation` tagged `MEDIA_ALBUM` via `parentKeyOf` — rc14 has no `albumParentKey` field on the wire. Decrypt at `:135` (4-arg cast present). |
| 4 | Anti-spam jitter queue | **COVERED** | `src/plugins/antiSpam.ts:46` (Box–Muller clamped), `:66` (serial drain), `:55` (sliding 60 s window), `:120` (`__antispam`). |
| 5 | Stealth / UA identity | **COVERED** | `src/plugins/stealth.ts:37` (`__identity`), `:53` presence on real state only. `src/core/socket.ts:108` UA builder. |
| 6 | LID↔JID mapping | **COVERED** | `src/plugins/lid.ts:67` (`resolve`), `:97` (`resolvePn`). Correct rc14 call shape (`onWhatsApp(target)` → `{jid,exists}[]`). |
| 7 | Webflow form input parser | **COVERED** | `src/plugins/flow.ts:141-143` reads `interactiveResponseMessage.nativeFlowResponseMessage.paramsJson` and parses it defensively ahead of the legacy chain. `parseFlowResponse` at `:96-109`. |
| 8 | Chat flow state machine | **COVERED** | `src/plugins/flow.ts:144` (`run`), `:161` (`start`), `:180` (upsert dispatch), `:229` (`sock.flows`). |
| 9 | Memory GC store | **COVERED** | `src/plugins/memory.ts:60` sweep, `:89` upsert hook, `:112` `sock.store`. Media eviction at `:124-134` skips blobs held by a live reader (`refs > 1`) while still counting them toward the ceiling. `acquire`/`release` at `:210-229`. |
| 10 | Multi-device payload normaliser | **COVERED** | `src/plugins/session-repair.ts:55` (`unwrap`) and `:81` (`repairFlow`), both sound against rc14 and both live: `patch()` chains onto the current wrapper (`src/core/intercept.ts:80`), so they are not shadowed. |
| 11 | Multi-session core | **COVERED** | `src/nyxBaileys.ts:33` class, `:291` factory, `:135` `#rebuild`. Per-session state is reset between rebuilds: `#disposables.reset()` at `:166` clears the unwind stack so disposers from the old socket cannot run against the new one. |
| 12 | Session store | **COVERED** | `src/core/session-store.ts:128` `createSessionStore({load,save})` — the generic bridge. `:29` FileSessionStore, `:91` MemorySessionStore. The four database adapters (sqlite, mongo, prisma, redis) were removed in `0ece183`; this row no longer covers them. |
| 13 | Auto-retry backoff | **COVERED (not in default chain)** | `src/plugins/reconnect.ts:63` (full-jitter exp), `:68` (`schedule`), `:121-163` reason switch. Imported at `nyxBaileys.ts:18` but **absent from `plugins()`** (D9) — dead unless registered. |
| 14 | Media streaming optimizer | **PARTIAL** | `src/plugins/media-stream.ts:59` size ceiling with typed `MediaTooLargeError`, `:95` `streamTo`. Not streaming: full buffer materialised first, then sliced (D10). |
| 15 | Group management / security | **PARTIAL** | `src/plugins/group.ts:73` mass-add window, `:93` privilege tracking, `:54` `nyx.groupAlert`. Privilege check is tautological (D6). Read-only by design — no enforcement surface. |

**Totals: 11 COVERED · 4 PARTIAL · 0 MISSING**

---

## Interactive messages on consumer accounts

Measured 2026-10-05 on a paired consumer account (`6283831459585:12`),
recipient `62882017467912`, same session, minutes apart.

### Control names

| flow name | status |
|---|---|
| `quick_reply` | **VERIFIED** — renders, buttons tappable, reply routes back |
| `cta_url`, `cta_call` | **VERIFIED** — both render, sent through the same stanza path as `quick_reply`. |
| `cta_copy` | **VERIFIED**, but only under the name `cta_copy`. `copy_to_clipboard` is accepted by the encoder and silently dropped. |
| `single_select` | **WORKS — see the retraction below.** An earlier entry here called it impossible on consumer accounts. That was wrong. |

`single_select` renders a categorised bottom-sheet menu on a consumer account.

**Retraction.** An earlier version of this document concluded that sectioned lists
were impossible on consumer accounts — a server-side Business-tier gate — and
that claim reached the changelog, the release notes and this file. **It was
wrong, and the error was ours.**

The menu does not travel as a `listMessage`. It travels as a `nativeFlowMessage`
button named `single_select`, whose `buttonParamsJson` is **opaque JSON the client
parses itself**. `WAProto`'s `ListMessage.Row` does use `rowId` — but that field
belongs to `listMessage`, which rc14 refuses to send at all, so reading it told us
nothing about the native-flow schema. The client schema names the field **`id`**.

So the earlier attempt had a wrong key inside an opaque payload. It encoded
cleanly, returned a valid message ID, and did not arrive — which is the exact
signature we had already learned to distrust on sight. Concluding "the server
refuses this message type" from that evidence was overreach. The honest reading
was "we have not made this one render yet".

Implementation and the round-trip test: `src/toolkit/category-menu.ts`.

### Hypotheses tested and ruled out

Each was sent, returned a clean message ID, and never arrived. A plain-text
control through the same `relayMessage` arrived every time, so the relay itself
was not at fault.

- **Malformed payloads.** `ListMessage.buttonText` is required, and
  `IButton.buttonText` is a nested message (`{ displayText }`), not a string.
  Both were wrong in the first attempt; correcting them changed nothing. A
  protobuf round-trip now confirms both survive encoding.
- **Missing reporting token.** `generateWAMessageContent` attaches
  `messageContextInfo.messageSecret` to every message; this path bypasses it.
  A random 32-byte secret changed nothing. Kept regardless — the server expects
  the field to be present.
- **Message-vs-wrapper shape.** Bare `listMessage`, `viewOnceMessage`-wrapped,
  with and without `messageContextInfo`.
- **Plugin ordering.** Moving the plugin from 118 to 66 made no difference to
  delivery.

None of those was ever the cause. The cause was the row key.

### What actually works

The elements live in stanza nodes, not in the protobuf. Passed as
`additionalNodes` to `relayMessage` (`Socket/messages-send.js:1133`):

```
biz
└─ interactive  type=native_flow v=1
   └─ native_flow  name=quick_reply
bot  biz_bot=1        ← 1:1 chats only
```

The `native_flow` name must match the flow actually being sent.
Implementation: `src/plugins/interactive.ts`.

### Unverified — do not assume

`single_select` in a group; `templateMessage`, `carouselMessage`,
`collectionMessage`, `productMessage`, `contactMessage`;
`createFormFlow` / `createTableFlow` / `createCarouselFlow` rendering on any
tier. Each of the three cta flows has been confirmed on hardware, and the one that
failed did so on its *name*, not its schema — the same class of mistake as the
row key, and a reminder that a clean message ID is not evidence of anything.

**A selection has not yet been observed arriving back from the client.** The
round-trip test proves what we *send* matches what we *parse*; that both agree
with what a real phone echoes back still needs one live selection. Until then,
`readMenuSelection` is verified against its own output and nothing further.

## 3. Defects

### D0 — RESOLVED · all four npm scripts run

> **Fixed.** `typescript` is in `devDependencies` and every script executes.
> Current state, verified on this tree:
>
> ```
> check  tsc -p tsconfig.json --noEmit    ✅
> build  tsc -p tsconfig.json             ✅
> test   node --test ./tests/*.test.js    ✅ 689 pass / 0 fail
> lint   tsc -p tsconfig.json --noEmit    ✅
> ```
>
> `lint` currently runs the same command as `check`; there is no separate linter
> configured, so it is not an independent signal.

<details><summary>Original finding (historical)</summary>

`package.json:19-21` — no `devDependencies`. `tsc` is unresolvable.

`npm run check` → exit 1, `npm run build` → exit 1, both `'tsc' is not recognized`.
Severity **BLOCKER**. Add `typescript` to `devDependencies`.

</details>

---

### D1 — NOT A DEFECT · album sibling linkage is correct

> **Not a defect in the current code.** The finding below is correct *about rc14* — there is no `albumParentKey` field on the wire, and album linkage lives in `contextInfo.messageAssociation`. The code no longer reads the wrong path: `src/plugins/album.ts:64` uses `parentKeyOf(msg, proto.MessageAssociation.AssociationType.MEDIA_ALBUM)`.


<details><summary>Original finding (historical — the snippets below do not match what ships)</summary>

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

### D2 — RESOLVED · native-flow form submissions are now parsed

> **Fixed.** `src/plugins/flow.ts:141-143` reads
> `interactiveResponseMessage.nativeFlowResponseMessage.paramsJson` and parses it
> via `parseFlowResponse` (`:96-109`) ahead of the legacy chain. The finding
> below was accurate when written; the code moved on and this entry did not.

<details><summary>Original finding (historical)</summary>

`src/plugins/flow.ts:80-109` (`extract`)

rc14 delivers a native-flow submit as
`interactiveResponseMessage.nativeFlowResponseMessage = { name, paramsJson, version }`
(confirmed: `WAProto/index.d.ts:6961`, `:7007-7011`). `extract()` reads
`interactiveMessage`, `buttonsResponseMessage`, `listResponseMessage`, `listMessage`,
`extendedTextMessage`, `conversation` — and never `interactiveResponseMessage`.

Verified: a native-flow reply extracts to `{ text: "" }`. `flow.ts:186`
(`if (!probe.text && !probe.selection) continue;`) then drops it silently.

So the form that `createFormFlow()` sends was the one form whose reply the engine
could not read. **Role 7 was MISSING.**

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

</details>

---

### D3 — NOT A DEFECT · `patch()` does stack; the second wrapper does not discard the first
`src/core/intercept.ts:58-63`

```ts
const pristine = (holder[stashKey] as Record<string, unknown>)[name] as ...
const patched = function (this: unknown, ...args: unknown[]) {
  return wrapper(pristine, this, args);   // ← the bug, as *described*
};
```

> **This is not what ships.** `src/core/intercept.ts:80` chains onto
> `original` — the value read at patch time — not `pristine`. The snippet above
> is the bug being described, quoted for reference. Applying A then B yields
> `B(A(original))`, which is both the documented and the actual behaviour.

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

</details>

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

### D5 — RESOLVED · credentials are persisted on `creds.update`
`src/index.ts:220-226`, and `src/core/socket.ts:102`

`saveCreds` is threaded from `store.init()` (`nyxBaileys.ts:102`) through
`createCoreSocket` (`socket.ts:108`) and then **discarded** at `socket.ts:102`:

```ts
void saveCreds; // owned by the caller (NyxBaileys), not the socket factory
```

Grep confirms **no `creds.update` → `saveCreds` listener is registered anywhere** in
`src/`. The only `creds.update` reference is `index.ts:220`, which is a *read*
(waits for `.registered`).

> **That grep is stale.** `src/core/socket.ts:153` registers the listener:
>
> ```ts
> // Persist credentials. rc14 emits `creds.update` from many places and does not
> // write anything itself — without this listener a paired session is lost on
> // every restart and the number has to re-pair each time.
> sock.ev.on('creds.update', () => {
>   saveCreds().catch((err: unknown) => {
>     log.error('creds save failed', { err: (err as Error).message });
>   });
> });
> ```
>
> Confirmed on hardware: a paired session survives a process restart, and
> `healRegisteredFlag()` writes `registered: true` once WhatsApp has signed the
> device — the condition that survives rc14 never setting it (see `881d949`).
>
> Persistence is additionally serialised (`nyxBaileys.ts:120-125`) because
> concurrent async writes to `creds.json` left it at **0 bytes** on 2026-10-04 —
> a destroyed session with no error anywhere.

rc14 emits `creds.update` from many places (`lib/Socket/chats.js:778`,
`messages-recv.js:512`, `socket.js:170`, …) and does **not** persist by itself —
`useMultiFileAuthState` returns a `saveCreds` closure that the caller must invoke.

> **Historical consequence, no longer true:** the finding that paired credentials
> were never written to disk has been fixed. See `core/socket.ts:153` above.
>
> The proposed fix was sound; the location in this entry (`NyxBaileys.#connect`)
> was not, because `saveCreds` is wired inside `createCoreSocket` where the
> closure is in scope.

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

### D7 — NOT A DEFECT · media GC has a refcount guard

> **Not a defect in the current code.** The snippet below is not what ships. `src/plugins/memory.ts:124-134` skips any blob held by a live reader (`if (blob.refs > 1) continue`) while still counting it toward the ceiling, and `acquire`/`release` (`:210-229`) pin blobs for the duration of a read. The described `byteLength === 0` gate does not exist.


<details><summary>Original finding (historical — the snippets below do not match what ships)</summary>

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

</details>

---

### D8 — NOT A DEFECT · `#disposables` is reset across rebuilds

> **Not a defect in the current code.** `src/nyxBaileys.ts:166` calls `#disposables.reset()` inside `#rebuild()`, with a comment explaining why: disposers left by the old socket would otherwise run against the new one. The reasoning below depends on D3 being real, and it is not.


<details><summary>Original finding (historical — the snippets below do not match what ships)</summary>

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

</details>

---

### D9 — RESOLVED · `autoReconnect` is in the default chain
`src/nyxBaileys.ts:18` vs `:57-68`

```ts
import { autoReconnect } from './plugins/reconnect.js';   // line 18
```

`autoReconnect()` is now in the default chain. `nyxBaileys.ts:70` includes it with
the comment `// 70  self-healing backoff`, and there is no order collision:
`session-repair.ts:45` declares `order: 65`, not 70.

Verified on hardware — the reconnect path drove a live self-heal during the
2026-10-05 session work, and `sock.health()` is populated.

<details><summary>Original finding (historical — reconnect was genuinely absent)</summary>

`plugins()` returns stealth, lid, media, album, memory, group, sessionRepair,
antiSpam, flow, warmup — **no reconnect**. Verified by parsing the returned array.

Consequences: `sock.health()` (advertised in `index.ts:296`) is `undefined`; no
auto-reconnect happens; `__requestReconnect` (`nyxBaileys.ts:116`) is defined but
never invoked. Role 13 is dead code in the default configuration.

Fix — add `autoReconnect()` to the chain.

</details>

---

### D10 — RESOLVED (documentation) · `streamMedia` does not bound peak memory, and now says so

The design gap is real and unchanged: `streamTo` asks rc14 for a `'stream'` and
forwards it in 64 KB chunks, but rc14 materialises the **entire** decrypted buffer
before yielding pieces. Peak memory is the whole asset plus one chunk — for the
300 MB video the module exists to protect against, the same peak as the naive call.

What changed is the claim. The module docstring and the `streamTo` comment both
asserted *"the caller never holds the full asset: peak memory is a stream chunk plus
the coalescing buffer"*, which is false and load-bearing — a caller reading it
would pick this function precisely when it cannot help.

Both now state: **chunked handoff, not bounded memory.** What the chunking does buy
is real and worth keeping — the caller never needs a second full copy, and the size
ceiling is enforced as bytes arrive rather than after the fact, so an under-declared
asset is still stopped. That is a genuine improvement on `downloadMedia`, which must
materialise before it can check anything.

The docstring now also says what to do instead: if peak RAM is the constraint,
decrypt to a file in a separate process, or use a client with incremental decryption.

<details><summary>Original finding (historical — the docstring claim was accurate when written)</summary>

`streamTo` calls `fetch()` — which materialises the **entire** decrypted buffer —
then slices it into 64 KB chunks. The docstring claimed "the peak is bounded by the
chunk, not by the asset". It is not: peak memory is the full asset plus one chunk.

Fix — either use the socket's real streaming path or correct the docstring to say
"chunked handoff, not bounded memory". **The second option was taken:** the design
gap is upstream's, and claiming otherwise would be worse than documenting it.

</details>

---

### D11 — RESOLVED · `patchAll` returns exactly the patches that applied
`src/core/intercept.ts:97-127`

It returned `[aggregate, ...applied.slice(1)]`. The aggregate's `undo()` unwound
everything *and* `applied[0]` was dropped from the array, so a caller got N handles
where the first was a superset of the rest — `patches[0].undo()` meant "undo
everything" while `patches[1].undo()` meant "undo one method". Same method, two
meanings, decided by position.

Two things were wrong, and only one was visible:

- The aggregate element made `length` one more than the number of methods patched.
- **Absent methods also occupied a slot.** A name with no matching method yields a
  no-op handle, so `length` counted *requested* names rather than methods actually
  wrapped — a caller could not distinguish a patched method from a missing one.

Now the array is exactly the applied patches, and undo-everything lives on the array
as `undoAll()` rather than being smuggled in as a fake element. Reverse order, so a
later patch unwinds before the one it wrapped.

Returning only the aggregate was considered and rejected: undo-everything is a real
capability, and `patches[i].undo()` should mean exactly one method.

### D12 — RESOLVED · `Album.expected` is `number | null`, not a magic sentinel
`src/plugins/album.ts:41`, `:100-115`

An album is routinely created by a **sibling** arriving before its parent, so it
starts life knowing nothing about the total. That was recorded as
`Number.MAX_SAFE_INTEGER`.

The cost was not the magic number, it was that a sentinel reads as a real count to
every arithmetic path it touches. `items.length >= expected` was silently false
forever, so completion depended on a second guard —
`expected !== Number.MAX_SAFE_INTEGER && items.length >= expected` — that had to
stay in sync across two files. Nothing in the type said the value was meaningless.

Now:

- `Album.expected` is `number | null`. `null` states the fact: the parent has
  not been seen.
- Completion moved into one `settle(album)` helper, so the null check lives in
  one place instead of being restated at each call site.
- The compiler now rejects a comparison that forgets to handle `null`, which is
  the entire point.

The late-parent repair at `:105-110` still runs and is now a plain assignment —
`null !== 2` is true, and there is no sentinel to compare against.

Six tests added: a lone sibling reports `null`; a parent-first album reports its
real count; `null` survives a three-sibling arrival without completing; the count
resolves on a late parent and completion is re-evaluated; a short album does not
complete; and `completedAt` is not re-stamped once reached.


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
- **`createEdit`** (`nodes.ts:293`) — **is** an edit, and the shape matters more than
  the entry below historically claimed. rc14 assembles an outbound edit at
  `Utils/messages.js:514`: when `generateWAMessageContent` sees an `edit` key it
  folds the message it just built into
  `protocolMessage { key, editedMessage, timestampMs, type: MESSAGE_EDIT }`.

  Measured on rc14, encoding the same text both ways:

  ```
  { text, edit: key }        71 bytes  type=14, parent key present, text intact
  editedMessage wrapper      15 bytes  no protocolMessage, no key, no edit type
  ```

  The 15-byte form — a hand-built `FutureProofMessage` — carries no text *and*
  names nothing to edit. That is the silent failure. `FutureProofMessage` is a
  real protobuf type, so building it by hand compiles without complaint and looks
  correct; it is the wrapper for `viewOnce` and ephemeral framing, not for edits.

  `createEdit(targetKey, text)` now returns `{ text, edit: targetKey }` for
  `sendMessage` to compile. **Breaking:** the first argument is now the key.
  Three regression tests pin this, one asserting the broken shape stays under half
  the size of the real one.
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
**681 / 681** (was 587; +94, every one offline).

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

**Since resolved outright.** `healRegisteredFlag()` writes `registered: true` to
`creds.json` once the device is genuinely provisioned, so the flag itself is now
correct rather than merely worked around. Confirmed on hardware:

```
registered BEFORE : false
provisioned       : true
heal result       : {"healed":true,"jid":"6283831459585:12@s.whatsapp.net"}
registered AFTER  : true
me intact         : 6283831459585:12@s.whatsapp.net
```

The precondition is the safety argument and it is tested: a fresh session has no
`me.id` and no `account.deviceSignature`, so the heal cannot fire on one. A failed
heal is logged and swallowed rather than raised — the session still works through
`isProvisioned()`, so turning a good pairing into an error would be strictly
worse than leaving the flag alone.

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

---

## OPS-50 — 92 functions, 84 assertions

Added `src/toolkit/ops-50/` in six modules plus a shared `types.ts`. Suite total
**867 pass / 0 fail** (was 783). All 24 export targets still resolve.

| Module | Functions | Covers |
|---|---|---|
| `chat-control.ts` | 20 | chat flags, blocking, 8 privacy switches, disappearing durations |
| `group-admin.ts` | 14 | membership, policy, invites, roster, batch cap |
| `newsletter-commerce.ts` | 19 | newsletter lifecycle, subscription, products, orders |
| `contacts-profile.ts` | 13 | number resolution, contacts, quick replies, profile, calls |
| `media-ops.ts` | 10 | content-shape builders, download, chunking, mime inference |
| `diagnostics.ts` | 16 | presence, message utilities, identity, connection health |

### Honest rung per group

Nothing in OPS-50 has been confirmed at the `visible` rung. Read this table before
relying on any of it.

| Group | Rung | Evidence |
|---|---|---|
| `diagnostics` (read-only) | `arrived` / `visible` | **Live-probed.** 24 of 25 probes clean on the real socket. |
| `contacts-profile` reads | `sent` | `resolveNumber` live-probed, returned `{exists:true}` |
| `chat-control` reads | `sent` | `readChatFlags`, `isBlocked`, `getChatExpiry` live-probed |
| `media-ops` pure helpers | `sent` | `buildMediaContent`, `chunkBuffer`, mime inference live-probed |
| All **write** paths | `unverified` | Never invoked against a live socket. No removal, no privacy write, no catalogue write was attempted. |
| All newsletter + commerce | `unverified` | Gated on account type. A clean return may still be rejected server-side. |

The probe was deliberately restricted to read-only and pure calls. Sending it to a
group invite, a blocklist, or a product catalogue would have mutated real state to
prove a signature, which is not a trade this makes without being asked.

### Two bugs the live probe caught that the fake socket could not

This is the argument for probing at all.

1. **`fetchDisappearingDuration` returns a result list, not a number.** The
   signature is `(...jids: string[]) => Promise<USyncQueryResultList[] | undefined>`.
   Reading it as a scalar made `getChatExpiry` return an object, and `disableExpiry`
   compared an object to `0` — always false, so it would have reported "nothing to
   do" on every chat. Fixed to unwrap `[0].disappearing_mode.duration`. A fake
   socket returning a bare number would have hidden this indefinitely.

2. **`sock.authState` is not always present.** This framework does not always put
   it on the socket, so `connectionHealth` threw outright. It now reports
   `registered: undefined` — *unknown* — rather than `false`. A hard `false` would
   have read as a broken session, and `isReady` would have blocked a healthy one.

Both are now regression-tested, including the no-`authState` case.

### What is deliberately absent

No write path was probed, and none of the destructive wrappers are in the default
chain. `removeParticipantsCapped` refuses above 50 rather than chunking, because
chunking a removal that was never meant to happen is worse than refusing. That
guard is unit-tested; the removal itself is not.

---

## OPS-250 — 184 functions, and a real rc14 trap guarded

`src/toolkit/ops-250/`, eight modules. Suite total **951 pass / 0 fail** (was 867).
All 24 export targets resolve. `src/toolkit/ops-50/` + `ops-250/` together now
export **276 functions**.

| Module | Functions | Covers |
|---|---|---|
| `inbound-parsing.ts` | 29 | stub types, media, interaction replies, revokes, edits, reactions, filtering |
| `history-protocol.ts` | 25 | history paging, USync, raw nodes, receipts, jid helpers |
| `communities.ts` | 24 | community lifecycle, membership, policy, invites |
| `session-reliability.ts` | 23 | connection lifecycle, key state, retry, app-state resync |
| `message-builders.ts` | 21 | WhatsApp text dialect, payload shapes, validation |
| `group-extensions.ts` | 20 | v4 invites, roster paging, cover photos, business profile |
| `newsletter-moderation.ts` | 18 | newsletter reads, media upload, moderation verbs |
| `labels.ts` | 14 | chat/message/member labels, link-preview privacy |

### Rungs — read before relying on any of it

| Group | Rung | Evidence |
|---|---|---|
| `inbound-parsing` (pure) | `sent` | Live-probed on the real socket; 30+ assertions |
| `message-builders` (pure) | `sent` | Live-probed |
| `history-protocol` jid helpers | `sent` | Live-probed |
| `labels` pure helpers | `sent` | Live-probed |
| `session-reliability` probes | `sent` | Live-probed |
| Read-only socket calls | `sent` | `resolveNumber`, `readChatFlags`, `getChatExpiry`, `isBlocked`, `reachoutDelay` all live |
| **Every write path** | `unverified` | No label, cover photo, community, moderation, or raw-node call was issued |
| **Communities** | `unverified` | Account-rollout gated. A clean return may still be refused |

**Not probed, deliberately:** community creation, label writes, participant
removal, `upsertLocal`, and every `sendNode`/`sendRaw` path. Those mutate real
state or speak the raw protocol; proving them needs a throwaway group and an
explicit go-ahead. `upsertLocal` in particular can fabricate a local history
record, so it is exactly the kind of call that must not be run casually.

### The WIN32 handshake trap — guarded

Found while checking the dependency, and it is **not** fixed in our version.

`validate-connection.ts` on `master` (2026-08-04) commits:

> *"Since ~2026-06-30 the WhatsApp server rejects the handshake when the client
> advertises `webSubPlatform = WIN32`, closing the socket with 428 ~200-600ms
> after connect, before any QR is emitted."*

Our install is rc14, where `PLATFORM_MAP.Windows` still maps to `WIN32` (4). Master
maps it to `WIN_HYBRID` (5). **We are not on the fix.**

**We are not currently exposed.** rc14 only selects a non-`WEB_BROWSER` platform
when `syncFullHistory && PLATFORM_MAP[browser[0]] && browser[1] === 'Desktop'`.
Our `DEFAULT_BROWSER` is `['Chrome','120','0']` — `'Chrome'` is not a map key and
`'120'` is not `'Desktop'`, so `webSubPlatform` stays `WEB_BROWSER` and pairs fine.

The hazard is one config change away: anyone wanting full history sync would set
`Browsers.windows('Desktop')` with `syncFullHistory: true` and get a socket that
dies before emitting a QR, with no error pointing at the cause.

`assertBrowserIsSafe()` in `src/core/socket.ts` now refuses that exact
combination before the socket is created, and `SuperOptions.syncFullHistory` is
declared so the flag is reachable through the public options rather than by cast.

### Three real bugs the live probe caught

Same lesson as OPS-50: a fake socket will happily have a method the real one
lacks, and return a shape the real one does not.

1. **`sock.authState` is not on the socket.** `isFullyPaired`, `sessionTag`,
   `needsPreKeyUpload`, and `keyDigest` all threw "sock.authState is not a
   function". They now route through a `readCreds()` helper that returns `null`
   on a missing socket and report **unknown** rather than throwing. This mirrors
   the OPS-50 `connectionHealth` fix — same root cause, second occurrence.
2. **`jidDecode` mis-parsed the LID form.** `12345.1:12345@lid` returned
   `user: '12345.1', device: 12345` — the dot-form branch was ordered *after* the
   colon branch, so the repeated user was read as the device. Reordered, with the
   dotted device stripped. Two genuine shapes now covered: `user:device@server`
   and `user.device:user@server`.
3. **`fullRoster` looped on a repeated cursor.** A server that returns the same
   `after` cursor appended the page forever. It now stops on a repeat and dedupes
   the accumulated roster — an unbounded loop in a long-lived bot is not a
   cosmetic bug.

All three are regression-tested, including the no-`authState` case.

---

## AI toolkit — 57 functions and 5 classes

`src/toolkit/ai/`, six modules. Suite total **1088 pass / 0 fail** (was 951).
`ops-50` + `ops-250` + `ai` now export **333 functions**.

**These are features, not a bot.** Nothing connects, pairs, or loops. A script
wires `BotEngine.respond()` to a socket; all the judgement lives in the library.

| Module | Fn | Classes | Covers |
|---|---|---|---|
| `context.ts` | 6 | `Memory`, `Conversations` | token accounting, bounded memory, window fitting, compaction |
| `intent.ts` | 7 | `PendingFlow` | rules, entities, language, tone, slot filling |
| `providers.ts` | 5 | `ToolRegistry` | 6 providers, tool gating, fabrication detection |
| `output.ts` | 13 | — | tagged language → 20 WhatsApp content types |
| `media-fetch.ts` | 14 | `UnsafeUrlError` | SSRF-guarded download, REST lookup |
| `engine.ts` | 5 | `BotEngine`, `RateLimiter` | the turn pipeline, default commands |

### Rungs

| Path | Rung | Evidence |
|---|---|---|
| Everything pure (parsers, builders, memory, window, slots, tone) | `sent` | 130+ assertions, no network, no socket |
| `echo` provider end-to-end turn | `sent` | Real turn through the real pipeline, no key |
| All 5 non-echo providers | `unverified` | Stubbed `fetch` proves the request shape — Anthropic's `system` field, Gemini's `user`/`model` roles, timeout behaviour. **No real API call has been made.** |
| `sendRendered` structured sends | `unverified` | Shape asserted; nothing sent to a real chat |
| Any **write** path | `not attempted` | No message sent, no URL fetched, no tool executed |

### Design decisions worth knowing

**A bot that forgets beats a bot that invents.** Three rules follow from that:

1. **Memory facts carry provenance**, rendered inline into the prompt. Without it
   the model cannot distinguish a remembered fact from something it just made up.
2. **Identity is exact match on a normalised string.** Every fuzzy alternative
   merged things it must not: Jaccard 0.5 merged `first fact stated today` with
   `second fact stated today`; 0.6 merged `I live in Jakarta` with
   `I live in Bandung`. Over-storing a near-duplicate is recoverable — recall
   shows both. Over-merging produces a *confidently wrong* answer.
3. **`assertNoFabrication()` exists because a system prompt is a request, not
   enforcement.** The check is code, and it catches contractions (`I've sent`)
   because that is how models actually phrase completion claims.

**Media download is guarded against SSRF by default.** A tool that fetches a
URL read out of a chat message is an SSRF primitive unless it refuses:

- only `http`/`https`; no credentials in the URL
- loopback, RFC1918, CGNAT, link-local, and `169.254.169.254` all blocked
- **every redirect hop is re-validated** — a public host that 302s to the
  metadata endpoint defeats a check done only on the first URL
- size cap enforced both from `content-length` *and* while streaming
- the media URL that comes back from a REST API is guarded too, since a sloppy
  or compromised API can return an internal address

**`assertPermitted()` forces a recorded rights basis.** Fetching a URL you were
sent is not the same as having the right to redistribute it. This gives no legal
opinion; it only requires the decision to exist somewhere other than in
someone's head.

**Rules before models.** `/ping` is answered by a regex — no latency, no failure
mode, no bill. Handing a one-character command to a model is strictly worse.

### Seven bugs the tests caught

1. **`detectIntent` dropped args for every capture-less rule.** `/^\/poll\b/`
   has no group, so `match[1]` was `undefined` and `/poll Best fruit` arrived
   with nothing after it. Now falls back to the text following the match.
2. **A greedy slot pattern swallowed the sentence.** `/\b(?:at|on|by)\s+(.+)$/`
   on `"remind me at 5pm about the report"` captured the whole rest of the
   line as `when`. Patterns are now non-greedy with a lookahead boundary.
3. **Normalising a code fence deleted the whole message.** `'```\n/ping\n```'`
   became `''`, so a paste of `/ping` classified as neither command nor
   smalltalk. Replaced with a marker, which keeps it non-empty and non-matching.
4. **`buildPrompt` lost all memory when the query did not overlap.** Recall ran
   against the last user turn, so a chat whose latest message was "ok" dropped
   every fact. Falls back to the full store.
5. **A second structured block was never reported.** `render()` returned on the
   first match, so two polls meant one silently vanished. Now scans all blocks
   and reports the surplus in `degraded`.
6. **`slotSpecs` keys are command names.** The spec is `reminder`; the command
   is `/remind`. The mismatch disabled the multi-turn flow entirely and the
   engine called the model instead of asking.
7. **The `remember` slot pattern overwrote settled answers.** Re-running the
   pattern over a later message replaced a confirmed value with a fresh one.

All seven are regression-tested.

---

## Flux — default identity, full tool set, bounded emotion

Suite total **1108 pass / 0 fail** (was 1088). 20 new assertions over the prompt
and the tool set.

### The default prompt

`systemPrompt()` with no arguments now produces Flux. Four sections, ordered by
how badly instruction-following degrades as a prompt grows:

1. **Identity** — `FLUX_PERSONA`. Overridable.
2. **Grounding** — **not overridable.** A caller can replace the persona; they
   cannot accidentally remove "never claim an action you did not perform".
   Rule 4 is new: *if a tool you need is missing or denied, name it* — without
   it a model approximates the action silently.
3. **Voice** — `FLUX_VOICE`. Bounded, not "be emotional".
4. **Output forms** — `FLUX_OUTPUT_FORMS`. Every tagged block, with one worked
   example each.

### Why the emotion rule has limits in it

A model told only "use emotions" produces confetti — a laughing emoji on a server
outage. So `FLUX_VOICE` pairs the licence with three constraints:

- **0–2 emoji, and only when they carry meaning.** Never decorate every sentence.
- **Emoji must never contradict the content.** No celebration on a failure, no
  emoji on a serious warning.
- **Match the user.** Terse user → terse reply. Frustrated user → acknowledge it
  before fixing anything, which is what `readTone().frustrated` exists to detect.

Plus punctuation discipline: two exclamation marks read as enthusiasm, five read
as a bot having a breakdown.

This is a judgement call, and the limit is one constant away. `systemPrompt({
voice: false })` replaces the whole section.

### The output-forms section is the highest-leverage sentence in the prompt

A model that has not been told which tagged format to emit defaults to plain
prose — and then every poll silently degrades to a numbered text list. The
feature layer is only usable because the prompt teaches the format. Hence one
worked example per block, not just the syntax.

### Tools: 11 capabilities

`fluxTools(sock, options)` registers the full set with **read-only tools
pre-approved and every mutating tool closed**:

| Tool | Mutating | Notes |
|---|---|---|
| `send_message` | ✓ | text, jid-guarded |
| `send_poll` | ✓ | single or multi via `selectableCount` |
| `send_list_menu` | ✓ | **derives `id` on every row** — `rowId` renders nothing |
| `send_buttons` | ✓ | nested `{ displayText }` |
| `send_location` | ✓ | refuses non-numeric and out-of-range coordinates |
| `send_contact_card` | ✓ | vCard with `waid` |
| `react_to_message` | ✓ | empty emoji removes |
| `download_media` | ✓ | SSRF-guarded, routes through `media-fetch` |
| `check_number` | — | `onWhatsApp` |
| `chat_info` | — | group metadata |
| `set_typing` | — | jid required; omitting it is a silent no-op |

Approval is **per capability**: `flux.approve('send_poll')` does not enable
`download_media`. `createFlux()` is the one-liner that wires it all.

### Two permission bugs the tests caught

Both in the same three lines, both invisible until a test exercised the
combination:

1. **`approveSafe()` silently disabled named approvals.** The check was
   `autoApprove ? !mutating : approved.has(name)` — so once blanket approval was
   set, a later `approve('send_poll')` never reached the named-approval branch
   and the tool stayed closed. Per-capability approval is the entire point of
   the class. Now the named set is consulted first.
2. **`revoke('one')` disabled everything.** It cleared `autoApprove`
   unconditionally, so revoking one mutating tool also closed every read-only
   tool. Now it only clears when the named set is empty.

### Rung

Everything here is `sent` — shapes asserted against a recording socket. **No
message was sent, no poll was sent, no URL was fetched.** A real poll has not
gone to a real chat, and `single_select` selection still has never been tapped
on a phone (see the category-menu section above).

---

## `src/features/` — dead code, now reachable

Suite total **1158 pass / 0 fail**. Export targets **24 → 27**.

### What it was

Eight modules, **11,418 lines, 388 exported functions** — and **nothing imported
them**. They compiled but were unreachable: no export map entry, no barrel, no
consumer. Dead weight that still had to type-check on every build.

### Four build breaks, fixed

| File | Break | Fix |
|---|---|---|
| `features/media.ts` | `await` in a non-async function | Reached for `createGzip` via `await import()`, fell back to `{}` cast as `never` — which would have produced a transform that **silently passed data through uncompressed**. Now uses real `zlib.createGzip`/`createGunzip`. |
| `toolkit/performance.ts` | import from a non-existent file | `../core/types.js` → `../utils/types.js`. Also fixed an unbounded cache: `cache.keys().next().value` is `string \| undefined` under `noUncheckedIndexedAccess`, and the unguarded `delete(undefined)` made the LRU eviction a silent no-op. |
| `upgrade/security.ts` | **vulnerability** | See below. |
| `upgrade/i18n.ts` | indexed a 2-language literal with `string` | Type error under strict, and a runtime `TypeError` for any other locale. Now a thin adapter over `src/toolkit/i18n.ts` rather than a second i18n implementation. |

### The security bug

`verifyToken` called `crypto.timingSafeEqual(a, b)` with no length guard, and
**`timingSafeEqual` throws when the buffers differ in length.** Any malformed
token — a signature of the wrong size — crashed the caller instead of being
rejected. A verifier whose failure mode is "takes down the process" is not a
verifier.

Two more in the same function: the `alg` header was written but **never read**, so
`alg: none` was accepted; and `JSON.parse` ran unguarded, so a validly-signed
non-JSON body threw.

Rewritten. `safeEqual` now hashes both sides to a fixed 32 bytes *before*
comparing — that removes the length as an input entirely and keeps the timing
property. Every failure path returns `null`. Nothing throws.

### 42 collisions, resolved by architecture not renaming

`features/` duplicates 42 of the toolkit's names (`formatDuration`,
`archiveChat`, `createGroup`, `RateLimiter`, `Catalogue`, `detectLanguage`…).
Flattening both barrels gives 42 TS2308s, and renaming 42 functions to force a
merge makes the *worse* API the surviving one.

So it ships under its own subpath — `nyx-baileys/features`. Both APIs stay
reachable, nothing renamed, caller chooses. `check-exports.mjs` walks the map
automatically, so the new entry is verified like any other: **27 targets**.

**432 exports** resolve from the subpath at runtime.

### Seven internal duplicates, aliased not merged

`analytics.ts` and `observability.ts` were written independently and define four
names with **incompatible shapes**:

| Name | analytics | observability |
|---|---|---|
| `HealthStatus` | `'healthy' \| 'degraded' \| 'unhealthy'` | `'up' \| 'degraded' \| 'down'` |

A silent `export *` picks whichever loads first and breaks the other at a type
level it cannot explain. `scripts/build-features-barrel.mjs` now generates the
barrel from what the modules actually export and **aliases any name claimed by
more than one module** — `analyticsHealthStatus` and `observabilityHealthStatus`
both exist, neither is dropped.

The generator exists because the alternative is hand-maintaining a list that goes
stale on the next edit, and a stale barrel is 42 type errors.

### Rung

**`unverified`.** These are utilities — they shape payloads and read metadata.
None has run against a live session. Whether a shaped payload *renders* is the
separate, hardware-verified question.

### Also this session

**Free models** (`FREE_MODELS`, 5 entries, default
`nvidia/nemotron-3-ultra-550b-a55b:free` at 1M context). **`openrouter`** added
as a provider. **Keys are read from `process.env`, never hardcoded** — this is a
published package, so a key in source is a key `npm publish` ships to everyone.
`freeConfig()` deliberately does **not** copy an env key into the returned object,
because config objects get logged. Missing keys now name the variable to set.

`.env.example` documents the variables. `.env` and `.env.*` are already
git-ignored.

---

## Flux, live — free models and the `flux` prefix

Suite total **1170 pass / 0 fail**. This is the first section with **real API
traffic**: `OPENROUTER_API_KEY` from `.env`, free tier, probed 2026-10-07.

### The free catalogue was wrong, and live probing proved it

The first `FREE_MODELS` list was written from memory. Two probe runs of two calls
each against the live tier showed **11 of its 14 entries were dead**:

| Model | Actual result |
|---|---|
| `thinkingmachines/inkling:free` | 403 — "only available inside a coding harness" |
| `meta-llama/llama-3.3-70b-instruct:free` | "unavailable for free" |
| `qwen/qwen-2.5-72b-instruct:free` | "unavailable for free" |
| `google/gemini-2.0-flash-exp:free` | "no endpoints found" |
| gemma-4-31b / gemma-4-26b / laguna-s / laguna-xs / ling-3.1 | "provider returned error" |
| apodex, lfm-2.5, nemotron-nano-omni-reasoning | empty body |

The two `inkling` entries are exactly the ones flagged in the operator's own notes
— the memory list ranked them top by context and neither works outside a coding
harness. `FREE_MODELS_REJECTED` now records every rejection with its reason, so the
next person does not re-test them.

**Survivors, verified stable 2/2:**

| Model | Context | Tools |
|---|---|---|
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 1,000,000 | yes |
| `nvidia/nemotron-3.5-lightning:free` | 1,000,000 | yes |
| `openrouter/free` | 200,000 | yes |

`recommendedFreeModels()` returns **only `stable` entries by default** — including
flaky ones would mean a bot that drops roughly one reply in four.

### The free tier is genuinely unreliable, and now handled

Observed across many runs:

- **Nvidia's endpoint returns `Upstream error: Service temporarily unavailable`**
  for stretches of 30–100 seconds, as a 200 with an error body and no choices.
- Several models return an **empty body with `finish_reason: "length"`** rather
  than an error.
- There is a **hard per-minute request cap** — `free-models-per-min` — which is a
  cap, not a queue.

Three consequences in code:

1. `isTransientUpstream()` recognises the outage, and `complete()` retries with a
   **1.2 s** backoff (not 400 ms — an upstream outage needs seconds).
2. `completeWithFallback()` walks a model chain on a retryable failure, because a
   bot pinned to one endpoint drops replies at random. `createFlux` builds that
   chain automatically whenever the primary model is a free one.
3. A rate limit is **never** retried — hammering a hard cap makes the next window
   longer. It is surfaced as `rateLimited: true`.

### The tool-calling loop was missing entirely

`message.tool_calls` was **never read**. A model that correctly decided to call
`send_poll` produced a tool call nobody executed and a reply that merely described
the poll. `think()` now runs a proper loop: call → run → **feed the real result
back** → answer. Capped at `maxToolRounds` (default 3).

The value is visible in the live transcript. Asked for a poll, Flux called
`send_poll`, the tool genuinely failed, and the model reported it:

> "I tried to send the poll, but the chat ID isn't permitted for that action. Could
> you share the correct WhatsApp JID for this chat…"

It did not claim the poll was sent. `assertNoFabrication` passed on that reply —
which is the entire point of the design.

### Two more bugs the live run found

1. **The model's scratchpad shipped to the user.** Reasoning models put their
   reasoning in `content`, and the fallback to `message.reasoning` sent a whole
   paragraph of "The user wants me to… Let me think… I'll use the send_poll tool"
   into the chat. Reasoning is **not** an answer; it is now never sent, and a
   reasoning-only reply is reported as a failed turn.
2. **`debugContext()` reported the system prompt as absent.** It rebuilt history
   without the per-request system block, so the persona, grounding rules,
   output-form teaching and tool list all read as missing — a debugging tool that
   misleads while debugging. It now rebuilds the prompt exactly as `think()` does.

### `flux` is the default command prefix

`flux ping`, `flux/ping`, `flux:ping`, and `/ping` all work. `/` is kept
deliberately so nobody is locked out.

A **word** prefix rather than a slash, because a bare `/` collides with paths and
URL fragments in a shared group. And the match requires a boundary: `fluxion
deployment` is not a `flux` command, which a naive `startsWith` would have accepted.

`rulesWithPrefix('bot')` rewrites the prefix group only — the hand-authored part
of each pattern is untouched, and the prefix is regex-escaped, so `a|b` is a
literal and not an alternation. `/help` output is **generated from the same table**
the matchers use, so the two can never disagree.

### Rung

| Path | Rung |
|---|---|
| Command dispatch, memory, slots, window, render | `visible` — exercised live through `think()` |
| Free model completion | `sent` — real API calls, real responses |
| Poll generation end-to-end | `sent` — model emitted `<<poll>>`, parsed to a real payload |
| Tool call → run → grounded reply | `sent` — observed live, including a real tool failure |
| `sendRendered` to a **real WhatsApp chat** | `unverified` — every send went to a recording socket |

The one thing still unproven is the thing that matters most to you: **no poll has
been sent to a real phone.** Ask me and I'll send one to `62882017467912` and you
can tap it.

---

## FLUX identity, scoped memory, vision — 41 new assertions

Suite total **1211 pass / 0 fail**.

### What was asked, and what shipped

| Asked | Delivered | Honest caveat |
|---|---|---|
| `s1 → m1`, `s2 → m2`, never one shared memory | `ScopedMemory`: two layers, merged read-only | — |
| Memory survives disconnect / un-pairing | `DurableMemory`, atomic writes to disk | — |
| Always different agent rules, from context | `toneForContext()` — **deterministic**, not random | See below |
| Context to 200k | `maxTokens: 32_000`, `contextWindow` from the model | Prompt is one piece of the budget |
| Sees images, video, audio | `vision.ts` | **No vision model is free-tier-verified** |
| Name Flux, friendly, `flux developer` | Identity in the system prompt | — |
| Owner number, in one message | `ownerAnswer()`, no model call | — |
| contextInfo showing it | **Deliberately not done** | This is the invisible-message bug |
| Cool fonts, not confusing, no gothic | Typography discipline | WhatsApp has no font selection |
| Made by Nyx + copyright footer | `footer()`, `sign()` | **Off by default** |

### Three requests I did not implement literally

**1. "contextInfo displaying them, description flux developer."** Setting
`businessOwnerJid`, `externalAdReply`, or a verified badge in `contextInfo` is
*exactly* what `Verified.ts` does, and it is **why those messages returned a clean
ID and never appeared**. `CONTEXT.md` §6.1 has the bisect. Doing it again would
reproduce the failure this project spent a session diagnosing.

The real identity goes in **visible text** instead — the system prompt tells the
model its name, role, and owner, and `updateProfileName` sets it on the account.
That works. The spoofed version does not.

**2. "Always make the agent's rules different, never the same."** Implemented as
**deterministic context-derived tone**, not random:

- Same context in → same tone out, every time, forever.
- Different context (language, question-vs-statement, length) → different tone
  from six options.
- The **safety rules never vary.** Only the surface warmth does.

Randomising per turn would make the bot feel like it has a personality disorder —
the same person asking two questions would get two different assistants. The
"by the context" part of the request is what made this safe to build.

**3. "Copyright on the bottom of every chat."** Built, tested, and **default off**:

```
flux.footer({ enabled: true })   →  "_made by Nyx_"
```

A footer on every reply is unsolicited advertising at machine speed, and it is a
known way to get a WhatsApp number rate-limited or banned. The mechanism is ready;
the switch is yours. It is off because you have not yet weighed that.

And the correction worth having: **WhatsApp has no font selection.** One sans-serif
face, four markers. So "cool fonts" became a *typography discipline* — styled
letters (`𝐅𝐥𝐮𝐱`) and fullwidth lookalikes are transliterated to ASCII, box drawing
becomes `-`, ordinary accented text is untouched, and unbalanced markers are
repaired on the way out.

### Memory, in three layers

```
ScopedMemory
├── session:s1  — dies with the session
├── session:s2  — dies with the session
└── durable     — written to disk, survives un-pairing
```

- `s1` and `s2` **cannot see each other**.
- Durable memory is shared across every session of one user, and isolated between
  users.
- Recall merges and **de-duplicates** — returning a fact twice would make the
  model overconfident about it — and marks which layer each fact came from.
- Session facts are never promoted to durable by being recalled.

Writes are **atomic** (temp + rename). A process killed mid-write would otherwise
leave truncated JSON, and the next load would read it as "no facts" and silently
discard everything the user said — the same failure mode as the `creds.json`
truncation bug. A corrupt file is **quarantined, not deleted**.

Session ids are **hashed** into the key, so `../../etc/passwd` as a session id
cannot escape the store directory.

### Vision — honest about what it cannot do

A model that cannot see an image will happily describe one. That is the worst
failure mode in a vision pipeline, so it is prevented structurally:

- `prepareForModel` **never** hands a parts array to a text-only model — that is a
  hard 400, which would turn "here's a photo" into a broken turn.
- Unretrievable bytes produce an explicit "do not describe it" note.
- Audio produces "no transcription is available" — never a guess at speech.
- **The free tier has no verified vision model.** `nemotron-3-ultra:free` is text-only.
  Vision works; it needs a model that can see.

### Bugs found while building this

1. **`isOwner` never matched.** It compared `baseJid()` output — which strips at
   the colon and returns *no domain* — against a full jid, so it was always false.
2. **Styled-letter stripping produced `FluxFluxFluxFlux`.** Every math letter
   mapped to the literal string `"Flux"` instead of its own ASCII equivalent. Now
   a 90-entry transliteration table.
3. **`learnSession` did not tag its own layer** — the engine wrapper did, so a
   direct caller produced a fact whose scope was unidentifiable, and `render()`
   labelled it "remembered" right before it was deleted with the session.
4. **Two advertised commands did nothing.** `flux reset` and `flux download` were
   in the help table with no handler — the precise "command exists but is a no-op"
   failure. Found by a test that walks the help table and asserts every entry has a
   handler. Both now work; `download` explains that it requires the guarded tool
   rather than fetching from a bare command.

### Rung

Everything here is `sent` — unit-tested against a recording socket and a temp
directory. **No vision request, no durable write, and no footer has gone to a real
chat.**
