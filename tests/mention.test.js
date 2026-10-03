/**
 * Message parsing.
 *
 * rc14 spreads one message across a dozen shapes depending on its type, and the
 * failures are silent — a command that matches plain text and stops matching
 * once the reply arrives wrapped. So each wrapper shape gets its own case.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractMentions,
  extractQuoted,
  extractText,
  parseCommandArgs,
  parseIncoming,
} from '../dist/core/mention.js';

import { wmMessage } from './helpers.js';

const ME = '15550001111@s.whatsapp.net';

/* ── text extraction ─────────────────────────────────────────────────── */

test('a plain conversation is read from conversation', () => {
  assert.equal(extractText(wmMessage({ message: { conversation: 'hello' } })), 'hello');
});

test('an extended text message is read from .text', () => {
  assert.equal(
    extractText(wmMessage({ message: { extendedTextMessage: { text: 'hi there' } } })),
    'hi there',
  );
});

test('captions count as text', () => {
  assert.equal(extractText(wmMessage({ message: { imageMessage: { caption: 'a cat' } } })), 'a cat');
  assert.equal(extractText(wmMessage({ message: { videoMessage: { caption: 'a clip' } } })), 'a clip');
  assert.equal(extractText(wmMessage({ message: { documentMessage: { caption: 'a pdf' } } })), 'a pdf');
});

test('a forwarded ephemeral message is unwrapped', () => {
  const msg = wmMessage({
    message: { ephemeralMessage: { ephemeralMessage: { conversation: 'forwarded hi' } } },
  });
  assert.equal(extractText(msg), 'forwarded hi');
});

test('a view-once is unwrapped', () => {
  for (const wrapper of ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension']) {
    const msg = wmMessage({ message: { [wrapper]: { viewOnceMessage: { conversation: 'secret' } } } });
    assert.equal(extractText(msg), 'secret', `failed to unwrap ${wrapper}`);
  }
});

test('an edited message is unwrapped through its `message` key', () => {
  const msg = wmMessage({
    message: { editedMessage: { message: { conversation: 'corrected' } } },
  });
  assert.equal(extractText(msg), 'corrected');
});

test('a caption wrapped by documentWithCaptionMessage is unwrapped', () => {
  const msg = wmMessage({
    message: {
      documentWithCaptionMessage: { message: { documentMessage: { caption: 'wrapped caption' } } },
    },
  });
  assert.equal(extractText(msg), 'wrapped caption');
});

test('a doubly wrapped message is unwrapped all the way', () => {
  const msg = wmMessage({
    message: {
      ephemeralMessage: {
        ephemeralMessage: { viewOnceMessage: { conversation: 'deep' } },
      },
    },
  });
  assert.equal(extractText(msg), 'deep');
});

test('a self-referential wrapper cannot spin the unwrapper', () => {
  const inner = { viewOnceMessage: null };
  const outer = { viewOnceMessage: inner };
  inner.viewOnceMessage = outer;

  const msg = wmMessage({ message: { viewOnceMessage: outer } });
  assert.doesNotThrow(() => extractText(msg));
});

test('media with no caption and no text yields null', () => {
  assert.equal(extractText(wmMessage({ message: { imageMessage: { mimetype: 'image/jpeg' } } })), null);
  assert.equal(extractText(wmMessage({ message: { reactionMessage: {} } })), null);
  assert.equal(extractText({ key: { id: 'x', remoteJid: 'a@s.whatsapp.net' } }), null);
  assert.equal(extractText({ message: null }), null);
});

test('an empty string is not mistaken for text', () => {
  assert.equal(extractText(wmMessage({ message: { conversation: '' } })), null);
});

/* ── mentions ────────────────────────────────────────────────────────── */

test('mentioned jids come out in order without duplicates', () => {
  const msg = wmMessage({
    message: {
      extendedTextMessage: { text: 'hi @a @b' },
      messageContextInfo: { mentionedJid: ['a@s.whatsapp.net', 'b@s.whatsapp.net', 'a@s.whatsapp.net'] },
    },
  });
  assert.deepEqual(extractMentions(msg), ['a@s.whatsapp.net', 'b@s.whatsapp.net']);
});

