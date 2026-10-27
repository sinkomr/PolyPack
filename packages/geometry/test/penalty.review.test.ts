// Independent review of packages/geometry/src/penalty.ts (written by a reviewer, not the author).
// Every test here is expected to pass: no defect was found in the geometry derivatives.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  DISK_RADIUS,
  circumradius,
  containerProtrusions,
  evaluate,
  pairPenetration,
  pieceSeparation,
  pieceVertices,
  polygonSeparation,
  type Container,
  type Pose,
} from "../src/index";

/** Small deterministic generator, independent of the solver package. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const SHAPES = [0, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 20, 50];
const POSE_KEYS = ["x", "y", "theta"] as const;

describe("review: pairPenetration", () => {
  it("has a depth bit-identical to -pieceSeparation, including far from the origin", () => {
    const pose = (N: number) =>
      fc.record({
        x: fc.double({ min: -3, max: 3, noNaN: true }),
        y: fc.double({ min: -3, max: 3, noNaN: true }),
        theta: N === 0 ? fc.constant(0) : fc.double({ min: -50, max: 50, noNaN: true }),
      });
    for (const N of SHAPES) {
      fc.assert(
        fc.property(pose(N), pose(N), fc.constantFrom(0, 1e3, 1e5, -9.9e5), (a, b, off) => {
          const A = { ...a, x: a.x + off };
          const B = { ...b, x: b.x + off, y: b.y };
          const depth = pairPenetration(N, A, B).depth;
          expect(depth === 0 ? 0 : depth).toBe(0 - pieceSeparation(N, A, B).sep);
        }),
        { numRuns: 300, seed: 20261008 + N },
      );
    }
  });

  it("agrees with the generic vertex-based SAT and reports the true contact feature", () => {
    const rnd = lcg(1);
    for (const N of SHAPES.filter((n) => n !== 0)) {
      const R = circumradius(N);
      for (let t = 0; t < 300; t++) {
        const a = { x: rnd() - 0.5, y: rnd() - 0.5, theta: 14 * rnd() - 7 };
        const d = R * (0.05 + 2.5 * rnd());
        const ang = 2 * Math.PI * rnd();
        const b = { x: a.x + d * Math.cos(ang), y: a.y + d * Math.sin(ang), theta: 14 * rnd() - 7 };
        const p = pairPenetration(N, a, b);
        const va = pieceVertices(N, a);
        const vb = pieceVertices(N, b);
        expect(p.depth).toBeCloseTo(-polygonSeparation(va, vb).sep, 10);
        // Recompute the depth from the reported feature alone: vertex against the line of the edge.
        const f = p.feature!;
        const e = f.edgePiece === "a" ? va : vb;
        const v = f.edgePiece === "a" ? vb : va;
        const i = f.edge;
        const j = (i + 1) % N;
        const ex = e[2 * j] - e[2 * i];
        const ey = e[2 * j + 1] - e[2 * i + 1];
        const signed = (v[2 * f.vertex] - e[2 * i]) * ey - (v[2 * f.vertex + 1] - e[2 * i + 1]) * ex;
        expect(-signed).toBeCloseTo(p.depth, 10);
      }
    }
  });

  it("matches central finite differences in x, y and theta of both pieces while the feature is unchanged", () => {
    const rnd = lcg(2);
    let checked = 0;
    for (const N of SHAPES) {
      const R = N === 0 ? DISK_RADIUS : circumradius(N);
      for (let t = 0; t < 400; t++) {
        const a = { x: rnd() - 0.5, y: rnd() - 0.5, theta: N === 0 ? 0 : 14 * rnd() - 7 };
        const d = R * (0.05 + 2.5 * rnd());
        const ang = 2 * Math.PI * rnd();
        const b = { x: a.x + d * Math.cos(ang), y: a.y + d * Math.sin(ang), theta: N === 0 ? 0 : 14 * rnd() - 7 };
        const p = pairPenetration(N, a, b);
        const feature = JSON.stringify(p.feature);
        for (const which of ["a", "b"] as const) {
          for (const key of POSE_KEYS) {
            const h = 1e-6;
            const plus = { a: { ...a }, b: { ...b } };
            const minus = { a: { ...a }, b: { ...b } };
            plus[which][key] += h;
            minus[which][key] -= h;
            const up = pairPenetration(N, plus.a, plus.b);
            const down = pairPenetration(N, minus.a, minus.b);
            if (JSON.stringify(up.feature) !== feature || JSON.stringify(down.feature) !== feature) continue;
            const numeric = (up.depth - down.depth) / (2 * h);
            expect(Math.abs(numeric - p[which][key])).toBeLessThan(1e-7 * (1 + Math.abs(numeric)));
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(25000);
  });

  it("is a non-smooth rotational minimum at exact face-to-face contact (why aligned squares lock)", () => {
    // Two overlapping pieces with parallel faces: rotating either piece either way deepens the SAT
    // penetration, so the depth has a V-shaped kink in theta and the single branch gradient returned
    // there is only one of the one-sided slopes. This is inherent to SAT depth, not a defect.
    for (const N of [3, 4, 5, 6, 8, 12]) {
      // a has a face pointing straight down and b a face pointing straight up.
      const a: Pose = { x: 0, y: 0, theta: -Math.PI - Math.PI / N };
      const b: Pose = { x: 0.13, y: -(2 * (circumradius(N) * Math.cos(Math.PI / N)) - 0.05), theta: -Math.PI / N };
      const base = pairPenetration(N, a, b);
      expect(base.depth).toBeCloseTo(0.05, 9);
      for (const delta of [1e-4, -1e-4]) {
        expect(pairPenetration(N, { ...a, theta: a.theta + delta }, b).depth).toBeGreaterThan(base.depth + 1e-5);
        expect(pairPenetration(N, a, { ...b, theta: b.theta + delta }).depth).toBeGreaterThan(base.depth + 1e-5);
      }
      for (const key of POSE_KEYS) {
        expect(Number.isFinite(base.a[key])).toBe(true);
        expect(Number.isFinite(base.b[key])).toBe(true);
      }
      // Translation invariance of the selected branch: the two translational gradients cancel.
      expect(base.a.x + base.b.x).toBeCloseTo(0, 12);
      expect(base.a.y + base.b.y).toBeCloseTo(0, 12);
    }
  });
});

describe("review: containerProtrusions", () => {
  const PIECES = [0, 3, 4, 5, 7, 8, 12, 20];
  const CONTAINERS = [0, 3, 4, 5, 6, 7, 9, 12, 50];

  it("matches central finite differences in pose, container centre, size and phi for every kind combination", () => {
    const rnd = lcg(3);
    for (const N of PIECES) {
      for (const M of CONTAINERS) {
        for (let t = 0; t < 12; t++) {
          const pose: Pose = { x: 6 * rnd() - 3, y: 6 * rnd() - 3, theta: N === 0 ? 0 : 14 * rnd() - 7 };
          const c: Container = {
            M,
            cx: 2 * rnd() - 1,
            cy: 2 * rnd() - 1,
            size: 0.5 + 5 * rnd(),
            phi: M === 0 ? 0 : 14 * rnd() - 7,
          };
          const base = containerProtrusions(N, pose, c);
          expect(base).toHaveLength((N === 0 ? 1 : N) * (M === 0 ? 1 : M));
          const h = 1e-6;
          const moves: [(d: number) => [Pose, Container], (k: number) => number][] = [
            [(d) => [{ ...pose, x: pose.x + d }, c], (k) => base[k].pose.x],
            [(d) => [{ ...pose, y: pose.y + d }, c], (k) => base[k].pose.y],
            [(d) => [{ ...pose, theta: pose.theta + d }, c], (k) => base[k].pose.theta],
            [(d) => [pose, { ...c, cx: c.cx + d }], (k) => base[k].container.cx],
            [(d) => [pose, { ...c, cy: c.cy + d }], (k) => base[k].container.cy],
            [(d) => [pose, { ...c, size: c.size + d }], (k) => base[k].container.size],
            [(d) => [pose, { ...c, phi: c.phi + d }], (k) => base[k].container.phi],
          ];
          for (const [move, analytic] of moves) {
            const up = containerProtrusions(N, ...move(h));
            const down = containerProtrusions(N, ...move(-h));
            for (let k = 0; k < base.length; k++) {
              const numeric = (up[k].depth - down[k].depth) / (2 * h);
              if (Math.abs(numeric - analytic(k)) > 2e-7 * (1 + Math.abs(numeric)))
                throw new Error(`N=${N} M=${M} constraint ${k}: numeric ${numeric}, analytic ${analytic(k)}`);
            }
          }
        }
      }
    }
  });

  it("has maximum depth zero exactly at the shared enclosing container, at fixed and auto orientation", () => {
    const rnd = lcg(4);
    for (const N of PIECES) {
      for (const M of CONTAINERS) {
        for (let t = 0; t < 10; t++) {
          const P = 1 + Math.floor(6 * rnd());
          const pieces = Array.from({ length: P }, () => ({
            x: 6 * rnd() - 3,
            y: 6 * rnd() - 3,
            theta: N === 0 ? 0 : 14 * rnd() - 7,
          }));
          const result = evaluate({ N, M, P, pieces, container_phi: 6 * rnd() - 3 }, { autoOrient: t % 2 === 0 });
          let deepest = -Infinity;
          for (const p of pieces)
            for (const w of containerProtrusions(N, p, result.container!)) deepest = Math.max(deepest, w.depth);
          expect(Math.abs(deepest)).toBeLessThan(1e-9);
        }
      }
    }
  });
});
