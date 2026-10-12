// Soft-to-rigid hardening, after Yohei Nakajima.
//
// The method, its shape paths, its three-phase schedule (compress, follow the path, settle),
// its energy and momentum update, and the default pressure, noise, softness, scale, step counts
// and start area below come from his openly published work, used here with thanks under its
// MIT licence:
//   site        https://yoheinakajima.github.io/soft-to-rigid/
//   repository  https://github.com/yoheinakajima/soft-to-rigid  (engine/engine2d.js, paper/main.pdf)
// PolyPack's part is the generalisation to every regular piece and container on the shared
// penalty geometry, the mapping of evaluation and time budgets onto the schedule, restarts, and
// a grid-based implementation of his legalisation rule, extended to scale together.
// See docs/methods/harden.md.
import { findOverlaps, type PackingConfig } from "@polypack/geometry";
import type { MethodContext, MethodDefinition } from "../framework";
import type { ParameterSchema } from "../schema";
import { restore, scatter } from "./penalty/restoration";
import { HardenDynamics } from "./harden/dynamics";
import { legalise } from "./harden/legalise";
import { SeenArrangements } from "./harden/signature";
import { HARDEN_PATHS, pathShape, softShape, type HardenPath, type SoftShape } from "./harden/shapes";

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

export const hardenMethod: MethodDefinition = {
  name: "harden",
  doc: "docs/methods/harden.md",
  defaults: {
    path: "harden",
    pressure: 0.16,
    noise: 8,
    tau0: 1,
    gamma0: 0.1,
    compressSteps: 2500,
    morphSteps: 7500,
    settleSteps: 1500,
    fill: 3.2,
    restarts: 0,
    evaluationInterval: 32,
  },
  schema: {
    type: "object",
    title: "Soft-to-rigid hardening, after Yohei Nakajima",
    description:
      "Soft-to-rigid hardening, after Yohei Nakajima: compress inscribed disks under inward pressure, harden them into the true polygons, settle, then legalise and score true shapes only. Best of independent seeded restarts.",
    additionalProperties: false,
    properties: {
      path: {
        type: "string",
        title: "Shape path",
        description:
          "harden: inscribed disks become polygons (softness tau from tau0 to 0). grow: rigid pieces grow from scale gamma0 to 1. rigid: true pieces throughout. snap: disks, then polygons at once. grow-area: rigid pieces grown along hardening's area schedule. Circle pieces have no softer shape, so harden, snap and grow-area equal rigid for them.",
        enum: [...HARDEN_PATHS],
        default: "harden",
      },
      pressure: numeric(
        "Inward pressure",
        "Pressure mu on the container size, in units of the piece's inscribed diameter: 3 mu while compressing, mu along the path, decaying to mu/10000 while settling. Default 0.16 is the reference's best-of-runs tuning for harden and rigid (0.08 for grow; median tunings 0.08, 0.04, 0.04).",
        0.16,
        0.0001,
        4,
      ),
      noise: numeric(
        "Noise multiplier",
        "Multiplier nu of the decaying Gaussian noise: positions 0.015 nu while compressing and 0.004 nu along the path, per inscribed diameter; angles 1.5 times that in radians. Default 8 is the reference's tuning for harden; 0 disables noise.",
        8,
        0,
        64,
      ),
      tau0: numeric(
        "Starting softness",
        "Softness tau0 at the start of the harden path: 1 is the inscribed disk, 0 the true polygon. Ignored by the other paths and for circle pieces.",
        1,
        0,
        1,
      ),
      gamma0: numeric(
        "Starting scale",
        "Scale gamma0 of the pieces at the start of the grow path. Default 0.1 is the reference's best-of-runs tuning (median tuning 0.2). Ignored by the other paths.",
        0.1,
        0.01,
        1,
      ),
      compressSteps: numeric(
        "Compression steps",
        "Momentum steps of the compression phase in a full-length run (reference 2,500). An evaluation budget rescales all three phases in proportion so that a run always completes its path.",
        2500,
        0,
        1000000,
        true,
      ),
      morphSteps: numeric(
        "Path steps",
        "Momentum steps along the shape path in a full-length run (reference 7,500).",
        7500,
        1,
        1000000,
        true,
      ),
      settleSteps: numeric(
        "Settling steps",
        "Noise-free momentum steps with the true shape and decaying pressure in a full-length run (reference 1,500).",
        1500,
        0,
        1000000,
        true,
      ),
      fill: numeric(
        "Starting container area",
        "Area of the starting container as a multiple of the total piece area (reference 3.2); pieces start at random poses inside it.",
        3.2,
        1.05,
        50,
      ),
      restarts: numeric(
        "Runs",
        "Independent seeded runs sharing the budget equally. 0 chooses automatically: as many full-length runs as the evaluation budget allows (at least one, shortened if necessary), or runs until the time budget expires.",
        0,
        0,
        100000,
        true,
      ),
      evaluationInterval: numeric(
        "Steps per assessment",
        "Momentum steps between counted assessments. Each assessment legalises the current poses as true shapes and scores them; an evaluation budget of E therefore buys E times this many steps.",
        32,
        1,
        100000,
        true,
      ),
    },
  },
  execute: (ctx) => executeHarden(ctx),
};

