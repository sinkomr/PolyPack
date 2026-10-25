/**
 * The net, and its fold into the polytope. At fold 0 the cells lie flat as the engine's net (the
 * Dali cross for the tesseract), pieces drawn through net placement after part placement. Moving
 * the fold turns every tree edge about its ridge into the fourth dimension (fold.ts); the scene is
 * seen from a 4D eye, so at full fold it is the classic projection of the polytope with the root
 * cell outermost, its parts faded so that the other cells show through it.
 *
 * Each cell's map (cell-local -> view) is projective: a 4x4 matrix H with a non-trivial last row.
 * It is the matrix of the cell's group, and the cell's meshes keep their cell-local geometry; the
 * materials divide by w and map normals by H's inverse transpose on the GPU (kit.ts, projective).
 * A fold step therefore sets eight matrices and moves no vertex. Picking, which three.js cannot do
 * through a projective matrix, projects the parts on the CPU, once per fold position.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Mesh,
  PerspectiveCamera,
  type Raycaster,
  Scene,
  Vector2,
  Vector3,
  type WebGLRenderer,
} from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { Cell } from "@polypack/boundary";
import { cellEdges, cellFaces } from "./clip";
import { Folder } from "./fold";
import { Looks, ORDER_FACE, ORDER_SOLID, Trash, WIDTH, faceMaterial, lightRig, projectiveLine, projectiveSurface, segments } from "./kit";
import type { Model } from "./model";
import { type Ctx, Label, type SceneView, toNdc } from "./scene";

const FOV = 34;
const ORIGIN3 = [0, 0, 0];

/** det of a 4x4 row-major matrix. */
function det4(m: Float64Array): number {
  const s0 = m[0] * m[5] - m[4] * m[1];
  const s1 = m[0] * m[6] - m[4] * m[2];
  const s2 = m[0] * m[7] - m[4] * m[3];
  const s3 = m[1] * m[6] - m[5] * m[2];
  const s4 = m[1] * m[7] - m[5] * m[3];
  const s5 = m[2] * m[7] - m[6] * m[3];
  const c5 = m[10] * m[15] - m[14] * m[11];
  const c4 = m[9] * m[15] - m[13] * m[11];
  const c3 = m[9] * m[14] - m[13] * m[10];
  const c2 = m[8] * m[15] - m[12] * m[11];
  const c1 = m[8] * m[14] - m[12] * m[10];
  const c0 = m[8] * m[13] - m[12] * m[9];
  return s0 * c5 - s1 * c4 + s2 * c3 + s3 * c2 - s4 * c1 + s5 * c0;
}

/** Writes positions (triangles, cell-local) projected by H into dst. */
function projectPositions(H: Float64Array, src: Float32Array, dst: Float32Array) {
  for (let v = 0; v < src.length; v += 3) {
    const x = src[v];
    const y = src[v + 1];
    const z = src[v + 2];
    const W = H[12] * x + H[13] * y + H[14] * z + H[15];
    dst[v] = (H[0] * x + H[1] * y + H[2] * z + H[3]) / W;
    dst[v + 1] = (H[4] * x + H[5] * y + H[6] * z + H[7]) / W;
    dst[v + 2] = (H[8] * x + H[9] * y + H[10] * z + H[11]) / W;
  }
}

function cssRgb(css: string): [number, number, number] {
  const c = new Color().setStyle(css);
  return [c.r, c.g, c.b];
}

/** A part as drawn (cell-local, through its cell's matrix) and as picked (projected on the CPU). */
interface PickPart {
  cell: number;
  src: Float32Array;
  pick: Mesh;
}

export class NetScene implements SceneView {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(FOV, 1, 0.01, 1000);
  private readonly root = new Group();
  private readonly faces = faceMaterial(0.2);
  private readonly edge: LineMaterial;
  private readonly rig;
  private readonly trash = new Trash();
  private model: Model | null = null;
  private folder: Folder | null = null;
  private fold = 0;
  /** One group per cell, its matrix the cell's projective map. */
  private groups: Group[] = [];
  private picks: PickPart[] = [];
  private pickDirty = true;
  private labels: Label[] = [];
  private labelCells: number[] = [];
  /** The look of the parts, and of the root cell's parts, which fade as the net closes around them. */
  private looks: Looks | null = null;
  private rootLooks: Looks | null = null;
  private W = 1;
  private H = 1;
  private readonly ndc = new Vector2();
  private readonly centre = new Vector3();
  private fitRadius = 1;
  /** The camera distance that framed the figure at the last fold (the user's zoom is relative to it). */
  private fitDist = 0;
  private controls: OrbitControls | null = null;
  private readonly tmp = new Vector3();
  private readonly p3 = [0, 0, 0];

