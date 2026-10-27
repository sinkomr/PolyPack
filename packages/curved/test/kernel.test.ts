/**
 * The curved kernel for the generic methods (src/kernel.ts): the kernel contract on a spread of
 * curvatures, pieces and P; gradients in the chart offsets; research records through
 * fromConfig, validate and finish; squeezed random starts that finish valid; infeasible problems.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type KernelState, mulberry32, relax, squeeze } from "@polypack/methods";
import { checkKernel } from "@polypack/methods/contract";
import { DISK_RADIUS, curvedKernel, makeSpace, validate, type CurvedConfig } from "../src/index";
import { FINISH_CAP, FINISH_ITER, VALIDATE_WORK, curvedFinish } from "../src/kernel-finish";

interface CurvedRecord {
  id: string;
  K: number;
  N: number;
  M: number;
  P: number;
  status: string;
  score_cert: number;
  config: CurvedConfig;
}

const RECORDS: CurvedRecord[] = JSON.parse(
  readFileSync(join(__dirname, "../../../data/curved/records.json"), "utf8"),
).records;

const problem = (id: string) => {
  const [K, N, M, P] = id.split("/").map(Number);
  return { K, N, M, P };
};

/** Central-difference check of every gradient entry of a state; returns the worst relative error. */
function gradientError(k: ReturnType<typeof curvedKernel>, s: KernelState): number {
  const n = k.P * k.dim;
  const g = new Float64Array(n + 1);
  k.energy(s, g);
  let worst = 0;
  for (let i = 0; i <= n; i++) {
    const h = i === n ? 1e-6 * s.size : 1e-6 * k.steps[i % k.dim];
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
    worst = Math.max(worst, Math.abs(fd - g[i]) / Math.max(1, Math.abs(fd), Math.abs(g[i])));
  }
  return worst;
}

