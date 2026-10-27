import { describe, expect, it } from "vitest";
import { type KernelState, type SpaceKernel, mulberry32, runMethod, squeeze } from "../src";
import { descend } from "../src/methods/penalty-schedule";
import { DISKS_IN_CIRCLE_BEST, disksKernel, validateDisks } from "../src/reference/disks";

const valid = (P: number, config: unknown) => validateDisks(P, config, 0).valid;

/** The reference kernel whose finish fails unless the state has no overlap at all, so starts need restoring. */
function strictKernel(P: number, failures: { count: number }): SpaceKernel {
  const base = disksKernel(P);
  return {
    ...base,
    finish(s) {
      if (base.energy(s) > 0) {
        failures.count++;
        return null;
      }
      return base.finish(s);
    },
  };
}

describe("penalty", () => {
  it("comes within 1% of the best known packings for P = 2 to 10 in 20,000 evaluations", () => {
    for (let P = 2; P <= 10; P++) {
      const r = runMethod(disksKernel(P), "penalty", { seed: 1, budget: { evals: 20000 } });
      expect(r.score, `P = ${P}`).not.toBeNull();
      expect(valid(P, r.config)).toBe(true);
      expect(r.score!, `P = ${P}`).toBeLessThan(DISKS_IN_CIRCLE_BEST[P] * 1.01);
      // no valid packing is below the best known, up to rounding
      expect(r.score!).toBeGreaterThanOrEqual(DISKS_IN_CIRCLE_BEST[P] * (1 - 1e-9));
    }
  });

  it("reaches them with the augmented schedule too", () => {
    for (const P of [4, 7, 9]) {
      const r = runMethod(disksKernel(P), "penalty", {
        seed: 2,
        params: { schedule: "augmented", outerIterations: 8 },
        budget: { evals: 20000 },
      });
      expect(valid(P, r.config)).toBe(true);
      expect(r.score!, `P = ${P}`).toBeLessThan(DISKS_IN_CIRCLE_BEST[P] * 1.01);
    }
  });

  it("is reproducible from the seed", () => {
    const run = (seed: number) => runMethod(disksKernel(8), "penalty", { seed, budget: { evals: 4000 } });
    const a = run(5);
    const b = run(5);
    expect(b.config).toEqual(a.config);
    expect(b.evaluations).toBe(a.evaluations);
    expect(run(6).config).not.toEqual(a.config);
  });

  it("keeps within the budget plus one offer, and has a result even on a small budget", () => {
    const costs: [number, number | undefined, number | undefined][] = [
      [1, undefined, undefined],
      [40, undefined, undefined],
      [40, 3, 5],
      [400, 100, undefined],
    ];
    for (const [finishCost, validateCost, gradCost] of costs) {
      for (const evals of [1, 7, 333, 1000, 2500.5, 6000]) {
        const k = { ...disksKernel(6), finishCost, validateCost, gradCost };
        const r = runMethod(k, "penalty", { seed: 3, budget: { evals } });
        const offer = finishCost + (validateCost ?? finishCost);
        // the first result may overrun by its offer; any later offer must fit
        expect(r.evaluations, `costs ${finishCost}/${validateCost}/${gradCost}, budget ${evals}`).toBeLessThan(
          evals + offer,
        );
        // wherever the budget holds a short descent, the run ends with a result
        if (evals >= 333)
          expect(r.score, `costs ${finishCost}/${validateCost}/${gradCost}, budget ${evals}`).not.toBeNull();
        if (r.score !== null) expect(valid(6, r.config)).toBe(true);
      }
    }
  });

  it("never returns worse than a valid start, and repairs an invalid one", () => {
    const best4 = {
      R: 1 + Math.SQRT2,
      centres: [
        [Math.SQRT2, 0],
        [0, Math.SQRT2],
        [-Math.SQRT2, 0],
        [0, -Math.SQRT2],
      ],
    };
    const loose5 = { R: 4, centres: Array.from({ length: 5 }, (_, i) => [2.5 * Math.cos(i), 2.5 * Math.sin(i)]) };
    for (const [P, start] of [
      [4, best4],
      [5, loose5],
    ] as const) {
      const before = validateDisks(P, start, 0);
      expect(before.valid).toBe(true);
      for (const evals of [10, 300, 3000]) {
        const r = runMethod(disksKernel(P), "penalty", { seed: 1, start, budget: { evals } });
        expect(r.score!).toBeLessThanOrEqual(before.score!);
        expect(validateDisks(P, r.config).valid).toBe(true);
      }
    }
    // overlapping disks, one start only: the descent separates them
    const overlapping = { R: 2.5, centres: Array.from({ length: 5 }, (_, i) => [0.3 * i, 0.1 * i]) };
    const r = runMethod(disksKernel(5), "penalty", {
      seed: 1,
      start: overlapping,
      params: { starts: 1 },
      budget: { evals: 3000 },
    });
    expect(valid(5, r.config)).toBe(true);
    expect(r.score!).toBeLessThan(DISKS_IN_CIRCLE_BEST[5] * 1.01);
  });

  it("restores starts whose finish fails, by relaxing or by growing", () => {
    for (const restoration of ["relax", "expand"]) {
      const failures = { count: 0 };
      const r = runMethod(strictKernel(6, failures), "penalty", {
        seed: 4,
        params: { restoration, starts: 4 },
        budget: { evals: 50000 },
      });
      expect(failures.count, restoration).toBeGreaterThan(0);
      expect(r.stopped).toBe("done");
      expect(valid(6, r.config)).toBe(true);
      expect(r.score!, restoration).toBeLessThan(DISKS_IN_CIRCLE_BEST[6] * 1.01);
    }
  });

  it("runs a fixed number of starts, and without the seeds capability", () => {
    const k = disksKernel(5);
    const plain: SpaceKernel = { ...k, capabilities: ["shape"], seeds: undefined };
    const r = runMethod(plain, "penalty", { seed: 1, params: { starts: 3 }, budget: { evals: 1e6 } });
    expect(r.stopped).toBe("done");
    expect(r.evaluations).toBeLessThan(20000);
    expect(valid(5, r.config)).toBe(true);
  });

  it("stops asking a kernel for seeds once they repeat", () => {
    const k = disksKernel(7);
    const fixed = k.seeds!(() => 0.25, 3);
    let calls = 0;
    const repeating: SpaceKernel = {
      ...k,
      seeds: (_rng, count) => {
        calls++;
        return fixed.slice(0, count).map((s: KernelState) => k.clone(s));
      },
    };
    const r = runMethod(repeating, "penalty", { seed: 1, params: { seedShare: 1 }, budget: { evals: 20000 } });
    expect(valid(7, r.config)).toBe(true);
    // one batch with the three seeds, one with nothing new, one doubled with nothing new
    expect(calls).toBe(3);
  });

  it("ends on the external stop with a valid best", () => {
    let calls = 0;
    const r = runMethod(disksKernel(6), "penalty", { seed: 1, budget: {}, shouldStop: () => ++calls > 3000 });
    expect(r.stopped).toBe("stopped");
    expect(valid(6, r.config)).toBe(true);
  });

  it("descends from the given start", () => {
    // no random starts and no seeds: a run that ignored its start would have nothing to descend from
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
    const r = runMethod(startless, "penalty", {
      seed: 1,
      start: overlapping,
      params: { starts: 1 },
      budget: { evals: 1e5 },
    });
    expect(r.stopped).toBe("done");
    expect(valid(5, r.config)).toBe(true);
  });

  it("jitters each start with the seeded stream, and not at all with jitter 0", () => {
    const start = { R: 4, centres: Array.from({ length: 6 }, (_, i) => [2.5 * Math.cos(i), 2.5 * Math.sin(i)]) };
    const run = (seed: number, jitter: number) =>
      runMethod(disksKernel(6), "penalty", { seed, start, params: { starts: 1, jitter }, budget: { evals: 1e5 } })
        .config;
    expect(run(1, 0)).toEqual(run(2, 0));
    expect(run(1, 0.1)).not.toEqual(run(2, 0.1));
  });

  it("polishes a new best, and stops polishing where it gains nothing", () => {
    // one start: the polish takes the residual overlaps of the descent's last weight away
    const once = (polish: boolean) =>
      runMethod(disksKernel(10), "penalty", { seed: 2, params: { starts: 1, polish }, budget: { evals: 1e5 } }).score!;
    expect(once(true)).toBeLessThan(once(false) * (1 - 1e-9));
    // a finish that polishes by itself: the first polish gains nothing, and no other is tried
    const base = disksKernel(7);
    let finishes = 0;
    const polishing: SpaceKernel = {
      ...base,
      finish(s) {
        finishes++;
        const q = base.clone(s);
        squeeze(base, q, { mus: [1e6, 1e7, 1e8, 1e9] });
        return base.finish(q);
      },
    };
    const r = runMethod(polishing, "penalty", { seed: 1, params: { starts: 12 }, budget: { evals: 1e6 } });
    expect(r.stopped).toBe("done");
    expect(finishes).toBe(12 + 1);
  });

  it("raises the weights of the lagging pieces under the augmented schedule only", () => {
    const options = {
      initialWeight: 10,
      growthFactor: 10,
      outerIterations: 6,
      innerIterations: 200,
      violationReduction: 0.5,
    };
    for (const schedule of ["quadratic", "augmented"] as const) {
      const base = disksKernel(9);
      const seen: (Float64Array | undefined)[] = [];
      const k: SpaceKernel = {
        ...base,
        energy: (s, g, w) => (seen.push(w && Float64Array.from(w)), base.energy(s, g, w)),
      };
      const s = base.randomStart(mulberry32(5));
      descend(k, s, { ...options, schedule });
      const heaviest = Math.max(...seen.map((w) => (w ? Math.max(...w) : 1)));
      const lightest = Math.min(...seen.map((w) => (w ? Math.min(...w) : 1)));
      if (schedule === "quadratic") expect(heaviest).toBe(1);
      else {
        // weights only ever rise, and not all alike: the pieces whose residual lagged got heavier
        expect(lightest).toBe(1);
        expect(heaviest).toBeGreaterThan(1);
        const last = seen[seen.length - 1]!;
        expect(Math.min(...last)).toBeLessThan(Math.max(...last));
      }
      expect(base.finish(s)).not.toBeNull();
    }
  });

  it("refuses bad parameters", () => {
    const bad: Record<string, unknown>[] = [
      { initialWeight: 0 },
      { growthFactor: 0.5 },
      { outerIterations: 0 },
      { innerIterations: 2.5 },
      { violationReduction: 1 },
      { jitter: -1 },
      { schedule: "cubic" },
      { restoration: "pray" },
      { seedShare: 1.5 },
      { starts: -1 },
      { restarts: 2 },
      { polish: "yes" },
      { nope: 1 },
    ];
    for (const params of bad)
      expect(() => runMethod(disksKernel(3), "penalty", { seed: 1, params, budget: { evals: 10 } })).toThrow();
  });
});
