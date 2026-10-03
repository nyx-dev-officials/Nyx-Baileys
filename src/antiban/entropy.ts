/**
 * Human entropy — background activity for idle sessions.
 *
 * ⚠️ EVASION MODULE, OFF BY DEFAULT. See `docs/ANTIBAN.md`.
 *
 * A session that connects and then does exactly nothing until it batch-sends is
 * a shape. A real phone shows typing, reads and presence in the background. This
 * runs those actions on a long, jittered timer against **contacts who messaged
 * first** — never strangers, because unsolicited activity is both a detection
 * signal and harassment.
 *
 * Adapted from the reference forks' `humanEntropy` to talk to a Baileys socket
 * directly. Every action is fail-silent: a background nicety must never take the
 * session down.
 */

export interface HumanEntropyOptions {
  /** Master switch. Default `false`. */
  enabled?: boolean;
  /** Cycle spacing window. Default 2h–6h. */
  minIntervalMs?: number;
  maxIntervalMs?: number;
  /** Recent contacts tracked. Default 30. */
  maxRecentContacts?: number;
  typingProbability?: number;
  typingMinMs?: number;
  typingMaxMs?: number;
  /** Chance of marking a tracked message read. Default 0.2. */
  readReceiptProbability?: number;
  readReceiptMinDelayMs?: number;
  readReceiptMaxDelayMs?: number;
  /** Chance of a `available`/`unavailable` toggle. Default 0.15. */
  presenceToggleProbability?: number;
  presenceToggleMinMs?: number;
  presenceToggleMaxMs?: number;
  /** Injectable RNG for tests. Defaults to `Math.random`. */
  random?: () => number;
}

export interface HumanEntropyStats {
  cycles: number;
  typingActions: number;
  readReceipts: number;
  presenceToggles: number;
  errors: number;
  lastCycleAt: number | null;
  nextCycleAt: number | null;
}

/** The slice of the socket this service touches. */
export interface EntropySocket {
  sendPresenceUpdate: (state: string, jid: string) => unknown;
  readMessages?: (keys: Array<{ remoteJid?: string | null; id?: string | null }>) => unknown;
  ev?: { on: (event: string, fn: (payload: any) => void) => void; off?: (event: string, fn: (payload: any) => void) => void };
}

interface Contact {
  jid: string;
  lastAt: number;
}

interface PendingRead {
  jid: string;
  key: { remoteJid?: string | null; id?: string | null };
  receivedAt: number;
}

const rand = (rng: () => number, min: number, max: number): number => Math.floor(rng() * (max - min + 1)) + min;

