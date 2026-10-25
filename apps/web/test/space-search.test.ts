/**
 * The board's search on a space problem (apps/web/src/space/search.ts): rounds of the real shared
 * job (runSpaceJob) on the current thread through a fake runner, with a fake clock where time
 * matters. Checks seeded reproducibility, that a pause (which ends the round in flight) does not
 * change the result, stop, the time and evaluation budgets, the lower bound, failures, and that
 * every result passes the server's rule.
 */
import { validateSpaceSubmission } from "@polypack/spaces";
import { loadSpacesIndex } from "@polypack/spaces/load";
import { type SpaceJob, type SpaceJobResult, mixSeed, parseSearchProblem, runSpaceJob } from "@polypack/spaces/search";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CancelledRound, type RoundRunner, SpaceSearch, type SpaceSearchProgress } from "../src/space/search";

const index = loadSpacesIndex(resolve(__dirname, "../../.."));

function problemOf(id: string) {
  const space = id.split("/")[0] as "sphere";
  const p = index[space]!.byId.get(id)!;
  return {
    search: parseSearchProblem(id)!,
    rule: { bound: p.bound?.value ?? null, certified: p.certified?.score ?? null },
    start: JSON.parse(p.config!),
  };
}

/** Runs each round on this thread after `delay` ms (so that it can be cancelled before it starts). */
class LocalRunner implements RoundRunner {
  jobs: SpaceJob[] = [];
  cancels = 0;
  private pending: { reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  constructor(
    private answer: (job: SpaceJob) => SpaceJobResult = (job) => runSpaceJob(job, { aborted: false, paused: false }),
    private delay = 0,
    private onRun?: (job: SpaceJob, n: number) => void,
  ) {}
  run(job: SpaceJob): Promise<SpaceJobResult> {
    this.jobs.push(job);
    this.onRun?.(job, this.jobs.length);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        try {
          resolve(this.answer(job));
        } catch (e) {
          reject(e as Error);
        }
      }, this.delay);
      this.pending = { reject, timer };
    });
  }
  cancel(): void {
    const p = this.pending;
    this.pending = null;
    if (!p) return;
    this.cancels++;
    clearTimeout(p.timer);
    p.reject(new CancelledRound());
  }
  dispose(): void {
    this.cancel();
  }
}

const result = (job: SpaceJob, score: number | null, extra: Partial<SpaceJobResult> = {}): SpaceJobResult => ({
  job,
  score,
  valid: score !== null,
  ...(score !== null ? { config: { rho: score, pieces: [] } } : {}),
  evaluations: job.budget.evals ?? 1,
  wallTime: 0,
  termination: "evals",
  reasons: [],
  ...extra,
});

