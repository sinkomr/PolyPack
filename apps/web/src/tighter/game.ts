import { containerArea, improvesOn, pieceArea } from "@polypack/geometry";
import type { PackingConfig } from "@polypack/geometry";
import { DealerState, canDeal, creditOf, earn, newDealer } from "./dealer";
import { ProblemKey, keyOf } from "./frontier";
import { PacerState, newPacer } from "./pacer";
import { FLOOR, Points, Tier, recordPoints } from "./points";
import type { RunRecord, SubmitOutcome } from "./submission";
import { sanitizeName } from "./names";
import { EconomyState, addBase, forgetHeld, newEconomy, noteRecorded, pointsMultiplier, takeBase } from "./economy";
import { PicksState, learnOnLeave, newPicks } from "./picks";
import { RunPlanState, newRunPlan } from "./runplan";
import { StandingState, newStanding } from "./standing";
import {
  EvolveMethod,
  Owned,
  UpgradeId,
  canBuy,
  costOf,
  currencyOf,
  evalsPerClick,
  level,
  owning,
  upgrade,
} from "./upgrades";

/**
 * The game state and the rules that change it. No DOM, no network, no workers: the page (main.ts)
 * runs the solver and the server calls and reports their outcomes here. Functions change the state
 * they are given in place and return what happened, so the page can tell the player.
 *
 * Points are paid per click: every step of a run that improves the board by more than the floor
 * pays at once (with consent), measured from the last score paid. The server still judges every
 * record: the paid points ride with the next submission, and are taken back if the server does not
 * make it the leader.
 */

/** What a problem's board is: bare (nothing placed), loaded (Load all, not a record) or ready. */
export type Phase = "bare" | "loaded" | "ready";

export interface Leader {
  score: number;
  name: string;
  id: number | null;
}

export interface PendingSend {
  score: number;
  /** The name sent, cleaned as the server cleans it. */
  name: string;
  leaderBefore: Leader | null;
  at: number;
  /** Points paid for the improvements this send carries: kept if it leads, taken back if not. */
  rp: number;
}

export interface ProblemState extends ProblemKey {
  key: string;
  tier: Tier;
  dealtAt: number;
  /**
   * The free floor: what the problem's first record improves on. Open problems: the smaller of
   * Load all and the leader of P + 1 (a P + 1 packing minus a piece is a P packing that is no
   * larger). Loose records: the record when it was dealt. Null until known.
   */
  floor: number | null;
  /**
   * A problem with a published value: the score a record must beat before it pays (the value less
   * its printed precision, as the server judges a record below it). Null for other problems.
   */
  published: number | null;
  phase: Phase;
  /** The best strict board found here (after Load all: the Load-all board), and its score. */
  board: PackingConfig | null;
  best: number | null;
  /** The run that produced `board`; null for Load all and for a dealt site record. */
  run: RunRecord | null;
  /** Seed of the next run. Compact's run uses seed 1; seeds are never repeated on a problem. */
  nextSeed: number;
  /** The problem's leader as last seen (null: none). */
  leader: Leader | null;
  /** Our score that the server last made leader, and its entry id while it is kept. */
  verified: number | null;
  ourId: number | null;
  /** The bonus for beating another name was paid on this problem. */
  beatPaid: boolean;
  /** The server took a problem out of play (409), or refused this score (400/422). */
  closed: boolean;
  refused: { score: number; reasons: string[] } | null;
  /** Dropped from the queue; leaves once its best has been sent (or there is nothing to send). */
  leaving: boolean;
  /** A POST whose answer has not arrived (or was lost): what was sent, under which name, after which leader. */
  sending: PendingSend | null;
  /** The score up to which points have been paid (null: none yet, so from the leader or the floor). */
  paidTo: number | null;
  /** Points paid here that no submission has carried yet. */
  unconfirmed: number;
  /** The board's score after each counted improvement, by evaluations run here (thinned when long). */
  trace: [number, number][];
  /**
   * Evaluations run on this problem (clicks' and auto-eval's), and since its last progress: an
   * improvement on `progressBest` by the tolerance (see applyStep).
   */
  evaluations: number;
  sinceGain: number;
  /** The best at the last progress; null before the first record (a dealt record starts from its own). */
  progressBest: number | null;
  /** Runs opened here (seeds used). */
  runs: number;
  /**
   * Runs that ended by themselves here (their method stopped improving, or their budget ran out). A
   * run closed by the game (another problem, another method, a reload) does not count: the next one
   * takes a new seed but not one of the player's seeds per problem.
   */
  endedRuns: number;
  lastRunAt: number;
  /** RP earned on this problem. */
  rp: number;
}

