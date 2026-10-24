import { boundingRadius, inradius, polygonSeparation } from "@polypack/geometry";
import { ChainNode, enumerateChains, inWedge } from "../chains";
import { SurfacePose, pieceParts } from "../parts";
import { apply } from "../rigid";
import { Solid, frameVertex } from "../solids";
import { canonicalize } from "./energy";

/**
 * Sequential linear programming polish ("contact LP"). From a valid packing at scale lam, it
 * linearises every near contact (part-part separations, cone-point clearances, and for disks the
 * developed centre distances) by finite differences and solves
 *   maximise d_lam  subject to  value_k + J_k . d >= 0,  |d_i| <= trust,
 * then accepts the step only if the true packing is valid (every value >= -accept); otherwise the
 * trust region shrinks. Contacts are keyed by the chains (edge paths) of the parts involved, so the
 * same contact is followed under small moves.
 */

interface PieceGeom {
  nodes: ChainNode[];
  parts: { key: string; face: number; poly: Float64Array }[];
}

function pathKey(node: ChainNode): string {
  return node.path.map((e) => `${e.face}.${e.edge}`).join("|");
}

export function geom(solid: Solid, N: number, lam: number, p: SurfacePose, i: number): PieceGeom {
  if (N === 0) {
    const nodes = enumerateChains(solid, 1, p.face, p.x, p.y, 2 * lam);
    return { nodes, parts: [] };
  }
  const nodes = enumerateChains(solid, 1, p.face, p.x, p.y, lam * boundingRadius(N));
  const parts = pieceParts(solid, 1, N, p, i, lam, nodes)
    .filter((q) => q.poly.length >= 6)
    .map((q) => ({ key: pathKey(nodes[q.chain]), face: q.face, poly: q.poly }));
  return { nodes, parts };
}

/** Constraint values involving piece i (all of them when `only` is undefined), keyed. */
export function values(solid: Solid, N: number, lam: number, poses: SurfacePose[], G: PieceGeom[], only: number | undefined, thr: number, out: Map<string, number>): void {
  const P = poses.length;
  const M = solid.M;
  const rin = N === 0 ? lam : inradius(N) * lam;
  const pieces = only === undefined ? [...Array(P).keys()] : [only];
  for (const i of pieces) {
    const p = poses[i];
    // cone points
    for (const node of G[i].nodes) {
      for (let k = 0; k < M; k++) {
        const [fx, fy] = frameVertex(M, 1, k);
        const [vx, vy] = apply(node.toAnchor, fx, fy);
        if (!inWedge(node.wedge, p.x, p.y, vx, vy, 1e-12)) continue;
        let v: number;
        if (N === 0) v = Math.hypot(vx - p.x, vy - p.y) - lam;
        else {
          v = -Infinity;
          for (let j = 0; j < N; j++) {
            const a = p.theta + Math.PI / 2 + Math.PI / N + (2 * Math.PI * j) / N;
            v = Math.max(v, (vx - p.x) * Math.cos(a) + (vy - p.y) * Math.sin(a) - rin);
          }
        }
        if (v < thr) out.set(`c${i}:${pathKey(node)}:${k}`, v);
      }
    }
    if (N === 0) {
      // developed images of every centre (pairs and loops)
      G[i].nodes.forEach((node, ni) => {
        for (let j = 0; j < P; j++) {
          if (poses[j].face !== node.face || (j === i && ni === 0)) continue;
          const [qx, qy] = apply(node.toAnchor, poses[j].x, poses[j].y);
          if (!inWedge(node.wedge, p.x, p.y, qx, qy, 1e-12)) continue;
          const v = Math.hypot(qx - p.x, qy - p.y) - 2 * lam;
          if (v < thr) {
            // the same geodesic is seen from both ends; key it from the smaller index
            if (j < i && only === undefined) continue;
            out.set(`d${Math.min(i, j)}:${Math.max(i, j)}:${i}:${pathKey(node)}`, v);
          }
        }
      });
      continue;
    }
    for (let a = 0; a < G[i].parts.length; a++) {
      const A = G[i].parts[a];
      for (let j = 0; j < P; j++) {
        if (j < i && only === undefined) continue;
        const parts = G[j].parts;
        for (let b = 0; b < parts.length; b++) {
          if (j === i && b <= a) continue;
          const B = parts[b];
          if (B.face !== A.face) continue;
          const v = polygonSeparation(A.poly, B.poly).sep;
          if (v < thr) {
            const key = i < j || (i === j && a < b) ? `p${i}:${A.key}:${j}:${B.key}` : `p${j}:${B.key}:${i}:${A.key}`;
            out.set(key, v);
          }
        }
      }
    }
  }
}

/**
 * Dense simplex for: maximise c.z subject to A z <= b, z >= 0, with b >= 0 (Bland's rule).
 * `shouldStop`, optional, is polled every 8 pivots; true gives up (null, as for an unbounded LP).
 */
