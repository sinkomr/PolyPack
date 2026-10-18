import { describe, expect, it } from "vitest";
import {
  ALL_SHAPES,
  Pacer,
  type SiteInfo,
  crossProblems,
  median,
  missingClass,
  orderProblems,
  toothDepth,
  parseIntList,
  parsePieceCounts,
  parseShapes,
  problemKey,
  runKey,
  sampleProblems,
  siteInfoByP,
  submissionBody,
} from "../batch-search/lib";

describe("list parsing", () => {
  it("expands lists and ranges, sorted and without duplicates", () => {
    expect(parseIntList("5,1-3,2", "x", 0, 10)).toEqual([1, 2, 3, 5]);
    expect(parsePieceCounts("1-5")).toEqual([1, 2, 3, 4, 5]);
  });
  it("skips shape codes 1 and 2 inside a range but refuses them alone", () => {
    expect(parseShapes("0-4", "N")).toEqual([0, 3, 4]);
    expect(() => parseShapes("1,2", "N")).toThrow(/no allowed value/);
    expect(ALL_SHAPES.length).toBe(99);
  });
  it("refuses malformed, reversed and out-of-range items", () => {
    expect(() => parseIntList("1,,2", "x", 0, 10)).toThrow(/empty/);
    expect(() => parseIntList("a", "x", 0, 10)).toThrow(/not an integer/);
    expect(() => parseIntList("5-3", "x", 0, 10)).toThrow(/reversed/);
    expect(() => parseIntList("-1", "x", 0, 10)).toThrow();
    expect(() => parsePieceCounts("0-3")).toThrow(/outside/);
    expect(() => parsePieceCounts("501")).toThrow(/outside/);
    expect(() => parseShapes("101", "M")).toThrow(/outside/);
  });
});

