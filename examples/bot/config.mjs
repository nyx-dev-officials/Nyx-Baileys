/**
 * Example bot configuration.
 *
 * This is the `config.js` every classic bot script has — owner list, prefix,
 * message templates — but as a plain ES module instead of `global.*`.
 *
 * Set OWNERS to your own number before running.
 */

import { FLUX_PREFIX } from '../../dist/index.js';

export default {
  sessionDir: process.env.SESSION_DIR ?? './session',

  // Command prefix. `flux ping`.
  prefix: process.env.PREFIX ?? FLUX_PREFIX,

  // Owner numbers (international format, no +). Owner-only commands check this.
  owners: (process.env.OWNERS ?? '15551234567').split(',').map((s) => s.trim()).filter(Boolean),

  // Answer commands in group chats too.
  groups: process.env.GROUPS === 'true',

  // Stanza spam off by default; the online/commands lines still print.
  logLevel: process.env.LOG_LEVEL ?? 'warn',

  // The rejection messages. Any key can be overridden; the rest use defaults.
  messages: {
    owner: 'Only the owner can use that command.',
    wait: 'Slow down a moment.',
  },
};
