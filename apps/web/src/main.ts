import {
  LeaderboardEntry,
  LiteratureRecord,
  MAX_PIECES,
  MAX_SIDES,
  ProblemInfo,
  areaLowerBound,
  isProven,
  parseConfig,
} from "@polypack/geometry";
import * as api from "./api";
import { Board } from "./board";
import { foundWithLabel, submissionFields } from "./found-with";
import { CLOSED_NOTE, acceptedMessage, leaderboardNote } from "./leaderboard-text";
import { decodeShare, encodeShare } from "./share";
import { readStoredBoard, taggedBoard } from "./board-units";
import { fillShapeSelect } from "./shapes-ui";
import { BoardView } from "./view";
import { SnapMode } from "./snapping";
import { SolvePanel } from "./solve-panel";
import { initDimensionSwitch } from "./dimension-switch";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const STORAGE_KEY = "polypack.board";
const DEG = 180 / Math.PI;

const status = $("status");
const say = (msg: string) => {
  status.textContent = msg;
};

const board = new Board();
const view = new BoardView($<HTMLCanvasElement>("board"), board, say);

// Handle for the browser console and the end-to-end tests.
Object.assign(window, { polypack: { board, view } });

/** Number formatted for an input field: up to 9 decimals, no trailing zeros. */
const fmt = (v: number) => String(Number(v.toFixed(9)));

// ---------- problem pickers ----------

interface Picker {
  select: HTMLSelectElement;
  custom: HTMLInputElement;
}
function makePicker(prefix: string): Picker {
  const select = $<HTMLSelectElement>(`${prefix}-select`);
  const custom = $<HTMLInputElement>(`${prefix}-custom`);
  fillShapeSelect(select, true);
  return { select, custom };
}
function readPicker(p: Picker): number | null {
  p.custom.hidden = p.select.value !== "other";
  if (p.select.value !== "other") return Number(p.select.value);
  const v = Number(p.custom.value);
  return Number.isInteger(v) && v >= 3 && v <= MAX_SIDES ? v : null;
}
function writePicker(p: Picker, value: number): void {
  if (document.activeElement === p.select || document.activeElement === p.custom) return;
  const listed = value === 0 || (value >= 3 && value <= 20);
  p.select.value = listed ? String(value) : "other";
  p.custom.hidden = listed;
  if (!listed) p.custom.value = String(value);
}

const nPicker = makePicker("n");
const mPicker = makePicker("m");
const pInput = $<HTMLInputElement>("p-input");

function problemChanged(): void {
  const N = readPicker(nPicker);
  const M = readPicker(mPicker);
  const P = Number(pInput.value);
  if (N === null || M === null) return say(`Sides must be an integer from 3 to ${MAX_SIDES}.`);
  if (!Number.isInteger(P) || P < 1 || P > MAX_PIECES) return say(`P must be an integer from 1 to ${MAX_PIECES}.`);
  const had = board.state.pieces.length > 0;
  const shapeChanged = N !== board.state.N;
  board.setProblem(N, M, P);
  if (had && shapeChanged) say("Piece shape changed, so the board was cleared. Undo brings it back.");
  else if (had) say("Problem changed. Your pieces were kept; use Clear to start over.");
  view.fit();
}
for (const el of [nPicker.select, nPicker.custom, mPicker.select, mPicker.custom, pInput]) {
  el.addEventListener("change", problemChanged);
}

// ---------- records and leaderboard ----------

let info: ProblemInfo | null = null;
let entries: LeaderboardEntry[] = [];
let total = 0;
let loadedKey = "";
let requestedKey = "";
/** A problem whose record a link asked to load (#p=N,M,P&record), until its data has arrived. */
let recordWanted: string | null = null;

type RecordChoice =
  | { kind: "literature"; value: number; lit: LiteratureRecord }
  | { kind: "site"; value: number; entry: LeaderboardEntry };

