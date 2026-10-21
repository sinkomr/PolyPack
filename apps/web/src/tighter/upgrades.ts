import { presetParams, tuningLevels } from "./presets";

/**
 * The tech tree. Progress is slow on purpose: a click is one evaluation of an open run at first, and
 * each upgrade adds a little. Evaluations per click climb one at a time; Auto-eval starts at one
 * evaluation every 5 s and is sped up step by step; methods come well after, one at a time, each
 * dearer than the last; seeds and method settings are bought too. Every finite ladder ends in a
 * levelled upgrade that can be bought again and again at a growing price, so nothing has a last rung.
 *
 * The whole tree shows in the shop. A mystery upgrade shows as ?????? until every prerequisite is
 * owned. Standing upgrades are paid in standing (the reset currency) and are kept through resets.
 *
 * Costs: the evaluations-per-click ladder is priced from a simulation of real runs (8 games of one
 * click a second, a new problem per 300 clicks' worth of evaluations; balance/stage1c.mts) at about
 * 85 % of the median points earned between Michael's targets: "2 per click" after about 100 clicks,
 * "3" about 150 clicks later, "4" 200 later, and so on (step n needs about 100·n(n+1)/2
 * evaluations) [CALC]. Everything else is extrapolated and waits for play-testing [SPEC]. The plan:
 * PolyPack-ideas/idle-games/tighter/plan-2026-10-20-long-game.md.
 *
 * The rest of the game reads what the player owns only through the functions below.
 */

export type EvolveMethod =
  "mc_compress" | "basin_hopping" | "shrink_repair" | "seed" | "penalty" | "harden" | "asc" | "morph" | "ls_growth";

export type UpgradeId =
  // clicks
  | "trace"
  | "click2"
  | "click3"
  | "click4"
  | "click5"
  | "click6"
  | "click7"
  | "click8"
  | "click9"
  | "click10"
  | "clickx"
  // auto-eval and away
  | "auto1"
  | "auto2"
  | "auto3"
  | "auto4"
  | "auto5"
  | "auto6"
  | "auto7"
  | "auto8"
  | "auto9"
  | "autox"
  | "away2"
  | "away3"
  | "away4"
  | "away5"
  | "away6"
  // seeds
  | "seeds"
  | "seeds2"
  | "seeds4"
  | "seeds8"
  | "seeds16"
  | "seeds32"
  // queue and lanes
  | "queue3"
  | "queue4"
  | "queue6"
  | "advance"
  | "lanes2"
  | "lanesx"
  | "continuous"
  // methods
  | "basin"
  | "shrink"
  | "penalty"
  | "lattice"
  | "harden"
  | "morph"
  | "asc"
  | "growth"
  // runs: method settings, method match, transfers
  | "sweeps10"
  | "tuneMc"
  | "tuneBasin"
  | "tuneShrink"
  | "tunePenalty"
  | "tuneHarden"
  | "tuneAsc"
  | "tuneGrowth"
  | "methodMatch"
  | "transfer"
  // problems: tiers, size rings, the wider frontier
  | "reach2"
  | "batch"
  | "published"
  | "ring200"
  | "ring120"
  | "ring80"
  | "ring50"
  | "ring30"
  | "ringAll"
  | "wide"
  // the dealer
  | "rank2"
  | "rank4"
  | "rank8"
  | "pick3"
  | "pick5"
  | "filters"
  | "learning"
  | "retake"
  | "collector"
  // records: rent, collections, standing
  | "rent"
  | "rentx"
  | "collections"
  | "standing"
  // standing (paid in standing, kept through resets)
  | "head1"
  | "head2"
  | "head3"
  | "keepBank"
  | "keepAuto"
  | "keepMethods"
  | "study"
  | "rules"
  | "pipeline"
  | "autoTune";

/** The shop's rows, in the order they are shown. */
export type Row =
  "clicks" | "auto" | "seeds" | "queue" | "methods" | "runs" | "problems" | "dealer" | "records" | "standing";

export const ROWS: readonly { id: Row; title: string }[] = [
  { id: "clicks", title: "Clicks" },
  { id: "auto", title: "Auto-eval and away" },
  { id: "seeds", title: "Seeds" },
  { id: "queue", title: "Queue and lanes" },
  { id: "methods", title: "Methods" },
  { id: "runs", title: "Runs" },
  { id: "problems", title: "Problems" },
  { id: "dealer", title: "Dealer" },
  { id: "records", title: "Records" },
  { id: "standing", title: "Standing" },
];

