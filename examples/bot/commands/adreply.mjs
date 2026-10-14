import { isAdReplyEnabled, setAdReplyEnabled } from '../../../dist/toolkit/adreply-state.js';

/**
 * `flux adreply on|off|status` — the native ad card on outgoing messages.
 *
 * Owner-only, because it changes every message the bot sends. The switch is
 * read once when the plugin is applied, so turning it on needs a restart; the
 * command says so rather than letting the change look silently ineffective.
 */
export default {
  name: 'adreply',
  aliases: ['adcard'],
  category: 'owner',
  usage: '[on|off|status]',
  ownerOnly: true,
  description: 'Turn the ad card on outgoing messages on or off.',
  handler: async (ctx) => {
    const arg = (ctx.args ?? '').trim().toLowerCase();
    if (arg === 'on' || arg === 'off') {
      const on = setAdReplyEnabled(arg === 'on');
      return {
        text: on
          ? '◈ Ad card *on* — every outgoing message carries it now. *Restart the bot* to apply.'
          : '◈ Ad card *off* — messages send plain. *Restart the bot* to apply.',
      };
    }
    const on = isAdReplyEnabled();
    return {
      text: on
        ? '◈ Ad card is *on*. Every outgoing message carries the card. Restart to apply changes.'
        : '◈ Ad card is *off*. Nothing is stamped on outgoing messages.\nUse `flux adreply on` to enable it.',
    };
  },
};