/**
 * Counted pair and wall feature tests between cooperative checkpoints (about a millisecond).
 * Counting work instead of reading a clock keeps the checkpoints of a seeded run reproducible;
 * a checkpoint draws no random number and assesses nothing.
 */
export const CHECKPOINT_WORK = 60000;

export interface PhaseSteps {
  compress: number;
  morph: number;
  settle: number;
}

/**
 * Phase lengths of a run of `steps` momentum steps, in the proportion of the full-length run
 * (reference 2500 : 7500 : 1500). The path phase receives the rounding remainder and at least
 * one step. Only a run of a handful of steps can round its settling phase away; what is scored
 * is the legalised true shape in every case. A run from a supplied arrangement has no
 * compression: those steps go to the path.
 */
export function planPhases(steps: number, full: PhaseSteps, compression = true): PhaseSteps {
  const total = full.compress + full.morph + full.settle;
  const count = Math.max(1, Math.floor(steps));
  let compress = Math.round((count * full.compress) / total);
  let settle = Math.round((count * full.settle) / total);
  if (compress + settle >= count) {
    settle = Math.min(settle, count - 1);
    compress = Math.min(compress, count - 1 - settle);
  }
  if (!compression) compress = 0;
  return { compress, morph: count - compress - settle, settle };
}

/**
 * Number of runs for an evaluation allowance: the requested number, or as many full-length runs
 * as fit (at least one). Every run needs one assessment, so the allowance bounds the count.
 */
export function planRuns(evals: number, fullSteps: number, interval: number, restarts: number): number {
  if (!Number.isFinite(evals)) return restarts > 0 ? restarts : Infinity;
  const wanted = restarts > 0 ? restarts : Math.max(1, Math.floor(evals / Math.ceil(fullSteps / interval)));
  return Math.min(wanted, Math.floor(evals));
}

export type HardenPhase = "compress" | "morph" | "settle";

export interface HardenObservation {
  kind: "run" | "step" | "checkpoint" | "assessment" | "end";
  run: number;
  /** Momentum steps completed in this run. */
  step: number;
  phase: HardenPhase;
  /** Phase lengths of this run. */
  plan: PhaseSteps;
  shape: SoftShape;
  /** PolyPack size of the moving container. */
  size: number;
  /** Largest positive violation of the last gradient. */
  violation: number;
  /** Counted feature tests since the previous checkpoint. */
  work: number;
  /** The legalised true-shape configuration of an assessment. */
  config?: PackingConfig;
}