/** What an upgrade is paid in: record points, or standing (earned by resets). */
export type Currency = "rp" | "standing";

export interface Upgrade {
  id: UpgradeId;
  name: string;
  /** The price (of the first level, for a levelled upgrade). */
  cost: number;
  requires: UpgradeId[];
  /** What it does in the game. */
  effect: string;
  /** The real feature behind it. */
  real: string;
  row: Row;
  /** Shown as ?????? until every prerequisite is owned. */
  mystery?: boolean;
  /** Bought again and again: level L + 1 costs cost · growth^L, up to `max` levels. */
  levels?: { max: number; growth: number };
  /** Paid in record points (the default) or in standing. */
  currency?: Currency;
}

/** Levels bought of levelled upgrades (an owned levelled upgrade has level 1 or more). */
export type Levels = Readonly<Partial<Record<UpgradeId, number>>>;

/**
 * What the player owns: the upgrade ids, the levels of levelled ones, the cycle rule played under (a
 * standing rule can take something away, such as auto-eval or seeds), and the rules finished (whose
 * rewards hold for good).
 */
export type Owned = ReadonlySet<UpgradeId> & {
  readonly levels?: Levels;
  readonly rule?: string | null;
  readonly rewards?: readonly string[];
};

/** An Owned from ids, levels, the cycle's rule and the rules finished. */
export function owning(
  ids: Iterable<UpgradeId>,
  levels: Levels = {},
  rule: string | null = null,
  rewards: readonly string[] = [],
): Owned {
  const set = new Set(ids) as Set<UpgradeId> & {
    levels?: Levels;
    rule?: string | null;
    rewards?: readonly string[];
  };
  set.levels = levels;
  set.rule = rule;
  set.rewards = rewards;
  return set;
}

/** The level owned: for a levelled upgrade its level, otherwise 1 when owned and 0 when not. */
export function level(o: Owned, id: UpgradeId): number {
  if (!o.has(id)) return 0;
  return Math.max(1, o.levels?.[id] ?? 1);
}

/** Evaluations per click, by upgrade (1 without any). */
const CLICK: Partial<Record<UpgradeId, number>> = {
  click2: 2,
  click3: 3,
  click4: 4,
  click5: 5,
  click6: 6,
  click7: 7,
  click8: 8,
  click9: 9,
  click10: 10,
};
/** Auto-eval's evaluations per second, by upgrade. */
const AUTO: Partial<Record<UpgradeId, number>> = {
  auto1: 1 / 5,
  auto2: 1 / 4,
  auto3: 1 / 3,
  auto4: 1 / 2,
  auto5: 1,
  auto6: 2,
  auto7: 3,
  auto8: 5,
  auto9: 10,
};
/** Hours of auto-eval kept while the player is away, by upgrade (1 with Auto-eval I). */
const AWAY: Partial<Record<UpgradeId, number>> = { auto1: 1, away2: 4, away3: 12, away4: 24, away5: 72, away6: 168 };
/** Seeds (runs) per problem, by upgrade (1 without any). */
const SEEDS: Partial<Record<UpgradeId, number>> = { seeds2: 2, seeds4: 4, seeds8: 8, seeds16: 16, seeds32: 32 };
/** Problem slots, by upgrade (1 without any). */
const QUEUE: Partial<Record<UpgradeId, number>> = { queue3: 3, queue4: 4, queue6: 6 };
/** Methods in the order they unlock, by upgrade. */
const METHOD: Partial<Record<UpgradeId, EvolveMethod>> = {
  basin: "basin_hopping",
  shrink: "shrink_repair",
  penalty: "penalty",
  lattice: "seed",
  harden: "harden",
  morph: "morph",
  asc: "asc",
  growth: "ls_growth",
};
/** Tuning upgrades, by method. */
export const TUNING: Partial<Record<EvolveMethod, UpgradeId>> = {
  mc_compress: "tuneMc",
  basin_hopping: "tuneBasin",
  shrink_repair: "tuneShrink",
  penalty: "tunePenalty",
  harden: "tuneHarden",
  asc: "tuneAsc",
  ls_growth: "tuneGrowth",
};
/** Smallest N+M+P of the contested problems dealt, by upgrade (the size rings, largest first). */
const RING: Partial<Record<UpgradeId, number>> = {
  reach2: 300,
  ring200: 200,
  ring120: 120,
  ring80: 80,
  ring50: 50,
  ring30: 30,
  ringAll: 0,
};

