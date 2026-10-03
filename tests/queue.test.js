/**
 * Concurrency primitives.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { backoffDelay, Semaphore, TaskQueue, withRetry } from '../dist/utils/queue.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

/* ── TaskQueue ───────────────────────────────────────────────────────── */

test('a serial queue runs tasks one at a time, in order', async () => {
  const queue = new TaskQueue();
  const events = [];
  let active = 0;
  let peak = 0;

  const tasks = [1, 2, 3].map((n) =>
    queue.add(async () => {
      active += 1;
      peak = Math.max(peak, active);
      events.push(`start${n}`);
      await tick();
      events.push(`end${n}`);
      active -= 1;
      return n * 10;
    }),
  );

  assert.deepEqual(await Promise.all(tasks), [10, 20, 30]);
  assert.equal(peak, 1, 'serial means never more than one running');
  assert.deepEqual(events, ['start1', 'end1', 'start2', 'end2', 'start3', 'end3']);
});

test('concurrency lets that many tasks overlap and no more', async () => {
  const queue = new TaskQueue({ concurrency: 2 });
  let active = 0;
  let peak = 0;

  const tasks = [1, 2, 3, 4].map(() =>
    queue.add(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await tick();
      active -= 1;
    }),
  );

  await Promise.all(tasks);
  await tick(); // let the final `finally` clear the active slot
  assert.equal(peak, 2);
  assert.equal(queue.idle, true);
});

test('add resolves with the task result and rejects with its error', async () => {
  const queue = new TaskQueue();
  assert.equal(await queue.add(() => 5), 5);
  await assert.rejects(queue.add(() => Promise.reject(new Error('nope'))), /nope/);
});

test('onError observes a failure without swallowing it', async () => {
  const seen = [];
  const queue = new TaskQueue({ onError: (error) => seen.push(error.message) });
  await assert.rejects(queue.add(() => Promise.reject(new Error('bad'))));
  assert.deepEqual(seen, ['bad']);
});

test('onIdle resolves when the queue drains, immediately when already idle', async () => {
  const queue = new TaskQueue();
  await queue.onIdle(); // no throw, resolves

  let done = false;
  const p = queue.add(async () => {
    await tick();
    done = true;
  });
  assert.equal(queue.idle, false);
  await queue.onIdle();
  assert.equal(done, true);
  await p;
});

test('pause holds tasks until resume', async () => {
  const queue = new TaskQueue();
  let ran = false;
  queue.pause();
  const p = queue.add(() => {
    ran = true;
  });
  await tick();
  assert.equal(ran, false, 'a paused queue starts nothing');
  assert.equal(queue.paused, true);
  assert.equal(queue.size, 1);

  queue.resume();
  await p;
  assert.equal(ran, true);
});

test('clear drops waiting tasks without running them', async () => {
  const queue = new TaskQueue();
  queue.pause();
  let ran = false;
  queue.add(() => {
    ran = true;
  });
  queue.clear();
  assert.equal(queue.size, 0);
  queue.resume();
  await tick();
  assert.equal(ran, false);
});

/* ── Semaphore ───────────────────────────────────────────────────────── */

test('a semaphore limits concurrent holders', async () => {
  const sem = new Semaphore(2);
  let active = 0;
  let peak = 0;

  const work = [1, 2, 3, 4, 5].map(() =>
    sem.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await tick();
      active -= 1;
    }),
  );

  await Promise.all(work);
  assert.equal(peak, 2);
  assert.equal(sem.available, 2);
  assert.equal(sem.waiting, 0);
});

test('a semaphore releases the slot when the task throws', async () => {
  const sem = new Semaphore(1);
  await assert.rejects(sem.run(() => Promise.reject(new Error('x'))));
  assert.equal(sem.available, 1, 'the slot came back');
  assert.equal(await sem.run(() => 42), 42);
});

test('release on a free semaphore is a no-op', () => {
  const sem = new Semaphore(1);
  assert.doesNotThrow(() => sem.release());
  assert.equal(sem.available, 1);
});

/* ── withRetry and backoffDelay ──────────────────────────────────────── */

test('withRetry returns the first success', async () => {
  let calls = 0;
  const value = await withRetry(async () => {
    calls += 1;
    return 'ok';
  });
  assert.equal(value, 'ok');
  assert.equal(calls, 1);
});

test('withRetry retries until it succeeds', async () => {
  const sleeps = [];
  let calls = 0;
  const value = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error('again');
      return calls;
    },
    { attempts: 5, baseDelayMs: 10, sleep: async (ms) => sleeps.push(ms) },
  );
  assert.equal(value, 3);
  assert.deepEqual(sleeps, [10, 20], 'exponential backoff between attempts');
});

test('withRetry gives up and rethrows the last error', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      () => {
        calls += 1;
        return Promise.reject(new Error(`fail ${calls}`));
      },
      { attempts: 3, baseDelayMs: 0, sleep: async () => {} },
    ),
    /fail 3/,
  );
  assert.equal(calls, 3);
});

test('shouldRetry can stop early', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      () => {
        calls += 1;
        return Promise.reject(new Error('permanent'));
      },
      { attempts: 5, baseDelayMs: 0, sleep: async () => {}, shouldRetry: () => false },
    ),
  );
  assert.equal(calls, 1, 'a non-retryable error is not retried');
});

test('backoffDelay grows exponentially and is capped', () => {
  assert.equal(backoffDelay(1, { baseDelayMs: 100 }), 100);
  assert.equal(backoffDelay(2, { baseDelayMs: 100 }), 200);
  assert.equal(backoffDelay(3, { baseDelayMs: 100 }), 400);
  assert.equal(backoffDelay(10, { baseDelayMs: 100, maxDelayMs: 500 }), 500);
});