describe("the curved kernel", () => {
  it("passes the kernel contract for K < 0, K > 0 and tiny K, disks and polygons, several P", () => {
    const ids = [
      "-1/0/0/5",
      "-1/0/0/12",
      "-1/3/4/3",
      "-1/4/0/6",
      "-1/5/6/2",
      "-0.3/6/4/2",
      "-4/3/3/1",
      "1/3/3/4",
      "1/0/0/1",
      "1/4/4/3",
      "1/3/0/5",
      "0.5/0/0/3",
      "2/3/4/3",
      "0.000001/4/4/5",
      "-0.000001/0/0/7",
      "0/3/3/5",
    ];
    for (const id of ids) expect([id, checkKernel(() => curvedKernel(problem(id)), { seed: 1 })]).toEqual([id, []]);
  });

  it("differentiates the energy in the chart offsets away from the anchors, for true and soft shapes", () => {
    const rng = mulberry32(4);
    for (const id of ["-1/3/4/3", "1/4/4/3", "-1/0/0/5", "0.000001/5/0/3"]) {
      const k = curvedKernel(problem(id));
      for (const shape of [1, 0.4, 0]) {
        const s = k.randomStart(rng);
        for (let i = 0; i < k.P; i++) k.jiggle(s, i, 0.8, rng);
        k.setShape!(s, shape);
        expect(k.energy(s), `${id} at t = ${shape}`).toBeGreaterThan(1e-6);
        expect(gradientError(k, s), `${id} at t = ${shape}`).toBeLessThan(1e-4);
      }
    }
  });

  it("keeps chart offsets, rebase and setSize consistent with the configuration", () => {
    const k = curvedKernel(problem("-1/4/5/4"));
    const rng = mulberry32(2);
    const s = k.randomStart(rng);
    for (let i = 0; i < k.P; i++) k.jiggle(s, i, 2, rng);
    const before = k.toConfig(s) as CurvedConfig;
    k.rebase(s);
    expect([...s.x].every((v) => v === 0)).toBe(true);
    const after = k.toConfig(s) as CurvedConfig;
    after.pieces.forEach((p, i) => {
      expect(p.x).toBeCloseTo(before.pieces[i].x, 12);
      expect(p.y).toBeCloseTo(before.pieces[i].y, 12);
      expect(p.theta).toBeCloseTo(before.pieces[i].theta, 12);
    });
    // setSize scales each centre's geodesic polar radius about O and keeps theta
    const big = k.clone(s);
    k.setSize(big, s.size * 1.3);
    const grown = k.toConfig(big) as CurvedConfig;
    const ratio = Math.hypot(grown.pieces[0].x, grown.pieces[0].y) / Math.hypot(after.pieces[0].x, after.pieces[0].y);
    grown.pieces.forEach((p, i) => {
      expect(Math.hypot(p.x, p.y) / Math.hypot(after.pieces[i].x, after.pieces[i].y)).toBeCloseTo(ratio, 12);
      expect(Math.atan2(p.y, p.x)).toBeCloseTo(Math.atan2(after.pieces[i].y, after.pieces[i].x), 12);
      expect(p.theta).toBe(after.pieces[i].theta);
    });
    expect(ratio).toBeGreaterThan(1);
  });

  it("validates research records by the server's rule, and finishes them at no more than their size", () => {
    // (polygon pieces only: the records of disks of radius 1 are archived, data/curved/archive/README.md; disks of
    // diameter 1 have no records yet)
    const ids = [
      "curved/-1/3/4/5",
      "curved/-1/4/0/5",
      "curved/1/3/3/5",
      "curved/1/4/4/3",
      "curved/1.225778283313099/3/5/5",
      "curved/-1e-06/4/4/5",
    ];
    for (const id of ids) {
      const r = RECORDS.find((q) => q.id === id)!;
      expect(r.status).toBe("best_known");
      const k = curvedKernel({ K: r.K, N: r.N, M: r.M, P: r.P });
      const v = k.validate(r.config);
      expect([id, v.valid, v.score]).toEqual([id, true, r.score_cert]);
      const s = k.fromConfig(r.config)!;
      expect(k.toConfig(s)).toEqual(r.config);
      expect(k.energy(s)).toBe(0);
      if (k.bound !== null) expect(k.bound).toBeLessThanOrEqual(r.score_cert);
      const f = k.finish(s);
      expect(f).not.toBeNull();
      expect(f!.score).toBeLessThanOrEqual(r.score_cert * (1 + 1e-9));
      expect(k.validate(f!.config).valid).toBe(true);
      expect(validate({ N: r.N, M: r.M, P: r.P }, r.K, f!.config as CurvedConfig, { tol: 0 }).valid).toBe(true);
    }
  });

  it("finishes squeezed random starts to valid configurations", () => {
    const rng = mulberry32(8);
    for (const id of ["-1/0/0/5", "-1/3/4/3", "1/3/3/4", "-0.000001/4/4/4", "1/0/0/1"]) {
      const k = curvedKernel(problem(id));
      const s = k.randomStart(rng);
      squeeze(k, s);
      const f = k.finish(s);
      expect([id, f !== null]).toEqual([id, true]);
      expect(k.validate(f!.config).valid).toBe(true);
      const { N, M, P, K } = problem(id);
      expect(validate({ N, M, P }, K, f!.config as CurvedConfig, { tol: 0 }).valid).toBe(true);
      // the squeeze ends with overlaps of about 1e-10, so its size can be a hair below the finished one
      expect(f!.score).toBeLessThanOrEqual(s.size * (1 + 1e-3));
    }
  });

  it("ends a finish early when it is told to stop, still with a valid configuration or null", () => {
    const r = RECORDS.find((q) => q.id === "curved/-1/3/5/5")!;
    const k = curvedKernel({ K: r.K, N: r.N, M: r.M, P: r.P });
    expect(k.inradius).toBeCloseTo(0.2637, 4);
    let polls = 0;
    const f = k.finish(k.fromConfig(r.config)!, () => (polls++, true));
    expect(polls).toBe(1);
    expect(f!.score).toBeLessThanOrEqual(r.score_cert * (1 + 1e-9));
    expect(k.validate(f!.config).valid).toBe(true);
    // from a squeezed random start: whatever comes back is valid
    const s = k.randomStart(mulberry32(6));
    squeeze(k, s, { mus: [10, 100, 1000] });
    const g = k.finish(s, () => true);
    if (g) expect(k.validate(g.config).valid).toBe(true);
  });

  it("runs on infeasible problems without throwing, and finish gives null", () => {
    // twelve disks of diameter 1 at K = 1 have more area than the open hemisphere (12 * 0.77 > 2 pi); no unit square
    // fits in a hyperbolic triangle of the family's range; two unit pentagons do not fit in any disk at K = 1
    // (docs/spaces/CURVED.md, the catalogue)
    for (const id of ["1/0/0/12", "-1/5/3/1", "1/5/0/2"]) {
      const k = curvedKernel(problem(id));
      expect(RECORDS.find((r) => r.id === `curved/${id}`)?.status ?? "infeasible").toBe("infeasible");
      const s = k.randomStart(mulberry32(1));
      expect(Number.isFinite(k.energy(s))).toBe(true);
      squeeze(k, s, { mus: [10, 100] });
      expect(k.finish(s)).toBeNull();
      expect(k.validate(k.toConfig(s)).valid).toBe(false);
    }
    // no unit octagon exists at K = 1: not a problem at all
    expect(() => curvedKernel({ K: 1, N: 8, M: 4, P: 1 })).toThrow(RangeError);
  });

  it("mirrors the server's checks of form and bounds", () => {
    const k = curvedKernel(problem("-1/3/4/3"));
    const r = RECORDS.find((q) => q.id === "curved/-1/3/4/3")!;
    expect(k.validate(r.config).valid).toBe(true);
    expect(k.validate({ size: "1", pieces: r.config.pieces })).toMatchObject({ valid: false, score: null });
    expect(k.validate({ size: r.config.size, pieces: r.config.pieces.slice(1) })).toMatchObject({ valid: false });
    const far = { ...r.config, pieces: r.config.pieces.map((p, i) => (i ? p : { ...p, theta: 2e4 })) };
    expect(k.validate(far)).toMatchObject({ valid: false, score: null });
    // a size below the area bound is refused before the geometry is checked
    expect(k.validate({ ...r.config, size: k.bound! * 0.9 })).toMatchObject({ valid: false, score: k.bound! * 0.9 });
    // 1e-9 overlap is touching for the server (like validate.ts at TOL); more is not
    const shrunk = { ...r.config, size: r.config.size * (1 - 1e-6) };
    expect(k.validate(shrunk).valid).toBe(false);
    expect(k.fromConfig({ size: 1, pieces: [] })).toBeNull();
  });

  it("counts pieces beyond float range as overlapping, and refuses configurations outside the server's limits", () => {
    const k = curvedKernel(problem("-1/3/4/2"));
    const s = k.fromConfig({ size: 3, pieces: [{ x: 0.1, y: 0, theta: 0 }, { x: 0, y: 0.5, theta: 0 }] })!;
    // a chart offset of 800 length units: cosh overflows, so the piece's coordinates are not finite
    s.x[0] = 800;
    const g = new Float64Array(2 * k.dim + 1);
    expect(k.energy(s, g)).toBe(Infinity);
    expect(g.every(Number.isFinite)).toBe(true);
    expect(k.clear(s, 0, 0)).toBe(false);
    expect(k.finish(s)).toBeNull();
    const ok = { size: 3, pieces: [{ x: 0.1, y: 0, theta: 0 }, { x: 0, y: 0.5, theta: 0 }] };
    for (const bad of [
      { ...ok, size: 2e6 },
      { ...ok, pieces: [{ x: 2e4, y: 0, theta: 0 }, ok.pieces[1]] },
      { ...ok, pieces: [{ x: 0, y: 0, theta: 1e300 }, ok.pieces[1]] },
      // within the coordinate limits, but far outside the container (the server's far-centre test)
      { ...ok, pieces: [{ x: 300, y: 0, theta: 0 }, ok.pieces[1]] },
    ]) {
      expect(k.fromConfig(bad)).toBeNull();
      expect(k.validate(bad).valid).toBe(false);
    }
  });

  it("names problems as the catalogue does, and accepts P through 100 as the server does", () => {
    expect(curvedKernel({ K: 1e-6, N: 4, M: 4, P: 5 }).id).toBe("curved/1e-06/4/4/5");
    expect(curvedKernel({ K: -1e-6, N: 0, M: 0, P: 7 }).id).toBe("curved/-1e-06/0/0/7");
    expect(curvedKernel({ K: -1, N: 3, M: 8, P: 29 }).id).toBe("curved/-1/3/8/29");
    for (const r of RECORDS.slice(0, 40)) expect(curvedKernel({ K: r.K, N: r.N, M: r.M, P: r.P }).id).toBe(r.id);
    expect(curvedKernel({ K: -1, N: 0, M: 0, P: 100 }).P).toBe(100);
    expect(() => curvedKernel({ K: -1, N: 0, M: 0, P: 101 })).toThrow(/100/);
  });

  it("caps a finish's work, and polls the stop inside the polish's linear programs", () => {
    // two hexagons do not fit in a hyperbolic square: finish gives up within its cap
    const bad = curvedKernel(problem("-1/6/4/2"));
    const space = makeSpace(-1, 6, 4);
    const geometry = { space, P: 2, dim: 3, sizeCap: Infinity };
    for (let seed = 1; seed <= 3; seed++) {
      const s = bad.randomStart(mulberry32(seed));
      relax(bad, s, { maxIter: 300 });
      const stats = { work: 0 };
      const poses = (bad.toConfig(s) as CurvedConfig).pieces;
      expect(curvedFinish(geometry, poses, s.size, { bound: bad.bound, cost: bad.finishCost, stats })).toBeNull();
      // the cap, plus at most one legalisation (a few dozen validator calls)
      expect(stats.work).toBeLessThan(FINISH_CAP * bad.finishCost + 60 * VALIDATE_WORK);
    }
    // the stop is polled at every simplex pivot, many times per polish iteration
    const k = curvedKernel(problem("-1/3/8/10"));
    const s = k.randomStart(mulberry32(2));
    squeeze(k, s, { mus: [10, 100] });
    let polls = 0;
    k.finish(s, () => (polls++, false));
    expect(polls).toBeGreaterThan(5 * FINISH_ITER);
  });

  it("growth can open an overlap between flush polygons far from O at strong curvature; a relaxation closes it", () => {
    // two triangles sharing most of an edge, 1.9 from O at K = -4 (docs/spaces/CURVED.md §13): the
    // radial growth turns them against each other by K times the change of the area of the
    // triangle O c_i c_j, which beats their separation here
    const k = curvedKernel({ K: -4, N: 3, M: 0, P: 2 });
    const s = k.fromConfig({
      size: 10,
      pieces: [
        { x: 1.645448267190433, y: -0.9500000000000008, theta: 3.141592653589793 },
        { x: 2.4455848629200303, y: -1.333239739695534, theta: -0.8502778936811567 },
      ],
    })!;
    expect(k.energy(s)).toBeLessThan(1e-20);
    k.setSize(s, 10 * (1 + 1e-6));
    expect(k.energy(s)).toBeGreaterThan(1e-13);
    relax(k, s, { maxIter: 300 });
    expect(k.energy(s)).toBeLessThan(1e-20);
  });

  it("seeds rings that finish to the tilings at K*, the hyperbolic disk rings and six squares in a hexagon", () => {
    // [id, the size to reach]: a record's, or for disks of diameter 1 (no records yet) the analytic ring's
    const ring = (K: number, P: number) => {
      const r = DISK_RADIUS;
      return 2 * (r + Math.asinh(Math.sinh(Math.sqrt(-K) * r) / Math.sin(Math.PI / P)) / Math.sqrt(-K)); // (diameter)
    };
    const targets: [string, number, string][] = [
      ...["curved/-3.4413111779836725/3/9/9", "curved/-4.50521902808615/3/10/10", "curved/-1/4/6/6"].map((id): [string, number, string] => {
        const r = RECORDS.find((q) => q.id === id)!;
        return [id, r.score_cert, id];
      }),
      ["-1/0/0/5", ring(-1, 5), "5 disks in a ring"],
      ["-1/0/0/10", ring(-1, 10), "10 disks in a ring"],
    ];
    for (const [id, want] of targets) {
      const r = id.startsWith("curved/") ? RECORDS.find((q) => q.id === id)! : { ...problem(id) };
      const k = curvedKernel({ K: r.K, N: r.N, M: r.M, P: r.P });
      const seeds = k.seeds!(mulberry32(1), 12);
      expect(seeds.length, id).toBeGreaterThan(0);
      let best = Infinity;
      for (const s of seeds) {
        const f = k.finish(s);
        if (f) {
          expect(k.validate(f.config).valid).toBe(true);
          best = Math.min(best, f.score);
        }
      }
      expect(best, id).toBeLessThanOrEqual(want * (1 + 1e-9));
    }
  });

  it("times energy() at P = 10 and P = 30", () => {
    const rng = mulberry32(3);
    for (const id of ["-1/0/0/10", "-1/3/8/10", "-1/0/0/30", "-1/3/8/29"]) {
      const k = curvedKernel(problem(id));
      // the states a squeeze of a random start visits, every 25th
      const visited: KernelState[] = [];
      let calls = 0;
      const tap = { ...k, energy: (s: KernelState, g?: Float64Array) => (calls++ % 25 || visited.push(k.clone(s)), k.energy(s, g)) };
      squeeze(tap, k.randomStart(rng));
      const g = new Float64Array(k.P * k.dim + 1);
      const t = performance.now();
      for (let q = 0; q < 5; q++) for (const s of visited) k.energy(s, g);
      const ms = (performance.now() - t) / (5 * visited.length);
      console.log(`curved kernel ${id}: ${ms.toFixed(4)} ms per energy() with gradient (${visited.length} states)`);
      expect(ms).toBeGreaterThan(0);
    }
  });
});
