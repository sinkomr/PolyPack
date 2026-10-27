/**
 * The balls kernel for unit balls (radius r = BALL_RADIUS) in a ball, a cube or another solid (kernel.ts has the
 * whole kernel's description).
 *
 * State. Ball i owns x[3i .. 3i + 2], its centre, absolute (the container is centred at the origin, so there are
 * no charts and rebase has nothing to fold); size is s. aux is unused.
 *
 * Energy. For a pair, the overlap 2 r - |c_i - c_j|; for the ball container of radius s the protrusion
 * |c_i| + r - s; for the cube [-s/2, s/2]^3 one term per face, +-c_ik + r - s/2; for any other solid s C one term
 * per face f, N_f . c_i + r - s b_f (container.ts). E is the weighted sum of their
 * squared positive parts, with its exact gradient. Each is minus one of the validator's gaps (validate.ts), rounded
 * as the validator rounds it (a floating-point difference changes only its sign when its terms are swapped), so the
 * energy is zero exactly when the configuration is valid at tolerance 0, and clear() agrees with the validator at
 * any tolerance. A ball is its own inscribed ball: setShape changes nothing.
 */
import type { KernelCapability, KernelState, Rng, SpaceKernel } from "@polypack/methods";
import { centreIn, latticeCut, legalizeBalls } from "./ball-pieces";
import { BALL_DIAMETER, BALL_RADIUS, type BallsProblem, ballContainerRadius, ballContainerRadiusSlope, ballContainerScore } from "./catalogue";
import { containerKind, containerOfProblem, wallGap } from "./container";
import { ballsServerRule, finishBallsConfig } from "./kernel-rule";
import { pieceVolume } from "./problems";
import { BALLS_CLEARANCE } from "./search";
import { type BallsConfig, ballsConfigErrors } from "./validate";

/** Volume fraction of a random start: the balls fill about this much of the container. */
const START_FILL = 0.15;

/** The lattice cuts of the search's new starts (ball-pieces.ts freshStart), in the order the seeds take them. */
const BALL_SEEDS: readonly ["fcc" | "hcp" | "sc", boolean][] = [
  ["fcc", true],
  ["hcp", true],
];
const CUBE_SEEDS: readonly ["fcc" | "hcp" | "sc", boolean][] = [
  ["fcc", false],
  ["sc", false],
  ["fcc", true],
  ["hcp", true],
];
const SOLID_SEEDS: readonly ["fcc" | "hcp" | "sc", boolean][] = [
  ["fcc", false],
  ["hcp", false],
  ["sc", false],
  ["fcc", true],
  ["hcp", true],
];

