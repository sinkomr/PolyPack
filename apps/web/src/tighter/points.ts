import { SCORE_TIE, areaLowerBound, improvesOn } from "@polypack/geometry";

/**
 * Record points (RP), design.md §5. For a verified improvement from s_prev to s_new:
 *
 *   RP = w · c · [ (1 + log10(Δ / F)) + 100 ln(s_prev / s_new) + 100 ln(g_prev / g_new) + bonus ]
 *
 * with Δ = 1 − s_new / s_prev, g = s / areaLowerBound − 1, w = d(N) d(M) and c the contest weight
 * of the problem's tier. Only improvements that count are paid: those `improvesOn` accepts, i.e.
 * Δ > F with F = SCORE_TIE = 1e-9 relative, exactly the improvements the server makes leader.
 * Everything here is game-only arithmetic on server-visible numbers.
 */

/** The floor F: the smallest relative improvement that counts, equal to the server's tie tolerance. */
export const FLOOR = SCORE_TIE;

/** Contest weight c of a tier (design.md §6). The MVP deals open frontier problems and loose records. */
export const CONTEST = { open: 1, loose: 3 } as const;
export type Tier = keyof typeof CONTEST;

/** Points per unit of ln(s_prev / s_new) and of ln(g_prev / g_new). */
export const SIZE_WEIGHT = 100;
export const GAP_WEIGHT = 100;
/** A first record whose gap beats the free floor's by at least 10 %. */
export const FIRST_RECORD_BONUS = 10;
export const FIRST_RECORD_GAP_RATIO = 0.9;
/** The first improvement visible at 6 decimals on a record held by another name (once per problem). */
export const BEAT_OTHER_BONUS = 5;

/** Distinctness of a shape: 1 for circles and up to 20 sides, 20 / n for near-circular polygons. */
export function distinctness(n: number): number {
  return n === 0 || n <= 20 ? 1 : 20 / n;
}

/** Shape weight w = d(N) · d(M). */
export function shapeWeight(N: number, M: number): number {
  return distinctness(N) * distinctness(M);
}

export interface PointsInput {
  N: number;
  M: number;
  P: number;
  /** The leader's score before this improvement, or for a problem without one its free floor. */
  sPrev: number;
  /** The verified new score. */
  sNew: number;
  tier: Tier;
  /** This is the problem's first record: it has no leader and sPrev is its free floor. */
  first?: boolean;
  /** sPrev is held by another name and the bonus for beating one has not been paid on this problem. */
  beatOther?: boolean;
}

export interface Points {
  /** Relative improvement Δ = 1 − s_new / s_prev. */
  delta: number;
  /** Decades of Δ above the floor: log10(Δ / F), never negative. */
  decades: number;
  w: number;
  c: number;
  nibble: number;
  size: number;
  gap: number;
  bonus: number;
  /** Which bonuses were paid. */
  firstBonus: boolean;
  beatBonus: boolean;
  /** w · c · (nibble + size + gap + bonus). */
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
  const { N, M, P, sPrev, sNew } = input;
  if (!(sNew > 0) || !(sPrev > 0) || !Number.isFinite(sNew) || !Number.isFinite(sPrev)) return null;
  if (!improvesOn(sNew, sPrev)) return null;
  const delta = 1 - sNew / sPrev;
  // improvesOn and Δ > F are the same test up to one rounding; never pay less than the floor's point
  const decades = Math.max(0, Math.log10(delta / FLOOR));
  const w = shapeWeight(N, M);
  const c = CONTEST[input.tier];
  const nibble = 1 + decades;
  const size = SIZE_WEIGHT * Math.log(sPrev / sNew);
  const gPrev = gapOf(N, M, P, sPrev);
  const gNew = gapOf(N, M, P, sNew);
  // A gap at or below zero cannot occur for the dealt problems (P >= 2 and gap > 0); guard anyway,
  // since ln(g_prev / g_new) would be undefined or infinite.
  const gap = gPrev > 0 && gNew > 0 ? GAP_WEIGHT * Math.log(gPrev / gNew) : 0;
  const firstBonus = !!input.first && gNew > 0 && gNew <= FIRST_RECORD_GAP_RATIO * gPrev;
  // "visible": the 6-decimal displays differ, so the change shows on the site
  const beatBonus = !!input.beatOther && show6(sNew) !== show6(sPrev);
  const bonus = (firstBonus ? FIRST_RECORD_BONUS : 0) + (beatBonus ? BEAT_OTHER_BONUS : 0);
  return {
    delta,
    decades,
    w,
    c,
    nibble,
    size,
    gap,
    bonus,
    firstBonus,
    beatBonus,
    total: w * c * (nibble + size + gap + bonus),
  };
}
