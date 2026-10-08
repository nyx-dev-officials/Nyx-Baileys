# Implementation Plan — Nyx-Baileys / Flux

> Document 3 of 4 (vibe-docs-guide sequence). Requirements: `TRD.md`. Flows: `APP_FLOW.md`. Proof: `TESTING.md`.

---

## Project Rule

> Build one phase at a time.
> Do not start the next phase until the current one passes its verification checks.

This project is **mid-flight**, not pre-development. Phases 0–6 are listed as done because they are done; their state is taken from `TRD.md`, not from memory.

**The one rule this repo violated, and the reason Phase 1 exists:** five functions reported success for work they never did. They type-checked, they exported, and they passed every unit test. Compile-and-export was treated as verification. It is not.

---

## Completed (Phases 0–6)

| Phase | Delivered |
|---|---|
| 0 — Setup | TypeScript strict ESM, `node:test`, `.env.example`, 27 export targets |
| 1 — Core chain | Plugin architecture, `patch`/`invariant`, ordered chain, session store |
| 2 — Ops | OPS-50 (92 fns), OPS-250 (184 fns), features barrel (432 exports) |
| 3 — AI toolkit | Providers, tool registry, scoped memory, identity, free-model fallback |
| 4 — Typography | Per-feature faces, tracking, label/value split |
| 5 — Pacing | 2.5s floor + non-uniform jitter, action bypass |
| 6 — Defect sweep | `sendList` routing, `pin` shape, 3 fake-success functions, `range()` loop |

**Not completed, and carried forward as Phases 1–4 below.** The numbering restarts at 1 deliberately: the next owner should not read "Phase 6 done" as "Phase 1 complete."

---

## Phase 1 — Make `sendList` actually deliver 🔴 highest priority

**Dependencies:** none. Start here.

**Why first:** `AGENTS-FIX-QUEUE.md` §5–6 measured that **`single_select` never arrives on this consumer account**. Commit `357d0ba` routed `sendList` into exactly that flow. It went from *definitely broken* (threw `Invalid media type`) to *plausibly broken* — progress, but not a working feature, and it is the most-used structured surface in the repo.

**Tasks**

- [ ] Read `AGENTS-FIX-QUEUE.md` §6 first — malformed payloads, missing reporting token, message-vs-wrapper shapes and ordering are **already ruled out**. Do not re-chase them.
- [ ] Send `sendList` to the test recipient with a marker. **Ask the user to confirm arrival.**
- [ ] If it does not arrive: change the flow name in `sendCategoryMenu` from `single_select` to `quick_reply`, which the queue identifies as the one that works, passed as `relayMessage`'s `additionalNodes`.
- [ ] Re-verify arrival **and** that the tap round-trips a row selection back.
- [ ] Update `tests/category-menu.test.js` and the flow name in `docs/HOW-IT-WORKS.md`, whose line 246 currently claims sectioned lists render on both platforms.

**Deliverable:** a tapped menu row returns the right selection on this account.

**Verify**
- [ ] Message arrives on the phone (operator-confirmed, marker-matched)
- [ ] Tapping a row sends back a reply that `readMenuSelection()` resolves
- [ ] Row `id` survives as ASCII — a styled id breaks matching on device only
- [ ] `npm test` green

**If arrival still fails after the flow-name change:** stop. Do not add more variants. Record it as a server-side gate on consumer accounts and move to Phase 2 — `AGENTS-FIX-QUEUE.md` §6 already establishes the encoder is not the problem.

---

## Phase 2 — Make `compressAudio` and `optimizeForWhatsApp` real

**Dependencies:** Phase 1 (or run in parallel — different files, no overlap).

**Why:** same defect shape as the five already fixed. `compressAudio` gzips its input to `.compressed.gz` — not audio. `optimizeForWhatsApp` gzips the bytes, keeps the **original extension**, and returns `whatsappReady: true` with `mimeType: 'video/mp4'` — a file guaranteed to be rejected, certified ready.

**The pattern already exists** in `media.ts`: `requireFfmpeg()`, `runFfmpeg()`, `requireNonEmpty()`, applied to `compressVideo` and `trimMedia`. Reuse it. Do not add a second ffmpeg path.

**Tasks**

- [ ] `compressAudio` → real codec via `runFfmpeg` (`bitrate`, `format`, `sampleRate` already in the options interface)
- [ ] `optimizeForWhatsApp` → images via sharp, video/audio via ffmpeg; **derive the output extension from the actual output format**
- [ ] `whatsappReady` must be **computed** from a real size/dimension check, never hardcoded `true`
- [ ] Both must reject, not guess, on unsupported input

**Deliverable:** both functions return genuinely playable/encoded media.

**Verify**
- [ ] Output decodes — `ffprobe` reports a real duration for audio/video
- [ ] `whatsappReady: false` is returned for input that genuinely exceeds limits
- [ ] Non-media input throws instead of producing a `.gz`
- [ ] Missing ffmpeg throws with a message naming the caller
- [ ] New tests in `tests/media-real.test.js` use **real generated files**, never mocks

---

## Phase 3 — Resolve the `anti-delete` disclosure with the user

**Dependencies:** none. **Not agent-executable.**

