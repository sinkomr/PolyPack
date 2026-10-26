/**
 * The surface kernel for the generic methods (src/kernel.ts), fold mode: the kernel contract on
 * a spread of problems, research records through fromConfig, validate and finish, squeezed random
 * starts, and the pieces of the model that the contract does not reach (charts far outside their
 * faces, soft outlines, seeds, the server's rule).
 */
import { readFileSync } from "node:fs";
import { pieceVertices } from "@polypack/geometry";
import { type KernelState, mulberry32, runMethod, squeeze } from "@polypack/methods";
import { checkKernel } from "@polypack/methods/contract";
import { describe, expect, it } from "vitest";
import { type SolidName, getSolid, surfaceKernel, validateFold } from "../src/index";
import { pieceOutline } from "../src/kernel-energy";
import { chartPoint, faceShapes, surfaceBound, unfoldChart } from "../src/kernel-solid";
import { canonicalize } from "../src/search/energy";
import { randomFacePoint, rng, walkRay } from "./helpers";

interface FoldRecord {
  id: string;
  solid: SolidName;
  N: number;
  P: number;
  s: number;
  pieces: { face: number; x: number; y: number; theta: number }[];
  bound: { value: number };
}
const records: FoldRecord[] = JSON.parse(
  readFileSync(new URL("../../../data/surface/records.json", import.meta.url), "utf8"),
).records;
const record = (id: string) => records.find((r) => r.id === id)!;

