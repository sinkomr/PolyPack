// Shrink and repair: separate feasibility from size, as the strongest irregular-packing
// (nesting) heuristics do (Egeblad, Nielsen & Odgaard 2007; Imamichi, Yagiura & Nagamochi 2009;
// Gardeyn & Wauters' sparrow). From the best valid packing at size s the container is shrunk to
// s (1 - r), the centres are scaled into it (overlaps appear), and a repair phase at that fixed
// size removes the overlap with local descent, relocation of conflicting pieces by sampling, and
// guided-local-search weights. A repaired state is legalised strictly and scored; the shrink
// ratio r adapts to success and failure, and repeated failure restores the best and disrupts it.
// See docs/methods/shrink_repair.md.
import {
  areaLowerBound,
  enclose,
  findOverlaps,
  inradius,
  type Container,
  type PackingConfig,
  type Pose,
} from "@polypack/geometry";
import type { MethodContext, MethodDefinition, Sketch } from "../framework";
import type { ParameterSchema } from "../schema";
import { legalise } from "./harden/legalise";
import { restore, scatter } from "./penalty/restoration";
import { RepairState, SUCCESS_DEPTH, type RepairSettings } from "./shrink_repair/repair";

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

export const shrinkRepairMethod: MethodDefinition = {
  name: "shrink_repair",
  doc: "docs/methods/shrink_repair.md",
  defaults: {
    start: "auto",
    shrinkRatio: 0.01,
    minShrinkRatio: 0.0002,
    maxShrinkRatio: 0.05,
    strikes: 3,
    patience: 12,
    globalSamples: 48,
    localSamples: 24,
    weightGrowth: 2,
    weightDecay: 0.95,
    descentIterations: 40,
    explorePatience: 24,
    maxRuin: 1,
    restartAfter: 40,
    restartSlack: 0.02,
    evaluationWork: 4000,
  },
  schema: {
    type: "object",
    title: "Shrink and repair",
    description:
      "Shrink the container below the best packing, then repair the overlaps at that fixed size by local descent, relocation of conflicting pieces and guided-local-search weights; score only strictly legalised repairs.",
    additionalProperties: false,
    properties: {
      start: {
        type: "string",
        title: "Start",
        description:
          "auto: a complete supplied start, otherwise the automatic seed generators. random: uniform random poses in a container somewhat larger than the area bound, repaired before shrinking (a supplied start is still scored by the framework).",
        enum: ["auto", "random"],
        default: "auto",
      },
      shrinkRatio: numeric(
        "Shrink ratio",
        "Initial fractional shrink r of the container from the best size; it grows by a quarter after a successful repair and halves after a failed one.",
        0.01,
        1e-6,
        0.5,
      ),
      minShrinkRatio: numeric(
        "Smallest shrink ratio",
        "Below this ratio a failure restores the best packing, disrupts it and resets the ratio.",
        0.0002,
        1e-9,
        0.5,
      ),
      maxShrinkRatio: numeric("Largest shrink ratio", "Cap on the growing shrink ratio.", 0.05, 1e-6, 0.5),
      strikes: numeric(
        "Strike limit",
        "A repair fails after this many strikes; each strike ends after `patience` iterations without a lower raw overlap and restores the least overlapping state of the repair.",
        3,
        1,
        1000,
        true,
      ),
      patience: numeric(
        "Patience",
        "Repair iterations (relocate every conflicting piece, descend, update weights) without a lower raw overlap that end a strike.",
        12,
        1,
        10000,
        true,
      ),
      globalSamples: numeric(
        "Container samples",
        "Uniform poses over the whole container tried for each relocated piece.",
        48,
        0,
        10000,
        true,
      ),
      localSamples: numeric(
        "Local samples",
        "Poses near the piece's current and best-sampled poses tried for each relocated piece.",
        24,
        0,
        10000,
        true,
      ),
      weightGrowth: numeric(
        "Weight growth",
        "Guided local search: the weight of the deepest remaining conflict is multiplied by this at a local minimum, shallower conflicts by less (down to 1 + (growth - 1)/5).",
        2,
        1,
        100,
      ),
      weightDecay: numeric(
        "Weight decay",
        "Factor applied to the weight of a former conflict at each update; weights never fall below 1 and are reset to 1 at each new container size.",
        0.95,
        0,
        1,
      ),
      descentIterations: numeric(
        "Descent iterations",
        "L-BFGS iterations of the global descent on the weighted overlap after each relocation round.",
        40,
        1,
        100000,
        true,
      ),
      explorePatience: numeric(
        "Exploration patience",
        "Patience of the repairs that explore below the floor of the best packing's basin, and of the repair of a start.",
        24,
        1,
        10000,
        true,
      ),
      maxRuin: numeric(
        "Largest ruin",
        "Largest fraction of the pieces ruined (scattered over their region, or turned together as a block) before an exploring repair; their number is log-uniform between 1 and this fraction of P.",
        1,
        0,
        1,
      ),
      restartAfter: numeric(
        "Restart after",
        "Explorations in a row that fail to improve the current packing before random poses are repaired near the best size and become the current packing; 0 never restarts.",
        40,
        0,
        100000,
        true,
      ),
      restartSlack: numeric(
        "Restart slack",
        "A restart repairs random poses in a container this fraction larger than the best (growing by 2% after each failure).",
        0.02,
        0,
        1,
      ),
      evaluationWork: numeric(
        "Work per assessment and piece",
        "Counted pair and wall feature tests per counted assessment, per piece. Every successful repair is assessed at once; between successes one legalised working state is assessed per P times this much work, so an evaluation budget bounds the work.",
        4000,
        1,
        10000000,
        true,
      ),
    },
  },
  execute: (ctx) => executeShrinkRepair(ctx),
};

