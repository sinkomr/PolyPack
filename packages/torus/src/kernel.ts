/**
 * The torus space's kernel for the generic search methods (packages/methods/src/kernel.ts,
 * docs/methods/dimensions/README.md, docs/spaces/TORUS.md "Kernel for the generic methods").
 *
 *  - State: as in the search (search.ts), a base packing in aux (basis, centres, angles) mapped by
 *    k F: k = size / (score of the base lattice) scales lattice and centres together, and for the
 *    free family F = [[e^t1, t2], [0, e^-t1]] (determinant 1) shears the cell; t1 and t2 are the
 *    kernel's 2 globals (sq and hex have none). Per piece: the centre's offset in the base frame
 *    and the angle's offset times the circumradius (disks: the centre only), so every variable
 *    is a length. The size is the torus score (L, or the square root of the cell area for free).
 *    `rebase` folds offsets, scale and shear into the base packing. It, fromConfig and the starts
 *    also reduce a free basis that is skewed and bring far centres back into the cell, which leave
 *    the packing as it is (positions count modulo the lattice). fromConfig refuses numbers beyond
 *    the server's limits, as the server does.
 *  - Energy: kernel-energy.ts (squared penetration depths of all image pairs within reach, with
 *    the shared kernel's analytic derivatives).
 *  - finish(): the search's tight-scale bisection (scaleSearch) to 1e-13 relative, with the
 *    energy's pair test at each step and the float validator at tolerance 0 on the result; a free
 *    basis is first Lagrange-Gauss reduced, as the server stores it.
 *  - validate(): the server's rule (packages/spaces/src/validate.ts): format and ranges, the size
 *    against the kernel's bound (with the server's slack), the lattice's shortest vector and
 *    enumeration window, then validateTorusPacking at 1e-9. The server's strict check of a size
 *    below a research record (tolerance 1e-11) needs the record and stays with the server.
 *  - Capabilities: shape (rounded polygons; a no-op for disks), seeds (lattice placements,
 *    kernel-seeds.ts) and, for polygons, swap (the angles of two pieces).
 */
import { type Pose, boundingRadius, inradius, isShapeCode, pieceArea } from "@polypack/geometry";
import type { Finished, KernelCapability, KernelState, SpaceKernel, Validation } from "@polypack/methods";
import { TorusEnergy, type TorusKernelAux, type TorusStateView, familyBasis } from "./kernel-energy";
import { latticeSeed } from "./kernel-seeds";
import {
  type Lattice,
  SQRT3_2,
  TORUS_FAMILIES,
  type TorusFamily,
  familyLattice,
  gaussReduce,
  imageWindow,
  latticeCoordinates,
  torusScore,
} from "./lattice";
import { scaleSearch, scaledLattice, tightScale } from "./search";
import { areaScoreBound, validateTorusPacking } from "./validate";

export type { TorusKernelAux } from "./kernel-energy";

/** A torus configuration in the space's format (docs/spaces/TORUS.md, the API's torus space). */
export interface TorusConfig {
  lattice: { L: number } | { b1: [number, number]; b2: [number, number] };
  poses: [number, number, number][];
}

/**
 * The server's touching tolerance and input bounds for torus configurations (SPACE_TOL,
 * SPACE_MAX_SIZE, SPACE_MAX_COORD and TORUS_MAX_TRANSLATES of packages/spaces/src/info.ts, which
 * this package cannot import: the spaces package depends on it).
 */
