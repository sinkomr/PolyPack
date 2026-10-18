// Repair phase of shrink_repair: at a fixed container, minimise the weighted sum of squared pair
// penetrations and squared wall protrusions, with per-piece relocation by sampling, local descent
// and guided-local-search weights. The overlap measures and their analytic derivatives are the
// shared ones (`pairPenetration`, `visitContainerProtrusions`), so "zero" here is the same zero
// the strict verifier tests. See docs/methods/shrink_repair.md.
import {
  boundingRadius,
  inradius,
  pairPenetration,
  penaltyContainerNormals,
  penaltyEdgeNormals,
  visitContainerProtrusions,
  type Container,
  type Pose,
  type ProtrusionVisitor,
} from "@polypack/geometry";
import { gaussian } from "../harden/dynamics";

/** A state is feasible for the repair when no pair penetrates and no piece protrudes by more than this. */
export const SUCCESS_DEPTH = 1e-10;

export interface RepairSettings {
  /** Uniform samples over the whole container per relocation. */
  globalSamples: number;
  /** Samples near the current and the best pose per relocation. */
  localSamples: number;
  /** Multiplier of the GLS weight of the deepest conflict; shallower conflicts get less. */
  weightGrowth: number;
  /** Factor applied to the weight of a pair or wall that no longer conflicts (weights never fall below 1). */
  weightDecay: number;
  /** L-BFGS iterations of one global descent. */
  descentIterations: number;
}

/** L-BFGS memory of the global descent. */
const MEMORY = 8;
/** Gradient steps of the descent that follows a relocation of one piece. */
const REFINE_STEPS = 10;
/** Weights are rescaled when one exceeds this, to keep the objective finite. */
const WEIGHT_CEILING = 1e12;

/**
 * Working state of the repair: poses in the frame of a container centred at the origin with a
 * horizontal bottom edge (phi = 0), whose size is fixed during one repair.
 *
 * Objective  F = sum_pairs w_ij d_ij^2 + sum_i v_i sum_walls p_ik^2,
 * with d_ij = max(0, penetration depth) of the true pieces and p_ik = max(0, protrusion of piece i
 * through wall k) in the support form (furthest vertex per wall). The unweighted sum of the same
 * terms is the raw overlap that decides success, strikes and restoration.
 */
export class RepairState {
  readonly N: number;
  readonly M: number;
  readonly P: number;
  readonly poses: Pose[];
  readonly container: Container;
  /** Bounding radius, inradius (1 for a circle) and symmetry period of a piece. */
  readonly R: number;
  readonly rin: number;
  readonly period: number;
  /** Apothem of the container per unit size (1 for a circle). */
  readonly apothem: number;
  /** Counted pair and wall feature tests since the caller last reset it. */
  work = 0;
  /** Raw overlap, weighted objective and deepest violation of the last full evaluation. */
  raw = 0;
  value = 0;
  maxDepth = 0;
  /** Deepest pair penetration (walls excluded) of the last full evaluation. */
  maxPairDepth = 0;

  private readonly settings: RepairSettings;
  private readonly axes: Float64Array[];
  private readonly containerAxes: Float64Array;
  private readonly scratch: Float64Array;
  private readonly pairWeight: Float64Array;
  private readonly wallWeight: Float64Array;
  private readonly activePairs = new Set<number>();
  private readonly activeWalls = new Set<number>();
  private readonly stamp: Uint32Array;
  private stampValue = 0;
  // Uniform grid of cell lists over the container's bounding box; pieces outside are clamped
  // into the border cells, which keeps every pair within reach in adjacent cells.
  private cellSize = 1;
  private gridOrigin = 0;
  private G = 1;
  private head = new Int32Array(1);
  private readonly next: Int32Array;
  private readonly prev: Int32Array;
  private readonly cellOf: Int32Array;
  // Pairs within reach of the last full evaluation, with their depths.
  private pairI = new Int32Array(64);
  private pairJ = new Int32Array(64);
  private pairD = new Float64Array(64);
  private pairCount = 0;
  private readonly wallDepth: Float64Array;
  // Wall visitor accumulators.
  private wSum = 0;
  private wMax = 0;
  private wgx = 0;
  private wgy = 0;
  private wgt = 0;
  private readonly visitor: ProtrusionVisitor;
  // Candidate pose and its edge axes for sampling.
  private readonly candidate: Pose = { x: 0, y: 0, theta: 0 };
  private readonly candidateAxes: Float64Array;
  private readonly trialAxes: Float64Array;
  private readonly pairCost: number;
  private readonly wallCost: number;