test('mentions are read from a media message context too', () => {
  const msg = wmMessage({
    message: { imageMessage: { caption: 'hi', contextInfo: { mentionedJid: ['a@s.whatsapp.net'] } } },
  });
  assert.deepEqual(extractMentions(msg), ['a@s.whatsapp.net']);
});

test('a message with no context has no mentions', () => {
  assert.deepEqual(extractMentions(wmMessage({ message: { conversation: 'hi' } })), []);
});

test('a malformed mentionedJid is ignored rather than throwing', () => {
  const msg = wmMessage({
    message: { extendedTextMessage: { text: 'x' }, messageContextInfo: { mentionedJid: 'not-an-array' } },
  });
  assert.deepEqual(extractMentions(msg), []);
});

/* ── quotes ──────────────────────────────────────────────────────────── */

test('the quoted message is found with its participant', () => {
  const msg = wmMessage({
    id: 'NEW',
    message: {
      extendedTextMessage: { text: 'and this' },
      messageContextInfo: {
        quotedMessage: { stanzaId: 'OLD', participant: 'a@s.whatsapp.net', text: 'the original' },
      },
    },
  });

  assert.deepEqual(extractQuoted(msg), {
    id: 'OLD',
    participant: 'a@s.whatsapp.net',
    text: 'the original',
  });
});

test('a message with no quote yields null', () => {
  assert.equal(extractQuoted(wmMessage({ message: { conversation: 'hi' } })), null);
});

/* ── argument tokenising ─────────────────────────────────────────────── */

test('args split on whitespace', () => {
  assert.deepEqual(parseCommandArgs('one two three'), ['one', 'two', 'three']);
  assert.deepEqual(parseCommandArgs('  spaced   out  '), ['spaced', 'out']);
  assert.deepEqual(parseCommandArgs(''), []);
});

test('quotes keep a value together', () => {
  assert.deepEqual(parseCommandArgs('"Ada Lovelace" twice'), ['Ada Lovelace', 'twice']);
  assert.deepEqual(parseCommandArgs("it's fine"), ["it's", 'fine']);
  assert.deepEqual(parseCommandArgs('say ""'), ['say', ''], 'an empty quoted string is still an argument');
  assert.deepEqual(parseCommandArgs('""'), ['']);
});

test('a backslash escapes the next character', () => {
  // `\X` yields a literal X, which is how a quote or a space survives a split.
  assert.deepEqual(parseCommandArgs('say \\"quoted\\"'), ['say', '"quoted"']);
  assert.deepEqual(parseCommandArgs('one\\ two'), ['one two']);
  // A literal backslash therefore needs doubling — which is how a Windows path
  // is written on a command line.
  assert.deepEqual(parseCommandArgs('path C:\\\\Users\\\\me'), ['path', 'C:\\Users\\me']);
});

/* ── command parsing ─────────────────────────────────────────────────── */

test('a command is split into name and arguments', () => {
  const parsed = parseIncoming(wmMessage({ message: { conversation: '.kick 1555 spammer' } }));

  assert.equal(parsed.isCommand, true);
  assert.equal(parsed.name, 'kick');
  assert.equal(parsed.argString, '1555 spammer');
  assert.deepEqual(parsed.args, ['1555', 'spammer']);
});

test('the command name is lowercased', () => {
  assert.equal(parseIncoming(wmMessage({ message: { conversation: '.KiCK x' } })).name, 'kick');
});

test('a command with no arguments still parses', () => {
  const parsed = parseIncoming(wmMessage({ message: { conversation: '.ping' } }));
  assert.equal(parsed.name, 'ping');
  assert.equal(parsed.argString, '');
  assert.deepEqual(parsed.args, []);
});

test('a bare prefix is a help request, not a nameless command', () => {
  const parsed = parseIncoming(wmMessage({ message: { conversation: '.' } }));
  assert.equal(parsed.isCommand, true);
  assert.equal(parsed.name, '');
});

