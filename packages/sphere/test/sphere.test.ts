import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Quat,
  type SphereConfig,
  type Vec3,
  areaBound,
  centreOf,
  centreThetaFromQuat,
  circumradiusAngle,
  expFromQuat,
  inradiusAngle,
  maxMarginPlane,
  pieceArea,
  pieceExists,
  quatFromCentreTheta,
  quatFromExp,
  quatMul,
  quatToMatrix,
  rotate,
  standardVertices,
  validate,
} from "../src";

const root = join(__dirname, "../../..");
const recordsPath = join(root, "data/sphere/records.json");

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-300)) * Math.cos(2 * Math.PI * r());
const randUnit = (r: () => number): Vec3 => {
  const v: Vec3 = [gauss(r), gauss(r), gauss(r)];
  const n = Math.hypot(...v);
  return [v[0] / n, v[1] / n, v[2] / n];
};

const TILINGS: [number, number, number][] = [
  [3, 4, 1 / Math.acos(-1 / 3)],
  [3, 8, 2 / Math.PI],
  [3, 20, 1 / Math.atan(2)],
  [4, 6, 1 / Math.acos(1 / 3)],
  [5, 12, 1 / Math.acos(Math.sqrt(5) / 3)],
];

describe("piece geometry", () => {
  it("Platonic tilings meet the area bound exactly", () => {
    for (const [N, P, rho] of TILINGS) {
      expect(P * pieceArea(N, rho)).toBeCloseTo(4 * Math.PI * rho * rho, 10);
      expect(areaBound(N, P)).toBeCloseTo(rho, 10);
    }
  });
  it("vertex angles of the tilings are 2 pi / q", () => {
    // triangles at the tetrahedron: 3 around a vertex; squares at the cube: 3; pentagons: 3
    const angle = (N: number, rho: number) => {
      const a = 1 / rho;
      return 2 * Math.asin(Math.cos(Math.PI / N) / Math.cos(a / 2));
    };
    expect(angle(3, TILINGS[0][2])).toBeCloseTo((2 * Math.PI) / 3, 12);
    expect(angle(3, TILINGS[1][2])).toBeCloseTo(Math.PI / 2, 12);
    expect(angle(3, TILINGS[2][2])).toBeCloseTo((2 * Math.PI) / 5, 12);
    expect(angle(4, TILINGS[3][2])).toBeCloseTo((2 * Math.PI) / 3, 12);
    expect(angle(5, TILINGS[4][2])).toBeCloseTo((2 * Math.PI) / 3, 12);
  });
  it("existence limit rho > N / (2 pi) and inradius < circumradius", () => {
    for (const N of [3, 4, 5, 6, 8]) {
      expect(pieceExists(N, (N / (2 * Math.PI)) * (1 + 1e-9))).toBe(true);
      expect(pieceExists(N, (N / (2 * Math.PI)) * (1 - 1e-9))).toBe(false);
      const rho = N / Math.PI;
      expect(inradiusAngle(N, rho)).toBeLessThan(circumradiusAngle(N, rho));
    }
    expect(pieceExists(3, 1 / (2 * Math.PI - 0.1))).toBe(false); // small sin(a/2) but a > pi
    expect(pieceExists(3, 1 / Math.sqrt(20))).toBe(false); // K = 20: perimeter 3 > 2 pi rho (curved-package regression)
    expect(validate({ N: 3, P: 1 }, { rho: 1 / Math.sqrt(20), pieces: [{ q: [1, 0, 0, 0] }] }).valid).toBe(false);
    expect(pieceExists(0, 1.01 / Math.PI)).toBe(true);
    expect(pieceExists(0, 0.99 / Math.PI)).toBe(false);
  });
  it("side of the standard piece is 1/rho on the unit sphere", () => {
    for (const N of [3, 4, 5, 6, 8]) {
      const rho = 1.7;
      const V = standardVertices(N, circumradiusAngle(N, rho));
      const d = Math.acos(V[0][0] * V[1][0] + V[0][1] * V[1][1] + V[0][2] * V[1][2]);
      expect(d).toBeCloseTo(1 / rho, 13);
      expect(V[0][0]).toBeCloseTo(0, 15); // vertex 0 straight up (+y)
      expect(V[0][1]).toBeGreaterThan(0);
    }
  });
});