  constructor(problem: { N: number; M: number; P: number }, settings: RepairSettings) {
    this.N = problem.N;
    this.M = problem.M;
    this.P = problem.P;
    this.settings = settings;
    const { N, M, P } = this;
    this.poses = Array.from({ length: P }, () => ({ x: 0, y: 0, theta: 0 }));
    this.container = { M, cx: 0, cy: 0, phi: 0, size: 1 };
    this.R = boundingRadius(N);
    this.rin = N === 0 ? 1 : inradius(N);
    this.period = N === 0 ? 2 * Math.PI : (2 * Math.PI) / N;
    this.apothem = M === 0 ? 1 : inradius(M);
    this.axes = N === 0 ? [] : Array.from({ length: P }, () => new Float64Array(3 * N));
    this.candidateAxes = new Float64Array(3 * Math.max(N, 1));
    this.trialAxes = new Float64Array(3 * Math.max(N, 1));
    this.containerAxes = M === 0 ? new Float64Array(0) : penaltyContainerNormals(M, 0);
    this.scratch = new Float64Array(2 * (N + M));
    this.pairWeight = new Float64Array(P * P).fill(1);
    this.wallWeight = new Float64Array(P).fill(1);
    this.stamp = new Uint32Array(P * P);
    this.next = new Int32Array(P);
    this.prev = new Int32Array(P);
    this.cellOf = new Int32Array(P);
    this.wallDepth = new Float64Array(P);
    this.pairCost = N === 0 ? 1 : 2 * N;
    this.wallCost = M === 0 ? Math.max(1, N) : M;
    this.visitor = (depth, px, py, pt) => {
      if (!(depth > 0)) return;
      this.wSum += depth * depth;
      if (depth > this.wMax) this.wMax = depth;
      this.wgx += 2 * depth * px;
      this.wgy += 2 * depth * py;
      this.wgt += 2 * depth * pt;
    };
  }

  // ---------------------------------------------------------------------------------------------
  // State

  /** Set the container size and rebuild the grid for it. */
  setSize(size: number): void {
    this.container.size = size;
    // Half-width of the container's bounding box: its circumradius (radius for a circle).
    const half = this.M === 0 ? size : size / (2 * Math.sin(Math.PI / this.M));
    this.cellSize = 2 * this.R;
    const span = 2 * (half + this.R);
    this.G = Math.max(1, Math.min(256, Math.ceil(span / this.cellSize)));
    this.gridOrigin = -this.G * this.cellSize * 0.5;
    if (this.head.length !== this.G * this.G) this.head = new Int32Array(this.G * this.G);
    this.rebuildGrid();
  }

  /** Copy poses in (angles reduced to one symmetry period) and refresh caches. */
  load(pieces: readonly Pose[]): void {
    for (let i = 0; i < this.P; i++) {
      this.poses[i].x = pieces[i].x;
      this.poses[i].y = pieces[i].y;
      this.poses[i].theta = this.N === 0 ? 0 : this.wrap(pieces[i].theta);
      this.refreshAxes(i);
    }
    this.rebuildGrid();
  }

  snapshot(): Pose[] {
    return this.poses.map((p) => ({ x: p.x, y: p.y, theta: p.theta }));
  }

  /** Reset every GLS weight to 1. */
  resetWeights(): void {
    for (const key of this.activePairs) this.pairWeight[key] = 1;
    for (const i of this.activeWalls) this.wallWeight[i] = 1;
    this.activePairs.clear();
    this.activeWalls.clear();
  }

  private wrap(theta: number): number {
    const t = theta % this.period;
    return t < 0 ? t + this.period : t;
  }

  private refreshAxes(i: number): void {
    if (this.N !== 0) penaltyEdgeNormals(this.N, this.poses[i].theta, this.axes[i]);
  }

