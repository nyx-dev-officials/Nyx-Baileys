# PROJECT-CONTEXT — entry point

**Read this, then go to §1. Do not read the whole repo.**

Produced 2026-10-07 by `opencode` (space-bunny-free) → handed to **Freebuff**.

---

## 1. Where things are

| Document | Read it for |
|---|---|
| **`TRD.md`** | What the project must do. Every checkbox is a **measurement**, not an intention — `[x]` verified, `[ ]` not verified. Also lists 6 open contradictions in §9. |
| **`APP_FLOW.md`** | How a message moves through the system. Operator vs recipient; there are no screens. |
| **`IMPLEMENTATION_PLAN.md`** | Phase order. **Phase 1 is the highest-priority defect in the repo.** |
| **`TESTING.md`** | How we prove it works. Manual checks only the operator can run, with markers and pass/fail. |
| **`AGENTS-FIX-QUEUE.md`** | **Measured** hardware truth. Contradicts several docs — where they disagree, this wins. |
| `CONTEXT.md` | Historical archaeology + the traps table in §8. Counts in its early sections are history. |
| `docs/VERIFICATION.md` | Hardware evidence log. |
| `CHANGELOG.md` | Release history. |

---

## 2. The 60-second version

`C:/Nyx-Baileys` — a modular WhatsApp framework wrapping `@whiskeysockets/baileys` **rc14** without forking it. It decorates a live socket at runtime with an ordered plugin chain. The goal is **Flux**: that framework plus a WhatsApp-native AI agent with durable scoped memory, free-model inference, and a per-feature typographic identity.

```
npm run check                      clean
npm run build                      clean
npm test                           1288 pass / 0 fail
node scripts/check-exports.mjs     27 targets resolve
```

**Live account** `6283831459585`, session `C:/nyx-live-session`, test recipient `62882017467912`. Never commit `creds.json`.

---

## 3. Three things to know before you touch anything

**1. This platform reports success for messages it never delivers.** A clean message ID is not delivery. Verification means the operator confirms on their phone. Everything in `TESTING.md` follows from this.

**2. Compile-and-export is not verification.** Five functions returned well-formed success results for work they never did — `trimMedia` destroyed files, `compressImage` produced undecodable images, `sendList` threw on every call. All passed every test. When you add a function, ask what real file or real socket proves it works.

**3. Don't trust a comment or a commit message over a measured document.** The longest-running false lead in this repo was a commit message saying "verified against real files, not mocks" that was true for half its contents and misleading for the rest. `AGENTS-FIX-QUEUE.md` exists because the code did not.

---

## 4. Start here

→ **`IMPLEMENTATION_PLAN.md` Phase 1**: `sendList` routes to `single_select`, which **never arrives** on this consumer account. It needs a phone test, then almost certainly a flow-name change to `quick_reply`.

---

## 5. Standing boundaries

- Never `git stash`, delete, or move a user file without explicit permission.
- `src/plugins/Verified.ts` and `Hidden.ts` are user-authored; committed because tracked files import them.
- Keys live in `.env`, git-ignored. 🔴 **They were exposed in chat and in `C:/Users/bian/Downloads/NOX-API-KEYS.md` — rotate them.**
- `anti-delete` forwards every revoked group message to the owner's DM. **Do not change it without the user's explicit answer.**
- Be cumulative: update existing source rather than adding a parallel path; delete what a change made dead. Stale docs and dead helpers are defects.
- Out of scope: image-rendered fonts, WhatsApp native markup, new typography faces without asking, destructive group actions, a real auth layer.