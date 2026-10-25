/**
 * The board's search on a space problem (apps/web/src/space/search.ts): rounds of the real shared
 * job (runSpaceJob) on the current thread through a fake runner, with a fake clock where time
 * matters. Checks seeded reproducibility, that a pause (which ends the round in flight) does not
 * change the result, stop, the time and evaluation budgets, the lower bound, failures, and that
 * every result passes the server's rule.
 */
import { validateSpaceSubmission } from "@polypack/spaces";
import { loadSpacesIndex, readEntryConfigSync } from "@polypack/spaces/load";
import { type SpaceJob, type SpaceJobResult, mixSeed, parseSearchProblem, runSpaceJob } from "@polypack/spaces/search";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FRESH_EVALS, freshSize, roundSize } from "../src/space/model";
import { CancelledRound, type RoundRunner, SpaceSearch, type SpaceSearchProgress } from "../src/space/search";

const root = resolve(__dirname, "../../..");
const index = loadSpacesIndex(root);

function problemOf(id: string) {
  const space = id.split("/")[0] as "sphere";
  const p = index[space]!.byId.get(id)!;
  return {
    search: parseSearchProblem(id)!,
    rule: { bound: p.bound?.value ?? null, certified: p.certified?.score ?? null },
    // polyhedra configurations are kept apart and read on demand
    start: JSON.parse(readEntryConfigSync(root, index[space]!, p)!),
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
        { seed, budget: { evals: 20000 }, fresh: false, rule: sphere.rule },
        new LocalRunner(),
      ).done;
    const a = await run(3);
    const b = await run(3);
    expect(sphere.rule.bound).toBeLessThan(sphere.start.rho * 0.99);
    expect(a.ended).toBe("evals");
    expect(a.rounds).toBe(2);
    expect(a.evaluations).toBe(20000);
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
      { seed: 5, budget: { evals: 20000 }, fresh: false, rule: sphere.rule },
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
      { seed: 5, budget: { evals: 20000 }, fresh: false, rule: sphere.rule, onProgress: (p) => states.push(p.state) },
      runner,
    );
    const paused = await search.done;
    expect(runner.cancels).toBe(1);
    // the interrupted round ran again with the same job
    expect(runner.jobs).toHaveLength(plain.rounds + 1);
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
      { seed: 1, budget: { evals: 50000 }, fresh: true, rule: { bound: null } },
      runner,
    ).done;
    expect(runner.jobs.map((j) => j.kind)).toEqual(["fresh", "fresh", "iterate", "iterate"]);
    // a fresh round that found nothing doubles the next one
    expect(runner.jobs.map((j) => j.budget.evals)).toEqual([10000, 20000, 10000, 10000]);
    expect(r.evaluations).toBe(50000);
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

  it("loses no round and starts none when pause and resume follow each other in one tick", async () => {
    const plain = await new SpaceSearch(
      sphere.search,
      sphere.start,
      { seed: 9, budget: { evals: 20000 }, fresh: false, rule: sphere.rule },
      new LocalRunner(),
    ).done;
    // pause() then resume() while round 2 is in flight: it runs again, nothing counts as failed
    let search: SpaceSearch | null = null;
    const quick = new LocalRunner(undefined, 5, (_job, n) => {
      if (n === 2)
        setTimeout(() => {
          search!.pause();
          search!.resume();
        }, 1);
    });
    search = new SpaceSearch(
      sphere.search,
      sphere.start,
      { seed: 9, budget: { evals: 20000 }, fresh: false, rule: sphere.rule },
      quick,
    );
    const r = await search.done;
    expect(r.ended).toBe("evals");
    expect(r.reasons).toEqual([]);
    expect(r.rounds).toBe(plain.rounds);
    expect(r.best).toEqual(plain.best);
    expect(quick.jobs[2]).toEqual(quick.jobs[1]);

    // resume() then pause() while paused: the run stays paused and starts no round
    let held: SpaceSearch | null = null;
    const states: string[] = [];
    const runner = new LocalRunner(undefined, 5, (_job, n) => {
      if (n === 2)
        setTimeout(() => {
          held!.pause();
          setTimeout(() => {
            held!.resume();
            held!.pause();
            setTimeout(() => {
              states.push(held!.state);
              const started = runner.jobs.length;
              setTimeout(() => {
                // still paused, and no round started meanwhile
                states.push(held!.state, String(runner.jobs.length - started));
                held!.resume();
              }, 30);
            }, 5);
          }, 5);
        }, 1);
    });
    held = new SpaceSearch(
      sphere.search,
      sphere.start,
      { seed: 9, budget: { evals: 20000 }, fresh: false, rule: sphere.rule },
      runner,
    );
    const again = await held.done;
    expect(states).toEqual(["paused", "paused", "0"]);
    expect(again.best).toEqual(plain.best);
  });

  it("keeps a fold round within the evaluations it is given", async () => {
    const fold = problemOf("surface/cube/fold/0/10");
    const runner = new LocalRunner();
    const r = await new SpaceSearch(
      fold.search,
      fold.start,
      { seed: 1, budget: { evals: 5 }, fresh: false, rule: fold.rule },
      runner,
    ).done;
    expect(r.evaluations).toBeLessThanOrEqual(5);
    // a round of 4 compressions (the start and 3 hops), then one of 1 (the start only)
    expect(runner.jobs.map((j) => j.budget.evals)).toEqual([3, 0]);
    expect(r.best).not.toBeNull();
  });
});

