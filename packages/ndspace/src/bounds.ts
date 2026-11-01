/**
 * Lower bounds on the score (the container scale s) of an nD problem, from the polytopes' facts alone (no coordinates):
 *  - volume: P vol(piece) <= s^d vol(container);
 *  - inradius: the piece contains a ball of its inradius, which must fit in the container (a ball in a convex body has radius
 *    at most the body's inradius): s r_in(C) >= r_in(piece), for a ball container r_in = s/2;
 *  - circumradius, in a ball container: a regular polytope's smallest enclosing ball is its circumscribed ball (vertex-
 *    transitive, so the circumcentre is the centroid [EST]), so s/2 >= R(piece).
 * They are the core's `lowerBound` (packages/ndim bounds.ts) and the last one, computed here from `INFO` so that a page
 * needs no coordinates.
 */
import { ND_BALL, ND_INFO, ndCode, type NdProblemId } from "./catalogue";

const BALL_RADIUS = 0.5;

/** Volume of the d-ball of radius r (V_d = 2 pi / d V_(d-2)). */
export function ndBallVolume(d: number, r = 1): number {
  let v = d % 2 === 0 ? 1 : 2;
  for (let k = d % 2 === 0 ? 2 : 3; k <= d; k += 2) v *= (2 * Math.PI) / k;
  return v * r ** d;
}

function facts(d: number, shape: string) {
  if (shape === ND_BALL)
    return { volume: ndBallVolume(d, BALL_RADIUS), inradius: BALL_RADIUS, circumradius: BALL_RADIUS };
  const info = ND_INFO.get(ndCode(d, shape));
  if (!info) throw new Error(`unknown shape ${shape} in ${d}D`);
  return info;
}

export interface NdBound {
  value: number;
  kind: "volume" | "inradius" | "circumradius";
}

/** The best lower bound on s of the problem with P pieces, and the kind that gives it. */
export function ndLowerBound(p: Pick<NdProblemId, "d" | "piece" | "container">, P: number): NdBound {
  const a = facts(p.d, p.piece);
  const c = facts(p.d, p.container);
  const candidates: NdBound[] = [
    { value: Math.pow((P * a.volume) / c.volume, 1 / p.d), kind: "volume" },
    { value: a.inradius / c.inradius, kind: "inradius" },
  ];
  // a ball container of diameter s holds the piece's circumscribed ball: s >= 2 R
  if (p.container === ND_BALL) candidates.push({ value: 2 * a.circumradius, kind: "circumradius" });
  return candidates.reduce((best, x) => (x.value > best.value ? x : best));
}

/** The bound as the spaces list it: slightly lowered, since the volumes are floats (about 1e-14 relative). */
export function ndBoundEntry(
  p: Pick<NdProblemId, "d" | "piece" | "container">,
  P: number,
): { value: number; label: string } {
  const b = ndLowerBound(p, P);
  return { value: b.value * (1 - 1e-12), label: `${b.kind} bound; [CALC]` };
}
