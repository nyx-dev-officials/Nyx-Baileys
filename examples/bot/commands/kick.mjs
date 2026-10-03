import { jidNormalizedUser } from '../../../dist/index.js';

/**
 * Remove a member. Group-only, admin-only, and the bot must itself be admin.
 *
 * The target is a reply/mention, or a number in the arguments. This is a real
 * moderation action against a live group, so it is guarded three ways rather
 * than trusting the caller.
 */
export default {
  name: 'kick',
  category: 'group',
  groupOnly: true,
  adminsOnly: true,
  botAdminOnly: true,
  usage: '<@mention | number>',
  description: 'Remove a member from the group.',

  handler: async (ctx) => {
    const mentioned = ctx.message.message?.extendedTextMessage?.contextInfo?.participant;
    const target = mentioned ?? (ctx.argv[0] ? `${ctx.argv[0].replace(/\D/g, '')}@s.whatsapp.net` : null);

    if (!target) {
      await ctx.reply('Mention someone, reply to them, or pass a number.');
      return;
    }

    const jid = jidNormalizedUser(target);
    if (jid === jidNormalizedUser(ctx.sock.user?.id ?? '')) {
      await ctx.reply('I will not remove myself.');
      return;
    }

    await ctx.sock.groupParticipantsUpdate(ctx.jid, [jid], 'remove');
    await ctx.reply(`Removed ${jid}.`);
  },
};
