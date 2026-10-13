/**
 * The AI gate: sleep/wake words, ambient replies, nothing else.
 *
 * The commands plugin owns every `flux <command>` (including `flux ai on` —
 * `ai` is a registry command). This plugin owns exactly two things the router
 * cannot express: the bare wake word, and non-command messages when awake.
 *
 * - Bare `flux` (any case, any separator, nothing after it) from the owner or
 *   a permitted person wakes the AI globally, permits the current chat, and
 *   acknowledges — but only on a state change, so repeating it does not chatter.
 *   Anyone else's bare word is met with silence, not a denial: denials teach
 *   probing.
 * - Anything else starting with the prefix is ignored here. The router owns it;
 *   two responders to one message is how double replies happen.
 * - Any other text is ambient: answered only when awake, only in a permitted
 *   chat, and in groups only when addressed (mention or quote of the bot).
 *   Everyone may receive; only the owner flips the switch.
 *
 * Model failures answer with one fixed line. Anything more specific would leak
 * provider internals into chats, and anything silent would read as a dead bot.
 */

import type { BaileysEventMap } from '@whiskeysockets/baileys';

import { createBot, RateLimiter, type BotEngine } from '../toolkit/ai/engine.js';
import { readOpenRouterKey } from '../toolkit/ai-state.js';
import type { ProviderConfig } from '../toolkit/ai/providers.js';
import { configureAiState, isAwake, isChatPermitted, permitChat, setAwake } from '../toolkit/ai-state.js';
import { permittedPersons } from '../toolkit/ai-state.js';
import { stripPrefix, toUser } from './commands.js';
import type { CoreSocket, Plugin } from '../utils/types.js';

export const AI_BUSY_REPLY = 'flux is busy try again';

export interface AiGateOptions {
  /** Bare numbers or JIDs. Compared normalized, like everywhere else. */
  owners?: readonly string[];
  /** Trigger word family. Default `flux `. */
  prefix?: string;
  /** Session directory the AI state file lives beside. Configures ai-state. */
  sessionDir: string;
  /** Ambient replies per chat per minute. Default 8. */
  ambientPerMinute?: number;
  /** Override engine construction. Tests only — production resolves providers. */
  createEngine?: () => Promise<EngineLike | null>;
}

/** Structural minimum the gate needs. The real BotEngine satisfies it. */
export interface EngineLike {
  respond(
    sock: CoreSocket,
    jid: string,
    message: unknown,
  ): Promise<{ sent: boolean; action: string } | null>;
}

interface UpsertMessageShape {
  key?: { remoteJid?: string; fromMe?: boolean; participant?: string };
  message?: {
    conversation?: string | null;
    extendedTextMessage?: {
      text?: string | null;
      contextInfo?: {
        mentionedJid?: unknown;
        participant?: unknown;
        quotedMessage?: unknown;
      } | null;
    } | null;
  } | null;
}

function shapeOf(msg: unknown): UpsertMessageShape {
  return (msg ?? {}) as UpsertMessageShape;
}

function messageText(msg: unknown): string {
  const m = shapeOf(msg).message;
  return m?.conversation ?? m?.extendedTextMessage?.text ?? '';
}

function senderOf(msg: unknown): string {
  const key = shapeOf(msg).key;
  return toUser(key?.participant ?? key?.remoteJid ?? '');
}

function chatOf(msg: unknown): string {
  const remoteJid = shapeOf(msg).key?.remoteJid;
  return typeof remoteJid === 'string' ? remoteJid : '';
}

/** Mentioned, quoted, or nothing. Deterministic — no model call to detect it. */
function isAddressed(msg: unknown, botJid: string): boolean {
  const info = shapeOf(msg).message?.extendedTextMessage?.contextInfo;
  if (!info || typeof info !== 'object') return false;
  const bare = toUser(botJid);
  const mentioned = (info as { mentionedJid?: unknown }).mentionedJid;
  if (Array.isArray(mentioned) && mentioned.some((jid) => typeof jid === 'string' && (jid === botJid || toUser(jid) === bare))) {
    return true;
  }
  const quoted = (info as { participant?: unknown }).participant;
  return typeof quoted === 'string' && (quoted === botJid || toUser(quoted) === bare);
}

