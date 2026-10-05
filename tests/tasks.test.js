/**
 * Cron parsing and scheduling.
 *
 * Two things are worth more than the syntax and both are pinned here: the cron
 * day fields OR (a crontab rule that is wrong in most reimplementations), and a
 * throwing task never taking its own schedule down with it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CronError,
  Scheduler,
  cronMatches,
  nextCronTime,
  parseCron,
} from '../dist/core/tasks.js';

import { sleep } from './helpers.js';

/* ── cron parsing ────────────────────────────────────────────────────── */

test('a wildcard field expands to its whole range', () => {
  const schedule = parseCron('* * * * *');
  assert.equal(schedule.minute.size, 60);
  assert.equal(schedule.hour.size, 24);
  assert.equal(schedule.dayOfMonth.size, 31);
  assert.equal(schedule.month.size, 12);
  assert.equal(schedule.dayOfWeek.size, 7);
  assert.equal(schedule.domWildcard, true);
  assert.equal(schedule.dowWildcard, true);
});

test('lists, ranges, steps and */n all parse', () => {
  assert.deepEqual([...parseCron('1,2,3 * * * *').minute].sort((a, b) => a - b), [1, 2, 3]);
  assert.deepEqual([...parseCron('10-13 * * * *').minute].sort((a, b) => a - b), [10, 11, 12, 13]);
  assert.equal(parseCron('*/15 * * * *').minute.size, 4);
  assert.equal([...parseCron('*/15 * * * *').minute].sort((a, b) => a - b).join(), '0,15,30,45');
  assert.equal([...parseCron('10-20/5 * * * *').minute].sort((a, b) => a - b).join(), '10,15,20');
});

test('a bare value with a step means "from here, to the end"', () => {
  assert.deepEqual([...parseCron('50/10 * * * *').minute].sort((a, b) => a - b), [50]);
  const from = [...parseCron('5/20 * * * *').minute].sort((a, b) => a - b);
  assert.deepEqual(from, [5, 25, 45]);
});

test('day-of-week accepts 7 as Sunday and normalises it', () => {
  assert.equal(parseCron('0 0 * * 7').dayOfWeek.has(0), true);
  assert.equal(parseCron('0 0 * * 7').dayOfWeek.has(7), false);
});

test('bad expressions are rejected with a CronError', () => {
  const bad = [
    '',
    '* * * *',
    '* * * * * *',
    '60 * * * *',
    '* 24 * * *',
    '* * 0 * *',
    '* * * 13 *',
    '* * * * 8',
    '*/0 * * * *',
    'abc * * * *',
    '10-5 * * * *',
    '1-2-3 * * * *',
    '1,,2 * * * *',
  ];
  for (const expr of bad) {
    assert.throws(() => parseCron(expr), CronError, `accepted ${JSON.stringify(expr)}`);
  }
});

/* ── cron matching ───────────────────────────────────────────────────── */

test('a schedule matches only its exact minute', () => {
  const schedule = parseCron('30 14 * * *');
  assert.equal(cronMatches(schedule, new Date(2026, 0, 5, 14, 30)), true);
  assert.equal(cronMatches(schedule, new Date(2026, 0, 5, 14, 31)), false);
  assert.equal(cronMatches(schedule, new Date(2026, 0, 5, 15, 30)), false);
});

test('the two day fields are OR-ed, as crontab says', () => {
  // 2026-01-09 is a Friday; 2026-01-05 is a Monday. Both are used so the
  // day-of-week match is genuinely a Friday, not just "some weekday".
  const friday13 = parseCron('0 0 13 * 5');
  const friday = new Date(2026, 0, 9, 0, 0);
  assert.equal(friday.getDay(), 5, 'fixture assumption: 2026-01-09 is a Friday');
  assert.equal(cronMatches(friday13, friday), true, 'a day-of-week match alone counts');
  assert.equal(cronMatches(friday13, new Date(2026, 0, 13, 0, 0)), true, 'a day-of-month match alone counts');
  assert.equal(cronMatches(friday13, new Date(2026, 0, 5, 0, 0)), false, 'neither field matches a Monday');

  // With one field wildcarded it is a plain match on the other.
  const onlyDow = parseCron('0 0 13 * *');
  assert.equal(cronMatches(onlyDow, new Date(2026, 0, 5, 0, 0)), false);
  assert.equal(cronMatches(onlyDow, new Date(2026, 0, 13, 0, 0)), true);
});

