import {
  aesEncryptGCM,
  decryptPollVote,
  generateMessageID,
  getKeyAuthor,
  hmacSign,
  jidNormalizedUser,
  proto,
  sha256,
} from '@whiskeysockets/baileys';
import { randomBytes } from 'node:crypto';

import type { BaileysEventMap, WAMessage, WAMessageKey } from '@whiskeysockets/baileys';
import type { Plugin } from '../utils/types.js';

/**
 * Polls: creation, voting, tracking, results, closing.
 *
 * ## Why this plugin exists at all
 *
 * rc14 can *create* polls through `sendMessage({ poll })` and that path is
 * solid — but it is one-way. Three gaps forced this plugin:
 *
 *   1. **No vote sender.** `AnyRegularMessageContent` has no poll-vote variant,
 *      so a vote has to be built and relayed by hand.
 *   2. **No vote reader.** Upstream's `pollUpdateMessage` decrypt branch in
 *      `Utils/process-message.js` is commented out, so votes arrive as opaque
 *      `PollEncValue` blobs. Nothing decrypts them.
 *   3. **No result cache.** The decrypt branch it disabled depended on
 *      `getMessage` to fetch the poll creation and read its `messageSecret`.
 *      This framework's core socket wires `getMessage: async () => undefined`
 *      (`src/core/socket.ts:91`), so that lookup can never succeed here.
 *
 * Consequence, and it is the whole design of this file: **a poll's secret is
 * only available at the moment we see its creation message.** So polls are
 * cached on arrival, keyed by creation-message id, and votes for a poll we
 * never observed are reported as undecryptable rather than guessed at.
 *
 * ## The vote cipher
 *
 * `decryptPollVote` derives its key as
 * `HMAC(HMAC(encKey, 0^32) over (msgId ‖ creator ‖ voter ‖ "Poll Vote" ‖ 0x01))`
 * with AAD `msgId` + NUL + `voter`, AES-256-GCM. This file reproduces that
 * derivation
 * exactly so a vote we emit is decryptable by any client — including this one.
 * Note it uses bare `aesDecryptGCM` with no trailing MAC, so the encrypt side
 * must *not* append one (that is `encryptMessage`'s job, and it is a
 * different, incompatible framing).
 *
 * Option identity is the hex sha256 of the option name, per upstream's own
 * `getAggregateVotesInPollMessage`. A vote carries those hex digests as UTF-8
 * bytes, not as raw 32-byte hashes.
 */

/** Bound on tracked polls. Oldest are evicted; nothing here is durable state. */
const DEFAULT_MAX_POLLS = 300;

export interface PollsOptions {
  /** Max polls held in memory. Oldest evicted first. */
  maxPolls?: number;
}

export interface PollOption {
  readonly name: string;
  /** Hex sha256 of `name` — the wire identity of this option. */
  readonly hash: string;
  /** Normalised jids that selected this option. */
  readonly voters: string[];
}

export interface PollState {
  readonly id: string;
  /** Chat the poll lives in. */
  readonly jid: string;
  /** Normalised creator jid, as used in the vote key derivation. */
  readonly creator: string;
  readonly name: string;
  readonly options: readonly PollOption[];
  /** How many options one voter may pick. */
  readonly selectableCount: number;
  readonly createdAt: number;
  /** True once the creator closed it. */
  closed: boolean;
  closedAt?: number;
  /** Votes that arrived for a poll whose secret we never had. Never faked. */
  undecryptableVotes: number;
  /** Authoritative counts, when the server sent a result snapshot. */
  snapshot?: readonly { readonly optionName: string; readonly votes: number }[];
}

export interface PollResult {
  readonly id: string;
  readonly name: string;
  readonly closed: boolean;
  readonly totalVoters: number;
  readonly options: readonly { readonly name: string; readonly votes: number; readonly share: number }[];
  /** Set when counts came from the server rather than from tracked votes. */
  readonly source: 'snapshot' | 'tracked';
}

export interface CreatePollOptions {
  /** How many options a voter may pick. Default 1. */
  selectableCount?: number;
  /** Route to `pollCreationMessageV2` for community announcement groups. */
  toAnnouncementGroup?: boolean;
}

/** The creation message, whichever version the sender used. */
function creationOf(msg: WAMessage): proto.Message.IPollCreationMessage | null {
  const m = msg.message as
    | {
        pollCreationMessage?: proto.Message.IPollCreationMessage | null;
        pollCreationMessageV2?: proto.Message.IPollCreationMessage | null;
        pollCreationMessageV3?: proto.Message.IPollCreationMessage | null;
      }
    | null
    | undefined;
  // Same precedence as upstream's vote aggregation, so our option list and
  // theirs never disagree about which options exist.
  return m?.pollCreationMessage ?? m?.pollCreationMessageV2 ?? m?.pollCreationMessageV3 ?? null;
}

