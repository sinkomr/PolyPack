import { parseConfig } from "@polypack/geometry";
import type { PackingConfig } from "@polypack/geometry";
import { DealerState, creditOf, newDealer } from "./dealer";
import { isPolygon, keyOf, parseKey, poly } from "./frontier";
import {
  DEFAULT_PATIENCE,
  DEFAULT_TOLERANCE,
  GameState,
  LOG_LIMIT,
  Leader,
  PATIENCES,
  PAST_LIMIT,
  PastProblem,
  PendingSend,
  Phase,
  ProblemState,
  TOLERANCES,
  TRACE_LIMIT,
  newGame,
} from "./game";
import { sanitizeName } from "./names";
import { PacerState, newPacer } from "./pacer";
import { CONTEST, Tier } from "./points";
import type { RunRecord } from "./submission";
import { normalizeEconomy } from "./economy";
import { normalizePicks } from "./picks";
import { normalizeRunPlan } from "./runplan";
import { readLattice } from "./methods/lattice";
import { HEAD_STARTS, newStanding, normalizeStanding } from "./standing";
import {
  EvolveMethod,
  SWITCHES,
  UPGRADES,
  UpgradeId,
  currencyOf,
  evalsPerClick,
  isUpgradeId,
  methods,
  owning,
  rpCostFactor,
  upgrade,
} from "./upgrades";

/**
 * Every method of the tree the player can choose: a pipeline keeps its stages while a reset has taken
 * a method away, and drops a stage whose method is no longer selectable (methods/).
 */
const treeMethods = () => methods(owning(UPGRADES.map((u) => u.id)));

/**
 * Upgrades taken out of the tree, at their list price: a save that owns one gets the price back once
 * (the next save no longer owns it), and the page says so by the row's name, `group`.
 * - 2026-10-21: auto-eval's bank went, and with it the Away upgrades and Keep the bank; auto-eval
 *   runs only while the page is open.
 * - 2026-10-22: the Seeds row went (the Seed counter and Seeds: 2 to 32 per problem). Every run
 *   takes a random seed, and a problem allows any number of runs.
 */
const RETIRED = new Map<string, { cost: number; currency: "rp" | "standing"; group: string }>([
  ["away2", { cost: 1200, currency: "rp", group: "Away" }],
  ["away3", { cost: 12000, currency: "rp", group: "Away" }],
  ["away4", { cost: 42000, currency: "rp", group: "Away" }],
  ["away5", { cost: 250000, currency: "rp", group: "Away" }],
  ["away6", { cost: 1_500_000, currency: "rp", group: "Away" }],
  ["keepBank", { cost: 2, currency: "standing", group: "Away" }],
  ["seeds", { cost: 300, currency: "rp", group: "Seeds" }],
  ["seeds2", { cost: 2000, currency: "rp", group: "Seeds" }],
  ["seeds4", { cost: 7000, currency: "rp", group: "Seeds" }],
  ["seeds8", { cost: 28000, currency: "rp", group: "Seeds" }],
  ["seeds16", { cost: 75000, currency: "rp", group: "Seeds" }],
  ["seeds32", { cost: 400000, currency: "rp", group: "Seeds" }],
]);

/** What a save's retired upgrades pay back (RETIRED), and the rows they were in, in RETIRED's order. */
export interface RetiredRefund {
  rp: number;
  standing: number;
  groups: string[];
}

/**
 * The refund of the retired upgrades a save's `owned` list holds, each counted once. Their prices are
 * in the record points of their time: `scale` turns them into today's (pointsScale, for a save of
 * version 3 or older). Standing keeps its value.
 */
export function retiredRefund(owned: unknown, scale = 1): RetiredRefund {
  const out: RetiredRefund = { rp: 0, standing: 0, groups: [] };
  const ids = new Set(Array.isArray(owned) ? owned : []);
  for (const [id, r] of RETIRED)
    if (ids.has(id)) {
      out[r.currency] += r.currency === "rp" ? Math.round(r.cost * scale) : r.cost;
      if (!out.groups.includes(r.group)) out.groups.push(r.group);
    }
  return out;
}
/**
 * Levelled upgrades whose range shrank, with the old maximum and the old list price (level j + 1
 * cost `cost` × `growth`^j). Faster auto-eval had 100 levels at 150,000 RP × 1.4 a level while
 * auto-eval's rate was in clicks, and 3 at that price while it multiplied a rate in evaluations a
 * second by 1.3. Then it added one evaluation a second a level, 10 levels at 100,000 RP × 1.6 a
 * level, and now 10 a second a level, the same 10 levels at a tenth of that: a level kept is worth more.
 * Levels past the new maximum are refunded at the price they were bought at; none past the old
 * maximum could have been bought. A save loaded while the maximum was 3 kept 3 levels and had the
 * rest refunded then, so nothing is refunded twice: the levels a save still has are kept.
 */
