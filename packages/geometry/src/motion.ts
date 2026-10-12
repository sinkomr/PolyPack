import { Contact, TOL, pieceSeparation } from "./overlap";
import { Pose, boundingRadius, inradius } from "./shapes";

/**
 * Interactive moves keep separations above -MOVE_TOL, ten times tighter than TOL, so a board
 * built by hand validates on the server with margin.
 */
export const MOVE_TOL = TOL / 10;

/**
 * Longest translation applied in one substep. The thinnest piece (the triangle) has width 0.866,
 * so a substep can never carry a piece through another one: it penetrates by at most MAX_STEP and
 * the push-out along the contact normal brings it back on the side it came from.
 */
const MAX_STEP = 0.2;

/** Orientation that gives a new piece a horizontal bottom edge. */
export function defaultTheta(N: number): number {
  return N !== 0 && N % 2 === 0 ? Math.PI / N : 0;
}

/** True when the point lies in the closed piece. */
export function pieceContainsPoint(N: number, pose: Pose, x: number, y: number): boolean {
  const dx = x - pose.x;
  const dy = y - pose.y;
  if (N === 0) return dx * dx + dy * dy <= 1;
  const r = inradius(N);
  const step = (2 * Math.PI) / N;
  for (let k = 0; k < N; k++) {
    const ang = pose.theta + Math.PI / 2 + Math.PI / N + k * step;
    if (dx * Math.cos(ang) + dy * Math.sin(ang) > r) return false;
  }
  return true;
}

function split(poses: readonly Pose[], ids: readonly number[]): { moving: Pose[]; fixed: Pose[] } {
  const set = new Set(ids);
  return { moving: ids.map((i) => poses[i]), fixed: poses.filter((_, i) => !set.has(i)) };
}

/** Deepest contact between a moving piece and a fixed piece, or null when none are within reach. */
function deepestContact(N: number, moving: readonly Pose[], fixed: readonly Pose[]): Contact | null {
  const reach = 2 * boundingRadius(N);
  let best: Contact | null = null;
  for (const a of moving) {
    for (const b of fixed) {
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      if (dx * dx + dy * dy > reach * reach) continue;
      const c = pieceSeparation(N, a, b);
      if (!best || c.sep < best.sep) best = c;
    }
  }
  return best;
}

const shifted = (ps: readonly Pose[], ox: number, oy: number): Pose[] =>
  ps.map((p) => ({ x: p.x + ox, y: p.y + oy, theta: p.theta }));

const clear = (N: number, moving: readonly Pose[], fixed: readonly Pose[]): boolean => {
  const c = deepestContact(N, moving, fixed);
  return !c || c.sep >= -MOVE_TOL;
};

/**
 * Translate the pieces `ids` rigidly toward (dx, dy) without ever overlapping the other pieces.
 * The move is taken in substeps. When a substep penetrates, the group is pushed out along the
 * contact normal by exactly the penetration depth, which removes the blocked component of the
 * motion and so slides the group along the blocking edge. If pushing out does not settle (a
 * wedge), the group advances along the straight substep to first contact and stops.
 * Returns the displacement actually applied.
 */
export function slideMove(
  N: number,
  poses: readonly Pose[],
  ids: readonly number[],
  dx: number,
  dy: number,
): { dx: number; dy: number } {
  const dist = Math.hypot(dx, dy);
  if (dist === 0 || ids.length === 0) return { dx: 0, dy: 0 };
  const { moving, fixed } = split(poses, ids);
  const n = Math.ceil(dist / MAX_STEP);
  const sx = dx / n;
  const sy = dy / n;
  let ox = 0;
  let oy = 0;
  for (let s = 0; s < n; s++) {
    let cx = ox + sx;
    let cy = oy + sy;
    let ok = false;
    for (let it = 0; it < 8; it++) {
      const c = deepestContact(N, shifted(moving, cx, cy), fixed);
      if (!c || c.sep >= -MOVE_TOL) {
        ok = true;
        break;
      }
      cx -= c.nx * c.sep;
      cy -= c.ny * c.sep;
    }
    if (ok) {
      ox = cx;
      oy = cy;
      continue;
    }
    // wedge: stop at first contact along the straight substep
    let lo = 0;
    let hi = 1;
    for (let it = 0; it < 40; it++) {
      const f = (lo + hi) / 2;
      if (clear(N, shifted(moving, ox + f * sx, oy + f * sy), fixed)) lo = f;
      else hi = f;
    }
    ox += lo * sx;
    oy += lo * sy;
    break;
  }
  return { dx: ox, dy: oy };
}

