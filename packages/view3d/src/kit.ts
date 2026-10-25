/**
 * The three.js pieces the three views share: one look (materials) per piece, cell boxes, fat lines,
 * the lights and the room environment. Everything made here is registered for disposal.
 */
import {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  FrontSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Material,
  type PerspectiveCamera,
  PMREMGenerator,
  type Texture,
  type WebGLRenderer,
} from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import type { Cell } from "@polypack/boundary";
import { cellEdges, cellFaces, type PartMesh } from "./clip";
import { pieceColor, pieceCutColor, pieceEdgeColor, type Theme } from "./palette";

/** Draw order among transparent objects: solids, then lines, then the cells' tinted faces. */
export const ORDER_SOLID = 0;
export const ORDER_LINE = 1;
export const ORDER_FACE = 2;

/** Anything with a dispose method. */
interface Disposable {
  dispose(): void;
}

/** Collects what must be disposed together (one configuration's drawing, or the whole view). */
export class Trash {
  private items: Disposable[] = [];
  add<T extends Disposable>(x: T): T {
    this.items.push(x);
    return x;
  }
  empty() {
    for (const x of this.items) x.dispose();
    this.items = [];
  }
}

/** Every line material, so that each viewport can set its pixel size before drawing. */
export class LineRegistry {
  private readonly all: LineMaterial[] = [];
  make(opts: ConstructorParameters<typeof LineMaterial>[0]): LineMaterial {
    // fat lines are quads built in screen space: under a mirroring matrix three.js would take them
    // for back faces and cull them
    const m = new LineMaterial({ side: DoubleSide, ...opts });
    this.all.push(m);
    return m;
  }
  /** Sets every line material's viewport size (CSS pixels): called per viewport, allocation free. */
  resolution(w: number, h: number) {
    const all = this.all;
    for (let i = 0; i < all.length; i++) all[i].resolution.set(w, h);
  }
  remove(m: LineMaterial) {
    const i = this.all.indexOf(m);
    if (i >= 0) this.all.splice(i, 1);
    m.dispose();
  }
  get size(): number {
    return this.all.length;
  }
}

/** Line widths in CSS pixels. */
export const WIDTH = { piece: 1.4, pieceHot: 2.4, cell: 1.1, section: 1.6 };

/**
 * One look per piece: its surface, its cut faces, its outline and its flat cross-sections. All
 * transparent at opacity 1, so that highlighting (others fade) never changes a shader program.
 */
export class Looks {
  surface: MeshStandardMaterial[] = [];
  cut: MeshStandardMaterial[] = [];
  section: MeshStandardMaterial[] = [];
  line: LineMaterial[] = [];
  private hot: number | null = null;
  private dark = false;
  /** Opacity factor for all pieces (the net fades the cell nearest the 4D eye). */
  private fadeBy = 1;
  /** Looks that copy this one's highlight and colour scheme. */
  private readonly followers = new Set<Looks>();