  private cellIndex(x: number, y: number): number {
    const G = this.G;
    let cx = Math.floor((x - this.gridOrigin) / this.cellSize);
    let cy = Math.floor((y - this.gridOrigin) / this.cellSize);
    // Non-finite coordinates go to cell 0; they never occur in a state the method keeps.
    if (!(cx >= 0)) cx = 0;
    else if (cx >= G) cx = G - 1;
    if (!(cy >= 0)) cy = 0;
    else if (cy >= G) cy = G - 1;
    return cy * G + cx;
  }

  private rebuildGrid(): void {
    this.head.fill(-1);
    for (let i = 0; i < this.P; i++) this.insert(i);
    this.work += this.P;
  }

  private insert(i: number): void {
    const c = this.cellIndex(this.poses[i].x, this.poses[i].y);
    this.cellOf[i] = c;
    const first = this.head[c];
    this.next[i] = first;
    this.prev[i] = -1;
    if (first >= 0) this.prev[first] = i;
    this.head[c] = i;
  }

  private remove(i: number): void {
    const n = this.next[i];
    const p = this.prev[i];
    if (p >= 0) this.next[p] = n;
    else this.head[this.cellOf[i]] = n;
    if (n >= 0) this.prev[n] = p;
  }

  /** Place piece i at a pose and keep the grid and caches current. */
  place(i: number, pose: Pose): void {
    const p = this.poses[i];
    p.x = pose.x;
    p.y = pose.y;
    p.theta = this.N === 0 ? 0 : this.wrap(pose.theta);
    this.refreshAxes(i);
    const c = this.cellIndex(p.x, p.y);
    if (c !== this.cellOf[i]) {
      this.remove(i);
      this.insert(i);
    }
  }

  /** Scale every centre about the container centre (the origin). */
  scaleCentres(factor: number): void {
    for (const p of this.poses) {
      p.x *= factor;
      p.y *= factor;
    }
    this.rebuildGrid();
  }

  // ---------------------------------------------------------------------------------------------
  // Walls

