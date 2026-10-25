/**
 * The cell atlas: every cell as a small multiple, in its own local coordinates, all turned together
 * by one camera. Each face of a cell is tinted with the colour of the cell glued to it; each part
 * of a piece is drawn clipped to its cell, so a piece that folds across a ridge appears in several
 * tiles in one colour.
 */
import { Group, type Mesh, Mesh as ThreeMesh, PerspectiveCamera, type Raycaster, Scene, Vector2, type WebGLRenderer } from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { cellRadius } from "./clip";
import { ORDER_SOLID, Trash, cellBox, faceMaterial, lightRig, segments } from "./kit";
import { gridLayout, type Tile } from "./layout";
import type { Model } from "./model";
import { axisName, cellAxis, fmt } from "./palette";
import { type Ctx, type Layers, type SceneView, toNdc } from "./scene";

const LABEL = 24;
const GAP = 8;
const FOV = 24;

export class AtlasScene implements SceneView {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(FOV, 1, 0.01, 1000);
  private readonly root = new Group();
  private readonly faces = faceMaterial(0.16);
  private readonly rig;
  private cells: { group: Group; pick: Mesh[]; recolor: () => void }[] = [];
  private tiles: Tile[] = [];
  private readonly cards: HTMLElement[] = [];
  private readonly titles: HTMLElement[] = [];
  private readonly chips: HTMLElement[] = [];
  private readonly trash = new Trash();
  private model: Model | null = null;
  private H = 1;
  private radius = 1;
  private readonly ndc = new Vector2();

  constructor(
    private readonly ctx: Ctx,
    private readonly layers: Layers,
  ) {
    // local coordinates (u0, u1, u2) are drawn with u2 up
    this.root.rotation.x = -Math.PI / 2;
    this.scene.add(this.root, this.camera);
    this.scene.environment = ctx.env;
    this.scene.environmentIntensity = 0.55;
    this.rig = lightRig(this.camera);
    const poly = ctx.engine.polytope;
    poly.cells.forEach((cell, i) => {
      const card = document.createElement("div");
      card.className = "pp3-card";
      layers.under.append(card);
      this.cards.push(card);
      const title = document.createElement("div");
      title.className = "pp3-title";
      const chip = document.createElement("span");
      chip.className = "pp3-chip";
      chip.setAttribute("aria-hidden", "true");
      const name = document.createElement("span");
      name.className = "pp3-name";
      name.textContent = ctx.names[i];
      const where = document.createElement("span");
      where.className = "pp3-where";
      const ax = cellAxis(cell.normal);
      if (ax) where.dataset.axis = String(ax.axis);
      title.append(chip, name, where);
      layers.over.append(title);
      this.titles.push(title);
      this.chips.push(chip);
    });
    this.recolor();
  }

  build(model: Model | null) {
    for (const c of this.cells) this.root.remove(c.group);
    this.cells = [];
    this.trash.empty();
    this.model = model;
    const poly = this.ctx.engine.polytope;
    if (!model) {
      this.updateTitles();
      return;
    }
    const s = model.s;
    this.radius = Math.max(...poly.cells.map((c) => cellRadius(c, s)));
    const colors = this.ctx.cellColors();
    poly.cells.forEach((cell, ci) => {
      const group = new Group();
      const box = cellBox(cell, s, (f) => colors[cell.facets[f].neighbor], this.faces, this.ctx.cellEdge, this.trash);
      group.add(box.group);
      const pick: Mesh[] = [];
      for (const p of model.byCell[ci]) {
        const part = model.parts[p];
        const mesh = new ThreeMesh(model.geoms[p]!, [model.looks.surface[part.piece], model.looks.cut[part.piece]]);
        mesh.renderOrder = ORDER_SOLID;
        mesh.userData.piece = part.piece;
        group.add(mesh);
        pick.push(mesh);
        const lines = segments(model.meshes[p]!.lines, model.looks.line[part.piece]);
        this.trash.add(lines.geometry);
        group.add(lines);
      }
      this.root.add(group);
      this.cells.push({
        group,
        pick,
        recolor: () => {
          const cc = this.ctx.cellColors();
          box.colorFaces((f) => cc[cell.facets[f].neighbor]);
        },
      });
    });
    this.updateTitles();
  }