  constructor(
    private readonly lines: LineRegistry,
    count: number,
    dark: boolean,
    /** For objects drawn through a projective matrix (the folding net). */
    projective = false,
  ) {
    this.dark = dark;
    for (let i = 0; i < count; i++) {
      this.surface.push(
        new MeshStandardMaterial({ roughness: 0.42, metalness: 0, transparent: true, side: FrontSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
      );
      this.cut.push(
        new MeshStandardMaterial({ roughness: 0.85, metalness: 0, transparent: true, side: FrontSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
      );
      this.section.push(
        new MeshStandardMaterial({ roughness: 0.7, metalness: 0, transparent: true, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }),
      );
      this.line.push(lines.make({ linewidth: WIDTH.piece, transparent: true, worldUnits: false }));
    }
    if (projective) {
      for (const m of [...this.surface, ...this.cut, ...this.section]) projectiveSurface(m);
      for (const m of this.line) projectiveLine(m);
    }
    this.theme(dark);
  }

  theme(dark: boolean) {
    this.dark = dark;
    for (const f of this.followers) f.theme(dark);
    this.surface.forEach((m, i) => m.color.setStyle(pieceColor(i, dark)));
    this.cut.forEach((m, i) => m.color.setStyle(pieceCutColor(i, dark)));
    this.section.forEach((m, i) => m.color.setStyle(pieceColor(i, dark)));
    this.line.forEach((m, i) => m.color.setStyle(pieceEdgeColor(i, dark)));
    this.highlight(this.hot, true);
  }

  /** Lights up piece `hot` (null: none) and fades the others. */
  highlight(hot: number | null, force = false) {
    if (hot === this.hot && !force) return;
    this.hot = hot;
    for (const f of this.followers) f.highlight(hot, force);
    const k = this.fadeBy;
    for (let i = 0; i < this.surface.length; i++) {
      const on = hot === null || hot === i;
      const glow = hot === i;
      const surf = this.surface[i];
      const cut = this.cut[i];
      const sec = this.section[i];
      for (let j = 0; j < 3; j++) {
        const m = j === 0 ? surf : j === 1 ? cut : sec;
        m.opacity = (on ? 1 : 0.14) * k;
        m.depthWrite = on && k > 0.98;
        m.emissive.copy(m.color).multiplyScalar(glow ? 0.28 : 0);
      }
      // faint fat lines bead where their round caps overlap: a faded piece keeps no outline
      this.line[i].opacity = k;
      this.line[i].visible = on && k > 0.5;
      this.line[i].linewidth = glow ? WIDTH.pieceHot : WIDTH.piece;
    }
  }

  /** Multiplies every opacity by k (1: as highlighted). */
  fade(k: number) {
    if (k === this.fadeBy) return;
    this.fadeBy = k;
    this.highlight(this.hot, true);
  }

  /** Makes `other` copy this look's highlight and colour scheme from now on. */
  follow(other: Looks) {
    this.followers.add(other);
    other.theme(this.dark);
    other.highlight(this.hot, true);
  }

  unfollow(other: Looks) {
    this.followers.delete(other);
  }

  dispose() {
    for (const m of [...this.surface, ...this.cut, ...this.section]) m.dispose();
    for (const m of this.line) this.lines.remove(m);
  }
}

/**
 * Lets a material draw through a projective model matrix M (a 4D view: last row not 0 0 0 1).
 * Positions: the model-view position is divided by its w (three.js assumes w = 1). Normals: a
 * tangent plane (n, -n.p) maps by M's inverse transpose, and its first three numbers are the new
 * normal, outward when w > 0; M may carry a factor -1 (see NetScene), hence the sign of w.
 */
export function projectiveSurface(m: Material) {
  m.onBeforeCompile = (shader) => {
    if (!shader.vertexShader.includes("#include <project_vertex>")) patchFailed(m.type);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <defaultnormal_vertex>",
        `vec4 ppW = modelMatrix * vec4( position, 1.0 );
        vec4 ppPlane = transpose( inverse( modelMatrix ) ) * vec4( objectNormal, - dot( objectNormal, position ) );
        vec3 transformedNormal = normalize( mat3( viewMatrix ) * ppPlane.xyz ) * sign( ppW.w );
        #ifdef FLIP_SIDED
          transformedNormal = - transformedNormal;
        #endif`,
      )
      .replace(
        "#include <project_vertex>",
        `#include <project_vertex>
        mvPosition /= mvPosition.w;
        gl_Position = projectionMatrix * mvPosition;`,
      );
  };
  m.customProgramCacheKey = () => "pp3-projective";
}

/** The patches match three.js 0.186's shader text; a later version may need them redone. */
function patchFailed(what: string) {
  console.warn(`view3d: the projective patch did not apply to ${what}; the folded net will be drawn wrongly.`);
}

/** The same for fat lines: their ends, in view space, divided by w. */
export function projectiveLine(m: LineMaterial): LineMaterial {
  const before = m.vertexShader;
  m.vertexShader = m.vertexShader
    .replace("vec4 start = modelViewMatrix * vec4( instanceStart, 1.0 );", "vec4 start = modelViewMatrix * vec4( instanceStart, 1.0 ); start /= start.w;")
    .replace("vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );", "vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 ); end /= end.w;");
  if ((m.vertexShader.match(/ \/= (start|end)\.w;/g) ?? []).length !== 2 || m.vertexShader === before) patchFailed("LineMaterial");
  m.needsUpdate = true;
  return m;
}

/** A mesh of one part: surface (material 0) then cut faces (material 1), as built by partMesh. */
export function partGeometry(mesh: PartMesh, positions = mesh.positions, normals = mesh.normals): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(positions, 3));
  g.setAttribute("normal", new BufferAttribute(normals, 3));
  const total = positions.length / 3;
  g.addGroup(0, mesh.surfaceCount, 0);
  if (total > mesh.surfaceCount) g.addGroup(mesh.surfaceCount, total - mesh.surfaceCount, 1);
  return g;
}

/** Fat line segments ([xyz xyz]*) with one material. */
export function segments(points: Float32Array, material: LineMaterial): LineSegments2 {
  const g = new LineSegmentsGeometry();
  g.setPositions(points.length ? points : new Float32Array(6));
  if (!points.length) g.instanceCount = 0;
  const l = new LineSegments2(g, material);
  l.renderOrder = ORDER_LINE;
  return l;
}

/**
 * A cell drawn in its local coordinates: its faces, each tinted by the colour of `faceColor(facet)`,
 * and its edges. Returns the group and the face mesh (for recolouring).
 */
export function cellBox(
  cell: Cell,
  s: number,
  faceColor: (facet: number) => string,
  faceMaterial: MeshBasicMaterial,
  edgeMaterial: LineMaterial,
  trash: Trash,
): { group: Group; faces: Mesh; colorFaces: (faceColor: (facet: number) => string) => void } {
  const group = new Group();
  const faces = cellFaces(cell, s);
  const pos: number[] = [];
  const facetOf: number[] = [];
  for (const f of faces) {
    for (let i = 1; i + 1 < f.pts.length; i++) {
      for (const p of [f.pts[0], f.pts[i], f.pts[i + 1]]) {
        pos.push(p[0], p[1], p[2]);
        facetOf.push(f.facet);
      }
    }
  }
  const g = trash.add(new BufferGeometry());
  g.setAttribute("position", new BufferAttribute(Float32Array.from(pos), 3));
  const col = new Float32Array(pos.length);
  g.setAttribute("color", new BufferAttribute(col, 3));
  const c = new Color();
  const colorFaces = (fc: (facet: number) => string) => {
    facetOf.forEach((f, i) => {
      c.setStyle(fc(f));
      col.set([c.r, c.g, c.b], i * 3);
    });
    (g.getAttribute("color") as BufferAttribute).needsUpdate = true;
  };
  colorFaces(faceColor);
  const mesh = new Mesh(g, faceMaterial);
  mesh.renderOrder = ORDER_FACE;
  group.add(mesh);
  const edges = segments(cellEdges(cell, s), edgeMaterial);
  trash.add(edges.geometry);
  group.add(edges);
  return { group, faces: mesh, colorFaces };
}

/** The translucent material of tinted cell faces. */
export function faceMaterial(opacity: number): MeshBasicMaterial {
  return new MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity,
    depthWrite: false,
    side: DoubleSide,
    // behind the pieces' cut faces, which lie in the same planes
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 2,
  });
}

