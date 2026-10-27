import { AtlasResponse, AtlasTile, LeaderboardEntry, RecordStatus } from "@polypack/geometry";
import { foundWithLabel } from "./found-with";
import {
  AtlasRow,
  AtlasView,
  Drawable,
  Drawing,
  FIRST_TILES,
  LAYOUTS,
  Outline,
  SCALES,
  SITE_TEXT,
  SIZES,
  STATUS_TEXT,
  TileStatus,
  TiltClass,
  chooseDrawable,
  containerOutline,
  drawPacking,
  drawableKey,
  layoutSize,
  normalizeView,
  pendingEntry,
  safeHref,
  sizeRow,
  tileKey,
  tileLabel,
  tileStatus,
  tiltLegend,
  tiltName,
  verifiedEntry,
} from "./atlas-model";
import { el, shapeLabel } from "./shapes-ui";
import { SOURCES, recordCredits, recordSources, sourceLabel, sourceMarks } from "./sources";

/**
 * The records atlas: a wall of small drawings, one per P, with a detail dialog. This file is the
 * DOM half; the decisions and the geometry are in atlas-model.ts. Everything is built with the
 * DOM API and names from the server only ever enter as text.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

// ---------- status marks ----------

type MarkName = RecordStatus | "site" | "pending";

/** A five-pointed star in a 12 by 12 box. */
const STAR =
  Array.from({ length: 10 }, (_, i) => {
    const r = i % 2 ? 2.2 : 5.4;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    return `${i ? "L" : "M"}${(6 + r * Math.cos(a)).toFixed(2)} ${(6.4 + r * Math.sin(a)).toFixed(2)}`;
  }).join("") + "Z";

/** Small shapes that tell the statuses apart without colour. "best_known" has no mark. */
const MARKS: Record<MarkName, { cls: "solid" | "line" | "cut"; d: string }[]> = {
  proven: [
    { cls: "solid", d: "M6 .6a5.4 5.4 0 1 0 0 10.8A5.4 5.4 0 0 0 6 .6Z" },
    { cls: "cut", d: "M3.3 6.2l1.9 1.9 3.6-4" },
  ],
  proven_unrefereed: [
    { cls: "line", d: "M6 1.1a4.9 4.9 0 1 0 0 9.8A4.9 4.9 0 0 0 6 1.1Z" },
    { cls: "line", d: "M3.6 6.2l1.7 1.7 3.2-3.6" },
  ],
  trivial_tiling: [{ cls: "solid", d: "M1 1h4.4v4.4H1zM6.6 1H11v4.4H6.6zM1 6.6h4.4V11H1zM6.6 6.6H11V11H6.6z" }],
  best_known: [],
  site: [{ cls: "solid", d: STAR }],
  pending: [
    { cls: "line", d: "M2.4 .8v10.6" },
    { cls: "solid", d: "M2.4 1.4h7.8L8 4.1l2.2 2.7H2.4z" },
  ],
};

function mark(name: MarkName): SVGSVGElement {
  const s = svg("svg", { viewBox: "0 0 12 12", class: `mark mark-${name}`, "aria-hidden": "true", focusable: "false" });
  for (const part of MARKS[name]) s.append(svg("path", { class: part.cls, d: part.d }));
  return s;
}

/** The marks of one tile, in a fixed order. */
function marksOf(st: TileStatus): MarkName[] {
  const names: MarkName[] = [];
  if (st.published && st.published !== "best_known") names.push(st.published);
  if (st.site === "beats" || st.site === "matches" || st.site === "only") names.push("site");
  if (st.pending) names.push("pending");
  return names;
}

// ---------- drawings ----------

function outlineNode(o: Outline, cls: string): SVGElement {
  return o.circle !== undefined
    ? svg("circle", { class: cls, cx: 0, cy: 0, r: o.circle })
    : svg("polygon", { class: cls, points: o.points! });
}

let textureCount = 0;

/**
 * The fill classes are told apart by more than hue: corner-on pieces carry diagonal stripes and
 * pieces at other angles a grid of dots. Each drawing gets its own patterns, sized against its
 * extent so that the texture has about the same grain on screen whatever the number of pieces.
 * Returns the fill reference for the overlay of a class.
 */
function textures(
  parent: SVGElement,
  extent: number,
  classes: readonly TiltClass[],
): Partial<Record<TiltClass, string>> {
  const fills: Partial<Record<TiltClass, string>> = {};
  const wanted = classes.filter((c) => c !== 0);
  if (!wanted.length) return fills;
  const step = +Math.min(0.5, Math.max(0.12, extent * 0.045)).toFixed(4);
  const defs = svg("defs");
  for (const cls of wanted) {
    const id = `atlas-texture-${++textureCount}`;
    const pattern = svg("pattern", { id, patternUnits: "userSpaceOnUse", width: step, height: step });
    if (cls === 1) {
      pattern.setAttribute("patternTransform", "rotate(45)");
      pattern.append(svg("rect", { class: "ink", x: 0, y: 0, width: +(step * 0.36).toFixed(4), height: step }));
    } else {
      pattern.append(svg("circle", { class: "ink", cx: step / 2, cy: step / 2, r: +(step * 0.25).toFixed(4) }));
    }
    defs.append(pattern);
    fills[cls] = `url(#${id})`;
  }
  parent.append(defs);
  return fills;
}

