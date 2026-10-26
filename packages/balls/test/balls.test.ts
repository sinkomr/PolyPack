/**
 * The balls space's package: ids, bounds, the validator (contacts, overlaps and protrusions at the tolerance,
 * malformed input) and the search (valid results at any budget, reproducible by seed, stops, warm starts).
 * The search tests assert properties, not seeded outcomes, which may differ between Node versions.
 */
import { describe, expect, it } from "vitest";
import {
  BALLS_CLEARANCE,
  BALLS_CODES,
  type BallsConfig,
  ballsBound,
  ballsConfigErrors,
  getBallsProblem,
  latticeCut,
  legalizeBalls,
  parseBallsId,
  searchBalls,
  tightSize,
  validateBalls,
} from "../src";
import { mulberry32 } from "../src/random";
import { conePoses } from "../scripts/cones";

const ballInBall = getBallsProblem("ballinball")!;
const ballInCube = getBallsProblem("ballincub")!;
const cubes = getBallsProblem("cubinball")!;

describe("ids and bounds", () => {
  it("reads ids in their one written form", () => {
    expect(parseBallsId("balls/ballinball/13")).toMatchObject({ code: "ballinball", P: 13 });
    for (const bad of ["balls/ballinball/013", "balls/ballinball/+3", "balls/ballinballs/3", "balls/ballinball", "polyhedra/cubincub/3", 3])
      expect(typeof parseBallsId(bad)).toBe("string");
    expect(BALLS_CODES).toEqual(["ballinball", "ballincub", "tetinball", "cubinball", "octinball", "dodinball", "icoinball"]);
  });

  it("gives the elementary bounds", () => {
    expect(ballsBound(ballInBall, 2).value).toBe(2);
    expect(ballsBound(ballInBall, 100).value).toBeCloseTo(Math.cbrt(100), 12);
    expect(ballsBound(ballInCube, 2).value).toBeCloseTo(2 + 2 / Math.sqrt(3), 14);
    expect(ballsBound(ballInCube, 100).value).toBeCloseTo(Math.cbrt((400 * Math.PI) / 3), 12);
    // two cubes hold disjoint balls of radius 1/2: s >= 1, above the circumradius sqrt(3)/2
    expect(ballsBound(cubes, 2)).toMatchObject({ value: 1, kind: "two pieces" });
    expect(ballsBound(getBallsProblem("tetinball")!, 2).kind).toBe("one piece");
  });
});

