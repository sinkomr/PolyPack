/**
 * basin_hopping on any kernel: perturb the current packing, solve locally (local.ts squeeze),
 * offer the result and accept it by a Metropolis rule on its finished score. The operators (kick,
 * swap, reinsert, restart) and their adaptive weights, and the adaptive kick size, are those of
 * the polygon method (packages/solver/src/methods/basin_hopping.ts) as far as they generalise;
 * docs/methods/dimensions/basin_hopping.md says what was kept and why.
 */
import type { ParameterSchema } from "@polypack/solver/schema";
import type { MethodContext, SpaceMethodDefinition } from "../framework";
import type { KernelState } from "../kernel";
import type { SqueezeOptions } from "../local";
import { randomInt } from "../random";
import {
  OPERATORS,
  type Operator,
  type OperatorStats,
  TIE,
  chooseOperator,
  kick,
  metropolis,
  reinsert,
  samePacking,
  stressedPiece,
  swapPair,
} from "./basin-operators";
import { FinalRefinement } from "./basin-final";
import { fitIterations } from "./seed-starts";

/** Structured starts asked of a kernel with the capability "seeds", for the restart set. */
const SEEDS = 4;
/** The solves of a squeeze: its six penalty weights and the relax after them (local.ts). */
const SQUEEZE_SOLVES = 7;
/** Redraws in a row of a perturbation that changed nothing before a kick is forced. */
const MAX_REDRAWS = 8;
/** The shrink of the probe that picks the piece to reinsert (basin-operators.ts stressedPiece). */
const REINSERT_SQUEEZE = 0.02;

const number = (
  title: string,
  description: string,
  value: number,
  minimum: number,
  maximum: number,
  integer = false,
): ParameterSchema => ({ type: integer ? "integer" : "number", title, description, default: value, minimum, maximum });

const WEIGHTS: Record<Operator, number> = { kick: 4, swap: 1, reinsert: 2, restart: 0.3 };
const WEIGHT_TEXT: Record<Operator, string> = {
  kick: "Jiggle a fraction of the pieces by the adaptive kick size.",
  swap: "Exchange the orientations of two pieces (only where the space can swap).",
  reinsert: "Move a piece in the way of a smaller size to the best of several random poses.",
  restart: "Start again from a structured start or the supplied one, strongly kicked, or from random poses.",
};

const schema: ParameterSchema = {
  type: "object",
  title: "Basin hopping",
  description:
    "Perturb the current packing, squeeze it, and accept the finished score by a Metropolis rule, with adaptive operator weights and kick size.",
  additionalProperties: false,
  properties: {
    temperature: number(
      "Temperature",
      "Relative to the current score s: a worse finished score s' is accepted with probability exp(-(s' - s) / (temperature s)). Zero accepts strict improvements only.",
      0.01,
      0,
      10,
    ),
    kickMagnitude: number(
      "Kick size",
      "Initial jiggle of a kicked piece, in steps (a step moves a piece by about its inradius); adapted after kicks within [0.001, 10].",
      0.35,
      0.001,
      10,
    ),
    kickFraction: number("Kicked fraction", "Fraction of the pieces a kick jiggles, at least one.", 0.4, 0, 1),
    reinsertionTrials: number(
      "Reinsertion samples",
      "Random poses tried for a reinserted piece; the one with the least overlap wins.",
      48,
      1,
      4096,
      true,
    ),
    restartStrength: number(
      "Restart strength",
      "A restart from a structured or supplied start jiggles every piece by this multiple of the kick size.",
      3,
      1,
      100,
    ),
    targetAcceptance: number(
      "Target kick acceptance",
      "The kick size grows when kicks are accepted more often than this, and shrinks when less often.",
      0.5,
      0,
      1,
    ),
    adaptationRate: number(
      "Adaptation rate",
      "Rate of the operators' success averages and of the kick-size adaptation; zero disables both.",
      0.15,
      0,
      1,
    ),
    weightFloor: number(
      "Operator exploration floor",
      "Effective weight = base weight times (floor + recent rate of improvements).",
      0.2,
      0.001,
      1,
    ),
    weights: {
      type: "object",
      title: "Operator weights",
      description: "Relative base weights; zero disables an operator, all zero falls back to kicks.",
      additionalProperties: false,
      properties: Object.fromEntries(OPERATORS.map((o) => [o, number(o, WEIGHT_TEXT[o], WEIGHTS[o], 0, 1000)])),
    },
    localIterations: number(
      "Local solve iterations",
      "L-BFGS iterations per penalty weight of each hop's squeeze.",
      200,
      1,
      100000,
      true,
    ),
    refinementEvals: number(
      "Final refinement evaluations",
      "The most evaluations the final tight squeeze of the best packing may take; it runs only when it and one offer fit in a third of the evaluation budget. Zero disables it; time-only runs have none.",
      3000,
      0,
      1000000,
      true,
    ),
  },
};

