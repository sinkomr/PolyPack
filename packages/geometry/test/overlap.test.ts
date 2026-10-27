import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  TOL,
  circleSeparation,
  evaluate,
  findOverlaps,
  pieceSeparation,
  pieceVertices,
  polygonCircleSeparation,
  polygonSeparation,
  regularPolygonSeparation,
} from "../src";
import { intersectionArea, poseArb, sidesArb } from "./helpers";

describe("polygon separation (SAT)", () => {
  it("agrees in sign with a reference intersection area", () => {
    fc.assert(
      fc.property(sidesArb, poseArb(), poseArb(), (N, a, b) => {
        const va = pieceVertices(N, a);
        const vb = pieceVertices(N, b);
        const area = intersectionArea(va, vb);
        const { sep } = polygonSeparation(va, vb);
        if (sep > 1e-9) expect(area).toBeLessThan(1e-12);
        if (sep < -1e-6) expect(area).toBeGreaterThan(1e-14);
        if (area > 1e-9) expect(sep).toBeLessThan(0);
      }),
      { numRuns: 2000 },
    );
  });

  it("closed-form regular test equals the vertex-array reference", () => {
    fc.assert(
      fc.property(sidesArb, poseArb(), poseArb(), (N, a, b) => {
        const ref = polygonSeparation(pieceVertices(N, a), pieceVertices(N, b));
        const fast = regularPolygonSeparation(N, a, b);
        expect(fast.sep).toBeCloseTo(ref.sep, 9);
      }),
      { numRuns: 2000 },
    );
  });

  it("moving A along the contact normal by the depth resolves the overlap", () => {
    fc.assert(
      fc.property(sidesArb, poseArb(0.6), poseArb(0.6), (N, a, b) => {
        const c = regularPolygonSeparation(N, a, b);
        fc.pre(c.sep < 0);
        const moved = { ...a, x: a.x - c.sep * c.nx, y: a.y - c.sep * c.ny };
        expect(regularPolygonSeparation(N, moved, b).sep).toBeGreaterThan(-TOL);
      }),
      { numRuns: 1000 },
    );
  });

  it("two unit squares side by side touch exactly", () => {
    const a = { x: 0, y: 0, theta: Math.PI / 4 };
    const b = { x: 1, y: 0, theta: Math.PI / 4 };
    expect(Math.abs(pieceSeparation(4, a, b).sep)).toBeLessThan(1e-12);
    expect(findOverlaps(4, [a, b])).toHaveLength(0);
    expect(findOverlaps(4, [a, { ...b, x: 1 - 1e-6 }])).toHaveLength(1);
  });
});

describe("circles", () => {
  it("circle-circle uses the centre distance", () => {
    expect(circleSeparation({ x: 0, y: 0, theta: 0 }, { x: 3, y: 4, theta: 0 }).sep).toBeCloseTo(4, 12);
    expect(
      findOverlaps(0, [
        { x: 0, y: 0, theta: 0 },
        { x: 1, y: 0, theta: 0 },
      ]),
    ).toHaveLength(0);
    expect(
      findOverlaps(0, [
        { x: 0, y: 0, theta: 0 },
        { x: 0.999, y: 0, theta: 0 },
      ]),
    ).toHaveLength(1);
  });

  it("polygon-circle closest-point distance", () => {
    const sq = pieceVertices(4, { x: 0, y: 0, theta: Math.PI / 4 });
    // facing an edge, facing a corner, and centre inside
    expect(polygonCircleSeparation(sq, 2, 0, 1).sep).toBeCloseTo(0.5, 12);
    expect(polygonCircleSeparation(sq, 1.5, 1.5, 1).sep).toBeCloseTo(Math.SQRT2 - 1, 12);
    expect(polygonCircleSeparation(sq, 0.25, 0, 0.1).sep).toBeCloseTo(-0.35, 12);
  });
});

describe("broad phase", () => {
  it("grid search finds the same pairs as the all-pairs search", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(0, 3, 4, 5, 6, 9),
        fc.array(poseArb(4), { minLength: 2, maxLength: 40 }),
        (N, poses) => {
          const brute: string[] = [];
          for (let i = 0; i < poses.length; i++) {
            for (let j = i + 1; j < poses.length; j++) {
              if (pieceSeparation(N, poses[i], poses[j]).sep < -TOL) brute.push(`${i}-${j}`);
            }
          }
          const grid = findOverlaps(N, poses).map((o) => `${o.i}-${o.j}`);
          expect(grid.sort()).toEqual(brute.sort());
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("overlap limit", () => {
  // every piece at one point: P(P-1)/2 overlapping pairs without the limit
  const stacked = Array.from({ length: 60 }, () => ({ x: 0, y: 0, theta: 0 }));

  it("stops at the limit and finds every pair without one", () => {
    expect(findOverlaps(7, stacked)).toHaveLength((60 * 59) / 2);
    expect(findOverlaps(7, stacked, TOL, 1, 20)).toHaveLength(20);
    expect(findOverlaps(0, stacked.slice(0, 3), TOL, 1, 20)).toHaveLength(3);
  });

  it("evaluate reports a capped count as a lower bound and still rejects", () => {
    const capped = evaluate({ N: 7, M: 4, P: 60, pieces: stacked, container_phi: 0 }, { maxOverlaps: 20 });
    expect(capped.valid).toBe(false);
    expect(capped.reasons[0]).toMatch(/^at least 20 overlapping pair/);
    const few = evaluate({ N: 7, M: 4, P: 2, pieces: stacked.slice(0, 2), container_phi: 0 }, { maxOverlaps: 20 });
    expect(few.reasons[0]).toMatch(/^1 overlapping pair/);
  });
});
