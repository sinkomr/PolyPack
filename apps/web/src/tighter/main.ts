import { MAX_PIECES, areaLowerBound, evaluate } from "@polypack/geometry";
import type { Container, LeaderboardEvent, PackingConfig, ProblemInfo } from "@polypack/geometry";
import * as api from "../api";
import { Board } from "../board";
import { BoardView } from "../view";
import {
  DealerState,
  canDeal,
  contestedCandidates,
  contestedDealable,
  drawContestedPair,
  drawProblem,
  drawWide,
  evalsToNextDeal,
  nextRandom,
  openDealable,
  publishedTarget,
  retakeTier,
  takeToken,
} from "./dealer";
import { FRONTIER, ProblemKey, STARTER, keyOf, parseKey, problemTitle, shapeName } from "./frontier";
import {
  GameState,
  Leader,
  PastProblem,
  ProblemState,
  STALE_EVALS,
  StepChange,
  accrue,
  addToQueue,
  applyAnswer,
  applyLeader,
  applyLoadAll,
  applyStep,
  buy,
  density,
  drop,
  evolvable,
  hasUnsent,
  leave,
  log,
  markSending,
  newGame,
  newProblem,
  openedRun,
  ownedSet,
  pay,
  payAll,
  withdrawConsent,
  pendingPoints,
  problem,
  recordsHeld,
  reveal,
  revealed,
  seenKeys,
  slotted,
  spent,
  submitTarget,
  unconfirmedPoints,
} from "./game";
import {
  RENT_CHECK_MS,
  collections,
  collectionsBonus,
  nextRentCheck,
  rentRate,
  rentWaiting,
  settleRent,
  syncEconomy,
  tidyRent,
} from "./economy";
import { Lane } from "./lanes";
import type { RunState } from "./open-run";
import {
  OFFLINE_BACKOFF_MS,
  RATE_LIMITED_BACKOFF_MS,
  canSend,
  compact as compactPacer,
  pause,
  recordSend,
} from "./pacer";
import { Offer, addRetake, offerFits } from "./picks";
import { CONTEST, FLOOR, TIERS, TIER_LABEL, Tier, gapOf, show6 } from "./points";
import {
  Candidate,
  Ranked,
  collectorTargets,
  formatShapes,
  msPerEval,
  parseShapes,
  passes,
  rankCandidates,
} from "./rank";
import { autoHold, autoTarget } from "./scheduler";
import { STORAGE_KEY, exportString, fromJson, importString, toJson } from "./save";
import { ShopRenderer, shopView } from "./shop";
import {
  MARKS,
  RESET_MIN,
  RULES,
  bestMark,
  markProgress,
  resetCycle,
  resetPreview,
  ruleAllowsMethod,
  ruleAllowsProblem,
  ruleById,
  ruleOpenProblems,
  standingMultiplier,
} from "./standing";
import { RunRecord, classifyAnswer, shouldSubmit, submissionBody } from "./submission";
import { RunChoice, chooseRun, observeRun, pipelineMethod, planRandom, problemKind } from "./runplan";
import { renderRunsPanel } from "./runs-ui";
import { TransferStart, chooseStart, neighbourPs, scoredTransfer } from "./transfer";
import { sanitizeName } from "./names";
import {
  COMPACT_EVALS,
  EvolveMethod,
  Owned,
  RUN_BUDGET,
  UpgradeId,
  autoPerSecond,
  awayHours,
  bankCap,
  cores,
  dealerChoices,
  evalsPerClick,
  laneCount,
  lanesMaxed,
  level,
  methodParams,
  methods,
  offerCount,
  queueSize,
  ringMin,
  seedsPerProblem,
  tuningLevel,
  upgrade,
  UPGRADES,
  costOf,
} from "./upgrades";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- clock ----------

/** Game time. The end-to-end tests move it forward (dev builds only) to pass the submission minute. */
let clockOffset = 0;
const now = () => Date.now() + clockOffset;

// ---------- formatting ----------

const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
const fmtRP = (n: number) => (n < 100 ? n.toFixed(1) : fmtInt(n));
const fmtPct = (x: number, digits = 2) => `${(x * 100).toFixed(digits)} %`;
const fmtCompute = (ms: number) =>
  ms < 60_000
    ? `${(ms / 1000).toFixed(0)} s`
    : ms < 3_600_000
      ? `${(ms / 60_000).toFixed(1)} min`
      : `${(ms / 3_600_000).toFixed(1)} h`;
/** A relative change as the trace and status show it: "−0.0607 %". */
const fmtChange = (before: number, after: number) =>
  `${after < before ? "−" : "+"}${(Math.abs(1 - after / before) * 100).toFixed(4)} %`;
const evals = (n: number) => `${fmtInt(n)} evaluation${n === 1 ? "" : "s"}`;
/** Hours as the bank note says them: "4 h", "3 days", "a week". */
const fmtHours = (h: number) => (h < 48 ? `${h} h` : h === 168 ? "a week" : `${h / 24} days`);
/** Auto-eval's pace: "1 evaluation every 5 s", "2 evaluations a second". */
const fmtRate = (r: number) => (r < 1 ? `1 evaluation every ${Math.round(1 / r)} s` : `${evals(r)} a second`);

// ---------- state and saving ----------

let savesDisabled = false;
let startNote: string | null = null;

function randomSeed(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0];
}

function initialState(): GameState {
  const query = new URLSearchParams(location.search);
  // ?seed=n chooses the dealer's sequence of a new game (reproducible deals); a saved game keeps its own
  const asked = Number(query.get("seed"));
  const seed =
    query.has("seed") && Number.isSafeInteger(asked) && asked >= 0 && asked <= 0xffffffff ? asked : randomSeed();
  let text: string | null = null;
  try {
    text = localStorage.getItem(STORAGE_KEY);
  } catch {
    startNote = "This browser does not let the page keep a save; the game lasts until the tab is closed.";
  }
  if (text) {
    const r = fromJson(text, now());
    if (r.ok) return r.state;
    if (/newer version/.test(r.error)) {
      // never overwrite a save this version cannot read
      savesDisabled = true;
      startNote = `Your save is from a newer version of Tighter, so this page will not touch it. Playing without saving.`;
    } else {
      try {
        localStorage.setItem(`${STORAGE_KEY}.unreadable.${Date.now()}`, text);
      } catch {
        // nothing more to keep
      }
      startNote = `Your save could not be read (${r.error}). It was kept aside, and a new game started.`;
    }
  }
  return newGame(now(), seed);
}

let state = initialState();
// collections and the first cycle's earnings, for a save from before records were an economy
syncEconomy(state);
/**
 * While the page was closed, auto-eval (if it was on) kept earning evaluations into its bank, up to
 * the hours the player's upgrades keep. Then it is off: compute starts only on a press, and the
 * bank runs once the player switches auto-eval on again.
 */
function welcomeBack(s: GameState): number {
  const o = ownedSet(s);
  const earned = s.settings.auto
    ? accrue(s, now(), (autoPerSecond(o) ?? 0) * laneCount(o), bankCap(o, laneCount(o)))
    : 0;
  s.bankAt = now();
  s.settings.auto = false;
  return earned;
}
const earnedAway = welcomeBack(state);
if (earnedAway >= 1 && !startNote)
  startNote = `While you were away, auto-eval earned ${evals(Math.floor(earnedAway))}. Switch Auto-eval on to run them.`;

/**
 * Only the tab that holds the game (see "one tab" below) runs anything or writes the save; another
 * tab on the same save would double the caps and overwrite its points.
 */
let ownsGame = false;

let saveTimer = 0;
function saveNow(): void {
  clearTimeout(saveTimer);
  saveTimer = 0;
  if (savesDisabled || !ownsGame) return;
  try {
    state.pacer = compactPacer(state.pacer, now());
    localStorage.setItem(STORAGE_KEY, toJson(state));
  } catch {
    // storage full or unavailable: the game goes on in memory
  }
}
/** Saves soon: clicks come many a second, so saves are spaced. */
function persist(): void {
  if (savesDisabled || !ownsGame || saveTimer) return;
  saveTimer = window.setTimeout(saveNow, 1000);
}
window.addEventListener("pagehide", saveNow);
// leaving for another tab (which may take the game over) saves at once
document.addEventListener("visibilitychange", () => {
  if (document.hidden) saveNow();
});

const owned = () => ownedSet(state);
const focused = () => problem(state, state.focus);
/** A problem's points as earned, before standing and collections multiply them: what method match learns from. */
const basePoints = (p: ProblemState) => state.economy.base[p.key] ?? p.rp;
/** A method the player owns and the cycle's rule allows. */
const allowedMethod = (o: Owned, m: EvolveMethod): boolean =>
  methods(o).includes(m) && ruleAllowsMethod(state.standing, m);
/** The select's method, or when the rule refuses it the first owned method it allows. */
const chosenMethod = (o: Owned): EvolveMethod =>
  allowedMethod(o, state.settings.method)
    ? state.settings.method
    : (methods(o).find((m) => allowedMethod(o, m)) ?? "mc_compress");
/** Method match is on: "Auto" chosen, and Method match or Auto-tune owned. */
const autoMethods = (o: Owned): boolean => state.runplan.auto && (o.has("methodMatch") || o.has("autoTune"));
/** The pipeline decides each new run's method: Pipelines owned and at least one stage. */
const piped = (o: Owned): boolean => o.has("pipeline") && state.runplan.pipeline.length > 0;

// ---------- board ----------

const statusEl = $("status");
const say = (text: string) => {
  statusEl.textContent = text;
};
const board = new Board();
const view = new BoardView($<HTMLCanvasElement>("board"), board, () => {});
view.readOnly = true;
view.previewLabel = null;

/** The dashed area bound, centred on a container (or the origin). */
function ghost(p: ProblemState, around: Container | null): Container {
  return {
    M: p.M,
    cx: around?.cx ?? 0,
    cy: around?.cy ?? 0,
    phi: around?.phi ?? 0,
    size: areaLowerBound(p.N, p.M, p.P),
  };
}

let shown = "";
/** Puts the focused problem's board on the canvas, when it changed. */
function showFocus(force = false): void {
  const p = focused();
  const sig = p ? `${p.key}|${p.phase}|${p.best}` : "";
  if (!force && sig === shown) return;
  const refit = !p || !shown.startsWith(`${p.key}|`) || force;
  shown = sig;
  view.setPreview(null);
  if (!p) {
    board.load({ N: 0, M: 0, P: 1, pieces: [], container_phi: 0 }, false);
    view.ghost = null;
    view.fit();
    return;
  }
  const config: PackingConfig = p.board ?? { N: p.N, M: p.M, P: p.P, pieces: [], container_phi: 0 };
  if (board.load(config, false)) board.load({ N: p.N, M: p.M, P: p.P, pieces: [], container_phi: 0 }, false);
  // the dashed area bound frames a board that has no record yet
  view.ghost = p.phase === "ready" ? null : ghost(p, board.container);
  // a new problem is framed; clicks on the same one keep the camera still
  if (refit || p.phase !== "ready") fitView(board.container ?? view.ghost);
  else view.requestDraw();
}

/**
 * The view's fit, allowed to zoom out further: BoardView.fit stops at 4 pixels per unit, which
 * leaves large frontier problems (300 pieces of up to 100 sides) overflowing the canvas.
 */
function fitView(c: Container | null): void {
  view.fit();
  const canvas = $<HTMLCanvasElement>("board");
  const w = canvas.clientWidth,
    h = canvas.clientHeight;
  if (!c || !(c.size > 0) || !w || !h) return;
  // distance from the centre to a vertex (polygon) or the rim (circle)
  const reach = c.M === 0 ? c.size : c.size / (2 * Math.sin(Math.PI / c.M));
  const zoom = (0.42 * Math.min(w, h)) / reach;
  if (zoom < view.cam.zoom) {
    view.cam.zoom = zoom;
    view.requestDraw();
  }
}
// The canvas changes size when the banner comes and goes (and with the window): fit again.
let canvasSize = "";
new ResizeObserver(() => {
  const c = $("board");
  const size = `${c.clientWidth}x${c.clientHeight}`;
  if (size === canvasSize) return;
  canvasSize = size;
  fitView(board.container ?? view.ghost);
}).observe($("board"));

// ---------- lanes and their open runs ----------

/**
 * Evaluations asked of a problem's open run: one click's (Evolve, or Compact's 100), or one of
 * auto-eval's. Clicks and auto-eval share one queue per lane, so every evaluation earned runs once,
 * whatever the order.
 */
interface Job {
  key: string;
  evals: number;
  /** A press of the player's; otherwise auto-eval's. */
  click: boolean;
  compact: boolean;
}

interface OpenRunView {
  key: string;
  method: EvolveMethod;
  /** The tuning level its parameters are the preset of. */
  level: number;
  /** Who chose the method (a change of mode starts a new run). */
  mode: RunMode;
  /** The parameters asked for (an upgrade that changes them starts a new run), and as resolved. */
  asked: string;
  params: Record<string, unknown>;
  seed: number;
  /** Evaluations the run has done, its start's scoring included. */
  evaluations: number;
  /** For the bandit: the kind of problem, the problem's RP and the run's evaluations when it opened. */
  kind: string;
  rpAt: number;
  evalsAt: number;
}

/** Who chose a run's method: Compact, the select, Method match or the pipeline. */
type RunMode = "compact" | "select" | "auto" | "pipeline";

