import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  Container,
  PairPenetration,
  Pose,
  Protrusion,
  containerProtrusions,
  containerVertices,
  enclose,
  pairPenetration,
  penaltyContainerNormals,
  penaltyEdgeNormals,
  pieceSeparation,
  pieceVertices,
  visitContainerProtrusions,
} from "../src";

const shapes = [0, 3, 4, 5, 6, 8];
const epsilon = 1e-6;
const real = (span: number) => fc.integer({ min: -100000, max: 100000 }).map((n) => (n * span) / 100003);
const poseArb: fc.Arbitrary<Pose> = fc.record({ x: real(4), y: real(4), theta: real(3) });
const containerArb: fc.Arbitrary<Container> = fc.record({
  M: fc.constant(0),
  cx: real(2),
  cy: real(2),
  phi: real(3),
  size: fc.integer({ min: 10000, max: 600000 }).map((n) => n / 100003),
});

function sameFeature(a: PairPenetration, b: PairPenetration): boolean {
  return (
    a.feature?.edgePiece === b.feature?.edgePiece &&
    a.feature?.edge === b.feature?.edge &&
    a.feature?.vertex === b.feature?.vertex
  );
}

function visitedProtrusions(
  N: number,
  pose: Pose,
  container: Container,
  supportOnly = false,
  scratch?: Float64Array,
  axes?: Float64Array,
) {
  const out: Protrusion[] = [];
  visitContainerProtrusions(
    N,
    pose,
    container,
    (depth, px, py, ptheta, cx, cy, size, phi, index, vertex, edge) => {
      out[index] = {
        depth,
        pose: { x: px, y: py, theta: ptheta },
        container: { cx, cy, size, phi },
        ...(vertex === undefined ? {} : { vertex }),
        ...(edge === undefined ? {} : { edge }),
      };
    },
    supportOnly,
    scratch,
    axes,
  );
  return out;
}

describe("analytic signed penetration", () => {
  for (const N of shapes) {
    it(`matches separation and central pose derivatives for N=${N}`, () => {
      fc.assert(
        fc.property(poseArb, poseArb, (a, b) => {
          fc.pre(Math.hypot(a.x - b.x, a.y - b.y) > 1e-3);
          const actual = pairPenetration(N, a, b);
          expect(actual.depth).toBeCloseTo(-pieceSeparation(N, a, b).sep, 12);
          const checks: Array<{ numeric: number; analytic: number }> = [];
          for (const piece of ["a", "b"] as const) {
            for (const key of ["x", "y", "theta"] as const) {
              const p = piece === "a" ? a : b;
              const plus = { ...p, [key]: p[key] + epsilon };
              const minus = { ...p, [key]: p[key] - epsilon };
              const high = pairPenetration(N, piece === "a" ? plus : a, piece === "b" ? plus : b);
              const low = pairPenetration(N, piece === "a" ? minus : a, piece === "b" ? minus : b);
              // A central difference across a SAT switch measures no single branch.
              fc.pre(sameFeature(actual, high) && sameFeature(actual, low));
              checks.push({ numeric: (high.depth - low.depth) / (2 * epsilon), analytic: actual[piece][key] });
            }
          }
          for (const check of checks) expect(Math.abs(check.numeric - check.analytic)).toBeLessThan(2e-6);
        }),
        { numRuns: 300, seed: 10521 + N },
      );
    });
  }

  it("handles coincident centres and ties with finite, deterministic branch derivatives", () => {
    const pose = { x: 0, y: 0, theta: 0 };
    for (const N of shapes) {
      const value = pairPenetration(N, pose, pose);
      expect(value.depth).toBeCloseTo(-pieceSeparation(N, pose, pose).sep, 12);
      expect(Object.values(value.a).every(Number.isFinite)).toBe(true);
      expect(Object.values(value.b).every(Number.isFinite)).toBe(true);
      expect(pairPenetration(N, pose, pose)).toEqual(value);
    }
  });

  it("returns the actual vertex against the selected edge", () => {
    fc.assert(
      fc.property(fc.constantFrom(3, 4, 5, 6, 8), poseArb, poseArb, (N, a, b) => {
        const contact = pairPenetration(N, a, b);
        const feature = contact.feature!;
        const p = pieceVertices(N, feature.edgePiece === "a" ? a : b);
        const q = pieceVertices(N, feature.edgePiece === "a" ? b : a);
        const edge = feature.edge;
        const next = (edge + 1) % N;
        const ex = p[2 * next] - p[2 * edge];
        const ey = p[2 * next + 1] - p[2 * edge + 1];
        const length = Math.hypot(ex, ey);
        const ux = ey / length;
        const uy = -ex / length;
        const gaps: number[] = [];
        for (let k = 0; k < N; k++) {
          gaps.push((q[2 * k] - p[2 * edge]) * ux + (q[2 * k + 1] - p[2 * edge + 1]) * uy);
        }
        expect(gaps[feature.vertex]).toBeCloseTo(Math.min(...gaps), 11);
        expect(contact.depth).toBeCloseTo(-gaps[feature.vertex], 11);
      }),
      { numRuns: 400, seed: 422 },
    );
  });
});

