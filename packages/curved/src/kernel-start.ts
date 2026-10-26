/**
 * Starts of the curved kernel (kernel.ts).
 *
 * Random placements: centres uniform by area in the region of the container where a piece's
 * inscribed disk fits (every wall at least rho away, or within r - rho of O in a disk container),
 * orientations uniform. Structured starts (the capability "seeds"): rings about O (ringLayout).
 *
 * The package's search places centres in a disk about O instead (search.ts, placementRadius).
 * At K < 0 a polygon container near the ideal polygon keeps much of its room in its corners,
 * which that disk does not reach, so its random starts crowd the middle and jam. Sampling the
 * whole region spreads them as the container allows.
 *
 * Sampling. The regular M-gon with apothem t is 2M congruent right triangles (O, foot of an
 * apothem, vertex), each spanning an angle pi/M at O. In direction phi from an apothem the
 * boundary is at r_b(phi) with tn_K(r_b) cos(phi) = tn_K(t), and the area of the thin sector up to
 * it is vs_K(r_b(phi)) dphi (the area element is sn_K(r) dr dphi and d vs_K / dr = sn_K). So phi is
 * drawn with density proportional to vs_K(r_b(phi)) (by rejection against its largest value, at
 * the corner), then r with vs_K(r) uniform on [0, vs_K(r_b)]; a point is kept when its inscribed
 * disk fits. A disk container is the same with r_b = r - rho.
 *
 * A random start places its pieces one by one, each at the best of CANDIDATES such centres: the
 * one farthest from the centres placed before it (best-candidate sampling). Independent centres
 * clump, and near P_max a relaxation of clumped pieces jams (K = -1, six squares in a hexagon:
 * no relaxed start of eight separated); spread ones separate.
 */
import { type CurvedPose, type Space } from "./problem";
import { type LPoint, expO, lineValue, pairVs, polarPoint } from "./space";
import { asnK, atnK, distFromVs, tnK, vsK } from "./kfun";
import { sideFromApothem, wallAngle } from "./shapes";
import { centreDistance, pairGap, pieceState, requiredT, wallCovectors } from "./evaluate";

/** Tries before a placement gives up and returns its last candidate (never reached in practice). */
const TRIES = 400;
/** Candidates per piece in a random start. */
const CANDIDATES = 12;

/**
 * A centre (exponential coordinates about O) uniform by area in the part of the container with
 * apothem or radius t where the piece's inscribed disk fits; O when that part is empty.
 */
export function randomCentreInside(space: Space, t: number, rng: () => number): { x: number; y: number } {
  const { K, M } = space;
  const rho = space.piece.rho;
  if (M === 0) {
    const rMax = t - rho;
    if (!(rMax > 0)) return { x: 0, y: 0 };
    const r = distFromVs(K, rng() * vsK(K, rMax));
    const a = 2 * Math.PI * rng();
    return { x: r * Math.cos(a), y: r * Math.sin(a) };
  }
  if (!(t > rho)) return { x: 0, y: 0 };
  const walls = wallCovectors(space, t);
  const tnT = tnK(K, t);
  const boundary = (phi: number) => atnK(K, tnT / Math.cos(phi));
  const vsCorner = vsK(K, boundary(Math.PI / M));
  const fits = (p: LPoint) => walls.every((n) => asnK(K, lineValue(K, n, p)) <= -rho);
  let last = { x: 0, y: 0 };
  for (let k = 0; k < TRIES; k++) {
    const phi = (Math.PI / M) * rng();
    const rb = boundary(phi);
    if (!(rng() * vsCorner <= vsK(K, rb))) continue;
    const r = distFromVs(K, rng() * vsK(K, rb));
    // one of the 2M right triangles: about apothem w, on either side of it
    const w = Math.floor(rng() * M) % M;
    const a = wallAngle(M, w) + (rng() < 0.5 ? phi : -phi);
    last = { x: r * Math.cos(a), y: r * Math.sin(a) };
    if (fits(polarPoint(K, r, a))) return last;
  }
  return last;
}

