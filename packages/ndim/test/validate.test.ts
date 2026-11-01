import { beforeAll, describe, expect, it } from "vitest";
import {
  NDIM_TOL,
  pairSeparation,
  pieceWallGap,
  cayleyMatrix,
  configErrors,
  getPolytope,
  inradiusBound,
  loadPolytope,
  lowerBound,
  maxPiecesByVolume,
  nParams,
  placeVertices,
  signedSeparation,
  tightScale,
  validateNd,
  volumeBound,
  ballVolume,
  unitVolume,
  type NdProblem,
} from "../src";

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

const zeros = (d: number): number[] => new Array(nParams(d)).fill(0);
const cubeProblem = (d: number): NdProblem => ({ d, piece: `${d}:cube`, container: `${d}:cube` });

beforeAll(async () => {
  await loadPolytope("8:421");
});

describe("validateNd", () => {
  it("accepts a tight packing and returns its score", () => {
    const d = 4;
    const g = 1e-7;
    const pieces = [];
    for (const a of [-0.5, 0.5])
      for (const b of [-0.5, 0.5])
        for (const c of [-0.5, 0.5])
          for (const e of [-0.5, 0.5]) pieces.push([a * (1 + g), b * (1 + g), c * (1 + g), e * (1 + g), ...zeros(d)]);
    const s = 2 + 3 * g;
    const r = validateNd(cubeProblem(d), { s, pieces }, { tol: 0 });
    expect(r.reasons).toEqual([]);
    expect(r.valid).toBe(true);
    expect(r.score).toBe(s);
    expect(r.minWallGap).toBeCloseTo(g, 12);
    expect(r.minPairSep).toBeCloseTo(g, 12);
    // shrinking the container by 1e-6 relative breaks it
    const bad = validateNd(cubeProblem(d), { s: s * (1 - 1e-6), pieces });
    expect(bad.valid).toBe(false);
    expect(bad.score).toBeNull();
    expect(bad.reasons.join(" ")).toMatch(/sticks out/);
  });

  it("refuses overlaps and protrusions of 1e-9 at tolerance 0 and accepts them at the touching tolerance 1e-9 and above", () => {
    const d = 5;
    const pair = (dx: number) => ({
      s: 10,
      pieces: [
        [0, 0, 0, 0, 0, ...zeros(d)],
        [dx, 0, 0, 0, 0, ...zeros(d)],
      ],
    });
    expect(validateNd(cubeProblem(d), pair(1 - 1e-9), { tol: 0 }).valid).toBe(false);
    expect(validateNd(cubeProblem(d), pair(1 - 1e-9), { tol: 1e-11 }).valid).toBe(false);
    expect(validateNd(cubeProblem(d), pair(1 - 1e-9), { tol: 2e-9 }).valid).toBe(true);
    expect(validateNd(cubeProblem(d), pair(1 - 1e-7)).valid).toBe(false); // PolyPack's default tolerance 1e-9
    expect(validateNd(cubeProblem(d), pair(1)).valid).toBe(true);
    expect(NDIM_TOL).toBe(1e-9);
    const out = (s: number) => validateNd(cubeProblem(d), { s, pieces: [[0, 0, 0, 0, 0, ...zeros(d)]] }, { tol: 0 });
    expect(out(1 - 2e-9).valid).toBe(false);
    expect(out(1 + 2e-9).valid).toBe(true);
  });

  it("checks balls: pairs, walls, balls in a polytope and a ball", () => {
    const d = 6;
    const ball: NdProblem = { d, piece: "ball", container: "ball" };
    expect(validateNd(ball, { s: 1, pieces: [[0, 0, 0, 0, 0, 0]] }, { tol: 0 }).valid).toBe(true);
    expect(validateNd(ball, { s: 1 - 2e-9, pieces: [[0, 0, 0, 0, 0, 0]] }, { tol: 0 }).valid).toBe(false);
    // two balls touching in a ball of diameter 2
    const two = {
      s: 2,
      pieces: [
        [0.5, 0, 0, 0, 0, 0],
        [-0.5, 0, 0, 0, 0, 0],
      ],
    };
    expect(validateNd(ball, two, { tol: 0 }).valid).toBe(true);
    expect(
      validateNd(
        ball,
        {
          s: 2,
          pieces: [
            [0.5, 0, 0, 0, 0, 0],
            [-0.5 + 1e-9, 0, 0, 0, 0, 0],
          ],
        },
        { tol: 0 },
      ).valid,
    ).toBe(false);
    const inCube: NdProblem = { d, piece: "ball", container: "6:cube" };
    expect(validateNd(inCube, { s: 1, pieces: [[0, 0, 0, 0, 0, 0]] }, { tol: 0 }).valid).toBe(true);
    expect(validateNd(inCube, { s: 1 - 2e-9, pieces: [[0, 0, 0, 0, 0, 0]] }, { tol: 0 }).valid).toBe(false);
    // the ball touching the cube's corner region: the corner of a cube of side 1 is at distance sqrt(6)/2 from the centre
    const cubeInBall: NdProblem = { d, piece: "6:cube", container: "ball" };
    const s = Math.sqrt(6);
    expect(
      validateNd(cubeInBall, { s: s * (1 + 1e-12), pieces: [[0, 0, 0, 0, 0, 0, ...zeros(d)]] }, { tol: 0 }).valid,
    ).toBe(true);
    expect(
      validateNd(cubeInBall, { s: s * (1 - 1e-8), pieces: [[0, 0, 0, 0, 0, 0, ...zeros(d)]] }, { tol: 0 }).valid,
    ).toBe(false);
  });

  it("is sound: it never accepts a pair that the full separation test calls overlapping", () => {
    const rng = mulberry32(7);
    let accepted = 0;
    let refused = 0;
    for (const [code, d] of [
      ["4:cube", 4],
      ["4:simplex", 4],
      ["5:ortho", 5],
      ["6:demi", 6],
      ["4:24cell", 4],
      ["7:simplex", 7],
    ] as const) {
      const P = getPolytope(code);
      for (let t = 0; t < 40; t++) {
        const p1 = [...new Array(d).fill(0), ...Array.from({ length: nParams(d) }, () => (rng() - 0.5) * 1.8)];
        const p2 = [
          ...Array.from({ length: d }, () => (rng() - 0.5) * 2.2 * P.circumradius),
          ...Array.from({ length: nParams(d) }, () => (rng() - 0.5) * 1.8),
        ];
        const A = placeVertices(P.V, P.nV, d, new Float64Array(d), cayleyMatrix(p1.slice(d), d));
        const B = placeVertices(P.V, P.nV, d, Float64Array.from(p2.slice(0, d)), cayleyMatrix(p2.slice(d), d));
        const sep = signedSeparation(A, P.nV, B, P.nV, d).sep;
        const r = validateNd({ d, piece: code, container: "ball" }, { s: 100, pieces: [p1, p2] }, { tol: 0 });
        expect(r.valid).toBe(sep >= 0);
        if (r.valid) accepted++;
        else {
          refused++;
          expect(r.reasons[0]).toMatch(/overlap by/);
        }
      }
    }
    expect(accepted).toBeGreaterThan(30);
    expect(refused).toBeGreaterThan(30);
  });

  it("validates 8:421 as a container", () => {
    const p: NdProblem = { d: 8, piece: "8:simplex", container: "8:421" };
    const C = getPolytope("8:421");
    const s = 3;
    const r = validateNd(p, { s, pieces: [[0, 0, 0, 0, 0, 0, 0, 0, ...zeros(8)]] }, { tol: 0 });
    expect(r.valid).toBe(s * C.inradius > getPolytope("8:simplex").circumradius);
    expect(r.minWallGap).toBeGreaterThan(0);
  });

  it("tightScale gives the smallest s at which the poses fit", () => {
    const rng = mulberry32(3);
    for (const [piece, container, d] of [
      ["4:simplex", "4:cube", 4],
      ["5:cube", "5:ortho", 5],
      ["6:ortho", "ball", 6],
      ["5:simplex", "5:demi", 5],
    ] as const) {
      const pieces = [[...new Array(d).fill(0), ...Array.from({ length: nParams(d) }, () => (rng() - 0.5) * 2)]];
      const prob: NdProblem = { d, piece, container };
      const s = tightScale(prob, pieces);
      expect(validateNd(prob, { s: s * (1 + 1e-9), pieces }, { tol: 0 }).valid).toBe(true);
      expect(validateNd(prob, { s: s * (1 - 1e-6), pieces }, { tol: 0 }).valid).toBe(false);
    }
    expect(tightScale({ d: 4, piece: "ball", container: "4:cube" }, [[0, 0, 0, 0]])).toBeCloseTo(1, 14);
    expect(tightScale({ d: 4, piece: "ball", container: "ball" }, [[0.25, 0, 0, 0]])).toBeCloseTo(1.5, 14);
  });
});

