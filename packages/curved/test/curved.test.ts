import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  extremePoints,
  enclosingCircle,
  enclosingPolygon,
  regularPolygonSeparation,
  circleSeparation,
  type Pose,
} from "@polypack/geometry";
import {
  allStates,
  apothemFromSide,
  compose,
  continueTo,
  diskPairRow,
  distance,
  expO,
  distanceFromO,
  makeSpace,
  pairGap,
  pieceExists,
  pieceGeometry,
  pieceState,
  polishAt,
  poseMotion,
  rimRow,
  sensitivity,
  sideFromApothem,
  solve,
  transvection,
  validate,
  vertexEdgeRow,
  wallRow,
  applyPoint,
  ORIGIN,
  type CurvedPose,
} from "../src/index";
import { multiplierRange, oneSidedSlopes } from "../src/sensitivity";
import { kPolish } from "../src/ideal";

const RECORDS = join(__dirname, "../../../data/records.json");

/** Pose (x, y, theta) of the motion G = T(c) R(theta) (inverse of poseMotion), for tests. */
function poseOfMotion(K: number, G: ReturnType<typeof poseMotion>): CurvedPose {
  const c = { e: G.b[0], x: G.b[1], y: G.b[2] };
  const D = distanceFromO(K, c);
  const s = Math.hypot(c.x, c.y);
  const x = s > 0 ? (D * c.x) / s : 0;
  const y = s > 0 ? (D * c.y) / s : 0;
  const R = compose(transvection(K, -x, -y), G);
  return { x, y, theta: Math.atan2(R.L[7], R.L[4]) };
}

describe("geometry", () => {
  it("unit pieces have side 1 at every curvature", () => {
    for (const K of [-4, -1, -1e-6, 0, 1e-6, 0.5, 1])
      for (const N of [3, 4, 5, 6]) {
        const sp = makeSpace(K, N, 4);
        for (let k = 0; k < N; k++) expect(distance(K, sp.vertices[k], sp.vertices[(k + 1) % N])).toBeCloseTo(1, 13);
      }
  });

  it("Gauss-Bonnet: area = (N alpha - (N-2) pi)/K", () => {
    for (const K of [-1, -0.3, 0.4, 1])
      for (const N of [3, 4, 5, 6]) {
        const g = pieceGeometry(N, K);
        expect(g.area).toBeCloseTo((N * g.alpha - (N - 2) * Math.PI) / K, 12);
      }
  });

  it("exponential coordinates: T(x, y) moves O by sqrt(x^2 + y^2)", () => {
    for (const K of [-1, 0, 1, 1e-9]) {
      expect(distanceFromO(K, expO(K, 0.3, -0.4))).toBeCloseTo(0.5, 14);
      expect(distanceFromO(K, applyPoint(poseMotion(K, 0.3, -0.4, 2), ORIGIN))).toBeCloseTo(0.5, 14);
    }
  });

  it("matches PolyPack's Euclidean separating-axis test at K = 0", () => {
    let seed = 5;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let it = 0; it < 500; it++) {
      const N = [0, 3, 4, 5, 6, 8][it % 6];
      const sp = makeSpace(0, N, 4);
      const a: Pose = { x: 2 * rnd() - 1, y: 2 * rnd() - 1, theta: 7 * rnd() };
      const b: Pose = { x: 2 * rnd() - 1, y: 2 * rnd() - 1, theta: 7 * rnd() };
      const [A, B] = allStates(sp, [a, b]);
      const ours = pairGap(sp, A, B).gap;
      const theirs = N === 0 ? circleSeparation(a, b).sep : regularPolygonSeparation(N, a, b).sep;
      expect(Math.abs(ours - theirs)).toBeLessThan(1e-12);
    }
  });

  it("analytic gradients agree with finite differences", () => {
    const h = 1e-6;
    for (const K of [-1, 0, 0.7])
      for (const N of [0, 4]) {
        const M = N === 0 ? 5 : 4;
        const sp = makeSpace(K, N, M);
        const a = { x: 0.21, y: -0.33, theta: 0.4 };
        const b = { x: -0.3, y: 0.25, theta: 1.9 };
        const rows = (A: CurvedPose, B: CurvedPose, t: number) => {
          const SA = pieceState(sp, A);
          const SB = pieceState(sp, B);
          return N === 0
            ? [diskPairRow(sp, SA, SB, 0, 1), wallRow(sp, SA, 0, -1, 1, t)]
            : [vertexEdgeRow(sp, SA, 1, SB, 2, 0, 1, 0), wallRow(sp, SA, 0, 2, 1, t), rimRow(sp, SA, 0, 1, t)];
        };
        const base = rows(a, b, 1.3);
        base.forEach((row, r) => {
          (["x", "y", "theta"] as const).forEach((k, idx) => {
            const ap = { ...a, [k]: a[k] + h };
            const am = { ...a, [k]: a[k] - h };
            expect(
              Math.abs((rows(ap, b, 1.3)[r].value - rows(am, b, 1.3)[r].value) / (2 * h) - row.gi[idx]),
            ).toBeLessThan(1e-7);
            if (row.j >= 0) {
              const bp = { ...b, [k]: b[k] + h };
              const bm = { ...b, [k]: b[k] - h };
              expect(
                Math.abs((rows(a, bp, 1.3)[r].value - rows(a, bm, 1.3)[r].value) / (2 * h) - row.gj[idx]),
              ).toBeLessThan(1e-7);
            }
          });
          expect(
            Math.abs((rows(a, b, 1.3 + h)[r].value - rows(a, b, 1.3 - h)[r].value) / (2 * h) - row.gt),
          ).toBeLessThan(1e-7);
        });
      }
  });
});

