import { AUTO_CLICK_EVALS, DEAL_CLICKS } from "./dealer";
import type { DimensionId, Family } from "./frontier";
import { sym } from "./how";
import type { How, Var } from "./how";
import { METHOD_GAMES, isSelectable, methodGame, methodLabel, warmupOf } from "./methods";
import { MC_COMPRESS_MATH, MC_COMPRESS_TEXT, MC_COMPRESS_VARS } from "./methods/mc_compress";
import { presetParams, tuningLevels } from "./presets";
import { RESET_GROWTH, RESET_MIN } from "./points";
import { BALLS_CODES } from "@polypack/balls/catalogue";
import { PAIR_COUNT } from "@polypack/polyhedra/catalogue";
import { DOMAIN_MAX_P, SURFACE_ARCHIMEDEAN, domainProblems } from "./catalogue";
import { SliceId, sliceById, solidsOfSlice } from "./slices";
import { RP_PER_EVAL, msPerEval } from "./rank";

/**
 * The tech tree. Progress is slow on purpose: a click is one evaluation of an open run at first, and
 * each upgrade adds a little. Evaluations per click climb one at a time. Auto-eval runs evaluations
 * for the player at its own rate, 1 a second with its first rung and 150 with its tenth, and only its
 * own rungs (and Faster auto-eval) speed it up: evaluations-per-click upgrades do not. The rate is
 * auto-eval's in all: the lanes share it, so a lane lets one more problem progress at once but adds
 * no evaluations. Faster auto-eval adds 10 a second a level up to 250, a target the player's CPU
 * caps where it cannot keep up: about 44 % of a core at N+M+P = 85, a whole core from about
 * N+M+P = 130 up (rank.ts), where more lanes spread it over more cores [CALC]. Methods come well
 * after, one at a time, each dearer than the last; method settings are bought too. Every
 * finite ladder ends in a levelled upgrade that can be bought again and again at a growing price, so
 * nothing has a last rung (Faster auto-eval excepted: its limit tops it out).
 *
 * The whole tree shows in the shop. A mystery upgrade shows as ?????? until every prerequisite is
 * owned. Standing upgrades are paid in standing (the reset currency) and are kept through resets.
 *
 * Costs (2026-10-22, with the size and gap weights at 10,000, points.ts): priced in a pacing model of
 * real mc_compress runs from Load all (16 games of one click a second, the first problem from the
 * starter corner and the rest from the frontier, a new problem taken whenever one is earned,
 * upgrades bought cheapest first; PolyPack-ideas/idle-games/tighter/methods-2026-10-22/economy.md),
 * so that each upgrade is bought, on average, when it was at the prices of the weights of 100: 2 per
 * click after about a minute, 5 per click after 8, 10 per click after 42, Basin hopping after about
 * 72 minutes, Auto-advance after about 2 hours 15 [CALC]. The model earns about 8 times the points
 * it did at 3 hours, so from Basin hopping on every price is 8 times what it was. The ladder before
 * it is set by hand to the model's pace [CALC], and the tree past the model's 3 hours keeps the
 * factor of 8 [SPEC]. A problem's first record (Compact) now pays about 1,000 to 2,900 RP on the
 * starter corner, so Trace detail costs 400 and the first record goes on toward 2 per click. The
 * Auto-eval rungs keep their tenth: each still costs a small part of the rung that gates it, so it
 * is bought as soon as its gate opens: Auto-eval with 2 per click, then 3 and 4 per click, 7 per
 * click, 10 per click, Basin hopping, the Second lane and asc. Its rates follow the targets of the time when auto-eval
 * clicked at the player's click size [SPEC]: half to three quarters of an active player's
 * evaluations (one click a second) before 10 per click, as many at 10 per click, then more with
 * methods and lanes, near the 120 a second in each lane its ninth rung ran then. The plan:
 * PolyPack-ideas/idle-games/tighter/plan-2026-10-20-long-game.md.
 *
 * The rest of the game reads what the player owns only through the functions below.
 */

export type EvolveMethod =
  "mc_compress" | "basin_hopping" | "shrink_repair" | "seed" | "penalty" | "harden" | "asc" | "morph" | "ls_growth";

const EVOLVE_METHODS: readonly EvolveMethod[] = [
  "mc_compress",
  "basin_hopping",
  "shrink_repair",
  "seed",
  "penalty",
  "harden",
  "asc",
  "morph",
  "ls_growth",
];

/** The evolve methods a family has: today's list for polygons, none for the families still to come (not wired yet). */
export const methodsFor = (family: Family): readonly EvolveMethod[] => (family === "polygon" ? EVOLVE_METHODS : []);

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
  | "auto10"
  | "autox"
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
  // problems: tiers, size rings, more open problems
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
  | "autoTune"
  // dimensions: the slices of the catalogue with a card (slices.ts)
  | CardSliceId;

/** The slices that are bought with a card (the others open with their dimension). */
export type CardSliceId = Exclude<SliceId, "surf-platonic" | "poly-archimedean">;

/** The shop's rows, in the order they are shown. */
export type Row =
  "clicks" | "auto" | "queue" | "methods" | "runs" | "problems" | "dimensions" | "dealer" | "records" | "standing";

export const ROWS: readonly { id: Row; title: string }[] = [
  { id: "clicks", title: "Clicks" },
  { id: "auto", title: "Auto-eval" },
  { id: "queue", title: "Queue and lanes" },
  { id: "methods", title: "Methods" },
  { id: "runs", title: "Runs" },
  { id: "problems", title: "Problems" },
  { id: "dimensions", title: "Dimensions" },
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
 * standing rule can take something away, such as auto-eval), the rules finished (whose rewards
 * hold for good), and the switches turned off (SWITCHES: owned, but not in use).
 */
export type Owned = ReadonlySet<UpgradeId> & {
  readonly levels?: Levels;
  readonly rule?: string | null;
  readonly rewards?: readonly string[];
  readonly off?: ReadonlySet<UpgradeId>;
  /** Resets so far: the cycle's threshold, and with it the price of a dimension's cards. */
  readonly resets?: number;
  /** The dimensions open (the first only when missing): their cards exist, the others' do not. */
  readonly dimensions?: readonly DimensionId[];
};

