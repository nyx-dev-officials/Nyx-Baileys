# Antigravity handoff — copy everything below this line

---

You are taking over `C:/Nyx-Baileys`, a hyper-modular WhatsApp framework built on
`@whiskeysockets/baileys` **rc14**. It does not fork Baileys — it decorates the live
socket at runtime with an ordered plugin chain and returns a real Baileys socket.

**Read `C:/Nyx-Baileys/CONTEXT.md` first.** It contains the git state, the live account
details, a list of traps that each cost real debugging time, and the live-test harness.
Do not skip it. Every task below assumes you have.

---

## Absolute rules

1. **Never `git stash`, delete, move, or overwrite a file you did not create.** The
   working tree is dirty with user-authored work. If a task seems to need that, stop and
   ask.
2. **A returned message ID is not proof of delivery.** This account drops messages
   silently. Never report a WhatsApp feature as working from a clean ID. The user looks
   at the phone and tells you what arrived.
3. **Never assert hardware behaviour from a passing unit test.** Keep "unit-tested" and
   "confirmed on hardware" as separate claims, always.
4. **Do not commit, push, retag, or publish without explicit instruction.** In
   particular: do not commit `src/plugins/Verified.ts` or `src/plugins/Hidden.ts`, and
   do not move `v0.3.1` or cut a release.
5. Run the full chain before and after every change:
   `npm run check && npm run build && npm test && node scripts/check-exports.mjs`
   Expected: clean, clean, **783 pass / 0 fail**, 24 exports.
6. Prefer the smallest diff that kills the bug. Do not refactor adjacent code.

---

## Live account

| | |
|---|---|
| Own number | `6283831459585` |
| Session | `C:/nyx-live-session` |
| Test recipient | `62882017467912` → `62882017467912@s.whatsapp.net` |

Never commit `creds.json` or anything under `C:/nyx-live-session`.

**No screenshots.** The verification loop is: you send a uniquely-marked message, the
user looks at their phone, the user reports what arrived. Ask for the arrival set.

Use the harness in `CONTEXT.md` §9. Two things people get wrong: run `npm run build`
first (scripts import from `dist/`, so editing `src/` does nothing until rebuilt), and
print the plugin chain before sending — if the plugin under test is not in the chain,
the test proves nothing.

---

## Task 1 — diagnose why `Verified.ts` messages are invisible · **start here**

This is the only confirmed, blocking bug.

`src/plugins/Verified.ts` defines `verifiedSpoof()`, which wraps `sock.sendMessage` and
stamps every outgoing message with a fabricated `status@broadcast` quote plus a large
`contextInfo` block, so the message appears to originate from an official Meta-verified
business account.

**Symptom:** `sendMessage` returns a clean ID, the message shows in the bot's own chat,
and **nothing arrives in the test chat.**

```
SENT id=3EB03C2A02A4EFBDD6A945   ← "hi", verifiedSpoof active, never arrived
```

A 10-variant bisect already ran. Each variant isolated one group of context fields and
**every one returned a clean ID** — no server-side rejection at any point:

| Variant | Isolates | ID |
|---|---|---|
| 1-control | plain text, no context at all | `3EB0805925B08FEA8D8694` |
| 2-quote-only | the fake status quote | `3EB08653F0D7625F331049` |
| 3-fwd-only | `isForwarded` + `forwardingScore` | `3EB0C87FD4F7842F3BF931` |
| 4-expiry-only | `expiration` + ephemeral timestamp | `3EB09C8ECB77D343B57401` |
| 5-mentions-only | `mentionedJid` + `groupMentions` | `3EB0B91ED8E05A2CE10308` |
| 6-ad+business | `externalAdReply` + `businessOwnerJid` | `3EB0EFDF636D9C41844A9B` |
| 7-actionlink | `actionLink` | `3EB0CE294A5FD49DCC1F2C` |
| 8-newsletter | `forwardedNewsletterMessageInfo` | `3EB0DA32ACEE56D04F554E` |
| 9-fullctx | the entire real contextInfo block | `3EB0FBFD9920496CE461B5` |
| A-full | full block **and** the fake quote | `3EB03B0084079F58E06027` |

Marker for that run: `VL104824`.

### Step 1.1 — establish the control (do this first, everything depends on it)

Re-send a **plain text** message with **no plugin registered**, to
`62882017467912`, with a fresh marker. Then ask the user:

> did `<marker> 1-control` arrive in the test chat?

- **It arrived** → delivery is fine; the plugin causes a render suppression. Go to 1.2.
- **It did not arrive** → the plugin is exonerated. This is the account-level phantom
  -delivery problem that has bitten this project repeatedly. Go to 1.3.

**Do not skip this. Do not start deleting context fields before you have the answer.**
Two entirely different bugs fit the evidence.

### Step 1.2 — if plain text arrives: bisect for render suppression

Now the server stores the message and the client draws nothing. Suspects, in order:

1. The fake `status@broadcast` quote — the recipient cannot fetch it.
2. `externalAdReply` with `showAdAttribution: true`.
3. `actionLink`.
4. `businessOwnerJid` / `businessMessageForwardInfo`.
5. `forwardedNewsletterMessageInfo`.
6. `expiration: 86400` + `disappearingMode` + `ephemeralSettingTimestamp`.
7. `mentionedJid` / `groupMentions` referencing `0@s.whatsapp.net`.

