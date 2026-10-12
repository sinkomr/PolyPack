// Energy and momentum dynamics of soft-to-rigid hardening, after Yohei Nakajima
// (https://github.com/yoheinakajima/soft-to-rigid, MIT licence; engine/engine2d.js `gradient` and `step`).
// The energy, the update rule and its constants are the reference's. This file evaluates them with
// PolyPack's shared penalty geometry, for any regular piece in any regular or circular container.
import {
  MAX_COORD,
  boundingRadius,
  containerArea,
  enclose,
  inradius,
  pairPenetration,
  penaltyContainerNormals,
  penaltyEdgeNormals,
  pieceArea,
  visitContainerProtrusions,
  type Container,
  type PackingConfig,
  type Pose,
  type ProtrusionVisitor,
} from "@polypack/geometry";
import { nearbyPairs } from "../penalty/objective";
import { shapeReach, type SoftShape } from "./shapes";

/** Reference update constants (engine2d.js `step`). */
export const MOMENTUM = 0.85;
export const POSE_RATE = 0.04;
export const SIZE_RATE = 0.02;
/** Translation cap per step is STEP_CAP * sqrt(2) * circumradius; the rotation cap is STEP_CAP radians. */
export const STEP_CAP = 0.03;
/** Below this softness margin a piece is a pure disk and receives no torque. */
const DISK_TAU = 0.9999;
/** Up to this many pieces every pair is distance-tested directly; above it a cell grid is used. */
const DIRECT_PAIRS = 32;

