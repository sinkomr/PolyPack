/** Problem ids and standard pieces of the boundary space. */
import { CUBE_FACES, CUBE_VERTICES } from "./parts";
import { isPolytopeName } from "./polytope";
import type { BoundaryProblem, PieceName } from "./types";
import { PIECES } from "./types";

export const MAX_P = 9999;

export function isPieceName(x: unknown): x is PieceName {
  return typeof x === "string" && (PIECES as readonly string[]).includes(x);
}

/** Is P a valid piece count (an integer from 1 to MAX_P)? */
export function isPieceCount(P: unknown): P is number {
  return typeof P === "number" && Number.isInteger(P) && P >= 1 && P <= MAX_P;
}

/**
 * Parses `boundary/<polytope>/<piece>/<P>`, e.g. `boundary/tesseract/ball/9`. Exactly one written
 * form is accepted: lower-case names from the catalogue and P from 1 to 9999 without leading zeros
 * or signs. Returns the problem, or a plain sentence saying what is wrong.
 */
export function parseBoundaryId(id: string): BoundaryProblem | string {
  if (typeof id !== "string") return "A boundary problem id must be a string.";
  const parts = id.split("/");
  if (parts.length !== 4 || parts[0] !== "boundary") return `"${id}" is not of the form boundary/<polytope>/<piece>/<P>.`;
  const [, polytope, piece, ps] = parts;
  if (!isPolytopeName(polytope)) return `Unknown polytope "${polytope}".`;
  if (!isPieceName(piece)) return `Unknown piece "${piece}".`;
  if (!/^[1-9][0-9]{0,3}$/.test(ps)) return `The piece count "${ps}" must be a whole number from 1 to ${MAX_P}, written without leading zeros.`;
  return { polytope, piece, P: Number(ps) };
}

/** The one written form of a problem's id; throws on an invalid problem. */
export function formatBoundaryId(p: BoundaryProblem): string {
  if (!isPolytopeName(p.polytope) || !isPieceName(p.piece) || !isPieceCount(p.P)) throw new Error("formatBoundaryId: invalid problem");
  return `boundary/${p.polytope}/${p.piece}/${p.P}`;
}

/**
 * A piece in its standard pose (piece-local coordinates, centred at the origin): the ball (radius
 * BALL_RADIUS = 1/2; the shape {kind: "ball"} is the UNIT ball and the parts' place.A carries the radius, parts.ts), or the unit cube [-1/2, 1/2]^3 with its 8 vertices (vertex v has coordinate k = +1/2
 * exactly when bit k of v is set) and 6 faces (-x, +x, -y, +y, -z, +z, counter-clockwise seen
 * from outside). Pieces have dimension d - 1; only d = 4 is supported.
 */
export function standardPiece(piece: PieceName, d: number): { kind: "ball" } | { kind: "polytope"; vertices: number[][]; faces: number[][] } {
  if (d !== 4) throw new Error("standardPiece: only d = 4 (3D pieces) is supported");
  if (piece === "ball") return { kind: "ball" };
  if (piece === "cube") return { kind: "polytope", vertices: CUBE_VERTICES.map((v) => v.slice()), faces: CUBE_FACES.map((f) => f.slice()) };
  throw new Error(`standardPiece: unknown piece ${String(piece)}`);
}
