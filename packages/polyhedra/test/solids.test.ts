import { describe, expect, it } from "vitest";
import {
  POLYHEDRA_PROBLEMS,
  SOLID_NAMES,
  formatPolyhedraId,
  getProblem,
  getSolid,
  parsePolyhedraId,
  volumeBound,
  wikiUrl,
} from "../src";

describe("solids", () => {
  it("has upstream's 56 solids, each a closed convex polyhedron centred at the origin", () => {
    expect(SOLID_NAMES.length).toBe(56);
    for (const name of SOLID_NAMES) {
      const S = getSolid(name);
      expect(S.nv - S.edges.length + S.faces.length, name).toBe(2);
      for (let f = 0; f < S.faces.length; f++) {
        const n = [S.N[3 * f], S.N[3 * f + 1], S.N[3 * f + 2]];
        expect(Math.abs(Math.hypot(...n) - 1), name).toBeLessThan(1e-15);
        for (let v = 0; v < S.nv; v++) {
          const d = n[0] * S.V[3 * v] + n[1] * S.V[3 * v + 1] + n[2] * S.V[3 * v + 2] - S.offsets[f];
          if (S.faces[f].includes(v)) expect(Math.abs(d), `${name} face ${f}`).toBeLessThan(1e-14);
          else expect(d, `${name} face ${f}`).toBeLessThan(-1e-6);
        }
        // counter-clockwise seen from outside
        const [a, b, c] = S.faces[f].slice(0, 3).map((i) => [S.V[3 * i], S.V[3 * i + 1], S.V[3 * i + 2]]);
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const x = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        expect(x[0] * n[0] + x[1] * n[1] + x[2] * n[2]).toBeGreaterThan(0);
      }
      let cx = 0;
      for (let v = 0; v < 3 * S.nv; v++) cx += Math.abs(S.V[v]);
      expect(cx).toBeGreaterThan(0);
      expect(S.inradius).toBeCloseTo(Math.min(...S.offsets), 15);
    }
  });

  it("has unit edges where upstream says so", () => {
    for (const name of SOLID_NAMES) {
      const S = getSolid(name);
      if (S.family === "catalan" || S.family === "elongated_prism") continue;
      for (const [i, j] of S.edges) {
        const l = Math.hypot(S.V[3 * j] - S.V[3 * i], S.V[3 * j + 1] - S.V[3 * i + 1], S.V[3 * j + 2] - S.V[3 * i + 2]);
        expect(Math.abs(l - 1), name).toBeLessThan(1e-14);
      }
    }
    expect(getSolid("cube").volume).toBe(1);
    expect(getSolid("prism3_l3").edgeMax).toBeCloseTo(3, 14);
  });
});

describe("problems and ids", () => {
  it("lists upstream's 86 3D problems with unique codes", () => {
    expect(POLYHEDRA_PROBLEMS.length).toBe(86);
    expect(new Set(POLYHEDRA_PROBLEMS.map((p) => p.code)).size).toBe(86);
    expect(POLYHEDRA_PROBLEMS.slice(0, 5).map((p) => p.code)).toEqual(["tetintet", "octinoct", "icoinico", "dodindod", "cubincub"]);
    expect(getProblem("pr3l15incub")).toMatchObject({ piece: "prism3_l15", container: "cube", family: "prisms" });
    expect(getProblem("cubintet")!.title).toBe("Cubes in a tetrahedron");
    expect(getProblem("icoinoct")!.title).toBe("Icosahedra in an octahedron");
  });

  it("parses ids in their one written form only", () => {
    expect(parsePolyhedraId("polyhedra/cubintet/12")).toMatchObject({ code: "cubintet", P: 12 });
    expect(formatPolyhedraId("cubintet", 12)).toBe("polyhedra/cubintet/12");
    for (const bad of ["polyhedra/cubintet/012", "polyhedra/cubintet/+1", "polyhedra/cubintet/0", "polyhedra/blob/3", "surface/cube/fold/0/1", "polyhedra/cubintet", 12])
      expect(typeof parsePolyhedraId(bad)).toBe("string");
    expect(wikiUrl("cubincub", 5)).toBe("https://polyhedrainpolyhedra.wiki/#cubincub_n05");
  });

  it("computes the volume bound", () => {
    expect(volumeBound(getProblem("cubincub")!, 8)).toBe(2);
    expect(volumeBound(getProblem("tetintet")!, 8)).toBeCloseTo(2, 14);
  });
});
