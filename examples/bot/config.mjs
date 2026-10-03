/**
 * Example bot configuration.
 *
 * This is the `config.js` every classic bot script has — owner list, prefix,
 * message templates — but as a plain ES module instead of `global.*`.
 *
 * Set OWNERS to your own number before running.
 */

export default {
  sessionDir: process.env.SESSION_DIR ?? './session',

  // Command prefix. `/ping`.
  prefix: process.env.PREFIX ?? '/',

  // Owner numbers (international format, no +). Owner-only commands check this.
  owners: (process.env.OWNERS ?? '15551234567').split(',').map((s) => s.trim()).filter(Boolean),

  // Answer commands in group chats too.
  groups: process.env.GROUPS === 'true',

  logLevel: process.env.LOG_LEVEL ?? 'info',

  // The rejection messages. Any key can be overridden; the rest use defaults.
  messages: {
    owner: 'Only the owner can use that command.',
    wait: 'Slow down a moment.',
  },
};
