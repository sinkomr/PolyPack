/**
 * Shape continuation on any kernel with soft shapes (docs/methods/dimensions/morph.md), the port
 * of the polygon method `morph`.
 *
 * From a supplied arrangement, or a short start (one of the kernel's structured seeds when it has
 * them, otherwise a random start), a sequence of local problems is warmed from soft to true shape:
 * for each t of a rising schedule from t0 to 1, the arrangement from the previous t is carried to
 * the first contact of the new shape by a homothety and squeezed there (or, with
 * localMethod "relax", relaxed at the size it has). Each stage has a slice of what is left of the
 * budget, so a continuation always reaches t = 1. The arrangement at t = 1, repaired by the
 * squeeze's closing relaxation, is offered; soft stages are not.
 *
 * Further continuations start afresh from random starts until the budget ends or `restarts`
 * continuations are done; the framework keeps the best.
 */
import type { MethodContext, SpaceMethodDefinition } from "../framework";
import type { KernelState } from "../kernel";
import { relax, squeeze } from "../local";
import { energyCost, offerFirst, offerTrueShape, withAllowance } from "./harden-offers";
import { morphSchedule, toContact } from "./morph-stage";

/** Gradient evaluations per stage below which a new continuation is not started under an evaluation budget. */
const MIN_STAGE_GRADIENTS = 20;

const numeric = (
  title: string,
  description: string,
  value: number,
  minimum: number,
  maximum: number,
  integer = false,
) => ({ type: integer ? "integer" : "number", title, description, default: value, minimum, maximum }) as const;

export const morph: SpaceMethodDefinition = {
  name: "morph",
  title: "Shape continuation",
  summary:
    "Packs soft round versions of the pieces first, then sharpens them into their real shapes in small steps, re-packing after each step.",
  doc: "docs/methods/dimensions/morph.md",
  requires: ["shape"],
  defaults: {
    t0: 0,
    stages: 7,
    spacing: 1,
    adaptive: true,
    residualThreshold: 0.02,
    localMethod: "squeeze",
    innerIterations: 120,
    outerIterations: 6,
    initialWeight: 10,
    jitter: 0.03,
    restarts: 0,
  },
  schema: {
    type: "object",
    title: "Shape continuation",
    description:
      "Carry an arrangement of inscribed disks or balls toward the true shapes in stages, re-packing at each stage, and offer true shapes only.",
    additionalProperties: false,
    properties: {
      t0: {
        type: "number",
        title: "Starting shape",
        description:
          "Shape of the first stage: 0 is the inscribed disk or ball, values toward 1 start nearer the true shape.",
        default: 0,
        minimum: 0,
        exclusiveMaximum: 1,
      },
      stages: numeric(
        "Stages",
        "Number of base stages including t0 and t = 1; adaptive subdivision may add at most two stages per interval.",
        7,
        2,
        64,
        true,
      ),
      spacing: numeric("Schedule power", "Base schedule t = t0 + (1 - t0) (j / (stages - 1))^spacing.", 1, 0.25, 4),
      adaptive: {
        type: "boolean",
        title: "Adaptive schedule",
        description: "Halve the next shape step after a large residual, at most twice per base interval.",
        default: true,
      },
      residualThreshold: numeric(
        "Residual threshold",
        "Overlap left after a stage (the root of its energy, in the kernel's lengths) above which the next shape step is halved.",
        0.02,
        0,
        1,
      ),
      localMethod: {
        type: "string",
        title: "Local solve",
        description:
          "squeeze: at every stage, scale to first contact and squeeze the size with rising penalty weights. relax: squeeze at the first and last stages only; in between keep the size and relax the overlaps that hardening creates.",
        enum: ["squeeze", "relax"],
        default: "squeeze",
      },
      innerIterations: numeric(
        "Inner iterations",
        "L-BFGS iterations per penalty weight, and of a relaxation.",
        120,
        1,
        2000,
        true,
      ),
      outerIterations: numeric(
        "Penalty weights",
        "Number of penalty weights of a squeeze, rising tenfold from the initial weight.",
        6,
        1,
        30,
        true,
      ),
      initialWeight: numeric(
        "Initial penalty weight",
        "First weight of the energy against the size in a squeeze.",
        10,
        0.001,
        1e8,
      ),
      jitter: numeric(
        "Initial perturbation",
        "Seeded random move of every piece before a continuation, up to this many steps (about inradii) in each variable.",
        0.03,
        0,
        0.5,
      ),
      restarts: numeric(
        "Continuations",
        "Number of continuations; the first starts from the supplied arrangement, the others from fresh random starts. 0 runs continuations until the budget ends.",
        0,
        0,
        100000,
        true,
      ),
    },
  },
  run: (ctx) => runMorph(ctx),
};