  private updateTitles() {
    const s = this.model?.s;
    this.titles.forEach((t, i) => {
      const where = t.querySelector(".pp3-where") as HTMLElement;
      const cell = this.ctx.engine.polytope.cells[i];
      const ax = cellAxis(cell.normal);
      where.textContent = ax && s !== undefined ? `${axisName(ax.axis)} = ${fmt(ax.sign * s * Math.abs(cell.origin[ax.axis]))}` : "";
      const n = this.model ? this.model.byCell[i].length : 0;
      t.setAttribute("aria-label", `Cell ${this.ctx.names[i]}: ${n} ${n === 1 ? "part" : "parts"}`);
    });
  }

  resize(W: number, H: number) {
    this.H = H;
    const g = gridLayout(this.ctx.engine.polytope.cells.length, W - 2 * GAP, H - 2 * GAP, { gap: GAP, label: LABEL });
    this.tiles = g.tiles.map((t) => ({ ...t, x: t.x + GAP, y: t.y + GAP, view: { ...t.view, x: t.view.x + GAP, y: t.view.y + GAP } }));
    this.tiles.forEach((t, i) => {
      const card = this.cards[i];
      card.style.left = `${t.x}px`;
      card.style.top = `${t.y}px`;
      card.style.width = `${t.w}px`;
      card.style.height = `${t.h}px`;
      const title = this.titles[i];
      title.style.left = `${t.x}px`;
      title.style.top = `${t.y}px`;
      title.style.width = `${t.w}px`;
      title.style.height = `${LABEL}px`;
      title.classList.toggle("pp3-small", t.w < 150);
    });
    this.camera.aspect = 1;
    this.camera.updateProjectionMatrix();
  }

  render(r: WebGLRenderer) {
    const lines = this.ctx.lines;
    for (let i = 0; i < this.tiles.length && i < this.cells.length; i++) {
      const v = this.tiles[i].view;
      const y = this.H - v.y - v.size;
      r.setViewport(v.x, y, v.size, v.size);
      r.setScissor(v.x, y, v.size, v.size);
      for (let k = 0; k < this.cells.length; k++) this.cells[k].group.visible = k === i;
      lines.resolution(v.size, v.size);
      r.render(this.scene, this.camera);
    }
  }

  pick(x: number, y: number, ray: Raycaster): number | null {
    for (let i = 0; i < this.tiles.length && i < this.cells.length; i++) {
      const v = this.tiles[i].view;
      if (x < v.x || x > v.x + v.size || y < v.y || y > v.y + v.size) continue;
      toNdc(x, y, v.x, v.y, v.size, v.size, this.ndc);
      ray.setFromCamera(this.ndc, this.camera);
      const hit = ray.intersectObjects(this.cells[i].pick, false)[0];
      return hit ? (hit.object.userData.piece as number) : null;
    }
    return null;
  }

  home(controls: OrbitControls) {
    const d = (this.radius / Math.sin(((FOV / 2) * Math.PI) / 180)) * 1.02;
    controls.target.set(0, 0, 0);
    // three's y is the drawing's up (local u2)
    this.camera.position.set(1.25, 0.8, 1.7).normalize().multiplyScalar(d);
    this.camera.near = d / 50;
    this.camera.far = d * 10;
    this.camera.updateProjectionMatrix();
    controls.minDistance = d * 0.4;
    controls.maxDistance = d * 4;
    controls.update();
  }

  recolor() {
    const colors = this.ctx.cellColors();
    this.chips.forEach((c, i) => (c.style.background = colors[i]));
    for (const c of this.cells) c.recolor();
  }

  describe(): string {
    const m = this.model;
    if (!m) return "No packing to draw.";
    const n = this.ctx.engine.polytope.cells.length;
    return `The ${n} cells side by side, each in its own coordinates, with the parts of the pieces it holds. Each face is tinted with the colour of the cell glued to it.`;
  }

  dispose() {
    this.build(null);
    this.faces.dispose();
    this.rig.dispose();
    for (const e of [...this.cards, ...this.titles]) e.remove();
  }

  /** Shows or hides the HTML of this scene. */
  set active(on: boolean) {
    for (const e of [...this.cards, ...this.titles]) e.hidden = !on;
  }
}
