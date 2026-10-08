# TRD — Nyx-Baileys / Flux

> **Technical Requirements Document.** Per the vibe-docs-guide sequence, this is document 1 of 4. The others are `APP_FLOW.md`, `IMPLEMENTATION_PLAN.md`, `TESTING.md`.
>
> **Status of every checkbox below is a measurement, not an intention.** `[x]` means verified on hardware or against the installed rc14 source. `[ ]` means not verified — not "not started." Many items are `[ ]` despite existing code, and that distinction is the point of this document.
>
> **Evidence for every `[x]`:** `AGENTS-FIX-QUEUE.md` (measured on the live account) and `docs/VERIFICATION.md`. Where those two and a code comment disagree, the measured document wins and the comment is the defect.
>
> Last verified: 2026-10-07 · commit `0bed09b`

---

## 1. Project Overview

`C:/Nyx-Baileys` is a modular WhatsApp automation framework that wraps `@whiskeysockets/baileys` **rc14** without forking it. It decorates a live Baileys socket at runtime with an ordered plugin chain and returns a real socket, so it can be used as a library or as a bot.

The end state — **Flux** — is that framework plus a WhatsApp-native AI agent: tools that render as native WhatsApp UI, durable scoped memory, multimodal input, free-model inference, and a per-feature typographic identity. The product surface is the chat itself, so "UI" decisions are formatting decisions.

**TBD** — target audience beyond the current single operator is undecided. Every requirement below is written for one operator and one test recipient.

---

## 2. Technical Goals

- [x] **A returned message ID is never treated as delivery.** This account silently drops sends; the distinction is enforced by the test loop in `TESTING.md`.
- [x] **No function reports success for work it did not do.** A fake result is more expensive than a crash. Enforced by `tests/rc14-surface.test.js` and real-file tests in `tests/media-real.test.js`.
- [x] **No API key is hardcoded.** Read from environment; `.env` is git-ignored.
- [ ] **AI output cannot silently corrupt user data.** Currently violated: `trimMedia` destroyed files before `357d0ba`. Broader guarantee not yet implemented.
- [ ] **Every destructive action is confirmed by the user.** Currently violated by `anti-delete` default behaviour — see §4.6.
- [ ] **WhatsApp-native rendering is used over screenshots.** Partially true: media is genuinely transcoded, but typography is Unicode text rather than real fonts because the user rejected image rendering.

---

## 3. Proposed Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Core | `@whiskeysockets/baileys` **rc14** | Installed **and** registry-latest. Upstream `master` has an unpublished `WIN32 → WIN_HYBRID` fix; `assertBrowserIsSafe()` guards the known rc14 428. |
| Runtime | Node ≥ 20 (local v24.19.0) | |
| Language | TypeScript, `strict`, ESM | `node16`/`nodenext` resolution — relative imports need explicit `.js` |
| Tests | `node:test` | 1288 assertions, 0 failures |
| Media | `sharp` (libvips 8.18.7) + system `ffmpeg` | Both required by `media.ts`. ffmpeg at `C:/Users/bian/bin/ffmpeg` |
| AI | OpenRouter free tier, Anthropic, Gemini, Groq, Ollama, echo | Free models probed live; see §6 |
| Typography | Unicode mathematical/small-cap lettersets + tracking | No font files. WhatsApp has no font selection. |
| Auth | **TBD** | No authentication layer exists. The socket session *is* the credential. |
| Hosting | **TBD** | Currently a locally-run process with a persisted session. |
| Error monitoring | **TBD** | None. Failures surface in stdout only. |

---

## 4. Functional Requirements

Written as observable behaviour.

### 4.1 Socket lifecycle and plugin chain

- [x] Plugins apply in ascending `order`; lower order wraps earlier, so it runs inside.
- [x] A plugin returning `undefined` from `patch` does not break the chain.
- [x] Each plugin registers an undo via `onDispose`.
- [x] `npm test` confirms the chain against a fake socket.
- [ ] **A message survives a full connect → send → dispose → reconnect cycle on a real socket.** Partially evidenced only.

