import { describe, expect, it } from "vitest";
import { type KernelState, type SpaceKernel, getMethod, methodsFor, mulberry32, runMethod } from "../src";
import { checkKernel } from "../src/contract";
import { DISKS_IN_CIRCLE_BEST, disksKernel, validateDisks } from "../src/reference/disks";
import { HardenDynamics } from "../src/methods/harden-dynamics";
import {
  MIN_RUN_STEPS,
  type RunCosts,
  offersPerRun,
  pathShape,
  planPhases,
  planRuns,
  runCost,
  stepsFor,
} from "../src/methods/harden-schedule";
import { roomDisksKernel, softDisksKernel, softRadius } from "./soft-disks";

const FULL = { compress: 2500, morph: 7500, settle: 1500 };
const COSTS: RunCosts = { step: 1, measure: 16, offer: 2, full: FULL, interval: 1000, polish: 502 };
/** An expensive space kernel's costs: a finish of 1,000, a gradient of 4, a finish that fails on overlapping states. */
const COSTLY = { finishCost: 1000, validateCost: 3, gradCost: 4, failAbove: 0.05 };

describe("the hardening schedule", () => {
  it("follows the reference's paths, ending exactly at the true shape", () => {
    expect(pathShape("harden", 0, 1)).toBe(0);
    expect(pathShape("harden", 0.25, 1)).toBe(0.25);
    expect(pathShape("harden", 0, 0.5)).toBe(0.5);
    expect(pathShape("rigid", 0, 1)).toBe(1);
    expect(pathShape("snap", 0, 1)).toBe(0);
    expect(pathShape("snap", 1e-9, 1)).toBe(1);
    for (const path of ["harden", "rigid", "snap"] as const) expect(pathShape(path, 1, 0.7)).toBe(1);
  });

  it("splits a run in the reference's proportion, and a supplied start skips compression", () => {
    expect(planPhases(11500, FULL)).toEqual(FULL);
    expect(planPhases(1150, FULL)).toEqual({ compress: 250, morph: 750, settle: 150 });
    expect(planPhases(1150, FULL, false)).toEqual({ compress: 0, morph: 1000, settle: 150 });
    expect(planPhases(1, FULL)).toEqual({ compress: 0, morph: 1, settle: 0 });
  });

  it("fits whole runs into the evaluation budget, at the kernel's costs", () => {
    // a full run: 11,500 steps, 719 measurements of the size's unit, two offers while settling and at the end
    expect(offersPerRun(11500, COSTS)).toBe(2);
    expect(offersPerRun(11500, { ...COSTS, interval: 0 })).toBe(1);
    expect(runCost(11500, COSTS)).toBe(11500 + 719 + 2 * 2 + 502);
    expect(planRuns(30000, COSTS, 0)).toBe(2);
    expect(planRuns(3000, COSTS, 0)).toBe(1);
    expect(planRuns(3000, COSTS, 7)).toBe(7);
    // never so many runs that one could not take its shortest length
    expect(planRuns(300, COSTS, 100000)).toBe(Math.floor(300 / runCost(MIN_RUN_STEPS, { ...COSTS, polish: 0 })));
    expect(planRuns(Infinity, COSTS, 0)).toBe(Infinity);
    const costly: RunCosts = { ...COSTS, step: 4, offer: 1003, polish: 2003 };
    for (const c of [COSTS, costly])
      for (const share of [10, 100, 1000, 2999, 15013, 20000]) {
        const steps = stepsFor(share, c);
        // the longest run that fits, or none when not even one step does
        if (steps > 0) expect(runCost(steps, c)).toBeLessThanOrEqual(share);
        expect(runCost(steps + 1, c)).toBeGreaterThan(share);
        // a step costs the kernel's gradient
        expect(steps * c.step).toBeLessThanOrEqual(share);
      }
  });
});

