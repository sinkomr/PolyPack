import { describe, expect, it } from "vitest";
import { ALL_SOLID_NAMES, ARCHIMEDEAN_NAMES, CATALAN_NAMES, SURFACE_NS, getSolid, surfaceBound, surfaceBounds, surfaceDomain } from "../src/index";
import { independentBounds, loadSurfaceRecords } from "./helpers";

const records = loadSurfaceRecords();

describe("the surface domain", () => {
  it("holds every solid, both modes, N = 0 and 3 to 100, P = 1 to 100", () => {
    expect(SURFACE_NS.length).toBe(99);
    expect(surfaceDomain.info.problems).toBe(49 * 2 * 99 * 100);
    for (const n of ARCHIMEDEAN_NAMES) {
      expect(surfaceDomain.info.fields[0].groups![n]).toBe("Archimedean");
      expect(surfaceDomain.info.fields[0].titles![n]).toBeTruthy();
    }
    const at = (fields: Record<string, string | number>, P: number) => surfaceDomain.bound({ fields: { ...fields, P }, P });
    expect(at({ solid: "prism5", mode: "fold", N: 100 }, 100)).toMatchObject({ label: "area bound; [CALC]" });
    expect(at({ solid: "rhombic_dodecahedron", mode: "nofold", N: 0 }, 1)).toMatchObject({ label: "one piece bound; [CALC]" });
    for (const bad of [
      [{ solid: "prism4", mode: "fold", N: 0 }, 1],
      [{ solid: "cube", mode: "fold", N: 2 }, 1],
      [{ solid: "cube", mode: "fold", N: 101 }, 1],
      [{ solid: "cube", mode: "flat", N: 0 }, 1],
      [{ solid: "cube", mode: "fold", N: 0 }, 101],
      [{ solid: "cube", mode: "fold", N: 0 }, 0],
    ] as const)
      expect(at(bad[0], bad[1])).toBeUndefined();
  });

  it("agrees with bounds computed independently from the solids' 3D coordinates, on every solid", () => {
    for (const name of ALL_SOLID_NAMES)
      for (const N of [0, 3, 4, 5, 6, 7, 8, 12, 50, 100])
        for (const P of [1, 5, 30, 100]) {
          const id = `${name} ${N} ${P}`;
          const { area, one } = surfaceBounds(name, N, P);
          const ind = independentBounds(getSolid(name), N, P);
          expect(Math.abs(area / ind.area - 1), id).toBeLessThan(1e-12);
          // sampling finds the corner radius or less, so its bound is the one-piece bound or more
          expect(one, id).toBeLessThanOrEqual(ind.oneAtMost * (1 + 1e-12));
          expect(one, id).toBeGreaterThan(ind.oneAtMost * 0.99);
          expect(surfaceBound(name, N, P).value, id).toBe(Math.max(area, one));
        }
  });

  it("gives the Platonic records' own bounds, to the last bit", () => {
    // the records' bounds come from python/surface/tables.py; the domain repeats its float operations
    for (const r of records) expect(surfaceBound(r.solid, r.N, r.P).value, r.id).toBe(r.bound.value);
  });

  it("samples problems without a record, small P first, deterministically", () => {
    const s = surfaceDomain.sample(500);
    expect(s.length).toBe(500);
    expect(s).toEqual(surfaceDomain.sample(500));
    expect(new Set(s).size).toBe(500);
    // folding problems without a record, from P = 2
    expect(s[0]).toBe(`surface/${ALL_SOLID_NAMES[5]}/fold/0/2`);
    const ids = new Set(records.map((r: { id: string }) => r.id));
    const catalan = new Set(CATALAN_NAMES as readonly string[]);
    expect(s.some((id) => ids.has(id) || id.endsWith("/1"))).toBe(false);
    // nofold only on the Catalan solids, whose faces no 2D in 2D problem covers
    expect(s.filter((id) => id.includes("/nofold/")).every((id) => catalan.has(id.split("/")[1]))).toBe(true);
    expect(s.some((id) => id.includes("/nofold/"))).toBe(true);
    for (const id of s) {
      const [, solid, mode, N, P] = id.split("/");
      expect(surfaceDomain.bound({ fields: { solid, mode, N: Number(N) }, P: Number(P) })).toBeDefined();
    }
  });
});
