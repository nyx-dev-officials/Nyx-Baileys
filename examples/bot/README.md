# Example bot on nyx-baileys

A minimal but real WhatsApp bot in the shape the classic scripts use — a config,
an entry point, and a directory of command modules — running on `nyx-baileys`
instead of `@whiskeysockets/baileys`.

## Run it

```bash
npm run build                 # the example imports from ./dist
OWNERS=15551234567 node examples/bot/index.mjs
```

First run prints a QR — scan it from **WhatsApp → Linked devices**. Then message
the number (the default prefix is `flux `, or pairing first with `flux` and the
bot stays up on the same connection):

```
flux ping
flux menu
flux whoami
```

`flux menu` sends the interactive catalogue — one row per command family, with
live counts. Tapping a family replies with its first page and **Next**, then
**Previous / Next** as you move: a page turn *edits the message in place*
rather than posting a new one, 25 commands per page. `flux menu <family>` works
typed too (same paged message), and `flux menu features` keeps the old
button-type demo sheet.

Set `GROUPS=true` to let it answer in groups. `/groupinfo` and `/kick` only work
in a group, and `/kick` additionally needs you to be an admin and the bot to be
an admin.

## Menu taps

`/menu` sends the interactive feature menu — Call, URL, Quick Reply, Copy — and a
tap sends that feature's example button back. The dispatch lives in `index.mjs`:
read the row id out of `interactiveResponseMessage`, resolve it to a feature, and
send it. An id that is not one of ours resolves to `null` and is ignored, so an
unrelated interactive message is never mis-dispatched.

## Layout

```
examples/bot/
  config.mjs           owner list, prefix, message templates
  index.mjs            createNyxBot(...) + graceful shutdown
  commands/
    ping.mjs
    echo.mjs
    menu.mjs           the native feature menu (falls back to text)
    whoami.mjs
    groupinfo.mjs      groupOnly
    kick.mjs           groupOnly + adminsOnly + botAdminOnly
```

## Writing a command

A command module default-exports a spec. Everything is optional except `name`
and `handler`:

```js
export default {
  name: 'hello',
  aliases: ['hi'],
  category: 'general',
  usage: '[name]',
  description: 'Say hello.',
  cooldownMs: 3000,
  handler: async (ctx) => {
    await ctx.reply(`hello ${ctx.args || 'there'}`);
  },
};
```

The context gives you what a bot actually needs:

| field | what it is |
|---|---|
| `ctx.sock` | the live socket — send media, manage groups, anything |
| `ctx.sender` / `ctx.jid` | normalised sender and chat ids |
| `ctx.isOwner` | sender is on the owner list |
| `ctx.isGroupAdmin()` / `ctx.isBotAdmin()` | resolved from group metadata |
| `ctx.args` / `ctx.argv` | body after the command, raw and tokenised |
| `ctx.reply(text)` / `ctx.replyPrivate(text)` | reply in chat / DM the sender |

Guards in the spec (`ownerOnly`, `adminsOnly`, `botAdminOnly`, `groupOnly`,
`privateOnly`, `cooldownMs`) are enforced for you, with a per-sender cooldown so
one user cannot starve the others.

## Dropping to the client

The bot host is a convenience, not a cage. Anything it does you can do directly:

```js
import { createNyxBaileys, commands, loadCommands } from 'nyx-baileys';

const client = createNyxBaileys({ sessionDir: './session' });
client.registerPlugin(commands({ prefix: '/', owners: ['15551234567'] }));
const sock = await client.connect();
for (const { spec } of await loadCommands('./commands')) sock.commands.register(spec);
```
