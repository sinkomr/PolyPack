import { SCORE_TIE, areaLowerBound, improvesOn } from "@polypack/geometry";
import { msPerEval, rulesOf } from "./families";
import type { ProblemKey } from "./frontier";

/**
 * Record points (RP), design.md §5. For a verified improvement from s_prev to s_new:
 *
 *   RP = w · k · [ STEP_WEIGHT · (1 + log10(Δ / F)) + W_s ln(s_prev / s_new) + W_g ln(g_prev / g_new) ] · multiplier + bonus
 *
 * k is the cost factor, the ms an evaluation of the problem takes over the ms at N+M+P = 85, so that
 * a slow problem pays about as much per second of solver time as a fast one. With Δ = 1 − s_new /
 * s_prev, g = s / areaLowerBound − 1 and w = d(N) d(M). The multiplier (standing, collections, rules)
 * is game.ts's and applies to the bracket only.
 *
 * The bonus is flat, with no multiplier of any kind [SPEC, Michael 2026-11-01, replacing the tier
 * weights of 1, 3, 10 and 100, the double pay for beating a record, and the first-record bonus of 10]:
 *   FIRST_BONUS (1,000) for the first record on a problem that has none. That payment pays only the
 *     bonus: the cut from the starting score is not paid, later payments count from the first record.
 *   LEAD_BONUS (10,000) for the payment whose board passes a record held by another name, a
 *     published value or a research record, visibly at 6 decimals and by LEAD_MIN relative. That
 *     payment also pays the bracket for the margin past the record.
 * game.ts decides which bonus is due (once per problem per cycle) and passes it as `bonus`.
 *
 * Only improvements that count are paid: those `improvesOn` accepts, i.e. Δ > F with F = SCORE_TIE =
 * 1e-9 relative, exactly the improvements the server makes leader. Everything here is game-only
 * arithmetic on server-visible numbers.
 *
 * The size and gap terms telescope: over a run they add up to W_s ln(s₀/s₁) + W_g ln(g₀/g₁)
 * whatever path it takes, so they pay for how much smaller the board got. The step term is paid once
 * for each step that improves, and counts a tenth of what it did so that many tiny steps pay little:
 * a nibble pays 0.1 to about 0.7 points (it paid 1 to 6) [CALC].
 */

/** The floor F: the smallest relative improvement that counts, equal to the server's tie tolerance. */
export const FLOOR = SCORE_TIE;

/**
 * The tiers of a problem, categories for dealing, filters and the income table (design.md §6): open
 * problems (no entry yet), loose site records (clearly weaker than their neighbours in P), every
 * other site record without a published value, and problems with a best-known published value.
 * They no longer weigh the pay.
 */
export const TIERS = ["open", "loose", "batch", "published"] as const;
export type Tier = (typeof TIERS)[number];
export const isTier = (v: unknown): v is Tier => typeof v === "string" && (TIERS as readonly string[]).includes(v);

/** How the game names a tier to the player. */
export const TIER_LABEL: Record<Tier, string> = {
  open: "open problem",
  loose: "loose record",
  batch: "site record",
  published: "published value",
};

/**
 * Points per unit of ln(s_prev / s_new) and of ln(g_prev / g_new). One weight for both: on open
 * problems the gap term pays (1 + g) / g ≈ 4 to 11 times the size term for the same cut and carries
 * most of the ranking, and the published values' gaps (median 9.8 %, under 2 % for 1.9 % of them)
 * keep it from running away near the bound [CALC].
 */
export const SIZE_WEIGHT = 10_000;
export const GAP_WEIGHT = 10_000;
/** The gap g counts as at least this in the gap term, so a board at its bound does not pay without limit. */
export const G_MIN = 0.01;
/**
 * Record points the first cycle must earn before it can be reset [SPEC, Michael's ladder of 2026-10-26];
 * each later cycle needs 5 times the one before (standing.ts resetThreshold). Michael raised the first
 * reset 5x on 2026-10-27: at about a day of active play it came too early, and 5x restores roughly a week. It lives here so the
 * tree's texts can read it without importing standing.ts, which imports the tree.
 */
export const RESET_MIN = 1_000_000_000;
/** What each cycle's threshold is times the last one's. */
export const RESET_GROWTH = 5;
/** The weight of the step term, a tenth of what it was [SPEC, Michael 2026-11-01]. */
export const STEP_WEIGHT = 0.1;
/** The flat bonus for the first record on a problem that has none. */
export const FIRST_BONUS = 1_000;
/** The flat bonus for taking the lead on a problem that already has a record. */
export const LEAD_BONUS = 10_000;
/** The board must pass the record by at least this relative margin for the lead bonus. */
export const LEAD_MIN = 1e-6;
export type BonusKind = "first" | "lead";
export const BONUS_RP: Record<BonusKind, number> = { first: FIRST_BONUS, lead: LEAD_BONUS };
/** The cost model's reference: ms of one mc_compress evaluation at N+M+P = 85, where the factor is 1. */
export const REFERENCE_SIZE = 85;

