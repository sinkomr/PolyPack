import { Container, DISK_RADIUS, PackingConfig, containerVertices, pieceContainsPoint, pieceVertices } from "@polypack/geometry";
import { Board } from "./board";
import { MagneticSnap, SnapMode } from "./snapping";
import type { Sketch } from "@polypack/solver";

const HANDLE_OFFSET_PX = 30;
const HANDLE_RADIUS_PX = 9;
const HIT_PX = 16;
const CLICK_SLOP_PX = 4;
const MAGNET_RADIUS_PX = 12;

type Gesture =
  | { kind: "pan"; sx: number; sy: number; camX: number; camY: number; moved: boolean }
  | { kind: "drag"; startX: number; startY: number; ax: number; ay: number; sx: number; sy: number; grabX: number; grabY: number }
  | { kind: "rotate"; last: number; pending: number }
  | { kind: "phi"; cx: number; cy: number; last: number }
  | { kind: "marquee"; x0: number; y0: number; x1: number; y1: number }
  | { kind: "touch2"; dist: number; ang: number; midX: number; midY: number; pending: number };

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Canvas rendering and pointer, wheel, touch and keyboard interaction for a Board. */
export class BoardView {
  cam = { x: 0, y: 0, zoom: 60 };
  /** When on, tapping a piece toggles it in the selection (for touch screens and keyboards without Shift). */
  multiSelect = false;
  snapMode: SnapMode = "both";
  /** When set, the view never edits the board: it only pans and zooms (the Tighter page). */
  readOnly = false;
  /** Text drawn over a solver preview; null draws none. */
  previewLabel: string | null = "Solver preview — Accept result to edit";
  /** A dashed outline drawn under the pieces, such as the area lower bound; null for none. */
  ghost: Container | null = null;
  private snapGuide: MagneticSnap | null = null;
  private preview: { config: PackingConfig; container: Container } | null = null;
  /** A solver method's working shapes, drawn instead of the preview while it runs. */
  private sketch: Sketch | null = null;
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private pointers = new Map<number, { x: number; y: number }>();
  private gesture: Gesture | null = null;
  private handleAngle = 0;
  /** Piece last reached with the N / P keys. */
  private cursor = -1;
  private frame = 0;
  private wheelTimer = 0;
  private colors: Record<string, string> = {};

