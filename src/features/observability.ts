/**
 * @file observability.ts
 * @description Full-stack observability primitives for Nyx-Baileys.
 * Covers metrics collection, distributed tracing, structured logging,
 * health checks, alerting, circuit breakers, bulkheads, event bus,
 * metric sinks, and many standalone utility helpers.
 *
 * Only Node.js built-ins are used: node:crypto, node:perf_hooks,
 * node:process, node:os, node:fs, node:http.
 */

import { randomBytes, createHash } from 'node:crypto';
import { performance, PerformanceObserver } from 'node:perf_hooks';
import { hrtime } from 'node:process';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as http from 'node:http';

// ─── Shared primitive types ───────────────────────────────────────────────────

export type Labels = Record<string, string>;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type HealthStatus = 'up' | 'degraded' | 'down';

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface SpanContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  sampled: boolean;
  baggage: Record<string, string>;
}

export interface Span {
  context: SpanContext;
  operationName: string;
  startTime: number; // epoch ms
  endTime?: number;
  duration?: number; // ms
  attributes: Record<string, string | number | boolean>;
  events: SpanEvent[];
  status: 'ok' | 'error' | 'unset';
  errorMessage?: string;
}

export interface SpanEvent {
  name: string;
  timestamp: number; // epoch ms
  attributes: Record<string, string | number | boolean>;
}

