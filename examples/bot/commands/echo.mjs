export default {
  name: 'echo',
  category: 'general',
  usage: '<text>',
  description: 'Repeat your text back.',
  handler: async (ctx) => {
    await ctx.reply(ctx.args || '(nothing to echo)');
  },
};
