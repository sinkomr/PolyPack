/**
 * The validator must never fail open (a pair is accepted only with a certificate), must bound its work, and the
 * max-margin LP fallback must agree with the Euclidean separation as documented (margin.ts).
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  HARD_MAX_PIECES,
  MAX_BALL_PIECES,
  MAX_PIECES_BY_DIM,
  POLYTOPE_CODES,
  cayleyMatrix,
  placeVertices,
  configErrors,
  gapAlong,
  getPolytope,
  loadPolytope,
  maxMarginSeparation,
  ndCheck,
  pairSeparation,
  penetrationDepth,
  closestPoints,
  polytopeInfo,
  signedSeparation,
  validateNd,
  validateNdAsync,
  pieceWallGap,
  type NdProblem,
} from "../src";

beforeAll(async () => {
  await loadPolytope("8:421");
});

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

const zero = (d: number): number[] => new Array(d + (d * (d - 1)) / 2).fill(0);
const ballOf = (code: string): NdProblem => ({ d: polytopeInfo(code).d, piece: code, container: "ball" });
const shifted = (code: string, o: number[]): Float64Array => {
  const P = getPolytope(code);
  const X = Float64Array.from(P.V);
  for (let v = 0; v < P.nV; v++) for (let i = 0; i < P.d; i++) X[v * P.d + i] += o[i];
  return X;
};

describe("coincident pieces are refused (EPA used to fail open on them)", () => {
  for (const code of POLYTOPE_CODES) {
    const d = polytopeInfo(code).d;
    it(`${code}: two and three identical poses overlap`, () => {
      const P = getPolytope(code);
      const r = signedSeparation(P.V, P.nV, P.V, P.nV, d);
      expect(r.sep).toBeLessThan(-0.05);
      expect(r.lower).toBeLessThanOrEqual(r.upper + 1e-9);
      const v = validateNd(ballOf(code), { s: 100, pieces: [zero(d), zero(d), zero(d)] });
      expect(v.valid).toBe(false);
      expect(v.reasons.join(" ")).toMatch(/overlap/);
      expect(v.minPairSep).toBeLessThan(-0.05);
    });
  }
  it("centrally symmetric polytopes: the depth of identical copies is twice the inradius, or bracketed when EPA stops early", () => {
    for (const code of ["5:cube", "6:ortho", "8:ortho", "10:cube", "6:demi", "8:demi", "10:demi", "7:321", "6:122"]) {
      const P = getPolytope(code);
      const r = signedSeparation(P.V, P.nV, P.V, P.nV, P.d);
      if (r.converged) expect(r.sep).toBeCloseTo(-2 * P.inradius, 8);
      expect(r.lower, code).toBeLessThanOrEqual(-2 * P.inradius + 1e-9);
      expect(r.upper, code).toBeGreaterThanOrEqual(-2 * P.inradius - 1e-9);
    }
  });
});

describe("aligned copies shifted along a body axis or the diagonal", () => {
  // for centrally symmetric polytopes A - A' = 2A - o, so the depth is min_f (2 b_f - N_f . o) exactly
  const symmetric = [
    "4:cube",
    "4:ortho",
    "4:24cell",
    "5:cube",
    "5:ortho",
    "6:cube",
    "6:ortho",
    "6:demi",
    "8:ortho",
    "8:demi",
    "10:ortho",
    "10:demi",
  ];
  for (const code of symmetric) {
    const P = getPolytope(code);
    const d = P.d;
    it(`${code}: the depth is min_f (2 b_f - N_f . o), and the validator follows it at tolerance 1e-9`, () => {
      for (const x of [0, 0.05, 0.2, 0.5, 0.9]) {
        for (const axis of ["e0", "diag"]) {
          const o = new Array<number>(d).fill(0);
          if (axis === "e0") o[0] = x;
          else for (let i = 0; i < d; i++) o[i] = x / Math.sqrt(d);
          let depth = Infinity;
          for (let f = 0; f < P.nF; f++) {
            let nf = 0;
            for (let i = 0; i < d; i++) nf += P.N[f * d + i] * o[i];
            depth = Math.min(depth, 2 * P.b[f] - nf);
          }
          const pose = zero(d);
          for (let i = 0; i < d; i++) pose[i] = o[i];
          const v = validateNd(ballOf(code), { s: 100, pieces: [zero(d), pose] });
          if (depth > 2e-9) expect(v.valid, `${code} ${x} ${axis}`).toBe(false);
          if (depth < 0) expect(v.valid, `${code} ${x} ${axis}`).toBe(true);
          if (depth > 1e-6) {
            const r = signedSeparation(P.V, P.nV, shifted(code, o), P.nV, d);
            if (r.converged) expect(Math.abs(r.sep + depth), `${code} ${x} ${axis}`).toBeLessThan(1e-8);
            expect(r.lower, `${code} ${x} ${axis}`).toBeLessThanOrEqual(-depth + 1e-9);
            expect(r.upper, `${code} ${x} ${axis}`).toBeGreaterThanOrEqual(-depth - 1e-9);
          }
        }
      }
    });
  }
  it("the same random rotation with an offset in the rotated frame (the review's symmetric corpus): verdicts follow the exact depth", () => {
    const rng = mulberry32(21);
    for (const code of [
      "4:cube",
      "4:ortho",
      "4:120cell",
      "5:ortho",
      "6:122",
      "7:ortho",
      "8:cube",
      "8:demi",
      "9:ortho",
      "10:cube",
    ]) {
      const P = getPolytope(code);
      const d = P.d;
      const prob = ballOf(code);
      for (const delta of [1e-13, 1e-10, 1e-8, 1e-5, 1e-2, 0.2]) {
        const k = Array.from({ length: (d * (d - 1)) / 2 }, () => (rng() - 0.5) * 3);
        const R = cayleyMatrix(k, d, 0);
        const u = Array.from({ length: d }, () => rng() - 0.5);
        const un = Math.hypot(...u);
        // the offset o along u that makes the depth exactly delta: depth(lam u) = min_f (2 b_f - lam N_f.u)
        let lam = Infinity;
        for (let f = 0; f < P.nF; f++) {
          let nu = 0;
          for (let i = 0; i < d; i++) nu += (P.N[f * d + i] * u[i]) / un;
          if (nu > 1e-12) lam = Math.min(lam, (2 * P.b[f] - delta) / nu);
        }
        const o = u.map((v) => (v / un) * lam);
        let depth = Infinity;
        for (let f = 0; f < P.nF; f++) {
          let nf = 0;
          for (let i = 0; i < d; i++) nf += P.N[f * d + i] * o[i];
          depth = Math.min(depth, 2 * P.b[f] - nf);
        }
        const t = Array.from({ length: d }, (_, i) => o.reduce((acc, oj, j) => acc + R[i * d + j] * oj, 0));
        const v = validateNd(prob, {
          s: 1e3,
          pieces: [
            [...zero(d).slice(0, d), ...k, 0],
            [...t, ...k, 0],
          ],
        });
        if (depth > 2e-9) expect(v.valid, `${code} ${delta}`).toBe(false);
        if (depth < 5e-10) expect(v.valid, `${code} ${delta}`).toBe(true);
      }
    }
  });
  it("simplices: small shifts are refused, a far diagonal shift is accepted (LP margin 0.15 in 4D, 0.75 in 10D)", () => {
    for (const [d, x, ok] of [
      [4, 0.05, false],
      [4, 0.9, true],
      [8, 0.2, false],
      [10, 0.05, false],
      [10, 0.9, true],
    ] as const) {
      const code = `${d}:simplex`;
      const pose = zero(d);
      for (let i = 0; i < d; i++) pose[i] = x / Math.sqrt(d);
      expect(validateNd(ballOf(code), { s: 100, pieces: [zero(d), pose] }).valid, `${code} ${x}`).toBe(ok);
    }
  });
  it("the starting simplex of EPA is built whatever the ties: EPA makes progress on aligned and coincident hulls, and says when it stops early", () => {
    for (const code of ["5:demi", "6:ortho", "8:simplex", "10:demi", "4:24cell", "9:cube", "10:ortho"]) {
      const P = getPolytope(code);
      const c = closestPoints(P.V, P.nV, P.V, P.nV, P.d);
      const e = penetrationDepth(P.V, P.nV, P.V, P.nV, P.d, c.corral);
      expect(e.depth, code).toBeGreaterThan(0.05); // used to be 0 with converged = false
      expect(e.normal, code).not.toBeNull();
    }
    for (const code of ["5:demi", "6:ortho", "4:24cell"]) {
      const P = getPolytope(code);
      const c = closestPoints(P.V, P.nV, P.V, P.nV, P.d);
      expect(penetrationDepth(P.V, P.nV, P.V, P.nV, P.d, c.corral).converged, code).toBe(true);
    }
  });
});

describe("the max-margin LP fallback (margin.ts)", () => {
  const cube = (d: number, o: number[]) => shifted(`${d}:cube`, o);
  it("brackets the Euclidean separation of axis-aligned cubes (closed forms), 4D to 10D", () => {
    for (const d of [4, 5, 7, 10]) {
      const rng = mulberry32(d);
      const n = 2 ** d;
      const A = cube(d, new Array(d).fill(0));
      for (let t = 0; t < 6; t++) {
        const o = Array.from({ length: d }, () => (rng() - 0.5) * 2.6);
        const m = Math.max(...o.map(Math.abs));
        const sep = m > 1 ? Math.hypot(...o.map((v) => Math.max(0, Math.abs(v) - 1))) : -(1 - m);
        const r = maxMarginSeparation(A, n, cube(d, o), n, d);
        expect(r.conclusive, `${d}D ${t}`).toBe(true);
        expect(r.lower).toBeLessThanOrEqual(sep + 1e-9);
        expect(r.upper).toBeGreaterThanOrEqual(sep - 1e-9);
        // the factor sqrt(d) between the box margin and the Euclidean one
        if (sep > 0) expect(r.lower).toBeGreaterThan(sep / Math.sqrt(d) - 1e-9);
        else expect(r.lower).toBeGreaterThan(sep * Math.sqrt(d) - 1e-9);
      }
    }
  });
  it("brackets the separation of random rotated pairs of other polytopes (against GJK / EPA)", () => {
    const rng = mulberry32(5);
    for (const code of ["4:24cell", "5:demi", "6:122", "7:ortho", "8:simplex", "4:120cell"]) {
      const P = getPolytope(code);
      const d = P.d;
      for (let t = 0; t < 4; t++) {
        const pose = Array.from({ length: d }, () => (rng() - 0.5) * 2 * P.circumradius);
        const Q = Array.from({ length: (d * (d - 1)) / 2 }, () => (rng() - 0.5) * 3);
        // B is the polytope under a rotation, placed through the validator's own pose code
        const prob = ballOf(code);
        const sepRef = pairSeparation(prob, zero(d), [...pose, ...Q]);
        const B = placed(code, [...pose, ...Q]);
        const r = maxMarginSeparation(P.V, P.nV, B, P.nV, d);
        expect(r.lower, `${code} ${t}`).toBeLessThanOrEqual(sepRef + 1e-9);
        expect(r.upper, `${code} ${t}`).toBeGreaterThanOrEqual(sepRef - 1e-9);
      }
    }
  });
  function placed(code: string, pose: number[]): Float64Array {
    const P = getPolytope(code);
    const d = P.d;
    const R = cayleyMatrix(pose.slice(d, d + (d * (d - 1)) / 2), d, 0);
    return placeVertices(P.V, P.nV, d, Float64Array.from(pose.slice(0, d)), R);
  }
  it("accepts touching pieces: face to face, shifted face to face, and a sliver of overlap within the tolerance", () => {
    const d = 6;
    const n = 64;
    const A = cube(d, new Array(d).fill(0));
    for (const o of [
      [1, 0, 0, 0, 0, 0],
      [1, 0.3, -0.7, 0.9, 0, 0.5],
      [-0.2, 0, 1, 0.4, 0.4, 0],
    ]) {
      const r = maxMarginSeparation(A, n, cube(d, o), n, d, { acceptAt: -1e-12 });
      expect(r.verdict).toBe("separated");
      expect(r.lower).toBeGreaterThanOrEqual(-1e-12);
    }
    const sliver = maxMarginSeparation(A, n, cube(d, [1 - 5e-10, 0.2, 0, 0, 0, 0]), n, d, { acceptAt: -1e-9 });
    expect(sliver.verdict).toBe("separated");
    const P = getPolytope("4:24cell");
    const B = Float64Array.from(P.V);
    for (let v = 0; v < P.nV; v++) for (let i = 0; i < 4; i++) B[v * 4 + i] += 2 * P.b[0] * P.N[i];
    expect(maxMarginSeparation(P.V, P.nV, B, P.nV, 4, { acceptAt: -1e-9 }).verdict).toBe("separated");
  });
  it("refuses overlaps by more than the tolerance (the box margin below -sqrt(d) tol), and says 'open' in the band", () => {
    const d = 6;
    const n = 64;
    const tol = 1e-9;
    const A = cube(d, new Array(d).fill(0));
    const opts = { acceptAt: -tol, refuseBelow: -Math.sqrt(d) * tol };
    for (const depth of [1e-6, 1e-4, 0.1, 0.9]) {
      const r = maxMarginSeparation(A, n, cube(d, [1 - depth, 0.1, 0, 0.2, 0, 0]), n, d, opts);
      expect(r.verdict, `depth ${depth}`).toBe("overlapping");
      expect(r.upper).toBeLessThan(-tol);
    }
    // an overlap of 1.5e-9 lies in the band between tol and sqrt(d) tol: neither accepted nor proved a refusal
    const band = maxMarginSeparation(A, n, cube(d, [1 - 1.5e-9, 0, 0, 0, 0, 0]), n, d, opts);
    expect(band.verdict).toBe("open");
    // never accepted anywhere in the band
    expect(band.lower).toBeLessThan(-tol);
  });
  it("is open (not conclusive) when its caps stop it, and never invents a certificate", () => {
    const d = 8;
    const P = getPolytope("8:cube");
    const B = shifted("8:cube", [0.9, 0.3, 0.2, 0.1, 0, 0, 0, 0]);
    const r = maxMarginSeparation(P.V, P.nV, B, P.nV, d, { acceptAt: -1e-9, maxCuts: 12, maxRounds: 2 });
    expect(r.verdict).toBe("open");
    expect(r.conclusive).toBe(false);
    expect(r.upper).toBe(Infinity);
    expect(r.lower).toBeLessThanOrEqual(-0.1 + 1e-9); // the true separation is -0.1
    if (r.dir) expect(gapAlong(P.V, P.nV, B, P.nV, d, r.dir)).toBeCloseTo(r.lower, 12);
  });
});

describe("size limits are enforced before any work", () => {
  const cubes = (d: number, n: number): number[][] => Array.from({ length: n }, (_, i) => [i * 3, ...zero(d).slice(1)]);
  it("P is capped by dimension, and the cap can be raised by trusted callers up to a hard ceiling", () => {
    for (const [d, cap] of Object.entries(MAX_PIECES_BY_DIM)) {
      const prob: NdProblem = { d: Number(d), piece: `${d}:cube`, container: `${d}:cube` };
      expect(configErrors(prob, { s: 1e4, pieces: cubes(Number(d), cap) })).toEqual([]);
      expect(configErrors(prob, { s: 1e4, pieces: cubes(Number(d), cap + 1) }).join()).toMatch(/at most \d+ pieces/);
    }
    const prob: NdProblem = { d: 4, piece: "4:cube", container: "4:cube" };
    expect(configErrors(prob, { s: 1e4, pieces: cubes(4, 81) }, 20, { maxPieces: 100 })).toEqual([]);
    expect(
      configErrors(prob, { s: 1e4, pieces: cubes(4, HARD_MAX_PIECES + 1) }, 20, { maxPieces: 1e9 }).join(),
    ).toMatch(/at most 256 pieces/);
  });
  it("8000 10D cubes and 300 8:421 are refused at once (they took 784 MB and 40 s)", () => {
    const t0 = performance.now();
    const big = validateNd({ d: 10, piece: "10:cube", container: "ball" }, { s: 1e5, pieces: cubes(10, 8000) });
    const g = validateNd({ d: 8, piece: "8:421", container: "8:421" }, { s: 30, pieces: cubes(8, 300) });
    expect(big.valid).toBe(false);
    expect(g.valid).toBe(false);
    expect(big.reasons[0]).toMatch(/at most 20 pieces/);
    expect(performance.now() - t0).toBeLessThan(200);
  });
  it("balls are allowed more pieces, with a pair sweep that costs nothing for far pairs", () => {
    const d = 10;
    const pieces = Array.from({ length: MAX_BALL_PIECES }, (_, i) => [i * 2, ...new Array(d - 1).fill(0)]);
    const t0 = performance.now();
    const v = validateNd({ d, piece: "ball", container: "ball" }, { s: 4 * MAX_BALL_PIECES, pieces });
    expect(v.valid).toBe(true);
    expect(performance.now() - t0).toBeLessThan(300);
    expect(
      validateNd({ d, piece: "ball", container: "ball" }, { s: 1e4, pieces: [...pieces, pieces[0]] }).reasons[0],
    ).toMatch(/at most 400 pieces/);
  });
  it("the work caps count P nV d and P nV nF", () => {
    // 20 pieces of 1024 vertices in 10D are 204,800 numbers: fine; a raised piece cap with 10:cube hits the vertex work cap
    const prob: NdProblem = { d: 10, piece: "10:cube", container: "ball" };
    expect(configErrors(prob, { s: 1e5, pieces: cubes(10, 20) })).toEqual([]);
    expect(configErrors(prob, { s: 1e5, pieces: cubes(10, 60) }, 20, { maxPieces: 100 }).join()).toMatch(/work limit/);
  });
});

describe("stops early and sweeps pairs", () => {
  it("ends after maxPairErrors refused pairs (the default is 3) and reports the work done", () => {
    const d = 8;
    const pieces = Array.from({ length: 12 }, () => zero(d));
    const prob = ballOf("8:421");
    const v = validateNd(prob, { s: 100, pieces });
    expect(v.valid).toBe(false);
    expect(v.reasons.length).toBe(3);
    expect(v.pairsTested).toBeLessThanOrEqual(3);
    const one = validateNd(prob, { s: 100, pieces }, { maxPairErrors: 1 });
    expect(one.reasons.length).toBe(1);
  });
  it("finds the same overlapping pairs as an all-pairs scan", () => {
    const d = 5;
    const rng = mulberry32(3);
    const pieces = Array.from({ length: 300 }, () => Array.from({ length: d }, () => rng() * 4));
    const prob: NdProblem = { d, piece: "ball", container: "ball" };
    const v = validateNd(prob, { s: 100, pieces }, { maxErrors: 1e6, maxPairErrors: 1e6 });
    const expected: string[] = [];
    for (let i = 0; i < pieces.length; i++)
      for (let j = i + 1; j < pieces.length; j++)
        if (pairSeparation(prob, pieces[i], pieces[j]) < -1e-9) expected.push(`${i},${j}`);
    const got = v.reasons.map((r) => /pieces (\d+) and (\d+)/.exec(r)!.slice(1, 3).join(",")).sort();
    expect(got).toEqual(expected.sort());
    expect(expected.length).toBeGreaterThan(20);
  });
  it("the wall prefilter keeps every verdict and never reports a gap above the true one", () => {
    const d = 5;
    const rng = mulberry32(8);
    const prob: NdProblem = { d, piece: "5:cube", container: "5:ortho" };
    const s = 6;
    for (let rep = 0; rep < 12; rep++) {
      const pieces = Array.from({ length: 6 }, () => [
        ...Array.from({ length: d }, () => (rng() - 0.5) * 4),
        ...Array.from({ length: 10 }, () => (rng() - 0.5) * 2),
      ]);
      const v = validateNd(prob, { s, pieces }, { maxPairErrors: 1e6, maxErrors: 1e6 });
      const exact = Math.min(...pieces.map((p) => pieceWallGap(prob, s, p)));
      expect(v.minWallGap).toBeLessThanOrEqual(exact + 1e-12);
      const wallErrors = v.reasons.filter((r) => /sticks out/.test(r)).length;
      expect(wallErrors).toBe(pieces.filter((p) => pieceWallGap(prob, s, p) < -1e-9).length);
    }
  });
});

describe("slices and a deadline", () => {
  it("validateNdAsync gives the verdict of validateNd, in slices", async () => {
    const d = 6;
    const rng = mulberry32(2);
    const prob = ballOf("6:cube");
    const pieces = Array.from({ length: 24 }, () => [
      ...Array.from({ length: d }, () => (rng() - 0.5) * 5),
      ...Array.from({ length: 15 }, () => (rng() - 0.5) * 2),
    ]);
    const a = await validateNdAsync(prob, { s: 30, pieces }, { sliceMs: 0 });
    const b = validateNd(prob, { s: 30, pieces });
    expect(a.valid).toBe(b.valid);
    expect(a.reasons).toEqual(b.reasons);
    expect(a.slices).toBeGreaterThan(1);
  });
  it("ndCheck yields between pieces and pairs, and a deadline stops the check as invalid", () => {
    const d = 4;
    const prob = ballOf("4:cube");
    const pieces = Array.from({ length: 6 }, (_, i) => [i * 1.5, ...zero(d).slice(1)]);
    let yields = 0;
    const steps = ndCheck(prob, { s: 30, pieces });
    for (;;) {
      const r = steps.next();
      if (r.done) {
        expect(r.value.valid).toBe(true);
        break;
      }
      yields++;
    }
    expect(yields).toBeGreaterThanOrEqual(pieces.length);
    const late = validateNd(prob, { s: 30, pieces }, { deadline: performance.now() - 1 });
    expect(late.valid).toBe(false);
    expect(late.reasons.join()).toMatch(/time budget/);
  });
});
