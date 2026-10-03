# Reference Survey — Technique Taxonomy

## What this document is

A survey of techniques found across the WhatsApp client library ecosystem —
upstream forks, community wrappers, browser-side extraction tools, and API
servers. Written while reverse-engineering the protocol surface to build this
framework.

**Sources are described by capability, not by name.** The techniques below are
documented because they are the useful way to do something. Several appeared in
public forks, and attributing them individually would mostly amount to holding
named individuals responsible for the state of an ecosystem they do not control.
Where a specific claim matters to a reader — "does fork X actually change the
socket?", "is this repo abandoned?" — the honest answer is usually *it does not
matter*, because the technique is already documented upstream or is trivially
reimplementable.

Every `file:line` that once pointed into a third-party checkout has been removed
along with the attribution. Nothing below is copyable from another project; it
is a description of what the protocol requires.

## Why the split matters

Roughly 40 techniques found were **portable** — real engineering that improves
reliability, correctness, or performance. About 15 were **evasion**: their
purpose is to defeat platform abuse detection. See
[`DESIGN-NOTES.md`](./DESIGN-NOTES.md) for why the second category is not
implemented here.

The distinction is not always clean. One anti-spam fork mixed genuinely good
queue and breaker code beside modules whose only function was presence
fabrication. Bucketing by *intent* rather than by repository is the only way to
sort them — a good technique in a bad repo is still a good technique, and a bad
technique next to good code is still a bad technique.

---

## 1. Native flow payloads

The single most valuable thing in the survey, and the hardest to get right by
guessing.

### 1.1 The wire shape

Native flow on the current upstream release is **three fields**, not a nested
object:

```ts
{
  messageVersion: number
  messageParamsJson: string     // the entire UI, as a JSON string
  buttons: [{ name: string, buttonParamsJson: string }]
}
```

The rich section/row schema is **not** in the protobuf. It lives inside
`messageParamsJson`, serialised by the client and parsed by the client. This is
why hand-built protobuf objects for flows either silently drop fields or encode
to a few bytes of nothing.

### 1.2 Button construction

- Buttons are a flat array. Each entry has a real proto `name`; the payload is
  the opaque `buttonParamsJson` string.
- There are five distinct control names. Not all accept the same fields.
- `merchant_url` is **mandatory** on the checkout control — omitting it does not
  degrade the button, it invalidates it.
- Icons are upper-cased by the client, so mixed-case input is harmless but
  inconsistent.
- Parent-level controls (`bottom_sheet`, `limited_time_offer`) live in a
  **separate container-level** `messageParamsJson`, not per-button. This is the
  most common mistake and it is invisible until the control does not appear.

### 1.3 Shorthand vs explicit

Some wrappers accept a shorthand and expand it internally; others construct
`NativeFlowMessage` directly. The expansion step is where fields get lost —
preferring the explicit constructor removes a whole class of bug.

### 1.4 Response decoding

A flow reply arrives as `interactiveResponseMessage.nativeFlowResponseMessage`,
carrying `{ name, paramsJson, version }`. The `paramsJson` echoes the structure
the sender built, so the sender can parse its own option ids back out.

A `native_flow_name` stanza attribute is required on the outbound form for the
client to bind the reply correctly. Without it the form renders but the response
never routes back.

**Implemented here** in `src/core/nodes.ts`. See `session-repair.ts` for the
`optionName` backfill that catches malformed rows.

---

## 2. Multi-media containers

### 2.1 The two-phase model

An album is **not** one message carrying a media array:

1. A parent `albumMessage` carries **only counts** — `expectedImageCount`,
   `expectedVideoCount`. There is no media array and nothing to decrypt.
2. Each media item arrives as a **separate sibling message**, linked back to the
   parent.

### 2.2 Where the link actually lives

The obvious guess — `mediaMessage.albumParentKey` — **does not exist** in the
current schema. The link is:

```
message.contextInfo.messageAssociation
  .associationType  === MEDIA_ALBUM
  .parentMessageKey  → the parent
  .messageIndex      → sibling ordering
```

Getting this path wrong returns `undefined` forever with no error, so albums
silently never assemble. Verified against both placements: `ContextInfo` carries
no `messageAssociation`; `MessageContextInfo` does.