interface LaneView {
  lane: Lane;
  run: OpenRunView | null;
  jobs: Job[];
  pumping: boolean;
  current: Job | null;
  /** The open run's state during a long step (Compact's, or many evaluations a click). */
  progress: RunState | null;
}

/** Most clicks a lane holds before it has caught up; more are not taken. */
const MAX_QUEUED_CLICKS = 20;

const lanes: LaneView[] = [];
/**
 * As many lanes as the player owns (up to the CPU's cores less one). A lane no longer owned (after a
 * reset) goes once it is idle: its run closes, its worker stops, and auto-eval's jobs it held go
 * back to the bank.
 */
function ensureLanes(): void {
  const want = laneCount(owned());
  while (lanes.length > want) {
    const lv = lanes[lanes.length - 1];
    if (lv.pumping || lv.current) break;
    for (const j of lv.jobs) if (!j.click) state.bank += j.evals;
    lanes.pop();
    lv.lane.terminate();
  }
  while (lanes.length < want) {
    const lv: LaneView = {
      lane: new Lane(lanes.length),
      run: null,
      jobs: [],
      pumping: false,
      current: null,
      progress: null,
    };
    lv.lane.onProgress = (s) => {
      lv.progress = s;
      scheduleRender();
    };
    lanes.push(lv);
  }
}
ensureLanes();
/** The keys of the problems a lane has a run on, or work queued for. */
const laneKeys = (l: LaneView) =>
  [l.run?.key, l.current?.key, ...l.jobs.map((j) => j.key)].filter((k): k is string => !!k);
const laneOn = (key: string) => lanes.find((l) => laneKeys(l).includes(key));
/** The last step's change per problem, for the score panel (not saved). */
const lastChange = new Map<string, StepChange & { evals: number; seed: number; method: string }>();
/** Problems whose first-record banner is up. */
let banner: { key: string; text: string } | null = null;

/** The lane for work on `key`: the one already holding it, else an idle one. */
function laneFor(key: string): LaneView {
  ensureLanes();
  return (
    laneOn(key) ??
    lanes.find((l) => !l.pumping && !l.jobs.length && !l.run) ??
    lanes.find((l) => !l.pumping && !l.jobs.length) ??
    lanes[0]
  );
}

const loading = new Set<string>();

/**
 * Transfers: the best known packing of a neighbour with fewer pieces (same N and M), grown to this
 * problem's pieces. The player's own boards in the queue first, then the site's records of the
 * closest neighbours (one GET each, and one for the packing). Null when there is none.
 */
async function findTransfer(p: ProblemState): Promise<TransferStart | null> {
  const own = state.queue
    .filter((q) => q !== p && q.N === p.N && q.M === p.M && q.P < p.P && q.board && q.phase !== "bare" && !!q.run)
    .sort((a, b) => b.P - a.P)[0];
  let best = own?.board ? scoredTransfer(own.board, p) : null;
  for (const P2 of neighbourPs(p.P, owned().has("wide"))) {
    if (best && best.from >= P2) break;
    const info = await api.getProblem(p.N, p.M, P2);
    const lead = info?.site_best;
    if (!lead || lead.verification === "pending") continue;
    // 404 when the entry is no longer kept (only the leader of a problem is)
    const entry = await api.getSubmission(lead.id);
    if (!entry || entry.N !== p.N || entry.M !== p.M || entry.P !== P2) continue;
    const t = scoredTransfer({ N: p.N, M: p.M, P: P2, pieces: entry.pieces, container_phi: entry.container_phi }, p);
    if (t && (!best || t.score < best.score)) best = t;
    if (best) break;
  }
  return best;
}

/**
 * Load all: the board's Add all from the centre. Its score is the free floor and is never sent. With
 * Transfers, a neighbour's packing grown to this problem starts it instead when that is clearly smaller; the
 * free floor is then the smallest of the two (and of the trim floor), so neither is sent unimproved.
 */
async function loadAll(p: ProblemState): Promise<boolean> {
  if (p.phase !== "bare") return true;
  if (loading.has(p.key) || !ownsGame) return false;
  loading.add(p.key);
  try {
    const b = new Board();
    b.load({ N: p.N, M: p.M, P: p.P, pieces: [], container_phi: 0 }, false);
    b.addPieces(p.P, 0, 0);
    const config = b.toConfig();
    const e = evaluate(config, { autoOrient: true });
    if (!e.valid || !e.container || e.score === null) {
      say(`Load all did not give a valid board: ${e.reasons.join("; ")}`);
      return false;
    }
    config.container_phi = e.container.phi;
    // A record for P + 1 minus any one piece packs P pieces in no more room: it is part of the floor.
    const next = p.P < MAX_PIECES ? await api.getProblem(p.N, p.M, p.P + 1) : null;
    const trim = next?.site_best && next.site_best.verification !== "pending" ? next.site_best.score : null;
    const transfer = owned().has("transfer") ? await findTransfer(p) : null;
    if (problem(state, p.key) !== p || p.phase !== "bare") return p.phase !== "bare";
    const start = chooseStart({ board: config, score: e.score }, trim, transfer);
    applyLoadAll(p, start.board, start.score, trim);
    reveal(state, "score");
    if (p.key === state.focus) {
      const b0 = areaLowerBound(p.N, p.M, p.P);
      say(
        start.transferred
          ? `Transfer: the best packing of ${transfer!.from} pieces, with ${p.P - transfer!.from} more placed around it. ` +
              `Side ${show6(start.score)}, ${fmtPct(start.score / b0 - 1)} above the area bound (Load all: ${show6(e.score)}). ` +
              (p.floor! < start.score
                ? `The record for ${p.P + 1} pieces, less one, is smaller (${show6(p.floor!)}): that is the free floor.`
                : "This is the free floor: a transfer is never sent unimproved. Press Compact.")
          : `Load all: ${p.P} pieces on rings around the centre. Side ${show6(e.score)}, ${fmtPct(e.score / b0 - 1)} above the area bound. ` +
              (p.floor! < e.score
                ? `The record for ${p.P + 1} pieces, less one, is smaller (${show6(p.floor!)}): that is the free floor.`
                : "This is the free floor: Load all is never sent. Press Compact."),
      );
    }
    if (start.transferred)
      log(state, now(), `Transfer on ${problemTitle(p)}: started from the packing of ${transfer!.from} pieces.`);
    persist();
    return true;
  } finally {
    loading.delete(p.key);
    render();
  }
}

/** Queues a press on the focused problem: Compact (100 evaluations) or Evolve (a click's). */
function press(compact: boolean): void {
  const p = focused();
  if (!p || !ownsGame || p.leaving || p.closed) return;
  const o = owned();
  if (compact ? p.phase !== "loaded" || !!p.run || laneOn(p.key) : !evolvable(p)) return;
  if (!compact && spent(p, seedsPerProblem(o))) {
    say(spentText(p));
    return;
  }
  const lv = laneFor(p.key);
  if (lv.jobs.filter((j) => j.click).length >= MAX_QUEUED_CLICKS) return;
  lv.jobs.push({ key: p.key, evals: compact ? COMPACT_EVALS : evalsPerClick(o), click: true, compact });
  if (banner?.key === p.key) banner = null;
  void pump(lv);
  render();
}

/** Works through a lane's queue: clicks first, then auto-eval's banked evaluations. */
async function pump(lv: LaneView): Promise<void> {
  if (lv.pumping || !ownsGame) return;
  lv.pumping = true;
  try {
    for (;;) {
      if (!ownsGame || !lanes.includes(lv)) break;
      const job = lv.jobs.shift() ?? autoJob(lv);
      if (!job) break;
      const ran = await runJob(lv, job);
      if (!ran && !job.click) {
        // auto-eval's evaluations are never lost: back to the bank, and the next tick tries again
        state.bank += job.evals;
        break;
      }
    }
  } finally {
    lv.pumping = false;
    scheduleRender();
  }
}

/** A run's method, tuning level and who chose them. */
type WantedRun = RunChoice & { mode: RunMode };

const levelFits = (o: Owned, r: OpenRunView) =>
  o.has("autoTune") && state.runplan.auto ? r.level <= tuningLevel(o, r.method) : r.level === tuningLevel(o, r.method);

/**
 * The run a job on `p` wants: Compact's (mc_compress); else the pipeline's stage for the problem's
 * next seed; else Method match's choice; else the select's method. A run already open in the same
 * mode is kept while its choice still holds, so the bandit draws only when a new run opens.
 */
function wantedRun(p: ProblemState, o: Owned, lv: LaneView, compact: boolean): WantedRun {
  if (compact) return { method: "mc_compress", level: tuningLevel(o, "mc_compress"), mode: "compact" };
  const r = lv.run && lv.lane.open && lv.run.key === p.key ? lv.run : null;
  const tune = o.has("autoTune") && state.runplan.auto;
  const draw = (ms: readonly EvolveMethod[], withLevels: boolean) =>
    chooseRun(state.runplan, {
      kind: problemKind(p),
      methods: ms,
      levelOf: (m) => tuningLevel(o, m),
      tune: withLevels,
      allowed: (m) => allowedMethod(o, m),
      rand: planRandom(state.runplan, state.dealer.seed),
    });
  if (piped(o)) {
    const stage = pipelineMethod(state.runplan.pipeline, p.endedRuns, (m) => allowedMethod(o, m));
    if (stage) {
      if (r && r.mode === "pipeline" && r.method === stage.method && levelFits(o, r))
        return { method: r.method, level: r.level, mode: "pipeline" };
      const level = tune ? (draw([stage.method], true)?.level ?? 0) : tuningLevel(o, stage.method);
      return { method: stage.method, level, mode: "pipeline" };
    }
  }
  if (autoMethods(o)) {
    if (r && r.mode === "auto" && allowedMethod(o, r.method) && levelFits(o, r))
      return { method: r.method, level: r.level, mode: "auto" };
    const c = draw(methods(o), tune);
    if (c) return { ...c, mode: "auto" };
  }
  const m = chosenMethod(o);
  return { method: m, level: tuningLevel(o, m), mode: "select" };
}

/** A run that ends or is replaced: the bandit learns what it paid per evaluation (Compact's excepted). */
function finishRun(run: OpenRunView | null): void {
  if (!run || run.mode === "compact") return;
  const p = problem(state, run.key);
  if (p)
    observeRun(state.runplan, run.kind, run.method, run.level, basePoints(p) - run.rpAt, run.evaluations - run.evalsAt);
}

/** Opens a run on the problem (closing whatever the lane held), with its next seed. */
async function openRun(lv: LaneView, p: ProblemState, want: WantedRun, job: Job): Promise<boolean> {
  const { method, level } = want;
  const params = methodParams(owned(), method, level);
  // a problem's run lives in one lane: a run on it elsewhere closes first
  for (const other of lanes)
    if (other !== lv && other.run?.key === p.key) {
      finishRun(other.run);
      other.run = null;
      void other.lane.close();
    }
  finishRun(lv.run);
  lv.run = null;
  if (lv.lane.open) await lv.lane.close();
  const seed = p.nextSeed;
  const a = await lv.lane.openRun({
    problem: { N: p.N, M: p.M, P: p.P },
    method,
    params,
    budget: { evals: RUN_BUDGET },
    seed,
    start: structuredClone(p.board!),
  });
  if (problem(state, p.key) !== p) {
    void lv.lane.close();
    return false;
  }
  if (!a.ok) {
    say(`A run on ${problemTitle(p)} could not start: ${a.message}.`);
    return false;
  }
  openedRun(state, p, seed, now());
  lv.run = {
    key: p.key,
    method,
    level,
    mode: want.mode,
    asked: JSON.stringify(params),
    params: a.params,
    seed,
    evaluations: a.state.evaluations,
    kind: problemKind(p),
    rpAt: basePoints(p),
    evalsAt: 0,
  };
  // the start's own scoring (with the container's best turn) may already beat the board
  settle(lv.run, p, { ...job, click: false }, a.state, a.state.evaluations, 0);
  return true;
}

/**
 * Runs one job: opens a run when the lane has none on the problem (or the method or its parameters
 * changed), then steps it. Returns whether the job's evaluations were run. The job is the lane's
 * current one from the start, so that no other lane takes its problem meanwhile (a Load all, for one).
 */
async function runJob(lv: LaneView, job: Job): Promise<boolean> {
  lv.current = job;
  lv.progress = null;
  try {
    let p = problem(state, job.key);
    if (!p || p.leaving || p.closed) return false;
    // auto-eval's Compact of a problem that has not been loaded yet (Auto-advance)
    if (job.compact && p.phase === "bare" && !(await loadAll(p))) return false;
    p = problem(state, job.key);
    if (!p || !p.board || (job.compact ? p.phase !== "loaded" : !evolvable(p))) return false;
    const o = owned();
    const want = wantedRun(p, o, lv, job.compact);
    const asked = JSON.stringify(methodParams(o, want.method, want.level));
    const r = lv.run;
    // Compact's run goes on under the select's method when that is the same method and setting
    const sameMode = !!r && (r.mode === want.mode || (r.mode === "compact" && want.mode === "select"));
    if (
      !r ||
      !lv.lane.open ||
      r.key !== p.key ||
      r.method !== want.method ||
      r.level !== want.level ||
      r.asked !== asked ||
      !sameMode
    ) {
      if (!job.compact && spent(p, seedsPerProblem(o))) return false;
      if (!(await openRun(lv, p, want, job))) return false;
    } else if (r.mode !== want.mode) {
      // from here on the run is the method's own: what it pays is measured from now
      r.mode = want.mode;
      r.rpAt = basePoints(p);
      r.evalsAt = r.evaluations;
    }
    const run = lv.run!;
    const t = await lv.lane.step(job.evals);
    if (!t.ok) {
      finishRun(run);
      lv.run = null;
      say(`The run on ${problemTitle(p)} stopped: ${t.message}.`);
      return false;
    }
    const done = Math.max(0, t.state.evaluations - run.evaluations);
    run.evaluations = t.state.evaluations;
    if (t.state.ended) lv.run = null;
    if (problem(state, p.key) !== p) {
      // the problem left the queue meanwhile; the work still counts as done
      state.stats.evaluations += done;
      return true;
    }
    settle(run, p, job, t.state, done, t.ms);
    if (t.state.ended) finishRun(run);
    return true;
  } finally {
    lv.current = null;
    lv.progress = null;
  }
}

