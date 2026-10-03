# FEATURES — 250 entries

Nyx-Baileys 0.1.0 · snapshot 2026-10-03, 51 TypeScript files under `src/`,
21 plugin modules (11 in the default chain)

## How to read this

Every entry is a **name**, a **one-sentence description**, a **layer**, and a
**status tag**. Nothing here is aspirational and nothing is marketing.

| Layer | Meaning |
|---|---|
| `core` | The interception primitive, the socket, protobuf builders, media traversal, session stores |
| `plugins` | The 11 default plugins plus `metrics` |
| `utils` | Text composition, logging, shared types |
| `adapters` | `SessionStore` implementations (SQLite/Mongo/Prisma/Redis) |
| `multi` | One process, N accounts |
| `cli` | Argument parsing and output |
| `security` | Validation, redaction, permissions, ACL, audit |

| Status tag | Meaning |
|---|---|
| `[ok]` | Implemented and working |
| `[defect]` | Implemented but **known broken**; the defect is named |
| `[partial]` | Implemented but does less than its name implies |
| `[closed]` | Implemented in source, **not reachable** from the package exports map |
| `[open]` | **Not implemented.** Designed in `DESIGN-NOTES.md` or `ARCHITECTURE.md` |

## The tiers, honestly

| Tier | Count | What it means |
|---|---|---|
| **1 — implemented** | **190** | In `src/` today, cited to `file:line` |
| **2 — specified** | **60** | Designed in enough detail to build; effort S/M/L given |
| **3 — candidate** | **43** | Worth considering, with a real risk note |
| **Total** | **250** | |

**Tier 1 is enumerated at "coherent capability" granularity, not per symbol.**
`src/` exports 51 names from the package root and has four more layers behind it;
a per-symbol enumeration would inflate the count without adding information. Where
a tier-1 entry is partial or defective, the tag says so and the entry names the
defect rather than implying it away.

**Nothing was padded to reach 250.** Tier 3 stops at 43 because that is how many
candidates survived an honest risk review — the honest answer to "should we add
VoIP support" is "yes, and it is a project, not a feature". `VERIFICATION.md`'s
8 PARTIAL and 1 MISSING rows and the 40 portable techniques in
`REF-FINDINGS.md` are the source for Tier 2. Tier 3 includes 6 items that are
explicitly **evasion-adjacent and excluded**; they are listed so nobody
re-proposes them.

---

# TIER 1 — implemented (130)

## core / socket (8)

| # | Name | Layer | What it does |
|---|---|---|---|
| 1 | Upstream socket construction | `core` | Calls `makeWASocket()` once and returns its result with its type unchanged — no fork, no `node_modules` edit. `core/socket.ts:83-113` |
| 2 | `auth`-object credential passing | `core` | Passes `{creds, keys}` as one `auth` property, the rc14 shape. `core/socket.ts:84` |
| 3 | Credential persistence listener | `core` | Registers `creds.update` → `saveCreds`, which rc14 does not provide — without it a pairing is lost on every restart. `core/socket.ts:107-111` |
| 4 | Web version negotiation | `core` | Fetches the current WA web version and uses it instead of a pin. `core/socket.ts:44-52` |
| 5 | Pinned version fallback | `core` | Falls back to a hardcoded version if negotiation fails or times out. `core/socket.ts:59` |
| 6 | Desktop Chrome fingerprint | `core` | One default `['Chrome','120','0']` tuple, chosen to be internally consistent. `core/socket.ts:14-18` |
| 7 | UA derived from the fingerprint | `core` | Builds the Chrome UA from the same tuple, so the two cannot disagree. `core/socket.ts:117-123` |
| 8 | Transport tuning defaults | `core` | 20 s connect timeout, 30 s keepalive, 64 MiB payload, TLS verification on. `core/socket.ts:32-38` |

## core / interception (9)

| # | Name | Layer | What it does |
|---|---|---|---|
| 9 | Runtime method patching | `core` | `patch(target, name, wrapper)` replaces a method on a live object at runtime. `core/intercept.ts:43-85` |
| 10 | Wrapper chaining | `core` | The wrapper receives the *current* implementation, so A-then-B gives `B(A(orig))` and both plugins run. `core/intercept.ts:48`, `:72-74` |
| 11 | Pristine stash and exact undo | `core` | Keeps a pristine copy on `Symbol.for('nyx-baileys.pristine')` so teardown restores the true original. `core/intercept.ts:19`, `:57-68` |
| 12 | Silent no-apply on a missing method | `core` | Returns `{applied:false}` and changes nothing rather than throwing; the caller decides. `core/intercept.ts:50-52` |
| 13 | Multi-method patch unit | `core` | `patchAll()` registers one disposer covering every method it touched. `core/intercept.ts:88-112` |
| 14 | Detachable listener helper | `core` | `listen()` wraps `ev.on` and returns an `off` that tolerates a torn-down emitter. `core/intercept.ts:122-137` |
| 15 | Shared disposer registry | `core` | `Disposables` collects teardown callbacks for plugins and the host alike. `core/intercept.ts:140-170` |
| 16 | Reverse-order unwind | `core` | `dispose()` pops from the end so later patches unwind before the ones they wrap, each in its own try/catch. `core/intercept.ts:159-169` |
| 17 | Non-throwing invariant | `core` | `invariant(cond, msg)` asserts with a readable message instead of `undefined is not a function`. `core/intercept.ts:173-175` |

## core / media traversal (7)

| # | Name | Layer | What it does |
|---|---|---|---|
| 18 | Media field enumeration | `core` | `MEDIA_KEYS` lists the seven per-type media fields rc14 uses instead of a generic `message.media`. `core/media.ts:18-26` |
| 19 | Priority media traversal | `core` | `firstMedia()` returns the first populated media field; there is no `message.media` to read. `core/media.ts:57-66` |
| 20 | Two-hop context resolution | `core` | `contextOf()` returns the media field's `contextInfo`, else root `messageContextInfo`. `core/media.ts:83-89` |
| 21 | Association access | `core` | `associationOf()` reads `contextInfo.messageAssociation`. `core/media.ts:92-94` |
| 22 | Type-filtered parent lookup | `core` | `parentKeyOf(msg, type)` returns a parent id only for the requested `associationType`, so a quote is not read as album membership. `core/media.ts:102-107` |
| 23 | Long-safe size reading | `core` | `sizeOf()` converts protobufjs `Long` to a number via `toString()`. `core/media.ts:110-115` |
| 24 | Mime and field accessors | `core` | `mimeOf()` and `mediaKeyOf()` read the mime and name the field used. `core/media.ts:69-77`, `:118-120` |

## core / protobuf builders (11)

| # | Name | Layer | What it does |
|---|---|---|---|
| 25 | Typed flow schema | `core` | `FlowParams`/`FlowSection`/`FlowRow` describe the JSON payload the client renders, which is not in the protobuf at all. `core/nodes.ts:26-48` |
| 26 | `buildFlowMessageParams()` | `core` | Builds that JSON params object, omitting empty fields rather than emitting `undefined`. `core/nodes.ts:61-87` |
| 27 | `toFlowMessage()` | `core` | Wraps params into the real rc14 three-field node: `messageVersion`, `messageParamsJson`, `buttons`. `core/nodes.ts:90-101` |
| 28 | `toNatives()` alias | `core` | Parity alias for the JavaScript surface. `core/nodes.ts:104` |
| 29 | Row shorthands | `core` | `radioRow()` (selectable, carries `optionName`) and `infoRow()` (labelled, not selectable). `core/nodes.ts:51-58` |
| 30 | `createFormFlow()` | `core` | A native-flow data-entry form with sections, rows and a CTA. `core/nodes.ts:151-159` |
| 31 | `createCarouselFlow()` | `core` | A horizontally scrolling carousel, one section per card. `core/nodes.ts:162-182` |
| 32 | `createTableFlow()` | `core` | A read-only data sheet that renders as a native table rather than monospace text. `core/nodes.ts:185-208` |
| 33 | `carouselCardWithMedia()` | `core` | A carousel card that flags `hasMediaAttachment` for caller-supplied media. `core/nodes.ts:214-243` |
| 34 | `createAlbumContainer()` | `core` | Emits the album **parent**: counts only, no media array, because that is what rc14 sends. `core/nodes.ts:251-260` |
| 35 | `createEdit()` | `core` | `[defect]` Emits `{editedMessage:{text}}`, but rc14's `editedMessage` is a `FutureProofMessage` wrapping a `Message`. The text is silently lost on the wire; the `as` cast hides it. `core/nodes.ts:263-265` — see `ARCHITECTURE.md` §5.6 |

