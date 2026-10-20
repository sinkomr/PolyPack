/**
 * The tech tree. Progress is slow on purpose: a click is one evaluation of an open run at first, and
 * each upgrade adds a little. Evaluations per click climb one at a time; Auto-eval starts at one
 * evaluation every 5 s and is sped up step by step; methods come well after, one at a time, each
 * dearer than the last; seeds and method settings are bought too.
 *
 * Costs: the evaluations-per-click ladder is priced from a simulation of real runs (8 games of one
 * click a second, a new problem per 300 clicks' worth of evaluations; balance/stage1c.mts) at about
 * 85 % of the median points earned between Michael's targets: "2 per click" after about 100 clicks,
 * "3" about 150 clicks later, "4" 200 later, and so on (step n needs about 100·n(n+1)/2
 * evaluations) [CALC]. Everything else is extrapolated and waits for play-testing [SPEC].
 * The rest of the game reads what the player owns only through the functions below.
 */

export type EvolveMethod =
  "mc_compress" | "basin_hopping" | "shrink_repair" | "seed" | "penalty" | "harden" | "asc" | "morph" | "ls_growth";

export type UpgradeId =
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
  | "auto1"
  | "auto2"
  | "auto3"
  | "auto4"
  | "auto5"
  | "auto6"
  | "auto7"
  | "auto8"
  | "auto9"
  | "away2"
  | "away3"
  | "away4"
  | "seeds"
  | "seeds2"
  | "seeds4"
  | "seeds8"
  | "seeds16"
  | "queue3"
  | "sweeps10"
  | "basin"
  | "shrink"
  | "lattice"
  | "penalty"
  | "harden"
  | "asc"
  | "morph"
  | "growth"
  | "reach2"
  | "advance"
  | "lanes2";

