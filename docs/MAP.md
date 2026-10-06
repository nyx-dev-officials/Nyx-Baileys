# Nyx-Baileys — folder map and how the interactive menu works

Read this when you want to know **where something lives** and **why the menu
needed those specific files**. Every claim here has been verified against this
tree; where something is unverified it says so.

---

## 1. The folder map

```
src/
├── index.ts              503  public surface — re-exports everything below
├── lite.ts                   smaller surface: core + plugins, no multi/security/cli
├── nyxBaileys.ts        343  the NyxBaileys class — lifecycle, rebuild, dispose
│
├── core/                17 files — the engine, zero dependencies on plugins
│   ├── socket.ts        169  makeWASocket() called ONCE, credentials persisted
│   ├── intercept.ts     220  patch() — the one primitive every plugin is built on
│   ├── nodes.ts             protobuf builders: flows, album, edit
│   ├── media.ts             rc14 media traversal, the two-hop contextInfo rule
│   ├── album.ts             album parent + sibling assembly
│   ├── jid.ts               phone number → JID, LID resolution
│   ├── session-store.ts     SessionStore interface + file/memory implementations
│   ├── store.ts             in-memory history/media/statuses
│   ├── tasks.ts             scheduler
│   ├── clock.ts             server clock estimate
│   ├── conversation.ts      per-chat state with TTL
│   ├── delivery.ts          delivery tracking
│   ├── errors.ts            typed errors
│   ├── mention.ts           @mentions
│   ├── re-pair.ts           pair / relogin helpers
│   ├── retry.ts             media retry
│   └── revoked-store.ts     remembers deleted messages
│
├── plugins/             32 files — each a { name, order, apply }
│   ├── interactive.ts   479  the interactive dispatcher (order 66)
│   ├── chat-ops.ts           group + chat admin (order 66)
│   ├── session-repair.ts     normalises inbound payloads (order 65)
│   ├── antiSpam.ts           pacing queue (order 80)
│   ├── album.ts              incoming albums (order 40)
│   ├── flow.ts               multi-step conversational state machine (order 90)
│   ├── moderation.ts         mass-add and privilege-climb policy (order 145)
│   └── …26 more              see docs/FEATURES.md for all 30+
│
├── toolkit/              3 files — operational helpers, NOT plugins
│   ├── index.ts               barrel
│   ├── ops.ts                 20 everyday + diagnostic functions
│   └── category-menu.ts  204  sendCategoryMenu() + readMenuSelection()
│
├── security/             7 files — validation, redaction, ACL, audit
├── antiban/              7 files — pacing realism, fingerprint, circadian
├── integrations/         5 files — HTTP client, webhooks bridge
├── multi/                2 files — SessionManager, N accounts in one process
├── bot/                  2 files — high-level bot helpers
├── cli/                  5 files — zero-dependency arg parsing and output
└── utils/               11 files — types, logger, queue, cache, compose
```

**The one distinction that matters:** `plugins/` decorates the socket and is part
of the framework's contract. `toolkit/` is plain functions you call yourself —
nothing is installed, nothing is patched. A helper belongs in `toolkit/` unless it
needs to intercept.

---

## 2. How the category menu actually gets delivered

Five files, in order. This is the path a menu takes from a function call to a
sheet on a phone.

### 2.1 `src/toolkit/category-menu.ts` — you call this

```ts
import { sendCategoryMenu, readMenuSelection } from 'nyx-baileys/toolkit';

await sendCategoryMenu(sock, jid, [
  { title: 'Media',      rows: [{ id: 'photo', title: 'Photo' }] },
  { title: 'Interactive', rows: [{ id: 'url',  title: 'Open a link' }] },
], { buttonTitle: 'Menu' });
```

It builds an `InteractiveMessage` with a `nativeFlowMessage` button named
`single_select`, whose `buttonParamsJson` is a **JSON string**. The client parses
that string itself — it is opaque to protobuf.

### 2.2 The `viewOnceMessage` envelope — non-negotiable

