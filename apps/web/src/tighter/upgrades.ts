import type { How } from "./how";
import { presetParams, tuningLevels } from "./presets";

/**
 * The tech tree. Progress is slow on purpose: a click is one evaluation of an open run at first, and
 * each upgrade adds a little. Evaluations per click climb one at a time; Auto-eval clicks for the
 * player, starting at a click every 5 s, each as many evaluations as the player's own, so every click
 * upgrade speeds it up too, and its own rungs speed it up step by step [CALC, balance/autosim.mts:
 * about 20 % of an active player's evaluations when bought, 50 % by 10 per click, 100 % by Basin
 * hopping, and more with lanes]; methods come well after, one at a time, each
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
  // auto-eval
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
  { id: "auto", title: "Auto-eval" },
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
  /** What the player gets, in one short sentence. */
  effect: string;
  /**
   * What exactly happens, with the rule as formulas and every variable defined: the tree shows it on
   * hover or focus, and on a phone behind "How it works".
   */
  how: How;
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
/**
 * Auto-eval's clicks per second (per lane), by upgrade. Each of its clicks runs as many evaluations as
 * one of the player's, so every evaluations-per-click upgrade speeds auto-eval up too.
 */
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
/** Faster auto-eval: auto-eval's clicks a second grow by this much a level. */
export const AUTOX_GROWTH = 1.3;
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

/** A number as the shop writes it: whole, or to one decimal ("2.5"). */
const number = (x: number) => (Math.abs(x - Math.round(x)) < 1e-9 ? String(Math.round(x)) : x.toFixed(1));
const seconds = (x: number) => `${number(x)} s`;

// ---------- the explanations (How, how.ts) ----------
// Every number below is read from the code that implements the upgrade: the tables above, the
// dealer and the economy, and the solver's methods (packages/solver/src/methods).

/** A variable in How markup: sym("s", "ref") is s with the subscript "ref". */
const sym = (name: string, sub?: string) => `<var>${name}</var>${sub === undefined ? "" : `<sub>${sub}</sub>`}`;
type Var = readonly [string, string];

const K = sym("k");
const VAR_K: Var = [K, "evaluations per click"];
const EVALUATION =
  "An evaluation is one scoring of the whole packing by the solver, which checks the pieces for overlaps and measures the container around them.";
const DEALS_PER_CLICK =
  "New problems are earned per 300 clicks' worth of evaluations (300 × k), so more evaluations per click do not bring them faster per click.";

/** Evaluations per click: the rungs' value, the levels of One more evaluation per click, the Clicks only reward. */
const CLICK_MATH = (base: string) => [`${K} = ${base} + ${sym("a")} + ${sym("r")}`];
const CLICK_VARS: readonly Var[] = [
  VAR_K,
  [sym("a"), "levels of One more evaluation per click"],
  [sym("r"), "1 once you have finished a cycle under the Clicks only rule, else 0"],
];

function clickRung(id: UpgradeId, cost: number, requires: UpgradeId[]): Upgrade {
  const n = CLICK[id]!;
  return {
    id,
    name: `${n} evaluations per click`,
    cost,
    requires,
    effect: `Each Evolve click runs ${n} evaluations instead of ${n - 1}.`,
    how: {
      text: [
        `An Evolve click asks the open run on the problem for more evaluations. ${EVALUATION} Between two evaluations the method moves the pieces, so each evaluation is one more step of its search.`,
        `With this upgrade a click runs ${n} evaluations of the same run, one after another. Auto-eval's clicks are as large as yours, so it speeds up by the same factor.`,
      ],
      math: CLICK_MATH(String(n)),
      vars: CLICK_VARS,
      note: DEALS_PER_CLICK,
    },
    row: "clicks",
  };
}

/** Auto-eval's pace: "every 5 s", "once a second", "2 times a second". */
const pace = (c: number) =>
  c < 1 ? `every ${seconds(1 / c)}` : c === 1 ? "once a second" : `${number(c)} times a second`;
const AUTO_VARS: readonly Var[] = [
  [sym("e"), "auto-eval's evaluations per second, all lanes together"],
  VAR_K,
  [sym("L"), "lanes, the solver workers that run at once (1 until Second lane)"],
];
const AUTO_NOTE =
  "Your computer sets the upper limit. When it cannot keep up, auto-eval runs as fast as it can, and at most 60 s of its clicks (at least 100 evaluations) wait to be run.";
/** Auto-eval's evaluations a second at `c` clicks a second per lane. */
const autoMath = (c: number) =>
  c < 1
    ? `${sym("e")} = ${K} × ${sym("L")} / ${number(1 / c)}`
    : `${sym("e")} = ${c === 1 ? "" : `${number(c)} × `}${K} × ${sym("L")}`;

function autoRung(id: UpgradeId, cost: number, requires: UpgradeId[]): Upgrade {
  const c = AUTO[id]!;
  const prev = Math.max(0, ...Object.values(AUTO).filter((x) => x < c));
  const first = id === "auto1";
  return {
    id,
    name: first ? "Auto-eval" : `Auto-eval: ${c < 1 ? `every ${seconds(1 / c)}` : `${number(c)} a second`}`,
    cost,
    requires,
    effect: first
      ? `Auto-eval clicks Evolve for you ${pace(c)} while it is switched on.`
      : `Auto-eval clicks ${pace(c)} in each lane instead of ${pace(prev)}.`,
    how: {
      text: first
        ? [
            `Auto-eval presses Evolve for you ${pace(c)}, beside your own clicks. Each of its clicks runs as many evaluations as one of yours, so every evaluations-per-click upgrade speeds it up too. ${EVALUATION}`,
            "It runs while its switch is on and this page is open. It pauses in a hidden tab unless Continuous lets it go on, and on battery power (where the browser reports it) unless you allow that in Settings. Nothing builds up while it is paused or off.",
            "Without Auto-advance it works only on problems you have already compacted (your first click on a new problem). The first lane works on the problem on the board, and any other lane on the next problems in the queue.",
          ]
        : [
            `In each lane auto-eval now clicks ${pace(c)}, and each of its clicks runs as many evaluations as one of yours. A lane is a solver worker that runs one problem at a time.`,
          ],
      math: [autoMath(c)],
      vars: AUTO_VARS,
      note: AUTO_NOTE,
    },
    row: "auto",
  };
}

const SEED_TEXT =
  "A run is one search by one method on one problem, from the problem's best board. A seed is the whole number that starts the run's random choices, so each seed searches differently.";

function seedRung(id: UpgradeId, cost: number, requires: UpgradeId[]): Upgrade {
  const n = SEEDS[id]!;
  const prev = Math.max(1, ...Object.values(SEEDS).filter((x) => x < n));
  return {
    id,
    name: `Seeds: ${n} per problem`,
    cost,
    requires,
    effect: `Each problem gets up to ${n} runs, each with its own seed, instead of ${prev}.`,
    how: {
      text: [
        SEED_TEXT,
        "A run ends by itself when its method stops improving, or after its budget of 100,000 evaluations. Each run that ends so spends one of the problem's seeds, and your next click opens a new run with the next seed. When every seed is spent, Evolve does nothing more on that problem and auto-eval passes it by.",
        "A run that the game closes (for another problem, another method or a reload) spends no seed, and the next run there still takes a new seed.",
      ],
      math: [`${sym("S")} = ${n} × ${sym("d")}`],
      vars: [
        [sym("S"), "seeds per problem, the runs that may end by themselves on it"],
        [sym("d"), "2 once you have finished a cycle under the One seed rule, else 1"],
      ],
      note: "Under the One seed rule, S = 1 for that cycle.",
    },
    row: "seeds",
  };
}

function queueRung(id: UpgradeId, cost: number, requires: UpgradeId[]): Upgrade {
  const q = QUEUE[id]!;
  const t = sym("t");
  return {
    id,
    name: `Problem queue: ${q}`,
    cost,
    requires,
    effect: `The queue holds ${q} problems, and the dealer earns a new one every ${number(300 / q)} clicks.`,
    how: {
      text: [
        "The queue holds the problems you work on, one per slot. A deal gives a free slot a new problem. The dealer earns deals as evaluations run, yours and auto-eval's, and saves up at most one deal per slot. When a slot is free and a deal is saved, it deals at once. When the queue is empty, it deals a problem without a saved deal, and the next evaluations pay that back.",
        "A problem leaves the queue when you drop it, or when Auto-advance replaces it.",
      ],
      math: [
        `${t} ← min(${sym("q")}, ${t} + ${sym("q")} × ${sym("e")} / (300 × ${K}))`,
        `deal when ${t} ≥ 1, then ${t} ← ${t} − 1`,
      ],
      vars: [
        [t, "deals saved up (below 0 after a deal made without one)"],
        [sym("q"), `slots in the queue, ${q} with this upgrade`],
        [sym("e"), "evaluations run since the last update, yours and auto-eval's"],
        VAR_K,
      ],
      note: `With ${q} slots that is one deal per ${number(300 / q)} clicks' worth of evaluations.`,
    },
    row: "queue",
  };
}

