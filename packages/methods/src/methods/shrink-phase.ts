/**
 * The repair phase of shrink_repair (shrink_repair.ts) on any kernel: remove the overlaps of a
 * state at its fixed size by relocating conflicting pieces to the best of sampled poses, relaxing
 * the whole state (local.ts relax), and guided-local-search weights that make the pieces of
 * persistent conflicts more expensive. Also the ruins of its exploration: a region of pieces
 * found from the energy alone, shifted, scattered or (where the space can) swapped.
 *
 * Everything goes through kernel calls; nothing here decides validity. A repair succeeds when the
 * kernel's energy model is (about) zero, and the caller then offers the state.
 */
import type { KernelState, Rng, SpaceKernel } from "../kernel";
import { relax } from "../local";
import { randomInt, sample } from "../random";
import { assign } from "./basin-operators";

/** Weighted energy at or below which a repair has succeeded (overlaps of about 1e-9 piece units). */
export const REPAIRED = 1e-18;
/** Jiggle of the near samples of a relocation, in steps; one in two uses a fifth of it. */
const NEAR_SPREAD = 0.5;
/** GLS weights are rescaled when one passes this; only their ratios matter. */
const WEIGHT_CEILING = 1e6;
/** The shrink of the probe that finds a region's neighbours (see region). */
const REGION_SQUEEZE = 0.25;
/** Jiggle of the pieces of a shifted region, in steps. */
const SHIFT = 1;

export interface RepairSettings {
  /** Uniformly random poses tried per relocated piece. */
  globalSamples: number;
  /** Poses near the piece's current and best-sampled poses tried per relocated piece. */
  localSamples: number;
  /** GLS multiplier of the deepest conflict; the shallowest gets 1 + (growth - 1) / 5. */
  weightGrowth: number;
  /** GLS decay of a former conflict's weight towards 1. */
  weightDecay: number;
  /** L-BFGS iterations of each relaxation. */
  descentIterations: number;
  /** Strikes of a failing repair. */
  strikes: number;
}

function shuffle(values: number[], rng: Rng): void {
  for (let i = values.length - 1; i > 0; i--) {
    const j = randomInt(rng, i + 1);
    [values[i], values[j]] = [values[j], values[i]];
  }
}

export class Repair {
  /** Guided-local-search weight of each piece (SpaceKernel.energy's weights), at least 1. */
  readonly weights: Float64Array;
  /** Repair iterations of the last run. */
  iterations = 0;

  constructor(
    private readonly k: SpaceKernel,
    private readonly settings: RepairSettings,
    private readonly rng: Rng,
  ) {
    this.weights = new Float64Array(k.P).fill(1);
  }

  /** Every weight back to 1, for a new container size. */
  resetWeights(): void {
    this.weights.fill(1);
  }

  /** Each piece's unweighted energy (one energy sweep). */
  private pieceEnergies(s: KernelState): Float64Array {
    const e = new Float64Array(this.k.P);
    for (let i = 0; i < this.k.P; i++) e[i] = this.k.pieceEnergy(s, i);
    return e;
  }

  /**
   * Relocates piece i: tries uniformly random poses and poses near its current one and near the
   * best so far, by its weighted energy against the others, and moves it to the best when that
   * is lower than where it is. Returns true when it moved.
   */
  relocate(s: KernelState, i: number): boolean {
    const { k, rng, weights, settings } = this;
    const here = k.pieceEnergy(s, i, weights);
    if (!(here > 0)) return false;
    let best: KernelState | null = null;
    let bestEnergy = here;
    const scratch = k.clone(s);
    for (let t = 0; t < settings.globalSamples && bestEnergy > 0; t++) {
      // randomPose replaces the piece's whole pose, so the scratch state needs no reset
      k.randomPose(scratch, i, rng);
      const e = k.pieceEnergy(scratch, i, weights);
      if (e < bestEnergy) {
        bestEnergy = e;
        best = k.clone(scratch);
      }
    }
    for (let t = 0; t < settings.localSamples && bestEnergy > 0; t++) {
      // near samples alternate between the current pose and the best found so far
      const near = k.clone(t % 2 === 0 || !best ? s : best);
      k.jiggle(near, i, NEAR_SPREAD * (rng() < 0.5 ? 1 : 0.2), rng);
      const e = k.pieceEnergy(near, i, weights);
      if (e < bestEnergy) {
        bestEnergy = e;
        best = near;
      }
    }
    if (!best) return false;
    assign(s, best);
    return true;
  }

  /**
   * Guided local search at a local minimum: the weight of every piece still in conflict is
   * multiplied by between 1 + (growth - 1) / 5 (shallowest) and growth (deepest), in proportion
   * to its depth (the root of its energy); the weights of former conflicts decay towards 1.
   */
  private updateWeights(e: Float64Array): void {
    const { weights } = this;
    const growth = this.settings.weightGrowth;
    const low = 1 + (growth - 1) / 5;
    let deepest = 0;
    for (const v of e) if (v > REPAIRED) deepest = Math.max(deepest, Math.sqrt(v));
    if (!(deepest > 0)) return;
    let ceiling = 0;
    for (let i = 0; i < weights.length; i++) {
      if (e[i] > REPAIRED) weights[i] *= low + ((growth - low) * Math.sqrt(e[i])) / deepest;
      else weights[i] = Math.max(1, weights[i] * this.settings.weightDecay);
      ceiling = Math.max(ceiling, weights[i]);
    }
    if (ceiling > WEIGHT_CEILING) {
      const f = 1 / Math.sqrt(ceiling);
      for (let i = 0; i < weights.length; i++) weights[i] = Math.max(1, weights[i] * f);
    }
  }