rc14 only serialises interactive messages inside this wrapper. `sendMessage`
cannot reach the content type at all: `generateWAMessageContent` has no branch for
it and its final `else` calls `prepareWAMessageMedia`, which throws
`Boom: Invalid media type`.

### 2.3 `generateWAMessageFromContent` — keys and timestamp

Takes the **original** object (not the normalised one) and builds the
`WebMessageInfo`. The key and the message ID come from here.

### 2.4 The reporting secret — attached by hand

`generateWAMessageContent` attaches a 32-byte `messageContextInfo.messageSecret`
to every message it builds. That function is **bypassed** on this path, so the
secret is supplied directly on the outer message. Not what makes the menu render —
the payload shape is — but the server expects the field.

### 2.5 `relayMessage` — the only way out

```ts
await sock.relayMessage(jid, full.message, { messageId: full.key.id });
```

No `additionalNodes`. Those exist to make a **quick reply** render on consumer
clients; attaching them to a `single_select` would label the flow as
`quick_reply`.

---

## 3. Why it took as long as it did

The honest account, because the failure mode is worth remembering.

**`listMessage` was never the mechanism.** It is rejected outright by rc14, so the
`WAProto` schema for `ListMessage.Row` — which really does use `rowId` — tells you
nothing about what this menu needs. The client-side schema names the field **`id`**.

An earlier attempt used `rowId`. It encoded cleanly, returned a valid message ID,
and never arrived. That is the exact signature of a silent drop, which this project
had already learned to distrust. It was concluded from that evidence that
sectioned lists were **impossible on consumer accounts**, and that claim reached
`docs/VERIFICATION.md`, the changelog, and the 0.3.1 release notes.

It was wrong. The conclusion was overreach: "we have not made this render yet"
would have been the correct reading of a clean ID and no delivery.

### The rule this produced

**A returned message ID is not evidence of delivery.** Every silent drop in this
project has looked identical to a success. So:

- prove it on a phone, with a screenshot
- or check whether the code is even *reachable*

---

## 4. Reading a selection back

The client echoes the sender's own JSON, so the selected `id` comes back verbatim:

```ts
sock.ev.on('messages.upsert', ({ messages }) => {
  const picked = readMenuSelection(messages[0]?.message);
  if (picked) route(picked);   // 'photo' | 'url' | …
});
```

`readMenuSelection` returns `null` on malformed JSON — a decode failure should drop
one reply, not kill the handler.

---

## 5. What is verified and what is not

| | |
|---|---|
| `quick_reply`, `cta_url`, `cta_call`, `cta_copy` | **Verified on hardware.** Render and route back. |
| `single_select` | Menu renders. |
| Selection round-trip | **Not yet observed from a real phone.** The unit test proves what we send matches what we parse; that both agree with a real echo needs one live tap. |
| `single_select` in a group | **Untested** — only 1:1 has been exercised. |
| `templateMessage`, `carouselMessage`, `collectionMessage` | Untested. |

---

## 6. Things that look wrong but are not

- **`expiration` is dropped on the root `messageContextInfo`.** It must sit on the
  **per-type field's** `contextInfo`. On the root it encodes to an empty object
  with no error. Sub-24h expiry needs the raw stanza.
- **Passing `ephemeralExpiration` as an option crashes rc14** at
  `messages.js:597` — normalisation runs first, so the guard checks the wrong
  variable and assigns `contextInfo` onto a string.
- **`decryptMediaMessage` is not exported by rc14.** The tree has
  `downloadMediaMessage` and `decryptMediaRetryData`. That is a v6-era name.
- **`copy_to_clipboard` is not a flow name.** `cta_copy` is; the longer spelling
  encodes fine and is silently dropped.
- **`{ image: { buffer } }` throws on `undefined.url`.** rc14's `getStream` checks
  `Buffer.isBuffer(item)` first, then `'stream' in item`, then `item.url`. The
  buffer is the **value** of the media key.
- **`star` is a `chatModify`, not a `sendMessage` content key.** Sending it as
  message content does nothing at all.
- **A file that compiles, type-checks and is not in a barrel never runs.** Check
  reachability before assuming code is broken.