/**
 * Random poses of the boundary kernel (kernel.ts) as displacements. A method undoes a rejected
 * move by writing the piece's x back, so randomPose leaves the anchors alone: it draws a target
 * (a cell, and a point of it) and writes the displacement from the piece's anchor along the
 * shortest geodesic the lattice words give. On the tesseract the geodesics from a point are its lattice
 * words (tesseract.ts): each realised word gives an image y of the target in the anchor's
 * development, the segment from the anchor to y is a straight path avoiding the hinges, and the
 * chart's move along y - anchor ends on the target. Any of them encodes the target exactly, so a
 * uniform target gives a uniform pose; the shortest keeps the displacement short. [CALC] For
 * 80,000 random pairs of points at s = 1 to 3 a word was always found, and the move along it
 * always ended on the target.
 */
import { TesseractWords } from "./tesseract";

let WORDS: TesseractWords | null = null;

/** The lattice words, built once per thread (about 16,000). */
function words(): TesseractWords {
  WORDS ??= new TesseractWords(2);
  return WORDS;
}

/**
 * The displacement (in the frame of `cell`) along the shortest realised geodesic from the point a
 * of `cell` to the point u of `target`, at edge s; null when no word with at most two crossings
 * per lattice axis is realised.
 */
export function displacementTo(
  cell: number,
  a: number[],
  target: number,
  u: number[],
  s: number,
): [number, number, number] | null {
  let best: [number, number, number] | null = null;
  let bestLength = Infinity;
  for (const y of words().images(cell, a, target, u, s)) {
    const v: [number, number, number] = [y[0] - a[0], y[1] - a[1], y[2] - a[2]];
    const length = Math.hypot(v[0], v[1], v[2]);
    if (length < bestLength) {
      best = v;
      bestLength = length;
    }
  }
  return best;
}
