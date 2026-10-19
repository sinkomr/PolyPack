import { MAX_PIECES, areaLowerBound, evaluate } from "@polypack/geometry";
import type { Container, LeaderboardEvent, PackingConfig } from "@polypack/geometry";
import * as api from "../api";
import { Board } from "../board";
import { BoardView } from "../view";
import {
  DealerState,
  canDeal,
  drawLoosePair,
  drawProblem,
  drawTier,
  looseCandidates,
  looseDealable,
  nextDealAt,
  nextRandom,
  openDealable,
  takeToken,
} from "./dealer";
import { FRONTIER, STARTER, keyOf, problemTitle } from "./frontier";
import {
  GameState,
  Leader,
  ProblemState,
  RunChange,
  RunOutcome,
  addToQueue,
  applyAnswer,
  applyLeader,
  applyLoadAll,
  applyRun,
  buy,
  density,
  drop,
  evolvable,
  hasUnsent,
  leave,
  log,
  newGame,
  newProblem,
  ownedSet,
  pendingPoints,
  problem,
  recordsHeld,
  reveal,
  revealed,
  seenKeys,
  slotted,
  submitTarget,
} from "./game";
import { Lane, LaneEnd, LaneProgress, LaneRequest } from "./lanes";
import {
  OFFLINE_BACKOFF_MS,
  RATE_LIMITED_BACKOFF_MS,
  canSend,
  compact as compactPacer,
  nextAllowedAt,
  pause,
  recordSend,
} from "./pacer";
import { FLOOR, gapOf, show6 } from "./points";
import { autoHold, autoTarget } from "./scheduler";
import { STORAGE_KEY, exportString, fromJson, importString, toJson } from "./save";
import { classifyAnswer, shouldSubmit, submissionBody } from "./submission";
import {
  COMPACT_EVALS,
  EvolveMethod,
  UpgradeId,
  autoWaitSeconds,
  available,
  canBuy,
  evolveEvals,
  laneCount,
  methods,
  queueSize,
  upgrade,
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
const fmtClock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const fmtCompute = (ms: number) =>
  ms < 60_000
    ? `${(ms / 1000).toFixed(0)} s`
    : ms < 3_600_000
      ? `${(ms / 60_000).toFixed(1)} min`
      : `${(ms / 3_600_000).toFixed(1)} h`;
/** A relative change as the trace and status show it: "−0.0607 %". */
const fmtChange = (before: number, after: number) =>
  `${after < before ? "−" : "+"}${(Math.abs(1 - after / before) * 100).toFixed(4)} %`;
const METHOD_TEXT: Record<EvolveMethod, string> = { mc_compress: "mc_compress", basin_hopping: "basin_hopping" };

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
// Compute starts only on a press: auto-eval is off after every load.
state.settings.auto = false;

let saveTimer = 0;
function saveNow(): void {
  clearTimeout(saveTimer);
  if (savesDisabled) return;
  try {
    state.pacer = compactPacer(state.pacer, now());
    localStorage.setItem(STORAGE_KEY, toJson(state));
  } catch {
    // storage full or unavailable: the game goes on in memory
  }
}
function persist(): void {
  if (savesDisabled) return;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveNow, 400);
}
window.addEventListener("pagehide", saveNow);

const owned = () => ownedSet(state);
const focused = () => problem(state, state.focus);

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
  view.fit();
}

// ---------- lanes ----------

interface LaneView {
  lane: Lane;
  key: string | null;
  action: "compact" | "evolve" | null;
  method: string;
  evals: number;
  seed: number;
  progress: LaneProgress | null;
  /** When auto-eval may start this lane's next run. */
  nextAutoAt: number;
}
const lanes: LaneView[] = [];
function ensureLanes(): void {
  while (lanes.length < laneCount(owned()))
    lanes.push({
      lane: new Lane(lanes.length),
      key: null,
      action: null,
      method: "",
      evals: 0,
      seed: 0,
      progress: null,
      nextAutoAt: 0,
    });
}
ensureLanes();
const laneOn = (key: string) => lanes.find((l) => l.key === key);
const busyKeys = () => new Set(lanes.flatMap((l) => (l.key ? [l.key] : [])));
/** The last run's change per problem, for the score panel (not saved). */
const lastChange = new Map<string, RunChange & { seed: number; method: string; evals: number; seconds: number }>();
/** Problems whose first-record banner is up. */
let banner: { key: string; text: string } | null = null;

