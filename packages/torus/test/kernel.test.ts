/**
 * The torus kernel (src/kernel.ts) for the generic methods, in every family: the kernel contract,
 * the exact gradient (globals and soft shapes included), the research records through
 * fromConfig, validate and finish, the local solves from random starts, the soft shapes, seeds,
 * swap, rebase, and the server's rule.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type KernelState, type SpaceKernel, mulberry32, registerMethod, runMethod, squeeze } from "@polypack/methods";
import { checkKernel } from "@polypack/methods/contract";
import {
  type TorusConfig,
  type TorusFamily,
  type TorusRecordsFile,
  TORUS_FAMILIES,
  recordPacking,
  scalePacking,
  tightScale,
  torusKernel,
  torusScore,
  validateTorusPacking,
} from "../src";

const url = new URL("../../../data/torus/records.json", import.meta.url);
const file: TorusRecordsFile | undefined = existsSync(url) ? JSON.parse(readFileSync(url, "utf8")) : undefined;
const records = file?.records ?? [];

/** The largest relative difference between the gradient and central differences, over every entry. */
function gradientError(k: SpaceKernel, s: KernelState): number {
  const n = s.x.length;
  const g = new Float64Array(n + 1);
  k.energy(s, g);
  let worst = 0;
  for (let c = 0; c <= n; c++) {
    const h = 1e-6;
    const p = k.clone(s);
    const m = k.clone(s);
    if (c === n) {
      p.size += h;
      m.size -= h;
    } else {
      p.x[c] += h;
      m.x[c] -= h;
    }
    const fd = (k.energy(p) - k.energy(m)) / (2 * h);
    worst = Math.max(worst, Math.abs(fd - g[c]) / Math.max(1, Math.abs(fd)));
  }
  return worst;
}

// a method for these tests only: squeeze random starts and offer each (packages/methods/test/framework.test.ts)
registerMethod({
  name: "test_torus_restarts",
  title: "Restarts (test)",
  summary: "Squeezes random starts.",
  doc: "docs/methods/dimensions/test_torus_restarts.md",
  requires: [],
  schema: { type: "object", additionalProperties: false, properties: {} },
  defaults: {},
  run(ctx) {
    for (;;) {
      const s = ctx.kernel.randomStart(ctx.rng);
      squeeze(ctx.kernel, s, { mus: [10, 100, 1000, 1e4] });
      ctx.offer(s);
    }
  },
});