const defaults = {
  temperature: 0.01,
  kickMagnitude: 0.35,
  kickFraction: 0.4,
  reinsertionTrials: 48,
  restartStrength: 3,
  targetAcceptance: 0.5,
  adaptationRate: 0.15,
  weightFloor: 0.2,
  weights: { ...WEIGHTS },
  localIterations: 200,
  refinementEvals: 3000,
};

export interface BasinTrace {
  operators: Record<Operator, OperatorStats>;
  kickMagnitude: number;
  redraws: number;
  /** Hops whose local solve did not finish. */
  failures: number;
  refined: boolean;
}

/** One hop, for an observer: the operator, the squeezed size, the finished score (null: no finish) and the decision. */
export interface BasinHop {
  op: Operator;
  size: number;
  score: number | null;
  accepted: boolean;
  /** The current packing's finished score after the hop. */
  current: number;
}

/**
 * The method's loop. `trace`, when given, receives its operator statistics as it runs; `observe`
 * sees every hop (it draws no random number).
 */
export function runBasinHopping(ctx: MethodContext, trace?: BasinTrace, observe?: (hop: BasinHop) => void): void {
  const k = ctx.kernel;
  const p = ctx.params;
  const rng = ctx.rng;
  const t: BasinTrace = trace ?? {
    operators: {} as Record<Operator, OperatorStats>,
    kickMagnitude: 0,
    redraws: 0,
    failures: 0,
    refined: false,
  };
  for (const o of OPERATORS) t.operators[o] = { tries: 0, accepted: 0, improvements: 0, successRate: 0 };
  t.kickMagnitude = p.kickMagnitude as number;
  const temperature = p.temperature as number;
  const rate = p.adaptationRate as number;
  /**
   * A squeeze's iterations per solve, fitted to the budget (seed-starts.ts fitIterations): the
   * wanted `localIterations`, or fewer so that `solves` solves and one offer fit in what is left;
   * a run's first squeeze takes at most half of it, so the run has a result early.
   */
  const fitted = (solves: number, first: boolean): SqueezeOptions => ({
    maxIter: fitIterations(ctx, p.localIterations as number, solves, first),
  });
  // the final refinement (basin-final.ts), which learns its cost from the hops' squeezes
  const final = new FinalRefinement(ctx, p.refinementEvals as number);

  // The restart set: the supplied start and the kernel's structured starts.
  const restarts: KernelState[] = [];
  if (ctx.start) restarts.push(k.clone(ctx.start));
  if (k.seeds) restarts.push(...k.seeds(rng, SEEDS));

  // The first local solve. Without a valid supplied start, the first candidate (the supplied
  // start, else the first structured start, else random poses) is squeezed and offered at once,
  // until one finishes: the run has a result as early as the budget allows. Then the other
  // candidates are squeezed, fitted together to what is left, and offered smallest first while
  // they could beat the current packing, until one finishes: structured starts squeeze to very
  // different sizes (polyhedra/tetintet/6, seed 1: 2.67, 3.00, 2.30 and 2.30). A valid start the
  // solve does not beat stays the current packing. The current packing is the squeezed state, not
  // its finished configuration: the next hop perturbs the local minimum of the penalty, and the
  // finished score decides acceptance.
  let current: KernelState | null = null;
  let currentScore = Infinity;
  const take = (s: KernelState, score: number | null) => {
    if (score !== null && score < currentScore) {
      current = s;
      currentScore = score;
    }
  };
  const given = ctx.best();
  if (given) take(given.state, given.score);
  const queue = restarts.map((s) => k.clone(s));
  while (!current) {
    const s = queue.shift() ?? k.randomStart(rng);
    // before any result, the squeeze stops where the budget leaves the offer
    if (ctx.best()) final.squeeze(s, fitted(SQUEEZE_SOLVES, false));
    else final.firstSqueeze(s, fitted(SQUEEZE_SOLVES, true));
    take(s, ctx.offer(s));
  }
  if (queue.length) {
    const rest = final.squeezedStarts(queue, fitted(SQUEEZE_SOLVES * queue.length, false));
    for (const s of rest) {
      if (!(s.size < currentScore)) break;
      const score = ctx.offer(s);
      take(s, score);
      if (score !== null) break;
    }
  }

  let redraws = 0;
  for (;;) {
    ctx.check();
    if (final.due()) {
      // A tight squeeze of the best so far; the hops then go on with what is left.
      t.refined = true;
      const best = ctx.best();
      if (best) {
        const score = final.run(best.state);
        if (score !== null && score < currentScore) {
          current = best.state;
          currentScore = score;
        }
      } else final.done = true;
      continue;
    }
    const before = ctx.used();
    const base = { ...(p.weights as Record<Operator, number>) };
    if (!k.swap || k.P < 2) base.swap = 0;
    // Perturbations that change nothing are redrawn without a solve; after a few, a kick is forced.
    const forced = redraws >= MAX_REDRAWS;
    if (forced) for (const o of OPERATORS) base[o] = o === "kick" ? 1 : 0;
    const op = chooseOperator(base, t.operators, p.weightFloor as number, rng);
    let s = k.clone(current!);
    if (op === "swap") swapPair(k, s, rng);
    else if (op === "reinsert")
      reinsert(k, s, stressedPiece(k, s, rng, REINSERT_SQUEEZE), rng, p.reinsertionTrials as number);
    else if (op === "restart") {
      if (restarts.length) {
        s = k.clone(restarts[randomInt(rng, restarts.length)]);
        kick(k, s, rng, t.kickMagnitude * (p.restartStrength as number), 1);
      } else s = k.randomStart(rng);
    } else kick(k, s, rng, t.kickMagnitude, p.kickFraction as number);
    if (!forced && samePacking(k, s, current!)) {
      redraws++;
      t.redraws++;
      continue;
    }
    redraws = 0;
    const stats = t.operators[op];
    stats.tries++;
    final.squeeze(s, fitted(SQUEEZE_SOLVES, false));
    const raw = ctx.offer(s);
    if (raw === null) t.failures++;
    const previous = currentScore;
    // a difference within float noise is a tie: it neither improves nor changes the kick size
    const tie = raw !== null && Math.abs(raw - previous) <= TIE * previous;
    const score = tie ? previous : raw;
    const improved = score !== null && score < previous;
    // the finished score decides, not the squeezed size: the finishing is the space's own
    const accepted = score !== null && metropolis(previous, score, temperature * previous, rng);
    if (accepted) {
      current = s;
      currentScore = score!;
      stats.accepted++;
    }
    if (improved) stats.improvements++;
    stats.successRate = (1 - rate) * stats.successRate + rate * Number(improved);
    // A kick that comes back to the same minimum (a tie) counts as accepted: the kick was too
    // small to leave the basin, so it grows, as uphill rejections shrink it.
    if (op === "kick")
      t.kickMagnitude = Math.max(
        0.001,
        Math.min(10, t.kickMagnitude * Math.exp(rate * (Number(accepted || tie) - (p.targetAcceptance as number)))),
      );
    observe?.({ op, size: s.size, score: raw, accepted, current: currentScore });
    final.step(ctx.used() - before);
  }
}

export const basinHopping: SpaceMethodDefinition = {
  name: "basin_hopping",
  title: "Basin hopping",
  summary:
    "Shakes the packing up a little, lets it settle tight again, and keeps the result when it is better, or now and then when it is only slightly worse.",
  doc: "docs/methods/dimensions/basin_hopping.md",
  requires: [],
  schema,
  defaults,
  run: (ctx) => runBasinHopping(ctx),
};
