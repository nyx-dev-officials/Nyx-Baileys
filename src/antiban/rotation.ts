/**
 * Egress rotation.
 *
 * ⚠️ EVASION MODULE. See `docs/ANTIBAN.md`.
 *
 * A fleet that all connects from one address is one address to rate-limit or
 * block. A rotator spreads sessions across proxies and — more importantly —
 * **quarantines a proxy that just failed** so a dead endpoint does not become a
 * retry loop. Selection is round-robin, random, or sticky-per-session.
 *
 * Ported and adapted from the reference forks' `proxyRotator`. This module only
 * *chooses* a proxy config; opening the connection is the caller's job.
 */

export interface ProxyEntry {
  /** `host:port` or a full URL. */
  url: string;
  protocol?: 'http' | 'https' | 'socks4' | 'socks5';
  username?: string;
  password?: string;
  /** Higher weight is chosen more often under `weighted`. Default 1. */
  weight?: number;
  label?: string;
}

export type RotationStrategy = 'round-robin' | 'random' | 'weighted' | 'sticky';

export interface RotatorOptions {
  strategy?: RotationStrategy;
  /** How long a failed proxy is skipped. Default 5 minutes. */
  cooldownMs?: number;
  /** Consecutive failures before a proxy is quarantined. Default 1. */
  failureThreshold?: number;
  /** Called when a proxy is quarantined or restored. */
  onStateChange?: (url: string, state: 'quarantined' | 'restored') => void;
}

interface Slot {
  entry: ProxyEntry;
  weight: number;
  failures: number;
  quarantineUntil: number;
  used: number;
}

/** What `makeWASocket` expects for `agent` / `fetchAgent`. */
export interface ProxyAgentConfig {
  url: string;
  protocol: 'http' | 'https' | 'socks4' | 'socks5';
  username?: string;
  password?: string;
}

export class ProxyRotator {
  readonly #strategy: RotationStrategy;
  readonly #cooldown: number;
  readonly #threshold: number;
  readonly #onChange: (url: string, state: 'quarantined' | 'restored') => void;
  #slots: Slot[];
  #cursor = 0;

  constructor(proxies: readonly ProxyEntry[], options: RotatorOptions = {}) {
    if (proxies.length === 0) throw new Error('proxy-rotation: at least one proxy is required');
    this.#strategy = options.strategy ?? 'round-robin';
    this.#cooldown = options.cooldownMs ?? 5 * 60 * 1000;
    this.#threshold = options.failureThreshold ?? 1;
    this.#onChange = options.onStateChange ?? (() => {});
    this.#slots = proxies.map((entry) => ({
      entry,
      weight: entry.weight ?? 1,
      failures: 0,
      quarantineUntil: 0,
      used: 0,
    }));
  }

  get size(): number {
    return this.#slots.length;
  }

  /** Proxies not currently quarantined. */
  available(now = Date.now()): ProxyEntry[] {
    return this.#slots.filter((s) => s.quarantineUntil <= now).map((s) => s.entry);
  }

  /**
   * Next proxy for `key`. Under `sticky`, the same key always resolves to the
   * same proxy for as long as it stays healthy.
   */
  next(key?: string, now = Date.now()): ProxyAgentConfig {
    this.#releaseExpired(now);
    const healthy = this.#slots.filter((s) => s.quarantineUntil <= now);
    if (healthy.length === 0) throw new Error('proxy-rotation: every proxy is quarantined');

    let slot: Slot;
    switch (this.#strategy) {
      case 'sticky':
        slot = healthy[this.#hash(key ?? '') % healthy.length]!;
        break;
      case 'random':
        slot = healthy[Math.floor(Math.random() * healthy.length)]!;
        break;
      case 'weighted': {
        const total = healthy.reduce((sum, s) => sum + s.weight, 0);
        let roll = Math.random() * total;
        slot = healthy[healthy.length - 1]!;
        for (const candidate of healthy) {
          roll -= candidate.weight;
          if (roll <= 0) {
            slot = candidate;
            break;
          }
        }
        break;
      }
      case 'round-robin':
      default: {
        slot = healthy[this.#cursor % healthy.length]!;
        this.#cursor = (this.#cursor + 1) % this.#slots.length;
        break;
      }
    }

    slot.used += 1;
    return this.#toAgent(slot.entry);
  }

  /** Record a failure. Quarantines once the threshold is reached. */
  reportFailure(url: string, now = Date.now()): void {
    const slot = this.#slots.find((s) => s.entry.url === url);
    if (!slot) return;
    slot.failures += 1;
    if (slot.failures >= this.#threshold && slot.quarantineUntil <= now) {
      slot.quarantineUntil = now + this.#cooldown;
      this.#onChange(url, 'quarantined');
    }
  }

  /** Record a success, clearing failures and any quarantine. */
  reportSuccess(url: string): void {
    const slot = this.#slots.find((s) => s.entry.url === url);
    if (!slot) return;
    const wasQuarantined = slot.quarantineUntil > 0;
    slot.failures = 0;
    slot.quarantineUntil = 0;
    if (wasQuarantined) this.#onChange(url, 'restored');
  }

  stats(): Array<{ url: string; used: number; failures: number; quarantined: boolean }> {
    const now = Date.now();
    return this.#slots.map((s) => ({
      url: s.entry.url,
      used: s.used,
      failures: s.failures,
      quarantined: s.quarantineUntil > now,
    }));
  }

  #releaseExpired(now: number): void {
    for (const slot of this.#slots) {
      if (slot.quarantineUntil > 0 && slot.quarantineUntil <= now) {
        slot.quarantineUntil = 0;
        slot.failures = 0;
        this.#onChange(slot.entry.url, 'restored');
      }
    }
  }

  #hash(value: string): number {
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
    return hash;
  }

  #toAgent(entry: ProxyEntry): ProxyAgentConfig {
    const protocol = entry.protocol ?? (entry.url.startsWith('socks') ? 'socks5' : 'http');
    return {
      url: entry.url,
      protocol,
      ...(entry.username ? { username: entry.username } : {}),
      ...(entry.password ? { password: entry.password } : {}),
    };
  }
}