/** The record the single button shows: the proven minimum if there is one, otherwise the best known. */
function currentRecord(): RecordChoice | null {
  const lit = info?.literature ?? null;
  const site = info?.site_best ?? null;
  if (lit && isProven(lit.status)) return { kind: "literature", value: lit.value, lit };
  if (site && (!lit || site.score < lit.value)) return { kind: "site", value: site.score, entry: site };
  if (lit) return { kind: "literature", value: lit.value, lit };
  return null;
}

// Live updates for the problem on the board only; it follows the board from problem to problem.
const live = new api.LiveFeed(
  (e) => {
    const s = board.state;
    if (e.N !== s.N || e.M !== s.M || e.P !== s.P) return;
    if (e.rank === 1) say(`New best for this problem: ${e.score.toFixed(6)} by ${e.name}.`);
    refreshProblem();
  },
  () => refreshProblem(),
);

async function refreshProblem(): Promise<void> {
  const { N, M, P } = board.state;
  const key = `${N}/${M}/${P}`;
  requestedKey = key;
  live.follow([key]);
  const [problem, lb] = await Promise.all([api.getProblem(N, M, P), api.getLeaderboard(N, M, P)]);
  const s = board.state;
  if (`${s.N}/${s.M}/${s.P}` !== key) return; // the problem changed while loading
  info = problem;
  entries = lb?.entries ?? [];
  total = lb?.total ?? 0;
  loadedKey = key;
  $("leaderboard-note").textContent = problem
    ? ""
    : "The server is not reachable; records and the leaderboard are unavailable.";
  render();
  if (recordWanted === key) {
    recordWanted = null;
    if (currentRecord()) await showRecord();
  }
}

const statusText: Record<string, string> = {
  proven: "proven optimal",
  proven_unrefereed: "proven optimal (unrefereed: the proof is recent and not peer reviewed)",
  best_known: "best known, not proven",
  trivial_tiling: "optimal: a zero-waste tiling",
};