/** A problem that left the queue: enough to count records held and never deal it again. */
export interface PastProblem extends ProblemKey {
  key: string;
  tier: Tier;
  best: number | null;
  verified: number | null;
  ourId: number | null;
  rp: number;
  leftAt: number;
}

export interface Settings {
  /** Auto-eval switched on (once owned). */
  auto: boolean;
  method: EvolveMethod;
  /** Keep running while the tab is hidden. */
  background: boolean;
  /** Keep running on battery power (where the browser tells). */
  battery: boolean;
  /** Auto-advance: the smallest relative improvement that counts as progress (one of TOLERANCES). */
  tolerance: number;
  /** Auto-advance: evaluations without progress before a problem leaves the queue (one of PATIENCES; null: never). */
  patience: number | null;
}

export interface Stats {
  evaluations: number;
  /** Clicks of Evolve (and Compact). */
  clicks: number;
  runs: number;
  computeMs: number;
  submissions: number;
  firstRecords: number;
  /** Verified improvements, first records included. */
  verifiedImprovements: number;
}

export interface LogLine {
  t: number;
  text: string;
}

export interface GameState {
  version: number;
  createdAt: number;
  /** Spendable record points, and all ever earned (less any taken back). */
  rp: number;
  rpEarned: number;
  owned: UpgradeId[];
  /** Levels of levelled upgrades (each also listed in `owned`). */
  levels: Partial<Record<UpgradeId, number>>;
  name: string;
  /** "Send my records to PolyPack under this name": nothing is sent before. */
  consent: boolean;
  settings: Settings;
  stats: Stats;
  /** Evaluations auto-eval is due and has not run yet (fractional; at most a minute's worth; a loaded save starts at 0). */
  autoDue: number;
  /** When auto-eval's due evaluations were last brought up to date. */
  autoAt: number;
  dealer: DealerState;
  pacer: PacerState;
  queue: ProblemState[];
  focus: string | null;
  past: PastProblem[];
  /** Panels shown so far; a panel once shown stays. */
  reveal: string[];
  log: LogLine[];
  /** Standing (resets), records as an economy, the dealer's picks, how runs are planned. */
  standing: StandingState;
  economy: EconomyState;
  picks: PicksState;
  runplan: RunPlanState;
}

export const TRACE_LIMIT = 400;
export const LOG_LIMIT = 40;
export const PAST_LIMIT = 3000;
/**
 * Auto-advance's settings: the tolerance, the smallest relative improvement that counts as progress
 * (10⁻⁹ is the floor, any improvement that counts at all), and the patience, the evaluations without
 * progress before a problem leaves the queue (null: never).
 */
export const TOLERANCES: readonly number[] = [1e-9, 1e-8, 1e-7, 1e-6, 1e-5, 1e-4, 1e-3];
export const PATIENCES: readonly (number | null)[] = [250, 500, 1000, 2000, 5000, 10000, 20000, null];
export const DEFAULT_TOLERANCE = 1e-6;
export const DEFAULT_PATIENCE = 1000;

export function newGame(now: number, seed: number): GameState {
  return {
    version: 2,
    createdAt: now,
    rp: 0,
    rpEarned: 0,
    owned: [],
    levels: {},
    name: "",
    consent: false,
    settings: {
      auto: false,
      method: "mc_compress",
      background: false,
      battery: false,
      tolerance: DEFAULT_TOLERANCE,
      patience: DEFAULT_PATIENCE,
    },
    stats: {
      evaluations: 0,
      clicks: 0,
      runs: 0,
      computeMs: 0,
      submissions: 0,
      firstRecords: 0,
      verifiedImprovements: 0,
    },
    autoDue: 0,
    autoAt: now,
    dealer: newDealer(seed),
    pacer: newPacer(),
    queue: [],
    focus: null,
    past: [],
    reveal: [],
    log: [],
    standing: newStanding(now),
    economy: newEconomy(),
    picks: newPicks(),
    runplan: newRunPlan(),
  };
}