describe("cached penalty edge normals", () => {
  const sides = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 20, 50];
  for (const N of sides) {
    it(`cached and uncached pairs are bit-identical, including gradients and features, for N=${N}`, () => {
      const axesA = new Float64Array(3 * N);
      const axesB = new Float64Array(3 * N);
      fc.assert(
        fc.property(poseArb, poseArb, fc.constantFrom(0, 1e3, 1e5, -9.9e5), (a, b, offset) => {
          const A = { ...a, x: a.x + offset, theta: a.theta * 30 };
          const B = { ...b, x: b.x + offset, theta: b.theta * 30 };
          expect(penaltyEdgeNormals(N, A.theta, axesA)).toBe(axesA);
          expect(penaltyEdgeNormals(N, B.theta, axesB)).toBe(axesB);
          const plain = pairPenetration(N, A, B);
          expect(pairPenetration(N, A, B, axesA, axesB)).toEqual(plain);
          expect(pairPenetration(N, A, B, axesA)).toEqual(plain);
          expect(pairPenetration(N, A, B, undefined, axesB)).toEqual(plain);
          expect(plain.depth === 0 ? 0 : plain.depth).toBe(0 - pieceSeparation(N, A, B).sep);
        }),
        { numRuns: 160, seed: 26910 + N },
      );
    });
  }

  it("keeps exact-contact and coincident SAT tie selection unchanged", () => {
    for (const N of sides) {
      for (const theta of [0, Math.PI / 4, -Math.PI / N, 51.2]) {
        const a = { x: 0, y: 0, theta };
        for (const b of [a, { ...a, x: 0.1, y: -0.05 }, { ...a, x: 1 }]) {
          const axesA = penaltyEdgeNormals(N, a.theta);
          const axesB = penaltyEdgeNormals(N, b.theta);
          expect(pairPenetration(N, a, b, axesA, axesB)).toEqual(pairPenetration(N, a, b));
        }
      }
    }
  });

  it("handles empty circle caches and ignores undersized polygon caches", () => {
    const empty = penaltyEdgeNormals(0, 2);
    expect(empty).toHaveLength(0);
    expect(penaltyEdgeNormals(0, 4, empty)).toBe(empty);
    const a = { x: 0, y: 0, theta: 0.3 };
    const b = { x: 0.7, y: -0.8, theta: -0.4 };
    expect(pairPenetration(0, a, b, empty, empty)).toEqual(pairPenetration(0, a, b));
    expect(pairPenetration(4, a, b, empty, new Float64Array(11))).toEqual(pairPenetration(4, a, b));
    expect(penaltyEdgeNormals(4, 0, empty)).toHaveLength(12);
  });
});

