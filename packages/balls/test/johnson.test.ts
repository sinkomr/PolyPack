/**
 * The balls space with the 92 Johnson solids: test packings (python/balls/fixtures/johnson_packings.json, made by
 * scripts/gen-johnson-packings.ts and certified exactly by python/balls/test_johnson_balls.py) against the float
 * validator, adversarial variants, the catalogue's order and ids, and the bounds, which rest on the Chebyshev and
 * enclosing radii (extent.ts) because a Johnson solid's vertex centroid is not the centre of its largest inscribed ball
 * or its smallest enclosing ball. Test packings only, no search for good ones.
 */
import { readFileSync } from "node:fs";
import { JOHNSON_SOLID_NAMES, getSolid } from "@polypack/polyhedra";
import { SOLID_NAMES_LIST } from "@polypack/polyhedra/catalogue";
import { checkKernel } from "@polypack/methods/contract";
import { describe, expect, it } from "vitest";
import { BALLS_CODES, BALLS_ORIGINAL_CODES, BALL_RADIUS, ballsProblemOf } from "../src/catalogue";
import { containerOf } from "../src/container";
import { chebyshevOf, chebyshevRadius, enclosingOf, enclosingRadius } from "../src/extent";
import { ballsBound } from "../src/problems";
import { ballsKernel } from "../src/kernel";
import { validateBalls } from "../src/validate";

interface Case {
  code: string;
  P: number;
  s: number;
  pieces: number[][];
  minWallGap: number;
  overlap: { s: number; pieces: number[][]; pair: [number, number]; depth: number };
  protrusion: { pieces: number[][]; piece: number; depth: number };
}
const fixture = JSON.parse(readFileSync(new URL("../../../python/balls/fixtures/johnson_packings.json", import.meta.url), "utf8")) as {
  cases: Case[];
};
const problem = (code: string) => ballsProblemOf(code)!;

describe("test packings with Johnson solids in the balls space", () => {
  it("are 12: balls in three Johnson solids and three Johnson solids in a ball, valid at tolerance 0", () => {
    expect(fixture.cases).toHaveLength(12);
    expect(new Set(fixture.cases.map((c) => c.code)).size).toBe(6);
    for (const c of fixture.cases) {
      const v = validateBalls(problem(c.code), { s: c.s, pieces: c.pieces }, { tol: 0 });
      expect(v.valid, c.code).toBe(true);
      expect(v.minWallGap, c.code).toBe(c.minWallGap);
      // a bound is never above a valid packing
      expect(c.s, c.code).toBeGreaterThanOrEqual(ballsBound(problem(c.code), c.P).value * (1 - 1e-12));
    }
  });

  it("refuse a piece that overlaps a neighbour or sticks out of the container by 1e-9", () => {
    for (const c of fixture.cases) {
      const pb = problem(c.code);
      expect(c.overlap.depth, c.code).toBeGreaterThanOrEqual(1e-9 * (1 - 1e-6));
      expect(c.overlap.depth, c.code).toBeLessThan(1.001e-9);
      const o = validateBalls(pb, { s: c.overlap.s, pieces: c.overlap.pieces }, { tol: 0 });
      expect(o.valid, c.code).toBe(false);
      expect(o.errors.join(), c.code).toMatch(/overlap/);
      expect(validateBalls(pb, { s: c.overlap.s, pieces: c.overlap.pieces }, { tol: 1e-11 }).valid, c.code).toBe(false);
      expect(c.protrusion.depth, c.code).toBeGreaterThanOrEqual(1e-9 * (1 - 1e-6));
      expect(c.protrusion.depth, c.code).toBeLessThan(1.001e-9);
      const w = validateBalls(pb, { s: c.s, pieces: c.protrusion.pieces }, { tol: 0 });
      expect(w.valid, c.code).toBe(false);
      expect(w.errors.join(), c.code).toMatch(new RegExp(`piece ${c.protrusion.piece} sticks out`));
      expect(validateBalls(pb, { s: c.s, pieces: c.protrusion.pieces }, { tol: 1e-11 }).valid, c.code).toBe(false);
    }
  });

  it("read a solid's quaternion of any norm as its rotation", () => {
    for (const c of fixture.cases.filter((x) => x.code.endsWith("inball"))) {
      const scaled = c.pieces.map((p) => [p[0], p[1], p[2], p[3] * 3, p[4] * 3, p[5] * 3, p[6] * 3]);
      const v = validateBalls(problem(c.code), { s: c.s, pieces: scaled }, { tol: 0 });
      expect(v.valid, c.code).toBe(true);
      expect(Math.abs(v.minWallGap - c.minWallGap), c.code).toBeLessThan(1e-12);
    }
  });
});

