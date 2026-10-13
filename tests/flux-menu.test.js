import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FAMILY_LIST_CAP,
  FLUX_MENU_TAP_PREFIX,
  bucketedFamilies,
  displayFamily,
  familyFlavor,
  familyPageButtons,
  familyPageCount,
  fluxMenuCategories,
  fluxMenuTap,
  formatCatalogueFallback,
  formatFamilyMenu,
  parseFluxMenuTap,
  parseFluxPageTap,
  progressMeterFrames,
  sendFluxFamilyPage,
  smallCaps,
  sourceFamilies,
} from '../dist/toolkit/flux-menu.js';
import { buildFullRegistry } from '../dist/toolkit/registry-full.js';

test('every registry family is bucketed exactly once', () => {
  const reg = buildFullRegistry();
  const bucketed = bucketedFamilies();
  const present = sourceFamilies(reg);
  assert.deepEqual([...bucketed].sort(), [...present].sort());
  assert.equal(new Set(bucketed).size, bucketed.length, 'a family sits in two buckets');
});

test('the sheet fits native menu limits', () => {
  const reg = buildFullRegistry();
  const categories = fluxMenuCategories(reg);
  assert.ok(categories.length <= 8, `${categories.length} sections is over the native limit`);
  assert.ok(categories.length > 0, 'empty catalogue produced no sections');
  for (const section of categories) {
    assert.ok(section.title.length <= 24, `section title too long: ${section.title}`);
    for (const row of section.rows) {
      assert.ok(row.title.length <= 24, `row title too long: ${row.title}`);
      assert.ok(
        (row.description ?? '').length <= 72,
        `row description too long for ${row.title}: ${row.description}`,
      );
      assert.match(row.id, /^flux:cat:[a-z0-9-]+$/);
    }
  }
});

/** A `╠➺` row that actually names a command, not the stats line above them. */
const isCommandRow = (line) => line.startsWith('╠➺') && line.includes('`');

test('row descriptions carry live counts, not hand-written ones', () => {
  const reg = buildFullRegistry();
  const categories = fluxMenuCategories(reg);
  const flat = categories.flatMap((section) => section.rows);
  const hash = flat.find((row) => row.id === `${FLUX_MENU_TAP_PREFIX}hash`);
  assert.ok(hash);
  assert.match(hash.description ?? '', /10 commands$/);
  const timezone = flat.find((row) => row.id === `${FLUX_MENU_TAP_PREFIX}timezone`);
  assert.ok(timezone);
  assert.match(timezone.description ?? '', /418 commands$/);
});

test('a small family lists fully, Elaina-framed, with no run hint', () => {
  const reg = buildFullRegistry();
  const text = formatFamilyMenu(reg, 'hash');
  assert.match(text, /MENU ʜᴀꜱʜ/);
  assert.match(text, /╔═━───╍━╍╍┄/);
  assert.match(text, /commands :: 10/);
  assert.match(text, /╚═─━╍╍━╍╾/);
  assert.match(text, /`[a-z0-9-]+`/);
  assert.doesNotMatch(text, /Reply `flux <name>`/, 'the run hint was cut on purpose');
  assert.doesNotMatch(text, /for the next page/);
});

test('a huge family pages with stats, nav and no overflow dump', () => {
  const reg = buildFullRegistry();
  assert.equal(familyPageCount(reg, 'timezone'), 17);
  const first = formatFamilyMenu(reg, 'timezone', 1);
  const firstRows = first.split('\n').filter(isCommandRow);
  assert.equal(firstRows.length, FAMILY_LIST_CAP);
  assert.match(first, /page :: 1\/17/);
  assert.match(first, /flux menu timezone 2/);
  const second = formatFamilyMenu(reg, 'timezone', 2);
  assert.match(second, /page :: 2\/17/);
  assert.notEqual(first, second);
  assert.doesNotMatch(first, /\+ \d+ more/);
});

