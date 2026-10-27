/**
 * The balls kernel for unit-edge solids, any of the polyhedra space's 94, in a ball (kernel.ts has the whole
 * kernel's description). It is the polyhedra space's kernel (packages/polyhedra/src/kernel.ts) with a ball for the
 * container. Its rho and Rc are the solid's inradius (the least face offset) and circumradius (the largest vertex
 * distance), both about the vertex centroid, which is the centre of the solid's largest inscribed ball and of its
 * smallest enclosing ball for all 94 (container.ts); so the soft shapes below lie inside the solid, and the ball of
 * radius t Rc + (1 - t) rho about the centre holds the soft piece, also for the long and the thin prisms.
 *
 * State. Piece i owns x[6i .. 6i + 5]: its centre (3 lengths), then its chart rotation r, a rotation vector times
 * the piece's circumradius Rc so that it reads as a length: the piece is turned by exp([r / Rc]x) A_i, the anchor
 * A_i a unit quaternion kept in aux (r turns the anchored piece about its centre, in the world frame). A change d of
 * r moves no vertex by more than |d|, to first order. rebase folds r into A_i. size is s, the ball's radius.
 * Centres are absolute (the ball is centred at the origin), so setSize scales them by the ratio of the sizes.
 *
 * Energy. At shape parameter t a piece is t P (+) B((1 - t) rho), the solid P scaled by t about its centre and
 * dilated by (1 - t) rho, rho its inradius: the solid at t = 1, its inscribed ball at t = 0, and inside the solid
 * for every t, since P's support about its centre is at least rho in every direction [EST, elementary]. For a pair,
 * with sd the signed distance of the cores t P_i and t P_j (minus their penetration depth by the separating-axis
 * test when they overlap, their Euclidean distance when they do not; the polyhedra simulator's sdCores), the
 * overlap is
 *   o = 2 (1 - t) rho - sd,
 * the exact penetration depth of the soft pieces, whose Minkowski difference is the cores' one dilated by
 * 2 (1 - t) rho. The protrusion from the ball of radius s is
 *   max_v |X_v| + (1 - t) rho - s
 * over the core's world vertices X_v: the farthest point of a convex body from the origin is a vertex, and the
 * dilation adds (1 - t) rho along the ray to it [EST, elementary]. Then
 *   E = sum_pairs (w_i + w_j) / 2 o_+^2 + sum_pieces w_i (protrusion)_+^2,
 * with analytic gradients: sdCores' for the pairs; for the wall the unit vector n = X_v / |X_v| of the farthest
 * vertex, which a turn dw about the centre moves by dw x (X_v - c), so d|X_v| / dw = (X_v - c) x n. Both are in
 * world-frame rotations, which the left Jacobian of exp maps to r (packages/polyhedra kernel-rotation.ts). At
 * t = 1 the model is the validator's (vertex distances and the separating-axis test, validate.ts) up to rounding: the
 * kernel places the vertices from its own rotation (the chart's exponential times the anchor) and takes the depth
 * from the simulator's separating-axis test, which agree with the validator's to about 1e-15, as in the polyhedra
 * kernel. So a configuration valid at tolerance 0 has an energy of about 1e-30 at most, and zero with a clearance
 * above that rounding (the finish keeps 1e-10).
 *
 * Growing a state keeps its zero energy: scaling the centres by f > 1 adds (f - 1) n . (c_j - c_i) > 0 to a
 * separated pair's gap along its separating normal n, and a vertex at c + v with |c + v| <= s moves to
 * f c + v = (c + v) + (f - 1) c, at most s + (f - 1) |c| <= f s from the origin, since the centre lies in the
 * piece and so in the ball [EST, elementary].
 */