  constructor(private readonly ctx: Ctx) {
    this.root.rotation.x = -Math.PI / 2;
    this.scene.add(this.root, this.camera);
    this.scene.environment = ctx.env;
    this.scene.environmentIntensity = 0.55;
    this.rig = lightRig(this.camera);
    this.edge = projectiveLine(ctx.lines.make({ linewidth: WIDTH.cell, transparent: true, worldUnits: false }));
    projectiveSurface(this.faces);
    this.recolor();
  }

  build(model: Model | null) {
    this.root.clear();
    this.trash.empty();
    for (const l of [this.looks, this.rootLooks]) {
      if (!l) continue;
      this.model?.looks.unfollow(l);
      l.dispose();
    }
    this.looks = this.rootLooks = null;
    for (const l of this.labels) l.dispose();
    this.labels = [];
    this.labelCells = [];
    this.groups = [];
    this.picks = [];
    this.model = model;
    this.folder = null;
    if (!model) return;
    const { polytope: poly, net } = this.ctx.engine;
    const s = model.s;
    const folder = new Folder(poly, net, s);
    this.folder = folder;
    const dark = this.ctx.theme().dark;
    const looks = new Looks(this.ctx.lines, model.count, dark, true);
    const rootLooks = new Looks(this.ctx.lines, model.count, dark, true);
    model.looks.follow(looks);
    model.looks.follow(rootLooks);
    this.looks = looks;
    this.rootLooks = rootLooks;
    const colors = this.ctx.cellColors();
    const theme = this.ctx.theme();
    this.groups = poly.cells.map(() => {
      const g = new Group();
      g.matrixAutoUpdate = false;
      this.root.add(g);
      return g;
    });
    // the faces glued inside the net are not tinted: the tinted ones show where each cell will meet
    const treeFace = new Set<string>();
    for (const p of net) {
      if (!p.parent) continue;
      treeFace.add(`${p.cell}/${p.parent.facet}`);
      const back = poly.cells[p.cell].facets[p.parent.facet];
      treeFace.add(`${p.parent.cell}/${back.neighborFacet}`);
    }
    for (const p of net) {
      const cell = poly.cells[p.cell];
      this.addCell(cell, s, colors, (f) => !treeFace.has(`${p.cell}/${f}`));
      const label = new Label(this.ctx.names[p.cell], colors[p.cell], theme.bg, 0.15 * s);
      this.root.add(label.sprite);
      this.labels.push(label);
      this.labelCells.push(p.cell);
    }
    model.parts.forEach((part, i) => {
      const mesh = model.meshes[i];
      const geo = model.geoms[i];
      if (!mesh || !geo) return;
      const lk = part.cell === folder.root ? rootLooks : looks;
      const m = new Mesh(geo, [lk.surface[part.piece], lk.cut[part.piece]]);
      m.renderOrder = ORDER_SOLID;
      m.frustumCulled = false;
      this.groups[part.cell].add(m);
      const lines = segments(mesh.lines, lk.line[part.piece]);
      lines.frustumCulled = false;
      this.trash.add(lines.geometry);
      this.groups[part.cell].add(lines);
      // for picking: the same triangles, projected on the CPU when needed
      const pg = this.trash.add(new BufferGeometry());
      pg.setAttribute("position", new BufferAttribute(new Float32Array(mesh.positions.length), 3));
      const pick = new Mesh(pg);
      pick.matrixAutoUpdate = false;
      pick.userData.piece = part.piece;
      this.picks.push({ cell: part.cell, src: mesh.positions, pick });
    });
    this.apply();
  }

  private addCell(cell: Cell, s: number, colors: string[], tinted: (facet: number) => boolean) {
    const pos: number[] = [];
    const col: number[] = [];
    for (const f of cellFaces(cell, s)) {
      if (!tinted(f.facet)) continue;
      const rgb = cssRgb(colors[cell.facets[f.facet].neighbor]);
      for (let i = 1; i + 1 < f.pts.length; i++) {
        for (const p of [f.pts[0], f.pts[i], f.pts[i + 1]]) {
          pos.push(p[0], p[1], p[2]);
          col.push(...rgb);
        }
      }
    }
    const g = this.groups[cell.index];
    if (pos.length) {
      const geo = this.trash.add(new BufferGeometry());
      geo.setAttribute("position", new BufferAttribute(Float32Array.from(pos), 3));
      geo.setAttribute("color", new BufferAttribute(Float32Array.from(col), 3));
      const m = new Mesh(geo, this.faces);
      m.renderOrder = ORDER_FACE;
      m.frustumCulled = false;
      g.add(m);
    }
    const l = segments(cellEdges(cell, s), this.edge);
    l.frustumCulled = false;
    this.trash.add(l.geometry);
    g.add(l);
  }

