# PROJECT CONTEXT — Nyx-Baileys

**Purpose:** the single entry point for anyone (human or agent) picking this repo up cold. Supersedes the removed `ANTIGRAVITY-HANDOFF.md` / `ANTIGRAVITY-MISSION.md`.

**Read order:** this file → `AGENTS-FIX-QUEUE.md` (measured hardware truth, contradicts several docs) → `CONTEXT.md` §8 (traps) → the task at hand. Do not read the rest of `CONTEXT.md` cold; most of it is archaeology and several counts in it are historical.

**Handoff:** produced 2026-10-07 by `opencode` (space-bunny-free) → handed to **Freebuff**.

---

## 1. What this project is

`C:/Nyx-Baileys` — a modular WhatsApp framework built **on top of** `@whiskeysockets/baileys` **rc14**. It does not fork Baileys. It decorates a live socket at runtime with an ordered plugin chain and returns a real Baileys socket.

- Remote `github.com/nyx-dev-officials/Nyx-Baileys` · branch `main` · version `0.3.1`
- `v0.3.1` tag → `9c2ce9e`, now **11 commits behind `main`**
- Node ≥ 20 (local: v24.19.0) · TypeScript strict · tests via `node:test`

### The goal

Turn it into **Flux**: a WhatsApp AI agent with WhatsApp-native tools, durable scoped memory, multimodal input, free-model AI, and a distinctive per-feature typographic identity. Not a fork, not a UI — the surface is the chat itself.

---

## 2. Current state — verified 2026-10-07

```
npm run check                      clean (tsc --noEmit, strict)
npm run build                      clean
npm test                           1288 pass / 0 fail
node scripts/check-exports.mjs     all 27 export targets resolve
```

Recent commits, all pushed except the last two:

```
0ce58b1 chore: drop the Antigravity handoff and mandate docs
3cdaae2 feat(media): compressVideo does real H.264 via ffmpeg
051aa2a fix: range() looped forever and exhausted memory on non-numeric input
357d0ba fix: three features that faked success, one of which corrupted media
9de46a9 docs: record the typography work, the two new traps, and §6.1 resolved
```

### Live account

| | |
|---|---|
| Own number | `6283831459585` (consumer tier) |
| Linked device | `6283831459585:12@s.whatsapp.net` · `10DDCU0FYA001NS` |
| Session dir | `C:/nyx-live-session` (`creds.json` + app-state sync) |
| Test recipient | `62882017467912@s.whatsapp.net` |

Never commit `creds.json` or anything under that directory.

---

## 3. 🔴 Highest-priority open issue — a commit I made is probably wrong

**`AGENTS-FIX-QUEUE.md` §5–6 measured, on this exact consumer account, that `single_select` never arrives.** The encoder accepts it, a valid message ID comes back, and the message never lands. The flow name that *does* work is `quick_reply`.

In `357d0ba` I "fixed" `sendList` by routing it to `sendCategoryMenu()`, which sends `single_select`. I verified it compiles, returns a relay ID, and that the payload no longer contains the rejected `listMessage` key. **I did not verify arrival — nobody did.** By the queue's own measurement, this path is dead on consumer accounts.

So `sendList` went from *definitely broken* (threw `Invalid media type`) to *plausibly broken* (routes to a flow the server strips). That is still progress and still not a working feature.

**First task for the next owner:** re-test `sendList` end-to-end on the phone. If it does not arrive, switch `sendCategoryMenu` to the `quick_reply` flow name and re-verify. Read `AGENTS-FIX-QUEUE.md` §6 first — it lists what has already been ruled out, so do not re-chase those.

---

## 4. Work queue, in priority order

### 4.1 Known-broken, fix first

| | |
|---|---|
| `sendList` → `single_select` | Probably never arrives on consumer accounts. See §3. |
| `compressAudio` | Still gzips the input to `.compressed.gz`. Not audio. Returns a plausible ratio. `ffmpeg` helper already exists in `media.ts`. |
| `optimizeForWhatsApp` | **Worst one.** Gzips the bytes, keeps the **original extension**, and returns `whatsappReady: true` with `mimeType: 'video/mp4'`. A file guaranteed to be rejected, certified ready. |

