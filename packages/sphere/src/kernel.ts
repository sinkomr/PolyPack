/**
 * The sphere space's kernel for the generic search methods (packages/methods/src/kernel.ts,
 * docs/methods/dimensions/README.md, docs/spaces/SPHERE.md "Kernel for the generic methods").
 *
 *  - State: per piece a rotation vector about a world axis, times rho (x_i = rho w_i, so that
 *    every variable is a length), applied to an anchor quaternion kept in aux: the pose is
 *    q_i = exp(w_i) q0_i, as in the search (search.ts). The size is rho; a piece's angular size is
 *    1/rho. `rebase` folds the rotations into the anchors.
 *  - Energy: kernel-energy.ts (separating-edge values for polygons, the cap distance for disks,
 *    a wall where the pieces stop existing), with its exact gradient.
 *  - finish(): the search's tight-size bisection (tightSize) to 1e-13 relative, with the energy's
 *    pair test at each step and the float validator at tolerance 0 on the result: on the whole
 *    sphere a larger rho shrinks every piece inside itself, so validity is monotone in rho.
 *  - validate(): the server's rule (packages/spaces/src/validate.ts): the configuration's format
 *    and ranges, the size against the kernel's bound (with the server's slack), then validate() of
 *    this package at the touching tolerance 1e-9. The server's strict check of a size below a
 *    research record (tolerance 1e-11) needs the record and stays with the server.
 *  - Capabilities: shape (caps cut from the polygons, kernel-energy.ts; a no-op for disks), seeds
 *    (Platonic and spiral centres, kernel-seeds.ts) and, for polygons, swap (orientations carried
 *    along the geodesic between the two centres).
 */
import type { Finished, KernelCapability, KernelState, SpaceKernel, Validation } from "@polypack/methods";
import {
  type Quat,
  type SphereConfig,
  type Vec3,
  areaBound,
  centreOf,
  pieceAngle,
  pieceExists,
  quatMul,
  rhoForAngle,
} from "./geometry";
import { SphereEnergy, type SphereStateView } from "./kernel-energy";
import { platonicCentres, posesFromCentres, spiralCentres, touchingRho } from "./kernel-seeds";
import { expQuat, maxAngle, normalized, randomQuat, tightRho, tightSize } from "./search";
import { validate as validateSphere } from "./validate";

/**
 * The server's touching tolerance and input bounds for sphere configurations (SPACE_TOL,
 * SPACE_MAX_SIZE, SPACE_MAX_COORD and SPACE_MIN_QUATERNION_NORM of packages/spaces/src/info.ts,
 * which this package cannot import: the spaces package depends on it).
 */
export const SPHERE_SERVER_RULE = {
  tol: 1e-9,
  maxSize: 1e6,
  maxCoord: 1e4,
  minQuaternionNorm: 1e-6,
  /** SPACE_BOUND_SLACK: a size below the bound by more than this relative amount is refused. */
  boundSlack: 1e-9,
} as const;

/** The kernel's data in KernelState.aux. */
export interface SphereKernelAux {
  /** Anchor quaternions, unit, 4 per piece. */
  q0: Float64Array;
  /** The soft-shape parameter (1 = the true shape). */
  t: number;
}

const supportedN = (N: number) => N === 0 || (Number.isInteger(N) && N >= 3 && N <= 100);

/** Energy evaluations one finish() and one validate() cost, by N (see the kernel's finishCost). */
const FINISH_COST: Record<number, number> = { 0: 30, 3: 100, 4: 500, 5: 500, 6: 800, 8: 2500 };
const VALIDATE_COST: Record<number, number> = { 0: 5, 3: 80, 4: 200, 5: 400, 6: 700, 8: 2500 };

/** The rotation vector w with exp(w) = q (|w| <= pi): the turn's angle times its axis. */
function rotationVector(q: Quat): Vec3 {
  const n = normalized(q);
  // q and -q are the same turn; the one with w >= 0 turns by at most pi
  const sign = n[0] < 0 ? -1 : 1;
  const s = Math.hypot(n[1], n[2], n[3]);
  if (s < 1e-300) return [0, 0, 0];
  const k = (2 * Math.atan2(s, sign * n[0])) / s;
  return [sign * k * n[1], sign * k * n[2], sign * k * n[3]];
}