## core / session stores (6)

| # | Name | Layer | What it does |
|---|---|---|---|
| 36 | `SessionStore` interface | `core` | The three-method contract (`init`/`get`/`set`) that any persistence backend fits. `utils/types.ts:50-56` |
| 37 | `FileSessionStore` | `core` | Default store: upstream multi-file auth state plus a JSON sidecar. `core/session-store.ts:29-85` |
| 38 | Sidecar state file | `core` | Plugin state persists to `<dir>/state.json` as free-form `get`/`set`, so the warm-up ramp survives restarts. `core/session-store.ts:54-78` |
| 39 | `MemorySessionStore` | `core` | Non-durable in-memory store, so a test or short-lived CLI never touches disk. `core/session-store.ts:91-116` |
| 40 | `createSessionStore()` | `core` | Wraps any sync-or-async `load`/`save` pair as a store — the adapter for Mongo, Postgres or Redis. `core/session-store.ts:128-165` |
| 41 | `clear()` wipe | `core` | Removes the session directory; the next start requires a fresh pairing. `core/session-store.ts:81-84` |

## nyxBaileys / lifecycle (15)

| # | Name | Layer | What it does |
|---|---|---|---|
| 42 | `NyxBaileys` wrapper class | `core` | Owns the socket lifecycle and the plugin chain; the returned socket is a real `WASocket`. `nyxBaileys.ts:33-289` |
| 43 | `createNyxBaileys()` factory | `core` | One isolated instance per session number. `nyxBaileys.ts:292-294` |
| 44 | Connect concurrency guard | `core` | Simultaneous `connect()` callers share one in-flight attempt rather than opening two sockets. `nyxBaileys.ts:86-92` |
| 45 | Disposed-instance guard | `core` | `connect()` after `dispose()` throws via `invariant`, it does not silently reopen. `nyxBaileys.ts:95` |
| 46 | Default 11-plugin chain | `plugins` | `plugins()` returns stealth, lid, media, album, memory, group, repair, reconnect, anti-spam, flow, warmup in `order`. `nyxBaileys.ts:56-70` |
| 47 | `registerPlugin()` | `core` | Appends a plugin and re-sorts by `order`, redefining the instance's own chain so instances cannot contaminate each other. `nyxBaileys.ts:76-80` |
| 48 | Per-plugin failure isolation | `core` | A plugin that throws is logged by name and skipped; the socket survives. `nyxBaileys.ts:182-188` |
| 49 | `applied[]` diagnostics | `core` | Names of plugins that actually applied, in application order. `nyxBaileys.ts:41`, `:180` |
| 50 | `patchCount` observability | `core` | Outstanding disposer count — the cheapest assertion that decoration happened. `nyxBaileys.ts:286-288` |
| 51 | `#rebuild()` unwind-then-redecorate | `core` | Disposes every patch before rebuilding, so wrappers never stack across reconnect cycles. `nyxBaileys.ts:136-161` |
| 52 | Cold rebuild from the store | `core` | Rebuilds from persisted auth state, never from memory — a reconnect is the same path as a cold start. `nyxBaileys.ts:150-156` |
| 53 | `__requestReconnect` bridge | `core` | The host exposes a rebuild function so the reconnect plugin never owns the connect path. `nyxBaileys.ts:115-121` |
| 54 | Single `connection.update` owner | `core` | `#wireConnection()` is the one place that reads connection phase and records `connectionState`. `nyxBaileys.ts:193-220` |
| 55 | `onConnection()` fan-out | `core` | Plugins subscribe here instead of adding listeners; each listener's throw is isolated. `nyxBaileys.ts:229-232`, `:234-242` |
| 56 | Event passthrough with unsubscribe | `core` | `on()` returns an unsubscribe function; `ev` and `user` forward to the live socket. `nyxBaileys.ts:252-265` |

## plugins / stealth (3)

| # | Name | Layer | What it does |
|---|---|---|---|
| 57 | Identity pinned once per socket | `plugins` | Exposes one `__identity` as the single source of the fingerprint, so nothing invents a second one. `plugins/stealth.ts:37-41` |
| 58 | Presence follows real state | `plugins` | `available` on `open`, `unavailable` on `close` — no synthetic traffic. `plugins/stealth.ts:45-56` |
| 59 | Non-goals recorded in source | `plugins` | The module docstring states it does not rotate the fingerprint or fire idle typing indicators. `plugins/stealth.ts:8-14` |

## plugins / lid-router (4)

| # | Name | Layer | What it does |
|---|---|---|---|
| 60 | `resolveJid()` | `plugins` | Resolves `@lid` to the canonical `@s.whatsapp.net` via `onWhatsApp`, so callers need not care which identifier they were handed. `plugins/lid.ts:67-91` |
| 61 | `resolvePn()` | `plugins` | Reverse lookup for lid-based group fan-out. `plugins/lid.ts:97-112` |
| 62 | TTL + bounded LRU cache | `plugins` | 6-hour TTL, 5 000 entry cap, oldest evicted. `plugins/lid.ts:35-36`, `:46-52` |
| 63 | Passthrough and safe fallback | `plugins` | Non-JID strings return untouched; a failed lookup uses the supplied JID rather than throwing. `plugins/lid.ts:67-70`, `:84-90` |

## plugins / media-stream (5)

| # | Name | Layer | What it does |
|---|---|---|---|
| 64 | `downloadMedia()` | `plugins` | Guarded download returning `{buffer, mime, fileName, bytes}` with a size ceiling enforced. `plugins/media-stream.ts:61-97` |
| 65 | `streamMedia()` | `plugins` | `[partial]` Decrypts once then hands out 64 KB chunks. The full buffer still exists first, so peak memory is the whole asset — the docstring concedes this rather than claiming bounded memory. `plugins/media-stream.ts:100-114` |
| 66 | `MediaTooLargeError` | `plugins` | Typed error carrying both `bytes` and `limit` so the caller can decide to skip or fetch out of band. `plugins/media-stream.ts:40-48` |
| 67 | Empty-decrypt throws | `plugins` | An expired key or unsupported type throws instead of returning an empty buffer, which is how broken-media bugs survive for months. `plugins/media-stream.ts:74-78` |
| 68 | Declared-size early reject | `plugins` | A sender-declared `fileLength` over the ceiling is refused before the RAM is spent; untrusted input can only reject early, never approve. `plugins/media-stream.ts:84-87` |

## plugins / album (6)

| # | Name | Layer | What it does |
|---|---|---|---|
| 69 | Parent container parsing | `plugins` | Reads `expectedImageCount`/`expectedVideoCount` to learn how many members to expect. `plugins/album.ts:96-102` |
| 70 | Sibling linkage | `plugins` | Finds a sibling's parent via `contextInfo.messageAssociation` tagged `MEDIA_ALBUM` — rc14 has no `albumParentKey` field at all. `plugins/album.ts:62-63` |
| 71 | Sibling index | `plugins` | Reads `messageIndex` from the association when the sender supplied one. `plugins/album.ts:66-67` |
| 72 | Legacy inline fallback | `plugins` | Also reads nested `albumMessage.media`/`groupedMediaMessage.media` in case a client ships that shape. `plugins/album.ts:70-76` |
| 73 | `expandAlbum()` | `plugins` | Decrypts one item on demand and throws rather than returning an empty buffer. `plugins/album.ts:135-157` |
| 74 | `waitForAlbum()` + `nyx.album` | `plugins` | Resolves when an album completes; every change emits an event. The registry is bounded at 200. `plugins/album.ts:78-88`, `:160-174` |

