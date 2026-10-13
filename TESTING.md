# Testing Guide — Nyx-Baileys / Flux

> Document 4 of 4 (vibe-docs-guide sequence). Requirements: `TRD.md`. Flows: `APP_FLOW.md`. Order: `IMPLEMENTATION_PLAN.md`.

---

## 1. Testing Goal

**A message the operator did not see arrive on a phone is untested, regardless of what the API returned.**

This project has exactly one product, and the platform reports success for messages it never delivers. Every rule below descends from that fact.

---

## 2. The rule that overrides the rest

**Never mark anything passed unless it was actually verified.** Not from a return value. Not from a passing mock. Not from a plausible log line.

Three ways a claim gets marked passed without evidence, all of which have happened here:

| False evidence | What actually happened |
|---|---|
| A clean message ID | `sendList` returned an ID for a message that never arrived |
| A mock socket accepted the payload | `sendList` passed every test and threw on every real send |
| A unit test on a helper | `prepareForModel()` passes; the engine's `String()` around it destroys the output |

---

## 3. The live verification loop

There are no screenshots. This is the whole procedure.

```
1. npm run build          ← scripts import from dist/, not src/
2. print the plugin chain ← a plugin that never registered proves nothing
3. send uniquely-marked messages
4. ≥ 2.5s apart           ← matches shipped pacing
5. USER looks at the phone
6. USER reports what arrived
7. record arrival, not the ID
```

**Canonical harness**

```js
import { pathToFileURL } from 'node:url';

const DIST = 'C:/Nyx-Baileys/dist';
const { createNyxBaileys } = await import(pathToFileURL(`${DIST}/index.js`).href);
const { toRecipientJid }  = await import(pathToFileURL(`${DIST}/cli/commands.js`).href);

const jid  = toRecipientJid('62882017467912');   // test recipient
const MARK = 'XX' + new Date().toISOString().slice(11, 19).replace(/:/g, '');

const c = createNyxBaileys({
  sessionDir: 'C:/nyx-live-session',
  logLevel: 'error',
  warmupDays: 0,
  antiSpam: { minGapMs: 2_500, jitterMs: 0, maxPerMinute: 60, maxQueue: 100 },
});
await c.connect();
await new Promise((r) => { const t = setTimeout(r, 20000);
  c.on('connection.update', (u) => { if (u.connection === 'open') { clearTimeout(t); r(); } }); });

console.log('MARKER:', MARK);
console.log('chain:', (c.applied ?? []).map((p) => p.name ?? p).join(' > '));

// ...send marked messages, ≥2.5s apart...

console.log('MARKER:', MARK, '- report which arrived');
await new Promise((r) => setTimeout(r, 4000));
await c.dispose();
process.exit(0);                                   // or the process hangs
```

**Scratch scripts live in** `C:/Users/bian/AppData/Local/Temp/opencode/*.mjs`. Never in the repo.

---

## 4. Test types, mapped to this product

| Check | Means here |
|---|---|
| Happy path | Message arrives, with the right content, styled as intended |
| Validation | Garbage input is **rejected loudly**, not coerced |
| Error handling | Unsupported platform capability **throws**, never returns a plausible empty result |
| Permissions | One chat cannot read another's memory; no cross-chat leakage |
| Device | **The operator's actual phone.** Not a resized browser |
| Accessibility | Limited — see below |
| Regression | `npm test` stays green at 1365; export targets stay at 27 |

**Accessibility:** there is no UI to audit for keyboard or focus. What applies is that rendered structures are native WhatsApp UI, so the client handles a11y. This is a genuine limitation, stated rather than ticked.

---

## 5. Automated checks — run these

```bash
npm run check                     # tsc --noEmit, strict
npm run build                     # clean dist
npm test                          # node:test
node scripts/check-exports.mjs    # 27 export targets
```

Current: `0` errors · `1365 pass / 0 fail` · `27` targets.

### Tests that exist because they caught something

| File | What it prevents |
|---|---|
| `tests/rc14-surface.test.js` | Calling a socket method rc14 never had; unsupported functions faking success |
| `tests/media-real.test.js` | Codec functions reporting success without doing the work — uses **real generated files** |
| `tests/helpers-loop.test.js` | `range()` looping forever on strings. A *hang*, invisible to assertions |
| `tests/typography.test.js` | Faces emitting glyphs outside their own Unicode block |
| `tests/feature-font.test.js` | A styled `rowId`/`buttonId` — breaks reply matching **on device only** |
| `tests/send-cooldown.test.js` | Jitter undercutting the 2.5s floor |
| `tests/category-menu.test.js` | Menus emitting the `listMessage` rc14 cannot send |

### What automation cannot do here

A fake socket **accepts any object**. It proves argument order and never return shape. Anything whose behaviour depends on a branch existing in `generateWAMessage`, or on a protobuf field name, must be exercised against **real files or a real socket**. Five defects got through because of this.

---

## 6. Manual checks — only the operator can do these

