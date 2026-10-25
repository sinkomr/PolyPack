/**
 * The 3D on 4D viewer at /spaces/boundary.html: any problem of the boundary catalogue
 * (GET /api/spaces/boundary/records), with its research record or its site best, drawn by the
 * three.js views of packages/view3d (Cells, Net with Fold, Slice), its values in the board's words,
 * and links to the board and the notes. "?id=<problem id>" or "#id=<problem id>" opens a problem;
 * the address follows the problem shown.
 *
 * The drawing is the board's (space/render/boundary.ts): three.js loads with a dynamic import
 * after the page, and one view serves every P of a piece, keeping its camera, fold and slice.
 */
import type { SpaceConfig, SpaceName, SpaceProblemSummary } from "@polypack/spaces";
import { type ViewerProblem, piecesText, readViewerProblem, viewerId, viewerPacking } from "./boundary-model";
import { problemFacts } from "./space/facts";
import { DEFAULT_PROBLEM, type PickField, fieldsOfId, pickProblem } from "./space/pick";
import { mountBoundaryView } from "./space/render/boundary";
import type { SpaceView } from "./space/view";
import { configUrl, day, downloadName, stateHash } from "./spaces-model";

const SPACE: SpaceName = "boundary";
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Makes an element with a class and children (text is inserted as text, never as markup). */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else e.setAttribute(k, v);
  }
  e.append(...children);
  return e;
}

let problems: SpaceProblemSummary[] | null = null;
let problem: ViewerProblem | null = null;
let view: SpaceView | null = null;
/** The polytope and piece the view draws ("tesseract/ball"): another P of them keeps the view. */
let viewOf = "";
/** The packing the user chose with the Packing menu (kept for the next problem when it has one). */
let wantedPacking: "certified" | "site" | null = null;
/** Counts loads, so that a late answer for an earlier problem is dropped. */
let token = 0;

function say(text: string): void {
  $("viewer-status").textContent = text;
}

/** A message over the drawing while the catalogue or a problem is read, or a failure with Try again; null hides it. */
function busy(text: string | null, retry: (() => void) | null = null): void {
  $("viewer-busy").hidden = text === null;
  $("viewer-busy-text").textContent = text ?? "";
  const button = $<HTMLButtonElement>("viewer-retry");
  button.hidden = !retry;
  button.onclick = retry;
}

/** The address names the problem shown, as "#id=<problem id>" (a query's id is kept, the hash wins). */
function setAddress(id: string): void {
  const hash = `#id=${id}`;
  if (location.hash !== hash) history.replaceState(history.state, "", `${location.pathname}${location.search}${hash}`);
}

async function getJson(url: string): Promise<{ status: number; body: unknown } | null> {
  try {
    const r = await fetch(url);
    let body: unknown = null;
    try {
      body = await r.json();
    } catch {
      // an answer without JSON is described by its status
    }
    return { status: r.status, body };
  } catch {
    return null;
  }
}

/** Reads the catalogue (once), then opens the problem wanted, or the nearest one it lists. */
async function start(wanted: string | null): Promise<void> {
  const mine = ++token;
  if (!problems) {
    busy("Loading the problems of this kind…");
    const r = await getJson(`/api/spaces/${SPACE}/records`);
    if (mine !== token) return;
    const list =
      r && r.status === 200 && Array.isArray((r.body as { problems?: unknown })?.problems)
        ? (r.body as { problems: SpaceProblemSummary[] }).problems.filter((p) => typeof p?.id === "string")
        : null;
    if (!list) {
      const text = "The problems of this kind could not be loaded. The server may be unreachable.";
      say(text);
      busy(text, () => void start(wanted));
      return;
    }
    problems = list;
  }
  const pick = pickProblem(SPACE, problems, fieldsOfId(SPACE, wanted ?? DEFAULT_PROBLEM[SPACE]));
  renderPicker(pick.fields);
  if (!pick.id) {
    busy("This kind lists no problems.");
    return;
  }
  const note =
    wanted !== null && wanted !== pick.id ? `${wanted} is not in the catalogue, so ${pick.id} is shown.` : "";
  await load(pick.id, note);
}

function renderPicker(fields: PickField[]): void {
  const rows = fields.map((f) => {
    const id = `viewer-f-${f.key}`;
    const select = h("select", { id, autocomplete: "off" });
    for (const o of f.options) select.add(new Option(o.text, o.value));
    select.value = f.value;
    select.addEventListener("change", () => {
      const wish: Record<string, string> = {};
      for (const g of fields) wish[g.key] = g.key === f.key ? select.value : g.value;
      const pick = pickProblem(SPACE, problems ?? [], wish);
      renderPicker(pick.fields);
      // keep the focus on the field that was changed
      $(id)?.focus();
      if (pick.id) void load(pick.id, "");
    });
    return h("div", { class: "row" }, h("label", { for: id }, f.label), select);
  });
  $("viewer-fields").replaceChildren(...rows);
}

