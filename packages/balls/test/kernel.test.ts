/**
 * The kernel of the generic search methods (src/kernel.ts): the methods' contract on every problem, exact gradients
 * for true and soft shapes, the test packings in and out, squeeze and finish from random starts, seeds, the
 * server's rule (compared in full with the server's own in packages/spaces/test/methods.test.ts), moves undone,
 * states that blew up, absurd starts, a finish told to stop, the finish's stops, valid inputs, loose sizes and
 * rounding at contact, and every method on every problem. The method runs assert properties, not seeded outcomes,
 * which may differ between Node versions and platforms.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type KernelState, type SpaceKernel, methodsFor, mulberry32, runMethod, squeeze } from "@polypack/methods";
import { checkKernel } from "@polypack/methods/contract";
import {
  BALLS_CLEARANCE,
  BALLS_ORIGINAL_CODES,
  BALLS_STRICT_REASON,
  type BallsConfig,
  ballsBound,
  ballsKernel,
  getBallsProblem,
  polishBalls,
  polishSolids,
  validateBalls,
} from "../src";
import { BALL_MUS } from "../src/ball-pieces";
import { SOLID_MUS } from "../src/solid-pieces";
import { StopSearch, getSolid } from "@polypack/polyhedra";

/** The test packings shared with the certifier's tests (python/balls/fixtures/packings.json). */
const packings = JSON.parse(readFileSync(new URL("../../../python/balls/fixtures/packings.json", import.meta.url), "utf8"))
  .packings as { id: string; code: string; P: number; config: BallsConfig }[];
const packing = (code: string, P: number) => packings.find((p) => p.code === code && p.P === P)!.config;

/** Valid at tolerance 0 by the space's validator. */
const strictlyValid = (code: string, config: unknown) =>
  validateBalls(getBallsProblem(code)!, config as BallsConfig, { tol: 0 }).valid;