export interface Upgrade {
  id: UpgradeId;
  name: string;
  cost: number;
  requires: UpgradeId[];
  /** What it does in the game. */
  effect: string;
  /** The real feature behind it. */
  real: string;
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
const AWAY: Partial<Record<UpgradeId, number>> = { auto1: 1, away2: 4, away3: 12, away4: 24 };
/** Seeds (runs) per problem, by upgrade (1 without any). */
const SEEDS: Partial<Record<UpgradeId, number>> = { seeds2: 2, seeds4: 4, seeds8: 8, seeds16: 16 };
/** Methods in the order they unlock, by upgrade. */
const METHOD: Partial<Record<UpgradeId, EvolveMethod>> = {
  basin: "basin_hopping",
  shrink: "shrink_repair",
  lattice: "seed",
  penalty: "penalty",
  harden: "harden",
  asc: "asc",
  morph: "morph",
  growth: "ls_growth",
};

const per = (n: number) => `${n} evaluation${n === 1 ? "" : "s"}`;
const every = (r: number) => (r < 1 ? `one evaluation every ${Math.round(1 / r)} s` : `${per(r)} a second`);

function clickRung(id: UpgradeId, cost: number, requires: UpgradeId[]): Upgrade {
  const n = CLICK[id]!;
  return {
    id,
    name: `${n} evaluations per click`,
    cost,
    requires,
    effect: `each Evolve click runs ${per(n)} of the open run`,
    real: `${per(n)} of the same run(), one after another`,
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
  };
}

function methodRung(id: UpgradeId, cost: number, requires: UpgradeId[], effect: string): Upgrade {
  const m = METHOD[id]!;
  return { id, name: `Method: ${m}`, cost, requires, effect, real: m };
}

export const UPGRADES: readonly Upgrade[] = [
  {
    id: "trace",
    name: "Side-length trace",
    cost: 5,
    requires: [],
    effect: "every improvement on a trace of the side",
    real: "the Solve panel's trace",
  },
  // ---- evaluations per click, about 100, 250, 450, 700, ... clicks in; then a slow auto-eval ----
  clickRung("click2", 150, ["trace"]),
  clickRung("click3", 320, ["click2"]),
  clickRung("click4", 500, ["click3"]),
  autoRung("auto1", 650, ["click4"]),
  clickRung("click5", 780, ["click4"]),
  {
    id: "seeds",
    name: "Seed counter",
    cost: 300,
    requires: ["auto1"],
    effect: "shows each run's seed and the seeds used on a problem; a seed is never repeated on a problem",
    real: "seed: uint32, mulberry32",
  },
  autoRung("auto2", 900, ["auto1"]),
  clickRung("click6", 950, ["click5"]),
  {
    id: "queue3",
    name: "Problem queue: 3",
    cost: 1000,
    requires: ["click5"],
    effect: "3 problems at a time, each slot dealt a new one per 300 clicks' worth of evaluations",
    real: "GET /api/problems before each deal",
  },
  clickRung("click7", 1100, ["click6"]),
  {
    id: "away2",
    name: "Away: 4 hours",
    cost: 1200,
    requires: ["auto2"],
    effect: "auto-eval keeps earning for up to 4 hours while you are away",
    real: "evaluations owed, run when you are back",
  },
  autoRung("auto3", 1300, ["auto2"]),
  clickRung("click8", 1400, ["click7"]),
  clickRung("click9", 1550, ["click8"]),
  {
    id: "sweeps10",
    name: "mc_compress: 10 sweeps per evaluation",
    cost: 1600,
    requires: ["click7"],
    effect: "each mc_compress evaluation follows 10 sweeps of moves instead of 5: more search per click",
    real: "sweepsPerEvaluation 10 (the solver's default)",
  },
  clickRung("click10", 1700, ["click9"]),
  autoRung("auto4", 1900, ["auto3"]),
  {
    id: "seeds2",
    name: "Seeds: 2 per problem",
    cost: 2000,
    requires: ["seeds", "click7"],
    effect: "when a run on a problem stops improving, a second run starts with a new seed",
    real: "a new seed is a new attempt",
  },
  autoRung("auto5", 2800, ["auto4"]),
  // ---- well after: methods, one at a time, each dearer than the last ----
  methodRung(
    "basin",
    5000,
    ["click10", "auto4"],
    "perturb-and-repair runs: big jumps past the compaction floor, then nibbles",
  ),
  {
    id: "reach2",
    name: "Reach: loose records",
    cost: 6000,
    requires: ["basin"],
    effect: "deals site records with N, M <= 20 and a gap above 12 %, at 3x the points",
    real: "/api/records?N=&M=",
  },
  {
    id: "seeds4",
    name: "Seeds: 4 per problem",
    cost: 7000,
    requires: ["seeds2", "basin"],
    effect: "up to 4 runs with new seeds on each problem",
    real: "a new seed is a new attempt",
  },
  autoRung("auto6", 8000, ["auto5", "basin"]),
  methodRung("shrink", 10000, ["basin"], "shrink the container, then repair the overlaps: fast on dense boards"),
  {
    id: "advance",
    name: "Auto-advance",
    cost: 11000,
    requires: ["reach2", "queue3"],
    effect: "auto-eval compacts new problems and moves on when a problem stops paying",
    real: "an expected-gain rule over the queue",
  },
  {
    id: "away3",
    name: "Away: 12 hours",
    cost: 12000,
    requires: ["away2", "auto5"],
    effect: "auto-eval keeps earning for up to 12 hours while you are away",
    real: "evaluations owed, run when you are back",
  },
  methodRung("penalty", 15000, ["shrink"], "a soft-overlap squeeze with L-BFGS: steady nibbles near a plateau"),
  {
    id: "lanes2",
    name: "Second lane",
    cost: 18000,
    requires: ["advance"],
    effect: "a second solver worker: auto-eval runs on two problems at once",
    real: "2 Web Workers",
  },
  methodRung("lattice", 21000, ["penalty"], "lattice and symmetric starts: a new board from scratch, often a jump"),
  autoRung("auto7", 24000, ["auto6", "lanes2"]),
  {
    id: "seeds8",
    name: "Seeds: 8 per problem",
    cost: 28000,
    requires: ["seeds4", "lattice"],
    effect: "up to 8 runs with new seeds on each problem",
    real: "a new seed is a new attempt",
  },
  methodRung("harden", 30000, ["lattice"], "soft-to-rigid: momentum steps that harden a soft packing"),
  autoRung("auto8", 38000, ["auto7"]),
  {
    id: "away4",
    name: "Away: 24 hours",
    cost: 42000,
    requires: ["away3", "auto7"],
    effect: "auto-eval keeps earning for up to a day while you are away",
    real: "evaluations owed, run when you are back",
  },
  methodRung("morph", 45000, ["harden"], "morph the pieces' shapes and back: a different road through the same basin"),
  methodRung("asc", 60000, ["morph"], "active-set contact descent: slow evaluations, deep improvements"),
  {
    id: "seeds16",
    name: "Seeds: 16 per problem",
    cost: 75000,
    requires: ["seeds8", "asc"],
    effect: "up to 16 runs with new seeds on each problem",
    real: "a new seed is a new attempt",
  },
  autoRung("auto9", 90000, ["auto8", "asc"]),
  methodRung("growth", 120000, ["asc"], "lattice-strip growth: the strongest and slowest search"),
];

const BY_ID = new Map(UPGRADES.map((u) => [u.id, u]));

export function upgrade(id: UpgradeId): Upgrade {
  return BY_ID.get(id)!;
}

export const isUpgradeId = (id: unknown): id is UpgradeId => typeof id === "string" && BY_ID.has(id as UpgradeId);

/** Upgrades not yet owned whose prerequisites are all owned: the cards the player sees. */
export function available(owned: ReadonlySet<UpgradeId>): Upgrade[] {
  return UPGRADES.filter((u) => !owned.has(u.id) && u.requires.every((r) => owned.has(r)));
}

export type BuyCheck = { ok: true } | { ok: false; reason: "owned" | "locked" | "points" };

export function canBuy(owned: ReadonlySet<UpgradeId>, rp: number, id: UpgradeId): BuyCheck {
  const u = BY_ID.get(id);
  if (!u) return { ok: false, reason: "locked" };
  if (owned.has(id)) return { ok: false, reason: "owned" };
  if (!u.requires.every((r) => owned.has(r))) return { ok: false, reason: "locked" };
  // A tiny tolerance so that 4.9999999999 RP after floating sums still buys a 5 RP card.
  if (rp + 1e-9 < u.cost) return { ok: false, reason: "points" };
  return { ok: true };
}

// ---------- what the player owns, as game parameters ----------

const highest = <T>(
  owned: ReadonlySet<UpgradeId>,
  table: Partial<Record<UpgradeId, T>>,
  base: T,
  better: (a: T, b: T) => boolean,
): T => {
  let v = base;
  for (const [id, x] of Object.entries(table) as [UpgradeId, T][]) if (owned.has(id) && better(x, v)) v = x;
  return v;
};

/** Evaluations of one Evolve click. */
export function evalsPerClick(owned: ReadonlySet<UpgradeId>): number {
  return highest(owned, CLICK, 1, (a, b) => a > b);
}

/** Evaluations of Compact: one press that compacts the Load-all board (design §3). */
export const COMPACT_EVALS = 100;

/** Evaluations a run may do in all before it ends and the next seed takes over. */
export const RUN_BUDGET = 100_000;

/** Auto-eval's evaluations per second, or null without it. */
export function autoPerSecond(owned: ReadonlySet<UpgradeId>): number | null {
  return owned.has("auto1") ? highest(owned, AUTO, 0, (a, b) => a > b) : null;
}

/** Hours of auto-eval earned while away, at most. */
export function awayHours(owned: ReadonlySet<UpgradeId>): number {
  return highest(owned, AWAY, 0, (a, b) => a > b);
}

/** Most evaluations auto-eval's bank holds: its rate over the hours kept while away (at least one). */
export function bankCap(owned: ReadonlySet<UpgradeId>): number {
  return Math.max(1, (autoPerSecond(owned) ?? 0) * awayHours(owned) * 3600);
}

export function seedsPerProblem(owned: ReadonlySet<UpgradeId>): number {
  return highest(owned, SEEDS, 1, (a, b) => a > b);
}

/** The methods the player may run, mc_compress first, then in the order they were unlocked. */
export function methods(owned: ReadonlySet<UpgradeId>): EvolveMethod[] {
  return ["mc_compress", ...UPGRADES.filter((u) => owned.has(u.id) && METHOD[u.id]).map((u) => METHOD[u.id]!)];
}

/** The method's parameters as the player's upgrades set them (the solver's defaults otherwise). */
export function methodParams(owned: ReadonlySet<UpgradeId>, method: EvolveMethod): Record<string, unknown> {
  if (method === "mc_compress") return { sweepsPerEvaluation: owned.has("sweeps10") ? 10 : 5 };
  return {};
}

export function laneCount(owned: ReadonlySet<UpgradeId>): number {
  return owned.has("lanes2") ? 2 : 1;
}

export function queueSize(owned: ReadonlySet<UpgradeId>): number {
  return owned.has("queue3") ? 3 : 1;
}
