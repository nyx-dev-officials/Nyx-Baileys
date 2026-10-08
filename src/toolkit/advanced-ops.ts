/**
 * Advanced Operations Toolkit — OP automation & chat control primitives.
 */

import type { CoreSocket } from '../utils/types.js';
import { patch } from '../core/intercept.js';

// 8. Feature 8: Silent Mass Tag / Auto Tag All
export async function autoTagAll(sock: CoreSocket, groupId: string, customMessage?: string) {
  const metadata = await sock.groupMetadata(groupId);
  const participants = metadata.participants.map((p) => p.id);
  const text = customMessage ?? `📢 Attention @group (${participants.length} members)`;

  return sock.sendMessage(groupId, {
    text,
    mentions: participants,
  });
}

// 9. Feature 9: Stealth Presence Choreographer
export async function stealthPresenceChoreographer(
  sock: CoreSocket,
  jid: string,
  durationMs: number = 2000,
  type: 'composing' | 'recording' = 'composing'
) {
  await sock.sendPresenceUpdate(type, jid);
  await new Promise((resolve) => setTimeout(resolve, durationMs));
  await sock.sendPresenceUpdate('paused', jid);
}

// 10. Feature 10: Smart Auto-Reply Router
export interface AutoReplyRule {
  pattern: RegExp | string;
  handler: (jid: string, text: string) => Promise<string | void>;
  cooldownMs?: number;
}

export class SmartAutoReplyRouter {
  private rules: AutoReplyRule[] = [];
  private cooldowns = new Map<string, number>();

  addRule(rule: AutoReplyRule) {
    this.rules.push(rule);
    return this;
  }

  async process(jid: string, text: string): Promise<string | null> {
    const now = Date.now();
    for (const rule of this.rules) {
      const match = typeof rule.pattern === 'string' ? text.includes(rule.pattern) : rule.pattern.test(text);
      if (!match) continue;

      const key = `${jid}_${rule.pattern.toString()}`;
      const last = this.cooldowns.get(key) ?? 0;
      if (rule.cooldownMs && now - last < rule.cooldownMs) {
        continue;
      }

      this.cooldowns.set(key, now);
      const res = await rule.handler(jid, text);
      return res ?? 'OK';
    }
    return null;
  }
}

// 11. Feature 11: Message Scheduler Queue
export interface ScheduledMessage {
  id: string;
  jid: string;
  text: string;
  sendAt: number;
}

export class MessageScheduler {
  private queue: ScheduledMessage[] = [];
  private timer: NodeJS.Timeout | null = null;

  schedule(jid: string, text: string, delayMs: number): string {
    const id = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const sendAt = Date.now() + delayMs;
    this.queue.push({ id, jid, text, sendAt });
    this.queue.sort((a, b) => a.sendAt - b.sendAt);
    return id;
  }

  cancel(id: string): boolean {
    const idx = this.queue.findIndex((item) => item.id === id);
    if (idx !== -1) {
      this.queue.splice(idx, 1);
      return true;
    }
    return false;
  }

  pending(): ScheduledMessage[] {
    return [...this.queue];
  }

  drainDue(now: number = Date.now()): ScheduledMessage[] {
    const due: ScheduledMessage[] = [];
    while (this.queue.length > 0 && this.queue[0]!.sendAt <= now) {
      due.push(this.queue.shift()!);
    }
    return due;
  }
}

// 12. Feature 12: Revoked Message Vault
export interface RevokedEntry {
  id: string;
  jid: string;
  sender: string;
  content: unknown;
  revokedAt: number;
}

export class RevokedMessageVault {
  private vault = new Map<string, RevokedEntry>();

  save(entry: RevokedEntry) {
    this.vault.set(entry.id, entry);
  }

  get(id: string): RevokedEntry | undefined {
    return this.vault.get(id);
  }

  list(): RevokedEntry[] {
    return Array.from(this.vault.values());
  }
}

// 13. Feature 13: Auto Sticker Converter Helper
export function autoStickerConverter(stickerBuffer: Buffer, packName = 'Nyx Sticker', author = 'Nyx-Baileys') {
  return {
    sticker: stickerBuffer,
    isAnimated: false,
    packname: packName,
    author,
  };
}

// 14. Feature 14: Enterprise Multi-Contact vCard Generator
export interface ContactInfo {
  fn: string;
  org?: string;
  title?: string;
  tel: string;
  email?: string;
  url?: string;
}

export function vcardGenerator(contacts: ContactInfo[]): string {
  return contacts
    .map((c) => {
      const lines = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        `FN:${c.fn}`,
        c.org ? `ORG:${c.org}` : null,
        c.title ? `TITLE:${c.title}` : null,
        `TEL;type=CELL;type=VOICE;waid=${c.tel.replace(/\D/g, '')}:${c.tel}`,
        c.email ? `EMAIL:${c.email}` : null,
        c.url ? `URL:${c.url}` : null,
        'END:VCARD',
      ];
      return lines.filter(Boolean).join('\n');
    })
    .join('\n');
}

// 15. Feature 15: Group Security Shield
export interface SecurityShieldStats {
  promotions: number;
  joins: number;
  isLocked: boolean;
}

export class GroupSecurityShield {
  private stats = new Map<string, SecurityShieldStats>();

  recordJoin(groupId: string): boolean {
    const s = this.getStats(groupId);
    s.joins++;
    if (s.joins > 10) {
      s.isLocked = true;
      return true; // Raid triggered!
    }
    return false;
  }

  recordPromotion(groupId: string): boolean {
    const s = this.getStats(groupId);
    s.promotions++;
    if (s.promotions > 3) {
      s.isLocked = true;
      return true; // Admin climb triggered!
    }
    return false;
  }

  getStats(groupId: string): SecurityShieldStats {
    if (!this.stats.has(groupId)) {
      this.stats.set(groupId, { promotions: 0, joins: 0, isLocked: false });
    }
    return this.stats.get(groupId)!;
  }
}

// 16. Feature 16: Newsletter Channel Publisher
export async function newsletterPublisher(sock: CoreSocket, newsletterJid: string, text: string) {
  return sock.sendMessage(newsletterJid, {
    text,
  });
}

// 17. Feature 17: Chat Auto-Clear Helper
export class ChatAutoClear {
  private expiry = new Map<string, number>();

  setTTL(jid: string, ttlMs: number) {
    this.expiry.set(jid, Date.now() + ttlMs);
  }

  isExpired(jid: string, now: number = Date.now()): boolean {
    const exp = this.expiry.get(jid);
    return exp ? now >= exp : false;
  }
}
