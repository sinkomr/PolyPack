import { improvesOn } from "@polypack/geometry";
import { AUTO_CLICK_EVALS, DEAL_CLICKS } from "./dealer";
import {
  COMBO_BONUS,
  COMBO_RECORDS,
  RENT_PAYDAY_MS,
  RENT_GROWTH,
  RENT_RETRY_MS,
  RENT_SHARE,
  RENT_WINDOW_MS,
  SHAPE_BONUS,
  SHAPE_MILESTONES,
  TIER_BONUS,
} from "./economy";
import { rulesOf } from "./families";
import { FRONTIER_P, poly } from "./frontier";
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
  BEAT_OTHER_FACTOR,
  CONTEST,
  FIRST_RECORD_BONUS,
  FIRST_RECORD_GAP_RATIO,
  FLOOR,
  GAP_WEIGHT,
  SIZE_WEIGHT,
  TIER_LABEL,
  costFactor,
  recordPoints,
} from "./points";
import { MAX_STAGES, MIN_OBSERVED_EVALS } from "./runplan";
import { DIMENSION_TEXT, RESET_MIN, RULES, resetThreshold } from "./standing";
import { CLIENT_TAG } from "./submission";
import { MAX_NEIGHBOUR_LOOKUPS, TRANSFER_MARGIN } from "./transfer";
import { AUTO_BASE, AUTO_JOB_SECONDS, AUTO_SLACK_SECONDS, COMPACT_EVALS, RUN_BUDGET } from "./upgrades";

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
 * beat it by more than the smallest improvement that counts. `side` is "side", or "diameter" for a
 * circle container.
 */
export function smallerText(side: string, before: number | null, after: number | null): string {
  if (before === null || after === null || !improvesOn(after, before)) return "";
  return `It made the ${side} ${((1 - after / before) * 100).toFixed(3)} % smaller.`;
}

// ---------- how points are paid ----------

/** The worked example: 60 24-gons in a 30-gon (an open problem), a board 20 % above the area bound. */
const EXAMPLE = poly(24, 30, 60);
const exampleBound = rulesOf(EXAMPLE).bound(EXAMPLE)!;
const exampleSide = exampleBound * 1.2;
const exampleW = rulesOf(EXAMPLE).weight(EXAMPLE);
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
    `so ${exampleW.toFixed(3)} × ${r.k.toFixed(3)} × ${sum.toFixed(sum < 10 ? 3 : 2)} = ${r.total.toFixed(2)} RP`
  );
}

