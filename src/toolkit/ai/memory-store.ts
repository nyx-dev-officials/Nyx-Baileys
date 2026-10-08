/**
 * FLUX MEMORY — per-session, per-user, and durable.
 *
 * Three separate concerns, kept separate because conflating them is what makes
 * a bot feel broken:
 *
 *  1. **Session scope** — `session:abc` gets `m1`, `session:xyz` gets `m2`.
 *     A shared memory across sessions is how a bot "remembers" something said to
 *     somebody else, which is both wrong and a privacy problem.
 *  2. **Durability** — memory outlives the socket. A user who disconnects, or
 *     whose pairing is torn down and rebuilt, must not lose everything they told
 *     the bot. Memory is written to disk, keyed by jid.
 *  3. **User scope** — one user across every chat shares one memory. Asking
 *     "what do you know about me" in a group and in a DM should give the same
 *     answer.
 *
 * The layer decides precedence: a session override wins, then the user's durable
 * memory, then nothing. Never the other way — a throwaway session must not be
 * able to overwrite a durable fact.
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

import { Memory, type FactCandidate, type MemoryFact } from './context.js';
import { baseJid } from '../ops-50/types.js';

/* ════════════════════════════════════════════════════════════════════════
   Keys
   ════════════════════════════════════════════════════════════════════════ */

/** Stable per-user key. Device-stripped, so `:12` and `:4` are one person. */
export function userKey(jid: string): string {
  const base = baseJid(jid);
  const digits = base.split('@')[0] ?? base;
  return `u_${digits.replace(/[^\w]/g, '')}`;
}

/**
 * Per-session key.
 *
 * Hashing means a session id — which can be an invite code or a UUID — never
 * becomes a filename verbatim. A key derived from raw user input is a path
 * traversal waiting to happen.
 */
export function sessionKey(jid: string, sessionId: string): string {
  const digest = createHash('sha256').update(`${userKey(jid)}::${sessionId}`).digest('hex');
  return `s_${digest.slice(0, 24)}`;
}

/* ════════════════════════════════════════════════════════════════════════
   Durable store
   ════════════════════════════════════════════════════════════════════════ */

interface PersistedFact {
  fact: string;
  source: string;
  at: number;
  hits: number;
  expiresAt?: number;
}

interface PersistedMemory {
  version: 1;
  facts: PersistedFact[];
}

export interface DurableOptions {
  /** Directory for the JSON files. Created if missing. */
  dir: string;
  /** Facts per user. Default 300. */
  capacity?: number;
}

/**
 * Memory on disk, keyed by user.
 *
 * Writes are atomic — temp file then `rename` — because a process killed
 * mid-write would otherwise leave truncated JSON, and the next load would read
 * it as "no facts" and quietly discard everything the user told the bot. That is
 * the same failure mode as the `creds.json` truncation bug in `CONTEXT.md` §8.
 */
export class DurableMemory {
  private cache = new Map<string, Memory>();

  constructor(private readonly options: DurableOptions) {
    mkdirSync(options.dir, { recursive: true });
  }

  private path(key: string): string {
    return join(this.options.dir, `${key}.json`);
  }

  /** Load, or return an empty store. A corrupt file is quarantined, not fatal. */
  private load(key: string): Memory {
    const cached = this.cache.get(key);
    if (cached) return cached;

    const memory = new Memory(this.options.capacity ?? 300);
    const file = this.path(key);

    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as PersistedMemory;

        if (parsed?.version === 1 && Array.isArray(parsed.facts)) {
          for (const fact of parsed.facts) {
            if (!fact?.fact || !fact?.source) continue;
            // Replayed through `learn` so the same validation applies as at write
            // time — a hand-edited file must not be able to inject a bad fact.
            memory.learn({
              fact: fact.fact,
              source: fact.source,
              ...(fact.expiresAt !== undefined ? { expiresAt: fact.expiresAt } : {}),
            });
          }
        }
      } catch {
        // Quarantine rather than delete: the user may want it, and losing the
        // file silently is exactly the failure we are preventing.
        try {
          renameSync(file, `${file}.corrupt`);
        } catch { /* nothing more we can do */ }
      }
    }

    this.cache.set(key, memory);
    return memory;
  }

  /** Flush a user's facts to disk. */
  save(key: string, memory: Memory): void {
    const facts = memory.recall(undefined, this.options.capacity ?? 300)
      .map((f: MemoryFact) => ({
        fact: f.fact,
        source: f.source,
        at: f.at,
        hits: f.hits,
        ...(f.expiresAt !== undefined ? { expiresAt: f.expiresAt } : {}),
      }));

    const payload: PersistedMemory = { version: 1, facts };
    const file = this.path(key);
    const temp = `${file}.tmp`;

    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(temp, JSON.stringify(payload), 'utf8');
    // Rename is atomic on POSIX and Windows for same-volume moves.
    renameSync(temp, file);
  }

  /** The memory for a user, creating it on first access. */
  for(key: string): Memory {
    return this.load(key);
  }

  /** Learn and immediately persist. */
  remember(key: string, candidate: FactCandidate): boolean {
    const memory = this.load(key);
    const changed = memory.learn(candidate);
    if (changed) this.save(key, memory);
    return changed;
  }

  /** Forget and immediately persist. */
  forget(key: string, topic: string): number {
    const memory = this.load(key);
    const removed = memory.forget(topic);
    if (removed > 0) this.save(key, memory);
    return removed;
  }

  /** Drop everything for a user, on disk and in cache. */
  purge(key: string): boolean {
    this.cache.delete(key);
    try {
      renameSync(this.path(key), `${this.path(key)}.purged`);
      return true;
    } catch {
      return false;
    }
  }

  /** Every user key with stored facts. */
  keys(): string[] {
    try {
      // Imported lazily so a read-only consumer does not need the writer.
      const { readdirSync } = require('node:fs') as typeof import('node:fs');
      return readdirSync(this.options.dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''));
    } catch {
      return [];
    }
  }
}

