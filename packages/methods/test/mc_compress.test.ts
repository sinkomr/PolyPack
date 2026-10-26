import { describe, expect, it } from "vitest";
import { getMethod, listMethods, methodsFor, runMethod } from "../src";
import type { KernelState, SpaceKernel } from "../src/kernel";
import { sizeMoves } from "../src/methods/mc-chain";
import { mulberry32 } from "../src/random";
import { DISKS_IN_CIRCLE_BEST, disksKernel, validateDisks } from "../src/reference/disks";
import { instrument, torusDisksKernel, validateTorusDisks } from "./mc-torus-kernel";

const excess = (score: number | null, best: number) => (score ?? Infinity) / best - 1;

/** P disks of the best packing of seven, the centre and a ring of six, with the centres scaled by `scale`. */
const hexagon = (scale: number) => ({
  R: 2 * scale + 1,
  centres: [
    [0, 0],
    ...Array.from({ length: 6 }, (_, i) => [2 * scale * Math.cos((i * Math.PI) / 3), 2 * scale * Math.sin((i * Math.PI) / 3)]),
  ] as [number, number][],
});

describe("mc_compress", () => {
  it("is registered after penalty's place, with its board text, for every kernel", () => {
    const m = getMethod("mc_compress")!;
    expect(m.title).toBe("Monte Carlo compression");
    expect(m.summary).toMatch(/\.$/);
    expect(m.requires).toEqual([]);
    expect(methodsFor(disksKernel(3)).map((d) => d.name)).toContain("mc_compress");
    const names = listMethods().map((d) => d.name);
    expect(names.indexOf("mc_compress")).toBeLessThan(names.indexOf("asc"));
  });

  // Measured over seeds 1-20 at 30000 evaluations (docs/methods/dimensions/mc_compress.md): P = 3
  // to 9 end within 1e-7 of the best known radius in 18 of 20 runs or more, but a run can jam (five
  // disks with one caged by four, R = 3, in 1 of 20); P = 2 within 3e-5 (two disks jam off the
  // diameter); P = 10 within 1.3e-2. Thresholds: the best of three seeds (tight) and each of them
  // (loose), with a margin, so that a changed trajectory does not fail them.
  it("comes close to the best known packings of 2 to 10 disks in a circle within 30000 evaluations", () => {
    const tight: Record<number, number> = { 2: 1e-4, 9: 1e-6, 10: 5e-3 };
    const loose: Record<number, number> = { 2: 1e-3, 9: 0.05, 10: 0.02 };
    for (let P = 2; P <= 10; P++) {
      const e = [1, 2, 3].map((seed) => {
        const r = runMethod(disksKernel(P), "mc_compress", { seed, budget: { evals: 30000 } });
        expect(validateDisks(P, r.config, 0).valid).toBe(true);
        return excess(r.score, DISKS_IN_CIRCLE_BEST[P]);
      });
      expect(Math.min(...e), `P = ${P}`).toBeLessThan(tight[P] ?? 1e-6);
      expect(Math.max(...e), `P = ${P}`).toBeLessThan(loose[P] ?? 0.12);
      // nothing beats a proven optimum (P <= 10 are proven), so the scores are honest
      expect(Math.min(...e)).toBeGreaterThan(-1e-9);
    }
  });

  // Measured over seeds 1-20 at 30000 evaluations: one disk reaches the hexagonal lattice in 19 of
  // 20 runs (worst 1.5e-3), two disks in 9 of 20 (worst 3.4e-2); the square cell is 2 against 1.8612.
  it("reaches the hexagonal lattice on a free torus by moving the cell's shape (the globals)", () => {
    for (const P of [1, 2]) {
      const k = torusDisksKernel(P);
      const runs = [1, 2, 3].map((seed) => runMethod(torusDisksKernel(P), "mc_compress", { seed, budget: { evals: 30000 } }));
      for (const r of runs) expect(validateTorusDisks(P, r.config, 0).valid).toBe(true);
      const e = runs.map((r) => excess(r.score, k.bound!));
      if (P === 1) expect(Math.min(...e)).toBeLessThan(1e-6);
      expect(Math.max(...e)).toBeLessThan(P === 1 ? 1e-2 : 0.06);
    }
  });

  it("is reproducible from the seed and keeps to its evaluation budget", () => {
    const a = runMethod(disksKernel(8), "mc_compress", { seed: 4, budget: { evals: 4000 } });
    const b = runMethod(disksKernel(8), "mc_compress", { seed: 4, budget: { evals: 4000 } });
    const c = runMethod(disksKernel(8), "mc_compress", { seed: 5, budget: { evals: 4000 } });
    expect(b.config).toEqual(a.config);
    expect(b.evaluations).toBe(a.evaluations);
    expect(c.config).not.toEqual(a.config);
    expect(a.stopped).toBe("evals");
    // the run ends at the budget, or where the framework refuses an offer that no longer fits
    // (a finish and a validation, 1 each); the last call may start just below the budget
    expect(a.evaluations).toBeGreaterThan(4000 - 3);
    expect(a.evaluations).toBeLessThan(4000 + 3);
  });

  it("never returns worse than a valid start, and recovers a loose one's packing", () => {
    const tight = hexagon(1);
    expect(validateDisks(7, tight).valid).toBe(true);
    const r = runMethod(disksKernel(7), "mc_compress", { seed: 1, start: tight, budget: { evals: 2000 } });
    expect(r.score).toBeLessThanOrEqual(tight.R);
    // centres 30% apart: the contraction keeps the contact pattern and closes it
    for (const seed of [1, 2, 3]) {
      const loose = runMethod(disksKernel(7), "mc_compress", { seed, start: hexagon(1.3), budget: { evals: 600 } });
      expect(loose.score).toBeLessThan(3 * (1 + 1e-9));
    }
    // an overlapping start is separated, not trusted
    const bad = { R: 1, centres: hexagon(0.2).centres };
    const s = runMethod(disksKernel(7), "mc_compress", { seed: 1, start: bad, budget: { evals: 3000 } });
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
    for (const params of [{}, { initialTemperature: 0.05, maxRestarts: 3, stagnationSweeps: 200 }]) {
      // an expect that fails inside finish is caught by runMethod, which then reports an error
      const r = runMethod(k, "mc_compress", { seed: 2, params, budget: { evals: 5000 } });
      expect(r.stopped).not.toBe("error");
    }
    expect(offers).toBeGreaterThan(100);
  });

  it("knows which size moves a space has besides setSize", () => {
    const rng = mulberry32(1);
    const disks = disksKernel(4);
    expect(sizeMoves(disks, disks.randomStart(rng))).toEqual({ centres: true, walls: true });
    // setSize changes the size alone, as in the torus and surface spaces: neither is a move
    const torus = torusDisksKernel(3);
    expect(sizeMoves(torus, torus.randomStart(rng))).toEqual({ centres: false, walls: false });
  });

  it("with charts and a dear finish: offers take their share, the last state is offered, no trial is empty", () => {
    for (const seed of [1, 2]) {
      const { kernel, probe } = instrument(torusDisksKernel(3));
      const budget = 20000;
      const r = runMethod(kernel, "mc_compress", { seed, budget: { evals: budget } });
      expect(r.stopped).toBe("evals");
      // it ends where the framework refuses an offer that no longer fits (a finish 50, a validation 10)
      expect(r.evaluations).toBeGreaterThan(budget - 2 * 60);
      // offerShare 0.2, with the start's offer and the last ones on top
      expect(probe.offerCost / r.evaluations).toBeGreaterThan(0.15);
      expect(probe.offerCost / r.evaluations).toBeLessThan(0.25);
      expect(probe.empty).toBe(0);
      // the chain's state at the end finishes no better than the result, up to the last few moves
      const base = torusDisksKernel(3);
      const end = base.finish(base.clone(probe.chain!))!;
      expect(r.score!).toBeLessThanOrEqual(end.score * (1 + 1e-3));
    }
  });

  it("ends on the external stop with a valid best", () => {
    let calls = 0;
    const r = runMethod(disksKernel(5), "mc_compress", { seed: 1, budget: {}, shouldStop: () => ++calls > 2000 });
    expect(r.stopped).toBe("stopped");
    expect(validateDisks(5, r.config, 0).valid).toBe(true);
  });

  it("refuses bad parameters", () => {
    const run = (params: Record<string, unknown>) =>
      runMethod(disksKernel(3), "mc_compress", { seed: 1, params, budget: { evals: 10 } });
    expect(() => run({ moveStep: 0 })).toThrow(/moveStep/);
    expect(() => run({ shrinkFraction: 0.5 })).toThrow(/shrinkFraction/);
    expect(() => run({ targetAcceptance: 1.5 })).toThrow(/targetAcceptance/);
    expect(() => run({ adaptationSweeps: 2.5 })).toThrow(/integer/);
    expect(() => run({ offerShare: 0 })).toThrow(/offerShare/);
    expect(() => run({ restartExpansion: Number.NaN })).toThrow(/restartExpansion/);
    expect(() => run({ step: 0.1 })).toThrow(/unknown parameter/);
    const ok = runMethod(disksKernel(3), "mc_compress", {
      seed: 1,
      params: { maxRestarts: 0, initialTemperature: 0.1, jumpRate: 1 },
      budget: { evals: 500 },
    });
    expect(ok.score).not.toBeNull();
  });
});