const SHRUNK = new Map<UpgradeId, { max: number; cost: number; growth: number }>([
  ["autox", { max: 100, cost: 150_000, growth: 1.4 }],
]);

/**
 * Saves. The game lives in the browser: a versioned JSON document in localStorage, and the same
 * document as a save string for export and import ("tighter:" + version + ":" + encoding + ":" +
 * base64url). Loading is defensive: every field is checked, anything malformed falls back to its
 * default, and boards are parsed with the site's own parseConfig. A save from a newer version is
 * refused rather than read wrongly.
 *
 * Adding a field needs no new version (missing fields take their default). A change that would
 * misread old saves bumps SAVE_VERSION and adds a step to MIGRATIONS, and so does anything a save
 * must get exactly once (a refund): a page of an older version never writes over a newer save.
 */
export const SAVE_VERSION = 5;
export const STORAGE_KEY = "tighter.save";

/** Step k turns a save of version k into one of version k + 1. */
export type Migration = (save: Record<string, unknown>) => Record<string, unknown>;
export const MIGRATIONS: Record<number, Migration> = {
  /**
   * Version 1 ran a whole run per click (30 to 300 evaluations) and paid points on the server's
   * answer. Version 2 opens runs and steps them, and pays per click: what version 1 had verified is
   * paid, the rest pays from there. Its "Longer runs" upgrades become evaluations per click.
   */
  1: (save) => {
    const PER_RUN = 30;
    const evalsOld = isObj(save.stats) ? int(save.stats.evaluations, 0) : 0;
    const queue = (Array.isArray(save.queue) ? save.queue : []).map((q) => {
      if (!isObj(q)) return q;
      const trace = Array.isArray(q.trace) ? q.trace.filter((x): x is number => posOrNull(x) !== null) : [];
      return {
        ...q,
        trace: trace.map((v, i) => [i * PER_RUN, v]),
        sinceGain: int(q.deadRuns, 0) * PER_RUN,
        evaluations: int(q.runs, 0) * PER_RUN,
        paidTo: posOrNull(q.verified),
        unconfirmed: 0,
        sending: isObj(q.sending) ? { ...q.sending, rp: 0 } : null,
      };
    });
    const renamed: Record<string, string> = { evals1: "click2", evals2: "click3" };
    const owned = (Array.isArray(save.owned) ? save.owned : []).map((id) =>
      typeof id === "string" ? (renamed[id] ?? id) : id,
    );
    const dealer = isObj(save.dealer) ? { ...save.dealer, evalsAt: evalsOld } : save.dealer;
    const stats = isObj(save.stats) ? { ...save.stats, clicks: int(save.stats.runs, 0) } : save.stats;
    return { ...save, queue, owned, dealer, stats };
  },
  /**
   * Version 3 sells the Auto-eval upgrades at a tenth of their price. What a save owned when they
   * cost more is paid back once, in record points (autoPriceRefund); `autoRefund` tells the page.
   */
  2: (save) => {
    const ids = (Array.isArray(save.owned) ? save.owned : []).filter(isUpgradeId);
    const refund = autoPriceRefund(ids, savedLevels(save.levels));
    return { ...save, rp: num(save.rp, 0, 0) + refund, autoRefund: refund };
  },
  /**
   * Version 4 pays mostly for how much smaller a board gets (points.ts: the size and gap weights went
   * from 100 to 10,000), and every price went up with it (upgrades.ts). A save's record points are in
   * the old points, so each amount is multiplied by pointsScale, the new prices over the old of what
   * the save could buy next. Its bank then buys what it bought before, and its earnings, its records'
   * rent and the points still waiting for the server keep their place against the new prices.
   * Method match's arms learned what paid under the old points, so they start over. `pointsScale`
   * stays on the migrated save for the refunds read after it (retired upgrades, SHRUNK) and the page.
   */
  3: (save) => {
    const ids = (Array.isArray(save.owned) ? save.owned : []).filter(isUpgradeId);
    const f = pointsScale(ids, savedLevels(save.levels));
    const x = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v * f : v);
    const each = (list: unknown, scale: (q: Record<string, unknown>) => Record<string, unknown>) =>
      Array.isArray(list) ? list.map((q) => (isObj(q) ? scale(q) : q)) : list;
    const queue = each(save.queue, (q) => ({
      ...q,
      rp: x(q.rp),
      unconfirmed: x(q.unconfirmed),
      sending: isObj(q.sending) ? { ...q.sending, rp: x(q.sending.rp) } : q.sending,
    }));
    const past = each(save.past, (q) => ({ ...q, rp: x(q.rp) }));
    const st = isObj(save.standing) ? save.standing : null;
    const ec = isObj(save.economy) ? save.economy : null;
    const base: Record<string, unknown> = {};
    if (ec && isObj(ec.base)) for (const [k, v] of Object.entries(ec.base)) base[k] = x(v);
    return {
      ...save,
      rp: x(save.rp),
      rpEarned: x(save.rpEarned),
      queue,
      past,
      ...(st
        ? {
            standing: {
              ...st,
              cycleEarned: x(st.cycleEarned),
              history: each(st.history, (h) => ({ ...h, earned: x(h.earned) })),
            },
          }
        : {}),
      ...(ec
        ? {
            economy: {
              ...ec,
              base,
              rentPaid: x(ec.rentPaid),
              lastRent: isObj(ec.lastRent) ? { ...ec.lastRent, rp: x(ec.lastRent.rp) } : ec.lastRent,
            },
          }
        : {}),
      ...(isObj(save.runplan) ? { runplan: { ...save.runplan, bandit: {} } } : {}),
      ...(save.autoRefund !== undefined ? { autoRefund: x(save.autoRefund) } : {}),
      pointsScale: f,
    };
  },
  /**
   * Version 5 deals problems of other families, so every problem carries its `family` (all polygon
   * until now) and a space problem's `bound` (null for a polygon). Resets work differently too: a
   * save that has reset is rebalanced once. Its standing, history and rules are cleared, the Standing
   * row goes, and the record points its finished cycles earned, which the resets took, come back
   * (`rebalanced`, for the page's notice).
   */
  4: (save) => {
    const each = (list: unknown, add: Record<string, unknown>) =>
      Array.isArray(list) ? list.map((q) => (isObj(q) ? { family: "polygon", ...add, ...q } : q)) : list;
    const picks = isObj(save.picks) ? { ...save.picks, offers: each(save.picks.offers, {}) } : save.picks;
    const out: Record<string, unknown> = {
      ...save,
      queue: each(save.queue, { bound: null }),
      past: each(save.past, {}),
      ...(picks !== undefined ? { picks } : {}),
    };
    const st = isObj(save.standing) ? save.standing : null;
    if (!st || !(int(st.resets, 0) > 0)) return out;
    const back = (Array.isArray(st.history) ? st.history : []).reduce(
      (t: number, h) => t + (isObj(h) ? num(h.earned, 0, 0) : 0),
      0,
    );
    // the standing card and everything bought with standing
    const gone = (id: unknown) => id === "standing" || (isUpgradeId(id) && currencyOf(upgrade(id)) === "standing");
    const reset = newStanding(0);
    return {
      ...out,
      rp: num(save.rp, 0, 0) + back,
      owned: (Array.isArray(save.owned) ? save.owned : []).filter((id) => !gone(id)),
      levels: isObj(save.levels)
        ? Object.fromEntries(Object.entries(save.levels).filter(([id]) => !gone(id)))
        : save.levels,
      standing: {
        ...st,
        points: reset.points,
        total: reset.total,
        resets: reset.resets,
        history: reset.history,
        rule: reset.rule,
        nextRule: reset.nextRule,
        rulesDone: reset.rulesDone,
        marks: reset.marks,
      },
      rebalanced: back,
    };
  },
};

