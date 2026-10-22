/**
 * The engine against a fake runJob and a fake clock: jobs "run" for a scripted number of fake
 * seconds and return scripted packings, and the clock moves only when a job ends, earliest end
 * first. Everything here is deterministic.
 */
import type { PackingConfig } from "@polypack/geometry";
import { describe, expect, it } from "vitest";
import { POLICY, armsFor, familyKey, makePlan, searchProblem } from "../src/engine";
import type { Candidate, Control, Job, JobResult, Problem, RunJob, SearchInput, SearchOutcome } from "../src/types";

const SQUARES: Problem = { N: 4, M: 4, P: 10 };

/** A distinct fake packing; the engine checks only N, M, P and the piece count. */
function packing(problem: Problem, name: string): PackingConfig {
  return {
    N: problem.N,
    M: problem.M,
    P: problem.P,
    pieces: Array.from({ length: problem.P }, (_, i) => ({ x: i, y: 0, theta: 0 })),
    container_phi: 0,
    name,
  };
}

interface Answer {
  score?: number | null;
  strict?: boolean;
  /** Fake seconds the job runs; 0.8 of its time budget when left out, like an evaluation cap. */
  seconds?: number;
  termination?: string;
  config?: PackingConfig;
  /** Thrown synchronously by runJob. */
  throws?: unknown;
  /** Rejected by runJob's promise. */
  rejects?: unknown;
}

interface Record_ {
  job: Job;
  index: number;
  at: number;
  end: number;
  result?: JobResult;
}

type Script = (job: Job, index: number, sim: Sim) => Answer;

class Sim {
  clock = 0;
  readonly jobs: Record_[] = [];
  /** Finished jobs in the order their results were delivered. */
  readonly finished: Record_[] = [];
  inFlight = 0;
  maxInFlight = 0;
  /** The best strict result delivered so far, mirroring the engine's rule. */
  best: { score: number; config: PackingConfig } | null = null;
  private readonly pending: { record: Record_; deliver: () => void }[] = [];
  private scheduled = false;

  constructor(
    private readonly script: Script,
    readonly control: Control = { aborted: false, paused: false },
  ) {}

  readonly now = () => this.clock;

  readonly runJob: RunJob = (job) => {
    const index = this.jobs.length;
    const answer = this.script(job, index, this);
    const record: Record_ = { job, index, at: this.clock, end: this.clock };
    this.jobs.push(record);
    if (answer.throws !== undefined) throw answer.throws;
    record.end = this.clock + (answer.seconds ?? job.budget.time_s * 0.8);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    return new Promise<JobResult>((resolve, reject) => {
      this.pending.push({
        record,
        deliver: () => {
          this.inFlight -= 1;
          this.finished.push(record);
          if (answer.rejects !== undefined) return reject(answer.rejects);
          const result = makeResult(job, answer, record.end - record.at);
          record.result = result;
          if (result.valid && result.strict && result.best && (!this.best || result.score! < this.best.score))
            this.best = { score: result.score!, config: result.best };
          resolve(result);
        },
      });
      this.schedule();
    });
  };

  /** Delivers one result per macrotask, after the engine has started all it wants to start. */
  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      if (!this.pending.length) return;
      this.pending.sort((a, b) => a.record.end - b.record.end || a.record.index - b.record.index);
      const next = this.pending.shift()!;
      // An aborted job ends at once
      if (this.control.aborted) next.record.end = Math.min(next.record.end, this.clock);
      this.clock = Math.max(this.clock, next.record.end);
      next.deliver();
      if (this.pending.length) this.schedule();
    });
  }
}

function makeResult(job: Job, answer: Answer, seconds: number): JobResult {
  const score = answer.score ?? null;
  const valid = score !== null;
  return {
    job,
    score,
    valid,
    strict: valid && answer.strict !== false,
    best: valid ? (answer.config ?? packing(job.problem, `${job.method}#${job.seed}`)) : undefined,
    params: job.params ?? {},
    evaluations: job.budget.evals ?? 100,
    wallTime: seconds,
    termination: answer.termination ?? (valid ? "evals" : "error"),
    reasons: [],
  };
}

function search(
  sim: Sim,
  overrides: Partial<SearchInput> = {},
): Promise<SearchOutcome & { results: [JobResult, Candidate | null][] }> {
  const results: [JobResult, Candidate | null][] = [];
  const input: SearchInput = {
    problem: SQUARES,
    leader: null,
    published: null,
    areaBound: Math.sqrt(10),
    maxSeconds: 3600,
    lanes: 4,
    seed: 7,
    now: sim.now,
    onResult: (result, best) => results.push([result, best]),
    ...overrides,
  };
  return searchProblem(input, sim.runJob, sim.control).then((outcome) => ({ ...outcome, results }));
}