async function ollamaModel(): Promise<string | null> {
  try {
    const response = await fetch('http://127.0.0.1:11434/api/tags', {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { models?: Array<{ name?: string }> };
    const name = data.models?.find((m) => typeof m.name === 'string' && m.name)?.name;
    return name ?? null;
  } catch {
    return null;
  }
}

export function aiGate(options: AiGateOptions): Plugin {
  const prefix = options.prefix ?? 'flux ';
  const owners = new Set((options.owners ?? []).map(toUser).filter(Boolean));
  configureAiState(options.sessionDir);

  const limiter = new RateLimiter(options.ambientPerMinute ?? 8);
  let engine: EngineLike | null = null;
  let engineFailed = false;

  async function getEngine(): Promise<EngineLike | null> {
    if (engine || engineFailed) return engine;
    if (options.createEngine) {
      try {
        engine = await options.createEngine();
      } catch {
        engine = null;
      }
      if (!engine) engineFailed = true;
      return engine;
    }
    // Order is the user's call: strongest brain first, keyless cloud second,
    // local install last. A missing key skips its provider rather than failing.
    const usable: ProviderConfig[] = [];
    const openRouterKey = readOpenRouterKey();
    if (openRouterKey) {
      usable.push({ provider: 'openrouter', model: 'nvidia/nemotron-3-ultra-550b-a55b:free', apiKey: openRouterKey });
    }
    usable.push({ provider: 'pollinations', model: 'openai' });
    const ollama = await ollamaModel();
    if (ollama) usable.push({ provider: 'ollama', model: ollama });
    const [primary, ...rest] = usable;
    if (!primary) {
      engineFailed = true;
      return null;
    }
    try {
      engine = createBot({
        ai: primary,
        aiFallbacks: rest,
        policy: { rateLimitPerMinute: options.ambientPerMinute ?? 8 },
      });
    } catch {
      engineFailed = true;
      return null;
    }
    return engine;
  }

  async function send(sock: CoreSocket, jid: string, text: string): Promise<void> {
    await sock.sendMessage(jid, { text });
  }

  return {
    name: 'ai-gate',
    order: 165,
    apply(ctx) {
      const isOwner = (sender: string): boolean => owners.has(sender);
      const isPermittedPerson = (sender: string): boolean =>
        permittedPersons().map(toUser).includes(sender);

      ctx.sock.ev.on('messages.upsert', (event: BaileysEventMap['messages.upsert']) => {
        for (const msg of event?.messages ?? []) {
          void (async (): Promise<void> => {
            try {
              if (msg.key?.fromMe) return;
              const jid = chatOf(msg);
              if (!jid) return;
              const text = messageText(msg);
              if (!text.trim()) return;

              const stripped = stripPrefix(text, prefix);
              if (stripped) {
                // Anything beyond the bare word belongs to the router.
                if (!stripped.bare) return;
                const sender = senderOf(msg);
                if (!isOwner(sender) && !isPermittedPerson(sender)) return;
                const woke = setAwake(true);
                const permitted = permitChat(jid);
                if (woke || permitted) {
                  await send(ctx.sock, jid, 'AI awake here — I reply in this chat. `flux off` to sleep.');
                }
                return;
              }

              if (!isAwake() || !isChatPermitted(jid)) return;
              const group = jid.endsWith('@g.us');
              if (group && !isAddressed(msg, ctx.sock.user?.id ?? '')) return;
              if (!limiter.take(jid)) return;

              const brain = await getEngine();
              if (!brain) {
                await send(ctx.sock, jid, AI_BUSY_REPLY);
                return;
              }
              const result = await brain.respond(ctx.sock, jid, msg).catch(() => null);
              if (!result || (!result.sent && result.action !== 'silent')) {
                await send(ctx.sock, jid, AI_BUSY_REPLY);
              }
            } catch (err) {
              ctx.log.debug('ai gate turn failed', { err: (err as Error).message });
            }
          })();
        }
      });
    },
  };
}
