/**
 * The nD in nD space's kernel for the generic search methods (packages/methods/src/kernel.ts,
 * docs/methods/dimensions/README.md; docs/spaces/NDIM.md §11): P equal polytopes of the dimension's catalogue, or balls of
 * diameter 1, in the container scaled by s (a polytope, or the ball of diameter s), centred at the origin.
 *
 * State. A polytope piece i owns dim = d + d(d - 1)/2 numbers x[dim i ...]: its centre t (d lengths, absolute: the
 * container is centred at the origin) and a chart rotation, the Cayley parameters k of a skew matrix S times the piece's
 * circumradius Rc so that they read as lengths (x = k Rc). The piece is turned by R = R0 C(S), C(S) = (I - S)^-1 (I + S),
 * R0 its anchor, a rotation matrix kept in aux; a step of x moves no vertex by much more than its size, to first order.
 * rebase folds C(S) into R0 (and re-orthonormalises it). A ball owns its centre only (dim = d). size is s, the score;
 * setSize scales the centres with the container and keeps the pieces' size.
 *
 * Energy. For a pair, the overlap 2 r - sd, where sd is the signed separation of the two pieces' cores (the polytope scaled
 * by the shape parameter tau about its centre; minus the penetration depth when they overlap: GJK and EPA of packages/ndim)
 * and r = (1 - tau) rho the dilation, rho the inradius, so that tau = 1 is the true piece and tau = 0 its inscribed ball. For
 * a wall, the largest protrusion of the core plus r beyond a facet of the container (N_f . x + r - s b_f), or beyond the
 * ball (|x| + r - s/2). Balls are their own inscribed balls. E is the weighted sum of the squares of the positive overlaps,
 * with the exact gradient: the envelope theorem at the separating direction u (the support vertices of the two pieces
 * carry the gradient) and, for a vertex x = t + tau R0 C(S) v, d(u . x)/dk_ij = 2 (a_i b_j - a_j b_i) with
 * a = (R0 (I - S)^-1)^T u and b = tau (I - S)^-1 v (dC = 2 (I - S)^-1 dS (I - S)^-1). The model is exact at tau = 1 up to
 * EPA's depth, which never exceeds the true depth, so a configuration valid at tolerance 0 has (almost) no energy.
 *
 * finish() is the legalisation by scaling: the centres and the container scale together by a factor f >= 1 raise every
 * pair gap (by at least 2 rho (f - 1)) and every wall gap (by at least rho (f - 1)), so the valid factors form a ray
 * [f*, inf) of the validator; finish() brackets and bisects it with the validator at tolerance 0 and returns the smallest
 * valid factor to 1e-12. validate() is the server's rule: the form, the lower bound with the server's slack, the check at
 * the touching tolerance 1e-9 with the work cap. seeds() are lattice cuts (Z^d, D_d, E8) with the spacing at which the
 * pieces just do not overlap.
 */
import type { Finished, KernelCapability, KernelState, Rng, SpaceKernel, Validation } from "@polypack/methods";
import {
  type Polytope,
  closestPoints,
  gapAlong,
  getPolytope,
  isLoaded,
  readPose,
  signedSeparation,
} from "@polypack/ndim";
import { ND_BALL, formatNdId, ndInRange, ndCode, ndShapes, type NdProblemId } from "./catalogue";
import { ndBoundEntry, ndBallVolume } from "./bounds";
import { contactPoints } from "./contact";
import { inverse, mul, orthonormalise } from "./linalg";
import { robustPose } from "./pose";
import { latticePoints, type LatticeName } from "./lattice";
import { NDIM_MAX_REASONS, ndCheck, ndProblemOf, parseNdConfig, type NdConfigShape } from "./validate";

/** The server's slack below the lower bound (SPACE_BOUND_SLACK of packages/spaces). */
const BOUND_SLACK = 1e-9;
/** Touching tolerance of the server's check. */
const NDIM_KERNEL_TOL = 1e-9;
/** Volume fraction of a random start. */
const START_FILL = 0.15;
const BALL_R = 0.5;
/** Shape parameters below this are taken as the inscribed ball. */
const POINT_T = 1e-6;

interface Aux {
  /** Anchor rotations, P x d x d, row-major. */
  R0: Float64Array;
  /** The shape parameter in [0, 1]. */
  t: number;
}

