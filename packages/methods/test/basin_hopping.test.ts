import { describe, expect, it } from "vitest";
import { type SpaceKernel, getMethod, methodsFor, mulberry32, registerMethod, runMethod } from "../src";
import { type BasinHop, type BasinTrace, basinHopping, runBasinHopping } from "../src/methods/basin_hopping";
import { OPERATORS, chooseOperator, metropolis, reinsert, stressedPiece } from "../src/methods/basin-operators";
import { DISKS_IN_CIRCLE_BEST, disksKernel, validateDisks } from "../src/reference/disks";

// The same method with its operator statistics exposed, for the tests that look inside a run.
let trace: BasinTrace | undefined;
registerMethod({
  ...basinHopping,
  name: "test_basin_trace",
  doc: "docs/methods/dimensions/test_basin_trace.md",
  run: (ctx) => {
    trace = { operators: {} as BasinTrace["operators"], kickMagnitude: 0, redraws: 0, failures: 0, refined: false };
    runBasinHopping(ctx, trace);
  },
});
let hops: BasinHop[] = [];
registerMethod({
  ...basinHopping,
  name: "test_basin_hops",
  doc: "docs/methods/dimensions/test_basin_hops.md",
  run: (ctx) => {
    hops = [];
    trace = { operators: {} as BasinTrace["operators"], kickMagnitude: 0, redraws: 0, failures: 0, refined: false };
    runBasinHopping(ctx, trace, (h) => hops.push(h));
  },
});

/**
 * The reference kernel with a dear finishing (`cost` evaluations) that fails on every other call,
 * as a polish that does not converge would.
 */
function dearDisks(P: number, cost: number): SpaceKernel {
  const k = disksKernel(P);
  let calls = 0;
  return { ...k, finishCost: cost, finish: (s, stop) => (calls++ % 2 === 1 ? null : k.finish(s, stop)) };
}

/** The reference kernel with a finishing that gives up on loose states, as the curved polish does. */
function tightOnlyDisks(P: number): SpaceKernel {
  const k = disksKernel(P);
  return {
    ...k,
    finish(s, stop) {
      let dmin = Infinity;
      for (let i = 0; i < P; i++)
        for (let j = i + 1; j < P; j++)
          dmin = Math.min(dmin, Math.hypot(s.x[2 * i] - s.x[2 * j], s.x[2 * i + 1] - s.x[2 * j + 1]));
      // a closest pair more than 1% apart is too loose to finish
      return dmin > 2.02 ? null : k.finish(s, stop);
    },
  };
}

/**
 * The reference kernel whose finishing adds 20% to the radius of every configuration with disk 0
 * left of the centre: valid (the circle only grows), and unrelated to the squeezed size.
 */
function lopsidedDisks(P: number): SpaceKernel {
  const k = disksKernel(P);
  return {
    ...k,
    finish(s, stop) {
      const f = k.finish(s, stop);
      if (!f) return null;
      const c = f.config as { R: number; centres: [number, number][] };
      const R = c.centres[0][0] < 0 ? 1.2 * c.R : c.R;
      return { config: { R, centres: c.centres }, score: R };
    },
  };
}

/** The reference kernel with a swap that exchanges two disks' centres (a disk has no orientation to swap). */
function swappingDisks(P: number): SpaceKernel {
  const k = disksKernel(P);
  return {
    ...k,
    capabilities: [...k.capabilities, "swap"],
    swap(s, i, j) {
      for (let d = 0; d < 2; d++) [s.x[2 * i + d], s.x[2 * j + d]] = [s.x[2 * j + d], s.x[2 * i + d]];
    },
  };
}

const square4 = {
  R: 1 + Math.SQRT2,
  centres: [
    [Math.SQRT2, 0],
    [0, Math.SQRT2],
    [-Math.SQRT2, 0],
    [0, -Math.SQRT2],
  ],
};