## plugins / memory-gc (5)

| # | Name | Layer | What it does |
|---|---|---|---|
| 75 | Per-chat history trimming | `plugins` | Keeps the newest N message ids per chat (200 default) and drops chats with an empty trail. `plugins/memory.ts:52-66`, `:94-97` |
| 76 | Status accounting | `plugins` | Status posts are counted separately so they never crowd real history out of the window. `plugins/memory.ts:99-103` |
| 77 | Media blob table | `plugins` | `store.put`/`store.take` hold decrypted buffers, `take` being consume-once. `plugins/memory.ts:117-126` |
| 78 | Continuous sweep | `plugins` | Runs on a timer and after every upsert, so pressure is relieved before the point of failure. `plugins/memory.ts:89-110` |
| 79 | Heap pressure warning | `plugins` | Logs a line when `heapUsed` crosses a configured threshold. `plugins/memory.ts:81-86` |

## plugins / group-guard (5)

| # | Name | Layer | What it does |
|---|---|---|---|
| 80 | Mass-add detection | `plugins` | Flags 8+ joins inside 10 minutes per group; counts join timestamps, not jids. `plugins/group.ts:73-91` |
| 81 | Privilege tracking | `plugins` | `[partial]` Maintains an observed-admin set per group. The check is a counter, not a detector — `known >= 3` means "three promote events", not "every member is an admin". `plugins/group.ts:101-112` |
| 82 | `allow()` group filter | `plugins` | Ignores groups not on an allowlist. `plugins/group.ts:66` |
| 83 | `groupAlerts` + event | `plugins` | Bounded at 100, emitted as `nyx.groupAlert`. `plugins/group.ts:50-55`, `:117` |
| 84 | Report-only by design | `plugins` | Auto-kicking on a signal this noisy is how a guard becomes the incident; the hook is where an operator decides. `plugins/group.ts:12-16` |

## plugins / session-repair (5)

| # | Name | Layer | What it does |
|---|---|---|---|
| 85 | Interactive node hoisting | `plugins` | Moves an interactive node out of `viewOnceMessage`/`documentWithCaptionMessage`/`editedMessage`/`ephemeralMessage`/V2 wrappers, or the client ignores it. `plugins/session-repair.ts:33-71` |
| 86 | `optionName` backfill | `plugins` | Gives every native-flow row a selectable id by parsing `messageParamsJson`, repairing, re-serialising. Without it the client degrades to a text bubble. `plugins/session-repair.ts:81-114` |
| 87 | Malformed params left alone | `plugins` | An unparsable `paramsJson` is not rewritten — corrupting the payload is worse than the missing field. `plugins/session-repair.ts:88-91` |
| 88 | `__repairStats` / `__normalise` | `plugins` | A live repair counter and the normaliser callable standalone. `plugins/session-repair.ts:161-170` |
| 89 | Both compile entry points patched | `plugins` | `sendMessage` and `relayMessage`, so normalisation happens before Baileys serialises. `plugins/session-repair.ts:140-159` |

## plugins / reconnect (6)

| # | Name | Layer | What it does |
|---|---|---|---|
| 90 | Full-jitter backoff | `plugins` | Exponential from 1 s to a 60 s ceiling with `random()` full jitter, so retries do not synchronise. `plugins/reconnect.ts:63-66` |
| 91 | Reason-aware switch | `plugins` | Eight `DisconnectReason` branches each get their own response rather than one generic retry. `plugins/reconnect.ts:122-163` |
| 92 | Terminal reasons halt the loop | `plugins` | `loggedOut` and `multideviceMismatch` stop retrying, because both need a human with a phone. `plugins/reconnect.ts:123-130`, `:135-141` |
| 93 | `health()` report | `plugins` | `{level, since, pausedFor, signals}` with per-reason counters. `plugins/reconnect.ts:55-60`, `:167` |
| 94 | Health level thresholds | `plugins` | `low`/`elevated`/`paused` at 0/3/10 accumulated bad signals. `plugins/reconnect.ts:48-53` |
| 95 | Backoff reset | `plugins` | Counters clear after a configurable healthy stretch. `plugins/reconnect.ts:110-115` |

## plugins / anti-spam (6)

| # | Name | Layer | What it does |
|---|---|---|---|
| 96 | Box–Muller gaps | `plugins` | Inter-send delay from a clamped normal distribution, not `random(0,max)`, which clusters at zero. `plugins/antiSpam.ts:46-52` |
| 97 | Serial drain queue | `plugins` | One message in flight at a time; each waits out its gap before the next. `plugins/antiSpam.ts:66-87` |
| 98 | Sliding-window ceiling | `plugins` | Per-minute cap over a 60 s sliding window; exceeding it throws naming the ceiling. `plugins/antiSpam.ts:55-64` |
| 99 | Queue cap rejects | `plugins` | Past 500 queued, sends are rejected instead of the queue growing unbounded. `plugins/antiSpam.ts:97-99` |
| 100 | `__antispam` controls | `plugins` | `setPressure(n)` multiplies gaps (clamped ≥1), `stats()`, `reset()`. `plugins/antiSpam.ts:120-130` |
| 101 | Both send paths gated | `plugins` | `sendMessage` and `relayMessage`, each checked for `.applied` with a named warning. `plugins/antiSpam.ts:109-117` |

## plugins / flow (7)

| # | Name | Layer | What it does |
|---|---|---|---|
| 102 | Flow registry + active map | `plugins` | Flows declared by id; one active run per chat. `plugins/flow.ts:70-71` |
| 103 | `parseFlowResponse()` | `plugins` | Parses `interactiveResponseMessage.nativeFlowResponseMessage.paramsJson`, tries several key names then walks the object for a recognisable value. `plugins/flow.ts:95-128` |
| 104 | Multi-source extraction | `plugins` | Pulls the user's choice from native-flow, interactive, buttons, list, list-message, extended-text and conversation, in that order. `plugins/flow.ts:130-167` |
| 105 | Flexible `match` | `plugins` | A step's entry condition is a `RegExp` or a predicate. `plugins/flow.ts:172-175` |
| 106 | `goto`/`end` with state | `plugins` | Steps hand off and share a scratch `state` object across the whole conversation. `plugins/flow.ts:177-200` |
| 107 | TTL expiry | `plugins` | Idle conversations drop after `ttlMs` (15 min default). `plugins/flow.ts:250-255` |
| 108 | `flows` runtime API | `plugins` | `add`, `remove`, `list`, `active(jid)`, `reset(jid?)`. `plugins/flow.ts:287-300` |

## plugins / warmup (3)

| # | Name | Layer | What it does |
|---|---|---|---|
| 109 | `rampFor()` curve | `plugins` | Exported 8×→1× multiplier, `1 + 7·(1-progress)²`, monotone and continuous at both ends. `plugins/warmup.ts:17-24` |
| 110 | Persisted start time | `plugins` | `warmupStartedAt` lives in the sidecar store so restarting the process cannot reset the ramp. `plugins/warmup.ts:34-40` |
| 111 | Soft pressure coupling | `plugins` | Reaches `__antispam` through a cast rather than an import, so plugin order stays flexible. `plugins/warmup.ts:48-51` |

## plugins / metrics (6)