/** The engine's plan for SQUARES without memory. */
function planFor(maxSeconds: number, lanes: number, withKnown = false) {
  const arms = armsFor(SQUARES).filter((arm) => withKnown || arm.start !== "warm").length;
  return makePlan(maxSeconds, lanes, arms, 1 / (POLICY.secondsPerEvaluationPerPiece * SQUARES.P));
}

/** Every job improves on all earlier ones: strictly decreasing scores by job index. */
const improving: Script = (_job, index) => ({ score: 5 * (1 - 1e-5) ** index });

describe("engine: lanes and time", () => {
  it("keeps every lane busy and never more", async () => {
    for (const lanes of [1, 4, 7]) {
      const sim = new Sim(improving);
      await search(sim, { lanes, maxSeconds: 400 });
      expect(sim.maxInFlight).toBe(lanes);
      // The first wave starts all lanes at once
      expect(sim.jobs.filter((r) => r.at === 0)).toHaveLength(lanes);
    }
  });

  it("never starts a job whose budget would end past maxSeconds, the final polish included", async () => {
    for (const maxSeconds of [7, 95, 600, 2000]) {
      const sim = new Sim(improving);
      const outcome = await search(sim, { maxSeconds });
      expect(outcome.stopped).toBe("time");
      for (const r of sim.jobs) expect(r.at + r.job.budget.time_s).toBeLessThanOrEqual(maxSeconds + 1e-9);
      expect(sim.clock).toBeLessThanOrEqual(maxSeconds);
      expect(sim.jobs.at(-1)!.job.method).toBe("polish");
    }
  });

  it("starts nothing when there is no time", async () => {
    const sim = new Sim(improving);
    const outcome = await search(sim, { maxSeconds: 0 });
    expect(outcome).toMatchObject({ best: null, jobs: 0, stopped: "time" });
    expect(sim.jobs).toHaveLength(0);
  });

  it("gives every job an evaluation cap and a budget between T0 / 2 and the cap", async () => {
    const sim = new Sim(improving);
    await search(sim, { maxSeconds: 3000 });
    const plan = planFor(3000, 4);
    for (const { job } of sim.jobs) {
      expect(Number.isInteger(job.budget.evals)).toBe(true);
      expect(job.budget.evals).toBeGreaterThanOrEqual(POLICY.minEvaluations);
      if (job.kind === "polish") continue;
      expect(job.budget.time_s).toBeGreaterThanOrEqual(plan.minJob);
      expect(job.budget.time_s).toBeLessThanOrEqual(plan.cap);
    }
  });
});