const SELECT = "Choose it in the Method list beside Evolve, and your next click opens a run with it.";
function methodRung(
  id: UpgradeId,
  cost: number,
  requires: UpgradeId[],
  effect: string,
  how: How,
  mystery = false,
): Upgrade {
  const m = METHOD[id]!;
  return { id, name: `Method: ${m}`, cost, requires, effect, how, row: "methods", mystery };
}

// The methods, from packages/solver/src/methods/*.ts (their defaults and update rules).

const MC_COMPRESS_TEXT: readonly string[] = [
  "mc_compress is a Monte Carlo compression. A sweep tries P moves. Each move picks a random piece and shifts it by up to its step in x and y, or for half the moves on polygons turns it by up to its turning step. A move is kept only when the piece stays inside the container and overlaps nothing.",
  "Every 2 sweeps it tries to shrink. It pulls every centre toward the container's centre by the fraction f and fits the container tightly around them, and then it tries the wall alone at (1 − f) times its side. A change is kept only when nothing overlaps and the side does not grow. Every 10 sweeps it also tries a new angle for the container, and every 20 sweeps the steps and f adapt so that about 30 % of tries succeed.",
  "The packing is scored once every n sweeps, which is one evaluation. A run ends after 500 evaluations without progress, which is a fall of more than 10⁻⁹ (relative) in the score or the container's side.",
];
const MC_COMPRESS_MATH: readonly string[] = [
  `${sym("c", "i")} ← ${sym("c", "0")} + (1 − ${sym("f")})(${sym("c", "i")} − ${sym("c", "0")})`,
  `${sym("s")} ← (1 − ${sym("f")}) × ${sym("s")}`,
  `1 evaluation per ${sym("n")} sweeps of ${sym("P")} moves`,
];
const MC_COMPRESS_VARS = (n: string): readonly Var[] => [
  [sym("c", "i"), "the centre of piece i"],
  [sym("c", "0"), "the container's centre"],
  [sym("f"), "the shrink fraction, 1 % at first, adapting up to 5 %"],
  [sym("s"), "the container's side"],
  [sym("n"), `sweeps per evaluation, ${n}`],
  [sym("P"), "pieces"],
];

const BASIN_HOW: How = {
  text: [
    "basin_hopping jumps from one local optimum to the next. Each hop changes the current packing with one of several moves, chosen by how often each has paid. The main move, a kick, shifts 40 % of the pieces (at least one) by up to m in x and y and turns them by up to 90°. The others swap pieces, move a cluster, take a piece out and put it back elsewhere, or start afresh.",
    "A short penalty solve of at most 150 evaluations then repairs the overlaps and squeezes the container. Its best packing becomes the current one when it is smaller, or else with the probability below. After each kick, m grows if the hop was accepted and shrinks if not, so that about half the kicks are accepted.",
    "It has no rule to stop early. The hops go on until 3,000 evaluations of the run's budget of 100,000 are left, and a long penalty solve then refines the best packing.",
  ],
  math: [
    `accept when ${sym("s")}′ &lt; ${sym("s")}, else with probability exp(−(${sym("s")}′ − ${sym("s")}) / ${sym("T")})`,
    `${sym("m")} ← ${sym("m")} × exp(0.15 × (${sym("a")} − 0.5))`,
  ],
  vars: [
    [sym("s"), "the side of the current packing"],
    [`${sym("s")}′`, "the side after the hop"],
    [sym("T"), "the temperature, 0.04 (in piece sides)"],
    [
      sym("m"),
      "the kick size in piece sides, 0.35 at first (0.25 with basin_hopping tuning), kept between 0.001 and 10",
    ],
    [sym("a"), "1 if the hop was accepted, else 0"],
  ],
  note: SELECT,
};

const PENALTY_TEXT =
  "penalty treats the container's side and every piece's position and angle as variables. It minimises the side plus a penalty for overlaps and for pieces that stick out of the container, with L-BFGS, a quasi-Newton method that estimates the curvature from its last 12 steps.";
const PENALTY_HOW: How = {
  text: [
    PENALTY_TEXT,
    "After each accepted L-BFGS step it pushes the pieces apart until nothing overlaps and scores that packing, which is one evaluation. Each solve takes at most I steps. Between solves each term's multiplier λ is updated, and the weight w is multiplied by 4 when the largest violation did not at least halve (an augmented Lagrangian). The run ends after 10 solves.",
  ],
  math: [
    `${sym("F")} = ${sym("s")} + Σ<sub>${sym("k")}</sub> (max(0, ${sym("λ", "k")} + 2${sym("w")}${sym("g", "k")})<sup>2</sup> − ${sym("λ", "k")}<sup>2</sup>) / (4${sym("w")})`,
    `${sym("λ", "k")} ← max(0, ${sym("λ", "k")} + 2${sym("w")}${sym("g", "k")})`,
    `evaluations per run ≈ 10 × (${sym("I")} + 1)`,
  ],
  vars: [
    [sym("F"), "what L-BFGS minimises"],
    [sym("s"), "the container's side"],
    [sym("k"), "one term, for a pair of pieces or for a piece and a wall"],
    [
      sym("g", "k"),
      "its violation, which is how deep the two pieces overlap or how far the piece sticks out (negative when clear)",
    ],
    [sym("λ", "k"), "its multiplier, 0 at first"],
    [sym("w"), "the penalty weight, 10 at first"],
    [sym("I"), "L-BFGS steps at most per solve, 200 at first (more with penalty tuning)"],
  ],
  note: SELECT,
};

const SHRINK_HOW: How = {
  text: [
    "shrink_repair shrinks the container's side by the ratio r and scales the centres into it, which makes pieces overlap. It then repairs the overlaps at that fixed size. The repair lowers F below with L-BFGS, moves each piece still in conflict to the best of 72 sampled spots, and raises the weights of pairs that keep overlapping.",
    "When the repaired packing scores smaller, r grows by a quarter, up to 5 %. Otherwise r halves. Once r falls below 0.02 %, it explores instead. It scatters or turns a group of nearby pieces and repairs 1 to 4 times 0.02 % below the current side. After 40 failed explorations it restarts from random positions 2 % larger than the best.",
    "Every repaired packing is scored, and the working packing is also scored after every W × P units of work. Each scoring is one evaluation. It has no rule to stop early, so a run uses its whole budget of 100,000 evaluations.",
  ],
  math: [
    `${sym("s")} ← (1 − ${sym("r")}) × ${sym("s")}`,
    `${sym("F")} = Σ ${sym("w", "ij")} ${sym("d", "ij")}<sup>2</sup> + Σ ${sym("v", "i")} ${sym("p", "ik")}<sup>2</sup>`,
    `${sym("r")} ← min(0.05, 1.25 × ${sym("r")}) after a gain, else ${sym("r")} ← ${sym("r")} / 2`,
    `a scoring every ${sym("W")} × ${sym("P")} units of work, a test of two pieces costing 2${sym("N")} units`,
  ],
  vars: [
    [sym("s"), "the container's side"],
    [sym("r"), "the shrink ratio, 1 % at first"],
    [sym("F"), "what the repair lowers to 0"],
    [sym("w", "ij"), "the weight of pieces i and j, raised while they keep overlapping"],
    [sym("d", "ij"), "how deep pieces i and j overlap"],
    [sym("v", "i"), "the weight of piece i against the walls"],
    [sym("p", "ik"), "how far piece i sticks out past wall k"],
    [sym("W"), "units of work per piece between two scorings, 4,000 at first (more with shrink_repair tuning)"],
    [sym("P"), "pieces"],
    [sym("N"), "sides of a piece (1 unit per test for circles)"],
  ],
  note: SELECT,
};

const SEED_HOW: How = {
  text: [
    "seed builds new boards from scratch instead of improving the current one. Its generators are a square lattice, a hexagonal lattice, a double lattice for pentagons, rows, and rings along the container's edge (when the container's symmetry allows and P ≤ 100). They take turns, and each makes up to 12 boards with different offsets and angles.",
    "A lattice is scaled until neighbouring pieces just touch, and seed keeps the P sites that need the smallest container centred on the origin. Each board is one evaluation. The problem's board changes only when one of them is smaller than your best. The run ends when every generator is done, after a few dozen evaluations.",
  ],
  math: [
    `keep the ${sym("P")} sites ${sym("x")} with the smallest max<sub>${sym("j")}</sub> (${sym("x")} · ${sym("u", "j")} + ${sym("h")}(${sym("u", "j")}))`,
  ],
  vars: [
    [sym("P"), "pieces"],
    [sym("x"), "a lattice site, where a piece's centre goes"],
    [sym("j"), "an edge of the container"],
    [sym("u", "j"), "the outward unit normal of edge j"],
    [`${sym("h")}(${sym("u", "j")})`, "how far a piece reaches past its centre in that direction"],
  ],
  note: SELECT,
};

