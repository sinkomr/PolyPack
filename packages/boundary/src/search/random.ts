/** Seeded randomness for the boundary searches: every random choice comes from one mulberry32 stream. */

/** mulberry32: uniform draws in [0, 1) from a uint32 seed (the solver's own generator). */
export function mulberry32(seed: number): () => number {
  let a = (Number.isFinite(seed) ? Math.trunc(seed) : 0) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A uniform integer in [0, n). */
export const randInt = (rand: () => number, n: number): number => Math.min(n - 1, Math.floor(rand() * n));