export interface HealthCheckResult {
  name: string;
  status: HealthStatus;
  message?: string;
  durationMs: number;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface AlertRule {
  id: string;
  name: string;
  metric: string;
  condition: (value: number) => boolean;
  severity: Severity;
  cooldownMs: number;
  message: string;
}

export interface Alert {
  ruleId: string;
  ruleName: string;
  severity: Severity;
  message: string;
  value: number;
  timestamp: number;
}

export interface SLOResult {
  slo: number;       // target (0–1)
  actual: number;    // achieved (0–1)
  met: boolean;
  errorBudgetRemaining: number; // (0–1)
}

export interface MTTRResult {
  incidentCount: number;
  totalRepairTimeMs: number;
  mttrMs: number;
}

export interface MTTDResult {
  incidentCount: number;
  totalDetectionTimeMs: number;
  mttdMs: number;
}

export interface ApdexResult {
  score: number;       // 0–1
  satisfied: number;
  tolerating: number;
  frustrated: number;
  total: number;
}

export interface MetricPoint {
  name: string;
  labels: Labels;
  value: number;
  timestamp: number; // epoch ms
  type: 'counter' | 'gauge' | 'histogram' | 'summary';
}

export interface HistogramBucket {
  le: number;
  count: number;
}

export interface HistogramData {
  buckets: HistogramBucket[];
  sum: number;
  count: number;
  min: number;
  max: number;
}

export interface SummaryQuantile {
  quantile: number;
  value: number;
}

export interface SummaryData {
  quantiles: SummaryQuantile[];
  sum: number;
  count: number;
}

// ─── Utility helpers ──────────────────────────────────────────────────────────

function labelKey(labels: Labels): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`)
    .join(',');
}

function nowMs(): number {
  return Date.now();
}

function hrtimeMs(): number {
  const [s, ns] = hrtime();
  return s * 1_000 + ns / 1_000_000;
}

// ─── MetricsCollector ─────────────────────────────────────────────────────────

/**
 * Collects counters, gauges, histograms, and summaries with label support.
 */
export class MetricsCollector {
  private counters = new Map<string, Map<string, number>>();
  private gauges = new Map<string, Map<string, number>>();
  private histograms = new Map<string, Map<string, HistogramData>>();
  private summaryWindows = new Map<string, Map<string, number[]>>();
  private readonly defaultBuckets: number[];

  constructor(
    defaultBuckets: number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  ) {
    this.defaultBuckets = defaultBuckets;
  }

  // --- Counters ---

  /** Increment a counter by `amount` (default 1). */
  incrementCounter(name: string, labels: Labels = {}, amount = 1): void {
    const key = labelKey(labels);
    const map = this.counters.get(name) ?? new Map<string, number>();
    map.set(key, (map.get(key) ?? 0) + amount);
    this.counters.set(name, map);
  }

  /** Reset a counter to 0. */
  resetCounter(name: string, labels: Labels = {}): void {
    const key = labelKey(labels);
    this.counters.get(name)?.set(key, 0);
  }

  /** Get current counter value. */
  getCounter(name: string, labels: Labels = {}): number {
    return this.counters.get(name)?.get(labelKey(labels)) ?? 0;
  }

  // --- Gauges ---

  /** Set a gauge to an absolute value. */
  setGauge(name: string, value: number, labels: Labels = {}): void {
    const key = labelKey(labels);
    const map = this.gauges.get(name) ?? new Map<string, number>();
    map.set(key, value);
    this.gauges.set(name, map);
  }

  /** Increment a gauge. */
  incrementGauge(name: string, labels: Labels = {}, amount = 1): void {
    const key = labelKey(labels);
    const map = this.gauges.get(name) ?? new Map<string, number>();
    map.set(key, (map.get(key) ?? 0) + amount);
    this.gauges.set(name, map);
  }

  /** Decrement a gauge. */
  decrementGauge(name: string, labels: Labels = {}, amount = 1): void {
    this.incrementGauge(name, labels, -amount);
  }

  /** Get current gauge value. */
  getGauge(name: string, labels: Labels = {}): number {
    return this.gauges.get(name)?.get(labelKey(labels)) ?? 0;
  }

  // --- Histograms ---

  /** Observe a value into a histogram. */
  observeHistogram(name: string, value: number, labels: Labels = {}, buckets?: number[]): void {
    const key = labelKey(labels);
    const map = this.histograms.get(name) ?? new Map<string, HistogramData>();
    const bkts = buckets ?? this.defaultBuckets;
    const existing = map.get(key) ?? {
      buckets: bkts.map(le => ({ le, count: 0 })),
      sum: 0,
      count: 0,
      min: Infinity,
      max: -Infinity,
    };
    existing.sum += value;
    existing.count += 1;
    if (value < existing.min) existing.min = value;
    if (value > existing.max) existing.max = value;
    for (const b of existing.buckets) {
      if (value <= b.le) b.count += 1;
    }
    map.set(key, existing);
    this.histograms.set(name, map);
  }

  /** Retrieve histogram data. */
  getHistogram(name: string, labels: Labels = {}): HistogramData | undefined {
    return this.histograms.get(name)?.get(labelKey(labels));
  }

  // --- Summaries ---

  /** Observe a value for a rolling-window summary. */
  observeSummary(name: string, value: number, labels: Labels = {}): void {
    const key = labelKey(labels);
    const map = this.summaryWindows.get(name) ?? new Map<string, number[]>();
    const window = map.get(key) ?? [];
    window.push(value);
    // Keep last 1000 observations
    if (window.length > 1_000) window.shift();
    map.set(key, window);
    this.summaryWindows.set(name, map);
  }

  /** Compute summary quantiles (0.5, 0.9, 0.95, 0.99 by default). */
  getSummary(
    name: string,
    labels: Labels = {},
    quantiles: number[] = [0.5, 0.9, 0.95, 0.99],
  ): SummaryData {
    const key = labelKey(labels);
    const window = [...(this.summaryWindows.get(name)?.get(key) ?? [])];
    window.sort((a, b) => a - b);
    const sum = window.reduce((acc, v) => acc + v, 0);
    return {
      quantiles: quantiles.map(q => ({
        quantile: q,
        value: window.length === 0 ? 0 : (window[Math.ceil(q * window.length) - 1] ?? 0),
      })),
      sum,
      count: window.length,
    };
  }

  /** Dump all metrics as an array of MetricPoint snapshots. */
  snapshot(): MetricPoint[] {
    const points: MetricPoint[] = [];
    const ts = nowMs();

    for (const [name, labelMap] of this.counters) {
      for (const [key, value] of labelMap) {
        points.push({ name, labels: parseKey(key), value, timestamp: ts, type: 'counter' });
      }
    }
    for (const [name, labelMap] of this.gauges) {
      for (const [key, value] of labelMap) {
        points.push({ name, labels: parseKey(key), value, timestamp: ts, type: 'gauge' });
      }
    }
    for (const [name, labelMap] of this.histograms) {
      for (const [key, data] of labelMap) {
        points.push({
          name,
          labels: parseKey(key),
          value: data.count === 0 ? 0 : data.sum / data.count,
          timestamp: ts,
          type: 'histogram',
        });
      }
    }
    for (const [name, labelMap] of this.summaryWindows) {
      for (const [key, window] of labelMap) {
        const sum = window.reduce((a, v) => a + v, 0);
        points.push({
          name,
          labels: parseKey(key),
          value: window.length === 0 ? 0 : sum / window.length,
          timestamp: ts,
          type: 'summary',
        });
      }
    }
    return points;
  }
}

/** Parse a label key string back into a Labels object. */
function parseKey(key: string): Labels {
  if (!key) return {};
  const result: Labels = {};
  for (const pair of key.split(',')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const k = pair.slice(0, eqIdx);
    const v = pair.slice(eqIdx + 2, -1); // strip quotes
    result[k] = v;
  }
  return result;
}

// ─── TraceManager ─────────────────────────────────────────────────────────────

/**
 * Lightweight distributed tracing — starts/ends spans, propagates context,
 * adds events and attributes.
 */
export class TraceManager {
  private spans = new Map<string, Span>();
  private activeContext: SpanContext | null = null;

  /** Begin a new span, optionally child of a parent context. */
  startSpan(operationName: string, parent?: SpanContext): Span {
    const context: SpanContext = {
      traceId: parent?.traceId ?? generateTraceId(),
      spanId: generateSpanId(),
      parentSpanId: parent?.spanId,
      sampled: parent?.sampled ?? true,
      baggage: { ...(parent?.baggage ?? {}) },
    };
    const span: Span = {
      context,
      operationName,
      startTime: nowMs(),
      attributes: {},
      events: [],
      status: 'unset',
    };
    this.spans.set(context.spanId, span);
    this.activeContext = context;
    return span;
  }

  /** Finish a span and compute its duration. */
  endSpan(span: Span, error?: Error): void {
    span.endTime = nowMs();
    span.duration = span.endTime - span.startTime;
    if (error) {
      span.status = 'error';
      span.errorMessage = error.message;
    } else if (span.status === 'unset') {
      span.status = 'ok';
    }
    if (this.activeContext?.spanId === span.context.spanId) {
      this.activeContext = null;
    }
  }

  /** Add a named event to an in-flight span. */
  addEvent(
    span: Span,
    name: string,
    attributes: Record<string, string | number | boolean> = {},
  ): void {
    span.events.push({ name, timestamp: nowMs(), attributes });
  }

  /** Set a key-value attribute on a span. */
  setAttribute(span: Span, key: string, value: string | number | boolean): void {
    span.attributes[key] = value;
  }

  /** Propagate current active context. */
  propagateContext(): SpanContext | null {
    return this.activeContext;
  }

  /** Look up a stored span by its span-id. */
  getSpan(spanId: string): Span | undefined {
    return this.spans.get(spanId);
  }

  /** Return all completed spans. */
  completedSpans(): Span[] {
    return [...this.spans.values()].filter(s => s.endTime !== undefined);
  }

  /** Clear all stored spans. */
  clearSpans(): void {
    this.spans.clear();
  }
}

// ─── StructuredLogger ─────────────────────────────────────────────────────────

const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string; // ISO-8601
  context: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Structured JSON logger with log levels, child loggers with context,
 * and automatic redaction of sensitive fields.
 */
export class StructuredLogger {
  private readonly context: Record<string, unknown>;
  private readonly minLevel: LogLevel;
  private readonly sensitiveFields: Set<string>;
  private readonly sink: (entry: LogEntry) => void;

  constructor(options: {
    context?: Record<string, unknown>;
    minLevel?: LogLevel;
    sensitiveFields?: string[];
    sink?: (entry: LogEntry) => void;
  } = {}) {
    this.context = options.context ?? {};
    this.minLevel = options.minLevel ?? 'info';
    this.sensitiveFields = new Set(
      options.sensitiveFields ?? ['password', 'token', 'secret', 'apiKey', 'authorization', 'cookie'],
    );
    this.sink = options.sink ?? ((entry: LogEntry) => process.stdout.write(JSON.stringify(entry) + '\n'));
  }

  /** Create a child logger that inherits and extends this context. */
  child(extraContext: Record<string, unknown>): StructuredLogger {
    return new StructuredLogger({
      context: { ...this.context, ...extraContext },
      minLevel: this.minLevel,
      sensitiveFields: [...this.sensitiveFields],
      sink: this.sink,
    });
  }

  private write(level: LogLevel, message: string, extra: Record<string, unknown> = {}): void {
    if (LOG_LEVEL_RANK[level] < LOG_LEVEL_RANK[this.minLevel]) return;
    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      context: this.redact(this.context),
      ...this.redact(extra),
    };
    this.sink(entry);
  }

  private redact(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (this.sensitiveFields.has(k)) {
        result[k] = '[REDACTED]';
      } else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        result[k] = this.redact(v as Record<string, unknown>);
      } else {
        result[k] = v;
      }
    }
    return result;
  }

  debug(message: string, extra?: Record<string, unknown>): void {
    this.write('debug', message, extra);
  }
  info(message: string, extra?: Record<string, unknown>): void {
    this.write('info', message, extra);
  }
  warn(message: string, extra?: Record<string, unknown>): void {
    this.write('warn', message, extra);
  }
  error(message: string, extra?: Record<string, unknown>): void {
    this.write('error', message, extra);
  }
  fatal(message: string, extra?: Record<string, unknown>): void {
    this.write('fatal', message, extra);
  }
}

// ─── HealthCheckRegistry ──────────────────────────────────────────────────────

export type HealthCheckFn = () => Promise<Omit<HealthCheckResult, 'name' | 'durationMs' | 'timestamp'>>;

/**
 * Registry for named health-check probes. Runs all checks concurrently and
 * rolls up an overall status (up / degraded / down).
 */
export class HealthCheckRegistry {
  private readonly checks = new Map<string, HealthCheckFn>();

  /** Register a named health check function. */
  register(name: string, fn: HealthCheckFn): void {
    this.checks.set(name, fn);
  }

  /** Unregister a named health check. */
  unregister(name: string): void {
    this.checks.delete(name);
  }

  /** Run all registered health checks concurrently. */
  async runAll(): Promise<{ overall: HealthStatus; checks: HealthCheckResult[] }> {
    const results = await Promise.all(
      [...this.checks.entries()].map(async ([name, fn]) => {
        const start = hrtimeMs();
        try {
          const result = await fn();
          return {
            name,
            durationMs: hrtimeMs() - start,
            timestamp: nowMs(),
            ...result,
          } as HealthCheckResult;
        } catch (err: unknown) {
          return {
            name,
            status: 'down' as HealthStatus,
            message: err instanceof Error ? err.message : String(err),
            durationMs: hrtimeMs() - start,
            timestamp: nowMs(),
          };
        }
      }),
    );

    let overall: HealthStatus = 'up';
    for (const r of results) {
      if (r.status === 'down') { overall = 'down'; break; }
      if (r.status === 'degraded') overall = 'degraded';
    }
    return { overall, checks: results };
  }
}

// ─── AlertRulesEngine ─────────────────────────────────────────────────────────

/**
 * Evaluates metric values against alert rules.
 * Respects per-rule cooldown windows and routes to registered alert handlers.
 */
export class AlertRulesEngine {
  private readonly rules = new Map<string, AlertRule>();
  private readonly lastFired = new Map<string, number>();
  private readonly handlers: Array<(alert: Alert) => void> = [];

  /** Add or replace an alert rule. */
  defineRule(rule: AlertRule): void {
    this.rules.set(rule.id, rule);
  }

  /** Remove a rule by id. */
  removeRule(id: string): void {
    this.rules.delete(id);
    this.lastFired.delete(id);
  }

  /** Register a handler called when an alert fires. */
  onAlert(handler: (alert: Alert) => void): void {
    this.handlers.push(handler);
  }

  /** Evaluate a metric value against all matching rules. */
  evaluate(metricName: string, value: number): Alert[] {
    const fired: Alert[] = [];
    const now = nowMs();
    for (const rule of this.rules.values()) {
      if (rule.metric !== metricName) continue;
      if (!rule.condition(value)) continue;
      const last = this.lastFired.get(rule.id) ?? 0;
      if (now - last < rule.cooldownMs) continue;
      this.lastFired.set(rule.id, now);
      const alert: Alert = {
        ruleId: rule.id,
        ruleName: rule.name,
        severity: rule.severity,
        message: rule.message,
        value,
        timestamp: now,
      };
      fired.push(alert);
      for (const h of this.handlers) h(alert);
    }
    return fired;
  }

  /** List all currently defined rules. */
  listRules(): AlertRule[] {
    return [...this.rules.values()];
  }
}

// ─── DashboardDataProvider ────────────────────────────────────────────────────

export interface DashboardSnapshot {
  generatedAt: string;
  counters: Record<string, number>;
  gauges: Record<string, number>;
  histogramMeans: Record<string, number>;
  summaryMeans: Record<string, number>;
  healthOverall: HealthStatus;
  activeAlerts: Alert[];
}

/**
 * Aggregates metrics into a dashboard-ready JSON payload.
 */
export class DashboardDataProvider {
  constructor(
    private readonly collector: MetricsCollector,
    private readonly registry: HealthCheckRegistry,
    private readonly alertsEngine: AlertRulesEngine,
  ) {}

  private activeAlerts: Alert[] = [];

  /** Call this to push a new alert into the dashboard feed. */
  pushAlert(alert: Alert): void {
    this.activeAlerts.push(alert);
    // Keep last 100 alerts
    if (this.activeAlerts.length > 100) this.activeAlerts.shift();
  }

  /** Produce a full dashboard snapshot asynchronously. */
  async snapshot(): Promise<DashboardSnapshot> {
    const { overall } = await this.registry.runAll();
    const points = this.collector.snapshot();

    const counters: Record<string, number> = {};
    const gauges: Record<string, number> = {};
    const histogramMeans: Record<string, number> = {};
    const summaryMeans: Record<string, number> = {};

    for (const p of points) {
      const key = Object.keys(p.labels).length > 0
        ? `${p.name}{${labelKey(p.labels)}}`
        : p.name;
      if (p.type === 'counter') counters[key] = p.value;
      else if (p.type === 'gauge') gauges[key] = p.value;
      else if (p.type === 'histogram') histogramMeans[key] = p.value;
      else if (p.type === 'summary') summaryMeans[key] = p.value;
    }

    return {
      generatedAt: new Date().toISOString(),
      counters,
      gauges,
      histogramMeans,
      summaryMeans,
      healthOverall: overall,
      activeAlerts: [...this.activeAlerts],
    };
  }
}

// ─── EventBus ─────────────────────────────────────────────────────────────────

export type EventHandler<T = unknown> = (payload: T) => void | Promise<void>;

/**
 * Simple publish/subscribe event bus for internal decoupled communication.
 */
export class EventBus {
  private readonly subscribers = new Map<string, Array<EventHandler<unknown>>>();

  /** Subscribe to a named event. Returns an unsubscribe function. */
  subscribe<T = unknown>(event: string, handler: EventHandler<T>): () => void {
    const list = this.subscribers.get(event) ?? [];
    list.push(handler as EventHandler<unknown>);
    this.subscribers.set(event, list);
    return () => this.unsubscribe(event, handler);
  }

  /** Unsubscribe a specific handler from an event. */
  unsubscribe<T = unknown>(event: string, handler: EventHandler<T>): void {
    const list = this.subscribers.get(event);
    if (!list) return;
    const idx = list.indexOf(handler as EventHandler<unknown>);
    if (idx !== -1) list.splice(idx, 1);
  }

  /** Publish an event and invoke all subscribers. */
  async publish<T = unknown>(event: string, payload: T): Promise<void> {
    const list = this.subscribers.get(event) ?? [];
    await Promise.all(list.map(h => h(payload)));
  }

  /** Publish synchronously without awaiting async handlers. */
  publishSync<T = unknown>(event: string, payload: T): void {
    const list = this.subscribers.get(event) ?? [];
    for (const h of list) void h(payload);
  }

  /** Remove all subscribers for an event. */
  clearEvent(event: string): void {
    this.subscribers.delete(event);
  }

  /** Remove all subscribers for all events. */
  clearAll(): void {
    this.subscribers.clear();
  }
}

// ─── CircuitBreaker ───────────────────────────────────────────────────────────

export interface CircuitBreakerOptions {
  failureThreshold: number;   // failures before opening
  recoveryTimeoutMs: number;  // ms before attempting half-open
  successThreshold?: number;  // successes in half-open before closing
  onStateChange?: (prev: CircuitState, next: CircuitState) => void;
}

export class CircuitBreakerOpenError extends Error {
  constructor(name: string) {
    super(`Circuit breaker "${name}" is OPEN — request rejected`);
    this.name = 'CircuitBreakerOpenError';
  }
}

/**
 * Classic three-state circuit breaker: closed → open → half-open → closed.
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private successes = 0;
  private lastOpenedAt = 0;
  private readonly successThreshold: number;

  constructor(
    private readonly name: string,
    private readonly options: CircuitBreakerOptions,
  ) {
    this.successThreshold = options.successThreshold ?? 1;
  }

  get currentState(): CircuitState {
    return this.state;
  }

  /** Execute fn through the circuit breaker. Throws CircuitBreakerOpenError if open. */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastOpenedAt >= this.options.recoveryTimeoutMs) {
        this.transition('half-open');
      } else {
        throw new CircuitBreakerOpenError(this.name);
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    if (this.state === 'half-open') {
      this.successes += 1;
      if (this.successes >= this.successThreshold) {
        this.failures = 0;
        this.successes = 0;
        this.transition('closed');
      }
    } else {
      this.failures = 0;
    }
  }

  private onFailure(): void {
    this.failures += 1;
    this.successes = 0;
    if (this.state === 'half-open' || this.failures >= this.options.failureThreshold) {
      this.lastOpenedAt = Date.now();
      this.transition('open');
    }
  }

  private transition(next: CircuitState): void {
    const prev = this.state;
    if (prev === next) return;
    this.state = next;
    this.options.onStateChange?.(prev, next);
  }

  /** Manually reset to closed state. */
  reset(): void {
    this.failures = 0;
    this.successes = 0;
    this.transition('closed');
  }
}

// ─── BulkheadIsolator ─────────────────────────────────────────────────────────

export class BulkheadRejectedError extends Error {
  constructor(resource: string, limit: number) {
    super(`Bulkhead for "${resource}" is full — max concurrent operations: ${limit}`);
    this.name = 'BulkheadRejectedError';
  }
}

/**
 * Limits concurrent operations per named resource to prevent resource exhaustion.
 */
export class BulkheadIsolator {
  private readonly active = new Map<string, number>();
  private readonly limits: Map<string, number>;

  constructor(defaultLimit = 10) {
    this.limits = new Map();
    this._defaultLimit = defaultLimit;
  }

  private readonly _defaultLimit: number;

  /** Configure the concurrency limit for a specific resource. */
  setLimit(resource: string, limit: number): void {
    this.limits.set(resource, limit);
  }

  private getLimit(resource: string): number {
    return this.limits.get(resource) ?? this._defaultLimit;
  }

  /** Execute fn within the bulkhead for the given resource. */
  async execute<T>(resource: string, fn: () => Promise<T>): Promise<T> {
    const limit = this.getLimit(resource);
    const current = this.active.get(resource) ?? 0;
    if (current >= limit) throw new BulkheadRejectedError(resource, limit);

    this.active.set(resource, current + 1);
    try {
      return await fn();
    } finally {
      const after = (this.active.get(resource) ?? 1) - 1;
      if (after <= 0) this.active.delete(resource);
      else this.active.set(resource, after);
    }
  }

  /** Return current active count for a resource. */
  activeCount(resource: string): number {
    return this.active.get(resource) ?? 0;
  }
}

// ─── MetricsSink ──────────────────────────────────────────────────────────────

export type SinkTarget = 'console' | { type: 'file'; path: string } | { type: 'http'; url: string };

export interface MetricsSinkOptions {
  target: SinkTarget;
  flushIntervalMs?: number;
  batchSize?: number;
}

/**
 * Batches metric points and flushes them to console, a file, or an HTTP endpoint.
 */
export class MetricsSink {
  private readonly buffer: MetricPoint[] = [];
  private readonly batchSize: number;
  private readonly target: SinkTarget;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly collector: MetricsCollector, options: MetricsSinkOptions) {
    this.target = options.target;
    this.batchSize = options.batchSize ?? 100;

    if (options.flushIntervalMs) {
      this.timer = setInterval(() => void this.flush(), options.flushIntervalMs);
      if (typeof this.timer.unref === 'function') this.timer.unref();
    }
  }

  /** Collect current metrics into the buffer. */
  collect(): void {
    const points = this.collector.snapshot();
    this.buffer.push(...points);
    if (this.buffer.length >= this.batchSize) void this.flush();
  }

  /** Flush buffered metrics to the configured target. */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.batchSize);
    const payload = JSON.stringify(batch);

    if (this.target === 'console') {
      process.stdout.write(`[MetricsSink] ${payload}\n`);
    } else if (typeof this.target === 'object' && this.target.type === 'file') {
      await fs.promises.appendFile(this.target.path, payload + '\n', 'utf8');
    } else if (typeof this.target === 'object' && this.target.type === 'http') {
      await this.postHttp(this.target.url, payload);
    }
  }

  private postHttp(url: string, body: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const options: http.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      };
      const req = http.request(options, res => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  /** Stop the automatic flush timer. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

// ─── Standalone Functions ─────────────────────────────────────────────────────

/** Record a latency observation in the global default collector. */
export function recordLatency(
  collector: MetricsCollector,
  name: string,
  valueMs: number,
  labels: Labels = {},
): void {
  collector.observeHistogram(name, valueMs, labels);
}

/** Increment a throughput counter. */
export function recordThroughput(
  collector: MetricsCollector,
  name: string,
  labels: Labels = {},
  amount = 1,
): void {
  collector.incrementCounter(`${name}_throughput`, labels, amount);
}

/** Record an error occurrence. */
export function recordError(
  collector: MetricsCollector,
  name: string,
  labels: Labels = {},
): void {
  collector.incrementCounter(`${name}_errors_total`, labels);
}

/** Record a successful operation. */
export function recordSuccess(
  collector: MetricsCollector,
  name: string,
  labels: Labels = {},
): void {
  collector.incrementCounter(`${name}_success_total`, labels);
}

/** Start a high-resolution timer. Returns an opaque handle (start time in ms). */
export function startTimer(): number {
  return performance.now();
}

/** Stop a timer and return elapsed milliseconds. */
export function stopTimer(startHandle: number): number {
  return performance.now() - startHandle;
}

/**
 * Compute Apdex score from an array of response times.
 * @param samples   Response times in ms.
 * @param threshold Satisfied threshold T in ms.
 */
export function computeApdex(samples: number[], threshold: number): ApdexResult {
  let satisfied = 0;
  let tolerating = 0;
  let frustrated = 0;
  for (const s of samples) {
    if (s <= threshold) satisfied++;
    else if (s <= threshold * 4) tolerating++;
    else frustrated++;
  }
  const total = samples.length;
  const score = total === 0 ? 1 : (satisfied + tolerating * 0.5) / total;
  return { score, satisfied, tolerating, frustrated, total };
}

/**
 * Compute availability ratio.
 * @param uptimeMs    Total uptime in ms.
 * @param downtimeMs  Total downtime in ms.
 */
export function computeAvailability(uptimeMs: number, downtimeMs: number): number {
  const total = uptimeMs + downtimeMs;
  if (total === 0) return 1;
  return uptimeMs / total;
}

/**
 * Compute remaining error budget given an SLO target and current availability.
 * @param sloTarget   0–1 (e.g. 0.999 for 99.9 %)
 * @param availability  Current measured availability 0–1
 */
export function computeErrorBudget(sloTarget: number, availability: number): number {
  const totalErrorBudget = 1 - sloTarget;
  const consumed = sloTarget - availability;
  if (totalErrorBudget === 0) return 0;
  return Math.max(0, (totalErrorBudget - consumed) / totalErrorBudget);
}

/** Format a MetricsCollector snapshot as Prometheus text exposition. */
export function formatPrometheusMetrics(points: MetricPoint[]): string {
  const lines: string[] = [];
  for (const p of points) {
    const labelStr = Object.keys(p.labels).length > 0
      ? `{${Object.entries(p.labels).map(([k, v]) => `${k}="${v}"`).join(',')}}`
      : '';
    lines.push(`# TYPE ${p.name} ${p.type}`);
    lines.push(`${p.name}${labelStr} ${p.value} ${p.timestamp}`);
  }
  return lines.join('\n') + '\n';
}