const HARDEN_HOW: How = {
  text: [
    "harden is Nakajima's soft-to-rigid method. Each piece starts as the disc inscribed in it and turns into its true polygon over the run, while momentum descent pushes the container in. A schedule has three phases. Compress squeezes the discs under 3 times the pressure μ, morph turns the discs into polygons, and settle relaxes the true shapes without noise as the pressure falls.",
    "Every I momentum steps, the pieces are moved apart from their mean centre until nothing overlaps, and that packing is scored, which is one evaluation. A full schedule takes about 11,500 steps, and a run of 100,000 evaluations repeats it many times.",
  ],
  math: [
    `${sym("E")} = Σ ${sym("d")}<sup>2</sup> + Σ ${sym("p")}<sup>2</sup> + ${sym("μ")} × ${sym("L")}`,
    `${sym("v")} ← 0.85 × ${sym("v")} − 0.04 × ∇${sym("E")}, then each pose moves by ${sym("v")} plus noise`,
    `evaluations per schedule = ⌈11,500 / ${sym("I")}⌉`,
  ],
  vars: [
    [sym("E"), "the energy the descent lowers"],
    [sym("d"), "how deep two soft pieces overlap"],
    [sym("p"), "how far a corner of a piece sticks out past a wall"],
    [sym("μ"), "the pressure, 0.16"],
    [sym("L"), "the container's size (its side, or its apothem for 7 or more sides)"],
    [sym("v"), "the velocity of a piece (or of L)"],
    [sym("I"), "momentum steps per evaluation, 32 at first (more with harden tuning)"],
  ],
  note: SELECT,
};

const MORPH_HOW: How = {
  text: [
    "morph solves a chain of easier problems. It replaces each piece by a soft shape S(t), the polygon shrunk by t and rounded by a disc, which goes from the inscribed disc at t = 0 to the true polygon at t = 1 in 7 steps.",
    "At each step it scales the packing to first contact and runs a penalty solve on the soft shapes, with the objective of the penalty method. After each accepted step of that solve it turns the soft packing back into true pieces, spreading the centres until nothing overlaps, and scores it, which is one evaluation. When a step ends with an overlap or a protrusion above 0.02 piece sides, it halves the next step, at most twice between two planned steps. The run ends after the last step.",
  ],
  math: [
    `${sym("S")}(${sym("t")}) = ${sym("t")} × polygon ⊕ (1 − ${sym("t")}) × ${sym("ρ")} × disc`,
    `${sym("t", "j")} = ${sym("j")} / 6, for ${sym("j")} = 0, 1, …, 6`,
  ],
  vars: [
    [`${sym("S")}(${sym("t")})`, "the soft shape at t"],
    [sym("t"), "how far along the path, from 0 to 1"],
    [sym("ρ"), "the radius of the disc inscribed in the piece"],
    [sym("j"), "the step"],
  ],
  note: `⊕ adds two shapes point by point (a Minkowski sum). ${SELECT}`,
};

const ASC_TEXT =
  "asc (adaptive shrinking container) is a Monte Carlo search with the container as a variable. A sweep tries P moves of single pieces, moves of the container (shift, turn, shrink), and strains that move all centres at once. A strain squeezes the centres along a random axis (and may stretch them across it, keeping the area), squeezes them within a sector, or pulls them all inward while the container shrinks. The pieces never change shape.";
const ASC_HOW: How = {
  text: [
    ASC_TEXT,
    "A move is kept only when no piece overlaps another or leaves the container and the side does not grow. The packing is scored once every n sweeps, which is one evaluation. A run ends after 2,000 sweeps without a gain.",
  ],
  math: [
    `${sym("x")} ← (1 − ${sym("a")}) × ${sym("x")}, ${sym("y")} ← ${sym("y")} / (1 − ${sym("a")})`,
    `${sym("s")} ← (1 − ${sym("a")}) × ${sym("s")}`,
    `1 evaluation per ${sym("n")} sweeps`,
  ],
  vars: [
    [sym("x"), "a centre's coordinate along the random axis, from the container's centre"],
    [sym("y"), "its coordinate across the axis"],
    [sym("a"), "the move's size, which adapts"],
    [sym("s"), "the container's side"],
    [sym("n"), "sweeps per evaluation, 10 at first (more with asc tuning)"],
  ],
  note: SELECT,
};

const GROWTH_HOW: How = {
  text: [
    "ls_growth is Lubachevsky–Stillinger growth. The container stays fixed at the tight fit of the start. The pieces shrink to 0.8 of their size, get random velocities, and then grow at a steady rate while they fly and bounce off each other and the walls, until they jam.",
    "Every I collisions or steps, the pieces are scaled back to their true size and the packing is scored, which is one evaluation. A growth run ends at a jam or after S evaluations without a gain. A run of the method makes 4 growth runs, each from the best packing so far at 0.95 of its size.",
  ],
  math: [
    `${sym("σ")} ← ${sym("σ")} + ${sym("g")} × Δ${sym("t")}`,
    `${sym("u")}′ = 4${sym("g")} − ${sym("u")}`,
    `${sym("s")} ≤ ${sym("L")} / ${sym("σ")}`,
  ],
  vars: [
    [sym("σ"), "the pieces' size as a fraction of their true size"],
    [sym("g"), "the growth rate, 0.01 per unit of time"],
    [`Δ${sym("t")}`, "the time step"],
    [
      sym("u"),
      "two discs' relative speed along the line between them, positive when they part (polygons bounce approximately)",
    ],
    [`${sym("u")}′`, "the same after they collide"],
    [sym("s"), "the side scored"],
    [sym("L"), "the container's fixed side"],
    [sym("I"), "collisions or steps per evaluation, 16 at first (more with ls_growth tuning)"],
    [sym("S"), "evaluations without a gain before a growth run ends, 128 at first (more with ls_growth tuning)"],
  ],
  note: SELECT,
};

/**
 * The tuned parameters at the solver's defaults (level 0), for the tuning cards; a test checks them
 * against the solver's own defaults. mc_compress's level 0 is 10 sweeps: its tuning needs "10 sweeps
 * per evaluation".
 */
export const TUNED_DEFAULTS: Partial<Record<EvolveMethod, Record<string, number>>> = {
  mc_compress: { sweepsPerEvaluation: 10, stagnationEvals: 500, maxRestarts: 0 },
  basin_hopping: { kickMagnitude: 0.35 },
  shrink_repair: { evaluationWork: 4000 },
  penalty: { innerIterations: 200 },
  harden: { evaluationInterval: 32 },
  asc: { sweepsPerEvaluation: 10, stagnationSweeps: 2000 },
  ls_growth: { evaluationInterval: 16, stagnationEvaluations: 128 },
};
/** What each tuned parameter sets, by method. */
const TUNED_MEANING: Record<string, string> = {
  "mc_compress.sweepsPerEvaluation": "sweeps of P moves between two evaluations",
  "mc_compress.stagnationEvals": "evaluations without progress before the run ends or restarts",
  "mc_compress.maxRestarts": "restarts, each from the packing spread 15 % wider, before the run ends",
  "basin_hopping.kickMagnitude": "the kick size at the start of a run, in piece sides",
  "shrink_repair.evaluationWork": "units of work per piece between two scorings of the working packing",
  "penalty.innerIterations": "L-BFGS steps at most per solve (a run makes 10 solves)",
  "harden.evaluationInterval": "momentum steps between two evaluations",
  "asc.sweepsPerEvaluation": "sweeps between two evaluations",
  "asc.stagnationSweeps": "sweeps without a gain before the run ends",
  "ls_growth.evaluationInterval": "collisions or steps between two evaluations",
  "ls_growth.stagnationEvaluations": "evaluations without a gain before a growth run ends",
};
/** How much longer an evaluation takes at the top level, from the bench (presets.ts). */
const TUNED_TIME: Partial<Record<EvolveMethod, string>> = {
  mc_compress: "up to 30 % longer",
  shrink_repair: "up to 2.5 times as long",
  penalty: "up to 3 times as long",
  harden: "up to 4 times as long",
  asc: "10 to 30 % longer",
  ls_growth: "up to 5 times as long",
};

