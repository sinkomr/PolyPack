import { describe, expect, it } from "vitest";
import type { PolytopeName } from "../src/index";
import {
  ChainLimitError,
  TesseractWords,
  buildPolytope,
  enumerateChains,
  geodesicDistance,
  geodesicLoop,
  getPolytope,
  hingeClearance,
  isoApply,
  tesseractClearance,
  traceGeodesic,
} from "../src/index";
import { cell24Vertices, randomCellPoint, randomDirection, rng, simplexVertices, trace4d } from "./helpers";

const T = getPolytope("tesseract");
const W = new TesseractWords(2);

describe("generic chains against the tesseract's lattice words (as test_tess.py)", () => {
  it("has tess.py's 1957 words per start cell", () => {
    expect(W.count).toBe(8 * 1957);
  });

  // words with |m_k| <= 2 cover every path shorter than 2 when s >= 1
  for (const s of [1, 1.42, 1.6, 2.2, 3.1])
    it(`s = ${s}: distances, loops and clearances agree on random points`, () => {
      const rand = rng(Math.round(s * 1000));
      let compared = 0;
      for (let trial = 0; trial < 120; trial++) {
        const c1 = Math.floor(rand() * 8);
        const u1 = randomCellPoint(s, rand);
        // half the second points uniform, half at the end of a random geodesic of length < 2 from the first
        let c2 = Math.floor(rand() * 8);
        let u2 = randomCellPoint(s, rand);
        if (trial % 2) {
          const w = traceGeodesic(T, s, c1, u1, randomDirection(rand), 2 * rand());
          if (!w.hitHinge) [c2, u2] = [w.cell, w.u];
        }
        const dw = W.distance(c1, u1, c2, u2, s);
        const dg = geodesicDistance(T, s, { cell: c1, u: u1 }, { cell: c2, u: u2 }, 2);
        if (dw < 2 || dg < 2) {
          compared++;
          expect(Math.abs(Math.min(dw, 9) - Math.min(dg, 9))).toBeLessThan(1e-12);
        }
        const lw = W.loop(c1, u1, s);
        const lg = geodesicLoop(T, s, { cell: c1, u: u1 }, 2);
        expect(Math.min(lw, 2)).toBeCloseTo(Math.min(lg, 2), 12);
        expect(hingeClearance(T, s, { cell: c1, u: u1 }, s)).toBeCloseTo(tesseractClearance(u1, s), 12);
      }
      expect(compared).toBeGreaterThan(20);
    });
});

