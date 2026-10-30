/**
 * The balls space's package: ids, bounds, the validator (contacts, overlaps and protrusions at the tolerance,
 * malformed input) and the search (valid results at any budget, reproducible by seed, stops, warm starts).
 * The search tests assert properties, not seeded outcomes, which may differ between Node versions.
 */
import { describe, expect, it } from "vitest";
import {
  BALLS_CLEARANCE,
  BALLS_CODES,
  BALLS_ORIGINAL_CODES,
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
import { readFileSync } from "node:fs";
import { BALLS_MAX_P, BALLS_MIN_P, ballsDomain } from "../src";

/** The test packings shared with the certifier's tests (python/balls/fixtures/packings.json). */
const packings = JSON.parse(readFileSync(new URL("../../../python/balls/fixtures/packings.json", import.meta.url), "utf8"))
  .packings as { id: string; code: string; P: number; config: BallsConfig }[];

const ballInBall = getBallsProblem("ballinball")!;
const ballInCube = getBallsProblem("ballincub")!;
const cubes = getBallsProblem("cubinball")!;

describe("ids and bounds", () => {
  it("reads ids in their one written form", () => {
    expect(parseBallsId("balls/ballinball/13")).toMatchObject({ code: "ballinball", P: 13 });
    for (const bad of ["balls/ballinball/013", "balls/ballinball/+3", "balls/ballinballs/3", "balls/ballinball", "polyhedra/cubincub/3", 3])
      expect(typeof parseBallsId(bad)).toBe("string");
    expect(BALLS_CODES.slice(0, 1)).toEqual(["ballinball"]);
    expect(BALLS_CODES).toHaveLength(373);
    expect(BALLS_ORIGINAL_CODES.every((c) => BALLS_CODES.includes(c))).toBe(true);
  });

  it("gives the elementary bounds", () => {
    expect(ballsBound(ballInBall, 2).value).toBe(2);
    expect(ballsBound(ballInBall, 100).value).toBeCloseTo(Math.cbrt(100), 12);
    expect(ballsBound(ballInCube, 2).value).toBeCloseTo(1 + 1 / Math.sqrt(3), 14);
    expect(ballsBound(ballInCube, 100).value).toBeCloseTo(Math.cbrt((50 * Math.PI) / 3), 12);
    // two cubes hold disjoint balls of radius 1/2: a container of radius at least 1, diameter s >= 2 (above 2 times the
    // circumradius sqrt(3)/2)
    expect(ballsBound(cubes, 2)).toMatchObject({ value: 2, kind: "two-piece" });
    expect(ballsBound(getBallsProblem("tetinball")!, 2).kind).toBe("one piece");
  });
});

describe("the catalogue", () => {
  it("has a domain of the 373 problems for P = 2 to 100, with their bounds, and a sample of small P first from the first 7", () => {
    expect(ballsDomain.info.problems).toBe(373 * (BALLS_MAX_P - BALLS_MIN_P + 1));
    expect(ballsDomain.info.fields.map((f) => f.key)).toEqual(["code", "P"]);
    const all = ballsDomain.sample(10000);
    expect(all).toHaveLength(693);
    expect(new Set(all).size).toBe(693);
    expect(all.slice(0, 8)).toEqual([...BALLS_ORIGINAL_CODES.map((c) => `balls/${c}/2`), "balls/ballinball/3"]);
    expect(ballsDomain.sample(3)).toHaveLength(3);
    for (const id of all) {
      const p = parseBallsId(id);
      if (typeof p === "string") throw new Error(p);
      expect(ballsDomain.bound({ fields: { code: p.code }, P: p.P })!.value).toBe(ballsBound(p.problem, p.P).value);
    }
    expect(ballsDomain.bound({ fields: { code: "ballinball" }, P: 2 })).toEqual({
      value: 2,
      label: expect.stringMatching(/^two piece bound; \[EST\]/),
    });
    // outside the domain
    expect(ballsDomain.bound({ fields: { code: "ballinball" }, P: 1 })).toBeUndefined();
    expect(ballsDomain.bound({ fields: { code: "ballinball" }, P: 101 })).toBeUndefined();
    expect(ballsDomain.bound({ fields: { code: "cubincub" }, P: 5 })).toBeUndefined();
  });

  it("has test packings of every kind, valid at tolerance 0 and not below their bounds", () => {
    expect(new Set(packings.map((p) => p.code))).toEqual(new Set(BALLS_ORIGINAL_CODES));
    for (const p of packings) {
      const problem = getBallsProblem(p.code)!;
      const v = validateBalls(problem, p.config, { tol: 0 });
      expect(v.valid, p.id).toBe(true);
      expect(v.minWallGap, p.id).toBeGreaterThan(0.5 * BALLS_CLEARANCE);
      expect(p.config.pieces).toHaveLength(p.P);
      expect(p.config.s, p.id).toBeGreaterThanOrEqual(ballsBound(problem, p.P).value);
      // shrunk by 1e-8, the container no longer holds them
      expect(validateBalls(problem, { ...p.config, s: p.config.s * (1 - 1e-8) }, { tol: 0 }).valid, p.id).toBe(false);
    }
  });

  it("starts the search from a test packing and never returns worse", () => {
    for (const p of packings.filter((q) => q.P === 13)) {
      const problem = getBallsProblem(p.code)!;
      const r = searchBalls(problem, 13, { seed: 3, maxEvals: 3000, start: p.config });
      expect(r.score, p.id).toBeLessThanOrEqual(p.config.s * (1 + 1e-9));
      expect(validateBalls(problem, r.config!, { tol: 0 }).valid, p.id).toBe(true);
    }
  });
});

describe("validateBalls", () => {
  const two = (d: number, s: number): BallsConfig => ({ s, pieces: [[d, 0, 0], [-d, 0, 0]] });

  it("accepts touching balls and walls, and overlaps and protrusions within the tolerance", () => {
    // balls of diameter 1 at +-1/2 touch, and the container of diameter 2 holds them
    expect(validateBalls(ballInBall, two(0.5, 2)).valid).toBe(true);
    expect(validateBalls(ballInBall, two(0.5, 2), { tol: 0 }).valid).toBe(true);
    // 0.25e-9 deep: within the touching tolerance, not at tolerance 0
    expect(validateBalls(ballInBall, two(0.5 - 0.125e-9, 2)).valid).toBe(true);
    expect(validateBalls(ballInBall, two(0.5 - 0.125e-9, 2), { tol: 0 }).valid).toBe(false);
  });

  it("rejects an overlap or a protrusion deeper than 1e-9", () => {
    const v = validateBalls(ballInBall, two(0.5 - 1e-9, 2));
    expect(v.valid).toBe(false);
    expect(v.errors[0]).toMatch(/^pieces 0 and 1 overlap by (2\.0|1\.99)\d*e-9$/);
    expect(validateBalls(ballInBall, two(0.5 + 2e-9, 2 + 4e-9)).valid).toBe(true);
    expect(validateBalls(ballInBall, two(0.5 + 3e-9, 2 + 2e-9)).valid).toBe(false);
    const grid = (h: number): BallsConfig => ({
      s: 2,
      pieces: [-1, 1].flatMap((x) => [-0.5, 0.5].flatMap((y) => [-0.5, 0.5].map((z) => [x * h, y, z]))),
    });
    expect(validateBalls(ballInCube, grid(0.5)).valid).toBe(true);
    expect(validateBalls(ballInCube, grid(0.5 + 2e-9)).errors[0]).toMatch(/sticks out of the container by (2\.0|1\.99)\d*e-9$/);
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
    // the container is scored by its diameter, twice the radius sqrt(1.5) that the vertices need
    expect(validateBalls(cubes, pair(0, 2 * far)).valid).toBe(true);
    expect(validateBalls(cubes, pair(-2e-9, 2 * far)).errors[0]).toMatch(/^pieces 0 and 1 overlap by (2\.0|1\.99)\d*e-9$/);
    expect(validateBalls(cubes, pair(0, 2 * far - 4e-9)).errors[0]).toMatch(/sticks out of the container/);
    expect(tightSize(cubes, pair(0, 2 * far).pieces)).toBeCloseTo(2 * far, 14);
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

  it("cuts lattice packings: 27 balls of the simple cubic lattice fill a cube of edge 3", () => {
    const rng = mulberry32(1);
    const c = latticeCut(ballInCube, 27, () => 0.5 + 0 * rng(), "sc", false);
    expect(legalizeBalls(ballInCube, c, 0, 0).s).toBeCloseTo(3, 12);
    // an fcc cut of 13 balls holds the cuboctahedral shell of 12 round one: a ball container of diameter 3 when centred
    const d = latticeCut(ballInBall, 13, () => 0.5, "fcc", false);
    expect(tightSize(ballInBall, d)).toBeCloseTo(3, 12);
  });
});

describe("the cone construction of tetrahedra", () => {
  it("puts 20 tetrahedra with a common vertex in the ball of radius 1, touching only along the cones' walls", () => {
    const tet = getBallsProblem("tetinball")!;
    const v = validateBalls(tet, { s: 2, pieces: conePoses(20) });
    expect(v.valid, v.errors.join("; ")).toBe(true);
    // they touch (the common vertex), so the gaps are zero up to rounding, and every vertex is at distance 1
    expect(Math.abs(v.minPairSep)).toBeLessThan(1e-12);
    expect(Math.abs(v.minWallGap)).toBeLessThan(1e-12);
    expect(tightSize(tet, conePoses(20))).toBeCloseTo(2, 12);
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
    // two unit cubes face to face in a ball of radius sqrt(1.5), diameter 2 sqrt(1.5)
    expect(searchBalls(cubes, 2, { seed: 1, maxEvals: 30000 }).score).toBeLessThan(2 * Math.sqrt(1.5) * (1 + 1e-6));
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