/** Format metric points as InfluxDB line protocol. */
export function formatInfluxLineProtocol(points: MetricPoint[], measurement = 'nyx'): string {
  return points
    .map(p => {
      const tagStr = Object.keys(p.labels).length > 0
        ? ',' + Object.entries(p.labels).map(([k, v]) => `${k}=${v}`).join(',')
        : '';
      return `${measurement}${tagStr} ${p.name}=${p.value} ${p.timestamp * 1_000_000}`;
    })
    .join('\n');
}

/** Serialise a completed Span to an OpenTelemetry-compatible JSON object. */
export function formatOpenTelemetrySpan(span: Span): Record<string, unknown> {
  return {
    traceId: span.context.traceId,
    spanId: span.context.spanId,
    parentSpanId: span.context.parentSpanId ?? null,
    name: span.operationName,
    kind: 'SPAN_KIND_INTERNAL',
    startTimeUnixNano: String(BigInt(span.startTime) * 1_000_000n),
    endTimeUnixNano: span.endTime != null ? String(BigInt(span.endTime) * 1_000_000n) : null,
    attributes: Object.entries(span.attributes).map(([key, value]) => ({ key, value })),
    events: span.events.map(e => ({
      name: e.name,
      timeUnixNano: String(BigInt(e.timestamp) * 1_000_000n),
      attributes: Object.entries(e.attributes).map(([key, value]) => ({ key, value })),
    })),
    status: { code: span.status === 'ok' ? 1 : span.status === 'error' ? 2 : 0 },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
  };
}

