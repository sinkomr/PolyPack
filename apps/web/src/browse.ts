import { areaLowerBound } from "@polypack/geometry";
import * as api from "./api";
import { Atlas } from "./atlas";
import { AtlasRow, AtlasView, parseView, safeHref, viewQuery } from "./atlas-model";
import { el, fillShapeSelect, shapeLabel } from "./shapes-ui";
import { SOURCES, followSourceMarks, recordSources, renderSourceList, sourceMarks } from "./sources";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const nSel = $<HTMLSelectElement>("n-select");
const mSel = $<HTMLSelectElement>("m-select");
fillShapeSelect(nSel, false);
fillShapeSelect(mSel, false);
// the notes of the sources do not depend on the server: they are there before any record is
renderSourceList($("source-list"));
followSourceMarks(document);

const STATUS: Record<string, string> = {
  proven: "proven",
  proven_unrefereed: "proven (unrefereed)",
  best_known: "best known",
  trivial_tiling: "optimal tiling",
};

type Row = AtlasRow;

/** The problem is in the hash, "#N,M". Returns false when the hash names shapes this page does not offer. */
function selectFromHash(): boolean {
  const hash = /^#(\d+),(\d+)$/.exec(location.hash);
  const offered = (select: HTMLSelectElement, value: string) => [...select.options].some((o) => o.value === value);
  const valid = !!hash && offered(nSel, hash[1]) && offered(mSel, hash[2]);
  nSel.value = valid ? hash![1] : "4";
  mSel.value = valid ? hash![2] : "4";
  // no hash at all is the default problem; a hash that cannot be read is a broken link
  return valid || !location.hash;
}
const validStart = selectFromHash();

/** The atlas keeps its display state in the query string; the problem stays in the hash. */
const address = (query: string) => `${location.pathname}${query}#${Number(nSel.value)},${Number(mSel.value)}`;
/** Marks the history entry made by opening a detail panel, so that closing the panel can step back over it. */
const PANEL_ENTRY = "atlasPanel";
function followView(view: AtlasView, how: "push" | "replace" | "close"): void {
  const url = address(viewQuery(view, location.search));
  if (how === "push") history.pushState({ [PANEL_ENTRY]: true }, "", url);
  // closed with Esc or Close: leave the entry that opening made, as Back would have
  else if (how === "close" && history.state?.[PANEL_ENTRY]) history.back();
  else history.replaceState(how === "close" ? null : history.state, "", url);
}
const startView = parseView(location.search);
const atlas = new Atlas({
  root: $("atlas"),
  dialog: $<HTMLDialogElement>("atlas-detail"),
  // a panel number means nothing without the problem it belongs to
  view: validStart ? startView : { ...startView, p: null },
  fetchTiles: api.getAtlas,
  onView: followView,
  tileHref: (view) => address(viewQuery(view, location.search)),
  refresh: () => void refresh(),
});

const SVG = "http://www.w3.org/2000/svg";
function svg(tag: string, attrs: Record<string, string | number>, text = ""): SVGElement {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text) e.textContent = text;
  return e;
}

