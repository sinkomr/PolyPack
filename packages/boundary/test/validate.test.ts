import { describe, expect, it } from "vitest";
import type { BoundaryConfig, BoundaryProblem, PieceName } from "../src/index";
import type { PolytopeName } from "../src/index";
import {
  BALL_RADIUS,
  RIDGE_SNAP,
  TesseractWords,
  boundaryVolume,
  buildPolytope,
  enumerateChains,
  polyhedronThickness,
  tesseractClearance,
  validateOn,
  geodesicDistance,
  getPolytope,
  isoApply,
  isoFromAffine,
  parseBoundaryId,
  partMesh,
  partPolyhedron,
  pieceParts,
  polyhedronVolume,
  quaternionToMatrix,
  validateBoundary,
} from "../src/index";
import { cell16Vertices, cell24Vertices, loadFixtures, randomCellPoint, rng, simplexVertices, trace4d, atSite } from "./helpers";

const T = getPolytope("tesseract");
const problem = (piece: PieceName, P: number): BoundaryProblem => ({ polytope: "tesseract", piece, P });
const shrink = (c: BoundaryConfig, k: number): BoundaryConfig => ({ s: c.s * k, pieces: c.pieces.map((p) => ({ ...p, u: p.u.map((x) => x * k) })) });
const rotZ = (deg: number): [number, number, number, number] => [Math.cos((deg * Math.PI) / 360), 0, 0, Math.sin((deg * Math.PI) / 360)];

describe("timing", () => {
  it("validates a P = 16 configuration in under 200 ms (balls and cubes, cold and warm)", () => {
    const ball = loadFixtures("balls").find((f) => f.id.endsWith("/16"))!;
    const cube = loadFixtures("cubes").find((f) => f.id.endsWith("/16"))!;
    const times: Record<string, number[]> = { ball: [], cube: [] };
    for (let r = 0; r < 5; r++) {
      for (const [k, f] of [
        ["ball", ball],
        ["cube", cube],
      ] as const) {
        const t0 = performance.now();
        const v = validateBoundary(parseBoundaryId(f.id) as BoundaryProblem, f.config);
        times[k].push(performance.now() - t0);
        expect(v.ok).toBe(true);
      }
    }
    // first call is cold (JIT, topology cache); the report quotes these numbers
    console.log(`P = 16 validation ms: balls ${times.ball.map((t) => t.toFixed(1)).join(" ")}; cubes ${times.cube.map((t) => t.toFixed(1)).join(" ")}`);
    for (const t of [...times.ball, ...times.cube]) expect(t).toBeLessThan(200);
  });
});