export function simplex(A: number[][], b: number[], c: number[], maxPivots = 5000, shouldStop?: () => boolean): number[] | null {
  const m = A.length;
  const n = c.length;
  // tableau rows: [A | I | b], objective row: [-c | 0 | 0]
  const W = n + m + 1;
  const T: Float64Array[] = [];
  for (let r = 0; r < m; r++) {
    const row = new Float64Array(W);
    for (let j = 0; j < n; j++) row[j] = A[r][j];
    row[n + r] = 1;
    row[W - 1] = b[r];
    T.push(row);
  }
  const obj = new Float64Array(W);
  for (let j = 0; j < n; j++) obj[j] = -c[j];
  const basis = Array.from({ length: m }, (_, r) => n + r);
  for (let it = 0; it < maxPivots; it++) {
    if (shouldStop && (it & 7) === 7 && shouldStop()) return null;
    let col = -1;
    for (let j = 0; j < W - 1; j++)
      if (obj[j] < -1e-12) {
        col = j;
        break;
      }
    if (col < 0) break;
    let row = -1;
    let best = Infinity;
    for (let r = 0; r < m; r++) {
      const a = T[r][col];
      if (a > 1e-12) {
        const q = T[r][W - 1] / a;
        if (q < best - 1e-15 || (Math.abs(q - best) <= 1e-15 && basis[r] < basis[row])) {
          best = q;
          row = r;
        }
      }
    }
    if (row < 0) return null; // unbounded
    const pr = T[row];
    const pv = pr[col];
    for (let j = 0; j < W; j++) pr[j] /= pv;
    for (let r = 0; r < m; r++) {
      if (r === row) continue;
      const f = T[r][col];
      if (f !== 0) for (let j = 0; j < W; j++) T[r][j] -= f * pr[j];
    }
    const f = obj[col];
    if (f !== 0) for (let j = 0; j < W; j++) obj[j] -= f * pr[j];
    basis[row] = col;
  }
  const z = new Array(n).fill(0);
  basis.forEach((v, r) => {
    if (v < n) z[v] = T[r][W - 1];
  });
  return z;
}

export interface SlpResult {
  lam: number;
  poses: SurfacePose[];
  iterations: number;
}

/**
 * Polish a valid packing (pieces scaled by lam on the unit solid). Returns a packing that is
 * valid with every constraint value >= -max(accept, the start's worst overlap) (accept defaults to
 * 1e-14) and lam at least the input's. `shouldStop`, optional, is polled before every iteration and
 * also inside one (per piece of the derivatives, in the LP, per trial step); true returns the last
 * accepted packing.
 */
