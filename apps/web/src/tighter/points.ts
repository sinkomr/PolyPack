import { SCORE_TIE, areaLowerBound, improvesOn } from "@polypack/geometry";
import { msPerEval, rulesOf } from "./families";
import type { ProblemKey } from "./frontier";

/**
 * Record points (RP), design.md §5. For a verified improvement from s_prev to s_new:
 *
 *   RP = w · c · k · [ (1 + log10(Δ / F)) + W_s ln(s_prev / s_new) + W_g ln(g_prev / g_new) + bonus ] · beat
 *
 * k is the cost factor, the ms an evaluation of the problem takes over the ms at N+M+P = 85, so that
 * a slow problem pays about as much per second of solver time as a fast one. `beat` is 2 for the
 * improvement while the board is past another name's record or a published value and the server has not yet made our entry the leader, and 1 otherwise.
 *
 * with Δ = 1 − s_new / s_prev, g = s / areaLowerBound − 1, w = d(N) d(M) and c the contest weight
 * of the problem's tier. Only improvements that count are paid: those `improvesOn` accepts, i.e.
 * Δ > F with F = SCORE_TIE = 1e-9 relative, exactly the improvements the server makes leader.
 * Everything here is game-only arithmetic on server-visible numbers.
 *
 * The size and gap terms telescope: over a run they add up to W_s ln(s₀/s₁) + W_g ln(g₀/g₁)
 * whatever path it takes, so they pay for how much smaller the board got. The step term is paid once
 * for each step that improves. With weights of 100 (until 2026-10-22) the step term was 80 to 99 % of
 * what methods earned, so points counted improving steps: mc_compress, which improves a hair on
 * almost every evaluation, out-earned methods that cut the side 10 to 60 times more. At 10,000 each,
 * the methods' points per evaluation rank as their side cuts do on the method reports' measured runs
 * (Spearman 0.99 at 40-evaluation jobs, 0.77 at 10-evaluation clicks), and a nibble still pays its
 * step term of 1 to about 6 points (methods-2026-10-22/economy.md) [CALC].
 */

/** The floor F: the smallest relative improvement that counts, equal to the server's tie tolerance. */
export const FLOOR = SCORE_TIE;

/**
 * Contest weight c of a tier (design.md §6, plan 2026-10-20 §3): open problems (no entry yet), loose
 * site records (clearly weaker than their neighbours in P), every other site record without a
 * published value, and problems with a best-known published value, which a record must beat.
 */
export const CONTEST = { open: 1, loose: 3, batch: 10, published: 100 } as const;
export type Tier = keyof typeof CONTEST;
export const TIERS = Object.keys(CONTEST) as Tier[];

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
/**
 * Record points the first cycle must earn before it can be reset [SPEC, Michael's ladder of 2026-10-26];
 * each later cycle needs 5 times the one before (standing.ts resetThreshold). Michael raised the first
 * reset 5x on 2026-10-27: at about a day of active play it came too early, and 5x restores roughly a week. It lives here so the
 * tree's texts can read it without importing standing.ts, which imports the tree.
 */
export const RESET_MIN = 1_000_000_000;
/** What each cycle's threshold is times the last one's. */
export const RESET_GROWTH = 5;
/** A first record whose gap beats the free floor's by at least 10 %. */
export const FIRST_RECORD_BONUS = 10;
export const FIRST_RECORD_GAP_RATIO = 0.9;
/**
 * What every improvement pays times from the moment the board is visibly (at 6 decimals) past a
 * record held by another name, or a published value, until the server makes our entry the leader
 * [SPEC, Michael 2026-10-27: beating a record should pay noticeably more than a first record, "not
 * insanely more"; the double pay lasts until the new record is accepted]. An additive bonus could
 * not do it: the terms it would add to are in the hundreds to thousands.
 */
export const BEAT_OTHER_FACTOR = 2;

/** The cost model's reference: ms of one mc_compress evaluation at N+M+P = 85, where the factor is 1. */
export const REFERENCE_SIZE = 85;

/**
 * The cost factor k of a problem: the ms one of its game evaluations takes (a fixed table for
 * polygons, 5 ms for the space problems, whose evaluations are sized to that) over the ms at N+M+P =
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
  /** This is the problem's first record: it has no leader and sPrev is its free floor. */
  first?: boolean;
  /** The board is past another name's record (or a published value) and our entry is not yet the leader: the payment is doubled. */
  beatOther?: boolean;
};

export interface Points {
  /** Relative improvement Δ = 1 − s_new / s_prev. */
  delta: number;
  /** Decades of Δ above the floor: log10(Δ / F), never negative. */
  decades: number;
  w: number;
  c: number;
  /** The cost factor k (costFactor). */
  k: number;
  /** BEAT_OTHER_FACTOR when this improvement is the paid beat of a record, else 1. */
  beat: number;
  nibble: number;
  size: number;
  gap: number;
  bonus: number;
  /** Which bonuses were paid. */
  firstBonus: boolean;
  beatBonus: boolean;
  /** w · c · k · (nibble + size + gap + bonus) · beat. */
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
  const c = CONTEST[input.tier];
  const nibble = 1 + decades;
  const size = SIZE_WEIGHT * Math.log(sPrev / sNew);
  const bound = rules.bound(input);
  if (bound === null) throw new Error(`no bound for ${input.family}`);
  const gPrev = sPrev / bound - 1;
  const gNew = sNew / bound - 1;
  // A gap at or below zero cannot occur for the dealt problems (P >= 2 and gap > 0); guard anyway,
  // since ln(g_prev / g_new) would be undefined or infinite.
  const gap = gPrev > 0 && gNew > 0 ? GAP_WEIGHT * Math.log(gPrev / gNew) : 0;
  const firstBonus = !!input.first && gNew > 0 && gNew <= FIRST_RECORD_GAP_RATIO * gPrev;
  // the caller says whether the board is visibly past another name's record (game.ts beating)
  const beatBonus = !!input.beatOther;
  const bonus = firstBonus ? FIRST_RECORD_BONUS : 0;
  const k = costFactor(input);
  const beat = beatBonus ? BEAT_OTHER_FACTOR : 1;
  return {
    delta,
    decades,
    w,
    c,
    k,
    beat,
    nibble,
    size,
    gap,
    bonus,
    firstBonus,
    beatBonus,
    total: w * c * k * (nibble + size + gap + bonus) * beat,
  };
}