describe("the catalogue with the Johnson solids", () => {
  it("has 373 codes, the first 7 and every earlier id unchanged, and the Johnson codes after the other balls-in-solid ones", () => {
    expect(BALLS_CODES).toHaveLength(373);
    expect(BALLS_ORIGINAL_CODES.every((c) => BALLS_CODES.includes(c))).toBe(true);
    // the earlier 189 codes are all there, and the Johnson ones come after them in each block (balls in a solid, then solids in a ball)
    const earlier = SOLID_NAMES_LIST.slice(0, 94);
    const old = new Set(["ballinball", ...earlier.map((s) => `ballin${s.code}`), ...earlier.map((s) => `${s.code}inball`)]);
    expect(old.size).toBe(189);
    const plain = BALLS_CODES.filter((c) => !/j\d\d/.test(c) || c === "ballinball");
    expect(new Set(plain)).toEqual(old);
    expect(plain).toHaveLength(189);
    expect(BALLS_CODES.indexOf("ballinball")).toBe(0);
    // balls in a Johnson solid come after the trapezohedra, in Johnson's order, then the solids in a ball
    const j = SOLID_NAMES_LIST.slice(94);
    expect(BALLS_CODES.slice(1 + 94, 1 + 186)).toEqual(j.map((s) => `ballin${s.code}`));
    expect(BALLS_CODES.slice(-92)).toEqual(j.map((s) => `${s.code}inball`));
    expect(problem("ballinj12")).toMatchObject({ piece: "ball", container: "triangular_bipyramid", title: "Balls in a J12 triangular bipyramid", group: "Balls in a Johnson solid" });
    expect(problem("j92inball")).toMatchObject({ piece: "triangular_hebesphenorotunda", container: "ball", group: "Johnson solids in a ball" });
  });
});