export function newProblem(p: ProblemKey, tier: Tier, now: number): ProblemState {
  return {
    N: p.N,
    M: p.M,
    P: p.P,
    key: keyOf(p),
    tier,
    dealtAt: now,
    floor: null,
    published: null,
    phase: "bare",
    board: null,
    best: null,
    run: null,
    nextSeed: 1,
    leader: null,
    verified: null,
    ourId: null,
    beatPaid: false,
    closed: false,
    refused: null,
    leaving: false,
    sending: null,
    paidTo: null,
    unconfirmed: 0,
    trace: [],
    evaluations: 0,
    sinceGain: 0,
    progressBest: null,
    runs: 0,
    endedRuns: 0,
    lastRunAt: 0,
    rp: 0,
  };
}

export const ownedSet = (s: GameState): Owned => owning(s.owned, s.levels, s.standing.rule, s.standing.rulesDone);

/** The tolerance progress is measured with: the player's with Auto-advance, else any improvement that counts. */
export const progressTolerance = (s: GameState): number => (ownedSet(s).has("advance") ? s.settings.tolerance : FLOOR);

/** Evaluations without progress after which a problem has stalled, for the lanes' order: the patience, or with Never its default. */
export const stallAfter = (s: GameState): number => s.settings.patience ?? DEFAULT_PATIENCE;

export function log(s: GameState, now: number, text: string): void {
  s.log.push({ t: now, text });
  if (s.log.length > LOG_LIMIT) s.log.splice(0, s.log.length - LOG_LIMIT);
}

export function reveal(s: GameState, ...panels: string[]): void {
  for (const p of panels) if (!s.reveal.includes(p)) s.reveal.push(p);
}

export const revealed = (s: GameState, panel: string) => s.reveal.includes(panel);

export function problem(s: GameState, key: string | null): ProblemState | undefined {
  return key === null ? undefined : s.queue.find((p) => p.key === key);
}

/** Keys of every problem dealt so far: never dealt again. */
export function seenKeys(s: GameState): Set<string> {
  return new Set([...s.queue.map((p) => p.key), ...s.past.map((p) => p.key)]);
}

/** Problems in the queue that hold a slot (those leaving do not). */
export const slotted = (s: GameState) => s.queue.filter((p) => !p.leaving);

/** Density of a packing of side (or radius) s: the pieces' area over the container's. */
export function density(p: ProblemKey, s: number): number {
  return (p.P * pieceArea(p.N)) / containerArea(p.M, s);
}

// ---------- the board ----------

/**
 * Evolve can run: the board came from a run (a record, or a Compact that did not beat a trim
 * floor) or is a dealt site record.
 */
export const evolvable = (p: ProblemState): boolean => p.phase === "ready" || (p.phase === "loaded" && p.run !== null);

/** As many runs as the player has seeds per problem have run to their end here: nothing is left to give. */
export const spent = (p: ProblemState, seeds: number): boolean => p.endedRuns >= seeds;

/** Load all: the Load-all board becomes the problem's board and, with the trim floor, its free floor. */
export function applyLoadAll(p: ProblemState, board: PackingConfig, score: number, trimFloor: number | null): void {
  if (p.phase !== "bare") return;
  p.board = board;
  p.best = score;
  p.run = null;
  p.floor = trimFloor !== null && trimFloor < score ? trimFloor : score;
  p.phase = "loaded";
}

/**
 * Evaluations run, the player's (`click`) or auto-eval's: they count in all, and earn the dealer's
 * credit in clicks, the player's at the player's click size and auto-eval's at a fixed one (dealer.ts).
 */
export function countEvaluations(s: GameState, evaluations: number, click: boolean): void {
  s.stats.evaluations += evaluations;
  earn(s.dealer, creditOf(evaluations, click ? evalsPerClick(ownedSet(s)) : null));
}

