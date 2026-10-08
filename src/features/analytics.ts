/**
 * @file analytics.ts
 * @module features/analytics
 *
 * Comprehensive analytics layer for Nyx-Baileys.
 * Covers message metrics, group analytics, connection monitoring,
 * media analytics, user behaviour, spam detection, sentiment, keyword
 * tracking, conversation flow, bot performance, error tracking, health
 * checking, alerting, report generation and dashboard collection.
 *
 * All types are self-contained — no runtime dependency on Baileys is
 * required, though WAMessage keys are referenced through the published
 * Baileys type surface.
 */

import type { proto } from '@whiskeysockets/baileys';

/* ─────────────────────────────────────────────────────────────────────────
   Shared primitive types
   ───────────────────────────────────────────────────────────────────────── */

/** Epoch milliseconds timestamp. */
export type EpochMs = number;

/** A simple [bucket, count] pair used in histograms / heatmaps. */
export interface BucketCount {
  bucket: string;
  count: number;
}

/** Percentile descriptor returned by latency helpers. */
export interface LatencyPercentiles {
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
}

/** Direction of a WhatsApp message. */
export type MessageDirection = 'sent' | 'received';

/** High-level message status. */
export type MessageStatus = 'pending' | 'delivered' | 'read' | 'failed';

/** Sentiment polarity label. */
export type SentimentLabel = 'positive' | 'negative' | 'neutral';

/** Severity levels used by AlertManager. */
export type AlertSeverity = 'info' | 'warning' | 'critical';

/** A recorded event with an arbitrary payload. */
export interface AnalyticsEvent<T = unknown> {
  eventType: string;
  ts: EpochMs;
  payload: T;
}

/** A window definition for sliding-window calculations. */
export interface TimeWindow {
  startMs: EpochMs;
  endMs: EpochMs;
}

/* ─────────────────────────────────────────────────────────────────────────
   1. MessageMetrics
   ───────────────────────────────────────────────────────────────────────── */

export interface MessageRecord {
  id: string;
  direction: MessageDirection;
  status: MessageStatus;
  ts: EpochMs;
  jid: string;
  sizeBytes: number;
}

export interface MessageMetricsSummary {
  totalSent: number;
  totalReceived: number;
  totalFailed: number;
  successRate: number;
  averageSizeBytes: number;
}

/**
 * Tracks per-message events: sent, received, and failed counts together
 * with byte sizes. Thread-safe for single-threaded Node.js use.
 */
export class MessageMetrics {
  private readonly records: MessageRecord[] = [];

  /** Record a message event. */
  track(record: MessageRecord): void {
    this.records.push(record);
  }

  /** Record a sent message. */
  trackSent(id: string, jid: string, sizeBytes: number): void {
    this.track({ id, direction: 'sent', status: 'delivered', ts: Date.now(), jid, sizeBytes });
  }

  /** Record a received message. */
  trackReceived(id: string, jid: string, sizeBytes: number): void {
    this.track({ id, direction: 'received', status: 'read', ts: Date.now(), jid, sizeBytes });
  }

  /** Record a failed outbound message. */
  trackFailed(id: string, jid: string): void {
    this.track({ id, direction: 'sent', status: 'failed', ts: Date.now(), jid, sizeBytes: 0 });
  }

  get sentCount(): number {
    return this.records.filter((r) => r.direction === 'sent' && r.status !== 'failed').length;
  }

  get receivedCount(): number {
    return this.records.filter((r) => r.direction === 'received').length;
  }

  get failedCount(): number {
    return this.records.filter((r) => r.status === 'failed').length;
  }

  /** Compute a roll-up summary. */
  summary(): MessageMetricsSummary {
    const sent = this.sentCount;
    const received = this.receivedCount;
    const failed = this.failedCount;
    const total = sent + failed;
    const successRate = total === 0 ? 1 : sent / total;
    const sizes = this.records.map((r) => r.sizeBytes);
    const averageSizeBytes = sizes.length === 0 ? 0 : sizes.reduce((a, b) => a + b, 0) / sizes.length;
    return { totalSent: sent, totalReceived: received, totalFailed: failed, successRate, averageSizeBytes };
  }

  /** Return records in a time window. */
  inWindow(window: TimeWindow): MessageRecord[] {
    return this.records.filter((r) => r.ts >= window.startMs && r.ts <= window.endMs);
  }

