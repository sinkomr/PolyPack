import { describe, expect, it } from "vitest";
import type { BoundaryConfig, BoundaryProblem, PieceName } from "../src/index";
import { TesseractWords, getPolytope, searchBoundary, tesseractClearance, validateBoundary } from "../src/index";
import { ChainMetric, WordMetric } from "../src/search/balls";
import { chartsOf } from "../src/search/chart";
import { AlignedCubeModel, twoRings } from "../src/search/cubes";
import { mulberry32 } from "../src/search/random";
import { loadFixtures } from "./helpers";

const T = getPolytope("tesseract");
const problem = (piece: PieceName, P: number): BoundaryProblem => ({ polytope: "tesseract", piece, P });
const fixture = (piece: "balls" | "cubes", P: number): BoundaryConfig => loadFixtures(piece).find((f) => f.id.endsWith(`/${P}`))!.config;
const rel = (a: number, b: number) => Math.abs(a - b) / b;

describe("search: metrics", () => {
  const words = new WordMetric();
  const chains = new ChainMetric(T);

  it("the lattice-word metric agrees with the engine's chains on random states", () => {
    const rand = mulberry32(11);
    for (let t = 0; t < 40; t++) {
      const s = 1.45 + 1.2 * rand();
      const P = 5;
      const cells = Int32Array.from({ length: P }, () => Math.floor(rand() * 8));
      const U = Float64Array.from({ length: 3 * P }, () => (2 * rand() - 1) * (s / 2));
      expect(Math.abs(words.evaluate(cells, U, s, null, true) - chains.evaluate(cells, U, s, null, true))).toBeLessThan(1e-9);
    }
  });

  it("finds geodesics between two points of one ridge (crossing time 0 / 0)", () => {
    // regression: both ends on the crossed face; the word was dropped as unrealised
    const rand = mulberry32(3);
    let disagree = 0;
    for (let t = 0; t < 300; t++) {
      const s = 1.5 + 1.5 * rand();
      const h = s / 2;
      const c = Math.floor(rand() * 8);
      const k = Math.floor(rand() * 3);
      const tau = rand() < 0.5 ? -1 : 1;
      const cells = Int32Array.from([c, c]);
      const U = new Float64Array(6);
      for (let q = 0; q < 2; q++) {
        for (let m = 0; m < 3; m++) U[3 * q + m] = (2 * rand() - 1) * h;
        U[3 * q + k] = tau * h;
      }
      if (t % 2) {
        // the second point charted in the neighbour across face k
        const i = c >> 1;
        const ax = [0, 1, 2, 3].filter((j) => j !== i);
        const x4 = [0, 0, 0, 0];
        x4[i] = (c & 1 ? 1 : -1) * h;
        ax.forEach((g, m) => (x4[g] = U[3 + m]));
        const j = ax[k];
        cells[1] = 2 * j + (tau > 0 ? 1 : 0);
        [0, 1, 2, 3].filter((g) => g !== j).forEach((g, m) => (U[3 + m] = x4[g]));
      }
      if (Math.abs(words.evaluate(cells, U, s, null, true) - chains.evaluate(cells, U, s, null, true)) > 1e-9) disagree++;
    }
    expect(disagree).toBe(0);
  });

  it("matches TesseractWords and the closed-form clearance on random points", () => {
    const tw = new TesseractWords(2);
    const rand = mulberry32(5);
    for (let t = 0; t < 300; t++) {
      const s = 1.45 + 1.2 * rand();
      const cells = Int32Array.from([Math.floor(rand() * 8), Math.floor(rand() * 8)]);
      const U = Float64Array.from({ length: 6 }, () => (2 * rand() - 1) * (s / 2));
      const a = [...U.slice(0, 3)];
      const b = [...U.slice(3)];
      const d = tw.distance(cells[0], a, cells[1], b, s);
      const expected = Math.max(1 - tesseractClearance(a, s), 1 - tesseractClearance(b, s), 2 - d, 2 - tw.loop(cells[0], a, s), 2 - tw.loop(cells[1], b, s));
      expect(Math.abs(words.evaluate(cells, U, s, null, true) - expected)).toBeLessThan(1e-12);
    }
  });

  it("has analytic gradients (finite differences)", () => {
    const rand = mulberry32(9);
    for (const metric of [words, chains]) {
      const s = 1.9;
      const P = 6;
      const cells = Int32Array.from({ length: P }, () => Math.floor(rand() * 8));
      const U = Float64Array.from({ length: 3 * P }, () => (2 * rand() - 1) * 0.8 * (s / 2));
      const g = new Float64Array(3 * P);
      metric.evaluate(cells, U, s, g, false);
      for (let k = 0; k < 3 * P; k++) {
        const e = 1e-7;
        const Up = Float64Array.from(U);
        const Um = Float64Array.from(U);
        Up[k] += e;
        Um[k] -= e;
        const fd = (metric.evaluate(cells, Up, s, null, false) - metric.evaluate(cells, Um, s, null, false)) / (2 * e);
        expect(Math.abs(fd - g[k])).toBeLessThan(1e-5 * Math.max(1, Math.abs(g[k])));
      }
    }
  });
});

