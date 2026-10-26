import type { Rng } from "./kernel";

/** mulberry32, as every PolyPack search uses it: a seed in [0, 2^32 - 1] gives a stream in [0, 1). */
export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A uniform integer in [0, n). */
export const randomInt = (rng: Rng, n: number) => Math.min(n - 1, Math.floor(rng() * n));

/** k distinct integers of [0, n), in random order (k <= n). */
export function sample(rng: Rng, n: number, k: number): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = 0; i < k; i++) {
    const j = i + randomInt(rng, n - i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}