/** Generate a 128-bit hex trace ID. */
export function generateTraceId(): string {
  return randomBytes(16).toString('hex');
}

/** Generate a 64-bit hex span ID. */
export function generateSpanId(): string {
  return randomBytes(8).toString('hex');
}

/** Correlate a trace ID with a set of span IDs, returning a lookup map. */
export function correlateTrace(
  traceId: string,
  spans: Span[],
): Map<string, Span[]> {
  const map = new Map<string, Span[]>();
  for (const span of spans) {
    if (span.context.traceId !== traceId) continue;
    const parent = span.context.parentSpanId ?? '__root__';
    const list = map.get(parent) ?? [];
    list.push(span);
    map.set(parent, list);
  }
  return map;
}

/**
 * Extract W3C traceparent / tracestate context from HTTP-style headers.
 * Returns null if not present or malformed.
 */
export function extractTraceContext(
  headers: Record<string, string | string[] | undefined>,
): SpanContext | null {
  const raw = headers['traceparent'];
  const traceparent = Array.isArray(raw) ? raw[0] : raw;
  if (!traceparent) return null;

  const parts = traceparent.split('-');
  if (parts.length < 4) return null;
  const [, traceId, spanId, flags] = parts as [string, string, string, string];
  const sampled = parseInt(flags ?? '0', 16) === 1;

  const baggage: Record<string, string> = {};
  const stateRaw = headers['tracestate'];
  const tracestate = Array.isArray(stateRaw) ? stateRaw[0] : stateRaw;
  if (tracestate) {
    for (const pair of tracestate.split(',')) {
      const [k, v] = pair.split('=');
      if (k && v) baggage[k.trim()] = v.trim();
    }
  }

  return { traceId: traceId ?? '', spanId: spanId ?? '', sampled, baggage };
}

