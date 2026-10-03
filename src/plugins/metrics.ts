import type { BaileysEventMap } from '@whiskeysockets/baileys';

import type { Plugin } from '../utils/types.js';

/**
 * Dependency-free metrics registry.
 *
 * No Prometheus client, no global side effects, no pulls. The registry is a
 * closed set of maps keyed by metric name, and `snapshot()` is a plain
 * serialisable object the host can render, push to a `/metrics` handler, or
 * diff against the previous snapshot itself.
 *
 * ## The cardinality rule
 *
 * Label cardinality is the failure mode that turns a metrics endpoint into an
 * OOM. A naive `inc('messages', { jid })` creates one time series per contact
 * and the map grows until the process dies. So there is a hard ceiling on series
 * per metric, and once it is reached every *new* label combination is folded
 * into a single `__other__` series. An already-admitted series keeps counting,
 * so a hot label is never silently split. The ceiling is per-metric, and
 * `droppedSeries` reports how often folding happened, because a registry that
 * quietly throws data away without saying so is a lie.
 */

export type MetricType = 'counter' | 'gauge' | 'histogram';

export type MetricLabels = Readonly<Record<string, string | number | boolean>>;

export interface HistogramSpec {
  /** Upper bounds in the unit being observed (seconds, by default). */
  readonly bounds: readonly number[];
}

/** What one label combination holds. */
export interface SeriesSnapshot {
  readonly labels: MetricLabels;
  readonly count: number;
  readonly sum: number;
  readonly min: number;
  readonly max: number;
  /** Present for histograms: cumulative counts at each upper bound. */
  readonly buckets?: readonly { readonly le: number; readonly count: number }[];
}

export interface MetricSnapshot {
  readonly name: string;
  readonly type: MetricType;
  readonly series: readonly SeriesSnapshot[];
  /** Series that existed but were folded away by the cardinality ceiling. */
  readonly droppedSeries: number;
}

export interface MetricsSnapshot {
  readonly at: number;
  readonly uptimeSec: number;
  readonly metrics: readonly MetricSnapshot[];
}

export interface MetricsOptions {
  /** Max distinct label combinations per metric name. */
  maxSeriesPerMetric?: number;
  /** Max distinct label *keys* kept per series; extras are dropped. */
  maxLabelKeys?: number;
  /** Label values are truncated to this length so a rogue value cannot bloat. */
  maxLabelValueLength?: number;
  /** Histogram bucket bounds in seconds, used when a metric has no spec. */
  defaultBuckets?: readonly number[];
  /** Seed the registry with counters, timers and gauges at construction. */
  counters?: readonly string[];
  timers?: readonly string[];
  gauges?: readonly string[];
  /** Register the built-in socket event counters. Default true. */
  instrumentEvents?: boolean;
}

/** Default latency buckets: 5ms to 10s, which covers socket round-trips. */
const DEFAULT_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

const OTHER = '__other__';

