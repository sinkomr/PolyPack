/**
 * createBoundaryView: three drawings of a packing on the boundary of a 4-polytope, in one element.
 *
 *  - Cells: the cells side by side in their own coordinates (atlas.ts).
 *  - Net: the net of the cells, with a Fold slider that folds it into the fourth dimension (net.ts).
 *  - Slice: the boundary cut by a hyperplane x_k = t, live or as a strip of nine (slicer.ts).
 *
 * It draws only what the engine gives it (the parts, the cells' frames and gluings, the net), so
 * that what is seen is what the server validates. It depends on three.js and the engine's types
 * only, so the website, a standalone page and the board can all mount it.
 */
import { NeutralToneMapping, Raycaster, type Texture, WebGLRenderer } from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { BoundaryConfig } from "@polypack/boundary";
import { AtlasScene } from "./atlas";
import { LineRegistry, WIDTH, roomEnvironment } from "./kit";
import { type Engine, type Model, buildModel, disposeModel } from "./model";
import { NetScene } from "./net";
import { DARK, LIGHT, type Theme, axisName, cellColors, cellNames, fmt } from "./palette";
import type { SceneView } from "./scene";
import { SliceScene } from "./slicer";
import { injectStyle } from "./style";

export type ViewKey = "atlas" | "net" | "slice";

export const VIEWS: readonly { key: ViewKey; label: string }[] = [
  { key: "atlas", label: "Cells" },
  { key: "net", label: "Net" },
  { key: "slice", label: "Slice" },
];

export interface BoundaryViewOptions extends Engine {
  initialView?: ViewKey;
  /** Names the toolbar for screen readers. */
  label?: string;
  /** The piece's name, singular and plural, for the descriptions ("ball", "balls"). */
  pieceNames?: [string, string];
}

export interface BoundaryView {
  /** Draws a configuration; null clears the drawing. */
  show(config: BoundaryConfig | null): void;
  setView(view: ViewKey): void;
  readonly view: ViewKey;
  destroy(): void;
}

const STEP = (5 * Math.PI) / 180;
const FOLD_TIME = 2400;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(text: string, aria?: string): HTMLButtonElement {
  const b = el("button", undefined, text);
  b.type = "button";
  if (aria) b.setAttribute("aria-label", aria);
  return b;
}

