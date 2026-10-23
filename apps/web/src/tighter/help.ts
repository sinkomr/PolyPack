import { areaLowerBound, improvesOn } from "@polypack/geometry";
import { AUTO_CLICK_EVALS, DEAL_CLICKS } from "./dealer";
import {
  PAIR_BONUS,
  RENT_CHECK_MS,
  RENT_GROWTH,
  RENT_RECHECK_MS,
  RENT_SHARE,
  RENT_WINDOW_MS,
  SHAPE_BONUS,
  SHAPE_MILESTONES,
  TIER_BONUS,
} from "./economy";
import { FRONTIER_P, FRONTIER_SIDES } from "./frontier";
import type { How } from "./how";
import { METHOD_GAMES, methodLabel } from "./methods";
import type { MethodGame } from "./methods";
import { MAX_NAME_LENGTH } from "./names";
import {
  OFFLINE_BACKOFF_MS,
  PLAYER_PER_MINUTE,
  PLAYER_WINDOW_MS,
  PROBLEM_INTERVAL_MS,
  RATE_LIMITED_BACKOFF_MS,
} from "./pacer";
import {
  BEAT_OTHER_BONUS,
  CONTEST,
  FIRST_RECORD_BONUS,
  FIRST_RECORD_GAP_RATIO,
  FLOOR,
  GAP_WEIGHT,
  SIZE_WEIGHT,
  TIER_LABEL,
  recordPoints,
  shapeWeight,
} from "./points";
import { MAX_STAGES, MIN_OBSERVED_EVALS } from "./runplan";
import { HELD_PER_STANDING, RESET_MIN, RULES } from "./standing";
import { CLIENT_TAG } from "./submission";
import { MAX_NEIGHBOUR_LOOKUPS, TRANSFER_MARGIN } from "./transfer";
import {
  AUTOX_STEP,
  AUTO_JOB_SECONDS,
  AUTO_MAX,
  AUTO_RATES,
  AUTO_SLACK_SECONDS,
  COMPACT_EVALS,
  RUN_BUDGET,
} from "./upgrades";

/**
 * The "How it works" explanations outside the tech tree, in the shared format of how.ts: the points
 * panel, standing and its cycle rules, records, auto-eval and the lanes, Settings, and the Runs
 * panel. tighter.html places each one as an empty `details[data-how]` (main.ts fills it); the Runs
 * panel builds its own. Every number comes from the constant the game uses, so the text follows the
 * code when a constant changes.
 */

const SUPERSCRIPT: Record<string, string> = {
  "-": "⁻",
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
};
/** A whole exponent as Unicode superscripts: −9 as "⁻⁹". */
export const superscript = (e: number) => [...String(e)].map((ch) => SUPERSCRIPT[ch] ?? ch).join("");

/** The smallest improvement that counts, as plain text ("10⁻⁹") and as markup. */
const exponent = Math.round(Math.log10(FLOOR));
export const MIN_STEP = `10${superscript(exponent)}`;
const minStep = `10<sup>−${-exponent}</sup>`;

const int = (n: number) => n.toLocaleString("en-US");
const pct = (x: number) => `${Math.round(x * 100)} %`;
const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;
const minutes = (ms: number) => `${Math.round(ms / 60_000)} minute${Math.round(ms / 60_000) === 1 ? "" : "s"}`;
/** "a, b and c". */
export const andList = (xs: readonly string[]) =>
  xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
export const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * What a run that ended did to the board, for its end's event: "It made the side 0.494 % smaller.",
 * from the board's score when it opened (`before`) to the run's best (`after`), or "" when it did not
 * beat it by more than the smallest improvement that counts. `side` is "side", or "radius" for a
 * circle container.
 */
export function smallerText(side: string, before: number | null, after: number | null): string {
  if (before === null || after === null || !improvesOn(after, before)) return "";
  return `It made the ${side} ${((1 - after / before) * 100).toFixed(3)} % smaller.`;
}

// ---------- how points are paid ----------

