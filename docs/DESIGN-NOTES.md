# DESIGN NOTES — five features that were requested and not built

Nyx-Baileys 0.1.0 · `@whiskeysockets/baileys@7.0.0-rc14` · Node ≥ 20

## Why this document exists

The project brief asked for five capabilities that this framework does not
implement. They are not missing because they ran out of time or because they
turned out to be hard. Four were refused because they exist to defeat WhatsApp's
abuse detection, and the fifth was refused because it cannot work.

Both reasons are refusals. They are not the same reason, and this document keeps
them apart on purpose — lumping "we will not do this" together with "this does
not work" would be a way of avoiding the harder question.

Four of the five are also recorded, mechanism by mechanism, in
`REF-FINDINGS.md` §E. That survey read twelve reference forks and classified
fifteen techniques found in them as EVASION. This framework implements none of
them, for the same reasons and with the same reasoning.

One structural point first, because it governs all five: **a Node WebSocket
client has no browser.** There is no canvas, no `AudioContext`, no
`navigator.plugins`, no DOM. Any brief that describes fingerprint
desynchronisation in those terms is describing a browser automation stack, not
this one. Where that matters, it is called out below rather than quietly
translated into something easier to build.

---

## 1. Dynamic frame padding in the Noise handshake

**Requested.** Vary the size and timing of frames during the Noise handshake so
that traffic-volume analysis — the kind behavioural ML classifiers run against
the byte stream — cannot infer how much data is moving or when.

**Not built.**

**Why.** This has exactly one purpose: to make automated abuse harder to detect.
There is no functional reading. Padding a handshake does not improve reliability,
does not fix a protocol bug, and does not make the transport faster or safer. It
is anti-detection engineering aimed at a platform's abuse-detection systems, and
it violates WhatsApp's Terms of Service. A user who installs this framework is
not asking to be harder to detect by the operator; they are asking for a
library that works.

`REF-FINDINGS.md` classifies the closest relatives of this in the reference set
as EVASION for the same reason — E4 (per-session timing-fingerprint profiles,
`baileys-antiban/src/sessionFingerprint.ts:43-66`), whose stated purpose is to
ensure no two bot instances share a timing signature so they cannot be clustered.

**What exists instead.** None, deliberately. The transport is left alone. The
socket's WebSocket tuning (`src/core/socket.ts:32-38`) sets `connectTimeoutMs`,
`keepAliveIntervalMs`, `maxPayload` and TLS verification — operational limits,
not camouflage. Nothing in `src/` pads, delays, or reshapes a frame for
fingerprinting purposes.

---

## 2. Browser fingerprint desynchronisation

**Requested.** Randomise canvas hashes, `AudioContext` sample frequencies and
`navigator.plugins` counts on each connection so fingerprint matchers cannot
correlate sessions.

**Not built.**

**Why, in two parts.**

The first part is mechanical: those three APIs do not exist in Node. There is no
canvas to hash, no audio context to sample, no plugin array to count. A Node
Baileys socket has exactly one identity surface on the wire — the
`clientPayload`, which carries the browser tuple (`browser: [engine, version,
patch]`) plus `appVersion`, `deviceModel` and the platform. Randomising *that* is
the real version of this request, and it is `REF-FINDINGS.md` E3
(`baileys-antiban/src/deviceFingerprint.ts:1-10`), which randomises
`appVersion` patch, `osVersion` build and `deviceModel` from a pool to break
`clientPayload` fingerprinting. E3's own file describes this as closing "the #1
gap in anti-ban coverage", which is an accurate description of what it is.

The second part is the reason it is refused. The purpose of desynchronising a
fingerprint is to defeat attribution — to make an abusive operator impossible to
trace to a specific account, device or payment trail. E3 is impersonating other
people's hardware. That is the harm, and it is not a stylistic objection.

**What was built instead — one consistent identity, pinned per socket.**

- `src/core/socket.ts:14-18` — a single default fingerprint,
  `['Chrome', '120', '0']`, chosen as a real, internally consistent
  Chrome-on-Windows combination.
- `src/core/socket.ts:117-123` — `desktopUserAgent()` derives the UA string from
  that same tuple, so the two can never disagree.
- `src/plugins/stealth.ts:37-41` — the fingerprint is exposed once, as
  `sock.__identity`, and the comment is explicit about why: *"Consistency is the
  entire product here."*
- `src/core/socket.ts:6-13` — the design note states the rule in the file that
  enforces it: churning the tuple per connection is what looks anomalous, because
  one browser does not change OS mid-session.
- `src/plugins/stealth.ts:8-11` — the module docstring records the deliberate
  omission: it does not rotate the fingerprint per connection.

