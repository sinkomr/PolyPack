/**
 * The fold search on the solids beyond the Platonic ones, and its nofold mode (every piece kept in
 * its face). Properties only: seeded outcomes differ between Node versions.
 */
import { describe, expect, it } from "vitest";
import { type SolidName, getSolid, validate, validateNofold } from "../src/index";
import { PolygonEnergy, diskEnergyNofold } from "../src/search/energy";
import { Packing } from "../src/search/optimize";
import { mulberry32, randomPose, searchProblem } from "../src/search/search";

describe("nofold energies", () => {
  it("are zero exactly when the nofold validator (tolerance 0) accepts", () => {
    const rand = mulberry32(3);
    let zero = 0;
    let positive = 0;
    for (const name of ["deltoidal_icositetrahedron", "rhombic_dodecahedron", "prism5", "antiprism4", "cube"] as SolidName[]) {
      const S = getSolid(name);
      for (let t = 0; t < 40; t++) {
        const N = [0, 3, 6, 12][t % 4];
        const lam = 0.05 + 0.25 * rand();
        const poses = Array.from({ length: 1 + (t % 3) }, () => randomPose(S, rand));
        const E = N === 0 ? diskEnergyNofold(S, 1, lam, poses) : new PolygonEnergy(S, 1, N, lam, poses, "nofold").total();
        // the energy is in the unit solid with pieces scaled by lam: the same packing at s = 1 / lam
        const s = 1 / lam;
        const v = validateNofold({ solid: name, N, s, pieces: poses.map((p) => ({ ...p, x: p.x * s, y: p.y * s })) }, { tol: 0 });
        if (E === 0) zero++;
        else positive++;
        expect(E === 0, `${name} N=${N}`).toBe(v.ok);
      }
    }
    expect(zero).toBeGreaterThan(10);
    expect(positive).toBeGreaterThan(10);
  });

  it("the disk gradient matches finite differences", () => {
    const S = getSolid("prism7");
    const rand = mulberry32(9);
    const poses = Array.from({ length: 6 }, () => randomPose(S, rand));
    const lam = 0.45;
    const g = new Float64Array(2 * poses.length);
    diskEnergyNofold(S, 1, lam, poses, g);
    const h = 1e-7;
    for (let i = 0; i < poses.length; i++)
      for (const c of [0, 1]) {
        const plus = poses.map((p, j) => (j === i ? { ...p, x: p.x + (c === 0 ? h : 0), y: p.y + (c === 1 ? h : 0) } : p));
        const minus = poses.map((p, j) => (j === i ? { ...p, x: p.x - (c === 0 ? h : 0), y: p.y - (c === 1 ? h : 0) } : p));
        const fd = (diskEnergyNofold(S, 1, lam, plus) - diskEnergyNofold(S, 1, lam, minus)) / (2 * h);
        expect(Math.abs(fd - g[2 * i + c])).toBeLessThan(1e-5 * (1 + Math.abs(fd)));
      }
  });

  it("Packing defaults to the fold mode", () => {
    const S = getSolid("antiprism6");
    const poses = [randomPose(S, mulberry32(1))];
    expect(new Packing(S, 0, 0.3, poses).mode).toBe("fold");
    expect(new Packing(S, 0, 0.3, poses, "nofold").mode).toBe("nofold");
  });
});

describe("searches on the new solids", () => {
  it("fold and nofold searches return valid packings, the same for the same seed", () => {
    const cases: [SolidName, number, number, "fold" | "nofold"][] = [
      ["deltoidal_icositetrahedron", 4, 3, "nofold"],
      ["prism3", 0, 2, "fold"],
      ["antiprism7", 0, 4, "nofold"],
      ["triakis_octahedron", 3, 2, "fold"],
    ];
    for (const [name, N, P, mode] of cases) {
      const opts = { seed: 4, randomStarts: 1, hops: 1, warm: [], mode };
      const a = searchProblem(getSolid(name), N, P, opts);
      expect(a, name).not.toBeNull();
      const s = 1 / a!.lam;
      const pieces = a!.poses.map((p) => ({ face: p.face, x: p.x * s, y: p.y * s, theta: p.theta }));
      expect(validate({ solid: name, N, s, pieces }, mode).ok, name).toBe(true);
      const b = searchProblem(getSolid(name), N, P, opts);
      expect(b!.lam).toBe(a!.lam);
      expect(b!.poses).toEqual(a!.poses);
    }
  });

  it("stops at its deadline", () => {
    const t = Date.now();
    const r = searchProblem(getSolid("disdyakis_triacontahedron"), 6, 12, {
      seed: 1,
      randomStarts: 50,
      hops: 1000,
      warm: [],
      deadline: Date.now() + 300,
    });
    // the starts and hops end at the deadline; the final tightening and polish run on
    expect(Date.now() - t).toBeLessThan(45_000);
    if (r) expect(r.lam).toBeGreaterThan(0);
  });
});
