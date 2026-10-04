# Nyx-Baileys

A hyper-modular WhatsApp client framework. It takes upstream
[`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys) v7, decorates
the live socket at runtime with a chain of ordered plugins, and hands you back a
real Baileys socket. No fork, no vendored copy, no edit to `node_modules`.

Version 0.1.0 · upstream `7.0.0-rc14` · Node ≥ 20 · MIT

## 60-second quickstart

```bash
npm install nyx-baileys
```

Pair a number. rc14 removed terminal QR rendering, so ask for the 8-character
code and type it in via **WhatsApp → Linked devices → Link a device**:

```bash
npx nyx-baileys pair --dir ./session --phone 628334549585
```

No `--phone` and it waits for a QR scan instead, printing the ref. The code is
void about 30 s after it is issued, so have the phone open first.

```bash
npx nyx-baileys status --dir ./session     # is it paired, and what state
```

Send something:

```bash
SESSION_DIR=./session node dist/index.js --to 15551234567@s.whatsapp.net
```

That runs the demo: a paced text message, a native-flow form, a carousel, a data
table and a fenced status block. Pass no `--to` and it prints the helper table
instead and stays connected.

Programmatically:

```ts
import { createNyxBaileys } from 'nyx-baileys';

const client = createNyxBaileys({ sessionDir: './session', logLevel: 'info' });
const sock = await client.connect();           // real WASocket, 13 plugins applied

await sock.sendMessage('15551234567@s.whatsapp.net', { text: 'hello' });

console.log(client.applied);   // ['stealth','lid-router','media-stream',…]
console.log(client.patchCount); // live runtime patches

await client.dispose();
```

Configuration is by environment variable in the demo (`src/index.ts:187-201`):
`SESSION_DIR`, `LOG_LEVEL`, `WARMUP_DAYS`, `MIN_GAP_MS`, `JITTER_MS`,
`MAX_PER_MIN`. Configure by object in code — `SuperOptions` is at
`src/utils/types.ts:60-82`.

## Architecture in one paragraph

`makeWASocket()` is called once and its result is returned unmodified in type.
Everything downstream decorates that object at runtime rather than replacing it.
The primitive is `patch(target, name, wrapper)` in `src/core/intercept.ts`, which
wraps a method and passes the wrapper **the implementation that was in place at
the moment of the patch** — so two plugins that both wrap `sendMessage` compose
into `B(A(original))` instead of one silently discarding the other. Each patch
stashes a pristine copy on a well-known symbol and returns an undo handle, so
`dispose()` unwinds the socket back to exactly what upstream returned. Plugins
declare `{name, order, apply}` and are applied in ascending `order`; each is
isolated, so one that throws costs you that plugin and not the socket. Helpers
that cannot be socket methods without lying about its type — `resolveJid`,
`downloadMedia`, `flows`, `health` — are attached with
`Object.defineProperty(..., {enumerable: false})` and consumed through one
explicit cast. Nothing in `node_modules` is touched at any point.

Full detail: [`ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## Performance and the `lite` entry

The root entry re-exports all of Baileys, which is correct for anything that
opens a socket and wasteful for a script that only wants JID helpers, a clock
estimate or the text utilities — the upstream protocol stack is protobufjs and
libsignal, and you pay for it at import time whether you dial out or not.

`nyx-baileys/lite` carries the pure surface only and pulls **none** of the
engine. Nothing in its transitive import graph may import
`@whiskeysockets/baileys`; `tests/lite.test.js` walks the built graph and fails
the suite if that rule is broken.

```ts
import { canonicalThreadKey, chunkText, formatDuration } from 'nyx-baileys/lite';
```

Cold import, on this machine (Node 24):

| Entry | Time | Heap | Exports |
|---|---|---|---|
| `nyx-baileys` (root) | ~931 ms | ~26.2 MB | 600 |
| `nyx-baileys/lite` | ~48 ms | ~5.4 MB | 148 |

That is **~95% faster and ~79% lighter** for a script that never opens a socket.

### The inbound hot path

The other cost is per-message work on `messages.upsert`. Profiling 100k messages
across 500 chats showed the chain spending its time on **garbage**, not on
logic — three allocations per message, each costing more than the work around
it. The worst of them was a `sweep()` per *message* that walked every chat on a
500-chat deployment:

- **memory GC** enforced the per-chat cap by allocating a fresh array on every
  message past the cap. The allocation, not the copy, was the cost: 1.05 µs per
  message against 0.07 µs for the push alone. Dropping the oldest entry with
  `shift` (a memmove, no allocation) costs 0.145 µs. It also no longer walks
  every chat on the upsert path.
- **Clock sync** allocated a `{ rtt, skew }` object per sample and memmoved the
  window on every push. It is now a fixed-capacity `Float64Array` ring.
- **Media lookup** probed all seven rc14 media fields per message. Seven *misses*
  against a megamorphic shape cost more than walking the keys the message
  actually has — 202 ns → 32 ns on a bare `{ conversation }`.

| | Before | After |
|---|---|---|
| Default chain, per message | ~16.0 µs | **~0.61 µs** |

That is **~96% less overhead per inbound message** (~26x). The two figures were
measured back to back, same machine, same load — which matters, because the
absolute number on a shared box drifts by nearly 2x. Compare ratios, not
single readings.

Run either bench yourself:

```bash
npm run bench -- 100000 500                    # chain overhead, best of 7 trials
npm run bench:plugins -- 100000 500            # which plugin costs what
```

Both report the **minimum across trials** with a forced GC between them, and
attribute cost per plugin *in isolation* — measuring plugins cumulatively
attributes a GC pause to whichever step follows it, which produces impossible
negative "savings".

### Engine-free bot primitives

`nyx-baileys/lite` also carries the modules a script author needs before a
socket exists, all of them pure:

| Module | What it is |
|---|---|
| `JsonStore` | persistent JSON document, debounced autosave, atomic writes |
| `Scheduler` | interval / one-shot / five-field cron, with contained failures |
| `ConversationStore` | per-user state with a TTL and a hard size ceiling |
| `parseIncoming` | text, mentions, quoted reply and command/argument parsing |

### Group moderation

```ts
import { moderation, welcome } from 'nyx-baileys/plugins';

client
  .registerPlugin(moderation({
    words: [{ pattern: ['free crypto', /wa\.me\/[a-z0-9]+/i] }],
    links: { blockInvite: true, allowDomains: ['example.com'] },
    flood: { max: 6, windowMs: 8_000 },
    // The ladder is data: delete → mute → kick → ban, and `Infinity` means
    // “never”, so a stage you did not configure is genuinely off.
    strikes: { deleteAt: 1, muteAt: 3, kickAt: 5, banAt: 8, decayMs: 86_400_000 },
    exempt: (jid) => owners.has(jid),
    isAdmin: (jid) => admins.has(jid),
  }))
  .registerPlugin(welcome({ templates: { add: 'Welcome, {name}.' } }));
```

`moderation` emits `nyx.moderation` for every decision and does nothing else.
`dryRun: true` reports without acting, which is how you tune a ladder against a
real group. Two honest limits: WhatsApp has **no server-side per-member mute**, so
`isMuted()` is an advisory flag your own command handler gates on, and
exemptions are checked on the action path too — a mod bot that removes the human
running it is the outage this design exists to prevent.

## Project layout

```
src/
  index.ts           public surface (500+ exports) + demo main()
  lite.ts            engine-free entry: pure helpers only, no baileys
  nyxBaileys.ts    the wrapper class: lifecycle, plugin chain, rebuild
  core/              socket · intercept · nodes · media · session-store ·
                     clock · delivery · retry · errors · jid · album
  plugins/           13 default plugins + 12 opt-in feature plugins
  antiban/           opt-in anti-ban engines — see docs/ANTIBAN.md
  integrations/      keyless HTTP integrations + Indonesian localisation
  utils/             types · compose · logger · text · format · random ·
                     time · args · cache · queue
  adapters/          SessionStore: sqlite · mongo · prisma · redis
  multi/             SessionManager — one process, N accounts
  security/          validate · redact · permissions · acl · audit
  cli/               args · output
bot/               command loader + createNyxBot host for bot scripts
tests/               37 node:test suites, 631 tests
docs/                this file, ARCHITECTURE, PLUGIN-API, FEATURES,
                     DESIGN-NOTES, VERIFICATION, REF-FINDINGS, ANTIBAN
```

The default chain, in `order`: `stealth` 10 · `clock-sync` 15 · `lid-router` 20
· `media-stream` 30 · `album` 40 · `memory-gc` 50 · `group-guard` 60 ·
`session-repair` 65 · `reconnect` 70 · `anti-spam` 80 · `delivery` 85 · `flow`
90 · `warmup` 100.

## Running a bot

nyx-baileys ships the pieces a WhatsApp bot script otherwise hand-rolls: a
command router with owner/admin/cooldown guards and a category menu, a loader
for a directory of command modules, and `createNyxBot()` to wire them together.

```bash
OWNERS=15551234567 node examples/bot/index.mjs
```

```ts
import { createNyxBot } from 'nyx-baileys';

const bot = await createNyxBot({
  sessionDir: './session',
  owners: ['15551234567'],
  commandsDir: './commands',
});
// /menu, /ping, and every command in ./commands are live.
```

See [`examples/bot/`](./examples/bot/) for a working bot and
[the bot README](./examples/bot/README.md) for the command contract.

## Capability coverage

Measured against `VERIFICATION.md`'s 15-role matrix, after the full remediation
pass. Status is `VERIFICATION.md`'s, updated where a fix changed it.

| # | Capability | Status | Where |
|---|---|---|---|
| 1 | Upstream protocol engine | covered | `core/socket.ts:83` |
| 2 | Native flow / interactive layouts | **serialises, cannot send** | `core/nodes.ts:61`, `:90`, `:151` — rc14 rejects `interactiveMessage`; see [Buttons](#buttons-and-interactive-layouts) |
| 3 | Album container (receive) | covered | `plugins/album.ts:62`, `:90` — was broken by D1 |
| 4 | Anti-spam jitter queue | covered | `plugins/antiSpam.ts:46`, `:66` |
| 5 | Identity and presence | covered | `plugins/stealth.ts:37`, `:53` |
| 6 | LID ↔ JID mapping | covered | `plugins/lid.ts:67`, `:97` |
| 7 | Native-flow form input parsing | covered | `plugins/flow.ts:95`, `:140` — was MISSING (D2) |
| 8 | Chat flow state machine | covered | `plugins/flow.ts:202`, `:238` |
| 9 | Memory GC store | covered | `plugins/memory.ts` — refcount-guarded eviction (D7) |
| 10 | Payload normaliser | covered | `plugins/session-repair.ts:81` — was dead (D3) |
| 11 | Multi-session core | covered | `nyxBaileys.ts:33`; `multi/session-manager.ts` |
| 12 | SQL/NoSQL session bridge | covered | `core/session-store.ts:128`; `adapters/` |
| 13 | Auto-retry backoff | covered | `plugins/reconnect.ts:63` — was unwired (D9) |
| 14 | Media streaming | covered | `plugins/media-stream.ts` — true `stream` path (D10) |
| 15 | Group management | covered | `plugins/group.ts` — membership-ratio climb (D6) |

**All 15 roles are covered.** Fifteen defects were fixed and verified:
**D0** (npm scripts could not run — no `devDependencies`),
**D1** (album linkage read a field rc14 does not have),
**D2** (native-flow form submissions were invisible to the flow engine),
**D3** (`patch()` did not stack — the second wrapper discarded the first),
**D4** (`goto()` after `end()` dropped silently),
**D5** (paired credentials were never written to disk),
**D6** (privilege-climb signal was tautological),
**D7** (media GC evicted the blobs it should keep),
**D8** (disposables were not reset across rebuilds),
**D9** (`autoReconnect` was imported but absent from the chain),
**D10** (`streamMedia` buffered the whole asset),
**D11** (`patchAll` handles could double-undo),
**D12** (album parent arriving late never resolved the count),
**D13** (`main()` installed a second `connection.update` listener),
**D14** (the warm-up ramp was applied once and never advanced).

Also fixed: a `patch()` pristine-stash scoping bug that made `undo()` set a
second patched method to `undefined`, and `createEdit()` emitting a shape whose
text was silently dropped on the wire. Every fix has a regression test in
`tests/`.

## Honest limitations

The verify chain is green as of 2026-10-03: `npm run check` and `npm run build`
exit 0 under `strict` + `noUncheckedIndexedAccess`, and `npm test` reports
**631 tests, 631 pass, 0 fail** in ~4s.

The suite covers the primitives that everything else depends on — interception
chaining and unwind, native-flow serialisation, album linkage, the jitter queue,
payload normalisation, memory bounds, group thresholds, flow extraction — but it
runs against fake sockets. A number is now paired and live, and connection,
login, credential persistence and plain-text delivery are verified against it —
including by screenshot on a physical phone. Everything else below still rests on
unit tests alone, and [HOW-IT-WORKS.md](./docs/HOW-IT-WORKS.md) carries an
honest per-area status table.

A few functional limits, stated plainly:

- **The warm-up ramp only advances on the hour.** It re-evaluates on a one-hour
  interval rather than continuously, so the multiplier can lag the true session
  age by up to an hour.
- **Flow state is in memory**, so a restart drops in-flight conversations.
- **Group enforcement is opt-in.** `groupGuard` is report-only, but `moderation` is a
  real surface — delete, mute, kick and ban. It is off by default because who gets
  removed from a group is the operator's decision, not the library's.
- **The anti-ban pack is opt-in and its effect is not measurable here.** Its
  mechanics are unit-tested; whether it actually helps an account is not
  something this repository can claim. [`ANTIBAN.md`](./docs/ANTIBAN.md).

The project was named "Super Baileys" until v0.1.0. `SuperBaileys` and
`createSuperBaileys` remain as deprecated aliases for one release so the rename
is not a breaking change; internal event namespaces moved from `super.*` to
`nyx.*`, which *is* breaking for anyone subscribing to them.

And the deliberate one:

- **Five requested capabilities were not built**, four because they exist to
  defeat abuse detection and one because it cannot work. They are documented
  individually, with mechanisms and reasoning, in
  [`DESIGN-NOTES.md`](./docs/DESIGN-NOTES.md).

## Documentation

| Document | What is in it |
|---|---|
| [`ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | How the layers fit, the interception model, plugin ordering, and the rc14 API realities that cost the most time |
| [`PLUGIN-API.md`](./docs/PLUGIN-API.md) | The `Plugin` interface, helper attachment, disposal, ordering, a complete worked example, and every socket helper the plugins add |
| [`HOW-IT-WORKS.md`](./docs/HOW-IT-WORKS.md) | **Start here.** Task-oriented: "I want X, the code is Y" — with an honest per-area table of what is unit-tested versus what has actually run against WhatsApp |
| [`FEATURES.md`](./docs/FEATURES.md) | 250 entries — 190 implemented, 60 specified — plus 43 candidates, each with a status tag and a risk note |
| [`DESIGN-NOTES.md`](./docs/DESIGN-NOTES.md) | The five refused features, what was built instead, and why |
| [`VERIFICATION.md`](./docs/VERIFICATION.md) | Coverage matrix and the defect report that started all this |
| [`REF-FINDINGS.md`](./docs/REF-FINDINGS.md) | Survey of 12 reference forks: 40 portable techniques, 15 classified EVASION |
| [`ANTIBAN.md`](./docs/ANTIBAN.md) | The opt-in anti-ban module set: what it does, how to enable it, and what is deliberately not ported |

## License

MIT. See [`package.json`](./package.json).

This project is not affiliated with, endorsed by, or connected to WhatsApp or
Meta. It automates accounts you own. Read WhatsApp's Terms of Service before
deploying it against anyone else's number.
