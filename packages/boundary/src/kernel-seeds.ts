/**
 * Structured starts of the boundary kernel (kernel.ts, capability "seeds"): the cell layouts, the
 * nofold packings of docs/spaces/BOUNDARY.md section 6. Each of the 8 cells holds floor(P / 8) or
 * ceil(P / 8) = n pieces (P mod 8 random cells hold one more), at points of one local layout:
 *  - balls: one at the cell's centre (s = 2); two on a random main diagonal of the inner cube of
 *    edge s - 2, 2 apart (s = 2 + 2 / sqrt 3); more on the k^3 grid of spacing 2, k = ceil(cbrt n)
 *    (s = 2 k);
 *  - cubes: the k^3 grid of unit cubes (s = k, with the two rings' hair of room).
 * Every piece lies in the closed cell that anchors it, so the layout is valid at its edge (pieces
 * may touch across a 2-face). The cubes' other structured start, the search's two rings, is the
 * cube model's constructedStart.
 */
import type { State } from "./search/model";
import { randInt } from "./search/random";
import type { PieceName } from "./types";

/** Room the cube layouts get over their exact edge, as the search's two rings (1e-6 relative). */
const ROOM = 1 + 1e-6;

/** How many pieces each of the 8 cells holds: floor(P / 8), plus one in P mod 8 random cells. */
function perCell(P: number, rand: () => number): number[] {
  const counts = new Array<number>(8).fill(Math.floor(P / 8));
  const cells = [0, 1, 2, 3, 4, 5, 6, 7];
  for (let i = 0; i < P % 8; i++) {
    const j = i + randInt(rand, 8 - i);
    [cells[i], cells[j]] = [cells[j], cells[i]];
    counts[cells[i]]++;
  }
  return counts;
}

/** The nofold layout of P pieces: each cell's pieces at points of one local layout, in random order. */
export function cellLayout(piece: PieceName, P: number, rand: () => number): { st: State; s: number } {
  const n = Math.ceil(P / 8);
  const k = Math.ceil(Math.cbrt(n) - 1e-12);
  let s: number;
  let local: (rand: () => number) => number[][];
  if (piece === "cube") {
    // k^3 unit cubes, spaced s / k >= 1 apart
    s = k * ROOM;
    local = () => grid(k, s / k);
  } else if (n === 1) {
    s = 2;
    local = () => [[0, 0, 0]];
  } else if (n === 2) {
    // the two centres on a main diagonal of the inner cube of edge s - 2, 2 apart
    s = 2 + 2 / Math.sqrt(3);
    local = (r) => {
      const a = s / 2 - 1;
      const d = [0, 1, 2].map(() => (r() < 0.5 ? -a : a));
      return [d, d.map((x) => -x)];
    };
  } else {
    s = 2 * k;
    local = () => grid(k, 2);
  }
  const counts = perCell(P, rand);
  const cells = new Int32Array(P);
  const U = new Float64Array(3 * P);
  let q = 0;
  for (let c = 0; c < 8; c++) {
    const pts = local(rand);
    // a random choice of counts[c] of the cell's points
    for (let i = 0; i < counts[c]; i++) {
      const j = i + randInt(rand, pts.length - i);
      [pts[i], pts[j]] = [pts[j], pts[i]];
      cells[q] = c;
      U.set(pts[i], 3 * q);
      q++;
    }
  }
  return { st: { cells, U }, s };
}

/** The k^3 points of spacing d centred at the origin. */
function grid(k: number, d: number): number[][] {
  const out: number[][] = [];
  const c = (a: number) => (a - (k - 1) / 2) * d;
  for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) for (let e = 0; e < k; e++) out.push([c(a), c(b), c(e)]);
  return out;
}
