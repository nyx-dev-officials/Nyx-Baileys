# Nyx-Baileys

A hyper-modular WhatsApp client framework. It takes upstream
[`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys) v7, decorates
the live socket at runtime with a chain of ordered plugins, and hands you back a
real Baileys socket. No fork, no vendored copy, no edit to `node_modules`.

Version 0.1.0 · upstream `7.0.0-rc14` · Node ≥ 20 · MIT

## 60-second quickstart

```bash
npm install super-baileys
```

Pair a number — Baileys prints the QR in your terminal, scan it from
**WhatsApp → Linked devices**:

```bash
SESSION_DIR=./session node dist/index.js --pair
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
import { createSuperBaileys } from 'super-baileys';

const client = createSuperBaileys({ sessionDir: './session', logLevel: 'info' });
const sock = await client.connect();           // real WASocket, 11 plugins applied

await sock.sendMessage('15551234567@s.whatsapp.net', { text: 'hello' });

console.log(client.applied);   // ['stealth','lid-router','media-stream',…]
console.log(client.patchCount); // 8 live patches

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

Full detail: [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Project layout

```
src/
  index.ts           public surface (51 exports) + demo main()
  superBaileys.ts    the wrapper class: lifecycle, plugin chain, rebuild
  core/              socket · intercept · nodes · media · session-store
  plugins/           11 default plugins + 10 opt-in
  utils/             types · compose · logger
  adapters/          SessionStore: sqlite · mongo · prisma · redis
  multi/             SessionManager — one process, N accounts
  security/          validate · redact · permissions · acl · audit
  cli/               args · output
tests/               9 node:test suites, 195 tests
docs/                this file, ARCHITECTURE, PLUGIN-API, FEATURES,
                     DESIGN-NOTES, VERIFICATION, REF-FINDINGS
```

The default chain, in `order`: `stealth` 10 · `lid-router` 20 · `media-stream` 30
· `album` 40 · `memory-gc` 50 · `group-guard` 60 · `session-repair` 65 ·
`reconnect` 70 · `anti-spam` 80 · `flow` 90 · `warmup` 100.

## Capability coverage

Measured against `VERIFICATION.md`'s 15-role matrix, after the six fixes it
recommended were applied. Status is `VERIFICATION.md`'s, updated where a fix
changed it.

| # | Capability | Status | Where |
|---|---|---|---|
| 1 | Upstream protocol engine | covered | `core/socket.ts:83` |
| 2 | Native flow / interactive layouts | covered | `core/nodes.ts:61`, `:90`, `:151` |
| 3 | Album container (receive) | covered | `plugins/album.ts:62`, `:90` — was broken by D1 |
| 4 | Anti-spam jitter queue | covered | `plugins/antiSpam.ts:46`, `:66` |
| 5 | Identity and presence | covered | `plugins/stealth.ts:37`, `:53` |
| 6 | LID ↔ JID mapping | covered | `plugins/lid.ts:67`, `:97` |
| 7 | Native-flow form input parsing | covered | `plugins/flow.ts:95`, `:140` — was MISSING (D2) |
| 8 | Chat flow state machine | covered | `plugins/flow.ts:202`, `:238` |
| 9 | Memory GC store | partial | `plugins/memory.ts:60` — eviction inverted (D7) |
| 10 | Payload normaliser | covered | `plugins/session-repair.ts:81` — was dead (D3) |
| 11 | Multi-session core | covered | `superBaileys.ts:33`; `multi/session-manager.ts` |
| 12 | SQL/NoSQL session bridge | covered | `core/session-store.ts:128`; `adapters/` |
| 13 | Auto-retry backoff | covered | `plugins/reconnect.ts:63` — was unwired (D9) |
| 14 | Media streaming | partial | `plugins/media-stream.ts:104` — buffers whole (D10) |
| 15 | Group management | partial | `plugins/group.ts:73` — report-only, D6 tautological |

**6 of the 15 roles changed state.** Six defects were fixed and verified:
**D0** (npm scripts could not run — no `devDependencies`),
**D1** (album linkage read a field rc14 does not have),
**D2** (native-flow form submissions were invisible to the flow engine),
**D3** (`patch()` did not stack — the second wrapper discarded the first),
**D5** (paired credentials were never written to disk),
**D9** (`autoReconnect` was imported but absent from the chain).

Nine remain open: D4, D6, D7, D8, D10, D11, D12, D13, D14, plus two found
afterwards — a `patch()` pristine-stash scoping bug that makes `undo()` set a
second patched method to `undefined`, and `createEdit()` emitting a shape whose
text is silently dropped on the wire. Details and reproductions:
`ARCHITECTURE.md` §2 and §5.6.

## Honest limitations

**`npm test` does not run, and 11 tests fail when invoked directly.**
As of 2026-10-03 the type check and the build are both **green** — `npm run check`
and `npm run build` exit 0 with zero errors under `strict` +
`noUncheckedIndexedAccess`. Two things are still not right:

- **`npm test` cannot load the test directory.** The script is
  `node --test tests/`, which this Node build resolves as a module path and fails
  with `Cannot find module '…/tests'`. Invoking the files directly works:
  `node --test tests/*.test.js` gives **195 tests, 186 pass, 9 fail**.
- **The 9 failures are real defects, not flakes**, and each is a
  `BUG:`-prefixed regression test so it fails loudly rather than rot: four name
  the `patch()` pristine-stash bug below, one is media-GC eviction, one is
  `createEdit`, one is `flowResponse` propagation, and one is a
  `messageParamsJson` that parses to `null`. The count is a moving target —
  it was 11 when this was written and is dropping as the remaining work lands.

**`dist/` is current**, so those test results do describe `src/`.

**Six source layers are unreachable from the package surface.** `adapters/`,
`multi/`, `security/`, `cli/` and ten opt-in plugins compile and are documented,
but `src/index.ts` exports only the 51 core/plugins/utils names and `package.json`
`exports` maps only `.`, `./core/*`, `./plugins/*`, `./utils/*`. Deep relative
imports from `dist/` work; the `super-baileys/adapters/…` specifier their own
docstrings advertise does not resolve. A `bin/super-baileys.js` also exists on
disk with no `bin` entry in `package.json`.

Functional limits, stated plainly:

- **Albums can be received but not sent.** `createAlbumContainer()` emits the
  parent stub, and the plugin assembles incoming albums, but there is no
  `sendAlbum()`. `FEATURES.md` T11.
- **`streamMedia` is not streaming.** It decrypts the whole asset and then slices
  it. Peak memory is the full asset plus one chunk. `FEATURES.md` #195.
- **The warm-up ramp is evaluated once per socket build**, not on an interval, so
  a long-lived process holds its day-one multiplier for the socket's life.
  `FEATURES.md` #199.
- **Flow state is in memory**, so a restart drops in-flight conversations.
- **Group policy is report-only.** There is no enforcement surface; the framework
  supplies a signal and a hook, and the decision stays with the operator.
- **`createEdit()` is broken** — it emits `{editedMessage:{text}}` where rc14
  wants `{editedMessage:{message:{conversation:text}}}`, and the text is silently
  lost. `ARCHITECTURE.md` §5.6.

And the deliberate one:

- **Five requested capabilities were not built**, four because they exist to
  defeat abuse detection and one because it cannot work. They are documented
  individually, with mechanisms and reasoning, in
  [`DESIGN-NOTES.md`](./DESIGN-NOTES.md).

## Documentation

| Document | What is in it |
|---|---|
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | How the layers fit, the interception model, plugin ordering, and the rc14 API realities that cost the most time |
| [`PLUGIN-API.md`](./PLUGIN-API.md) | The `Plugin` interface, helper attachment, disposal, ordering, a complete worked example, and every socket helper the plugins add |
| [`FEATURES.md`](./FEATURES.md) | 250 entries — 190 implemented, 60 specified — plus 43 candidates, each with a status tag and a risk note |
| [`DESIGN-NOTES.md`](./DESIGN-NOTES.md) | The five refused features, what was built instead, and why |
| [`VERIFICATION.md`](./VERIFICATION.md) | Coverage matrix and the defect report that started all this |
| [`REF-FINDINGS.md`](./REF-FINDINGS.md) | Survey of 12 reference forks: 40 portable techniques, 15 classified EVASION |

## License

MIT. See [`package.json`](../package.json).

This project is not affiliated with, endorsed by, or connected to WhatsApp or
Meta. It automates accounts you own. Read WhatsApp's Terms of Service before
deploying it against anyone else's number.
