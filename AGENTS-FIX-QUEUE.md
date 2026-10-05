# Stale-code fix queue

Ground truth from live testing on 2026-10-05, account `6283831459585`
(consumer WhatsApp, device `10DDCU0FYA001NS`, session `6283831459585:12`).

Read this before trusting any comment, docstring or test name in the
repository. Several of them were written from an incorrect mental model of
rc14 and are still in the tree. Each item below is a *measured* falsehood.

---

## 1. `docs/VERIFICATION.md` — three claims that are now false

### 1a. Line 64, role 7 "Webflow form input parser — MISSING"

Says `src/plugins/flow.ts:80-109` "Never reads
`interactiveResponseMessage.nativeFlowResponseMessage` (D2). A native-flow form
submit extracts to `""` — verified."

**False.** `flow.ts:141-143` reads it today:

```ts
const native = (m?.interactiveResponseMessage as
  | { nativeFlowResponseMessage?: { paramsJson?: string | null } | null }
  | undefined)?.nativeFlowResponseMessage;
const flowReply = parseFlowResponse(native?.paramsJson);
```

The D2 finding was real *at the time it was written* and was fixed. The
verification record was never updated, so it now reports a fixed bug as open.
Line 79 (`6 COVERED · 8 PARTIAL · 1 MISSING`) and line 144 ("Role 7 is
MISSING") inherit the error.

Fix: mark role 7 COVERED, point at `flow.ts:141`, restate the totals, and
correct line 144.

### 1b. Lines 470-493, §5.6 `editedMessage` — wrong, and now inverted

Claims the correct shape is:

```
{ editedMessage: { message: { conversation: text } } }
```

and calls a bare `{ editedMessage: { text } }` broken.

**Both are wrong.** Measured on rc14, encoding the same text both ways:

```
{ text, edit: key }        71 bytes  protocolMessage type=14 (MESSAGE_EDIT),
                                     parentMessageKey present, text intact
editedMessage wrapper      15 bytes  no protocolMessage, no key, no type
```

The 15-byte form — which the doc recommends — carries no text *and* names
nothing to edit. `Utils/messages.js:514` assembles the real thing when it sees
an `edit` key. `createEdit` was fixed in `0ece183` to return
`{ text, edit: targetKey }`.

Note the trap: `FutureProofMessage` is a genuine protobuf type, so hand-building
it compiles without complaint and *looks* right. It is the wrapper for
`viewOnce` and ephemeral framing, not for outbound edits.

Also stale: line 601 maps the test
`createEdit actually carries the text onto the wire` to §5.6. That test was
replaced by three regression tests; the name no longer exists.

### 1c. Line 443, "non-issue" entry for edits

Repeats the same incorrect conclusion as 1b. Needs the same correction.

---

## 2. `docs/ARCHITECTURE.md` — adapter tree and edit shape

- **Lines 528-532**: document `adapters/session-{sqlite,mongo,prisma,redis}.ts`.
  All four were deleted in `0ece183` (1,472 lines). The directory is gone.
- **Line 510**: "file/memory/adapter factories" — drop "adapter".
- **Lines 553, 560-564**: reason about `./adapters/*` export specifiers and cite
  `src/adapters/index.ts:11-13`. That file no longer exists. `package.json` no
  longer exports `./adapters` or `./adapters/*`; the surface is 22 targets.
- **Lines 470-493**: same §5.6 edit error as 1b.

---

## 3. `docs/FEATURES.md` — nine "adapters" features that no longer exist

Line 16 lists `adapters` as a subsystem. **Line 382** opens a section titled
`## adapters (9)`; rows 164-172 (`docs/FEATURES.md:386-394`) each cite a line
number inside a deleted file:

```
| 164 | Driver-free by construction | `adapters` | … `adapters/index.ts:16-19` |
| 165 | `SqliteSessionStore`           | `adapters` | … `adapters/session-sqlite.ts:239` |
| 166 | Atomic write + fsync           | `adapters` | … `adapters/session-sqlite.ts:20-32` |
| 167 | `MongoSessionStore`            | `adapters` | … `adapters/session-mongo.ts:16-30` |
| 168 | Native BSON values             | `adapters` | … `adapters/session-mongo.ts:26-28` |
| 169 | `PrismaSessionStore`           | `adapters` | … `adapters/session-prisma.ts:9-11` |
| 170 | `BufferJSON` round-trip        | `adapters` | … `adapters/session-prisma.ts:29-33` |
| 171 | `RedisSessionStore`            | `adapters` | … `adapters/session-redis.ts:13-17` |
| 172 | Epoch-prefix invalidation      | `adapters` | … `adapters/session-redis.ts:19-30` |
```

Delete the section and renumber. Renumbering is why this was left for a
human decision — the table runs to 190+ and every downstream cross-reference
moves. **Ask before renumbering.**

Lines 431, 438 and 582-583 also discuss the adapter export surface and need
rechecking. Line 478's "Five control names" claim needs the interactive status
below.

---

## 4. `docs/HOW-IT-WORKS.md` — three rows that now mislead

- **Line 162**: `| **listMessage** | **throws Invalid media type** |`
  Still true of *rc14's own send path*, but the plugin intercepts first, so a
  user following this doc will conclude the feature is unavailable.
- **Line 177**: a results table where `listMessage` renders `no`. Correct, but
  for the wrong reason — it is not a payload problem.
- **Line 246**: `| listMessage | renders | renders |` — **wrong**, and the
  most misleading line in the repo. It says sectioned lists render on both
  platforms. They do not, on any consumer account.

Correct cause for all three: `single_select` is a server-side Business-tier
gate. See §6.

---

## 5. `docs/VERIFICATION.md` line 64 and `docs/FEATURES.md:478` — the interactive whitelist

Feature 201 claims five control names are available:
`quick_reply`, `cta_copy`, `cta_url`, `cta_call`, `single_select`.

**Measured, 1:1 consumer account, same recipient, same session, minutes apart:**

| flow name | outcome |
|---|---|
| `quick_reply` | **renders**, buttons tappable, reply routes back |
| `single_select` | valid ID returned, **never arrives** |

`cta_url` and `cta_copy` are whitelisted by server policy but were **not
tested** here — do not promote them to "verified" without doing so.

So: 1 of 5 confirmed, 2 reported-but-untested, 1 (`single_select`) confirmed
dead, `cta_call` unknown. `src/plugins/interactive.ts` already documents this
honestly; the docs do not.

---

## 6. `docs/VERIFICATION.md` — what was actually ruled out

Worth preserving so nobody re-chases these. Each was sent, returned a clean
message ID, and never arrived:

1. **Malformed payloads.** `ListMessage.buttonText` is required.
   `IButton.buttonText` is a nested message (`{ displayText }`), not a string.
   Both were wrong in the first attempt; fixing them changed nothing. A
   protobuf round-trip now confirms both survive encoding.
2. **Missing reporting token.** `generateWAMessageContent` attaches
   `messageContextInfo.messageSecret` to every message. This path bypasses it.
   A random 32-byte secret changed nothing. Kept anyway — the server expects
   the field.
3. **Message-vs-wrapper shapes.** All variants tested: bare `listMessage`,
   `viewOnceMessage`-wrapped, with and without `messageContextInfo`.
4. **Ordering.** Moving the plugin 118 → 66 changed nothing about delivery.

**The actual fix**, and the only thing that worked:

```
biz
└─ interactive  type=native_flow v=1
   └─ native_flow  name=quick_reply
bot  biz_bot=1        ← 1:1 chats only
```

passed as `relayMessage`'s `additionalNodes` (`Socket/messages-send.js:1133`).

The `native_flow` name must match the flow actually sent. `single_select` is
accepted by the encoder and stripped by the server.

---

## 7. `src/plugins/interactive.ts` — honest now, keep it that way

Fixed in `0ece183`. Worth reading as the reference implementation: it
documents the phantom-delivery failure mode, the ruled-out causes, and states
plainly that only `quick_reply` is verified.

**Do not restore the old header.** It claimed *"Verified against a physical
phone, not inferred from logs"* for all four interactive types, which was
false — that sentence is what sent this whole search down a dead end.

---

## 8. Still unverified — do not assume

- `cta_url`, `cta_copy`, `cta_call` on consumer accounts
- `single_select` in a **group** (only ever tested 1:1)
- `templateMessage`, `carouselMessage`, `collectionMessage`,
  `productMessage`, `contactMessage` — all unrendered
- `createFormFlow` / `createTableFlow` / `createCarouselFlow` — build
  correctly, never confirmed rendering on any tier

---

## 9. Breaking change in `0ece183`

`createEdit` signature changed:

```ts
// before — silently produced a 15-byte no-op
createEdit(text: string): WebMessageInfo

// after
createEdit(targetKey: WAMessageKey, text: string): { text, edit }
```

Anything calling the old form now gets `undefined` as the key rather than a
compile error. Nothing in-repo calls it, but it is public surface and the
migration is not documented in `CHANGELOG.md`.
