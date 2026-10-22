import type { PackingConfig } from "@polypack/geometry";
import { describe, expect, it } from "vitest";
import { armsFor, familyKey, searchProblem } from "../src/engine";
import {
  MAX_ARMS,
  MAX_FAMILIES,
  MEMORY_VERSION,
  armPrior,
  emptyMemory,
  parseMemory,
  remember,
  type Memory,
} from "../src/engine/memory";
import type { Job, JobResult, Problem, RunJob, SearchInput } from "../src/types";

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

function sample(): Memory {
  let memory = emptyMemory();
  memory = remember(memory, "4/4/10", {
    arms: [
      { key: "fresh:harden", credit: 0.75 },
      { key: "iterate:shrink_repair", credit: 0.25 },
      { key: "fresh:asc", credit: 0 },
    ],
    rates: [{ method: "harden", rate: 9000 }],
  });
  memory = remember(memory, "c/c/20", { arms: [{ key: "fresh:ls_growth", credit: 1 }], rates: [] });
  return remember(memory, "4/4/10", {
    arms: [{ key: "fresh:harden", credit: 0.5 }],
    rates: [{ method: "harden", rate: 4000 }],
  });
}

describe("engine memory", () => {
  it("round-trips through JSON", () => {
    const memory = sample();
    expect(memory.used).toBe(3);
    expect(memory.families["4/4/10"].rates.harden).toBe(6000);
    expect(memory.families["4/4/10"].arms["fresh:harden"]).toEqual({ n: 1.9, r: 1.175 });
    expect(parseMemory(json(memory))).toEqual(memory);
    expect(parseMemory(json(parseMemory(json(memory))))).toEqual(memory);
  });

  it("falls back to empty memory for anything that is not memory", () => {
    const throwing = Object.defineProperty({ version: MEMORY_VERSION, used: 1 }, "families", {
      enumerable: true,
      get() {
        throw new Error("corrupt");
      },
    });
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const inputs: unknown[] = [
      undefined,
      null,
      42,
      "memory",
      [],
      [sample()],
      { ...sample(), version: 0 },
      { ...sample(), version: "1" },
      { ...sample(), version: MEMORY_VERSION + 1 },
      { version: MEMORY_VERSION, used: -1, families: {} },
      { version: MEMORY_VERSION, used: 1, families: [] },
      { version: MEMORY_VERSION, used: Number.NaN, families: {} },
      throwing,
      proxy,
    ];
    for (const input of inputs) expect(parseMemory(input)).toEqual(emptyMemory());
  });

  it("drops malformed parts and keeps the rest", () => {
    const memory = json(sample()) as {
      families: Record<string, { arms: Record<string, unknown>; rates: Record<string, unknown> }>;
    };
    memory.families["__proto__/4/10"] = memory.families["4/4/10"];
    memory.families["4/4/7"] = memory.families["4/4/10"];
    memory.families["4/c/20"] = { arms: {}, rates: {} };
    const arms = memory.families["4/4/10"].arms;
    arms["fresh:bad"] = { n: -1, r: 0 };
    arms["nonsense"] = { n: 1, r: 1 };
    arms["warm:big"] = { n: 1e9, r: 2e9 };
    memory.families["4/4/10"].rates.asc = Number.POSITIVE_INFINITY;
    memory.families["4/4/10"].rates.morph = "fast";
    const parsed = parseMemory(memory);
    expect(Object.keys(parsed.families).sort()).toEqual(["4/4/10", "c/c/20"]);
    const family = parsed.families["4/4/10"];
    expect(Object.keys(family.arms).sort()).toEqual(["fresh:asc", "fresh:harden", "iterate:shrink_repair", "warm:big"]);
    // Counts are capped and the credit stays within them
    expect(family.arms["warm:big"].n).toBeLessThanOrEqual(20);
    expect(family.arms["warm:big"].r).toBeLessThanOrEqual(family.arms["warm:big"].n);
    expect(family.rates).toEqual({ harden: 6000 });
  });

  it("stays bounded", () => {
    let memory = emptyMemory();
    const shapes = ["c", "3", "4", "5", "6", "7", "8", "9+"];
    const buckets = [1, 10, 20, 50, 100, 200, 500];
    const arms = Array.from({ length: 50 }, (_, i) => ({
      key: `fresh:arm-${String.fromCharCode(97 + (i % 26))}${i}`,
      credit: 0.02,
    }));
    const methods = Array.from({ length: 30 }, (_, i) => ({
      method: `method_${String.fromCharCode(97 + (i % 26))}`,
      rate: 1000 + i,
    }));
    for (let k = 0; k < 3; k++)
      for (const n of shapes)
        for (const m of shapes)
          for (const b of buckets) memory = remember(memory, `${n}/${m}/${b}`, { arms, rates: methods });
    expect(Object.keys(memory.families)).toHaveLength(MAX_FAMILIES);
    for (const family of Object.values(memory.families))
      expect(Object.keys(family.arms).length).toBeLessThanOrEqual(MAX_ARMS);
    // 32 long arm keys and 16 rates a family, more than the engine writes
    expect(JSON.stringify(memory).length).toBeLessThan(160_000);
    expect(parseMemory(json(memory))).toEqual(memory);
    // The most recently used families are kept
    expect(memory.families["9+/9+/500"]).toBeDefined();
    expect(memory.families["c/c/1"]).toBeUndefined();
  });

  it("holds every family's arms and rates in about 40 kB", () => {
    let memory = emptyMemory();
    for (const N of [0, 3, 4, 5, 6, 7, 8, 9])
      for (const M of [0, 3, 4, 5, 6, 7, 8, 9])
        for (const P of [5, 15, 30, 70, 150, 300, 500]) {
          const problem = { N, M, P };
          const arms = armsFor(problem).map((arm, i) => ({ key: arm.key, credit: (0.123456 * ((i % 7) + 1)) / 7 }));
          const rates = [...new Set(armsFor(problem).map((arm) => arm.method))].map((method) => ({
            method,
            rate: 12345.678,
          }));
          memory = remember(memory, familyKey(problem), { arms, rates });
        }
    expect(Object.keys(memory.families)).toHaveLength(MAX_FAMILIES);
    expect(JSON.stringify(memory).length).toBeLessThan(48_000);
  });

  it("gives the family's best arm an even prior and weaker arms lower ones", () => {
    const family = sample().families["4/4/10"];
    expect(armPrior(undefined, "fresh:harden")).toEqual({ alpha: 1, beta: 1 });
    expect(armPrior(family, "fresh:morph")).toEqual({ alpha: 1, beta: 1 });
    const best = armPrior(family, "fresh:harden");
    expect(best.alpha).toBeCloseTo(best.beta, 12);
    const weak = armPrior(family, "fresh:asc");
    expect(weak.alpha).toBe(1);
    expect(weak.beta).toBeGreaterThan(1);
    const middle = armPrior(family, "iterate:shrink_repair");
    expect(middle.alpha / (middle.alpha + middle.beta)).toBeLessThan(0.5);
    expect(middle.alpha / (middle.alpha + middle.beta)).toBeGreaterThan(weak.alpha / (weak.alpha + weak.beta));
  });
});