const per = (n: number) => `${n} evaluation${n === 1 ? "" : "s"}`;
const every = (r: number) => (r < 1 ? `one evaluation every ${Math.round(1 / r)} s` : `${per(r)} a second`);
const hours = (h: number) => (h < 48 ? `${h} hour${h === 1 ? "" : "s"}` : h === 168 ? "a week" : `${h / 24} days`);

function clickRung(id: UpgradeId, cost: number, requires: UpgradeId[]): Upgrade {
  const n = CLICK[id]!;
  return {
    id,
    name: `${n} evaluations per click`,
    cost,
    requires,
    effect: `each Evolve click runs ${per(n)} of the open run`,
    real: `${per(n)} of the same run(), one after another`,
    row: "clicks",
  };
}

function autoRung(id: UpgradeId, cost: number, requires: UpgradeId[]): Upgrade {
  const r = AUTO[id]!;
  return {
    id,
    name: id === "auto1" ? "Auto-eval" : `Auto-eval: ${r < 1 ? `every ${Math.round(1 / r)} s` : `${r} a second`}`,
    cost,
    requires,
    effect:
      id === "auto1"
        ? `${every(r)} while it is on, beside your clicks; it keeps earning while you are away (up to 1 hour) and runs what it earned when you are back`
        : `auto-eval runs ${every(r)}`,
    real: "the same run(), one evaluation at a time",
    row: "auto",
  };
}

function awayRung(id: UpgradeId, cost: number, requires: UpgradeId[]): Upgrade {
  const h = AWAY[id]!;
  return {
    id,
    name: `Away: ${hours(h)}`,
    cost,
    requires,
    effect: `auto-eval keeps earning for up to ${hours(h)} while you are away`,
    real: "evaluations owed, run when you are back",
    row: "auto",
  };
}

function seedRung(id: UpgradeId, cost: number, requires: UpgradeId[]): Upgrade {
  const n = SEEDS[id]!;
  return {
    id,
    name: `Seeds: ${n} per problem`,
    cost,
    requires,
    effect:
      n === 2
        ? "when a run on a problem stops improving, a second run starts with a new seed"
        : `up to ${n} runs with new seeds on each problem`,
    real: "a new seed is a new attempt",
    row: "seeds",
  };
}

function methodRung(id: UpgradeId, cost: number, requires: UpgradeId[], effect: string, mystery = false): Upgrade {
  const m = METHOD[id]!;
  return { id, name: `Method: ${m}`, cost, requires, effect, real: m, row: "methods", mystery };
}

function tuneRung(id: UpgradeId, method: EvolveMethod, cost: number, requires: UpgradeId[], mystery = false): Upgrade {
  return {
    id,
    name: `${method} tuning`,
    cost,
    requires,
    effect: `each level gives ${method} a setting that searches more per evaluation (measured to pay at least as much per click)`,
    real: `${method}'s parameters: ${tuningSummary(method)}`,
    row: "runs",
    mystery,
    // as many levels as the method has presets that passed the bench (presets.ts)
    levels: { max: Math.max(1, tuningLevels(method)), growth: 3 },
  };
}

/** The settings a tuning upgrade's levels set, for its card: "sweepsPerEvaluation 15, 20, 30". */
function tuningSummary(method: EvolveMethod): string {
  const n = tuningLevels(method);
  const levels = Array.from({ length: n }, (_, i) => presetParams(method, i + 1, true));
  const keys = [...new Set(levels.flatMap((l) => Object.keys(l)))];
  return keys.map((k) => `${k} ${levels.map((l) => String(l[k] ?? "–")).join(", ")}`).join("; ");
}

function ringRung(id: UpgradeId, cost: number, requires: UpgradeId[], mystery = false): Upgrade {
  const min = RING[id]!;
  return {
    id,
    name: min === 0 ? "Problem sets: every size" : `Problem sets: N+M+P ≥ ${min}`,
    cost,
    requires,
    effect:
      min === 0
        ? "site records of every size: the smallest, densest and most contested problems, and the fastest to evaluate"
        : `site records down to ${min} in N+M+P: smaller, denser, more contested, and cheaper to evaluate`,
    real: "/api/records?N=&M=, by size",
    row: "problems",
    mystery,
  };
}

function standingRung(
  id: UpgradeId,
  name: string,
  cost: number,
  requires: UpgradeId[],
  effect: string,
  real: string,
  levels?: { max: number; growth: number },
): Upgrade {
  return { id, name, cost, requires, effect, real, row: "standing", mystery: true, currency: "standing", levels };
}

