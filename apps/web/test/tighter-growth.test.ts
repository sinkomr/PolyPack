import { describe, expect, it } from "vitest";
import { findFreeSpot } from "@polypack/geometry";
import type { PackingConfig, Pose } from "@polypack/geometry";
import { OpenRun, resolvedParams } from "../src/tighter/open-run";
import { presetParams } from "../src/tighter/presets";
import { RUN_BUDGET, methodParams, owning } from "../src/tighter/upgrades";

const board = (N: number, M: number, P: number, shift = 0): PackingConfig => {
  const pieces: Pose[] = [];
  for (let k = 0; k < P; k++) pieces.push(findFreeSpot(N, pieces, 0, 0));
  return { N, M, P, pieces: pieces.map((q) => ({ ...q, x: q.x + shift })), container_phi: 0 };
};

describe("Tighter ls_growth: one growth a run", () => {
  it("runs one growth at every tuning level, with the solver's other defaults", () => {
    const o = owning(["growth", "tuneGrowth"], { tuneGrowth: 3 });
    const defaults = resolvedParams("ls_growth", {});
    for (let l = 0; l <= 3; l++) {
      expect(presetParams("ls_growth", l).runs).toBe(1);
      expect(methodParams(o, "ls_growth", l).runs).toBe(1);
      const r = resolvedParams("ls_growth", methodParams(o, "ls_growth", l));
      expect(r).toMatchObject({ runs: 1, initialShrink: defaults.initialShrink, growthRate: defaults.growthRate });
    }
    // without the tuning card too
    expect(methodParams(owning(["growth"]), "ls_growth")).toEqual({ runs: 1 });
  });

  it(
    "ends a run by itself at its jam, well within its budget, on 8 pieces after Compact",
    { timeout: 60_000 },
    async () => {
      const problem = { N: 21, M: 24, P: 8 };
      const compact = new OpenRun({
        problem,
        method: "mc_compress",
        params: { sweepsPerEvaluation: 10 },
        budget: { evals: RUN_BUDGET },
        seed: 1,
        start: board(21, 24, 8),
      });
      const c = await compact.step(100);
      expect(c.evaluations).toBe(101);
      await compact.close();
      const r = new OpenRun({
        problem,
        method: "ls_growth",
        params: presetParams("ls_growth", 0),
        budget: { evals: RUN_BUDGET },
        seed: 2,
        start: c.best!,
      });
      // early on the pieces are still small: the latest packing scored is larger than the start
      let s = await r.step(20);
      expect(s.last!).toBeGreaterThan(s.score!);
      while (!s.ended && s.evaluations < 20_000) s = await r.step(50);
      expect(s).toMatchObject({ ended: true, closed: false });
      expect(s.evaluations).toBeLessThan(5_000);
      await r.close();
    },
  );
});