/**
 * The cost factor k of a problem: the ms one of its game evaluations takes (a fixed table for
 * polygons, the kernel evaluations a space problem's game evaluation is, measured, for the others) over the ms at N+M+P =
 * 85. Not the player's measured speed, so the pay is the same on every machine. Expected RP per
 * second of solver time then runs about level from N+M+P = 85 up [CALC, scratchpad w6/model.py].
 */
export function costFactor(p: ProblemKey): number {
  return rulesOf(p).evalMs(p) / msPerEval(REFERENCE_SIZE);
}

/** Distinctness of a shape: 1 for circles and up to 20 sides, 20 / n for near-circular polygons. */
export function distinctness(n: number): number {
  return n === 0 || n <= 20 ? 1 : 20 / n;
}

/** Shape weight w = d(N) · d(M). */
export function shapeWeight(N: number, M: number): number {
  return distinctness(N) * distinctness(M);
}

export type PointsInput = ProblemKey & {
  /** A space problem's bound as the server gave it (ProblemState.bound); polygons compute theirs. */
  bound?: number | null;
  /** The leader's score before this improvement, or for a problem without one its free floor. */
  sPrev: number;
  /** The verified new score. */
  sNew: number;
  tier: Tier;
  /** The flat bonus this payment earns (game.ts decides, once per problem per cycle), if any. */
  bonus?: BonusKind | null;
};

export interface Points {
  /** Relative improvement Δ = 1 − s_new / s_prev. */
  delta: number;
  /** Decades of Δ above the floor: log10(Δ / F), never negative. */
  decades: number;
  w: number;
  /** The cost factor k (costFactor). */
  k: number;
  /** STEP_WEIGHT · (1 + decades). */
  nibble: number;
  size: number;
  gap: number;
  /** w · k · (nibble + size + gap), before the multiplier; 0 for a first record, which pays only its bonus. */
  improvement: number;
  /** The flat bonus kind paid with this improvement, and its RP (0 without). */
  bonus: BonusKind | null;
  bonusRp: number;
  /** improvement + bonusRp (game.ts applies the multiplier to the improvement only). */
  total: number;
}

/** Gap to the area bound, g = s / b − 1. */
export function gapOf(N: number, M: number, P: number, s: number): number {
  return s / areaLowerBound(N, M, P) - 1;
}

/** Six-decimal display of a score, as the site shows it. */
export const show6 = (s: number) => s.toFixed(6);

/**
 * The points of one improvement, or null when it does not count (not better than sPrev by more
 * than the floor, or not a finite positive score).
 */
export function recordPoints(input: PointsInput): Points | null {
  const { sPrev, sNew } = input;
  if (!(sNew > 0) || !(sPrev > 0) || !Number.isFinite(sNew) || !Number.isFinite(sPrev)) return null;
  if (!improvesOn(sNew, sPrev)) return null;
  const delta = 1 - sNew / sPrev;
  // improvesOn and Δ > F are the same test up to one rounding; never pay less than the floor's point
  const decades = Math.max(0, Math.log10(delta / FLOOR));
  const rules = rulesOf(input);
  const w = rules.weight(input);
  const nibble = STEP_WEIGHT * (1 + decades);
  const size = SIZE_WEIGHT * Math.log(sPrev / sNew);
  const bound = rules.bound(input);
  if (bound === null) throw new Error(`no bound for ${input.family}`);
  const gPrev = sPrev / bound - 1;
  const gNew = sNew / bound - 1;
  // g counts as at least G_MIN: a board at its bound (g near 0) would pay without limit, and a gap
  // at or below zero would make ln(g_prev / g_new) undefined
  const gap = GAP_WEIGHT * Math.log(Math.max(gPrev, G_MIN) / Math.max(gNew, G_MIN));
  const k = costFactor(input);
  const bonus = input.bonus ?? null;
  const bonusRp = bonus ? BONUS_RP[bonus] : 0;
  // a first record pays only its bonus: the cut from the starting score is not paid
  const improvement = bonus === "first" ? 0 : w * k * (nibble + size + gap);
  return { delta, decades, w, k, nibble, size, gap, improvement, bonus, bonusRp, total: improvement + bonusRp };
}

/** Records of one piece shape in one container shape (any sides, any piece count) that a combination needs to count for Collections. */
export const COMBO_RECORDS = 9;