/** Inject a SpanContext into a headers object as W3C traceparent. */
export function injectTraceContext(
  context: SpanContext,
  headers: Record<string, string>,
): void {
  headers['traceparent'] = `00-${context.traceId}-${context.spanId}-${context.sampled ? '01' : '00'}`;
  const baggage = Object.entries(context.baggage).map(([k, v]) => `${k}=${v}`).join(',');
  if (baggage) headers['tracestate'] = baggage;
}

/**
 * Sanitize a log field value: hash it if it matches a sensitive pattern.
 * Returns '[REDACTED:<hash>]' for sensitive values so you can still correlate.
 */
export function sanitizeLogField(key: string, value: string, sensitiveKeys: string[] = []): string {
  const defaultSensitive = ['password', 'token', 'secret', 'apikey', 'authorization', 'cookie'];
  const isSensitive = [...defaultSensitive, ...sensitiveKeys].some(k =>
    key.toLowerCase().includes(k.toLowerCase()),
  );
  if (!isSensitive) return value;
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 8);
  return `[REDACTED:${hash}]`;
}

/**
 * Compute SLO compliance.
 * @param sloTarget   0–1 target (e.g. 0.999)
 * @param goodEvents  Number of good events
 * @param totalEvents Total events
 */
export function computeSLO(
  sloTarget: number,
  goodEvents: number,
  totalEvents: number,
): SLOResult {
  const actual = totalEvents === 0 ? 1 : goodEvents / totalEvents;
  const met = actual >= sloTarget;
  const errorBudgetRemaining = computeErrorBudget(sloTarget, actual);
  return { slo: sloTarget, actual, met, errorBudgetRemaining };
}