export function createBoundaryView(host: HTMLElement, opts: BoundaryViewOptions): BoundaryView {
  injectStyle(host.ownerDocument);
  const engine: Engine = opts;
  const poly = engine.polytope;
  const names = cellNames(poly);
  const [one, many] = opts.pieceNames ?? ["piece", "pieces"];
  const ac = new AbortController();
  const on = <T extends EventTarget>(t: T, type: string, fn: (e: Event) => void, o?: AddEventListenerOptions) =>
    t.addEventListener(type, fn as EventListener, { ...o, signal: ac.signal });

  // ---- DOM -------------------------------------------------------------------------------------
  const root = el("div", "pp3");
  const bar = el("div", "pp3-bar");
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", opts.label ?? "Drawing of the packing");
  const viewButtons = VIEWS.map((v) => {
    const b = button(v.label);
    b.dataset.view = v.key;
    b.setAttribute("aria-pressed", "false");
    return b;
  });
  const spacer = el("span", "pp3-spacer");
  const reset = button("Reset view");
  bar.append(...viewButtons, spacer, reset);

  // fold controls
  const foldRow = el("div", "pp3-controls");
  const foldRange = el("div", "pp3-range");
  const foldLabel = el("label", undefined, "Fold");
  const fold = el("input");
  fold.type = "range";
  fold.min = "0";
  fold.max = "1000";
  fold.step = "1";
  fold.value = "0";
  fold.id = `pp3-fold-${Math.random().toString(36).slice(2, 8)}`;
  foldLabel.htmlFor = fold.id;
  const foldOut = el("output", undefined, "flat");
  foldOut.htmlFor.add(fold.id);
  foldRange.append(foldLabel, fold, foldOut);
  const foldPlay = button("Fold up");
  foldRow.append(foldRange, foldPlay);

  // slice controls
  const sliceRow = el("div", "pp3-controls");
  const axisGroup = el("div", "pp3-group");
  axisGroup.setAttribute("role", "group");
  axisGroup.setAttribute("aria-label", "Slice across axis");
  axisGroup.append(el("span", "pp3-lab", "Axis"));
  const axisButtons = Array.from({ length: poly.d }, (_, k) => {
    const b = button(axisName(k), `Slice across ${axisName(k)}`);
    b.setAttribute("aria-pressed", "false");
    axisGroup.append(b);
    return b;
  });
  const sliceRange = el("div", "pp3-range");
  const sliceLabel = el("label", undefined, "Position");
  const slice = el("input");
  slice.type = "range";
  slice.min = "0";
  slice.max = "1000";
  slice.step = "1";
  slice.value = "500";
  slice.id = `pp3-slice-${Math.random().toString(36).slice(2, 8)}`;
  sliceLabel.htmlFor = slice.id;
  const sliceOut = el("output");
  sliceOut.htmlFor.add(slice.id);
  sliceRange.append(sliceLabel, slice, sliceOut);
  const stripButton = button("Strip of 9");
  stripButton.setAttribute("aria-pressed", "false");
  sliceRow.append(axisGroup, stripButton, sliceRange);

  const stage = el("div", "pp3-stage");
  const under = el("div", "pp3-under");
  const over = el("div", "pp3-over");
  const canvas = el("canvas");
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "application");
  const message = el("div", "pp3-message");
  message.hidden = true;
  stage.append(under, canvas, over, message);
  const legend = el("div", "pp3-legend");
  const status = el("p", "pp3-status");
  const live = el("div", "pp3-sr");
  live.setAttribute("aria-live", "polite");
  root.append(bar, foldRow, sliceRow, stage, legend, status, live);
  host.replaceChildren(root);

  // ---- renderer --------------------------------------------------------------------------------
  let renderer: WebGLRenderer | null = null;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  } catch {
    renderer = null;
  }
  let current: ViewKey = opts.initialView ?? "atlas";
  if (!renderer) {
    // no WebGL: a plain message, and an inert view
    canvas.remove();
    for (const r of [bar, foldRow, sliceRow, legend, status]) r.hidden = true;
    message.hidden = false;
    message.textContent = "This 3D drawing needs WebGL, which this browser has turned off or does not support.";
    status.textContent = "";
    return {
      show() {},
      setView(v: ViewKey) {
        current = v;
      },
      get view() {
        return current;
      },
      destroy() {
        ac.abort();
        root.remove();
      },
    };
  }
  const r = renderer;
  r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  r.toneMapping = NeutralToneMapping;
  r.setClearColor(0x000000, 0);
  r.setScissorTest(true);

  const scheme = matchMedia("(prefers-color-scheme: dark)");
  const readTheme = (): Theme => {
    const base = scheme.matches ? DARK : LIGHT;
    const cs = getComputedStyle(root);
    const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
    return {
      dark: scheme.matches,
      bg: v("--pp3-bg", base.bg),
      panel: v("--pp3-panel", base.panel),
      text: v("--pp3-text", base.text),
      muted: v("--pp3-muted", base.muted),
      border: v("--pp3-border", base.border),
      accent: v("--pp3-accent", base.accent),
    };
  };
  let theme = readTheme();
  let colors = cellColors(poly, theme.dark);
  const lines = new LineRegistry();
  const cellEdge = lines.make({ linewidth: WIDTH.cell, transparent: true, worldUnits: false });
  const paintEdges = () => {
    cellEdge.color.setStyle(theme.dark ? "#9aa4b2" : "#4f5965");
    cellEdge.opacity = theme.dark ? 0.85 : 0.75;
  };
  paintEdges();
  const room = roomEnvironment(r);
  const env: Texture = room.texture;
  const ctx = {
    engine,
    lines,
    env,
    names,
    theme: () => theme,
    cellColors: () => colors,
    cellEdge,
  };
  const atlas = new AtlasScene(ctx, { under, over });
  const net = new NetScene(ctx);
  const sliceScene = new SliceScene(ctx, { under, over });
  const scenes: Record<ViewKey, SceneView> = { atlas, net, slice: sliceScene };
  const controls: Record<ViewKey, OrbitControls> = {
    atlas: new OrbitControls(atlas.camera, canvas),
    net: new OrbitControls(net.camera, canvas),
    slice: new OrbitControls(sliceScene.camera, canvas),
  };
  for (const [k, c] of Object.entries(controls) as [ViewKey, OrbitControls][]) {
    c.enableDamping = true;
    c.dampingFactor = 0.14;
    c.rotateSpeed = 0.9;
    c.enablePan = k !== "atlas";
    c.enabled = false;
    c.addEventListener("change", () => request());
  }
  net.attach(controls.net);

  // ---- state -----------------------------------------------------------------------------------
  let model: Model | null = null;
  const stale: Record<ViewKey, boolean> = { atlas: true, net: true, slice: true };
  /** The edge each scene was last framed at (null: never framed). */
  const framedAt: Record<ViewKey, number | null> = { atlas: null, net: null, slice: null };
  let hovered: number | null = null;
  let pinned: number | null = null;
  let W = 1;
  let H = 1;

  const ray = new Raycaster();

  function ensureBuilt(k: ViewKey) {
    if (!stale[k]) return;
    stale[k] = false;
    scenes[k].build(model);
    scenes[k].resize(W, H);
    if (!model) return;
    const prev = framedAt[k];
    if (prev === null) scenes[k].home(controls[k]);
    else if (prev !== model.s && k !== "net") {
      // keep the user's turn and zoom, at the new size
      const c = controls[k];
      const cam = scenes[k].camera;
      cam.position.sub(c.target).multiplyScalar(model.s / prev).add(c.target);
      c.minDistance *= model.s / prev;
      c.maxDistance *= model.s / prev;
      cam.near *= model.s / prev;
      cam.far *= model.s / prev;
      cam.updateProjectionMatrix();
      c.update();
    }
    framedAt[k] = model.s;
  }

  // ---- drawing ---------------------------------------------------------------------------------
  let raf = 0;
  let anim: { from: number; to: number; start: number; time: number } | null = null;
  function request() {
    if (!raf) raf = requestAnimationFrame(frame);
  }
  function frame(now: number) {
    raf = 0;
    if (anim) {
      const u = anim.time > 0 ? Math.min(1, (now - anim.start) / anim.time) : 1;
      const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
      setFold(anim.from + (anim.to - anim.from) * e, false);
      if (u >= 1) {
        anim = null;
        syncFoldButton();
        announce(net.describe());
      }
    }
    controls[current].update();
    r.setScissor(0, 0, W, H);
    r.setViewport(0, 0, W, H);
    r.clear();
    if (model) scenes[current].render(r);
    if (anim) request();
  }

  function resize() {
    const w = Math.max(1, Math.floor(stage.clientWidth));
    const h = Math.max(1, Math.floor(stage.clientHeight));
    if (w === W && h === H) return;
    W = w;
    H = h;
    r.setSize(W, H, false);
    for (const k of Object.keys(scenes) as ViewKey[]) if (!stale[k]) scenes[k].resize(W, H);
    request();
  }

  // ---- text ------------------------------------------------------------------------------------
  function paintLegend() {
    const caption: Record<ViewKey, string> = {
      atlas: "Face colour: the cell glued there.",
      net: "Tinted face: the cell it meets when folded.",
      slice: "Face colour: the cell the slice crosses; at either end the slice is a whole cell.",
    };
    legend.replaceChildren(el("span", undefined, caption[current]));
    names.forEach((n, i) => {
      const key = el("span", "pp3-key");
      const chip = el("span", "pp3-chip");
      chip.style.background = colors[i];
      chip.setAttribute("aria-hidden", "true");
      key.append(chip, n);
      legend.append(key);
    });
  }

  function pieceText(i: number): string {
    if (!model) return "";
    const p = model.config.pieces[i];
    const cells = [...new Set(model.parts.filter((x, j) => x.piece === i && model!.meshes[j]).map((x) => x.cell))];
    const where = cells.map((c) => names[c]).join(", ");
    return `${one[0].toUpperCase()}${one.slice(1)} ${i + 1}: centre in cell ${names[p.cell]} at (${p.u.map(fmt).join(", ")}); ${cells.length === 1 ? "inside it" : `parts in ${where}`}.`;
  }

  function paintStatus() {
    const k = pinned ?? hovered;
    if (!model) {
      status.textContent = "No packing to draw.";
      return;
    }
    if (k !== null) {
      status.textContent = pieceText(k);
      return;
    }
    const head = `${model.count} ${model.count === 1 ? one : many}, edge ${model.s.toFixed(6)}.`;
    const hint = current === "net" ? " Drag to turn; move Fold to fold the net into the fourth dimension." : " Drag to turn; point at or tap a piece to follow it.";
    status.textContent = head + hint;
  }

  function paintLabel() {
    const d = model ? scenes[current].describe() : "No packing to draw.";
    canvas.setAttribute(
      "aria-label",
      model ? `${d} Drag or use the arrow keys to turn it, plus and minus to zoom, Page Up and Page Down to pick a ${one}.` : d,
    );
  }

  function announce(text: string) {
    live.textContent = text;
  }

  // ---- views -----------------------------------------------------------------------------------
  function setView(k: ViewKey) {
    if (!(k in scenes)) return;
    stopAnim();
    current = k;
    for (const [key, c] of Object.entries(controls)) c.enabled = key === k;
    for (const b of viewButtons) b.setAttribute("aria-pressed", String(b.dataset.view === k));
    foldRow.hidden = k !== "net" || !model;
    sliceRow.hidden = k !== "slice" || !model;
    // the tiles' cards and titles show only around a drawing
    atlas.active = k === "atlas" && model !== null;
    sliceScene.active = k === "slice" && model !== null;
    legend.hidden = !model;
    ensureBuilt(k);
    if (k === "slice") syncSlice();
    if (k === "net") syncFold();
    paintLegend();
    paintStatus();
    paintLabel();
    request();
  }

  // fold
  let shownFold = 0;
  function setFold(f: number, fromSlider: boolean) {
    net.setFold(f);
    const v = Math.round(f * 1000);
    if (!fromSlider && v !== shownFold) fold.value = String(v);
    shownFold = v;
    syncFold();
    request();
  }
  let shownPct = -1;
  function syncFold() {
    const pct = Math.round(net.foldValue * 100);
    // the text changes a hundred times in a whole fold, not every frame
    if (pct !== shownPct) {
      shownPct = pct;
      const text = pct === 0 ? "flat" : pct === 100 ? "folded" : `${pct}%`;
      foldOut.textContent = text;
      fold.setAttribute("aria-valuetext", text);
    }
    syncFoldButton();
  }
  function syncFoldButton() {
    const text = anim ? "Stop" : net.foldValue > 0.5 ? "Unfold" : "Fold up";
    if (foldPlay.textContent !== text) foldPlay.textContent = text;
  }
  function stopAnim() {
    if (!anim) return;
    anim = null;
    syncFoldButton();
  }
  on(fold, "input", () => {
    stopAnim();
    setFold(Number(fold.value) / 1000, true);
    paintLabel();
  });
  on(foldPlay, "click", () => {
    if (anim) {
      stopAnim();
      return;
    }
    const from = net.foldValue;
    const to = from > 0.5 ? 0 : 1;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    anim = { from, to, start: performance.now(), time: reduce ? 0 : FOLD_TIME * Math.abs(to - from) };
    syncFoldButton();
    request();
  });

  // slice
  function syncSlice() {
    const [lo, hi] = sliceScene.range;
    const t = sliceScene.position;
    slice.value = String(Math.round(((t - lo) / (hi - lo || 1)) * 1000));
    const text = sliceScene.liveText;
    sliceOut.textContent = text;
    slice.setAttribute("aria-valuetext", text);
    axisButtons.forEach((b, k) => b.setAttribute("aria-pressed", String(k === sliceScene.axisIndex)));
    stripButton.setAttribute("aria-pressed", String(sliceScene.isStrip));
    sliceRange.hidden = sliceScene.isStrip;
  }
  on(slice, "input", () => {
    const [lo, hi] = sliceScene.range;
    sliceScene.setPosition(lo + ((hi - lo) * Number(slice.value)) / 1000);
    const text = sliceScene.liveText;
    sliceOut.textContent = text;
    slice.setAttribute("aria-valuetext", text);
    paintLabel();
    request();
  });
  axisButtons.forEach((b, k) =>
    on(b, "click", () => {
      sliceScene.setAxis(k);
      syncSlice();
      paintLabel();
      request();
    }),
  );
  on(stripButton, "click", () => {
    sliceScene.setStrip(!sliceScene.isStrip);
    sliceScene.home(controls.slice);
    sliceScene.active = true;
    syncSlice();
    paintLabel();
    request();
  });

  for (const b of viewButtons) on(b, "click", () => setView(b.dataset.view as ViewKey));
  on(reset, "click", () => {
    if (model) scenes[current].home(controls[current]);
    request();
  });

  // ---- pointing at pieces ----------------------------------------------------------------------
  function highlight() {
    model?.looks.highlight(pinned ?? hovered);
    paintStatus();
    request();
  }
  let pending: { x: number; y: number } | null = null;
  let pickRaf = 0;
  let dragging = false;
  let down: { x: number; y: number; t: number } | null = null;
  function pickAt(x: number, y: number): number | null {
    if (!model) return null;
    return scenes[current].pick(x, y, ray);
  }
  on(canvas, "pointermove", (e) => {
    const p = e as PointerEvent;
    if (down && Math.hypot(p.clientX - down.x, p.clientY - down.y) > 6) dragging = true;
    if (p.pointerType !== "mouse" || p.buttons) return;
    const rect = canvas.getBoundingClientRect();
    pending = { x: p.clientX - rect.left, y: p.clientY - rect.top };
    if (!pickRaf)
      pickRaf = requestAnimationFrame(() => {
        pickRaf = 0;
        if (!pending) return;
        const k = pickAt(pending.x, pending.y);
        pending = null;
        if (k !== hovered) {
          hovered = k;
          highlight();
        }
      });
  });
  on(canvas, "pointerleave", () => {
    pending = null;
    if (hovered !== null) {
      hovered = null;
      highlight();
    }
  });
  on(canvas, "pointerdown", (e) => {
    const p = e as PointerEvent;
    down = { x: p.clientX, y: p.clientY, t: performance.now() };
    dragging = false;
  });
  on(canvas, "pointerup", (e) => {
    const p = e as PointerEvent;
    const was = down;
    down = null;
    if (!was || dragging || performance.now() - was.t > 600) return;
    // a tap or a click: pin the piece under it, or unpin
    const rect = canvas.getBoundingClientRect();
    const k = pickAt(p.clientX - rect.left, p.clientY - rect.top);
    pinned = k === null || k === pinned ? null : k;
    if (pinned !== null) announce(pieceText(pinned));
    highlight();
  });

  on(canvas, "keydown", (e) => {
    const ev = e as KeyboardEvent;
    if (!model) return;
    const c = controls[current];
    const k = ev.shiftKey ? 3 * STEP : STEP;
    let used = true;
    switch (ev.key) {
      case "ArrowLeft":
        c.rotateLeft(-k);
        break;
      case "ArrowRight":
        c.rotateLeft(k);
        break;
      case "ArrowUp":
        c.rotateUp(-k);
        break;
      case "ArrowDown":
        c.rotateUp(k);
        break;
      case "+":
      case "=":
        c.dollyIn(1.12);
        c.update();
        break;
      case "-":
      case "_":
        c.dollyOut(1.12);
        c.update();
        break;
      case "Home":
      case "0":
        scenes[current].home(c);
        break;
      case "PageDown":
      case "PageUp": {
        const n = model.count;
        const step = ev.key === "PageDown" ? 1 : -1;
        pinned = pinned === null ? (step > 0 ? 0 : n - 1) : (pinned + step + n) % n;
        announce(pieceText(pinned));
        highlight();
        break;
      }
      case "Escape":
        if (pinned === null) used = false;
        pinned = null;
        highlight();
        break;
      default:
        used = false;
    }
    if (used) {
      ev.preventDefault();
      request();
    }
  });

  // ---- size and colour scheme ------------------------------------------------------------------
  const ro = new ResizeObserver(() => resize());
  ro.observe(stage);
  // a printed page takes the canvas as last drawn: draw now, at the print layout's size
  on(window, "beforeprint", () => {
    resize();
    frame(performance.now());
  });
  on(scheme, "change", () => {
    theme = readTheme();
    colors = cellColors(poly, theme.dark);
    paintEdges();
    model?.looks.theme(theme.dark);
    atlas.recolor();
    net.recolor();
    // the net and the slices bake colours into their buffers: rebuild them when next shown
    stale.net = stale.slice = true;
    if (current !== "atlas") ensureBuilt(current);
    if (current === "slice") syncSlice();
    if (current === "net") {
      net.setFold(Number(fold.value) / 1000);
    }
    paintLegend();
    request();
  });

  // ---- the API ---------------------------------------------------------------------------------
  function show(config: BoundaryConfig | null) {
    stopAnim();
    const old = model;
    hovered = null;
    pinned = null;
    try {
      model = config ? buildModel(engine, config, lines, theme) : null;
      message.hidden = true;
    } catch (err) {
      model = null;
      message.hidden = false;
      message.textContent = `This configuration cannot be drawn: ${err instanceof Error ? err.message : String(err)}`;
    }
    for (const k of Object.keys(stale) as ViewKey[]) stale[k] = true;
    ensureBuilt(current);
    if (current === "net") net.setFold(Number(fold.value) / 1000);
    if (old) disposeModel(old);
    canvas.style.visibility = model ? "" : "hidden";
    setView(current);
  }

  resize();
  setView(current);
  show(null);

  return {
    show,
    setView,
    get view() {
      return current;
    },
    destroy() {
      stopAnim();
      if (raf) cancelAnimationFrame(raf);
      if (pickRaf) cancelAnimationFrame(pickRaf);
      raf = pickRaf = 0;
      ac.abort();
      ro.disconnect();
      for (const c of Object.values(controls)) c.dispose();
      for (const s of Object.values(scenes)) s.dispose();
      if (model) disposeModel(model);
      model = null;
      lines.remove(cellEdge);
      room.dispose();
      r.dispose();
      r.forceContextLoss();
      root.remove();
    },
  };
}