test('ordinary text is not a command', () => {
  const parsed = parseIncoming(wmMessage({ message: { conversation: 'kick 1555 spammer' } }));
  assert.equal(parsed.isCommand, false);
  assert.equal(parsed.name, null);
  assert.deepEqual(parsed.args, []);
  assert.equal(parsed.body, 'kick 1555 spammer');
});

test('the prefix is configurable and can be empty', () => {
  assert.equal(parseIncoming(wmMessage({ message: { conversation: '!help' } }), { prefix: '!' }).name, 'help');
  assert.equal(parseIncoming(wmMessage({ message: { conversation: '/help' } }), { prefix: '/' }).name, 'help');

  const prefixless = parseIncoming(wmMessage({ message: { conversation: 'help me' } }), { prefix: '' });
  assert.equal(prefixless.isCommand, true);
  assert.equal(prefixless.name, 'help');
  assert.deepEqual(prefixless.args, ['me']);
});

test('an alternate prefix also dispatches', () => {
  const parsed = parseIncoming(wmMessage({ message: { conversation: '/menu' } }), {
    prefix: '.',
    altPrefix: '/',
  });
  assert.equal(parsed.name, 'menu');
});

test('the longer prefix wins when both could match', () => {
  const parsed = parseIncoming(wmMessage({ message: { conversation: '!!help' } }), {
    prefix: '!',
    altPrefix: '!!',
  });
  assert.equal(parsed.name, 'help', '!! must be consumed as a whole, leaving "help"');
});

test('a quoted line is stripped so replying does not replay a command', () => {
  const msg = wmMessage({
    message: {
      extendedTextMessage: { text: '.kick 999' },
      messageContextInfo: {
        quotedMessage: { stanzaId: 'OLD', participant: 'a@s.whatsapp.net', text: '.kick 999' },
      },
    },
  });

  const parsed = parseIncoming(msg);
  assert.equal(parsed.isCommand, false, 'the quoted command must not re-fire');
  assert.equal(parsed.body, '');
  assert.equal(parsed.quoted.id, 'OLD');
});

test('a mention of the bot is stripped from the front of the body', () => {
  const msg = wmMessage({
    message: {
      extendedTextMessage: { text: '@15550001111 .ping now' },
      messageContextInfo: { mentionedJid: [ME] },
    },
  });

  const parsed = parseIncoming(msg, { selfJid: ME });
  assert.equal(parsed.name, 'ping');
  assert.deepEqual(parsed.args, ['now']);
});

test('a mention of someone else is left alone', () => {
  const other = '15559998888@s.whatsapp.net';
  const msg = wmMessage({
    message: {
      extendedTextMessage: { text: '@15559998888 .ping' },
      messageContextInfo: { mentionedJid: [other] },
    },
  });

  const parsed = parseIncoming(msg, { selfJid: ME });
  assert.equal(parsed.isCommand, false, 'another person was addressed, not the bot');
});

test('quoted arguments keep their spaces through parseIncoming', () => {
  const parsed = parseIncoming(
    wmMessage({ message: { conversation: '.ban "Ada Lovelace" spam' } }),
  );
  assert.equal(parsed.name, 'ban');
  assert.deepEqual(parsed.args, ['Ada Lovelace', 'spam']);
});

test('the original text is preserved alongside the stripped body', () => {
  const msg = wmMessage({
    message: {
      extendedTextMessage: { text: '@15550001111 .ping' },
      messageContextInfo: {
        mentionedJid: [ME],
        quotedMessage: { stanzaId: 'Q', participant: 'a@s.whatsapp.net', text: 'earlier' },
      },
    },
  });

  const parsed = parseIncoming(msg, { selfJid: ME });
  assert.equal(parsed.text, '@15550001111 .ping');
  // `body` is the cleaned text before command parsing — the mention is gone,
  // the prefix is still part of it.
  assert.equal(parsed.body, '.ping');
  assert.equal(parsed.name, 'ping');
  assert.deepEqual(parsed.mentions, [ME]);
});