describe("research fixtures", () => {
  for (const name of ["balls", "cubes"] as const) {
    const list = loadFixtures(name);
    it(`${name}: P = 1..16 present`, () => {
      expect(list.map((f) => (parseBoundaryId(f.id) as BoundaryProblem).P)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    });
    for (const f of list)
      it(`${f.id} is valid at its s and invalid at s (1 - 1e-6)`, () => {
        const p = parseBoundaryId(f.id) as BoundaryProblem;
        const v = validateBoundary(p, f.config);
        expect(v.reasons).toEqual([]);
        expect(v.ok).toBe(true);
        expect(v.score).toBe(f.config.s);
        const w = validateBoundary(p, shrink(f.config, 1 - 1e-6));
        expect(w.ok).toBe(false);
        expect(w.reasons.length).toBeGreaterThan(0);
      });
  }

  it("ball contacts: closest pairs are 1 apart (lattice words agree), and a ball nudged 1e-6 towards a contact overlaps it", () => {
    const W = new TesseractWords(2);
    let nudged = 0;
    for (const f of loadFixtures("balls")) {
      const { s, pieces } = f.config;
      if (pieces.length < 3) continue;
      const contacts: [number, number][] = [];
      let best = Infinity;
      for (let i = 0; i < pieces.length; i++)
        for (let j = i + 1; j < pieces.length; j++) {
          const d = geodesicDistance(T, s, pieces[i], pieces[j], 1.25);
          expect(Math.min(d, 1.25)).toBeCloseTo(Math.min(W.distance(pieces[i].cell, pieces[i].u, pieces[j].cell, pieces[j].u, s), 1.25), 12);
          best = Math.min(best, d);
          if (d < 1 + 1e-9) contacts.push([i, j], [j, i]);
        }
      expect(best).toBeGreaterThan(1 - 1e-9);
      expect(best).toBeLessThan(1 + 1e-9);
      // nudge ball i towards the developed image of ball j, along a contact whose nudge keeps i's edge clearance
      for (const [i, j] of contacts) {
        const u = pieces[i].u as [number, number, number];
        const imgs = enumerateChains(T, s, pieces[i].cell, u, 1.25)
          .filter((n) => n.cell === pieces[j].cell)
          .map((n) => isoApply(n.toAnchor, pieces[j].u))
          .filter((y) => Math.hypot(y[0] - u[0], y[1] - u[1], y[2] - u[2]) < 1 + 1e-9);
        const y = imgs[0];
        const d = Math.hypot(y[0] - u[0], y[1] - u[1], y[2] - u[2]);
        const v2 = u.map((x, k) => x + (1e-6 * (y[k] - x)) / d);
        if (tesseractClearance(v2, s) < 0.5 || v2.some((x) => Math.abs(x) > s / 2)) continue;
        const moved = pieces.map((p, k) => (k === i ? { ...p, u: v2 } : p));
        const v = validateBoundary(parseBoundaryId(f.id) as BoundaryProblem, { s, pieces: moved });
        expect(v.ok).toBe(false);
        expect(v.reasons.join(" ")).toMatch(new RegExp(`Balls ${Math.min(i, j)} and ${Math.max(i, j)} overlap: their centres are 0\\.99999`));
        nudged++;
        break;
      }
    }
    expect(nudged).toBeGreaterThanOrEqual(8);
  });

  it("cube parts have total volume 1 per cube, and the anchor part comes first", () => {
    for (const f of loadFixtures("cubes")) {
      const parts = pieceParts(T, "cube", f.config);
      const vol = new Array(f.config.pieces.length).fill(0);
      for (const part of parts) vol[part.piece] += polyhedronVolume(partPolyhedron(T, part.cell, isoFromAffine(part.place), part.clip, f.config.s));
      for (const v of vol) expect(v).toBeCloseTo(1, 10);
      f.config.pieces.forEach((p, i) => {
        const first = parts.find((x) => x.piece === i)!;
        expect(first.cell).toBe(p.cell);
        expect(first.chain).toEqual([p.cell]);
      });
    }
  });
});

describe("parts against the R^4 ray tracer", () => {
  // every point of a piece lies in exactly one part, and that part puts it where the straight
  // segment from the centre, walked in R^4, ends
  const configs: [string, PieceName, BoundaryConfig][] = [
    ["turned cube over a ridge", "cube", { s: 1.5, pieces: [{ cell: 0, u: [0.3, 0, 0], q: rotZ(45) }] }],
    [
      "generic turned cube over three faces (found by random search)",
      "cube",
      {
        s: 1.837370462110266,
        pieces: [{ cell: 5, u: [0.09450441182600357, -0.40786889627076284, 0.3143200569769978], q: [-0.8318284261934625, -0.06278131225584976, 0.47611851787732634, -0.2782645021238588] }],
      },
    ],
    ["cube crossing four faces", "cube", { s: 1.2, pieces: [{ cell: 2, u: [0, 0, 0], q: rotZ(45) }] }],
    ["ball near a ridge", "ball", atSite({ s: 2.4, pieces: [{ cell: 7, u: [1.2, 0.05, -0.1] }] })],
  ];
  for (const [label, piece, cfg] of configs)
    it(label, () => {
      expect(validateBoundary(problem(piece, 1), cfg).ok).toBe(true);
      const parts = pieceParts(T, piece, cfg);
      const p = cfg.pieces[0];
      const R = piece === "ball" ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : quaternionToMatrix(p.q ?? [1, 0, 0, 0]);
      const rand = rng(label.length);
      let tested = 0;
      for (let k = 0; k < 400; k++) {
        // a random point of the piece (piece-local)
        // a ball is the unit ball under its part's place (whose A carries the radius 1/2); a cube is the cube of edge 1
        const x = [0, 1, 2].map(() => 2 * rand() - 1).map((v) => (piece === "ball" ? v : v / 2));
        if (piece === "ball" && Math.hypot(...x) >= 1) continue;
        const xs = piece === "ball" ? x.map((v) => v * BALL_RADIUS) : x;
        const holders = parts.filter((part) => {
          const y = isoApply(isoFromAffine(part.place), x);
          const inCell = T.cells[part.cell].facets.every((f) => f.inside.n.reduce((a, n, i) => a + n * y[i], 0) <= f.inside.h * cfg.s + 1e-12);
          return inCell && part.clip.every((h) => h.n.reduce((a, n, i) => a + n * y[i], 0) <= h.h + 1e-12);
        });
        expect(holders.length).toBe(1);
        // where the development of the segment centre -> x ends in R^4
        const d = [0, 1, 2].map((i) => R[3 * i] * xs[0] + R[3 * i + 1] * xs[1] + R[3 * i + 2] * xs[2]);
        const L = Math.hypot(...d);
        const end = trace4d(T, cfg.s, p.cell, p.u, d, L);
        if (!end) continue;
        tested++;
        expect(holders[0].cell).toBe(end.cell);
        expect(holders[0].chain).toEqual(end.cells);
        const y = isoApply(isoFromAffine(holders[0].place), x);
        for (let i = 0; i < 3; i++) expect(y[i]).toBeCloseTo(end.u[i], 9);
      }
      expect(tested).toBeGreaterThan(150);
      if (piece === "cube") {
        const total = parts.reduce((a, part) => a + polyhedronVolume(partPolyhedron(T, part.cell, isoFromAffine(part.place), part.clip, cfg.s)), 0);
        expect(total).toBeCloseTo(1, 10);
        for (const part of parts) {
          const mesh = partMesh(T, "cube", part, cfg.s)!;
          expect(mesh.faces.every((f) => f.every((i) => i >= 0))).toBe(true);
          expect(mesh.vertices.length).toBeGreaterThanOrEqual(4);
        }
      } else expect(partMesh(T, "ball", parts[0], cfg.s)).toBeNull();
    });
});

describe("adversarial configurations", () => {
  it("a ball centre within 1 of an edge", () => {
    const v = validateBoundary(problem("ball", 1), { s: 1, pieces: [{ cell: 0, u: [0.15, 0.15, 0] }] });
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/Ball 0 is 0\.49497474\d* from an edge of the tesseract/);
    expect(validateBoundary(problem("ball", 1), { s: 1, pieces: [{ cell: 0, u: [0.145, 0.145, 0] }] }).ok).toBe(true);
  });

  it("two balls overlapping across a ridge (touching is allowed)", () => {
    // cell 0's facet +u0 is glued to cell 3's facet -u0; centres 0.995 from that ridge on each side
    const s = 1.25;
    const over = validateBoundary(problem("ball", 2), { s, pieces: [{ cell: 0, u: [0.1275, 0, 0] }, { cell: 3, u: [-0.1275, 0, 0] }] });
    expect(over.ok).toBe(false);
    expect(over.reasons.join(" ")).toMatch(/Balls 0 and 1 overlap: their centres are 0\.995 apart/);
    expect(validateBoundary(problem("ball", 2), { s, pieces: [{ cell: 0, u: [0.125, 0, 0] }, { cell: 3, u: [-0.125, 0, 0] }] }).ok).toBe(true);
  });

  it("two balls overlapping only around a hinge (the path across their common ridge is exactly 2)", () => {
    // cells 0 (x0 = -h), 3 (x1 = +h) and 5 (x2 = +h) meet at the edge x0 = -h, x1 = x2 = +h. Ball A in
    // cell 0 at 4D (-h, h - 0.1, h - 1, 0), ball B in cell 5 at (-h + 1, h - 0.1, h, 0): across the ridge
    // of cells 0 and 5 they are exactly 2 apart, but the path through cell 3, round the edge, has
    // length 1.1 sqrt 2 = 1.5556 (it crosses the two ridges that contain the edge).
    // (drawn for balls of radius 1 and halved to site units: the geodesic is 1.1 sqrt 2 / 2 = 0.7778)
    const s = 2;
    const A = { cell: 0, u: [0.95, 0.5, 0] };
    const B = { cell: 5, u: [-0.5, 0.95, 0] };
    expect(geodesicDistance(T, s, A, B, 1.25)).toBeCloseTo(0.55 * Math.SQRT2, 12);
    const v = validateBoundary(problem("ball", 2), { s, pieces: [A, B] });
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/Balls 0 and 1 overlap: their centres are 0\.7778174593 apart/);
  });

  it("a cube whose interior contains a hinge point", () => {
    const v = validateBoundary(problem("cube", 1), { s: 2, pieces: [{ cell: 0, u: [0.7, 0.7, 0] }] });
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/Cube 0 has an edge of the tesseract passing through its interior \(depth 0\.2\)/);
    // touching an edge along a face is allowed
    expect(validateBoundary(problem("cube", 1), { s: 2, pieces: [{ cell: 0, u: [0.5, 0.5, 0] }] }).ok).toBe(true);
    // a cube at a cell centre turned about u2 pokes its corners into the four side neighbours and
    // still avoids the edges down to s = 1 (the cell's u2-edges stay outside the turned square,
    // the others lie in the cube's faces u2 = +-1/2)
    expect(validateBoundary(problem("cube", 1), { s: 1.2, pieces: [{ cell: 0, u: [0, 0, 0], q: rotZ(45) }] }).ok).toBe(true);
    expect(validateBoundary(problem("cube", 1), { s: 1, pieces: [{ cell: 0, u: [0, 0, 0], q: rotZ(30) }] }).ok).toBe(true);
    // below s = 1 the cell's edges along u0 and u1 enter the cube
    const w = validateBoundary(problem("cube", 1), { s: 0.99, pieces: [{ cell: 0, u: [0, 0, 0], q: rotZ(30) }] });
    expect(w.ok).toBe(false);
    expect(w.reasons.join(" ")).toMatch(/edge of the tesseract/);
  });

  it("a turned cube crossing a ridge overlaps another cube's part in the neighbour", () => {
    // cube A in cell 0 turned 45 degrees about u2 reaches 0.257 beyond the face u0 = 0.75 into cell 3,
    // whose face u0 = -0.75 is that ridge
    const s = 1.5;
    const A = { cell: 0, u: [0.3, 0, 0], q: rotZ(45) };
    const over = validateBoundary(problem("cube", 2), { s, pieces: [A, { cell: 3, u: [-0.05, 0, 0] }] });
    expect(over.ok).toBe(false);
    expect(over.reasons.join(" ")).toMatch(/Cubes 0 and 1 overlap in cell 3 \(depth 0\.05/);
    expect(validateBoundary(problem("cube", 2), { s, pieces: [A, { cell: 3, u: [0.25, 0, 0] }] }).ok).toBe(true);
    // the same overlap seen from B's side when B is the turned one, mirrored
    const B = { cell: 3, u: [-0.3, 0, 0], q: rotZ(45) };
    const v2 = validateBoundary(problem("cube", 2), { s, pieces: [{ cell: 0, u: [0.05, 0, 0] }, B] });
    expect(v2.ok).toBe(false);
    expect(v2.reasons.join(" ")).toMatch(/Cubes 0 and 1 overlap in cell 0/);
  });

  it("a cube centre outside its anchor cell", () => {
    const v = validateBoundary(problem("cube", 1), { s: 2, pieces: [{ cell: 0, u: [1.01, 0, 0] }] });
    expect(v.ok).toBe(false);
    expect(v.reasons).toEqual(["Piece 0: its centre lies outside its anchor cell 0 by 0.01."]);
    // within the tolerance it is clamped onto the face and accepted
    expect(validateBoundary(problem("cube", 1), { s: 2, pieces: [{ cell: 0, u: [1 + 1e-10, 0, 0] }] }).ok).toBe(true);
  });

  it("shape: wrong P, NaN, q on a ball, bad q, bad cell, bad s, bad problem", () => {
    const ok: BoundaryConfig = { s: 2, pieces: [{ cell: 0, u: [0, 0, 0] }] };
    const r = (p: BoundaryProblem, c: unknown) => validateBoundary(p, c).reasons.join(" ");
    expect(r(problem("ball", 2), ok)).toMatch(/has 1 pieces; the problem needs exactly 2/);
    expect(r(problem("ball", 1), { s: NaN, pieces: ok.pieces })).toMatch(/edge s must be a finite number/);
    expect(r(problem("ball", 1), { s: 2, pieces: [{ cell: 0, u: [0, NaN, 0] }] })).toMatch(/centre u must be 3 finite numbers/);
    expect(r(problem("ball", 1), { s: 2, pieces: [{ cell: 0, u: [0, 0, 0], q: [1, 0, 0, 0] }] })).toMatch(/is a ball and must not have a rotation q/);
    expect(r(problem("cube", 1), { s: 2, pieces: [{ cell: 0, u: [0, 0, 0], q: [1, 0, 0, 1e-4] }] })).toMatch(/must be a unit quaternion/);
    expect(validateBoundary(problem("cube", 1), { s: 2, pieces: [{ cell: 0, u: [0, 0, 0], q: [1, 0, 0, 1e-5].map((x, _, a) => x / Math.hypot(...a)) }] }).ok).toBe(true);
    expect(r(problem("cube", 1), { s: 2, pieces: [{ cell: 0, u: [0, 0, 0], q: [1, 0, 0] }] })).toMatch(/rotation q must be 4 finite numbers/);
    expect(r(problem("cube", 1), { s: 2, pieces: [{ cell: 8, u: [0, 0, 0] }] })).toMatch(/cell must be a whole number from 0 to 7/);
    expect(r(problem("cube", 1), { s: 2, pieces: [{ cell: 1.5, u: [0, 0, 0] }] })).toMatch(/cell must be a whole number/);
    expect(r(problem("cube", 1), { s: 2, pieces: [{ cell: 0, u: [0, 0] }] })).toMatch(/3 finite numbers/);
    expect(r(problem("cube", 1), { s: 0, pieces: ok.pieces })).toMatch(/greater than 0/);
    expect(r(problem("cube", 1), { s: 1e4 + 1, pieces: ok.pieces })).toMatch(/at most 10000; it is 10001/);
    expect(validateBoundary(problem("cube", 1), { s: 1e4, pieces: ok.pieces }).ok).toBe(true);
    expect(r(problem("cube", 1), { s: "2", pieces: ok.pieces })).toMatch(/finite number/);
    expect(r(problem("cube", 1), null)).toMatch(/must be an object/);
    expect(r(problem("cube", 1), { s: 2 })).toMatch(/list of pieces/);
    expect(r(problem("cube", 1), { s: 2, pieces: [null] })).toMatch(/Piece 0 must be an object/);
    expect(r({ polytope: "cube" as never, piece: "ball", P: 1 }, ok)).toMatch(/Unknown polytope/);
    expect(r({ polytope: "tesseract", piece: "tetrahedron" as never, P: 1 }, ok)).toMatch(/Unknown piece/);
    expect(r({ polytope: "tesseract", piece: "ball", P: 0 }, ok)).toMatch(/whole number from 1 to 9999/);
    expect(r({ polytope: "tesseract", piece: "ball", P: 10000 }, ok)).toMatch(/whole number from 1 to 9999/);
    expect(r({ polytope: "tesseract", piece: "ball", P: 1.5 }, ok)).toMatch(/whole number from 1 to 9999/);
  });

  it("bounds the work: a polytope far too small fails cheaply with a plain reason", () => {
    const rand = rng(3);
    const pieces = Array.from({ length: 50 }, () => ({ cell: Math.floor(rand() * 8), u: randomCellPoint(0.01, rand) }));
    for (const piece of ["ball", "cube"] as const) {
      const t0 = performance.now();
      const v = validateBoundary(problem(piece, 50), { s: 0.01, pieces });
      expect(v.ok).toBe(false);
      expect(v.reasons.length).toBeLessThanOrEqual(20);
      expect(performance.now() - t0).toBeLessThan(200);
    }
    // the chain cap itself, when the cheap checks pass (cap set very low)
    const v = validateBoundary(problem("ball", 1), { s: 2, pieces: [{ cell: 0, u: [0, 0, 0] }] }, { maxChains: 5 });
    expect(v.ok).toBe(false);
    expect(v.reasons[0]).toMatch(/Piece 0 reaches more than 5 chains of cells; the tesseract is far too small for its pieces/);
  });

  it("the volume bound: P pieces need P vol(piece) <= 8 s^3", () => {
    expect(boundaryVolume(T)).toBeCloseTo(8, 12);
    const pieces = Array.from({ length: 9 }, (_, i) => ({ cell: i % 8, u: [0, 0, 0] }));
    const v = validateBoundary(problem("cube", 9), { s: 1, pieces });
    expect(v.reasons).toEqual(["9 cubes have a total volume of 9, more than the 8 of the tesseract's boundary at s = 1."]);
    // 8 cubes exactly fill the boundary at s = 1
    expect(validateBoundary(problem("cube", 8), { s: 1, pieces: pieces.slice(0, 8) }).ok).toBe(true);
  });

  it("worst cases stay fast: P = 9999 overlapping pieces just above the volume bound", () => {
    const rand = rng(9);
    for (const piece of ["ball", "cube"] as const) {
      const vol = piece === "ball" ? (4 * Math.PI) / 3 : 1;
      const s = (1.001 * 9999 * vol / 8) ** (1 / 3);
      // centres at least 1 from the cell's edges, so that the cheap edge checks pass
      const pieces = Array.from({ length: 9999 }, () => ({ cell: Math.floor(rand() * 8), u: randomCellPoint(s, rand, 1.01) }));
      const t0 = performance.now();
      const v = validateBoundary(problem(piece, 9999), { s, pieces });
      const t = performance.now() - t0;
      console.log(`P = 9999 overlapping ${piece}s at s = ${s.toFixed(3)}: ${t.toFixed(0)} ms`);
      expect(v.ok).toBe(false);
      expect(v.reasons.join(" ")).toMatch(/overlap/);
      expect(t).toBeLessThan(3000);
    }
  });

  it("many pieces: P = 512 cubes tiling the tesseract at s = 4 validate, and one moved cube does not", () => {
    // 8 k^3 unit cubes at s = k (research note sec. 3), k = 4
    const k = 4;
    const pieces = [];
    for (let c = 0; c < 8; c++)
      for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) for (let d = 0; d < k; d++) pieces.push({ cell: c, u: [a - 1.5, b - 1.5, d - 1.5] });
    const t0 = performance.now();
    expect(validateBoundary(problem("cube", 512), { s: k, pieces }).ok).toBe(true);
    expect(performance.now() - t0).toBeLessThan(5000);
    const moved = pieces.map((p, i) => (i === 7 ? { ...p, u: [p.u[0] + 0.01, p.u[1], p.u[2]] } : p));
    const v = validateBoundary(problem("cube", 512), { s: k, pieces: moved });
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/overlap/);
  });
});

