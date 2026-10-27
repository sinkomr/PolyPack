import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  Container,
  areaLowerBound,
  autoOrient,
  containerArea,
  enclose,
  evaluate,
  pieceArea,
  pieceVertices,
  strictVerify,
  Pose,
  DISK_RADIUS,
} from "../src";
import { poseArb, sidesArb } from "./helpers";

/** Largest amount by which any piece sticks out of the container (negative when all are inside). */
function maxViolation(N: number, poses: Pose[], c: Container): number {
  let worst = -Infinity;
  const pts: [number, number, number][] = [];
  for (const p of poses) {
    if (N === 0) pts.push([p.x, p.y, DISK_RADIUS]);
    else {
      const v = pieceVertices(N, p);
      for (let i = 0; i < N; i++) pts.push([v[2 * i], v[2 * i + 1], 0]);
    }
  }
  if (c.M === 0) {
    for (const [x, y, pad] of pts) worst = Math.max(worst, Math.hypot(x - c.cx, y - c.cy) + pad - c.size / 2);
    return worst;
  }
  const apothem = c.size / (2 * Math.tan(Math.PI / c.M));
  for (let j = 0; j < c.M; j++) {
    const ang = c.phi - Math.PI / 2 + (2 * Math.PI * j) / c.M;
    for (const [x, y, pad] of pts) {
      worst = Math.max(worst, (x - c.cx) * Math.cos(ang) + (y - c.cy) * Math.sin(ang) + pad - apothem);
    }
  }
  return worst;
}

/** Primal brute force for the enclosing LP: try every vertex of the feasible region. */
function bruteApothem(N: number, poses: Pose[], M: number, phi: number): number {
  const u: [number, number][] = [];
  const h: number[] = [];
  for (let j = 0; j < M; j++) {
    const ang = phi - Math.PI / 2 + (2 * Math.PI * j) / M;
    u.push([Math.cos(ang), Math.sin(ang)]);
    let m = -Infinity;
    for (const p of poses) {
      if (N === 0) m = Math.max(m, p.x * u[j][0] + p.y * u[j][1] + DISK_RADIUS);
      else {
        const v = pieceVertices(N, p);
        for (let i = 0; i < N; i++) m = Math.max(m, v[2 * i] * u[j][0] + v[2 * i + 1] * u[j][1]);
      }
    }
    h.push(m);
  }
  let best = Infinity;
  const feasible = (a: number, cx: number, cy: number) =>
    u.every(([ux, uy], j) => a + cx * ux + cy * uy >= h[j] - 1e-9);
  for (let i = 0; i < M; i++) {
    for (let j = i + 1; j < M; j++) {
      for (let k = j + 1; k < M; k++) {
        // solve a + c . u = h for the three constraints by Cramer's rule
        const m = [
          [1, u[i][0], u[i][1]],
          [1, u[j][0], u[j][1]],
          [1, u[k][0], u[k][1]],
        ];
        const r = [h[i], h[j], h[k]];
        const det3 = (q: number[][]) =>
          q[0][0] * (q[1][1] * q[2][2] - q[1][2] * q[2][1]) -
          q[0][1] * (q[1][0] * q[2][2] - q[1][2] * q[2][0]) +
          q[0][2] * (q[1][0] * q[2][1] - q[1][1] * q[2][0]);
        const d = det3(m);
        if (Math.abs(d) < 1e-9) continue;
        const col = (c: number) => m.map((row, n) => row.map((v, cc) => (cc === c ? r[n] : v)));
        const a = det3(col(0)) / d;
        if (a < best && feasible(a, det3(col(1)) / d, det3(col(2)) / d)) best = a;
      }
    }
  }
  if (M % 2 === 0) {
    // opposite edges: a is fixed, the centre slides along a line; accept if some centre is feasible
    for (let i = 0; i < M / 2; i++) {
      const j = i + M / 2;
      const a = (h[i] + h[j]) / 2;
      if (a >= best) continue;
      const b = h[i] - a;
      for (let t = -20; t <= 20; t += 0.001) {
        if (feasible(a, b * u[i][0] - t * u[i][1], b * u[i][1] + t * u[i][0])) {
          best = a;
          break;
        }
      }
    }
  }
  return best;
}