/** The largest mismatch of the energy's gradient and central differences over every variable and the size. */
function gradientError(k: SpaceKernel, s: KernelState): number {
  const n = k.P * k.dim;
  const g = new Float64Array(n + 1);
  k.energy(s, g);
  let worst = 0;
  for (let i = 0; i <= n; i++) {
    const h = 1e-6 * (i < n ? k.steps[i % k.dim] : 1);
    const p = k.clone(s);
    const m = k.clone(s);
    if (i < n) {
      p.x[i] += h;
      m.x[i] -= h;
    } else {
      p.size += h;
      m.size -= h;
    }
    const fd = (k.energy(p) - k.energy(m)) / (2 * h);
    worst = Math.max(worst, Math.abs(fd - g[i]) / Math.max(1, Math.abs(fd), Math.abs(g[i])));
  }
  return worst;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("ballsKernel", () => {
  for (const code of BALLS_ORIGINAL_CODES)
    it(`passes the kernel contract: ${code}, P = 2, 5 and 13`, async () => {
      for (const P of [2, 5, 13]) {
        expect(checkKernel(() => ballsKernel({ code, P }), { seed: P }), `P = ${P}`).toEqual([]);
        await tick();
      }
    });

  it("passes the kernel contract at a large P: 60 balls in a cube, 40 icosahedra", () => {
    expect(checkKernel(() => ballsKernel({ code: "ballincub", P: 60 }), { seed: 3, states: 2 })).toEqual([]);
    expect(checkKernel(() => ballsKernel({ code: "icoinball", P: 40 }), { seed: 3, states: 2 })).toEqual([]);
  });

  it("has the gradient of its energy for overlapping pieces and walls, true and soft, in charts turned away from their anchors", () => {
    for (const code of BALLS_ORIGINAL_CODES) {
      const k = ballsKernel({ code, P: 6 });
      const rng = mulberry32(2);
      const s = k.randomStart(rng);
      // overlapping pieces and walls, and for solids chart rotations of up to 3 steps
      k.setSize(s, 0.45 * s.size);
      for (let i = 0; i < 6; i++) k.jiggle(s, i, 3, rng);
      expect(k.energy(s), code).toBeGreaterThan(1e-3);
      for (const t of [1, 0.6, 0]) {
        k.setShape!(s, t);
        expect(gradientError(k, s), `${code}, t = ${t}`).toBeLessThan(1e-6);
      }
    }
    // a container smaller than a ball: both faces of an axis push
    const k = ballsKernel({ code: "ballincub", P: 2 });
    const s = k.fromConfig({ s: 1.5, pieces: [[0.1, -0.2, 0.3], [5, 0, 0]] })!;
    expect(gradientError(k, s)).toBeLessThan(1e-6);
  });

  it("softens solids monotonically into their inscribed balls; a ball is its own soft shape", () => {
    const k = ballsKernel({ code: "tetinball", P: 2 });
    const rho = getSolid("tetrahedron").inradius;
    // two tetrahedra 1.5 inradii apart in a large ball: at t = 0 two balls of radius rho overlapping by rho / 2
    const s = k.fromConfig({ s: 20, pieces: [[0, 0, 0, 1, 0, 0, 0], [1.5 * rho, 0, 0, 0, 1, 0, 0]] })!;
    k.setShape!(s, 0);
    expect(k.energy(s)).toBeCloseTo((0.5 * rho) ** 2, 14);
    let last = Infinity;
    for (const t of [1, 0.75, 0.5, 0.25, 0]) {
      k.setShape!(s, t);
      const e = k.energy(s);
      expect(e).toBeLessThanOrEqual(last);
      last = e;
    }
    // a soft piece's farthest point is its core's farthest vertex plus the dilation: an axis-aligned cube centred at
    // distance 3 on a diagonal, so that a vertex lies 3 + sqrt(3) / 2 from the origin, in a ball of radius 3.5, scored by its
    // diameter 7 (the
    // other cube well inside)
    const c = ballsKernel({ code: "cubinball", P: 2 });
    const far = 3 + Math.sqrt(3) / 2;
    const u = 1 / Math.sqrt(3);
    const q = c.fromConfig({ s: 7, pieces: [[3 * u, 3 * u, 3 * u, 1, 0, 0, 0], [-2, 0, 0, 1, 0, 0, 0]] })!;
    expect(c.energy(q)).toBeCloseTo((far - 3.5) ** 2, 13);
    // at t = 0.5: the core's vertex at 3 + sqrt(3) / 4, and the dilation half the inradius 1/2
    c.setShape!(q, 0.5);
    expect(c.energy(q)).toBeCloseTo((3 + 0.5 * (Math.sqrt(3) / 2) + 0.5 * 0.5 - 3.5) ** 2, 13);
    // balls: every t is the ball
    const b = ballsKernel({ code: "ballinball", P: 2 });
    const two = b.fromConfig({ s: 2, pieces: [[0.45, 0, 0], [-0.45, 0, 0]] })!;
    const e = b.energy(two);
    expect(e).toBeCloseTo(0.1 ** 2, 14);
    b.setShape!(two, 0);
    expect(b.energy(two)).toBe(e);
  });

  it("splits its energy into the pieces' terms, and clear() agrees with them", () => {
    for (const code of ["ballinball", "ballincub", "icoinball", "cubinball"]) {
      const k = ballsKernel({ code, P: 7 });
      const rng = mulberry32(4);
      const s = k.randomStart(rng);
      k.setSize(s, 0.5 * s.size);
      // without walls, every pair term is in two pieces' energies
      const free = k.clone(s);
      free.size = 1e3;
      const e = k.energy(free);
      expect(e, code).toBeGreaterThan(0);
      let sum = 0;
      for (let i = 0; i < k.P; i++) sum += k.pieceEnergy(free, i);
      expect(sum, code).toBeCloseTo(2 * e, 12);
      for (let i = 0; i < k.P; i++) expect(k.clear(s, i, 0), code).toBe(k.pieceEnergy(s, i) === 0);
    }
  });

  it("swaps the orientations of two solids and keeps their centres; balls have nothing to swap", () => {
    const k = ballsKernel({ code: "octinball", P: 4 });
    const s = k.randomStart(mulberry32(5));
    k.jiggle(s, 1, 1, mulberry32(6));
    const before = k.toConfig(s) as BallsConfig;
    k.swap!(s, 1, 3);
    const after = k.toConfig(s) as BallsConfig;
    expect(after.pieces[1].slice(0, 3)).toEqual(before.pieces[1].slice(0, 3));
    for (let d = 3; d < 7; d++) {
      expect(after.pieces[1][d]).toBeCloseTo(before.pieces[3][d], 14);
      expect(after.pieces[3][d]).toBeCloseTo(before.pieces[1][d], 14);
    }
    expect(ballsKernel({ code: "ballinball", P: 4 }).swap).toBeUndefined();
  });

  it("squeezes random starts and finishes them into valid packings", async () => {
    for (const [code, P, seed] of [
      ["ballinball", 9, 1],
      ["ballincub", 6, 2],
      ["tetinball", 10, 3],
      ["cubinball", 5, 4],
      ["dodinball", 3, 5],
    ] as const) {
      const k = ballsKernel({ code, P });
      const s = k.randomStart(mulberry32(seed));
      const roomy = s.size;
      squeeze(k, s);
      const f = k.finish(s);
      expect(f, code).not.toBeNull();
      expect(strictlyValid(code, f!.config), code).toBe(true);
      expect(k.validate(f!.config), code).toEqual({ valid: true, score: f!.score, reasons: [] });
      expect(f!.score, code).toBeLessThan(0.9 * roomy);
      expect(f!.score, code).toBeGreaterThanOrEqual(k.bound!);
      await tick();
    }
  });

  it("seeds lattice cuts that are packings already, and new ones on every call", () => {
    for (const [code, P] of [
      ["ballinball", 13],
      ["ballincub", 8],
      ["cubinball", 8],
      ["icoinball", 5],
    ] as const) {
      const k = ballsKernel({ code, P });
      const rng = mulberry32(1);
      const seeds = k.seeds!(rng, 4);
      expect(seeds.length).toBe(4);
      for (const q of seeds) {
        expect(k.energy(q), code).toBe(0);
        expect(k.validate(k.toConfig(q)).valid, code).toBe(true);
        const f = k.finish(q)!;
        expect(strictlyValid(code, f.config), code).toBe(true);
        expect(f.score, code).toBeLessThanOrEqual(q.size * (1 + 1e-9));
      }
      expect(k.toConfig(k.seeds!(rng, 1)[0])).not.toEqual(k.toConfig(seeds[0]));
    }
    // 8 balls of the simple cubic lattice, axis-aligned (the second seed in a cube): the cube of edge 2, all touching
    const k = ballsKernel({ code: "ballincub", P: 8 });
    expect(k.seeds!(mulberry32(2), 2)[1].size).toBeCloseTo(2, 8);
  });

  it("validates as the server does: touching tolerance, the strict check of a problem without records, the bound", () => {
    const k = ballsKernel({ code: "ballinball", P: 2 });
    const two = (d: number, s: number) => ({ s, pieces: [[d, 0, 0], [-d, 0, 0]] });
    expect(k.validate(two(0.5, 2))).toEqual({ valid: true, score: 2, reasons: [] });
    // within the strict tolerance 1e-11
    expect(k.validate(two(0.5 - 0.125e-11, 2)).valid).toBe(true);
    // within the touching tolerance, not the strict one: refused, since the space has no records
    const loose = k.validate(two(0.5 - 0.125e-9, 2));
    expect(loose.valid).toBe(false);
    expect(loose.score).toBe(2);
    expect(loose.reasons[0]).toBe(BALLS_STRICT_REASON);
    expect(loose.reasons[1]).toMatch(/^pieces 0 and 1 overlap by /);
    expect(k.validate(two(0.5 - 0.5e-8, 2)).reasons[0]).toMatch(/^pieces 0 and 1 overlap by /);
    // below the bound 2 by more than 1e-9 relative
    const low = k.validate(two(0.4995, 1.998));
    expect(low).toMatchObject({ valid: false, score: 1.998 });
    expect(low.reasons[0]).toMatch(/lower bound 2 /);
    // malformed, or the wrong number of pieces: no score
    expect(k.validate([two(0.5, 2)])).toEqual({ valid: false, score: null, reasons: ["config must be an object"] });
    expect(k.validate({ s: "2", pieces: [] })).toMatchObject({ valid: false, score: null });
    expect(k.validate({ s: 2, pieces: [[1, 0, 0]] })).toEqual({
      valid: false,
      score: null,
      reasons: ["expected 2 pieces for this problem, got 1"],
    });
    expect(k.validate({ s: 2, pieces: [[1, 0, 0], [-1, 0]] })).toMatchObject({ valid: false, score: null });
    // solids: a quaternion too small to turn anything
    const t = ballsKernel({ code: "tetinball", P: 2 });
    expect(t.validate({ s: 3, pieces: [[1, 0, 0, 1, 0, 0, 0], [-1, 0, 0, 1e-7, 0, 0, 0]] }).score).toBeNull();
    expect(t.fromConfig({ s: 3, pieces: [[1, 0, 0, 1, 0, 0, 0], [-1, 0, 0, 1e-7, 0, 0, 0]] })).toBeNull();
  });

  it("takes the test packings in and finishes them no worse", async () => {
    for (const code of BALLS_ORIGINAL_CODES)
      for (const P of [5, 13]) {
        const k = ballsKernel({ code, P });
        const config = packing(code, P);
        expect(k.validate(config).valid, code).toBe(true);
        const s = k.fromConfig(config)!;
        expect(s.size).toBe(config.s);
        expect(k.energy(s), code).toBe(0);
        // the conversion keeps the configuration valid (with unit quaternions)
        expect(strictlyValid(code, k.toConfig(s)), code).toBe(true);
        const f = k.finish(s)!;
        expect(f.score, code).toBeLessThanOrEqual(config.s * (1 + 1e-9));
        expect(strictlyValid(code, f.config), code).toBe(true);
        await tick();
      }
  });

  it("states its bound, its costs and its capabilities, and takes only the catalogue's P", () => {
    const k = ballsKernel({ code: "dodinball", P: 10 });
    expect(k.id).toBe("balls/dodinball/10");
    expect(k.space).toBe("balls");
    expect(k.dim).toBe(6);
    expect(k.capabilities).toEqual(["shape", "seeds", "swap"]);
    expect(k.bound).toBe(ballsBound(getBallsProblem("dodinball")!, 10).value);
    const b = ballsKernel({ code: "ballincub", P: 10 });
    expect(b.dim).toBe(3);
    expect(b.capabilities).toEqual(["shape", "seeds"]);
    for (const q of [k, b]) {
      expect(q.finishCost).toBeGreaterThanOrEqual(10);
      expect(q.validateCost).toBeGreaterThanOrEqual(1);
      expect(q.validateCost).toBeLessThan(q.finishCost);
    }
    expect(() => ballsKernel({ code: "nope", P: 3 })).toThrow(/unknown/);
    expect(() => ballsKernel({ code: "ballinball", P: 2.5 })).toThrow(/positive integer/);
    expect(() => ballsKernel({ code: "ballinball", P: 1 })).toThrow(/from 2 to 100/);
    expect(() => ballsKernel({ code: "ballinball", P: 101 })).toThrow(/from 2 to 100/);
    expect(ballsKernel({ code: "icoinball", P: 100 }).P).toBe(100);
  });

  it("undoes randomPose and jiggle when the piece's variables are written back", () => {
    for (const code of ["ballincub", "tetinball"]) {
      const k = ballsKernel({ code, P: 4 });
      const rng = mulberry32(8);
      const s = k.randomStart(rng);
      k.jiggle(s, 2, 1, rng);
      const before = k.toConfig(s) as BallsConfig;
      const d = k.dim;
      for (const move of ["randomPose", "jiggle"] as const) {
        const saved = s.x.slice(2 * d, 3 * d);
        if (move === "randomPose") k.randomPose(s, 2, rng);
        else k.jiggle(s, 2, 3, rng);
        expect((k.toConfig(s) as BallsConfig).pieces[2]).not.toEqual(before.pieces[2]);
        s.x.set(saved, 2 * d);
        const after = k.toConfig(s) as BallsConfig;
        for (let i = 0; i < 4; i++)
          for (let c = 0; c < after.pieces[i].length; c++)
            expect(after.pieces[i][c], move).toBeCloseTo(before.pieces[i][c], 14);
      }
    }
  });

  it("has no NaN: huge rotations stay finite, a state that blew up has energy Infinity and no finish", () => {
    const k = ballsKernel({ code: "cubinball", P: 4 });
    const s = k.randomStart(mulberry32(3));
    const g = new Float64Array(4 * k.dim + 1);
    for (const big of [1e15, 1e200]) {
      const q = k.clone(s);
      for (let i = 0; i < 4; i++) q.x.set([big, -big / 3, big / 7], 6 * i + 3);
      const e = k.energy(q, g);
      expect(Number.isFinite(e) && e >= 0).toBe(true);
      expect(g.every(Number.isFinite)).toBe(true);
      expect((k.toConfig(q) as BallsConfig).pieces.flat().every(Number.isFinite)).toBe(true);
      const f = k.finish(q);
      if (f) expect(k.validate(f.config).valid).toBe(true);
    }
    for (const code of ["cubinball", "ballinball"]) {
      const b = ballsKernel({ code, P: 4 });
      const r = b.randomStart(mulberry32(3));
      for (const bad of [NaN, Infinity]) {
        const q = b.clone(r);
        q.x[b.dim + 1] = bad;
        expect(b.energy(q, new Float64Array(4 * b.dim + 1)), code).toBe(Infinity);
        expect(b.pieceEnergy(q, 1), code).toBe(Infinity);
        expect(b.clear(q, 1, 0), code).toBe(false);
        expect(b.finish(q), code).toBeNull();
      }
    }
  });

  it("refuses an absurd start, and a run given the roomiest one the server reads stays within its budget", async () => {
    for (const code of ["ballinball", "octinball"]) {
      const k = ballsKernel({ code, P: 5 });
      const pose = (i: number, v: number) => (k.dim === 3 ? [v * (i + 1), -v, v] : [v * (i + 1), -v, v, 1, 0, 0, 0]);
      const absurd = { s: 1e300, pieces: Array.from({ length: 5 }, (_, i) => pose(i, 1e17)) };
      expect(k.fromConfig(absurd)).toBeNull();
      expect(k.validate(absurd)).toMatchObject({ valid: false, score: null });
      const roomy = { s: 1e6, pieces: Array.from({ length: 5 }, (_, i) => pose(i, 1e3)) };
      expect(k.fromConfig(roomy)).not.toBeNull();
      for (const start of [absurd, roomy]) {
        const t0 = performance.now();
        const r = runMethod(k, "penalty", { seed: 1, start, budget: { evals: 3000, time_s: 20 } });
        expect((performance.now() - t0) / 1000).toBeLessThan(30);
        expect(["evals", "time", "done", "bound"]).toContain(r.stopped);
        if (r.config) expect(k.validate(r.config).valid).toBe(true);
        await tick();
      }
    }
  });

  it("stops a finish under way: an always-true stop returns at once, with a valid input or its legalization", () => {
    for (const code of ["ballinball", "dodinball"]) {
      const k = ballsKernel({ code, P: 30 });
      const s = k.fromConfig(packing(code, 30))!;
      // a little room, so that the polish has work to do: valid, and a result of the finish by itself
      k.setSize(s, 1.05 * s.size);
      let polls = 0;
      const f = k.finish(s, () => (polls++, true));
      // the stop is read once: in the solids' legalization, or before the balls' polish
      expect(polls, code).toBe(1);
      expect(f, code).not.toBeNull();
      expect(f!.score, code).toBeLessThanOrEqual(s.size);
      expect(k.validate(f!.config).valid, code).toBe(true);
      // a stop that comes later ends the finish as well, with a valid result
      for (const at of [30, 300]) {
        let n = 0;
        const g = k.finish(s, () => ++n > at);
        expect(n, code).toBe(at + 1);
        expect(g!.score, code).toBeLessThanOrEqual(s.size);
        expect(k.validate(g!.config).valid, code).toBe(true);
      }
    }
  });
});

describe("ballsKernel: finishing", () => {
  /** Runs f and returns the StopSearch it throws (failing when it throws something else or nothing). */
  const stopOf = (f: () => unknown): StopSearch & { partial?: BallsConfig } => {
    try {
      f();
    } catch (e) {
      if (e instanceof StopSearch) return e;
      throw e;
    }
    throw new Error("the polish did not stop");
  };

  it("hands over the last iterate, legalized, from every stop in the polish, at an evaluation or between them", async () => {
    for (const [code, P] of [
      ["dodinball", 8],
      ["tetinball", 12],
      ["ballinball", 13],
      ["ballincub", 9],
    ] as const) {
      const pb = getBallsProblem(code)!;
      const k = ballsKernel({ code, P });
      const s = k.randomStart(mulberry32(2));
      squeeze(k, s, { maxIter: 60 });
      const start = k.toConfig(s) as BallsConfig;
      const solid = pb.piece !== "ball";
      const polish = (tick: () => void, poll: () => void) => {
        const o = { rng: () => 0.5, tick, poll, clearance: BALLS_CLEARANCE };
        return solid ? polishSolids(pb, start, o, SOLID_MUS.slice(3)) : polishBalls(pb, start, o, BALL_MUS.slice(3));
      };
      // count the polls and evaluations of a whole polish, and the polls before its first evaluation
      let polls = 0;
      let ticks = 0;
      let pollsBefore = -1;
      polish(
        () => {
          if (pollsBefore < 0) pollsBefore = polls;
          ticks++;
        },
        () => polls++,
      );
      expect(polls, code).toBeGreaterThan(solid ? 10 : 3);
      const cases: ["poll" | "tick", number][] = [];
      for (let n = 1; n <= polls; n += Math.max(1, Math.floor(polls / 25))) cases.push(["poll", n]);
      cases.push(["poll", polls]);
      for (let n = 1; n <= ticks; n += Math.max(1, Math.floor(ticks / 10))) cases.push(["tick", n]);
      for (const [where, n] of cases) {
        let p = 0;
        let t = 0;
        const e = stopOf(() =>
          polish(
            () => {
              if (where === "tick" && ++t === n) throw new StopSearch("aborted");
            },
            () => {
              if (where === "poll" && ++p === n) throw new StopSearch("aborted");
            },
          ),
        );
        // a solids polish stopped before its first evaluation has no iterate but the start, which the caller has
        if (solid && where === "poll" && n <= pollsBefore) continue;
        expect(e.partial, `${code} ${where} ${n}`).toBeDefined();
        expect(strictlyValid(code, e.partial), `${code} ${where} ${n}`).toBe(true);
      }
      await tick();
    }
  });

  it("polls the solids' legalization: a stop there is answered at once, and an invalid input then finishes to nothing", () => {
    // 100 dodecahedra piled within 1e-6 of the origin: the legalization scales them apart in many sweeps
    const rng = mulberry32(1);
    const pieces = Array.from({ length: 100 }, () => [
      1e-6 * rng(),
      1e-6 * rng(),
      1e-6 * rng(),
      rng() - 0.5,
      rng() - 0.5,
      rng() - 0.5,
      rng() - 0.5,
    ]);
    const k = ballsKernel({ code: "dodinball", P: 100 });
    const s = k.fromConfig({ s: 10, pieces })!;
    let n = 0;
    const f = k.finish(s, () => ++n > 5);
    expect(n).toBe(6);
    expect(f).toBeNull();
  });

  it("never finishes a valid input to something worse, or to nothing", () => {
    for (const [code, config] of [
      // legalization scales centres about the origin: from these, past the server's coordinate limit 1e4
      ["cubinball", { s: 20004, pieces: [[1e4, 0, 0, 1, 0, 0, 0], [1e4 - 1, 0, 0, 1, 0, 0, 0]] }],
      ["cubinball", { s: 20004, pieces: [[1e4, 0, 0, 1, 0, 0, 0], [1e4 - 1.5, 0, 0, 1, 0, 0, 0]] }],
      ["ballinball", { s: 20001, pieces: [[1e4, 0, 0], [1e4 - 1, 0, 0]] }],
      // optima, touching
      ["ballinball", { s: 2, pieces: [[0.5, 0, 0], [-0.5, 0, 0]] }],
      ["cubinball", { s: 2 * Math.sqrt(1.5), pieces: [[-0.5, 0, 0, 1, 0, 0, 0], [0.5, 0, 0, 1, 0, 0, 0]] }],
    ] as const) {
      const k = ballsKernel({ code, P: 2 });
      expect(strictlyValid(code, config), code).toBe(true);
      const s = k.fromConfig(config)!;
      for (const stop of [undefined, () => true]) {
        const f = k.finish(s, stop);
        expect(f, code).not.toBeNull();
        expect(f!.score, code).toBeLessThanOrEqual(config.s);
        expect(strictlyValid(code, f!.config), code).toBe(true);
      }
    }
  });

  it("polishes from the size the pieces need, whatever size the configuration states", async () => {
    for (const [code, P] of [
      ["ballinball", 30],
      ["ballincub", 10],
      ["tetinball", 10],
      ["cubinball", 12],
    ] as const) {
      const k = ballsKernel({ code, P });
      const rng = mulberry32(1);
      // overlapping pieces within 3 of the origin
      const pieces = Array.from({ length: P }, () => {
        const c = [6 * rng() - 3, 6 * rng() - 3, 6 * rng() - 3];
        return k.dim === 6 ? [...c, 1, 0, 0, 0] : c;
      });
      const at = (s: number, shift = 0) =>
        k.finish(k.fromConfig({ s, pieces: pieces.map((p) => [p[0] + shift, ...p.slice(1)]) })!)!.score;
      const tight = at(10);
      // the same start polished: the same result
      expect(at(1e6), code).toBe(tight);
      // off centre in the cube: the pieces are centred first
      if (code === "ballincub") expect(at(1e6, 500), code).toBeLessThan(1.05 * tight);
      await tick();
    }
  });

  it("has zero energy exactly when balls are valid at tolerance 0, and clear() agrees with the validator", () => {
    // a ball 2^-52 past the wall: the validator's (s - 1) - |c| is negative, while |c| + 1 - s rounds to 0
    const k = ballsKernel({ code: "ballinball", P: 2 });
    const r = 1.5 + 2 ** -52;
    const off = k.fromConfig({ s: 2.5, pieces: [[r, 0, 0], [-r, 0, 0]] })!;
    expect(strictlyValid("ballinball", k.toConfig(off))).toBe(false);
    expect(k.energy(off)).toBeGreaterThan(0);
    expect(k.clear(off, 0, 0)).toBe(false);
    // near-contact configurations a few units of rounding either side of touching, between balls and with the walls
    const rng = mulberry32(5);
    const ulps = (x: number, n: number) => x + n * 2 ** (Math.floor(Math.log2(Math.abs(x))) - 52);
    let invalid = 0;
    for (const code of ["ballinball", "ballincub"]) {
      const kc = ballsKernel({ code, P: 3 });
      const pb = getBallsProblem(code)!;
      for (let t = 0; t < 400; t++) {
        const n = () => Math.floor(7 * rng()) - 3;
        const u = [rng() - 0.5, rng() - 0.5, rng() - 0.5];
        const l = Math.hypot(u[0], u[1], u[2]);
        const a = [rng() - 0.5, rng() - 0.5, rng() - 0.5];
        // b and c on either side of a, each about 2 from it
        const d = ulps(2, n());
        const e = ulps(2, n());
        const b = a.map((v, i) => v + (d * u[i]) / l);
        const c = a.map((v, i) => v - (e * u[i]) / l);
        const pieces = [a, b, c];
        const need = Math.max(
          ...pieces.map((p) =>
            code === "ballinball" ? Math.hypot(p[0], p[1], p[2]) + 1 : 2 * Math.max(...p.map(Math.abs)) + 2,
          ),
        );
        const config = { s: ulps(need, n()), pieces };
        const st = kc.fromConfig(config)!;
        const valid = validateBalls(pb, config, { tol: 0 }).valid;
        if (!valid) invalid++;
        expect(kc.energy(st) === 0, `${code} ${t}`).toBe(valid);
        for (const tol of [0, 1e-9])
          expect(
            [0, 1, 2].every((i) => kc.clear(st, i, tol)),
            `${code} ${t} ${tol}`,
          ).toBe(validateBalls(pb, config, { tol }).valid);
      }
    }
    // both outcomes occur
    expect(invalid).toBeGreaterThan(100);
    expect(invalid).toBeLessThan(770);
  });
});

describe("ballsKernel: every method", () => {
  // each method on each problem at a small P and a budget of a few finishes, from a valid start (the test packing,
  // grown by 3 %) and from nothing: a valid result by the server's rule and by the validator at tolerance 0, and
  // never worse than the start
  for (const code of BALLS_ORIGINAL_CODES)
    it(`runs each method it offers: ${code}`, async () => {
      const P = 5;
      const k = ballsKernel({ code, P });
      const names = methodsFor(k).map((m) => m.name);
      expect(names).toEqual(
        expect.arrayContaining(["penalty", "mc_compress", "asc", "basin_hopping", "shrink_repair", "harden", "morph", "seed"]),
      );
      const start = { ...packing(code, P), s: packing(code, P).s * 1.03 };
      const s0 = k.fromConfig(start)!;
      k.setSize(s0, start.s);
      const grown = k.toConfig(s0) as BallsConfig;
      expect(k.validate(grown).valid).toBe(true);
      const evals = 3 * (k.finishCost + k.validateCost!) + 3000;
      for (const name of names) {
        for (const from of [grown, undefined]) {
          const r = runMethod(k, name, { seed: 7, ...(from ? { start: from } : {}), budget: { evals, time_s: 30 } });
          expect(r.reasons.filter((x) => x !== "no valid configuration found"), name).toEqual([]);
          if (from) expect(r.score!, name).toBeLessThanOrEqual(grown.s);
          if (r.config) {
            expect(k.validate(r.config).valid, name).toBe(true);
            expect(strictlyValid(code, r.config), name).toBe(true);
            expect(r.score, name).toBeGreaterThanOrEqual(k.bound! * (1 - 1e-9));
          } else expect(from, name).toBeUndefined();
          await tick();
        }
      }
    });
});

describe("ballsKernel: costs", () => {
  // Processor time of energy(), finish() and validate() after a squeeze, for docs/spaces/BALLS.md: medians of three
  // random starts. Run with
  //   BALLS_KERNEL_BENCH=1 npx vitest run packages/balls/test/kernel.test.ts -t costs
  // (BALLS_KERNEL_BENCH_CODES and BALLS_KERNEL_BENCH_P choose the problems and the P).
  it.skipIf(!process.env.BALLS_KERNEL_BENCH)("measures energy(), finish() and validate()", () => {
    const cpu = () => {
      const u = process.cpuUsage();
      return (u.user + u.system) / 1000;
    };
    const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const perCall = (f: () => void, ms: number) => {
      let n = 0;
      const t0 = cpu();
      while (cpu() - t0 < ms || n < 3) {
        f();
        n++;
      }
      return (cpu() - t0) / n;
    };
    const codes = (process.env.BALLS_KERNEL_BENCH_CODES ?? BALLS_ORIGINAL_CODES.join(",")).split(",");
    const Ps = (process.env.BALLS_KERNEL_BENCH_P ?? "2,3,5,10,20,40,80").split(",").map(Number);
    for (const code of codes)
      for (const P of Ps) {
        const k = ballsKernel({ code, P });
        const e: number[] = [];
        const f: number[] = [];
        const v: number[] = [];
        for (const seed of [1, 2, 3]) {
          const s = k.randomStart(mulberry32(100 * P + seed));
          squeeze(k, s, { maxIter: 100 });
          const g = new Float64Array(P * k.dim + 1);
          const em = perCall(() => k.energy(s, g), 100);
          const t0 = cpu();
          const done = k.finish(s);
          const fm = cpu() - t0;
          e.push(em);
          f.push(fm / em);
          v.push(done ? perCall(() => k.validate(done.config), 60) / em : NaN);
        }
        console.log(
          `${code} P = ${P}: energy ${median(e).toFixed(4)} ms; finish ${Math.round(median(f))} energies (finishCost ${k.finishCost}); validate ${median(v).toFixed(1)} energies (validateCost ${k.validateCost})`,
        );
      }
  });
});