Both media functions have the same shape of fix already applied to `compressVideo` and `trimMedia`: real ffmpeg, `requireNonEmpty()`, no byte-level fallback.

### 4.2 Unverified, not known-broken

`src/features/` has **395 exports that compile and export but have largely never been executed.** Compilation is not evidence. Five fake-success defects were found by execution (§5); the rest is unproven.

The blocker is methodology, not effort: a generic sweep feeding garbage input cannot distinguish *"correctly rejected bad input"* from *"broken on valid input."* `auth`'s 20 "failures" were all correct crypto validation; `observability`'s 4 "hangs" were sampling functions legitimately sleeping.

Doing this properly needs **per-function fixtures derived from each signature** — one correct input per function, asserting the real result shape. That is the highest-value unstarted work in the repo.

### 4.3 Privacy — needs the user's decision, not a patch

`src/plugins/anti-delete.ts` forwards **every revoked message from every group** into `62882017467912`'s DM by default:

```ts
if (!options.forwardFrom) return true;   // was: return !jid.endsWith('@g.us')
```

That is a disclosure decision, not a retention one, and the original file said so. Do not "fix" it silently — raise it with the user and let them choose.

### 4.4 AI toolkit gaps

All in `src/toolkit/ai/`:

- **Vision is broken end-to-end.** `prepareForModel` returns `string | ContentPart[]` and `engine.ts` wraps it in `String(...)`, so a multimodal turn becomes `"[object Object]"`. The standalone helper passes its tests; the engine path was never exercised.
- `toneForContext()` exists but the engine never passes language/question/length context, so contextual tone collapses to one default.
- `DurableMemory` persists facts, **not transcripts.** Full context does not survive logout/unpair.
- `made by Nyx` footer is implemented but defaults **off**; the user asked for it on every reply.

### 4.5 Release

`v0.3.1` → `9c2ce9e`, eleven commits behind. Do not republish, move the tag, or cut `0.3.2` without asking.

---

## 5. Defects found by execution this session

Recorded because the pattern recurs and the tests never caught it.

| Defect | Why it hid |
|---|---|
| `sendList` sent `listMessage` | rc14's `generateWAMessage` has **no** `listMessage` branch. Green in every mock test — a fake socket accepts any object. |
| `trimMedia` byte-sliced an MP4 | Destroyed the file (box-structured container, `moov` often last) and returned a correct-looking `durationMs`. |
| `compressImage` gzipped an image | Output was not decodable; every consumer would reject it. Docstring called it a "stand-in". |
| `pinMessage` nested `pin` | rc14 wants `{ pin: <key>, type: n }` as **siblings**. Protobuf drops the wrong shape silently. |
| `searchMessages` / `getMessageInfo` | rc14 has no such APIs. Returned `{messages:[]}` and `null` — a caller cannot tell "unsupported" from "no matches". Now throw. |
| `range()` infinite loop | `i += step` does **string concatenation** given strings, so `range('hello','x')` walks `'hello1'`, `'hello12'`… forever, allocating as it goes. A *hang*, so it appeared as a suite that never finished, not a failure. |
| `isStyled()` missed 2 of 4 blocks | Small caps are IPA (U+0250–02AF), full-width is U+FF21–FF5A. Miss either and the face re-styles every pass, growing a glyph per call. |
| "italic" map held *script* codepoints | A terminal's fallback font renders both identically. Only codepoints are reliable. |

**The unifying lesson:** a fake socket proves argument order and never return shape, and a type check proves nothing about a runtime branch. Anything whose behaviour depends on a branch existing in `generateWAMessage`, or on a protobuf field name, must be exercised against real files or a real socket. `tests/rc14-surface.test.js` now checks every `sock.*` call against the installed package; `tests/media-real.test.js` uses real generated media.

---

## 6. Traps — do not re-litigate

Verified against hardware or the rc14 source. Full table in `CONTEXT.md` §8.