describe("a new arrangement on a free torus", () => {
  it("goes on from a left-handed basis (a fresh torus search returns one for some seeds)", async () => {
    // built explicitly: which seeds give det < 0 depends on the Node version's floating point
    const p = problemOf("torus/free/5/7");
    const s = p.start as { lattice: { b1: number[]; b2: number[] } };
    const det = (l: { b1: number[]; b2: number[] }) => l.b1[0] * l.b2[1] - l.b1[1] * l.b2[0];
    // the same lattice with b2 negated
    const left = { ...s, lattice: { b1: s.lattice.b1, b2: [-s.lattice.b2[0], -s.lattice.b2[1]] } };
    expect(det(left.lattice)).toBeLessThan(0);
    const runner = new LocalRunner();
    const r = await new SpaceSearch(
      p.search,
      left,
      { seed: 2, budget: { evals: 4000 }, fresh: false, rule: p.rule },
      runner,
    ).done;
    expect(det((runner.jobs[0].start as typeof left).lattice)).toBeLessThan(0);
    expect(r.ended).toBe("evals");
    expect(r.reasons).toEqual([]);
    expect(r.rounds).toBe(1);
  });
});

describe("a new arrangement, within the panel's default budget", () => {
  // the first round alone, half of the default 20,000 evaluations, without the time limit so that
  // the test does not depend on the machine
  for (const id of ["sphere/0/12", "sphere/4/30", "torus/sq/5/7", "torus/free/4/12"])
    it(`finds a valid packing of ${id} from nothing in its first round`, async () => {
      const p = problemOf(id);
      const kind = p.search.space as "sphere" | "torus";
      for (const seed of [1, 2]) {
        const r = await new SpaceSearch(
          p.search,
          null,
          { seed, budget: { evals: FRESH_EVALS[kind] }, fresh: true, rule: p.rule },
          new LocalRunner(),
        ).done;
        expect(r.rounds).toBe(1);
        expect(r.best, `${id}, seed ${seed}`).not.toBeNull();
        expect(validateSpaceSubmission(p.search.space, id, r.best!.config, p.rule).valid).toBe(true);
      }
    });
});

describe("a run from a tight packing, with the panel's default budget", () => {
  // the start: the best of a new arrangement with seed 4 (10,000 evaluations), then a run from
  // it with 20,000 evaluations (the default, without the time limit) and seed 9
  // A clear gain, not an exact value: seeded results differ between Node versions (CI runs Node 24),
  // and ten rounds of 2,000 evaluations from such a start gained nothing at all.
  for (const [id, gain] of [
    ["sphere/4/30", 0.005],
    ["torus/free/4/12", 0.005],
  ] as const)
    it(`improves ${id} by more than ${gain * 100}%`, async () => {
      const p = problemOf(id);
      const fresh = await new SpaceSearch(
        p.search,
        null,
        { seed: 4, budget: { evals: 10000 }, fresh: true, rule: p.rule },
        new LocalRunner(),
      ).done;
      const start = fresh.best!;
      const r = await new SpaceSearch(
        p.search,
        start.config,
        { seed: 9, budget: { evals: 20000 }, fresh: false, rule: p.rule },
        new LocalRunner(),
      ).done;
      expect(r.best!.score).toBeLessThan(start.score * (1 - gain));
      expect(validateSpaceSubmission(p.search.space, id, r.best!.config, p.rule).valid).toBe(true);
    });
});

describe("3D in 3D: rounds of the polyhedra search", () => {
  it("builds a valid packing from nothing in its first round", async () => {
    for (const id of ["polyhedra/cubincub/5", "polyhedra/tetintet/4"]) {
      const p = problemOf(id);
      for (const seed of [1, 2]) {
        const r = await new SpaceSearch(
          p.search,
          null,
          { seed, budget: { evals: freshSize(p.search) }, fresh: true, rule: p.rule },
          new LocalRunner(),
        ).done;
        expect(r.rounds).toBe(1);
        expect(r.best, `${id}, seed ${seed}`).not.toBeNull();
        expect(validateSpaceSubmission("polyhedra", id, r.best!.config, p.rule).valid).toBe(true);
      }
    }
  });

  it("runs rounds from the record with the run's seeds, reproducibly, never worse than the record", async () => {
    const id = "polyhedra/cubincub/11";
    const p = problemOf(id);
    const run = (runner: LocalRunner) =>
      new SpaceSearch(p.search, p.start, { seed: 7, budget: { evals: 2 * roundSize(p.search) }, fresh: false, rule: p.rule }, runner)
        .done;
    const a = new LocalRunner();
    const b = new LocalRunner();
    const [ra, rb] = [await run(a), await run(b)];
    expect(a.jobs.map((j) => j.seed)).toEqual([mixSeed(7, 0), mixSeed(7, 1)]);
    expect(a.jobs.every((j) => j.budget.evals === roundSize(p.search))).toBe(true);
    expect(ra.ended).toBe("evals");
    expect(ra.best).not.toBeNull();
    expect(rb.best!.config).toEqual(ra.best!.config);
    expect(ra.best!.score).toBeLessThanOrEqual(p.start.s);
    expect(validateSpaceSubmission("polyhedra", id, ra.best!.config, p.rule).valid).toBe(true);
  });
});
