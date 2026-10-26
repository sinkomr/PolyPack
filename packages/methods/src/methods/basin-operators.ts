/**
 * The perturbations and the acceptance rule of basin_hopping (basin_hopping.ts), on any kernel.
 * Every operator changes a state the caller owns, in place, through kernel calls only: jiggle,
 * randomPose, swap and pieceEnergy. None of them decides validity.
 *
 * The polygon method's cluster rotation, peel and cleave are not here: each needs the pieces'
 * positions in a common frame (a centroid, a wall normal, a vertex), which the kernel does not
 * expose (docs/methods/dimensions/basin_hopping.md).
 */
import type { KernelState, Rng, SpaceKernel } from "../kernel";
import { randomInt, sample } from "../random";

export const OPERATORS = ["kick", "swap", "reinsert", "restart"] as const;
export type Operator = (typeof OPERATORS)[number];

export interface OperatorStats {
  tries: number;
  accepted: number;
  improvements: number;
  /** Exponential moving average of improvements, which raises the operator's weight. */
  successRate: number;
}

/** Scores within this relative difference are a tie (float noise of the finishing). */
export const TIE = 1e-9;

/** Moves s's contents to target (s is a fresh state the caller no longer uses). */
export function assign(target: KernelState, s: KernelState): void {
  target.x = s.x;
  target.size = s.size;
  target.aux = s.aux;
}

/**
 * Metropolis rule: a strict improvement is accepted without a draw; otherwise, at a positive
 * temperature (score units), with probability exp(-(candidate - current) / temperature), ties
 * included. Nonfinite scores are rejected.
 */
export function metropolis(current: number, candidate: number, temperature: number, rng: Rng): boolean {
  if (!Number.isFinite(candidate) || !Number.isFinite(current)) return false;
  if (candidate < current) return true;
  if (!(temperature > 0)) return false;
  return rng() < Math.exp(-(candidate - current) / temperature);
}

/** Roulette over base * (floor + success rate); a zero base weight disables an operator, and all zero falls back to kick. */
export function chooseOperator(
  base: Record<Operator, number>,
  stats: Record<Operator, OperatorStats>,
  floor: number,
  rng: Rng,
): Operator {
  const effective = OPERATORS.map((o) => base[o] * (floor + stats[o].successRate));
  const total = effective.reduce((t, w) => t + w, 0);
  if (!(total > 0)) return "kick";
  let draw = rng() * total;
  for (let i = 0; i < OPERATORS.length; i++) {
    draw -= effective[i];
    if (draw < 0) return OPERATORS[i];
  }
  for (let i = OPERATORS.length - 1; i >= 0; i--) if (effective[i] > 0) return OPERATORS[i];
  return "kick";
}

/** Jiggles max(1, ceil(fraction P)) distinct pieces by up to `amount` steps in each variable. */
export function kick(k: SpaceKernel, s: KernelState, rng: Rng, amount: number, fraction: number): void {
  const count = Math.min(k.P, Math.max(1, Math.ceil(fraction * k.P)));
  for (const i of sample(rng, k.P, count)) k.jiggle(s, i, amount, rng);
}

/** Exchanges the orientations of two distinct random pieces (capability "swap"). */
export function swapPair(k: SpaceKernel, s: KernelState, rng: Rng): void {
  if (!k.swap || k.P < 2) return;
  const [i, j] = sample(rng, k.P, 2);
  k.swap(s, i, j);
}

/**
 * The piece to reinsert: drawn with probability proportional to its energy in a copy of s shrunk
 * by `squeeze` (so every contact becomes an overlap). That energy is what removing the piece
 * would take off the shrunk packing's energy, so the pieces most in the way of a smaller size are
 * the likeliest; drawing rather than taking the largest keeps one stuck piece from being picked
 * every time. Costs one energy sweep.
 */
export function stressedPiece(k: SpaceKernel, s: KernelState, rng: Rng, squeeze: number): number {
  const probe = k.clone(s);
  k.setSize(probe, s.size * (1 - squeeze));
  const e = new Float64Array(k.P);
  let total = 0;
  for (let i = 0; i < k.P; i++) total += e[i] = k.pieceEnergy(probe, i);
  if (!(total > 0)) return randomInt(rng, k.P);
  let draw = rng() * total;
  for (let i = 0; i < k.P; i++) {
    draw -= e[i];
    if (draw < 0) return i;
  }
  return k.P - 1;
}

/**
 * Re-places piece i at the best of `trials` uniformly random poses by its own energy against the
 * others at s's size: the deepest hole the samples find. Stops early at a pose with no overlap.
 * This is sampled free-space search, not a proof that no better hole exists.
 */
export function reinsert(k: SpaceKernel, s: KernelState, i: number, rng: Rng, trials: number): void {
  const scratch = k.clone(s);
  let best: KernelState | null = null;
  let bestEnergy = Infinity;
  for (let t = 0; t < trials; t++) {
    // randomPose replaces the piece's whole pose, so the scratch state needs no reset between samples
    k.randomPose(scratch, i, rng);
    const e = k.pieceEnergy(scratch, i);
    if (e < bestEnergy) {
      bestEnergy = e;
      best = k.clone(scratch);
      if (e === 0) break;
    }
  }
  if (best) assign(s, best);
}

/** True when a and b give the same configuration (an exchange of equal orientations, say). */
export function samePacking(k: SpaceKernel, a: KernelState, b: KernelState): boolean {
  return JSON.stringify(k.toConfig(a)) === JSON.stringify(k.toConfig(b));
}
