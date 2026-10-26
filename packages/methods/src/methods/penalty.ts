/**
 * penalty: the local optimiser of the generic methods (docs/methods/dimensions/penalty.md). The
 * size and every variable are minimised together under a penalty on overlaps whose weight rises
 * (penalty-schedule.ts), from the given start, then from seeds or random starts while the budget
 * lasts. The first descent takes at most half of the budget, so a short run still ends with a
 * result. A start whose finish fails is restored (relaxed, then grown) and offered again; a new
 * best is polished with heavier weights and offered once more, until a polish gains nothing.
 */
import type { MethodContext, SpaceMethodDefinition } from "../framework";
import type { KernelState } from "../kernel";
import { relax, squeeze } from "../local";
import { descend, type ScheduleOptions } from "./penalty-schedule";
import { StartStream, fitIterations } from "./seed-starts";

/** Seeds asked of the kernel at once. */
const SEED_BATCH = 8;
/** The weights of the polish: past the schedule's, so the residual overlaps shrink to about 1e-9. */
const POLISH_WEIGHTS = [1e6, 1e7, 1e8, 1e9];
/** Expansion steps of a restoration: the size grows by 1%, 2%, 4%, ... up to 128%. */
const EXPANSIONS = 8;

interface PenaltyParams extends ScheduleOptions {
  seedShare: number;
  jitter: number;
  restoration: "relax" | "expand";
  starts: number;
  polish: boolean;
}

/**
 * A start whose finish failed: relaxed at its size (restoration "relax"), then grown step by step
 * keeping the normalized arrangement, which moves the pieces apart, until a finish succeeds.
 */
function restore(ctx: MethodContext, s: KernelState, p: PenaltyParams): number | null {
  const k = ctx.kernel;
  const relaxing = p.restoration === "relax";
  const maxIter = () => fitIterations(ctx, p.innerIterations, 1, false);
  if (relaxing) {
    relax(k, s, { maxIter: maxIter() });
    const r = ctx.offer(s);
    if (r !== null) return r;
  }
  for (let t = 0, grow = 0.01; t < EXPANSIONS; t++, grow *= 2) {
    const q = k.clone(s);
    k.setSize(q, s.size * (1 + grow));
    if (relaxing) relax(k, q, { maxIter: maxIter() });
    const r = ctx.offer(q);
    if (r !== null) return r;
  }
  return null;
}

function run(ctx: MethodContext): void {
  const p = ctx.params as unknown as PenaltyParams;
  const k = ctx.kernel;
  const starts = new StartStream(ctx, p.seedShare, SEED_BATCH, p.jitter);
  let polishing = p.polish;
  for (let n = 0; p.starts === 0 || n < p.starts; n++) {
    const s = n === 0 && ctx.start ? starts.given(ctx.start) : starts.next();
    const before = ctx.best()?.score ?? Infinity;
    const first = before === Infinity;
    descend(k, s, { ...p, innerIterations: fitIterations(ctx, p.innerIterations, p.outerIterations + 1, first) });
    const score = ctx.offer(s) ?? restore(ctx, s, p);
    if (polishing && score !== null && score < before) {
      squeeze(k, s, {
        mus: POLISH_WEIGHTS,
        maxIter: fitIterations(ctx, p.innerIterations, POLISH_WEIGHTS.length + 1, false),
      });
      const polished = ctx.offer(s);
      // where the space's finish polishes already, a polish gains nothing: it is not tried again
      if (!(polished !== null && polished < score * (1 - 1e-12))) polishing = false;
    }
  }
}

export const penalty: SpaceMethodDefinition = {
  name: "penalty",
  title: "Penalty",
  summary:
    "Squeezes the packing tighter while overlapping pieces push apart, restarts from fresh layouts, and keeps the tightest valid result.",
  doc: "docs/methods/dimensions/penalty.md",
  requires: [],
  defaults: {
    seedShare: 0.5,
    schedule: "quadratic",
    initialWeight: 10,
    growthFactor: 10,
    outerIterations: 4,
    innerIterations: 500,
    violationReduction: 0.5,
    jitter: 0.1,
    restoration: "relax",
    starts: 0,
    polish: true,
  },
  schema: {
    type: "object",
    title: "Penalty",
    description:
      "Minimise the size and every variable together under a rising overlap penalty, from many starts; restore starts that do not finish and polish every new best.",
    additionalProperties: false,
    properties: {
      seedShare: {
        type: "number",
        minimum: 0,
        maximum: 1,
        default: 0.5,
        title: "Seed share",
        description:
          "Fraction of the starts taken from the space's structured seeds, where it has them; the rest are random. A given start always comes first.",
      },
      schedule: {
        type: "string",
        enum: ["quadratic", "augmented"],
        default: "quadratic",
        title: "Penalty schedule",
        description:
          "Quadratic multiplies the overlap weight at every solve; augmented holds it while overlaps shrink fast enough and raises the weights of the pieces that lag.",
      },
      initialWeight: {
        type: "number",
        exclusiveMinimum: 0,
        default: 10,
        title: "Initial weight",
        description: "The first weight of the squared overlaps, in piece units.",
      },
      growthFactor: {
        type: "number",
        minimum: 1,
        maximum: 100,
        default: 10,
        title: "Weight growth",
        description:
          "Weight multiplier: after every quadratic solve, or when an augmented solve leaves too much overlap.",
      },
      outerIterations: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        default: 4,
        title: "Outer iterations",
        description: "Solves per start, each at one weight; the polish of a new best adds the weights 1e6 to 1e9.",
      },
      innerIterations: {
        type: "integer",
        minimum: 1,
        maximum: 10000,
        default: 500,
        title: "Inner iterations",
        description: "L-BFGS iterations per solve, and per relaxation.",
      },
      violationReduction: {
        type: "number",
        exclusiveMinimum: 0,
        exclusiveMaximum: 1,
        default: 0.5,
        title: "Augmented overlap reduction",
        description:
          "Augmented schedule: hold the weight while the largest overlap falls to this fraction of the last; pieces above the target get heavier.",
      },
      jitter: {
        type: "number",
        minimum: 0,
        maximum: 1,
        default: 0.1,
        title: "Symmetry breaking",
        description:
          "Seeded move of every structured start, in piece steps; a given start moves 1e-4 of it, random starts not at all; 0 disables it.",
      },
      restoration: {
        type: "string",
        enum: ["relax", "expand"],
        default: "relax",
        title: "Restoration",
        description:
          "When a finish fails: relax at the size, then grow the size step by step relaxing each time; or grow it without relaxing.",
      },
      starts: {
        type: "integer",
        minimum: 0,
        maximum: 1000000,
        default: 0,
        title: "Starts",
        description: "Starts to descend from, the given start first; 0 restarts while the budget lasts.",
      },
      polish: {
        type: "boolean",
        default: true,
        title: "Polish the best",
        description: "Squeeze every new best again with weights up to 1e9 and offer it once more.",
      },
    },
  },
  run,
};