/** An SVG of a packing, or of the bare container when there are no coordinates to draw. */
function drawingNode(d: Drawing | Outline): SVGSVGElement {
  const [x, y, w, h] = d.box;
  const extent = Math.max(w, h);
  // room for the container's stroke
  const pad = extent * 0.02;
  const s = svg("svg", {
    viewBox: [x - pad, y - pad, w + 2 * pad, h + 2 * pad].map((v) => +v.toFixed(4)).join(" "),
    "aria-hidden": "true",
    focusable: "false",
  });
  // the stylesheet turns this into a stroke width that thins out as the pieces get smaller
  s.style.setProperty("--extent", String(+extent.toFixed(3)));
  s.style.aspectRatio = `${+w.toFixed(4)} / ${+h.toFixed(4)}`;
  // the outline goes on top: pieces that touch the container would otherwise cover half of it
  s.append(outlineNode(d, "floor"));
  if ("paths" in d) {
    const fills = textures(
      s,
      extent,
      d.paths.map((p) => p.cls),
    );
    for (const p of d.paths) {
      s.append(svg("path", { class: `piece tilt-${p.cls}`, d: p.d }));
      const fill = fills[p.cls];
      if (fill) s.append(svg("path", { class: "texture", d: p.d, fill }));
    }
  }
  s.append(outlineNode(d, "container"));
  return s;
}

/** A legend swatch drawn the way the pieces are: fill colour plus the texture of the class. */
function swatch(cls: TiltClass): SVGSVGElement {
  const s = svg("svg", { viewBox: "0 0 1 1", class: "swatch", "aria-hidden": "true", focusable: "false" });
  const fill = textures(s, 5, [cls])[cls];
  s.append(svg("rect", { class: `tilt-${cls}`, x: 0, y: 0, width: 1, height: 1 }));
  if (fill) s.append(svg("rect", { class: "texture", x: 0, y: 0, width: 1, height: 1, fill }));
  return s;
}

const plural = (n: number) => `${shapeLabel(n)}s`;
const withArticle = (n: number) =>
  `${/^(8|11|18)/.test(shapeLabel(n)) || shapeLabel(n) === "octagon" ? "an" : "a"} ${shapeLabel(n)}`;
/** "circles in a square" */
export const familyName = (N: number, M: number) => `${plural(N)} in ${withArticle(M)}`;

// ---------- the atlas ----------

/** Id prefix of the credit lines in the detail panel; the reference marks of the panel point to them. */
const CREDIT_ID = "detail-source-";

interface Tile {
  P: number;
  row: AtlasRow;
  status: TileStatus;
  drawable: Drawable;
  /** Identity of the drawing; the coordinates are fetched again when it changes. */
  key: string;
  /** Everything the caption and the detail panel show, to skip untouched tiles on a refresh. */
  signature: string;
  /** Size that places the tile (row, true scale): the smallest known value, never a pending claim. */
  layout: number;
  /** Size of what is drawn; larger than `layout` for a verified entry that is not the record. */
  size: number;
  /** undefined: not fetched (or released). null: the server has nothing to draw. */
  data: AtlasTile | null | undefined;
  /** Near the viewport, where drawings are kept in the page. */
  near: boolean;
  /** The drawing is in the page at the moment. */
  drawn: boolean;
  /** Id of the request that is fetching this tile, 0 when none is. */
  loading: number;
  /** `key` when that request was sent; an answer for another key is out of date. */
  requestKey: string;
  /** Failed requests in a row, and the time before which the next one waits. */
  attempts: number;
  retryAt: number;
  /** The retries are used up; the tile says so until something asks again. */
  error: boolean;
  /** Answers that disagreed with the listing about what to draw. */
  mismatches: number;
  item: HTMLLIElement;
  link: HTMLAnchorElement;
  art: HTMLElement;
  cap: HTMLElement;
  score: HTMLElement;
}

export interface AtlasOptions {
  root: HTMLElement;
  dialog: HTMLDialogElement;
  view: AtlasView;
  fetchTiles: (N: number, M: number, from: number, to: number) => Promise<AtlasResponse | null>;
  /**
   * Called after every change of the display state, to keep the address in step.
   * "push": a detail panel was opened and Back should close it. "close": the panel was closed by
   * the visitor. "replace": anything else.
   */
  onView: (view: AtlasView, how: "push" | "replace" | "close") => void;
  /** Address that opens the atlas with the detail panel of P. */
  tileHref: (view: AtlasView) => string;
  /** Asks for the records listing again, when an answer shows that it is out of date. */
  refresh: () => void;
}

/** Values of P asked for in one request; the server may answer with fewer and a `next`. */
const CHUNK = 30;
/** Requests under way at once. */
const PARALLEL = 2;
/** A failed request is repeated this many times, after 0.4 s, 0.8 s and 1.6 s. */
const RETRIES = 3;
const BACKOFF_MS = 400;
/** Pieces kept in memory for tiles away from the viewport; beyond it their coordinates are released. */
const HELD_PIECES = 40_000;

