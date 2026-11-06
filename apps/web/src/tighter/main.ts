import { MAX_PIECES, evaluate, eventKeys, improvesOn } from "@polypack/geometry";
import type { Container, LeaderboardEvent, PackingConfig, ProblemInfo } from "@polypack/geometry";
import type { SpaceConfig, SpaceProblemSummary } from "@polypack/spaces";
import * as api from "../api";
import { Board } from "../board";
import { BoardView } from "../view";
import {
  AUTO_CLICK_EVALS,
  DEAL_CLICKS,
  DealerState,
  canDeal,
  clicksToNextDeal,
  contestedCandidates,
  contestedDealable,
  drawContestedPair,
  filterSources,
  nextRandom,
  openDealable,
  pickSource,
  publishedTarget,
  retakeTier,
  sourceOdds,
  takeToken,
} from "./dealer";
import type { SourceReach } from "./dealer";
import { FinderDeps, Pool, TakenCache, findOpen, firstDealPools } from "./open-finder";
import { SpaceBoard, mountSpaceBoard, spaceScoreBox } from "./board-space";
import {
  ListedSpace,
  ListedSpaceProblem,
  RuleLimits,
  SpaceListings,
  drawSliceProblem,
  listingOf,
  sliceHasCircles,
} from "./catalogue";
import { problemTitle, rulesOf } from "./families";
import {
  FRONTIER,
  ProblemKey,
  STARTER,
  SpaceKey,
  isPolygon,
  keyOf,
  keyPart,
  needPolygon,
  parseKey,
  poly,
  shapeName,
  DimensionId,
  familyDimension,
} from "./frontier";
import {
  AdvancePlan,
  GameState,
  Leader,
  DEFAULT_PATIENCE,
  PATIENCE_MAX,
  PATIENCE_MIN,
  parsePatience,
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
  countEvaluations,
  countedEvals,
  density,
  endRunAtStall,
  drop,
  evolvable,
  followed,
  hasUnsent,
  leave,
  log,
  markSending,
  newGame,
  newProblem,
  openedRun,
  ownedSet,
  polygonBoard,
  pay,
  problem,
  recordsHeld,
  reveal,
  reserveSeed,
  runSeed,
  revealed,
  seenKeys,
  slotted,
  stallAfter,
  stallEnds,
  submitTarget,
  multiplierFor,
  type PaidPoints,
} from "./game";
import {
  COMBO_BONUS,
  COMBO_RECORDS,
  SHAPE_BONUS,
  SHAPE_MILESTONES,
  TIER_BONUS,
  collections,
  collectionsBonus,
  nextPaydayAfter,
  paydayDueAt,
  rentRate,
  rentWaiting,
  syncEconomy,
  tidyRent,
} from "./economy";
import { Lane, NOT_ISOLATED, isSpaceRunState } from "./lanes";
import { methodGame, methodLabel, runSetup, warmIn, warmupOf } from "./methods";
import { latticeDue, latticeStep } from "./methods/lattice";
import type { RunStage, RunView } from "./methods";
import type { RunState } from "./open-run";
import {
  OFFLINE_BACKOFF_MS,
  RATE_LIMITED_BACKOFF_MS,
  canSend,
  compact as compactPacer,
  pause,
  recordSend,
} from "./pacer";
import { Offer, addRetake, expireOffers, offerFits, skipOffer } from "./picks";
import { HolderReader, addRival, heldByTighter, heldKeys, removeRival } from "./rivals";
import { SLICES, SliceId, sliceById } from "./slices";
import { openSlices } from "./unlocks";
import { GROUPS, SOURCES, income } from "./income";
import { FIRST_BONUS, LEAD_BONUS, TIERS, TIER_LABEL, Tier, costFactor, shapeWeight, show6 } from "./points";
import { bonusKindOf, bonusRow, multiplierRow, multiplierTitle, payDetail } from "./pay-text";
import { HELP, MIN_STEP, andList, lowerFirst, smallerText, superscript } from "./help";
import { moreDetail } from "./detail";
import { renderMechanics } from "./mechanics";
import {
  Candidate,
  Filters,
  Ranked,
  collectorTargets,
  formatShapes,
  msPerEval,
  parseShapes,
  passes,
  rankCandidates,
} from "./rank";
import {
  AUTO_LIMIT_WARNING,
  AUTO_METER_CARD,
  AUTO_METER_NOTE,
  AutoMeter,
  Speeds,
  autoHold,
  autoOverLimit,
  autoTarget,
  laneSplit,
  meterShare,
} from "./scheduler";
import {
  RetiredRefund,
  SAVE_FAILED_TEXT,
  STORAGE_KEY,
  tryWrite,
  exportString,
  fromJson,
  importString,
  toExportJson,
  toJson,
} from "./save";
import { Archive, archiveOf, archiveReady, attachArchive, idbStore, newArchiveId } from "./archive";
import { recoverRecords } from "./recovery";
import { renderPace } from "./render-pace";
import { PHONE_QUERY, TreeRenderer, treeSummary, treeView } from "./shop";
import {
  DIMENSION_TEXT,
  MARKS,
  RULES,
  bestMark,
  markProgress,
  grantHeadStart,
  fundsOf,
  resetCycle,
  resetPreview,
  ruleAllowsMethod,
  ruleAllowsProblem,
  ruleById,
  ruleOpenProblems,
  ruleOpenWide,
  SMALL_PIECES,
  standingMultiplier,
} from "./standing";
import {
  RunRecord,
  Trouble,
  answerTrouble,
  classifyAnswer,
  orientBoard,
  shouldSubmit,
  submissionBody,
  troubleText,
} from "./submission";
import {
  BoardStage,
  RunChoice,
  boardStage,
  chooseRun,
  observeRun,
  pipelineMethod,
  planRandom,
  problemKind,
} from "./runplan";
import { renderRunsPanel } from "./runs-ui";
import { runPayday } from "./payday";
import { TransferStart, chooseStart, neighbourPs, scoredTransfer } from "./transfer";
import { sanitizeName } from "./names";
import { bindNamePopup, showNamePopup } from "./name-popup";
import { runTutorial } from "./tutorial";
import {
  SpaceRead,
  classifySpaceAnswer,
  fetchSpaceProblem,
  postSpaceSubmission,
  spaceDealable,
  spaceStands,
  spaceSubmissionBody,
  spaceTier,
} from "./space-submission";
import type { SpaceRunState } from "./space-run-types";
import {
  COMPACT_EVALS,
  EvolveMethod,
  Owned,
  RUN_BUDGET,
  UpgradeId,
  AUTO_SLACK_SECONDS,
  autoCap,
  autoJobEvals,
  autoPerSecond,
  autoRateText,
  canBuy,
  cores,
  SWITCHES,
  dealerChoices,
  evalsPerClick,
  inUse,
  laneCount,
  lanesMaxed,
  level,
  methodParams,
  methods,
  offText,
  offerCount,
  queueSize,
  ringMin,
  switchName,
  switchOf,
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
/** "side", or "diameter" for a circle container (families.ts scoreWord). */
/** GET /api/problems for a polygon problem. */
const getProblem = (p: ProblemKey) => {
  const q = needPolygon(p, "the problem read");
  return api.getProblem(q.N, q.M, q.P);
};
/** The gap of a score to the problem's lower bound, s / b − 1. */
const gapTo = (p: ProblemKey & { bound?: number | null }, s: number): number =>
  s / (isPolygon(p) ? rulesOf(p).bound(p)! : (p.bound ?? NaN)) - 1;
const sideWord = (p: ProblemKey) => rulesOf(p).scoreWord(p);

/**
 * The milliseconds of one evaluation that auto-eval's speed terms count from: the problem's family
 * rules (families.ts evalMs), a polygon problem's by its size and a space problem's from the
 * measured kernel evaluations its game evaluation is.
 */
const tableMsOf = (p: ProblemKey): number => rulesOf(p).evalMs(p);
/** The board's stage for Method match: fresh until a run on it ends by itself or it reaches its patience without progress. */
const stageOf = (p: ProblemState): BoardStage => boardStage(p.endedRuns, p.sinceGain, stallAfter(state, p));
/** The kind of problem the bandit learns a problem's methods for: its tier, family (polygons: size and piece shape) and stage. */
const kindOf = (p: ProblemState & { tier: string }): string =>
  isPolygon(p) ? problemKind(p, stageOf(p)) : `${p.tier}|${p.family}|${stageOf(p)}`;

/** What a read of a problem's leader gives: whether it takes entries, and who leads it. */
interface LeaderRead {
  accepts: boolean;
  leader: Leader | null;
}
/** Space problems have no live feed: their leaders and rents are read at most once in this time, across all of them. */
const SPACE_READ_MS = 10_000;
let spaceReadAt = -Infinity;

/** A problem's leader from the server just now, whatever its family; null when it could not be read. */
async function readLeader(p: ProblemKey): Promise<LeaderRead | null> {
  if (isPolygon(p)) {
    const info = await getProblem(p);
    if (!info) return null;
    const lead = info.site_best;
    return {
      accepts: info.accepts_submissions,
      leader: lead ? { score: lead.score, name: lead.name, id: lead.id } : null,
    };
  }
  spaceReadAt = now();
  const { read } = await fetchSpaceProblem(p.family, p.id);
  return read ? { accepts: read.accepts, leader: read.leader } : null;
}
/**
 * Auto-eval's target from its evaluations a second: "up to 1 evaluation a second", "up to 2.5
 * evaluations a second". A target, never a claim: a computer that cannot keep up runs fewer.
 */
const fmtRate = (r: number) => `up to ${autoRateText(r)}`;

// ---------- state and saving ----------

let savesDisabled = false;
let startNote: string | null = null;
/** Upgrades Head start gave a loaded save that owned it without them. */
let startHeadGiven = 0;
/** What a save from before version 4's points and prices was given, said once as it is read (save.ts). */
const rescaleNote = (f: number) =>
  `Record points now pay mostly for how much smaller a board gets. Prices went up too. Your points were multiplied by ${f.toFixed(1)}, so they buy what they did before.`;
/** What a save from before auto-eval's lower prices was given back, said once as it is read. */
const refundNote = (rp: number) =>
  `Auto-eval upgrades now cost a tenth of what they did, so you got ${fmtInt(rp)} RP back for the ones you had bought.`;
/** What the ladder of 2026-10-27 paid back to a save (save.ts migration 7), said once as it is read. */
const ladderNote = (rp: number) =>
  `Auto-eval now has one ladder of small steps. You keep your rate and get ${fmtInt(rp)} RP back.`;
/** What the cheaper ladder of Faster auto-eval paid back to a save (save.ts migration 9), said once as it is read. */
const c3Note = (rp: number) =>
  `Faster auto-eval is cheaper now. You got back ${fmtInt(rp)} RP, the difference for the levels you own.`;
/** What version 11's change of standing paid back to a save (save.ts standingRework), said once as it is read. */
const standingNote = (r: { standing: number; rp: number; resets: number }) =>
  "Resets work differently now. You reset by buying the Standing card in the tech tree, and you buy it again for each reset. Each reset gives 1 standing point, or 2 under a rule, and doubles all your points. Every Standing-row option now costs 1 standing point, and the three Head starts are one upgrade with 3 levels. Records pay rent, Higher rent and Collections now go at a reset, unless Head start gives them back." +
  (r.standing > 0
    ? ` You got ${fmtInt(r.standing)} standing points back for what you had paid above the new prices.`
    : "") +
  (r.rp > 0 ? ` You had bought Standing without a reset, so you got ${fmtRP(r.rp)} RP back.` : "") +
  (r.resets > 0
    ? ` You keep your ${fmtInt(r.resets)} resets, so your points now pay ×${fmtInt(Math.pow(2, r.resets))}.`
    : "");
/** Said once to a save that had reset, when it is read (save.ts migration 4). */
const REBALANCED_NOTE =
  "Tighter changed, and resets now work differently. Your standing was cleared, and the record points your finished cycles earned are back to spend. Your records and upgrades are kept.";
/** What the unit change of 2026-10-27 did to a save (save.ts migration 5), said once as it is read. */
function unitsNote(u: { converted: number; dropped: number }): string {
  const one = (n: number) => n === 1;
  const parts = ["Disks and balls now have diameter 1. A circle or ball container is measured by its diameter."];
  if (u.converted > 0)
    parts.push(
      `${fmtInt(u.converted)} of your problems ${one(u.converted) ? "uses them and was" : "use them and were"} converted. The packings are the same. Only the numbers changed.`,
    );
  if (u.dropped > 0)
    parts.push(
      `${fmtInt(u.dropped)} curved ${one(u.dropped) ? "problem" : "problems"} with disk pieces ${one(u.dropped) ? "was" : "were"} removed, because the change made ${one(u.dropped) ? "it a different problem" : "them different problems"}.`,
    );
  return parts.join(" ");
}
/** What a save's retired upgrades paid back (save.ts RETIRED), said once as it is read. */
function retiredNote(r: RetiredRefund): string {
  const paid = [r.rp > 0 ? `${fmtInt(r.rp)} RP` : "", r.standing > 0 ? `${fmtInt(r.standing)} standing` : ""];
  return `The ${andList(r.groups)} upgrades are gone from the tech tree. You got ${andList(paid.filter(Boolean))} back.`;
}

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
    startNote = "This browser does not let the page keep a save, so your game is lost when you close the tab.";
  }
  if (text) {
    const r = fromJson(text, now());
    if (r.ok) {
      const notes = [
        r.rescaled ? rescaleNote(r.rescaled) : "",
        r.refunded ? refundNote(r.refunded) : "",
        r.retired ? retiredNote(r.retired) : "",
        r.rebalanced ? REBALANCED_NOTE : "",
        r.units ? unitsNote(r.units) : "",
        r.ladder ? ladderNote(r.ladder.rp) : "",
        r.c3 ? c3Note(r.c3.rp) : "",
        r.standing ? standingNote(r.standing) : "",
        r.headStart ? headStartNote(r.headStart) : "",
      ];
      startHeadGiven = r.headStart ?? 0;
      if (notes.some(Boolean)) startNote = notes.filter(Boolean).join(" ");
      return r.state;
    }
    if (/newer version/.test(r.error)) {
      // never overwrite a save this version cannot read
      savesDisabled = true;
      startNote = `Your save is from a newer version of Tighter, so this page leaves it alone and plays without saving.`;
    } else {
      try {
        localStorage.setItem(`${STORAGE_KEY}.unreadable.${Date.now()}`, text);
      } catch {
        // nothing more to keep
      }
      startNote = `Your save could not be read (${r.error}). It was set aside, and a new game started.`;
    }
  }
  return newGame(now(), seed);
}

let state = initialState();
// collections and the first cycle's earnings, for a save from before records were an economy
syncEconomy(state);
// the records past the save's limit live in IndexedDB (archive.ts): they load right after the save,
// from the database this save names (it is written with the save before any row is)
state.archiveId ??= newArchiveId();
attachArchive(state, new Archive(idbStore(state.archiveId)));
try {
  // ask the browser not to clear the archive when it is short of space
  void navigator.storage?.persist?.().catch(() => undefined);
} catch {
  // not offered
}
const archiveLoaded: Promise<void> = (() => {
  let known: Set<string> | null = null;
  return archiveOf(state)!
    .load((key) => (known ??= new Set([...state.queue, ...state.past].map((p) => p.key))).has(key))
    .then(() => undefined);
})();
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
  // storage full or unavailable: the game goes on in memory, and the player is told until a save works
  const ok = tryWrite(() => {
    state.pacer = compactPacer(state.pacer, now());
    localStorage.setItem(STORAGE_KEY, toJson(state));
  });
  // the archive writes only the rows that changed
  void archiveOf(state)?.flush();
  const warning = $("t-save-warning");
  warning.textContent = ok ? "" : SAVE_FAILED_TEXT;
  warning.hidden = ok;
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
const basePoints = (p: ProblemState) => p.base ?? p.rp;
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
  const q = needPolygon(p, "the area bound ghost");
  return {
    M: q.M,
    cx: around?.cx ?? 0,
    cy: around?.cy ?? 0,
    phi: around?.phi ?? 0,
    size: rulesOf(q).bound(q)!,
  };
}

/** The drawing of the focused space problem, in the place of the canvas (board-space.ts); null while a polygon problem is shown. */
let spaceBoard: { key: string; board: SpaceBoard } | null = null;
const spaceHost = $("t-space-board");
const boardCanvas = $<HTMLCanvasElement>("board");

/** Shows the canvas again, and drops the space drawing. */
function useCanvas(): void {
  if (!spaceBoard) return;
  spaceBoard.board.destroy();
  spaceBoard = null;
  spaceHost.hidden = true;
  boardCanvas.hidden = false;
}

/** A space problem's board (the board field holds a SpaceConfig for these), null while its pieces are being placed. */
const spaceConfig = (p: ProblemState): SpaceConfig | null =>
  p.phase === "bare" ? null : (p.board as unknown as SpaceConfig | null);

/** Shows a space problem's packing with the site's own drawing, in the canvas's place. */
function showSpace(p: ProblemState & SpaceKey): void {
  if (spaceBoard?.key !== p.key) {
    spaceBoard?.board.destroy();
    boardCanvas.hidden = true;
    spaceHost.hidden = false;
    spaceBoard = {
      key: p.key,
      board: mountSpaceBoard(spaceHost, { family: p.family, id: p.id, P: p.P, board: spaceConfig(p) }),
    };
  }
  // a configuration the page has not made yet is drawn as empty
  spaceBoard.board.show(spaceConfig(p));
}

/** The phone layout (tighter.css, "phones"): the dock's panes replace each other there. */
const phoneLayout = matchMedia(PHONE_QUERY);

/**
 * Whether the board is out of sight: the tech tree is open, or on a phone the queue or the points
 * pane is. It follows the page's own state, not the layout, so asking is cheap: reading the
 * canvas's size on every render would force a layout. The dock's pane only hides the board on the
 * phone layout (on wider screens the panel sits beside it), hence the media query.
 */
const boardHidden = (): boolean => treeOpen || (phoneLayout.matches && (pane === "queue" || pane === "points"));

let shown = "";
/** A forced refit that came while the board was hidden: done when it is next drawn. */
let refitOnShow = false;
/**
 * Puts the focused problem's board on the canvas, when it changed; a new problem is placed at once.
 * While the board is hidden only the game's part runs; `shown` stays, so showing it again draws it.
 */
