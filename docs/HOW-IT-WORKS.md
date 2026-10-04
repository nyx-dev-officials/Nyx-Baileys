# HOW IT WORKS — "I want X, the code is Y"

Task-oriented. Every entry starts from something you want to do, not from a module
name, and points at the code that does it.

`FEATURES.md` answers *what exists*. This answers *how you use it*.

Citations are `file:line` against the tree at commit `5d041e6` plus this branch.

---

## Read the status column first

**Not everything here has been run.** This document was written by reading source,
and in a few places the source was read rather than the code exercised. The table
below is the honest state of each area. Where a row says *unit-tested*, that means
a `node:test` suite covers it against a fake socket — **not** that it has talked to
WhatsApp.

| Area | Unit-tested | Run against live WhatsApp |
|---|---|---|
| Connection, login, session persistence | yes | **yes** — paired account, `state: open` |
| Plain text send | yes | **yes** — delivered to a group, confirmed by phone screenshot |
| `moderation` word/link/flood rules | yes | **no** — group-only and destructive; needs a throwaway group |
| `welcome` | yes | **no** |
| `withRetry` / backoff | yes | yes (indirectly) |
| JID, text, format, validation, security, stores | yes | n/a — pure code |
| **Buttons / list / template / native flow** | serialisation only | **no — rc14 cannot send these at all** |
| **Newsletters** | **no dedicated suite** | **no** |
| **`stealth`, `metrics`, `webhook`, `call-log`, `read-receipts`, `send-presence`, `anti-delete`** | **no** | **no** |
| Polls, reactions, status, albums, media, presence | yes | **no** |

Prefer to trust a row over a paragraph. Where this document is confidently wrong,
it will be wrong in the direction of "this works" — because that is what reading
source tells you.

---

## Contents

