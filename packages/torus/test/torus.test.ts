import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { boundingRadius, circumradius, inradius } from "@polypack/geometry";
import {
  Lattice,
  TORUS_DISK_RADIUS,
  TorusPacking,
  areaScoreBound,
  cellArea,
  familyLattice,
  gaussReduce,
  latticeImages,
  scalePacking,
  torusScore,
  validateTorusPacking,
} from "../src";

const SQ3 = Math.sqrt(3);
const pose = (x: number, y: number, theta = 0) => ({ x, y, theta });
const pack = (family: TorusPacking["family"], N: number, lattice: Lattice, poses: ReturnType<typeof pose>[]): TorusPacking => ({
  family,
  N,
  lattice,
  poses,
});
/** the unit square tiling: theta = pi/4 turns the vertex-up square axis-aligned */
const squareTile = (L: number) => pack("sq", 4, familyLattice("sq", L), [pose(0.3, 0.2, Math.PI / 4)]);
/** two triangles tiling the hexagonal torus of side 1 */
const triangles = (L = 1, shift = 0) =>
  pack("hex", 3, familyLattice("hex", L), [pose(0.5, SQ3 / 6, 0), pose(1 - shift, SQ3 / 3, Math.PI)]);

describe("lattices", () => {
  it("builds the family lattices and scores", () => {
    const sq = familyLattice("sq", 3);
    expect(cellArea(sq)).toBeCloseTo(9, 12);
    expect(torusScore("sq", sq)).toBe(3);
    const hex = familyLattice("hex", 2);
    expect(cellArea(hex)).toBeCloseTo(2 * SQ3, 12);
    expect(torusScore("hex", hex)).toBe(2);
    expect(torusScore("free", hex)).toBeCloseTo(Math.sqrt(2 * SQ3), 12);
  });

  it("Gauss-reduces a skewed basis to a short one of the same lattice", () => {
    const l: Lattice = { b1: [2.5, 0], b2: [2500.3, 2.1] };
    const { lattice: r, M } = gaussReduce(l);
    expect(Math.hypot(...r.b1)).toBeCloseTo(Math.hypot(0.3, 2.1), 9);
    expect(Math.abs(r.b1[0] * r.b2[0] + r.b1[1] * r.b2[1])).toBeLessThanOrEqual((r.b1[0] ** 2 + r.b1[1] ** 2) / 2 + 1e-9);
    const detM = M[0][0] * M[1][1] - M[0][1] * M[1][0];
    expect(Math.abs(detM)).toBe(1);
    expect(cellArea(r)).toBeCloseTo(cellArea(l), 6);
  });

  it("enumerates every short lattice vector even for an unreduced basis", () => {
    const l: Lattice = { b1: [2.5, 0], b2: [2500.3, 1.9] };
    const imgs = latticeImages(l, [0, 0], 2, true);
    // b2 - 1000 b1 = (0.3, 1.9) and its negative are the only vectors shorter than 2;
    // the half plane (m > 0, or m = 0 and n > 0) keeps the negative, (m, n) = (1000, -1)
    const lens = imgs.map((im) => Math.hypot(...im.v));
    expect(imgs.length).toBe(1);
    expect(lens[0]).toBeCloseTo(Math.hypot(0.3, 1.9), 9);
    expect(imgs[0].m).toBe(1000);
    expect(imgs[0].n).toBe(-1);
  });

  it("refuses a nearly degenerate basis instead of hanging", () => {
    expect(() => latticeImages({ b1: [1e-7, 0], b2: [0, 1e7] }, [0, 0], 2)).toThrow();
  });

  it("matches brute force on random bases", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.5, max: 4, noNaN: true }),
        fc.double({ min: -20, max: 20, noNaN: true }),
        fc.double({ min: 0.5, max: 4, noNaN: true }),
        fc.double({ min: -3, max: 3, noNaN: true }),
        fc.double({ min: -3, max: 3, noNaN: true }),
        (a, b, c, dx, dy) => {
          const l: Lattice = { b1: [a, 0], b2: [b, c] };
          const reach = 2.5;
          const got = latticeImages(l, [dx, dy], reach)
            .map((im) => `${im.m},${im.n}`)
            .sort();
          const want: string[] = [];
          for (let m = -600; m <= 600; m++)
            for (let n = -12; n <= 12; n++) {
              const vx = dx + m * a + n * b;
              const vy = dy + n * c;
              if (vx * vx + vy * vy < reach * reach) want.push(`${m},${n}`);
            }
          expect(got).toEqual(want.sort());
        },
      ),
      { numRuns: 200, seed: 11 },
    );
  });
});

