import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type KernelState,
  type MethodContext,
  type SpaceKernel,
  methodsFor,
  mulberry32,
  registerMethod,
  runMethod,
  squeeze,
} from "@polypack/methods";
import { checkKernel } from "@polypack/methods/contract";
import { describe, expect, it } from "vitest";
import type { BoundaryConfig, PieceName } from "../src/index";
import { BOUNDARY_SERVER_RULE, boundaryBound, boundaryKernel, getPolytope, validateBoundary } from "../src/index";
import { trace4d } from "./helpers";

const T = getPolytope("tesseract");
const problem = (piece: PieceName, P: number) => ({ polytope: "tesseract" as const, piece, P });
const kernel = (piece: PieceName, P: number) => boundaryKernel(problem(piece, P));
const PIECES = ["ball", "cube"] as const;

interface Rec {
  id: string;
  piece: PieceName;
  P: number;
  score_cert: number;
  bound: { value: number };
  config: BoundaryConfig;
}
const records = (): Rec[] =>
  JSON.parse(readFileSync(fileURLToPath(new URL("../../../data/boundary/records.json", import.meta.url)), "utf8"))
    .records;

/** A random start shrunk below its edge with every piece pushed up to 1.5 s, so that overlaps abound and paths cross ridges. */
function displaced(k: SpaceKernel, rng: () => number): KernelState {
  const s = k.randomStart(rng);
  k.setSize(s, s.size * (0.6 + 0.4 * rng()));
  for (let i = 0; i < k.P; i++) k.jiggle(s, i, (1.5 * s.size) / k.steps[0], rng);
  return s;
}

describe("boundary kernel: the contract", () => {
  for (const piece of PIECES)
    it(`${piece}s pass checkKernel at P = 1, 4, 9 and 16`, () => {
      for (const P of [1, 4, 9, 16]) expect(checkKernel(() => kernel(piece, P), { seed: P })).toEqual([]);
    });

  it("cubes beyond the catalogue pass it too (random starts roomy enough at P = 26, 31 and 64)", () => {
    for (const P of [26, 31, 64]) expect(checkKernel(() => kernel("cube", P), { seed: P, states: 2 })).toEqual([]);
  });
});

describe("boundary kernel: energy", () => {
  it("has the gradient of its weighted energy, in every displacement and the size, across ridges", () => {
    for (const piece of PIECES)
      for (const P of [3, 9]) {
        const k = kernel(piece, P);
        const rng = mulberry32(P);
        const n = 3 * P;
        for (let t = 0; t < 6; t++) {
          const s = displaced(k, rng);
          const w = Float64Array.from({ length: P }, () => 0.5 + rng());
          const g = new Float64Array(n + 1);
          if (!(k.energy(s, g, w) > 1e-8)) continue;
          for (let i = 0; i <= n; i++) {
            const h = 1e-7 * (i === n ? s.size : 1);
            const p = k.clone(s);
            const m = k.clone(s);
            if (i === n) {
              p.size += h;
              m.size -= h;
            } else {
              p.x[i] += h;
              m.x[i] -= h;
            }
            const fd = (k.energy(p, undefined, w) - k.energy(m, undefined, w)) / (2 * h);
            expect(Math.abs(fd - g[i])).toBeLessThan(1e-5 * Math.max(1, Math.abs(fd)));
          }
        }
      }
  });

  it("is linear in the weights, and a piece's energy is its own terms and its pairs", () => {
    for (const piece of PIECES) {
      const P = 6;
      const k = kernel(piece, P);
      const one = kernel(piece, 1);
      const two = kernel(piece, 2);
      const rng = mulberry32(21);
      for (let t = 0; t < 5; t++) {
        const s = displaced(k, rng);
        const E = k.energy(s);
        // the weights e_i add up to all ones
        let sum = 0;
        for (let i = 0; i < P; i++)
          sum += k.energy(
            s,
            undefined,
            Float64Array.from({ length: P }, (_, j) => (j === i ? 1 : 0)),
          );
        expect(Math.abs(sum - E)).toBeLessThanOrEqual(1e-12 * Math.max(1, E));
        // brute force from one- and two-piece problems at the same s
        const c = k.toConfig(s) as BoundaryConfig;
        const alone = c.pieces.map((p) => one.energy(one.fromConfig({ s: c.s, pieces: [p] })!));
        const w = Float64Array.from({ length: P }, () => 0.5 + rng());
        for (let i = 0; i < P; i++) {
          let plain = alone[i];
          let weighted = w[i] * alone[i];
          for (let j = 0; j < P; j++) {
            if (j === i) continue;
            const pair =
              two.energy(two.fromConfig({ s: c.s, pieces: [c.pieces[i], c.pieces[j]] })!) - alone[i] - alone[j];
            plain += pair;
            weighted += ((w[i] + w[j]) / 2) * pair;
          }
          expect(Math.abs(k.pieceEnergy(s, i) - plain)).toBeLessThanOrEqual(1e-9 * Math.max(1, plain));
          expect(Math.abs(k.pieceEnergy(s, i, w) - weighted)).toBeLessThanOrEqual(1e-9 * Math.max(1, weighted));
          // clear at tolerance 0 exactly when the piece has no energy
          expect(k.clear(s, i, 0)).toBe(k.pieceEnergy(s, i) === 0);
        }
      }
    }
  });
});

