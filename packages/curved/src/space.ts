/**
 * Points, lines and isometries of the plane of constant curvature K, in a representation that
 * is exact in form for every K and well conditioned for small |K|.
 *
 * Homogeneous model. Points are vectors v = (v0, v1, v2) with Q_K(v) = v0^2 + K (v1^2 + v2^2) = 1
 * and v0 > 0 (for K > 0 this is the open hemisphere centred at the origin O = (1, 0, 0)). For K = -1
 * this is the hyperboloid, for K = +1 the unit sphere. The chart p = (v1, v2) / v0 is the
 * Beltrami-Klein model (K < 0), the gnomonic projection (K > 0) or the identity (K = 0); geodesics are
 * straight lines in it, and its differential at O is the identity.
 *
 * Lifted coordinates. We store a point as (e, x, y) with v = (1 - K e, x, y). For a point at
 * distance D from O, e = vs_K(D) = (1 - cs_K(D)) / K (= D^2/2 at K = 0), so e never needs a division by K.
 *
 * Lines are covectors n with n . v = 0. A line at signed distance h from O with outward unit normal
 * direction u is n = (-sn_K(h), cs_K(h) u); it has Qd(n) = |n_vec|^2 + K n0^2 = 1 and then
 * n . v = sn_K(signed distance of v from the line) for a normalised point v.
 *
 * Isometries act linearly on v, hence affinely on lifted coordinates: p' = L p + b.
 */
import { Sfun, Ufun, Vfun, asnK, csK, distFromVs, snK } from "./kfun";

export interface LPoint {
  e: number;
  x: number;
  y: number;
}

/** Affine action on lifted coordinates (e, x, y): p' = L p + b; L row-major 3x3. */
export interface Motion {
  K: number;
  L: Float64Array;
  b: Float64Array;
}

export const ORIGIN: LPoint = { e: 0, x: 0, y: 0 };

/**
 * Transvection T(w) along the geodesic from O through the point exp_O(w), w = (x, y), moving O to
 * the point at distance |w| in direction w. Entire in (x, y, K):
 *   b = (D^2 V, S x, S y),  L = [[1 - K D^2 V, S x, S y], [-K S x, 1 - K V x^2, -K V x y], [-K S y, -K V x y, 1 - K V y^2]]
 * with D^2 = x^2 + y^2, S = S(K D^2), V = V(K D^2).
 */
export function transvection(K: number, x: number, y: number): Motion {
  const D2 = x * x + y * y;
  const t = K * D2;
  const S = Sfun(t);
  const V = Vfun(t);
  const L = new Float64Array([
    1 - K * D2 * V,
    S * x,
    S * y,
    -K * S * x,
    1 - K * V * x * x,
    -K * V * x * y,
    -K * S * y,
    -K * V * x * y,
    1 - K * V * y * y,
  ]);
  return { K, L, b: new Float64Array([D2 * V, S * x, S * y]) };
}

export function rotation(K: number, theta: number): Motion {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return { K, L: new Float64Array([1, 0, 0, 0, c, -s, 0, s, c]), b: new Float64Array(3) };
}

/** a o b (apply b first). */
export function compose(a: Motion, b: Motion): Motion {
  const L = new Float64Array(9);
  const A = a.L;
  const B = b.L;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) L[3 * i + j] = A[3 * i] * B[j] + A[3 * i + 1] * B[3 + j] + A[3 * i + 2] * B[6 + j];
  const v = new Float64Array(3);
  for (let i = 0; i < 3; i++) v[i] = A[3 * i] * b.b[0] + A[3 * i + 1] * b.b[1] + A[3 * i + 2] * b.b[2] + a.b[i];
  return { K: a.K, L, b: v };
}

/** Pose motion G = T(x, y) R(theta): the piece frame of a pose. */
export function poseMotion(K: number, x: number, y: number, theta: number): Motion {
  return compose(transvection(K, x, y), rotation(K, theta));
}

/** G^{-1} = R(-theta) T(-x, -y). */
export function poseMotionInverse(K: number, x: number, y: number, theta: number): Motion {
  return compose(rotation(K, -theta), transvection(K, -x, -y));
}

export function applyPoint(m: Motion, p: LPoint): LPoint {
  const L = m.L;
  return {
    e: L[0] * p.e + L[1] * p.x + L[2] * p.y + m.b[0],
    x: L[3] * p.e + L[4] * p.x + L[5] * p.y + m.b[1],
    y: L[6] * p.e + L[7] * p.x + L[8] * p.y + m.b[2],
  };
}

/** Tangent (velocity) vectors in lifted coordinates transform by the linear part. */
export function applyTangent(m: Motion, d: LPoint): LPoint {
  const L = m.L;
  return {
    e: L[0] * d.e + L[1] * d.x + L[2] * d.y,
    x: L[3] * d.e + L[4] * d.x + L[5] * d.y,
    y: L[6] * d.e + L[7] * d.x + L[8] * d.y,
  };
}

/** Lifted point at polar position (distance r from O, direction a), via sn and vs. */
export function polarPoint(K: number, r: number, a: number): LPoint {
  const s = snK(K, r);
  const t = K * r * r;
  return { e: r * r * Vfun(t), x: s * Math.cos(a), y: s * Math.sin(a) };
}

