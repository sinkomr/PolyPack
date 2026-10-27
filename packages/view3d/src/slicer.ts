/**
 * Slices of the boundary by the hyperplane x_k = t. Inside the polytope's range the slice of the
 * boundary is a closed surface (the surface of a cube for the tesseract): each cell the hyperplane
 * crosses gives one face, tinted with that cell's colour, and each part in it gives a flat
 * cross-section on that face. At an end of the range the slice is a whole cell, drawn solid with its
 * parts. Coordinates are R^4 without x_k, in increasing order, drawn with the last one up.
 *
 * One live slice follows the slider; the strip shows nine fixed slices side by side. Moving the
 * slider rewrites preallocated buffers only.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  type InterleavedBufferAttribute,
  Mesh,
  PerspectiveCamera,
  type Raycaster,
  Scene,
  Vector2,
  type WebGLRenderer,
} from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { ORDER_FACE, ORDER_SOLID, Trash, cellBox, faceMaterial, lightRig, segments } from "./kit";
import { gridLayout, type Tile } from "./layout";
import type { Model } from "./model";
import { axisName, fmt } from "./palette";
import { type Ctx, type Layers, type SceneView, toNdc } from "./scene";
import { ballRadius } from "./clip";
import { MAX_SECTION, SLICE_CUT, SLICE_WHOLE, SliceScratch, ballSection, polytopeSection, slicePlane, stripPositions } from "./slice";

const FOV = 26;
const LABEL = 24;
const GAP = 8;
/** Points a part's section may have (a 96-gon and the cuts of its planes). */
const CAP = 128;
const FRAME_CAP = 32;
const NONE = new Float64Array(0);

/** Per cell: cell-local -> slice coordinates (R^4 without x_k), and the face's outward normal there. */
interface CellMap {
  L: Float64Array; // 3x3 row-major
  b: Float64Array; // 3
  n: Float64Array; // 3, unit (zero for a cell parallel to the hyperplane)
  verts: Float64Array; // the cell's vertices at s, xyz
  edges: Int32Array;
}

interface Section {
  part: number;
  cell: number;
  mesh: Mesh;
  pos: BufferAttribute;
  lines: LineSegments2;
}

interface Frame {
  cell: number;
  mesh: Mesh;
  pos: BufferAttribute;
  lines: LineSegments2;
}

/** One slice x_k = t: the frame (cells' faces), the sections, and the whole cells for the ends. */
class SliceGroup {
  readonly group = new Group();
  private readonly frames: Frame[] = [];
  private readonly sections: Section[] = [];
  private readonly wholes: { cell: number; group: Group; pick: Mesh[] }[] = [];
  readonly pick: Mesh[] = [];
  t = 0;
  /** The cell drawn whole, or -1 when the slice is a surface. */
  whole = -1;

