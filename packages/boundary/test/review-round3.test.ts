/**
 * Independent review, round 3 (2026-10-25): the ridge snap capped at ridgeSnap(s, tol) and charged
 * to every check (validate.ts header, "Ridge snap").
 *
 * "Defects": `it.fails` reproduces a defect found in this round; the fix makes it pass. "Held up":
 * checked directly. Also re-run outside this file: the round-1 and round-2 batches against the
 * research verifiers (see the report).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { BoundaryPiece, BoundaryProblem, PieceName } from "../src/index";
import { RIDGE_SNAP, parseBoundaryId, validateBoundary } from "../src/index";
import { ridgeSnap } from "../src/chains";

const problem = (piece: PieceName, P: number): BoundaryProblem => ({ polytope: "tesseract", piece, P });
const ok = (piece: PieceName, s: number, pieces: BoundaryPiece[], tol: number) => validateBoundary(problem(piece, pieces.length), { s, pieces }, { tol }).ok;
const turned45: [number, number, number, number] = [Math.cos(Math.PI / 8), 0, 0, Math.sin(Math.PI / 8)];

function ringPiece(ring: 0 | 1, r: number, a: number, b: number, s: number): BoundaryPiece {
  const h = s / 2;
  r = ((r % (4 * s)) + 4 * s) % (4 * s);
  const seg = Math.min(3, Math.floor(r / s));
  const t = r - seg * s;
  const cells = ring === 0 ? [0, 3, 1, 2] : [4, 7, 5, 6];
  const along = seg < 2 ? -h + t : h - t;
  return { cell: cells[seg], u: ring === 0 ? [along, a, b] : [a, b, along] };
}
function tiling(k: number, off: (ring: number, a: number, b: number) => number): { s: number; pieces: BoundaryPiece[] } {
  const s = k;
  const h = s / 2;
  const pieces: BoundaryPiece[] = [];
  for (const ring of [0, 1] as const)
    for (let ia = 0; ia < k; ia++)
      for (let ib = 0; ib < k; ib++) for (let m = 0; m < 4 * k; m++) pieces.push(ringPiece(ring, 0.5 + m + off(ring, ia, ib), -h + 0.5 + ia, -h + 0.5 + ib, s));
  return { s, pieces };
}

describe("review round 3: defects", () => {
  // DEFECT (low: tol 0 only, i.e. the search's final polish, not the server). At tol 0 the snap is
  // ridgeSnap(s, 0) = 2^-52 max(1, s), and a centre that close to a facet (but not on it) is
  // snapped and charged mu ~ 1 rounding unit: the thresholds become depth <= -mu and distance
  // >= 2 + 2 mu, so exact contacts of that piece fail. Reproduced at s = 3 and 4: a cube whose face
  // holds a hinge (depth exactly 0; "edge ... beyond its anchor cell (depth 0)") and two balls
  // exactly 2 apart, each centre 2^-52 or 2^-51 inside its +u0 facet, are rejected at tol 0 and
  // accepted with the centre on the facet or 3 units inside (not snapped). The same contacts are
  // accepted at tol 1e-15. Fix: charge only the displacement beyond one rounding unit,
  // max(0, mu - sqrt 3 2^-52 max(1, s)) (a move that small is rounding, which tol 0 already
  // accepts elsewhere), or compare against max(threshold, the uncharged value at tol 0).
  it("tol 0: exact contacts of a centre one rounding unit inside its facet are accepted", () => {
    for (const d of [2 ** -52, 2 ** -51]) {
      expect(ok("cube", 3, [{ cell: 0, u: [1.5 - d, 0, 0] }, { cell: 0, u: [1.5 - d, 1, 0] }], 0), `cube, d ${d}`).toBe(true);
      expect(ok("ball", 4, [{ cell: 0, u: [2 - d, -1, 0] }, { cell: 0, u: [2 - d, 1, 0] }], 0), `balls, d ${d}`).toBe(true);
    }
  });
});

describe("review round 3: held up", () => {
  it("the snap reproducer and variants are rejected at tol 1e-9 and 1e-11 for s up to 1e4", () => {
    let n = 0;
    for (const s of [22, 1e3, 1e4])
      for (const tol of [1e-9, 1e-11]) {
        const h = s / 2;
        for (const d of [0.99 * RIDGE_SNAP * s, 0.99 * ridgeSnap(s, tol), 0.5 * ridgeSnap(s, tol)])
          for (const extra of [0.9 * d, 0.1 * tol]) {
            // B overlaps the raw (unsnapped) A by tol + extra, on the side away from A's facet
            const over = tol + extra;
            const cases: [PieceName, BoundaryPiece[]][] = [
              ["cube", [{ cell: 0, u: [h - d, 0, 0] }, { cell: 0, u: [h - d - 1 + over, 0, 0] }]],
              ["ball", [{ cell: 0, u: [h - d, 0, 0] }, { cell: 0, u: [h - d - 2 + over, 0, 0] }]],
              ["ball", [{ cell: 0, u: [h - d - 2 + over, 0, 0] }, { cell: 0, u: [h - d, 0, 0] }]],
              ["cube", [{ cell: 0, u: [h - d, -h + 0.8, 0] }, { cell: 0, u: [h - d - 1 + over, -h + 0.8, 0] }]],
              ["cube", [{ cell: 0, u: [h - d, 0, 0] }, { cell: 0, u: [h - d - 0.5 - Math.SQRT1_2 + over, 0, 0], q: turned45 }]],
            ];
            for (const [piece, pieces] of cases) {
              expect(ok(piece, s, pieces, tol), `${piece} s ${s} tol ${tol} d ${d} over ${over}`).toBe(false);
              n++;
            }
          }
      }
    expect(n).toBe(180);
  });

  it("exact contacts pass with the charging: fixtures, tilings, slid rows, ridge-centred contacts (tol 1e-9, 1e-11)", () => {
    for (const name of ["balls", "cubes"]) {
      const path = fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url));
      for (const f of JSON.parse(readFileSync(path, "utf8")).configs)
        for (const tol of [1e-9, 1e-11]) expect(validateBoundary(parseBoundaryId(f.id) as BoundaryProblem, f.config, { tol }).ok, `${f.id} tol ${tol}`).toBe(true);
    }
    for (const tol of [1e-9, 1e-11])
      for (const k of [1, 2, 3])
        for (const off of [() => 0, () => 0.5, () => 0.5 - 2 ** -50, () => 0.5 + 2 ** -48, (r: number, a: number, b: number) => ((r * 7 + a * 3 + b * 5 + 1) * 0.6180339887) % 1]) {
          const c = tiling(k, off);
          expect(ok("cube", c.s, c.pieces, tol), `k ${k} tol ${tol}`).toBe(true);
        }
    for (const tol of [1e-9, 1e-11, 0]) {
      // two balls in one ridge, anchored on opposite sides, exactly 2 apart (each exactly 1 from an edge)
      expect(ok("ball", 4, [{ cell: 0, u: [2, -1, 0] }, { cell: 3, u: [-2, 1, 0] }], tol)).toBe(true);
      // a cube centred on a ridge touching one beside it, anchored in either cell
      expect(ok("cube", 3, [{ cell: 0, u: [1.5, 0, 0] }, { cell: 3, u: [-1.5, 1, 0] }], tol)).toBe(true);
      expect(ok("cube", 3, [{ cell: 0, u: [1.5, 0, 0] }, { cell: 0, u: [1.5, 1, 0] }], tol)).toBe(true);
      // centres inside their facet by more than the snap at this tol (not snapped)
      expect(ok("cube", 3, [{ cell: 0, u: [1.5 - 1e-13, 0, 0] }, { cell: 0, u: [1.5 - 1e-13, 1, 0] }], tol)).toBe(true);
      expect(ok("ball", 4, [{ cell: 0, u: [2 - 1e-13, -1, 0] }, { cell: 0, u: [2 - 1e-13, 1, 0] }], tol)).toBe(true);
    }
    // snapped centres (within the snap at tol > 0) keep their exact contacts
    for (const tol of [1e-9, 1e-11])
      for (const d of [2 ** -52, 1e-15, 0.5 * ridgeSnap(3, tol)]) {
        expect(ok("cube", 3, [{ cell: 0, u: [1.5 - d, 0, 0] }, { cell: 0, u: [1.5 - d, 1, 0] }], tol), `cube tol ${tol} d ${d}`).toBe(true);
        expect(ok("ball", 4, [{ cell: 0, u: [2 - d, -1, 0] }, { cell: 0, u: [2 - d, 1, 0] }], tol), `ball tol ${tol} d ${d}`).toBe(true);
      }
  });

  it("tol 0 (the search's polish): dyadic tilings, rows slid onto the ridges and ridge-centred contacts pass", () => {
    for (const k of [1, 2, 3])
      for (const off of [() => 0, () => 0.5, () => 0.25]) {
        const c = tiling(k, off);
        expect(ok("cube", c.s, c.pieces, 0), `k ${k}`).toBe(true);
      }
    // the research cube optima pass at tol 0 too
    const path = fileURLToPath(new URL("./fixtures/cubes.json", import.meta.url));
    for (const f of JSON.parse(readFileSync(path, "utf8")).configs) expect(validateBoundary(parseBoundaryId(f.id) as BoundaryProblem, f.config, { tol: 0 }).ok, f.id).toBe(true);
  });
});
