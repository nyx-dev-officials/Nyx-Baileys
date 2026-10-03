/**
 * Text formatting.
 *
 * Two things are asserted here rather than eyeballed: the exact WhatsApp
 * markdown dialect (single `*`/`_`/`~`, triple-backtick fences, numbered list
 * items in backticks — not the `-` bullets markdown uses), and table alignment
 * measured in *display columns* so CJK and emoji do not silently break it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bold,
  code,
  compose,
  formFlow,
  infoRow,
  italic,
  mono,
  preformatted,
  radioRow,
  strike,
  table,
  tableFlow,
} from '../dist/utils/compose.js';

import { columnOf, displayWidth, parseParams } from './helpers.js';

/* ── the dialect ─────────────────────────────────────────────────────── */

test('the inline markers use the WhatsApp dialect, not markdown', () => {
  assert.equal(bold('hi'), '*hi*', 'WhatsApp bold is *star*, not **star**');
  assert.equal(italic('hi'), '_hi_');
  assert.equal(strike('hi'), '~hi~');
  assert.equal(mono('hi'), '`hi`');

  assert.equal(bold('hi').includes('**'), false);
  assert.equal(italic('hi').includes('__'), false);
  assert.equal(strike('hi').includes('~~'), false);
});

test('code() emits a triple-backtick fence, with the language on its own line', () => {
  assert.equal(code('const a = 1'), '```const a = 1```');
  assert.equal(code('const a = 1', 'ts'), '```ts\nconst a = 1```');
  assert.equal(preformatted('line1\n\nline2'), '```line1\n\nline2```');
});

test('preformatted preserves blank lines, which plain compose would collapse', () => {
  const text = 'alpha\n\nbeta';
  assert.ok(preformatted(text).includes('\n\n'), 'the blank line survives');
});

/* ── compose ─────────────────────────────────────────────────────────── */

test('compose renders a numbered list with backticked numerals', () => {
  const out = compose({
    list: { title: 'Steps', items: ['first', 'second', 'third'] },
  });

  assert.equal(out, ['*Steps*', '', '`1.` first', '`2.` second', '`3.` third'].join('\n'));
  assert.equal(out.includes('- first'), false, 'markdown hyphens must not leak in');
});

test('compose renders sections as titled bullet groups', () => {
  const out = compose({
    sections: [
      { title: 'Alpha', rows: ['one', 'two'] },
      { title: 'Beta', rows: ['three'] },
    ],
  });

  assert.equal(
    out,
    ['*Alpha*', '• one', '• two', '', '*Beta*', '• three'].join('\n'),
  );
  assert.equal(out.split('\n').filter((l) => l === '').length, 1, 'exactly one blank separator');
});

test('compose joins list, sections and footer with a blank line before each block', () => {
  const out = compose({
    list: { title: 'Steps', items: ['a'] },
    sections: [{ title: 'Extra', rows: ['b'] }],
    footer: 'bye',
  });

  assert.equal(
    out,
    [
      '*Steps*',
      '',
      '`1.` a',
      '',
      '*Extra*',
      '• b',
      '',
      '_bye_',
    ].join('\n'),
  );
});

test('the footer is italic and nothing else is', () => {
  const out = compose({ footer: 'sent from nyx' });
  assert.equal(out, '_sent from nyx_');
  assert.equal(compose({}).includes('*'), false);
});

test('compose of nothing is the empty string', () => {
  assert.equal(compose({}), '');
  assert.equal(compose({ sections: [] }), '');
  assert.equal(compose({ list: { title: 'T', items: [] } }), '*T*\n');
});

/* ── table ───────────────────────────────────────────────────────────── */

test('table pads ASCII columns to a shared width and rules them with box characters', () => {
  const out = table(['Name', 'Qty'], [
    ['apple', '3'],
    ['kiwi', '12'],
  ]);

  // 'apple' is 5 columns wide, so that is the width of the whole first column.
  assert.equal(
    out,
    ['Name   Qty', '─────  ───', 'apple  3', 'kiwi   12'].join('\n'),
  );
  assert.equal(out.includes('|'), false, 'markdown pipes render literally in WhatsApp');
  assert.equal(out.includes('---'), false);
});

