/**
 * Independent review, round 2 (2026-10-25): the fixes of round 1 (review-validator.test.ts).
 *
 * "Defects": `it.fails` reproduces a defect found in this round; the fix makes it pass. "Held up":
 * the fixes checked directly. Also checked outside this file (scratch scripts against copies of the
 * research verifiers): the round-1 batches regenerated on the fixed engine (6,178 cases) and a
 * harsher near-ridge batch (2,204 cases, delta at the snap threshold, s up to 30), 0 disagreements
 * once the reference knows the in-ridge distance (tess.py drops those words, as TesseractWords
 * did); the cube grid against an all-pairs SAT on 300 random packings (P up to 120) with 2,678
 * near-contact nudges, 0 disagreements.
 */
import { describe, expect, it } from "vitest";
import type { BoundaryPiece, BoundaryProblem, PieceName, Polytope } from "../src/index";
import {
  MAX_S,
  PART_EPS,
  RIDGE_SNAP,
  TesseractWords,
  buildPolytope,
  cellExcess,
  clampToCell,
  geodesicDistance,
  geodesicLoop,
  getPolytope,
  isoApply,
  isoFromAffine,
  partPolyhedron,
  pieceParts,
  polyhedronThickness,
  polyhedronVolume,
  satDepth,
  satShape,
  toAmbient,
  validateBoundary,
  validateOn,
} from "../src/index";
import { cell16Vertices, cell24Vertices, rng, simplexVertices, atSite } from "./helpers";

const T = getPolytope("tesseract");
const problem = (piece: PieceName, P: number): BoundaryProblem => ({ polytope: "tesseract", piece, P });
const randQuat = (rand: () => number): [number, number, number, number] => {
  for (;;) {
    const q = [0, 1, 2, 3].map(() => 2 * rand() - 1);
    const n = Math.hypot(...q);
    if (n > 0.1 && n <= 1) return q.map((x) => x / n) as [number, number, number, number];
  }
};
const others: [string, Polytope][] = [
  ["5-cell", buildPolytope("tesseract" as never, simplexVertices())],
  ["16-cell", buildPolytope("tesseract" as never, cell16Vertices())],
  ["24-cell", buildPolytope("tesseract" as never, cell24Vertices())],
];

describe("review round 2: defects", () => {
  // DEFECT (low: the catalogue's scores lie far below the s where it matters). The ridge snap
  // (clampToCell, RIDGE_SNAP max(1, s) = 1e-10 at s = MAX_S) moves a centre up to that far
  // towards its facet before every check, and only the in-cell edge tests use the raw centre. So
  // it acts as extra tolerance on top of tol, away from the facet: a piece in the same cell
  // overlapping the raw piece by tol + 0.9 eta is accepted. Reproduced at s = 1e4: 1.09 tol at the
  // default tol = 1e-9, 9.9 tol at tol = 1e-11 (the server's strict tolerance); 1.89 tol at s = 1e3
  // with tol = 1e-11. At s <= 22 (every catalogue score) the excess is below 3e-13. Fix: snap
  // within min(RIDGE_SNAP max(1, s), tol / 10) (the rule-3 bound keeps the cone branch sound for any
  // distance above it), or charge the snap to the verdict (compare against tol - snap).
  it("the ridge snap does not hide an overlap larger than tol", () => {
    const s = 1e4;
    const h = s / 2;
    const d = 0.99 * RIDGE_SNAP * s;
    for (const tol of [1e-9, 1e-11]) {
      const over = tol + 0.9 * d;
      const cubes = validateBoundary(problem("cube", 2), { s, pieces: [{ cell: 0, u: [h - d, 0, 0] }, { cell: 0, u: [h - d - 1 + over, 0, 0] }] }, { tol });
      const balls = validateBoundary(problem("ball", 2), { s, pieces: [{ cell: 0, u: [h - d, 0, 0] }, { cell: 0, u: [h - d - 1 + over, 0, 0] }] }, { tol });
      expect(cubes.ok, `cubes, tol ${tol}`).toBe(false);
      expect(balls.ok, `balls, tol ${tol}`).toBe(false);
    }
  });
});

