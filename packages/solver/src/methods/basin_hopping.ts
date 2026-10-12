import { evaluate, findOverlaps, type PackingConfig } from "@polypack/geometry";
import type { MethodContext, MethodDefinition, SubRunResult } from "../framework";
import type { ParameterSchema } from "../schema";
import { penaltyMethod } from "./penalty";
import { scatter } from "./penalty/restoration";
import { congruenceSignature } from "./seed/signature";
import { refineAligned } from "./basin_hopping/refinement";
import {
  copy,
  centerLocalStart,
  globalRestart,
  operatorNames,
  randomKick,
  reinsertPieceCooperative,
  rotateCluster,
  samePacking,
  swapOrientations,
  strictLocalStart,
  type Operator,
} from "./basin_hopping/operators";

export interface OperatorStats {
  tries: number;
  accepted: number;
  improvements: number;
  successRate: number;
}
export const IMPROVEMENT_THRESHOLD = 1e-9;
export interface BasinTrace {
  version: 1;
  operators: Record<Operator, OperatorStats>;
  hops: {
    operator: Operator;
    score: number | null;
    rawScore: number | null;
    currentScore: number;
    accepted: boolean;
    improved: boolean;
  }[];
  kickMagnitude: number;
  localFailures: number;
  centeredStarts: number;
  redraws: number;
  refinementEvaluations: number;
}

function numeric(
  title: string,
  description: string,
  value: number,
  min: number,
  max: number,
  integer = false,
): ParameterSchema {
  return { type: integer ? "integer" : "number", title, description, default: value, minimum: min, maximum: max };
}

const weights = { kick: 4, swap: 1, cluster: 2, reinsert: 2, restart: 0.3 };
export const basinHoppingMethod: MethodDefinition = {
  name: "basin_hopping",
  doc: "docs/methods/basin_hopping.md",
  defaults: {
    localEvals: 150,
    refinementEvals: 3000,
    alignmentTolerance: 0.01,
    seedEvals: 24,
    temperature: 0.04,
    kickMagnitude: 0.35,
    kickFraction: 0.4,
    rotationMagnitude: Math.PI / 2,
    clusterRadius: 1.8,
    reinsertionTrials: 48,
    restartStrength: 3,
    targetAcceptance: 0.5,
    adaptationRate: 0.15,
    weightFloor: 0.2,
    weights,
    poolLimit: 8,
    penalty: { ...penaltyMethod.defaults, outerIterations: 6, innerIterations: 120 },
  },
  schema: {
    type: "object",
    title: "Basin hopping / iterated local search",
    description:
      "Perturb and locally repair packings, with adaptive operators and Metropolis acceptance of local scores.",
    additionalProperties: false,
    properties: {
      localEvals: numeric(
        "Local solve evaluations",
        "Maximum shared assessments per hop penalty solve, including its start; clipped to remaining budget, terminal refinement and pool reserves.",
        150,
        2,
        1000000,
        true,
      ),
      refinementEvals: numeric(
        "Final refinement evaluations",
        "Cap for a tighter final penalty solve from the strict best; reserve at most one sixth of the method allowance. Zero disables it.",
        3000,
        0,
        1000000,
        true,
      ),
      alignmentTolerance: numeric(
        "Final wall alignment tolerance",
        "Radians: also try a fixed-angle penalty solve when all pieces are near container face or vertex alignment. Zero disables this restricted solve.",
        0.01,
        0,
        0.1,
      ),
      seedEvals: numeric(
        "Seed evaluations",
        "Automatic seed slice, also with a supplied start; adds seed results to alternative restarts.",
        24,
        1,
        10000,
        true,
      ),
      temperature: numeric(
        "Temperature",
        "Score units; uphill probability exp(-difference/temperature). Zero accepts strict improvements only.",
        0.04,
        0,
        1000,
      ),
      kickMagnitude: numeric(
        "Kick displacement",
        "Uniform displacement per axis in piece units; adapted after kick trials, bounded to [0.001,10].",
        0.35,
        0.001,
        10,
      ),
      kickFraction: numeric(
        "Kicked fraction",
        "Ceiling of this fraction of pieces is sampled without replacement, at least one.",
        0.4,
        0,
        1,
      ),
      rotationMagnitude: numeric(
        "Rotation amplitude",
        "Uniform angle in plus/minus this many radians for kicks and cluster turns.",
        Math.PI / 2,
        0,
        Math.PI,
      ),
      clusterRadius: numeric(
        "Cluster radius",
        "Radius as a multiple of the piece bounding diameter; require at least two members and rotate about their centroid.",
        1.8,
        0,
        10000,
      ),
      reinsertionTrials: numeric(
        "Free region samples",
        "Centre samples inside the current container, with fitting neighbour and wall orientations; rank enclosing size then clearance.",
        48,
        1,
        4096,
        true,
      ),
      restartStrength: numeric(
        "Restart strength",
        "Multiply the adaptive kick amplitude for all pieces of a randomly selected seed.",
        3,
        1,
        100,
      ),
      targetAcceptance: numeric(
        "Target kick acceptance",
        "Adapt kick size toward this acceptance probability; numerical score ties within 1e-9 do not change the amplitude.",
        0.5,
        0,
        1,
      ),
      adaptationRate: numeric(
        "Adaptation rate",
        "Exponential moving average coefficient and logarithmic kick adaptation rate; zero disables adaptation.",
        0.15,
        0,
        1,
      ),
      weightFloor: numeric(
        "Operator exploration floor",
        "Effective weight = base weight times (floor + recent rate of improvements larger than 1e-9). Zero base weight disables an operator.",
        0.2,
        0.001,
        1,
      ),
      weights: {
        type: "object",
        title: "Operator weights",
        description:
          "Relative base weights; all zero falls back to kicks. Recent improvements larger than 1e-9 adapt their effective weights.",
        additionalProperties: false,
        properties: Object.fromEntries(
          operatorNames.map((name) => [
            name,
            numeric(name, `Relative selection weight for ${name}.`, weights[name], 0, 1000),
          ]),
        ),
      },
      poolLimit: numeric(
        "Local optimum pool",
        "Keep and emit plain configurations in at most this many distinct score/distance classes, best first. Emit costs one evaluation.",
        8,
        0,
        64,
        true,
      ),
      penalty: {
        ...penaltyMethod.schema,
        title: "Local penalty parameters",
        description:
          "Nested penalty schema; defaults use six outer and 120 inner iterations. Child solves never append polish.",
        properties: {
          ...penaltyMethod.schema.properties,
          outerIterations: { ...penaltyMethod.schema.properties!.outerIterations, default: 6 },
          innerIterations: { ...penaltyMethod.schema.properties!.innerIterations, default: 120 },
        },
      },
    },
  },
  async execute(ctx) {
    await executeBasinHopping(ctx);
  },
};

