import { Bandit, Prior, observe, sampleArm } from "./bandit";
import { FRONTIER_P, FRONTIER_SIDES, ProblemKey, keyOf } from "./frontier";
import { CONTEST, TIERS, Tier, shapeWeight } from "./points";

/**
 * The dealer's judgement (plan 2026-10-20 §3): what a candidate problem is expected to pay, the
 * buckets the learning dealer learns over, the player's filters, and the Collector's aim. Pure: the
 * page fetches the candidates and passes them in.
 *
 * The ranking score is an expected number of record points per second of solver time:
 *
 *   score = w · c · room · RP_PER_EVAL · correction · speed
 *
 * with w the shape weight, c the contest weight of the tier, room what the tier and the record's
 * weakness leave to gain, correction the learning dealer's draw for the candidate's bucket (1
 * without it), and speed √(cost of an evaluation at N+M+P = 85 / cost at the candidate's size).
 * The square root splits the difference between a clicking player (a click is one click whatever
 * the cost of its evaluation) and auto-eval (which runs as many evaluations as the CPU allows).
 * Room and RP_PER_EVAL are [SPEC]; the cost table is measured [CALC].
 */

/** Median ms of one mc_compress evaluation (open run, after Compact) by N+M+P, measured 2026-10-20 [CALC]. */
export const COST_TABLE: readonly (readonly [number, number])[] = [
  [18, 0.22],
  [24, 0.31],
  [33, 0.45],
  [54, 0.87],
  [64, 1.31],
  [85, 1.77],
  [180, 7.35],
  [326, 22.8],
  [500, 52.3],
];

/** The cost of one evaluation at size N+M+P, interpolated on log-log axes (extrapolated at the ends). */
export function msPerEval(total: number): number {
  const t = Math.max(2, total);
  const T = COST_TABLE;
  let i = 0;
  while (i < T.length - 2 && t > T[i + 1][0]) i++;
  const [x0, y0] = T[i];
  const [x1, y1] = T[i + 1];
  const slope = Math.log(y1 / y0) / Math.log(x1 / x0);
  return y0 * Math.pow(t / x0, slope);
}

/** The speed term: √(cost at N+M+P = 85 / cost at this size); 1 for the starter corner's sizes. */
export function speedFactor(total: number): number {
  return Math.sqrt(msPerEval(85) / msPerEval(total));
}

/** A site record is loose when its gap exceeds the median gap of its neighbours in P by this much. */
export const LOOSE_WEAKNESS = 0.005;
/** Neighbours of P: the same pair's records at P − NEIGHBOURS … P + NEIGHBOURS. */
export const NEIGHBOURS = 3;

/** A problem the dealer may deal, with what is known about its record. */
export interface Candidate extends ProblemKey {
  tier: Tier;
  /** The record's gap less its neighbours' median gap (contested problems); null when not judged. */
  weakness: number | null;
  /** The site leader the board starts from and must beat (contested problems, retakes). */
  leader: { score: number; name: string; id: number } | null;
  /** Published values: the score a record must beat (the value less its printed precision). */
  target: number | null;
  /** Published values: the value as printed, and its source. */
  source: string | null;
  /** A record the player lost, offered again. */
  retake: boolean;
}

/** What is left to gain on a problem of this tier [SPEC]. */
export function room(tier: Tier, weakness: number | null): number {
  switch (tier) {
    case "open":
      return 1;
    case "loose":
      return Math.min(1, 0.3 + 25 * Math.max(0, weakness ?? 0));
    // a typical site record has been worked on: improvements are rarer than on a weak one
    case "batch":
      return 0.1;
    // most published values are excellent, many likely optimal: a record below one is rare
    case "published":
      return 0.004;
  }
}

/** Record points an evaluation earns on a fresh open problem of shape weight 1, roughly [SPEC; stage-one simulation]. */
export const RP_PER_EVAL = 0.5;

/** The prior: expected record points per evaluation. */
export function priorPerEval(c: ProblemKey & { tier: Tier; weakness: number | null }): number {
  return shapeWeight(c.N, c.M) * CONTEST[c.tier] * room(c.tier, c.weakness) * RP_PER_EVAL;
}

