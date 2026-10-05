# Changelog

All notable changes to `nyx-baileys`. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
semantic versioning with a `0.x` line.

## [0.3.1] — 2026-10-06

### Added

- ** plugin** — group subject, description, invite link and revoke, plus
  per-chat mute, archive, pin, star, label, clear and mark-read. Every entry
  validates its jid before touching the socket, and sends exactly one
   union member — rc14's  is a discriminated union, and
  passing two settings in one call matches no member and silently picks a branch.
  Star is a , not a  content key.

- ** module** — 20 operational helpers: a binary stanza observer, a
  headless pairing-code extractor for containers with no scannable QR, a raw
  AES-GCM media decryptor, a session integrity auditor, a socket heartbeat, a
  priority queue, an RTT probe, a group delta listener, an app-state injector, an
  ephemeral scavenger, and the everyday chat/group operations.

  One deliberate deviation:  resolves  at
  runtime rather than importing it. That export does not exist in rc14, and a
  static import of a missing binding throws at module-evaluation time, taking the
  whole module down. Lazy lookup keeps everything else working and lets this one
  function name its own absence.



### Added

- **`chatOps` plugin** — group subject, description, invite link and revoke, plus
  per-chat mute, archive, pin, star, label, clear and mark-read. Every entry
  validates its jid before touching the socket, and sends exactly one
  `chatModify` union member — rc14's `chatModify` is a discriminated union, and
  passing two settings in one call matches no member and silently picks a
  branch. Star is a `chatModify`, not a `sendMessage` content key.

- **`toolkit` module** — 20 operational helpers: a binary stanza observer, a
  headless pairing-code extractor for containers with no scannable QR, a raw
  AES-GCM media decryptor, a session integrity auditor, a socket heartbeat, a
  priority queue, an RTT probe, a group delta listener, an app-state injector,
  an ephemeral scavenger, and the everyday chat/group operations.

  One deliberate deviation: `rawDecryptMedia` resolves `decryptMediaMessage` at
  runtime rather than importing it. That export does not exist in rc14, and a
  static import of a missing binding throws at module-evaluation time, taking
  the whole module down. Lazy lookup keeps everything else working and lets this
  one function name its own absence.

Patched release: `v0.3.0` was cut at `06b98b3`, before the `chatOps`
plugin and the `toolkit` module landed in `c17c732`. Publishing from that tag
would have shipped a package missing both, so the version moves to 0.3.1 and
the tarball is verified to contain all 24 export targets.
## [0.3.0] — 2026-10-05

### Breaking

- **`createEdit` signature changed.** `createEdit(text)` returned a
  `FutureProofMessage` wrapper that encoded to **15 bytes** with no
  `protocolMessage`, no target key and no edit type — it carried no text and named
  nothing to edit. rc14 assembles an outbound edit at `Utils/messages.js:514` when
  it sees an `edit` key, so the correct form is `{ text, edit: targetKey }`.

  ```ts
  // before — silent no-op
  const node = createEdit('after');

  // after
  const original = await sock.sendMessage(jid, { text: 'before' });
  await sock.sendMessage(jid, createEdit(original.key, 'after'));
  ```

  Callers of the old form now receive `undefined` as the target key rather than a
  compile error. The 71-byte real form carries `type: 14` (`MESSAGE_EDIT`), the
  parent key and the text.

  Note for anyone who "fixed" this before: a hand-built `FutureProofMessage` is a
  genuine protobuf type, so it compiles without complaint and looks correct. It is
  the wrapper for `viewOnce` and ephemeral framing, not for edits.

- **`adapters/` removed.** `sqlite`, `mongo`, `prisma` and `redis` session stores
  are gone — 1,472 lines. Nothing outside `src/adapters/` imported them, verified
  before deletion. `src/index.ts` no longer re-exports them and `package.json` no
  longer maps `./adapters` or `./adapters/*`. The export surface is 22 targets.
  Implement `SessionStore` directly if you need one.

### Added

- **`interactive` plugin — interactive messages that actually arrive.**
  `listMessage`, `buttonsMessage`, `templateMessage` and `interactiveMessage` are
  rejected by rc14's `generateWAMessageContent` with `Boom: Invalid media type`.
  Routing around that is not enough on its own: `generateWAMessageFromContent` +
  `relayMessage` returns a clean message ID, resolves without error, and delivers
  nothing. The elements live in stanza nodes, and those must be passed to
  `relayMessage` as `additionalNodes`:

  ```
  biz
  └─ interactive  type=native_flow v=1
     └─ native_flow  name=quick_reply
  bot  biz_bot=1        ← 1:1 chats only
  ```

  Verified on a paired consumer account: quick-reply buttons render, are tappable,
  and their replies route back. The `native_flow` name must match the flow sent.
  Intercepts at order 66 — above `session-repair` (65), below every pacing wrapper
  — so an interactive send cannot be delayed or swallowed by a queue that does not
  understand it.

  `toInteractiveInner()` converts `buttonsMessage` and `listMessage` into native
  flows, because neither is an `InteractiveMessage` shape. Passing either to
  `InteractiveMessage.fromObject` does not throw; it silently discards every field.
  A bare-string `buttonText` is accepted alongside the nested `{ displayText }`.

