/**
 * The surface kernel (src/kernel.ts) beyond the Platonic solids: the Catalan solids, prisms,
 * antiprisms and Johnson solids, folding and without folding. The Platonic tests (kernel.test.ts) are unchanged; here:
 * the kernel contract on a spread of solids, N and P in both modes, the certified test packings of
 * python/surface/fixtures/general_packings.json (there are no records of these solids) through
 * fromConfig, validate and finish, the bound of every problem, and the parts that read the faces one
 * by one (charts, random poses by area, seeds, the walls of the nofold mode).
 */
import { readFileSync } from "node:fs";
import { mulberry32, squeeze } from "@polypack/methods";
import { checkKernel } from "@polypack/methods/contract";
import { describe, expect, it } from "vitest";
import { ALL_SOLID_NAMES, type SolidName, getSolid, surfaceKernel, validate } from "../src/index";
import { chartPoint, faceShapes, randomSurfacePoint, unfoldChart } from "../src/kernel-solid";
import { independentBounds, loadSurfaceRecords } from "./helpers";

type Mode = "fold" | "nofold";
interface Packing {
  id: string;
  solid: SolidName;
  mode: Mode;
  N: number;
  P: number;
  s: number;
  pieces: { face: number; x: number; y: number; theta: number }[];
}
const packings: Packing[] = JSON.parse(
  readFileSync(new URL("../../../python/surface/fixtures/general_packings.json", import.meta.url), "utf8"),
).records;