/** The tree, in an order where every prerequisite comes before the upgrades that need it. */
export const UPGRADES: readonly Upgrade[] = [
  {
    id: "trace",
    name: "Side-length trace",
    cost: 5,
    requires: [],
    effect: "every improvement on a trace of the side",
    real: "the Solve panel's trace",
    row: "clicks",
  },
  // ---- evaluations per click, about 100, 250, 450, 700, ... clicks in; a slow auto-eval early ----
  clickRung("click2", 150, ["trace"]),
  autoRung("auto1", 100, ["click2"]),
  clickRung("click3", 320, ["click2"]),
  {
    id: "seeds",
    name: "Seed counter",
    cost: 300,
    requires: ["auto1"],
    effect: "shows each run's seed and the seeds used on a problem; a seed is never repeated on a problem",
    real: "seed: uint32, mulberry32",
    row: "seeds",
  },
  autoRung("auto2", 400, ["auto1", "click3"]),
  clickRung("click4", 500, ["click3"]),
  clickRung("click5", 780, ["click4"]),
  autoRung("auto3", 900, ["auto2", "click4"]),
  clickRung("click6", 950, ["click5"]),
  {
    id: "queue3",
    name: "Problem queue: 3",
    cost: 1000,
    requires: ["click5"],
    effect: "3 problems at a time, each slot dealt a new one per 300 clicks' worth of evaluations",
    real: "GET /api/problems before each deal",
    row: "queue",
  },
  clickRung("click7", 1100, ["click6"]),
  awayRung("away2", 1200, ["auto2"]),
  clickRung("click8", 1400, ["click7"]),
  clickRung("click9", 1550, ["click8"]),
  {
    id: "sweeps10",
    name: "mc_compress: 10 sweeps per evaluation",
    cost: 1600,
    requires: ["click7"],
    effect: "each mc_compress evaluation follows 10 sweeps of moves instead of 5: more search per click",
    real: "sweepsPerEvaluation 10 (the solver's default)",
    row: "runs",
  },
  clickRung("click10", 1700, ["click9"]),
  autoRung("auto4", 1900, ["auto3"]),
  {
    id: "clickx",
    name: "One more evaluation per click",
    cost: 2000,
    requires: ["click10"],
    effect: "each level adds one evaluation to every click",
    real: "more evaluations of the same run()",
    row: "clicks",
    levels: { max: 990, growth: 1.25 },
  },
  seedRung("seeds2", 2000, ["seeds", "click7"]),
  autoRung("auto5", 2800, ["auto4"]),
  {
    id: "rank2",
    name: "Dealer: best of 2",
    cost: 3000,
    requires: ["queue3"],
    effect: "the dealer draws 2 problems and deals the one expected to pay more per evaluation",
    real: "a ranking by shape weight, contest weight, room and the cost of an evaluation",
    row: "dealer",
  },
  // ---- well after: methods, one at a time, each dearer than the last ----
  methodRung(
    "basin",
    5000,
    ["click10", "auto4"],
    "perturb-and-repair runs: big jumps past the compaction floor, then nibbles",
  ),
  {
    id: "reach2",
    name: "Reach: site records",
    cost: 6000,
    requires: ["basin"],
    effect:
      "deals site records with N, M ≤ 20 and at least 300 in N+M+P that are weaker than their neighbours, at 3× the points",
    real: "/api/records?N=&M=",
    row: "problems",
  },
  seedRung("seeds4", 7000, ["seeds2", "basin"]),
  autoRung("auto6", 8000, ["auto5", "basin"]),
  tuneRung("tuneMc", "mc_compress", 8000, ["sweeps10", "basin"]),
  {
    id: "rank4",
    name: "Dealer: best of 4",
    cost: 9000,
    requires: ["rank2", "reach2"],
    effect: "the dealer draws 4 problems and deals the best",
    real: "the same ranking over more candidates",
    row: "dealer",
  },
  methodRung("shrink", 10000, ["basin"], "shrink the container, then repair the overlaps: fast on dense boards"),
  {
    id: "advance",
    name: "Auto-advance",
    cost: 11000,
    requires: ["reach2", "queue3"],
    effect: "auto-eval compacts new problems and moves on when a problem stops paying",
    real: "an expected-gain rule over the queue",
    row: "queue",
  },
  awayRung("away3", 12000, ["away2", "auto5"]),
  {
    id: "pick3",
    name: "Your pick: 3",
    cost: 14000,
    requires: ["rank2", "advance"],
    effect: "3 problems are offered and you choose; with Auto-advance, a lane with nothing to do takes the best offer",
    real: "the ranked candidates, shown",
    row: "dealer",
  },
  methodRung("penalty", 15000, ["shrink"], "a soft-overlap squeeze with L-BFGS: steady nibbles near a plateau"),
  {
    id: "lanes2",
    name: "Second lane",
    cost: 18000,
    requires: ["advance"],
    effect: "a second solver worker: auto-eval runs on two problems at once",
    real: "2 Web Workers",
    row: "queue",
  },
  ringRung("ring200", 20000, ["reach2", "rank4"]),
  {
    id: "filters",
    name: "Dealer filters",
    cost: 20000,
    requires: ["pick3"],
    effect: "choose the piece shapes, containers, piece counts and tiers the dealer draws from",
    real: "filters on the candidates",
    row: "dealer",
  },
  tuneRung("tuneBasin", "basin_hopping", 20000, ["basin", "tuneMc"]),
  methodRung("lattice", 21000, ["penalty"], "lattice and symmetric starts: a new board from scratch, often a jump"),
  autoRung("auto7", 24000, ["auto6", "lanes2"]),
  {
    id: "rent",
    name: "Records pay rent",
    cost: 25000,
    requires: ["advance"],
    effect: "every record you still lead pays by the hour, 1 % of what it earned, for as long as it stands",
    real: "GET /api/problems: the server says who leads",
    row: "records",
  },
  {
    id: "queue4",
    name: "Problem queue: 4",
    cost: 25000,
    requires: ["advance", "lanes2"],
    effect: "4 problems at a time",
    real: "GET /api/problems before each deal",
    row: "queue",
  },
  {
    id: "continuous",
    name: "Continuous",
    cost: 26000,
    requires: ["lanes2"],
    effect: "allows running while this tab is hidden (a setting, off until you tick it); without it a hidden tab banks",
    real: "Web Workers keep running in a background tab",
    row: "queue",
  },
  seedRung("seeds8", 28000, ["seeds4", "lattice"]),
  {
    id: "rank8",
    name: "Dealer: best of 8",
    cost: 30000,
    requires: ["rank4", "ring200"],
    effect: "the dealer draws 8 problems and deals the best",
    real: "the same ranking over more candidates",
    row: "dealer",
  },
  methodRung("harden", 30000, ["lattice"], "soft-to-rigid: momentum steps that harden a soft packing", true),
  tuneRung("tuneShrink", "shrink_repair", 30000, ["shrink", "tuneMc"]),
  {
    id: "wide",
    name: "Wider frontier",
    cost: 30000,
    requires: ["queue4"],
    effect: "open problems with every side from 21 to 100 and up to 500 pieces",
    real: "problems with no entry yet",
    row: "problems",
  },
  {
    id: "collections",
    name: "Collections",
    cost: 35000,
    requires: ["queue3", "reach2"],
    effect:
      "completed sets of records (every P of a frontier pair, piece shapes, tier firsts) each add to all points, for good",
    real: "records the server confirmed",
    row: "records",
  },
  autoRung("auto8", 38000, ["auto7"]),
  {
    id: "batch",
    name: "Reach: every site record",
    cost: 40000,
    requires: ["ring200"],
    effect: "site records at any gap, not only the weak ones, at 10× the points",
    real: "/api/records?N=&M=",
    row: "problems",
  },
  tuneRung("tunePenalty", "penalty", 40000, ["penalty", "tuneMc"]),
  awayRung("away4", 42000, ["away3", "auto7"]),
  methodRung(
    "morph",
    45000,
    ["harden"],
    "morph the pieces' shapes and back: a different road through the same basin",
    true,
  ),
  {
    id: "retake",
    name: "Retake",
    cost: 45000,
    requires: ["rent"],
    effect: "a record you lost is offered again first, starting from the new leader's packing",
    real: "the live feed (/api/events) and GET /api/problems",
    row: "dealer",
  },
  {
    id: "transfer",
    name: "Transfers",
    cost: 50000,
    requires: ["lattice", "wide"],
    effect: "a new problem starts from the best packing of a neighbour with fewer pieces, the rest placed in the gaps",
    real: "a known packing plus findFreeSpot",
    row: "runs",
    mystery: true,
  },
  {
    id: "lanesx",
    name: "Another lane",
    cost: 60000,
    requires: ["lanes2", "continuous"],
    effect: "each level adds a solver worker, up to your CPU's cores less one",
    real: "Web Workers, one per core",
    row: "queue",
    levels: { max: 31, growth: 2.2 },
  },
  {
    id: "rentx",
    name: "Higher rent",
    cost: 60000,
    requires: ["rent"],
    effect: "each level adds half again to the rent your records pay",
    real: "the same records, held longer",
    row: "records",
    levels: { max: 50, growth: 1.6 },
  },
  ringRung("ring120", 60000, ["ring200", "batch"]),
  methodRung("asc", 60000, ["morph"], "active-set contact descent: slow evaluations, deep improvements", true),
  {
    id: "pick5",
    name: "Your pick: 5",
    cost: 70000,
    requires: ["pick3", "rank8"],
    effect: "5 problems are offered",
    real: "the ranked candidates, shown",
    row: "dealer",
  },
  seedRung("seeds16", 75000, ["seeds8", "asc"]),
  {
    id: "collector",
    name: "Collector",
    cost: 80000,
    requires: ["collections", "pick3"],
    effect: "one deal in three fills your nearest-to-complete collection",
    real: "the dealer aims at your sets",
    row: "dealer",
    mystery: true,
  },
  tuneRung("tuneHarden", "harden", 80000, ["harden"], true),
  autoRung("auto9", 90000, ["auto8", "asc"]),
  {
    id: "learning",
    name: "Learning dealer",
    cost: 100000,
    requires: ["rank8", "collections"],
    effect: "the dealer learns which kinds of problem pay you most per evaluation, and deals more of them",
    real: "Thompson sampling, a multi-armed bandit, over your own results",
    row: "dealer",
    mystery: true,
  },
  {
    id: "queue6",
    name: "Problem queue: 6",
    cost: 120000,
    requires: ["queue4", "collections"],
    effect: "6 problems at a time",
    real: "GET /api/problems before each deal",
    row: "queue",
  },
  methodRung("growth", 120000, ["asc"], "lattice-strip growth: the strongest and slowest search", true),
  {
    id: "autox",
    name: "Faster auto-eval",
    cost: 150000,
    requires: ["auto9"],
    effect: "each level makes auto-eval a quarter faster",
    real: "the same run(), more evaluations a second, up to what the CPU can do",
    row: "auto",
    levels: { max: 100, growth: 1.4 },
  },
  ringRung("ring80", 150000, ["ring120"], true),
  tuneRung("tuneAsc", "asc", 150000, ["asc"], true),
  {
    id: "methodMatch",
    name: "Method match",
    cost: 160000,
    requires: ["learning", "shrink"],
    effect: "the game picks the method for each run from what has paid on problems like it",
    real: "a bandit over methods, per kind of problem",
    row: "runs",
    mystery: true,
  },
  awayRung("away5", 250000, ["away4", "rent"]),
  tuneRung("tuneGrowth", "ls_growth", 300000, ["growth"], true),
  ringRung("ring50", 400000, ["ring80"], true),
  seedRung("seeds32", 400000, ["seeds16", "growth"]),
  {
    id: "published",
    name: "Reach: published values",
    cost: 500000,
    requires: ["batch", "ring120"],
    effect: "problems with a value published in the literature, at 100× the points; beating one goes to review",
    real: "the site's literature table",
    row: "problems",
    mystery: true,
  },
  {
    id: "standing",
    name: "Standing",
    cost: 750000,
    requires: ["collections", "rent", "ring120"],
    effect:
      "reset the tree for standing: every point of standing adds 10 % to all points for good, and buys what no record point can",
    real: "your records stay on the server; only the game's tree starts again",
    row: "records",
    mystery: true,
  },
  ringRung("ring30", 1_000_000, ["ring50"], true),
  awayRung("away6", 1_500_000, ["away5"]),
  ringRung("ringAll", 3_000_000, ["ring30"], true),
  // ---- standing: paid in standing, kept through resets ----
  standingRung(
    "head1",
    "Head start I",
    1,
    ["standing"],
    "each new cycle begins with 2 to 5 evaluations per click and Auto-eval",
    "the first upgrades, owned at once",
  ),
  standingRung(
    "keepBank",
    "Keep the bank",
    2,
    ["standing"],
    "auto-eval's bank survives a reset",
    "evaluations owed stay owed",
  ),
  standingRung(
    "head2",
    "Head start II",
    3,
    ["head1"],
    "each new cycle also begins with the queue of 3, 2 seeds, auto-eval at 1 a second and Basin hopping",
    "more of the tree, owned at once",
  ),
  standingRung(
    "rules",
    "Cycle rules",
    3,
    ["standing"],
    "before a reset, choose a rule for the next cycle; finishing a cycle under it gives a reward of its own, for good",
    "the community's compute aimed at one family of problems",
  ),
  standingRung(
    "pipeline",
    "Pipelines",
    4,
    ["standing"],
    "order your methods: each new seed on a problem runs the next one",
    "runPipeline's stages, as successive runs",
  ),
  standingRung(
    "keepAuto",
    "Keep auto-eval",
    5,
    ["head1"],
    "the Auto-eval and away upgrades survive resets",
    "the same workers, kept",
  ),
  standingRung(
    "autoTune",
    "Auto-tune",
    6,
    ["standing"],
    "the game tries the methods and settings you own on each kind of problem and keeps what pays",
    "a bandit over methods and their settings",
  ),
  standingRung(
    "head3",
    "Head start III",
    8,
    ["head2"],
    "each new cycle also begins with Auto-advance, the second lane and Reach: site records",
    "more of the tree, owned at once",
  ),
  standingRung(
    "keepMethods",
    "Keep methods",
    10,
    ["keepAuto"],
    "the methods you own survive resets",
    "the same methods, kept",
  ),
  standingRung(
    "study",
    "Quick study",
    2,
    ["standing"],
    "each level makes every record-point price a tenth cheaper",
    "the same tree, climbed faster",
    { max: 10, growth: 1.6 },
  ),
];

