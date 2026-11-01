/**
 * Lattice points for the structured starts of the nD kernel: the P points of a lattice nearest to a centre. The lattices
 * are Z^d (the k^d grids), D_d (integer points with an even coordinate sum: the densest known ball packing lattice in 3
 * to 5 dimensions) and E8 (D8 together with the half-integer points of even sum, in 8 dimensions), at unit scale
 * (spacing 1 in the integer coordinates).
 */
import type { Rng } from "@polypack/methods";

export type LatticeName = "zd" | "dd" | "e8";

/** Largest number of candidate points a search keeps before it takes the nearest P of them (bounds the work). */
const MAX_CANDIDATES = 20000;

/**
 * The P lattice points nearest to `centre` (ties broken by rng), as a flat array P x d, or null when the lattice does not
 * have enough points near that centre within the candidate cap. The points are in the lattice's own coordinates (the
 * caller scales them).
 */
export function latticePoints(
  name: LatticeName,
  d: number,
  centre: ArrayLike<number>,
  P: number,
  rng: Rng,
): Float64Array | null {
  // E8 is D8 plus the half-integer points of even sum: two cosets, each searched as a shifted integer lattice
  const shifts = name === "e8" ? [0, 0.5] : [0];
  const cands: { p: Float64Array; r2: number; tie: number }[] = [];
  // grow the squared radius until enough candidates are found
  for (let R2 = 1; R2 < 4 * d + 8; R2 *= 1.5) {
    cands.length = 0;
    let overflow = false;
    for (const shift of shifts) {
      const p = new Float64Array(d);
      const rec = (k: number, r2: number, parity: number): void => {
        if (overflow) return;
        if (k === d) {
          // D_d: even sum of integer coordinates; E8's half-integer coset: even sum of x - 1/2 shifted... the coset
          // (Z + 1/2)^8 with an even sum of the coordinates
          const ok = name === "zd" || (shift === 0 ? parity % 2 === 0 : Math.round(sumOf(p, d)) % 2 === 0);
          if (ok) {
            if (cands.length >= MAX_CANDIDATES) overflow = true;
            else cands.push({ p: Float64Array.from(p), r2, tie: rng() });
          }
          return;
        }
        const c = centre[k];
        const room = Math.sqrt(Math.max(0, R2 - r2));
        for (let v = Math.ceil(c - room - shift) + shift; v <= c + room + 1e-12; v += 1) {
          const e = v - c;
          const r2n = r2 + e * e;
          if (r2n > R2 + 1e-12) continue;
          p[k] = v;
          rec(k + 1, r2n, parity + (shift === 0 ? Math.round(v) : 0));
        }
      };
      rec(0, 0, 0);
    }
    if (overflow) break;
    if (cands.length >= P) {
      cands.sort((a, b) => a.r2 - b.r2 || a.tie - b.tie);
      const out = new Float64Array(P * d);
      for (let i = 0; i < P; i++) out.set(cands[i].p, i * d);
      return out;
    }
  }
  // too many candidates before P were found within a radius, or the radius cap was reached: no start of this kind
  return null;
}

function sumOf(p: Float64Array, d: number): number {
  let s = 0;
  for (let i = 0; i < d; i++) s += p[i];
  return s;
}