`stealth` is named for the absence of the thing that was asked for. It pins an
identity rather than scattering one.

---

## 3. Automated ephemeral activity emulation

**Requested.** Background routines that emit read receipts, typing indicators and
metadata queries during dormant hours, so the account carries a plausible
signature of continuous human activity.

**Not built.**

**Why.** Two independent reasons, and both apply.

**It violates the Terms of Service.** This is the same category as §1: its
purpose is to keep a non-human account looking human to the platform's classifier.
`REF-FINDINGS.md` documents four separate instances of it in one reference repo,
each with its own mechanism:

| Ref | Mechanism | File |
|---|---|---|
| E1 | Typing indicators to up to 30 idle contacts on a 2–6h cycle, 30% probability, no message ever sent | `humanEntropy.ts:1-9`, `:293-300` |
| E2 | Circadian activity curves plus 5–20min "phone put down" pauses | `presenceChoreographer.ts:1-13` |
| E7 | Read receipts replaced with Gaussian 3–45s delays and a 15% skip rate | `readReceiptVariance.ts:1-10`, `:88` |
| E11 | Suggests auto-replies to raise a fabricated inbound/outbound engagement ratio | `replyRatio.ts:1-10` |

**It deceives the people on the other end.** This is the reason the other four
exclusions are purely policy questions and this one is not. E1 puts "typing…" on
a real person's phone, from a human who is not typing. The recipient cannot tell
the difference between the bot and a friend standing by, and the whole point of
the typing indicator is that they can. E7 lies about when a message was read.

That is the part the marketing never mentions, and it is the part that decides
it. Every other exclusion in this document is a choice about how a platform
should be treated. This one is a choice about what it is acceptable to show a
person who is not part of the project.

**What was built instead — presence that reflects reality.**

- `src/plugins/stealth.ts:45-56` — presence is driven by `connection.update`.
  `available` on `open`, `unavailable` on `close`. Nothing else emits presence,
  ever. The comment at `:43-44` says it: *"Presence tracks real state … No fake
  'warmth' traffic."*
- `src/plugins/stealth.ts:11-14` — the omission is recorded in the module
  docstring rather than left as an absence someone re-adds later.
- `src/core/socket.ts:88` — `markOnlineOnConnect: false`, so presence is set by
  the plugin from real connection state rather than by the socket announcing
  itself on connect.

**This line is held in code, not only in this document.**
Two opt-in plugins implement the legitimate half of this territory, and both
state the refusal in their own source comments rather than relying on a
document nobody reads at 2am:

- `src/plugins/presence.ts` — presence means *connected and actually busy* vs
  *connected but idle*, which is an honest mapping of socket state and is also
  what the web client does. Its docstring (`:9-27`) states: *"A chat that shows
  `composing…` for a bot that is not composing anything is a false statement to
  a real person, and repeating it on a timer turns a small lie into a habit."*
  It enumerates the only three things permitted to cause a presence — a real
  connection change, real message traffic inside a short window, or an explicit
  operator call — and notes that `composing`/`recording` are manual per-chat
  overrides only, because only the operator knows when the bot is really
  composing. There is no `setInterval` whose job is to make the account look
  busy.
- `src/plugins/read-receipts.ts` — a receipt is a statement that a message was
  displayed, so only a message this socket genuinely received may produce one.
  Its docstring (`:8-26`) rules out both idle-timer receipts and "mark the whole
  chat read on a schedule", on the grounds that the latter *is* a lie: the
  account claims to have read messages that may never have arrived, and the
  sender's blue ticks stop carrying information. Its `delayMs` is a per-message
  timer that fires once for a real key and then dies — a delay, not a generator.
  That is precisely the E7/E9 distinction, applied at the point of
  implementation.

Neither plugin is in the default chain; both are opt-in via
`registerPlugin()`. Neither adds synthetic traffic.

**A boundary case, recorded because it is easy to get wrong.**
`REF-FINDINGS.md` E16 classifies "one `composing` indicator immediately before a
reply the bot genuinely sends" as **not** evasion, on the reasoning that an
indicator which resolves into a real message is honest UI. That reasoning is
sound and this document agrees with it. `presence.ts` implements exactly that and
no more: its `composing` is a manual per-chat override, never automatic. If you
add an automatic indicator before a real outbound message, you are inside E16
and outside this objection. If you add one with no message behind it, you are
inside E1 and outside it.

---

## 4. Bypassing text sanitisation

**Requested.** Inject markdown and tracking tags into interactive nodes so that
content survives — and is reported back by — the client's own sanitisation.