import type { KernelCapability, KernelState, Rng, SpaceKernel } from "@polypack/methods";
import {
  SD_GRADIENT as GR,
  type Pose,
  type SimPose,
  chartGradient,
  expQuat,
  getSolid,
  logQuat,
  mulQuat,
  prepShape,
  randomQuat,
  sdCores,
  simPose,
  unitQuat,
} from "@polypack/polyhedra";
import { latticeCut } from "./ball-pieces";
import { BALL_RADIUS, type BallsProblem, ballContainerRadius, ballContainerRadiusSlope, ballContainerScore, ballsProblemOf } from "./catalogue";
import { ballsServerRule, finishBallsConfig } from "./kernel-rule";
import { BALLS_CLEARANCE } from "./search";
import { cubeLatticeCut, legalizeSolids, solidsAt } from "./solid-pieces";
import { type BallsConfig, ballsConfigErrors } from "./validate";

/** The kernel's own data in a state's aux. */
interface SolidsAux {
  /** Each piece's anchor rotation, a unit quaternion (w, x, y, z): 4 numbers per piece. */
  a: Float64Array;
  /** The shape parameter t in [0, 1] (1: the true solids). */
  t: number;
}

/** Volume fraction of a random start: the pieces fill about this much of the ball. */
const START_FILL = 0.15;