export const TORUS_SERVER_RULE = {
  tol: 1e-9,
  maxSize: 1e6,
  maxCoord: 1e4,
  maxTranslates: 1000,
  /** SPACE_BOUND_SLACK: a size below the bound by more than this relative amount is refused. */
  boundSlack: 1e-9,
} as const;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finiteUpTo = (v: unknown, max: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= max;

export function torusKernel(problem: { family: TorusFamily; N: number; P: number }): SpaceKernel {
  const { family, N, P } = problem;
  if (!TORUS_FAMILIES.includes(family) || !isShapeCode(N) || !Number.isInteger(P) || P < 1)
    throw new Error(`bad torus problem ${JSON.stringify(problem)}`);
  const model = new TorusEnergy(family, N, P);
  const { dim, globals, R } = model;
  const r = N === 0 ? 1 : inradius(N);
  // one step moves a piece by about its inradius
  const steps = Float64Array.from(dim === 3 ? [r, r, r] : [1, 1]);
  // Thue's density pi / sqrt(12) bounds disks in the plane, hence on every torus (TORUS.md section 1)
  const bound = areaScoreBound(family, N, P, N === 0 ? Math.PI / Math.sqrt(12) : 1);
  const capabilities: KernelCapability[] = N === 0 ? ["shape", "seeds"] : ["shape", "seeds", "swap"];
  const auxOf = (s: KernelState) => s.aux as TorusKernelAux;
  const view = (s: KernelState) => s as TorusStateView;

  /** A clean state for a lattice and poses (the size is the lattice's score). */
  const stateOf = (lattice: Lattice, poses: readonly Pose[]): KernelState => {
    const sb = torusScore(family, lattice);
    const aux: TorusKernelAux = {
      B: new Float64Array(4),
      sb,
      u: new Float64Array(2 * P),
      th: new Float64Array(P),
      t: 1,
    };
    anchor(aux, lattice, poses, sb);
    return { x: new Float64Array(P * dim + globals), size: sb, aux };
  };

  /**
   * Sets the base packing to a lattice and poses at score `size` (fromConfig, the starts and
   * rebase). A free basis that is skewed is replaced by a reduced one, centres more than a cell
   * outside the cell come back into it, and angles beyond 1000 radians come back by turns of the
   * piece: none of this changes the packing, and it keeps the image enumeration short.
   */
  const anchor = (a: TorusKernelAux, l: Lattice, poses: readonly Pose[], size: number) => {
    let lattice = l;
    if (family === "free") {
      const n2 = (q: Lattice) => q.b1[0] ** 2 + q.b1[1] ** 2 + q.b2[0] ** 2 + q.b2[1] ** 2;
      const red = reduced(lattice);
      if (n2(lattice) > 1.5 * n2(red)) lattice = red;
      a.B.set([lattice.b1[0], lattice.b1[1], lattice.b2[0], lattice.b2[1]]);
    } else a.B.set(familyBasis(family, size));
    a.sb = size;
    const turn = N === 0 ? 0 : (2 * Math.PI) / N;
    poses.forEach((p, i) => {
      const [fa, fb] = latticeCoordinates(lattice, [p.x, p.y]);
      const [x, y] = fa < -1 || fa >= 2 || fb < -1 || fb >= 2 ? wrapped(lattice, p.x, p.y) : [p.x, p.y];
      a.u[2 * i] = x;
      a.u[2 * i + 1] = y;
      a.th[i] = turn && Math.abs(p.theta) > 1000 ? p.theta - turn * Math.round(p.theta / turn) : p.theta;
    });
  };

  /** The map k F of the base frame to the plane, as in the energy. */
  const frame = (s: KernelState) => {
    const k = s.size / auxOf(s).sb;
    const et = globals ? Math.exp(s.x[P * dim]) : 1;
    const t2 = globals ? s.x[P * dim + 1] : 0;
    return { f11: k * et, f12: k * t2, f22: k / et };
  };
  const latticeOf = (s: KernelState): Lattice => {
    if (family !== "free") return familyLattice(family, s.size);
    const { f11, f12, f22 } = frame(s);
    const B = auxOf(s).B;
    return { b1: [f11 * B[0] + f12 * B[1], f22 * B[1]], b2: [f11 * B[2] + f12 * B[3], f22 * B[3]] };
  };
  const posesOf = (s: KernelState): Pose[] => {
    const { f11, f12, f22 } = frame(s);
    const a = auxOf(s);
    return Array.from({ length: P }, (_, i) => {
      const px = a.u[2 * i] + s.x[dim * i];
      const py = a.u[2 * i + 1] + s.x[dim * i + 1];
      return { x: f11 * px + f12 * py, y: f22 * py, theta: dim === 3 ? a.th[i] + s.x[dim * i + 2] / R : a.th[i] };
    });
  };
  const configOf = (lattice: Lattice, poses: readonly Pose[]): TorusConfig => ({
    lattice:
      family === "free"
        ? { b1: [lattice.b1[0], lattice.b1[1]], b2: [lattice.b2[0], lattice.b2[1]] }
        : { L: Math.hypot(lattice.b1[0], lattice.b1[1]) },
    poses: poses.map((p) => [p.x, p.y, p.theta]),
  });

  /** A Lagrange-Gauss reduced basis of the lattice, with the orientation of the given one. */
  const reduced = (l: Lattice): Lattice => {
    const red = gaussReduce(l).lattice;
    const flip =
      Math.sign(red.b1[0] * red.b2[1] - red.b1[1] * red.b2[0]) !== Math.sign(l.b1[0] * l.b2[1] - l.b1[1] * l.b2[0]);
    return { b1: red.b1, b2: flip ? [-red.b2[0], -red.b2[1]] : red.b2 };
  };
  /** Positions brought into the cell [0, 1)^2 of the lattice, modulo lattice vectors. */
  const wrapped = (l: Lattice, x: number, y: number): [number, number] => {
    const [a, b] = latticeCoordinates(l, [x, y]);
    const m = Math.floor(a);
    const n = Math.floor(b);
    return [x - m * l.b1[0] - n * l.b2[0], y - m * l.b1[1] - n * l.b2[1]];
  };

  /** The server's rule: format and ranges, the work bounds, then the validator at the touching tolerance. */
  const serverRule = (config: unknown): Validation => {
    const rule = TORUS_SERVER_RULE;
    const fail = (reasons: string[], score: number | null = null): Validation => ({ valid: false, score, reasons });
    if (!isObject(config)) return fail(["config must be an object"]);
    const l = config.lattice;
    let lattice: Lattice;
    if (!isObject(l))
      return fail([family === "free" ? "lattice must be {b1: [x, y], b2: [x, y]}" : "lattice must be {L}"]);
    if (family !== "free") {
      if (!("L" in l) || "b1" in l || "b2" in l) return fail([`a ${family} lattice is given as {L}`]);
      if (!finiteUpTo(l.L, rule.maxSize) || !(l.L > 0))
        return fail([`lattice.L must be positive, at most ${rule.maxSize}`]);
      lattice = familyLattice(family, l.L);
    } else {
      const vec = (v: unknown): [number, number] | null =>
        Array.isArray(v) && v.length === 2 && finiteUpTo(v[0], rule.maxSize) && finiteUpTo(v[1], rule.maxSize)
          ? [v[0], v[1]]
          : null;
      const b1 = "L" in l ? null : vec(l.b1);
      const b2 = "L" in l ? null : vec(l.b2);
      if (!b1 || !b2)
        return fail([`a free lattice is given as {b1: [x, y], b2: [x, y]} of numbers of at most ${rule.maxSize}`]);
      if (!(Math.abs(b1[0] * b2[1] - b1[1] * b2[0]) > 0))
        return fail(["lattice.b1 and lattice.b2 must be linearly independent"]);
      lattice = { b1, b2 };
    }
    const score = torusScore(family, lattice);
    const list = config.poses;
    if (!Array.isArray(list)) return fail(["poses must be an array"], score);
    if (list.length !== P) return fail([`expected ${P} pieces for this problem, got ${list.length}`], score);
    const bad = list.findIndex(
      (p) => !Array.isArray(p) || p.length !== 3 || !p.every((v) => finiteUpTo(v, rule.maxCoord)),
    );
    if (bad >= 0) return fail([`poses[${bad}] must be [x, y, theta] of numbers of at most ${rule.maxCoord}`], score);
    if (score < bound * (1 - rule.boundSlack))
      return fail([`the size ${score} is below the lower bound ${bound} of this problem`], score);
    // a lattice vector shorter than the piece's width makes a piece overlap its own translate
    const shortest = gaussReduce(lattice).lattice.b1;
    const width = 2 * r;
    const len = Math.hypot(shortest[0], shortest[1]);
    if (len < width - rule.tol)
      return fail([`the lattice has a vector of length ${len}, shorter than the piece's width ${width}`], score);
    const { X1, X2 } = imageWindow(lattice, 2 * boundingRadius(N) + 2e-7);
    if (!((2 * X1 + 3) * (2 * X2 + 3) <= rule.maxTranslates))
      return fail([`the lattice basis is too skewed (at most ${rule.maxTranslates} translates per pair)`], score);
    const poses = (list as number[][]).map(([x, y, theta]) => ({ x, y, theta }));
    const v = validateTorusPacking({ family, N, lattice, poses }, { tol: rule.tol });
    if (v.errors.length) return fail(v.errors.slice(0, 20), score);
    if (!v.valid)
      return fail(
        v.overlaps
          .slice(0, 20)
          .map((o) =>
            o.i === o.j
              ? `piece ${o.i} overlaps its own translate by (${o.m}, ${o.n}) lattice vectors, by ${-o.sep}`
              : `pieces ${o.i} and ${o.j} overlap (translate (${o.m}, ${o.n})) by ${-o.sep}`,
          ),
        score,
      );
    return { valid: true, score, reasons: [] };
  };

  return {
    space: "torus",
    id: `torus/${family}/${N}/${P}`,
    P,
    dim,
    steps,
    globals,
    // a shear by r / size moves a piece near the far side of the cell by about r
    globalSteps: Float64Array.from(globals ? [r / bound, r / bound] : []),
    inradius: r,
    bound,
    // [CALC] measured at P = 10 and 30 in every family, squeezed states, rounded up: a finish is a
    // bisection with the energy's pair test (9 to 45 sweeps), a validate one to 8 sweeps
    finishCost: 50,
    validateCost: 10,
    capabilities,

    fromConfig(config) {
      // malformed as the server reads it: not the family's lattice, or numbers beyond its limits
      const rule = TORUS_SERVER_RULE;
      if (!isObject(config) || !isObject(config.lattice) || !Array.isArray(config.poses) || config.poses.length !== P)
        return null;
      const l = config.lattice;
      let lattice: Lattice;
      if (family === "free") {
        const ok = (v: unknown): v is [number, number] =>
          Array.isArray(v) && v.length === 2 && v.every((e) => finiteUpTo(e, rule.maxSize));
        if (!ok(l.b1) || !ok(l.b2)) return null;
        lattice = { b1: [l.b1[0], l.b1[1]], b2: [l.b2[0], l.b2[1]] };
        if (!(torusScore(family, lattice) > 0)) return null;
      } else {
        if (!finiteUpTo(l.L, rule.maxSize) || !(l.L > 0)) return null;
        lattice = familyLattice(family, l.L);
      }
      const poses: Pose[] = [];
      for (const p of config.poses) {
        if (!Array.isArray(p) || p.length !== 3 || !p.every((v) => finiteUpTo(v, rule.maxCoord))) return null;
        poses.push({ x: p[0], y: p[1], theta: p[2] });
      }
      return stateOf(lattice, poses);
    },
    toConfig: (s) => configOf(latticeOf(s), posesOf(s)),
    clone(s) {
      const a = auxOf(s);
      const aux: TorusKernelAux = {
        B: Float64Array.from(a.B),
        sb: a.sb,
        u: Float64Array.from(a.u),
        th: Float64Array.from(a.th),
        t: a.t,
      };
      return { x: Float64Array.from(s.x), size: s.size, aux };
    },
    rebase(s) {
      anchor(auxOf(s), latticeOf(s), posesOf(s), s.size);
      s.x.fill(0);
    },
    randomStart(rng) {
      // the search's start: random poses in a cell of density 0.45 (free: square or hexagonal)
      const area = (P * pieceArea(N)) / 0.45;
      const shape: "sq" | "hex" = family === "free" ? (rng() < 0.5 ? "sq" : "hex") : family;
      const l = familyLattice(shape, shape === "sq" ? Math.sqrt(area) : Math.sqrt(area / SQRT3_2));
      const poses = Array.from({ length: P }, () => {
        const fa = rng();
        const fb = rng();
        return {
          x: fa * l.b1[0] + fb * l.b2[0],
          y: fa * l.b1[1] + fb * l.b2[1],
          theta: N === 0 ? 0 : 2 * Math.PI * rng(),
        };
      });
      return stateOf(l, poses);
    },
    randomPose(s, i, rng) {
      // through x_i alone (the methods undo a move by writing x_i back): a uniformly random
      // offset in the base cell, and turn, moves the piece to a uniformly random pose
      const B = auxOf(s).B;
      const fa = rng();
      const fb = rng();
      s.x[dim * i] = fa * B[0] + fb * B[2];
      s.x[dim * i + 1] = fa * B[1] + fb * B[3];
      if (dim === 3) s.x[dim * i + 2] = R * 2 * Math.PI * rng();
    },
    jiggle(s, i, amount, rng) {
      for (let c = 0; c < dim; c++) s.x[dim * i + c] += (2 * rng() - 1) * amount * steps[c];
    },
    setSize(s, size) {
      // centres live in the base frame and scale with k = size / sb
      s.size = size;
    },
    energy: (s, grad, weights) => model.energy(view(s), grad, weights),
    pieceEnergy: (s, i, weights) => model.pieceEnergy(view(s), i, weights),
    clear: (s, i, tol) => model.clear(view(s), i, tol),
    finish(s, shouldStop): Finished | null {
      let lattice = latticeOf(s);
      if (family === "free") lattice = reduced(lattice);
      const poses = posesOf(s).map((p) => {
        const [x, y] = wrapped(lattice, p.x, p.y);
        return { x, y, theta: p.theta };
      });
      // the search's bisection (tightScale), with the energy's own pair test in place of the
      // validator at each step: the same separation values, without the validator's bookkeeping.
      // When it finds no valid scale within a factor of about 14, neither would the validator.
      const at = (k: number) => ({
        lattice: scaledLattice(family, lattice, k),
        poses: poses.map((p) => ({ x: p.x * k, y: p.y * k, theta: p.theta })),
      });
      const validAt = (k: number) => {
        const v = validateTorusPacking({ family, N, ...at(k) }, { tol: 0 });
        return v.errors.length === 0 && v.valid && v.minSep >= 0;
      };
      const fast = scaleSearch((k) => {
        const p = at(k);
        return model.separatedAt(p.lattice, p.poses);
      });
      if (fast === null) return null;
      // the validator decides: the bisection's end, or just above it (by up to 7e-12) past rounding at a contact
      let k: number | null = null;
      for (let n = 0; n < 4 && k === null; n++) {
        const kk = n === 0 ? fast : fast * (1 + 1e-13 * 4 ** n);
        if (validAt(kk)) k = kk;
      }
      if (k === null) {
        // rare: the validator's own bisection, which polls the stop between its steps
        const stopped = new Error("stopped");
        try {
          const t = tightScale({ family, N, P }, { lattice, poses }, () => {
            if (shouldStop?.()) throw stopped;
          });
          return t && { config: configOf(t.lattice, t.poses), score: t.score };
        } catch (e) {
          if (e !== stopped) throw e;
          return null;
        }
      }
      const p = at(k);
      return { config: configOf(p.lattice, p.poses), score: torusScore(family, p.lattice) };
    },
    validate: serverRule,

    setShape(s, t) {
      if (N !== 0) auxOf(s).t = Math.max(0, Math.min(1, t));
    },
    seeds(rng, count) {
      return Array.from({ length: count }, () => {
        const { lattice, poses } = latticeSeed(family, N, P, rng);
        return stateOf(lattice, poses);
      });
    },
    ...(N === 0
      ? {}
      : {
          swap(s: KernelState, i: number, j: number) {
            // through the angle offsets alone: theta_i = th_i + x / R
            const th = auxOf(s).th;
            const ti = th[i] + s.x[dim * i + 2] / R;
            const tj = th[j] + s.x[dim * j + 2] / R;
            s.x[dim * i + 2] = R * (tj - th[i]);
            s.x[dim * j + 2] = R * (ti - th[j]);
          },
        }),
  };
}