function link(text: string, href: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.textContent = text;
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

async function loadEntry(id: number, who: string): Promise<void> {
  const cfg = await api.getSubmission(id);
  // the server keeps only the best entry of each problem, so a link to one since overtaken is dead
  if (!cfg)
    return say(
      "That entry could not be loaded. It may have been overtaken: only the best entry of each problem is kept.",
    );
  const err = board.load({ N: cfg.N, M: cfg.M, P: cfg.P, pieces: cfg.pieces, container_phi: cfg.container_phi });
  if (err) return say(`That entry could not be loaded: ${err}.`);
  view.fit();
  say(`Loaded ${who}'s entry as an editable copy. Undo returns to your board.`);
}

async function showRecord(): Promise<void> {
  const rec = currentRecord();
  const box = $("record-info");
  if (!rec) return;
  box.hidden = false;
  box.replaceChildren();
  const line = (...parts: (string | Node)[]) => {
    const p = document.createElement("p");
    p.append(...parts);
    box.append(p);
  };
  if (rec.kind === "site") {
    line(`Best record: ${rec.value.toFixed(6)} by ${rec.entry.name} on this site's leaderboard.`);
    if (info?.literature)
      line(
        `Best published value: ${info.literature.display} (`,
        link(info.literature.source_name, info.literature.source_url),
        ").",
      );
    await loadEntry(rec.entry.id, rec.entry.name);
    return;
  }
  const lit = rec.lit;
  line(`${lit.display} — ${statusText[lit.status]}.`);
  line("Source: ", link(lit.source_name, lit.source_url), `, read ${lit.accessed}.`);
  if (lit.citation) line(lit.citation);
  if (lit.picture_url) line(link("Picture at the source", lit.picture_url));
  line(`Conversion: ${lit.conversion_note}`);
  if (lit.note) line(lit.note);
  if (lit.coordinates_note) line(lit.coordinates_note);
  if (lit.pieces) {
    const err = board.load({ N: lit.N, M: lit.M, P: lit.P, pieces: lit.pieces, container_phi: lit.container_phi ?? 0 });
    if (err) line(`The stored coordinates could not be loaded: ${err}.`);
    else {
      view.fit();
      say("Record loaded as an editable copy. Undo returns to your board.");
    }
  } else {
    line("Coordinates are not available from the source, so this arrangement cannot be loaded onto the board.");
  }
}
$("show-record").addEventListener("click", showRecord);

function renderLeaderboard(): void {
  const list = $("leaderboard");
  list.replaceChildren();
  // one row at most: the leader
  for (const e of entries.slice(0, 1)) {
    const li = document.createElement("li");
    const pending = e.verification === "pending";
    if (pending) li.className = "pending";
    const head = document.createElement("span");
    head.textContent = `${e.score.toFixed(6)} — ${e.name} `;
    if (pending) {
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = "⚑ pending verification";
      b.title = "Below the best published value; awaiting review";
      head.append(b);
    }
    const meta = document.createElement("span");
    meta.className = "meta";
    // how the entry was found (nothing for entries stored before that was recorded), then the note
    const found = foundWithLabel(e.found_with);
    meta.textContent = `${[e.created_at.slice(0, 10), found, e.agent_note].filter(Boolean).join(" · ")} · `;
    const load = document.createElement("button");
    load.className = "linkish";
    load.textContent = "load";
    load.setAttribute("aria-label", `Load the entry of ${e.name}`);
    load.addEventListener("click", () => loadEntry(e.id, e.name));
    meta.append(load);
    li.append(head, meta);
    list.append(li);
  }
  if (info)
    $("leaderboard-note").textContent = leaderboardNote(total, entries.length, info.accepts_submissions !== false);
}

// ---------- rendering of the side panel ----------

const phiInput = $<HTMLInputElement>("phi");
const selX = $<HTMLInputElement>("sel-x");
const selY = $<HTMLInputElement>("sel-y");
const selTheta = $<HTMLInputElement>("sel-theta");
let saveTimer = 0;

function setField(el: HTMLInputElement, value: string, enabled = true): void {
  el.disabled = !enabled;
  if (document.activeElement !== el) {
    el.value = value;
    el.classList.remove("invalid");
  }
}

/** Gap of a score to the record in percent, without a "-0.0000". */
function gapPercent(score: number, record: number): string {
  const text = (((score - record) / record) * 100).toFixed(4);
  return Number(text) === 0 ? "0.0000" : text;
}

function render(): void {
  const s = board.state;
  const c = board.container;
  writePicker(nPicker, s.N);
  writePicker(mPicker, s.M);
  if (document.activeElement !== pInput) pInput.value = String(s.P);

  const k = s.pieces.length;
  $("count").textContent = `${k} / ${s.P}` + (k === s.P ? " ✓ ready to submit" : k > s.P ? " ✗ too many" : "");
  $("score-label").textContent = s.M === 0 ? "Container diameter d" : "Container side s";
  $("score").textContent = c ? c.size.toFixed(6) : "—";
  $("bound").textContent = areaLowerBound(s.N, s.M, s.P).toFixed(6);

  const fresh = loadedKey === `${s.N}/${s.M}/${s.P}`;
  const rec = fresh ? currentRecord() : null;
  $("record").textContent = rec
    ? `${rec.value.toFixed(6)} (${rec.kind === "site" ? rec.entry.name : statusText[rec.lit.status].split(":")[0].split(" (")[0]})`
    : "none yet";
  // The gap compares like with like only when all P pieces are placed.
  $("gap").textContent =
    rec && c && k === s.P ? `${gapPercent(c.size, rec.value)} %` : rec ? `place ${s.P} pieces` : "—";
  const button = $<HTMLButtonElement>("show-record");
  const proven = rec?.kind === "literature" && isProven(rec.lit.status);
  button.textContent = proven ? "Show proven minimum" : "Show best record";
  button.disabled = !rec;
  if (!fresh && requestedKey !== `${s.N}/${s.M}/${s.P}`) {
    $("record-info").hidden = true;
    refreshProblem();
  }
  renderLeaderboard();
  // A problem with a proven optimum takes no entries. Until its data has arrived the button stays
  // usable: the server refuses such a submission with the same explanation.
  const isClosed = fresh && info?.accepts_submissions === false;
  $<HTMLButtonElement>("submit").disabled = isClosed;
  $("submit-closed").hidden = !isClosed;

  setField(phiInput, fmt(s.phi * DEG), s.M !== 0);
  $<HTMLButtonElement>("auto-orient").disabled = s.M === 0 || k === 0;

  const one = board.selection.size === 1 ? s.pieces[[...board.selection][0]] : null;
  setField(selX, one ? fmt(one.x) : "", !!one);
  setField(selY, one ? fmt(one.y) : "", !!one);
  setField(selTheta, one ? fmt(one.theta * DEG) : "", !!one && s.N !== 0);
  $("sel-note").textContent = one
    ? ""
    : board.selection.size
      ? `${board.selection.size} pieces selected; they move and rotate as a group.`
      : "Select one piece to edit its coordinates.";

  $<HTMLButtonElement>("undo").disabled = !board.canUndo;
  $<HTMLButtonElement>("redo").disabled = !board.canRedo;
  for (const id of ["delete", "rot-ccw", "rot-cw", "snap-left", "snap-up", "snap-down", "snap-right"]) {
    $<HTMLButtonElement>(id).disabled = board.selection.size === 0;
  }
  $<HTMLButtonElement>("add-all").disabled = k >= s.P;

  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(taggedBoard(board.toConfig())));
    } catch {
      // storage can be unavailable (private mode); the board still works
    }
  }, 400);
}
board.onChange(render);