export function solidPiecesKernel(pb: BallsProblem, P: number, common: { id: string; bound: number }): SpaceKernel {
  const piece = getSolid(pb.piece);
  // the piece in the units of the canonical solid (edge 1)
  const shape = prepShape(piece, 1);
  // Gauss-map pruning of the edge-edge axes when it is the faster of the two (the polyhedra kernel's rule; the
  // depth is the same either way): [CALC] there, per overlapping pair the full set costs about 0.012 us x nd^2 nv and
  // the pruned one about 0.03 us x ne^2. For the Platonic solids it prunes tetrahedra, dodecahedra and icosahedra.
  shape.prune = shape.edirs.length ** 2 * shape.nv > 2 * shape.edges.length ** 2;
  // [CALC] Costs in energy() calls, from the medians of three squeezed random starts for the five solids at P = 2,
  // 3, 5, 10, 20, 40 and 80 (processor time, Node 26 on Apple Silicon, 2026-10-26; docs/spaces/BALLS.md, "Kernel
  // for the generic methods"). A finish takes about 1 ms of processor time per piece (0.2 to 3) whatever the solid,
  // the energy per piece grows with the separating-axis test of one overlapping pair (satUs, modelled as the polyhedra
  // kernel does): 0.003 ms per cube, 0.004 per tetrahedron or octahedron, 0.008 to 0.011 per dodecahedron or
  // icosahedron. Fitted: 250 / (1 + satUs / 35), that is 233 to 244 energies for tetrahedra, cubes and octahedra and
  // 141 for dodecahedra and icosahedra, which the measured finishes were 0.41 to 2.9 times in 80 % of the 105 runs
  // (median 0.95; 0.21 to 5.2 in all, and the three starts of one case up to 10 times apart). A validate (two
  // checks, at the touching and the strict tolerance) cost 1.7 to 8.2 energies (median 3.2). [CALC] For the other 89
  // solids the same fit, checked with the same bench on 11 of them at P = 5, 10 and 30 (tetrahedra, dodecahedra,
  // truncated tetrahedra, truncated icosidodecahedra, pentagonal hexecontahedra, prisms of height 3, 12-gonal prisms of
  // height 3, 12-gonal trapezohedra, 12-gonal bipyramids, triakis icosahedra, disdyakis triacontahedra, 12-gonal
  // antiprisms): the measured finishes were 0.5 to 3.6 times the fit where it gives 31 or more, and up to 9 times
  // (at P = 5) where the many edges drive it below that, truncated icosidodecahedra (fit 24, measured 48 to 214),
  // pentagonal hexecontahedra (12; 20 to 62) and disdyakis triacontahedra (10; 26 to 39). So it has a floor of 30.
  const satUs = shape.prune ? 0.03 * shape.edges.length ** 2 : 0.012 * shape.edirs.length ** 2 * shape.nv;
  const finishCost = Math.max(30, Math.round(250 / (1 + satUs / 35)));
  const validateCost = 3;
  const rho = piece.inradius;
  const Rc = piece.circumradius;
  const dim = 6;
  const Q = new Float64Array(4);
  // the lattice cuts of unit balls that the search's new starts scale to the circumradius
  const unitBalls = ballsProblemOf("ballinball")!;

  const auxOf = (s: KernelState) => s.aux as SolidsAux;

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
    return simPose(shape, [x[o], x[o + 1], x[o + 2]], [Q[0], Q[1], Q[2], Q[3]], k);
  };

  /**
   * True when the line between the centres already separates the cores A and B by at least `gap`: then their
   * distance is at least that too and the soft pieces do not overlap. A cheap first test before sdCores.
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

  /** A centre uniformly at random in the ball of radius R about the origin, into x[o .. o + 2]. */
  const centreIn = (R: number, rng: Rng, x: Float64Array, o: number) => {
    const r = R * Math.cbrt(rng());
    const u = 2 * rng() - 1;
    const phi = 2 * Math.PI * rng();
    const q = Math.sqrt(1 - u * u);
    x[o] = r * q * Math.cos(phi);
    x[o + 1] = r * q * Math.sin(phi);
    x[o + 2] = r * u;
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
   * its wall). With `grad`, its gradient in x and, last, in the size.
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
      const o = dim * i;
      const cx = x[o];
      const cy = x[o + 1];
      const cz = x[o + 2];
      // no vertex of the core is farther than t Rc from the centre
      if (Math.hypot(cx, cy, cz) + t * Rc + r <= ballContainerRadius(s.size)) return;
      const X = core(i).X;
      let m2 = -1;
      let im = 0;
      for (let v = 0; v < X.length; v += 3) {
        const d2 = X[v] * X[v] + X[v + 1] * X[v + 1] + X[v + 2] * X[v + 2];
        if (d2 > m2) {
          m2 = d2;
          im = v;
        }
      }
      const m = Math.sqrt(m2);
      const viol = m + r - ballContainerRadius(s.size);
      if (!(viol > 0)) return;
      const wi = w ? w[i] : 1;
      e += wi * viol * viol;
      if (GC && GT) {
        const c2 = 2 * wi * viol;
        if (m > 0) {
          const nx = X[im] / m;
          const ny = X[im + 1] / m;
          const nz = X[im + 2] / m;
          GC[3 * i] += c2 * nx;
          GC[3 * i + 1] += c2 * ny;
          GC[3 * i + 2] += c2 * nz;
          // turning by dw moves the farthest vertex by dw x lever, so d|X| / dw = lever x n
          const lx = X[im] - cx;
          const ly = X[im + 1] - cy;
          const lz = X[im + 2] - cz;
          GT[3 * i] += c2 * (ly * nz - lz * ny);
          GT[3 * i + 1] += c2 * (lz * nx - lx * nz);
          GT[3 * i + 2] += c2 * (lx * ny - ly * nx);
        }
        gs -= c2 * ballContainerRadiusSlope();
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
        chartGradient(
          x[o + 3] / Rc,
          x[o + 4] / Rc,
          x[o + 5] / Rc,
          GT[3 * i],
          GT[3 * i + 1],
          GT[3 * i + 2],
          1 / Rc,
          grad,
          o + 3,
        );
      }
      grad[P * dim] = gs;
    }
    return e;
  };

  const toConfig = (s: KernelState): BallsConfig => {
    const { a } = auxOf(s);
    const x = s.x;
    const pieces: number[][] = [];
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
    aux: { a, t: 1 } satisfies SolidsAux,
  });

  /** The state of poses (any quaternions of the server's range) at size s: centres, and anchors at the poses' turns. */
  const stateOf = (pieces: readonly ArrayLike<number>[], s: number): KernelState => {
    const x = new Float64Array(dim * P);
    const a = new Float64Array(4 * P);
    for (let i = 0; i < P; i++) {
      const p = pieces[i];
      x[dim * i] = p[0];
      x[dim * i + 1] = p[1];
      x[dim * i + 2] = p[2];
      unitQuat(p, 3, a, 4 * i);
    }
    return state(x, s, a);
  };

  const capabilities: KernelCapability[] = ["shape", "seeds", "swap"];

  return {
    space: "balls",
    id: common.id,
    P,
    dim,
    // a step of rho moves the centre by the inradius, or turns no vertex farther than that
    steps: new Float64Array(dim).fill(rho),
    inradius: rho,
    globals: 0,
    globalSteps: new Float64Array(0),
    bound: common.bound,
    finishCost,
    validateCost,
    capabilities,

    fromConfig(config) {
      // malformed, or outside the server's limits (s at most 1e6, centres at most 1e4, quaternion components at
      // most 1e100 and norms at least 1e-6): null, so that no method works on a state no submission could have
      if (ballsConfigErrors(pb, config, P).length) return null;
      const c = config as BallsConfig;
      return stateOf(c.pieces, c.s);
    },
    toConfig,
    clone(s) {
      const { a, t } = auxOf(s);
      return { x: Float64Array.from(s.x), size: s.size, aux: { a: Float64Array.from(a), t } satisfies SolidsAux };
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
      // roomy: the pieces fill START_FILL of the ball, and each lies in it whatever its orientation
      const radius = Math.max(Math.cbrt((P * piece.volume) / (START_FILL * ((4 * Math.PI) / 3))), Rc + rho);
      const size = ballContainerScore(radius);
      const x = new Float64Array(dim * P);
      const a = new Float64Array(4 * P);
      for (let i = 0; i < P; i++) {
        centreIn(radius - Rc, rng, x, dim * i);
        randomQuat(rng, a, 4 * i);
      }
      return state(x, size, a);
    },
    randomPose(s, i, rng) {
      // A centre whose inscribed ball lies in the container, and a uniformly random orientation. The orientation is
      // written as the chart's rotation D, uniformly random, so that the anchor stays and writing piece i's x back
      // undoes the move; D A_i is uniformly random for any anchor A_i (the uniform measure is invariant).
      const o = dim * i;
      centreIn(Math.max(0, ballContainerRadius(s.size) - rho), rng, s.x, o);
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
      const lim = ballContainerRadius(s.size) + tol;
      if (Math.hypot(x[o], x[o + 1], x[o + 2]) + t * Rc + r > lim) {
        Ci = placeCore(x, a, i, t);
        const X = Ci.X;
        for (let v = 0; v < X.length; v += 3) if (Math.hypot(X[v], X[v + 1], X[v + 2]) + r > lim) return false;
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
    // the true solids, whatever the state's shape
    finish: (s, shouldStop) => finishBallsConfig(pb, P, toConfig(s), shouldStop),
    validate: (config) => ballsServerRule(pb, P, common.bound, config),
    setShape(s, t) {
      auxOf(s).t = Math.min(1, Math.max(0, t));
    },
    seeds(rng, count) {
      // The search's new starts (search.ts): balls of the circumradius placed as a cut of a lattice packing of unit
      // balls (face-centred cubic, then hexagonal close-packed), turned at random, each solid turned at random,
      // valid as placed since their circumscribed balls are disjoint; for cubes first a cut of the cubic lattice.
      // Each is legalized, so it is a packing already, at the size it needs.
      const kinds = pb.piece === "cube" ? (["cubes", "fcc", "hcp"] as const) : (["fcc", "hcp"] as const);
      const out: KernelState[] = [];
      for (let n = 0; n < count; n++) {
        const kind = kinds[n % kinds.length];
        let poses: Pose[];
        if (kind === "cubes") poses = cubeLatticeCut(P, rng);
        else {
          const R = (Rc / BALL_RADIUS) * (1 + 1e-9);
          const centres = latticeCut(unitBalls, P, rng, kind, true).map((c) => [c[0] * R, c[1] * R, c[2] * R]);
          poses = solidsAt(centres, rng);
        }
        const c = legalizeSolids(pb, poses, BALLS_CLEARANCE, BALLS_CLEARANCE, () => {});
        out.push(stateOf(c.pieces, c.s));
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