export function runMorph(ctx: MethodContext): void {
  const k = ctx.kernel;
  const p = ctx.params;
  const restarts = p.restarts as number;
  const relaxing = p.localMethod === "relax";
  const maxIter = p.innerIterations as number;
  const mus = Array.from({ length: p.outerIterations as number }, (_, j) => (p.initialWeight as number) * 10 ** j);
  const threshold = p.residualThreshold as number;
  const jitter = p.jitter as number;
  const stages = p.stages as number;
  // soft pieces pack below the true shapes' bound, but not below half of it (see harden-dynamics.ts)
  const softFloor = k.bound !== null && k.bound > 0 ? k.bound / 2 : 0;
  const offer = k.finishCost + (k.validateCost ?? k.finishCost);
  const limited = Number.isFinite(ctx.remaining());

  for (let run = 0; restarts === 0 || run < restarts; run++) {
    // under an evaluation budget, a continuation starts only when its stages and offer fit
    if (run > 0 && limited && ctx.remaining() < offer + stages * MIN_STAGE_GRADIENTS * energyCost(k, true)) return;
    let s: KernelState;
    let structured = true;
    if (run === 0 && ctx.start) s = ctx.start;
    else if (run === 0 && k.seeds) s = k.seeds(ctx.rng, 1)[0] ?? k.randomStart(ctx.rng);
    else {
      s = k.randomStart(ctx.rng);
      structured = false;
    }
    // Before any long work, a first result that the space's finishing can take: the start when
    // it is supplied or structured, otherwise the start relaxed apart (harden-offers.ts).
    if (run === 0) offerFirst(ctx, structured ? [() => s] : [], () => s);
    if (jitter > 0) for (let i = 0; i < k.P; i++) k.jiggle(s, i, jitter, ctx.rng);

    const schedule = morphSchedule(p.t0 as number, stages, p.spacing as number);
    let previous = -1;
    let residual = 0;
    let subdivisions = 0;
    while (schedule.length) {
      let t = schedule.shift()!;
      // a large residual halves the next shape step, at most twice per base interval
      if (p.adaptive && residual > threshold && previous >= 0 && t > previous && subdivisions < 2) {
        schedule.unshift(t);
        t = (previous + t) / 2;
        subdivisions++;
      } else subdivisions = 0;
      k.setShape!(s, t);
      const first = previous < 0;
      // The stage's slice: what is left after the continuation's offer, shared with the stages
      // still to come (as the polygon method does), so that the last stage, t = 1, is reached.
      const slice = limited ? Math.max(0, Math.floor((ctx.remaining() - offer) / (schedule.length + 1))) : Infinity;
      // The first and last stages always squeeze; with "relax" the stages between keep the size.
      let energy: number;
      let cut: boolean;
      if (relaxing && !first && t !== 1) {
        const stage = withAllowance(k, slice);
        energy = relax(stage.kernel, s, { maxIter });
        cut = stage.exhausted();
      } else {
        // A quarter of the slice is kept for a closing relaxation: a squeeze cut short by its slice
        // stops at a low penalty weight with deep overlaps, which the space's finishing refuses.
        const stage = withAllowance(k, slice === Infinity ? Infinity : Math.floor(0.75 * slice));
        // The harder shape overlaps where the softer one touched: a homothety removes the overlap
        // and tightens to the new first contact before the squeeze. The start is squeezed as it
        // is: tightening a roomy random start to its first contact first gave worse packings.
        if (!first) toContact(stage.kernel, s);
        // The problem's bound holds for the true shapes; soft pieces may pack below it.
        energy = squeeze(stage.kernel, s, { mus, maxIter, minSize: t < 1 ? softFloor : undefined });
        cut = stage.exhausted();
        if (cut) {
          const rest = withAllowance(k, Math.max(0, slice - stage.spent()));
          energy = relax(rest.kernel, s, { maxIter });
        }
      }
      // a stage cut short by its slice says nothing about the shape step: no subdivision
      residual = cut ? 0 : Math.sqrt(energy);
      previous = t;
    }
    // the arrangement at t = 1, repaired by the squeeze's closing relaxation
    offerTrueShape(ctx, s);
  }
}
