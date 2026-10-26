/**
 * A kernel for the tests of harden and morph only: the reference disks, whose soft shape at t is a
 * smaller concentric disk of radius 1 - (1 - t) * 0.3, inside the true disk. So t = 0 gives disks
 * of radius 0.7 and t = 1 the true unit disks. The energy, pieceEnergy and clear use the current
 * radius; finish and validate are the reference kernel's, at the true radius, whatever the shape.
 *
 * It records every shape set and the shape of every state handed to finish, so a test can check
 * that a method's schedule really changes t and that it offers true shapes only.
 *
 * Options make it behave like an expensive space kernel, to test what the reference kernel cannot
 * show: finish and validate costs, a gradient that costs several evaluations, a finish that fails
 * on deeply overlapping states (as a real space's finishing does on raw random starts, whose
 * pieces are piled up here near the centre), no seeds, and a bound at the optimum.
 */
import type { KernelState, Rng, SpaceKernel } from "../src/kernel";
import { disksKernel } from "../src/reference/disks";

export interface SoftDisksKernel extends SpaceKernel {
  /** Every t passed to setShape, in order. */
  readonly shapes: number[];
  /** The states passed to setShape, in the same order (to tell a method's own state from its copies). */
  readonly shaped: KernelState[];
  /** The shape of every state passed to finish, in order. */
  readonly finished: number[];
}

interface Soft {
  t: number;
}

export const softRadius = (t: number) => 1 - (1 - t) * 0.3;

export interface SoftDisksOptions {
  finishCost?: number;
  validateCost?: number;
  gradCost?: number;
  /** finish returns null when the true disks' energy of the state exceeds this. */
  failAbove?: number;
  /** Without the capability "seeds" (default with). */
  seeds?: boolean;
  /** The problem's lower bound (default the reference kernel's). */
  bound?: number;
}

export function softDisksKernel(P: number, o: SoftDisksOptions = {}): SoftDisksKernel {
  const base = disksKernel(P);
  const shapes: number[] = [];
  const shaped: KernelState[] = [];
  const finished: number[] = [];
  const shapeOf = (s: KernelState) => (s.aux as Soft | null)?.t ?? 1;
  const withShape = (s: KernelState | null, t = 1): KernelState | null => (s ? { ...s, aux: { t } } : s);

  const energy = (s: KernelState, grad?: Float64Array, w?: Float64Array): number => {
    const r = softRadius(shapeOf(s));
    const x = s.x;
    const R = s.size;
    if (grad) grad.fill(0);
    let e = 0;
    for (let i = 0; i < P; i++) {
      const wi = w ? w[i] : 1;
      const d0 = Math.hypot(x[2 * i], x[2 * i + 1]);
      const out = d0 + r - R;
      if (out > 0) {
        e += wi * out * out;
        if (grad) {
          if (d0 > 0) {
            grad[2 * i] += (2 * wi * out * x[2 * i]) / d0;
            grad[2 * i + 1] += (2 * wi * out * x[2 * i + 1]) / d0;
          }
          grad[2 * P] -= 2 * wi * out;
        }
      }
      for (let j = i + 1; j < P; j++) {
        const dx = x[2 * i] - x[2 * j];
        const dy = x[2 * i + 1] - x[2 * j + 1];
        const d = Math.hypot(dx, dy);
        const over = 2 * r - d;
        if (over > 0) {
          const wij = w ? (w[i] + w[j]) / 2 : 1;
          e += wij * over * over;
          if (grad && d > 0) {
            const gx = (-2 * wij * over * dx) / d;
            const gy = (-2 * wij * over * dy) / d;
            grad[2 * i] += gx;
            grad[2 * i + 1] += gy;
            grad[2 * j] -= gx;
            grad[2 * j + 1] -= gy;
          }
        }
      }
    }
    return e;
  };

  const pieceEnergy = (s: KernelState, i: number, w?: Float64Array): number => {
    const r = softRadius(shapeOf(s));
    const x = s.x;
    const wi = w ? w[i] : 1;
    const out = Math.hypot(x[2 * i], x[2 * i + 1]) + r - s.size;
    let e = out > 0 ? wi * out * out : 0;
    for (let j = 0; j < P; j++) {
      if (j === i) continue;
      const over = 2 * r - Math.hypot(x[2 * i] - x[2 * j], x[2 * i + 1] - x[2 * j + 1]);
      if (over > 0) e += (w ? (w[i] + w[j]) / 2 : 1) * over * over;
    }
    return e;
  };

  return {
    ...base,
    space: "test-soft",
    id: `test-soft/disks/${P}`,
    shapes,
    shaped,
    finished,
    finishCost: o.finishCost ?? base.finishCost,
    validateCost: o.validateCost ?? base.validateCost,
    gradCost: o.gradCost ?? base.gradCost,
    bound: o.bound ?? base.bound,
    capabilities: o.seeds === false ? ["shape"] : ["shape", "seeds"],
    fromConfig: (c) => withShape(base.fromConfig(c)),
    clone: (s) => ({ x: Float64Array.from(s.x), size: s.size, aux: { t: shapeOf(s) } }),
    randomStart(rng) {
      const s = withShape(base.randomStart(rng))!;
      // a failing finish needs raw starts that overlap: the centres piled up in a quarter of the radius
      if (o.failAbove !== undefined) for (let i = 0; i < s.x.length; i++) s.x[i] *= 0.25;
      return s;
    },
    energy,
    pieceEnergy,
    clear(s, i, tol) {
      const r = softRadius(shapeOf(s));
      const x = s.x;
      if (Math.hypot(x[2 * i], x[2 * i + 1]) + r > s.size + tol) return false;
      for (let j = 0; j < P; j++)
        if (j !== i && Math.hypot(x[2 * i] - x[2 * j], x[2 * i + 1] - x[2 * j + 1]) < 2 * r - tol) return false;
      return true;
    },
    finish(s) {
      finished.push(shapeOf(s));
      if (o.failAbove !== undefined && base.energy(s) > o.failAbove) return null;
      return base.finish(s);
    },
    setShape(s, t) {
      shapes.push(t);
      shaped.push(s);
      s.aux = { t };
    },
    ...(o.seeds === false
      ? { seeds: undefined }
      : { seeds: (rng: Rng, count: number) => base.seeds!(rng, count).map((s) => withShape(s)!) }),
  };
}

