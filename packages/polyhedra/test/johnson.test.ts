import { describe, expect, it } from "vitest";
import { JOHNSON_SOLID_NAMES, SOLID_NAMES, getSolid, solidNameOfCode } from "../src";
import { JOHNSON_SOLIDS, SOLID_NAMES_LIST } from "../src/catalogue";

/** V, E, F of J1 to J92 (Johnson 1966; python/polyhedra/johnson_table.py). */
const VEF: [number, number, number][] = [
  [5, 8, 5],
  [6, 10, 6],
  [9, 15, 8],
  [12, 20, 10],
  [15, 25, 12],
  [20, 35, 17],
  [7, 12, 7],
  [9, 16, 9],
  [11, 20, 11],
  [9, 20, 13],
  [11, 25, 16],
  [5, 9, 6],
  [7, 15, 10],
  [8, 15, 9],
  [10, 20, 12],
  [12, 25, 15],
  [10, 24, 16],
  [15, 27, 14],
  [20, 36, 18],
  [25, 45, 22],
  [30, 55, 27],
  [15, 33, 20],
  [20, 44, 26],
  [25, 55, 32],
  [30, 65, 37],
  [8, 14, 8],
  [12, 24, 14],
  [16, 32, 18],
  [16, 32, 18],
  [20, 40, 22],
  [20, 40, 22],
  [25, 50, 27],
  [25, 50, 27],
  [30, 60, 32],
  [18, 36, 20],
  [18, 36, 20],
  [24, 48, 26],
  [30, 60, 32],
  [30, 60, 32],
  [35, 70, 37],
  [35, 70, 37],
  [40, 80, 42],
  [40, 80, 42],
  [18, 42, 26],
  [24, 56, 34],
  [30, 70, 42],
  [35, 80, 47],
  [40, 90, 52],
  [7, 13, 8],
  [8, 17, 11],
  [9, 21, 14],
  [11, 19, 10],
  [12, 23, 13],
  [13, 22, 11],
  [14, 26, 14],
  [14, 26, 14],
  [15, 30, 17],
  [21, 35, 16],
  [22, 40, 20],
  [22, 40, 20],
  [23, 45, 24],
  [10, 20, 12],
  [9, 15, 8],
  [10, 18, 10],
  [15, 27, 14],
  [28, 48, 22],
  [32, 60, 30],
  [65, 105, 42],
  [70, 120, 52],
  [70, 120, 52],
  [75, 135, 62],
  [60, 120, 62],
  [60, 120, 62],
  [60, 120, 62],
  [60, 120, 62],
  [55, 105, 52],
  [55, 105, 52],
  [55, 105, 52],
  [55, 105, 52],
  [50, 90, 42],
  [50, 90, 42],
  [50, 90, 42],
  [45, 75, 32],
  [8, 18, 12],
  [16, 40, 26],
  [10, 22, 14],
  [11, 26, 17],
  [12, 28, 18],
  [14, 33, 21],
  [16, 38, 24],
  [14, 26, 14],
  [18, 36, 20],
];