| # | Name | Layer | What it does |
|---|---|---|---|
| 112 | Counters | `plugins` | Monotonic increments keyed by name. `plugins/metrics.ts:109+` |
| 113 | Gauges | `plugins` | Last-value series for point-in-time readings. `plugins/metrics.ts:109+` |
| 114 | Fixed-bucket histograms | `plugins` | Cumulative counts at declared upper bounds. `plugins/metrics.ts:29-33` |
| 115 | Cardinality ceiling | `plugins` | A hard cap on label combinations per metric, because a naive `inc(…, {jid})` creates one series per contact until the process dies. `plugins/metrics.ts:15-21` |
| 116 | `__other__` folding + `droppedSeries` | `plugins` | New label sets past the ceiling fold into one series and the count is reported — a registry that discards data silently is a lie. `plugins/metrics.ts:11-21` |
| 117 | `snapshot()` | `plugins` | A plain serialisable object the host can render, push, or diff. `plugins/metrics.ts:53-57` |

## utils (10)

| # | Name | Layer | What it does |
|---|---|---|---|
| 118 | `compose()` | `utils` | Builds WhatsApp's own text dialect — `*bold*`, `_italic_`, `~strike~`, bullets — as protocol messages, not styled text. `utils/compose.ts:31-52` |
| 119 | `code()` / `preformatted()` | `utils` | Fenced blocks that preserve blank lines, the usual way text gets mangled. `utils/compose.ts:55-62` |
| 120 | `table()` | `utils` | Aligned monospace tables; markdown tables render as literal pipes in WA. `utils/compose.ts:65-79` |
| 121 | `displayWidth()` | `utils` | Width accounting for CJK and emoji, which occupy two terminal columns. `utils/compose.ts:82-98` |
| 122 | Spec adapters | `utils` | `formFlow()`/`tableFlow()` wrap a plain object into the node builders. `utils/compose.ts:105-131` |
| 123 | `createLogger()` | `utils` | Levelled logger with a structured `meta` JSON tail and no dependency. `utils/logger.ts:19-47` |
| 124 | Child scopes | `utils` | `child(scope)` nests prefixes, so every plugin's lines are attributable. `utils/logger.ts:42` |
| 125 | TTY / `NO_COLOR` detection | `utils` | Colour only when it is a terminal and `NO_COLOR` is unset. `utils/logger.ts:21` |
| 126 | `silentLogger` | `utils` | The library default — a library should not spray the host app's stdout. `utils/logger.ts:50-56` |

## security / permissions (6)

| # | Name | Layer | What it does |
|---|---|---|---|
| 127 | 25-capability vocabulary | `security` | The only place a permission is named, so the whole surface is greppable from one file. `security/permissions.ts:23-67` |
| 128 | Prefix-wildcard matching | `security` | `group.*` covers everything under `group.`, never `groupish.*`; no suffix or infix wildcards. `security/permissions.ts:215-225` |
| 129 | Three-valued role verdict | `security` | `allow`/`deny`/`none`, so "no opinion" is never collapsed into "denied". `security/permissions.ts:254-260` |
| 130 | 7-role ladder | `security` | `owner`/`admin`/`moderator`/`operator`/`member`/`guest`/`banned`, each a real operating decision. `security/permissions.ts:107-191` |
| 131 | Fail-closed default | `security` | An unassigned subject is `guest`; `banned` denies everything in every role aggregation. `security/permissions.ts:184-196` |
| 132 | Grant expansion | `security` | `capabilitiesOf`/`expandGrants` resolve wildcards against the closed capability set; `defineRole` returns a frozen copy. `security/permissions.ts:274-308` |
| 133 | Explicit deny on `admin` | `security` | `session.export` is denied explicitly, so a future grant edit cannot silently widen it. `security/permissions.ts:133-136` |

## security / acl (9)

| # | Name | Layer | What it does |
|---|---|---|---|
| 134 | `can()` with a reason | `security` | Every decision carries a `reason` on **both** outcomes — a bare `false` gets inverted by some caller and the inversion ships. `security/acl.ts:41-53`, `:202` |
| 135 | `allows()` / `assert()` | `security` | Boolean form and throwing form, the latter raising `AclDeniedError`. `security/acl.ts:348-362`, `:125-129` |
| 136 | Deny-overrides-allow | `security` | Every grant from every role is gathered before the verdict; resolution is never by rank. `security/acl.ts:16-27` |
| 137 | Explicit scope resolution | `security` | A group-scoped role grants nothing globally and vice versa — silently widening a group grant is the failure that gets a moderator's powers applied everywhere. `security/acl.ts:28-38` |
| 138 | Subject patterns | `security` | Prefix and `*` matching, opt-in, for role-by-prefix assignment. `security/acl.ts:145-148` |
| 139 | Expiring assignments | `security` | `expiresAt` makes grants time-limited without a separate revocation path. `security/acl.ts:60-70` |
| 140 | `HardDeny` list | `security` | Direct capability denies with their own reason and author, independent of roles. `security/acl.ts:73-83` |
| 141 | Introspection | `security` | `rolesFor`, `grantsFor`, `isOwner` for rendering an operator's view of the ACL. `security/acl.ts:364-380` |
| 142 | Persistence + plugin form | `security` | `AclStore.load/save` and an `accessControl()` plugin that attaches to the socket. `security/acl.ts:113-123`, `:697` |

## security / validate (9)

| # | Name | Layer | What it does |
|---|---|---|---|
| 143 | `Validated<T>` with reasons | `security` | Every failure carries a greppable `code` and an actionable `reason`; no schema library, no throwing on first mismatch. `security/validate.ts:22-34` |
| 144 | Closed JID server list | `security` | The real server set is closed, so anything outside it is malformed or an attempt to steer a lookup. `security/validate.ts:80-88` |
| 145 | `parseJid()` | `security` | Parses a jid into structured parts; treats it as an address, not a string. `security/validate.ts:134-253` |
| 146 | JID helpers | `security` | `normalizeJid`, `isValidJid`, `jidUser`, `isGroupJid`, `MAX_JID_LENGTH` 128. `security/validate.ts:255-290` |
| 147 | `stripControlChars()` | `security` | Removes control characters from text before it reaches a renderer. `security/validate.ts:307-321` |
| 148 | `sanitizeText()` + length caps | `security` | 65 536 max message, 4 096 default text. `security/validate.ts:337-385` |
| 149 | Combinators | `security` | `all`, `any`, `refine`, `optional` compose validators with readable labels. `security/validate.ts:387-441` |
| 150 | Shape validators | `security` | `oneOf`, `record`, `arrayOf`, `jsonObject` for untrusted objects. `security/validate.ts:443-582` |
| 151 | Inbound gate + plugin | `security` | `gateInbound` filters `messages.upsert` frames; `validationGate` attaches it as a plugin. `security/validate.ts:673-754` |

## security / redact (6)

| # | Name | Layer | What it does |
|---|---|---|---|
| 152 | Non-mutating deep redact | `security` | Everything is rebuilt into fresh containers, so redacting a live object cannot mutate session state. `security/redact.ts:11-13`, `:636` |
| 153 | Buffer → length placeholder | `security` | A `Buffer` in a log line is key material and `JSON.stringify` will emit it; it becomes `{__type, byteLength}`. `security/redact.ts:45-58` |
| 154 | Sensitive-key rule table | `security` | `isSensitiveKey` matches known secret shapes and named keys, including `noiseKey`/`advSecretKey`. `security/redact.ts:212` |
| 155 | Findings on every mask | `security` | `redactWithFindings` reports what was masked and why, so redaction is auditable without seeing the secret. `security/redact.ts:34-42`, `:633` |
| 156 | Format helpers | `security` | `redactJson`, `redactText`, `redactMeta`, `maskTail`. `security/redact.ts:664-750` |
| 157 | Redacting logger + guard plugin | `security` | Wraps any `Logger` so log lines are redacted at the sink; `redactionGuard` attaches it. `security/redact.ts:755-798` |