/** The size rings, largest first (plan §3): ring k holds N+M+P ≥ RINGS[k] and below RINGS[k − 1]. */
export const RINGS: readonly number[] = [300, 200, 120, 80, 50, 30, 0];

export function sizeRing(total: number): number {
  const i = RINGS.findIndex((min) => total >= min);
  return i < 0 ? RINGS.length - 1 : i;
}

/** A shape's class for the learning dealer: circles, few sides, many sides, near-circular. */
export function shapeClass(n: number): "c" | "f" | "m" | "n" {
  return n === 0 ? "c" : n <= 6 ? "f" : n <= 20 ? "m" : "n";
}

/** The learning dealer's bucket: tier × size ring × the classes of piece and container. */
export function bucketOf(c: ProblemKey & { tier: Tier }): string {
  return `${c.tier}|r${sizeRing(c.N + c.M + c.P)}|${shapeClass(c.N)}${shapeClass(c.M)}`;
}

/**
 * The learning dealer learns, per bucket, how far the prior is off: the ratio of what problems paid
 * per evaluation to what the prior expected. Before any data the ratio is 1 ± 1.
 */
export const CORRECTION_PRIOR: Prior = { mean: 1, sd: 1 };
/** A problem teaches the learning dealer once it has run this many evaluations. */
export const LEARN_MIN_EVALS = 200;
/** Ratios are clipped to this range, so one lucky problem does not decide a bucket. */
export const MAX_RATIO = 20;

/** The ratio a problem that left the queue teaches its bucket, or null when it ran too little. */
export function learnedRatio(rp: number, evaluations: number, prior: number): number | null {
  if (!(evaluations >= LEARN_MIN_EVALS) || !(prior > 0) || !Number.isFinite(rp)) return null;
  return Math.min(MAX_RATIO, Math.max(0, rp / evaluations / prior));
}

/** Teaches a bucket what a problem paid. Returns whether it learned anything. */
export function learn(b: Bandit, bucket: string, rp: number, evaluations: number, prior: number): boolean {
  const r = learnedRatio(rp, evaluations, prior);
  if (r === null) return false;
  observe(b, bucket, r);
  return true;
}

export interface Ranked {
  candidate: Candidate;
  /** Expected record points per second of solver time, in the prior's units. */
  score: number;
  /** Expected record points per evaluation (the prior). */
  prior: number;
  bucket: string;
}

/**
 * Candidates ranked best first. With a bandit (the learning dealer), each bucket's correction is a
 * Thompson draw from what it has learned; without, the prior alone decides. Retakes come first.
 */
export function rankCandidates(cands: readonly Candidate[], bandit: Bandit | null, rand: () => number): Ranked[] {
  const draws = new Map<string, number>();
  const out = cands.map((candidate) => {
    const bucket = bucketOf(candidate);
    const prior = priorPerEval(candidate);
    let correction = 1;
    if (bandit) {
      if (!draws.has(bucket)) draws.set(bucket, sampleArm(bandit, bucket, CORRECTION_PRIOR, rand));
      correction = Math.max(0.01, draws.get(bucket)!);
    }
    const score = prior * correction * speedFactor(candidate.N + candidate.M + candidate.P);
    return { candidate, score, prior, bucket };
  });
  return out.sort((a, b) => Number(b.candidate.retake) - Number(a.candidate.retake) || b.score - a.score);
}

// ---------- filters ----------

/** The player's filters (Dealer filters). Null lists allow everything. */
export interface Filters {
  /** Piece shapes allowed (0: circle, n: n sides). */
  pieces: number[] | null;
  /** Container shapes allowed. */
  containers: number[] | null;
  minP: number;
  maxP: number;
  tiers: Tier[] | null;
}

export const NO_FILTERS: Filters = { pieces: null, containers: null, minP: 1, maxP: 500, tiers: null };

const isShape = (n: unknown): n is number =>
  Number.isSafeInteger(n) && ((n as number) === 0 || ((n as number) >= 3 && (n as number) <= 100));

