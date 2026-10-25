/**
 * Independent review of the boundary validator (2026-10-25).
 *
 * "Confirmed defects": each `it.fails` reproduces a defect found in review; it fails today, so the
 * suite stays green, and the fix makes it pass (then Vitest reports the unexpected pass: turn it
 * into a plain `it`). "Held up": behaviour checked in review that is correct today.
 *
 * Also checked outside this file (scratch scripts against copies of the research verifiers
 * tess.py, cube1.py parts + LPs): 4,350 random and threshold configurations, 0 verdict
 * disagreements, including 600 pair contacts at chain depth 1-3 near ridges, edges and vertices.
 */
import { describe, expect, it } from "vitest";
import type { BoundaryConfig, BoundaryPiece, BoundaryProblem, PieceName } from "../src/index";
import {
  TesseractWords,
  getPolytope,
  isoFromAffine,
  partPolyhedron,
  pieceParts,
  polyhedronVolume,
  quaternionToMatrix,
  tesseractEmbed,
  MAX_S,
  validateBoundary,
} from "../src/index";
import { rng } from "./helpers";

const T = getPolytope("tesseract");
const problem = (piece: PieceName, P: number): BoundaryProblem => ({ polytope: "tesseract", piece, P });
const randQuat = (rand: () => number): [number, number, number, number] => {
  for (;;) {
    const q = [0, 1, 2, 3].map(() => 2 * rand() - 1);
    const n = Math.hypot(...q);
    if (n > 0.1 && n <= 1) return q.map((x) => x / n) as [number, number, number, number];
  }
};

/** Ring layouts (research note sec. 3-4): ring 0 = cells 0, 3, 1, 2 along u0; ring 1 = cells 4, 7, 5, 6 along u2. */
function ringPiece(ring: 0 | 1, r: number, a: number, b: number, s: number): BoundaryPiece {
  const h = s / 2;
  r = ((r % (4 * s)) + 4 * s) % (4 * s);
  const seg = Math.min(3, Math.floor(r / s));
  const t = r - seg * s;
  const cells = ring === 0 ? [0, 3, 1, 2] : [4, 7, 5, 6];
  const along = seg < 2 ? -h + t : h - t;
  return { cell: cells[seg], u: ring === 0 ? [along, a, b] : [a, b, along] };
}

/** k^2 rows of 4k unit cubes round each ring at s = k, row (ring, ia, ib) slid by offset(...). */
function slidTiling(k: number, offset: (ring: number, ia: number, ib: number) => number): BoundaryConfig {
  const s = k;
  const h = s / 2;
  const pieces: BoundaryPiece[] = [];
  for (const ring of [0, 1] as const)
    for (let ia = 0; ia < k; ia++)
      for (let ib = 0; ib < k; ib++) for (let m = 0; m < 4 * k; m++) pieces.push(ringPiece(ring, 0.5 + m + offset(ring, ia, ib), -h + 0.5 + ia, -h + 0.5 + ib, s));
  return { s, pieces };
}

