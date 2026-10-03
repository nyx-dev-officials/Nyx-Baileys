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
import { createNyxBaileys } from 'nyx-baileys';

const client = createNyxBaileys({ sessionDir: './session', logLevel: 'info' });
const sock = await client.connect();           // real WASocket, 13 plugins applied

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
  index.ts           public surface (500+ exports) + demo main()
  nyxBaileys.ts    the wrapper class: lifecycle, plugin chain, rebuild
  core/              socket · intercept · nodes · media · session-store ·
                     clock · delivery · retry · errors · jid · album
  plugins/           13 default plugins + 10 opt-in feature plugins
  antiban/           opt-in anti-ban engines — see docs/ANTIBAN.md
  integrations/      keyless HTTP integrations + Indonesian localisation
  utils/             types · compose · logger
  adapters/          SessionStore: sqlite · mongo · prisma · redis
  multi/             SessionManager — one process, N accounts
  security/          validate · redact · permissions · acl · audit
  cli/               args · output
tests/               19 node:test suites, 286 tests
docs/                this file, ARCHITECTURE, PLUGIN-API, FEATURES,
                     DESIGN-NOTES, VERIFICATION, REF-FINDINGS, ANTIBAN
```

The default chain, in `order`: `stealth` 10 · `clock-sync` 15 · `lid-router` 20
· `media-stream` 30 · `album` 40 · `memory-gc` 50 · `group-guard` 60 ·
`session-repair` 65 · `reconnect` 70 · `anti-spam` 80 · `delivery` 85 · `flow`
90 · `warmup` 100.

## Capability coverage

Measured against `VERIFICATION.md`'s 15-role matrix, after the full remediation
pass. Status is `VERIFICATION.md`'s, updated where a fix changed it.

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
**286 tests, 286 pass, 0 fail** in ~3.8s.

The suite covers the primitives that everything else depends on — interception
chaining and unwind, native-flow serialisation, album linkage, the jitter queue,
payload normalisation, memory bounds, group thresholds, flow extraction — but it
runs against fake sockets. Nothing here has been exercised against a live paired
account, so poll votes, newsletters and client-side form rendering are
unverified end to end.

A few functional limits, stated plainly:

- **The warm-up ramp only advances on the hour.** It re-evaluates on a one-hour
  interval rather than continuously, so the multiplier can lag the true session
  age by up to an hour.
- **Flow state is in memory**, so a restart drops in-flight conversations.
- **Group policy is report-only.** There is no enforcement surface; the framework
  supplies a signal and a hook, and the decision stays with the operator.
- **The anti-ban pack is opt-in and its effect is not measurable here.** Its
  mechanics are unit-tested; whether it actually helps an account is not
  something this repository can claim. [`ANTIBAN.md`](./ANTIBAN.md).

The project was named "Super Baileys" until v0.1.0. `SuperBaileys` and
`createSuperBaileys` remain as deprecated aliases for one release so the rename
is not a breaking change; internal event namespaces moved from `super.*` to
`nyx.*`, which *is* breaking for anyone subscribing to them.

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
| [`ANTIBAN.md`](./ANTIBAN.md) | The opt-in anti-ban module set: what it does, how to enable it, and what is deliberately not ported |

## License

MIT. See [`package.json`](../package.json).

This project is not affiliated with, endorsed by, or connected to WhatsApp or
Meta. It automates accounts you own. Read WhatsApp's Terms of Service before
deploying it against anyone else's number.