describe("basin_hopping", () => {
  it("is registered with its board title, summary, doc and defaults", () => {
    const m = getMethod("basin_hopping")!;
    expect(m.title).toBe("Basin hopping");
    expect(m.summary.length).toBeGreaterThan(20);
    expect(m.doc).toBe("docs/methods/dimensions/basin_hopping.md");
    expect(m.requires).toEqual([]);
    expect(methodsFor(disksKernel(3)).map((d) => d.name)).toContain("basin_hopping");
    expect(Object.keys((m.defaults.weights as object) ?? {})).toEqual([...OPERATORS]);
  });

  it("comes within 1% of the best known packings for P = 2 to 10 in 30,000 evaluations", () => {
    for (let P = 2; P <= 10; P++) {
      const r = runMethod(disksKernel(P), "basin_hopping", { seed: 1, budget: { evals: 30000 } });
      expect(validateDisks(P, r.config, 0).valid).toBe(true);
      expect(r.score!).toBeLessThanOrEqual(DISKS_IN_CIRCLE_BEST[P] * 1.01);
      // never below the best known (a margin for float rounding only)
      expect(r.score!).toBeGreaterThanOrEqual(DISKS_IN_CIRCLE_BEST[P] * (1 - 1e-12));
    }
  });

  it("is reproducible from the seed, and another seed runs differently", () => {
    const run = (seed: number) => runMethod(disksKernel(8), "basin_hopping", { seed, budget: { evals: 4000 } });
    const a = run(5);
    expect(run(5)).toEqual(a);
    expect(run(6).config).not.toEqual(a.config);
  });

  it("spends its evaluation budget and no more than one call beyond it", () => {
    for (const evals of [1, 7, 60, 777, 5000]) {
      const r = runMethod(disksKernel(6), "basin_hopping", { seed: 3, budget: { evals } });
      expect(r.stopped).toBe("evals");
      // the framework ends a run one offer (a finish and a check, 2 here) short rather than overrun
      expect(r.evaluations).toBeGreaterThanOrEqual(evals - 2);
      // the largest single charge is the kernel's four structured starts
      expect(r.evaluations).toBeLessThanOrEqual(evals + 4);
    }
  });

  it("never returns worse than a valid start, and repairs an invalid one", () => {
    const r = runMethod(disksKernel(4), "basin_hopping", { seed: 1, start: square4, budget: { evals: 500 } });
    expect(r.score!).toBeLessThanOrEqual(square4.R);
    // a loose valid start is improved
    const loose = { R: 6, centres: square4.centres.map(([x, y]) => [2 * x, 2 * y]) };
    const l = runMethod(disksKernel(4), "basin_hopping", { seed: 2, start: loose, budget: { evals: 3000 } });
    expect(l.score!).toBeLessThan(6);
    expect(l.score!).toBeLessThan(square4.R * 1.01);
    // every disk at one point: invalid, and the result is still valid
    const heap = { R: 1, centres: Array.from({ length: 5 }, () => [0, 0]) };
    const h = runMethod(disksKernel(5), "basin_hopping", { seed: 2, start: heap, budget: { evals: 3000 } });
    expect(validateDisks(5, h.config, 0).valid).toBe(true);
  });

  it("refuses bad parameters", () => {
    const bad = [
      { temperature: -1 },
      { kickFraction: 2 },
      { kickMagnitude: 0 },
      { reinsertionTrials: 1.5 },
      { weights: { kick: -1 } },
      { weights: { cluster: 1 } },
      { localIterations: 0 },
      { refinementEvals: -1 },
      { nope: 1 },
    ];
    for (const params of bad)
      expect(() => runMethod(disksKernel(3), "basin_hopping", { seed: 1, params, budget: { evals: 10 } })).toThrow();
  });

  it("swaps only where the kernel can, and falls back to kicks when every weight is zero", () => {
    runMethod(disksKernel(6), "test_basin_trace", { seed: 1, budget: { evals: 12000 } });
    expect(trace!.operators.swap.tries).toBe(0);
    expect(trace!.operators.kick.tries + trace!.operators.reinsert.tries).toBeGreaterThan(5);
    const swapped = runMethod(swappingDisks(6), "test_basin_trace", {
      seed: 1,
      params: { weights: { kick: 0, reinsert: 0, restart: 0 } },
      budget: { evals: 6000 },
    });
    expect(trace!.operators.swap.tries).toBeGreaterThan(0);
    expect(trace!.operators.kick.tries).toBe(0);
    expect(validateDisks(6, swapped.config, 0).valid).toBe(true);
    runMethod(disksKernel(6), "test_basin_trace", {
      seed: 1,
      params: { weights: { kick: 0, swap: 0, reinsert: 0, restart: 0 } },
      budget: { evals: 3000 },
    });
    expect(trace!.operators.kick.tries).toBeGreaterThan(0);
  });

  it("grows the kick when hops keep coming back to the same minimum", () => {
    // seven disks: the hexagonal optimum is so deep that small kicks return to it
    runMethod(disksKernel(7), "test_basin_trace", {
      seed: 2,
      params: { weights: { reinsert: 0, restart: 0 } },
      budget: { evals: 20000 },
    });
    expect(trace!.kickMagnitude).toBeGreaterThan(0.35);
    expect(trace!.refined).toBe(true);
  });
});

