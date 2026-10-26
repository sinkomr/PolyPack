/**
 * One search job on a space problem, run synchronously on a search thread: a thread of the
 * volunteer client (its pool.ts sends the job, its worker.ts runs it here) or the board's Web
 * Worker (apps/web/src/space/worker.ts). The searches of the space packages are synchronous code,
 * so they cannot read the thread's messages while they work; the volunteer's pool also writes the
 * job's stop and pause flags into memory shared with the thread (SpaceControl), and a Gate polls
 * them (the board instead ends a job by ending its worker, and runs short jobs):
 *
 *  - aborted: the search ends at its next poll and returns its best so far;
 *  - paused: the search blocks in the poll until resumed, and that time is not counted;
 *  - the job's time budget is active seconds, pauses excluded, checked at each poll.
 *
 * Engines, each seeded by the job's seed:
 *  - surface (fold): the fold search of packages/surface (penalty compression on the solid, basin
 *    hopping, contact-LP polish; surface-fold.ts), with its compressions as the evaluation budget.
 *    It searches for four fifths of the job's time; the final polish gets the rest and
 *    SURFACE_FINAL_OVERRUN s more;
 *  - curved: solve of packages/curved (random or warm start, penalty compression, SLP polish,
 *    basin hopping), run in rounds of one start and up to 8 hops, each round seeded from the job's
 *    seed and started from the best so far; the hop count is the evaluation budget. The search
 *    polls the gate inside each restart and hop too (its shouldStop option);
 *  - sphere and torus: searchSphere and searchTorus of their packages (penalty relaxation, a
 *    tight-size bisection with the float validator, basin hopping), budgeted by evaluations;
 *  - boundary: searchBoundary of packages/boundary (penalty relaxation in each piece's cell,
 *    compression of the edge s, polish, hops), budgeted by its energy evaluations, one call per
 *    job. Its time is the gate's (active seconds, polled through shouldStop at every evaluation),
 *    so it gets no time_s of its own, which would count pauses. One call is a whole search (the
 *    start compressed and polished, then random starts and hops); a fresh job gets no start. It
 *    ends "bound" when its best reaches its own floor (engine.ts then stops the problem). Its word
 *    tables cost about 50 ms once per thread.
 *  - polyhedra: searchPolyhedra of packages/polyhedra (a start is legalized and polished, else a
 *    soft-to-rigid run packs one; then soft hops and jiggles, each polished by a separating-plane
 *    penalty method), budgeted by evaluations: simulator steps and polish evaluations.
 *  - balls: searchBalls of packages/balls (a start is legalized and polished, else a lattice cut or random
 *    centres; then hops from the best, each polished by a penalty method with the container size as a variable;
 *    solids in a ball by separating planes), budgeted by its objective evaluations.
 * Surface problems in the nofold mode on the Platonic solids are planar problems and run on the
 * polygon solver instead (nofold.ts has the conversion); they never reach this file. On the other
 * solids (Catalan solids, prisms, antiprisms) the faces are not all one regular polygon, and their
 * nofold problems run here: the surface search above in its nofold mode, every piece kept inside
 * its own face.
 *
 * Those engines are the method "auto", the default. A job may instead name a generic method of
 * @polypack/methods that the problem offers (methods.ts spaceMethodsFor): it then runs that method
 * on the problem's kernel (kernels.ts) with the job's seed, parameters and start, its evaluations
 * (the kernel's energy evaluations) capped by `evals` when the job has a cap, and the gate's time
 * and pauses through shouldStop, polled at every kernel call. The method keeps an improvement only
 * when it passes the job's whole rule. A method or parameters the problem does not take give an
 * error result. A generic method ends "bound" at its kernel's bound, which can lie above the
 * problem's (engine.ts says what the volunteer client makes of it).
 *
 * Every result is checked here by the server's rule (model.ts checkSpaceConfig, with the job's
 * bound and certified size); the start, when it passes, is a candidate too, so a job never returns
 * worse than what it was given.
 */
import { type BoundaryConfig, searchBoundary } from "@polypack/boundary";
import { solve as solveCurved } from "@polypack/curved";
import { searchSphere } from "@polypack/sphere";
import { getSolid } from "@polypack/surface";
import { searchTorus } from "@polypack/torus";
import { type PolyhedraConfig, getProblem as getPolyhedraProblem, searchPolyhedra } from "@polypack/polyhedra";
import { type BallsConfig, getBallsProblem, searchBalls } from "@polypack/balls";
import { type SpaceKernel, runMethod } from "@polypack/methods";
import type { SpaceConfig, SpaceName } from "../types";
import { spaceKernel } from "./kernels";
import { AUTO, checkSpaceMethod, isAutoMethod } from "./methods";
import {
  type SearchProblem,
  type SpaceRule,
  checkSpaceConfig,
  nofoldOnPolygonEngine,
  parseSearchProblem,
  readSpaceConfig,
  torusConfigOf,
  torusPackingOf,
} from "./model";
import { mixSeed } from "./seed";
import { surfaceFoldSearch } from "./surface-fold";