const BY_ID = new Map(UPGRADES.map((u) => [u.id, u]));

export function upgrade(id: UpgradeId): Upgrade {
  return BY_ID.get(id)!;
}

export const isUpgradeId = (id: unknown): id is UpgradeId => typeof id === "string" && BY_ID.has(id as UpgradeId);

export const currencyOf = (u: Upgrade): Currency => u.currency ?? "rp";

/** Record-point prices after Quick study (0.9 a level). */
export function rpCostFactor(o: Owned): number {
  return Math.pow(0.9, level(o, "study"));
}

/** The price of the next level (or of the upgrade), or null when it is owned to its last level. */
export function costOf(o: Owned, id: UpgradeId): number | null {
  const u = BY_ID.get(id);
  if (!u) return null;
  const l = level(o, id);
  if (u.levels ? l >= u.levels.max : l > 0) return null;
  const base = u.levels ? u.cost * Math.pow(u.levels.growth, l) : u.cost;
  return currencyOf(u) === "rp" ? Math.round(base * rpCostFactor(o)) : Math.round(base);
}

/** Whether the upgrade shows as itself in the shop: not a mystery, or every prerequisite owned. */
export function isRevealed(o: Owned, id: UpgradeId): boolean {
  const u = BY_ID.get(id);
  return !!u && (!u.mystery || u.requires.every((r) => o.has(r)));
}