export class Atlas {
  view: AtlasView;
  private N = -1;
  private M = -1;
  private tiles = new Map<number, Tile>();
  /** P in display order, and the part of it that is shown. */
  private order: number[] = [];
  private shown: number[] = [];
  private arrangement = "";
  private generation = 0;
  private requests = 0;
  private requestId = 0;
  private timer = 0;
  private timerAt = Infinity;
  private held = 0;
  private offline = false;
  private detailShown = "";
  private observer: IntersectionObserver | null;
  private deepLink: number | null;
  private readonly box: HTMLElement;
  private readonly more: HTMLButtonElement;
  private readonly form: HTMLFormElement;
  private readonly legendBox: HTMLElement;

  constructor(private opts: AtlasOptions) {
    const q = <T extends HTMLElement>(sel: string) => opts.root.querySelector(sel) as T;
    this.view = normalizeView(opts.view);
    this.deepLink = this.view.p;
    this.box = q("#atlas-tiles");
    this.more = q<HTMLButtonElement>("#atlas-more");
    this.form = q<HTMLFormElement>("#atlas-controls");
    this.legendBox = q("#atlas-legend");

    this.observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver((entries) => this.onIntersect(entries), { rootMargin: "500px 0px" });

    this.form.addEventListener("change", () => {
      const data = new FormData(this.form);
      const pick = <T extends string>(options: readonly T[], name: string, now: T) =>
        options.includes(data.get(name) as T) ? (data.get(name) as T) : now;
      this.setView({
        ...this.view,
        size: pick(SIZES, "size", this.view.size),
        scale: pick(SCALES, "scale", this.view.scale),
        layout: pick(LAYOUTS, "layout", this.view.layout),
      });
    });
    this.form.addEventListener("submit", (e) => e.preventDefault());
    this.more.addEventListener("click", () => this.setView({ ...this.view, all: !this.view.all }));

    this.box.addEventListener("click", (e) => {
      const link = (e.target as Element).closest<HTMLAnchorElement>("a.tile");
      // modified clicks keep their meaning: the address opens the same panel in a new tab
      if (!link || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      this.open(Number(link.dataset.p), { push: true });
    });
    this.box.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const link = (e.target as Element).closest<HTMLAnchorElement>("a.tile");
      if (!link) return;
      const i = this.shown.indexOf(Number(link.dataset.p));
      const next = this.tiles.get(this.shown[i + (e.key === "ArrowRight" ? 1 : -1)]);
      if (next) {
        e.preventDefault();
        next.link.focus();
      }
    });