### 4.2 Outbound pacing

- [x] A minimum 2.5s gap between outbound messages.
- [x] Random jitter **only ever widens** the gap; it can never undercut the floor. Box-Muller clamped, not uniform — uniform clusters at the ends and is as machine-like as no jitter.
- [x] Protocol actions (react, edit, delete, pin, disappearing-messages) bypass the queue and do not consume the per-minute ceiling.
- [x] `{ text, react: undefined }` is still treated as a paced text send, matching upstream's `hasNonNullishProperty` test.
- [ ] Rate-limit and ban responses from the server are **not** handled — there is no back-off on a 429 from the send path itself.

### 4.3 Typography (`src/features/typography.ts`)

- [x] Each rendering feature file has its own signature face.
- [x] Only the four hardware-approved faces are used: small caps, bold, bold-italic, italic. Gothic/fraktur excluded as cringey.
- [x] Seven files, four faces → the rest separated by tracking (hair space U+200A), a real typographic device.
- [x] **Labels take the face; values and routing keys stay ASCII.** A styled `rowId` or `buttonId` breaks reply matching, and only on device.
- [x] `featureFont` is opt-in and **defaults off**, so user-authored text is never silently restyled.
- [x] Styling is idempotent; already-styled input returns unchanged.
- [x] No face emits WhatsApp native markup (`*bold*`, `_italic_`, `~strike~`, backticks). Explicitly rejected by the user.
- [x] Every face emits glyphs only from its own Unicode block, asserted by codepoint.

### 4.4 Messaging (`src/features/messaging.ts`)

- [x] `sendText`, media senders, `sendPoll`, `sendButtons`, `sendContact` honour `featureFont` on labels only.
- [x] `sendList` never emits `listMessage`, which rc14's `generateWAMessage` cannot send at all.
- [x] `pinMessage` sends `{ pin: <key>, type: n }` as siblings; the nested shape is dropped by protobuf.
- [x] `searchMessages` and `getMessageInfo` **throw** rather than return a plausible empty result. rc14 exposes no such API.
- [ ] **`sendList` does not yet render.** It routes to `sendCategoryMenu()` → `single_select`, which `AGENTS-FIX-QUEUE.md` §5-6 measured as **never arriving on this consumer account**. Arrival unverified. **This is the highest-priority defect.**
- [ ] `cta_url`, `cta_copy`, `cta_call` on a consumer account — server-whitelisted, never sent from this account.
- [ ] `single_select` in a **group** — never tested, only 1:1.
- [ ] `templateMessage`, `carouselMessage`, `collectionMessage`, `productMessage`, `contactMessage` — never confirmed rendering.
- [ ] `createFormFlow` / `createTableFlow` / `createCarouselFlow` — encode cleanly, rendering never confirmed on any tier.

### 4.5 Media (`src/features/media.ts`)

- [x] `compressImage` decodes and re-encodes via libvips; preserves input format so a `.png` does not become JPEG and lose alpha.
- [x] `compressImage` refuses to upscale when given `maxWidthPx`.
- [x] `compressVideo` transcodes to H.264/MP4 with `+faststart`, crf clamped.
- [x] `trimMedia` cuts container-aware via ffmpeg `-ss/-to -c copy`, verified with `ffprobe` on a real MP4.
- [x] ffmpeg availability is probed; a missing binary **throws**. No byte-level fallback, deliberately.
- [x] Codec output is verified non-empty rather than trusting the exit code.
- [ ] **`compressAudio` still gzips its input to `.compressed.gz`.** Not audio. Returns a plausible ratio.
- [ ] **`optimizeForWhatsApp` is worse.** Gzips the bytes, keeps the **original extension**, and returns `whatsappReady: true` with `mimeType: 'video/mp4'`. A file guaranteed to be rejected, certified ready.
- [ ] WhatsApp's actual size/dimension limits are not enforced anywhere.

### 4.6 Privacy and group moderation — **needs the user's decision**