/** Score against P: published values, site bests and the area bound, each with its own mark shape. */
function drawChart(rows: Row[], sizeName: string): void {
  const chart = $("chart");
  chart.replaceChildren();
  if (!rows.length) return;
  const W = 900, H = 380, L = 56, R = 16, T = 34, B = 42;
  const pMin = rows[0].P;
  const pMax = Math.max(rows[rows.length - 1].P, pMin + 1);
  const values = rows.flatMap((r) => [r.bound, r.site?.score, r.lit?.value].filter((v): v is number => v !== undefined));
  const yMin = Math.min(...values) * 0.97;
  const yMax = Math.max(...values) * 1.03;
  const x = (p: number) => L + ((p - pMin) / (pMax - pMin)) * (W - L - R);
  const y = (v: number) => H - B - ((v - yMin) / (yMax - yMin)) * (H - T - B);

  for (let i = 0; i <= 4; i++) {
    const v = yMin + ((yMax - yMin) * i) / 4;
    chart.append(svg("line", { class: "gridline", x1: L, x2: W - R, y1: y(v), y2: y(v) }));
    chart.append(svg("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end" }, v.toFixed(2)));
  }
  const every = Math.max(1, Math.ceil(rows.length / 20));
  rows.forEach((r, i) => {
    if (i % every === 0) chart.append(svg("text", { x: x(r.P), y: H - B + 16, "text-anchor": "middle" }, String(r.P)));
  });
  chart.append(svg("line", { class: "axis", x1: L, x2: W - R, y1: H - B, y2: H - B }));
  chart.append(svg("line", { class: "axis", x1: L, x2: L, y1: T, y2: H - B }));
  chart.append(svg("text", { x: (L + W - R) / 2, y: H - 6, "text-anchor": "middle" }, "P (number of pieces)"));
  chart.append(svg("text", { x: 14, y: (T + H - B) / 2, "text-anchor": "middle", transform: `rotate(-90 14 ${(T + H - B) / 2})` }, sizeName));

  const line = (pts: [number, number][], cls: string) =>
    chart.append(svg("polyline", { class: cls, points: pts.map(([p, v]) => `${x(p)},${y(v)}`).join(" ") }));
  line(rows.map((r) => [r.P, r.bound]), "bound");
  const lit = rows.filter((r) => r.lit);
  line(lit.map((r) => [r.P, r.lit!.value]), "lit");
  for (const r of lit) {
    const m = svg("rect", { class: "lit-mark", x: x(r.P) - 4, y: y(r.lit!.value) - 4, width: 8, height: 8 });
    m.append(svg("title", {}, `P = ${r.P}: published ${r.lit!.display} (${STATUS[r.lit!.status]})`));
    chart.append(m);
  }
  for (const r of rows.filter((q) => q.site)) {
    // an entry that awaits review is a claim: hollow and dashed, and named as such
    const pending = r.site!.verification === "pending";
    const m = svg("circle", { class: pending ? "site-mark pending" : "site-mark", cx: x(r.P), cy: y(r.site!.score), r: 4 });
    const what = pending ? "entry pending verification" : "site best";
    m.append(svg("title", {}, `P = ${r.P}: ${what} ${r.site!.score.toFixed(6)} by ${r.site!.name}`));
    chart.append(m);
  }
  // legend
  const lx = L + 12;
  chart.append(svg("circle", { class: "site-mark", cx: lx, cy: 16, r: 4 }));
  chart.append(svg("text", { x: lx + 10, y: 20 }, "site best"));
  chart.append(svg("rect", { class: "lit-mark", x: lx + 86, y: 12, width: 8, height: 8 }));
  chart.append(svg("text", { x: lx + 100, y: 20 }, "published"));
  chart.append(svg("line", { class: "bound", x1: lx + 176, x2: lx + 204, y1: 16, y2: 16 }));
  chart.append(svg("text", { x: lx + 210, y: 20 }, "area lower bound"));
  if (rows.some((r) => r.site?.verification === "pending")) {
    chart.append(svg("circle", { class: "site-mark pending", cx: lx + 340, cy: 16, r: 4 }));
    chart.append(svg("text", { x: lx + 350, y: 20 }, "pending verification"));
  }
}

/** Under the atlas: whose published values and coordinates the tiles of this problem show. */
function creditSources(rows: Row[]): void {
  const line = $("atlas-sources");
  const used = new Set(rows.flatMap((r) => (r.lit ? Object.values(recordSources(r.lit)).flat() : [])));
  const sources = SOURCES.filter((s) => used.has(s.n));
  line.hidden = !sources.length;
  line.replaceChildren();
  if (!sources.length) return;
  line.append("Published records compiled by ");
  sources.forEach((s, i) => {
    if (i) line.append(i === sources.length - 1 ? " and " : ", ");
    line.append(s.author, sourceMarks([s.n])!);
  });
  line.append(", used with attribution.");
}