/** The rotation taking unit vector u to unit vector v about u x v (the transport along the geodesic). */
function transport(u: Vec3, v: Vec3): Quat {
  const c = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const ax = u[1] * v[2] - u[2] * v[1];
  const ay = u[2] * v[0] - u[0] * v[2];
  const az = u[0] * v[1] - u[1] * v[0];
  // [1 + cos d, sin d axis] is the half-angle quaternion of the turn by d, before normalization
  if (1 + c > 1e-12) return normalized([1 + c, ax, ay, az]);
  // antipodal: a half turn about an axis at right angles to u
  const e = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const n = [u[1] * e[2] - u[2] * e[1], u[2] * e[0] - u[0] * e[2], u[0] * e[1] - u[1] * e[0]];
  const l = Math.hypot(n[0], n[1], n[2]);
  return [0, n[0] / l, n[1] / l, n[2] / l];
}

export function sphereKernel(problem: { N: number; P: number }): SpaceKernel {
  const { N, P } = problem;
  if (!supportedN(N) || !Number.isInteger(P) || P < 1 || P > 100)
    throw new Error(`bad sphere problem ${JSON.stringify(problem)}`);
  const dim = 3;
  // The largest angular size the kernel uses. For polygons it is 2 pi / N (1 - 1e-12), much closer
  // to the existence limit than the search's maxAngle (1 - 1e-9): one or two polygons, whose area
  // bound is that limit (an infimum), then finish within the framework's 1e-9 of the bound, so a
  // run can stop there. Validity is the validator's, here as everywhere.
  const aMax = N === 0 ? maxAngle(N, P) : ((2 * Math.PI) / N) * (1 - 1e-12);
  const model = new SphereEnergy(N, P, aMax);
  // one step moves a piece by about its inradius (side 1, or a disk of diameter 1: radius 1/2)
  const step = N === 0 ? 0.5 : 1 / (2 * Math.tan(Math.PI / N));
  const bound = areaBound(N, P);
  const capabilities: KernelCapability[] = N === 0 ? ["shape", "seeds"] : ["shape", "seeds", "swap"];
  const auxOf = (s: KernelState) => s.aux as SphereKernelAux;
  const view = (s: KernelState) => s as SphereStateView;

  const stateOf = (q: readonly Quat[], rho: number): KernelState => {
    const q0 = new Float64Array(4 * P);
    q.forEach((p, i) => q0.set(normalized(p), 4 * i));
    const aux: SphereKernelAux = { q0, t: 1 };
    return { x: new Float64Array(dim * P), size: rho, aux };
  };

  /** The pose of piece i: exp(x_i / rho) q0_i, unit. */
  const pose = (s: KernelState, i: number): Quat => {
    const q0 = auxOf(s).q0;
    const a: Quat = [q0[4 * i], q0[4 * i + 1], q0[4 * i + 2], q0[4 * i + 3]];
    const x = s.x;
    if (x[3 * i] === 0 && x[3 * i + 1] === 0 && x[3 * i + 2] === 0) return a;
    return normalized(quatMul(expQuat(x[3 * i] / s.size, x[3 * i + 1] / s.size, x[3 * i + 2] / s.size), a));
  };
  const poses = (s: KernelState): Quat[] => Array.from({ length: P }, (_, i) => pose(s, i));
  /** Moves the anchor of piece i to its pose, x_i to 0 (rebase only: the methods undo moves by writing x back). */
  const setAnchor = (s: KernelState, i: number) => {
    auxOf(s).q0.set(pose(s, i), 4 * i);
    s.x.fill(0, 3 * i, 3 * i + 3);
  };
  /** Turns piece i to pose q through x_i alone: exp(x_i / rho) q0_i = q. */
  const setPose = (s: KernelState, i: number, q: Quat) => {
    const q0 = auxOf(s).q0;
    const inv: Quat = [q0[4 * i], -q0[4 * i + 1], -q0[4 * i + 2], -q0[4 * i + 3]];
    const w = rotationVector(quatMul(q, inv));
    for (let c = 0; c < 3; c++) s.x[3 * i + c] = s.size * w[c];
  };

  const toConfig = (s: KernelState): SphereConfig => ({ rho: s.size, pieces: poses(s).map((q) => ({ q })) });

  /** The server's rule: format and ranges, then the validator at the touching tolerance. */
  const serverRule = (config: unknown): Validation => {
    const fail = (reasons: string[], score: number | null = null): Validation => ({ valid: false, score, reasons });
    const c = config as { rho?: unknown; pieces?: unknown };
    if (!c || typeof c !== "object" || Array.isArray(c)) return fail(["config must be an object"]);
    const rule = SPHERE_SERVER_RULE;
    const rho = c.rho;
    if (typeof rho !== "number" || !Number.isFinite(rho) || !(rho > 0) || rho > rule.maxSize)
      return fail([`rho must be a positive finite number of at most ${rule.maxSize}`]);
    if (!Array.isArray(c.pieces)) return fail(["pieces must be an array"], rho);
    if (c.pieces.length !== P) return fail([`expected ${P} pieces for this problem, got ${c.pieces.length}`], rho);
    const reasons: string[] = [];
    const pieces = c.pieces.map((p: unknown, i) => {
      const q = (p as { q?: unknown } | null)?.q;
      const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= rule.maxCoord;
      if (!Array.isArray(q) || q.length !== 4 || !q.every(finite))
        reasons.push(`pieces[${i}] must be an object {q: [w, x, y, z]} of numbers of at most ${rule.maxCoord}`);
      else if (!(Math.hypot(...(q as number[])) >= rule.minQuaternionNorm))
        reasons.push(`pieces[${i}].q must have a norm of at least ${rule.minQuaternionNorm}`);
      return { q: q as Quat };
    });
    if (reasons.length) return fail(reasons.slice(0, 20), rho);
    if (rho < bound * (1 - rule.boundSlack))
      return fail([`the size ${rho} is below the lower bound ${bound} of this problem`], rho);
    const v = validateSphere({ N, P }, { rho, pieces }, { tol: rule.tol });
    if (v.valid) return { valid: true, score: rho, reasons: [] };
    if (v.errors.length) return fail(v.errors, rho);
    const [i, j] = v.worstPair ?? [-1, -1];
    return fail([`pieces ${i} and ${j} overlap by ${-v.minGap}`], rho);
  };

  return {
    space: "sphere",
    id: `sphere/${N}/${P}`,
    P,
    dim,
    steps: Float64Array.from([step, step, step]),
    globals: 0,
    globalSteps: new Float64Array(0),
    // the planar piece's (lengths on the sphere of radius rho are in the units of rho)
    inradius: step,
    bound,
    // [CALC] measured at P = 10 to 30 (8-gons: 10), squeezed states, rounded up: a finish is a
    // bisection with the energy's pair test (about 50 sweeps) and one call of the validator, whose
    // max-margin planes cost far more than a sweep for polygons
    finishCost: FINISH_COST[N] ?? 2500,
    validateCost: VALIDATE_COST[N] ?? 2500,
    capabilities,

    fromConfig(config) {
      const c = config as SphereConfig;
      if (!c || typeof c !== "object" || !(c.rho > 0) || !Number.isFinite(c.rho)) return null;
      if (!Array.isArray(c.pieces) || c.pieces.length !== P) return null;
      const q: Quat[] = [];
      for (const p of c.pieces) {
        const v = p?.q;
        if (!Array.isArray(v) || v.length !== 4 || !v.every((e) => typeof e === "number" && Number.isFinite(e)))
          return null;
        if (!(Math.hypot(...v) > 0)) return null;
        q.push([v[0], v[1], v[2], v[3]]);
      }
      return stateOf(q, c.rho);
    },
    toConfig,
    clone(s) {
      const aux: SphereKernelAux = { q0: Float64Array.from(auxOf(s).q0), t: auxOf(s).t };
      return { x: Float64Array.from(s.x), size: s.size, aux };
    },
    rebase(s) {
      for (let i = 0; i < P; i++) if (s.x[3 * i] !== 0 || s.x[3 * i + 1] !== 0 || s.x[3 * i + 2] !== 0) setAnchor(s, i);
    },
    randomStart(rng) {
      // the search's start: uniformly random poses at rho = (area bound) / 0.7
      const q = Array.from({ length: P }, () => randomQuat(rng));
      return stateOf(q, bound / 0.7);
    },
    randomPose(s, i, rng) {
      // a uniformly random turn of the anchor is a uniformly random pose
      const w = rotationVector(randomQuat(rng));
      for (let c = 0; c < 3; c++) s.x[3 * i + c] = s.size * w[c];
    },
    jiggle(s, i, amount, rng) {
      for (let c = 0; c < dim; c++) s.x[dim * i + c] += (2 * rng() - 1) * amount * step;
    },
    setSize(s, size) {
      // the same quaternions: x = rho w scales with rho
      const k = size / s.size;
      for (let i = 0; i < s.x.length; i++) s.x[i] *= k;
      s.size = size;
    },
    energy: (s, grad, weights) => model.energy(view(s), grad, weights),
    pieceEnergy: (s, i, weights) => model.pieceEnergy(view(s), i, weights),
    clear: (s, i, tol) => model.clear(view(s), i, tol),
    finish(s, shouldStop): Finished | null {
      const q = poses(s);
      const q0 = new Float64Array(4 * P);
      q.forEach((p, i) => q0.set(p, 4 * i));
      const configAt = (rho: number): SphereConfig => ({ rho, pieces: q.map((p) => ({ q: p })) });
      const validAt = (rho: number) => {
        const v = validateSphere({ N, P }, configAt(rho), { tol: 0 });
        return v.errors.length === 0 && v.minGap >= 0;
      };
      // the search's bisection (tightRho), with the energy's own pair test in place of the
      // validator at each step: the same answer except within float rounding at the contacts.
      // When it finds no valid size within a factor of about 14, neither would the validator.
      const fast = tightSize(
        (r) => pieceAngle(N, r) < aMax && pieceExists(N, r) && model.separatedAt(q0, r),
        s.size,
        rhoForAngle(N, aMax),
      );
      if (fast === null) return null;
      // the validator decides: the bisection's end, or just above it (by up to 7e-12) past rounding at a contact
      let rho: number | null = null;
      for (let k = 0; k < 4 && rho === null; k++) {
        const r = k === 0 ? fast : fast * (1 + 1e-13 * 4 ** k);
        if (validAt(r)) rho = r;
      }
      if (rho === null) {
        // rare: the validator's own bisection from there, which polls the stop between its steps
        const stopped = new Error("stopped");
        try {
          rho = tightRho({ N, P }, q, fast, () => {
            if (shouldStop?.()) throw stopped;
          });
        } catch (e) {
          if (e !== stopped) throw e;
          return null;
        }
        if (rho === null) return null;
      }
      return { config: configAt(rho), score: rho };
    },
    validate: serverRule,

    setShape(s, t) {
      if (N !== 0) auxOf(s).t = Math.max(0, Math.min(1, t));
    },
    seeds(rng, count) {
      const kinds: { C: Vec3[]; aligned: boolean }[] = [];
      const platonic = platonicCentres(P);
      for (const C of platonic ? [platonic, spiralCentres(P)] : [spiralCentres(P)])
        for (const aligned of N === 0 ? [false] : [true, false]) kinds.push({ C, aligned });
      const out: KernelState[] = [];
      for (let n = 0; n < count; n++) {
        const { C, aligned } = kinds[n % kinds.length];
        out.push(stateOf(posesFromCentres(N, C, rng, aligned), touchingRho(N, P, C)));
      }
      return out;
    },
    ...(N === 0
      ? {}
      : {
          swap(s: KernelState, i: number, j: number) {
            // each piece takes the other's orientation, carried along the geodesic between the centres
            const qi = pose(s, i);
            const qj = pose(s, j);
            const T = transport(centreOf(qj), centreOf(qi));
            const Tinv: Quat = [T[0], -T[1], -T[2], -T[3]];
            setPose(s, i, quatMul(T, qj));
            setPose(s, j, quatMul(Tinv, qi));
          },
        }),
  };
}
