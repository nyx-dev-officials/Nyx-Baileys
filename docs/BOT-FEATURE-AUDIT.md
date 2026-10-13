# Bot feature audit — `SC-BOT-WA`

Ten third-party WhatsApp bot archives were read to answer one question: what do
the bots people actually run **do**, and which of those things does this library
not do yet?

This is the record of that pass. It exists because the archive folder is outside
the repository and the count below cannot be reproduced from a clean checkout —
but the decisions taken from it are in `src/`, and a decision needs its evidence
written down next to it.

## Method

| Archive | Size | Main file that holds the dispatch |
|---|---|---|
| `ELAINA-AI_BUTTON_FIX_V6.4` | 10.6 MB | `plugins/*.js` (per-plugin) |
| `ELAINA-AI_FIX_V11` | 10.4 MB | `plugins/*.js` (per-plugin) |
| `cheemsbot14beta` | 2.6 MB | `XeonCheems14.js` (1.1 MB) |
| `Yuan_[ENC]` | 1.6 MB | `app/case.js` |
| `Zyee_Kull_Multi_Device` | 5.3 MB | `Bangzyee.js` |
| `xbug6` | 2.8 MB | `69/xeontext*.js` |
| `xcfukupikz3` | 5.2 MB | `XeonCheems10.js` |
| `RIOO_XDZZ_V1` | 0.8 MB | `Xzyroo.js` |
| `KoyDev v2` | 1.7 MB | `koy.js` |
| `FREE` (Kyuu) | 1.1 MB | `lib/bug/*.js` |

Each archive was extracted, every `.js` over 15 KB was scanned for `case '…'`
labels, the labels were lowercased and de-duplicated **per archive**, and then
counted across archives. One archive (`xbug6`) contains **284** distinct command
labels on its own — this is the scale of what these bots ship.

Counting across archives rather than tallying total occurrences matters: a label
present in eight of ten bots is a feature users expect; a label that appears
eighty times in one file is one bot being verbose.

## What was counted, and what it became

| Command in the archives | Bots | Status here |
|---|---|---|
| `welcome` | 8 | Already present — `plugins/welcome.ts` |
| `sticker` | 7 | Added for real — `toolkit/media-forge.ts` `toSticker` |
| `autoread` | 7 | Added — `createAutoPresence` |
| `antilink` | 7 | Already present — `plugins/moderation.ts`, `plugins/antiSpam.ts` |
| `toimg` / `toimage` | 6 | Added for real — `toImage` (ffmpeg) |
| `swm` (sticker watermark) | 6 | Added — `sendWatermarkedSticker` |
| `hidetag` | 6 | Added — `hiddenTag`, `visibleTag` |
| `tomp3` | 5 | Added for real — `toMp3` (ffmpeg) |
| `reverse` | 5 | Added — `utils/fancy-text.ts` |
| `tts` | 4 | Added — `textToSpeech` |
| `tovn` | 4 | Added for real — `toVoiceNote` (Opus in OGG) |
| `tovideo` | 4 | Added for real — `toVideo` |
| `emojimix` | 4 | Added — `emojiMixUrl`, `sendEmojiMix` |
| `antispam` | 4 | Already present — `plugins/antiSpam.ts` |
| `afk` | 4 | Added — `createAfkStore`, `afkNotice` |
| `fliptext` | 3 | Added — `flip` / `unflip`, now a true inverse pair |
| `antidelete` | 3 | Already present — `plugins/anti-delete.ts` |
| `translate` | 2 | Added — `translateText` |
| `qc` (quote card) | 2 | Added — `quoteCardSvg` (SVG, no image library) |
| `autotyping`, `autorecording` | 1 each | Added — `createAutoPresence` |

Nothing in the "added" rows is a re-implementation for its own sake: each one is
either a protocol trick this library could not express (hidden mentions), a
transform family that existed only as twelve inconsistent inline copies, or a
conversion that was **claimed** by `features/media.ts` and not performed.

## Refused, on the record

These appear repeatedly across the archives and are not implemented. This is a
decision, not an oversight:

| Command family | What it does | Why it is not here |
|---|---|---|
| `pushkontak`, `pushkontak2`, `pushid` | Sends a message to every contact, or every member of every group, unsolicited | Bulk unsolicited messaging. It is the fastest route to a ban, and it lands on people who never asked |
| `bcgc`, `bcall`, `bcallad` | Broadcast into groups, or auto-join calls | Same, plus it is how a bot gets removed from every group it is in |
| `bug`, `xbug`, `crash`, `blank`, `muncul`, `forceclose` | Payloads designed to crash or hang a recipient's client | Deliberate denial of service against a person |
| `spamcall`, `spampairing`, `spamotp` | Call and pairing-code floods | Harassment, and pairing floods get a number platform-banned |
| `readsw`, `swview` | Auto-view of status broadcasts | It works, but status view is a person's own signal of who saw it. Automating it makes that signal false |
| `getcase`, `getsession`, `backup`, `clearsession` | Reads and ships the session folder | Exfiltrates credentials. Nothing in this library will ever read someone's session to send it elsewhere |

The `xbug6` archive also ships a `.env`-shaped obfuscation helper in its own
`lib/`. Reading these to build a command inventory is one thing; adopting their
attack surface is another, and none of it was copied.

## The finding that was not on the list

Reading the archives is what prompted a read of our own
`src/features/media.ts`, and that is where the real defect is:

```ts
export async function convertImageFormat(inputPath, options) {
  writeFileSync(outputPath, readFileSync(inputPath));
  return { outputPath, fromFormat, toFormat: targetFormat };
}
```

It does not convert anything. `extractAudioFromVideo` writes the video's bytes to
a file with an audio extension. `addWatermark` writes the input back out. Each
returns a success object naming a path that holds a byte-for-byte copy — so a
caller gets `ok`, sends the file, and finds out later.

`toolkit/media-forge.ts` is the replacement: it runs `ffmpeg`/`ffprobe`, verifies
the artifact exists and is non-empty, and reports `{ ok: false, reason }` by name
when the tools are unavailable or the conversion failed.
`tests/media-forge.test.js` proves it by generating real media, converting it, and
asking `ffprobe` what the output actually is — an assertion the stubs cannot pass.

**The stubs in `features/media.ts` are still there.** They are out of scope for
this pass; the audit records them so the next pass does not have to find them
again. Until then, treat every function in that file that shells out to nothing
as unverified.