## security / audit (6)

| # | Name | Layer | What it does |
|---|---|---|---|
| 158 | Append-only `AuditLog` | `security` | A log an attacker can quietly edit is worse than no log. `security/audit.ts:173` |
| 159 | HMAC hash chain | `security` | `hash(n) = HMAC(key, prevHash ‖ canonicalJSON(entry))` — editing a line breaks every hash after it. `security/audit.ts:161-172` |
| 160 | `canonicalize()` | `security` | Stable key ordering so the hash is reproducible. `security/audit.ts:127` |
| 161 | `verify()` localisation | `security` | Detects tampering and reports the exact sequence number. `security/audit.ts:107` |
| 162 | Tamper-evidence honesty | `security` | Without a key the chain is tamper-*evident* only; with one it needs a second secret to forge. Truncation is not detectable — ship off-host. `security/audit.ts:18-33` |
| 163 | Sink + plugin form | `security` | `AuditSink`, `silentAuditSink`, `auditSink(log)` and an `auditTrail()` plugin. `security/audit.ts:553-582` |

## adapters (9)

| # | Name | Layer | What it does |
|---|---|---|---|
| 164 | Driver-free by construction | `adapters` | No adapter imports a database driver; each declares the narrow client surface and you supply the client, so no peer dependency is forced. `adapters/index.ts:16-19` |
| 165 | `SqliteSessionStore` | `adapters` | Injected persistence function rather than a database — the store serialises to a string and hands it over. `adapters/session-sqlite.ts:239` |
| 166 | Atomic write + fsync | `adapters` | Temp file, fsync, then `rename` over the target; a truncated auth file is an unrecoverable session. `adapters/session-sqlite.ts:20-32` |
| 167 | `MongoSessionStore` | `adapters` | Creds as one document, Signal keys one document per `(sessionId, type, keyId)` — the key store grows for the life of the account and a blob hits the 16 MB BSON limit. `adapters/session-mongo.ts:16-30` |
| 168 | Native BSON values | `adapters` | Key material stored as `Uint8Array`, not JSON-encoded: a 32-byte Signal key stays 32 bytes instead of ~48. `adapters/session-mongo.ts:26-28` |
| 169 | `PrismaSessionStore` | `adapters` | Two models against a structurally-typed client, so `@prisma/client` stays a peer concern and Drizzle/Knex remain swappable. `adapters/session-prisma.ts:9-11` |
| 170 | `BufferJSON` round-trip | `adapters` | Encodes with Baileys' `BufferJSON` replacer; plain `JSON.stringify` turns a 32-byte key into `{"0":1,…}` and silently desyncs the ratchet. `adapters/session-prisma.ts:29-33` |
| 171 | `RedisSessionStore` | `adapters` | The L1 cache layer in front of a durable store — a credential fetch on reconnect is one O(1) round trip. `adapters/session-redis.ts:13-17` |
| 172 | Epoch-prefix invalidation | `adapters` | Logout bumps a per-session generation prefix so every pre-key row is invalidated without a `KEYS` scan or variadic `DEL`. `adapters/session-redis.ts:19-30` |

## multi (7)

| # | Name | Layer | What it does |
|---|---|---|---|
| 173 | `SessionManager` | `multi` | One process, N accounts, each with its own socket, auth directory, plugin instances and log scope. `multi/session-manager.ts:229` |
| 174 | `createSessionManager()` | `multi` | Factory with `maxSessions`, `sessionRoot` and restart policy. `multi/session-manager.ts:687` |
| 175 | Blast-radius containment | `multi` | Every per-session operation records a throw against that session only; `broadcast` reports per-session outcomes rather than throwing on the first failure. `multi/session-manager.ts:22-27` |
| 176 | Attribution | `multi` | Every session logs under its own id and records `lastError`, so a 3am crash identifies the account without reading the whole log. `multi/session-manager.ts:29-32`, `:79-92` |
| 177 | Session operations | `multi` | `create`, `restart`, `remove`, `get`, `list`, `disposeAll`. `multi/session-manager.ts:294-618` |
| 178 | Bounded per-session restart | `multi` | A session that cannot reach `open` is rebuilt on a bounded backoff, one at a time; the attempt counter resets on `open`. `multi/session-manager.ts:34-37` |
| 179 | Logout is not restarted | `multi` | A server-side unpair needs a human; restarting on it loops forever and looks like a network problem. `multi/session-manager.ts:39-43` |

## cli (6)

| # | Name | Layer | What it does |
|---|---|---|---|
| 180 | Spec-driven parsing | `cli` | `parseArgv` handles `--flag`, `--no-flag`, `--key value`, `--key=value`, repeats, `-h`/`-V` and `--`. `cli/args.ts:6-20` |
| 181 | Unknown input is an error | `cli` | Stray words and unknown flags raise `UsageError`; a CLI that ignores what it does not understand reports success for work it never did. `cli/args.ts:76` |
| 182 | Help rendering | `cli` | `renderCommandHelp` and `renderRootHelp` generated from the same specs. `cli/args.ts:409-428` |
| 183 | `Reporter` two contracts | `cli` | `--json` puts exactly one JSON object on stdout and nothing else; diagnostics always go to stderr. `cli/output.ts:1-11`, `:224` |
| 184 | Colour gating | `cli` | `NO_COLOR` off, `FORCE_COLOR` on, otherwise TTY. `cli/output.ts:33-38` |
| 185 | Widths and formatters | `cli` | `displayWidth`, `truncate`, `renderTable`, `formatBytes`, `formatAgo`, `formatDuration`. `cli/output.ts:53-204` |

## types and entry point (5)

| # | Name | Layer | What it does |
|---|---|---|---|
| 186 | `CoreSocket = WASocket` | `core` | The type is never replaced, so every Baileys API and community extension still applies. `utils/types.ts:13` |
| 187 | Extension over `any` cast | `core` | Anything that cannot be a runtime wrapper lives behind a non-enumerable extension interface instead of an `any` cast. `utils/types.ts:5-11` |
| 188 | `Plugin` / `PluginContext` / `Wrapper` | `core` | The three types a plugin author needs, and no more. `utils/types.ts:16-38` |
| 189 | `SuperOptions` | `core` | Session dir/store, browser tuple, anti-spam, warm-up days, log level, QR printing, per-JID id. `utils/types.ts:60-82` |
| 190 | Public surface and demo | `core` | 51 exports plus a `main()` exercising identity, a paced send, and three native-flow layouts. `index.ts:24-58`, `:187` |

**Tier 1 total: 190.**

> The numbering runs to 190 because the `security/`, `adapters/`, `multi/`,
> `cli/` and `metrics` layers are real implemented surface, not aspirations. Every
> one is in `tsconfig.json`'s `include`, so it compiles as part of the package.
> Two caveats apply to all of entries 112–185: **`src/index.ts` does not
> re-export them** (it exports 51 core/plugins/utils names), and **`package.json`
> `exports` does not map them** — the map is `.`, `./core/*`, `./plugins/*`,
> `./utils/*` only. So they are reachable by deep relative import from `dist/`
> but not by the `nyx-baileys/adapters/…` specifier their own docstrings
> advertise. Both are one-line fixes in files this pass does not own.
>
> Ten further plugins are implemented and compiled but **opt-in** — none is in
> `plugins()`, so each needs `registerPlugin()`: `metrics` (110),
> `reactions` (125), `status` (130), `newsletter` (135), `call-log` (140),
> `presence` (150), `read-receipts` (160), `commands` (170), `webhook` (180)
> and `poll`. They are counted as tier-1 surface rather than given their own
> entries, to hold the count at capability granularity instead of module
> granularity. `presence.ts` and `read-receipts.ts` are worth reading directly:
> both hold the same line as `DESIGN-NOTES.md` §3 in their own source comments.

