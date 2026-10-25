/**
 * What one configuration gives the three scenes: its parts (from the engine), each part as a
 * clipped mesh in its holding cell's local coordinates, and the data the slices need (each part's
 * half-spaces, a polytope piece's placed vertices). Built once per show(config).
 */
import type { BufferGeometry } from "three";
import type { BoundaryConfig, NetPlacement, PiecePart, Polytope } from "@polypack/boundary";
import { type PartMesh, type PieceShape, cellPlanes, partMesh, toPlane } from "./clip";
import { LineRegistry, Looks, Trash, partGeometry } from "./kit";
import { packPlanes } from "./slice";
import type { Theme } from "./palette";

/** What the view needs from the engine, bound to one polytope and one kind of piece. */
export interface Engine {
  polytope: Polytope;
  /** The piece in its standard pose: standardPiece(name, polytope.d). */
  piece: PieceShape;
  /** The parts of a configuration: pieceParts(polytope, name, config). */
  parts: (config: BoundaryConfig) => PiecePart[];
  /** A net of the cells: defaultNet(polytope). */
  net: NetPlacement[];
  /** Cell-local coordinates to R^d at edge s: toAmbient(polytope, cell, u, s). */
  toAmbient: (cell: number, u: number[], s: number) => number[];
}

export interface Model {
  config: BoundaryConfig;
  s: number;
  /** Number of pieces. */
  count: number;
  parts: PiecePart[];
  /** Per part: its mesh, or null when nothing of it shows (a touching sliver). */
  meshes: (PartMesh | null)[];
  /** Per part: its geometry in cell-local coordinates, shared by the scenes. */
  geoms: (BufferGeometry | null)[];
  /** Part indices held by each cell. */
  byCell: number[][];
  /** Per part: the cell's half-spaces and the part's clip, packed for slicing. */
  planes: Float64Array[];
  /** Per part of a polytope piece: its placed vertices (xyz), for slicing. */
  verts: (Float64Array | null)[];
  /** The standard polytope piece's edges as index pairs, for slicing. */
  edges: Int32Array | null;
  looks: Looks;
  trash: Trash;
}

export function buildModel(engine: Engine, config: BoundaryConfig, lines: LineRegistry, theme: Theme): Model {
  const { polytope: poly, piece } = engine;
  const s = config.s;
  const parts = engine.parts(config);
  const trash = new Trash();
  const looks = trash.add(new Looks(lines, config.pieces.length, theme.dark));
  const byCell: number[][] = poly.cells.map(() => []);
  const meshes: (PartMesh | null)[] = [];
  const geoms: (BufferGeometry | null)[] = [];
  const planes: Float64Array[] = [];
  const verts: (Float64Array | null)[] = [];
  const cellPl = poly.cells.map((c) => cellPlanes(c, s));
  const detail = config.pieces.length > 24 ? 3 : 4;
  parts.forEach((part, i) => {
    const pl = [...cellPl[part.cell], ...part.clip.map((h) => toPlane(h))];
    const mesh = partMesh(piece, part.place, pl, { sphereDetail: detail });
    meshes.push(mesh);
    geoms.push(mesh ? trash.add(partGeometry(mesh)) : null);
    if (mesh) byCell[part.cell].push(i);
    planes.push(packPlanes(pl));
    if (piece.kind === "polytope") {
      const A = part.place.A;
      const b = part.place.b;
      const out = new Float64Array(piece.vertices.length * 3);
      piece.vertices.forEach((v, k) => {
        for (let r = 0; r < 3; r++) out[3 * k + r] = A[r][0] * v[0] + A[r][1] * v[1] + A[r][2] * v[2] + b[r];
      });
      verts.push(out);
    } else verts.push(null);
  });
  let edges: Int32Array | null = null;
  if (piece.kind === "polytope") {
    const seen = new Set<string>();
    const list: number[] = [];
    for (const f of piece.faces) {
      for (let i = 0; i < f.length; i++) {
        const a = f[i];
        const b = f[(i + 1) % f.length];
        const k = a < b ? `${a},${b}` : `${b},${a}`;
        if (!seen.has(k)) {
          seen.add(k);
          list.push(a, b);
        }
      }
    }
    edges = Int32Array.from(list);
  }
  return { config, s, count: config.pieces.length, parts, meshes, geoms, byCell, planes, verts, edges, looks, trash };
}

export function disposeModel(m: Model) {
  m.trash.empty();
}