describe("boundary kernel: charts and sizes", () => {
  it("moves a piece along the straight path an independent R^4 trace follows, however long", () => {
    const rng = mulberry32(5);
    for (const piece of PIECES) {
      const k = kernel(piece, 1);
      let checked = 0;
      for (let t = 0; t < 60; t++) {
        const s = 1.5 + rng();
        const cell = Math.floor(rng() * 8);
        const u = [0, 1, 2].map(() => (2 * rng() - 1) * 0.45 * s);
        const dir = [0, 1, 2].map(() => 2 * rng() - 1);
        const norm = Math.hypot(...dir);
        // up to 60 edges: some paths cross more than 64 ridges, which Charts.move alone refuses
        const L = s * (0.5 + 59.5 * rng());
        const ref = trace4d(T, s, cell, u, dir, L);
        if (!ref) continue;
        const st = k.fromConfig({ s, pieces: [{ cell, u }] })!;
        for (let m = 0; m < 3; m++) st.x[m] = (dir[m] / norm) * L;
        const p = (k.toConfig(st) as BoundaryConfig).pieces[0];
        expect(p.cell).toBe(ref.cell);
        for (let m = 0; m < 3; m++) expect(Math.abs(p.u[m] - ref.u[m])).toBeLessThan(1e-8);
        checked++;
      }
      expect(checked).toBeGreaterThan(40);
    }
  });

  it("setSize scales every centre, rebase keeps the configuration, and moves touch one piece", () => {
    const rng = mulberry32(8);
    for (const piece of PIECES) {
      const k = kernel(piece, 7);
      const s = displaced(k, rng);
      const before = k.toConfig(s) as BoundaryConfig;
      const big = k.clone(s);
      k.setSize(big, s.size * 1.3);
      const after = k.toConfig(big) as BoundaryConfig;
      expect(after.s).toBe(s.size * 1.3);
      after.pieces.forEach((p, i) => {
        expect(p.cell).toBe(before.pieces[i].cell);
        for (let m = 0; m < 3; m++) expect(Math.abs(p.u[m] - 1.3 * before.pieces[i].u[m])).toBeLessThan(1e-9);
      });
      const r = k.clone(big);
      k.rebase(r);
      expect([...r.x].every((v) => v === 0)).toBe(true);
      expect(k.toConfig(r)).toEqual(after);
      // randomPose and jiggle move piece 3 only, through its x alone: writing it back undoes them
      for (const move of [(q: KernelState) => k.randomPose(q, 3, rng), (q: KernelState) => k.jiggle(q, 3, 0.7, rng)]) {
        const q = k.clone(big);
        const x = q.x.slice(9, 12);
        const aux = k.clone(q).aux;
        move(q);
        expect(q.aux).toEqual(aux);
        const c = k.toConfig(q) as BoundaryConfig;
        c.pieces.forEach((p, i) =>
          i === 3 ? expect(p).not.toEqual(after.pieces[i]) : expect(p).toEqual(after.pieces[i]),
        );
        q.x.set(x, 9);
        expect(k.toConfig(q)).toEqual(after);
      }
    }
  });
});