describe("poses", () => {
  it("rotation matrix of a non-unit quaternion is orthogonal", () => {
    const M = quatToMatrix([0.3, -1.2, 2.5, 0.7]);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        const d = M[i][0] * M[j][0] + M[i][1] * M[j][1] + M[i][2] * M[j][2];
        expect(d).toBeCloseTo(i === j ? 1 : 0, 14);
      }
  });
  it("centre/theta and exponential coordinates round-trip", () => {
    const r = rng(7);
    for (let t = 0; t < 200; t++) {
      const c = randUnit(r);
      if (c[2] < -0.999) continue;
      const th = (r() - 0.5) * 2 * Math.PI;
      const q = quatFromCentreTheta(c, th);
      const back = centreThetaFromQuat(q);
      for (let k = 0; k < 3; k++) expect(back.centre[k]).toBeCloseTo(c[k], 12);
      expect(Math.cos(back.theta - th)).toBeCloseTo(1, 12);
      const rho = 0.5 + 2 * r();
      const e = expFromQuat(q, rho);
      const q2 = quatFromExp(e.x, e.y, e.theta, rho);
      const s = Math.sign(q[0] * q2[0] + q[1] * q2[1] + q[2] * q2[2] + q[3] * q2[3]);
      for (let k = 0; k < 4; k++) expect(s * q2[k]).toBeCloseTo(q[k], 11);
    }
  });
  it("theta rotates the piece about its centre (vertex up at theta = 0)", () => {
    const q = quatFromExp(0, 0, Math.PI / 2, 1);
    const v = rotate(q, [0, 1, 0]);
    expect(v[0]).toBeCloseTo(-1, 14); // +y rotated counterclockwise by 90 degrees about e3
    expect(centreOf(q)[2]).toBeCloseTo(1, 15);
  });
});

describe("max-margin plane (chart-free pair test)", () => {
  it("is never beaten by random normals and is symmetric", () => {
    const r = rng(11);
    for (let t = 0; t < 60; t++) {
      const N = 3 + (t % 4);
      const A = Array.from({ length: N }, () => randUnit(r));
      const B = Array.from({ length: N }, () => randUnit(r));
      const mm = maxMarginPlane(A, B);
      const mm2 = maxMarginPlane(B, A);
      expect(mm.value).toBeCloseTo(mm2.value, 12);
      let best = -Infinity;
      for (let k = 0; k < 20000; k++) {
        const n = randUnit(r);
        let lo = Infinity;
        for (const a of A) lo = Math.min(lo, n[0] * a[0] + n[1] * a[1] + n[2] * a[2]);
        for (const b of B) lo = Math.min(lo, -(n[0] * b[0] + n[1] * b[1] + n[2] * b[2]));
        best = Math.max(best, lo);
      }
      expect(best).toBeLessThanOrEqual(mm.value + 1e-12);
      expect(best).toBeGreaterThan(mm.value - 0.1);
    }
  });

  it("separates two near-hemisphere triangles whose union lies in no hemisphere", () => {
    // R = pi/2 - e: piece 0 at the north pole, piece 1 at the south pole turned by 60 degrees, so the
    // six vertices alternate north/south around the equator (no open hemisphere contains them all).
    const e = 1e-3;
    const N = 3;
    const a = 2 * Math.asin(Math.sin(Math.PI / 2 - e) * Math.sin(Math.PI / N));
    const rho = 1 / a;
    const q0: Quat = [1, 0, 0, 0];
    const flip: Quat = [0, 1, 0, 0];
    const q1 = quatMul(flip, [Math.cos(Math.PI / 6), 0, 0, Math.sin(Math.PI / 6)]);
    const cfg = (q: Quat): SphereConfig => ({ rho, pieces: [{ q: q0 }, { q }] });
    const res = validate({ N, P: 2 }, cfg(q1));
    expect(res.strictlyValid).toBe(true);
    // tilt piece 1 about the x axis: by 1.5 e still separated (by a tilted plane), by 5 e overlapping
    const tilt = (ang: number) => quatMul([Math.cos(ang / 2), Math.sin(ang / 2), 0, 0], q1);
    expect(validate({ N, P: 2 }, cfg(tilt(1.5 * e))).strictlyValid).toBe(true);
    expect(validate({ N, P: 2 }, cfg(tilt(5 * e))).valid).toBe(false);
  });
});

describe("float validator limits near the existence limit (documentation, not authoritative)", () => {
  it("antipodal pieces just above N/(2 pi): circumradius ~ pi/2 - sqrt(eps), gaps of that order", () => {
    for (const N of [3, 4, 5, 6, 8]) {
      for (const eps of [1e-6, 1e-9, 1e-12]) {
        const rho = (N / (2 * Math.PI)) * (1 + eps);
        const R = circumradiusAngle(N, rho);
        // pi/2 - R behaves like sqrt(2 eps (pi/N) cot(pi/N)): small, so the float asin loses digits
        const predicted = Math.sqrt(2 * eps * (Math.PI / N) / Math.tan(Math.PI / N));
        expect(Math.abs(Math.PI / 2 - R - predicted) / predicted).toBeLessThan(eps >= 1e-9 ? 1e-3 : 0.05);
        const res = validate({ N, P: 2 }, { rho, pieces: [{ q: [1, 0, 0, 0] }, { q: [0, 1, 0, 0] }] });
        expect(res.valid).toBe(true); // the decision with the 1e-9 tolerance is safe here
        // antipodal centres take the far-pair branch: gap = rho (pi - 2R) ~ 2 rho (pi/2 - R), and pi/2 - R
        // carries an absolute float error of about 1e-16/(pi/2 - R): correct to a few digits only
        expect(Math.abs(res.minGap / (2 * rho * predicted) - 1)).toBeLessThan(0.05);
      }
    }
  });
});

