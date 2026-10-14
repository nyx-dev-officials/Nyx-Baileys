import type { Plugin, PluginContext } from '../utils/types.js';
import { patch } from '../core/intercept.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAdReplyEnabled } from '../toolkit/adreply-state.js';

/** The pre-compressed card artwork, shipped next to the compiled plugin. */
function assetPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'ad-reply-thumb.jpg');
}

export interface AdReplyOptions {
  /**
   * Honour the persisted `flux adreply on` switch. On by default, which means the
   * card is OFF for anyone who has not run the command. Pass `false` to stamp the
   * card unconditionally — that is what the unit tests use, so they do not depend
   * on a session file existing.
   */
  stateful?: boolean;
  /** Card headline. Keep it short — it renders on one line above the thumbnail. */
  displayName?: string;
  /** Card subline. */
  body?: string;
  /** Where the card taps through to. */
  sourceUrl?: string;
  /** The media the card advertises. Rendered as a preview, not sent as an attachment. */
  mediaUrl?: string;
  /** Preview thumbnail. */
  thumbnailUrl?: string;
  /**
   * Opt in. Off by default so a plain library user gets no card they did not ask
   * for. The plugin is cosmetic branding, not a capability: it cannot make an
   * account official, and the text on the card is only whatever you put there.
   */
  enabled?: boolean;
}

/**
 * Attach a native `externalAdReply` ad card to every outgoing message.
 *
 * This is the pattern the reference bots reach for by monkey-patching their reply
 * helper. Doing it as a plugin instead means it is removable, opt-in, and does not
 * fire on sends that deliberately carry their own context.
 *
 * Field names are restricted to ones that actually exist on
 * `proto.ContextInfo.ExternalAdReplyInfo` in rc14 — verified against
 * `WAProto/index.d.ts`. Inventing a field here would be silently dropped by
 * protobuf, which is how most of these cards end up rendering with only a title.
 */
export function adReply(options: AdReplyOptions = {}): Plugin {
  return {
    name: 'ad-reply',
    order: 13,
    apply({ sock, onDispose }: PluginContext) {
      if (options.enabled === false) return;
      // The switch is per-session and owner-controlled. Reading it once at apply
      // time means `flux adreply on` needs a restart to take effect — that is the
      // honest trade for not paying a file read on every single outgoing message.
      if (options.stateful !== false && !isAdReplyEnabled()) return;

      const mediaUrl = options.mediaUrl ?? 'https://videotourl.com/videos/1791285535994-f54d2fe5-3ab1-416b-ba0d-c9fcde4c3e3a.mp4';
      // The source `thumbnailUrl` points at is 5504x3072 and 22MB, which is a
      // thumbnail WhatsApp's card fetcher will time out on. The same artwork,
      // cropped to 1280x720 and re-encoded, ships alongside the build as a 144KB
      // buffer: embedded, so the card renders without a remote round-trip. Falls
      // back to the URL if the asset is missing rather than sending no image.
      let embedded: Uint8Array | undefined;
      try {
        embedded = new Uint8Array(readFileSync(assetPath()));
      } catch {
        embedded = undefined;
      }
      const externalAdReply = {
        title: options.displayName ?? '𝓝𝔂𝔁 • 𝓕𝓵𝓾𝔁',
        body: options.body ?? 'whatsapp -bot  •  nyx-devs',
        sourceUrl: options.sourceUrl ?? 'https://nyx-devs.vercel.app',
        mediaUrl,
        thumbnailUrl: options.thumbnailUrl ?? 'https://i.im.ge/QQqwVKC/Blackhole.png',
        ...(embedded ? { thumbnail: embedded } : {}),
        // 1 = IMAGE, 2 = VIDEO. This has to agree with `mediaUrl` or the client
        // is asked to render an mp4 as a still and shows nothing. Derived from the
        // URL rather than pinned, so swapping `mediaUrl` cannot desync them.
        mediaType: /\.mp4(\?|$)/i.test(String(mediaUrl)) ? 2 : 1,
        renderLargerThumbnail: true,
        showAdAttribution: true,
      };

      const handle = patch(sock as never, 'sendMessage', ((
        original: (...args: unknown[]) => unknown,
        self: unknown,
        args: unknown[],
      ): Promise<unknown> => {
        const jid = args[0] as string;
        const content = args[1];
        if (typeof content !== 'object' || content === null) {
          return Reflect.apply(original, self, args) as Promise<unknown>;
        }

        const payload = { ...(content as Record<string, unknown>) };
        const existing = (payload.contextInfo ?? {}) as Record<string, unknown>;

        // Never stomp a card the caller set deliberately.
        if (existing.externalAdReply === undefined) {
          payload.contextInfo = { ...existing, externalAdReply };
        }

        return Reflect.apply(original, self, [jid, payload, ...args.slice(2)]) as Promise<unknown>;
      }) as never);

      if (handle.applied) onDispose(() => handle.undo());
    },
  };
}