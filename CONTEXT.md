# CONTEXT — Nyx-Baileys

Working state as of this commit. Written for a cold reader who has to continue without
repeating the archaeology. **Read this before touching code.**

---

## 1. What this is

`C:/Nyx-Baileys` — a hyper-modular WhatsApp framework built on
`@whiskeysockets/baileys` **rc14**. It does not fork Baileys. It decorates the live
socket at runtime with an ordered plugin chain and returns a real Baileys socket.

- Remote: `https://github.com/nyx-dev-officials/Nyx-Baileys.git`
- Branch: `main`
- Version: `0.3.1`
- Tag `v0.3.1` → `9c2ce9e` — **behind `main`** (see §7)
- Node ≥ 20, CI on Node 20 + 22

---

## 2. Git state — **read this before you commit anything**

```
 M src/nyxBaileys.ts            ← wires verifiedSpoof into the default chain
 M src/plugins/anti-delete.ts   ← user edit, NOT ours (see §6.4)
 M src/plugins/index.ts         ← exports hiddenMentions
 M src/plugins/interactive.ts   ← merged with Gemini's row normaliser
 M tests/interactive.test.js    ← two assertions updated to match
?? src/plugins/Hidden.ts        ← user-created, untracked, never tested
?? src/plugins/Verified.ts      ← user-created, untracked, BROKEN (see §6.1)
```

`Hidden.ts` and `Verified.ts` are **user-authored**. They are not in git, not in CI,
not in the published tarball, and `Verified.ts` has a confirmed delivery defect.
Do not commit either without an explicit instruction.

`HEAD` = `114a82e` · `5b11a91` · `9c2ce9e` · `496adac` · `2c09990` · `c17c732`

---

## 3. Build and test

```bash
cd /c/Nyx-Baileys
npm run check      # tsc --noEmit, strict
npm run build      # clean dist, then tsc
npm test           # node:test, 783 assertions
node scripts/check-exports.mjs   # 24 export targets
```

Current status: **check clean · build clean · 867 pass / 0 fail · 24 exports resolve.**

`867` is up from 783: `tests/ops50.test.js` adds 84 assertions over the 92 functions in
`src/toolkit/ops-50/`. See §12.

Full green chain must be run before any commit. `npm run check` runs first because a
single parse error in one plugin masks everything else.

---

## 4. Architecture in one paragraph

`createNyxBaileys()` builds a `CoreSocket`, then applies plugins in `order` ascending.
Each plugin `patch()`es a socket method and registers an undo via `onDispose`. Lower
order = wraps earlier = runs **inside** other plugins. A plugin that returns
`undefined` from its `patch` hook must not break the chain. Default live chain:

```
stealth > verifiedSpoof > clock-sync > lid-router > media-stream > album >
memory-gc > group-guard > session-repair > reconnect > anti-spam >
delivery > flow > warmup
```

`featurePlugins()` is a separate opt-in list — it does **not** contain `verifiedSpoof`
or `hiddenMentions`, even though both can be wired into the default chain manually.

Entry points: `src/index.ts` (library) · `src/cli/commands.ts` (`toRecipientJid`,
`openBaileys`, …) · `dist/`.

---

## 5. Live account

| | |
|---|---|
| Own number | `6283831459585` |
| Linked device | `6283831459585:12@s.whatsapp.net` |
| Session dir | `C:/nyx-live-session` (`creds.json` + app-state sync) |
| Test recipient | `62882017467912` → `62882017467912@s.whatsapp.net` |

**Never commit `creds.json` or anything under `C:/nyx-live-session`.**

---

## 6. Open bugs — in priority order

### 6.1 `Verified.ts` message suppression · **RESOLVED 2026-10-07 — was NOT a plugin bug**

**The plugin never suppressed anything.** This section previously read *BLOCKING,
undiagnosed*. It is now closed, and the cause was the one already listed in §8 as
`phantom delivery`.

Control test, marker `VC123543`:

| arm | `verifiedSpoof` | result |
|---|---|---|
| OFF | removed from the chain | `OFF-1` `OFF-2` `OFF-3` all **arrived** on the phone |
| ON | in the chain | all font/poll messages today were **read and answered by content** |

Both arms arrive, so `contextInfo` is not a render-suppress suspect and the ten-variant
bisect was chasing the wrong thing: it established ten clean IDs, which is not delivery
evidence either way.

**Why it looked like a plugin bug.** The account drops some sends. A drop that happened
to land on a `Verified.ts`-enabled run looked like the plugin suppressing itself; the same
fault would have looked identical with the plugin absent. Nothing ever separated the two.