- **`healRegisteredFlag()`.** rc14 sets `registered` in exactly one place — the
  `companion_finish` branch of `messages-recv.js:940` — and that notification does
  not arrive on this path, so a correctly paired session still reports itself
  unpaired and every socket-dependent command refuses it. `pair` now corrects the
  flag on disk once the device is genuinely provisioned. A fresh session has no
  `me.id` and no `account.deviceSignature`, so the heal cannot fire on one.

### Fixed

- **Pairing CLI defects** — readiness is a `qr` update, not `connection === 'open'`;
  a half-finished session is detected and reported before any network call instead of
  three silent 401s; `creds.json` writes are serialised, because concurrent async
  writes truncated it to 0 bytes and destroyed a paired session.
- **Credential persistence** — `core/socket.ts` registers the `creds.update`
  listener. rc14 emits that event from many places and persists nothing itself.
- **Three awaited timers were `unref()`'d** in `queue.ts`, `album.ts` and
  `antiban.ts`, so their backoff timers never fired. Covered by isolated
  child-process regression tests.

### Known limitations

- **Sectioned lists do not work on consumer accounts.** `single_select` returns a
  valid message ID and is silently stripped by the server — a Business-tier gate,
  not a payload problem. The encoder accepts it, the server accepts the stanza, then
  deletes the interactive node in transit. Ruled out by live differential:
  malformed payloads (`ListMessage.buttonText` required, `IButton.buttonText` a
  nested message), a missing `messageSecret` reporting token, message-vs-wrapper
  shape, and plugin ordering. Only the Business API or a Business account produces
  a sectioned menu.
- **`cta_url`, `cta_copy` and `cta_call` are unverified** on consumer accounts.
  Reported whitelisted by server policy; not tested here.

### Verified against hardware

Everything in this release was exercised on a paired consumer account
(), against a physical phone, with screenshots rather than return
values.  returns a clean message ID whether or not WhatsApp accepts the
stanza, so a returned ID is not evidence of anything.

**Confirmed rendering:** text · mention · poll · poll vote · location · contact ·
image · album · document · video · voice note · sticker · quick-reply buttons ·
cta_url · cta_call · cta_copy · listMessage (as a plaintext menu) · reaction ·
delete · edit · forwarded (single and multiple) · quoted reply · pin (24h bucket
with a scheduled unpin) · 15-second ephemeral · group send · presence (all four
states, including  and ) · profile name · profile picture ·
block / unblock · read-receipt plumbing · webhook delivery to a live HTTP sink.

**Known limits, established rather than assumed:**

- **Sectioned lists are impossible on a consumer account.**  returns
  a valid ID and is stripped by the server. Not a payload problem — four
  hypotheses were tested and eliminated first.
- **Profile About cannot be written from a linked device.** The stanza is
  correct on the wire (, emoji, duration all present) and the server discards
  it.  on the status namespace returns nothing at all, so read-back is
  impossible in principle.
- ** is not a flow name.**  is; the longer spelling
  encodes fine and never arrives.

724 tests, up from 538.

---
## [0.2.0] — 2026-10-04

Base commit `5d041e6`. This release is **the pairing repair**. Eight defects,
five of them in `src/cli/`, and all eight reachable because the CLI had no tests
at all — `tests/args.test.js` covers the command *plugin*'s parser, not
`dist/cli/`.

### Fixed

- **`connection === 'open'` never fires while a session is unregistered.** Auth has
  not completed, so there is nothing to be open *to*. `connected to WA` is a
  Baileys **log line, not an event**, which is what makes this easy to misread.
  Readiness is now a `qr` update, and it is awaited only when a pairing code is
  actually requested — waiting on the QR path turned a working scan into a
  timeout.
- **`registered` is set in exactly one place in rc14** — the `companion_finish`
  branch of `messages-recv.js:940` — and that notification does not arrive. A
  fully provisioned device therefore read as unpaired and every socket-dependent
  command refused to run. `isProvisioned()` now derives pairing from what
  WhatsApp actually supplied: `me.id` plus `account.deviceSignature`.
- **`creds.json` was truncated to 0 bytes by its own shutdown.** Baileys persists
  with an async `writeFile` that truncates before writing, and the CLI watchdog
  called `process.exit()` without waiting for it. An empty file is then read back
  as a fresh session, so the next run silently re-paired. Saves are now serialised
  and `dispose()` awaits the last one.
