import { describe, expect, it } from "vitest";
import { asnK, polishAt, snK, type CurvedPose } from "../src/index";
import {
  configKey,
  contactKeys,
  densityOf,
  familyLabel,
  feasibleAt,
  followBranch,
  poseDistance,
  rootBisect,
  sameConfig,
  symmetryLabel,
  tryPolish,
  makePoint,
  pieceExistsStrict,
} from "../src/sweep";

/** Ring of P unit disks touching their neighbours at curvature K (radius r0 of the centres). */
function ringRadius(K: number, P: number): number {
  return asnK(K, snK(K, 1) / Math.sin(Math.PI / P));
}
function ring(K: number, P: number, phase = 0): CurvedPose[] {
  const r0 = ringRadius(K, P);
  return Array.from({ length: P }, (_, k) => {
    const a = phase + (2 * Math.PI * k) / P;
    return { x: r0 * Math.cos(a), y: r0 * Math.sin(a), theta: 0 };
  });
}
function sixPlusOne(K: number): CurvedPose[] {
  const r0 = Math.max(2, ringRadius(K, 6));
  return [{ x: 0, y: 0, theta: 0 }, ...Array.from({ length: 6 }, (_, k) => ({ x: r0 * Math.cos((Math.PI * k) / 3), y: r0 * Math.sin((Math.PI * k) / 3), theta: 0 }))];
}

describe("sweep helpers", () => {
  it("symmetry, shell labels and density", () => {
    const K = -0.5;
    expect(symmetryLabel({ N: 0, M: 0, P: 5 }, K, ring(K, 5, 0.3))).toBe("D5");
    expect(symmetryLabel({ N: 0, M: 0, P: 7 }, K, sixPlusOne(K))).toBe("D6");
    expect(familyLabel(K, sixPlusOne(K))).toBe("6+1");
    const skew: CurvedPose[] = [
      { x: 0.3, y: 0.1, theta: 0 },
      { x: -1.9, y: 0.7, theta: 0 },
      { x: 1.2, y: -2.1, theta: 0 },
    ];
    expect(symmetryLabel({ N: 0, M: 0, P: 3 }, K, skew)).toBe("C1");
    // 2 x 2 unit squares fill the square of side 2 at K = 0: D4, density 1
    const sq: CurvedPose[] = [
      { x: -0.5, y: -0.5, theta: 0 },
      { x: 0.5, y: -0.5, theta: 0 },
      { x: -0.5, y: 0.5, theta: 0 },
      { x: 0.5, y: 0.5, theta: 0 },
    ];
    expect(symmetryLabel({ N: 4, M: 4, P: 4 }, 0, sq)).toBe("D4");
    expect(densityOf({ N: 4, M: 4, P: 4 }, 0, 2)).toBeCloseTo(1, 12);
    // a rattler is ignored by the symmetry test
    const withRattler = [...ring(K, 5), { x: 0.123, y: -0.05, theta: 0 }];
    expect(symmetryLabel({ N: 0, M: 0, P: 6 }, K, withRattler, [5])).toBe("D5");
    expect(symmetryLabel({ N: 0, M: 0, P: 6 }, K, withRattler)).toBe("C1");
  });

  it("pose distance respects the piece's own rotation symmetry", () => {
    const a: CurvedPose[] = [{ x: 0, y: 0, theta: 0.1 }];
    const b: CurvedPose[] = [{ x: 0, y: 0, theta: 0.1 + (2 * Math.PI) / 3 }];
    expect(poseDistance({ N: 3, M: 3, P: 1 }, a, b)).toBeLessThan(1e-12);
    expect(poseDistance({ N: 4, M: 4, P: 1 }, a, b)).toBeGreaterThan(0.5);
  });

  it("contact keys and configuration identity", () => {
    const K = -0.25;
    const prob = { N: 0, M: 0, P: 4 };
    const pc = polishAt(prob, K, { size: 1 + ringRadius(K, 4) + 1e-6, pieces: ring(K, 4) });
    const keys = contactKeys(pc.polish.active, 0);
    // 4 neighbour contacts and 4 rim contacts
    expect(keys.filter((k) => k.startsWith("p:")).length).toBe(4);
    expect(keys.filter((k) => k.startsWith("r:")).length).toBe(4);
    const p = makePoint(prob, K, pc, true);
    const q = makePoint(prob, K, polishAt(prob, K, { size: pc.config.size, pieces: ring(K, 4, 1.0) }), true);
    expect(sameConfig(p, q)).toBe(true);
    expect(configKey(p)).toBe(configKey(q));
  });
});

