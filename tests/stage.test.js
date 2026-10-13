import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALT_ENTER,
  ALT_LEAVE,
  CURSOR_RESTORE,
  CURSOR_SAVE,
  SCROLL_RESET,
  Stage,
  confirmPromptTheme,
  promptPageSize,
  receiptFrame,
  sectionFrame,
  selectPromptTheme,
  stageCapabilities,
  textPromptTheme,
} from '../dist/cli/stage.js';
import { renderFluxIntro, visibleWidth } from '../dist/core/flux-intro.js';

function fakeOut(columns = 80, rows = 24) {
  const chunks = [];
  return {
    columns,
    rows,
    isTTY: true,
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    chunks,
  };
}

function plainWidths(lines) {
  return lines
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/\x1b\[[0-9;]*m/g, '').length);
}

function dashboardRows(output) {
  const lines = output.split('\n');
  return lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
}

test('a pinned stage reserves the dashboard and confines later output', () => {
  const out = fakeOut(80, 24);
  const stage = new Stage(out, { color: false, unicode: false, alternate: false });
  stage.begin(['alpha', 'beta']);
  assert.equal(stage.isActive(), true);
  assert.equal(stage.headerHeightValue(), 2);
  const started = out.chunks.join('');
  assert.match(started, /\x1b\[2J/);
  assert.match(started, /\x1b\[3;24r/);
  assert.match(started, /\x1b\[3;1H/);
});

test('a same-height dashboard refresh leaves the console region intact', () => {
  const out = fakeOut(80, 24);
  const stage = new Stage(out, { color: false, unicode: false, alternate: false });
  stage.begin(['alpha', 'beta']);
  out.chunks.length = 0;
  stage.update(['alpha', 'gamma']);
  const refreshed = out.chunks.join('');
  assert.ok(refreshed.includes(CURSOR_SAVE));
  assert.ok(refreshed.includes(SCROLL_RESET));
  assert.ok(refreshed.includes(CURSOR_RESTORE));
  assert.ok(!refreshed.includes('\x1b[2J'));
  assert.ok(refreshed.includes('gamma'));
});

test('leaving the stage restores scrolling and the cursor', () => {
  const out = fakeOut(80, 24);
  const stage = new Stage(out, { color: false, unicode: false, alternate: true });
  stage.begin(['alpha', 'beta']);
  out.chunks.length = 0;
  stage.stop(['finished']);
  const stopped = out.chunks.join('');
  assert.ok(stopped.includes(SCROLL_RESET));
  assert.ok(stopped.includes(ALT_LEAVE));
  assert.ok(!stopped.includes(ALT_ENTER));
  assert.ok(stopped.includes('finished'));
  assert.equal(stage.isActive(), false);
});

test('prompt panels use the full terminal width', () => {
  assert.deepEqual(new Set(plainWidths(sectionFrame('Choose action', ['Use arrows'], 80, false, false))), new Set([80]));
  assert.deepEqual(new Set(plainWidths(receiptFrame(['Selected connect'], 80, false, false))), new Set([80]));
});

test('prompt themes stay plain when colour is unavailable', () => {
  assert.equal(textPromptTheme(false).style.message('Number'), 'Number');
  assert.equal(confirmPromptTheme(false).style.answer('Yes'), 'Yes');
  assert.equal(selectPromptTheme(false, false).icon.cursor, '>');
  assert.ok(selectPromptTheme(true, true).icon.cursor.includes('❯'));
  assert.equal(promptPageSize(24, 16, 4), 2);
});

test('capabilities refuse pinning without an interactive terminal', () => {
  const nonTerminal = { ...fakeOut(120, 40), isTTY: false };
  assert.equal(stageCapabilities(nonTerminal, { color: false, unicode: false }).pinned, false);
  assert.equal(stageCapabilities(fakeOut(120, 40), { color: false, unicode: false }).pinned, true);
  assert.equal(
    stageCapabilities(fakeOut(120, 40), { color: false, unicode: false }, { TERM: 'dumb' }).alternate,
    false,
  );
});

test('an expanded dashboard uses the terminal width without wrapping', () => {
  const plugins = Array.from({ length: 16 }, (_, index) => ({ name: `plugin${index}`, order: (index + 1) * 10 }));
  const rows = dashboardRows(renderFluxIntro({
    plugins,
    columns: 120,
    rows: 50,
    maxWidth: 120,
    colour: false,
    unicode: false,
    activity: ['Selected connect', 'Entered number'],
    connection: 'open',
    linkedNumber: '62882017467912@test',
  }));
  assert.deepEqual(new Set(rows.map(visibleWidth)), new Set([118]));
  const text = rows.join('\n');
  assert.match(text, /plugin15/);
  assert.match(text, /Selected connect/);
  assert.match(text, /linked/);
  assert.match(text, /socket open/);
});

test('a short terminal automatically selects the compact dashboard', () => {
  const rows = dashboardRows(renderFluxIntro({
    columns: 80,
    rows: 30,
    maxWidth: 78,
    colour: false,
    unicode: false,
    plugins: [{ name: 'stealth', order: 10 }],
  }));
  assert.deepEqual(new Set(rows.map(visibleWidth)), new Set([78]));
  assert.ok(rows.length <= 22);
  assert.match(rows.join('\n'), /awaiting pairing/);
});

test('a very short terminal automatically selects the minimal dashboard', () => {
  const rows = dashboardRows(renderFluxIntro({
    columns: 80,
    rows: 22,
    maxWidth: 78,
    colour: false,
    unicode: false,
    plugins: [{ name: 'stealth', order: 10 }],
  }));
  assert.deepEqual(new Set(rows.map(visibleWidth)), new Set([78]));
  assert.ok(rows.length <= 16);
  assert.ok(!rows.join('\n').includes(':: CONSOLE'));
});

test('an explicit compact dashboard caps a large plugin inventory', () => {
  const plugins = Array.from({ length: 16 }, (_, index) => ({ name: `plugin${index}`, order: (index + 1) * 10 }));
  const text = renderFluxIntro({
    plugins,
    columns: 120,
    rows: 50,
    mode: 'compact',
    maxWidth: 120,
    colour: false,
    unicode: false,
  });
  assert.match(text, /\.\.\.and 10 more/);
});