- **`pair` could never request a pairing code.** rc14 emits a QR ref and never
  volunteers one. `--phone` requests it, and is validated *before* the socket
  opens so a typo costs no connection attempt.
- **`--json pair` wrote to neither stream.** Pairing artifacts now go to stderr as
  JSON lines, keeping the one-object stdout contract intact.
- **`send` and `form` rejected bare phone numbers**, despite documenting them.
  `toRecipientJid()` normalises; anything already carrying an `@` passes through.
- **Three timers that resolve awaited promises were `unref()`'d.** `withRetry`'s
  backoff sleep, `waitForAlbum`'s timeout, and `readReceiptVariance`'s
  `readMessages` delay. An unref'd timer does not hold the event loop open, so in
  a process where that timer is the only pending work Node concludes the loop is
  empty and exits. The awaited promise then never settles and the caller's
  `await` never returns — silently, with no error at all. It surfaced on CI as
  four tests reported `cancelledByParent` alongside `# fail 0`, which is what
  node does when the process exits part-way through a file. It never reproduced
  locally because a dev machine always has other handles open.
- **Background schedules are deliberately still `unref()`'d.** `humanEntropy`'s
  activity timer must not be able to hold a short-lived script open, so both
  directions are now pinned by tests.
- **`dist/cli/index.js` exited 0 having done nothing** when run directly. It now
  dispatches; the barrel is unchanged for importers.

### Added

- `interactive` — sends the message types rc14 refuses. `listMessage`,
  `buttonsMessage`, `templateMessage`, `interactiveMessage` and the carousel,
  collection, product and contact variants now go out instead of throwing
  `Invalid media type`. It patches `sendMessage`, builds the message with
  `generateWAMessageFromContent`, relays it with the options `sendMessage` itself
  would pass, and emits the local-history update so the sender sees the message
  afterwards. Content the upstream chain already understands is passed straight
  through untouched. Opt-in, like the other feature plugins.
- `moderation` and `welcome` — group enforcement. Word, link and flood rules into
  a configurable strike ladder (delete · mute · kick · ban), and join/leave/
  promote/demote announcements with cooldown, per-event collapsing and rejoin
  suppression. Both opt-in: who gets removed from a group is the operator's
  decision, not the library's.
- `announceAt` is wired, with `announceText` and per-kind defaults. Fires from
  that rung upward, like every other rung.
- `welcome` gained `dryRun`, mirroring `moderation`. Without it there was no way
  to exercise the plugin against a live socket without posting to a real group.
- `nyx-baileys selftest` — verifies the engine against a live session and sends
  **nothing** unless `--send` (one message to Note to Self) or `--group`. Each
  check declares its evidence class: `read`, `synthetic`, or `local`.
- `pair --reset` recovers a half-negotiated session, which previously had no
  recovery path at all.
- GitHub Actions CI on Node 20 and 22, running typecheck, lint, build, test and
  an export-map check.
- `scripts/check-exports.mjs`. The `exports` map is a contract and `tsc` has no
  opinion about whether its strings resolve.
- `docs/HOW-IT-WORKS.md` — task-oriented, with a per-area table of what is
  unit-tested versus what has actually run against WhatsApp.

### Known limitations

- **rc14 cannot send interactive messages *natively*,** and the `interactive`
  plugin works around it rather than fixing upstream. `generateWAMessageContent`
  is an if/else chain over the content keys it knows and its final `else` throws
  `Invalid media type`, so `listMessage`, `buttonsMessage`, `templateMessage` and
  `interactiveMessage` are rejected by `sendMessage` itself. The builders in
  `core/nodes.ts` always serialised them correctly; only delivery was missing.
- **Template and native-flow messages remain WhatsApp Business surfaces.**
  `interactive` fixes delivery, not client support — consumer WhatsApp will not
  render them even once they arrive. `listMessage` and `buttonsMessage` are
  consumer-supported and render everywhere.
- Newsletter, and `stealth` / `metrics` / `webhooks` / `call-log` /
  `read-receipts` / `send-presence` / `anti-delete`, are unit-tested but have
  never been run against live WhatsApp.

### Tests

538 → **681**, 40 suites. Seven previously untested plugins now have coverage, a
flaky `JsonStore` autosave test was made deterministic rather than merely
re-run, and the `interactive` plugin ships with 14 tests of its own.

## [0.1.0]

First tagged release. Named "Super Baileys" until v0.1.0; `SuperBaileys` and
`createSuperBaileys` remain as deprecated aliases for one release. Internal event
namespaces moved from `super.*` to `nyx.*`, which **is** breaking for anyone
subscribing to them.

[0.2.0]: https://github.com/nyx-dev-officials/Nyx-Baileys/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/nyx-dev-officials/Nyx-Baileys/releases/tag/v0.1.0