// ---------- toolbar ----------

$("mouse-snap").addEventListener("change", () => {
  view.snapMode = $<HTMLSelectElement>("mouse-snap").value as SnapMode;
  say(
    view.snapMode === "off"
      ? "Mouse snapping off."
      : "Drag near a corner or edge to snap. Hold Option / Alt for free movement.",
  );
});

const addNear = () => (board.container ? { x: board.container.cx, y: board.container.cy } : view.cam);
$("add").addEventListener("click", () => {
  const at = addNear();
  board.addPieces(1, at.x, at.y);
});
$("board").addEventListener("add-piece", () => $("add").click());
$("add-all").addEventListener("click", () => {
  const at = addNear();
  board.addPieces(board.state.P - board.state.pieces.length, at.x, at.y);
  view.fit();
});
$("delete").addEventListener("click", () => board.removeSelected());
$("undo").addEventListener("click", () => board.undo());
$("redo").addEventListener("click", () => board.redo());
$("clear").addEventListener("click", () => {
  board.clear();
  say("Board cleared. Undo brings it back.");
});
$("fit").addEventListener("click", () => view.fit());
$("multi").addEventListener("click", (e) => {
  view.multiSelect = !view.multiSelect;
  (e.currentTarget as HTMLElement).setAttribute("aria-pressed", String(view.multiSelect));
});
const rotate = (deg: number) => {
  const pivot = board.selectionPivot();
  if (pivot) board.step(() => board.rotateSelection(deg / DEG, pivot.x, pivot.y));
};
$("rot-ccw").addEventListener("click", () => rotate(1));
$("rot-cw").addEventListener("click", () => rotate(-1));
const snap = (ux: number, uy: number) => {
  const t = board.step(() => board.snapSelection(ux, uy));
  say(t > 0 ? `Moved ${t.toFixed(4)} to contact.` : "Nothing to touch in that direction.");
};
$("snap-left").addEventListener("click", () => snap(-1, 0));
$("snap-right").addEventListener("click", () => snap(1, 0));
$("snap-up").addEventListener("click", () => snap(0, 1));
$("snap-down").addEventListener("click", () => snap(0, -1));

// undo and redo also work when the focus is outside the canvas, but not while typing in a field
const layout = document.querySelector<HTMLElement>("main.layout")!;
document.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement;
  if (t.id === "board" || t.tagName === "INPUT" || t.tagName === "SELECT") return;
  // another kind is shown (dimension-switch.ts): the hidden polygon board is left as it is
  if (layout.dataset.space) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) board.redo();
    else board.undo();
  }
});