describe("search: aligned cubes", () => {
  it("has an analytic gradient (finite differences)", () => {
    const rand = mulberry32(4);
    const model = new AlignedCubeModel(T, 12, chartsOf(T));
    for (let t = 0; t < 10; t++) {
      const s = 1.2 + 0.6 * rand();
      const cells = Int32Array.from({ length: 12 }, () => Math.floor(rand() * 8));
      const U = Float64Array.from({ length: 36 }, () => (2 * rand() - 1) * (s / 2));
      const g = new Float64Array(36);
      model.energy({ cells, U }, s, g);
      for (let k = 0; k < 36; k++) {
        const e = 1e-7;
        const Up = Float64Array.from(U);
        const Um = Float64Array.from(U);
        Up[k] += e;
        Um[k] -= e;
        const tmp = new Float64Array(36);
        const fd = (model.energy({ cells, U: Up }, s, tmp) - model.energy({ cells, U: Um }, s, tmp)) / (2 * e);
        expect(Math.abs(fd - g[k])).toBeLessThan(1e-5 * Math.max(1, Math.abs(g[k])));
      }
    }
  });

  it("its exact rule agrees with the validator on the research layouts and below them", () => {
    for (const P of [9, 11, 12, 16]) {
      const config = fixture("cubes", P);
      const model = new AlignedCubeModel(T, P, chartsOf(T));
      const st = model.stateOf(config)!;
      expect(model.violation(st, config.s)).toBeLessThanOrEqual(0);
      // squeezed by 1e-3: both must see the overlap
      const k = 1 - 1e-3;
      const small = { cells: st.cells, U: st.U.map((x) => x * k) };
      expect(model.violation(small, config.s * k)).toBeGreaterThan(0);
      expect(validateBoundary(problem("cube", P), { s: config.s * k, pieces: model.pieces(small, config.s * k) }).ok).toBe(false);
    }
  });
});