### 2.3 Older shape

Some clients ship `albumMessage.media` / `groupedMediaMessage.media` nested
inline. Handling both is cheap and worth it.

**Implemented here** in `src/core/media.ts` (traversal) and
`src/plugins/album.ts` (assembly and deferred decrypt).

---

## 3. Multi-session and durable session storage

### 3.1 Tenant isolation at the schema level

The pattern worth copying from any multi-session server: **every table carries
`sessionId`**, and every uniqueness constraint is composite:

```prisma
model SessionKey {
  sessionId String
  type      String
  keyId     String
  @@unique([sessionId, type, keyId])
  @@index([sessionId])
}
```

A single `@@unique([type, keyId])` breaks the second session silently.

### 3.2 `keys` is not a plain object

The auth `keys` field is upstream's `SignalKeyStore` — `get(type, ids)` and
`set(data)`, not a blob. Two contracts must be reproduced exactly or the Signal
ratchet desynchronises:

- `get` returns an entry for **every** requested id, `null` for missing ones.
- `set` **deletes** on a falsy value rather than storing it.

### 3.3 Credentials contain `Uint8Array`

Signal keys are 32 raw bytes. Plain `JSON.stringify` turns one into
`{"0":1,"1":3,…}`. Any JSON-path store must use Baileys' `BufferJSON`
replacer/reviver or it will corrupt every key on first write.

**Implemented here** in `src/adapters/`, with the corruption round-tripped
explicitly in tests.

---

## 4. Rate limiting and pacing

### 4.1 Jitter

Box–Muller transform clamped to roughly ±3σ, rather than `random(0, max)`.
Uniform jitter clusters at zero — half the samples land in the first tenth of
the window — which is exactly the burst the technique is meant to remove.

### 4.2 The part that is evasion

The same forks that implement good jitter also implement **synthetic presence**:
timers emitting typing indicators and receipts while idle. Good pacing code sits
directly beside it. The split has to be made by intent.

### 4.3 Bursts vs ceilings

A pause on every *n*-th message is **more** detectable than no pause, not less —
it imposes a fixed period, and a period is a clean fingerprint. Smooth
per-message jitter plus a sliding-window ceiling defeats burst shaping better
than a metronome does.

**Implemented here** in `src/plugins/antiSpam.ts`.

---

## 5. Connection and clock management

### 5.1 Clock skew via rolling median

Server-time offset is estimated from a rolling window, using the **median**
rather than the mean. One wildly skewed sample drags a mean far enough to
mis-order message timestamps; the median ignores it.

### 5.2 Per-layer circuit breakers

Auth state has layers (session, pre-keys, transport). Independent breakers per
layer mean a pre-key failure does not tear down a healthy session, and recovery
is staggered instead of simultaneous.

### 5.3 408 recovery with refusal to half-recover

On a 408 the app may have sent messages the server never saw. Correct recovery
re-emits the gap. The important discipline: **refuse partial recovery** rather
than resuming mid-stream, because a resumed stream with unknown state produces
silent duplication that is very hard to diagnose later.

**Implemented here** in `src/plugins/reconnect.ts`.

---

## 6. Stanza construction

ACK/NACK construction as a **pure function** of (message, tag, error) rather
than inline at the call site. Same shape for protocol messages generally. Pure
construction is trivially testable; inline construction is not.

---

## 7. Browser-extraction tooling

Different category entirely — these target the **web client bundle**, not the
Node library:

- **Lazy module resolution** against a split resource-bundle graph, so a renamed
  internal chunk degrades to `undefined` instead of throwing at import time.
- **Registry injection with graceful fallback** for the same reason.
- **WeakMap wrappers preserving object identity**, so instrumentation is
  observable to code that compares references.

The general lesson, which does apply here: **every internal name is a
compatibility surface, and every one of them can move without notice.** The
three most expensive bugs in this codebase were all a field that moved.

---

## 8. Findings that reduced to "does not matter"

Recorded because the absence of a finding is worth stating:

- **One fork marketed as socket/UA/TLS hardening changes neither.** Transport is
  stock and there is no TLS customisation anywhere in the tree. Its custom client
  opens a port with no TLS layer at all.