/** A run opened on the problem: it uses the next seed. */
export function openedRun(s: GameState, p: ProblemState, seed: number, now: number): void {
  s.stats.runs++;
  p.runs++;
  p.lastRunAt = now;
  if (seed >= p.nextSeed) p.nextSeed = seed + 1;
}

/** One step of an open run: the evaluations it did and the run's best strict packing so far. */
export interface StepOutcome {
  evaluations: number;
  best: PackingConfig | null;
  score: number | null;
  /** The run as a board it found records it (budget: the evaluations the run had done). */
  run: RunRecord;
  ms: number;
  /** The run ended by itself (not closed by the game): it uses up one of the player's seeds here. */
  ended: boolean;
  /** A click of the player's (true) or auto-eval's evaluations. */
  click: boolean;
  /** Compact's step (its 100 evaluations from the Load-all board). */
  compact?: boolean;
}

export interface StepChange {
  /** The record (or before the first one, the free floor) the step is measured against. */
  before: number | null;
  /** The board's score after the step. */
  after: number | null;
  /** The board changed (any strictly smaller strict result). */
  improved: boolean;
  /** It improved by more than the floor: an event the server will count. */
  counted: boolean;
  firstRecord: boolean;
  /** Points paid for this step (null: none, or no consent yet). */
  points: Points | null;
}

/**
 * A step of a run on problem `p`. Its best becomes the board only when it is strict, valid and
 * smaller than the board: the side never grows. Every step counts toward the effort counters, and
 * an improvement above the floor pays at once (with consent).
 *
 * Progress (Auto-advance's): the best s beats the best at the last progress s_ref by the tolerance
 * τ, s < s_ref · (1 − τ). Then s_ref becomes s and the count since progress starts again; otherwise
 * the count grows by the step's evaluations. The first record sets s_ref, and a dealt record starts
 * from its own best. With τ = 10⁻⁹ every improvement that counts is progress, as it always was.
 */
export function applyStep(s: GameState, p: ProblemState, o: StepOutcome, now: number): StepChange {
  countEvaluations(s, o.evaluations, o.click);
  s.stats.computeMs += Math.round(o.ms);
  if (o.click) s.stats.clicks++;
  p.evaluations += o.evaluations;
  p.lastRunAt = now;
  if (o.ended) p.endedRuns++;
  const wasReady = p.phase === "ready";
  // what an improvement is measured against: the board's record, or before the first one the free floor
  const before = wasReady ? p.best : (p.floor ?? p.best);
  const ok = !!o.best && o.score !== null && Number.isFinite(o.score) && o.score > 0;
  const smaller = ok && p.best !== null && p.phase !== "bare" && o.score! < p.best;
  let counted = false;
  let firstRecord = false;
  if (smaller) {
    counted = before !== null && improvesOn(o.score!, before);
    p.board = structuredClone(o.best!);
    p.best = o.score!;
    p.run = structuredClone(o.run);
    p.refused = null;
    // Load all is never a record: the first record must beat the free floor by more than F.
    if (!wasReady && counted) {
      p.phase = "ready";
      firstRecord = true;
    }
  } else if (o.compact && !wasReady && p.phase === "loaded" && !p.run) {
    // a Compact that did not beat a trim floor: the board is still a run's, and Evolve may go on
    p.run = structuredClone(o.run);
  }
  const ref = p.progressBest ?? (wasReady ? before : null);
  if (firstRecord || (smaller && ref !== null && p.phase === "ready" && p.best! < ref * (1 - progressTolerance(s)))) {
    p.progressBest = p.best;
    p.sinceGain = 0;
  } else {
    if (p.phase === "ready") p.progressBest = ref;
    p.sinceGain += o.evaluations;
  }
  if (counted && p.phase === "ready") pushTrace(p);
  const points = counted ? pay(s, p) : null;
  return { before, after: smaller ? p.best : before, improved: smaller, counted, firstRecord, points };
}

function pushTrace(p: ProblemState): void {
  if (p.best === null) return;
  p.trace.push([p.evaluations, p.best]);
  // thin the middle, keeping the first and the last points, so the whole history stays drawn
  if (p.trace.length > TRACE_LIMIT)
    p.trace = [p.trace[0], ...p.trace.slice(1, -1).filter((_, i) => i % 2 === 1), p.trace.at(-1)!];
}

