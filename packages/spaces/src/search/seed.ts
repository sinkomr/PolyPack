/**
 * Seeded randomness for the searches' own choices (which job comes next, the seed of each job or
 * round). Nothing here reads Math.random or a clock, so the same seed, the same job answers and
 * the same clock give the same choices. The volunteer client's polygon engine uses the same
 * functions (apps/volunteer/src/engine/random.ts re-exports them).
 */

/** Any number as a uint32: finite values wrap modulo 2^32 (negative ones too), others become 0. */
export function toUint32(value: number): number {
  return Number.isFinite(value) ? Math.trunc(value) >>> 0 : 0;
}

/** A well-mixed uint32 from two inputs (the finaliser of MurmurHash3 over a golden-ratio step). */
export function mixSeed(a: number, b: number): number {
  let h = (toUint32(a) ^ Math.imul(toUint32(b) + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Uniform draws in [0, 1) from a uint32 seed (mulberry32, the solver's own generator). */
export function seededStream(seed: number): () => number {
  let state = toUint32(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