describe("engine: exploration and budgets", () => {
  it("runs each arm once at the base budget before the bandit repeats any", async () => {
    const known = { config: packing(SQUARES, "known"), score: 6, source: "site" as const };
    const sim = new Sim(improving);
    await search(sim, { known, maxSeconds: 2000 });
    const arms = armsFor(SQUARES);
    const keys = sim.jobs
      .slice(0, arms.length)
      .map((r) => `${r.job.kind}:${r.job.method}:${JSON.stringify(r.job.params ?? {})}`);
    expect(new Set(keys).size).toBe(arms.length);
    const base = sim.jobs[0].job.budget.time_s;
    for (const r of sim.jobs.slice(0, arms.length)) expect(r.job.budget.time_s).toBe(base);
  });

  it("doubles the budget of an arm that keeps improving, up to the cap", async () => {
    // Only iterated shrink_repair jobs improve; everything else returns the same packing
    let score = 5;
    const sim = new Sim((job) => {
      if (job.kind === "iterate" && job.method === "shrink_repair") score *= 1 - 1e-4;
      return { score };
    });
    // One lane, so that each of the arm's jobs ends before its next one starts
    await search(sim, { maxSeconds: 20000, lanes: 1 });
    const budgets = sim.jobs
      .filter((r) => r.job.kind === "iterate" && r.job.method === "shrink_repair")
      .map((r) => r.job.budget.time_s);
    expect(budgets.length).toBeGreaterThan(5);
    expect(budgets[1]).toBe(2 * budgets[0]);
    expect(budgets[2]).toBe(4 * budgets[0]);
    const cap = Math.max(...sim.jobs.map((r) => r.job.budget.time_s));
    expect(cap).toBeLessThanOrEqual(POLICY.capMaxSeconds);
    expect(budgets.at(-1)).toBeGreaterThan(budgets[0]);
  });

  it("doubles the budget of an arm after two jobs at its level without an improvement", async () => {
    const sim = new Sim(() => ({ score: 5 }));
    await search(sim, { maxSeconds: 20000, lanes: 1 });
    const byArm = new Map<string, number[]>();
    for (const { job } of sim.jobs) {
      if (job.kind === "polish") continue;
      const key = `${job.kind}:${job.method}:${(job.params as { path?: string } | undefined)?.path ?? ""}`;
      byArm.set(key, [...(byArm.get(key) ?? []), job.budget.time_s]);
    }
    const repeated = [...byArm.values()].filter((budgets) => budgets.length >= 3);
    expect(repeated.length).toBeGreaterThan(0);
    // With one lane, an arm's jobs finish in order: levels 0, 0, 1, 1, 2, ...
    for (const budgets of repeated) expect(budgets[2]).toBeCloseTo(2 * budgets[0], 9);
  });

  it("charges arms for the time their jobs use, so early stoppers are not penalised", async () => {
    // asc returns after a tenth of its budget and improves as often as the others
    let score = 5;
    const sim = new Sim((job, index) => {
      score *= 1 - 1e-7 * ((index % 3) + 1);
      return { score, seconds: job.method === "asc" ? job.budget.time_s * 0.1 : undefined };
    });
    await search(sim, { maxSeconds: 3000, lanes: 2 });
    const share = (method: string) => sim.jobs.filter((r) => r.job.method === method).length / sim.jobs.length;
    expect(share("asc")).toBeGreaterThan(share("morph"));
  });
});

describe("engine: starts", () => {
  it("uses the known packing for warm jobs and the current best for iterated ones", async () => {
    const known = { config: packing(SQUARES, "known"), score: 6, source: "literature" as const };
    const iterateStarts: (PackingConfig | undefined)[] = [];
    const sim = new Sim((job, index, s) => {
      if (job.kind === "iterate") {
        // The start is the best delivered so far
        expect(job.start).toBe(s.best?.config);
        iterateStarts.push(job.start);
      }
      if (job.kind === "warm") expect(job.start).toBe(known.config);
      if (job.kind === "fresh") expect(job.start).toBeUndefined();
      return { score: index % 3 === 0 ? 5.5 * (1 - 1e-5) ** index : 5.6 };
    });
    await search(sim, { known, maxSeconds: 3000 });
    expect(sim.jobs.some((r) => r.job.kind === "warm")).toBe(true);
    // Each improvement became the start of later iterated jobs
    expect(new Set(iterateStarts).size).toBeGreaterThan(3);
  });

  it("runs no warm job without a known packing, and ignores a known packing of another problem", async () => {
    const other = { config: packing({ N: 4, M: 4, P: 11 }, "other"), score: 4, source: "site" as const };
    for (const known of [undefined, other]) {
      const sim = new Sim(improving);
      await search(sim, { known, maxSeconds: 600 });
      expect(sim.jobs.filter((r) => r.job.kind === "warm")).toHaveLength(0);
    }
  });

  it("uses several seeds, all uint32, whatever input.seed is", async () => {
    for (const seed of [0, 7, -1, 2 ** 40 + 3, 1.5, Number.NaN]) {
      const sim = new Sim(improving);
      await search(sim, { seed, maxSeconds: 600 });
      const seeds = sim.jobs.map((r) => r.job.seed);
      for (const s of seeds) {
        expect(Number.isInteger(s)).toBe(true);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(2 ** 32 - 1);
      }
      expect(new Set(seeds).size).toBe(seeds.length);
    }
  });
});