/** A step's result applied to the game: the board, the counters, the points, the messages. */
function settle(run: OpenRunView, p: ProblemState, job: Job, st: RunState, done: number, ms: number): void {
  const record: RunRecord = {
    method: run.method,
    params: run.params,
    seed: run.seed,
    budget: { evals: Math.max(1, st.evaluations) },
  };
  const change = applyStep(
    state,
    p,
    {
      evaluations: done,
      best: st.best,
      score: st.score,
      run: record,
      ms,
      ended: st.ended && !st.closed && !st.error,
      click: job.click,
      compact: job.compact && done > 1,
    },
    now(),
  );
  lastChange.set(p.key, { ...change, evals: done, seed: run.seed, method: run.method });
  if (change.firstRecord) {
    reveal(state, "consent", "log");
    banner = {
      key: p.key,
      text:
        p.tier === "open"
          ? `New record ${show6(p.best!)} · no one had packed ${problemTitle(p).replace(/, (\d+) pieces$/, " with $1 pieces")} before.`
          : `New best ${show6(p.best!)} on ${problemTitle(p)}.`,
    };
    log(
      state,
      now(),
      `New record ${show6(p.best!)} on ${problemTitle(p)}${state.consent ? "" : " (not sent: no name yet)"}.`,
    );
  }
  if (change.points) reveal(state, "points", "upgrades");
  if (st.ended && !st.closed && !st.error) {
    const left = spent(p, seedsPerProblem(owned()));
    log(
      state,
      now(),
      `The run with seed ${run.seed} on ${problemTitle(p)} stopped improving after ${evals(st.evaluations)}.` +
        (left ? " Its seeds are spent." : ` The next click starts one with a new seed${nextStageText(p)}.`),
    );
  }
  if (job.click && p.key === state.focus) say(stepMessage(p, change, run, job, done));
  persist();
  scheduleRender();
  void submitTick();
  void dealTick();
}

function stepMessage(p: ProblemState, c: StepChange, run: OpenRunView, job: Job, done: number): string {
  const o = owned();
  const what =
    `${job.compact ? "Compact" : `Click ${fmtInt(state.stats.clicks)}`} · ${run.method}` +
    `${o.has("seeds") ? ` · seed ${run.seed}` : ""} · ${evals(done)}: `;
  if (!c.improved || c.before === null || c.after === null) return `${what}no improvement on ${show6(p.best ?? 0)}.`;
  const decades = Math.log10((1 - c.after / c.before) / FLOOR);
  const tail = c.counted
    ? `${decades.toFixed(1)} decades above the floor`
    : `below the 10⁻⁹ floor, so it is not an event`;
  let text = `${what}${show6(c.before)} → ${show6(c.after)} (${fmtChange(c.before, c.after)}, ${tail})`;
  text += c.points ? ` · +${fmtRP(c.points.total)} RP.` : ".";
  if (c.counted && !state.consent) text += " Put your name on your records to send them and earn their points.";
  return text;
}

/** With a pipeline: ", running <method>" for the next stage on the problem; otherwise nothing. */
function nextStageText(p: ProblemState): string {
  const o = owned();
  if (!piped(o)) return "";
  const stage = pipelineMethod(state.runplan.pipeline, p.endedRuns, (m) => allowedMethod(o, m));
  return stage ? `, running ${stage.method} (stage ${stage.stage + 1} of ${state.runplan.pipeline.length})` : "";
}

/** Runs that ran to their end here, of the seeds per problem the player has. */
const seedsText = (p: ProblemState, seeds: number) =>
  `${fmtInt(Math.min(p.endedRuns, seeds))} of ${fmtInt(seeds)} seed${seeds === 1 ? "" : "s"} spent`;

function spentText(p: ProblemState): string {
  const n = seedsPerProblem(owned());
  return `Every seed on ${problemTitle(p)} has run until it stopped improving (${n} of ${n}). Take the next problem${n < 16 ? ", or buy more seeds" : ""}.`;
}

function stopAll(): void {
  state.settings.auto = false;
  for (const l of lanes) l.jobs = l.jobs.filter((j) => j.compact && j.click);
  say("Stopped: auto-eval is off and queued clicks are dropped. What auto-eval earned stays in its bank.");
  persist();
  render();
}

// ---------- hold: hidden tabs and battery ----------

let onBattery = false;
function holdReason(): "hidden" | "battery" | null {
  return autoHold({
    hidden: document.hidden,
    onBattery,
    // running while hidden needs Continuous; before it a hidden tab banks, whatever the save says
    background: state.settings.background && owned().has("continuous"),
    battery: state.settings.battery,
  });
}
/**
 * Auto-eval runs nothing while the tab is hidden or the device is on battery power, unless the
 * player allowed it in Settings; it keeps earning into its bank meanwhile, and the bank runs when
 * running is allowed again. Clicks are the player's own and always run.
 */
function applyHold(): void {
  if (!holdReason()) kickLanes();
  render();
}
document.addEventListener("visibilitychange", applyHold);
type BatteryManager = EventTarget & { charging: boolean };
const getBattery = (navigator as Navigator & { getBattery?: () => Promise<BatteryManager> }).getBattery;
if (getBattery) {
  getBattery
    .call(navigator)
    .then((b) => {
      $("t-battery-box").hidden = false;
      const update = () => {
        onBattery = !b.charging;
        applyHold();
      };
      b.addEventListener("chargingchange", update);
      update();
    })
    .catch(() => {});
}

// ---------- auto-eval ----------

/** Brings auto-eval's bank up to now. */
function accrueBank(): void {
  const o = owned();
  accrue(state, now(), state.settings.auto ? (autoPerSecond(o) ?? 0) * laneCount(o) : 0, bankCap(o, laneCount(o)));
}

/**
 * Auto-eval's next click for this lane, from its bank, when it may run one. It clicks as the player
 * does, with as many evaluations as a click of theirs, so an evaluation pays the same either way: at
 * one evaluation every 5 s and 2 a click (where Auto-eval comes), that is one click every 10 s.
 */
function autoJob(lv: LaneView): Job | null {
  const o = owned();
  const k = evalsPerClick(o);
  if (autoPerSecond(o) === null || !state.settings.auto || holdReason() || state.bank < k) return null;
  const busy = new Set(lanes.filter((l) => l !== lv).flatMap(laneKeys));
  const target = autoTarget({
    lane: lanes.indexOf(lv),
    queue: state.queue,
    focus: state.focus,
    busy,
    owned: o,
    seeds: seedsPerProblem(o),
    // a Compact waits until the bank holds its 100 evaluations; meanwhile runs go on elsewhere
    canCompact: state.bank >= COMPACT_EVALS,
  });
  if (!target) return null;
  if (target.action === "compact") {
    if (state.bank < COMPACT_EVALS) return null;
    state.bank -= COMPACT_EVALS;
    return { key: target.key, evals: COMPACT_EVALS, click: false, compact: true };
  }
  state.bank -= k;
  return { key: target.key, evals: k, click: false, compact: false };
}

/** Starts every idle lane that has work, banked or queued. */
function kickLanes(): void {
  if (!ownsGame) return;
  ensureLanes();
  for (const lv of lanes) if (!lv.pumping) void pump(lv);
}

function autoTick(): void {
  if (!ownsGame) return;
  accrueBank();
  kickLanes();
}

// ---------- submissions ----------

let submitting = false;
/** Problems whose submission is on its way. */
const inFlight = new Set<string>();

/** Sends at most one improvement per call, when consent, the pacer and the server allow. */
async function submitTick(): Promise<void> {
  if (submitting) return;
  const t = now();
  // problems dropped with nothing left to send leave now
  for (const p of [...state.queue]) if (p.leaving && (!state.consent || !hasUnsent(p))) leave(state, p.key, t);
  if (!ownsGame || !state.consent || !state.name) return;
  const candidates = state.queue
    .filter(hasUnsent)
    .map((p) => ({ p, kind: { first: p.verified === null && p.leader === null, leaving: p.leaving } }))
    .filter(({ p, kind }) => canSend(state.pacer, p.key, t, kind))
    .sort((a, b) => Number(b.kind.leaving) - Number(a.kind.leaving) || Number(b.kind.first) - Number(a.kind.first));
  const next = candidates[0];
  if (!next) return;
  submitting = true;
  try {
    await submit(next.p);
  } finally {
    submitting = false;
    persist();
    render();
  }
}

/**
 * Before a board is sent, its container is turned to its best angle, as the server scores it. The
 * runs score fixed angles between turns, so this often gains a little: an improvement like any other.
 */
function orient(p: ProblemState): void {
  if (!p.board || p.best === null) return;
  const e = evaluate(p.board, { autoOrient: true });
  if (!e.valid || !e.container || e.score === null || !(e.score < p.best)) return;
  p.board = { ...p.board, container_phi: e.container.phi };
  p.best = e.score;
  const points = pay(state, p);
  if (points)
    log(
      state,
      now(),
      `Turning the container on ${problemTitle(p)} gained ${fmtChange(p.best / (1 - points.delta), p.best)} (+${fmtRP(points.total)} RP).`,
    );
}

async function submit(p: ProblemState): Promise<void> {
  const name = state.name;
  // the leader just before: the server's exact check decides
  const info = await api.getProblem(p.N, p.M, p.P);
  if (problem(state, p.key) !== p || !ownsGame) return;
  if (!info) {
    state.pacer = pause(state.pacer, now(), OFFLINE_BACKOFF_MS);
    log(state, now(), "The server cannot be reached; sending waits half a minute.");
    return;
  }
  if (!info.accepts_submissions) {
    p.closed = true;
    log(state, now(), `${problemTitle(p)} is closed: its optimum is proven. It leaves the queue.`);
    leave(state, p.key, now());
    return;
  }
  const leaderBefore: Leader | null = info.site_best
    ? { score: info.site_best.score, name: info.site_best.name, id: info.site_best.id }
    : null;
  noteLeader(p, leaderBefore);
  orient(p);
  const best = p.best!;
  if (!shouldSubmit(best, submitTarget(p, leaderBefore?.score ?? null))) return;
  // The player may have withdrawn consent or changed the name while the leader was read: what goes
  // to the server is decided now, immediately before the POST.
  if (!ownsGame || !state.consent || state.name !== name || !name) return;
  const board0 = structuredClone(p.board!);
  const run = structuredClone(p.run!);
  state.pacer = recordSend(state.pacer, p.key, now());
  // Kept in the save before the POST goes, so that an answer lost to a reload is recognised later.
  markSending(p, best, name, leaderBefore, now());
  saveNow();
  // the server announces a new leader before it answers: that event is this entry, not a rival's
  inFlight.add(p.key);
  let answer: Awaited<ReturnType<typeof api.postSubmission>>;
  try {
    answer = await api.postSubmission(submissionBody(board0, name, run));
  } finally {
    inFlight.delete(p.key);
  }
  const outcome = classifyAnswer(answer.status, answer.body);
  if (problem(state, p.key) !== p) return;
  const a = applyAnswer(state, p, leaderBefore, best, outcome, now());
  const title = problemTitle(p);
  switch (outcome.kind) {
    case "leader":
      reveal(state, "points", "upgrades");
      log(
        state,
        now(),
        `Verified: ${show6(outcome.score)} is the record for ${title}${a.confirmed > 0 ? ` (${fmtRP(a.confirmed)} RP confirmed)` : ""}.`,
      );
      if (outcome.pending) log(state, now(), "It beats a published value and waits for an administrator's review.");
      break;
    case "behind":
      log(
        state,
        now(),
        `Another entry got there first on ${title}: the record is ${show6(outcome.leaderScore ?? 0)}.` +
          (a.takenBack > 0 ? ` ${fmtRP(a.takenBack)} RP taken back.` : "") +
          (a.points ? ` Your board still beats it: +${fmtRP(a.points.total)} RP.` : ""),
      );
      break;
    case "closed":
      log(
        state,
        now(),
        `${title} is closed: ${outcome.reasons.join("; ")}. It leaves the queue.${a.takenBack > 0 ? ` ${fmtRP(a.takenBack)} RP taken back.` : ""}`,
      );
      leave(state, p.key, now());
      break;
    case "rate-limited":
      state.pacer = pause(state.pacer, now(), RATE_LIMITED_BACKOFF_MS);
      log(state, now(), "The server asks to wait a minute; sending pauses.");
      break;
    case "refused":
      log(
        state,
        now(),
        `The server refused the entry on ${title} (${outcome.status}): ${outcome.reasons.join("; ")}.` +
          (a.takenBack > 0 ? ` ${fmtRP(a.takenBack)} RP taken back.` : ""),
      );
      break;
    case "offline":
      state.pacer = pause(state.pacer, now(), OFFLINE_BACKOFF_MS);
      log(state, now(), "The server cannot be reached; sending waits half a minute.");
      break;
  }
  if (p.leaving && !hasUnsent(p)) leave(state, p.key, now());
}

