/**
 * GJK / EPA against closed forms in 4 to 10 dimensions and against the 3D separating-axis test of the polyhedra space,
 * which decides the same quantity exactly for convex polyhedra.
 */
import { describe, expect, it } from "vitest";
import { closestPoints, gapAlong, getPolytope, penetrationDepth, signedSeparation } from "../src";
import { getSolid } from "../../polyhedra/src/solids";
import { place, separation } from "../../polyhedra/src/geom";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The cube [-1/2, 1/2]^d translated by c. */
function cubeAt(d: number, c: number[]): Float64Array {
  const P = getPolytope(`${d}:cube`);
  const X = Float64Array.from(P.V);
  for (let v = 0; v < P.nV; v++) for (let i = 0; i < d; i++) X[v * d + i] += c[i];
  return X;
}

describe("axis-aligned unit cubes (closed forms)", () => {
  for (const d of [4, 5, 7, 10]) {
    it(`${d}D: the distance of disjoint cubes is Euclidean and the depth of overlapping ones is 1 - max |offset|`, () => {
      const rng = mulberry32(d);
      const n = 2 ** d;
      const A = cubeAt(d, new Array(d).fill(0));
      for (let t = 0; t < 12; t++) {
        const c = Array.from({ length: d }, () => (rng() - 0.5) * 2.6);
        const B = cubeAt(d, c);
        const r = signedSeparation(A, n, B, n, d);
        const m = Math.max(...c.map(Math.abs));
        if (m > 1) {
          const dist = Math.hypot(...c.map((v) => Math.max(0, Math.abs(v) - 1)));
          expect(r.sep).toBeCloseTo(dist, 11);
          expect(r.dir).not.toBeNull();
        } else {
          expect(r.sep).toBeCloseTo(-(1 - m), 9);
          expect(r.converged).toBe(true);
        }
      }
    });
  }
  it("resolves overlaps of 1e-9 and touching to well below the tolerance", () => {
    const d = 6;
    const n = 64;
    const A = cubeAt(d, new Array(d).fill(0));
    const at = (x: number) => cubeAt(d, [x, 0.1, -0.2, 0, 0, 0.3]);
    expect(signedSeparation(A, n, at(1 - 1e-9), n, d).sep).toBeCloseTo(-1e-9, 12);
    expect(signedSeparation(A, n, at(1), n, d).sep).toBeGreaterThan(-1e-13);
    expect(signedSeparation(A, n, at(1 + 1e-9), n, d).sep).toBeCloseTo(1e-9, 12);
    expect(signedSeparation(A, n, at(1 + 1e-9), n, d).sep).toBeGreaterThan(0);
  });
  it("finds the depth of identical coincident polytopes (every facet at the same offset)", () => {
    const P = getPolytope("5:ortho");
    expect(signedSeparation(P.V, P.nV, P.V, P.nV, 5).sep).toBeCloseTo(-2 * P.inradius, 9);
    const Q = getPolytope("4:24cell");
    expect(signedSeparation(Q.V, Q.nV, Q.V, Q.nV, 4).sep).toBeCloseTo(-2 * Q.inradius, 9);
  });
});

describe("closed forms for other polytopes", () => {
  it("two aligned 24-cells face to face: the separation is the shift minus 2 * inradius", () => {
    const P = getPolytope("4:24cell");
    const n = Array.from(P.N.slice(0, 4));
    for (const delta of [-0.3, -1e-9, 0, 1e-9, 0.4]) {
      const sh = 2 * P.b[0] + delta;
      const B = Float64Array.from(P.V);
      for (let v = 0; v < P.nV; v++) for (let i = 0; i < 4; i++) B[v * 4 + i] += sh * n[i];
      const r = signedSeparation(P.V, P.nV, B, P.nV, 4);
      expect(r.sep).toBeCloseTo(delta, delta === 0 ? 11 : 9);
    }
  });
  it("gapAlong is a lower bound of the separation", () => {
    const rng = mulberry32(5);
    const P = getPolytope("5:demi");
    for (let t = 0; t < 20; t++) {
      const sh = Array.from({ length: 5 }, () => (rng() - 0.5) * 3);
      const B = Float64Array.from(P.V);
      for (let v = 0; v < P.nV; v++) for (let i = 0; i < 5; i++) B[v * 5 + i] += sh[i];
      const u = Array.from({ length: 5 }, () => rng() - 0.5);
      const l = Math.hypot(...u);
      const sep = signedSeparation(P.V, P.nV, B, P.nV, 5).sep;
      expect(
        gapAlong(
          P.V,
          P.nV,
          B,
          P.nV,
          5,
          u.map((v) => v / l),
        ),
      ).toBeLessThanOrEqual(sep + 1e-9);
    }
  });
  it("closestPoints returns the distance of a point from a polytope", () => {
    const P = getPolytope("7:simplex");
    const far = new Float64Array(7);
    far[0] = 5;
    const r = closestPoints(P.V, P.nV, far, 1, 7);
    // the distance is at least 5 - circumradius and at most 5 + circumradius
    expect(r.dist).toBeGreaterThan(5 - P.circumradius);
    expect(r.dist).toBeLessThan(5 + P.circumradius);
    // a point inside gives a touch
    const inside = closestPoints(P.V, P.nV, new Float64Array(7), 1, 7);
    expect(inside.w).toBeNull();
    const pen = penetrationDepth(P.V, P.nV, new Float64Array(7), 1, 7, inside.corral);
    expect(pen.depth).toBeCloseTo(P.inradius, 9);
  });
});