function toOutcome(end: LaneEnd, req: LaneRequest): RunOutcome | null {
  if (end.kind === "result") {
    const r = end.result;
    return {
      best: r.best,
      score: r.score,
      valid: r.valid,
      strict: r.strict,
      evaluations: r.evaluations,
      wallTime: r.wallTime,
      run: { method: r.method, params: r.params, seed: r.seed, budget: { evals: req.budget.evals } },
    };
  }
  if (end.kind === "stopped") {
    // the worker's preview is its strict best (solve-runtime checks it with the strict tolerance)
    if (!end.preview || !end.container) return null;
    return {
      best: end.preview,
      score: end.container.size,
      valid: true,
      strict: true,
      evaluations: end.evaluations,
      wallTime: end.elapsed,
      run: { method: req.method, params: req.params, seed: req.seed, budget: { evals: req.budget.evals } },
    };
  }
  return null;
}

const loading = new Set<string>();

/** Load all: the board's Add all from the centre. Its score is the free floor and is never sent. */
async function loadAll(p: ProblemState): Promise<boolean> {
  if (p.phase !== "bare") return true;
  if (loading.has(p.key)) return false;
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
    if (problem(state, p.key) !== p || p.phase !== "bare") return p.phase !== "bare";
    applyLoadAll(p, config, e.score, trim);
    reveal(state, "score");
    if (p.key === state.focus) {
      const b0 = areaLowerBound(p.N, p.M, p.P);
      say(
        `Load all: ${p.P} pieces on rings around the centre. Side ${show6(e.score)}, ${fmtPct(e.score / b0 - 1)} above the area bound. ` +
          (p.floor! < e.score
            ? `The record for ${p.P + 1} pieces, less one, is smaller (${show6(p.floor!)}): that is the free floor.`
            : "This is the free floor: Load all is never sent. Press Compact."),
      );
    }
    persist();
    return true;
  } finally {
    loading.delete(p.key);
    render();
  }
}

async function startRun(lv: LaneView, p: ProblemState, action: "compact" | "evolve", manual: boolean): Promise<void> {
  if (lv.key || lv.lane.busy || laneOn(p.key) || p.leaving || p.closed) return;
  lv.key = p.key;
  lv.action = action;
  try {
    if (p.phase === "bare" && !(await loadAll(p))) {
      lv.key = null;
      lv.action = null;
      return;
    }
  } catch {
    lv.key = null;
    lv.action = null;
    return;
  }
  if (problem(state, p.key) !== p || !p.board) {
    lv.key = null;
    lv.action = null;
    render();
    return;
  }
  const o = owned();
  const method: EvolveMethod =
    action === "compact"
      ? "mc_compress"
      : methods(o).includes(state.settings.method)
        ? state.settings.method
        : "mc_compress";
  const evals = action === "compact" ? COMPACT_EVALS : evolveEvals(o, method);
  // Compact's first run is seed 1, as measured; every other run takes the problem's next seed
  const seed = action === "compact" && p.runs === 0 ? 1 : p.nextSeed++;
  const req: LaneRequest = {
    problem: { N: p.N, M: p.M, P: p.P },
    method,
    params: {},
    budget: { evals },
    seed,
    start: structuredClone(p.board),
  };
  Object.assign(lv, { method, evals, seed, progress: null });
  if (p.key === state.focus && banner?.key === p.key) banner = null;
  render();
  const end = await lv.lane.run(req, (progress) => {
    lv.progress = progress;
    // the focused problem's board shows the run's best strict packing as it improves
    if (
      p.key === state.focus &&
      progress.preview &&
      progress.previewContainer &&
      progress.previewContainer.size < (p.best ?? Infinity)
    ) {
      view.setPreview(progress.preview, progress.previewContainer);
      if (view.ghost) view.ghost = ghost(p, progress.previewContainer);
    }
    scheduleRender();
  });
  lv.key = null;
  lv.action = null;
  lv.progress = null;
  lv.nextAutoAt = now() + (autoWaitSeconds(owned()) ?? 0) * 1000;
  if (p.key === state.focus) view.setPreview(null);
  const outcome = toOutcome(end, req);
  if (problem(state, p.key) !== p) {
    // the problem left the queue meanwhile; the work still counts as done
    if (outcome && lanes.includes(lv)) {
      state.stats.evaluations += outcome.evaluations;
      state.stats.runs++;
      state.stats.computeMs += Math.round(outcome.wallTime * 1000);
    }
    render();
    return;
  }
  if (!outcome) {
    const why = end.kind === "error" ? end.message : "it was stopped before it found a valid packing";
    say(`The run on ${problemTitle(p)} ended without a result: ${why}.`);
    showFocus(true);
    render();
    return;
  }
  const change = applyRun(state, p, outcome, now());
  lastChange.set(p.key, { ...change, seed, method, evals, seconds: outcome.wallTime });
  if (end.kind === "stopped") log(state, now(), `A run on ${problemTitle(p)} was stopped; its best so far was kept.`);
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
  if (p.key === state.focus || manual) say(runMessage(p, change, outcome, action));
  persist();
  showFocus();
  render();
  void submitTick();
}

