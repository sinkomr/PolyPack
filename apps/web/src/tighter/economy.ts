import { FRONTIER_P, FRONTIER_SIDES, ProblemKey, parseKey } from "./frontier";
import type { GameState, PastProblem, ProblemState } from "./game";
import { ruleRewardFactor, standingMultiplier } from "./standing";
import { level } from "./upgrades";
import type { Owned } from "./upgrades";

/**
 * Records as an economy (plan §5).
 *
 * **Rent.** Every record the player still leads pays by the hour: 1 % of the record points that
 * problem earned (before multipliers), × 1.5 a level of Higher rent, × today's points multiplier
 * [SPEC]. Rent accrues between checks; a check (GET /api/problems) that finds the record still held
 * pays the rent since the last one, at most a week of it; a check or a live event that finds it lost
 * pays nothing for the unchecked time. The server says who leads, so rent needs no other trust.
 *
 * **Collections**, counted from records the server confirmed and kept through resets: every P of a
 * frontier pair (+2 % to all points each), 10, 30 and 100 records with one piece shape (+1 % each),
 * the first record in each tier (+5 % each).
 */

export interface EconomyState {
  /** Keys of every problem where the server confirmed a record of the player's (collections count these). */
  recorded: string[];
  /** Tiers with a confirmed record (tier firsts). */
  tiers: string[];
  /** Record points earned per problem before multipliers (rent is a share of it). */
  base: Record<string, number>;
  /** Per record held, while Rent is owned: when its rent was last settled by a check. */
  checks: Record<string, number>;
  /** Rent paid in all. */
  rentPaid: number;
  /** The last rent paid, for the panel. */
  lastRent: { key: string; rp: number; at: number } | null;
}

export const newEconomy = (): EconomyState => ({
  recorded: [],
  tiers: [],
  base: {},
  checks: {},
  rentPaid: 0,
  lastRent: null,
});

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isKey = (k: unknown): k is string => typeof k === "string" && /^\d+\/\d+\/\d+$/.test(k);

/** Most problems remembered as recorded. */
export const RECORDED_LIMIT = 20000;
export const TIERS = ["open", "loose", "batch", "published"] as const;

function numbers(v: unknown, limit: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObj(v)) return out;
  let n = 0;
  for (const [k, x] of Object.entries(v)) {
    if (n >= limit) break;
    if (isKey(k) && typeof x === "number" && Number.isFinite(x) && x >= 0) {
      out[k] = x;
      n++;
    }
  }
  return out;
}

export function normalizeEconomy(v: unknown): EconomyState {
  const d = newEconomy();
  if (!isObj(v)) return d;
  const last = isObj(v.lastRent) ? v.lastRent : null;
  return {
    recorded: Array.isArray(v.recorded) ? [...new Set(v.recorded.filter(isKey))].slice(-RECORDED_LIMIT) : [],
    tiers: Array.isArray(v.tiers)
      ? [...new Set(v.tiers.filter((t): t is string => typeof t === "string" && t.length <= 20))].slice(0, 20)
      : [],
    base: numbers(v.base, RECORDED_LIMIT),
    checks: numbers(v.checks, RECORDED_LIMIT),
    rentPaid: typeof v.rentPaid === "number" && Number.isFinite(v.rentPaid) && v.rentPaid >= 0 ? v.rentPaid : 0,
    lastRent:
      last && isKey(last.key) && typeof last.rp === "number" && last.rp >= 0 && typeof last.at === "number"
        ? { key: last.key, rp: last.rp, at: last.at }
        : null,
  };
}

// ---------- collections ----------

export interface Collections {
  /** Frontier pairs with a record on every frontier P. */
  pairs: number;
  /** The pairs closest to complete (not complete), most recorded first: up to three. */
  nearest: { N: number; M: number; have: number }[];
  /** Piece shapes with records, and the milestones (10, 30, 100) each has reached. */
  shapes: { N: number; count: number; milestones: number }[];
  milestones: number;
  /** Tiers with a first record. */
  tiers: string[];
  /** What it adds to all points (0.02 a pair, 0.01 a milestone, 0.05 a tier first). */
  bonus: number;
}

export const PAIR_BONUS = 0.02;
export const SHAPE_BONUS = 0.01;
export const TIER_BONUS = 0.05;
export const SHAPE_MILESTONES = [10, 30, 100] as const;
const FRONTIER_SIDE_SET = new Set<number>(FRONTIER_SIDES);
const FRONTIER_P_SET = new Set<number>(FRONTIER_P);

