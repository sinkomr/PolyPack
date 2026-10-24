import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SOLID_NAMES, apply, compose, faceTo3D, frameVertex, getSolid, glue, inverse, surfaceArea } from "../src/index";

const expected = {
  tetrahedron: { F: 4, V: 4, E: 6, M: 3, degree: 3, cone: 1 },
  cube: { F: 6, V: 8, E: 12, M: 4, degree: 3, cone: 1.5 },
  octahedron: { F: 8, V: 6, E: 12, M: 3, degree: 4, cone: 4 / 3 },
  dodecahedron: { F: 12, V: 20, E: 30, M: 5, degree: 3, cone: 1.8 },
  icosahedron: { F: 20, V: 12, E: 30, M: 3, degree: 5, cone: 5 / 3 },
} as const;

describe("solids", () => {
  for (const name of SOLID_NAMES) {
    const S = getSolid(name);
    it(`${name}: counts and cone angle`, () => {
      const e = expected[name];
      expect([S.F, S.V, S.E, S.M, S.degree]).toEqual([e.F, e.V, e.E, e.M, e.degree]);
      expect(S.coneAngle / Math.PI).toBeCloseTo(e.cone, 12);
      expect(S.V - S.E + S.F).toBe(2);
    });

    it(`${name}: faces are unit regular polygons, counter-clockwise from outside`, () => {
      for (const f of S.faces) {
        const P = f.map((v) => S.vertices[v]);
        for (let k = 0; k < S.M; k++) {
          const a = P[k];
          const b = P[(k + 1) % S.M];
          expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeCloseTo(1, 12);
        }
        const c = [0, 1, 2].map((t) => P.reduce((u, p) => u + p[t] / S.M, 0));
        const u = [0, 1, 2].map((t) => P[1][t] - P[0][t]);
        const w = [0, 1, 2].map((t) => P[2][t] - P[0][t]);
        const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        expect(n[0] * c[0] + n[1] * c[1] + n[2] * c[2]).toBeGreaterThan(0);
        expect(f[0]).toBe(Math.min(...f));
      }
    });

    it(`${name}: gluing is an involution that matches edges`, () => {
      const s = 1.37;
      for (let f = 0; f < S.F; f++)
        for (let k = 0; k < S.M; k++) {
          const g = glue(S, s, f, k);
          expect(S.adj[g.face][g.edge]).toEqual({ face: f, edge: k });
          const a = apply(g.T, ...frameVertex(S.M, s, g.edge));
          const b = frameVertex(S.M, s, k + 1);
          expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(1e-12);
          const back = glue(S, s, g.face, g.edge);
          const id = compose(g.T, back.T);
          expect(Math.abs(id.c - 1) + Math.abs(id.s) + Math.abs(id.tx) + Math.abs(id.ty)).toBeLessThan(1e-12);
          // the 3D embedding agrees with the gluing along the shared edge
          for (const t of [0.25, 0.5, 0.8]) {
            const [px, py] = frameVertex(S.M, s, g.edge);
            const [qx, qy] = frameVertex(S.M, s, g.edge + 1);
            const x = px + t * (qx - px);
            const y = py + t * (qy - py);
            const p3 = faceTo3D(S, s, g.face, x, y);
            const [u, v] = apply(g.T, x, y);
            const q3 = faceTo3D(S, s, f, u, v);
            expect(Math.hypot(p3[0] - q3[0], p3[1] - q3[1], p3[2] - q3[2])).toBeLessThan(1e-12);
          }
        }
    });

    it(`${name}: going once around a vertex rotates by the cone angle`, () => {
      // unfold the faces around frame vertex 0 of face 0, crossing edge M-1 then the matching edges
      const s = 1;
      let f = 0;
      let k = S.M - 1; // edge M-1 ends at frame vertex 0
      let T = { ang: 0, c: 1, s: 0, tx: 0, ty: 0 };
      for (let step = 0; step < S.degree; step++) {
        const g = glue(S, s, f, k);
        T = compose(T, g.T);
        f = g.face;
        // in the new face the vertex is the start of the entry edge; the next edge around it is the one before
        k = (g.edge + S.M - 1) % S.M;
      }
      expect(f).toBe(0);
      const turn = (((T.ang % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI));
      const v0 = frameVertex(S.M, s, 0);
      const img = apply(T, v0[0], v0[1]);
      expect(Math.hypot(img[0] - v0[0], img[1] - v0[1])).toBeLessThan(1e-12);
      // total rotation = cone angle (mod 2 pi), measured clockwise or counter-clockwise
      const cone = S.coneAngle % (2 * Math.PI);
      const ok = Math.min(Math.abs(turn - cone), Math.abs(turn - (2 * Math.PI - cone)));
      expect(ok).toBeLessThan(1e-12);
      const back = inverse(T);
      expect(Math.abs(compose(T, back).ang)).toBeLessThan(1e-12);
    });
  }

  it("surface areas", () => {
    expect(surfaceArea(getSolid("cube"), 2)).toBeCloseTo(24, 12);
    expect(surfaceArea(getSolid("tetrahedron"), 1)).toBeCloseTo(Math.sqrt(3), 12);
    expect(surfaceArea(getSolid("icosahedron"), 1)).toBeCloseTo(5 * Math.sqrt(3), 12);
  });

  it("matches the committed solids.json used by the Python certifier", () => {
    const data = JSON.parse(readFileSync(new URL("../../../data/surface/solids.json", import.meta.url), "utf8"));
    for (const name of SOLID_NAMES) {
      const S = getSolid(name);
      expect(data.solids[name].faces).toEqual(S.faces);
      expect(data.solids[name].adj).toEqual(S.adj.map((r) => r.map((e) => [e.face, e.edge])));
    }
  });
});