**Not built.**

**Why.** Sanitisation here is a control the WhatsApp client applies to what it
renders. Injecting content past it is forging message content: producing a
message node that does not correspond to what the sender's library asked for,
and that the recipient's client displays as though it did. The two concrete
mechanisms in the reference set are both in this category and both are documented
as harmful for reasons beyond detection:

- **E5**, zero-width codepoint injection between words
  (`contentVariator.ts:1-6`, `:11-13`). The purpose is byte-level
  de-duplication failure against a spam classifier. The human sees clean text;
  the text they select, copy or search for no longer matches. `REF-FINDINGS.md`
  notes it is a cross-tenant and accessibility hazard as well as a ToS breach.
- **E6**, synthetic typos followed by synthetic corrections
  (`legitimacySignalInjector.ts:1-14`, `:20-26`). The user receives two
  messages, one of which is a fabricated error, purely so the account looks
  fallible. It degrades the conversation to make the account look human.

There is a further practical point specific to `interactiveNode`. The native-flow
payload on rc14 is an opaque JSON string — `messageParamsJson`
(`src/core/nodes.ts:90-101`). The rich section/row schema is not in the protobuf
at all; the client parses that string and renders it. Anything written into it is
outside every schema the framework can validate against, which is precisely why
"just inject a tracking tag here" has no defensible form.

**What was built instead — structural repair, which is a different operation.**

`src/plugins/session-repair.ts` does touch interactive nodes on the way out. It is
worth being precise about why that is not the same thing:

- **Hoisting** (`:55-71`) moves an interactive node out of a wrapper
  (`viewOnceMessage`, `documentWithCaptionMessage`, `editedMessage`,
  `ephemeralMessage`, `viewOnceMessageV2`, `viewOnceMessageV2Extension`) and
  deletes the wrapper. The client ignores an interactive node nested inside one of
  those, so the payload the caller built would otherwise never render. This
  restores intent; it does not add content.
- **`optionName` backfill** (`:81-114`) gives every row in a native flow a
  selectable identifier, parsed out of `messageParamsJson` and re-serialised. A
  row without one cannot be bound by the client, so it silently degrades to a
  text bubble. This completes a field the schema requires and the sender omitted.

Both are fixes, not bypasses, and the module says so at `:20-22`: *"Both are
fixes, not bypasses: the message still goes through Baileys' own protobuf
compilation and WhatsApp's own validation."* The repair runs on the way
**outbound**, before Baileys compiles anything; it never alters what the
recipient receives beyond making the sender's own message match the sender's own
intent. A malformed `messageParamsJson` is left untouched rather than rewritten
(`:88-91`) — corrupting the payload would be worse than the missing field.

---

## 5. Cryptographic token hot-swapping

**Requested.** Hold a redundant pool of credentials and rebuild from it under a
live socket, without closing the WebSocket.

**Not built.**

**Why — and this one is not a policy objection.**

**It cannot work.** WhatsApp multi-device runs a Signal ratchet per linked device.
The socket's identity is a live ratchet position: the Signal keys, the
pre-key bundle and the signed identity key are not interchangeable credentials,
they are a position in a chain of agreement. Overwriting them mid-connection
does not "swap a token" — it forks the chain. The server is holding one
pre-key-derived session; the client would be holding another. There is no message
that resolves this, because there is no message in which both sides agree to
abandon the old position. The old socket's in-flight messages encrypt against
keys the new ones no longer share, so every message already queued is
unrecoverable.

