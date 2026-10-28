import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type Container,
  type Pose,
  circumradius,
  inradius,
  pairPenetration,
  pairSeparation,
  penaltyEdgeNormals,
  regularPolygonSeparation,
  visitContainerProtrusions,
} from "../src";
import * as refOverlap from "./reference/overlap";
import * as refPenalty from "./reference/penalty";

// The reference modules are origin/main 10b69de's overlap.ts and penalty.ts, unchanged but for the
// shapes import path: they compute every cos and sin inline. The kernel now memoises a piece's
// trigonometry by (N, theta); every result must be the same double, bit for bit.

const sides = [3, 4, 5, 6, 8, 12, 24, 100];
const thetaArb = fc.oneof(
  fc.double({ min: -10, max: 10, noNaN: true }),
  fc.double({ min: -1500, max: 1500, noNaN: true }), // past the pruning's |theta| limit of 1000
  fc.constantFrom(0, -0, Math.PI / 2, Math.PI, 2 * Math.PI, 1e-17, 1e6),
);
const coord = fc.double({ min: -3, max: 3, noNaN: true });

/** A second pose at a near-contact distance from the first, or anywhere, with a theta from a small pool so cache hits happen. */
const pairArb = fc
  .tuple(
    fc.constantFrom(...sides),
    thetaArb,
    thetaArb,
    fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }),
    fc.double({ min: -1e-6, max: 1e-6, noNaN: true }),
    fc.boolean(),
    fc.boolean(),
    coord,
    coord,
  )
  .map(([N, ta, tb, dir, jitter, near, sameTheta, x, y]) => {
    const a: Pose = { x, y, theta: ta };
    const gap = 2 * inradius(N) + (circumradius(N) - inradius(N)) * 0.5 * (1 + Math.sin(dir * 3)) + jitter;
    const dist = near ? gap : Math.abs(x) + 0.5;
    const b: Pose = { x: x + dist * Math.cos(dir), y: y + dist * Math.sin(dir), theta: sameTheta ? ta : tb };
    return { N, a, b };
  });

describe("trig cache is bit-identical to the inline-trig reference", () => {
  it("regularPolygonSeparation and pairSeparation", () => {
    fc.assert(
      fc.property(pairArb, fc.constantFrom(1, 0.9, 1.3), ({ N, a, b }, scale) => {
        const got = regularPolygonSeparation(N, a, b, scale);
        const want = refOverlap.regularPolygonSeparation(N, a, b, scale);
        expect(Object.is(got.sep, want.sep)).toBe(true);
        expect(Object.is(got.nx, want.nx)).toBe(true);
        expect(Object.is(got.ny, want.ny)).toBe(true);
        expect(Object.is(pairSeparation(N, a, b, scale), refOverlap.pairSeparation(N, a, b, scale))).toBe(true);
        // and again, now that both orientations are cached, and with the roles swapped
        expect(Object.is(regularPolygonSeparation(N, b, a, scale).sep, refOverlap.regularPolygonSeparation(N, b, a, scale).sep)).toBe(true);
      }),
      { numRuns: 3000 },
    );
  });

  it("pairPenetration, with and without caller axes and padding", () => {
    fc.assert(
      fc.property(pairArb, fc.constantFrom(0, 0.05), fc.boolean(), ({ N, a, b }, padding, withAxes) => {
        const axA = withAxes ? penaltyEdgeNormals(N, a.theta) : undefined;
        const axB = withAxes ? penaltyEdgeNormals(N, b.theta) : undefined;
        const got = pairPenetration(N, a, b, axA, axB, 1, padding);
        const want = refPenalty.pairPenetration(N, a, b, axA, axB, 1, padding);
        expect(JSON.stringify(got, replacer)).toBe(JSON.stringify(want, replacer));
      }),
      { numRuns: 2000 },
    );
  });

  it("visitContainerProtrusions in every mode, including circles", () => {
    const containerArb = fc.tuple(fc.constantFrom(0, 3, 4, 6, 7), fc.double({ min: 0.5, max: 8, noNaN: true }), thetaArb, coord, coord);
    fc.assert(
      fc.property(
        fc.constantFrom(0, ...sides),
        thetaArb,
        coord,
        coord,
        containerArb,
        fc.boolean(),
        fc.constantFrom(1, 0.8),
        fc.constantFrom(0, 0.02),
        (N, theta, x, y, [M, size, phi, cx, cy], supportOnly, scale, padding) => {
          const container: Container = { M, size, phi, cx, cy };
          const pose: Pose = { x, y, theta };
          const record = (visit: typeof visitContainerProtrusions) => {
            const out: unknown[] = [];
            visit(N, pose, container, (...args: unknown[]) => out.push(args), supportOnly, undefined, undefined, scale, padding);
            return out;
          };
          expect(JSON.stringify(record(visitContainerProtrusions), replacer)).toBe(
            JSON.stringify(record(refPenalty.visitContainerProtrusions), replacer),
          );
        },
      ),
      { numRuns: 3000 },
    );
  });

  it("is unaffected by a pose whose theta changes between calls, or by many orientations evicting each other", () => {
    // 5000 distinct orientations of one N overflow the 2048 memo slots; the same pose objects are mutated in place
    const N = 12;
    const a: Pose = { x: 0, y: 0, theta: 0 };
    const b: Pose = { x: 1.7, y: 0.3, theta: 0 };
    for (let i = 0; i < 5000; i++) {
      a.theta = (i * 0.37) % 7;
      b.theta = (i * 1.91) % 11;
      b.x = 1.5 + (i % 7) * 0.05;
      expect(Object.is(pairSeparation(N, a, b), refOverlap.pairSeparation(N, a, b))).toBe(true);
      const got = regularPolygonSeparation(N, a, b);
      const want = refOverlap.regularPolygonSeparation(N, a, b);
      expect(Object.is(got.sep, want.sep) && Object.is(got.nx, want.nx) && Object.is(got.ny, want.ny)).toBe(true);
    }
  });

  it("handles NaN and infinite orientations as the reference does", () => {
    for (const theta of [NaN, Infinity, -Infinity]) {
      for (const N of [5, 24]) {
        const a: Pose = { x: 0, y: 0, theta };
        const b: Pose = { x: 1, y: 0, theta: 0.3 };
        expect(Object.is(regularPolygonSeparation(N, a, b).sep, refOverlap.regularPolygonSeparation(N, a, b).sep)).toBe(true);
        expect(Object.is(regularPolygonSeparation(N, b, a).sep, refOverlap.regularPolygonSeparation(N, b, a).sep)).toBe(true);
      }
    }
  });
});