/** Exponential map at O: the point at distance |w| in direction w. */
export function expO(K: number, x: number, y: number): LPoint {
  const D2 = x * x + y * y;
  const t = K * D2;
  const S = Sfun(t);
  return { e: D2 * Vfun(t), x: S * x, y: S * y };
}

/** Homogeneous v0 = 1 - K e. */
export function v0(K: number, p: LPoint): number {
  return 1 - K * p.e;
}

/** Versine vs_K of the distance between two normalised lifted points: (|dx|^2 + K de^2) / 2. */
export function pairVs(K: number, p: LPoint, q: LPoint): number {
  const dx = p.x - q.x;
  const dy = p.y - q.y;
  const de = p.e - q.e;
  return (dx * dx + dy * dy + K * de * de) / 2;
}

export function distance(K: number, p: LPoint, q: LPoint): number {
  return distFromVs(K, pairVs(K, p, q));
}

/** Distance from O (e = vs_K(D)). */
export function distanceFromO(K: number, p: LPoint): number {
  return distFromVs(K, p.e);
}

/** Inverse of expO: exponential coordinates (x, y) of a lifted point (for K > 0 within the open hemisphere). */
export function logO(K: number, p: LPoint): { x: number; y: number } {
  const D = distanceFromO(K, p);
  const s = Math.hypot(p.x, p.y);
  if (s === 0) return { x: 0, y: 0 };
  return { x: (D * p.x) / s, y: (D * p.y) / s };
}

/** Covector of the line at signed distance h from O with outward normal angle a (Qd = 1). */
export function lineCovector(K: number, h: number, a: number): [number, number, number] {
  const c = csK(K, h);
  return [-snK(K, h), c * Math.cos(a), c * Math.sin(a)];
}

/** n . v for lifted p: sn_K(signed distance) when n is normalised (Qd = 1) and p normalised. */
export function lineValue(K: number, n: ArrayLike<number>, p: LPoint): number {
  return n[0] * (1 - K * p.e) + n[1] * p.x + n[2] * p.y;
}

/** n . dv for a lifted tangent d (dv0 = -K de). */
export function lineTangent(K: number, n: ArrayLike<number>, d: LPoint): number {
  return -K * n[0] * d.e + n[1] * d.x + n[2] * d.y;
}

/** Signed distance from the normalised line n (positive on the side n . v > 0). */
export function signedDistance(K: number, n: ArrayLike<number>, p: LPoint): number {
  return asnK(K, lineValue(K, n, p));
}

/** Homogeneous cross product a x b of two lifted points: the covector of the line through them. */
export function lineThrough(K: number, a: LPoint, b: LPoint): [number, number, number] {
  const a0 = 1 - K * a.e;
  const b0 = 1 - K * b.e;
  return [a.x * b.y - a.y * b.x, a.y * b0 - a0 * b.y, a0 * b.x - a.x * b0];
}

/** Qd(n) = |n_vec|^2 + K n0^2 (invariant under isometries for covectors). */
export function covectorNorm2(K: number, n: ArrayLike<number>): number {
  return n[1] * n[1] + n[2] * n[2] + K * n[0] * n[0];
}

/** Chart (Klein / gnomonic) coordinates p = v_vec / v0. */
export function chart(K: number, p: LPoint): { x: number; y: number } {
  const w = 1 - K * p.e;
  return { x: p.x / w, y: p.y / w };
}

/** Poincare-disk-type conformal coordinates scaled to match at O: v_vec / ((1 + v0)/2). */
export function conformal(K: number, p: LPoint): { x: number; y: number } {
  const w = (2 - K * p.e) / 2;
  return { x: p.x / w, y: p.y / w };
}

/**
 * Infinitesimal generators of the isometry group acting on a lifted point, giving lifted tangent
 * vectors: translations along x and y at O (P_x, P_y) and the rotation J about O.
 *   P_x p = (x, 1 - K e, 0),  P_y p = (y, 0, 1 - K e),  J p = (0, -y, x).
 */
export function generator(K: number, a: 0 | 1 | 2, p: LPoint): LPoint {
  if (a === 0) return { e: p.x, x: 1 - K * p.e, y: 0 };
  if (a === 1) return { e: p.y, x: 0, y: 1 - K * p.e };
  return { e: 0, x: -p.y, y: p.x };
}

/**
 * Chain rule from body-frame velocities (dx_b, dy_b, dtheta_b), defined by dG = G (dx_b P_x + dy_b P_y + dtheta_b J),
 * to the pose coordinates (x, y, theta) of G = T(x, y) R(theta):
 *   body translation = R(-theta) A dw,  A = S I + K U w w^T,
 *   body rotation    = dtheta - K V (x dy - y dx),
 * with S, U, V evaluated at K |w|^2. Returns the 3x3 matrix Jb (row-major) with body = Jb . (dx, dy, dtheta).
 */
export function bodyJacobian(K: number, x: number, y: number, theta: number): Float64Array {
  const t = K * (x * x + y * y);
  const S = Sfun(t);
  const U = Ufun(t);
  const V = Vfun(t);
  const a00 = S + K * U * x * x;
  const a01 = K * U * x * y;
  const a11 = S + K * U * y * y;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  // R(-theta) = [[c, s], [-s, c]]
  return new Float64Array([
    c * a00 + s * a01,
    c * a01 + s * a11,
    0,
    -s * a00 + c * a01,
    -s * a01 + c * a11,
    0,
    K * V * y,
    -K * V * x,
    1,
  ]);
}
