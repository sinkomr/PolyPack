/**
 * Structured starts of the polyhedra kernel (kernel.ts, capability "seeds"): patches of a box lattice.
 */
import type { Rng } from "@polypack/methods";
import { quatToR } from "./geom";
import type { Solid } from "./solids";

/**
 * A box-lattice patch: P copies of the piece in one orientation q (a unit quaternion), on the lattice of the
 * axis-aligned boxes that bound the turned piece, at a random offset of the lattice; with `stagger`, every second
 * layer (in z) is shifted by half a box in x and y. Boxes of the lattice do not overlap, so neither do the pieces
 * in them (they may touch).
 *
 * The P lattice points kept are those that need the smallest container. With h_f the support of the turned
 * piece in the direction of the container's face normal N_f (h_f = max_v N_f . R v), the piece centred at c lies
 * in s C exactly when N_f . c + h_f <= s b_f for every face f, so its gauge
 *   g(c) = max_f (N_f . c + h_f) / b_f
 * is the smallest scale of the container (centred at the origin) that holds it. The patch is the P points of
 * smallest gauge and its size the largest gauge among them: the container fits the patch, and the patch takes the
 * container's shape.
 */
export function latticeSeed(
  piece: Solid,
  cont: Solid,
  P: number,
  q: ArrayLike<number>,
  stagger: boolean,
  rng: Rng,
): { centres: Float64Array; size: number } {
  const R = quatToR(q[0], q[1], q[2], q[3]);
  const nv = piece.nv;
  const V = piece.V;
  const Y = new Float64Array(3 * nv);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < nv; v++) {
    const a = V[3 * v];
    const b = V[3 * v + 1];
    const c = V[3 * v + 2];
    for (let d = 0; d < 3; d++) {
      const y = R[3 * d] * a + R[3 * d + 1] * b + R[3 * d + 2] * c;
      Y[3 * v + d] = y;
      if (y < lo[d]) lo[d] = y;
      if (y > hi[d]) hi[d] = y;
    }
  }
  const w = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  // the box's centre seen from the piece's centre
  const m = [(hi[0] + lo[0]) / 2, (hi[1] + lo[1]) / 2, (hi[2] + lo[2]) / 2];
  const F = cont.offsets.length;
  const N = cont.N;
  const b = cont.offsets;
  const h = new Float64Array(F);
  for (let f = 0; f < F; f++) {
    let best = -Infinity;
    for (let v = 0; v < nv; v++)
      best = Math.max(best, N[3 * f] * Y[3 * v] + N[3 * f + 1] * Y[3 * v + 1] + N[3 * f + 2] * Y[3 * v + 2]);
    h[f] = best;
  }
  // index range: the boxes of a container about 1.5 times as large as P boxes' volume would fill (and at least
  // enough indices for P points)
  const sEst = Math.cbrt((P * w[0] * w[1] * w[2]) / cont.volume);
  const K = w.map((wa) => Math.max(Math.ceil((1.5 * sEst * cont.circumradius) / wa) + 1, Math.ceil(Math.cbrt(P))));
  const off = [rng(), rng(), rng()];
  const cand: { g: number; x: number; y: number; z: number }[] = [];
  for (let k = -K[2]; k <= K[2]; k++) {
    const sh = stagger && k & 1 ? 0.5 : 0;
    for (let j = -K[1]; j <= K[1]; j++)
      for (let i = -K[0]; i <= K[0]; i++) {
        const x = (i + off[0] + sh) * w[0] - m[0];
        const y = (j + off[1] + sh) * w[1] - m[1];
        const z = (k + off[2]) * w[2] - m[2];
        let g = -Infinity;
        for (let f = 0; f < F; f++) g = Math.max(g, (N[3 * f] * x + N[3 * f + 1] * y + N[3 * f + 2] * z + h[f]) / b[f]);
        cand.push({ g, x, y, z });
      }
  }
  cand.sort((p, r) => p.g - r.g);
  const centres = new Float64Array(3 * P);
  let size = 0;
  for (let i = 0; i < P; i++) {
    const c = cand[i];
    centres[3 * i] = c.x;
    centres[3 * i + 1] = c.y;
    centres[3 * i + 2] = c.z;
    size = Math.max(size, c.g);
  }
  // the lattice's random offset leaves the patch off centre: move the middle of its bounding box to the origin when
  // that needs a smaller container (it does for a box-shaped container)
  const pLo = [Infinity, Infinity, Infinity];
  const pHi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P; i++)
    for (let d = 0; d < 3; d++) {
      pLo[d] = Math.min(pLo[d], centres[3 * i + d] + lo[d]);
      pHi[d] = Math.max(pHi[d], centres[3 * i + d] + hi[d]);
    }
  const tau = [0, 1, 2].map((d) => -(pLo[d] + pHi[d]) / 2);
  let moved = 0;
  for (let i = 0; i < P; i++)
    for (let f = 0; f < F; f++) {
      let p = h[f];
      for (let d = 0; d < 3; d++) p += N[3 * f + d] * (centres[3 * i + d] + tau[d]);
      moved = Math.max(moved, p / b[f]);
    }
  if (moved < size) {
    for (let i = 0; i < P; i++) for (let d = 0; d < 3; d++) centres[3 * i + d] += tau[d];
    size = moved;
  }
  return { centres, size };
}