/**
 * Counted feature tests between cooperative checkpoints (about a millisecond). Counting work
 * instead of reading a clock keeps the checkpoints of a seeded run reproducible.
 */
export const CHECKPOINT_WORK = 60000;

export type RepairOutcome = "feasible" | "failed" | "stopped";

export interface ShrinkRepairObservation {
  kind: "start" | "repair" | "assessment" | "improvement" | "disruption" | "restart";
  /** Container size the repair worked at, or of the assessed state. */
  size: number;
  /** Best size so far (Infinity before the first valid packing). */
  best: number;
  ratio: number;
  outcome?: RepairOutcome;
  /** Repair iterations of a repair. */
  iterations?: number;
  /** Pieces ruined before an exploring repair, and how. */
  ruined?: number;
  ruin?: "scatter" | "rotate";
  /** The strictly legalised configuration of an assessment. */
  config?: PackingConfig;
}

/** Configuration of working poses in the container frame (phi = 0). */
function configOf(problem: { N: number; M: number; P: number }, pieces: readonly Pose[]): PackingConfig {
  return { ...problem, container_phi: 0, pieces: pieces.map((p) => ({ x: p.x, y: p.y, theta: p.theta })) };
}

/**
 * Strict legalisation: a configuration with no pair separation below zero. Scaling centres by f
 * about any point moves a penetrating pair apart along its deepest separating axis u by
 * (f - 1) (c_b - c_a) . u, and (c_b - c_a) . u = r + R cos(delta) - d >= 2 r - d for a pair of
 * regular polygons of inradius r penetrating by d (a regular polygon reaches at least r along
 * every direction; for circles r = R = 1). So f = 1 + d / (2 r - d), with a last-place margin,
 * separates every pair whose depth is below 2 r; this is checked, and anything else goes to the
 * bisected homothety of harden's legalisation and the shared restoration.
 */
export async function legaliseStrict(
  config: PackingConfig,
  stopped: () => boolean,
  tick: (work: number) => Promise<boolean> | boolean,
  random: () => number,
): Promise<PackingConfig | undefined> {
  const { N } = config;
  let deepest = 0;
  const overlaps = findOverlaps(N, config.pieces, 0);
  if (!overlaps.length) return config;
  for (const o of overlaps) deepest = Math.max(deepest, -o.sep);
  const r = N === 0 ? 1 : inradius(N);
  if (deepest < r) {
    let margin = 4e-12;
    for (let attempt = 0; attempt < 4; attempt++) {
      const f = (1 + deepest / (2 * r - deepest)) * (1 + margin);
      const scaled = { ...config, pieces: config.pieces.map((p) => ({ x: f * p.x, y: f * p.y, theta: p.theta })) };
      if (!findOverlaps(N, scaled.pieces, 0).length) return scaled;
      margin *= 16;
    }
  }
  const contact = await legalise(config, stopped, tick);
  if (stopped()) return undefined;
  const legal = restore(contact ?? config, "expand", stopped, random);
  if (!legal || findOverlaps(N, legal.pieces, 0).length) return undefined;
  return legal;
}