describe("analytic protrusion constraints", () => {
  for (const N of shapes) {
    for (const M of shapes) {
      it(`matches direct geometry and all central derivatives for N=${N}, M=${M}`, () => {
        fc.assert(
          fc.property(poseArb, containerArb, (pose, arbitraryContainer) => {
            const container = { ...arbitraryContainer, M };
            const actual = containerProtrusions(N, pose, container);
            const vertices = N === 0 ? [pose.x, pose.y] : pieceVertices(N, pose);
            const containerPoly = M === 0 ? undefined : containerVertices(container);
            expect(actual).toHaveLength((N === 0 ? 1 : N) * (M === 0 ? 1 : M));
            for (const constraint of actual) {
              const vertex = constraint.vertex ?? 0;
              const x = vertices[2 * vertex];
              const y = vertices[2 * vertex + 1];
              if (M === 0) {
                fc.pre(Math.hypot(x - container.cx, y - container.cy) > 1e-3);
                expect(constraint.depth).toBeCloseTo(
                  Math.hypot(x - container.cx, y - container.cy) + (N === 0 ? 1 : 0) - container.size,
                  12,
                );
              } else {
                const edge = constraint.edge!;
                const prev = (edge + M - 1) % M;
                const px = containerPoly![2 * prev];
                const py = containerPoly![2 * prev + 1];
                const ex = containerPoly![2 * edge] - px;
                const ey = containerPoly![2 * edge + 1] - py;
                const length = Math.hypot(ex, ey);
                expect(constraint.depth).toBeCloseTo(((x - px) * ey - (y - py) * ex) / length + (N === 0 ? 1 : 0), 11);
              }
            }

            for (const key of ["x", "y", "theta"] as const) {
              const high = containerProtrusions(N, { ...pose, [key]: pose[key] + epsilon }, container);
              const low = containerProtrusions(N, { ...pose, [key]: pose[key] - epsilon }, container);
              for (let i = 0; i < actual.length; i++) {
                const numeric = (high[i].depth - low[i].depth) / (2 * epsilon);
                expect(Math.abs(numeric - actual[i].pose[key])).toBeLessThan(2e-6);
              }
            }
            for (const key of ["cx", "cy", "size", "phi"] as const) {
              const high = containerProtrusions(N, pose, { ...container, [key]: container[key] + epsilon });
              const low = containerProtrusions(N, pose, { ...container, [key]: container[key] - epsilon });
              for (let i = 0; i < actual.length; i++) {
                const numeric = (high[i].depth - low[i].depth) / (2 * epsilon);
                expect(Math.abs(numeric - actual[i].container[key])).toBeLessThan(2e-6);
              }
            }
          }),
          { numRuns: 45, seed: 6543 + N * 10 + M },
        );
      });

      it(`agrees with the existing enclosing-container conventions for N=${N}, M=${M}`, () => {
        fc.assert(
          fc.property(fc.array(poseArb, { minLength: 1, maxLength: 8 }), real(3), (poses, phi) => {
            const container = enclose(N, poses, M, phi);
            const depths = poses.flatMap((pose) => containerProtrusions(N, pose, container).map((g) => g.depth));
            expect(Math.max(...depths)).toBeLessThan(2e-8);
            const smaller = { ...container, size: container.size - 1e-5 };
            const shrunk = poses.flatMap((pose) => containerProtrusions(N, pose, smaller).map((g) => g.depth));
            expect(Math.max(...shrunk)).toBeGreaterThan(1e-7);
          }),
          { numRuns: 12, seed: 20001 + N * 10 + M },
        );
      });
    }
  }

  it("circle-centre radial degeneracy returns finite subgradients", () => {
    const container = { M: 0, cx: 2, cy: -1, phi: 0.7, size: 3 };
    const constraint = containerProtrusions(0, { x: 2, y: -1, theta: 0.4 }, container)[0];
    expect(constraint.depth).toBe(-2);
    expect(Object.values(constraint.pose).every(Number.isFinite)).toBe(true);
    expect(Object.values(constraint.container).every(Number.isFinite)).toBe(true);
  });
});