/** The worked example: 60 24-gons in a 30-gon (an open problem), a board 20 % above the area bound. */
const EXAMPLE = { N: 24, M: 30, P: 60 };
const exampleBound = areaLowerBound(EXAMPLE.N, EXAMPLE.M, EXAMPLE.P);
const exampleSide = exampleBound * 1.2;
const exampleW = shapeWeight(EXAMPLE.N, EXAMPLE.M);
function exampleLine(delta: number, label: string): string {
  const r = recordPoints({ ...EXAMPLE, sPrev: exampleSide, sNew: exampleSide * (1 - delta), tier: "open" })!;
  const terms =
    r.size + r.gap < 0.00005
      ? `<var>t</var><sub>size</sub> + <var>t</var><sub>gap</sub> ≈ 0`
      : r.size + r.gap < 0.01
        ? `<var>t</var><sub>size</sub> + <var>t</var><sub>gap</sub> = ${(r.size + r.gap).toFixed(4)}`
        : `<var>t</var><sub>size</sub> = ${r.size.toFixed(2)}, <var>t</var><sub>gap</sub> = ${r.gap.toFixed(2)}`;
  const sum = r.nibble + r.size + r.gap;
  return (
    `<var>Δ</var> ${label} gives <var>t</var><sub>step</sub> = ${r.nibble.toFixed(0)}, ${terms}, ` +
    `so ${exampleW.toFixed(3)} × ${sum.toFixed(sum < 10 ? 3 : 2)} = ${r.total.toFixed(2)} RP`
  );
}

const POINTS: How[] = [
  {
    text: [
      `You earn record points (RP) each time a click makes your board smaller by more than the smallest improvement that counts, ${MIN_STEP} of its size. The server uses the same rule, so a smaller step would not make a new record there either. The click pays at once, whether you pressed Evolve or auto-eval clicked for you.`,
      "Points are paid only while you send your records under your name. Improvements made before that wait, and each problem pays them in one payment when you put your name on your records.",
      `Each payment adds three terms and any bonus, then multiplies the sum by the shape weight, the contest weight and your points multiplier. The step term is the size of this one improvement on a log scale. It is 1 for the smallest improvement that counts and grows by 1 for each factor of 10 above it. It measures each step, not the record, so it goes up and down from click to click. The size term pays for how much the side shrank, and the gap term for how much closer it came to the area bound. Both are close to 0 for small steps and large for big ones, such as the first click on a new problem (Compact, ${int(COMPACT_EVALS)} evaluations at once).`,
      "The server checks every record you send. A board is usually sent within a minute, and Settings explains when. If the server does not make it the record, for example because another entry got there first, the points paid for that board are taken back. Points you have already spent are not owed, and your balance never goes below 0.",
    ],
    math: [
      `<var>Δ</var> = 1 − <var>s</var><sub>new</sub> / <var>s</var><sub>prev</sub>, paid only when <var>Δ</var> &gt; <var>F</var>`,
      `RP = <var>m</var> × <var>w</var> × <var>c</var> × (<var>t</var><sub>step</sub> + <var>t</var><sub>size</sub> + <var>t</var><sub>gap</sub> + <var>B</var>)`,
      `<var>t</var><sub>step</sub> = 1 + log<sub>10</sub>(<var>Δ</var> / <var>F</var>)`,
      `<var>t</var><sub>size</sub> = ${SIZE_WEIGHT} × ln(<var>s</var><sub>prev</sub> / <var>s</var><sub>new</sub>)`,
      `<var>t</var><sub>gap</sub> = ${GAP_WEIGHT} × ln(<var>g</var><sub>prev</sub> / <var>g</var><sub>new</sub>)`,
      `<var>g</var><sub>prev</sub> = <var>s</var><sub>prev</sub> / <var>b</var> − 1, <var>g</var><sub>new</sub> = <var>s</var><sub>new</sub> / <var>b</var> − 1`,
      `<var>w</var> = <var>d</var>(<var>N</var>) × <var>d</var>(<var>M</var>), where <var>d</var>(<var>n</var>) = 1 for <var>n</var> ≤ 20 and 20 / <var>n</var> above`,
      `<var>m</var> = (1 + 0.1 × <var>T</var>) × (1 + <var>C</var>) × <var>R</var>`,
    ],
    vars: [
      ["<var>Δ</var>", "the relative improvement of this step (0.001 means the side shrank by 0.1 %)"],
      ["<var>F</var>", `${MIN_STEP}, the smallest improvement that counts`],
      [
        "<var>s</var><sub>prev</sub>",
        "the side the payment is measured from. It is the side at your last payment on this problem, or before any payment the current record, or with no record the starting score (the side your first record must beat).",
      ],
      [
        "<var>s</var><sub>new</sub>",
        "your board's new side, in units where each piece has side 1 (circle pieces have radius 1). For a circle container it is the radius.",
      ],
      ["<var>t</var><sub>step</sub>", "the step term, in points"],
      ["<var>t</var><sub>size</sub>", "the size term, in points"],
      ["<var>t</var><sub>gap</sub>", "the gap term, in points"],
      [
        "<var>g</var><sub>prev</sub>, <var>g</var><sub>new</sub>",
        "how far the side is above the area bound, before and after the step (0.2 means 20 % above)",
      ],
      [
        "<var>b</var>",
        "the area bound, the side of a container whose area equals the total area of the pieces, in the same units as the side. No packing can be smaller.",
      ],
      [
        "<var>w</var>",
        "the shape weight. Pieces and containers with many sides are close to circles, so they pay less.",
      ],
      ["<var>d</var>(<var>n</var>)", "how distinct a shape with n sides is (n = 0 for a circle)"],
      ["<var>N</var>, <var>M</var>", "the number of sides of a piece and of the container (0 for a circle)"],
      [
        "<var>c</var>",
        `the contest weight, which is ${CONTEST.open} for an ${TIER_LABEL.open} (no entry yet), ${CONTEST.loose} for a ${TIER_LABEL.loose} (a site record clearly weaker than its neighbours), ${CONTEST.batch} for any other ${TIER_LABEL.batch} and ${CONTEST.published} for a ${TIER_LABEL.published} from the literature`,
      ],
      [
        "<var>B</var>",
        `bonus points, ${FIRST_RECORD_BONUS} for a problem's first record when its gap is at most ${FIRST_RECORD_GAP_RATIO} of the starting score's gap, plus ${BEAT_OTHER_BONUS} the first time you beat another name's record on a problem by enough to change its 6 decimals, otherwise 0`,
      ],
      ["<var>m</var>", "your points multiplier"],
      ["<var>T</var>", "the standing you have earned in all cycles, spent or not"],
      ["<var>C</var>", "the collections bonus (0.05 means +5 %, and 0 without Collections)"],
      [
        "<var>R</var>",
        "1.5 for each finished cycle rule whose reward applies to this problem, multiplied together (1 when none applies)",
      ],
    ],
    note: "On a problem with a published value, nothing pays until your board beats that value, and the first payment is measured from it. Before a send the container is turned to its best angle, as the server scores it. When that shrinks the side by more than the smallest improvement that counts, it pays like any other improvement.",
  },
  {
    text: `An example, before the multiplier m. The problem 24-gons in a 30-gon with 60 pieces is open, so w = ${exampleW.toFixed(3)} and c = ${CONTEST.open}. Its area bound is b = ${exampleBound.toFixed(6)}. Your board has side ${exampleSide.toFixed(6)}, 20 % above the bound, and here is what four different clicks would pay.`,
    math: [
      exampleLine(1.0000001 * FLOOR, `just above ${minStep}`),
      exampleLine(1e-6, "= 10<sup>−6</sup>"),
      exampleLine(1e-3, "= 10<sup>−3</sup>"),
      exampleLine(1e-2, "= 10<sup>−2</sup>"),
    ],
    note: "The step term depends only on how big the step is. It does not grow as your record gets better, which is why it rises and falls from one click to the next.",
  },
];

