/**
 * The engine's functions bound to one polytope and one kind of piece: what createBoundaryView
 * needs to draw, taken from the same code that validates.
 */
import { type PieceName, type PolytopeName, defaultNet, getPolytope, pieceParts, standardPiece, toAmbient } from "@polypack/boundary";
import type { Engine } from "./model";

export function engineFor(polytope: PolytopeName, piece: PieceName): Engine {
  const poly = getPolytope(polytope);
  return {
    polytope: poly,
    piece: standardPiece(piece, poly.d),
    parts: (config) => pieceParts(poly, piece, config),
    net: defaultNet(poly),
    toAmbient: (cell, u, s) => toAmbient(poly, cell, u, s),
  };
}
