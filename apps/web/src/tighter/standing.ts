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
} from "./frontier";
import { RESET_GROWTH, RESET_MIN } from "./points";
import type { GameState } from "./game";
import { EvolveMethod, HEAD2_AUTO_LEVELS, UPGRADES, UpgradeId, currencyOf, upgrade } from "./upgrades";

/**
 * Standing: the reset currency (plan §5).
 *
 * A reset trades the cycle's record points and the main tree for standing. Records stay on the
 * server and keep paying rent; collections, the dealer's learning, the queue and the lifetime counts
 * stay too. Every point of standing ever earned adds 10 % to all record points, and standing buys
 * the Standing row: head starts that make the opening of a new cycle a sprint, rows that survive
 * resets, and mechanics that exist nowhere else (Pipelines, Auto-tune). A cycle may be played under
 * a rule (circles only, small problems, clicks only, one method): finishing it under the rule pays
 * extra standing and a reward of the rule's own, for good. The rules also aim the players' compute at
 * one family of problems.
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
  /** Standing it gave. */
  gain: number;
  rule: string | null;
  /** Milestones reached: ms since the cycle began, by mark id. */
  marks: Record<string, number>;
}

export interface StandingState {
  /** Standing to spend on the Standing row. */
  points: number;
  /** Standing ever earned: each point adds 10 % to all record points, spent or not. */
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

/** The multiplier standing puts on every record point: 1 + 0.1 per point of standing ever earned. */
export const standingMultiplier = (s: StandingState): number => 1 + 0.1 * s.total;

// ---------- cycle rules ----------

export interface Rule {
  id: string;
  name: string;
  /** What the rule takes away for one cycle, as one or two sentences. */
  limit: string;
  /** What finishing a cycle under it gives for good, as a sentence that reads after "Once finished, ". */
  reward: string;
}

/** Problems small enough for the "small problems" rule and its reward: N+M+P at most this. */
export const SMALL_TOTAL = 120;

export const RULES: readonly Rule[] = [
  {
    id: "circles",
    name: "Circles only",
    limit:
      "Only problems with circle pieces or a circle container are dealt. The open ones are circles in a polygon, or polygons in a circle, of 21 to 100 sides. The rule covers the polygon problems of 2D in 2D only, so problems of other dimensions are dealt as usual.",
    reward: "Every polygon problem with circle pieces or a circle container pays 1.5 times the points.",
  },
  {
    id: "small",
    name: "Small problems only",
    limit: `Only problems with N + M + P at most ${SMALL_TOTAL} are dealt, where N and M are the sides of the piece and of the container (0 for a circle) and P is the number of pieces. The rule covers the polygon problems of 2D in 2D only, so problems of other dimensions are dealt as usual.`,
    reward: `Every polygon problem with N + M + P at most ${SMALL_TOTAL} pays 1.5 times the points.`,
  },
  {
    id: "clicks",
    name: "Clicks only",
    limit: "Auto-eval does not run, so every evaluation comes from your own clicks.",
    reward: "Every click runs one more evaluation.",
  },
  {
    id: "method",
    name: "One method",
    limit: "Only mc_compress runs. Other methods are greyed out, and pipeline stages that use them are skipped.",
    reward: "Points on boards found by mc_compress are multiplied by 1.5.",
  },
];
export const ruleById = (id: string | null) => RULES.find((r) => r.id === id) ?? null;

const hasCircles = (p: ProblemKey) => {
  const q = needPolygon(p, "cycle rule circles");
  return q.N === 0 || q.M === 0;
};
const isSmall = (p: ProblemKey) => {
  const q = needPolygon(p, "cycle rule small");
  return q.N + q.M + q.P <= SMALL_TOTAL;
};

/**
 * Whether the cycle's rule lets the dealer deal or offer this problem (circles only, small problems
 * only, ...). The dealer calls it on every candidate.
 */
export function ruleAllowsProblem(s: StandingState, p: ProblemKey): boolean {
  // circles only and small problems only are rules of 2D in 2D's polygon problems
  if (!isPolygon(p)) return true;
  if (s.rule === "circles") return hasCircles(p);
  if (s.rule === "small") return isSmall(p);
  return true;
}

/** Whether the cycle's rule lets a run use this method (one method only, ...). */
export function ruleAllowsMethod(s: StandingState, method: EvolveMethod): boolean {
  return s.rule !== "method" || method === "mc_compress";
}

/**
 * Open problems the dealer draws from under a rule that the frontier cannot serve: under "circles
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
  let f = 1;
  if (isPolygon(p)) {
    if (s.rulesDone.includes("circles") && hasCircles(p)) f *= 1.5;
    if (s.rulesDone.includes("small") && isSmall(p)) f *= 1.5;
  }
  if (s.rulesDone.includes("method") && method === "mc_compress") f *= 1.5;
  return f;
}

// ---------- resets ----------

/** Record points a cycle must earn before it can be reset (points.ts, beside the weights it scales with). */
export { RESET_MIN } from "./points";
/**
 * The confirmed cycle RP a reset needs, by the number of resets so far [SPEC, Michael's ladder of
 * 2026-10-26]: 200,000,000 in the first cycle and 5 times the last one's after: 1,000,000,000,
 * then 5,000,000,000.
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
  "3-on-4": { label: "3D on 4D", what: "solids packed on the boundary of a four-dimensional solid" },
};

/** Records the player leads, as far as the game has seen (queue and past). */
export const heldCount = (s: GameState) =>
  s.queue.filter((p) => p.ourId !== null).length + s.past.filter((p) => p.ourId !== null).length;

/** Standing points a reset gives at its threshold, and the root's factor [SPEC]. */
export const GAIN_AT_THRESHOLD = 5;

/**
 * Standing a reset gives now [SPEC]: ⌊5 √(cycle RP / threshold)⌋, nothing before the cycle has
 * earned the threshold (resetThreshold). The records held no longer count.
 */
export function standingGain(cycleEarned: number, threshold = RESET_MIN): number {
  if (!(cycleEarned >= threshold)) return 0;
  return Math.floor(GAIN_AT_THRESHOLD * Math.sqrt(cycleEarned / threshold) + 1e-9);
}

/** Standing for finishing a cycle under a rule, on top of the gain: half again, at least one. */
export const ruleBonus = (gain: number) => (gain > 0 ? Math.max(1, Math.ceil(gain / 2)) : 0);

/** Record points of this cycle at which the next point of standing comes. */
export function nextStandingAt(cycleEarned: number, threshold = RESET_MIN): number {
  const g = standingGain(cycleEarned, threshold);
  if (g === 0) return threshold;
  return Math.max(threshold, Math.ceil((threshold * (g + 1) ** 2) / GAIN_AT_THRESHOLD ** 2 - 1e-6));
}

/** Upgrades a reset never takes: the Standing row, Standing itself, and records' own (rent, collections). */
export const ALWAYS_KEPT: readonly UpgradeId[] = ["standing", "rent", "rentx", "collections"];
/** Head starts: owned at once when a cycle begins (with their prerequisites). */
export const HEAD_STARTS: Readonly<Partial<Record<UpgradeId, readonly UpgradeId[]>>> = {
  head1: ["trace", "click2", "click3", "click4", "click5", "auto1"],
  head2: ["queue3", "autox", "basin"],
  head3: ["reach2", "advance", "lanes2"],
};
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

/** What a reset keeps of what the player owns, and what head starts give: the next cycle's tree. */
export function nextCycleTree(s: GameState): { owned: UpgradeId[]; levels: Partial<Record<UpgradeId, number>> } {
  const has = new Set(s.owned);
  const kept = s.owned.filter((id) => {
    const u = upgrade(id);
    return (
      currencyOf(u) === "standing" ||
      ALWAYS_KEPT.includes(id) ||
      (has.has("keepAuto") && u.row === "auto") ||
      (has.has("keepMethods") && METHOD_IDS.includes(id))
    );
  });
  const heads = Object.entries(HEAD_STARTS)
    .filter(([id]) => has.has(id as UpgradeId))
    .flatMap(([, ids]) => ids!);
  const keptSet = new Set(kept);
  const owned = new Set([...kept, ...withPrerequisites(heads)]);
  // levels stay only with the upgrades kept (a head start grants first levels only, bar Head start II's
  // levels of Faster auto-eval, which it brings up to the rate of the old fifth rung)
  const levels: Partial<Record<UpgradeId, number>> = {};
  for (const [id, l] of Object.entries(s.levels) as [UpgradeId, number][]) if (keptSet.has(id)) levels[id] = l;
  if (has.has("head2")) levels.autox = Math.max(levels.autox ?? 0, HEAD2_AUTO_LEVELS);
  return { owned: UPGRADES.filter((u) => owned.has(u.id)).map((u) => u.id), levels };
}

export interface ResetPreview {
  /** Standing the reset gives, the rule's bonus included (0: it cannot reset yet). */
  gain: number;
  ruleBonus: number;
  /** Record points still to earn before a reset is possible (0 when it is). */
  short: number;
  /** Record points of this cycle at which the next point of standing comes. */
  nextAt: number;
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

export function resetPreview(s: GameState): ResetPreview {
  const held = heldCount(s);
  const earned = confirmedCycleEarned(s);
  const threshold = resetThreshold(s.standing.resets);
  const gain = standingGain(earned, threshold);
  const opened = dimensionOpenedBy(s.standing.resets + 1);
  const bonus = s.standing.rule ? ruleBonus(gain) : 0;
  const next = nextCycleTree(s).owned;
  return {
    gain: gain + bonus,
    ruleBonus: bonus,
    short: gain > 0 ? 0 : Math.max(0, threshold - earned),
    nextAt: nextStandingAt(earned, threshold),
    held,
    opens: opened && !s.standing.dimensions.includes(opened) ? opened : null,
    keeps: next,
    loses: s.owned.filter((id) => !next.includes(id)),
  };
}

/**
 * Resets the cycle, when it can (Standing owned, the gain at least one): standing gained, the rule
 * finished, the tree as nextCycleTree says, record points back to zero (less any still waiting for
 * the server, which carry over), the next cycle begun under the rule chosen for it. Records,
 * collections, rent, the queue and every lifetime count stay. Returns the standing gained, or 0.
 */
export function resetCycle(s: GameState, now: number): number {
  if (!s.owned.includes("standing")) return 0;
  const preview = resetPreview(s);
  if (preview.gain <= 0) return 0;
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