describe("basin_hopping with other finishings", () => {
  it("accepts by the finished score, not by the squeezed size", () => {
    // at temperature 0 an accepted hop must lower the finished score; the squeezed size knows
    // nothing of the 20% this finishing adds to half the packings
    runMethod(lopsidedDisks(7), "test_basin_hops", { seed: 3, params: { temperature: 0 }, budget: { evals: 20000 } });
    expect(hops.length).toBeGreaterThan(10);
    let current = Infinity;
    for (const h of hops) {
      if (h.accepted) expect(h.score!).toBeLessThan(current);
      expect(h.current).toBeLessThanOrEqual(current);
      current = h.current;
    }
    expect(hops.some((h) => h.score !== null && h.score > 1.1 * h.size)).toBe(true);
  });

  it("copes with a dear finishing that fails half the time, and still refines", () => {
    const r = runMethod(dearDisks(10, 2000), "test_basin_trace", { seed: 1, budget: { evals: 40000 } });
    expect(validateDisks(10, r.config, 0).valid).toBe(true);
    expect(r.score!).toBeLessThanOrEqual(DISKS_IN_CIRCLE_BEST[10] * 1.02);
    expect(r.evaluations).toBeLessThanOrEqual(40000 + 4);
    expect(trace!.refined).toBe(true);
    expect(trace!.failures).toBeGreaterThan(0);
  });

  it("finds a result where the finishing gives up on loose states", () => {
    const r = runMethod(tightOnlyDisks(9), "basin_hopping", { seed: 2, budget: { evals: 10000 } });
    expect(validateDisks(9, r.config, 0).valid).toBe(true);
  });

  it("skips the refinement when it and one offer do not fit a quarter of the budget", () => {
    runMethod(dearDisks(8, 3000), "test_basin_trace", { seed: 1, budget: { evals: 20000 } });
    expect(trace!.refined).toBe(false);
  });
});

describe("the basin_hopping operators", () => {
  it("accepts by the Metropolis rule", () => {
    const rng = mulberry32(1);
    expect(metropolis(2, 1, 0, rng)).toBe(true);
    expect(metropolis(2, 2, 0, rng)).toBe(false);
    expect(metropolis(2, 3, 0, rng)).toBe(false);
    expect(metropolis(2, NaN, 1, rng)).toBe(false);
    let accepted = 0;
    for (let t = 0; t < 4000; t++) if (metropolis(1, 1.1, 0.1, rng)) accepted++;
    expect(accepted / 4000).toBeCloseTo(Math.exp(-1), 1);
  });

  it("chooses operators by their weights, never a disabled one", () => {
    const rng = mulberry32(2);
    const stats = Object.fromEntries(
      OPERATORS.map((o) => [o, { tries: 0, accepted: 0, improvements: 0, successRate: 0 }]),
    ) as never;
    const seen = new Set<string>();
    for (let t = 0; t < 500; t++)
      seen.add(chooseOperator({ kick: 1, swap: 0, reinsert: 1, restart: 0 }, stats, 0.2, rng));
    expect([...seen].sort()).toEqual(["kick", "reinsert"]);
    expect(chooseOperator({ kick: 0, swap: 0, reinsert: 0, restart: 0 }, stats, 0.2, rng)).toBe("kick");
  });

  it("reinserts the piece in the way into a hole", () => {
    // six disks in a ring around an empty centre, at the size of the seven-disk optimum, one disk outside it
    const k = disksKernel(7);
    const centres = Array.from({ length: 6 }, (_, i) => [
      2 * Math.cos((i * Math.PI) / 3),
      2 * Math.sin((i * Math.PI) / 3),
    ]);
    centres.push([3.5, 0.5]);
    const s = k.fromConfig({ R: 3, centres })!;
    const rng = mulberry32(4);
    expect(stressedPiece(k, s, rng, 0.02)).toBe(6);
    reinsert(k, s, 6, rng, 4096);
    expect(k.pieceEnergy(s, 6)).toBeLessThan(0.05);
    expect(Math.hypot(s.x[12], s.x[13])).toBeLessThan(0.2);
  });
});