describe("validator input checks", () => {
  const good: SphereConfig = { rho: 1, pieces: [{ q: [1, 0, 0, 0] }, { q: [0, 1, 0, 0] }] };
  it("rejects wrong P, NaN, zero quaternions and non-existent pieces", () => {
    expect(validate({ N: 4, P: 2 }, good).strictlyValid).toBe(true);
    expect(validate({ N: 4, P: 3 }, good).valid).toBe(false);
    expect(validate({ N: 4, P: 2 }, { rho: NaN, pieces: good.pieces }).valid).toBe(false);
    expect(validate({ N: 4, P: 2 }, { rho: Infinity, pieces: good.pieces }).valid).toBe(false);
    expect(validate({ N: 4, P: 2 }, { rho: 1, pieces: [{ q: [1, 0, 0, 0] }, { q: [0, 0, 0, 0] }] }).valid).toBe(false);
    expect(validate({ N: 4, P: 2 }, { rho: 1, pieces: [{ q: [1, 0, 0, 0] }, { q: [NaN, 1, 0, 0] }] }).valid).toBe(false);
    expect(validate({ N: 6, P: 2 }, { rho: 0.95, pieces: good.pieces }).valid).toBe(false); // 6/(2 pi) = 0.9549
    expect(validate({ N: 7, P: 2 }, good).valid).toBe(false); // outside the supported set {0, 3, 4, 5, 6, 8}
    expect(validate({ N: 0, P: 2 }, { rho: 0.6, pieces: good.pieces }).valid).toBe(false); // caps beyond a hemisphere
  });
  it("disks: overlap by 1e-6 rejected, gap accepted", () => {
    const rho = 2;
    const ang = 2 / rho;
    const mk = (d: number): SphereConfig => ({ rho, pieces: [{ q: [1, 0, 0, 0] }, { q: quatFromCentreTheta([Math.sin(d), 0, Math.cos(d)], 0) }] });
    expect(validate({ N: 0, P: 2 }, mk(ang * (1 + 1e-6))).strictlyValid).toBe(true);
    expect(validate({ N: 0, P: 2 }, mk(ang * (1 - 1e-6))).valid).toBe(false);
  });
});

describe("stored records (data/sphere/records.json)", () => {
  const have = existsSync(recordsPath);
  it.runIf(have)("every record is strictly valid at score_cert and overlaps when slightly smaller", () => {
    const data = JSON.parse(readFileSync(recordsPath, "utf8"));
    expect(data.records.length).toBeGreaterThan(0);
    for (const r of data.records) {
      const cfg: SphereConfig = { rho: r.score_cert, pieces: r.config.pieces };
      const res = validate({ N: r.N, P: r.P }, cfg);
      expect(res.errors, r.id).toEqual([]);
      expect(res.strictlyValid, r.id).toBe(true);
      expect(r.score_cert).toBeGreaterThanOrEqual(r.score_float);
      expect((r.score_cert - r.score_float) / r.score_float).toBeLessThanOrEqual(1.0000001e-8);
      // display is score_cert rounded up at 6 decimals
      expect(Number(r.display)).toBeGreaterThanOrEqual(r.score_cert);
      expect(Number(r.display) - r.score_cert).toBeLessThan(1.0000001e-6);
      // tightness: 1e-6 smaller and the stored poses overlap (or the piece no longer exists)
      const tight = validate({ N: r.N, P: r.P }, { rho: r.score_float * (1 - 1e-6), pieces: r.config.pieces });
      expect(tight.valid, r.id).toBe(false);
      if (r.bound) expect(r.score_float).toBeGreaterThanOrEqual(r.bound.value * (1 - 1e-12));
    }
  });
  it.runIf(have)("exact cases: Platonic tilings and P = 2", () => {
    const data = JSON.parse(readFileSync(recordsPath, "utf8"));
    const by = new Map<string, any>(data.records.map((r: any) => [r.id, r]));
    for (const [N, P, rho] of TILINGS) {
      const r = by.get(`sphere/${N}/${P}`);
      expect(r, `sphere/${N}/${P}`).toBeTruthy();
      expect(Math.abs(r.score_float - rho) / rho).toBeLessThan(1e-11);
    }
    for (const N of [3, 4, 5, 6]) expect(by.get(`sphere/${N}/2`).score_float).toBeCloseTo(N / (2 * Math.PI), 14);
    expect(by.get("sphere/0/2").score_float).toBeCloseTo(2 / Math.PI, 14);
  });
  it.runIf(have)("a cube-tiling square rotated by 1e-6 overlaps", () => {
    const data = JSON.parse(readFileSync(recordsPath, "utf8"));
    const r = data.records.find((x: any) => x.id === "sphere/4/6");
    const pieces = r.config.pieces.map((p: any) => ({ q: p.q as Quat }));
    const d = 1e-6;
    pieces[1] = { q: quatMul(pieces[1].q, [Math.cos(d / 2), 0, 0, Math.sin(d / 2)]) };
    expect(validate({ N: 4, P: 6 }, { rho: r.score_float, pieces }).valid).toBe(false);
  });
});