/** Standard normal by Box–Muller from two draws of the seeded stream, as in the reference. */
export function gaussian(random: () => number): number {
  let u = 0;
  while (u === 0) u = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

/**
 * Length unit of the pressure and of the noise: the piece's inscribed diameter. The reference
 * states both in absolute units for unit squares and unit-diameter circles, whose inscribed
 * diameter is 1. Scaling by it reproduces those two cases exactly (PolyPack's circles have
 * radius 1, so every length doubles) and keeps both proportionate for other piece sizes.
 */
export function lengthUnit(N: number): number {
  return N === 0 ? 2 : 2 * inradius(N);
}

/**
 * Size variable L per unit of PolyPack's container size. The reference moves the side of a
 * square or triangle and the radius of a circle. A polygon's side per unit of apothem shrinks
 * as 1/M, which would make the same update ever stiffer for many-sided containers, so from
 * the first polygon whose apothem exceeds its side (M >= 7) L is the apothem: the limit is
 * the reference's circle and M = 3, 4 keep the reference's side.
 */
export function sizeUnit(M: number): number {
  return M === 0 ? 1 : Math.max(1, inradius(M));
}

export interface EnergyReport {
  /** Sum of squared pair and wall violations, without the pressure term. */
  energy: number;
  /** Derivative of that energy with respect to L. */
  sizeGradient: number;
  /** Largest positive violation. */
  violation: number;
}

/**
 * State of one run: poses and velocities, and a container centred at the origin with a
 * horizontal bottom edge (phi = 0) whose size variable L moves under inward pressure.
 *
 * E = sum_pairs (2 r - sd_ij)_+^2 + sum_i sum_core-vertices (wall violation + r)_+^2 (+ mu L),
 * with r the disk padding and sd the signed distance between cores. Both terms and their
 * analytic derivatives come from the shared `pairPenetration` and `visitContainerProtrusions`.
 *
 * A gradient is assembled in resumable parts (`prepare`, `addPairs`, `addWalls`, `finish`) so
 * that the caller can place cooperative checkpoints by counted work; `gradient` runs them all.
 */
export class HardenDynamics {
  readonly N: number;
  readonly M: number;
  readonly P: number;
  readonly poses: Pose[];
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  readonly vt: Float64Array;
  readonly gx: Float64Array;
  readonly gy: Float64Array;
  readonly gt: Float64Array;
  /** Container size variable; PolyPack's size is L / unit. */
  L = 1;
  vL = 0;
  readonly unit: number;
  readonly length: number;
  /** Counted pair and wall feature tests of this state so far. */
  work = 0;
  energy = 0;
  violation = 0;
  private sizeGradient = 0;
  private shape: SoftShape = { gamma: 1, tau: 0, scale: 1, padding: 0 };
  private pairs: [number, number][] = [];
  private current = 0;
  private readonly cap: number;
  private readonly apothem: number;
  private readonly axes: Float64Array[];
  private readonly containerAxes: Float64Array;
  private readonly scratch: Float64Array;
  private readonly container: Container;
  private readonly visitor: ProtrusionVisitor;

  constructor(problem: { N: number; M: number; P: number }) {
    this.N = problem.N;
    this.M = problem.M;
    this.P = problem.P;
    const { N, M, P } = this;
    this.poses = Array.from({ length: P }, () => ({ x: 0, y: 0, theta: 0 }));
    this.vx = new Float64Array(P);
    this.vy = new Float64Array(P);
    this.vt = new Float64Array(P);
    this.gx = new Float64Array(P);
    this.gy = new Float64Array(P);
    this.gt = new Float64Array(P);
    this.unit = sizeUnit(M);
    this.length = lengthUnit(N);
    this.cap = STEP_CAP * Math.SQRT2 * boundingRadius(N);
    // Distance from the container centre to its walls per unit of PolyPack size.
    this.apothem = M === 0 ? 1 : inradius(M);
    this.axes = N === 0 ? [] : Array.from({ length: P }, () => new Float64Array(3 * N));
    this.containerAxes = M === 0 ? new Float64Array(0) : penaltyContainerNormals(M, 0);
    this.scratch = new Float64Array(2 * (N + M));
    this.container = { M, cx: 0, cy: 0, phi: 0, size: 1 };
    this.visitor = (depth, px, py, ptheta, _cx, _cy, size) => {
      if (!(depth > 0)) return;
      const i = this.current;
      if (depth > this.violation) this.violation = depth;
      this.energy += depth * depth;
      this.gx[i] += 2 * depth * px;
      this.gy[i] += 2 * depth * py;
      this.gt[i] += 2 * depth * ptheta;
      this.sizeGradient += 2 * depth * size;
    };
  }

  /** PolyPack container size (side, or radius for a circle) of the moving container. */
  get size(): number {
    return this.L / this.unit;
  }

  /**
   * Reference start: a container of `fill` times the pieces' area, centres uniform in it at
   * least a bounding radius from the walls, uniform angles. A piece that finds no such place
   * (a container too small to hold one piece clear of its walls) is placed anywhere inside.
   */
  scatter(fill: number, random: () => number): void {
    const { N, M, P } = this;
    const size = Math.sqrt((fill * P * pieceArea(N)) / containerArea(M, 1));
    this.L = size * this.unit;
    this.vL = 0;
    const half = M === 0 ? size : size / (2 * Math.sin(Math.PI / M));
    const margin = boundingRadius(N);
    const inside = (x: number, y: number, clearance: number): boolean => {
      if (M === 0) return Math.hypot(x, y) < size - clearance;
      for (let edge = 0; edge < M; edge++) {
        if (
          x * this.containerAxes[3 * edge + 1] + y * this.containerAxes[3 * edge + 2] >
          this.apothem * size - clearance
        )
          return false;
      }
      return true;
    };
    for (let i = 0; i < P; i++) {
      const pose = this.poses[i];
      pose.x = 0;
      pose.y = 0;
      // The clearance is dropped after 200 failures; a uniform point of the bounding square
      // lies in the container with probability above 0.4, so 64 more trials practically always place it.
      for (let trial = 0; trial < 264; trial++) {
        const x = (2 * random() - 1) * half;
        const y = (2 * random() - 1) * half;
        if (!inside(x, y, trial < 200 ? margin : 0)) continue;
        pose.x = x;
        pose.y = y;
        break;
      }
      pose.theta = N === 0 ? 0 : 2 * Math.PI * random();
    }
    this.rest();
  }

  /**
   * Adopt a supplied arrangement: its enclosing container at the stored orientation becomes
   * the moving container, and every pose is expressed in that container's frame (centre at
   * the origin, phi = 0), which is a rigid motion of the whole arrangement.
   */
  adopt(config: PackingConfig): void {
    const box = enclose(config.N, config.pieces, config.M, config.M === 0 ? 0 : config.container_phi);
    const c = Math.cos(-box.phi);
    const s = Math.sin(-box.phi);
    for (let i = 0; i < this.P; i++) {
      const dx = config.pieces[i].x - box.cx;
      const dy = config.pieces[i].y - box.cy;
      this.poses[i].x = c * dx - s * dy;
      this.poses[i].y = s * dx + c * dy;
      this.poses[i].theta = this.N === 0 ? 0 : config.pieces[i].theta - box.phi;
    }
    this.L = box.size * this.unit;
    this.vL = 0;
    this.rest();
  }

  private rest(): void {
    this.vx.fill(0);
    this.vy.fill(0);
    this.vt.fill(0);
  }

  /** True-shape arrangement of the current poses in the moving container's frame. */
  config(): PackingConfig {
    return {
      N: this.N,
      M: this.M,
      P: this.P,
      container_phi: 0,
      pieces: this.poses.map((p) => ({ x: p.x, y: p.y, theta: p.theta })),
    };
  }

  /** False once a pose or the container has left the range a configuration may hold. */
  finite(): boolean {
    if (!Number.isFinite(this.L)) return false;
    for (const p of this.poses) {
      if (!Number.isFinite(p.theta) || !(Math.abs(p.x) <= MAX_COORD) || !(Math.abs(p.y) <= MAX_COORD)) return false;
    }
    return true;
  }

  /** Counted feature tests of one candidate pair in this shape. */
  pairCost(shape: SoftShape): number {
    if (this.N === 0 || shape.scale === 0) return 1;
    // 2N separating axes, and N^2 vertex-edge distances from each side for a padded core.
    return 2 * this.N + (shape.padding > 0 ? 2 * this.N * this.N : 0);
  }

  /** Counted feature tests of one piece against the walls: every core vertex against every wall. */
  wallCost(shape: SoftShape): number {
    return (this.N === 0 || shape.scale === 0 ? 1 : this.N) * Math.max(1, this.M);
  }

  /** Start a gradient for this shape and list the pairs within interaction reach; returns their number. */
  prepare(shape: SoftShape): number {
    const { N, P, poses } = this;
    this.shape = shape;
    this.gx.fill(0);
    this.gy.fill(0);
    this.gt.fill(0);
    this.energy = 0;
    this.violation = 0;
    this.sizeGradient = 0;
    this.container.size = this.size;
    if (N !== 0 && shape.scale !== 0) {
      for (let i = 0; i < P; i++) penaltyEdgeNormals(N, poses[i].theta, this.axes[i]);
    }
    // Two soft pieces further apart than twice their reach cannot touch: the reference's
    // neighbour cut-off, here with the exact reach of the current shape.
    const reach = 2 * shapeReach(N, shape);
    if (P > DIRECT_PAIRS) {
      this.pairs = reach > 0 ? nearbyPairs(poses, reach, () => false) : [];
      this.work += 12 * P;
      return this.pairs.length;
    }
    const pairs: [number, number][] = [];
    const limit = reach * reach;
    for (let i = 0; i < P; i++) {
      for (let j = i + 1; j < P; j++) {
        const dx = poses[i].x - poses[j].x;
        const dy = poses[i].y - poses[j].y;
        if (dx * dx + dy * dy <= limit) pairs.push([i, j]);
      }
    }
    this.pairs = pairs;
    this.work += (P * (P - 1)) / 2;
    return pairs.length;
  }

  /** Add the pair terms of listed pairs [from, to). */
  addPairs(from: number, to: number): void {
    const { N, poses, gx, gy, gt, axes, shape } = this;
    for (let k = from; k < to; k++) {
      const [i, j] = this.pairs[k];
      // depth = 2 r - sd(cores): exact core distance when apart, minus the SAT depth when overlapping.
      const hit = pairPenetration(N, poses[i], poses[j], axes[i], axes[j], shape.scale, shape.padding);
      const depth = hit.depth;
      if (!(depth > 0)) continue;
      if (depth > this.violation) this.violation = depth;
      this.energy += depth * depth;
      const factor = 2 * depth;
      gx[i] += factor * hit.a.x;
      gy[i] += factor * hit.a.y;
      gt[i] += factor * hit.a.theta;
      gx[j] += factor * hit.b.x;
      gy[j] += factor * hit.b.y;
      gt[j] += factor * hit.b.theta;
    }
    this.work += (to - from) * this.pairCost(shape);
  }

  /** Add the wall terms of pieces [from, to). */
  addWalls(from: number, to: number): void {
    const { N, poses, shape, container } = this;
    const reach = shapeReach(N, shape);
    const clear = this.apothem * container.size - reach;
    const disk = N === 0 || shape.scale === 0;
    let visited = 0;
    for (let i = from; i < to; i++) {
      // A piece whose reach stays inside the container's inscribed circle touches no wall.
      if (Math.hypot(poses[i].x, poses[i].y) <= clear) continue;
      this.current = i;
      visited++;
      if (disk) {
        // A circle piece or a pure inscribed disk: one constraint per wall, with its radius.
        visitContainerProtrusions(0, poses[i], container, this.visitor, false, undefined, this.containerAxes, reach, 0);
      } else {
        visitContainerProtrusions(
          N,
          poses[i],
          container,
          this.visitor,
          false,
          this.scratch,
          this.containerAxes,
          shape.scale,
          shape.padding,
        );
      }
    }
    this.work += to - from + visited * this.wallCost(shape);
  }

  /** Complete the gradient: dE/dL, and no torque on pure disks. */
  finish(): EnergyReport {
    if (this.N === 0 || this.shape.tau >= DISK_TAU) this.gt.fill(0);
    return { energy: this.energy, sizeGradient: this.sizeGradient / this.unit, violation: this.violation };
  }

  /** Energy and gradient of the current state in one call. */
  gradient(shape: SoftShape): EnergyReport {
    this.addPairs(0, this.prepare(shape));
    this.addWalls(0, this.P);
    return this.finish();
  }

  /**
   * One momentum step from the finished gradient: v <- 0.85 v - 0.04 grad, capped, then noise;
   * the container follows v_L <- 0.85 v_L - 0.02 (pressure + dE/dL) under the same cap.
   * `pressure` and `noise` are already in piece length units; angular noise is 1.5 times the
   * positional noise per length unit (radians).
   */
  advance(report: EnergyReport, pressure: number, noise: number, random: () => number): void {
    const { P, poses, vx, vy, vt, gx, gy, gt, cap } = this;
    const turn = this.N === 0 ? 0 : (1.5 * noise) / this.length;
    for (let i = 0; i < P; i++) {
      vx[i] = MOMENTUM * vx[i] - POSE_RATE * gx[i];
      vy[i] = MOMENTUM * vy[i] - POSE_RATE * gy[i];
      vt[i] = MOMENTUM * vt[i] - POSE_RATE * gt[i];
      const speed = Math.hypot(vx[i], vy[i]);
      if (speed > cap) {
        vx[i] *= cap / speed;
        vy[i] *= cap / speed;
      }
      if (Math.abs(vt[i]) > STEP_CAP) vt[i] = Math.sign(vt[i]) * STEP_CAP;
      const pose = poses[i];
      pose.x += vx[i];
      pose.y += vy[i];
      pose.theta += vt[i];
      if (noise > 0) {
        pose.x += noise * gaussian(random);
        pose.y += noise * gaussian(random);
        if (turn > 0) pose.theta += turn * gaussian(random);
      }
    }
    this.vL = MOMENTUM * this.vL - SIZE_RATE * (pressure + report.sizeGradient);
    if (Math.abs(this.vL) > cap) this.vL = Math.sign(this.vL) * cap;
    this.L += this.vL;
    this.work += P;
  }
}