  constructor(
    private readonly owner: SliceScene,
    private readonly model: Model,
    private readonly k: number,
    trash: Trash,
  ) {
    const { ctx } = owner;
    const poly = ctx.engine.polytope;
    const colors = ctx.cellColors();
    const tint = new Color();
    poly.cells.forEach((cell, ci) => {
      const map = owner.maps[ci];
      if (map.n[0] === 0 && map.n[1] === 0 && map.n[2] === 0) {
        // parallel to the hyperplane: drawn whole at the ends of the range
        const g = new Group();
        g.matrixAutoUpdate = false;
        const L = map.L;
        g.matrix.set(L[0], L[1], L[2], map.b[0], L[3], L[4], L[5], map.b[1], L[6], L[7], L[8], map.b[2], 0, 0, 0, 1);
        const box = cellBox(cell, model.s, (f) => colors[cell.facets[f].neighbor], owner.wholeFaces, ctx.cellEdge, trash);
        g.add(box.group);
        const pick: Mesh[] = [];
        for (const p of model.byCell[ci]) {
          const part = model.parts[p];
          const m = new Mesh(model.geoms[p]!, [model.looks.surface[part.piece], model.looks.cut[part.piece]]);
          m.renderOrder = ORDER_SOLID;
          m.userData.piece = part.piece;
          g.add(m);
          pick.push(m);
          const l = segments(model.meshes[p]!.lines, model.looks.line[part.piece]);
          trash.add(l.geometry);
          g.add(l);
        }
        g.visible = false;
        this.group.add(g);
        this.wholes.push({ cell: ci, group: g, pick });
        return;
      }
      // a face of the slice surface, in the cell's own colour
      const fg = trash.add(new BufferGeometry());
      const fpos = new BufferAttribute(new Float32Array(FRAME_CAP * 9), 3);
      fg.setAttribute("position", fpos);
      this.geometryOf.set(fpos, fg);
      const col = new Float32Array(FRAME_CAP * 9);
      tint.setStyle(colors[ci]);
      for (let i = 0; i < col.length; i += 3) col.set([tint.r, tint.g, tint.b], i);
      fg.setAttribute("color", new BufferAttribute(col, 3));
      const fm = new Mesh(fg, owner.frameFaces);
      fm.renderOrder = ORDER_FACE;
      fm.frustumCulled = false;
      const fl = segments(new Float32Array(FRAME_CAP * 6), ctx.cellEdge);
      fl.frustumCulled = false;
      trash.add(fl.geometry);
      this.group.add(fm, fl);
      this.frames.push({ cell: ci, mesh: fm, pos: fpos, lines: fl });
      // the sections of its parts
      for (const p of model.byCell[ci]) {
        const part = model.parts[p];
        const g = trash.add(new BufferGeometry());
        const pos = new BufferAttribute(new Float32Array(CAP * 9), 3);
        g.setAttribute("position", pos);
        this.geometryOf.set(pos, g);
        const nor = new Float32Array(CAP * 9);
        for (let i = 0; i < nor.length; i += 3) nor.set([map.n[0], map.n[1], map.n[2]], i);
        g.setAttribute("normal", new BufferAttribute(nor, 3));
        const m = new Mesh(g, model.looks.section[part.piece]);
        m.renderOrder = ORDER_SOLID;
        m.frustumCulled = false;
        m.userData.piece = part.piece;
        const l = segments(new Float32Array(CAP * 6), model.looks.line[part.piece]);
        l.frustumCulled = false;
        trash.add(l.geometry);
        this.group.add(m, l);
        this.sections.push({ part: p, cell: ci, mesh: m, pos, lines: l });
      }
    });
  }

  /** Moves the slice to t: allocation free. */
  update(t: number) {
    this.t = t;
    const { owner, model, k } = this;
    const poly = owner.ctx.engine.polytope;
    const plane = owner.plane;
    const sc = owner.scratch;
    // a whole cell at the ends
    this.whole = -1;
    const wholes = this.wholes;
    let held: Mesh[] | null = null;
    for (let i = 0; i < wholes.length; i++) {
      const w = wholes[i];
      const on = slicePlane(poly.cells[w.cell], k, t, model.s, plane) === SLICE_WHOLE;
      w.group.visible = on;
      if (on) {
        this.whole = w.cell;
        held = w.pick;
      }
    }
    const surface = this.whole < 0;
    this.pick.length = 0;
    if (held) for (let i = 0; i < held.length; i++) this.pick.push(held[i]);
    // sections sit a hair outside the face they lie on, so that its tint does not cover them
    const eps = 0.0015 * model.s;
    for (let fi = 0; fi < this.frames.length; fi++) {
      const f = this.frames[fi];
      let n = 0;
      if (surface && slicePlane(poly.cells[f.cell], k, t, model.s, plane) === SLICE_CUT) {
        const map = owner.maps[f.cell];
        n = polytopeSection(sc, map.verts, map.edges, plane, NONE);
      }
      this.write(f.cell, n, f.pos, f.lines, 0, FRAME_CAP);
      f.mesh.visible = n >= 3;
      f.lines.visible = n >= 3;
    }
    for (let xi = 0; xi < this.sections.length; xi++) {
      const x = this.sections[xi];
      let n = 0;
      if (surface && slicePlane(poly.cells[x.cell], k, t, model.s, plane) === SLICE_CUT) {
        const verts = model.verts[x.part];
        n =
          verts && model.edges
            ? polytopeSection(sc, verts, model.edges, plane, model.planes[x.part])
            : ballSection(sc, model.parts[x.part].place.b, plane, model.planes[x.part], 96, undefined, ballRadius(model.parts[x.part].place.A));
      }
      this.write(x.cell, n, x.pos, x.lines, eps, CAP);
      x.mesh.visible = n >= 3;
      x.lines.visible = n >= 3;
      if (n >= 3) this.pick.push(x.mesh);
    }
  }

