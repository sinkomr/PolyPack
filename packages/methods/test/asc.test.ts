import { describe, expect, it } from "vitest";
import { getMethod, methodsFor, runMethod } from "../src";
import type { KernelState, SpaceKernel } from "../src/kernel";
import { DISKS_IN_CIRCLE_BEST, disksKernel, validateDisks } from "../src/reference/disks";
import { instrument, torusDisksKernel, validateTorusDisks } from "./mc-torus-kernel";

const excess = (score: number | null, best: number) => (score ?? Infinity) / best - 1;

/** The best packing of seven disks, the centre and a ring of six, with the centres scaled by `scale`. */
const hexagon = (scale: number) => ({
  R: 2 * scale + 1,
  centres: [
    [0, 0],
    ...Array.from({ length: 6 }, (_, i) => [2 * scale * Math.cos((i * Math.PI) / 3), 2 * scale * Math.sin((i * Math.PI) / 3)]),
  ] as [number, number][],
});

describe("asc", () => {
  it("is registered with its board text, for every kernel", () => {
    const m = getMethod("asc")!;
    expect(m.title).toBe("Adaptive shrinking container");
    expect(m.summary).toMatch(/\.$/);
    expect(m.requires).toEqual([]);
    expect(methodsFor(disksKernel(3)).map((d) => d.name)).toContain("asc");
  });

  // Measured over seeds 1-20 at 30000 evaluations (docs/methods/dimensions/asc.md): P = 3 to 8
  // end within 1e-7 of the best known radius in most runs, but a run can cage a disk (P = 5 at
  // R = 3) and return at stagnation; P = 9 within 3e-2, P = 10 within 3e-2. Thresholds: the best
  // of three seeds (tight) and each of them (loose), with a margin.
  it("comes close to the best known packings of 2 to 10 disks in a circle within 30000 evaluations", () => {
    const tight: Record<number, number> = { 2: 2e-4, 9: 0.03, 10: 0.01 };
    const loose: Record<number, number> = { 2: 2e-3, 9: 0.05, 10: 0.04 };
    for (let P = 2; P <= 10; P++) {
      const e = [1, 2, 3].map((seed) => {
        const r = runMethod(disksKernel(P), "asc", { seed, budget: { evals: 30000 } });
        expect(validateDisks(P, r.config, 0).valid).toBe(true);
        return excess(r.score, DISKS_IN_CIRCLE_BEST[P]);
      });
      expect(Math.min(...e), `P = ${P}`).toBeLessThan(tight[P] ?? 1e-6);
      expect(Math.max(...e), `P = ${P}`).toBeLessThan(loose[P] ?? 0.12);
      expect(Math.min(...e)).toBeGreaterThan(-1e-9);
    }
  });

  it("strains the cell (the globals) to the hexagonal lattice on a free torus, which needs them", () => {
    for (const P of [1, 2]) {
      const k = torusDisksKernel(P);
      const runs = [1, 2, 3].map((seed) => runMethod(torusDisksKernel(P), "asc", { seed, budget: { evals: 30000 } }));
      for (const r of runs) expect(validateTorusDisks(P, r.config, 0).valid).toBe(true);
      // seeds 1-20 at 30000 evaluations: 20 of 20 runs for one disk, 17 of 20 for two (worst 3.4e-2)
      const e = runs.map((r) => excess(r.score, k.bound!));
      expect(Math.min(...e)).toBeLessThan(1e-6);
      expect(Math.max(...e)).toBeLessThan(0.06);
    }
    // without the container moves the cell keeps its shape: one disk stays in its square cell
    const fixed = runMethod(torusDisksKernel(1), "asc", {
      seed: 1,
      params: { containerMoves: false },
      budget: { evals: 5000 },
    });
    expect(fixed.score).toBeGreaterThan(2 - 1e-9);
  });

  it("is reproducible from the seed and keeps to its evaluation budget", () => {
    const a = runMethod(disksKernel(8), "asc", { seed: 4, budget: { evals: 4000 } });
    const b = runMethod(disksKernel(8), "asc", { seed: 4, budget: { evals: 4000 } });
    const c = runMethod(disksKernel(8), "asc", { seed: 5, budget: { evals: 4000 } });
    expect(b.config).toEqual(a.config);
    expect(b.evaluations).toBe(a.evaluations);
    expect(c.config).not.toEqual(a.config);
    expect(a.stopped).toBe("evals");
    // the run ends at the budget, or where the framework refuses an offer that no longer fits
    expect(a.evaluations).toBeGreaterThan(4000 - 3);
    expect(a.evaluations).toBeLessThan(4000 + 3);
  });

  it("never returns worse than a valid start, and recovers a loose one's packing", () => {
    const tight = hexagon(1);
    const r = runMethod(disksKernel(7), "asc", { seed: 1, start: tight, budget: { evals: 2000 } });
    expect(r.score).toBeLessThanOrEqual(tight.R);
    // centres 30% apart: the radial warmup keeps the contact pattern and closes it
    for (const seed of [1, 2, 3]) {
      const loose = runMethod(disksKernel(7), "asc", { seed, start: hexagon(1.3), budget: { evals: 600 } });
      expect(loose.score).toBeLessThan(3 * (1 + 1e-4));
    }
    const bad = { R: 1, centres: hexagon(0.2).centres };
    const s = runMethod(disksKernel(7), "asc", { seed: 1, start: bad, budget: { evals: 3000 } });
    expect(validateDisks(7, s.config, 0).valid).toBe(true);
    expect(excess(s.score, 3)).toBeLessThan(0.2);
  });

  it("offers only hard states: every piece clear at tolerance 0", () => {
    const base = disksKernel(6);
    let offers = 0;
    const k: SpaceKernel = {
      ...base,
      finish(s: KernelState) {
        offers++;
        expect(validateDisks(6, base.toConfig(s), 0).valid).toBe(true);
        return base.finish(s);
      },
    };
    for (const params of [{}, { temperature: 0.05 }]) {
      // an expect that fails inside finish is caught by runMethod, which then reports an error
      const r = runMethod(k, "asc", { seed: 2, params, budget: { evals: 5000 } });
      expect(r.stopped).not.toBe("error");
    }
    expect(offers).toBeGreaterThan(100);
  });

  it("with charts and a dear finish: offers take their share, the last state is offered, no trial is empty", () => {
    for (const seed of [1, 2]) {
      const { kernel, probe } = instrument(torusDisksKernel(3));
      const budget = 20000;
      const r = runMethod(kernel, "asc", { seed, budget: { evals: budget } });
      // it ends at stagnation, or where the framework refuses an offer that no longer fits (60)
      if (r.stopped === "evals") expect(r.evaluations).toBeGreaterThan(budget - 2 * 60);
      else expect(r.stopped).toBe("done");
      expect(probe.offerCost / r.evaluations).toBeGreaterThan(0.15);
      expect(probe.offerCost / r.evaluations).toBeLessThan(0.25);
      // setSize changes the size alone here, so radial and centres are left out, not tried empty
      expect(probe.empty).toBe(0);
      const base = torusDisksKernel(3);
      const end = base.finish(base.clone(probe.chain!))!;
      expect(r.score!).toBeLessThanOrEqual(end.score * (1 + 1e-3));
    }
  });

  it("ends on the external stop with a valid best", () => {
    let calls = 0;
    const r = runMethod(disksKernel(5), "asc", { seed: 1, budget: {}, shouldStop: () => ++calls > 2000 });
    expect(r.stopped).toBe("stopped");
    expect(validateDisks(5, r.config, 0).valid).toBe(true);
  });

  it("refuses bad parameters", () => {
    const run = (params: Record<string, unknown>) => runMethod(disksKernel(3), "asc", { seed: 1, params, budget: { evals: 10 } });
    expect(() => run({ driftStep: 0 })).toThrow(/driftStep/);
    expect(() => run({ radialStep: 0.5 })).toThrow(/radialStep/);
    expect(() => run({ strainStep: -1 })).toThrow(/strainStep/);
    expect(() => run({ stagnationSweeps: 0 })).toThrow(/stagnationSweeps/);
    expect(() => run({ containerMoves: "yes" })).toThrow(/containerMoves/);
    expect(() => run({ balancedStep: 0.01 })).toThrow(/unknown parameter/);
    const ok = runMethod(disksKernel(3), "asc", {
      seed: 1,
      params: { containerMoves: false, collectiveMoves: false, temperature: 0.1, adaptationGain: 0 },
      budget: { evals: 500 },
    });
    expect(ok.score).not.toBeNull();
  });
});