/**
 * The score a submission must beat: the leader read just before, or without one the free floor; on a
 * problem with a published value, never above that value.
 */
export function submitTarget(p: ProblemState, leaderScore: number | null): number | null {
  const target = leaderScore ?? p.floor;
  if (p.published === null) return target;
  return target === null ? p.published : Math.min(target, p.published);
}

// ---------- points ----------

/**
 * The score the next submission improves on, as far as the game knows: the leader (often our own
 * last verified entry), else our last verified score, else the free floor.
 */
export function previousScore(p: ProblemState): number | null {
  return p.leader?.score ?? p.verified ?? p.floor;
}

/**
 * What the next payment is measured from: the last score paid, else the score to beat; on a problem
 * with a published value, never above the published value (nothing pays until the board beats it).
 */
const payBase = (p: ProblemState): number | null => {
  const base = p.paidTo ?? previousScore(p);
  return base !== null && p.published !== null ? Math.min(base, p.published) : base;
};

function pointsFor(p: ProblemState, name: string): Points | null {
  if (p.phase !== "ready" || p.best === null || !p.run || p.closed) return null;
  const sPrev = payBase(p);
  if (sPrev === null) return null;
  return recordPoints({
    N: p.N,
    M: p.M,
    P: p.P,
    sPrev,
    sNew: p.best,
    tier: p.tier,
    first: p.paidTo === null && p.leader === null && p.verified === null,
    beatOther: beatsOther(p, p.leader, name),
  });
}

/**
 * Points as paid: the improvement's own points (`base`, design §5) times the multiplier of the
 * moment (standing, collections, rules finished); `total` is what was paid, and what a take-back takes.
 */
export interface PaidPoints extends Points {
  base: number;
  multiplier: number;
}

/** The points multiplier on the problem now (for the method of the run that found its board). */
export const multiplierFor = (s: GameState, p: ProblemState): number =>
  pointsMultiplier(s, ownedSet(s), p, p.run?.method ?? null);

function withMultiplier(points: Points, multiplier: number): PaidPoints {
  return { ...points, base: points.total, multiplier, total: points.total * multiplier };
}

/**
 * Points the board would pay now (shown while no name is given; paid as one event on consent), with
 * the game state's multiplier when it is given.
 */
export function pendingPoints(p: ProblemState, name: string, s?: GameState): PaidPoints | null {
  const points = pointsFor(p, name);
  return points ? withMultiplier(points, s ? multiplierFor(s, p) : 1) : null;
}

/** Pays the board's improvement since the last payment, as one event. Nothing without consent. */
export function pay(s: GameState, p: ProblemState): PaidPoints | null {
  if (!s.consent) return null;
  const own = pointsFor(p, s.name);
  if (!own) return null;
  const points = withMultiplier(own, multiplierFor(s, p));
  s.rp += points.total;
  s.rpEarned += points.total;
  s.standing.cycleEarned += points.total;
  p.rp += points.total;
  p.unconfirmed += points.total;
  addBase(s.economy, p.key, points.base);
  p.paidTo = p.best;
  if (points.beatBonus) p.beatPaid = true;
  return points;
}

/** On consent: every board's improvement since its last payment pays, one event per problem. */
export function payAll(s: GameState): number {
  let total = 0;
  for (const p of s.queue) total += pay(s, p)?.total ?? 0;
  return total;
}

/**
 * Sending switched off: points paid and not yet carried by a submission will never be confirmed, so
 * they are taken back, and each board pays again from its last confirmed score once sending is back
 * on. A submission already on its way keeps its points until its answer. Returns the points taken.
 */
export function withdrawConsent(s: GameState): number {
  let total = 0;
  for (const p of s.queue) {
    total += takeBack(s, p, p.unconfirmed);
    p.unconfirmed = 0;
    p.paidTo = p.sending?.score ?? p.verified;
  }
  s.consent = false;
  return total;
}