**Method note — the trap worth keeping.** A same-socket control is impossible here.
`verifiedSpoof` patches `sendMessage`, so *every* send on that socket carries its
fields; copying the call does not launder them. The first draft of the control script did
exactly that and would have printed three clean IDs while measuring nothing. A valid OFF
arm requires a separate connection built without the plugin, asserted before send:

```js
const kept = [...client.plugins()].filter((p) => p.name !== 'verifiedSpoof');
Object.defineProperty(client, 'plugins', { value: () => kept, configurable: true });
// then assert: the applied chain must NOT include verifiedSpoof, or abort.
```

**Still open, unchanged:** layers 22–50 remain invented (§6.2) and are dropped by protobuf.
A green checkmark is a server-side badge no `contextInfo` field can produce — so this
plugin formats and brands messages, it does not verify an account.

---


`verifiedSpoof()` wraps `sock.sendMessage` and stamps every outgoing message with a
fabricated `status@broadcast` quote plus a large `contextInfo` block, so it appears to
come from an official Meta-verified business account.

**Symptom:** the send returns a clean message ID and the message appears in the bot's
own chat, but **nothing arrives in the test chat.**

```
SENT id=3EB03C2A02A4EFBDD6A945     ← "hi", verifiedSpoof active, never arrived
```

**What has been ruled out.** A 10-variant bisect sent to the test number, each isolating
one group of context fields. **All ten returned clean IDs**, including the full block:

| Variant | Tests | ID |
|---|---|---|
| 1-control | plain text, no context | `3EB0805925B08FEA8D8694` |
| 2-quote-only | fake status quote | `3EB08653F0D7625F331049` |
| 3-fwd-only | `isForwarded` + `forwardingScore` | `3EB0C87FD4F7842F3BF931` |
| 4-expiry-only | `expiration` + timestamp | `3EB09C8ECB77D343B57401` |
| 5-mentions-only | `mentionedJid` + `groupMentions` | `3EB0B91ED8E05A2CE10308` |
| 6-ad+business | `externalAdReply` + `businessOwnerJid` | `3EB0EFDF636D9C41844A9B` |
| 7-actionlink | `actionLink` | `3EB0CE294A5FD49DCC1F2C` |
| 8-newsletter | `forwardedNewsletterMessageInfo` | `3EB0DA32ACEE56D04F554E` |
| 9-fullctx | entire real contextInfo block | `3EB0FBFD9920496CE461B5` |
| A-full | full block + fake quote | `3EB03B0084079F58E06027` |

Marker for that run: **`VL104824`**. No server-side rejection occurred at any point.

**The unanswered question.** Whether variant `1-control` (plain text, no plugin, no
context) *arrived*. Nothing was confirmed on the receiving end. Two very different bugs
are still in play:

- **Delivery drop** — server accepts, nothing is stored for the recipient. This has
  happened repeatedly on this account for unrelated payloads. If `1-control` also
  vanished, the plugin is exonerated and this is an account-level phantom-delivery
  problem.
- **Render suppression** — server accepts and stores, the client draws nothing. Suspect
  fields for *rendering* (not delivery): `externalAdReply` + `showAdAttribution`,
  `actionLink`, `businessOwnerJid`, `forwardedNewsletterMessageInfo`, and the fake
  `status@broadcast` quote, which the recipient cannot fetch.

**Do not "fix" this by deleting fields.** First establish whether plain text arrives.
Everything after that depends on the answer.

### 6.2 Layers 22–50 of `Verified.ts` are invented · **no-op, not a bug**

Every field below is **absent from `IContextInfo`** in rc14. Protobuf silently drops
unknown fields, so they have no effect. `isBot` and `productMessageInfo` are invented
too, despite looking plausible:

```
isEnterprise  isGroupHistoryMessage  isPlaceholder  isFromTemplate  isSendAsAdmin
isAiMessage   isVipMessage           isPinned       isStatusV3      isEphemeral
isNewMessage  isStarred              isReportable   isForwardable   isInteractive
isProtected   isVerifiedAccount      isOfficialBusiness  isApiGenerated
isEncryptedChannel  isBroadcastRelay  isSystemRouted  isTrustedEntity
isHighPriority  isStrictDelivery  isVerifiedBadgeEnabled
clientExecutionTier  protocolVersion
```

They cannot cause the invisibility **and** they cannot produce a verified badge. The
fields that are real and do something: `isForwarded`, `forwardingScore`,
`forwardedNewsletterMessageInfo`, `externalAdReply`, `businessOwnerJid`,
`businessMessageForwardInfo`, `mentionedJid`, `disappearingMode`,
`ephemeralSettingTimestamp`, `expiration`, `actionLink`, `groupMentions`,
`smbClientCampaignId`, `dataSharingContext`, `messageSecret`,
`deviceListMetadataVersion`, `deviceListMetadata`.

