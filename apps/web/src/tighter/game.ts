import { containerArea, improvesOn, pieceArea } from "@polypack/geometry";
import type { PackingConfig } from "@polypack/geometry";
import { DealerState, newDealer } from "./dealer";
import { ProblemKey, keyOf } from "./frontier";
import { PacerState, newPacer } from "./pacer";
import { Points, Tier, recordPoints } from "./points";
import type { RunRecord, SubmitOutcome } from "./submission";
import { sanitizeName } from "./names";
import { EvolveMethod, UpgradeId, canBuy, upgrade } from "./upgrades";

/**
 * The game state and the rules that change it. No DOM, no network, no workers: the page (main.ts)
 * runs solver runs and server calls and reports their outcomes here. Functions change the state
 * they are given in place and return what happened, so the page can tell the player.
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
  phase: Phase;
  /** The best strict board found here (after Load all: the Load-all board), and its score. */
  board: PackingConfig | null;
  best: number | null;
  /** The run that produced `board`; null for Load all and for a dealt site record. */
  run: RunRecord | null;
  /** Seed of the next Evolve run. Compact uses seed 1; seeds are never repeated on a problem. */
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
  /** Best score after each run, oldest first (bounded). */
  trace: number[];
  /** Runs since the last improvement above the floor. */
  deadRuns: number;
  runs: number;
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
}

export interface Stats {
  evaluations: number;
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
  /** Spendable record points, and all ever earned. */
  rp: number;
  rpEarned: number;
  owned: UpgradeId[];
  name: string;
  /** "Send my records to PolyPack under this name": nothing is sent before. */
  consent: boolean;
  settings: Settings;
  stats: Stats;
  dealer: DealerState;
  pacer: PacerState;
  queue: ProblemState[];
  focus: string | null;
  past: PastProblem[];
  /** Panels shown so far; a panel once shown stays. */
  reveal: string[];
  log: LogLine[];
}

export const TRACE_LIMIT = 400;
export const LOG_LIMIT = 40;
export const PAST_LIMIT = 3000;
/** A problem whose last this many runs found nothing above the floor stops paying (Auto-advance). */
export const STALE_RUNS = 8;

export function newGame(now: number, seed: number): GameState {
  return {
    version: 1,
    createdAt: now,
    rp: 0,
    rpEarned: 0,
    owned: [],
    name: "",
    consent: false,
    settings: { auto: false, method: "mc_compress", background: false, battery: false },
    stats: { evaluations: 0, runs: 0, computeMs: 0, submissions: 0, firstRecords: 0, verifiedImprovements: 0 },
    dealer: newDealer(seed, now),
    pacer: newPacer(),
    queue: [],
    focus: null,
    past: [],
    reveal: [],
    log: [],
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
    phase: "bare",
    board: null,
    best: null,
    run: null,
    nextSeed: 2,
    leader: null,
    verified: null,
    ourId: null,
    beatPaid: false,
    closed: false,
    refused: null,
    leaving: false,
    sending: null,
    trace: [],
    deadRuns: 0,
    runs: 0,
    lastRunAt: 0,
    rp: 0,
  };
}

export const ownedSet = (s: GameState): Set<UpgradeId> => new Set(s.owned);

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

/** Load all: the Load-all board becomes the problem's board and, with the trim floor, its free floor. */
export function applyLoadAll(p: ProblemState, board: PackingConfig, score: number, trimFloor: number | null): void {
  if (p.phase !== "bare") return;
  p.board = board;
  p.best = score;
  p.run = null;
  p.floor = trimFloor !== null && trimFloor < score ? trimFloor : score;
  p.phase = "loaded";
}

/** The parts of a finished solver run that the game uses. */
export interface RunOutcome {
  best?: PackingConfig;
  score: number | null;
  valid: boolean;
  strict: boolean;
  evaluations: number;
  /** Seconds. */
  wallTime: number;
  run: RunRecord;
}

export interface RunChange {
  /** The record (or before the first one, the free floor) the run is measured against. */
  before: number | null;
  /** The board's score after the run. */
  after: number | null;
  /** The board changed (any strictly smaller strict result). */
  improved: boolean;
  /** It improved by more than the floor: an event the server will count. */
  counted: boolean;
  firstRecord: boolean;
}