// ---------- clicks, evaluations and runs ----------

/** The methods' own sentences on when their runs end (runEnds, in each method's file), in the table's order. */
export function runEndRules(games: Readonly<Record<string, MethodGame>> = METHOD_GAMES): string {
  return Object.values(games)
    .map((g) => g.runEnds)
    .filter((t): t is string => !!t)
    .join(" ");
}

/** The sentences after a run's general rule: the methods' own rules, then the stall rule, or "". */
const runRules = () => [runEndRules(), stallRule()].filter(Boolean).join(" ");

/**
 * The sentences on the runs the game ends at a stall (each method's restartAfter, in its file in
 * methods/), or "" when no method has one: "The game also ends a stalled run of mc_compress. Once
 * the run has done 500 evaluations and its problem has gone 500 evaluations without progress, it
 * counts as ended by itself." With several methods, R is defined per method.
 */
export function stallRule(games: Readonly<Record<string, MethodGame>> = METHOD_GAMES): string {
  const limits = Object.entries(games)
    .filter(([, g]) => g.restartAfter != null && g.restartAfter > 0)
    .map(([m, g]) => ({ m: methodLabel(m), r: g.restartAfter! }));
  if (!limits.length) return "";
  const which = limits.map((x) => x.m);
  const head = `The game also ends a stalled run of ${which.length < 2 ? which[0] : `${which.slice(0, -1).join(", ")} or ${which.at(-1)}`}.`;
  if (limits.length === 1) {
    const r = int(limits[0].r);
    return `${head} Once the run has done ${r} evaluations and its problem has gone ${r} evaluations without progress, it counts as ended by itself.`;
  }
  return (
    `${head} Once the run has done R evaluations and its problem has gone R evaluations without progress, it counts as ended by itself. ` +
    `R is ${andList(limits.map((x) => `${int(x.r)} for ${x.m}`))}.`
  );
}