### 6.3 Category menu — implemented and unit-tested, never confirmed on hardware

`src/toolkit/category-menu.ts` sends `single_select` with rows keyed **`id`**.
`tests/category-menu.test.js` (17 assertions) passes. A real tap has never been
observed, and `single_select` in a **group** is entirely unverified.

Do not reintroduce the claim that `single_select` is dropped on consumer accounts. That
was **inferred from a malformed payload, not observed**, and has been retracted in
`docs/VERIFICATION.md`. The real defect was row shape — see §8.

### 6.4 `anti-delete.ts` now forwards every revoked message · **disclosure risk**

User edit, not ours:

```ts
if (!options.archiveJid) return false;
if (!options.forwardFrom) return true;   // was: return !jid.endsWith('@g.us')
```

With `archiveJid` defaulting to `62882017467912@s.whatsapp.net`, **every** revoked
message from **every group** is forwarded into that DM, with the sender's JID mentioned.
The original file was explicit that this is a disclosure decision, not a retention one.
Flagged to the user; their call.

### 6.5 Smaller known gaps

- Profile **About** cannot be updated from the linked consumer device; the stanza
  transmits but the account rejects it.
- Inbound-only plugins (`flow`, `commands`, `welcome`, `readReceipts`, `reactions`)
  have synthetic-event coverage only. No real wire reply has ever been observed.
- `Hidden.ts` is registered in `src/plugins/index.ts` but is **not** in the default
  chain, has no tests, and has never been executed.

---

## 7. Release hygiene

`v0.3.1` → `9c2ce9e`. Current `main` is two commits ahead (`5b11a91` category menus,
`114a82e` MAP docs), so **the tag does not contain the category-menu work.** Either
move the tag or cut `0.3.2` — do not republish without asking.

Last confirmed CI green: `5b11a91`. CI for `114a82e` was never checked.

`.env.example` is an unrelated tracked Archil sandbox file with no secret. Left alone.

---

## 8. Traps — each one cost real time

These are verified against hardware or the rc14 source. Do not re-litigate them.

| Trap | Reality |
|---|---|
| **`rowId` vs `id`** | The wire field is `id`. `rowId` produces a stanza the client accepts and then renders nothing. `toInteractiveInner` now normalises to `{ header, title, description, id }`. |
| **Nested quotes in a template substitution** | `` `${x || '[no text]'}` `` **broke the parse of `anti-delete.ts`** — 4 phantom TS1005/TS1160 errors pointing at unrelated lines. 50 insertions of bisecting found it. Build by concatenation. |
| **`copy_to_clipboard`** | Not a WhatsApp flow name. Silently drops. It is **`cta_copy`**. |
| **Media buffer shape** | `{ image: buffer, mimetype, fileName }`. `{ image: { buffer } }` fails. Same for video/audio/document/sticker. |
| **`createEdit`** | Signature is `createEdit(targetKey, text): { text, edit }`. The old form silently no-op'd on a 15-byte payload. |
| **`Album.expected`** | `number \| null`. The `-1` sentinel is gone. |
| **`ephemeralExpiration`** | Passing it to rc14 can crash. `expiration` goes in per-type `contextInfo`. |
| **`decryptMediaMessage`** | Does not exist in rc14. It is `downloadMediaMessage`. |
| **`star`** | A `chatModify` operation, not a `sendMessage` content key. |
| **`sendPresenceUpdate(type, jid)`** | The target JID is **required** for `composing`/`recording`. |
| **`readMessages`** | Needs a genuine inbound key with `fromMe: false`. Your own outgoing key returns nothing. |
| **Phantom delivery** | A clean message ID does not mean delivery. This account drops messages. Confirm on the receiving end, always. |
| **Invented proto fields** | Protobuf drops them without error. They are indistinguishable from working code. |
| **`listFallback` default** | `'text'` — safe. `'off'` sends the native flow and can vanish. |

---

## 9. Live-test harness

No screenshots. **The loop is: send a uniquely-marked message → the user looks at the
phone → the user reports what arrived.** Never claim something works from a returned
message ID.

Scratch scripts live in `C:/Users/bian/AppData/Local/Temp/opencode/*.mjs`. They are
throwaway. Write a fresh one per test; do not add them to the repo.

Canonical skeleton:

