/**
 * The kernel of the generic search methods (src/kernel.ts): the methods' contract on a spread of problems,
 * exact gradients in the charts and for soft shapes, records in and out, squeeze and finish from random starts,
 * seeds, the server's rule, moves undone, states that blew up, absurd starts and a finish told to stop.
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type KernelState, type SpaceKernel, mulberry32, runMethod, squeeze } from "@polypack/methods";
import { checkKernel } from "@polypack/methods/contract";
import { getProblem, getSolid, polyhedraKernel, validatePolyhedra } from "../src";
import { readProblemConfigs } from "../src/records-file";

const recordsPath = new URL("../../../data/polyhedra/records.json", import.meta.url).pathname;
const haveRecords = existsSync(recordsPath);
/** A research record's configuration, read from its problem's file alone; its s is the record's certified score. */
const recordConfig = (code: string, P: number) => readProblemConfigs(recordsPath, code).get(P)!;

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

describe("polyhedraKernel", () => {
  // piece and container solids of every family; P = 2, 5 and 12
  const spread: [string, number][] = [
    ["cubintet", 2],
    ["tteintte", 2],
    ["ap5inap5", 2],
    ["tetintet", 5],
    ["ddoinddo", 5],
    ["pr3l15incub", 5],
    ["octincub", 12],
    ["rdoinrdo", 12],
    ["pr9incub", 12],
  ];
  for (const [code, P] of spread)
    it(`passes the kernel contract: ${code}, P = ${P}`, () => {
      expect(checkKernel(() => polyhedraKernel({ code, P }), { seed: P })).toEqual([]);
    });

  it("passes the kernel contract at a large P: 80 tetrahedra in a tetrahedron", () => {
    expect(checkKernel(() => polyhedraKernel({ code: "tetintet", P: 80 }), { seed: 3, states: 2 })).toEqual([]);
  });

  it("has the gradient of its energy in charts turned away from their anchors, for true and soft shapes", () => {
    for (const [code, P] of [
      ["cubincub", 6],
      ["ddoinddo", 4],
      ["pr3l3incub", 5],
      ["sncinsnc", 3],
    ] as const) {
      const k = polyhedraKernel({ code, P });
      const rng = mulberry32(2);
      const s = k.randomStart(rng);
      // overlapping pieces and walls, with chart rotations of up to 3 steps
      k.setSize(s, 0.45 * s.size);
      for (let i = 0; i < P; i++) k.jiggle(s, i, 3, rng);
      expect(k.energy(s), code).toBeGreaterThan(1e-3);
      for (const t of [1, 0.6, 0]) {
        k.setShape!(s, t);
        expect(gradientError(k, s), `${code}, t = ${t}`).toBeLessThan(1e-5);
      }
    }
  });

  it("softens pieces monotonically into their inscribed balls", () => {
    const k = polyhedraKernel({ code: "tetintet", P: 2 });
    const rho = getSolid("tetrahedron").inradius;
    // two tetrahedra 1.5 inradii apart in a large container: at t = 0 two balls of radius rho overlapping by rho / 2
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
  });

  it("splits its energy into the pieces' terms, and clear() agrees with them", () => {
    const k = polyhedraKernel({ code: "icoincub", P: 7 });
    const rng = mulberry32(4);
    const s = k.randomStart(rng);
    k.setSize(s, 0.6 * s.size);
    // without walls, every pair term is in two pieces' energies
    const free = k.clone(s);
    free.size = 1e3;
    const e = k.energy(free);
    expect(e).toBeGreaterThan(0);
    let sum = 0;
    for (let i = 0; i < k.P; i++) sum += k.pieceEnergy(free, i);
    expect(sum).toBeCloseTo(2 * e, 12);
    for (let i = 0; i < k.P; i++) expect(k.clear(s, i, 0)).toBe(k.pieceEnergy(s, i) === 0);
  });

  it("swaps the orientations of two pieces and keeps their centres", () => {
    const k = polyhedraKernel({ code: "pr5incub", P: 4 });
    const s = k.randomStart(mulberry32(5));
    k.jiggle(s, 1, 1, mulberry32(6));
    const before = k.toConfig(s) as { pieces: number[][] };
    k.swap!(s, 1, 3);
    const after = k.toConfig(s) as { pieces: number[][] };
    expect(after.pieces[1].slice(0, 3)).toEqual(before.pieces[1].slice(0, 3));
    for (let d = 3; d < 7; d++) {
      expect(after.pieces[1][d]).toBeCloseTo(before.pieces[3][d], 14);
      expect(after.pieces[3][d]).toBeCloseTo(before.pieces[1][d], 14);
    }
  });

  it("squeezes random starts and finishes them into valid packings", () => {
    for (const [code, P, seed] of [
      ["cubincub", 5, 1],
      ["tetintet", 4, 2],
      ["pr5incub", 6, 3],
      ["icoinico", 3, 4],
    ] as const) {
      const k = polyhedraKernel({ code, P });
      const s = k.randomStart(mulberry32(seed));
      const roomy = s.size;
      squeeze(k, s);
      const f = k.finish(s);
      expect(f, code).not.toBeNull();
      expect(validatePolyhedra(getProblem(code)!, f!.config as never, { tol: 0 }).valid, code).toBe(true);
      expect(k.validate(f!.config).valid, code).toBe(true);
      expect(f!.score, code).toBeLessThan(0.8 * roomy);
      expect(f!.score, code).toBeGreaterThan(k.bound!);
    }
  });

  it("seeds box-lattice patches that are packings already, tilings for cubes", () => {
    for (const [code, P] of [
      ["cubincub", 8],
      ["cubincub", 27],
      ["pr3incub", 6],
      ["octinoct", 6],
    ] as const) {
      const k = polyhedraKernel({ code, P });
      const seeds = k.seeds!(mulberry32(1), 3);
      expect(seeds.length).toBe(3);
      for (const q of seeds) {
        expect(k.energy(q), code).toBeLessThan(1e-20);
        const f = k.finish(q)!;
        expect(k.validate(f.config).valid, code).toBe(true);
        expect(f.score, code).toBeLessThanOrEqual(q.size * (1 + 1e-9));
      }
      // the canonical orientation's patch: 2 x 2 x 2 and 3 x 3 x 3 cubes fill the cube of side 2 and 3
      if (code === "cubincub") expect(seeds[0].size).toBeCloseTo(Math.cbrt(P), 12);
    }
  });

  it("validates as the server does", () => {
    const k = polyhedraKernel({ code: "cubincub", P: 2 });
    const side = (gap: number) => ({ s: 5, pieces: [[0, 0, 0, 1, 0, 0, 0], [1 + gap, 0, 0, 1, 0, 0, 0]] });
    // pieces may overlap by the touching tolerance 1e-9, not more
    expect(k.validate(side(-0.5e-9))).toEqual({ valid: true, score: 5, reasons: [] });
    expect(k.validate(side(-1e-8)).valid).toBe(false);
    // malformed, or the wrong number of pieces: no score
    expect(k.validate({ s: "5", pieces: [] })).toMatchObject({ valid: false, score: null });
    expect(k.validate({ s: 5, pieces: [[0, 0, 0, 1, 0, 0, 0]] })).toMatchObject({ valid: false, score: null });
    expect(k.fromConfig({ s: 5, pieces: [[0, 0, 0, 0, 0, 0, 0], [2, 0, 0, 1, 0, 0, 0]] })).toBeNull();
    // below the volume bound (2^(1/3) for two unit cubes in a cube) by more than 1e-9 relative
    const tiny = polyhedraKernel({ code: "cubincub", P: 8 });
    expect(tiny.bound).toBeCloseTo(2, 12);
    const r = tiny.validate({ s: 1.999, pieces: Array.from({ length: 8 }, () => [0, 0, 0, 1, 0, 0, 0]) });
    expect(r.valid).toBe(false);
    expect(r.reasons[0]).toMatch(/lower bound/);
  });

  it.skipIf(!haveRecords)("takes research records in and finishes them no worse than the record", () => {
    // cubes with the wiki's clearance, truncated tetrahedra, and prisms stored with integer quaternions near 5e48
    for (const [code, P] of [
      ["cubincub", 11],
      ["tteintte", 8],
      ["pr8l15incub", 2],
    ] as const) {
      const k = polyhedraKernel({ code, P });
      const record = recordConfig(code, P);
      expect(k.validate(record).valid, code).toBe(true);
      const s = k.fromConfig(record)!;
      expect(s.size).toBe(record.s);
      expect(k.energy(s), code).toBe(0);
      // the conversion keeps the configuration valid (with unit quaternions)
      expect(validatePolyhedra(getProblem(code)!, k.toConfig(s) as never, { tol: 0 }).valid, code).toBe(true);
      const f = k.finish(s)!;
      expect(f, code).not.toBeNull();
      expect(f.score, code).toBeLessThanOrEqual(record.s * (1 + 1e-9));
      expect(validatePolyhedra(getProblem(code)!, f.config as never, { tol: 0 }).valid, code).toBe(true);
    }
  });

  it("states its lower bound, its costs and its capabilities", () => {
    const k = polyhedraKernel({ code: "dodindod", P: 10 });
    expect(k.id).toBe("polyhedra/dodindod/10");
    expect(k.space).toBe("polyhedra");
    expect(k.capabilities).toEqual(["shape", "seeds", "swap"]);
    expect(k.bound).toBeCloseTo(Math.cbrt(10), 12);
    expect(k.finishCost).toBeGreaterThanOrEqual(10);
    expect(k.validateCost).toBeGreaterThanOrEqual(1);
    expect(k.validateCost).toBeLessThan(k.finishCost);
    // a finish costs more energies for a cheap solid than for a costly one, and more at small P
    expect(polyhedraKernel({ code: "phcinphc", P: 10 }).finishCost).toBeLessThan(k.finishCost);
    expect(polyhedraKernel({ code: "cubincub", P: 3 }).finishCost).toBeGreaterThan(
      polyhedraKernel({ code: "cubincub", P: 80 }).finishCost,
    );
    expect(() => polyhedraKernel({ code: "nope", P: 3 })).toThrow(/unknown/);
    expect(() => polyhedraKernel({ code: "cubincub", P: 0 })).toThrow(/positive/);
    // the server accepts P up to 100
    expect(() => polyhedraKernel({ code: "cubincub", P: 101 })).toThrow(/at most 100/);
  });

  it("undoes randomPose and jiggle when the piece's variables are written back", () => {
    const k = polyhedraKernel({ code: "tetincub", P: 4 });
    const rng = mulberry32(8);
    const s = k.randomStart(rng);
    k.jiggle(s, 2, 1, rng);
    const before = k.toConfig(s) as { pieces: number[][] };
    for (const move of ["randomPose", "jiggle"] as const) {
      const saved = s.x.slice(12, 18);
      if (move === "randomPose") k.randomPose(s, 2, rng);
      else k.jiggle(s, 2, 3, rng);
      expect((k.toConfig(s) as { pieces: number[][] }).pieces[2]).not.toEqual(before.pieces[2]);
      s.x.set(saved, 12);
      const after = k.toConfig(s) as { pieces: number[][] };
      for (let i = 0; i < 4; i++)
        for (let d = 0; d < 7; d++) expect(after.pieces[i][d], move).toBeCloseTo(before.pieces[i][d], 14);
    }
  });

  it("has no NaN: huge rotations stay finite, a state that blew up has energy Infinity and no finish", () => {
    const k = polyhedraKernel({ code: "cubincub", P: 4 });
    const s = k.randomStart(mulberry32(3));
    const g = new Float64Array(4 * k.dim + 1);
    for (const big of [1e15, 1e200]) {
      const q = k.clone(s);
      for (let i = 0; i < 4; i++) q.x.set([big, -big / 3, big / 7], 6 * i + 3);
      const e = k.energy(q, g);
      expect(Number.isFinite(e) && e >= 0).toBe(true);
      expect(g.every(Number.isFinite)).toBe(true);
      expect((k.toConfig(q) as { pieces: number[][] }).pieces.flat().every(Number.isFinite)).toBe(true);
      const f = k.finish(q);
      if (f) expect(k.validate(f.config).valid).toBe(true);
    }
    for (const bad of [NaN, Infinity]) {
      const q = k.clone(s);
      q.x[7] = bad;
      expect(k.energy(q, g)).toBe(Infinity);
      expect(k.pieceEnergy(q, 1)).toBe(Infinity);
      expect(k.clear(q, 1, 0)).toBe(false);
      expect(k.finish(q)).toBeNull();
    }
  });

  it("refuses an absurd start, and a run given one ends within its time budget", () => {
    const k = polyhedraKernel({ code: "cubincub", P: 5 });
    const absurd = { s: 1e300, pieces: Array.from({ length: 5 }, (_, i) => [1e17 * (i + 1), -1e17, 3e16, 1, 0, 0, 0]) };
    expect(k.fromConfig(absurd)).toBeNull();
    expect(k.validate(absurd)).toMatchObject({ valid: false, score: null });
    // the largest start the server would read is taken; it is far from tight, but a run on it stays budgeted
    const roomy = { s: 1e6, pieces: Array.from({ length: 5 }, (_, i) => [1e4 * (i % 2 ? 1 : -1), 0, 0, 1, 0, 0, 0]) };
    expect(k.fromConfig(roomy)).not.toBeNull();
    for (const start of [absurd, roomy]) {
      const t0 = performance.now();
      const r = runMethod(k, "penalty", { seed: 1, start, budget: { evals: 3000, time_s: 20 } });
      expect((performance.now() - t0) / 1000).toBeLessThan(30);
      expect(["evals", "time", "done", "bound"]).toContain(r.stopped);
      if (r.config) expect(k.validate(r.config).valid).toBe(true);
    }
  });

  it.skipIf(!haveRecords)("stops a finish under way: an always-true stop returns the legalized start at once", () => {
    const cpu = () => {
      const u = process.cpuUsage();
      return (u.user + u.system) / 1000;
    };
    // 100 truncated icosidodecahedra: the slowest finish ([CALC] about 1.4 s of processor time without a stop)
    const k = polyhedraKernel({ code: "tidintid", P: 100 });
    const record = recordConfig("tidintid", 100);
    const s = k.fromConfig(record)!;
    let polls = 0;
    const t0 = cpu();
    const f = k.finish(s, () => (polls++, true));
    const ms = cpu() - t0;
    // the stop is read once, before the polish; the legalized record comes back
    expect(polls).toBe(1);
    expect(f).not.toBeNull();
    expect(f!.score).toBeLessThanOrEqual(record.s);
    expect(k.validate(f!.config).valid).toBe(true);
    expect(ms).toBeLessThan(1000);
    // a stop that comes during the polish ends it as well, with a valid result
    let n = 0;
    const g = k.finish(s, () => ++n > 30);
    expect(n).toBeLessThan(40);
    expect(k.validate(g!.config).valid).toBe(true);
  });

  // Processor time of energy(), finish() and validate() after a squeeze, for docs/spaces/POLYHEDRA.md: medians of
  // three random starts. Run with
  //   POLYHEDRA_KERNEL_BENCH=1 npx vitest run packages/polyhedra/test/kernel.test.ts
  // (POLYHEDRA_KERNEL_BENCH_CODES and POLYHEDRA_KERNEL_BENCH_P choose the problems and the P).
  it.skipIf(!process.env.POLYHEDRA_KERNEL_BENCH)("measures energy(), finish() and validate()", () => {
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
    const codes = (process.env.POLYHEDRA_KERNEL_BENCH_CODES ?? "cubincub,tetintet,tidintid,ddoinddo").split(",");
    const Ps = (process.env.POLYHEDRA_KERNEL_BENCH_P ?? "3,10,50").split(",").map(Number);
    for (const code of codes)
      for (const P of Ps) {
        const k = polyhedraKernel({ code, P });
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
          `${code} P = ${P}: energy ${median(e).toFixed(3)} ms; finish ${Math.round(median(f))} energies (finishCost ${k.finishCost}); validate ${median(v).toFixed(1)} energies (validateCost ${k.validateCost})`,
        );
      }
  });
});