function tuneRung(id: UpgradeId, method: EvolveMethod, cost: number, requires: UpgradeId[], mystery = false): Upgrade {
  const n = Math.max(1, tuningLevels(method));
  const levels = Array.from({ length: n + 1 }, (_, l) => ({
    ...TUNED_DEFAULTS[method],
    ...presetParams(method, l, true),
  }));
  const keys = Object.keys(TUNED_DEFAULTS[method] ?? {});
  const time = TUNED_TIME[method];
  return {
    id,
    name: `${method} tuning`,
    cost,
    requires,
    effect:
      n === 1
        ? `Gives ${method} a setting that paid more per evaluation in tests.`
        : `Each level gives ${method} a setting that does more search per evaluation.`,
    how: {
      text: [
        `${n === 1 ? "The level sets" : `Each level sets`} ${method}'s parameters as below, from level 0 (the solver's defaults) to level ${n}. Runs use the new setting from your next click.`,
        `A level was kept only where it cut the side at least as much per evaluation as the level below (within 0.05 percentage points) on three test problems (40 21-gons in a 24-gon, 80 36-gons in a 33-gon and 30 heptagons in a heptagon).${time ? ` An evaluation takes ${time} at the top level, which matters only when your computer limits auto-eval.` : ""}`,
      ],
      math: keys.map((k) => `<code>${k}</code> = ${levels.map((l) => String(l[k as keyof typeof l])).join(", ")}`),
      vars: keys.map((k) => [`<code>${k}</code>`, `${TUNED_MEANING[`${method}.${k}`]}, at levels 0 to ${n}`]),
      note: `${n > 1 ? "Each level costs 3 times the one before. " : ""}With Auto-tune and Auto chosen, a run may also use a lower level when that paid more.`,
    },
    row: "runs",
    mystery,
    // as many levels as the method has presets that passed the bench (presets.ts)
    levels: { max: n, growth: 3 },
  };
}

const RING_TEXT =
  "Contested problems are site records and published values of shapes with up to 20 sides (or circles), which other players have worked on. They are dealt only when N + M + P is at least your size ring's bound.";

function ringRung(id: UpgradeId, cost: number, requires: UpgradeId[], mystery = false): Upgrade {
  const min = RING[id]!;
  const prev = Math.min(...Object.values(RING).filter((x) => x > min));
  return {
    id,
    name: min === 0 ? "Problem sets: every size" : `Problem sets: N+M+P ≥ ${min}`,
    cost,
    requires,
    effect:
      min === 0
        ? "Site records and published values of every size can be dealt."
        : `Site records and published values are dealt down to N + M + P = ${min} instead of ${prev}.`,
    how: {
      text: [
        RING_TEXT,
        `${min === 0 ? "This upgrade removes the bound." : `This upgrade lowers the bound to ${min}.`} Smaller problems evaluate faster. One mc_compress evaluation took about 7.4 ms at N + M + P = 180, 1.8 ms at 85, 0.45 ms at 33 and 0.22 ms at 18 on the machine it was measured on. The dealer's ranking favours faster problems (see Dealer: best of 2).`,
      ],
      math: min === 0 ? undefined : [`${sym("N")} + ${sym("M")} + ${sym("P")} ≥ ${min}`],
      vars:
        min === 0
          ? undefined
          : [
              [sym("N"), "sides of a piece (0 for a circle)"],
              [sym("M"), "sides of the container (0 for a circle)"],
              [sym("P"), "pieces"],
            ],
    },
    row: "problems",
    mystery,
  };
}

function dealerRung(id: UpgradeId, cost: number, requires: UpgradeId[]): Upgrade {
  const k = id === "rank8" ? 8 : id === "rank4" ? 4 : 2;
  return {
    id,
    name: `Dealer: best of ${k}`,
    cost,
    requires,
    effect:
      k === 2
        ? "The dealer draws 2 problems and deals the one expected to pay more."
        : `The dealer draws ${k} problems instead of ${k / 2} and deals the best one.`,
    how: {
      text: [
        `When a deal is due, the dealer draws ${k} candidate problems, checks each with the server, and ranks them by the value V below. It deals the best one, or the next if that one's packing cannot be read. A lost record waiting for Retake and Collector's pick come before the ranked candidates.`,
        "V is the record points the candidate is expected to pay per evaluation, scaled up for problems that evaluate faster. 0.5 is about the record points an evaluation earns on a fresh open problem with w = 1. The square root splits the difference between your clicks, which count the same however long an evaluation takes, and auto-eval, which your computer's speed limits.",
      ],
      math: [
        `${sym("V")} = ${sym("w")} × ${sym("c")} × ${sym("R")} × 0.5 × ${sym("θ")} × √(${sym("t", "85")} / ${sym("t")})`,
        `${sym("w")} = ${sym("d")}(${sym("N")}) × ${sym("d")}(${sym("M")})`,
        `${sym("d")}(${sym("x")}) = 1 for a circle or ${sym("x")} ≤ 20, else 20 / ${sym("x")}`,
      ],
      vars: [
        [sym("V"), "the candidate's value"],
        [sym("w"), "the shape weight, which also multiplies every point the problem pays"],
        [sym("N"), "sides of a piece (0 for a circle)"],
        [sym("M"), "sides of the container (0 for a circle)"],
        [`${sym("d")}(${sym("x")})`, "how far a shape with x sides is from a circle"],
        [
          sym("c"),
          "the contest weight, 1 for an open problem, 3 for a loose record, 10 for another site record and 100 for a published value",
        ],
        [
          sym("R"),
          "the room left, 1 for an open problem, min(1, 0.3 + 25 × its weakness) for a loose record (see Reach), 0.1 for another site record and 0.004 for a published value",
        ],
        [sym("θ"), "1, or with the Learning dealer its correction for this kind of problem"],
        [sym("t"), "milliseconds of one mc_compress evaluation at this problem's N + M + P, from a measured table"],
        [sym("t", "85"), "the same at N + M + P = 85, 1.77 ms"],
      ],
    },
    row: "dealer",
  };
}

function pickRung(id: UpgradeId, cost: number, requires: UpgradeId[]): Upgrade {
  const n = id === "pick5" ? 5 : 3;
  return {
    id,
    name: `Your pick: ${n}`,
    cost,
    requires,
    effect:
      n === 3
        ? "The dealer offers you 3 problems, and you choose which one to take."
        : "The dealer offers you 5 problems at a time instead of 3.",
    how: {
      text: [
        `When a slot is free and a deal is saved, the dealer draws problems one at a time and shows up to ${n} of them as offers, best first by the value it expects them to pay (see Dealer: best of 2). Nothing more is dealt until you take one. The game checks an offer with the server as you take it, and removes offers that your tree, your filters or the cycle's rule no longer allow.`,
        "With Auto-advance and auto-eval on, a stalled problem is also replaced by the best offer, and the game takes the top offer into a free slot for you whenever a lane would otherwise have no problem to work on.",
      ],
      note: "Each offer is a separate draw, so the dealer's best-of choice does not apply to offers. The first problem of a game is always dealt for you.",
    },
    row: "dealer",
  };
}

const LANE_MATH = [`${sym("L")} = min(2 + ${sym("a")}, max(2, ${sym("C")} − 1))`];
const LANE_VARS: readonly Var[] = [
  [sym("L"), "lanes"],
  [sym("a"), "levels of Another lane"],
  [sym("C"), "your CPU's cores, as the browser reports them (4 when it does not say)"],
];
const LANE_TEXT =
  "A lane is a solver worker, a thread of the browser that holds one open run. Two lanes never work on the same problem, since one run's evaluations cannot be split. Auto-eval clicks at its pace in every lane, so each lane adds as many evaluations per second as the first.";

function standingRung(
  id: UpgradeId,
  name: string,
  cost: number,
  requires: UpgradeId[],
  effect: string,
  how: How,
  levels?: { max: number; growth: number },
): Upgrade {
  return { id, name, cost, requires, effect, how, row: "standing", mystery: true, currency: "standing", levels };
}

const RENT_MATH = [
  `${sym("h")} = 0.01 × ${sym("B")} × 1.5<sup>${sym("a")}</sup> × ${sym("m")}`,
  `rent paid at a check = ${sym("h")} × min(${sym("Δ")}, 168)`,
];
const RENT_VARS: readonly Var[] = [
  [sym("h"), "a record's rent, in record points per hour"],
  [sym("B"), "the record points that problem earned, before multipliers"],
  [sym("a"), "levels of Higher rent"],
  [sym("m"), "your points multiplier now (standing, collections and the rewards of cycle rules)"],
  [sym("Δ"), "hours since the record's last check (168 hours is a week)"],
];