function showFocus(force = false): void {
  const p = focused();
  if (p && p.phase === "bare" && ownsGame && !loading.has(p.key)) void loadAll(p).then(() => showFocus());
  if (boardHidden()) {
    refitOnShow ||= force;
    return;
  }
  force ||= refitOnShow;
  refitOnShow = false;
  const sig = p ? `${p.key}|${p.phase}|${p.best}` : "";
  if (!force && sig === shown) return;
  const refit = !p || !shown.startsWith(`${p.key}|`) || force;
  shown = sig;
  view.setPreview(null);
  if (p && !isPolygon(p)) {
    showSpace(p);
    return;
  }
  useCanvas();
  if (!p) {
    board.load({ N: 0, M: 0, P: 1, pieces: [], container_phi: 0 }, false);
    view.ghost = null;
    view.fit();
    return;
  }
  const q = needPolygon(p, "the board");
  const config: PackingConfig = polygonBoard(p) ?? { N: q.N, M: q.M, P: q.P, pieces: [], container_phi: 0 };
  if (board.load(config, false)) board.load({ N: q.N, M: q.M, P: q.P, pieces: [], container_phi: 0 }, false);
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
  // the space drawing fits itself to its box
  if (spaceBoard) return;
  view.fit();
  const canvas = $<HTMLCanvasElement>("board");
  const w = canvas.clientWidth,
    h = canvas.clientHeight;
  if (!c || !(c.size > 0) || !w || !h) return;
  // distance from the centre to a vertex (polygon) or the rim (circle, whose size is its diameter)
  const reach = c.M === 0 ? c.size / 2 : c.size / (2 * Math.sin(Math.PI / c.M));
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
  // the board may have come back into view with a packing it has not drawn yet
  showFocus();
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
  /**
   * The player's parameters (methodParams: an upgrade that changes them starts a new run), and the
   * run's as the solver resolved them, after the method's runParams.
   */
  asked: string;
  params: Record<string, unknown>;
  seed: number;
  /** Evaluations the run may do in all (the method's runBudget), and its first that are its warm-up (warmup). */
  budget: number;
  warmup: number;
  /** Evaluations the run has done, its start's scoring included. */
  evaluations: number;
  /** After its latest step: its latest valid score, its best, what its method found and its latest sub-run (RunState). */
  last: number | null;
  runBest: number | null;
  found: number | null;
  /** Finished packings its method has handed back (a space run reports it; a 2D run does not), and the count at the problem's last progress. */
  offers?: number;
  offersAtGain: number;
  /** The offers already counted into the problem's offersSinceGain. */
  offersCounted: number;
  stage?: RunStage;
  /** The board it opened from (the method's startFrom), and the problem's best then. */
  origin: PackingConfig | SpaceConfig | null;
  startScore: number | null;
  /** For the bandit: the kind of problem, the problem's RP and the run's evaluations when it opened. */
  kind: string;
  rpAt: number;
  evalsAt: number;
}

/** The run's counters from a state the worker sent (after a step). */
function track(run: OpenRunView, st: RunState | SpaceRunState): void {
  run.evaluations = st.evaluations;
  run.last = st.last;
  run.runBest = st.score;
  run.found = st.found;
  run.offers = isSpaceRunState(st) ? st.offers : undefined;
  run.stage = st.stage;
}

/** The run as its method's texts see it (methods/types.ts), with a long step's live state when one goes. */
function runView(run: OpenRunView, p: ProblemState | undefined, live?: RunState | null): RunView {
  const st = live ?? null;
  return {
    evaluations: st?.evaluations ?? run.evaluations,
    budget: run.budget,
    params: run.params,
    warmup: run.warmup,
    last: st ? st.last : run.last,
    runBest: st ? st.score : run.runBest,
    found: st ? st.found : run.found,
    stage: st ? st.stage : run.stage,
    startScore: run.startScore,
    problemBest: p?.best ?? null,
  };
}

/** Who chose a run's method: Compact, the select, Method match, the pipeline, or the problem's Lattice build. */
type RunMode = "compact" | "select" | "auto" | "pipeline" | "lattice";

interface LaneView {
  lane: Lane;
  run: OpenRunView | null;
  jobs: Job[];
  pumping: boolean;
  current: Job | null;
  /** The open run's state during a long step (Compact's, or many evaluations a click). */
  progress: RunState | null;
  /** Auto-eval's evaluations this lane may still take (its share of the rate, as accrued; below zero: owed). */
  autoDue: number;
  /** This lane's share of auto-eval's rate at the last accrual, evaluations a second (laneSplit). */
  autoRate: number;
}

/** Most clicks a lane holds before it has caught up; more are not taken. */
const MAX_QUEUED_CLICKS = 20;

const lanes: LaneView[] = [];
/** The lanes that run: those owned, or fewer where the player's "Lanes in use" setting says so. */
const lanesWanted = (o: Owned) => Math.max(1, Math.min(laneCount(o), state.settings.lanesInUse ?? Infinity));
/**
 * As many lanes as the player owns (up to the CPU's cores less one). A lane no longer owned (after a
 * reset) goes once it is idle: its run closes, its worker stops, and auto-eval's jobs it held are
 * due again.
 */
