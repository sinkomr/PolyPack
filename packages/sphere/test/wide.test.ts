import { describe, it, expect } from "vitest";
import { maxMarginPlane, validate, validateAsync } from "../src/validate";
import { placedVertices, cross, dot, norm, inradiusAngle, type Vec3, type Quat } from "../src/geometry";

// Independent exhaustive oracle: retain every triple, including ones outside hull facets.
function brute(A: Vec3[], B: Vec3[]) {
  const S = [...A, ...B.map((b) => b.map((v) => -v) as Vec3)];
  let best = -Infinity;
  const test = (n: Vec3) => {
    const l = norm(n);
    if (l > 1e-12) best = Math.max(best, Math.min(...S.map((s) => dot(n, s) / l)));
  };
  for (let i = 0; i < S.length; i++)
    for (let j = i + 1; j < S.length; j++) {
      test(S[i].map((x, k) => x + S[j][k]) as Vec3);
      for (let k = j + 1; k < S.length; k++) {
        const n = cross(S[j].map((x, r) => x - S[i][r]) as Vec3, S[k].map((x, r) => x - S[i][r]) as Vec3);
        test(n);
        test(n.map((x) => -x) as Vec3);
      }
    }
  return best;
}
const qy = (t: number): Quat => [Math.cos(t / 2), 0, Math.sin(t / 2), 0];
describe("many-sided spherical pieces", () => {
  it("agrees with exhaustive candidates for separated, overlapping and nearly hemispherical pairs", () => {
    for (const N of [12, 20])
      for (const rho of [(N / (2 * Math.PI)) * (1 + 1e-7), N])
        for (const t of [0, 0.1, 1, 2.9]) {
          const A = placedVertices(N, rho, [1, 0, 0, 0]);
          const B = placedVertices(N, rho, qy(t));
          expect(maxMarginPlane(A, B).value).toBeCloseTo(brute(A, B), 10);
        }
  });
  it("accepts a touching 100-gon and rejects a hair of overlap", () => {
    const N = 100,
      rho = 100,
      d = 2 * inradiusAngle(N, rho);
    // For N divisible by four, rotate by pi/N to put opposite edge normals on x.
    const spin: Quat = [Math.cos(Math.PI / N / 2), 0, 0, Math.sin(Math.PI / N / 2)];
    const mul = (p: Quat, q: Quat): Quat => [p[0] * q[0] - p[2] * q[2], p[2] * q[3], p[2] * q[0], p[0] * q[3]];
    const cfg = (gap: number) => ({ rho, pieces: [{ q: spin }, { q: mul(qy(d + gap / rho), spin) }] });
    expect(validate({ N, P: 2 }, cfg(0)).valid).toBe(true);
    expect(validate({ N, P: 2 }, cfg(-1e-6)).valid).toBe(false);
    expect(validate({ N, P: 2 }, cfg(1e-6)).valid).toBe(true);
  });
  it("slices the pair calculation itself, including coincident and nearly hemispherical 100-gons", async () => {
    for (const rho of [100, (100 / (2 * Math.PI)) * (1 + 1e-7)]) {
      const config = { rho, pieces: Array.from({ length: 100 }, () => ({ q: [1, 0, 0, 0] as Quat })) };
      const v = await validateAsync({ N: 100, P: 100 }, config, { maxErrors: 20, sliceMs: 2 });
      expect(v.valid).toBe(false);
      expect(v.slices).toBeGreaterThan(1);
      // Allow scheduler pauses on a shared machine; isolated slice measurements are reported separately.
      expect(v.longestSliceMs).toBeLessThan(150);
    }
  });
  it("rejects malformed lists and non-existent pieces", () => {
    for (const config of [
      null,
      { rho: 100, pieces: {} },
      { rho: 100, pieces: [null] },
      { rho: 1, pieces: [{ q: [1, 0, 0, 0] }] },
    ])
      expect(validate({ N: 100, P: 1 }, config as never).valid).toBe(false);
  });
});