export function slpPolish(solid: Solid, N: number, lam: number, poses0: SurfacePose[], opts: { iterations?: number; accept?: number; shouldStop?: () => boolean } = {}): SlpResult {
  const P = poses0.length;
  const dim = N === 0 ? 2 : 3;
  const accept = opts.accept ?? 1e-14;
  let acceptWorst = accept;
  let poses = poses0.map((p) => canonicalize(solid, 1, p));
  let G = poses.map((p, i) => geom(solid, N, lam, p, i));
  {
    // steps may not make the worst overlap worse than at the start (which may carry rounding-level overlaps)
    let worst0 = 0;
    const m0 = new Map<string, number>();
    values(solid, N, lam, poses, G, undefined, 0, m0);
    for (const v of m0.values()) worst0 = Math.min(worst0, v);
    acceptWorst = Math.max(accept, -worst0 * 1.0001);
  }
  const R = N === 0 ? 1 : boundingRadius(N);
  let trust = 0.02 * lam;
  const h = 1e-7 * lam;
  let it = 0;
  const allValues = (l: number, ps: SurfacePose[], gs: PieceGeom[], thr: number) => {
    const m = new Map<string, number>();
    values(solid, N, l, ps, gs, undefined, thr, m);
    return m;
  };
  for (; it < (opts.iterations ?? 60); it++) {
    if (opts.shouldStop && opts.shouldStop()) break;
    const thr = Math.max(4 * trust, 1e-6) * Math.max(1, R);
    const base = allValues(lam, poses, G, thr);
    const keys = [...base.keys()];
    if (!keys.length) {
      // nothing nearby (or contacts not yet visible: a piece flush with an edge has no part across
      // it until it moves): try growing within the trust region, checked like any other step
      const l2 = lam * (1 + trust);
      const gs = poses.map((p, i) => geom(solid, N, l2, p, i));
      let worst = 0;
      for (const v of allValues(l2, poses, gs, 0).values()) worst = Math.min(worst, v);
      if (worst >= -acceptWorst) {
        lam = l2;
        G = gs;
      } else {
        trust *= 0.25;
        if (trust < 1e-13 * lam) break;
      }
      continue;
    }
    const kidx = new Map(keys.map((k, t) => [k, t]));
    const nv = dim * P + 1;
    const J: number[][] = keys.map(() => new Array(nv).fill(0));
    // derivatives in each piece's variables
    let stopped = false;
    for (let i = 0; i < P; i++) {
      if (opts.shouldStop && opts.shouldStop()) {
        stopped = true;
        break;
      }
      for (let c = 0; c < dim; c++) {
        const q = { ...poses[i] };
        if (c === 0) q.x += h;
        else if (c === 1) q.y += h;
        else q.theta += h / (R * lam);
        const qc = canonicalize(solid, 1, q);
        const ps = poses.slice();
        ps[i] = qc;
        const gs = G.slice();
        gs[i] = geom(solid, N, lam, qc, i);
        const m = new Map<string, number>();
        values(solid, N, lam, ps, gs, i, Infinity, m);
        // contacts seen from the other pieces (disk images keyed from i, self pairs included)
        for (const [k, v] of m) {
          const t = kidx.get(k);
          if (t !== undefined) J[t][dim * i + c] = (v - base.get(k)!) / h;
        }
        // keys owned by other pieces that involve i: recompute those pieces' view
        if (N === 0) {
          for (let j = 0; j < P; j++) {
            if (j === i) continue;
            const mj = new Map<string, number>();
            values(solid, N, lam, ps, gs, j, Infinity, mj);
            for (const [k, v] of mj) {
              const t = kidx.get(k);
              if (t !== undefined && k.startsWith("d") && J[t][dim * i + c] === 0) {
                const d = (v - base.get(k)!) / h;
                if (d !== 0) J[t][dim * i + c] = d;
              }
            }
          }
        }
      }
    }
    if (stopped) break;
    // derivative in lam
    {
      const l2 = lam * (1 + 1e-7);
      const gs = poses.map((p, i) => geom(solid, N, l2, p, i));
      const m = allValues(l2, poses, gs, Infinity);
      for (const [k, t] of kidx) {
        const v = m.get(k);
        if (v !== undefined) J[t][nv - 1] = (v - base.get(k)!) / (l2 - lam);
      }
    }
    // LP in z = d+ - d- (all >= 0), bounds as rows
    const n = 2 * nv;
    const A: number[][] = [];
    const b: number[] = [];
    keys.forEach((k, t) => {
      const row = new Array(n).fill(0);
      for (let v = 0; v < nv; v++) {
        row[v] = -J[t][v];
        row[nv + v] = J[t][v];
      }
      A.push(row);
      b.push(Math.max(0, base.get(k)!));
    });
    for (let v = 0; v < nv; v++) {
      const bound = v === nv - 1 ? trust * lam : trust;
      for (const side of [0, 1]) {
        const row = new Array(n).fill(0);
        row[side * nv + v] = 1;
        A.push(row);
        b.push(bound);
      }
    }
    const c = new Array(n).fill(0);
    c[nv - 1] = 1;
    c[2 * nv - 1] = -1;
    const z = simplex(A, b, c, 5000, opts.shouldStop);
    if (!z && opts.shouldStop && opts.shouldStop()) break;
    if (!z) {
      trust *= 0.5;
      if (trust < 1e-13 * lam) break;
      continue;
    }
    // guard against numerical trouble in the dense simplex: the step must respect its bounds and
    // (to rounding) the linearised constraints, else it is discarded
    const d = new Array(nv).fill(0).map((_, v) => z[v] - z[nv + v]);
    let bad = d.some((v, idx) => !Number.isFinite(v) || Math.abs(v) > (idx === nv - 1 ? trust * lam : trust) * (1 + 1e-9));
    keys.forEach((k, t) => {
      let lin = base.get(k)!;
      for (let v = 0; v < nv; v++) lin += J[t][v] * d[v];
      if (lin < -1e-9 * Math.max(1, trust)) bad = true;
    });
    if (bad) {
      trust *= 0.5;
      if (trust < 1e-13 * lam) break;
      continue;
    }
    if (d[nv - 1] <= 1e-15 * lam) {
      trust *= 0.5;
      if (trust < 1e-13 * lam) break;
      continue;
    }
    // try the step, halving it until the true packing is valid
    let ok = false;
    for (let t = 1; t >= 1 / 64; t /= 2) {
      if (t < 1 && opts.shouldStop && opts.shouldStop()) break;
      const l2 = lam + t * d[nv - 1];
      const ps = poses.map((p, i) =>
        canonicalize(solid, 1, { ...p, x: p.x + t * d[dim * i], y: p.y + t * d[dim * i + 1], theta: dim === 3 ? p.theta + (t * d[dim * i + 2]) / (R * lam) : p.theta }),
      );
      const gs = ps.map((p, i) => geom(solid, N, l2, p, i));
      const m = allValues(l2, ps, gs, 0);
      let worst = 0;
      for (const v of m.values()) worst = Math.min(worst, v);
      if (worst >= -acceptWorst) {
        lam = l2;
        poses = ps;
        G = gs;
        ok = true;
        if (t === 1) trust = Math.min(trust * 1.5, 0.05 * lam);
        break;
      }
    }
    if (!ok) {
      trust *= 0.25;
      if (trust < 1e-13 * lam) break;
    }
  }
  return { lam, poses, iterations: it };
}