// ---------- dealing ----------

let dealing = false;
let dealPausedUntil = 0;
/** Problems found taken or published during this session, besides those already dealt. */
const skipped = new Set<string>();
/** GET /api/records answers of this session, by pair, kept for 10 minutes. */
const recordsCache = new Map<string, { at: number; records: api.RecordsResponse }>();
const RECORDS_TTL_MS = 600_000;
/** Most GETs one deal (or one filling of the offers) makes before it gives up for a while. */
const DEAL_GETS = 30;

/** The GETs of one deal: how many went, and whether the server could not be reached. */
interface DealIo {
  gets: number;
  offline: boolean;
}
const spentIo = (io: DealIo) => io.offline || io.gets >= DEAL_GETS;

async function problemInfo(io: DealIo, k: ProblemKey): Promise<ProblemInfo | null> {
  io.gets++;
  const info = await api.getProblem(k.N, k.M, k.P);
  if (!info) io.offline = true;
  return info;
}

async function pairRecords(io: DealIo, N: number, M: number): Promise<api.RecordsResponse | null> {
  const key = `${N}/${M}`;
  const cached = recordsCache.get(key);
  if (cached && Math.abs(now() - cached.at) < RECORDS_TTL_MS) return cached.records;
  io.gets++;
  const records = await api.getRecords(N, M);
  if (!records) {
    io.offline = true;
    return null;
  }
  recordsCache.set(key, { at: now(), records });
  return records;
}

/** Whether a deal is due: a slot free and a token earned by evaluations, or an empty queue. */
function mayDeal(): boolean {
  const o = owned();
  const slots = queueSize(o);
  const filled = slotted(state).length;
  if (filled >= slots) return false;
  // with nothing to work on, nothing would earn the next problem: one is dealt on credit
  return filled === 0 || canDeal(state.dealer, slots, state.stats.evaluations, evalsPerClick(o));
}

/** The tiers of contested problems the player may be dealt. */
function contestedTiers(o: ReadonlySet<UpgradeId>): Set<Tier> {
  const t = new Set<Tier>();
  if (o.has("reach2")) t.add("loose");
  if (o.has("batch")) t.add("batch");
  if (o.has("published")) t.add("published");
  return t;
}

const dealerFilters = () => (owned().has("filters") ? state.picks.filters : null);
/** The player's filters and the cycle's rule allow a candidate. */
const allowed = (c: ProblemKey & { tier?: Tier }) => passes(dealerFilters(), c) && ruleAllowsProblem(state.standing, c);

const openCandidateOf = (k: ProblemKey): Candidate => ({
  N: k.N,
  M: k.M,
  P: k.P,
  tier: "open",
  weakness: null,
  leader: null,
  target: null,
  source: null,
  retake: false,
});

/** An open problem of the frontier (or the wider frontier), checked with GET just before. */
async function openCandidate(io: DealIo, d: DealerState, exclude: Set<string>, list?: readonly ProblemKey[]) {
  const o = owned();
  const pass = (p: ProblemKey) => allowed({ ...p, tier: "open" });
  // a cycle rule may need open problems of its own (circles have none in the frontier)
  const ruled = ruleOpenProblems(state.standing);
  const k =
    !list && !ruled && o.has("wide") && nextRandom(d) < 0.5
      ? drawWide(d, exclude, pass)
      : drawProblem(d, (list ?? ruled ?? FRONTIER).filter(pass), exclude);
  if (!k) return null;
  const info = await problemInfo(io, k);
  if (!info) return null;
  if (openDealable(info)) return openCandidateOf(k);
  skipped.add(keyOf(k));
  exclude.add(keyOf(k));
  return null;
}

/** A site record or published value of a random contested pair, in the player's tiers and size ring. */
async function contestedCandidate(io: DealIo, d: DealerState, exclude: Set<string>): Promise<Candidate | null> {
  const o = owned();
  const f = dealerFilters();
  const pair = drawContestedPair(d, f?.pieces ?? null, f?.containers ?? null);
  if (!pair) return null;
  const records = await pairRecords(io, pair.N, pair.M);
  if (!records) return null;
  const list = contestedCandidates(records, { ringMin: ringMin(o), tiers: contestedTiers(o), exclude, allow: allowed });
  if (!list.length) return null;
  const c = list[Math.floor(nextRandom(d) * list.length)];
  const info = await problemInfo(io, c);
  if (!info) return null;
  if (contestedDealable(info, c)) return c;
  // the pair's records changed since they were read
  recordsCache.delete(`${pair.N}/${pair.M}`);
  exclude.add(keyOf(c));
  return null;
}

/** The first record the player lost that can be taken back, started from its new leader (Retake). */
async function retakeCandidate(io: DealIo): Promise<Candidate | null> {
  while (state.picks.retake.length && !spentIo(io)) {
    const key = state.picks.retake[0];
    const k = parseKey(key);
    if (!k || problem(state, key) || state.picks.offers.some((x) => keyOf(x) === key)) {
      state.picks.retake.shift();
      continue;
    }
    const info = await problemInfo(io, k);
    if (!info) return null;
    state.picks.retake.shift();
    const lead = info.site_best;
    // nothing to take back: closed, no leader, in review, or the player's own name leads again
    if (!info.accepts_submissions || !lead || lead.verification === "pending") continue;
    if (state.name && sanitizeName(lead.name) === sanitizeName(state.name)) continue;
    if (!ruleAllowsProblem(state.standing, k)) continue;
    const records = k.N <= 20 && k.M <= 20 ? await pairRecords(io, k.N, k.M) : null;
    const tier = retakeTier(k.N, k.M, k.P, records);
    const lit = info.literature?.status === "best_known" ? info.literature : null;
    return {
      ...k,
      tier: lit ? "published" : tier === "published" ? "batch" : tier,
      weakness: null,
      leader: { score: lead.score, name: lead.name, id: lead.id },
      target: lit ? publishedTarget(lit) : null,
      source: lit ? `${lit.display} (${lit.source_name})` : null,
      retake: true,
    };
  }
  return null;
}

/** A missing problem of the player's nearest-to-complete collection, still open (Collector). */
async function collectorCandidate(io: DealIo, exclude: Set<string>): Promise<Candidate | null> {
  const targets = collectorTargets(new Set(state.economy.recorded), exclude).filter((k) =>
    allowed({ ...k, tier: "open" }),
  );
  for (const k of targets.slice(0, 6)) {
    const info = await problemInfo(io, k);
    if (!info) return null;
    if (openDealable(info)) return openCandidateOf(k);
    skipped.add(keyOf(k));
    exclude.add(keyOf(k));
  }
  return null;
}

/**
 * Up to `want` candidates, each checked with GET just before it counts: a retake first (Retake),
 * one deal in three a collection's missing problem (Collector), then draws, two in three of them
 * contested once the player reaches site records. `forced` is a candidate that must go first.
 */
async function gatherCandidates(
  d: DealerState,
  want: number,
  exclude: Set<string>,
): Promise<{ list: Candidate[]; forced: Candidate | null; offline: boolean }> {
  const io: DealIo = { gets: 0, offline: false };
  const o = owned();
  const list: Candidate[] = [];
  let forced: Candidate | null = null;
  const add = (c: Candidate | null) => {
    if (!c || list.some((x) => keyOf(x) === keyOf(c))) return;
    list.push(c);
    exclude.add(keyOf(c));
  };
  if (o.has("retake")) forced = await retakeCandidate(io);
  if (!forced && o.has("collector") && d.dealt % 3 === 2) forced = await collectorCandidate(io, exclude);
  if (forced) exclude.add(keyOf(forced));
  const contested = Number.isFinite(ringMin(o)) && contestedTiers(o).size > 0;
  const room = want - (forced ? 1 : 0);
  for (let attempt = 0; list.length < room && attempt < Math.max(6, room * 3) && !spentIo(io); attempt++)
    add(
      contested && nextRandom(d) < 2 / 3
        ? await contestedCandidate(io, d, exclude)
        : await openCandidate(io, d, exclude),
    );
  return { list, forced, offline: io.offline };
}

/** The candidates in order, best first: the learning dealer's draws once owned, else the prior. */
function rank(d: DealerState, list: readonly Candidate[]): Ranked[] {
  return rankCandidates(list, owned().has("learning") ? state.picks.bandit : null, () => nextRandom(d));
}

/** A ranking for a candidate dealt without one (the first deal, a forced one). */
function plainRanked(c: Candidate): Ranked {
  return rankCandidates([c], null, () => 0.5)[0];
}

/**
 * The problem a candidate becomes: an open problem starts bare; a site record, a retake or a
 * published value starts from a packing the server keeps (the leader's, or the best drawable one
 * for a published value) and must be improved on. Null when that packing cannot be read.
 */
async function materialize(c: Candidate): Promise<ProblemState | null> {
  if (c.tier === "open" && !c.retake) return newProblem(c, "open", now());
  let config: PackingConfig | null = null;
  let score: number | null = null;
  if (c.tier === "published") {
    // the best drawable packing: a site record at least as good as the value, else its coordinates
    const atlas = await api.getAtlas(c.N, c.M, c.P, c.P);
    const tile = atlas?.tiles.find((t) => t.P === c.P);
    if (tile) {
      const cfg: PackingConfig = { N: c.N, M: c.M, P: c.P, pieces: tile.pieces, container_phi: tile.container_phi };
      const e = evaluate(cfg, { autoOrient: true });
      if (e.valid && e.container && e.score !== null) {
        config = { ...cfg, container_phi: e.container.phi };
        score = e.score;
      }
    }
  } else if (c.leader) {
    // 404 when the entry is no longer kept (only the leader of a problem is)
    const entry = await api.getSubmission(c.leader.id);
    if (entry && entry.N === c.N && entry.M === c.M && entry.P === c.P) {
      config = { N: c.N, M: c.M, P: c.P, pieces: entry.pieces, container_phi: entry.container_phi };
      score = c.leader.score;
    }
  }
  if (!config || score === null || new Board().load(config, false)) return null;
  const p = newProblem(c, c.tier, now());
  p.phase = "ready";
  p.board = config;
  p.best = score;
  p.floor = c.leader ? Math.min(score, c.leader.score) : score;
  p.leader = c.leader ? { ...c.leader } : null;
  p.published = c.target;
  // a retaken problem comes back from the past
  if (c.retake) state.past = state.past.filter((q) => q.key !== p.key);
  return p;
}

/** A problem dealt: into the queue, with what the learning dealer will learn from. */
function dealt(p: ProblemState, r: { bucket: string; prior: number }, retake = false): void {
  takeToken(state.dealer);
  addToQueue(state, p);
  state.picks.dealt[p.key] = { bucket: r.bucket, prior: r.prior };
  log(state, now(), `${retake ? "Retake" : "Dealt"}: ${problemTitle(p)}${dealtNote(p)}.`);
  persist();
  showFocus();
}

/** What a dealt problem is, after its title in the log. */
function dealtNote(p: ProblemState): string {
  if (p.tier === "open") return "";
  if (p.tier === "published")
    return `, a published value to beat${p.leader ? ` (site record by ${p.leader.name})` : ""}`;
  return `, a ${TIER_LABEL[p.tier]} by ${p.leader?.name ?? "another name"}`;
}

/** Your pick: offers wait for the player; otherwise the dealer deals on its own. */
const picking = (o: ReadonlySet<UpgradeId>) => offerCount(o) > 0 && state.dealer.dealt > 0;

/** An offer the tree, the filters and the cycle's rule still allow (they may have changed since it was drawn). */
const offerAllowed = (o: Owned, x: Offer): boolean =>
  offerFits(x, { retake: o.has("retake"), tiers: contestedTiers(o), ringMin: ringMin(o) }, allowed);

async function dealTick(): Promise<void> {
  if (!ownsGame || dealing || now() < dealPausedUntil) return;
  const o = owned();
  if (picking(o)) {
    if (state.picks.offers.some((x) => !offerAllowed(o, x)))
      state.picks.offers = state.picks.offers.filter((x) => offerAllowed(o, x));
    if (!mayDeal() || (state.picks.offers.length >= offerCount(o) && !autoTakes(o))) return;
    dealing = true;
    try {
      await offerTick(o);
    } finally {
      dealing = false;
      render();
    }
    return;
  }
  if (!mayDeal()) return;
  dealing = true;
  try {
    const r = await deal(state.dealer);
    if (r) dealt(r.p, r.ranked, r.ranked.candidate.retake);
  } finally {
    dealing = false;
    render();
  }
}

/** Offline or nothing found: ask again in a while rather than every second. */
function pauseDealing(offline: boolean): void {
  dealPausedUntil = now() + OFFLINE_BACKOFF_MS;
  if (offline && !state.queue.length)
    $("t-title").textContent = "The server cannot be reached; the game needs it to deal a problem. Retrying…";
}