    const dialog = opts.dialog;
    dialog.querySelector("#detail-close")!.addEventListener("click", () => this.closePanel(false));
    // a click on the backdrop lands on the dialog element itself
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) this.closePanel(false);
    });
    // Esc closes the dialog without passing through closePanel
    dialog.addEventListener("close", () => this.panelClosed(false));
    this.applyView();
  }

  /** Changes the display state: tile size, drawing scale, layout, how many tiles are shown. */
  setView(view: AtlasView): void {
    this.view = normalizeView({ ...view, p: this.view.p });
    this.applyView();
    this.arrange();
    this.opts.onView(this.view, "replace");
  }

  private applyView(): void {
    const { root } = this.opts;
    root.dataset.size = this.view.size;
    root.dataset.scale = this.view.scale;
    root.dataset.layout = this.view.layout;
    for (const input of this.form.querySelectorAll<HTMLInputElement>("input[type=radio]")) {
      input.checked = this.view[input.name as "size" | "scale" | "layout"] === input.value;
      // the row scale compares the containers of one row, so it only exists in the rows layout
      if (input.name === "scale" && input.value === "row") {
        input.disabled = this.view.layout !== "rows";
        input.parentElement!.title = input.disabled ? "Available in the Rows layout" : "";
      }
    }
    this.setHrefs();
  }

  private setHrefs(): void {
    for (const t of this.tiles.values()) t.link.href = this.opts.tileHref({ ...this.view, p: t.P });
  }

  /** The server could not be reached: keep what is shown unless it belongs to another problem. */
  unavailable(N: number, M: number): void {
    this.offline = true;
    if (N !== this.N || M !== this.M) this.update(N, M, [], true);
    else this.renderLede();
  }

  /** Brings the tiles in line with the latest records. Tiles that did not change are left alone. */
  update(N: number, M: number, rows: readonly AtlasRow[], offline = false): void {
    this.offline = offline;
    if (N !== this.N || M !== this.M) {
      const first = this.N < 0;
      this.N = N;
      this.M = M;
      // answers of requests that are still under way belong to the old problem
      this.generation++;
      this.held = 0;
      this.observer?.disconnect();
      this.tiles.clear();
      this.box.replaceChildren();
      this.arrangement = "";
      if (!first) {
        // a panel of the previous problem makes no sense for the new one
        this.deepLink = null;
        this.closePanel(false);
      }
      this.opts.root.querySelector("#atlas-title")!.textContent = `The atlas of ${familyName(N, M)}`;
      this.opts.root.dataset.container = String(M);
    }
    const seen = new Set<number>();
    for (const row of rows) {
      const status = tileStatus(row);
      if (!status) continue;
      seen.add(row.P);
      const drawable = chooseDrawable(row);
      const key = drawableKey(drawable);
      const { site, lit } = row;
      const reviewed = verifiedEntry(row);
      const signature = JSON.stringify([
        site?.id,
        site?.score,
        site?.name,
        site?.found_with,
        site?.verification,
        reviewed?.id,
        reviewed?.score,
        reviewed?.name,
        lit?.value,
        lit?.status,
        key,
      ]);
      let tile = this.tiles.get(row.P);
      if (!tile) {
        tile = this.createTile(row, status, drawable);
        this.tiles.set(row.P, tile);
        this.observer?.observe(tile.item);
      }
      const redraw = tile.key !== key;
      Object.assign(tile, { row, status, drawable });
      tile.layout = layoutSize(row);
      // a verified entry that is not the record is drawn at its own, larger size; a pending one never sets the scale
      tile.size = drawable.kind === "site" && !drawable.record && !drawable.pending ? reviewed!.score : tile.layout;
      if (redraw) {
        // a request under way for the old drawing is recognised by its key and dropped when it answers
        tile.key = key;
        this.release(tile);
        tile.error = false;
        tile.attempts = 0;
        tile.retryAt = 0;
        tile.mismatches = 0;
      }
      // the listing came through, so a tile that had given up may try again
      if (tile.error && this.needed(tile)) this.retry(tile);
      if (tile.signature !== signature || redraw) {
        tile.signature = signature;
        this.renderCaption(tile);
        this.renderArt(tile);
      }
    }
    for (const [P, tile] of this.tiles) {
      if (seen.has(P)) continue;
      this.observer?.unobserve(tile.item);
      this.release(tile);
      tile.item.remove();
      this.tiles.delete(P);
    }
    this.order = [...this.tiles.keys()].sort((a, b) => a - b);
    this.arrange();
    this.renderLegend();
    this.setHrefs();
    this.renderLede();
    this.opts.root.classList.toggle("empty", !this.order.length);
    this.schedule();

    if (this.deepLink !== null) {
      const P = this.deepLink;
      this.deepLink = null;
      if (this.tiles.has(P)) this.open(P, { reveal: true });
      else {
        this.view = { ...this.view, p: null };
        this.opts.onView(this.view, "replace");
      }
    } else if (this.opts.dialog.open && this.view.p !== null) {
      const tile = this.tiles.get(this.view.p);
      if (tile) this.renderDetail(tile);
      else this.closePanel(false);
    }
  }

  private renderLede(): void {
    const lede = this.opts.root.querySelector("#atlas-lede")!;
    const drawable = [...this.tiles.values()].some((t) => t.key !== "none");
    lede.textContent = this.order.length
      ? drawable
        ? "One tile for each number of pieces P, drawn from the best packing this site has coordinates for. Select a tile for its values and source."
        : "One tile for each number of pieces P. No coordinates are on record for this family yet, so the tiles stay empty until an entry is submitted from the board. Select a tile for its values and source."
      : this.offline
        ? "The server is not reachable, so the atlas cannot be drawn. It appears as soon as the server answers."
        : `Nothing to show yet for ${familyName(this.N, this.M)}.`;
  }

  private createTile(row: AtlasRow, status: TileStatus, drawable: Drawable): Tile {
    const item = el("li", "", "tile-item");
    const link = el("a", "", "tile");
    link.dataset.p = String(row.P);
    const art = el("span", "", "tile-art");
    const cap = el("span", "", "tile-cap");
    const score = el("span", "", "tile-score");
    link.append(art, cap, score);
    item.append(link);
    return {
      P: row.P,
      row,
      status,
      drawable,
      // "" forces the first drawing
      key: "",
      signature: "",
      layout: 1,
      size: 1,
      data: undefined,
      near: !this.observer,
      drawn: false,
      loading: 0,
      requestKey: "",
      attempts: 0,
      retryAt: 0,
      error: false,
      mismatches: 0,
      item,
      link,
      art,
      cap,
      score,
    };
  }

  private renderCaption(t: Tile): void {
    const label = tileLabel(t.row, this.M) + (t.error ? ", the drawing could not be loaded" : "");
    t.link.setAttribute("aria-label", label);
    t.link.title = label;
    t.link.classList.toggle("proven", !!t.status.published && t.status.published !== "best_known");
    t.link.classList.toggle("pending", t.status.pending);
    t.cap.replaceChildren(el("span", String(t.P), "tile-p"), ...marksOf(t.status).map(mark));
    t.score.textContent = t.status.best === null ? "pending" : t.status.best.toFixed(6);
  }

  /** What the art box of a tile holds. `build` false leaves a loaded drawing out (tiles far from the viewport). */
  private artNodes(t: Tile, build: boolean): { nodes: Node[]; state: string; drawing: Drawing | null } {
    const outline = () => drawingNode(containerOutline(this.M, 1));
    const bare = (state: string, text = "") => ({
      nodes: text ? [outline(), el("span", text, "tile-empty")] : [outline()],
      state,
      drawing: null,
    });
    if (t.key === "none" || t.data === null) return bare("empty", "no coordinates");
    if (t.error) return bare("failed", "not loaded");
    if (t.data === undefined) return bare("loading");
    if (!build) return bare("parked");
    const drawing = drawPacking(this.N, this.M, t.data.pieces, t.data.container_phi);
    if (!drawing) return bare("empty", "no coordinates");
    // a site entry that is not the smallest known value is a drawing, not the record
    const site = t.data.source === "site";
    const pending = site && t.data.verification === "pending";
    const behind = site && !pending && t.status.site === "behind";
    return {
      // an unverified drawing says so on its face, not only in the caption
      nodes: pending ? [drawingNode(drawing), el("span", "pending", "tile-flag")] : [drawingNode(drawing)],
      state: `drawn${pending ? " not-record pending-drawing" : behind ? " not-record" : ""}`,
      drawing,
    };
  }

  private renderArt(t: Tile): void {
    const { nodes, state } = this.artNodes(t, t.near);
    t.drawn = state.startsWith("drawn");
    t.art.className = `tile-art ${state}`;
    t.art.replaceChildren(...nodes);
  }

  /** Puts the tiles into their groups and works out the true-scale factors. */
  private arrange(): void {
    const { layout, all } = this.view;
    const shown = all ? this.order : this.order.slice(0, FIRST_TILES);
    const rowOf = (P: number) => (layout === "rows" ? sizeRow(this.tiles.get(P)!.layout) : 0);
    const arrangement = JSON.stringify([layout, this.order.map((P) => [P, rowOf(P)]), shown.length]);
    if (arrangement !== this.arrangement) {
      this.arrangement = arrangement;
      this.shown = shown;
      // moving a focused node drops the focus, so it is put back afterwards
      const focused =
        document.activeElement instanceof HTMLElement && this.box.contains(document.activeElement)
          ? document.activeElement
          : null;
      const groups = new Map<number, HTMLUListElement>();
      const sections: HTMLElement[] = [];
      const limit = new Set(shown);
      for (const P of this.order) {
        const t = this.tiles.get(P)!;
        const k = rowOf(P);
        let list = groups.get(k);
        if (!list) {
          const section = el("div", "", "tile-group");
          if (layout === "rows") section.append(el("span", `${this.M === 0 ? "d" : "s"} ≤ ${k}`, "group-label"));
          list = el("ul", "", "tile-list");
          section.append(list);
          section.hidden = true;
          groups.set(k, list);
          sections.push(section);
        }
        t.item.hidden = !limit.has(P);
        if (!t.item.hidden) list.parentElement!.hidden = false;
        list.append(t.item);
      }
      this.box.replaceChildren(...sections);
      if (focused?.isConnected && !focused.closest("[hidden]")) focused.focus({ preventScroll: true });

      const rest = this.order.length - FIRST_TILES;
      this.more.hidden = rest <= 0;
      this.more.textContent = all ? `Show the first ${FIRST_TILES} only` : `Show more (${rest} more)`;
      this.more.setAttribute("aria-expanded", String(all));
    }
    // true scale: against the largest container shown, and against the largest of the same row
    let largest = 0;
    const rowLargest = new Map<number, number>();
    for (const P of shown) {
      const t = this.tiles.get(P)!;
      const k = sizeRow(t.layout);
      largest = Math.max(largest, t.size);
      rowLargest.set(k, Math.max(rowLargest.get(k) ?? 0, t.size));
    }
    for (const P of shown) {
      const t = this.tiles.get(P)!;
      t.item.style.setProperty("--k-global", (t.size / largest).toFixed(4));
      t.item.style.setProperty("--k-row", (t.size / rowLargest.get(sizeRow(t.layout))!).toFixed(4));
    }
  }

  private renderLegend(): void {
    const tiles = [...this.tiles.values()];
    const lists: HTMLElement[] = [];
    const entry = (symbol: Node, text: string) => {
      const li = el("li");
      li.append(symbol, el("span", text));
      return li;
    };
    const classes = tiles.length ? tiltLegend(this.N, this.M) : [];
    if (classes.length) {
      const fills = el("ul", "", "legend-list");
      fills.setAttribute("aria-label", "Fill and texture: tilt of a piece");
      fills.append(...classes.map((c) => entry(swatch(c.cls), c.text)));
      lists.push(fills);
    }
    const present = new Set<MarkName | "none" | "not-record">();
    for (const t of tiles) {
      for (const m of marksOf(t.status)) present.add(m);
      if (t.status.published === "best_known") present.add("best_known");
      if (t.drawable.kind === "none") present.add("none");
      if (t.drawable.kind === "site" && !t.drawable.record) present.add("not-record");
    }
    const marks = el("ul", "", "legend-list");
    marks.setAttribute("aria-label", "Marks");
    const text: Record<MarkName, string> = {
      ...STATUS_TEXT,
      site: "site entry holds or equals the smallest known value",
      pending: "an entry is pending verification",
    };
    for (const name of ["proven", "proven_unrefereed", "trivial_tiling", "site", "pending"] as MarkName[]) {
      if (present.has(name)) marks.append(entry(mark(name), text[name]));
    }
    if (present.has("best_known")) marks.append(entry(el("span", "12", "legend-plain"), "no mark: best known"));
    if (present.has("none")) marks.append(entry(el("span", "", "legend-outline empty"), "no coordinates to draw"));
    if (present.has("not-record"))
      marks.append(
        entry(el("span", "", "legend-outline not-record"), "site drawing that is not the smallest known value"),
      );
    if (marks.childElementCount) lists.push(marks);
    this.legendBox.replaceChildren(...lists);
  }

  // ---------- coordinates on demand ----------

  private onIntersect(entries: IntersectionObserverEntry[]): void {
    for (const e of entries) {
      const tile = this.tiles.get(Number((e.target.firstElementChild as HTMLElement | null)?.dataset.p));
      if (!tile || tile.near === e.isIntersecting) continue;
      tile.near = e.isIntersecting;
      if (tile.near) {
        // coming back into view is a reason to try again
        if (tile.error) this.retry(tile);
        else if (tile.data) this.renderArt(tile);
      } else {
        // Away from the viewport the drawing leaves the page (up to 500 shapes each, 500 tiles),
        // and beyond a budget the coordinates leave memory as well.
        if (tile.drawn) this.renderArt(tile);
        if (this.held > HELD_PIECES && this.view.p !== tile.P && tile.data) {
          this.release(tile);
          this.renderArt(tile);
        }
      }
    }
    this.schedule();
  }

  /** Forgets the coordinates of a tile. */
  private release(t: Tile): void {
    if (t.data) this.held -= t.data.pieces.length;
    t.data = undefined;
  }

  /** Whether the coordinates of a tile are worth having now: it is near the viewport or its panel is open. */
  private needed(t: Tile): boolean {
    return t.key !== "none" && (t.near || this.view.p === t.P);
  }

  private retry(t: Tile): void {
    t.error = false;
    t.attempts = 0;
    t.retryAt = 0;
    this.renderCaption(t);
    this.renderArt(t);
    this.refreshDetail(t);
    this.schedule();
  }

  private schedule(delay = 30): void {
    const at = Date.now() + delay;
    if (this.timer && at >= this.timerAt) return;
    clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      this.timerAt = Infinity;
      this.dispatch();
    }, delay);
  }

  /** Sends requests for the tiles that need coordinates, a chunk of P each, a few at a time. */
  private dispatch(): void {
    const now = Date.now();
    let wait = Infinity;
    while (this.requests < PARALLEL) {
      const need: Tile[] = [];
      for (const P of this.order) {
        const t = this.tiles.get(P)!;
        if (t.data !== undefined || t.error || t.loading || !this.needed(t)) continue;
        if (t.retryAt > now) wait = Math.min(wait, t.retryAt - now);
        else if (!need.length || P < need[0].P + CHUNK) need.push(t);
      }
      if (!need.length) break;
      const id = ++this.requestId;
      for (const t of need) {
        t.loading = id;
        t.requestKey = t.key;
      }
      this.requests++;
      void this.fetchChunk(id, need[0].P, need[need.length - 1].P, this.generation);
    }
    if (wait < Infinity) this.schedule(wait);
  }

  private async fetchChunk(id: number, from: number, to: number, generation: number): Promise<void> {
    const res = await this.opts.fetchTiles(this.N, this.M, from, to).catch(() => null);
    this.requests--;
    if (generation === this.generation) {
      const got = new Map((res?.tiles ?? []).map((t) => [t.P, t]));
      // a shortened answer stops before `next`; the tiles from there on are asked for again
      const end = res ? (res.next ?? to + 1) : to + 1;
      for (let P = from; P <= to; P++) {
        const t = this.tiles.get(P);
        if (!t || t.loading !== id) continue;
        t.loading = 0;
        if (!res) this.failed(t);
        else if (P < end) this.accept(t, got.get(P) ?? null);
      }
    }
    this.schedule(0);
  }

  /** A request failed: wait and try again, and after the last retry say so on the tile. */
  private failed(t: Tile): void {
    t.attempts++;
    if (t.attempts <= RETRIES) {
      t.retryAt = Date.now() + BACKOFF_MS * 2 ** (t.attempts - 1);
      return;
    }
    t.error = true;
    this.renderCaption(t);
    this.renderArt(t);
    this.refreshDetail(t);
  }

  private accept(t: Tile, data: AtlasTile | null): void {
    // The listing moved on while the request was under way (a new site best): this answer is for
    // the old drawing. The tile is still without data, so it is asked for again when needed.
    if (t.requestKey !== t.key) return;
    // The answer and the listing disagree about what to draw, so one of them is out of date.
    // Reload the listing and ask once more; if they still disagree the server's drawing stands.
    if (tileKey(data) !== t.key && t.mismatches++ < 1) {
      t.retryAt = Date.now() + BACKOFF_MS;
      this.opts.refresh();
      return;
    }
    t.mismatches = 0;
    t.attempts = 0;
    t.data = data;
    if (data) this.held += data.pieces.length;
    this.renderArt(t);
    this.refreshDetail(t);
  }

  // ---------- detail panel ----------

  /**
   * Opens the detail panel of P. `reveal` also scrolls its tile into view (deep links). `push`
   * records the opening in the browser history, so that Back closes the panel.
   */
  open(P: number, how: { reveal?: boolean; push?: boolean } = {}): void {
    const tile = this.tiles.get(P);
    if (!tile) return;
    const dialog = this.opts.dialog;
    const wasOpen = dialog.open && this.view.p !== null;
    if (!this.shown.includes(P)) this.setView({ ...this.view, all: true });
    const before = this.view.p === null ? undefined : this.tiles.get(this.view.p);
    before?.link.classList.remove("current");
    this.view = { ...this.view, p: P };
    tile.link.classList.add("current");
    if (how.reveal) tile.item.scrollIntoView({ block: "center" });
    // opening the panel is a reason to try a failed drawing again
    if (tile.error) this.retry(tile);
    this.renderDetail(tile);
    if (!dialog.open) {
      // opened from the address, there is no tile to return the focus to: give it one
      if (how.reveal) tile.link.focus({ preventScroll: true });
      dialog.showModal();
    }
    this.opts.onView(this.view, how.push && !wasOpen ? "push" : "replace");
    this.setHrefs();
    this.schedule();
  }

  /** Follows the address after Back or Forward: opens the panel of P or closes it, without touching the history. */
  showPanel(P: number | null): void {
    if (P !== null && this.tiles.has(P)) this.open(P);
    else this.closePanel(true);
  }

  private closePanel(fromHistory: boolean): void {
    this.panelClosed(fromHistory);
    if (this.opts.dialog.open) this.opts.dialog.close();
  }

  /** Bookkeeping of a closed panel; runs once however the dialog was closed. */
  private panelClosed(fromHistory: boolean): void {
    if (this.view.p === null) return;
    this.tiles.get(this.view.p)?.link.classList.remove("current");
    this.view = { ...this.view, p: null };
    this.detailShown = "";
    this.setHrefs();
    this.opts.onView(this.view, fromHistory ? "replace" : "close");
  }

  private refreshDetail(t: Tile): void {
    if (this.view.p === t.P && this.opts.dialog.open) this.renderDetail(t);
  }

  private renderDetail(t: Tile): void {
    const { N, M } = this;
    const { row, status } = t;
    const { lit } = row;
    const dialog = this.opts.dialog;
    const body = dialog.querySelector<HTMLElement>("#detail-body")!;
    const { nodes, state, drawing } = this.artNodes(t, true);
    // Nothing about this P changed (a refresh for another P, or the polling fallback): the panel
    // is left exactly as it is, focus included.
    const shown = JSON.stringify([N, M, t.P, t.signature, state, tileKey(t.data ?? null)]);
    if (shown === this.detailShown) return;
    this.detailShown = shown;

    const sizeName = M === 0 ? "diameter d" : "side s";
    dialog.querySelector("#detail-title")!.textContent =
      `P = ${t.P}: ${t.P} ${t.P === 1 ? shapeLabel(N) : plural(N)} in ${withArticle(M)}`;
    const reviewed = verifiedEntry(row);
    const pending = pendingEntry(row);
    const who = (e: LeaderboardEntry) => {
      const found = foundWithLabel(e.found_with);
      return found ? `${e.name} (${found})` : e.name;
    };

    const figure = el("div", "", "detail-figure");
    const art = el("div", "", `tile-art ${state}`);
    art.append(...nodes);
    const note = el("p", "", "note");
    /** A link to another site; an address that is not http(s) or a path of this site stays text. */
    const outside = (text: string, url: string | undefined, focus: string): Node => {
      const href = safeHref(url);
      if (!href) return document.createTextNode(text);
      const a = el("a", text);
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.dataset.focus = focus;
      return a;
    };
    if (state === "failed") {
      const again = el("button", "Try again");
      again.type = "button";
      again.dataset.focus = "retry";
      again.addEventListener("click", () => this.retry(t));
      note.append("The coordinates could not be loaded. ", again);
    } else if (state === "loading") {
      note.textContent = "Loading the coordinates…";
    } else if (t.data?.source === "literature") {
      const marks = lit && sourceMarks(recordSources(lit).coordinates, CREDIT_ID);
      // without a mark the arrangement was built here to match the published value, not taken from a source
      note.textContent =
        marks || !lit?.coordinates_note
          ? "Drawn from published coordinates."
          : "Drawn from coordinates constructed by PolyPack to match the published value.";
      if (marks) note.append(marks);
    } else if (t.data?.source === "site") {
      const drawn = t.data.verification === "pending" ? pending : reviewed;
      const by = `Drawn from the entry by ${drawn?.name ?? "a visitor"}`;
      note.textContent = state.includes("pending-drawing")
        ? `${by} at ${t.data.score.toFixed(6)}, which is pending verification and is not counted as a known value. No other coordinates are available.`
        : state.includes("not-record")
          ? `${by} at ${t.data.score.toFixed(6)}: above the published value, whose coordinates are not available.`
          : `${by}.`;
    } else {
      note.append("Coordinates are not available from the source.");
      if (safeHref(lit?.picture_url))
        note.append(" ", outside("Picture at the source", lit!.picture_url, "picture"), ".");
    }
    figure.append(art, note);

    const facts = el("div", "", "detail-facts");
    const badges = el("p", "", "detail-badges");
    const badge = (name: MarkName | null, text: string) => {
      const b = el("span", "", "badge");
      if (name) b.append(mark(name));
      b.append(text);
      badges.append(b);
    };
    if (status.published)
      badge(status.published === "best_known" ? null : status.published, STATUS_TEXT[status.published]);
    if (status.site !== "none" && status.site !== "behind") badge("site", SITE_TEXT[status.site]);
    if (status.pending) badge("pending", "an entry is pending verification");
    facts.append(badges);

    const list = el("dl", "", "detail-list");
    const fact = (term: string, ...value: (string | Node)[]) => {
      const dd = el("dd");
      dd.append(...value);
      list.append(el("dt", term), dd);
      return dd;
    };
    fact(`Smallest known ${sizeName}`, status.best === null ? "no verified value" : status.best.toFixed(6)).className =
      "big";
    fact(
      "Site best",
      reviewed ? `${reviewed.score.toFixed(6)} by ${who(reviewed)}` : pending ? "none verified yet" : "none yet",
    );
    if (pending) {
      fact(
        "Pending verification",
        `${pending.score.toFixed(6)} by ${who(pending)}`,
        el("span", "Below the published value and not yet reviewed, so it is not counted above.", "detail-source"),
      );
    }
    if (lit) {
      // Value, caption and coordinates are the sources' own: each carries a reference mark, and
      // the credit lines below name the sources here, where the list at the foot of the page is
      // out of reach behind the dialog.
      const credits = recordCredits(lit);
      const own = recordSources(lit).value[0];
      const dd = fact("Published", `${lit.display}, ${STATUS_TEXT[lit.status]}`);
      dd.append(sourceMarks(recordSources(lit).value, CREDIT_ID) ?? "");
      if (lit.citation) {
        const caption = el("span", lit.citation, "detail-source");
        caption.append(sourceMarks(own ? [own] : [], CREDIT_ID) ?? "");
        dd.append(caption);
      }
      // the record's own source links to the page that was read; a source outside the list has no number
      const source = el("span", "", "detail-source");
      const first = credits.find((c) => c.n === own);
      if (first) {
        source.id = `${CREDIT_ID}${first.n}`;
        source.tabIndex = -1;
        source.classList.add("detail-credit");
        source.append("Source ", el("sup", String(first.n)), " ");
      }
      source.append(outside(lit.source_name, lit.source_url, "source"), `, read ${lit.accessed}`);
      if (first) source.append(`: ${first.what}`);
      dd.append(source);
      for (const c of credits.filter((c) => c.n !== own)) {
        const s = SOURCES.find((s) => s.n === c.n)!;
        const more = el("span", "", "detail-source detail-credit");
        more.id = `${CREDIT_ID}${c.n}`;
        more.tabIndex = -1;
        more.append(
          "Source ",
          el("sup", String(c.n)),
          " ",
          outside(sourceLabel(s), s.url, `source-${c.n}`),
          `: ${c.what}`,
        );
        dd.append(more);
      }
    } else fact("Published", "no published value on record");
    fact("Area lower bound", row.bound.toFixed(6));
    if (status.best !== null)
      fact("Gap to the bound", `${(((status.best - row.bound) / row.bound) * 100).toFixed(2)} %`);
    if (N !== 0 && drawing) {
      const tilts = el("ul", "", "tilt-list");
      for (const g of drawing.tilts.slice(0, 5)) {
        const li = el("li");
        li.append(swatch(g.cls), `${tiltName(N, M, g)} × ${g.count}`);
        tilts.append(li);
      }
      if (drawing.tilts.length > 5) tilts.append(el("li", `and ${drawing.tilts.length - 5} more angles`));
      fact("Tilt of the pieces", tilts);
    }
    facts.append(list);

    // The main link puts on the board the arrangement this panel draws: a site entry by its id, a
    // published packing through the board's record button. Without a drawing it opens the problem.
    const links = el("p", "", "detail-links");
    const drawn = !!t.data;
    const board = el("a", drawn ? "Show on the board" : "Open on the board", "button-link");
    board.href =
      t.data?.source === "site" && t.data.id !== undefined
        ? `/#s=${t.data.id}`
        : drawn
          ? `/#p=${N},${M},${t.P}&record`
          : `/#p=${N},${M},${t.P}`;
    board.dataset.focus = "board";
    links.append(board);
    if (drawn) {
      const empty = el("a", "Open an empty board");
      empty.href = `/#p=${N},${M},${t.P}`;
      empty.dataset.focus = "empty";
      links.append(empty);
    }
    facts.append(links);

    // A rebuilt panel must not drop the keyboard focus to the page behind it: the control that
    // had it gets it back, or the Close button when that control is gone.
    const active = document.activeElement;
    const focus = active instanceof HTMLElement && body.contains(active) ? (active.dataset.focus ?? "") : null;
    body.replaceChildren(figure, facts);
    if (focus !== null) {
      const same = focus ? body.querySelector<HTMLElement>(`[data-focus="${focus}"]`) : null;
      (same ?? dialog.querySelector<HTMLElement>("#detail-close"))?.focus();
    }
  }
}
