/**
 * Operational toolkit — diagnostic hooks and everyday chat/group actions.
 *
 * Everything here is a thin, explicit wrapper over the rc14 socket surface. No
 * fork, no `node_modules` edits, no monkey-patching of Baileys internals beyond
 * the single documented `ws.send` observation hook, which is the one thing that
 * cannot be reached any other way.
 *
 * ## One deviation, deliberately
 *
 * The AES-GCM media decryptor is written here against a *runtime lookup* of
 * `decryptMediaMessage` rather than a static import. In rc14 that export does
 * not exist (the tree exposes `downloadMediaMessage` and
 * `decryptMediaRetryData`), and a static named import of a missing binding
 * throws at module-evaluation time — which would take this entire module, and
 * every importer of it, down with it. Looking it up lazily means the rest of
 * the toolkit works, and this one function reports its own absence clearly.
 *
 * Everything else matches the specified shape.
 */

import { createHash } from 'node:crypto';

type AnySock = Record<string, any>;

/* ════════════════════════════════════════════════════════════════════════
   Part 1 — developer, secret and operational code
   ════════════════════════════════════════════════════════════════════════ */

/** 1. Zero-allocation binary stanza observer on the raw WebSocket. */
export function attachStanzaInterceptor(
  sock: AnySock,
  onFrame?: (bytes: number, direction: 'out') => void,
): () => void {
  const ws = sock?.ws;
  if (!ws) return () => {};
  const originalSend = ws.send;
  ws.send = function patched(this: unknown, data: unknown, ...args: unknown[]) {
    // Buffer check is free and never allocates; anything else passes through
    // untouched so a non-binary send is not perturbed.
    if (Buffer.isBuffer(data)) onFrame?.(data.byteLength, 'out');
    return originalSend.call(this, data, ...args);
  };
  return () => {
    ws.send = originalSend;
  };
}

/** 2. Headless pairing-code extractor, for containers with no terminal QR. */
export function extractPairingCode(sock: AnySock, phoneNumber: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!sock?.requestPairingCode) {
      reject(new Error('requestPairingCode is unavailable on this socket'));
      return;
    }
    const onUpdate = async (update: AnySock): Promise<void> => {
      if (!update?.qr) return;
      try {
        resolve(await sock.requestPairingCode(phoneNumber));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      } finally {
        sock.ev?.off?.('connection.update', onUpdate);
      }
    };
    sock.ev.on('connection.update', onUpdate);
  });
}

/** 3. Raw AES-GCM media decryptor. Runtime lookup — see the header note. */
export async function rawDecryptMedia(
  sock: AnySock,
  messageNode: AnySock,
): Promise<Buffer> {
  const media =
    messageNode?.message?.imageMessage ||
    messageNode?.message?.documentMessage ||
    messageNode?.message?.videoMessage ||
    messageNode?.message?.audioMessage ||
    messageNode?.message?.stickerMessage;
  if (!media) throw new Error('No media found in node');

  const decrypt = (sock as AnySock)?.decryptMediaMessage
    ?? (await import('@whiskeysockets/baileys') as AnySock).decryptMediaMessage;
  if (typeof decrypt !== 'function') {
    throw new Error(
      'decryptMediaMessage is not exported by the installed baileys. ' +
        'Use downloadMediaMessage from the package instead.',
    );
  }

  return decrypt(
    {
      directPath: media.directPath,
      mediaKey: media.mediaKey,
      url: media.url,
      mimetype: media.mimetype,
      fileEncSha256: media.fileEncSha256,
      fileSha256: media.fileSha256,
      fileLength: media.fileLength,
      mediaKeyTimestamp: media.mediaKeyTimestamp,
    },
    'buffer',
    { logger: sock.logger ?? console },
  );
}

/** 4. Session integrity auditor — catches a half-written creds file on boot. */
export async function auditSessionIntegrity(authCreds: AnySock): Promise<boolean> {
  if (!authCreds?.me?.id || !authCreds?.noiseKey?.private || !authCreds.registered) {
    console.warn('⚠️ [Integrity] Core noise keys or account registration missing.');
    return false;
  }
  return true;
}