/** A save's levels of levelled upgrades, as the migrations read them: whole, at least 1, within range. */
function savedLevels(v: unknown): Partial<Record<UpgradeId, number>> {
  const levels: Partial<Record<UpgradeId, number>> = {};
  if (isObj(v))
    for (const [id, l] of Object.entries(v)) {
      const u = isUpgradeId(id) ? upgrade(id) : null;
      if (u?.levels && Number.isSafeInteger(l) && (l as number) >= 1)
        levels[id as UpgradeId] = Math.min(l as number, u.levels.max);
    }
  return levels;
}

/**
 * The list price of every record-point upgrade before version 4 (2026-10-22), when the size and gap
 * weights were 100. Levelled upgrades grew by the same factor a level then as now.
 */
const PRICE_BEFORE_V4: Partial<Record<UpgradeId, number>> = {
  trace: 5,
  click2: 150,
  auto1: 9,
  click3: 320,
  auto2: 35,
  click4: 500,
  click5: 780,
  auto3: 80,
  click6: 950,
  queue3: 1000,
  click7: 1100,
  click8: 1400,
  click9: 1550,
  sweeps10: 1600,
  click10: 1700,
  auto4: 135,
  clickx: 2000,
  auto5: 250,
  rank2: 3000,
  basin: 5000,
  reach2: 6000,
  auto6: 450,
  tuneMc: 8000,
  rank4: 9000,
  shrink: 10000,
  advance: 11000,
  pick3: 14000,
  penalty: 15000,
  lanes2: 18000,
  ring200: 20000,
  filters: 20000,
  tuneBasin: 20000,
  lattice: 21000,
  auto7: 900,
  rent: 25000,
  queue4: 25000,
  continuous: 26000,
  rank8: 30000,
  harden: 30000,
  tuneShrink: 30000,
  wide: 30000,
  collections: 35000,
  auto8: 1600,
  batch: 40000,
  tunePenalty: 40000,
  morph: 45000,
  retake: 45000,
  transfer: 50000,
  lanesx: 60000,
  rentx: 60000,
  ring120: 60000,
  asc: 60000,
  pick5: 70000,
  collector: 80000,
  tuneHarden: 80000,
  auto9: 2800,
  auto10: 4500,
  learning: 100_000,
  queue6: 120_000,
  growth: 120_000,
  autox: 10000,
  ring80: 150_000,
  tuneAsc: 150_000,
  methodMatch: 160_000,
  tuneGrowth: 300_000,
  ring50: 400_000,
  published: 500_000,
  standing: 750_000,
  ring30: 1_000_000,
  ringAll: 3_000_000,
};