/**
 * A finished run on problem `p`. Its result becomes the board only when it is strict, valid and
 * smaller than the board: the side never grows. Every run counts toward the effort counters.
 */
export function applyRun(s: GameState, p: ProblemState, r: RunOutcome, now: number): RunChange {
  s.stats.evaluations += r.evaluations;
  s.stats.runs++;
  s.stats.computeMs += Math.round(r.wallTime * 1000);
  p.runs++;
  p.lastRunAt = now;
  if (r.run.seed >= p.nextSeed) p.nextSeed = r.run.seed + 1;
  const wasReady = p.phase === "ready";
  // what an improvement is measured against: the board's record, or before the first one the free floor
  const before = wasReady ? p.best : (p.floor ?? p.best);
  const ok = r.valid && r.strict && !!r.best && r.score !== null && Number.isFinite(r.score) && r.score > 0;
  const smaller = ok && p.best !== null && p.phase !== "bare" && r.score! < p.best;
  let counted = false;
  let firstRecord = false;
  if (smaller) {
    counted = before !== null && improvesOn(r.score!, before);
    p.board = structuredClone(r.best!);
    p.best = r.score!;
    p.run = structuredClone(r.run);
    p.refused = null;
    // Load all is never a record: the first record must beat the free floor by more than F.
    if (!wasReady && counted) {
      p.phase = "ready";
      firstRecord = true;
    }
  }
  p.deadRuns = counted ? 0 : p.deadRuns + 1;
  if (p.phase === "ready" && p.best !== null) {
    p.trace.push(p.best);
    if (p.trace.length > TRACE_LIMIT) p.trace.splice(0, p.trace.length - TRACE_LIMIT);
  }
  return { before, after: smaller ? p.best : before, improved: smaller, counted, firstRecord };
}

/** The score a submission must beat: the leader read just before, or without one the free floor. */
export function submitTarget(p: ProblemState, leaderScore: number | null): number | null {
  return leaderScore ?? p.floor;
}

// ---------- points and the server ----------

/**
 * The score the next submission improves on, as far as the game knows: the leader (often our own
 * last verified entry), else our last verified score, else the free floor.
 */
export function previousScore(p: ProblemState): number | null {
  return p.leader?.score ?? p.verified ?? p.floor;
}

/** Points the board would earn if it were verified now (shown as pending; never credited). */
export function pendingPoints(p: ProblemState, name: string): Points | null {
  if (p.phase !== "ready" || p.best === null || !p.run || p.closed) return null;
  const sPrev = previousScore(p);
  if (sPrev === null) return null;
  return recordPoints({
    N: p.N,
    M: p.M,
    P: p.P,
    sPrev,
    sNew: p.best,
    tier: p.tier,
    first: p.leader === null && p.verified === null,
    beatOther: beatsOther(p, p.leader, name),
  });
}

/**
 * Whether beating `leader` pays the bonus for another name's record: not yet paid here, not our
 * entry, and not our name as the server stores it (it strips angle brackets, for one).
 */
function beatsOther(p: ProblemState, leader: Leader | null, name: string): boolean {
  return !p.beatPaid && !!leader && leader.id !== p.ourId && sanitizeName(leader.name) !== sanitizeName(name);
}

/**
 * Records a POST about to go, before it goes (and the page saves it), so that an answer lost to a
 * reload or a dropped connection can be recognised later (see applyLeader).
 */
export function markSending(
  p: ProblemState,
  score: number,
  name: string,
  leaderBefore: Leader | null,
  now: number,
): void {
  p.sending = { score, name: sanitizeName(name), leaderBefore, at: now };
}

/** Whether the problem has something the server would make leader, as far as the game knows. */
export function hasUnsent(p: ProblemState): boolean {
  if (p.closed || p.phase !== "ready" || p.best === null || !p.run) return false;
  if (p.refused && p.refused.score === p.best) return false;
  const sPrev = previousScore(p);
  return sPrev === null || improvesOn(p.best, sPrev);
}

export interface AnswerChange {
  points: Points | null;
  outcome: SubmitOutcome;
}