describe("validator: valid packings with contacts", () => {
  it("accepts the unit square tiling (all four neighbours touch)", () => {
    const v = validateTorusPacking(squareTile(1));
    expect(v.valid).toBe(true);
    expect(Math.abs(v.minSep)).toBeLessThan(1e-12);
    // (1,0), (0,1), (1,1) and (1,-1) in the half plane; corners touch at a point
    expect(v.contacts.length).toBe(4);
    expect(v.density).toBeCloseTo(1, 12);
  });

  it("accepts disks in self-contact through the shortest lattice vector", () => {
    const v = validateTorusPacking(pack("sq", 0, familyLattice("sq", 1), [pose(0, 0)]));
    expect(v.valid).toBe(true);
    expect(v.contacts.length).toBe(2);
  });

  it("accepts disks touching inside the cell and across its boundary", () => {
    const v = validateTorusPacking(pack("sq", 0, familyLattice("sq", 2), [pose(0.25, 0.5), pose(1.25, 0.5)]));
    expect(v.valid).toBe(true);
    const pair = v.contacts.filter((c) => c.i === 0 && c.j === 1);
    expect(pair.map((c) => [c.m, c.n])).toEqual(expect.arrayContaining([[0, 0], [-1, 0]]));
  });

  it("accepts the triangle tiling of the hexagonal torus", () => {
    const v = validateTorusPacking(triangles());
    expect(v.valid).toBe(true);
    expect(v.density).toBeCloseTo(1, 12);
  });

  it("accepts pieces given far outside the fundamental cell", () => {
    const v = validateTorusPacking(pack("sq", 0, familyLattice("sq", 2), [pose(200.25, 0.5), pose(1.25 - 2000, 20.5)]));
    expect(v.valid).toBe(true);
  });

  it("accepts the unit-square tiling given by a very skewed basis", () => {
    const v = validateTorusPacking(pack("free", 4, { b1: [1, 0], b2: [1000, 1] }, [pose(0.1, 0.1, Math.PI / 4)]));
    expect(v.valid).toBe(true);
  });
});

describe("validator: adversarial overlaps", () => {
  it("rejects self-overlap through a short lattice vector", () => {
    const v = validateTorusPacking(pack("sq", 0, familyLattice("sq", 1 - 5e-7), [pose(0, 0)]));
    expect(v.valid).toBe(false);
    expect(v.overlaps.every((o) => o.i === 0 && o.j === 0)).toBe(true);
  });

  it("rejects a polygon overlapping its own translate (diamond at L = 1)", () => {
    const v = validateTorusPacking(pack("sq", 4, familyLattice("sq", 1), [pose(0, 0, 0)]));
    expect(v.valid).toBe(false);
    expect(validateTorusPacking(pack("sq", 4, familyLattice("sq", Math.SQRT2), [pose(0, 0, 0)])).valid).toBe(true);
  });

  it("rejects overlap through the self-image of an unreduced basis", () => {
    const v = validateTorusPacking(pack("free", 0, { b1: [1.25, 0], b2: [1250.15, 0.95] }, [pose(0, 0)]));
    expect(v.valid).toBe(false);
    expect(v.overlaps[0].m).toBe(1000);
  });

  it("rejects overlap across the cell boundary only", () => {
    const v = validateTorusPacking(pack("sq", 0, familyLattice("sq", 2), [pose(0.25, 0.5), pose(1.25 + 5e-7, 0.5)]));
    expect(v.valid).toBe(false);
    expect(v.overlaps.map((o) => [o.m, o.n])).toEqual([[-1, 0]]);
  });

  it("rejects a shrunken triangle torus and a shifted triangle", () => {
    expect(validateTorusPacking(triangles(1 - 1e-6)).valid).toBe(false);
    expect(validateTorusPacking(triangles(1, 1e-6)).valid).toBe(false);
  });

  it("rejects near-degenerate and malformed input", () => {
    expect(validateTorusPacking(pack("free", 0, { b1: [3, 1], b2: [6, 2] }, [pose(0, 0)])).errors.length).toBeGreaterThan(0);
    expect(validateTorusPacking(pack("free", 0, { b1: [1e-7, 0], b2: [0, 1e7] }, [pose(0, 0)])).valid).toBe(false);
    expect(validateTorusPacking(pack("sq", 2, familyLattice("sq", 3), [pose(0, 0)])).valid).toBe(false);
    expect(validateTorusPacking(pack("sq", 0, familyLattice("sq", 3), [pose(NaN, 0)])).valid).toBe(false);
    expect(validateTorusPacking(pack("sq", 0, familyLattice("sq", Infinity), [pose(0, 0)])).valid).toBe(false);
    expect(validateTorusPacking(pack("sq", 0, familyLattice("sq", 3), [])).valid).toBe(false);
  });

  it("treats a 1e-9 overlap as touching at the shared tolerance and as overlap when strict", () => {
    // disks of diameter 1 (site units): the tolerance 1e-9 is in site lengths
    const p = pack("sq", 0, familyLattice("sq", 5), [pose(0, 0), pose(1 - 1e-10, 0)]);
    expect(validateTorusPacking(p).valid).toBe(true);
    expect(validateTorusPacking(p, { tol: 0 }).valid).toBe(false);
    // shrinking the pieces by 1e-9 clears it, the certificate-style check
    expect(validateTorusPacking(p, { tol: 0, scale: 1 - 1e-9 }).valid).toBe(true);
    // 2e-9 deep is an overlap even at the shared tolerance, and 0.9e-9 is still touching
    const deep = pack("sq", 0, familyLattice("sq", 5), [pose(0, 0), pose(1 - 2e-9, 0)]);
    expect(validateTorusPacking(deep).valid).toBe(false);
    const edge = pack("sq", 0, familyLattice("sq", 5), [pose(0, 0), pose(1 - 0.9e-9, 0)]);
    expect(validateTorusPacking(edge).valid).toBe(true);
  });
});

