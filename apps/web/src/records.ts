/**
 * The Records page for the dimensions other than the classic board: a tab per dimension, a picker
 * per field of the chosen kind's problem ids, charts of the chosen problem family against P, and a
 * table of its records or of every record of the kind. The classic board's records are on
 * browse.html (the Flat kind of 2D in 2D).
 */
import type { SpaceInfo, SpaceName } from "@polypack/spaces";
import * as api from "./api";
import { safeHref } from "./atlas-model";
import { DIMENSIONS, familyOfSpace } from "./dimension-table";
import { addOptions } from "./option-groups";
import { drawRecordsChart } from "./records-chart";
import {
  ChartPoint,
  RecordsState,
  SCORE_NAMES,
  chartPoints,
  domainPRange,
  collectPages,
  gapText,
  isPolygonHash,
  nextZoom,
  statusText,
  holderText,
  parseRecordsHash,
  pickers,
  recordsHash,
  scoreText,
  seriesHash,
  seriesNote,
  seriesProblems,
  seriesTitle,
  settleSeries,
} from "./records-model";
import { renderTabs } from "./records-tabs";
import { el } from "./shapes-ui";
import { isBoardSpace, spaceAddress } from "./space-address";
import {
  FieldSpec,
  ListedProblem,
  SPACE_FIELDS,
  day,
  entriesText,
  fieldOf,
  filterProblems,
  minus,
  nofoldFaceProblem,
  plainBoundLabel,
  round6,
  sentence,
  siteBelowCertified,
} from "./spaces-model";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Rows of a table of every record that show at once; a button shows the next ones. */
const ROWS_PER_PAGE = 200;

let infos: SpaceInfo[] = [];
let state: RecordsState | null = null;
/** Problems of each kind, fetched once per visit: the records, and the problems of a domain that only have entries. */
const loaded = new Map<SpaceName, ListedProblem[]>();
/** The range of P the charts are zoomed to; null shows every P. A new family starts unzoomed. */
let zoom: { from: number; to: number } | null = null;
let shownRows = ROWS_PER_PAGE;

/** A link whose visible text is completed for screen readers ("Board" → "Board: cube/fold/4/7"). */
function link(href: string, text: string, hidden: string): HTMLAnchorElement {
  const a = el("a", text);
  a.href = href;
  a.append(el("span", hidden, "visually-hidden"));
  return a;
}

function th(text: string, sub = ""): HTMLTableCellElement {
  const cell = el("th", text);
  cell.scope = "col";
  if (sub) cell.append(el("span", sub, "th-sub"));
  return cell;
}

/** Hash of the page without changing the history entry: the pickers and the table's scope do not make steps for Back. */
function follow(next: RecordsState): void {
  state = next;
  history.replaceState(history.state, "", `${location.pathname}${location.search}${recordsHash(next)}`);
}

/** Each kind's problems are fetched once, however fast the tabs are switched: the answer in flight is shared. */
const loading = new Map<SpaceName, Promise<ListedProblem[] | null>>();

function load(space: SpaceName): Promise<ListedProblem[] | null> {
  const known = loaded.get(space);
  if (known) return Promise.resolve(known);
  let pending = loading.get(space);
  if (!pending) {
    pending = (async () => {
      const data = await api.getSpaceRecords(space);
      if (!data) return null;
      const problems: ListedProblem[] = [...data.problems];
      // a domain's problems without a research record are not in the listing: those with site entries come by themselves
      if (infos.find((s) => s.space === space)?.domain)
        problems.push(...(await collectPages((after) => api.getSpaceSiteOnly(space, after))));
      loaded.set(space, problems);
      return problems;
    })().finally(() => loading.delete(space));
    loading.set(space, pending);
  }
  return pending;
}

/** The pickers are built again only for another kind, so that focus stays on the picker being used. */
let pickersOf: SpaceName | null = null;

function renderPickers(
  space: SpaceName,
  problems: ListedProblem[],
  info: SpaceInfo | undefined,
  chosen: Record<string, string>,
): void {
  const form = $("pickers");
  if (pickersOf === space) {
    for (const f of SPACE_FIELDS[space]) $<HTMLSelectElement>(`pick-${f.key}`).value = chosen[f.key];
    return;
  }
  pickersOf = space;
  form.replaceChildren();
  for (const { spec, options } of pickers(space, problems, info)) {
    const select = el("select");
    select.id = `pick-${spec.key}`;
    addOptions(select, options);
    select.value = chosen[spec.key];
    select.addEventListener(
      "change",
      () => void show({ ...state!, filters: { ...state!.filters, [spec.key]: select.value } }),
    );
    const label = el("label", spec.label);
    label.htmlFor = select.id;
    // a label and its select wrap together on a narrow screen
    const pair = el("span", "", "filter");
    pair.append(label, select);
    form.append(pair);
  }
}

// ---------- charts ----------

interface Charted {
  space: SpaceName;
  points: ChartPoint[];
  range: [number, number];
  title: string;
  scoreName: string;
}
let charted: Charted | null = null;