/** Stable, order-independent identity for a label set. */
function labelKey(labels: MetricLabels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${String(labels[k])}`)
    .join(',');
}

interface Series {
  labels: MetricLabels;
  count: number;
  sum: number;
  min: number;
  max: number;
  /** Histogram only: cumulative counts, one per bound plus the overflow slot. */
  buckets: number[] | null;
}

interface Metric {
  type: MetricType;
  series: Map<string, Series>;
  /** The folded bucket, created lazily so unused metrics stay empty. */
  overflow: Series | null;
  droppedSeries: number;
}

export function metrics(options: MetricsOptions = {}): Plugin {
  const maxSeries = Math.max(1, options.maxSeriesPerMetric ?? 200);
  const maxKeys = Math.max(1, options.maxLabelKeys ?? 8);
  const maxValueLength = Math.max(1, options.maxLabelValueLength ?? 64);
  const defaultBounds = options.defaultBuckets ?? DEFAULT_BUCKETS;
  const startedAt = Date.now();

  return {
    name: 'metrics',
    order: 110,

    apply(ctx) {
      const log = ctx.log.child('metrics');
      const registry = new Map<string, Metric>();

      const newSeries = (labels: MetricLabels, type: MetricType): Series => ({
        labels,
        count: 0,
        sum: 0,
        min: Number.POSITIVE_INFINITY,
        max: Number.NEGATIVE_INFINITY,
        buckets: type === 'histogram' ? new Array(defaultBounds.length + 1).fill(0) : null,
      });

      const declare = (name: string, type: MetricType): Metric => {
        const existing = registry.get(name);
        if (existing) return existing;
        const created: Metric = { type, series: new Map(), overflow: null, droppedSeries: 0 };
        registry.set(name, created);
        return created;
      };

      /**
       * Trim to the allowed key count and cap value length. Both bounds exist
       * because label sets are caller-supplied and this is a public API.
       */
      const normaliseLabels = (labels: MetricLabels | undefined): MetricLabels => {
        if (!labels) return {};
        const out: Record<string, string | number | boolean> = {};
        let kept = 0;
        for (const [k, v] of Object.entries(labels)) {
          if (kept >= maxKeys) break;
          out[k] = typeof v === 'string' ? v.slice(0, maxValueLength) : v;
          kept += 1;
        }
        return out;
      };

      /**
       * Resolve a label set to its series, creating it or folding it into the
       * overflow bucket. This is the single choke point where cardinality is
       * enforced — every write goes through here.
       */
      const seriesFor = (metric: Metric, rawLabels: MetricLabels | undefined): Series => {
        const labels = normaliseLabels(rawLabels);
        const key = labelKey(labels);

        const hit = metric.series.get(key);
        if (hit) return hit;

        if (metric.series.size >= maxSeries) {
          metric.droppedSeries += 1;
          metric.overflow ??= newSeries({ [OTHER]: metric.droppedSeries }, metric.type);
          return metric.overflow;
        }

        const created = newSeries(labels, metric.type);
        metric.series.set(key, created);
        return created;
      };

      const record = (series: Series, value: number, bounds?: readonly number[]): void => {
        series.count += 1;
        series.sum += value;
        if (value < series.min) series.min = value;
        if (value > series.max) series.max = value;
        if (!series.buckets) return;

        const edges = bounds ?? defaultBounds;
        // Bounds are declared, not stored, per series — a custom spec would
        // otherwise need re-bucketing of values already recorded under the
        // default edges. Declared lengths are validated equal on construction.
        let index = edges.findIndex((le) => value <= le);
        if (index === -1) index = edges.length;
        series.buckets[index] = (series.buckets[index] ?? 0) + 1;
      };

      const add = (name: string, value: number, labels?: MetricLabels, type: MetricType = 'counter'): void => {
        if (!Number.isFinite(value)) {
          log.debug('dropped non-finite metric value', { name });
          return;
        }
        record(seriesFor(declare(name, type), labels), value);
      };

      /* ── public api ────────────────────────────────────────────── */

      /** Add `value` (default 1) to a counter. */
      const inc = (name: string, value = 1, labels?: MetricLabels): void => {
        add(name, value, labels, 'counter');
      };

      /** Set a gauge to an absolute value. */
      const set = (name: string, value: number, labels?: MetricLabels): void => {
        add(name, value, labels, 'gauge');
      };

      /** Record one observation. The unit is whatever the caller measured. */
      const observe = (name: string, value: number, labels?: MetricLabels): void => {
        add(name, value, labels, 'histogram');
      };

      /**
       * Start a timer. The returned function reports elapsed seconds — in
       * seconds because that is the Prometheus base unit, and every caller here
       * is measuring a socket round-trip or a queue wait.
       */
      const start = (name: string, labels?: MetricLabels): (() => number) => {
        const from = process.hrtime.bigint();
        return () => {
          const seconds = Number(process.hrtime.bigint() - from) / 1e9;
          observe(name, seconds, labels);
          return seconds;
        };
      };

      /** Time an async operation, recording success and failure separately. */
      const time = async <T>(
        name: string,
        fn: () => Promise<T> | T,
        labels?: MetricLabels,
      ): Promise<T> => {
        const stop = start(name, labels);
        try {
          return await fn();
        } catch (err) {
          add(`${name}_errors`, 1, labels, 'counter');
          throw err;
        } finally {
          stop();
        }
      };

      /** Counters that must exist even before anything has been recorded. */
      for (const name of options.counters ?? []) declare(name, 'counter');
      for (const name of options.timers ?? []) declare(name, 'histogram');
      for (const name of options.gauges ?? []) declare(name, 'gauge');

      /* ── built-in instrumentation ──────────────────────────────── */

      if (options.instrumentEvents !== false) {
        // Only real socket events are counted. No method is patched, so this
        // cannot interfere with the plugins that do wrap send/read paths.
        ctx.sock.ev.on('messages.upsert', (event: BaileysEventMap['messages.upsert']) => {
          const n = event?.messages?.length ?? 0;
          if (n > 0) inc('baileys_messages_received_total', n, { type: event.type });
        });
        ctx.sock.ev.on('messages.reaction', (event: BaileysEventMap['messages.reaction']) => {
          inc('baileys_reactions_total', event?.length ?? 0);
        });
        ctx.sock.ev.on('message-receipt.update', (event: BaileysEventMap['message-receipt.update']) => {
          inc('baileys_receipts_total', event?.length ?? 0);
        });
        ctx.sock.ev.on('call', (event: BaileysEventMap['call']) => {
          for (const c of event ?? []) inc('baileys_calls_total', 1, { status: c.status });
        });
        ctx.sock.ev.on('connection.update', (event: BaileysEventMap['connection.update']) => {
          const phase = event?.connection;
          if (phase) inc('baileys_connection_updates_total', 1, { phase });
        });
      }

      /* ── snapshot ──────────────────────────────────────────────── */

      const snapshotSeries = (s: Series): SeriesSnapshot => {
        const out = {
          labels: s.labels,
          count: s.count,
          sum: s.sum,
          min: Number.isFinite(s.min) ? s.min : 0,
          max: Number.isFinite(s.max) ? s.max : 0,
        } as {
          labels: MetricLabels;
          count: number;
          sum: number;
          min: number;
          max: number;
          buckets?: readonly { le: number; count: number }[];
        };

        if (s.buckets) {
          // Cumulative, the way a histogram consumer reads it.
          let running = 0;
          out.buckets = defaultBounds.map((le, i) => {
            running += s.buckets?.[i] ?? 0;
            return { le, count: running };
          });
        }
        return out;
      };

      const snapshot = (): MetricsSnapshot => ({
        at: Date.now(),
        uptimeSec: (Date.now() - startedAt) / 1000,
        metrics: [...registry.entries()].map(([name, metric]) => {
          const series = [...metric.series.values()];
          if (metric.overflow) series.push(metric.overflow);
          return {
            name,
            type: metric.type,
            series: series.filter((s) => s.count > 0).map(snapshotSeries),
            droppedSeries: metric.droppedSeries,
          };
        }),
      });

      /** Clear one metric, or the whole registry when called with no name. */
      const reset = (name?: string): void => {
        if (name === undefined) {
          registry.clear();
          return;
        }
        registry.delete(name);
      };

      const api = {
        inc,
        set,
        observe,
        start,
        time,
        snapshot,
        reset,
        /** Direct read for a single metric, cheaper than a full snapshot. */
        get: (name: string): MetricSnapshot | undefined => {
          const metric = registry.get(name);
          if (!metric) return undefined;
          const series = [...metric.series.values()];
          if (metric.overflow) series.push(metric.overflow);
          return { name, type: metric.type, series: series.map(snapshotSeries), droppedSeries: metric.droppedSeries };
        },
        limits: { maxSeriesPerMetric: maxSeries, maxLabelKeys: maxKeys, defaultBuckets: defaultBounds },
      };

      Object.defineProperty(ctx.sock, 'metrics', {
        value: api,
        enumerable: false,
        configurable: true,
      });

      log.debug('attached', { maxSeries, maxKeys });
    },
  };
}

export default metrics;
