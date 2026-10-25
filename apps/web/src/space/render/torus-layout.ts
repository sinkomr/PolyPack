/**
 * What a torus drawing shows, as numbers (no DOM): the basis drawn, the window, and every lattice
 * translate of a piece that meets the window. Kept apart from the SVG so that it is tested in Node.
 *
 * A basis is Lagrange-Gauss reduced first (the same lattice): a skewed basis, such as
 * b2 + 320 b1, would otherwise give a long thin cell, a huge window and millions of translates.
 * The translates are enumerated from the window's lattice coordinates (Cramer's rule), so their
 * number follows the window's area, and they are capped at MAX_TORUS_PIECES drawn shapes. The
 * walk itself is bounded too: a lattice whose shortest vector is far below a piece's size (no
 * packing has one) or that needs more than MAX_TORUS_CELLS cells is not drawn, nor is one whose
 * determinant is zero or not finite. torusLayout then returns the reason as a sentence.
 */
import { type Lattice, gaussReduce } from "@polypack/torus";

type V2 = readonly [number, number];

/** Most shapes a torus drawing holds; beyond it the layout is cut short and says so. */
export const MAX_TORUS_PIECES = 6000;
/** Most cells (lattice translates) the layout walks over. */
export const MAX_TORUS_CELLS = 100_000;
/**
 * Smallest shortest lattice vector drawn, as a share of the piece's circumradius. A packing needs
 * at least the piece's width (more than the circumradius), so anything below is malformed.
 */
export const MIN_TORUS_VECTOR = 0.05;

export interface TorusLayout {
  /** The basis drawn: the given lattice, reduced, with det(b1, b2) > 0. */
  basis: readonly [V2, V2];
  /** Window in drawing coordinates (y up). */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** Every drawn shape: centre, angle, the piece it copies, and whether it lies outside the central cell. */
  pieces: { x: number; y: number; theta: number; orbit: number; ghost: boolean }[];
  /** Origins of the other cells drawn in the tiled view. */
  cells: [number, number][];
  /** True when MAX_TORUS_PIECES cut the drawing short. */
  capped: boolean;
}

const add = (a: V2, B: readonly [V2, V2], m: number, n: number): [number, number] => [
  a[0] + m * B[0][0] + n * B[1][0],
  a[1] + m * B[0][1] + n * B[1][1],
];

/**
 * The layout of a packing with circumradius R (1 for disks) in the tiled view (`tile`) or the
 * one-cell view, or why it is not drawn.
 */
export function torusLayout(
  lattice: Lattice,
  poses: readonly { x: number; y: number; theta: number }[],
  R: number,
  tile: boolean,
): TorusLayout | string {
  const degenerate = "The lattice is degenerate, so it is not drawn.";
  const given = [lattice.b1[0], lattice.b1[1], lattice.b2[0], lattice.b2[1]];
  if (!given.every(Number.isFinite)) return degenerate;
  const d0 = lattice.b1[0] * lattice.b2[1] - lattice.b1[1] * lattice.b2[0];
  if (!(Number.isFinite(d0) && Math.abs(d0) > 0)) return degenerate;
  const reduced = gaussReduce(lattice).lattice;
  const shortest = Math.hypot(reduced.b1[0], reduced.b1[1]);
  if (!(shortest >= MIN_TORUS_VECTOR * R))
    return `The lattice is far smaller than a piece (its shortest vector is ${shortest.toPrecision(3)}), so it is not drawn.`;
  const b1: V2 = [reduced.b1[0], reduced.b1[1]];
  let b2: V2 = [reduced.b2[0], reduced.b2[1]];
  // -b2 spans the same lattice; a positive determinant keeps the cell and its arrows the same way round
  if (b1[0] * b2[1] - b1[1] * b2[0] < 0) b2 = [-b2[0], -b2[1]];
  const B: readonly [V2, V2] = [b1, b2];
  const det = B[0][0] * B[1][1] - B[0][1] * B[1][0];
  if (!(det > 0) || !Number.isFinite(det)) return degenerate;

  const corners = ([0, 1] as const).flatMap((s) => ([0, 1] as const).map((t) => add([0, 0], B, s, t)));
  let x0 = Math.min(...corners.map((c) => c[0]));
  let x1 = Math.max(...corners.map((c) => c[0]));
  let y0 = Math.min(...corners.map((c) => c[1]));
  let y1 = Math.max(...corners.map((c) => c[1]));
  // tiled: a rectangular window around the cell; one cell: the cell itself
  const grow = tile ? Math.max(1.6 * R, 0.45 * Math.max(x1 - x0, y1 - y0)) : 0;
  x0 -= grow;
  x1 += grow;
  y0 -= grow;
  y1 += grow;

  // lattice coordinates of a point: w = a b1 + b b2
  const coords = (x: number, y: number): [number, number] => [
    (x * B[1][1] - y * B[1][0]) / det,
    (B[0][0] * y - B[0][1] * x) / det,
  ];
  // centres reduced to the central cell (fractional coordinates in [0, 1))
  const cen = poses.map((q): [V2, number] => {
    let [a, b] = coords(q.x, q.y);
    a -= Math.floor(a);
    b -= Math.floor(b);
    return [add([0, 0], B, a, b), q.theta];
  });
  // the translates (m, n) whose cell can meet the window grown by R: the window's corners in
  // lattice coordinates bound m and n, and a centre lies in [0, 1) of its cell
  const wc = [coords(x0 - R, y0 - R), coords(x1 + R, y0 - R), coords(x0 - R, y1 + R), coords(x1 + R, y1 + R)];
  const mLo = Math.floor(Math.min(...wc.map((c) => c[0]))) - 1;
  const mHi = Math.ceil(Math.max(...wc.map((c) => c[0]))) + 1;
  const nLo = Math.floor(Math.min(...wc.map((c) => c[1]))) - 1;
  const nHi = Math.ceil(Math.max(...wc.map((c) => c[1]))) + 1;
  const cellCount = (mHi - mLo + 1) * (nHi - nLo + 1);
  if (!(cellCount <= MAX_TORUS_CELLS))
    return `The lattice needs too many cells to draw (${cellCount.toPrecision(3)}), so it is not drawn.`;
  const hit = (p: V2) => p[0] + R > x0 && p[0] - R < x1 && p[1] + R > y0 && p[1] - R < y1;
  const span = [Math.abs(B[0][0]) + Math.abs(B[1][0]), Math.abs(B[0][1]) + Math.abs(B[1][1])];
  const pieces: TorusLayout["pieces"] = [];
  const cells: [number, number][] = [];
  let capped = false;
  for (let m = mLo; m <= mHi && !capped; m++)
    for (let n = nLo; n <= nHi && !capped; n++) {
      const central = m === 0 && n === 0;
      for (let i = 0; i < cen.length; i++) {
        const p = add(cen[i][0], B, m, n);
        if (!hit(p)) continue;
        if (pieces.length >= MAX_TORUS_PIECES) {
          capped = true;
          break;
        }
        pieces.push({ x: p[0], y: p[1], theta: cen[i][1], orbit: i, ghost: !tile && !central });
      }
      const o = add([0, 0], B, m, n);
      if (
        tile &&
        !central &&
        o[0] + span[0] > x0 - 1 &&
        o[0] - span[0] < x1 + 1 &&
        o[1] + span[1] > y0 - 1 &&
        o[1] - span[1] < y1 + 1
      )
        cells.push(o);
    }
  return { basis: B, x0, x1, y0, y1, pieces, cells, capped };
}