describe("validator adversarial cases", () => {
  const sqRho = (K: number) => pieceGeometry(4, K).rho;
  const facing = (K: number, a: number, shift = 0): CurvedPose[] => {
    const T = transvection(K, 0, shift);
    return [1, -1].map((sx) => poseOfMotion(K, compose(T, poseMotion(K, sx * a, 0, Math.PI / 4))));
  };

  it("rejects overlaps and protrusions beyond 1e-9", () => {
    for (const K of [-1, 0, 1]) {
      const rho = sqRho(K);
      expect(validate({ N: 4, M: 0, P: 2 }, K, { size: 1.4, pieces: facing(K, rho) }).valid).toBe(true);
      expect(validate({ N: 4, M: 0, P: 2 }, K, { size: 1.4, pieces: facing(K, rho - 2e-9) }).valid).toBe(false);
      const th = Math.PI / 4;
      expect(validate({ N: 4, M: 4, P: 1 }, K, { size: 1, pieces: [{ x: 0, y: 0, theta: th }] }).valid).toBe(true);
      expect(validate({ N: 4, M: 4, P: 1 }, K, { size: 1 - 1e-8, pieces: [{ x: 0, y: 0, theta: th }] }).valid).toBe(
        false,
      );
    }
  });

  it("tolerance trap: a real 1e-4 overlap 8 units from the centre is rejected", () => {
    const K = -1;
    const rho = sqRho(K);
    const bad = facing(K, rho - 0.5e-4, 8);
    expect(Math.hypot(bad[0].x, bad[0].y)).toBeGreaterThan(7.9);
    const vb = validate({ N: 4, M: 0, P: 2 }, K, { size: 10, pieces: bad });
    expect(vb.valid).toBe(false);
    // the facing edges are ultraparallel: 1e-4 apart on the axis, 1e-4 cosh(1/2) at the vertices
    expect(vb.minPairGap).toBeLessThan(-0.9e-4);
    expect(vb.minPairGap).toBeGreaterThan(-1.2e-4);
    const good = facing(K, rho + 0.5e-4, 8);
    const vg = validate({ N: 4, M: 0, P: 2 }, K, { size: 10, pieces: good });
    expect(vg.valid).toBe(true);
    expect(vg.minPairGap).toBeGreaterThan(0.9e-4);
  });

  it("unit polygons exist at K > 0 only for sqrt K < 2 pi / N (regression: K = 20 triangles)", () => {
    for (const [N, K] of [
      [3, 20],
      [3, 30],
      [3, 39],
      [3, 50],
      [4, 30],
      [6, 35],
    ] as const) {
      expect(pieceExists(N, K)).toBe(false);
      expect(validate({ N, M: 0, P: 1 }, K, { size: 0.25, pieces: [{ x: 0, y: 0, theta: 0 }] }).valid).toBe(false);
    }
    // just inside and just outside the limit sqrt K = 2 pi / N
    for (const N of [3, 4, 5, 6]) {
      const Kc = ((2 * Math.PI) / N) ** 2;
      expect(pieceExists(N, Kc * (1 - 1e-9))).toBe(true);
      expect(pieceExists(N, Kc * (1 + 1e-9))).toBe(false);
    }
  });

  it("rejects malformed input", () => {
    const ok = { size: 1.5, pieces: [{ x: 0, y: 0, theta: 0 }] };
    expect(validate({ N: 3, M: 3, P: 1 }, -1, ok).valid).toBe(true);
    expect(validate({ N: 3, M: 3, P: 2 }, -1, ok).valid).toBe(false);
    expect(validate({ N: 2, M: 3, P: 1 }, -1, ok).valid).toBe(false);
    expect(validate({ N: 3, M: 3, P: 1 }, NaN, ok).valid).toBe(false);
    expect(validate({ N: 3, M: 3, P: 1 }, -1, { size: NaN, pieces: ok.pieces }).valid).toBe(false);
    expect(validate({ N: 3, M: 3, P: 1 }, -1, { size: -1, pieces: ok.pieces }).valid).toBe(false);
    expect(validate({ N: 3, M: 3, P: 1 }, -1, { size: 1.5, pieces: [{ x: NaN, y: 0, theta: 0 }] }).valid).toBe(false);
    expect(validate({ N: 3, M: 3, P: 1 }, -1, { size: 1.5, pieces: [{ x: 0, y: Infinity, theta: 0 }] }).valid).toBe(
      false,
    );
    // no unit octagon on the unit sphere; containers stay in an open hemisphere
    expect(validate({ N: 8, M: 0, P: 1 }, 1, ok).valid).toBe(false);
    expect(validate({ N: 3, M: 4, P: 1 }, 1, { size: Math.PI / 2, pieces: ok.pieces }).valid).toBe(false);
    expect(validate({ N: 3, M: 0, P: 1 }, 1, { size: 1.6, pieces: ok.pieces }).valid).toBe(false);
  });
});