  /** Reset all records. */
  reset(): void {
    this.records.length = 0;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   2. GroupAnalytics
   ───────────────────────────────────────────────────────────────────────── */

export interface MemberEvent {
  jid: string;
  groupJid: string;
  type: 'join' | 'leave';
  ts: EpochMs;
}

export interface GroupActivityEntry {
  jid: string;
  groupJid: string;
  ts: EpochMs;
}

export interface GroupAnalyticsSummary {
  currentMembers: number;
  netGrowth: number;
  joinCount: number;
  leaveCount: number;
  heatmap: BucketCount[];
}

/**
 * Tracks group member growth and generates hour-of-week activity heatmaps.
 */
export class GroupAnalytics {
  private readonly memberEvents: MemberEvent[] = [];
  private readonly activityLog: GroupActivityEntry[] = [];

  recordJoin(jid: string, groupJid: string, ts: EpochMs = Date.now()): void {
    this.memberEvents.push({ jid, groupJid, type: 'join', ts });
  }

  recordLeave(jid: string, groupJid: string, ts: EpochMs = Date.now()): void {
    this.memberEvents.push({ jid, groupJid, type: 'leave', ts });
  }

  recordActivity(jid: string, groupJid: string, ts: EpochMs = Date.now()): void {
    this.activityLog.push({ jid, groupJid, ts });
  }

  memberGrowth(groupJid: string): { joins: number; leaves: number; net: number } {
    const events = this.memberEvents.filter((e) => e.groupJid === groupJid);
    const joins = events.filter((e) => e.type === 'join').length;
    const leaves = events.filter((e) => e.type === 'leave').length;
    return { joins, leaves, net: joins - leaves };
  }

  /**
   * Build an activity heatmap bucketed by day-of-week + hour-of-day.
   * Bucket key format: `"DDD HH"` e.g. `"Mon 14"`.
   */
  activityHeatmap(groupJid: string): BucketCount[] {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
    const counts = new Map<string, number>();
    for (const entry of this.activityLog) {
      if (entry.groupJid !== groupJid) continue;
      const d = new Date(entry.ts);
      const key = `${days[d.getDay()]} ${String(d.getHours()).padStart(2, '0')}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([bucket, count]) => ({ bucket, count }))
      .sort((a, b) => a.bucket.localeCompare(b.bucket));
  }

  summary(groupJid: string): GroupAnalyticsSummary {
    const { joins, leaves, net } = this.memberGrowth(groupJid);
    return {
      currentMembers: Math.max(0, joins - leaves),
      netGrowth: net,
      joinCount: joins,
      leaveCount: leaves,
      heatmap: this.activityHeatmap(groupJid),
    };
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   3. ConnectionMonitor
   ───────────────────────────────────────────────────────────────────────── */

export interface ConnectionEvent {
  type: 'connect' | 'disconnect' | 'latency';
  ts: EpochMs;
  latencyMs?: number;
}

export interface ConnectionStats {
  uptimeMs: number;
  downtimeMs: number;
  reconnectCount: number;
  averageLatencyMs: number;
  p99LatencyMs: number;
}

/**
 * Monitors connection uptime, disconnect events, reconnection frequency
 * and round-trip latency samples.
 */
export class ConnectionMonitor {
  private readonly events: ConnectionEvent[] = [];
  private connectedSince: EpochMs | null = null;
  private _reconnectCount = 0;

  onConnect(ts: EpochMs = Date.now()): void {
    this.events.push({ type: 'connect', ts });
    if (this.connectedSince !== null) {
      this._reconnectCount++;
    }
    this.connectedSince = ts;
  }

  onDisconnect(ts: EpochMs = Date.now()): void {
    this.events.push({ type: 'disconnect', ts });
    this.connectedSince = null;
  }

  recordLatency(latencyMs: number, ts: EpochMs = Date.now()): void {
    this.events.push({ type: 'latency', ts, latencyMs });
  }

  get uptimeMs(): number {
    const pairs = this.connectionPairs();
    return pairs.reduce((acc, [c, d]) => acc + (d - c), 0);
  }

  get reconnectCount(): number {
    return this._reconnectCount;
  }

  private connectionPairs(): [EpochMs, EpochMs][] {
    const pairs: [EpochMs, EpochMs][] = [];
    let lastConnect: EpochMs | null = null;
    for (const ev of this.events) {
      if (ev.type === 'connect') {
        lastConnect = ev.ts;
      } else if (ev.type === 'disconnect' && lastConnect !== null) {
        pairs.push([lastConnect, ev.ts]);
        lastConnect = null;
      }
    }
    if (lastConnect !== null) {
      pairs.push([lastConnect, Date.now()]);
    }
    return pairs;
  }

  stats(): ConnectionStats {
    const latencies = this.events
      .filter((e) => e.type === 'latency' && e.latencyMs !== undefined)
      .map((e) => e.latencyMs as number);
    const averageLatencyMs = latencies.length === 0 ? 0 : latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const p99LatencyMs = computeP99Latency(latencies);
    const uptime = this.uptimeMs;
    const total = this.events.length > 0 ? Date.now() - (this.events[0]?.ts ?? Date.now()) : 0;
    return {
      uptimeMs: uptime,
      downtimeMs: Math.max(0, total - uptime),
      reconnectCount: this._reconnectCount,
      averageLatencyMs,
      p99LatencyMs,
    };
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   4. MediaAnalytics
   ───────────────────────────────────────────────────────────────────────── */

export type MediaType = 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'unknown';

export interface MediaRecord {
  type: MediaType;
  sizeBytes: number;
  ts: EpochMs;
  jid: string;
}

export interface MediaAnalyticsSummary {
  byType: Record<MediaType, { count: number; totalBytes: number }>;
  totalCount: number;
  totalBytes: number;
}

/**
 * Tracks types and sizes of media messages sent and received.
 */
export class MediaAnalytics {
  private readonly records: MediaRecord[] = [];

  record(type: MediaType, sizeBytes: number, jid: string, ts: EpochMs = Date.now()): void {
    this.records.push({ type, sizeBytes, ts, jid });
  }

  /** Infer media type from a Baileys message key. */
  static inferType(msg: proto.IMessage): MediaType {
    if (msg.imageMessage) return 'image';
    if (msg.videoMessage) return 'video';
    if (msg.audioMessage) return 'audio';
    if (msg.documentMessage) return 'document';
    if (msg.stickerMessage) return 'sticker';
    return 'unknown';
  }

  summary(): MediaAnalyticsSummary {
    const byType: Record<MediaType, { count: number; totalBytes: number }> = {
      image: { count: 0, totalBytes: 0 },
      video: { count: 0, totalBytes: 0 },
      audio: { count: 0, totalBytes: 0 },
      document: { count: 0, totalBytes: 0 },
      sticker: { count: 0, totalBytes: 0 },
      unknown: { count: 0, totalBytes: 0 },
    };
    let totalCount = 0;
    let totalBytes = 0;
    for (const r of this.records) {
      const bucket = byType[r.type];
      bucket.count++;
      bucket.totalBytes += r.sizeBytes;
      totalCount++;
      totalBytes += r.sizeBytes;
    }
    return { byType, totalCount, totalBytes };
  }

  topTypes(n = 3): Array<{ type: MediaType; count: number }> {
    const { byType } = this.summary();
    return (Object.entries(byType) as Array<[MediaType, { count: number; totalBytes: number }]>)
      .map(([type, { count }]) => ({ type, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, n);
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   5. UserBehaviorTracker
   ───────────────────────────────────────────────────────────────────────── */

export interface UserInteraction {
  jid: string;
  ts: EpochMs;
  action: string;
}

export interface ResponseTimeSample {
  jid: string;
  promptTs: EpochMs;
  replyTs: EpochMs;
  latencyMs: number;
}

export interface UserBehaviorSummary {
  uniqueUsers: number;
  averageResponseTimeMs: number;
  medianResponseTimeMs: number;
  topActions: BucketCount[];
}

/**
 * Tracks per-user interaction patterns and response time distributions.
 */
export class UserBehaviorTracker {
  private readonly interactions: UserInteraction[] = [];
  private readonly responseSamples: ResponseTimeSample[] = [];

  record(jid: string, action: string, ts: EpochMs = Date.now()): void {
    this.interactions.push({ jid, ts, action });
  }

  recordResponseTime(jid: string, promptTs: EpochMs, replyTs: EpochMs): void {
    this.responseSamples.push({ jid, promptTs, replyTs, latencyMs: replyTs - promptTs });
  }

  summary(): UserBehaviorSummary {
    const uniqueUsers = new Set(this.interactions.map((i) => i.jid)).size;
    const latencies = this.responseSamples.map((s) => s.latencyMs);
    const averageResponseTimeMs =
      latencies.length === 0 ? 0 : latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const medianResponseTimeMs = computeMedianLatency(latencies);
    const actionCounts = new Map<string, number>();
    for (const i of this.interactions) {
      actionCounts.set(i.action, (actionCounts.get(i.action) ?? 0) + 1);
    }
    const topActions: BucketCount[] = Array.from(actionCounts.entries())
      .map(([bucket, count]) => ({ bucket, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    return { uniqueUsers, averageResponseTimeMs, medianResponseTimeMs, topActions };
  }

  actionsForUser(jid: string): UserInteraction[] {
    return this.interactions.filter((i) => i.jid === jid);
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   6. SpamDetector
   ───────────────────────────────────────────────────────────────────────── */

export interface SpamSignal {
  jid: string;
  text: string;
  ts: EpochMs;
}

export interface SpamReport {
  jid: string;
  messageCount: number;
  windowMs: number;
  rate: number; /** messages per second */
  isSpam: boolean;
  repeatedPatterns: string[];
}

/**
 * Detects message-rate spamming and repeated pattern abuse.
 */
export class SpamDetector {
  private readonly signals: SpamSignal[] = [];
  private readonly rateThreshold: number;
  private readonly windowMs: number;

  constructor(options: { rateThreshold?: number; windowMs?: number } = {}) {
    this.rateThreshold = options.rateThreshold ?? 5; // msgs/sec
    this.windowMs = options.windowMs ?? 10_000;
  }

  record(jid: string, text: string, ts: EpochMs = Date.now()): void {
    this.signals.push({ jid, text, ts });
  }

  analyse(jid: string, now: EpochMs = Date.now()): SpamReport {
    const windowStart = now - this.windowMs;
    const recent = this.signals.filter((s) => s.jid === jid && s.ts >= windowStart);
    const rate = recent.length / (this.windowMs / 1_000);
    const textCounts = new Map<string, number>();
    for (const s of recent) {
      textCounts.set(s.text, (textCounts.get(s.text) ?? 0) + 1);
    }
    const repeatedPatterns = Array.from(textCounts.entries())
      .filter(([, c]) => c > 1)
      .map(([text]) => text);
    return {
      jid,
      messageCount: recent.length,
      windowMs: this.windowMs,
      rate,
      isSpam: rate >= this.rateThreshold || repeatedPatterns.length > 0,
      repeatedPatterns,
    };
  }

  flaggedUsers(now: EpochMs = Date.now()): string[] {
    const jids = [...new Set(this.signals.map((s) => s.jid))];
    return jids.filter((jid) => this.analyse(jid, now).isSpam);
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   7. SentimentTracker
   ───────────────────────────────────────────────────────────────────────── */

export interface SentimentRecord {
  jid: string;
  text: string;
  label: SentimentLabel;
  score: number; // −1..+1
  ts: EpochMs;
}

export interface SentimentSummary {
  positive: number;
  negative: number;
  neutral: number;
  averageScore: number;
}

/**
 * Records pre-computed sentiment labels and scores; aggregates distributions.
 * Sentiment scoring itself is performed externally (LLM, lexicon, etc.).
 */
export class SentimentTracker {
  private readonly records: SentimentRecord[] = [];

  record(jid: string, text: string, label: SentimentLabel, score: number, ts: EpochMs = Date.now()): void {
    this.records.push({ jid, text, label, score, ts });
  }

  summary(window?: TimeWindow): SentimentSummary {
    const filtered = window
      ? this.records.filter((r) => r.ts >= window.startMs && r.ts <= window.endMs)
      : this.records;
    const counts = { positive: 0, negative: 0, neutral: 0 };
    let scoreSum = 0;
    for (const r of filtered) {
      counts[r.label]++;
      scoreSum += r.score;
    }
    return {
      ...counts,
      averageScore: filtered.length === 0 ? 0 : scoreSum / filtered.length,
    };
  }

  trend(bucketMs = 3_600_000): BucketCount[] {
    const map = new Map<number, { positive: number; total: number }>();
    for (const r of this.records) {
      const bucket = Math.floor(r.ts / bucketMs) * bucketMs;
      const entry = map.get(bucket) ?? { positive: 0, total: 0 };
      if (r.label === 'positive') entry.positive++;
      entry.total++;
      map.set(bucket, entry);
    }
    return Array.from(map.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([ts, { total }]) => ({ bucket: new Date(ts).toISOString(), count: total }));
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   8. KeywordTracker
   ───────────────────────────────────────────────────────────────────────── */

export interface KeywordMention {
  keyword: string;
  jid: string;
  ts: EpochMs;
  context: string;
}

export interface KeywordFrequency {
  keyword: string;
  count: number;
  lastSeen: EpochMs;
}

/**
 * Tracks keyword mentions and their frequencies across conversations.
 */
export class KeywordTracker {
  private readonly mentions: KeywordMention[] = [];
  private readonly watchList: Set<string>;

  constructor(keywords: string[] = []) {
    this.watchList = new Set(keywords.map((k) => k.toLowerCase()));
  }

  addKeyword(keyword: string): void {
    this.watchList.add(keyword.toLowerCase());
  }

  /** Scan a message body for tracked keywords. */
  scan(text: string, jid: string, ts: EpochMs = Date.now()): KeywordMention[] {
    const found: KeywordMention[] = [];
    const lower = text.toLowerCase();
    for (const keyword of this.watchList) {
      if (lower.includes(keyword)) {
        const mention: KeywordMention = { keyword, jid, ts, context: text.slice(0, 200) };
        this.mentions.push(mention);
        found.push(mention);
      }
    }
    return found;
  }

  frequencies(): KeywordFrequency[] {
    const map = new Map<string, { count: number; lastSeen: EpochMs }>();
    for (const m of this.mentions) {
      const entry = map.get(m.keyword) ?? { count: 0, lastSeen: 0 };
      entry.count++;
      if (m.ts > entry.lastSeen) entry.lastSeen = m.ts;
      map.set(m.keyword, entry);
    }
    return Array.from(map.entries())
      .map(([keyword, { count, lastSeen }]) => ({ keyword, count, lastSeen }))
      .sort((a, b) => b.count - a.count);
  }

  mentionsFor(keyword: string): KeywordMention[] {
    return this.mentions.filter((m) => m.keyword === keyword.toLowerCase());
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   9. ConversationFlowAnalyzer
   ───────────────────────────────────────────────────────────────────────── */

export interface ConversationMessage {
  id: string;
  jid: string;
  sender: string;
  ts: EpochMs;
  text: string;
  replyToId?: string;
}

export interface ThreadStats {
  depth: number;
  participantCount: number;
  averageReplyLatencyMs: number;
  messageCount: number;
}

/**
 * Analyses conversation thread depth, branching, and participant dynamics.
 */
export class ConversationFlowAnalyzer {
  private readonly messages: ConversationMessage[] = [];

  addMessage(msg: ConversationMessage): void {
    this.messages.push(msg);
  }

  threadDepth(rootId: string): number {
    const byParent = new Map<string, ConversationMessage[]>();
    for (const m of this.messages) {
      if (m.replyToId) {
        const children = byParent.get(m.replyToId) ?? [];
        children.push(m);
        byParent.set(m.replyToId, children);
      }
    }
    const walk = (id: string, depth: number): number => {
      const children = byParent.get(id) ?? [];
      if (children.length === 0) return depth;
      return Math.max(...children.map((c) => walk(c.id, depth + 1)));
    };
    return walk(rootId, 0);
  }

  threadStats(rootId: string): ThreadStats {
    const thread = this.collectThread(rootId);
    const participants = new Set(thread.map((m) => m.sender));
    const latencies: number[] = [];
    const byId = new Map(thread.map((m) => [m.id, m]));
    for (const m of thread) {
      if (m.replyToId) {
        const parent = byId.get(m.replyToId);
        if (parent) latencies.push(m.ts - parent.ts);
      }
    }
    return {
      depth: this.threadDepth(rootId),
      participantCount: participants.size,
      averageReplyLatencyMs:
        latencies.length === 0 ? 0 : latencies.reduce((a, b) => a + b, 0) / latencies.length,
      messageCount: thread.length,
    };
  }

  private collectThread(rootId: string): ConversationMessage[] {
    const result: ConversationMessage[] = [];
    const queue: string[] = [rootId];
    const visited = new Set<string>();
    const byParent = new Map<string, ConversationMessage[]>();
    for (const m of this.messages) {
      if (m.replyToId) {
        const arr = byParent.get(m.replyToId) ?? [];
        arr.push(m);
        byParent.set(m.replyToId, arr);
      }
    }
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const msg = this.messages.find((m) => m.id === id);
      if (msg) result.push(msg);
      for (const child of byParent.get(id) ?? []) {
        queue.push(child.id);
      }
    }
    return result;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   10. BotPerformanceMonitor
   ───────────────────────────────────────────────────────────────────────── */

export interface CommandExecution {
  command: string;
  durationMs: number;
  success: boolean;
  ts: EpochMs;
}

export interface BotPerformanceSummary {
  totalExecutions: number;
  successRate: number;
  averageDurationMs: number;
  p99DurationMs: number;
  slowestCommand: string | null;
}

/**
 * Monitors bot command execution times and success rates.
 */
export class BotPerformanceMonitor {
  private readonly executions: CommandExecution[] = [];

  record(command: string, durationMs: number, success: boolean, ts: EpochMs = Date.now()): void {
    this.executions.push({ command, durationMs, success, ts });
  }

  summary(): BotPerformanceSummary {
    if (this.executions.length === 0) {
      return { totalExecutions: 0, successRate: 1, averageDurationMs: 0, p99DurationMs: 0, slowestCommand: null };
    }
    const successes = this.executions.filter((e) => e.success).length;
    const durations = this.executions.map((e) => e.durationMs);
    const averageDurationMs = durations.reduce((a, b) => a + b, 0) / durations.length;
    const p99DurationMs = computeP99Latency(durations);
    const slowest = this.executions.reduce((a, b) => (a.durationMs > b.durationMs ? a : b));
    return {
      totalExecutions: this.executions.length,
      successRate: successes / this.executions.length,
      averageDurationMs,
      p99DurationMs,
      slowestCommand: slowest.command,
    };
  }

  commandStats(command: string): { count: number; averageMs: number; successRate: number } {
    const execs = this.executions.filter((e) => e.command === command);
    if (execs.length === 0) return { count: 0, averageMs: 0, successRate: 1 };
    const successes = execs.filter((e) => e.success).length;
    const averageMs = execs.reduce((a, b) => a + b.durationMs, 0) / execs.length;
    return { count: execs.length, averageMs, successRate: successes / execs.length };
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   11. ErrorTracker
   ───────────────────────────────────────────────────────────────────────── */

export interface ErrorRecord {
  code: string;
  message: string;
  stack?: string;
  ts: EpochMs;
  context?: string;
}

export interface ErrorSummary {
  totalErrors: number;
  uniqueCodes: number;
  topErrors: BucketCount[];
  recentErrors: ErrorRecord[];
}

/**
 * Centralised error recording with aggregation and top-error reporting.
 */
export class ErrorTracker {
  private readonly records: ErrorRecord[] = [];

  record(code: string, message: string, stack?: string, context?: string): void {
    this.records.push({ code, message, stack, ts: Date.now(), context });
  }

  recordError(err: Error, code = 'UNKNOWN', context?: string): void {
    this.record(code, err.message, err.stack, context);
  }

  summary(recentN = 10): ErrorSummary {
    const codeCounts = new Map<string, number>();
    for (const r of this.records) {
      codeCounts.set(r.code, (codeCounts.get(r.code) ?? 0) + 1);
    }
    const topErrors: BucketCount[] = Array.from(codeCounts.entries())
      .map(([bucket, count]) => ({ bucket, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    return {
      totalErrors: this.records.length,
      uniqueCodes: codeCounts.size,
      topErrors,
      recentErrors: this.records.slice(-recentN),
    };
  }

  errorsInWindow(window: TimeWindow): ErrorRecord[] {
    return this.records.filter((r) => r.ts >= window.startMs && r.ts <= window.endMs);
  }

  clear(): void {
    this.records.length = 0;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   12. HealthChecker
   ───────────────────────────────────────────────────────────────────────── */

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface HealthCheck {
  name: string;
  fn: () => Promise<boolean> | boolean;
}

export interface HealthReport {
  status: HealthStatus;
  checks: Array<{ name: string; ok: boolean; durationMs: number }>;
  ts: EpochMs;
}

/**
 * Runs named health check functions and aggregates the results into a
 * structured health report.
 */
export class HealthChecker {
  private readonly checks: HealthCheck[] = [];

  register(check: HealthCheck): void {
    this.checks.push(check);
  }

  async run(): Promise<HealthReport> {
    const results: HealthReport['checks'] = [];
    for (const check of this.checks) {
      const start = Date.now();
      let ok = false;
      try {
        ok = await check.fn();
      } catch {
        ok = false;
      }
      results.push({ name: check.name, ok, durationMs: Date.now() - start });
    }
    const failCount = results.filter((r) => !r.ok).length;
    let status: HealthStatus = 'healthy';
    if (failCount === results.length && results.length > 0) status = 'unhealthy';
    else if (failCount > 0) status = 'degraded';
    return { status, checks: results, ts: Date.now() };
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   13. AlertManager
   ───────────────────────────────────────────────────────────────────────── */

export interface Alert {
  id: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  ts: EpochMs;
  resolved: boolean;
}

export type AlertHandler = (alert: Alert) => void | Promise<void>;

/**
 * Issues, tracks and resolves named alerts with configurable severity
 * levels and subscriber callbacks.
 */
export class AlertManager {
  private readonly alerts: Alert[] = [];
  private readonly handlers: AlertHandler[] = [];
  private idCounter = 0;

  subscribe(handler: AlertHandler): () => void {
    this.handlers.push(handler);
    return () => {
      const idx = this.handlers.indexOf(handler);
      if (idx >= 0) this.handlers.splice(idx, 1);
    };
  }

  async raise(severity: AlertSeverity, title: string, message: string): Promise<Alert> {
    const alert: Alert = {
      id: `alert_${++this.idCounter}`,
      severity,
      title,
      message,
      ts: Date.now(),
      resolved: false,
    };
    this.alerts.push(alert);
    for (const handler of this.handlers) {
      await handler(alert);
    }
    return alert;
  }

  resolve(id: string): boolean {
    const alert = this.alerts.find((a) => a.id === id);
    if (!alert) return false;
    alert.resolved = true;
    return true;
  }

  active(): Alert[] {
    return this.alerts.filter((a) => !a.resolved);
  }

  history(): Alert[] {
    return [...this.alerts];
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   14. ReportGenerator
   ───────────────────────────────────────────────────────────────────────── */

export interface ReportSection {
  title: string;
  data: unknown;
}

export interface Report {
  title: string;
  generatedAt: EpochMs;
  window: TimeWindow;
  sections: ReportSection[];
}

/**
 * Collects data from multiple analytics sources and assembles them into a
 * structured report snapshot.
 */
export class ReportGenerator {
  private readonly sections: ReportSection[] = [];

  addSection(title: string, data: unknown): void {
    this.sections.push({ title, data });
  }

  generate(title: string, window: TimeWindow): Report {
    return {
      title,
      generatedAt: Date.now(),
      window,
      sections: [...this.sections],
    };
  }

  toJson(report: Report): string {
    return JSON.stringify(report, null, 2);
  }

  reset(): void {
    this.sections.length = 0;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   15. DashboardDataCollector
   ───────────────────────────────────────────────────────────────────────── */

export interface DashboardSnapshot {
  ts: EpochMs;
  messageMetrics: MessageMetricsSummary;
  connectionStats: ConnectionStats;
  mediaSummary: MediaAnalyticsSummary;
  userBehavior: UserBehaviorSummary;
  errorSummary: ErrorSummary;
  health: HealthReport;
}

/**
 * Aggregates live data from all major analytics subsystems into a single
 * snapshot suitable for a monitoring dashboard.
 */
export class DashboardDataCollector {
  constructor(
    private readonly messageMetrics: MessageMetrics,
    private readonly connectionMonitor: ConnectionMonitor,
    private readonly mediaAnalytics: MediaAnalytics,
    private readonly userBehavior: UserBehaviorTracker,
    private readonly errorTracker: ErrorTracker,
    private readonly healthChecker: HealthChecker,
  ) {}

  async snapshot(): Promise<DashboardSnapshot> {
    const health = await this.healthChecker.run();
    return {
      ts: Date.now(),
      messageMetrics: this.messageMetrics.summary(),
      connectionStats: this.connectionMonitor.stats(),
      mediaSummary: this.mediaAnalytics.summary(),
      userBehavior: this.userBehavior.summary(),
      errorSummary: this.errorTracker.summary(),
      health,
    };
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   Standalone utility functions
   ───────────────────────────────────────────────────────────────────────── */

/** Sort a numeric array in-place and return it. */
function sortedCopy(values: number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/** Pick a percentile value from a pre-sorted array (0 < p < 100). */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(idx, 0), sorted.length - 1)] ?? 0;
}

/**
 * Compute the engagement rate: (reactions + replies) / total messages.
 */
export function computeEngagementRate(totalMessages: number, reactions: number, replies: number): number {
  if (totalMessages === 0) return 0;
  return (reactions + replies) / totalMessages;
}

/**
 * Fraction of inbound messages that received a reply within a conversation.
 */
export function computeResponseRate(received: number, replied: number): number {
  if (received === 0) return 0;
  return replied / received;
}

/** Mean of a latency sample array. */
export function computeAverageLatency(samples: number[]): number {
  if (samples.length === 0) return 0;
  return samples.reduce((a, b) => a + b, 0) / samples.length;
}

/** Median (p50) of a latency sample array. */
export function computeMedianLatency(samples: number[]): number {
  return percentile(sortedCopy(samples), 50);
}

/** 99th-percentile latency. */
export function computeP99Latency(samples: number[]): number {
  return percentile(sortedCopy(samples), 99);
}

/** Error rate: errors / total operations. */
export function computeErrorRate(errors: number, total: number): number {
  if (total === 0) return 0;
  return errors / total;
}

/**
 * Retention rate: fraction of users who remain active after a time window.
 * @param cohortSize  Number of users at the start of the window.
 * @param retained    Number still active at the end of the window.
 */
export function computeRetentionRate(cohortSize: number, retained: number): number {
  if (cohortSize === 0) return 0;
  return retained / cohortSize;
}

/**
 * Detect statistical anomalies in a time series using a simple z-score
 * threshold (default σ > 2.5).
 */
export function detectAnomalies(
  series: number[],
  threshold = 2.5,
): Array<{ index: number; value: number; zScore: number }> {
  if (series.length < 2) return [];
  const mean = series.reduce((a, b) => a + b, 0) / series.length;
  const variance = series.reduce((a, b) => a + (b - mean) ** 2, 0) / series.length;
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return [];
  return series
    .map((value, index) => ({ index, value, zScore: Math.abs(value - mean) / stdDev }))
    .filter((r) => r.zScore > threshold);
}

/**
 * Forecast the next N values using simple linear regression.
 */
export function forecastActivity(series: number[], steps = 5): number[] {
  const n = series.length;
  if (n === 0) return Array(steps).fill(0) as number[];
  const xs = series.map((_, i) => i);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = series.reduce((a, b) => a + b, 0) / n;
  const ssXX = xs.reduce((a, x) => a + (x - meanX) ** 2, 0);
  const ssXY = xs.reduce((a, x, i) => a + (x - meanX) * ((series[i] ?? 0) - meanY), 0);
  const slope = ssXX === 0 ? 0 : ssXY / ssXX;
  const intercept = meanY - slope * meanX;
  return Array.from({ length: steps }, (_, i) => intercept + slope * (n + i));
}

/**
 * Bucket timestamps into hour-of-day slots and return a 24-bucket heatmap.
 */
export function generateHeatmap(timestamps: EpochMs[]): BucketCount[] {
  const counts: number[] = Array(24).fill(0) as number[];
  for (const ts of timestamps) {
    const hour = new Date(ts).getHours();
    counts[hour] = (counts[hour] ?? 0) + 1;
  }
  return counts.map((count, hour) => ({ bucket: String(hour).padStart(2, '0') + ':00', count }));
}

/** Count word frequencies in a body of text. */
export function computeWordFrequency(text: string): Map<string, number> {
  const freq = new Map<string, number>();
  for (const word of text.toLowerCase().match(/\b[a-z]{2,}\b/g) ?? []) {
    freq.set(word, (freq.get(word) ?? 0) + 1);
  }
  return freq;
}

/** Rank senders by message count. */
export function computeTopContributors(
  messages: Array<{ sender: string }>,
  topN = 10,
): BucketCount[] {
  const counts = new Map<string, number>();
  for (const m of messages) {
    counts.set(m.sender, (counts.get(m.sender) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([bucket, count]) => ({ bucket, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);
}

/**
 * Group engagement: (active members / total members) in a given window.
 */
export function computeGroupEngagement(totalMembers: number, activeMembers: number): number {
  if (totalMembers === 0) return 0;
  return activeMembers / totalMembers;
}

/** Return the hours-of-day (0-23) with the highest message volume. */
export function computePeakHours(timestamps: EpochMs[], topN = 3): number[] {
  const heatmap = generateHeatmap(timestamps);
  return heatmap
    .sort((a, b) => b.count - a.count)
    .slice(0, topN)
    .map((b) => parseInt(b.bucket, 10));
}

/**
 * Message velocity: messages per minute in the supplied window.
 */
export function computeMessageVelocity(messageCount: number, windowMs: number): number {
  if (windowMs === 0) return 0;
  return messageCount / (windowMs / 60_000);
}

/** Count distinct sender JIDs. */
export function computeUniqueUsers(messages: Array<{ sender: string }>): number {
  return new Set(messages.map((m) => m.sender)).size;
}

/** Median character count across a set of messages. */
export function computeMedianMessageLength(messages: Array<{ text: string }>): number {
  const lengths = messages.map((m) => m.text.length);
  return computeMedianLatency(lengths);
}

/**
 * Count how many times each emoji appears across a corpus of messages.
 * Uses the Unicode emoji regex segment.
 */
export function computeEmojiFrequency(texts: string[]): Map<string, number> {
  const emojiRe = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu;
  const freq = new Map<string, number>();
  for (const text of texts) {
    for (const match of text.matchAll(emojiRe)) {
      const emoji = match[0];
      freq.set(emoji, (freq.get(emoji) ?? 0) + 1);
    }
  }
  return freq;
}

/**
 * Heuristically flag whether a sender exhibits bot-like behaviour based on
 * coefficient-of-variation of inter-message gaps and a minimum message count.
 */
export function detectBotPattern(
  timestamps: EpochMs[],
  options: { cvThreshold?: number; minMessages?: number } = {},
): boolean {
  const { cvThreshold = 0.15, minMessages = 10 } = options;
  if (timestamps.length < minMessages) return false;
  const sorted = sortedCopy(timestamps);
  const gaps = sorted.slice(1).map((t, i) => t - (sorted[i] ?? 0));
  if (gaps.length === 0) return false;
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  if (mean === 0) return true; // all at same instant — definitely bot
  const variance = gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length;
  const cv = Math.sqrt(variance) / mean;
  return cv < cvThreshold;
}

/** Churn rate: users who left / users at start. */
export function computeChurnRate(usersAtStart: number, usersWhoLeft: number): number {
  if (usersAtStart === 0) return 0;
  return usersWhoLeft / usersAtStart;
}

/** Growth rate: (end - start) / start. */
export function computeGrowthRate(startCount: number, endCount: number): number {
  if (startCount === 0) return 0;
  return (endCount - startCount) / startCount;
}

/**
 * Satisfaction score (CSAT): fraction of interactions rated positively.
 * Ratings should be in range [1, 5]; positive is ≥ 4.
 */
export function computeSatisfactionScore(ratings: number[]): number {
  if (ratings.length === 0) return 0;
  const positive = ratings.filter((r) => r >= 4).length;
  return positive / ratings.length;
}

/**
 * Net Promoter Score: (promoters − detractors) / total × 100.
 * Promoters are scores 9-10, detractors are 0-6 (out of 10).
 */
export function computeNetPromoterScore(scores: number[]): number {
  if (scores.length === 0) return 0;
  const promoters = scores.filter((s) => s >= 9).length;
  const detractors = scores.filter((s) => s <= 6).length;
  return ((promoters - detractors) / scores.length) * 100;
}

export interface FunnelStep {
  name: string;
  count: number;
}

/**
 * Track conversion funnel: attach drop-off rates to each step.
 */
export function trackConversionFunnel(
  steps: FunnelStep[],
): Array<FunnelStep & { conversionRate: number; dropOffRate: number }> {
  return steps.map((step, i) => {
    const previous = i === 0 ? step.count : (steps[i - 1]?.count ?? step.count);
    const conversionRate = previous === 0 ? 0 : step.count / previous;
    return { ...step, conversionRate, dropOffRate: 1 - conversionRate };
  });
}

/**
 * Return the maximum thread depth found across all root messages.
 * Roots are messages with no `replyToId`.
 */
export function analyzeThreadDepth(messages: ConversationMessage[]): number {
  const analyzer = new ConversationFlowAnalyzer();
  for (const m of messages) analyzer.addMessage(m);
  const roots = messages.filter((m) => !m.replyToId);
  if (roots.length === 0) return 0;
  return Math.max(...roots.map((r) => analyzer.threadDepth(r.id)));
}

/**
 * Compute the average latency between a prompt message and its replies.
 */
export function computeReplyLatency(
  messages: Array<{ id: string; ts: EpochMs; replyToId?: string }>,
): number {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const latencies: number[] = [];
  for (const m of messages) {
    if (m.replyToId) {
      const parent = byId.get(m.replyToId);
      if (parent) latencies.push(m.ts - parent.ts);
    }
  }
  return computeAverageLatency(latencies);
}

/**
 * Read rate: fraction of delivered messages that were marked as read.
 */
export function computeReadRate(delivered: number, read: number): number {
  if (delivered === 0) return 0;
  return read / delivered;
}

/**
 * Forward rate: fraction of received messages that were forwarded.
 */
export function computeForwardRate(received: number, forwarded: number): number {
  if (received === 0) return 0;
  return forwarded / received;
}

/**
 * Delete rate: fraction of sent messages that were deleted by the sender.
 */
export function computeDeleteRate(sent: number, deleted: number): number {
  if (sent === 0) return 0;
  return deleted / sent;
}

/**
 * Distribution of reaction emojis across a set of reaction events.
 */
export function computeReactionDistribution(
  reactions: Array<{ emoji: string }>,
): Map<string, number> {
  const dist = new Map<string, number>();
  for (const r of reactions) {
    dist.set(r.emoji, (dist.get(r.emoji) ?? 0) + 1);
  }
  return dist;
}

/* ─────────────────────────────────────────────────────────────────────────
   Additional standalone helpers (bringing total well above 50 exports)
   ───────────────────────────────────────────────────────────────────────── */

/** Compute full latency percentiles from a raw sample array. */
export function computeLatencyPercentiles(samples: number[]): LatencyPercentiles {
  const s = sortedCopy(samples);
  return {
    p50: percentile(s, 50),
    p75: percentile(s, 75),
    p90: percentile(s, 90),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
  };
}

/** Moving average over the last `windowSize` values of a series. */
export function movingAverage(series: number[], windowSize: number): number[] {
  if (windowSize <= 0) return [...series];
  return series.map((_, i) => {
    const start = Math.max(0, i - windowSize + 1);
    const slice = series.slice(start, i + 1);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });
}

/** Normalise an array of numbers to the [0, 1] range. */
export function normalise(values: number[]): number[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  if (range === 0) return values.map(() => 0);
  return values.map((v) => (v - min) / range);
}

/** Convert a Map<string, number> to a sorted BucketCount array. */
export function mapToBuckets(map: Map<string, number>): BucketCount[] {
  return Array.from(map.entries())
    .map(([bucket, count]) => ({ bucket, count }))
    .sort((a, b) => b.count - a.count);
}

/** Total byte count across an array of media records. */
export function totalMediaBytes(records: MediaRecord[]): number {
  return records.reduce((a, r) => a + r.sizeBytes, 0);
}

/** Convert milliseconds to a human-readable duration string. */
export function formatDurationMs(ms: number): string {
  const s = Math.floor(ms / 1_000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/** Create a rolling time window ending now. */
export function rollingWindow(durationMs: number, now: EpochMs = Date.now()): TimeWindow {
  return { startMs: now - durationMs, endMs: now };
}

/** Partition an array into chunks of size n. */
export function chunkArray<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) {
    out.push(arr.slice(i, i + n));
  }
  return out;
}

/** Deduplicate an array by a key selector. */
export function deduplicateBy<T>(arr: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return arr.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
