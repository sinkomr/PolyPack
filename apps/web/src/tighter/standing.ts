import {
  FRONTIER,
  FRONTIER_P,
  FRONTIER_SIDES,
  DimensionId,
  ProblemKey,
  isPolygon,
  keyOf,
  needPolygon,
  poly,
  SMALL_PIECES,
  SMALL_TOTAL,
} from "./frontier";
import { RESET_GROWTH, RESET_MIN } from "./points";
import type { GameState } from "./game";
import { archiveOf, archivedCount } from "./archive";
import { spaceFields } from "./families";
import { ballsProblemOf } from "@polypack/balls/catalogue";
import { nextNoon, tidyRent } from "./economy";
import type { RuleWide } from "./dealer";
import {
  EvolveMethod,
  Funds,
  UPGRADES,
  UpgradeId,
  canBuy,
  costOf,
  currencyOf,
  headStartGives,
  level,
  owning,
  upgrade,
} from "./upgrades";

/**
 * Standing: the reset currency (plan §5).
 *
 * Buying the Standing card in the tech tree is the reset (2026-11-01). It costs the cycle's threshold
 * in record points (resetThreshold) and needs as many confirmed record points earned in the cycle. A
 * reset trades the cycle's record points and the main tree for 1 standing point (2 when the cycle was
 * played under a rule) and doubles all record points for good. Records stay on the server, and the
 * dealer's learning, the queue and the lifetime counts stay. Rent, Higher rent and Collections go like
 * the other cards, unless Head start gives them back. Standing buys the Standing row: Head start,
 * rows that survive resets, and mechanics that exist nowhere else (Pipelines, Auto-tune). A cycle may
 * be played under a rule (circles only, small problems, clicks only, one method): finishing it under
 * the rule pays one more standing point and a reward of the rule's own, for good. The rules also aim
 * the players' compute at one family of problems.
 *
 * The One seed rule (id "seed") was dropped with the Seeds row on 2026-10-22. A save read with it as
 * the cycle's rule goes on without a rule, and a finished "seed" rule, its reward and its history
 * entries are forgotten: ruleOrNull knows only the rules below.
 */

/** One cycle, as the history shows it. */
export interface CycleRecord {
  startedAt: number;
  endedAt: number;
  /** Record points earned in the cycle. */
  earned: number;
  /** Standing points it gave. */
  gain: number;
  rule: string | null;
  /** Milestones reached: ms since the cycle began, by mark id. */
  marks: Record<string, number>;
}

export interface StandingState {
  /** Standing to spend on the Standing row. */
  points: number;
  /** Standing ever earned, spent or not (shown; the multiplier comes from the resets). */
  total: number;
  resets: number;
  /** Record points earned in this cycle (since the last reset). */
  cycleEarned: number;
  cycleStartedAt: number;
  /** The rule this cycle is played under, if any. */
  rule: string | null;
  /** Rules finished so far: their rewards hold for good. */
  rulesDone: string[];
  /** The rule chosen for the next cycle (Cycle rules), if any. */
  nextRule: string | null;
  /** Milestones of this cycle: ms since it began, by mark id. */
  marks: Record<string, number>;
  /** Past cycles, the latest last. */
  history: CycleRecord[];
  /** The dimensions opened for good (a reset opens the next, see dimensionOpenedBy). */
  dimensions: DimensionId[];
}

const DIMENSION_IDS: readonly DimensionId[] = ["2-in-2", "2-on-3", "3-in-3", "3-on-4"];

export const HISTORY_LIMIT = 20;

export const newStanding = (now: number): StandingState => ({
  points: 0,
  total: 0,
  resets: 0,
  cycleEarned: 0,
  cycleStartedAt: now,
  rule: null,
  rulesDone: [],
  nextRule: null,
  marks: {},
  history: [],
  dimensions: ["2-in-2"],
});

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, fallback: number, min = 0) =>
  typeof v === "number" && Number.isFinite(v) && v >= min ? v : fallback;
const ruleOrNull = (v: unknown): string | null => (typeof v === "string" && RULES.some((r) => r.id === v) ? v : null);