describe("search: charts", () => {
  it("moving across a ridge and back returns to the start, with an orthogonal map", () => {
    const charts = chartsOf(T);
    const rand = mulberry32(2);
    const out = new Float64Array(3);
    const back = new Float64Array(3);
    const M = new Float64Array(9);
    const M2 = new Float64Array(9);
    for (let t = 0; t < 200; t++) {
      const s = 1 + rand();
      const h = s / 2;
      const c = Math.floor(rand() * 8);
      const U = Float64Array.from({ length: 3 }, () => (2 * rand() - 1) * h * 0.9);
      const v = [0, 1, 2].map(() => (2 * rand() - 1) * s);
      const c2 = charts.move(c, U, 0, v[0], v[1], v[2], s, out, 0, M, 0);
      if (c2 < 0) continue;
      // the reverse direction at the end point is -M v
      const w = [0, 1, 2].map((r) => -(M[3 * r] * v[0] + M[3 * r + 1] * v[1] + M[3 * r + 2] * v[2]));
      const c3 = charts.move(c2, out, 0, w[0], w[1], w[2], s, back, 0, M2, 0);
      expect(c3).toBe(c);
      for (let k = 0; k < 3; k++) expect(back[k]).toBeCloseTo(U[k], 9);
      expect(Math.abs(out[0]) <= h && Math.abs(out[1]) <= h && Math.abs(out[2]) <= h).toBe(true);
    }
  });

  it("the two rings are valid at s = max(1, ceil(P/2)/4) (1 + 1e-6)", () => {
    const charts = chartsOf(T);
    for (const P of [8, 11, 12, 16]) {
      const nA = Math.ceil(P / 2);
      const s = Math.max(1, nA / 4) * (1 + 1e-6);
      const st = twoRings(charts, s, nA, P - nA, 0.37);
      const config = { s, pieces: Array.from({ length: P }, (_, q) => ({ cell: st.cells[q], u: [...st.U.slice(3 * q, 3 * q + 3)] })) };
      expect(validateBoundary(problem("cube", P), config).reasons).toEqual([]);
    }
  });
});

describe("search: behaviour", () => {
  it("is deterministic for a given problem, start, seed and evaluation budget", () => {
    for (const [piece, P, evals] of [
      ["ball", 5, 40_000],
      ["cube", 9, 40_000],
    ] as const) {
      const a = searchBoundary(problem(piece, P), { seed: 7, budget: { evals } });
      const b = searchBoundary(problem(piece, P), { seed: 7, budget: { evals } });
      expect(a.config).not.toBeNull();
      expect(b.score).toBe(a.score);
      expect(b.config).toEqual(a.config);
      expect(b.evals).toBe(a.evals);
      expect(b.trace.map((e) => [e.evals, e.score, e.source, e.stage])).toEqual(a.trace.map((e) => [e.evals, e.score, e.source, e.stage]));
      const c = searchBoundary(problem(piece, P), { seed: 8, budget: { evals } });
      expect(c.trace.map((e) => e.evals)).not.toEqual(a.trace.map((e) => e.evals));
    }
  });

  it("honours shouldStop within 100 ms", () => {
    for (const piece of ["ball", "cube"] as const) {
      const t0 = performance.now();
      let stopAt = Infinity;
      const r = searchBoundary(problem(piece, 12), {
        seed: 1,
        budget: { evals: 1e12 },
        shouldStop: () => {
          const t = performance.now();
          if (t - t0 > 300 && stopAt === Infinity) stopAt = t;
          return stopAt !== Infinity;
        },
      });
      const latency = performance.now() - stopAt;
      expect(r.ended).toBe("stopped");
      expect(latency).toBeLessThan(100);
    }
  });

  it("ends on time_s with the given clock", () => {
    // the clock advances 1 ms per reading, and it is read once per evaluation
    let t = 0;
    const r = searchBoundary(problem("ball", 6), { seed: 1, budget: { evals: 1e12, time_s: 5 }, now: () => (t += 0.001) });
    expect(r.ended).toBe("time");
    expect(t).toBeGreaterThan(5);
    expect(t).toBeLessThan(5.01);
    expect(r.evals).toBeGreaterThan(3000);
  });

  it("never returns worse than a valid start, and returns the start itself with no budget", () => {
    for (const [piece, P] of [
      ["ball", 9],
      ["cube", 11],
    ] as const) {
      const start = fixture(piece === "ball" ? "balls" : "cubes", P);
      const none = searchBoundary(problem(piece, P), { seed: 3, start, budget: { evals: 0 } });
      expect(none.score).toBe(start.s);
      expect(none.config).toEqual(start);
      expect(none.startScore).toBe(start.s);
      const some = searchBoundary(problem(piece, P), { seed: 3, start, budget: { evals: 3000 } });
      expect(some.score!).toBeLessThanOrEqual(start.s);
      // and a valid start a little too large comes back no larger, polished when the budget allows
      const big = { s: start.s * 1.01, pieces: start.pieces.map((p) => ({ ...p, u: p.u.map((x) => x * 1.01) })) };
      const r = searchBoundary(problem(piece, P), { seed: 3, start: big, budget: { evals: 60_000 } });
      expect(r.score!).toBeLessThan(big.s);
      expect(validateBoundary(problem(piece, P), r.config!, { tol: 0 }).ok).toBe(true);
    }
  });

  it("does not return an invalid start", () => {
    const start = fixture("balls", 9);
    const bad = { s: start.s * 0.99, pieces: start.pieces.map((p) => ({ ...p, u: p.u.map((x) => x * 0.99) })) };
    const r = searchBoundary(problem("ball", 9), { seed: 1, start: bad, budget: { evals: 0 } });
    expect(r.config).toBeNull();
    expect(r.startScore).toBeNull();
  });

  it("reports only valid configurations (tol 0), each better than the last", () => {
    for (const [piece, P] of [
      ["ball", 7],
      ["cube", 10],
    ] as const) {
      const seen: { config: BoundaryConfig; score: number }[] = [];
      const r = searchBoundary(problem(piece, P), { seed: 5, budget: { evals: 50_000 }, onImprove: (b) => seen.push(b) });
      expect(seen.length).toBeGreaterThan(0);
      for (let k = 0; k < seen.length; k++) {
        expect(validateBoundary(problem(piece, P), seen[k].config, { tol: 0 }).reasons).toEqual([]);
        expect(seen[k].config.s).toBe(seen[k].score);
        if (k) expect(seen[k].score).toBeLessThan(seen[k - 1].score);
      }
      expect(r.score).toBe(seen[seen.length - 1].score);
      expect(validateBoundary(problem(piece, P), r.config!, { tol: 1e-9 }).ok).toBe(true);
    }
  });
});

