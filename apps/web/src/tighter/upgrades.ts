/**
 * The first ten upgrades of the tech tree (techtree.html, balance/results/techtree.json), through
 * Basin hopping, Reach: loose records and Second lane. Costs and prerequisites are the design's.
 * The rest of the game reads what the player owns only through the functions below.
 */
export type UpgradeId =
  "trace" | "evals1" | "queue3" | "seeds" | "auto1" | "basin" | "reach2" | "evals2" | "advance" | "lanes2";

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

export const UPGRADES: readonly Upgrade[] = [
  {
    id: "trace",
    name: "Side-length trace",
    cost: 5,
    requires: [],
    effect: "every run's change on a trace of the side",
    real: "the Solve panel's trace",
  },
  {
    id: "evals1",
    name: "Longer runs I",
    cost: 30,
    requires: ["trace"],
    effect: "60 evaluations per run",
    real: "budget.evals 60",
  },
  {
    id: "queue3",
    name: "Problem queue: 3",
    cost: 50,
    requires: ["trace"],
    effect: "3 problems dealt from the frontier",
    real: "GET /api/problems before each deal",
  },
  {
    id: "seeds",
    name: "Seed counter",
    cost: 70,
    requires: ["auto1"],
    effect: "shows each run's seed and how many were tried on the board; never repeats one",
    real: "seed: uint32, mulberry32",
  },
  {
    id: "auto1",
    name: "Auto-eval I",
    cost: 85,
    requires: ["evals1"],
    effect: "one run every 15 s while it is on (a game throttle: clicking is faster)",
    real: "the same run(), scheduled",
  },
  {
    id: "basin",
    name: "Basin hopping",
    cost: 170,
    requires: ["seeds", "queue3"],
    effect: "perturb-and-repair runs past the compaction floor (at least 100 evaluations)",
    real: "basin_hopping",
  },
  {
    id: "reach2",
    name: "Reach: loose records",
    cost: 300,
    requires: ["basin"],
    effect: "deals site records with N, M <= 20 and a gap above 12 %, at 3x the points",
    real: "/api/records?N=&M=",
  },
  {
    id: "evals2",
    name: "Longer runs II",
    cost: 560,
    requires: ["basin"],
    effect: "300 evaluations per run",
    real: "budget.evals 300",
  },
  {
    id: "advance",
    name: "Auto-advance",
    cost: 850,
    requires: ["reach2", "seeds"],
    effect: "auto-eval moves on when runs stop paying, and compacts new problems",
    real: "an expected-gain rule over the queue",
  },
  {
    id: "lanes2",
    name: "Second lane",
    cost: 1200,
    requires: ["seeds", "reach2"],
    effect: "2 runs at once on 2 cores, on different problems",
    real: "2 Web Workers",
  },
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

/** Evaluations of one Evolve run. */
export function evalsPerRun(owned: ReadonlySet<UpgradeId>): number {
  if (owned.has("evals2")) return 300;
  if (owned.has("evals1")) return 60;
  return 30;
}

/** Evaluations of one Compact run (design §3). */
export const COMPACT_EVALS = 100;
/** Basin hopping's first run from a compacted board is its jump, measured at 100 evaluations. */
export const BASIN_MIN_EVALS = 100;

export type EvolveMethod = "mc_compress" | "basin_hopping";

export function methods(owned: ReadonlySet<UpgradeId>): EvolveMethod[] {
  return owned.has("basin") ? ["mc_compress", "basin_hopping"] : ["mc_compress"];
}

/** Evaluations of an Evolve run of `method`. */
export function evolveEvals(owned: ReadonlySet<UpgradeId>, method: EvolveMethod): number {
  const e = evalsPerRun(owned);
  return method === "basin_hopping" ? Math.max(BASIN_MIN_EVALS, e) : e;
}

/** Seconds auto-eval waits between the runs of a lane, or null without auto-eval. */
export function autoWaitSeconds(owned: ReadonlySet<UpgradeId>): number | null {
  return owned.has("auto1") ? 15 : null;
}

export function laneCount(owned: ReadonlySet<UpgradeId>): number {
  return owned.has("lanes2") ? 2 : 1;
}

export function queueSize(owned: ReadonlySet<UpgradeId>): number {
  return owned.has("queue3") ? 3 : 1;
}
