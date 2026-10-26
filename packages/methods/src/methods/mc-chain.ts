/**
 * The hard-particle chain that mc_compress and asc share (docs/methods/dimensions/mc_compress.md
 * and asc.md).
 *
 * A chain state is hard when every piece is clear at tolerance 0 by the kernel's clear(). A trial
 * that leaves a piece not clear is never kept, so every state of the chain is hard. Hardness is the
 * kernel's model, not validity: the chain offers its states, and the framework's finish and
 * validate decide.
 *
 * Costs, with the counted kernel of a method context:
 *  - a single-piece trial is one clear(), 1/P of an evaluation, so a sweep of P trials costs one;
 *  - a collective trial checks every piece, at most one evaluation. It stops at the first piece
 *    that is not clear, and it starts from the piece that blocked the last collective trial,
 *    which a jammed packing tends to repeat;
 *  - an offer costs the kernel's finishCost, and its validateCost when it improves the best. Offers
 *    are spaced to take a set share of the evaluations (offerShare), and the last one that fits
 *    the budget is made in time.
 *
 * Undoing a trial: a jiggle changes only the piece's own variables (kernel.ts), so the chain keeps
 * a copy of those dim numbers and writes them back. Every other trial (a random re-placement, a size
 * or globals change, a collective move) works on a clone and is adopted when kept.
 */
import type { ParameterSchema } from "@polypack/solver/schema";
import type { MethodContext } from "../framework";
import type { KernelState, Rng, SpaceKernel } from "../kernel";
import { relax } from "../local";
import { randomInt } from "../random";

/** The smallest adapted step, as in the polygon methods. */
export const MIN_STEP = 1e-7;

/** A numeric parameter with its title, description, default and inclusive range. */
export function numeric(
  title: string,
  description: string,
  value: number,
  minimum: number,
  maximum: number,
  integer = false,
): ParameterSchema {
  return { type: integer ? "integer" : "number", title, description, default: value, minimum, maximum };
}

/** Copies every field of `from` into `to`, so a method keeps one state object; `from` is discarded after. */
export function adopt(to: KernelState, from: KernelState): void {
  to.x.set(from.x);
  to.size = from.size;
  to.aux = from.aux;
}

/** The size-energy Metropolis rule: a size no larger is kept, a larger one with probability exp(-increase / T). */
export function acceptSize(before: number, after: number, temperature: number, rng: Rng): boolean {
  return after <= before || (temperature > 0 && rng() < Math.exp(-(after - before) / temperature));
}

/** Multiplies a step by exp(gain * (rate - target)), kept in [MIN_STEP, maximum]; gain 0 leaves it as it is. */
export function adaptStep(step: number, rate: number, target: number, gain: number, maximum: number): number {
  if (gain === 0) return step;
  return Math.max(MIN_STEP, Math.min(maximum, step * Math.exp(gain * (rate - target))));
}

/** The first piece of s, from `first` on and cyclically, that is not clear at tolerance 0, or -1 when every piece is. */
export function blocker(k: SpaceKernel, s: KernelState, first = 0): number {
  for (let n = 0; n < k.P; n++) {
    const i = (first + n) % k.P;
    if (!k.clear(s, i, 0)) return i;
  }
  return -1;
}

/**
 * Moves one random global of s by a uniform random amount of up to `amount` of its globalSteps
 * entry. One at a time: at a jammed cell most directions of a joint move are blocked (on a square
 * torus lattice any change of the aspect shortens a lattice vector, while the shear is free).
 */
export function jiggleGlobals(k: SpaceKernel, s: KernelState, amount: number, rng: Rng): void {
  const g = randomInt(rng, k.globals);
  s.x[k.P * k.dim + g] += (2 * rng() - 1) * amount * k.globalSteps[g];
}

/** Moves every piece of s by the same random offset, of up to `amount` steps in each of a piece's variables. */
export function drift(k: SpaceKernel, s: KernelState, amount: number, rng: Rng): void {
  const offset = Array.from({ length: k.dim }, (_, d) => (2 * rng() - 1) * amount * k.steps[d]);
  for (let i = 0; i < k.P; i++) for (let d = 0; d < k.dim; d++) s.x[i * k.dim + d] += offset[d];
}

