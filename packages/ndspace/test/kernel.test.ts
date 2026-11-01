import { beforeAll, describe, expect, it } from "vitest";
import { checkKernel } from "@polypack/methods/contract";
import { mulberry32, relax, runMethod } from "@polypack/methods";
import { cayleyMatrix, loadPolytope, poseOfMatrix } from "@polypack/ndim";
import { ND_DIMENSIONS, ND_P_RANGE, ndShapes } from "../src/catalogue";
import { ndKernel } from "../src/kernel";
import { robustPose } from "../src/pose";
import { ndCheck, ndProblemOf } from "../src/validate";
import { gridP, gridPacking } from "./helpers";

beforeAll(async () => {
  await loadPolytope("8:421");
});

/**
 * A spread of problems over every dimension: polytope and ball pieces and containers, small and large polytopes. In 7D and above
 * the core's EPA often stops at its cap on overlapping polytope pairs (the energy then uses a depth bound, which is not smooth), so
 * the polytope pairs of the contract run here are those where it converges; ball pieces are exact in every dimension.
 */
const SPREAD: [number, string, string, number][] = [
  [4, "cube", "cube", 5],
  [4, "24cell", "ball", 3],
  [4, "ball", "600cell", 4],
  [4, "simplex", "ortho", 4],
  [4, "120cell", "120cell", 2],
  [5, "demi", "cube", 4],
  [5, "ball", "ball", 5],
  [6, "221", "122", 3],
  [6, "ortho", "ball", 3],
  [7, "ortho", "cube", 3],
  [7, "ball", "demi", 4],
  [8, "ortho", "ball", 2],
  [8, "ball", "421", 3],
  [9, "ball", "cube", 3],
  [10, "simplex", "cube", 2],
  [10, "ball", "ortho", 3],
];