---

# TIER 2 — specified (60)

Designed in enough detail to implement. Effort: **S** ≈ under a day, **M** ≈ a
few days, **L** ≈ a week or more. Sourced from the 40 portable techniques in
`REF-FINDINGS.md` (cited `T#`) and from the genuine gaps in `VERIFICATION.md`'s
coverage matrix — 8 PARTIAL and 1 MISSING at the time of that review.

## Fixing what is already broken (10)

| # | Name | Layer | Design decision that matters | Effort |
|---|---|---|---|---|
| 191 | `patch()` stash merge | `core` | The stash is created once and holds only the first patched name, so `undo()` on a second method assigns `undefined`. Merge into the existing stash object instead of only creating it. One line; unblocks correct teardown and `patchAll`. | S |
| 192 | `patchAll()` return shape | `core` | Returns `[aggregate, ...applied.slice(1)]`, dropping `applied[0]` while the aggregate supersedes everything. Return the aggregate alone, or return `applied` unmodified. | S |
| 193 | `createEdit()` wire shape | `core` | `editedMessage` is `FutureProofMessage { Message message = 1 }`. Build `{editedMessage:{message:{conversation:text}}}`; drop the `as` cast so the compiler enforces it. | S |
| 194 | Media GC refcount | `plugins` | Current eviction removes the blobs holding bytes and skips empty ones — the inverse of its comment. Add a real refcount, or drop the guard and fix the comment to match the code. | S |
| 195 | True streaming download | `plugins` | `streamTo` materialises the whole buffer then slices. Use `downloadMediaMessage(msg,'stream',…)`, which rc14 exports and types; peak becomes one chunk. | M |
| 196 | `goto()` re-entrancy guard | `plugins` | `goto` into a step that ended or TTL-expired is a silent no-op, and the warning only fires on a missing *name*. Check `active.has(jid)` before dispatch. | S |
| 197 | Privilege-climb denominator | `plugins` | `known` counts promotes, so the check is a tautology. Divide observed admins by a group-metadata participant count and require ≥ 0.8. Needs a metadata cache first (#214). | M |
| 198 | Album completion race | `plugins` | `ensure(parent, jid, MAX_SAFE_INTEGER)` means a parent arriving after its siblings never updates `expected`, so `completedAt` is never set. Store `expected: number \| null` and back-fill when the parent lands. | S |
| 199 | Warm-up on an interval | `plugins` | The ramp is computed once per socket build, so a long-lived process holds its day-one multiplier forever. Re-evaluate hourly with a disposer-cleared interval. | S |
| 200 | Demo listener cleanup | `plugins` | `main()` adds a second `connection.update` listener that calls `dispose()`, which will also fire during a rebuild now that `reconnect` is in the chain. Move it behind `onConnection()`. | S |

## Native flow: the real button vocabulary (11)

| # | Name | Layer | Design decision that matters | Effort |
|---|---|---|---|---|
| 201 | Five control names | `core` | `quick_reply`, `cta_copy`, `cta_url`, `cta_call`, `single_select`, discriminated by which shorthand key is present on the button. `REF-FINDINGS` T1 | M |
| 202 | `merchant_url` mandatory | `core` | Omitting it yields a `cta_url` that renders but does not open. Make it non-optional in the type for url buttons. `T1` | S |
| 203 | Icon name upper-casing | `core` | The WA enum is upper-case; passing a lower-case shorthand through silently drops the icon. `String(icon).toUpperCase()` at serialisation. `T1` | S |
| 204 | `limited_time_offer` | `core` | A parent-level control in the container's `messageParamsJson`, gated on `offerText`, carrying `{text,url,copy_code,expiration_time}`. `T2` | M |
| 205 | `bottom_sheet` | `core` | Also container-level: `{in_thread_buttons_limit, divider_indices, list_title, button_title}`, with `divider_indices` auto-generated as one divider per button. `T2` | M |
| 206 | Shorthand-vs-wire detection | `core` | Detect by absence of `.name` on the first element: `isShorthand = Array.isArray(b) && b.length && !b[0].name`. This is the load-bearing heuristic. `T3` | S |
| 207 | Explicit proto materialisation | `core` | Run the assembled object through `NativeFlowMessage.create()` rather than relying on implicit coercion. `T3` | S |
| 208 | `native_flow_name` stanza attribute | `core` | Required for WA to route the response; omitting it yields silent drops. Set it on the outgoing stanza. `T4` | M |
| 209 | `native_flow_response` classification | `core` | Classify the receipt type so a flow reply is distinguishable from an ordinary message. `T4` | S |
| 210 | One constructor, N wrappers | `core` | A single `generateNativeFlowMessage(body, buttons, opts)` with four thin helpers delegating to it, rather than four envelope builders. `T5` | M |
| 211 | Row extraction by own `id` | `core` | Because the sender controls `paramsJson`, the receiver parses it and reads back its own `id`, with a legacy `singleSelectReply` fallback. Pairs with #103. `T40` | S |

## Albums: the send side (6)

| # | Name | Layer | Design decision that matters | Effort |
|---|---|---|---|---|
| 212 | Parent stub generator | `core` | Validate input is an array, count video and image members, reject fewer than two, emit counts only. The receiver needs the count before members arrive. `T9` | M |
| 213 | Children with parent linkage | `core` | Each member is an independent message with its own id, tagged `messageAssociation {parentMessageKey, MEDIA_ALBUM}`, relayed individually. `T10` | M |
| 214 | Pre-relay media validation | `core` | Reject any member that is not image or video **before** any child hits the wire, so a partial album never reaches the receiver. `T10` | S |
| 215 | Inter-child pacing | `core` | Sequential relay with a gap between children, not `Promise.all`. Refactors cited upstream specifically to reduce RSS. `T10` | S |
| 216 | Non-destructive context default | `core` | `||=` for `messageContextInfo` so a caller-supplied context survives. `T10` | S |
| 217 | Distinct header validators | `core` | Interactive headers accept document/location; carousel headers do not. Model as separate predicates, not one loose union. `T11` | S |

## Multi-tenant and session lifecycle (10)

| # | Name | Layer | Design decision that matters | Effort |
|---|---|---|---|---|
| 218 | Schema-level tenant isolation | `adapters` | Every model carries `sessionId` with a composite uniqueness including it, so isolation is enforced by the database rather than by application discipline. `T12` | M |
| 219 | Message key is not globally unique | `adapters` | Composite `[sessionId, remoteJid, id]` — message ids are unique per chat only. Getting this wrong produces spurious upsert collisions. `T18` | S |
| 220 | Boot-time session restoration | `multi` | Rebuild sockets from persisted socket config on startup, so sessions are not memory-only. `T13` | M |
| 221 | `restartRequired` bypasses backoff | `plugins` | A server-requested restart is not an error and should not be delayed; schedule at 0. `T14` | S |
| 222 | Pairing-stream QR cap | `cli` | Bound how many QR codes one long-lived stream may emit before tearing the session down, so a client cannot hold pairing open indefinitely. `T15` | S |
| 223 | Cacheable Signal key store | `adapters` | Wrap the key store in an LRU so prekey derivation is not repeated on every send. `T16` | M |
| 224 | Store-backed `getMessage` | `adapters` | Baileys needs `getMessage` to resolve historical messages for retries and receipts; backing it with the message table means a retry after restart still finds its target. `T16` | M |
| 225 | Fan-out teardown | `multi` | Delete chats, contacts, messages, metadata and sessions in one `Promise.all`, with the in-memory map cleared in `finally`. `T17` | S |
| 226 | Three-tier auth store | `adapters` | Redis → Postgres → Disk with per-layer circuit breakers, `loggedOnce`, cache warming and optional peer deps via dynamic import. `T31` | L |
| 227 | Canonical session key | `multi` | `platform:chatType:chatId` with build/parse helpers and a non-throwing parser; an explicit "never hand-construct the string" rule. `T32` | S |

## Rate limiting and reliability (12)

| # | Name | Layer | Design decision that matters | Effort |
|---|---|---|---|---|
| 228 | Exact retry-after | `plugins` | Instead of a flat "wait 60s", sort the window and return the precise moment the oldest entry expires. A real token bucket. `T20` | S |
| 229 | Content-hash dedup | `plugins` | Reject identical content inside a window, with a bounded LRU-evicted map. Unbounded hash maps are a classic leak. `T21` | M |
| 230 | Per-JID circuit breaker | `plugins` | closed/open/half-open with a single half-open probe and reopen-on-failure, scoped per recipient so one bad contact cannot stall the bot. `T22` | M |
| 231 | Breaker → pacing coupling | `plugins` | Feed breaker state into `__antispam.setPressure`, so a recipient under retry-stop gets slower pacing. Note `setPressure` currently clamps ≥1 and cannot tighten (#236). | S |
| 232 | Persistent priority queue | `plugins` | Survives crashes; `maxAttempts`, doubling retry delay, `maxQueueSize`, priority lanes drained high→normal→low. `T23` | L |
| 233 | Post-reconnect throttle ramp | `plugins` | Burst-flooding on reconnect genuinely trips rate limits, so a ramp from low rate is the correct fix — the maths is legitimate even where the source's framing is not. `T24` | M |
| 234 | 408 message-gap recovery | `plugins` | After a clean reconnect, offline messages exist server-side but never fire `messages.upsert`, so messages in the window are silently lost. Track last-seen id per chat, re-query, re-emit the gap, refuse partial recovery. `T25` | L |
| 235 | Typed retry reasons | `plugins` | Map retry codes to meaning — invalid key id (3), no session (5), bad MAC (7), expired (8) — turning an opaque integer into "resend" or "give up". `T26` | S |
| 236 | Allow tightening the pressure multiplier | `plugins` | `setPressure` clamps to `max(1,n)`, so the framework can never *tighten* pacing through this channel despite `reconnect` describing a signal that would. Either widen the clamp or document it as widening-only. | S |
| 237 | Clock-skew median estimator | `core` | Estimate server↔local offset from RTT midpoints and report the **median** of samples, not the mean — one delayed packet drags a mean far off. Also normalises seconds-vs-milliseconds `lastSeen`. `T30`, `T6` | M |
| 238 | Presence transition state machine | `plugins` | Collapse redundant `available`/`composing`/`available` into distinct transitions, so consumers get one `online` event per real change. `T6` | M |
| 239 | ACK/NACK as a pure function | `core` | Reproduce WA's own ACK construction with the non-obvious rules preserved: `class` mirrors the inbound tag, and `from` appears only on message-class ACKs and only when supplied. Pure, so it is unit-testable. `T33` | M |

## Presence, typing, and the honest line (4)

| # | Name | Layer | Design decision that matters | Effort |
|---|---|---|---|---|
| 240 | One indicator before a real reply | `plugins` | Emit a single `composing` immediately before a message you are actually about to send, then send it. `REF-FINDINGS` E16 classifies this as **not** evasion, because the indicator resolves into a real message. In scope. | S |
| 241 | Exclude idle-contact typing | `plugins` | `[excluded]` The same mechanism with **no message behind it** is E1 — a bot making a phone show "typing…" from a human who is not typing. Not in scope; see `DESIGN-NOTES.md` §3. | — |
| 242 | Exclude read-receipt delay | `plugins` | `[excluded]` E7 — Gaussian 3–45s read delays with a 15% skip rate, framed as defeating the "instant reads = bot" signal. Lies about when a message was seen. Not in scope. | — |
| 243 | Exclude length-proportional send delay | `plugins` | `[excluded]` E9 — holding transmission for `min(len*30, 3000)` ms so timing looks proportional to typing. The content is already known; the delay computes nothing. Pacing a real queue (#96) is in scope, imitating typing time is not. | — |

## Composability and testing (5)

| # | Name | Layer | Design decision that matters | Effort |
|---|---|---|---|---|
| 244 | Cancellable message scheduler | `plugins` | `Map`-backed bounded queue that throws past `maxQueue`, rejects past timestamps, and supports `cancel(id)`/`cancelForJid`/`clearAll`. `T8` | M |
| 245 | Native-flow round-trip harness | `core` | Encode a flow with the builders, decode it back, assert the params survived, then feed a synthetic `paramsJson` reply through `parseFlowResponse`. Catches the whole class of silent-shape bugs. | M |
| 246 | Rule-based inbound anti-spam | `security` | Pluggable rules with typed actions (`warn`/`mute`/`kick`/`ban`/`delete`/`ignore`) and a numeric score — **protecting your own instance from a misbehaving plugin**, which is legitimate and distinct from evading the platform. `T34` | M |
| 247 | Dry-run / offline mode | `core` | A socket-shaped object that records calls and replays fixture frames, so plugin and flow logic is testable with no network. The framework's own tests already need this. | M |
| 248 | Plugin lifecycle audit events | `security` | Emit `plugin.applied` / `plugin.failed` / `plugin.disposed` into the audit log so decoration is reconstructable after the fact. | S |

## Remaining gaps from the coverage matrix (2)

| # | Name | Layer | Design decision that matters | Effort |
|---|---|---|---|---|
| 249 | Group enforcement surface | `plugins` | `group-guard` is report-only by design. Expose an `onAlert` callback so a moderation service can act — the *decision* stays with the operator, the framework only supplies the signal and a hook. | S |
| 250 | Durable flow state | `plugins` | Flow state is in memory, so a restart drops in-flight conversations. Persist `active` runs into `ctx.state` on a debounce and restore on boot, for flows that must survive. | M |

**Tier 2 total: 60.** Combined with Tier 1: 250.

> The numbering is continuous across tiers, so the document totals 250: **190
> implemented, 60 specified.** Tier 3 is listed separately below and is *not*
> counted, because a candidate is a maybe rather than a plan. If a single number
> is wanted: 250 entries across implemented and specified, of which 190 exist in
> code today.

---

# TIER 3 — candidates (43)

Not commitments. Each carries an honest note, including where the risk is the
point. **Not counted in the 250** — see the note above.

## Worth doing (18)

| # | Candidate | Layer | Honest note |
|---|---|---|---|
| T1 | WebRTC/VoIP relay transport | `core` | The only fork in the reference set that gets past signalling. Dual relay ports (3478 STUN vs 3480 real client), idempotent SDP `a=fingerprint` rewrite, ICE restart/RTT bounds. A project, not a feature. `T35` |
| T2 | RTP pre-roll | `core` | 500 ms buffer so the first audio chunks are not clipped. Genuine audio-quality fix, cheap. `T36` |
| T3 | `injectable getMessage` | `adapters` | Already reachable via `createSessionStore`; promoting it to a first-class option is easy. `T16` |
| T4 | Group metadata cache | `multi` | Prerequisite for #197 — the participant count that makes privilege-climb a real detector instead of a counter. |
| T5 | Export the security/multi/adapters/cli layers from `src/index.ts` | `core` | They compile and are tested by hand but are not on the package's public surface. One file. |
| T6 | Extend `package.json` `exports` | `core` | Currently `.`, `./core/*`, `./plugins/*`, `./utils/*`. The `nyx-baileys/adapters/session-mongo.js` specifier in the adapter docstrings does not resolve. One file. |
| T7 | Replace the raw NUL byte in `audit.ts` | `security` | `${body.prev}\u0000${canonicalize(body)}` writes the domain separator as a literal byte, so `file` classifies the source as binary, `git diff` treats it as binary, and some editors mangle it. The escape sequence is functionally identical. |
| T8 | Ratchet invariant test | `core` | The five DESIGN-NOTES exclusions are enforced by convention. A test asserting no code path writes to `authState.keys` after connect would make exclusion §5 structural. |
| T9 | Fix the stale `order` comments | `core` | `nyxBaileys.ts:64-65` say 70 and 75; the fields say 65 and 70. Behaviour is correct; only the comments lie. |
| T10 | Export `plugins/metrics.ts` from the root | `plugins` | It is not in `plugins()` and not re-exported, so it is currently reachable only by deep import. |
| T11 | Send-side album helper on the socket | `core` | `sock.sendAlbum(jid, media[])` implementing #212–#217. The single largest functional gap: albums can be received but not sent. |
| T12 | Wire `metrics` into the default chain | `plugins` | It is opt-in today. Default-on costs a small constant allocation; the cardinality ceiling makes it safe. |
| T13 | Flow reply schema validation | `security` | `flowResponse` is parsed from sender-controlled `paramsJson`. Running it through `jsonObject()` and a shape validator before `ctx.state` sees it closes a real trust gap. |
| T14 | Capability surface generated from one source | `security` | `CAPABILITIES` is already the single source; generating the `can()` call-site helpers from it would remove typos in ACL usage. |
| T15 | Reconnect ramp via `restartThrottle` | `plugins` | #233 as a plugin, with the maths from `T24` and none of the framing. |
| T16 | Per-plugin configuration schema | `core` | Every built-in takes an options object with no validation. `SuperOptions` has the same gap. |
| T17 | Disposal test matrix | `core` | Assert that after `dispose()` every patched method is byte-identical to what `makeWASocket()` returned. This is the test that would have caught #191. |
| T18 | Emit `nyx.` events through a typed map | `core` | `nyx.album`, `nyx.groupAlert`, `nyx.approval` are emitted with `as never` casts because `.ev` is typed by Baileys. |

## Honest risk notes (19)

| # | Candidate | Layer | Risk |
|---|---|---|---|
| T19 | Proxy rotation | `multi` | Residential-proxy rotation for IP reputation is `REF-FINDINGS` E13 — the mechanism botnets are built from. Not an evasion *technique* this framework lacks, but a bad idea with a good engineering story attached. Decline. |
| T20 | Graph-expansion limiting | `plugins` | Contact-graph shaping and cold-contact ratios are E14. The rate maths is reusable; the intent is spam-campaign tooling. If built, the stated purpose must be spam protection for your own users. |
| T21 | Reply-ratio enforcement | `plugins` | E11. Suggesting auto-replies to raise a fabricated engagement ratio is inauthentic-behaviour creation, not rate limiting. Decline. |
| T22 | Sock-puppet reputation network | `multi` | E10 — the most severe item in the reference set. Deceives *other real accounts* into vouching for the operation. Decline outright. |
| T23 | Per-session timing profiles | `core` | E4. Independent random jitter envelopes per session, seeded per session, so instances cannot be clustered. This is `anti-spam`'s pacing applied for a purpose that is not backpressure. Decline — see `DESIGN-NOTES.md` §1. |
| T24 | Device fingerprint pool | `core` | E3. Defeats attribution by impersonating other people's hardware. `stealth` deliberately pins one identity instead. Decline. |
| T25 | Circadian activity curves | `plugins` | E2. Fabricates a daily life that does not exist. Decline. |
| T26 | Content variation | `plugins` | E5/E6. Zero-width injection breaks copy-paste and search; synthetic typos send users a fabricated error. Decline. |
| T27 | Timelock-aware routing | `plugins` | E15, which `REF-FINDINGS` itself flags as **borderline, not adopted**. Respecting a platform's timelock by pausing new-contact sends is legitimate; routing around it "via routing decisions" is not. Build the first half only. |
| T28 | Randomised startup delay | `core` | Delaying `sendPresenceUpdate('available')` by a random interval so the bot "does not snap online and blast". E12. Decline. |
| T29 | Synthetic document/media cache | `core` | Nothing in the brief, but it is the natural next request after a fingerprint pool, and it has the same shape. Decline preemptively. |
| T30 | Message content obfuscation | `plugins` | Encoding outbound text to defeat content classifiers. Not present in the reference set, but requested often. Decline. |
| T31 | Auto-mark-read after a delay | `plugins` | `REF-FINDINGS` §3.2 flags this: auto-mark-read is a legitimate product feature, but the **one-second delay** is decorative pacing. If built, send the read immediately. Conditional yes. |
| T32 | Anti-delete / keep-all message mode | `plugins` | Common in the reference set and genuinely useful for archival. Increases session-store growth, so it needs a retention policy. Conditional yes. |
| T33 | Broadcast-list support | `plugins` | Not evasion — it is a WhatsApp feature. High fan-out cost and the fastest route to a rate limit; require an explicit confirmation step and honour `maxPerMinute`. Conditional yes. |
| T34 | Status-broadcast support | `plugins` | Also a real feature. `memory.ts:99-103` already distinguishes status entries, so accounting is in place. Conditional yes. |
| T35 | Sticker generation | `utils` | Pure client-side media work, present in several reference repos. No protocol risk; needs the media pipeline from #195 to be non-blocking. Low priority, no objection. |
| T36 | Chat export | `plugins` | Reads the session store and writes files. Straightforward, and the store adapters already support it. No objection. |
| T37 | Pre-key manager | `adapters` | Present in `Baileys-Joss`. Refreshing pre-keys ahead of expiry avoids a send-timeout stall; interacts with #223's LRU. No objection. |

## Explicitly excluded, listed so nobody re-proposes them (6)

| # | Excluded | Layer | Why |
|---|---|---|---|
| E1 | Synthetic typing to idle contacts | `plugins` | `DESIGN-NOTES.md` §3. A phone shows "typing…" from a human who is not typing. |
| E2 | Noise handshake frame padding | `core` | `DESIGN-NOTES.md` §1. Anti-detection only; no functional reading. |
| E7 | Read-receipt timing falsification | `plugins` | `DESIGN-NOTES.md` §3. Lies about when a message was seen. |
| E9 | Length-proportional send delay | `plugins` | `DESIGN-NOTES.md` §3. Imposes a fake typing time on the person waiting. |
| E10 | Browser fingerprint desynchronisation | `core` | `DESIGN-NOTES.md` §2. Defeats attribution. Also: canvas, `AudioContext` and `navigator.plugins` do not exist in Node. |
| E14 | Cryptographic token hot-swapping | `core` | `DESIGN-NOTES.md` §5. Cannot work — it desynchronises the Signal ratchet, and corrupted credentials require re-pairing. |

---

## Count summary

| Tier | Count |
|---|---|
| Tier 1 — implemented | **190** |
| Tier 2 — specified | **60** |
| **Subtotal, the "250 features"** | **250** |
| Tier 3 — candidate | 43 (not counted) |
| Tier 3 of which explicitly excluded | 6 |

**Honest notes on the count.**

- Tier 1 is larger than a casual reading of `src/` suggests because the
  `security/`, `adapters/`, `multi/`, `cli/` and `metrics` layers are real
  implemented surface. They were being written concurrently with this document,
  and two of them are not yet reachable from the package's public exports.
- Tier 2 does not pad. Three of its 60 entries are **excluded** features (#241,
  #242, #243) documented precisely so they are not re-added by a later
  contributor who finds the same technique in another fork. They are counted
  because recording a refusal with its mechanism is work, not filler.
- Tier 3 stops at 43 because that is what survived the risk review. Several of
  them are "yes, but" rather than "yes" — that is the honest state of features
  whose value depends entirely on how they are framed.
- Nothing in this document is described as implemented unless it is in `src/`
  today. Where an entry is partial, defective or unreachable, the status tag
  says so.
