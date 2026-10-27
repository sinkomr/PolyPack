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
  /** full citation */
  source: string;
  url?: string;
  accessed?: string;
  /** the source's own claim: proven, proven_unrefereed, best_known or conjecture */
  status: string;
  doi?: string;
  /**
   * Set only when the entry's proof states this exact torus case and was checked against the
   * source: the theorem or section. A record is `proven` only through such an entry.
   */
  proof?: string;
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
  /** "diameter" once the data is in site units (disks of diameter 1) */
  units?: string;
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

/**
 * The display rule for certified scores: score_cert rounded to the nearest at `digits`
 * decimals, computed from its exact binary64 value with ties to even, always `digits`
 * decimals (2.000000000002 -> "2.000000"). Matches Python's
 * str(Decimal(x).quantize(Decimal("0.000001"), rounding=ROUND_HALF_EVEN)).
 */
export function displayScore(x: number, digits = 6): string {
  if (!Number.isFinite(x)) throw new RangeError("display needs a finite number");
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(x));
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const expBits = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let exp: number;
  if (expBits === 0) exp = -1074;
  else {
    mant |= 1n << 52n;
    exp = expBits - 1075;
  }
  // |x| * 10^digits = mant * 10^digits * 2^exp, exactly, as num / den
  let num = mant * 10n ** BigInt(digits);
  let den = 1n;
  if (exp >= 0) num <<= BigInt(exp);
  else den <<= BigInt(-exp);
  let q = num / den;
  const twice = 2n * (num % den);
  if (twice > den || (twice === den && (q & 1n) === 1n)) q += 1n;
  const s = q.toString().padStart(digits + 1, "0");
  const out = digits > 0 ? `${s.slice(0, s.length - digits)}.${s.slice(s.length - digits)}` : s;
  return x < 0 && q !== 0n ? `-${out}` : out;
}