- [x] Revoked messages are captured with bounded memory.
- [ ] **`anti-delete` forwards every revoked message from every group into the owner's DM by default.** `return true` where the original had `return !jid.endsWith('@g.us')`. This is disclosure, not retention, and the original file said so.
- [ ] **Do not change this unilaterally.** Raise it with the user and let them choose.
- [ ] No destructive group action (remove, blocklist, privacy writes, catalogue writes) has ever been invoked. All are `unverified` by design — they need a throwaway group and explicit go-ahead.

### 4.7 Flux AI toolkit (`src/toolkit/ai/`)

- [x] Default prefix is `flux`; accepts `flux ping`, `flux/ping`, `flux:ping`, and legacy `/ping`.
- [x] Tool registry with explicit approval for mutating tools.
- [x] Tool-call loop resolves, executes, feeds the real result back, and produces a grounded answer. Exercised live.
- [x] Free-model catalogue derived from live probes, not assumption; each entry records stable / flaky / rejected.
- [x] Retries, transient-outage detection, rate-limit handling, and an automatic fallback chain.
- [x] Scoped memory: `s1` and `s2` isolated; durable user facts atomic and user-scoped; path-traversal safe.
- [x] Identity: name `Flux`, role `flux developer`, owner answer returns `+62 838-3145-9585`, typography sanitizer.
- [x] Multimodal preparation refuses to invent audio/document contents.
- [ ] **Vision is broken end to end.** `engine.ts` wraps `prepareForModel()` in `String(...)`, so a `ContentPart[]` becomes `"[object Object]"`. The standalone helper passes tests; the engine path was never exercised.
- [ ] `toneForContext()` exists but the engine never passes language/question/length context, so contextual tone collapses to one default.
- [ ] `DurableMemory` persists **facts, not transcripts.** Full conversation context does not survive logout/unpair.
- [ ] `made by Nyx` footer is implemented but **defaults off**; the user asked for it on every reply.
- [ ] No verified **free** vision model exists. Current free model is text-only.

### 4.8 Session and resilience

- [x] `assertBrowserIsSafe()` guards the known rc14 428 browser-identity failure.
- [x] Session store performs atomic writes.
- [ ] Profile **About** cannot be updated from this linked consumer device; the stanza transmits and the account rejects it.
- [ ] No rate-limit or ban back-off on the send path (§4.2).

### 4.9 Package surface

- [x] 27 export targets resolve; verified by `scripts/check-exports.mjs`.
- [x] `nyx-baileys/features` is a separate subpath because the features modules duplicate ~42 toolkit names; flattening produces ambiguous re-exports TypeScript refuses to resolve.
- [x] The features barrel is generated from what modules actually export; 42 collisions aliased by module prefix rather than silently resolved.
- [ ] `src/features/` — **395 exports, largely never executed.** Compilation is not evidence. Five fake-success defects were found by execution; the rest is unproven. Blocked on per-function fixtures — see `IMPLEMENTATION_PLAN.md`.

---

## 5. Non-Functional Requirements

- [x] `npm run check` clean under TypeScript `strict`.
- [x] `npm run build` clean.
- [x] `npm test` — 1288 pass / 0 fail.
- [x] No key-shaped string anywhere in the tracked tree; verified by scan before every commit this session.
- [x] Bot identity and timing are treated as fingerprint-relevant: jitter is non-uniform and actions bypass pacing.
- [ ] **No public API changed without a CHANGELOG entry.** `createEdit`'s signature changed in `0ece183` and was never documented — the old call form silently yields `undefined` rather than a compile error.
- [ ] No error monitoring. A send failure in production is a line in stdout.
- [ ] No performance budget. Untested under message burst.
- [ ] Not published. `v0.3.1` → `9c2ce9e`, **11 commits behind `main`**. Do not move the tag or cut `0.3.2` without asking.

---

## 6. Integrations

