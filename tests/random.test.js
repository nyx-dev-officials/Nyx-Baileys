/**
 * Randomness.
 *
 * The point of the seedable generator is determinism, so most of these pin a
 * seed and assert on the sequence or on a property that must always hold.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  chance,
  hexColor,
  jitter,
  nanoId,
  pick,
  randomFloat,
  randomInt,
  sample,
  seeded,
  shuffle,
  uuid,
  weighted,
} from '../dist/utils/random.js';

test('a seeded generator is reproducible, different seeds differ', () => {
  const a = seeded(42);
  const b = seeded(42);
  const c = seeded(43);

  const seqA = Array.from({ length: 5 }, () => a());
  const seqB = Array.from({ length: 5 }, () => b());
  const seqC = Array.from({ length: 5 }, () => c());

  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
  for (const n of seqA) assert.ok(n >= 0 && n < 1, `out of range: ${n}`);
});

test('randomInt is inclusive on both ends and in range', () => {
  assert.equal(randomInt(5, 5), 5);
  assert.equal(randomInt(0, 9, () => 0), 0);
  assert.equal(randomInt(0, 9, () => 0.999999), 9);

  const rng = seeded(7);
  for (let i = 0; i < 500; i += 1) {
    const n = randomInt(3, 8, rng);
    assert.ok(Number.isInteger(n) && n >= 3 && n <= 8, `out of range: ${n}`);
  }
});

test('randomFloat stays within its span', () => {
  assert.equal(randomFloat(2, 4, () => 0), 2);
  assert.equal(randomFloat(2, 4, () => 0.5), 3);
  const rng = seeded(17);
  for (let i = 0; i < 100; i += 1) {
    const n = randomFloat(0, 1, rng);
    assert.ok(n >= 0 && n < 1, `out of default range: ${n}`);
  }
});

test('chance is a threshold on the roll', () => {
  assert.equal(chance(0.5, () => 0.49), true);
  assert.equal(chance(0.5, () => 0.5), false);
  assert.equal(chance(0, () => 0), false);
  assert.equal(chance(1, () => 0.999999), true);
});

test('pick returns an element or undefined for an empty list', () => {
  assert.equal(pick([]), undefined);
  assert.equal(pick(['only']), 'only');
  assert.equal(pick(['a', 'b', 'c'], () => 0), 'a');
  assert.equal(pick(['a', 'b', 'c'], () => 0.999999), 'c');
});

test('sample takes distinct elements and never exceeds the list', () => {
  const items = [1, 2, 3, 4, 5];
  const rng = seeded(11);
  for (let i = 0; i < 50; i += 1) {
    const got = sample(items, 3, rng);
    assert.equal(got.length, 3);
    assert.equal(new Set(got).size, 3, 'sampled values must be distinct');
  }
  assert.deepEqual(sample(items, 99).slice().sort((a, b) => a - b), items, 'n beyond the list returns all');
  assert.deepEqual(sample(items, 0), []);
});

test('shuffle is a permutation and returns a new array', () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  const out = shuffle(items, seeded(3));
  assert.notEqual(out, items, 'a fresh array is returned');
  assert.deepEqual(items, [1, 2, 3, 4, 5, 6, 7, 8], 'the input is untouched');
  assert.deepEqual(out.slice().sort((a, b) => a - b), items);
});

test('weighted picks by weight and skips non-positive weights', () => {
  const entries = [
    ['a', 0],
    ['b', 1],
    ['c', 3],
  ];
  assert.equal(weighted([], () => 0), undefined);
  assert.equal(weighted([['x', 0]], () => 0), undefined);
  assert.equal(weighted(entries, () => 0), 'b', 'first positive weight at roll 0');
  assert.equal(weighted(entries, () => 0.99), 'c', 'the heavy entry at the top of the range');
  assert.equal(weighted([['solo', 5]], () => 0.5), 'solo');
});

test('weighted honours relative frequencies', () => {
  const rng = seeded(99);
  let heavy = 0;
  for (let i = 0; i < 2000; i += 1) {
    if (weighted([['light', 1], ['heavy', 9]], rng) === 'heavy') heavy += 1;
  }
  assert.ok(heavy > 1500 && heavy < 1950, `expected ~1800 heavy picks, got ${heavy}`);
});

test('nanoId has the requested length and alphabet', () => {
  assert.equal(nanoId(8, seeded(1)).length, 8);
  assert.equal(nanoId(0).length, 0);
  assert.match(nanoId(20, seeded(2)), /^[a-z0-9]{20}$/);
});

test('uuid looks like a v4 uuid', () => {
  const value = uuid(seeded(5));
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test('jitter is centred on zero and bounded by the spread', () => {
  const rng = seeded(13);
  let sum = 0;
  for (let i = 0; i < 1000; i += 1) {
    const n = jitter(100, rng);
    assert.ok(n >= -100 && n <= 100, `out of bounds: ${n}`);
    sum += n;
  }
  assert.ok(Math.abs(sum / 1000) < 12, 'the mean should sit near zero');
});

test('hexColor is a six-digit hex colour', () => {
  assert.match(hexColor(seeded(21)), /^#[0-9a-f]{6}$/);
});
