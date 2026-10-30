/**
 * The generic polyhedra code on the 92 Johnson solids, which are neither centrally symmetric nor vertex-transitive and
 * mostly have no insphere: test packings (python/polyhedra/fixtures/johnson_packings.json, made by
 * scripts/gen-johnson-packings.ts, which python/polyhedra/test_johnson_packings.py certifies exactly) against the float
 * validator, adversarial variants, a quaternion of any norm, the completeness of the separating-axis candidates on solids
 * without symmetry, the box-lattice start of every Johnson solid, the polish and the kernel contract.
 */
import { readFileSync } from "node:fs";
import { checkKernel } from "@polypack/methods/contract";
import { describe, expect, it } from "vitest";
import {
  JOHNSON_SOLID_NAMES,
  type Pose,
  configErrors,
  getProblem,
  getSolid,
  latticeStart,
  legalizeConfig,
  place,
  polishConfig,
  polyhedraKernel,
  separation,
  validatePolyhedra,
} from "../src";
import { pairCode } from "../src/catalogue";
import { mulberry32, gauss } from "../src/sim/sim";

interface Case {
  piece: string;
  container: string;
  code: string;
  P: number;
  s: number;
  pieces: number[][];
  minWallGap: number;
  minPairSep: number | null;
  overlap: { pieces: number[][]; pair: [number, number]; depth: number } | null;
  protrusion: { pieces: number[][]; piece: number; depth: number };
}
const fixture = JSON.parse(readFileSync(new URL("../../../python/polyhedra/fixtures/johnson_packings.json", import.meta.url), "utf8")) as {
  cases: Case[];
};
const problemOf = (code: string) => getProblem(code)!;

describe("test packings of Johnson solids", () => {
  it("are 44, valid at tolerance 0, with the gaps the fixture records", () => {
    expect(fixture.cases).toHaveLength(44);
    for (const c of fixture.cases) {
      const v = validatePolyhedra(problemOf(c.code), { s: c.s, pieces: c.pieces as Pose[] }, { tol: 0 });
      expect(v.valid, c.code).toBe(true);
      expect(v.minWallGap, c.code).toBe(c.minWallGap);
      expect(v.minWallGap, c.code).toBeGreaterThan(0);
    }
  });

  it("have a piece in a cube, in itself, in another Johnson solid and in an Archimedean solid", () => {
    for (const piece of new Set(fixture.cases.map((c) => c.piece))) {
      const mine = fixture.cases.filter((c) => c.piece === piece);
      expect(mine.map((c) => c.container).filter((x) => x === "cube" || x === piece)).toHaveLength(2);
      expect(mine).toHaveLength(4);
      expect(mine.filter((c) => JOHNSON_SOLID_NAMES.includes(c.container) && c.container !== piece)).toHaveLength(1);
    }
  });

  it("refuse a piece that overlaps its neighbour by 1e-9, at tolerance 0 and just inside it", () => {
    let n = 0;
    for (const c of fixture.cases) {
      if (!c.overlap) continue;
      n++;
      expect(c.overlap.depth, c.code).toBeGreaterThanOrEqual(1e-9);
      expect(c.overlap.depth, c.code).toBeLessThan(1.0001e-9);
      const bad = validatePolyhedra(problemOf(c.code), { s: c.s, pieces: c.overlap.pieces as Pose[] }, { tol: 0, stopAt: Infinity });
      expect(bad.valid, c.code).toBe(false);
      expect(bad.errors.join(), c.code).toMatch(/overlap/);
      // at the touching tolerance of 1e-9 the same overlap is a hair outside it, and the server's strict one of 1e-11 refuses it too
      expect(validatePolyhedra(problemOf(c.code), { s: c.s, pieces: c.overlap.pieces as Pose[] }, { tol: 1e-11 }).valid, c.code).toBe(false);
    }
    expect(n).toBe(42);
  });

  it("refuse a piece that sticks out of the container by 1e-9", () => {
    for (const c of fixture.cases) {
      expect(c.protrusion.depth, c.code).toBeGreaterThanOrEqual(1e-9);
      expect(c.protrusion.depth, c.code).toBeLessThan(1.0001e-9);
      const bad = validatePolyhedra(problemOf(c.code), { s: c.s, pieces: c.protrusion.pieces as Pose[] }, { tol: 0 });
      expect(bad.valid, c.code).toBe(false);
      expect(bad.errors.join(), c.code).toMatch(new RegExp(`piece ${c.protrusion.piece} sticks out`));
      expect(validatePolyhedra(problemOf(c.code), { s: c.s, pieces: c.protrusion.pieces as Pose[] }, { tol: 1e-11 }).valid, c.code).toBe(false);
    }
  });

  it("read a quaternion of any norm as its rotation, and refuse a zero or a non-finite one as before", () => {
    for (const c of fixture.cases) {
      const k = [7.3, 1e-5, 5e48][c.P % 3];
      const scaled = c.pieces.map((p) => [p[0], p[1], p[2], p[3] * k, p[4] * k, p[5] * k, p[6] * k]) as Pose[];
      const a = validatePolyhedra(problemOf(c.code), { s: c.s, pieces: c.pieces as Pose[] }, { tol: 0 });
      const b = validatePolyhedra(problemOf(c.code), { s: c.s, pieces: scaled }, { tol: 0 });
      expect(b.valid, c.code).toBe(true);
      expect(Math.abs(b.minWallGap - a.minWallGap), c.code).toBeLessThan(1e-12);
    }
    const c = fixture.cases[0];
    for (const q of [[0, 0, 0, 0], [1e-7, 0, 0, 0], [Number.NaN, 0, 0, 1]])
      expect(configErrors({ s: c.s, pieces: [[0, 0, 0, ...q]] }).length, String(q)).toBeGreaterThan(0);
  });
});