describe("the hardening dynamics", () => {
  it("moves the pieces in piece units, whatever the kernel's variables measure", () => {
    // the reference disks with every variable stored at half its length: steps 0.5, inradius 1
    const base = disksKernel(6);
    const halved: SpaceKernel = {
      ...base,
      steps: Float64Array.from([0.5, 0.5]),
      energy(s, g, w) {
        const e = base.energy({ ...s, x: s.x.map((v) => 2 * v) }, g, w);
        if (g) for (let j = 0; j < s.x.length; j++) g[j] *= 2;
        return e;
      },
    };
    const a = base.randomStart(mulberry32(3));
    const b = { ...a, x: a.x.map((v) => v / 2) };
    const da = new HardenDynamics(base, a);
    const db = new HardenDynamics(halved, b);
    const ra = mulberry32(9);
    const rb = mulberry32(9);
    for (let i = 0; i < 300; i++) {
      da.step(0.5, 0.05, ra, i % 16 === 0);
      db.step(0.5, 0.05, rb, i % 16 === 0);
    }
    for (let j = 0; j < a.x.length; j++) expect(2 * b.x[j]).toBeCloseTo(a.x[j], 12);
    expect(b.size).toBeCloseTo(a.size, 12);
  });

  it("measures the size's unit: the length by which a unit of size moves the contacts", () => {
    // one disk crosses the circle; the pair overlap does not depend on the size
    const config = {
      R: 2.4,
      centres: [
        [1.5, 0],
        [0, -1],
        [-1.2, 0.3],
      ],
    };
    const circle = disksKernel(3);
    const dc = new HardenDynamics(circle, circle.fromConfig(config)!);
    dc.step(0, 0, mulberry32(1), true);
    expect(dc.unit).toBeCloseTo(1, 6);
    // the same problem sized by a square's side, whose walls move by half of it
    const side: SpaceKernel = {
      ...circle,
      energy(s, g, w) {
        const e = circle.energy({ ...s, size: s.size / 2 }, g, w);
        if (g) g[s.x.length] /= 2;
        return e;
      },
    };
    const ds = new HardenDynamics(side, { ...circle.fromConfig(config)!, size: 4.8 });
    ds.step(0, 0, mulberry32(1), true);
    expect(ds.unit).toBeCloseTo(0.5, 6);
  });

  it("stops the pieces whose chart rebase changes, and only those", () => {
    const base = disksKernel(2);
    // a rebase that moves piece 0 to another chart and leaves piece 1 alone
    const k: SpaceKernel = {
      ...base,
      rebase(s) {
        s.x[0] += 1;
      },
    };
    const s = base.fromConfig({
      R: 3,
      centres: [
        [0.5, 0.3],
        [-0.5, -0.2],
      ],
    })!;
    const d = new HardenDynamics(k, s);
    d.step(0, 0, mulberry32(1));
    d.step(0, 0, mulberry32(1));
    expect(d.velocity.every((v) => v !== 0)).toBe(true);
    const kept = d.velocity.slice(2, 4);
    d.rebase();
    expect([...d.velocity.slice(0, 2)]).toEqual([0, 0]);
    expect([...d.velocity.slice(2, 4)]).toEqual([...kept]);
  });
});

