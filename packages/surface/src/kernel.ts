/**
 * The surface space's kernel for the generic search methods (packages/methods/src/kernel.ts,
 * docs/methods/dimensions/README.md), fold mode: pieces on the surface of a solid, folding
 * across its edges. The nofold mode is planar and runs on the polygon solver instead.
 *
 * State. Each piece's chart is its anchor face's frame on the solid of edge 1, as the fold
 * search works: x = (u, v[, theta]) per piece, the centre (u, v) = (x, y) / s and the angle in
 * that frame (disks have no angle: dim 2). aux keeps the anchor faces and the soft-shape
 * parameter t. size = s, the solid's edge, which is the score (docs/spaces/SURFACE.md). So the
 * fixed chart with a changing size is the fold search's packing on the unit solid with pieces
 * scaled by lam = 1/s, and setSize keeps the normalized arrangement by changing s alone.
 * A chart may leave its face during a local solve; every operation reads a piece through
 * unfoldChart (kernel-solid.ts), which develops the centre along the segment from its face's
 * centre across the edges it crosses (across one edge, what the fold search's canonicalize does),
 * and rebase stores that pose. Steps: the inradius at the bound's edge for (u, v), and the turn
 * that moves a corner by the inradius for theta.
 *
 * Energy: kernel-energy.ts (the fold search's model, with weights), in piece units: s^2 times
 * the energy on the unit solid. Gradient: analytic for disks; for polygons central differences
 * of each piece's own terms, as the fold search does, and of the whole energy for dE/ds.
 * finish and validate: kernel-finish.ts (bisection on the scale, a short contact-LP polish, the
 * validator at tolerance 0; and the server's rule).
 *
 * Capabilities: "shape" (soft polygons inside the true ones, kernel-energy.ts pieceOutline; a
 * no-op for disks), "seeds" (nofold-like layouts: the pieces spread evenly over the faces, on a
 * triangular patch about each face's centre, valid at the size returned) and, for polygons,
 * "swap" (the two pieces exchange their angles in their own faces' frames).
 */
import { boundingRadius, inradius } from "@polypack/geometry";
import type { Finished, KernelCapability, KernelState, Rng, SpaceKernel, Validation } from "@polypack/methods";
import { PolygonModel, TooLarge, diskClear, diskTerms, jumpAwareDifference } from "./kernel-energy";
import {
  SERVER_BOUND_SLACK,
  SERVER_MAX_P,
  finishFold,
  parseFoldSubmission,
  validateFoldSubmission,
} from "./kernel-finish";
import {
  areaBound,
  chartPoint,
  faceCentre3D,
  faceShapes,
  randomSurfacePoint,
  surfaceBound,
  unfoldChart,
} from "./kernel-solid";
import type { SurfacePose } from "./parts";
import { SOLID_NAMES, type SolidName, getSolid, isSolidName } from "./solids";

/** The kernel's own data of a state. */
interface SurfaceAux {
  /** anchor face of each piece */
  faces: Int32Array;
  /** soft-shape parameter (1 = the true shape) */
  t: number;
}

/**
 * Energy evaluations one finish() costs, against an energy sweep of every piece: its bisection
 * takes up to about 60 sweeps and its contact-LP polish (work-bounded, kernel-finish.ts) the rest.
 * [CALC] Measured on squeezed random starts against a sweep that develops every piece (P = 10 and
 * 30; cube, octahedron, icosahedron, dodecahedron): polygons 140 to 1200 sweeps (medians about
 * 175 at P = 10 and 710 at P = 30), disks 490 to 2600 (medians about 650 and 1880); a disk sweep
 * is several times cheaper than a polygon sweep, while the polish costs about as much.
 */
export function surfaceFinishCost(N: number, P: number): number {
  return N === 0 ? 200 + 60 * P : 100 + 20 * P;
}

/** Energy evaluations one validate() costs (measured): the fold validator develops every piece once, as an energy sweep does. */
export const SURFACE_VALIDATE_COST = 2;

