import { describe, expect, it } from "vitest";
import { type KernelState, mulberry32, runMethod } from "../src";
import { DISKS_IN_CIRCLE_BEST, disksKernel, validateDisks } from "../src/reference/disks";
import { morphSchedule, toContact } from "../src/methods/morph-stage";
import { softDisksKernel } from "./soft-disks";

const s2 = Math.SQRT2;
const OPTIMAL_4 = {
  R: 1 + s2,
  centres: [
    [s2, 0],
    [0, s2],
    [-s2, 0],
    [0, -s2],
  ],
};

describe("the continuation's pieces", () => {
  it("schedules the shapes from t0 to exactly 1", () => {
    expect(morphSchedule(0, 4, 1)).toEqual([0, 1 / 3, 2 / 3, 1]);
    expect(morphSchedule(0.1, 2, 1)).toEqual([0.1, 1]);
    const s = morphSchedule(0.3, 7, 2);
    expect(s[0]).toBe(0.3);
    expect(s.at(-1)).toBe(1);
    for (let i = 1; i < s.length; i++) expect(s[i]).toBeGreaterThan(s[i - 1]);
  });

  it("carries an arrangement to its first contact, apart or together", () => {
    const k = disksKernel(4);
    for (const factor of [0.8, 1.7]) {
      const s = k.fromConfig({
        R: OPTIMAL_4.R * factor,
        centres: OPTIMAL_4.centres.map(([x, y]) => [x * factor, y * factor]),
      })!;
      toContact(k, s);
      // first contact of this arrangement is the optimum itself
      expect(s.size).toBeGreaterThanOrEqual(OPTIMAL_4.R);
      expect(s.size).toBeLessThan(OPTIMAL_4.R * (1 + 1e-6));
      expect(k.energy(s)).toBeLessThanOrEqual(1e-20);
    }
    // coincident pieces cannot be scaled apart: left as they are
    const stuck = k.fromConfig({
      R: 3,
      centres: [
        [0, 0],
        [0, 0],
        [1, 0],
        [0, 1],
      ],
    })!;
    toContact(k, stuck);
    expect(stuck.size).toBe(3);
  });
});