describe("validateBalls", () => {
  const two = (d: number, s: number): BallsConfig => ({ s, pieces: [[d, 0, 0], [-d, 0, 0]] });

  it("accepts touching balls and walls, and overlaps and protrusions within the tolerance", () => {
    expect(validateBalls(ballInBall, two(1, 2)).valid).toBe(true);
    expect(validateBalls(ballInBall, two(1, 2), { tol: 0 }).valid).toBe(true);
    // 1e-9 / 2 deep: within the touching tolerance, not at tolerance 0
    expect(validateBalls(ballInBall, two(1 - 0.25e-9, 2)).valid).toBe(true);
    expect(validateBalls(ballInBall, two(1 - 0.25e-9, 2), { tol: 0 }).valid).toBe(false);
  });

  it("rejects an overlap or a protrusion deeper than 1e-9", () => {
    const v = validateBalls(ballInBall, two(1 - 1e-9, 2));
    expect(v.valid).toBe(false);
    expect(v.errors[0]).toMatch(/^pieces 0 and 1 overlap by (2\.0|1\.99)\d*e-9$/);
    expect(validateBalls(ballInBall, two(1 + 2e-9, 2 + 2e-9)).valid).toBe(true);
    expect(validateBalls(ballInBall, two(1 + 3e-9, 2 + 1e-9)).valid).toBe(false);
    const grid = (h: number): BallsConfig => ({
      s: 4,
      pieces: [-1, 1].flatMap((x) => [-1, 1].flatMap((y) => [-1, 1].map((z) => [x * h, y, z]))),
    });
    expect(validateBalls(ballInCube, grid(1)).valid).toBe(true);
    expect(validateBalls(ballInCube, grid(1 + 2e-9)).errors[0]).toMatch(/sticks out of the container by (2\.0|1\.99)\d*e-9$/);
  });

  it("refuses malformed input", () => {
    const bad: unknown[] = [
      null,
      [],
      { s: 3 },
      { s: 0, pieces: [[0, 0, 0]] },
      { s: NaN, pieces: [[0, 0, 0]] },
      { s: 2e6, pieces: [[0, 0, 0]] },
      { s: 3, pieces: [[0, 0]] },
      { s: 3, pieces: [[0, 0, "0"]] },
      { s: 3, pieces: [[0, 0, Infinity]] },
      { s: 3, pieces: [[0, 0, 2e4]] },
      // eslint-disable-next-line no-sparse-arrays
      { s: 3, pieces: [[0, , 0]] },
    ];
    for (const c of bad) expect(ballsConfigErrors(ballInBall, c).length, JSON.stringify(c)).toBeGreaterThan(0);
    expect(ballsConfigErrors(ballInBall, { s: 3, pieces: [[0, 0, 0]] }, 2)).toEqual(["expected 2 pieces for this problem, got 1"]);
    // a solid's pose has 7 numbers and a nonzero quaternion
    expect(ballsConfigErrors(cubes, { s: 3, pieces: [[0, 0, 0]] }).length).toBeGreaterThan(0);
    expect(ballsConfigErrors(cubes, { s: 3, pieces: [[0, 0, 0, 0, 0, 0, 0]] }).length).toBeGreaterThan(0);
    expect(ballsConfigErrors(cubes, { s: 3, pieces: [[0, 0, 0, 1, 0, 0, 0]] })).toEqual([]);
    expect(ballsConfigErrors(cubes, { s: 2e6, pieces: [[0, 0, 0, 1, 0, 0, 0]] }).length).toBeGreaterThan(0);
  });

  it("checks solids by vertex distance and by the separating-axis test", () => {
    const far = Math.sqrt(1.5);
    const pair = (g: number, s: number): BallsConfig => ({
      s,
      pieces: [
        [-0.5 - g / 2, 0, 0, 1, 0, 0, 0],
        [0.5 + g / 2, 0, 0, 1, 0, 0, 0],
      ],
    });
    expect(validateBalls(cubes, pair(0, far)).valid).toBe(true);
    expect(validateBalls(cubes, pair(-2e-9, far)).errors[0]).toMatch(/^pieces 0 and 1 overlap by (2\.0|1\.99)\d*e-9$/);
    expect(validateBalls(cubes, pair(0, far - 2e-9)).errors[0]).toMatch(/sticks out of the container/);
    expect(tightSize(cubes, pair(0, far).pieces)).toBeCloseTo(far, 14);
  });
});

describe("legalizeBalls and latticeCut", () => {
  it("makes any centres valid with the clearance", () => {
    const rng = mulberry32(5);
    for (const problem of [ballInBall, ballInCube]) {
      const centres = Array.from({ length: 20 }, (): [number, number, number] => [rng() * 3, rng() * 3, rng() * 3]);
      centres.push([...centres[3]]);
      const c = legalizeBalls(problem, centres, BALLS_CLEARANCE, BALLS_CLEARANCE);
      const v = validateBalls(problem, c, { tol: 0 });
      expect(v.valid).toBe(true);
      expect(v.minPairSep).toBeGreaterThanOrEqual(0.99 * BALLS_CLEARANCE);
      expect(v.minWallGap).toBeGreaterThanOrEqual(0.99 * BALLS_CLEARANCE);
    }
  });

  it("cuts lattice packings: 27 balls of the simple cubic lattice fill a cube of edge 6", () => {
    const rng = mulberry32(1);
    const c = latticeCut(ballInCube, 27, () => 0.5 + 0 * rng(), "sc", false);
    expect(legalizeBalls(ballInCube, c, 0, 0).s).toBeCloseTo(6, 12);
    // an fcc cut of 13 balls holds the cuboctahedral shell of 12 round one: radius 3 when centred
    const d = latticeCut(ballInBall, 13, () => 0.5, "fcc", false);
    expect(tightSize(ballInBall, d)).toBeCloseTo(3, 12);
  });
});