/** No draw for strict improvements or temperature zero; finite ties are accepted at T>0. */
export function metropolis(current: number, candidate: number, temperature: number, random: () => number): boolean {
  if (!Number.isFinite(candidate) || !Number.isFinite(current)) return false;
  if (candidate < current) return true;
  if (temperature <= 0) return false;
  return random() < Math.exp(-(candidate - current) / temperature);
}

export function chooseOperator(
  base: Record<Operator, number>,
  stats: Record<Operator, OperatorStats>,
  floor: number,
  random: () => number,
): Operator {
  const effective = operatorNames.map((name) => base[name] * (floor + stats[name].successRate));
  const total = effective.reduce((sum, w) => sum + w, 0);
  if (total === 0) return "kick";
  let draw = random() * total;
  for (let i = 0; i < effective.length; i++) {
    draw -= effective[i];
    if (draw < 0) return operatorNames[i];
  }
  for (let i = effective.length - 1; i >= 0; i--) {
    if (effective[i] > 0) return operatorNames[i];
  }
  return "kick";
}

/** Exported for callers needing structured diagnostics: MethodDefinition itself returns void. */
export async function executeBasinHopping(ctx: MethodContext): Promise<BasinTrace> {
  const p = ctx.params;
  const trace: BasinTrace = {
    version: 1,
    operators: Object.fromEntries(
      operatorNames.map((name) => [name, { tries: 0, accepted: 0, improvements: 0, successRate: 0 }]),
    ) as Record<Operator, OperatorStats>,
    hops: [],
    kickMagnitude: p.kickMagnitude as number,
    localFailures: 0,
    centeredStarts: 0,
    redraws: 0,
    refinementEvaluations: 0,
  };
  const limit = p.poolLimit as number;
  const pool: { config: PackingConfig; score: number; key: string }[] = [];
  const seeds = ctx.starts.filter((c) => c.pieces.length === ctx.problem.P).map(copy);
  let evaluations = 0;
  let best: PackingConfig | undefined;
  let bestScore = Infinity;
  const track = (config: PackingConfig | undefined, score: number | null) => {
    if (config && score !== null && score < bestScore && !findOverlaps(config.N, config.pieces, 1e-12).length) {
      best = copy(config);
      bestScore = score;
    }
  };
  // This reserve belongs to the method, in addition to the framework's polish
  // reserve. Unlimited-evaluation runs cannot promise a final refinement slice.
  const initialAllowance = ctx.remaining().evals;
  const initialTime = ctx.remaining().time_s;
  const timeReserve =
    !Number.isFinite(initialAllowance) && Number.isFinite(initialTime) && (p.refinementEvals as number) > 0
      ? initialTime / 6
      : 0;
  const finalReserve = Number.isFinite(initialAllowance)
    ? Math.min(p.refinementEvals as number, Math.floor(initialAllowance / 6))
    : 0;
  const assess = async (config: PackingConfig) => {
    const result = await ctx.evaluate(config);
    if (result) evaluations++;
    return result;
  };
  const remember = async (config: PackingConfig, score: number) => {
    if (limit === 0 || findOverlaps(config.N, config.pieces, 1e-12).length) return;
    const key = await congruenceSignature(ctx, config, score);
    if (key === undefined) return;
    const member = pool.find((c) => c.key === key);
    if (!member) pool.push({ config: copy(config), score, key });
    else if (score < member.score) {
      member.config = copy(config);
      member.score = score;
    }
    pool.sort((a, b) => a.score - b.score);
    pool.length = Math.min(pool.length, limit);
  };
  const local = async (start: PackingConfig, reserve: number): Promise<SubRunResult | undefined> => {
    if (ctx.shouldStop()) return undefined;
    const evals = Math.min(p.localEvals as number, ctx.remaining().evals - reserve);
    if (evals < 1) return undefined;
    const centered = centerLocalStart(start);
    if (centered !== start) trace.centeredStarts++;
    const guarded = strictLocalStart(centered, ctx.random, ctx.shouldStop);
    if (!guarded || ctx.shouldStop()) return undefined;
    try {
      const result = await ctx.run("penalty", p.penalty as Record<string, unknown>, {
        start: guarded,
        evals,
        ...(timeReserve > 0 ? { time_s: Math.max(0, ctx.remaining().time_s - timeReserve) } : {}),
      });
      evaluations += result.evaluations;
      track(result.best, result.score);
      if (result.termination === "error") trace.localFailures++;
      return result;
    } catch {
      trace.localFailures++;
      return undefined;
    }
  };
  if (!(await ctx.checkpoint())) return trace;
  let current = ctx.start?.pieces.length === ctx.problem.P ? copy(ctx.start) : undefined;
  let currentScore = ctx.initialEvaluation?.valid ? ctx.initialEvaluation.score : null;
  if (current) {
    seeds.push(copy(current));
    track(current, currentScore);
  }
  {
    try {
      const seeded = await ctx.run(
        "seed",
        { kind: "auto" },
        { evals: Math.min(p.seedEvals as number, ctx.remaining().evals) },
      );
      evaluations += seeded.evaluations;
      track(seeded.best, seeded.score);
      if (!current) {
        current = seeded.found;
        currentScore = seeded.foundScore;
      }
      if (seeded.found) seeds.push(copy(seeded.found));
    } catch {
      // Custom registries may omit seed. Assess a valid shared scatter fallback.
    }
  }
  if (ctx.shouldStop()) return trace;
  if (current && currentScore === null) {
    const repaired = await local(current, Math.min(1, limit));
    current = repaired?.found;
    currentScore = repaired?.foundScore ?? null;
  }
  if (!current || currentScore === null) {
    const fallback = scatter(ctx.problem, ctx.random);
    const result = await assess(fallback);
    if (result?.valid && result.score !== null) {
      current = { ...fallback, container_phi: result.container!.phi };
      currentScore = result.score;
      seeds.push(copy(current));
      track(current, currentScore);
    }
  }
  if (!current || currentScore === null || ctx.shouldStop()) return trace;
  const first = await local(current, finalReserve + Math.min(1, limit));
  if (first?.found && first.foundScore !== null) {
    current = first.found;
    currentScore = first.foundScore;
  }
  await remember(current, currentScore);
  let redraws = 0;
  while (
    !ctx.shouldStop() &&
    ctx.remaining().evals > finalReserve + pool.length &&
    ctx.remaining().time_s > timeReserve
  ) {
    if (!(await ctx.checkpoint())) break;
    const before = evaluations;
    const reserve = finalReserve + Math.min(limit, pool.length + 1);
    if (ctx.remaining().evals <= reserve) {
      await assess(current);
      break;
    }
    const availableWeights = { ...(p.weights as Record<Operator, number>) };
    if (current.N === 0) availableWeights.swap = 0;
    if (ctx.remaining().evals < reserve + current.P + 1) availableWeights.reinsert = 0;
    // An operator-only parameter set can have no legal move. Bounded redraws
    // fall back to a kick, rather than burning solves or looping forever.
    if (redraws >= 8) {
      for (const name of operatorNames) availableWeights[name] = Number(name === "kick");
    }
    const operator = chooseOperator(availableWeights, trace.operators, p.weightFloor as number, ctx.random);
    const stats = trace.operators[operator];
    let perturbed: PackingConfig;
    if (operator === "swap") perturbed = swapOrientations(current, ctx.random);
    else if (operator === "cluster")
      perturbed = rotateCluster(current, ctx.random, p.clusterRadius as number, p.rotationMagnitude as number);
    else if (operator === "restart")
      perturbed = globalRestart(
        current,
        seeds,
        ctx.random,
        trace.kickMagnitude * (p.restartStrength as number),
        p.rotationMagnitude as number,
      );
    else if (operator === "reinsert") {
      let worst = 0;
      let smallest = Infinity;
      if (current.P > 1) {
        for (let i = 0; i < current.P; i++) {
          if (ctx.shouldStop() || ctx.remaining().evals <= reserve + 1) break;
          // Keep P unchanged so partial arrangements cannot enter the valid best
          // tracker. Their enclosing sizes are still computed by shared geometry.
          const removal = await assess({ ...current, pieces: current.pieces.filter((_, j) => i !== j) });
          if (removal?.score !== null && removal?.score !== undefined && removal.score < smallest) {
            smallest = removal.score;
            worst = i;
          }
        }
      }
      perturbed = await reinsertPieceCooperative(
        current,
        worst,
        ctx.random,
        p.reinsertionTrials as number,
        ctx.checkpoint,
        ctx.shouldStop,
      );
    } else
      perturbed = randomKick(
        current,
        ctx.random,
        trace.kickMagnitude,
        p.kickFraction as number,
        p.rotationMagnitude as number,
      );
    if (ctx.shouldStop()) break;
    if (samePacking(current, perturbed)) {
      trace.redraws++;
      redraws++;
      continue;
    }
    redraws = 0;
    stats.tries++;
    const result = await local(perturbed, reserve);
    const candidate = result?.found;
    const rawScore = result?.foundScore ?? null;
    const previousScore = currentScore;
    // Treat float64 score noise as a tie; retain the actual assessed score in
    // diagnostics and in the framework's independent best tracker.
    const score: number | null =
      rawScore !== null && Math.abs(rawScore - currentScore) <= IMPROVEMENT_THRESHOLD ? currentScore : rawScore;
    const improved = score !== null && score < currentScore;
    const accepted =
      !!candidate && score !== null && metropolis(currentScore, score, p.temperature as number, ctx.random);
    if (accepted) {
      current = candidate!;
      currentScore = score!;
      stats.accepted++;
    }
    if (improved) stats.improvements++;
    const rate = p.adaptationRate as number;
    stats.successRate = (1 - rate) * stats.successRate + rate * Number(improved);
    if (operator === "kick" && (rawScore === null || Math.abs(rawScore - previousScore) > IMPROVEMENT_THRESHOLD))
      trace.kickMagnitude = Math.max(
        0.001,
        Math.min(10, trace.kickMagnitude * Math.exp(rate * (Number(accepted) - (p.targetAcceptance as number)))),
      );
    trace.hops.push({ operator, score, rawScore, currentScore, accepted, improved });
    // Bound diagnostics in time-only runs without changing optimization decisions.
    if (trace.hops.length > 2048) trace.hops.shift();
    if (candidate && rawScore !== null && !ctx.shouldStop()) await remember(candidate, rawScore);
    // Failed/unregistered local methods can consume nothing; force progress.
    if (evaluations === before && !ctx.shouldStop()) await assess(current);
  }
  if (best && finalReserve > 0 && !ctx.shouldStop()) {
    // Reuse penalty's driver with a scoped context: every assessment still goes
    // through the parent framework, while this terminal solve is not a hop.
    const cap = Math.max(0, ctx.remaining().evals - pool.length);
    const initial = await assess(best);
    if (initial) {
      trace.refinementEvaluations++;
      let phaseCap = Math.min(cap, Math.ceil(cap / 2));
      const stopped = () => ctx.shouldStop() || trace.refinementEvaluations >= phaseCap;
      const refinement: MethodContext = {
        ...ctx,
        start: best,
        initialEvaluation: initial,
        params: {
          ...(p.penalty as Record<string, unknown>),
          outerIterations: Math.max(20, (p.penalty as Record<string, number>).outerIterations),
          innerIterations: Math.max(300, (p.penalty as Record<string, number>).innerIterations),
          gradientTolerance: Math.min(1e-10, (p.penalty as Record<string, number>).gradientTolerance),
          jitter: 0,
        },
        shouldStop: stopped,
        remaining: () => ({
          ...ctx.remaining(),
          evals: Math.min(ctx.remaining().evals, phaseCap - trace.refinementEvaluations),
        }),
        checkpoint: async () => !stopped() && (await ctx.checkpoint()),
        evaluate: async (config, options) => {
          if (stopped()) return undefined;
          const result = await ctx.evaluate(config, options);
          if (result) {
            evaluations++;
            trace.refinementEvaluations++;
            if (result.valid) track({ ...config, container_phi: result.container!.phi }, result.score);
          }
          return result;
        },
      };
      try {
        await refineAligned(refinement, best, p.alignmentTolerance as number);
        phaseCap = cap;
        if (best && !stopped()) {
          const next = await refinement.evaluate(best);
          if (next) await penaltyMethod.execute({ ...refinement, start: best, initialEvaluation: next });
        }
      } catch {
        trace.localFailures++;
      }
      if (best) await remember(best, bestScore);
    }
  }
  if (best && timeReserve > 0 && !ctx.shouldStop()) {
    try {
      const result = await ctx.run(
        "penalty",
        {
          ...(p.penalty as Record<string, unknown>),
          outerIterations: Math.max(20, (p.penalty as Record<string, number>).outerIterations),
          innerIterations: Math.max(300, (p.penalty as Record<string, number>).innerIterations),
          gradientTolerance: Math.min(1e-10, (p.penalty as Record<string, number>).gradientTolerance),
          jitter: 0,
        },
        { start: best, evals: p.refinementEvals as number, time_s: ctx.remaining().time_s },
      );
      trace.refinementEvaluations += result.evaluations;
      evaluations += result.evaluations;
      if (result.termination === "error") trace.localFailures++;
      track(result.best, result.score);
      if (best) await remember(best, bestScore);
    } catch {
      trace.localFailures++;
    }
  }
  // Members were ranked by the score of the search that produced them, which may be at a fixed phi.
  // Emit them best first by the server's auto-oriented score, which is what a next stage sees.
  for (const member of pool) member.score = evaluate(member.config, { autoOrient: true }).score ?? Infinity;
  pool.sort((a, b) => a.score - b.score);
  for (const member of pool) {
    if (ctx.shouldStop()) break;
    const { agent_note: _note, ...plain } = member.config;
    await ctx.emit(plain);
  }
  // Early convergence can leave a method allowance. Count those assessments,
  // too, without inventing additional hops or taking the final polish reserve.
  while (Number.isFinite(initialAllowance) && !ctx.shouldStop()) await assess(best ?? current);
  return trace;
}
