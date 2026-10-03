export default {
  name: 'groupinfo',
  category: 'group',
  groupOnly: true,
  description: 'Show this group’s subject and size.',
  handler: async (ctx) => {
    const metadata = await ctx.sock.groupMetadata(ctx.jid);
    const admins = (metadata.participants ?? []).filter((p) => p.admin).length;
    await ctx.reply(
      [
        `subject: ${metadata.subject ?? '(none)'}`,
        `members: ${metadata.participants?.length ?? 0}`,
        `admins:  ${admins}`,
      ].join('\n'),
    );
  },
};