/** The poll secret. Root `messageContextInfo` only — never inside the media. */
function secretOf(msg: WAMessage): Uint8Array | undefined {
  const m = msg.message as { messageContextInfo?: { messageSecret?: Uint8Array | null } | null } | null | undefined;
  const secret = m?.messageContextInfo?.messageSecret;
  return secret ? new Uint8Array(secret) : undefined;
}

export interface VoteKey {
  /**
   * The poll's 32-byte `messageSecret`.
   *
   * Named `pollEncKey` to match upstream `decryptPollVote`'s parameter exactly,
   * so a `VoteKey` can be handed straight to it — the same object both
   * directions of the cipher take.
   */
  readonly pollEncKey: Uint8Array;
  /** Id of the poll creation message. */
  readonly pollMsgId: string;
  /** Normalised jid of whoever created the poll. */
  readonly pollCreatorJid: string;
  /** Normalised jid of the voter. */
  readonly voterJid: string;
}

/**
 * Encrypt a poll vote — the exact inverse of upstream `decryptPollVote`.
 *
 * Exported so the round-trip can be asserted directly against Baileys' own
 * decryptor rather than taken on trust. `decryptPollVote` is a published
 * function, so if these two disagree the disagreement is detectable, not
 * hypothetical.
 *
 * @param selected hex sha256 digests of the chosen option names, as UTF-8
 * bytes on the wire; an empty list is a vote withdrawal or a poll close.
 */
export function encryptPollVote(
  selected: readonly string[],
  key: VoteKey,
): proto.Message.PollEncValue {
  const toBinary = (s: string): Uint8Array => new Uint8Array(Buffer.from(s));

  const payload = proto.Message.PollVoteMessage.create({
    selectedOptions: selected.map((hex) => new Uint8Array(Buffer.from(hex))),
  });
  const plaintext = proto.Message.PollVoteMessage.encode(payload).finish();

  const sign = Buffer.concat([
    toBinary(key.pollMsgId),
    toBinary(key.pollCreatorJid),
    toBinary(key.voterJid),
    toBinary('Poll Vote'),
    new Uint8Array([1]),
  ]);
  const key0 = hmacSign(key.pollEncKey, new Uint8Array(32), 'sha256');
  const voteKey = hmacSign(sign, key0, 'sha256');

  // The separator is a NUL byte, exactly as upstream writes it. It is spelled
  // as an escape rather than a literal control character so this file stays
  // plain text — a raw NUL here is invisible in review and turns the source
  // into a "binary" file for grep and diff.
  const aad = toBinary(`${key.pollMsgId}\u0000${key.voterJid}`);
  const iv = randomBytes(16);

  // No message MAC: upstream decrypts with bare `aesDecryptGCM`, so appending
  // one (as `encryptMessage` does) would produce a ciphertext it cannot read.
  const encPayload = aesEncryptGCM(plaintext, voteKey, new Uint8Array(iv), aad);
  return proto.Message.PollEncValue.create({
    encPayload: new Uint8Array(encPayload),
    encIv: new Uint8Array(iv),
  });
}