describe("engine: best and polish", () => {
  it("never takes a packing that is not strict as the best, but iterates from one", async () => {
    const loose = packing(SQUARES, "not strict");
    const sim = new Sim((_job, index) => {
      if (index === 0) return { score: 3.5, strict: false, config: loose };
      if (index === 1) return { score: 3.6, strict: false };
      return { score: 5 + index * 1e-3 };
    });
    const outcome = await search(sim, { lanes: 1, maxSeconds: 600 });
    expect(outcome.best?.strict).toBe(true);
    expect(outcome.best?.score).toBe(5.002);
    for (const [, best] of outcome.results) expect(best?.config).not.toBe(loose);
    // Before any strict packing, the first iterated job started from the loose one
    const first = sim.jobs.find((r) => r.job.kind === "iterate")!;
    expect(first.job.start).toBe(loose);
  });

  it("polishes the best packing last", async () => {
    const sim = new Sim(improving);
    const outcome = await search(sim, { maxSeconds: 900 });
    const last = sim.jobs.at(-1)!;
    expect(last.job).toMatchObject({ method: "polish", kind: "polish", finalPolish: false });
    // The polish's answer improved on everything before it, so it is the best
    expect(outcome.best?.job).toBe(last.job);
    expect(outcome.jobs).toBe(sim.jobs.length);
    expect(outcome.results).toHaveLength(sim.jobs.length);
  });

  it("polishes the packing that was best when the search stopped", async () => {
    let bestBeforePolish: PackingConfig | undefined;
    const sim = new Sim((job, index, s) => {
      if (job.method === "polish") bestBeforePolish = s.best?.config;
      return { score: index < 20 ? 5 - index * 0.01 : 5 };
    });
    await search(sim, { maxSeconds: 1200 });
    expect(sim.jobs.at(-1)!.job.start).toBe(bestBeforePolish);
    expect(sim.jobs.filter((r) => r.job.method === "polish")).toHaveLength(1);
  });

  it("stops at the area bound and still polishes", async () => {
    const methods: string[] = [];
    const sim = new Sim((job, index, s) => {
      // Once the bound is reached, only the polish starts
      if (s.best && s.best.score < 3.1) methods.push(job.method);
      return { score: index === 5 ? 3 * (1 + 5e-10) : 4 };
    });
    const outcome = await search(sim, { areaBound: 3, maxSeconds: 3600 });
    expect(outcome.stopped).toBe("bound");
    expect(outcome.best?.score).toBe(3 * (1 + 5e-10));
    expect(methods).toEqual(["polish"]);
  });
});

describe("engine: stopping", () => {
  it("stops on stagnation after the floor when nothing ever improves", async () => {
    const sim = new Sim(() => ({ score: 5 }));
    const outcome = await search(sim, { maxSeconds: 36000 });
    expect(outcome.stopped).toBe("stagnation");
    const plan = planFor(36000, 4);
    const firstEnd = Math.min(...sim.finished.map((r) => r.end));
    const lastStart = Math.max(...sim.jobs.filter((r) => r.job.kind !== "polish").map((r) => r.at));
    // The first result is the only improvement; nothing starts once the floor has passed
    expect(lastStart - firstEnd).toBeLessThan(plan.stagnationFloor);
    expect(lastStart).toBeGreaterThan(plan.stagnationFloor / 2);
    expect(sim.clock).toBeLessThan(2000);
  });

  it("gives the search as much time again as it took to find its last improvement", async () => {
    // Improvements until about 3000 s, then none
    const sim = new Sim((_job, index, s) => ({ score: s.clock < 3000 ? 5 * (1 - 1e-6) ** index : 5 }));
    const outcome = await search(sim, { maxSeconds: 100000 });
    expect(outcome.stopped).toBe("stagnation");
    const floor = planFor(100000, 4).stagnationFloor;
    // Replay the improvements in delivery order and check every start against the rule
    const improvements: number[] = [0];
    let best = Infinity;
    for (const r of sim.finished) {
      const score = r.result?.score;
      if (score != null && score < best * (1 - POLICY.minImprovement)) improvements.push(r.end);
      if (score != null) best = Math.min(best, score);
    }
    const last = improvements.at(-1)!;
    expect(last).toBeGreaterThan(2900);
    for (const r of sim.jobs) {
      if (r.job.kind === "polish") continue;
      const before = Math.max(...improvements.filter((t) => t <= r.at));
      expect(r.at - before).toBeLessThan(Math.max(floor, r.at / 2));
    }
    const lastStart = Math.max(...sim.jobs.filter((r) => r.job.kind !== "polish").map((r) => r.at));
    expect(lastStart).toBeGreaterThan(1.6 * last);
    expect(sim.clock).toBeLessThan(3 * last);
  });

  it("starts jobs again when a job finishing during the wait improves the best", async () => {
    // Nothing improves except one long job that ends after stagnation has been reached
    let longJob = -1;
    const sim = new Sim((job, index) => {
      if (longJob < 0 && index >= 20) {
        longJob = index;
        return { score: 4, seconds: 800 };
      }
      return { score: 5 };
    });
    const outcome = await search(sim, { maxSeconds: 36000, lanes: 2 });
    const end = sim.jobs[longJob].end;
    expect(sim.jobs.some((r) => r.at >= end && r.job.kind !== "polish")).toBe(true);
    expect(outcome.best?.score).toBe(4);
    expect(outcome.stopped).toBe("stagnation");
  });

  it("aborts: starts nothing more, waits for the running jobs and skips the polish", async () => {
    const control = { aborted: false, paused: false };
    const sim = new Sim((_job, index) => {
      if (index === 9) control.aborted = true;
      return { score: 5 - index * 0.01 };
    }, control);
    const outcome = await search(sim, { maxSeconds: 3600 });
    expect(outcome.stopped).toBe("aborted");
    expect(sim.jobs).toHaveLength(10);
    expect(sim.jobs.some((r) => r.job.method === "polish")).toBe(false);
    expect(sim.inFlight).toBe(0);
    expect(outcome.best?.score).toBe(Math.min(...sim.finished.map((r) => r.result!.score!)));
  });

  it("returns at once when aborted before it starts", async () => {
    const sim = new Sim(improving, { aborted: true, paused: false });
    const outcome = await search(sim);
    expect(outcome).toMatchObject({ best: null, jobs: 0, stopped: "aborted" });
  });
});