- [Connect and pair](#connect-and-pair)
- [Send](#send)
- [Buttons and interactive layouts](#buttons-and-interactive-layouts) ← **read this one**
- [Moderate a group](#moderate-a-group)
- [Announce joins](#announce-joins)
- [Build a command bot](#build-a-command-bot)
- [Reactions, polls, status](#reactions-polls-status)
- [Albums and media](#albums-and-media)
- [Presence and read state](#presence-and-read-state)
- [Newsletters](#newsletters)
- [Sessions and persistence](#sessions-and-persistence)
- [Run several numbers](#run-several-numbers)
- [Security](#security)
- [Pace yourself](#pace-yourself)
- [Operate it](#operate-it)

---

## Connect and pair

**I want a socket.**

```ts
import { createNyxBaileys } from 'nyx-baileys';

const client = createNyxBaileys({ sessionDir: './session' });
await client.connect();          // real WASocket, 13 plugins applied
const sock = client.sock;        // every Baileys API still works
```

**`connect()` resolving does not mean the socket is open.** It resolves once the
plugins are applied. On an **unregistered** session `connection === 'open'` never
arrives at all — auth has not completed, so there is nothing to be open *to*. Wait
for a `connection.update` carrying a **`qr`**, not for `open`:

```ts
await new Promise((resolve) => {
  const off = sock.ev.on('connection.update', (u) => {
    if (u.connection === 'open' || u.qr) { off(); resolve(); }
  });
});
```

Attach the listener in the same tick you would read the ref from it. The first `qr`
arrives *in the very event that satisfies readiness*, so a capture listener
attached after the `await` sees nothing.

**I want to pair from the command line.**

```bash
npx nyx-baileys pair --dir ./session --phone 6283831459585
```

The 8-character code has to be requested explicitly — rc14 emits a QR ref and
never volunteers a code. `--phone` is validated **before** the socket opens, so a
typo costs no connection attempt.

**I want to clean up a session that will not pair.** A `creds.json` holding
handshake material but no `registered` flag cannot be resumed; WhatsApp refuses it
with 401 on every connect. `pair` detects this before connecting and names the fix:

```bash
npx nyx-baileys pair --dir ./session --reset
```

**I want to know whether a session is paired.** Read the *provisioning evidence*,
not the flag. `registered` has exactly one assignment in all of rc14
(`messages-recv.js:940`, the `companion_finish` branch) and that notification does
not arrive here, so a fully working device reads `registered: false`:

```ts
const paired =
  creds.registered === true ||
  Boolean(creds.me?.id && creds.account?.deviceSignature);
```

That is exactly what `isProvisioned()` in `src/cli/commands.ts` does.

---

## Send

**I want to send text.** The only path that reliably delivers.

```ts
await sock.sendMessage('15551234567@s.whatsapp.net', { text: 'hello' });
await sock.sendMessage('120363000000000000@g.us', { text: 'to the group' });
```

**I want to send to a bare phone number.** Convert it first. The lid router passes
non-jid input through unchanged, so raw digits reach `sendMessage`, whose
`jidDecode` returns `undefined` — surfacing as
`Cannot destructure property 'user' of 'jidDecode(...)'`, naming neither the number
nor the cause.

```ts
import { toRecipientJid } from 'nyx-baileys';   // src/cli/commands.ts
await sock.sendMessage(toRecipientJid('+62 882-0174-67912'), { text: 'hi' });
```

**I want to know if a send worked.** Do not trust the returned message ID. See the
next section — an ID is not evidence of delivery.

---

## Buttons and interactive layouts

**Read this before building anything with buttons.** This is the one place where
the honest answer is "rc14 cannot do this".

**What rc14 accepts** — `generateWAMessageContent`
(`@whiskeysockets/baileys/lib/Utils/messages.js:273`) is an if/else chain over the
content keys it knows, and its **final `else`** calls `prepareWAMessageMedia`,
which throws `Boom: Invalid media type` for anything unrecognised:

| Content key | Status on rc14 |
|---|---|
| `text` | works |
| `image` · `video` · `audio` · `document` · `sticker` | works |
| `poll` · `album` · `contacts` · `location` · `react` | works |
| `listReply` · `event` · `pin` · `buttonReply` | works |
| **`listMessage`** | **throws `Invalid media type`** |
| **`buttonsMessage`** | **throws `Invalid media type`** |
| **`templateMessage`** | **throws `Invalid media type`** |
| **`interactiveMessage`** | **throws `Invalid media type`** |

**The workaround that does not work.** `sendMessage` ends by calling
`relayMessage`, which *is* public, and `generateWAMessageFromContent` skips the
broken chain. Build the inner message, wrap it, relay it — and it **returns a
plausible message ID, resolves without error, and delivers nothing**:

| Path | Returned | Arrived on a real phone |
|---|---|---|
| `sendMessage({ text })` | `3EB0401B6488…` | **yes** |
| `generateWAMessageFromContent` + `relayMessage` | `3EB071D7B219…` | no |
| same, `useCachedGroupMetadata: false` | `3EB0207FFE76…` | no |
| same, an actual `listMessage` | `3EB0250BE977…` | no |

Three phantom "successes" were reported from return values before a phone
screenshot disproved them. **A returned message ID is not evidence of delivery.**

**What this repo still gives you.** The builders serialise correctly — the proto
shapes are right, only the delivery path is missing:

```ts
import { createFormFlow, createTableFlow, createCarouselFlow, radioRow, infoRow } from 'nyx-baileys';

const form = createFormFlow({
  title: 'Deploy',
  body: 'Pick a target',
  ctaLabel: 'Submit',
  sections: [{
    title: 'Target',
    highlightLabel: 'REQUIRED',
    rows: [
      radioRow('Vercel', 'vercel', 'Serverless'),   // selectable
      infoRow('Pacing', 'Jittered queue'),           // read-only
    ],
  }],
});
```

| Builder | Produces | File |
|---|---|---|
| `createFormFlow` | `InteractiveMessage.NativeFlowMessage` with radio + info rows | `core/nodes.ts:151` |
| `createTableFlow` | table flow — takes `columns: string[]`, `rows: string[][]` | `core/nodes.ts:185` |
| `createCarouselFlow` | swipeable cards | `core/nodes.ts:162` |
| `carouselCardWithMedia` | a carousel card carrying media | `core/nodes.ts:214` |
| `createAlbumContainer` | album parent for N media | `core/nodes.ts:251` |
| `createEdit` | an edit wrapper | `core/nodes.ts:271` |

`nyx-baileys form` now **fails with an accurate message** rather than surfacing a
Boom that names neither cause nor workaround.

**If you need the proto shapes anyway** — read them, do not guess them. From
`WAProto/WAProto.proto`:

```ts
// Quick replies. This Button has NO url or call variant — its `type` enum is
// only UNKNOWN / RESPONSE / NATIVE_FLOW.
proto.Message.ButtonsMessage.create({
  headerText: 'Quick Reply',
  contentText: 'Tap one',
  buttons: [{ buttonId: 'ping', buttonText: { displayText: 'Ping' } }],
});

// URL + call + quick reply in one row. Plain strings, unlike TemplateButton.
proto.Message.TemplateMessage.create({
  hydratedFourRowTemplate: proto.Message.TemplateMessage.HydratedFourRowTemplate.create({
    hydratedTitleText: 'Actions',
    hydratedContentText: 'Pick one',
    hydratedButtons: [
      { index: 0, hydratedCallButton:  { displayText: 'Call', phoneNumber: '62882017467912' } },
      { index: 1, hydratedURLButton:   { displayText: 'Open', url: 'https://example.com' } },
      { index: 2, hydratedQuickReplyButton: { displayText: 'Ping', id: 'ping' } },
    ],
  }),
});
```

**Consumer vs Business.** This is independent of the blocker above, and it matters
even once sending is fixed:

| Type | Consumer WhatsApp | WhatsApp Business |
|---|---|---|
| `listMessage` | renders | renders |
| `buttonsMessage` (quick reply) | renders | renders |
| `templateMessage` / hydrated | **no** | renders |
| `nativeFlowMessage` (flows) | **no** | renders |

So "it shows on web but not on mobile" has **two** independent causes, and only one
is a code problem.

**The fix, if you want it.** This framework decorates the socket at runtime and
never edits `node_modules`, so the intended route is a plugin that patches
`sock.sendMessage`: detect an unrecognised content key, build with
`generateWAMessageFromContent`, then **mirror `sendMessage`'s tail** rather than
calling `relayMessage` directly. The open question is precisely which part of that
tail `relayMessage` alone is missing.

---

## Moderate a group

**I want to stop spam in a group.** `moderation` is **opt-in** — it is not in the
default chain, because who gets removed from a group is the operator's decision,
not the library's.

```ts
import { moderation } from 'nyx-baileys/plugins';

client.registerPlugin(moderation({
  words: [{ pattern: ['free crypto', /wa\.me\/[a-z0-9]+/i] }],
  links: { blockInvite: true, allowDomains: ['example.com'] },
  flood: { max: 6, windowMs: 8_000 },
  strikes: { deleteAt: 1, muteAt: 3, kickAt: 5, banAt: 8, decayMs: 86_400_000 },
  exempt: (jid) => owners.has(jid),
  isAdmin: (jid) => admins.has(jid),
}));
```

The ladder is **data**. Every threshold is configuration, and `Infinity` means
genuinely off, so a stage you did not configure is unreachable.

| Field | Default | At this strike |
|---|---|---|
| `deleteAt` | `1` | deletes the message for everyone |
| `muteAt` | `Infinity` | sets `isMuted()` — advisory, see below |
| `kickAt` | `Infinity` | removes the member |
| `banAt` | `Infinity` | removes them, and re-removes on re-entry |
| `announceAt` | `Infinity` | posts the outcome into the group |
| `decayMs` | `86400000` | one strike forgiven after this much quiet |

**Three things that are not bugs and will otherwise cost you an afternoon:**

1. **A mute is advisory.** WhatsApp has no server-side per-member mute — a group
   admin can remove someone, and removal *is* the ban. There is no read-only
   participant and no shadow ban. So `mute` sets `isMuted()` and you gate your own
   handler on it:

   ```ts
   if (sock.__moderation.isMuted(groupId, sender)) return;
   ```

   And the plugin **keeps evaluating** a muted member — that is the whole reason
   the ladder works. Returning early on a mute makes `muteAt` a permanent ceiling,
   so `kickAt` above it is unreachable and the member is warned forever.

2. **Every message over the flood ceiling is its own offence.** The rule does not
   clear its window on trigger. With `max: 3` and 8 rapid messages you get 5
   offences and strikes `[1,2,3,4,5]`.

3. **Exemptions default to nobody and are silent.** `isAdmin` defaults to
   `() => false`, not to "everyone who looks like an admin" — a default that let
   any member's spam-mod kick the human running the bot is the outage this design
   exists to prevent. Pass `exempt` and `isAdmin` explicitly. They are checked
   before any counter is touched *and again on the action path*, so a member
   promoted to admin between two strikes is not removed by the second.

**I want to tune it without touching anything.** `dryRun: true` records state and
reports decisions but skips the network call — it can tell you who it *would* have
banned, which is the only reason to run one.

**I want to react to decisions.**

```ts
sock.ev.on('nyx.moderation', (e) => {
  // e.kind is the OUTCOME, not the rule that fired.
  // A word hit at kickAt: 3 emits kind: 'kick'; the rule is in e.reason.
  console.log(e.groupId, e.kind, e.jid, e.strikes, e.reason);
});
```

**I want to act manually.** `sock.__moderation` exposes `isMuted`, `isBanned`,
`strikesOf`, `mute`, `unmute`, `kick`, `ban`, `unban`, `stats()`, `reset()`.
`kick`/`ban` are no-ops on an exempt or admin member.

**Deletion is a send.** `delete: { key, force: true }` goes back through
`sendMessage`, so it passes the anti-spam queue. That ordering is deliberate — a
bot that can delete at full speed is itself a spam primitive — but under heavy
pacing a delete can lag the message it removes.

---

## Announce joins

```ts
import { welcome } from 'nyx-baileys/plugins';

client.registerPlugin(welcome({
  templates: { add: 'Welcome, {name}.' },
  cooldownMs: 10_000,
  maxPerEvent: 1,
}));
```

Emits `nyx.welcome` with `{ groupId, text, mentioned }`.
Snapshot via `sock.__welcome.snapshot()`.

| Field | Default | Meaning |
|---|---|---|
| `useNames` | `false` | resolve `{name}` via `nameOf` rather than the jid's local part |
| `mention` | `'participant'` | `'none' \| 'participant' \| 'all'` |
| `cooldownMs` | `10000` | minimum gap between announcements in one group |
| `maxPerEvent` | `1` | collapse a larger event into one bundled line; `0` announces nothing |
| `events` | add/remove/promote on, **demote off** | per-event switches |
| `rejoinWindowMs` | `300000` | skip a participant seen this recently |
| `dryRun` | `false` | decide and report, send nothing |

Two defaults worth knowing: a template does **not** enable its event
(`events.demote` stays false even if you supply a demote template), and names are
off by default because `pushName` is whatever the sender typed and can be a
multi-kilobyte string of arbitrary content.

`mention: 'all'` exists and is deliberately not the default — tagging every member
on every join is a group-wide notification each time someone arrives.

---

## Build a command bot

```ts
import { createNyxBot } from 'nyx-baileys';

const bot = await createNyxBot({
  sessionDir: './session',
  owners: ['15551234567'],
  commandsDir: './commands',
});
```

Drops in `/menu`, `/ping`, and every module in `./commands`. Guarded by owner and
admin checks, cooldowns, and scoping; each handler is fire-and-forget, so dispatch
is async.

Or register commands yourself — `src/plugins/commands.ts:195`:

```ts
sock.commands.register({ name: 'ping', handler: (c) => c.reply('pong') });
sock.commands.register({ name: 'sum', aliases: ['s'], handler: (c) => c.reply('…') });
sock.commands.help();  sock.commands.categories();
```

Helpers: `tokenize` (quote-aware), `toUser` (number or jid → bare user id).

---

## Reactions, polls, status

All opt-in; all attached as non-enumerable socket helpers.

```ts
// reactions
sock.react(key, '👍');  sock.unreact(key);  sock.reactionsOf(key);

// polls
const poll = await sock.createPoll({ name: 'lunch?', values: ['a','b'], selectableCount: 1 });
sock.votePoll(key, 'a');  sock.pollResults(key);  sock.closePoll(key);  sock.listPolls();

// status
sock.statuses;  sock.getStatus(author);  sock.statusByAuthor();  sock.statusStats();
```

Files: `plugins/reaction.ts:79`, `plugins/poll.ts:199`, `plugins/status.ts:94`.

---

## Albums and media

```ts
const ids = await sock.sendAlbum('120363000000000000@g.us', [buf1, buf2, buf3]);
await sock.waitForAlbum(ids);        // resolves once every part has arrived
sock.expandAlbum(key);               // the inbound direction
```

`plugins/album.ts:62`. rc14 delivers album participants as `GroupParticipant`
objects, and the linkage bug there (D1) is fixed — see `VERIFICATION.md`.

**Streaming**, `plugins/media-stream.ts` — a true `stream` path, not a buffer:

```ts
await sock.downloadMedia(message, 'out.mp4');   // size-capped
sock.streamMedia(message, writable, { maxBytes });
```

---

## Presence and read state

```ts
sock.setPresence('available');            // send-presence
sock.presenceOf(jid);                     // presence
sock.markRead(jid);  sock.bulkRead(jids); sock.deferRead(jid, 60);
sock.readReceiptKeys();  sock.receiptSnapshot();
sock.revoked(key);                        // anti-delete
```

---

## Newsletters

**Untested and unverified.** Read the status table above. The plugin delegates to
upstream's purpose-built newsletter methods, which are dedicated protocol nodes
rather than entries in the broken send-content chain — so unlike buttons and flows
they are *not* blocked by `Invalid media type`. That is an inference from reading
rc14's typings, not an observation.

```ts
await sock.newsletterFollow(jid);
sock.newsletterMetadata(jid);
sock.newsletterReact(jid, serverId, emoji);
sock.newsletterSubscriberCount(jid);
sock.newsletterParticipantEvents(jid, handler);
```

`plugins/newsletter.ts:99`. Two identity shapes matter and are easy to confuse:
`id` is the newsletter's own jid and identifies the channel; `server_id` identifies
one post inside it. They live in different namespaces and are **not**
interchangeable, so reactions and views are keyed by the pair.

Because there is no test suite here, treat this section as a map of what exists —
not a claim that it works.

---

## Sessions and persistence

```ts
import { FileSessionStore, MemorySessionStore, createSessionStore } from 'nyx-baileys';

const client = createNyxBaileys({
  sessionDir: './session',                       // FileSessionStore by default
  sessionStore: new SqliteSessionStore({ /* … */ }),
});
```

Also shipped: `MongoSessionStore`, `PrismaSessionStore`, `RedisSessionStore`, and
`createSessionStore({ load, save })` for anything else —
`core/session-store.ts:128`.

**One durability rule worth knowing.** Credentials are persisted with an async
`writeFile`, which truncates before it writes. `NyxBaileys` serialises those saves
and `dispose()` awaits the last one, so a clean shutdown cannot leave `creds.json`
at 0 bytes — but if you `process.exit()` with a save in flight you will destroy the
session, and an empty file reads back as "fresh, unpaired", so the next run
silently starts pairing from scratch. **Let `dispose()` finish.**

---

## Run several numbers

```ts
import { SessionManager } from 'nyx-baileys';
```

`multi/session-manager.ts` — one process, N accounts, isolated state per session.

---

## Security

```ts
import { accessControl, redact, redactText, redactJson, auditSink, injectionGuard, validationGate } from 'nyx-baileys';
```

| Tool | What it does |
|---|---|
| `redactJson(value, { extraKeys })` | masks whole values by key name |
| `redactText(text, options)` | masks secret **shapes inside prose** |
| `accessControl()` | grant / deny with `describeGrant` |
| `auditSink()` | structured audit trail |
| `injectionGuard()` | screens untrusted payloads |
| `validationGate()` | **returns a plugin**, order 8 |

`redactText` and `redact` are complements, not alternatives — asking `redactText`
to mask `{"me": "…"}` is a category error, not a leak. `redactionGuard()` composes
them, and `redactingLogger()` is usually the right entry point because the sites
that forget to redact are precisely the ones nobody reviews.

---

## Pace yourself

**This is the one that looks like a bug and is not.** The warm-up ramp is
`1 + 7·(1−progress)²`, so a **freshly paired number waits 8× the configured gap —
20–51 s between messages.** Every send looks like it silently failed. It has not.

```ts
createNyxBaileys({
  warmupDays: 0,                                        // no ramp
  antiSpam: { minGapMs: 250, jitterMs: 100, maxPerMinute: 60 },
});
```

`antiSpam` enforces the gap with a Box–Muller draw, and throws `BurstCeilingError`
past `maxPerMinute` in a sliding 60 s window. `sock.__antispam.stats()` reports
`{ queued, sent, pressure }` — `pressure` is the warm-up multiplier.

---

## Operate it

**The CLI.**

```bash
npx nyx-baileys pair    --dir ./session --phone <number>
npx nyx-baileys status  --dir ./session
npx nyx-baileys selftest --dir ./session            # sends nothing unless asked
npx nyx-baileys send    <jid> "text" --dir ./session
npx nyx-baileys health  --dir ./session
npx nyx-baileys sessions list
```

`selftest` verifies the engine against a live session and **sends nothing unless
`--send` (one message to Note to Self) or `--group`**. Each check declares how it
was verified — `read`, `synthetic` (a fabricated event into the *real* socket
emitter, so the genuine plugin runs with the wire untouched), or `local`.

Exit codes: `0` ok · `1` usage · `2` connection/session failure · `3` not paired ·
`130` interrupted.

**Health.**

```ts
sock.health();   // { level, signals: { ok, rateLimited, dead, server }, since }
```

`reconnect` handles `restartRequired` and transient closes, and stops on a real
logout — no retry can fix that one.

**Metrics.** `sock.metrics` (opt-in plugin, order 110) counts by phase.

---

## Where things are

| Concern | File |
|---|---|
| Interception primitive | `core/intercept.ts` — `patch`, `patchAll`, `Disposables` |
| Socket construction | `core/socket.ts` |
| Plugin chain | `nyxBaileys.ts` |
| Message builders | `core/nodes.ts` |
| JID / mention handling | `core/mention.ts`, `core/media.ts` |
| Retry & backoff | `utils/queue.ts` |
| Logging | `utils/logger.ts` |
| CLI | `cli/commands.ts`, `cli/args.ts`, `cli/output.ts` |

Full detail: [`ARCHITECTURE.md`](./ARCHITECTURE.md) ·
[`PLUGIN-API.md`](./PLUGIN-API.md) · [`FEATURES.md`](./FEATURES.md) ·
[`VERIFICATION.md`](./VERIFICATION.md)
