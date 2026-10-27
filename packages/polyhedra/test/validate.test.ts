/**
 * The float validator (src/validate.ts) against the certified records, against the near-contact cases the
 * certifier's tests use (python/polyhedra/fixtures/crosscheck.json), on malformed input, and its worst-case time.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type Pose,
  POLYHEDRA_MAX_P,
  POLYHEDRA_PROBLEMS,
  configErrors,
  getProblem,
  getSolid,
  place,
  separation,
  validatePolyhedra,
} from "../src";
import { readRecordsFile } from "../src/records-file";

const recUrl = new URL("../../../data/polyhedra/records.json", import.meta.url);
const doc = existsSync(recUrl) ? readRecordsFile(recUrl.pathname) : null;
/** Lets the test runner breathe during a long loop. */
const breathe = () => new Promise((r) => setImmediate(r));
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
    for (const n of [7, 9, 10, 11]) {
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

  it("every record up to P = 30 and every tenth above is valid by the float validator at tolerance 0 at its certified scale", async () => {
    // the one broad float scan of the stored polyhedra records (the spaces tests check a fixed sample of every
    // space): all 14,850 take over a minute (scripts/bench-validate.ts), so every one up to P = 30 and every tenth above
    let minGap = Infinity;
    for (const [i, r] of records.entries()) {
      if (r.P > 30 && i % 10 !== 0) continue;
      if (i % 100 === 0) await breathe();
      const p = getProblem(r.code)!;
      expect(r.config.pieces.length).toBe(r.P);
      const v = validatePolyhedra(p, r.config, { tol: 0 });
      expect(v.valid, r.id).toBe(true);
      minGap = Math.min(minGap, v.minWallGap, v.minPairSep);
    }
    // the certified clearances: 1e-7 by the wiki's convention, about 1e-10 after wall-padding refinements and
    // 5e-12 in some community constructions; the smallest, 1.7e-13 in floats, is 96 pentagonal prisms in a cube
    // (PingYou Ltd). All are proven positive by the certifier.
    expect(minGap).toBeGreaterThan(1e-13);
  });

  it("rejects every record's container shrunk by 1e-6 relative, at PolyPack's tolerance", async () => {
    // every 7th up to P = 30, every 49th above
    for (const [i, r] of records.entries()) {
      if (i % (r.P > 30 ? 49 : 7) !== 0) continue;
      if (i % 98 === 0) await breathe();
      const v = validatePolyhedra(getProblem(r.code)!, { s: r.config.s * (1 - 1e-6), pieces: r.config.pieces });
      expect(v.valid, r.id).toBe(false);
    }
  });

  it("covers every problem for P = 2 to 100 with consistent ids", () => {
    // the wiki's 86 problems and PolyPack's 64
    const ids = new Set(records.map((r: { id: string }) => r.id));
    expect(POLYHEDRA_MAX_P).toBe(500);
    expect(POLYHEDRA_PROBLEMS.length).toBe(150);
    expect(records.length).toBe(150 * 99);
    for (const p of POLYHEDRA_PROBLEMS)
      for (let n = 2; n <= 100; n++) expect(ids.has(`polyhedra/${p.code}/${n}`)).toBe(true);
    for (const r of records) expect(r.id).toBe(`polyhedra/${r.code}/${r.P}`);
  });
});