describe("engine memory in a search", () => {
  const packing = (problem: Problem, name: string): PackingConfig => ({
    ...problem,
    pieces: Array.from({ length: problem.P }, (_, i) => ({ x: i, y: 0, theta: 0 })),
    container_phi: 0,
    name,
  });

  /** One lane: each job ends (0.8 of its budget later) before the next starts. */
  function run(problem: Problem, memory: unknown, improves: (job: Job) => boolean) {
    let clock = 0;
    let score = 10;
    const jobs: Job[] = [];
    const runJob: RunJob = async (job) => {
      jobs.push(job);
      const seconds = job.budget.time_s * 0.8;
      clock += seconds;
      if (improves(job)) score *= 1 - 1e-4;
      const result: JobResult = {
        job,
        score,
        valid: true,
        strict: true,
        best: packing(problem, String(score)),
        evaluations: 5000 * seconds,
        wallTime: seconds,
        termination: "evals",
        reasons: [],
      };
      return result;
    };
    const input: SearchInput = {
      problem,
      leader: null,
      published: null,
      areaBound: 1,
      maxSeconds: 1200,
      lanes: 1,
      seed: 3,
      memory,
      now: () => clock,
    };
    return searchProblem(input, runJob, { aborted: false, paused: false }).then((outcome) => ({ outcome, jobs }));
  }

  it("starts the family's next problem from what this one taught", async () => {
    const improves = (job: Job) => job.kind === "iterate" && job.method === "shrink_repair";
    const first = await run({ N: 4, M: 4, P: 10 }, undefined, improves);
    // Without memory, the catalogue's order: fresh harden, then fresh shrink_repair
    expect(first.jobs.slice(0, 2).map((job) => `${job.kind}:${job.method}`)).toEqual([
      "fresh:harden",
      "fresh:shrink_repair",
    ]);
    const memory = json(first.outcome.memory);
    const family = parseMemory(memory).families[familyKey({ N: 4, M: 4, P: 12 })];
    expect(family.arms["iterate:shrink_repair"]).toEqual({ n: 1, r: 1 });
    // The rate measured on the first problem: 5000 evaluations per second for ten pieces
    expect(family.rates.harden).toBe(50000);

    const second = await run({ N: 4, M: 4, P: 12 }, memory, improves);
    // The arm with the family's credit goes first once it has a start
    expect(`${second.jobs[1].kind}:${second.jobs[1].method}`).toBe("iterate:shrink_repair");
    // The first harden job's evaluation cap uses the remembered rate, 50000 / 12 per second
    const harden = second.jobs[0];
    expect(harden.budget.evals).toBe(Math.floor((50000 / 12) * harden.budget.time_s * 0.8));
    expect(parseMemory(json(second.outcome.memory)).used).toBe(2);
  });

  it("searches normally with memory that is not memory", async () => {
    for (const memory of [null, "garbage", { version: 0 }, { version: 1, used: 1, families: { "4/4/10": 5 } }]) {
      const { outcome, jobs } = await run({ N: 4, M: 4, P: 10 }, memory, () => true);
      expect(outcome.best).not.toBeNull();
      expect(jobs[0].method).toBe("harden");
      expect(parseMemory(json(outcome.memory)).families["4/4/10"].arms["fresh:harden"]).toBeDefined();
    }
  });
});
