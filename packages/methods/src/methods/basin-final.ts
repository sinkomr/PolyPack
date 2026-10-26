/**
 * The offer accounting and the final refinement that basin_hopping and shrink_repair share.
 *
 * An offer that improves the best costs the kernel's finishCost and its validateCost. With some
 * kernels that is thousands of evaluations (a polish, a careful check), so the methods plan their
 * offers with offerCost.
 *
 * The final refinement is a tight squeeze of a packing (penalty weights 1e5, 1e7, 1e9), offered.
 * It needs an evaluation budget: a time-only run has no known end. Its reserve is its squeeze,
 * estimated at 1.25 times the largest squeeze the run has made (the cap before any), at most the
 * cap, plus one offer. It runs only when that reserve fits in a quarter of the budget. It starts
 * before the step (a hop, a repair) that could cut into the reserve, a step being as dear as the
 * dearest so far or the largest squeeze, and its squeeze stops where the budget leaves just one
 * offer.
 */
import type { MethodContext } from "../framework";
import type { KernelState, SpaceKernel } from "../kernel";
import { type SqueezeOptions, squeeze } from "../local";

/** Evaluations of one offer that improves the best: the finish and the server's check. */
export function offerCost(k: SpaceKernel): number {
  return k.finishCost + (k.validateCost ?? k.finishCost);
}

/** The refinement's penalty weights: from a valid packing, so they start high and end high. */
const REFINEMENT_MUS = [1e5, 1e7, 1e9];
const REFINEMENT_ITER = 400;
/** The refinement's squeeze is estimated at this multiple of the largest squeeze of the run. */
const SQUEEZE_MARGIN = 1.25;
/** The refinement runs only when its reserve fits in this share of the evaluation budget. */
const BUDGET_SHARE = 1 / 4;

/** Thrown by squeezeWithin's guard; caught there. */
class Spent extends Error {}

/**
 * Squeezes s, stopping once the run has used `limit` evaluations; s is then where the squeeze got
 * to (a point it evaluated). The kernel's own Stop still ends the run.
 */
export function squeezeWithin(ctx: MethodContext, s: KernelState, limit: number, o: SqueezeOptions = {}): void {
  const k = ctx.kernel;
  const guard = () => {
    if (ctx.used() >= limit) throw new Spent();
  };
  const guarded: SpaceKernel = {
    ...k,
    energy: (q, g, w) => (guard(), k.energy(q, g, w)),
    pieceEnergy: (q, i, w) => (guard(), k.pieceEnergy(q, i, w)),
  };
  try {
    squeeze(guarded, s, o);
  } catch (e) {
    if (!(e instanceof Spent)) throw e;
  }
}

export class FinalRefinement {
  /** True once the refinement has run, and from the start when it never will (no evaluation budget, or a cap of 0). */
  done: boolean;
  private largestSqueeze = 0;
  private dearestStep = 0;
  private readonly limit: number;

  /** `cap`: the most evaluations the refinement's squeeze may take. */
  constructor(
    private readonly ctx: MethodContext,
    private readonly cap: number,
  ) {
    const budget = ctx.remaining();
    this.done = !(cap > 0) || !Number.isFinite(budget);
    this.limit = BUDGET_SHARE * budget;
  }

  /** A squeeze of the method's, whose cost the estimate of the refinement learns from. */
  squeeze(s: KernelState, o?: SqueezeOptions): void {
    const before = this.ctx.used();
    squeeze(this.ctx.kernel, s, o);
    this.largestSqueeze = Math.max(this.largestSqueeze, this.ctx.used() - before);
  }

  /** Records the cost of one step of the method. */
  step(cost: number): void {
    this.dearestStep = Math.max(this.dearestStep, cost);
  }

  /** The evaluations to keep for the refinement: its squeeze and one offer. */
  reserve(): number {
    const squeezeCost = this.largestSqueeze > 0 ? SQUEEZE_MARGIN * this.largestSqueeze : this.cap;
    return Math.min(this.cap, squeezeCost) + offerCost(this.ctx.kernel);
  }

  /** True while the refinement may still run: not done, and its reserve fits the budget's share. */
  possible(): boolean {
    return !this.done && this.reserve() <= this.limit;
  }

  /**
   * What the next step may cost: the dearest step so far, and at least the largest squeeze (a
   * step may squeeze, as the first polish of shrink_repair does). The start is not a step: it
   * squeezes every structured start once.
   */
  nextStep(): number {
    return Math.max(this.dearestStep, this.largestSqueeze);
  }

  /** True when the next step could cut into the reserve: time to refine. */
  due(): boolean {
    return this.possible() && this.ctx.remaining() <= this.reserve() + this.nextStep();
  }

  /**
   * The starts of basin_hopping's first solve: every candidate (the supplied start, the kernel's
   * structured starts) squeezed, smallest squeezed size first. Structured starts squeeze
   * to very different sizes (the four tetrahedra seeds of polyhedra/tetintet/6: 2.67, 3.00, 2.30
   * and 2.30), so all are squeezed but only the smallest is offered unless it does not finish.
   */
  squeezedStarts(candidates: readonly KernelState[], o?: SqueezeOptions): KernelState[] {
    for (const s of candidates) this.squeeze(s, o);
    return [...candidates].sort((a, b) => a.size - b.size);
  }

  /** The refinement: s squeezed tightly, leaving the budget one offer, and offered. Marks it done. */
  run(s: KernelState): number | null {
    this.done = true;
    // one evaluation of margin: the fractional charges of pieceEnergy drift in the last digits
    const room = this.ctx.remaining() - offerCost(this.ctx.kernel) - 1;
    if (room > 0) squeezeWithin(this.ctx, s, this.ctx.used() + room, { mus: REFINEMENT_MUS, maxIter: REFINEMENT_ITER });
    return this.ctx.offer(s);
  }
}