function marks(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObj(v)) return out;
  for (const [k, t] of Object.entries(v))
    if (MARKS.some((m) => m.id === k) && typeof t === "number" && Number.isFinite(t) && t >= 0) out[k] = t;
  return out;
}

/** The dimensions opened, in the table's order, with the first always among them. */
function dimensionsOf(v: unknown): DimensionId[] {
  const got = Array.isArray(v) ? v : [];
  return DIMENSION_IDS.filter((id) => id === "2-in-2" || got.includes(id));
}

export function normalizeStanding(v: unknown, now: number): StandingState {
  const d = newStanding(now);
  if (!isObj(v)) return d;
  return {
    points: num(v.points, 0),
    total: num(v.total, 0),
    resets: Number.isSafeInteger(v.resets) && (v.resets as number) >= 0 ? (v.resets as number) : 0,
    cycleEarned: num(v.cycleEarned, 0),
    cycleStartedAt: num(v.cycleStartedAt, now),
    rule: ruleOrNull(v.rule),
    rulesDone: Array.isArray(v.rulesDone)
      ? [...new Set(v.rulesDone.map(ruleOrNull).filter((r): r is string => r !== null))]
      : [],
    nextRule: ruleOrNull(v.nextRule),
    marks: marks(v.marks),
    history: Array.isArray(v.history)
      ? v.history
          .filter(isObj)
          .map((h) => ({
            startedAt: num(h.startedAt, 0),
            endedAt: num(h.endedAt, 0),
            earned: num(h.earned, 0),
            gain: num(h.gain, 0),
            rule: ruleOrNull(h.rule),
            marks: marks(h.marks),
          }))
          .slice(-HISTORY_LIMIT)
      : [],
    dimensions: dimensionsOf(v.dimensions),
  };
}

/** The multiplier standing puts on every record point: each reset doubles it, 2^resets. */
export const standingMultiplier = (s: StandingState): number => Math.pow(2, s.resets);

// ---------- cycle rules ----------

export interface Rule {
  id: string;
  name: string;
  /** What the rule takes away for one cycle, as one or two sentences. */
  limit: string;
  /** What finishing a cycle under it gives for good, as a sentence that reads after "Once finished, ". */
  reward: string;
}

export { SMALL_PIECES, SMALL_TOTAL };

export const RULES: readonly Rule[] = [
  {
    id: "circles",
    name: "Circles only",
    limit:
      "Only problems with circles are dealt. In 2D in 2D that means circle pieces or a circle container, in the other Dimensions disk or ball pieces or a ball container.",
    reward: "Every problem the rule would deal pays 1.5 times the points, in every Dimension.",
  },
  {
    id: "small",
    name: "Small problems only",
    limit: `Only small problems are dealt. In 2D in 2D that means size ${SMALL_TOTAL} or less, in the other Dimensions ${SMALL_PIECES} pieces or fewer. Size is N + M + P, the sides of the piece and of the container plus the number of pieces, with 0 sides for a circle.`,
    reward: `Every problem the rule would deal pays 1.5 times the points, in every Dimension.`,
  },
  {
    id: "clicks",
    name: "Clicks only",
    limit: "Auto-eval is off, so every evaluation comes from your own clicks.",
    reward: "Every click runs one more evaluation.",
  },
  {
    id: "method",
    name: "One method",
    limit: "Only mc_compress runs. Other methods are greyed out, and pipeline stages that use them are skipped.",
    reward: "Improvements found by mc_compress pay 1.5 times the points.",
  },
];
export const ruleById = (id: string | null) => RULES.find((r) => r.id === id) ?? null;

/**
 * Whether a problem has circles. 2D in 2D: circle pieces or a circle container (N or M = 0). Other
 * families: disk pieces (surfaces, sphere, torus: N = 0), a disk piece or a disk container (curved:
 * N or M = 0), a ball piece or a ball container (every balls problem is one or the other); a
 * polyhedra problem is solids only, so never.
 */