/** Collections are counted at every paid click: kept per list of records until it changes. */
const memo = new WeakMap<string[], { key: string; value: Collections }>();

/** The player's collections, from the records confirmed (whether or not Collections is owned). */
export function collections(e: EconomyState): Collections {
  const key = `${e.recorded.length}|${e.recorded.at(-1)}|${e.tiers.join(",")}`;
  const seen = memo.get(e.recorded);
  if (seen?.key === key) return seen.value;
  const pairs = new Map<string, { N: number; M: number; have: number }>();
  const shapes = new Map<number, number>();
  for (const k of e.recorded) {
    const p = parseKey(k);
    if (!p) continue;
    shapes.set(p.N, (shapes.get(p.N) ?? 0) + 1);
    if (FRONTIER_SIDE_SET.has(p.N) && FRONTIER_SIDE_SET.has(p.M) && FRONTIER_P_SET.has(p.P)) {
      const id = `${p.N}/${p.M}`;
      const pair = pairs.get(id) ?? { N: p.N, M: p.M, have: 0 };
      pair.have++;
      pairs.set(id, pair);
    }
  }
  const complete = [...pairs.values()].filter((x) => x.have >= FRONTIER_P.length).length;
  const nearest = [...pairs.values()]
    .filter((x) => x.have < FRONTIER_P.length)
    .sort((a, b) => b.have - a.have || a.N - b.N || a.M - b.M)
    .slice(0, 3);
  const shapeList = [...shapes.entries()]
    .map(([N, count]) => ({ N, count, milestones: SHAPE_MILESTONES.filter((m) => count >= m).length }))
    .sort((a, b) => b.count - a.count || a.N - b.N);
  const milestones = shapeList.reduce((t, x) => t + x.milestones, 0);
  const tiers = TIERS.filter((t) => e.tiers.includes(t));
  const value: Collections = {
    pairs: complete,
    nearest,
    shapes: shapeList,
    milestones,
    tiers,
    bonus: complete * PAIR_BONUS + milestones * SHAPE_BONUS + tiers.length * TIER_BONUS,
  };
  memo.set(e.recorded, { key, value });
  return value;
}

/** What collections add to all points: their bonus once Collections is owned, else nothing. */
export function collectionsBonus(s: GameState, o: Owned): number {
  return o.has("collections") ? collections(s.economy).bonus : 0;
}

/**
 * The multiplier on every point the problem pays (improvements and rent): standing × collections ×
 * the rewards of the rules finished that apply to it (and to the method that found it).
 */
export function pointsMultiplier(s: GameState, o: Owned, p: ProblemKey, method: string | null): number {
  return standingMultiplier(s.standing) * (1 + collectionsBonus(s, o)) * ruleRewardFactor(s.standing, p, method);
}

/**
 * The server confirmed a record of the player's on the problem: it counts for collections (and its
 * tier for tier firsts), and with Rent its rent starts now (or goes on, if it was already held).
 */
export function noteRecorded(s: GameState, o: Owned, p: ProblemState, now: number): void {
  const e = s.economy;
  if (!e.recorded.includes(p.key)) {
    e.recorded.push(p.key);
    if (e.recorded.length > RECORDED_LIMIT) e.recorded.splice(0, e.recorded.length - RECORDED_LIMIT);
  }
  if (!e.tiers.includes(p.tier)) e.tiers.push(p.tier);
  if (o.has("rent") && e.checks[p.key] === undefined) e.checks[p.key] = now;
}

/** A record of the player's was lost: no rent for it, and none for the time since its last check. */
export function forgetHeld(e: EconomyState, key: string): void {
  delete e.checks[key];
}

/** Points earned on a problem before multipliers (paid now). */
export function addBase(e: EconomyState, key: string, base: number): void {
  if (base > 0) e.base[key] = (e.base[key] ?? 0) + base;
}

/** Points taken back on a problem: its base falls in the same proportion as its points. */
export function takeBase(e: EconomyState, key: string, taken: number, rpBefore: number): void {
  const b = e.base[key];
  if (b === undefined || !(taken > 0)) return;
  e.base[key] = rpBefore > 0 ? Math.max(0, b * (1 - Math.min(1, taken / rpBefore))) : 0;
}

/**
 * Brings the economy up to a save made before it: every problem the server confirmed (queue and
 * past) counts as recorded, and a first cycle's earnings are all the points earned.
 */
