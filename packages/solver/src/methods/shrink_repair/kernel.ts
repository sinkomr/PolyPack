// Allocation-free overlap kernels for the repair's inner loops. They compute the same quantities
// as the shared `pairPenetration` and `visitContainerProtrusions` (support form) with the same
// separating axes, support formula and derivative of the selected branch, rearranged for speed:
//
// - Pair. Along edge normal k of piece p, at angle theta_p + pi/2 + pi/N + k step (step = 2 pi/N),
//   the other piece q reaches R cos(delta), delta the angle between -u_k and q's nearest vertex
//   direction. Consecutive edge normals differ by exactly the vertex spacing, so delta is the
//   same for all N edges of one pass: one cosine per pass instead of one per axis. A separating
//   axis (separation >= 0) ends the depth-only test at once.
// - Walls. The furthest vertex of a regular polygon along a wall normal is the vertex nearest in
//   angle to it; a wall that the piece's bounding disk cannot reach is skipped.
//
// Results agree with the shared functions to rounding (tested in shrink_repair.test.ts). The
// strict verdicts of the method never come from here: legalisation and scoring use the shared
// findOverlaps and evaluate.
import { boundingRadius, containerInradius, DISK_RADIUS, pieceInradius } from "@polypack/geometry";

/** Distance from `rel` to the nearest multiple of `step`, in [0, step / 2]. */
function offset(rel: number, step: number): number {
  let t = rel % step;
  if (t < 0) t += step;
  return t > step / 2 ? step - t : t;
}

export class Kernel {
  readonly N: number;
  readonly M: number;
  readonly R: number;
  readonly r: number;
  readonly step: number;
  /** Derivatives of the last depthGradient: of the depth with respect to the poses of a and b. */
  ax = 0;
  ay = 0;
  at = 0;
  bx = 0;
  by = 0;
  bt = 0;
  /** Last wall pass: sum of squared protrusions, the deepest one and the gradient of the sum. */
  wallSum = 0;
  wallMax = 0;
  wx = 0;
  wy = 0;
  wt = 0;
  private readonly baseCos: Float64Array;
  private readonly baseSin: Float64Array;
  private readonly wallCos: Float64Array;
  private readonly wallSin: Float64Array;
  private readonly wallAngle: Float64Array;

  constructor(N: number, M: number) {
    this.N = N;
    this.M = M;
    this.R = boundingRadius(N);
    this.r = pieceInradius(N);
    this.step = N === 0 ? 2 * Math.PI : (2 * Math.PI) / N;
    this.baseCos = new Float64Array(N);
    this.baseSin = new Float64Array(N);
    for (let k = 0; k < N; k++) {
      const angle = Math.PI / 2 + Math.PI / N + k * this.step;
      this.baseCos[k] = Math.cos(angle);
      this.baseSin[k] = Math.sin(angle);
    }
    // Container wall normals at phi = 0, in the shared order (wall 0 is the bottom edge).
    this.wallCos = new Float64Array(M);
    this.wallSin = new Float64Array(M);
    this.wallAngle = new Float64Array(M);
    for (let j = 0; j < M; j++) {
      const angle = -Math.PI / 2 + (2 * Math.PI * j) / M;
      this.wallAngle[j] = angle;
      this.wallCos[j] = Math.cos(angle);
      this.wallSin[j] = Math.sin(angle);
    }
  }

  /** Edge normals of a piece at angle theta, as [ux0, uy0, ux1, uy1, ...] (length 2N). */
  normals(theta: number, out: Float64Array): void {
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    for (let k = 0; k < this.N; k++) {
      out[2 * k] = c * this.baseCos[k] - s * this.baseSin[k];
      out[2 * k + 1] = s * this.baseCos[k] + c * this.baseSin[k];
    }
  }

  /**
   * Penetration depth of pieces a and b when they overlap, otherwise 0 (it may stop at the
   * first separating axis). ua and ub are the pieces' edge normals from `normals`.
   */
  depth(
    xa: number,
    ya: number,
    ta: number,
    ua: Float64Array,
    xb: number,
    yb: number,
    tb: number,
    ub: Float64Array,
  ): number {
    const dx = xb - xa;
    const dy = yb - ya;
    if (this.N === 0) {
      const d = 2 * this.R - Math.hypot(dx, dy);
      return d > 0 ? d : 0;
    }
    const { N, r, R, step } = this;
    const extra = Math.PI + Math.PI / N;
    const ca = r + R * Math.cos(offset(ta - tb + extra, step));
    let best = -Infinity;
    for (let k = 0; k < N; k++) {
      const s = dx * ua[2 * k] + dy * ua[2 * k + 1] - ca;
      if (s >= 0) return 0;
      if (s > best) best = s;
    }
    const cb = r + R * Math.cos(offset(tb - ta + extra, step));
    for (let k = 0; k < N; k++) {
      const s = -(dx * ub[2 * k] + dy * ub[2 * k + 1]) - cb;
      if (s >= 0) return 0;
      if (s > best) best = s;
    }
    return -best;
  }