function runMessage(p: ProblemState, c: RunChange, o: RunOutcome, action: "compact" | "evolve"): string {
  const o2 = owned();
  const what =
    `${action === "compact" ? "Compact" : `Run ${p.runs}`} · ` +
    `${o.run.method} · ${fmtInt(o.run.budget.evals ?? 0)} evaluations${o2.has("seeds") ? ` · seed ${o.run.seed}` : ""} · ${o.wallTime.toFixed(1)} s: `;
  if (!c.improved || c.before === null || c.after === null) return `${what}no improvement on ${show6(p.best ?? 0)}.`;
  const decades = Math.log10((1 - c.after / c.before) / FLOOR);
  const tail = c.counted
    ? `${decades.toFixed(1)} decades above the floor`
    : `below the 10⁻⁹ floor, so it is not an event`;
  let text = `${what}${show6(c.before)} → ${show6(c.after)} (${fmtChange(c.before, c.after)}, ${tail}).`;
  if (c.firstRecord && !state.consent) text += " Put your name on it to send it.";
  return text;
}

function idleLane(): LaneView | undefined {
  return lanes.find((l) => !l.key && !l.lane.busy);
}

function stopAll(): void {
  state.settings.auto = false;
  for (const l of lanes) l.lane.stop();
  say("Stopped. Every run keeps its best result, and auto-eval is off.");
  persist();
  render();
}

// ---------- hold: hidden tabs and battery ----------

let onBattery = false;
function holdReason(): "hidden" | "battery" | null {
  return autoHold({
    hidden: document.hidden,
    onBattery,
    background: state.settings.background,
    battery: state.settings.battery,
  });
}
/** Runs pause while the tab is hidden, unless the player allowed it. */
function applyHold(): void {
  const hiddenHold = document.hidden && !state.settings.background;
  for (const l of lanes) l.lane.setPaused(hiddenHold);
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
        render();
      };
      b.addEventListener("chargingchange", update);
      update();
    })
    .catch(() => {});
}

// ---------- auto-eval ----------