describe("boundary kernel: configurations", () => {
  it("reads only what its model can judge: no ball rotations, cube rotations that are symmetries", () => {
    const ball = kernel("ball", 1);
    const cube = kernel("cube", 1);
    const piece = { cell: 3, u: [0.1, -0.2, 0.3] };
    for (const bad of [
      null,
      {},
      { s: 2 },
      { s: -1, pieces: [piece] },
      { s: 2, pieces: [] },
      { s: 2, pieces: [{ cell: 8, u: [0, 0, 0] }] },
      { s: 2, pieces: [{ cell: 0, u: [0, 0] }] },
    ])
      for (const k of [ball, cube]) expect(k.fromConfig(bad)).toBeNull();
    expect(ball.fromConfig({ s: 2, pieces: [{ ...piece, q: [1, 0, 0, 0] }] })).toBeNull();
    // a quarter turn about a local axis is a symmetry of the cube; an eighth of a turn is not
    const c45 = Math.SQRT1_2;
    expect(cube.fromConfig({ s: 2, pieces: [{ ...piece, q: [c45, 0, 0, c45] }] })).not.toBeNull();
    const turned = { s: 2, pieces: [{ ...piece, q: [Math.cos(Math.PI / 8), 0, 0, Math.sin(Math.PI / 8)] }] };
    expect(cube.fromConfig(turned)).toBeNull();
    // validate is the server's rule: it judges turned cubes too
    expect(cube.validate(turned)).toEqual({ valid: true, score: 2, reasons: [] });
    expect(validateBoundary(problem("cube", 1), turned, BOUNDARY_SERVER_RULE).ok).toBe(true);
  });

  it("converts and validates every research record, and finishes each at or below its score", () => {
    expect(records().length).toBe(32);
    for (const r of records()) {
      const k = kernel(r.piece, r.P);
      const v = k.validate(r.config);
      expect(v.valid).toBe(true);
      expect(v.score).toBe(r.score_cert);
      const st = k.fromConfig(r.config)!;
      expect(st.size).toBe(r.config.s);
      expect(k.energy(st)).toBe(0);
      const f = k.finish(st)!;
      expect(f.score).toBeLessThanOrEqual(r.score_cert * (1 + 1e-9));
      expect(validateBoundary(problem(r.piece, r.P), f.config, { tol: 0 }).reasons).toEqual([]);
    }
  });

  it("validates as the server does: the records' lower bound and its slack, the score, the server's words", () => {
    for (const r of records()) expect(boundaryBound(r.piece, r.P)).toBe(r.bound.value);
    // the cube/8 record shrunk by 1.1e-9: the validator alone takes it (tolerance 1e-9), the bound does not
    const eight = records().find((r) => r.id === "boundary/tesseract/cube/8")!;
    const k = kernel("cube", 8);
    for (const [f, valid] of [
      [1 - 0.9e-9, true],
      [1 - 1.1e-9, false],
    ] as const) {
      const s = eight.config.s * f;
      const c = { s, pieces: eight.config.pieces };
      expect(validateBoundary(problem("cube", 8), c, BOUNDARY_SERVER_RULE).ok).toBe(true);
      expect(k.validate(c)).toEqual(
        valid
          ? { valid: true, score: s, reasons: [] }
          : { valid: false, score: s, reasons: [`the size ${s} is below the lower bound 1 of this problem`] },
      );
    }
    const one = records().find((r) => r.id === "boundary/tesseract/ball/1")!;
    const ball = kernel("ball", 1);
    const moved = { s: one.config.s, pieces: [{ cell: 0, u: [1e-3, 0, 0] }] };
    expect(ball.validate(moved)).toMatchObject({ valid: false, score: one.config.s });
    expect(ball.validate({ s: 2, pieces: [{ cell: 0, u: [0, 0, 0], q: [1, 0, 0, 0] }] })).toEqual({
      valid: false,
      score: null,
      reasons: ["pieces[0] is a ball and has no rotation q"],
    });
    expect(ball.validate({ s: 2, pieces: [] }).reasons).toEqual(["expected 1 pieces for this problem, got 0"]);
    // no kernel for a P the server would refuse
    expect(() => kernel("ball", 65)).toThrow(/above the server's largest, 64/);
  });

  it("refuses starts outside the server's limits, and no absurd state hangs", () => {
    const absurd = [
      { s: 1e300, pieces: [{ cell: 0, u: [1e17, -1e17, 3] }] },
      { s: 1e300, pieces: [{ cell: 0, u: [0, 0, 0] }] },
      { s: 2, pieces: [{ cell: 0, u: [1e17, 0, 0] }] },
      { s: 2, pieces: [{ cell: 0, u: [0, 0, 0], q: [1e17, 0, 0, 0] }] },
    ];
    for (const piece of PIECES) for (const c of absurd) expect(kernel(piece, 1).fromConfig(c)).toBeNull();
    const t0 = performance.now();
    for (const piece of PIECES) {
      const k = kernel(piece, 4);
      const s = k.randomStart(mulberry32(1));
      k.setSize(s, 1e300);
      for (let i = 0; i < 4; i++) k.jiggle(s, i, 1e17, mulberry32(i));
      const g = new Float64Array(13);
      expect(Number.isFinite(k.energy(s, g))).toBe(true);
      expect(g.every(Number.isFinite)).toBe(true);
      k.toConfig(s);
      k.finish(s);
      k.rebase(s);
      k.randomPose(s, 0, mulberry32(2));
    }
    expect(performance.now() - t0).toBeLessThan(10_000);
  });

  it("finishes a squeezed random start into a valid configuration", () => {
    for (const piece of PIECES)
      for (const P of [2, 7, 13]) {
        const k = kernel(piece, P);
        const s = k.randomStart(mulberry32(100 + P));
        squeeze(k, s);
        const f = k.finish(s)!;
        expect(f).not.toBeNull();
        expect(f.score).toBeGreaterThanOrEqual(k.bound! * (1 - 1e-12));
        expect(validateBoundary(problem(piece, P), f.config, { tol: 0 }).reasons).toEqual([]);
        expect(k.validate(f.config).valid).toBe(true);
      }
  });

  it("seeds valid structured layouts: the cell layouts, and for cubes the two rings", () => {
    const rng = mulberry32(4);
    for (const piece of PIECES)
      for (const P of [5, 8, 12, 16, 30]) {
        const k = kernel(piece, P);
        const seeds = k.seeds!(rng, 4);
        expect(seeds.length).toBe(4);
        for (const q of seeds) {
          expect(k.energy(q)).toBeLessThan(1e-20);
          expect(k.validate(k.toConfig(q)).reasons).toEqual([]);
        }
      }
    // P = 8 balls: one per cell at s = 2; cubes: the rings and one per cell, both at s = 1 (1 + 1e-6)
    expect(kernel("ball", 8).seeds!(rng, 1)[0].size).toBe(2);
    expect(kernel("cube", 8).seeds!(rng, 2).map((q) => q.size)).toEqual([1 + 1e-6, 1 + 1e-6]);
  });
});

describe("boundary kernel: a method run", () => {
  // a method for this test only: squeeze the kernel's seeds and random starts, offering each
  registerMethod({
    name: "test_boundary_squeeze",
    title: "Squeeze (boundary test)",
    summary: "Squeezes seeds and random starts.",
    doc: "docs/methods/dimensions/test_boundary_squeeze.md",
    requires: [],
    schema: { type: "object", additionalProperties: false, properties: {} },
    defaults: {},
    run(ctx: MethodContext) {
      const k = ctx.kernel;
      for (let t = 0; ; t++) {
        const s = t % 2 === 0 && k.seeds ? k.seeds(ctx.rng, 1)[0] : k.randomStart(ctx.rng);
        squeeze(k, s, { mus: [10, 1e3, 1e5] });
        ctx.offer(s);
      }
    },
  });

  it("returns a configuration the server's rule accepts, reproducibly from the seed", () => {
    for (const [piece, P] of [
      ["ball", 6],
      ["cube", 9],
    ] as const) {
      const a = runMethod(kernel(piece, P), "test_boundary_squeeze", { seed: 3, budget: { evals: 30_000 } });
      const b = runMethod(kernel(piece, P), "test_boundary_squeeze", { seed: 3, budget: { evals: 30_000 } });
      expect(a.stopped === "evals" || a.stopped === "bound").toBe(true);
      expect(a.score).not.toBeNull();
      expect(validateBoundary(problem(piece, P), a.config, BOUNDARY_SERVER_RULE).reasons).toEqual([]);
      expect(b.config).toEqual(a.config);
      expect(b.evaluations).toBe(a.evaluations);
    }
  });
});

describe("boundary kernel: every method", () => {
  /** The generic methods a kernel offers, without this file's own. */
  const offered = (k: SpaceKernel) =>
    methodsFor(k)
      .map((m) => m.name)
      .filter((n) => !n.startsWith("test_"));

  it("takes an absurd start for none, or as a start to repair, and ends each method it offers soon, with no error", () => {
    const P = 5;
    const absurd = [
      // outside the server's limits: refused, so the method runs from no start
      { s: 1e300, pieces: Array.from({ length: P }, () => ({ cell: 0, u: [1e17, 0, 0] })) },
      // read, but every piece on one point of a tesseract far too small
      { s: 0.01, pieces: Array.from({ length: P }, () => ({ cell: 0, u: [0, 0, 0] })) },
    ];
    for (const piece of PIECES) {
      const k = kernel(piece, P);
      expect(k.fromConfig(absurd[0])).toBeNull();
      expect(k.fromConfig(absurd[1])).not.toBeNull();
      const names = offered(k);
      expect(names.length).toBeGreaterThanOrEqual(piece === "ball" ? 8 : 6);
      for (const name of names)
        for (const start of absurd) {
          const t0 = performance.now();
          // two offers' worth: enough to start, finish and check, not to search
          const r = runMethod(k, name, { seed: 1, start, budget: { evals: 4000, time_s: 5 } });
          expect(performance.now() - t0, `${piece} ${name}`).toBeLessThan(10_000);
          expect(r.stopped, `${piece} ${name}`).not.toBe("error");
          expect(
            r.reasons.filter((x) => x !== "no valid configuration found"),
            `${piece} ${name}`,
          ).toEqual([]);
          if (r.config) expect(k.validate(r.config).valid, `${piece} ${name}`).toBe(true);
        }
    }
  });

  it("returns from a small valid start a result the server's rule accepts, never worse than the start", () => {
    for (const piece of PIECES) {
      const P = 3;
      const k = kernel(piece, P);
      // the research record: valid, and hard to beat in a short run
      const start = records().find((r) => r.piece === piece && r.P === P)!.config;
      const given = k.validate(start);
      expect(given.valid).toBe(true);
      for (const name of offered(k)) {
        // about one offer: a method's own first result is seldom better than the start
        const r = runMethod(k, name, { seed: 1, start, budget: { evals: 2500 } });
        expect(r.stopped, `${piece} ${name}`).not.toBe("error");
        expect(r.reasons, `${piece} ${name}`).toEqual([]);
        expect(r.score!, `${piece} ${name}`).toBeLessThanOrEqual(given.score!);
        expect(validateBoundary(problem(piece, P), r.config, BOUNDARY_SERVER_RULE).reasons, `${piece} ${name}`).toEqual(
          [],
        );
        expect(k.validate(r.config), `${piece} ${name}`).toMatchObject({ valid: true, score: r.score });
      }
    }
  });

  it("ends a long run of the largest problem on its time limit, with its best so far", () => {
    const k = kernel("ball", 64);
    const t0 = performance.now();
    const r = runMethod(k, "basin_hopping", { seed: 1, budget: { evals: 1e9, time_s: 0.25 } });
    // the limit is polled at every kernel call, a finish under way included
    expect(performance.now() - t0).toBeLessThan(5_000);
    expect(r.stopped).toBe("time");
    if (r.config) expect(validateBoundary(problem("ball", 64), r.config, BOUNDARY_SERVER_RULE).reasons).toEqual([]);
  });
});