test('table aligns CJK columns by display width, not by string length', () => {
  const out = table(['名前', 'Qty'], [
    ['さくら', '12'],
    ['Al', '3'],
  ]);

  assert.equal(out, ['名前    Qty', '──────  ───', 'さくら  12', 'Al      3'].join('\n'));

  // The real property: every row's second column starts at the same display
  // column, which is what "aligned" means when cells are not the same width.
  const [head, , r1, r2] = out.split('\n');
  const aligned = [columnOf(head, 'Qty'), columnOf(r1, '12'), columnOf(r2, '3')];
  assert.deepEqual(aligned, [8, 8, 8], `columns did not align: ${aligned.join(',')}`);

  // A naive string-index implementation would NOT agree — that is the whole
  // point of displayWidth, and the reason this test is not tautological.
  const naive = [head.indexOf('Qty'), r1.indexOf('12'), r2.indexOf('3')];
  assert.notDeepEqual(aligned, naive, 'string indices are not display columns here');
});

test('a wide CJK cell grows its column past its own header', () => {
  // 'さくら' is 6 display columns; the header '名前' is only 4. The column has
  // to grow to fit the data or the ASCII row would be pushed out of line.
  const out = table(['名前', 'v'], [
    ['さくら', '1'],
    ['x', '2'],
  ]);
  assert.deepEqual(out.split('\n'), ['名前    v', '──────  ─', 'さくら  1', 'x       2']);
});

test('table counts emoji as two columns', () => {
  const out = table(['E', 'n'], [
    ['🎉', '1'],
    ['ab', '22'],
  ]);
  assert.deepEqual(out.split('\n'), ['E   n', '──  ──', '🎉  1', 'ab  22']);
  assert.equal(displayWidth('🎉'), 2, 'sanity: emoji is wide');
});

test('table leaves no trailing whitespace on the last rendered line', () => {
  const out = table(['a', 'b'], [['longer value', 'x']]);
  const lines = out.split('\n');
  for (const line of lines) {
    assert.equal(line, line.replace(/\s+$/, ''), `trailing whitespace in ${JSON.stringify(line)}`);
  }
});

test('a short row is padded from the headers, and a missing cell is not "undefined"', () => {
  const out = table(['a', 'b', 'c'], [['1']]);
  const rows = out.split('\n');
  assert.equal(rows.length, 3);
  assert.equal(rows[2], '1');
  assert.equal(out.includes('undefined'), false);
});

test('a header-only table still emits a rule', () => {
  const out = table(['only'], []);
  assert.equal(out, 'only\n────');
});

test('a table with no columns at all degenerates to a blank line', () => {
  // Documented as-is: `[line([]), rule([])].join('\n')` — no headers, no rows,
  // nothing to render. Asserting the real output so a change is noticed.
  assert.equal(table([], []), '\n');
});

/* ── flow helpers that delegate to nodes ─────────────────────────────── */

test('formFlow builds a native flow whose rows all carry an optionName', () => {
  const node = formFlow({
    title: 'Choose',
    sections: [
      {
        title: 'Plan',
        rows: [
          { title: 'Free', id: 'plan_free', description: 'no card' },
          { title: 'Pro', id: 'plan_pro' },
        ],
      },
    ],
  });

  const nf = node.message.interactiveMessage.nativeFlowMessage;
  const p = parseParams(nf.messageParamsJson, 'formFlow messageParamsJson');

  assert.equal(p.title, 'Choose');
  assert.equal(p.sections[0].title, 'Plan');
  assert.deepEqual(
    p.sections[0].rows.map((r) => r.optionName),
    ['plan_free', 'plan_pro'],
    'radioRow always sets an optionName from the spec id',
  );
  assert.equal(p.sections[0].rows[0].description, 'no card');
  assert.deepEqual(parseParams(nf.buttons[0].buttonParamsJson), { displayName: 'Continue' });
});

test('tableFlow builds a read-only data sheet', () => {
  const node = tableFlow('Ledger', ['Region', 'Total'], [
    ['North', '10'],
    ['South', '7'],
  ]);
  const p = parseParams(node.message.interactiveMessage.nativeFlowMessage.messageParamsJson);

  assert.equal(p.ctaLabel, 'Close');
  assert.equal(p.sections[0].rows[0].title, 'Region: North');
  assert.equal(p.sections[0].rows[0].description, '10');
  assert.equal('optionName' in p.sections[0].rows[0], false);
});

test('compose re-exports the node row builders', () => {
  assert.deepEqual(radioRow('t', 'o', 'd'), { title: 't', optionName: 'o', description: 'd' });
  assert.equal('optionName' in infoRow('t', 'd'), false);
});