/** An Owned from ids, levels, the cycle's rule, the rules finished and the switches turned off. */
export function owning(
  ids: Iterable<UpgradeId>,
  levels: Levels = {},
  rule: string | null = null,
  rewards: readonly string[] = [],
  off: Iterable<UpgradeId> = [],
  resets = 0,
  dimensions: readonly DimensionId[] = ["2-in-2"],
): Owned {
  const set = new Set(ids) as Set<UpgradeId> & {
    levels?: Levels;
    rule?: string | null;
    rewards?: readonly string[];
    off?: ReadonlySet<UpgradeId>;
    resets?: number;
    dimensions?: readonly DimensionId[];
  };
  set.levels = levels;
  set.rule = rule;
  set.rewards = rewards;
  set.off = new Set(off);
  set.resets = resets;
  set.dimensions = dimensions;
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
 * Auto-eval's evaluations a second, all lanes together, by upgrade: slowly while the player's own
 * clicks are small, then about doubling a rung. The rate is in evaluations, not clicks:
 * evaluations-per-click upgrades leave it as it is. A save keeps its rungs, at these rates (save.ts).
 */
const AUTO: Partial<Record<UpgradeId, number>> = {
  auto1: 1,
  auto2: 2,
  auto3: 3,
  auto4: 5,
  auto5: 10,
  auto6: 20,
  auto7: 35,
  auto8: 60,
  auto9: 100,
  auto10: 150,
};
/** The Auto-eval rungs' evaluations a second, slowest first. */
export const AUTO_RATES: readonly number[] = Object.values(AUTO).sort((a, b) => a - b);
/**
 * The most evaluations a second auto-eval asks for, all lanes together. It is a target: where the
 * player's CPU cannot keep up, auto-eval runs as fast as it can [SPEC]. 250 keep about 44 % of one
 * core busy at N+M+P = 85 (1.77 ms an evaluation, rank.ts) and need a whole core from about
 * N+M+P = 130 up; there the lanes, each a worker of its own, spread it over more cores [CALC].
 */
export const AUTO_MAX = 250;
/** Faster auto-eval's evaluations a second a level. */
export const AUTOX_STEP = 10;
/** Levels of Faster auto-eval, from the last rung up to AUTO_MAX: 10. */
const AUTOX_LEVELS = (AUTO_MAX - AUTO.auto10!) / AUTOX_STEP;
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

/** "a, b and c". */
const listed = (xs: readonly string[]) =>
  xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
/** A number as the shop writes it: whole, or to one decimal ("2.5"). */
const number = (x: number) => (Math.abs(x - Math.round(x)) < 1e-9 ? String(Math.round(x)) : x.toFixed(1));
const seconds = (x: number) => `${number(x)} s`;

// ---------- the explanations (How, how.ts) ----------
// Every number below is read from the code that implements the upgrade: the tables above, the
// dealer and the economy, and the solver's methods (packages/solver/src/methods, whose texts are in
// each method's file in methods/).

const K = sym("k");
const VAR_K: Var = [K, "evaluations per click"];
const EVALUATION =
  "An evaluation is one scoring of the whole packing by the solver, which checks the pieces for overlaps and measures the container around them.";
const DEALS_PER_CLICK = `New problems are earned per ${DEAL_CLICKS} clicks. Each Evolve click of yours counts as one click whatever its evaluations, so more evaluations per click do not bring them faster per click. Auto-eval's evaluations count ${AUTO_CLICK_EVALS} to the click.`;

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
        `With this upgrade a click runs ${n} evaluations of the same run, one after another. Auto-eval keeps its own rate in evaluations a second, which this upgrade does not change.`,
      ],
      math: CLICK_MATH(String(n)),
      vars: CLICK_VARS,
      note: DEALS_PER_CLICK,
    },
    row: "clicks",
  };
}

/** Each lane's share of auto-eval's rate, and the rate with it. */
const SHARE_MATH = `${sym("r", "lane")} = ${sym("r")} / ${sym("L")}`;
const AUTO_MATH = (r: string) => [`${sym("r")} = ${r}`, SHARE_MATH];
const AUTO_VARS: readonly Var[] = [
  [sym("r"), "auto-eval's target in evaluations a second, all lanes together"],
  [sym("r", "lane"), "the share of each lane, in evaluations a second"],
  [sym("L"), "lanes, the solver workers that run at once (1 until Second lane)"],
];
const AUTO_NOTE =
  "Your computer sets the upper limit. When it cannot keep up, auto-eval runs as fast as it can, and at most 60 s of its evaluations (at least 100) wait to be run.";
const AUTO_RATE =
  "Its rate is in evaluations a second, whatever your evaluations per click. Upgrades of evaluations per click make your own clicks larger, and only the Auto-eval upgrades and Faster auto-eval speed auto-eval up.";
const AUTO_SHARE =
  "The rate is for all your lanes together. The lanes share it, so with L lanes each one runs r / L evaluations a second. More lanes let more problems progress at once, but they add no evaluations.";
/** The smallest N+M+P at which one evaluation takes at least a second's share of `perSecond` (rank.ts's table). */
function coreBound(perSecond: number): number {
  let t = 2;
  while (msPerEval(t) < 1000 / perSecond) t++;
  return t;
}

function autoRung(id: UpgradeId, cost: number, requires: UpgradeId[]): Upgrade {
  const r = AUTO[id]!;
  const prev = Math.max(0, ...Object.values(AUTO).filter((x) => x < r));
  const first = id === "auto1";
  return {
    id,
    name: first ? "Auto-eval" : `Auto-eval: ${autoRateText(r)}`,
    cost,
    requires,
    effect: first
      ? `Auto-eval runs ${autoRateText(r)} for you while it is switched on.`
      : `Auto-eval runs ${autoRateText(r)} in all instead of ${number(prev)}.`,
    how: {
      text: first
        ? [
            `Auto-eval runs evaluations on a problem's open run for you, beside your own clicks, at a rate of ${autoRateText(r)}. ${EVALUATION}`,
            AUTO_RATE,
            "It runs while its switch is on and this page is open. It pauses in a hidden tab unless Continuous lets it go on, and on battery power (where the browser reports it) unless you allow that in Settings. Nothing builds up while it is paused or off.",
            "Without Auto-advance it works only on problems you have already compacted (your first click on a new problem). The first lane works on the problem on the board, and any other lane on the next problems in the queue.",
            AUTO_SHARE,
          ]
        : [
            `Auto-eval now runs ${autoRateText(r)} instead of ${autoRateText(prev)}. A lane is a solver worker that runs one problem at a time.`,
            AUTO_SHARE,
            AUTO_RATE,
          ],
      math: AUTO_MATH(number(r)),
      vars: AUTO_VARS,
      note: AUTO_NOTE,
    },
    row: "auto",
  };
}

/** The work a deal is earned by, in clicks (dealer.ts creditOf). */
const DEAL_CREDIT = `${sym("c")} = ${sym("e", "you")} / ${K} + ${sym("e", "auto")} / ${AUTO_CLICK_EVALS}`;
const DEAL_VARS: readonly Var[] = [
  [sym("c"), "the work done since the last update, in clicks"],
  [sym("e", "you"), "the evaluations of your own clicks since then (an Evolve click runs k, Compact 100)"],
  [sym("e", "auto"), "auto-eval's evaluations since then"],
  VAR_K,
];

function queueRung(id: UpgradeId, cost: number, requires: UpgradeId[]): Upgrade {
  const q = QUEUE[id]!;
  const t = sym("t");
  return {
    id,
    name: `Problem queue: ${q}`,
    cost,
    requires,
    effect: `The queue holds ${q} problems, and the dealer earns a new one every ${number(DEAL_CLICKS / q)} clicks.`,
    how: {
      text: [
        "The queue holds the problems you work on, one per slot. A deal gives a free slot a new problem. The dealer earns deals as you and auto-eval work, and saves up at most one deal per slot. When a slot is free and a deal is saved, it deals at once. When the queue is empty, it deals a problem without a saved deal, and the next work pays that back.",
        `Work counts in clicks. Each Evolve click of yours counts as one, whatever its evaluations, and ${AUTO_CLICK_EVALS} evaluations of auto-eval count as one click.`,
        "A problem leaves the queue when you drop it, or when Auto-advance replaces it.",
      ],
      math: [
        `${t} ← min(${sym("q")}, ${t} + ${sym("q")} × ${sym("c")} / ${DEAL_CLICKS})`,
        DEAL_CREDIT,
        `deal when ${t} ≥ 1, then ${t} ← ${t} − 1`,
      ],
      vars: [
        [t, "deals saved up (below 0 after a deal made without one)"],
        [sym("q"), `slots in the queue, ${q} with this upgrade`],
        ...DEAL_VARS,
      ],
      note: `With ${q} slots that is one deal per ${number(DEAL_CLICKS / q)} clicks, or per ${Math.round((DEAL_CLICKS / q) * AUTO_CLICK_EVALS).toLocaleString("en-US")} evaluations of auto-eval.`,
    },
    row: "queue",
  };
}