/** Upgrades that can be bought next (prerequisites owned, a level left): the shop's open cards. */
export function available(o: Owned): Upgrade[] {
  return UPGRADES.filter((u) => costOf(o, u.id) !== null && u.requires.every((r) => o.has(r)));
}

/** What the player can pay with. */
export interface Funds {
  rp: number;
  standing: number;
}

export type BuyCheck = { ok: true } | { ok: false; reason: "owned" | "locked" | "points" };

export function canBuy(o: Owned, funds: Funds | number, id: UpgradeId): BuyCheck {
  const u = BY_ID.get(id);
  if (!u) return { ok: false, reason: "locked" };
  const cost = costOf(o, id);
  if (cost === null) return { ok: false, reason: "owned" };
  if (!u.requires.every((r) => o.has(r))) return { ok: false, reason: "locked" };
  const f = typeof funds === "number" ? { rp: funds, standing: 0 } : funds;
  const have = currencyOf(u) === "rp" ? f.rp : f.standing;
  // A tiny tolerance so that 4.9999999999 RP after floating sums still buys a 5 RP card.
  if (have + 1e-9 < cost) return { ok: false, reason: "points" };
  return { ok: true };
}

/** How a card shows in the shop. */
export type CardState = "owned" | "buyable" | "dear" | "locked" | "mystery";

