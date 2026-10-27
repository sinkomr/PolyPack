import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  Pose,
  findFreeSpot,
  findOverlaps,
  pieceContainsPoint,
  pieceSeparation,
  rotateGroup,
  rotatePose,
  slideMove,
  snapDistance,
} from "../src";

/** A valid random layout built the way the board builds one. */
function layout(N: number, count: number, seeds: number[]): Pose[] {
  const poses: Pose[] = [];
  for (let i = 0; i < count; i++) {
    const p = findFreeSpot(N, poses, seeds[(2 * i) % seeds.length], seeds[(2 * i + 1) % seeds.length]);
    poses.push({ ...p, theta: seeds[i % seeds.length] });
  }
  // random thetas may collide with neighbours; keep only pieces that leave the layout valid
  const kept: Pose[] = [];
  for (const p of poses) if (findOverlaps(N, [...kept, p]).length === 0) kept.push(p);
  return kept;
}

const shapeArb = fc.constantFrom(0, 3, 4, 5, 6, 8);
const seedsArb = fc.array(fc.double({ min: -3, max: 3, noNaN: true }), { minLength: 4, maxLength: 12 });
const moveArb = fc.double({ min: -6, max: 6, noNaN: true });

describe("slideMove", () => {
  it("never produces an overlap", () => {
    fc.assert(
      fc.property(shapeArb, seedsArb, moveArb, moveArb, fc.nat(), fc.nat(), (N, seeds, dx, dy, pick, pick2) => {
        const poses = layout(N, 10, seeds);
        const ids = [...new Set([pick % poses.length, pick2 % poses.length])];
        const d = slideMove(N, poses, ids, dx, dy);
        const after = poses.map((p, i) => (ids.includes(i) ? { ...p, x: p.x + d.dx, y: p.y + d.dy } : p));
        // pieces inside the moved group keep their relative positions, so check all pairs
        expect(findOverlaps(N, after)).toHaveLength(0);
      }),
      { numRuns: 400 },
    );
  });

  it("slides along a blocking edge", () => {
    const sq = Math.PI / 4;
    // a wall of squares along y = 0, and a square above it pushed down and to the right
    const wall = [-2, -1, 0, 1, 2].map((x) => ({ x, y: 0, theta: sq }));
    const poses = [...wall, { x: -1.5, y: 2, theta: sq }];
    const d = slideMove(4, poses, [5], 2, -3);
    expect(d.dx).toBeCloseTo(2, 9);
    expect(-1.5 + d.dx).toBeCloseTo(0.5, 9);
    expect(2 + d.dy).toBeCloseTo(1, 9);
  });

  it("does not tunnel through a piece on a long move", () => {
    const poses = [{ x: 0, y: 0, theta: 0 }, { x: 0, y: 5, theta: 0 }];
    const d = slideMove(0, poses, [1], 0, -50);
    expect(5 + d.dy).toBeCloseTo(1, 9);
  });
});

describe("rotateGroup", () => {
  it("never produces an overlap", () => {
    fc.assert(
      fc.property(shapeArb, seedsArb, fc.double({ min: -7, max: 7, noNaN: true }), fc.nat(), fc.nat(), (N, seeds, ang, pick, pick2) => {
        const poses = layout(N, 10, seeds);
        const ids = [...new Set([pick % poses.length, pick2 % poses.length])];
        const px = ids.reduce((s, i) => s + poses[i].x, 0) / ids.length;
        const py = ids.reduce((s, i) => s + poses[i].y, 0) / ids.length;
        const r = rotateGroup(N, poses, ids, px, py, ang);
        expect(Math.abs(r.angle)).toBeLessThanOrEqual(Math.abs(ang));
        const after = poses.map((p, i) => {
          if (!ids.includes(i)) return p;
          const q = rotatePose(p, px, py, r.angle);
          return { ...q, x: q.x + r.dx, y: q.y + r.dy };
        });
        expect(findOverlaps(N, after)).toHaveLength(0);
      }),
      { numRuns: 400 },
    );
  });

  it("a square resting against one neighbour turns and is nudged away", () => {
    const sq = Math.PI / 4;
    const poses = [{ x: 0, y: 0, theta: sq }, { x: 1, y: 0, theta: sq }];
    const r = rotateGroup(4, poses, [1], 1, 0, Math.PI / 4);
    expect(r.angle).toBeCloseTo(Math.PI / 4, 12);
    const moved = { x: 1 + r.dx, y: r.dy, theta: sq + r.angle };
    // now a diamond whose corner touches the neighbour's face
    expect(moved.x).toBeCloseTo(0.5 + Math.SQRT1_2, 9);
    expect(Math.abs(pieceSeparation(4, moved, poses[0]).sep)).toBeLessThan(1e-9);
  });

  it("a wedged square stops at contact", () => {
    const sq = Math.PI / 4;
    const poses = [-1, 0, 1].flatMap((x) => [-1, 0, 1].map((y) => ({ x, y, theta: sq })));
    const r = rotateGroup(4, poses, [4], 0, 0, 0.5);
    expect(Math.abs(r.angle)).toBeLessThan(1e-6);
    expect(Math.hypot(r.dx, r.dy)).toBeLessThan(1e-6);
  });
});

describe("snapDistance", () => {
  it("moves to exact contact", () => {
    fc.assert(
      fc.property(shapeArb, seedsArb, fc.double({ min: 0, max: 6.28, noNaN: true }), fc.nat(), (N, seeds, dir, pick) => {
        const poses = layout(N, 8, seeds);
        const id = pick % poses.length;
        const ux = Math.cos(dir);
        const uy = Math.sin(dir);
        const t = snapDistance(N, poses, [id], ux, uy);
        const moved = { ...poses[id], x: poses[id].x + t * ux, y: poses[id].y + t * uy };
        const after = poses.map((p, i) => (i === id ? moved : p));
        expect(findOverlaps(N, after)).toHaveLength(0);
        if (t > 0) {
          const gaps = poses.filter((_, i) => i !== id).map((p) => pieceSeparation(N, moved, p).sep);
          expect(Math.min(...gaps)).toBeLessThan(1e-9);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("returns 0 when nothing is in the way", () => {
    const poses = [{ x: 0, y: 0, theta: 0 }, { x: 5, y: 0, theta: 0 }];
    expect(snapDistance(3, poses, [0], -1, 0)).toBe(0);
    expect(snapDistance(0, poses, [0], 1, 0)).toBeCloseTo(4, 9);
  });
});

describe("helpers", () => {
  it("findFreeSpot never overlaps", () => {
    const poses: Pose[] = [];
    for (let i = 0; i < 60; i++) poses.push(findFreeSpot(5, poses, 0, 0));
    expect(findOverlaps(5, poses)).toHaveLength(0);
  });

  it("point-in-piece", () => {
    const sq = { x: 0, y: 0, theta: Math.PI / 4 };
    expect(pieceContainsPoint(4, sq, 0.49, 0.49)).toBe(true);
    expect(pieceContainsPoint(4, sq, 0.51, 0)).toBe(false);
    expect(pieceContainsPoint(0, sq, 0.35, 0.35)).toBe(true);
    expect(pieceContainsPoint(0, sq, 0.4, 0.4)).toBe(false);
  });
});