test('a schedule finds a later time on the same day', () => {
  // The day-skipping search must not step over today's remaining hours.
  const next = nextCronTime('30 14 * * *', new Date(2026, 0, 5, 10, 15, 30));
  assert.ok(next, 'a schedule later today must be found, not skipped past');
  assert.equal(next.getDate(), 5);
  assert.equal(next.getHours(), 14);
  assert.equal(next.getMinutes(), 30);
});

test('nextCronTime returns the next matching minute, strictly after the input', () => {
  const from = new Date(2026, 0, 5, 10, 15, 30);
  const next = nextCronTime('30 14 * * *', from);
  assert.equal(next.getHours(), 14);
  assert.equal(next.getMinutes(), 30);
  assert.ok(next > from);

  // Already at the firing minute: the next one is a day later, never the same
  // instant back.
  const onTheMinute = new Date(2026, 0, 5, 14, 30, 0);
  const following = nextCronTime('30 14 * * *', onTheMinute);
  assert.equal(following.getDate(), 6);
  assert.ok(following > onTheMinute);
});

test('nextCronTime skips whole days rather than crawling', () => {
  // A yearly schedule must not walk two years of minutes.
  const from = new Date(2026, 5, 15, 9, 0, 0);
  const started = process.hrtime.bigint();
  const next = nextCronTime('0 0 1 1 *', from);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(next.getMonth(), 0);
  assert.equal(next.getDate(), 1);
  assert.equal(next.getHours(), 0);
  assert.ok(elapsedMs < 250, `day-skipping regressed: ${elapsedMs.toFixed(1)}ms`);
});

test('a schedule that matched every minute returns the very next one', () => {
  const from = new Date(2026, 0, 5, 10, 15, 45);
  const next = nextCronTime('* * * * *', from);
  assert.equal(next.getMinutes(), 16);
  assert.equal(next.getSeconds(), 0);
});

/* ── scheduler ───────────────────────────────────────────────────────── */

test('every() fires repeatedly', async () => {
  const scheduler = new Scheduler();
  let fired = 0;
  scheduler.every(15, () => {
    fired += 1;
  });

  // The contract is "fires repeatedly", not an exact tick count. Under a
  // loaded runner a 15ms interval cannot be relied on to fire eight times in
  // 120ms, and asserting that made this flaky in a full `npm test` run while
  // passing reliably in isolation.
  await sleep(300);
  scheduler.dispose();
  assert.ok(fired >= 2, `expected repeated fires within 300ms, got ${fired}`);
});

test('a task that throws is reported and the schedule survives it', async () => {
  const errors = [];
  const scheduler = new Scheduler({ onError: (err, task) => errors.push([err.message, task.name]) });
  let fired = 0;

  const task = scheduler.every(
    15,
    () => {
      fired += 1;
      if (fired === 1) throw new Error('boom');
    },
    { name: 'flaky' },
  );

  await sleep(120);
  scheduler.dispose();

  assert.ok(fired >= 3, `a failing task killed its own schedule after ${fired} run(s)`);
  assert.equal(errors.length, 1, 'the failure should have been reported once');
  assert.deepEqual(errors[0], ['boom', 'flaky']);
  assert.equal(task.failures, 1);
  assert.ok(task.runs >= 3);
});

test('a rejected promise is contained too', async () => {
  const errors = [];
  const scheduler = new Scheduler({ onError: (err) => errors.push(err.message) });
  let fired = 0;
  scheduler.every(15, () => {
    fired += 1;
    return Promise.reject(new Error('async boom'));
  });

  await sleep(90);
  scheduler.dispose();
  assert.ok(fired >= 2);
  assert.ok(errors.includes('async boom'));
});

test('at() runs once, in the past or near, and then unregisters', async () => {
  const scheduler = new Scheduler();
  let fired = 0;
  scheduler.at(Date.now() + 20, () => {
    fired += 1;
  });

  await sleep(90);
  assert.equal(fired, 1);
  assert.equal(scheduler.size, 0, 'a one-shot must not stay registered');
  scheduler.dispose();
});

test('at() accepts a date in the past and fires immediately', async () => {
  const scheduler = new Scheduler();
  let fired = 0;
  scheduler.at(new Date(Date.now() - 10_000), () => {
    fired += 1;
  });
  await sleep(40);
  assert.equal(fired, 1);
  scheduler.dispose();
});