describe("harden on the reference kernel", () => {
  it("is offered where the kernel has soft shapes", () => {
    const m = getMethod("harden")!;
    expect(m.requires).toEqual(["shape"]);
    expect(m.title).toBe("Soft-to-rigid hardening");
    expect(methodsFor(disksKernel(3)).map((d) => d.name)).toContain("harden");
    expect(methodsFor({ capabilities: [] }).map((d) => d.name)).not.toContain("harden");
  });

  it("comes within 0.1% of the best known packings for P = 2 to 10 in 30,000 evaluations", () => {
    // Measured (seeds 1-10, Node 26, Apple Silicon): every run within 2.4e-8 of the best known radius.
    const gaps: Record<number, number> = {};
    for (let P = 2; P <= 10; P++) {
      const r = runMethod(disksKernel(P), "harden", { seed: 1, budget: { evals: 30000 } });
      expect(r.score).not.toBeNull();
      expect(validateDisks(P, r.config, 0).valid).toBe(true);
      gaps[P] = r.score! / DISKS_IN_CIRCLE_BEST[P] - 1;
      // nothing below the best known radius (beyond rounding)
      expect(gaps[P]).toBeGreaterThan(-1e-9);
      expect(gaps[P]).toBeLessThan(1e-3);
    }
    console.log("harden, 30,000 evaluations, seed 1: score / best known - 1 by P", gaps);
  });

  it("is reproducible from the seed", () => {
    const a = runMethod(disksKernel(7), "harden", { seed: 5, budget: { evals: 4000 } });
    const b = runMethod(disksKernel(7), "harden", { seed: 5, budget: { evals: 4000 } });
    const c = runMethod(disksKernel(7), "harden", { seed: 6, budget: { evals: 4000 } });
    expect(b.config).toEqual(a.config);
    expect(b.evaluations).toBe(a.evaluations);
    expect(c.config).not.toEqual(a.config);
  });

  it("respects the budget and ends its runs before it is spent", () => {
    for (const evals of [40, 300, 3000, 12000]) {
      const r = runMethod(disksKernel(6), "harden", { seed: 3, budget: { evals } });
      expect(r.score).not.toBeNull();
      expect(validateDisks(6, r.config, 0).valid).toBe(true);
      // the counted kernel stops at the budget; one call past it costs at most a finish
      expect(r.evaluations).toBeLessThanOrEqual(evals + 1);
      expect(["done", "evals"]).toContain(r.stopped);
    }
    for (const restarts of [3, 100000]) {
      const r = runMethod(disksKernel(6), "harden", { seed: 3, params: { restarts }, budget: { evals: 3000 } });
      expect(r.evaluations).toBeLessThanOrEqual(3001);
      expect(r.score).not.toBeNull();
    }
  });

  it("returns a valid result on a stop or a time limit, from its first offer", () => {
    let calls = 0;
    const stopped = runMethod(disksKernel(5), "harden", { seed: 2, budget: {}, shouldStop: () => ++calls > 50 });
    expect(stopped.stopped).toBe("stopped");
    expect(validateDisks(5, stopped.config, 0).valid).toBe(true);
    let t = 0;
    const timed = runMethod(disksKernel(5), "harden", { seed: 2, budget: { time_s: 1 }, now: () => (t += 1e-4) });
    expect(timed.stopped).toBe("time");
    expect(validateDisks(5, timed.config, 0).valid).toBe(true);
  });

  it("never returns worse than a valid start, and starts its first run from it", () => {
    const s = Math.SQRT2;
    const optimal = {
      R: 1 + s,
      centres: [
        [s, 0],
        [0, s],
        [-s, 0],
        [0, -s],
      ],
    };
    expect(validateDisks(4, optimal, 0).valid).toBe(true);
    for (const evals of [30, 3000]) {
      const r = runMethod(disksKernel(4), "harden", { seed: 1, start: optimal, budget: { evals } });
      expect(r.score).toBeLessThanOrEqual(optimal.R);
    }
    // a loose valid start is improved
    const loose = { R: 1.5 * optimal.R, centres: optimal.centres.map(([x, y]) => [1.5 * x, 1.5 * y]) };
    const r = runMethod(disksKernel(4), "harden", {
      seed: 1,
      start: loose,
      params: { restarts: 1 },
      budget: { evals: 3000 },
    });
    expect(r.score!).toBeLessThan(optimal.R * (1 + 1e-6));
  });

  it("refuses bad parameters", () => {
    const run = (params: Record<string, unknown>) =>
      runMethod(disksKernel(3), "harden", { seed: 1, params, budget: { evals: 10 } });
    expect(() => run({ path: "grow" })).toThrow(/enum/);
    expect(() => run({ pressure: 0 })).toThrow(/pressure/);
    expect(() => run({ noise: -1 })).toThrow(/noise/);
    expect(() => run({ tau0: 1.5 })).toThrow(/tau0/);
    expect(() => run({ compressSteps: 1.5 })).toThrow(/integer/);
    expect(() => run({ morphSteps: 0 })).toThrow(/morphSteps/);
    expect(() => run({ polish: "yes" })).toThrow(/boolean/);
    expect(() => run({ fill: 3.2 })).toThrow(/unknown parameter/);
  });
});

