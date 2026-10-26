/**
 * The momentum dynamics of soft-to-rigid hardening, after Yohei Nakajima
 * (https://github.com/yoheinakajima/soft-to-rigid, MIT licence; engine/engine2d.js `gradient` and
 * `step`), on any kernel's penalty energy (docs/methods/dimensions/harden.md).
 *
 * The reference minimises E + mu L, its pair and wall penetrations squared plus an inward pressure
 * mu on the container size L, with the update
 *
 *   v <- 0.85 v - 0.04 dE/dz      for every pose variable z, a length (or an angle),
 *   v_L <- 0.85 v_L - 0.02 (mu + dE/dL)   for the size,
 *
 * a capped step and decaying Gaussian noise. A kernel's variables need not be lengths (the
 * surface's (u, v) live on the unit solid, the sphere's spin turns a piece by x / rho), but its
 * `steps` say what moves a piece by about its inradius. So each variable x_j is read as the length
 * z_j = x_j * inradius / steps_j, and the update in x is the reference's scaled by
 * (steps_j / inradius)^2: exactly the reference for a variable that is a length with a step of
 * one inradius, and the same mobility in piece units for a turn.
 *
 * The size needs a unit too. The reference moves the radius of a circle (a unit of size moves the
 * wall by a unit of length) or the side of a polygon. In other spaces a unit of size moves the
 * contacts by very different lengths: the side of a hyperbolic square buys ever less room (its
 * inradius stays below asinh 1), and on a closed surface the size spreads the pairs instead of
 * moving walls. So the size moves in units of room: `unit` is how far a unit of size moves the
 * contacts, measured from the gradient (see measureUnit), and the size dynamics is the reference's
 * in the room a = unit * size: v_a <- 0.85 v_a - 0.02 (mu + dE/dsize / unit), size += v_a / unit.
 */
import type { KernelState, Rng, SpaceKernel } from "../kernel";
import { variableSteps } from "../local";

/** Reference update constants (engine2d.js `step`). */
export const MOMENTUM = 0.85;
export const POSE_RATE = 0.04;
export const SIZE_RATE = 0.02;
/** The reference caps a step at 0.03 per variable: 0.03 rad, and 0.03 sqrt(2) R on a 2D translation. */
export const STEP_CAP = 0.03;
/** The largest relative change of the size in one step. */
export const SIZE_STEP = 0.02;