const COUNTS: How = {
  text: [
    "An evaluation is one scoring of your whole packing by the solver, which checks every overlap and how tightly the container fits. Between two evaluations the solver moves pieces, so each evaluation is one more step of search.",
    `A click is one press of Evolve. Each click runs as many evaluations as you have per click. A new open problem starts with every piece placed on rings around the centre. Its side, or the side of a smaller known packing, is the starting score. Your first record must beat it, and the starting board is never sent. Your first click on it is Compact, ${int(COMPACT_EVALS)} evaluations of mc_compress in one press.`,
    `A run is one session of a solver method on one problem, from the problem's best board. Each run starts with a new random seed, the number that fixes its random choices, so each run searches differently. A run stays open between clicks. It ends by itself when its method stops improving, or after ${int(RUN_BUDGET)} evaluations, and the next click starts a new run. ${runRules()}${runRules() ? " " : ""}A problem allows any number of runs. Changing the method or its settings also starts a new run.`,
    "Evaluations run counts every evaluation, yours and auto-eval's, including the one that scores a run's starting board. Clicks counts your own presses of Evolve that ran, not auto-eval's. Compute is the time the solver spent on those evaluations, added up over every lane, so with two lanes busy it grows twice as fast as the clock.",
    "Records held counts the problems where your entry is the current record on PolyPack, as far as the game has seen. Earned counts every record point you have earned, less any taken back, and spending does not lower it.",
    `New problems are earned by work, counted in clicks. Each Evolve click of yours counts as one click, whatever its evaluations, and Compact's ${int(COMPACT_EVALS)} evaluations count as ${int(COMPACT_EVALS)} / k clicks. Auto-eval's evaluations count ${AUTO_CLICK_EVALS} to the click, whatever your evaluations per click.`,
  ],
  math: [
    `<var>c</var><sub>deal</sub> = ${DEAL_CLICKS} / <var>q</var>`,
    `<var>c</var> = <var>e</var><sub>you</sub> / <var>k</var> + <var>e</var><sub>auto</sub> / ${AUTO_CLICK_EVALS}`,
  ],
  vars: [
    [
      "<var>c</var><sub>deal</sub>",
      "the clicks that earn you one new problem, which the game deals (gives you) once a slot of your queue is free",
    ],
    ["<var>q</var>", "the slots in your queue (1 at the start)"],
    ["<var>c</var>", "the clicks a stretch of work counts as"],
    ["<var>e</var><sub>you</sub>", "the evaluations of your own clicks in it"],
    ["<var>e</var><sub>auto</sub>", "auto-eval's evaluations in it"],
    ["<var>k</var>", "your evaluations per click"],
  ],
};

// ---------- standing and cycle rules ----------

const STANDING: How = {
  text: [
    "A cycle is the time between two resets. Your first cycle began when you started the game. A reset trades this cycle's record points and most of your tech tree for standing.",
    "Every point of standing you have ever earned adds 10 % to all the record points you earn, whether you spend it or not. You spend standing on the upgrades in the tech tree's Standing row, which only standing buys and which every reset keeps.",
    `You can reset once this cycle has earned ${int(RESET_MIN)} RP that the server has confirmed. Points still waiting for the server do not count yet, and they carry into the next cycle.`,
    "A reset takes away your RP to spend and every upgrade bought with RP, except Records pay rent, Higher rent, Collections and Standing. Keep auto-eval also keeps the Auto-eval row, and Keep methods keeps your methods. Head starts give their upgrades back at once, at their first level.",
    "A reset keeps your records on the server, and they go on paying rent. It also keeps your collections, your standing and the Standing row, the queue, what the dealer has learned and every count.",
  ],
  math: [
    `<var>G</var> = ⌊√(<var>E</var> / ${int(RESET_MIN)}) + <var>H</var> / ${HELD_PER_STANDING}⌋, once <var>E</var> ≥ ${int(RESET_MIN)}`,
    `<var>G</var><sub>rule</sub> = max(1, ⌈<var>G</var> / 2⌉), added only for a cycle played under a rule`,
    `multiplier on all points = 1 + 0.1 × <var>T</var>`,
    `<var>E</var><sub>next</sub> = ${int(RESET_MIN)} × (<var>G</var> + 1 − <var>H</var> / ${HELD_PER_STANDING})<sup>2</sup>`,
  ],
  vars: [
    ["<var>G</var>", "the standing a reset gives now"],
    ["<var>E</var>", "the record points earned in this cycle and confirmed by the server, rent included"],
    ["<var>H</var>", "the records you hold now"],
    ["<var>G</var><sub>rule</sub>", "the extra standing for finishing a cycle under a rule"],
    ["<var>T</var>", "the standing you have earned in all cycles, spent or not"],
    [
      "<var>E</var><sub>next</sub>",
      "the confirmed record points of this cycle at which the reset gives one more standing, with H unchanged",
    ],
  ],
  note: "The milestones show how long this cycle took to reach a few key upgrades, next to your fastest earlier cycle.",
};