describe("a search on a space problem, in rounds", () => {
  const sphere = problemOf("sphere/4/10");

  it("gives the same result for the same seed, and every result passes the server's rule", async () => {
    const run = async (seed: number) =>
      new SpaceSearch(
        sphere.search,
        sphere.start,
        { seed, budget: { evals: 6000 }, fresh: false, rule: sphere.rule },
        new LocalRunner(),
      ).done;
    const a = await run(3);
    const b = await run(3);
    expect(sphere.rule.bound).toBeLessThan(sphere.start.rho * 0.99);
    expect(a.ended).toBe("evals");
    expect(a.rounds).toBe(3);
    expect(a.evaluations).toBe(6000);
    expect(a.best).not.toBeNull();
    expect(b.best).toEqual(a.best);
    expect(a.best!.seed).toBe(mixSeed(3, a.best!.round));
    const v = validateSpaceSubmission("sphere", "sphere/4/10", a.best!.config, sphere.rule);
    expect(v.valid).toBe(true);
    expect(v.score).toBe(a.best!.score);
    // the start is a candidate of the first round, so the result is never worse than the start
    expect(a.best!.score).toBeLessThanOrEqual(sphere.start.rho);
  });

  it("gives the same result when it is paused in the middle of a round and resumed", async () => {
    const plain = await new SpaceSearch(
      sphere.search,
      sphere.start,
      { seed: 5, budget: { evals: 6000 }, fresh: false, rule: sphere.rule },
      new LocalRunner(),
    ).done;
    let search: SpaceSearch | null = null;
    const states: SpaceSearchProgress["state"][] = [];
    const runner = new LocalRunner(undefined, 5, (_job, n) => {
      // pause while the second round is in flight, resume a little later
      if (n === 2)
        setTimeout(() => {
          search!.pause();
          setTimeout(() => search!.resume(), 20);
        }, 1);
    });
    search = new SpaceSearch(
      sphere.search,
      sphere.start,
      { seed: 5, budget: { evals: 6000 }, fresh: false, rule: sphere.rule, onProgress: (p) => states.push(p.state) },
      runner,
    );
    const paused = await search.done;
    expect(runner.cancels).toBe(1);
    // the interrupted round ran again with the same job
    expect(runner.jobs).toHaveLength(4);
    expect(runner.jobs[2]).toEqual(runner.jobs[1]);
    expect(states).toContain("paused");
    expect(paused.best).toEqual(plain.best);
    expect(paused.rounds).toBe(plain.rounds);
  });

  it("stops at once and keeps the best of the rounds that finished", async () => {
    let search: SpaceSearch | null = null;
    const runner = new LocalRunner(
      (job) => result(job, 2 - runner.jobs.length * 0.1),
      5,
      (_job, n) => {
        if (n === 3) setTimeout(() => search!.stop(), 1);
      },
    );
    search = new SpaceSearch(
      sphere.search,
      null,
      { seed: 1, budget: { evals: 1e6 }, fresh: true, rule: { bound: null } },
      runner,
    );
    const r = await search.done;
    expect(r.ended).toBe("stopped");
    expect(r.rounds).toBe(2);
    expect(r.best?.score).toBeCloseTo(1.8, 12);
    expect(search.state).toBe("stopped");
  });

  it("stops when shouldStop says so", async () => {
    let calls = 0;
    const runner = new LocalRunner((job) => result(job, 2), 1);
    const r = await new SpaceSearch(
      sphere.search,
      null,
      { seed: 1, budget: { evals: 1e6 }, fresh: true, rule: { bound: null }, shouldStop: () => ++calls > 3 },
      runner,
    ).done;
    expect(r.ended).toBe("stopped");
  });

  it("counts only finished rounds against the time budget, and gives a round the time left", async () => {
    let t = 0;
    const runner = new LocalRunner((job) => {
      t += 2;
      return result(job, 2);
    });
    const r = await new SpaceSearch(
      sphere.search,
      sphere.start,
      { seed: 1, budget: { evals: 1e6, time_s: 5 }, fresh: false, rule: { bound: null }, now: () => t },
      runner,
    ).done;
    expect(r.ended).toBe("time");
    expect(r.rounds).toBe(3);
    expect(r.seconds).toBe(6);
    expect(runner.jobs.map((j) => j.budget.time_s)).toEqual([5, 3, 1]);
  });

  it("starts fresh only until it has a result, then from its best", async () => {
    const scores = [null, 3, 2.5];
    const runner = new LocalRunner((job) =>
      result(job, runner.jobs.length <= scores.length ? scores[runner.jobs.length - 1] : 2.5),
    );
    const r = await new SpaceSearch(
      sphere.search,
      sphere.start,
      { seed: 1, budget: { evals: 8000 }, fresh: true, rule: { bound: null } },
      runner,
    ).done;
    expect(runner.jobs.map((j) => j.kind)).toEqual(["fresh", "fresh", "iterate", "iterate"]);
    expect(runner.jobs[2].start).toEqual({ rho: 3, pieces: [] });
    expect(runner.jobs[3].start).toEqual({ rho: 2.5, pieces: [] });
    expect(r.trace.map((p) => p[1])).toEqual([3, 2.5]);
  });

  it("ends at the lower bound, and after three failed rounds in a row", async () => {
    const atBound = await new SpaceSearch(
      sphere.search,
      sphere.start,
      { seed: 1, budget: { evals: 1e6 }, fresh: false, rule: { bound: 2 } },
      new LocalRunner((job) => result(job, 2)),
    ).done;
    expect(atBound.ended).toBe("bound");
    expect(atBound.rounds).toBe(1);

    const failing = new LocalRunner(() => {
      throw new Error("the search thread failed: out of memory");
    });
    const failed = await new SpaceSearch(
      sphere.search,
      sphere.start,
      { seed: 1, budget: { evals: 1e6 }, fresh: false, rule: { bound: null } },
      failing,
    ).done;
    expect(failed.ended).toBe("error");
    expect(failed.rounds).toBe(3);
    expect(failed.reasons).toEqual(["the search thread failed: out of memory"]);
    expect(failed.best).toBeNull();
  });

  it("runs the shared job of each space from its research record", async () => {
    for (const [id, evals] of [
      ["torus/sq/5/7", 2000],
      ["curved/-1/3/4/5", 9],
    ] as const) {
      const p = problemOf(id);
      const r = await new SpaceSearch(
        p.search,
        p.start,
        { seed: 2, budget: { evals }, fresh: false, rule: p.rule },
        new LocalRunner(),
      ).done;
      expect(r.best, id).not.toBeNull();
      expect(validateSpaceSubmission(p.search.space, id, r.best!.config, p.rule).valid, id).toBe(true);
    }
  });
});
