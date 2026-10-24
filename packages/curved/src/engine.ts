/**
 * Public engine API for the constant-curvature family, independent of any UI.
 *
 *   validate(problem, K, config)                 float validation (see validate.ts)
 *   solve(problem, K, { seed, restarts, hops })  seeded global search + polish
 *   polishAt(problem, K, config, { margin })     local optimum with active set and multipliers
 *   sensitivity(problem, K, config)              envelope-theorem ds/dK at a polished optimum
 *   continueTo(problem, K0, K1, config, steps)   warm-started continuation in K
 *   certifyPrep(problem, K, config)              margin re-solve for interval certification
 *
 * Poses are K-independent exponential coordinates (see problem.ts), so the same configuration can
 * be evaluated at any K and the envelope theorem applies with fixed (x, y, theta, s).
 */
import { CurvedConfig, CurvedPose, CurvedProblem, makeSpace, Space } from "./problem";
import {
  pieceState,
  vertexEdgeRow,
  diskPairRow,
  wallRow,
  rimRow,
  type Row,
  allStates,
  pairGap,
  centreDistance,
} from "./evaluate";
import { ActiveRow, PolishResult, polish } from "./polish";
import { SearchOptions, SearchResult, search } from "./search";
import { validate, ValidationResult } from "./validate";
import { apothemFromSide, maxContainerSize, pieceExists } from "./shapes";

export { validate } from "./validate";

export interface SolveResult extends SearchResult {
  problem: CurvedProblem;
  K: number;
  validation?: ValidationResult;
}

export function solve(problem: CurvedProblem, K: number, options: SearchOptions = {}): SolveResult {
  const space = makeSpace(K, problem.N, problem.M);
  const res = search(space, problem.P, options);
  const out: SolveResult = { ...res, problem, K };
  if (res.config) out.validation = validate(problem, K, res.config);
  return out;
}

export interface PolishedConfig {
  config: CurvedConfig;
  polish: PolishResult;
  validation: ValidationResult;
}

/** Polish a configuration to a local optimum at curvature K (gaps >= margin). */
export function polishAt(
  problem: CurvedProblem,
  K: number,
  config: CurvedConfig,
  opts: { margin?: number; maxIter?: number } = {},
): PolishedConfig {
  const space = makeSpace(K, problem.N, problem.M);
  const t0 = config.size < maxContainerSize(problem.M, K) ? apothemFromSide(problem.M, K, config.size) : undefined;
  const pol = polish(space, config.pieces, Number.isFinite(t0 as number) ? t0 : undefined, {
    margin: opts.margin ?? 0,
    maxIter: opts.maxIter,
  });
  const cfg = { size: pol.size, pieces: pol.poses };
  return { config: cfg, polish: pol, validation: validate(problem, K, cfg) };
}

/** Re-evaluate one active row (same pieces, witness and container size s) at curvature K. */
export function rowValueAt(problem: CurvedProblem, K: number, config: CurvedConfig, row: ActiveRow): number {
  const space = makeSpace(K, problem.N, problem.M);
  const t = apothemFromSide(problem.M, K, config.size);
  const Si = pieceState(space, config.pieces[row.i]);
  let r: Row;
  if (row.kind === "pair") {
    const Sj = pieceState(space, config.pieces[row.j]);
    if (problem.N === 0) r = diskPairRow(space, Si, Sj, row.i, row.j);
    else {
      const [P, Q, pi, qi] = row.owner === 0 ? [Si, Sj, row.i, row.j] : [Sj, Si, row.j, row.i];
      r = vertexEdgeRow(space, P, row.edge, Q, row.vertex, pi, qi, row.owner);
    }
  } else if (row.kind === "wall") r = wallRow(space, Si, row.i, row.vertex, row.wall, t);
  else r = rimRow(space, Si, row.i, row.vertex, t);
  return r.value;
}

export interface Sensitivity {
  /** envelope-theorem derivative of the optimal size with respect to K */
  dsdK: number;
  active: ActiveRow[];
  kktResidual: number;
}

/**
 * ds/dK = -sum_k lambda_k d g_k / dK at fixed poses and fixed size s (envelope theorem for
 * min s subject to g_k(z, s; K) >= 0, with lambda_k the multipliers for s). Valid at a
 * nondegenerate KKT point; check kktResidual and that multipliers are well separated from 0.
 */
export function sensitivity(problem: CurvedProblem, K: number, config: CurvedConfig, pol?: PolishResult): Sensitivity {
  const p = pol ?? polishAt(problem, K, config).polish;
  const cfg = pol ? config : { size: p.size, pieces: p.poses };
  const h = 1e-6 * Math.max(1, Math.abs(K));
  let dsdK = 0;
  for (const row of p.active) {
    if (row.lambda === 0) continue;
    const gp = rowValueAt(problem, K + h, cfg, row);
    const gm = rowValueAt(problem, K - h, cfg, row);
    dsdK -= row.lambda * ((gp - gm) / (2 * h));
  }
  return { dsdK, active: p.active, kktResidual: p.kktResidual };
}