describe("numeric protrusion visitor", () => {
  it("cached container normals preserve every full and support constraint exactly", () => {
    const scratch = new Float64Array(240);
    const cached = new Map<number, Float64Array>();
    fc.assert(
      fc.property(
        fc.constantFrom(...shapes, 7, 12, 20, 50),
        fc.constantFrom(...shapes, 7, 12, 20, 50),
        poseArb,
        containerArb,
        fc.constantFrom(0, 1e3, 1e5, -9.9e5),
        (N, M, pose, value, offset) => {
          const container = { ...value, M, phi: value.phi * 30, cx: value.cx + offset };
          const p = { ...pose, x: pose.x + offset, theta: pose.theta * 30 };
          const out = cached.get(M) ?? new Float64Array(3 * M);
          cached.set(M, out);
          const axes = penaltyContainerNormals(M, container.phi, out);
          expect(axes).toBe(out);
          for (const supportOnly of [false, true]) {
            const base = visitedProtrusions(N, p, container, supportOnly, scratch);
            expect(visitedProtrusions(N, p, container, supportOnly, scratch, axes)).toEqual(base);
            expect(visitedProtrusions(N, p, container, supportOnly, undefined, axes)).toEqual(base);
            expect(visitedProtrusions(N, p, container, supportOnly, scratch, new Float64Array(0))).toEqual(base);
          }
        },
      ),
      { numRuns: 250, seed: 810316 },
    );
  });

  it("cached container axes keep exact support ties and empty circles unchanged", () => {
    expect(penaltyContainerNormals(0, 2)).toHaveLength(0);
    const pose = { x: 0, y: 0, theta: Math.PI / 4 };
    const container = { M: 4, cx: 0, cy: 0, phi: 0, size: 1 };
    const axes = penaltyContainerNormals(4, 0, new Float64Array(1));
    expect(axes).toHaveLength(12);
    for (const supportOnly of [false, true]) {
      expect(visitedProtrusions(4, pose, container, supportOnly, undefined, axes)).toEqual(
        visitedProtrusions(4, pose, container, supportOnly),
      );
    }
  });

  it("preserves every full constraint and vertex-major index with reusable scratch", () => {
    const scratch = new Float64Array(32);
    fc.assert(
      fc.property(
        fc.constantFrom(...shapes),
        fc.constantFrom(...shapes),
        poseArb,
        containerArb,
        (N, M, pose, value) => {
          const container = { ...value, M };
          const full = containerProtrusions(N, pose, container);
          expect(visitedProtrusions(N, pose, container, false, scratch)).toEqual(full);
          expect(visitedProtrusions(N, pose, container, false, new Float64Array(0))).toEqual(full);
          if (N === 0 || M === 0) expect(visitedProtrusions(N, pose, container, true)).toEqual(full);
          for (let k = 0; k < full.length; k++) {
            if (N !== 0) expect(full[k].vertex).toBe(M === 0 ? k : Math.floor(k / M));
            if (M !== 0) expect(full[k].edge).toBe(k % M);
          }
        },
      ),
      { numRuns: 250, seed: 72611 },
    );
  });

  for (const N of shapes.filter((n) => n !== 0)) {
    for (const M of shapes.filter((m) => m !== 0)) {
      it(`support-only walls equal max vertex depths and have central derivatives for N=${N}, M=${M}`, () => {
        fc.assert(
          fc.property(poseArb, containerArb, (pose, value) => {
            const container = { ...value, M };
            const full = containerProtrusions(N, pose, container);
            const support = visitedProtrusions(N, pose, container, true);
            expect(support).toHaveLength(M);
            for (let edge = 0; edge < M; edge++) {
              const wall = support[edge];
              const depths = full.filter((g) => g.edge === edge).map((g) => g.depth);
              expect(wall.depth).toBeCloseTo(Math.max(...depths), 11);
              expect(wall).toEqual(full[wall.vertex! * M + edge]);
            }

            for (const key of ["x", "y", "theta"] as const) {
              const high = visitedProtrusions(N, { ...pose, [key]: pose[key] + epsilon }, container, true);
              const low = visitedProtrusions(N, { ...pose, [key]: pose[key] - epsilon }, container, true);
              for (let edge = 0; edge < M; edge++) {
                fc.pre(high[edge].vertex === support[edge].vertex && low[edge].vertex === support[edge].vertex);
                const numeric = (high[edge].depth - low[edge].depth) / (2 * epsilon);
                expect(Math.abs(numeric - support[edge].pose[key])).toBeLessThan(2e-6);
              }
            }
            for (const key of ["cx", "cy", "size", "phi"] as const) {
              const high = visitedProtrusions(N, pose, { ...container, [key]: container[key] + epsilon }, true);
              const low = visitedProtrusions(N, pose, { ...container, [key]: container[key] - epsilon }, true);
              for (let edge = 0; edge < M; edge++) {
                fc.pre(high[edge].vertex === support[edge].vertex && low[edge].vertex === support[edge].vertex);
                const numeric = (high[edge].depth - low[edge].depth) / (2 * epsilon);
                expect(Math.abs(numeric - support[edge].container[key])).toBeLessThan(2e-6);
              }
            }
          }),
          { numRuns: 60, seed: 8011 + N * 100 + M },
        );
      });
    }
  }

  it("handles exact support ties with a deterministic finite branch", () => {
    const pose = { x: 0, y: 0, theta: Math.PI / 4 };
    const container = { M: 4, cx: 0, cy: 0, size: 1, phi: 0 };
    const full = containerProtrusions(4, pose, container);
    const support = visitedProtrusions(4, pose, container, true);
    expect(visitedProtrusions(4, pose, container, true)).toEqual(support);
    for (let edge = 0; edge < container.M; edge++) {
      const wall = support[edge];
      expect(Math.abs(wall.depth)).toBeLessThan(1e-14);
      expect(wall.depth).toBeCloseTo(Math.max(...full.filter((g) => g.edge === edge).map((g) => g.depth)), 12);
      expect(Object.values(wall.pose).every(Number.isFinite)).toBe(true);
      expect(Object.values(wall.container).every(Number.isFinite)).toBe(true);
    }
  });
});

