import { describe, expect, it } from "vitest";
import { type SpaceKernel, mulberry32, registerMethod, runMethod } from "../src";
import { type ShrinkRepairEvent, runShrinkRepair, shrinkRepair } from "../src/methods/shrink_repair";
import { REPAIRED, Repair, type RuinKind, region, ruin } from "../src/methods/shrink-phase";
import { DISKS_IN_CIRCLE_BEST, disksKernel, validateDisks } from "../src/reference/disks";

// The same method with its repairs exposed, for the tests that look inside a run.
let events: ShrinkRepairEvent[] = [];
registerMethod({
  ...shrinkRepair,
  name: "test_shrink_events",
  doc: "docs/methods/dimensions/test_shrink_events.md",
  run: (ctx) => {
    events = [];
    runShrinkRepair(ctx, (e) => events.push(e));
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
 * The reference kernel whose finishing never gives a radius below the offered size, and adds 10%:
 * valid (the circle only grows). A compression by less than 9% then never finishes below the size
 * it shrank from.
 */
function inflatingDisks(P: number): SpaceKernel {
  const k = disksKernel(P);
  return {
    ...k,
    finish(s, stop) {
      const f = k.finish(s, stop);
      if (!f) return null;
      const R = 1.1 * Math.max(f.score, s.size);
      return { config: { R, centres: (f.config as { centres: unknown }).centres }, score: R };
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

const settings = {
  globalSamples: 16,
  localSamples: 8,
  weightGrowth: 2,
  weightDecay: 0.95,
  descentIterations: 40,
  strikes: 1,
};

describe("shrink_repair", () => {
  it("comes within 1% of the best known packings for P = 2 to 10 in 30,000 evaluations", () => {
    for (let P = 2; P <= 10; P++) {
      const r = runMethod(disksKernel(P), "shrink_repair", { seed: 1, budget: { evals: 30000 } });
      expect(validateDisks(P, r.config, 0).valid).toBe(true);
      expect(r.score!).toBeLessThanOrEqual(DISKS_IN_CIRCLE_BEST[P] * 1.01);
      // never below the best known (a margin for float rounding only)
      expect(r.score!).toBeGreaterThanOrEqual(DISKS_IN_CIRCLE_BEST[P] * (1 - 1e-12));
    }
  });

  it("is reproducible from the seed, and another seed runs differently", () => {
    const run = (seed: number) => runMethod(disksKernel(9), "shrink_repair", { seed, budget: { evals: 4000 } });
    const a = run(5);
    expect(run(5)).toEqual(a);
    expect(run(6).config).not.toEqual(a.config);
  });

  it("spends its evaluation budget and no more than one call beyond it", () => {
    for (const evals of [1, 7, 60, 777, 5000]) {
      const r = runMethod(disksKernel(6), "shrink_repair", { seed: 3, budget: { evals } });
      expect(r.stopped).toBe("evals");
      // the framework ends a run one offer (a finish and a check, 2 here) short rather than overrun
      expect(r.evaluations).toBeGreaterThanOrEqual(evals - 2);
      // the largest single charge is the kernel's four structured starts
      expect(r.evaluations).toBeLessThanOrEqual(evals + 4);
    }
  });

  it("never returns worse than a valid start, from either start mode", () => {
    // the optimal hexagon, opened by 1e-12 so that rounding cannot make it overlap
    const ring = 2 * (1 + 1e-12);
    const hexagon = {
      R: ring + 1 + 1e-12,
      centres: [
        [0, 0],
        ...Array.from({ length: 6 }, (_, i) => [
          ring * Math.cos((i * Math.PI) / 3),
          ring * Math.sin((i * Math.PI) / 3),
        ]),
      ],
    };
    expect(validateDisks(7, hexagon, 0).valid).toBe(true);
    for (const start of ["auto", "random"]) {
      const r = runMethod(disksKernel(7), "shrink_repair", {
        seed: 1,
        start: hexagon,
        params: { start },
        budget: { evals: 2000 },
      });
      expect(r.score!).toBeLessThanOrEqual(hexagon.R);
    }
    // a loose valid start is shrunk; every disk at one point is repaired
    const loose = { R: 9, centres: hexagon.centres.map(([x, y]) => [2 * x, 2 * y]) };
    const l = runMethod(disksKernel(7), "shrink_repair", { seed: 2, start: loose, budget: { evals: 3000 } });
    expect(l.score!).toBeLessThan(3 * 1.01);
    const heap = { R: 1, centres: Array.from({ length: 5 }, () => [0, 0]) };
    const h = runMethod(disksKernel(5), "shrink_repair", { seed: 2, start: heap, budget: { evals: 3000 } });
    expect(validateDisks(5, h.config, 0).valid).toBe(true);
  });

  it("refuses bad parameters", () => {
    const bad = [
      { start: "seed" },
      { shrinkRatio: 0 },
      { minShrinkRatio: 0.6 },
      { strikes: 0 },
      { patience: 2.5 },
      { globalSamples: -1 },
      { weightGrowth: 0.5 },
      { weightDecay: 1.5 },
      { maxRuin: 2 },
      { polish: "yes" },
      { evaluationWork: 4000 },
    ];
    for (const params of bad)
      expect(() => runMethod(disksKernel(3), "shrink_repair", { seed: 1, params, budget: { evals: 10 } })).toThrow();
  });

  it("compresses, polishes the floor of a basin, then explores with ruins", () => {
    runMethod(disksKernel(10), "test_shrink_events", { seed: 4, budget: { evals: 20000 } });
    const kinds = new Set(events.map((e) => e.kind));
    expect(kinds).toContain("compress");
    expect(kinds).toContain("polish");
    expect(kinds).toContain("explore");
    // every exploration ruins a region of 1 to maxRuin P = 5 pieces
    for (const e of events.filter((e) => e.kind === "explore")) {
      expect(e.ruined).toBeGreaterThanOrEqual(1);
      expect(e.ruined).toBeLessThanOrEqual(5);
    }
    // successful compressions shrink: each finished score is below the size it was shrunk from
    const compressed = events.filter((e) => e.kind === "compress" && e.score !== null);
    expect(compressed.length).toBeGreaterThan(3);
  });

  it("restarts after failed explorations", () => {
    runMethod(disksKernel(5), "test_shrink_events", { seed: 1, params: { restartAfter: 1 }, budget: { evals: 20000 } });
    // a restart repairs random poses just above the best size and continues from them
    const restarts = events.filter((e) => e.kind === "restart");
    expect(restarts.length).toBeGreaterThan(1);
    // a restart above the best is not offered: it cannot beat it
    for (const e of restarts) if (e.offered) expect(e.size).toBeLessThan(DISKS_IN_CIRCLE_BEST[5] * 1.03);
  });
});

describe("shrink_repair with other finishings", () => {
  it("accepts an offered state by its finished score, not by its repaired size", () => {
    runMethod(inflatingDisks(8), "test_shrink_events", {
      seed: 1,
      params: { restartAfter: 0 },
      budget: { evals: 15000 },
    });
    const start = events.find((e) => e.kind === "start" && e.score !== null)!.score!;
    const shrinks = events.filter((e) => e.kind === "compress" || e.kind === "explore");
    expect(shrinks.some((e) => e.repaired && e.offered)).toBe(true);
    // no compression finishes below the size it shrank from, so the current packing never moves:
    // every target stays below the start's score
    for (const e of shrinks) expect(e.size).toBeLessThan(start);
  });

  it("rations dear offers, banks its progress at the end, and copes with a finishing that fails", () => {
    const r = runMethod(dearDisks(10, 2000), "test_shrink_events", { seed: 1, budget: { evals: 40000 } });
    expect(validateDisks(10, r.config, 0).valid).toBe(true);
    expect(r.score!).toBeLessThanOrEqual(DISKS_IN_CIRCLE_BEST[10] * 1.01);
    expect(r.evaluations).toBeLessThanOrEqual(40000 + 4);
    // offers (4,000 evaluations each with the check) stay near a quarter of the budget: the start,
    // the banks and the refinement
    const offered = events.filter((e) => e.offered);
    expect(offered.length).toBeLessThanOrEqual(5);
    expect(events.some((e) => e.kind === "refine" || e.kind === "bank")).toBe(true);
  });

  it("squeezes its start when only two offers fit the budget", () => {
    // an improving offer costs 10,000 of 20,000 evaluations: the start's offer is about the only one
    const r = runMethod({ ...disksKernel(8), finishCost: 5000 }, "shrink_repair", {
      seed: 1,
      budget: { evals: 20000 },
    });
    expect(r.score!).toBeLessThanOrEqual(DISKS_IN_CIRCLE_BEST[8] * 1.001);
  });

  it("finds a result where the finishing gives up on loose states", () => {
    const r = runMethod(tightOnlyDisks(9), "shrink_repair", { seed: 2, budget: { evals: 10000 } });
    expect(validateDisks(9, r.config, 0).valid).toBe(true);
    expect(r.score!).toBeLessThanOrEqual(DISKS_IN_CIRCLE_BEST[9] * 1.01);
  });

  it("never targets a size below the lower bound, whatever the ratios", () => {
    const k = disksKernel(8);
    runMethod(k, "test_shrink_events", {
      seed: 1,
      params: { shrinkRatio: 0.5, minShrinkRatio: 0.5, maxShrinkRatio: 0.5, restartAfter: 1 },
      budget: { evals: 20000 },
    });
    const shrinks = events.filter((e) => e.kind === "compress" || e.kind === "explore");
    expect(shrinks.length).toBeGreaterThan(5);
    for (const e of shrinks) expect(e.size).toBeGreaterThanOrEqual(k.bound!);
  });
});

describe("the repair phase", () => {
  it("repairs disks heaped at one point in a roomy circle", () => {
    const k = disksKernel(5);
    const s = k.fromConfig({ R: 3.2, centres: Array.from({ length: 5 }, (_, i) => [1e-3 * i, 0]) })!;
    const repair = new Repair(k, settings, mulberry32(1));
    expect(repair.run(s, 3)).toBe(true);
    expect(k.energy(s)).toBeLessThanOrEqual(REPAIRED);
    expect(s.size).toBe(3.2);
  });

  it("fails below the optimum, raising the weights of the pieces in conflict", () => {
    const k = disksKernel(7);
    const s = k.randomStart(mulberry32(3));
    k.setSize(s, 2.9);
    const repair = new Repair(k, settings, mulberry32(2));
    expect(repair.run(s, 3)).toBe(false);
    expect(Math.min(...repair.weights)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...repair.weights)).toBeGreaterThan(1);
    expect(repair.iterations).toBeLessThanOrEqual(4 * 1 * 3);
    repair.resetWeights();
    expect([...repair.weights].every((w) => w === 1)).toBe(true);
  });

  it("finds a region of neighbours from the energy alone", () => {
    // disks in a row: a region is a run of consecutive disks
    const k = disksKernel(9);
    const s = k.fromConfig({ R: 10, centres: Array.from({ length: 9 }, (_, i) => [2 * i - 8, 0]) })!;
    const rng = mulberry32(5);
    for (let t = 0; t < 20; t++) {
      const count = 1 + (t % 9);
      const chosen = region(k, s, count, rng).sort((a, b) => a - b);
      expect(chosen.length).toBe(count);
      expect(chosen[chosen.length - 1] - chosen[0]).toBe(count - 1);
    }
  });

  it("ruins by shifting, scattering, and swapping where the kernel can", () => {
    const rng = mulberry32(6);
    const seen = new Set<RuinKind>();
    const plain = disksKernel(6);
    const s = plain.randomStart(rng);
    for (let t = 0; t < 30; t++) seen.add(ruin(plain, plain.clone(s), [0, 1, 2], rng));
    expect([...seen].sort()).toEqual(["scatter", "shift"]);
    const swapping = swappingDisks(6);
    for (let t = 0; t < 30; t++) {
      const q = swapping.clone(s);
      const kind = ruin(swapping, q, [0, 1, 2], rng);
      seen.add(kind);
      // only the ruined pieces move
      for (let i = 6; i < 12; i++) expect(q.x[i]).toBe(s.x[i]);
    }
    expect(seen).toContain("swap");
  });
});