/** Takes back points the server did not confirm. Spent points are not owed: the balance stops at zero. */
function takeBack(s: GameState, p: ProblemState, rp: number): number {
  if (!(rp > 0)) return 0;
  takeBase(s.economy, p.key, rp, p.rp);
  s.rp = Math.max(0, s.rp - rp);
  s.rpEarned = Math.max(0, s.rpEarned - rp);
  s.standing.cycleEarned = Math.max(0, s.standing.cycleEarned - rp);
  p.rp = Math.max(0, p.rp - rp);
  return rp;
}

/** Points paid and not yet confirmed by the server, in the queue. */
export function unconfirmedPoints(s: GameState): number {
  return s.queue.reduce((t, p) => t + p.unconfirmed + (p.sending?.rp ?? 0), 0);
}

/**
 * Whether beating `leader` pays the bonus for another name's record: not yet paid here, not our
 * entry, and not our name as the server stores it (it strips angle brackets, for one).
 */
function beatsOther(p: ProblemState, leader: Leader | null, name: string): boolean {
  // a leader read from a "behind" answer has no id; the name tells it from ours
  return (
    !p.beatPaid &&
    !!leader &&
    (leader.id === null || leader.id !== p.ourId) &&
    sanitizeName(leader.name) !== sanitizeName(name)
  );
}

// ---------- the server ----------

/**
 * Records a POST about to go, before it goes (and the page saves it), so that an answer lost to a
 * reload or a dropped connection can be recognised later (see applyLeader). The points paid so far
 * ride with it.
 */
export function markSending(
  p: ProblemState,
  score: number,
  name: string,
  leaderBefore: Leader | null,
  now: number,
): void {
  p.sending = { score, name: sanitizeName(name), leaderBefore, at: now, rp: p.unconfirmed };
  p.unconfirmed = 0;
}

/** Whether the problem has something the server would make leader, as far as the game knows. */
export function hasUnsent(p: ProblemState): boolean {
  if (p.closed || p.phase !== "ready" || p.best === null || !p.run) return false;
  if (p.refused && p.refused.score === p.best) return false;
  // a problem with a published value sends only a board that beats it: a small gain on the published
  // packing itself would otherwise go out under the player's name
  if (p.published !== null && !improvesOn(p.best, p.published)) return false;
  const sPrev = previousScore(p);
  return sPrev === null || improvesOn(p.best, sPrev);
}

export interface AnswerChange {
  outcome: SubmitOutcome;
  /** Points the answer confirmed (they were paid before), and points it took back. */
  confirmed: number;
  takenBack: number;
  /** Points paid after the answer: the board measured against a new leader that it still beats. */
  points: Points | null;
}

/**
 * The answer to a submission of `sentScore` on problem `p`, sent after the leader was read as
 * `leaderBefore` (null: none). Points were paid per click; the answer confirms them when the
 * server made the entry leader, and takes them back when it did not.
 */
export function applyAnswer(
  s: GameState,
  p: ProblemState,
  leaderBefore: Leader | null,
  sentScore: number,
  outcome: SubmitOutcome,
  now: number,
): AnswerChange {
  const carried = p.sending?.rp ?? 0;
  let confirmed = 0;
  let takenBack = 0;
  let points: Points | null = null;
  if (outcome.kind === "leader") {
    confirmed = carried;
    if (leaderBefore === null && p.verified === null) s.stats.firstRecords++;
    s.stats.verifiedImprovements++;
    p.verified = outcome.score;
    p.ourId = outcome.id;
    p.leader = { score: outcome.score, name: sanitizeName(s.name), id: outcome.id };
    p.refused = null;
    // it counts for collections, and with Rent its rent runs
    noteRecorded(s, ownedSet(s), p, now);
  } else if (outcome.kind === "behind") {
    // another entry got there first: nothing paid since the last confirmation was a record
    takenBack = takeBack(s, p, carried + p.unconfirmed);
    p.unconfirmed = 0;
    // a record of ours it overtook is lost now: no rent for it from its last check on
    if (p.ourId !== null) forgetHeld(s.economy, p.key);
    p.ourId = null;
    if (outcome.leaderScore !== null) {
      // it is now the one to beat (whose it is, the next read says); what the board still beats it by pays
      p.leader = { score: outcome.leaderScore, name: "another name", id: null };
      p.paidTo = outcome.leaderScore;
      points = pay(s, p);
    }
  } else if (outcome.kind === "closed") {
    takenBack = takeBack(s, p, carried + p.unconfirmed);
    p.unconfirmed = 0;
    p.closed = true;
  } else if (outcome.kind === "refused") {
    takenBack = takeBack(s, p, carried);
    p.refused = { score: sentScore, reasons: outcome.reasons };
  } else if (outcome.kind === "rate-limited") {
    // not looked at: the points ride with the next submission
    p.unconfirmed += carried;
  }
  // Without an answer the send may still have reached the server: it is kept to be recognised later.
  if (outcome.kind !== "offline") {
    p.sending = null;
    if (outcome.kind !== "rate-limited") s.stats.submissions++;
  }
  return { outcome, confirmed, takenBack, points };
}