test('pages clamp and union back to the whole family', () => {
  const reg = buildFullRegistry();
  const names = (page) => formatFamilyMenu(reg, 'timezone', page)
    .split('\n')
    .filter(isCommandRow)
    .map((line) => /`([^`]+)`/.exec(line)?.[1]);
  assert.deepEqual(formatFamilyMenu(reg, 'timezone', 0), formatFamilyMenu(reg, 'timezone', 1));
  assert.deepEqual(formatFamilyMenu(reg, 'timezone', 99), formatFamilyMenu(reg, 'timezone', 17));
  const all = [];
  for (let page = 1; page <= 17; page++) all.push(...names(page));
  assert.equal(new Set(all).size, 418);
});

test('page buttons are exactly two: back and forward', () => {
  assert.deepEqual(familyPageButtons('hash', 1, 1), [], 'single page needs no nav');
  const labels = (bs) => bs.map((b) => JSON.parse(b.buttonParamsJson).display_text);
  const ids = (bs) => bs.map((b) => JSON.parse(b.buttonParamsJson).id);

  const first = familyPageButtons('timezone', 1, 17);
  assert.deepEqual(labels(first), ['Next ▶']);
  const middle = familyPageButtons('timezone', 5, 17);
  assert.deepEqual(labels(middle), ['◀ Previous', 'Next ▶']);
  const last = familyPageButtons('timezone', 17, 17);
  assert.deepEqual(labels(last), ['◀ Previous']);

  for (const b of [...first, ...middle, ...last]) {
    assert.equal(b.name, 'quick_reply');
    assert.match(JSON.parse(b.buttonParamsJson).id, /^flux:page:/);
  }
  assert.equal(ids(middle)[0], 'flux:page:timezone:4', 'back steps one page');
  assert.equal(ids(middle)[1], 'flux:page:timezone:6', 'forward steps one page');
  assert.equal(ids(last).length, 1, 'the last page never offers a forward that does nothing');
});

test('page taps parse family and number, and reject junk', () => {
  assert.deepEqual(parseFluxPageTap('flux:page:timezone:6'), { family: 'timezone', page: 6 });
  assert.deepEqual(parseFluxPageTap('flux:page:unit-temperature:3'), { family: 'unit-temperature', page: 3 });
  assert.equal(parseFluxPageTap('flux:page:timezone:0'), null);
  assert.equal(parseFluxPageTap('flux:page:timezone:-1'), null);
  assert.equal(parseFluxPageTap('flux:page:timezone'), null);
  assert.equal(parseFluxPageTap('flux:page::2'), null);
  assert.equal(parseFluxPageTap('flux:cat:hash'), null);
  assert.equal(parseFluxPageTap('call'), null);
});

test('small-caps map letters and leave the rest alone', () => {
  assert.equal(smallCaps('Flux Menu 2'), 'ꜰʟᴜx ᴍᴇɴᴜ 2');
  assert.equal(smallCaps('a-b_c.d'), 'ᴀ-ʙ_ᴄ.ᴅ');
});

test('an unknown family answers with the valid list, never silence', () => {
  const reg = buildFullRegistry();
  const text = formatFamilyMenu(reg, 'nosuchfam');
  assert.match(text, /No category/);
  assert.match(text, /timezone/);
});

test('the text fallback carries every bucket and the total', () => {
  const reg = buildFullRegistry();
  const text = formatCatalogueFallback(reg);
  assert.match(text, /\*FLUX · 1792 commands\*/);
  for (const title of ['Text & Style', 'Games & Fun', 'Media Studio', 'Assistant', 'System & Ops', 'Security', 'World & Data', 'Measure & Math']) {
    assert.match(text, new RegExp(`\\*${title.replace(/&/g, '&')}\\*`));
  }
  assert.match(text, /flux menu <family>/);
});

test('tap parsing accepts only the catalogue namespace', () => {
  assert.equal(parseFluxMenuTap('flux:cat:hash'), 'hash');
  assert.equal(parseFluxMenuTap('flux:cat:unit-temperature'), 'unit-temperature');
  assert.equal(parseFluxMenuTap('call'), null);
  assert.equal(parseFluxMenuTap('flux:cat:'), null);
  assert.equal(parseFluxMenuTap(''), null);
  assert.equal(parseFluxMenuTap('flux:dog:hash'), null);
});

test('display names and flavors stay readable', () => {
  assert.equal(displayFamily('unit-temperature'), 'Unit Temperature');
  assert.equal(displayFamily('live-api'), 'Live API');
  assert.equal(displayFamily('ops2'), 'Ops 2');
  assert.equal(familyFlavor('unit-data'), 'data units');
  assert.equal(familyFlavor('game'), 'games & social');
});

function tapMessage(id, jid = 'g1@g.us') {
  return {
    key: { remoteJid: jid },
    message: {
      interactiveResponseMessage: {
        nativeFlowResponseMessage: { paramsJson: JSON.stringify({ id }) },
      },
    },
  };
}

function tapHarness() {
  const sent = [];
  const handlers = {};
  let n = 0;
  const sock = {
    ev: {
      on: (event, fn) => {
        handlers[event] = fn;
        return () => { delete handlers[event]; };
      },
    },
    sendMessage: async (jid, content, opts) => {
      sent.push([jid, content, opts]);
      n += 1;
      return { key: { id: `KEY${n}` } };
    },
  };
  return { sent, handlers, sock };
}

/** 15 frames at 240ms plus a random 1-2s settle. Outlast the worst case. */
const settleMeter = () => new Promise((r) => setTimeout(r, 7000));

test('a catalogue tap answers with that family list, and revokes the meter', async () => {
  const reg = buildFullRegistry();
  const { sent, handlers, sock } = tapHarness();
  fluxMenuTap(reg).apply({
    sock,
    state: {},
    options: {},
    log: { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) },
    onDispose: () => {},
  });
  const fire = handlers['messages.upsert'];
  assert.ok(fire, 'tap plugin attached no listener');
  await fire({ messages: [tapMessage('flux:cat:hash')] });
  await settleMeter();

  // The meter is revoked, so the last thing sent is the page itself.
  const revoked = sent.filter(([, c]) => c.delete !== undefined);
  assert.equal(revoked.length, 1, 'the meter is revoked exactly once');
  assert.equal(revoked[0][1].delete.id, 'KEY1', 'it revokes its own message, not something else');
  const [, page] = sent.at(-1);
  assert.equal(page.delete, undefined);
  assert.equal(page.edit, undefined, 'opening a family is a fresh message');
  assert.equal(sent.at(-1)[0], 'g1@g.us');
  assert.match(page.text, /MENU ʜᴀꜱʜ/);
  assert.match(page.text, /commands :: 10/);
});

test('a page turn is a fresh buttoned message quoted to the tap', async () => {
  const reg = buildFullRegistry();
  const { sent, handlers, sock } = tapHarness();
  fluxMenuTap(reg).apply({
    sock,
    state: {},
    options: {},
    log: { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) },
    onDispose: () => {},
  });
  const fire = handlers['messages.upsert'];
  await fire({ messages: [tapMessage('flux:cat:timezone')] });
  await settleMeter();
  const openedIds = sent.at(-1)[1].interactiveButtons.map((b) => JSON.parse(b.buttonParamsJson).id);
  assert.ok(openedIds.includes('flux:page:timezone:2'), 'page one offers a way into page two');

  const before = sent.length;
  await fire({ messages: [tapMessage('flux:page:timezone:2')] });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, before + 1, 'a page turn is one message');
  const [, second] = sent.at(-1);

  // The regression this shape exists for: an edit arrives with no buttons, so
  // there is no Next to press. Every page must be a fresh interactive message.
  assert.equal(second.edit, undefined, 'an edited page loses its buttons');
  assert.ok(second.interactiveButtons, 'the page carries buttons');
  assert.match(second.text, /page :: 2\/17/);
  assert.deepEqual(
    second.interactiveButtons.map((b) => JSON.parse(b.buttonParamsJson).display_text),
    ['◀ Previous', 'Next ▶'],
  );
  assert.equal(second.quoted, undefined, 'the quote rides in send options, not the payload');
  const quoted = sent.at(-1)[2]?.opts ?? sent.at(-1)[2];
  assert.ok(quoted?.quoted, 'the page replies to the tap that asked for it');
});

test('a page tap with no remembered message falls back to a fresh send', async () => {
  const reg = buildFullRegistry();
  const { sent, handlers, sock } = tapHarness();
  fluxMenuTap(reg).apply({
    sock,
    state: {},
    options: {},
    log: { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) },
    onDispose: () => {},
  });
  await handlers['messages.upsert']({ messages: [tapMessage('flux:page:timezone:3')] });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1].edit, undefined, 'no key remembered means a new message, not a broken edit');
  assert.match(sent[0][1].text, /page :: 3\/17/);
});

test('feature taps, foreign buttons and garbage pass through silent', async () => {
  const reg = buildFullRegistry();
  const { sent, handlers, sock } = tapHarness();
  fluxMenuTap(reg).apply({
    sock,
    state: {},
    options: {},
    log: { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) },
    onDispose: () => {},
  });
  const fire = handlers['messages.upsert'];
  await fire({ messages: [tapMessage('call'), tapMessage('flux:cat:nope'), tapMessage('???')] });
  await fire({ messages: [{ key: {}, message: {} }] });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent, []);
});

test('a fresh family send plays the progress meter, a page turn does not', async () => {
  const reg = buildFullRegistry();
  const { sent, handlers, sock } = tapHarness();
  fluxMenuTap(reg).apply({
    sock,
    state: {},
    options: {},
    log: { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) },
    onDispose: () => {},
  });
  const fire = handlers['messages.upsert'];

  await fire({ messages: [tapMessage('flux:cat:timezone')] });
  await settleMeter();

  const meter = sent.filter(([, c]) => c.edit !== undefined);
  const texts = meter.map(([, c]) => c.text);
  // The opening frame is a fresh send; every frame after it is an edit of that one.
  assert.equal(sent[0][1].text, progressMeterFrames()[0], 'the meter opens on its first frame');
  assert.equal(sent[0][1].edit, undefined);
  assert.match(texts.at(-1), /^✅/, 'and closes on the check');
  assert.equal(texts.length, progressMeterFrames().length - 1, 'every frame is played');
  assert.equal(meter[0][1].edit.id, 'KEY1', 'every frame edits the one meter message');
  assert.ok(!meter.some(([, c]) => c.interactiveButtons), 'the meter carries no buttons');

  // The real page lands after the meter, as its own message.
  const page = sent.at(-1)[1];
  assert.match(page.text, /page :: 1\/17/);
  assert.ok(page.interactiveButtons, 'the page still carries its nav buttons');

  // A page turn must not re-run the meter — the reader already has a page.
  const before = sent.length;
  await fire({ messages: [tapMessage('flux:page:timezone:2')] });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, before + 1, 'a page turn is one message, no meter');
});

test('a broken meter still sends the menu', async () => {
  const reg = buildFullRegistry();
  const sent = [];
  let calls = 0;
  const sock = {
    sendMessage: async (jid, content) => {
      calls += 1;
      // Fail every meter frame the way a flaky socket would.
      if (content.edit !== undefined) throw new Error('edit failed');
      sent.push([jid, content]);
      return { key: { id: `K${sent.length}` } };
    },
  };
  await sendFluxFamilyPage(sock, 'jid', reg, 'timezone', 1, { progress: true });
  assert.ok(calls > 1, 'the meter was attempted');
  const [, page] = sent.at(-1);
  assert.match(page.text, /page :: 1\/17/, 'the menu still reaches the reader');
  assert.ok(page.interactiveButtons, 'with its buttons intact');
  assert.equal(sent.filter(([, c]) => c.delete !== undefined).length, 0, 'nothing to revoke when the meter died');
});

test('meter frames are a real animation, not decoration', () => {
  const frames = progressMeterFrames();
  assert.match(frames[0], /ꜰʟᴜx/);
  assert.match(frames.at(-1), /^✅/);
  assert.ok(frames.length > 8, `too few frames to read as motion: ${frames.length}`);

  const pctOf = (frame) => Number(frame.match(/(\d+)%/)[1]);
  const filledOf = (frame) => (frame.match(/▰/g) || []).length;
  const pct = frames.slice(0, -1).map(pctOf);
  const filled = frames.slice(0, -1).map(filledOf);

  // Monotonic: the bar only ever grows. A meter that jumps backwards is a bug.
  for (let i = 1; i < pct.length; i += 1) {
    assert.ok(pct[i] >= pct[i - 1], `percentage went backwards at frame ${i}`);
    assert.ok(filled[i] >= filled[i - 1], `bar shrank at frame ${i}`);
  }
  assert.equal(pct[0], 6);
  assert.equal(pct.at(-1), 100, 'the last drawn frame is full');
  assert.equal(filled.at(-1), 10, 'and every cell is filled');

  // Percentage tracks the bar, so the display never lies about the bar.
  for (let i = 0; i < pct.length; i += 1) {
    const expected = Math.round((filled[i] / 10) * 100);
    assert.ok(Math.abs(pct[i] - expected) <= 15, `frame ${i}: ${pct[i]}% but ${filled[i]}/10 cells`);
  }

  // Every frame is the same shape, so the message does not jitter as it animates.
  const widths = new Set(frames.slice(0, -1).map((f) => f.split('\n')[2].length));
  assert.equal(widths.size, 1, `bar row changed width mid-animation: ${[...widths]}`);

  // The status line advances rather than repeating one line.
  const stages = new Set(frames.slice(0, -1).map((f) => f.split('\n')[4]));
  assert.ok(stages.size >= 4, `only ${stages.size} distinct stages`);

  // Frame count is honoured, so the meter can be sped up or slowed in one place.
  assert.equal(progressMeterFrames(4).length, 5);
  assert.equal(pctOf(progressMeterFrames(4)[0]), 25);
});