describe("the surface kernel (fold)", () => {
  // faces matched by the pieces (squares on the cube, triangles on the deltahedra, pentagons on
  // the dodecahedron, hexagons on the triangles) and not, disks, one piece and several
  const problems: [SolidName, number, number][] = [
    ["tetrahedron", 0, 1],
    ["tetrahedron", 3, 4],
    ["tetrahedron", 6, 3],
    ["cube", 4, 3],
    ["cube", 5, 2],
    ["cube", 0, 7],
    ["octahedron", 3, 5],
    ["octahedron", 8, 2],
    ["dodecahedron", 5, 2],
    ["dodecahedron", 0, 6],
    ["icosahedron", 3, 7],
    ["icosahedron", 4, 3],
    // pieces larger than the faces (finishes once failed from relaxed random starts here)
    ["dodecahedron", 3, 5],
    ["dodecahedron", 3, 6],
    ["icosahedron", 6, 22],
  ];
  for (const [solid, N, P] of problems)
    it(`passes the kernel contract: ${solid}, N = ${N}, P = ${P}`, () => {
      expect(checkKernel(() => surfaceKernel({ solid, N, P }), { seed: 3 * P + N })).toEqual([]);
    });

  it("refuses problems it does not have", () => {
    expect(() => surfaceKernel({ solid: "prism" as SolidName, N: 4, P: 2 })).toThrow(/solid/);
    expect(() => surfaceKernel({ solid: "cube", N: 2, P: 2 })).toThrow(/N/);
    expect(() => surfaceKernel({ solid: "cube", N: 4, P: 0 })).toThrow(/P/);
  });

  it("states every record's lower bound to the last bit, as the server checks it", () => {
    // all 2038 records, fold and nofold; the bound depends on the solid, N and P only
    const all: { id: string; solid: SolidName; N: number; P: number; bound: { value: number } }[] = JSON.parse(
      readFileSync(new URL("../../../data/surface/records.json", import.meta.url), "utf8"),
    ).records;
    const off = all.filter((r) => surfaceBound(getSolid(r.solid), r.N, r.P) !== r.bound.value).map((r) => r.id);
    expect(off).toEqual([]);
    expect(all.length).toBeGreaterThan(2000);
    // so a size just below the bound is refused by the kernel exactly when the server refuses it
    const r = record("surface/tetrahedron/fold/5/1");
    const k = surfaceKernel({ solid: "tetrahedron", N: 5, P: 1 });
    const at = (f: number) => ({ s: r.bound.value * f, pieces: r.pieces.map((p) => ({ ...p, x: (p.x * r.bound.value * f) / r.s, y: (p.y * r.bound.value * f) / r.s })) });
    expect(k.validate(at(1 - 1.01e-9)).reasons[0]).toMatch(/below the lower bound/);
    expect(k.validate(at(1 - 0.99e-9)).reasons.join()).not.toMatch(/below the lower bound/);
    expect(k.fromConfig(at(1 - 1.01e-9))).toBeNull();
    expect(k.fromConfig(at(1 - 0.99e-9))).not.toBeNull();
  });

  it("ends quickly on a start far below the bound", () => {
    // a past case: a method handed a start at 0.05 of the bound ran 15 minutes past its budget
    const k = surfaceKernel({ solid: "cube", N: 4, P: 3 });
    const start = { ...(k.toConfig(k.randomStart(() => 0.37)) as object), s: k.bound! * 0.05 };
    expect(k.fromConfig(start)).toBeNull();
    let t0 = performance.now();
    const r = runMethod(surfaceKernel({ solid: "cube", N: 4, P: 3 }), "penalty", { seed: 1, start, budget: { evals: 2000 } });
    expect(performance.now() - t0).toBeLessThan(20000);
    expect(r.evaluations).toBeLessThan(2000 + k.finishCost + 2 * k.gradCost!);
    // finish: nothing well below the bound, in no time; from below the bound up to it, a valid packing
    for (const [solid, N, P] of [
      ["cube", 4, 1],
      ["dodecahedron", 3, 5],
      ["icosahedron", 0, 5],
    ] as [SolidName, number, number][]) {
      const kk = surfaceKernel({ solid, N, P });
      for (const f of [0.03, 0.1, 0.49]) {
        const s = kk.randomStart(mulberry32(1));
        kk.setSize(s, kk.bound! * f);
        t0 = performance.now();
        expect(kk.finish(s)).toBeNull();
        // the model's energy stays bounded too: Infinity once a piece crosses too many chains
        const e = kk.energy(s, new Float64Array(P * kk.dim + 1));
        expect(e > 0).toBe(true);
        expect(performance.now() - t0).toBeLessThan(500);
      }
      const s = kk.randomStart(mulberry32(1));
      kk.setSize(s, kk.bound! * 0.7);
      const fin = kk.finish(s)!;
      expect(fin.score).toBeGreaterThanOrEqual(kk.bound!);
      expect(kk.validate(fin.config).valid).toBe(true);
    }
  });

  for (const id of ["surface/cube/fold/3/7", "surface/octahedron/fold/0/5", "surface/icosahedron/fold/5/23", "surface/dodecahedron/fold/8/4"])
    it(`converts, validates and finishes the research record ${id}`, () => {
      const r = record(id);
      const k = surfaceKernel({ solid: r.solid, N: r.N, P: r.P });
      const config = { s: r.s, pieces: r.pieces };
      expect(k.validate(config)).toEqual({ valid: true, score: r.s, reasons: [] });
      const s = k.fromConfig(config)!;
      expect(s.size).toBe(r.s);
      // the round trip keeps every pose (disks drop their angle, which means nothing for a disk)
      const back = k.toConfig(s) as typeof config;
      back.pieces.forEach((p, i) => {
        expect(p.face).toBe(r.pieces[i].face);
        expect(p.x).toBeCloseTo(r.pieces[i].x, 12);
        expect(p.y).toBeCloseTo(r.pieces[i].y, 12);
        if (r.N > 0) expect(p.theta).toBe(r.pieces[i].theta);
      });
      expect(k.energy(s)).toBeLessThan(1e-20);
      const f = k.finish(s)!;
      expect(f).not.toBeNull();
      expect(f.score).toBeLessThanOrEqual(r.s * (1 + 1e-9));
      const c = f.config as typeof config;
      expect(validateFold({ solid: r.solid, N: r.N, s: c.s, pieces: c.pieces }, { tol: 0 }).ok).toBe(true);
      expect(k.validate(c).valid).toBe(true);
    });

  it("squeezes random starts into packings that finish valid", () => {
    const cases: [SolidName, number, number, number][] = [
      // solid, N, P, and an upper limit on the squeezed edge: 10% above the record (three random
      // starts rarely reach the tetrahedron's exact tiling; they end 9% above it)
      ["cube", 0, 6, record("surface/cube/fold/0/6").s * 1.1],
      ["tetrahedron", 3, 4, 1.1],
      ["octahedron", 4, 3, record("surface/octahedron/fold/4/3").s * 1.1],
      ["icosahedron", 0, 5, record("surface/icosahedron/fold/0/5").s * 1.1],
    ];
    for (const [solid, N, P, limit] of cases) {
      const k = surfaceKernel({ solid, N, P });
      const rand = mulberry32(11);
      let best = Infinity;
      for (let t = 0; t < 3; t++) {
        const s = k.randomStart(rand);
        squeeze(k, s);
        const f = k.finish(s);
        expect(f).not.toBeNull();
        const c = f!.config as { s: number; pieces: { face: number; x: number; y: number; theta: number }[] };
        expect(validateFold({ solid, N, s: c.s, pieces: c.pieces }, { tol: 0 }).ok).toBe(true);
        expect(k.validate(c).valid).toBe(true);
        best = Math.min(best, f!.score);
      }
      expect(best).toBeLessThan(limit);
      expect(best).toBeGreaterThanOrEqual(k.bound! * (1 - 1e-9));
    }
  });

  it("keeps the gradient right when charts have wandered far from their faces", () => {
    for (const [solid, N, P] of [
      ["icosahedron", 3, 8],
      ["cube", 0, 6],
      ["tetrahedron", 5, 3],
    ] as [SolidName, number, number][]) {
      const k = surfaceKernel({ solid, N, P });
      const r = mulberry32(5);
      const s = k.randomStart(r);
      k.setSize(s, s.size * 0.7);
      // up to three steps per variable, without a rebase: many centres leave their faces
      for (let i = 0; i < P; i++) k.jiggle(s, i, 3, r);
      const n = P * k.dim;
      const g = new Float64Array(n + 1);
      const e = k.energy(s, g);
      expect(e).toBeGreaterThan(0);
      let checked = 0;
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
        // a coordinate whose difference quotient straddles a jump of the energy says nothing
        const fwd = (k.energy(p) - e) / h;
        const bwd = (e - k.energy(m)) / h;
        if (Math.abs(fwd - bwd) > 1e-3 * Math.max(1, Math.abs(fd))) continue;
        expect(Math.abs(fd - g[i])).toBeLessThan(1e-4 * Math.max(1, Math.abs(fd)));
        checked++;
      }
      expect(checked).toBeGreaterThan(0.9 * (n + 1));
      // rebase moves no piece
      const c = k.clone(s);
      k.rebase(c);
      expect(k.energy(c)).toBeCloseTo(e, 9);
    }
  });

  it("develops a chart along the segment from its face's centre", () => {
    for (const name of ["tetrahedron", "cube", "icosahedron"] as SolidName[]) {
      const S = getSolid(name);
      const rand = rng(17);
      for (let t = 0; t < 300; t++) {
        const face = Math.floor(rand() * S.F);
        const a = 2 * Math.PI * rand();
        const L = 0.2 + 1.5 * rand();
        const p = { face, x: L * Math.cos(a), y: L * Math.sin(a), theta: rand() };
        const u = unfoldChart(S, p);
        // the reference walks the same ray from the centre (null when it passes near a vertex)
        const w = walkRay(S, 1, face, 0, 0, Math.cos(a), Math.sin(a), L, 1e-7);
        if (!w) continue;
        expect(u.face).toBe(w.face);
        expect(u.x).toBeCloseTo(w.x, 9);
        expect(u.y).toBeCloseTo(w.y, 9);
      }
      // across one edge it is the fold search's canonicalize
      for (let t = 0; t < 100; t++) {
        const [x, y] = randomFacePoint(S, 1, rand);
        const k = Math.floor(rand() * S.M);
        const ang = (2 * Math.PI * (k + 1)) / S.M - Math.PI / 2;
        const ap = faceShapes(S)[0].inner;
        // push the point just across edge k, away from the corners
        const d = ap - (x * Math.cos(ang) + y * Math.sin(ang)) + 0.01;
        const q = { face: 0, x: x + d * Math.cos(ang), y: y + d * Math.sin(ang), theta: 0.3 };
        const c = canonicalize(S, 1, q);
        const u = unfoldChart(S, q);
        if (c.face !== u.face) continue;
        expect(u.x).toBeCloseTo(c.x, 12);
        expect(u.y).toBeCloseTo(c.y, 12);
        expect(u.theta).toBeCloseTo(c.theta, 12);
      }
    }
  });

  it("makes soft pieces inside the true ones, from the inscribed disk to the piece", () => {
    for (const N of [3, 4, 5, 6, 8]) {
      const pose = { face: 0, x: 0.1, y: -0.2, theta: 0.7 };
      const lam = 0.4;
      const truePoly = pieceVertices(N, pose, lam);
      const inside = (x: number, y: number) => {
        for (let k = 0; k < N; k++) {
          const j = (k + 1) % N;
          const ex = truePoly[2 * j] - truePoly[2 * k];
          const ey = truePoly[2 * j + 1] - truePoly[2 * k + 1];
          if (ex * (y - truePoly[2 * k + 1]) - ey * (x - truePoly[2 * k]) < -1e-15) return false;
        }
        return true;
      };
      for (const t of [0, 1e-13, 0.3, 0.9, 1 - 1e-7]) {
        const o = pieceOutline(N, pose, lam, t);
        for (let k = 0; k < o.poly.length; k += 2) {
          expect(inside(o.poly[k], o.poly[k + 1])).toBe(true);
          // each corner satisfies every side's half-plane, and lies on two of them
          let on = 0;
          for (let e = 0; e < o.b.length; e++) {
            const d = o.nx[e] * o.poly[k] + o.ny[e] * o.poly[k + 1] - o.b[e];
            expect(d).toBeLessThan(1e-14);
            if (Math.abs(d) < 1e-14) on++;
          }
          expect(on).toBeGreaterThanOrEqual(2);
        }
      }
      // t = 0: the corners lie on the inscribed circle
      const disk = pieceOutline(N, pose, lam, 0);
      const rIn = (lam * 0.5) / Math.tan(Math.PI / N);
      for (let k = 0; k < disk.poly.length; k += 2)
        expect(Math.hypot(disk.poly[k] - pose.x, disk.poly[k + 1] - pose.y)).toBeCloseTo(rIn, 14);
      expect(pieceOutline(N, pose, lam, 1).poly).toEqual(truePoly);
    }
  });

  it("seeds valid nofold layouts spread over the faces", () => {
    for (const [solid, N, P] of [
      ["cube", 4, 6],
      ["icosahedron", 3, 9],
      ["tetrahedron", 0, 7],
      ["dodecahedron", 6, 30],
    ] as [SolidName, number, number][]) {
      const k = surfaceKernel({ solid, N, P });
      const seeds = k.seeds!(mulberry32(2), 3);
      expect(seeds).toHaveLength(3);
      for (const s of seeds) {
        expect(s.size).toBeGreaterThanOrEqual(k.bound!);
        expect(k.validate(k.toConfig(s)).valid).toBe(true);
        const faces = [...(s.aux as { faces: Int32Array }).faces];
        const counts = new Map<number, number>();
        for (const f of faces) counts.set(f, (counts.get(f) ?? 0) + 1);
        const per = [...counts.values()];
        // as even as the faces allow
        expect(Math.max(...per) - Math.min(...(counts.size === getSolid(solid).F ? per : [0]))).toBeLessThanOrEqual(1);
      }
    }
  });

  it("swaps the angles of two polygons and offers no swap for disks", () => {
    const k = surfaceKernel({ solid: "cube", N: 3, P: 4 });
    const s = k.randomStart(mulberry32(4));
    const before = k.toConfig(s) as { pieces: { theta: number }[] };
    k.swap!(s, 0, 2);
    const after = k.toConfig(s) as { pieces: { theta: number }[] };
    expect(after.pieces[0].theta).toBeCloseTo(before.pieces[2].theta, 12);
    expect(after.pieces[2].theta).toBeCloseTo(before.pieces[0].theta, 12);
    // also for charts off their faces, and without moving an anchor
    for (let i = 0; i < 4; i++) k.jiggle(s, i, 2, mulberry32(i));
    const faces = Int32Array.from((s.aux as { faces: Int32Array }).faces);
    const off = k.toConfig(s) as { pieces: { theta: number }[] };
    k.swap!(s, 1, 3);
    const swapped = k.toConfig(s) as { pieces: { theta: number }[] };
    expect(swapped.pieces[1].theta).toBeCloseTo(off.pieces[3].theta, 12);
    expect(swapped.pieces[3].theta).toBeCloseTo(off.pieces[1].theta, 12);
    expect((s.aux as { faces: Int32Array }).faces).toEqual(faces);
    const disks = surfaceKernel({ solid: "cube", N: 0, P: 4 });
    expect(disks.capabilities).not.toContain("swap");
    expect(disks.swap).toBeUndefined();
    expect(k.capabilities).toEqual(["shape", "seeds", "swap"]);
  });

  it("moves change only the piece's variables, and random poses cover the surface evenly", () => {
    for (const [solid, N] of [
      ["icosahedron", 3],
      ["dodecahedron", 0],
      ["tetrahedron", 4],
    ] as [SolidName, number][]) {
      const k = surfaceKernel({ solid, N, P: 3 });
      const S = getSolid(solid);
      const r = mulberry32(8);
      const s = k.randomStart(r);
      const faces = Int32Array.from((s.aux as { faces: Int32Array }).faces);
      const hits = new Array<number>(S.F).fill(0);
      const draws = 80 * S.F;
      for (let t = 0; t < draws; t++) {
        const before = Float64Array.from(s.x);
        if (t % 2) k.randomPose(s, 1, r);
        else k.jiggle(s, 1, 1.5, r);
        for (let v = 0; v < s.x.length; v++) if (Math.floor(v / k.dim) !== 1) expect(s.x[v]).toBe(before[v]);
        expect((s.aux as { faces: Int32Array }).faces).toEqual(faces);
        if (t % 2) hits[(k.toConfig(s) as { pieces: { face: number }[] }).pieces[1].face]++;
      }
      // every face about equally often (40 expected per face; a loose band)
      for (const h of hits) expect(h).toBeGreaterThan(15);
    }
    // the chart point of a surface point unfolds back to it, from every face
    for (const name of ["cube", "octahedron", "dodecahedron"] as SolidName[]) {
      const S = getSolid(name);
      const rand = rng(23);
      for (let t = 0; t < 200; t++) {
        const g = Math.floor(rand() * S.F);
        const [x, y] = randomFacePoint(S, 1, rand);
        const f = Math.floor(rand() * S.F);
        const c = chartPoint(S, f, g, x, y)!;
        const u = unfoldChart(S, { face: f, x: c[0], y: c[1], theta: 0 });
        expect(u.face).toBe(g);
        expect(u.x).toBeCloseTo(x, 9);
        expect(u.y).toBeCloseTo(y, 9);
      }
    }
  });

  it("applies the server's rule", () => {
    const r = record("surface/cube/fold/3/7");
    const k = surfaceKernel({ solid: "cube", N: 3, P: 7 });
    const ok = { s: r.s, pieces: r.pieces };
    expect(k.validate(ok).valid).toBe(true);
    // a configuration with an overlap above the touching tolerance
    expect(k.validate({ ...ok, s: r.s * (1 - 1e-6) }).valid).toBe(false);
    // the form
    expect(k.validate({ s: r.s, pieces: r.pieces.slice(1) })).toMatchObject({ valid: false, score: null });
    expect(k.validate({ s: -1, pieces: r.pieces }).valid).toBe(false);
    expect(k.validate({ s: r.s, pieces: r.pieces.map((p, i) => (i ? p : { ...p, face: 6 })) }).valid).toBe(false);
    expect(k.validate({ s: r.s, pieces: r.pieces.map((p, i) => (i ? p : { ...p, x: 2e4 })) }).valid).toBe(false);
    expect(k.validate(null).valid).toBe(false);
    expect(k.fromConfig({ s: r.s, pieces: r.pieces.slice(1) })).toBeNull();
    // below the lower bound
    const tiny = { s: k.bound! * 0.99, pieces: r.pieces };
    expect(k.validate(tiny).reasons[0]).toMatch(/lower bound/);
    // the server's reasons, word for word (packages/spaces/src/validate.ts parseSurface)
    const reasons = (c: unknown) => k.validate(c).reasons;
    expect(reasons([])).toEqual(["config must be an object"]);
    expect(reasons({ pieces: r.pieces })).toEqual(["s must be a finite number"]);
    expect(reasons({ s: "1", pieces: r.pieces })).toEqual(["s must be a finite number"]);
    expect(reasons({ s: 0, pieces: r.pieces })).toEqual(["s must be positive"]);
    expect(reasons({ s: 2e6, pieces: r.pieces })).toEqual(["s must be at most 1000000 in absolute value"]);
    expect(reasons({ s: r.s })).toEqual(["pieces must be an array"]);
    expect(reasons({ s: r.s, pieces: r.pieces.slice(1) })).toEqual(["expected 7 pieces for this problem, got 6"]);
    const bad = r.pieces.map((p, i) => (i === 0 ? { face: 9, x: null, y: p.y } : i === 1 ? 3 : p));
    expect(reasons({ s: r.s, pieces: bad })).toEqual([
      "pieces[0].face must be an integer from 0 to 5",
      "pieces[0].x must be a finite number",
      "pieces[0].theta must be a finite number",
      "pieces[1] must be an object {face, x, y, theta}",
    ]);
    // P above the catalogue's
    expect(surfaceKernel({ solid: "cube", N: 3, P: 81 }).validate({ s: 9, pieces: [] }).reasons).toEqual([
      "P = 81 is above the largest P of the surface catalogue (80)",
    ]);
  });

  it("states its piece's inradius and costs, and ends a finish's polish on the stop", () => {
    const k = surfaceKernel({ solid: "cube", N: 4, P: 7 });
    expect(k.inradius).toBeCloseTo(0.5, 15);
    expect(surfaceKernel({ solid: "cube", N: 0, P: 7 }).inradius).toBe(1);
    expect(k.validateCost).toBeLessThan(k.finishCost);
    // a valid start shrunk by 1e-4: the polish grows it back, a stopped finish only tightens it
    const r = record("surface/cube/fold/4/7");
    const s = k.fromConfig({ s: r.s, pieces: r.pieces })!;
    k.setSize(s, r.s * 1.001);
    const full = k.finish(s)!;
    let polls = 0;
    const stopped = k.finish(s, () => ++polls > 0)!;
    expect(polls).toBeGreaterThan(0);
    for (const f of [full, stopped]) expect(k.validate(f.config).valid).toBe(true);
    expect(stopped.score).toBeCloseTo(r.s * 1.001, 9);
    expect(full.score).toBeLessThan(stopped.score);
  });

  it("finds nothing to finish when no shrink clears an overlap", () => {
    // two disks with one centre: no scale separates them
    const k = surfaceKernel({ solid: "cube", N: 0, P: 2 });
    const s = k.fromConfig({
      s: 3,
      pieces: [
        { face: 0, x: 0.2, y: 0.1, theta: 0 },
        { face: 0, x: 0.2, y: 0.1, theta: 0 },
      ],
    }) as KernelState;
    expect(k.finish(s)).toBeNull();
  });
});