describe("Johnson solids", () => {
  it("are 92 in the data, named j01 to j92, and the last 92 of the 186 solids of the problems", () => {
    expect(JOHNSON_SOLID_NAMES).toHaveLength(92);
    expect(JOHNSON_SOLIDS).toHaveLength(92);
    expect(JOHNSON_SOLIDS.map((s) => s.name)).toEqual([...JOHNSON_SOLID_NAMES]);
    expect(SOLID_NAMES).toHaveLength(186);
    expect(SOLID_NAMES_LIST).toHaveLength(186);
    expect(SOLID_NAMES.slice(94)).toEqual([...JOHNSON_SOLID_NAMES]);
    expect(SOLID_NAMES_LIST.slice(94)).toEqual([...JOHNSON_SOLIDS]);
    JOHNSON_SOLIDS.forEach((s, i) => {
      expect(s.code).toBe(`j${String(i + 1).padStart(2, "0")}`);
      expect(s.code).not.toContain("in");
      expect(s.family).toBe("johnson");
      expect(s.title).toBe(`J${i + 1} ${s.name.replace(/_/g, " ")}`);
      expect(solidNameOfCode(s.code)).toBe(s.name);
      expect(getSolid(s.name).title).toBe(s.title);
      expect(getSolid(s.name).code).toBe(s.code);
      expect(getSolid(s.name).family).toBe("johnson");
    });
    expect(JOHNSON_SOLIDS[11].title).toBe("J12 triangular bipyramid");
    expect(JOHNSON_SOLIDS[91].title).toBe("J92 triangular hebesphenorotunda");
  });

  it("have unit edges, regular convex faces and the centroid at the origin", () => {
    JOHNSON_SOLID_NAMES.forEach((name, i) => {
      const S = getSolid(name);
      expect([S.nv, S.edges.length, S.faces.length], name).toEqual(VEF[i]);
      expect(S.volume, name).toBeGreaterThan(0);
      // unit edges, in floating point
      for (const [a, b] of S.edges) {
        const l = Math.hypot(S.V[3 * a] - S.V[3 * b], S.V[3 * a + 1] - S.V[3 * b + 1], S.V[3 * a + 2] - S.V[3 * b + 2]);
        expect(Math.abs(l - 1), `${name} edge`).toBeLessThan(1e-13);
      }
      // the centroid of the vertices is the origin
      for (let k = 0; k < 3; k++) {
        let c = 0;
        for (let v = 0; v < S.nv; v++) c += S.V[3 * v + k];
        expect(Math.abs(c / S.nv), `${name} centroid`).toBeLessThan(1e-14);
      }
      // strictly convex: every vertex off a face lies strictly inside its plane; the origin is inside
      for (let f = 0; f < S.faces.length; f++) {
        expect(S.offsets[f], `${name} face ${f}`).toBeGreaterThan(0);
        for (let v = 0; v < S.nv; v++) {
          const d =
            S.N[3 * f] * S.V[3 * v] + S.N[3 * f + 1] * S.V[3 * v + 1] + S.N[3 * f + 2] * S.V[3 * v + 2] - S.offsets[f];
          if (S.faces[f].includes(v)) expect(Math.abs(d), `${name} face ${f}`).toBeLessThan(1e-13);
          else expect(d, `${name} face ${f}`).toBeLessThan(-1e-3);
        }
        // regular: equal sides (above) and one distance from the face centre
        const q = S.faces[f];
        const cen = [0, 1, 2].map((k) => q.reduce((s, v) => s + S.V[3 * v + k], 0) / q.length);
        const r = q.map((v) => Math.hypot(S.V[3 * v] - cen[0], S.V[3 * v + 1] - cen[1], S.V[3 * v + 2] - cen[2]));
        expect(Math.max(...r) - Math.min(...r), `${name} face ${f} circle`).toBeLessThan(1e-13);
        expect(r[0], `${name} face ${f} radius`).toBeCloseTo(1 / (2 * Math.sin(Math.PI / q.length)), 12);
      }
      expect(S.edgeMax, name).toBeCloseTo(1, 12);
    });
  });

  it("have the volumes of the literature for a few solids", () => {
    // volumes at unit edge from the literature (MathWorld, Wikipedia): J1 and J12 sqrt(2)/6 (a bipyramid is two tetrahedra),
    // J6 (45 + 17 sqrt 5)/12, J84 0.85949, J91 (17 + 9 sqrt 5)/12, J92 (15 + 7 sqrt 5)/6
    expect(getSolid("square_pyramid").volume).toBeCloseTo(Math.SQRT2 / 6, 13);
    expect(getSolid("triangular_bipyramid").volume).toBeCloseTo(Math.SQRT2 / 6, 13);
    expect(getSolid("pentagonal_rotunda").volume).toBeCloseTo((45 + 17 * Math.sqrt(5)) / 12, 12);
    expect(getSolid("snub_disphenoid").volume).toBeCloseTo(0.8594936461913, 11);
    expect(getSolid("bilunabirotunda").volume).toBeCloseTo((17 + 9 * Math.sqrt(5)) / 12, 12);
    expect(getSolid("triangular_hebesphenorotunda").volume).toBeCloseTo((15 + 7 * Math.sqrt(5)) / 6, 12);
  });
});
