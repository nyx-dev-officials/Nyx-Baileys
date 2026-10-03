export default {
  name: 'whoami',
  aliases: ['me'],
  category: 'general',
  description: 'Show your sender id and whether you are an owner.',
  handler: async (ctx) => {
    const admin = ctx.isGroup ? await ctx.isGroupAdmin() : false;
    await ctx.reply(
      [
        `sender: ${ctx.sender}`,
        `chat:   ${ctx.jid}`,
        `owner:  ${ctx.isOwner ? 'yes' : 'no'}`,
        ctx.isGroup ? `group admin: ${admin ? 'yes' : 'no'}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  },
};