/** Filters read from a save, or null when there are none. */
export function normalizeFilters(v: unknown): Filters | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const shapes = (x: unknown) => (Array.isArray(x) ? [...new Set(x.filter(isShape))].sort((a, b) => a - b) : null);
  const p = (x: unknown, d: number) =>
    Number.isSafeInteger(x) && (x as number) >= 1 && (x as number) <= 500 ? (x as number) : d;
  const minP = p(o.minP, 1);
  const maxP = Math.max(minP, p(o.maxP, 500));
  const tiers = Array.isArray(o.tiers)
    ? [...new Set(o.tiers.filter((t): t is Tier => TIERS.includes(t as Tier)))]
    : null;
  const pieces = shapes(o.pieces);
  const containers = shapes(o.containers);
  return {
    pieces: pieces && pieces.length ? pieces : null,
    containers: containers && containers.length ? containers : null,
    minP,
    maxP,
    tiers: tiers && tiers.length ? tiers : null,
  };
}

/** Whether a candidate passes the filters (null: no filters). */
export function passes(f: Filters | null, c: ProblemKey & { tier?: Tier }): boolean {
  if (!f) return true;
  if (f.pieces && !f.pieces.includes(c.N)) return false;
  if (f.containers && !f.containers.includes(c.M)) return false;
  if (c.P < f.minP || c.P > f.maxP) return false;
  if (f.tiers && c.tier && !f.tiers.includes(c.tier)) return false;
  return true;
}

/**
 * Shapes typed as a list of codes and ranges, "0, 3-6, 21-100" (0 is the circle). Empty text: every
 * shape (null). Returns an error message for text it cannot read.
 */
export function parseShapes(text: string): number[] | null | { error: string } {
  const t = text.trim();
  if (!t) return null;
  const out = new Set<number>();
  for (const part of t.split(/[,\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(part);
    if (!m) return { error: `cannot read “${part}”` };
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (b < a || b > 100) return { error: `“${part}” is not a range of shapes from 0 to 100` };
    for (let n = a; n <= b; n++) if (isShape(n)) out.add(n);
  }
  return out.size
    ? [...out].sort((x, y) => x - y)
    : { error: "no shape in that list (0 is the circle, then 3 to 100 sides)" };
}

/** A list of shapes as ranges: [0, 3, 4, 5, 9] → "0, 3-5, 9". */
export function formatShapes(list: readonly number[] | null): string {
  if (!list || !list.length) return "";
  const parts: string[] = [];
  let i = 0;
  while (i < list.length) {
    let j = i;
    // circles (0) never join a range: 1 and 2 are not shapes
    while (j + 1 < list.length && list[j + 1] === list[j] + 1 && list[i] !== 0) j++;
    parts.push(j > i ? `${list[i]}-${list[j]}` : `${list[i]}`);
    i = j + 1;
  }
  return parts.join(", ");
}

// ---------- the Collector ----------

/**
 * Problems that would complete the player's nearest collection: for each frontier pair (N, M), all
 * of FRONTIER_P. Pairs with the most problems recorded (but not all) come first; within a pair, the
 * missing P in order. Problems in `exclude` (dealt before, or taken) are skipped.
 */
export function collectorTargets(recorded: ReadonlySet<string>, exclude: ReadonlySet<string>): ProblemKey[] {
  const pairs: { have: number; missing: ProblemKey[]; order: number }[] = [];
  let order = 0;
  for (const N of FRONTIER_SIDES)
    for (const M of FRONTIER_SIDES) {
      let have = 0;
      const missing: ProblemKey[] = [];
      for (const P of FRONTIER_P) {
        const k = { N, M, P };
        if (recorded.has(keyOf(k))) have++;
        else if (!exclude.has(keyOf(k))) missing.push(k);
      }
      if (have > 0 && have < FRONTIER_P.length && missing.length) pairs.push({ have, missing, order: order++ });
    }
  pairs.sort((a, b) => b.have - a.have || a.order - b.order);
  return pairs.flatMap((p) => p.missing);
}
