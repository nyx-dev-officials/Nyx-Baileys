/**
 * Delivery-rate tracking.
 *
 * The strongest early signal that an outbound number is being softly throttled
 * is not an error — it is that sends stop reaching anyone. WhatsApp reports
 * delivery through `messages.update` (`status` 3 = DELIVERY_ACK, 4 = READ), so
 * counting acknowledgements against sends gives a delivery rate with no extra
 * protocol work.
 *
 * A rate below the threshold is a signal, not a verdict: it is reported for an
 * operator or a health layer to act on. Adapted from the reference forks.
 */

export interface DeliveryTrackerOptions {
  /** Rolling window for the rate. Default 1 hour. */
  windowMs?: number;
  /** Minimum sends before the rate is meaningful. Default 10. */
  minSampleSize?: number;
  /** Rate below this fires `onLowRate`. Default 0.6. */
  lowRateThreshold?: number;
  /** Called at most once per window when the rate first drops. */
  onLowRate?: (rate: number, stats: DeliveryStats) => void;
}

export interface DeliveryStats {
  sent: number;
  delivered: number;
  /** `null` until `minSampleSize` sends are in the window. */
  rate: number | null;
  windowMs: number;
}

interface Record_ {
  sentAt: number;
  delivered: boolean;
}

export class DeliveryTracker {
  readonly #windowMs: number;
  readonly #min: number;
  readonly #threshold: number;
  readonly #onLowRate: (rate: number, stats: DeliveryStats) => void;
  #messages = new Map<string, Record_>();
  #lastAlertAt = 0;

  constructor(options: DeliveryTrackerOptions = {}) {
    this.#windowMs = options.windowMs ?? 60 * 60 * 1000;
    this.#min = options.minSampleSize ?? 10;
    this.#threshold = options.lowRateThreshold ?? 0.6;
    this.#onLowRate = options.onLowRate ?? (() => {});
  }

  /** Register an outbound message by id. */
  sent(id: string, at = Date.now()): void {
    if (!id) return;
    this.#messages.set(id, { sentAt: at, delivered: false });
    this.#prune();
  }

  /** Mark a message delivered (status 3 or 4). Unknown ids are ignored. */
  delivered(id: string): void {
    const record = this.#messages.get(id);
    if (record) record.delivered = true;
    this.#prune();
    this.#check();
  }

  stats(): DeliveryStats {
    this.#prune();
    const cutoff = Date.now() - this.#windowMs;
    let sent = 0;
    let delivered = 0;
    for (const record of this.#messages.values()) {
      if (record.sentAt < cutoff) continue;
      sent += 1;
      if (record.delivered) delivered += 1;
    }
    return {
      sent,
      delivered,
      rate: sent >= this.#min ? delivered / sent : null,
      windowMs: this.#windowMs,
    };
  }

  reset(): void {
    this.#messages.clear();
    this.#lastAlertAt = 0;
  }

  get tracked(): number {
    return this.#messages.size;
  }

  #prune(): void {
    const cutoff = Date.now() - this.#windowMs;
    for (const [id, record] of this.#messages) {
      if (record.sentAt < cutoff) this.#messages.delete(id);
    }
  }

  #check(): void {
    const stats = this.stats();
    if (stats.rate === null) return;
    const now = Date.now();
    if (now - this.#lastAlertAt < this.#windowMs) return;
    if (stats.rate < this.#threshold) {
      this.#lastAlertAt = now;
      this.#onLowRate(stats.rate, stats);
    }
  }
}