const RULES_HOW: How = {
  text: [
    "Before a reset you can choose a rule for the next cycle, and it limits that whole cycle. When you reset at the end of a cycle played under a rule, the reset gives half again as much standing, rounded up and at least 1 more. You also keep the rule's reward for good. The reward comes once per rule, and the extra standing comes every time you finish a cycle under it.",
    ...RULES.map((r) => `${r.name}. ${r.limit} Once finished, ${lowerFirst(r.reward)}`),
  ],
  math: [`<var>G</var><sub>rule</sub> = max(1, ⌈<var>G</var> / 2⌉)`, `<var>R</var> = 1.5<sup><var>j</var></sup>`],
  vars: [
    ["<var>G</var><sub>rule</sub>", "the extra standing for finishing a cycle under a rule"],
    ["<var>G</var>", "the standing the reset gives without the rule"],
    ["<var>R</var>", "the multiplier the finished rules put on a problem's points"],
    [
      "<var>j</var>",
      "how many of Circles only, Small problems only and One method you have finished whose reward applies to the problem",
    ],
  ],
};

// ---------- records: rent and collections ----------

const RECORDS: How[] = [
  {
    text: [
      `With Records pay rent, every record you still hold earns rent every hour, equal to ${pct(RENT_SHARE)} of the record points that problem earned before multipliers, times ${RENT_GROWTH} for each level of Higher rent, times your points multiplier now.`,
      `Rent builds up between checks, even while the game is closed. Once a record's last check is ${minutes(RENT_RECHECK_MS)} old, the game asks the server who holds it, at most one record every ${seconds(RENT_CHECK_MS)}, the longest unchecked first. If the record is still yours, the rent since its last check is paid, at most ${Math.round(RENT_WINDOW_MS / 86_400_000)} days of it. If someone has beaten it, it pays nothing for the time since its last check.`,
      "Rent counts as record points earned in this cycle, so it also counts toward a reset.",
    ],
    math: [
      `<var>h</var> = ${RENT_SHARE} × <var>p</var> × ${RENT_GROWTH}<sup><var>v</var></sup> × <var>m</var>`,
      `rent paid at a check = <var>h</var> × min(<var>t</var>, ${Math.round(RENT_WINDOW_MS / 3_600_000)} h)`,
    ],
    vars: [
      ["<var>h</var>", "the rent of one record, in RP an hour"],
      ["<var>p</var>", "the RP its problem earned before multipliers, less any taken back"],
      ["<var>v</var>", "your level of Higher rent (0 without it)"],
      ["<var>m</var>", "your points multiplier on that problem now (standing, collections and rules)"],
      ["<var>t</var>", "the time since the record's last check, in hours"],
    ],
  },
  {
    text: [
      "Collections count every problem where the server confirmed a record of yours, even one beaten later. Once you own Collections they add to all your points, and they stay through resets.",
      `A shape pair is one piece shape in one container shape, each with ${FRONTIER_SIDES.slice(0, -1).join(", ")} or ${FRONTIER_SIDES.at(-1)} sides. It is complete when you have a confirmed record for each of its ${FRONTIER_P.length} piece counts, ${andList(FRONTIER_P.map(String))}.`,
      `A piece shape reaches a milestone at ${andList(SHAPE_MILESTONES.map(String))} confirmed records with that piece. A tier first is your first confirmed record in each tier, that is ${andList(Object.values(TIER_LABEL).map((t) => `${t}s`))}.`,
    ],
    math: [
      `<var>C</var> = ${PAIR_BONUS} × <var>A</var> + ${SHAPE_BONUS} × <var>K</var> + ${TIER_BONUS} × <var>Q</var>`,
      `all points × (1 + <var>C</var>)`,
    ],
    vars: [
      ["<var>C</var>", "the collections bonus (0.05 means +5 %)"],
      ["<var>A</var>", "your complete shape pairs"],
      ["<var>K</var>", "the milestones your piece shapes have reached, added over every shape"],
      ["<var>Q</var>", "the tiers with a first record (0 to 4)"],
    ],
  },
];

