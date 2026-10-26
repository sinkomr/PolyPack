/**
 * The reference kernel: P unit disks in a circle of radius R, in the plane. It belongs to no
 * space; it is the test bed of the generic methods, small and exact, with known optima
 * (DISKS_IN_CIRCLE_BEST, from Packomania), and the model a space kernel can be compared with.
 *
 * Configuration: { R, centres: [x, y][] }. State: x = the centres (dim 2), size = R, no charts.
 * Energy: max(0, 2 - |c_i - c_j|)^2 per pair and max(0, |c_i| + 1 - R)^2 per disk, with exact
 * gradients. finish() scales the centres by the factor that makes the closest pair touch and
 * takes the smallest R around them: a closed form, so a finish costs about one energy sweep.
 * Capabilities: "shape" (a disk is its own inscribed disk, so every soft shape is the disk
 * itself) and "seeds" (patches of the hexagonal lattice).
 */
import type { Finished, KernelState, Rng, SpaceKernel, Validation } from "../kernel";

/**
 * Best known R for P unit disks in a circle, P = 1 to 12: the values of data/records.json (N = 0,
 * M = 0), which come from Eckard Specht's Packomania (cci, read 2026-10-07). All but P = 12 are
 * proven optimal there.
 */
export const DISKS_IN_CIRCLE_BEST: Record<number, number> = {
  1: 1,
  2: 2,
  3: 2.1547005383792515,
  4: 2.414213562373095,
  5: 2.7013016167040798,
  6: 3,
  7: 3,
  8: 3.304764870962486,
  9: 3.613125929752753,
  10: 3.8130256313981246,
  11: 3.9238044001630872,
  12: 4.029601930116184,
};

export interface DisksConfig {
  R: number;
  centres: [number, number][];
}

/** The server-style rule of the reference problem: pairs at least 2 apart and disks inside, up to `tol`. */
export function validateDisks(P: number, config: unknown, tol = 1e-9): Validation {
  const c = config as DisksConfig;
  if (!c || typeof c.R !== "number" || !Number.isFinite(c.R) || !Array.isArray(c.centres) || c.centres.length !== P)
    return { valid: false, score: null, reasons: ["malformed configuration"] };
  const reasons: string[] = [];
  for (const [x, y] of c.centres) if (Math.hypot(x, y) + 1 > c.R + tol) reasons.push("a disk crosses the circle");
  for (let i = 0; i < P; i++)
    for (let j = i + 1; j < P; j++) {
      const d = Math.hypot(c.centres[i][0] - c.centres[j][0], c.centres[i][1] - c.centres[j][1]);
      if (d < 2 - tol) reasons.push(`disks ${i} and ${j} overlap`);
    }
  return { valid: reasons.length === 0, score: c.R, reasons: reasons.slice(0, 5) };
}