export function hasCircles(p: ProblemKey): boolean {
  if (isPolygon(p)) return p.N === 0 || p.M === 0;
  const f = spaceFields(p.id);
  if (!f) return false;
  switch (f.family) {
    case "surface":
    case "sphere":
    case "torus":
      return f.N === 0;
    case "curved":
      return f.N === 0 || f.M === 0;
    case "balls": {
      const b = ballsProblemOf(f.code);
      return !!b && (b.piece === "ball" || b.container === "ball");
    }
    default:
      return false;
  }
}
/** Whether a problem is small: in 2D in 2D (polygons and curved) N+M+P at most SMALL_TOTAL, any other family P at most SMALL_PIECES. */
export function isSmall(p: ProblemKey): boolean {
  if (isPolygon(p)) return p.N + p.M + p.P <= SMALL_TOTAL;
  // curved problems are in 2D in 2D: they are measured by N + M + P as polygons are
  const f = p.family === "curved" ? spaceFields(p.id) : null;
  if (f && f.family === "curved") return f.N + f.M + f.P <= SMALL_TOTAL;
  return p.P <= SMALL_PIECES;
}

/**
 * Classes of problems that the rules' rewards tell apart on rent (ruleRewardFactor with no method).
 * Classes 0 to 3 are polygon problems (bit 1 circles, bit 2 small); 4 to 7 are other families, 4 plus
 * the same bits. Class 4, any other family without either, is what the single family class was, so
 * the numbering of earlier classes holds.
 */
export const RENT_CLASSES = 8;
/** A problem's class. */
export function rentClass(p: ProblemKey): number {
  return (isPolygon(p) ? 0 : 4) | (hasCircles(p) ? 1 : 0) | (isSmall(p) ? 2 : 0);
}
/** The rules' reward factor shared by every problem of a class (the method rule needs a run, which a past entry has not). */
export function rentClassFactor(s: StandingState, c: number): number {
  return shapeRuleFactor(s, (c & 1) !== 0, (c & 2) !== 0);
}

/**
 * Whether the cycle's rule lets the dealer deal or offer this problem (circles only, small problems
 * only, ...). The dealer calls it on every candidate.
 */
export function ruleAllowsProblem(s: StandingState, p: ProblemKey): boolean {
  if (s.rule === "circles") return hasCircles(p);
  if (s.rule === "small") return isSmall(p);
  return true;
}

/** Whether the cycle's rule lets a run use this method (one method only, ...). */
export function ruleAllowsMethod(s: StandingState, method: EvolveMethod): boolean {
  return s.rule !== "method" || method === "mc_compress";
}

/** The wide set a rule also draws open problems from (2D in 2D, sides 21 to 100, whatever More open problems says), or null. */
export function ruleOpenWide(s: StandingState): RuleWide | null {
  return s.rule === "circles" || s.rule === "small" ? s.rule : null;
}

/**
 * Open problems the dealer draws first under a rule that the frontier cannot serve: under "circles
 * only", circles in each frontier polygon and each frontier polygon in a circle (N or M = 0, the
 * other a frontier side, P a frontier count: 306 problems); under "small problems only", the
 * frontier problems with N+M+P at most 120. Null: the dealer's own lists.
 */
export function ruleOpenProblems(s: StandingState): readonly ProblemKey[] | null {
  if (s.rule === "circles") return CIRCLE_FRONTIER;
  if (s.rule === "small") return SMALL_FRONTIER;
  return null;
}
const CIRCLE_FRONTIER: readonly ProblemKey[] = FRONTIER_SIDES.flatMap((side) =>
  FRONTIER_P.flatMap((P) => [poly(0, side, P), poly(side, 0, P)]),
);
const SMALL_FRONTIER: readonly ProblemKey[] = FRONTIER.filter(isSmall);

/** The rules' rewards on one improvement's points: the product of those finished that apply. */
export function ruleRewardFactor(s: StandingState, p: ProblemKey, method: string | null): number {
  let f = shapeRuleFactor(s, hasCircles(p), isSmall(p));
  if (s.rulesDone.includes("method") && method === "mc_compress") f *= RULE_REWARD;
  return f;
}

