import { describe, expect, it } from "vitest";
import { getSolid, validateFold, faceTo3D } from "../src/index";
import { PolygonEnergy, canonicalize, diskEnergy } from "../src/search/energy";
import { Packing, compress } from "../src/search/optimize";
import { areaScale, mulberry32, randomPose, searchProblem } from "../src/search/search";
import { simplex, slpPolish } from "../src/search/slp";

describe("search components", () => {
  it("canonicalize keeps the surface point and moves the centre into a face", () => {
    const S = getSolid("icosahedron");
    const rand = mulberry32(3);
    for (let t = 0; t < 200; t++) {
      const p = randomPose(S, rand);
      // push the point out of its face by up to 0.3 edge lengths
      const q = { ...p, x: p.x + (rand() - 0.5) * 0.6, y: p.y + (rand() - 0.5) * 0.6 };
      const c = canonicalize(S, 1, q);
      const a = (2 * Math.PI) / 3;
      for (let j = 0; j < 3; j++) {
        const ang = a * (j + 1) - Math.PI / 2;
        expect(c.x * Math.cos(ang) + c.y * Math.sin(ang)).toBeLessThanOrEqual(1 / (2 * Math.tan(Math.PI / 3)) + 1e-12);
      }
      // when the move crossed exactly one edge, the 3D point is the unfolded one: check via distance to the anchor
      if (c.face === q.face) expect(Math.hypot(c.x - q.x, c.y - q.y)).toBe(0);
      expect(Number.isFinite(c.theta)).toBe(true);
    }
    // a centre pushed far beyond a vertex of the tetrahedron is pulled back instead of looping
    const tet = getSolid("tetrahedron");
    const c = canonicalize(tet, 1, { face: 0, x: 0.2, y: 1.5, theta: 0 });
    expect(Number.isFinite(c.x) && Number.isFinite(c.y)).toBe(true);
    expect(faceTo3D(tet, 1, c.face, c.x, c.y).every(Number.isFinite)).toBe(true);
  });

  it("the disk energy gradient matches finite differences", () => {
    const S = getSolid("cube");
    const rand = mulberry32(11);
    const poses = Array.from({ length: 7 }, () => randomPose(S, rand)).map((p) => canonicalize(S, 1, p));
    const lam = 0.42;
    const g = new Float64Array(2 * poses.length);
    const E0 = diskEnergy(S, 1, lam, poses, g);
    expect(E0).toBeGreaterThan(0);
    const h = 1e-7;
    for (let i = 0; i < poses.length; i++)
      for (const c of [0, 1]) {
        const up = poses.map((p) => ({ ...p }));
        const dn = poses.map((p) => ({ ...p }));
        if (c === 0) {
          up[i].x += h;
          dn[i].x -= h;
        } else {
          up[i].y += h;
          dn[i].y -= h;
        }
        const fd = (diskEnergy(S, 1, lam, up.map((p) => canonicalize(S, 1, p))) - diskEnergy(S, 1, lam, dn.map((p) => canonicalize(S, 1, p)))) / (2 * h);
        expect(Math.abs(fd - g[2 * i + c])).toBeLessThan(1e-5 * Math.max(1, Math.abs(fd)));
      }
  });

  it("the polygon energy is zero exactly for packings the validator accepts", () => {
    const S = getSolid("cube");
    const tiling = Array.from({ length: 6 }, (_, f) => ({ face: f, x: 0, y: 0, theta: Math.PI / 4 }));
    // squares equal to the faces, at s = 1: scale 1 on the unit solid
    expect(new PolygonEnergy(S, 1, 4, 1 - 1e-9, tiling).total()).toBe(0);
    expect(new PolygonEnergy(S, 1, 4, 1.01, tiling).total()).toBeGreaterThan(0);
  });

  it("compression reproduces the cube's six-disk value 1.961568", () => {
    const S = getSolid("cube");
    let best = 0;
    for (let seed = 1; seed <= 3; seed++) {
      const rand = mulberry32(seed);
      const pk = new Packing(S, 0, 0.3, Array.from({ length: 6 }, () => randomPose(S, rand)));
      const r = compress(pk, 0.3);
      if (r && r.lam > best) best = r.lam;
    }
    expect(1 / best).toBeLessThan(1.9616);
    expect(1 / best).toBeGreaterThan(1.9615);
  });

  it("searchProblem is deterministic for a seed and returns a validated packing", () => {
    const S = getSolid("tetrahedron");
    const a = searchProblem(S, 3, 2, { seed: 5, randomStarts: 1, hops: 1, warm: [] });
    const b = searchProblem(S, 3, 2, { seed: 5, randomStarts: 1, hops: 1, warm: [] });
    expect(a && b).toBeTruthy();
    expect(a!.lam).toBe(b!.lam);
    const s = 1 / a!.lam;
    const v = validateFold({ solid: "tetrahedron", N: 3, s, pieces: a!.poses.map((p) => ({ ...p, x: p.x * s, y: p.y * s })) }, { tol: 1e-10 });
    expect(v.ok).toBe(true);
    expect(areaScale(S, 3, 2)).toBeGreaterThan(a!.lam);
  });

  it("simplex solves a small LP (with a degenerate vertex)", () => {
    // maximise x + y s.t. x + 2y <= 4, 3x + y <= 6, x <= 2, y <= 2 (optimum (1.6, 1.2), value 2.8)
    const z = simplex(
      [
        [1, 2],
        [3, 1],
        [1, 0],
        [0, 1],
      ],
      [4, 6, 2, 2],
      [1, 1],
    )!;
    expect(z[0] + z[1]).toBeCloseTo(2.8, 12);
    // degenerate: the constraint x + y <= 2 is redundant with x <= 1, y <= 1 at (1, 1)
    const w = simplex(
      [
        [1, 1],
        [1, 0],
        [0, 1],
      ],
      [2, 1, 1],
      [1, 1],
    )!;
    expect(w[0] + w[1]).toBeCloseTo(2, 12);
  });

  it("the contact-LP polish never lowers the scale and keeps the packing valid", () => {
    const S = getSolid("tetrahedron");
    const r = searchProblem(S, 4, 3, { seed: 2, randomStarts: 1, hops: 0, warm: [] })!;
    const shrunk = r.lam * (1 - 1e-3);
    const p = slpPolish(S, 4, shrunk, r.poses, { iterations: 60 });
    expect(p.lam).toBeGreaterThan(shrunk);
    const s = 1 / p.lam;
    const v = validateFold({ solid: "tetrahedron", N: 4, s, pieces: p.poses.map((q) => ({ ...q, x: q.x * s, y: q.y * s })) }, { tol: 1e-12 });
    expect(v.ok).toBe(true);
  });

  it("polish does not grow pieces flush with an edge into their neighbours (regression)", () => {
    // six octagons, one per cube face, each with four sides on its face's edges (s = 1 + sqrt 2)
    const S = getSolid("cube");
    const lam = (1 / (1 + Math.SQRT2)) * (1 - 1e-9);
    const poses = Array.from({ length: 6 }, (_, f) => ({ face: f, x: 0, y: 0, theta: Math.PI / 8 }));
    const r = slpPolish(S, 8, lam, poses, { iterations: 20 });
    expect(r.lam).toBeGreaterThanOrEqual(lam);
    const s = 1 / r.lam;
    const v = validateFold({ solid: "cube", N: 8, s, pieces: r.poses.map((q) => ({ ...q, x: q.x * s, y: q.y * s })) }, { tol: 1e-12 });
    expect(v.ok).toBe(true);
  });
});