export function surfaceKernel(problem: { solid: SolidName; N: number; P: number }): SpaceKernel {
  const { N, P } = problem;
  if (!isSolidName(problem.solid)) throw new Error(`unknown solid ${String(problem.solid)}`);
  // built on the Platonic solids' identical regular faces (faceShapes, the bound): other solids
  // keep Auto alone until the kernel reads their faces one by one
  if (!(SOLID_NAMES as readonly string[]).includes(problem.solid))
    throw new Error(`the surface kernel covers the Platonic solids only, not ${problem.solid}`);
  if (!(Number.isInteger(N) && (N === 0 || N >= 3))) throw new Error("N must be 0 or an integer >= 3");
  if (!(Number.isInteger(P) && P >= 1)) throw new Error("P must be a positive integer");
  const solid = getSolid(problem.solid);
  const dim = N === 0 ? 2 : 3;
  const n = P * dim;
  const bound = surfaceBound(solid, N, P);
  const rIn = N === 0 ? 1 : inradius(N);
  const R = boundingRadius(N);
  // (u, v) are lengths on the unit solid, so a move by the inradius at the bound's edge is rIn / bound
  const steps = Float64Array.from(dim === 2 ? [rIn / bound, rIn / bound] : [rIn / bound, rIn / bound, rIn / R]);
  const model = N === 0 ? null : new PolygonModel(solid, N, P);
  const faces = faceShapes(solid);
  // random starts at the fold search's density (its lam = 0.55 of the area scale), roomy for one
  // piece, and with every piece small enough to fit in a face: larger pieces wrap around the
  // vertices, and a relaxation from random poses then often leaves cone points inside them
  const fitsFace = R / Math.min(...faces.map((f) => f.inner));
  const roomy = Math.max(areaBound(solid, N, P) / 0.55, 1.25 * bound, fitsFace);

  const aux = (s: KernelState) => s.aux as SurfaceAux;
  const chart = (s: KernelState, i: number): SurfacePose => ({
    face: aux(s).faces[i],
    x: s.x[dim * i],
    y: s.x[dim * i + 1],
    theta: dim === 3 ? s.x[dim * i + 2] : 0,
  });
  const canonical = (s: KernelState): SurfacePose[] =>
    Array.from({ length: P }, (_, i) => unfoldChart(solid, chart(s, i)));
  const make = (x: Float64Array, size: number, faceIds: ArrayLike<number>, t = 1): KernelState => ({
    x,
    size,
    aux: { faces: Int32Array.from(faceIds), t } satisfies SurfaceAux,
  });
  const store = (s: KernelState, i: number, p: SurfacePose) => {
    aux(s).faces[i] = p.face;
    s.x[dim * i] = p.x;
    s.x[dim * i + 1] = p.y;
    if (dim === 3) s.x[dim * i + 2] = p.theta;
  };

  const diskEnergy = (s: KernelState, grad?: Float64Array, w?: Float64Array): number => {
    const size = s.size;
    const poses = canonical(s);
    const g = grad ? new Float64Array(2 * P) : undefined;
    const { e, dlam } = diskTerms(solid, 1 / size, poses, w, g);
    const s2 = size * size;
    if (grad && g) {
      for (let i = 0; i < P; i++) {
        // unfoldChart turned the chart by poses[i].theta (the chart angle is 0); the chart
        // gradient is the canonical one turned back
        const a = poses[i].theta;
        const c = Math.cos(a);
        const sn = Math.sin(a);
        grad[2 * i] = s2 * (c * g[2 * i] + sn * g[2 * i + 1]);
        grad[2 * i + 1] = s2 * (-sn * g[2 * i] + c * g[2 * i + 1]);
      }
      // E(s) = s^2 E1(1 / s), so dE/ds = 2 s E1 - dE1/dlam
      grad[n] = 2 * size * e - dlam;
    }
    return s2 * e;
  };

  const polygonEnergy = (m: PolygonModel, s: KernelState, grad?: Float64Array, w?: Float64Array): number => {
    const size = s.size;
    const lam = 1 / size;
    const t = aux(s).t;
    const poses = canonical(s);
    const { geoms, byFace } = m.layout(poses, lam, t);
    const e = m.total(geoms, byFace, w);
    const s2 = size * size;
    if (grad) {
      // steps of 1e-7 piece units, as the fold search's gradient takes them
      const h = [1e-7 * lam, 1e-7 * lam, 1e-7 / R];
      for (let i = 0; i < P; i++) {
        const e0 = m.local(i, geoms[i], byFace, w);
        const base = chart(s, i);
        for (let c = 0; c < 3; c++) {
          const plus = { ...base };
          const minus = { ...base };
          if (c === 0) {
            plus.x += h[0];
            minus.x -= h[0];
          } else if (c === 1) {
            plus.y += h[1];
            minus.y -= h[1];
          } else {
            plus.theta += h[2];
            minus.theta -= h[2];
          }
          const ep = m.local(i, m.geom(unfoldChart(solid, plus), lam, t, i, false), byFace, w);
          const em = m.local(i, m.geom(unfoldChart(solid, minus), lam, t, i, false), byFace, w);
          grad[3 * i + c] = s2 * jumpAwareDifference(em, e0, ep, h[c]);
        }
      }
      const hs = 1e-7 * size;
      const at = (sz: number) => {
        const l = m.layout(poses, 1 / sz, t, false);
        return sz * sz * m.total(l.geoms, l.byFace, w);
      };
      grad[n] = jumpAwareDifference(at(size - hs), s2 * e, at(size + hs), hs);
    }
    return s2 * e;
  };

  const guard = <T>(f: () => T, tooLarge: T): T => {
    try {
      return f();
    } catch (e) {
      if (e instanceof TooLarge) return tooLarge;
      throw e;
    }
  };

  /**
   * A uniformly random pose for piece i, written in its own anchor's chart (a move changes only
   * the piece's variables): the point's chart coordinates are the developed end of a shortest
   * path from the anchor face's centre, which unfoldChart takes back to the point.
   */
  const random = (s: KernelState, i: number, rng: Rng) => {
    for (;;) {
      const pt = randomSurfacePoint(solid, rng);
      const c = chartPoint(solid, aux(s).faces[i], pt.face, pt.x, pt.y);
      if (!c) continue;
      s.x[dim * i] = c[0];
      s.x[dim * i + 1] = c[1];
      if (dim === 3) s.x[dim * i + 2] = 2 * Math.PI * rng();
      return;
    }
  };

  /**
   * A nofold-like start: P spread as evenly as the faces allow (the faces that hold one more are
   * spread over the solid, greedily farthest from those already chosen), and on each face the k
   * points of a triangular lattice of spacing 2 R nearest a random offset, about the face's
   * centre, every piece at one angle (in its face's frame). At the size returned every patch
   * lies in its face, so the start is a valid nofold packing.
   */
  const seed = (rng: Rng): KernelState => {
    const F = solid.F;
    const counts = new Array<number>(F).fill(Math.floor(P / F));
    const extra = P - counts[0] * F;
    if (extra > 0) {
      const centres = Array.from({ length: F }, (_, f) => faceCentre3D(solid, f));
      const dist = (a: number, b: number) => Math.hypot(...[0, 1, 2].map((k) => centres[a][k] - centres[b][k]));
      const chosen = [Math.min(F - 1, Math.floor(rng() * F))];
      while (chosen.length < extra) {
        let best = -1;
        let far = -Infinity;
        for (let f = 0; f < F; f++) {
          if (chosen.includes(f)) continue;
          const d = Math.min(...chosen.map((c) => dist(c, f)));
          if (d > far + 1e-12) {
            far = d;
            best = f;
          }
        }
        chosen.push(best);
      }
      for (const f of chosen) counts[f]++;
    }
    const spacing = 2 * R;
    const theta = 2 * Math.PI * rng();
    const patches = counts.map((k) => latticePatch(k, spacing, rng));
    // the edge at which each face's inner disk holds its patch, and at least the bound
    let size = bound * 1.02;
    patches.forEach((pts, f) => {
      if (!pts.length) return;
      const reach = Math.max(...pts.map(([x, y]) => Math.hypot(x, y))) + R;
      size = Math.max(size, (reach / faces[f].inner) * (1 + 1e-9));
    });
    const x = new Float64Array(n);
    const faceIds: number[] = [];
    let i = 0;
    patches.forEach((pts, f) => {
      for (const [px, py] of pts) {
        faceIds.push(f);
        x[dim * i] = px / size;
        x[dim * i + 1] = py / size;
        if (dim === 3) x[dim * i + 2] = theta;
        i++;
      }
    });
    return make(x, size, faceIds);
  };

  const capabilities: KernelCapability[] = N === 0 ? ["shape", "seeds"] : ["shape", "seeds", "swap"];

  const kernel: SpaceKernel = {
    space: "surface",
    id: `surface/${solid.name}/fold/${N}/${P}`,
    P,
    dim,
    steps,
    globals: 0,
    globalSteps: new Float64Array(0),
    // lengths are in piece units, as the edge s is
    inradius: rIn,
    bound,
    finishCost: surfaceFinishCost(N, P),
    validateCost: SURFACE_VALIDATE_COST,
    // a polygon's gradient is a central difference: [CALC] 8.3 to 8.9 sweeps on squeezed states
    // (cube, octahedron, icosahedron; P = 10 and 30); a disk's is analytic, about one sweep
    gradCost: N === 0 ? 1 : 9,
    capabilities,

    fromConfig(config) {
      // what the server would refuse unchecked: a malformed configuration, P above the catalogue's, a size below the bound
      const parsed = parseFoldSubmission(solid, P, config);
      if (Array.isArray(parsed) || P > SERVER_MAX_P || parsed.s < bound * (1 - SERVER_BOUND_SLACK)) return null;
      const x = new Float64Array(n);
      parsed.pieces.forEach((p, i) => {
        x[dim * i] = p.x / parsed.s;
        x[dim * i + 1] = p.y / parsed.s;
        if (dim === 3) x[dim * i + 2] = p.theta;
      });
      const s = make(
        x,
        parsed.s,
        parsed.pieces.map((p) => p.face),
      );
      kernel.rebase(s);
      return s;
    },
    toConfig(s) {
      const size = s.size;
      return {
        s: size,
        pieces: canonical(s).map((p) => ({
          face: p.face,
          x: p.x * size,
          y: p.y * size,
          theta: dim === 3 ? p.theta : 0,
        })),
      };
    },
    clone: (s) => make(Float64Array.from(s.x), s.size, aux(s).faces, aux(s).t),
    rebase(s) {
      for (let i = 0; i < P; i++) store(s, i, unfoldChart(solid, chart(s, i)));
    },
    randomStart(rng) {
      const s = make(new Float64Array(n), roomy, new Int32Array(P));
      for (let i = 0; i < P; i++) {
        const pt = randomSurfacePoint(solid, rng);
        store(s, i, { face: pt.face, x: pt.x, y: pt.y, theta: 2 * Math.PI * rng() });
      }
      return s;
    },
    randomPose: random,
    jiggle(s, i, amount, rng) {
      for (let c = 0; c < dim; c++) s.x[dim * i + c] += (2 * rng() - 1) * amount * steps[c];
    },
    setSize(s, size) {
      s.size = size;
    },
    energy(s, grad, w) {
      if (!(s.size > 0) || !Number.isFinite(s.size)) {
        grad?.fill(0);
        return Infinity;
      }
      const e = guard(() => (model ? polygonEnergy(model, s, grad, w) : diskEnergy(s, grad, w)), Infinity);
      if (e === Infinity) grad?.fill(0);
      return e;
    },
    pieceEnergy(s, i, w) {
      if (!(s.size > 0) || !Number.isFinite(s.size)) return Infinity;
      const lam = 1 / s.size;
      const s2 = s.size * s.size;
      return guard(() => {
        const poses = canonical(s);
        if (!model) return s2 * diskTerms(solid, lam, poses, w, undefined, i).e;
        const { geoms, byFace } = model.layout(poses, lam, aux(s).t);
        return s2 * model.local(i, geoms[i], byFace, w);
      }, Infinity);
    },
    clear(s, i, tol) {
      if (!(s.size > 0) || !Number.isFinite(s.size)) return false;
      const lam = 1 / s.size;
      // tol is a length in piece units; the model's lengths are lam times shorter
      return guard(() => {
        const poses = canonical(s);
        if (!model) return diskClear(solid, lam, poses, i, tol * lam);
        const { geoms, byFace } = model.layout(poses, lam, aux(s).t);
        return model.clear(i, geoms[i], byFace, tol * lam);
      }, false);
    },
    finish(s, shouldStop): Finished | null {
      // well below the bound nothing valid is near, and the pieces are far too large for the solid
      if (!(s.size >= 0.5 * bound) || !Number.isFinite(s.size)) return null;
      // no valid packing is smaller than the bound, so the tightening starts there at the latest;
      // finish always uses the true shape; the stop ends the polish early
      const size = Math.max(s.size, bound);
      const r = guard(() => finishFold(solid, N, 1 / size, canonical(s), { shouldStop }), null);
      if (!r) return null;
      const config = {
        s: r.s,
        pieces: r.pieces.map((p) => ({ face: p.face, x: p.x, y: p.y, theta: dim === 3 ? p.theta : 0 })),
      };
      return { config, score: r.s };
    },
    validate: (config): Validation => validateFoldSubmission(solid, N, P, bound, config),

    setShape(s, t) {
      // disks are their own inscribed disk: every soft shape is the disk itself
      if (dim === 3) aux(s).t = Math.min(1, Math.max(0, t));
    },
    seeds(rng, count) {
      return Array.from({ length: count }, () => seed(rng));
    },
    ...(dim === 3
      ? {
          swap(s: KernelState, i: number, j: number) {
            // the angles on the surface, each chart's own plus the turn its unfolding adds (which
            // depends on the position only), are exchanged; the anchors stay
            const ti = s.x[3 * i + 2];
            const tj = s.x[3 * j + 2];
            const turn = (k: number) => unfoldChart(solid, chart(s, k)).theta - s.x[3 * k + 2];
            const ai = turn(i);
            const aj = turn(j);
            s.x[3 * i + 2] = tj + aj - ai;
            s.x[3 * j + 2] = ti + ai - aj;
          },
        }
      : {}),
  };
  return kernel;
}

/** The k points of a triangular lattice of spacing d nearest a random offset, with their mean at the origin. */
function latticePatch(k: number, d: number, rng: Rng): [number, number][] {
  if (k === 0) return [];
  const ox = rng() * d;
  const oy = rng() * d * (Math.sqrt(3) / 2);
  const reach = Math.ceil(Math.sqrt(k)) + 2;
  const pts: [number, number][] = [];
  for (let a = -reach; a <= reach; a++)
    for (let b = -reach; b <= reach; b++) pts.push([(a + b / 2) * d + ox, ((b * Math.sqrt(3)) / 2) * d + oy]);
  pts.sort((p, q) => Math.hypot(p[0], p[1]) - Math.hypot(q[0], q[1]));
  const chosen = pts.slice(0, k);
  const cx = chosen.reduce((t, p) => t + p[0], 0) / k;
  const cy = chosen.reduce((t, p) => t + p[1], 0) / k;
  return chosen.map(([x, y]) => [x - cx, y - cy]);
}
