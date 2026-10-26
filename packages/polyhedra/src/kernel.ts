/**
 * The polyhedra space's kernel for the generic search methods (packages/methods/src/kernel.ts,
 * docs/methods/dimensions/README.md; docs/spaces/POLYHEDRA.md, "Kernel for the generic methods"): P congruent
 * copies of the piece solid in the container solid scaled by s.
 *
 * State. Piece i owns x[6i .. 6i + 5]: its centre (3 lengths, in the units of the canonical solids), then its
 * chart rotation r, a rotation vector times the piece's circumradius Rc so that it reads as a length: the piece is
 * turned by exp([r / Rc]x) A_i, the anchor A_i a unit quaternion kept in aux (r turns the anchored piece about its
 * centre, in the world frame). A change d of r moves no vertex by more than |d|, to first order. rebase folds r
 * into A_i. size is s, the score. Centres are absolute (the container s C is centred at the origin), so setSize
 * scales them by the ratio of the sizes.
 *
 * Energy: the soft-to-rigid simulator's model (sim/geom.ts) in canonical units. At shape parameter t a piece is
 * t P (+) B((1 - t) rho), the piece solid P scaled by t about its centre and dilated by (1 - t) rho, rho its
 * inradius: the solid at t = 1, its inscribed ball at t = 0, and inside the solid for every t, since P's support
 * h_P(u) is at least rho in every direction. For a pair, with sd the signed distance of the cores t P_i and t P_j
 * (minus their exact penetration depth by the separating-axis test when they overlap, their Euclidean distance
 * when they do not; sdCores), the overlap is
 *   o = 2 (1 - t) rho - sd,
 * the exact penetration depth of the soft pieces: their Minkowski difference is the cores' one dilated by
 * 2 (1 - t) rho. The overlap with container face f (unit outward normal N_f, offset b_f) is the soft piece's
 * support beyond the face, max_v N_f . X_v + (1 - t) rho - s b_f over the core's world vertices X_v. Then
 *   E = sum_pairs (w_i + w_j) / 2 o_+^2 + sum_pieces sum_faces w_i (wall overlap)_+^2,
 * with analytic gradients: sdCores' for the pairs, the extreme vertex's lever arm for the walls, both in the
 * centres and in world-frame rotations, which the left Jacobian of exp maps to r (kernel-rotation.ts). The model
 * is exact at t = 1, so a configuration valid at tolerance 0 has zero energy.
 *
 * finish() is the space's own: the legalization and the polish of polish.ts (penalty weights 1e4 to 1e9, the
 * search's polish of a start), each result checked with validatePolyhedra at tolerance 0, the smaller kept. The
 * polish polls the stop it is given and ends early, leaving the legalized result.
 * validate() is the server's rule (packages/spaces/src/validate.ts) for every entry that does not beat the research
 * record: P at most POLYHEDRA_MAX_P, the configuration read as the server reads it, its s not below the volume
 * bound by more than 1e-9 relative, then validatePolyhedra at the touching tolerance 1e-9. Left out: the server
 * also checks an entry below the record's certified s by more than 1e-6 relative at the strict tolerance 1e-11.
 * That needs the record, which the kernel does not have; finish() gives configurations valid at tolerance 0,
 * which pass it.
 */
import type { Finished, KernelCapability, KernelState, Rng, SpaceKernel, Validation } from "@polypack/methods";
import type { Pose } from "./geom";
import { POLYHEDRA_MAX_P } from "./info";
import { chartGradient, expQuat, logQuat, mulQuat, randomQuat, unitQuat } from "./kernel-rotation";
import { latticeSeed } from "./kernel-seeds";
import { StopSearch, legalizeConfig, polishConfig } from "./polish";
import { formatPolyhedraId, getProblem, volumeBound } from "./problems";
import { parsePolyhedraConfig } from "./records";
import { GR, type SimPose, pose, prepShape, sdCores } from "./sim/geom";
import { getSolid } from "./solids";
import { POLYHEDRA_TOL, type PolyhedraConfig, configErrors, validatePolyhedra } from "./validate";

/** The kernel's own data in a state's aux. */
interface PolyhedraAux {
  /** Each piece's anchor rotation, a unit quaternion (w, x, y, z): 4 numbers per piece. */
  a: Float64Array;
  /** The shape parameter t in [0, 1] (1: the true solids). */
  t: number;
}

