export default {
  name: 'ping',
  category: 'general',
  description: 'Check the bot is alive.',
  handler: async (ctx) => {
    const started = Date.now();
    await ctx.reply(`pong (${Date.now() - started}ms)`);
  },
};