describe("the cone construction of tetrahedra", () => {
  it("puts 20 tetrahedra with a common vertex in the unit ball, touching only along the cones' walls", () => {
    const tet = getBallsProblem("tetinball")!;
    const v = validateBalls(tet, { s: 1, pieces: conePoses(20) });
    expect(v.valid, v.errors.join("; ")).toBe(true);
    // they touch (the common vertex), so the gaps are zero up to rounding, and every vertex is at distance 1
    expect(Math.abs(v.minPairSep)).toBeLessThan(1e-12);
    expect(Math.abs(v.minWallGap)).toBeLessThan(1e-12);
    expect(tightSize(tet, conePoses(20))).toBeCloseTo(1, 12);
    expect(() => conePoses(21)).toThrow(RangeError);
  });
});

describe("searchBalls", () => {
  it("returns valid results at any budget, and ends on its evaluations", () => {
    for (const [code, P] of [
      ["ballinball", 7],
      ["ballincub", 9],
      ["tetinball", 4],
      ["icoinball", 5],
    ] as const) {
      const problem = getBallsProblem(code)!;
      for (const maxEvals of [30, 3000, 30000]) {
        const r = searchBalls(problem, P, { seed: 2, maxEvals });
        expect(r.evaluations).toBeLessThanOrEqual(maxEvals);
        if (r.config) {
          const v = validateBalls(problem, r.config, { tol: 0 });
          expect(v.valid, `${code} ${P} ${maxEvals}`).toBe(true);
          expect(r.score).toBe(r.config.s);
          expect(r.score).toBeGreaterThanOrEqual(ballsBound(problem, P).value);
        }
      }
    }
  });

  it("finds the known optima of small cases", () => {
    // [EST] eight balls in a cube of edge 4 (Schaer 1966); 13 balls in a ball of radius 3 (twelve round one)
    expect(searchBalls(ballInCube, 8, { seed: 1, maxEvals: 150000 }).score).toBeLessThan(4 * (1 + 1e-8));
    expect(searchBalls(ballInBall, 4, { seed: 1, maxEvals: 60000 }).score).toBeLessThan((1 + Math.sqrt(6) / 2) * (1 + 1e-8));
  });

  it("is reproducible by seed when it ends on evaluations", () => {
    const a = searchBalls(ballInBall, 9, { seed: 11, maxEvals: 20000 });
    const b = searchBalls(ballInBall, 9, { seed: 11, maxEvals: 20000 });
    const c = searchBalls(ballInBall, 9, { seed: 12, maxEvals: 20000 });
    expect(a.config).toEqual(b.config);
    expect(a.evaluations).toBe(b.evaluations);
    expect(c.config).not.toEqual(a.config);
    const s1 = searchBalls(cubes, 4, { seed: 3, maxEvals: 8000 });
    const s2 = searchBalls(cubes, 4, { seed: 3, maxEvals: 8000 });
    expect(s1.config).toEqual(s2.config);
  });

  it("stops when asked and on time, with a valid best so far", () => {
    let calls = 0;
    const r = searchBalls(ballInBall, 20, { seed: 1, maxEvals: 1e9, shouldStop: () => ++calls > 500 });
    expect(r.stopped).toBe("aborted");
    expect(r.evaluations).toBeLessThanOrEqual(500);
    if (r.config) expect(validateBalls(ballInBall, r.config, { tol: 0 }).valid).toBe(true);
    let t = 0;
    const timed = searchBalls(getBallsProblem("dodinball")!, 10, { seed: 1, maxEvals: 1e9, maxSeconds: 2, now: () => (t += 0.001) });
    expect(timed.stopped).toBe("time");
  });

  it("never returns worse than a valid start, polished or taken as it is", () => {
    const first = searchBalls(ballInCube, 12, { seed: 4, maxEvals: 20000 });
    const again = searchBalls(ballInCube, 12, { seed: 5, maxEvals: 5000, start: first.config!, startPolished: true });
    expect(again.score).toBeLessThanOrEqual(first.score);
    expect(again.startScore).toBeLessThanOrEqual(first.score * (1 + 1e-12));
    // a start larger than it needs is legalized down to its tight size first
    const loose = { s: first.score * 1.5, pieces: first.config!.pieces };
    const r = searchBalls(ballInCube, 12, { seed: 5, maxEvals: 3000, start: loose });
    expect(r.score).toBeLessThanOrEqual(first.score * (1 + 1e-9));
    expect(() => searchBalls(ballInCube, 11, { seed: 1, start: first.config! })).toThrow(/12 pieces, not 11/);
  });
});