export interface SpaceJob {
  space: SpaceName;
  id: string;
  /**
   * "auto" (the default): the space's own search; or a generic method the problem offers
   * (methods.ts spaceMethodsFor). The space's SPACE_METHOD, which jobs carried before methods could
   * be chosen, also means auto. spaceMethodName gives the name a result is recorded under.
   */
  method?: string;
  /** The method's parameters over its defaults; auto takes none. */
  params?: Record<string, unknown>;
  /** Integer from 0 to 2^32 - 1. */
  seed: number;
  /** Active seconds, pauses excluded; `evals` caps the run further (see each engine). */
  budget: { time_s: number; evals?: number };
  /** Configuration to start from; without it the engine builds its own. */
  start?: SpaceConfig;
  /**
   * True when the start is this search's own result, already polished (the best of a board's previous
   * round): polyhedra and balls take it as it is instead of polishing it again. Ignored by the other spaces.
   */
  polished?: boolean;
  /** The problem's bound and certified size, so that results are checked by the server's whole rule. */
  rule?: SpaceRule;
  /** "polish" only for nofold results, which come from the polygon engine's jobs. */
  kind: "warm" | "iterate" | "fresh" | "polish";
}

export interface SpaceJobResult {
  job: SpaceJob;
  /** Score of the best valid configuration, or null when there is none. */
  score: number | null;
  valid: boolean;
  config?: SpaceConfig;
  evaluations: number;
  /** Active seconds. */
  wallTime: number;
  /** "evals", "time", "aborted", "done", "error", or "crashed" when the thread was lost. */
  termination: string;
  reasons: string[];
}

export const isSpaceJob = (job: unknown): job is SpaceJob =>
  typeof job === "object" &&
  job !== null &&
  typeof (job as SpaceJob).space === "string" &&
  typeof (job as SpaceJob).id === "string";

/** Stop and pause flags as a synchronous search sees them. */
export interface SpaceControl {
  readonly aborted: boolean;
  readonly paused: boolean;
  /** Blocks for up to `ms` or until the flags change; default a plain sleep. */
  wait?(ms: number): void;
}

/** Seconds the surface fold search's final stage may run past the job's budget. */
export const SURFACE_FINAL_OVERRUN = 1.5;

/**
 * Evaluations of one boundary job when its caller sets the size by evaluations, as the board's
 * rounds do: [CALC] 300,000 took 1.5 to 2.2 s on balls and cubes of P = 16 on an Apple Silicon
 * laptop (about 140,000 to 190,000 a second), as long as a sphere or torus round of 10,000; the
 * search's builder reports that most research values are reached within 300,000 (balls P = 6 and
 * 9 need 0.6 to 9 million). A job's own budget.evals overrides it; the volunteer client sizes its
 * jobs by time instead.
 */
export const BOUNDARY_ROUND_EVALS = 300_000;

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Time and stop checks of one job, polled by the engines. */
export class Gate {
  why: "aborted" | "time" | null = null;
  private active = 0;
  private last: number;
  constructor(
    readonly control: SpaceControl,
    readonly seconds: number,
    readonly clock: () => number = () => performance.now() / 1000,
  ) {
    this.last = clock();
  }

  private account(): void {
    const t = this.clock();
    this.active += t - this.last;
    this.last = t;
  }

  /** Active seconds so far. */
  get elapsed(): number {
    this.account();
    return this.active;
  }

  /** True once the job must end (and from then on); blocks while paused. */
  stop(): boolean {
    return this.stopAt(this.seconds);
  }

  /**
   * As stop(), for a phase that ends after `limit` active seconds of the job, before its budget
   * (a search phase that leaves time for a final polish) or after it (that polish).
   */
  stopAt(limit: number): boolean {
    if (this.why === "aborted") return true;
    if (this.control.aborted) {
      this.why = "aborted";
      return true;
    }
    if (this.control.paused) {
      this.account();
      while (this.control.paused && !this.control.aborted) (this.control.wait ?? sleepSync).call(this.control, 200);
      // the pause is not active time
      this.last = this.clock();
      if (this.control.aborted) {
        this.why = "aborted";
        return true;
      }
    }
    this.account();
    if (this.active >= this.seconds) this.why ??= "time";
    return this.active >= limit;
  }