/** What a completed rule multiplies the points of the problems it was about by. */
const RULE_REWARD = 1.5;

/** The polygon rules' rewards: circles only, and small problems only. */
function shapeRuleFactor(s: StandingState, circles: boolean, small: boolean): number {
  let f = 1;
  if (s.rulesDone.includes("circles") && circles) f *= RULE_REWARD;
  if (s.rulesDone.includes("small") && small) f *= RULE_REWARD;
  return f;
}

// ---------- resets ----------

/** Record points a cycle must earn before it can be reset (points.ts, beside the weights it scales with). */
export { RESET_MIN } from "./points";
/**
 * The confirmed cycle RP a reset needs, by the number of resets so far [SPEC, Michael's ladder of
 * 2026-10-26, first reset raised 5x on 2026-10-27, cut back 5x on 2026-11-09]: 200,000,000 in the first
 * cycle and 5 times the last one's after: 1,000,000,000, then 5,000,000,000.
 */
export const resetThreshold = (resets: number): number => RESET_MIN * Math.pow(RESET_GROWTH, resets);

/** The dimension a reset opens, by the number of resets after it (null: it opens none). */
export function dimensionOpenedBy(resets: number): DimensionId | null {
  return resets === 1 ? "2-on-3" : resets === 2 ? "3-in-3" : null;
}

/** The dimensions as the player reads them: the label, and a sentence on what it holds. */
export const DIMENSION_TEXT: Readonly<Record<DimensionId, { label: string; what: string }>> = {
  "2-in-2": { label: "2D in 2D", what: "polygons and circles packed in polygons and circles" },
  "2-on-3": { label: "2D on 3D", what: "pieces packed on the surfaces of solids" },
  "3-in-3": { label: "3D in 3D", what: "solids packed in solids" },
  "3-on-4": { label: "3D on 4D", what: "solids packed on the surface of a 4D solid" },
};

/** Records the player leads, as far as the game has seen (queue, past and the archive). */
export const heldCount = (s: GameState) =>
  s.queue.filter((p) => p.ourId !== null).length + s.past.filter((p) => p.ourId !== null).length + archivedCount(s);

/** Standing points a reset gives, and one more for finishing the cycle under a rule. */
export const RESET_GAIN = 1;
export const RULE_GAIN = 1;
export const resetGain = (rule: string | null): number => RESET_GAIN + (rule ? RULE_GAIN : 0);

const METHOD_IDS: readonly UpgradeId[] = ["basin", "shrink", "penalty", "lattice", "harden", "morph", "asc", "growth"];

/** The upgrades and every prerequisite they need. */
function withPrerequisites(ids: Iterable<UpgradeId>): Set<UpgradeId> {
  const want = new Set<UpgradeId>();
  const add = (id: UpgradeId) => {
    if (want.has(id)) return;
    want.add(id);
    for (const r of upgrade(id).requires) add(r);
  };
  for (const id of ids) add(id);
  return want;
}

/**
 * What a reset keeps of what the player owns, and what Head start gives: the next cycle's tree. The
 * standing options stay (the Standing card does not: it is bought again for the next reset), Keep
 * auto-eval keeps the Auto-eval row and Keep methods the methods.
 */
export function nextCycleTree(s: GameState): { owned: UpgradeId[]; levels: Partial<Record<UpgradeId, number>> } {
  const has = new Set(s.owned);
  const kept = s.owned.filter((id) => {
    const u = upgrade(id);
    return (
      id !== "standing" &&
      (currencyOf(u) === "standing" ||
        (has.has("keepAuto") && u.row === "auto") ||
        (has.has("keepMethods") && METHOD_IDS.includes(id)))
    );
  });
  const head = headStartGives(has.has("head") ? level(owning(s.owned, s.levels), "head") : 0);
  const keptSet = new Set(kept);
  const owned = new Set([...kept, ...withPrerequisites(head.ids)]);
  // levels stay with the upgrades kept, and Head start brings the levels it gives up to its own
  const levels: Partial<Record<UpgradeId, number>> = {};
  for (const [id, l] of Object.entries(s.levels) as [UpgradeId, number][]) if (keptSet.has(id)) levels[id] = l;
  for (const [id, l] of Object.entries(head.levels) as [UpgradeId, number][]) levels[id] = Math.max(levels[id] ?? 0, l);
  return { owned: UPGRADES.filter((u) => owned.has(u.id)).map((u) => u.id), levels };
}