export async function executeHarden(ctx: MethodContext, observe?: (event: HardenObservation) => void): Promise<void> {
  if (!(await ctx.checkpoint())) return;
  const { N, P } = ctx.problem;
  const path = ctx.params.path as HardenPath;
  const options = { tau0: ctx.params.tau0 as number, gamma0: ctx.params.gamma0 as number };
  const interval = ctx.params.evaluationInterval as number;
  const full: PhaseSteps = {
    compress: ctx.params.compressSteps as number,
    morph: ctx.params.morphSteps as number,
    settle: ctx.params.settleSteps as number,
  };
  const fullSteps = full.compress + full.morph + full.settle;
  const limited = Number.isFinite(ctx.remaining().evals);
  const runs = planRuns(ctx.remaining().evals, fullSteps, interval, ctx.params.restarts as number);

  // Hashes of scored arrangements, at most 16,384 short keys however large P is.
  const seen = new SeenArrangements(N);
  // The framework has already scored a supplied start; an identical arrangement is not scored again.
  if (ctx.start?.pieces.length === P) seen.add(ctx.start);

  let work = 0;
  for (let run = 0; run < runs; run++) {
    if (!(await ctx.checkpoint())) return;
    const remaining = ctx.remaining().evals;
    if (remaining < 1) return;
    // A complete supplied arrangement replaces the random start of the first run.
    const supplied = run === 0 && ctx.start?.pieces.length === P ? ctx.start : undefined;
    const state = new HardenDynamics(ctx.problem);
    if (supplied) state.adopt(supplied);
    else state.scatter(ctx.params.fill as number, ctx.random);
    // Pressure and noise in piece length units; see lengthUnit.
    const pressure = (ctx.params.pressure as number) * state.length;
    const noise = (ctx.params.noise as number) * state.length;
    let shape = softShape(N, pathShape(path, 0, N, options));
    let phase: HardenPhase = "compress";
    let violation = 0;
    /** Momentum steps completed in this run. */
    let done = 0;
    let plan: PhaseSteps = { compress: 0, morph: 0, settle: 0 };
    const notify = (kind: HardenObservation["kind"], config?: PackingConfig): void =>
      observe?.({ kind, run, step: done, phase, plan, shape, size: state.size, violation, work, config });
    const due = (): boolean => {
      work += state.work;
      state.work = 0;
      return work >= CHECKPOINT_WORK;
    };
    const pause = (): Promise<boolean> => {
      notify("checkpoint");
      work = 0;
      return ctx.checkpoint();
    };
    // Scans of the legalisation are counted like the gradient's feature tests.
    const scan = (units: number): Promise<boolean> | boolean => {
      work += units;
      return work < CHECKPOINT_WORK || pause();
    };
    /** Legalise the current poses as true shapes and score them; false ends the method. */
    const assess = async (): Promise<boolean> => {
      if (ctx.shouldStop()) return false;
      const raw = state.config();
      // Homothety about the mean centre to first contact: apart if any true pieces overlap
      // (the reference's legalisation), together if none touch. Coincident centres cannot be
      // separated this way and fall through to the seeded shared restoration.
      const contact = await legalise(raw, ctx.shouldStop, scan);
      if (ctx.shouldStop()) return false;
      const legal = restore(contact ?? raw, "expand", ctx.shouldStop, ctx.random);
      // Only an arrangement with no zero-tolerance overlap is ever scored.
      if (!legal || findOverlaps(N, legal.pieces, 0).length) return !ctx.shouldStop();
      if (!seen.add(legal)) return true;
      notify("assessment", legal);
      return (await ctx.evaluate(legal, { autoOrient: false })) !== undefined;
    };

    // Until something valid has been scored, a stop or an expired time budget would leave the run
    // without a result, and the first steps of a large problem take a noticeable time. When the
    // framework holds no valid start and the run can afford it, one arrangement is therefore
    // scored first: the legalised supplied start, or else the shared jitter-free grid, which
    // needs no repair and no seeded draw. This reads no clock: a seeded run always does the same.
    if (run === 0 && !ctx.initialEvaluation?.valid && (!limited || remaining / runs >= 2)) {
      if (supplied) {
        if (!(await assess())) return;
      } else {
        const grid = scatter(ctx.problem, () => 0.5);
        seen.add(grid);
        notify("assessment", grid);
        if (!(await ctx.evaluate(grid, { autoOrient: false }))) return;
      }
    }
    // An evaluation allowance fixes the run length: its share of assessments times the steps each
    // one pays for. Without one every run has the full length and time or stop ends the last run.
    const steps = limited ? Math.floor(ctx.remaining().evals / (runs - run)) * interval : fullSteps;
    plan = planPhases(steps, full, !supplied);
    const total = plan.compress + plan.morph + plan.settle;
    notify("run");
    while (done < total) {
      // Phase, progress u within it, and the reference's pressure and noise for this step.
      let strength = pressure;
      let sigma = 0;
      if (done < plan.compress) {
        phase = "compress";
        strength = 3 * pressure;
        sigma = 0.015 * noise * (1 - done / plan.compress);
      } else if (done < plan.compress + plan.morph) {
        phase = "morph";
        const u = (done - plan.compress) / plan.morph;
        shape = softShape(N, pathShape(path, u, N, options));
        sigma = 0.004 * noise * (1 - u);
      } else {
        phase = "settle";
        shape = softShape(N, pathShape(path, 1, N, options));
        strength = pressure * 10 ** ((-4 * (done - plan.compress - plan.morph)) / plan.settle);
      }
      // One gradient, in parts small enough that a checkpoint is never more than
      // CHECKPOINT_WORK plus one part away.
      const pairs = state.prepare(shape);
      const pairChunk = Math.max(1, Math.floor(CHECKPOINT_WORK / (4 * state.pairCost(shape))));
      for (let from = 0; from < pairs; from += pairChunk) {
        if (due() && !(await pause())) return;
        state.addPairs(from, Math.min(pairs, from + pairChunk));
      }
      const wallChunk = Math.max(1, Math.floor(CHECKPOINT_WORK / (4 * (1 + state.wallCost(shape)))));
      for (let from = 0; from < P; from += wallChunk) {
        if (due() && !(await pause())) return;
        state.addWalls(from, Math.min(P, from + wallChunk));
      }
      const report = state.finish();
      violation = report.violation;
      state.advance(report, strength, sigma, ctx.random);
      done++;
      notify("step");
      // A diverged state cannot be scored or continued; the next run starts afresh.
      if (!state.finite()) break;
      if ((done % interval === 0 || done === total) && !(await assess())) return;
    }
    notify("end");
  }
}
