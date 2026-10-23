import { enclose, MAX_COORD } from "@polypack/geometry";
import type { MethodContext, MethodDefinition } from "@polypack/solver";
import { nextPenaltyWeight, penaltyMethod } from "../../../../../packages/solver/src/methods/penalty";
import { lbfgs } from "../../../../../packages/solver/src/methods/penalty/lbfgs";
import {
  createPenaltyObjective,
  packState,
  unpackState,
} from "../../../../../packages/solver/src/methods/penalty/objective";
import { restore, scatter } from "../../../../../packages/solver/src/methods/penalty/restoration";
import { CYCLE_TOLERANCE, SETTLE_PARAMS, SQUEEZE } from "./penalty-settings";

// penalty's definitions in an open run (worker side only: it imports the solver).
//
// - "penalty_squeeze" is the solver's penalty, copied, scoring every k-th accepted L-BFGS step
//   instead of every step. Until the solver has that setting (kernel request K1), the copy must
//   follow packages/solver/src/methods/penalty.ts: tighter-penalty.test.ts checks that at k = 1 it
//   is the solver's penalty to the bit.
// - "penalty" keeps the solver's name, which the server records (packages/geometry/src/provenance.ts).
//   At its defaults it is the solver's own penalty, so basin_hopping's ctx.run("penalty", …) solves
//   stay the solver's. With settleEvals > 0 (the game's presets) a run alternates a squeeze with a
//   settle, 1,000 evaluations of mc_compress, until a cycle gains less than cycleTolerance.

type Schema = MethodDefinition["schema"];
const SOLVER_PROPERTIES = penaltyMethod.schema.properties!;

const INTERVAL: Schema = {
  type: "integer",
  minimum: 1,
  maximum: 1000,
  default: 1,
  title: "Evaluation interval",
  description:
    "Score the restored iterate after every k-th accepted L-BFGS step, and at a solve's end when that step was not scored, instead of after every step. 1 is the solver's penalty.",
};

/** The squeeze: the solver's penalty scoring every k-th accepted step. */
export const squeezeMethod: MethodDefinition = {
  name: SQUEEZE,
  doc: `docs/methods/${SQUEEZE}.md`,
  defaults: { ...penaltyMethod.defaults, evaluationInterval: 1 },
  schema: {
    ...penaltyMethod.schema,
    title: "Penalty squeeze",
    properties: { ...SOLVER_PROPERTIES, evaluationInterval: INTERVAL },
  },
  // A copy of penaltyMethod.execute with two changes, each marked "squeeze:".
  async execute(ctx) {
    if (!(await ctx.checkpoint())) return;
    let initial = ctx.start?.pieces.length === ctx.problem.P ? ctx.start : undefined;
    if (!initial && ctx.params.start === "seed") {
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
        // as the solver's penalty: a context that remains active can recover with scatter
      }
    }
    initial ??= scatter(ctx.problem, ctx.random);
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
    const k = ctx.params.evaluationInterval as number;
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
        // squeeze: only every k-th accepted step is repaired and scored
        onIteration: (v, it) => ((it + 1) % k === 0 ? submit(v) : Promise.resolve(!ctx.shouldStop())),
      });
      if (result.status === "nonfinite" || result.status === "stopped") return;
      x = result.x;
      // squeeze: the solve's last iterate was just scored when its step was a k-th one (the solver,
      // at k = 1, scores it twice)
      if (!(k > 1 && result.iterations % k === 0) && !(await submit(x))) return;
      const violation = objective.violation(x);
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

/** The squeeze's parameters, from a game penalty run's: every key the squeeze knows. */
function squeezeParams(params: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(squeezeMethod.schema.properties!);
  return Object.fromEntries(Object.entries(params).filter(([key]) => keys.includes(key)));
}

/**
 * Squeeze and settle: a squeeze, then a settle of `settleEvals` evaluations of mc_compress, each a
 * sub-run from the run's best, until a squeeze and its settle shrink the run's best by less than
 * cycleTolerance (relative), or the budget ends the run.
 */
async function cycle(ctx: MethodContext): Promise<void> {
  const tolerance = ctx.params.cycleTolerance as number;
  const settleEvals = ctx.params.settleEvals as number;
  const squeeze = squeezeParams(ctx.params);
  let before = ctx.initialEvaluation?.valid ? ctx.initialEvaluation.score : null;
  for (;;) {
    if (!(await ctx.checkpoint())) return;
    await ctx.run(SQUEEZE, squeeze);
    if (!(await ctx.checkpoint())) return;
    const settled = await ctx.run("mc_compress", { ...SETTLE_PARAMS }, { evals: settleEvals });
    const after = settled.score;
    if (before === null || after === null || !(after < before * (1 - tolerance))) return;
    before = after;
  }
}

/** penalty as the game registers it: the solver's at its defaults, the squeeze and settle with the game's presets. */
export const gamePenaltyMethod: MethodDefinition = {
  name: "penalty",
  doc: penaltyMethod.doc,
  defaults: { ...penaltyMethod.defaults, evaluationInterval: 1, settleEvals: 0, cycleTolerance: CYCLE_TOLERANCE },
  schema: {
    ...penaltyMethod.schema,
    properties: {
      ...SOLVER_PROPERTIES,
      evaluationInterval: INTERVAL,
      settleEvals: {
        type: "integer",
        minimum: 0,
        maximum: 100000,
        default: 0,
        title: "Settle evaluations",
        description:
          "0: one penalty solve sequence. Otherwise alternate a squeeze with this many evaluations of mc_compress, each from the run's best, until a squeeze and its settle gain less than cycleTolerance.",
      },
      cycleTolerance: {
        type: "number",
        minimum: 1e-12,
        maximum: 1e-2,
        default: CYCLE_TOLERANCE,
        title: "Cycle tolerance",
        description:
          "With settles, the run ends when a squeeze and its settle shrink the best score by less than this fraction.",
      },
    },
  },
  execute(ctx) {
    if ((ctx.params.settleEvals as number) > 0) return cycle(ctx);
    // the solver's own penalty, bit for bit: basin_hopping's solves and any run at the defaults
    if ((ctx.params.evaluationInterval as number) === 1) return penaltyMethod.execute(ctx);
    return squeezeMethod.execute(ctx);
  },
};

/**
 * penalty's definitions in an open run: the game's penalty under the solver's name, and the squeeze
 * its runs call as a sub-run.
 */
export const penaltyDefinitions: readonly MethodDefinition[] = [gamePenaltyMethod, squeezeMethod];