describe("validator: invariances (property tests)", () => {
  const shapes = [0, 3, 4, 5, 6, 7, 8];
  const arb = fc.record({
    N: fc.constantFrom(...shapes),
    pts: fc.array(fc.tuple(fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: -7, max: 7, noNaN: true })), {
      minLength: 1,
      maxLength: 5,
    }),
    L: fc.double({ min: 1.5, max: 8, noNaN: true }),
    m: fc.integer({ min: -3, max: 3 }),
    n: fc.integer({ min: -3, max: 3 }),
    shear: fc.integer({ min: -4, max: 4 }),
  });

  it("is unchanged by moving a piece by a lattice vector and by a change of basis", () => {
    fc.assert(
      fc.property(arb, ({ N, pts, L, m, n, shear }) => {
        const l = familyLattice("hex", L);
        const poses = pts.map(([u, v, t]) => pose(u * l.b1[0] + v * l.b2[0], u * l.b1[1] + v * l.b2[1], t));
        const base = validateTorusPacking(pack("hex", N, l, poses));
        const moved = poses.map((q, k) => (k === 0 ? pose(q.x + m * l.b1[0] + n * l.b2[0], q.y + m * l.b1[1] + n * l.b2[1], q.theta) : q));
        const other = validateTorusPacking(pack("free", N, { b1: l.b1, b2: [l.b2[0] + shear * l.b1[0], l.b2[1] + shear * l.b1[1]] }, moved));
        expect(other.valid).toBe(base.valid);
        expect(other.minSep).toBeCloseTo(base.minSep, 7);
        expect(other.pairsChecked).toBe(base.pairsChecked);
      }),
      { numRuns: 150, seed: 5 },
    );
  });

  it("stays valid when scaled up", () => {
    fc.assert(
      fc.property(arb, ({ N, pts, L }) => {
        const l = familyLattice("sq", L);
        const poses = pts.map(([u, v, t]) => pose(u * L, v * L, t));
        const p = pack("sq", N, l, poses);
        if (!validateTorusPacking(p, { tol: 0 }).valid) return;
        expect(validateTorusPacking(scalePacking(p, 1.01), { tol: 0 }).valid).toBe(true);
      }),
      { numRuns: 150, seed: 6 },
    );
  });

  it("agrees with an O(P^2 K^2) brute force over a large lattice box", () => {
    fc.assert(
      fc.property(arb, ({ N, pts, L }) => {
        const l = familyLattice("sq", L);
        const poses = pts.map(([u, v, t]) => pose(u * L, v * L, t));
        const v = validateTorusPacking(pack("sq", N, l, poses), { tol: 0 });
        // brute force with bounding disks only (an exact test is not needed: a pair is a
        // candidate iff its centres are within 2R, and the validator must test it)
        const R = N === 0 ? TORUS_DISK_RADIUS : boundingRadius(N);
        let candidates = 0;
        for (let i = 0; i < poses.length; i++)
          for (let j = i; j < poses.length; j++)
            for (let m = -8; m <= 8; m++)
              for (let n = -8; n <= 8; n++) {
                if (i === j && !(m > 0 || (m === 0 && n > 0))) continue;
                const dx = poses[j].x - poses[i].x + m * L;
                const dy = poses[j].y - poses[i].y + n * L;
                if (Math.hypot(dx, dy) < 2 * R + 2e-7) candidates++;
              }
        expect(v.pairsChecked).toBe(candidates);
      }),
      { numRuns: 150, seed: 7 },
    );
  });
});

describe("bounds", () => {
  it("area bound equals the tiling scores", () => {
    expect(areaScoreBound("sq", 4, 5)).toBeCloseTo(Math.sqrt(5), 12);
    expect(areaScoreBound("hex", 3, 2)).toBeCloseTo(1, 12);
    expect(areaScoreBound("free", 6, 1)).toBeCloseTo(Math.sqrt((3 * SQ3) / 2), 12);
    expect(circumradius(6)).toBeCloseTo(1, 12);
    expect(inradius(4)).toBeCloseTo(0.5, 12);
  });
});