describe("piece existence", () => {
  it("polygons at K > 0 need sqrt(K) < 2 pi / N (perimeter below a great circle)", () => {
    expect(pieceExistsStrict(3, 4)).toBe(true);
    expect(pieceExistsStrict(3, (2 * Math.PI / 3) ** 2 * 1.0001)).toBe(false);
    // the weaker engine test is met again far beyond the limit (e.g. K = 17.6 for triangles); the strict one is not
    expect(pieceExistsStrict(3, 17.6)).toBe(false);
    expect(pieceExistsStrict(4, 2.4)).toBe(true);
    expect(pieceExistsStrict(4, 2.5)).toBe(false);
    expect(pieceExistsStrict(0, 2.4)).toBe(true);
    expect(pieceExistsStrict(3, -50)).toBe(true);
    expect(tryPolish({ N: 3, M: 3, P: 1 }, 17.6, { size: 0.5, pieces: [{ x: 0, y: 0, theta: 0 }] })).toBeUndefined();
  });
});

describe("followBranch", () => {
  it("tracks the 3-ring to the closed form R = 1 + r0(K) and stops at the hemisphere", () => {
    const prob = { N: 0, M: 0, P: 3 };
    const start = tryPolish(prob, 0, { size: 1 + ringRadius(0, 3) + 1e-9, pieces: ring(0, 3) });
    expect(start && feasibleAt(prob, 0, start)).toBe(true);
    const down = followBranch(prob, 0, start!, -0.5, { grid: 1 / 16 });
    expect(down.end.kind).toBe("range");
    for (const p of down.points) expect(Math.abs(p.size - (1 + ringRadius(p.K, 3)))).toBeLessThan(1e-9);
    // grid points are exact multiples of 1/16
    expect(down.points.every((p) => Number.isInteger(p.K * 16))).toBe(true);
    // 3 disks: the ring radius plus 1 reaches the hemisphere radius pi/(2 sqrt K) somewhere below K = 0.6
    const up = followBranch(prob, 0, start!, 1, { grid: 1 / 16 });
    expect(up.end.kind).toBe("hemisphere");
    const last = up.points[up.points.length - 1];
    expect(Math.abs(last.size - Math.PI / (2 * Math.sqrt(last.K)))).toBeLessThan(1e-3);
  });

  it("locates the first-order transition of 7 disks (7-ring vs 6+1) at cosh sqrt(-K) = 1/(2 sin(pi/7))", () => {
    const prob = { N: 0, M: 0, P: 7 };
    const K0 = -0.5;
    const r7 = tryPolish(prob, K0, { size: 1 + ringRadius(K0, 7) + 1e-9, pieces: ring(K0, 7) })!;
    const s61 = tryPolish(prob, K0, { size: 3 + 1e-9, pieces: sixPlusOne(K0) })!;
    expect(r7.config.size).toBeLessThan(s61.config.size);
    const a = followBranch(prob, K0, r7, -0.125, { grid: 1 / 32 });
    const b = followBranch(prob, K0, s61, -0.125, { grid: 1 / 32 });
    expect(a.end.kind).toBe("range");
    expect(b.end.kind).toBe("range");
    // the 6+1 branch is flat (s = 3) for K <= 0: ring disks touch the centre and the rim, not each other
    for (const p of b.points) expect(Math.abs(p.size - 3)).toBeLessThan(1e-9);
    const near = (pts: typeof a.points, K: number) => pts.reduce((x, y) => (Math.abs(y.K - K) < Math.abs(x.K - K) ? y : x));
    const f = (K: number) => {
      const pa = tryPolish(prob, K, { size: near(a.points, K).size, pieces: near(a.points, K).pieces })!;
      const pb = tryPolish(prob, K, { size: near(b.points, K).size, pieces: near(b.points, K).pieces })!;
      return pa.config.size - pb.config.size;
    };
    const Kc = rootBisect(f, -0.5, -0.125, 1e-12);
    const exact = -(Math.acosh(1 / (2 * Math.sin(Math.PI / 7))) ** 2);
    expect(Math.abs(Kc - exact)).toBeLessThan(1e-7);
  }, 30000);
});