export function disksKernel(P: number): SpaceKernel {
  const dim = 2;
  const bound = Math.max(1, Math.sqrt(P));
  const state = (centres: number[], R: number): KernelState => ({ x: Float64Array.from(centres), size: R, aux: null });

  const energy = (s: KernelState, grad?: Float64Array, w?: Float64Array): number => {
    const x = s.x;
    const R = s.size;
    if (grad) grad.fill(0);
    let e = 0;
    for (let i = 0; i < P; i++) {
      const wi = w ? w[i] : 1;
      const r = Math.hypot(x[2 * i], x[2 * i + 1]);
      const out = r + 1 - R;
      if (out > 0) {
        e += wi * out * out;
        if (grad) {
          if (r > 0) {
            grad[2 * i] += (2 * wi * out * x[2 * i]) / r;
            grad[2 * i + 1] += (2 * wi * out * x[2 * i + 1]) / r;
          }
          grad[P * dim] -= 2 * wi * out;
        }
      }
      for (let j = i + 1; j < P; j++) {
        const dx = x[2 * i] - x[2 * j];
        const dy = x[2 * i + 1] - x[2 * j + 1];
        const d = Math.hypot(dx, dy);
        const over = 2 - d;
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
    const x = s.x;
    const wi = w ? w[i] : 1;
    const out = Math.hypot(x[2 * i], x[2 * i + 1]) + 1 - s.size;
    let e = out > 0 ? wi * out * out : 0;
    for (let j = 0; j < P; j++) {
      if (j === i) continue;
      const over = 2 - Math.hypot(x[2 * i] - x[2 * j], x[2 * i + 1] - x[2 * j + 1]);
      if (over > 0) e += (w ? (w[i] + w[j]) / 2 : 1) * over * over;
    }
    return e;
  };

  const toConfig = (s: KernelState): DisksConfig => ({
    R: s.size,
    centres: Array.from({ length: P }, (_, i) => [s.x[2 * i], s.x[2 * i + 1]] as [number, number]),
  });

  const uniformInDisk = (rng: Rng, radius: number): [number, number] => {
    const r = radius * Math.sqrt(rng());
    const a = 2 * Math.PI * rng();
    return [r * Math.cos(a), r * Math.sin(a)];
  };

  return {
    space: "reference",
    id: `reference/disks/${P}`,
    P,
    dim,
    steps: Float64Array.from([1, 1]),
    inradius: 1,
    globals: 0,
    globalSteps: new Float64Array(0),
    bound,
    finishCost: 1,
    capabilities: ["shape", "seeds"],
    fromConfig(config) {
      const c = config as DisksConfig;
      if (!c || !(c.R > 0) || !Array.isArray(c.centres) || c.centres.length !== P) return null;
      const flat: number[] = [];
      for (const p of c.centres) {
        if (!Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite)) return null;
        flat.push(p[0], p[1]);
      }
      return state(flat, c.R);
    },
    toConfig,
    clone: (s) => ({ x: Float64Array.from(s.x), size: s.size, aux: s.aux }),
    rebase() {},
    randomStart(rng) {
      const R = 2 * Math.sqrt(P) + 1;
      const flat: number[] = [];
      for (let i = 0; i < P; i++) flat.push(...uniformInDisk(rng, R - 1));
      return state(flat, R);
    },
    randomPose(s, i, rng) {
      const [x, y] = uniformInDisk(rng, Math.max(0, s.size - 1));
      s.x[2 * i] = x;
      s.x[2 * i + 1] = y;
    },
    jiggle(s, i, amount, rng) {
      s.x[2 * i] += (2 * rng() - 1) * amount;
      s.x[2 * i + 1] += (2 * rng() - 1) * amount;
    },
    setSize(s, size) {
      const k = size / s.size;
      for (let i = 0; i < s.x.length; i++) s.x[i] *= k;
      s.size = size;
    },
    energy,
    pieceEnergy,
    clear(s, i, tol) {
      const x = s.x;
      if (Math.hypot(x[2 * i], x[2 * i + 1]) + 1 > s.size + tol) return false;
      for (let j = 0; j < P; j++)
        if (j !== i && Math.hypot(x[2 * i] - x[2 * j], x[2 * i + 1] - x[2 * j + 1]) < 2 - tol) return false;
      return true;
    },
    finish(s): Finished | null {
      const x = s.x;
      let dmin = Infinity;
      for (let i = 0; i < P; i++)
        for (let j = i + 1; j < P; j++)
          dmin = Math.min(dmin, Math.hypot(x[2 * i] - x[2 * j], x[2 * i + 1] - x[2 * j + 1]));
      if (P > 1 && !(dmin > 1e-9)) return null;
      // the factor that makes the closest pair touch, nudged up until the rule holds at tolerance 0
      let lambda = P > 1 ? 2 / dmin : 1;
      for (let tries = 0; tries < 60; tries++) {
        let rmax = 0;
        const centres = Array.from({ length: P }, (_, i) => {
          const c: [number, number] = [lambda * x[2 * i], lambda * x[2 * i + 1]];
          rmax = Math.max(rmax, Math.hypot(c[0], c[1]));
          return c;
        });
        const config: DisksConfig = { R: rmax + 1, centres };
        if (validateDisks(P, config, 0).valid) return { config, score: config.R };
        lambda *= 1 + 4 * Number.EPSILON * (tries + 1);
      }
      return null;
    },
    validate: (config) => validateDisks(P, config),
    setShape() {},
    seeds(rng, count) {
      // hexagonal lattice points nearest a random offset, the P closest to the centre
      const out: KernelState[] = [];
      for (let n = 0; n < count; n++) {
        const ox = rng() * 2;
        const oy = rng() * Math.sqrt(3);
        const pts: [number, number][] = [];
        const reach = Math.ceil(Math.sqrt(P)) + 2;
        for (let a = -reach; a <= reach; a++)
          for (let b = -reach; b <= reach; b++) pts.push([2 * a + b + ox, Math.sqrt(3) * b + oy]);
        pts.sort((p, q) => Math.hypot(p[0], p[1]) - Math.hypot(q[0], q[1]));
        const chosen = pts.slice(0, P);
        const cx = chosen.reduce((t, p) => t + p[0], 0) / P;
        const cy = chosen.reduce((t, p) => t + p[1], 0) / P;
        const flat = chosen.flatMap(([x, y]) => [x - cx, y - cy]);
        let R = 1;
        for (let i = 0; i < P; i++) R = Math.max(R, Math.hypot(flat[2 * i], flat[2 * i + 1]) + 1);
        out.push(state(flat, R));
      }
      return out;
    },
  };
}
