/**
 * The sphere kernel (src/kernel.ts) for the generic methods: the kernel contract, the exact
 * gradient (soft shapes included), the research records through fromConfig, validate and finish,
 * the local solves from random starts, the soft shapes, seeds and swap, and the server's rule.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type KernelState,
  type SpaceKernel,
  mulberry32,
  registerMethod,
  runMethod,
  relax,
  squeeze,
} from "@polypack/methods";
import { checkKernel } from "@polypack/methods/contract";
import { type SphereConfig, quatFromCentreTheta, sphereKernel, tightRho, validate } from "../src";

const url = new URL("../../../data/sphere/records.json", import.meta.url);
const records: { id: string; N: number; P: number; score_float: number; score_cert: number; config: SphereConfig }[] =
  existsSync(url) ? JSON.parse(readFileSync(url, "utf8")).records : [];

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
  name: "test_sphere_restarts",
  title: "Restarts (test)",
  summary: "Squeezes random starts.",
  doc: "docs/methods/dimensions/test_sphere_restarts.md",
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

describe("sphereKernel", () => {
  it("passes the kernel contract for disks and polygons, small and large P", () => {
    for (const [N, P] of [
      [0, 2],
      [0, 7],
      [0, 30],
      [3, 4],
      [3, 13],
      [3, 30],
      [4, 3],
      [4, 6],
      [4, 20],
      [5, 12],
      [6, 2],
      [6, 9],
      [6, 30],
      [8, 7],
    ])
      expect(
        checkKernel(() => sphereKernel({ N, P }), { seed: 100 * N + P }),
        `sphere/${N}/${P}`,
      ).toEqual([]);
  });

  it("has an exact gradient in every variable and the size, for true and soft shapes", () => {
    const rng = mulberry32(4);
    for (const [N, P] of [
      [0, 7],
      [3, 5],
      [4, 9],
      [6, 12],
      [8, 4],
    ])
      for (const t of [1, 0.5, 0]) {
        const k = sphereKernel({ N, P });
        const s = k.randomStart(rng);
        // rotations away from the anchors, and a squeeze, so that many pairs overlap
        for (let i = 0; i < P; i++) k.jiggle(s, i, 0.3, rng);
        k.setShape!(s, t);
        s.size *= 0.8;
        expect(k.energy(s)).toBeGreaterThan(0);
        expect(gradientError(k, s), `sphere/${N}/${P} t = ${t}`).toBeLessThan(1e-6);
      }
  });

  it("has a positive wall below the size at which the pieces stop existing", () => {
    const k = sphereKernel({ N: 4, P: 2 });
    const s = k.fromConfig({ rho: 0.5, pieces: [{ q: [1, 0, 0, 0] }, { q: [0, 1, 0, 0] }] })!;
    // squares exist only above rho = 4 / (2 pi) = 0.6366
    expect(k.energy(s)).toBeGreaterThan(0.01);
    expect(k.clear(s, 0, 1e-9)).toBe(false);
    expect(gradientError(k, s)).toBeLessThan(1e-6);
  });

  describe.skipIf(records.length === 0)("on the research records", () => {
    it("converts every record, which validates, has no energy and finishes at its score", () => {
      for (const r of records) {
        const k = sphereKernel({ N: r.N, P: r.P });
        const s = k.fromConfig(r.config);
        expect(s, r.id).not.toBeNull();
        expect(k.validate(r.config).valid, r.id).toBe(true);
        expect(k.energy(s!), r.id).toBeLessThanOrEqual(1e-9);
        const f = k.finish(s!);
        expect(f, r.id).not.toBeNull();
        expect(f!.score, r.id).toBeLessThanOrEqual(r.score_cert * (1 + 1e-9));
        expect(k.validate(f!.config).valid, r.id).toBe(true);
      }
    });

    it("finishes at the validator's own bisection", () => {
      for (const id of ["sphere/0/24", "sphere/4/7", "sphere/5/12", "sphere/6/30", "sphere/8/9"]) {
        const r = records.find((x) => x.id === id)!;
        const k = sphereKernel({ N: r.N, P: r.P });
        const s = k.fromConfig({ ...r.config, rho: r.config.rho * 1.02 })!;
        const f = k.finish(s)!;
        const q = r.config.pieces.map((p) => p.q);
        expect(f.score / tightRho({ N: r.N, P: r.P }, q, r.config.rho * 1.02)! - 1, id).toBeLessThan(1e-12);
        expect(validate({ N: r.N, P: r.P }, f.config as SphereConfig, { tol: 0 }).minGap).toBeGreaterThanOrEqual(0);
      }
    });
  });

  it("squeezes random starts to valid packings near the records", () => {
    const rng = mulberry32(7);
    for (const [N, P] of [
      [0, 12],
      [3, 8],
      [4, 6],
      [6, 10],
    ]) {
      const k = sphereKernel({ N, P });
      let best = Infinity;
      for (let t = 0; t < 3; t++) {
        const s = k.randomStart(rng);
        squeeze(k, s);
        const f = k.finish(s);
        expect(f, `sphere/${N}/${P}`).not.toBeNull();
        expect(k.validate(f!.config).valid).toBe(true);
        best = Math.min(best, f!.score);
      }
      expect(best).toBeGreaterThanOrEqual(k.bound! * (1 - 1e-9));
      // a local solve, not a search: within 25 % of the record
      const r = records.find((x) => x.id === `sphere/${N}/${P}`);
      if (r) expect(best, `sphere/${N}/${P}`).toBeLessThan(r.score_cert * 1.25);
    }
  });

  it("softens towards the inscribed caps, never adding energy", () => {
    const rng = mulberry32(12);
    for (const N of [3, 4, 6]) {
      const k = sphereKernel({ N, P: 10 });
      for (let rep = 0; rep < 4; rep++) {
        const s = k.randomStart(rng);
        s.size *= 0.8;
        const e = (t: number) => {
          const c = k.clone(s);
          k.setShape!(c, t);
          return k.energy(c);
        };
        expect(e(0)).toBeLessThanOrEqual(e(0.5));
        expect(e(0.5)).toBeLessThanOrEqual(e(1));
        expect(e(1)).toBeGreaterThan(0);
      }
    }
    // two squares corner to corner: their inscribed caps are apart (centre angle above 2 r, r about
    // 0.5 / rho) but their corners overlap (below 2 R, R about 0.707 / rho)
    const k = sphereKernel({ N: 4, P: 2 });
    const rho = 3;
    const d = 1.2 / rho;
    const pieces = [
      { q: quatFromCentreTheta([0, 0, 1], 0) },
      { q: quatFromCentreTheta([Math.sin(d), 0, Math.cos(d)], 0) },
    ];
    const s = k.fromConfig({ rho, pieces })!;
    expect(k.energy(s)).toBeGreaterThan(1e-4);
    k.setShape!(s, 0);
    expect(k.energy(s)).toBe(0);
    k.setShape!(s, 1);
    expect(k.energy(s)).toBeGreaterThan(1e-4);
  });

  it("gives seeds that finish to valid packings, and swaps orientations without moving centres", () => {
    for (const [N, P] of [
      [0, 12],
      [4, 6],
      [5, 12],
      [6, 17],
    ]) {
      const k = sphereKernel({ N, P });
      for (const s of k.seeds!(mulberry32(P), 4)) {
        expect(k.validate(k.toConfig(s)).valid, `sphere/${N}/${P}`).toBe(true);
        const f = k.finish(s);
        expect(f, `sphere/${N}/${P}`).not.toBeNull();
        expect(k.validate(f!.config).valid).toBe(true);
        // a seed's caps touch at most: no relaxation is needed
        expect(f!.score).toBeLessThanOrEqual(s.size * (1 + 1e-12));
      }
    }
    const k = sphereKernel({ N: 5, P: 6 });
    const s = k.randomStart(mulberry32(3));
    relax(k, s);
    const before = k.toConfig(s) as SphereConfig;
    const c = k.clone(s);
    k.swap!(c, 1, 4);
    const after = k.toConfig(c) as SphereConfig;
    const centre = (q: number[]) => {
      const [w, x, y, z] = q;
      return [2 * (x * z + w * y), 2 * (y * z - w * x), w * w - x * x - y * y + z * z];
    };
    for (const i of [1, 4]) {
      const a = centre(before.pieces[i].q);
      const b = centre(after.pieces[i].q);
      for (let d = 0; d < 3; d++) expect(b[d]).toBeCloseTo(a[d], 12);
    }
    expect(after.pieces[1].q).not.toEqual(before.pieces[1].q);
  });

  it("validates by the server's rule", () => {
    const k = sphereKernel({ N: 4, P: 2 });
    const good = { rho: 1, pieces: [{ q: [1, 0, 0, 0] }, { q: [0, 1, 0, 0] }] };
    expect(k.validate(good)).toEqual({ valid: true, score: 1, reasons: [] });
    expect(k.validate({ ...good, rho: -1 }).valid).toBe(false);
    expect(k.validate({ ...good, rho: 2e6 }).valid).toBe(false);
    expect(k.validate({ rho: 1, pieces: [{ q: [1, 0, 0, 0] }] }).valid).toBe(false);
    expect(k.validate({ rho: 1, pieces: [{ q: [1, 0, 0, 0] }, { q: [1e-7, 0, 0, 0] }] }).valid).toBe(false);
    expect(k.validate({ rho: 1, pieces: [{ q: [1, 0, 0, 0] }, { q: [2e4, 0, 0, 0] }] }).valid).toBe(false);
    expect(k.validate({ rho: 1, pieces: [{ q: [1, 0, 0, 0] }, { q: [1, 0, 0, "0"] }] }).valid).toBe(false);
    expect(k.validate(null).valid).toBe(false);
    // two squares on top of each other overlap; an overlap within the touching tolerance 1e-9 is accepted
    expect(k.validate({ rho: 1, pieces: [{ q: [1, 0, 0, 0] }, { q: [1, 0, 0, 0] }] }).valid).toBe(false);
    const disks = sphereKernel({ N: 0, P: 2 });
    const pair = (gap: number) => {
      const d = 2 / 2 + gap / 2; // rho 2: angular radius 1/2, centres at angle 1 + gap / 2
      return { rho: 2, pieces: [{ q: [1, 0, 0, 0] }, { q: quatFromCentreTheta([Math.sin(d), 0, Math.cos(d)], 0) }] };
    };
    expect(disks.validate(pair(-1e-10)).valid).toBe(true);
    expect(disks.validate(pair(-1e-8)).valid).toBe(false);
  });

  it("keeps the configuration through rebase, clone and setSize", () => {
    const k = sphereKernel({ N: 6, P: 8 });
    const rng = mulberry32(2);
    const s = k.randomStart(rng);
    for (let i = 0; i < 8; i++) k.jiggle(s, i, 2, rng);
    const e = k.energy(s);
    const c = k.clone(s);
    k.rebase(c);
    expect(c.x.every((v) => v === 0)).toBe(true);
    expect(Math.abs(k.energy(c) - e)).toBeLessThan(1e-12 * Math.max(1, e));
    // setSize keeps the quaternions: back and forth gives the same configuration
    const big = k.clone(s);
    k.setSize(big, s.size * 1.5);
    k.setSize(big, s.size);
    const a = k.toConfig(s) as SphereConfig;
    const b = k.toConfig(big) as SphereConfig;
    a.pieces.forEach((p, i) => p.q.forEach((v, j) => expect(b.pieces[i].q[j]).toBeCloseTo(v, 12)));
  });
  it("moves pieces through their own variables only, so that writing them back undoes a move", () => {
    const k = sphereKernel({ N: 5, P: 6 });
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
      runMethod(sphereKernel({ N: 4, P: 8 }), "test_sphere_restarts", { seed: 5, budget: { evals: 4000 } });
    const a = run();
    expect(a.stopped).toBe("evals");
    expect(a.score).not.toBeNull();
    const k = sphereKernel({ N: 4, P: 8 });
    expect(k.validate(a.config)).toEqual({ valid: true, score: a.score, reasons: [] });
    expect(run().config).toEqual(a.config);
  });
  it("refuses sizes below the bound, as the server does, and stops one or two polygons at it", () => {
    const r = records.find((x) => x.id === "sphere/3/8");
    if (r) {
      // eight triangles tile the sphere: the record is at the area bound
      const k = sphereKernel({ N: 3, P: 8 });
      const below = k.validate({ ...r.config, rho: r.config.rho * (1 - 2e-9) });
      expect(below.valid).toBe(false);
      expect(below.reasons[0]).toMatch(/below the lower bound/);
    }
    for (const N of [3, 4, 8]) {
      // the bound is the existence limit N / (2 pi), an infimum; a finish gets within 1e-9 of it
      const res = runMethod(sphereKernel({ N, P: 2 }), "test_sphere_restarts", { seed: 1, budget: { evals: 20000 } });
      expect(res.stopped, `sphere/${N}/2`).toBe("bound");
      expect(sphereKernel({ N, P: 2 }).validate(res.config).valid).toBe(true);
    }
  });

  it("gives up a finish that cannot succeed at once", () => {
    for (const N of [0, 6]) {
      const k = sphereKernel({ N, P: 4 });
      // four pieces on top of each other never separate
      const s = k.fromConfig({ rho: 3, pieces: Array.from({ length: 4 }, () => ({ q: [1, 0, 0, 0] })) })!;
      expect(k.finish(s)).toBeNull();
    }
  });
});