function autoTick(): void {
  const o = owned();
  if (!o.has("auto1") || !state.settings.auto || holdReason()) return;
  ensureLanes();
  const t = now();
  lanes.forEach((lv, i) => {
    if (lv.key || lv.lane.busy || t < lv.nextAutoAt) return;
    const target = autoTarget({ lane: i, queue: state.queue, focus: state.focus, busy: busyKeys(), owned: o });
    const p = target && problem(state, target.key);
    if (p) void startRun(lv, p, target.action, false);
  });
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
  if (!state.consent || !state.name.trim()) return;
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

async function submit(p: ProblemState): Promise<void> {
  const board0 = structuredClone(p.board!);
  const best = p.best!;
  const run = structuredClone(p.run!);
  const name = state.name.trim();
  // the leader just before: the server's exact check decides, and points are paid against it
  const info = await api.getProblem(p.N, p.M, p.P);
  if (problem(state, p.key) !== p) return;
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
  if (applyLeader(p, leaderBefore).lost)
    log(
      state,
      now(),
      `Your record on ${problemTitle(p)} was beaten: ${show6(leaderBefore!.score)} by ${leaderBefore!.name}.`,
    );
  if (!shouldSubmit(best, submitTarget(p, leaderBefore?.score ?? null))) return;
  state.pacer = recordSend(state.pacer, p.key, now());
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
  const { points } = applyAnswer(state, p, leaderBefore, best, outcome, now());
  const title = problemTitle(p);
  switch (outcome.kind) {
    case "leader":
      reveal(state, "points", "upgrades");
      log(
        state,
        now(),
        `Verified: ${show6(outcome.score)} is the record for ${title}${points ? ` (+${fmtRP(points.total)} RP)` : ""}.`,
      );
      if (outcome.pending) log(state, now(), "It beats a published value and waits for an administrator's review.");
      break;
    case "behind":
      log(state, now(), `Another entry got there first on ${title}: the record is ${show6(outcome.leaderScore ?? 0)}.`);
      break;
    case "closed":
      log(state, now(), `${title} is closed: ${outcome.reasons.join("; ")}. It leaves the queue.`);
      leave(state, p.key, now());
      break;
    case "rate-limited":
      state.pacer = pause(state.pacer, now(), RATE_LIMITED_BACKOFF_MS);
      log(state, now(), "The server asks to wait a minute; sending pauses.");
      break;
    case "refused":
      log(state, now(), `The server refused the entry on ${title} (${outcome.status}): ${outcome.reasons.join("; ")}.`);
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

async function dealTick(): Promise<void> {
  if (dealing || now() < dealPausedUntil) return;
  const slots = queueSize(owned());
  if (slotted(state).length >= slots || !canDeal(state.dealer, slots, now())) return;
  dealing = true;
  try {
    const p = await deal(state.dealer);
    if (p) {
      takeToken(state.dealer);
      addToQueue(state, p);
      log(
        state,
        now(),
        `Dealt: ${problemTitle(p)}${p.tier === "loose" ? `, a loose record by ${p.leader?.name}` : ""}.`,
      );
      persist();
      showFocus();
    }
  } finally {
    dealing = false;
    render();
  }
}

async function deal(d: DealerState): Promise<ProblemState | null> {
  const exclude = new Set([...seenKeys(state), ...skipped]);
  if (drawTier(d, owned()) === "loose") {
    const loose = await dealLoose(d, exclude);
    if (loose) return loose;
  }
  // the first problem comes from the starter corner while any of it is left open
  for (const list of d.dealt === 0 ? [STARTER, FRONTIER] : [FRONTIER]) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const k = drawProblem(d, list, exclude);
      if (!k) break;
      const info = await api.getProblem(k.N, k.M, k.P);
      if (!info) {
        dealPausedUntil = now() + OFFLINE_BACKOFF_MS;
        $("t-title").textContent = "The server cannot be reached; the game needs it to deal a problem. Retrying…";
        return null;
      }
      if (openDealable(info)) return newProblem(k, "open", now());
      skipped.add(keyOf(k));
      exclude.add(keyOf(k));
    }
  }
  // everything drawn was taken: ask again in a while rather than every second
  dealPausedUntil = now() + OFFLINE_BACKOFF_MS;
  return null;
}

/** A loose record: a site leader of N, M <= 20 with a gap above 12 %, started from its own packing. */
async function dealLoose(d: DealerState, exclude: Set<string>): Promise<ProblemState | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { N, M } = drawLoosePair(d);
    const records = await api.getRecords(N, M);
    if (!records) return null;
    const candidates = looseCandidates(records, exclude);
    if (!candidates.length) continue;
    const c = candidates[Math.floor(nextRandom(d) * candidates.length)];
    const info = await api.getProblem(N, M, c.P);
    if (!looseDealable(info, c)) continue;
    // 404 when the entry is no longer kept (only the leader of a problem is)
    const entry = await api.getSubmission(c.id);
    if (!entry || entry.N !== N || entry.M !== M || entry.P !== c.P) continue;
    const config: PackingConfig = { N, M, P: c.P, pieces: entry.pieces, container_phi: entry.container_phi };
    if (new Board().load(config, false)) continue;
    const p = newProblem({ N, M, P: c.P }, "loose", now());
    p.phase = "ready";
    p.board = config;
    p.best = c.score;
    p.floor = c.score;
    p.leader = { score: c.score, name: c.name, id: c.id };
    return p;
  }
  return null;
}

// ---------- records held: live leader changes ----------

function onLeaderEvent(e: LeaderboardEvent): void {
  const key = keyOf(e);
  // our own entry, announced before its answer arrives; a rival's is seen in that answer instead
  if (inFlight.has(key)) return;
  const q = problem(state, key);
  const past = q ? undefined : state.past.find((p) => p.key === key);
  const target = q ?? past;
  if (!target) return;
  if (applyLeader(target, { score: e.score, name: e.name, id: e.id }).lost) {
    log(state, now(), `Your record on ${problemTitle(target)} was beaten: ${show6(e.score)} by ${e.name}.`);
    persist();
    render();
  }
}
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

