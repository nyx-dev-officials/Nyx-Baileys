# Phone numbers in play

Every number that appears in this tree and in `C:/Users/bian/whatsapp-bot`, what it
is, where it lives, and whether it is real. Six of them matter; the rest are
fixtures.

Checked on 2026-10-09.

---

## Owner numbers

The two owners are declared in the bot project's config, not in `.env`:

`C:/Users/bian/whatsapp-bot/config.json` → `ownerPhones`

```json
"ownerPhones": ["62882017467912", "6288905164526"]
```

| Number | Who | Notes |
|---|---|---|
| `62882017467912` | Owner 1 — the personal number | Also the nyx test recipient. |
| `6288905164526` | Owner 2 — the bot number | The `EVENT HORIZON` account; `whatsapp-bot/.env` `PHONE=6288905164526`. |

Owner checks read `config.ownerPhones` first and fall back to `config.ownerPhone`
if the list is absent — see `commands/owner.js:13`, `commands/utility.js:261`,
`lib/acl.js:52`, `lib/utils.js:51`, `index.js:279`.

**In nyx-baileys there is no owner number configured.** `owners` is an option
(`src/plugins/commands.ts:115`), and every value shipped in this tree is a
placeholder:

- [examples/bot/config.mjs](examples/bot/config.mjs#L17) — `OWNERS` env, default `15551234567`
- [README.md](README.md#L250), [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md#L444) — same placeholder in examples

To make `/` commands owner-gated here, set `OWNERS=62882017467912,6288905164526`
in the environment before starting the example bot. Nothing in the repo needs
editing to do that.

---

## Live account

| Number | Role | Where |
|---|---|---|
| `6283831459585` | Own number of the paired test account | `C:/nyx-live-session` |
| `6283831459585:12` | The linked device (session `:12`) | `C:/nyx-live-session/creds.json` |
| `62882017467912` | Test recipient | used in `src/cli/commands.ts:1689`, the probes, and live sends |

The session directory is **outside the repo on purpose** — `C:/nyx-live-session`.
Never copy it in, never commit `creds.json`. `.gitignore` covers `session/`,
`sessions/` and `creds.json` in case one lands in the working tree by accident.

`C:/Users/bian/whatsapp-bot/{auth,auth_info}` were **dead** — a live probe on
2026-10-09 got `statusCode 401`, so both were moved to
`*.dead-20261009/` rather than deleted. Re-pair before that bot will connect.

---

## Placeholders and fixtures — not real numbers

| Number | What it is | Where |
|---|---|---|
| `15551234567` | Placeholder owner used in every example | [examples/bot/config.mjs](examples/bot/config.mjs#L17), [README.md](README.md#L250), [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md#L126) |
| `628999000111` | Fake group member in `selftest` | [src/cli/commands.ts](src/cli/commands.ts#L1544) |
| `15550001111`, `15559999999`, `15559998888`, `15559876543` | Doc fixtures | various |
| `628123456789`, `628000000000`, `620000000000000` | Doc fixtures | various |

None of these should ever be treated as a live contact, and none should be
"fixed" to a real number. `tests/feature-menu.test.js` asserts the reference
repo's author number and URL never ship as defaults; the same reasoning applies
here.

---

## One malformed number, to fix

[README.md:43](README.md#L43):

```
npx nyx-baileys pair --dir ./session --phone 628334549585
```

That is 12 digits and is not a valid number — it is a typo for
`6283831459585` (dropped `8`, transposed `83`→`33`). Every other occurrence in
this tree spells it correctly: `src/cli/commands.ts:615` and `:663`,
[docs/HOW-IT-WORKS.md:91](docs/HOW-IT-WORKS.md#L91), `CONTEXT.md`.

Reusing that README line verbatim costs a connect attempt, and WhatsApp counts
failed handshakes against a number.