  /** Unweighted wall terms of one pose into wSum, wMax and the gradient accumulators. */
  private walls(pose: Pose): void {
    this.wSum = 0;
    this.wMax = 0;
    this.wgx = 0;
    this.wgy = 0;
    this.wgt = 0;
    // A piece whose bounding disk lies inside the container's inscribed circle touches no wall.
    if (Math.hypot(pose.x, pose.y) + this.R <= this.apothem * this.container.size) return;
    this.work += this.wallCost;
    // Support form for polygon containers: one constraint per wall, at the piece's furthest vertex.
    visitContainerProtrusions(
      this.N,
      pose,
      this.container,
      this.visitor,
      true,
      this.scratch,
      this.M === 0 ? undefined : this.containerAxes,
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Full objective

  private pushPair(i: number, j: number): void {
    if (this.pairCount === this.pairI.length) {
      const grow = (a: Int32Array) => {
        const b = new Int32Array(2 * a.length);
        b.set(a);
        return b;
      };
      this.pairI = grow(this.pairI);
      this.pairJ = grow(this.pairJ);
      const d = new Float64Array(2 * this.pairD.length);
      d.set(this.pairD);
      this.pairD = d;
    }
    this.pairI[this.pairCount] = i;
    this.pairJ[this.pairCount] = j;
    this.pairCount++;
  }

  /** List every pair whose centres are within twice the bounding radius (i < j). */
  private collectPairs(): void {
    this.pairCount = 0;
    const { G, head, next, poses } = this;
    const reach2 = 4 * this.R * this.R;
    for (let i = 0; i < this.P; i++) {
      const a = poses[i];
      const c = this.cellOf[i];
      const cx = c % G;
      const cy = (c - cx) / G;
      for (let gy = Math.max(0, cy - 1); gy <= Math.min(G - 1, cy + 1); gy++) {
        for (let gx = Math.max(0, cx - 1); gx <= Math.min(G - 1, cx + 1); gx++) {
          for (let j = head[gy * G + gx]; j >= 0; j = next[j]) {
            if (j <= i) continue;
            const dx = a.x - poses[j].x;
            const dy = a.y - poses[j].y;
            if (dx * dx + dy * dy <= reach2) this.pushPair(i, j);
          }
        }
      }
    }
    this.work += this.P;
  }

  /**
   * Evaluate the weighted objective at the current poses; with `gradient` (length 3P) also its
   * gradient. Updates raw, value, maxDepth, the pair list with depths and the wall depths.
   */
  evaluate(gradient?: Float64Array): number {
    const { N, P, poses, axes, pairWeight, wallWeight } = this;
    if (gradient) gradient.fill(0);
    this.collectPairs();
    let value = 0;
    let raw = 0;
    let maxPair = 0;
    for (let k = 0; k < this.pairCount; k++) {
      const i = this.pairI[k];
      const j = this.pairJ[k];
      const hit = pairPenetration(N, poses[i], poses[j], axes[i], axes[j]);
      const d = hit.depth;
      this.pairD[k] = d;
      if (!(d > 0)) continue;
      const w = pairWeight[i * P + j];
      raw += d * d;
      value += w * d * d;
      if (d > maxPair) maxPair = d;
      if (gradient) {
        const f = 2 * w * d;
        gradient[3 * i] += f * hit.a.x;
        gradient[3 * i + 1] += f * hit.a.y;
        gradient[3 * i + 2] += f * hit.a.theta;
        gradient[3 * j] += f * hit.b.x;
        gradient[3 * j + 1] += f * hit.b.y;
        gradient[3 * j + 2] += f * hit.b.theta;
      }
    }
    this.work += this.pairCount * this.pairCost;
    let maxWall = 0;
    for (let i = 0; i < P; i++) {
      this.walls(poses[i]);
      this.wallDepth[i] = this.wMax;
      if (this.wSum === 0) continue;
      const v = wallWeight[i];
      raw += this.wSum;
      value += v * this.wSum;
      if (this.wMax > maxWall) maxWall = this.wMax;
      if (gradient) {
        gradient[3 * i] += v * this.wgx;
        gradient[3 * i + 1] += v * this.wgy;
        gradient[3 * i + 2] += v * this.wgt;
      }
    }
    this.work += P;
    if (gradient && N === 0) for (let i = 0; i < P; i++) gradient[3 * i + 2] = 0;
    this.raw = raw;
    this.value = value;
    this.maxPairDepth = maxPair;
    this.maxDepth = Math.max(maxPair, maxWall);
    return value;
  }

  /** True when the last evaluation found nothing deeper than SUCCESS_DEPTH. */
  feasible(): boolean {
    return this.maxDepth <= SUCCESS_DEPTH;
  }

  /** Pieces in conflict at the last evaluation, in index order. */
  conflicting(): number[] {
    const hit = new Uint8Array(this.P);
    for (let k = 0; k < this.pairCount; k++) {
      if (this.pairD[k] > SUCCESS_DEPTH) {
        hit[this.pairI[k]] = 1;
        hit[this.pairJ[k]] = 1;
      }
    }
    for (let i = 0; i < this.P; i++) if (this.wallDepth[i] > SUCCESS_DEPTH) hit[i] = 1;
    const out: number[] = [];
    for (let i = 0; i < this.P; i++) if (hit[i]) out.push(i);
    return out;
  }

  /**
   * Guided local search: multiply the weight of every pair and wall still in conflict at the
   * last evaluation by between 1 + (growth - 1) / 5 (shallowest) and `growth` (deepest), and
   * decay the weights of former conflicts towards 1.
   */
  updateWeights(): void {
    const growth = this.settings.weightGrowth;
    const low = 1 + (growth - 1) / 5;
    const decay = this.settings.weightDecay;
    const deepest = this.maxDepth;
    if (!(deepest > 0)) return;
    this.stampValue++;
    if (this.stampValue === 0xffffffff) {
      this.stamp.fill(0);
      this.stampValue = 1;
    }
    let ceiling = 0;
    for (let k = 0; k < this.pairCount; k++) {
      const d = this.pairD[k];
      if (!(d > SUCCESS_DEPTH)) continue;
      const key = this.pairI[k] * this.P + this.pairJ[k];
      const w = this.pairWeight[key] * (low + ((growth - low) * d) / deepest);
      this.pairWeight[key] = w;
      if (w > ceiling) ceiling = w;
      this.stamp[key] = this.stampValue;
      this.activePairs.add(key);
    }
    for (const key of this.activePairs) {
      if (this.stamp[key] === this.stampValue) continue;
      const w = Math.max(1, this.pairWeight[key] * decay);
      this.pairWeight[key] = w;
      if (w === 1) this.activePairs.delete(key);
    }
    for (let i = 0; i < this.P; i++) {
      const d = this.wallDepth[i];
      if (d > SUCCESS_DEPTH) {
        const w = this.wallWeight[i] * (low + ((growth - low) * d) / deepest);
        this.wallWeight[i] = w;
        if (w > ceiling) ceiling = w;
        this.activeWalls.add(i);
      } else if (this.activeWalls.has(i)) {
        const w = Math.max(1, this.wallWeight[i] * decay);
        this.wallWeight[i] = w;
        if (w === 1) this.activeWalls.delete(i);
      }
    }
    if (ceiling > WEIGHT_CEILING) {
      // Only ratios matter to the search; keep the numbers finite.
      const f = 1 / Math.sqrt(ceiling);
      for (const key of this.activePairs) this.pairWeight[key] = Math.max(1, this.pairWeight[key] * f);
      for (const i of this.activeWalls) this.wallWeight[i] = Math.max(1, this.wallWeight[i] * f);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // One piece

  /**
   * Weighted loss of piece i placed at `pose` (axes: its edge normals) against every other piece
   * at its current pose and the walls. Stops early once the loss reaches `cutoff`.
   */
  pieceLoss(i: number, pose: Pose, axes: Float64Array, cutoff: number): number {
    const { G, head, next, poses, P, N } = this;
    let loss = 0;
    this.walls(pose);
    if (this.wSum > 0) {
      loss += this.wallWeight[i] * this.wSum;
      if (loss >= cutoff) return loss;
    }
    const reach2 = 4 * this.R * this.R;
    const c = this.cellIndex(pose.x, pose.y);
    const cx = c % G;
    const cy = (c - cx) / G;
    let tests = 0;
    for (let gy = Math.max(0, cy - 1); gy <= Math.min(G - 1, cy + 1); gy++) {
      for (let gx = Math.max(0, cx - 1); gx <= Math.min(G - 1, cx + 1); gx++) {
        for (let j = head[gy * G + gx]; j >= 0; j = next[j]) {
          if (j === i) continue;
          const q = poses[j];
          const dx = pose.x - q.x;
          const dy = pose.y - q.y;
          if (dx * dx + dy * dy > reach2) continue;
          tests++;
          const d = pairPenetration(N, pose, q, axes, this.axes[j]).depth;
          if (!(d > 0)) continue;
          loss += this.pairWeight[i < j ? i * P + j : j * P + i] * d * d;
          if (loss >= cutoff) {
            this.work += tests * this.pairCost;
            return loss;
          }
        }
      }
    }
    this.work += tests * this.pairCost;
    return loss;
  }

  /** Weighted loss of piece i at `pose` and its gradient with respect to that pose. */
  private pieceGradient(i: number, pose: Pose, axes: Float64Array, g: Float64Array): number {
    const { G, head, next, poses, P, N } = this;
    g[0] = 0;
    g[1] = 0;
    g[2] = 0;
    let loss = 0;
    this.walls(pose);
    if (this.wSum > 0) {
      const v = this.wallWeight[i];
      loss += v * this.wSum;
      g[0] += v * this.wgx;
      g[1] += v * this.wgy;
      g[2] += v * this.wgt;
    }
    const reach2 = 4 * this.R * this.R;
    const c = this.cellIndex(pose.x, pose.y);
    const cx = c % G;
    const cy = (c - cx) / G;
    let tests = 0;
    for (let gy = Math.max(0, cy - 1); gy <= Math.min(G - 1, cy + 1); gy++) {
      for (let gx = Math.max(0, cx - 1); gx <= Math.min(G - 1, cx + 1); gx++) {
        for (let j = head[gy * G + gx]; j >= 0; j = next[j]) {
          if (j === i) continue;
          const q = poses[j];
          const dx = pose.x - q.x;
          const dy = pose.y - q.y;
          if (dx * dx + dy * dy > reach2) continue;
          tests++;
          const hit = pairPenetration(N, pose, q, axes, this.axes[j]);
          const d = hit.depth;
          if (!(d > 0)) continue;
          const w = this.pairWeight[i < j ? i * P + j : j * P + i];
          loss += w * d * d;
          g[0] += 2 * w * d * hit.a.x;
          g[1] += 2 * w * d * hit.a.y;
          g[2] += 2 * w * d * hit.a.theta;
        }
      }
    }
    this.work += tests * this.pairCost;
    if (N === 0) g[2] = 0;
    return loss;
  }

  /** Uniform centre inside the container, at least `margin` from every wall. */
  private sampleCentre(random: () => number, out: Pose): void {
    const s = this.container.size;
    if (this.M === 0) {
      const radius = Math.max(0, s - this.rin) * Math.sqrt(random());
      const angle = 2 * Math.PI * random();
      out.x = radius * Math.cos(angle);
      out.y = radius * Math.sin(angle);
      return;
    }
    const limit = Math.max(0, this.apothem * s - this.rin);
    const half = limit / Math.cos(Math.PI / this.M);
    // Rejection from the bounding square of the shrunken polygon; acceptance is above 0.4.
    for (let trial = 0; trial < 64; trial++) {
      const x = (2 * random() - 1) * half;
      const y = (2 * random() - 1) * half;
      let inside = true;
      for (let k = 0; k < this.M && inside; k++) {
        if (x * this.containerAxes[3 * k + 1] + y * this.containerAxes[3 * k + 2] > limit) inside = false;
      }
      if (inside) {
        out.x = x;
        out.y = y;
        return;
      }
    }
    out.x = 0;
    out.y = 0;
  }

  /**
   * Angle for a sampled pose. The interlocking angles come first: an edge parallel to a
   * container wall, rotated by a quarter of the piece's symmetry period at a time (multiples of
   * 22.5 degrees from the walls for squares, which include the 45-degree tilt); the angle of a
   * random other piece, or that angle turned by pi/N (the inverted neighbour that tiles with
   * triangles); for a circular container, an edge facing the centre. The rest are uniform.
   */
  private sampleAngle(i: number, x: number, y: number, random: () => number): number {
    const { N, M, period } = this;
    if (N === 0) return 0;
    const u = random();
    if (u < 0.4) {
      // Edge normal theta + pi/2 + pi/N parallel to wall normal -pi/2 + 2 pi k / M.
      const wall = M === 0 ? Math.atan2(y, x) + Math.PI / 2 : (2 * Math.PI * Math.floor(random() * M)) / M;
      return wall - Math.PI - Math.PI / N + (period / 4) * Math.floor(random() * 4);
    }
    if (u < 0.6 && this.P > 1) {
      let j = Math.floor(random() * (this.P - 1));
      if (j >= i) j++;
      return this.poses[j].theta + (random() < 0.5 ? 0 : Math.PI / N);
    }
    if (u < 0.7) return this.poses[i].theta;
    return period * random();
  }

  /** Short gradient descent of one piece's weighted loss from `pose`, in place; returns the loss. */
  private refine(i: number, pose: Pose): number {
    const g = new Float64Array(3);
    const axes = this.candidateAxes;
    if (this.N !== 0) penaltyEdgeNormals(this.N, pose.theta, axes);
    let loss = this.pieceGradient(i, pose, axes, g);
    const trial: Pose = { x: 0, y: 0, theta: 0 };
    const trialAxes = this.trialAxes;
    let step = 0;
    for (let k = 0; k < REFINE_STEPS && loss > 0; k++) {
      const norm = Math.hypot(g[0], g[1], this.R * g[2]);
      if (!(norm > 0)) break;
      // First step moves the piece by a tenth of its bounding radius.
      if (step === 0) step = (0.1 * this.R) / norm;
      let accepted = false;
      for (let line = 0; line < 12; line++) {
        trial.x = pose.x - step * g[0];
        trial.y = pose.y - step * g[1];
        trial.theta = pose.theta - step * g[2];
        if (this.N !== 0) penaltyEdgeNormals(this.N, trial.theta, trialAxes);
        const value = this.pieceLoss(i, trial, trialAxes, loss);
        if (value < loss) {
          accepted = true;
          break;
        }
        step *= 0.35;
      }
      if (!accepted) break;
      pose.x = trial.x;
      pose.y = trial.y;
      pose.theta = trial.theta;
      if (this.N !== 0) penaltyEdgeNormals(this.N, pose.theta, axes);
      loss = this.pieceGradient(i, pose, axes, g);
      step *= 2;
    }
    return loss;
  }

  /**
   * Relocate piece i: sample poses across the whole container and near its current and best
   * poses, keep the one of least weighted loss, refine it by local descent, and move the piece
   * there if that lowers its loss. Returns true when the piece moved.
   */
  relocate(i: number, random: () => number): boolean {
    const { N, settings } = this;
    const current = this.poses[i];
    const currentLoss = this.pieceLoss(i, current, N === 0 ? this.candidateAxes : this.axes[i], Infinity);
    if (currentLoss === 0) return false;
    const best: Pose = { x: current.x, y: current.y, theta: current.theta };
    let bestLoss = currentLoss;
    const cand = this.candidate;
    const axes = this.candidateAxes;
    const consider = () => {
      if (N !== 0) penaltyEdgeNormals(N, cand.theta, axes);
      const loss = this.pieceLoss(i, cand, axes, bestLoss);
      if (loss < bestLoss) {
        bestLoss = loss;
        best.x = cand.x;
        best.y = cand.y;
        best.theta = cand.theta;
      }
    };
    for (let k = 0; k < settings.globalSamples && bestLoss > 0; k++) {
      this.sampleCentre(random, cand);
      cand.theta = this.sampleAngle(i, cand.x, cand.y, random);
      consider();
    }
    // Local samples alternate between the current pose and the best found so far.
    const sigma = 0.3 * this.R;
    for (let k = 0; k < settings.localSamples && bestLoss > 0; k++) {
      const base = k % 2 === 0 ? current : best;
      const scale = sigma * (random() < 0.5 ? 1 : 0.2);
      cand.x = base.x + scale * gaussian(random);
      cand.y = base.y + scale * gaussian(random);
      cand.theta = random() < 0.25 ? this.sampleAngle(i, cand.x, cand.y, random) : base.theta + 0.15 * gaussian(random);
      consider();
    }
    const refined = this.refine(i, best);
    if (!(refined < currentLoss)) return false;
    this.place(i, best);
    return true;
  }

  /** Move piece i to a uniformly random pose in the container (a disruption). */
  scatterPiece(i: number, random: () => number): void {
    const cand: Pose = { x: 0, y: 0, theta: 0 };
    this.sampleCentre(random, cand);
    cand.theta = this.N === 0 ? 0 : this.period * random();
    this.place(i, cand);
  }

  // ---------------------------------------------------------------------------------------------
  // Global descent

  private x = new Float64Array(0);
  private g = new Float64Array(0);
  private xNew = new Float64Array(0);
  private gNew = new Float64Array(0);
  private direction = new Float64Array(0);
  private sHistory: Float64Array[] = [];
  private yHistory: Float64Array[] = [];

  private ensureBuffers(): void {
    const n = 3 * this.P;
    if (this.x.length === n) return;
    this.x = new Float64Array(n);
    this.g = new Float64Array(n);
    this.xNew = new Float64Array(n);
    this.gNew = new Float64Array(n);
    this.direction = new Float64Array(n);
    this.sHistory = Array.from({ length: MEMORY }, () => new Float64Array(n));
    this.yHistory = Array.from({ length: MEMORY }, () => new Float64Array(n));
  }

  private loadVector(x: Float64Array): void {
    for (let i = 0; i < this.P; i++) {
      const p = this.poses[i];
      p.x = x[3 * i];
      p.y = x[3 * i + 1];
      p.theta = this.N === 0 ? 0 : x[3 * i + 2];
      this.refreshAxes(i);
    }
    this.rebuildGrid();
  }

  /**
   * L-BFGS on the weighted objective over every pose, with an Armijo backtracking line search
   * and steps capped at a quarter of the bounding radius (and a quarter radian). Stops at the
   * iteration limit, when the state is feasible, or when no step decreases the objective.
   * `pulse` is called after every iteration and returns false to stop. Leaves the state
   * evaluated at its final poses.
   */
  async descend(iterations: number, pulse: () => boolean | Promise<boolean>): Promise<boolean> {
    this.ensureBuffers();
    const { P, N } = this;
    const n = 3 * P;
    const { x, g, xNew, gNew, direction, sHistory, yHistory } = this;
    for (let i = 0; i < P; i++) {
      x[3 * i] = this.poses[i].x;
      x[3 * i + 1] = this.poses[i].y;
      x[3 * i + 2] = this.poses[i].theta;
    }
    let f = this.evaluate(g);
    const rho = new Float64Array(MEMORY);
    const alpha = new Float64Array(MEMORY);
    let stored = 0;
    let newest = -1;
    const capMove = 0.25 * this.R;
    for (let it = 0; it < iterations; it++) {
      if (this.feasible() || !(f > 0)) break;
      // Two-loop recursion.
      for (let k = 0; k < n; k++) direction[k] = -g[k];
      for (let m = 0; m < stored; m++) {
        const h = (newest - m + MEMORY) % MEMORY;
        let dot = 0;
        for (let k = 0; k < n; k++) dot += sHistory[h][k] * direction[k];
        alpha[h] = rho[h] * dot;
        for (let k = 0; k < n; k++) direction[k] -= alpha[h] * yHistory[h][k];
      }
      if (stored > 0) {
        let sy = 0;
        let yy = 0;
        for (let k = 0; k < n; k++) {
          sy += sHistory[newest][k] * yHistory[newest][k];
          yy += yHistory[newest][k] * yHistory[newest][k];
        }
        const gamma = sy / yy;
        for (let k = 0; k < n; k++) direction[k] *= gamma;
      }
      for (let m = stored - 1; m >= 0; m--) {
        const h = (newest - m + MEMORY) % MEMORY;
        let dot = 0;
        for (let k = 0; k < n; k++) dot += yHistory[h][k] * direction[k];
        const beta = rho[h] * dot;
        for (let k = 0; k < n; k++) direction[k] += sHistory[h][k] * (alpha[h] - beta);
      }
      let slope = 0;
      for (let k = 0; k < n; k++) slope += g[k] * direction[k];
      if (!(slope < 0)) {
        stored = 0;
        slope = 0;
        for (let k = 0; k < n; k++) {
          direction[k] = -g[k];
          slope -= g[k] * g[k];
        }
        if (!(slope < 0)) break;
      }
      // Cap the largest move.
      let largest = 0;
      for (let i = 0; i < P; i++) {
        largest = Math.max(largest, Math.hypot(direction[3 * i], direction[3 * i + 1]) / capMove);
        if (N !== 0) largest = Math.max(largest, Math.abs(direction[3 * i + 2]) / 0.25);
      }
      let step = stored === 0 ? Math.min(1, 1 / Math.max(largest, 1e-300)) : 1;
      if (step * largest > 1) step = 1 / largest;
      let accepted = false;
      let fNew = f;
      for (let line = 0; line < 40; line++) {
        for (let k = 0; k < n; k++) xNew[k] = x[k] + step * direction[k];
        this.loadVector(xNew);
        fNew = this.evaluate(gNew);
        if (Number.isFinite(fNew) && fNew <= f + 1e-4 * step * slope && fNew < f) {
          accepted = true;
          break;
        }
        step *= 0.5;
      }
      if (!accepted) {
        this.loadVector(x);
        this.evaluate();
        break;
      }
      // Curvature pair.
      const slot = (newest + 1) % MEMORY;
      const s = sHistory[slot];
      const y = yHistory[slot];
      let sy = 0;
      let ss = 0;
      let yy = 0;
      for (let k = 0; k < n; k++) {
        s[k] = xNew[k] - x[k];
        y[k] = gNew[k] - g[k];
        sy += s[k] * y[k];
        ss += s[k] * s[k];
        yy += y[k] * y[k];
      }
      if (sy > 1e-12 * Math.sqrt(ss * yy)) {
        rho[slot] = 1 / sy;
        newest = slot;
        stored = Math.min(MEMORY, stored + 1);
      }
      x.set(xNew);
      g.set(gNew);
      f = fNew;
      if (!(await pulse())) return false;
    }
    // Keep angles in one period.
    if (N !== 0) {
      for (let i = 0; i < P; i++) {
        this.poses[i].theta = this.wrap(this.poses[i].theta);
        this.refreshAxes(i);
      }
    }
    return true;
  }
}
