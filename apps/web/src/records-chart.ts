import { ChartMode, ChartPoint, chartScale, pTicks, plotted, pointLines } from "./records-model";
import { el } from "./shapes-ui";

/**
 * The charts of the Records page for the dimensions other than the classic board, drawn like the
 * Atlas page's: the record of one problem family against P as a line, the research records and the
 * site's leading entries as marks, and the lower bound dashed. "size" plots scores; "gap" plots each
 * score minus its bound, so that the bound is the zero line.
 */

const SVG = "http://www.w3.org/2000/svg";
function svg(tag: string, attrs: Record<string, string | number>, text = ""): SVGElement {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text) e.textContent = text;
  return e;
}

const W = 900,
  H = 380,
  L = 56,
  R = 16,
  T = 34,
  B = 42;

export interface ChartInput {
  points: ChartPoint[];
  /** The range of P the axis spans before any zoom: the family's domain, else its points. */
  pRange: [number, number];
  /** What the vertical axis names, e.g. "sphere radius ρ". */
  scoreName: string;
  /** The family in a few words, for the box that describes a point. */
  title: string;
  mode: ChartMode;
  /** What to say inside a chart with nothing to plot. */
  empty: string;
}

/** The box that describes a hovered point: one per chart, in the chart's figure. */
function tipOf(chart: Element): HTMLElement {
  const figure = chart.parentElement!;
  let tip = figure.querySelector<HTMLElement>(".chart-tip");
  if (!tip) {
    tip = el("div", "", "chart-tip");
    tip.setAttribute("role", "status");
    tip.hidden = true;
    figure.append(tip);
  }
  return tip;
}

/**
 * Draws one chart into `chart`. A drag across the plot, + and − (with 0 to reset) and a double
 * click ask `onZoom` for a range of P, as on the Atlas page; the arrow keys and Home and End pick
 * a point from the keyboard.
 */
