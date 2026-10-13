import {
  featureMenuText,
  formatCatalogueFallback,
  formatFamilyMenu,
  buildFullRegistry,
  sendFeatureMenu,
  sendFluxFamilyPage,
  sendFluxMenu,
} from '../../../dist/index.js';

/**
 * `flux menu` — the command catalogue.
 *
 * No argument sends the interactive category sheet (native `single_select`
 * with one row per family); taps come back through the `fluxMenuTap` plugin
 * wired in the host. `flux menu <family>` answers that family as text, which
 * is also the path small terminals and text-only clients take. `flux menu
 * features` keeps the old button-type demo sheet, and `flux menu text` forces
 * the plaintext catalogue.
 */
export default {
  name: 'menu',
  category: 'general',
  usage: '[family [page] | features | text]',
  description: 'Browse the command catalogue.',
  handler: async (ctx) => {
    const [arg, pageRaw] = ctx.args.trim().toLowerCase().split(/\s+/);

    if (arg === 'features') {
      try {
        await sendFeatureMenu(ctx.sock, ctx.jid);
      } catch {
        await ctx.reply(featureMenuText());
      }
      return;
    }

    const reg = buildFullRegistry();
    if (arg === 'text') {
      await ctx.reply(formatCatalogueFallback(reg));
      return;
    }
    if (arg) {
      const page = pageRaw === undefined || pageRaw === '' ? 1 : Number.parseInt(pageRaw, 10);
      try {
        await sendFluxFamilyPage(ctx.sock, ctx.jid, reg, arg, Number.isFinite(page) ? page : 1, {
          progress: true,
          // Answer as a reply to the message that asked, so the sheet sits under it.
          quoted: ctx.key,
        });
      } catch {
        await ctx.reply(formatFamilyMenu(reg, arg, Number.isFinite(page) ? page : 1));
      }
      return;
    }
    try {
      await sendFluxMenu(ctx.sock, ctx.jid, reg, { progress: true, quoted: ctx.key });
    } catch {
      await ctx.reply(formatCatalogueFallback(reg));
    }
  },
};
