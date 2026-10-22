/**
 * Seeded randomness for the engine's own choices. Nothing here reads Math.random or a clock, so a
 * search with the same seed, the same job answers and the same clock makes the same choices.
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

function normal(random: () => number): number {
  // Box-Muller; 1 - u keeps the logarithm finite
  return Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
}

/** Gamma(shape, 1) by Marsaglia and Tsang's squeeze, with the usual boost for shape < 1. */
function gamma(random: () => number, shape: number): number {
  if (shape < 1) return gamma(random, shape + 1) * Math.pow(random(), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(random);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = random();
    if (u < 1 - 0.0331 * x * x * x * x || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** One draw from Beta(alpha, beta), both positive. */
export function betaSample(random: () => number, alpha: number, beta: number): number {
  const x = gamma(random, alpha);
  const y = gamma(random, beta);
  return x + y > 0 ? x / (x + y) : 0.5;
}