export interface SLAConfig {
  uptimeTargetPercent: number; // e.g. 99.9
  measuredUptimeMs: number;
  totalWindowMs: number;
}

/**
 * Compute SLA compliance.
 * Returns the measured uptime % and whether it meets the SLA.
 */
export function computeSLA(config: SLAConfig): { targetPercent: number; actualPercent: number; met: boolean } {
  const actualPercent = config.totalWindowMs === 0
    ? 100
    : (config.measuredUptimeMs / config.totalWindowMs) * 100;
  return {
    targetPercent: config.uptimeTargetPercent,
    actualPercent,
    met: actualPercent >= config.uptimeTargetPercent,
  };
}

export interface Incident {
  detectedAt: number;   // epoch ms
  resolvedAt: number;   // epoch ms
}

/** Compute Mean Time To Repair (MTTR). */
export function computeMTTR(incidents: Incident[]): MTTRResult {
  const totalRepairTimeMs = incidents.reduce((acc, i) => acc + (i.resolvedAt - i.detectedAt), 0);
  return {
    incidentCount: incidents.length,
    totalRepairTimeMs,
    mttrMs: incidents.length === 0 ? 0 : totalRepairTimeMs / incidents.length,
  };
}

export interface DetectionIncident {
  occurredAt: number;   // epoch ms — when the incident actually started
  detectedAt: number;   // epoch ms — when it was detected/alerted
}

