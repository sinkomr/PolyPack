/**
 * Whole-sphere geometry for PolyPack sphere/N/P problems (no container).
 *
 * Problem: P congruent pieces on a sphere of radius rho: disks of geodesic radius 1 (N = 0) or
 * regular spherical N-gons of geodesic side 1 (N >= 3). Score rho (smaller is better), K = 1/rho^2.
 *
 * All computation is done on the UNIT sphere, where a piece has angular size a = 1/rho (polygon
 * side angle, disk angular radius).
 *
 * Coordinates: R^3 with O = e3 = (0, 0, 1) (north pole); the tangent frame at O is x = e1, y = e2.
 * The curved package's homogeneous point (v0, v1, v2) at K = 1 is (Z, X, Y) here.
 *
 * Standard piece: centre O, vertex k at (sin R cos phi_k, sin R sin phi_k, cos R),
 * phi_k = pi/2 + 2 pi k/N (vertex 0 straight up, +y), angular circumradius R with
 * sin(a/2) = sin R sin(pi/N). A convex regular N-gon needs R < pi/2, i.e. a < 2 pi/N (rho > N/(2 pi)).
 *
 * Pose: a quaternion q = [w, x, y, z] (any nonzero q; the rotation of q/|q|, v -> q v q*). The piece
 * is G(standard piece). Gauge used by the search: piece 0 has q = [1, 0, 0, 0].
 * Relation to the curved package's pose (x, y, theta): G = T(c) R_z(theta), with c = G e3 the
 * centre, T(c) the rotation about e3 x c by the angle d(O, c) (transvection along the geodesic Oc),
 * R_z(theta) the rotation about e3 by theta; exponential coordinates (x, y) = rho d (c_x, c_y)/|(c_x, c_y)|
 * on the sphere of radius rho. This decomposition is singular only at c = -e3 (the south pole).
 */

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export interface SphereProblem {
  N: number;
  P: number;
}

export interface SpherePiece {
  q: Quat;
}

export interface SphereConfig {
  rho: number;
  pieces: SpherePiece[];
}

export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const unit = (a: Vec3): Vec3 => scale(a, 1 / norm(a));

/** Angular size of a piece on the unit sphere. */
export function pieceAngle(rho: number): number {
  return 1 / rho;
}

/** Does the piece exist as a convex regular N-gon (or a proper cap) at sphere radius rho? */
export function pieceExists(N: number, rho: number): boolean {
  if (!(rho > 0) || !Number.isFinite(rho)) return false;
  const a = 1 / rho;
  if (N === 0) return a < Math.PI; // as the certifier: a cap of angular radius pi is the whole sphere
  return N >= 3 && a < (2 * Math.PI) / N; // equivalent to sin(a/2) < sin(pi/N) only for a < pi
}

/** Angular circumradius R: sin(a/2) = sin R sin(pi/N). Disks: the angular radius. */
export function circumradiusAngle(N: number, rho: number): number {
  const a = 1 / rho;
  if (N === 0) return a;
  return Math.asin(Math.sin(a / 2) / Math.sin(Math.PI / N));
}

/** Angular inradius r: tan(a/2) = sin r tan(pi/N). */
export function inradiusAngle(N: number, rho: number): number {
  const a = 1 / rho;
  if (N === 0) return a;
  return Math.asin(Math.tan(a / 2) / Math.tan(Math.PI / N));
}

/** Interior angle alpha: cos(pi/N) = cos(a/2) sin(alpha/2). */
export function interiorAngle(N: number, rho: number): number {
  const a = 1 / rho;
  return 2 * Math.asin(Math.min(1, Math.cos(Math.PI / N) / Math.cos(a / 2)));
}

/** Area of one piece on the sphere of radius rho (Gauss-Bonnet; caps 2 pi rho^2 (1 - cos a)). */
export function pieceArea(N: number, rho: number): number {
  const a = 1 / rho;
  const unitArea = N === 0 ? 2 * Math.PI * (1 - Math.cos(a)) : N * interiorAngle(N, rho) - (N - 2) * Math.PI;
  return unitArea * rho * rho;
}

/** Area bound (float): the rho at which P pieces have total area 4 pi rho^2; for P <= 2 polygons the existence limit N/(2 pi). */
export function areaBound(N: number, P: number): number {
  if (N === 0) return 1 / Math.acos(1 - 2 / P);
  const alphaStar = ((N - 2) * Math.PI + (4 * Math.PI) / P) / N;
  if (alphaStar >= Math.PI) return N / (2 * Math.PI);
  const ca = Math.cos(Math.PI / N) / Math.sin(alphaStar / 2);
  return 1 / (2 * Math.acos(Math.min(1, ca)));
}

