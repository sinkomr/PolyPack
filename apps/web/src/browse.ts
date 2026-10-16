import { areaLowerBound } from "@polypack/geometry";
import * as api from "./api";
import { Atlas } from "./atlas";
import { foundWithLabel } from "./found-with";
import { AtlasRow, AtlasView, parseView, safeHref, verifiedEntry, viewQuery } from "./atlas-model";
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

/** The charts are optional: a closed section draws nothing, and whether it is open is remembered. */
const PLOT_KEY = "polypack.charts";
const plot = $<HTMLDetailsElement>("plot");
try {
  plot.open = localStorage.getItem(PLOT_KEY) === "open";
} catch {
  // storage may be unavailable; the charts then start closed
}

/**
 * Against P: the record of each P (the smaller of the published value and the best entry not
 * awaiting review) as a line, published values and site bests as marks, and the area bound.
 * "size" plots container sizes; "gap" plots each size minus the area bound of its P, so that the
 * bound is the zero line and the height of a mark is how far it stands from the bound.
 */
function drawChart(chart: HTMLElement, rows: Row[], sizeName: string, mode: "size" | "gap"): void {
  chart.replaceChildren();
  if (!rows.length) return;
  const bound = new Map(rows.map((r) => [r.P, r.bound]));
  const val = (P: number, size: number) => (mode === "size" ? size : size - bound.get(P)!);
  const record = (r: Row): number | undefined => {
    const site = verifiedEntry(r)?.score;
    const lit = r.lit?.value;
    return site === undefined ? lit : lit === undefined ? site : Math.min(site, lit);
  };
  const W = 900,
    H = 380,
    L = 56,
    R = 16,
    T = 34,
    B = 42;
  const pMin = rows[0].P;
  const pMax = Math.max(rows[rows.length - 1].P, pMin + 1);
  const values = rows.flatMap((r) =>
    [r.bound, r.site?.score, r.lit?.value].filter((v): v is number => v !== undefined).map((v) => val(r.P, v)),
  );
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = (hi - lo || 1) * 0.04;
  const yMin = mode === "size" ? lo * 0.97 : lo - pad;
  const yMax = mode === "size" ? hi * 1.03 : hi + pad;
  const x = (p: number) => L + ((p - pMin) / (pMax - pMin)) * (W - L - R);
  const y = (v: number) => H - B - ((v - yMin) / (yMax - yMin)) * (H - T - B);
  const digits = mode === "gap" && yMax - yMin < 0.4 ? 3 : 2;
  // many points: smaller marks, so that the record line stays readable
  const dot = rows.length > 120 ? 2 : 4;

  for (let i = 0; i <= 4; i++) {
    const v = yMin + ((yMax - yMin) * i) / 4;
    chart.append(svg("line", { class: "gridline", x1: L, x2: W - R, y1: y(v), y2: y(v) }));
    chart.append(svg("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end" }, v.toFixed(digits)));
  }
  const every = Math.max(1, Math.ceil(rows.length / 20));
  rows.forEach((r, i) => {
    if (i % every === 0) chart.append(svg("text", { x: x(r.P), y: H - B + 16, "text-anchor": "middle" }, String(r.P)));
  });
  chart.append(svg("line", { class: "axis", x1: L, x2: W - R, y1: H - B, y2: H - B }));
  chart.append(svg("line", { class: "axis", x1: L, x2: L, y1: T, y2: H - B }));
  chart.append(svg("text", { x: (L + W - R) / 2, y: H - 6, "text-anchor": "middle" }, "P (number of pieces)"));
  const yName = mode === "size" ? sizeName : `${sizeName} minus area bound`;
  chart.append(
    svg(
      "text",
      { x: 14, y: (T + H - B) / 2, "text-anchor": "middle", transform: `rotate(-90 14 ${(T + H - B) / 2})` },
      yName,
    ),
  );

  const line = (pts: [number, number][], cls: string) =>
    chart.append(svg("polyline", { class: cls, points: pts.map(([p, v]) => `${x(p)},${y(val(p, v))}`).join(" ") }));
  line(
    rows.map((r) => [r.P, r.bound]),
    "bound",
  );
  line(
    rows.flatMap((r): [number, number][] => (record(r) === undefined ? [] : [[r.P, record(r)!]])),
    "record",
  );
  const tip = (P: number, size: number) =>
    mode === "size" ? size.toFixed(6) : `${size.toFixed(6)}, ${(size - bound.get(P)!).toFixed(6)} above the area bound`;
  for (const r of rows.filter((q) => q.lit)) {
    const v = y(val(r.P, r.lit!.value));
    const m = svg("rect", { class: "lit-mark", x: x(r.P) - dot, y: v - dot, width: 2 * dot, height: 2 * dot });
    m.append(svg("title", {}, `P = ${r.P}: published ${tip(r.P, r.lit!.value)} (${STATUS[r.lit!.status]})`));
    chart.append(m);
  }
  for (const r of rows.filter((q) => q.site)) {
    // an entry that awaits review is a claim: hollow and dashed, and named as such
    const pending = r.site!.verification === "pending";
    const m = svg("circle", {
      class: pending ? "site-mark pending" : "site-mark",
      cx: x(r.P),
      cy: y(val(r.P, r.site!.score)),
      r: dot,
    });
    const what = pending ? "entry pending verification" : "site best";
    m.append(svg("title", {}, `P = ${r.P}: ${what} ${tip(r.P, r.site!.score)} by ${r.site!.name}`));
    chart.append(m);
  }
  // legend
  const lx = L + 12;
  chart.append(svg("line", { class: "record", x1: lx - 4, x2: lx + 20, y1: 16, y2: 16 }));
  chart.append(svg("text", { x: lx + 26, y: 20 }, "record"));
  chart.append(svg("circle", { class: "site-mark", cx: lx + 90, cy: 16, r: 4 }));
  chart.append(svg("text", { x: lx + 100, y: 20 }, "site best"));
  chart.append(svg("rect", { class: "lit-mark", x: lx + 172, y: 12, width: 8, height: 8 }));
  chart.append(svg("text", { x: lx + 186, y: 20 }, "published"));
  chart.append(svg("line", { class: "bound", x1: lx + 264, x2: lx + 292, y1: 16, y2: 16 }));
  chart.append(svg("text", { x: lx + 298, y: 20 }, mode === "size" ? "area bound" : "area bound (zero)"));
  if (rows.some((r) => r.site?.verification === "pending")) {
    chart.append(svg("circle", { class: "site-mark pending", cx: lx + 430, cy: 16, r: 4 }));
    chart.append(svg("text", { x: lx + 440, y: 20 }, "pending verification"));
  }
}