async function load(id: string, note: string): Promise<void> {
  const mine = ++token;
  setAddress(id);
  busy(`Loading ${id}…`);
  const r = await getJson(configUrl(SPACE, id));
  if (mine !== token) return;
  const p =
    r === null
      ? "The server is not reachable."
      : r.status === 404
        ? `${id} is not in the catalogue of this kind.`
        : r.status !== 200
          ? `The server answered ${r.status}.`
          : readViewerProblem(id, r.body);
  if (typeof p === "string") {
    problem = null;
    view?.show(null);
    renderValues(null);
    say(p);
    busy(`${id} could not be loaded. ${p}`, () => void load(id, note));
    return;
  }
  busy(null);
  problem = p;
  // a view of the same polytope and piece keeps its camera, fold and slice
  if (!view || viewOf !== `${p.polytope}/${p.piece}`) {
    view?.destroy();
    view = mountBoundaryView($("viewer-host"), p, "Drawing of the packing");
    viewOf = `${p.polytope}/${p.piece}`;
  }
  show(note);
}

/** Draws the packing the Packing menu names (or the better one), with its values and links. */
function show(note = ""): void {
  const p = problem;
  if (!p) return;
  const packing = viewerPacking(p, wantedPacking);
  const select = $<HTMLSelectElement>("viewer-packing");
  const [certified, site] = [...select.options];
  // the values themselves are under Values; the menu says only which packings there are
  certified.disabled = !p.configs.certified;
  certified.textContent = p.configs.certified ? "Research record" : "Research record (none)";
  site.disabled = !p.configs.site;
  site.textContent = p.configs.site ? "Site best" : p.site_best ? "Site best (unreadable)" : "Site best (none yet)";
  select.disabled = !packing;
  if (packing) select.value = packing;
  const config = packing ? p.configs[packing] : null;
  // a boundary configuration, read by readBoundaryConfig
  view?.show(config as SpaceConfig | null);
  renderValues(packing);
  const what =
    packing === "site"
      ? `the site's best entry, by ${p.site_best!.name}, ${day(p.site_best!.created_at)}`
      : packing === "certified"
        ? "the research record"
        : null;
  say(
    note ||
      (config && what
        ? `${p.id}: ${piecesText(p.piece, p.P)}, ${what}, edge ${config.s.toFixed(6)}.`
        : p.status === "infeasible"
          ? `${p.id}: no packing exists for this problem.`
          : `${p.id}: the server's packing of this problem could not be read.`),
  );
}

function renderValues(packing: "certified" | "site" | null): void {
  const p = problem;
  const config = p && packing ? p.configs[packing] : null;
  $("viewer-score").textContent = config ? config.s.toFixed(6) : "—";
  $("viewer-shown").textContent =
    p && packing === "site"
      ? `the site's best entry, by ${p.site_best!.name}`
      : p && packing === "certified"
        ? "the research record"
        : "—";
  const facts = $("viewer-facts");
  facts.replaceChildren();
  if (p)
    for (const f of problemFacts(p)) {
      const dd = h("dd", {}, f.value);
      if (f.note && f.details) dd.append(h("details", { class: "fact-note" }, h("summary", {}, "Why"), f.note));
      else if (f.note) dd.append(h("span", { class: "fact-note" }, f.note));
      facts.append(h("dt", {}, f.label), dd);
    }
  $("viewer-problem-note").replaceChildren(...(p ? ["Problem ", h("code", {}, p.id)] : []));
  // the links name the problem shown
  const board = $<HTMLAnchorElement>("viewer-board");
  board.href = p ? `/#space=${p.id}` : "/#space=boundary";
  const records = $<HTMLAnchorElement>("viewer-records");
  records.href = `/dimensions.html${stateHash({ space: SPACE, filters: p ? { polytope: p.polytope, piece: p.piece } : {} })}`;
  const json = $<HTMLAnchorElement>("viewer-json");
  json.hidden = !p;
  if (p) {
    json.href = configUrl(SPACE, p.id);
    json.download = downloadName(p.id);
    json.textContent = `${p.id} as JSON`;
  }
  // the page's title names the problem, for tabs and history
  document.title = p ? `PolyPack — 3D on 4D: ${piecesText(p.piece, p.P)}` : "PolyPack — 3D on 4D viewer";
}

$<HTMLSelectElement>("viewer-packing").addEventListener("change", (e) => {
  wantedPacking = (e.target as HTMLSelectElement).value as "certified" | "site";
  show();
});
window.addEventListener("hashchange", () => {
  const id = viewerId(location.search, location.hash);
  if (id && id !== problem?.id) void start(id);
});

void start(viewerId(location.search, location.hash));