export function drawRecordsChart(
  chart: SVGSVGElement,
  input: ChartInput,
  onZoom: (from: number | null, to?: number, keep?: number) => void,
  keep?: number,
): void {
  const { points, mode, scoreName } = input;
  chart.replaceChildren();
  const tipBox = tipOf(chart);
  tipBox.hidden = true;
  const [pMin, pMaxRaw] = input.pRange;
  const pMax = Math.max(pMaxRaw, pMin + 1);
  const scale = chartScale(points, mode);
  const x = (p: number) => L + ((p - pMin) / (pMax - pMin)) * (W - L - R);

  chart.append(svg("line", { class: "axis", x1: L, x2: W - R, y1: H - B, y2: H - B }));
  chart.append(svg("line", { class: "axis", x1: L, x2: L, y1: T, y2: H - B }));
  for (const p of pTicks(pMin, pMax))
    chart.append(svg("text", { x: x(p), y: H - B + 16, "text-anchor": "middle" }, String(p)));
  chart.append(svg("text", { x: (L + W - R) / 2, y: H - 6, "text-anchor": "middle" }, "P (number of pieces)"));
  if (!scale) {
    chart.append(svg("text", { x: (L + W - R) / 2, y: (T + H - B) / 2, "text-anchor": "middle" }, input.empty));
    chart.onpointerdown = chart.onpointermove = chart.onpointerup = chart.ondblclick = chart.onkeydown = null;
    chart.removeAttribute("tabindex");
    return;
  }
  const { yMin, yMax, digits } = scale;
  const y = (v: number) => H - B - ((v - yMin) / (yMax - yMin)) * (H - T - B);
  for (let i = 0; i <= 4; i++) {
    const v = yMin + ((yMax - yMin) * i) / 4;
    chart.append(svg("line", { class: "gridline", x1: L, x2: W - R, y1: y(v), y2: y(v) }));
    chart.append(svg("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end" }, v.toFixed(digits)));
  }
  const yName = mode === "size" ? scoreName : `${scoreName} minus lower bound`;
  chart.append(
    svg(
      "text",
      { x: 14, y: (T + H - B) / 2, "text-anchor": "middle", transform: `rotate(-90 14 ${(T + H - B) / 2})` },
      yName,
    ),
  );

  // a run of P without a value breaks the line, rather than drawing a value nobody has
  const line = (pts: [number, number | null][], cls: string) => {
    let run: [number, number][] = [];
    const flush = () => {
      if (run.length > 1)
        chart.append(svg("polyline", { class: cls, points: run.map(([p, v]) => `${x(p)},${y(v)}`).join(" ") }));
      run = [];
    };
    for (const [p, v] of pts) {
      if (v === null || (run.length && p !== run[run.length - 1][0] + 1)) flush();
      if (v !== null) run.push([p, v]);
    }
    flush();
  };
  line(
    points.map((p) => [p.P, p.bound === null ? null : plotted(mode, p.bound, p)]),
    "bound",
  );
  line(
    points.map((p) => [p.P, p.record === null ? null : plotted(mode, p.record, p)]),
    "record",
  );
  // many points: smaller marks, so that the record line stays readable
  const dot = points.length > 60 ? 2.5 : 4;
  for (const p of points) {
    if (p.certified) {
      const v = plotted(mode, p.certified.score, p);
      if (v !== null) {
        // proven optimal: filled; best known: hollow
        const cls = p.certified.status === "proven" ? "proven-mark" : "lit-mark";
        chart.append(svg("rect", { class: cls, x: x(p.P) - dot, y: y(v) - dot, width: 2 * dot, height: 2 * dot }));
      }
    }
    if (p.site) {
      const v = plotted(mode, p.site.score, p);
      if (v !== null) chart.append(svg("circle", { class: "site-mark", cx: x(p.P), cy: y(v), r: dot }));
    }
  }

  // legend: only what the chart shows
  let lx = L + 12;
  const entry = (mark: SVGElement, label: string, width: number) => {
    chart.append(mark, svg("text", { x: lx + 26, y: 20 }, label));
    lx += width;
  };
  entry(svg("line", { class: "record", x1: lx - 4, x2: lx + 20, y1: 16, y2: 16 }), "record", 90);
  if (points.some((p) => p.certified?.status === "best_known"))
    entry(svg("rect", { class: "lit-mark", x: lx + 8, y: 12, width: 8, height: 8 }), "best known", 110);
  if (points.some((p) => p.certified?.status === "proven"))
    entry(svg("rect", { class: "proven-mark", x: lx + 8, y: 12, width: 8, height: 8 }), "proven", 90);
  if (points.some((p) => p.site))
    entry(svg("circle", { class: "site-mark", cx: lx + 12, cy: 16, r: 4 }), "site best", 100);
  if (points.some((p) => p.bound !== null))
    entry(
      svg("line", { class: "bound", x1: lx - 4, x2: lx + 20, y1: 16, y2: 16 }),
      mode === "size" ? "lower bound" : "lower bound (zero)",
      150,
    );

  // Hover: the P nearest the pointer is picked (marks are too small to aim at), marked with a
  // guide line and a dot on its record, and described in a box beside it.
  const guide = svg("line", { class: "hover-line", y1: T, y2: H - B });
  const spot = svg("circle", { class: "hover-dot", r: 5 });
  const hover = svg("g", { class: "hover", visibility: "hidden" });
  hover.append(guide, spot);
  chart.append(hover);
  let at = -1;
  const show = (i: number) => {
    at = Math.max(0, Math.min(points.length - 1, i));
    const p = points[at];
    const px = x(p.P);
    const v = (p.record === null ? null : plotted(mode, p.record, p)) ?? yMin;
    const py = y(v);
    guide.setAttribute("x1", String(px));
    guide.setAttribute("x2", String(px));
    spot.setAttribute("cx", String(px));
    spot.setAttribute("cy", String(py));
    hover.setAttribute("visibility", "visible");
    const { head, lines } = pointLines(input.title, p);
    const headRow = el("div", head, "tip-head");
    tipBox.replaceChildren(
      headRow,
      ...lines.map(([k, t]) => {
        const row = el("div");
        row.append(el("span", k), " ", t);
        return row;
      }),
    );
    tipBox.hidden = false;
    // placed beside the point, on whichever side has room, in the figure's own pixels
    const box = chart.getBoundingClientRect();
    const k = box.width / W;
    const left = px * k;
    const right = left > box.width / 2;
    tipBox.style.left = right ? "" : `${left + 12}px`;
    tipBox.style.right = right ? `${box.width - left + 12}px` : "";
    tipBox.style.top = `${Math.max(0, Math.min(py * k - 20, box.height - tipBox.offsetHeight))}px`;
  };
  const hide = () => {
    hover.setAttribute("visibility", "hidden");
    tipBox.hidden = true;
  };

  // Zoom: a drag across the plot selects a range of P, shown by a band while dragging.
  const band = svg("rect", { class: "zoom-band", y: T, height: H - B - T, width: 0, visibility: "hidden" });
  chart.append(band);
  const toView = (e: PointerEvent) => {
    const box = chart.getBoundingClientRect();
    return ((e.clientX - box.left) / box.width) * W;
  };
  const pAt = (vx: number) => pMin + ((Math.max(L, Math.min(W - R, vx)) - L) / (W - L - R)) * (pMax - pMin);
  let dragFrom: number | null = null;
  chart.onpointerdown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const vx = toView(e);
    if (vx < L || vx > W - R) return;
    dragFrom = vx;
    chart.setPointerCapture(e.pointerId);
  };
  chart.onpointerup = (e: PointerEvent) => {
    if (dragFrom === null) return;
    const from = dragFrom;
    dragFrom = null;
    band.setAttribute("visibility", "hidden");
    const to = toView(e);
    // a click, or a drag too short to mean a range, is not a zoom
    if (Math.abs(to - from) < 8) return;
    onZoom(Math.floor(pAt(Math.min(from, to))), Math.ceil(pAt(Math.max(from, to))));
  };
  chart.ondblclick = () => onZoom(null);
  chart.onpointermove = (e: PointerEvent) => {
    const vx = toView(e);
    if (dragFrom !== null) {
      const lo = Math.max(L, Math.min(dragFrom, vx));
      const hi = Math.min(W - R, Math.max(dragFrom, vx));
      band.setAttribute("x", String(lo));
      band.setAttribute("width", String(hi - lo));
      band.setAttribute("visibility", "visible");
    }
    if (vx < L - 8 || vx > W - R + 8) return hide();
    const p = pAt(vx);
    // points are sorted by P: the nearest is beside the first one at or above p
    let i = points.findIndex((q) => q.P >= p);
    if (i < 0) i = points.length - 1;
    else if (i > 0 && p - points[i - 1].P < points[i].P - p) i--;
    show(i);
  };
  chart.onpointerleave = () => {
    if (dragFrom === null) hide();
  };
  chart.onblur = hide;
  chart.tabIndex = 0;
  chart.onkeydown = (e: KeyboardEvent) => {
    // + and - halve or double the range around the chosen point (the middle when none); 0 resets
    if (e.key === "+" || e.key === "=" || e.key === "-" || e.key === "_") {
      e.preventDefault();
      const centre = at >= 0 ? points[at].P : (pMin + pMax) / 2;
      const half = ((pMax - pMin) / 2) * (e.key === "+" || e.key === "=" ? 0.5 : 2);
      onZoom(Math.floor(centre - half), Math.ceil(centre + half), at >= 0 ? points[at].P : undefined);
      return;
    }
    if (e.key === "0") {
      e.preventDefault();
      onZoom(null);
      return;
    }
    const step = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    show(Number.isFinite(step) ? (at < 0 ? 0 : at + step) : step < 0 ? 0 : points.length - 1);
  };
  if (keep !== undefined) {
    const i = points.findIndex((q) => q.P === keep);
    if (i >= 0) show(i);
  }
}