export function ballPiecesKernel(pb: BallsProblem, P: number, common: { id: string; bound: number }): SpaceKernel {
  const dim = 3;
  const kind = containerKind(pb);
  const cube = kind === "cube";
  const C = kind === "polyhedron" ? containerOfProblem(pb) : null;
  // [CALC] Costs in energy() calls, from the medians of three squeezed random starts for balls in a ball and in a
  // cube at P = 2, 3, 5, 10, 20, 40, 80 and 100 (processor time, Node 26 on Apple Silicon, 2026-10-26; docs/spaces/
  // BALLS.md, "Kernel for the generic methods"). An energy takes about 1 us up to P = 10 and 0.02 ms at P = 100
  // (every pair is tested). A finish cost 190 to 2,500 energies up to P = 5 and 6,500 to 8,300 from P = 20 on, where
  // its polish runs out of iterations at every penalty weight (about 0.19 s at P = 100); at P = 10, 450 to 6,200,
  // depending on the start. Fitted: max(500, 7500 P^2 / (P^2 + 200)), which the measured finishes were 0.47 to 1.4
  // times in 80 % of the 48 runs (median 1.03; 0.18 to 5.0 in all). A validate (two checks, at the touching and the
  // strict tolerance) cost 1.9 to 3.2 energies. [CALC] For balls in another solid the same bench (balls in the tetrahedron,
  // the pentakis dodecahedron, the disdyakis triacontahedron, the 12-gonal prism of height 3 and the 12-gonal
  // trapezohedron, P = 5, 10, 30 and 80, the same day) found finishes of 1,100 to 8,800 energies, 0.2 to 6.8 times the
  // fit (above 3 times only at P of 10 or less on the solids with many faces, where the fit is 833 to 2,500), and
  // validates of 0.4 to 1.3 energies: the fit is kept.
  const finishCost = Math.max(500, Math.round((7500 * P * P) / (P * P + 200)));
  const validateCost = 2.5;
  const state = (x: Float64Array, size: number): KernelState => ({ x, size, aux: null });

  const finite = (s: KernelState): boolean => {
    if (!Number.isFinite(s.size)) return false;
    for (let k = 0; k < s.x.length; k++) if (!Number.isFinite(s.x[k])) return false;
    return true;
  };

  /**
   * The energy's terms: all of them, or with only >= 0 those of ball `only` (its pairs and its walls). With `grad`,
   * its gradient in x and, last, in the size.
   */
  const terms = (s: KernelState, grad: Float64Array | undefined, w: Float64Array | undefined, only: number): number => {
    // a state that blew up has no geometry: Infinity, which L-BFGS's line search takes as too long a step
    if (!finite(s)) {
      grad?.fill(0);
      return Infinity;
    }
    grad?.fill(0);
    const x = s.x;
    const S = s.size;
    let e = 0;
    let gs = 0;
    const wall = (i: number) => {
      const wi = w ? w[i] : 1;
      const o = 3 * i;
      if (C) {
        // one term per face, minus the validator's gap s b_f - r - N_f . c, rounded as wallGap rounds it
        for (let f = 0; f < C.F; f++) {
          const nx = C.N[3 * f];
          const ny = C.N[3 * f + 1];
          const nz = C.N[3 * f + 2];
          const viol = -(S * C.b[f] - BALL_RADIUS - (nx * x[o] + ny * x[o + 1] + nz * x[o + 2]));
          if (!(viol > 0)) continue;
          e += wi * viol * viol;
          if (grad) {
            const c = 2 * wi * viol;
            grad[o] += c * nx;
            grad[o + 1] += c * ny;
            grad[o + 2] += c * nz;
            gs -= c * C.b[f];
          }
        }
      } else if (cube) {
        const h = S / 2 - BALL_RADIUS;
        for (let d = 0; d < 3; d++) {
          const v = x[o + d];
          // the faces at +s/2 and -s/2 along axis d: both can be crossed when s < 2
          const hi = v - h;
          if (hi > 0) {
            e += wi * hi * hi;
            if (grad) {
              grad[o + d] += 2 * wi * hi;
              gs -= wi * hi;
            }
          }
          const lo = -v - h;
          if (lo > 0) {
            e += wi * lo * lo;
            if (grad) {
              grad[o + d] -= 2 * wi * lo;
              gs -= wi * lo;
            }
          }
        }
      } else {
        const r = Math.hypot(x[o], x[o + 1], x[o + 2]);
        // minus the validator's gap (s - r) - |c|, rounded as it rounds it, so that the term is positive exactly when
        // the validator sees a protrusion at tolerance 0
        const viol = -(ballContainerRadius(S) - BALL_RADIUS - r);
        if (!(viol > 0)) return;
        e += wi * viol * viol;
        if (grad) {
          if (r > 0) {
            const c = (2 * wi * viol) / r;
            grad[o] += c * x[o];
            grad[o + 1] += c * x[o + 1];
            grad[o + 2] += c * x[o + 2];
          }
          gs -= 2 * wi * viol * ballContainerRadiusSlope();
        }
      }
    };
    const pair = (i: number, j: number) => {
      const oi = 3 * i;
      const oj = 3 * j;
      const dx = x[oi] - x[oj];
      const dy = x[oi + 1] - x[oj + 1];
      const dz = x[oi + 2] - x[oj + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (!(d2 < BALL_DIAMETER * BALL_DIAMETER)) return;
      const d = Math.sqrt(d2);
      // minus the validator's sqrt(d2) - 2 r
      const ov = BALL_DIAMETER - d;
      const wij = w ? (w[i] + w[j]) / 2 : 1;
      e += wij * ov * ov;
      // coincident centres have no direction to be pushed apart in: no gradient (the finish's legalization separates them)
      if (grad && d > 0) {
        const c = (2 * wij * ov) / d;
        grad[oi] -= c * dx;
        grad[oi + 1] -= c * dy;
        grad[oi + 2] -= c * dz;
        grad[oj] += c * dx;
        grad[oj + 1] += c * dy;
        grad[oj + 2] += c * dz;
      }
    };
    if (only >= 0) {
      wall(only);
      for (let j = 0; j < P; j++) if (j !== only) pair(Math.min(only, j), Math.max(only, j));
    } else
      for (let i = 0; i < P; i++) {
        wall(i);
        for (let j = i + 1; j < P; j++) pair(i, j);
      }
    if (grad) grad[P * dim] = gs;
    return e;
  };

  const toConfig = (s: KernelState): BallsConfig => ({
    s: s.size,
    pieces: Array.from({ length: P }, (_, i) => [s.x[3 * i], s.x[3 * i + 1], s.x[3 * i + 2]]),
  });

  const capabilities: KernelCapability[] = ["shape", "seeds"];

  return {
    space: "balls",
    id: common.id,
    P,
    dim,
    // a step of 1 moves a ball by its radius
    steps: new Float64Array(dim).fill(BALL_RADIUS),
    inradius: BALL_RADIUS,
    globals: 0,
    globalSteps: new Float64Array(0),
    bound: common.bound,
    finishCost,
    validateCost,
    capabilities,

    fromConfig(config) {
      // malformed, or outside the server's limits (s at most 1e6, coordinates at most 1e4): null, so that no method
      // works on a state no submission could have
      if (ballsConfigErrors(pb, config, P).length) return null;
      const c = config as BallsConfig;
      const x = new Float64Array(dim * P);
      for (let i = 0; i < P; i++) x.set(c.pieces[i].slice(0, 3), 3 * i);
      return state(x, c.s);
    },
    toConfig,
    clone: (s) => state(Float64Array.from(s.x), s.size),
    rebase() {},
    randomStart(rng) {
      // roomy: the balls fill START_FILL of the container, and each fits in it
      const v = pieceVolume(pb);
      const size = C
        ? Math.max(Math.cbrt((P * v) / (START_FILL * C.volume)), (2 * BALL_RADIUS) / C.inradius)
        : cube
          ? Math.max(Math.cbrt((P * v) / START_FILL), 2 * BALL_DIAMETER)
          : ballContainerScore(Math.max(BALL_RADIUS * Math.cbrt(P / START_FILL), BALL_DIAMETER));
      const x = new Float64Array(dim * P);
      for (let i = 0; i < P; i++) x.set(centreIn(pb, size, rng), 3 * i);
      return state(x, size);
    },
    randomPose(s, i, rng) {
      s.x.set(centreIn(pb, s.size, rng), 3 * i);
    },
    jiggle(s, i, amount, rng) {
      for (let d = 0; d < 3; d++) s.x[3 * i + d] += (2 * rng() - 1) * amount;
    },
    setSize(s, size) {
      const f = size / s.size;
      for (let k = 0; k < s.x.length; k++) s.x[k] *= f;
      s.size = size;
    },
    energy: (s, grad, w) => terms(s, grad, w, -1),
    pieceEnergy: (s, i, w) => terms(s, undefined, w, i),
    clear(s, i, tol) {
      if (!finite(s)) return false;
      const x = s.x;
      const o = 3 * i;
      // the validator's gaps, computed as it computes them (validate.ts), each refused below -tol
      if (C) {
        if (wallGap(C, s.size, BALL_RADIUS, x[o], x[o + 1], x[o + 2]) < -tol) return false;
      } else if (cube) {
        const h = s.size / 2 - BALL_RADIUS;
        if (h - Math.abs(x[o]) < -tol || h - Math.abs(x[o + 1]) < -tol || h - Math.abs(x[o + 2]) < -tol) return false;
      } else if (ballContainerRadius(s.size) - BALL_RADIUS - Math.hypot(x[o], x[o + 1], x[o + 2]) < -tol) return false;
      for (let j = 0; j < P; j++) {
        if (j === i) continue;
        const dx = x[o] - x[3 * j];
        const dy = x[o + 1] - x[3 * j + 1];
        const dz = x[o + 2] - x[3 * j + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < (1.25 * BALL_DIAMETER) ** 2 && Math.sqrt(d2) - BALL_DIAMETER < -tol) return false;
      }
      return true;
    },
    finish: (s, shouldStop) => finishBallsConfig(pb, P, toConfig(s), shouldStop),
    validate: (config) => ballsServerRule(pb, P, common.bound, config),
    // a ball is its own inscribed ball, so every soft shape is the ball itself
    setShape() {},
    seeds(rng, count) {
      // cuts of the lattice packings the search starts from (ball-pieces.ts latticeCut), turned and shifted by the
      // stream, legalized: packings already, at the size they need
      const kinds = C ? SOLID_SEEDS : cube ? CUBE_SEEDS : BALL_SEEDS;
      const out: KernelState[] = [];
      for (let n = 0; n < count; n++) {
        const [kind, turn] = kinds[n % kinds.length];
        const c = legalizeBalls(pb, latticeCut(pb, P, rng, kind, turn), BALLS_CLEARANCE, BALLS_CLEARANCE);
        const x = new Float64Array(dim * P);
        c.pieces.forEach((p, i) => x.set(p, 3 * i));
        out.push(state(x, c.s));
      }
      return out;
    },
  };
}
