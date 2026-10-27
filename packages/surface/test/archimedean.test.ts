/** Small constructed packings only: certified independently by python/surface/test_general.py. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type SolidName, type SurfacePose, getSolid, surfaceKernel, validate } from "../src/index";

interface Packing {
  id: string;
  solid: SolidName;
  mode: "fold" | "nofold";
  N: number;
  P: number;
  s: number;
  pieces: SurfacePose[];
}
const packings: Packing[] = JSON.parse(readFileSync(
  new URL("../../../python/surface/fixtures/archimedean_packings.json", import.meta.url), "utf8",
)).packings;

describe("constructed Archimedean test packings", () => {
  it("covers disks, triangles and 12-gons in both modes on two and three face kinds", () => {
    expect(packings.length).toBe(24);
    for (const solid of ["truncated_tetrahedron", "cuboctahedron", "snub_cube", "truncated_icosidodecahedron"])
      for (const N of [0, 3, 12])
        for (const mode of ["fold", "nofold"])
          expect(packings.some((p) => p.solid === solid && p.N === N && p.mode === mode)).toBe(true);
  });

  for (const p of packings) {
    it(`${p.id}: validator, kernel energy, gradient, conversion and finish agree`, () => {
      const S = getSolid(p.solid);
      const config = { s: p.s, pieces: p.pieces };
      expect(validate(p, p.mode, { tol: 0 }).ok).toBe(true);
      if (p.mode === "fold") expect(validate(p, "nofold").ok).toBe(false);
      else {
        expect(validate(p, "fold", { tol: 0 }).ok).toBe(true);
        expect(new Set(p.pieces.map((q) => S.sides[q.face]))).toEqual(new Set(S.sides));
        expect(new Set(p.pieces.map((q) => q.face)).size).toBeLessThan(p.P);
      }
      const k = surfaceKernel({ solid: p.solid, N: p.N, P: p.P, mode: p.mode });
      expect(k.validate(config)).toEqual({ valid: true, score: p.s, reasons: [] });
      const state = k.fromConfig(config)!;
      expect(state).not.toBeNull();
      const converted = k.toConfig(state) as typeof config;
      expect(converted.s).toBe(p.s);
      converted.pieces.forEach((q, i) => {
        expect(q.face).toBe(p.pieces[i].face);
        expect(q.x).toBeCloseTo(p.pieces[i].x, 12);
        expect(q.y).toBeCloseTo(p.pieces[i].y, 12);
        expect(q.theta).toBeCloseTo(p.N === 0 ? 0 : p.pieces[i].theta, 12);
      });
      const gradient = new Float64Array(p.P * k.dim + 1);
      expect(k.energy(state, gradient)).toBe(0);
      expect(gradient.every(Number.isFinite)).toBe(true);
      for (let i = 0; i < p.P; i++) {
        expect(k.clear(state, i, 0)).toBe(true);
        expect(k.pieceEnergy(state, i)).toBe(0);
      }
      const finished = k.finish(state)!;
      expect(finished).not.toBeNull();
      expect(finished.score).toBeLessThanOrEqual(p.s * (1 + 1e-9));
      expect(k.validate(finished.config).valid).toBe(true);
      // Duplicate a piece: pair terms must reject it in either mode.
      const overlap = { s: p.s, pieces: p.pieces.map((q, i) => i === 1 ? { ...p.pieces[0] } : q) };
      expect(k.validate(overlap).valid).toBe(false);
      expect(k.energy(k.fromConfig(overlap)!)).toBeGreaterThan(0);
    });
  }
});