  /** Relaxes s with the weights; true when the weighted energy reached REPAIRED. */
  private descend(s: KernelState): boolean {
    return relax(this.k, s, { weights: this.weights, maxIter: this.settings.descentIterations }) <= REPAIRED;
  }

  /**
   * Repairs s in place at its size. It relaxes once; then each strike runs iterations (relocate
   * every conflicting piece in random order, relax, update the weights) until `patience` in a
   * row fail to lower the least total overlap of the repair by 0.1%, and ends by going back to
   * that least overlapping state, keeping the weights. After `strikes` strikes, or
   * 4 strikes patience iterations, the repair has failed. True when it succeeded.
   */
  run(s: KernelState, patience: number): boolean {
    const { k, rng } = this;
    const strikes = this.settings.strikes;
    this.iterations = 0;
    if (this.descend(s)) return true;
    let e = this.pieceEnergies(s);
    let least = e.reduce((t, v) => t + v, 0);
    let leastState = k.clone(s);
    const limit = 4 * strikes * patience;
    for (let strike = 0; strike < strikes && this.iterations < limit; strike++) {
      let still = 0;
      while (still < patience && this.iterations < limit) {
        this.iterations++;
        const order: number[] = [];
        for (let i = 0; i < k.P; i++) if (e[i] > REPAIRED) order.push(i);
        shuffle(order, rng);
        for (const i of order) this.relocate(s, i);
        if (this.descend(s)) return true;
        e = this.pieceEnergies(s);
        const total = e.reduce((t, v) => t + v, 0);
        if (total < least * (1 - 1e-3)) {
          least = total;
          leastState = k.clone(s);
          still = 0;
        } else still++;
        this.updateWeights(e);
      }
      assign(s, k.clone(leastState));
      // the next strike starts from the restored state (none after the last)
      if (strike + 1 < strikes) e = this.pieceEnergies(s);
    }
    return false;
  }
}

/**
 * A region of `count` pieces around a random one, found from the energy alone. In a copy of s
 * shrunk by REGION_SQUEEZE (25%: centre distances scale by 0.75), two pieces overlap when their
 * gap is below about a third of their contact distance (unit disks: centres closer than 2.67); with
 * weights 1 for piece c and 0 elsewhere, pieceEnergy(j) is half the pair term of j and c alone
 * (SpaceKernel.energy: a pair term is weighted by (w_c + w_j) / 2, a wall term by w_j), so it
 * names c's neighbours, deepest (closest) first. The region grows breadth first from the random
 * piece; when it runs out of neighbours it takes random pieces. About one energy sweep per piece
 * expanded.
 */
export function region(k: SpaceKernel, s: KernelState, count: number, rng: Rng): number[] {
  const P = k.P;
  const n = Math.min(P, Math.max(1, Math.round(count)));
  const probe = k.clone(s);
  k.setSize(probe, s.size * (1 - REGION_SQUEEZE));
  const chosen = [randomInt(rng, P)];
  const taken = new Uint8Array(P);
  taken[chosen[0]] = 1;
  const w = new Float64Array(P);
  for (let head = 0; head < chosen.length && chosen.length < n; head++) {
    const c = chosen[head];
    w.fill(0);
    w[c] = 1;
    const near: [number, number][] = [];
    for (let j = 0; j < P; j++) {
      if (taken[j]) continue;
      const v = k.pieceEnergy(probe, j, w);
      if (v > 0) near.push([j, v]);
    }
    near.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    for (const [j] of near) {
      if (chosen.length >= n) break;
      taken[j] = 1;
      chosen.push(j);
    }
  }
  if (chosen.length < n) {
    const rest = Array.from({ length: P }, (_, i) => i).filter((i) => !taken[i]);
    for (const r of sample(rng, rest.length, n - chosen.length)) chosen.push(rest[r]);
  }
  return chosen;
}

export type RuinKind = "shift" | "scatter" | "swap";

/**
 * Ruins the pieces given, in place: shifts each by up to SHIFT steps in every variable (the
 * region keeps its place but loses its contacts), scatters each to a uniformly random pose, or,
 * where the space can swap, exchanges the orientations of random pairs of them. The kind is drawn
 * uniformly from those available. The repair that follows re-places them.
 */
export function ruin(k: SpaceKernel, s: KernelState, pieces: readonly number[], rng: Rng): RuinKind {
  const kinds: RuinKind[] = k.swap && pieces.length >= 2 ? ["shift", "scatter", "swap"] : ["shift", "scatter"];
  const kind = kinds[randomInt(rng, kinds.length)];
  if (kind === "swap") {
    for (let t = 0; t < Math.max(1, Math.floor(pieces.length / 2)); t++) {
      const [a, b] = sample(rng, pieces.length, 2);
      k.swap!(s, pieces[a], pieces[b]);
    }
  } else
    for (const i of pieces) {
      if (kind === "shift") k.jiggle(s, i, SHIFT, rng);
      else k.randomPose(s, i, rng);
    }
  return kind;
}