describe("malformed input is refused with a reason", () => {
  const d = 4;
  const prob = cubeProblem(d);
  const pose = [0, 0, 0, 0, ...zeros(d)];
  const reasons = (cfg: unknown, p: NdProblem = prob) => validateNd(p, cfg as never).reasons.join("; ");
  it("bad configurations", () => {
    expect(reasons(null)).toMatch(/config must be an object/);
    expect(reasons([])).toMatch(/config must be an object/);
    expect(reasons({ pieces: [pose] })).toMatch(/s must be/);
    expect(reasons({ s: 0, pieces: [pose] })).toMatch(/s must be/);
    expect(reasons({ s: -1, pieces: [pose] })).toMatch(/s must be/);
    expect(reasons({ s: NaN, pieces: [pose] })).toMatch(/s must be/);
    expect(reasons({ s: Infinity, pieces: [pose] })).toMatch(/s must be/);
    expect(reasons({ s: 2e6, pieces: [pose] })).toMatch(/s must be/);
    expect(reasons({ s: "2", pieces: [pose] })).toMatch(/s must be/);
    expect(reasons({ s: 2 })).toMatch(/pieces must be/);
    expect(reasons({ s: 2, pieces: [] })).toMatch(/pieces must be/);
    expect(reasons({ s: 2, pieces: "x" })).toMatch(/pieces must be/);
    expect(reasons({ s: 2, pieces: [pose.slice(1)] })).toMatch(/pieces\[0\]/);
    expect(reasons({ s: 2, pieces: [[...pose.slice(0, 3), NaN, ...zeros(d)]] })).toMatch(/finite/);
    expect(reasons({ s: 2, pieces: [[...pose.slice(0, 3), null, ...zeros(d)]] })).toMatch(/finite/);
    expect(reasons({ s: 2, pieces: [[1e5, 0, 0, 0, ...zeros(d)]] })).toMatch(/centre coordinates/);
    expect(reasons({ s: 2, pieces: [[0, 0, 0, 0, 99, 0, 0, 0, 0, 0]] })).toMatch(/Cayley/);
    expect(reasons({ s: 2, pieces: [[0, 0, 0, 0, ...zeros(d), 1]] })).toMatch(/even number/);
    expect(reasons({ s: 2, pieces: [[0, 0, 0, 0, ...zeros(d), 3.5]] })).toMatch(/integer/);
    expect(reasons({ s: 2, pieces: [pose, "pose"] })).toMatch(/pieces\[1\]/);
    expect(configErrors(prob, { s: 2, pieces: [pose] })).toEqual([]);
  });
  it("bad problems", () => {
    expect(reasons({ s: 2, pieces: [pose] }, { d: 3, piece: "4:cube", container: "4:cube" })).toMatch(
      /d must be an integer from 4 to 10/,
    );
    expect(reasons({ s: 2, pieces: [pose] }, { d: 4.5, piece: "4:cube", container: "4:cube" })).toMatch(/d must be/);
    expect(reasons({ s: 2, pieces: [pose] }, { d: 4, piece: "5:cube", container: "4:cube" })).toMatch(
      /not 4-dimensional/,
    );
    expect(reasons({ s: 2, pieces: [pose] }, { d: 4, piece: "4:nothing", container: "4:cube" })).toMatch(
      /unknown piece/,
    );
    expect(reasons({ s: 2, pieces: [pose] }, { d: 4, piece: "4:cube", container: 7 as never })).toMatch(
      /container must be/,
    );
    expect(reasons({ s: 2, pieces: [pose] }, null as never)).toMatch(/problem must be an object/);
  });
  it("many errors are capped", () => {
    const pieces = Array.from({ length: 50 }, () => [...pose]);
    const r = validateNd(prob, { s: 0.5, pieces }, { maxErrors: 5, tol: 0 });
    expect(r.valid).toBe(false);
    expect(r.reasons.length).toBeLessThanOrEqual(6);
  });
});

