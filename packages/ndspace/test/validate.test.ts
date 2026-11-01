import { beforeAll, describe, expect, it } from "vitest";
import { loadPolytope, validateNd } from "@polypack/ndim";
import { mulberry32 } from "@polypack/methods";
import { ND_DIMENSIONS, ND_P_RANGE } from "../src/catalogue";
import { ndKernel } from "../src/kernel";
import {
  NDIM_CHECK_MS,
  loadNdProblem,
  ndCheck,
  ndCheckOps,
  ndCheckSteps,
  ndIsHeavy,
  ndProblemOf,
  parseNdConfig,
} from "../src/validate";
import { cubePose, gridP, gridPacking } from "./helpers";

beforeAll(async () => {
  await loadPolytope("8:421");
});

describe("parsing a configuration", () => {
  const prob = { d: 4, piece: "cube", container: "cube", P: 2 };
  const good = { s: 2, pieces: [cubePose([-0.5, 0, 0, 0]), cubePose([0.5, 0, 0, 0])] };

  it("reads a well-formed one, with only its known fields and copies of the poses", () => {
    const r = parseNdConfig(prob, { ...good, extra: 1 });
    expect(r).toMatchObject({ ok: true, score: 2 });
    if (!r.ok) throw new Error();
    expect(Object.keys(r.config)).toEqual(["s", "pieces"]);
    expect(r.config.pieces[0]).toEqual(good.pieces[0]);
    expect(r.config.pieces[0]).not.toBe(good.pieces[0]);
    // the flip is optional
    expect(parseNdConfig(prob, { s: 2, pieces: [good.pieces[0].slice(0, 10), good.pieces[1]] }).ok).toBe(true);
    // balls are their centres
    expect(
      parseNdConfig(
        { ...prob, piece: "ball" },
        {
          s: 2,
          pieces: [
            [0, 0, 0, 0],
            [1, 0, 0, 0],
          ],
        },
      ).ok,
    ).toBe(true);
  });

  it("refuses malformed input as malformed, a wrong number of pieces as a valid form", () => {
    const bad: [string, unknown][] = [
      ["null", null],
      ["array", []],
      ["no s", { pieces: good.pieces }],
      ["s zero", { s: 0, pieces: good.pieces }],
      ["s negative", { s: -1, pieces: good.pieces }],
      ["s too large", { s: 1e6 + 1, pieces: good.pieces }],
      ["s string", { s: "2", pieces: good.pieces }],
      ["s NaN", { s: NaN, pieces: good.pieces }],
      ["pieces missing", { s: 2 }],
      ["pieces object", { s: 2, pieces: {} }],
      ["pose not an array", { s: 2, pieces: [good.pieces[0], "x"] }],
      ["pose too short", { s: 2, pieces: [good.pieces[0], [0, 0, 0, 0]] }],
      ["pose too long", { s: 2, pieces: [good.pieces[0], [...good.pieces[1], 0]] }],
      ["non-finite", { s: 2, pieces: [good.pieces[0], [Infinity, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]] }],
      ["centre too far", { s: 2, pieces: [good.pieces[0], cubePose([2e4, 0, 0, 0])] }],
      ["Cayley parameter too large", { s: 2, pieces: [good.pieces[0], [0, 0, 0, 0, 33, 0, 0, 0, 0, 0, 0]] }],
      ["odd flip", { s: 2, pieces: [good.pieces[0], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]] }],
      ["flip out of range", { s: 2, pieces: [good.pieces[0], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 16]] }],
      ["flip not an integer", { s: 2, pieces: [good.pieces[0], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5]] }],
    ];
    for (const [what, config] of bad) {
      const r = parseNdConfig(prob, config);
      expect(r.ok, what).toBe(false);
      if (!r.ok) {
        expect(r.malformed, what).toBe(true);
        expect(r.errors.length, what).toBeGreaterThan(0);
        expect(r.errors.length, what).toBeLessThanOrEqual(20);
      }
    }
    const wrong = parseNdConfig(prob, { s: 2, pieces: [good.pieces[0]] });
    expect(wrong).toMatchObject({ ok: false, malformed: false });
  });

  it("lists at most 20 errors however large the input", () => {
    const r = parseNdConfig({ ...prob, P: 40 }, { s: 2, pieces: Array.from({ length: 40 }, () => [NaN]) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeLessThanOrEqual(20);
  });
});

