/**
 * Rotations of the polyhedra kernel's charts (kernel.ts): a piece's orientation is exp([w]x) A, the anchor A a
 * unit quaternion and w a world-frame rotation vector (the chart). Quaternions are scalar first, (w, x, y, z), and
 * compose as rotations do: R(p q) = R(p) R(q).
 */
import type { Rng } from "@polypack/methods";

/**
 * The unit quaternion of exp([w]x) for w = (wx, wy, wz), into out[o .. o + 3]. |w| is taken by hypot, so that a
 * huge finite w gives a finite (if arbitrary) rotation; a non-finite w gives NaN.
 */
export function expQuat(wx: number, wy: number, wz: number, out: Float64Array, o = 0): void {
  const th = Math.hypot(wx, wy, wz);
  // sin(th / 2) / th, by its series near 0 (error below 1e-17 there)
  const sh = th < 1e-4 ? 0.5 - (th * th) / 48 : Math.sin(th / 2) / th;
  out[o] = Math.cos(th / 2);
  out[o + 1] = wx * sh;
  out[o + 2] = wy * sh;
  out[o + 3] = wz * sh;
}

/**
 * The rotation vector w of a unit quaternion q (exp([w]x) = q, |w| <= pi), times `scale`, into out[o .. o + 2]:
 * the angle is 2 atan2(|v|, |q_w|) for the vector part v, about v / |v| (q and -q are the same rotation).
 */
export function logQuat(q: ArrayLike<number>, qo: number, scale: number, out: Float64Array, o: number): void {
  const sign = q[qo] < 0 ? -1 : 1;
  const w = sign * q[qo];
  const x = sign * q[qo + 1];
  const y = sign * q[qo + 2];
  const z = sign * q[qo + 3];
  const v = Math.hypot(x, y, z);
  // angle / |v|; near the identity 2 / w, the limit of 2 atan2(v, w) / v
  const f = v < 1e-12 ? 2 / w : (2 * Math.atan2(v, w)) / v;
  out[o] = scale * f * x;
  out[o + 1] = scale * f * y;
  out[o + 2] = scale * f * z;
}

/** out[o ..] = normalise(p q), p and q at their offsets (out may be p or q). */
export function mulQuat(p: ArrayLike<number>, po: number, q: ArrayLike<number>, qo: number, out: Float64Array, o = 0): void {
  const pw = p[po];
  const px = p[po + 1];
  const py = p[po + 2];
  const pz = p[po + 3];
  const qw = q[qo];
  const qx = q[qo + 1];
  const qy = q[qo + 2];
  const qz = q[qo + 3];
  const w = pw * qw - px * qx - py * qy - pz * qz;
  const x = pw * qx + px * qw + py * qz - pz * qy;
  const y = pw * qy - px * qz + py * qw + pz * qx;
  const z = pw * qz + px * qy - py * qx + pz * qw;
  const m = Math.hypot(w, x, y, z);
  out[o] = w / m;
  out[o + 1] = x / m;
  out[o + 2] = y / m;
  out[o + 3] = z / m;
}

/**
 * q / |q| into out[o ..], for any finite nonzero q (a configuration's quaternions need not be unit; some records
 * store integer ones near 5e48): divided by its largest component first, so that nothing overflows.
 */
export function unitQuat(q: ArrayLike<number>, qo: number, out: Float64Array, o = 0): void {
  const m = Math.max(Math.abs(q[qo]), Math.abs(q[qo + 1]), Math.abs(q[qo + 2]), Math.abs(q[qo + 3]));
  const w = q[qo] / m;
  const x = q[qo + 1] / m;
  const y = q[qo + 2] / m;
  const z = q[qo + 3] / m;
  const n = Math.hypot(w, x, y, z);
  out[o] = w / n;
  out[o + 1] = x / n;
  out[o + 2] = y / n;
  out[o + 3] = z / n;
}

/** A uniformly random unit quaternion (Shoemake's method; three numbers of the stream), into out[o ..]. */
export function randomQuat(rng: Rng, out: Float64Array, o = 0): void {
  const u1 = rng();
  const u2 = 2 * Math.PI * rng();
  const u3 = 2 * Math.PI * rng();
  const a = Math.sqrt(1 - u1);
  const b = Math.sqrt(u1);
  out[o] = a * Math.sin(u2);
  out[o + 1] = a * Math.cos(u2);
  out[o + 2] = b * Math.sin(u3);
  out[o + 3] = b * Math.cos(u3);
}

/**
 * The gradient in the chart from the gradient g in a world-frame rotation: J_l(w)^T g, J_l the left Jacobian of
 * exp on SO(3), since exp(w + d) = exp(J_l(w) d) exp(w) to first order. With th = |w|,
 *   J_l(w) = I + a [w]x + b [w]x^2,  a = (1 - cos th) / th^2,  b = (th - sin th) / th^3,
 * so J_l^T g = g - a (w x g) + b (w x (w x g)). With the unit axis u = w / th this is
 *   J_l^T g = g - A (u x g) + B (u x (u x g)),  A = (1 - cos th) / th,  B = 1 - sin(th) / th,
 * which neither overflows for a huge w nor divides by 0 at w = 0. Writes out[o .. o + 2] = scale * J_l^T g.
 */
export function chartGradient(
  wx: number,
  wy: number,
  wz: number,
  gx: number,
  gy: number,
  gz: number,
  scale: number,
  out: Float64Array,
  o: number,
): void {
  const th = Math.hypot(wx, wy, wz);
  if (!(th > 0)) {
    out[o] = scale * gx;
    out[o + 1] = scale * gy;
    out[o + 2] = scale * gz;
    return;
  }
  const ux = wx / th;
  const uy = wy / th;
  const uz = wz / th;
  // series near 0, where the closed forms cancel (errors below 1e-18 there)
  const t2 = th * th;
  const A = th < 1e-3 ? th * (0.5 - t2 / 24) : (1 - Math.cos(th)) / th;
  const B = th < 1e-3 ? t2 * (1 / 6 - t2 / 120) : 1 - Math.sin(th) / th;
  const c1x = uy * gz - uz * gy;
  const c1y = uz * gx - ux * gz;
  const c1z = ux * gy - uy * gx;
  const c2x = uy * c1z - uz * c1y;
  const c2y = uz * c1x - ux * c1z;
  const c2z = ux * c1y - uy * c1x;
  out[o] = scale * (gx - A * c1x + B * c2x);
  out[o + 1] = scale * (gy - A * c1y + B * c2y);
  out[o + 2] = scale * (gz - A * c1z + B * c2z);
}
