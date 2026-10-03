/**
 * Randomness, with a seedable generator.
 *
 * A bot needs this constantly — pick a random greeting, shuffle a list, pick a
 * winner, jitter a delay, mint an id — and `Math.random()` makes all of that
 * untestable. Everything here takes an optional `Random` so a test can pin the
 * sequence, while the module-level helpers default to the global generator and
 * are drop-in replacements for the ad-hoc `Math.random()` calls a script would
 * otherwise write.
 *
 * The generator is mulberry32: tiny, fast and good enough for presentation and
 * jitter. It is **not** cryptographic — for anything security-shaped use
 * `node:crypto`.
 */

export type Random = () => number;

/** Deterministic 32-bit PRNG. Same seed → same sequence, always. */
export function seeded(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A generator seeded from the clock, for the non-deterministic default. */
export const globalRandom: Random = seeded(Date.now() >>> 0);

/** Float in `[min, max)`. */
export function randomFloat(min = 0, max = 1, rng: Random = Math.random): number {
  return min + (max - min) * rng();
}

/**
 * Integer in `[min, max]`, inclusive. Uses rejection-free scaling: rounding a
 * float is fine for our purposes and keeps this allocation-free.
 */
export function randomInt(min: number, max: number, rng: Random = Math.random): number {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/** True with probability `p` (default a coin flip). */
export function chance(p = 0.5, rng: Random = Math.random): boolean {
  return rng() < p;
}

/** One element, or `undefined` for an empty list. */
export function pick<T>(items: readonly T[], rng: Random = Math.random): T | undefined {
  if (items.length === 0) return undefined;
  return items[randomInt(0, items.length - 1, rng)];
}

/**
 * `n` distinct elements (or the whole list, shuffled, when `n` is omitted or
 * exceeds the length). Never returns the same element twice.
 */
export function sample<T>(items: readonly T[], n: number, rng: Random = Math.random): T[] {
  const pool = [...items];
  const take = Math.max(0, Math.min(n, pool.length));
  for (let i = 0; i < take; i += 1) {
    const j = randomInt(i, pool.length - 1, rng);
    const tmp = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = tmp;
  }
  return pool.slice(0, take);
}

/** Fisher–Yates shuffle, returning a new array. */
export function shuffle<T>(items: readonly T[], rng: Random = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i, rng);
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

/** Pick by weight. Weights ≤ 0 are ignored; all-zero means `undefined`. */
export function weighted<T>(
  entries: readonly (readonly [T, number])[],
  rng: Random = Math.random,
): T | undefined {
  let total = 0;
  for (const [, weight] of entries) if (weight > 0) total += weight;
  if (total <= 0) return undefined;

  let roll = rng() * total;
  for (const [value, weight] of entries) {
    if (weight <= 0) continue;
    roll -= weight;
    if (roll < 0) return value;
  }
  // Float drift can leave `roll` just above zero; the last positive wins.
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (entry[1] > 0) return entry[0];
  }
  return undefined;
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const HEX_ALPHABET = '0123456789abcdef';

/** A short, URL-safe id. Not unique across processes — prefix if it matters. */
export function nanoId(size = 12, rng: Random = Math.random): string {
  let out = '';
  for (let i = 0; i < size; i += 1) out += ID_ALPHABET[randomInt(0, ID_ALPHABET.length - 1, rng)]!;
  return out;
}

/** A v4-shaped UUID. Uses `crypto.randomUUID` when the platform has it. */
export function uuid(rng: Random = Math.random): string {
  const globalCrypto = globalThis.crypto;
  if (globalCrypto && typeof globalCrypto.randomUUID === 'function' && rng === Math.random) {
    return globalCrypto.randomUUID();
  }
  const hex: string[] = [];
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) hex.push('-');
    else if (i === 14) hex.push('4');
    else if (i === 19) hex.push(HEX_ALPHABET[randomInt(8, 11, rng)]!);
    else hex.push(HEX_ALPHABET[randomInt(0, 15, rng)]!);
  }
  return hex.join('');
}

/**
 * Roughly normal noise via the mean of three uniforms, scaled to roughly
 * `[-spread, spread]` centred on zero. Use for anti-ban jitter.
 */
export function jitter(spread: number, rng: Random = Math.random): number {
  const mean = (rng() + rng() + rng()) / 3;
  return (mean - 0.5) * 2 * spread;
}

/** A hex colour, e.g. `#a1b2c3`. */
export function hexColor(rng: Random = Math.random): string {
  return `#${randomInt(0, 0xff_ff_ff, rng).toString(16).padStart(6, '0')}`;
}