export function quatMul(p: Quat, q: Quat): Quat {
  const [w1, x1, y1, z1] = p;
  const [w2, x2, y2, z2] = q;
  return [
    w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
    w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
    w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
    w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
  ];
}

/** Rotation matrix of q/|q| (rows), exactly orthogonal formula H(q)/|q|^2. */
export function quatToMatrix(q: Quat): [Vec3, Vec3, Vec3] {
  const [w, x, y, z] = q;
  const n = w * w + x * x + y * y + z * z;
  return [
    [(w * w + x * x - y * y - z * z) / n, (2 * (x * y - w * z)) / n, (2 * (x * z + w * y)) / n],
    [(2 * (x * y + w * z)) / n, (w * w - x * x + y * y - z * z) / n, (2 * (y * z - w * x)) / n],
    [(2 * (x * z - w * y)) / n, (2 * (y * z + w * x)) / n, (w * w - x * x - y * y + z * z) / n],
  ];
}

export function rotate(q: Quat, v: Vec3): Vec3 {
  const M = quatToMatrix(q);
  return [dot(M[0], v), dot(M[1], v), dot(M[2], v)];
}

export function centreOf(q: Quat): Vec3 {
  return rotate(q, [0, 0, 1]);
}

/** Vertices of the standard N-gon of circumradius R (vertex 0 up). */
export function standardVertices(N: number, R: number): Vec3[] {
  const out: Vec3[] = [];
  for (let k = 0; k < N; k++) {
    const phi = Math.PI / 2 + (2 * Math.PI * k) / N;
    out.push([Math.sin(R) * Math.cos(phi), Math.sin(R) * Math.sin(phi), Math.cos(R)]);
  }
  return out;
}

/** Vertices of a placed N-gon on the unit sphere at sphere radius rho. */
export function placedVertices(N: number, rho: number, q: Quat): Vec3[] {
  const R = circumradiusAngle(N, rho);
  return standardVertices(N, R).map((v) => rotate(q, v));
}

/** G = T(c) R_z(theta) as a quaternion (c any nonzero vector; c = -e3 uses the rotation by pi about e1). */
export function quatFromCentreTheta(c: Vec3, theta: number): Quat {
  const u = unit(c);
  const d = Math.acos(Math.max(-1, Math.min(1, u[2])));
  const s = Math.hypot(u[0], u[1]);
  let qt: Quat;
  if (s < 1e-300) qt = u[2] > 0 ? [1, 0, 0, 0] : [0, 1, 0, 0];
  else qt = [Math.cos(d / 2), (Math.sin(d / 2) * -u[1]) / s, (Math.sin(d / 2) * u[0]) / s, 0];
  return quatMul(qt, [Math.cos(theta / 2), 0, 0, Math.sin(theta / 2)]);
}

/** Inverse of quatFromCentreTheta: centre (unit) and theta (radians). */
export function centreThetaFromQuat(q: Quat): { centre: Vec3; theta: number } {
  const n = Math.hypot(...q);
  const qn: Quat = [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
  const c = centreOf(qn);
  const qt = quatFromCentreTheta(c, 0);
  const qz = quatMul([qt[0], -qt[1], -qt[2], -qt[3]], qn);
  return { centre: c, theta: 2 * Math.atan2(qz[3], qz[0]) };
}

/** The curved package's pose (x, y, theta) on the sphere of radius rho -> quaternion. */
export function quatFromExp(x: number, y: number, theta: number, rho: number): Quat {
  const D = Math.hypot(x, y);
  const d = D / rho;
  if (D === 0) return [Math.cos(theta / 2), 0, 0, Math.sin(theta / 2)];
  // T(c): rotation by d about the axis (-y, x, 0)/D, taking e3 to (sin d x/D, sin d y/D, cos d)
  const qt: Quat = [Math.cos(d / 2), (Math.sin(d / 2) * -y) / D, (Math.sin(d / 2) * x) / D, 0];
  return quatMul(qt, [Math.cos(theta / 2), 0, 0, Math.sin(theta / 2)]);
}

/** Quaternion -> (x, y, theta) exponential coordinates on the sphere of radius rho (distance d < pi). */
export function expFromQuat(q: Quat, rho: number): { x: number; y: number; theta: number } {
  const { centre, theta } = centreThetaFromQuat(q);
  const d = Math.acos(Math.max(-1, Math.min(1, centre[2])));
  const s = Math.hypot(centre[0], centre[1]);
  if (s === 0) return { x: 0, y: 0, theta };
  return { x: (rho * d * centre[0]) / s, y: (rho * d * centre[1]) / s, theta };
}
