import { adReplyCard } from '../../../dist/index.js';

/**
 * `flux adreply` — send one message carrying the native ad card.
 *
 * A preview, not a switch. Nothing is stamped on anything else; this sends a
 * single message so you can look at your phone and tell whether the card renders
 * at all. Which it had not been observed to do.
 */
export default {
  name: 'adreply',
  aliases: ['adcard'],
  category: 'owner',
  usage: '',
  ownerOnly: true,
  description: 'Send a test message with the native ad card.',
  handler: async (ctx) => {
    await ctx.sock.sendMessage(ctx.jid, {
      text: '◈ ad card test — if you see a banner under this line, it renders.',
      contextInfo: { externalAdReply: adReplyCard() },
    });
    return {};
  },
};