describe("morph on the reference kernel", () => {
  it("comes within 2.5% of the best known packings for P = 2 to 10 in 30,000 evaluations", () => {
    // Measured (seeds 1-10, Node 26, Apple Silicon): within 2.4e-8 except one seed for P = 9,
    // which stays at another local optimum 1.02% above the best known radius.
    const gaps: Record<number, number> = {};
    for (let P = 2; P <= 10; P++) {
      const r = runMethod(disksKernel(P), "morph", { seed: 1, budget: { evals: 30000 } });
      expect(r.score).not.toBeNull();
      expect(validateDisks(P, r.config, 0).valid).toBe(true);
      gaps[P] = r.score! / DISKS_IN_CIRCLE_BEST[P] - 1;
      // nothing below the best known radius (beyond rounding)
      expect(gaps[P]).toBeGreaterThan(-1e-9);
      expect(gaps[P]).toBeLessThan(0.025);
    }
    console.log("morph, 30,000 evaluations, seed 1: score / best known - 1 by P", gaps);
  });

  it("is reproducible from the seed", () => {
    const a = runMethod(disksKernel(8), "morph", { seed: 5, budget: { evals: 4000 } });
    const b = runMethod(disksKernel(8), "morph", { seed: 5, budget: { evals: 4000 } });
    const c = runMethod(disksKernel(8), "morph", { seed: 6, budget: { evals: 4000 } });
    expect(b.config).toEqual(a.config);
    expect(b.evaluations).toBe(a.evaluations);
    expect(c.config).not.toEqual(a.config);
  });

  it("respects the budget", () => {
    for (const evals of [5, 60, 600, 6000]) {
      const r = runMethod(disksKernel(6), "morph", { seed: 3, budget: { evals } });
      expect(r.score).not.toBeNull();
      expect(validateDisks(6, r.config, 0).valid).toBe(true);
      // the counted kernel stops at the budget; one call past it costs at most a finish
      expect(r.evaluations).toBeLessThanOrEqual(evals + 1);
      // it ends when the budget is spent, or when what is left cannot pay for another continuation
      expect(["evals", "done"]).toContain(r.stopped);
    }
    // a fixed number of continuations ends on its own
    const one = runMethod(disksKernel(6), "morph", { seed: 3, params: { restarts: 1 }, budget: { evals: 1e6 } });
    expect(one.stopped).toBe("done");
    expect(one.evaluations).toBeLessThan(1e5);
    let t = 0;
    const timed = runMethod(disksKernel(6), "morph", { seed: 2, budget: { time_s: 1 }, now: () => (t += 1e-4) });
    expect(timed.stopped).toBe("time");
    expect(validateDisks(6, timed.config, 0).valid).toBe(true);
  });

  it("never returns worse than a valid start, and continues from it", () => {
    for (const evals of [10, 3000]) {
      const r = runMethod(disksKernel(4), "morph", { seed: 1, start: OPTIMAL_4, budget: { evals } });
      expect(r.score).toBeLessThanOrEqual(OPTIMAL_4.R);
    }
    // one continuation from a loose valid start finds its optimum
    const loose = { R: 1.4 * OPTIMAL_4.R, centres: OPTIMAL_4.centres.map(([x, y]) => [1.3 * x, 1.3 * y]) };
    const r = runMethod(disksKernel(4), "morph", {
      seed: 1,
      start: loose,
      params: { restarts: 1 },
      budget: { evals: 1e5 },
    });
    expect(r.stopped).toBe("done");
    expect(r.score!).toBeLessThan(OPTIMAL_4.R * (1 + 1e-9));
  });

  it("refuses bad parameters", () => {
    const run = (params: Record<string, unknown>) =>
      runMethod(disksKernel(3), "morph", { seed: 1, params, budget: { evals: 10 } });
    expect(() => run({ t0: 1 })).toThrow(/t0/);
    expect(() => run({ t0: -0.1 })).toThrow(/t0/);
    expect(() => run({ stages: 1 })).toThrow(/stages/);
    expect(() => run({ stages: 3.5 })).toThrow(/integer/);
    expect(() => run({ localMethod: "mc_compress" })).toThrow(/enum/);
    expect(() => run({ adaptive: 1 })).toThrow(/boolean/);
    expect(() => run({ family: "circumscribed" })).toThrow(/unknown parameter/);
  });
});