  constructor(
    private canvas: HTMLCanvasElement,
    private board: Board,
    private say: (msg: string) => void,
  ) {
    this.ctx = canvas.getContext("2d")!;
    new ResizeObserver(() => this.resize()).observe(canvas);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.readColors());
    this.readColors();
    this.resize();
    board.onChange(() => this.requestDraw());
    canvas.addEventListener("pointerdown", (e) => this.onDown(e));
    canvas.addEventListener("pointermove", (e) => this.onMove(e));
    canvas.addEventListener("pointerup", (e) => this.onUp(e));
    canvas.addEventListener("pointercancel", (e) => this.onUp(e));
    canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener("keydown", (e) => this.onKey(e));
    // Safari reports trackpad rotation through its own gesture events
    let lastRotation = 0;
    canvas.addEventListener("gesturestart", (e) => {
      e.preventDefault();
      if (this.locked) return;
      lastRotation = 0;
      this.board.begin();
    });
    canvas.addEventListener("gesturechange", (e) => {
      e.preventDefault();
      if (this.locked) return;
      const rot = (e as unknown as { rotation: number }).rotation;
      const pivot = this.board.selectionPivot();
      if (pivot) this.board.rotateSelection((-(rot - lastRotation) * Math.PI) / 180, pivot.x, pivot.y);
      lastRotation = rot;
    });
    canvas.addEventListener("gestureend", () => { if (!this.locked) this.board.commit(); });
  }

  private readColors(): void {
    const css = getComputedStyle(document.documentElement);
    for (const name of ["bg", "grid", "grid-major", "piece", "piece-stroke", "sel", "sel-stroke", "container", "text", "muted"]) {
      this.colors[name] = css.getPropertyValue(`--${name}`).trim();
    }
    this.requestDraw();
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    this.w = r.width;
    this.h = r.height;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  // World coordinates have y up; screen coordinates have y down.
  private sx(x: number): number {
    return this.w / 2 + (x - this.cam.x) * this.cam.zoom;
  }
  private sy(y: number): number {
    return this.h / 2 - (y - this.cam.y) * this.cam.zoom;
  }
  private wx(sx: number): number {
    return this.cam.x + (sx - this.w / 2) / this.cam.zoom;
  }
  private wy(sy: number): number {
    return this.cam.y - (sy - this.h / 2) / this.cam.zoom;
  }

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** Page coordinates of a world point (used by the end-to-end tests). */
  clientPoint(x: number, y: number): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + this.sx(x), y: r.top + this.sy(y) };
  }

  /** Centre the view on the container (or the pieces) with a margin. */
  fit(): void {
    const c = this.sketch?.container ?? this.preview?.container ?? this.board.container ?? this.ghost;
    if (!c || c.size === 0) {
      this.cam = { x: 0, y: 0, zoom: 60 };
    } else {
      const reach = c.M === 0 ? c.size / 2 : c.size / (2 * Math.sin(Math.PI / c.M));
      this.cam.x = c.cx;
      this.cam.y = c.cy;
      this.cam.zoom = Math.max(4, Math.min(160, (0.42 * Math.min(this.w, this.h)) / reach));
    }
    this.requestDraw();
  }

  /** Solver frames are read-only and never enter board history or persistent storage. */
  setPreview(config: PackingConfig | null, container?: Container): void {
    // A gesture ends under the mode it began in, before the board locks or unlocks.
    if (this.gesture && this.locked !== (this.readOnly || !!(config && container) || !!this.sketch)) this.endGesture();
    this.preview = config && container ? { config, container } : null;
    this.snapGuide = null;
    this.requestDraw();
  }

  /**
   * A solver method's working state, shown in place of the preview until cleared. It is only
   * a picture: it never enters the board, and accepting a run always takes its strict result.
   */
  setSketch(sketch: Sketch | null): void {
    if (this.gesture && this.locked !== (this.readOnly || !!sketch || !!this.preview)) this.endGesture();
    this.sketch = sketch;
    this.snapGuide = null;
    this.requestDraw();
  }

  /** The sketch shown, if any (used by the end-to-end tests). */
  get shownSketch(): Sketch | null {
    return this.sketch;
  }

  /** Solver output is on screen (or the view is read-only), so the board cannot be edited. */
  private get locked(): boolean {
    return this.readOnly || !!this.preview || !!this.sketch;
  }

  private zoomAt(sx: number, sy: number, factor: number): void {
    const x = this.wx(sx);
    const y = this.wy(sy);
    this.cam.zoom = Math.max(2, Math.min(2000, this.cam.zoom * factor));
    // keep the world point under the pointer fixed
    this.cam.x = x - (sx - this.w / 2) / this.cam.zoom;
    this.cam.y = y + (sy - this.h / 2) / this.cam.zoom;
    this.requestDraw();
  }

  private pieceAt(x: number, y: number): number {
    const { N, pieces } = this.board.state;
    for (let i = pieces.length - 1; i >= 0; i--) if (pieceContainsPoint(N, pieces[i], x, y)) return i;
    return -1;
  }

  private rotateHandle(): { x: number; y: number; px: number; py: number } | null {
    if (this.locked) return null;
    const pivot = this.board.selectionPivot();
    if (!pivot) return null;
    const px = this.sx(pivot.x);
    const py = this.sy(pivot.y);
    const len = pivot.radius * this.cam.zoom + HANDLE_OFFSET_PX;
    // straight up at rest; follows the pointer during a rotation gesture
    const a = Math.PI / 2 + this.handleAngle;
    return { x: px + len * Math.cos(a), y: py - len * Math.sin(a), px, py };
  }

  private phiHandle(): { x: number; y: number } | null {
    if (this.locked) return null;
    const c = this.board.container;
    if (!c || c.M === 0) return null;
    const v = containerVertices(c);
    return { x: this.sx(v[0]), y: this.sy(v[1]) };
  }

  private onDown(e: PointerEvent): void {
    this.canvas.focus();
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 2) {
      // The first finger may have started a pan or a marquee on empty space. Drop it, so that it
      // is not taken for a tap that clears the selection the twist is about to rotate.
      if (this.gesture?.kind === "pan" || this.gesture?.kind === "marquee") this.gesture = null;
      this.endGesture();
      const [a, b] = [...this.pointers.values()];
      this.board.begin();
      this.gesture = {
        kind: "touch2",
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        ang: Math.atan2(-(b.y - a.y), b.x - a.x),
        midX: (a.x + b.x) / 2,
        midY: (a.y + b.y) / 2,
        pending: 0,
      };
      return;
    }
    if (this.pointers.size > 2) return;

    if (this.locked) {
      this.gesture = { kind: "pan", sx: p.x, sy: p.y, camX: this.cam.x, camY: this.cam.y, moved: false };
      return;
    }

    const rh = this.rotateHandle();
    if (rh && Math.hypot(p.x - rh.x, p.y - rh.y) <= HIT_PX) {
      this.board.begin();
      this.gesture = { kind: "rotate", last: Math.atan2(rh.py - p.y, p.x - rh.px), pending: 0 };
      return;
    }
    const ph = this.phiHandle();
    if (ph && Math.hypot(p.x - ph.x, p.y - ph.y) <= HIT_PX) {
      const c = this.board.container!;
      this.board.begin();
      this.gesture = { kind: "phi", cx: c.cx, cy: c.cy, last: Math.atan2(this.wy(p.y) - c.cy, this.wx(p.x) - c.cx) };
      return;
    }
    const x = this.wx(p.x);
    const y = this.wy(p.y);
    const hit = this.pieceAt(x, y);
    const additive = e.shiftKey || e.ctrlKey || e.metaKey || this.multiSelect;
    if (hit >= 0) {
      if (additive) {
        this.board.toggle(hit);
        if (!this.board.selection.has(hit)) return;
      } else if (!this.board.selection.has(hit)) {
        this.board.select([hit]);
      }
      this.board.begin();
      const pose = this.board.state.pieces[hit];
      this.gesture = { kind: "drag", startX: x, startY: y, ax: 0, ay: 0, sx: p.x, sy: p.y, grabX: x - pose.x, grabY: y - pose.y };
    } else if (e.shiftKey) {
      this.gesture = { kind: "marquee", x0: x, y0: y, x1: x, y1: y };
    } else {
      this.gesture = { kind: "pan", sx: p.x, sy: p.y, camX: this.cam.x, camY: this.cam.y, moved: false };
    }
  }

  private onMove(e: PointerEvent): void {
    if (!this.pointers.has(e.pointerId)) return;
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    const g = this.gesture;
    if (!g) return;
    switch (g.kind) {
      case "pan":
        if (Math.hypot(p.x - g.sx, p.y - g.sy) > CLICK_SLOP_PX) g.moved = true;
        this.cam.x = g.camX - (p.x - g.sx) / this.cam.zoom;
        this.cam.y = g.camY + (p.y - g.sy) / this.cam.zoom;
        this.requestDraw();
        break;
      case "drag": {
        if (Math.hypot(p.x - g.sx, p.y - g.sy) <= CLICK_SLOP_PX && g.ax === 0 && g.ay === 0) break;
        // The piece chases the pointer: ask for whatever part of the total displacement is still
        // owed, so a piece that was blocked catches up once the way is free.
        const d = this.board.translateSelection(this.wx(p.x) - g.startX - g.ax, this.wy(p.y) - g.startY - g.ay);
        g.ax += d.dx;
        g.ay += d.dy;
        this.snapGuide = e.altKey ? null : this.board.magnetSelection(Math.min(0.2, MAGNET_RADIUS_PX / this.cam.zoom), this.snapMode);
        if (this.snapGuide) {
          g.ax += this.snapGuide.dx;
          g.ay += this.snapGuide.dy;
          // A face alignment rotates the grabbed point too. Keep that point under the mouse
          // on subsequent events rather than introducing a jump for off-centre grabs.
          const c = Math.cos(this.snapGuide.angle), s = Math.sin(this.snapGuide.angle);
          const x = c * g.grabX - s * g.grabY, y = s * g.grabX + c * g.grabY;
          g.startX += x - g.grabX;
          g.startY += y - g.grabY;
          g.grabX = x;
          g.grabY = y;
        }
        this.requestDraw();
        break;
      }
      case "rotate": {
        // the pivot follows the group, which a rotation may nudge away from a neighbour
        const pivot = this.locked ? null : this.board.selectionPivot();
        if (!pivot) break;
        const ang = Math.atan2(this.sy(pivot.y) - p.y, p.x - this.sx(pivot.x));
        g.pending = wrapAngle(g.pending + wrapAngle(ang - g.last));
        g.last = ang;
        const a = this.board.rotateSelection(g.pending, pivot.x, pivot.y);
        g.pending -= a;
        this.handleAngle += a;
        this.requestDraw();
        break;
      }
      case "phi": {
        const ang = Math.atan2(this.wy(p.y) - g.cy, this.wx(p.x) - g.cx);
        this.board.setPhi(this.board.state.phi + wrapAngle(ang - g.last));
        g.last = ang;
        break;
      }
      case "marquee":
        g.x1 = this.wx(p.x);
        g.y1 = this.wy(p.y);
        this.requestDraw();
        break;
      case "touch2": {
        if (this.pointers.size < 2) break;
        const [a, b] = [...this.pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const ang = Math.atan2(-(b.y - a.y), b.x - a.x);
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        const pivot = this.locked ? null : this.board.selectionPivot();
        if (pivot) {
          // two fingers with a selection: twist rotates the selected pieces
          g.pending = wrapAngle(g.pending + wrapAngle(ang - g.ang));
          g.pending -= this.board.rotateSelection(g.pending, pivot.x, pivot.y);
        } else {
          // two fingers with nothing selected: pinch zooms and pans
          this.cam.x -= (midX - g.midX) / this.cam.zoom;
          this.cam.y += (midY - g.midY) / this.cam.zoom;
          this.zoomAt(midX, midY, dist / g.dist);
        }
        g.dist = dist;
        g.ang = ang;
        g.midX = midX;
        g.midY = midY;
        break;
      }
    }
  }

  private onUp(e: PointerEvent): void {
    if (!this.pointers.delete(e.pointerId)) return;
    const g = this.gesture;
    if (g?.kind === "touch2") {
      if (this.pointers.size === 0) this.endGesture();
      return;
    }
    if (this.pointers.size === 0) this.endGesture();
  }

  private endGesture(): void {
    const g = this.gesture;
    this.gesture = null;
    if (this.snapGuide) this.say(this.snapGuide.kind === "edge" ? "Faces aligned and snapped." : this.snapGuide.kind === "corner" ? "Corners snapped." : "Corner snapped to edge.");
    this.snapGuide = null;
    this.requestDraw();
    if (!g) return;
    if (g.kind === "pan") {
      if (!this.locked && !g.moved && !this.multiSelect && this.board.selection.size) this.board.select([]);
      return;
    }
    if (g.kind === "marquee") {
      const { pieces } = this.board.state;
      const [xa, xb] = [Math.min(g.x0, g.x1), Math.max(g.x0, g.x1)];
      const [ya, yb] = [Math.min(g.y0, g.y1), Math.max(g.y0, g.y1)];
      const ids = pieces.map((_, i) => i).filter((i) => pieces[i].x >= xa && pieces[i].x <= xb && pieces[i].y >= ya && pieces[i].y <= yb);
      this.board.select(ids);
      this.say(`${ids.length} piece(s) selected`);
      return;
    }
    this.handleAngle = 0;
    this.board.commit();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const p = this.local(e);
    const overSelected = (() => {
      if (this.locked) return false;
      const hit = this.pieceAt(this.wx(p.x), this.wy(p.y));
      return hit >= 0 && this.board.selection.has(hit);
    })();
    // ctrlKey marks a trackpad pinch, which always zooms
    if (overSelected && !e.ctrlKey) {
      const pivot = this.board.selectionPivot()!;
      const fine = e.altKey ? 0.1 : 1;
      this.board.begin();
      this.board.rotateSelection(-e.deltaY * 0.0015 * fine, pivot.x, pivot.y);
      // one undo step per burst of wheel events
      clearTimeout(this.wheelTimer);
      this.wheelTimer = window.setTimeout(() => this.board.commit(), 300);
    } else {
      this.zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    }
  }

  private onKey(e: KeyboardEvent): void {
    const b = this.board;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (this.locked) {
      if (key === "f" && !mod) this.fit();
      else if ((key === "+" || key === "=") && !mod) this.zoomAt(this.w / 2, this.h / 2, 1.25);
      else if (key === "-" && !mod) this.zoomAt(this.w / 2, this.h / 2, 0.8);
      else return;
      e.preventDefault();
      return;
    }
    const arrows: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, 1],
      ArrowDown: [0, -1],
    };
    if (key in arrows) {
      e.preventDefault();
      if (!b.selection.size) return;
      const [ux, uy] = arrows[key];
      if (e.shiftKey) {
        const t = b.step(() => b.snapSelection(ux, uy));
        this.say(t > 0 ? `moved ${t.toFixed(4)} to contact` : "nothing to touch in that direction");
      } else {
        const d = e.altKey ? 0.01 : 0.1;
        b.step(() => b.translateSelection(ux * d, uy * d));
      }
      return;
    }
    if ((key === "q" || key === "e") && !mod) {
      const pivot = b.selectionPivot();
      if (!pivot) return;
      const deg = e.shiftKey ? 15 : e.altKey ? 0.1 : 1;
      const sign = key === "q" ? 1 : -1;
      b.step(() => b.rotateSelection((sign * deg * Math.PI) / 180, pivot.x, pivot.y));
      e.preventDefault();
      return;
    }
    if ((key === "n" || key === "p") && !mod && b.state.pieces.length) {
      // N and P step through the pieces (Tab is left alone so that it always leaves the canvas);
      // with Shift the piece is added to the selection
      const n = b.state.pieces.length;
      const dir = key === "n" ? 1 : -1;
      const cur = this.cursor >= 0 && this.cursor < n ? this.cursor : dir === 1 ? -1 : 0;
      this.cursor = (cur + dir + n) % n;
      b.select(e.shiftKey ? [...b.selection, this.cursor] : [this.cursor]);
      this.say(`piece ${this.cursor + 1} of ${n} selected` + (b.selection.size > 1 ? `, ${b.selection.size} in the selection` : ""));
      e.preventDefault();
      return;
    }
    if (key === "Escape") b.select([]);
    else if (key === "Delete" || key === "Backspace") b.removeSelected();
    else if (key === "a" && mod) b.select(b.state.pieces.map((_, i) => i));
    else if (key === "z" && mod && e.shiftKey) b.redo();
    else if (key === "z" && mod) b.undo();
    else if (key === "y" && mod) b.redo();
    else if (key === "a" && !mod) this.canvas.dispatchEvent(new CustomEvent("add-piece", { bubbles: true }));
    else if (key === "f" && !mod) this.fit();
    else if ((key === "+" || key === "=") && !mod) this.zoomAt(this.w / 2, this.h / 2, 1.25);
    else if (key === "-" && !mod) this.zoomAt(this.w / 2, this.h / 2, 0.8);
    else return;
    e.preventDefault();
  }

  requestDraw(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private path(v: Float64Array): void {
    const ctx = this.ctx;
    ctx.beginPath();
    for (let i = 0; i < v.length; i += 2) {
      if (i === 0) ctx.moveTo(this.sx(v[i]), this.sy(v[i + 1]));
      else ctx.lineTo(this.sx(v[i]), this.sy(v[i + 1]));
    }
    ctx.closePath();
  }

  /**
   * Path of a sketch's working shape: the polygon scaled by `scale` about its centre, dilated by
   * a disk of radius `padding`, i.e. the scaled polygon with each corner replaced by an arc of
   * that radius spanning the turn between its two edge normals (2 pi / N). Scale 0 is the disk
   * itself; a circle piece (N = 0) is a disk of radius `scale` * DISK_RADIUS (diameter `scale`).
   */
  private softPath(N: number, p: { x: number; y: number; theta: number }, scale: number, padding: number, buf: Float64Array | null): void {
    const ctx = this.ctx;
    const z = this.cam.zoom;
    ctx.beginPath();
    if (!N || !buf || scale <= 0) {
      ctx.arc(this.sx(p.x), this.sy(p.y), (N ? padding : scale * DISK_RADIUS) * z, 0, 2 * Math.PI);
      return;
    }
    pieceVertices(N, p, scale, buf);
    if (!(padding > 0)) {
      this.path(buf);
      return;
    }
    // Vertices run counter-clockwise; the outward normal at vertex k points along the centre-to-vertex
    // direction a, and its corner arc runs from a - pi/N to a + pi/N, joining the adjacent edges.
    const segments = Math.max(2, Math.ceil(48 / N));
    for (let k = 0; k < N; k++) {
      const vx = buf[2 * k];
      const vy = buf[2 * k + 1];
      const a = Math.atan2(vy - p.y, vx - p.x);
      for (let j = 0; j <= segments; j++) {
        const t = a - Math.PI / N + ((2 * Math.PI) / N) * (j / segments);
        const x = this.sx(vx + padding * Math.cos(t));
        const y = this.sy(vy + padding * Math.sin(t));
        if (k === 0 && j === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    }
    ctx.closePath();
  }

  private drawGrid(): void {
    const ctx = this.ctx;
    const z = this.cam.zoom;
    // unit grid when it is wide enough to read, otherwise the next decade
    let unit = 1;
    while (unit * z < 14) unit *= 10;
    const x0 = Math.floor(this.wx(0) / unit) * unit;
    const y0 = Math.floor(this.wy(this.h) / unit) * unit;
    ctx.lineWidth = 1;
    for (let x = x0; this.sx(x) <= this.w; x += unit) {
      const major = Math.round(x / unit) % 5 === 0;
      ctx.strokeStyle = major ? this.colors["grid-major"] : this.colors["grid"];
      ctx.beginPath();
      ctx.moveTo(Math.round(this.sx(x)) + 0.5, 0);
      ctx.lineTo(Math.round(this.sx(x)) + 0.5, this.h);
      ctx.stroke();
    }
    for (let y = y0; this.sy(y) >= 0; y += unit) {
      const major = Math.round(y / unit) % 5 === 0;
      ctx.strokeStyle = major ? this.colors["grid-major"] : this.colors["grid"];
      ctx.beginPath();
      ctx.moveTo(0, Math.round(this.sy(y)) + 0.5);
      ctx.lineTo(this.w, Math.round(this.sy(y)) + 0.5);
      ctx.stroke();
    }
  }

  private draw(): void {
    const ctx = this.ctx;
    const sketch = this.sketch;
    const { N, pieces } = sketch ?? this.preview?.config ?? this.board.state;
    const z = this.cam.zoom;
    ctx.fillStyle = this.colors["bg"];
    ctx.fillRect(0, 0, this.w, this.h);
    this.drawGrid();

    const ghost = this.ghost;
    if (ghost && ghost.size > 0) {
      ctx.strokeStyle = this.colors["muted"];
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 5]);
      if (ghost.M === 0) {
        ctx.beginPath();
        ctx.arc(this.sx(ghost.cx), this.sy(ghost.cy), (ghost.size / 2) * z, 0, 2 * Math.PI);
      } else {
        this.path(containerVertices(ghost));
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const c = sketch?.container ?? this.preview?.container ?? this.board.container;
    if (c && c.size > 0) {
      ctx.strokeStyle = this.colors["container"];
      ctx.lineWidth = 2;
      if (c.M === 0) {
        ctx.beginPath();
        ctx.arc(this.sx(c.cx), this.sy(c.cy), (c.size / 2) * z, 0, 2 * Math.PI);
      } else {
        this.path(containerVertices(c));
      }
      ctx.stroke();
    }

    const buf = N ? new Float64Array(2 * N) : null;
    const outline = (i: number) => {
      const p = pieces[i];
      if (sketch) this.softPath(N, p, sketch.scale, sketch.padding, buf);
      else if (buf) this.path(pieceVertices(N, p, 1, buf));
      else {
        ctx.beginPath();
        ctx.arc(this.sx(p.x), this.sy(p.y), DISK_RADIUS * z, 0, 2 * Math.PI);
      }
    };
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let pass = 0; pass < 2; pass++) {
      // selected pieces are drawn last so their outline is never hidden
      for (let i = 0; i < pieces.length; i++) {
        const sel = !this.locked && this.board.selection.has(i);
        if (sel !== (pass === 1)) continue;
        const p = pieces[i];
        if (sketch && buf) {
          // A dotted outline of the true polygon around each working shape shows what it becomes.
          this.path(pieceVertices(N, p, 1, buf));
          ctx.strokeStyle = this.colors["muted"];
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        outline(i);
        ctx.fillStyle = this.colors[sel ? "sel" : "piece"];
        // Working shapes may overlap; translucency keeps the overlaps visible.
        if (sketch) ctx.globalAlpha = 0.7;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = this.colors[sel ? "sel-stroke" : "piece-stroke"];
        ctx.lineWidth = sel ? 3 : 1.25;
        // selection is shown by a dashed, thicker outline as well as by colour
        ctx.setLineDash(sel ? [7, 4] : []);
        ctx.stroke();
        ctx.setLineDash([]);
        if (sel && N) {
          // tick from the centre toward vertex 0 shows the orientation
          const R = 0.5 / Math.sin(Math.PI / N);
          ctx.beginPath();
          ctx.moveTo(this.sx(p.x), this.sy(p.y));
          ctx.lineTo(this.sx(p.x + 0.6 * R * Math.cos(p.theta + Math.PI / 2)), this.sy(p.y + 0.6 * R * Math.sin(p.theta + Math.PI / 2)));
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        if (z >= 34) {
          ctx.fillStyle = this.colors["text"];
          ctx.fillText(String(i + 1), this.sx(p.x), this.sy(p.y) + (sel && N ? 12 : 0));
        }
      }
    }

    if (sketch) {
      ctx.fillStyle = this.colors["text"];
      ctx.textAlign = "left";
      ctx.fillText("Solver working shapes — not a valid packing; the result is the true pieces", 14, 20);
      ctx.fillText(sketch.label, 14, 36);
      ctx.textAlign = "center";
    } else if (this.preview && this.previewLabel !== null) {
      ctx.fillStyle = this.colors["text"];
      ctx.textAlign = "left";
      ctx.fillText(this.previewLabel, 14, 20);
      ctx.textAlign = "center";
    }

    const snap = this.snapGuide;
    if (snap) {
      ctx.strokeStyle = this.colors["sel-stroke"];
      ctx.fillStyle = this.colors["bg"];
      ctx.lineWidth = 3;
      if (snap.guide.length > 1) {
        ctx.beginPath();
        ctx.moveTo(this.sx(snap.guide[0].x), this.sy(snap.guide[0].y));
        ctx.lineTo(this.sx(snap.guide[1].x), this.sy(snap.guide[1].y));
        ctx.stroke();
      }
      for (const p of snap.guide) {
        ctx.beginPath();
        ctx.arc(this.sx(p.x), this.sy(p.y), 5, 0, 2 * Math.PI);
        ctx.fill();
        ctx.stroke();
      }
      ctx.fillStyle = this.colors["text"];
      ctx.textAlign = "left";
      ctx.fillText(snap.kind === "edge" ? "Face snap" : snap.kind === "corner" ? "Corner snap" : "Corner / edge snap", 14, 20);
      ctx.textAlign = "center";
    }

    const rh = this.rotateHandle();
    if (rh) {
      ctx.strokeStyle = this.colors["sel-stroke"];
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(rh.px, rh.py);
      ctx.lineTo(rh.x, rh.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(rh.x, rh.y, HANDLE_RADIUS_PX, 0, 2 * Math.PI);
      ctx.fillStyle = this.colors["bg"];
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = this.colors["text"];
      ctx.fillText("⟳", rh.x, rh.y + 1);
    }
    const ph = this.phiHandle();
    if (ph) {
      ctx.strokeStyle = this.colors["container"];
      ctx.lineWidth = 2;
      ctx.fillStyle = this.colors["bg"];
      ctx.fillRect(ph.x - 8, ph.y - 8, 16, 16);
      ctx.strokeRect(ph.x - 8, ph.y - 8, 16, 16);
      ctx.fillStyle = this.colors["text"];
      ctx.fillText("φ", ph.x, ph.y);
    }
    const g = this.gesture;
    if (g?.kind === "marquee") {
      ctx.strokeStyle = this.colors["muted"];
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.strokeRect(this.sx(g.x0), this.sy(g.y0), this.sx(g.x1) - this.sx(g.x0), this.sy(g.y1) - this.sy(g.y0));
      ctx.setLineDash([]);
    }
  }
}
