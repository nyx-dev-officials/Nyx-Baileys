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

/**
 * Median over a fixed-capacity ring buffer, via a reused scratch array.
 *
 * `skewMs()` runs on the send path, so it must not allocate. The ring is read
 * in order into `scratch`, sorted in place, and the median taken from it — one
 * allocation for the lifetime of the estimator rather than one per call.
 */
const ringMedian = (
  ring: Float64Array,
  filled: number,
  scratch: number[],
): number => {
  if (filled === 0) return 0;
  scratch.length = filled;
  for (let i = 0; i < filled; i += 1) scratch[i] = ring[i] ?? 0;
  scratch.sort((a, b) => a - b);
  const mid = Math.floor(filled / 2);
  if (filled % 2 === 0) return ((scratch[mid - 1] ?? 0) + (scratch[mid] ?? 0)) / 2;
  return scratch[mid] ?? 0;
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
  /** Fixed-capacity skew ring. Never grows, never reallocates. */
  readonly #skew: Float64Array;
  /** Fixed-capacity round-trip ring, parallel to `#skew`. */
  readonly #rtt: Float64Array;
  /** Next write position in the rings. */
  #cursor = 0;
  /** Live entries, capped at the window. */
  #filled = 0;
  /** Reused by `skewMs()` so the estimator allocates nothing per call. */
  readonly #scratch: number[] = [];
  /** Second scratch, for `stats()` — it reports two medians at once. */
  readonly #scratch2: number[] = [];
  #lastUpdatedAt = 0;

  constructor(options: ClockSyncOptions = {}) {
    // A window of 0 or less would make the ring cursor divide by zero and the
    // window trivially empty. Clamp to 1 so the class is total.
    this.#window = Math.max(1, options.sampleWindowSize ?? 10);
    this.#min = options.minSamples ?? 3;
    this.#skew = new Float64Array(this.#window);
    this.#rtt = new Float64Array(this.#window);
  }

  /**
   * Add a round-trip sample. `skew` is measured against the midpoint of the
   * round trip, which cancels half the network delay.
   */
  record(sample: ClockSample): void {
    const rtt = Math.max(0, sample.localReceivedAt - sample.localSentAt);
    const midpoint = sample.localSentAt + rtt / 2;
    this.#push(rtt, sample.serverTimestamp - midpoint);
  }

  /**
   * Record a one-way sample: a server timestamp observed at local time `at`.
   *
   * This is the path the inbound plugin takes, once per message, so it exists
   * to avoid building a `ClockSample` object per message. With a one-way
   * sample the round trip is zero, the midpoint is `at`, and the skew is just
   * the distance between the two clocks.
   */
  recordServerTimestamp(serverTimestampMs: number, at = Date.now()): void {
    this.#push(0, serverTimestampMs - at, at);
  }

  #push(rtt: number, skew: number, at = Date.now()): void {
    // Ring, not push/shift: a bounded window makes `shift()` a memmove on every
    // sample and allocates one `{rtt, skew}` object per sample — both pure waste
    // on a path that runs once per inbound message.
    this.#skew[this.#cursor] = skew;
    this.#rtt[this.#cursor] = rtt;
    this.#cursor = (this.#cursor + 1) % this.#window;
    if (this.#filled < this.#window) this.#filled += 1;
    this.#lastUpdatedAt = at;
  }

  /** Estimated skew in ms. Negative means local is ahead. */
  skewMs(): number {
    if (this.#filled < this.#min) return 0;
    return ringMedian(this.#skew, this.#filled, this.#scratch);
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
    const count = this.#filled;

    let confidence: ClockSyncStats['confidence'] = 'low';
    if (count >= this.#min) {
      const skews: number[] = [];
      for (let i = 0; i < count; i += 1) skews.push(this.#skew[i] ?? 0);
      confidence = count >= 10 && standardDeviation(skews) < 500 ? 'high' : 'medium';
    }

    return {
      skewMs: count >= this.#min ? ringMedian(this.#skew, count, this.#scratch) : 0,
      estimatedRttMs: ringMedian(this.#rtt, count, this.#scratch2),
      sampleCount: count,
      confidence,
      lastUpdatedAt: this.#lastUpdatedAt,
    };
  }

  reset(): void {
    this.#skew.fill(0);
    this.#rtt.fill(0);
    this.#cursor = 0;
    this.#filled = 0;
    this.#lastUpdatedAt = 0;
  }

  /** Live samples, capped at the window — not the lifetime total. */
  get sampleCount(): number {
    return this.#filled;
  }
}