describe("the surface kernel on the Catalan solids, prisms and antiprisms", () => {
  // every family, both modes, disks, triangles, squares, hexagons and 12-gons, P = 1, 5 and 30
  const problems: [SolidName, Mode, number, number][] = [
    ["truncated_tetrahedron", "fold", 0, 2],
    ["truncated_tetrahedron", "nofold", 3, 3],
    ["cuboctahedron", "fold", 3, 2],
    ["cuboctahedron", "nofold", 0, 3],
    ["snub_cube", "fold", 12, 2],
    ["snub_cube", "nofold", 3, 3],
    ["truncated_icosidodecahedron", "fold", 3, 2],
    ["truncated_icosidodecahedron", "nofold", 12, 4],
    ["rhombic_dodecahedron", "fold", 4, 5],
    ["rhombic_dodecahedron", "nofold", 0, 30],
    ["triakis_tetrahedron", "fold", 3, 1],
    ["triakis_tetrahedron", "nofold", 6, 5],
    ["deltoidal_icositetrahedron", "fold", 0, 30],
    ["deltoidal_icositetrahedron", "nofold", 12, 5],
    ["pentagonal_icositetrahedron", "fold", 6, 5],
    ["rhombic_triacontahedron", "fold", 12, 1],
    ["rhombic_triacontahedron", "nofold", 3, 30],
    ["disdyakis_dodecahedron", "fold", 3, 30],
    ["prism3", "fold", 0, 1],
    ["prism3", "nofold", 4, 30],
    ["prism5", "fold", 6, 30],
    ["prism12", "fold", 12, 5],
    ["prism12", "nofold", 0, 5],
    ["antiprism4", "fold", 3, 5],
    ["antiprism4", "nofold", 6, 1],
    ["antiprism7", "fold", 4, 30],
    ["antiprism12", "fold", 0, 5],
    ["antiprism12", "nofold", 12, 30],
    // Johnson solids without a vertex of three triangles (a cone angle of exactly pi; see SURFACE.md, kernel)
    ["triangular_cupola", "fold", 0, 2],
    ["triangular_cupola", "nofold", 3, 3],
    ["pentagonal_rotunda", "fold", 4, 5],
    ["square_gyrobicupola", "nofold", 6, 5],
    ["snub_disphenoid", "fold", 3, 5],
    ["disphenocingulum", "fold", 0, 3],
    ["triangular_hebesphenorotunda", "nofold", 0, 5],
  ];
  for (const [solid, mode, N, P] of problems)
    it(`passes the kernel contract: ${solid} ${mode}, N = ${N}, P = ${P}`, () => {
      expect(checkKernel(() => surfaceKernel({ solid, N, P, mode }), { seed: 3 * P + N })).toEqual([]);
    });

  it("names its problem and keeps the Platonic default", () => {
    expect(surfaceKernel({ solid: "prism5", N: 3, P: 4 }).id).toBe("surface/prism5/fold/3/4");
    expect(surfaceKernel({ solid: "prism5", N: 3, P: 4, mode: "nofold" }).id).toBe("surface/prism5/nofold/3/4");
    expect(() => surfaceKernel({ solid: "prism5", N: 3, P: 4, mode: "flat" as Mode })).toThrow(/mode/);
  });

  it("states the records' bounds to the last bit, and on the other solids bounds checked independently", () => {
    // every Platonic record, fold and nofold (python/surface/tables.py computed their bounds)
    const records: { id: string; solid: SolidName; mode: Mode; N: number; P: number; bound: { value: number } }[] =
      loadSurfaceRecords();
    for (const r of records)
      expect(surfaceKernel({ solid: r.solid, N: r.N, P: r.P, mode: r.mode }).bound, r.id).toBe(r.bound.value);
    // the other solids, against the area from 3D cross products and a sampled corner radius
    for (const solid of ALL_SOLID_NAMES.filter((n) => !getSolid(n).uniform))
      for (const N of [0, 3, 6, 12, 100])
        for (const P of [1, 7, 30, 100]) {
          const k = surfaceKernel({ solid, N, P, mode: P % 2 ? "fold" : "nofold" });
          const ind = independentBounds(getSolid(solid), N, P);
          const id = `${solid} ${N} ${P}`;
          if (ind.area >= ind.oneAtMost) expect(Math.abs(k.bound! / ind.area - 1), id).toBeLessThan(1e-12);
          else {
            expect(k.bound!, id).toBeLessThanOrEqual(ind.oneAtMost * (1 + 1e-12));
            expect(k.bound!, id).toBeGreaterThan(Math.max(ind.area, ind.oneAtMost * 0.99));
          }
        }
  });

  it("has a nofold energy that is zero exactly when the nofold validator accepts", () => {
    // three pieces dropped on one face, often overlapping each other or its edges
    let positive = 0;
    let zero = 0;
    for (const [solid, N] of [
      ["rhombic_dodecahedron", 3],
      ["rhombic_dodecahedron", 0],
      ["prism5", 4],
      ["antiprism4", 6],
      ["triakis_tetrahedron", 12],
      ["deltoidal_icositetrahedron", 5],
    ] as [SolidName, number][]) {
      const S = getSolid(solid);
      const k = surfaceKernel({ solid, N, P: 3, mode: "nofold" });
      const F = faceShapes(S)[0];
      // a scale at which the face's inner disk is about four pieces across
      const s = (4 * (N === 0 ? 1 : 1 / (2 * Math.sin(Math.PI / N)))) / F.inner;
      const r = mulberry32(N + 1);
      for (let t = 0; t < 400; t++) {
        const pieces = [0, 1, 2].map(() => {
          for (;;) {
            const x = (2 * r() - 1) * s;
            const y = (2 * r() - 1) * s;
            if (faceShapes(S)[0].b.every((b, j) => F.nx[j] * x + F.ny[j] * y <= b * s))
              return { face: 0, x, y, theta: 7 * r() };
          }
        });
        const state = k.fromConfig({ s, pieces })!;
        const v = validate({ solid, N, s, pieces }, "nofold", { tol: 0 });
        const worst = Math.min(v.minPairSep, v.minWallSep);
        if (Math.abs(worst) < 1e-9) continue;
        const e = k.energy(state);
        if (worst < 0) {
          expect(e, `${solid} ${N}: ${v.errors[0]}`).toBeGreaterThan(0);
          positive++;
        } else {
          expect(e, `${solid} ${N}`).toBe(0);
          zero++;
        }
        // clear() says the same per piece
        for (let i = 0; i < 3; i++) expect(k.clear(state, i, 0) || k.pieceEnergy(state, i) > 0).toBe(true);
      }
    }
    expect(positive).toBeGreaterThan(300);
    expect(zero).toBeGreaterThan(100);
  });

  it("converts, validates and finishes the certified test packings at or below their size", () => {
    let n = 0;
    for (const r of packings) {
      if (getSolid(r.solid).uniform) continue;
      const k = surfaceKernel({ solid: r.solid, N: r.N, P: r.P, mode: r.mode });
      const config = { s: r.s, pieces: r.pieces };
      expect(k.validate(config), r.id).toEqual({ valid: true, score: r.s, reasons: [] });
      const s = k.fromConfig(config)!;
      expect(s, r.id).not.toBeNull();
      expect(k.energy(s), r.id).toBeLessThan(1e-18);
      const f = k.finish(s)!;
      expect(f, r.id).not.toBeNull();
      expect(f.score, r.id).toBeLessThanOrEqual(r.s * (1 + 1e-9));
      const c = f.config as typeof config;
      expect(validate({ solid: r.solid, N: r.N, s: c.s, pieces: c.pieces }, r.mode, { tol: 0 }).ok, r.id).toBe(true);
      n++;
    }
    expect(n).toBeGreaterThan(40);
  });

  it("checks a problem without a research record at 1e-11 too, as the server does", () => {
    // a certified test packing on edges shrunk until its pieces overlap by between 1e-11 and 1e-9
    const shrunk = (r: { s: number; pieces: Packing["pieces"] }, d: number) => ({
      s: r.s * (1 - d),
      pieces: r.pieces.map((p) => ({ ...p, x: p.x * (1 - d), y: p.y * (1 - d) })),
    });
    const between = (solid: SolidName, N: number, mode: Mode, r: { s: number; pieces: Packing["pieces"] }) => {
      for (const d of [1e-10, 2e-10, 4e-10, 8e-10]) {
        const c = shrunk(r, d);
        const loose = validate({ solid, N, ...c }, mode, { tol: 1e-9 }).ok;
        const strict = validate({ solid, N, ...c }, mode, { tol: 1e-11 }).ok;
        if (loose && !strict) return c;
      }
      throw new Error(`no shrink gives an overlap between 1e-11 and 1e-9 on ${solid}`);
    };
    for (const id of ["surface/rhombic_dodecahedron/fold/3/3", "surface/prism5/nofold/6/9"]) {
      const r = packings.find((q) => q.id === id)!;
      const k = surfaceKernel({ solid: r.solid, N: r.N, P: r.P, mode: r.mode });
      const v = k.validate(between(r.solid, r.N, r.mode, r));
      expect(v.valid, id).toBe(false);
      expect(v.reasons[0]).toBe(
        "valid only within the float tolerance; this problem has no research record yet, and its entries must be valid at tolerance 1e-11",
      );
    }
    // a Platonic problem with a record: the touching tolerance, as the server's (no strict check below the record's margin)
    const rec = loadSurfaceRecords().find((q: { id: string }) => q.id === "surface/cube/fold/4/7");
    expect(surfaceKernel({ solid: "cube", N: 4, P: 7 }).validate(between("cube", 4, "fold", rec)).valid).toBe(true);
  });

  it("treats a pose that is not a number as a violation, with and without folding", () => {
    for (const mode of ["fold", "nofold"] as Mode[])
      for (const N of [0, 4]) {
        const k = surfaceKernel({ solid: "rhombic_dodecahedron", N, P: 3, mode });
        const s = k.randomStart(mulberry32(1));
        s.x[0] = Number.NaN;
        const g = new Float64Array(3 * k.dim + 1);
        expect(k.energy(s, g)).toBe(Infinity);
        expect(k.pieceEnergy(s, 0)).toBe(Infinity);
        expect(k.clear(s, 0, 0)).toBe(false);
        expect(k.clear(s, 1, 0)).toBe(false);
      }
  });

  it("counts two disk centres at one point as a full overlap", () => {
    for (const mode of ["fold", "nofold"] as Mode[]) {
      const k = surfaceKernel({ solid: "prism5", N: 0, P: 2, mode });
      const p = { face: 2, x: 0.1, y: 0.05, theta: 0 };
      const s = k.fromConfig({ s: 6, pieces: [p, { ...p }] })!;
      const g = new Float64Array(5);
      // two disks of diameter 1 on top of each other: penetration depth 1 (a full overlap), squared
      expect(k.energy(s, g), mode).toBeGreaterThan(0.97);
      expect(g.every(Number.isFinite)).toBe(true);
      expect(k.pieceEnergy(s, 0)).toBeGreaterThan(0);
      expect(k.clear(s, 0, 1e-9)).toBe(false);
    }
  });

  it("squeezes random starts into valid packings, with and without folding", () => {
    for (const [solid, mode, N, P] of [
      ["rhombic_dodecahedron", "fold", 4, 6],
      ["prism6", "nofold", 0, 9],
      ["antiprism5", "fold", 3, 7],
      ["deltoidal_icositetrahedron", "nofold", 6, 12],
    ] as [SolidName, Mode, number, number][]) {
      const k = surfaceKernel({ solid, N, P, mode });
      const s = k.randomStart(mulberry32(4));
      squeeze(k, s, { mus: [10, 1e3, 1e5], maxIter: 100 });
      const f = k.finish(s)!;
      expect(f, `${solid} ${mode}`).not.toBeNull();
      expect(k.validate(f.config).valid).toBe(true);
      expect(f.score).toBeGreaterThanOrEqual(k.bound!);
      // without folding no piece leaves its face
      if (mode === "nofold") {
        const c = f.config as { s: number; pieces: { face: number; x: number; y: number; theta: number }[] };
        expect(validate({ solid, N, s: c.s, pieces: c.pieces }, "nofold", { tol: 0 }).ok).toBe(true);
      }
    }
  });

  it("reads every solid's charts: a chart point of any face unfolds to its surface point", () => {
    for (const name of ALL_SOLID_NAMES) {
      const S = getSolid(name);
      const r = mulberry32(3);
      for (let t = 0; t < 8; t++) {
        const q = randomSurfacePoint(S, r);
        const f = Math.floor(r() * S.F);
        const c = chartPoint(S, f, q.face, q.x, q.y)!;
        const u = unfoldChart(S, { face: f, x: c[0], y: c[1], theta: 0 });
        expect(u.face, name).toBe(q.face);
        expect(Math.hypot(u.x - q.x, u.y - q.y), name).toBeLessThan(1e-9);
      }
    }
  });

  it("places random poses by area, and seeds as many pieces on a face as its area allows", () => {
    // a hexagonal prism: two hexagons of area 2.598 and six squares of area 1 (at scale 1)
    const S = getSolid("prism6");
    const faces = faceShapes(S);
    const total = faces.reduce((a, f) => a + f.area, 0);
    const k = surfaceKernel({ solid: "prism6", N: 0, P: 12 });
    const r = mulberry32(6);
    const s = k.randomStart(r);
    const hits = new Array<number>(S.F).fill(0);
    const draws = 4000;
    for (let t = 0; t < draws; t++) {
      k.randomPose(s, 0, r);
      hits[(k.toConfig(s) as { pieces: { face: number }[] }).pieces[0].face]++;
    }
    faces.forEach((f, i) => expect(Math.abs(hits[i] / draws - f.area / total), `face ${i}`).toBeLessThan(0.02));
    for (const seed of k.seeds!(mulberry32(2), 2)) {
      expect(k.validate(k.toConfig(seed)).valid).toBe(true);
      const counts = new Array<number>(S.F).fill(0);
      for (const f of (seed.aux as { faces: Int32Array }).faces) counts[f]++;
      faces.forEach((f, i) => expect(Math.abs(counts[i] - (12 * f.area) / total), `face ${i}`).toBeLessThan(1));
    }
  });

  it("keeps a piece without folding inside its face, and lets it move to another", () => {
    const k = surfaceKernel({ solid: "rhombic_dodecahedron", N: 4, P: 1, mode: "nofold" });
    const s = k.fromConfig({ s: 4, pieces: [{ face: 0, x: 0, y: 0, theta: 0.2 }] })!;
    expect(k.energy(s)).toBe(0);
    expect(k.clear(s, 0, 0)).toBe(true);
    // pushed towards an edge it sticks out, a protrusion the energy and clear() both see
    const out = k.clone(s);
    const corner = faceShapes(getSolid("rhombic_dodecahedron"))[0].poly;
    out.x[0] = corner[0] * 0.95;
    out.x[1] = corner[1] * 0.95;
    expect(k.energy(out)).toBeGreaterThan(0);
    expect(k.clear(out, 0, 1e-9)).toBe(false);
    // a random pose can land on any face (the anchor changes only in rebase)
    const seen = new Set<number>();
    const r = mulberry32(1);
    for (let t = 0; t < 200; t++) {
      k.randomPose(s, 0, r);
      seen.add((k.toConfig(s) as { pieces: { face: number }[] }).pieces[0].face);
    }
    expect(seen.size).toBe(12);
  });
});
