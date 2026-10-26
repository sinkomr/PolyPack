/**
 * The penalty model of the methods kernel (kernel.ts) in the nofold mode: every piece inside its own
 * face, pieces of one face apart, pieces of different faces never in contact (docs/spaces/SURFACE.md,
 * validity). It is the fold search's nofold energy (search/energy.ts, mode "nofold") with what the
 * generic methods also need: per-piece weights, the terms of one piece, a hard clearance test and
 * soft pieces. As in kernel-energy.ts it works on the solid of scale 1 with pieces scaled by lam = 1/s,
 * poses canonical (the centre in the closed anchor face), and the kernel turns its results into piece
 * units (times s^2).
 *
 * Terms: WALL_WEIGHT times the squared protrusion beyond each edge line of the face (how far the piece
 * reaches past the line: for a disk its centre's distance beyond it plus lam, for a polygon its
 * farthest corner's), and the squared penetration depth of every pair on one face (polygons: the
 * separating-axis depth with the exact normals of the outlines' sides, parts.ts partSeparation;
 * disks: 2 lam minus the centres' distance). Per edge the farthest point counts, not every corner,
 * so a soft piece, which lies inside the true one, never sticks out more (the fold search's nofold
 * energy sums the corners instead).
 *
 * A piece belongs to the face its centre is in, as in the fold mode: a piece whose centre crosses an
 * edge moves to the neighbouring face (kernel.ts reads every chart through unfoldChart), so methods can
 * move pieces between faces. At the crossing the energy jumps: a piece that is not symmetric about the
 * shared edge sticks out of the two faces by different amounts, the other edges of the new face count
 * instead of the old one's, and its pair terms move from one face's pieces to the other's. The energy
 * is a model; finish decides validity.
 */
import { boundingRadius } from "@polypack/geometry";
import { pieceOutline } from "./kernel-energy";
import { type HalfPlanes, type SurfacePose, faceCutsOf, partSeparation } from "./parts";
import { WALL_WEIGHT } from "./search/energy";
import type { Solid } from "./solids";

/** One piece's shape in its face: an outline (polygons) or a centre and radius (disks), with its wall terms. */
export interface NofoldGeom {
  face: number;
  x: number;
  y: number;
  /** polygons: the outline (anchor face frame) and its sides' half-planes */
  shape: { poly: Float64Array; cuts: { nx: Float64Array; ny: Float64Array; b: Float64Array } } | null;
  /** sum of WALL_WEIGHT * protrusion^2 */
  wall: number;
  /** deepest protrusion beyond the face (0 when inside) */
  out: number;
}

const pairWeight = (w: Float64Array | undefined, i: number, j: number) => (!w ? 1 : (w[i] + w[j]) / 2);

export class NofoldModel {
  private readonly reach: number;
  /** each face's edge lines at scale 1 (outward unit normals, inside n . p <= b) */
  private readonly edges: HalfPlanes[];

  constructor(
    readonly solid: Solid,
    readonly N: number,
    readonly P: number,
  ) {
    this.reach = 2 * boundingRadius(N);
    this.edges = Array.from({ length: solid.F }, (_, f) => faceCutsOf(solid, 1, f));
  }

  /** The geometry of a piece at canonical pose p, scale lam, soft shape t (polygons). */
  geom(p: SurfacePose, lam: number, t: number): NofoldGeom {
    const E = this.edges[p.face];
    const o = this.N === 0 ? null : pieceOutline(this.N, p, lam, t);
    let wall = 0;
    let out = 0;
    for (let j = 0; j < E.b.length; j++) {
      // how far the piece reaches past edge line j
      let far: number;
      if (!o) far = E.nx[j] * p.x + E.ny[j] * p.y + lam - E.b[j];
      else {
        far = -Infinity;
        for (let k = 0; k < o.poly.length; k += 2) far = Math.max(far, E.nx[j] * o.poly[k] + E.ny[j] * o.poly[k + 1] - E.b[j]);
      }
      if (far > 0) {
        wall += WALL_WEIGHT * far * far;
        out = Math.max(out, far);
      }
    }
    return { face: p.face, x: p.x, y: p.y, shape: o ? { poly: o.poly, cuts: o } : null, wall, out };
  }

  layout(poses: SurfacePose[], lam: number, t: number): { geoms: NofoldGeom[]; byFace: number[][] } {
    const byFace: number[][] = Array.from({ length: this.solid.F }, () => []);
    const geoms = poses.map((p, i) => {
      byFace[p.face].push(i);
      return this.geom(p, lam, t);
    });
    return { geoms, byFace };
  }

  /** Separation of two pieces on one face (negative: penetration depth); Infinity when they are far apart. */
  private sep(a: NofoldGeom, b: NofoldGeom, lam: number): number {
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (d > this.reach * lam) return Infinity;
    if (!a.shape || !b.shape) return d - 2 * lam;
    return partSeparation(a.shape, b.shape);
  }

  total(geoms: NofoldGeom[], byFace: number[][], lam: number, w?: Float64Array): number {
    let e = 0;
    geoms.forEach((g, i) => (e += (w ? w[i] : 1) * g.wall));
    for (const list of byFace)
      for (let a = 0; a < list.length; a++)
        for (let b = a + 1; b < list.length; b++) {
          const s = this.sep(geoms[list[a]], geoms[list[b]], lam);
          if (s < 0) e += pairWeight(w, list[a], list[b]) * s * s;
        }
    return e;
  }

  /** The terms of piece i if its geometry were g, against the others in `geoms`. */
  local(i: number, g: NofoldGeom, geoms: NofoldGeom[], byFace: number[][], lam: number, w?: Float64Array): number {
    let e = (w ? w[i] : 1) * g.wall;
    for (const j of byFace[g.face]) {
      if (j === i) continue;
      const s = this.sep(g, geoms[j], lam);
      if (s < 0) e += pairWeight(w, i, j) * s * s;
    }
    return e;
  }

  /** True when piece i sticks out of its face and overlaps no piece by more than tol (scale 1). */
  clear(i: number, geoms: NofoldGeom[], byFace: number[][], lam: number, tol: number): boolean {
    const g = geoms[i];
    if (g.out > tol) return false;
    for (const j of byFace[g.face]) if (j !== i && this.sep(g, geoms[j], lam) < -tol) return false;
    return true;
  }
}