/**
 * What a record point of a save from before version 4 is worth now: the new list prices over the old
 * of the upgrades it could buy next (the record-point upgrades it does not own whose prerequisites it
 * owns, and the next level of each levelled one it owns), so that its bank buys what it bought before.
 * A save that could buy nothing more takes the whole tree's ratio. Quick study discounts both prices
 * alike, so it leaves the ratio as it is.
 */
export function pointsScale(ids: readonly UpgradeId[], levels: Partial<Record<UpgradeId, number>>): number {
  const owned = new Set(ids);
  let now = 0;
  let before = 0;
  let allNow = 0;
  let allBefore = 0;
  for (const u of UPGRADES) {
    const old = PRICE_BEFORE_V4[u.id];
    if (currencyOf(u) !== "rp" || old === undefined) continue;
    allNow += u.cost;
    allBefore += old;
    // the level the save would buy next: the first for an upgrade it does not own
    const next = !owned.has(u.id) ? 0 : u.levels ? Math.max(1, levels[u.id] ?? 1) : null;
    if (next === null || (u.levels && next >= u.levels.max) || !u.requires.every((r) => owned.has(r))) continue;
    const g = u.levels ? Math.pow(u.levels.growth, next) : 1;
    now += u.cost * g;
    before += old * g;
  }
  return before > 0 ? now / before : allNow / allBefore;
}

/**
 * The lowest list price each Auto-eval rung had before version 3: what it cost from 2026-10-21
 * (it cost more before that). Faster auto-eval's level j + 1 had the lower of 100,000 × 1.6^j (from
 * 2026-10-21, 10 levels) and 150,000 × 1.4^j (before, 100 levels).
 */
const AUTO_BEFORE: Partial<Record<UpgradeId, number>> = {
  auto1: 90,
  auto2: 350,
  auto3: 800,
  auto4: 1350,
  auto5: 2500,
  auto6: 4500,
  auto7: 9000,
  auto8: 16000,
  auto9: 28000,
  auto10: 45000,
};
const autoxBefore = (j: number) => Math.min(100_000 * Math.pow(1.6, j), 150_000 * Math.pow(1.4, j));

/**
 * What a save gets back for auto-eval's lower prices: for each Auto-eval rung and each Faster
 * auto-eval level it owns, the price before (AUTO_BEFORE) less its price in version 3 (PRICE_BEFORE_V4),
 * at the save's Quick study discount, in the record points of version 3 (version 4's step scales
 * them). The rungs its head starts give it each cycle cost nothing, and get nothing back; Faster
 * auto-eval's levels past its 10 are SHRUNK's, refunded whole when the save is read. Never more
 * than the save paid: the prices before are the lowest they ever were, and Quick study only grows.
 */