/**
 * The centres alone moved in by the factor f, the container staying: setSize, then the old size at
 * fixed variables. It is a move of its own only where the variables (or the anchors setSize moves)
 * are positions in the container's frame; see sizeMoves.
 */
export function scaleCentres(k: SpaceKernel, s: KernelState, f: number): void {
  const size = s.size;
  k.setSize(s, size * f);
  s.size = size;
}

/** Equal configurations, numbers to 1e-12 relative, in any JSON-like format. */
function sameConfig(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number")
    return a === b || Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => sameConfig(v, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return sameConfig(ka, kb) && ka.every((key) => sameConfig((a as never)[key], (b as never)[key]));
  }
  return a === b;
}

/**
 * The size moves a space has besides setSize, which moves the arrangement with the container:
 *  - centres: the centres alone (scaleCentres);
 *  - walls: the container alone, the size at fixed variables.
 * Tried once on a rebased copy of s, with toConfig only (no evaluations). In a space whose
 * variables are positions about the container's centre (the reference disks, polyhedra, curved)
 * both are moves of their own. Where setSize changes the size alone (torus, surface), or the
 * variables are offsets from anchors that follow the size (sphere, boundary), the centres move
 * changes nothing on a rebased state and the walls move is setSize; between rebases they would
 * only pull pieces towards their anchors, so the methods leave them out there.
 */
export function sizeMoves(k: SpaceKernel, s: KernelState): { centres: boolean; walls: boolean } {
  const base = k.clone(s);
  k.rebase(base);
  const f = 0.9;
  const whole = k.clone(base);
  k.setSize(whole, base.size * f);
  const walls = k.clone(base);
  walls.size = base.size * f;
  const centres = k.clone(base);
  scaleCentres(k, centres, f);
  return {
    centres: !sameConfig(k.toConfig(centres), k.toConfig(base)),
    walls: !sameConfig(k.toConfig(walls), k.toConfig(whole)),
  };
}

/**
 * Relaxes s at its size (local.ts) and then grows it with setSize, a little more each time, until
 * every piece is clear; false when that fails. A relaxed state often keeps overlaps of about 1e-10,
 * which the first growths of 1e-9, 1e-8, ... part.
 */
function separate(k: SpaceKernel, s: KernelState): boolean {
  relax(k, s, { maxIter: 300 });
  let grow = 1e-9;
  for (let t = 0; t < 16; t++) {
    if (blocker(k, s) < 0) return true;
    k.setSize(s, s.size * (1 + grow));
    grow = Math.min(10 * grow, 0.25);
    if (t % 4 === 3) relax(k, s, { maxIter: 300 });
  }
  return blocker(k, s) < 0;
}

/**
 * The chain's first state: the run's start as given when it is already hard; else that start
 * separated (relaxed, then grown until hard); else the kernel's random starts, separated the same
 * way. `given` says whether the start was used as given.
 */
export function hardStart(ctx: MethodContext): { state: KernelState; given: boolean } {
  const k = ctx.kernel;
  if (ctx.start && blocker(k, ctx.start) < 0) return { state: ctx.start, given: true };
  if (ctx.start && separate(k, ctx.start)) return { state: ctx.start, given: false };
  for (;;) {
    const s = k.randomStart(ctx.rng);
    if (separate(k, s)) return { state: s, given: false };
  }
}

/**
 * A hard state of the run, with the trials both methods use and the offers. The state object
 * stays the same for the whole run; kept trials are written into it.
 */
export class HardChain {
  readonly k: SpaceKernel;
  /** True when a kept trial changed the state since it was last offered. */
  changed: boolean;
  /** The run's best score, as the framework kept it after the last offer (Infinity while there is none). */
  best: number;
  private first = 0;
  private readonly saved: Float64Array;
  /** Evaluations used when the last offer ended, and what it cost. */
  private offerEnd = 0;
  private offerCost: number;
  /** Evaluations used when the last sweep ended, and the most a sweep has cost. */
  private sweepEnd: number;
  private sweepCost = 1;

