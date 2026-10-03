/**
 * Multi-session fleet.
 *
 * `SessionManager` runs N independent `NyxBaileys` accounts in one Node
 * process, each with its own socket, auth directory, plugin instances and log
 * scope:
 *
 *   const fleet = createSessionManager({ maxSessions: 8, sessionRoot: './fleet' });
 *
 *   await fleet.create('sales', { jid: '15551234567@s.whatsapp.net' });
 *   await fleet.create('support', { jid: '15559876543@s.whatsapp.net' });
 *
 *   const report = await fleet.broadcast('Server maintenance at 22:00 UTC');
 *   if (report.failed > 0) report.results.filter((r) => !r.ok && !r.skipped);
 *
 *   await fleet.disposeAll();
 *
 * A session that stops reaching `open` is rebuilt on its own, from the auth
 * store, on a bounded backoff. The other accounts are not touched.
 */

export {
  SessionManager,
  createSessionManager,
  type BroadcastOptions,
  type BroadcastOutcome,
  type BroadcastReport,
  type CreateSessionOptions,
  type FleetEvent,
  type FleetListener,
  type RestartPolicy,
  type SessionManagerOptions,
  type SessionRecord,
  type SessionStatus,
} from './session-manager.js';