export function polls(options: PollsOptions = {}): Plugin {
  const maxPolls = Math.max(1, options.maxPolls ?? DEFAULT_MAX_POLLS);

  return {
    name: 'polls',
    order: 120,

    apply(ctx) {
      const log = ctx.log.child('poll');
      const states = new Map<string, PollState>();
      /**
       * Secrets live apart from the public state so `getPoll()` can never leak
       * poll encKey material into a log line or a serialised response.
       */
      const secrets = new Map<string, Uint8Array>();

      const meId = (): string => jidNormalizedUser(ctx.sock.user?.id ?? '');

      const evict = (): void => {
        while (states.size > maxPolls) {
          const oldest = states.keys().next().value;
          if (oldest === undefined) break;
          states.delete(oldest);
          secrets.delete(oldest);
        }
      };

      /* ── creation ───────────────────────────────────────────────── */

      const create = async (
        jid: string,
        name: string,
        values: readonly string[],
        options: CreatePollOptions = {},
      ): Promise<string> => {
        if (values.length < 2) throw new Error('a poll needs at least two options');

        // 32-byte secret, generated here rather than left to upstream, because
        // voting later requires it and a returned WAMessage does not expose it.
        const messageSecret = randomBytes(32);
        const selectableCount = options.selectableCount ?? 1;
        if (selectableCount < 0 || selectableCount > values.length) {
          throw new Error(`selectableCount ${selectableCount} is out of range for ${values.length} options`);
        }

        const sent = await ctx.sock.sendMessage(jid, {
          poll: {
            name,
            values: [...values],
            selectableCount,
            messageSecret: new Uint8Array(messageSecret),
            toAnnouncementGroup: options.toAnnouncementGroup ?? false,
          },
        });

        const id = sent?.key?.id;
        if (!id) throw new Error('poll was relayed but no message id came back');

        const creator = meId();
        states.set(id, {
          id,
          jid,
          creator,
          name,
          options: values.map((option) => ({ name: option, hash: sha256(Buffer.from(option)).toString(), voters: [] })),
          selectableCount,
          createdAt: Date.now(),
          closed: false,
          undecryptableVotes: 0,
        });
        secrets.set(id, new Uint8Array(messageSecret));
        evict();

        log.debug('created', { id, options: values.length, selectableCount });
        ctx.sock.ev.emit('nyx.poll' as never, states.get(id) as never);
        return id;
      };

      /* ── voting ─────────────────────────────────────────────────── */

      /**
       * Cast or change a vote. An empty `selected` list is how a creator closes
       * a poll, which is the same wire action — so `close()` delegates here.
       */
      const vote = async (pollId: string, selected: readonly string[]): Promise<string> => {
        const poll = states.get(pollId);
        if (!poll) throw new Error(`unknown poll ${pollId}`);
        const encKey = secrets.get(pollId);
        if (!encKey) throw new Error(`poll ${pollId} has no stored secret — it cannot be voted on from here`);

        const voter = meId();
        const voteEnc = encryptPollVote(selected, {
          pollEncKey: encKey,
          pollMsgId: poll.id,
          pollCreatorJid: poll.creator,
          voterJid: voter,
        });

        const creationKey = proto.MessageKey.create({
          remoteJid: poll.jid,
          fromMe: poll.creator === voter,
          id: poll.id,
          participant: poll.creator === voter ? undefined : poll.creator,
        });
        const update = proto.Message.PollUpdateMessage.create({
          pollCreationMessageKey: creationKey,
          vote: voteEnc,
          senderTimestampMs: Date.now(),
        });

        // Hand-rolled only because upstream has no vote content variant; the
        // construction itself is all generated protobuf constructors.
        const message = proto.Message.create({ pollUpdateMessage: update });
        const messageId = generateMessageID();
        await ctx.sock.relayMessage(poll.jid, message, { messageId });

        // Apply locally: we cannot read back our own relayed node, and waiting
        // for the server echo would make `vote()` look like it did nothing.
        applyVote(poll, voter, selected, selected.length > 0);
        log.debug('voted', { pollId, options: selected.length });
        return messageId;
      };

      const close = async (pollId: string): Promise<string> => {
        const poll = states.get(pollId);
        if (!poll) throw new Error(`unknown poll ${pollId}`);
        if (poll.closed) return '';
        const messageId = await vote(pollId, []);
        poll.closed = true;
        poll.closedAt = Date.now();
        ctx.sock.ev.emit('nyx.poll' as never, poll as never);
        return messageId;
      };

      /* ── tracking ───────────────────────────────────────────────── */

      /**
       * Fold one voter into the poll. `hasSelection` false means a withdrawal,
       * which clears the voter rather than adding an empty entry.
       */
      const applyVote = (
        poll: PollState,
        voter: string,
        selected: readonly string[],
        hasSelection: boolean,
      ): void => {
        const options = poll.options as PollOption[];
        // A change replaces this voter's previous choice; WhatsApp keeps one
        // selection set per voter, so accumulating would double-count.
        for (const option of options) {
          const at = option.voters.indexOf(voter);
          if (at !== -1) option.voters.splice(at, 1);
        }
        if (!hasSelection) return;

        for (const hash of selected) {
          const option = options.find((o) => o.hash === hash);
          // An unknown hash means a poll version we did not model. Counting it
          // against a guessed option would be worse than dropping it.
          if (option && !option.voters.includes(voter)) option.voters.push(voter);
        }
      };

      /** Decrypt and record an incoming `pollUpdateMessage`. */
      const trackUpdate = (update: proto.Message.IPollUpdateMessage, key: WAMessageKey): void => {
        const creationId = update.pollCreationMessageKey?.id;
        if (!creationId) return;
        const poll = states.get(creationId);
        if (!poll) return;

        const encKey = secrets.get(creationId);
        const encVote = update.vote;
        if (!encKey || !encVote) {
          poll.undecryptableVotes += 1;
          log.debug('vote not decryptable (no stored secret)', { poll: creationId });
          return;
        }

        const me = meId();
        try {
          const decoded = decryptPollVote(encVote, {
            pollEncKey: encKey,
            pollCreatorJid: poll.creator,
            pollMsgId: poll.id,
            voterJid: getKeyAuthor(key, me),
          });
          const hashes = (decoded.selectedOptions ?? []).map((o) => Buffer.from(o).toString());
          const withdrew = hashes.length === 0;
          const voter = getKeyAuthor(key, me);
          applyVote(poll, voter, hashes, !withdrew);

          // A withdrawal from the creator is the close signal, not a vote.
          if (withdrew && voter === poll.creator && !poll.closed) {
            poll.closed = true;
            poll.closedAt = Date.now();
          }
          ctx.sock.ev.emit('nyx.pollUpdate' as never, { poll, voter, hashes, withdrew } as never);
        } catch (err) {
          poll.undecryptableVotes += 1;
          log.debug('vote decrypt failed', { poll: creationId, err: (err as Error).message });
        }
      };

      const trackCreation = (creation: proto.Message.IPollCreationMessage, key: WAMessageKey, msg: WAMessage): void => {
        const id = key.id;
        if (!id) return;

        const me = meId();
        const creator = jidNormalizedUser(getKeyAuthor(key, me) || key.remoteJid || '');
        const values = (creation.options ?? []).map((o) => o.optionName ?? '');

        // Never clobber a poll we already track: a creation re-delivered by
        // history sync must not wipe the votes accumulated since.
        if (!states.has(id)) {
          states.set(id, {
            id,
            jid: key.remoteJid ?? '',
            creator,
            name: creation.name ?? '',
            options: values.map((name) => ({ name, hash: sha256(Buffer.from(name)).toString(), voters: [] })),
            selectableCount: creation.selectableOptionsCount ?? 1,
            createdAt: Number(msg.messageTimestamp ?? Date.now()),
            closed: false,
            undecryptableVotes: 0,
          });
        }

        const secret = secretOf(msg);
        if (secret) secrets.set(id, secret);
        evict();
        ctx.sock.ev.emit('nyx.poll' as never, states.get(id) as never);
      };

      /* ── results ────────────────────────────────────────────────── */

      const results = (pollId: string): PollResult | undefined => {
        const poll = states.get(pollId);
        if (!poll) return undefined;

        if (poll.snapshot) {
          // Snapshot counts are the server's, so trust them over our own tally,
          // but expose the same shape either way.
          const total = poll.snapshot.reduce((n, o) => n + o.votes, 0);
          return {
            id: poll.id,
            name: poll.name,
            closed: poll.closed,
            totalVoters: total,
            options: poll.snapshot.map((o) => ({
              name: o.optionName,
              votes: o.votes,
              share: total === 0 ? 0 : o.votes / total,
            })),
            source: 'snapshot' as const,
          };
        }

        const totalVoters = poll.options.reduce((n, o) => n + o.voters.length, 0);
        return {
          id: poll.id,
          name: poll.name,
          closed: poll.closed,
          totalVoters,
          options: poll.options.map((o) => ({
            name: o.name,
            votes: o.voters.length,
            share: totalVoters === 0 ? 0 : o.voters.length / totalVoters,
          })),
          source: 'tracked',
        };
      };

      ctx.sock.ev.on('messages.upsert', (event: BaileysEventMap['messages.upsert']) => {
        for (const msg of event?.messages ?? []) {
          if (!msg.key) continue;

          const snapshot = (msg.message as { pollResultSnapshotMessage?: proto.Message.IPollResultSnapshotMessage | null } | undefined)
            ?.pollResultSnapshotMessage;
          if (snapshot) {
            const poll = states.get(snapshot.contextInfo?.stanzaId ?? '');
            if (poll) {
              poll.snapshot = (snapshot.pollVotes ?? []).map((v) => ({
                optionName: v.optionName ?? '',
                votes: Number(v.optionVoteCount ?? 0),
              }));
            }
          }

          const creation = creationOf(msg);
          if (creation) {
            trackCreation(creation, msg.key, msg);
            continue;
          }

          const update = (msg.message as { pollUpdateMessage?: proto.Message.IPollUpdateMessage | null } | undefined)
            ?.pollUpdateMessage;
          if (update) trackUpdate(update, msg.key);
        }
      });

      /* ── surface ────────────────────────────────────────────────── */

      Object.defineProperty(ctx.sock, 'pollStates', { value: states, enumerable: false, configurable: true });
      Object.defineProperty(ctx.sock, 'createPoll', { value: create, enumerable: false, configurable: true });
      Object.defineProperty(ctx.sock, 'votePoll', { value: vote, enumerable: false, configurable: true });
      Object.defineProperty(ctx.sock, 'closePoll', { value: close, enumerable: false, configurable: true });
      Object.defineProperty(ctx.sock, 'pollResults', { value: results, enumerable: false, configurable: true });
      Object.defineProperty(ctx.sock, 'getPoll', {
        value: (id: string): PollState | undefined => states.get(id),
        enumerable: false,
        configurable: true,
      });
      Object.defineProperty(ctx.sock, 'listPolls', {
        value: (jid?: string): PollState[] =>
          [...states.values()].filter((p) => (jid ? p.jid === jid : true)),
        enumerable: false,
        configurable: true,
      });

      log.debug('attached', { maxPolls });
    },
  };
}

export default polls;