/** Standard normal by Box–Muller from two draws of the seeded stream, as in the reference. */
export function gaussian(rng: Rng): number {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/**
 * The piece's inradius in the units of the size (kernel.inradius). The reference states pressure
 * and noise per unit-side square or unit-diameter circle, that is per inscribed diameter, which
 * is twice this.
 */
export function pieceLength(k: SpaceKernel): number {
  return k.inradius;
}

/** One run's moving state: the kernel state, its velocities and its size's velocity. */
export class HardenDynamics {
  readonly velocity: Float64Array;
  sizeVelocity = 0;
  /** Energy of the last step, without the pressure term. */
  energy = 0;
  private readonly grad: Float64Array;
  private readonly steps: Float64Array;
  /** The reference's rate per variable, scaled to the variable's units. */
  private readonly rate: Float64Array;
  private readonly cap: number;
  private readonly sizeCap: number;
  private readonly minSize: number;
  /** The run's start size: roomy enough, by the kernel's rule, that a short relaxation separates the pieces. */
  private readonly maxSize: number;
  private readonly probe: Float64Array;
  /** Length by which a unit of size moves the contacts (1 until measured; exactly 1 for disks in a circle). */
  unit = 1;

  constructor(
    private readonly k: SpaceKernel,
    readonly s: KernelState,
  ) {
    this.steps = variableSteps(k);
    this.velocity = new Float64Array(this.steps.length);
    this.grad = new Float64Array(this.steps.length + 1);
    this.probe = new Float64Array(this.steps.length + 1);
    const r = pieceLength(k);
    this.rate = this.steps.map((step) => POSE_RATE * (step / r) ** 2);
    // the reference's caps in piece units: 0.03 per variable, so 0.03 sqrt(dim) on a piece's step
    this.cap = STEP_CAP * Math.sqrt(k.dim);
    // the size moves at most as far as a translation may: 0.03 sqrt(2) inradii
    this.sizeCap = STEP_CAP * Math.SQRT2 * r;
    // The problem's bound holds for the true shapes; soft pieces pack below it (inscribed disks
    // fill 60% of a triangle, inscribed balls 30% of a tetrahedron, so a size about 0.67 times
    // as large), and only a runaway container falls below half of it.
    this.minSize = k.bound !== null && k.bound > 0 ? k.bound / 2 : 0;
    // A run never needs more room than its start had. Where the room saturates (the inradius of
    // a hyperbolic polygon stays below asinh 1), a jammed arrangement would otherwise push the
    // size out without end: a unit of size buys ever less room.
    this.maxSize = s.size;
  }

  /**
   * The size's unit from the gradient at size L and at L + h, the pieces fixed. Every term is a
   * contact depth d squared, so between the two only the terms that depend on the size change:
   * d^2E/dL^2 = sum 2 (dd/dL)^2, and each piece's gradient (in lengths) changes by
   * sum 2 (dd/dL) grad d, with |grad d| = 1. Their ratio is a mean of |dd/dL|: the length by which
   * a unit of size moves a contact (exactly 1 for disks in a circle, one half for a square's
   * side). Without such a contact the unit stays. One energy evaluation with its gradient.
   */
  private measureUnit(): void {
    const { k, s, grad: g, probe, steps } = this;
    const r = pieceLength(k);
    const h = 1e-4 * r;
    const size = s.size;
    s.size = size + h;
    const e = k.energy(s, probe);
    s.size = size;
    if (!Number.isFinite(e)) return;
    const n = s.x.length;
    const curvature = (probe[n] - g[n]) / h;
    let pull = 0;
    for (let i = 0; i < k.P; i++) {
      let q = 0;
      for (let d = 0; d < k.dim; d++) {
        const j = i * k.dim + d;
        q += (((probe[j] - g[j]) / h) * steps[j]) ** 2;
      }
      pull += Math.sqrt(q) / r;
    }
    if (curvature > 0 && pull > 0) this.unit = Math.min(100, Math.max(0.01, curvature / pull));
  }

  /**
   * One momentum step at the state's current shape: one energy evaluation with its gradient, and
   * one more when `measure` asks for the size's unit. `pressure` is in the units of the energy per
   * unit of room; `noise` is the standard deviation in piece units (steps) of every piece
   * variable. Returns false when the state has diverged.
   */
  step(pressure: number, noise: number, rng: Rng, measure = false): boolean {
    const { k, s, velocity: v, grad: g, steps, rate } = this;
    const e = k.energy(s, g);
    if (!Number.isFinite(e)) return false;
    this.energy = e;
    if (measure) this.measureUnit();
    const x = s.x;
    const { dim, P } = k;
    for (let i = 0; i < P; i++) {
      const base = i * dim;
      let norm = 0;
      for (let d = 0; d < dim; d++) {
        const j = base + d;
        v[j] = MOMENTUM * v[j] - rate[j] * g[j];
        norm += (v[j] / steps[j]) ** 2;
      }
      // the cap bounds the piece's whole step in piece units, keeping its direction
      norm = Math.sqrt(norm);
      const scale = norm > this.cap ? this.cap / norm : 1;
      for (let d = 0; d < dim; d++) {
        const j = base + d;
        v[j] *= scale;
        x[j] += v[j];
        if (noise > 0) x[j] += noise * steps[j] * gaussian(rng);
      }
    }
    // variables of the whole packing follow the same update, capped one by one, without noise
    for (let j = P * dim; j < x.length; j++) {
      v[j] = MOMENTUM * v[j] - rate[j] * g[j];
      const c = STEP_CAP * steps[j];
      if (Math.abs(v[j]) > c) v[j] = Math.sign(v[j]) * c;
      x[j] += v[j];
    }
    // the container, in units of room: inward pressure against the contacts' push dE/dsize
    this.sizeVelocity = MOMENTUM * this.sizeVelocity - SIZE_RATE * (pressure + g[x.length] / this.unit);
    if (Math.abs(this.sizeVelocity) > this.sizeCap) this.sizeVelocity = Math.sign(this.sizeVelocity) * this.sizeCap;
    // A unit measured a few steps ago may be far off where it changes fast with the size (on a
    // closed surface it falls about as the size squared), so the size also moves by at most 2%
    // per step; for disks in a circle the cap above binds first.
    let delta = this.sizeVelocity / this.unit;
    if (Math.abs(delta) > SIZE_STEP * s.size) {
      delta = Math.sign(delta) * SIZE_STEP * s.size;
      this.sizeVelocity = delta * this.unit;
    }
    let size = s.size + delta;
    if (!(size > this.minSize)) {
      // pressed onto half the bound (or towards zero without one): stop the container there
      size = this.minSize > 0 ? this.minSize : s.size / 2;
      this.sizeVelocity = 0;
    }
    if (size > this.maxSize) {
      size = this.maxSize;
      this.sizeVelocity = 0;
    }
    s.size = size;
    for (let j = 0; j < x.length; j++) if (!Number.isFinite(x[j])) return false;
    return Number.isFinite(s.size);
  }

  /**
   * Folds the charts into their anchors (kernel.rebase). A velocity is a direction in its piece's
   * chart; where rebase changes a piece's variables (an offset folded into the anchor, a new face
   * or cell, a wrap), the generic method cannot carry it into the new chart, so that piece starts
   * again from rest. Pieces whose variables rebase leaves alone keep their velocity, as do the
   * variables of the whole packing that it leaves alone.
   */
  rebase(): void {
    const { k, s, velocity: v } = this;
    const before = Float64Array.from(s.x);
    k.rebase(s);
    const { dim, P } = k;
    for (let i = 0; i < P; i++) {
      let changed = false;
      for (let d = 0; d < dim && !changed; d++) changed = s.x[i * dim + d] !== before[i * dim + d];
      if (changed) v.fill(0, i * dim, i * dim + dim);
    }
    for (let j = P * dim; j < s.x.length; j++) if (s.x[j] !== before[j]) v[j] = 0;
  }
}