The failure mode on the far side of a successful-looking swap is worse than an
error: a `Bad MAC` / `No Session` storm, which `REF-FINDINGS.md` §4.1 records as
the well-known symptom of exactly this class of mistake (Baileys issues #1769,
#2491). `session-repair.ts`'s sibling concern is the same shape from the other
direction.

**And corrupted credentials are unrecoverable by definition.** When the key store
does not parse, the honest response is to report that re-pairing is required.
Inventing a recovery path that silently desyncs the ratchet converts a loud,
correct "please scan a QR code" into a quiet, permanent inability to send.

**The codebase already encodes this.** The decision is written into the two files
that would otherwise implement it:

- `src/plugins/reconnect.ts:17-19` — *"It will not hot-swap Signal session keys
  under a live socket. Credentials that fail to parse are unrecoverable by design,
  and the honest response is to report that a re-pair is needed rather than to
  invent a recovery that desyncs the ratchet."*
- `src/multi/session-manager.ts:31-33` — *"Rebuilding is a cold start against the
  auth store, never an in-memory key transplant: transplanting Signal keys under
  a live socket desyncs the ratchet."*

**What was built instead — rebuild from persisted state, one socket at a time.**

- `src/nyxBaileys.ts:136-161` — `#rebuild()` unwinds every patch, disposes the
  socket and calls `#connect()` again against the same session store. State is
  never rebuilt from memory; the auth store is the source of truth, so a
  reconnect is the same code path as a cold start.
- `src/nyxBaileys.ts:115-121` — the reconnect plugin asks the host to rebuild
  rather than swapping the socket itself, so there is exactly one owner of the
  connect path.
- `src/multi/session-manager.ts` — a session that cannot reach `open` is torn
  down and rebuilt on a bounded backoff, one session at a time. Blast radius is
  contained: 40 of 50 accounts delivering in a broadcast is a partial success
  report, not a failure.
- `src/plugins/reconnect.ts:123-130` — `DisconnectReason.loggedOut` explicitly
  stops the retry loop rather than looping forever. A server-side unpair needs a
  human with a phone, and a retry loop makes that look like a network problem.

---

## What the five refusals have in common

Nothing, and that is the point worth making.

| # | Request | Refused because |
|---|---|---|
| 1 | Noise frame padding | Policy — anti-detection |
| 2 | Fingerprint desync | Policy — anti-detection, defeats attribution |
| 3 | Ephemeral activity emulation | Policy — anti-detection **and** deceives the recipient |
| 4 | Sanitisation bypass | Policy — forges message content |
| 5 | Credential hot-swap | **Impossible** — desynchronises the Signal ratchet |

Four are refusals to participate in abuse evasion. One is a correction of a
technical misconception. Only the first four belong in the same conversation as
`REF-FINDINGS.md` §E; §5 belongs with the ratchet.

Grouping them would misrepresent all five. §1–§4 could be reimplemented by
choosing differently, and the objection would still stand. §5 cannot be
reimplemented at all, and no amount of choosing differently changes that.

## What the framework does instead, in one place

| Requested | Built | Where |
|---|---|---|
| Randomised fingerprint | One consistent desktop identity, pinned per socket, UA derived from the same tuple | `core/socket.ts:14-18`, `:117-123`; `plugins/stealth.ts:37-41` |
| Synthetic presence traffic | Presence driven by real `connection.update` state, nothing else; an opt-in `presence` plugin that refuses idle timers in its own source | `plugins/stealth.ts:45-56`; `plugins/presence.ts:9-27` |
| Fake account warmth | Outbound pacing: Box–Muller gaps, serial drain, per-minute ceiling, queue cap | `plugins/antiSpam.ts:46-52`, `:66-87`, `:55-64`, `:97-99` |
| Fake account history | A real warm-up ramp, persisted so it survives restart, 8× → 1× over N days | `plugins/warmup.ts:17-24`, `:34-40`, `:48-51` |
| Fake read receipts | Receipts only for messages genuinely received; an opt-in `read-receipts` plugin that refuses schedule-based bulk reads | `plugins/read-receipts.ts:8-26` |
| Content injection | Structural repair of the sender's own payload, before Baileys compiles it | `plugins/session-repair.ts:55-71`, `:81-114` |
| Live credential swap | Cold rebuild from persisted state, with disposals unwound first | `nyxBaileys.ts:136-161`; `multi/session-manager.ts` |

The recurring substitution is: **do the real version of the legitimate need.**
The legitimate need behind most of these is "do not get rate-limited, do not
look automated, do not lose my session." Every row above addresses one of those
directly. None of them addresses it by making the software harder to identify as
software.

### On `antiSpam` specifically, because the name invites the question

`antiSpam` is a **throughput governor**. It paces messages a caller actually
asked to send, and it never invents traffic. The scope is stated in the source at
`src/plugins/antiSpam.ts:14`: *"Scope: outbound pacing. It does not fabricate
presence."* `warmup` feeds it a multiplier through
`__antispam.setPressure` (`warmup.ts:48-51`), which lengthens the gaps a real
outbound queue already applies.

A queue that spaces real work out is ordinary backpressure. A system that
generates work nobody asked for, to make the account look occupied, is not the
same thing and is not built here. `FEATURES.md` marks these Tier 1 with the same
distinction in mind.

## Boundary

This framework is a WhatsApp client library. Its users are people automating
their own accounts and applications, and most of what it does — pacing, queueing,
reconnecting, repairing malformed payloads, keeping a session alive — is ordinary
production engineering.

What is refused here is a specific set of five capabilities whose only function is
to make automated use harder for the platform to identify or measure. The line is
drawn at purpose, not at mechanism: a rate limiter and a typing-indicator
suppressor use similar code, and only one of them is in this repository.
