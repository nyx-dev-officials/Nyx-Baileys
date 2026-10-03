/**
 * Feature plugin barrel.
 *
 * These plugins are *opt-in*: none of them is in `SuperBaileys`'s default chain,
 * because every one of them encodes a product decision that is not the library's
 * to make — whether to send read receipts, what presence means, which webhook
 * events leave the process. Wire them explicitly:
 *
 * ```ts
 * sb.registerPlugin(metrics())
 *    .registerPlugin(readReceipts({ groups: false }))
 *    .registerPlugin(presence({ busyMs: 8000 }))
 *    .registerPlugin(commands({ prefix: '!', defaults: [greet] }))
 *    .registerPlugin(webhooks({ endpoints: [{ url, secret }] }));
 * ```
 *
 * `featurePlugins()` returns them in ascending `order`, which is the order they
 * should be handed to `registerPlugin` — the host sorts by `order` anyway, this
 * just makes the intended sequence readable.
 */

import { callLog } from './call-log.js';
import { commands } from './commands.js';
import { metrics } from './metrics.js';
import { newsletters } from './newsletter.js';
import { polls } from './poll.js';
import { presence } from './presence.js';
import { reactions } from './reaction.js';
import { readReceipts } from './read-receipts.js';
import { statusFeed } from './status.js';
import { webhooks } from './webhook.js';

import type { Plugin } from '../utils/types.js';

/* factories */
export { polls } from './poll.js';
export { reactions } from './reaction.js';
export { presence } from './presence.js';
export { readReceipts } from './read-receipts.js';
export { statusFeed } from './status.js';
export { newsletters } from './newsletter.js';
export { callLog } from './call-log.js';
export { commands, tokenize } from './commands.js';
export { webhooks } from './webhook.js';
export { metrics } from './metrics.js';

/* poll */
export type { PollState, PollOption, PollResult, PollsOptions, CreatePollOptions } from './poll.js';

/* reaction */
export type { ReactionOptions, ObservedReaction, MessageReactions } from './reaction.js';
export { DEFAULT_REACTION_EMOJI } from './reaction.js';

/* presence */
export type { PresenceOptions, PresenceSnapshot } from './presence.js';

/* read receipts */
export type { ReadReceiptsOptions, ReadReceiptsSnapshot, ReceiptPolicy } from './read-receipts.js';

/* status */
export type { StatusEntry, StatusOptions } from './status.js';

/* newsletter */
export type {
  NewsletterOptions,
  NewsletterReactionState,
  NewsletterViewState,
  NewsletterParticipantEvent,
  NewsletterSettingsEvent,
  NewsletterReactionEvent,
} from './newsletter.js';

/* call log */
export type { CallEntry, CallOptions } from './call-log.js';

/* commands */
export type { CommandSpec, CommandOptions, CommandContext, HelpSection } from './commands.js';

/* webhook */
export type {
  WebhookOptions,
  WebhookEndpoint,
  WebhookRoute,
  WebhookDelivery,
  WebhookSnapshot,
} from './webhook.js';

/* metrics */
export type {
  MetricsOptions,
  MetricsSnapshot,
  MetricSnapshot,
  SeriesSnapshot,
  MetricLabels,
  MetricType,
  HistogramSpec,
} from './metrics.js';

/**
 * Every feature plugin, in ascending `order`.
 *
 * The `order` gaps are deliberate: 110–180 sits above the framework's default
 * chain (which ends at 100), so these plugins observe state after the built-in
 * ones have normalised it. Commands at 170 and webhooks at 180 are last because
 * both read message bodies and both fan out — they want the final say.
 */
export function featurePlugins(): Plugin[] {
  return [
    metrics(),      // 110
    polls(),        // 120
    reactions(),    // 125
    statusFeed(),   // 130
    newsletters(),  // 135
    callLog(),      // 140
    presence(),     // 150
    readReceipts(), // 160
    commands(),     // 170
    webhooks(),     // 180
  ].sort((a, b) => a.order - b.order);
}