export class HumanEntropy {
  readonly #cfg: Required<HumanEntropyOptions>;
  readonly #sock: EntropySocket;
  #contacts = new Map<string, Contact>();
  #pendingReads: PendingRead[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;
  #stats: HumanEntropyStats = {
    cycles: 0,
    typingActions: 0,
    readReceipts: 0,
    presenceToggles: 0,
    errors: 0,
    lastCycleAt: null,
    nextCycleAt: null,
  };

  constructor(sock: EntropySocket, options: HumanEntropyOptions = {}) {
    this.#sock = sock;
    this.#cfg = {
      enabled: options.enabled ?? false,
      minIntervalMs: options.minIntervalMs ?? 2 * 60 * 60 * 1000,
      maxIntervalMs: options.maxIntervalMs ?? 6 * 60 * 60 * 1000,
      maxRecentContacts: options.maxRecentContacts ?? 30,
      typingProbability: options.typingProbability ?? 0.3,
      typingMinMs: options.typingMinMs ?? 3_000,
      typingMaxMs: options.typingMaxMs ?? 8_000,
      readReceiptProbability: options.readReceiptProbability ?? 0.2,
      readReceiptMinDelayMs: options.readReceiptMinDelayMs ?? 10 * 60 * 1000,
      readReceiptMaxDelayMs: options.readReceiptMaxDelayMs ?? 60 * 60 * 1000,
      presenceToggleProbability: options.presenceToggleProbability ?? 0.15,
      presenceToggleMinMs: options.presenceToggleMinMs ?? 30 * 1000,
      presenceToggleMaxMs: options.presenceToggleMaxMs ?? 2 * 60 * 1000,
      random: options.random ?? Math.random,
    };
  }

  get enabled(): boolean {
    return this.#cfg.enabled;
  }

  /** Begin tracking inbound messages. Safe to call when disabled (no-op). */
  attach(): void {
    if (!this.#cfg.enabled || !this.#sock.ev) return;
    this.#sock.ev.on('messages.upsert', (event: { messages?: Array<{ key?: { remoteJid?: string; fromMe?: boolean; id?: string } ; messageTimestamp?: unknown }> }) => {
      for (const msg of event.messages ?? []) {
        const jid = msg.key?.remoteJid;
        if (!jid || msg.key?.fromMe) continue;
        if (jid.endsWith('@g.us') || jid.endsWith('@broadcast')) continue;
        this.#contacts.delete(jid);
        this.#contacts.set(jid, { jid, lastAt: Date.now() });
        while (this.#contacts.size > this.#cfg.maxRecentContacts) {
          const oldest = this.#contacts.keys().next().value;
          if (oldest === undefined) break;
          this.#contacts.delete(oldest);
        }
        if (msg.key?.id && this.#cfg.random() < this.#cfg.readReceiptProbability) {
          this.#pendingReads.push({ jid, key: { remoteJid: jid, id: msg.key.id }, receivedAt: Date.now() });
          if (this.#pendingReads.length > this.#cfg.maxRecentContacts) this.#pendingReads.shift();
        }
      }
    });
  }

  start(): void {
    if (!this.#cfg.enabled || this.#running) return;
    this.#running = true;
    this.#scheduleNext();
  }

  stop(): void {
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#stats.nextCycleAt = null;
  }

  get contactCount(): number {
    return this.#contacts.size;
  }

  stats(): HumanEntropyStats {
    return { ...this.#stats };
  }

  /** Run one cycle now (used by tests and by the timer). */
  async runCycle(): Promise<void> {
    if (this.#contacts.size === 0 && this.#pendingReads.length === 0) return;
    this.#stats.cycles += 1;
    this.#stats.lastCycleAt = Date.now();

    const contacts = [...this.#contacts.values()];
    const rng = this.#cfg.random;

    try {
      // Typing presence to a recent contact.
      if (contacts.length > 0 && rng() < this.#cfg.typingProbability) {
        const contact = contacts[Math.floor(rng() * contacts.length)]!;
        await this.#safePresence('composing', contact.jid);
        await new Promise((r) => setTimeout(r, rand(rng, this.#cfg.typingMinMs, this.#cfg.typingMaxMs)));
        await this.#safePresence('paused', contact.jid);
        this.#stats.typingActions += 1;
      }

      // A delayed read receipt.
      if (this.#pendingReads.length > 0 && rng() < this.#cfg.readReceiptProbability && this.#sock.readMessages) {
        const pending = this.#pendingReads.shift()!;
        const delay = rand(rng, this.#cfg.readReceiptMinDelayMs, this.#cfg.readReceiptMaxDelayMs);
        if (Date.now() - pending.receivedAt >= Math.min(delay, this.#cfg.readReceiptMinDelayMs)) {
          await Promise.resolve(this.#sock.readMessages([pending.key]));
          this.#stats.readReceipts += 1;
        }
      }

      // An availability toggle.
      if (rng() < this.#cfg.presenceToggleProbability) {
        await this.#safePresence('unavailable', '');
        await new Promise((r) => setTimeout(r, rand(rng, this.#cfg.presenceToggleMinMs, this.#cfg.presenceToggleMaxMs)));
        await this.#safePresence('available', '');
        this.#stats.presenceToggles += 1;
      }
    } catch {
      this.#stats.errors += 1;
    }
  }

  #scheduleNext(): void {
    const delay = rand(this.#cfg.random, this.#cfg.minIntervalMs, this.#cfg.maxIntervalMs);
    this.#stats.nextCycleAt = Date.now() + delay;
    this.#timer = setTimeout(() => {
      void this.runCycle().finally(() => {
        if (this.#running) this.#scheduleNext();
      });
    }, delay);
    this.#timer.unref?.();
  }

  async #safePresence(state: string, jid: string): Promise<void> {
    try {
      await Promise.resolve(this.#sock.sendPresenceUpdate(state, jid));
    } catch {
      this.#stats.errors += 1;
    }
  }
}