export function cardState(o: Owned, funds: Funds, id: UpgradeId): CardState {
  // owned comes first: after a reset an upgrade may be kept while its prerequisites are not
  if (o.has(id) && costOf(o, id) === null) return "owned";
  if (!o.has(id) && !isRevealed(o, id)) return "mystery";
  const c = canBuy(o, funds, id);
  if (c.ok) return "buyable";
  return c.reason === "owned" ? "owned" : c.reason === "locked" ? "locked" : "dear";
}

// ---------- what the player owns, as game parameters ----------

const highest = <T>(o: Owned, table: Partial<Record<UpgradeId, T>>, base: T, better: (a: T, b: T) => boolean): T => {
  let v = base;
  for (const [id, x] of Object.entries(table) as [UpgradeId, T][]) if (o.has(id) && better(x, v)) v = x;
  return v;
};

/** Evaluations of one Evolve click (one more for good after a cycle played under "clicks only"). */
export function evalsPerClick(o: Owned): number {
  return highest(o, CLICK, 1, (a, b) => a > b) + level(o, "clickx") + (o.rewards?.includes("clicks") ? 1 : 0);
}

/** Evaluations of Compact: one press that compacts the Load-all board (design §3). */
export const COMPACT_EVALS = 100;

/** Evaluations a run may do in all before it ends and the next seed takes over. */
export const RUN_BUDGET = 100_000;

