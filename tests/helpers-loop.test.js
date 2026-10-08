/**
 * The `range` / `times` unbounded-loop defect, and the general class.
 *
 * ## What happened
 *
 * `range('hello', 'x')` looped forever. `for (let i = start; i < end; i += step)`
 * reads as safe for any input and is not: with strings, `i += step` performs
 * **concatenation**, so `i` walks `'hello1'`, `'hello12'`, `'hello123'` — each
 * still sorting before `'x'` — pushing onto the array without end. Unbounded
 * loop plus unbounded allocation: the process hangs and then exhausts memory.
 *
 * It is three lines long, it type-checks, and it passed every unit test in the
 * suite, because every existing test passes it numbers.
 *
 * ## Why it is easy to ship
 *
 * `Array.from`, `for` loops and `+=` are all total functions over the wrong
 * type in JavaScript. Nothing throws. The failure is a hang, so it does not
 * surface as a test failure either — it surfaces as a suite that never finishes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { range, times } from '../dist/features/helpers.js';

test('range builds a normal ascending range', () => {
  assert.deepEqual(range(0, 5), [0, 1, 2, 3, 4]);
  assert.deepEqual(range(0, 10, 3), [0, 3, 6, 9]);
});

test('range builds a descending range on a negative step', () => {
  assert.deepEqual(range(5, 0, -1), [5, 4, 3, 2, 1]);
  assert.deepEqual(range(10, 0, -5), [10, 5]);
});

test('range is empty when the bounds do not imply elements', () => {
  assert.deepEqual(range(5, 5), []);
  assert.deepEqual(range(0, 5, -1), []);
});

test('range rejects a zero step', () => {
  assert.throws(() => range(0, 10, 0), RangeError);
});

test('range refuses string arguments instead of looping forever', () => {
  // The defect itself. Without the guard this call does not return — it spins
  // appending digits to a string and growing an array without bound.
  assert.throws(() => range('hello', 'x'), TypeError);
  assert.throws(() => range('0', '5'), TypeError);
  assert.throws(() => range(0, '5'), TypeError);
});

test('range rejects NaN and Infinity', () => {
  assert.throws(() => range(NaN, 5), TypeError);
  assert.throws(() => range(0, Infinity), TypeError);
  assert.throws(() => range(0, 10, NaN), TypeError);
});

test('range refuses a span too large to materialise', () => {
  // Same failure mode as the string case, reached with valid numbers.
  assert.throws(() => range(0, 1e9), RangeError);
  assert.throws(() => range(0, 1e9, 1), RangeError);
});

test('range still allows a large-but-reasonable span', () => {
  assert.equal(range(0, 100_000).length, 100_000);
});

test('times calls the callback n times', () => {
  const seen = [];
  times(3, (i) => seen.push(i));
  assert.deepEqual(seen, [0, 1, 2]);
});

test('times clamps negatives to zero rather than throwing', () => {
  let called = 0;
  times(-5, () => { called += 1; });
  assert.equal(called, 0, 'existing behaviour: a negative count is clamped, not rejected');
});

test('times rejects non-finite and enormous counts', () => {
  assert.throws(() => times('many', () => 1), TypeError);
  assert.throws(() => times(NaN, () => 1), TypeError);
  assert.throws(() => times(1e9, () => 1), RangeError);
});