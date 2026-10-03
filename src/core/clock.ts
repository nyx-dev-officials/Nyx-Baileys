/**
 * Server clock synchronisation.
 *
 * A client that trusts its own wall clock will mis-order messages and stamp
 * outbound payloads with a time the server did not witness. This estimates the
 * offset between local and server time from round-trip samples and exposes it.
 *
 * The estimate is the *median* of the sample window, not the mean: one wildly
 * skewed sample (a stalled socket, an NTP step) drags a mean far enough to
 * re-order timestamps, while a median ignores it entirely. Adapted from the
 * rolling-median clock sync surveyed in the reference forks.
 */

export interface ClockSample {
  /** Local time the request left, in ms. */
  localSentAt: number;
  /** Local time the response returned, in ms. */
  localReceivedAt: number;
  /** The server's timestamp for the same exchange, in ms. */
  serverTimestamp: number;
}

export interface ClockSyncOptions {
  /** Samples kept in the rolling window. Default 10. */
  sampleWindowSize?: number;
  /** Samples required before a skew is reported. Default 3. */
  minSamples?: number;
}

export interface ClockSyncStats {
  skewMs: number;
  estimatedRttMs: number;
  sampleCount: number;
  confidence: 'low' | 'medium' | 'high';
  lastUpdatedAt: number;
}

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const lo = sorted[mid - 1] ?? 0;
    const hi = sorted[mid] ?? 0;
    return (lo + hi) / 2;
  }
  return sorted[mid] ?? 0;
};

const standardDeviation = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
};

/** Rolling-median estimator of server-to-local clock skew. */
export class ClockSync {
  readonly #window: number;
  readonly #min: number;
  #samples: Array<{ rtt: number; skew: number }> = [];
  #lastUpdatedAt = 0;

  constructor(options: ClockSyncOptions = {}) {
    this.#window = options.sampleWindowSize ?? 10;
    this.#min = options.minSamples ?? 3;
  }

  /**
   * Add a round-trip sample. `skew` is measured against the midpoint of the
   * round trip, which cancels half the network delay.
   */
  record(sample: ClockSample): void {
    const rtt = Math.max(0, sample.localReceivedAt - sample.localSentAt);
    const midpoint = sample.localSentAt + rtt / 2;
    this.#samples.push({ rtt, skew: sample.serverTimestamp - midpoint });
    if (this.#samples.length > this.#window) this.#samples.shift();
    this.#lastUpdatedAt = Date.now();
  }

  /** Estimated skew in ms. Negative means local is ahead. */
  skewMs(): number {
    if (this.#samples.length < this.#min) return 0;
    return median(this.#samples.map((s) => s.skew));
  }

  /** Local ms → server-aligned ms. */
  toServerTime(localMs: number): number {
    return localMs + this.skewMs();
  }

  /** Server ms → local-aligned ms. */
  toLocalTime(serverMs: number): number {
    return serverMs - this.skewMs();
  }

  stats(): ClockSyncStats {
    const count = this.#samples.length;
    const skews = this.#samples.map((s) => s.skew);
    const rtts = this.#samples.map((s) => s.rtt);

    let confidence: ClockSyncStats['confidence'] = 'low';
    if (count >= this.#min) {
      confidence = count >= 10 && standardDeviation(skews) < 500 ? 'high' : 'medium';
    }

    return {
      skewMs: count >= this.#min ? median(skews) : 0,
      estimatedRttMs: median(rtts),
      sampleCount: count,
      confidence,
      lastUpdatedAt: this.#lastUpdatedAt,
    };
  }

  reset(): void {
    this.#samples = [];
    this.#lastUpdatedAt = 0;
  }

  get sampleCount(): number {
    return this.#samples.length;
  }
}
