import { areaLowerBound, closedToSubmissions } from "@polypack/geometry";
import type { ProblemInfo } from "@polypack/geometry";
import type { RecordsResponse } from "../api";
import { ProblemKey, keyOf } from "./frontier";
import type { Tier } from "./points";
import type { UpgradeId } from "./upgrades";

/**
 * The dealer: which problem the player gets next, and how often (design.md §5, §6).
 *
 * New problems are earned by work, not time: each queue slot is dealt one problem per DEAL_CLICKS
 * clicks' worth of evaluations (at the evaluations a click does when they run), as a token bucket of
 * `slots` tokens. Clicking faster, or auto-eval, brings the next problem sooner. The rate also stands
 * in for a server-side limit on new problems per address. Every problem is checked with
 * GET /api/problems just before it is dealt.
 *
 * Pure apart from the random draws, which come from a seeded generator kept in the save, so a game
 * started with the same seed is dealt the same candidates.
 */
export const DEAL_CLICKS = 300;
/** A loose record is a site record of N, M <= 20 whose gap to the area bound is above this. */
export const LOOSE_GAP = 0.12;
/** Shapes of loose records: circles and 3 to 20 sides. */
export const LOOSE_SIDES: readonly number[] = [0, ...Array.from({ length: 18 }, (_, i) => i + 3)];

export interface DealerState {
  /** Seed of the dealer's draws. */
  seed: number;
  /** Draws made so far; draw k uses the k-th value of the sequence. */
  draws: number;
  /** Problems dealt so far. */
  dealt: number;
  /** Deal tokens; a deal takes one. */
  tokens: number;
  /** The player's evaluations run when `tokens` was last brought up to date. */
  evalsAt: number;
}

export const newDealer = (seed: number): DealerState => ({
  seed: seed >>> 0,
  draws: 0,
  dealt: 0,
  tokens: 1,
  evalsAt: 0,
});

/** Evaluations that earn one slot one problem: DEAL_CLICKS clicks of `perClick` evaluations. */
export const dealEvals = (perClick: number) => DEAL_CLICKS * Math.max(1, perClick);

/** mulberry32, the solver's generator (seededRandom), one value at a time. */
export function mulberry32(state: number): number {
  let t = (state + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** The next uniform value in [0, 1) of the dealer's sequence. */
export function nextRandom(d: DealerState): number {
  const value = mulberry32((d.seed + Math.imul(d.draws, 0x9e3779b1)) >>> 0);
  d.draws++;
  return value;
}

/**
 * Brings the tokens up to `evaluations` (the player's evaluations run): `slots` per
 * dealEvals(perClick) evaluations, at most `slots`.
 */
export function refill(d: DealerState, slots: number, evaluations: number, perClick: number): void {
  const run = Math.max(0, evaluations - d.evalsAt);
  d.tokens = Math.min(slots, d.tokens + (run * slots) / dealEvals(perClick));
  d.evalsAt = Math.max(d.evalsAt, evaluations);
}

export function canDeal(d: DealerState, slots: number, evaluations: number, perClick: number): boolean {
  refill(d, slots, evaluations, perClick);
  return d.tokens >= 1 - 1e-9;
}

/** Evaluations still to run before the next token (0 when one is there). */
export function evalsToNextDeal(d: DealerState, slots: number, evaluations: number, perClick: number): number {
  refill(d, slots, evaluations, perClick);
  if (d.tokens >= 1 - 1e-9) return 0;
  // less a hair, so that a rounding error in the bucket does not show one evaluation too many
  return Math.ceil(((1 - d.tokens) * dealEvals(perClick)) / slots - 1e-9);
}

/**
 * Takes one token for a problem dealt. A problem dealt without a token (the queue was empty, so the
 * player had nothing to work on) leaves the bucket in debt, repaid by the next evaluations.
 */
export function takeToken(d: DealerState): void {
  d.tokens -= 1;
  d.dealt++;
}

/**
 * The tier of the next deal. Before Reach: loose records, always the open frontier; after it, two
 * loose records for every open problem, as the design's model draws them.
 */
export function drawTier(d: DealerState, owned: ReadonlySet<UpgradeId>): Tier {
  if (!owned.has("reach2")) return "open";
  return nextRandom(d) < 2 / 3 ? "loose" : "open";
}

/** A random problem of `list` not in `exclude`, or null after `attempts` draws found none. */
export function drawProblem(
  d: DealerState,
  list: readonly ProblemKey[],
  exclude: ReadonlySet<string>,
  attempts = 24,
): ProblemKey | null {
  for (let i = 0; i < attempts; i++) {
    const p = list[Math.floor(nextRandom(d) * list.length)];
    if (p && !exclude.has(keyOf(p))) return p;
  }
  // The list is nearly used up: take the first one left, if any.
  return list.find((p) => !exclude.has(keyOf(p))) ?? null;
}

/**
 * Whether an open problem can be dealt, from GET /api/problems just before: it takes submissions,
 * has no site entry (someone may have taken it) and no published value.
 */
export function openDealable(info: ProblemInfo | null): boolean {
  return !!info && info.accepts_submissions && !info.site_best && !info.literature;
}

export interface LooseCandidate {
  P: number;
  score: number;
  gap: number;
  id: number;
  name: string;
}

/**
 * Loose records of one (N, M) from GET /api/records: site leaders with a gap above LOOSE_GAP,
 * not awaiting review, on problems without a published value and not already seen.
 */
export function looseCandidates(records: RecordsResponse, exclude: ReadonlySet<string>): LooseCandidate[] {
  const { N, M } = records;
  const published = new Set(records.literature.map((r) => r.P));
  const out: LooseCandidate[] = [];
  for (const e of records.site) {
    if (published.has(e.P) || e.verification === "pending" || e.P < 2) continue;
    if (exclude.has(keyOf({ N, M, P: e.P }))) continue;
    const gap = e.score / areaLowerBound(N, M, e.P) - 1;
    if (gap > LOOSE_GAP) out.push({ P: e.P, score: e.score, gap, id: e.id, name: e.name });
  }
  return out;
}

/** Whether a loose record is still the same open leader just before it is dealt. */
export function looseDealable(info: ProblemInfo | null, c: LooseCandidate): boolean {
  return (
    !!info &&
    info.accepts_submissions &&
    !closedToSubmissions(info.literature) &&
    !info.literature &&
    info.site_best?.id === c.id &&
    info.site_best.verification !== "pending"
  );
}

/** A random (N, M) pair of loose-record shapes. */
export function drawLoosePair(d: DealerState): { N: number; M: number } {
  const pick = () => LOOSE_SIDES[Math.floor(nextRandom(d) * LOOSE_SIDES.length)];
  const N = pick();
  return { N, M: pick() };
}