/**
 * The answer to a submission of `sentScore` on problem `p`, sent after the leader was read as
 * `leaderBefore` (null: none). Points are paid only when the server made the entry leader, against
 * that leader or, for a problem without one, its free floor.
 */
export function applyAnswer(
  s: GameState,
  p: ProblemState,
  leaderBefore: Leader | null,
  sentScore: number,
  outcome: SubmitOutcome,
  now: number,
): AnswerChange {
  let points: Points | null = null;
  if (outcome.kind === "leader") {
    const sPrev = leaderBefore?.score ?? p.verified ?? p.floor;
    const first = leaderBefore === null && p.verified === null;
    if (sPrev !== null) {
      points = recordPoints({
        N: p.N,
        M: p.M,
        P: p.P,
        sPrev,
        sNew: outcome.score,
        tier: p.tier,
        first,
        beatOther: beatsOther(p, leaderBefore, s.name),
      });
    }
    if (points) {
      s.rp += points.total;
      s.rpEarned += points.total;
      p.rp += points.total;
      if (points.beatBonus) p.beatPaid = true;
    }
    if (first) s.stats.firstRecords++;
    s.stats.verifiedImprovements++;
    p.verified = outcome.score;
    p.ourId = outcome.id;
    p.leader = { score: outcome.score, name: sanitizeName(s.name), id: outcome.id };
    p.refused = null;
  } else if (outcome.kind === "behind") {
    // another entry got there first; it is now the one to beat (whose it is, the next read says)
    if (outcome.leaderScore !== null) p.leader = { score: outcome.leaderScore, name: "another name", id: null };
    p.ourId = null;
  } else if (outcome.kind === "closed") {
    p.closed = true;
  } else if (outcome.kind === "refused") {
    p.refused = { score: sentScore, reasons: outcome.reasons };
  }
  // Without an answer the send may still have reached the server: it is kept to be recognised later.
  if (outcome.kind !== "offline") {
    p.sending = null;
    s.stats.submissions++;
  }
  void now;
  return { points, outcome };
}

/** Relative difference under which the leader's score is the score we sent (same packing, same code). */
const SAME_SCORE = 1e-12;

/**
 * The leader read from the server (GET /api/problems, or a live event), for a problem in the queue
 * or one that left. Our record is lost when the leader is no longer our entry.
 *
 * With the game state `s`, a send whose answer never arrived is settled first: when the leader has
 * the name and the score of that send, it is our entry, and it is paid once, as its answer would have
 * been. Otherwise that send did not lead and is forgotten (the board goes again if it still improves).
 * Call it only while no POST for the problem is on its way.
 */
export function applyLeader(
  p: ProblemState | PastProblem,
  leader: Leader | null,
  s?: GameState,
  now = 0,
): { lost: boolean; reconciled: boolean; points: Points | null } {
  if (s && "sending" in p && p.sending) {
    const send = p.sending;
    p.sending = null;
    if (
      leader &&
      leader.id !== null &&
      sanitizeName(leader.name) === send.name &&
      Math.abs(leader.score - send.score) <= SAME_SCORE * send.score
    ) {
      const outcome: SubmitOutcome = { kind: "leader", score: leader.score, id: leader.id, pending: false };
      const { points } = applyAnswer(s, p, send.leaderBefore, send.score, outcome, now);
      return { lost: false, reconciled: true, points };
    }
  }
  const held = p.ourId !== null;
  const ours = leader !== null && leader.id !== null && leader.id === p.ourId;
  const lost = held && !ours;
  if (!ours) p.ourId = null;
  if ("leader" in p) p.leader = leader;
  return { lost, reconciled: false, points: null };
}

/** Problems where the player is the current leader, as far as the game has seen. */
export function recordsHeld(s: GameState): number {
  return s.queue.filter((p) => p.ourId !== null).length + s.past.filter((p) => p.ourId !== null).length;
}

// ---------- upgrades ----------

export function buy(s: GameState, id: UpgradeId): boolean {
  const owned = ownedSet(s);
  if (!canBuy(owned, s.rp, id).ok) return false;
  s.rp = Math.max(0, s.rp - upgrade(id).cost);
  s.owned.push(id);
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