/** Checks the records held when the page opens, one GET at a time. */
async function refreshHeld(): Promise<void> {
  const held = [...state.queue, ...state.past].filter((p) => p.ourId !== null).slice(-30);
  for (const p of held) {
    const info = await api.getProblem(p.N, p.M, p.P);
    if (!info) return;
    const leader = info.site_best
      ? { score: info.site_best.score, name: info.site_best.name, id: info.site_best.id }
      : null;
    if (applyLeader(p, leader).lost)
      log(
        state,
        now(),
        `Your record on ${problemTitle(p)} was beaten${leader ? `: ${show6(leader.score)} by ${leader.name}` : ""}.`,
      );
    await new Promise((r) => setTimeout(r, 1000));
  }
  persist();
  render();
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
  const t = now();
  const p = focused();
  ensureLanes();
  showFocus();

  // reveals: a panel once shown stays
  if (s.queue.some((q) => q.phase !== "bare") || s.past.length) reveal(s, "score");
  if (s.consent || s.stats.firstRecords || s.queue.some((q) => q.phase === "ready" && q.tier === "open"))
    reveal(s, "consent", "log");
  if (s.rpEarned > 0) reveal(s, "points", "upgrades");
  if (o.has("queue3")) reveal(s, "queue");
  if (o.has("auto1") || o.has("lanes2")) reveal(s, "lanes");

  // totals
  show("t-bar", revealed(s, "points"));
  text("t-bar-rp", fmtRP(s.rp));
  text("t-bar-earned", fmtRP(s.rpEarned));
  text("t-bar-held", fmtInt(recordsHeld(s)));
  text("t-bar-evals", fmtInt(s.stats.evaluations));
  text("t-bar-cpu", fmtCompute(s.stats.computeMs));
  show("t-bar-auto-box", o.has("auto1"));
  text("t-bar-auto", s.settings.auto ? `1 run / ${autoWaitSeconds(o)} s wait` : "off");
  show("t-bar-lanes-box", o.has("lanes2"));
  text("t-bar-lanes", `${laneCount(o)}`);

  // hold note
  const hold = holdReason();
  text(
    "t-hold",
    hold === "hidden"
      ? "Paused while the tab is hidden"
      : hold === "battery" && s.settings.auto
        ? "Auto-eval waits: on battery power (allow it in Settings)"
        : "",
  );

  renderProblem(p, t);
  renderToolbar(p, o);
  renderScore(p, o);
  renderConsent();
  renderPoints(t);
  renderUpgrades(o);
  renderQueue(o, t);
  renderLanes(o, t);
  renderLog();
  $<HTMLInputElement>("t-bg").checked = s.settings.background;
  $<HTMLInputElement>("t-battery").checked = s.settings.battery;
}

function renderProblem(p: ProblemState | undefined, t: number): void {
  const s = state;
  text("t-held", fmtInt(recordsHeld(s)));
  if (!p) {
    if (!dealing && t >= dealPausedUntil) text("t-title", "Dealing a problem…");
    text("t-problem-note", "");
    show("t-next", false);
    return;
  }
  text("t-title", problemTitle(p));
  let note: string;
  if (p.closed) note = "Closed: the server takes no more entries for this problem.";
  else if (p.leaving) note = "Sending your best before it leaves the queue…";
  else if (p.ourId !== null) note = `You hold this record: ${show6(p.verified!)}.`;
  else if (p.leader && p.tier === "loose" && !p.run)
    note = `Loose record: ${show6(p.leader.score)} by ${p.leader.name}, ${fmtPct(gapOf(p.N, p.M, p.P, p.leader.score))} above the area bound. Contest weight 3.`;
  else if (p.leader) note = `Record: ${show6(p.leader.score)} by ${p.leader.name}.`;
  else if (p.phase === "ready") note = "Your record has not been sent yet.";
  else note = "No record exists. Any valid packing is a new record.";
  text("t-problem-note", note);
  // before the queue, one problem at a time: the next one is dealt when the deal timer allows
  const single = !owned().has("queue3");
  show("t-next", single && evolvable(p));
  if (single && evolvable(p)) {
    const ready = canDeal(state.dealer, 1, t);
    $<HTMLButtonElement>("t-next").disabled = !ready || dealing;
    text("t-next", ready ? "Next problem" : `Next problem in ${fmtClock(nextDealAt(state.dealer, 1, t) - t)}`);
  }
}

