/**
 * The board's drawing of a packing on a solid's surface (apps/web/src/space/render/surface.ts): its pieces are drawn
 * at their true size in site units, a disk of diameter 1 and a polygon of side 1. Until 2026-11-02 the drawing passed
 * no scale to pieceParts, which drew disks of the old radius 1 (twice their size, overlapping).
 */
import { describe, expect, it } from "vitest";
import { type SurfacePose, getSolid, surfaceArea } from "@polypack/surface";
import { drawnParts } from "../src/space/render/surface";

/** Area of a simple polygon given as x, y pairs. */
function area(poly: Float64Array): number {
  let a = 0;
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += poly[2 * i] * poly[2 * j + 1] - poly[2 * j] * poly[2 * i + 1];
  }
  return Math.abs(a) / 2;
}

const drawnArea = (parts: { poly: Float64Array }[]) => parts.reduce((t, p) => t + area(p.poly), 0);

// the research record of 10 disks on the cube, folded over its edges (live on 2026-11-02, valid in site units)
const CUBE_10: { s: number; pieces: SurfacePose[] } = {
  s: 1.2771635752724886,
  pieces: [
    { face: 4, x: -0.4893125921074972, y: 0.1028260045175433, theta: 2.373970520418212 },
    { face: 2, x: 0.4685637043722922, y: -0.13624423198342744, theta: -14.8915767662657 },
    { face: 3, x: -0.1362442319834273, y: -0.46856370437229267, theta: 1.5067275735027275 },
    { face: 0, x: -0.5644109962891064, y: -0.09509987013329821, theta: -4.14641373438678 },
    { face: 5, x: -0.13896119225806045, y: -0.6191071714924292, theta: -1.5171225588155899 },
    { face: 1, x: -0.6191071714924297, y: 0.13896119225806047, theta: -4.136595102224196 },
    { face: 4, x: 0.48931259210749767, y: -0.10282600451754315, theta: 3.710156912024749 },
    { face: 1, x: 0.38003693499145874, y: 0.1803260865346385, theta: 4.163895213371977 },
    { face: 5, x: -0.18032608653463816, y: 0.38003693499145924, theta: 2.312089318269186 },
    { face: 0, x: 0.5644109962891067, y: 0.09509987013329803, theta: -2.2690752989054825 },
  ],
};

describe("the surface board draws pieces at their true size", () => {
  it("a disk of diameter 1 in the middle of a face covers pi / 4", () => {
    const parts = drawnParts(getSolid("cube"), 2, 0, [{ face: 0, x: 0, y: 0, theta: 0 }]);
    expect(parts).toHaveLength(1);
    // drawn as a circumscribed many-sided polygon: a little more than the disk
    const a = drawnArea(parts);
    expect(a).toBeGreaterThan(Math.PI / 4);
    expect(a).toBeLessThan((Math.PI / 4) * 1.02);
  });

  it("the cube record's 10 disks cover 10 pi / 4, less than the cube's surface", () => {
    const S = getSolid("cube");
    const a = drawnArea(drawnParts(S, CUBE_10.s, 0, CUBE_10.pieces));
    expect(a / ((10 * Math.PI) / 4)).toBeCloseTo(1, 1);
    expect(a).toBeLessThan(surfaceArea(S, CUBE_10.s));
  });

  it("a polygon keeps side 1: a triangle in the middle of a tetrahedron's face covers sqrt(3) / 4", () => {
    const parts = drawnParts(getSolid("tetrahedron"), 3, 3, [{ face: 0, x: 0, y: 0, theta: 0 }]);
    expect(drawnArea(parts)).toBeCloseTo(Math.sqrt(3) / 4, 9);
  });
});