/**
 * Gives the cards of the Head start level owned now, in the current cycle (the same ones a reset
 * gives): every id of headStartGives not owned yet, with what it needs, and each level up to the one
 * given. Nothing is lowered, taken away or paid for. Rent newly owned starts earning from `now`
 * (no back-rent), and the milestones are timed. Idempotent. Returns the ids newly given.
 */
export function grantHeadStart(s: GameState, now: number): UpgradeId[] {
  if (!s.owned.includes("head")) return [];
  const head = headStartGives(level(owning(s.owned, s.levels), "head"));
  const want = withPrerequisites(head.ids);
  const had = new Set(s.owned);
  const given = UPGRADES.filter((u) => want.has(u.id) && !had.has(u.id)).map((u) => u.id);
  let raised = false;
  for (const [id, l] of Object.entries(head.levels) as [UpgradeId, number][]) {
    if ((s.levels[id] ?? 0) < l) {
      s.levels[id] = l;
      raised = true;
    }
  }
  if (!given.length && !raised) return [];
  const all = new Set([...s.owned, ...given]);
  s.owned = UPGRADES.filter((u) => all.has(u.id)).map((u) => u.id);
  if (given.includes("rent")) tidyRent(s, owning(s.owned, s.levels), now);
  // the cycle rule "clicks only": Auto-eval stays off even when it was given (autoPerSecond is null under it too)
  if (s.standing.rule === "clicks") s.settings.auto = false;
  markProgress(s, now);
  return given;
}

export interface ResetPreview {
  /** Whether the Standing card can be bought now (its price in RP in hand, and as many confirmed this cycle). */
  can: boolean;
  /** Standing points the reset gives: 1, and 1 more under a rule. */
  gain: number;
  ruleBonus: number;
  /** What Standing costs now, in record points. */
  price: number;
  /** Confirmed record points of this cycle still to earn before the card can be bought (0 when enough). */
  short: number;
  held: number;
  /** The dimension this reset opens (null: none, or it is open already). */
  opens: DimensionId | null;
  /** Upgrades the next cycle begins with. */
  keeps: UpgradeId[];
  /** Upgrades the reset takes away. */
  loses: UpgradeId[];
}

/**
 * Record points of this cycle that the server has confirmed: points paid per click count once the
 * submission carrying them is answered, so a reset never turns points that may be taken back into
 * standing that cannot.
 */
export function confirmedCycleEarned(s: GameState): number {
  const waiting = s.queue.reduce((t, p) => t + p.unconfirmed + (p.sending?.rp ?? 0), 0);
  return Math.max(0, s.standing.cycleEarned - waiting);
}

/** What the player can pay with, Standing's confirmed points included (upgrades.ts canBuy). */
export const fundsOf = (s: GameState): Funds => ({
  rp: s.rp,
  standing: s.standing.points,
  confirmed: confirmedCycleEarned(s),
});

export function resetPreview(s: GameState): ResetPreview {
  const held = heldCount(s);
  const earned = confirmedCycleEarned(s);
  const o = owning(
    s.owned,
    s.levels,
    s.standing.rule,
    s.standing.rulesDone,
    s.settings.off,
    s.standing.resets,
    s.standing.dimensions,
  );
  const price = costOf(o, "standing") ?? resetThreshold(s.standing.resets);
  const bonus = s.standing.rule ? RULE_GAIN : 0;
  const opened = dimensionOpenedBy(s.standing.resets + 1);
  const next = nextCycleTree(s).owned;
  return {
    can: canBuy(o, fundsOf(s), "standing").ok,
    gain: RESET_GAIN + bonus,
    ruleBonus: bonus,
    price,
    short: Math.max(0, price - earned),
    held,
    opens: opened && !s.standing.dimensions.includes(opened) ? opened : null,
    keeps: next,
    loses: s.owned.filter((id) => !next.includes(id)),
  };
}

