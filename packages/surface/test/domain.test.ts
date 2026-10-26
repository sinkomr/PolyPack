import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALL_SOLID_NAMES, CATALAN_NAMES, SURFACE_NS, surfaceBound, surfaceDomain } from "../src/index";

const records = JSON.parse(readFileSync(new URL("../../../data/surface/records.json", import.meta.url), "utf8")).records;

describe("the surface domain", () => {
  it("holds every solid, both modes, N = 0 and 3 to 100, P = 1 to 100", () => {
    expect(SURFACE_NS.length).toBe(99);
    expect(surfaceDomain.info.problems).toBe(36 * 2 * 99 * 100);
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

  it("gives the Platonic records' own bounds", () => {
    for (const r of records) {
      const b = surfaceBound(r.solid, r.N, r.P);
      expect(Math.abs(b.value / r.bound.value - 1), r.id).toBeLessThan(1e-12);
    }
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