/** Relative difference under which the leader's score is the score we sent (same packing, same code). */
const SAME_SCORE = 1e-12;

/**
 * The leader read from the server (GET /api/problems, or a live event), for a problem in the queue
 * or one that left. Our record is lost when the leader is no longer our entry.
 *
 * With the game state `s`, a send whose answer never arrived is settled first: when the leader has
 * the name and the score of that send, it is our entry and its points are confirmed. Otherwise that
 * send did not lead; its points wait for the next submission (the board goes again if it still
 * improves). Call it only while no POST for the problem is on its way.
 */
export function applyLeader(
  p: ProblemState | PastProblem,
  leader: Leader | null,
  s?: GameState,
  now = 0,
): { lost: boolean; reconciled: boolean; confirmed: number } {
  if (s && "sending" in p && p.sending) {
    const send = p.sending;
    if (
      leader &&
      leader.id !== null &&
      sanitizeName(leader.name) === send.name &&
      Math.abs(leader.score - send.score) <= SAME_SCORE * send.score
    ) {
      const outcome: SubmitOutcome = { kind: "leader", score: leader.score, id: leader.id, pending: false };
      const { confirmed } = applyAnswer(s, p, send.leaderBefore, send.score, outcome, now);
      return { lost: false, reconciled: true, confirmed };
    }
    p.sending = null;
    p.unconfirmed += send.rp;
  }
  const held = p.ourId !== null;
  const ours = leader !== null && leader.id !== null && leader.id === p.ourId;
  const lost = held && !ours;
  if (!ours) p.ourId = null;
  // a record lost pays no rent, not even for the time since its last check
  if (lost && s) forgetHeld(s.economy, p.key);
  if ("leader" in p) p.leader = leader;
  return { lost, reconciled: false, confirmed: 0 };
}

/** Problems where the player is the current leader, as far as the game has seen. */
export function recordsHeld(s: GameState): number {
  return s.queue.filter((p) => p.ourId !== null).length + s.past.filter((p) => p.ourId !== null).length;
}

// ---------- auto-eval's pace ----------

/**
 * Brings auto-eval's due evaluations up to `now`: `perSecond` evaluations a second since `autoAt`,
 * at most `cap` due at once. Auto-eval runs live: the caller passes 0 while it cannot run (off,
 * held, or another tab holds the game), and nothing is owed for that time. Returns the evaluations added.
 */
export function accrue(s: GameState, now: number, perSecond: number, cap: number): number {
  const elapsed = Math.max(0, now - s.autoAt) / 1000;
  s.autoAt = Math.max(s.autoAt, now);
  if (!(perSecond > 0)) return 0;
  const before = s.autoDue;
  s.autoDue = Math.min(Math.max(cap, before), before + elapsed * perSecond);
  return s.autoDue - before;
}

// ---------- upgrades ----------

/** Buys an upgrade, or its next level, with record points or standing. */
export function buy(s: GameState, id: UpgradeId): boolean {
  const o = ownedSet(s);
  if (!canBuy(o, { rp: s.rp, standing: s.standing.points }, id).ok) return false;
  const cost = costOf(o, id)!;
  const u = upgrade(id);
  if (currencyOf(u) === "rp") s.rp = Math.max(0, s.rp - cost);
  else s.standing.points = Math.max(0, s.standing.points - cost);
  if (!s.owned.includes(id)) s.owned.push(id);
  if (u.levels) s.levels[id] = level(o, id) + 1;
  return true;
}