| Trap | Reality |
|---|---|
| **Phantom delivery** | This account drops sends. A clean message ID is **not** delivery. Always confirm on the phone. |
| **`rowId` vs `id`** | Wire field is `id` in the `single_select` JSON. `rowId` compiles, returns an ID, renders nothing. |
| **`pin` shape** | `{ pin: <key>, type: n }` — siblings. Nesting is dropped. |
| **`cta_copy`, not `copy_to_clipboard`** | The latter silently drops. |
| **Media buffer shape** | `{ image: buffer, mimetype, fileName }`. `{ image: { buffer } }` fails. |
| **`decryptMediaMessage`** | Does not exist. It is `downloadMediaMessage`. |
| **Native markup** | Single backticks are not monospace; it is triple. **Rejected for brand typography anyway** — Unicode variants only. |
| **Unicode "fonts"** | Four faces approved on hardware: small caps, bold, bold-italic, italic. Seven feature files, so three are separated by **tracking** (hair space U+200A). Never add gothic/fraktur. |

---

## 7. Typography — settled, do not relitigate

`src/features/typography.ts`. One signature face per feature file, opt-in per send via `featureFont`, **defaulting off** so user-authored text is never silently restyled.

| Feature | Face | Tracking |
|---|---|---|
| `analytics` | small caps | wide |
| `auth` | bold | wide |
| `groups` | bold | tight |
| `i18n` | italic | tight |
| `media` | italic | wide |
| `messaging` | bold-italic | tight |
| `observability` | small caps | tight |

**Labels take the face; values and routing keys stay ASCII.** A styled `rowId` or `buttonId` breaks reply matching, and only on device. Approved by the user as "10/10" after several rounds — two earlier rounds guessed wrong, so **do not swap faces without asking.**

Real font files (Exo Italic, Liberation Serif, Lobster, Zaslia) are unreachable in-text: WhatsApp has no font selection. They are only achievable by rendering to an image, which the user declined.

---

## 8. Conventions and boundaries

- **Never `git stash`, delete, or move a user file without explicit permission.** A stash round-trip on `Verified.ts` once cost a real outage of trust.
- `src/plugins/Verified.ts` and `Hidden.ts` are user-authored. Both are now committed because tracked files import them — excluding them breaks the build.
- A returned message ID is never proof of delivery.
- Never assert hardware behaviour from a passing unit test.
- **Be cumulative.** Update existing source rather than adding a parallel path; remove code that a change made dead. Stale docs and dead helpers are defects — the counts in this file and in `CONTEXT.md` should match `npm test` on every commit.
- Keys live in `C:/Nyx-Baileys/.env`, which is git-ignored. Never hardcode. **Keys were exposed in chat and in `C:/Users/bian/Downloads/NOX-API-KEYS.md` — rotate them.**
- Untracked and deliberately not committed: `probe-debug.mjs`, `probe-free.mjs`, `probe-raw.mjs` (scratch scripts that read `.env`).

---

## 9. Environment notes for the next owner

- `ffmpeg` **is** on PATH at `C:/Users/bian/bin/ffmpeg` (build `N-126889`). `sharp` with libvips 8.18.7 is a dependency. Both are used by `media.ts`.
- Live-test loop, no screenshots: **send a uniquely-marked message → the user looks at the phone → the user reports what arrived.** Markers used recently: `FD122327` (fonts), `VC123543` (verifiedSpoof control).
- The plugin chain, printed before trusting any result:
  ```
  stealth > verifiedSpoof > clock-sync > lid-router > media-stream > album >
  memory-gc > group-guard > session-repair > reconnect > anti-spam >
  delivery > flow > warmup
  ```
- `verifiedSpoof` is explicitly `enabled: true` in the default chain. It was suspected of suppressing its own messages for weeks; that is **disproven** (`CONTEXT.md` §6.1, marker `VC123543`). The symptom was this account's phantom delivery.
- Outbound pacing is a **2.5s floor plus clamped Box-Muller jitter** (2.5–6.5s, median ~4.5s). Jitter only ever widens the gap. Set `jitterMs: 0` for a flat cadence.