/** The tree, in an order where every prerequisite comes before the upgrades that need it. */
export const UPGRADES: readonly Upgrade[] = [
  {
    id: "trace",
    name: "Trace detail",
    cost: 5,
    requires: [],
    effect: "The trace in the board's corner gets its labels and a dot at each improvement.",
    how: {
      text: [
        "The trace is the small chart in the board's corner. It draws the problem's side after each improvement that counted, against the evaluations run on that problem. An improvement counts when it beats the side before by more than the 10⁻⁹ minimum, as below.",
        "Trace detail adds a dot at each of the last 60 improvements and a label under the chart. The label gives the side at the first and the last point, the number of improvements, and the evaluations between them.",
      ],
      math: [`counts when ${sym("s")}′ &lt; ${sym("s")} × (1 − 10<sup>−9</sup>)`],
      vars: [
        [sym("s"), "the container's side before, which is the score (smaller is better)"],
        [`${sym("s")}′`, "the side after"],
      ],
    },
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
    effect: "You see each run's seed and how many of a problem's seeds are spent.",
    how: {
      text: [
        SEED_TEXT,
        "On each problem the seeds go 1, 2, 3 and so on and are never repeated. Compact, your first click on a new problem, uses seed 1. With the Seed counter, the toolbar and the Lanes panel show each run's seed, and the toolbar shows how many of the problem's seeds are spent.",
        "A seed is spent when its run ends by itself, because its method stopped improving or it used its budget of 100,000 evaluations. Without a Seeds upgrade a problem has one seed.",
      ],
    },
    row: "seeds",
  },
  autoRung("auto2", 400, ["auto1", "click3"]),
  clickRung("click4", 500, ["click3"]),
  clickRung("click5", 780, ["click4"]),
  autoRung("auto3", 900, ["auto2", "click4"]),
  clickRung("click6", 950, ["click5"]),
  queueRung("queue3", 1000, ["click5"]),
  clickRung("click7", 1100, ["click6"]),
  clickRung("click8", 1400, ["click7"]),
  clickRung("click9", 1550, ["click8"]),
  {
    id: "sweeps10",
    name: "mc_compress: 10 sweeps per evaluation",
    cost: 1600,
    requires: ["click7"],
    effect: "mc_compress runs 10 sweeps of moves per evaluation instead of 5.",
    how: {
      text: [
        "Each evaluation of mc_compress now follows 10 sweeps of moves instead of 5, so each click searches about twice as long. 10 is the solver's own default. Compact, your first click on a new problem, uses it too.",
        ...MC_COMPRESS_TEXT,
      ],
      math: MC_COMPRESS_MATH,
      vars: MC_COMPRESS_VARS("10 with this upgrade, 5 without"),
    },
    row: "runs",
  },
  clickRung("click10", 1700, ["click9"]),
  autoRung("auto4", 1450, ["auto3"]),
  {
    id: "clickx",
    name: "One more evaluation per click",
    cost: 2000,
    requires: ["click10"],
    effect: "Each level adds one evaluation to every click, yours and auto-eval's.",
    how: {
      text: [
        `Each level adds one evaluation to every Evolve click, on top of the 10 of the last rung. Auto-eval's clicks grow with yours. ${EVALUATION}`,
      ],
      math: CLICK_MATH("10"),
      vars: CLICK_VARS,
      note: `Each level costs 1.25 times the one before. ${DEALS_PER_CLICK}`,
    },
    row: "clicks",
    levels: { max: 990, growth: 1.25 },
  },
  seedRung("seeds2", 2000, ["seeds", "click7"]),
  autoRung("auto5", 2800, ["auto4"]),
  dealerRung("rank2", 3000, ["queue3"]),
  // ---- well after: methods, one at a time, each dearer than the last ----
  methodRung(
    "basin",
    5000,
    ["click10", "auto4"],
    "You can run basin_hopping, which kicks the packing out of a local optimum and repairs it.",
    BASIN_HOW,
  ),
  {
    id: "reach2",
    name: "Reach: site records",
    cost: 6000,
    requires: ["basin"],
    effect: "The dealer also deals weak site records, which pay 3 times the points.",
    how: {
      text: [
        `${RING_TEXT} With Reach, two in three of the dealer's draws are contested problems.`,
        "A site record is loose when its gap to the area bound exceeds the median gap of the same shapes' records with 3 fewer to 3 more pieces by at least 0.005. Reach deals loose records with N + M + P ≥ 300. The board starts from the leader's packing, and every point an improvement on it pays is multiplied by 3.",
      ],
      math: [
        `${sym("g")} = ${sym("s")} / ${sym("b")} − 1`,
        `loose when ${sym("g")} − median(${sym("g", "near")}) ≥ 0.005`,
        `${sym("N")} + ${sym("M")} + ${sym("P")} ≥ 300`,
      ],
      vars: [
        [sym("g"), "a record's gap to the area bound (its weakness is the difference below)"],
        [sym("s"), "the record's side"],
        [sym("b"), "the area bound, the side at which the pieces would fill the container with no gaps"],
        [sym("g", "near"), "the gaps of the same shapes' records with P − 3 to P + 3 pieces (at least 2 of them)"],
        [sym("N"), "sides of a piece (0 for a circle)"],
        [sym("M"), "sides of the container (0 for a circle)"],
        [sym("P"), "pieces"],
      ],
    },
    row: "problems",
  },
  seedRung("seeds4", 7000, ["seeds2", "basin"]),
  autoRung("auto6", 8000, ["auto5", "basin"]),
  tuneRung("tuneMc", "mc_compress", 8000, ["sweeps10", "basin"]),
  dealerRung("rank4", 9000, ["rank2", "reach2"]),
  methodRung(
    "shrink",
    10000,
    ["basin"],
    "You can run shrink_repair, which shrinks the container and then repairs the overlaps.",
    SHRINK_HOW,
  ),
  {
    id: "advance",
    name: "Auto-advance",
    cost: 11000,
    requires: ["reach2", "queue3"],
    effect: "Problems that stop making progress are replaced, and auto-eval compacts new problems first.",
    how: {
      text: [
        "You set two values in the Queue panel. The tolerance τ is the smallest relative improvement that counts as progress, from 10⁻⁹ to 10⁻³, and 10⁻⁶ at first. The patience W is how many evaluations a problem may run without progress before it is replaced, from 250 to 20,000 or Never, and 1,000 at first.",
        "Each problem in the queue keeps its best side at its last progress, which its first record sets, and counts the evaluations it has run since then. After every e evaluations on it (a click of yours or of auto-eval), the game updates both as below. The queue shows the count, as in “830 since progress”.",
        "While auto-eval is on, a problem whose count reaches W is replaced once a deal is earned (each slot earns a problem per 300 clicks' worth of evaluations) and the dealer has a problem for it, with Your pick the best offer. The old problem then leaves as if you had pressed Drop, its best sent first, and the new one takes its slot, so the queue never shrinks. Until then the lanes work on the other problems. A problem whose seeds are all spent is replaced first, before stalled ones. While your records have no name, a problem with an unsent best is never dropped.",
        "Auto-eval compacts newly dealt problems first (100 evaluations of mc_compress, the work of your first click on a problem). After that a lane keeps to its own problem while it makes progress, and otherwise takes the problem with the fewest evaluations since progress that is still making progress.",
      ],
      math: [
        `${sym("s")} &lt; ${sym("s", "ref")} × (1 − ${sym("τ")}) ⇒ ${sym("s", "ref")} ← ${sym("s")}, ${sym("n")} ← 0`,
        `otherwise ${sym("n")} ← ${sym("n")} + ${sym("e")}`,
        `replaced once ${sym("n")} ≥ ${sym("W")} and a deal is earned`,
      ],
      vars: [
        [sym("s"), "the problem's best side now"],
        [sym("s", "ref"), "its best side at its last progress"],
        [sym("τ"), "the tolerance, 10⁻⁹ to 10⁻³ (10⁻⁶ at first)"],
        [sym("n"), "evaluations run on it since its last progress"],
        [sym("e"), "the evaluations just run on it"],
        [sym("W"), "the patience, 250 to 20,000 evaluations or Never (1,000 at first)"],
      ],
      note: "With the patience at Never nothing leaves, and the lanes count a problem as stalled after 1,000 evaluations without progress. With auto-eval off, nothing leaves by itself.",
    },
    row: "queue",
  },
  pickRung("pick3", 14000, ["rank2", "advance"]),
  methodRung(
    "penalty",
    15000,
    ["shrink"],
    "You can run penalty, which squeezes the container with a smooth overlap penalty and L-BFGS.",
    PENALTY_HOW,
  ),
  {
    id: "lanes2",
    name: "Second lane",
    cost: 18000,
    requires: ["advance"],
    effect: "Auto-eval runs on two problems at once, each in its own solver worker.",
    how: {
      text: [
        `${LANE_TEXT} Your own clicks go to the lane that holds the problem on the board.`,
        "Without Auto-advance the first lane works on the problem on the board and the second on the next problem in the queue. With it, a lane keeps to its own problem while that makes progress, and otherwise moves to the problem with the fewest evaluations since progress that is still making progress.",
      ],
      math: LANE_MATH,
      vars: LANE_VARS,
    },
    row: "queue",
  },
  ringRung("ring200", 20000, ["reach2", "rank4"]),
  {
    id: "filters",
    name: "Dealer filters",
    cost: 20000,
    requires: ["pick3"],
    effect: "You choose which piece shapes, containers, piece counts and tiers the dealer may deal.",
    how: {
      text: [
        "The Queue panel gets a Filters section. You can list the piece shapes and the container shapes allowed, as numbers and ranges such as 0, 3-6, 21-100 (0 is the circle, then 3 to 100 sides). You can also set the fewest and most pieces (1 to 500) and the tiers. An empty list allows everything.",
        "The dealer deals or offers a problem only when it passes every filter. Filters that allow too little can leave it with nothing to deal, and it then waits a while before it tries again.",
      ],
    },
    row: "dealer",
  },
  tuneRung("tuneBasin", "basin_hopping", 20000, ["basin", "tuneMc"]),
  methodRung(
    "lattice",
    21000,
    ["penalty"],
    "You can run seed, which builds new boards from lattices, rows and rings.",
    SEED_HOW,
  ),
  autoRung("auto7", 24000, ["auto6", "lanes2"]),
  {
    id: "rent",
    name: "Records pay rent",
    cost: 25000,
    requires: ["advance"],
    effect: "Every record you still lead pays 1 % of what it earned, every hour.",
    how: {
      text: [
        "Each record you lead pays rent by the hour for as long as you lead it, even while this page is closed. The game checks your records with the server one at a time, each at most once every 10 minutes, and pays the rent since a record's last check, up to a week of it.",
        "When a check or the live feed finds a record taken by another name, the rent since its last check is not paid.",
      ],
      math: RENT_MATH,
      vars: RENT_VARS,
    },
    row: "records",
  },
  queueRung("queue4", 25000, ["advance", "lanes2"]),
  {
    id: "continuous",
    name: "Continuous",
    cost: 26000,
    requires: ["lanes2"],
    effect: "Auto-eval can keep running while this tab is hidden, once you tick its setting.",
    how: {
      text: [
        "Without this upgrade, auto-eval pauses while the tab is hidden. With it, Settings gets a box, off until you tick it, that keeps auto-eval running in a hidden tab.",
        "Browsers slow down the timers of a hidden tab, and may wake them only once a minute. Up to 60 s of auto-eval's clicks wait to be run, so such a tab still loses nothing. Nothing runs once the page is closed.",
      ],
    },
    row: "queue",
  },
  seedRung("seeds8", 28000, ["seeds4", "lattice"]),
  dealerRung("rank8", 30000, ["rank4", "ring200"]),
  methodRung(
    "harden",
    30000,
    ["lattice"],
    "You can run harden, which packs discs and hardens them into the true pieces.",
    HARDEN_HOW,
    true,
  ),
  tuneRung("tuneShrink", "shrink_repair", 30000, ["shrink", "tuneMc"]),
  {
    id: "wide",
    name: "Wider frontier",
    cost: 30000,
    requires: ["queue4"],
    effect: "Half the open problems dealt can have any sides from 21 to 100 and 40 to 500 pieces.",
    how: {
      text: [
        "Open problems have no site entry yet. Without this upgrade they come from the frontier, where N and M are among 21, 24, 27, 30, 33, 36, 40, 44, 47, 50, 55, 60, 66, 72, 80, 90 and 100 and P among 40, 60, 80, 100, 120, 150, 200, 250 and 300.",
        "With it, each draw of an open problem has an even chance to come instead from any N and M from 21 to 100 and any P from 40 to 500, each drawn uniformly. Transfers then also look at the problems with 1 to 3 fewer pieces.",
      ],
      note: "Under the Circles only and Small problems only rules, the rule's own list of problems is used instead.",
    },
    row: "problems",
  },
  {
    id: "collections",
    name: "Collections",
    cost: 35000,
    requires: ["queue3", "reach2"],
    effect: "Completed sets of records add to all your points, for good.",
    how: {
      text: [
        "Collections count the records the server has confirmed, and the count is kept through resets. Each frontier pair (one of the 17 frontier piece shapes in one of the 17 frontier containers) with a record on all 9 of its piece counts adds 2 %. Each piece shape adds 1 % at 10, 30 and 100 records. Each tier (open problem, loose record, site record, published value) adds 5 % once you have its first record.",
        "The bonus multiplies every point you are paid, rent included.",
      ],
      math: [`${sym("m", "c")} = 1 + 0.02 × ${sym("a")} + 0.01 × ${sym("b")} + 0.05 × ${sym("t")}`],
      vars: [
        [sym("m", "c"), "the multiplier from collections"],
        [sym("a"), "frontier pairs complete"],
        [sym("b"), "marks reached by piece shapes (10, 30 and 100 records of one shape)"],
        [sym("t"), "tiers with a first record"],
      ],
    },
    row: "records",
  },
  autoRung("auto8", 38000, ["auto7"]),
  {
    id: "batch",
    name: "Reach: every site record",
    cost: 40000,
    requires: ["ring200"],
    effect: "The dealer also deals site records that are not loose, at 10 times the points.",
    how: {
      text: [
        `${RING_TEXT} This upgrade adds every site record without a published value, loose or not.`,
        "The board starts from the leader's packing, and every point an improvement on it pays is multiplied by 10. These records have been worked on, so the dealer expects only 0.1 of the room an open problem has.",
      ],
    },
    row: "problems",
  },
  tuneRung("tunePenalty", "penalty", 40000, ["penalty", "tuneMc"]),
  methodRung(
    "morph",
    45000,
    ["harden"],
    "You can run morph, which solves with rounded pieces and sharpens them step by step.",
    MORPH_HOW,
    true,
  ),
  {
    id: "retake",
    name: "Retake",
    cost: 45000,
    requires: ["rent"],
    effect: "A record you lose is offered again first, starting from the new leader's packing.",
    how: {
      text: [
        "When the server shows that another name took a record of yours on a problem no longer in your queue, the problem goes on a retake list. At each deal, the oldest problem on that list comes before every other candidate, if it still takes entries and someone else still leads it.",
        "It starts from the new leader's packing, which your board must beat by more than the 10⁻⁹ minimum. A problem whose piece or container has more than 20 sides counts as a loose record (3 times the points). On smaller shapes it is ranked like any site record, or as a published value where there is one.",
      ],
    },
    row: "dealer",
  },
  {
    id: "transfer",
    name: "Transfers",
    cost: 50000,
    requires: ["lattice", "wide"],
    effect: "A new problem can start from the best packing of a neighbour with fewer pieces.",
    how: {
      text: [
        "When a new open problem is placed, the game looks for the best known packing of the same shapes with fewer pieces. That is your own board in the queue, or else the site's record of the nearest piece count it can find (at most 4 lookups). It keeps those pieces where they are and places the missing ones in free space. With 6 or fewer missing, each goes where it grows the container least.",
        "This start is used only when its side is under 98 % of Load all's, the start with every piece on rings around the centre. The starting score, which your first record must beat by more than the 10⁻⁹ minimum, is the smallest of the sides below.",
      ],
      math: [
        `use the transfer when ${sym("s", "t")} &lt; 0.98 × ${sym("s", "L")}`,
        `${sym("s", "0")} = min(${sym("s", "L")}, ${sym("s", "t")}, ${sym("s", "P+1")})`,
      ],
      vars: [
        [sym("s", "t"), "the side of the transferred start (it counts only when used)"],
        [sym("s", "L"), "the side of Load all's start"],
        [sym("s", "0"), "the starting score"],
        [
          sym("s", "P+1"),
          "the site record for one piece more, since dropping a piece from it packs P pieces in no more room",
        ],
      ],
    },
    row: "runs",
    mystery: true,
  },
  {
    id: "lanesx",
    name: "Another lane",
    cost: 60000,
    requires: ["lanes2", "continuous"],
    effect: "Each level adds a lane, up to one less than your CPU's cores.",
    how: {
      text: [LANE_TEXT, "Levels past your cores less one add nothing, so the tree stops offering them."],
      math: LANE_MATH,
      vars: LANE_VARS,
      note: "Each level costs 2.2 times the one before.",
    },
    row: "queue",
    levels: { max: 31, growth: 2.2 },
  },
  {
    id: "rentx",
    name: "Higher rent",
    cost: 60000,
    requires: ["rent"],
    effect: "Each level multiplies the rent of every record by 1.5.",
    how: {
      text: [
        "Each level multiplies every record's rent by 1.5, so level 1 pays 1.5 times the rent, level 2 pays 2.25 times, level 5 about 7.6 times and level 10 about 58 times.",
      ],
      math: RENT_MATH,
      vars: RENT_VARS,
      note: "Each level costs 1.6 times the one before.",
    },
    row: "records",
    levels: { max: 50, growth: 1.6 },
  },
  ringRung("ring120", 60000, ["ring200", "batch"]),
  methodRung(
    "asc",
    60000,
    ["morph"],
    "You can run asc, a Monte Carlo search that also strains and shrinks the whole packing.",
    ASC_HOW,
    true,
  ),
  pickRung("pick5", 70000, ["pick3", "rank8"]),
  seedRung("seeds16", 75000, ["seeds8", "asc"]),
  {
    id: "collector",
    name: "Collector",
    cost: 80000,
    requires: ["collections", "pick3"],
    effect: "Every third deal fills a gap in the collection you are closest to completing.",
    how: {
      text: [
        "A collection here is a frontier pair of shapes with a record on each of its 9 piece counts (40, 60, 80, 100, 120, 150, 200, 250 and 300). On every third deal, the dealer first looks at the pair where you hold the most of those records but not all, and deals a missing problem of it that the server shows is still open.",
        "It checks at most 6 such problems per deal. If none is open, the deal goes on as usual.",
      ],
      math: [`Collector's deal when ${sym("D")} mod 3 = 2`],
      vars: [[sym("D"), "problems dealt before this deal"]],
    },
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
    effect: "The dealer learns which kinds of problem pay you most, and deals more of them.",
    how: {
      text: [
        "The dealer sorts problems into kinds by tier, size (N + M + P of at least 300, 200, 120, 80, 50, 30, or less) and the shapes of piece and container (circle, 3 to 6 sides, 7 to 20, or more). When a problem that ran at least 200 evaluations leaves the queue, its kind learns the ratio r of what it paid per evaluation to what the dealer expected.",
        "When it ranks candidates, the dealer draws one correction θ per kind from what that kind has learned and multiplies the kind's values V by it (see Dealer: best of 2). This is Thompson sampling. Kinds that paid well rank higher, and kinds with little data still get tried now and then.",
      ],
      math: [
        `${sym("r")} = min(20, ${sym("G")} / (${sym("E")} × ${sym("p")}))`,
        `${sym("θ")} = max(0.01, ${sym("μ")} + ${sym("σ")} × ${sym("z")})`,
        `${sym("μ")} = (1 + ${sym("n")} × ${sym("r̄")} / ${sym("v")}) / (1 + ${sym("n")} / ${sym("v")}), ${sym("σ")} = 1 / √(1 + ${sym("n")} / ${sym("v")})`,
      ],
      vars: [
        [sym("r"), "what one problem teaches its kind"],
        [sym("G"), "the record points it earned"],
        [sym("E"), "the evaluations it ran"],
        [sym("p"), "the record points per evaluation the dealer expected (w × c × R × 0.5)"],
        [sym("θ"), "the kind's correction for this ranking"],
        [sym("z"), "a random draw from the standard normal distribution"],
        [sym("μ"), "the kind's expected correction, 1 before it has learned anything"],
        [sym("σ"), "its uncertainty, 1 at first, smaller as it learns"],
        [sym("n"), "problems the kind has learned from"],
        [sym("r̄"), "the mean of their ratios r"],
        [sym("v"), "the variance of their ratios (1 until there are two)"],
      ],
    },
    row: "dealer",
    mystery: true,
  },
  queueRung("queue6", 120000, ["queue4", "collections"]),
  methodRung(
    "growth",
    120000,
    ["asc"],
    "You can run ls_growth, which grows the pieces inside a fixed container until they jam.",
    GROWTH_HOW,
    true,
  ),
  {
    id: "autox",
    name: "Faster auto-eval",
    cost: 150000,
    requires: ["auto9"],
    effect: `Each level makes auto-eval click ${Math.round((AUTOX_GROWTH - 1) * 100)} % more often.`,
    how: {
      text: [
        `Each level multiplies auto-eval's clicks per second by ${AUTOX_GROWTH}, starting from the ${number(AUTO.auto9!)} a second of the last Auto-eval rung. Level 1 gives ${number(AUTO.auto9! * AUTOX_GROWTH)} clicks a second in each lane, level 5 about ${Math.round(AUTO.auto9! * AUTOX_GROWTH ** 5)} and level 10 about ${Math.round(AUTO.auto9! * AUTOX_GROWTH ** 10)}.`,
      ],
      math: [
        `${sym("c")} = ${number(AUTO.auto9!)} × ${AUTOX_GROWTH}<sup>${sym("a")}</sup>`,
        `${sym("e")} = ${sym("c")} × ${K} × ${sym("L")}`,
      ],
      vars: [
        [sym("c"), "auto-eval's clicks per second in each lane"],
        [sym("a"), "levels of Faster auto-eval"],
        ...AUTO_VARS,
      ],
      note: `${AUTO_NOTE} Once an evaluation takes longer than the pace allows, more levels add nothing. Each level costs 1.4 times the one before.`,
    },
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
    effect: "With Auto chosen, the game picks each new run's method from what has paid.",
    how: {
      text: [
        "Problems are sorted into kinds by tier, size (N + M + P of at least 300, 200, 120, 80, 50, 30, or less) and piece shape (circle, 3 to 8 sides, 9 to 20, or more). Every run that ends or is replaced after at least 20 evaluations teaches its arm, one method at one setting on one kind, the record points it earned per evaluation. The game learns from every run, before you buy this too.",
        "With Auto chosen in the Method list, each new run draws a plausible value θ for every method you own from what its arm has learned, and runs the method with the highest. This is Thompson sampling. An untried arm is expected to pay the mean of the arms tried on that kind, with a spread as wide as that mean, so new methods get tried.",
      ],
      math: [
        `${sym("y")} = ${sym("G")} / ${sym("E")}`,
        `${sym("θ")} = ${sym("μ")} + ${sym("σ")} × ${sym("z")}`,
        `${sym("μ")} = (${sym("μ", "0")} / ${sym("σ", "0")}<sup>2</sup> + ${sym("n")} × ${sym("ȳ")} / ${sym("v")}) / (1 / ${sym("σ", "0")}<sup>2</sup> + ${sym("n")} / ${sym("v")})`,
        `${sym("σ")} = 1 / √(1 / ${sym("σ", "0")}<sup>2</sup> + ${sym("n")} / ${sym("v")})`,
      ],
      vars: [
        [sym("y"), "what one run teaches its arm"],
        [sym("G"), "the record points the run earned, before multipliers"],
        [sym("E"), "the evaluations it ran"],
        [sym("θ"), "the arm's draw for this choice"],
        [sym("z"), "a random draw from the standard normal distribution"],
        [sym("μ"), "the arm's expected value"],
        [sym("σ"), "its uncertainty"],
        [sym("μ", "0"), "the mean y of the arms tried on this kind (0 before any)"],
        [sym("σ", "0"), "the spread of those arms' means, at least |μ₀| (1 before any)"],
        [sym("n"), "runs the arm has learned from"],
        [sym("ȳ"), "the mean of their y"],
        [sym("v"), "the variance of their y (σ₀² until there are two)"],
      ],
      note: "Compact's runs teach nothing. Pipelines, when set, decide the method before Method match does.",
    },
    row: "runs",
    mystery: true,
  },
  tuneRung("tuneGrowth", "ls_growth", 300000, ["growth"], true),
  ringRung("ring50", 400000, ["ring80"], true),
  seedRung("seeds32", 400000, ["seeds16", "growth"]),
  {
    id: "published",
    name: "Reach: published values",
    cost: 500000,
    requires: ["batch", "ring120"],
    effect: "The dealer also deals problems with a published value, at 100 times the points.",
    how: {
      text: [
        `${RING_TEXT} This upgrade adds problems with a best-known value in the literature. Proven values are never dealt.`,
        "The board starts from the best packing the site can draw, a site record or the published coordinates. Nothing pays until your board goes below the target T, and from there every point is multiplied by 100. A record below a published value waits for an administrator's review. The dealer expects little room, 0.004 of an open problem's, since many published values are excellent.",
      ],
      math: [`${sym("T")} = ${sym("v")} − 10<sup>−${sym("d")}</sup>`],
      vars: [
        [sym("T"), "the side your board must go below"],
        [sym("v"), "the published value as printed"],
        [sym("d"), "the digits printed after its decimal point"],
      ],
    },
    row: "problems",
    mystery: true,
  },
  {
    id: "standing",
    name: "Standing",
    cost: 750000,
    requires: ["collections", "rent", "ring120"],
    effect: "You can reset the tree for standing, and each point of standing adds 10 % to all points.",
    how: {
      text: [
        "A reset ends the cycle, the play since the last reset. Your record points and most of the tree go back to zero, and you get standing. You can reset once the cycle has earned 250,000 record points that the server has confirmed.",
        "Your records stay on the server and keep paying rent. Your collection counts, the dealer's learning and the queue stay, and so do the upgrades Records pay rent, Higher rent and Collections. Every point of standing ever earned adds 10 % to all record points, spent or not, and standing buys the Standing row.",
      ],
      math: [
        `${sym("S")} = ⌊√(${sym("E")} / 250,000) + ${sym("H")} / 50⌋, at least 1`,
        `${sym("m", "s")} = 1 + 0.1 × ${sym("S", "all")}`,
      ],
      vars: [
        [sym("S"), "the standing a reset gives"],
        [sym("E"), "the record points of this cycle that the server has confirmed (at least 250,000)"],
        [sym("H"), "the records you hold"],
        [sym("m", "s"), "the multiplier standing puts on every record point"],
        [sym("S", "all"), "the standing you have ever earned"],
      ],
    },
    row: "records",
    mystery: true,
  },
  ringRung("ring30", 1_000_000, ["ring50"], true),
  ringRung("ringAll", 3_000_000, ["ring30"], true),
  // ---- standing: paid in standing, kept through resets ----
  standingRung(
    "head1",
    "Head start I",
    1,
    ["standing"],
    "Each new cycle starts with 2 to 5 evaluations per click and Auto-eval.",
    {
      text: [
        "At every reset, the next cycle begins owning Trace detail, 2, 3, 4 and 5 evaluations per click, and Auto-eval at a click every 5 s.",
      ],
    },
  ),
  standingRung(
    "head2",
    "Head start II",
    3,
    ["head1"],
    "Each new cycle also starts with Basin hopping, the queue of 3 and 2 seeds.",
    {
      text: [
        "At every reset, the next cycle also begins owning Method: basin_hopping and what it needs (6 to 10 evaluations per click), Auto-eval up to a click a second, Problem queue: 3, the Seed counter and Seeds: 2 per problem.",
      ],
    },
  ),
  standingRung(
    "rules",
    "Cycle rules",
    3,
    ["standing"],
    "Before a reset you can choose a rule for the next cycle, which earns a lasting reward.",
    {
      text: [
        "Before a reset, you can choose a rule for the next cycle in the Standing panel. The cycle is played under it, and the reset that ends that cycle pays extra standing and gives the rule's reward for good.",
        "Circles only deals only problems with circle pieces or a circle container, and its reward is 1.5 times the points on every problem with circles. Small problems only deals only problems with N + M + P of at most 120, for 1.5 times the points on those. One seed allows one seed per problem, for twice the seeds per problem. Clicks only turns auto-eval off, for one more evaluation per click. One method allows only mc_compress, for 1.5 times the points on improvements mc_compress finds.",
      ],
      math: [`${sym("S", "rule")} = max(1, ⌈${sym("S")} / 2⌉)`],
      vars: [
        [sym("S", "rule"), "the extra standing for finishing a cycle under a rule"],
        [sym("S"), "the standing the reset gives otherwise"],
      ],
      note: "Rewards multiply with each other and with your other multipliers.",
    },
  ),
  standingRung(
    "pipeline",
    "Pipelines",
    4,
    ["standing"],
    "You order your methods, and each new seed on a problem runs the next one.",
    {
      text: [
        "In the Runs panel you list up to 9 methods in order. Each time a run on a problem ends by itself, the next run there uses the next method in the list, and after the last it starts again at the first. A method the cycle's rule forbids is skipped. A run the game closed (for another problem, or a reload) opens again with the same method.",
        "With Auto-tune and Auto chosen, the setting of each run is drawn as Auto-tune draws it. Otherwise each method runs at the tuning level you own. Compact still uses mc_compress.",
      ],
      math: [`stage of the next run = ${sym("r")} mod ${sym("n")}, counting stages from 0`],
      vars: [
        [sym("r"), "runs on the problem that ended by themselves"],
        [sym("n"), "stages in the list"],
      ],
    },
  ),
  standingRung(
    "keepAuto",
    "Keep auto-eval",
    5,
    ["head1"],
    "Your Auto-eval upgrades survive resets, Faster auto-eval's levels included.",
    {
      text: [
        "At a reset, every upgrade of the Auto-eval row stays owned. That is Auto-eval, its eight faster rungs, and Faster auto-eval with its levels. Under the Clicks only rule auto-eval is still off for that cycle.",
      ],
    },
  ),
  standingRung(
    "autoTune",
    "Auto-tune",
    6,
    ["standing"],
    "With Auto chosen, the game also picks each run's tuning level from what has paid.",
    {
      text: [
        "Auto-tune adds every tuning level you own, from 0 up to your level, as arms of Method match, so a run may use a lower setting where that paid more on this kind of problem. It makes Auto available in the Method list even without Method match, and draws as Method match does.",
      ],
      math: [`arms = kind × method × level ${sym("l")}, for ${sym("l")} = 0, 1, …, ${sym("l", "m")}`],
      vars: [
        [sym("l"), "a tuning level"],
        [sym("l", "m"), "the level you own of method m's tuning"],
      ],
    },
  ),
  standingRung(
    "head3",
    "Head start III",
    8,
    ["head2"],
    "Each new cycle also starts with Auto-advance, the second lane and Reach.",
    {
      text: [
        "At every reset, the next cycle also begins owning Reach: site records, Auto-advance and the Second lane, with what they need.",
      ],
    },
  ),
  standingRung("keepMethods", "Keep methods", 10, ["keepAuto"], "The methods you own survive resets.", {
    text: [
      "At a reset, every Method upgrade you own stays owned (basin_hopping, shrink_repair, penalty, seed, harden, morph, asc and ls_growth). Their tuning upgrades go back to zero. Under the One method rule only mc_compress runs in that cycle.",
    ],
  }),
  standingRung(
    "study",
    "Quick study",
    2,
    ["standing"],
    "Each level makes every record-point price 10 % cheaper.",
    {
      text: [
        "Each level multiplies every price in record points by 0.9. Level 1 gives 0.9 of the price, level 2 gives 0.81, level 5 about 0.59 and level 10 about 0.35. Prices in standing do not change.",
      ],
      math: [`${sym("p")} = round(${sym("p", "0")} × 0.9<sup>${sym("a")}</sup>)`],
      vars: [
        [sym("p"), "the price you pay, in record points"],
        [sym("p", "0"), "the price without Quick study"],
        [sym("a"), "levels of Quick study"],
      ],
      note: "Each level costs 1.6 times the one before, in standing.",
    },
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

/** Auto-eval's clicks per second (per lane), or null without it. */
export function autoClicksPerSecond(o: Owned): number | null {
  // the "clicks only" cycle rule: no auto-eval in this cycle
  if (!o.has("auto1") || o.rule === "clicks") return null;
  return highest(o, AUTO, 0, (a, b) => a > b) * Math.pow(AUTOX_GROWTH, level(o, "autox"));
}

/** Auto-eval's evaluations per second (per lane): its clicks a second, each of the player's click size. */
export function autoPerSecond(o: Owned): number | null {
  const c = autoClicksPerSecond(o);
  return c === null ? null : c * evalsPerClick(o);
}

/**
 * Auto-eval's pace as the page shows it, from its evaluations a second (all lanes): "a click of 4
 * every 5 s", "2 clicks of 10 a second"; with one evaluation a click, in evaluations.
 */
export function autoRateText(o: Owned, perSecond: number): string {
  const k = evalsPerClick(o);
  const c = perSecond / k;
  if (k === 1) return c < 1 ? `1 evaluation every ${seconds(1 / c)}` : `${number(c)} evaluations a second`;
  return c < 1 ? `a click of ${k} every ${seconds(1 / c)}` : `${number(c)} click${c === 1 ? "" : "s"} of ${k} a second`;
}

/**
 * Seconds of auto-eval a lane may fall behind and still catch up: a hidden tab's timers may wake
 * only once a minute. Nothing is earned while auto-eval cannot run (off, held, or the page closed).
 */
export const AUTO_SLACK_SECONDS = 60;

/** Most evaluations auto-eval may be due at once: a minute of every lane's rate, and at least a Compact. */
export function autoCap(o: Owned, lanes = 1): number {
  return Math.max(COMPACT_EVALS, (autoPerSecond(o) ?? 0) * lanes * AUTO_SLACK_SECONDS);
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
