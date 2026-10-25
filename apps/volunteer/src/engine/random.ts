/**
 * Seeded randomness for the engine's own choices. Nothing here reads Math.random or a clock, so a
 * search with the same seed, the same job answers and the same clock makes the same choices.
 */

// toUint32, mixSeed and seededStream are shared with the searches of the spaces and the board
export { mixSeed, seededStream, toUint32 } from "@polypack/spaces/search";

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