describe("checking a configuration", () => {
  it("accepts a grid of balls or hypercubes a hair apart in every dimension, with the stated size and none smaller", () => {
    for (const d of ND_DIMENSIONS)
      for (const kind of ["ball", "cube"] as const) {
        const { problem, config } = gridPacking(d, kind, gridP(d));
        expect(ndCheck(problem, config, 1e-9), `${d}D ${kind}`).toEqual([]);
        // 1e-6 smaller: the pieces overlap and stick out of the walls
        const tight = { ...config, s: config.s - 1e-6 };
        expect(ndCheck(problem, tight, 1e-9).length, `${d}D ${kind} tight`).toBeGreaterThan(0);
      }
  });

  it("says what is wrong: a protrusion and an overlap", () => {
    const { problem, config } = gridPacking(5, "cube", 8);
    const out = ndCheck(problem, { ...config, s: 1.9 }, 1e-9);
    expect(out.some((r) => /sticks out of the container/.test(r))).toBe(true);
    const crowded = { ...config, pieces: config.pieces.map((p, i) => (i === 3 ? config.pieces[2] : p)) };
    expect(ndCheck(problem, crowded, 1e-9).some((r) => /pieces 2 and 3 overlap by/.test(r))).toBe(true);
  });

  it("agrees with the core validator on random states of several problems", () => {
    const rng = mulberry32(5);
    for (const [d, a, b, P] of [
      [4, "24cell", "ball", 4],
      [5, "simplex", "ortho", 5],
      [6, "221", "cube", 4],
      [4, "ball", "600cell", 6],
    ] as [number, string, string, number][]) {
      const prob = { d, piece: a, container: b, P };
      const k = ndKernel(prob);
      for (let t = 0; t < 3; t++) {
        const s = k.randomStart(rng);
        // shrunk so that some of them overlap
        k.setSize(s, s.size * (0.4 + 0.4 * rng()));
        const cfg = k.toConfig(s) as { s: number; pieces: number[][] };
        const mine = ndCheck(prob, cfg, 1e-9, 20);
        const core = validateNd(ndProblemOf(prob), cfg, { tol: 1e-9 });
        expect(mine.length === 0, `${d} ${a} ${b}`).toBe(core.valid);
        expect(mine).toEqual(core.valid ? [] : core.reasons.length ? core.reasons : mine);
      }
    }
  });

  it("is sliced: the steps yield between pieces and pairs, and give the same answer as the synchronous run", () => {
    const { problem, config } = gridPacking(6, "cube", 24);
    const steps = ndCheckSteps(problem, config, 1e-9);
    let yields = 0;
    let r = steps.next();
    while (!r.done) {
      yields++;
      r = steps.next();
    }
    expect(r.value).toEqual([]);
    // 24 pieces: at least the 276 pairs
    expect(yields).toBeGreaterThanOrEqual(276);
  });

  it("stops a check whose work passes the cap, and says so", () => {
    const { problem, config } = gridPacking(6, "cube", 24);
    let t = 0;
    // a clock that advances 1 ms per reading: the cap of 5 ms is passed after a few steps
    const steps = ndCheckSteps(problem, config, 1e-9, 20, 5, () => t++);
    let r = steps.next();
    while (!r.done) r = steps.next();
    expect(r.value).toHaveLength(1);
    expect(r.value[0]).toMatch(/the check was stopped after \d+ ms of work, above the cap of 5 ms/);
    expect(NDIM_CHECK_MS).toBe(8000);
  });

  it("stops at the maximum number of errors", () => {
    // 20 pieces on top of each other
    const { problem } = gridPacking(4, "cube", 16);
    const same = { s: 2, pieces: Array.from({ length: 16 }, () => cubePose([0, 0, 0, 0])) };
    const out = ndCheck(problem, same, 1e-9, 5);
    expect(out.length).toBeLessThanOrEqual(5);
    expect(out.length).toBeGreaterThan(0);
  });

  it("classifies heavy checks by size and loads 8D 4_21 on demand", async () => {
    const heavy = [
      { d: 8, piece: "421", container: "421", P: 20 },
      { d: 8, piece: "cube", container: "421", P: 20 },
      { d: 10, piece: "cube", container: "ortho", P: 20 },
      { d: 4, piece: "120cell", container: "600cell", P: 40 },
    ];
    for (const p of heavy) expect(ndIsHeavy(p), JSON.stringify(p)).toBe(true);
    for (const p of [
      { d: 4, piece: "cube", container: "cube", P: 2 },
      { d: 5, piece: "ball", container: "ball", P: 32 },
      { d: 10, piece: "ball", container: "ball", P: 20 },
    ])
      expect(ndIsHeavy(p), JSON.stringify(p)).toBe(false);
    expect(ndCheckOps({ d: 8, piece: "421", container: "421", P: 20 })).toBeGreaterThan(7e8);
    await loadNdProblem({ d: 8, piece: "421", container: "421" });
    const k = ndKernel({ d: 8, piece: "421", container: "421", P: 2 });
    expect(k.P).toBe(2);
  });

  it("checks no input for more than the cap, in the worst problems of every dimension", () => {
    // pieces that all sit on one another (every pair overlaps), and a valid packing hugging the walls: both stay fast
    const rng = mulberry32(11);
    for (const [d, a, b, P] of [
      [8, "421", "421", 20],
      [10, "cube", "ortho", 20],
      [4, "120cell", "120cell", 40],
      [6, "122", "221", 24],
    ] as [number, string, string, number][]) {
      const prob = { d, piece: a, container: b, P };
      const k = ndKernel(prob);
      const s = k.randomStart(rng);
      const cfg = k.toConfig(s) as { s: number; pieces: number[][] };
      const piled = { s: cfg.s, pieces: cfg.pieces.map((p) => [...p.slice(0, d).map(() => 0), ...p.slice(d)]) };
      const t0 = performance.now();
      const out = ndCheck(prob, piled, 1e-9);
      expect(performance.now() - t0, `${d}D ${a} in ${b}`).toBeLessThan(NDIM_CHECK_MS);
      expect(out.length).toBeGreaterThan(0);
      const t1 = performance.now();
      ndCheck(prob, cfg, 1e-9);
      expect(performance.now() - t1, `${d}D ${a} in ${b} random`).toBeLessThan(NDIM_CHECK_MS);
    }
  });

  it("has a range of P for every dimension at which the grid packings fit", () => {
    for (const d of ND_DIMENSIONS) expect(gridP(d)).toBeLessThanOrEqual(ND_P_RANGE[d][1]);
  });
});