/**
 * Resets the cycle, when the Standing card can be bought (resetPreview.can): standing gained, the rule
 * finished, the tree as nextCycleTree says, record points back to zero (less any still waiting for
 * the server, which carry over), the next cycle begun under the rule chosen for it. Records, the
 * list of records, the queue and every lifetime count stay. Rent restarts from now for the records
 * held if the new tree has Rent, and the rent not yet paid is lost. Returns the standing gained, or 0.
 */
export function resetCycle(s: GameState, now: number): number {
  const preview = resetPreview(s);
  if (!preview.can) return 0;
  const st = s.standing;
  markProgress(s, now);
  st.history.push({
    startedAt: st.cycleStartedAt,
    endedAt: now,
    earned: st.cycleEarned,
    gain: preview.gain,
    rule: st.rule,
    marks: { ...st.marks },
  });
  if (st.history.length > HISTORY_LIMIT) st.history.splice(0, st.history.length - HISTORY_LIMIT);
  if (st.rule && !st.rulesDone.includes(st.rule)) st.rulesDone.push(st.rule);
  st.points += preview.gain;
  st.total += preview.gain;
  st.resets++;
  // the dimension this reset opens stays open for good
  const opened = dimensionOpenedBy(st.resets);
  if (opened && !st.dimensions.includes(opened)) st.dimensions.push(opened);
  // points still waiting for the server are not traded for standing: they carry into the next
  // cycle, where a confirmation keeps them and a take-back takes them from there
  const waiting = st.cycleEarned - confirmedCycleEarned(s);
  const tree = nextCycleTree(s);
  s.owned = tree.owned;
  s.levels = tree.levels;
  // rent accrued and not paid is lost; with Rent back (Head start), the records held start earning now
  // and the first payday is the next noon
  delete s.economy.paidUntil;
  delete s.economy.paydayAt;
  if (s.owned.includes("rent")) {
    s.economy.paidUntil = now;
    s.economy.paydayAt = nextNoon(now);
  }
  s.rp = Math.min(s.rp, waiting);
  st.cycleEarned = waiting;
  st.cycleStartedAt = now;
  st.rule = s.owned.includes("rules") ? st.nextRule : null;
  st.nextRule = null;
  st.marks = {};
  s.autoDue = 0;
  // offers were drawn for the old tree; the new cycle draws its own (lost records stay owed a retake)
  const retakes = s.picks.offers.filter((x) => x.retake).map(keyOf);
  s.picks.retake = [...retakes, ...s.picks.retake.filter((k) => !retakes.includes(k))];
  s.picks.offers = [];
  s.autoAt = now;
  if (!s.owned.includes("auto1") || st.rule === "clicks") s.settings.auto = false;
  markProgress(s, now);
  return preview.gain;
}

// ---------- the sense of speed ----------

/** Milestones timed in each cycle. */
export const MARKS: readonly { id: string; label: string }[] = [
  { id: "click2", label: "2 evaluations per click" },
  { id: "auto1", label: "Auto-eval" },
  { id: "click10", label: "10 evaluations per click" },
  { id: "basin", label: "Basin hopping" },
  { id: "advance", label: "Auto-advance" },
  { id: "ready", label: "Reset threshold earned" },
];

/** Times the milestones of the cycle reached by now (an upgrade owned, or a reset possible). */
export function markProgress(s: GameState, now: number): void {
  const st = s.standing;
  for (const { id } of MARKS) {
    if (st.marks[id] !== undefined) continue;
    const reached = id === "ready" ? st.cycleEarned >= resetThreshold(st.resets) : s.owned.includes(id as UpgradeId);
    if (reached) st.marks[id] = Math.max(0, now - st.cycleStartedAt);
  }
}

/** The fastest a past cycle reached a milestone, if any did. */
export function bestMark(st: StandingState, id: string): number | null {
  const times = st.history.map((h) => h.marks[id]).filter((t): t is number => t !== undefined);
  return times.length ? Math.min(...times) : null;
}