/** Pose after rotating by `angle` about the pivot (px, py). */
export function rotatePose(p: Pose, px: number, py: number, angle: number): Pose {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dx = p.x - px;
  const dy = p.y - py;
  return { x: px + c * dx - s * dy, y: py + s * dx + c * dy, theta: p.theta + angle };
}

/**
 * Rotate the pieces `ids` rigidly about a pivot toward `angle` without overlapping the others.
 * The rotation is taken in substeps. When a substep penetrates, the group is pushed out along
 * the contact normal, exactly as in slideMove, so a piece resting against a neighbour can still
 * turn: it is nudged away as its corner swings round. If pushing out does not settle (the piece
 * is wedged), the rotation stops at first contact, found by bisection.
 * Returns the angle applied and the translation of the group (and of its pivot) from the nudges.
 */
export function rotateGroup(
  N: number,
  poses: readonly Pose[],
  ids: readonly number[],
  px: number,
  py: number,
  angle: number,
): { angle: number; dx: number; dy: number } {
  if (angle === 0 || ids.length === 0) return { angle: 0, dx: 0, dy: 0 };
  const { moving, fixed } = split(poses, ids);
  if (fixed.length === 0) return { angle, dx: 0, dy: 0 };
  let reach = 0;
  for (const p of moving) reach = Math.max(reach, Math.hypot(p.x - px, p.y - py));
  reach += boundingRadius(N);
  const n = Math.max(1, Math.ceil((Math.abs(angle) * reach) / MAX_STEP));
  // group rotated by a about the pivot, then translated by (ox, oy)
  const at = (a: number, ox: number, oy: number) => shifted(moving.map((p) => rotatePose(p, px, py, a)), ox, oy);
  let good = 0;
  let ox = 0;
  let oy = 0;
  for (let s = 1; s <= n; s++) {
    const a = (angle * s) / n;
    let cx = ox;
    let cy = oy;
    let ok = false;
    for (let it = 0; it < 8; it++) {
      const c = deepestContact(N, at(a, cx, cy), fixed);
      if (!c || c.sep >= -MOVE_TOL) {
        ok = true;
        break;
      }
      cx -= c.nx * c.sep;
      cy -= c.ny * c.sep;
    }
    if (ok) {
      good = a;
      ox = cx;
      oy = cy;
      continue;
    }
    let lo = good;
    let hi = a;
    for (let it = 0; it < 50; it++) {
      const mid = (lo + hi) / 2;
      if (clear(N, at(mid, ox, oy), fixed)) lo = mid;
      else hi = mid;
    }
    return { angle: lo, dx: ox, dy: oy };
  }
  return { angle, dx: ox, dy: oy };
}

/**
 * Distance the pieces `ids` can travel along the unit direction (ux, uy) until first contact.
 * Returns 0 when nothing is in the way within maxDist.
 *
 * Conservative advancement on the separating axis of each pair. If the axis normal n (the
 * direction that separates the moving piece) has n . u >= 0, moving along u cannot close the gap
 * on that axis, so the pair can never collide and is ignored. Otherwise the gap closes at rate
 * -(n . u), so advancing by sep / -(n . u) is safe. Repeating converges to contact.
 */
export function snapDistance(
  N: number,
  poses: readonly Pose[],
  ids: readonly number[],
  ux: number,
  uy: number,
  maxDist = 1000,
): number {
  const { moving, fixed } = split(poses, ids);
  let t = 0;
  for (let it = 0; it < 500; it++) {
    let advance = Infinity;
    for (const m of moving) {
      const a = { x: m.x + t * ux, y: m.y + t * uy, theta: m.theta };
      for (const b of fixed) {
        const c = pieceSeparation(N, a, b);
        const closing = -(c.nx * ux + c.ny * uy);
        if (closing <= 1e-9) continue;
        advance = Math.min(advance, Math.max(c.sep, 0) / closing);
      }
    }
    if (advance === Infinity) return 0;
    if (advance <= 1e-13) return t;
    t += advance;
    if (t > maxDist) return 0;
  }
  return t;
}

/**
 * A pose near (x, y) where a new piece overlaps nothing. Candidates are tried on rings of
 * growing radius, spaced a little more than one piece apart.
 */
export function findFreeSpot(N: number, poses: readonly Pose[], x: number, y: number): Pose {
  const theta = defaultTheta(N);
  const d = 2 * boundingRadius(N) * 1.05;
  for (let ring = 0; ring < 200; ring++) {
    const count = ring === 0 ? 1 : 6 * ring;
    for (let k = 0; k < count; k++) {
      const ang = (2 * Math.PI * k) / count;
      const cand = { x: x + ring * d * Math.cos(ang), y: y + ring * d * Math.sin(ang), theta };
      if (clear(N, [cand], poses)) return cand;
    }
  }
  return { x: x + 200 * d, y, theta };
}