/**
 * The soft disks in a circle whose radius saturates with the size, R = Rmax tanh(L / Rmax), as the
 * inradius of a hyperbolic polygon saturates with its side: near Rmax a unit of size buys very
 * little room. The size L is the score; the configuration keeps the circle's radius R.
 */
export function roomDisksKernel(P: number, Rmax: number): SpaceKernel {
  const base = softDisksKernel(P);
  const room = (L: number) => Rmax * Math.tanh(L / Rmax);
  const dRoom = (L: number) => 1 / Math.cosh(L / Rmax) ** 2;
  const size = (R: number) => (R < Rmax ? Rmax * Math.atanh(R / Rmax) : Infinity);
  const at = (s: KernelState): KernelState => ({ ...s, size: room(s.size) });
  return {
    ...base,
    id: `test-room/disks/${P}`,
    bound: size(base.bound!),
    // the seeds' sizes are radii; this kernel goes without them
    capabilities: ["shape"],
    seeds: undefined,
    fromConfig(c) {
      const s = base.fromConfig(c);
      if (s) s.size = size(s.size);
      return s && Number.isFinite(s.size) ? s : null;
    },
    toConfig: (s) => base.toConfig(at(s)),
    randomStart(rng) {
      const s = base.randomStart(rng);
      const R = Math.min(s.size, 0.98 * Rmax);
      for (let i = 0; i < s.x.length; i++) s.x[i] *= R / s.size;
      s.size = size(R);
      return s;
    },
    setSize(s, L) {
      const k = room(L) / room(s.size);
      for (let i = 0; i < s.x.length; i++) s.x[i] *= k;
      s.size = L;
    },
    energy(s, g, w) {
      const e = base.energy(at(s), g, w);
      if (g) g[s.x.length] *= dRoom(s.size);
      return e;
    },
    pieceEnergy: (s, i, w) => base.pieceEnergy(at(s), i, w),
    clear: (s, i, tol) => base.clear(at(s), i, tol),
    finish(s) {
      const f = base.finish(at(s));
      return f && f.score < Rmax ? { config: f.config, score: size(f.score) } : null;
    },
    validate(c) {
      const v = base.validate(c);
      return { ...v, score: v.score === null ? null : size(v.score) };
    },
  };
}