/** 5. Socket keep-alive ping forcer, cleared on close. */
export function forceSocketHeartbeat(sock: AnySock, intervalMs = 30_000): () => void {
  const timer = setInterval(() => {
    const ws = sock?.ws;
    const OPEN = (sock as AnySock)?.WebSocket?.OPEN ?? (globalThis as AnySock).WebSocket?.OPEN ?? 1;
    if (ws && ws.readyState === OPEN) ws.ping();
  }, intervalMs);

  const onUpdate = (update: AnySock): void => {
    if (update?.connection === 'close') clearInterval(timer);
  };
  sock?.ev?.on?.('connection.update', onUpdate);

  return () => {
    clearInterval(timer);
    sock?.ev?.off?.('connection.update', onUpdate);
  };
}

/** 6. Priority message queue — urgent sends jump the queue. */
export class PriorityMessageQueue {
  #queue: Array<{ jid: string; content: unknown; priority: number }> = [];
  #isProcessing = false;

  enqueue(jid: string, content: unknown, priority = 1): void {
    this.#queue.push({ jid, content, priority });
    this.#queue.sort((a, b) => b.priority - a.priority);
  }

  get size(): number {
    return this.#queue.length;
  }

  async processQueue(sock: AnySock, gapMs = 1_200): Promise<void> {
    if (this.#isProcessing) return;
    this.#isProcessing = true;
    try {
      while (this.#queue.length > 0) {
        const item = this.#queue.shift();
        if (item) {
          await sock.sendMessage(item.jid, item.content);
          await new Promise((r) => setTimeout(r, gapMs));
        }
      }
    } finally {
      // Restored in a finally: a throw mid-drain must not wedge the queue shut.
      this.#isProcessing = false;
    }
  }
}

/** 7. Round-trip latency probe. */
export async function measureSocketLatency(sock: AnySock): Promise<number> {
  const start = performance.now();
  await sock.query({ tag: 'iq', attrs: { to: '@s.whatsapp.net', type: 'get', xmlns: 'w:p' } });
  return Math.round(performance.now() - start);
}

/** 8. Group metadata delta detector. */
export function setupGroupDeltaListener(
  sock: AnySock,
  onChange: (event: string, details: unknown) => void,
): () => void {
  const handler = (updates: AnySock[]): void => {
    for (const update of updates ?? []) {
      if (update?.subject) onChange('SUBJECT_CHANGE', update);
      if (update?.desc) onChange('DESCRIPTION_CHANGE', update);
      if (update?.participants) onChange('PARTICIPANTS_CHANGE', update);
    }
  };
  sock.ev.on('groups.update', handler);
  return () => sock.ev.off('groups.update', handler);
}

/** 9. Dynamic app-state mutation injector. */
export async function injectAppStatePatch(sock: AnySock, actionData: unknown): Promise<void> {
  const appStateSync = sock?.appStateSync;
  if (appStateSync && typeof appStateSync.uploadPatch === 'function') {
    await appStateSync.uploadPatch('regular_high', { actions: [actionData] });
  }
}

/** 10. Ephemeral timer scavenger — clears completed self-destruct handles. */
export class EphemeralMemoryScavenger {
  #trackingMap = new Map<string, NodeJS.Timeout>();

  track(id: string, handle: NodeJS.Timeout): void {
    this.#trackingMap.set(id, handle);
  }

  get size(): number {
    return this.#trackingMap.size;
  }