describe("harden where the shape really changes", () => {
  it("uses a test kernel that passes the kernel contract", () => {
    for (const P of [2, 5]) expect(checkKernel(() => softDisksKernel(P), { seed: P })).toEqual([]);
  });

  it("compresses soft disks, hardens them along the path, and offers true shapes only", () => {
    const k = softDisksKernel(5);
    // the size at every energy evaluation, with the shape it was taken at
    const seen: [number, number][] = [];
    const recording = {
      ...k,
      energy: (s: KernelState, g?: Float64Array, w?: Float64Array) => {
        seen.push([(s.aux as { t: number }).t, s.size]);
        return k.energy(s, g, w);
      },
    };
    const params = { restarts: 1, compressSteps: 250, morphSteps: 750, settleSteps: 150, offerInterval: 100 };
    const r = runMethod(recording, "harden", { seed: 4, params, budget: { evals: 3000 } });
    expect(validateDisks(5, r.config, 0).valid).toBe(true);
    expect(r.score!).toBeGreaterThanOrEqual(DISKS_IN_CIRCLE_BEST[5] * (1 - 1e-12));
    expect(r.score!).toBeLessThan(DISKS_IN_CIRCLE_BEST[5] * 1.01);

    // the run's shapes: t = 0 while compressing, rising along the path, then the true shape
    // (the first entry is the true-shape copy of the start, offered before the run)
    expect(k.shapes.slice(0, 2)).toEqual([1, 0]);
    const rising = k.shapes.filter((t) => t > 0 && t < 1);
    expect(rising.length).toBeGreaterThan(100);
    for (let i = 1; i < rising.length; i++) expect(rising[i]).toBeGreaterThan(rising[i - 1]);
    expect(k.shapes.at(-1)).toBe(1);
    // the dynamics really ran soft: compressed disks of radius 0.7 well below the true optimum
    const compressed = Math.min(...seen.filter(([t]) => t === 0).map(([, size]) => size));
    expect(compressed).toBeLessThan(DISKS_IN_CIRCLE_BEST[5] * softRadius(0) * 1.05);
    // every state handed to finish was at the true shape: the first offer, those while settling, the end, the squeeze
    expect(k.finished.length).toBeGreaterThanOrEqual(4);
    expect(k.finished.every((t) => t === 1)).toBe(true);
  });

  it("reaches the best known packings for P = 2 to 10 from soft starts", () => {
    for (let P = 2; P <= 10; P++) {
      const r = runMethod(softDisksKernel(P), "harden", { seed: 1, budget: { evals: 30000 } });
      expect(validateDisks(P, r.config, 0).valid).toBe(true);
      expect(r.score! / DISKS_IN_CIRCLE_BEST[P] - 1).toBeLessThan(1e-3);
    }
  });
});

describe("harden on an expensive space kernel", () => {
  it("plans its runs at the kernel's gradient and offer costs, so that they settle and offer", () => {
    // a gradient costs 4 and a finish 1,000: a plan at one evaluation per step and twice the
    // finish per offer was cut in compression or left a third of the budget unspent
    for (const evals of [5000, 20000]) {
      const k = softDisksKernel(8, COSTLY);
      const r = runMethod(k, "harden", { seed: 1, budget: { evals } });
      expect(r.stopped).toBe("done");
      expect(validateDisks(8, r.config, 0).valid).toBe(true);
      expect(r.evaluations).toBeLessThanOrEqual(evals);
      expect(r.evaluations).toBeGreaterThan(0.9 * evals);
      // the first offer, then the run's own
      expect(k.finished.length).toBeGreaterThanOrEqual(2);
      expect(r.score! / DISKS_IN_CIRCLE_BEST[8] - 1).toBeLessThan(evals === 5000 ? 1e-3 : 1e-5);
    }
  });

  it("returns a valid result when stopped early, though raw random starts do not finish", () => {
    const raw = softDisksKernel(8, COSTLY);
    for (let seed = 1; seed <= 5; seed++) expect(raw.finish(raw.randomStart(mulberry32(seed)))).toBeNull();
    // the first offer: a seed, or without seeds a random start relaxed apart
    for (const seeds of [true, false]) {
      let calls = 0;
      const r = runMethod(softDisksKernel(8, { ...COSTLY, seeds }), "harden", {
        seed: 1,
        budget: {},
        shouldStop: () => ++calls > 60,
      });
      expect(r.stopped).toBe("stopped");
      expect(validateDisks(8, r.config, 0).valid).toBe(true);
    }
  });

  it("measures the size in units of room, so a container that saturates does not run away", () => {
    // R = 3.9 tanh(L / 3.9): near the optimum a unit of size moves the wall by about 0.06.
    // With the size in units of size the run ended 4.4% above the optimum.
    const k = roomDisksKernel(10, 3.9);
    const best = 3.9 * Math.atanh(DISKS_IN_CIRCLE_BEST[10] / 3.9);
    const r = runMethod(k, "harden", { seed: 1, budget: { evals: 20000 } });
    expect(r.score! / best - 1).toBeGreaterThan(-1e-9);
    expect(r.score! / best - 1).toBeLessThan(1e-3);
  });

  it("squeezes a settled state that lies at or below the bound", () => {
    // the bound is the optimum and only states without overlap finish: the settled state lies
    // below the bound with some overlap, and only a closing squeeze that starts above it helps
    for (const P of [4, 7]) {
      const bound = DISKS_IN_CIRCLE_BEST[P] * (1 - 1e-12);
      const r = runMethod(softDisksKernel(P, { bound, failAbove: 1e-15, seeds: false }), "harden", {
        seed: 1,
        budget: { evals: 20000 },
      });
      expect(r.stopped).toBe("bound");
    }
  });
});