describe("torusKernel", () => {
  it("passes the kernel contract in every family, for disks and polygons, small and large P", () => {
    for (const family of TORUS_FAMILIES)
      for (const [N, P] of [
        [0, 1],
        [0, 7],
        [0, 30],
        [3, 4],
        [3, 13],
        [4, 6],
        [4, 30],
        [5, 2],
        [6, 9],
        [6, 30],
        [8, 7],
      ])
        expect(
          checkKernel(() => torusKernel({ family, N, P }), { seed: 100 * N + P }),
          `${family}/${N}/${P}`,
        ).toEqual([]);
  });

  it("has an exact gradient in every variable, the globals and the size, for true and soft shapes", () => {
    const rng = mulberry32(4);
    for (const family of TORUS_FAMILIES)
      for (const [N, P] of [
        [0, 7],
        [3, 5],
        [4, 9],
        [6, 12],
        [8, 4],
      ])
        for (const t of [1, 0.5, 0]) {
          const k = torusKernel({ family, N, P });
          const s = k.randomStart(rng);
          for (let i = 0; i < P; i++) k.jiggle(s, i, 0.3, rng);
          for (let g = 0; g < k.globals; g++) s.x[P * k.dim + g] = 0.2 * (rng() - 0.5);
          k.setShape!(s, t);
          s.size *= 0.7;
          expect(k.energy(s)).toBeGreaterThan(0);
          expect(gradientError(k, s), `${family}/${N}/${P} t = ${t}`).toBeLessThan(1e-6);
        }
  });

  describe.skipIf(records.length === 0)("on the research records", () => {
    it("converts every record, which validates, has no energy and finishes at its score", () => {
      for (const r of records) {
        const k = torusKernel({ family: r.family, N: r.N, P: r.P });
        const s = k.fromConfig(r.configuration);
        expect(s, r.problem).not.toBeNull();
        expect(k.validate(r.configuration).valid, r.problem).toBe(true);
        expect(k.energy(s!), r.problem).toBeLessThanOrEqual(1e-9);
        const f = k.finish(s!);
        expect(f, r.problem).not.toBeNull();
        expect(f!.score, r.problem).toBeLessThanOrEqual(r.score_cert * (1 + 1e-9));
        expect(k.validate(f!.config).valid, r.problem).toBe(true);
      }
    });

    it("finishes at the validator's own bisection", () => {
      for (const id of ["torus/sq/0/7", "torus/hex/5/8", "torus/free/3/6", "torus/free/7/16", "torus/hex/6/12"]) {
        const r = records.find((x) => x.problem === id)!;
        const k = torusKernel({ family: r.family, N: r.N, P: r.P });
        const start = scalePacking(recordPacking(r), 1.02);
        const config: TorusConfig = {
          lattice:
            r.family === "free" ? { b1: [...start.lattice.b1], b2: [...start.lattice.b2] } : { L: start.lattice.b1[0] },
          poses: start.poses.map((p) => [p.x, p.y, p.theta]),
        } as TorusConfig;
        const f = k.finish(k.fromConfig(config)!)!;
        const ref = tightScale(r, start)!;
        expect(Math.abs(f.score / ref.score - 1), id).toBeLessThan(1e-12);
        expect(f.score).toBeLessThanOrEqual(r.score_float * (1 + 1e-12));
      }
    });
  });

  it("squeezes random starts to valid packings in every family", () => {
    const rng = mulberry32(7);
    for (const family of TORUS_FAMILIES)
      for (const [N, P] of [
        [0, 4],
        [3, 6],
        [6, 9],
      ]) {
        const k = torusKernel({ family, N, P });
        let best = Infinity;
        for (let t = 0; t < 3; t++) {
          const s = k.randomStart(rng);
          squeeze(k, s);
          const f = k.finish(s);
          expect(f, `${family}/${N}/${P}`).not.toBeNull();
          expect(k.validate(f!.config).valid).toBe(true);
          best = Math.min(best, f!.score);
        }
        expect(best).toBeGreaterThanOrEqual(k.bound! * (1 - 1e-9));
        // a local solve, not a search: within 25 % of the record
        const r = records.find((x) => x.problem === `torus/${family}/${N}/${P}`);
        if (r) expect(best, `${family}/${N}/${P}`).toBeLessThan(r.score_cert * 1.25);
      }
  });

  it("shears a free cell: one disk reaches the hexagonal lattice", () => {
    // the densest lattice packing of disks has score sqrt(2 sqrt(3)) [EST: Lagrange, Gauss]
    const k = torusKernel({ family: "free", N: 0, P: 1 });
    const rng = mulberry32(1);
    let best = Infinity;
    for (let t = 0; t < 4; t++) {
      const s = k.randomStart(rng);
      squeeze(k, s);
      best = Math.min(best, k.finish(s)!.score);
    }
    expect(best).toBeLessThan(Math.sqrt(2 * Math.sqrt(3)) * (1 + 1e-6));
  });

  it("softens towards the inscribed disks, never adding energy", () => {
    const rng = mulberry32(12);
    for (const family of TORUS_FAMILIES)
      for (const N of [3, 4, 6]) {
        const k = torusKernel({ family, N, P: 10 });
        for (let rep = 0; rep < 3; rep++) {
          const s = k.randomStart(rng);
          s.size *= 0.7;
          const e = (t: number) => {
            const c = k.clone(s);
            k.setShape!(c, t);
            return k.energy(c);
          };
          expect(e(0)).toBeLessThanOrEqual(e(0.5) + 1e-12);
          expect(e(0.5)).toBeLessThanOrEqual(e(1) + 1e-12);
          expect(e(1)).toBeGreaterThan(0);
        }
      }
    // two squares corner to corner (theta = 0 puts a vertex on the x axis), 1.2 apart: their
    // inscribed disks (radius 0.5) are apart, their corners (at 0.707) overlap
    const k = torusKernel({ family: "sq", N: 4, P: 2 });
    const s = k.fromConfig({
      lattice: { L: 10 },
      poses: [
        [0, 0, 0],
        [1.2, 0, 0],
      ],
    })!;
    expect(k.energy(s)).toBeGreaterThan(1e-3);
    k.setShape!(s, 0);
    expect(k.energy(s)).toBe(0);
  });

  it("gives seeds that are valid lattice placements, and swaps angles only", () => {
    for (const family of TORUS_FAMILIES)
      for (const [N, P] of [
        [0, 7],
        [3, 6],
        [5, 8],
        [6, 12],
      ]) {
        const k = torusKernel({ family, N, P });
        for (const s of k.seeds!(mulberry32(P), 4)) {
          expect(k.validate(k.toConfig(s)).valid, `${family}/${N}/${P}`).toBe(true);
          const f = k.finish(s)!;
          expect(k.validate(f.config).valid).toBe(true);
          expect(f.score).toBeLessThanOrEqual(s.size * (1 + 1e-12));
        }
      }
    const k = torusKernel({ family: "hex", N: 5, P: 4 });
    const s = k.randomStart(mulberry32(3));
    const before = k.toConfig(s) as TorusConfig;
    k.swap!(s, 0, 2);
    const after = k.toConfig(s) as TorusConfig;
    expect(after.poses[0]).toEqual([before.poses[0][0], before.poses[0][1], before.poses[2][2]]);
    expect(after.poses[2]).toEqual([before.poses[2][0], before.poses[2][1], before.poses[0][2]]);
  });

  it("rebases a sheared free cell to a reduced basis and far centres into the cell, keeping the packing", () => {
    const k = torusKernel({ family: "free", N: 4, P: 5 });
    const rng = mulberry32(5);
    const s = k.randomStart(rng);
    // a strong shear (t2) and a piece many cells away
    s.x[5 * 3 + 1] = 1.4;
    s.x[0] += 40;
    const e = k.energy(s);
    const before = k.toConfig(s) as TorusConfig & { lattice: { b1: number[]; b2: number[] } };
    k.rebase(s);
    const after = k.toConfig(s) as TorusConfig & { lattice: { b1: number[]; b2: number[] } };
    expect(s.x.every((v) => v === 0)).toBe(true);
    expect(Math.abs(k.energy(s) - e)).toBeLessThan(1e-9 * Math.max(1, e));
    const len2 = (l: { b1: number[]; b2: number[] }) => l.b1[0] ** 2 + l.b1[1] ** 2 + l.b2[0] ** 2 + l.b2[1] ** 2;
    expect(len2(after.lattice)).toBeLessThan(len2(before.lattice) / 1.5);
    expect(Math.abs(after.poses[0][0])).toBeLessThan(Math.abs(before.poses[0][0]));
    // the same lattice and the same packing
    const lat = (c: typeof before) => ({ b1: c.lattice.b1 as [number, number], b2: c.lattice.b2 as [number, number] });
    expect(torusScore("free", lat(after))).toBeCloseTo(torusScore("free", lat(before)), 12);
    const check = (c: typeof before) =>
      validateTorusPacking({
        family: "free",
        N: 4,
        lattice: lat(c),
        poses: c.poses.map(([x, y, theta]) => ({ x, y, theta })),
      }).minSep;
    expect(check(after)).toBeCloseTo(check(before), 9);
  });

  it("validates by the server's rule", () => {
    const sq = torusKernel({ family: "sq", N: 0, P: 2 });
    const good = {
      lattice: { L: 4 },
      poses: [
        [0, 0, 0],
        [2, 0, 0],
      ],
    };
    expect(sq.validate(good)).toEqual({ valid: true, score: 4, reasons: [] });
    expect(sq.validate({ ...good, lattice: { L: -4 } }).valid).toBe(false);
    expect(sq.validate({ ...good, lattice: { b1: [4, 0], b2: [0, 4] } }).valid).toBe(false);
    expect(sq.validate({ ...good, poses: [[0, 0, 0]] }).valid).toBe(false);
    expect(
      sq.validate({
        ...good,
        poses: [
          [0, 0, 0],
          [2e4, 0, 0],
        ],
      }).valid,
    ).toBe(false);
    expect(
      sq.validate({
        ...good,
        poses: [
          [0, 0, 0],
          [2, 0],
        ],
      }).valid,
    ).toBe(false);
    // touching within the tolerance 1e-9 is accepted, an overlap of 1e-8 is not
    expect(
      sq.validate({
        ...good,
        poses: [
          [0, 0, 0],
          [2 - 1e-10, 0, 0],
        ],
      }).valid,
    ).toBe(true);
    expect(
      sq.validate({
        ...good,
        poses: [
          [0, 0, 0],
          [2 - 1e-8, 0, 0],
        ],
      }).valid,
    ).toBe(false);
    // through the cell's side: the image at x - 4
    expect(
      sq.validate({
        ...good,
        poses: [
          [0, 0, 0],
          [2 + 1e-8, 0, 0],
        ],
      }).valid,
    ).toBe(false);
    const free = torusKernel({ family: "free", N: 0, P: 1 });
    expect(free.validate({ lattice: { b1: [2, 0], b2: [0, 2] }, poses: [[0, 0, 0]] }).valid).toBe(true);
    expect(free.validate({ lattice: { L: 2 }, poses: [[0, 0, 0]] }).valid).toBe(false);
    expect(free.validate({ lattice: { b1: [2, 0], b2: [4, 0] }, poses: [[0, 0, 0]] }).valid).toBe(false);
    // a lattice vector shorter than the width, and a basis too skewed to enumerate
    expect(free.validate({ lattice: { b1: [1.5, 0], b2: [0, 3] }, poses: [[0, 0, 0]] }).valid).toBe(false);
    const skewed = { lattice: { b1: [2, 0], b2: [2000, 2] }, poses: [[0, 0, 0]] };
    expect(free.validate(skewed).valid).toBe(false);
    expect(free.validate(skewed).reasons[0]).toMatch(/skewed/);
  });

  it("states sizes in the score's units", () => {
    for (const family of TORUS_FAMILIES as readonly TorusFamily[]) {
      const k = torusKernel({ family, N: 6, P: 3 });
      const s = k.randomStart(mulberry32(2));
      const c = k.toConfig(s) as TorusConfig;
      const l = "L" in c.lattice ? null : c.lattice;
      const score = l ? torusScore(family, l) : (c.lattice as { L: number }).L;
      expect(score).toBeCloseTo(s.size, 12);
      expect(k.inradius).toBeCloseTo(Math.sqrt(3) / 2, 15);
    }
  });
  it("moves pieces through their own variables only, so that writing them back undoes a move", () => {
    const k = torusKernel({ family: "free", N: 5, P: 6 });
    const rng = mulberry32(8);
    const s = k.randomStart(rng);
    for (let i = 0; i < k.P; i++) k.jiggle(s, i, 0.5, rng);
    const config = JSON.stringify(k.toConfig(s));
    const aux = JSON.stringify(k.clone(s).aux, (_, v) => (v instanceof Float64Array ? [...v] : v));
    const x = Float64Array.from(s.x);
    const moves: [string, (q: KernelState) => void, number[]][] = [
      ["jiggle", (q) => k.jiggle(q, 2, 1, rng), [2]],
      ["randomPose", (q) => k.randomPose(q, 3, rng), [3]],
      ["swap", (q) => k.swap!(q, 1, 4), [1, 4]],
    ];
    for (const [name, move, moved] of moves) {
      const q = k.clone(s);
      move(q);
      expect(
        JSON.stringify(q.aux, (_, v) => (v instanceof Float64Array ? [...v] : v)),
        name,
      ).toBe(aux);
      for (let c = 0; c < x.length; c++)
        if (!moved.includes(Math.floor(c / k.dim)) || c >= k.P * k.dim) expect(q.x[c], `${name} ${c}`).toBe(x[c]);
      expect(JSON.stringify(k.toConfig(q)), name).not.toBe(config);
      for (const i of moved) for (let c = 0; c < k.dim; c++) q.x[k.dim * i + c] = x[k.dim * i + c];
      expect(JSON.stringify(k.toConfig(q)), name).toBe(config);
    }
  });
  it("runs a method through the framework: a valid best, reproducible from the seed", () => {
    const run = () =>
      runMethod(torusKernel({ family: "free", N: 5, P: 3 }), "test_torus_restarts", {
        seed: 5,
        budget: { evals: 4000 },
      });
    const a = run();
    expect(a.stopped).toBe("evals");
    expect(a.score).not.toBeNull();
    const k = torusKernel({ family: "free", N: 5, P: 3 });
    expect(k.validate(a.config)).toEqual({ valid: true, score: a.score, reasons: [] });
    expect(run().config).toEqual(a.config);
  });
  it("never hangs on far centres, and refuses numbers beyond the server's limits", () => {
    const k = torusKernel({ family: "sq", N: 0, P: 2 });
    const far = {
      lattice: { L: 5 },
      poses: [
        [0, 0, 0],
        [1e17, 0, 0],
      ],
    };
    expect(k.fromConfig(far)).toBeNull();
    expect(k.validate(far).valid).toBe(false);
    const t0 = performance.now();
    const res = runMethod(k, "test_torus_restarts", { seed: 1, start: far, budget: { evals: 2000, time_s: 20 } });
    expect(performance.now() - t0).toBeLessThan(20000);
    expect(res.score).not.toBeNull();
    // a state whose offsets have run far: finite and terminating, or degenerate (Infinity)
    const s = k.fromConfig({
      lattice: { L: 5 },
      poses: [
        [0, 0, 0],
        [2.5, 0, 0],
      ],
    })!;
    for (const x of [1e9, 1e17, 1e300]) {
      const q = k.clone(s);
      q.x[2] = x;
      expect(k.energy(q, new Float64Array(5))).toBeGreaterThanOrEqual(0);
      expect(k.pieceEnergy(q, 1)).toBeGreaterThanOrEqual(0);
      k.clear(q, 1, 0);
      k.finish(q);
    }
    // far centres within the limits come back into the cell
    const near = k.fromConfig({
      lattice: { L: 5 },
      poses: [
        [0, 0, 0],
        [9002.5, -40, 0],
      ],
    })!;
    const c = k.toConfig(near) as TorusConfig;
    expect(c.poses[1][0]).toBeCloseTo(2.5, 9);
    expect(c.poses[1][1]).toBeCloseTo(0, 9);
    expect(k.energy(near)).toBe(0);
  });

  it("reduces a skewed free basis on the way in", () => {
    const k = torusKernel({ family: "free", N: 0, P: 1 });
    // the lattice spanned by (2, 0) and (2000, 2) is that of (2, 0) and (0, 2)
    const s = k.fromConfig({ lattice: { b1: [2, 0], b2: [2000, 2] }, poses: [[0, 0, 0]] })!;
    expect(k.energy(s)).toBe(0);
    const c = k.toConfig(s) as { lattice: { b1: number[]; b2: number[] } };
    expect(Math.hypot(c.lattice.b2[0], c.lattice.b2[1])).toBeCloseTo(2, 9);
    expect(k.finish(s)!.score).toBeCloseTo(2, 9);
  });

  it("refuses sizes below the bound, names overlaps as the server does, and gives up hopeless finishes", () => {
    // one disk on the hexagonal free lattice is at Thue's bound
    const free = torusKernel({ family: "free", N: 0, P: 1 });
    const hex = { b1: [2, 0], b2: [1, Math.sqrt(3)] };
    expect(free.validate({ lattice: hex, poses: [[0, 0, 0]] }).valid).toBe(true);
    const f = 1 - 2e-9;
    const below = free.validate({ lattice: { b1: [2 * f, 0], b2: [f, Math.sqrt(3) * f] }, poses: [[0, 0, 0]] });
    expect(below.valid).toBe(false);
    expect(below.reasons[0]).toMatch(/below the lower bound/);
    // one square at theta = 0 stands on a corner: 1.414 wide, against a cell of 1.2
    const sq = torusKernel({ family: "sq", N: 4, P: 1 });
    const own = sq.validate({ lattice: { L: 1.2 }, poses: [[0, 0, 0]] });
    expect(own.reasons.some((m) => /overlaps its own translate/.test(m))).toBe(true);
    for (const family of TORUS_FAMILIES) {
      const k = torusKernel({ family, N: 4, P: 3 });
      const c = k.toConfig(k.randomStart(mulberry32(1))) as TorusConfig;
      // three squares on top of each other never separate
      expect(k.finish(k.fromConfig({ ...c, poses: c.poses.map(() => [1, 1, 0]) })!)).toBeNull();
    }
  });
});