const posesArb = fc.array(poseArb(3), { minLength: 1, maxLength: 12 });
const phiArb = fc.double({ min: -4, max: 4, noNaN: true });

describe("enclosing polygon", () => {
  it("contains every piece and is tight", () => {
    fc.assert(
      fc.property(fc.constantFrom(0, 3, 4, 5, 7), posesArb, sidesArb, phiArb, (N, poses, M, phi) => {
        const c = enclose(N, poses, M, phi);
        const v = maxViolation(N, poses, c);
        expect(v).toBeLessThan(1e-9);
        // shrinking by 1e-9 about the same centre must push something outside
        const shrunk = { ...c, size: c.size - 1e-9 };
        expect(maxViolation(N, poses, shrunk)).toBeGreaterThan(0);
      }),
      { numRuns: 500 },
    );
  });

  it("matches a brute-force solution of the LP", () => {
    fc.assert(
      fc.property(fc.constantFrom(0, 3, 4, 6), posesArb, fc.integer({ min: 3, max: 8 }), phiArb, (N, poses, M, phi) => {
        const c = enclose(N, poses, M, phi);
        const apothem = c.size / (2 * Math.tan(Math.PI / M));
        expect(apothem).toBeCloseTo(bruteApothem(N, poses, M, phi), 6);
      }),
      { numRuns: 60 },
    );
  });
});