async function deal(d: DealerState): Promise<{ p: ProblemState; ranked: Ranked } | null> {
  const exclude = new Set([...seenKeys(state), ...skipped]);
  if (d.dealt === 0) {
    // the first problem comes from the starter corner while any of it is left open
    const io: DealIo = { gets: 0, offline: false };
    const ruled = ruleOpenProblems(state.standing);
    for (const list of ruled ? [ruled] : [STARTER, FRONTIER])
      for (let attempt = 0; attempt < 6 && !spentIo(io); attempt++) {
        const c = await openCandidate(io, d, exclude, list);
        if (c) return { p: newProblem(c, "open", now()), ranked: plainRanked(c) };
      }
    pauseDealing(io.offline);
    return null;
  }
  const { list, forced, offline } = await gatherCandidates(d, dealerChoices(owned()), exclude);
  const order = [...(forced ? [plainRanked(forced)] : []), ...rank(d, list)];
  for (const r of order) {
    const p = await materialize(r.candidate);
    if (p) return { p, ranked: r };
    skipped.add(keyOf(r.candidate));
  }
  pauseDealing(offline);
  return null;
}

/** A lane would have nothing to do: fewer problems still paying than lanes (Auto-advance takes an offer). */
function autoTakes(o: ReadonlySet<UpgradeId>): boolean {
  if (!o.has("advance") || !state.settings.auto || autoPerSecond(o) === null) return false;
  const seeds = seedsPerProblem(o);
  const paying = slotted(state).filter((p) => !p.closed && !spent(p, seeds) && p.sinceGain < STALE_EVALS);
  return paying.length < laneCount(o);
}

/** Your pick: fills the offers when a deal is due; Auto-advance takes the best when a lane would idle. */
async function offerTick(o: ReadonlySet<UpgradeId>): Promise<void> {
  const d = state.dealer;
  const count = offerCount(o);
  if (state.picks.offers.length < count) {
    const exclude = new Set([...seenKeys(state), ...skipped, ...state.picks.offers.map((x) => keyOf(x))]);
    const { list, forced, offline } = await gatherCandidates(d, count - state.picks.offers.length, exclude);
    const ranked = [...(forced ? [plainRanked(forced)] : []), ...rank(d, list)];
    for (const r of ranked)
      if (state.picks.offers.length < count)
        state.picks.offers.push({ ...r.candidate, score: r.score, prior: r.prior, bucket: r.bucket, at: now() });
    state.picks.offers.sort((a, b) => Number(b.retake) - Number(a.retake) || b.score - a.score);
    if (!ranked.length) pauseDealing(offline);
    persist();
  }
  if (state.picks.offers.length && autoTakes(o)) await takeOffer(state.picks.offers[0], true);
}

/** Whether an offer is still as it was, from GET /api/problems just before it is taken. */
function offerStands(info: ProblemInfo | null, x: Offer): boolean {
  if (!info) return false;
  if (x.tier === "open" && !x.retake) return openDealable(info);
  return contestedDealable(info, x);
}

/** Takes an offer into the queue (the player's pick, or Auto-advance's). */
async function takeOffer(x: Offer, auto = false): Promise<void> {
  if (!offerAllowed(owned(), x)) {
    state.picks.offers = state.picks.offers.filter((y) => y !== x);
    say(`${problemTitle(x)} is no longer within your reach, filters or rule; the offer is gone.`);
    persist();
    return;
  }
  if (!mayDeal()) {
    say(`Every slot is full: the next one frees after ${evals(evalsToDeal())}, or drop a problem.`);
    return;
  }
  const info = await api.getProblem(x.N, x.M, x.P);
  if (!info) {
    pauseDealing(true);
    say("The server cannot be reached; the offer stays until it can be checked.");
    return;
  }
  state.picks.offers = state.picks.offers.filter((y) => y !== x);
  const title = problemTitle(x);
  if (!offerStands(info, x)) {
    skipped.add(keyOf(x));
    log(state, now(), `${title} changed since it was offered (someone took it, or its record moved); it is gone.`);
    persist();
    return;
  }
  const p = await materialize(x);
  if (!p || problem(state, p.key)) {
    skipped.add(keyOf(x));
    log(state, now(), `${title} could not be loaded; it is gone.`);
    persist();
    return;
  }
  dealt(p, x, x.retake);
  if (!auto) {
    state.focus = p.key;
    showFocus();
  }
  say(`${auto ? "Auto-advance took" : "Taken"}: ${title}.`);
}

async function onTakeOffer(key: string): Promise<void> {
  const x = state.picks.offers.find((y) => keyOf(y) === key);
  if (!x || dealing || !ownsGame) return;
  dealing = true;
  try {
    await takeOffer(x);
  } finally {
    dealing = false;
    render();
    kickLanes();
  }
}

/** Evaluations until the next deal (0: one is due). */
function evalsToDeal(): number {
  const o = owned();
  return evalsToNextDeal(state.dealer, queueSize(o), state.stats.evaluations, evalsPerClick(o));
}

// ---------- records held: live leader changes ----------

/**
 * A leader read from the server: settles a send whose answer was lost (its points confirmed, as its
 * answer would have) and tells the player when a record of theirs was beaten.
 */
function noteLeader(p: ProblemState | PastProblem, leader: Leader | null): void {
  const r = applyLeader(p, leader, state, now());
  if (r.reconciled && leader) {
    reveal(state, "points", "upgrades");
    log(
      state,
      now(),
      `Verified: ${show6(leader.score)} is the record for ${problemTitle(p)}` +
        `${r.confirmed > 0 ? ` (${fmtRP(r.confirmed)} RP confirmed)` : ""}; its answer had not arrived.`,
    );
  } else if (r.lost) {
    // Retake: a record lost after it left the queue is offered again first
    const retake = owned().has("retake") && !problem(state, p.key);
    if (retake) addRetake(state.picks, p.key);
    log(
      state,
      now(),
      `Your record on ${problemTitle(p)} was beaten${leader ? `: ${show6(leader.score)} by ${leader.name}` : ""}.` +
        (retake ? " It will be offered again first." : ""),
    );
  }
}

function onLeaderEvent(e: LeaderboardEvent): void {
  const key = keyOf(e);
  // our own entry, announced before its answer arrives; a rival's is seen in that answer instead
  if (!ownsGame || inFlight.has(key)) return;
  const target = problem(state, key) ?? state.past.find((p) => p.key === key);
  if (!target) return;
  noteLeader(target, { score: e.score, name: e.name, id: e.id });
  persist();
  render();
}
function listen(): void {
  try {
    const source = new EventSource("/api/events");
    source.addEventListener("leaderboard", (e) => {
      try {
        onLeaderEvent(JSON.parse((e as MessageEvent).data));
      } catch {
        // a malformed event is ignored
      }
    });
  } catch {
    // no live updates: records held are checked when the game next looks at each problem
  }
}

/**
 * When the page opens: settles sends whose answer was lost (a reload during a POST), then checks the
 * records held, one GET a second.
 */
async function refreshHeld(): Promise<void> {
  const check = [
    ...state.queue.filter((p) => p.sending !== null),
    ...[...state.queue, ...state.past].filter((p) => p.ourId !== null && !("sending" in p && p.sending)).slice(-30),
  ];
  for (const p of check) {
    const info = await api.getProblem(p.N, p.M, p.P);
    if (!info) return;
    if (inFlight.has(p.key)) continue;
    const leader = info.site_best
      ? { score: info.site_best.score, name: info.site_best.name, id: info.site_best.id }
      : null;
    noteLeader(p, leader);
    payRent(p);
    persist();
    render();
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// ---------- rent: one record checked at a time ----------

let rentChecking = false;
let rentCheckedAt = 0;

/** A check found the record still ours (or not): pays the rent it is owed since its last check. */
function payRent(p: ProblemState | PastProblem): void {
  if (settleRent(state, owned(), p, now()) > 0) reveal(state, "points", "upgrades");
}

/** With Rent: the record checked longest ago is checked, at most one every 10 s. */
async function rentTick(): Promise<void> {
  const o = owned();
  if (!ownsGame || rentChecking || now() - rentCheckedAt < RENT_CHECK_MS) return;
  tidyRent(state, o, now());
  const p = nextRentCheck(state, o, now());
  if (!p || inFlight.has(p.key) || ("sending" in p && p.sending)) return;
  rentChecking = true;
  rentCheckedAt = now();
  try {
    const info = await api.getProblem(p.N, p.M, p.P);
    if (!info || inFlight.has(p.key) || !ownsGame) return;
    const leader = info.site_best
      ? { score: info.site_best.score, name: info.site_best.name, id: info.site_best.id }
      : null;
    noteLeader(p, leader);
    payRent(p);
    persist();
  } finally {
    rentChecking = false;
  }
}

// ---------- rendering ----------

let renderFrame = 0;
function scheduleRender(): void {
  if (renderFrame) return;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = 0;
    render();
  });
}

function text(id: string, value: string): void {
  const el = $(id);
  if (el.textContent !== value) el.textContent = value;
}
function show(id: string, visible: boolean): void {
  const el = $(id);
  if (el.hidden === visible) el.hidden = !visible;
}

function render(): void {
  const s = state;
  const o = owned();
  const p = focused();
  ensureLanes();
  showFocus();

  // reveals: a panel once shown stays
  if (s.queue.some((q) => q.phase !== "bare") || s.past.length) reveal(s, "score");
  if (s.consent || s.stats.firstRecords || s.queue.some((q) => q.phase === "ready" && q.tier === "open"))
    reveal(s, "consent", "log");
  if (s.rpEarned > 0) reveal(s, "points", "upgrades");
  if (queueSize(o) > 1) reveal(s, "queue");
  if (o.has("auto1") || o.has("lanes2")) reveal(s, "lanes");

  // totals
  show("t-bar", revealed(s, "points"));
  text("t-bar-rp", fmtRP(s.rp));
  text("t-bar-earned", fmtRP(s.rpEarned));
  text("t-bar-held", fmtInt(recordsHeld(s)));
  text("t-bar-evals", fmtInt(s.stats.evaluations));
  text("t-bar-cpu", fmtCompute(s.stats.computeMs));
  const rate = autoPerSecond(o);
  show("t-bar-auto-box", rate !== null);
  text("t-bar-auto", rate !== null && s.settings.auto ? fmtRate(rate * laneCount(o)) : "off");
  show("t-bar-bank-box", rate !== null);
  text("t-bar-bank", fmtInt(Math.floor(s.bank)));
  show("t-bar-lanes-box", o.has("lanes2"));
  text("t-bar-lanes", `${laneCount(o)}`);

  // hold note
  const hold = holdReason();
  const auto = s.settings.auto && rate !== null;
  text(
    "t-hold",
    auto && hold === "hidden"
      ? "Auto-eval is banking while the tab is hidden"
      : auto && hold === "battery"
        ? "Auto-eval is banking: on battery power (allow it in Settings)"
        : "",
  );

  renderProblem(p);
  renderToolbar(p, o);
  renderScore(p, o);
  renderConsent();
  renderPoints();
  renderUpgrades(o);
  renderQueue(o);
  renderLanes(o);
  renderRuns(o);
  renderLog();
  show("t-bg-box", o.has("continuous"));
  $<HTMLInputElement>("t-bg").checked = s.settings.background && o.has("continuous");
  $<HTMLInputElement>("t-battery").checked = s.settings.battery;
  renderStanding(o);
  renderRecords(o);
}

function renderProblem(p: ProblemState | undefined): void {
  const s = state;
  text("t-held", fmtInt(recordsHeld(s)));
  if (!p) {
    if (picking(owned()) && s.picks.offers.length) text("t-title", "Pick a problem from the offers in the queue.");
    else if (!dealing && now() >= dealPausedUntil) text("t-title", "Dealing a problem…");
    text("t-problem-note", "");
    show("t-next", false);
    return;
  }
  text("t-title", problemTitle(p));
  let note: string;
  const seeds = seedsPerProblem(owned());
  if (p.closed) note = "Closed: the server takes no more entries for this problem.";
  else if (p.leaving) note = "Sending your best before it leaves the queue…";
  else if (spent(p, seeds)) note = spentText(p);
  else if (p.ourId !== null)
    note =
      `You hold this record: ${show6(p.verified!)}.` +
      (p.published !== null && p.verified! > p.published
        ? ` The published value is still ahead: below ${show6(p.published)} pays ${CONTEST.published}×.`
        : "");
  else if (p.tier === "published")
    note =
      `Published value: beat ${show6(p.published!)} for ${CONTEST.published}× the points; a record below it waits for an administrator's review.` +
      (p.leader ? ` Site record: ${show6(p.leader.score)} by ${p.leader.name}.` : "");
  else if (p.leader && p.tier !== "open" && !p.run)
    note = `${TIER_LABEL[p.tier][0].toUpperCase()}${TIER_LABEL[p.tier].slice(1)}: ${show6(p.leader.score)} by ${p.leader.name}, ${fmtPct(gapOf(p.N, p.M, p.P, p.leader.score))} above the area bound. Contest weight ${CONTEST[p.tier]}.`;
  else if (p.leader) note = `Record: ${show6(p.leader.score)} by ${p.leader.name}.`;
  else if (p.phase === "ready") note = "Your record has not been sent yet.";
  else note = "No record exists. Any valid packing is a new record.";
  text("t-problem-note", note);
  // before the queue, one problem at a time: the next one is earned by evaluations (or this one is spent)
  const single = queueSize(owned()) <= 1;
  show("t-next", single && evolvable(p));
  if (single && evolvable(p)) {
    const left = evalsToDeal();
    const ready = left === 0 || spent(p, seeds);
    $<HTMLButtonElement>("t-next").disabled = !ready || dealing;
    text("t-next", ready ? "Next problem" : `Next problem after ${evals(left)}`);
  }
}