describe("search: quick convergence", () => {
  it("balls: P = 4 reaches 1 + 1/sqrt 2, and P = 2 ends on the bound sqrt 2", () => {
    const r = searchBoundary(problem("ball", 4), { seed: 1, budget: { evals: 150_000 } });
    expect(rel(r.score!, 1 + Math.SQRT1_2)).toBeLessThan(1e-9);
    const two = searchBoundary(problem("ball", 2), { seed: 1, budget: { evals: 150_000 } });
    expect(two.ended).toBe("bound");
    expect(rel(two.score!, Math.SQRT2)).toBeLessThan(1e-9);
  });

  it("balls on the generic chain metric: P = 1 ends on sqrt 2, and a valid start is kept or bettered", () => {
    const one = searchBoundary(problem("ball", 1), { seed: 1, budget: { evals: 20_000 }, ballMetric: "chains" });
    expect(one.ended).toBe("bound");
    expect(rel(one.score!, Math.SQRT2)).toBeLessThan(1e-9);
    const start = fixture("balls", 4);
    const r = searchBoundary(problem("ball", 4), { seed: 1, start, budget: { evals: 400 }, ballMetric: "chains" });
    expect(r.score!).toBeLessThanOrEqual(start.s);
    expect(validateBoundary(problem("ball", 4), r.config!, { tol: 1e-9 }).ok).toBe(true);
  });

  it("cubes: P = 9 reaches 5/4, and P = 8 ends on s = 1", () => {
    const r = searchBoundary(problem("cube", 9), { seed: 1, budget: { evals: 150_000 } });
    expect(rel(r.score!, 1.25)).toBeLessThan(1e-6);
    const eight = searchBoundary(problem("cube", 8), { seed: 1, budget: { evals: 150_000 } });
    expect(eight.ended).toBe("bound");
    expect(rel(eight.score!, 1)).toBeLessThan(1e-9);
  });
});
