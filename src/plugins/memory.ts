import type { WAMessage } from '@whiskeysockets/baileys';

import type { Plugin } from '../utils/types.js';

/**
 * Memory GC.
 *
 * A long-lived router accumulates message history, status entries and media
 * references until Node's heap gives out — usually on a small VPS. This plugin
 * keeps all three bounded and runs on a timer plus an LRU pass after each
 * upsert, so pressure is relieved continuously instead of at the point of
 * failure.
 *
 * Media *bytes* are only released when nothing references them, so an
 * in-flight download isn't pulled out from under a caller.
 */

export interface MemoryGcOptions {
  /** Messages kept per chat. */
  keepMessagesPerChat?: number;
  /** Status entries kept. */
  keepStatuses?: number;
  /** Media entries kept in the blob table. */
  keepMedia?: number;
  /** Sweep interval. */
  intervalMs?: number;
  /** Log a line when heap usage crosses this. 0 disables. */
  heapWarnMb?: number;
}

export interface MediaBlob {
  key: string;
  size: number;
  at: number;
  ref: Buffer;
}

export function memoryGc(options: MemoryGcOptions = {}): Plugin {
  const keepMessages = options.keepMessagesPerChat ?? 200;
  const keepStatuses = options.keepStatuses ?? 100;
  const keepMedia = options.keepMedia ?? 100;
  const interval = options.intervalMs ?? 60_000;
  const heapWarn = options.heapWarnMb ?? 0;

  return {
    name: 'memory-gc',
    order: 50,

    apply(ctx) {
      const log = ctx.log.child('gc');

      /** chat jid -> newest-first list of message ids */
      const history = new Map<string, string[]>();
      const statuses: number[] = [];
      const media = new Map<string, MediaBlob>();

      /** Keep only the newest `n` entries, oldest evicted. */
      const trim = <T>(list: T[], n: number): T[] => (list.length > n ? list.slice(list.length - n) : list);

      const sweep = (): void => {
        for (const [jid, ids] of history) {
          const next = trim(ids, keepMessages);
          if (next.length !== ids.length) history.set(jid, next);
          // Chat with an empty trail is not worth keeping.
          if (next.length === 0) history.delete(jid);
        }

        if (statuses.length > keepStatuses) {
          statuses.splice(0, statuses.length - keepStatuses);
        }

        // Media is evicted oldest-first. The map entry always goes, even for a
        // zero-length buffer — skipping it pinned the entry forever and let
        // `media.size` grow past the documented ceiling.
        if (media.size > keepMedia) {
          const ordered = [...media.values()].sort((a, b) => a.at - b.at);
          for (const blob of ordered.slice(0, media.size - keepMedia)) {
            media.delete(blob.key);
          }
        }

        if (heapWarn > 0) {
          const used = process.memoryUsage().heapUsed / 1024 / 1024;
          if (used > heapWarn) {
            log.warn('heap pressure', { usedMb: Math.round(used), chats: history.size, media: media.size });
          }
        }
      };

      ctx.sock.ev.on('messages.upsert', (event: { messages: WAMessage[] }) => {
        for (const msg of event.messages ?? []) {
          const jid = msg.key?.remoteJid;
          const id = msg.key?.id;
          if (!jid || !id) continue;

          const ids = history.get(jid) ?? [];
          ids.push(id);
          history.set(jid, trim(ids, keepMessages));

          // Status posts ride the same upsert channel; count them separately
          // so they never crowd real chat history out of the window. rc14's
          // IMessage has no dedicated status field, so match on the wire key.
          const kind = msg.message ? Object.keys(msg.message).find((k) => k.startsWith('status')) : undefined;
          if (kind) statuses.push(Number(msg.messageTimestamp ?? Date.now()));

          sweep();
        }
      });

      const timer = setInterval(sweep, interval);
      timer.unref?.();

      Object.defineProperty(ctx.sock, 'store', {
        value: {
          history,
          media,
          statuses,
          put: (key: string, ref: Buffer) => {
            media.set(key, { key, size: ref.byteLength, at: Date.now(), ref });
            sweep();
          },
          take: (key: string): Buffer | undefined => {
            const blob = media.get(key);
            if (!blob) return undefined;
            media.delete(key);
            return blob.ref;
          },
          stats: () => ({
            chats: history.size,
            media: media.size,
            statuses: statuses.length,
            heapMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          }),
          sweep,
        },
        enumerable: false,
        configurable: true,
      });

      ctx.onDispose(() => clearInterval(timer));
      log.debug('attached', { keepMessages, keepStatuses, keepMedia, interval });
    },
  };
}

export default memoryGc;