function drawCharts(keep?: number, focusOn?: Element | null): void {
  const reset = $<HTMLButtonElement>("chart-reset");
  if (!charted) return;
  const { points, range, title, scoreName } = charted;
  const inZoom = zoom ? points.filter((p) => p.P >= zoom!.from && p.P <= zoom!.to) : points;
  // a range with fewer than two points shows every P
  const zoomed = !!zoom && inZoom.length >= 2;
  const visible = zoomed ? inZoom : points;
  const span: [number, number] = zoomed ? [visible[0].P, visible[visible.length - 1].P] : range;
  reset.hidden = !zoomed;
  $("chart-range").textContent = zoomed ? `P = ${span[0]} to ${span[1]}` : "";
  $("chart-title").textContent = points.length
    ? `The record ${scoreName} for each number of pieces P against the lower bound, below which no packing can be. ${title}.`
    : `${title}: no problem of this family has a record or an entry yet.`;
  $("chart-gap-title").textContent = points.some((p) => p.bound !== null)
    ? `How far each record stands above the lower bound: the record minus the bound, for each P. ${title}.`
    : `${title}: no lower bound is known for the records of this family.`;
  const zoomTo = (from: number | null, to?: number, keepP?: number) => {
    const all = charted!.points;
    zoom = nextZoom(zoom, all.length ? [all[0].P, all[all.length - 1].P] : null, from, to);
    drawCharts(keepP, document.activeElement instanceof SVGElement ? document.activeElement : null);
  };
  for (const [id, mode] of [
    ["chart", "size"],
    ["chart-gap", "gap"],
  ] as const) {
    const chart = document.getElementById(id) as unknown as SVGSVGElement;
    drawRecordsChart(
      chart,
      { points: visible, pRange: span, scoreName, title, mode, empty: "No record or entry yet" },
      zoomTo,
      focusOn === chart ? keep : undefined,
    );
  }
}
$("chart-reset").addEventListener("click", () => {
  zoom = null;
  drawCharts();
});

// ---------- table ----------

function renderTable(
  space: SpaceName,
  problems: ListedProblem[],
  series: ListedProblem[],
  info: SpaceInfo | undefined,
): void {
  const specs = SPACE_FIELDS[space];
  const all = state!.all;
  const rows = all ? filterProblems(space, problems, {}) : series;
  const fields: FieldSpec[] = all ? specs : [];
  const head = el("tr");
  head.append(
    ...fields.map((f) => th(f.label)),
    th("P"),
    th("Record", "6 decimals"),
    th("Status"),
    th("Held by"),
    th("Lower bound"),
    th("Gap", "record minus bound"),
    th("Links"),
  );
  $("rec-head").replaceChildren(head);
  $("same-as").hidden = !rows.some((p) => nofoldFaceProblem(p.id));
  $("table-note").textContent = rows.length
    ? all
      ? `${rows.length.toLocaleString("en-US")} problems with a research record or an entry.`
      : ""
    : info?.domain && !all
      ? "No problem of this family has a record or an entry yet. All its problems are open: choose one on the board, or let the volunteer client search them."
      : "No problems.";
  // a table with no rows has nothing to scroll or to reach: its box is left out
  $("rec-wrap").hidden = !rows.length;
  const body = $("rec-rows");
  const shown = rows.slice(0, all ? shownRows : rows.length);
  body.replaceChildren(
    ...shown.map((p) => {
      const tr = el("tr");
      tr.dataset.id = p.id;
      if (!p.accepts_submissions) tr.className = "closed";
      for (const f of fields) tr.append(el("td", f.cell(fieldOf(p, f))));
      tr.append(el("td", String(p.P), "num"));
      const rec = el("td", scoreText(p), "num");
      if (siteBelowCertified(p)) rec.append(" ", el("span", "below research record", "badge"));
      tr.append(rec);
      const status = el("td", statusText(p), "state");
      const why = entriesText(p).why;
      if (why && !p.accepts_submissions) {
        // a proven optimum cites its proofs, which can be long, so they open on demand
        const d = el("details", "", "cell-why");
        d.append(el("summary", "Why closed"), why);
        status.append(d);
      }
      tr.append(status);
      tr.append(
        el(
          "td",
          p.site_best && holderText(p) === "Site entry"
            ? `Site entry: ${p.site_best.name}, ${day(p.site_best.created_at)}`
            : holderText(p),
          "name",
        ),
      );
      const bound = el("td", p.bound ? minus(round6(p.bound.value)) : "—", "num");
      if (p.bound?.label) bound.append(el("span", plainBoundLabel(p.bound.label), "cell-why"));
      tr.append(bound);
      tr.append(el("td", p.best_score !== null && p.bound ? gapText(p.best_score, p.bound.value) : "—", "num"));
      const links = el("td", "", "links");
      if (isBoardSpace(space)) links.append(link(`/${spaceAddress(space, p.id)}`, "Board", `: ${p.id}`));
      if (all) links.append(" ", link(seriesHash(space, specs, p), "Chart", `: family of ${p.id}`));
      const face = nofoldFaceProblem(p.id);
      if (face)
        links.append(
          " ",
          link(face.href, `Same as N = ${face.N}, M = ${face.M}, P = ${face.k}`, ` in 2D in 2D, for ${p.id}`),
        );
      tr.append(links);
      return tr;
    }),
  );
  const more = $<HTMLButtonElement>("rec-more");
  more.hidden = shown.length >= rows.length;
  more.textContent = `Show ${Math.min(ROWS_PER_PAGE, rows.length - shown.length).toLocaleString("en-US")} more of ${(rows.length - shown.length).toLocaleString("en-US")}`;
}

