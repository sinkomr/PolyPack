/**
 * The board's runs with a chosen method (apps/web/src/space): rounds of a generic method through
 * the shared job, on a test kernel that stands in for a space's (packages/spaces/test/generic-fixtures.ts),
 * and nofold rounds of the polygon solver's methods (nofold-round.ts). Every result passes the
 * server's rule.
 */
import { validateSpaceSubmission } from "@polypack/spaces";
import { loadSpacesIndex, readEntryConfigSync } from "@polypack/spaces/load";
import {
  type SpaceJob,
  type SpaceJobResult,
  parseSearchProblem,
  runSpaceJob,
  setKernelFactoryForTests,
} from "@polypack/spaces/search";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DISKS,
  disksRule,
  grownDisks,
  restarts,
  withDisks,
  withoutKernels,
} from "../../../packages/spaces/test/generic-fixtures";
import { genericRound } from "../src/space/model";
import { runNofoldRound } from "../src/space/nofold-round";
import { type RoundRunner, SpaceSearch } from "../src/space/search";

afterEach(() => setKernelFactoryForTests(null));

/** Runs each round at once on this thread. */
class LocalRunner implements RoundRunner {
  jobs: SpaceJob[] = [];
  run(job: SpaceJob): Promise<SpaceJobResult> {
    this.jobs.push(job);
    return Promise.resolve(runSpaceJob(job, { aborted: false, paused: false }));
  }
  cancel(): void {}
  dispose(): void {}
}

describe("a board run of a generic method", () => {
  it("runs rounds of the chosen method with its settings, from the best so far, reproducibly", async () => {
    withDisks();
    const search = parseSearchProblem(DISKS)!;
    const start = grownDisks();
    const run = async (seed: number) => {
      const runner = new LocalRunner();
      const r = await new SpaceSearch(
        search,
        start,
        {
          seed,
          budget: { evals: 3 * genericRound(search) },
          fresh: false,
          method: restarts.name,
          params: { mu: 1e5 },
          rule: disksRule,
        },
        runner,
      ).done;
      return { r, jobs: runner.jobs };
    };
    const { r, jobs } = await run(2);
    expect(r.ended).toBe("evals");
    expect(jobs.length).toBeGreaterThanOrEqual(2);
    expect(jobs.every((j) => j.method === restarts.name && j.params?.mu === 1e5)).toBe(true);
    expect(jobs[0].budget.evals).toBe(genericRound(search));
    // the second round starts from the first one's best
    expect(jobs[1].start).not.toEqual(start);
    expect(r.best).not.toBeNull();
    expect(r.best!.score).toBeLessThan(start.size);
    const v = validateSpaceSubmission("curved", DISKS, r.best!.config, disksRule);
    expect(v.valid, v.reasons.join("; ")).toBe(true);
    expect(v.score).toBe(r.best!.score);
    expect((await run(2)).r.best).toEqual(r.best);
  });

  it("ends with the rounds' reason when the method cannot run here", async () => {
    // no kernel: a generic method is refused by every round
    withoutKernels();
    const search = parseSearchProblem(DISKS)!;
    const r = await new SpaceSearch(
      search,
      grownDisks(),
      { seed: 1, budget: { evals: 1e5 }, fresh: false, method: restarts.name, rule: disksRule },
      new LocalRunner(),
    ).done;
    expect(r.ended).toBe("error");
    expect(r.best).toBeNull();
    expect(r.reasons[0]).toMatch(/offers no generic method/);
  });
});

describe("a nofold round of a polygon method", () => {
  const root = resolve(__dirname, "../../..");
  const id = "surface/cube/nofold/4/13";
  const index = loadSpacesIndex(root);
  const entry = index.surface!.byId.get(id)!;
  const start = JSON.parse(readEntryConfigSync(root, index.surface!, entry)!);
  const rule = { bound: entry.bound?.value ?? null, certified: entry.certified?.score ?? null };
  const job = (o: Partial<SpaceJob>): SpaceJob => ({
    space: "surface",
    id,
    seed: 4,
    budget: { time_s: 60, evals: 1500 },
    kind: "iterate",
    start,
    rule,
    ...o,
  });

  it("runs the chosen polygon method on the fullest face and returns a valid packing", async () => {
    for (const method of ["mc_compress", "penalty"]) {
      const r = await runNofoldRound(job({ method }));
      expect(r.valid, `${method}: ${r.reasons.join("; ")}`).toBe(true);
      expect(r.evaluations, method).toBeGreaterThan(0);
      expect(validateSpaceSubmission("surface", id, r.config, rule).valid).toBe(true);
    }
  });

  it("refuses a method or settings the problem does not take", async () => {
    const unknown = await runNofoldRound(job({ method: "warp_drive" }));
    expect(unknown).toMatchObject({ valid: false, termination: "error" });
    expect(unknown.reasons[0]).toMatch(/unknown method "warp_drive"/);
    const bad = await runNofoldRound(job({ method: "penalty", params: { nope: 1 } }));
    expect(bad.termination).toBe("error");
    expect(bad.reasons[0]).toMatch(/^penalty: params: unknown parameter nope/);
  });
});