/** Fisher–Yates shuffle from the seeded stream. */
function shuffle(values: number[], random: () => number): void {
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const t = values[i];
    values[i] = values[j];
    values[j] = t;
  }
}

/**
 * Poses of a configuration in the frame of its enclosing container at the stored orientation:
 * centre at the origin, phi = 0 (a rigid motion of the whole arrangement).
 */
function adopt(config: PackingConfig): { pieces: Pose[]; size: number } {
  const box = enclose(config.N, config.pieces, config.M, config.M === 0 ? 0 : config.container_phi);
  const c = Math.cos(-box.phi);
  const s = Math.sin(-box.phi);
  return {
    size: box.size,
    pieces: config.pieces.map((p) => {
      const dx = p.x - box.cx;
      const dy = p.y - box.cy;
      return { x: c * dx - s * dy, y: s * dx + c * dy, theta: config.N === 0 ? 0 : p.theta - box.phi };
    }),
  };
}

export async function executeShrinkRepair(
  ctx: MethodContext,
  observe?: (event: ShrinkRepairObservation) => void,
): Promise<void> {
  if (!(await ctx.checkpoint())) return;
  const { N, P } = ctx.problem;
  const params = ctx.params;
  const settings: RepairSettings = {
    globalSamples: params.globalSamples as number,
    localSamples: params.localSamples as number,
    weightGrowth: params.weightGrowth as number,
    weightDecay: params.weightDecay as number,
  };
  const descentIterations = params.descentIterations as number;
  const r0 = params.shrinkRatio as number;
  const rMin = Math.min(params.minShrinkRatio as number, r0);
  const rMax = Math.max(params.maxShrinkRatio as number, r0);
  const strikes = params.strikes as number;
  const patience = params.patience as number;
  const explorePatience = params.explorePatience as number;
  const maxRuin = params.maxRuin as number;
  const restartAfter = params.restartAfter as number;
  const restartSlack = params.restartSlack as number;
  const interval = (params.evaluationWork as number) * P;
  const state = new RepairState(ctx.problem, settings);

  // The best packing so far, and the current one that compression and exploration work on: the
  // best, or since the last restart the descendant of a random start until it beats the best.
  let best: Pose[] | undefined;
  let bestSize = Infinity;
  let current: Pose[] | undefined;
  let currentSize = Infinity;
  let ratio = r0;
  let sinceCheckpoint = 0;
  let sinceAssessment = 0;
  let phase = "starting";
  const notify = (event: ShrinkRepairObservation) => observe?.(event);

  const absorb = () => {
    sinceCheckpoint += state.work;
    sinceAssessment += state.work;
    state.work = 0;
  };
  /** Cooperative checkpoint by counted work; false ends the method. */
  const checkpoint = async (): Promise<boolean> => {
    absorb();
    if (sinceCheckpoint >= CHECKPOINT_WORK) {
      sinceCheckpoint = 0;
      if (!(await ctx.checkpoint())) return false;
    }
    return !ctx.shouldStop();
  };
  const tick = (work: number): Promise<boolean> | boolean => {
    sinceCheckpoint += work;
    if (sinceCheckpoint < CHECKPOINT_WORK) return !ctx.shouldStop();
    sinceCheckpoint = 0;
    return ctx.checkpoint();
  };
  /**
   * Legalise and score poses in the container frame. Unless `insurance`, a result smaller than
   * the current packing (the one being shrunk) or the best replaces it. Returns false to end the
   * method, null when nothing valid was scored, otherwise the score and the poses re-centred on
   * their enclosing container.
   */
  const assess = async (
    pieces: readonly Pose[],
    kind: "assessment" | "improvement",
    insurance = false,
  ): Promise<false | null | { score: number; pieces: Pose[] }> => {
    if (ctx.shouldStop()) return false;
    const legal = await legaliseStrict(configOf(ctx.problem, pieces), ctx.shouldStop, tick, ctx.random);
    if (ctx.shouldStop()) return false;
    if (!legal) return null;
    notify({ kind, size: state.container.size, best: bestSize, ratio, config: legal });
    const result = await ctx.evaluate(legal, { autoOrient: false });
    if (!result) return false;
    if (!result.valid || result.score === null || !result.container) return null;
    const container: Container = result.container;
    // Re-centre on the enclosing container (phi = 0 in this frame).
    const centred = legal.pieces.map((p) => ({ x: p.x - container.cx, y: p.y - container.cy, theta: p.theta }));
    if (!insurance) {
      if (result.score < currentSize) {
        current = centred;
        currentSize = result.score;
      }
      if (result.score < bestSize) {
        best = centred;
        bestSize = result.score;
      }
    }
    return { score: result.score, pieces: centred };
  };
  /** Called inside the repair after every unit of work: checkpoints and periodic assessments. */
  const pulse = async (): Promise<boolean> => {
    if (!(await checkpoint())) return false;
    if (sinceAssessment >= interval) {
      sinceAssessment = 0;
      if ((await assess(state.poses, "assessment")) === false) return false;
    }
    return true;
  };
  const sketch = (): Sketch => ({
    N,
    pieces: state.poses.map((p) => ({ x: p.x, y: p.y, theta: p.theta })),
    container: { ...state.container },
    scale: 1,
    padding: 0,
    label: `shrink_repair ${phase} at size ${state.container.size.toFixed(6)} (best ${
      Number.isFinite(bestSize) ? bestSize.toFixed(6) : "none"
    }), overlap ${state.raw.toExponential(2)}`,
    values: { size: state.container.size, best: bestSize, ratio, overlap: state.raw },
  });

  /** Repair the loaded state at the current size. */
  const repair = async (patience: number): Promise<{ outcome: RepairOutcome; iterations: number }> => {
    let iterations = 0;
    if (!(await state.descend(descentIterations, pulse))) return { outcome: "stopped", iterations };
    if (state.feasible()) return { outcome: "feasible", iterations };
    let leastRaw = state.raw;
    let least = state.snapshot();
    const limit = 4 * strikes * patience;
    for (let strike = 0; strike < strikes && iterations < limit; strike++) {
      let still = 0;
      while (still < patience && iterations < limit) {
        iterations++;
        const order = state.conflicting();
        shuffle(order, ctx.random);
        for (const i of order) {
          state.relocate(i, ctx.random);
          if (!(await pulse())) return { outcome: "stopped", iterations };
        }
        if (!(await state.descend(descentIterations, pulse))) return { outcome: "stopped", iterations };
        ctx.sketch?.(sketch);
        if (state.feasible()) return { outcome: "feasible", iterations };
        if (state.raw < leastRaw * (1 - 1e-3)) {
          leastRaw = state.raw;
          least = state.snapshot();
          still = 0;
        } else still++;
        state.updateWeights();
      }
      // A strike restores the least overlapping state of this repair, keeping the weights.
      state.load(least);
      state.evaluate();
    }
    return { outcome: "failed", iterations };
  };

  // --- Initial arrangement -------------------------------------------------------------------
  // Until something valid has been scored, a stop would leave the run without a result; with no
  // valid start the shared jitter-free grid (no seeded draw, no repair needed) is scored first.
  if (!ctx.initialEvaluation?.valid && ctx.remaining().evals >= 2) {
    const grid = scatter(ctx.problem, () => 0.5);
    const outcome = await assess(adopt(grid).pieces, "assessment", true);
    if (outcome === false) return;
  }
  let initial: PackingConfig | undefined;
  let random = params.start === "random";
  if (!random && ctx.start?.pieces.length === P) initial = ctx.start;
  if (!random && !initial) {
    const slice = Math.min(ctx.remaining().evals, Math.max(3, Math.min(24, Math.floor(ctx.remaining().evals / 10))));
    const seeded = await ctx.run("seed", { kind: "auto", poolLimit: 0 }, { evals: slice });
    initial = seeded.found ?? seeded.best;
    if (ctx.shouldStop()) return;
    if (!initial || initial.pieces.length !== P) random = true;
  }
  /**
   * Repair the loaded state at `size`, growing the container (and the centres) by `growth`
   * after each failure, until a strict packing is scored; it becomes the current packing.
   * Returns false to end the method.
   */
  const settle = async (size: number, growth: number): Promise<boolean> => {
    for (let attempt = 0; attempt < 60; attempt++) {
      state.setSize(size);
      state.resetWeights();
      const { outcome, iterations } = await repair(explorePatience);
      notify({ kind: "repair", size, best: bestSize, ratio, outcome, iterations });
      if (outcome === "stopped") return false;
      if (outcome === "feasible") {
        const scored = await assess(state.poses, "improvement");
        if (scored === false) return false;
        if (scored) {
          current = scored.pieces;
          currentSize = scored.score;
          return true;
        }
      }
      // A repair that reached feasibility but whose legalisation failed counts as a failure.
      state.scaleCentres(growth);
      size *= growth;
    }
    return true;
  };

  let size: number;
  let settled = false;
  if (initial) {
    const adopted = adopt(initial);
    state.load(adopted.pieces);
    size = adopted.size;
    if (!findOverlaps(N, initial.pieces, 0).length) {
      // A strict start is the packing to shrink from; the framework (or the seed) has scored it.
      best = current = state.snapshot();
      bestSize = currentSize = size;
      settled = true;
    }
  } else {
    // Random poses in a container 30% larger than the area bound, repaired before shrinking.
    size = 1.3 * areaLowerBound(N, ctx.problem.M, P);
    state.setSize(size);
    for (let i = 0; i < P; i++) state.scatterPiece(i, ctx.random);
  }
  notify({ kind: "start", size, best: bestSize, ratio });
  // An invalid start (or a random one) is repaired at its own size, which grows by 5% after
  // each failure, until a strict packing is scored.
  phase = "repairing the start";
  if (!settled && !(await settle(size, 1.05))) return;
  if (!best || !current) return;

  // --- Shrink and repair ---------------------------------------------------------------------
  // Compression: shrink the current packing by `ratio`, which grows after a success and halves
  // after a failure. Once it falls below its minimum the search is at the floor of the current
  // packing's basin and turns to exploration: targets just below it (1 to 4 times the minimum
  // ratio), each from the current packing with a ruined region of a log-uniform number of
  // pieces, repaired with the longer exploration patience. A better packing found that way
  // resumes compression. After `restartAfter` explorations in a row without one, random poses
  // are repaired at a container `restartSlack` larger than the best (growing by 2% on failure)
  // and the result becomes the current packing, whose descendants replace the best only when
  // they beat it.
  let exploring = false;
  let stale = 0;
  while (!ctx.shouldStop()) {
    if (!(await checkpoint())) return;
    if (restartAfter > 0 && stale >= restartAfter) {
      phase = "restarting";
      stale = 0;
      exploring = false;
      ratio = r0;
      const restartSize = bestSize * (1 + restartSlack);
      state.setSize(restartSize);
      for (let i = 0; i < P; i++) state.scatterPiece(i, ctx.random);
      notify({ kind: "restart", size: restartSize, best: bestSize, ratio });
      // The restart's packing replaces the current one even when it is worse.
      currentSize = Infinity;
      const kept: Pose[] | undefined = current;
      if (!(await settle(restartSize, 1.02))) return;
      if (currentSize === Infinity) {
        current = kept;
        currentSize = bestSize;
      }
      continue;
    }
    const r = exploring ? rMin * (1 + 3 * ctx.random()) : ratio;
    const from = currentSize;
    const target = from * (1 - r);
    phase = exploring ? "exploring" : "compressing";
    state.load(current!);
    state.setSize(target);
    state.scaleCentres(1 - r);
    state.resetWeights();
    if (exploring) {
      const count = Math.max(1, Math.round(Math.pow(Math.max(1, maxRuin * P), ctx.random())));
      const kind = state.ruin(count, ctx.random);
      notify({ kind: "disruption", size: target, best: bestSize, ratio: r, ruined: count, ruin: kind });
    }
    const { outcome, iterations } = await repair(exploring ? explorePatience : patience);
    notify({ kind: "repair", size: target, best: bestSize, ratio: r, outcome, iterations });
    if (outcome === "stopped") return;
    if (outcome === "feasible") {
      if ((await assess(state.poses, "improvement")) === false) return;
    }
    // The current packing may also have improved through a periodic assessment.
    if (currentSize < from) {
      ratio = exploring ? Math.max(ratio, 2 * r) : Math.min(rMax, ratio * 1.25);
      exploring = false;
      stale = 0;
    } else if (!exploring) {
      ratio *= 0.5;
      if (ratio < rMin) {
        ratio = rMin;
        exploring = true;
      }
    } else stale++;
  }
}

export { SUCCESS_DEPTH };