function renderToolbar(p: ProblemState | undefined, o: ReadonlySet<UpgradeId>): void {
  const lv = p ? laneOn(p.key) : undefined;
  const canEvolve = !!p && evolvable(p);
  const seeds = seedsPerProblem(o);
  show("t-loadall", !canEvolve);
  $<HTMLButtonElement>("t-loadall").disabled = !p || p.phase !== "bare" || loading.has(p.key);
  show("t-compact", !canEvolve);
  $<HTMLButtonElement>("t-compact").disabled = !p || p.phase !== "loaded" || !!p.run || !!lv;
  show("t-evolve", canEvolve);
  const k = evalsPerClick(o);
  text("t-evolve", k === 1 ? "Evolve" : `Evolve ×${k}`);
  $<HTMLButtonElement>("t-evolve").disabled = !canEvolve || !!p?.leaving || !!p?.closed || (!!p && spent(p, seeds));
  $("t-evolve").title = `Runs ${evals(k)} of the open solver run on this board`;
  // the method select: the owned methods (those the cycle's rule refuses greyed), and "Auto" with Method match
  const ms = methods(o);
  const canAuto = o.has("methodMatch") || o.has("autoTune");
  const values = [...(canAuto ? ["auto"] : []), ...ms];
  show("t-method-box", values.length > 1);
  const select = $<HTMLSelectElement>("t-method");
  const optionsSig = values
    .map((v) => `${v}:${v === "auto" || ruleAllowsMethod(state.standing, v as EvolveMethod)}`)
    .join(",");
  if (select.dataset.sig !== optionsSig) {
    select.dataset.sig = optionsSig;
    select.replaceChildren(
      ...values.map((m) => {
        const opt = document.createElement("option");
        opt.value = m;
        opt.textContent =
          m === "auto" ? (o.has("autoTune") ? "Auto (methods and settings)" : "Auto (method match)") : m;
        opt.disabled = m !== "auto" && !ruleAllowsMethod(state.standing, m as EvolveMethod);
        return opt;
      }),
    );
  }
  if (!ms.includes(state.settings.method)) state.settings.method = "mc_compress";
  const selected = canAuto && state.runplan.auto ? "auto" : state.settings.method;
  if (select.value !== selected) select.value = selected;
  select.title = piped(o)
    ? "The pipeline chooses each new run's method (Runs panel); Auto still chooses its setting with Auto-tune"
    : canAuto && state.runplan.auto
      ? "The game chooses each new run's method from what has paid on problems like this one"
      : "The method of the next run";
  show("t-auto", autoPerSecond(o) !== null);
  const autoBtn = $<HTMLButtonElement>("t-auto");
  autoBtn.setAttribute("aria-pressed", String(state.settings.auto));
  text("t-auto", state.settings.auto ? "Auto-eval: on" : "Auto-eval: off");
  $<HTMLButtonElement>("t-stop").disabled = !lanes.some((l) => l.jobs.length) && !state.settings.auto;
  let info = "";
  const run = lv?.run && p && lv.run.key === p.key ? lv.run : null;
  if (p && run) {
    const going = lv?.progress?.evaluations ?? run.evaluations;
    const how = run.mode === "auto" ? " (auto)" : run.mode === "pipeline" ? " (pipeline)" : "";
    info = `${run.method}${run.level ? ` · setting ${run.level}` : ""}${how}${o.has("seeds") ? ` · seed ${run.seed}` : ""} · run at ${evals(going)}`;
    const queued = lv!.jobs.filter((j) => j.click).reduce((t, j) => t + j.evals, 0);
    if (queued) info += ` · ${evals(queued)} queued`;
    if (o.has("seeds")) info += ` · ${seedsText(p, seeds)}`;
  } else if (p) {
    info = p.phase === "bare" ? "0 pieces placed" : `${p.P} pieces placed`;
    if (lv?.current?.compact) info = `Compact · mc_compress · ${evals(lv.progress?.evaluations ?? 0)}`;
    if (o.has("seeds") && p.runs) info += ` · ${seedsText(p, seeds)}`;
  }
  text("t-runinfo", info);
  const b = banner && p && banner.key === p.key ? banner.text : "";
  show("t-banner", !!b);
  const el = $("t-banner");
  if (b && el.dataset.text !== b) {
    el.dataset.text = b;
    const [head, ...rest] = b.split(" · ");
    const strong = document.createElement("strong");
    strong.textContent = head;
    el.replaceChildren(strong, rest.length ? ` · ${rest.join(" · ")}` : "");
  }
}

function renderScore(p: ProblemState | undefined, o: ReadonlySet<UpgradeId>): void {
  show("t-score", revealed(state, "score") && !!p);
  if (!p) return;
  text("t-side-label", p.M === 0 ? "Container radius r" : "Container side s");
  const b = areaLowerBound(p.N, p.M, p.P);
  text("t-bound", show6(b));
  if (p.best === null || p.phase === "bare") {
    for (const id of ["t-side", "t-delta", "t-gap", "t-density"]) text(id, "—");
  } else {
    text("t-side", show6(p.best));
    text("t-gap", fmtPct(p.best / b - 1));
    text("t-density", density(p, p.best).toFixed(3));
    const c = lastChange.get(p.key);
    const delta = $("t-delta");
    if (c && c.improved && c.before !== null && c.after !== null) {
      const chip = document.createElement("span");
      chip.className = "chip good";
      chip.textContent = fmtChange(c.before, c.after) + (c.points ? ` · +${fmtRP(c.points.total)} RP` : "");
      if (delta.textContent !== chip.textContent) delta.replaceChildren(chip);
    } else text("t-delta", c ? "no change" : "—");
  }
  text(
    "t-record",
    p.ourId !== null
      ? `yours, ${show6(p.verified!)}`
      : p.leader
        ? `${show6(p.leader.score)} by ${p.leader.name}`
        : "none yet",
  );
  // the trace: the side after each improvement on this problem, by evaluations run here
  const svg = $("t-trace") as unknown as SVGSVGElement;
  const tr = p.trace;
  const visible = o.has("trace") && tr.length >= 2;
  svg.toggleAttribute("hidden", !visible);
  if (!visible) return;
  const sig = `${p.key}|${tr.length}|${tr[tr.length - 1][1]}`;
  if (svg.dataset.sig === sig) return;
  svg.dataset.sig = sig;
  const sides = tr.map(([, v]) => v);
  const high = Math.max(...sides),
    low = Math.min(...sides);
  const range = high - low || high * 1e-6;
  const e0 = tr[0][0],
    e1 = tr[tr.length - 1][0];
  const span = e1 - e0 || 1;
  const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  line.setAttribute(
    "points",
    tr
      .map(([e, v]) => `${(10 + (280 * (e - e0)) / span).toFixed(1)},${(10 + (65 * (high - v)) / range).toFixed(2)}`)
      .join(" "),
  );
  const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
  label.setAttribute("x", "10");
  label.setAttribute("y", "92");
  label.textContent = `${show6(sides[0])} → ${show6(sides[sides.length - 1])} · ${evals(e1 - e0)}`;
  svg.replaceChildren(line, label);
  svg.setAttribute(
    "aria-label",
    `Side after each improvement, from ${show6(sides[0])} to ${show6(sides[sides.length - 1])} over ${evals(e1 - e0)}`,
  );
}

function renderConsent(): void {
  show("t-consent", revealed(state, "consent"));
  const name = $<HTMLInputElement>("t-name");
  const agree = $<HTMLInputElement>("t-agree");
  if (document.activeElement !== name && !name.dataset.edited) name.value = state.name;
  if (document.activeElement !== agree && !agree.dataset.edited) agree.checked = state.consent;
  text(
    "t-consent-note",
    state.consent
      ? `Your records go to PolyPack as “${state.name}”, at most one per problem a minute and six a minute in all. Untick and save to stop.`
      : state.stats.submissions
        ? "Sending is off. Your records stay here until you send them, and earn no points meanwhile."
        : "Nothing has been sent yet. Records earn points once they go to PolyPack under your name.",
  );
}

function renderPoints(): void {
  show("t-points", revealed(state, "points"));
  text("t-rp", fmtRP(state.rp));
  text("t-earned", fmtRP(state.rpEarned));
  text("t-evals", fmtInt(state.stats.evaluations));
  text("t-clicks", fmtInt(state.stats.clicks));
  const waiting = unconfirmedPoints(state);
  let unpaid = 0;
  if (!state.consent) for (const q of state.queue) unpaid += pendingPoints(q, state.name, state)?.total ?? 0;
  text(
    "t-pending",
    !state.consent && unpaid > 0
      ? `${fmtRP(unpaid)} (needs your name)`
      : waiting > 0
        ? `${fmtRP(waiting)} (sent within the minute)`
        : "—",
  );
}

const shop = new ShopRenderer($("t-cards"), $("t-shop-summary"), (id) => onBuy(id));
function renderUpgrades(o: Owned): void {
  show("t-upgrades", revealed(state, "upgrades"));
  if (!revealed(state, "upgrades")) return;
  const funds = { rp: state.rp, standing: state.standing.points };
  shop.render(shopView(o, funds), funds);
}

function onBuy(id: UpgradeId): void {
  accrueBank();
  // a lane past the CPU's cores would add nothing
  if (id === "lanesx" && lanesMaxed(owned())) return;
  if (!buy(state, id)) return;
  const u = upgrade(id);
  const l = u.levels ? ` (level ${level(owned(), id)})` : "";
  log(state, now(), `Bought ${u.name}${l}: ${u.effect}.`);
  say(`${u.name}${l}: ${u.effect}.`);
  ensureLanes();
  persist();
  render();
  void dealTick();
  kickLanes();
}

let queueSig = "";
function renderQueue(o: ReadonlySet<UpgradeId>): void {
  show("t-queue", revealed(state, "queue"));
  if (!revealed(state, "queue")) return;
  const slots = queueSize(o);
  text("t-queue-heading", `Queue · ${slots} slots`);
  const list = $("t-queue-list");
  const busy = new Set(lanes.flatMap(laneKeys));
  const seeds = seedsPerProblem(o);
  const sig = state.queue
    .map(
      (p) =>
        `${p.key}|${p.phase}|${p.best}|${p.ourId}|${p.leader?.score}|${p.leaving}|${busy.has(p.key)}|${p.key === state.focus}|${spent(p, seeds)}`,
    )
    .join(";");
  if (sig !== queueSig) {
    queueSig = sig;
    list.replaceChildren(
      ...state.queue.map((p) => {
        const li = document.createElement("li");
        if (p.key === state.focus) li.className = "focus";
        const gap =
          p.best !== null && p.phase !== "bare" ? ` · gap ${fmtPct(p.best / areaLowerBound(p.N, p.M, p.P) - 1)}` : "";
        const status = p.leaving
          ? " · leaving"
          : p.ourId !== null
            ? " · yours"
            : p.tier === "published"
              ? " · published value"
              : p.tier !== "open"
                ? ` · ${TIER_LABEL[p.tier]} by ${p.leader?.name ?? "?"}`
                : p.phase === "bare"
                  ? " · no record yet"
                  : "";
        li.append(
          `${problemTitle(p)}${gap}${status}${spent(p, seeds) ? " · seeds spent" : ""}${busy.has(p.key) ? " · running" : ""}`,
        );
        const actions = document.createElement("span");
        actions.className = "t-q-actions";
        if (p.key !== state.focus && !p.leaving) {
          const showBtn = document.createElement("button");
          showBtn.textContent = "Show";
          showBtn.setAttribute("aria-label", `Show ${problemTitle(p)} on the board`);
          showBtn.addEventListener("click", () => {
            state.focus = p.key;
            persist();
            showFocus();
            render();
          });
          actions.append(showBtn);
        }
        if (!p.leaving) {
          const dropBtn = document.createElement("button");
          dropBtn.textContent = "Drop";
          dropBtn.setAttribute("aria-label", `Drop ${problemTitle(p)} from the queue`);
          dropBtn.addEventListener("click", () => onDrop(p.key));
          actions.append(dropBtn);
        }
        li.append(actions);
        return li;
      }),
    );
  }
  const free = slots - slotted(state).length;
  const left = evalsToDeal();
  const offers = state.picks.offers.length;
  text(
    "t-deal",
    picking(o)
      ? offers && mayDeal()
        ? `Pick a problem: ${offers} offered below.`
        : offers
          ? `The offers wait for a free slot: ${free > 0 ? `the next one after ${evals(left)}` : "every slot is full; drop a problem to take one"}.`
          : free > 0 && left > 0
            ? `New offers come after ${evals(left)} more.`
            : free > 0
              ? "Drawing offers…"
              : "Every slot is full. Drop a problem to take a new one."
      : free > 0
        ? left === 0
          ? "Dealing a problem…"
          : `The next problem is dealt after ${evals(left)} more.`
        : `Every slot is full. Each slot earns a new problem per 300 clicks' worth of evaluations; drop a problem to take it.`,
  );
  renderOffers(o);
  renderFilters(o);
}