describe("review round 2: held up", () => {
  it("coneOver (rule 3 bound): centres at and around the snap threshold see across their ridge", () => {
    for (const s of [1.26, 2.5, 3.7, 8, 30]) {
      const h = s / 2;
      const eta = RIDGE_SNAP * Math.max(1, s);
      for (const delta of [0, 0.5 * eta, eta * (1 - 1e-9), eta * (1 + 1e-9), 1.5 * eta, 3 * eta, 1e-13 * s, 3e-13 * s, 1e-12 * s, 1e-11]) {
        const A = { cell: 0, u: [h - delta, 0.1, 0] };
        const B = { cell: 3, u: [-h + delta, 0.1, 0] };
        // two coincident cubes across the ridge, and the half-cube stack of round 1
        expect(validateBoundary(problem("cube", 2), { s, pieces: [A, B] }).ok, `cubes s ${s} delta ${delta}`).toBe(false);
        expect(validateBoundary(problem("cube", 2), { s, pieces: [A, { cell: 3, u: [-h + 0.7, 0.1, 0] }] }).ok).toBe(false);
        if (s >= 2.2) {
          // (balls of radius 1 drawn, halved to site units)
          expect(validateBoundary(problem("ball", 2), atSite({ s, pieces: [A, B] })).ok, `balls s ${s} delta ${delta}`).toBe(false);
          expect(validateBoundary(problem("ball", 2), atSite({ s, pieces: [B, A] })).ok).toBe(false);
          expect(validateBoundary(problem("ball", 2), atSite({ s, pieces: [A, { cell: 3, u: [-h + 1, 0.1, 0] }] })).ok).toBe(false);
        }
      }
    }
  });

  it("the cube grid agrees with an all-pairs SAT on random packings and near-contact nudges", () => {
    const tol = 1e-9;
    const rand = rng(8);
    const shapesOf = (p: BoundaryPiece, s: number) =>
      pieceParts(T, "cube", { s, pieces: [p] })
        .map((part) => ({ cell: part.cell, P: partPolyhedron(T, part.cell, isoFromAffine(part.place), part.clip, s) }))
        .filter((x) => x.P.faces.length && polyhedronThickness(x.P) > PART_EPS)
        .map((x) => ({ cell: x.cell, sat: satShape(x.P) }));
    type Shapes = ReturnType<typeof shapesOf>;
    const depth = (A: Shapes, B: Shapes) => {
      let w = -Infinity;
      for (const x of A) for (const y of B) if (x.cell === y.cell) w = Math.max(w, satDepth(x.sat, y.sat));
      return w;
    };
    let verdicts = 0;
    for (let r = 0; r < 10; r++) {
      // coordinates straddle the grid lines -4, -2, 0, 2, 4 (low corners within 1e-13 of them too)
      const s = [3.3, 4.02, 4.5, 6.2][r % 4];
      const h = s / 2;
      const pieces: BoundaryPiece[] = [];
      const sh: Shapes[] = [];
      for (let tries = 0; tries < 400 && pieces.length < 50; tries++) {
        const p: BoundaryPiece = { cell: Math.floor(rand() * 8), u: [0, 1, 2].map(() => (2 * rand() - 1) * h) };
        for (let k = 0; k < 3; k++) if (rand() < 0.3) p.u[k] = Math.max(-h, Math.min(h, 2 * Math.round((p.u[k] - 0.5) / 2) + 0.5 + [0, 1e-13, -1e-13][Math.floor(rand() * 3)]));
        if (r % 3 && rand() < 0.8) p.q = randQuat(rand);
        if (!validateBoundary(problem("cube", 1), { s, pieces: [p] }).ok) continue;
        const S = shapesOf(p, s);
        if (sh.some((B) => depth(S, B) > tol)) continue;
        pieces.push(p);
        sh.push(S);
      }
      expect(validateBoundary(problem("cube", pieces.length), { s, pieces }).ok).toBe(true);
      verdicts++;
      for (let k = 0; k < 12; k++) {
        const i = Math.floor(rand() * pieces.length);
        const j = Math.floor(rand() * pieces.length);
        if (i === j || pieces[i].cell !== pieces[j].cell) continue;
        const dir = pieces[j].u.map((x, m) => x - pieces[i].u[m]);
        const at = (t: number): BoundaryPiece => ({ ...pieces[i], u: pieces[i].u.map((x, m) => Math.max(-h, Math.min(h, x + t * dir[m]))) });
        const rest = sh.filter((_, m) => m !== i);
        const over = (t: number) => rest.some((B) => depth(shapesOf(at(t), s), B) > tol);
        if (over(0) || !over(1)) continue;
        let lo = 0;
        let hi = 1;
        for (let it = 0; it < 40; it++) {
          const m = (lo + hi) / 2;
          if (over(m)) hi = m;
          else lo = m;
        }
        for (const t of [Math.min(1, hi + 1e-6), Math.max(0, lo - 1e-6)]) {
          const moved = pieces.map((p, m) => (m === i ? at(t) : p));
          if (!validateBoundary(problem("cube", 1), { s, pieces: [moved[i]] }).ok) continue;
          const truth = !rest.some((B) => depth(shapesOf(moved[i], s), B) > tol);
          expect(validateBoundary(problem("cube", moved.length), { s, pieces: moved }).ok).toBe(truth);
          verdicts++;
        }
      }
    }
    expect(verdicts).toBeGreaterThan(40);
  });

  it("valid columns of 9999 cubes at s = MAX_S validate in linear time (one cell, and on a ridge)", () => {
    for (const ridge of [false, true]) {
      const s = MAX_S;
      const h = s / 2;
      const pieces = Array.from({ length: 9999 }, (_, k) => ({ cell: 0, u: [ridge ? h : 0, -h + 0.5 + k, 0] }));
      const t0 = performance.now();
      expect(validateBoundary(problem("cube", 9999), { s, pieces }).ok).toBe(true);
      // 0.28 s and 0.44 s under tsx (11.2 s and 25.7 s before the grid)
      expect(performance.now() - t0).toBeLessThan(3000);
      const bad = pieces.map((p, k) => (k === 9998 ? { ...p, u: [p.u[0], p.u[1] - 0.5, p.u[2]] } : p));
      // reported in each cell the pair overlaps in (cells 0 and 3 when the column straddles the ridge)
      const reasons = validateBoundary(problem("cube", 9999), { s, pieces: bad }).reasons;
      expect(reasons.length).toBe(ridge ? 2 : 1);
      for (const r of reasons) expect(r).toMatch(/^Cubes 9997 and 9998 overlap in cell [03] \(depth 0\.5\)\.$/);
    }
  });

  it("large s: slivers over a ridge are seen at every s up to MAX_S, at tol 1e-9 and 1e-11", () => {
    for (const s of [2, 1e3, 3e3, 9999.5, MAX_S]) {
      const h = s / 2;
      const pair = (depth: number) => [
        { cell: 0, u: [h - 0.5 + depth, 0.123, -0.31] },
        { cell: 3, u: [-h + 0.5, 0.123, -0.31] },
      ];
      expect(validateBoundary(problem("cube", 2), { s, pieces: pair(5e-10) }).ok).toBe(true);
      expect(validateBoundary(problem("cube", 2), { s, pieces: pair(1.5e-9) }).ok, `s ${s}`).toBe(false);
      expect(validateBoundary(problem("cube", 2), { s, pieces: pair(5e-12) }, { tol: 1e-11 }).ok).toBe(true);
      expect(validateBoundary(problem("cube", 2), { s, pieces: pair(3e-11) }, { tol: 1e-11 }).ok, `strict, s ${s}`).toBe(false);
      // a cube turned 45 degrees about u2 poking its edge over the ridge
      const tip = (depth: number) => [
        { cell: 0, u: [h - Math.SQRT1_2 + depth, 0, 0], q: [Math.cos(Math.PI / 8), 0, 0, Math.sin(Math.PI / 8)] as [number, number, number, number] },
        { cell: 3, u: [-h + 0.5, 0, 0] },
      ];
      expect(validateBoundary(problem("cube", 2), { s, pieces: tip(5e-10) }).ok).toBe(true);
      expect(validateBoundary(problem("cube", 2), { s, pieces: tip(2e-9) }).ok).toBe(false);
    }
  });

  it("the snap keeps centres in their closed cells (tesseract, 5-cell, 16-cell, 24-cell) and moves them by at most 1.5 eta", () => {
    const rand = rng(99);
    for (const [name, P] of [["tesseract", T] as [string, Polytope], ...others]) {
      let n = 0;
      for (let k = 0; k < 4000; k++) {
        const s = [1, 3, 100, MAX_S][k % 4];
        const c = Math.floor(rand() * P.cells.length);
        const cell = P.cells[c];
        const w = cell.vertices.map(() => rand() ** 3);
        const sw = w.reduce((a, b) => a + b, 0);
        const u = [0, 1, 2].map((i) => cell.vertices.reduce((a, v, j) => a + (w[j] / sw) * v[i] * s, 0));
        const eta = RIDGE_SNAP * Math.max(1, s);
        for (let t = 0; t < 1 + (k % 2); t++) {
          const f = cell.facets[Math.floor(rand() * cell.facets.length)].inside;
          const ex = f.n.reduce((a, x, i) => a + x * u[i], 0) - f.h * s;
          const target = -eta * (rand() * 3 - 1);
          for (let i = 0; i < 3; i++) u[i] += (target - ex) * f.n[i];
        }
        if (!(cellExcess(P, c, u, s) <= 1e-9)) continue;
        const p = clampToCell(P, c, u, s);
        n++;
        expect(cellExcess(P, c, p, s), name).toBeLessThanOrEqual(1e-15 * Math.max(1, s));
        expect(Math.hypot(p[0] - u[0], p[1] - u[1], p[2] - u[2]), name).toBeLessThanOrEqual(1.5 * eta);
      }
      expect(n, name).toBeGreaterThan(1000);
    }
  });

  it("validateOn: ball pairs centred on one ridge, anchored on opposite sides, closer than 2, are rejected (all four polytopes)", () => {
    const rand = rng(777);
    for (const [name, P, s0, s1] of [["tesseract", T, 2.2, 4.5], ["5-cell", others[0][1], 3.5, 7], ["16-cell", others[1][1], 3.5, 7], ["24-cell", others[2][1], 3.5, 5]] as [string, Polytope, number, number][]) {
      let n = 0;
      for (let it = 0; it < 6000 && n < 150; it++) {
        const s = s0 + (s1 - s0) * rand();
        const c = Math.floor(rand() * P.cells.length);
        const cell = P.cells[c];
        const fc = cell.facets[Math.floor(rand() * cell.facets.length)];
        const ridge = fc.vertices.map((i) => cell.vertices[i].map((x) => x * s));
        const pt = () => {
          const w = ridge.map(() => rand() ** 2);
          const sw = w.reduce((a, b) => a + b, 0);
          return [0, 1, 2].map((i) => ridge.reduce((a, v, j) => a + (w[j] / sw) * v[i], 0));
        };
        const ua = pt();
        const k = rand();
        const ub = pt().map((x, i) => ua[i] + k * (x - ua[i]));
        const A = { cell: c, u: ua };
        const B = { cell: fc.neighbor, u: isoApply(isoFromAffine(fc.toNeighbor, s), ub) };
        const a4 = toAmbient(P, A.cell, A.u, s);
        const b4 = toAmbient(P, B.cell, B.u, s);
        const d = Math.hypot(...a4.map((x, i) => x - b4[i]));
        if (!(d < 2 - 1e-7)) continue;
        if (!validateOn(P, "ball", 1, atSite({ s, pieces: [A] })).ok || !validateOn(P, "ball", 1, atSite({ s, pieces: [B] })).ok) continue;
        // the segment inside the flat ridge is a path of length d < 2
        expect(validateOn(P, "ball", 2, atSite({ s, pieces: [A, B] })).ok, name).toBe(false);
        expect(validateOn(P, "ball", 2, atSite({ s, pieces: [B, A] })).ok, name).toBe(false);
        n++;
      }
      expect(n, name).toBeGreaterThan(name === "24-cell" ? 20 : 100);
    }
  });

  it("validateOn: cube parts cover the cube once on the 5-cell, 16-cell and 24-cell", () => {
    const rand = rng(2024);
    for (const [name, P] of others) {
      const [s0, s1] = name === "24-cell" ? [2, 4.5] : [3.5, 7];
      let n = 0;
      for (let it = 0; it < 20000 && n < 80; it++) {
        const s = s0 + (s1 - s0) * rand();
        const c = Math.floor(rand() * P.cells.length);
        const cell = P.cells[c];
        const w = cell.vertices.map(() => rand() ** 2);
        const sw = w.reduce((a, b) => a + b, 0);
        const p = { cell: c, u: [0, 1, 2].map((i) => cell.vertices.reduce((a, v, j) => a + (w[j] / sw) * v[i] * s, 0)), q: randQuat(rand) };
        if (!validateOn(P, "cube", 1, { s, pieces: [p] }).ok) continue;
        n++;
        const vol = pieceParts(P, "cube", { s, pieces: [p] }).reduce((a, part) => a + polyhedronVolume(partPolyhedron(P, part.cell, isoFromAffine(part.place), part.clip, s)), 0);
        expect(Math.abs(vol - 1), name).toBeLessThan(1e-12);
      }
      expect(n, name).toBe(80);
    }
  });

  it("TesseractWords agrees with the generic chains on points of the cells' faces (distances and loops)", () => {
    const W = new TesseractWords(2);
    const rand = rng(99);
    let compared = 0;
    for (let k = 0; k < 400; k++) {
      const s = 1.5 + 2.5 * rand();
      const h = s / 2;
      const c1 = Math.floor(rand() * 8);
      const f = Math.floor(rand() * 6);
      const u1 = [0, 1, 2].map(() => (2 * rand() - 1) * h);
      u1[f >> 1] = (f & 1 ? 1 : -1) * h;
      const c2 = rand() < 0.5 ? T.cells[c1].facets[f].neighbor : Math.floor(rand() * 8);
      const u2 = [0, 1, 2].map(() => (2 * rand() - 1) * h);
      if (rand() < 0.7) u2[Math.floor(rand() * 3)] = (rand() < 0.5 ? -1 : 1) * h;
      const dw = W.distance(c1, u1, c2, u2, s);
      const dg = geodesicDistance(T, s, { cell: c1, u: u1 }, { cell: c2, u: u2 }, 2);
      if (dw < 2 || dg < 2) {
        compared++;
        expect(Math.abs(Math.min(dw, 9) - Math.min(dg, 9))).toBeLessThan(1e-9);
      }
      expect(Math.min(W.loop(c1, u1, s), 2)).toBeCloseTo(Math.min(geodesicLoop(T, s, { cell: c1, u: u1 }, 2), 2), 9);
    }
    expect(compared).toBeGreaterThan(80);
  });

  it("options: a bad tol throws, maxReasons and maxChains below 1 cannot make anything pass", () => {
    const over = { s: 3, pieces: [{ cell: 0, u: [0, 0, 0] }, { cell: 0, u: [0, 0, 0] }] };
    for (const tol of [NaN, -1, Infinity, "1e-9" as unknown as number]) expect(() => validateBoundary(problem("ball", 2), over, { tol })).toThrow(RangeError);
    for (const maxReasons of [0, -5, NaN, 0.5]) expect(validateBoundary(problem("ball", 2), over, { maxReasons }).ok).toBe(false);
    for (const maxChains of [0, -1, NaN]) expect(validateBoundary(problem("ball", 1), atSite({ s: 3, pieces: [{ cell: 0, u: [0, 0, 0] }] }), { maxChains }).ok).toBe(false);
    // holes in the pieces list itself
    expect(validateBoundary(problem("ball", 2), { s: 3, pieces: [{ cell: 0, u: [0, 0, 0] }, ,] }).ok).toBe(false);
    const sparse = new Array(2);
    sparse[1] = { cell: 1, u: [0, 0, 0] };
    expect(validateBoundary(problem("ball", 2), { s: 3, pieces: sparse }).ok).toBe(false);
  });
});