Method: send one variant per suspect, each with its own marker, and get the arrival +
visibility set from the user. Binary search if you want to be fast.

### Step 1.3 — if plain text does not arrive: it is not the plugin

Reproduce with the plugin fully removed from the chain. Compare against a known-good
baseline from earlier in this project where the same payload shape *did* arrive. Look
at session state and the connection lifecycle, not at `Verified.ts`.

### Step 1.4 — read this before touching the file

Layers 22–50 of `Verified.ts` — `isVerifiedAccount`, `isOfficialBusiness`,
`isProtected`, `isStrictDelivery`, `protocolVersion`, `isBot`, `productMessageInfo`
and the rest — **do not exist in rc14's `IContextInfo`.** Protobuf drops unknown
fields without error, so they are no-ops.

They therefore **cannot** be causing the invisibility, and they **cannot** produce a
verified badge. Any "fix" that only removes them will change nothing. That is why
merely stripping layers is not the fix.

### Task 1 deliverables

- A written diagnosis naming the specific field or stanza, with the evidence.
- The smallest diff that restores visibility.
- Updated tests.
- A live confirmation from the user that the message renders **and** is visible in the
  test chat. No confirmation, no claim.

---

## Task 2 — confirm the category menu on hardware

`src/toolkit/category-menu.ts` sends `single_select` with rows keyed **`id`** (not
`rowId` — `rowId` produces a stanza the client accepts and then renders nothing).
17 unit assertions pass. **A real tap has never been observed.** `single_select` in a
group is entirely unverified.

Send a category menu to `62882017467912`, get the user to tap a row, and confirm
`readMenuSelection()` receives it.

Two cautions:

- An earlier revision of the source claimed `single_select` is dropped on consumer
  accounts. That claim was **inferred from a malformed payload, not observed**, and has
  been retracted in `docs/VERIFICATION.md`. Do not reintroduce it. If a menu fails,
  suspect the payload shape before the platform.
- `interactive.ts` defaults `listFallback` to `'text'` deliberately — the `'off'` path
  can send a native flow that silently vanishes. Do not flip the default.

---

## Task 3 — decide `anti-delete.ts` forwarding, do not assume

`src/plugins/anti-delete.ts` has an uncommitted user edit that changed the forwarding
gate from opt-in to opt-out:

```ts
if (!options.archiveJid) return false;
if (!options.forwardFrom) return true;   // was: return !jid.endsWith('@g.us')
```

with `archiveJid` defaulting to `62882017467912@s.whatsapp.net`.

Every revoked message from **every group** is now forwarded into that DM with the
sender's JID mentioned. The original file was explicit that forwarding is a disclosure
decision, not a retention one — people delete things in groups because they do not want
them kept.

**Present this to the user and let them choose.** Do not silently revert it, and do not
ship it as-is without a deliberate decision.

---

## Task 4 — `Hidden.ts` is wired but never executed

`src/plugins/Hidden.ts` is exported from `src/plugins/index.ts` but is **not** in the
default chain in `src/nyxBaileys.ts`, has **no tests**, and has never been run. It
injects mentions targeting the recipient plus `0@s.whatsapp.net`.

Its name is misleading — it uses public `mentionedJid`, which is not "hidden" in any
meaningful sense; it is visible in the message. Confirm with the user what it is
actually meant to do before writing tests or wiring it in.

---

## Task 5 — release hygiene (ask first)

`v0.3.1` points at `9c2ce9e`. Current `main` is two commits ahead, so **the tag does not
contain the category-menu work** (`5b11a91`) or `docs/MAP.md` (`114a82e`).

Ask before doing any of: move the tag, cut `0.3.2`, commit `Verified.ts`/`Hidden.ts`,
or publish. CI for `114a82e` was never checked — verify it before assuming green.

---

## Known traps — each one already cost real time

Verified against hardware or the rc14 source. Do not re-litigate.

- **A quoted string nested in a template substitution breaks the parse.**
  `` `${x || '[none]'}` `` produced 4 phantom `TS1005`/`TS1160` errors pointing at
  unrelated lines and cost a long bisection. Build such strings by concatenation.
- `rowId` must be normalised to `id` on the wire.
- The CTA flow is **`cta_copy`**. `copy_to_clipboard` silently drops.
- Media is `{ image: buffer, mimetype, fileName }`, never `{ image: { buffer } }`.
- `createEdit(targetKey, text)` returns `{ text, edit }`.
- `Album.expected` is `number | null` — the `-1` sentinel is gone.
- `expiration` goes in per-type `contextInfo`; passing rc14 `ephemeralExpiration` can crash.
- There is no `decryptMediaMessage` in rc14. It is `downloadMediaMessage`.
- `star` is a `chatModify` operation, not a `sendMessage` content key.
- `sendPresenceUpdate(type, jid)` requires the target JID.
- `readMessages` needs a genuine inbound key with `fromMe: false`.
- Invented proto fields drop silently and look exactly like working code.

---

## Communication rules

- Report **only** what was observed. Separate "unit-tested", "builds clean", "sent",
  and "confirmed visible on the recipient's phone" — never collapse them.
- When something fails, report the raw error and the command that produced it. Do not
  paraphrase a failure into a success.
- If a task is blocked on the user (a phone check, a decision), say exactly what you
  need and stop. Do not guess.
- Ask before anything that touches git history, releases, or the live session.