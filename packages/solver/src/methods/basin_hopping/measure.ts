import { evaluate, pieceSeparation, type PackingConfig } from "@polypack/geometry";
import { MethodRegistry, type Problem, type SubRunResult } from "../../framework";
import { seedMethod } from "../seed";
import { penaltyMethod } from "../penalty";
import { basinHoppingMethod, executeBasinHopping, type BasinTrace } from "../basin_hopping";
import { samePacking } from "./operators";

/** Read-only instrumentation used to reproduce the documented measurements.
 * Timing comes from the framework; it never influences the search. */
export async function measureBasinRun(problem: Problem, budget: number, seed: number, params = {}) {
  const registry = new MethodRegistry();
  registry.register(seedMethod);
  registry.register(penaltyMethod);
  let trace: BasinTrace | undefined;
  const solves: (SubRunResult & { start?: PackingConfig })[] = [];
  registry.register({
    ...basinHoppingMethod,
    async execute(ctx) {
      trace = await executeBasinHopping({
        ...ctx,
        run: async (method, parameters, options) => {
          const result = await ctx.run(method, parameters, options);
          if (method === "penalty") solves.push({ ...result, start: options?.start });
          return result;
        },
      });
    },
  });
  const result = await registry.run(problem, { method: "basin_hopping", budget: { evals: budget }, seed, params });
  if (!result.best || result.score === null || !trace) throw new Error("Measurement has no result");
  const checked = evaluate(result.best, { autoOrient: true });
  if (!checked.valid || checked.score === null || Math.abs(checked.score - result.score) > 1e-12)
    throw new Error("Measurement disagrees with geometry");
  let minimumSeparation = Infinity;
  for (let i = 0; i < problem.P; i++) {
    for (let j = 0; j < i; j++)
      minimumSeparation = Math.min(
        minimumSeparation,
        pieceSeparation(problem.N, result.best.pieces[i], result.best.pieces[j]).sep,
      );
  }
  if (!result.strict || minimumSeparation < -1e-12 || result.evaluations > budget)
    throw new Error("Measurement violates strictness or budget");
  let noops = 0;
  let noopEvaluations = 0;
  let current = solves[0]?.found;
  trace.hops.forEach((hop, k) => {
    const solve = solves[k + 1];
    if (current && solve?.start && samePacking(current, solve.start)) {
      noops++;
      noopEvaluations += solve.evaluations;
    }
    if (hop.accepted) current = solve?.found;
  });
  return {
    ...problem,
    budget,
    seed,
    score: result.score,
    assessmentDifference: checked.score - result.score,
    valid: result.valid,
    strict: result.strict,
    evaluations: result.evaluations,
    wallTime: result.wallTime,
    minimumSeparation,
    hops: trace.hops.length,
    noops,
    noopEvaluations,
    redraws: trace.redraws,
    refinementEvaluations: trace.refinementEvaluations,
    operators: trace.operators,
  };
}