```js
import { pathToFileURL } from 'node:url';

const { createNyxBaileys } = await import(pathToFileURL('C:/Nyx-Baileys/dist/index.js').href);
const { toRecipientJid }  = await import(pathToFileURL('C:/Nyx-Baileys/dist/cli/commands.js').href);

const jid = toRecipientJid('62882017467912');       // test recipient
const MARK = 'XX' + new Date().toISOString().slice(11, 19).replace(/:/g, '');

const c = createNyxBaileys({
  sessionDir: 'C:/nyx-live-session',
  logLevel: 'error',
  warmupDays: 0,
  antiSpam: { minGapMs: 300, jitterMs: 150, maxPerMinute: 60, maxQueue: 100 },
});
await c.connect();
await new Promise((r) => { const t = setTimeout(r, 20000);
  c.on('connection.update', (u) => { if (u.connection === 'open') { clearTimeout(t); r(); } }); });

// Assert the chain before trusting any result — a plugin that never registered
// makes every downstream conclusion wrong.
const applied = (c.applied ?? []).map((p) => p.name ?? p);
console.log('chain:', applied.join(' > '));

for (const [label, content] of variants) {
  const r = await c.sock.sendMessage(jid, content);
  console.log(`${label.padEnd(18)} OK id=${r?.key?.id}`);
  await new Promise((x) => setTimeout(x, 2200));   // stay under anti-spam
}

console.log('MARKER:', MARK);   // hand this to the user to look for
await new Promise((r) => setTimeout(r, 4000));
await c.dispose();
process.exit(0);
```

Run it:

```bash
cd /c/Nyx-Baileys && node /c/Users/bian/AppData/Local/Temp/opencode/<name>.mjs
```

**Rules for this harness**

1. `npm run build` first — the scripts import from `dist/`, not `src/`. Editing
   source changes nothing until it is rebuilt.
2. Print the plugin chain before sending. If the plugin under test is not in it, the
   test proves nothing.
3. Every message carries a unique marker so the arrival set is unambiguous.
4. ≥ 2.2 s between sends, or anti-spam swallows the batch.
5. Ask the user for the arrival set. Do not infer it from a message ID.
6. `grep` the output for your own result lines — the socket is noisy.
7. `c.dispose()` and `process.exit(0)` or the process hangs on the live socket.

---

## 10. File map

| File | What it is |
|---|---|
| `CONTEXT.md` | This file — state, bugs, traps, harness. |
| `ANTIGRAVITY-MISSION.md` | Standing open-ended improvement mandate. |
| `ANTIGRAVITY-HANDOFF.md` | One-shot brief, focused on the `Verified.ts` defect. |
| `src/nyxBaileys.ts` | Default chain construction. Modified — wires `verifiedSpoof()`. |
| `src/plugins/index.ts` | Barrel export. Modified — exports `hiddenMentions`. |
| `src/plugins/interactive.ts` | Quick replies + CTA flows. Merged with Gemini's row normaliser. `order: 66`. |
| `src/plugins/Verified.ts` | **User-authored, untracked, defective.** See §6.1. |
| `src/plugins/Hidden.ts` | **User-authored, untracked, untested.** Hidden mention injector. |
| `src/plugins/anti-delete.ts` | Revoke capture + optional forward. Modified. See §6.4. |
| `src/toolkit/category-menu.ts` | `sendCategoryMenu()` / `readMenuSelection()`. |
| `src/toolkit/ops.ts` | 20 operational helpers. |
| `src/plugins/chat-ops.ts` | Group/chat settings. Opt-in. |
| `src/core/intercept.js`→`.ts` | `patch()` + `invariant()` used by every plugin. |
| `src/core/revoked-store.ts` | Bounded store behind `anti-delete`. |
| `src/core/media.ts` | `firstMedia()`, `sizeOf()`. |
| `tests/interactive.test.js` | 30+ assertions; two updated this session. |
| `tests/category-menu.test.js` | 17 assertions. |
| `tests/chat-ops.test.js`, `tests/toolkit.test.js` | Ops coverage. |
| `docs/VERIFICATION.md` | What actually ran on hardware vs what is unit-tested. |
| `docs/MAP.md` | Folder architecture + menu delivery path. |
| `docs/REF-FINDINGS.md` | rc14 reference behaviour. |
| `CHANGELOG.md` | Release history + known limits. |
| `scripts/check-exports.mjs` | Verifies all 24 export targets resolve. |

---

## 11. OPS-50 — what was just added

`src/toolkit/ops-50/`, 92 functions in six modules, exported through
`src/toolkit/index.ts`. Rungs and per-module detail are in
`docs/VERIFICATION.md`; the short version:

