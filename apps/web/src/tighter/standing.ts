import type { ProblemKey } from "./frontier";
import type { EvolveMethod } from "./upgrades";

/**
 * Standing: the reset currency (plan §5). Owned by the economy work: resets, what they keep, the
 * standing gained, cycle rules and their rewards. This base holds the state and its defaults.
 */

export interface StandingState {
  /** Standing to spend on the Standing row. */
  points: number;
  /** Standing ever earned: each point adds 10 % to all record points, spent or not. */
  total: number;
  resets: number;
  /** Record points earned in this cycle (since the last reset). */
  cycleEarned: number;
  cycleStartedAt: number;
  /** The rule this cycle is played under, if any. */
  rule: string | null;
  /** Rules finished so far: their rewards hold for good. */
  rulesDone: string[];
}

export const newStanding = (now: number): StandingState => ({
  points: 0,
  total: 0,
  resets: 0,
  cycleEarned: 0,
  cycleStartedAt: now,
  rule: null,
  rulesDone: [],
});

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, fallback: number, min = 0) =>
  typeof v === "number" && Number.isFinite(v) && v >= min ? v : fallback;

export function normalizeStanding(v: unknown, now: number): StandingState {
  const d = newStanding(now);
  if (!isObj(v)) return d;
  return {
    points: num(v.points, 0),
    total: num(v.total, 0),
    resets: Number.isSafeInteger(v.resets) && (v.resets as number) >= 0 ? (v.resets as number) : 0,
    cycleEarned: num(v.cycleEarned, 0),
    cycleStartedAt: num(v.cycleStartedAt, now),
    rule: typeof v.rule === "string" ? v.rule.slice(0, 40) : null,
    rulesDone: Array.isArray(v.rulesDone)
      ? [...new Set(v.rulesDone.filter((r): r is string => typeof r === "string").map((r) => r.slice(0, 40)))].slice(
          0,
          50,
        )
      : [],
  };
}

/** The multiplier standing puts on every record point: 1 + 0.1 per point of standing ever earned. */
export const standingMultiplier = (s: StandingState): number => 1 + 0.1 * s.total;

/**
 * Whether the cycle's rule lets the dealer deal or offer this problem (circles only, small problems
 * only, ...). The dealer calls it on every candidate. Stub: every problem (the economy work fills it).
 */
export function ruleAllowsProblem(s: StandingState, p: ProblemKey): boolean {
  void s;
  void p;
  return true;
}

/** Whether the cycle's rule lets a run use this method (one method only, ...). Stub: every method. */
export function ruleAllowsMethod(s: StandingState, method: EvolveMethod): boolean {
  void s;
  void method;
  return true;
}
