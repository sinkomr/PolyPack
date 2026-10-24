/** Types and helpers for data/torus/records.json (written by python/torus/build_records.py). */
import { Pose } from "@polypack/geometry";
import { LatticeSpec, TorusFamily, latticeFromSpec } from "./lattice";
import { TorusPacking, scalePacking } from "./validate";

export interface TorusBound {
  value: number;
  label: string;
  source?: string;
}

export interface TorusLiterature {
  /** literature score in PolyPack units, or null when only a bracket or a proof without value is known */
  value: number | null;
  short: string;
  source: string;
  url?: string;
  accessed?: string;
  status: string;
  note?: string;
}

export interface TorusRecord {
  problem: string;
  family: TorusFamily;
  N: number;
  P: number;
  score_float: number;
  score_cert: number;
  display: string;
  status: "best_known" | "proven" | "infeasible";
  density: number;
  eps: number;
  configuration: { lattice: LatticeSpec; poses: [number, number, number][] };
  certificate: string;
  bound: TorusBound;
  /** closed form when the score equals the bound (sqrt(P * c)) */
  exact?: { expr: string; value: number } | null;
  min_clearance_shrunk?: string;
  search_label?: string;
  literature?: TorusLiterature[];
  method: string;
  seed: number | null;
  budget: unknown;
  software: string;
  found_by: string;
  notes?: string;
}

export interface TorusRecordsFile {
  generated: string;
  conventions: Record<string, unknown>;
  records: TorusRecord[];
}

export function recordPacking(r: TorusRecord): TorusPacking {
  const poses: Pose[] = r.configuration.poses.map(([x, y, theta]) => ({ x, y, theta }));
  return { family: r.family, N: r.N, lattice: latticeFromSpec(r.family, r.configuration.lattice), poses };
}

/**
 * The packing at the certified score: the stored configuration scaled about the origin by
 * score_cert / score_float (full-size pieces). Float rounding of this scaling is why the
 * proof is made on the stored configuration with shrunk pieces instead.
 */
export function certifiedPacking(r: TorusRecord): TorusPacking {
  return scalePacking(recordPacking(r), r.score_cert / r.score_float);
}

/** Round up to `digits` decimals as a string (the display rule for certified scores). */
export function roundUp(x: number, digits = 6): string {
  const f = 10 ** digits;
  let v = Math.ceil(x * f - 1e-7) / f;
  if (v < x) v += 1 / f;
  return v.toFixed(digits);
}
