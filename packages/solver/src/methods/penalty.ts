import { enclose, MAX_COORD } from "@polypack/geometry";
import type { MethodDefinition } from "../framework";
import { lbfgs } from "./penalty/lbfgs";
import { createPenaltyObjective, packState, unpackState } from "./penalty/objective";
import { restore, scatter } from "./penalty/restoration";

export const penaltyMethod: MethodDefinition = {
  name: "penalty",
  doc: "docs/methods/penalty.md",
  defaults: {
    start: "seed",
    schedule: "augmented",
    initialWeight: 10,
    growthFactor: 4,
    outerIterations: 10,
    innerIterations: 200,
    memory: 12,
    gradientTolerance: 1e-7,
    restoration: "separate",
    jitter: 1e-5,
    violationReduction: 0.5,
  },
  schema: {
    type: "object",
    title: "Penalty / augmented Lagrangian",
    description:
      "Minimise container size using analytic penetration gradients and L-BFGS, restoring valid candidates for final contact polish.",
    additionalProperties: false,
    properties: {
      start: {
        type: "string",
        enum: ["seed", "scatter"],
        default: "seed",
        title: "Initial arrangement",
        description:
          "Without a complete supplied start, use the best automatic seed within 24 shared assessments, or the random scatter baseline. Seed runs without a valid result fall back to scatter.",
      },
      schedule: {
        type: "string",
        enum: ["quadratic", "augmented"],
        default: "augmented",
        title: "Penalty schedule",
        description:
          "Quadratic raises the squared-violation weight; augmented also updates nonnegative inequality multipliers.",
      },
      initialWeight: {
        type: "number",
        exclusiveMinimum: 0,
        default: 10,
        title: "Initial weight",
        description: "Initial coefficient of squared penetration and protrusion in piece units.",
      },
      growthFactor: {
        type: "number",
        minimum: 1,
        maximum: 100,
        default: 4,
        title: "Weight growth",
        description:
          "Weight multiplier: every quadratic outer solve, or only when augmented constraint violation fails to decrease enough.",
      },
      outerIterations: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        default: 10,
        title: "Outer iterations",
        description: "Maximum number of weight and multiplier updates.",
      },
      innerIterations: {
        type: "integer",
        minimum: 1,
        maximum: 10000,
        default: 200,
        title: "Inner iterations",
        description: "Maximum L-BFGS iterations at each weight; every accepted step submits a restored candidate.",
      },
      memory: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        default: 12,
        title: "L-BFGS memory",
        description: "Number of curvature pairs retained in the inverse-Hessian approximation.",
      },
      gradientTolerance: {
        type: "number",
        exclusiveMinimum: 0,
        default: 1e-7,
        title: "Gradient tolerance",
        description: "Stop an inner solve when the infinity norm of its gradient reaches this threshold.",
      },
      jitter: {
        type: "number",
        minimum: 0,
        maximum: 1,
        default: 1e-5,
        title: "Initial symmetry breaking",
        description:
          "Seeded position and angle perturbation before the first inner solve, in piece units/radians. Zero disables it; the unperturbed start remains the valid fallback.",
      },
      violationReduction: {
        type: "number",
        exclusiveMinimum: 0,
        exclusiveMaximum: 1,
        default: 0.5,
        title: "Augmented violation reduction",
        description:
          "Keep the augmented weight when maximum positive constraint violation is at most this fraction of its previous value; otherwise increase it.",
      },
      restoration: {
        type: "string",
        enum: ["separate", "expand"],
        default: "separate",
        title: "Feasibility restoration",
        description:
          "Separate uses small pairwise moves, then uniform expansion if necessary; expand uses uniform centre expansion directly.",
      },
    },
  },
  async execute(ctx) {
    if (!(await ctx.checkpoint())) return;
    let initial = ctx.start?.pieces.length === ctx.problem.P ? ctx.start : undefined;
    if (!initial && ctx.params.start === "seed") {
      // The context exposes no remaining budget. A fixed assessment cap keeps
      // evaluations-only runs deterministic; the framework clips parent limits.
      try {
        const seeded = await ctx.run("seed", { kind: "auto" }, { evals: 24 });
        if (
          seeded.valid &&
          seeded.best?.N === ctx.problem.N &&
          seeded.best.M === ctx.problem.M &&
          seeded.best.P === ctx.problem.P &&
          seeded.best.pieces.length === ctx.problem.P
        )
          initial = seeded.best;
      } catch {
        // A context that remains active can recover with scatter. The standard
        // framework propagates child exceptions and stops the parent instead.
      }
    }
    initial ??= scatter(ctx.problem, ctx.random);
    // Subtract an anchored centroid before geometry and optimization so large
    // absolute coordinates do not affect line searches or symmetry breaking.
    const anchor = initial.pieces[0];
    const cx = anchor.x + initial.pieces.reduce((sum, p) => sum + (p.x - anchor.x), 0) / initial.P;
    const cy = anchor.y + initial.pieces.reduce((sum, p) => sum + (p.y - anchor.y), 0) / initial.P;
    const translate = (config: typeof initial, dx: number, dy: number) => ({
      ...config,
      pieces: config.pieces.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })),
    });
    let config = { ...translate(initial, -cx, -cy), container_phi: 0 };
    let assessment = ctx.start === initial ? ctx.initialEvaluation : undefined;
    if (!assessment?.valid) {
      const repaired = restore(
        config,
        ctx.params.restoration as "separate" | "expand",
        ctx.shouldStop,
        ctx.random,
        2 * MAX_COORD,
      );
      config = repaired ?? scatter(ctx.problem, ctx.random);
      assessment = await ctx.evaluate(translate(config, cx, cy), { autoOrient: false });
    }
    if (!assessment?.valid || !assessment.container || ctx.shouldStop()) return;
    // Recompute only the initial enclosure in the local frame. The mandatory
    // framework assessment remains the scored fallback. Initialize phi to zero
    // because ctx.start stores the framework's auto-angle; far-coordinate LP/MEC
    // rounding in that angle must not become an optimizer input.
    let x = packState({ config, container: enclose(config.N, config.pieces, config.M, config.container_phi) });
    const template = config;
    const jitter = ctx.params.jitter as number;
    if (jitter > 0) {
      const stride = config.N === 0 ? 2 : 3;
      for (let i = 0; i < stride * config.P; i++) x[i] += jitter * (2 * ctx.random() - 1);
    }
    const augmented = ctx.params.schedule === "augmented";
    const multipliers = new Map<number, number>();
    let weight = ctx.params.initialWeight as number;
    let previousViolation = Infinity;
    const submit = async (variables: readonly number[]): Promise<boolean> => {
      if (ctx.shouldStop()) return false;
      const trial = unpackState(template, variables).config;
      const valid = restore(
        trial,
        ctx.params.restoration as "separate" | "expand",
        ctx.shouldStop,
        ctx.random,
        2 * MAX_COORD,
      );
      if (!valid) return !ctx.shouldStop();
      return (await ctx.evaluate(translate(valid, cx, cy), { autoOrient: false })) !== undefined;
    };
    for (let outer = 0; outer < (ctx.params.outerIterations as number); outer++) {
      if (ctx.shouldStop() || !(await ctx.checkpoint())) return;
      if (!Number.isFinite(weight)) return;
      const objective = createPenaltyObjective(template, weight, multipliers, augmented, ctx.shouldStop, true);
      const initialValue = objective.evaluate(x).value;
      const result = await lbfgs(objective.evaluate, x, {
        iterations: ctx.params.innerIterations as number,
        memory: ctx.params.memory as number,
        tolerance: ctx.params.gradientTolerance as number,
        shouldStop: ctx.shouldStop,
        checkpoint: ctx.checkpoint,
        onIteration: submit,
      });
      if (result.status === "nonfinite" || result.status === "stopped") return;
      x = result.x;
      if (!(await submit(x))) return;
      const violation = objective.violation(x);
      // A stalled inner solve without significant progress must not turn
      // unresolved residuals into larger multipliers. Require convergence or significant objective decrease.
      if (result.status === "converged" || initialValue - result.value > 1e-12 * Math.max(1, Math.abs(initialValue)))
        objective.updateMultipliers(x);
      weight = nextPenaltyWeight(
        weight,
        ctx.params.growthFactor as number,
        augmented,
        violation,
        previousViolation,
        ctx.params.violationReduction as number,
      );
      previousViolation = violation;
    }
  },
};

/** Practical AL continuation: hold the weight while primal feasibility improves. */
export function nextPenaltyWeight(
  weight: number,
  growth: number,
  augmented: boolean,
  violation: number,
  previousViolation: number,
  reduction = 0.5,
): number {
  return !augmented || violation > reduction * previousViolation ? weight * growth : weight;
}