export function syncEconomy(s: GameState): void {
  for (const p of [...s.past, ...s.queue]) {
    if (p.verified === null) continue;
    if (!s.economy.recorded.includes(p.key)) s.economy.recorded.push(p.key);
    if (!s.economy.tiers.includes(p.tier)) s.economy.tiers.push(p.tier);
  }
  if (s.standing.resets === 0 && s.standing.cycleEarned < s.rpEarned) s.standing.cycleEarned = s.rpEarned;
}

// ---------- rent ----------

/** Rent per hour: a share of what the record earned [SPEC]. */
export const RENT_SHARE = 0.01;
/** Each level of Higher rent multiplies rent by this. */
export const RENT_GROWTH = 1.5;
/** Rent paid at most for this long without a check. */
export const RENT_WINDOW_MS = 7 * 24 * 3_600_000;
/** At most one rent check this often. */
export const RENT_CHECK_MS = 10_000;
/** A record is checked again no sooner than this after its last check [SPEC]: few records, few requests. */
export const RENT_RECHECK_MS = 10 * 60_000;

type Held = ProblemState | PastProblem;

/** Records the player leads, as far as the game has seen: the queue's, then the past's. */
export function heldRecords(s: GameState): Held[] {
  return [...s.queue.filter((p) => p.ourId !== null), ...s.past.filter((p) => p.ourId !== null)];
}

const methodOf = (p: Held) => ("run" in p ? (p.run?.method ?? null) : null);

/** A record's rent per hour now (0 without Rent). */
export function rentPerHour(s: GameState, o: Owned, p: Held): number {
  if (!o.has("rent")) return 0;
  const m = pointsMultiplier(s, o, p, methodOf(p));
  // a record from before the base was kept: its points, as earned (multipliers were 1 then)
  const base = s.economy.base[p.key] ?? p.rp;
  return RENT_SHARE * base * Math.pow(RENT_GROWTH, level(o, "rentx")) * m;
}

/** Rent of every record held, per hour. */
export function rentRate(s: GameState, o: Owned): number {
  if (!o.has("rent")) return 0;
  return heldRecords(s).reduce((t, p) => t + rentPerHour(s, o, p), 0);
}

/** Rent accrued and not yet checked, across the records held (paid as each is checked). */
export function rentWaiting(s: GameState, o: Owned, now: number): number {
  if (!o.has("rent")) return 0;
  let t = 0;
  for (const p of heldRecords(s)) {
    const at = s.economy.checks[p.key];
    if (at === undefined) continue;
    t += (rentPerHour(s, o, p) * Math.min(RENT_WINDOW_MS, Math.max(0, now - at))) / 3_600_000;
  }
  return t;
}

/**
 * Starts the rent of records held that have none running (Rent just bought, or a record seen as
 * ours by a check), and forgets checks and bases of problems no longer held or in the queue.
 */
export function tidyRent(s: GameState, o: Owned, now: number): void {
  const e = s.economy;
  const held = new Set(heldRecords(s).map((p) => p.key));
  if (o.has("rent")) for (const k of held) if (e.checks[k] === undefined) e.checks[k] = now;
  for (const k of Object.keys(e.checks)) if (!held.has(k)) delete e.checks[k];
  const queued = new Set(s.queue.map((p) => p.key));
  for (const k of Object.keys(e.base)) if (!held.has(k) && !queued.has(k)) delete e.base[k];
}

/** The held record whose rent was checked longest ago, if that is at least RENT_RECHECK_MS ago. */
export function nextRentCheck(s: GameState, o: Owned, now: number): Held | null {
  if (!o.has("rent")) return null;
  let best: Held | null = null;
  let oldest = now - RENT_RECHECK_MS + 1;
  for (const p of heldRecords(s)) {
    const at = s.economy.checks[p.key];
    if (at !== undefined && at < oldest) {
      oldest = at;
      best = p;
    }
  }
  return best;
}

/**
 * A check found the record still the player's: pays its rent since the last check (at most a week)
 * and starts the next window. Returns the points paid (0 when it is not held, or without Rent).
 */
export function settleRent(s: GameState, o: Owned, p: Held, now: number): number {
  const e = s.economy;
  if (!o.has("rent") || p.ourId === null) return 0;
  const at = e.checks[p.key];
  e.checks[p.key] = now;
  if (at === undefined) return 0;
  const rp = (rentPerHour(s, o, p) * Math.min(RENT_WINDOW_MS, Math.max(0, now - at))) / 3_600_000;
  if (!(rp > 0)) return 0;
  s.rp += rp;
  s.rpEarned += rp;
  s.standing.cycleEarned += rp;
  e.rentPaid += rp;
  e.lastRent = { key: p.key, rp, at: now };
  return rp;
}