// Backward-compatible shape continuation arguments; the preceding tests are unchanged.
describe("rounded penalty extensions", () => {
  for (const N of [3, 4, 5, 6, 8]) {
    it(`matches central pair derivatives at random scale and padding for N=${N}`, () => {
      fc.assert(
        fc.property(poseArb, poseArb, real(1), (a, b, u) => {
          const scale = 0.05 + 0.9 * Math.abs(u);
          const padding = (1 - scale) / (2 * Math.tan(Math.PI / N));
          const actual = pairPenetration(N, a, b, undefined, undefined, scale, padding);
          for (const piece of ["a", "b"] as const) {
            for (const key of ["x", "y", "theta"] as const) {
              const p = piece === "a" ? a : b;
              const plus = { ...p, [key]: p[key] + epsilon };
              const minus = { ...p, [key]: p[key] - epsilon };
              const high = pairPenetration(
                N,
                piece === "a" ? plus : a,
                piece === "b" ? plus : b,
                undefined,
                undefined,
                scale,
                padding,
              );
              const low = pairPenetration(
                N,
                piece === "a" ? minus : a,
                piece === "b" ? minus : b,
                undefined,
                undefined,
                scale,
                padding,
              );
              fc.pre(sameFeature(actual, high) && sameFeature(actual, low));
              expect(Math.abs((high.depth - low.depth) / (2 * epsilon) - actual[piece][key])).toBeLessThan(2e-6);
            }
          }
        }),
        { numRuns: 180, seed: 72000 + N },
      );
    });

    for (const M of [0, 3, 4, 5, 6, 8]) {
      it(`matches rounded containment derivatives for N=${N}, M=${M}`, () => {
        fc.assert(
          fc.property(poseArb, containerArb, real(1), (p, c, u) => {
            const container = { ...c, M };
            const scale = Math.abs(u);
            const padding = (1 - scale) / (2 * Math.tan(Math.PI / N));
            const actual = containerProtrusions(N, p, container, scale, padding);
            for (const key of ["x", "y", "theta"] as const) {
              const high = containerProtrusions(N, { ...p, [key]: p[key] + epsilon }, container, scale, padding);
              const low = containerProtrusions(N, { ...p, [key]: p[key] - epsilon }, container, scale, padding);
              for (let i = 0; i < actual.length; i++) {
                fc.pre(Math.abs(high[i].depth - low[i].depth) < 100 * epsilon);
                expect(Math.abs((high[i].depth - low[i].depth) / (2 * epsilon) - actual[i].pose[key])).toBeLessThan(
                  2e-6,
                );
              }
            }
            for (const key of ["cx", "cy", "size", "phi"] as const) {
              const high = containerProtrusions(
                N,
                p,
                { ...container, [key]: container[key] + epsilon },
                scale,
                padding,
              );
              const low = containerProtrusions(N, p, { ...container, [key]: container[key] - epsilon }, scale, padding);
              for (let i = 0; i < actual.length; i++) {
                expect(
                  Math.abs((high[i].depth - low[i].depth) / (2 * epsilon) - actual[i].container[key]),
                ).toBeLessThan(2e-6);
              }
            }
          }),
          { numRuns: 30, seed: 72100 + N * 10 + M },
        );
      });
    }
  }
});