/** Auto-eval's evaluations per second (per lane), or null without it. */
export function autoPerSecond(o: Owned): number | null {
  // the "clicks only" cycle rule: no auto-eval in this cycle
  if (!o.has("auto1") || o.rule === "clicks") return null;
  return highest(o, AUTO, 0, (a, b) => a > b) * Math.pow(1.25, level(o, "autox"));
}

/** Hours of auto-eval earned while away, at most. */
export function awayHours(o: Owned): number {
  return highest(o, AWAY, 0, (a, b) => a > b);
}

/** Most evaluations auto-eval's bank holds: its rate over the hours kept while away (at least one). */
export function bankCap(o: Owned, lanes = 1): number {
  return Math.max(1, (autoPerSecond(o) ?? 0) * lanes * awayHours(o) * 3600);
}

/** Seeds per problem: one under the "one seed" cycle rule, twice as many for good once a cycle finished under it. */
export function seedsPerProblem(o: Owned): number {
  if (o.rule === "seed") return 1;
  return highest(o, SEEDS, 1, (a, b) => a > b) * (o.rewards?.includes("seed") ? 2 : 1);
}

/** The methods the player may run, mc_compress first, then in the order they unlock. */
export function methods(o: Owned): EvolveMethod[] {
  return ["mc_compress", ...UPGRADES.filter((u) => o.has(u.id) && METHOD[u.id]).map((u) => METHOD[u.id]!)];
}

/** The tuning level owned for a method (0 to 3). */
export function tuningLevel(o: Owned, method: EvolveMethod): number {
  const id = TUNING[method];
  return id ? level(o, id) : 0;
}

/**
 * The method's parameters as the player's upgrades set them: the preset of its tuning level (the
 * owned level, or a lower one that Auto-tune chose), the solver's defaults otherwise.
 */
export function methodParams(o: Owned, method: EvolveMethod, tuning?: number): Record<string, unknown> {
  const owned = tuningLevel(o, method);
  const l = tuning === undefined ? owned : Math.max(0, Math.min(owned, tuning));
  return presetParams(method, l, o.has("sweeps10"));
}

/** CPU cores the browser reports (4 when it does not say). */
export function cores(): number {
  const n = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency;
  return Number.isSafeInteger(n) && n! > 0 ? n! : 4;
}

/** Solver workers: one, two with the second lane, one more a level of Another lane, at most the cores less one (at least 2). */
export function laneCount(o: Owned, coreCount = cores()): number {
  if (!o.has("lanes2")) return 1;
  return Math.min(2 + level(o, "lanesx"), Math.max(2, coreCount - 1));
}

export function queueSize(o: Owned): number {
  return highest(o, QUEUE, 1, (a, b) => a > b);
}

/** Problems with a site record (N, M ≤ 20) are dealt down to this N+M+P; Infinity before Reach. */
export function ringMin(o: Owned): number {
  return highest(o, RING, Infinity, (a, b) => a < b);
}

/** Candidates the dealer draws to deal the best of (1: a random draw). */
export function dealerChoices(o: Owned): number {
  return o.has("rank8") ? 8 : o.has("rank4") ? 4 : o.has("rank2") ? 2 : 1;
}

/** Offers the player picks from (0: the dealer deals on its own). */
export function offerCount(o: Owned): number {
  return o.has("pick5") ? 5 : o.has("pick3") ? 3 : 0;
}

// ---------- the shop's view of levels (appended by the shop work) ----------

/** Levels of Another lane that still add a lane on this CPU (laneCount stops at the cores less one). */
export function laneLevelsUseful(coreCount = cores()): number {
  return Math.max(0, Math.max(2, coreCount - 1) - 2);
}

/** Another lane is owned to every level this CPU can use: buying more would add nothing. */
export function lanesMaxed(o: Owned, coreCount = cores()): boolean {
  return o.has("lanes2") && level(o, "lanesx") >= laneLevelsUseful(coreCount);
}