describe("enclosing circle", () => {
  it("contains every piece and is minimal", () => {
    fc.assert(
      fc.property(fc.constantFrom(0, 3, 4, 5), posesArb, (N, poses) => {
        const c = enclose(N, poses, 0, 0);
        expect(maxViolation(N, poses, c)).toBeLessThan(1e-9);
        expect(maxViolation(N, poses, { ...c, size: c.size - 2e-9 })).toBeGreaterThan(0);
        // a minimal circle cannot be improved by moving its centre
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const moved = { ...c, cx: c.cx + 1e-4 * dx, cy: c.cy + 1e-4 * dy };
          expect(maxViolation(N, poses, moved)).toBeGreaterThan(-1e-12);
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe("auto-orient", () => {
  it("is never worse than phi = 0 or the starting phi", () => {
    fc.assert(
      fc.property(fc.constantFrom(0, 3, 4, 5), posesArb, sidesArb, phiArb, (N, poses, M, phi0) => {
        const best = autoOrient(N, poses, M, phi0);
        expect(best.size).toBeLessThanOrEqual(enclose(N, poses, M, 0).size);
        expect(best.size).toBeLessThanOrEqual(enclose(N, poses, M, phi0).size + 1e-12);
        expect(maxViolation(N, poses, best)).toBeLessThan(1e-9);
      }),
      { numRuns: 100 },
    );
  });

  it("is close to a fine brute-force scan", () => {
    fc.assert(
      fc.property(fc.constantFrom(3, 4, 5), posesArb, fc.integer({ min: 3, max: 6 }), (N, poses, M) => {
        const best = autoOrient(N, poses, M);
        let scan = Infinity;
        for (let i = 0; i < 20000; i++) scan = Math.min(scan, enclose(N, poses, M, (i * 2 * Math.PI) / M / 20000).size);
        expect(best.size).toBeLessThanOrEqual(scan + 1e-9);
      }),
      { numRuns: 15 },
    );
  });
});

// Each known answer below is derived here from the construction [CALC]; the published values
// they reproduce are cited next to each test.
describe("known answers", () => {
  it("one piece in a container of the same shape has size 1", () => {
    for (const N of [3, 4, 5, 6, 7, 12]) {
      expect(autoOrient(N, [{ x: 0.3, y: -0.2, theta: 0.4 }], N).size).toBeCloseTo(1, 9);
    }
    expect(enclose(0, [{ x: 1, y: 2, theta: 0 }], 0, 0).size).toBeCloseTo(1, 12);
  });

  it("k^2 unit squares tile a square of side k", () => {
    for (const k of [1, 2, 3, 5]) {
      const pieces: Pose[] = [];
      for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) pieces.push({ x: i, y: j, theta: Math.PI / 4 });
      const e = evaluate({ N: 4, M: 4, P: k * k, pieces, container_phi: 0 });
      expect(e.valid).toBe(true);
      expect(e.score).toBeCloseTo(k, 9);
      expect(e.score!).toBeGreaterThanOrEqual(areaLowerBound(4, 4, k * k) - 1e-9);
    }
  });

  it("two unit-diameter disks in a circle: diameter 2", () => {
    const pieces = [{ x: -DISK_RADIUS, y: 0, theta: 0 }, { x: DISK_RADIUS, y: 0, theta: 0 }];
    const e = evaluate({ N: 0, M: 0, P: 2, pieces, container_phi: 0 });
    expect(e.valid).toBe(true);
    expect(e.score).toBeCloseTo(2, 12);
  });

  // [EST] Ellsworth (continuing Friedman), "Squares in Squares", n = 5:
  // s = 2 + sqrt(2)/2 = 2.70710678118654, "Proved by Frits Göbel in early 1979".
  // https://kingbird.myphotos.cc/packing/squares_in_squares.html (accessed 2026-10-07).
  it("five unit squares in a square: s = 2 + 1/sqrt(2)", () => {
    const s = 2 + Math.SQRT1_2;
    const d = s / 2 - 0.5;
    const pieces: Pose[] = [
      { x: 0, y: 0, theta: 0 }, // theta = 0 is the diamond orientation
      ...[[-d, -d], [d, -d], [-d, d], [d, d]].map(([x, y]) => ({ x, y, theta: Math.PI / 4 })),
    ];
    const e = evaluate({ N: 4, M: 4, P: 5, pieces, container_phi: 0 }, { autoOrient: true });
    expect(e.valid).toBe(true);
    expect(e.score).toBeCloseTo(s, 9);
  });
});

describe("evaluate and strict verification", () => {
  it("rejects overlaps and wrong counts with reasons", () => {
    const pieces = [{ x: 0, y: 0, theta: 0 }, { x: 0.5, y: 0, theta: 0 }];
    const e = evaluate({ N: 4, M: 4, P: 3, pieces, container_phi: 0 });
    expect(e.valid).toBe(false);
    expect(e.reasons).toHaveLength(2);
  });

  it("with stopWhenInvalid, returns the same verdict, reasons and overlaps, and leaves valid packings as they were", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(0, 3, 4, 6, 12, 60),
        fc.constantFrom(0, 3, 4, 7),
        fc.array(poseArb(3), { maxLength: 12 }),
        fc.integer({ min: -1, max: 1 }),
        fc.double({ min: -4, max: 4, noNaN: true }),
        (N, M, pieces, extra, phi) => {
          const config = { N, M, P: Math.max(1, pieces.length + extra), pieces, container_phi: phi };
          for (const opts of [{}, { autoOrient: true, maxOverlaps: 3 }]) {
            const full = evaluate(config, opts);
            const early = evaluate(config, { ...opts, stopWhenInvalid: true });
            expect(early.valid).toBe(full.valid);
            expect(early.reasons).toEqual(full.reasons);
            expect(early.overlaps).toEqual(full.overlaps);
            if (full.valid) expect(early).toEqual(full);
            else expect([early.container, early.score]).toEqual([null, null]);
          }
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("the area bound holds for valid packings", () => {
    const pieces = [{ x: 0, y: 0, theta: 0 }, { x: 3, y: 0.1, theta: 1 }, { x: 0.2, y: 3, theta: 2 }];
    for (const M of [0, 3, 4, 6]) {
      const e = evaluate({ N: 5, M, P: 3, pieces, container_phi: 0.3 }, { autoOrient: true });
      expect(e.valid).toBe(true);
      expect(containerArea(M, e.score!)).toBeGreaterThan(3 * pieceArea(5));
    }
  });

  it("shrink test certifies a touching packing and rejects a penetrating one", () => {
    const touching = [{ x: 0, y: 0, theta: Math.PI / 4 }, { x: 1, y: 0, theta: Math.PI / 4 }];
    const c = enclose(4, touching, 4, 0);
    const ok = strictVerify(4, touching, c);
    expect(ok.ok).toBe(true);
    expect(ok.certifiedSize).toBeCloseTo(2, 6);
    expect(ok.certifiedSize).toBeGreaterThan(2);
    const bad = [touching[0], { ...touching[1], x: 1 - 1e-6 }];
    expect(strictVerify(4, bad, enclose(4, bad, 4, 0)).ok).toBe(false);
  });
});