describe("bounds", () => {
  it("volume and inradius bounds", () => {
    // 2^d cubes fill a cube of side 2: the volume bound is exactly 2
    for (let d = 4; d <= 10; d++) expect(volumeBound(cubeProblem(d), 2 ** d)).toBeCloseTo(2, 12);
    expect(volumeBound({ d: 4, piece: "ball", container: "4:cube" }, 1)).toBeCloseTo(ballVolume(4, 0.5) ** 0.25, 12);
    expect(inradiusBound({ d: 4, piece: "4:cube", container: "4:cube" })).toBe(1);
    expect(inradiusBound({ d: 4, piece: "4:600cell", container: "4:cube" })).toBeCloseTo(
      getPolytope("4:600cell").inradius / 0.5,
      12,
    );
    expect(lowerBound({ d: 4, piece: "4:600cell", container: "4:cube" }, 1).kind).toBe("inradius");
    expect(lowerBound(cubeProblem(5), 32).kind).toBe("volume");
    expect(maxPiecesByVolume(cubeProblem(4), 2.0000001)).toBe(16);
    expect(maxPiecesByVolume({ d: 4, piece: "ball", container: "ball" }, 3)).toBe(81);
    expect(unitVolume(10, "10:cube")).toBe(1);
    // 17 balls fit in the cube of side 2 (4D): the volume bound is below 2
    expect(volumeBound({ d: 4, piece: "ball", container: "4:cube" }, 17)).toBeLessThan(2);
  });
});