// ---------- auto-eval and its holds ----------

const AUTO: How = {
  text: [
    "Auto-eval runs evaluations for you while it is on, at its own rate, beside your own clicks. Its rate is in evaluations a second, set by the Auto-eval upgrades and Faster auto-eval. Upgrades of evaluations per click make your own clicks larger but do not speed auto-eval up. Its evaluations pay exactly as yours do.",
    "A lane is one solver worker in your browser, holding one open run. The lanes share auto-eval's rate, so with L lanes each one runs r / L evaluations a second. Each lane works on a different problem, because one run cannot be split. More lanes let more problems progress at once, but they add no evaluations. A lane with nothing to work on leaves its share to the others. Without Auto-advance, lane 1 works on the problem on the board and each other lane on another problem in the queue that already has a record. Auto-advance moves on from problems that stopped improving.",
    "Auto-eval runs only while this page is open in the tab that holds the game. It pauses while the tab is hidden, unless you own Continuous and allowed it in Settings, and while the device runs on battery, unless you allowed that in Settings. While it is off or paused it earns nothing, and it does not catch up later. Your own clicks are never paused.",
    `Auto-eval hands a lane its due evaluations in batches of at most ${AUTO_JOB_SECONDS} s worth of the lane's share, and at least 1 evaluation, so that a lane's worker gets only a few messages a second at any rate. A batch is also at most about ${AUTO_JOB_SECONDS} s of your computer's time on that problem, judged from how long evaluations of its run's method, at its setting, have taken here, so a click of yours waits behind little even on a large problem or with a slow method.`,
    `The rate is a target. When the solver is slower than that, because one evaluation takes longer than L / r seconds, auto-eval runs as fast as your computer allows, and the evaluations it has fallen behind wait their turn, up to ${AUTO_SLACK_SECONDS} s worth of them. Anything beyond that is dropped. The rate stops at ${AUTO_MAX} evaluations a second. Each lane is a solver worker of its own, so on a large problem more lanes spread the work over more cores.`,
  ],
  math: [
    `<var>r</var> = min(${AUTO_MAX}, <var>a</var> + ${AUTOX_STEP} × <var>x</var>)`,
    `<var>r</var><sub>lane</sub> = <var>r</var> / <var>L</var>`,
    `<var>b</var> = min(⌊<var>D</var>⌋, max(1, min(⌈${AUTO_JOB_SECONDS} × <var>r</var><sub>lane</sub>⌉, ⌊${AUTO_JOB_SECONDS * 1000} / <var>t</var>⌋)))`,
    `<var>D</var><sub>max</sub> = max(${COMPACT_EVALS}, ${AUTO_SLACK_SECONDS} × <var>r</var>)`,
  ],
  vars: [
    ["<var>r</var>", "auto-eval's target in all lanes together, in evaluations a second"],
    [
      "<var>a</var>",
      `the evaluations a second of the fastest Auto-eval upgrade you own, from ${AUTO_RATES[0]} to ${AUTO_RATES.at(-1)}`,
    ],
    [
      "<var>x</var>",
      `your level of Faster auto-eval (0 without it), which adds ${AUTOX_STEP} evaluations a second a level`,
    ],
    ["<var>L</var>", "your lanes"],
    ["<var>r</var><sub>lane</sub>", "each lane's share, in evaluations a second"],
    ["<var>b</var>", "the evaluations of a lane's next batch"],
    [
      "<var>t</var>",
      "the ms one evaluation of the batch's problem, with its run's method, is expected to take on your computer",
    ],
    ["<var>D</var>", "the evaluations auto-eval is due now, all lanes together"],
    ["<var>D</var><sub>max</sub>", "the most evaluations auto-eval can be behind at once"],
  ],
  note: "The totals bar shows the target r, as in “up to 10 evaluations a second”. With L = 2, each lane then runs up to 5 of them. Your computer may run fewer.",
};

