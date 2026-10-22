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
import { FRONTIER, FRONTIER_P, ProblemKey, STARTER, keyOf, parseKey, problemTitle, shapeName } from "./frontier";
import {
  AdvancePlan,
  GameState,
  Leader,
  PATIENCES,
  PastProblem,
  ProblemState,
  StepChange,
  TOLERANCES,
  accrue,
  addToQueue,
  advancePlan,
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
  problem,
  recordsHeld,
  reveal,
  revealed,
  seenKeys,
  slotted,
  spent,
  stallAfter,
  submitTarget,
} from "./game";
import {
  PAIR_BONUS,
  RENT_CHECK_MS,
  SHAPE_BONUS,
  SHAPE_MILESTONES,
  TIER_BONUS,
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
import { CONTEST, TIERS, TIER_LABEL, Tier, gapOf, show6 } from "./points";
import { HELP, MIN_STEP, andList, lowerFirst, superscript } from "./help";
import { renderHow } from "./how";
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
import { PHONE_QUERY, TreeRenderer, treeView } from "./shop";
import {
  HELD_PER_STANDING,
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
import {
  RunRecord,
  Trouble,
  answerTrouble,
  classifyAnswer,
  shouldSubmit,
  submissionBody,
  troubleText,
} from "./submission";
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
  autoCap,
  autoPerSecond,
  autoRateText,
  canBuy,
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
/** A relative improvement as the status line shows it: "1.2 × 10⁻⁴", or from a hundredth up "3.1 %". */
function fmtRelative(x: number): string {
  if (x >= 0.01) return `${(x * 100).toPrecision(2)} %`;
  let e = Math.floor(Math.log10(x));
  let m = (x / 10 ** e).toFixed(1);
  if (m === "10.0") [m, e] = ["1.0", e + 1];
  return `${m} × 10${superscript(e)}`;
}
const evals = (n: number) => `${fmtInt(n)} evaluation${n === 1 ? "" : "s"}`;
/** "side", or "radius" for a circle container. */
const sideWord = (p: ProblemKey) => (p.M === 0 ? "radius" : "side");
/** Auto-eval's pace from its evaluations a second, in its clicks: "a click of 4 every 5 s". */
const fmtRate = (r: number) => autoRateText(owned(), r);

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
    startNote = "This browser does not let the page keep a save, so the game lasts only until you close the tab.";
  }
  if (text) {
    const r = fromJson(text, now());
    if (r.ok) return r.state;
    if (/newer version/.test(r.error)) {
      // never overwrite a save this version cannot read
      savesDisabled = true;
      startNote = `Your save is from a newer version of Tighter, so this page leaves it untouched and plays without saving.`;
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
// auto-eval runs live and owes nothing for the time the page was closed; it starts off, so compute
// starts only on a press
state.settings.auto = false;

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
const noticeEl = $("t-notice");
/**
 * Something that happened: kept in the save's log, and when it matters to the player (the server
 * confirmed, refused or took back points, a record was lost, a reset) shown on the notice line under
 * the board until the next one. The page has no log panel.
 */
function event(text: string, notice = true): void {
  log(state, now(), text);
  if (notice) showNotice(text);
}
/** Puts a line on the notice line, with the time it happened. */
function showNotice(text: string): void {
  const d = new Date(now());
  noticeEl.textContent = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} · ${text}`;
  noticeEl.hidden = false;
}
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
/** Puts the focused problem's board on the canvas, when it changed; a new problem is placed at once. */
function showFocus(force = false): void {
  const p = focused();
  if (p && p.phase === "bare" && ownsGame && !loading.has(p.key)) void loadAll(p).then(() => showFocus());
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
  let zoom = (0.42 * Math.min(w, h)) / reach;
  // the trace and the score sit in the canvas's bottom corners: beside the packing when there is
  // room, otherwise the packing is fitted above them
  const inset = overlayInset(w, 0.42 * Math.min(w, h));
  if (inset > 0) zoom = Math.min(zoom, (0.42 * Math.min(w, Math.max(h * 0.45, h - inset))) / reach);
  if (zoom < view.cam.zoom) view.cam.zoom = zoom;
  if (inset > 0) view.cam.y = c.cy - Math.min(inset, h * 0.55) / 2 / view.cam.zoom;
  view.requestDraw();
}

/** Height the corner overlays take at the bottom of the canvas, when a packing this wide (half, in pixels) would run under them. */
function overlayInset(w: number, halfWidth: number): number {
  const boxes = [$("t-pip"), $("t-score")].filter((e) => !e.hidden && e.offsetWidth > 0);
  if (!boxes.length) return 0;
  const ow = Math.max(...boxes.map((e) => e.offsetWidth));
  if (w / 2 - halfWidth >= ow + 12) return 0;
  return Math.max(...boxes.map((e) => e.offsetHeight)) + 12;
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
 * reset) goes once it is idle: its run closes, its worker stops, and auto-eval's jobs it held are
 * due again.
 */
function ensureLanes(): void {
  const want = laneCount(owned());
  while (lanes.length > want) {
    const lv = lanes[lanes.length - 1];
    if (lv.pumping || lv.current) break;
    for (const j of lv.jobs) if (!j.click) state.autoDue += j.evals;
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
      say(`Placing the pieces did not give a valid board (${e.reasons.join(", ")}).`);
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
      const side = sideWord(p);
      // the starting score: what the first record must beat (the code's free floor)
      const startingScore =
        p.floor! < start.score
          ? `The record for ${p.P + 1} pieces, with one piece taken out, packs ${p.P} pieces in less room (${show6(p.floor!)}). ` +
            "That is the starting score your first record must beat."
          : `This ${side} is the starting score your first record must beat, and this board is never sent as it is. Your first press of Evolve compacts it.`;
      say(
        start.transferred
          ? `This problem starts from the best packing of ${transfer!.from} pieces, with ${p.P - transfer!.from} more placed around it (Transfers). ` +
              `Its ${side} is ${show6(start.score)}, ${fmtPct(start.score / b0 - 1)} above the area bound. Every piece on rings around the centre would give ${show6(e.score)}. ` +
              startingScore
          : `${p.P} pieces placed on rings around the centre. The ${side} is ${show6(e.score)}, ${fmtPct(e.score / b0 - 1)} above the area bound. ` +
              startingScore,
      );
    }
    if (start.transferred)
      event(`${problemTitle(p)} started from the best packing of ${transfer!.from} pieces (Transfers).`, false);
    persist();
    return true;
  } finally {
    loading.delete(p.key);
    render();
  }
}

/** A Compact of the problem is queued or running (the player's first click, or Auto-advance's). */
const compacting = (key: string) =>
  lanes.some((l) => (l.current?.key === key && l.current.compact) || l.jobs.some((j) => j.key === key && j.compact));
/** The next Evolve click on the problem compacts it first: its board is the start, not yet a run's. */
const compactsFirst = (p: ProblemState) => p.phase === "loaded" && !p.run && !compacting(p.key);

/**
 * Queues an Evolve click on the focused problem. The first click on a board that has only been
 * placed (a new problem is placed at once when it is shown) is Compact: 100 evaluations of
 * mc_compress, as one press. Clicks pressed while that Compact runs queue behind it as Evolve clicks.
 */
function press(): void {
  const p = focused();
  if (!p || !ownsGame || p.leaving || p.closed) return;
  stopped = false;
  const o = owned();
  const compact = compactsFirst(p);
  if (!compact && !evolvable(p) && !compacting(p.key)) return;
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

/** Works through a lane's queue: clicks first, then auto-eval's due evaluations. */
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
        // a job that could not run is due again, and the next tick tries again
        state.autoDue += job.evals;
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
    say(`A run on ${problemTitle(p)} could not start (${a.message}).`);
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
      say(`The run on ${problemTitle(p)} stopped (${t.message}).`);
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
          ? `New record ${show6(p.best!)} · No one had sent a packing of ${problemTitle(p).replace(/, (\d+) pieces$/, " with $1 pieces")} before.`
          : `New best ${show6(p.best!)} on ${problemTitle(p)}.`,
    };
    event(
      `New record ${show6(p.best!)} on ${problemTitle(p)}.${state.consent ? "" : " It is not sent until you put your name on your records."}`,
      false,
    );
  }
  if (change.points) reveal(state, "points", "upgrades");
  if (st.ended && !st.closed && !st.error) {
    const seeds = seedsPerProblem(owned());
    event(
      `The run with seed ${run.seed} on ${problemTitle(p)} stopped improving after ${evals(st.evaluations)}.` +
        (spent(p, seeds)
          ? seeds === 1
            ? " This problem's one seed has now run."
            : ` All ${fmtInt(seeds)} of your seeds per problem have now run here.`
          : ` The next click starts a new run with the next seed${nextStageText(p)}.`),
    );
  }
  // after Stop, the click that was already running does not write over "Stopped"
  if (job.click && p.key === state.focus && !stopped) say(stepMessage(p, change, run, job, done));
  persist();
  scheduleRender();
  void submitTick();
  void dealTick();
}

function stepMessage(p: ProblemState, c: StepChange, run: OpenRunView, job: Job, done: number): string {
  const o = owned();
  const what =
    `${job.compact ? "Compact" : `Click ${fmtInt(state.stats.clicks)}`} ran ${evals(done)} of ${run.method}` +
    `${o.has("seeds") ? ` with seed ${run.seed}` : ""}.`;
  if (!c.improved || c.before === null || c.after === null) return `${what} No improvement on ${show6(p.best ?? 0)}.`;
  // the relative improvement of this one step (the step term of its points), never a measure of the record
  let text =
    `${what} The ${sideWord(p)} went from ${show6(c.before)} to ${show6(c.after)}, ` +
    `an improvement of ${fmtRelative(1 - c.after / c.before)}`;
  if (!c.counted)
    return `${text}. That is less than the smallest improvement that counts (${MIN_STEP}), so it pays with the next one that does.`;
  text += c.points ? `, worth +${fmtRP(c.points.total)} RP.` : ".";
  if (!state.consent) text += " Put your name on your records to send them and earn their points.";
  return text;
}

/** With a pipeline: ", running <method>" for the next stage on the problem; otherwise nothing. */
function nextStageText(p: ProblemState): string {
  const o = owned();
  if (!piped(o)) return "";
  const stage = pipelineMethod(state.runplan.pipeline, p.endedRuns, (m) => allowedMethod(o, m));
  return stage ? `, using ${stage.method} (stage ${stage.stage + 1} of ${state.runplan.pipeline.length})` : "";
}

/** Runs that ran to their end here, of the seeds per problem the player has. */
const seedsText = (p: ProblemState, seeds: number) =>
  `${fmtInt(Math.min(p.endedRuns, seeds))} of ${fmtInt(seeds)} seed${seeds === 1 ? "" : "s"} used`;

function spentText(p: ProblemState): string {
  const o = owned();
  const n = seedsPerProblem(o);
  return (
    `${n === 1 ? "Your one seed" : `All ${fmtInt(n)} of your seeds`} on ${problemTitle(p)} ran until ${n === 1 ? "its run" : "their runs"} stopped improving. ` +
    `Move on to the next problem${o.has("seeds32") || o.rule === "seed" ? "" : ", or buy more seeds per problem in the tech tree"}.`
  );
}

/** Stop was pressed and no click since: the status line keeps saying so. */
let stopped = false;

function stopAll(): void {
  stopped = true;
  state.settings.auto = false;
  for (const l of lanes) l.jobs = l.jobs.filter((j) => j.compact && j.click);
  say("Stopped. Auto-eval is off, and the clicks still waiting to run were dropped.");
  persist();
  render();
}

// ---------- hold: hidden tabs and battery ----------

let onBattery = false;
function holdReason(): "hidden" | "battery" | null {
  return autoHold({
    hidden: document.hidden,
    onBattery,
    // running while hidden needs Continuous; before it a hidden tab pauses auto-eval, whatever the save says
    background: state.settings.background && owned().has("continuous"),
    battery: state.settings.battery,
  });
}
/**
 * Auto-eval runs nothing while the tab is hidden or the device is on battery power, unless the
 * player allowed it in Settings, and owes nothing for that time. Clicks are the player's own and
 * always run.
 */
function applyHold(): void {
  accrueAuto();
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

/** Auto-eval may run now: owned, switched on, not held, in the tab that holds the game. */
function autoRuns(o: Owned): boolean {
  return ownsGame && state.settings.auto && autoPerSecond(o) !== null && !holdReason();
}

/** Auto-eval was running at the last accrual: a span counts only when it ran from start to end. */
let autoRan = false;
/**
 * Brings auto-eval's due evaluations up to now. It runs live: it earns only while it may run, and
 * once it may not (off, held), nothing stays due and nothing is owed for the time it was stopped.
 */
function accrueAuto(): void {
  const o = owned();
  const runs = autoRuns(o);
  accrue(state, now(), runs && autoRan ? (autoPerSecond(o) ?? 0) * laneCount(o) : 0, autoCap(o, laneCount(o)));
  autoRan = runs;
  if (!runs) state.autoDue = 0;
}

/**
 * Auto-eval's next click for this lane, from what it is due, when it may run one. It clicks as the player
 * does, with as many evaluations as a click of theirs (its rate is in clicks, so it earns k evaluations
 * a click), and an evaluation pays the same either way.
 */
function autoJob(lv: LaneView): Job | null {
  const o = owned();
  const k = evalsPerClick(o);
  if (autoPerSecond(o) === null || !state.settings.auto || holdReason() || state.autoDue < k) return null;
  const busy = new Set(lanes.filter((l) => l !== lv).flatMap(laneKeys));
  const target = autoTarget({
    lane: lanes.indexOf(lv),
    queue: state.queue,
    focus: state.focus,
    busy,
    owned: o,
    seeds: seedsPerProblem(o),
    // a Compact waits until auto-eval is due its 100 evaluations; meanwhile runs go on elsewhere
    canCompact: state.autoDue >= COMPACT_EVALS,
    // with Auto-advance a lane keeps to its run's problem until that problem stalls
    current: lv.run?.key ?? null,
    stall: stallAfter(state),
  });
  if (!target) return null;
  if (target.action === "compact") {
    if (state.autoDue < COMPACT_EVALS) return null;
    state.autoDue -= COMPACT_EVALS;
    return { key: target.key, evals: COMPACT_EVALS, click: false, compact: true };
  }
  state.autoDue -= k;
  return { key: target.key, evals: k, click: false, compact: false };
}

/** Starts every idle lane that has work, auto-eval's or queued clicks. */
function kickLanes(): void {
  if (!ownsGame) return;
  ensureLanes();
  for (const lv of lanes) if (!lv.pumping) void pump(lv);
}

function autoTick(): void {
  if (!ownsGame) return;
  accrueAuto();
  kickLanes();
}

// ---------- submissions ----------

let submitting = false;
/** Problems whose submission is on its way. */
const inFlight = new Set<string>();
/**
 * Longest a submission's GET or POST is waited for. Sends go one at a time, so a request that never
 * ends would hold back every other send; past this it counts as unanswered, as when the server
 * cannot be reached, and a late answer is recognised by the next read of the leader.
 */
const SEND_TIMEOUT_MS = 30_000;

/** A request's answer, or `late` once `ms` pass without one (the request itself goes on). */
function within<T>(ms: number, request: Promise<T>, late: T): Promise<{ answer: T; timedOut: boolean }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ answer: late, timedOut: true }), ms);
    const done = (answer: T) => {
      clearTimeout(timer);
      resolve({ answer, timedOut: false });
    };
    request.then(done, () => done(late));
  });
}

/**
 * The notice of what went wrong with sending, while it lasts. Points waiting for the server's
 * answer are not shown; a notice appears only when sending goes wrong, and goes once it works again.
 */
let trouble: string | null = null;

/** Says on the notice line what went wrong with sending and what the game does next (logged once while it lasts). */
function sendTrouble(t: Trouble): void {
  const text = troubleText(t);
  if (text !== trouble) log(state, now(), text);
  trouble = text;
  showNotice(text);
}

/** Sending works again: the notice of its trouble goes, unless another notice has taken its place. */
function sendingWorks(): void {
  if (trouble !== null && noticeEl.textContent?.endsWith(` · ${trouble}`)) noticeEl.hidden = true;
  trouble = null;
}

/** Pauses all sending after the server could not be reached, failed, or asked to wait, and says so. */
function pauseSending(t: Trouble): void {
  state.pacer = pause(state.pacer, now(), t.kind === "rate-limited" ? RATE_LIMITED_BACKOFF_MS : OFFLINE_BACKOFF_MS);
  sendTrouble(t);
}

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
    event(
      `Turning the container to its best angle on ${problemTitle(p)} gained ${fmtChange(p.best / (1 - points.delta), p.best)} (+${fmtRP(points.total)} RP).`,
      false,
    );
}

async function submit(p: ProblemState): Promise<void> {
  const name = state.name;
  // the leader just before: the server's exact check decides
  const read = await within(SEND_TIMEOUT_MS, api.getProblem(p.N, p.M, p.P), null);
  const info = read.answer;
  if (problem(state, p.key) !== p || !ownsGame) return;
  if (!info) {
    pauseSending(read.timedOut ? { kind: "timeout", waitedMs: SEND_TIMEOUT_MS } : { kind: "unreachable" });
    return;
  }
  if (!info.accepts_submissions) {
    sendingWorks();
    p.closed = true;
    event(
      `The server takes no more entries for ${problemTitle(p)}, because its optimum is proven. It leaves the queue.`,
    );
    leave(state, p.key, now());
    return;
  }
  const leaderBefore: Leader | null = info.site_best
    ? { score: info.site_best.score, name: info.site_best.name, id: info.site_best.id }
    : null;
  noteLeader(p, leaderBefore);
  orient(p);
  const best = p.best!;
  if (!shouldSubmit(best, submitTarget(p, leaderBefore?.score ?? null))) {
    // the server answered, and the board does not go: sending has nothing wrong left to report
    sendingWorks();
    return;
  }
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
  let posted: { answer: { status: number | null; body: unknown }; timedOut: boolean };
  try {
    posted = await within(SEND_TIMEOUT_MS, api.postSubmission(submissionBody(board0, name, run)), {
      status: null,
      body: null,
    });
  } finally {
    inFlight.delete(p.key);
  }
  const answer = posted.answer;
  const outcome = classifyAnswer(answer.status, answer.body);
  if (problem(state, p.key) !== p) return;
  const a = applyAnswer(state, p, leaderBefore, best, outcome, now());
  const title = problemTitle(p);
  const wrong = answerTrouble(
    outcome,
    answer.status,
    posted.timedOut ? SEND_TIMEOUT_MS : null,
    title,
    a.takenBack > 0 ? fmtRP(a.takenBack) : null,
  );
  if (!wrong) sendingWorks();
  else if (outcome.kind === "refused") sendTrouble(wrong);
  else pauseSending(wrong);
  switch (outcome.kind) {
    case "leader":
      reveal(state, "points", "upgrades");
      event(
        `The server made ${show6(outcome.score)} the record for ${title}${a.confirmed > 0 ? ` (${fmtRP(a.confirmed)} RP confirmed)` : ""}.`,
      );
      if (outcome.pending) event("It beats a published value, so it waits for an administrator's review.");
      break;
    case "behind":
      event(
        `Another entry got there first on ${title}, and the record is now ${show6(outcome.leaderScore ?? 0)}.` +
          (a.takenBack > 0 ? ` ${fmtRP(a.takenBack)} RP taken back.` : "") +
          (a.points ? ` Your board still beats it, which pays +${fmtRP(a.points.total)} RP.` : ""),
      );
      break;
    case "closed":
      event(
        `The server takes no more entries for ${title} (${outcome.reasons.join(", ")}). It leaves the queue.${a.takenBack > 0 ? ` ${fmtRP(a.takenBack)} RP taken back.` : ""}`,
      );
      leave(state, p.key, now());
      break;
  }
  if (p.leaving && !hasUnsent(p)) leave(state, p.key, now());
}

/**
 * A send whose answer never came is settled by its problem's next send, a minute later, which
 * reads the record first. One still unsettled after this long (sending was switched off, or the
 * board no longer goes) is settled by reading its record here.
 */
const LOST_ANSWER_MS = 120_000;
let lostChecking = false;
let lostCheckAfter = 0;

/** Reads the record of the oldest send left without an answer, once it is LOST_ANSWER_MS old. */
async function settleLost(): Promise<void> {
  if (!ownsGame || submitting || lostChecking || now() < lostCheckAfter || now() < state.pacer.pausedUntil) return;
  const p = state.queue.find((q) => q.sending && !inFlight.has(q.key) && now() - q.sending.at >= LOST_ANSWER_MS);
  if (!p) return;
  lostChecking = true;
  try {
    const { answer: info } = await within(SEND_TIMEOUT_MS, api.getProblem(p.N, p.M, p.P), null);
    if (problem(state, p.key) !== p || !p.sending || inFlight.has(p.key) || !ownsGame) return;
    if (!info) {
      lostCheckAfter = now() + OFFLINE_BACKOFF_MS;
      sendTrouble({ kind: "lost", title: problemTitle(p) });
      return;
    }
    sendingWorks();
    // ours: its points are confirmed; not ours: they wait for the board's next send
    const lead = info.site_best;
    noteLeader(p, lead ? { score: lead.score, name: lead.name, id: lead.id } : null);
    persist();
    render();
  } finally {
    lostChecking = false;
  }
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
  event(`${retake ? "Retake" : "Dealt"}: ${problemTitle(p)}${dealtNote(p)}.`, false);
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

/** Auto-advance moves on: owned, with auto-eval switched on. */
const advancing = (o: ReadonlySet<UpgradeId>): boolean =>
  o.has("advance") && state.settings.auto && autoPerSecond(o) !== null;

/** Auto-advance's move now (game.ts advancePlan), or null without it. */
function plan(o: ReadonlySet<UpgradeId>): AdvancePlan | null {
  if (!advancing(o)) return null;
  return advancePlan(state, { seeds: seedsPerProblem(o), slots: queueSize(o), perClick: evalsPerClick(o) });
}

/** A deal is earned by evaluations (a token), whether or not a slot is free. */
function dealEarned(): boolean {
  const o = owned();
  return canDeal(state.dealer, queueSize(o), state.stats.evaluations, evalsPerClick(o));
}

/**
 * Deals into a free slot when one is due. With Auto-advance, a problem that stopped making
 * progress is replaced as soon as a deal is earned: its replacement is found first (the dealer's,
 * or with Your pick the best offer), then it leaves as if dropped, so the queue never runs short.
 */
async function dealTick(): Promise<void> {
  if (!ownsGame || dealing || now() < dealPausedUntil) return;
  const o = owned();
  const move = plan(o);
  for (const p of move?.now ?? []) autoDrop(p);
  if (picking(o)) {
    if (state.picks.offers.some((x) => !offerAllowed(o, x)))
      state.picks.offers = state.picks.offers.filter((x) => offerAllowed(o, x));
    const out = move?.replace ?? null;
    if (!out && (!mayDeal() || (state.picks.offers.length >= offerCount(o) && !autoTakes(o)))) return;
    dealing = true;
    try {
      await offerTick(o, out);
    } finally {
      dealing = false;
      render();
    }
    return;
  }
  // a free slot is filled first; a problem that stopped making progress waits for the next deal
  const out = mayDeal() ? null : (move?.replace ?? null);
  if (!out && !mayDeal()) return;
  dealing = true;
  try {
    const r = await deal(state.dealer);
    if (r) {
      if (out) autoDrop(out, r.p);
      dealt(r.p, r.ranked, r.ranked.candidate.retake);
    }
  } finally {
    dealing = false;
    render();
  }
}

/** Offline or nothing found: ask again in a while rather than every second. */
function pauseDealing(offline: boolean): void {
  dealPausedUntil = now() + OFFLINE_BACKOFF_MS;
  if (offline && !state.queue.length)
    $("t-title").textContent =
      `The server cannot be reached, and the game needs it to deal you a problem. Trying again in ${OFFLINE_BACKOFF_MS / 1000} s…`;
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

/** A free slot and a lane that would have nothing to do: fewer problems still making progress than lanes (Auto-advance takes an offer). */
function autoTakes(o: ReadonlySet<UpgradeId>): boolean {
  if (!advancing(o) || !mayDeal()) return false;
  const seeds = seedsPerProblem(o);
  const stall = stallAfter(state);
  const moving = slotted(state).filter((p) => !p.closed && !spent(p, seeds) && p.sinceGain < stall);
  return moving.length < laneCount(o);
}

/**
 * Your pick: fills the offers when a deal is due (or a problem waits to be replaced, `out`).
 * Auto-advance takes the best offer into a free slot when a lane would idle, or in place of `out`.
 */
async function offerTick(o: ReadonlySet<UpgradeId>, out: ProblemState | null): Promise<void> {
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
  const best = state.picks.offers[0];
  if (!best) return;
  if (autoTakes(o)) await takeOffer(best, true);
  else if (out) await takeOffer(best, true, out);
}

/** Whether an offer is still as it was, from GET /api/problems just before it is taken. */
function offerStands(info: ProblemInfo | null, x: Offer): boolean {
  if (!info) return false;
  if (x.tier === "open" && !x.retake) return openDealable(info);
  return contestedDealable(info, x);
}

/** Takes an offer into the queue (the player's pick, or Auto-advance's, in place of `out` when given). */
async function takeOffer(x: Offer, auto = false, out: ProblemState | null = null): Promise<void> {
  if (!offerAllowed(owned(), x)) {
    state.picks.offers = state.picks.offers.filter((y) => y !== x);
    say(`The offer of ${problemTitle(x)} is gone, because your reach, filters or rule no longer allow it.`);
    persist();
    return;
  }
  if (out ? !dealEarned() : !mayDeal()) {
    if (!auto)
      say(
        slotted(state).length >= queueSize(owned())
          ? "Every slot is full. Drop a problem to make room for this one."
          : `The next problem is earned after ${fmtInt(evalsToDeal())} more evaluations.`,
      );
    return;
  }
  const info = await api.getProblem(x.N, x.M, x.P);
  if (!info) {
    pauseDealing(true);
    say("The server cannot be reached. The offer stays until it can be checked.");
    return;
  }
  state.picks.offers = state.picks.offers.filter((y) => y !== x);
  const title = problemTitle(x);
  if (!offerStands(info, x)) {
    skipped.add(keyOf(x));
    event(`${title} changed since it was offered, so the offer is gone. Someone took it, or its record moved.`);
    persist();
    return;
  }
  const p = await materialize(x);
  if (!p || problem(state, p.key)) {
    skipped.add(keyOf(x));
    event(`${title} could not be loaded, so the offer is gone.`);
    persist();
    return;
  }
  // the replacement is in hand: the problem it replaces leaves now
  if (out) autoDrop(out, p);
  dealt(p, x, x.retake);
  if (!auto) {
    state.focus = p.key;
    showFocus();
  }
  if (!out) say(auto ? `Auto-advance took ${title}, the best offer.` : `You took ${title}.`);
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
    event(
      `The server made ${show6(leader.score)} the record for ${problemTitle(p)}` +
        `${r.confirmed > 0 ? ` (${fmtRP(r.confirmed)} RP confirmed)` : ""}. The game recognised your entry from the current record, because its answer had not arrived.`,
    );
  } else if (r.lost) {
    // Retake: a record lost after it left the queue is offered again first
    const retake = owned().has("retake") && !problem(state, p.key);
    if (retake) addRetake(state.picks, p.key);
    event(
      `Your record on ${problemTitle(p)} was beaten${leader ? ` by ${leader.name}, with ${show6(leader.score)}` : ""}.` +
        (retake ? " It will be the first problem offered to you again (Retake)." : ""),
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
  if (s.consent || s.stats.firstRecords || s.queue.some((q) => q.phase === "ready" && q.tier === "open")) {
    reveal(s, "consent");
    // the first record asks once for a name, in a pop-up over the board; after that, Settings holds it
    if (!revealed(s, "asked") && ownsGame) {
      reveal(s, "asked");
      if (!s.consent) openWelcome();
      persist();
    }
  }
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
  show("t-bar-lanes-box", o.has("lanes2"));
  text("t-bar-lanes", `${laneCount(o)}`);

  // hold note
  const hold = holdReason();
  const auto = s.settings.auto && rate !== null;
  text(
    "t-hold",
    auto && hold === "hidden"
      ? "Auto-eval is paused because this tab is hidden."
      : auto && hold === "battery"
        ? "Auto-eval is paused on battery power. You can allow it in Settings."
        : "",
  );

  renderProblem(p);
  problemTip();
  renderToolbar(p, o);
  renderScore(p, o);
  renderConsent();
  renderPoints();
  renderUpgrades(o);
  renderQueue(o);
  renderLanes(o);
  renderRuns(o);
  show("t-bg-box", o.has("continuous"));
  $<HTMLInputElement>("t-bg").checked = s.settings.background && o.has("continuous");
  $<HTMLInputElement>("t-battery").checked = s.settings.battery;
  text(
    "t-run-note",
    o.has("continuous")
      ? "Unless the first box is ticked, auto-eval pauses while this tab is hidden."
      : "Auto-eval pauses while this tab is hidden. The Continuous upgrade in the tech tree lets it keep running.",
  );
  renderStanding(o);
  renderRecords(o);
  renderDock();
}

function renderProblem(p: ProblemState | undefined): void {
  const s = state;
  if (!p) {
    if (picking(owned()) && s.picks.offers.length) text("t-title", "Pick a problem from the offers in the queue.");
    else if (!dealing && now() >= dealPausedUntil) text("t-title", "Dealing a problem…");
    text("t-problem-note", "");
    text("t-problem-count", "");
    show("t-next", false);
    return;
  }
  text("t-title", problemTitle(p));
  text("t-problem-count", countText(p));
  let note: string;
  const seeds = seedsPerProblem(owned());
  if (p.closed) note = "This problem is closed. The server takes no more entries for it.";
  else if (p.leaving) note = "This problem leaves the queue once your best board has been sent.";
  else if (spent(p, seeds)) note = spentText(p);
  else if (p.ourId !== null)
    note =
      `You hold the record for this problem, ${show6(p.verified!)}.` +
      (p.published !== null && p.verified! > p.published
        ? ` The published value ${show6(p.published)} is still smaller, and nothing more pays until your board beats it.`
        : "");
  else if (p.tier === "published")
    note =
      `To earn points here, beat the published value ${show6(p.published!)}. Below it, improvements pay ${CONTEST.published} times as much as on an open problem, and a record waits for an administrator's review.` +
      (p.leader ? ` The site's record is ${show6(p.leader.score)}, by ${p.leader.name}.` : "");
  else if (p.leader && p.tier !== "open" && !p.run)
    note =
      `${TIER_LABEL[p.tier][0].toUpperCase()}${TIER_LABEL[p.tier].slice(1)} ${show6(p.leader.score)} by ${p.leader.name}, ${fmtPct(gapOf(p.N, p.M, p.P, p.leader.score))} above the area bound. ` +
      `Improvements here pay ${CONTEST[p.tier]} times as much as on an open problem.`;
  else if (p.leader) note = `The record is ${show6(p.leader.score)}, by ${p.leader.name}.`;
  else if (p.phase === "ready") note = "Your record has not been sent yet.";
  else
    note = "No one has sent a packing for this problem yet. Your first board below the starting score is a new record.";
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

/** The problem's title and note in full on hover: the top row may cut them short. */
function problemTip(): void {
  const tip = [$("t-title").textContent, $("t-problem-note").textContent].filter(Boolean).join("\n");
  const box = $("t-problem-text");
  if (box.title !== tip) box.title = tip;
}

function renderToolbar(p: ProblemState | undefined, o: ReadonlySet<UpgradeId>): void {
  const lv = p ? laneOn(p.key) : undefined;
  const canEvolve = !!p && evolvable(p);
  const seeds = seedsPerProblem(o);
  // one button: the first click on a board that has only been placed compacts it (100 evaluations)
  const first = !!p && compactsFirst(p);
  const k = evalsPerClick(o);
  text("t-evolve", first ? "Evolve (compacts first)" : k === 1 ? "Evolve" : `Evolve ×${k}`);
  $<HTMLButtonElement>("t-evolve").disabled =
    !p ||
    p.phase === "bare" ||
    p.leaving ||
    p.closed ||
    (!first && !canEvolve && !compacting(p.key)) ||
    (canEvolve && spent(p, seeds));
  $("t-evolve").title = !p
    ? "There is no problem on the board yet."
    : p.phase === "bare"
      ? "The pieces are being placed."
      : first
        ? `Your first click compacts the board with ${evals(COMPACT_EVALS)} of mc_compress. After that, each click runs ${evals(k)}.`
        : `Each click runs ${evals(k)} of the solver on this board.`;
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
    ? "Your pipeline in the Runs panel chooses the method of each new run."
    : canAuto && state.runplan.auto
      ? "The game chooses each new run's method from what has paid best on problems like this one."
      : "The solver method your clicks run. Changing it starts a new run.";
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
    info = p.phase === "bare" ? "Placing the pieces…" : `${p.P} pieces placed`;
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
  show("t-score", !!p);
  show("t-pip", !!p);
  if (!p) return;
  text("t-side-label", p.M === 0 ? "Radius r" : "Side s");
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
  // the trace, always in the board's corner: the side after each improvement here, by evaluations run
  // here; Trace detail adds its labels and a mark at each improvement
  const svg = $("t-trace") as unknown as SVGSVGElement;
  const tr = p.trace;
  const visible = tr.length >= 2;
  svg.toggleAttribute("hidden", !visible);
  show("t-trace-empty", !visible);
  if (!visible) return;
  const detail = o.has("trace");
  const sig = `${p.key}|${tr.length}|${tr[tr.length - 1][1]}|${detail}`;
  if (svg.dataset.sig === sig) return;
  svg.dataset.sig = sig;
  const sides = tr.map(([, v]) => v);
  const high = Math.max(...sides),
    low = Math.min(...sides);
  const range = high - low || high * 1e-6;
  const e0 = tr[0][0],
    e1 = tr[tr.length - 1][0];
  const span = e1 - e0 || 1;
  const bottom = detail ? 72 : 88;
  const pt = ([e, v]: [number, number]) =>
    [10 + (280 * (e - e0)) / span, 10 + ((bottom - 10) * (high - v)) / range] as const;
  const NS = "http://www.w3.org/2000/svg";
  const line = document.createElementNS(NS, "polyline");
  line.setAttribute(
    "points",
    tr
      .map(pt)
      .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(2)}`)
      .join(" "),
  );
  const parts: SVGElement[] = [line];
  if (detail) {
    // a mark at each improvement (the last 60), and the labels
    for (const q of tr.slice(-60)) {
      const [x, y] = pt(q);
      const dot = document.createElementNS(NS, "circle");
      dot.setAttribute("cx", x.toFixed(1));
      dot.setAttribute("cy", y.toFixed(2));
      dot.setAttribute("r", "2.2");
      parts.push(dot);
    }
    const label = document.createElementNS(NS, "text");
    label.setAttribute("x", "10");
    label.setAttribute("y", "92");
    label.textContent = `${show6(sides[0])} → ${show6(sides[sides.length - 1])} · ${fmtInt(tr.length)} improvements · ${evals(e1 - e0)}`;
    parts.push(label);
  }
  svg.replaceChildren(...parts);
  svg.setAttribute(
    "aria-label",
    `Side after each improvement, from ${show6(sides[0])} to ${show6(sides[sides.length - 1])} over ${evals(e1 - e0)}`,
  );
}

function renderConsent(): void {
  const name = $<HTMLInputElement>("t-name");
  const agree = $<HTMLInputElement>("t-agree");
  if (document.activeElement !== name && !name.dataset.edited) name.value = state.name;
  if (document.activeElement !== agree && !agree.dataset.edited) agree.checked = state.consent;
  text(
    "t-consent-note",
    state.consent
      ? `Your records are sent to PolyPack as “${state.name}”. To stop sending, untick the box and save.`
      : state.stats.submissions
        ? `Sending is off. New records stay in this browser and pay no points until you send them.${owned().has("rent") ? " Records already on the server keep paying rent." : ""}`
        : "Nothing has been sent yet. Your records pay points only once they are sent to PolyPack under your name.",
  );
}

/** The points themselves are in the totals; the panel keeps their explanations and the name nudge. */
function renderPoints(): void {
  show("t-points-help", revealed(state, "points"));
  show("t-name-nudge", !state.consent && revealed(state, "asked"));
  // the clicks: in the evaluations' tooltip
  const evals = $("t-bar-evals-box");
  const tip = `Evaluations run in all, by your clicks and by auto-eval. Clicks so far: ${fmtInt(state.stats.clicks)}.`;
  if (evals.title !== tip) evals.title = tip;
}

const tree = new TreeRenderer(
  $("t-cards"),
  $("t-shop-summary"),
  $("t-tree-detail"),
  (id) => onBuy(id),
  (id) => canBuy(owned(), { rp: state.rp, standing: state.standing.points }, id).ok,
);
/** The tech tree is the view in place of the board (kept while the page is open). */
let treeOpen = false;
function renderUpgrades(o: Owned): void {
  const on = revealed(state, "upgrades");
  show("t-views", on);
  if (!on) treeOpen = false;
  show("t-board-view", !treeOpen);
  show("t-upgrades", treeOpen);
  const funds = { rp: state.rp, standing: state.standing.points };
  const v = treeView(o, funds);
  if (treeOpen) tree.render(v, funds);
  // near the board, always: what can be bought now, else the next upgrade to save for
  const count = $("t-tab-count");
  show("t-tab-count", v.buyable > 0);
  text("t-tab-count", ` ${fmtInt(v.buyable)}`);
  count.setAttribute("aria-label", `${fmtInt(v.buyable)} to buy`);
  text(
    "t-next-up",
    v.buyable > 0
      ? `${fmtInt(v.buyable)} upgrade${v.buyable === 1 ? "" : "s"} to buy in the tech tree`
      : v.next
        ? `Save up for ${v.next.name} (${v.next.price})`
        : "",
  );
  $("t-next-up").dataset.ready = String(v.buyable > 0);
}

function setView(toTree: boolean): void {
  // on a phone the dock's Tree tab is the same view
  if (toTree) setPaneAttr("tree");
  else if (pane === "tree") setPaneAttr("board");
  if (treeOpen === toTree) return;
  treeOpen = toTree;
  $("t-tab-board").setAttribute("aria-selected", String(!toTree));
  $("t-tab-tree").setAttribute("aria-selected", String(toTree));
  $("t-tab-board").tabIndex = toTree ? -1 : 0;
  $("t-tab-tree").tabIndex = toTree ? 0 : -1;
  render();
  if (toTree) tree.scrollToFrontier();
  else fitView(board.container ?? view.ghost);
}

// ---------- phones: the dock's views ----------

/**
 * On a phone the screen shows one view at a time between the problem and the action dock: the
 * board, the tech tree, the queue (offers, filters, lanes, runs) or the points (the totals in full,
 * standing, records, and how points are paid).
 * The dock's tabs choose it; on wider screens the dock is not shown and the panel stays beside the
 * board (the view chosen only matters to the phone layout's CSS).
 */
type Pane = "board" | "tree" | "queue" | "points";
const PANES: readonly Pane[] = ["board", "tree", "queue", "points"];
let pane: Pane = "board";

function setPaneAttr(p: Pane): void {
  pane = p;
  if (document.body.dataset.pane !== p) document.body.dataset.pane = p;
}

function setPane(p: Pane): void {
  setPaneAttr(p);
  setView(p === "tree");
  if (p === "board") fitView(board.container ?? view.ghost);
  render();
}

/** Which views have something to show yet: the dock appears once there are two. */
function panesOpen(): Record<Pane, boolean> {
  const any = (...ids: string[]) => ids.some((id) => !$(id).hidden);
  return {
    board: true,
    tree: !$("t-views").hidden,
    queue: any("t-queue", "t-lanes", "t-runs"),
    points: any("t-points-help", "t-standing", "t-records"),
  };
}

function renderDock(): void {
  const open = panesOpen();
  if (!open[pane]) setPaneAttr("board");
  show("t-dock", PANES.filter((p) => open[p]).length > 1);
  for (const p of PANES) {
    const tab = $(`t-dock-${p}`);
    show(`t-dock-${p}`, open[p]);
    const selected = String(p === pane);
    if (tab.getAttribute("aria-selected") !== selected) tab.setAttribute("aria-selected", selected);
    tab.tabIndex = p === pane ? 0 : -1;
  }
  // the tree's count of upgrades to buy, as on the desktop tab
  const count = $("t-tab-count");
  show("t-dock-count", !count.hidden);
  text("t-dock-count", count.textContent ?? "");
  const label = count.getAttribute("aria-label");
  if (label) $("t-dock-count").setAttribute("aria-label", label);
}

for (const p of PANES) {
  $(`t-dock-${p}`).addEventListener("click", () => setPane(p));
  // the tabs as a tab list: the arrow keys move between those shown
  $(`t-dock-${p}`).addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const open = panesOpen();
    const shown = PANES.filter((q) => open[q]);
    const next = shown[(shown.indexOf(pane) + (e.key === "ArrowRight" ? 1 : shown.length - 1)) % shown.length];
    setPane(next);
    $(`t-dock-${next}`).focus();
  });
}

// On a phone the totals are one line that scrolls sideways: it takes the keyboard's focus there, so
// it can be scrolled without a finger too.
const phoneLayout = matchMedia(PHONE_QUERY);
const totalsFocus = () => ($("t-bar").tabIndex = phoneLayout.matches ? 0 : -1);
totalsFocus();
phoneLayout.addEventListener("change", totalsFocus);

// on a phone the status line shows three lines; a tap shows all of it
statusEl.addEventListener("click", () => {
  statusEl.dataset.open = String(statusEl.dataset.open !== "true");
});

function onBuy(id: UpgradeId): void {
  accrueAuto();
  // a lane past the CPU's cores would add nothing
  if (id === "lanesx" && lanesMaxed(owned())) return;
  if (!buy(state, id)) return;
  const u = upgrade(id);
  const l = u.levels ? ` (level ${level(owned(), id)})` : "";
  event(`Bought ${u.name}${l}. ${u.effect}`, false);
  say(`Bought ${u.name}${l}. ${u.effect}`);
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
        li.dataset.key = p.key;
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
        const count = document.createElement("span");
        count.className = "t-q-count";
        li.append(actions, count);
        return li;
      }),
    );
  }
  // the counters change with every step: they are written in place, so the rows (and their buttons
  // under the pointer) are rebuilt only when the signature above changes
  for (const li of list.children as HTMLCollectionOf<HTMLElement>) {
    const p = problem(state, li.dataset.key ?? null);
    const count = li.querySelector(".t-q-count");
    const value = p ? countText(p) : "";
    if (count && count.textContent !== value) count.textContent = value;
  }
  text("t-deal", dealText(o));
  renderAdvance(o);
  renderOffers(o);
  renderFilters(o);
}

/** Evaluations a long step under way on the problem has done that its counters do not have yet. */
function stepping(p: ProblemState): number {
  const lv = lanes.find((l) => l.current?.key === p.key && l.run?.key === p.key);
  return lv?.progress && lv.run ? Math.max(0, lv.progress.evaluations - lv.run.evaluations) : 0;
}

/** A problem's counters, live: "12,345 evaluations · 830 since progress". */
function countText(p: ProblemState): string {
  const going = stepping(p);
  return `${evals(p.evaluations + going)} · ${fmtInt(p.sinceGain + going)} since progress`;
}

/** The queue's dealing line: when the next problem comes, and with Auto-advance which one leaves next. */
function dealText(o: Owned): string {
  const free = queueSize(o) - slotted(state).length;
  const left = evalsToDeal();
  const more = `${fmtInt(left)} more evaluation${left === 1 ? "" : "s"}`;
  const offers = state.picks.offers.length;
  const line = picking(o)
    ? offers && mayDeal()
      ? `Pick a problem from the ${offers === 1 ? "offer" : `${offers} offers`} below.`
      : offers
        ? free > 0
          ? `The offers wait for a free slot. The next one is earned after ${more}.`
          : "The offers wait for a free slot. Every slot is full, so drop a problem to take one."
        : free > 0 && left > 0
          ? `New offers come after ${more}.`
          : free > 0
            ? "Drawing offers…"
            : "Every slot is full. Drop a problem to take a new one."
    : free > 0
      ? left === 0
        ? "Dealing a problem…"
        : `The next problem is dealt after ${more}.`
      : "Every slot is full. Each slot earns a new problem per 300 clicks' worth of evaluations. Drop a problem to take one.";
  const due = plan(o)?.due;
  if (!due) return line;
  const why = spent(due, seedsPerProblem(o))
    ? `Every seed on ${problemTitle(due)} is spent.`
    : `${problemTitle(due)} has run ${evals(due.sinceGain)} without progress.`;
  return `${line} ${why} Auto-advance replaces it ${left > 0 ? `when the next problem is earned, after ${more}` : "as soon as a new problem is found"}.`;
}

/** The percentage a tolerance is: 10⁻⁶ is "0.0001 %". */
const fmtTolerance = (t: number) => `${(t * 100).toFixed(Math.max(0, Math.round(-Math.log10(t)) - 2))} %`;

/** Auto-advance's settings, once it is owned: the tolerance and the patience, and what they mean now. */
function renderAdvance(o: Owned): void {
  show("t-advance", o.has("advance"));
  if (!o.has("advance")) return;
  const { tolerance, patience } = state.settings;
  const tol = $<HTMLSelectElement>("t-tolerance");
  const pat = $<HTMLSelectElement>("t-patience");
  const tv = `1e${Math.round(Math.log10(tolerance))}`;
  const pv = patience === null ? "never" : String(patience);
  if (tol.value !== tv) tol.value = tv;
  if (pat.value !== pv) pat.value = pv;
  text(
    "t-advance-note",
    `A problem makes progress when its best is at least ${fmtTolerance(tolerance)} smaller than at its last progress. ` +
      (patience === null
        ? "Auto-advance keeps every problem in the queue, and the lanes go first to problems that are making progress."
        : `After ${evals(patience)} without progress, Auto-advance drops it as soon as a new problem can take its slot.`) +
      (state.settings.auto ? "" : " Auto-advance moves on only while auto-eval is on."),
  );
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
  event(none ? "Dealer filters cleared." : "Dealer filters saved.", false);
  persist();
  render();
  void dealTick();
}

/**
 * Takes a problem out of the queue (Drop, or Auto-advance): runs on it close and clicks queued for it
 * go. With an unsent best it stays, marked leaving, until that has been sent. Returns whether it left now.
 */
function dropProblem(key: string): boolean {
  for (const lv of lanes) {
    lv.jobs = lv.jobs.filter((j) => j.key !== key);
    if (lv.run?.key === key) {
      lv.run = null;
      void lv.lane.close();
    }
  }
  return drop(state, key, now());
}

function onDrop(key: string): void {
  const p = problem(state, key);
  if (!p) return;
  const unsent = p.phase === "ready" && !!p.run && hasUnsent(p) && !state.consent;
  if (unsent && !confirm(`Your best on ${problemTitle(p)} has not been sent. Drop it anyway?`)) return;
  const left = dropProblem(key);
  event(left ? `Dropped ${problemTitle(p)}.` : `Dropping ${problemTitle(p)} once its best has been sent.`, false);
  persist();
  showFocus();
  render();
  void submitTick();
  void dealTick();
}

/**
 * Auto-advance drops a problem exactly as Drop does, and says why; `next` is the problem dealt in
 * its place (none when nothing in the queue was left to run).
 */
function autoDrop(p: ProblemState, next?: ProblemKey): void {
  if (problem(state, p.key) !== p || p.leaving) return;
  const why = spent(p, seedsPerProblem(owned()))
    ? "because every seed on it has run until it stopped improving"
    : `after ${evals(p.sinceGain)} without progress`;
  const instead = next ? `, and ${problemTitle(next)} takes its slot` : "";
  const left = dropProblem(p.key);
  const message = left
    ? `Auto-advance dropped ${problemTitle(p)} ${why}${instead}.`
    : `Auto-advance is dropping ${problemTitle(p)} ${why}${instead}. It leaves the queue once its best has been sent.`;
  event(message, false);
  say(message);
  persist();
  scheduleRender();
  void submitTick();
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
  lanes.forEach((lv, i) => {
    const li = list.children[i] as HTMLElement;
    const line = li.querySelector(".t-lane-line") as HTMLElement;
    const q = lv.run ? problem(state, lv.run.key) : undefined;
    let msg: string;
    if (q && lv.run) {
      msg =
        `Lane ${i + 1}: ${problemTitle(q)} · ${lv.run.method}${o.has("seeds") ? ` · seed ${lv.run.seed}` : ""} · ` +
        `run at ${evals(lv.progress?.evaluations ?? lv.run.evaluations)}`;
      if (lv.jobs.length) msg += ` · ${lv.jobs.length} click${lv.jobs.length === 1 ? "" : "s"} waiting`;
    } else msg = `Lane ${i + 1}: no open run`;
    if (line.textContent !== msg) line.textContent = msg;
  });
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

// ---------- standing and records ----------

/** A span of time as the Standing panel shows it: "42 s", "3 min 05 s", "3 h 05 min", "2 d 4 h". */
function fmtSpan(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  const s = Math.floor((Math.max(0, ms) % 60_000) / 1000);
  if (m === 0) return `${s} s`;
  if (m < 60) return `${m} min ${String(s).padStart(2, "0")} s`;
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
  // the standing to spend and its multiplier are in the totals
  setStats("t-st-stats", [
    ["Standing earned in all", fmtInt(st.total)],
    [`Cycle ${fmtInt(st.resets + 1)} so far`, `${fmtRP(st.cycleEarned)} RP in ${fmtSpan(now() - st.cycleStartedAt)}`],
    ["Rule this cycle", st.rule ? ruleById(st.rule)!.name : "none"],
  ]);
  // the sense of speed: when this cycle reached each milestone, against the best cycle before
  setLines(
    "t-st-marks",
    MARKS.filter((m) => st.marks[m.id] !== undefined || bestMark(st, m.id) !== null).map((m) => {
      const t = st.marks[m.id];
      const best = bestMark(st, m.id);
      const reached =
        t === undefined
          ? "not yet this cycle"
          : t < 1000
            ? "at the start of this cycle"
            : `after ${fmtSpan(t)} this cycle`;
      return `${m.label}: ${reached}${best !== null ? ` (fastest earlier cycle ${best < 1000 ? "at the start" : fmtSpan(best)})` : ""}`;
    }),
  );
  const pv = resetPreview(state);
  const rule = ruleById(st.rule);
  text(
    "t-st-preview",
    pv.gain > 0
      ? `Reset now for ${fmtInt(pv.gain)} standing${pv.ruleBonus ? `, ${fmtInt(pv.ruleBonus)} of it for finishing under ${rule!.name}` : ""}. ` +
          `All points would then pay ×${(standingMultiplier(st) + 0.1 * pv.gain).toFixed(1)} instead of ×${standingMultiplier(st).toFixed(1)}. ` +
          `The next point of standing comes at ${fmtInt(pv.nextAt)} confirmed RP in this cycle.`
      : `A reset needs ${fmtInt(RESET_MIN)} RP earned in this cycle and confirmed by the server, so ${fmtInt(Math.ceil(pv.short))} more to go. ` +
          `It then gives ⌊√(cycle RP / ${fmtInt(RESET_MIN)}) + records held / ${HELD_PER_STANDING}⌋ standing.`,
  );
  const btn = $<HTMLButtonElement>("t-st-reset");
  btn.disabled = pv.gain <= 0 || !ownsGame;
  show("t-st-reset", !confirmingReset);
  show("t-st-confirm", confirmingReset && pv.gain > 0);
  if (confirmingReset) {
    const kept = [
      pv.held === 1 ? "the 1 record you hold and its rent" : `the ${fmtInt(pv.held)} records you hold and their rent`,
      `your collections (+${fmtPct(collectionsBonus(state, o), 0)})`,
      "Standing and every standing upgrade",
      o.has("keepAuto") ? "the Auto-eval upgrades" : "",
      o.has("keepMethods") ? "your methods" : "",
      "the queue, what the dealer has learned and every count",
    ].filter(Boolean);
    const next = ruleById(st.nextRule);
    text(
      "t-st-confirm-text",
      `You get ${fmtInt(pv.gain)} standing and give up ${fmtRP(state.rp)} RP to spend and ${fmtInt(pv.loses.length)} upgrade${pv.loses.length === 1 ? "" : "s"}. ` +
        `You keep ${andList(kept)}. The next cycle begins with ${fmtInt(pv.keeps.length)} upgrades` +
        (next ? ` and is played under ${next.name}. ${next.limit}` : "."),
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
        ? `${chosen.name}. ${chosen.limit} Finishing a cycle under it gives half again the standing (at least 1 more)` +
          (st.rulesDone.includes(chosen.id)
            ? ". You have finished it before, so its reward already holds."
            : `, and from then on ${lowerFirst(chosen.reward)}`)
        : "No rule chosen. A rule limits the next cycle, and finishing a cycle under it pays extra standing and a reward that stays for good.") +
        (st.rulesDone.length ? ` Finished so far: ${andList(st.rulesDone.map((id) => ruleById(id)!.name))}.` : ""),
    );
  }
  // what only standing buys
  const left = UPGRADES.filter((u) => u.currency === "standing" && costOf(o, u.id) !== null);
  text(
    "t-st-only",
    left.length
      ? `Standing buys ${andList(left.map((u) => `${u.name} (${fmtInt(costOf(o, u.id)!)})`))}. They are in the tech tree's Standing row, and every reset keeps them.`
      : "You own every standing upgrade.",
  );
  show("t-st-history-box", st.history.length > 0);
  setLines(
    "t-st-history",
    st.history
      .map(
        (h, i) =>
          `Cycle ${i + 1 + Math.max(0, st.resets - st.history.length)} lasted ${fmtSpan(h.endedAt - h.startedAt)} and earned ${fmtRP(h.earned)} RP and ${fmtInt(h.gain)} standing${h.rule ? `, under ${ruleById(h.rule)?.name ?? h.rule}` : ""}.`,
      )
      .reverse(),
  );
}

function renderRecords(o: Owned): void {
  const rent = o.has("rent");
  const col = o.has("collections");
  show("t-records", rent || col);
  if (!rent && !col) return;
  // the records held are in the totals
  const rows: [string, string][] = [];
  if (rent) {
    rows.push(["Rent per hour", `${fmtRP(rentRate(state, o))} RP`]);
    rows.push(["Rent waiting for a check", `about ${fmtRP(rentWaiting(state, o, now()))} RP`]);
    rows.push(["Rent paid", `${fmtRP(state.economy.rentPaid)} RP`]);
  }
  const c = collections(state.economy);
  if (col) rows.push(["Collections", `+${fmtPct(c.bonus, 0)} on all points`]);
  setStats("t-rc-stats", rows);
  const last = state.economy.lastRent;
  text(
    "t-rc-note",
    rent
      ? "Each record you hold is checked in turn and paid the rent it built up since its last check." +
          (last
            ? ` The last check paid +${fmtRP(last.rp)} RP on ${titleOf(last.key)}, ${fmtAgo(now() - last.at)}.`
            : "")
      : "",
  );
  if (!col) {
    setLines("t-rc-sets", []);
    return;
  }
  const pairName = (n: { N: number; M: number }) => problemTitle({ ...n, P: 0 }).replace(/, 0 pieces$/, "");
  const lines = [
    `${fmtInt(c.pairs)} complete frontier pair${c.pairs === 1 ? "" : "s"}, with a record on all ${FRONTIER_P.length} piece counts (+${fmtPct(PAIR_BONUS, 0)} each).` +
      (c.nearest.length
        ? ` The closest to complete ${c.nearest.length === 1 ? "is" : "are"} ${andList(c.nearest.map((n) => `${pairName(n)} (${n.have} of ${FRONTIER_P.length})`))}.`
        : ""),
    `${fmtInt(c.milestones)} shape milestone${c.milestones === 1 ? "" : "s"} at ${andList(SHAPE_MILESTONES.map(String))} records with one piece shape (+${fmtPct(SHAPE_BONUS, 0)} each).` +
      (c.shapes.length
        ? ` Your most recorded pieces are ${andList(c.shapes.slice(0, 3).map((x) => `${shapeName(x.N, true)} (${fmtInt(x.count)})`))}.`
        : ""),
    `First records by tier: ${c.tiers.length ? andList(c.tiers.map((t) => TIER_LABEL[t as Tier] ?? t)) : "none yet"} (+${fmtPct(TIER_BONUS, 0)} each).`,
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
  // let the stopped jobs settle first (an auto-eval job that could not run is due again)
  await new Promise((r) => setTimeout(r, 0));
  const rule = ruleById(state.standing.rule);
  const gain = resetCycle(state, now());
  ensureLanes();
  lastChange.clear();
  banner = null;
  if (gain > 0) {
    const st = state.standing;
    const next = ruleById(st.rule);
    event(
      `Reset for ${fmtInt(gain)} standing. All points now pay ×${standingMultiplier(st).toFixed(1)}.` +
        (rule ? ` You finished a cycle under ${rule.name}, and its reward holds for good.` : ""),
    );
    say(
      `Cycle ${fmtInt(st.resets + 1)} begins with ${fmtInt(state.owned.length)} upgrades.` +
        (next ? ` It is played under ${next.name}. ${next.limit}` : "") +
        " Your records stay on the server and keep paying rent.",
    );
  }
  saveNow();
  showFocus(true);
  render();
  kickLanes();
  void dealTick();
}

// ---------- dialogs: the first record's pop-up, and Settings ----------

const welcome = $<HTMLDialogElement>("t-welcome");
const settingsDialog = $<HTMLDialogElement>("t-settings");

/** The name-and-consent form lives in Settings; the first record's pop-up borrows it. */
function placeConsent(into: "welcome" | "settings"): void {
  const slot = $(into === "welcome" ? "t-welcome-slot" : "t-settings-slot");
  const form = $("t-consent");
  if (form.parentElement !== slot) slot.append(form);
}

/** The first record found: a pop-up over the board asks for a name (it does not stop the game). */
function openWelcome(): void {
  if (settingsDialog.open) return;
  placeConsent("welcome");
  renderConsent();
  if (!welcome.open) welcome.show();
  $("t-name").focus();
}

function closeWelcome(): void {
  if (welcome.open) welcome.close();
  placeConsent("settings");
}

function openSettings(focusName = false): void {
  closeWelcome();
  renderConsent();
  if (!settingsDialog.open) settingsDialog.showModal();
  if (focusName) $("t-name").focus();
}

$("t-open-settings").addEventListener("click", () => openSettings());
$("t-settings-close").addEventListener("click", () => settingsDialog.close());
// a press on the backdrop closes Settings
settingsDialog.addEventListener("click", (e) => {
  if (e.target === settingsDialog) settingsDialog.close();
});
$("t-name-nudge").addEventListener("click", () => openSettings(true));
$("t-welcome-later").addEventListener("click", () => {
  closeWelcome();
  say(
    "Your record stays in this browser and pays no points until you send it. You can add your name at any time in Settings.",
  );
});
$("t-tab-board").addEventListener("click", () => setView(false));
$("t-tab-tree").addEventListener("click", () => setView(true));
// the tabs as a tab list: the arrow keys move between them
for (const id of ["t-tab-board", "t-tab-tree"])
  $(id).addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    setView(!treeOpen);
    $(treeOpen ? "t-tab-tree" : "t-tab-board").focus();
  });
// Cheats for local playtesting, in Settings: a production build leaves the module out
if (import.meta.env.DEV)
  void import("./cheats").then(({ mountCheats }) =>
    mountCheats(settingsDialog.querySelector<HTMLElement>(".t-dialog-body")!, {
      state: () => state,
      canChange: () => ownsGame,
      changed: () => {
        persist();
        render();
      },
    }),
  );

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
$("t-evolve").addEventListener("click", () => press());
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
  // it earns from now: nothing is owed for the time it was off
  accrueAuto();
  state.settings.auto = !state.settings.auto;
  accrueAuto();
  say(
    state.settings.auto
      ? `Auto-eval is on. It clicks for you at ${fmtRate((autoPerSecond(o) ?? 0) * laneCount(o))} in all, beside your own clicks.`
      : "Auto-eval is off.",
  );
  persist();
  render();
  kickLanes();
});
$("t-stop").addEventListener("click", stopAll);
$("t-tolerance").addEventListener("change", () => {
  const t = Number($<HTMLSelectElement>("t-tolerance").value);
  if (!TOLERANCES.includes(t)) return;
  state.settings.tolerance = t;
  persist();
  render();
});
$("t-patience").addEventListener("change", () => {
  const v = $<HTMLSelectElement>("t-patience").value;
  const w = v === "never" ? null : Number(v);
  if (!PATIENCES.includes(w)) return;
  state.settings.patience = w;
  persist();
  render();
  void dealTick();
});
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
        ? "That name is empty once cleaned the way PolyPack stores names, which removes angle brackets and control characters. Choose another name."
        : "Enter a display name first. Records are sent to PolyPack under that name.",
    );
    text("t-consent-note", "Nothing is sent until you enter a name.");
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
      ? `Your records will be sent to PolyPack as “${name}”.${paid > 0 ? ` Your improvements so far paid +${fmtRP(paid)} RP.` : ""}`
      : `Nothing will be sent, and your records stay in this browser.${withdrawn > 0 ? ` The ${fmtRP(withdrawn)} RP the server had not confirmed yet were taken back. They are paid again when you send again.` : ""}`,
  );
  event(agree ? `Sending records as “${name}”.` : "Sending is off.", false);
  closeWelcome();
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
    text("t-save-note", "The browser did not allow copying, so copy the save string above yourself.");
  }
});
$("t-import").addEventListener("click", async () => {
  const r = await importString($<HTMLTextAreaElement>("t-save-text").value, now());
  if (!r.ok) {
    text("t-save-note", `The save could not be imported (${r.error}).`);
    return;
  }
  if (!confirm("Replace your current game with this save? Your current game is lost unless you exported it first."))
    return;
  for (const l of lanes) l.lane.terminate();
  lanes.length = 0;
  state = r.state;
  syncEconomy(state);
  state.settings.auto = false;
  lastChange.clear();
  banner = null;
  savesDisabled = false;
  ensureLanes();
  saveNow();
  showFocus(true);
  text("t-save-note", "Save imported.");
  render();
});

// ---------- "How it works" ----------

// tighter.html places each explanation as an empty disclosure named by data-how; help.ts holds the text
for (const d of document.querySelectorAll<HTMLElement>("details[data-how]")) {
  const how = HELP[d.dataset.how ?? ""];
  if (how) for (const h of Array.isArray(how) ? how : [how]) d.append(renderHow(h));
}

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
  state.autoAt = now();
  applyHold();
  listen();
  void dealTick();
  void refreshHeld();
  ticker = window.setInterval(() => {
    void dealTick();
    void submitTick();
    void settleLost();
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
      ? "Tighter was opened in another tab, which now runs the game. Nothing runs in this tab."
      : "Tighter is open in another tab. Only one tab runs the game at a time, so nothing runs in this tab.",
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
