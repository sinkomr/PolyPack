import { Pose, boundingRadius, pieceVertices } from "@polypack/geometry";

export type SnapMode = "off" | "corners" | "edges" | "both";
export interface SnapPoint {
  x: number;
  y: number;
}
export interface MagneticSnap {
  dx: number;
  dy: number;
  /** Rotation about the selected piece's centre; groups only translate. */
  angle: number;
  kind: "corner" | "corner-edge" | "edge";
  guide: SnapPoint[];
  cost: number;
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const MAX_ALIGN_ANGLE = Math.PI / 30;
const point = (v: Float64Array, k: number): SnapPoint => ({ x: v[2 * k], y: v[2 * k + 1] });
const midpoint = (a: SnapPoint, b: SnapPoint): SnapPoint => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Nearby feature targets only. The Board must validate the whole motion before applying one. */
export function magneticCandidates(
  N: number,
  poses: readonly Pose[],
  ids: readonly number[],
  radius: number,
  mode: SnapMode,
): MagneticSnap[] {
  if (N === 0 || mode === "off" || !ids.length || !(radius > 0)) return [];
  const selected = new Set(ids);
  const candidates: MagneticSnap[] = [];
  const add = (dx: number, dy: number, kind: MagneticSnap["kind"], guide: SnapPoint[], angle = 0) => {
    // Include the furthest vertex's rotational travel, so large polygons cannot leap to a face.
    const travel = Math.hypot(dx, dy) + 2 * boundingRadius(N) * Math.sin(Math.abs(angle) / 2);
    // Rank a capturable face alignment first: a bare corner snap is always a shorter move (it has no
    // rotational travel), so by travel alone it would win every time and faces would never align.
    const bias = kind === "corner-edge" ? radius / 2 : kind === "edge" ? -radius : 0;
    if (travel <= radius) candidates.push({ dx, dy, angle, kind, guide, cost: travel + bias });
  };
  const project = (p: SnapPoint, a: SnapPoint, b: SnapPoint): SnapPoint | null => {
    const ex = b.x - a.x,
      ey = b.y - a.y;
    const t = ((p.x - a.x) * ex + (p.y - a.y) * ey) / (ex * ex + ey * ey);
    return t > 0 && t < 1 ? { x: a.x + t * ex, y: a.y + t * ey } : null;
  };
  for (let j = 0; j < poses.length; j++) {
    if (selected.has(j)) continue;
    let fixed: Float64Array | undefined;
    for (const i of ids) {
      const movingPose = poses[i];
      if (Math.hypot(movingPose.x - poses[j].x, movingPose.y - poses[j].y) > 2 * boundingRadius(N) + radius) continue;
      fixed ??= pieceVertices(N, poses[j]);
      const moving = pieceVertices(N, movingPose);
      for (let a = 0; a < N; a++) {
        const p = point(moving, a),
          pn = point(moving, (a + 1) % N);
        for (let b = 0; b < N; b++) {
          const q = point(fixed, b),
            qn = point(fixed, (b + 1) % N);
          if (mode === "corners" || mode === "both") add(q.x - p.x, q.y - p.y, "corner", [q]);
          if (mode === "edges" || mode === "both") {
            const onFixed = project(p, q, qn);
            if (onFixed) add(onFixed.x - p.x, onFixed.y - p.y, "corner-edge", [q, qn, onFixed]);
            const onMoving = project(q, p, pn);
            if (onMoving) add(q.x - onMoving.x, q.y - onMoving.y, "corner-edge", [q]);
            // CCW edges must face opposite ways for exterior face-to-face contact.
            const angle = wrap(Math.atan2(q.y - qn.y, q.x - qn.x) - Math.atan2(pn.y - p.y, pn.x - p.x));
            if (Math.abs(angle) > MAX_ALIGN_ANGLE || (ids.length > 1 && Math.abs(angle) > 1e-10)) continue;
            const pm = midpoint(p, pn),
              qm = midpoint(q, qn);
            const c = Math.cos(angle),
              s = Math.sin(angle);
            const rx = movingPose.x + c * (pm.x - movingPose.x) - s * (pm.y - movingPose.y);
            const ry = movingPose.y + s * (pm.x - movingPose.x) + c * (pm.y - movingPose.y);
            add(qm.x - rx, qm.y - ry, "edge", [q, qn], ids.length === 1 ? angle : 0);
          }
        }
      }
    }
  }
  return candidates.sort((a, b) => a.cost - b.cost);
}