describe("chains against an independent ray tracer in R^4", () => {
  // every ray followed in R^4 must follow an enumerated chain, and that chain's development must
  // put the ray's end point where the straight segment ends
  const cases: [number, string][] = [
    [0.6, "random"],
    [1, "random"],
    [1, "near a ridge"],
    [1, "within 1e-14 of a ridge"],
    [1, "on a ridge"],
    [1.5, "near a hinge"],
    [1.5, "near a vertex"],
    [2.5, "random"],
  ];
  for (const [s, where] of cases)
    it(`s = ${s}, centre ${where}`, () => {
      const rand = rng(Math.round(s * 77) + where.length);
      const h = s / 2;
      for (let trial = 0; trial < 6; trial++) {
        const cell = Math.floor(rand() * 8);
        let u = randomCellPoint(s, rand);
        if (where === "near a ridge") u[0] = h - 1e-10;
        if (where === "within 1e-14 of a ridge") u[2] = -h + 1e-14;
        if (where === "on a ridge") u[1] = -h;
        if (where === "near a hinge") u = [h - 1e-7, h - 2e-7, u[2]];
        if (where === "near a vertex") u = [h - 1e-7, h - 2e-7, -h + 3e-7];
        const reach = 1.5;
        const nodes = enumerateChains(T, s, cell, u, reach);
        const byCells = new Map(nodes.map((n) => [n.cells.join(","), n]));
        let followed = 0;
        for (let r = 0; r < 300; r++) {
          const d = randomDirection(rand);
          const L = reach * rand();
          const end = trace4d(T, s, cell, u, d, L);
          if (!end) continue;
          followed++;
          const node = byCells.get(end.cells.join(","));
          expect(node, `ray along ${d} for ${L} follows cells ${end.cells}`).toBeDefined();
          const y = isoApply(node!.toAnchor, end.u);
          for (let k = 0; k < 3; k++) expect(y[k]).toBeCloseTo(u[k] + L * d[k], 9);
          // the engine's own walker agrees
          const w = traceGeodesic(T, s, cell, u, d, L);
          if (!w.hitHinge) {
            expect(w.cells).toEqual(end.cells);
            for (let k = 0; k < 3; k++) expect(w.u[k]).toBeCloseTo(end.u[k], 9);
          }
        }
        expect(followed).toBeGreaterThan(200);
      }
    });

  it("on the 5-cell and the 24-cell too (generic polytopes)", () => {
    for (const [name, V] of [
      ["5-cell", simplexVertices()],
      ["24-cell", cell24Vertices()],
    ] as const) {
      const P = buildPolytope(name as PolytopeName, V as number[][]);
      const rand = rng(name.length);
      for (const s of [1, 2]) {
        for (let trial = 0; trial < 4; trial++) {
          const cell = Math.floor(rand() * P.cells.length);
          // a random point of the cell: a random convex combination of its vertices
          const wts = P.cells[cell].vertices.map(() => rand() ** 3);
          const tot = wts.reduce((a, b) => a + b, 0);
          const u = [0, 1, 2].map((k) => P.cells[cell].vertices.reduce((a, v, j) => a + (wts[j] / tot) * v[k] * s, 0));
          const nodes = enumerateChains(P, s, cell, u, 1.5 * s);
          const byCells = new Map(nodes.map((n) => [n.cells.join(","), n]));
          for (let r = 0; r < 200; r++) {
            const d = randomDirection(rand);
            const L = 1.5 * s * rand();
            const end = trace4d(P, s, cell, u, d, L);
            if (!end) continue;
            const node = byCells.get(end.cells.join(","));
            expect(node).toBeDefined();
            const y = isoApply(node!.toAnchor, end.u);
            for (let k = 0; k < 3; k++) expect(y[k]).toBeCloseTo(u[k] + L * d[k], 9);
          }
        }
      }
    }
  });
});

describe("geodesic distance properties", () => {
  it("is symmetric and satisfies the triangle inequality on random samples", () => {
    const rand = rng(5);
    for (const s of [1.3, 2]) {
      const pts = Array.from({ length: 14 }, () => ({ cell: Math.floor(rand() * 8), u: randomCellPoint(s, rand) }));
      const D = pts.map((a) => pts.map((b) => geodesicDistance(T, s, a, b, 4)));
      let triples = 0;
      for (let i = 0; i < pts.length; i++)
        for (let j = 0; j < pts.length; j++) {
          expect(Math.abs(Math.min(D[i][j], 9) - Math.min(D[j][i], 9))).toBeLessThan(1e-12);
          for (let k = 0; k < pts.length; k++) {
            if (D[i][j] + D[j][k] > 4) continue;
            triples++;
            expect(D[i][k]).toBeLessThanOrEqual(D[i][j] + D[j][k] + 1e-12);
          }
        }
      expect(triples).toBeGreaterThan(100);
      for (let i = 0; i < pts.length; i++) expect(D[i][i]).toBe(0);
    }
  });

  it("opposite cell centres are 2 s apart (through a neighbouring cell)", () => {
    for (const s of [1, Math.SQRT2, 2]) expect(geodesicDistance(T, s, { cell: 0, u: [0, 0, 0] }, { cell: 1, u: [0, 0, 0] }, 2 * s + 1)).toBeCloseTo(2 * s, 12);
  });

  it("bounds the work: a far too small polytope throws a ChainLimitError", () => {
    expect(() => enumerateChains(T, 0.01, 0, [0.001, 0.002, 0.003], 2, { maxChains: 500 })).toThrow(ChainLimitError);
  });
});
