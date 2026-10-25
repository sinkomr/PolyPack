import { describe, expect, it } from "vitest";
import type { Polytope, PolytopeName } from "../src/index";
import { bfsNet, buildPolytope, defaultNet, getPolytope, isoApply, isoCompose, isoFromAffine, toAmbient } from "../src/index";
import { cell16Vertices, cell24Vertices, simplexVertices } from "./helpers";

const T = getPolytope("tesseract");
const DEG = 180 / Math.PI;

/** Checks every gluing of a polytope: isometry, ridge fixed pointwise, inverse pairs, neighbour beyond the ridge, agreement with R^4. */
function checkGluings(P: Polytope, s: number): void {
  for (const c of P.cells)
    c.facets.forEach((f, fi) => {
      const A = f.toNeighbor.A;
      // orthogonal
      for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++) expect(A[0][i] * A[0][j] + A[1][i] * A[1][j] + A[2][i] * A[2][j]).toBeCloseTo(i === j ? 1 : 0, 12);
      const g = isoFromAffine(f.toNeighbor, s);
      const nb = P.cells[f.neighbor];
      const back = nb.facets[f.neighborFacet];
      expect(back.neighbor).toBe(c.index);
      expect(back.neighborFacet).toBe(fi);
      // inverse pair
      const id = isoCompose(isoFromAffine(back.toNeighbor, s), g);
      for (let k = 0; k < 9; k++) expect(id.m[k]).toBeCloseTo([1, 0, 0, 0, 1, 0, 0, 0, 1][k], 12);
      for (let k = 0; k < 3; k++) expect(id.t[k]).toBeCloseTo(0, 12);
      // the ridge is fixed pointwise: each ridge vertex goes to the same polytope vertex in the neighbour
      for (const vi of f.vertices) {
        const y = c.vertices[vi].map((x) => x * s);
        const y2 = isoApply(g, y);
        const gid = c.vertexIds[vi];
        const vj = nb.vertexIds.indexOf(gid);
        expect(vj).toBeGreaterThanOrEqual(0);
        for (let k = 0; k < 3; k++) expect(y2[k]).toBeCloseTo(nb.vertices[vj][k] * s, 12);
        const x1 = toAmbient(P, c.index, y, s);
        const x2 = toAmbient(P, nb.index, y2, s);
        for (let k = 0; k < 4; k++) expect(x2[k]).toBeCloseTo(x1[k], 12);
      }
      // the neighbour, unfolded into this cell's frame, lies beyond this facet
      const inv = isoFromAffine(back.toNeighbor, s);
      for (const v of nb.vertices) {
        const y = isoApply(inv, v.map((x) => x * s));
        const n = f.inside.n;
        expect(n[0] * y[0] + n[1] * y[1] + n[2] * y[2]).toBeGreaterThanOrEqual(s * f.inside.h - 1e-12);
      }
      // a point beyond the ridge goes where the R^4 rotation about the ridge takes it
      const centre = f.vertices.reduce((a, vi) => a.map((x, k) => x + (c.vertices[vi][k] * s) / f.vertices.length), [0, 0, 0]);
      const beyond = centre.map((x, k) => x + 0.3 * s * f.inside.n[k]);
      const x = toAmbient(P, c.index, beyond, s);
      const xr = toAmbient(P, nb.index, isoApply(g, beyond), s);
      const q = toAmbient(P, c.index, centre, s);
      // the gluing keeps the distance to the ridge and lands in the neighbour's hyperplane, on the neighbour's side
      const nc = c.normal;
      const nn = nb.normal;
      const d1 = x.reduce((a, xi, i) => a + (xi - q[i]) ** 2, 0);
      const d2 = xr.reduce((a, xi, i) => a + (xi - q[i]) ** 2, 0);
      expect(d2).toBeCloseTo(d1, 12);
      // xr lies in the neighbour's hyperplane and on the neighbour's side of the ridge
      expect(nn.reduce((a, ni, i) => a + ni * (xr[i] - q[i]), 0)).toBeCloseTo(0, 12);
      expect(nc.reduce((a, ni, i) => a + ni * (xr[i] - q[i]), 0)).toBeLessThan(0);
    });
}