  /**
   * Maps the polygon in the scratch (n points, cell-local) to slice coordinates, pushed eps along
   * the face's outward normal, and writes it as a fan (counter-clockwise outside) and as an outline.
   */
  private write(cell: number, n: number, pos: BufferAttribute, lines: LineSegments2, eps: number, cap: number) {
    const map = this.owner.maps[cell];
    const src = this.owner.scratch.out;
    const P = this.owner.mapped;
    if (n > cap) n = cap;
    const L = map.L;
    const nx = map.n[0], ny = map.n[1], nz = map.n[2];
    for (let i = 0; i < n; i++) {
      const x = src[3 * i], y = src[3 * i + 1], z = src[3 * i + 2];
      P[3 * i] = L[0] * x + L[1] * y + L[2] * z + map.b[0] + eps * nx;
      P[3 * i + 1] = L[3] * x + L[4] * y + L[5] * z + map.b[1] + eps * ny;
      P[3 * i + 2] = L[6] * x + L[7] * y + L[8] * z + map.b[2] + eps * nz;
    }
    // orientation against the outward normal (Newell)
    let ax = 0, ay = 0, az = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      ax += (P[3 * i + 1] - P[3 * j + 1]) * (P[3 * i + 2] + P[3 * j + 2]);
      ay += (P[3 * i + 2] - P[3 * j + 2]) * (P[3 * i] + P[3 * j]);
      az += (P[3 * i] - P[3 * j]) * (P[3 * i + 1] + P[3 * j + 1]);
    }
    const rev = ax * nx + ay * ny + az * nz < 0;
    const out = pos.array as Float32Array;
    let w = 0;
    for (let i = 1; i + 1 < n; i++) {
      const b = rev ? i + 1 : i;
      const c = rev ? i : i + 1;
      out[w++] = P[0];
      out[w++] = P[1];
      out[w++] = P[2];
      out[w++] = P[3 * b];
      out[w++] = P[3 * b + 1];
      out[w++] = P[3 * b + 2];
      out[w++] = P[3 * c];
      out[w++] = P[3 * c + 1];
      out[w++] = P[3 * c + 2];
    }
    if (w > 0) {
      pos.clearUpdateRanges();
      pos.addUpdateRange(0, w);
      pos.needsUpdate = true;
    }
    (this.geometryOf.get(pos) as BufferGeometry).setDrawRange(0, w / 3);
    // the outline sits a little further out than the fill
    const g = lines.geometry;
    const la = g.attributes.instanceStart as InterleavedBufferAttribute;
    const out2 = la.data.array as Float32Array;
    const lift = eps * 0.4;
    let m = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      out2[m++] = P[3 * i] + lift * nx;
      out2[m++] = P[3 * i + 1] + lift * ny;
      out2[m++] = P[3 * i + 2] + lift * nz;
      out2[m++] = P[3 * j] + lift * nx;
      out2[m++] = P[3 * j + 1] + lift * ny;
      out2[m++] = P[3 * j + 2] + lift * nz;
    }
    if (m > 0) la.data.needsUpdate = true;
    g.instanceCount = n >= 3 ? n : 0;
  }

  /** Each dynamic position attribute's geometry, for its draw range. */
  private readonly geometryOf = new Map<BufferAttribute, BufferGeometry>();
}

export class SliceScene implements SceneView {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(FOV, 1, 0.01, 1000);
  readonly frameFaces = faceMaterial(0.13);
  readonly wholeFaces = faceMaterial(0.16);
  readonly plane = new Float64Array(4);
  readonly scratch = new SliceScratch();
  readonly mapped = new Float64Array(3 * MAX_SECTION);
  maps: CellMap[] = [];
  private readonly root = new Group();
  private readonly rig;
  private readonly trash = new Trash();
  private model: Model | null = null;
  private live: SliceGroup | null = null;
  private strip: SliceGroup[] = [];
  private stripMode = false;
  private axis: number;
  private t = 0;
  private lo = -0.5;
  private hi = 0.5;
  private radius = 1;
  private W = 1;
  private H = 1;
  private tiles: Tile[] = [];
  private readonly cards: HTMLElement[] = [];
  private readonly titles: HTMLElement[] = [];
  private readonly ndc = new Vector2();

  constructor(
    readonly ctx: Ctx,
    private readonly layers: Layers,
  ) {
    this.axis = ctx.engine.polytope.d - 1;
    this.root.rotation.x = -Math.PI / 2;
    this.scene.add(this.root, this.camera);
    this.scene.environment = ctx.env;
    this.scene.environmentIntensity = 0.55;
    this.rig = lightRig(this.camera);
  }

  /** The slider's range [lo, hi] for the current axis at the current s. */
  get range(): [number, number] {
    return [this.lo, this.hi];
  }

  get position(): number {
    return this.t;
  }

  get axisIndex(): number {
    return this.axis;
  }

  get isStrip(): boolean {
    return this.stripMode;
  }

  build(model: Model | null) {
    this.model = model;
    this.rebuild();
  }

