# Anti-ban module set

> **Read this before enabling anything here.** These modules are not reliability
> features. They exist to make automated WhatsApp activity look less like
> automation, in order to reduce the chance an account is limited or banned.
> That is a deliberate capability with real consequences — for the account, and
> for anyone on the other end. Every module below is **off by default and not in
> the default plugin chain**; nothing here runs unless you turn it on.

## Why this exists

The reference forks under `refs/` implement a large "anti-ban" surface. Earlier
releases of Nyx-Baileys declined it. This module set ports the mechanical parts
so the decision is yours and explicit, rather than hidden behind a dependency.

Two things stay true:

- **Nothing is wired into `NyxBaileys`'s default chain.** `plugins()` returns the
  thirteen observability/behaviour plugins and none of these.
- **Every engine defaults to `enabled: false`.** A plugin factory you call still
  produces a disabled engine unless you opt in, and the plugin pack logs a
  warning when an engine starts.

The most aggressive knob — content variation that inserts invisible characters,
and device-fingerprint variation — is the kind of thing that changes what your
messages and your client *are*. Treat enabling it as a product decision.

## What is here

| Module | File | What it does |
|---|---|---|
| Presence choreography | `src/antiban/circadian.ts` | Circadian activity curve, distraction and offline gaps, a Gaussian WPM typing model, jittered read receipts |
| Human entropy | `src/antiban/entropy.ts` | Background typing / delayed read / presence activity on a long timer, against contacts who messaged first |
| Content variation | `src/antiban/imperfection.ts` | Zero-width characters, punctuation variation, optional synonyms |
| Legitimacy signals | `src/antiban/imperfection.ts` | QWERTY typos plus corrections, mid-typing pauses |
| Read-receipt variance | `src/antiban/imperfection.ts` | Gaussian-jittered delay before `readMessages` |
| Device fingerprint | `src/antiban/fingerprint.ts` | Deterministic per-session `appVersion` / OS / device model |
| Egress rotation | `src/antiban/rotation.ts` | Round-robin / random / weighted / sticky proxy selection with quarantine |
| Presets | `src/antiban/presets.ts` | Named pacing+warm-up postures |

## Opt-in plugins

```ts
import { createNyxBaileys, presenceChoreography, contentVariation } from 'nyx-baileys';

const client = createNyxBaileys({ sessionDir: './session' });
client.registerPlugin(presenceChoreography({ enabled: true }));
client.registerPlugin(contentVariation({ synonyms: true }));
await client.connect();
```

Each factory attaches its engine to the socket non-enumerably and registers an
undo, so `client.dispose()` unwinds it like any other patch:

- `sock.choreographer` — `PresenceChoreographer`
- `sock.variator` — `ContentVariator`
- `sock.legitimacy` — `LegitimacySignalInjector`
- `sock.entropy` — `HumanEntropy`

`antibanPlugins()` returns all five in ascending order if you want the pack.

## Using the engines directly

The engines are pure and testable; you do not have to use the plugins. For
example, to build and run a typing plan by hand:

```ts
import { PresenceChoreographer } from 'nyx-baileys';

const choreo = new PresenceChoreographer({ enabled: true });
const plan = choreo.computeTypingPlan(text.length);
await choreo.executeTypingPlan(sock, jid, plan);
await sock.sendMessage(jid, { text });
```

## What is deliberately not ported

Some modules in the reference forks are not here even as opt-in, because their
only function is to fabricate interactions that never happened — reply-ratio and
reputation "gaming", and a contact-graph enforcer that decides *who* you are
allowed to message. Those cross from "look less robotic" into "manufacture a
history", and the framework will not do that for you. See
[`REF-FINDINGS.md`](./REF-FINDINGS.md) §9.

## The honest caveats

- **None of this is verified against a live ban-detection system**, because none
  is available to test against. The mechanics are unit-tested; the *effectiveness*
  is not, and cannot honestly be claimed.
- **Anti-ban tuning is not a substitute for not spamming.** The single most
  effective way to avoid a ban is to send messages people want to receive.
- **The timers are long and unref'd.** Human entropy will not hold your process
  open, and a short-lived process will not run a cycle.