/** What the charts show; they are drawn only while their section is open. */
let charted: { rows: Row[]; sizeName: string } = { rows: [], sizeName: "" };
function drawCharts(): void {
  const { rows, sizeName } = charted;
  const shown = plot.open && rows.length > 0;
  $("chart-title").textContent = shown
    ? `The record ${sizeName} for each number of pieces P against the area bound, the size at which the pieces would fill the container exactly. No packing can be smaller.`
    : "";
  $("chart-gap-title").textContent = shown
    ? `How far each value stands above the area bound: the record ${sizeName} minus the bound, for each P.`
    : "";
  drawChart($("chart"), shown ? rows : [], sizeName, "size");
  drawChart($("chart-gap"), shown ? rows : [], sizeName, "gap");
}
plot.addEventListener("toggle", () => {
  try {
    localStorage.setItem(PLOT_KEY, plot.open ? "open" : "closed");
  } catch {
    // the choice is then not remembered
  }
  drawCharts();
});

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
    charted = { rows: [], sizeName: "" };
    drawCharts();
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
  charted = { rows, sizeName };
  drawCharts();
  creditSources(rows);
  atlas.update(N, M, rows);
  followView(atlas.view, "replace");
  for (const r of rows) {
    const tr = el("tr");
    if (r.site?.verification === "pending") tr.className = "pending";
    tr.append(el("td", String(r.P)));
    tr.append(
      el(
        "td",
        r.site ? r.site.score.toFixed(6) + (r.site.verification === "pending" ? " ⚑ pending verification" : "") : "—",
      ),
    );
    const found = foundWithLabel(r.site?.found_with);
    tr.append(el("td", r.site ? (found ? `${r.site.name} (${found})` : r.site.name) : "—"));
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