describe("against the 3D separating-axis test of the polyhedra space", () => {
  const names = [
    "tetrahedron",
    "cube",
    "octahedron",
    "dodecahedron",
    "icosahedron",
    "truncated_icosahedron",
    "prism3",
    "antiprism5",
  ];
  it("agrees on the penetration depth of random overlapping pairs and bounds the SAT value for disjoint ones", () => {
    const rng = mulberry32(42);
    let disjoint = 0;
    let overlapping = 0;
    for (let t = 0; t < 160; t++) {
      const a = getSolid(names[t % names.length]);
      const b = getSolid(names[(t * 5 + 3) % names.length]);
      const pa = [0, 0, 0, rng() - 0.5, rng() - 0.5, rng() - 0.5, rng() - 0.5];
      const spread = 0.8 + rng() * 2.2;
      const pb = [
        (rng() - 0.5) * spread,
        (rng() - 0.5) * spread,
        (rng() - 0.5) * spread,
        rng() - 0.5,
        rng() - 0.5,
        rng() - 0.5,
        rng() - 0.5,
      ];
      const A = place(a, pa);
      const B = place(b, pb);
      const exact = separation(A, B).sep;
      const r = signedSeparation(A.X, a.nv, B.X, b.nv, 3);
      if (exact > 1e-6) disjoint++;
      if (exact < -1e-6) overlapping++;
      // overlapping: the SAT value is the exact penetration depth; disjoint: it is only a lower bound of the distance
      // (vertex-vertex and vertex-edge contacts have no SAT axis), the Euclidean distance is at least as large
      const ok = exact < 0 ? Math.abs(r.sep - exact) < 2e-9 * Math.max(1, -exact) : r.sep >= exact - 1e-9 && r.sep >= 0;
      if (!ok)
        throw new Error(`${a.name} ${b.name} pair ${t}: SAT ${exact}, GJK/EPA ${r.sep} (converged ${r.converged})`);
    }
    expect(disjoint).toBeGreaterThan(20);
    expect(overlapping).toBeGreaterThan(20);
  });
});

describe("EPA in 4 to 8 dimensions: the depth and direction are a facet of the Minkowski difference", () => {
  // Moving B by (depth + e) along the direction separates the pieces, moving it by (depth - e) does not: so the depth is
  // the exact penetration depth to within e, independently of how EPA found it.
  const rot = (d: number, rng: () => number) => Array.from({ length: (d * (d - 1)) / 2 }, () => (rng() - 0.5) * 1.6);
  for (const [code, d] of [
    ["4:simplex", 4],
    ["4:24cell", 4],
    ["5:cube", 5],
    ["5:ortho", 5],
    ["6:demi", 6],
    ["6:221", 6],
    ["7:simplex", 7],
    ["8:ortho", 8],
  ] as const) {
    it(`${code}`, async () => {
      const { cayleyMatrix, placeVertices } = await import("../src");
      const P = getPolytope(code);
      const rng = mulberry32(d * 7 + code.length);
      let deep = 0;
      for (let t = 0; t < 12; t++) {
        const R1 = cayleyMatrix(rot(d, rng), d);
        const R2 = cayleyMatrix(rot(d, rng), d);
        const t2 = Float64Array.from({ length: d }, () => (rng() - 0.5) * P.circumradius * 1.1);
        const A = placeVertices(P.V, P.nV, d, new Float64Array(d), R1);
        const B = placeVertices(P.V, P.nV, d, t2, R2);
        const r = signedSeparation(A, P.nV, B, P.nV, d);
        if (r.sep > -1e-3) continue;
        deep++;
        expect(r.converged).toBe(true);
        const depth = -r.sep;
        const shifted = (amount: number) => {
          const S = Float64Array.from(B);
          for (let v = 0; v < P.nV; v++)
            for (let i = 0; i < d; i++) S[v * d + i] += amount * (r.dir as Float64Array)[i];
          return signedSeparation(A, P.nV, S, P.nV, d).sep;
        };
        expect(shifted(depth + 1e-6)).toBeGreaterThan(-1e-12); // separated (or touching to rounding)
        expect(shifted(depth - 1e-6)).toBeLessThan(-1e-7 + 1e-9); // still overlapping by about 1e-6
      }
      expect(deep).toBeGreaterThan(3);
    });
  }
});