describe("problem sets", () => {
  it("samples distinct problems reproducibly", () => {
    const a = sampleProblems(50, 7, [0, 3, 4], [0, 4], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const b = sampleProblems(50, 7, [0, 3, 4], [0, 4], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(a).toEqual(b);
    expect(new Set(a.map(problemKey)).size).toBe(50);
    expect(sampleProblems(50, 8, [0, 3, 4], [0, 4], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).not.toEqual(a);
  });
  it("returns the whole set when the sample is at least as large", () => {
    expect(sampleProblems(10, 1, [4], [4], [1, 2])).toEqual(crossProblems([4], [4], [1, 2]));
  });
});

describe("site information and ordering", () => {
  const records = {
    N: 4,
    M: 4,
    literature: [
      { N: 4, M: 4, P: 1, value: 1, status: "trivial_tiling" },
      { N: 4, M: 4, P: 2, value: 2, status: "proven_unrefereed" },
      { N: 4, M: 4, P: 3, value: 2, status: "best_known" },
      { N: 4, M: 4, P: 5, value: 2.7, status: "proven" },
    ],
    site: [
      { P: 2, score: 2.1 },
      { P: 3, score: 2 },
      { P: 6, score: 3 },
    ],
  } as never;

  it("reads closed status, published values and leaders per P", () => {
    const info = siteInfoByP(records);
    expect(info.get(1)).toEqual({ closed: true, published: 1, leader: null });
    expect(info.get(2)).toEqual({ closed: false, published: 2, leader: 2.1 });
    expect(info.get(5)?.closed).toBe(true);
    expect(info.get(6)).toEqual({ closed: false, published: null, leader: 3 });
    expect(info.get(7)).toBeUndefined();
  });

  it("classifies missing-first", () => {
    expect(missingClass(undefined)).toBe(0);
    expect(missingClass({ closed: false, published: null, leader: null })).toBe(0);
    expect(missingClass({ closed: false, published: 2, leader: null })).toBe(1);
    expect(missingClass({ closed: false, published: 2, leader: 2.1 })).toBe(1);
    expect(missingClass({ closed: false, published: 2, leader: 2 })).toBe(2);
    expect(missingClass({ closed: false, published: null, leader: 3 })).toBe(2);
  });

  it("orders missing-first, then smallest P, and keeps every problem", () => {
    const info = siteInfoByP(records);
    const problems = [2, 3, 4, 6, 7].map((P) => ({ N: 4, M: 4, P }));
    const lookup = (p: { P: number }): SiteInfo | undefined => info.get(p.P);
    expect(orderProblems(problems, "missing-first", lookup).map((p) => p.P)).toEqual([4, 7, 2, 3, 6]);
    expect(orderProblems([...problems].reverse(), "smallest-first", lookup).map((p) => p.P)).toEqual([2, 3, 4, 6, 7]);
    const random = orderProblems(problems, "random", lookup, 3);
    expect(random.map((p) => p.P).sort((a, b) => a - b)).toEqual([2, 3, 4, 6, 7]);
    expect(orderProblems(problems, "random", lookup, 3)).toEqual(random);
  });
});

describe("resume keys", () => {
  it("distinguish problem, method, seed and budget", () => {
    const p = { N: 4, M: 0, P: 7 };
    const b = { evals: 3000, time_s: 3 };
    const key = runKey(p, "asc", 1, b);
    expect(runKey({ ...p }, "asc", 1, { ...b })).toBe(key);
    expect(
      new Set([
        key,
        runKey({ ...p, P: 8 }, "asc", 1, b),
        runKey({ ...p, M: 4 }, "asc", 1, b),
        runKey(p, "harden", 1, b),
        runKey(p, "asc", 2, b),
        runKey(p, "asc", 1, { ...b, evals: 3001 }),
        runKey(p, "asc", 1, { ...b, time_s: 3.5 }),
      ]).size,
    ).toBe(7);
    // a key line read back from runs.jsonl has extra fields; only the named ones count
    expect(runKey({ ...p, score: 1 } as never, "asc", 1, b)).toBe(key);
  });
});

describe("pacer", () => {
  /** A fake clock: sleeping advances it, and every send time is recorded. */
  function fake() {
    let now = 0;
    return {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it("allows at most `limit` sends in any sliding window", async () => {
    const clock = fake();
    const pacer = new Pacer(25, 60_000, clock.now, clock.sleep);
    const times: number[] = [];
    for (let i = 0; i < 60; i++) {
      await pacer.acquire();
      times.push(clock.now());
    }
    expect(times.slice(0, 25).every((t) => t === 0)).toBe(true);
    expect(times[25]).toBe(60_000);
    expect(times[50]).toBe(120_000);
    for (let i = 25; i < times.length; i++) expect(times[i] - times[i - 25]).toBeGreaterThanOrEqual(60_000);
  });

  it("serves concurrent callers one at a time, still within the limit", async () => {
    const clock = fake();
    const pacer = new Pacer(2, 1000, clock.now, clock.sleep);
    const times: number[] = [];
    await Promise.all(Array.from({ length: 5 }, () => pacer.acquire().then(() => times.push(clock.now()))));
    expect(times).toEqual([0, 0, 1000, 1000, 2000]);
  });

  it("spreads sends over time without waiting when below the limit", async () => {
    const clock = fake();
    const pacer = new Pacer(25, 60_000, clock.now, clock.sleep);
    for (let i = 0; i < 100; i++) {
      expect(pacer.delay()).toBe(0);
      await pacer.acquire();
      clock.advance(2400); // 25 per minute exactly
    }
  });

  it("holds everything back after block(), e.g. a 429", async () => {
    const clock = fake();
    const pacer = new Pacer(25, 60_000, clock.now, clock.sleep);
    await pacer.acquire();
    pacer.block(65_000);
    await pacer.acquire();
    expect(clock.now()).toBe(65_000);
  });

  it("passes a rejected sleep (shutdown) to the caller without blocking later callers forever", async () => {
    let now = 0;
    let fail = true;
    const pacer = new Pacer(
      1,
      1000,
      () => now,
      async (ms) => {
        if (fail) throw new Error("shutdown");
        now += ms;
      },
    );
    await pacer.acquire();
    await expect(pacer.acquire()).rejects.toThrow("shutdown");
    fail = false;
    await pacer.acquire();
    expect(now).toBe(1000);
  });
});

describe("median", () => {
  it("handles empty, odd and even lists", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe("submission body", () => {
  const config = { N: 0, M: 0, P: 1, pieces: [{ x: 0, y: 0, theta: 0 }], container_phi: 0 };
  const best = { config, method: "asc", params: { sweeps: 4 }, seed: 2, budget: { evals: 20000, time_s: 15 } };

  it("records the run in its own fields and sends no note unless one was given", () => {
    expect(submissionBody(best, "Claude Haiku 5.5", "")).toEqual({
      ...config,
      name: "Claude Haiku 5.5",
      found_with: "optimizer",
      method: "asc",
      method_params: { sweeps: 4 },
      seed: 2,
      budget: { evals: 20000, time_s: 15 },
    });
    expect(submissionBody(best, "x", "cloud pilot").agent_note).toBe("cloud pilot");
    expect(submissionBody(best, "x", "")).not.toHaveProperty("agent");
  });

  it("leaves out parameters that are missing or larger than the server accepts", () => {
    const { params: _params, ...old } = best;
    expect(submissionBody(old, "x", "")).not.toHaveProperty("method_params");
    expect(submissionBody({ ...best, params: { blob: "x".repeat(5000) } }, "x", "")).not.toHaveProperty(
      "method_params",
    );
  });
});

describe("teeth order", () => {
  // squares in a square where every record is the plain ceil(sqrt P) grid, held by the site:
  // just after a perfect square the grid is far less dense than its neighbours
  const grid = (P: number) => ({ closed: false, published: null, leader: Math.ceil(Math.sqrt(P)) });
  const lookup = (p: { P: number }) => grid(p.P);
  const at = (P: number) => ({ N: 4, M: 4, P });

  it("rates a problem by how much denser its neighbours pack", () => {
    // P = 10: 10/16 against the second-densest neighbour, 8/9 (9/9 is the exceptional tiling)
    expect(toothDepth(at(10), lookup)).toBeCloseTo(1 - Math.sqrt(10 / 16 / (8 / 9)), 9);
    expect(toothDepth(at(16), lookup)).toBe(0);
    expect(toothDepth(at(9), lookup)).toBe(0);
  });

  it("leaves out problems with a published value, and those without a site leader", () => {
    const published = (p: { P: number }) => ({ ...grid(p.P), published: p.P === 10 ? 4 : null });
    expect(toothDepth(at(10), published)).toBeNull();
    const none = (p: { P: number }) => ({ ...grid(p.P), leader: p.P === 10 ? null : grid(p.P).leader });
    expect(toothDepth(at(10), none)).toBeNull();
  });

  it("orders the deepest teeth first", () => {
    const order = orderProblems([9, 10, 16, 17, 25].map(at), "teeth", lookup).map((p) => p.P);
    expect(order.slice(0, 2)).toEqual([10, 17]);
    expect(order.slice(2)).toEqual([9, 16, 25]);
  });
});
