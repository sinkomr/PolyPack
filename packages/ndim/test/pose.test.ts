import { describe, expect, it } from "vitest";
import { MAX_CAYLEY, cayleyMatrix, cayleyOfMatrix, nParams, poseOfMatrix, readPose } from "../src";
import { det, matmul, transpose } from "../src/linalg";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const orthoError = (R: Float64Array, d: number): number => {
  const G = matmul(transpose(R, d), R, d);
  let e = 0;
  for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) e = Math.max(e, Math.abs(G[i * d + j] - (i === j ? 1 : 0)));
  return e;
};

describe("Cayley rotations", () => {
  it("are orthonormal with determinant 1 for every d, also with flips", () => {
    const rng = mulberry32(1);
    for (let d = 4; d <= 10; d++) {
      for (let t = 0; t < 5; t++) {
        const params = Array.from({ length: nParams(d) }, () => (rng() - 0.5) * 4);
        const flip = t === 0 ? 0 : 0b11 << ((t - 1) % (d - 1));
        const R = cayleyMatrix(params, d, flip);
        expect(orthoError(R, d)).toBeLessThan(1e-13);
        expect(det(R, d)).toBeCloseTo(1, 11);
      }
    }
  });
  it("gives the identity for zero parameters and a diagonal sign matrix for a flip", () => {
    const R = cayleyMatrix(new Array(nParams(5)).fill(0), 5, 0b00110);
    for (let i = 0; i < 5; i++)
      for (let j = 0; j < 5; j++) expect(R[i * 5 + j] + 0).toBe(i === j ? (i === 1 || i === 2 ? -1 : 1) : 0);
  });
  it("round-trips through the matrix, including half turns that need a flip", () => {
    const rng = mulberry32(2);
    for (let d = 4; d <= 10; d++) {
      for (let t = 0; t < 4; t++) {
        const params = Array.from({ length: nParams(d) }, () => (rng() - 0.5) * 3);
        const R = cayleyMatrix(params, d, 0);
        const back = cayleyOfMatrix(R, d);
        const R2 = cayleyMatrix(back.params, d, back.flip);
        for (let i = 0; i < d * d; i++) expect(Math.abs(R2[i] - R[i])).toBeLessThan(1e-9);
      }
      // a half turn in the plane of axes 0 and 1 (no Cayley form without a flip)
      const H = new Float64Array(d * d);
      for (let i = 0; i < d; i++) H[i * d + i] = i < 2 ? -1 : 1;
      const back = cayleyOfMatrix(H, d);
      expect(back.flip).toBe(0b11);
      expect(Math.max(...back.params.map(Math.abs))).toBeLessThan(1e-12);
    }
  });
  it("refuses reflections, non-orthonormal and non-finite matrices", () => {
    const d = 4;
    const I = new Float64Array(d * d);
    for (let i = 0; i < d; i++) I[i * d + i] = 1;
    const reflection = Float64Array.from(I);
    reflection[0] = -1;
    expect(() => cayleyOfMatrix(reflection, d)).toThrow(/reflection/);
    expect(() => poseOfMatrix(new Float64Array(d), reflection, d)).toThrow(/reflection/);
    const skewed = Float64Array.from(I);
    skewed[1] = 1e-6; // not orthonormal by 1e-6
    expect(() => cayleyOfMatrix(skewed, d)).toThrow(/orthonormal/);
    const scaled = Float64Array.from(I);
    scaled[0] = 1.001;
    expect(() => cayleyOfMatrix(scaled, d)).toThrow(/orthonormal/);
    const bad = Float64Array.from(I);
    bad[5] = NaN;
    expect(() => cayleyOfMatrix(bad, d)).toThrow(/finite/);
    expect(() => cayleyOfMatrix(new Float64Array(9), d)).toThrow(/finite d x d/);
    // an orthonormal matrix within 1e-10 is accepted
    const near = Float64Array.from(I);
    near[1] = 1e-10;
    expect(() => cayleyOfMatrix(near, d)).not.toThrow();
  });
  it("makes poses that read back", () => {
    const d = 6;
    const R = cayleyMatrix(
      Array.from({ length: nParams(d) }, (_, i) => 0.05 * i - 0.3),
      d,
      0,
    );
    const pose = poseOfMatrix([1, 2, 3, 4, 5, 6], R, d);
    expect(pose.length).toBe(d + nParams(d) + 1);
    const r = readPose(d, pose, false);
    expect(typeof r).toBe("object");
    if (typeof r === "object" && r.R)
      for (let i = 0; i < d * d; i++) expect(Math.abs(r.R[i] - R[i])).toBeLessThan(1e-9);
  });
});

describe("readPose", () => {
  const d = 4;
  const m = nParams(d);
  const good = [...new Array(d).fill(0.5), ...new Array(m).fill(0.1)];
  it("accepts a pose with and without a flip, and a ball's centre", () => {
    expect(typeof readPose(d, good, false)).toBe("object");
    expect(typeof readPose(d, [...good, 0b0101], false)).toBe("object");
    expect(typeof readPose(d, [1, 2, 3, 4], true)).toBe("object");
  });
  it("refuses malformed poses with a reason", () => {
    const msg = (p: unknown, ball = false) => {
      const r = readPose(d, p, ball);
      return typeof r === "string" ? r : "ok";
    };
    expect(msg("nope")).toMatch(/array/);
    expect(msg(null)).toMatch(/array/);
    expect(msg(good.slice(1))).toMatch(/numbers/);
    expect(msg([...good, 1, 1])).toMatch(/numbers/);
    expect(msg([1, 2, 3], true)).toMatch(/centre of a ball/);
    expect(msg(good.map((v, i) => (i === 2 ? NaN : v)))).toMatch(/finite/);
    expect(msg(good.map((v, i) => (i === 2 ? Infinity : v)))).toMatch(/finite/);
    expect(msg(good.map((v, i) => (i === 2 ? ("1" as unknown as number) : v)))).toMatch(/finite/);
    expect(msg(good.map((v, i) => (i === 1 ? 1e5 : v)))).toMatch(/centre coordinates/);
    expect(msg(good.map((v, i) => (i === 6 ? MAX_CAYLEY + 1 : v)))).toMatch(/Cayley/);
    expect(msg([...good, 0b0001])).toMatch(/even number/); // a reflection
    expect(msg([...good, 1.5])).toMatch(/integer/);
    expect(msg([...good, -2])).toMatch(/integer/);
    expect(msg([...good, 16])).toMatch(/integer/);
    expect(msg([...good, 0b0011])).toBe("ok");
  });
});