  /**
   * Signed penetration depth of a and b (positive: overlap) and, when positive, its derivatives
   * with respect to both poses in ax..bt, those of the selected separating-axis branch as in the
   * shared pairPenetration.
   */
  depthGradient(
    xa: number,
    ya: number,
    ta: number,
    ua: Float64Array,
    xb: number,
    yb: number,
    tb: number,
    ub: Float64Array,
  ): number {
    const dx = xb - xa;
    const dy = yb - ya;
    if (this.N === 0) {
      const distance = Math.hypot(dx, dy);
      // Coincident centres: a bounded subgradient that separates them, as in the shared code.
      const ux = distance === 0 ? 1 : -dx / distance;
      const uy = distance === 0 ? 0 : -dy / distance;
      this.ax = -ux;
      this.ay = -uy;
      this.at = 0;
      this.bx = ux;
      this.by = uy;
      this.bt = 0;
      return 2 * this.R - distance;
    }
    const { N, r, R, step } = this;
    const extra = Math.PI + Math.PI / N;
    const relA = ta - tb + extra;
    const relB = tb - ta + extra;
    const ca = r + R * Math.cos(offset(relA, step));
    const cb = r + R * Math.cos(offset(relB, step));
    let best = -Infinity;
    let pass = 0;
    let edge = 0;
    for (let k = 0; k < N; k++) {
      const s = dx * ua[2 * k] + dy * ua[2 * k + 1] - ca;
      if (s > best) {
        best = s;
        edge = k;
      }
    }
    for (let k = 0; k < N; k++) {
      const s = -(dx * ub[2 * k] + dy * ub[2 * k + 1]) - cb;
      if (s > best) {
        best = s;
        pass = 1;
        edge = k;
      }
    }
    if (!(best < 0)) return -best;
    // Edge piece p, vertex piece q; d = q - p.
    const ux = pass === 0 ? ua[2 * edge] : ub[2 * edge];
    const uy = pass === 0 ? ua[2 * edge + 1] : ub[2 * edge + 1];
    const qt = pass === 0 ? tb : ta;
    const rel = (pass === 0 ? relA : relB) + edge * step;
    const vertex = Math.round(rel / step);
    const vertexAngle = qt + Math.PI / 2 + vertex * step;
    const vx = R * Math.cos(vertexAngle);
    const vy = R * Math.sin(vertexAngle);
    const ddx = pass === 0 ? dx : -dx;
    const ddy = pass === 0 ? dy : -dy;
    const pt = (ddx + vx) * uy - (ddy + vy) * ux;
    const qtheta = vy * ux - vx * uy;
    if (pass === 0) {
      this.ax = ux;
      this.ay = uy;
      this.at = pt;
      this.bx = -ux;
      this.by = -uy;
      this.bt = qtheta;
    } else {
      this.bx = ux;
      this.by = uy;
      this.bt = pt;
      this.ax = -ux;
      this.ay = -uy;
      this.at = qtheta;
    }
    return -best;
  }

  /**
   * Squared protrusions of one piece through the walls of a container of size `size` centred at
   * the origin with phi = 0, in support form (the furthest vertex per polygon wall; for a
   * circular container the furthest vertex from the centre). Sets wallSum, wallMax and, with
   * `gradient`, the derivatives of wallSum in wx, wy, wt.
   */
  walls(x: number, y: number, theta: number, size: number, gradient: boolean): void {
    this.wallSum = 0;
    this.wallMax = 0;
    this.wx = 0;
    this.wy = 0;
    this.wt = 0;
    const { N, M, R, step } = this;
    // radius of the circle container, or the apothem of a polygon container
    const limit = size * containerInradius(M);
    if (M === 0) {
      const distance = Math.hypot(x, y);
      if (distance + R <= limit) return;
      let px = x;
      let py = y;
      let ox = 0;
      let oy = 0;
      if (N !== 0) {
        // The vertex nearest in angle to the centre's direction is the furthest from the centre.
        const a0 = theta + Math.PI / 2;
        const vertex = Math.round(((distance === 0 ? 0 : Math.atan2(y, x)) - a0) / step);
        const angle = a0 + vertex * step;
        ox = R * Math.cos(angle);
        oy = R * Math.sin(angle);
        px += ox;
        py += oy;
      }
      const reach = Math.hypot(px, py);
      const depth = reach + (N === 0 ? DISK_RADIUS : 0) - limit;
      if (!(depth > 0)) return;
      this.wallSum = depth * depth;
      this.wallMax = depth;
      if (gradient) {
        const ux = reach === 0 ? 1 : px / reach;
        const uy = reach === 0 ? 0 : py / reach;
        this.wx = 2 * depth * ux;
        this.wy = 2 * depth * uy;
        this.wt = 2 * depth * (ox * uy - oy * ux);
      }
      return;
    }
    const a0 = theta + Math.PI / 2;
    for (let j = 0; j < M; j++) {
      const wx = this.wallCos[j];
      const wy = this.wallSin[j];
      const h = x * wx + y * wy;
      if (h + R <= limit) continue;
      let depth: number;
      let ox = 0;
      let oy = 0;
      if (N === 0) depth = h + DISK_RADIUS - limit;
      else {
        const vertex = Math.round((this.wallAngle[j] - a0) / step);
        const angle = a0 + vertex * step;
        ox = R * Math.cos(angle);
        oy = R * Math.sin(angle);
        depth = h + ox * wx + oy * wy - limit;
      }
      if (!(depth > 0)) continue;
      this.wallSum += depth * depth;
      if (depth > this.wallMax) this.wallMax = depth;
      if (gradient) {
        this.wx += 2 * depth * wx;
        this.wy += 2 * depth * wy;
        this.wt += 2 * depth * (ox * wy - oy * wx);
      }
    }
  }
}