  remainingMs(): number {
    return Math.max(0, (this.seconds - this.elapsed) * 1000);
  }
}

/** Runs one space job to its end. Never throws: failures are results. */
export function runSpaceJob(job: SpaceJob, control: SpaceControl, clock?: () => number): SpaceJobResult {
  const gate = new Gate(control, Math.max(0, job.budget.time_s), clock);
  const fail = (termination: string, reason: string): SpaceJobResult => ({
    job,
    score: null,
    valid: false,
    evaluations: 0,
    wallTime: gate.elapsed,
    termination,
    reasons: [reason],
  });
  const p = parseSearchProblem(job.id);
  if (!p || p.space !== job.space)
    return fail("error", `not a problem id of ${job.space}: ${String(job.id).slice(0, 80)}`);
  if (nofoldOnPolygonEngine(p)) return fail("error", "nofold problems of the Platonic solids run on the polygon engine");
  const why = checkSpaceMethod(p, job.method, job.params);
  if (why) return fail("error", why);
  const start = job.start === undefined ? undefined : (readSpaceConfig(p, job.start) ?? undefined);
  if (job.start !== undefined && !start) return fail("error", "the start is not a configuration of this problem");
  // the best valid configuration: the start, then whatever the engine returns
  let best: { config: SpaceConfig; score: number } | null = null;
  const consider = (config: SpaceConfig | null | undefined) => {
    if (!config) return;
    const c = checkSpaceConfig(p.space, p.id, config, job.rule);
    if (c.valid && c.score !== null && (!best || c.score < best.score)) best = { config, score: c.score };
  };
  if (start) consider(start);
  let evaluations = 0;
  let ran = "done";
  let failure: string[] = [];
  try {
    const out = isAutoMethod(p.space, job.method) ? runEngine(p, job, start, gate) : runGeneric(p, job, start, gate);
    evaluations = out.evaluations;
    ran = out.termination;
    failure = out.reasons ?? [];
    consider(out.config);
  } catch (error) {
    return { ...fail("error", (error as Error)?.message ?? String(error)), evaluations };
  }
  const b = best as { config: SpaceConfig; score: number } | null;
  return {
    job,
    score: b ? b.score : null,
    valid: b !== null,
    ...(b ? { config: b.config } : {}),
    evaluations,
    wallTime: gate.elapsed,
    termination: gate.why ?? ran,
    reasons: failure.length ? failure : b ? [] : ["no valid configuration found"],
  };
}

/**
 * A generic method on the problem's kernel (checkSpaceMethod has made sure it has one that offers
 * the method). A fresh job gets no start, as in the boundary search; the start is still a
 * candidate (runSpaceJob). The method keeps an improvement only when it passes the job's whole
 * rule (its bound, certified size and any other flag), which replaces the kernel's own check;
 * runSpaceJob checks the result once more. A job without an evaluation cap runs on the gate alone,
 * so that a method does not size its work to a cap it does not have.
 */
function runGeneric(
  p: SearchProblem,
  job: SpaceJob,
  start: SpaceConfig | undefined,
  gate: Gate,
): { config: SpaceConfig | null; evaluations: number; termination: string; reasons: string[] } {
  const own = spaceKernel(p);
  if (!own) throw new Error(`${p.id} has no kernel`);
  const kernel: SpaceKernel = { ...own, validate: (config) => checkSpaceConfig(p.space, p.id, config, job.rule) };
  const r = runMethod(kernel, job.method ?? AUTO, {
    seed: job.seed,
    ...(job.params ? { params: job.params } : {}),
    ...(start && job.kind !== "fresh" ? { start } : {}),
    budget: job.budget.evals === undefined ? {} : { evals: job.budget.evals },
    shouldStop: () => gate.stop(),
  });
  return {
    config: r.config as SpaceConfig | null,
    // a piece's share of a sweep counts 1/P, so the count can be fractional
    evaluations: Math.round(r.evaluations),
    termination: r.stopped,
    reasons: r.stopped === "error" ? r.reasons : [],
  };
}