let offersSig = "";
/** Your pick: the offers, best first, each with what it is expected to pay and a Take button. */
function renderOffers(o: ReadonlySet<UpgradeId>): void {
  const box = $("t-offers");
  show("t-offers", picking(o) && state.picks.offers.length > 0);
  if (box.hidden) return;
  const due = mayDeal();
  const sig = `${state.picks.offers.map((x) => `${keyOf(x)}|${x.score}`).join(";")}|${due}|${dealing}`;
  if (sig === offersSig) return;
  offersSig = sig;
  $("t-offer-list").replaceChildren(
    ...state.picks.offers.map((x, i) => {
      const li = document.createElement("li");
      li.className = "t-offer";
      const title = problemTitle(x);
      const h = document.createElement("strong");
      h.textContent = title;
      const what =
        x.tier === "open"
          ? "open: any packing is a record"
          : x.tier === "published"
            ? `published value ${x.source ?? ""}: beat ${show6(x.target!)}`.replace(/\s+:/, ":")
            : `${TIER_LABEL[x.tier]} ${show6(x.leader!.score)} by ${x.leader!.name}, gap ${fmtPct(gapOf(x.N, x.M, x.P, x.leader!.score))}` +
              (x.weakness !== null && x.weakness > 0 ? `, ${fmtPct(x.weakness)} weaker than its neighbours` : "");
      const meta = document.createElement("span");
      meta.className = "note";
      // what the dealer knows, not a promise: the ranking itself is an estimate
      meta.textContent =
        `${i === 0 ? "Best offer · " : ""}${x.retake ? "Retake · " : ""}${what} · contest weight ${CONTEST[x.tier]}` +
        ` · about ${msPerEval(x.N + x.M + x.P).toFixed(1)} ms an evaluation`;
      const btn = document.createElement("button");
      btn.textContent = "Take";
      btn.disabled = !due || dealing;
      btn.setAttribute("aria-label", `Take ${title}`);
      btn.addEventListener("click", () => void onTakeOffer(keyOf(x)));
      li.append(h, meta, btn);
      return li;
    }),
  );
}

let filtersShown = "";
/** Dealer filters: the form shows the saved filters (until the player edits it). */
function renderFilters(o: ReadonlySet<UpgradeId>): void {
  show("t-filters", o.has("filters"));
  if (!o.has("filters")) return;
  const f = state.picks.filters;
  const sig = JSON.stringify(f);
  if (sig === filtersShown) return;
  filtersShown = sig;
  $<HTMLInputElement>("t-f-pieces").value = formatShapes(f?.pieces ?? null);
  $<HTMLInputElement>("t-f-containers").value = formatShapes(f?.containers ?? null);
  $<HTMLInputElement>("t-f-minp").value = String(f?.minP ?? 1);
  $<HTMLInputElement>("t-f-maxp").value = String(f?.maxP ?? 500);
  for (const t of TIERS) $<HTMLInputElement>(`t-f-tier-${t}`).checked = !f?.tiers || f.tiers.includes(t);
}

function onSaveFilters(e: Event): void {
  e.preventDefault();
  const pieces = parseShapes($<HTMLInputElement>("t-f-pieces").value);
  const containers = parseShapes($<HTMLInputElement>("t-f-containers").value);
  for (const [label, v] of [
    ["Piece shapes", pieces],
    ["Containers", containers],
  ] as const)
    if (v && !Array.isArray(v)) {
      text("t-filter-note", `${label}: ${v.error}.`);
      return;
    }
  const minP = Math.round(Number($<HTMLInputElement>("t-f-minp").value) || 1);
  const maxP = Math.round(Number($<HTMLInputElement>("t-f-maxp").value) || 500);
  if (!(minP >= 1 && maxP <= 500 && minP <= maxP)) {
    text("t-filter-note", "Pieces: a range from 1 to 500, the first no larger than the second.");
    return;
  }
  const tiers = TIERS.filter((t) => $<HTMLInputElement>(`t-f-tier-${t}`).checked);
  if (!tiers.length) {
    text("t-filter-note", "Keep at least one tier.");
    return;
  }
  const filters = {
    pieces: pieces as number[] | null,
    containers: containers as number[] | null,
    minP,
    maxP,
    tiers: tiers.length === TIERS.length ? null : tiers,
  };
  const none = !filters.pieces && !filters.containers && minP === 1 && maxP === 500 && !filters.tiers;
  state.picks.filters = none ? null : filters;
  // offers drawn under the old filters make way for new ones
  state.picks.offers = state.picks.offers.filter((x) => passes(state.picks.filters, x));
  filtersShown = "";
  text(
    "t-filter-note",
    none
      ? "No filters: the dealer draws from everything you have reached."
      : "Filters saved. The dealer draws only what they allow; if nothing fits, nothing is dealt.",
  );
  log(state, now(), none ? "Dealer filters cleared." : "Dealer filters saved.");
  persist();
  render();
  void dealTick();
}

function onDrop(key: string): void {
  const p = problem(state, key);
  if (!p) return;
  const unsent = p.phase === "ready" && !!p.run && hasUnsent(p) && !state.consent;
  if (unsent && !confirm(`Your best on ${problemTitle(p)} has not been sent. Drop it anyway?`)) return;
  for (const lv of lanes) {
    lv.jobs = lv.jobs.filter((j) => j.key !== key);
    if (lv.run?.key === key) {
      lv.run = null;
      void lv.lane.close();
    }
  }
  const left = drop(state, key, now());
  log(state, now(), left ? `Dropped ${problemTitle(p)}.` : `Dropping ${problemTitle(p)} once its best has been sent.`);
  persist();
  showFocus();
  render();
  void submitTick();
  void dealTick();
}

let lanesSig = "";
function renderLanes(o: Owned): void {
  show("t-lanes", revealed(state, "lanes"));
  if (!revealed(state, "lanes")) return;
  text(
    "t-lanes-heading",
    lanes.length > 1 ? `Lanes · ${lanes.length} of at most ${Math.max(2, cores() - 1)} on this CPU` : "Lanes",
  );
  const list = $("t-lane-list");
  const sig = `${lanes.length}`;
  if (sig !== lanesSig) {
    lanesSig = sig;
    list.replaceChildren(
      ...lanes.map(() => {
        const li = document.createElement("li");
        const line = document.createElement("div");
        line.className = "t-lane-line";
        li.append(line);
        return li;
      }),
    );
  }
  const rate = autoPerSecond(o);
  lanes.forEach((lv, i) => {
    const li = list.children[i] as HTMLElement;
    const line = li.querySelector(".t-lane-line") as HTMLElement;
    const q = lv.run ? problem(state, lv.run.key) : undefined;
    let msg: string;
    if (q && lv.run) {
      msg =
        `Lane ${i + 1}: ${problemTitle(q)} · ${lv.run.method}${o.has("seeds") ? ` · seed ${lv.run.seed}` : ""} · ` +
        `run at ${evals(lv.progress?.evaluations ?? lv.run.evaluations)}`;
      if (lv.jobs.length) msg += ` · ${lv.jobs.length} queued`;
    } else msg = `Lane ${i + 1}: no open run`;
    if (rate !== null)
      msg += state.settings.auto
        ? holdReason()
          ? " · auto-eval banking"
          : ` · auto-eval ${fmtRate(rate)}`
        : " · auto-eval off";
    if (line.textContent !== msg) line.textContent = msg;
  });
  text(
    "t-bank-note",
    rate === null
      ? ""
      : `Auto-eval's bank: ${evals(Math.floor(state.bank))} waiting to run, at most ${evals(Math.floor(bankCap(o, laneCount(o))))} (${fmtHours(awayHours(o))} of every lane's auto-eval).`,
  );
}

function renderRuns(o: Owned): void {
  const p = focused();
  renderRunsPanel(
    $("t-runs"),
    $("t-runs-body"),
    {
      plan: state.runplan,
      owned: o,
      methods: methods(o),
      allowed: (m) => allowedMethod(o, m),
      focusKind: p ? problemKind(p) : null,
    },
    (next) => {
      state.runplan.pipeline = next;
      persist();
      render();
    },
  );
}

