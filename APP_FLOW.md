# App Flow — Nyx-Baileys / Flux

> Document 2 of 4 (vibe-docs-guide sequence). Technical requirements: `TRD.md`. Order of work: `IMPLEMENTATION_PLAN.md`. Proof: `TESTING.md`.

---

## 0. Structural note — this is not a screen-based product

The template assumes one user navigating screens. This project has **two users and no screens**, and pretending otherwise would make the doc wrong:

| | **Operator** | **Recipient** |
|---|---|---|
| Who | you — runs the bot | anyone chatting with the bot |
| Surface | a terminal, a phone for verification | WhatsApp, and nothing else |
| "Screen" | command output | **a rendered WhatsApp message** |
| "Primary action" | run a command | send text / tap a button |

Everything below maps the template's *intent* onto the equivalent here: a "screen" is a rendered message, a "loading state" is a typing indicator, an "error state" is a message the recipient can act on. Sections the template provides that genuinely do not apply are marked as such rather than filled with filler.

**There is no empty-state copy rule for the recipient** — a chat has no empty state, and forcing one in produced the sort of decorative copy the design principles in this repo's own standards reject. §6 explains what takes its place.

---

## 1. Primary Journey — the AI turn

The core loop. Everything else is a variation.

```
[Recipient sends "flux what fruit should I buy?"]
  → [prefix parsed]           flux/flux:/legacy / all accepted
  → [context assembled]       session memory + scoped durable facts
  → [provider called]         free model first, fallback chain on failure
  → [model requests a tool]   e.g. sendPoll
  → [tool approved?]          mutating tools require explicit approval
  → [tool executes]           native WhatsApp structure sent
  → [model gets real result]  not a guess — the actual tool output
  → [final answer]            grounded, typed output
  → [footer]                  "made by Nyx" — currently OFF, user wants ON
```

**Release blocker for this journey:** a returned message ID is not delivery (§4.3).

---

## 2. Message Details

Every surface the bot can render. For each: purpose, required content, primary action, error behaviour.

### 2.1 Plain text reply

- **Purpose:** the default answer surface.
- **Content:** `{ text }`. No wrapper.
- **Primary action:** recipient replies.
- **Typography:** **none by default.** `featureFont` is opt-in; user-authored text is never silently restyled.
- **Error:** if the provider chain fails, say which providers failed and that it is retryable. **Never** a fabricated answer.

### 2.2 Poll — `sendPoll`

- **Purpose:** a forced choice, native WhatsApp UI.
- **Content:** `{ poll: { name, values, selectableCount } }`.
- **Typography:** `name` is a **label** → takes the feature face. `values` are the **data being voted on** → stay plain ASCII. Verified.
- **Primary action:** recipient votes.
- **Error:** `selectableCount` outside `0..values.length` throws — rc14 enforces this.
- **Risk:** poll results must route back to the sender. **Unverified.**

### 2.3 Menu — `sendList` → `single_select`

- **Purpose:** tap-to-open selection.
- **Content:** `nativeFlowMessage` button named `single_select`, payload an **opaque JSON string the client parses**.
- **Schema:** the key is **`id`**, not `rowId`. `WAProto`'s own `ListMessage.Row` uses `rowId`, but that message type is unreachable in rc14, and the schema inside the opaque string is the *client's*, not protobuf's.
- **Typography:** section titles and row titles are labels → face. Row `id` and `description` verbatim.
- **Primary action:** recipient taps a row; reply routes back on `id`.
- **Error:** the tap round-trip is **unverified**, and per `AGENTS-FIX-QUEUE.md` §5-6 the whole flow **never arrives on this consumer account**. Highest-priority defect. See `IMPLEMENTATION_PLAN.md` Phase 1.

### 2.4 Buttons — `sendButtons`