**Why:** `anti-delete.ts` forwards **every revoked message from every group** into the owner's DM by default. `return true` where the original had `return !jid.endsWith('@g.us')`. This is disclosure, not retention, and the original file said so explicitly.

**Tasks**

- [ ] Present the behaviour and its impact to the user in plain terms
- [ ] Offer options: (a) per-group allowlist, (b) same-chat only, (c) metadata-only capture without forwarding, (d) leave as-is with informed consent
- [ ] Record the chosen option and the reason in `TRD.md` §4.6
- [ ] **Do not change this behaviour without an explicit answer**

**Deliverable:** a documented, user-chosen disclosure policy.

---

## Phase 4 — Per-function fixtures for `src/features/`

**Dependencies:** Phase 2.

**Why:** 395 exports, compile and export cleanly, **largely never executed.** Five fake-success defects were found by execution; the rest is unproven.

**Why the obvious approach fails:** a generic sweep feeding garbage input cannot distinguish *"correctly rejected bad input"* from *"broken on valid input."* Measured: `auth`'s 20 "failures" were all correct crypto validation (`encryptAES` rejecting a non-32-byte key is the function working); `observability`'s 4 "hangs" were sampling functions legitimately sleeping. Reporting those as bugs would be worse than useless.

**Tasks**

- [ ] For each module, derive **one correct input per function from its own signature**
- [ ] Assert the real **return shape**, not merely "did not throw"
- [ ] Whitelist functions that legitimately throw for unsupported platform capability
- [ ] Split any function that hangs a synchronous loop — that class has already produced one real defect (`range()`)

**Deliverable:** a pass/fail verdict per function, not an aggregate count.

**Verify**
- [ ] Every function in `src/features/` has either a passing fixture or a documented "unsupported in rc14"
- [ ] No function returns a plausible result for work it did not do — the standing rule

---

## Phase 5 — Flux AI gaps

**Dependencies:** Phase 4.

- [ ] **Vision end-to-end.** `engine.ts` wraps `prepareForModel()` in `String(...)`, so a `ContentPart[]` becomes `"[object Object]"`. Remove the `String()` and pass parts through.
- [ ] Wire `toneForContext()` — the engine never passes language/question/length context, so tone collapses to one default.
- [ ] Persist transcripts, not just facts — full context does not survive logout/unpair.
- [ ] Decide the `made by Nyx` footer. User asked for it on every reply; it is implemented and defaults **off**.
- [ ] Provider rate-limit back-off on the send path (§4.2 of `TRD.md`).

**Verify**
- [ ] A multimodal turn reaches the provider as structured parts, not a stringified array
- [ ] Two different questions produce measurably different system prompts
- [ ] History survives a restart of the object

---

## Phase 6 — Documentation drift

**Dependencies:** none. Cheap, and it prevents someone re-chasing settled work.

- [ ] Fix `docs/HOW-IT-WORKS.md:246` — sectioned lists do **not** render on consumer accounts
- [ ] Fix `docs/VERIFICATION.md` §5.6 — it recommends the `editedMessage` wrapper, measured as a 15-byte no-op. The correct form is `{ text, edit: key }`
- [ ] Mark the flow-form parser COVERED in `docs/VERIFICATION.md:64` — fixed, record never updated
- [ ] Remove the `adapters/` subsystem from `docs/ARCHITECTURE.md` and `docs/FEATURES.md` — deleted in `0ece183`, ~1,472 lines, with live citations into non-existent files. **Ask before renumbering the 190-row table.**
- [ ] Document the `createEdit` signature change in `CHANGELOG.md` — public surface, and the old call form silently yields `undefined`
- [ ] Append a correction to `357d0ba`'s "verified against real files, not mocks", which is true of its media half and misleading for the `sendList` half

---

## Phase 7 — Release

**Dependencies:** Phases 1, 2, 3.

- [ ] `v0.3.1` → `9c2ce9e`, eleven commits behind `main`
- [ ] **Ask before** moving the tag, cutting `0.3.2`, or publishing
- [ ] Rotate the exposed provider keys first — they are in chat and in `C:/Users/bian/Downloads/NOX-API-KEYS.md`

---

## Out of Scope

So scope is not expanded silently:

- **Rendering text to images for real font files.** Offered once, declined.
- **WhatsApp native formatting** (`*bold*`, `_italic_`, `~strike~`). Explicitly rejected; Unicode variants only.
- **Any new typography face** without asking. Four are hardware-approved; two earlier rounds of guesses were both wrong.
- **Destructive group actions** — remove, blocklist, privacy writes, catalogue writes. Never invoked, by design.
- **A real authentication layer.** The socket session is the credential. `TRD.md` §3 marks this `TBD`.
- **Business-tier features.** All measurements are from a consumer account.

---

## How to work the plan

1. Give the agent **only the current phase** plus the relevant `TRD.md` sections.
2. Ask it to list the files it plans to change **before** it changes them.
3. After the phase is built, run that phase's `TESTING.md` checks.
4. Fix failures before moving forward.
5. Update the plan if scope changes. **Never leave a plan that contradicts the shipped product** — stale plans are how the last three session's work got misread as complete.

## Phase implementation prompt

> "We are implementing Phase N only. Read `TRD.md` and `APP_FLOW.md`, then give me a step-by-step plan for this phase. Do not implement anything outside this phase. Before coding, list assumptions and files you expect to create or modify."