describe("per-piece helpers", () => {
  it("placeFacets agrees with placeVertices", async () => {
    const { placeFacets } = await import("../src");
    const rng = mulberry32(11);
    for (const [code, d] of [
      ["5:demi", 5],
      ["4:600cell", 4],
      ["6:221", 6],
    ] as const) {
      const P = getPolytope(code);
      const R = cayleyMatrix(
        Array.from({ length: nParams(d) }, () => (rng() - 0.5) * 2),
        d,
      );
      const t = Float64Array.from({ length: d }, () => rng() * 3);
      const X = placeVertices(P.V, P.nV, d, t, R);
      const F = placeFacets(P.N, P.b, P.nF, d, t, R);
      for (let v = 0; v < P.nV; v++)
        for (let f = 0; f < P.nF; f++) {
          let s = 0;
          for (let c = 0; c < d; c++) s += F.N[f * d + c] * X[v * d + c];
          expect(s).toBeLessThanOrEqual(F.b[f] + 1e-12);
        }
    }
  });
  it("pieceWallGap and pairSeparation give the numbers the validator uses", () => {
    const d = 5;
    const prob = cubeProblem(d);
    expect(pieceWallGap(prob, 1.001, [0, 0, 0, 0, 0, ...zeros(d)])).toBeCloseTo(0.0005, 13);
    expect(pairSeparation(prob, [0, 0, 0, 0, 0, ...zeros(d)], [1.25, 0.1, 0, 0, 0, ...zeros(d)])).toBeCloseTo(0.25, 12);
    expect(pairSeparation(prob, [0, 0, 0, 0, 0, ...zeros(d)], [0.75, 0.1, 0, 0, 0, ...zeros(d)])).toBeCloseTo(-0.25, 9);
    const balls: NdProblem = { d, piece: "ball", container: "ball" };
    expect(pairSeparation(balls, [0, 0, 0, 0, 0], [1.5, 0, 0, 0, 0])).toBeCloseTo(0.5, 14);
    expect(pieceWallGap(balls, 3, [1, 0, 0, 0, 0])).toBeCloseTo(0, 14);
    expect(() => pieceWallGap(prob, 1, [0, 0])).toThrow(RangeError);
  });
});