/** P centres for a random start: each the candidate farthest from those placed before it. */
export function spreadCentres(space: Space, t: number, P: number, rng: () => number): { x: number; y: number }[] {
  const { K } = space;
  const out: { x: number; y: number }[] = [];
  const lifted: LPoint[] = [];
  for (let i = 0; i < P; i++) {
    let best = { x: 0, y: 0 };
    let bestVs = -1;
    for (let c = 0; c < (i === 0 ? 1 : CANDIDATES); c++) {
      const q = randomCentreInside(space, t, rng);
      const lq = expO(K, q.x, q.y);
      // vs_K of the distance to the nearest centre placed so far (vs_K grows with the distance)
      let near = Infinity;
      for (const l of lifted) near = Math.min(near, pairVs(K, lq, l));
      if (near > bestVs) {
        bestVs = near;
        best = q;
      }
    }
    out.push(best);
    lifted.push(expO(K, best.x, best.y));
  }
  return out;
}

/** A layout of pieces with the smallest container about them (centred at O, as always). */
export interface Layout {
  size: number;
  pieces: CurvedPose[];
}

/** Pieces on a ring of radius r about O: piece k at direction phase + 2 pi k / n, turned by `turn` from its radial direction. */
function ring(n: number, r: number, phase: number, turn: number): CurvedPose[] {
  return Array.from({ length: n }, (_, k) => {
    const a = phase + (2 * Math.PI * k) / n;
    return { x: r * Math.cos(a), y: r * Math.sin(a), theta: a + turn };
  });
}

/** True when no two of the pieces overlap (separating-axis value or disk distance >= 0). */
function apart(space: Space, poses: CurvedPose[]): boolean {
  const st = poses.map((p) => pieceState(space, p));
  const reach = 2 * space.piece.R;
  for (let i = 0; i < st.length; i++)
    for (let j = i + 1; j < st.length; j++)
      if (!(centreDistance(space, st[i], st[j]) > reach) && !(pairGap(space, st[i], st[j]).gap >= 0)) return false;
  return true;
}

/**
 * Two rings about O: `inner` pieces (none; one at O; or a ring) and the other P - inner on an
 * outer ring, each ring as tight as its pieces allow (bisection on its radius, 40 steps), every
 * piece turned by `turn` from its radial direction (theta is measured from the frame carried from
 * O, so the radial direction at a centre in direction a is a). Then the smallest container about
 * them. Null when a ring does not close in the space (K > 0) or the container would be too big.
 * One ring of P triangles with a vertex at O is the {3, P} tiling where the triangle's angle is
 * 2 pi / P (docs/spaces/CURVED.md §6); P - 1 disks about one are the hyperbolic disk rings.
 */
export function ringLayout(
  space: Space,
  P: number,
  inner: number,
  turn: number,
  phase: number,
  innerPhase: number,
): Layout | null {
  const { K, M } = space;
  const rMax = K > 0 ? Math.PI / (2 * Math.sqrt(K)) - space.piece.R : 30 / Math.sqrt(Math.max(1, -K));
  // the smallest radius in [0, rMax] at which `fixed` and a ring of n pieces do not overlap
  const fit = (fixed: CurvedPose[], n: number, ph: number): CurvedPose[] | null => {
    const ok = (r: number) => apart(space, [...fixed, ...ring(n, r, ph, turn)]);
    let hi = 2 * space.piece.R;
    while (!ok(hi)) {
      hi *= 1.5;
      if (hi > rMax) return null;
    }
    let lo = 0;
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      if (ok(mid)) hi = mid;
      else lo = mid;
    }
    return [...fixed, ...ring(n, hi, ph, turn)];
  };
  let pieces: CurvedPose[] | null =
    inner === 0 ? [] : inner === 1 ? [{ x: 0, y: 0, theta: innerPhase + turn }] : fit([], inner, innerPhase);
  if (pieces && P > inner) pieces = fit(pieces, P - inner, phase);
  if (!pieces) return null;
  let t = -Infinity;
  for (const p of pieces) t = Math.max(t, requiredT(space, pieceState(space, p)));
  if (!(t < space.tMax)) return null;
  const size = M === 0 ? t : sideFromApothem(M, K, t);
  return Number.isFinite(size) ? { size, pieces } : null;
}
