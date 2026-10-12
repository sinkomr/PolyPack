import {
  findOverlaps,
  MAX_COORD,
  visitContainerProtrusions,
  type Container,
  type PackingConfig,
  type Pose,
} from "@polypack/geometry";
import type { MethodContext, MethodDefinition } from "../framework";
import type { ParameterSchema } from "../schema";
import { scatter, restore } from "./penalty/restoration";
import { strictEnclose } from "./mc_compress/state";
import { GrowthDynamics, type Advance } from "./ls_growth/dynamics";

function numeric(
  title: string,
  description: string,
  value: number,
  minimum: number,
  maximum: number,
  integer = false,
): ParameterSchema {
  return { type: integer ? "integer" : "number", title, description, default: value, minimum, maximum };
}

export const lsGrowthMethod: MethodDefinition = {
  name: "ls_growth",
  doc: "docs/methods/ls_growth.md",
  defaults: {
    initialization: "random",
    growthRate: 0.01,
    initialSpeed: 1,
    angularSpeed: 0.3,
    initialShrink: 0.2,
    restartShrink: 0.05,
    runs: 4,
    jamThreshold: 1e-8,
    jamWindow: 32,
    energyFactor: 4,
    evaluationInterval: 16,
    stagnationEvaluations: 128,
    maxStep: 0.02,
    seedEvals: 8,
  },
  schema: {
    type: "object",
    title: "Lubachevsky–Stillinger style growth",
    description:
      "Ballistic growing discs with exact collision events, or approximate rotating polygon dynamics, in a fixed container.",
    additionalProperties: false,
    properties: {
      initialization: {
        type: "string",
        title: "Initial arrangement",
        description:
          "Random sequential loose placement is classical; seed requests a small automatic generator slice. Supplied starts take precedence.",
        enum: ["random", "seed"],
        default: "random",
      },
      growthRate: numeric(
        "Growth rate",
        "Constant side/radius increase per simulation time. Slow growth permits more rearrangement; fast growth generally jams sooner.",
        0.01,
        1e-6,
        1,
      ),
      initialSpeed: numeric(
        "Initial speed",
        "Each fresh velocity has this translational magnitude in simulation length/time units.",
        1,
        1e-4,
        100,
      ),
      angularSpeed: numeric(
        "Angular speed",
        "Uniform angular velocity half-width in radians/time for polygons; discs ignore it.",
        0.3,
        0,
        10,
      ),
      initialShrink: numeric(
        "Initial piece shrink",
        "Fraction of unit piece size removed initially, with centres and container fixed, to create free room.",
        0.2,
        0.001,
        0.9,
      ),
      restartShrink: numeric(
        "Restart decompression",
        "Fraction removed from piece sizes when restarting the current best with fresh velocities.",
        0.05,
        0.001,
        0.5,
      ),
      runs: numeric(
        "Independent velocity runs",
        "Maximum growth runs; each restart uses the current best and independent seeded velocities.",
        4,
        1,
        100,
        true,
      ),
      jamThreshold: numeric(
        "Jamming threshold",
        "Fractional growth per collision below this for jamWindow successive collisions ends a run.",
        1e-8,
        1e-14,
        0.01,
      ),
      jamWindow: numeric(
        "Jamming collision count",
        "Consecutive tiny-growth collisions required before declaring jam; prevents one simultaneous contact from ending a run.",
        32,
        2,
        10000,
        true,
      ),
      energyFactor: numeric(
        "Kinetic energy reset factor",
        "When translational energy exceeds this multiple of its initial value, scale velocities back to initial energy.",
        4,
        1.01,
        100,
      ),
      evaluationInterval: numeric(
        "Events/steps per assessment",
        "Rescale to unit pieces and assess every this many queue operations or polygon steps, and at jamming.",
        16,
        1,
        10000,
        true,
      ),
      stagnationEvaluations: numeric(
        "Stagnation assessments",
        "End a run after this many assessments without a meaningful improvement in its best score.",
        128,
        2,
        10000,
        true,
      ),
      maxStep: numeric(
        "Maximum polygon time step",
        "Upper time-step bound; reduced with translational, angular and growth speeds, then backed up by bisection at contacts.",
        0.02,
        1e-5,
        0.1,
      ),
      seedEvals: numeric(
        "Seed evaluation slice",
        "Maximum automatic-generator slice, at least three evaluations when available; ignored for random placement.",
        8,
        3,
        256,
        true,
      ),
    },
  },
  execute: executeGrowth,
};