function runEngine(
  p: SearchProblem,
  job: SpaceJob,
  start: SpaceConfig | undefined,
  gate: Gate,
): { config: SpaceConfig | null; evaluations: number; termination: string; reasons?: string[] } {
  const cap = job.budget.evals ?? Number.MAX_SAFE_INTEGER;
  const shouldStop = () => gate.stop();
  switch (p.space) {
    case "balls": {
      // the search polls shouldStop at every evaluation and in the work between them
      const r = searchBalls(getBallsProblem(p.code)!, p.P, {
        seed: job.seed,
        start: start as unknown as BallsConfig | undefined,
        startPolished: job.polished === true && start !== undefined,
        maxEvals: cap,
        shouldStop,
      });
      return { config: r.config as unknown as SpaceConfig | null, evaluations: r.evaluations, termination: r.stopped };
    }
    case "polyhedra": {
      // the search counts simulator steps and polish evaluations; it polls shouldStop at each of them and in the work between them
      const r = searchPolyhedra(getPolyhedraProblem(p.code)!, p.P, {
        seed: job.seed,
        start: start as unknown as PolyhedraConfig | undefined,
        startPolished: job.polished === true && start !== undefined,
        maxEvals: cap,
        shouldStop,
      });
      return {
        config: r.config as unknown as SpaceConfig | null,
        evaluations: r.evaluations,
        termination: r.stopped,
      };
    }
    case "sphere": {
      const r = searchSphere({ N: p.N, P: p.P }, { seed: job.seed, start: start as never, maxEvals: cap, shouldStop });
      return { config: r.config as unknown as SpaceConfig | null, evaluations: r.evaluations, termination: r.stopped };
    }
    case "torus": {
      const r = searchTorus(
        { family: p.family, N: p.N, P: p.P },
        { seed: job.seed, start: start ? torusPackingOf(p, start) : undefined, maxEvals: cap, shouldStop },
      );
      return {
        config: r.packing ? torusConfigOf(p, r.packing) : null,
        evaluations: r.evaluations,
        termination: r.stopped,
      };
    }
    case "curved": {
      const problem = { N: p.N, M: p.M, P: p.P };
      let best = start
        ? { size: start.size as number, pieces: start.pieces as { x: number; y: number; theta: number }[] }
        : undefined;
      let done = 0;
      for (let round = 0; done < cap && !gate.stop(); round++) {
        const hops = Math.min(8, Math.max(0, cap - done - 1));
        const r = solveCurved(problem, p.K, {
          seed: mixSeed(job.seed, round),
          restarts: 1,
          hops,
          start: job.kind === "fresh" && round === 0 ? undefined : best,
          timeLimitMs: Math.max(50, Math.min(5000, gate.remainingMs())),
          // a start's repair and compression take many L-BFGS runs; on large problems shorter ones
          // keep a round to a few seconds (30 disks: 2 s instead of 8 s, same result)
          ...(p.P > 12 ? { lbfgsIter: 150 } : {}),
          // polled inside the round's restart and hops too
          shouldStop,
        });
        done += r.restartsDone + r.hopsDone;
        if (r.found && r.config && r.validation?.valid && (!best || r.config.size < best.size)) best = r.config;
        if (r.restartsDone + r.hopsDone === 0) break;
      }
      return {
        config: (best as unknown as SpaceConfig) ?? null,
        evaluations: done,
        termination: done >= cap ? "evals" : "done",
      };
    }
    case "surface": {
      const solid = getSolid(p.solid);
      const warm = start
        ? [
            {
              label: "start",
              lam: 1 / (start.s as number),
              poses: (start.pieces as { face: number; x: number; y: number; theta: number }[]).map((q) => ({
                face: q.face,
                x: q.x / (start.s as number),
                y: q.y / (start.s as number),
                theta: q.theta,
              })),
            },
          ]
        : [];
      // the search leaves the last fifth of the budget to the final tightening and polish, which
      // may run on for SURFACE_FINAL_OVERRUN s more
      const r = surfaceFoldSearch(solid, p.N, p.P, {
        seed: job.seed,
        randomStarts: warm.length ? 0 : 2,
        hops: Math.min(cap, 1_000_000),
        warm,
        stop: () => gate.stopAt(gate.seconds * 0.8),
        finalStop: () => gate.stopAt(gate.seconds + SURFACE_FINAL_OVERRUN),
        mode: p.mode,
      });
      if (!r) return { config: null, evaluations: 0, termination: "done" };
      const s = 1 / r.lam;
      const config = { s, pieces: r.poses.map((q) => ({ face: q.face, x: q.x * s, y: q.y * s, theta: q.theta })) };
      return { config, evaluations: r.compressions, termination: r.compressions >= cap ? "evals" : "done" };
    }
    case "boundary": {
      const r = searchBoundary(
        { polytope: p.polytope, piece: p.piece, P: p.P },
        {
          seed: job.seed,
          // a fresh job builds its own starts; the given start is still a candidate (runSpaceJob)
          start: job.kind === "fresh" ? undefined : (start as unknown as BoundaryConfig | undefined),
          budget: { evals: cap },
          shouldStop,
        },
      );
      return { config: r.config as unknown as SpaceConfig | null, evaluations: r.evals, termination: r.ended };
    }
  }
}
