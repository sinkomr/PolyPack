import { describe, expect, it } from "vitest";
import {
  POLYHEDRA_MAX_P, configErrors, getProblem, latticeStart, parsePolyhedraId,
  polyhedraKernel, validatePolyhedra, validatePolyhedraAsync, volumeBound,
} from "../src";

const codes = ["cubincub", "tetintet", "tidintid", "dtcindtc", "pr12l3incub"];

describe("polyhedra through P = 500", () => {
  it.each(codes)("constructs deterministic valid lattice starts for %s", async (code) => {
    const problem = getProblem(code)!;
    for (const P of [2, 17, 101, 257, 500]) {
      const startAt = performance.now();
      const c = latticeStart(problem, P);
      const startMs = performance.now() - startAt;
      expect(c).toEqual(latticeStart(problem, P));
      expect(configErrors(c, P)).toEqual([]);
      expect(c.s).toBeGreaterThanOrEqual(volumeBound(problem, P));
      const v = await validatePolyhedraAsync(problem, c, { tol: 0 });
      expect(v.valid, `${code}/${P}: ${v.errors.join("; ")}`).toBe(true);
      expect(typeof parsePolyhedraId(`polyhedra/${code}/${P}`)).toBe("object");
      if (P === 500) {
        const t = performance.now();
        const sync = validatePolyhedra(problem, c, { tol: 0 });
        const syncMs = performance.now() - t;
        const { workMs, slices, longestSliceMs, ...verdict } = v;
        expect(verdict).toEqual(sync);
        // Assert yielding, not host scheduling: preemption can inflate any wall-clock slice.
        if (code === "tidintid" || code === "dtcindtc") {
          expect(slices).toBeGreaterThan(2);
          expect(longestSliceMs).toBeLessThan(workMs / 2);
        }
        console.log(`[CALC] ${code}/500: sync ${syncMs.toFixed(1)} ms, async work ${workMs.toFixed(1)} ms, ${slices} slices, max ${longestSliceMs.toFixed(1)} ms`);
        const k = polyhedraKernel({ code, P });
        const state = k.fromConfig(c)!;
        expect(state).not.toBeNull();
        expect(k.validate(k.toConfig(state)).valid).toBe(true);
        const energyAt = performance.now();
        expect(k.energy(state)).toBeLessThan(1e-16);
        console.log(`[CALC] ${code}/500: lattice ${startMs.toFixed(1)} ms, kernel energy ${(performance.now() - energyAt).toFixed(1)} ms`);
        const overlap = { ...c, pieces: c.pieces.map((p) => [...p] as typeof p) };
        overlap.pieces[1] = [...overlap.pieces[0]];
        expect((await validatePolyhedraAsync(problem, overlap)).valid).toBe(false);
        expect((await validatePolyhedraAsync(problem, { ...c, s: c.s / 2 })).valid).toBe(false);
      }
    }
  }, 60000);

  it("refuses construction and kernel work above the cap", () => {
    expect(POLYHEDRA_MAX_P).toBe(500);
    expect(() => latticeStart(getProblem("cubincub")!, 501)).toThrow(/500/);
    expect(() => polyhedraKernel({ code: "cubincub", P: 501 })).toThrow(/500/);
  });
});