  clear(id: string): void {
    const handle = this.#trackingMap.get(id);
    if (handle) {
      clearTimeout(handle);
      this.#trackingMap.delete(id);
    }
  }
}

/* ════════════════════════════════════════════════════════════════════════
   Part 2 — everyday WhatsApp operations
   ════════════════════════════════════════════════════════════════════════ */

/** 1. Send a contact vCard. */
export async function sendContactCard(
  sock: AnySock,
  jid: string,
  name: string,
  phone: string,
): Promise<unknown> {
  const vcard =
    `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\n` +
    `TEL;type=CELL;type=VOICE;waid=${phone}:+${phone}\nEND:VCARD`;
  return sock.sendMessage(jid, { contacts: { displayName: name, contacts: [{ vcard }] } });
}

/** 2. Send a GPS location pin. */
export async function sendLocationPin(
  sock: AnySock,
  jid: string,
  lat: number,
  lng: number,
  name: string,
): Promise<unknown> {
  return sock.sendMessage(jid, { location: { degreesLatitude: lat, degreesLongitude: lng, name } });
}

/** 3. Update a group subject. */
export async function updateGroupSubject(
  sock: AnySock,
  groupJid: string,
  newTitle: string,
): Promise<void> {
  return sock.groupUpdateSubject(groupJid, newTitle);
}

/** 4. Update a group description. */
export async function updateGroupDescription(
  sock: AnySock,
  groupJid: string,
  newDesc: string,
): Promise<void> {
  return sock.groupUpdateDescription(groupJid, newDesc);
}

/** 5. Build a shareable group invite link. */
export async function getGroupInviteLink(sock: AnySock, groupJid: string): Promise<string> {
  const code = await sock.groupInviteCode(groupJid);
  if (!code) throw new Error(`no invite code for ${groupJid} — is this account an admin?`);
  return `https://chat.whatsapp.com/${code}`;
}

/** 6. Mute a chat for a duration, or unmute with null. */
export async function setChatMute(
  sock: AnySock,
  jid: string,
  durationMs: number | null,
): Promise<void> {
  return sock.chatModify({ mute: durationMs ? Date.now() + durationMs : null }, jid);
}

/** 7. Archive a chat. */
export async function setChatArchive(
  sock: AnySock,
  jid: string,
  archive: boolean,
): Promise<void> {
  return sock.chatModify({ archive, lastMessages: [] }, jid);
}

/** 8. Pin a chat to the top of the list. */
export async function setChatPin(sock: AnySock, jid: string, pin: boolean): Promise<void> {
  return sock.chatModify({ pin }, jid);
}

/**
 * 9. Star a message.
 *
 * This is a `chatModify`, not a `sendMessage` content key — sending it through
 * `sendMessage` does nothing at all, which is why it is routed here.
 */
export async function starMessage(
  sock: AnySock,
  jid: string,
  messageKey: { id: string; fromMe?: boolean },
  star: boolean,
): Promise<void> {
  return sock.chatModify(
    { star: { messages: [{ id: messageKey.id, fromMe: messageKey.fromMe }], star } },
    jid,
  );
}

/**
 * 10. Send media with a caption.
 *
 * The buffer is the *value* of the media key and `mimetype`/`fileName` sit
 * beside it. rc14's `getStream` checks `Buffer.isBuffer(item)` first, then
 * `'stream' in item`, then `item.url` — so `{ image: { buffer } }` matches none
 * of the three and dies on `undefined.url`.
 */
export async function sendMediaWithCaption(
  sock: AnySock,
  jid: string,
  buffer: Buffer,
  caption: string,
  type: 'image' | 'video' | 'document',
  mimetype?: string,
  fileName?: string,
): Promise<unknown> {
  const payload: Record<string, unknown> = { caption };
  if (type === 'image') payload.image = buffer;
  else if (type === 'video') payload.video = buffer;
  else if (type === 'document') {
    payload.document = buffer;
    payload.mimetype = mimetype ?? 'application/pdf';
    payload.fileName = fileName ?? 'file.pdf';
  }
  return sock.sendMessage(jid, payload);
}

/**
 * 11. Send a verified spoof message.
 *
 * Injects a fake quoted message from the internal WhatsApp system account (0@s.whatsapp.net).
 * This forces the mobile client to render the official green/blue verified checkmark
 * next to the provided display name in the quote bubble.
 */
export async function sendVerifiedMessage(
  sock: AnySock,
  jid: string,
  text: string,
  displayName: string = 'Nyx Verified System',
): Promise<unknown> {
  const verifiedQuoteSpoof = {
    key: {
      fromMe: false,
      participant: '0@s.whatsapp.net',
      remoteJid: 'status@broadcast',
      id: 'NYX00000000000000000',
    },
    message: {
      contactMessage: {
        displayName,
        vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${displayName}\nEND:VCARD`,
      },
    },
  };

  return sock.sendMessage(jid, { text }, { quoted: verifiedQuoteSpoof });
}

/* ════════════════════════════════════════════════════════════════════════
   Grouping helpers
   ════════════════════════════════════════════════════════════════════════ */

/** A stable fingerprint for an auth blob, for change detection. */
export function sessionFingerprint(creds: AnySock): string {
  return createHash('sha256')
    .update(JSON.stringify({
      me: creds?.me?.id ?? null,
      registered: creds?.registered ?? null,
      noise: creds?.noiseKey?.private ? 'present' : 'absent',
    }))
    .digest('hex')
    .slice(0, 16);
}

/** Attach the whole operational toolkit to a socket in one call. */
export function attachOpsToolkit(sock: AnySock): () => void {
  const detach: Array<() => void> = [];
  detach.push(attachStanzaInterceptor(sock));
  detach.push(forceSocketHeartbeat(sock));
  return () => {
    for (const fn of detach.reverse()) {
      try {
        fn();
      } catch {
        /* a failed detach must not block the rest */
      }
    }
  };
}