/** Compute Mean Time To Detect (MTTD). */
export function computeMTTD(incidents: DetectionIncident[]): MTTDResult {
  const totalDetectionTimeMs = incidents.reduce((acc, i) => acc + (i.detectedAt - i.occurredAt), 0);
  return {
    incidentCount: incidents.length,
    totalDetectionTimeMs,
    mttdMs: incidents.length === 0 ? 0 : totalDetectionTimeMs / incidents.length,
  };
}

export interface MemoryLeakResult {
  suspected: boolean;
  growthRateBytePerSec: number;
  sampleCount: number;
  samples: number[];
}

/**
 * Collect `sampleCount` RSS memory samples over `intervalMs` apart and
 * compute a linear growth-rate. A positive rate above `thresholdBytesPerSec`
 * is flagged as a suspected leak.
 */
export async function detectMemoryLeak(
  sampleCount = 5,
  intervalMs = 200,
  thresholdBytesPerSec = 500_000,
): Promise<MemoryLeakResult> {
  const samples: number[] = [];
  for (let i = 0; i < sampleCount; i++) {
    samples.push(process.memoryUsage().rss);
    if (i < sampleCount - 1) await sleep(intervalMs);
  }
  const first = samples[0] ?? 0;
  const last = samples[samples.length - 1] ?? 0;
  const totalTimeMs = intervalMs * (sampleCount - 1);
  const growthRateBytePerSec = totalTimeMs === 0 ? 0 : ((last - first) / totalTimeMs) * 1_000;
  return {
    suspected: growthRateBytePerSec > thresholdBytesPerSec,
    growthRateBytePerSec,
    sampleCount: samples.length,
    samples,
  };
}