  /** Rebuilds the groups (new configuration or axis). */
  private rebuild() {
    this.root.clear();
    this.trash.empty();
    this.live = null;
    this.strip = [];
    const model = this.model;
    if (!model) {
      this.updateTitles();
      return;
    }
    const { polytope: poly, toAmbient } = this.ctx.engine;
    const k = this.axis;
    const s = model.s;
    // the range of x_k over the polytope, and the slice's radius
    let lo = Infinity;
    let hi = -Infinity;
    let r = 0;
    for (const v of poly.vertices) {
      lo = Math.min(lo, v[k] * s);
      hi = Math.max(hi, v[k] * s);
      let q = 0;
      for (let j = 0; j < v.length; j++) if (j !== k) q += v[j] * v[j];
      r = Math.max(r, Math.sqrt(q) * s);
    }
    const keep = (this.t - this.lo) / (this.hi - this.lo || 1);
    this.lo = lo;
    this.hi = hi;
    this.t = Number.isFinite(keep) ? lo + Math.min(1, Math.max(0, keep)) * (hi - lo) : (lo + hi) / 2;
    this.radius = r;
    this.maps = poly.cells.map((cell) => {
      const x0 = toAmbient(cell.index, [0, 0, 0], s);
      const drop = (x: number[]) => x.filter((_, j) => j !== k);
      const b = drop(x0);
      const cols = [0, 1, 2].map((l) => {
        const e = [0, 0, 0];
        e[l] = 1;
        const x = toAmbient(cell.index, e, s);
        return drop(x).map((v, j) => v - b[j]);
      });
      const L = new Float64Array(9);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) L[3 * i + j] = cols[j][i];
      const nn = drop(cell.normal);
      const l = Math.hypot(...nn);
      const n = new Float64Array(l > 1e-9 ? nn.map((v) => v / l) : [0, 0, 0]);
      const verts = new Float64Array(cell.vertices.flatMap((v) => v.map((x) => x * s)));
      const edges = Int32Array.from(cell.hinges.flat());
      return { L, b: new Float64Array(b), n, verts, edges };
    });
    this.live = new SliceGroup(this, model, k, this.trash);
    this.root.add(this.live.group);
    this.live.update(this.t);
    this.strip = stripPositions(lo, hi, 9).map((t) => {
      const g = new SliceGroup(this, model, k, this.trash);
      g.update(t);
      g.group.visible = false;
      this.root.add(g.group);
      return g;
    });
    this.live.group.visible = !this.stripMode;
    this.updateTitles();
  }

  /** Moves the live slice. */
  setPosition(t: number) {
    this.t = Math.min(this.hi, Math.max(this.lo, t));
    this.live?.update(this.t);
  }

  setAxis(k: number) {
    if (k === this.axis) return;
    this.axis = k;
    this.rebuild();
    this.resize(this.W, this.H);
  }

  setStrip(on: boolean) {
    this.stripMode = on;
    if (this.live) this.live.group.visible = !on;
    this.resize(this.W, this.H);
  }

  /** "w = 0.250", with the cell when the slice is a whole cell. */
  label(t: number, whole: number): string {
    const v = `${axisName(this.axis)} = ${fmt(t)}`;
    return whole >= 0 ? `${v}: cell ${this.ctx.names[whole]}` : v;
  }

  /** A strip tile's title: the position, or the cell first when the slice is a whole cell. */
  private paintTitle(title: HTMLElement, g: SliceGroup) {
    const v = `${axisName(this.axis)} = ${fmt(g.t)}`;
    const name = document.createElement("span");
    name.className = "pp3-name";
    const where = document.createElement("span");
    where.className = "pp3-where";
    if (g.whole >= 0) {
      name.textContent = `cell ${this.ctx.names[g.whole]}`;
      where.textContent = v;
    } else {
      name.textContent = v;
    }
    title.replaceChildren(name, where);
    title.setAttribute("aria-label", this.label(g.t, g.whole));
  }

  get liveText(): string {
    return this.live ? this.label(this.t, this.live.whole) : "";
  }

  private updateTitles() {
    const n = this.stripMode && this.model ? this.strip.length : 0;
    while (this.cards.length < n) {
      const card = document.createElement("div");
      card.className = "pp3-card";
      this.layers.under.append(card);
      this.cards.push(card);
      const title = document.createElement("div");
      title.className = "pp3-title";
      this.layers.over.append(title);
      this.titles.push(title);
    }
    this.cards.forEach((c, i) => (c.hidden = i >= n));
    this.titles.forEach((c, i) => {
      c.hidden = i >= n;
      if (i < n) this.paintTitle(c, this.strip[i]);
    });
  }

  resize(W: number, H: number) {
    this.W = Math.max(1, W);
    this.H = Math.max(1, H);
    this.updateTitles();
    if (this.stripMode) {
      const g = gridLayout(this.strip.length || 9, this.W - 2 * GAP, this.H - 2 * GAP, { gap: GAP, label: LABEL });
      this.tiles = g.tiles.map((t) => ({ ...t, x: t.x + GAP, y: t.y + GAP, view: { ...t.view, x: t.view.x + GAP, y: t.view.y + GAP } }));
      this.tiles.forEach((t, i) => {
        const card = this.cards[i];
        const title = this.titles[i];
        if (!card || !title) return;
        Object.assign(card.style, { left: `${t.x}px`, top: `${t.y}px`, width: `${t.w}px`, height: `${t.h}px` });
        Object.assign(title.style, { left: `${t.x}px`, top: `${t.y}px`, width: `${t.w}px`, height: `${LABEL}px` });
        title.classList.toggle("pp3-small", t.w < 150);
      });
      this.camera.aspect = 1;
    } else {
      this.tiles = [];
      this.camera.aspect = this.W / this.H;
    }
    this.camera.updateProjectionMatrix();
  }

  render(r: WebGLRenderer) {
    const lines = this.ctx.lines;
    if (!this.stripMode) {
      r.setViewport(0, 0, this.W, this.H);
      r.setScissor(0, 0, this.W, this.H);
      lines.resolution(this.W, this.H);
      r.render(this.scene, this.camera);
      return;
    }
    for (let i = 0; i < this.tiles.length && i < this.strip.length; i++) {
      const v = this.tiles[i].view;
      const y = this.H - v.y - v.size;
      r.setViewport(v.x, y, v.size, v.size);
      r.setScissor(v.x, y, v.size, v.size);
      for (let j = 0; j < this.strip.length; j++) this.strip[j].group.visible = j === i;
      lines.resolution(v.size, v.size);
      r.render(this.scene, this.camera);
    }
  }

  pick(x: number, y: number, ray: Raycaster): number | null {
    let g: SliceGroup | null = null;
    if (!this.stripMode) {
      g = this.live;
      toNdc(x, y, 0, 0, this.W, this.H, this.ndc);
    } else {
      for (let i = 0; i < this.tiles.length && i < this.strip.length; i++) {
        const v = this.tiles[i].view;
        if (x < v.x || x > v.x + v.size || y < v.y || y > v.y + v.size) continue;
        g = this.strip[i];
        toNdc(x, y, v.x, v.y, v.size, v.size, this.ndc);
      }
    }
    if (!g) return null;
    ray.setFromCamera(this.ndc, this.camera);
    for (const m of g.pick) m.geometry.computeBoundingSphere();
    const hit = ray.intersectObjects(g.pick, false)[0];
    return hit ? (hit.object.userData.piece as number) : null;
  }

  home(controls: OrbitControls) {
    const half = ((FOV / 2) * Math.PI) / 180;
    const aspect = this.stripMode ? 1 : this.W / this.H;
    const hHalf = Math.atan(Math.tan(half) * aspect);
    const d = (this.radius / Math.sin(Math.min(half, hHalf))) * 1.03;
    controls.target.set(0, 0, 0);
    this.camera.position.set(1.25, 0.85, 1.7).normalize().multiplyScalar(d);
    this.camera.near = d / 50;
    this.camera.far = d * 10;
    this.camera.updateProjectionMatrix();
    controls.minDistance = d * 0.4;
    controls.maxDistance = d * 4;
    controls.update();
  }

  recolor() {
    this.rebuild();
  }

  describe(): string {
    if (!this.model) return "No packing to draw.";
    const ax = axisName(this.axis);
    if (this.stripMode) return `Nine slices ${ax} = constant side by side, from one end of the polytope to the other, with the pieces' cross-sections.`;
    const whole = this.live?.whole ?? -1;
    if (whole >= 0) return `The slice ${ax} = ${fmt(this.t)} is the whole cell ${this.ctx.names[whole]}, drawn with its parts.`;
    return `The slice ${ax} = ${fmt(this.t)} of the boundary: a closed surface whose faces come from the cells it crosses, with the pieces' cross-sections on it.`;
  }

  dispose() {
    this.model = null;
    this.rebuild();
    this.frameFaces.dispose();
    this.wholeFaces.dispose();
    this.rig.dispose();
    for (const e of [...this.cards, ...this.titles]) e.remove();
  }

  set active(on: boolean) {
    for (const e of [...this.cards, ...this.titles]) e.hidden = !on || !this.stripMode;
    if (on) this.updateTitles();
  }
}