/** Euclidean records with stored poses, re-centred so that the container is at O with phi = 0. */
function euclideanCases(): { N: number; M: number; P: number; value: number; pieces: CurvedPose[] }[] {
  const recs = JSON.parse(readFileSync(RECORDS, "utf8")).records as {
    N: number;
    M: number;
    P: number;
    value: number;
    pieces?: Pose[];
    container_phi?: number;
  }[];
  const pick = [
    [4, 4, 5],
    [0, 0, 5],
    [3, 3, 5],
    [6, 6, 4],
    [0, 4, 6],
    [3, 4, 4],
    [4, 0, 3],
    [0, 6, 3],
  ];
  const out: { N: number; M: number; P: number; value: number; pieces: CurvedPose[] }[] = [];
  for (const [N, M, P] of pick) {
    const r = recs.find((q) => q.N === N && q.M === M && q.P === P && q.pieces && q.pieces.length === P);
    if (!r || !r.pieces) continue;
    const set = extremePoints(N, r.pieces);
    const c = M === 0 ? enclosingCircle(set) : enclosingPolygon(set, M, r.container_phi ?? 0);
    const phi = M === 0 ? 0 : c.phi;
    const co = Math.cos(-phi);
    const si = Math.sin(-phi);
    const pieces = r.pieces.map((p) => {
      const dx = p.x - c.cx;
      const dy = p.y - c.cy;
      return { x: co * dx - si * dy, y: si * dx + co * dy, theta: p.theta - phi };
    });
    // records store rounded values; use PolyPack's own enclosing size of the stored poses
    expect(Math.abs(c.size - r.value)).toBeLessThan(1e-3);
    out.push({ N, M, P, value: c.size, pieces });
  }
  return out;
}

describe("Euclidean limit", () => {
  const cases = euclideanCases();
  it("found the record fixtures", () => expect(cases.length).toBeGreaterThanOrEqual(6));

  it("K = 0 reproduces PolyPack's record sizes", () => {
    for (const c of cases) {
      const v = validate({ N: c.N, M: c.M, P: c.P }, 0, { size: c.value * (1 + 1e-6), pieces: c.pieces });
      expect(v.valid).toBe(true);
      expect(Math.abs(v.tightSize - c.value)).toBeLessThan(2e-6 * Math.max(1, c.value));
    }
  });

  it("K = +-1e-6 reproduces the Euclidean values to O(|K|)", () => {
    for (const c of cases) {
      const prob = { N: c.N, M: c.M, P: c.P };
      const s0 = polishAt(prob, 0, { size: c.value, pieces: c.pieces }).config.size;
      // polishing may tighten stored poses slightly (e.g. 1 + sqrt 3 for five triangles), never loosen them
      expect(s0).toBeLessThanOrEqual(c.value + 1e-12);
      expect(c.value - s0).toBeLessThan(1e-4);
      for (const K of [1e-6, -1e-6]) {
        const pc = polishAt(prob, K, { size: s0, pieces: c.pieces });
        expect(pc.validation.valid).toBe(true);
        expect(Math.abs(pc.config.size - s0)).toBeLessThan(10 * Math.abs(K) * Math.max(1, s0) ** 3);
      }
    }
  });
});