function ensureLanes(): void {
  const want = lanesWanted(owned());
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
      autoDue: 0,
      autoRate: 0,
    };
    lv.lane.onProgress = (s) => {
      // a space run reports at its steps only: its live progress is not drawn yet
      if (isSpaceRunState(s)) return;
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
/** The keys of the problems a lane is running evaluations on now, or has jobs queued for (an open run alone is not work). */
const workingKeys = (l: LaneView) => [l.current?.key, ...l.jobs.map((j) => j.key)].filter((k): k is string => !!k);
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
async function findTransfer(p0: ProblemState): Promise<TransferStart | null> {
  const p = needPolygon(p0, "Transfers");
  const own = state.queue
    .filter(
      (q) =>
        q !== p0 && isPolygon(q) && q.N === p.N && q.M === p.M && q.P < p.P && q.board && q.phase !== "bare" && !!q.run,
    )
    .sort((a, b) => b.P - a.P)[0];
  let best = own && polygonBoard(own) ? scoredTransfer(polygonBoard(own)!, p) : null;
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
async function loadAll(p0: ProblemState): Promise<boolean> {
  if (!isPolygon(p0)) return loadAllSpace(p0);
  const p = needPolygon(p0, "Load all");
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
      say(`The pieces could not be placed on a valid board (${e.reasons.join(", ")}).`);
      return false;
    }
    config.container_phi = e.container.phi;
    // A record for P + 1 minus any one piece packs P pieces in no more room: it is part of the floor.
    // a lookup that fails is no trim floor: the start goes on without it
    const next = p.P < MAX_PIECES ? await api.getProblem(p.N, p.M, p.P + 1).catch(() => null) : null;
    const trim = next?.site_best && next.site_best.verification !== "pending" ? next.site_best.score : null;
    const transfer = owned().has("transfer") ? await findTransfer(p).catch(() => null) : null;
    if (problem(state, p.key) !== p || p.phase !== "bare") return p.phase !== "bare";
    const start = chooseStart({ board: config, score: e.score }, trim, transfer);
    applyLoadAll(p, start.board, start.score, trim);
    reveal(state, "score");
    if (p.key === state.focus) {
      const b0 = rulesOf(p).bound(p)!;
      const side = sideWord(p);
      // the starting score: what the first record must beat (the code's free floor)
      const startingScore =
        p.floor! < start.score
          ? `The record for ${p.P + 1} pieces, with one piece removed, fits ${p.P} pieces in a smaller ${side} (${show6(p.floor!)}). ` +
            "Your first record must beat that."
          : `Your first record must beat this ${side}. This board is not sent. Press Evolve to compact it.`;
      say(
        start.transferred
          ? `This problem starts from the best packing of ${transfer!.from} pieces, with ${p.P - transfer!.from} more placed around it (Transfers). ` +
              `Its ${side} is ${show6(start.score)}, ${fmtPct(start.score / b0 - 1)} above the area bound. Rings of pieces around the centre would give ${show6(e.score)}. ` +
              startingScore
          : `${p.P} pieces placed in rings around the centre. The ${side} is ${show6(e.score)}, ${fmtPct(e.score / b0 - 1)} above the area bound. ` +
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

/** Space problems whose start could not be made, so that it is not tried again this session. */
const startFailed = new Set<string>();
/** The Load all of a space problem under way, so that a click on it waits for the start. */
const spaceLoads = new Map<string, Promise<boolean>>();
/** The worker that makes space problems' starts: a lane's worker is blocked while it holds a paused space run. */
let startLane: Lane | null = null;

/**
 * Load all for a space problem: the worker's start (a seed layout, else a random start, spread out so
 * that the first Compact has room to remove), which is the free floor and is never sent, as for
 * polygons. When none can be made the problem stays bare, and its first run opens fresh: its Compact
 * gives the board.
 */
function loadAllSpace(p: ProblemState & SpaceKey): Promise<boolean> {
  if (p.phase !== "bare") return Promise.resolve(true);
  if (startFailed.has(p.key) || !ownsGame) return Promise.resolve(false);
  const known = spaceLoads.get(p.key);
  if (known) return known;
  loading.add(p.key);
  const load = (async (): Promise<boolean> => {
    try {
      startLane ??= new Lane(-1);
      const a = await startLane.spaceStart({ family: p.family, id: p.id, seed: runSeed(state.dealer.seed, p.key, 0) });
      if (problem(state, p.key) !== p || p.phase !== "bare") return p.phase !== "bare";
      if (!a.ok) {
        startFailed.add(p.key);
        event(`${problemTitle(p)} could not be placed (${a.message}). Its first run starts from scratch.`, false);
        return false;
      }
      applyLoadAll(p, a.config, a.score, null);
      reveal(state, "score");
      if (p.key === state.focus)
        say(
          `${p.P} pieces placed${a.loose ? " loosely" : ""}. The ${sideWord(p)} is ${show6(a.score)}, ${fmtPct(a.score / rulesOf(p).bound(p)! - 1)} above the bound. ` +
            `Your first record must beat this ${sideWord(p)}. This board is not sent. Press Evolve to compact it.`,
        );
      persist();
      return true;
    } finally {
      spaceLoads.delete(p.key);
      loading.delete(p.key);
      render();
    }
  })();
  spaceLoads.set(p.key, load);
  return load;
}

/** A Compact of the problem is queued or running (the player's first click, or Auto-advance's). */
const compacting = (key: string) =>
  lanes.some((l) => (l.current?.key === key && l.current.compact) || l.jobs.some((j) => j.key === key && j.compact));
/** The next Evolve click on the problem compacts it first: its board is the start, not yet a run's. */
const compactsFirst = (p: ProblemState) =>
  // a space problem whose start could not be made is compacted bare: the run opens fresh
  (p.phase === "loaded" || (p.phase === "bare" && !isPolygon(p))) && !p.run && !compacting(p.key);

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
        lv.autoDue += job.evals;
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
 * The run a job of `evals` on `p` wants: Compact's (mc_compress); else the problem's Lattice build
 * when it is due (methods/lattice.ts); else the pipeline's stage for the problem's next run; else
 * Method match's choice; else the select's method. A run already open in the same mode is kept while
 * its choice still holds, so the bandit draws only when a new run opens.
 */
function wantedRun(p: ProblemState, o: Owned, lv: LaneView, compact: boolean, evals: number): WantedRun {
  if (!isPolygon(p)) return wantedSpaceRun(p, o, lv, compact);
  if (compact) return { method: "mc_compress", level: tuningLevel(o, "mc_compress"), mode: "compact" };
  const r = lv.run && lv.lane.open && lv.run.key === p.key ? lv.run : null;
  const owns = o.has("lattice");
  const ruleOk = ruleAllowsMethod(state.standing, "seed");
  if (latticeDue(p, { owns, ruleOk, stall: stallAfter(state, p), evals, building: r?.mode === "lattice" }))
    return { method: "seed", level: 0, mode: "lattice" };
  const tune = o.has("autoTune") && state.runplan.auto;
  const draw = (ms: readonly EvolveMethod[], withLevels: boolean) =>
    chooseRun(state.runplan, {
      kind: kindOf(p),
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

/**
 * The run a job on a space problem wants: the polygon rules above with the family's methods
 * (families.ts) that the player owns, at tuning level 0 (the presets are polygon only for now), and
 * without the Lattice build.
 */
function wantedSpaceRun(p: ProblemState & SpaceKey, o: Owned, lv: LaneView, compact: boolean): WantedRun {
  if (compact) return { method: "mc_compress", level: 0, mode: "compact" };
  const family = rulesOf(p).methods;
  const ok = (m: EvolveMethod) => family.includes(m) && allowedMethod(o, m);
  const r = lv.run && lv.lane.open && lv.run.key === p.key ? lv.run : null;
  const draw = (ms: readonly EvolveMethod[]) =>
    chooseRun(state.runplan, {
      kind: kindOf(p),
      methods: ms,
      levelOf: () => 0,
      tune: false,
      allowed: ok,
      rand: planRandom(state.runplan, state.dealer.seed),
    });
  if (piped(o)) {
    const stage = pipelineMethod(state.runplan.pipeline, p.endedRuns, ok);
    if (stage) return { method: stage.method, level: 0, mode: "pipeline" };
  }
  if (autoMethods(o)) {
    if (r && r.mode === "auto" && ok(r.method)) return { method: r.method, level: 0, mode: "auto" };
    const c = draw(methods(o));
    if (c) return { ...c, level: 0, mode: "auto" };
  }
  const m = chosenMethod(o);
  return { method: ok(m) ? m : "mc_compress", level: 0, mode: "select" };
}

/**
 * A run that ends or is replaced: the bandit learns what it paid per evaluation (Compact's and a
 * Lattice build excepted, and a run closed within its warm-up, which has had no chance to pay).
 */
function finishRun(run: OpenRunView | null): void {
  if (!run || run.mode === "compact" || run.mode === "lattice" || run.evaluations < run.warmup) return;
  const p = problem(state, run.key);
  if (p)
    observeRun(state.runplan, run.kind, run.method, run.level, basePoints(p) - run.rpAt, run.evaluations - run.evalsAt);
}

/** Opens a run on the problem (closing whatever the lane held), with a new random seed. */
async function openRun(lv: LaneView, p: ProblemState, want: WantedRun, job: Job): Promise<boolean> {
  if (!isPolygon(p)) return openSpaceRun(lv, p, want, job);
  const { method, level } = want;
  const params = methodParams(owned(), method, level);
  // drawn before anything awaits, so that two runs opening at once on one problem never share a seed
  const seed = reserveSeed(state, p);
  const kind = kindOf(p);
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
  // the method's own settings for the run, its budget and its start (methods/)
  const q = needPolygon(p, "runs");
  const setup = runSetup(method, params, p);
  const startScore = p.best;
  const a = await lv.lane.openRun({
    problem: { N: q.N, M: q.M, P: q.P },
    method,
    params: setup.params,
    budget: { evals: setup.budget },
    seed,
    start: structuredClone(setup.start),
  });
  if (problem(state, p.key) !== p) {
    void lv.lane.close();
    return false;
  }
  if (!a.ok) {
    say(`A run on ${problemTitle(p)} could not start (${a.message}).`);
    return false;
  }
  openedRun(state, p, now());
  lv.run = {
    key: p.key,
    method,
    level,
    mode: want.mode,
    asked: JSON.stringify(params),
    params: a.params,
    seed,
    budget: setup.budget,
    warmup: warmupOf(method, a.params, { N: q.N, M: q.M, P: q.P, score: startScore }),
    evaluations: a.state.evaluations,
    last: a.state.last,
    runBest: a.state.score,
    found: a.state.found,
    offers: isSpaceRunState(a.state) ? a.state.offers : undefined,
    offersAtGain: 0,
    offersCounted: 0,
    stage: a.state.stage,
    origin: setup.start,
    startScore,
    kind,
    rpAt: basePoints(p),
    evalsAt: 0,
  };
  // the start's own scoring (with the container's best turn) may already beat the board
  settle(lv.run, p, { ...job, click: false }, a.state, a.state.evaluations, 0);
  return true;
}

/** Opens a run on a space problem: through the lane's space worker, with the family's unit of kernel evaluations. */
async function openSpaceRun(lv: LaneView, p: ProblemState & SpaceKey, want: WantedRun, job: Job): Promise<boolean> {
  const { method } = want;
  const seed = reserveSeed(state, p);
  for (const other of lanes)
    if (other !== lv && other.run?.key === p.key) {
      finishRun(other.run);
      other.run = null;
      void other.lane.close();
    }
  finishRun(lv.run);
  lv.run = null;
  if (lv.lane.open) await lv.lane.close();
  const startScore = p.best;
  const start = p.board ? structuredClone(p.board as SpaceConfig) : null;
  const a = await lv.lane.openSpace({
    family: p.family,
    id: p.id,
    method,
    params: {},
    budget: { evals: RUN_BUDGET },
    unit: rulesOf(p).unitsPerEvaluation(p),
    seed,
    start,
  });
  if (problem(state, p.key) !== p) {
    void lv.lane.close();
    return false;
  }
  if (!a.ok) {
    if (a.message === NOT_ISOLATED) {
      // latched: no more space problems are dealt this session, and the player is told once
      if (!spaceBlocked) say("Space problems need an isolated browser page, so they are left out here.");
      spaceBlocked = true;
    } else say(`A run on ${problemTitle(p)} could not start (${a.message}).`);
    return false;
  }
  openedRun(state, p, now());
  lv.run = {
    key: p.key,
    method,
    level: 0,
    mode: want.mode,
    asked: "{}",
    params: a.params,
    seed,
    budget: RUN_BUDGET,
    warmup: 0,
    evaluations: a.state.evaluations,
    last: a.state.last,
    runBest: a.state.score,
    found: a.state.found,
    offers: isSpaceRunState(a.state) ? a.state.offers : undefined,
    offersAtGain: 0,
    offersCounted: 0,
    stage: a.state.stage,
    origin: start,
    startScore,
    kind: kindOf(p),
    rpAt: basePoints(p),
    evalsAt: 0,
  };
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
    // auto-eval's Compact of a problem that has not been loaded yet (Auto-advance); a space problem whose
    // start could not be made is compacted from nothing
    if (job.compact && p.phase === "bare" && !(await loadAll(p)) && isPolygon(p)) return false;
    p = problem(state, job.key);
    if (!p || p.leaving || p.closed) return false;
    const fresh = !isPolygon(p) && job.compact && p.phase === "bare";
    if (!fresh && (!p.board || (job.compact ? p.phase !== "loaded" : !evolvable(p)))) return false;
    const o = owned();
    let want = wantedRun(p, o, lv, job.compact, job.evals);
    const askedOf = (w: WantedRun) => (isPolygon(p!) ? JSON.stringify(methodParams(o, w.method, w.level)) : "{}");
    let asked = askedOf(want);
    // the open run goes on when it is on the problem with the method, setting and mode wanted; Compact's
    // run goes on under the select's method when that is the same method and setting
    const goesOn = (r: OpenRunView | null): r is OpenRunView =>
      !!r &&
      lv.lane.open &&
      r.key === p!.key &&
      r.method === want.method &&
      r.level === want.level &&
      r.asked === asked &&
      (r.mode === want.mode || (r.mode === "compact" && want.mode === "select"));
    // a run that goes on but has stalled ends as if by itself: the next one is the pipeline's next
    // stage, Method match's new draw, or the same method with a new seed
    if (
      !job.compact &&
      goesOn(lv.run) &&
      stallEnds(
        methodGame(lv.run.method).restartAfter,
        lv.run.evaluations,
        p.sinceGain,
        lv.run.offers === undefined ? undefined : lv.run.offers - lv.run.offersAtGain,
      )
    ) {
      await endStalledRun(lv, p, lv.run);
      if (problem(state, job.key) !== p) return false;
      want = wantedRun(p, o, lv, false, job.evals);
      asked = askedOf(want);
    }
    const r = lv.run;
    if (!goesOn(r)) {
      if (!(await openRun(lv, p, want, job))) return false;
    } else if (r.mode !== want.mode) {
      // from here on the run is the method's own: what it pays is measured from now
      r.mode = want.mode;
      r.rpAt = basePoints(p);
      r.evalsAt = r.evaluations;
    }
    const run = lv.run!;
    let t = await lv.lane.step(job.evals);
    let ms = t.ok ? t.ms : 0;
    // a Compact outside 2D in 2D runs until the method's first finished packing, in steps of Compact's size
    // so that its progress shows; it counts as COMPACT_EVALS however long it ran (countedEvals)
    if (job.compact && !isPolygon(p)) {
      while (
        t.ok &&
        isSpaceRunState(t.state) &&
        t.state.offers < 1 &&
        !t.state.ended &&
        !t.state.closed &&
        !t.state.error &&
        !stopped &&
        lv.lane.open &&
        lv.run === run &&
        problem(state, p.key) === p &&
        !p.leaving &&
        !p.closed
      ) {
        lv.progress = t.state as unknown as RunState;
        scheduleRender();
        t = await lv.lane.step(COMPACT_EVALS);
        if (t.ok) ms += t.ms;
      }
    }
    if (!t.ok) {
      finishRun(run);
      lv.run = null;
      say(`The run on ${problemTitle(p)} stopped (${t.message}).`);
      return false;
    }
    const done = Math.max(0, t.state.evaluations - run.evaluations);
    const counted = countedEvals(done, job.compact && !isPolygon(p), COMPACT_EVALS);
    // a space Compact is mostly its finish, which says little of the run's speed afterwards
    if (!(job.compact && !isPolygon(p))) observeSpeed(run, p, done, ms);
    if (!job.click) autoMeter.addRan(now(), counted);
    track(run, t.state);
    if (t.state.ended) lv.run = null;
    if (problem(state, p.key) !== p) {
      // the problem left the queue meanwhile; the work still counts as done
      countEvaluations(state, counted, job.click);
      return true;
    }
    settle(run, p, job, t.state, done, ms);
    if (t.state.ended) finishRun(run);
    return true;
  } finally {
    lv.current = null;
    lv.progress = null;
  }
}

/**
 * The game ends a problem's run at a stall (game.ts stallEnds): it counts as a run that ended by
 * itself, Method match learns from it, and the lane's worker closes it.
 */
async function endStalledRun(lv: LaneView, p: ProblemState, run: OpenRunView): Promise<void> {
  const limit = methodGame(run.method).restartAfter!;
  endRunAtStall(p);
  finishRun(run);
  lv.run = null;
  const title = problemTitle(p);
  const smaller = smallerText(sideWord(p), run.startScore, run.runBest);
  event(
    `The run on ${title} made no progress in ${evals(limit)}, so the game ended it.` +
      `${smaller ? ` ${smaller}` : ""} ${title} stays in the queue. Its next run starts from the best board${nextStageText(p)}, when a lane or a click next works on it.`,
    p.key === state.focus,
  );
  persist();
  await lv.lane.close();
}

/** A step's result applied to the game: the board, the counters, the points, the messages. */
function settle(
  run: OpenRunView,
  p: ProblemState,
  job: Job,
  st: RunState | SpaceRunState,
  done: number,
  ms: number,
): void {
  // a space problem compacted from nothing (its start could not be made): the Compact's board is its free floor, as Load all's
  if (!isPolygon(p) && p.phase === "bare" && st.best && st.score !== null && st.score > 0)
    applyLoadAll(p, st.best, st.score, null);
  // a space Compact counts as COMPACT_EVALS however long it ran; the run's own count stays the real one
  const counted = countedEvals(done, job.compact && !isPolygon(p), COMPACT_EVALS);
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
      evaluations: counted,
      best: st.best,
      score: st.score,
      run: record,
      ms,
      // a Lattice build is not one of the problem's runs: it never moves a pipeline on
      ended: st.ended && !st.closed && !st.error && run.mode !== "lattice",
      click: job.click,
      compact: job.compact && done > 1,
      warm: warmIn(run.warmup, st.evaluations - done, st.evaluations),
    },
    now(),
  );
  // the offers the stall rule waits for count from the problem's latest progress
  if (p.sinceGain === 0) run.offersAtGain = run.offers ?? 0;
  // and the problem's own count, which Auto-advance's leaving waits on (game.ts leaveReason)
  if (run.offers !== undefined) {
    p.offersSinceGain = p.sinceGain === 0 ? 0 : (p.offersSinceGain ?? 0) + Math.max(0, run.offers - run.offersCounted);
    run.offersCounted = run.offers;
  }
  lastChange.set(p.key, { ...change, evals: counted, seed: run.seed, method: run.method });
  if (change.firstRecord) {
    reveal(state, "log");
    banner = {
      key: p.key,
      text:
        p.tier === "open"
          ? `New record ${show6(p.best!)}. No one had sent a packing of ${problemTitle(p).replace(/, (\d+) pieces$/, " with $1 pieces")} before.`
          : `New best ${show6(p.best!)} on ${problemTitle(p)}.`,
    };
    const bonus = change.points?.bonus
      ? ` It earns the ${change.points.bonus === "first" ? "first-record" : "lead"} bonus of ${fmtInt(change.points.bonusRp)} RP.`
      : "";
    event(`New record ${show6(p.best!)} on ${problemTitle(p)}.${bonus}`, false);
  }
  if (change.points) reveal(state, "points", "upgrades");
  if (run.mode === "lattice") {
    const built = latticeStep(p, st as RunState, run.startScore, problemTitle(p), sideWord(p));
    if (built) event(built.text, built.notice);
  } else if (st.ended && !st.closed && !st.error) {
    const title = problemTitle(p);
    const ended =
      methodGame(run.method).endedText?.(runView(run, p), title) ??
      `The run on ${title} stopped improving after ${evals(st.evaluations)}.`;
    const smaller = smallerText(sideWord(p), run.startScore, st.score);
    event(`${ended}${smaller ? ` ${smaller}` : ""} The next click starts a new run${nextStageText(p)}.`);
  }
  // after Stop, the click that was already running does not write over "Stopped"
  if (job.click && p.key === state.focus && !stopped) say(stepMessage(p, change, run, job, done, counted));
  persist();
  scheduleRender();
  void submitTick();
  void dealTick();
}

function stepMessage(
  p: ProblemState,
  c: StepChange,
  run: OpenRunView,
  job: Job,
  done: number,
  counted: number,
): string {
  // a space Compact ran to its first finished packing, and counts as less
  const as = counted < done ? ` It counts as ${evals(counted)}.` : "";
  const what = `${job.compact ? "Compact" : `Click ${fmtInt(state.stats.clicks)}`} ran ${evals(done)} of ${methodLabel(run.method)}.${as}`;
  if (!c.improved || c.before === null || c.after === null) {
    const note = methodGame(run.method).stepNote?.(runView(run, p));
    return `${what} No improvement on ${show6(p.best ?? 0)}.${note ? ` ${note}` : ""}`;
  }
  // the relative improvement of this one step (the step term of its points), never a measure of the record
  let text =
    `${what} The ${sideWord(p)} went from ${show6(c.before)} to ${show6(c.after)}, ` +
    `an improvement of ${fmtRelative(1 - c.after / c.before)}`;
  if (!c.counted)
    return `${text}. That is too small to count (under ${MIN_STEP}), so it will be paid together with the next step that counts.`;
  text += c.points ? `, worth +${fmtRP(c.points.total)} RP.${bonusSentence(c.points)}` : ".";
  return text;
}

/** With a pipeline: ", running <method>" for the next stage on the problem; otherwise nothing. */
function nextStageText(p: ProblemState): string {
  const o = owned();
  if (!piped(o)) return "";
  const stage = pipelineMethod(state.runplan.pipeline, p.endedRuns, (m) => allowedMethod(o, m));
  return stage
    ? `, using ${methodLabel(stage.method)} (stage ${stage.stage + 1} of ${state.runplan.pipeline.length})`
    : "";
}

/** The run's place in its budget, as the run line says it: "300 evaluations", or "300 of 1,000 evaluations" for a short run. */
const runAt = (run: OpenRunView, going: number) =>
  run.budget < RUN_BUDGET ? `${fmtInt(going)} of ${evals(run.budget)}` : evals(going);

/** Stop was pressed and no click since: the status line keeps saying so. */
let stopped = false;

function stopAll(): void {
  stopped = true;
  state.settings.auto = false;
  for (const l of lanes) l.jobs = l.jobs.filter((j) => j.compact && j.click);
  say("Stopped. Auto-eval is now off, and the clicks that were still waiting to run were dropped.");
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
  const t = now();
  const elapsed = Math.max(0, t - state.autoAt) / 1000;
  // the rate is all lanes' together: they share it
  accrue(state, t, runs && autoRan ? (autoPerSecond(o) ?? 0) : 0, autoCap(o));
  if (runs && autoRan) accrueLanes(o, t, elapsed);
  autoRan = runs;
  // a Compact's debt stays: switching auto-eval off and on does not cancel it
  if (!runs) {
    state.autoDue = Math.min(0, state.autoDue);
    for (const lv of lanes) lv.autoDue = Math.min(0, lv.autoDue);
  }
}

/** What auto-eval ran and was due over the last 30 s, while it had work and was not held. */
const autoMeter = new AutoMeter();

/** The target a lane's next auto-eval job would take, or null (no work for it). */
function laneAutoTarget(lv: LaneView, o: Owned) {
  const busy = new Set(lanes.filter((l) => l !== lv).flatMap(laneKeys));
  return autoTarget({
    lane: lanes.indexOf(lv),
    queue: state.queue,
    focus: state.focus,
    busy,
    owned: o,
    // with Auto-advance a lane keeps to its run's problem until that problem stalls
    current: lv.run?.key ?? null,
    stall: stallAfter(state),
  });
}

/** The expected ms of one evaluation of the lane's auto-eval work (0 when it has none). */
function laneWorkMs(lv: LaneView, o: Owned): number {
  const target = laneAutoTarget(lv, o);
  const tp = target ? problem(state, target.key) : undefined;
  if (!target || !tp) return 0;
  const key =
    target.action === "compact"
      ? runSpeedKey(tp, "mc_compress", isPolygon(tp) ? tuningLevel(o, "mc_compress") : 0)
      : jobSpeedKey(lv, tp, o);
  return speeds.msEach(key, tableMsOf(tp));
}

/**
 * Splits auto-eval's rate over the lanes that have work (scheduler.ts laneSplit: about equal solving
 * time each, at least a quarter of an equal share) and adds `elapsed` seconds of each lane's share to
 * its due evaluations. With no lane working, the lanes share it equally, as they did before. Also
 * counts the time for the measured rate while some lane has auto-eval's work and no click is running.
 */
function accrueLanes(o: Owned, t: number, elapsed: number): void {
  const R = autoPerSecond(o) ?? 0;
  const ms = lanes.map((lv) => laneWorkMs(lv, o));
  const working = lanes.map((_, i) => i).filter((i) => ms[i] > 0);
  const idx = working.length ? working : lanes.map((_, i) => i);
  const shares = laneSplit(
    idx.map((i) => (ms[i] > 0 ? ms[i] : 1)),
    R,
  );
  lanes.forEach((lv, i) => {
    const k = idx.indexOf(i);
    lv.autoRate = k < 0 ? 0 : shares[k];
    const cap = Math.max(COMPACT_EVALS, lv.autoRate * AUTO_SLACK_SECONDS);
    lv.autoDue =
      k < 0 ? Math.min(0, lv.autoDue) : Math.min(Math.max(cap, lv.autoDue), lv.autoDue + elapsed * lv.autoRate);
  });
  const clicking = lanes.some((lv) => lv.jobs.length || lv.current?.click);
  if (working.length && !clicking) autoMeter.addDue(t, R, Math.min(elapsed, 5));
}

/** The share of auto-eval's evaluations that ran over the last 30 s (null: too little to tell). */
const measuredShare = () => meterShare(autoMeter.summary(now()));

/**
 * How many times slower than the machine of rank.ts's cost table this device runs an evaluation, for
 * each method at each tuning level (scheduler.ts Speeds). Auto-eval's jobs are sized with it.
 */
const speeds = new Speeds();
/** The kind of run a speed is kept for: its method at its tuning level. */
const speedKey = (method: EvolveMethod, level: number) => `${method}@${level}`;
/** The speed key of a run on a problem: a space family's evaluations are sized by their own units, so they are kept apart. */
const runSpeedKey = (p: ProblemKey, method: EvolveMethod, level: number) =>
  isPolygon(p) ? speedKey(method, level) : `${p.family}:${speedKey(method, level)}`;

function observeSpeed(run: OpenRunView, p: ProblemKey, done: number, ms: number): void {
  speeds.observe(runSpeedKey(p, run.method, run.level), tableMsOf(p), done, ms);
}

/**
 * The kind of run a job of auto-eval on `p` in this lane goes to: the lane's open run on it, else the
 * method a new run would likely take (the pipeline's stage, or the select's), or null when Method
 * match will draw it.
 */
function jobSpeedKey(lv: LaneView, p: ProblemState, o: Owned): string | null {
  if (lv.run && lv.lane.open && lv.run.key === p.key) return runSpeedKey(p, lv.run.method, lv.run.level);
  const stage = piped(o) ? pipelineMethod(state.runplan.pipeline, p.endedRuns, (m) => allowedMethod(o, m)) : null;
  const m = stage ? stage.method : autoMethods(o) ? null : chosenMethod(o);
  return m ? runSpeedKey(p, m, isPolygon(p) ? tuningLevel(o, m) : 0) : null;
}

/**
 * Whether the rate auto-eval asks for is more than this computer was measured to run, on the problem
 * on the board with the method its next run would take (scheduler.ts). False until a step has run here.
 */
function overComputerLimit(o: Owned): boolean {
  const rate = autoPerSecond(o);
  const p = focused();
  const share = measuredShare();
  // what auto-eval really ran, when it had work for long enough to tell (a margin keeps it from flickering)
  if (share !== null) return share < AUTO_METER_CARD;
  if (rate === null || !p || !speeds.measured) return false;
  const msEach = speeds.msEach(lanes[0] ? jobSpeedKey(lanes[0], p, o) : null, tableMsOf(p));
  return autoOverLimit(rate, laneCount(o), msEach);
}

/**
 * The lane offered auto-eval's next job first: the one after the lane that took the last. The lanes
 * share one rate, and at a slow one less than a job a lane is due at each tick, so a fixed order
 * would hand every job to lane 1.
 */
let autoTurn = 0;

/**
 * Auto-eval's next job for this lane, from what it is due, when it may run one. Its rate is in
 * evaluations, whatever the player's click size, and the lanes share it: a job is what is due, at most
 * a quarter second of the lane's share and a quarter second of this device's time on the problem
 * (autoJobEvals), and an evaluation pays the same as a click's.
 */
function autoJob(lv: LaneView): Job | null {
  const o = owned();
  // the lane takes from its own share (laneSplit), and from the total, which stays at the rate
  const due = Math.min(state.autoDue, lv.autoDue);
  const laneRate = lv.autoRate > 0 ? lv.autoRate : undefined;
  const n = autoJobEvals(o, due, lanes.length, 0, laneRate);
  if (autoPerSecond(o) === null || !state.settings.auto || holdReason() || n < 1) return null;
  if (lanes.indexOf(lv) >= lanesWanted(o)) return null;
  const target = laneAutoTarget(lv, o);
  if (!target) return null;
  autoTurn = lanes.indexOf(lv) + 1;
  if (target.action === "compact") {
    // A Compact is one press of 100 evaluations. It starts once a job's worth is due and the rest is
    // owed (autoDue below zero), repaid before any lane's next job: waiting for 100 due at once never
    // ended while another lane took each job as it came due, so new problems sat uncompacted.
    state.autoDue -= COMPACT_EVALS;
    lv.autoDue -= COMPACT_EVALS;
    return { key: target.key, evals: COMPACT_EVALS, click: false, compact: true };
  }
  const tp = problem(state, target.key);
  // at most a quarter second of this device's time on that problem, with that run's method
  const msEach = tp ? speeds.msEach(jobSpeedKey(lv, tp, o), tableMsOf(tp)) : 0;
  const evals = tp ? autoJobEvals(o, due, lanes.length, msEach, laneRate) : n;
  state.autoDue -= evals;
  lv.autoDue -= evals;
  return { key: target.key, evals, click: false, compact: false };
}

/** Starts every idle lane that has work, auto-eval's or queued clicks, in turn from autoTurn. */
function kickLanes(): void {
  if (!ownsGame) return;
  ensureLanes();
  const first = autoTurn;
  for (let i = 0; i < lanes.length; i++) {
    const lv = lanes[(first + i) % lanes.length];
    if (!lv.pumping) void pump(lv);
  }
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

/** Sends at most one improvement per call, when the pacer and the server allow. */
async function submitTick(): Promise<void> {
  if (submitting) return;
  const t = now();
  // problems dropped with nothing left to send leave now
  for (const p of [...state.queue]) if (p.leaving && !hasUnsent(p)) leave(state, p.key, t);
  if (!ownsGame || !state.name) return;
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
 * Before a board is sent, its container is turned to its best angle: the server scores it at the
 * angle sent and does not search for a better one. The runs score fixed angles between turns, so
 * this often gains a little: an improvement like any other.
 */
function orient(p: ProblemState): void {
  needPolygon(p, "container orientation");
  const current = polygonBoard(p);
  if (!current || p.best === null) return;
  const turned = orientBoard(current, p.best);
  if (!turned) return;
  p.board = turned.board;
  p.best = turned.score;
  const points = pay(state, p);
  if (points)
    event(
      `The container was turned to its best angle on ${problemTitle(p)}. The side changed by ${fmtChange(p.best / (1 - points.delta), p.best)} (+${fmtRP(points.total)} RP).`,
      false,
    );
}

async function submit(p: ProblemState): Promise<void> {
  const name = state.name;
  // the leader just before: the server's exact check decides
  const read = await within(SEND_TIMEOUT_MS, readLeader(p), null);
  const info = read.answer;
  if (problem(state, p.key) !== p || !ownsGame) return;
  if (!info) {
    pauseSending(read.timedOut ? { kind: "timeout", waitedMs: SEND_TIMEOUT_MS } : { kind: "unreachable" });
    return;
  }
  if (!info.accepts) {
    sendingWorks();
    p.closed = true;
    event(`The server no longer takes entries for ${problemTitle(p)}. It leaves the queue.`);
    leave(state, p.key, now());
    return;
  }
  const leaderBefore: Leader | null = info.leader;
  noteLeader(p, leaderBefore);
  // the server scores a space board as it is: no turning of the container
  if (isPolygon(p)) orient(p);
  const best = p.best!;
  if (!shouldSubmit(best, submitTarget(p, leaderBefore?.score ?? null))) {
    // the server answered, and the board does not go: sending has nothing wrong left to report
    sendingWorks();
    return;
  }
  // The player may have changed the name while the leader was read: what goes
  // to the server is decided now, immediately before the POST.
  if (!ownsGame || state.name !== name || !name) return;
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
    const post = isPolygon(p)
      ? api.postSubmission(submissionBody(board0 as PackingConfig, name, run))
      : postSpaceSubmission(spaceSubmissionBody(p, board0 as SpaceConfig, name, run));
    posted = await within(SEND_TIMEOUT_MS, post, { status: null, body: null });
  } finally {
    inFlight.delete(p.key);
  }
  const answer = posted.answer;
  const outcome = isPolygon(p)
    ? classifyAnswer(answer.status, answer.body)
    : classifySpaceAnswer(answer.status, answer.body);
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
      if (outcome.pending) event("It beats a published value, so an administrator must review it.");
      break;
    case "behind":
      event(
        `Another entry was first on ${title}. The record is now ${show6(outcome.leaderScore ?? 0)}.` +
          (a.takenBack > 0 ? ` ${fmtRP(a.takenBack)} RP taken back.` : "") +
          (a.points ? ` Your board still beats it, and pays +${fmtRP(a.points.total)} RP.` : ""),
      );
      // the answer does not say whose entry it was: the record's holder is read, and becomes a rival
      if (isPolygon(p)) void readRival(p);
      break;
    case "closed":
      event(
        `The server no longer takes entries for ${title}${outcome.reasons.length ? ` (${outcome.reasons.join(", ")})` : ""}. It leaves the queue.${a.takenBack > 0 ? ` ${fmtRP(a.takenBack)} RP taken back.` : ""}`,
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

/** Reads the record's holder after a "behind" answer, to learn the name of the entry that was first. */
async function readRival(p: ProblemState): Promise<void> {
  const { answer: info } = await within(SEND_TIMEOUT_MS, readLeader(p), null);
  if (!info || !ownsGame) return;
  noteRival(p.key, info.leader);
  persist();
  render();
}

/** Reads the record of the oldest send left without an answer, once it is LOST_ANSWER_MS old. */
async function settleLost(): Promise<void> {
  if (!ownsGame || submitting || lostChecking || now() < lostCheckAfter || now() < state.pacer.pausedUntil) return;
  const p = state.queue.find((q) => q.sending && !inFlight.has(q.key) && now() - q.sending.at >= LOST_ANSWER_MS);
  if (!p) return;
  lostChecking = true;
  try {
    const { answer: info } = await within(SEND_TIMEOUT_MS, readLeader(p), null);
    if (problem(state, p.key) !== p || !p.sending || inFlight.has(p.key) || !ownsGame) return;
    if (!info) {
      lostCheckAfter = now() + OFFLINE_BACKOFF_MS;
      sendTrouble({ kind: "lost", title: problemTitle(p) });
      return;
    }
    sendingWorks();
    // ours: its points are confirmed; not ours: they wait for the board's next send
    noteLeader(p, info.leader);
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
  const info = await getProblem(k);
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

/** Whether a deal is due: a slot free and a token earned by work, or an empty queue. */
function mayDeal(): boolean {
  const o = owned();
  const slots = queueSize(o);
  const filled = slotted(state).length;
  if (filled >= slots) return false;
  // with nothing to work on, nothing would earn the next problem: one is dealt on credit
  return filled === 0 || canDeal(state.dealer, slots);
}

/** The tiers of contested problems the player may be dealt. */
function contestedTiers(o: ReadonlySet<UpgradeId>): Set<Tier> {
  const t = new Set<Tier>();
  if (o.has("reach2")) t.add("loose");
  if (o.has("batch")) t.add("batch");
  if (o.has("published")) t.add("published");
  return t;
}

/** Set while a deal looks outside the player's filters (an empty queue, nothing that fits): the filters are not applied. */
let filtersOff = false;
const dealerFilters = () => (!filtersOff && inUse(owned(), "filters") ? state.picks.filters : null);
/** The cycle's rule allows a problem ("circles only" and "small problems only" restrict every Dimension: standing.ts hasCircles, isSmall). */
const ruleOk = (p: ProblemKey): boolean => ruleAllowsProblem(state.standing, p);
/** The player's filters and the cycle's rule allow a candidate. */
const allowed = (c: ProblemKey & { tier?: Tier }) => passes(dealerFilters(), c) && ruleOk(c);

const openCandidateOf = (k: ProblemKey): Candidate => ({
  ...keyPart(k),
  tier: "open",
  weakness: null,
  leader: null,
  target: null,
  source: null,
  retake: false,
});

/** Open problems a batch found and no GET has confirmed yet, with when they were found. */
let openStock: ProblemKey[] = [];
let openStockAt = 0;
const OPEN_STOCK_MS = 60_000;
/** Most /api/leaders requests one deal (or one filling of the offers) makes. */
const DEAL_BATCHES = 4;
/** Problems found taken by a batch, remembered for a few minutes so the next deal does not ask again. */
const takenCache = new TakenCache(now);
const finderDeps: FinderDeps = { getLeaders: (keys) => api.getLeaders(keys), now };

/** An open problem, found in batches of up to 200 (one /api/leaders request) and checked with GET just before it is dealt. */
async function openCandidate(
  io: DealIo & { batches?: number },
  d: DealerState,
  exclude: Set<string>,
  firstPools?: Pool[],
) {
  const o = owned();
  const pass = (p: ProblemKey) => allowed({ ...p, tier: "open" });
  // a cycle rule may need open problems of its own (circles have none in the frontier)
  const ruled = ruleOpenProblems(state.standing);
  const ruledWide = ruleOpenWide(state.standing);
  const confirm = async (): Promise<Candidate | null> => {
    while (openStock.length && !spentIo(io)) {
      const k = openStock.shift()!;
      if (exclude.has(keyOf(k)) || !pass(k)) continue;
      const info = await problemInfo(io, k);
      if (!info) return null;
      if (openDealable(info)) return openCandidateOf(k);
      // a null leader also answers for a closed problem
      takenCache.add(keyOf(k));
      skipped.add(keyOf(k));
      exclude.add(keyOf(k));
    }
    return null;
  };
  if (now() - openStockAt > OPEN_STOCK_MS) openStock = [];
  const stocked = await confirm();
  if (stocked || spentIo(io)) return stocked;
  const batches = io.batches ?? 0;
  if (batches >= DEAL_BATCHES) return null;
  // the frontier first, then small problems of the wide set so that a deal always finds one while any is open
  const wideFirst = !firstPools && !ruled && o.has("wide") && nextRandom(d) < 0.5;
  const pools: Pool[] =
    firstPools ??
    (ruled
      ? [{ keys: ruled }, { wide: true, skew: 2.5, rule: ruledWide }]
      : wideFirst
        ? [{ wide: true, skew: 1 }, { keys: FRONTIER }]
        : [{ keys: FRONTIER }, { wide: true, skew: 2.5 }]);
  const found = await findOpen(finderDeps, d, pools, {
    exclude,
    taken: takenCache,
    allow: pass,
    within: dealerFilters(),
    smallest: !!firstPools,
    budget: DEAL_BATCHES - batches,
  });
  io.batches = batches + found.requests;
  io.gets += found.requests;
  if (found.offline) io.offline = true;
  openStock.push(...found.open);
  openStockAt = now();
  return confirm();
}

/** A site record or published value of a random contested pair, in the player's tiers and size ring. */
async function contestedCandidate(io: DealIo, d: DealerState, exclude: Set<string>): Promise<Candidate | null> {
  const o = owned();
  const f = dealerFilters();
  const pair = drawContestedPair(d, f?.pieces ?? null, f?.containers ?? null);
  if (!pair) return null;
  const records = await pairRecords(io, pair.N, pair.M);
  if (!records) return null;
  const heldBy = f?.tighter ? (e: { name: string; agent_note?: string }) => heldByTighter(e, state.name) : undefined;
  const list = contestedCandidates(records, {
    ringMin: ringMin(o),
    tiers: contestedTiers(o),
    exclude,
    allow: allowed,
    heldBy,
  });
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

/** Reads of what the rivals hold (GET /api/holder): each name at most once in 15 minutes, a few requests a minute in all. */
const holderReader = new HolderReader(api.getHolder, now);

/**
 * A record held by one of the player's rivals (the filter Records held by my rivals): a rival is drawn
 * at random, the problems it holds come from GET /api/holder, and one of them is checked with GET just
 * before it counts. It is dealt as a site record of its tier. Null when no rival holds a problem that fits.
 */
async function rivalCandidate(io: DealIo, d: DealerState, exclude: Set<string>): Promise<Candidate | null> {
  const o = owned();
  const f = dealerFilters();
  const rivals = state.picks.rivals;
  if (!rivals.length) return null;
  const tiers = contestedTiers(o);
  const start = Math.floor(nextRandom(d) * rivals.length);
  for (let i = 0; i < rivals.length && !spentIo(io); i++) {
    const rival = rivals[(start + i) % rivals.length].name;
    const held = await holderReader.get(rival);
    if (!held) continue;
    const fits = heldKeys(held).filter((key) => {
      const k = parseKey(key);
      if (!k || !isPolygon(k) || exclude.has(key) || problem(state, key)) return false;
      return passes(f, k) && ruleOk(k) && k.N + k.M + k.P >= ringMin(o);
    });
    if (!fits.length) continue;
    const k = needPolygon(parseKey(fits[Math.floor(nextRandom(d) * fits.length)])!, "Rivals");
    const info = await problemInfo(io, k);
    if (!info) return null;
    const lead = info.site_best;
    exclude.add(keyOf(k));
    // still theirs, open, and not awaiting review
    if (!info.accepts_submissions || !lead || lead.verification === "pending") continue;
    if (sanitizeName(lead.name) !== rival) continue;
    const records = k.N <= 20 && k.M <= 20 ? await pairRecords(io, k.N, k.M) : null;
    if (f?.tighter) {
      const e = records?.site.find((x) => x.P === k.P);
      if (!e || !heldByTighter(e, state.name)) continue;
    }
    const lit = info.literature?.status === "best_known" ? info.literature : null;
    const tier = lit ? "published" : retakeTier(k.N, k.M, k.P, records);
    if (!tiers.has(tier) || !allowed({ ...k, tier })) continue;
    return {
      ...k,
      tier,
      weakness: null,
      leader: { score: lead.score, name: lead.name, id: lead.id },
      target: lit ? publishedTarget(lit) : null,
      source: lit ? `${lit.display} (${lit.source_name})` : null,
      retake: false,
    };
  }
  return null;
}

// ---------- space problems ----------

/** The records listings of the spaces drawn from them, read once a session (not saved). */
const spaceListings: SpaceListings = {};

/** One problem of a records listing as the catalogue reads it, or none for an entry that is not one. */
function listedProblem(x: SpaceProblemSummary): ListedSpaceProblem[] {
  if (typeof x?.id !== "string" || !Number.isSafeInteger(x.P)) return [];
  const c = x.certified;
  return [
    {
      id: x.id,
      P: x.P,
      status: typeof x.status === "string" ? x.status : undefined,
      accepts_submissions: x.accepts_submissions === true,
      certified: c && typeof c.score === "number" ? { score: c.score, status: c.status } : null,
      bound: x.bound && typeof x.bound.value === "number" ? { value: x.bound.value } : null,
    },
  ];
}

/** Reads a space's records listing once; false when the server could not be reached. */
async function spaceListing(io: DealIo, space: ListedSpace): Promise<boolean> {
  if (spaceListings[space]) return true;
  io.gets++;
  const r = await api.getSpaceRecords(space);
  if (!r || !Array.isArray(r.problems)) {
    io.offline = true;
    return false;
  }
  spaceListings[space] = r.problems.flatMap(listedProblem);
  return true;
}

/** A space problem's GET (just before it is dealt); null when it could not be read, and `io` says so when the server was not reached. */
async function spaceInfo(io: DealIo, k: SpaceKey): Promise<SpaceRead | null> {
  io.gets++;
  const { status, read } = await fetchSpaceProblem(k.family, k.id);
  if (status === null || status >= 500) io.offline = true;
  return read;
}

/** Set once a space run could not open because the page is not cross-origin isolated: no space problems are dealt this session. */
let spaceBlocked = false;

/** The slices a space problem may be drawn from now: those open in the dimensions opened (the cycle's rules restrict polygon problems only), none once the page proved unable to run space problems. */
function dealableSlices(): SliceId[] {
  return spaceBlocked ? [] : openSlices(owned(), state.standing);
}

/** What the cycle's rule asks of the draws in the other Dimensions: small problems, 30 pieces or fewer; circles, disks or balls. */
function ruleLimits(): RuleLimits {
  return {
    ...(state.standing.rule === "small" ? { maxP: SMALL_PIECES } : {}),
    ...(state.standing.rule === "circles" ? { circles: true } : {}),
  };
}

/** The slices open now that the cycle's rule leaves a problem in (under circles only, not the solids of the polyhedra family). */
function ruledSlices(): SliceId[] {
  const open = dealableSlices();
  return state.standing.rule === "circles" ? open.filter(sliceHasCircles) : open;
}

/** Problems of a dimension dealt, offered or left so far. */
const dimensionDealt = (dim: DimensionId): number =>
  [...state.queue, ...state.past, ...state.picks.offers].filter((p) => familyDimension(p.family) === dim).length;

/** The dimension opened last, when it is not the first. */
const newestDimension = (): DimensionId | null => {
  const dim = state.standing.dimensions.at(-1) ?? null;
  return dim && dim !== "2-in-2" ? dim : null;
};

/** Deals of a new dimension that are weighted up: its first problems are drawn more often than the older kinds. */
const FRESH_DEALS = 5;

/** A slice drawn by weight: those of the newest dimension count three times. */
function pickSlice(d: DealerState, slices: readonly SliceId[]): SliceId | null {
  if (!slices.length) return null;
  const newest = newestDimension();
  const weight = (id: SliceId) => (sliceById(id).dimension === newest ? 3 : 1);
  let x = nextRandom(d) * slices.reduce((t, id) => t + weight(id), 0);
  for (const id of slices) {
    x -= weight(id);
    if (x < 0) return id;
  }
  return slices[slices.length - 1];
}

/** The share of draws that go to space problems: low in general, high while the newest dimension is fresh. */
function spaceShare(): number {
  const newest = newestDimension();
  return newest && dimensionDealt(newest) < FRESH_DEALS ? 0.7 : 0.3;
}

/**
 * A space problem of an open slice (the given one for a starter), checked with GET just before it
 * counts: open without a leader, else a site record. Never a closed problem, and none without a bound.
 */
async function spaceCandidate(
  io: DealIo,
  d: DealerState,
  exclude: Set<string>,
  starter?: SliceId,
): Promise<Candidate | null> {
  const slice = starter ?? pickSlice(d, ruledSlices());
  if (!slice) return null;
  const listed = listingOf(slice);
  if (listed && !(await spaceListing(io, listed))) return null;
  const k = drawSliceProblem(d, slice, {
    listings: spaceListings,
    exclude,
    starter: starter !== undefined,
    open: dealableSlices(),
    ...ruleLimits(),
  });
  if (!k) return null;
  if (!allowed({ ...k, tier: "open" })) {
    exclude.add(k.id);
    return null;
  }
  const read = await spaceInfo(io, k);
  if (!spaceDealable(read)) {
    exclude.add(k.id);
    if (!io.offline) skipped.add(k.id);
    return null;
  }
  return {
    ...keyPart(k),
    tier: spaceTier(read),
    weakness: null,
    leader: read.leader,
    target: null,
    source: null,
    retake: false,
    bound: read.bound,
  };
}

/**
 * The first deal after a reset that opened a dimension comes from that dimension's free slice, from
 * its starter corner: few pieces and simple shapes, so that the first record comes within a few clicks.
 */
async function starterCandidate(io: DealIo, d: DealerState, exclude: Set<string>): Promise<Candidate | null> {
  const dim = newestDimension();
  if (!dim || dimensionDealt(dim) > 0) return null;
  const slice = SLICES.find((s) => s.dimension === dim && s.free);
  if (!slice || !dealableSlices().includes(slice.id)) return null;
  for (let attempt = 0; attempt < 4 && !spentIo(io); attempt++) {
    const c = await spaceCandidate(io, d, exclude, slice.id);
    if (c) return c;
  }
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
    if (!isPolygon(k)) {
      const read = await spaceInfo(io, k);
      if (!read && io.offline) return null;
      state.picks.retake.shift();
      const lead = read?.leader;
      // nothing to take back: closed, no site entry leads (a research record has no entry to retake), or the player's own name leads again
      if (!spaceDealable(read) || !lead || lead.id === null || !ruleOk(k)) continue;
      if (state.name && sanitizeName(lead.name) === sanitizeName(state.name)) continue;
      return {
        ...k,
        tier: "batch",
        weakness: null,
        leader: lead,
        target: null,
        source: null,
        retake: true,
        bound: read.bound,
      };
    }
    const info = await problemInfo(io, k);
    if (!info) return null;
    state.picks.retake.shift();
    const lead = info.site_best;
    // nothing to take back: closed, no leader, in review, or the player's own name leads again
    if (!info.accepts_submissions || !lead || lead.verification === "pending") continue;
    if (state.name && sanitizeName(lead.name) === sanitizeName(state.name)) continue;
    if (!ruleOk(k)) continue;
    const pk = needPolygon(k, "Retake");
    const records = pk.N <= 20 && pk.M <= 20 ? await pairRecords(io, pk.N, pk.M) : null;
    const tier = retakeTier(pk.N, pk.M, pk.P, records);
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

/**
 * An open problem of the combination of pieces and container the player has the most records in
 * below 9, at a piece count with no record yet (Collector). One batch finds it, one GET confirms it.
 */
async function collectorCandidate(io: DealIo, d: DealerState, exclude: Set<string>): Promise<Candidate | null> {
  // problems found taken lately count as excluded, so a combination whose gaps are all taken gives way to the next
  const unusable = { has: (k: string) => exclude.has(k) || takenCache.has(k) };
  const targets = collectorTargets(new Set(state.economy.recorded), unusable, owned().has("wide"));
  if (!targets.length) return null;
  const pass = (p: ProblemKey) => allowed({ ...p, tier: "open" });
  const found = await findOpen(finderDeps, d, [{ keys: targets }], {
    exclude,
    taken: takenCache,
    allow: pass,
    within: dealerFilters(),
    budget: 2,
  });
  io.gets += found.requests;
  if (found.offline) io.offline = true;
  for (const k of found.open) {
    if (spentIo(io)) return null;
    const info = await problemInfo(io, k);
    if (!info) return null;
    if (openDealable(info)) return openCandidateOf(k);
    // a null leader also answers for a closed problem
    takenCache.add(keyOf(k));
    skipped.add(keyOf(k));
    exclude.add(keyOf(k));
  }
  return null;
}

/** What the player has reached, as the sources of a draw go. */
const sourceReach = (o: ReadonlySet<UpgradeId>): SourceReach => ({
  contested: contestedTiers(o),
  ringMin: ringMin(o),
  wide: o.has("wide"),
  space: ruledSlices().length > 0,
  ruled: ruleOpenProblems(state.standing),
  ruledWide: ruleOpenWide(state.standing),
  used: new Set([...seenKeys(state), ...skipped, ...takenCache.keys()]),
});

/**
 * Up to `want` candidates, each checked with GET just before it counts: a retake first (Retake),
 * one deal in three an open problem of the combination the player is closest to 9 records in (Collector), then draws, two in three of them
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
  if (inUse(o, "retake")) forced = await retakeCandidate(io);
  if (!forced && inUse(o, "collector") && d.dealt % 3 === 2) forced = await collectorCandidate(io, d, exclude);
  if (!forced) forced = await starterCandidate(io, d, exclude);
  if (forced) exclude.add(keyOf(forced));
  // attempts go only to sources that can give a problem the filters allow
  const odds = sourceOdds(filterSources(dealerFilters(), sourceReach(o)), spaceShare());
  const room = want - (forced ? 1 : 0);
  for (let attempt = 0; list.length < room && attempt < Math.max(6, room * 3) && !spentIo(io); attempt++) {
    const source = pickSource(odds, nextRandom(d));
    if (!source) break;
    add(
      source === "space"
        ? await spaceCandidate(io, d, exclude)
        : source === "contested"
          ? dealerFilters()?.rivals
            ? await rivalCandidate(io, d, exclude)
            : await contestedCandidate(io, d, exclude)
          : await openCandidate(io, d, exclude),
    );
  }
  return { list, forced, offline: io.offline };
}

/** Tells the ranking that the player's flat bonus on the candidate is already paid this cycle. */
function markSpent(c: Candidate): void {
  c.bonusSpent = state.bonusPaid[keyOf(c)] === state.standing.resets;
}

/** The candidates in order, best first: the learning dealer's draws once owned, else the prior. */
function rank(d: DealerState, list: readonly Candidate[]): Ranked[] {
  list.forEach(markSpent);
  return rankCandidates(list, inUse(owned(), "learning") ? state.picks.bandit : null, () => nextRandom(d));
}

/** A ranking for a candidate dealt without one (the first deal, a forced one). */
function plainRanked(c: Candidate): Ranked {
  markSpent(c);
  return rankCandidates([c], null, () => 0.5)[0];
}

/** A retaken problem comes back from the past, and keeps the base its entry still had. */
function retakeFromPast(p: ProblemState): void {
  const old = state.past.find((q) => q.key === p.key);
  if (old?.base !== undefined) p.base = old.base;
  state.past = state.past.filter((q) => q.key !== p.key);
}

/**
 * The problem a candidate becomes: an open problem starts bare; a site record, a retake or a
 * published value starts from a packing the server keeps (the leader's, or the best drawable one
 * for a published value) and must be improved on. Null when that packing cannot be read.
 */
async function materialize(c0: Candidate): Promise<ProblemState | null> {
  if (!isPolygon(c0)) return materializeSpace(c0);
  if (c0.tier === "open" && !c0.retake) return newProblem(c0, "open", now());
  const c = needPolygon(c0, "contested problems");
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
  } else if (c.leader?.id != null) {
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
  if (c.retake) retakeFromPast(p);
  return p;
}

/**
 * A space problem as dealt, from its GET just before: open without a leader (it starts bare), else a site
 * record that starts from the leader's board and must be improved on. It keeps the server's bound.
 * Null when it cannot be dealt now, or the leader's board is missing.
 */
async function materializeSpace(c: Candidate & SpaceKey): Promise<ProblemState | null> {
  const { read } = await fetchSpaceProblem(c.family, c.id);
  if (!spaceDealable(read)) return null;
  const p = newProblem(c, spaceTier(read), now());
  p.bound = read.bound;
  if (read.leader) {
    if (!read.config) return null;
    p.phase = "ready";
    p.board = read.config;
    p.best = read.leader.score;
    p.floor = read.leader.score;
    p.leader = { ...read.leader };
  }
  // a retaken problem comes back from the past
  if (c.retake) retakeFromPast(p);
  return p;
}

/** A problem dealt: into the queue, with what the learning dealer will learn from. */
function dealt(p: ProblemState, r: { bucket: string; prior: number }, retake = false, outside = false): void {
  takeToken(state.dealer);
  addToQueue(state, p);
  state.picks.dealt[p.key] = { bucket: r.bucket, prior: r.prior };
  // a problem dealt outside the filters is shown on the notice line, as the player may wonder why it came
  event(
    outside
      ? `Nothing fits your dealer filters, so a problem outside them was dealt: ${problemTitle(p)}${dealtNote(p)}.`
      : `${retake ? "Retake" : "Dealt"}: ${problemTitle(p)}${dealtNote(p)}.`,
    outside,
  );
  persist();
  showFocus();
}

/** What a dealt problem is, after its title in the log. */
function dealtNote(p: ProblemState): string {
  if (p.tier === "open") return "";
  if (p.tier === "published")
    return `, a published value to beat${p.leader ? ` (site record by ${p.leader.name})` : ""}`;
  if (p.leader?.id === null && !isPolygon(p)) return ", the research record to beat";
  return `, a ${TIER_LABEL[p.tier]} by ${p.leader?.name ?? "another name"}`;
}

/** Your pick: offers wait for the player; otherwise the dealer deals on its own. */
const picking = (o: ReadonlySet<UpgradeId>) => offerCount(o) > 0 && state.dealer.dealt > 0;

/** An offer the tree, the filters and the cycle's rule still allow (they may have changed since it was drawn). */
const offerAllowed = (o: Owned, x: Offer): boolean =>
  offerFits(x, { retake: inUse(o, "retake"), tiers: contestedTiers(o), ringMin: ringMin(o) }, allowed);

/** Auto-advance moves on: owned, with auto-eval switched on. */
const advancing = (o: ReadonlySet<UpgradeId>): boolean =>
  o.has("advance") && state.settings.auto && autoPerSecond(o) !== null;

/** Auto-advance's move now (game.ts advancePlan), or null without it. */
function plan(o: ReadonlySet<UpgradeId>): AdvancePlan | null {
  if (!advancing(o)) return null;
  return advancePlan(state, { slots: queueSize(o) });
}

/** A deal is earned by work (a token), whether or not a slot is free. */
function dealEarned(): boolean {
  const o = owned();
  return canDeal(state.dealer, queueSize(o));
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
  if (picking(o)) {
    // an offer older than 30 minutes leaves; its place is filled at the next deal
    if (expireOffers(state.picks, now()) > 0) persist();
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
      dealt(r.p, r.ranked, r.ranked.candidate.retake, r.outside);
    }
  } finally {
    dealing = false;
    render();
  }
}

/** Offline or nothing found: ask again in a while rather than every second. */
function pauseDealing(offline: boolean, filtered = false): void {
  dealPausedUntil = now() + OFFLINE_BACKOFF_MS;
  lastPauseOffline = offline;
  if (!state.queue.length)
    $("t-title").textContent = offline
      ? `The server cannot be reached, so no problem can be dealt. Trying again in ${OFFLINE_BACKOFF_MS / 1000} s…`
      : filtered
        ? "Nothing fits your dealer filters. Looking again…"
        : "Looking for an open problem…";
}

/**
 * Whether the last pause was because the server could not be reached (in memory only). Saving filters
 * ends any other pause at once, since new filters change what can be found.
 */
let lastPauseOffline = false;

/** The filters are why a deal or an offer fill found nothing: some are set, and the server answered. */
const filtersBlamed = (offline: boolean, found: number): boolean => !offline && found === 0 && !!dealerFilters();

/**
 * An empty queue never stays empty because of the filters: a problem is dealt as the dealer would
 * without them (the same sources and ranking, and the cycle's rule still applies). Null when it too found nothing.
 */
async function dealOutsideFilters(
  d: DealerState,
  exclude: Set<string>,
): Promise<{ p: ProblemState; ranked: Ranked } | null> {
  filtersOff = true;
  try {
    const { list, forced, offline } = await gatherCandidates(d, dealerChoices(owned()), exclude);
    if (offline) return null;
    for (const r of [...(forced ? [plainRanked(forced)] : []), ...rank(d, list)]) {
      const p = await materialize(r.candidate);
      if (p) return { p, ranked: r };
      skipped.add(keyOf(r.candidate));
    }
    return null;
  } finally {
    filtersOff = false;
  }
}

async function deal(d: DealerState): Promise<{ p: ProblemState; ranked: Ranked; outside?: boolean } | null> {
  const exclude = new Set([...seenKeys(state), ...skipped]);
  if (d.dealt === 0) {
    // the first problem comes from the starter corner while any of it is left open
    const io: DealIo = { gets: 0, offline: false };
    const ruled = ruleOpenProblems(state.standing);
    // the starter corner, then the rest of the frontier, then small problems of the wide set: the smallest open one found
    const ruledWide = ruleOpenWide(state.standing);
    const pools: Pool[] = ruled ? [{ keys: ruled }, { wide: true, skew: 2.5, rule: ruledWide }] : firstDealPools(STARTER, FRONTIER);
    for (let attempt = 0; attempt < 3 && !spentIo(io); attempt++) {
      const c = await openCandidate(io, d, exclude, pools);
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
  const filtered = filtersBlamed(offline, order.length);
  if (filtered && !slotted(state).length) {
    const r = await dealOutsideFilters(d, exclude);
    if (r) return { ...r, outside: true };
  }
  pauseDealing(offline, filtered);
  return null;
}

/** A free slot and a lane that would have nothing to do: fewer problems still making progress than lanes (Auto-advance takes an offer). */
function autoTakes(o: ReadonlySet<UpgradeId>): boolean {
  if (!advancing(o) || !mayDeal()) return false;
  const stall = stallAfter(state);
  const moving = slotted(state).filter((p) => !p.closed && p.sinceGain < stall);
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
    if (!ranked.length) {
      const filtered = filtersBlamed(offline, 0);
      const r = filtered && !slotted(state).length ? await dealOutsideFilters(d, exclude) : null;
      if (r) dealt(r.p, r.ranked, r.ranked.candidate.retake, true);
      else pauseDealing(offline, filtered);
    }
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

/**
 * The offer checked against the server just before it is taken: whether it stands, or null when the
 * server could not be reached. A space offer stands while it takes entries and has the same leader.
 */
async function offerCheck(x: Offer): Promise<boolean | null> {
  if (isPolygon(x)) {
    const info = await getProblem(x);
    return info ? offerStands(info, x) : null;
  }
  const { status, read } = await fetchSpaceProblem(x.family, x.id);
  if (status === null || status >= 500) return null;
  return spaceStands(read, x);
}

/** Takes an offer into the queue (the player's pick, or Auto-advance's, in place of `out` when given). */
async function takeOffer(x: Offer, auto = false, out: ProblemState | null = null): Promise<void> {
  if (!offerAllowed(owned(), x)) {
    state.picks.offers = state.picks.offers.filter((y) => y !== x);
    say(`The offer of ${problemTitle(x)} is gone. Your reach, filters or rule no longer allow it.`);
    persist();
    return;
  }
  if (out ? !dealEarned() : !mayDeal()) {
    if (!auto)
      say(
        slotted(state).length >= queueSize(owned())
          ? "Every slot is full. Drop a problem to make room."
          : `The next problem comes after ${workText(clicksToDeal())}.`,
      );
    return;
  }
  const stands = await offerCheck(x);
  if (stands === null) {
    pauseDealing(true);
    say("The server cannot be reached. The offer stays until it can be checked.");
    return;
  }
  state.picks.offers = state.picks.offers.filter((y) => y !== x);
  const title = problemTitle(x);
  if (!stands) {
    skipped.add(keyOf(x));
    event(`The offer of ${title} is gone. Someone took it, or its record moved.`);
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

/** Skip: the offer leaves and its problem is not offered again this session. */
function onSkipOffer(key: string): void {
  if (!ownsGame) return;
  const x = skipOffer(state.picks, key);
  if (!x) return;
  skipped.add(keyOf(x));
  event(`Skipped the offer of ${problemTitle(x)}.`, false);
  persist();
  render();
  void dealTick();
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

/** Clicks until the next deal (0: one is due), auto-eval's evaluations counting AUTO_CLICK_EVALS to one. */
function clicksToDeal(): number {
  return clicksToNextDeal(state.dealer, queueSize(owned()));
}

/** The work that earns `clicks` clicks: "120 more clicks", with auto-eval "or 1,200 evaluations of auto-eval". */
function workText(clicks: number, more = true): string {
  const own = `${fmtInt(clicks)}${more ? " more" : ""} click${clicks === 1 ? "" : "s"}`;
  return autoPerSecond(owned()) === null ? own : `${own} or ${evals(clicks * AUTO_CLICK_EVALS)} of auto-eval`;
}

// ---------- records held: live leader changes ----------

/** Counted already: a rival's taking of one record (problem and entry), so that an answer and a later read do not both count it. */
const rivalCounted = new Set<string>();

/** A name took a record from the player: it goes to the front of the rivals (once for each entry). */
function noteRival(key: string, leader: Leader | null): void {
  if (!leader || leader.id === null) return;
  const mark = `${key}#${leader.id}`;
  if (rivalCounted.has(mark)) return;
  if (addRival(state.picks.rivals, leader.name, state.name)) rivalCounted.add(mark);
}

/**
 * A leader read from the server: settles a send whose answer was lost (its points confirmed, as its
 * answer would have) and tells the player when a record of theirs was beaten.
 */
function noteLeader(p: ProblemState | PastProblem, leader: Leader | null, quiet = false): void {
  const r = applyLeader(p, leader, state, now());
  // an archived record that is lost leaves the archive (a payday tells of all of them in one line)
  if (r.lost) {
    const a = archiveOf(state);
    if (a?.get(p.key) === p) a.remove(p.key);
  }
  if (r.reconciled && leader) {
    reveal(state, "points", "upgrades");
    event(
      `The server made ${show6(leader.score)} the record for ${problemTitle(p)}` +
        `${r.confirmed > 0 ? ` (${fmtRP(r.confirmed)} RP confirmed)` : ""}. The game matched your entry to the record, because the server's answer had not arrived.`,
    );
  } else if (r.lost) {
    // Retake: a record lost after it left the queue is offered again first
    const retake = inUse(owned(), "retake") && !problem(state, p.key);
    if (retake) addRetake(state.picks, p.key);
    noteRival(p.key, leader);
    if (!quiet)
      event(
        `Your record on ${problemTitle(p)} was beaten${leader ? ` by ${leader.name}, with ${show6(leader.score)}` : ""}.` +
          (retake ? " It will be the first problem offered to you again (Retake)." : ""),
      );
  }
}

function onLeaderEvent(e: LeaderboardEvent): void {
  const key = keyOf(poly(e.N, e.M, e.P));
  // our own entry, announced before its answer arrives; a rival's is seen in that answer instead
  if (!ownsGame || inFlight.has(key)) return;
  const target = problem(state, key) ?? state.past.find((p) => p.key === key) ?? archiveOf(state)?.get(key);
  if (!target) return;
  noteLeader(target, { score: e.score, name: e.name, id: e.id });
  persist();
  render();
}
/**
 * Live leader changes, of the problems in the queue and the records held only (see followed). The
 * stream follows them as they change, checked every second; without it, records held are checked
 * when the game next looks at each problem.
 */
const feed = new api.LiveFeed(onLeaderEvent);
function listen(): void {
  feed.follow(eventKeys(followed(state)));
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
    // space problems are followed by followSpace, at most one read every 10 s
    if (!isPolygon(p)) continue;
    const info = await readLeader(p);
    if (!info) return;
    if (inFlight.has(p.key)) continue;
    noteLeader(p, info.leader);
    persist();
    render();
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Once per save, after the archive has loaded: records the save lost before the archive existed are
 * looked up on the server (recovery.ts). A failed try is repeated at a later load.
 */
let recovering = false;
async function findLostRecords(): Promise<void> {
  if (recovering || !ownsGame || state.archiveRecovered || !state.name) return;
  recovering = true;
  try {
    const s = state;
    const n = await recoverRecords(s, owned(), { getHolder: api.getHolder, getLeaders: api.getLeaders, now });
    if (s !== state) return;
    if (n !== null) persist();
    if (n) {
      event(
        `${fmtInt(n)} of your older records ${n === 1 ? "was" : "were"} found on the server and count${n === 1 ? "s" : ""} again.`,
      );
      render();
    }
  } finally {
    recovering = false;
  }
}

// ---------- rent: a payday every day at noon ----------

let paydayRunning = false;

/**
 * With Rent: once the saved payday time (economy.paydayAt) has come, all records held are looked up
 * in batches (payday.ts) and, when every batch has answered, the ones still ours pay the rent for
 * their window. The next payday is the next local noon. A failed request pays nothing and is tried
 * again 10 minutes later. A save without a payday time runs one at
 * its next load.
 */
async function paydayTick(): Promise<void> {
  const o = owned();
  // the archived records are part of the payday: it waits until they have loaded
  if (!ownsGame || paydayRunning || !o.has("rent") || !archiveReady(state)) return;
  if (now() < paydayDueAt(state.economy, now())) return;
  paydayRunning = true;
  try {
    const r = await runPayday({
      state,
      owned: o,
      now,
      getLeaders: api.getLeaders,
      noteLeader,
      busy: (p) => inFlight.has(p.key) || ("sending" in p && !!p.sending),
      active: () => ownsGame,
      batchDone: () => {
        reveal(state, "points", "upgrades");
        persist();
        render();
      },
    });
    state.economy.paydayAt = nextPaydayAfter(now(), r.unanswered);
    persist();
    if (r.archivedLost > 0)
      event(
        `${fmtInt(r.archivedLost)} of your records ${r.archivedLost === 1 ? "was" : "were"} beaten since the last payday.`,
      );
    if (r.paying > 0)
      event(
        `Payday. ${fmtInt(r.paying)} ${r.paying === 1 ? "record paid" : "records paid"} ${fmtRP(r.paid)} RP in rent.`,
        false,
      );
  } finally {
    paydayRunning = false;
  }
}

let spaceFollowing = false;
/** When each space problem was last read for its leader, by key. */
const spaceFollowedAt = new Map<string, number>();

/**
 * Space problems have no live feed: the queue's are read for their leader one at a time, the one
 * read longest ago first, and all together at most once every SPACE_READ_MS (readLeader).
 */
async function followSpace(): Promise<void> {
  if (!ownsGame || spaceFollowing || now() - spaceReadAt < SPACE_READ_MS) return;
  const next = state.queue
    .filter((p) => !isPolygon(p) && !p.sending && !inFlight.has(p.key) && !p.leaving && !p.closed)
    .sort((a, b) => (spaceFollowedAt.get(a.key) ?? 0) - (spaceFollowedAt.get(b.key) ?? 0))[0];
  if (!next) return;
  spaceFollowing = true;
  spaceFollowedAt.set(next.key, now());
  try {
    const info = await readLeader(next);
    if (!info || inFlight.has(next.key) || !ownsGame || problem(state, next.key) !== next) return;
    noteLeader(next, info.leader);
    persist();
  } finally {
    spaceFollowing = false;
  }
}

// ---------- rendering ----------

/**
 * Renders asked for by lane progress and settles run at most ten times a second: each is a pass
 * over the whole page, and a busy save asks once a frame. The player's actions and the ticker call
 * render() directly and stay immediate.
 */
const pace = renderPace({
  now: () => performance.now(),
  frame: (cb) => requestAnimationFrame(cb),
  later: (cb, ms) => window.setTimeout(cb, ms),
  render: () => render(),
});
const scheduleRender = (): void => pace.request();

function text(id: string, value: string): void {
  const el = $(id);
  if (el.textContent !== value) el.textContent = value;
}
function show(id: string, visible: boolean): void {
  const el = $(id);
  if (el.hidden === visible) el.hidden = !visible;
}

function render(): void {
  pace.rendered();
  const s = state;
  const o = owned();
  const p = focused();
  ensureLanes();
  showFocus();

  // reveals: a panel once shown stays
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
  // the rate is all lanes' together: they share it
  text("t-bar-auto", rate !== null && s.settings.auto ? fmtRate(rate) : "off");
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
  renderName();
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
      ? "Auto-eval pauses while this tab is hidden, unless the first box above is ticked."
      : "Auto-eval pauses while this tab is hidden. The Continuous upgrade lets it keep running.",
  );
  renderStanding(o);
  renderResetDialog(o);
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
  text("t-title", isPolygon(p) ? problemTitle(p) : rulesOf(p).title(p));
  text("t-problem-count", countText(p));
  let note: string;
  if (p.closed) note = "This problem is closed. The server takes no more entries.";
  else if (p.leaving) note = "This problem leaves the queue once your best board is sent.";
  else if (p.ourId !== null)
    note =
      `You hold the record for this problem, ${show6(p.verified!)}.` +
      (p.published !== null && p.verified! > p.published
        ? ` The published value ${show6(p.published)} is still smaller. Nothing pays until you beat it.`
        : "");
  else if (p.tier === "published")
    note =
      `Beat the published value ${show6(p.published!)} to earn points. Taking the lead pays a ${fmtInt(LEAD_BONUS)} RP bonus, and an administrator reviews the record.` +
      (p.leader ? ` The site's record is ${show6(p.leader.score)}, by ${p.leader.name}.` : "");
  else if (p.leader && p.tier !== "open" && !p.run)
    note =
      `${TIER_LABEL[p.tier][0].toUpperCase()}${TIER_LABEL[p.tier].slice(1)} ${show6(p.leader.score)} by ${p.leader.name}, ${fmtPct(gapTo(p, p.leader.score))} above the ${isPolygon(p) ? "area bound" : "bound"}. ` +
      `Taking the lead here pays a ${fmtInt(LEAD_BONUS)} RP bonus.`;
  else if (p.leader) note = `The record is ${show6(p.leader.score)}, by ${p.leader.name}.`;
  else if (p.phase === "ready") note = "Your record has not been sent yet.";
  else note = "No one has sent a packing for this problem yet. Any board below the starting score is a new record.";
  text("t-problem-note", note);
  // before the queue, one problem at a time: the next one is earned by work
  const single = queueSize(owned()) <= 1;
  show("t-next", single && evolvable(p));
  if (single && evolvable(p)) {
    const left = clicksToDeal();
    const ready = left === 0;
    $<HTMLButtonElement>("t-next").disabled = !ready || dealing;
    text("t-next", ready ? "Next problem" : `Next problem after ${fmtInt(left)} click${left === 1 ? "" : "s"}`);
    $("t-next").title = ready ? "" : `The next problem comes after ${workText(left)}.`;
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
  // one button: the first click on a board that has only been placed compacts it (100 evaluations)
  const first = !!p && compactsFirst(p);
  const k = evalsPerClick(o);
  text("t-evolve", first ? "Evolve (compacts first)" : k === 1 ? "Evolve" : `Evolve ×${k}`);
  $<HTMLButtonElement>("t-evolve").disabled =
    !p || p.phase === "bare" || p.leaving || p.closed || (!first && !canEvolve && !compacting(p.key));
  $("t-evolve").title = !p
    ? "There is no problem on the board yet."
    : p.phase === "bare"
      ? "The pieces are being placed."
      : first
        ? isPolygon(p)
          ? `Your first click compacts the board with ${evals(COMPACT_EVALS)} of mc_compress. After that, each click runs ${evals(k)}.`
          : `Your first click compacts the loosely placed board. It runs until mc_compress hands back its first finished packing, however long that takes, and counts as ${evals(COMPACT_EVALS)}. After that, each click runs ${evals(k)}.`
        : `Each click runs ${evals(k)} on this board.`;
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
          m === "auto" ? (o.has("autoTune") ? "Auto (methods and settings)" : "Auto (method match)") : methodLabel(m);
        opt.disabled = m !== "auto" && !ruleAllowsMethod(state.standing, m as EvolveMethod);
        return opt;
      }),
    );
  }
  if (!ms.includes(state.settings.method)) state.settings.method = "mc_compress";
  const selected = canAuto && state.runplan.auto ? "auto" : state.settings.method;
  if (select.value !== selected) select.value = selected;
  select.title = piped(o)
    ? "Your pipeline in the Runs panel picks each new run's method."
    : canAuto && state.runplan.auto
      ? "The game picks each new run's method from what has paid best on similar problems."
      : `The method your clicks use. Changing it starts a new run. ${methodGame(state.settings.method).bestFor ?? ""}`.trim();
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
    const note = methodGame(run.method).runNote?.(runView(run, p, lv?.progress)) ?? "";
    info = `${methodLabel(run.method)}${run.level ? ` · setting ${run.level}` : ""}${how} · run at ${runAt(run, going)}${note}`;
    const queued = lv!.jobs.filter((j) => j.click).reduce((t, j) => t + j.evals, 0);
    if (queued) info += ` · ${evals(queued)} queued`;
  } else if (p) {
    info = p.phase === "bare" ? "Placing the pieces…" : `${p.P} pieces placed`;
    if (lv?.current?.compact) info = `Compact · mc_compress · ${evals(lv.progress?.evaluations ?? 0)}`;
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
  // density is the pieces' area over the container's: for polygons only
  const flat = isPolygon(p);
  for (const id of ["t-density-label", "t-density"]) show(id, flat);
  const sp = flat ? null : spaceScoreBox(p, p.best);
  text("t-side-label", sp ? sp.label : sideWord(p) === "diameter" ? "Diameter d" : "Side s");
  text("t-bound-label", flat ? "Area bound" : "Lower bound");
  const b = sp ? sp.bound : rulesOf(p).bound(p)!;
  text("t-bound", b === null ? "—" : show6(b));
  if (p.best === null || p.phase === "bare") {
    for (const id of ["t-side", "t-delta", "t-gap", "t-density"]) text(id, "—");
  } else {
    text("t-side", show6(p.best));
    text("t-gap", b === null ? "—" : fmtPct(p.best / b - 1));
    if (flat) text("t-density", density(p, p.best).toFixed(3));
    const c = lastChange.get(p.key);
    const delta = $("t-delta");
    if (c && c.improved && c.before !== null && c.after !== null) {
      const chip = document.createElement("span");
      chip.className = "chip good";
      chip.textContent = fmtChange(c.before, c.after) + (c.points ? ` · +${fmtRP(c.points.total)} RP` : "");
      if (delta.textContent !== chip.textContent) delta.replaceChildren(chip);
    } else {
      text("t-delta", c ? "no change" : "—");
    }
  }
  text("t-prob-rp", fmtRP(p.rp));
  renderPays(p);
  renderPayDetail(p);
  text(
    "t-record",
    p.ourId !== null
      ? `yours, ${show6(p.verified!)}`
      : p.leader
        ? `${show6(p.leader.score)} by ${p.leader.name}`
        : "none yet",
  );
  renderTraces(p, o.has("trace"));
}

/** The More detail button under the score box: how the last payment on the board's problem was made up. */
function renderPayDetail(p: ProblemState): void {
  const row = $("t-pay-more");
  const c = lastChange.get(p.key);
  const why = c?.improved && c.points ? payDetail(c.points as PaidPoints) : [];
  const sig = why.join("|");
  if (row.dataset.sig === sig) return;
  row.dataset.sig = sig;
  row.replaceChildren(...(why.length ? [moreDetail({ text: why }, "The last payment", "t-pay-detail")] : []));
}

/** The score box's two pay rows: what multiplies the problem's improvements, and the bonus it can still pay. */
function renderPays(p: ProblemState): void {
  const o = owned();
  const standing = standingMultiplier(state.standing);
  const collectionsF = 1 + collectionsBonus(state, o);
  // the rule rewards are what is left of the game's own multiplier, so this row never prices pay itself
  const rules = multiplierFor(state, p) / (standing * collectionsF);
  const parts = { shape: rulesOf(p).weight(p), cost: costFactor(p), standing, collections: collectionsF, rules };
  text("t-pays", multiplierRow(parts));
  $("t-pays").title = multiplierTitle();
  const spent = state.bonusPaid[p.key] === state.standing.resets;
  const hasRecord = p.paidTo !== null || p.leader !== null || p.verified !== null || p.published !== null;
  text("t-bonus", bonusRow(bonusKindOf({ hasRecord }), spent));
  $("t-bonus").title =
    "A flat bonus, paid once per problem each cycle and not multiplied. The first record on a problem that has none pays only the bonus.";
}

/**
 * The graphs in the board's corner, always there, on one scale of evaluations run here: the side
 * after each improvement here (Trace detail adds its labels and a mark at each improvement), and
 * under it the RP paid here so far, noted only "RP".
 */
function renderTraces(p: ProblemState, detail: boolean): void {
  const svg = $("t-trace") as unknown as SVGSVGElement;
  const rpSvg = $("t-rp-trace") as unknown as SVGSVGElement;
  const tr = p.trace;
  const rt = p.rpTrace;
  const visible = tr.length >= 2;
  const rpVisible = rt.length >= 2;
  svg.toggleAttribute("hidden", !visible);
  rpSvg.toggleAttribute("hidden", !rpVisible);
  show("t-trace-empty", !visible);
  const drawn = [...(visible ? [tr] : []), ...(rpVisible ? [rt] : [])];
  if (!drawn.length) return;
  const e0 = Math.min(...drawn.map((t) => t[0][0])),
    e1 = Math.max(...drawn.map((t) => t[t.length - 1][0]));
  const span = e1 - e0 || 1;
  /** A point's place: x by evaluations, y from the highest value at `top` to the lowest at `bottom`. */
  const placer = (values: readonly number[], top: number, bottom: number) => {
    const high = Math.max(...values),
      low = Math.min(...values);
    const range = high - low || high * 1e-6 || 1;
    return ([e, v]: [number, number]) =>
      [10 + (280 * (e - e0)) / span, top + ((bottom - top) * (high - v)) / range] as const;
  };
  const NS = "http://www.w3.org/2000/svg";
  const polyline = (t: readonly [number, number][], pt: ReturnType<typeof placer>) => {
    const line = document.createElementNS(NS, "polyline");
    line.setAttribute(
      "points",
      t
        .map(pt)
        .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(2)}`)
        .join(" "),
    );
    return line;
  };
  const sig = `${p.key}|${tr.length}|${tr.at(-1)?.[1]}|${detail}|${e0}|${e1}`;
  if (visible && svg.dataset.sig !== sig) {
    svg.dataset.sig = sig;
    const sides = tr.map(([, v]) => v);
    const pt = placer(sides, 10, detail ? 72 : 88);
    const parts: SVGElement[] = [polyline(tr, pt)];
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
      label.textContent = `${show6(sides[0])} → ${show6(sides[sides.length - 1])} · ${fmtInt(tr.length)} improvements · ${evals(tr[tr.length - 1][0] - tr[0][0])}`;
      parts.push(label);
    }
    svg.replaceChildren(...parts);
    svg.setAttribute(
      "aria-label",
      `Side after each improvement, from ${show6(sides[0])} to ${show6(sides[sides.length - 1])} over ${evals(tr[tr.length - 1][0] - tr[0][0])}`,
    );
  }
  const rpSig = `${p.key}|${rt.length}|${rt.at(-1)?.[1]}|${e0}|${e1}`;
  if (rpVisible && rpSvg.dataset.sig !== rpSig) {
    rpSvg.dataset.sig = rpSig;
    const paid = rt.map(([, v]) => v);
    // the RP rises from the bottom left, so its note sits in the bottom right
    const note = document.createElementNS(NS, "text");
    note.setAttribute("x", "290");
    note.setAttribute("y", "58");
    note.setAttribute("text-anchor", "end");
    note.textContent = "RP";
    rpSvg.replaceChildren(polyline(rt, placer(paid, 6, 58)), note);
    rpSvg.setAttribute(
      "aria-label",
      `RP earned here, from ${fmtRP(paid[0])} to ${fmtRP(paid[paid.length - 1])} over ${evals(rt[rt.length - 1][0] - rt[0][0])}`,
    );
  }
}

function renderName(): void {
  text("t-name-now", state.name);
  text("t-name-note", `Your records are sent to PolyPack as “${state.name}”.`);
}

/** The income table as last drawn, so that the page is touched only when it changes. */
let incomeShown = "";
/** Record points of the last hour by problem group and source (income.ts), shown with the totals. */
function renderIncome(): void {
  const on = revealed(state, "points");
  show("t-income", on);
  if (!on) return;
  const sums = income.sums(now());
  const num = (n: number | undefined) => (n ? fmtInt(n) : "0");
  const note =
    sums.total > 0
      ? `Record points earned in the last hour, counted since this page opened. Rent counts when a payday pays it.`
      : "No record points yet in the last hour. Improvements and rent paydays appear here as they pay.";
  const rows = GROUPS.filter((g) => sums.byGroup[g.id]).map(
    (g) =>
      `<tr><th scope="row">${g.label}</th>${SOURCES.map((s) => `<td>${num(sums.cells[`${g.id}/${s.id}`])}</td>`).join("")}<td>${num(sums.byGroup[g.id])}</td></tr>`,
  );
  const html =
    `<thead><tr><th scope="col">Last hour</th>${SOURCES.map((s) => `<th scope="col">${s.label}</th>`).join("")}<th scope="col">Total</th></tr></thead>` +
    `<tbody>${rows.join("")}</tbody>` +
    `<tfoot><tr><th scope="row">All</th>${SOURCES.map((s) => `<td>${num(sums.bySource[s.id])}</td>`).join("")}<td>${num(sums.total)}</td></tr></tfoot>`;
  const shown = note + html;
  if (shown === incomeShown) return;
  incomeShown = shown;
  text("t-income-note", note);
  $("t-income-table").innerHTML = html;
}

/** The points themselves are in the totals; the panel keeps their explanations and the name nudge. */
function renderPoints(): void {
  show("t-points-help", revealed(state, "points"));
  renderIncome();
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
  (id) => canBuy(owned(), fundsOf(state), id).ok,
  (id) => onSwitch(id),
);
/** The tech tree is the view in place of the board (kept while the page is open). */
let treeOpen = false;
function renderUpgrades(o: Owned): void {
  const on = revealed(state, "upgrades");
  show("t-views", on);
  if (!on) treeOpen = false;
  show("t-board-view", !treeOpen);
  show("t-upgrades", treeOpen);
  const funds = fundsOf(state);
  // the tab count and the next-up line need only the summary; the whole view only while the tree shows
  let v: ReturnType<typeof treeSummary> = treeSummary(o, funds);
  if (treeOpen) {
    let full = treeView(o, funds);
    // Faster auto-eval's card says so when more levels would run no faster on this computer
    if (overComputerLimit(o))
      full = {
        ...full,
        nodes: full.nodes.map((n) =>
          n.id !== "autox"
            ? n
            : {
                ...n,
                levelText: `${n.levelText ?? "Level 0"}. More levels will not be faster on this computer.`,
                how: n.how ? { ...n.how, text: [AUTO_LIMIT_WARNING, ...n.how.text] } : n.how,
              },
        ),
      };
    tree.render(full, funds);
    v = full;
  }
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
    points: any("t-points-help", "t-income", "t-standing", "t-records"),
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
const totalsFocus = () => ($("t-bar").tabIndex = phoneLayout.matches ? 0 : -1);
totalsFocus();
phoneLayout.addEventListener("change", totalsFocus);
// a turn of the phone can bring the board back (or take it away) without a tap
phoneLayout.addEventListener("change", scheduleRender);

// on a phone the status line shows three lines; a tap shows all of it
statusEl.addEventListener("click", () => {
  statusEl.dataset.open = String(statusEl.dataset.open !== "true");
});

/** The line for the upgrades Head start gave (when bought, or at load). */
function headStartNote(n: number): string {
  return `Head start gave you ${n} upgrade${n === 1 ? "" : "s"}.`;
}

function onBuy(id: UpgradeId): void {
  accrueAuto();
  // a lane past the CPU's cores would add nothing
  if (id === "lanesx" && lanesMaxed(owned())) return;
  // Standing is the reset: it asks first
  if (id === "standing") return openResetDialog();
  if (!buy(state, id)) return;
  // Rent bought: the records held start earning from now
  if (id === "rent") tidyRent(state, owned(), now());
  // Head start gives its cards now as well as at each reset
  const headGiven = id === "head" ? grantHeadStart(state, now()).length : 0;
  const u = upgrade(id);
  const l = u.levels ? ` (level ${level(owned(), id)})` : "";
  event(`Bought ${u.name}${l}. ${u.effect}`, false);
  say(`Bought ${u.name}${l}. ${u.effect}`);
  if (headGiven > 0) {
    event(headStartNote(headGiven), false);
    say(headStartNote(headGiven));
  }
  ensureLanes();
  persist();
  render();
  void dealTick();
  kickLanes();
}

/** Turns a dealer upgrade off, or on again (its switch in the tech tree). */
function onSwitch(id: UpgradeId): void {
  const sw = switchOf(id);
  if (!sw || !owned().has(id)) return;
  const off = new Set(state.settings.off);
  // it was off: it goes on again
  const on = off.delete(sw);
  if (!on) off.add(sw);
  state.settings.off = SWITCHES.filter((x) => off.has(x));
  // Your pick off: the dealer deals on its own, and the offers waiting are cleared
  if (sw === "pick3" && !on) state.picks.offers = [];
  const name = switchName(owned(), sw);
  const line = on ? `Turned on ${name} again.` : `Turned off ${name}. ${offText(sw)}`;
  event(line, false);
  say(line);
  persist();
  render();
  void dealTick();
}

let queueSig = "";
/** The problem's rows under the pointer must not move or be replaced while lanes improve them: the rows are built only when the problems or their order change. */
function renderQueue(o: ReadonlySet<UpgradeId>): void {
  show("t-queue", revealed(state, "queue"));
  if (!revealed(state, "queue")) return;
  const slots = queueSize(o);
  text("t-queue-heading", `Queue · ${slots} ${slots === 1 ? "slot" : "slots"}`);
  text("t-queue-work", queueWorkText(o));
  const list = $("t-queue-list");
  // a problem that is leaving (dropped, its best still to be sent) is no row: one line under the list counts them
  const rows = slotted(state);
  const sig = rows.map((p) => p.key).join(";");
  if (sig !== queueSig) {
    queueSig = sig;
    // keyboard focus on a button survives the rebuild
    const active =
      document.activeElement instanceof HTMLElement && list.contains(document.activeElement)
        ? document.activeElement
        : null;
    const refocus = active ? { key: active.closest("li")?.dataset.key, cls: active.dataset.act } : null;
    list.replaceChildren(
      ...rows.map((p) => {
        const li = document.createElement("li");
        li.dataset.key = p.key;
        const title = document.createElement("span");
        title.className = "t-q-title";
        const status = document.createElement("span");
        status.className = "t-q-status";
        const count = document.createElement("span");
        count.className = "t-q-count";
        const side = document.createElement("div");
        side.className = "t-q-actions";
        const live = document.createElement("span");
        live.className = "t-q-live";
        live.textContent = "Working";
        const button = (act: string, label: string, click: () => void) => {
          const b = document.createElement("button");
          b.dataset.act = act;
          b.textContent = label;
          b.addEventListener("click", click);
          return b;
        };
        const key = p.key;
        side.append(
          button("show", "Show", () => {
            state.focus = key;
            persist();
            showFocus();
            render();
          }),
          button("keep", "Keep", () => {
            const q = problem(state, key);
            if (!q) return;
            q.kept = !q.kept;
            persist();
            render();
          }),
          button("drop", "Drop", () => onDrop(key)),
        );
        li.append(title, side, status, live, count);
        return li;
      }),
    );
    if (refocus)
      list
        .querySelector<HTMLElement>(`li[data-key="${CSS.escape(refocus.key ?? "")}"] [data-act="${refocus.cls}"]`)
        ?.focus();
  }
  // everything that changes while lanes work is written in place: no row, button or mark is replaced or moves
  const busy = new Set(lanes.flatMap(workingKeys));
  const t = now();
  sampleRp(t);
  for (const li of list.children as HTMLCollectionOf<HTMLElement>) {
    const p = problem(state, li.dataset.key ?? null);
    if (!p) continue;
    const gap = p.best !== null && p.phase !== "bare" ? `gap ${fmtPct(gapTo(p, p.best))}` : "";
    const status =
      p.ourId !== null
        ? "yours"
        : p.tier === "published"
          ? "published value"
          : p.tier !== "open"
            ? p.leader?.id === null && !isPolygon(p)
              ? "research record to beat"
              : `${TIER_LABEL[p.tier]} by ${p.leader?.name ?? "?"}`
            : p.phase === "bare"
              ? "no record yet"
              : "";
    const focus = p.key === state.focus;
    li.classList.toggle("focus", focus);
    setText(li.querySelector(".t-q-title"), problemTitle(p));
    setText(li.querySelector(".t-q-status"), [gap, status].filter(Boolean).join(" · "));
    setText(li.querySelector(".t-q-count"), countText(p));
    // the "Working" mark is text as well as a dot, so it reads without colour; its slot is always there
    li.querySelector(".t-q-live")?.classList.toggle("on", busy.has(p.key));
    const showBtn = li.querySelector<HTMLButtonElement>('[data-act="show"]')!;
    showBtn.style.visibility = focus ? "hidden" : "";
    showBtn.disabled = focus;
    showBtn.setAttribute("aria-label", `Show ${problemTitle(p)} on the board`);
    const keep = li.querySelector<HTMLButtonElement>('[data-act="keep"]')!;
    setText(keep, p.kept ? "Kept" : "Keep");
    keep.setAttribute("aria-pressed", String(p.kept));
    keep.setAttribute(
      "aria-label",
      p.kept
        ? `Kept ${problemTitle(p)}, Auto-advance will not drop it`
        : `Keep ${problemTitle(p)}, so that Auto-advance does not drop it`,
    );
    li.querySelector('[data-act="drop"]')?.setAttribute("aria-label", `Drop ${problemTitle(p)} from the queue`);
  }
  const leaving = state.queue.filter((p) => p.leaving).length;
  const note = $("t-queue-leaving");
  note.hidden = leaving === 0;
  setText(
    note,
    leaving === 1
      ? "1 problem is leaving. It goes once its best is sent."
      : `${leaving} problems are leaving. They go once their best is sent.`,
  );
  text("t-deal", dealText(o));
  renderAdvance(o);
  renderOffers(o);
  renderFilters(o);
}

/** Sets an element's text only when it differs, so that an unchanged line is not touched. */
function setText(el: Element | null, value: string): void {
  if (el && el.textContent !== value) el.textContent = value;
  // a cut line shows in full as the tooltip
  if (el instanceof HTMLElement && el.classList.contains("t-q-status") && el.title !== value) el.title = value;
}

/** What each problem in the queue has paid, sampled while the page runs: [time, RP] (nothing is saved). */
const RP_WINDOW_MS = 10 * 60_000;
const rpSamples = new Map<string, [number, number][]>();
function sampleRp(t: number): void {
  for (const k of [...rpSamples.keys()]) if (!state.queue.some((p) => p.key === k)) rpSamples.delete(k);
  for (const p of state.queue) {
    let s = rpSamples.get(p.key);
    if (!s) {
      // a problem dealt within the window started at 0 RP when it arrived
      s = t - p.dealtAt < RP_WINDOW_MS && p.dealtAt <= t ? [[p.dealtAt, 0]] : [];
      rpSamples.set(p.key, s);
    }
    if (!s.length || t - s[s.length - 1][0] >= 5000) s.push([t, p.rp]);
    // keep one sample from before the window, so that the rate covers all of it
    while (s.length > 1 && s[1][0] <= t - RP_WINDOW_MS) s.shift();
  }
}

/** RP a minute the problem paid over the last 10 minutes it was in the queue (since it arrived if less); null before 30 seconds of history. */
function rpPerMinute(p: ProblemState): number | null {
  const s = rpSamples.get(p.key);
  if (!s?.length) return null;
  const t = now();
  // the latest sample at or before the window's start, else the first one (the problem's arrival)
  let base = s[0];
  for (const x of s) if (x[0] <= t - RP_WINDOW_MS) base = x;
  const span = t - base[0];
  if (!(span >= 30_000)) return null;
  return Math.max(0, p.rp - base[1]) / (span / 60_000);
}

/** One plain sentence on which problem clicks work on, and which problems auto-eval works on. */
function queueWorkText(o: Owned): string {
  const board = focused();
  const clicks = board
    ? `Your clicks work on ${problemTitle(board)}, the problem on the board.`
    : "Your clicks work on the problem on the board.";
  if (!o.has("auto1") && !o.has("lanes2")) return clicks;
  const n = lanes.length;
  const how =
    n > 1
      ? `Auto-eval works on the problems in the queue one at a time in each of your ${n} lanes.`
      : "Auto-eval works on the problems in the queue one at a time.";
  return `${clicks} ${how}${state.settings.auto ? "" : " It is off now."}`;
}

/** Evaluations a long step under way on the problem has done that its counters do not have yet. */
function stepping(p: ProblemState): number {
  const lv = lanes.find((l) => l.current?.key === p.key && l.run?.key === p.key);
  return lv?.progress && lv.run ? Math.max(0, lv.progress.evaluations - lv.run.evaluations) : 0;
}

/** A problem's counters, live: "12,345 evaluations · 830 since progress · 1,240 RP a minute". */
function countText(p: ProblemState): string {
  const going = stepping(p);
  const rate = rpPerMinute(p);
  return `${evals(p.evaluations + going)} · ${fmtInt(p.sinceGain + going)} since progress${rate === null ? "" : ` · ${fmtInt(rate)} RP a minute`}`;
}

/** The queue's dealing line: when the next problem comes, and with Auto-advance which one leaves next. */
function dealText(o: Owned): string {
  const free = queueSize(o) - slotted(state).length;
  const left = clicksToDeal();
  const more = workText(left);
  const offers = state.picks.offers.length;
  const line = picking(o)
    ? offers && mayDeal()
      ? `Pick a problem from the ${offers === 1 ? "offer" : `${offers} offers`} below.`
      : offers
        ? free > 0
          ? `The offers wait for a free slot. The next one comes after ${more}.`
          : "The offers wait for a free slot. Every slot is full. Drop a problem to take one."
        : free > 0 && left > 0
          ? `New offers come after ${more}.`
          : free > 0
            ? "Drawing offers…"
            : "Every slot is full. Drop a problem to take a new one."
    : free > 0
      ? left === 0
        ? "Dealing a problem…"
        : `The next problem comes after ${more}.`
      : `Every slot is full. Each slot gets a new problem per ${workText(DEAL_CLICKS, false)}. Drop a problem to take one.`;
  // with auto-eval off nothing leaves, but the line still says which problem waits and why
  const due = o.has("advance") ? advancePlan(state, { slots: queueSize(o) }).due : null;
  if (!due) return line;
  const why = `${problemTitle(due)} has run ${evals(due.sinceGain)} without progress.`;
  if (!advancing(o)) return `${line} ${why} Auto-advance replaces it once you switch auto-eval on.`;
  return `${line} ${why} Auto-advance replaces it ${left > 0 ? `when the next problem comes, after ${more}` : "as soon as a new problem is found"}.`;
}

/** The percentage a tolerance is: 10⁻⁶ is "0.0001 %". */
const fmtTolerance = (t: number) => `${(t * 100).toFixed(Math.max(0, Math.round(-Math.log10(t)) - 2))} %`;

/** Auto-advance's settings, once it is owned: the tolerance and the patience, and what they mean now. */
function renderAdvance(o: Owned): void {
  show("t-advance", o.has("advance"));
  if (!o.has("advance")) return;
  const { tolerance, patience, leadPatience } = state.settings;
  const tol = $<HTMLSelectElement>("t-tolerance");
  const tv = `1e${Math.round(Math.log10(tolerance))}`;
  if (tol.value !== tv) tol.value = tv;
  patienceFields("t-patience", patience);
  patienceFields("t-patience-lead", leadPatience);
  const when = (n: number | null, who: string) =>
    n === null
      ? `With ${who}, Auto-advance does not drop a problem.`
      : `With ${who}, it drops a problem after ${evals(n)} without progress, once a new one can take its slot.`;
  text(
    "t-advance-note",
    `A problem makes progress when its best gets at least ${fmtTolerance(tolerance)} smaller than at its last progress. ` +
      `${when(patience, "a record that is not yours")} ${when(leadPatience, "your entry leading")} ` +
      "A problem you keep with Keep is never dropped this way." +
      (state.settings.auto ? "" : " Auto-advance works only while auto-eval is on."),
  );
}

/** One patience's number field and Never box, written from the setting (the field being typed in is left alone). */
function patienceFields(id: string, value: number | null): void {
  const input = $<HTMLInputElement>(id);
  const never = $<HTMLInputElement>(`${id}-never`);
  never.checked = value === null;
  input.disabled = value === null;
  if (value !== null && document.activeElement !== input && input.value !== String(value)) input.value = String(value);
}

let offersSig = "";
/** Your pick: the offers, best first, each with what it is expected to pay and a Take button. */
/** What an offer pays on top of improvements, in the offers' words. */
function offerBonus(x: Offer): string {
  if (state.bonusPaid[keyOf(x)] === state.standing.resets) return "its bonus is paid this cycle";
  return x.tier === "open" ? `bonus ${fmtInt(FIRST_BONUS)} RP` : `bonus ${fmtInt(LEAD_BONUS)} RP if you take the lead`;
}

/** A sentence for a payment that paid a bonus, else nothing. */
function bonusSentence(points: { bonus: "first" | "lead" | null; bonusRp: number }): string {
  if (!points.bonus) return "";
  return points.bonus === "first"
    ? ` That is the ${fmtInt(points.bonusRp)} RP bonus for the first record on this problem. The first record pays only the bonus.`
    : ` That includes the ${fmtInt(points.bonusRp)} RP bonus for taking the lead.`;
}

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
            : `${TIER_LABEL[x.tier]} ${show6(x.leader!.score)} by ${x.leader!.name}, gap ${fmtPct(gapTo(x, x.leader!.score))}` +
              (x.weakness !== null && x.weakness > 0 ? `, ${fmtPct(x.weakness)} weaker than its neighbours` : "");
      const meta = document.createElement("span");
      meta.className = "note";
      // what the dealer knows, not a promise: the ranking itself is an estimate
      meta.textContent =
        `${i === 0 ? "Best offer · " : ""}${x.retake ? "Retake · " : ""}${what} · ${offerBonus(x)}` +
        ` · about ${tableMsOf(x).toFixed(1)} ms an evaluation`;
      const btn = document.createElement("button");
      btn.className = "t-take";
      btn.textContent = "Take";
      btn.disabled = !due || dealing;
      btn.setAttribute("aria-label", `Take ${title}`);
      btn.addEventListener("click", () => void onTakeOffer(keyOf(x)));
      const skip = document.createElement("button");
      skip.className = "t-skip";
      skip.textContent = "Skip";
      skip.disabled = dealing;
      skip.setAttribute("aria-label", `Skip ${title}`);
      skip.addEventListener("click", () => onSkipOffer(keyOf(x)));
      const btns = document.createElement("div");
      btns.className = "t-offer-btns";
      btns.append(btn, skip);
      li.append(h, meta, btns);
      return li;
    }),
  );
}

let filtersShown = "";
/** Dealer filters: the form shows the saved filters (until the player edits it). */
function renderFilters(o: Owned): void {
  show("t-filters", inUse(o, "filters"));
  if (!inUse(o, "filters")) return;
  const f = state.picks.filters;
  const sig = JSON.stringify([f, state.picks.rivals]);
  if (sig === filtersShown) return;
  filtersShown = sig;
  $<HTMLInputElement>("t-f-tighter").checked = !!f?.tighter;
  $<HTMLInputElement>("t-f-rivals").checked = !!f?.rivals;
  const rivalList = $("t-rivals");
  rivalList.replaceChildren(
    ...(state.picks.rivals.length
      ? state.picks.rivals.map((r) => {
          const li = document.createElement("li");
          const label = document.createElement("span");
          label.textContent = `${r.name}, ${r.took} ${r.took === 1 ? "record" : "records"} taken`;
          const rm = document.createElement("button");
          rm.type = "button";
          rm.textContent = "Remove";
          rm.setAttribute("aria-label", `Remove ${r.name} from my rivals`);
          rm.addEventListener("click", () => {
            removeRival(state.picks.rivals, r.name);
            persist();
            render();
          });
          li.append(label, rm);
          return li;
        })
      : [Object.assign(document.createElement("li"), { textContent: "No rivals yet." })]),
  );
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
    text("t-filter-note", "Pieces: enter a range from 1 to 500, with the smaller number first.");
    return;
  }
  const tiers = TIERS.filter((t) => $<HTMLInputElement>(`t-f-tier-${t}`).checked);
  if (!tiers.length) {
    text("t-filter-note", "Keep at least one tier ticked.");
    return;
  }
  const tighter = $<HTMLInputElement>("t-f-tighter").checked;
  const rivals = $<HTMLInputElement>("t-f-rivals").checked;
  const filters: Filters = {
    pieces: pieces as number[] | null,
    containers: containers as number[] | null,
    minP,
    maxP,
    tiers: tiers.length === TIERS.length ? null : tiers,
    ...(tighter ? { tighter: true } : {}),
    ...(rivals ? { rivals: true } : {}),
  };
  const none =
    !filters.pieces && !filters.containers && minP === 1 && maxP === 500 && !filters.tiers && !tighter && !rivals;
  state.picks.filters = none ? null : filters;
  // offers drawn under the old filters make way for new ones
  state.picks.offers = state.picks.offers.filter((x) => passes(state.picks.filters, x));
  filtersShown = "";
  text(
    "t-filter-note",
    none
      ? "No filters. The dealer deals from everything you have reached."
      : `Filters saved. The dealer deals what they allow. ${noMatchText(state.picks.filters, owned())}`,
  );
  event(none ? "Dealer filters cleared." : "Dealer filters saved.", false);
  // new filters change what can be found, so a pause for finding nothing ends now (an unreachable server keeps its wait)
  if (!lastPauseOffline) dealPausedUntil = 0;
  persist();
  render();
  void dealTick();
}

/**
 * What to tell the player about saved filters: when no source can give a problem that passes them, why
 * not; else that a problem outside them is dealt when the queue is empty.
 */
function noMatchText(f: Filters | null, o: ReadonlySet<UpgradeId>): string {
  const reach = sourceReach(o);
  const can = filterSources(f, reach);
  const outside = "If the queue is empty and nothing fits, one problem outside the filters is dealt.";
  if (can.open || can.contested || can.space) return outside;
  const why = ["No problem you can be dealt now fits them."];
  if (f?.tiers && !f.tiers.includes("open")) why.push("Open problems are not among the tiers you ticked.");
  else why.push("Open problems have sides of 21 to 100 and 40 to 500 pieces.");
  if (!reach.contested.size || !Number.isFinite(reach.ringMin))
    why.push(
      `Problems with 20 sides or fewer are contested problems, which need the upgrade ${upgrade("reach2").name}.`,
    );
  else why.push("Your shapes, piece counts and tiers match no contested problem you can be dealt.");
  if (f?.rivals)
    why.push(
      `${state.picks.rivals.length ? "None of your rivals holds a record that fits." : "You have no rivals yet."}`,
    );
  why.push(outside);
  return why.join(" ");
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
  const left = dropProblem(key);
  event(left ? `Dropped ${problemTitle(p)}.` : `${problemTitle(p)} will be dropped once its best is sent.`, false);
  // an emptied queue is filled at once (outside the filters if nothing fits them), not after the pause of a search that found nothing
  if (!slotted(state).length && !lastPauseOffline) dealPausedUntil = 0;
  persist();
  showFocus();
  render();
  void submitTick();
  void dealTick();
}

/**
 * Auto-advance drops a problem exactly as Drop does, and says why; `next` is the problem dealt in
 * its place.
 */
function autoDrop(p: ProblemState, next?: ProblemKey): void {
  if (problem(state, p.key) !== p || p.leaving) return;
  const why = `after ${evals(p.sinceGain)} without progress`;
  const instead = next ? `, and ${problemTitle(next)} takes its slot` : "";
  const left = dropProblem(p.key);
  const message = left
    ? `Auto-advance dropped ${problemTitle(p)} ${why}${instead}.`
    : `Auto-advance is dropping ${problemTitle(p)} ${why}${instead}. It leaves once its best is sent.`;
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
      const note = methodGame(lv.run.method).runNote?.(runView(lv.run, q, lv.progress)) ?? "";
      msg =
        `Lane ${i + 1}: ${problemTitle(q)} · ${methodLabel(lv.run.method)} · ` +
        `run at ${runAt(lv.run, lv.progress?.evaluations ?? lv.run.evaluations)}${note}`;
      if (lv.jobs.length) msg += ` · ${lv.jobs.length} click${lv.jobs.length === 1 ? "" : "s"} waiting`;
    } else msg = `Lane ${i + 1}: no open run`;
    if (lanes.length > 1 && lv.autoRate > 0 && autoPerSecond(o) !== null && state.settings.auto)
      msg += ` · auto-eval gets ${autoRateText(lv.autoRate)}`;
    if (line.textContent !== msg) line.textContent = msg;
  });
  // "Lanes in use": 1 to the lanes owned
  const owns = laneCount(o);
  show("t-lanes-use-box", owns > 1);
  const use = $<HTMLInputElement>("t-lanes-use");
  use.max = String(owns);
  if (document.activeElement !== use) use.value = String(Math.min(owns, state.settings.lanesInUse ?? owns));
  // the lanes share auto-eval's rate by solving time
  const rate = autoPerSecond(o);
  show("t-lanes-note", rate !== null);
  if (rate !== null) {
    const sum = autoMeter.summary(now());
    const share = meterShare(sum);
    const ran = share !== null && share < AUTO_METER_NOTE;
    text(
      "t-lanes-note",
      (lanes.length > 1
        ? `The ${lanes.length} lanes share auto-eval's ${fmtRate(rate)}. Each lane that has work gets about the same solving time, so a lane on a large problem runs fewer evaluations a second.`
        : `Auto-eval runs ${fmtRate(rate)} in this lane.`) +
        (ran
          ? ` Auto-eval ran ${fmtCount(sum.ran / sum.seconds)} of its ${fmtCount(sum.due / sum.seconds)} evaluations a second in the last 30 s. Your computer is the limit.`
          : ""),
    );
  }
}

/** A rate of evaluations as a number for a sentence: whole above 10, else one decimal. */
const fmtCount = (r: number) => (r >= 10 ? Math.round(r).toLocaleString("en-US") : String(Math.round(r * 10) / 10));

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
      focusKind: p ? kindOf(p) : null,
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

let rulesSig = "";
const resetDialog = $<HTMLDialogElement>("t-reset");
const dimensionSentence = (d: keyof typeof DIMENSION_TEXT) =>
  `${DIMENSION_TEXT[d].label}, with ${DIMENSION_TEXT[d].what}`;
const plural = (n: number, one: string, many: string) => `${fmtInt(n)} ${n === 1 ? one : many}`;

function renderStanding(o: Owned): void {
  const st = state.standing;
  markProgress(state, now());
  // the Standing card is bought as the reset and bought again each cycle, so the panel stays once a reset has been made
  const visible = o.has("standing") || st.resets > 0;
  show("t-bar-standing-box", visible || st.total > 0);
  text("t-bar-standing", `${fmtInt(st.points)} · ×${fmtInt(standingMultiplier(st))}`);
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
  const opensText = pv.opens ? ` The reset opens ${dimensionSentence(pv.opens)}.` : "";
  text(
    "t-st-preview",
    pv.can
      ? `You can buy Standing in the tech tree now. It resets the game for ${plural(pv.gain, "standing point", "standing points")}, and all points then pay ×${fmtInt(standingMultiplier(st) * 2)}, up from ×${fmtInt(standingMultiplier(st))}.` +
          opensText
      : `Standing costs ${fmtInt(pv.price)} RP. You need that many RP to spend, and this cycle must have earned that many RP that the server has confirmed. ` +
          (pv.short > 0
            ? `${fmtInt(Math.ceil(pv.short))} more confirmed RP to go.`
            : `You have enough confirmed RP, and need ${fmtInt(Math.ceil(pv.price - state.rp))} more RP to spend.`) +
          opensText,
  );
  // what only standing buys
  const left = UPGRADES.filter((u) => u.currency === "standing" && costOf(o, u.id) !== null);
  text(
    "t-st-only",
    left.length
      ? `Standing buys ${andList(left.map((u) => `${u.name} (${fmtInt(costOf(o, u.id)!)})`))}. They are in the tech tree's Standing row. Resets keep them.`
      : "You own every standing upgrade.",
  );
  show("t-st-history-box", st.history.length > 0);
  setLines(
    "t-st-history",
    st.history
      .map(
        (h, i) =>
          `Cycle ${i + 1 + Math.max(0, st.resets - st.history.length)} lasted ${fmtSpan(h.endedAt - h.startedAt)} and earned ${fmtRP(h.earned)} RP and ${plural(h.gain, "standing point", "standing points")}${h.rule ? `, under ${ruleById(h.rule)?.name ?? h.rule}` : ""}.`,
      )
      .reverse(),
  );
}

/** The reset's confirm: what resets, what stays, and the rule for the next cycle (Cycle rules). */
function renderResetDialog(o: Owned): void {
  if (!resetDialog.open) return;
  const st = state.standing;
  const pv = resetPreview(state);
  if (!pv.can) {
    // the points it needed are gone (taken back, or spent): nothing to confirm
    resetDialog.close();
    return;
  }
  const rentBack = pv.keeps.includes("rent");
  const collectionsBack = pv.keeps.includes("collections");
  const parts = [
    `You get ${plural(pv.gain, "standing point", "standing points")} to spend, and all points will pay ×${fmtInt(standingMultiplier(st) * 2)}, up from ×${fmtInt(standingMultiplier(st))}.`,
    `You lose ${fmtRP(state.rp)} RP to spend and ${plural(pv.loses.length, "upgrade", "upgrades")}. The next cycle starts with ${plural(pv.keeps.length, "upgrade", "upgrades")}.`,
    `You keep ${pv.held === 0 ? "" : pv.held === 1 ? "the 1 record you hold, " : `the ${fmtInt(pv.held)} records you hold, `}your list of records, the dealer's learning, the queue, your standing and every count.` +
      (o.has("keepAuto") ? " You also keep the Auto-eval upgrades." : "") +
      (o.has("keepMethods") ? " You also keep your methods." : ""),
    rentBack
      ? `Records pay rent comes back, and your records start earning rent again from the moment of the reset. Rent that built up and was not paid is lost.`
      : `Records pay rent goes until you buy it again. Rent that built up and was not paid is lost, and no rent builds up while you do not own it.` +
        (o.has("collections") && !collectionsBack
          ? " Collections goes too, so its bonus is off until you buy it again. Your records still count for it."
          : ""),
  ];
  if (pv.opens) parts.push(`It opens ${dimensionSentence(pv.opens)}.`);
  text("t-st-confirm-text", parts.join(" "));
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
        ? `${chosen.name}. ${chosen.limit} Finishing that cycle under it gives 1 more standing point` +
          (st.rulesDone.includes(chosen.id)
            ? ". You have finished it before, so its reward already holds."
            : `, and from then on ${lowerFirst(chosen.reward)}`)
        : "No rule chosen. A rule limits the next cycle. Finish a cycle under it for 1 more standing point and a lasting reward.") +
        (st.rulesDone.length ? ` Finished so far: ${andList(st.rulesDone.map((id) => ruleById(id)!.name))}.` : ""),
    );
  }
}

/** Buying the Standing card is the reset: the confirm opens, and only Reset now buys it. */
function openResetDialog(): void {
  if (!ownsGame || !resetPreview(state).can) return;
  if (!resetDialog.open) resetDialog.showModal();
  renderResetDialog(owned());
  $("t-st-no").focus();
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
    rows.push(["Rent waiting for payday", `about ${fmtRP(rentWaiting(state, o, now()))} RP`]);
    const due = paydayDueAt(state.economy, now());
    rows.push(["Next payday", due <= now() ? "now" : `in ${fmtSpan(due - now())}`]);
    rows.push(["Rent paid", `${fmtRP(state.economy.rentPaid)} RP`]);
  }
  const c = collections(state.economy);
  if (col) rows.push(["Collections", `+${fmtPct(c.bonus, 0)} on all points`]);
  setStats("t-rc-stats", rows);
  const last = state.economy.lastRent;
  text(
    "t-rc-note",
    rent
      ? "Every day at noon, the game asks the server which of your records you still hold. Each one pays the rent it built up since the last payday, or since you won it if that was later." +
          (last
            ? ` The last rent paid was +${fmtRP(last.rp)} RP on ${titleOf(last.key)}, ${fmtAgo(now() - last.at)}.`
            : "")
      : "",
  );
  if (!col) {
    setLines("t-rc-sets", []);
    return;
  }
  const comboName = (n: { N: number; M: number }) => problemTitle(poly(n.N, n.M, 0)).replace(/, 0 pieces$/, "");
  const lines = [
    `${fmtInt(c.combos)} combination${c.combos === 1 ? "" : "s"} of pieces and container with ${COMBO_RECORDS} records (+${fmtPct(COMBO_BONUS, 0)} each).` +
      (c.nearest.length
        ? ` Closest: ${andList(c.nearest.map((n) => `${comboName(n)} (${n.have} of ${COMBO_RECORDS})`))}.`
        : ""),
    `${fmtInt(c.milestones)} shape milestone${c.milestones === 1 ? "" : "s"} at ${andList(SHAPE_MILESTONES.map(String))} records with one piece shape (+${fmtPct(SHAPE_BONUS, 0)} each).` +
      (c.shapes.length
        ? ` Your most recorded pieces: ${andList(c.shapes.slice(0, 3).map((x) => `${shapeName(x.N, true)} (${fmtInt(x.count)})`))}.`
        : ""),
    `First records in these tiers: ${c.tiers.length ? andList(c.tiers.map((t) => TIER_LABEL[t as Tier] ?? t)) : "none yet"} (+${fmtPct(TIER_BONUS, 0)} each).`,
  ];
  setLines("t-rc-sets", lines);
}

/** Resets the cycle for standing: lanes stop and start again with the next cycle's tree. */
async function doReset(): Promise<void> {
  resetDialog.close();
  if (!ownsGame || !resetPreview(state).can) return render();
  for (const l of lanes) {
    l.jobs = [];
    l.lane.terminate();
  }
  lanes.length = 0;
  // let the stopped jobs settle first (an auto-eval job that could not run is due again)
  await new Promise((r) => setTimeout(r, 0));
  const rule = ruleById(state.standing.rule);
  const opens = resetPreview(state).opens;
  const gain = resetCycle(state, now());
  // the dealer's lanes were stopped for the reset: a new cycle starts them again
  ensureLanes();
  lastChange.clear();
  banner = null;
  if (gain > 0) {
    const st = state.standing;
    const next = ruleById(st.rule);
    const opened = opens ? ` It opens ${dimensionSentence(opens)}.` : "";
    event(
      `Bought Standing and reset for ${plural(gain, "standing point", "standing points")}. All points now pay ×${fmtInt(standingMultiplier(st))}.` +
        (rule ? ` You finished a cycle under ${rule.name}. Its reward is yours for good.` : "") +
        opened,
    );
    say(
      `Cycle ${fmtInt(st.resets + 1)} begins with ${fmtInt(state.owned.length)} upgrades.` +
        (next ? ` It is played under ${next.name}. ${next.limit}` : "") +
        (state.owned.includes("rent")
          ? " Your records stay on the server and earn rent again."
          : " Your records stay on the server. They earn rent again once you own Records pay rent."),
    );
  }
  saveNow();
  showFocus(true);
  render();
  kickLanes();
  void dealTick();
}

// ---------- dialogs: Settings, and the name pop-up ----------

const settingsDialog = $<HTMLDialogElement>("t-settings");

function openSettings(): void {
  renderName();
  if (!settingsDialog.open) settingsDialog.showModal();
}

$("t-open-settings").addEventListener("click", () => openSettings());
$("t-settings-close").addEventListener("click", () => settingsDialog.close());
// a press on the backdrop closes Settings
settingsDialog.addEventListener("click", (e) => {
  if (e.target === settingsDialog) settingsDialog.close();
});
$("t-tut-replay").addEventListener("click", () => {
  settingsDialog.close();
  void runTutorial();
});
// the name is changed in the pop-up, which the tutorial also opens (name-popup.ts)
bindNamePopup({
  get: () => state.name,
  set: (name) => {
    state.name = name;
    say(`Your records are sent to PolyPack as “${name}”.`);
    event(`Sending records as “${name}”.`, false);
    persist();
    render();
    void submitTick();
  },
});
$("t-name-change").addEventListener("click", () => void showNamePopup());
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
        showFocus(true);
        render();
      },
      now,
      spaceStart: async (id) => {
        const k = parseKey(id);
        if (!k || isPolygon(k)) return `${id} is not a space problem id.`;
        const { loadSpaceProblem } = await import("../space/load");
        const p = await loadSpaceProblem(k.family, id);
        if (typeof p === "string") return p;
        return { bound: p.bound?.value ?? null, best: p.best ? { config: p.best.config, score: p.best.score } : null };
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
  $<HTMLInputElement>("t-f-tighter").checked = false;
  $<HTMLInputElement>("t-f-rivals").checked = false;
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
      ? `Auto-eval is on. It runs ${fmtRate(autoPerSecond(o) ?? 0)} besides your clicks${laneCount(o) > 1 ? `, shared by ${laneCount(o)} lanes` : ""}.`
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
/** The number field and the Never box of one patience (the saved setting `which`). */
function bindPatience(id: string, which: "patience" | "leadPatience"): void {
  const input = $<HTMLInputElement>(id);
  const never = $<HTMLInputElement>(`${id}-never`);
  const set = (v: number | null) => {
    state.settings[which] = v;
    persist();
    render();
    void dealTick();
  };
  input.addEventListener("change", () => {
    const v = parsePatience(input.value);
    if (typeof v === "number") return set(v);
    // not a whole number from the minimum to the maximum: the field shows the setting again
    input.value = String(state.settings[which] ?? DEFAULT_PATIENCE);
    say(`A patience is a whole number from ${fmtInt(PATIENCE_MIN)} to ${fmtInt(PATIENCE_MAX)}.`);
  });
  never.addEventListener("change", () => {
    if (never.checked) return set(null);
    const v = parsePatience(input.value);
    set(typeof v === "number" ? v : DEFAULT_PATIENCE);
  });
}
bindPatience("t-patience", "patience");
bindPatience("t-patience-lead", "leadPatience");
$("t-next").addEventListener("click", () => {
  const p = focused();
  if (!p || clicksToDeal() > 0) return;
  onDrop(p.key);
});
$("t-bg").addEventListener("change", () => {
  state.settings.background = $<HTMLInputElement>("t-bg").checked;
  persist();
  applyHold();
});
$("t-lanes-use").addEventListener("change", () => {
  const owns = laneCount(owned());
  const n = Math.floor(Number($<HTMLInputElement>("t-lanes-use").value));
  // all lanes is the default, kept as null
  state.settings.lanesInUse = !Number.isFinite(n) || n >= owns ? null : Math.max(1, n);
  persist();
  ensureLanes();
  kickLanes();
  render();
});
$("t-battery").addEventListener("change", () => {
  state.settings.battery = $<HTMLInputElement>("t-battery").checked;
  persist();
  applyHold();
});
$("t-st-no").addEventListener("click", () => resetDialog.close());
$("t-st-yes").addEventListener("click", () => void doReset());
$("t-st-rule").addEventListener("change", () => {
  const v = $<HTMLSelectElement>("t-st-rule").value;
  state.standing.nextRule = ruleById(v) ? v : null;
  persist();
  render();
});
/** A save string longer than this goes to a file: the clipboard and a text box cope badly with more. */
const EXPORT_TEXT_MAX = 4_000_000;
$("t-export").addEventListener("click", async () => {
  const area = $<HTMLTextAreaElement>("t-save-text");
  await archiveLoaded;
  const rows = archiveOf(state)?.values() ?? [];
  const str = await exportString(state, rows);
  if (str.length > EXPORT_TEXT_MAX) {
    // too big to paste: the save document as a file, which Import can read back
    const blob = new Blob([toExportJson(state, archiveOf(state)?.values() ?? [])], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `tighter-save-${new Date(now()).toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    area.value = "";
    text(
      "t-save-note",
      "The save is too big to copy, so it was saved as a file. Use Import from file to read it back.",
    );
    return;
  }
  area.value = str;
  area.select();
  try {
    await navigator.clipboard.writeText(area.value);
    text("t-save-note", "Save string copied to the clipboard.");
  } catch {
    text("t-save-note", "The browser blocked copying. Copy the save string above by hand.");
  }
});
async function doImport(source: string): Promise<void> {
  const r = await importString(source, now());
  if (!r.ok) {
    text("t-save-note", `The save could not be imported (${r.error}).`);
    return;
  }
  if (!confirm("Replace your current game with this save? You lose the current game unless you exported it.")) return;
  await archiveLoaded;
  for (const l of lanes) l.lane.terminate();
  lanes.length = 0;
  // the imported game's archived records replace the current ones, in this save's database
  state.archiveId ??= newArchiveId();
  const a = archiveOf(state) ?? new Archive(idbStore(state.archiveId));
  a.replaceAll(r.archive ?? []);
  r.state.archiveId = state.archiveId;
  state = r.state;
  attachArchive(state, a);
  syncEconomy(state);
  state.settings.auto = false;
  lastChange.clear();
  banner = null;
  savesDisabled = false;
  ensureLanes();
  saveNow();
  showFocus(true);
  const notes = [
    r.rescaled ? rescaleNote(r.rescaled) : "",
    r.refunded ? refundNote(r.refunded) : "",
    r.rebalanced ? REBALANCED_NOTE : "",
    r.units ? unitsNote(r.units) : "",
    r.ladder ? ladderNote(r.ladder.rp) : "",
    r.c3 ? c3Note(r.c3.rp) : "",
    r.standing ? standingNote(r.standing) : "",
  ].filter(Boolean);
  text("t-save-note", ["Save imported.", ...notes].join(" "));
  render();
}
$("t-import").addEventListener("click", () => void doImport($<HTMLTextAreaElement>("t-save-text").value));
$("t-import-file-btn").addEventListener("click", () => $<HTMLInputElement>("t-import-file").click());
$<HTMLInputElement>("t-import-file").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file) await doImport(await file.text());
});

// ---------- "How it works" ----------

// tighter.html places each explanation as an empty disclosure named by data-how; help.ts holds the
// text. Each becomes a "More detail" button named by the disclosure's summary.
const HOW_LEAD: Record<string, string> = {
  points: "Record points are what you earn when a board gets smaller.",
  counts: "Clicks, evaluations and runs are the three ways your work is counted.",
  standing: "You reset by buying Standing, and each reset gives you standing to spend and doubles your points.",
  records: "A record you still hold can keep paying you rent, and collections add a bonus.",
  auto: "Auto-eval works for you in the background, spread over your lanes.",
  running: "Auto-eval pauses in a few situations, and you can change some of them.",
  sending: "Your best boards are sent to PolyPack under your display name.",
};
for (const d of document.querySelectorAll<HTMLElement>("details[data-how]")) {
  const how = HELP[d.dataset.how ?? ""];
  if (!how) continue;
  const btn = moreDetail(how, d.querySelector("summary")?.textContent ?? "this panel", "t-how-btn");
  // a panel with nothing else in it still says what it is about, before the button
  const lead = HOW_LEAD[d.dataset.how ?? ""];
  if (lead) {
    const p = document.createElement("p");
    p.className = "note t-how-lead";
    p.textContent = lead;
    d.replaceWith(p, btn);
  } else d.replaceWith(btn);
}

// ---------- the Mechanics page ----------

const mechanicsDialog = $<HTMLDialogElement>("t-mechanics");
$("t-open-mechanics").addEventListener("click", () => {
  // built when first opened, from the same data as the cards, so it never drifts
  if (!mechanicsDialog.dataset.built) {
    renderMechanics($("t-mechanics-body"));
    mechanicsDialog.dataset.built = "1";
  }
  if (!mechanicsDialog.open) mechanicsDialog.showModal();
});
$("t-mechanics-close").addEventListener("click", () => mechanicsDialog.close());
mechanicsDialog.addEventListener("click", (e) => {
  if (e.target === mechanicsDialog) mechanicsDialog.close();
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
  /** Milliseconds left of the dealer's pause after a search that found nothing (for the tests). */
  get dealPause() {
    return Math.max(0, dealPausedUntil - now());
  },
  /** Lanes with work queued or going (for the tests: wait until every click has run). */
  get busy() {
    return lanes.some((l) => l.pumping || l.jobs.length);
  },
  /** The runs open in the lanes: their problem, method and seed (for the tests). */
  get runs() {
    return lanes.flatMap((l) => (l.run ? [{ key: l.run.key, method: l.run.method, seed: l.run.seed }] : []));
  },
};

if (startNote) say(startNote);
if (startHeadGiven > 0) event(headStartNote(startHeadGiven), false);
showFocus(true);
render();

let ticker = 0;
/** This tab holds the game: it may run, send and save. */
function start(): void {
  ownsGame = true;
  // a new game opens with the tutorial (?tutorial=off skips it), and the game starts when it is over
  if (!state.tutorialDone && new URLSearchParams(location.search).get("tutorial") !== "off") {
    void runTutorial().then(() => {
      if (!ownsGame) return;
      state.tutorialDone = true;
      saveNow();
      begin();
    });
  } else begin();
}

function begin(): void {
  $("t-elsewhere").hidden = true;
  document.body.classList.remove("standby");
  state.autoAt = now();
  applyHold();
  listen();
  void dealTick();
  void refreshHeld();
  void archiveLoaded.then(() => findLostRecords());
  ticker = window.setInterval(() => {
    listen();
    void dealTick();
    void submitTick();
    void settleLost();
    void paydayTick();
    void followSpace();
    autoTick();
    render();
  }, 1000);
}

/** Another tab holds the game: nothing runs here and the save is not written. */
function standBy(takenOver: boolean): void {
  if (ownsGame) {
    ownsGame = false;
    clearInterval(ticker);
    feed.close();
    clearTimeout(saveTimer);
    state.settings.auto = false;
    for (const l of lanes) l.lane.terminate();
  }
  text(
    "t-elsewhere-text",
    takenOver
      ? "Tighter was opened in another tab. That tab now runs the game, and this one does nothing."
      : "Tighter is open in another tab. Only one tab runs the game, so this one does nothing.",
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