describe("morph where the shape really changes", () => {
  it("warms the stages from t0 to 1 and offers true shapes only", () => {
    const k = softDisksKernel(6);
    const params = { stages: 4, adaptive: false, restarts: 1 };
    const r = runMethod(k, "morph", { seed: 2, params, budget: { evals: 1e5 } });
    expect(r.stopped).toBe("done");
    expect(validateDisks(6, r.config, 0).valid).toBe(true);
    expect(r.score!).toBeGreaterThanOrEqual(DISKS_IN_CIRCLE_BEST[6] * (1 - 1e-12));
    // the stages' shapes in order; the true-shape copies offered between them set t = 1
    const stages = k.shapes.filter((t) => t < 1);
    expect(stages).toEqual([0, 1 / 3, 2 / 3]);
    expect(k.shapes.at(-1)).toBe(1);
    // every state handed to finish was at the true shape: the first offer, and the end at t = 1
    expect(k.finished).toEqual([1, 1]);
  });

  it("halves the next shape step after a large residual, at most twice per interval", () => {
    // with "relax" the middle stages keep the size squeezed for the softest disks, so the harder
    // disks overlap there and leave a residual; the first stage is squeezed clean
    const k = softDisksKernel(6);
    const params = { stages: 4, localMethod: "relax", restarts: 1 };
    runMethod(k, "morph", { seed: 2, params, budget: { evals: 1e5 } });
    const stages = k.shapes.filter((t) => t < 1);
    const expected = [0, 1 / 3, 1 / 2, 7 / 12, 2 / 3, 5 / 6, 11 / 12];
    expect(stages.length).toBe(expected.length);
    stages.forEach((t, i) => expect(t).toBeCloseTo(expected[i], 15));
  });

  it("relaxes at a kept size between the first and the last stage with localMethod relax", () => {
    const k = softDisksKernel(5);
    // the size of the continuation's state as each stage begins, which is the previous stage's result
    const sizes: number[] = [];
    let main: KernelState | null = null;
    const recording = {
      ...k,
      setShape(s: KernelState, t: number) {
        if (t === 0) main = s;
        if (s === main) sizes.push(s.size);
        k.setShape!(s, t);
      },
    };
    const params = { stages: 4, adaptive: false, restarts: 1, localMethod: "relax" };
    const r = runMethod(recording, "morph", { seed: 2, params, budget: { evals: 1e5 } });
    expect(validateDisks(5, r.config, 0).valid).toBe(true);
    // stages 2 and 3 relax at the size the first stage squeezed to; the last squeezes again
    expect(sizes.length).toBe(4);
    expect(sizes[2]).toBe(sizes[1]);
    expect(sizes[3]).toBe(sizes[1]);
    expect(r.score!).toBeLessThan(DISKS_IN_CIRCLE_BEST[5] * 1.01);
  });

  it("reaches the best known packings for P = 2 to 10 from soft starts", () => {
    for (let P = 2; P <= 10; P++) {
      const r = runMethod(softDisksKernel(P), "morph", { seed: 1, budget: { evals: 30000 } });
      expect(validateDisks(P, r.config, 0).valid).toBe(true);
      expect(r.score! / DISKS_IN_CIRCLE_BEST[P] - 1).toBeLessThan(0.025);
    }
  });
});

describe("morph on an expensive space kernel", () => {
  /** A finish of 1,000, a gradient of 4, a finish that fails on overlapping states. */
  const COSTLY = { finishCost: 1000, validateCost: 3, gradCost: 4, failAbove: 0.05 };

  it("gives every stage a slice of the budget, so a continuation reaches the true shape", () => {
    // at a gradient of 4 a stage's squeeze costs thousands: without slices 5,000 evaluations
    // ended in the first stages, with nothing offered after the first offer
    for (const evals of [5000, 20000]) {
      const k = softDisksKernel(8, COSTLY);
      const r = runMethod(k, "morph", { seed: 1, budget: { evals } });
      // the continuation's own state was set to t = 1, and its result was offered after
      const main = k.shaped[k.shapes.indexOf(0)];
      expect(k.shapes.filter((_, i) => k.shaped[i] === main).at(-1)).toBe(1);
      expect(k.finished.length).toBeGreaterThanOrEqual(2);
      expect(r.stopped).toBe("done");
      expect(r.evaluations).toBeLessThanOrEqual(evals);
      expect(validateDisks(8, r.config, 0).valid).toBe(true);
      expect(r.score! / DISKS_IN_CIRCLE_BEST[8] - 1).toBeLessThan(evals === 5000 ? 1e-3 : 1e-5);
    }
  });

  it("returns a valid result when stopped early, though raw random starts do not finish", () => {
    const raw = softDisksKernel(8, COSTLY);
    for (let seed = 1; seed <= 5; seed++) expect(raw.finish(raw.randomStart(mulberry32(seed)))).toBeNull();
    for (const seeds of [true, false]) {
      let calls = 0;
      const r = runMethod(softDisksKernel(8, { ...COSTLY, seeds }), "morph", {
        seed: 1,
        budget: {},
        shouldStop: () => ++calls > 60,
      });
      expect(r.stopped).toBe("stopped");
      expect(validateDisks(8, r.config, 0).valid).toBe(true);
    }
  });
});