describe("tesseract", () => {
  it("has 8 cubic cells, 24 ridges, 32 edges, and cone angle 3 pi/2 at every edge", () => {
    expect(T.d).toBe(4);
    expect(T.vertices.length).toBe(16);
    expect(T.cells.length).toBe(8);
    expect(T.cells.reduce((a, c) => a + c.facets.length, 0) / 2).toBe(24);
    expect(T.edges.length).toBe(32);
    for (const c of T.cells) {
      expect(c.vertices.length).toBe(8);
      expect(c.hinges.length).toBe(12);
      expect(c.facets.length).toBe(6);
    }
    expect(T.hingeAngle).toBeCloseTo((3 * Math.PI) / 2, 14);
    for (const a of T.edgeAngles) expect(a).toBeCloseTo((3 * Math.PI) / 2, 14);
  });

  it("follows tess.py: cell id 2 i + (sigma > 0), local axes the other coordinates in increasing order", () => {
    for (let id = 0; id < 8; id++) {
      const c = T.cells[id];
      const i = id >> 1;
      const sg = id & 1 ? 1 : -1;
      expect(c.normal).toEqual([0, 1, 2, 3].map((k) => (k === i ? sg : 0)));
      expect(c.origin).toEqual([0, 1, 2, 3].map((k) => (k === i ? sg / 2 : 0)));
      const axes = [0, 1, 2, 3].filter((k) => k !== i);
      expect(c.frame).toEqual(axes.map((a) => [0, 1, 2, 3].map((k) => (k === a ? 1 : 0))));
      // facet 2 k + (tau > 0) is the face u_k = tau / 2, glued to the cell x_axes[k] = tau / 2
      c.facets.forEach((f, fi) => {
        const k = fi >> 1;
        const tau = fi & 1 ? 1 : -1;
        expect(f.inside.n).toEqual([0, 1, 2].map((j) => (j === k ? tau : 0)));
        expect(f.inside.h).toBe(0.5);
        expect(f.neighbor).toBe(2 * axes[k] + (tau > 0 ? 1 : 0));
      });
    }
  });

  it("gluings are isometries fixing their ridge, in inverse pairs, agreeing with the rotation of R^4", () => {
    checkGluings(T, 1);
    checkGluings(T, 1.7);
    // exact: the tesseract's gluing matrices are signed permutations with integer translations
    for (const c of T.cells)
      for (const f of c.facets) {
        for (const row of f.toNeighbor.A) for (const x of row) expect([-1, 0, 1]).toContain(x);
        for (const x of f.toNeighbor.b) expect([-1, 0, 1]).toContain(x);
      }
  });

  it("the default net is the Dali cross: a column of four, four around the second from the top", () => {
    const net = defaultNet(T);
    expect(net.length).toBe(8);
    const centre = (p: (typeof net)[number]) => p.place.b.map((x) => Math.round(x * 1e9) / 1e9);
    const at = new Map(net.map((p) => [p.cell, centre(p)]));
    expect(at.get(0)).toEqual([0, 0, 0]);
    expect(at.get(7)).toEqual([0, 0, 1]);
    expect(at.get(6)).toEqual([0, 0, -1]);
    expect(at.get(1)).toEqual([0, 0, -2]);
    expect(new Set([2, 3, 4, 5].map((c) => JSON.stringify(at.get(c))))).toEqual(new Set(["[-1,0,0]", "[1,0,0]", "[0,-1,0]", "[0,1,0]"].map((x) => JSON.stringify(JSON.parse(x)))));
    // each placed cell is a unit cube, and glued facets coincide in the net
    for (const p of net) {
      const c = T.cells[p.cell];
      const g = isoFromAffine(p.place);
      for (const v of c.vertices) {
        const y = isoApply(g, v);
        for (let k = 0; k < 3; k++) expect(Math.abs(Math.abs(y[k] - at.get(p.cell)![k]) - 0.5)).toBeLessThan(1e-12);
      }
      if (!p.parent) continue;
      const facet = c.facets[p.parent.facet];
      expect(facet.neighbor).toBe(p.parent.cell);
      const par = net.find((x) => x.cell === p.parent!.cell)!;
      const gp = isoFromAffine(par.place);
      const pc = T.cells[par.cell];
      for (const vi of facet.vertices) {
        const y = isoApply(g, c.vertices[vi]);
        const vj = pc.vertexIds.indexOf(c.vertexIds[vi]);
        const z = isoApply(gp, pc.vertices[vj]);
        for (let k = 0; k < 3; k++) expect(y[k]).toBeCloseTo(z[k], 12);
      }
    }
    expect(net.filter((p) => p.parent === null).map((p) => p.cell)).toEqual([0]);
  });
});

describe("generic builder", () => {
  const cases: [string, number[][], number, number, number][] = [
    // name, vertices, cells, cells per edge, cone angle in degrees (research note sec. 2.1)
    ["5-cell", simplexVertices(), 5, 3, 211.59],
    ["16-cell", cell16Vertices(), 16, 4, 282.12],
    ["24-cell", cell24Vertices(), 24, 3, 328.41],
  ];
  for (const [name, V, C, perEdge, cone] of cases)
    it(`${name}: ${C} cells, ${perEdge} cells per edge, cone angle ${cone} degrees, gluings consistent`, () => {
      const P = buildPolytope(name as PolytopeName, V);
      expect(P.cells.length).toBe(C);
      for (const a of P.edgeAngles) expect(a * DEG).toBeCloseTo(cone, 1);
      const per = new Map<string, number>();
      for (const c of P.cells)
        for (const [a, b] of c.hinges) {
          const k = [c.vertexIds[a], c.vertexIds[b]].sort((x, y) => x - y).join(",");
          per.set(k, (per.get(k) ?? 0) + 1);
        }
      for (const n of per.values()) expect(n).toBe(perEdge);
      // unit edge
      for (const [a, b] of P.edges) expect(Math.hypot(...P.vertices[a].map((x, i) => x - P.vertices[b][i]))).toBeCloseTo(1, 12);
      // frames orthonormal and orthogonal to the normal; vertices on the hyperplane
      for (const c of P.cells) {
        for (const f of c.frame) {
          expect(f.reduce((a, x, i) => a + x * c.normal[i], 0)).toBeCloseTo(0, 12);
          expect(Math.hypot(...f)).toBeCloseTo(1, 12);
        }
        c.vertexIds.forEach((id, j) => {
          const x = toAmbient(P, c.index, c.vertices[j], 1);
          for (let k = 0; k < 4; k++) expect(x[k]).toBeCloseTo(P.vertices[id][k], 12);
        });
      }
      checkGluings(P, 1);
      expect(bfsNet(P).length).toBe(C);
    });

  it("is deterministic: rebuilding gives the same cells, frames and gluings", () => {
    const a = buildPolytope("tesseract", T.vertices);
    expect(JSON.stringify(a)).toBe(JSON.stringify(T));
  });
});