/** The same placement anchored in the neighbour across facet f (the centre lies on f). */
function reanchor(piece: PieceName, p: BoundaryPiece, f: number, s: number): BoundaryPiece {
  const fc = T.cells[p.cell].facets[f];
  const { A, b } = fc.toNeighbor;
  const u = [0, 1, 2].map((r) => A[r][0] * p.u[0] + A[r][1] * p.u[1] + A[r][2] * p.u[2] + s * b[r]);
  const out: BoundaryPiece = { cell: fc.neighbor, u };
  if (piece === "cube") {
    const M = A.flat();
    const Rq = p.q ? quaternionToMatrix(p.q) : [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const mul = (X: number[], Y: number[]) => [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => X[3 * r] * Y[c] + X[3 * r + 1] * Y[3 + c] + X[3 * r + 2] * Y[6 + c]));
    let R = mul(M, Rq);
    const det = R[0] * (R[4] * R[8] - R[5] * R[7]) - R[1] * (R[3] * R[8] - R[5] * R[6]) + R[2] * (R[3] * R[7] - R[4] * R[6]);
    // a gluing may reverse orientation; the cube is symmetric under the reflection x -> -x
    if (det < 0) R = mul(R, [-1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const [a, bb, c, d, e, ff, g, hh, i] = R;
    const tr = a + e + i;
    let q: number[];
    if (tr > 0) {
      const S = Math.sqrt(tr + 1) * 2;
      q = [0.25 * S, (hh - ff) / S, (c - g) / S, (d - bb) / S];
    } else if (a > e && a > i) {
      const S = Math.sqrt(1 + a - e - i) * 2;
      q = [(hh - ff) / S, 0.25 * S, (bb + d) / S, (c + g) / S];
    } else if (e > i) {
      const S = Math.sqrt(1 + e - a - i) * 2;
      q = [(c - g) / S, (bb + d) / S, 0.25 * S, (ff + hh) / S];
    } else {
      const S = Math.sqrt(1 + i - a - e) * 2;
      q = [(d - bb) / S, (c + g) / S, (ff + hh) / S, 0.25 * S];
    }
    const n = Math.hypot(...q);
    out.q = q.map((x) => x / n) as [number, number, number, number];
  }
  return out;
}

describe("review: confirmed defects", () => {
  // DEFECT (critical: false accepts of gross overlaps, fake records). chains.ts coneOver measures a
  // window's angular height above each face only at the gate's VERTEX rays. When the centre lies
  // within a few 1e-13 s of a ridge plane (just above eta = 1e-13 max(1, s), so the cone branch
  // runs), every vertex ray is nearly parallel to that plane and the height reads ~ 3 delta / s <
  // MIN_WINDOW_ANGLE, although the window is almost the whole half-space beyond the ridge (the
  // straight-through direction has height ~1). The chain into the neighbour is dropped, with its
  // part, its hinges and its centre images. Reproduced (and confirmed invalid by the research
  // verifier: cube1.parts_of + LPs give overlap radius 0.25; tess words give centre distance 1e-12):
  //  - P = 16 unit cubes accepted at s = 1.26 (the volume bound; the research best is 1.5): two
  //    cubes per cell, centres 1.5e-13 inside the cell's -u0 and +u0 faces, each half of every
  //    cube in its neighbour never compared;
  //  - two coincident cubes, or two coincident balls (either order), anchored on the two sides of
  //    one ridge 5e-13 from it;
  //  - two balls 1.0 apart (ball 0's centre 5e-13 from the ridge).
  // Fix (both checked on a scratch copy: these reproducers rejected, the existing and review tests
  // pass): drop the angular pruning in coneOver (return the normals whenever there are >= 3), or
  // include among the candidate directions the gate plane's normal when the foot of u lies inside
  // the gate.
  it("does not drop the chain across a ridge when the centre is a few 1e-13 from its plane", () => {
    const pieces: BoundaryPiece[] = [];
    const s = 1.26;
    const h = s / 2;
    for (let c = 0; c < 8; c++) pieces.push({ cell: c, u: [h - 1.5e-13, 0, 0] }, { cell: c, u: [-h + 1.5e-13, 0, 0] });
    const fake = validateBoundary(problem("cube", 16), { s, pieces });
    for (const [s2, d] of [
      [2.5, 5e-13],
      [3.7, 7e-13],
    ]) {
      const h2 = s2 / 2;
      const A = { cell: 0, u: [h2 - d, 0.1, 0] };
      const B = { cell: 3, u: [-h2 + d, 0.1, 0] };
      expect(validateBoundary(problem("cube", 2), { s: s2, pieces: [A, B] }).ok).toBe(false);
      expect(validateBoundary(problem("ball", 2), { s: s2, pieces: [A, B] }).ok).toBe(false);
      expect(validateBoundary(problem("ball", 2), { s: s2, pieces: [B, A] }).ok).toBe(false);
      expect(validateBoundary(problem("ball", 2), { s: s2, pieces: [A, { cell: 3, u: [-h2 + 1, 0.1, 0] }] }).ok).toBe(false);
    }
    expect(fake.ok).toBe(false);
  });

  // DEFECT (medium). partPolyhedron clips with eps = 1e-12 max(1, s): at large s a cube poking up to
  // eps over a ridge keeps its whole anchor part (every vertex is "on" the plane) and loses its
  // part in the neighbour (no vertex is "in" by more than eps), so an overlap of depth up to
  // 1e-12 s in the neighbour cell goes unseen. Reproduced: depth 5e-9 accepted at s = 1e4, 5e-8 at
  // s = 1e5, 5e-7 at s = 1e6 (MAX_S), against tol = 1e-9. Fix: an eps independent of s (compute the
  // part relative to the piece centre, where coordinates are O(1)), or a much smaller MAX_S.
  it("rejects a cube overlapping a neighbour across a ridge by more than tol at large s", () => {
    for (const [s, depth] of [
      [1e4, 5e-9],
      [1e5, 5e-8],
      [1e6, 5e-7],
    ]) {
      const h = s / 2;
      // cell 0's facet +u0 is glued to cell 3's facet -u0
      const v = validateBoundary(problem("cube", 2), { s, pieces: [{ cell: 0, u: [h - 0.5 + depth, 0, 0] }, { cell: 3, u: [-h + 0.5, 0, 0] }] });
      expect(v.ok, `s = ${s}, depth ${depth}`).toBe(false);
    }
  });

  // DEFECT (high if the catalogue admits large P; the engine's MAX_P is 9999). The cube pair stage
  // sweeps along the cell's first local axis only, so a VALID layout whose parts share one u0 range
  // (a column, or a slab at large s) costs O(P^2) box tests. Measured under tsx (how the server
  // runs, `tsx src/node.ts`): 11.2 s for 9999 cubes in one column at s = 1e4, 25.7 s when every
  // cube straddles a ridge (two columns of parts), 3.9 s for 4000 on a ridge. Under Vitest the same
  // inputs take 1.3 s and 3.3 s. The server validates synchronously in the request handler and
  // charges the time only afterwards, so one submission stalls every request for that long. Fix:
  // bin parts in a uniform grid per cell (side 2 > the largest part extent sqrt 3), as
  // validateBalls does for centres.
  it("validates a valid column of 9999 cubes on a ridge quickly (pair stage not quadratic)", () => {
    // Round 2: was P = 6000 with an 800 ms bound, which the fixed (linear) code exceeded once
    // (888 ms) under the full parallel suite plus a background reference run. The quadratic sweep
    // took 3.3-10 s for this input under Vitest; the grid takes 0.3-0.5 s (0.44 s under tsx).
    const P = 9999;
    const s = MAX_S;
    const h = s / 2;
    const pieces = Array.from({ length: P }, (_, k) => ({ cell: 0, u: [h, -h + 0.5 + k, 0] }));
    const t0 = performance.now();
    const v = validateBoundary(problem("cube", P), { s, pieces });
    const ms = performance.now() - t0;
    expect(v.ok).toBe(true);
    expect(ms).toBeLessThan(2500);
  }, 60000);

  // DEFECT (low-medium; not reachable through JSON.parse, reachable from any JS caller or a
  // structured clone, and the input is typed unknown). Array.prototype.every skips holes, so
  // u = new Array(3) passes the shape check; every later comparison with NaN is false, so the
  // piece is accepted. A cube with q = new Array(4) passes at s = 0.5 (no cube fits below s = 1).
  // Fix: check u[k] for k < dim by index (Number.isFinite), and write the rejecting comparisons
  // NaN-safe (!(d >= 1 - tol) rather than d < 1 - tol).
  it("rejects sparse arrays (holes read as undefined, then NaN)", () => {
    expect(validateBoundary(problem("ball", 1), { s: 3, pieces: [{ cell: 0, u: new Array(3) }] }).ok).toBe(false);
    expect(validateBoundary(problem("ball", 2), { s: 3, pieces: [{ cell: 0, u: new Array(3) }, { cell: 0, u: [0, 0, 0] }] }).ok).toBe(false);
    expect(validateBoundary(problem("cube", 1), { s: 0.5, pieces: [{ cell: 0, u: [0, 0, 0], q: new Array(4) }] }).ok).toBe(false);
  });

  // DEFECT (low; caller misuse). maxReasons <= 0 makes every push a no-op and every early stop
  // (reasons.length >= maxReasons) fire at once: any configuration, malformed or overlapping, is
  // accepted. tol is not checked either (Infinity accepts everything). Fix: clamp maxReasons to
  // >= 1 and require a finite tol >= 0.
  it("does not accept everything when maxReasons is 0", () => {
    const v = validateBoundary(problem("ball", 2), { s: 3, pieces: [{ cell: 0, u: [0, 0, 0] }, { cell: 0, u: [0, 0, 0] }] }, { maxReasons: 0 });
    expect(v.ok).toBe(false);
  });

  // DEFECT (low; not in the validator). TesseractWords.distances finds no path between two points
  // that both lie on the crossing face of a word: the crossing time is 0/0 = NaN and the word is
  // dropped (tess.py has the same formula). Two balls centred on the ridge of cells 0 and 3,
  // anchored on opposite sides, 0.5 apart: the words say Infinity. The validator is right (it
  // rejects them); the gap weakens the cross-check tests exactly at ridge-centred points, and
  // src/search/balls.ts builds its distance tables from these words.
  it("TesseractWords: distance between two points on one ridge, anchored on opposite sides", () => {
    const W = new TesseractWords(2);
    const s = 3;
    const h = s / 2;
    const A = { cell: 0, u: [h, 0.1, 0.2] };
    const B = { cell: 3, u: [-h, 0.6, 0.2] };
    expect(validateBoundary(problem("ball", 2), { s, pieces: [A, B] }).ok).toBe(false);
    expect(W.distance(A.cell, A.u, B.cell, B.u, s)).toBeCloseTo(0.5, 12);
  });
});

describe("review: held up", () => {
  it("exact contacts: tilings and slid rows (cubes straddling ridges) are valid, and invalid 1e-7 smaller", () => {
    for (const k of [1, 2, 3]) {
      for (const cfg of [slidTiling(k, () => 0), slidTiling(k, (r, a, b) => ((r * 7 + a * 3 + b * 5 + 1) * 0.6180339887) % 1)]) {
        expect(validateBoundary(problem("cube", cfg.pieces.length), cfg).ok).toBe(true);
        // also at the server's strict tolerance
        expect(validateBoundary(problem("cube", cfg.pieces.length), cfg, { tol: 1e-11 }).ok).toBe(true);
        const f = 1 - 1e-7;
        const small = { s: cfg.s * f, pieces: cfg.pieces.map((p) => ({ ...p, u: p.u.map((x) => x * f) })) };
        expect(validateBoundary(problem("cube", cfg.pieces.length), small).ok).toBe(false);
      }
    }
    // two rings of floor(4 s) cubes for 1 <= s < 2 (research note sec. 4), rows slid
    for (const s of [1.25, 1.5, 1.75]) {
      const n = Math.floor(4 * s + 1e-9);
      const pieces: BoundaryPiece[] = [];
      for (const ring of [0, 1] as const) for (let m = 0; m < n; m++) pieces.push(ringPiece(ring, 0.5 + m + 0.123 * (ring + 1), 0, 0, s));
      expect(validateBoundary(problem("cube", pieces.length), { s, pieces }).ok).toBe(true);
    }
    // one cube of a slid row moved 1e-6 into its neighbour
    const cfg = slidTiling(2, (r, a, b) => ((r * 7 + a * 3 + b * 5 + 1) * 0.6180339887) % 1);
    const moved = cfg.pieces.map((p, i) => (i === 0 ? { ...p, u: [p.u[0] + (p.cell === 0 || p.cell === 3 ? 1e-6 : -1e-6), p.u[1], p.u[2]] } : p));
    expect(validateBoundary(problem("cube", moved.length), { s: cfg.s, pieces: moved }).ok).toBe(false);
  });

  it("balls centred on one ridge, anchored on opposite sides: the in-ridge distance is seen", () => {
    const rand = rng(5);
    let compared = 0;
    for (let k = 0; k < 400; k++) {
      const s = 2.2 + 2 * rand();
      const h = s / 2;
      const a = [(2 * rand() - 1) * (h - 1), (2 * rand() - 1) * (h - 1)];
      const b = [a[0] + (2 * rand() - 1) * 2.2, a[1] + (2 * rand() - 1) * 2.2].map((x) => Math.max(-(h - 1), Math.min(h - 1, x)));
      const A = { cell: 0, u: [h, a[0], a[1]] };
      const B = { cell: 3, u: [-h, b[0], b[1]] };
      // both on the ridge x0 = -h, x1 = +h: the segment inside the flat ridge is the shortest path
      const pa = tesseractEmbed(0, A.u, h);
      const pb = tesseractEmbed(3, B.u, h);
      const d = Math.hypot(...pa.map((x, i) => x - pb[i]));
      if (Math.abs(d - 2) < 1e-7) continue;
      for (const pieces of [
        [A, B],
        [B, A],
      ]) {
        expect(validateBoundary(problem("ball", 2), { s, pieces }).ok).toBe(d >= 2);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(700);
  });

  it("a piece centred on a ridge gives the same verdict anchored on either side (also at thresholds)", () => {
    const rand = rng(77);
    let thresholds = 0;
    for (let it = 0; it < 400 && thresholds < 40; it++) {
      const piece: PieceName = rand() < 0.5 ? "cube" : "ball";
      const s0 = piece === "cube" ? 1.2 + 2 * rand() : 2.1 + 2 * rand();
      const cell = Math.floor(rand() * 8);
      const f = Math.floor(rand() * 6);
      const n = T.cells[cell].facets[f].inside.n;
      const k = n.findIndex((x) => x !== 0);
      const ua = [0, 1, 2].map(() => (2 * rand() - 1) * (s0 / 2));
      const qa = piece === "cube" && rand() < 0.8 ? randQuat(rand) : undefined;
      const cb = rand() < 0.5 ? T.cells[cell].facets[Math.floor(rand() * 6)].neighbor : cell;
      const ub = [0, 1, 2].map(() => (2 * rand() - 1) * (s0 / 2));
      const qb = piece === "cube" && rand() < 0.8 ? randQuat(rand) : undefined;
      const at = (s: number): BoundaryPiece[] => {
        const A: BoundaryPiece = { cell, u: ua.map((x) => (x * s) / s0) };
        A.u[k] = (n[k] * s) / 2;
        if (qa) A.q = qa;
        const B: BoundaryPiece = { cell: cb, u: ub.map((x) => (x * s) / s0) };
        if (qb) B.q = qb;
        return [A, B];
      };
      const ok = (s: number) => validateBoundary(problem(piece, 2), { s, pieces: at(s) }).ok;
      let lo: number;
      let hi: number;
      if (ok(s0)) {
        let t = s0;
        while (t > 0.8 && ok(t)) t *= 0.97;
        if (t <= 0.8) continue;
        [lo, hi] = [t, t / 0.97];
      } else {
        let t = s0;
        while (t < 8 && !ok(t)) t *= 1.03;
        if (t >= 8) continue;
        [lo, hi] = [t / 1.03, t];
      }
      for (let j = 0; j < 45; j++) {
        const m = (lo + hi) / 2;
        if (ok(m)) hi = m;
        else lo = m;
      }
      thresholds++;
      for (const s of [hi * (1 + 3e-7), lo * (1 - 3e-7)]) {
        const [A, B] = at(s);
        const v1 = validateBoundary(problem(piece, 2), { s, pieces: [A, B] }).ok;
        const v2 = validateBoundary(problem(piece, 2), { s, pieces: [reanchor(piece, A, f, s), B] }).ok;
        expect(v2).toBe(v1);
      }
    }
    expect(thresholds).toBe(40);
  });

  it("two copies of one ridge-centred placement, anchored on opposite sides, overlap", () => {
    const rand = rng(31);
    for (let it = 0; it < 200; it++) {
      const piece: PieceName = it % 2 ? "cube" : "ball";
      const s = piece === "cube" ? 1.5 + 2 * rand() : 2.2 + 2 * rand();
      const cell = Math.floor(rand() * 8);
      const f = Math.floor(rand() * 6);
      const n = T.cells[cell].facets[f].inside.n;
      const k = n.findIndex((x) => x !== 0);
      const m = piece === "cube" ? 0.5 : 1;
      const u = [0, 1, 2].map(() => (2 * rand() - 1) * (s / 2 - m));
      u[k] = (n[k] * s) / 2;
      const A: BoundaryPiece = { cell, u };
      if (piece === "cube") A.q = randQuat(rand);
      const v = validateBoundary(problem(piece, 2), { s, pieces: [A, reanchor(piece, A, f, s)] });
      expect(v.ok).toBe(false);
      expect(v.reasons.join(" ")).toMatch(/overlap|edge of the tesseract/);
    }
  });

  it("parts of valid random rotated cubes near edges and vertices cover the cube exactly once (volume 1)", () => {
    const rand = rng(991);
    let n = 0;
    for (let it = 0; it < 20000 && n < 300; it++) {
      const s = 1 + 2 * rand() ** 2;
      const h = s / 2;
      const u = [0, 1, 2].map(() => (2 * rand() - 1) * h);
      const near = Math.floor(rand() * 4);
      for (let k = 0; k < near; k++) u[k] = (rand() < 0.5 ? -1 : 1) * (h - 0.9 * rand());
      const cfg = { s, pieces: [{ cell: Math.floor(rand() * 8), u, q: randQuat(rand) }] };
      if (!validateBoundary(problem("cube", 1), cfg).ok) continue;
      n++;
      const vol = pieceParts(T, "cube", cfg).reduce((a, part) => a + polyhedronVolume(partPolyhedron(T, part.cell, isoFromAffine(part.place), part.clip, s)), 0);
      expect(Math.abs(vol - 1)).toBeLessThan(1e-12);
    }
    expect(n).toBe(300);
  });

  it("ball overlaps of 5e-9 across a ridge are seen at every s up to MAX_S", () => {
    // MAX_S was lowered from 1e6 to 1e4 when the review's fixes landed: larger s is now rejected
    for (const s of [1e5, 1e6]) expect(validateBoundary(problem("ball", 2), { s, pieces: [{ cell: 0, u: [0, 0, 0] }, { cell: 1, u: [0, 0, 0] }] }).reasons.join(" ")).toMatch(/at most 10000/);
    for (const s of [3, 1e3, MAX_S]) {
      const h = s / 2;
      const over = validateBoundary(problem("ball", 2), { s, pieces: [{ cell: 0, u: [h - 1 + 2.5e-9, 0.3, -0.2] }, { cell: 3, u: [-h + 1, 0.3, -0.2] }] });
      expect(over.ok).toBe(false);
      const touch = validateBoundary(problem("ball", 2), { s, pieces: [{ cell: 0, u: [h - 1, 0.3, -0.2] }, { cell: 3, u: [-h + 1, 0.3, -0.2] }] });
      expect(touch.ok).toBe(true);
    }
  });

  it("a valid column of 1000 cubes is still fine (the quadratic sweep only bites at large P)", () => {
    const P = 1000;
    const s = P + 2;
    const h = s / 2;
    const pieces = Array.from({ length: P }, (_, k) => ({ cell: 0, u: [h, -h + 0.5 + k, 0] }));
    expect(validateBoundary(problem("cube", P), { s, pieces }).ok).toBe(true);
  });

  it("untrusted input: JSON forms, extremes and coincident pieces fail or pass cheaply", () => {
    const parse = (t: string) => JSON.parse(t) as unknown;
    // -0, extra fields, nested junk: accepted as the plain configuration
    expect(validateBoundary(problem("cube", 1), parse('{"s": 2, "pieces": [{"cell": -0, "u": [-0, 0, 0], "q": [1, -0, 0, 0], "extra": [[[[1]]]]}], "x": 1}')).ok).toBe(true);
    // 1e999 parses to Infinity
    expect(validateBoundary(problem("ball", 1), parse('{"s": 1e999, "pieces": [{"cell": 0, "u": [0, 0, 0]}]}')).ok).toBe(false);
    expect(validateBoundary(problem("ball", 1), parse('{"s": 3, "pieces": [{"cell": 0, "u": [1e999, 0, 0]}]}')).ok).toBe(false);
    // strings, nested arrays, near-zero quaternions, tiny s
    expect(validateBoundary(problem("ball", 1), parse('{"s": 3, "pieces": [{"cell": 0, "u": ["0", 0, 0]}]}')).ok).toBe(false);
    expect(validateBoundary(problem("ball", 1), parse('{"s": 3, "pieces": [{"cell": 0, "u": [[0], [0], [0]]}]}')).ok).toBe(false);
    expect(validateBoundary(problem("cube", 1), parse('{"s": 3, "pieces": [{"cell": 0, "u": [0, 0, 0], "q": [1e-300, 0, 0, 0]}]}')).ok).toBe(false);
    expect(validateBoundary(problem("cube", 1), { s: 5e-324, pieces: [{ cell: 0, u: [0, 0, 0] }] }).ok).toBe(false);
    // a huge list for a small P is rejected before it is read
    const t0 = performance.now();
    expect(validateBoundary(problem("ball", 3), { s: 3, pieces: new Array(1e6).fill({ cell: 0, u: [0, 0, 0] }) }).ok).toBe(false);
    // 9999 coincident pieces at the largest s (MAX_S, 1e4 since the review's fixes; it was 1e6)
    for (const piece of ["ball", "cube"] as const) {
      const v = validateBoundary(problem(piece, 9999), { s: MAX_S, pieces: Array.from({ length: 9999 }, () => ({ cell: 0, u: [0, 0, 0] })) });
      expect(v.ok).toBe(false);
      expect(v.reasons.length).toBe(20);
    }
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});