/** Penalty weights of finish()'s polish: those of the search's polish of a start (search.ts). */
const FINISH_MUS = [1e4, 1e5, 1e6, 1e7, 1e8, 1e9];
/** Pair and wall clearance finish() keeps: the search's default. */
const FINISH_CLEARANCE = 1e-12;
/** The server's slack below the lower bound (SPACE_BOUND_SLACK of packages/spaces). */
const BOUND_SLACK = 1e-9;
/** The server's reasons listed at most (MAX_REASONS of packages/spaces/src/validate.ts). */
const MAX_REASONS = 20;
/** Volume fraction of a random start: the pieces fill about this much of the container. */
const START_FILL = 0.15;

export function polyhedraKernel(problem: { code: string; P: number }): SpaceKernel {
  const pb = getProblem(problem.code);
  if (!pb) throw new Error(`unknown polyhedra problem ${problem.code}`);
  const P = problem.P;
  if (!Number.isInteger(P) || P < 1) throw new Error("P must be a positive integer");
  // the server refuses a P above its catalogue's, so no state of a larger P could ever be submitted or kept
  if (P > POLYHEDRA_MAX_P) throw new RangeError(`P must be at most ${POLYHEDRA_MAX_P}, the largest P the server accepts`);
  const piece = getSolid(pb.piece);
  const cont = getSolid(pb.container);
  // the piece in canonical units (sim/geom.ts scales to inradius 1/2 unless told otherwise)
  const shape = prepShape(piece, 1);
  // Edge-edge axes of the separating-axis test: all pairs of edge directions (nd^2 axes of 2 nv projections each)
  // or the Gauss-map pruned ones (ne^2 arc tests, then the few Minkowski face normals). Both sets hold every face
  // normal of the Minkowski difference, so the penetration depth is the same either way; only the time differs.
  // [CALC] Per overlapping pair the full set costs about 0.012 us x nd^2 nv and the pruned one about 0.03 us x ne^2,
  // so prune when nd^2 nv > 2 ne^2 (the simulator's own rule, set for its runs, prunes later). This is this
  // kernel's copy of the shape; the simulator's is not changed.
  shape.prune = shape.edirs.length ** 2 * shape.nv > 2 * shape.edges.length ** 2;
  // [CALC] Costs in energy() calls, fitted to medians of three squeezed random starts for 12 solids at P = 2 to 80
  // (docs/spaces/POLYHEDRA.md, "Kernel for the generic methods"). A finish takes a fixed part and a few ms of
  // processor time per piece whatever the solid; the energy takes per piece a part that grows with the separating-
  // axis test of one overlapping pair (satUs, modelled as above). So a finish costs about
  //   (1150 + 250 P) / (P (1 + satUs / 35))
  // energies: 805 for 2 cubes, 266 for 50; 80 for 2 truncated icosidodecahedra, 27 for 50. The measured
  // ratio was 0.44 to 2.4 times this for 80 % of the cases (median 0.94), from 0.14 to 5.7 in all: the polish
  // takes from a few to hundreds of iterations, depending on the start. A validate costs 1 to 4 energies for 90 %
  // of the cases (median 1.9), more at small P (up to 18 for 3 truncated icosidodecahedra): about 2 + 4 / P.
  const satUs = shape.prune ? 0.03 * shape.edges.length ** 2 : 0.012 * shape.edirs.length ** 2 * shape.nv;
  const finishCost = Math.max(10, Math.round((1150 + 250 * P) / (P * (1 + satUs / 35))));
  const validateCost = 2 + 4 / P;
  const rho = piece.inradius;
  const Rc = piece.circumradius;
  const CN = cont.N;
  const Cb = cont.offsets;
  const F = Cb.length;
  // every face offset is at least the container's inradius, so s' C with s' = s - d / rhoC lies d inside s C
  const rhoC = cont.inradius;
  const boxLo = [Infinity, Infinity, Infinity];
  const boxHi = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < cont.nv; v++)
    for (let d = 0; d < 3; d++) {
      boxLo[d] = Math.min(boxLo[d], cont.V[3 * v + d]);
      boxHi[d] = Math.max(boxHi[d], cont.V[3 * v + d]);
    }
  const dim = 6;
  const bound = volumeBound(pb, P);
  const Q = new Float64Array(4);

  const auxOf = (s: KernelState) => s.aux as PolyhedraAux;

  /** Piece i's unit quaternion exp(r / Rc) A_i, into Q. */
  const quatOf = (x: Float64Array, a: Float64Array, i: number) => {
    const o = dim * i;
    expQuat(x[o + 3] / Rc, x[o + 4] / Rc, x[o + 5] / Rc, Q);
    mulQuat(Q, 0, a, 4 * i, Q);
  };

  /** Piece i's core (the solid scaled by k about its centre) in the world. */
  const placeCore = (x: Float64Array, a: Float64Array, i: number, k: number): SimPose => {
    quatOf(x, a, i);
    const o = dim * i;
    return pose(shape, [x[o], x[o + 1], x[o + 2]], [Q[0], Q[1], Q[2], Q[3]], k);
  };

  /**
   * True when the line between the centres already separates the cores A and B by at least `gap`: then their
   * distance is at least that too and the soft pieces do not overlap. A cheap first test before sdCores, which scans
   * every candidate axis.
   */
  const apartAlongCentres = (A: SimPose, B: SimPose, gap: number): boolean => {
    let ux = B.c[0] - A.c[0];
    let uy = B.c[1] - A.c[1];
    let uz = B.c[2] - A.c[2];
    const l = Math.hypot(ux, uy, uz);
    if (!(l > 0)) return false;
    ux /= l;
    uy /= l;
    uz /= l;
    let hiA = -Infinity;
    let loB = Infinity;
    const XA = A.X;
    const XB = B.X;
    for (let v = 0; v < XA.length; v += 3) hiA = Math.max(hiA, ux * XA[v] + uy * XA[v + 1] + uz * XA[v + 2]);
    for (let v = 0; v < XB.length; v += 3) loB = Math.min(loB, ux * XB[v] + uy * XB[v + 1] + uz * XB[v + 2]);
    return loB - hiA >= gap;
  };

  /** A centre uniformly at random in scale C (rejection from its bounding box; the origin if that keeps failing). */
  const centreIn = (scale: number, rng: Rng, x: Float64Array, o: number) => {
    for (let tries = 0; tries < 1000; tries++) {
      const p = [0, 1, 2].map((d) => scale * (boxLo[d] + (boxHi[d] - boxLo[d]) * rng()));
      let inside = true;
      for (let f = 0; f < F && inside; f++)
        inside = CN[3 * f] * p[0] + CN[3 * f + 1] * p[1] + CN[3 * f + 2] * p[2] <= scale * Cb[f];
      if (inside) {
        x[o] = p[0];
        x[o + 1] = p[1];
        x[o + 2] = p[2];
        return;
      }
    }
    x[o] = x[o + 1] = x[o + 2] = 0;
  };

  /** True when the size, every variable and every anchor of s are finite numbers. */
  const finite = (s: KernelState): boolean => {
    if (!Number.isFinite(s.size)) return false;
    const x = s.x;
    for (let k = 0; k < x.length; k++) if (!Number.isFinite(x[k])) return false;
    const a = auxOf(s).a;
    for (let k = 0; k < a.length; k++) if (!Number.isFinite(a[k])) return false;
    return true;
  };

  /**
   * The energy's terms (see the file comment): all of them, or with only >= 0 those of piece `only` (its pairs and
   * its walls). With `grad`, its gradient in x and, last, in the size.
   */
  const terms = (s: KernelState, grad: Float64Array | undefined, w: Float64Array | undefined, only: number): number => {
    // a state that blew up has no geometry: Infinity, which L-BFGS's line search takes as too long a step (NaN would
    // slip through the energy's `> 0` tests as 0)
    if (!finite(s)) {
      grad?.fill(0);
      return Infinity;
    }
    const { a, t } = auxOf(s);
    const x = s.x;
    const r = (1 - t) * rho;
    // a soft piece lies in the ball of radius t Rc + r about its centre
    const reach = 2 * (t * Rc + r);
    const cores: (SimPose | null)[] = new Array(P).fill(null);
    const core = (i: number) => cores[i] ?? (cores[i] = placeCore(x, a, i, t));
    const GC = grad ? new Float64Array(3 * P) : null;
    const GT = grad ? new Float64Array(3 * P) : null;
    let gs = 0;
    let e = 0;

    const wall = (i: number) => {
      const wi = w ? w[i] : 1;
      const o = dim * i;
      for (let f = 0; f < F; f++) {
        const nx = CN[3 * f];
        const ny = CN[3 * f + 1];
        const nz = CN[3 * f + 2];
        const lim = s.size * Cb[f];
        // no vertex of the core is farther than t Rc from the centre
        if (nx * x[o] + ny * x[o + 1] + nz * x[o + 2] + t * Rc + r <= lim) continue;
        const X = core(i).X;
        let m = -Infinity;
        let im = 0;
        for (let v = 0; v < X.length; v += 3) {
          const p = nx * X[v] + ny * X[v + 1] + nz * X[v + 2];
          if (p > m) {
            m = p;
            im = v;
          }
        }
        const viol = m + r - lim;
        if (!(viol > 0)) continue;
        e += wi * viol * viol;
        if (GC && GT) {
          const c2 = 2 * wi * viol;
          GC[3 * i] += c2 * nx;
          GC[3 * i + 1] += c2 * ny;
          GC[3 * i + 2] += c2 * nz;
          // turning by dw moves the extreme vertex by dw x lever, so d(N . X)/dw = lever x N
          const lx = X[im] - x[o];
          const ly = X[im + 1] - x[o + 1];
          const lz = X[im + 2] - x[o + 2];
          GT[3 * i] += c2 * (ly * nz - lz * ny);
          GT[3 * i + 1] += c2 * (lz * nx - lx * nz);
          GT[3 * i + 2] += c2 * (lx * ny - ly * nx);
          gs -= c2 * Cb[f];
        }
      }
    };

    // a pair is always taken as (lower index, higher index), so energy() and pieceEnergy() compute it alike
    const pair = (p: number, q: number) => {
      const op = dim * p;
      const oq = dim * q;
      if (Math.hypot(x[op] - x[oq], x[op + 1] - x[oq + 1], x[op + 2] - x[oq + 2]) >= reach) return;
      if (apartAlongCentres(core(p), core(q), 2 * r)) return;
      const sd = sdCores(core(p), core(q), 2 * r, GC !== null);
      const ov = 2 * r - sd;
      if (!(ov > 0)) return;
      const wpq = w ? (w[p] + w[q]) / 2 : 1;
      e += wpq * ov * ov;
      if (GC && GT) {
        const c2 = -2 * wpq * ov;
        for (let d = 0; d < 3; d++) {
          GC[3 * p + d] += c2 * GR[d];
          GT[3 * p + d] += c2 * GR[3 + d];
          GC[3 * q + d] += c2 * GR[6 + d];
          GT[3 * q + d] += c2 * GR[9 + d];
        }
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

    if (grad && GC && GT) {
      grad.fill(0);
      for (let i = 0; i < P; i++) {
        const o = dim * i;
        grad[o] = GC[3 * i];
        grad[o + 1] = GC[3 * i + 1];
        grad[o + 2] = GC[3 * i + 2];
        // dE/dr = J_l(w)^T dE/dw / Rc for the chart rotation w = r / Rc
        chartGradient(x[o + 3] / Rc, x[o + 4] / Rc, x[o + 5] / Rc, GT[3 * i], GT[3 * i + 1], GT[3 * i + 2], 1 / Rc, grad, o + 3);
      }
      grad[P * dim] = gs;
    }
    return e;
  };

  const toConfig = (s: KernelState): PolyhedraConfig => {
    const { a } = auxOf(s);
    const x = s.x;
    const pieces: Pose[] = [];
    for (let i = 0; i < P; i++) {
      quatOf(x, a, i);
      const o = dim * i;
      pieces.push([x[o], x[o + 1], x[o + 2], Q[0], Q[1], Q[2], Q[3]]);
    }
    return { s: s.size, pieces };
  };

  const state = (x: Float64Array, size: number, a: Float64Array): KernelState => ({
    x,
    size,
    aux: { a, t: 1 } satisfies PolyhedraAux,
  });

  const capabilities: KernelCapability[] = ["shape", "seeds", "swap"];

  return {
    space: "polyhedra",
    id: formatPolyhedraId(pb.code, P),
    P,
    dim,
    // a step of rho moves the centre by the inradius, or turns no vertex farther than that
    steps: new Float64Array(dim).fill(rho),
    // rho is the piece's inradius in the pieces' own units; s scales the container, so a size step
    // of rho moves its walls by rho times the container's inradius at s = 1 (a size scale, not exact)
    inradius: rho,
    globals: 0,
    globalSteps: new Float64Array(0),
    bound,
    finishCost,
    validateCost,
    capabilities,

    fromConfig(config) {
      // malformed, or outside the server's limits (s at most 1e6, centres at most 1e4, quaternion components at
      // most 1e100 and norms at least 1e-6; validate.ts): null, so that no method works on a state no submission
      // could have
      if (configErrors(config, P, 1).length) return null;
      const c = config as PolyhedraConfig;
      const x = new Float64Array(dim * P);
      const a = new Float64Array(4 * P);
      for (let i = 0; i < P; i++) {
        const p = c.pieces[i];
        x[dim * i] = p[0];
        x[dim * i + 1] = p[1];
        x[dim * i + 2] = p[2];
        unitQuat(p, 3, a, 4 * i);
      }
      return state(x, c.s, a);
    },
    toConfig,
    clone(s) {
      const { a, t } = auxOf(s);
      return { x: Float64Array.from(s.x), size: s.size, aux: { a: Float64Array.from(a), t } satisfies PolyhedraAux };
    },
    rebase(s) {
      const { a } = auxOf(s);
      const x = s.x;
      for (let i = 0; i < P; i++) {
        const o = dim * i;
        if (x[o + 3] === 0 && x[o + 4] === 0 && x[o + 5] === 0) continue;
        quatOf(x, a, i);
        a.set(Q, 4 * i);
        x[o + 3] = x[o + 4] = x[o + 5] = 0;
      }
    },
    randomStart(rng) {
      // roomy: the pieces fill START_FILL of the container, and every centre is at least Rc inside it
      const size = Math.max(Math.cbrt((P * piece.volume) / (START_FILL * cont.volume)), (Rc + rho) / rhoC);
      const x = new Float64Array(dim * P);
      const a = new Float64Array(4 * P);
      for (let i = 0; i < P; i++) {
        centreIn(size - Rc / rhoC, rng, x, dim * i);
        randomQuat(rng, a, 4 * i);
      }
      return state(x, size, a);
    },
    randomPose(s, i, rng) {
      // A centre whose inscribed ball lies in the container, and a uniformly random orientation. The orientation is
      // written as the chart's rotation D, uniformly random, so that the anchor stays and writing piece i's x back
      // undoes the move; D A_i is uniformly random for any anchor A_i (the uniform measure is invariant).
      const o = dim * i;
      centreIn(Math.max(0, s.size - rho / rhoC), rng, s.x, o);
      randomQuat(rng, Q);
      logQuat(Q, 0, Rc, s.x, o + 3);
    },
    jiggle(s, i, amount, rng) {
      for (let d = 0; d < dim; d++) s.x[dim * i + d] += (2 * rng() - 1) * amount * rho;
    },
    setSize(s, size) {
      const f = size / s.size;
      for (let i = 0; i < P; i++) for (let d = 0; d < 3; d++) s.x[dim * i + d] *= f;
      s.size = size;
    },
    energy: (s, grad, w) => terms(s, grad, w, -1),
    pieceEnergy: (s, i, w) => terms(s, undefined, w, i),
    clear(s, i, tol) {
      if (!finite(s)) return false;
      const { a, t } = auxOf(s);
      const x = s.x;
      const r = (1 - t) * rho;
      const reach = 2 * (t * Rc + r);
      const o = dim * i;
      let Ci: SimPose | null = null;
      for (let f = 0; f < F; f++) {
        const nx = CN[3 * f];
        const ny = CN[3 * f + 1];
        const nz = CN[3 * f + 2];
        const lim = s.size * Cb[f] + tol;
        if (nx * x[o] + ny * x[o + 1] + nz * x[o + 2] + t * Rc + r <= lim) continue;
        Ci ??= placeCore(x, a, i, t);
        const X = Ci.X;
        for (let v = 0; v < X.length; v += 3) if (nx * X[v] + ny * X[v + 1] + nz * X[v + 2] + r > lim) return false;
      }
      for (let j = 0; j < P; j++) {
        if (j === i) continue;
        const oj = dim * j;
        if (Math.hypot(x[o] - x[oj], x[o + 1] - x[oj + 1], x[o + 2] - x[oj + 2]) >= reach) continue;
        Ci ??= placeCore(x, a, i, t);
        const Cj = placeCore(x, a, j, t);
        // in the energy's pair order
        const [A, B] = i < j ? [Ci, Cj] : [Cj, Ci];
        if (apartAlongCentres(A, B, 2 * r)) continue;
        const sd = sdCores(A, B, 2 * r, false);
        if (2 * r - sd > tol) return false;
      }
      return true;
    },
    finish(s, shouldStop): Finished | null {
      let best: PolyhedraConfig | null = null;
      const keep = (c: PolyhedraConfig) => {
        if ((!best || c.s < best.s) && validatePolyhedra(pb, c, { tol: 0 }).valid) best = c;
      };
      const done = (): Finished | null => {
        const out = best as PolyhedraConfig | null;
        return out ? { config: out, score: out.s } : null;
      };
      // the true solids, whatever the state's shape; a state the server could not read (not finite, out of its
      // ranges) finishes to nothing
      const start = toConfig(s);
      if (configErrors(start, P, 1).length) return null;
      // The legalization is not polled: it is a few separating-axis sweeps, and it gives the finish a valid result
      // to return when a stop comes during the polish.
      const legal = legalizeConfig(pb, start, FINISH_CLEARANCE, FINISH_CLEARANCE);
      keep(legal);
      if (shouldStop?.()) return done();
      // The polish polls at every evaluation (tick) and in the work between them (poll). A stop at an evaluation
      // makes it legalize what it has, which polls again and so ends it; either way StopSearch comes out of it.
      const stop = () => {
        if (shouldStop?.()) throw new StopSearch("aborted");
      };
      try {
        const polished = polishConfig(pb, legal, {
          pairClearance: FINISH_CLEARANCE,
          wallClearance: FINISH_CLEARANCE,
          mus: FINISH_MUS,
          tick: stop,
          poll: stop,
        });
        keep(polished.config);
      } catch (e) {
        if (!(e instanceof StopSearch)) throw e;
      }
      return done();
    },
    validate(config): Validation {
      // (P is at most POLYHEDRA_MAX_P, as the server requires: the factory refuses a larger one)
      const parsed = parsePolyhedraConfig(config, P, MAX_REASONS);
      if (!parsed.ok) return { valid: false, score: null, reasons: parsed.errors.slice(0, MAX_REASONS) };
      const c = parsed.config;
      if (c.s < bound * (1 - BOUND_SLACK))
        return { valid: false, score: c.s, reasons: [`the size ${c.s} is below the lower bound ${bound} of this problem`] };
      const v = validatePolyhedra(pb, c, { tol: POLYHEDRA_TOL, maxErrors: MAX_REASONS });
      if (v.valid) return { valid: true, score: c.s, reasons: [] };
      const reasons = v.errors.slice(0, MAX_REASONS);
      return {
        valid: false,
        score: c.s,
        reasons: reasons.length ? reasons : [`not a valid packing (smallest separation ${v.minPairSep})`],
      };
    },
    setShape(s, t) {
      auxOf(s).t = Math.min(1, Math.max(0, t));
    },
    seeds(rng, count) {
      // box-lattice patches (kernel-seeds.ts): the canonical orientation, plain and staggered, then random ones
      const out: KernelState[] = [];
      const q = new Float64Array(4);
      for (let n = 0; n < count; n++) {
        if (n < 2) q.set([1, 0, 0, 0]);
        else randomQuat(rng, q);
        const { centres, size } = latticeSeed(piece, cont, P, q, n % 2 === 1, rng);
        const x = new Float64Array(dim * P);
        const a = new Float64Array(4 * P);
        for (let i = 0; i < P; i++) {
          x.set(centres.subarray(3 * i, 3 * i + 3), dim * i);
          a.set(q, 4 * i);
        }
        out.push(state(x, size, a));
      }
      return out;
    },
    swap(s, i, j) {
      // the whole orientation (anchor and chart) of each piece, so that a swap is exactly reversible
      const { a } = auxOf(s);
      for (let d = 0; d < 4; d++) [a[4 * i + d], a[4 * j + d]] = [a[4 * j + d], a[4 * i + d]];
      for (let d = 3; d < dim; d++) [s.x[dim * i + d], s.x[dim * j + d]] = [s.x[dim * j + d], s.x[dim * i + d]];
    },
  };
}
