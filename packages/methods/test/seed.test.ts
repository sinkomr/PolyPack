import { describe, expect, it } from "vitest";
import { type SpaceKernel, runMethod } from "../src";
import { DISKS_IN_CIRCLE_BEST, disksKernel, validateDisks } from "../src/reference/disks";

const valid = (P: number, config: unknown) => validateDisks(P, config, 0).valid;

/** The reference kernel, counting its seeds() calls. */
function counted(P: number, calls: { seeds: number }): SpaceKernel {
  const k = disksKernel(P);
  return { ...k, seeds: (rng, n) => (calls.seeds++, k.seeds!(rng, n)) };
}

describe("seed", () => {
  it("comes within 1% of the best known packings for P = 2 to 10 in 20,000 evaluations", () => {
    for (let P = 2; P <= 10; P++) {
      const r = runMethod(disksKernel(P), "seed", { seed: 1, budget: { evals: 20000 } });
      expect(r.score, `P = ${P}`).not.toBeNull();
      expect(valid(P, r.config)).toBe(true);
      expect(r.score!, `P = ${P}`).toBeLessThan(DISKS_IN_CIRCLE_BEST[P] * 1.01);
      expect(r.score!).toBeGreaterThanOrEqual(DISKS_IN_CIRCLE_BEST[P] * (1 - 1e-9));
    }
  });

  it("is reproducible from the seed", () => {
    const run = (seed: number) => runMethod(disksKernel(9), "seed", { seed, budget: { evals: 3000 } });
    const a = run(11);
    const b = run(11);
    expect(b.config).toEqual(a.config);
    expect(b.evaluations).toBe(a.evaluations);
    expect(run(12).config).not.toEqual(a.config);
  });

  it("keeps within the budget plus one offer, and has a result even on a small budget", () => {
    const costs: [number, number | undefined, number | undefined][] = [
      [1, undefined, undefined],
      [40, undefined, undefined],
      [40, 3, 5],
      [400, 100, undefined],
    ];
    for (const [finishCost, validateCost, gradCost] of costs) {
      for (const evals of [1, 5, 9, 250, 1000.5, 4000]) {
        const k = { ...disksKernel(7), finishCost, validateCost, gradCost };
        const r = runMethod(k, "seed", { seed: 2, params: { batch: 32 }, budget: { evals } });
        const label = `costs ${finishCost}/${validateCost}/${gradCost}, budget ${evals}`;
        // the first result may overrun by its offer; any later offer must fit
        expect(r.evaluations, label).toBeLessThan(evals + finishCost + (validateCost ?? finishCost));
        if (evals >= 250) expect(r.score, label).not.toBeNull();
        if (r.score !== null) expect(valid(7, r.config)).toBe(true);
      }
    }
  });

  it("settles the given start first", () => {
    const k = disksKernel(5);
    const startless: SpaceKernel = {
      ...k,
      capabilities: [],
      seeds: undefined,
      randomStart: () => {
        throw new Error("no random starts here");
      },
    };
    const overlapping = { R: 2.5, centres: Array.from({ length: 5 }, (_, i) => [0.3 * i, 0.1 * i]) };
    const r = runMethod(startless, "seed", {
      seed: 1,
      start: overlapping,
      params: { starts: 1 },
      budget: { evals: 1e5 },
    });
    expect(r.stopped).toBe("done");
    expect(valid(5, r.config)).toBe(true);
  });

  it("never returns worse than a valid start", () => {
    const start = {
      R: 1 + Math.SQRT2,
      centres: [
        [Math.SQRT2, 0],
        [0, Math.SQRT2],
        [-Math.SQRT2, 0],
        [0, -Math.SQRT2],
      ],
    };
    for (const evals of [3, 200, 2000]) {
      const r = runMethod(disksKernel(4), "seed", { seed: 1, start, budget: { evals } });
      expect(r.score!).toBeLessThanOrEqual(start.R);
      expect(validateDisks(4, r.config).valid).toBe(true);
    }
  });

  it("takes the share of starts it is given from the kernel's seeds", () => {
    const run = (seedShare: number) => {
      const calls = { seeds: 0 };
      const r = runMethod(counted(6, calls), "seed", {
        seed: 3,
        params: { seedShare, starts: 40 },
        budget: { evals: 1e6 },
      });
      expect(r.stopped).toBe("done");
      expect(valid(6, r.config)).toBe(true);
      return calls.seeds;
    };
    expect(run(0)).toBe(0);
    // 20 seeds, then 40, in batches of 8; a lattice patch met before is skipped, so a few batches more
    const half = run(0.5);
    const all = run(1);
    expect(half).toBeGreaterThanOrEqual(3);
    expect(all).toBeGreaterThanOrEqual(5);
    expect(all).toBeGreaterThan(half);
    const plain: SpaceKernel = { ...disksKernel(6), capabilities: ["shape"], seeds: undefined };
    const r = runMethod(plain, "seed", { seed: 3, params: { seedShare: 1, starts: 10 }, budget: { evals: 1e6 } });
    expect(valid(6, r.config)).toBe(true);
  });

  it("ends on the external stop with a valid best", () => {
    let calls = 0;
    const r = runMethod(disksKernel(6), "seed", { seed: 1, budget: {}, shouldStop: () => ++calls > 3000 });
    expect(r.stopped).toBe("stopped");
    expect(valid(6, r.config)).toBe(true);
  });

  it("refuses bad parameters", () => {
    const bad: Record<string, unknown>[] = [
      { seedShare: -0.1 },
      { batch: 0 },
      { squeeze: 9 },
      { iterations: 0 },
      { jitter: 2 },
      { starts: 1.5 },
      { kind: "hex_lattice" },
    ];
    for (const params of bad)
      expect(() => runMethod(disksKernel(3), "seed", { seed: 1, params, budget: { evals: 10 } })).toThrow();
  });
});