- **Read-only paths are live-probed** — 24 of 25 probes clean on the real socket.
- **Every write path is `unverified`.** Nothing destructive was invoked: no removal,
  no blocklist change, no privacy write, no catalogue write. Those need a throwaway
  group and an explicit go-ahead.
- **Newsletter and commerce are account-type gated.** A clean return may still be
  rejected server-side. Do not trust an ID here the way you would for a DM.

### Two rc14 return-shape traps this work found

Both would have shipped silently. Both are now regression-tested.

| Trap | Reality |
|---|---|
| `fetchDisappearingDuration` | Signature is `(...jids) => Promise<USyncQueryResultList[] \| undefined>`. It returns a **result list**, not a number. Reading it as a scalar made `disableExpiry` compare an object to `0` and always report "nothing to do". |
| `sock.authState` | Not always on the socket in this framework. `connectionHealth` must report `registered: undefined` (*unknown*), never a hard `false` — that reads as a broken session and blocks a healthy one. |

**The lesson generalises:** a fake socket in a unit test will happily return a bare
number where rc14 returns a list, and will happily have a method the real socket
lacks. Payload-shape tests prove argument order; they cannot prove return shape.
Anything that *reads* an rc14 return value has to be probed live once.

---

## 12. Working agreements

- **Never `git stash`, delete, or move a user file without explicit permission.** A
  `stash pop` round-trip on `Verified.ts` caused a real outage of trust here. If the
  tree is dirty, say so and work with it.
- A returned message ID is not proof of delivery.
- Never assert hardware behaviour from a passing unit test.
- If a claim in the source contradicts `docs/VERIFICATION.md`, the doc wins — and the
  source comment gets fixed in the same change.
---

## 13. Flux typography — one font per feature file (2026-10-07)

`src/features/typography.ts` gives each rendering feature file its own signature
face. Seven files, seven faces, no overlap:

| Feature file | Face |
|---|---|
| `analytics` | double-struck |
| `auth` | bold sans |
| `groups` | script |
| `i18n` | italic |
| `media` | bold script |
| `messaging` | bold italic |
| `observability` | small caps |

`helpers` and `index` are deliberately unmapped — they render nothing.

### The label/value rule, and why it is load-bearing

**Labels take the face. Values and routing keys stay ASCII.** This is not a
stylistic choice; each half prevents a distinct breakage:

| Field | If styled | Result |
|---|---|---|
| `rowId` / `buttonId` / `id` | reply matching breaks | **device-only failure** — no unit test catches it |
| poll `values` | harder to read | user misreads the options they are voting on |
| `text` / `description` | unselectable | user cannot copy the text back |
| prices, counts | hard to verify | a number in fraktur is not trustworthy at a glance |

`featureFont` is **opt-in and defaults off**. `sendText` is also used for
user-authored content; silently restyling that would corrupt copyable output.

### Two traps found while building this

1. **`isStyled()` missed small caps.** Script/bold/double-struck are astral-plane
   (`U+1D400–U+1D7FF`); small caps are down in IPA extensions (`U+0250–U{02AF}`).
   Missing the second range made every `observability` render double-style into
   `ɢɢʀʀᴏᴏᴜᴅᴅ`. Detector now covers three ranges.
2. **`.length` is not a glyph count.** Astral glyphs cost 2 UTF-16 units, small
   caps cost 1. Any layout code must measure by codepoint. A test asserting
   cross-face string equality failed for exactly this reason.

### `sendList` was broken before this work — fixed

rc14's `generateWAMessage` has **no `listMessage` branch**. `WAProto` defines the
type and `getContentType()` returns `'list'`, but the send path falls through to
`prepareWAMessageMedia()`, finds no media key, and throws `Invalid media type`.
Verified in `node_modules/@whiskeysockets/baileys/lib/Utils/messages.js`.

So **every `sendList` call ever made failed** — it was untested because the tests
use a fake socket that accepts any object. `sendList` now delegates to
`sendCategoryMenu()` (`single_select` native flow, see §6.3), and the payload
mapping is extracted as `toMenuCategories()` so it is directly testable —
`sendCategoryMenu` builds its protobuf internally and only relays an ID, so the
content is otherwise unobservable.

> **Generalised lesson:** a fake socket accepts any object, so it proves argument
> order and never return shape. `sendList` was green in every mock-based test and
> broken on the wire. Any function whose real path depends on a branch existing in
> `generateWAMessage` must be probed against the live socket at least once.

### Live proof

Marker **`TF080012`** — seven per-face texts, one i18n poll, one observability
menu — all returned clean IDs. **Arrival on the recipient's phone is still
unconfirmed**; the user has not reported back. Per §8, a clean ID is not delivery.
