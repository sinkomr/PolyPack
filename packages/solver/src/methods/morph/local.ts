import { type PackingConfig } from "@polypack/geometry";
import type { MethodContext } from "../../framework";
import { lbfgs } from "../penalty/lbfgs";
import { createPenaltyObjective, packState, unpackState } from "../penalty/objective";
import { dilate, shapeClear, shapeContained, shapeEnclose, shapeSeparation, type MorphShape } from "./shapes";

export interface StageOutcome {
  config: PackingConfig;
  residual: number;
}
export type Submit = (config: PackingConfig) => Promise<boolean>;

export async function penaltyStage(
  ctx: MethodContext,
  config: PackingConfig,
  shape: MorphShape,
  slice: number,
  submit: Submit,
): Promise<StageOutcome> {
  let x = packState({ config, container: shapeEnclose(config, shape) });
  const multipliers = new Map<number, number>();
  const limit = ctx.remaining().evals - slice;
  let residual = Infinity;
  let weight = ctx.params.initialWeight as number;
  let previous = Infinity;
  const solved = new Set<string>();
  for (let outer = 0; outer < (ctx.params.outerIterations as number); outer++) {
    if (ctx.shouldStop() || ctx.remaining().evals <= limit || !(await ctx.checkpoint())) break;
    const key = JSON.stringify(x);
    if (solved.has(key)) break;
    solved.add(key);
    const objective = createPenaltyObjective(
      config,
      weight,
      multipliers,
      true,
      ctx.shouldStop,
      true,
      shape.scale,
      shape.padding,
    );
    // Cache repeated line-search states; no numerical objective work is repeated.
    const cache = new Map<string, ReturnType<typeof objective.evaluate>>();
    const evaluate = (variables: readonly number[]) => {
      const id = JSON.stringify(variables);
      const cached = cache.get(id);
      if (cached) return cached;
      const value = objective.evaluate(variables);
      cache.set(id, value);
      return value;
    };
    const result = await lbfgs(evaluate, x, {
      iterations: ctx.params.innerIterations as number,
      memory: 12,
      tolerance: 1e-7,
      shouldStop: () => ctx.shouldStop() || ctx.remaining().evals <= limit,
      checkpoint: ctx.checkpoint,
      onIteration: async (variables) => {
        config = unpackState(config, variables).config;
        return submit(config);
      },
    });
    x = result.x;
    config = unpackState(config, x).config;
    residual = objective.violation(x);
    if (result.status === "nonfinite" || result.status === "stopped") break;
    if (result.status === "stalled" && result.iterations === 0) break;
    objective.updateMultipliers(x);
    if (residual > previous * 0.5) weight *= 4;
    previous = residual;
  }
  return { config, residual };
}

/** Hard-particle MC compression on the current shape, with adaptive move sizes. */
export async function monteCarloStage(
  ctx: MethodContext,
  config: PackingConfig,
  shape: MorphShape,
  slice: number,
  submit: Submit,
): Promise<StageOutcome> {
  let container = shapeEnclose(config, shape);
  container.size *= 1.03;
  const limit = ctx.remaining().evals - slice;
  let step = ctx.params.translationStep as number;
  let angleStep = ctx.params.rotationStep as number;
  let jammed = 0;
  let stagnant = 0;
  let smallest = container.size;
  for (let sweep = 0; sweep < (ctx.params.mcSweeps as number); sweep++) {
    if (ctx.shouldStop() || ctx.remaining().evals <= limit || !(await ctx.checkpoint())) break;
    let accepted = 0;
    for (let move = 0; move < config.P; move++) {
      if (ctx.shouldStop() || (move % 8 === 0 && !(await ctx.checkpoint()))) return { config, residual: 0 };
      const i = Math.floor(ctx.random() * config.P);
      const p = config.pieces[i];
      const rotate = config.N !== 0 && ctx.random() < 0.5;
      const trial = rotate
        ? { ...p, theta: p.theta + angleStep * (2 * ctx.random() - 1) }
        : { ...p, x: p.x + step * (2 * ctx.random() - 1), y: p.y + step * (2 * ctx.random() - 1) };
      if (trial.x === p.x && trial.y === p.y && trial.theta === p.theta) continue;
      if (!shapeContained(config.N, trial, container, shape)) continue;
      let clear = true;
      for (let j = 0; j < config.P; j++) {
        if (ctx.shouldStop() || (j % 32 === 0 && !(await ctx.checkpoint()))) return { config, residual: 0 };
        if (i !== j && shapeSeparation(config.N, trial, config.pieces[j], shape) < 0) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;
      config.pieces[i] = trial;
      accepted++;
    }
    let changed = accepted > 0;
    if (sweep >= 5) {
      const contracted = dilate(config, 0.998);
      if (await shapeClear(contracted, shape, ctx.shouldStop, ctx.checkpoint)) {
        const tight = shapeEnclose(contracted, shape);
        if (tight.size < container.size) {
          config = contracted;
          container = tight;
          changed = true;
        }
      }
      const tight = shapeEnclose(config, shape);
      if (tight.size < container.size) container = tight;
    }
    if (changed && !(await submit(config))) break;
    jammed = changed ? 0 : jammed + 1;
    stagnant = container.size < smallest - 1e-8 ? 0 : stagnant + 1;
    smallest = Math.min(smallest, container.size);
    if (jammed >= 40 || stagnant >= 200) break;
    if (sweep % 10 === 9) {
      const gain = Math.exp(accepted / config.P - 0.3);
      step = Math.max(1e-7, Math.min(0.5, step * gain));
      angleStep = Math.max(1e-7, Math.min(0.5, angleStep * gain));
    }
  }
  return { config, residual: 0 };
}
