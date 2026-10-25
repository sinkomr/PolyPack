/**
 * The float validator (src/validate.ts) against the certified records, against the near-contact cases the
 * certifier's tests use (python/polyhedra/fixtures/crosscheck.json), on malformed input, and its worst-case time.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type Pose,
  POLYHEDRA_PROBLEMS,
  configErrors,
  getProblem,
  getSolid,
  place,
  separation,
  validatePolyhedra,
} from "../src";

const recUrl = new URL("../../../data/polyhedra/records.json", import.meta.url);
const doc = existsSync(recUrl) ? JSON.parse(readFileSync(recUrl, "utf8")) : null;
const cross = JSON.parse(readFileSync(new URL("../../../python/polyhedra/fixtures/crosscheck.json", import.meta.url), "utf8"));

describe("validatePolyhedra", () => {
  it("gives the verdicts stored in the cross-check fixture (regenerate it with scripts/gen-crosscheck.ts after a change)", () => {
    for (const c of cross.cases) {
      const p = getProblem(c.code)!;
      const v0 = validatePolyhedra(p, { s: c.s, pieces: c.pieces }, { tol: 0, stopAt: Infinity });
      const v1 = validatePolyhedra(p, { s: c.s, pieces: c.pieces }, { tol: 1e-9 });
      expect(v0.valid, c.id).toBe(c.ts_valid_strict);
      expect(v1.valid, c.id).toBe(c.ts_valid_tol);
      if (c.kind === "pair") expect(Math.abs(v0.minPairSep - c.target), c.id).toBeLessThan(1e-14);
    }
  });

  it("accepts touching and overlaps up to the tolerance, and rejects 2e-9", () => {
    const p = getProblem("cubincub")!;
    const touching = { s: 2, pieces: [[-0.5, 0, 0, 1, 0, 0, 0], [0.5, 0, 0, 1, 0, 0, 0]] as Pose[] };
    expect(validatePolyhedra(p, touching).valid).toBe(true);
    const over = { s: 2, pieces: [[-0.5, 0, 0, 1, 0, 0, 0], [0.5 - 2e-9, 0, 0, 1, 0, 0, 0]] as Pose[] };
    expect(validatePolyhedra(p, over).valid).toBe(false);
    const half = { s: 2, pieces: [[-0.5, 0, 0, 1, 0, 0, 0], [0.5 - 5e-10, 0, 0, 1, 0, 0, 0]] as Pose[] };
    expect(validatePolyhedra(p, half).valid).toBe(true);
    expect(validatePolyhedra(p, half, { tol: 1e-11 }).valid).toBe(false);
    // the walls
    // the cube's faces are at s / 2: s = 2 - 4e-9 makes the pieces stick out by 2e-9, s = 2 - 1e-9 by 5e-10
    expect(validatePolyhedra(p, { s: 2 - 4e-9, pieces: touching.pieces }).valid).toBe(false);
    expect(validatePolyhedra(p, { s: 2 - 1e-9, pieces: touching.pieces }).valid).toBe(true);
  });

  it("finds edge-edge overlaps that no face normal shows", () => {
    // two cubes turned 45 degrees about perpendicular axes: their edges cross; at the touching distance
    // along x the separating axis is an edge-edge cross product
    const p = getProblem("cubincub")!;
    const h = Math.SQRT1_2;
    const qa: [number, number, number, number] = [Math.cos(Math.PI / 8), 0, 0, Math.sin(Math.PI / 8)];
    const qb: [number, number, number, number] = [Math.cos(Math.PI / 8), 0, Math.sin(Math.PI / 8), 0];
    const P = getSolid("cube");
    const sepAt = (t: number) => separation(place(P, [0, 0, 0, ...qa]), place(P, [t, 0.2, 0.1, ...qb])).sep;
    let lo = 0;
    let hi = 3;
    for (let i = 0; i < 200; i++) {
      const m = (lo + hi) / 2;
      if (sepAt(m) < 0) lo = m;
      else hi = m;
    }
    const at = (t: number) => ({ s: 6, pieces: [[0, 0, 0, ...qa], [t, 0.2, 0.1, ...qb]] as Pose[] });
    expect(validatePolyhedra(p, at(hi + 1e-8), { tol: 0 }).valid).toBe(true);
    expect(validatePolyhedra(p, at(hi - 1e-7), { tol: 1e-9 }).valid).toBe(false);
    expect(h).toBeGreaterThan(0);
  });

  it("rejects coincident pieces, protrusions and malformed input without throwing", () => {
    const p = getProblem("tetintet")!;
    expect(validatePolyhedra(p, { s: 3, pieces: [[0, 0, 0, 1, 0, 0, 0], [0, 0, 0, 0, 1, 0, 0]] }).valid).toBe(false);
    expect(validatePolyhedra(p, { s: 0.99, pieces: [[0, 0, 0, 1, 0, 0, 0]] }).valid).toBe(false);
    expect(validatePolyhedra(p, { s: 1, pieces: [[0, 0, 0, 1, 0, 0, 0]] }).valid).toBe(true);
    const bad: unknown[] = [
      null,
      { s: 1 },
      { s: -1, pieces: [] },
      { s: 1, pieces: [[0, 0, 0, 0, 0, 0, 0]] },
      { s: 1, pieces: [[0, 0, 0, 1e-7, 0, 0, 0]] },
      { s: 1, pieces: [[0, 0, NaN, 1, 0, 0, 0]] },
      { s: 1, pieces: [[0, 0, 0, 1, 0, 0]] },
      { s: 1, pieces: [[0, 0, "0", 1, 0, 0, 0]] },
      { s: 1, pieces: [[1e5, 0, 0, 1, 0, 0, 0]] },
      { s: 1, pieces: [[0, 0, 0, 1e101, 0, 0, 0]] },
      { s: Infinity, pieces: [[0, 0, 0, 1, 0, 0, 0]] },
    ];
    for (const c of bad) {
      expect(configErrors(c).length, JSON.stringify(c)).toBeGreaterThan(0);
      expect(validatePolyhedra(p, c as never).valid).toBe(false);
    }
    expect(configErrors({ s: 1, pieces: [[0, 0, 0, 1, 0, 0, 0]] }, 2)).toEqual(["expected 2 pieces for this problem, got 1"]);
  });

  it("checks PolyPack's prisms and antiprisms: stacked pieces fit, overlaps and protrusions are rejected", () => {
    for (const n of [7, 9, 10]) {
      // two prisms stacked in their own prism of scale 2 (height 2, base side 2): they touch each other and both caps
      const pr = getProblem(`pr${n}inpr${n}`)!;
      const stack = (dz: number): Pose[] => [[0, 0, -0.5, 1, 0, 0, 0], [0, 0, 0.5 + dz, 1, 0, 0, 0]];
      expect(validatePolyhedra(pr, { s: 2, pieces: stack(0) }, { tol: 0 }).valid).toBe(true);
      expect(validatePolyhedra(pr, { s: 2, pieces: stack(-1e-7) }).valid).toBe(false);
      expect(validatePolyhedra(pr, { s: 2 - 1e-7, pieces: stack(0) }).valid).toBe(false);
      // two antiprisms stacked in a cube: each reaches R = 1 / (2 sin(pi/n)) from its axis along x (one vertex of a
      // base on each side), less along y and H/2 along z
      const ap = getProblem(`ap${n}incub`)!;
      const S = getSolid(`antiprism${n}`);
      const R = 1 / (2 * Math.sin(Math.PI / n));
      const H = 2 * Math.max(...Array.from({ length: S.nv }, (_, i) => S.V[3 * i + 2]));
      const two = (dz: number): Pose[] => [[0, 0, -H / 2, 1, 0, 0, 0], [0, 0, H / 2 + dz, 1, 0, 0, 0]];
      const v = validatePolyhedra(ap, { s: 2 * R + 2e-12, pieces: two(1e-9) }, { tol: 0 });
      expect(v.valid, `ap${n}incub`).toBe(true);
      expect(v.minPairSep).toBeCloseTo(1e-9, 12);
      expect(validatePolyhedra(ap, { s: 2 * R + 2e-12, pieces: two(-1e-7) }).valid).toBe(false);
      expect(validatePolyhedra(ap, { s: 2 * R - 1e-7, pieces: two(1e-9) }).valid).toBe(false);
      // turned by pi/n about the axis, an antiprism shows the cube its other base: still width 2R along x
      const qz = [Math.cos(Math.PI / (2 * n)), 0, 0, Math.sin(Math.PI / (2 * n))] as const;
      const turned: Pose[] = [[0, 0, -H / 2, ...qz], [0, 0, H / 2 + 1e-9, 1, 0, 0, 0]];
      expect(validatePolyhedra(ap, { s: 2 * R + 2e-12, pieces: turned }, { tol: 0 }).valid).toBe(true);
      expect(validatePolyhedra(ap, { s: 2 * R - 1e-7, pieces: turned }).valid).toBe(false);
    }
  });
});

describe.skipIf(!doc)("data/polyhedra/records.json", () => {
  const records = doc?.records ?? [];

  it("every record is valid by the float validator at tolerance 0 at its certified scale", () => {
    let minGap = Infinity;
    for (const r of records) {
      const p = getProblem(r.code)!;
      expect(r.config.pieces.length).toBe(r.P);
      const v = validatePolyhedra(p, r.config, { tol: 0 });
      expect(v.valid, r.id).toBe(true);
      minGap = Math.min(minGap, v.minWallGap, v.minPairSep);
    }
    // the certified clearances: 1e-7 by the wiki's convention, about 1e-10 after wall-padding refinements and
    // 5e-12 in some community constructions (all proven positive by the certifier)
    expect(minGap).toBeGreaterThan(1e-12);
  });

  it("rejects every record's container shrunk by 1e-6 relative, at PolyPack's tolerance", () => {
    for (const r of records.filter((_: unknown, i: number) => i % 7 === 0)) {
      const v = validatePolyhedra(getProblem(r.code)!, { s: r.config.s * (1 - 1e-6), pieces: r.config.pieces });
      expect(v.valid, r.id).toBe(false);
    }
  });

  it("covers every problem of the wiki for P = 2 to 30 with consistent ids", () => {
    // PolyPack's 21 problems (wiki: false) are not in this file yet
    const ids = new Set(records.map((r: { id: string }) => r.id));
    for (const p of POLYHEDRA_PROBLEMS.filter((x) => x.wiki))
      for (let n = 2; n <= 30; n++) expect(ids.has(`polyhedra/${p.code}/${n}`)).toBe(true);
    for (const r of records) expect(r.id).toBe(`polyhedra/${r.code}/${r.P}`);
  });
});

describe("work bounds", () => {
  it("validates 30 pieces of the largest solid, all in near contact, in bounded time", () => {
    // worst case for the pair test: the 120-vertex truncated icosidodecahedron, pieces on a tight grid so that
    // many pairs are near, each separated only along a cross product or a far face
    const p = getProblem("tidintid")!;
    const P = getSolid("truncated_icosidodecahedron");
    // half-widths along the axes: neighbours on the grid touch to within 1e-9
    const h = [0, 1, 2].map((k) => Math.max(...Array.from({ length: P.nv }, (_, v) => P.V[3 * v + k])));
    const pieces: Pose[] = [];
    for (let i = 0; i < 30; i++)
      pieces.push([(i % 4) * (2 * h[0] + 1e-9), (Math.floor(i / 4) % 4) * (2 * h[1] + 1e-9), Math.floor(i / 16) * (2 * h[2] + 1e-9), 1, 0, 0, 0]);
    const t0 = performance.now();
    const v = validatePolyhedra(p, { s: 1e3, pieces }, { stopAt: Infinity });
    const ms = performance.now() - t0;
    expect(v.valid).toBe(true);
    expect(v.pairsTested).toBeGreaterThan(40);
    expect(ms).toBeLessThan(5000);
  });
});