export function autoPriceRefund(ids: readonly UpgradeId[], levels: Partial<Record<UpgradeId, number>>): number {
  const owned = new Set(ids);
  const free = new Set<UpgradeId>();
  const give = (id: UpgradeId) => {
    if (free.has(id)) return;
    free.add(id);
    for (const r of upgrade(id).requires) give(r);
  };
  for (const [h, list] of Object.entries(HEAD_STARTS)) if (owned.has(h as UpgradeId)) list?.forEach(give);
  let refund = 0;
  for (const [id, before] of Object.entries(AUTO_BEFORE) as [UpgradeId, number][])
    if (owned.has(id) && !free.has(id)) refund += Math.max(0, before - PRICE_BEFORE_V4[id]!);
  const x = upgrade("autox");
  if (owned.has("autox") && x.levels)
    for (let j = 0; j < Math.min(levels.autox ?? 0, x.levels.max); j++)
      refund += Math.max(0, autoxBefore(j) - PRICE_BEFORE_V4.autox! * Math.pow(x.levels.growth, j));
  return Math.round(refund * rpCostFactor(owning(ids, levels)));
}

/**
 * A save read; the factor its record points were multiplied by for version 4's points and prices
 * (none if it was already of version 4); the record points it was given back for auto-eval's lower
 * prices as it was read (none if it was already of version 3); and what its retired upgrades paid back
 * (none if it owned none). Every amount is in today's points.
 */
export type LoadResult =
  | {
      ok: true;
      state: GameState;
      rescaled?: number;
      refunded?: number;
      retired?: RetiredRefund;
      rebalanced?: { rp: number };
    }
  | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, fallback: number, min = -Infinity, max = Infinity): number =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : fallback;
const int = (v: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number =>
  Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max ? (v as number) : fallback;
const posOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
const str = (v: unknown, fallback: string, max = 200): string => (typeof v === "string" ? v.slice(0, max) : fallback);
const tier = (v: unknown): Tier => (typeof v === "string" && v in CONTEST ? (v as Tier) : "open");
const idOrNull = (v: unknown): number | null => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : null);

/** Runs the migrations from the save's version up to SAVE_VERSION. */
export function migrate(
  raw: Record<string, unknown>,
  migrations: Record<number, Migration> = MIGRATIONS,
  target = SAVE_VERSION,
): { ok: true; save: Record<string, unknown> } | { ok: false; error: string } {
  let save = raw;
  let version = save.version;
  if (!Number.isSafeInteger(version) || (version as number) < 1) return { ok: false, error: "not a Tighter save" };
  if ((version as number) > target)
    return { ok: false, error: `this save is from a newer version of Tighter (save format ${version})` };
  while ((version as number) < target) {
    const step = migrations[version as number];
    if (!step) return { ok: false, error: `no way to read save format ${version}` };
    save = step(save);
    version = (version as number) + 1;
    save = { ...save, version };
  }
  return { ok: true, save };
}

function board(v: unknown, key: string): PackingConfig | null {
  if (!isObj(v)) return null;
  const parsed = parseConfig(v);
  if (!parsed.ok) return null;
  const c = parsed.config;
  if (keyOf(poly(c.N, c.M, c.P)) !== key || c.pieces.length !== c.P) return null;
  return { N: c.N, M: c.M, P: c.P, pieces: c.pieces, container_phi: c.container_phi };
}

function runRecord(v: unknown): RunRecord | null {
  if (!isObj(v) || typeof v.method !== "string" || !/^[a-z_]+$/.test(v.method)) return null;
  if (!Number.isSafeInteger(v.seed) || (v.seed as number) < 0 || (v.seed as number) > 0xffffffff) return null;
  if (!isObj(v.budget) || !Number.isSafeInteger(v.budget.evals) || (v.budget.evals as number) < 1) return null;
  return {
    method: v.method,
    params: isObj(v.params) ? v.params : {},
    seed: v.seed as number,
    budget: { evals: v.budget.evals as number },
  };
}

function leader(v: unknown): Leader | null {
  if (!isObj(v) || posOrNull(v.score) === null) return null;
  return { score: v.score as number, name: str(v.name, "another name", 40), id: idOrNull(v.id) };
}

function pendingSend(v: unknown): PendingSend | null {
  if (!isObj(v) || posOrNull(v.score) === null || typeof v.name !== "string") return null;
  const name = sanitizeName(v.name);
  if (!name) return null;
  return {
    score: v.score as number,
    name,
    leaderBefore: leader(v.leaderBefore),
    at: num(v.at, 0),
    rp: num(v.rp, 0, 0),
  };
}