| Service | Purpose | Failure behaviour | Verified |
|---|---|---|---|
| WhatsApp (rc14) | transport | this account drops sends; a clean ID is not delivery | `[x]` measured |
| OpenRouter free tier | AI inference | 30–100s outages, `free-models-per-min` limit, automatic fallback | `[x]` measured |
| `ffmpeg` | video/audio trim and compress | **throws** with a clear message; no byte fallback | `[x]` |
| `sharp` / libvips | image work | throws on undecodable input; error propagates | `[x]` |
| Anthropic / Gemini / Groq / Ollama | AI providers | provider error surfaces to caller | `[ ]` never exercised end to end |
| Pollinations | image generation | — | `[ ]` not implemented; key present in `.env` unused |

---

## 7. Constraints

- **Secrets** stay in environment variables. `.env` is git-ignored.
  🔴 **Keys were exposed in chat and in `C:/Users/bian/Downloads/NOX-API-KEYS.md`. Rotate them. Rotate them before any further real-provider testing.**
- **Never** `git stash`, delete, or move a user file without explicit permission. A stash round-trip on `Verified.ts` once cost a real outage of trust.
- `src/plugins/Verified.ts` and `Hidden.ts` are user-authored. Both are committed because tracked files import them; excluding them breaks the build.
- Free-tier quota is account-wide and includes failures.
- Real font files (Exo Italic, Liberation Serif, Lobster, Zaslia) are **unreachable in text** — WhatsApp has no font selection. They require rendering to an image, which the user declined.
- **No destructive action without confirmation** — currently violated by `anti-delete` (§4.6).
- Consumer WhatsApp account tier gates several features. Results measured on a 1:1 consumer account do not transfer to Business or group contexts without retesting.

---

## 8. Definition of Done

Project-level done, in order:

- [x] Every functional requirement is either verified or **explicitly listed as unverified**. This document is that list.
- [x] No known critical security issue. (The `anti-delete` disclosure is a *privacy decision*, tracked as §4.6.)
- [x] Secrets absent from the tracked tree.
- [x] Pacing, typography, and codec behaviour verified against real files and a real socket.
- [ ] `sendList` renders on a consumer account (§4.4).
- [ ] `compressAudio` and `optimizeForWhatsApp` produce real media (§4.5).
- [ ] `anti-delete` disclosure resolved by user decision (§4.6).
- [ ] Vision works end to end through `engine.ts` (§4.7).
- [ ] `src/features/` fixtures exist per function (§4.9).
- [ ] `v0.3.1` / `0.3.2` release resolved with the user (§5).

---

## 9. Open Contradictions

Surfaced by step 2 of the vibe-docs-guide workflow — "list contradictions before rewriting". These need a decision, not a patch.

1. **`docs/HOW-IT-WORKS.md:246` claims sectioned lists render on both platforms.** Measured: they do not, on any consumer account. `AGENTS-FIX-QUEUE.md` §4 calls this the most misleading line in the repo.
2. **`docs/VERIFICATION.md` §5.6 recommends an `editedMessage` wrapper for edits.** Measured: that form is a 15-byte no-op carrying no text. The correct form is `{ text, edit: key }`. The doc recommends the broken one.
3. **`AGENTS-FIX-QUEUE.md` §1a reports the flow-form parser as MISSING.** It was fixed; the verification record was never updated, so it now reports a closed bug as open.
4. **`docs/ARCHITECTURE.md` and `docs/FEATURES.md` still document an `adapters/` subsystem** deleted in `0ece183` — four session-store modules and ~1,472 lines, with live line-number citations into files that no longer exist.
5. **`createEdit`'s signature change is undocumented** in `CHANGELOG.md` despite being public surface with a silent-failure failure mode.
6. **Commit `357d0ba`'s message claims "verified against real files, not mocks."** True of the media work; misleading by proximity for the `sendList` half of the same commit, which remains unverified. Commit messages are documentation — fix it or append a correction.

Items 1–5 are doc-vs-measurement drift and are enumerated with exact line numbers in `AGENTS-FIX-QUEUE.md`. Item 6 is this session's own error.