describe("engine: robustness and determinism", () => {
  it("keeps going when jobs throw, reject, crash or error, and drops arms that keep failing", async () => {
    const sim = new Sim((job) => {
      if (job.method === "asc") return { throws: new Error("worker gone") };
      if (job.method === "morph") return { rejects: "no reason" };
      if (job.method === "basin_hopping") return { score: null, termination: "crashed" };
      if (job.method === "ls_growth") return { score: null, termination: "error" };
      return { score: 5 };
    });
    const lanes = 4;
    const outcome = await search(sim, { maxSeconds: 3600, lanes });
    expect(outcome.best?.score).toBe(5);
    expect(outcome.stopped).toBe("stagnation");
    for (const method of ["asc", "morph", "basin_hopping"])
      for (const kind of ["fresh", "iterate"]) {
        const failed = sim.jobs.filter((r) => r.job.method === method && r.job.kind === kind);
        expect(failed.length).toBeGreaterThan(0);
        // Jobs already in flight when the arm is dropped still finish
        expect(failed.length).toBeLessThanOrEqual(POLICY.errorLimit + lanes - 1);
      }
    expect(sim.jobs.filter((r) => r.job.method === "harden").length).toBeGreaterThan(10);
  });

  it("survives a host whose onResult throws and malformed results", async () => {
    const sim = new Sim((job) => (job.method === "harden" ? { score: Number.NaN } : { score: 5 }));
    const original = sim.runJob;
    const runJob: RunJob = (job, control) =>
      job.method === "asc" ? Promise.resolve(null as unknown as JobResult) : original(job, control);
    const outcome = await searchProblem(
      {
        problem: SQUARES,
        leader: null,
        published: null,
        areaBound: 3,
        maxSeconds: 1200,
        lanes: 3,
        seed: 1,
        now: sim.now,
        onResult: () => {
          throw new Error("log full");
        },
      },
      runJob,
      sim.control,
    );
    expect(outcome.best?.score).toBe(5);
  });

  it("makes the same jobs for the same input, answers and clock", async () => {
    const trace = async (seed: number) => {
      const sim = new Sim((job, index) => ({ score: index % 4 === 0 ? 5 * (1 - 1e-4) ** index : 5.2 }));
      const known = { config: packing(SQUARES, "known"), score: 5.1, source: "site" as const };
      const outcome = await search(sim, { known, seed, maxSeconds: 5000, lanes: 3 });
      return {
        jobs: sim.jobs.map(({ job, at }) => ({ ...job, start: job.start?.name, at })),
        best: outcome.best?.score,
        memory: outcome.memory,
      };
    };
    const a = await trace(11);
    expect(await trace(11)).toEqual(a);
    expect((await trace(12)).jobs).not.toEqual(a.jobs);
  });

  it("returns memory for the problem's family", async () => {
    const sim = new Sim(improving);
    const outcome = await search(sim, { maxSeconds: 600 });
    const memory = outcome.memory as { version: number; families: Record<string, unknown> };
    expect(memory.version).toBe(1);
    expect(Object.keys(memory.families)).toEqual([familyKey(SQUARES)]);
  });
});