function problemState(v: unknown, now: number): ProblemState | null {
  if (!isObj(v)) return null;
  const k = parseKey(str(v.key, ""));
  if (!k) return null;
  if (isPolygon(k) ? k.N !== v.N || k.M !== v.M || k.P !== v.P : k.family !== v.family || k.P !== v.P) return null;
  const key = keyOf(k);
  let phase: Phase = v.phase === "loaded" || v.phase === "ready" ? v.phase : "bare";
  // a space problem's board is read once its package stores one: until then it starts bare
  const b = isPolygon(k) ? board(v.board, key) : null;
  const best = posOrNull(v.best);
  // a board that cannot be read takes the problem back to the start
  if (phase !== "bare" && (!b || best === null)) phase = "bare";
  const run = runRecord(v.run);
  if (phase === "ready" && !run && tier(v.tier) === "open") phase = "bare";
  const trace = Array.isArray(v.trace)
    ? v.trace
        .filter(
          (x): x is [number, number] =>
            Array.isArray(x) && x.length === 2 && Number.isSafeInteger(x[0]) && x[0] >= 0 && posOrNull(x[1]) !== null,
        )
        .map(([e, s]) => [e, s] as [number, number])
        .slice(-TRACE_LIMIT)
    : [];
  const refused =
    isObj(v.refused) && posOrNull(v.refused.score) !== null && Array.isArray(v.refused.reasons)
      ? { score: v.refused.score as number, reasons: v.refused.reasons.map(String).slice(0, 20) }
      : null;
  const rp = num(v.rp, 0, 0);
  const evaluations = int(v.evaluations, 0);
  // the RP paid here by evaluations; a save from before it was kept starts from what the problem has paid
  const rpTrace: [number, number][] = Array.isArray(v.rpTrace)
    ? v.rpTrace
        .filter(
          (x): x is [number, number] =>
            Array.isArray(x) &&
            x.length === 2 &&
            Number.isSafeInteger(x[0]) &&
            x[0] >= 0 &&
            typeof x[1] === "number" &&
            Number.isFinite(x[1]) &&
            x[1] >= 0,
        )
        .map(([e, r]) => [e, r] as [number, number])
        .slice(-TRACE_LIMIT)
    : rp > 0
      ? [[evaluations, rp]]
      : [];
  // the best at the last progress is never below the best; a save from before it was kept starts from the best
  const mark = posOrNull(v.progressBest);
  const progressBest = phase !== "ready" ? null : mark !== null && mark >= best! ? mark : best;
  return {
    ...k,
    key,
    tier: tier(v.tier),
    bound: isPolygon(k) ? null : posOrNull(v.bound),
    dealtAt: num(v.dealtAt, now),
    floor: posOrNull(v.floor),
    published: posOrNull(v.published),
    phase,
    board: phase === "bare" ? null : b,
    best: phase === "bare" ? null : best,
    run: phase === "bare" ? null : run,
    nextSeed: int(v.nextSeed, 1, 1, 0xffffffff),
    leader: leader(v.leader),
    verified: posOrNull(v.verified),
    ourId: idOrNull(v.ourId),
    beatPaid: bool(v.beatPaid, false),
    closed: bool(v.closed, false),
    refused,
    leaving: bool(v.leaving, false),
    sending: pendingSend(v.sending),
    paidTo: phase === "ready" ? posOrNull(v.paidTo) : null,
    unconfirmed: num(v.unconfirmed, 0, 0),
    trace: phase === "bare" ? [] : trace,
    rpTrace,
    evaluations,
    sinceGain: int(v.sinceGain, 0),
    progressBest,
    runs: int(v.runs, 0),
    endedRuns: int(v.endedRuns, 0),
    // a save from before the build was kept has none: each of its problems gets its one build
    lattice: phase === "bare" ? null : readLattice(v.lattice),
    lastRunAt: num(v.lastRunAt, 0),
    rp,
  };
}

function pastProblem(v: unknown, now: number): PastProblem | null {
  if (!isObj(v)) return null;
  const k = parseKey(str(v.key, ""));
  if (!k) return null;
  return {
    ...k,
    key: keyOf(k),
    tier: tier(v.tier),
    best: posOrNull(v.best),
    verified: posOrNull(v.verified),
    ourId: idOrNull(v.ourId),
    rp: num(v.rp, 0, 0),
    leftAt: num(v.leftAt, now),
  };
}

/**
 * The dealer, its work since the last refill in clicks. A save from when it counted evaluations
 * (`evalsAt`, the evaluations run at its last refill) has the evaluations since then counted as the
 * clicks they were then, at the save's click size `perClick`.
 */