const RUNNING: How = {
  text: [
    "These settings apply only to auto-eval. Your own clicks always run.",
    `A tab is hidden when another tab is in front of it or its window is minimised. Without Continuous, auto-eval always pauses then. With Continuous, the first box lets it keep running. A browser may wake a hidden tab only about once a minute, so auto-eval then runs in bursts and makes up at most ${AUTO_SLACK_SECONDS} s of falling behind.`,
    "The battery box appears only in browsers that tell the page whether the device is charging. Unticked, auto-eval pauses while the device is not charging.",
    "While auto-eval is paused it earns nothing and owes nothing. When it resumes, it starts from that moment and does not make up the time it was paused.",
    "Only one tab runs the game at a time. If you open Tighter in a second tab, the second tab waits, and Play here instead moves the game to it.",
  ],
};

// ---------- sending ----------

const SENDING: How = {
  text: [
    `Nothing is sent until you enter a display name, tick the box and save. From then on the game sends a board to PolyPack whenever it beats the current record for its problem by more than the smallest improvement that counts (${MIN_STEP} of the side). Just before each send it asks the server for the current record, and it turns the container to its best angle, as the server scores it.`,
    `Each send contains the problem (piece shape, container shape and number of pieces), the position and angle of every piece, the container's angle and your display name. It also says how the board was found, which is the method, its settings, the seed, the number of evaluations and the tag ${CLIENT_TAG}.`,
    `Sends are paced. A problem's first send goes at once, and each later send for the same problem waits at least ${minutes(PROBLEM_INTERVAL_MS)} after the one before. In all, first sends included, at most ${PLAYER_PER_MINUTE} sends go in any ${seconds(PLAYER_WINDOW_MS)}. If the server asks the game to slow down, all sending pauses for ${minutes(RATE_LIMITED_BACKOFF_MS)}, and if the server cannot be reached, for ${seconds(OFFLINE_BACKOFF_MS)}.`,
    `Your name is cleaned the way the server stores it. Control characters, invisible direction marks and angle brackets become spaces, runs of spaces become one, and the name is cut to ${MAX_NAME_LENGTH} characters.`,
    "If you stop sending, the points the server has not confirmed yet are taken back, and they are paid again when you send again. Records already on the server stay there under your name. A problem you drop stays in the queue, marked as leaving, until its unsent best has gone.",
  ],
  math: [
    `sent only when <var>s</var> &lt; <var>s</var><sub>record</sub> × (1 − ${minStep})`,
    `<var>t</var><sub>next</sub> = max(<var>t</var><sub>last</sub> + ${seconds(PROBLEM_INTERVAL_MS)}, <var>t</var><sub>${PLAYER_PER_MINUTE}</sub> + ${seconds(PLAYER_WINDOW_MS)})`,
  ],
  vars: [
    ["<var>s</var>", "your board's side when it is sent, after the container's turn"],
    [
      "<var>s</var><sub>record</sub>",
      "the record's side read from the server just before, or with no record the starting score. A published value counts too when it is smaller.",
    ],
    ["<var>t</var><sub>next</sub>", "the earliest time the problem's next send can go (and never during a pause)"],
    ["<var>t</var><sub>last</sub>", "the time of that problem's last send (none before its first)"],
    [
      `<var>t</var><sub>${PLAYER_PER_MINUTE}</sub>`,
      `the time of the ${PLAYER_PER_MINUTE}th most recent send of any problem (none while fewer than ${PLAYER_PER_MINUTE} went in the last minute)`,
    ],
  ],
};

// ---------- the Runs panel ----------

export const PIPELINE: How = {
  text: [
    `A pipeline is a list of methods that the runs on a problem follow in turn. Each time a run ends by itself, because its method stopped improving, it reached ${int(RUN_BUDGET)} evaluations${stallRule() ? " or the game ended it at a stall" : ""}, the next run on that problem uses the next stage. After the last stage it starts again at the first.`,
    ...(runRules() ? [runRules()] : []),
    "A run that the game closes early does not move the pipeline on. That happens when its lane moves to another problem or the page reloads. The next run then repeats the same stage with a new random seed.",
    "Stages whose method this cycle's rule does not allow are skipped. While the pipeline has at least one stage, it chooses the method of every new run, and the toolbar's method is not used. With Auto-tune and Auto chosen, the game still picks the setting of each stage's method.",
  ],
  math: [`stage = (<var>n</var> mod <var>S</var>) + 1`],
  vars: [
    ["<var>n</var>", "the runs on this problem that ended by themselves"],
    ["<var>S</var>", `the number of stages (at most ${MAX_STAGES})`],
  ],
};

