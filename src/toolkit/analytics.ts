/**
 * Analytics, Intelligence & Operational Guard Toolkit.
 */

import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// 18. Feature 18: Message Sentiment Analyzer
export interface SentimentResult {
  score: number;
  comparative: number;
  intent: 'positive' | 'negative' | 'neutral';
  keywords: string[];
}

const POSITIVE_WORDS = new Set(['great', 'awesome', 'good', 'super', 'love', 'thanks', 'cool', 'excellent', 'fast', 'op', 'best']);
const NEGATIVE_WORDS = new Set(['bad', 'terrible', 'slow', 'hate', 'error', 'broken', 'fail', 'worst', 'spam', 'scam', 'bug']);

export function messageSentimentAnalyzer(text: string): SentimentResult {
  const words = text.toLowerCase().match(/\w+/g) || [];
  let score = 0;
  const keywords: string[] = [];

  for (const word of words) {
    if (POSITIVE_WORDS.has(word)) {
      score += 1;
      keywords.push(word);
    } else if (NEGATIVE_WORDS.has(word)) {
      score -= 1;
      keywords.push(word);
    }
  }

  const comparative = words.length > 0 ? score / words.length : 0;
  const intent = score > 0 ? 'positive' : score < 0 ? 'negative' : 'neutral';

  return { score, comparative, intent, keywords };
}

// 19. Feature 19: Group Activity Monitor
export interface GroupActivityStats {
  messageCount: number;
  senders: Map<string, number>;
  hourlyHistogram: number[];
  spamScore: number;
}

export class GroupActivityMonitor {
  private stats = new Map<string, GroupActivityStats>();

  recordMessage(groupId: string, senderJid: string, timestampMs: number = Date.now(), isSpamCandidate = false) {
    if (!this.stats.has(groupId)) {
      this.stats.set(groupId, {
        messageCount: 0,
        senders: new Map(),
        hourlyHistogram: new Array(24).fill(0),
        spamScore: 0,
      });
    }

    const s = this.stats.get(groupId)!;
    s.messageCount++;
    s.senders.set(senderJid, (s.senders.get(senderJid) ?? 0) + 1);

    const hour = new Date(timestampMs).getUTCHours();
    s.hourlyHistogram[hour] = (s.hourlyHistogram[hour] ?? 0) + 1;

    if (isSpamCandidate) {
      s.spamScore += 1;
    }
  }

  getTopSenders(groupId: string, topN = 5): Array<{ jid: string; count: number }> {
    const s = this.stats.get(groupId);
    if (!s) return [];

    return Array.from(s.senders.entries())
      .map(([jid, count]) => ({ jid, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, topN);
  }
}

// 20. Feature 20: Connection Quality Probe
export interface ProbeStats {
  samples: number[];
  avgRttMs: number;
  jitterMs: number;
}

export class ConnectionQualityProbe {
  private samples: number[] = [];

  recordSample(rttMs: number) {
    this.samples.push(rttMs);
    if (this.samples.length > 50) {
      this.samples.shift();
    }
  }

  getStats(): ProbeStats {
    if (this.samples.length === 0) return { samples: [], avgRttMs: 0, jitterMs: 0 };
    const sum = this.samples.reduce((a, b) => a + b, 0);
    const avgRttMs = sum / this.samples.length;

    let totalDiff = 0;
    for (let i = 1; i < this.samples.length; i++) {
      totalDiff += Math.abs(this.samples[i]! - this.samples[i - 1]!);
    }
    const jitterMs = this.samples.length > 1 ? totalDiff / (this.samples.length - 1) : 0;

    return { samples: [...this.samples], avgRttMs, jitterMs };
  }
}

// 21. Feature 21: Adaptive Rate Limit Shield
export class RateLimitShield {
  private errorsInWindow = 0;
  private backoffMultiplier = 1.0;

  recordError() {
    this.errorsInWindow++;
    if (this.errorsInWindow > 3) {
      this.backoffMultiplier = Math.min(this.backoffMultiplier * 1.5, 8.0);
    }
  }

  recordSuccess() {
    if (this.errorsInWindow > 0) this.errorsInWindow--;
    this.backoffMultiplier = Math.max(this.backoffMultiplier * 0.9, 1.0);
  }

  getMultiplier(): number {
    return this.backoffMultiplier;
  }
}

// 22. Feature 22: Session Health Audit
export interface SessionHealthResult {
  valid: boolean;
  credsExist: boolean;
  registered: boolean;
  meJid?: string;
  error?: string;
}

export function sessionHealthAudit(sessionDir: string): SessionHealthResult {
  const credsPath = join(sessionDir, 'creds.json');
  if (!existsSync(credsPath)) {
    return { valid: false, credsExist: false, registered: false, error: 'creds.json missing' };
  }

  try {
    const raw = readFileSync(credsPath, 'utf8');
    const creds = JSON.parse(raw);
    const registered = creds.registered === true || Boolean(creds.me?.id && creds.account?.deviceSignature);
    const meJid = creds.me?.id;

    return {
      valid: true,
      credsExist: true,
      registered,
      meJid,
    };
  } catch (err) {
    return {
      valid: false,
      credsExist: true,
      registered: false,
      error: (err as Error).message,
    };
  }
}

// 23. Feature 23: Media Metadata Inspector
export interface MediaMetadata {
  mime: string;
  estimatedSizeBytes: number;
  extension: string;
}

export function mediaMetadataExtractor(buffer: Buffer, mime: string): MediaMetadata {
  const ext = mime.split('/')[1]?.split(';')[0] ?? 'bin';
  return {
    mime,
    estimatedSizeBytes: buffer.byteLength,
    extension: ext,
  };
}

// 24. Feature 24: Rich Text Beautifier
export function richTextBeautifier(title: string, content: string): string {
  const border = '═'.repeat(title.length + 4);
  return `╔${border}╗\n║  ${title}  ║\n╚${border}╝\n\n${content}`;
}

// 25. Feature 25: Signed Webhook Dispatcher
export async function webhookDispatcher(url: string, secret: string, payload: unknown): Promise<{ status: number; ok: boolean }> {
  const json = JSON.stringify(payload);
  const signature = createHmac('sha256', secret).update(json).digest('hex');

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Nyx-Signature': `sha256=${signature}`,
    },
    body: json,
  });

  return { status: response.status, ok: response.ok };
}