  constructor(
    private readonly ctx: MethodContext,
    readonly s: KernelState,
    private readonly offerShare: number,
    changed: boolean,
  ) {
    this.k = ctx.kernel;
    this.changed = changed;
    this.best = ctx.best()?.score ?? Infinity;
    this.saved = new Float64Array(this.k.dim);
    this.offerCost = this.offerFits();
    this.offerEnd = this.sweepEnd = ctx.used();
  }

  /** What the framework asks to be left for an offer: a finish and the check of an improvement. */
  private offerFits(): number {
    return this.k.finishCost + (this.k.validateCost ?? this.k.finishCost);
  }

  /** True when some piece of t (default the chain's state) is not clear at tolerance 0. */
  blocked(t: KernelState = this.s): boolean {
    const i = blocker(this.k, t, this.first);
    if (i >= 0) this.first = i;
    return i >= 0;
  }

  /** Piece i jiggled by up to `amount` steps, kept when it is clear; whether it was kept. */
  jiggle(i: number, amount: number): boolean {
    this.save(i);
    this.k.jiggle(this.s, i, amount, this.ctx.rng);
    return this.keepOrRestore(i);
  }

  /**
   * Piece i re-placed at a random pose, kept when it is clear; whether it was kept. It works on a
   * clone: some kernels' randomPose sets a new anchor in aux (polyhedra, boundary), which writing
   * the piece's variables back would not undo.
   */
  jump(i: number): boolean {
    const t = this.k.clone(this.s);
    this.k.randomPose(t, i, this.ctx.rng);
    if (!this.k.clear(t, i, 0)) return false;
    adopt(this.s, t);
    return (this.changed = true);
  }

  private save(i: number): void {
    const o = i * this.k.dim;
    this.saved.set(this.s.x.subarray(o, o + this.k.dim));
  }

  private keepOrRestore(i: number): boolean {
    if (this.k.clear(this.s, i, 0)) return (this.changed = true);
    this.s.x.set(this.saved, i * this.k.dim);
    return false;
  }

  /**
   * A collective trial: `change` alters a clone of the state, which is kept when its size passes
   * the Metropolis rule at `temperature` (checked first: it costs nothing) and every piece is clear.
   */
  collective(change: (t: KernelState) => void, temperature: number): boolean {
    const t = this.k.clone(this.s);
    change(t);
    if (!(t.size > 0) || !acceptSize(this.s.size, t.size, temperature, this.ctx.rng) || this.blocked(t)) return false;
    adopt(this.s, t);
    return (this.changed = true);
  }

  /**
   * The state grown by the factor f about the container's centre, kept when every piece is clear.
   * Where the kernel's growth may itself open overlaps (kernel.growthMayOverlap: curved polygons),
   * the grown state is first separated by a relaxation and small further growths.
   */
  grow(f: number): boolean {
    const t = this.k.clone(this.s);
    this.k.setSize(t, t.size * f);
    if (this.blocked(t) && !(this.k.growthMayOverlap && separate(this.k, t))) return false;
    adopt(this.s, t);
    return (this.changed = true);
  }

  /**
   * Folds the charts into the anchors (kernel.rebase). The configuration does not change, but
   * rounding might leave a contact a hair inside; then the state stays as it was.
   */
  rebase(): void {
    const t = this.k.clone(this.s);
    this.k.rebase(t);
    if (t.x.every((v, j) => v === this.s.x[j])) return;
    if (!this.blocked(t)) adopt(this.s, t);
  }

  /**
   * Offers the state when a kept trial changed it since its last offer (the framework finishes it
   * and keeps it when it improves the best); returns whether it offered.
   */
  offer(): boolean {
    if (!this.changed) return false;
    const before = this.ctx.used();
    this.changed = false;
    // a clone, so a kernel whose finish works in place cannot disturb the chain
    if (this.ctx.offer(this.k.clone(this.s)) !== null) this.best = this.ctx.best()?.score ?? Infinity;
    this.offerEnd = this.ctx.used();
    this.offerCost = this.offerEnd - before;
    // a sweep's cost leaves out the offers made in it
    this.sweepEnd += this.offerCost;
    return true;
  }