export const METHOD_MATCH: How = {
  text: [
    "Method match learns which method pays best on each kind of problem, and chooses the method of each new run when Auto is chosen in the toolbar. With Auto-tune it also chooses the method's setting, from level 0 up to the tuning level you own.",
    "A kind of problem combines its tier (open problem, loose record, site record or published value), its size by N + M + P (300 or more, 200 to 299, 120 to 199, 80 to 119, 50 to 79, 30 to 49, or under 30) and its pieces (circles, 3 to 8 sides, 9 to 20 sides, or more than 20).",
    `When a run ends or is replaced, the game records its value, which is the RP its problem earned during the run before multipliers, divided by the run's evaluations. Runs of every method count, even before you own Method match, except Compact and runs shorter than ${MIN_OBSERVED_EVALS} evaluations.`,
    "To choose, the game draws one random value for each method from what it has learned, a bell curve around the method's average that narrows as the method gets more runs, and runs the method with the highest draw. Methods with few runs still get tried, and the best one is chosen more and more often.",
    "A method not yet tried on a kind of problem starts from the average of the methods tried on that kind (or on any kind, when none has been), with a spread at least as wide as that average.",
  ],
  math: [
    `<var>y</var> = <var>p</var> / <var>e</var>`,
    `<var>μ</var> = (<var>μ</var><sub>0</sub> / <var>σ</var><sub>0</sub><sup>2</sup> + <var>n</var> × <var>ȳ</var> / <var>v</var>) / (1 / <var>σ</var><sub>0</sub><sup>2</sup> + <var>n</var> / <var>v</var>)`,
    `<var>σ</var> = 1 / √(1 / <var>σ</var><sub>0</sub><sup>2</sup> + <var>n</var> / <var>v</var>)`,
    `draw = <var>μ</var> + <var>σ</var> × <var>z</var>, and the method with the highest draw runs`,
  ],
  vars: [
    ["<var>y</var>", "the value of one run, in RP an evaluation"],
    ["<var>p</var>", "the RP the problem earned during the run, before multipliers"],
    ["<var>e</var>", `the run's evaluations (at least ${MIN_OBSERVED_EVALS})`],
    ["<var>n</var>", "the method's runs on this kind of problem"],
    ["<var>ȳ</var>", "the average value of those runs"],
    ["<var>v</var>", "the variance of their values (with a single run, the starting spread squared)"],
    [
      "<var>μ</var><sub>0</sub>, <var>σ</var><sub>0</sub>",
      "the starting belief, an average and a spread in RP an evaluation",
    ],
    ["<var>μ</var>, <var>σ</var>", "the belief after n runs (the panel shows μ)"],
    ["<var>z</var>", "a random number from a standard normal distribution"],
  ],
};

export const TRANSFERS: How = {
  text: [
    "With Transfers, a new open problem can start from the best known packing of the same piece and container with fewer pieces, instead of every piece on rings around the centre.",
    `The game looks first at your own boards in the queue with fewer pieces, then at the site's records for up to ${MAX_NEIGHBOUR_LOOKUPS} smaller piece counts, closest first. Those are the piece counts below P among ${andList(FRONTIER_P.map(String))}, and with More open problems first P − 1, P − 2 and P − 3. The missing pieces are placed in free space around the packing, and when 6 or fewer are missing, each goes where it grows the container least.`,
    `The transfer is used only when its side is more than ${pct(1 - TRANSFER_MARGIN)} smaller than the rings' side. The starting score is then the smallest of the sides below, so the transferred board is never sent unless you improve it.`,
  ],
  math: [
    `use the transfer when <var>s</var><sub>T</sub> &lt; ${TRANSFER_MARGIN} × <var>s</var><sub>L</sub>`,
    `starting score = min(<var>s</var><sub>L</sub>, <var>s</var><sub>T</sub>, <var>s</var><sub>P+1</sub>)`,
  ],
  vars: [
    ["<var>s</var><sub>T</sub>", "the transferred board's side"],
    ["<var>s</var><sub>L</sub>", "the side with every piece on rings around the centre"],
    [
      "<var>s</var><sub>P+1</sub>",
      "the record for one more piece, if there is one. Without one of its pieces, it packs P pieces in no more room.",
    ],
  ],
};

/** The explanations tighter.html places, by their `data-how` names. */
export const HELP: Record<string, How | How[]> = {
  points: POINTS,
  counts: COUNTS,
  standing: STANDING,
  rules: RULES_HOW,
  records: RECORDS,
  auto: AUTO,
  running: RUNNING,
  sending: SENDING,
};