// ---------- page ----------

async function show(wish: RecordsState): Promise<void> {
  const space = wish.space;
  const info = infos.find((s) => s.space === space);
  const where = familyOfSpace(space);
  state = wish;
  renderTabs($("records-tabs"), space);
  document.title = `PolyPack — Records: ${where ? `${where.dimension.label}, ${where.family.name}` : space}`;
  $("kind-summary").textContent = where ? `${where.dimension.summary} ${where.family.summary}` : "";
  const known = loaded.get(space);
  if (!known) {
    $("status").textContent = "Loading the records…";
    $("records").hidden = true;
  }
  const problems = known ?? (await load(space));
  // another kind was chosen while the answer was on its way; the newer request draws the page
  if (state !== wish) return;
  if (!problems) {
    $("status").textContent = "The records of this kind could not be loaded.";
    return;
  }
  $("status").textContent = "";
  $("records").hidden = false;
  const list = pickers(space, problems, info);
  const chosen = settleSeries(list, problems, wish.filters);
  follow({ space, filters: chosen, all: wish.all });
  renderPickers(space, problems, info, chosen);
  const specs = SPACE_FIELDS[space];
  const series = seriesProblems(specs, problems, chosen);
  const sc = $("score-note");
  sc.replaceChildren(info ? `Score: ${sentence(info.score)}` : "");
  const viewer = safeHref(info?.viewer ?? "");
  if (viewer) sc.append(" ", link(viewer, "Open the viewer", ` of ${where?.family.name ?? space}`), ".");
  $("series-note").textContent = seriesNote(
    info,
    series,
    info?.records ?? problems.length,
    info?.problems ?? problems.length,
  );
  const points = chartPoints(series);
  const domain = domainPRange(info);
  const range: [number, number] = domain ?? (series.length ? [series[0].P, series[series.length - 1].P] : [1, 10]);
  const sameFamily = charted && charted.space === space && charted.title === seriesTitle(specs, chosen);
  if (!sameFamily) zoom = null;
  charted = { space, points, range, title: seriesTitle(specs, chosen), scoreName: SCORE_NAMES[space] ?? "score" };
  drawCharts();
  for (const input of document.querySelectorAll<HTMLInputElement>("input[name=scope]"))
    input.checked = input.value === (wish.all ? "all" : "series");
  shownRows = ROWS_PER_PAGE;
  renderTable(space, problems, series, info);
}

for (const input of document.querySelectorAll<HTMLInputElement>("input[name=scope]"))
  input.addEventListener("change", () => {
    if (input.checked && state) void show({ ...state, all: input.value === "all" });
  });
$("rec-more").addEventListener("click", () => {
  shownRows += ROWS_PER_PAGE;
  const space = state!.space;
  const problems = loaded.get(space)!;
  renderTable(
    space,
    problems,
    seriesProblems(SPACE_FIELDS[space], problems, state!.filters),
    infos.find((s) => s.space === space),
  );
});

/** Kinds in the order of the dimensions; the Flat kind has its own page. */
const ORDER: string[] = DIMENSIONS.flatMap((d) => d.families.map((f) => f.space));

/** The polygons' problems, and kinds this page has no table for, are on browse.html: the hash goes along. */
const sendToPolygons = (): boolean => {
  if (!isPolygonHash(location.hash, Object.keys(SPACE_FIELDS))) return false;
  location.replace(`/browse.html${location.search}${location.hash}`);
  return true;
};

async function start(): Promise<void> {
  if (sendToPolygons()) return;
  // the tabs are known without the server
  renderTabs($("records-tabs"), "curved");
  const data = await api.getSpaces();
  if (!data) {
    $("status").textContent = "The server is not reachable, so the records cannot be shown.";
    return;
  }
  infos = data.spaces
    .filter((s) => Object.hasOwn(SPACE_FIELDS, s.space) && ORDER.includes(s.space))
    .sort((a, b) => ORDER.indexOf(a.space) - ORDER.indexOf(b.space));
  const names = infos.map((s) => s.space);
  const follow = () => {
    if (sendToPolygons()) return;
    const wish = parseRecordsHash(location.hash, names);
    if (wish) void show(wish);
  };
  if (!names.length) {
    $("status").textContent = "The server lists no records for these kinds.";
    return;
  }
  window.addEventListener("hashchange", follow);
  follow();
}

void start();