describe("the radii of the best centre", () => {
  /** The smallest ball holding the points, by brute force over the balls through 2, 3 or 4 of them. */
  function bruteEnclosing(V: ArrayLike<number>): number {
    const pts: number[][] = [];
    for (let i = 0; i < V.length; i += 3) pts.push([V[i], V[i + 1], V[i + 2]]);
    const n = pts.length;
    let best = Infinity;
    const holds = (c: number[], r: number) => pts.every((p) => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) <= r * (1 + 1e-12));
    const through = (idx: number[]) => {
      // the centre in the span of the points' differences, equidistant from them (the smallest such ball)
      const a = pts[idx[0]];
      const u = idx.slice(1).map((i) => [pts[i][0] - a[0], pts[i][1] - a[1], pts[i][2] - a[2]]);
      const m = u.length;
      const G = u.map((p) => u.map((q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2]));
      const y = u.map((p) => (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]) / 2);
      // Cramer / elimination for m <= 3
      const t = gauss(G, y);
      if (!t) return;
      const c = [0, 1, 2].map((k) => a[k] + u.reduce((s, row, i) => s + t[i] * row[k], 0));
      const r = Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]);
      if (r < best && holds(c, r)) best = r;
      void m;
    };
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        through([i, j]);
        for (let k = j + 1; k < n; k++) {
          through([i, j, k]);
          for (let l = k + 1; l < n; l++) through([i, j, k, l]);
        }
      }
    return best;
  }
  function gauss(A: number[][], y: number[]): number[] | null {
    const n = y.length;
    const M = A.map((r, i) => [...r, y[i]]);
    for (let i = 0; i < n; i++) {
      let p = i;
      for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
      if (Math.abs(M[p][i]) < 1e-10) return null;
      [M[i], M[p]] = [M[p], M[i]];
      for (let r = 0; r < n; r++) {
        if (r === i) continue;
        const f = M[r][i] / M[i][i];
        for (let j = i; j <= n; j++) M[r][j] -= f * M[i][j];
      }
    }
    return M.map((r, i) => r[n] / r[i]);
  }
  /** The largest ball in the solid, by brute force over the vertices of the (x, r) polyhedron: four tight faces. */
  function bruteChebyshev(N: ArrayLike<number>, b: ArrayLike<number>): number {
    const F = b.length;
    let best = -Infinity;
    for (let i = 0; i < F; i++)
      for (let j = i + 1; j < F; j++)
        for (let k = j + 1; k < F; k++)
          for (let l = k + 1; l < F; l++) {
            const rows = [i, j, k, l];
            const A = rows.map((f) => [N[3 * f], N[3 * f + 1], N[3 * f + 2], 1]);
            const sol = gauss(A, rows.map((f) => b[f]));
            if (!sol) continue;
            let ok = true;
            for (let f = 0; f < F && ok; f++) ok = N[3 * f] * sol[0] + N[3 * f + 1] * sol[1] + N[3 * f + 2] * sol[2] + sol[3] <= b[f] + 1e-12;
            if (ok && sol[3] > best) best = sol[3];
          }
    return best;
  }

  it("agree with brute force on the small Johnson solids", () => {
    for (const n of [1, 2, 3, 12, 13, 17, 49, 50, 51, 62, 63, 84, 85, 86, 87, 91]) {
      const S = getSolid(JOHNSON_SOLID_NAMES[n - 1]);
      if (S.nv > 14 || S.offsets.length > 24) continue;
      expect(Math.abs(enclosingOf(S.V) - bruteEnclosing(S.V)), S.name).toBeLessThan(1e-9);
      expect(Math.abs(chebyshevOf(S.N, S.offsets) - bruteChebyshev(S.N, S.offsets)), S.name).toBeLessThan(1e-9);
    }
  });

  it("are the centroid's inradius and circumradius for the first 94 solids, and bound a square pyramid as known", () => {
    for (const s of SOLID_NAMES_LIST.slice(0, 94)) {
      const S = getSolid(s.name);
      expect(chebyshevRadius(S), s.name).toBe(S.inradius);
      expect(enclosingRadius(S), s.name).toBe(S.circumradius);
    }
    // J1, edge 1: the base's circumscribed ball has radius sqrt 2 / 2 and contains the apex (height sqrt 2 / 2); the largest
    // inscribed ball touches the base and the four sides, radius 0.2588190451 (the incircle of the cross-section through
    // the apex and the midpoints of two opposite base edges)
    const sq = getSolid("square_pyramid");
    expect(enclosingRadius(sq)).toBeCloseTo(Math.SQRT1_2, 8);
    expect(enclosingRadius(sq)).toBeLessThan(sq.circumradius);
    expect(chebyshevRadius(sq)).toBeGreaterThan(sq.inradius);
    expect(chebyshevRadius(sq)).toBeCloseTo(0.2588190451, 6);
  });

  it("never exceed what the centroid gives, for any Johnson solid, and bound from below as stated", () => {
    for (const name of JOHNSON_SOLID_NAMES) {
      const S = getSolid(name);
      const C = containerOf(name);
      expect(C.chebyshev, name).toBeGreaterThanOrEqual(S.inradius);
      expect(C.enclosing, name).toBeLessThanOrEqual(S.circumradius);
      // the one-piece bounds: the ball needs s >= r / chebyshev; the solid needs a ball of diameter 2 * enclosing
      const ballIn = ballsBound(problem(`ballin${S.code}`), 2);
      expect(ballIn.value, name).toBeGreaterThanOrEqual(BALL_RADIUS / C.chebyshev - 1e-12);
      const inBall = ballsBound(problem(`${S.code}inball`), 2);
      expect(inBall.value, name).toBeGreaterThanOrEqual(2 * C.enclosing - 1e-12);
      const centred = validateBalls(problem(`ballin${S.code}`), { s: (BALL_RADIUS / S.inradius) * (1 + 1e-9), pieces: [[0, 0, 0]] }, { tol: 0 });
      expect(centred.valid, name).toBe(true);
    }
  });
});

describe("the kernel with Johnson solids", () => {
  for (const code of ["ballinj01", "ballinj06", "ballinj44", "ballinj92", "j01inball", "j44inball", "j72inball", "j92inball"])
    it(`passes the kernel contract: ${code}, P = 3`, () => {
      expect(checkKernel(() => ballsKernel({ code, P: 3 }), { seed: 3, states: 3 }), code).toEqual([]);
    });
});
