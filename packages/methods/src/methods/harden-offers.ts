/**
 * Offers and bounded local solves shared by harden and morph (docs/methods/dimensions/harden.md,
 * morph.md): every offer is a true-shape state, the first offer comes from a state that the
 * space's finishing can take, and a local solve can be held to an allowance of evaluations.
 */
import type { MethodContext } from "../framework";
import type { KernelState, SpaceKernel } from "../kernel";
import { relax } from "../local";

/** Offers the true-shape version of s (a copy at t = 1); a soft state is never offered. */
export function offerTrueShape(ctx: MethodContext, s: KernelState): number | null {
  const k = ctx.kernel;
  const c = k.clone(s);
  k.setShape!(c, 1);
  return ctx.offer(c);
}

/** What one energy() call costs: gradCost with a gradient, 1 without. */
export const energyCost = (k: SpaceKernel, gradient: boolean) => (gradient ? (k.gradCost ?? 1) : 1);

/** A view of a kernel whose energy() refuses (returns Infinity) once `allowance` evaluations are spent. */
export interface Allowance {
  kernel: SpaceKernel;
  /** Evaluations spent through the view. */
  spent(): number;
  /** True once a call was refused. */
  exhausted(): boolean;
}

/**
 * Holds a local solve to an allowance. L-BFGS (lbfgs.ts) treats an Infinity as too long a step and
 * stops, and relax and squeeze then leave the state at their last accepted point; a refused call
 * costs nothing. So a solve that runs out of its allowance ends cleanly, where the run's Stop
 * would end the whole method.
 */
export function withAllowance(k: SpaceKernel, allowance: number): Allowance {
  let spent = 0;
  let refused = false;
  const kernel: SpaceKernel = {
    ...k,
    energy(s, grad, weights) {
      const cost = energyCost(k, !!grad);
      if (spent + cost > allowance) {
        refused = true;
        grad?.fill(0);
        return Infinity;
      }
      spent += cost;
      return k.energy(s, grad, weights);
    },
  };
  return { kernel, spent: () => spent, exhausted: () => refused };
}

/** L-BFGS iterations of the relaxation that makes a random start fit to be finished. */
const FIRST_RELAX_ITERATIONS = 100;
/** Relaxed random starts tried when no candidate finishes. */
const FIRST_RANDOM_TRIES = 2;

/**
 * The first offer, made before any long work so that a stop or a small budget still returns a
 * valid result, when nothing valid is held yet. Raw random starts rarely finish (their pieces
 * overlap deeply: none of ten on the boundary's balls or the surface's squares), so it tries, in
 * order: `candidates` (a supplied start, a structured seed), then up to two random starts relaxed
 * apart at their roomy size. It stops at the first that finishes. A space's finishing may still
 * refuse them all (curved/-1/3/4/6 refuses about a quarter of its relaxed random starts); then the
 * run has no result until a later offer finishes.
 */
export function offerFirst(
  ctx: MethodContext,
  candidates: (() => KernelState | undefined)[],
  random: () => KernelState,
): void {
  if (ctx.best() !== null) return;
  for (const make of candidates) {
    const s = make();
    if (s && offerTrueShape(ctx, s) !== null) return;
  }
  const k = ctx.kernel;
  for (let attempt = 0; attempt < FIRST_RANDOM_TRIES; attempt++) {
    const q = k.clone(attempt === 0 ? random() : k.randomStart(ctx.rng));
    k.setShape!(q, 1);
    relax(withAllowance(k, FIRST_RELAX_ITERATIONS * 1.5 * energyCost(k, true)).kernel, q, {
      maxIter: FIRST_RELAX_ITERATIONS,
    });
    if (ctx.offer(q) !== null) return;
  }
}