const POINTS: How[] = [
  {
    text: [
      `You earn record points (RP) whenever a click makes your board smaller by more than ${MIN_STEP} of its size, which is the same limit the server uses. The points are paid right away, whether you pressed Evolve yourself or auto-eval did it for you.`,
      "Your records are sent to PolyPack under your display name, and points are paid from your very first click. You can change the name at any time in Settings.",
      "Each payment is made of a few parts. The two biggest parts reward a smaller side and a side that is closer to the area bound. The area bound is the smallest side that the total area of the pieces allows. Over a whole run they add up to the same total however many clicks it takes, so a run that shrinks the side more pays more.",
      `Every click that improves the board also pays a small step part, which is larger for larger steps. The first click on a new problem (Compact, ${int(COMPACT_EVALS)} evaluations at once) usually pays the most, because a new board has the most room to shrink.`,
      "The payment is then multiplied by three weights. The shape weight makes shapes with many sides pay less, because they are close to circles. The contest weight makes problems that other players work on, and published values, pay more. The cost weight lets slow problems pay about as much per second as fast ones. Your points multiplier applies as well.",
      "Beating an existing record pays double on your accepted new record. Every payment is doubled from the moment your board is better than the other record, until the server accepts your board as the new record. After that, payments are single again.",
      "The server checks every record you send, and a board is usually sent within a minute. If the server does not accept it as the record, for example because another name got there first, the points paid for that board are taken back. Points you have already spent are not owed, and your balance never goes below 0.",
    ],
    math: [
      `<var>Δ</var> = 1 − <var>s</var><sub>new</sub> / <var>s</var><sub>prev</sub>, paid only when <var>Δ</var> &gt; <var>F</var>`,
      `RP = <var>m</var> × <var>w</var> × <var>c</var> × <var>κ</var> × (<var>t</var><sub>step</sub> + <var>t</var><sub>size</sub> + <var>t</var><sub>gap</sub> + <var>B</var>) × <var>β</var>`,
      `<var>t</var><sub>step</sub> = 1 + log<sub>10</sub>(<var>Δ</var> / <var>F</var>)`,
      `<var>t</var><sub>size</sub> = ${int(SIZE_WEIGHT)} × ln(<var>s</var><sub>prev</sub> / <var>s</var><sub>new</sub>)`,
      `<var>t</var><sub>gap</sub> = ${int(GAP_WEIGHT)} × ln(<var>g</var><sub>prev</sub> / <var>g</var><sub>new</sub>)`,
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
        "your board's new side, in units where a polygon piece has side 1 and a circle piece has diameter 1. For a circle container it is the diameter.",
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
        `bonus points, ${FIRST_RECORD_BONUS} for a problem's first record when its gap is at most ${FIRST_RECORD_GAP_RATIO} of the starting score's gap, otherwise 0`,
      ],
      [
        "<var>κ</var>",
        "the cost factor, the time one evaluation of the problem takes over the time one takes at N + M + P = 85, from a fixed table, so that a slow problem pays about as much for a second of work as a fast one",
      ],
      [
        "<var>β</var>",
        `${BEAT_OTHER_FACTOR} for every payment while your board is better, at 6 decimals, than another name's record or a published value and the server has not yet made your entry the record. It starts again each time another name takes the lead and you beat it. Otherwise 1`,
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
    text: `An example, before your multiplier. The problem 24-gons in a 30-gon with 60 pieces is open. Your board's side is 20 % above its area bound. Here is what four different clicks would pay.`,
    math: [
      exampleLine(1.0000001 * FLOOR, `just above ${minStep}`),
      exampleLine(1e-6, "= 10<sup>−6</sup>"),
      exampleLine(1e-3, "= 10<sup>−3</sup>"),
      exampleLine(1e-2, "= 10<sup>−2</sup>"),
    ],
    vars: [
      ["<var>w</var>", `the shape weight here, ${exampleW.toFixed(3)}`],
      ["<var>κ</var>", `the cost factor here, ${costFactor(EXAMPLE).toFixed(3)}`],
      [
        "<var>b</var>",
        `the area bound here, ${exampleBound.toFixed(6)}. The board's side is ${exampleSide.toFixed(6)}, 20 % above it. The contest weight of an open problem is ${CONTEST.open}.`,
      ],
    ],
    note: "The step term depends only on how big the step is. It does not grow as your record gets better, which is why it rises and falls from one click to the next. The size and gap terms of many small steps add up to those of one big step that shrinks the side as much.",
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
    "An evaluation is one scoring of your packing by the solver, which checks every overlap and how tightly the container fits. Between two evaluations the solver moves the pieces a little.",
    "A click is one press of Evolve, and it runs as many evaluations as you have per click.",
    `A new open problem starts with every piece on rings around the centre. Its side, or the side of a smaller known packing, is the starting score. Your first record must beat it. The starting board is never sent. Your first click on a problem is Compact, ${int(COMPACT_EVALS)} evaluations of mc_compress at once.`,
    `A run is one session of a solver method on one problem, starting from the problem's best board. Each run uses a new random seed, so it searches in a different way. A run stays open between clicks, and it ends when its method stops improving or after ${int(RUN_BUDGET)} evaluations. The next click after that starts a new run. ${runRules()}${runRules() ? " " : ""}Changing the method or its settings also starts a new run.`,
    "Evaluations run counts every evaluation, yours and auto-eval's, while Clicks counts only your own presses of Evolve. Compute is the time the solver has spent, added up over all lanes, so with two busy lanes it grows twice as fast as the clock.",
    "Records held counts the problems where your entry is the current record on PolyPack, as far as the game knows. Earned counts all the record points you have earned, minus any that were taken back, and spending points does not lower it.",
    `New problems are earned by work, counted in clicks. Each Evolve click counts as one click, whatever its evaluations. Compact's ${int(COMPACT_EVALS)} evaluations count as ${int(COMPACT_EVALS)} divided by your evaluations per click. Auto-eval's evaluations count ${AUTO_CLICK_EVALS} to the click.`,
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
    "A cycle is the time between two resets. When you reset, you trade this cycle's record points and most of your tech tree for standing.",
    "Each point of standing adds 10 % to all the record points you earn, and it counts whether you spend it or not. You can spend standing on the upgrades in the Standing row of the tech tree, and resets keep those upgrades.",
    `You can reset once this cycle has earned ${int(RESET_MIN)} RP that the server has confirmed. Each cycle needs 5 times as many as the one before it, so ${int(resetThreshold(1))} in the second cycle and ${int(resetThreshold(2))} in the third. Points that are still waiting for the server carry over into the next cycle.`,
    `The first reset opens ${DIMENSION_TEXT["2-on-3"].label}, ${DIMENSION_TEXT["2-on-3"].what}. The second opens ${DIMENSION_TEXT["3-in-3"].label}, ${DIMENSION_TEXT["3-in-3"].what}. A dimension stays open for good, and the problems in it are dealt by cards in the Dimensions row, which you buy again in each cycle. Curved problems, a part of ${DIMENSION_TEXT["2-in-2"].label}, have a card from the first cycle on.`,
    "A reset takes away your RP and every upgrade bought with RP, the Dimensions row included. The only exceptions are Records pay rent, Higher rent, Collections and Standing. Keep auto-eval also keeps the Auto-eval row, and Keep methods keeps your methods. Head starts give their upgrades back at once, at level 1.",
    "A reset keeps your records on the server, and they go on paying rent. It also keeps your collections, your standing, the Standing row, the queue, what the dealer has learned and every count.",
  ],
  math: [
    `<var>G</var> = ⌊5 × √(<var>E</var> / <var>R</var>)⌋, once <var>E</var> ≥ <var>R</var>`,
    `<var>R</var> = ${int(RESET_MIN)} × 5<sup><var>n</var></sup>`,
    `<var>G</var><sub>rule</sub> = max(1, ⌈<var>G</var> / 2⌉), added only for a cycle played under a rule`,
    `multiplier on all points = 1 + 0.1 × <var>T</var>`,
    `<var>E</var><sub>next</sub> = <var>R</var> × ((<var>G</var> + 1) / 5)<sup>2</sup>`,
  ],
  vars: [
    ["<var>G</var>", "the standing a reset gives now"],
    ["<var>E</var>", "the record points earned in this cycle and confirmed by the server, rent included"],
    ["<var>R</var>", "the record points this cycle needs for a reset (the threshold)"],
    ["<var>n</var>", "the resets you have made so far (0 in the first cycle)"],
    ["<var>G</var><sub>rule</sub>", "the extra standing for finishing a cycle under a rule"],
    ["<var>T</var>", "the standing you have earned in all cycles, spent or not"],
    [
      "<var>E</var><sub>next</sub>",
      "the confirmed record points of this cycle at which the reset gives one more standing",
    ],
  ],
  note: "The milestones show how long this cycle took to reach a few key upgrades, next to your fastest earlier cycle.",
};

const RULES_HOW: How = {
  text: [
    "Before a reset you can choose a rule for the next cycle, and the rule limits that whole cycle. If you finish a cycle under a rule, the reset gives half again as much standing, rounded up and at least 1 more. You also keep the rule's reward for good, but it comes only once per rule, while the extra standing comes every time you finish a cycle under it.",
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
      `Once you own Records pay rent, every record you still hold earns rent each hour. The rent is ${pct(RENT_SHARE)} of the points its problem paid before multipliers, and each level of Higher rent multiplies it by ${RENT_GROWTH}. Your points multiplier at that moment applies as well.`,
      `Rent builds up all the time, even while the game is closed. When the page opens, and every ${Math.round(RENT_PAYDAY_MS / 3_600_000)} hours after that, it is payday. The game asks the server about all your records at once, in groups of up to 200. A record that is still yours pays the rent since its last payday, for at most ${Math.round(RENT_WINDOW_MS / 86_400_000)} days. If someone has beaten it, you are paid nothing for that time. A record you won during the day is paid for its part of a day. A record the server could not answer is tried again after ${minutes(RENT_RETRY_MS)}.`,
      "Rent counts as record points earned in this cycle, so it also counts toward a reset.",
    ],
    math: [
      `<var>h</var> = ${RENT_SHARE} × <var>p</var> × ${RENT_GROWTH}<sup><var>v</var></sup> × <var>m</var>`,
      `rent paid at a payday = <var>h</var> × min(<var>t</var>, ${Math.round(RENT_WINDOW_MS / 3_600_000)} h)`,
    ],
    vars: [
      ["<var>h</var>", "the rent of one record, in RP an hour"],
      ["<var>p</var>", "the RP its problem earned before multipliers, less any taken back"],
      ["<var>v</var>", "your level of Higher rent (0 without it)"],
      ["<var>m</var>", "your points multiplier on that problem now (standing, collections and rules)"],
      ["<var>t</var>", "the time since the record's last payday, in hours"],
    ],
  },
  {
    text: [
      "Collections count every problem where the server confirmed a record of yours, even one that was beaten later. Once you own Collections, they add to all your points, and they stay through resets. Only polygon problems count for now.",
      `Same pieces and container. When you have ${COMBO_RECORDS} confirmed records with the same pieces in the same container, such as 21-gons in a 24-gon, you get +${COMBO_BONUS * 100} %. The piece counts can be anything.`,
      `Same pieces. A piece shape reaches a milestone at ${andList(SHAPE_MILESTONES.map(String))} confirmed records with that piece, in any container. Each milestone gives +${SHAPE_BONUS * 100} %.`,
      `Tiers. A tier first is your first confirmed record in each tier, which are ${andList(Object.values(TIER_LABEL).map((t) => `${t}s`))}. Each gives +${TIER_BONUS * 100} %.`,
      "Example. You have 9 records of 21-gons in a 24-gon, and 3 more of 21-gons in other containers. The 9 give +2 %. All 12 have 21-gon pieces, so they give +1 % more. With your first open problem and your first loose record (+10 %), every point you earn is multiplied by 1.13.",
    ],
    math: [
      `<var>C</var> = ${COMBO_BONUS} × <var>A</var> + ${SHAPE_BONUS} × <var>K</var> + ${TIER_BONUS} × <var>Q</var>`,
      `all points × (1 + <var>C</var>)`,
    ],
    vars: [
      ["<var>C</var>", "the collections bonus (0.05 means +5 %)"],
      ["<var>A</var>", `your combinations of pieces and container with ${COMBO_RECORDS} records`],
      ["<var>K</var>", "the milestones your piece shapes have reached, added over every shape"],
      ["<var>Q</var>", "the tiers with a first record (0 to 4)"],
    ],
  },
];