describe("the nD kernel", () => {
  for (const [d, a, b, P] of SPREAD)
    it(`passes the kernel contract: ${d}D ${a} in ${b}, P = ${P}`, () => {
      expect(checkKernel(() => ndKernel({ d, piece: a, container: b, P }), { seed: d * 10 + P, states: 3 })).toEqual(
        [],
      );
    });

  it("refuses a P outside the dimension's range, an unknown shape and a polytope that is not loaded", () => {
    expect(() => ndKernel({ d: 7, piece: "cube", container: "cube", P: 21 })).toThrow(RangeError);
    expect(() => ndKernel({ d: 4, piece: "cube", container: "cube", P: 1 })).toThrow(RangeError);
    expect(() => ndKernel({ d: 4, piece: "demi", container: "cube", P: 3 })).toThrow(/unknown/);
  });

  it("describes itself", () => {
    const k = ndKernel({ d: 5, piece: "demi", container: "cube", P: 6 });
    expect(k).toMatchObject({ space: "ndim", id: "ndim/5/demi/cube/6", P: 6, dim: 15, globals: 0 });
    expect(k.capabilities).toEqual(["shape", "seeds", "swap"]);
    expect(k.bound).toBeGreaterThan(0);
    const balls = ndKernel({ d: 5, piece: "ball", container: "cube", P: 6 });
    expect(balls).toMatchObject({ dim: 5 });
    expect(balls.capabilities).toEqual(["shape", "seeds"]);
  });

  it("has an energy whose full gradient matches differences, for every kind of pair and wall", () => {
    for (const [d, a, b, P] of [
      [4, "24cell", "cube", 2],
      [5, "simplex", "ortho", 2],
      [5, "demi", "ball", 2],
      [6, "ortho", "ball", 2],
      [4, "ball", "ortho", 2],
    ] as [number, string, string, number][]) {
      const k = ndKernel({ d, piece: a, container: b, P });
      const rng = mulberry32(d + P);
      for (const shape of [1, 0.6]) {
        const s = k.randomStart(rng);
        k.setShape!(s, shape);
        // pieces close together and the container tight: pair and wall terms
        k.setSize(s, s.size * 0.3);
        for (let i = 0; i < P * k.dim; i++) s.x[i] *= 0.2;
        const n = P * k.dim;
        const g = new Float64Array(n + 1);
        const e = k.energy(s, g);
        expect(e, `${d} ${a} ${b}`).toBeGreaterThan(0);
        for (let i = 0; i <= n; i++) {
          const h = 1e-6;
          const p = k.clone(s);
          const m = k.clone(s);
          if (i === n) {
            p.size += h;
            m.size -= h;
          } else {
            p.x[i] += h;
            m.x[i] -= h;
          }
          const fd = (k.energy(p) - k.energy(m)) / (2 * h);
          expect(Math.abs(fd - g[i]), `${d} ${a} ${b} shape ${shape} entry ${i}: ${g[i]} against ${fd}`).toBeLessThan(
            1e-4 * Math.max(1, Math.abs(fd)),
          );
        }
      }
    }
  });

  it("has a gradient in rotation at a chart that is not centred (S far from 0)", () => {
    const k = ndKernel({ d: 4, piece: "cube", container: "cube", P: 2 });
    const rng = mulberry32(8);
    const s = k.randomStart(rng);
    k.setSize(s, s.size * 0.3);
    for (let i = 0; i < k.dim; i++) s.x[i] = i < 4 ? 0.1 * i : 0.3 * (rng() - 0.5) * 3;
    for (let i = 0; i < k.dim; i++) s.x[k.dim + i] = i < 4 ? -0.1 * i : 0.3 * (rng() - 0.5) * 3;
    const g = new Float64Array(2 * k.dim + 1);
    k.energy(s, g);
    for (let i = 0; i < 2 * k.dim; i++) {
      const p = k.clone(s);
      const m = k.clone(s);
      p.x[i] += 1e-6;
      m.x[i] -= 1e-6;
      const fd = (k.energy(p) - k.energy(m)) / 2e-6;
      expect(Math.abs(fd - g[i])).toBeLessThan(1e-4 * Math.max(1, Math.abs(fd)));
    }
  });

  it("finishes to a valid configuration in the server's rule, the smallest by scaling, and keeps one that is already valid", () => {
    for (const [d, a, b, P] of [
      [4, "cube", "cube", 6],
      [5, "demi", "ball", 3],
      [6, "ball", "ortho", 4],
    ] as [number, string, string, number][]) {
      const prob = { d, piece: a, container: b, P };
      const k = ndKernel(prob);
      const s = k.randomStart(mulberry32(P));
      relax(k, s, { maxIter: 200 });
      const f = k.finish(s)!;
      expect(f, `${d}D ${a} in ${b}`).not.toBeNull();
      expect(ndCheck(prob, f.config as never, 0)).toEqual([]);
      expect(k.validate(f.config).valid).toBe(true);
      expect(f.score).toBeGreaterThanOrEqual(k.bound! * (1 - 1e-9));
      // a valid packing finishes to itself, to 1e-12
      const again = k.finish(k.fromConfig(f.config)!)!;
      expect(again.score).toBeLessThanOrEqual(f.score);
      expect(again.score).toBeGreaterThan(f.score * (1 - 1e-10));
      // a hair smaller is not valid
      const c = f.config as { s: number; pieces: number[][] };
      const f6 = 1 - 1e-6;
      const smaller = { s: c.s * f6, pieces: c.pieces.map((p) => p.map((v, i) => (i < d ? v * f6 : v))) };
      expect(ndCheck(prob, smaller, 0).length).toBeGreaterThan(0);
    }
  });

  it("validates as the server does: bound, form, geometry", () => {
    const prob = { d: 4, piece: "cube", container: "cube", P: 16 };
    const k = ndKernel(prob);
    const { config } = gridPacking(4, "cube", 16);
    expect(k.validate(config)).toMatchObject({ valid: true, score: config.s });
    // below the volume bound (2 for 16 hypercubes)
    expect(k.validate({ ...config, s: 1.5 })).toMatchObject({ valid: false });
    expect(k.validate({ ...config, s: 1.5 }).reasons[0]).toMatch(/below the lower bound/);
    expect(k.validate({ s: 2 })).toMatchObject({ valid: false, score: null });
    expect(k.validate(null).valid).toBe(false);
    expect(k.fromConfig({ s: 2, pieces: [] })).toBeNull();
    expect(k.fromConfig(config)).not.toBeNull();
  });

  it("starts from the lattice cuts: valid, with k^d hypercubes at the exact grid", () => {
    // 2^d hypercubes in a hypercube: the seed is the grid, at s = 2
    for (const d of [4, 5, 6]) {
      const prob = { d, piece: "cube", container: "cube", P: 2 ** d <= ND_P_RANGE[d][1] ? 2 ** d : gridP(d) };
      const k = ndKernel(prob);
      const seeds = k.seeds!(mulberry32(1), 4);
      expect(seeds.length).toBe(4);
      for (const st of seeds) {
        const cfg = k.toConfig(st) as { s: number; pieces: number[][] };
        expect(ndCheck(prob, cfg, 1e-9), `${d}D`).toEqual([]);
        expect(k.energy(st)).toBeLessThan(1e-20);
      }
      if (prob.P === 2 ** d) expect((k.toConfig(seeds[0]) as { s: number }).s).toBeLessThan(2 * (1 + 1e-6));
    }
    // balls: the D_d and E8 lattices pack better than the cubic grid in a ball
    const k8 = ndKernel({ d: 8, piece: "ball", container: "ball", P: 17 });
    const seeds = k8.seeds!(mulberry32(2), 4);
    const best = Math.min(...seeds.map((st) => st.size));
    expect(best).toBeGreaterThan(k8.bound! * (1 - 1e-9));
    for (const st of seeds) expect(k8.validate(k8.toConfig(st)).valid).toBe(true);
  });

  it("has seeds that are valid for a polytope in every other kind of container", () => {
    for (const [d, a, b, P] of [
      [4, "simplex", "ball", 8],
      [6, "ortho", "demi", 6],
      [7, "demi", "ortho", 5],
      [9, "cube", "simplex", 4],
    ] as [number, string, string, number][]) {
      const k = ndKernel({ d, piece: a, container: b, P });
      for (const st of k.seeds!(mulberry32(3), 3)) {
        const v = k.validate(k.toConfig(st));
        expect(v.valid, `${d}D ${a} in ${b}: ${v.reasons.join("; ")}`).toBe(true);
      }
    }
  });

  it("runs the generic methods and Auto's method on a small problem, to a result the server accepts", () => {
    const prob = { d: 4, piece: "cube", container: "cube", P: 4 };
    const k = ndKernel(prob);
    for (const method of ["penalty", "basin_hopping", "seed"]) {
      const r = runMethod(k, method, { seed: 3, budget: { evals: 800 } });
      expect(r.config, method).not.toBeNull();
      expect(ndCheck(prob, r.config as never, 1e-9), method).toEqual([]);
      expect(r.score!, method).toBeGreaterThanOrEqual(k.bound! * (1 - 1e-9));
      // four hypercubes fit in a hypercube of edge 2
      expect(r.score!, method).toBeLessThan(2.5);
    }
  });

  it("converts a rotation to a pose that reproduces it, also at a half turn where the core's solve is singular", () => {
    // a signed permutation of determinant 1 with eigenvalue -1: (x0, x1, x2, x3) -> (x1, x2, -x0, -x3)
    const R = Float64Array.from([0, 1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 0, 0, 0, 0, -1]);
    for (const noise of [0, 1e-17, 1e-16]) {
      const N = Float64Array.from(R, (v, i) => v + (i % 3 === 0 ? noise : -noise));
      const pose = robustPose([1, 2, 3, 4], N, 4)!;
      expect(pose).not.toBeNull();
      const back = cayleyMatrix(pose.slice(4, 10), 4, pose[10]);
      for (let i = 0; i < 16; i++) expect(Math.abs(back[i] - R[i])).toBeLessThan(1e-12);
    }
    // a random rotation: the same matrix as the core's conversion
    const params = [0.3, -0.2, 0.5, 0.1, 0.4, -0.6];
    const M = cayleyMatrix(params, 4, 0);
    const pose = robustPose([0, 0, 0, 0], M, 4)!;
    const back = cayleyMatrix(pose.slice(4, 10), 4, pose[10]);
    for (let i = 0; i < 16; i++) expect(Math.abs(back[i] - M[i])).toBeLessThan(1e-12);
    expect(poseOfMatrix([0, 0, 0, 0], M, 4).length).toBe(pose.length);
  });

  it("builds a kernel for every problem of a spread over the dimensions' shapes", () => {
    let n = 0;
    for (const d of ND_DIMENSIONS) {
      const shapes = ndShapes(d);
      for (const a of shapes.filter((_, i) => i % 2 === 0)) {
        const b = shapes[(shapes.indexOf(a) + 1) % shapes.length];
        const k = ndKernel({ d, piece: a, container: b, P: ND_P_RANGE[d][0] + 1 });
        expect(k.P).toBe(ND_P_RANGE[d][0] + 1);
        expect(ndProblemOf({ d, piece: a, container: b }).container).toBe(b === "ball" ? "ball" : `${d}:${b}`);
        n++;
      }
    }
    expect(n).toBeGreaterThan(15);
  });
});