/** A key light that follows the camera, and a little ambient light. */
export function lightRig(camera: PerspectiveCamera): Disposable {
  const key = new DirectionalLight(0xffffff, 1.5);
  key.position.set(-0.6, 1.2, 1);
  camera.add(key);
  camera.add(key.target);
  key.target.position.set(0, 0, -1);
  const fill = new AmbientLight(0xffffff, 0.35);
  camera.add(fill);
  return {
    dispose() {
      key.dispose();
      fill.dispose();
    },
  };
}

/** The soft studio environment that gives the solids their sheen; dispose() frees its GPU target. */
export function roomEnvironment(renderer: WebGLRenderer): { texture: Texture; dispose(): void } {
  const pmrem = new PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const target = pmrem.fromScene(room, 0.04);
  room.dispose();
  pmrem.dispose();
  return { texture: target.texture, dispose: () => target.dispose() };
}

/** CSS colours of the theme as three colours. */
export function themeColors(theme: Theme): { bg: Color; panel: Color; edge: Color; text: Color } {
  return {
    bg: new Color().setStyle(theme.bg),
    panel: new Color().setStyle(theme.panel),
    edge: new Color().setStyle(theme.dark ? "#8b95a3" : "#5d6773"),
    text: new Color().setStyle(theme.text),
  };
}

/** Disposes a material or several. */
export function disposeMaterial(m: Material | Material[]) {
  if (Array.isArray(m)) m.forEach((x) => x.dispose());
  else m.dispose();
}