/** JSON that tells -0, NaN and infinities apart. */
function replacer(_key: string, v: unknown): unknown {
  if (typeof v === "number") return Object.is(v, -0) ? "-0" : Number.isFinite(v) ? v : String(v);
  return v;
}

// Forced collisions: thetas that share a memo slot or sit in adjacent ones (the second probe), every
// ordered pair, and a visitor that evicts those slots while the container walk is in progress.
describe("trig cache under forced slot collisions", () => {
  const f64 = new Float64Array(1);
  const u32 = new Uint32Array(f64.buffer);
  // a copy of the slot hash in trig.ts; if it drifts the test still passes, only less pointedly
  const slot = (N: number, t: number) => {
    f64[0] = t;
    return Math.imul(u32[0] ^ Math.imul(u32[1], 0x9e3779b1) ^ Math.imul(N, 0x27d4eb2f), 0x85ebca6b) >>> 21;
  };
  const collide = (N: number, base: number, offset: number, n: number) => {
    const target = (slot(N, base) + offset) & 2047;
    const out = offset === 0 ? [base] : [];
    for (let i = 1; out.length < n && i < 200000; i++) {
      const t = base + i * 1.0000001e-3;
      if (slot(N, t) === target) out.push(t);
    }
    return out;
  };
  const same = (x: unknown, y: unknown) => JSON.stringify(x, replacer) === JSON.stringify(y, replacer);

  it("mixes N into the slot, so mixed-N use does not share one slot", () => {
    const slots = new Set([3, 4, 5, 6, 7, 8, 12, 24, 100].map((N) => slot(N, 0.3)));
    expect(slots.size).toBeGreaterThan(5);
  });

  it("stays bit-identical for every ordered pair of colliding thetas and under evicting visitors", () => {
    for (const N of [5, 12, 24]) {
      const pool = [0, 1, 2].flatMap((off) => collide(N, 0.3, off, 3));
      expect(pool.length).toBeGreaterThanOrEqual(6);
      for (const ta of pool)
        for (const tb of pool)
          for (const [d, ang] of [[1.9, 0.1], [1.2, 1], [1.0, 2.5], [1.7, 4]]) {
            const a: Pose = { x: 0, y: 0, theta: ta };
            const b: Pose = { x: d * Math.cos(ang), y: d * Math.sin(ang), theta: tb };
            expect(same(regularPolygonSeparation(N, a, b), refOverlap.regularPolygonSeparation(N, a, b))).toBe(true);
            expect(Object.is(pairSeparation(N, a, b), refOverlap.pairSeparation(N, a, b))).toBe(true);
            expect(same(pairPenetration(N, a, b), refPenalty.pairPenetration(N, a, b))).toBe(true);
            expect(
              same(
                pairPenetration(N, a, b, undefined, undefined, 1, 0.03),
                refPenalty.pairPenetration(N, a, b, undefined, undefined, 1, 0.03),
              ),
            ).toBe(true);
          }
      for (const M of [0, 4, 6])
        for (const supportOnly of [false, true])
          for (const theta of pool) {
            const container: Container = { M, size: 6, phi: 0.2, cx: 0.1, cy: -0.1 };
            const pose: Pose = { x: 0.3, y: 0.2, theta };
            const record = (visit: typeof visitContainerProtrusions, evict: boolean) => {
              const out: unknown[] = [];
              visit(N, pose, container, (...args: unknown[]) => {
                if (evict)
                  for (const t of pool)
                    regularPolygonSeparation(N, { x: 0, y: 0, theta: t }, { x: 1.5, y: 0, theta: t + 1e-3 });
                out.push(args);
              }, supportOnly);
              return out;
            };
            expect(same(record(visitContainerProtrusions, true), record(refPenalty.visitContainerProtrusions, false))).toBe(true);
          }
    }
  });
});