| # | Check | Method | Status |
|---|---|---|---|
| M1 | Plain text arrives | send marked text, user confirms | ✅ `VC123543` |
| M2 | `verifiedSpoof` does not suppress | OFF/ON control, separate connection | ✅ `VC123543` |
| M3 | Seven typography faces render | send all seven | ✅ `FD122327` — user rated 10/10 |
| M4 | Poll arrives | send marked poll | ⚠️ sent, arrival unconfirmed |
| M5 | **Menu arrives** | send marked menu | ⚠️ **unresolved** — `AGENTS-FIX-QUEUE.md` §5-6 measured it never arriving; `docs/VERIFICATION.md` retracts that and reports it rendering. They contradict each other |
| M6 | Menu tap round-trips | tap a row, confirm reply routes | ❌ **never observed** — no tap has ever come back from a real phone |
| M7 | Poll vote routes back | vote, confirm reply | ⚠️ unconfirmed |
| M8 | Button tap round-trips | tap, confirm reply | ⚠️ unconfirmed |
| M9 | Tracked typography is readable | user reads it aloud | ✅ via M3 |

---

## 7. Release blockers

Do not ship with any open:

- [ ] **Critical journey broken.** M5/M6 currently fail.
- [ ] **A function returns success for work it did not do.** Was true five times; `compressAudio` and `optimizeForWhatsApp` still do.
- [ ] **Unverified items not listed as unverified.** §6 above is that list.
- [ ] **Exposed secrets.** Provider keys are exposed in chat and in `C:/Users/bian/Downloads/NOX-API-KEYS.md`. **Rotate before any release.**
- [ ] **`anti-delete` disclosure unresolved** — forwards every revoked group message to the owner's DM.
- [ ] No console errors on the primary path — **not assessed**; there is no error monitoring.

---

## 8. Testing when you are not technical

1. Use it exactly like a first-time recipient.
2. Then deliberately do the wrong thing: send nonsense, send an unknown command, send no prefix, resend fast.
3. Tap every button, poll, and menu you receive. **Tapping is the test** — a message that renders but does not route is still broken.
4. Check on the actual phone, not just the operator's chat view.
5. Write down **what you expected vs what happened**, and quote the marker. That alone makes bug reports far clearer.

> Ask: *"show me what you tested and what remains unverified"* — never only *"is this secure?"* or *"does this work?"*

---

## 9. Test run for a phase

> "Using `TESTING.md`, create a test run for Phase N. Separate automated checks from checks the operator must do manually. For each failure, explain the impact in plain English, and **do not mark anything as passed unless it was actually verified**."

---

## 10. Honest status

**Verified:** build, typecheck, 1365 assertions, 27 exports, pacing, typography, image/audio media paths (`compressAudio` and `optimizeForWhatsApp` now transcode for real), `verifiedSpoof` non-suppression.**Unverified and known broken:** menu delivery and tap round-trip (disputed — see
M5/M6); poll/button tap round-trips; group-context `single_select`; every
non-`quick_reply` interactive flow.

**Fixed and regression-tested on 2026-10-08, against real files and stubbed
providers:** `compressAudio` and `optimizeForWhatsApp` now produce real media;
vision parts travel instead of `"[object Object]"`; tone context reaches the
prompt; transcripts persist and rehydrate. What is verified is the *code path* —
on-device rendering of menus and flows still is not.

**New — the feature menu.** `featureMenu`/`sendFeatureMenu` (in
`src/toolkit/feature-menu.ts`) build the `single_select` sheet whose rows are
Call / URL / Quick Reply / Copy, and the example bot's `/menu` sends it, dispatches
taps to a per-feature example, and falls back to text. `tests/feature-menu.test.js`
asserts the payload shape (row key is `id`, not `rowId`), the id round-trip, and
the fallback. Rendering it on a phone is the *same* unverified native-flow question
logged at M5/M6 — the builder is proven, the delivery is not.

**The rows are derived, not written.** The menu intersects the interactive
plugin's flow registry (`NATIVE_FLOW_NAMES`, now a runtime array so it can be read
at runtime rather than restated) with a sender registry (`FLOW_SENDERS`) naming the
exported function that sends each flow. A flow with no sender cannot reach the menu,
which is how `Location Request` — a row that shipped with nothing behind it — was
removed. The suite asserts the derivation: every sender name resolves to a real
callable, every row is backed by one, and every declared flow is accounted for in
exactly one bucket (menu, excluded, unlabelled, or unsendable) so nothing can be
silently dropped.

**`interactiveButtons` — the reference calling convention.**
`refs/atex-ovi__wabase-button` (the repo behind the menu screenshot) sends buttons
as `sock.sendMessage(jid, { text, title, subtitle, footer, interactiveButtons: [{
name, buttonParamsJson }] })`. That content key is now handled by the interactive
plugin. The stanza's `native_flow` name is **not** read off the payload: it is the
fixed literal `mixed` with `v='9'`, and the tests assert that constant rather than
the button's flow. An earlier revision of these tests asserted the opposite —
`name === the button's flow` — and passed for weeks while every interactive send
arrived on a phone without its button. The reference's own payload is asserted
verbatim in `tests/interactive.test.js`, and as of 2026-10-09 a rendered menu has
been confirmed on hardware.

**Unverified, unknown size:** 395 exports in `src/features/` minus the five defects found. Phase 4 exists to close this.