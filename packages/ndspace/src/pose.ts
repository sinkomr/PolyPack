/**
 * The pose of a rotation matrix, with a check that the pose reproduces it.
 *
 * The ndim package's poseOfMatrix solves S = (D R - I)(D R + I)^-1 for each even flip D and keeps the smallest parameters.
 * For a matrix with an eigenvalue -1 under some flip the solve is numerically singular and returns parameters of another
 * rotation, which can be the smallest. Here every candidate is rebuilt with cayleyMatrix and kept only when it reproduces R
 * to 1e-12.
 */
import { MAX_CAYLEY, cayleyMatrix } from "@polypack/ndim";
import { inverse, mul } from "./linalg";

const parity = (m: number): number => {
  let c = 0;
  for (; m; m &= m - 1) c++;
  return c & 1;
};

/** [t_1..t_d, k..., flip] for the centre t and the rotation R (row-major d x d), or null when no form within MAX_CAYLEY reproduces R. */
export function robustPose(t: ArrayLike<number>, R: Float64Array, d: number): number[] | null {
  let best: { size: number; params: number[]; flip: number } | null = null;
  // all even flips for d <= 7; above, the flip that makes D R close to the identity and its pair swaps
  const masks: number[] = [];
  if (d <= 7) {
    for (let m = 0; m < 1 << d; m++) if (!parity(m)) masks.push(m);
  } else {
    let base = 0;
    for (let i = 0; i < d; i++) if (R[i * d + i] < 0) base |= 1 << i;
    if (parity(base)) {
      let imin = 0;
      for (let i = 1; i < d; i++) if (Math.abs(R[i * d + i]) < Math.abs(R[imin * d + imin])) imin = i;
      base ^= 1 << imin;
    }
    masks.push(base);
    for (let i = 0; i < d; i++) for (let j = i + 1; j < d; j++) masks.push(base ^ (1 << i) ^ (1 << j));
  }
  const num = new Float64Array(d * d);
  const den = new Float64Array(d * d);
  for (const m of masks) {
    for (let i = 0; i < d; i++)
      for (let j = 0; j < d; j++) {
        const v = ((m >> i) & 1 ? -1 : 1) * R[i * d + j];
        num[i * d + j] = v - (i === j ? 1 : 0);
        den[i * d + j] = v + (i === j ? 1 : 0);
      }
    const inv = inverse(den, d);
    if (!inv) continue;
    const S = mul(num, inv, d);
    const params: number[] = [];
    let size = 0;
    for (let i = 0; i < d; i++)
      for (let j = i + 1; j < d; j++) {
        const v = 0.5 * (S[i * d + j] - S[j * d + i]);
        params.push(v);
        size = Math.max(size, Math.abs(v));
      }
    if (!(size <= MAX_CAYLEY) || (best && size >= best.size)) continue;
    const back = cayleyMatrix(params, d, m);
    let err = 0;
    for (let k = 0; k < d * d; k++) err = Math.max(err, Math.abs(back[k] - R[k]));
    if (err < 1e-12) best = { size, params, flip: m };
  }
  if (!best) return null;
  return [...Array.from(t).slice(0, d), ...best.params, best.flip];
}