const SELECT = "Choose it in the Method list beside Evolve, and your next click opens a run with it.";
/** A method's card: its name, effect and How come from its file in methods/. */
function methodRung(id: UpgradeId, cost: number, requires: UpgradeId[], mystery = false): Upgrade {
  const m = METHOD[id]!;
  const g = methodGame(m);
  const name = g.name ?? `Method: ${methodLabel(m)}`;
  return { id, name, cost, requires, effect: g.effect!, how: g.how!(SELECT), row: "methods", mystery };
}

/**
 * The tuned parameters at the solver's defaults (level 0), for the tuning cards, from each method's
 * file; a test checks them against the solver's own defaults. mc_compress's level 0 is 10 sweeps: its
 * tuning needs "10 sweeps per evaluation".
 */
export const TUNED_DEFAULTS: Partial<Record<EvolveMethod, Record<string, number>>> = Object.fromEntries(
  (Object.entries(METHOD_GAMES) as [EvolveMethod, (typeof METHOD_GAMES)[EvolveMethod]][])
    .filter(([, g]) => g.tunedDefaults)
    .map(([m, g]) => [m, g.tunedDefaults!]),
);

function tuneRung(id: UpgradeId, method: EvolveMethod, cost: number, requires: UpgradeId[], mystery = false): Upgrade {
  const n = Math.max(1, tuningLevels(method));
  const levels = Array.from({ length: n + 1 }, (_, l) => ({
    ...TUNED_DEFAULTS[method],
    ...presetParams(method, l, true),
  }));
  const g = methodGame(method);
  const m = methodLabel(method);
  const keys = Object.keys(TUNED_DEFAULTS[method] ?? {});
  const time = g.tunedTime;
  return {
    id,
    name: `${m} tuning`,
    cost,
    requires,
    effect:
      g.tuneEffect ??
      (n === 1
        ? `Gives ${m} a setting that paid more per evaluation in tests.`
        : `Each level gives ${m} a setting that does more search per evaluation.`),
    how: {
      text: [
        `${n === 1 ? "The level sets" : `Each level sets`} ${m}'s parameters as below, from level 0 (${g.tuneBase ?? "the solver's defaults"}) to level ${n}. Runs use the new setting from your next click.`,
        g.tuneNote ??
          `A level was kept only where it cut the side at least as much per evaluation as the level below (within 0.05 percentage points) on three test problems (40 21-gons in a 24-gon, 80 36-gons in a 33-gon and 30 heptagons in a heptagon).${time ? ` An evaluation takes ${time} at the top level, which matters only when your computer limits auto-eval.` : ""}`,
      ],
      math: keys.map((k) => `<code>${k}</code> = ${levels.map((l) => String(l[k as keyof typeof l])).join(", ")}`),
      vars: keys.map((k) => [`<code>${k}</code>`, `${g.tunedMeaning?.[k]}, at levels 0 to ${n}`]),
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
        `V is the record points the candidate is expected to pay per evaluation, scaled up for problems that evaluate faster. ${number(RP_PER_EVAL)} is about the record points an evaluation earns on a fresh open problem with w = 1. The square root splits the difference between your clicks, which count the same however long an evaluation takes, and auto-eval, which your computer's speed limits on larger problems.`,
      ],
      math: [
        `${sym("V")} = ${sym("w")} × ${sym("c")} × ${sym("R")} × ${number(RP_PER_EVAL)} × ${sym("θ")} × √(${sym("t", "85")} / ${sym("t")})`,
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

const LANE_MATH = [`${sym("L")} = min(2 + ${sym("a")}, max(2, ${sym("C")} − 1))`, SHARE_MATH];
const LANE_VARS: readonly Var[] = [
  [sym("L"), "lanes"],
  [sym("a"), "levels of Another lane"],
  [sym("C"), "your CPU's cores, as the browser reports them (4 when it does not say)"],
  [sym("r"), "auto-eval's target in evaluations a second, all lanes together"],
  [sym("r", "lane"), "the share of each lane, in evaluations a second"],
];
const LANE_TEXT =
  "A lane is a solver worker, a thread of the browser that holds one open run. Two lanes never work on the same problem, since one run's evaluations cannot be split. The lanes share auto-eval's rate, so each new lane lets one more problem progress at once but adds no evaluations. A lane with nothing to work on leaves its share to the others. When evaluations take so long that one core cannot keep up with the rate, more lanes spread the work over more cores.";

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

/** A method whose runs have a warm-up (methods/ warmup), with its evaluations at tuning level 0. */
export interface Warmup {
  label: string;
  evals: number;
  /** Which of its runs have it, after "every morph run" (methods/ warmupRuns): "on polygon pieces". */
  runs?: string;
}

/** The methods whose runs begin with a warm-up, in the table's order. */
function warmups(): Warmup[] {
  return (Object.keys(METHOD_GAMES) as EvolveMethod[])
    .map((m) => ({
      label: methodLabel(m),
      evals: warmupOf(m, presetParams(m, 0, true)),
      ...(methodGame(m).warmupRuns ? { runs: methodGame(m).warmupRuns } : {}),
    }))
    .filter((w) => w.evals > 0);
}

/**
 * Auto-advance's How. With methods whose runs have a warm-up (`warm`, from the table by default), it
 * says that those evaluations do not add to the count, and the formula takes them out.
 */
export function advanceHow(warm: readonly Warmup[] = warmups()): How {
  const firsts = listed(
    warm.map(
      (w, i) =>
        `the first ${w.evals.toLocaleString("en-US")}${i === 0 ? " evaluations" : ""} of every ${w.label} run${w.runs ? ` ${w.runs}` : ""}`,
    ),
  );
  const n = sym("n");
  const e = sym("e");
  return {
    text: [
      "You set two values in the Queue panel. The tolerance τ is the smallest relative improvement that counts as progress, from 10⁻⁹ to 10⁻³, and 10⁻⁶ at first. The patience W is how many evaluations a problem may run without progress before it is replaced, from 250 to 20,000 or Never, and 1,000 at first.",
      "Each problem in the queue keeps its best side at its last progress, which its first record sets, and counts the evaluations it has run since then. After every e evaluations on it (a click of yours, or a batch that auto-eval runs), the game updates both as below. The queue shows the count, as in “830 since progress”." +
        (warm.length
          ? ` ${firsts.charAt(0).toUpperCase()}${firsts.slice(1)} ${warm.length === 1 ? "are its" : "are their"} warm-up, and they do not add to the count.`
          : ""),
      `While auto-eval is on, a problem whose count reaches W is replaced once a deal is earned (each slot earns a problem per ${DEAL_CLICKS} clicks, and ${AUTO_CLICK_EVALS} evaluations of auto-eval count as one click) and the dealer has a problem for it, with Your pick the best offer. The old problem then leaves as if you had pressed Drop, its best sent first, and the new one takes its slot, so the queue never shrinks. Until then the lanes work on the other problems. While your records have no name, a problem with an unsent best is never dropped.`,
      "Auto-eval compacts newly dealt problems first (100 evaluations of mc_compress, the work of your first click on a problem). After that a lane keeps to its own problem while it makes progress, and otherwise takes the problem with the fewest evaluations since progress that is still making progress.",
    ],
    math: [
      `${sym("s")} &lt; ${sym("s", "ref")} × (1 − ${sym("τ")}) ⇒ ${sym("s", "ref")} ← ${sym("s")}, ${n} ← 0`,
      warm.length ? `otherwise ${n} ← ${n} + ${e} − ${sym("e", "warm")}` : `otherwise ${n} ← ${n} + ${e}`,
      `replaced once ${n} ≥ ${sym("W")} and a deal is earned`,
    ],
    vars: [
      [sym("s"), "the problem's best side now"],
      [sym("s", "ref"), "its best side at its last progress"],
      [sym("τ"), "the tolerance, 10⁻⁹ to 10⁻³ (10⁻⁶ at first)"],
      [n, "evaluations run on it since its last progress"],
      [e, "the evaluations just run on it"],
      ...(warm.length
        ? [[sym("e", "warm"), `the evaluations among e in a run's warm-up, ${firsts} (0 for other runs)`] as const]
        : []),
      [sym("W"), "the patience, 250 to 20,000 evaluations or Never (1,000 at first)"],
    ],
    note: "With the patience at Never nothing leaves, and the lanes count a problem as stalled after 1,000 evaluations without progress. With auto-eval off, nothing leaves by itself.",
  };
}

// ---------- dimensions: the cards of the slices (slices.ts) ----------

/**
 * What a slice card costs, as a share of the cycle's reset threshold T [SPEC]: the ladder of each
 * dimension is priced against the cycle it opens in, so that it is bought in that cycle's first
 * hours (2D on 3D) or its middle (3D in 3D), and the late cards near its end. One table, to tune.
 * Curved costs 300,000,000 in the first cycle, half the Standing card (SLICE_FIRST_CYCLE).
 */
export const SLICE_SHARE: Readonly<Record<CardSliceId, number>> = {
  curved: 0.3,
  "surf-prisms": 0.002,
  "surf-archimedean": 0.005,
  "surf-catalan-a": 0.01,
  "surf-catalan-b": 0.05,
  "surf-catalan-c": 0.15,
  sphere: 0.3,
  torus: 0.4,
  "surf-nofold-catalan": 0.5,
  "poly-catalan": 0.01,
  "poly-platonic": 0.03,
  "poly-prisms": 0.1,
  "poly-antiprisms": 0.15,
  "poly-elongated": 0.25,
  "poly-duals": 0.4,
  balls: 0.5,
};
/** Curved's price in the first cycle, where a share of T (200,000,000) would be too little. */
export const SLICE_FIRST_CYCLE: Partial<Record<CardSliceId, number>> = { curved: 300_000_000 };

/** The record points a reset needs in the cycle after `resets` resets (standing.ts resetThreshold). */
const thresholdAfter = (resets: number) => RESET_MIN * Math.pow(RESET_GROWTH, resets);

/** The price of a slice card in a cycle, before Quick study. */
export function slicePrice(id: CardSliceId, resets: number): number {
  return SLICE_FIRST_CYCLE[id] !== undefined && resets === 0
    ? SLICE_FIRST_CYCLE[id]!
    : Math.round(SLICE_SHARE[id] * thresholdAfter(resets));
}

/** The reset count a dimension is first open in (its cards are priced for that cycle in the tree's layout). */
const OPENING_RESETS: Partial<Record<DimensionId, number>> = { "2-in-2": 0, "2-on-3": 1, "3-in-3": 2 };

export const isCardSlice = (id: UpgradeId): id is CardSliceId => id in SLICE_SHARE;

/** Whether the upgrade exists now: a slice card only while its dimension is open. */
export function exists(o: Owned, id: UpgradeId): boolean {
  return !isCardSlice(id) || (o.dimensions ?? ["2-in-2"]).includes(sliceById(id).dimension);
}

const SLICE_FORMULA = (id: CardSliceId): string[] =>
  id === "curved"
    ? [
        `${sym("p")} = 300,000,000 in the first cycle, and ${SLICE_SHARE[id]} × ${sym("T")} in later ones`,
        `${sym("T")} = ${RESET_MIN.toLocaleString("en-US")} × ${RESET_GROWTH}<sup>${sym("r")}</sup>`,
      ]
    : [
        `${sym("p")} = ${SLICE_SHARE[id]} × ${sym("T")}`,
        `${sym("T")} = ${RESET_MIN.toLocaleString("en-US")} × ${RESET_GROWTH}<sup>${sym("r")}</sup>`,
      ];
const SLICE_VARS: readonly Var[] = [
  [sym("p"), "the price in record points, before Quick study"],
  [sym("T"), "the record points the cycle needs for a reset"],
  [sym("r"), "the resets you have made so far"],
];

/** The price of a slice card in the cycle it is dealt in, as its How states it. */
const priceNote = (id: CardSliceId): string => {
  const slice = sliceById(id);
  const resets = id === "curved" ? 0 : (OPENING_RESETS[slice.dimension] ?? 0);
  const p = slicePrice(id, resets);
  return `In cycle ${resets + 1}, with a threshold of ${thresholdAfter(resets).toLocaleString("en-US")}, it costs ${p.toLocaleString("en-US")} RP. It is bought again in each cycle, at that cycle's threshold.`;
};

function sliceCard(id: CardSliceId, requires: UpgradeId[], effect: string, what: string): Upgrade {
  const slice = sliceById(id);
  return {
    id,
    name: slice.label,
    cost: slicePrice(id, id === "curved" ? 0 : (OPENING_RESETS[slice.dimension] ?? 0)),
    requires,
    effect,
    how: {
      text: [what, priceNote(id)],
      math: SLICE_FORMULA(id),
      vars: SLICE_VARS,
      note: "Quick study lowers the price like any other price in record points. A reset takes the card away, and the dimension stays open.",
    },
    row: "dimensions",
    mystery: slice.late,
  };
}

/**
 * The text of a solid family's card. 3D in 3D opens with the Archimedean solids; each card opens a family,
 * and a pair of solids (the piece, the container) is dealt when both of its families are open, with 2 to 500
 * pieces. The counts come from the catalogue, so they follow it.
 */
function polyWhat(id: SliceId, what: string): string {
  const n = solidsOfSlice(id);
  return `The dealer also deals ${what} (${n} solids) as pieces and as containers, in pairs with any solid of a family that is open, itself included. Every ordered pair of solids is a problem, with 2 to 500 pieces: ${PAIR_COUNT.toLocaleString("en-US")} kinds of problem with every family open.`;
}

const nf = (n: number) => n.toLocaleString("en-US");

const SURFACE_PIECES =
  "Pieces are disks or polygons of 3 to 100 sides, with 1 to 100 of them, so each solid holds 9,900 problems.";

const SLICE_CARDS: Upgrade[] = [
  sliceCard(
    "curved",
    ["ring30"],
    "Deals packings on the hyperbolic plane and on spheres, besides the flat plane.",
    `The dealer also deals curved problems: ${nf(domainProblems("curved"))} kinds of problem, with 2 to ${DOMAIN_MAX_P.curved} pieces that are disks or polygons of 3 to 100 sides, packed in a regular polygon or disk on a surface of constant curvature K. K below 0 is the hyperbolic plane, K = 0 is the flat plane, and K above 0 is a sphere of radius 1 / √K. This is 2D in 2D, played on curved surfaces. Most have no research record yet.`,
  ),
  sliceCard(
    "surf-prisms",
    [],
    "Deals packings on the surfaces of the 9 prisms and 9 antiprisms.",
    `The dealer also deals pieces packed on the surface of a prism with 3, or 5 to 12 sides, and of an antiprism with 4 to 12 sides. A piece may bend over an edge onto the next face. ${SURFACE_PIECES}`,
  ),
  sliceCard(
    "surf-archimedean",
    ["surf-prisms"],
    `Deals packings on the ${SURFACE_ARCHIMEDEAN.length} Archimedean solids.`,
    `The dealer also deals pieces packed on the surface of an Archimedean solid, such as the cuboctahedron, the snub cube or the truncated icosahedron. A piece may bend over an edge. Without folding these would be 2D packings of regular faces, so only the folded ones are dealt. ${SURFACE_PIECES}`,
  ),
  sliceCard(
    "surf-catalan-a",
    ["surf-archimedean"],
    "Deals packings on the 6 Catalan solids with 12 or 24 faces.",
    `The dealer also deals pieces packed on the rhombic dodecahedron and the triakis tetrahedron (12 faces), and on the deltoidal icositetrahedron, the pentagonal icositetrahedron, the tetrakis hexahedron and the triakis octahedron (24 faces). A piece may bend over an edge. ${SURFACE_PIECES}`,
  ),
  sliceCard(
    "surf-catalan-b",
    ["surf-catalan-a"],
    "Deals packings on the 6 Catalan solids with 30 to 60 faces.",
    `The dealer also deals pieces packed on the rhombic triacontahedron (30 faces), the disdyakis dodecahedron (48 faces), and the deltoidal hexecontahedron, the pentagonal hexecontahedron, the pentakis dodecahedron and the triakis icosahedron (60 faces). A piece may bend over an edge. ${SURFACE_PIECES}`,
  ),
  sliceCard(
    "surf-catalan-c",
    ["surf-catalan-b"],
    "Deals packings on the disdyakis triacontahedron, the Catalan solid with 120 faces.",
    `The dealer also deals pieces packed on the disdyakis triacontahedron, the Catalan solid with the most faces. A piece may bend over an edge. ${SURFACE_PIECES}`,
  ),
  sliceCard(
    "sphere",
    ["surf-catalan-b"],
    "Deals packings on the surface of a sphere.",
    `The dealer also deals pieces packed in a cap of a sphere, the smallest one that holds them: ${nf(domainProblems("sphere"))} kinds of problem, with 2 to ${DOMAIN_MAX_P.sphere} pieces that are disks or polygons of 3 to 100 sides. Some have a research record to beat; the others are open.`,
  ),
  sliceCard(
    "torus",
    ["surf-catalan-b"],
    "Deals packings on a torus, with a square, a hexagonal or a free cell.",
    `The dealer also deals pieces packed on a flat torus whose cell is a square, a hexagon or any shape, the smallest one that holds them: ${nf(domainProblems("torus"))} kinds of problem, with 2 to ${DOMAIN_MAX_P.torus} pieces that are disks or polygons of 3 to 100 sides. Some have a research record to beat; the others are open.`,
  ),
  sliceCard(
    "surf-nofold-catalan",
    ["surf-catalan-b"],
    "Deals packings on the Catalan solids where a piece stays on one face.",
    `The dealer also deals the Catalan solids without folding: each piece must lie inside one face, so each face is a separate 2D packing. This is for the Catalan solids, whose faces are not regular. ${SURFACE_PIECES}`,
  ),
  sliceCard(
    "poly-catalan",
    [],
    "Opens the Catalan solids as pieces and containers.",
    polyWhat("poly-catalan", "the Catalan solids"),
  ),
  sliceCard(
    "poly-platonic",
    [],
    "Opens the Platonic solids as pieces and containers.",
    polyWhat("poly-platonic", "the Platonic solids"),
  ),
  sliceCard(
    "poly-prisms",
    ["poly-catalan"],
    "Opens the prisms as pieces and containers.",
    polyWhat("poly-prisms", "the prisms"),
  ),
  sliceCard(
    "poly-antiprisms",
    ["poly-prisms"],
    "Opens the antiprisms as pieces and containers.",
    polyWhat("poly-antiprisms", "the antiprisms"),
  ),
  sliceCard(
    "poly-elongated",
    ["poly-antiprisms"],
    "Opens the elongated prisms as pieces and containers.",
    polyWhat("poly-elongated", "the prisms of height 1.5, 2 and 3"),
  ),
  sliceCard(
    "poly-duals",
    ["poly-elongated"],
    "Opens the bipyramids and trapezohedra as pieces and containers.",
    polyWhat("poly-duals", "the bipyramids and trapezohedra"),
  ),
  sliceCard(
    "balls",
    ["poly-platonic"],
    "Deals packings of balls in solids, solids in a ball, and balls in a ball.",
    `The dealer also deals packings with balls: balls of diameter 1 in the smallest ball or in the smallest copy of a solid, and unit solids in the smallest ball, with 2 to 100 pieces each. A solid is dealt once its family is open. With every family open that is ${BALLS_CODES.length} kinds of problem. Most have no record yet.`,
  ),
];

/** The tree, in an order where every prerequisite comes before the upgrades that need it. */
export const UPGRADES: readonly Upgrade[] = [
  {
    id: "trace",
    name: "Trace detail",
    cost: 1000,
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
  clickRung("click2", 1500, ["trace"]),
  autoRung("auto1", 80, ["click2"]),
  clickRung("click3", 1800, ["click2"]),
  autoRung("auto2", 100, ["auto1", "click3"]),
  clickRung("click4", 2200, ["click3"]),
  clickRung("click5", 2800, ["click4"]),
  autoRung("auto3", 250, ["auto2", "click4"]),
  clickRung("click6", 3200, ["click5"]),
  queueRung("queue3", 3500, ["click5"]),
  clickRung("click7", 6000, ["click6"]),
  clickRung("click8", 8000, ["click7"]),
  clickRung("click9", 9500, ["click8"]),
  {
    id: "sweeps10",
    name: "mc_compress: 10 sweeps per evaluation",
    cost: 10000,
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
  clickRung("click10", 11000, ["click9"]),
  autoRung("auto4", 800, ["auto3", "click7"]),
  {
    id: "clickx",
    name: "One more evaluation per click",
    cost: 15000,
    requires: ["click10"],
    effect: "Each level adds one evaluation to every Evolve click of yours.",
    how: {
      text: [
        `Each level adds one evaluation to every Evolve click, on top of the 10 of the last rung. Auto-eval keeps its own rate in evaluations a second, which this does not change. ${EVALUATION}`,
      ],
      math: CLICK_MATH("10"),
      vars: CLICK_VARS,
      note: `Each level costs 1.25 times the one before. ${DEALS_PER_CLICK}`,
    },
    row: "clicks",
    levels: { max: 990, growth: 1.25 },
  },
  autoRung("auto5", 1500, ["auto4", "click10"]),
  dealerRung("rank2", 20000, ["queue3"]),
  // ---- well after: methods, one at a time, each dearer than the last ----
  methodRung("basin", 40000, ["click10", "auto4"]),
  {
    id: "reach2",
    name: "Reach: site records",
    cost: 48000,
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
  autoRung("auto6", 3600, ["auto5", "basin"]),
  tuneRung("tuneMc", "mc_compress", 64000, ["sweeps10", "basin"]),
  dealerRung("rank4", 72000, ["rank2", "reach2"]),
  methodRung("shrink", 80000, ["basin"]),
  {
    id: "advance",
    name: "Auto-advance",
    cost: 88000,
    requires: ["reach2", "queue3"],
    effect: "Problems that stop making progress are replaced, and auto-eval compacts new problems first.",
    how: advanceHow(),
    row: "queue",
  },
  pickRung("pick3", 112_000, ["rank2", "advance"]),
  methodRung("penalty", 120_000, ["shrink"]),
  {
    id: "lanes2",
    name: "Second lane",
    cost: 144_000,
    requires: ["advance"],
    effect: "Auto-eval works on two problems at once, each in its own solver worker, and they share its rate.",
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
  ringRung("ring200", 160_000, ["reach2", "rank4"]),
  {
    id: "filters",
    name: "Dealer filters",
    cost: 160_000,
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
  tuneRung("tuneBasin", "basin_hopping", 160_000, ["basin", "tuneMc"]),
  methodRung("lattice", 168_000, ["penalty"]),
  autoRung("auto7", 7200, ["auto6", "lanes2"]),
  {
    id: "rent",
    name: "Records pay rent",
    cost: 200_000,
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
  queueRung("queue4", 200_000, ["advance", "lanes2"]),
  {
    id: "continuous",
    name: "Continuous",
    cost: 208_000,
    requires: ["lanes2"],
    effect: "Auto-eval can keep running while this tab is hidden, once you tick its setting.",
    how: {
      text: [
        "Without this upgrade, auto-eval pauses while the tab is hidden. With it, Settings gets a box, off until you tick it, that keeps auto-eval running in a hidden tab.",
        "Browsers slow down the timers of a hidden tab, and may wake them only once a minute. Up to 60 s of auto-eval's evaluations wait to be run, so such a tab still loses nothing. Nothing runs once the page is closed.",
      ],
    },
    row: "queue",
  },
  dealerRung("rank8", 240_000, ["rank4", "ring200"]),
  methodRung("harden", 240_000, ["lattice"], true),
  tuneRung("tuneShrink", "shrink_repair", 240_000, ["shrink", "tuneMc"]),
  {
    id: "wide",
    name: "More open problems",
    cost: 240_000,
    requires: ["queue4"],
    effect: "Half the open problems dealt can have any sides from 21 to 100 and 40 to 500 pieces.",
    how: {
      text: [
        "Open problems have no site entry yet. Without this upgrade the dealer draws them from a fixed list of 2,601, where N and M are among 21, 24, 27, 30, 33, 36, 40, 44, 47, 50, 55, 60, 66, 72, 80, 90 and 100 and P among 40, 60, 80, 100, 120, 150, 200, 250 and 300.",
        "With it, each draw of an open problem has an even chance to come instead from any N and M from 21 to 100 and any P from 40 to 500, each drawn uniformly. Transfers then also look at the problems with 1 to 3 fewer pieces.",
      ],
      note: "Under the Circles only and Small problems only rules, the rule's own list of problems is used instead.",
    },
    row: "problems",
  },
  {
    id: "collections",
    name: "Collections",
    cost: 280_000,
    requires: ["queue3", "reach2"],
    effect: "Completed sets of records add to all your points, for good.",
    how: {
      text: [
        "Collections count the records the server has confirmed, and the count is kept through resets. A shape pair is one piece shape in one container shape, each with 21, 24, 27, 30, 33, 36, 40, 44, 47, 50, 55, 60, 66, 72, 80, 90 or 100 sides. Each shape pair with a record on all 9 of its piece counts (40, 60, 80, 100, 120, 150, 200, 250 and 300) adds 2 %. Each piece shape adds 1 % at 10, 30 and 100 records. Each tier (open problem, loose record, site record, published value) adds 5 % once you have its first record.",
        "The bonus multiplies every point you are paid, rent included.",
      ],
      math: [`${sym("m", "c")} = 1 + 0.02 × ${sym("a")} + 0.01 × ${sym("b")} + 0.05 × ${sym("t")}`],
      vars: [
        [sym("m", "c"), "the multiplier from collections"],
        [sym("a"), "shape pairs complete"],
        [sym("b"), "marks reached by piece shapes (10, 30 and 100 records of one shape)"],
        [sym("t"), "tiers with a first record"],
      ],
    },
    row: "records",
  },
  autoRung("auto8", 12800, ["auto7"]),
  {
    id: "batch",
    name: "Reach: every site record",
    cost: 320_000,
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
  tuneRung("tunePenalty", "penalty", 320_000, ["penalty", "tuneMc"]),
  methodRung("morph", 360_000, ["harden"], true),
  {
    id: "retake",
    name: "Retake",
    cost: 360_000,
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
    cost: 400_000,
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
    cost: 480_000,
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
    cost: 480_000,
    requires: ["rent"],
    effect: "Each level multiplies the rent of every record by 1.5.",
    how: {
      text: [
        "Each level multiplies every record's rent by 1.5, so level 1 pays 1.5 times the rent, level 2 pays 2.25 times and level 5, the last, about 7.6 times.",
      ],
      math: RENT_MATH,
      vars: RENT_VARS,
      note: "Each level costs 1.6 times the one before. There are 5 levels, because more would make rent outgrow everything else.",
    },
    row: "records",
    levels: { max: 5, growth: 1.6 },
  },
  ringRung("ring120", 480_000, ["ring200", "batch"]),
  methodRung("asc", 480_000, ["morph"], true),
  pickRung("pick5", 560_000, ["pick3", "rank8"]),
  {
    id: "collector",
    name: "Collector",
    cost: 640_000,
    requires: ["collections", "pick3"],
    effect: "Every third deal fills a gap in the collection you are closest to completing.",
    how: {
      text: [
        "A collection here is a shape pair (one piece shape in one container shape, as in Collections) with a record on each of its 9 piece counts (40, 60, 80, 100, 120, 150, 200, 250 and 300). On every third deal, the dealer first looks at the pair where you hold the most of those records but not all, and deals a missing problem of it that the server shows is still open.",
        "It checks at most 6 such problems per deal. If none is open, the deal goes on as usual.",
      ],
      math: [`Collector's deal when ${sym("D")} mod 3 = 2`],
      vars: [[sym("D"), "problems dealt before this deal"]],
    },
    row: "dealer",
    mystery: true,
  },
  tuneRung("tuneHarden", "harden", 640_000, ["harden"], true),
  autoRung("auto9", 22400, ["auto8", "asc"]),
  autoRung("auto10", 36000, ["auto9"]),
  {
    id: "learning",
    name: "Learning dealer",
    cost: 800_000,
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
        [
          sym("p"),
          `the record points per evaluation the dealer expected (w × c × R × κ × ${number(RP_PER_EVAL)}, with κ the cost factor of the points)`,
        ],
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
  queueRung("queue6", 960_000, ["queue4", "collections"]),
  methodRung("growth", 960_000, ["asc"], true),
  {
    id: "autox",
    name: "Faster auto-eval",
    cost: 80000,
    requires: ["auto10"],
    effect: `Each level adds ${AUTOX_STEP} evaluations a second to auto-eval, up to ${AUTO_MAX} in all.`,
    how: {
      text: [
        `Each level adds ${AUTOX_STEP} evaluations a second to auto-eval's rate, on top of the ${number(AUTO.auto10!)} a second of the last Auto-eval upgrade, so level ${AUTOX_LEVELS} reaches the limit of ${AUTO_MAX} a second. Like every Auto-eval upgrade, it raises the rate of all your lanes together, and the lanes share it.`,
        `The limit is a target, and your computer sets the real one. One mc_compress evaluation took about ${msPerEval(85)} ms at N + M + P = 85 on the machine it was measured on, so ${AUTO_MAX} evaluations a second keep about ${number((AUTO_MAX * msPerEval(85)) / 10)} % of one core busy there. From about N + M + P = ${Math.round(coreBound(AUTO_MAX) / 10) * 10} up an evaluation takes ${number(1000 / AUTO_MAX)} ms or more, so ${AUTO_MAX} a second need more than one core. Each lane is a solver worker of its own, so more lanes spread the work over more cores, and a lane that cannot keep up runs as fast as its core allows.`,
      ],
      math: AUTO_MATH(`min(${AUTO_MAX}, ${number(AUTO.auto10!)} + ${AUTOX_STEP} × ${sym("a")})`),
      vars: [AUTO_VARS[0], [sym("a"), `levels of Faster auto-eval, 0 to ${AUTOX_LEVELS}`], ...AUTO_VARS.slice(1)],
      note: `${AUTO_NOTE} Each level costs 1.6 times the one before.`,
    },
    row: "auto",
    levels: { max: AUTOX_LEVELS, growth: 1.6 },
  },
  ringRung("ring80", 1_200_000, ["ring120"], true),
  tuneRung("tuneAsc", "asc", 1_200_000, ["asc"], true),
  {
    id: "methodMatch",
    name: "Method match",
    cost: 1_280_000,
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
  tuneRung("tuneGrowth", "ls_growth", 2_400_000, ["growth"], true),
  ringRung("ring50", 3_200_000, ["ring80"], true),
  {
    id: "published",
    name: "Reach: published values",
    cost: 4_000_000,
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
    cost: 600_000_000,
    requires: ["collections", "rent", "ring120"],
    effect: "You can reset the tree for standing, and each point of standing adds 10 % to all points.",
    how: {
      text: [
        `A reset ends the cycle, the play since the last reset. Your record points and most of the tree go back to zero, and you get standing. The first cycle can be reset once it has earned ${RESET_MIN.toLocaleString("en-US")} record points that the server has confirmed. Each later cycle needs ${RESET_GROWTH} times as many as the one before.`,
        "Your records stay on the server and keep paying rent. Your collection counts, the dealer's learning and the queue stay, and so do the upgrades Records pay rent, Higher rent and Collections. Every point of standing ever earned adds 10 % to all record points, spent or not, and standing buys the Standing row.",
        "The first reset opens 2D on 3D, pieces packed on the surfaces of solids. The second opens 3D in 3D, solids packed in solids. An opened dimension stays open, and its cards in the Dimensions row are bought again in each cycle.",
      ],
      math: [
        `${sym("S")} = ⌊5 × √(${sym("E")} / ${sym("T")})⌋`,
        `${sym("T")} = ${RESET_MIN.toLocaleString("en-US")} × ${RESET_GROWTH}<sup>${sym("r")}</sup>`,
        `${sym("m", "s")} = 1 + 0.1 × ${sym("S", "all")}`,
      ],
      vars: [
        [sym("S"), "the standing a reset gives (5 at the threshold)"],
        [sym("E"), "the record points of this cycle that the server has confirmed (at least T)"],
        [sym("T"), "the record points this cycle needs for a reset"],
        [sym("r"), "the resets you have made so far (0 in the first cycle)"],
        [sym("m", "s"), "the multiplier standing puts on every record point"],
        [sym("S", "all"), "the standing you have ever earned"],
      ],
    },
    row: "records",
    mystery: true,
  },
  ringRung("ring30", 8_000_000, ["ring50"], true),
  ringRung("ringAll", 24_000_000, ["ring30"], true),
  // ---- standing: paid in standing, kept through resets ----
  standingRung(
    "head1",
    "Head start I",
    1,
    ["standing"],
    "Each new cycle starts with 2 to 5 evaluations per click and Auto-eval.",
    {
      text: [
        `At every reset, the next cycle begins owning Trace detail, 2, 3, 4 and 5 evaluations per click, and Auto-eval at ${autoRateText(AUTO.auto1!)}.`,
      ],
    },
  ),
  standingRung(
    "head2",
    "Head start II",
    3,
    ["head1"],
    "Each new cycle also starts with Basin hopping and the queue of 3.",
    {
      text: [
        `At every reset, the next cycle also begins owning Method: basin_hopping and what it needs (6 to 10 evaluations per click), the Auto-eval upgrades up to ${autoRateText(AUTO.auto5!)} and Problem queue: 3.`,
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
        "Circles only deals only problems with circle pieces or a circle container, and its reward is 1.5 times the points on every problem with circles. Small problems only deals only problems with N + M + P of at most 120, for 1.5 times the points on those. Circles only and Small problems only cover the polygon problems of 2D in 2D, so problems of other dimensions are dealt as usual and pay no reward from them. Clicks only turns auto-eval off, for one more evaluation per click. One method allows only mc_compress, for 1.5 times the points on improvements mc_compress finds.",
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
    "You order your methods, and each new run on a problem uses the next one.",
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
        "At a reset, every upgrade of the Auto-eval row stays owned. That is Auto-eval, its nine faster rungs, and Faster auto-eval with its levels. Under the Clicks only rule auto-eval is still off for that cycle.",
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
      `At a reset, every Method upgrade you own stays owned (${listed(Object.values(METHOD).map((m) => methodLabel(m!)))}). Their tuning upgrades go back to zero. Under the One method rule only mc_compress runs in that cycle.`,
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
  // ---- dimensions ----
  ...SLICE_CARDS,
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
  const base = isCardSlice(id)
    ? slicePrice(id, o.resets ?? 0)
    : u.levels
      ? u.cost * Math.pow(u.levels.growth, l)
      : u.cost;
  return currencyOf(u) === "rp" ? Math.round(base * rpCostFactor(o)) : Math.round(base);
}

/** Whether the upgrade shows as itself in the shop: not a mystery, or every prerequisite owned. */
export function isRevealed(o: Owned, id: UpgradeId): boolean {
  const u = BY_ID.get(id);
  return !!u && (!u.mystery || u.requires.every((r) => o.has(r)));
}

/** Upgrades that can be bought next (prerequisites owned, a level left): the shop's open cards. */
export function available(o: Owned): Upgrade[] {
  return UPGRADES.filter((u) => exists(o, u.id) && costOf(o, u.id) !== null && u.requires.every((r) => o.has(r)));
}

/** What the player can pay with. */
export interface Funds {
  rp: number;
  standing: number;
}

export type BuyCheck = { ok: true } | { ok: false; reason: "owned" | "locked" | "points" };

export function canBuy(o: Owned, funds: Funds | number, id: UpgradeId): BuyCheck {
  const u = BY_ID.get(id);
  if (!u || !exists(o, id)) return { ok: false, reason: "locked" };
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

/** Evaluations a run may do in all before it ends by itself and the next run takes over (methods/types.ts). */
export { RUN_BUDGET } from "./methods";

/**
 * Auto-eval's target in evaluations per second, all lanes together (they share it), or null without
 * it: its fastest rung, plus AUTOX_STEP a level of Faster auto-eval, at most AUTO_MAX. Evaluations per
 * click do not change it.
 */
export function autoPerSecond(o: Owned): number | null {
  // the "clicks only" cycle rule: no auto-eval in this cycle
  if (!o.has("auto1") || o.rule === "clicks") return null;
  return Math.min(AUTO_MAX, highest(o, AUTO, 0, (a, b) => a > b) + AUTOX_STEP * level(o, "autox"));
}

/**
 * Evaluations a second as the page writes them: "1 evaluation every 2 s" below one a second, else
 * "1 evaluation a second", "2.5 evaluations a second", "1,750 evaluations a second".
 */
export function autoRateText(perSecond: number): string {
  if (perSecond < 1) return `1 evaluation every ${seconds(1 / perSecond)}`;
  const n = perSecond >= 100 ? Math.round(perSecond).toLocaleString("en-US") : number(perSecond);
  return `${n} evaluation${n === "1" ? "" : "s"} a second`;
}

/**
 * Auto-eval hands a lane at most this many seconds of the lane's share at once: a few worker messages
 * a second a lane, whatever the rate, and a click of the player's waits behind little.
 */
export const AUTO_JOB_SECONDS = 0.25;

/**
 * The evaluations of auto-eval's next job in a lane, from the evaluations due (all lanes'): what is due,
 * at most AUTO_JOB_SECONDS of a lane's share of the rate (the rate over `lanes`) and at least 1, or 0
 * while less than one is due. With `msEach`, the expected ms of one evaluation on the job's problem,
 * also at most AUTO_JOB_SECONDS of the solver's time: where the CPU cannot keep up with the share, a
 * job that size would keep a click waiting for seconds.
 */
export function autoJobEvals(o: Owned, due: number, lanes = 1, msEach = 0): number {
  // a hair either way, so that a rounding error (a share a hair over a whole number of evaluations a
  // quarter second, or a sum of fractions just short of 1 due) does not change a job's size
  const share = Math.ceil(((autoPerSecond(o) ?? 0) / Math.max(1, lanes)) * AUTO_JOB_SECONDS - 1e-9);
  const timed = msEach > 0 ? Math.floor((AUTO_JOB_SECONDS * 1000) / msEach + 1e-9) : Infinity;
  const most = Math.max(1, Math.min(share, timed));
  return Math.max(0, Math.min(most, Math.floor(due + 1e-9)));
}

/**
 * Seconds of auto-eval the lanes may fall behind and still catch up: a hidden tab's timers may wake
 * only once a minute. Nothing is earned while auto-eval cannot run (off, held, or the page closed).
 */
export const AUTO_SLACK_SECONDS = 60;

/** Most evaluations auto-eval may be due at once: a minute of its rate (all lanes'), and at least a Compact. */
export function autoCap(o: Owned): number {
  return Math.max(COMPACT_EVALS, (autoPerSecond(o) ?? 0) * AUTO_SLACK_SECONDS);
}

/**
 * The methods the player may choose, mc_compress first, then in the order they unlock: the Method
 * list, Method match's choices and the pipeline editor. A method that is not selectable (its file in
 * methods/) is left out, though its card may be owned.
 */
export function methods(o: Owned): EvolveMethod[] {
  const owned = UPGRADES.filter((u) => o.has(u.id) && METHOD[u.id] && isSelectable(METHOD[u.id]!));
  return ["mc_compress", ...owned.map((u) => METHOD[u.id]!)];
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
  return inUse(o, "rank8") ? 8 : inUse(o, "rank4") ? 4 : inUse(o, "rank2") ? 2 : 1;
}

/** Offers the player picks from (0: the dealer deals on its own). */
export function offerCount(o: Owned): number {
  return inUse(o, "pick5") ? 5 : inUse(o, "pick3") ? 3 : 0;
}

// ---------- switches ----------

/**
 * The dealer's upgrades, which the player can turn off and on again in the tech tree once owned. A
 * ladder is one switch, named by its first rung: while it is off, the dealer works as it did before
 * the ladder's first rung.
 */
const SWITCH: Partial<Record<UpgradeId, UpgradeId>> = {
  rank2: "rank2",
  rank4: "rank2",
  rank8: "rank2",
  pick3: "pick3",
  pick5: "pick3",
  filters: "filters",
  retake: "retake",
  collector: "collector",
  learning: "learning",
};
/** The switches, by the upgrade that names each. */
export const SWITCHES: readonly UpgradeId[] = [...new Set(Object.values(SWITCH))];

/** The switch that turns the upgrade off and on, or null where it has none. */
export const switchOf = (id: UpgradeId): UpgradeId | null => SWITCH[id] ?? null;

/** The upgrade is owned and its switch, if it has one, is on. */
export function inUse(o: Owned, id: UpgradeId): boolean {
  const sw = SWITCH[id];
  return o.has(id) && !(sw && o.off?.has(sw));
}

/** The switch's name: the name of the highest rung owned of its ladder ("Dealer: best of 4"). */
export function switchName(o: Owned, sw: UpgradeId): string {
  const owned = UPGRADES.filter((u) => SWITCH[u.id] === sw && o.has(u.id));
  return (owned.at(-1) ?? upgrade(sw)).name;
}

/** What the dealer does while the switch is off. */
const OFF_TEXT: Partial<Record<UpgradeId, string>> = {
  rank2: "While it is off, the dealer deals the first problem it draws.",
  pick3: "While it is off, the dealer deals on its own. Turning it off clears the offers.",
  filters: "While it is off, the dealer may deal any problem. Your filters are kept for when you turn it on.",
  retake: "While it is off, the records you lose are not offered to you again.",
  collector: "While it is off, the dealer does not look for the problems your collections are missing.",
  learning:
    "While it is off, the dealer ranks problems without what it has learned. It still learns from the problems that leave the queue.",
};

/** For an upgrade with a switch, what turning it off does; null for the others. */
export function offText(id: UpgradeId): string | null {
  const sw = SWITCH[id];
  return sw ? OFF_TEXT[sw]! : null;
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