describe("solver", () => {
  it("is deterministic for a seed and finds 4 squares in a square of side 2 at K = 0", () => {
    const a = solve({ N: 4, M: 4, P: 4 }, 0, { seed: 11, restarts: 2, hops: 4 });
    const b = solve({ N: 4, M: 4, P: 4 }, 0, { seed: 11, restarts: 2, hops: 4 });
    expect(a.config!.size).toBe(b.config!.size);
    expect(a.config!.size).toBeCloseTo(2, 9);
    expect(a.validation!.valid).toBe(true);
  });

  it("hyperbolic disk rings: R = 1 + asinh(sinh 1 / sin(pi/P)) and dR/dK(0) = r0 (r0^2 - 1)/6", async () => {
    for (const P of [3, 4, 5]) {
      // the solves are long synchronous runs; let the test worker answer its runner between them
      await new Promise((resolve) => setImmediate(resolve));
      const r = solve({ N: 0, M: 0, P }, -1, { seed: 2, restarts: 2, hops: 4 });
      expect(r.config!.size).toBeCloseTo(1 + Math.asinh(Math.sinh(1) / Math.sin(Math.PI / P)), 9);
      await new Promise((resolve) => setImmediate(resolve));
      const e = solve({ N: 0, M: 0, P }, 0, { seed: 2, restarts: 2, hops: 4 });
      const r0 = e.config!.size - 1; // ring radius
      const s = sensitivity({ N: 0, M: 0, P }, 0, e.config!, e.polish);
      expect(s.dsdK).toBeCloseTo((r0 * (r0 * r0 - 1)) / 6, 5);
    }
  });

  it("multiplier range brackets the one-sided slopes of a degenerate record (4 hexagons)", () => {
    const prob = { N: 6, M: 6, P: 4 };
    const e = solve(prob, 0, { seed: 3, restarts: 2, hops: 6 });
    expect(e.config!.size).toBeCloseTo(7 / 3, 6);
    const rg = multiplierRange(prob, 0, e.config!, e.polish!);
    const d = 1e-4;
    const sp = polishAt(prob, d, e.config!).config.size;
    const sm = polishAt(prob, -d, e.config!).config.size;
    const right = (sp - e.config!.size) / d;
    const left = (e.config!.size - sm) / d;
    expect(right).toBeLessThanOrEqual(rg.max + 1e-2);
    expect(left).toBeGreaterThanOrEqual(rg.min - 1e-2);
  });

  it("continuation in K reports sizes, slopes and active-set changes", () => {
    const prob = { N: 0, M: 0, P: 4 };
    const e = solve(prob, 0, { seed: 2, restarts: 1, hops: 2 });
    const path = continueTo(prob, 0, -0.5, e.config!, 5);
    expect(path.length).toBe(6);
    for (const st of path) expect(st.feasible).toBe(true);
    for (let i = 1; i < path.length; i++) expect(path[i].size).toBeLessThan(path[i - 1].size);
    expect(Math.abs(path[1].predictionError)).toBeLessThan(1e-2);
  });

  it("container size and apothem round-trip", () => {
    for (const K of [-1, 0, 1])
      for (const M of [3, 4, 6, 8]) {
        const s = 0.7;
        expect(sideFromApothem(M, K, apothemFromSide(M, K, s))).toBeCloseTo(s, 13);
      }
  });
});

describe("scale-free ideal family", () => {
  it("a*(3,3,2): two triangles in the ideal triangle grow to side 1.06128 (K* = -1.12630)", () => {
    const r = solve({ N: 3, M: 3, P: 2 }, -1, { seed: 4, restarts: 2, hops: 4 });
    expect(r.config!.size).toBeCloseTo(3.5946997, 6);
    const a = kPolish(3, 3, r.config!.pieces, -1);
    expect(a.unbounded).toBe(false);
    expect(a.a).toBeCloseTo(1.061275, 5);
    expect(a.feasibility).toBeGreaterThan(-1e-10);
  });

  it("one-sided slopes are reported for a kinked record (6 disks, R = 3 at K = 0)", () => {
    const prob = { N: 0, M: 0, P: 6 };
    const e = solve(prob, 0, { seed: 5, restarts: 2, hops: 6 });
    expect(e.config!.size).toBeCloseTo(3, 8);
    const s = oneSidedSlopes(prob, 0, e.config!, 1e-3);
    expect(Number.isFinite(s.left) && Number.isFinite(s.right)).toBe(true);
  });
});