  /** Folds to f in [0, 1]. */
  setFold(f: number) {
    this.fold = Math.min(1, Math.max(0, f));
    this.apply();
  }

  get foldValue(): number {
    return this.fold;
  }

  /** Sets the cells' matrices for the current fold: allocation free. */
  private apply() {
    const F = this.folder;
    if (!F) return;
    F.update(this.fold);
    for (let c = 0; c < this.groups.length; c++) {
      const H = F.H[c];
      // The map turns faces over when det H < 0 (det J = det H / w^4). three.js reads that from the
      // top-left 3x3 alone, assuming an affine matrix; -H is the same projective map (the shaders
      // divide by w), so it gets the sign that makes the 3x3 tell the truth.
      const d3 = H[0] * (H[5] * H[10] - H[6] * H[9]) - H[1] * (H[4] * H[10] - H[6] * H[8]) + H[2] * (H[4] * H[9] - H[5] * H[8]);
      const k = det4(H) < 0 === d3 < 0 ? 1 : -1;
      const g = this.groups[c];
      g.matrix.set(
        k * H[0], k * H[1], k * H[2], k * H[3],
        k * H[4], k * H[5], k * H[6], k * H[7],
        k * H[8], k * H[9], k * H[10], k * H[11],
        k * H[12], k * H[13], k * H[14], k * H[15],
      );
      g.matrixWorldNeedsUpdate = true;
    }
    this.pickDirty = true;
    // the tints fade as the cells close up, leaving the classic wire figure; the root cell, which
    // becomes the outer cube around all the others, fades so that they can be seen through it
    this.faces.opacity = 0.2 * (1 - 0.7 * this.fold);
    const f2 = this.fold * this.fold * (3 - 2 * this.fold);
    this.rootLooks?.fade(1 - 0.82 * f2);
    for (let i = 0; i < this.labels.length; i++) {
      const cell = this.labelCells[i];
      const p = F.project(cell, ORIGIN3, this.p3);
      this.labels[i].sprite.position.set(p[0], p[1], p[2]);
      // at full fold the root's centre is the inner cell's: its name fades out
      this.labels[i].opacity = cell === F.root ? 1 - Math.min(1, this.fold * 1.6) : 1;
    }
    this.reframe();
    // labels keep their size on screen
    for (let i = 0; i < this.labels.length; i++) this.labels[i].setHeight(0.1 * this.fitRadius);
  }

  /** Keeps the folding figure framed, keeping the user's turn and relative zoom. */
  private reframe() {
    const F = this.folder;
    if (!F) return;
    // bounding box of the cells' projected vertices
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    const s = this.model!.s;
    const cells = this.ctx.engine.polytope.cells;
    for (let ci = 0; ci < cells.length; ci++) {
      const cell = cells[ci];
      const H = F.H[cell.index];
      for (let vi = 0; vi < cell.vertices.length; vi++) {
        const v = cell.vertices[vi];
        const x = v[0] * s, y = v[1] * s, z = v[2] * s;
        const W = H[12] * x + H[13] * y + H[14] * z + H[15];
        const px = (H[0] * x + H[1] * y + H[2] * z + H[3]) / W;
        const py = (H[4] * x + H[5] * y + H[6] * z + H[7]) / W;
        const pz = (H[8] * x + H[9] * y + H[10] * z + H[11]) / W;
        if (px < x0) x0 = px;
        if (py < y0) y0 = py;
        if (pz < z0) z0 = pz;
        if (px > x1) x1 = px;
        if (py > y1) y1 = py;
        if (pz > z1) z1 = pz;
      }
    }
    const r = 0.5 * Math.hypot(x1 - x0, y1 - y0, z1 - z0);
    // net coordinates -> three's (the root group turns u2 up)
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
    const c = this.controls;
    const fit = this.fitDistance(r);
    if (c && this.fitDist > 0) {
      const zoom = this.camera.position.distanceTo(c.target) / this.fitDist;
      this.tmp.copy(this.camera.position).sub(c.target).normalize();
      c.target.set(cx, cz, -cy);
      this.camera.position.copy(c.target).addScaledVector(this.tmp, fit * zoom);
      c.minDistance = fit * 0.3;
      c.maxDistance = fit * 4;
      c.update();
    }
    this.centre.set(cx, cz, -cy);
    this.fitRadius = r;
    this.fitDist = fit;
  }

