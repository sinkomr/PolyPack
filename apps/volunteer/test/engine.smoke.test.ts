/**
 * The engine with the real solver, through inlineRunJob, on five squares in a square. Each job is
 * capped by its evaluation budget with a generous time budget, and the clock is fake (one second
 * per 1000 evaluations), so the result does not depend on the machine's speed.
 */
import { evaluate, findOverlaps } from "@polypack/geometry";
import { strictTolerance } from "@polypack/solver";
import { expect, it } from "vitest";
import { inlineRunJob, searchProblem } from "../src/engine";
import type { JobResult, RunJob } from "../src/types";

const OPTIMUM = 2 + Math.SQRT1_2;

// A short smoke: about 8,000 evaluations of the real solver return a sound, strict packing. That it
// reaches the known optimum (about 35,000 evaluations) is checked in engine.quality.test.ts.
it("returns a strict five-square packing with the real solver", { timeout: 120_000 }, async () => {
  let clock = 0;
  const results: JobResult[] = [];
  const runJob: RunJob = async (job, control) => {
    expect(job.budget.evals).toBeGreaterThan(0);
    // The time budget is in fake seconds; a real one this long never binds
    const result = await inlineRunJob({ ...job, budget: { ...job.budget, time_s: 600 } }, control);
    clock += Math.max(1, result.evaluations) / 1000;
    results.push(result);
    return { ...result, job };
  };
  const outcome = await searchProblem(
    {
      problem: { N: 4, M: 4, P: 5 },
      leader: null,
      published: OPTIMUM,
      areaBound: Math.sqrt(5),
      maxSeconds: 8,
      lanes: 1,
      seed: 1,
      now: () => clock,
    },
    runJob,
    { aborted: false, paused: false },
  );

  expect(results.every((r) => r.termination !== "error" && r.termination !== "time")).toBe(true);
  expect(results.at(-1)!.job.method).toBe("polish");
  expect(clock).toBeLessThanOrEqual(8);
  const best = outcome.best!;
  expect(best.strict).toBe(true);
  const assessed = evaluate(best.config);
  expect(assessed.valid).toBe(true);
  expect(Math.abs(assessed.score! - best.score)).toBeLessThan(1e-9);
  expect(findOverlaps(4, best.config.pieces, strictTolerance(best.config))).toEqual([]);
  // never below the known optimum, 2 + 1/sqrt 2; reaching it is the quality test's
  expect(best.score).toBeGreaterThan(OPTIMUM - 1e-9);
});