describe("review fixes", () => {
  it("options: a bad tol throws, maxReasons and maxChains below 1 still reject", () => {
    const cfg = { s: 3, pieces: [{ cell: 0, u: [0, 0, 0] }, { cell: 0, u: [0, 0, 0] }] };
    for (const tol of [Infinity, -Infinity, NaN, -1e-9, "1e-9" as unknown as number]) expect(() => validateBoundary(problem("ball", 2), cfg, { tol })).toThrow(RangeError);
    for (const maxReasons of [0, -5, NaN, 0.5]) {
      const v = validateBoundary(problem("ball", 2), cfg, { maxReasons });
      expect(v.ok).toBe(false);
      expect(v.reasons.length).toBe(1);
    }
    for (const maxChains of [0, -1, NaN]) expect(validateBoundary(problem("ball", 2), cfg, { maxChains }).ok).toBe(false);
    expect(validateBoundary(problem("ball", 2), cfg, { tol: 0 }).ok).toBe(false);
  });

  it("sparse lists: holes in pieces, u or q are rejected", () => {
    // eslint-disable-next-line no-sparse-arrays
    const holes: unknown[] = [{ cell: 0, u: [0, 0, 0] }, , { cell: 1, u: [0, 0, 0] }];
    expect(validateBoundary(problem("ball", 3), { s: 3, pieces: holes }).reasons.join(" ")).toMatch(/Piece 1 must be an object/);
    expect(validateBoundary(problem("ball", 2), { s: 3, pieces: new Array(2) }).ok).toBe(false);
    // eslint-disable-next-line no-sparse-arrays
    expect(validateBoundary(problem("ball", 1), { s: 3, pieces: [{ cell: 0, u: [0, , 0] }] }).reasons.join(" ")).toMatch(/3 finite numbers/);
    // eslint-disable-next-line no-sparse-arrays
    expect(validateBoundary(problem("cube", 1), { s: 2, pieces: [{ cell: 0, u: [0, 0, 0], q: [1, , 0, 0] }] }).reasons.join(" ")).toMatch(/4 finite numbers/);
  });

  it("parts are scale-free: a cube poking 5e-7 over a ridge at s = 1e6 (beyond MAX_S) keeps its sliver in the neighbour", () => {
    for (const [s, poke] of [
      [1e4, 5e-9],
      [1e6, 5e-7],
    ]) {
      const h = s / 2;
      const parts = pieceParts(T, "cube", { s, pieces: [{ cell: 0, u: [h - 0.5 + poke, 0.2, -0.1] }] });
      expect(parts.map((p) => p.cell)).toEqual([0, 3]);
      const thick = parts.map((p) => polyhedronThickness(partPolyhedron(T, p.cell, isoFromAffine(p.place), p.clip, s)));
      expect(thick[1]).toBeCloseTo(poke, s > 1e5 ? 9 : 12);
      expect(thick[0]).toBeCloseTo(1 - poke, 9);
    }
  });

  it("chains are kept for centres in the band just above the ridge snap (rule 3's bound never under-estimates)", () => {
    for (const s of [1, 1.26, 2.5, 100, 1e4]) {
      const h = s / 2;
      for (const d of [0, 0.5, 1, 1.5, 3, 10, 1e3].map((k) => k * RIDGE_SNAP * Math.max(1, s))) {
        const nodes = enumerateChains(T, s, 0, [h - d, 0.1 * h, -0.05 * h], 0.9);
        // the chain straight through the +u0 face into cell 3 is always there
        expect(nodes.some((n) => n.cells.join(",") === "0,3"), `s = ${s}, d = ${d}`).toBe(true);
      }
    }
  });

  it("ridge-centred balls on the 5-cell, 16-cell and 24-cell: every overlapping pair on one ridge is seen from either side", () => {
    // without the copies across the ridge, rounding at the half-space window's boundary accepted
    // 254, 235 and 39 of about 570 such pairs (inexact gluings; the tesseract's are exact)
    const rand = rng(5);
    for (const [V, s] of [
      [simplexVertices(), 9],
      [cell16Vertices(), 9],
      [cell24Vertices(), 8],
    ] as const) {
      const P = buildPolytope("tesseract" as PolytopeName, V);
      let seen = 0;
      for (let k = 0; k < 300; k++) {
        const c0 = Math.floor(rand() * P.cells.length);
        const facet = P.cells[c0].facets[Math.floor(rand() * P.cells[c0].facets.length)];
        const tri = facet.vertices.map((i) => P.cells[c0].vertices[i].map((x) => x * s));
        const pt = () => {
          const w = [rand(), rand(), rand()].map((x) => x + 0.6);
          const t = w[0] + w[1] + w[2];
          return [0, 1, 2].map((kk) => (w[0] * tri[0][kk] + w[1] * tri[1][kk] + w[2] * tri[2][kk]) / t);
        };
        const A = pt();
        const B = pt();
        if (Math.hypot(...A.map((x, i) => x - B[i])) > 1.95) continue;
        const v = validateOn(P, "ball", 2, atSite({ s, pieces: [{ cell: c0, u: A }, { cell: facet.neighbor, u: isoApply(isoFromAffine(facet.toNeighbor, s), B) }] }));
        expect(v.ok).toBe(false);
        if (v.reasons.some((r) => /overlap/.test(r))) seen++;
      }
      expect(seen).toBeGreaterThan(200);
    }
  });

  describe("on the 24-cell (octahedral cells: anchor and neighbour do not form a box)", () => {
    const P24 = buildPolytope("tesseract" as PolytopeName, cell24Vertices());
    const s = 8;
    const c0 = 0;
    const f = 0;
    const facet = P24.cells[c0].facets[f];
    const tri = facet.vertices.map((i) => P24.cells[c0].vertices[i].map((x) => x * s));
    const g = [0, 1, 2].map((k) => (tri[0][k] + tri[1][k] + tri[2][k]) / 3);
    const e = (() => {
      const d = tri[1].map((x, k) => x - tri[0][k]);
      const n = Math.hypot(...d);
      return d.map((x) => x / n);
    })();
    const toNb = isoFromAffine(facet.toNeighbor, s);
    const across = (u: number[]) => isoApply(toNb, u);

    it("two balls on one ridge, anchored on opposite sides: the in-ridge distance is seen", () => {
      for (const [a, ok] of [
        [0.7, false],
        [0.99, false],
        [1.01, true],
        [1.05, true],
      ] as const) {
        const A = g.map((x, k) => x + a * e[k]);
        const B = g.map((x, k) => x - a * e[k]);
        for (const pieces of [
          [
            { cell: c0, u: A },
            { cell: facet.neighbor, u: across(B) },
          ],
          [
            { cell: facet.neighbor, u: across(A) },
            { cell: c0, u: B },
          ],
        ]) {
          // (drawn for balls of radius 1, halved to site units: the centres are a apart in site units)
          const v = validateOn(P24, "ball", 2, atSite({ s, pieces }));
          expect(v.ok, `half-distance ${a}: ${v.reasons.join(" ")}`).toBe(ok);
          if (!ok) expect(v.reasons.join(" ")).toMatch(new RegExp(`centres are ${String(a).replace(".", "\\.")}`));
        }
      }
    });

    it("a cube centred on or just off a ridge: every point in exactly one part, where the R^4 trace ends", () => {
      const n = facet.inside.n;
      for (const d of [0, 0.5, 2, 1e3, 1e5].map((k) => k * RIDGE_SNAP * s)) {
        const u = g.map((x, k) => x - d * n[k]);
        const cfg = { s, pieces: [{ cell: c0, u, q: [0.9, 0.3, -0.2, 0.25].map((x, _, q) => x / Math.hypot(...q)) as [number, number, number, number] }] };
        expect(validateOn(P24, "cube", 1, cfg).ok).toBe(true);
        const parts = pieceParts(P24, "cube", cfg);
        const vol = parts.reduce((acc, p) => acc + polyhedronVolume(partPolyhedron(P24, p.cell, isoFromAffine(p.place), p.clip, s)), 0);
        expect(vol).toBeCloseTo(1, 10);
        const R = quaternionToMatrix(cfg.pieces[0].q);
        const rand = rng(Math.round(d * 1e15) + 1);
        for (let k = 0; k < 300; k++) {
          const x = [0, 1, 2].map(() => rand() - 0.5);
          const holders = parts.filter((part) => {
            const y = isoApply(isoFromAffine(part.place), x);
            const inCell = P24.cells[part.cell].facets.every((ff) => ff.inside.n.reduce((acc, nn, i) => acc + nn * y[i], 0) <= ff.inside.h * s + 1e-11);
            return inCell && part.clip.every((hs) => hs.n.reduce((acc, nn, i) => acc + nn * y[i], 0) <= hs.h + 1e-11);
          });
          expect(holders.length).toBeGreaterThanOrEqual(1);
          const dir = [0, 1, 2].map((i) => R[3 * i] * x[0] + R[3 * i + 1] * x[1] + R[3 * i + 2] * x[2]);
          const end = trace4d(P24, s, c0, u, dir, Math.hypot(...dir));
          if (!end) continue;
          // points within 1e-11 of the ridge may sit in both parts; one of them is where the trace ends
          const h = holders.find((p) => p.cell === end.cell);
          expect(h).toBeDefined();
          const y = isoApply(isoFromAffine(h!.place), x);
          for (let i = 0; i < 3; i++) expect(y[i]).toBeCloseTo(end.u[i], 8);
        }
      }
    });
  });
});