describe("the separating-axis test on solids without a centre of symmetry", () => {
  it("has candidate axes that dominate every direction: no sampled direction separates more", () => {
    const rng = mulberry32(5);
    const randQ = (): Pose[number][] => {
      const q = [gauss(rng), gauss(rng), gauss(rng), gauss(rng)];
      const m = Math.hypot(...q);
      return q.map((x) => x / m);
    };
    let overlapping = 0;
    let disjoint = 0;
    for (const name of ["square_pyramid", "pentagonal_rotunda", "triangular_bipyramid", "gyroelongated_square_pyramid", "snub_disphenoid", "sphenomegacorona", "triangular_hebesphenorotunda", "elongated_pentagonal_gyrocupolarotunda"]) {
      const S = getSolid(name);
      for (let t = 0; t < 12; t++) {
        const a = place(S, [0, 0, 0, ...randQ()]);
        // B at a random place within about one circumradius, so that half the pairs overlap and half do not
        const d = [gauss(rng), gauss(rng), gauss(rng)];
        const l = Math.hypot(...d);
        const r = S.circumradius * (0.3 + 1.7 * rng());
        const b = place(S, [(r * d[0]) / l, (r * d[1]) / l, (r * d[2]) / l, ...randQ()]);
        const sep = separation(a, b).sep;
        let best = -Infinity;
        for (let i = 0; i < 4000; i++) {
          const u = [gauss(rng), gauss(rng), gauss(rng)];
          const m = Math.hypot(...u);
          let lo = Infinity, hi = -Infinity, lo2 = Infinity, hi2 = -Infinity;
          for (let k = 0; k < a.X.length; k += 3) {
            const p = (a.X[k] * u[0] + a.X[k + 1] * u[1] + a.X[k + 2] * u[2]) / m;
            lo = Math.min(lo, p);
            hi = Math.max(hi, p);
          }
          for (let k = 0; k < b.X.length; k += 3) {
            const p = (b.X[k] * u[0] + b.X[k + 1] * u[1] + b.X[k + 2] * u[2]) / m;
            lo2 = Math.min(lo2, p);
            hi2 = Math.max(hi2, p);
          }
          best = Math.max(best, lo2 - hi, lo - hi2);
        }
        // overlapping pieces: the candidates give the exact penetration depth, so no direction does better; disjoint
        // pieces: they give a positive lower bound on the distance, and they find a separation whenever any direction does
        if (sep <= 0) expect(best, `${name} ${t}`).toBeLessThanOrEqual(sep + 1e-12);
        else expect(best, `${name} ${t}`).toBeGreaterThan(0);
        if (best > 0) expect(sep, `${name} ${t}`).toBeGreaterThan(0);
        overlapping += sep <= 0 ? 1 : 0;
        disjoint += sep > 0 ? 1 : 0;
      }
    }
    expect(overlapping).toBeGreaterThan(10);
    expect(disjoint).toBeGreaterThan(10);
  });
});

describe("the box-lattice start of every Johnson solid", () => {
  it("is valid at tolerance 0 in a cube, in itself and in a Johnson solid of the same sort of shape", () => {
    for (const name of JOHNSON_SOLID_NAMES) {
      for (const container of ["cube", name, "pentagonal_rotunda"]) {
        const problem = problemOf(pairCode(name, container)!);
        const cfg = latticeStart(problem, 3);
        expect(validatePolyhedra(problem, cfg, { tol: 0 }).valid, `${name} in ${container}`).toBe(true);
      }
    }
  });
});

describe("the polish and the kernel on Johnson solids", () => {
  it("legalize a squeezed start into a valid one, and polish it into a valid one", () => {
    for (const [piece, container, P] of [["square_pyramid", "cube", 4], ["triangular_cupola", "triangular_cupola", 3], ["snub_disphenoid", "gyrobifastigium", 3]] as const) {
      const problem = problemOf(pairCode(piece, container)!);
      const start = latticeStart(problem, P);
      // pull the centres together so that pieces overlap, then legalize
      const squeezed = { s: start.s, pieces: start.pieces.map((p): Pose => [p[0] * 0.8, p[1] * 0.8, p[2] * 0.8, p[3], p[4], p[5], p[6]]) };
      const legal = legalizeConfig(problem, squeezed);
      expect(validatePolyhedra(problem, legal, { tol: 0 }).valid, `${piece} in ${container}`).toBe(true);
      const polished = polishConfig(problem, legal, { mus: [1e1, 1e3, 1e5], iterations: 60 });
      expect(validatePolyhedra(problem, polished.config, { tol: 0 }).valid, `${piece} in ${container}`).toBe(true);
    }
  });

  for (const [piece, container, P] of [["square_pyramid", "pentagonal_rotunda", 3], ["triangular_hebesphenorotunda", "cube", 3], ["snub_disphenoid", "snub_disphenoid", 4], ["cube", "gyroelongated_pentagonal_birotunda", 4]] as const)
    it(`passes the kernel contract: ${piece} in ${container}, P = ${P}`, () => {
      const code = pairCode(piece, container)!;
      expect(checkKernel(() => polyhedraKernel({ code, P }), { seed: P })).toEqual([]);
    });
});