// Alt+R runs the optimizer, Alt+A accepts its result, Alt+S submits to the leaderboard, on this board and on the
// other kinds' boards alike. A shortcut clicks its button, so it does nothing while the button is disabled. Keys are
// read by their position (e.code), since Option+R types "®" on a Mac; the capture phase keeps the board's own A key
// (add a piece) from also seeing Alt+A. Not while typing in a field.
const SHORTCUTS: Record<string, { poly: string; space?: string }> = {
  KeyR: { poly: "solve-run", space: "space-solve-run" },
  KeyA: { poly: "solve-accept" },
  KeyS: { poly: "submit", space: "space-submit" },
};
document.addEventListener(
  "keydown",
  (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat) return;
    const shortcut = SHORTCUTS[e.code];
    if (!shortcut) return;
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
    const id = layout.dataset.space ? shortcut.space : shortcut.poly;
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    const button = document.getElementById(id) as HTMLButtonElement | null;
    if (button && !button.disabled) button.click();
  },
  { capture: true },
);

// ---------- numeric fields ----------

phiInput.addEventListener("change", () => {
  const v = Number(phiInput.value);
  if (phiInput.value === "" || !Number.isFinite(v)) return phiInput.classList.add("invalid");
  board.step(() => board.setPhi(v / DEG));
});
$("auto-orient").addEventListener("click", () => {
  const before = board.container?.size ?? 0;
  board.autoOrient();
  const after = board.container?.size ?? 0;
  say(
    after < before
      ? `Auto-orient: ${before.toFixed(6)} → ${after.toFixed(6)}.`
      : "Auto-orient found no better orientation.",
  );
  view.fit();
});

function applySelectedFields(): void {
  if (board.selection.size !== 1) return;
  const i = [...board.selection][0];
  const cur = board.state.pieces[i];
  const x = Number(selX.value);
  const y = Number(selY.value);
  const theta = board.state.N === 0 ? cur.theta : Number(selTheta.value) / DEG;
  const fields = [selX, selY, selTheta];
  if (![x, y, theta].every(Number.isFinite) || selX.value === "" || selY.value === "") {
    fields.forEach((f) => f.classList.add("invalid"));
    return say("Enter numbers for x, y and θ.");
  }
  if (board.setPose(i, { x, y, theta })) {
    fields.forEach((f) => f.classList.remove("invalid"));
    say(`Piece ${i + 1} placed.`);
  } else {
    fields.forEach((f) => f.classList.add("invalid"));
    say("That position would overlap another piece, so it was not applied.");
  }
}
for (const el of [selX, selY, selTheta]) el.addEventListener("change", applySelectedFields);

// ---------- submit ----------

$("submit-closed").textContent = CLOSED_NOTE;
const nameInput = $<HTMLInputElement>("name");
try {
  nameInput.value = localStorage.getItem("polypack.name") ?? "";
} catch {
  // ignore
}
$("submit").addEventListener("click", async () => {
  const out = $("submit-result");
  const s = board.state;
  const fail = (msg: string) => {
    out.className = "note bad";
    out.textContent = `✗ ${msg}`;
  };
  if (s.pieces.length !== s.P) return fail(`Place exactly ${s.P} pieces first (${s.pieces.length} placed).`);
  const name = nameInput.value.trim();
  if (!name) {
    nameInput.focus();
    return fail("Enter a display name.");
  }
  try {
    localStorage.setItem("polypack.name", name);
  } catch {
    // ignore
  }
  out.className = "note";
  out.textContent = "Submitting…";
  // The server scores the container at the orientation it is sent and does not search for a
  // better one, so the container is turned to its best orientation first, as Auto-orient does.
  const unturned = board.container?.size ?? 0;
  if (board.autoOrient(false)) {
    say(
      `Turned the container to its best orientation before submitting: ${unturned.toFixed(6)} → ${board.container!.size.toFixed(6)}.`,
    );
    view.fit();
  }
  // The note is the user's own text; how the board was found is sent in its own fields.
  const note = $<HTMLInputElement>("agent-note").value.trim();
  const r = await api.submit({
    ...board.toConfig(),
    name,
    ...(note ? { agent_note: note } : {}),
    ...submissionFields(solve.foundWith),
  });
  if ("error" in r) return fail(r.error);
  if (!r.valid) {
    fail(r.reasons.join("; "));
    // a refusal can mean that the problem was closed since it was loaded
    refreshProblem();
    return;
  }
  out.className = r.leader ? "note good" : "note";
  out.textContent = acceptedMessage(r);
  refreshProblem();
});