- **One fork's advertised registration path references constants that do not
  exist in its own source** — a non-functional code path carried forward
  unchanged from upstream.
- **An explicitly-named "anti-spam" package is a dead link.** It has been absent
  for years and the ecosystem moved on. Any brief citing it as a dependency is
  citing a repository that cannot be cloned.
- **Apparent fingerprint-injection code in several forks is in fact extracted
  constants from the WhatsApp Web client** — legitimate fingerprint values
  lifted for compatibility, not spoofing logic. Reading the file matters;
  grepping the identifier gives the wrong answer.
- **A "typing indicator" in two forks emits exactly one indicator before a
  reply that genuinely sends.** That is honest UI feedback and was deliberately
  not counted as evasion.

The last two are the reason this document describes mechanisms rather than
drawing conclusions from filenames.

---

## Summary

| Category | Count | Disposition |
|---|---|---|
| Portable techniques | ~40 | Implemented where it earns its place; the rest documented for the reader |
| Evasion techniques | ~15 | Not implemented — see `DESIGN-NOTES.md` |
| Dead / non-functional repos | 4 | Noted, not actionable |

The portable half is ordinary, good engineering: correct protocol paths,
bounded caches, composite tenant keys, median-based clock skew, refusing partial
recovery. None of it is exotic. The value was in knowing *which* paths are
correct, and that knowledge is now in this repository's source rather than in a
dependency on someone else's checkout.

---

## 9. Ports from the local `refs/` checkouts

The twelve checkouts under `refs/` were re-surveyed for capabilities that are
portable, and the ones worth keeping were ported into this repository as
first-class, tested modules. The rest were left where they are, for the reasons
below.

### Ported

| Capability | Source shape | Landed as |
|---|---|---|
| Rolling-median clock sync | a `ClockSync` class measuring skew against the RTT midpoint | `core/clock.ts`, `plugins/clock-sync.ts` — re-evaluated median, exposed as `sock.clock` |
| Delivery-rate tracking | a tracker counting `messages.update` status 3/4 against sends | `core/delivery.ts`, `plugins/delivery.ts` — `sock.delivery.stats()` |
| Retry reason decoding | a Signal/WhatsApp retry-reason enum with descriptions | `core/retry.ts` — plus `isRetryable`, which the source lacked |
| Typed error taxonomy | `SessionNotFoundError` / `NotConnectedError` / `QueueFullError` | `core/errors.ts` — now raised by anti-spam and available everywhere |
| JID canonicalisation | a canonicalizer plus a stable thread key | `core/jid.ts` — pure string helpers, no resolver state |

The distinguishing test for "portable" was whether the technique improves
correctness or observability *of the user's own client*. Clock skew, delivery
rate, retry decoding, typed errors and JID canonicalisation all pass: they make
the client honest about its own state.

### Surveyed, not ported

These are the modules whose purpose is to **look less automated to WhatsApp**,
not to work better. They are the category [`DESIGN-NOTES.md`](./DESIGN-NOTES.md)
already refuses, and the re-survey did not change that judgement:

- **human-like activity generators** — scheduled typing, delayed receipts and
  presence cycles while idle (`humanEntropy`, `presenceChoreographer`)
- **deliberate imperfection injection** — typo-then-correct, mid-typing pauses
  (`legitimacySignalInjector`, `contentVariator`)
- **device / session fingerprint spoofing** — `deviceFingerprint`,
  `sessionFingerprint`, egress `proxyRotator`
- **receipt timing shaping** — `readReceiptVariance`
- **reply-ratio and reputation gaming** — `replyRatio`, `reputationVoucher`

Some of those files sit beside genuinely good engineering — a queue, a breaker,
a canonicalizer. The split is by intent, exactly as §"Why the split matters"
says: port the queue, decline the performance.

### Already covered

Most of what the forks advertise is already in this framework and needed no
port: anti-spam jitter and burst ceilings (`antiSpam.ts`), exponential backoff
with full jitter (`reconnect.ts`), SQL/NoSQL session stores with composite
tenant keys (`adapters/`), one-process-N-accounts (`multi/`), native-flow
forms and carousels (`nodes.ts`), album assembly (`album.ts`), newsletters
(`newsletter.ts`), polls (`poll.ts`) and LID routing (`lid.ts`).