export interface ContinuationStep {
  K: number;
  config: CurvedConfig;
  size: number;
  feasible: boolean;
  dsdK: number;
  kktResidual: number;
  active: ActiveRow[];
  /** active-set identity changes relative to the previous step */
  added: string[];
  removed: string[];
  /** size minus the first-order prediction from the previous step */
  predictionError: number;
  note?: string;
}

export function rowKey(r: ActiveRow): string {
  if (r.kind === "pair") return `pair:${r.i}-${r.j}:${r.owner}/${r.edge}/${r.vertex}`;
  if (r.kind === "wall") return `wall:${r.i}:${r.vertex}@${r.wall}`;
  return `rim:${r.i}:${r.vertex}`;
}

/**
 * Warm-started continuation from K0 to K1 in `steps` equal steps. Each step polishes the previous
 * configuration at the new K (same exponential coordinates as the start), then records the
 * envelope derivative, the active set and its changes. A failed step (no feasible polish, or the
 * container would leave the open hemisphere) is reported and the walk stops.
 */
export function continueTo(
  problem: CurvedProblem,
  K0: number,
  K1: number,
  config: CurvedConfig,
  steps: number,
  opts: { margin?: number } = {},
): ContinuationStep[] {
  const out: ContinuationStep[] = [];
  let cur = config;
  let prev: ContinuationStep | undefined;
  for (let i = 0; i <= steps; i++) {
    const K = K0 + ((K1 - K0) * i) / steps;
    if (!pieceExists(problem.N, K)) {
      out.push(failStep(K, cur, "unit piece does not exist at this K"));
      break;
    }
    let pc: PolishedConfig;
    try {
      pc = polishAt(problem, K, cur, { margin: opts.margin });
    } catch (e) {
      out.push(failStep(K, cur, (e as Error).message));
      break;
    }
    const feasible = pc.validation.valid && pc.polish.feasibility > -1e-9;
    const sens = sensitivity(problem, K, pc.config, pc.polish);
    const keys = new Set(pc.polish.active.map(rowKey));
    const prevKeys = new Set(prev ? prev.active.map(rowKey) : []);
    const step: ContinuationStep = {
      K,
      config: pc.config,
      size: pc.config.size,
      feasible,
      dsdK: sens.dsdK,
      kktResidual: sens.kktResidual,
      active: pc.polish.active,
      added: prev ? [...keys].filter((k) => !prevKeys.has(k)) : [],
      removed: prev ? [...prevKeys].filter((k) => !keys.has(k)) : [],
      predictionError: prev ? pc.config.size - (prev.size + prev.dsdK * (K - prev.K)) : 0,
    };
    out.push(step);
    if (!feasible) {
      step.note = "polish did not reach a valid configuration";
      break;
    }
    prev = step;
    cur = pc.config;
  }
  return out;
}

function failStep(K: number, config: CurvedConfig, note: string): ContinuationStep {
  return {
    K,
    config,
    size: NaN,
    feasible: false,
    dsdK: NaN,
    kktResidual: NaN,
    active: [],
    added: [],
    removed: [],
    predictionError: NaN,
    note,
  };
}

export interface CertificateWitness {
  i: number;
  j: number;
  /** "axis": edge `edge` of piece (owner 0 ? i : j) separates; "far": circumdisks disjoint; "disk": centre distance */
  type: "axis" | "far" | "disk";
  owner?: number;
  edge?: number;
}

export interface CertPrep {
  /** the margin-polished configuration whose size is score_cert */
  config: CurvedConfig;
  margin: number;
  validation: ValidationResult;
  witnesses: CertificateWitness[];
  polish: PolishResult;
}

/**
 * Margin re-solve for certification. Curved spaces have no similarity, so instead of scaling, the
 * optimum is re-polished with every gap >= margin; the resulting size is a candidate score_cert
 * for which the stored floats have strictly positive clearance (to be proven by the certifier).
 */
export function certifyPrep(
  problem: CurvedProblem,
  K: number,
  config: CurvedConfig,
  margin = 2e-11,
  maxIter?: number,
): CertPrep {
  const pc = polishAt(problem, K, config, { margin, maxIter });
  const space = makeSpace(K, problem.N, problem.M);
  return {
    config: pc.config,
    margin,
    validation: pc.validation,
    witnesses: witnesses(space, pc.config.pieces),
    polish: pc.polish,
  };
}

/** Separation witnesses for every pair, for the certifier. */
export function witnesses(space: Space, poses: CurvedPose[]): CertificateWitness[] {
  const st = allStates(space, poses);
  const out: CertificateWitness[] = [];
  for (let i = 0; i < poses.length; i++)
    for (let j = i + 1; j < poses.length; j++) {
      if (space.N === 0) {
        out.push({ i, j, type: "disk" });
        continue;
      }
      if (centreDistance(space, st[i], st[j]) > 2 * space.piece.R + 1e-3) {
        out.push({ i, j, type: "far" });
        continue;
      }
      const g = pairGap(space, st[i], st[j]);
      out.push({ i, j, type: "axis", owner: g.witness.owner, edge: g.witness.edge });
    }
  return out;
}