/** A Haar-random rotation (Gaussian columns, Gram-Schmidt, determinant fixed to +1), row-major. */
function randomRotation(n: number, rng: Rng, out: Float64Array): void {
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
  for (let i = 0; i < n * n; i++) out[i] = gauss();
  orthonormalise(out, n);
  // determinant by elimination
  const M = Float64Array.from(out);
  let det = 1;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r * n + c]) > Math.abs(M[p * n + c])) p = r;
    if (p !== c) {
      for (let j = 0; j < n; j++) [M[c * n + j], M[p * n + j]] = [M[p * n + j], M[c * n + j]];
      det = -det;
    }
    det *= M[c * n + c];
    for (let r = c + 1; r < n; r++) {
      const f = M[r * n + c] / M[c * n + c];
      for (let j = c; j < n; j++) M[r * n + j] -= f * M[c * n + j];
    }
  }
  if (det < 0) for (let i = 0; i < n; i++) out[i * n] = -out[i * n];
}

/** A piece placed in the world, for one energy call. */
interface Placed {
  t: Float64Array;
  /** R0 (I - S)^-1, for the gradient. */
  RM: Float64Array;
  Minv: Float64Array;
  /** Core vertices in the world (nV x d). */
  X: Float64Array;
}

export function ndKernel(problem: NdProblemId): SpaceKernel {
  const { d, P } = problem;
  const shapes = ndShapes(d);
  if (!shapes.includes(problem.piece) || !shapes.includes(problem.container)) throw new Error("unknown shape");
  if (!ndInRange(d, P)) throw new RangeError(`P must be in the range of ${d}D, the P the server accepts`);
  const ballPiece = problem.piece === ND_BALL;
  const ballContainer = problem.container === ND_BALL;
  for (const shape of [problem.piece, problem.container])
    if (shape !== ND_BALL && !isLoaded(ndCode(d, shape)))
      throw new Error(`${ndCode(d, shape)} is loaded on demand: await loadPolytope first`);
  const piece: Polytope | null = ballPiece ? null : getPolytope(ndCode(d, problem.piece));
  const cont: Polytope | null = ballContainer ? null : getPolytope(ndCode(d, problem.container));
  const m = (d * (d - 1)) / 2;
  const dim = ballPiece ? d : d + m;
  const rho = piece ? piece.inradius : BALL_R;
  const Rc = piece ? piece.circumradius : BALL_R;
  const nV = piece ? piece.nV : 1;
  const rhoC = cont ? cont.inradius : 0.5;
  const volP = piece ? piece.volume : ndBallVolume(d, BALL_R);
  const volC = cont ? cont.volume : ndBallVolume(d, 0.5);
  const id = formatNdId(d, problem.piece, problem.container, P);
  const bound = ndBoundEntry(problem, P).value;
  const ndProblem = ndProblemOf(problem);

  // Costs in energy() calls (measured by test/kernel.test.ts's bench and stated in docs/spaces/NDIM.md §11): an energy
  // costs about the pairs' GJK tests; a finish is a bracketing and a bisection of 30 to 60 validations of the whole packing.
  const finishCost = Math.max(20, Math.round(60 + 0.5 * P));
  const validateCost = 3;

  const aux = (s: KernelState) => s.aux as Aux;

  // ---------------------------------------------------------------- rotation
  const S = new Float64Array(d * d);
  const A = new Float64Array(d * d);
  /** C(S) = 2 (I - S)^-1 - I for the chart parameters of piece i (x entries d.. in length units); fills Minv too. */
  const chart = (x: Float64Array, i: number, Minv: Float64Array, C: Float64Array | null): boolean => {
    const o = dim * i + d;
    let k = 0;
    A.fill(0);
    for (let a = 0; a < d; a++) A[a * d + a] = 1;
    for (let a = 0; a < d; a++)
      for (let b = a + 1; b < d; b++) {
        const v = x[o + k++] / Rc;
        A[a * d + b] = -v; // I - S
        A[b * d + a] = v;
      }
    const inv = inverse(A, d);
    if (!inv) return false;
    Minv.set(inv);
    if (C) {
      for (let a = 0; a < d * d; a++) C[a] = 2 * inv[a];
      for (let a = 0; a < d; a++) C[a * d + a] -= 1;
    }
    return true;
  };

  /** The rotation of piece i: R0 C(S) (row-major d x d), or null when the chart is singular. */
  const rotationOf = (s: KernelState, i: number): Float64Array | null => {
    if (ballPiece) return null;
    const Minv = new Float64Array(d * d);
    const C = new Float64Array(d * d);
    if (!chart(s.x, i, Minv, C)) return null;
    return mul(aux(s).R0.subarray(i * d * d, (i + 1) * d * d), C, d);
  };

  // ---------------------------------------------------------------- configurations
  const poseOf = (s: KernelState, i: number): number[] | null => {
    const t = Array.from(s.x.subarray(dim * i, dim * i + d));
    if (ballPiece) return t;
    const R = rotationOf(s, i);
    if (!R) return null;
    return robustPose(t, R, d);
  };

  const toConfig = (s: KernelState): NdConfigShape => {
    const pieces: number[][] = [];
    for (let i = 0; i < P; i++) pieces.push(poseOf(s, i) ?? Array.from(s.x.subarray(dim * i, dim * i + d)));
    return { s: s.size, pieces };
  };

  const blank = (size: number): KernelState => ({
    x: new Float64Array(dim * P),
    size,
    aux: { R0: new Float64Array(P * d * d), t: 1 } satisfies Aux,
  });
  const setIdentity = (R0: Float64Array, i: number) => {
    R0.fill(0, i * d * d, (i + 1) * d * d);
    for (let a = 0; a < d; a++) R0[i * d * d + a * d + a] = 1;
  };

  const finite = (s: KernelState): boolean => {
    if (!Number.isFinite(s.size)) return false;
    for (let k = 0; k < s.x.length; k++) if (!Number.isFinite(s.x[k])) return false;
    return true;
  };

  // ---------------------------------------------------------------- energy
  /** Adds c * grad(u . x_v) of vertex v of piece i (core scale tau) to G, in x units. */
  const vertexGrad = (
    G: Float64Array,
    i: number,
    pl: Placed,
    v: number,
    tau: number,
    u: ArrayLike<number>,
    c: number,
  ) => {
    const o = dim * i;
    for (let a = 0; a < d; a++) G[o + a] += c * u[a];
    if (ballPiece) return;
    const a = new Float64Array(d);
    const b = new Float64Array(d);
    for (let j = 0; j < d; j++) {
      let sa = 0;
      let sb = 0;
      for (let l = 0; l < d; l++) {
        sa += pl.RM[l * d + j] * u[l];
        sb += pl.Minv[j * d + l] * piece!.V[v * d + l];
      }
      a[j] = sa;
      b[j] = tau * sb;
    }
    let k = 0;
    const f = (2 * c) / Rc;
    for (let p = 0; p < d; p++)
      for (let q = p + 1; q < d; q++) {
        G[o + d + k] += f * (a[p] * b[q] - a[q] * b[p]);
        k++;
      }
  };

  /**
   * The energy's terms: all, or with only >= 0 those of piece `only` (its pairs and walls). With `grad`, the gradient in
   * x and, last, in the size. `worst`, when given, receives the largest overlap (a length) of the terms evaluated.
   */
  const terms = (
    s: KernelState,
    grad: Float64Array | undefined,
    w: Float64Array | undefined,
    only: number,
    worst?: { v: number; stop?: number },
  ): number => {
    if (!finite(s)) {
      grad?.fill(0);
      if (worst) worst.v = Infinity;
      return Infinity;
    }
    const x = s.x;
    const tau = ballPiece ? 1 : aux(s).t;
    const r = ballPiece ? BALL_R : (1 - tau) * rho;
    // a piece that is a point plus a ball: balls, and polytopes whose core has shrunk to a point
    const pointLike = ballPiece || tau < POINT_T;
    const reach = ballPiece ? 2 * BALL_R : 2 * (tau * Rc + r);
    const placed: (Placed | null)[] = new Array(P).fill(null);
    const place = (i: number): Placed => {
      const hit = placed[i];
      if (hit) return hit;
      const Minv = new Float64Array(d * d);
      const C = new Float64Array(d * d);
      if (!chart(x, i, Minv, C)) throw new RangeError("singular chart");
      const R0 = aux(s).R0.subarray(i * d * d, (i + 1) * d * d);
      const R = mul(R0, C, d);
      const RM = mul(R0, Minv, d);
      const t = x.subarray(dim * i, dim * i + d);
      const X = new Float64Array(nV * d);
      for (let v = 0; v < nV; v++)
        for (let a = 0; a < d; a++) {
          let acc = 0;
          for (let l = 0; l < d; l++) acc += R[a * d + l] * piece!.V[v * d + l];
          X[v * d + a] = t[a] + tau * acc;
        }
      return (placed[i] = { t, RM, Minv, X });
    };
    let e = 0;
    let gs = 0;
    const G = grad ? new Float64Array(P * dim) : null;
    const u = new Float64Array(d);
    const record = (o: number) => {
      if (worst && o > worst.v) worst.v = o;
    };
    /** True once `worst` has passed its stop level (a feasibility test that needs no more terms). */
    const done = () => worst !== undefined && worst.stop !== undefined && worst.v > worst.stop;

    const wall = (i: number) => {
      if (done()) return;
      const wi = w ? w[i] : 1;
      const t = x.subarray(dim * i, dim * i + d);
      if (cont === null) {
        // ball container of radius s/2
        const lim = s.size / 2;
        let tn = 0;
        for (let a = 0; a < d; a++) tn += t[a] * t[a];
        tn = Math.sqrt(tn);
        if (pointLike) {
          const viol = tn + r - lim;
          if (!(viol > 0)) return;
          record(viol);
          e += wi * viol * viol;
          if (G) {
            const c2 = 2 * wi * viol;
            for (let a = 0; a < d; a++) G[dim * i + a] += tn > 0 ? (c2 * t[a]) / tn : 0;
            gs -= c2 * 0.5;
          }
          return;
        }
        if (tn + tau * Rc + r <= lim) return;
        const pl = place(i);
        let far = -1;
        let fv = 0;
        for (let v = 0; v < nV; v++) {
          let q = 0;
          for (let a = 0; a < d; a++) q += pl.X[v * d + a] ** 2;
          if (q > fv) {
            fv = q;
            far = v;
          }
        }
        const nrm = Math.sqrt(fv);
        const viol = nrm + r - lim;
        if (!(viol > 0)) return;
        record(viol);
        e += wi * viol * viol;
        if (G) {
          const c2 = 2 * wi * viol;
          for (let a = 0; a < d; a++) u[a] = pl.X[far * d + a] / nrm;
          vertexGrad(G, i, pl, far, tau, u, c2);
          gs -= c2 * 0.5;
        }
        return;
      }
      for (let f = 0; f < cont.nF; f++) {
        const Nf = cont.N.subarray(f * d, f * d + d);
        const lim = s.size * cont.b[f];
        let nt = 0;
        for (let a = 0; a < d; a++) nt += Nf[a] * t[a];
        if (pointLike) {
          const viol = nt + r - lim;
          if (!(viol > 0)) continue;
          record(viol);
          e += wi * viol * viol;
          if (G) {
            const c2 = 2 * wi * viol;
            for (let a = 0; a < d; a++) G[dim * i + a] += c2 * Nf[a];
            gs -= c2 * cont.b[f];
          }
          continue;
        }
        if (nt + tau * Rc + r <= lim) continue;
        const pl = place(i);
        let top = -Infinity;
        let at = 0;
        for (let v = 0; v < nV; v++) {
          let q = 0;
          for (let a = 0; a < d; a++) q += Nf[a] * pl.X[v * d + a];
          if (q > top) {
            top = q;
            at = v;
          }
        }
        const viol = top + r - lim;
        if (!(viol > 0)) continue;
        record(viol);
        e += wi * viol * viol;
        if (G) {
          const c2 = 2 * wi * viol;
          vertexGrad(G, i, pl, at, tau, Nf, c2);
          gs -= c2 * cont.b[f];
        }
      }
    };

    // a pair is always taken as (lower index, higher index), so energy() and pieceEnergy() compute it alike
    const pair = (p: number, q: number) => {
      if (done()) return;
      const tp = x.subarray(dim * p, dim * p + d);
      const tq = x.subarray(dim * q, dim * q + d);
      let d2 = 0;
      for (let a = 0; a < d; a++) d2 += (tq[a] - tp[a]) ** 2;
      if (d2 >= reach * reach) return;
      const dist = Math.sqrt(d2);
      const wpq = w ? (w[p] + w[q]) / 2 : 1;
      if (pointLike) {
        const o = 2 * r - dist;
        if (!(o > 0)) return;
        record(o);
        e += wpq * o * o;
        if (G) {
          const c2 = 2 * wpq * o;
          for (let a = 0; a < d; a++) {
            // o = 2 r - |t_q - t_p|: d o / d t_p = +du, d o / d t_q = -du for du the unit vector from p to q
            const du = dist > 0 ? (tq[a] - tp[a]) / dist : a === 0 ? 1 : 0;
            G[dim * p + a] += c2 * du;
            G[dim * q + a] -= c2 * du;
          }
        }
        return;
      }
      const P1 = place(p);
      const Q1 = place(q);
      if (dist > 0) {
        for (let a = 0; a < d; a++) u[a] = (tq[a] - tp[a]) / dist;
        // any direction bounds the separation from below: a gap of 2 r along the line of centres means no overlap
        if (gapAlong(P1.X, nV, Q1.X, nV, d, u) >= 2 * r) return;
      }
      const sep = signedSeparation(P1.X, nV, Q1.X, nV, d);
      const o = 2 * r - sep.sep;
      if (!(o > 0)) return;
      record(o);
      e += wpq * o * o;
      if (G) {
        const dir = sep.dir;
        if (!dir) return;
        // the derivative of the separation along its optimal direction is taken at the contact points (contact.ts)
        const ct = contactPoints(P1.X, Q1.X, nV, d, dir);
        const c2 = 2 * wpq * o;
        for (let k = 0; k < ct.ia.length; k++) {
          vertexGrad(G, p, P1, ct.ia[k], tau, dir, c2 * ct.wa[k]);
          vertexGrad(G, q, Q1, ct.ib[k], tau, dir, -c2 * ct.wb[k]);
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
    if (grad && G) {
      grad.fill(0);
      grad.set(G);
      grad[P * dim] = gs;
    }
    return e;
  };

  // ---------------------------------------------------------------- random poses
  // Bounding box of the container (for rejection sampling of centres) and whether it is worth using.
  const boxHalf = (() => {
    if (!cont) return 0;
    let mx = 0;
    for (let k = 0; k < cont.V.length; k++) mx = Math.max(mx, Math.abs(cont.V[k]));
    return mx;
  })();
  const boxAccept = cont ? volC / (2 * boxHalf) ** d : 1;

  /** A centre at random in the container of scale `scale` (a ball: radius scale/2), written to x[o ..]. */
  const centreIn = (scale: number, rng: Rng, x: Float64Array, o: number) => {
    if (!(scale > 0)) {
      for (let a = 0; a < d; a++) x[o + a] = 0;
      return;
    }
    if (cont === null) {
      // uniform in the ball: a Gaussian direction and radius (scale/2) U^(1/d)
      const g = new Float64Array(d);
      let l = 0;
      for (let a = 0; a < d; a++) {
        g[a] = Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
        l += g[a] * g[a];
      }
      l = Math.sqrt(l);
      const rad = (scale / 2) * Math.pow(rng(), 1 / d);
      for (let a = 0; a < d; a++) x[o + a] = (g[a] / l) * rad;
      return;
    }
    if (boxAccept >= 0.02) {
      const p = new Float64Array(d);
      for (let tries = 0; tries < 2000; tries++) {
        for (let a = 0; a < d; a++) p[a] = scale * boxHalf * (2 * rng() - 1);
        let inside = true;
        for (let f = 0; f < cont.nF && inside; f++) {
          let q = 0;
          for (let a = 0; a < d; a++) q += cont.N[f * d + a] * p[a];
          inside = q <= scale * cont.b[f];
        }
        if (inside) {
          for (let a = 0; a < d; a++) x[o + a] = p[a];
          return;
        }
      }
    }
    // radial: a random direction, a radius up to the container's boundary along it (not uniform, but inside)
    const g = new Float64Array(d);
    let l = 0;
    for (let a = 0; a < d; a++) {
      g[a] = Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
      l += g[a] * g[a];
    }
    l = Math.sqrt(l);
    let reachR = Infinity;
    for (let f = 0; f < cont.nF; f++) {
      let q = 0;
      for (let a = 0; a < d; a++) q += (cont.N[f * d + a] * g[a]) / l;
      if (q > 1e-12) reachR = Math.min(reachR, (scale * cont.b[f]) / q);
    }
    const rad = reachR * Math.pow(rng(), 1 / d);
    for (let a = 0; a < d; a++) x[o + a] = (g[a] / l) * rad;
  };

  /** The chart parameters (length units) of the rotation Q relative to an anchor: S = (Q - I)(Q + I)^-1, or false when Q is near a half turn. */
  const chartOf = (Q: Float64Array, x: Float64Array, o: number): boolean => {
    const num = Float64Array.from(Q);
    const den = Float64Array.from(Q);
    for (let a = 0; a < d; a++) {
      num[a * d + a] -= 1;
      den[a * d + a] += 1;
    }
    const inv = inverse(den, d);
    if (!inv) return false;
    const Sm = mul(num, inv, d);
    let k = 0;
    for (let a = 0; a < d; a++)
      for (let b = a + 1; b < d; b++) {
        const v = 0.5 * (Sm[a * d + b] - Sm[b * d + a]);
        if (!(Math.abs(v) < 1e3)) return false;
        x[o + k++] = v * Rc;
      }
    return true;
  };

  const shrunk = (size: number) => Math.max(0, size - Rc / rhoC);

  // ---------------------------------------------------------------- legalisation (finish)
  const scaledConfig = (cfg: NdConfigShape, f: number): NdConfigShape => ({
    s: cfg.s * f,
    pieces: cfg.pieces.map((p) => {
      const q = p.slice();
      for (let a = 0; a < d; a++) q[a] = p[a] * f;
      return q;
    }),
  });

  const validAt = (cfg: NdConfigShape, f: number): boolean => {
    const c = scaledConfig(cfg, f);
    if (!(c.s <= 1e6)) return false;
    return ndCheck(problem, c, 0, 1).length === 0;
  };

  /** The smallest factor f >= 1 (to 1e-12) at which scaling the centres and the container makes cfg valid at tolerance 0, or null. */
  const legalFactor = (cfg: NdConfigShape, stop?: () => boolean): number | null => {
    const c0 = ndCheckMeasure(cfg);
    if (c0 === null) return null;
    let hi = 1 + (2 * Math.max(0, c0)) / rho + 1e-12;
    if (!validAt(cfg, hi)) {
      let step = hi - 1;
      let ok = false;
      for (let k = 0; k < 60 && !ok; k++) {
        if (stop?.()) return null;
        step *= 2;
        hi = 1 + step;
        ok = validAt(cfg, hi);
      }
      if (!ok) return null;
    }
    let lo = 1;
    if (validAt(cfg, 1)) {
      // already valid: the ray [f*, inf) may reach below 1, so shrink while it stays valid (the finish tightens as well)
      hi = 1;
      let step = 1e-3;
      for (let k = 0; k < 40; k++) {
        if (stop?.()) return hi;
        const f = Math.max(0.01, 1 - step);
        if (!validAt(cfg, f)) {
          lo = f;
          break;
        }
        hi = f;
        if (f <= 0.01) return hi;
        step *= 2;
      }
      if (lo === 1) return hi;
    }
    for (let k = 0; k < 80 && hi - lo > 1e-13 * hi; k++) {
      if (stop?.()) break;
      const mid = 0.5 * (lo + hi);
      if (validAt(cfg, mid)) hi = mid;
      else lo = mid;
    }
    return hi;
  };

  /** The largest violation (a length) of cfg: overlap or protrusion, from the validator's measures; null for a malformed one. */
  const ndCheckMeasure = (cfg: NdConfigShape): number | null => {
    const parsed = parseNdConfig(problem, cfg);
    if (!parsed.ok) return null;
    const st = fromParsed(parsed.config);
    const worst = { v: 0 };
    terms(st, undefined, undefined, -1, worst);
    return worst.v;
  };

  const fromParsed = (c: NdConfigShape): KernelState => {
    const st = blank(c.s);
    const R0 = aux(st).R0;
    for (let i = 0; i < P; i++) {
      const r = readPose(d, c.pieces[i], ballPiece);
      if (typeof r === "string") throw new RangeError(r);
      st.x.set(r.t, dim * i);
      if (r.R) R0.set(r.R, i * d * d);
    }
    return st;
  };

  // ---------------------------------------------------------------- seeds
  const seedState = (name: LatticeName, offset: number, rotate: boolean, rng: Rng): KernelState | null => {
    const centre = new Float64Array(d).fill(offset);
    const pts = latticePoints(name, d, centre, P, rng);
    if (!pts) return null;
    // centred at their mean
    const mean = new Float64Array(d);
    for (let i = 0; i < P; i++) for (let a = 0; a < d; a++) mean[a] += pts[i * d + a] / P;
    for (let i = 0; i < P; i++) for (let a = 0; a < d; a++) pts[i * d + a] -= mean[a];
    const st = blank(1);
    const R0 = aux(st).R0;
    const Q = new Float64Array(d * d);
    if (rotate && !ballPiece) randomRotation(d, rng, Q);
    for (let i = 0; i < P; i++) {
      if (rotate && !ballPiece) R0.set(Q, i * d * d);
      else if (!ballPiece) setIdentity(R0, i);
    }
    // the spacing a: the smallest at which the pieces in these poses do not overlap, by bisection. The pieces contain their
    // inscribed balls and lie in their circumscribed ones, so the centres' least distance dmin (in lattice units) puts a
    // between 2 rho / dmin and 2 Rc / dmin, where the upper end is valid.
    let dmin = Infinity;
    for (let i = 0; i < P; i++)
      for (let j = i + 1; j < P; j++) {
        let q = 0;
        for (let a = 0; a < d; a++) q += (pts[i * d + a] - pts[j * d + a]) ** 2;
        dmin = Math.min(dmin, Math.sqrt(q));
      }
    const place = (a: number) => {
      for (let i = 0; i < P; i++) for (let q = 0; q < d; q++) st.x[dim * i + q] = a * pts[i * d + q];
    };
    // the canonical piece in the (common) pose of the seed, about the origin; a piece is this plus its centre
    const RV = new Float64Array(nV * d);
    if (piece) {
      const R = Float64Array.from(R0.subarray(0, d * d));
      for (let v = 0; v < nV; v++)
        for (let a = 0; a < d; a++) {
          let acc = 0;
          for (let l = 0; l < d; l++) acc += R[a * d + l] * piece.V[v * d + l];
          RV[v * d + a] = acc;
        }
    }
    const XA = new Float64Array(nV * d);
    const XB = new Float64Array(nV * d);
    const u = new Float64Array(d);
    /** True when no two pieces overlap at spacing a: GJK on the near pairs (no EPA: only whether they overlap matters). */
    const pairsOk = (a: number): boolean => {
      for (let i = 0; i < P; i++)
        for (let j = i + 1; j < P; j++) {
          let d2 = 0;
          for (let q = 0; q < d; q++) d2 += (a * (pts[j * d + q] - pts[i * d + q])) ** 2;
          const dist = Math.sqrt(d2);
          if (dist >= 2 * Rc) continue;
          if (!piece) {
            if (dist < 1) return false;
            continue;
          }
          if (dist < 2 * rho) return false;
          for (let v = 0; v < nV; v++)
            for (let q = 0; q < d; q++) {
              XA[v * d + q] = RV[v * d + q] + a * pts[i * d + q];
              XB[v * d + q] = RV[v * d + q] + a * pts[j * d + q];
            }
          for (let q = 0; q < d; q++) u[q] = (a * (pts[j * d + q] - pts[i * d + q])) / dist;
          if (gapAlong(XA, nV, XB, nV, d, u) >= 0) continue;
          const cp = closestPoints(XA, nV, XB, nV, d);
          if (cp.w === null || !(cp.dist > 1e-12)) return false;
        }
      return true;
    };
    let lo = (2 * rho) / dmin;
    let hi = (2 * Rc) / dmin;
    if (!(hi > 0) || !Number.isFinite(hi)) return null;
    for (let k = 0; k < 60 && hi - lo > 1e-10 * hi; k++) {
      const mid = 0.5 * (lo + hi);
      if (pairsOk(mid)) hi = mid;
      else lo = mid;
    }
    place(hi * (1 + 1e-9));
    // the container that holds the arrangement: the largest wall ratio, at least the roomy start
    st.size = tight(st);
    return st;
  };

  /** The smallest container scale that holds every piece of s as placed (from the vertices and facets). */
  const tight = (s: KernelState): number => {
    let size = 0;
    for (let i = 0; i < P; i++) {
      const t = s.x.subarray(dim * i, dim * i + d);
      let X: Float64Array | null = null;
      if (!ballPiece) {
        const R = rotationOf(s, i);
        if (!R) continue;
        X = new Float64Array(nV * d);
        for (let v = 0; v < nV; v++)
          for (let a = 0; a < d; a++) {
            let acc = 0;
            for (let l = 0; l < d; l++) acc += R[a * d + l] * piece!.V[v * d + l];
            X[v * d + a] = t[a] + acc;
          }
      }
      if (cont === null) {
        if (!X) {
          let tn = 0;
          for (let a = 0; a < d; a++) tn += t[a] ** 2;
          size = Math.max(size, 2 * (Math.sqrt(tn) + BALL_R));
        } else
          for (let v = 0; v < nV; v++) {
            let q = 0;
            for (let a = 0; a < d; a++) q += X[v * d + a] ** 2;
            size = Math.max(size, 2 * Math.sqrt(q));
          }
        continue;
      }
      for (let f = 0; f < cont.nF; f++) {
        if (!X) {
          let q = 0;
          for (let a = 0; a < d; a++) q += cont.N[f * d + a] * t[a];
          size = Math.max(size, (q + BALL_R) / cont.b[f]);
        } else
          for (let v = 0; v < nV; v++) {
            let q = 0;
            for (let a = 0; a < d; a++) q += cont.N[f * d + a] * X[v * d + a];
            size = Math.max(size, q / cont.b[f]);
          }
      }
    }
    return size;
  };

  const SEEDS: readonly [LatticeName, number, boolean][] =
    d === 8
      ? [
          ["zd", 0.5, false],
          ["e8", 0, false],
          ["dd", 0, false],
          ["zd", 0, false],
        ]
      : [
          ["zd", 0.5, false],
          ["dd", 0, false],
          ["zd", 0, false],
          ["dd", 0.25, false],
        ];

  const capabilities: KernelCapability[] = ballPiece ? ["shape", "seeds"] : ["shape", "seeds", "swap"];

  const kernel: SpaceKernel = {
    space: "ndim",
    id,
    P,
    dim,
    steps: new Float64Array(dim).fill(rho),
    inradius: rho,
    globals: 0,
    globalSteps: new Float64Array(0),
    bound,
    finishCost,
    validateCost,
    capabilities,

    fromConfig(config) {
      const parsed = parseNdConfig(problem, config);
      if (!parsed.ok) return null;
      // the same limits as the server: s and centres in range, rotations that can be read (parseNdConfig reads every pose)
      try {
        return fromParsed(parsed.config);
      } catch {
        return null;
      }
    },
    toConfig,
    clone(s) {
      const a = aux(s);
      return { x: Float64Array.from(s.x), size: s.size, aux: { R0: Float64Array.from(a.R0), t: a.t } satisfies Aux };
    },
    rebase(s) {
      if (ballPiece) return;
      const R0 = aux(s).R0;
      for (let i = 0; i < P; i++) {
        const o = dim * i + d;
        let zero = true;
        for (let k = 0; k < m; k++) if (s.x[o + k] !== 0) zero = false;
        if (zero) continue;
        const R = rotationOf(s, i);
        if (!R) continue;
        orthonormalise(R, d);
        R0.set(R, i * d * d);
        s.x.fill(0, o, o + m);
      }
    },
    randomStart(rng) {
      const size = Math.max(Math.pow((P * volP) / (START_FILL * volC), 1 / d), (1.5 * Rc) / rhoC + 1e-3);
      const st = blank(size);
      const R0 = aux(st).R0;
      for (let i = 0; i < P; i++) {
        centreIn(shrunk(size), rng, st.x, dim * i);
        if (!ballPiece) randomRotation(d, rng, R0.subarray(i * d * d, (i + 1) * d * d));
      }
      return st;
    },
    randomPose(s, i, rng) {
      centreIn(shrunk(s.size), rng, s.x, dim * i);
      if (ballPiece) return;
      // a uniformly random orientation, written as the chart rotation C relative to the anchor: R0 C = Q, C = R0^T Q
      const Q = new Float64Array(d * d);
      const rel = new Float64Array(d * d);
      const R0 = aux(s).R0;
      for (let tries = 0; tries < 20; tries++) {
        randomRotation(d, rng, Q);
        for (let a = 0; a < d; a++)
          for (let b = 0; b < d; b++) {
            let acc = 0;
            for (let l = 0; l < d; l++) acc += R0[i * d * d + l * d + a] * Q[l * d + b];
            rel[a * d + b] = acc;
          }
        if (chartOf(rel, s.x, dim * i + d)) return;
      }
      s.x.fill(0, dim * i + d, dim * i + d + m);
    },
    jiggle(s, i, amount, rng) {
      for (let a = 0; a < dim; a++) s.x[dim * i + a] += (2 * rng() - 1) * amount * rho;
    },
    setSize(s, size) {
      const f = size / s.size;
      for (let i = 0; i < P; i++) for (let a = 0; a < d; a++) s.x[dim * i + a] *= f;
      s.size = size;
    },
    energy: (s, grad, w) => terms(s, grad, w, -1),
    pieceEnergy: (s, i, w) => terms(s, undefined, w, i),
    clear(s, i, tol) {
      if (!finite(s)) return false;
      const worst = { v: 0 };
      terms(s, undefined, undefined, i, worst);
      return worst.v <= tol;
    },
    finish(s, shouldStop): Finished | null {
      if (!finite(s)) return null;
      const cfg = toConfig(s);
      if (!parseNdConfig(problem, cfg).ok) return null;
      const f = legalFactor(cfg, shouldStop);
      if (f === null) return null;
      const out = scaledConfig(cfg, f);
      if (ndCheck(problem, out, 0, 1).length) return null;
      return { config: out, score: out.s };
    },
    validate(config): Validation {
      const parsed = parseNdConfig(problem, config);
      if (!parsed.ok) return { valid: false, score: null, reasons: parsed.errors.slice(0, NDIM_MAX_REASONS) };
      const c = parsed.config;
      if (c.s < bound * (1 - BOUND_SLACK))
        return {
          valid: false,
          score: c.s,
          reasons: [`the size ${c.s} is below the lower bound ${bound} of this problem`],
        };
      const reasons = ndCheck(problem, c, NDIM_KERNEL_TOL);
      return { valid: reasons.length === 0, score: c.s, reasons };
    },
    setShape(s, t) {
      aux(s).t = Math.min(1, Math.max(0, t));
    },
    seeds(rng, count) {
      const out: KernelState[] = [];
      for (let n = 0; n < count; n++) {
        // the canonical orientation for the first lattice cuts, random orientations for the next
        const [name, off] = SEEDS[n % SEEDS.length];
        const st = seedState(name, off, n >= SEEDS.length && !ballPiece, rng) ?? seedState("zd", 0, false, rng);
        if (st) out.push(st);
      }
      return out;
    },
    ...(ballPiece
      ? {}
      : {
          swap(s: KernelState, i: number, j: number) {
            // the whole orientation (anchor and chart) of each piece, so that a swap is exactly reversible
            const R0 = aux(s).R0;
            for (let a = 0; a < d * d; a++)
              [R0[i * d * d + a], R0[j * d * d + a]] = [R0[j * d * d + a], R0[i * d * d + a]];
            for (let a = d; a < dim; a++) [s.x[dim * i + a], s.x[dim * j + a]] = [s.x[dim * j + a], s.x[dim * i + a]];
          },
        }),
  };
  return kernel;
}