async function refresh(): Promise<void> {
  const N = Number(nSel.value);
  const M = Number(mSel.value);
  const data = await api.getRecords(N, M);
  // the selection changed while the answer was on its way; the newer request draws the page
  if (N !== Number(nSel.value) || M !== Number(mSel.value)) return;
  const tbody = $("rows");
  tbody.replaceChildren();
  if (!data) {
    $("note").textContent = "The server is not reachable.";
    drawChart([], "");
    creditSources([]);
    atlas.unavailable(N, M);
    followView(atlas.view, "replace");
    return;
  }
  const byP = new Map<number, Row>();
  const row = (P: number) => byP.get(P) ?? byP.set(P, { P, bound: areaLowerBound(N, M, P) }).get(P)!;
  for (const l of data.literature) row(l.P).lit = l;
  for (const s of data.site) row(s.P).site = s;
  // where the best entry awaits review, the best reviewed one stands for the site in the atlas
  for (const s of data.site_verified ?? []) row(s.P).verified = s;
  const rows = [...byP.values()].sort((a, b) => a.P - b.P);
  const sizeName = M === 0 ? "container radius r" : "container side s";
  $("note").textContent = rows.length
    ? `${rows.length} values of P for ${shapeLabel(N)}s in a ${shapeLabel(M)}. Sizes are the ${sizeName}, for pieces of ${N === 0 ? "radius" : "side"} 1.`
    : `No published values or site entries yet for ${shapeLabel(N)}s in a ${shapeLabel(M)}.`;
  $("chart-title").textContent = rows.length ? `Smallest known ${sizeName} against the number of pieces P.` : "";
  drawChart(rows, sizeName);
  creditSources(rows);
  atlas.update(N, M, rows);
  followView(atlas.view, "replace");
  for (const r of rows) {
    const tr = el("tr");
    if (r.site?.verification === "pending") tr.className = "pending";
    tr.append(el("td", String(r.P)));
    tr.append(el("td", r.site ? r.site.score.toFixed(6) + (r.site.verification === "pending" ? " ⚑ pending verification" : "") : "—"));
    tr.append(el("td", r.site ? `${r.site.name} (${r.site.agent === "ai" ? "AI" : "human"})` : "—"));
    const pub = el("td");
    if (r.lit) {
      // an address from the data is followed only when it is http(s) or a path of this site
      const href = safeHref(r.lit.source_url);
      const a = el(href ? "a" : "span", r.lit.display);
      if (href && a instanceof HTMLAnchorElement) {
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
      }
      a.title = `${r.lit.source_name}, read ${r.lit.accessed}`;
      pub.append(a, sourceMarks(recordSources(r.lit).value) ?? "");
    } else pub.textContent = "—";
    tr.append(pub);
    tr.append(el("td", r.lit ? STATUS[r.lit.status] : "—"));
    tr.append(el("td", r.bound.toFixed(6)));
    const open = el("td");
    const link = el("a", "open");
    link.href = `/#p=${N},${M},${r.P}`;
    link.setAttribute("aria-label", `Open P = ${r.P} on the board`);
    open.append(link);
    tr.append(open);
    tbody.append(tr);
  }
}

// Back and Forward: the address leads. A detail panel opens or closes, and a hash typed by hand selects its problem.
window.addEventListener("popstate", async () => {
  const before = `${nSel.value},${mSel.value}`;
  const valid = selectFromHash();
  if (before !== `${nSel.value},${mSel.value}`) await refresh();
  atlas.showPanel(valid ? parseView(location.search).p : null);
});
nSel.addEventListener("change", refresh);
mSel.addEventListener("change", refresh);
const isLive = api.subscribe(
  (e) => {
    if (e.N === Number(nSel.value) && e.M === Number(mSel.value)) refresh();
  },
  () => refresh(),
);
setInterval(() => $("live").classList.toggle("on", isLive()), 1500);
refresh();