describe("bipyramids and trapezohedra", () => {
  /**
   * Two pieces face to face: piece 1 is the mirror image of piece 0 in the plane of its face 0, moved off it by g
   * along the face normal N (g < 0: into it). The mirror image is a proper copy because both families have the mirror
   * y -> -y: it is R K + (2b + g) N with R = (I - 2 N N^T)(I - 2 e_y e_y^T). The faces coincide when g = 0, so the
   * gap is exactly g, and a negative g is an overlap of depth -g. The container is the smallest with wall gap w.
   */
  const pair = (code: string, g: number, w: number) => {
    const p = getProblem(code)!;
    const S = getSolid(p.piece);
    const C = getSolid(p.container);
    const N = [S.N[0], S.N[1], S.N[2]];
    const b = S.offsets[0];
    const Rm = [0, 1, 2].map((i) => [0, 1, 2].map((j) => (i === j ? 1 : 0) - 2 * N[i] * N[j]));
    for (const row of Rm) row[1] = -row[1]; // times (I - 2 e_y e_y^T): negate the second column
    const q = quatOf(Rm);
    const d = (2 * b + g) / 2;
    const pieces: Pose[] = [
      [-d * N[0], -d * N[1], -d * N[2], 1, 0, 0, 0],
      [d * N[0], d * N[1], d * N[2], ...q],
    ];
    let s = 0;
    for (const pose of pieces) {
      const X = place(S, pose).X;
      for (let v = 0; v < S.nv; v++)
        for (let f = 0; f < C.faces.length; f++) {
          const dist = C.N[3 * f] * X[3 * v] + C.N[3 * f + 1] * X[3 * v + 1] + C.N[3 * f + 2] * X[3 * v + 2];
          s = Math.max(s, (dist + w) / C.offsets[f]);
        }
    }
    return { p, config: { s, pieces } };
  };

  it("accepts two pieces 1e-7 apart face to face and rejects them overlapping or sticking out by 2e-7", () => {
    for (const code of ["bp3inbp3", "bp7incub", "bp12inbp12", "tz4intz4", "tz11incub", "tz12intz12"]) {
      const { p, config } = pair(code, 1e-7, 1e-7);
      const ok = validatePolyhedra(p, config, { tol: 0 });
      expect(ok.valid, code).toBe(true);
      expect(Math.abs(ok.minPairSep - 1e-7), code).toBeLessThan(1e-12);
      expect(Math.abs(ok.minWallGap - 1e-7), code).toBeLessThan(1e-12);
      const over = validatePolyhedra(p, pair(code, -2e-7, 1e-7).config, { tol: 1e-9 });
      expect(over.valid, code).toBe(false);
      expect(Math.abs(over.minPairSep + 2e-7), code).toBeLessThan(1e-12);
      const out = validatePolyhedra(p, pair(code, 1e-7, -2e-7).config, { tol: 1e-9 });
      expect(out.valid, code).toBe(false);
      expect(Math.abs(out.minWallGap + 2e-7), code).toBeLessThan(1e-12);
    }
  });
});

/** A unit quaternion [w, x, y, z] of a rotation matrix (Shepperd's method). */
function quatOf(R: number[][]): [number, number, number, number] {
  const t = R[0][0] + R[1][1] + R[2][2];
  if (t > 0) {
    const r = Math.sqrt(1 + t) * 2;
    return [r / 4, (R[2][1] - R[1][2]) / r, (R[0][2] - R[2][0]) / r, (R[1][0] - R[0][1]) / r];
  }
  if (R[0][0] > R[1][1] && R[0][0] > R[2][2]) {
    const r = Math.sqrt(1 + R[0][0] - R[1][1] - R[2][2]) * 2;
    return [(R[2][1] - R[1][2]) / r, r / 4, (R[0][1] + R[1][0]) / r, (R[0][2] + R[2][0]) / r];
  }
  if (R[1][1] > R[2][2]) {
    const r = Math.sqrt(1 + R[1][1] - R[0][0] - R[2][2]) * 2;
    return [(R[0][2] - R[2][0]) / r, (R[0][1] + R[1][0]) / r, r / 4, (R[1][2] + R[2][1]) / r];
  }
  const r = Math.sqrt(1 + R[2][2] - R[0][0] - R[1][1]) * 2;
  return [(R[1][0] - R[0][1]) / r, (R[0][2] + R[2][0]) / r, (R[1][2] + R[2][1]) / r, r / 4];
}

describe("work bounds", () => {
  it("validates 100 pieces of the largest solid, all in near contact, in bounded time", () => {
    // worst case for the pair test: the 120-vertex truncated icosidodecahedron, pieces on a tight grid so that
    // many pairs are near, each separated only along a cross product or a far face
    const p = getProblem("tidintid")!;
    const P = getSolid("truncated_icosidodecahedron");
    // half-widths along the axes: neighbours on the grid touch to within 1e-9
    const h = [0, 1, 2].map((k) => Math.max(...Array.from({ length: P.nv }, (_, v) => P.V[3 * v + k])));
    const pieces: Pose[] = [];
    // a 5 x 5 x 4 grid: 235 near pairs [CALC]
    for (let i = 0; i < 100; i++)
      pieces.push([(i % 5) * (2 * h[0] + 1e-9), (Math.floor(i / 5) % 5) * (2 * h[1] + 1e-9), Math.floor(i / 25) * (2 * h[2] + 1e-9), 1, 0, 0, 0]);
    const t0 = performance.now();
    const v = validatePolyhedra(p, { s: 1e3, pieces }, { stopAt: Infinity });
    const ms = performance.now() - t0;
    expect(v.valid).toBe(true);
    expect(v.pairsTested).toBeGreaterThan(200);
    expect(ms).toBeLessThan(5000);
  });
});
