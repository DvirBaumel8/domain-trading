// Seeded randomness for the engine models. Everything the models do with chance (validation slice, bootstrap, subsampling) goes through here,
// so the same data and the same seed give the same model.
import { createHash } from 'node:crypto';

/** mulberry32: a small 32-bit generator; returns numbers in [0, 1). */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable 32-bit seed from text. */
export function seedOf(text: string): number {
  return createHash('sha256').update(text).digest().readUInt32BE(0);
}

/** A stable number in [0, 1) from text (sha256), for "hash split" decisions that must not depend on row order. */
export function hashUnit(text: string): number {
  return createHash('sha256').update(text).digest().readUInt32BE(0) / 4294967296;
}

/** Fisher-Yates over 0..n-1 with the seeded generator. */
export function seededPermutation(n: number, rng: () => number): Int32Array {
  const p = new Int32Array(n);
  for (let i = 0; i < n; i++) p[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = p[i]!; p[i] = p[j]!; p[j] = t;
  }
  return p;
}
