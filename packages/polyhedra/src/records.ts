/**
 * The records file data/polyhedra/records.json (written by python/polyhedra/build_records.py, every
 * configuration proven valid by python/polyhedra/certify.py), and reading configurations as a server must:
 * untrusted input in, a clean copy with only the known fields out.
 */
import type { Pose } from "./geom";
import { configErrors, type PolyhedraConfig } from "./validate";

export interface PolyhedraLiterature {
  value: number;
  source: string;
  url?: string | null;
  reference?: string | null;
  precision?: number | null;
  kind: string;
  coordinates: false;
}

export interface PolyhedraRecord {
  id: string;
  code: string;
  piece: string;
  container: string;
  family: string;
  P: number;
  /** Float container scale of the stored poses at the same centres (the pieces keep their clearance). */
  score_float: number;
  /** The certified scale: config.s. */
  score_cert: number;
  display: string;
  status: "best_known" | "proven";
  config: PolyhedraConfig;
  bound: { value: number; kind: string };
  found_by: string;
  credit?: string;
  lineage?: string;
  certificate_refined_by?: string;
  method?: string;
  /** Keys of the file's `sources` table. */
  sources: string[];
  /** Citation sentence. */
  source: string;
  /**
   * The file the configuration comes from; for a PolyPack search its seed, the packing or construction it started
   * from and, where given, the runs after that start.
   */
  origin: { file: string; date?: string | null; seed?: number; evaluations?: number; start?: string; runs?: string[] };
  /** The wiki's record of the case; absent for PolyPack's own problems, which the wiki does not list. */
  wiki?: { s_full: number; url: string; file?: string };
  literature: PolyhedraLiterature[];
  /** Upstream's uncertified touching limit, where given. */
  s_tight?: number;
  notes?: string;
}

export interface PolyhedraRecordsFile {
  space: "polyhedra";
  generated: string;
  scope: { P: [number, number]; problems: number; note: string };
  upstream: Record<string, unknown>;
  conventions: Record<string, string>;
  sources: Record<string, { title: string; authors: string; url: string; commit: string | null; licence: string }>;
  records: PolyhedraRecord[];
}

/**
 * x rounded to the nearest at `digits` decimals from its exact binary value, ties to even (as Python's
 * Decimal(x).quantize(..., ROUND_HALF_EVEN)).
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

export type ParsedConfig =
  | { ok: true; config: PolyhedraConfig; score: number }
  | { ok: false; malformed: boolean; errors: string[] };

/**
 * A configuration of a problem with P pieces from untrusted input: { s, pieces: [[x, y, z, qw, qx, qy, qz], ...] }
 * with only those fields kept. Errors are `malformed` when the input is not such a configuration at all, and not
 * when only the number of pieces is wrong (an invalid packing, as the other spaces have it).
 */
export function parsePolyhedraConfig(raw: unknown, P: number, maxErrors = 20): ParsedConfig {
  const errs = configErrors(raw, undefined, maxErrors);
  if (errs.length) return { ok: false, malformed: true, errors: errs };
  const c = raw as { s: number; pieces: number[][] };
  if (c.pieces.length !== P)
    return { ok: false, malformed: false, errors: [`expected ${P} pieces for this problem, got ${c.pieces.length}`] };
  const config: PolyhedraConfig = { s: c.s, pieces: c.pieces.map((p) => p.slice(0, 7) as Pose) };
  return { ok: true, config, score: config.s };
}