function dealer(v: unknown, evaluations: number, perClick: number): DealerState {
  const d = newDealer(Math.floor(Math.random() * 0xffffffff));
  if (!isObj(v)) return d;
  const since = evaluations - Math.min(int(v.evalsAt, evaluations), evaluations);
  return {
    seed: int(v.seed, d.seed, 0, 0xffffffff),
    draws: int(v.draws, 0),
    dealt: int(v.dealt, 0),
    // in debt after a problem dealt on credit
    tokens: num(v.tokens, 1, -100, 100),
    credit: num(v.credit, 0, 0, 1e9) + creditOf(since, perClick),
  };
}

function pacer(v: unknown): PacerState {
  if (!isObj(v)) return newPacer();
  const last: Record<string, number> = {};
  if (isObj(v.lastByProblem))
    for (const [k, t] of Object.entries(v.lastByProblem))
      if (parseKey(k) && typeof t === "number" && Number.isFinite(t)) last[k] = t;
  return {
    sent: Array.isArray(v.sent)
      ? v.sent.filter((t): t is number => typeof t === "number" && Number.isFinite(t)).slice(-20)
      : [],
    lastByProblem: last,
    pausedUntil: num(v.pausedUntil, 0),
  };
}

/** A game state from a parsed save document of the current version, with every field checked. */
export function normalize(save: Record<string, unknown>, now: number): GameState {
  const g = newGame(now, 0);
  const settings = isObj(save.settings) ? save.settings : {};
  const stats = isObj(save.stats) ? save.stats : {};
  const queue: ProblemState[] = [];
  const keys = new Set<string>();
  for (const q of Array.isArray(save.queue) ? save.queue : []) {
    const p = problemState(q, now);
    if (p && !keys.has(p.key) && queue.length < 12) {
      queue.push(p);
      keys.add(p.key);
    }
  }
  const past: PastProblem[] = [];
  for (const q of Array.isArray(save.past) ? save.past.slice(-PAST_LIMIT) : []) {
    const p = pastProblem(q, now);
    if (p && !keys.has(p.key)) {
      past.push(p);
      keys.add(p.key);
    }
  }
  const owned = [...new Set(Array.isArray(save.owned) ? save.owned.filter(isUpgradeId) : [])];
  // Auto-eval's rungs keep their ids, each at its new rate (auto5 runs 10 evaluations a second). Faster
  // auto-eval came after auto9 and now comes after auto10: a save from before auto10 is given it.
  if (owned.includes("autox") && !owned.includes("auto10")) owned.splice(owned.indexOf("autox"), 0, "auto10");
  // a save migrated from version 3 or older: the old prices refunded below are in the points of their time
  const scale = num(save.pointsScale, 1, 0);
  const retired = retiredRefund(save.owned, scale);
  const refund = { rp: retired.rp, standing: retired.standing };
  // levels of levelled upgrades that are owned, within their range. Levels bought above a range that
  // shrank (SHRUNK) are refunded at the list price they were bought at, once: the save keeps only the range.
  const levels: Partial<Record<UpgradeId, number>> = {};
  if (isObj(save.levels))
    for (const [id, l] of Object.entries(save.levels)) {
      const u = isUpgradeId(id) && owned.includes(id) ? upgrade(id) : null;
      if (!u?.levels || !Number.isSafeInteger(l) || (l as number) < 1) continue;
      levels[id as UpgradeId] = Math.min(l as number, u.levels.max);
      const old = SHRUNK.get(id as UpgradeId);
      if (old)
        for (let j = u.levels.max; j < Math.min(l as number, old.max); j++)
          refund[currencyOf(u)] += Math.round(
            old.cost * Math.pow(old.growth, j) * (currencyOf(u) === "rp" ? scale : 1),
          );
    }
  const standing = normalizeStanding(save.standing, now);
  standing.points += refund.standing;
  const evaluations = int(stats.evaluations, 0);
  const allMethods = methods(owning(owned, levels));
  const method = allMethods.find((m) => m === settings.method) ?? "mc_compress";
  const focus =
    typeof save.focus === "string" && queue.some((p) => p.key === save.focus) ? save.focus : (queue[0]?.key ?? null);
  return {
    version: SAVE_VERSION,
    createdAt: num(save.createdAt, now),
    rp: num(save.rp, 0, 0) + refund.rp,
    rpEarned: num(save.rpEarned, 0, 0),
    owned,
    levels,
    // the name as the server stores it; no consent without one
    name: sanitizeName(str(save.name, "", 400)),
    consent: bool(save.consent, false) && sanitizeName(str(save.name, "", 400)) !== "",
    settings: {
      auto: bool(settings.auto, g.settings.auto),
      method: method as EvolveMethod,
      background: bool(settings.background, false),
      battery: bool(settings.battery, false),
      // one of the choices, else the default; a saved null is Never
      tolerance: TOLERANCES.find((t) => t === settings.tolerance) ?? DEFAULT_TOLERANCE,
      patience:
        settings.patience === null ? null : (PATIENCES.find((w) => w === settings.patience) ?? DEFAULT_PATIENCE),
      off: SWITCHES.filter((id) => Array.isArray(settings.off) && settings.off.includes(id)),
    },
    stats: {
      evaluations,
      clicks: int(stats.clicks, 0),
      runs: int(stats.runs, 0),
      computeMs: int(stats.computeMs, 0),
      submissions: int(stats.submissions, 0),
      firstRecords: int(stats.firstRecords, 0),
      verifiedImprovements: int(stats.verifiedImprovements, 0),
    },
    // auto-eval runs live: nothing is due from before the page was opened
    autoDue: 0,
    autoAt: now,
    dealer: dealer(save.dealer, evaluations, evalsPerClick(owning(owned, levels, standing.rule, standing.rulesDone))),
    pacer: pacer(save.pacer),
    queue,
    focus,
    past,
    reveal: Array.isArray(save.reveal)
      ? [...new Set(save.reveal.filter((r): r is string => typeof r === "string").slice(0, 50))]
      : [],
    log: Array.isArray(save.log)
      ? save.log
          .filter(
            (l): l is { t: number; text: string } => isObj(l) && typeof l.t === "number" && typeof l.text === "string",
          )
          .slice(-LOG_LIMIT)
          .map((l) => ({ t: l.t, text: l.text.slice(0, 300) }))
      : [],
    standing,
    economy: normalizeEconomy(save.economy),
    picks: normalizePicks(save.picks),
    runplan: normalizeRunPlan(save.runplan, treeMethods()),
  };
}