- **Purpose:** up to 3 quick replies.
- **Content:** `{ buttonsMessage: { text, buttons: [{ buttonId, buttonText: { displayText } }] } }`.
- **Typography:** `displayText` is a label → face. `buttonId` verbatim — **a styled buttonId breaks reply matching on device and no unit test would catch it.**
- **Primary action:** recipient taps.
- **Error:** unknown `buttonId` arriving back — **unhandled**, currently logged and dropped.

### 2.5 Contact card — `sendContact`

- **Purpose:** share a contact.
- **Content:** `{ contacts: { displayName, contacts: [{ vcard }] } }`.
- **Typography:** `displayName` takes the face; **the vcard stays verbatim** — it is parsed by the contacts app, not read as styled text.

### 2.6 Media — see §4.2

### 2.7 Owner identity reply

- **Purpose:** the recipient asks who built the bot.
- **Content:** one message, `+62 838-3145-9585`.
- **Behaviour:** single response, not a list.

---

## 3. Decision Points

- **If the provider fails →** retry, then walk the fallback chain. If the whole chain fails, tell the recipient. **Never** substitute a plausible answer.
- **If the free endpoint returns a transient outage →** detect it (30–100s windows observed), fail over rather than hang.
- **If a tool is mutating →** require explicit approval before executing.
- **If a memory write targets an unknown session →** hash to a safe path; refuse traversal.
- **If the account drops the send →** nothing is observable from the bot side. §4.3 is the only signal that exists.

---

## 4. Secondary Flows

### 4.1 Operator: live verification

```
[Write a marked test script] → [print plugin chain] → [send marked messages]
  → [USER looks at phone] → [user reports what arrived] → [update docs]
```

**The plugin chain must be printed before trusting any result.** A plugin that never registered makes every downstream conclusion wrong. See `TESTING.md` §3.

### 4.2 Operator: media pipeline

```
[input file] → [codec required?] → [yes: ffmpeg / libvips] → [verify non-empty] → [result]
                          → [no:  THROW]      ← deliberately, never a fallback
```

`compressAudio` and `optimizeForWhatsApp` currently **skip this flow** and gzip their inputs instead. Tracked in `IMPLEMENTATION_PLAN.md` Phase 2.

### 4.3 Recipient: what happens on a dropped send

```
[bot sends] → [server returns clean ID] → [??] → [message never arrives]
```

There is no on-device signal. The operator's phone check is the only detector. This is why `TESTING.md` forbids inferring delivery from a return value.

### 4.4 Recovery

- **Bot session invalid:** auto-reconnect with backoff. Not verified after a forced expiry.
- **ffmpeg missing:** throws with a clear message naming the caller and how to point at a binary. **No byte-level fallback** — a loud failure is recoverable, a corrupt file reported as success is not.
- **Free model outage:** fallback chain, then an honest failure message.

---

## 5. Important States

The template's list, mapped. These are where bugs live.

| State | In this product |
|---|---|
| Loading | typing indicator (`sendPresenceUpdate` — target JID **required** for composing/recording) |
| Empty | not applicable to chat — see §6 |
| Validation error | recipient input that fails prefix/intent parsing gets a usage line naming the accepted forms |
| Network error | provider chain failure must be stated honestly, never hidden |
| Domain error | ffmpeg missing; provider rate-limited; memory write refused |
| Saved | durable memory write is atomic (temp + rename) |
| Published | not applicable — nothing is published |

---

## 6. What replaces the empty-state copy rule

The template's rule is "what is empty, why, and the action that fills it." For the **recipient** there is no empty state.

For the **operator**, the equivalent is the console, and it is a real defect surface: the plugin chain and the send result must both be printed on every run, because an unregistered plugin or a dropped send are both invisible otherwise. That is exactly why the test harness mandates it.

---

## 7. Flows explicitly out of scope

- Screenshot-driven verification — **prohibited by the operator.** The loop is send-a-marker, user-looks, user-reports.
- Any UI outside WhatsApp.
- Rendering text to images to achieve real font files — offered once and declined.