// ---------- save and share ----------

$("export").addEventListener("click", () => {
  const s = board.state;
  const blob = new Blob([JSON.stringify(taggedBoard(board.toConfig()), null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `polypack-N${s.N}-M${s.M}-P${s.P}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});
const importFile = $<HTMLInputElement>("import-file");
$("import").addEventListener("click", () => importFile.click());
importFile.addEventListener("change", async () => {
  const file = importFile.files?.[0];
  importFile.value = "";
  if (!file) return;
  let parsed;
  try {
    parsed = readStoredBoard(JSON.parse(await file.text()));
  } catch {
    return say("Import failed: the file is not valid JSON.");
  }
  if (!parsed.ok) return say(`Import failed: ${parsed.errors.join("; ")}.`);
  const err = board.load(parsed.config);
  if (err) return say(`Import failed: ${err}.`);
  view.fit();
  say(`Imported ${parsed.config.pieces.length} pieces.`);
});
$("share").addEventListener("click", async () => {
  const url = `${location.origin}${location.pathname}#${encodeShare(board.toConfig())}`;
  history.replaceState(null, "", url);
  try {
    await navigator.clipboard.writeText(url);
    say("Share link copied to the clipboard.");
  } catch {
    say("The share link is now in the address bar.");
  }
});

// ---------- live updates ----------

// (the feed is created with the records above, and follows the problem refreshProblem reads)
setInterval(() => $("live").classList.toggle("on", live.isLive()), 1500);

// ---------- start ----------

/**
 * Links from the records page (#p=N,M,P, with &record to load the record's arrangement once the
 * problem's data has arrived) and to a stored submission (#s=id).
 */
function followLink(): boolean {
  const p = /[#&]p=(\d+),(\d+),(\d+)(&record)?/.exec(location.hash);
  if (p) {
    const parsed = parseConfig({ N: Number(p[1]), M: Number(p[2]), P: Number(p[3]), pieces: [], container_phi: 0 });
    if (parsed.ok) {
      const { N, M, P } = parsed.config;
      const same = N === board.state.N;
      if (p[4]) {
        const key = `${N}/${M}/${P}`;
        // already loaded: show it now; otherwise when refreshProblem has the problem's data
        if (loadedKey === key && board.state.N === N && board.state.M === M && board.state.P === P) {
          board.setProblem(N, M, P);
          void showRecord();
        } else {
          recordWanted = key;
          board.setProblem(N, M, P);
        }
        return true;
      }
      // keep the saved pieces when only M or P differ
      board.setProblem(N, M, P);
      if (!same) say("Problem opened with an empty board.");
      return true;
    }
  }
  const sub = /[#&]s=(\d+)/.exec(location.hash);
  if (sub) {
    loadEntry(Number(sub[1]), "the submitter");
    return true;
  }
  return false;
}

function loadInitial(): void {
  const shared = decodeShare(location.hash);
  if (shared && !board.load(shared, false)) return;
  let restored = false;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    const parsed = saved ? readStoredBoard(JSON.parse(saved)) : null;
    restored = !!parsed?.ok && !board.load(parsed.config, false);
  } catch {
    // fall through to the default board
  }
  if (!restored) board.load({ N: 7, M: 7, P: 7, pieces: [], container_phi: 0 }, false);
  followLink();
}
loadInitial();
window.addEventListener("hashchange", () => {
  const shared = decodeShare(location.hash);
  if (shared && !board.load(shared)) view.fit();
  else if (followLink()) view.fit();
});
view.fit();
const solve = new SolvePanel(board, view, say);
Object.assign((window as unknown as { polypack: object }).polypack, { solve });
// the Problem set menu: the other families load on demand, and Flat (2D in 2D) is this board as it
// is; a run of the board's optimizer is paused while another family is shown, and goes on after
initDimensionSwitch(() => view.fit(), say, {
  hold: () => solve.holdWhileHidden(),
  release: () => solve.releaseHidden(),
});