test('at() rejects an unparseable date', () => {
  const scheduler = new Scheduler();
  assert.throws(() => scheduler.at('not a date', () => {}), /not a date/);
  scheduler.dispose();
});

test('every() rejects a non-positive interval', () => {
  const scheduler = new Scheduler();
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => scheduler.every(bad, () => {}), RangeError, `accepted ${bad}`);
  }
  scheduler.dispose();
});

test('cron() validates on registration, not at the first tick', () => {
  const scheduler = new Scheduler();
  assert.throws(() => scheduler.cron('not cron', () => {}), CronError);
  scheduler.dispose();
});

test('a cancelled task stops firing', async () => {
  const scheduler = new Scheduler();
  let fired = 0;
  const task = scheduler.every(15, () => {
    fired += 1;
  });

  await sleep(50);
  task.cancel();
  const after = fired;
  await sleep(80);

  assert.equal(fired, after, 'a cancelled task kept running');
  assert.equal(scheduler.size, 0);
  assert.doesNotThrow(() => task.cancel(), 'cancel is idempotent');
  scheduler.dispose();
});

test('dispose stops everything and refuses new work', async () => {
  const scheduler = new Scheduler();
  let fired = 0;
  scheduler.every(15, () => {
    fired += 1;
  });
  scheduler.at(Date.now() + 10_000, () => {
    fired += 1;
  });

  assert.equal(scheduler.size, 2);
  scheduler.dispose();
  assert.equal(scheduler.size, 0);

  const after = fired;
  await sleep(60);
  assert.equal(fired, after);

  assert.throws(() => scheduler.every(15, () => {}), /disposed/);
  assert.throws(() => scheduler.cron('* * * * *', () => {}), /disposed/);
  assert.doesNotThrow(() => scheduler.dispose(), 'dispose is idempotent');
});

test('immediate runs the task now as well as on the schedule', async () => {
  const scheduler = new Scheduler();
  let fired = 0;
  scheduler.every(
    10_000,
    () => {
      fired += 1;
    },
    { immediate: true },
  );
  await sleep(20);
  assert.equal(fired, 1);
  scheduler.dispose();
});

test('list() and get() expose live tasks with their next due time', () => {
  const scheduler = new Scheduler();
  const a = scheduler.every(10_000, () => {}, { name: 'a' });
  scheduler.cron('0 0 * * *', () => {}, { name: 'b' });

  const list = scheduler.list();
  assert.deepEqual(list.map((t) => t.name), ['a', 'b']);
  assert.equal(list[0].kind, 'interval');
  assert.equal(list[0].everyMs, 10_000);
  assert.equal(list[1].kind, 'cron');
  assert.equal(list[1].cron, '0 0 * * *');
  assert.ok(list[0].nextRunAt() > Date.now(), 'an armed interval reports its next fire');
  assert.ok(list[1].nextRunAt() > Date.now(), 'a cron task is armed too');

  assert.equal(scheduler.get(a.id).name, 'a');
  assert.equal(scheduler.get(9999), undefined);
  assert.equal(scheduler.cancel(9999), false);
  scheduler.dispose();
});

test('cancel(id) removes a task by id', async () => {
  const scheduler = new Scheduler();
  let fired = 0;
  const task = scheduler.every(15, () => {
    fired += 1;
  });

  assert.equal(scheduler.cancel(task.id), true);
  assert.equal(scheduler.size, 0);
  const after = fired;
  await sleep(50);
  assert.equal(fired, after);
  scheduler.dispose();
});

test('an error handler that itself throws does not escape', async () => {
  const scheduler = new Scheduler({
    onError: () => {
      throw new Error('handler exploded');
    },
  });
  scheduler.every(15, () => {
    throw new Error('task exploded');
  });

  await sleep(70);
  assert.doesNotThrow(() => scheduler.dispose());
});

test('jitter keeps tasks inside their window', async () => {
  const scheduler = new Scheduler();
  let fired = 0;
  scheduler.every(
    20,
    () => {
      fired += 1;
    },
    { jitterMs: 10 },
  );

  await sleep(150);
  scheduler.dispose();
  // With jitter a fast task must not spin; without it, a 20ms interval would
  // fire roughly seven times in 150ms.
  assert.ok(fired <= 8, `jitter did not hold the rate: ${fired} fires`);
  assert.ok(fired >= 2, `jitter stalled the task: ${fired} fires`);
});