  /**
   * The end of a sweep: offers the state when it is due. An offer is due when the chain has worked
   * (1 - offerShare) / offerShare times what the last offer cost since that offer ended, so offers
   * take offerShare of the evaluations; or when the budget left would not cover another offer
   * after two more sweeps of the costliest kind seen, so the chain's last state is offered while an
   * offer still fits (the framework refuses one that does not).
   */
  endSweep(): boolean {
    const used = this.ctx.used();
    this.sweepCost = Math.max(this.sweepCost, used - this.sweepEnd);
    this.sweepEnd = used;
    if (!this.changed) return false;
    const regular = used - this.offerEnd >= (this.offerCost * (1 - this.offerShare)) / this.offerShare;
    const last = this.ctx.remaining() < this.offerFits() + 2 * this.sweepCost;
    return (regular || last) && this.offer();
  }
}

/**
 * Progress for the stagnation rules: the chain's size has fallen by more than 1e-6 of itself since
 * the last mark, or the best has improved by more than 1e-9 of itself. Tiny shrinks of an almost
 * jammed chain therefore add up before they count.
 */
export class Progress {
  private size: number;
  private best: number;
  /** The sweep of the last progress. */
  sweep = 0;

  constructor(chain: HardChain) {
    this.size = chain.s.size;
    this.best = chain.best;
  }

  /** Marks progress at `sweep` when there was some since the last mark. */
  update(chain: HardChain, sweep: number): void {
    const size = chain.s.size;
    const best = chain.best;
    if (size < this.size * (1 - 1e-6)) {
      this.size = size;
      this.sweep = sweep;
    }
    if (best < this.best && (this.best === Infinity || this.best - best > 1e-9 * Math.max(1, this.best))) {
      this.best = best;
      this.sweep = sweep;
    }
  }

  /** Restarts the size mark at the chain's size (after a restart grew it). */
  reset(chain: HardChain, sweep: number): void {
    this.size = chain.s.size;
    this.sweep = sweep;
  }
}

/**
 * Bisection on a factor in [lo, 1]: the smallest at which `apply` keeps every piece of the
 * chain's state clear, or null when none below 1 does. Only checked factors are kept; where
 * clearness is not monotone in the factor it may stop short of the smallest.
 */
function bisect(chain: HardChain, lo: number, apply: (t: KernelState, f: number) => void, halvings: number) {
  const { k, s } = chain;
  let hi = 1;
  let best: KernelState | null = null;
  for (let n = 0; n < halvings && hi - lo > 1e-15; n++) {
    const mid = (lo + hi) / 2;
    const t = k.clone(s);
    apply(t, mid);
    if (chain.blocked(t)) lo = mid;
    else {
      hi = mid;
      best = t;
    }
  }
  return best;
}

/**
 * Shrinks a start as a whole, keeping its contact pattern (the polygon method's initial
 * contraction): by bisection, first the arrangement with the container (setSize), then, where the
 * space has them (sizeMoves), the centres alone and the container alone, each as far as every
 * piece stays clear. Writes the result into the chain's state; returns whether it changed.
 */
export function contract(chain: HardChain, moves: { centres: boolean; walls: boolean }, halvings = 30): boolean {
  const { k, s } = chain;
  const size = s.size;
  const lo = Math.min(1, Math.max(0, (k.bound ?? 0) / size));
  const stages: [number, (t: KernelState, f: number) => void][] = [[lo, (t, f) => k.setSize(t, t.size * f)]];
  if (moves.centres) stages.push([0, (t, f) => scaleCentres(k, t, f)]);
  if (moves.walls) stages.push([lo, (t, f) => (t.size *= f)]);
  let moved = false;
  for (const [from, apply] of stages) {
    // `from` is relative to the first size; the factor is relative to the current one
    const t = bisect(chain, Math.min(1, (from * size) / s.size), apply, halvings);
    if (t) {
      adopt(s, t);
      moved = chain.changed = true;
    }
  }
  return moved;
}