  private fitDistance(r: number): number {
    const half = ((FOV / 2) * Math.PI) / 180;
    const aspect = this.W / this.H;
    const hHalf = Math.atan(Math.tan(half) * aspect);
    // the flat net's box overstates its silhouette; the folded figure needs its full sphere
    return (r / Math.sin(Math.min(half, hHalf))) * (0.9 + 0.16 * this.fold);
  }

  resize(W: number, H: number) {
    this.W = Math.max(1, W);
    this.H = Math.max(1, H);
    this.camera.aspect = this.W / this.H;
    this.camera.updateProjectionMatrix();
    // a new shape of the drawing area changes the framing distance: keep the user's zoom relative to it
    const c = this.controls;
    if (c && this.fitDist > 0 && this.folder) {
      const fit = this.fitDistance(this.fitRadius);
      const zoom = this.camera.position.distanceTo(c.target) / this.fitDist;
      this.tmp.copy(this.camera.position).sub(c.target).normalize();
      this.camera.position.copy(c.target).addScaledVector(this.tmp, fit * zoom);
      this.fitDist = fit;
      c.update();
    }
  }

  render(r: WebGLRenderer) {
    r.setViewport(0, 0, this.W, this.H);
    r.setScissor(0, 0, this.W, this.H);
    this.ctx.lines.resolution(this.W, this.H);
    r.render(this.scene, this.camera);
  }

  pick(x: number, y: number, ray: Raycaster): number | null {
    const F = this.folder;
    if (!F) return null;
    if (this.pickDirty) {
      this.root.updateMatrixWorld();
      for (const p of this.picks) {
        const attr = p.pick.geometry.getAttribute("position") as BufferAttribute;
        projectPositions(F.H[p.cell], p.src, attr.array as Float32Array);
        attr.needsUpdate = true;
        p.pick.geometry.computeBoundingSphere();
        p.pick.matrixWorld.copy(this.root.matrixWorld);
      }
      this.pickDirty = false;
    }
    toNdc(x, y, 0, 0, this.W, this.H, this.ndc);
    ray.setFromCamera(this.ndc, this.camera);
    // the root's parts are faint once folded: what is seen through them is picked first
    let best: number | null = null;
    let bestD = Infinity;
    const faded = this.fold > 0.5;
    for (const p of this.picks) {
      const hit = ray.intersectObject(p.pick, false)[0];
      if (!hit) continue;
      const d = hit.distance + (faded && p.cell === F.root ? 1e6 : 0);
      if (d < bestD) {
        bestD = d;
        best = p.pick.userData.piece as number;
      }
    }
    return best;
  }

  home(controls: OrbitControls) {
    this.controls = controls;
    const d = this.fitDistance(this.fitRadius);
    this.fitDist = d;
    controls.target.copy(this.centre);
    this.camera.position.set(0.9, 0.75, 1.6).normalize().multiplyScalar(d).add(this.centre);
    this.camera.near = d / 100;
    this.camera.far = d * 20;
    this.camera.updateProjectionMatrix();
    controls.minDistance = d * 0.3;
    controls.maxDistance = d * 4;
    controls.update();
  }

  /** The controls that turn this scene (kept for reframing while folding). */
  attach(controls: OrbitControls) {
    this.controls = controls;
  }

  recolor() {
    const dark = this.ctx.theme().dark;
    this.edge.color.setStyle(dark ? "#9aa4b2" : "#4f5965");
    this.edge.opacity = dark ? 0.85 : 0.75;
    // the tints and labels are baked at build: the view rebuilds this scene on a scheme change
  }

  describe(): string {
    if (!this.model) return "No packing to draw.";
    const pct = Math.round(this.fold * 100);
    if (pct === 0) return "The net of the cells, laid flat in 3D, with every part of every piece in its cell.";
    if (pct === 100) return "The net folded up into the fourth dimension and seen from a 4D eye: the classic projection, the outer cell nearest the eye.";
    return `The net folded ${pct}% of the way into the fourth dimension, seen from a 4D eye.`;
  }

  dispose() {
    this.build(null);
    this.model = null;
    this.faces.dispose();
    this.ctx.lines.remove(this.edge);
    this.rig.dispose();
  }
}