/** Reads a save document (already parsed from JSON). */
export function readSave(raw: unknown, now: number, migrations: Record<number, Migration> = MIGRATIONS): LoadResult {
  if (!isObj(raw)) return { ok: false, error: "not a Tighter save" };
  const m = migrate(raw, migrations);
  if (!m.ok) return m;
  const refunded = (raw.version as number) < 3 ? Math.round(num(m.save.autoRefund, 0, 0)) : 0;
  const rescaled = (raw.version as number) < 4 ? num(m.save.pointsScale, 0, 0) : 0;
  const retired = retiredRefund(m.save.owned, num(m.save.pointsScale, 1, 0));
  const rebalanced = (raw.version as number) < 5 && m.save.rebalanced !== undefined;
  return {
    ok: true,
    state: normalize(m.save, now),
    ...(rescaled > 0 ? { rescaled } : {}),
    ...(refunded > 0 ? { refunded } : {}),
    ...(retired.groups.length ? { retired } : {}),
    ...(rebalanced ? { rebalanced: { rp: Math.round(num(m.save.rebalanced, 0, 0)) } } : {}),
  };
}

export function toJson(state: GameState): string {
  return JSON.stringify({ ...state, version: SAVE_VERSION });
}

export function fromJson(text: string, now: number): LoadResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "the save is not valid JSON" };
  }
  return readSave(raw, now);
}

// ---------- save strings ----------

const PREFIX = "tighter";

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

const canCompress = () => typeof CompressionStream === "function" && typeof DecompressionStream === "function";

/** The save as one line of text: deflated where the browser can, plain JSON otherwise. */
export async function exportString(state: GameState): Promise<string> {
  const bytes = new TextEncoder().encode(toJson(state));
  if (canCompress())
    return `${PREFIX}:${SAVE_VERSION}:z:${toBase64Url(await pipe(bytes, new CompressionStream("deflate-raw")))}`;
  return `${PREFIX}:${SAVE_VERSION}:j:${toBase64Url(bytes)}`;
}

export async function importString(text: string, now: number): Promise<LoadResult> {
  const m = /^tighter:(\d+):([zj]):([A-Za-z0-9_-]+)$/.exec(text.trim().replace(/\s+/g, ""));
  if (!m) return { ok: false, error: "that is not a Tighter save string" };
  try {
    let bytes = fromBase64Url(m[3]);
    if (m[2] === "z") {
      if (!canCompress()) return { ok: false, error: "this browser cannot read compressed save strings" };
      bytes = await pipe(bytes, new DecompressionStream("deflate-raw"));
    }
    return fromJson(new TextDecoder().decode(bytes), now);
  } catch {
    return { ok: false, error: "the save string is damaged" };
  }
}