// ---------- auto-eval and its holds ----------

const AUTO: How = {
  text: [
    "Auto-eval runs evaluations for you while it is on, alongside your own clicks. Its rate is in evaluations a second, and it is set by Auto-eval and Faster auto-eval. Upgrades of evaluations per click make your own clicks bigger but do not speed auto-eval up. Its evaluations pay just as yours do.",
    "A lane is a solver worker in your browser. It holds one open run, and each lane works on a different problem. The lanes share auto-eval's rate, so more lanes let more problems progress at once, but they add no evaluations. A lane with nothing to work on leaves its share to the others. Without Auto-advance, lane 1 works on the problem on the board, and each other lane works on another problem in the queue that already has a record. Auto-advance also moves on from problems that have stopped improving.",
    "Auto-eval runs only while this page is open in the tab that holds the game. It pauses while the tab is hidden, unless you own Continuous and allowed it in Settings, and it pauses on battery power, unless you allowed that in Settings. While it is off or paused it earns nothing, and it does not catch up later. Your own clicks never pause.",
    `Auto-eval gives each lane its evaluations in small batches, so a lane's worker gets only a few messages a second. A batch is at most about ${AUTO_JOB_SECONDS} s of your computer's time, judged from how long that problem's evaluations have taken here. So a click of yours waits behind very little, even on a large problem or with a slow method.`,
    `The rate is a target. If the solver is slower than that, auto-eval runs as fast as your computer allows. The evaluations it has fallen behind on wait their turn, up to ${AUTO_SLACK_SECONDS} s worth of them. Anything beyond that is dropped. Each lane is its own solver worker, so on a large problem more lanes spread the work over more cores.`,
  ],
  math: [
    `<var>r</var> = ${AUTO_BASE} + <var>x</var> for <var>x</var> up to 49, then the steps of the table under Faster auto-eval (5 a level from 50, 10 from 200, 50 from 500, 100 from 1,000)`,
    `<var>r</var><sub>lane</sub> = <var>r</var> / <var>L</var>`,
    `<var>b</var> = min(⌊<var>D</var>⌋, max(1, min(⌈${AUTO_JOB_SECONDS} × <var>r</var><sub>lane</sub>⌉, ⌊${AUTO_JOB_SECONDS * 1000} / <var>t</var>⌋)))`,
    `<var>D</var><sub>max</sub> = max(${COMPACT_EVALS}, ${AUTO_SLACK_SECONDS} × <var>r</var>)`,
  ],
  vars: [
    ["<var>r</var>", "auto-eval's target in all lanes together, in evaluations a second"],
    [
      "<var>x</var>",
      "your level of Faster auto-eval (0 without it), which has no last level and adds 1 evaluation a second a level at first, then more",
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
    `A tab is hidden when another tab is in front of it or its window is minimised. Without Continuous, auto-eval pauses then, and with Continuous the first box lets it keep running. A browser may wake a hidden tab only about once a minute, so auto-eval then runs in bursts and makes up at most ${AUTO_SLACK_SECONDS} s of falling behind.`,
    "The battery box shows only in browsers that tell the page whether the device is charging. When it is unticked, auto-eval pauses whenever the device is not charging.",
    "While auto-eval is paused it earns nothing and owes nothing. When it resumes, it starts from that moment and does not make up the lost time.",
    "Only one tab runs the game at a time. If you open Tighter in a second tab, that tab waits, and pressing Play here moves the game to it.",
  ],
};

// ---------- sending ----------

const SENDING: How = {
  text: [
    `Every game has a display name from the start, "TighterGamePlayer" and seven digits. You can change it in Settings. The game sends a board to PolyPack when it beats the current record for its problem by more than ${MIN_STEP} of the side. Just before each send, it asks the server for the current record and turns the container to its best angle, which is how the server scores it.`,
    `A send contains the problem (piece shape, container shape and number of pieces), the position and angle of every piece, the container's angle and your display name. It also says how the board was found, which means the method, its settings, the seed, the number of evaluations and the tag ${CLIENT_TAG}.`,
    `Sends are paced. The first send for a problem goes at once, and each later send for it waits at least ${minutes(PROBLEM_INTERVAL_MS)} after the one before. At most ${PLAYER_PER_MINUTE} sends go in any ${seconds(PLAYER_WINDOW_MS)}. If the server asks the game to slow down, sending pauses for ${minutes(RATE_LIMITED_BACKOFF_MS)}, and if the server cannot be reached, it pauses for ${seconds(OFFLINE_BACKOFF_MS)}.`,
    `Your name is cleaned the way the server stores it. Control characters, invisible direction marks and angle brackets become spaces, runs of spaces become one, and the name is cut to ${MAX_NAME_LENGTH} characters.`,
    "Records on the server keep the name they were sent with, even if you change your name later. A problem you drop stays in the queue, marked as leaving, until its unsent best has gone.",
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
    `A pipeline is a list of methods that the runs on a problem follow in turn. A run ends by itself when its method stops improving, when it reaches ${int(RUN_BUDGET)} evaluations${stallRule() ? ", or when the game ends it at a stall" : ""}. The next run on that problem then uses the next stage. After the last stage, the pipeline starts again at the first.`,
    ...(runRules() ? [runRules()] : []),
    "A run that the game closes early does not move the pipeline on. That happens when its lane moves to another problem or the page reloads. The next run then repeats the same stage with a new random seed.",
    "Stages whose method this cycle's rule does not allow are skipped. While the pipeline has a stage, it picks the method of every new run, so the toolbar's method is not used. With Auto-tune and Auto chosen, the game still picks the setting for each stage's method.",
  ],
  math: [`stage = (<var>n</var> mod <var>S</var>) + 1`],
  vars: [
    ["<var>n</var>", "the runs on this problem that ended by themselves"],
    ["<var>S</var>", `the number of stages (at most ${MAX_STAGES})`],
  ],
};

export const METHOD_MATCH: How = {
  text: [
    "Method match learns which method pays best on each kind of problem. When Auto is chosen in the toolbar, it picks the method for each new run. With Auto-tune it also picks the method's setting, from level 0 up to the tuning level you own.",
    "A kind of problem combines its tier (open problem, loose record, site record or published value), its size and its pieces. The size is the piece's sides plus the container's sides plus the number of pieces. It falls in a band: 300 or more, 200 to 299, 120 to 199, 80 to 119, 50 to 79, 30 to 49, or under 30. The pieces are circles, 3 to 8 sides, 9 to 20 sides, or more than 20 sides.",
    `After each run, the game records its value. That is the RP its problem earned during the run, before multipliers, divided by the run's evaluations. Runs of every method count, even before you own Method match. Compact and runs shorter than ${MIN_OBSERVED_EVALS} evaluations are the only ones that do not count.`,
    "To choose, the game draws a random value for each method from what it has learned. The draw is centred on the method's average and narrows as the method gets more runs, and the method with the highest draw is the one that runs. This way methods with few runs still get tried, and the best one is chosen more and more often.",
    "A method not yet tried on a kind of problem starts from the average of the methods tried on that kind, or on any kind if none has been tried. Its spread is at least as wide as that average, so it still gets a fair chance.",
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
    "With Transfers, a new open problem can start from the best known packing of the same shapes with fewer pieces. Without it, every piece starts on rings around the centre of the container.",
    `The game looks first at your own boards in the queue with fewer pieces. Then it looks at the site's records for up to ${MAX_NEIGHBOUR_LOOKUPS} smaller piece counts, closest first. Those are the counts below the problem's among ${andList(FRONTIER_P.map(String))}. With More open problems they also include the three counts just below it. The missing pieces are placed in free space around the packing. When 6 or fewer are missing, each goes where it grows the container least.`,
    `The transfer is used only when its side is more than ${pct(1 - TRANSFER_MARGIN)} smaller than the rings' side. The starting score is then the smallest of the rings' side, the transferred side and the record for one more piece. The transferred board is never sent unless you improve it. Your points still count from the start without the transfer, so a transfer costs you no points.`,
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