/**
 * Scanning work between cooperative checkpoints, in weighted piece visits (roughly one or two
 * milliseconds). Counting work instead of reading a clock keeps the checkpoints of a seeded
 * run reproducible; a checkpoint draws no random number and assesses nothing.
 */
const CHECKPOINT_WORK = 2048;

/** Random sequential addition inside a roomy enclosure, with bounded rejection work. */
export function randomLoose(
  problem: { N: number; M: number; P: number },
  random: () => number,
  stopped: () => boolean,
): PackingConfig {
  const steps = looseSteps(problem, random, stopped);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/**
 * randomLoose as a generator that yields the pieces scanned by each trial, so a caller can
 * checkpoint between trials. The draws and the accepted pieces are the same however it is driven.
 */
export function* looseSteps(
  problem: { N: number; M: number; P: number },
  random: () => number,
  stopped: () => boolean,
): Generator<number, PackingConfig> {
  const fallback = scatter(problem, random);
  const box = strictEnclose(fallback);
  box.size *= 1.3;
  const reach = problem.M === 0 ? box.size : box.size / (2 * Math.sin(Math.PI / problem.M));
  const pieces: Pose[] = [];
  for (let i = 0; i < problem.P; i++) {
    let placed = false;
    for (let trial = 0; trial < 256; trial++) {
      if (stopped()) return fallback;
      const p = {
        x: box.cx + reach * (2 * random() - 1),
        y: box.cy + reach * (2 * random() - 1),
        theta: problem.N === 0 ? 0 : 2 * Math.PI * random(),
      };
      let inside = true;
      visitContainerProtrusions(
        problem.N,
        p,
        box,
        (depth) => {
          if (depth > 0) inside = false;
        },
        true,
      );
      const blocked = !inside || findOverlaps(problem.N, [...pieces, p], 0).length > 0;
      yield inside ? pieces.length + 1 : 1;
      if (blocked) continue;
      pieces.push(p);
      placed = true;
      break;
    }
    if (!placed) return fallback;
  }
  return { ...problem, pieces, container_phi: 0 };
}

export interface GrowthObservation {
  kind: "evaluation" | "jam" | "restart" | "end";
  run: number;
  operations: number;
  collisions: number;
  repairs: number;
  thermostats: number;
  config: PackingConfig;
  container: Container;
}

export async function executeGrowth(ctx: MethodContext, observe?: (event: GrowthObservation) => void): Promise<void> {
  if (!(await ctx.checkpoint())) return;
  const allowance = ctx.remaining();
  // Every key belongs to one counted assessment, so an evaluation budget already bounds this
  // set and it is left exact. Only a run with unlimited evaluations forgets its oldest keys
  // (about 20 MB of signatures); a later recurrence is then assessed again, which costs time
  // but cannot change what a seeded evaluation budget returns.
  const seenLimit = Number.isFinite(allowance.evals) ? Infinity : Math.max(256, Math.ceil(2 ** 18 / ctx.problem.P));
  const seen = new Set<string>();
  const signature = (config: PackingConfig): string => JSON.stringify([config.container_phi, config.pieces]);
  const remember = (key: string): void => {
    seen.add(key);
    if (seen.size > seenLimit) seen.delete(seen.values().next().value as string);
  };
  let work = 0;
  const due = (units: number): boolean => {
    work += units;
    if (work < CHECKPOINT_WORK) return false;
    work = 0;
    return true;
  };
  let best = ctx.start;
  if (best) remember(signature(best));
  const valid = (config: PackingConfig | undefined): boolean =>
    !!config && config.pieces.length === ctx.problem.P && !findOverlaps(config.N, config.pieces, 0).length;
  let bestScore = valid(best) && ctx.initialEvaluation?.valid ? ctx.initialEvaluation.score! : Infinity;
  if (!valid(best)) {
    // The framework assesses nothing once the time budget has expired or stop was requested,
    // so a start still being prepared at that moment would leave the run with no configuration.
    // A jitter-free grid needs no search and no seeded draw, and is assessed while that is still
    // allowed: at once when evaluations are unlimited. Under an evaluation budget one more
    // assessment would shift every later count, so the grid replaces the start only when
    // preparation reaches the last 25 ms of the time budget (half of a shorter one), where that
    // budget ends the run anyway and the result no longer depends on the seed alone. A supplied
    // start that the framework scored valid within tolerance already guarantees a returned
    // configuration and is usually far tighter than the grid, so its repair keeps all the time.
    const timed = !ctx.initialEvaluation?.valid && Number.isFinite(allowance.time_s);
    const reserve = Math.min(allowance.time_s / 2, 0.025);
    const late = (): boolean => timed && ctx.remaining().time_s <= reserve;
    const grid = scatter(ctx.problem, () => 0.5);
    let gridScore: number | undefined;
    const insure = async (): Promise<boolean> => {
      if (gridScore === undefined) {
        remember(signature(grid));
        const evaluation = await ctx.evaluate(grid, { autoOrient: false });
        if (evaluation?.valid) gridScore = evaluation.score!;
      }
      return gridScore !== undefined;
    };
    if (timed && !Number.isFinite(allowance.evals) && !(await insure())) return;
    // Repair the supplied start locally, avoiding ctx.run's mandatory duplicate
    // start assessment. A coincident/incomplete start has a bounded loose fallback.
    if (best?.pieces.length === ctx.problem.P)
      best = restore(best, "separate", () => ctx.shouldStop() || late(), ctx.random);
    if (!valid(best) && !ctx.start && ctx.params.initialization === "seed" && !late()) {
      const seeded = await ctx.run(
        "seed",
        { kind: "auto" },
        { evals: Math.min(ctx.params.seedEvals as number, Math.max(3, Math.floor(ctx.remaining().evals / 10))) },
      );
      best = seeded.found ?? seeded.best;
      if (best && valid(best)) {
        bestScore = seeded.foundScore ?? seeded.score ?? Infinity;
        remember(signature(best));
      }
    }
    if (!best || !valid(best)) {
      best = undefined;
      const steps = looseSteps(ctx.problem, ctx.random, ctx.shouldStop);
      for (let step = steps.next(); ; step = steps.next()) {
        if (step.done) {
          best = step.value;
          break;
        }
        if (late()) break;
        if (due(step.value) && !(await ctx.checkpoint())) return;
      }
    }
    if (ctx.shouldStop()) return;
    if (!best) {
      // Preparation ran into the reserve: continue from the assessed grid.
      if (!(await insure())) return;
      best = grid;
      bestScore = gridScore!;
    } else if (!seen.has(signature(best))) {
      remember(signature(best));
      const evaluation = await ctx.evaluate(best, { autoOrient: false });
      if (!evaluation?.valid) return;
      bestScore = Math.min(bestScore, evaluation.score!);
    }
  }
  if (!best || !valid(best) || ctx.shouldStop()) return;
  let totalOperations = 0;
  let totalCollisions = 0;
  let totalRepairs = 0;
  let thermostats = 0;
  const runs = ctx.params.runs as number;
  for (let run = 0; run < runs; run++) {
    if (!(await ctx.checkpoint())) return;
    const tight = strictEnclose(best);
    const state = new GrowthDynamics(
      best,
      tight,
      1 - (ctx.params[run === 0 ? "initialShrink" : "restartShrink"] as number),
      ctx.params.growthRate as number,
      ctx.params.initialSpeed as number,
      ctx.params.angularSpeed as number,
      ctx.random,
    );
    let assessments = 0;
    let stagnant = 0;
    let runBest = Infinity;
    let tiny = 0;
    let flightTime = 0;
    const remaining = ctx.remaining().evals;
    const slice = Number.isFinite(remaining) ? Math.max(1, Math.floor(remaining / (runs - run))) : Infinity;
    const notify = (kind: GrowthObservation["kind"]): void =>
      observe?.({
        kind,
        run,
        operations: totalOperations + state.operations,
        collisions: totalCollisions + state.collisions,
        repairs: totalRepairs + state.repairs,
        thermostats,
        config: state.config(),
        container: state.unitContainer(),
      });
    const submit = async (): Promise<boolean> => {
      if (ctx.shouldStop()) return false;
      let config = state.config();
      // Division into unit coordinates can round a scaled nonnegative contact
      // negative. Uniformly shrinking pieces fixes that without moving centres.
      for (let attempt = 0; attempt < 8 && findOverlaps(config.N, config.pieces, 0).length; attempt++) {
        state.scale *= 1 - 2e-13;
        state.repairs++;
        config = state.config();
      }
      if (
        findOverlaps(config.N, config.pieces, 0).length ||
        !state.feasible(state.scale, ctx.shouldStop) ||
        config.pieces.some((p) => Math.abs(p.x) > MAX_COORD || Math.abs(p.y) > MAX_COORD)
      )
        return false;
      const key = signature(config);
      if (seen.has(key)) return true;
      remember(key);
      notify("evaluation");
      const evaluation = await ctx.evaluate(config, { autoOrient: false });
      if (!evaluation?.valid) return false;
      assessments++;
      if (evaluation.score! < runBest - 1e-9 * Math.max(1, Number.isFinite(runBest) ? runBest : 1)) stagnant = 0;
      else stagnant++;
      runBest = Math.min(runBest, evaluation.score!);
      if (evaluation.score! < bestScore) {
        bestScore = evaluation.score!;
        best = config;
      }
      return true;
    };
    if (run > 0) notify("restart");
    while (!ctx.shouldStop()) {
      let advance: Advance;
      if (ctx.problem.N === 0) {
        // A disc event sweeps the pairs, the walls and one repair probe.
        if (due(3 * state.work) && !(await ctx.checkpoint())) break;
        advance = state.discAdvance(ctx.shouldStop);
      } else {
        const steps = state.polygonSteps(ctx.params.maxStep as number, ctx.shouldStop);
        let step = steps.next();
        while (!step.done && (!due(step.value) || (await ctx.checkpoint()))) step = steps.next();
        if (!step.done) break;
        advance = step.value;
      }
      if (advance.failed) break;
      if (state.thermostat(ctx.params.energyFactor as number)) thermostats++;
      flightTime += advance.dt;
      if (advance.collision) {
        tiny =
          ((ctx.params.growthRate as number) * flightTime) / state.scale < (ctx.params.jamThreshold as number)
            ? tiny + 1
            : 0;
        flightTime = 0;
      }
      const jammed = tiny >= (ctx.params.jamWindow as number);
      if (state.operations % (ctx.params.evaluationInterval as number) === 0 || jammed) {
        if (!(await submit())) break;
      }
      if (jammed) {
        notify("jam");
        break;
      }
      if (assessments >= slice || stagnant >= (ctx.params.stagnationEvaluations as number)) break;
    }
    if (!ctx.shouldStop() && state.feasible(state.scale, ctx.shouldStop)) await submit();
    notify("end");
    totalOperations += state.operations;
    totalCollisions += state.collisions;
    totalRepairs += state.repairs;
  }
}
