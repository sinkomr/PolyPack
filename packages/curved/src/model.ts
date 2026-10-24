/**
 * Constraint model of a packing: collects gap rows (with gradients) for the penalty search and for
 * the sequential linear programming polish.
 */
import { CurvedPose, Space } from "./problem";
import {
  PieceState,
  Row,
  allStates,
  centreDistance,
  diskPairRow,
  pairGap,
  rimRow,
  vertexEdgeRow,
  wallRow,
  wallCovectors,
  containerGap,
} from "./evaluate";
import { asnK, distFromVs } from "./kfun";
import { lineValue } from "./space";

export function posesFromVector(z: ArrayLike<number>): CurvedPose[] {
  const P = z.length / 3;
  const out: CurvedPose[] = [];
  for (let i = 0; i < P; i++) out.push({ x: z[3 * i], y: z[3 * i + 1], theta: z[3 * i + 2] });
  return out;
}

export function vectorFromPoses(poses: readonly CurvedPose[]): Float64Array {
  const z = new Float64Array(3 * poses.length);
  poses.forEach((p, i) => {
    z[3 * i] = p.x;
    z[3 * i + 1] = p.y;
    z[3 * i + 2] = p.theta;
  });
  return z;
}

export interface RowOptions {
  /** include rows whose value is below this threshold */
  below: number;
  /** pair rows: "summary" = one row per pair at its SAT witness; "vertices" = every vertex of the other piece below threshold against the best axis */
  pairMode: "summary" | "vertices";
}

/** Gap rows of the configuration at container variable t. */
export function collectRows(space: Space, states: PieceState[], t: number, opt: RowOptions): Row[] {
  const { N, M } = space;
  const P = states.length;
  const rows: Row[] = [];
  const reach = 2 * space.piece.R + Math.max(0, opt.below);
  for (let i = 0; i < P; i++) {
    for (let j = i + 1; j < P; j++) {
      const cd = centreDistance(space, states[i], states[j]);
      if (cd > reach) continue;
      if (N === 0) {
        if (cd - 2 < opt.below) rows.push(diskPairRow(space, states[i], states[j], i, j));
        continue;
      }
      const g = pairGap(space, states[i], states[j]);
      if (g.gap >= opt.below) continue;
      const w = g.witness;
      const [pi, qi] = w.owner === 0 ? [i, j] : [j, i];
      const Pst = states[pi];
      const Qst = states[qi];
      if (opt.pairMode === "summary") {
        rows.push(orient(vertexEdgeRow(space, Pst, w.edge, Qst, w.vertex, pi, qi, w.owner), i, j));
      } else {
        const n = Pst.edges[w.edge];
        for (let k = 0; k < N; k++) {
          const v = asnK(space.K, lineValue(space.K, n, Qst.verts[k]));
          if (v < opt.below) rows.push(orient(vertexEdgeRow(space, Pst, w.edge, Qst, k, pi, qi, w.owner), i, j));
        }
      }
    }
  }
  const walls = M === 0 ? [] : wallCovectors(space, t);
  for (let i = 0; i < P; i++) {
    const S = states[i];
    const pts = N === 0 ? 1 : N;
    for (let k = 0; k < pts; k++) {
      const kk = N === 0 ? -1 : k;
      const p = N === 0 ? S.centre : S.verts[k];
      const pad = N === 0 ? 1 : 0;
      if (M === 0) {
        const g = t - distFromVs(space.K, p.e) - pad;
        if (g < opt.below) rows.push(rimRow(space, S, i, kk, t));
      } else {
        for (let w = 0; w < M; w++) {
          const g = -asnK(space.K, lineValue(space.K, walls[w], p)) - pad;
          if (g < opt.below) rows.push(wallRow(space, S, i, kk, w, t));
        }
      }
    }
  }
  return rows;
}

/** Store pair rows with i < j: swap the gradient slots when the axis owner is the larger index. */
function orient(r: Row, i: number, j: number): Row {
  if (r.i === i) return r;
  return { ...r, i, j, gi: r.gj, gj: r.gi };
}

/** Penalty energy sum(max(0, -gap)^2) over all constraints, with gradient in z (t fixed). */
export function energy(space: Space, z: Float64Array, t: number, grad: Float64Array, margin = 0): number {
  const states = allStates(space, posesFromVector(z));
  const rows = collectRows(space, states, t, { below: margin, pairMode: "summary" });
  grad.fill(0);
  let E = 0;
  for (const r of rows) {
    const v = r.value - margin;
    if (v >= 0) continue;
    E += v * v;
    const f = 2 * v;
    for (let a = 0; a < 3; a++) {
      grad[3 * r.i + a] += f * r.gi[a];
      if (r.j >= 0) grad[3 * r.j + a] += f * r.gj[a];
    }
  }
  return E;
}

/** Worst violation (most negative gap minus margin) over all constraints, exact (no row selection). */
export function worstGap(space: Space, states: PieceState[], t: number): { pair: number; container: number } {
  const P = states.length;
  let pair = Infinity;
  const reach = 2 * space.piece.R + 1e-6;
  for (let i = 0; i < P; i++)
    for (let j = i + 1; j < P; j++) {
      if (centreDistance(space, states[i], states[j]) > reach) continue;
      pair = Math.min(pair, pairGap(space, states[i], states[j]).gap);
    }
  const walls = space.M === 0 ? [] : wallCovectors(space, t);
  let container = Infinity;
  for (const s of states) container = Math.min(container, containerGap(space, s, walls, t));
  return { pair, container };
}

/**
 * Sum of violations below the margin, row by row as in the LP model: for a polygon pair, every vertex
 * of the other piece below the margin against the best separating axis; container rows per point.
 * Zero exactly when every gap is >= margin.
 */
export function violation(space: Space, states: PieceState[], t: number, margin: number): number {
  const rows = collectRows(space, states, t, { below: margin, pairMode: "vertices" });
  let v = 0;
  for (const r of rows) if (r.value < margin) v += margin - r.value;
  return v;
}