let logSig = "";
function renderLog(): void {
  show("t-events", revealed(state, "log"));
  const lines = state.log.slice(-12).reverse();
  const sig = lines.map((l) => `${l.t}${l.text}`).join("|");
  if (sig === logSig) return;
  logSig = sig;
  $("t-log").replaceChildren(
    ...lines.map((l) => {
      const li = document.createElement("li");
      const d = new Date(l.t);
      li.textContent = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} ${l.text}`;
      return li;
    }),
  );
}

// ---------- standing and records ----------

/** A span of time as the Standing panel shows it: "0:42", "3 h 05 min", "2 d 4 h". */
function fmtSpan(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 60) return `${m}:${String(Math.floor((Math.max(0, ms) % 60_000) / 1000)).padStart(2, "0")}`;
  if (m < 24 * 60) return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
  return `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`;
}
const fmtAgo = (ms: number) => (ms < 60_000 ? "just now" : `${fmtSpan(ms)} ago`);
const titleOf = (key: string) => {
  const k = parseKey(key);
  return k ? problemTitle(k) : key;
};

/** Rebuilds a stats list when its labels change, and updates its values. */
function setStats(id: string, rows: [string, string][]): void {
  const dl = $(id);
  const sig = rows.map(([label]) => label).join("|");
  if (dl.dataset.sig !== sig) {
    dl.dataset.sig = sig;
    dl.replaceChildren(
      ...rows.flatMap(([label]) => {
        const dt = document.createElement("dt");
        dt.textContent = label;
        return [dt, document.createElement("dd")];
      }),
    );
  }
  rows.forEach(([, value], i) => {
    const dd = dl.children[2 * i + 1] as HTMLElement;
    if (dd.textContent !== value) dd.textContent = value;
  });
}

/** Rebuilds a list when its lines change. */
function setLines(id: string, lines: string[]): void {
  const el = $(id);
  const sig = lines.join("\n");
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  el.replaceChildren(
    ...lines.map((line) => {
      const li = document.createElement("li");
      li.textContent = line;
      return li;
    }),
  );
}

let confirmingReset = false;
let rulesSig = "";

function renderStanding(o: Owned): void {
  const st = state.standing;
  markProgress(state, now());
  const visible = o.has("standing");
  show("t-bar-standing-box", visible || st.total > 0);
  text("t-bar-standing", `${fmtInt(st.points)} · ×${standingMultiplier(st).toFixed(1)}`);
  show("t-standing", visible);
  if (!visible) return;
  setStats("t-st-stats", [
    ["Standing to spend", fmtInt(st.points)],
    ["Earned in all", fmtInt(st.total)],
    ["On all points", `×${standingMultiplier(st).toFixed(1)}`],
    [`Cycle ${fmtInt(st.resets + 1)}`, `${fmtRP(st.cycleEarned)} RP in ${fmtSpan(now() - st.cycleStartedAt)}`],
    ["Rule", st.rule ? ruleById(st.rule)!.name : "none"],
  ]);
  // the sense of speed: when this cycle reached each milestone, against the best cycle before
  setLines(
    "t-st-marks",
    MARKS.filter((m) => st.marks[m.id] !== undefined || bestMark(st, m.id) !== null).map((m) => {
      const t = st.marks[m.id];
      const best = bestMark(st, m.id);
      const reached = t === undefined ? "not yet" : t < 1000 ? "at the start" : `in ${fmtSpan(t)}`;
      return `${m.label}: ${reached}${best !== null ? ` · best ${best < 1000 ? "at the start" : fmtSpan(best)}` : ""}`;
    }),
  );
  const pv = resetPreview(state);
  const rule = ruleById(st.rule);
  text(
    "t-st-preview",
    pv.gain > 0
      ? `Reset now for ${fmtInt(pv.gain)} standing${pv.ruleBonus ? `, ${fmtInt(pv.ruleBonus)} of it for finishing under ${rule!.name}` : ""}: all points ×${standingMultiplier(st).toFixed(1)} → ×${(standingMultiplier(st) + 0.1 * pv.gain).toFixed(1)}. The next point comes at ${fmtInt(pv.nextAt)} RP this cycle.`
      : `A reset needs ${fmtInt(RESET_MIN)} RP earned in the cycle and confirmed by the server: ${fmtInt(Math.ceil(pv.short))} to go. It gives √(cycle RP / 250,000) + records held / 50 standing.`,
  );
  const btn = $<HTMLButtonElement>("t-st-reset");
  btn.disabled = pv.gain <= 0 || !ownsGame;
  show("t-st-reset", !confirmingReset);
  show("t-st-confirm", confirmingReset && pv.gain > 0);
  if (confirmingReset) {
    const kept = [
      pv.held === 1 ? "1 record held and its rent" : `${fmtInt(pv.held)} records held and their rent`,
      `collections (+${fmtPct(collectionsBonus(state, o), 0)})`,
      "Standing and every standing upgrade",
      o.has("keepAuto") ? "the auto-eval and away upgrades" : "",
      o.has("keepMethods") ? "your methods" : "",
      o.has("keepBank") ? "auto-eval's bank" : "",
      "the queue, the dealer's learning and every count",
    ].filter(Boolean);
    const next = ruleById(st.nextRule);
    text(
      "t-st-confirm-text",
      `${fmtInt(pv.gain)} standing for ${fmtRP(state.rp)} RP to spend and ${fmtInt(pv.loses.length)} upgrade${pv.loses.length === 1 ? "" : "s"}. ` +
        `Kept: ${kept.join(", ")}. The next cycle begins with ${fmtInt(pv.keeps.length)} upgrades` +
        (next ? ` under the rule ${next.name}: ${next.limit}.` : "."),
    );
  }
  // cycle rules: the next cycle's, chosen here
  show("t-st-rules", o.has("rules"));
  if (o.has("rules")) {
    const select = $<HTMLSelectElement>("t-st-rule");
    const sig = st.rulesDone.join(",");
    if (rulesSig !== sig || !select.options.length) {
      rulesSig = sig;
      select.replaceChildren(
        new Option("No rule", ""),
        ...RULES.map((r) => new Option(`${r.name}${st.rulesDone.includes(r.id) ? " (finished)" : ""}`, r.id)),
      );
    }
    if (select.value !== (st.nextRule ?? "")) select.value = st.nextRule ?? "";
    const chosen = ruleById(st.nextRule);
    text(
      "t-st-rule-note",
      (chosen
        ? `${chosen.name}: ${chosen.limit}. Finish the cycle under it (reach a reset) for half again the standing, at least one more, and for good: ${chosen.reward}.`
        : "A rule limits one cycle; finishing the cycle under it pays extra standing and a reward of its own, for good.") +
        (st.rulesDone.length
          ? ` Finished: ${st.rulesDone.map((id) => `${ruleById(id)!.name} (${ruleById(id)!.reward})`).join("; ")}.`
          : ""),
    );
  }
  // what only standing buys
  const left = UPGRADES.filter((u) => u.currency === "standing" && costOf(o, u.id) !== null);
  text(
    "t-st-only",
    left.length
      ? `Only standing buys: ${left.map((u) => `${u.name} (${fmtInt(costOf(o, u.id)!)})`).join(", ")}. They are in the shop's Standing row and stay through resets.`
      : "You own every standing upgrade.",
  );
  show("t-st-history-box", st.history.length > 0);
  setLines(
    "t-st-history",
    st.history
      .map(
        (h, i) =>
          `Cycle ${i + 1 + Math.max(0, st.resets - st.history.length)}: ${fmtSpan(h.endedAt - h.startedAt)}, ${fmtRP(h.earned)} RP, +${fmtInt(h.gain)} standing${h.rule ? `, under ${ruleById(h.rule)?.name ?? h.rule}` : ""}`,
      )
      .reverse(),
  );
}

function renderRecords(o: Owned): void {
  const rent = o.has("rent");
  const col = o.has("collections");
  show("t-records", rent || col);
  if (!rent && !col) return;
  const rows: [string, string][] = [["Records held", fmtInt(recordsHeld(state))]];
  if (rent) {
    rows.push(["Rent per hour", `${fmtRP(rentRate(state, o))} RP`]);
    rows.push(["Waiting for a check", `about ${fmtRP(rentWaiting(state, o, now()))} RP`]);
    rows.push(["Rent paid", `${fmtRP(state.economy.rentPaid)} RP`]);
  }
  const c = collections(state.economy);
  if (col) rows.push(["Collections", `+${fmtPct(c.bonus, 0)} on all points`]);
  setStats("t-rc-stats", rows);
  const last = state.economy.lastRent;
  text(
    "t-rc-note",
    rent
      ? `Each record you lead is checked in turn, one every 10 s; when it is still yours, the rent since its last check is paid (a week of it at most). A record lost pays nothing for the time since its check.` +
          (last ? ` Last: +${fmtRP(last.rp)} RP on ${titleOf(last.key)}, ${fmtAgo(now() - last.at)}.` : "")
      : "",
  );
  if (!col) {
    setLines("t-rc-sets", []);
    return;
  }
  const lines = [
    `Frontier pairs with a record on all 9 piece counts: ${fmtInt(c.pairs)} (+2 % each)` +
      (c.nearest.length
        ? `. Nearest: ${c.nearest.map((n) => `${problemTitle({ N: n.N, M: n.M, P: 0 }).replace(/, 0 pieces$/, "")} ${n.have} of 9`).join("; ")}`
        : ""),
    `Piece shapes at 10, 30 and 100 records: ${fmtInt(c.milestones)} milestones (+1 % each)` +
      (c.shapes.length
        ? `. ${c.shapes
            .slice(0, 3)
            .map((x) => `${shapeName(x.N, true)} ${fmtInt(x.count)}`)
            .join("; ")}`
        : ""),
    `First records by tier: ${c.tiers.length ? c.tiers.join(", ") : "none yet"} (+5 % each)`,
  ];
  setLines("t-rc-sets", lines);
}

/** Resets the cycle for standing: lanes stop and start again with the next cycle's tree. */
async function doReset(): Promise<void> {
  confirmingReset = false;
  if (!ownsGame || resetPreview(state).gain <= 0) return render();
  for (const l of lanes) {
    l.jobs = [];
    l.lane.terminate();
  }
  lanes.length = 0;
  // let the stopped jobs settle first (an auto-eval job hands its evaluations back to the bank)
  await new Promise((r) => setTimeout(r, 0));
  const rule = ruleById(state.standing.rule);
  const gain = resetCycle(state, now());
  ensureLanes();
  lastChange.clear();
  banner = null;
  if (gain > 0) {
    const st = state.standing;
    const next = ruleById(st.rule);
    log(
      state,
      now(),
      `Reset for ${fmtInt(gain)} standing${rule ? `, the cycle finished under ${rule.name} (for good: ${rule.reward})` : ""}. All points ×${standingMultiplier(st).toFixed(1)}.`,
    );
    say(
      `Cycle ${fmtInt(st.resets + 1)} begins with ${fmtInt(state.owned.length)} upgrades${next ? `, under the rule ${next.name}: ${next.limit}` : ""}. Your records stand and keep paying.`,
    );
  }
  saveNow();
  showFocus(true);
  render();
  kickLanes();
  void dealTick();
}

// ---------- controls ----------

$("t-filter-form").addEventListener("submit", onSaveFilters);
$("t-f-clear").addEventListener("click", () => {
  $<HTMLInputElement>("t-f-pieces").value = "";
  $<HTMLInputElement>("t-f-containers").value = "";
  $<HTMLInputElement>("t-f-minp").value = "1";
  $<HTMLInputElement>("t-f-maxp").value = "500";
  for (const t of TIERS) $<HTMLInputElement>(`t-f-tier-${t}`).checked = true;
  $<HTMLFormElement>("t-filter-form").requestSubmit();
});
$("t-loadall").addEventListener("click", () => {
  const p = focused();
  if (p) void loadAll(p).then(() => showFocus());
});
$("t-compact").addEventListener("click", () => press(true));
$("t-evolve").addEventListener("click", () => press(false));
$("t-method").addEventListener("change", () => {
  const o = owned();
  const v = $<HTMLSelectElement>("t-method").value;
  if (v === "auto") {
    if (o.has("methodMatch") || o.has("autoTune")) state.runplan.auto = true;
  } else if (methods(o).includes(v as EvolveMethod)) {
    state.settings.method = v as EvolveMethod;
    state.runplan.auto = false;
  }
  persist();
  render();
});
$("t-auto").addEventListener("click", () => {
  const o = owned();
  if (autoPerSecond(o) === null) return;
  // earnings start now: nothing is owed for the time it was off
  accrueBank();
  state.settings.auto = !state.settings.auto;
  const banked = Math.floor(state.bank);
  say(
    state.settings.auto
      ? `Auto-eval on: ${fmtRate((autoPerSecond(o) ?? 0) * laneCount(o))} on the problem on the board, beside your clicks.` +
          (banked ? ` ${evals(banked)} banked while it was away run first.` : "")
      : "Auto-eval off. What it has banked stays.",
  );
  persist();
  render();
  kickLanes();
});
$("t-stop").addEventListener("click", stopAll);
$("t-next").addEventListener("click", () => {
  const p = focused();
  if (!p || (evalsToDeal() > 0 && !spent(p, seedsPerProblem(owned())))) return;
  onDrop(p.key);
});
for (const id of ["t-name", "t-agree"]) $(id).addEventListener("input", () => ($(id).dataset.edited = "1"));
$("t-consent-form").addEventListener("submit", (e) => {
  e.preventDefault();
  // the name as the server will store it: what is shown, sent and compared is the same
  const typed = $<HTMLInputElement>("t-name").value;
  const name = sanitizeName(typed);
  const agree = $<HTMLInputElement>("t-agree").checked;
  if (agree && !name) {
    say(
      typed.trim()
        ? "That name is empty once cleaned as PolyPack stores names (no angle brackets or control characters). Choose another."
        : "Enter a display name first: records go to PolyPack under it.",
    );
    text("t-consent-note", "No name, so nothing is sent.");
    $("t-name").focus();
    return;
  }
  delete $("t-name").dataset.edited;
  delete $("t-agree").dataset.edited;
  const withdrawn = state.consent && !agree ? withdrawConsent(state) : 0;
  state.name = name;
  state.consent = agree;
  // what the boards improved before there was a name pays now, one event per problem
  const paid = agree ? payAll(state) : 0;
  say(
    agree
      ? `Your records will be sent to PolyPack as “${name}”.${paid > 0 ? ` +${fmtRP(paid)} RP for your records so far.` : ""}`
      : `Nothing will be sent. Your records stay in this browser.${withdrawn > 0 ? ` ${fmtRP(withdrawn)} RP not yet confirmed by the server were taken back; they pay again when you send.` : ""}`,
  );
  log(state, now(), agree ? `Sending records as “${name}”.` : "Sending is off.");
  persist();
  render();
  void submitTick();
});
$("t-bg").addEventListener("change", () => {
  state.settings.background = $<HTMLInputElement>("t-bg").checked;
  persist();
  applyHold();
});
$("t-battery").addEventListener("change", () => {
  state.settings.battery = $<HTMLInputElement>("t-battery").checked;
  persist();
  applyHold();
});
$("t-st-reset").addEventListener("click", () => {
  if (resetPreview(state).gain <= 0) return;
  confirmingReset = true;
  render();
  $("t-st-no").focus();
});
$("t-st-no").addEventListener("click", () => {
  confirmingReset = false;
  render();
});
$("t-st-yes").addEventListener("click", () => void doReset());
$("t-st-rule").addEventListener("change", () => {
  const v = $<HTMLSelectElement>("t-st-rule").value;
  state.standing.nextRule = ruleById(v) ? v : null;
  persist();
  render();
});
$("t-export").addEventListener("click", async () => {
  const area = $<HTMLTextAreaElement>("t-save-text");
  area.value = await exportString(state);
  area.select();
  try {
    await navigator.clipboard.writeText(area.value);
    text("t-save-note", "Save string copied to the clipboard.");
  } catch {
    text("t-save-note", "Copy the save string above.");
  }
});
$("t-import").addEventListener("click", async () => {
  const r = await importString($<HTMLTextAreaElement>("t-save-text").value, now());
  if (!r.ok) {
    text("t-save-note", `Import failed: ${r.error}.`);
    return;
  }
  if (!confirm("Replace this game with the imported save?")) return;
  for (const l of lanes) l.lane.terminate();
  lanes.length = 0;
  state = r.state;
  syncEconomy(state);
  welcomeBack(state);
  lastChange.clear();
  banner = null;
  savesDisabled = false;
  ensureLanes();
  saveNow();
  showFocus(true);
  text("t-save-note", "Save imported.");
  render();
});

// ---------- start ----------

declare global {
  interface Window {
    tighter: unknown;
  }
}
// A handle for the browser console and the end-to-end tests.
window.tighter = {
  get state() {
    return state;
  },
  board,
  view,
  dev: import.meta.env.DEV,
  /** Moves game time forward (development builds only), e.g. past the submission minute. */
  skipAhead(ms: number) {
    if (import.meta.env.DEV) clockOffset += ms;
  },
  /** Lanes with work queued or going (for the tests: wait until every click has run). */
  get busy() {
    return lanes.some((l) => l.pumping || l.jobs.length);
  },
};

if (startNote) say(startNote);
showFocus(true);
render();

let ticker = 0;
/** This tab holds the game: it may run, send and save. */
function start(): void {
  ownsGame = true;
  $("t-elsewhere").hidden = true;
  document.body.classList.remove("standby");
  state.bankAt = Math.max(state.bankAt, now());
  applyHold();
  listen();
  void dealTick();
  void refreshHeld();
  ticker = window.setInterval(() => {
    void dealTick();
    void submitTick();
    void rentTick();
    autoTick();
    render();
  }, 1000);
}

/** Another tab holds the game: nothing runs here and the save is not written. */
function standBy(takenOver: boolean): void {
  if (ownsGame) {
    ownsGame = false;
    clearInterval(ticker);
    clearTimeout(saveTimer);
    state.settings.auto = false;
    for (const l of lanes) l.lane.terminate();
  }
  text(
    "t-elsewhere-text",
    takenOver
      ? "Tighter was opened in another tab, which now runs the game. Nothing runs here."
      : "Tighter is open in another tab. One tab runs the game at a time, so nothing runs here.",
  );
  $("t-elsewhere").hidden = false;
  document.body.classList.add("standby");
}

// One tab at a time (Web Locks): a second tab waits briefly (a reload releases the lock as it goes),
// then stands by and offers to take over, which moves the game here and stops the other tab.
const LOCK = "tighter.game";
const locks = (navigator as Navigator & { locks?: LockManager }).locks;
const holdForever = () => new Promise<void>(() => {});
if (locks) {
  locks
    .request(LOCK, { signal: AbortSignal.timeout(1500) }, () => {
      start();
      return holdForever();
    })
    // stolen by a tab that took over (when this one ran), or never granted
    .catch(() => standBy(ownsGame));
  $("t-take-over").addEventListener("click", () => {
    $<HTMLButtonElement>("t-take-over").disabled = true;
    // the other tab saved when it was left; this tab reads that save afresh
    void locks.request(LOCK, { steal: true }, () => {
      location.reload();
      return holdForever();
    });
  });
} else start();