function renderToolbar(p: ProblemState | undefined, o: ReadonlySet<UpgradeId>): void {
  const busy = p ? laneOn(p.key) : undefined;
  const lane = idleLane();
  const canEvolve = !!p && evolvable(p);
  show("t-loadall", !canEvolve);
  $<HTMLButtonElement>("t-loadall").disabled = !p || p.phase !== "bare" || !!busy || loading.has(p.key);
  show("t-compact", !canEvolve);
  $<HTMLButtonElement>("t-compact").disabled = !p || p.phase !== "loaded" || !!busy || !lane;
  show("t-evolve", canEvolve);
  $<HTMLButtonElement>("t-evolve").disabled = !canEvolve || !!busy || !lane || !!p?.leaving || !!p?.closed;
  const ms = methods(o);
  show("t-method-box", ms.length > 1);
  const select = $<HTMLSelectElement>("t-method");
  if (select.options.length !== ms.length) {
    select.replaceChildren(
      ...ms.map((m) => {
        const opt = document.createElement("option");
        opt.value = m;
        opt.textContent = `${METHOD_TEXT[m]} · ${evolveEvals(o, m)} evaluations`;
        return opt;
      }),
    );
  }
  for (const opt of Array.from(select.options)) {
    const label = `${METHOD_TEXT[opt.value as EvolveMethod]} · ${evolveEvals(o, opt.value as EvolveMethod)} evaluations`;
    if (opt.textContent !== label) opt.textContent = label;
  }
  if (select.value !== state.settings.method && ms.includes(state.settings.method))
    select.value = state.settings.method;
  if (state.settings.method === "basin_hopping" && !ms.includes("basin_hopping")) state.settings.method = "mc_compress";
  show("t-auto", o.has("auto1"));
  const autoBtn = $<HTMLButtonElement>("t-auto");
  autoBtn.setAttribute("aria-pressed", String(state.settings.auto));
  text("t-auto", state.settings.auto ? "Auto-eval: on" : "Auto-eval: off");
  $<HTMLButtonElement>("t-stop").disabled = !lanes.some((l) => l.key) && !state.settings.auto;
  let info = "";
  if (busy) {
    const done = busy.progress?.evaluations ?? 0;
    info =
      `${busy.action === "compact" ? "Compact · " : ""}${busy.method} · ${fmtInt(busy.evals)} evaluations` +
      `${o.has("seeds") ? ` · seed ${busy.seed}` : ""} · ${fmtInt(done)} done · ${(busy.progress?.elapsed ?? 0).toFixed(1)} s` +
      (busy.lane.paused ? " · paused" : "");
  } else if (p) {
    const c = lastChange.get(p.key);
    info = c
      ? `${c.method} · ${fmtInt(c.evals)} evaluations${o.has("seeds") ? ` · seed ${c.seed}` : ""} · ${c.seconds.toFixed(1)} s`
      : p.phase === "bare"
        ? "0 pieces placed"
        : `${p.P} pieces placed`;
    if (o.has("seeds") && p.runs) info += ` · ${fmtInt(p.runs)} seeds tried on this problem`;
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
      chip.textContent = fmtChange(c.before, c.after);
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
  // the trace: the side after each run on this problem
  const svg = $("t-trace") as unknown as SVGSVGElement;
  const tr = p.trace;
  const visible = o.has("trace") && tr.length >= 2;
  svg.toggleAttribute("hidden", !visible);
  if (!visible) return;
  const sig = `${p.key}|${tr.length}|${tr[tr.length - 1]}`;
  if (svg.dataset.sig === sig) return;
  svg.dataset.sig = sig;
  const high = Math.max(...tr),
    low = Math.min(...tr);
  const range = high - low || high * 1e-6;
  const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  line.setAttribute(
    "points",
    tr
      .map((v, i) => `${(10 + (280 * i) / (tr.length - 1)).toFixed(1)},${(10 + (65 * (high - v)) / range).toFixed(2)}`)
      .join(" "),
  );
  const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
  label.setAttribute("x", "10");
  label.setAttribute("y", "92");
  label.textContent = `${show6(tr[0])} → ${show6(tr[tr.length - 1])} · ${tr.length - 1} runs`;
  svg.replaceChildren(line, label);
  svg.setAttribute(
    "aria-label",
    `Side after each run, from ${show6(tr[0])} to ${show6(tr[tr.length - 1])} over ${tr.length - 1} runs`,
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
        ? "Sending is off. Your records stay here until you send them."
        : "Nothing has been sent yet; your record is kept here until you send it.",
  );
}

function renderPoints(t: number): void {
  show("t-points", revealed(state, "points"));
  text("t-rp", fmtRP(state.rp));
  text("t-earned", fmtRP(state.rpEarned));
  text("t-evals", fmtInt(state.stats.evaluations));
  let pending = 0;
  let nextAt = Infinity;
  for (const q of state.queue) {
    const pts = pendingPoints(q, state.name);
    if (!pts || !hasUnsent(q)) continue;
    pending += pts.total;
    nextAt = Math.min(
      nextAt,
      nextAllowedAt(state.pacer, q.key, t, { first: q.verified === null && q.leader === null, leaving: q.leaving }),
    );
  }
  text(
    "t-pending",
    pending > 0
      ? `${fmtRP(pending)} ${state.consent ? (nextAt > t ? `(next send ${fmtClock(nextAt - t)})` : "(sending)") : "(needs your name)"}`
      : "—",
  );
}

let cardsSig = "";
function renderUpgrades(o: ReadonlySet<UpgradeId>): void {
  show("t-upgrades", revealed(state, "upgrades"));
  const list = available(o);
  const box = $("t-cards");
  const sig = list.map((u) => u.id).join(",");
  if (sig !== cardsSig) {
    cardsSig = sig;
    if (!list.length) {
      const p = document.createElement("p");
      p.className = "note";
      p.textContent = "Every upgrade of this version is yours. The rest of the tree comes later.";
      box.replaceChildren(p);
      return;
    }
    box.replaceChildren(
      ...list.map((u) => {
        const card = document.createElement("div");
        card.className = "t-card";
        card.dataset.id = u.id;
        const h = document.createElement("h3");
        h.textContent = `${u.name} · ${fmtInt(u.cost)} RP`;
        const p = document.createElement("p");
        p.textContent = `${u.effect}. Real: ${u.real}.`;
        const row = document.createElement("div");
        row.className = "t-card-row";
        const bar = document.createElement("progress");
        bar.max = u.cost;
        bar.setAttribute("aria-label", `${u.name}: points toward its cost`);
        const btn = document.createElement("button");
        btn.textContent = "Buy";
        btn.setAttribute("aria-label", `Buy ${u.name} for ${u.cost} record points`);
        btn.addEventListener("click", () => onBuy(u.id));
        row.append(bar, btn);
        card.append(h, p, row);
        return card;
      }),
    );
  }
  for (const card of Array.from(box.children) as HTMLElement[]) {
    const id = card.dataset.id as UpgradeId | undefined;
    if (!id) continue;
    card.querySelector("progress")!.value = Math.min(state.rp, upgrade(id).cost);
    card.querySelector("button")!.disabled = !canBuy(o, state.rp, id).ok;
  }
}

function onBuy(id: UpgradeId): void {
  if (!buy(state, id)) return;
  const u = upgrade(id);
  log(state, now(), `Bought ${u.name}: ${u.effect}.`);
  say(`${u.name}: ${u.effect}.`);
  ensureLanes();
  persist();
  render();
  void dealTick();
}

let queueSig = "";
function renderQueue(o: ReadonlySet<UpgradeId>, t: number): void {
  show("t-queue", revealed(state, "queue"));
  if (!revealed(state, "queue")) return;
  const slots = queueSize(o);
  text("t-queue-heading", `Queue · ${slots} slots`);
  const list = $("t-queue-list");
  const busy = busyKeys();
  const sig = state.queue
    .map(
      (p) =>
        `${p.key}|${p.phase}|${p.best}|${p.ourId}|${p.leader?.score}|${p.leaving}|${busy.has(p.key)}|${p.key === state.focus}`,
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
            : p.tier === "loose"
              ? ` · loose record by ${p.leader?.name ?? "?"}`
              : p.phase === "bare"
                ? " · no record yet"
                : "";
        li.append(`${problemTitle(p)}${gap}${status}${busy.has(p.key) ? " · running" : ""}`);
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
  text(
    "t-deal",
    free > 0
      ? canDeal(state.dealer, slots, t)
        ? "Dealing a problem…"
        : `Next problem dealt in ${fmtClock(nextDealAt(state.dealer, slots, t) - t)}.`
      : `Every slot is full. Drop a problem to be dealt another (one per slot every 5 minutes).`,
  );
}

function onDrop(key: string): void {
  const p = problem(state, key);
  if (!p) return;
  const unsent = p.phase === "ready" && !!p.run && hasUnsent(p) && !state.consent;
  if (unsent && !confirm(`Your best on ${problemTitle(p)} has not been sent. Drop it anyway?`)) return;
  const lv = laneOn(key);
  if (lv) lv.lane.stop();
  const left = drop(state, key, now());
  log(state, now(), left ? `Dropped ${problemTitle(p)}.` : `Dropping ${problemTitle(p)} once its best has been sent.`);
  persist();
  showFocus();
  render();
  void submitTick();
  void dealTick();
}

let lanesSig = "";
function renderLanes(o: ReadonlySet<UpgradeId>, t: number): void {
  show("t-lanes", revealed(state, "lanes"));
  if (!revealed(state, "lanes")) return;
  const list = $("t-lane-list");
  const sig = `${lanes.length}`;
  if (sig !== lanesSig) {
    lanesSig = sig;
    list.replaceChildren(
      ...lanes.map((_, i) => {
        const li = document.createElement("li");
        const line = document.createElement("div");
        line.className = "t-lane-line";
        const bar = document.createElement("progress");
        bar.setAttribute("aria-label", `Lane ${i + 1} progress`);
        li.append(line, bar);
        return li;
      }),
    );
  }
  lanes.forEach((lv, i) => {
    const li = list.children[i] as HTMLElement;
    const line = li.querySelector(".t-lane-line") as HTMLElement;
    const bar = li.querySelector("progress") as HTMLProgressElement;
    const q = lv.key ? problem(state, lv.key) : undefined;
    let msg: string;
    if (q) {
      msg =
        `Lane ${i + 1}: ${problemTitle(q)} · ${lv.action === "compact" ? "Compact · " : ""}${lv.method} · ` +
        `${fmtInt(lv.progress?.evaluations ?? 0)} of ${fmtInt(lv.evals)} evaluations${o.has("seeds") ? ` · seed ${lv.seed}` : ""}` +
        (lv.lane.paused ? " · paused" : "");
      bar.max = lv.evals;
      bar.value = Math.min(lv.evals, lv.progress?.evaluations ?? 0);
    } else {
      const wait = lv.nextAutoAt - t;
      msg =
        `Lane ${i + 1}: idle` +
        (state.settings.auto && o.has("auto1")
          ? wait > 0
            ? ` · next auto run in ${fmtClock(wait)}`
            : " · looking for work"
          : "");
      bar.max = 1;
      bar.value = 0;
    }
    if (line.textContent !== msg) line.textContent = msg;
  });
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

// ---------- controls ----------

$("t-loadall").addEventListener("click", () => {
  const p = focused();
  if (p) void loadAll(p).then(() => showFocus());
});
$("t-compact").addEventListener("click", () => {
  const p = focused();
  const lv = idleLane();
  if (p && lv && p.phase === "loaded") void startRun(lv, p, "compact", true);
});
$("t-evolve").addEventListener("click", () => {
  const p = focused();
  const lv = idleLane();
  if (p && lv && evolvable(p)) void startRun(lv, p, "evolve", true);
});
$("t-method").addEventListener("change", () => {
  const m = $<HTMLSelectElement>("t-method").value as EvolveMethod;
  if (methods(owned()).includes(m)) state.settings.method = m;
  persist();
  render();
});
$("t-auto").addEventListener("click", () => {
  if (!owned().has("auto1")) return;
  state.settings.auto = !state.settings.auto;
  say(
    state.settings.auto
      ? `Auto-eval on: each lane starts a run ${autoWaitSeconds(owned())} s after its last one ends (a game throttle; clicking is faster).`
      : "Auto-eval off. Runs already going finish.",
  );
  persist();
  render();
  autoTick();
});
$("t-stop").addEventListener("click", stopAll);
$("t-next").addEventListener("click", () => {
  const p = focused();
  if (!p || !canDeal(state.dealer, 1, now())) return;
  onDrop(p.key);
});
for (const id of ["t-name", "t-agree"]) $(id).addEventListener("input", () => ($(id).dataset.edited = "1"));
$("t-consent-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $<HTMLInputElement>("t-name").value.replace(/\s+/g, " ").trim().slice(0, 40);
  const agree = $<HTMLInputElement>("t-agree").checked;
  delete $("t-name").dataset.edited;
  delete $("t-agree").dataset.edited;
  if (agree && !name) {
    say("Enter a display name first: records go to PolyPack under it.");
    $("t-name").focus();
    return;
  }
  state.name = name;
  state.consent = agree;
  say(
    agree
      ? `Your records will be sent to PolyPack as “${name}”.`
      : "Nothing will be sent. Your records stay in this browser.",
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
};

if (startNote) say(startNote);
showFocus(true);
render();
applyHold();
void dealTick();
void refreshHeld();
setInterval(() => {
  void dealTick();
  void submitTick();
  autoTick();
  render();
}, 1000);