// ---------- the queue ----------

/** Adds a dealt problem and focuses it when nothing else is. */
export function addToQueue(s: GameState, p: ProblemState): void {
  s.queue.push(p);
  if (!problem(s, s.focus)) s.focus = p.key;
}

/**
 * Drops a problem from the queue. With consent and an unsent improvement it stays, marked leaving,
 * until that has been sent; otherwise it leaves now. Returns whether it left now.
 */
export function drop(s: GameState, key: string, now: number): boolean {
  const p = problem(s, key);
  if (!p) return false;
  p.leaving = true;
  if (s.focus === key) s.focus = slotted(s)[0]?.key ?? null;
  if (s.consent && hasUnsent(p)) return false;
  leave(s, key, now);
  return true;
}

/** Moves a problem from the queue to the past. */
export function leave(s: GameState, key: string, now: number): void {
  const i = s.queue.findIndex((q) => q.key === key);
  if (i < 0) return;
  const [p] = s.queue.splice(i, 1);
  // the learning dealer learns what the problem paid per evaluation, from the points as earned, before standing and collections multiply them
  learnOnLeave(s.picks, { key: p.key, rp: s.economy.base[p.key] ?? p.rp, evaluations: p.evaluations });
  s.past.push({
    N: p.N,
    M: p.M,
    P: p.P,
    key: p.key,
    tier: p.tier,
    best: p.phase === "ready" ? p.best : null,
    verified: p.verified,
    ourId: p.ourId,
    rp: p.rp,
    leftAt: now,
  });
  if (s.past.length > PAST_LIMIT) s.past.splice(0, s.past.length - PAST_LIMIT);
  if (s.focus === key) s.focus = slotted(s)[0]?.key ?? null;
}

// ---------- Auto-advance: problems that stopped making progress leave ----------

/**
 * Why Auto-advance takes a problem out of the queue, or null while it stays: every seed on it is
 * spent (nothing is left to run), or it ran the player's patience of evaluations without progress.
 * A best that cannot be sent (no name on records yet) is never dropped this way, nor anything with
 * the patience at Never.
 */
export function leaveReason(s: GameState, p: ProblemState, seeds: number): "spent" | "stalled" | null {
  const patience = s.settings.patience;
  if (patience === null || p.leaving || p.closed) return null;
  if (!s.consent && hasUnsent(p)) return null;
  if (spent(p, seeds)) return "spent";
  return p.sinceGain >= patience ? "stalled" : null;
}

export interface AdvancePlan {
  /** Problems that leave now: nothing in the queue is left to run, so no evaluation would earn their replacements. */
  now: ProblemState[];
  /** The problem that leaves for the next deal, which is earned (null: none due, or no deal earned yet). */
  replace: ProblemState | null;
  /** The problem due to leave next, spent ones first, then the longest without progress. */
  due: ProblemState | null;
}

/**
 * Auto-advance's move (with auto-eval on). A problem due to leave goes only once a new one can take
 * its slot, a deal earned by work (dealer.ts), so the queue never runs short and the lanes
 * keep to the other problems meanwhile. When nothing in the queue is left to run, its spent problems
 * leave at once instead (an empty queue is dealt a problem on credit).
 */
export function advancePlan(s: GameState, o: { seeds: number; slots: number }): AdvancePlan {
  const queue = slotted(s);
  const due = queue
    .map((p) => ({ p, why: leaveReason(s, p, o.seeds) }))
    .filter((x) => x.why !== null)
    .sort((a, b) => Number(b.why === "spent") - Number(a.why === "spent") || b.p.sinceGain - a.p.sinceGain)
    .map((x) => x.p);
  const runnable = queue.some((p) => !p.closed && !spent(p, o.seeds));
  const now = runnable ? [] : due.filter((p) => spent(p, o.seeds));
  const earned = due.length > 0 && !now.length && canDeal(s.dealer, o.slots);
  return { now, replace: earned ? due[0] : null, due: due[0] ?? null };
}