export interface CpuUsageResult {
  userMs: number;
  systemMs: number;
  totalMs: number;
  wallMs: number;
  cpuPercent: number;
}

/**
 * Profile CPU usage over a given duration.
 */
export async function profileCpuUsage(durationMs = 500): Promise<CpuUsageResult> {
  const startCpu = process.cpuUsage();
  const startWall = hrtimeMs();
  await sleep(durationMs);
  const deltaCpu = process.cpuUsage(startCpu);
  const wallMs = hrtimeMs() - startWall;
  const userMs = deltaCpu.user / 1_000;
  const systemMs = deltaCpu.system / 1_000;
  const totalMs = userMs + systemMs;
  const cpuPercent = wallMs === 0 ? 0 : (totalMs / wallMs) * 100;
  return { userMs, systemMs, totalMs, wallMs, cpuPercent };
}

export interface GcPressureResult {
  gcEventCount: number;
  totalGcDurationMs: number;
  avgGcDurationMs: number;
  maxGcDurationMs: number;
}

/**
 * Track GC pressure over `durationMs` using PerformanceObserver.
 */
export async function trackGcPressure(durationMs = 1_000): Promise<GcPressureResult> {
  const events: number[] = [];

  const obs = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      events.push(entry.duration);
    }
  });

  try {
    obs.observe({ entryTypes: ['gc'] });
  } catch {
    // gc entry type may not be available in all environments
  }

  await sleep(durationMs);
  obs.disconnect();

  const total = events.reduce((a, v) => a + v, 0);
  return {
    gcEventCount: events.length,
    totalGcDurationMs: total,
    avgGcDurationMs: events.length === 0 ? 0 : total / events.length,
    maxGcDurationMs: events.length === 0 ? 0 : Math.max(...events),
  };
}

export interface EventLoopResult {
  samples: number[];
  avgLagMs: number;
  maxLagMs: number;
  p95LagMs: number;
}

/**
 * Monitor event-loop lag over `durationMs` by scheduling timers and
 * measuring actual delay versus expected delay.
 */
export async function monitorEventLoop(
  durationMs = 500,
  intervalMs = 50,
): Promise<EventLoopResult> {
  const samples: number[] = [];
  const end = Date.now() + durationMs;

  while (Date.now() < end) {
    const expected = intervalMs;
    const t0 = performance.now();
    await sleep(intervalMs);
    const actual = performance.now() - t0;
    samples.push(Math.max(0, actual - expected));
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, v) => a + v, 0);
  const avgLagMs = samples.length === 0 ? 0 : sum / samples.length;
  const maxLagMs = samples.length === 0 ? 0 : (sorted[sorted.length - 1] ?? 0);
  const p95Idx = Math.ceil(0.95 * sorted.length) - 1;
  const p95LagMs = samples.length === 0 ? 0 : (sorted[Math.max(0, p95Idx)] ?? 0);

  return { samples, avgLagMs, maxLagMs, p95LagMs };
}

export interface QueryProfile {
  queryId: string;
  durationMs: number;
  query?: string;
}

/**
 * Detect slow queries from a list of query profiles.
 * @param profiles  Array of executed query profiles.
 * @param thresholdMs  Queries slower than this are flagged.
 */
export function detectSlowQueries(
  profiles: QueryProfile[],
  thresholdMs: number,
): QueryProfile[] {
  return profiles.filter(p => p.durationMs > thresholdMs);
}

export interface CacheStats {
  hits: number;
  misses: number;
  total: number;
}

/** Compute cache hit rate (0–1). */
export function computeCacheHitRate(stats: CacheStats): number {
  if (stats.total === 0) return 0;
  return stats.hits / stats.total;
}

/** Compute cache miss rate (0–1). */
export function computeCacheMissRate(stats: CacheStats): number {
  if (stats.total === 0) return 0;
  return stats.misses / stats.total;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Re-export os utilities (for convenience) ─────────────────────────────────

/** Current system load averages (1, 5, 15 minutes). */
export function systemLoadAverage(): [number, number, number] {
  const [a, b, c] = os.loadavg();
  return [a ?? 0, b ?? 0, c ?? 0];
}

/** Total and free memory in bytes. */
export function systemMemory(): { totalBytes: number; freeBytes: number } {
  return { totalBytes: os.totalmem(), freeBytes: os.freemem() };
}