/* ════════════════════════════════════════════════════════════════════════
   Scoped memory
   ════════════════════════════════════════════════════════════════════════ */

export interface ScopeOptions {
  durable: DurableMemory;
  /** Facts per session. Default 60 — a session is a short window by nature. */
  sessionCapacity?: number;
}

/**
 * Two-layer memory: durable per user, scoped per session.
 *
 * `recall` merges and **de-duplicates**, and reports where each fact came from
 * so a caller can show the user which layer holds it. The dedupe matters: the
 * same fact can exist in both layers after a user says it twice, and returning
 * it twice makes the model think it is more certain than it is.
 */
/** Prefix that marks a fact as session-scoped. */
const SESSION_TAG = 'session:';

export class ScopedMemory {
  private sessions = new Map<string, Memory>();

  constructor(private readonly options: ScopeOptions) {}

  private sessionMemory(sessionId: string): Memory {
    let memory = this.sessions.get(sessionId);
    if (!memory) {
      memory = new Memory(this.options.sessionCapacity ?? 60);
      this.sessions.set(sessionId, memory);
    }
    return memory;
  }

    /**
   * Learn into the session layer only. Does not persist.
   *
   * Tags the source here rather than relying on the caller. The engine's
   * `rememberSession()` did tag it, but a direct caller of this class did not —
   * which produced a session fact whose layer was unidentifiable, so `render()`
   * labelled it "remembered" when it was about to be thrown away with the session.
   */
  learnSession(sessionId: string, candidate: FactCandidate): boolean {
    const source = candidate.source.startsWith(SESSION_TAG)
      ? candidate.source
      : `${SESSION_TAG}${candidate.source || 'chat'}`;
    return this.sessionMemory(sessionId).learn({ ...candidate, source });
  }

  /** Learn into the durable layer and persist. Survives everything. */
  remember(jid: string, candidate: FactCandidate): boolean {
    const user = userKey(jid);
    return this.options.durable.remember(user, { ...candidate, source: candidate.source || 'durable' });
  }

  /**
   * Recall, merging the session and durable layers.
   *
   * Session first, then durable, skipping anything already returned. The
   * precedence is read-only: a session fact is never promoted to durable by
   * being recalled.
   */
  recall(jid: string, sessionId: string, query?: string, limit = 15): MemoryFact[] {
    const fromSession = this.sessionMemory(sessionId).recall(query, limit);
    const seen = new Set(fromSession.map((f) => f.fact.toLowerCase()));

    const fromDurable = this.options.durable
      .for(userKey(jid))
      .recall(query, limit)
      .filter((f) => !seen.has(f.fact.toLowerCase()));

    return [...fromSession, ...fromDurable].slice(0, limit);
  }

  /** Render the merged memory as a prompt block, with the layer marked. */
  render(jid: string, sessionId: string, query?: string, limit = 15): string {
    const facts = this.recall(jid, sessionId, query, limit);
    if (facts.length === 0) return '';

    const lines = facts.map((f) => {
      const scope = f.source.startsWith('session:') ? 'this conversation' : 'remembered';
      return `- ${f.fact} (${scope}, from: ${f.source.replace(/^session:/, '')})`;
    });

    return `Known facts about this user:\n${lines.join('\n')}`;
  }

  /** Forget across **both** layers. */
  forget(jid: string, sessionId: string, topic: string): number {
    const fromSession = this.sessionMemory(sessionId).forget(topic);
    const fromDurable = this.options.durable.forget(userKey(jid), topic);
    return fromSession + fromDurable;
  }

  /** Forget only the session layer — a "forget this conversation" request. */
  forgetSession(sessionId: string, topic?: string): number {
    if (!topic) {
      const memory = this.sessionMemory(sessionId);
      const n = memory.size;
      memory.clear();
      this.sessions.delete(sessionId);
      return n;
    }
    return this.sessionMemory(sessionId).forget(topic);
  }

  /** End a session, dropping its layer. Durable memory is untouched. */
  endSession(sessionId: string): number {
    return this.forgetSession(sessionId);
  }

  /** How many sessions are live. */
  get activeSessions(): number {
    return this.sessions.size;
  }

  /** Drop cached sessions older than this. Long-lived bots accumulate them. */
  sweep(): number {
    let removed = 0;
    // Memory has no TTL of its own; this is the seam for one.
    for (const key of [...this.sessions.keys()]) {
      this.sessions.delete(key);
      removed += 1;
    }
    return removed;
  }
}