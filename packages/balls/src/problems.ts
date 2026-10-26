/**
 * The problems of the balls space with their geometry: the piece solid (the polyhedra space's unit-edge
 * Platonic solids, centred at their vertex centroid) and the lower bounds of the score.
 *
 * Units: balls have radius 1; Platonic solids have edge 1. The container is s times the canonical container,
 * centred at the origin: the ball of radius s, or the cube [-s/2, s/2]^3 with its faces normal to the axes (the
 * polyhedra space's unit cube scaled by s). The score is s: the container ball's radius, or the cube's edge.
 */
import { getSolid, type Solid } from "@polypack/polyhedra";
import { type BallsProblem, ballsProblemOf } from "./catalogue";

export type { BallsProblem };

/** The pieces' names in the plural. */
export const PLURAL: Record<BallsProblem["piece"], string> = {
  ball: "balls",
  tetrahedron: "tetrahedra",
  cube: "cubes",
  octahedron: "octahedra",
  dodecahedron: "dodecahedra",
  icosahedron: "icosahedra",
};

/** The problem of a code, or null. */
export const getBallsProblem = ballsProblemOf;

/** The Platonic solid of a problem's pieces, or null for balls. */
export function pieceSolid(problem: BallsProblem): Solid | null {
  return problem.piece === "ball" ? null : getSolid(problem.piece);
}

/** Volume of one piece: 4 pi / 3 for a unit ball. */
export function pieceVolume(problem: BallsProblem): number {
  return problem.piece === "ball" ? (4 * Math.PI) / 3 : getSolid(problem.piece).volume;
}

export interface BallsBound {
  value: number;
  /** "volume", "two pieces" or "one piece": which of the bounds below is the largest. */
  kind: "volume" | "two pieces" | "one piece";
  /** What it rests on, with its label. */
  label: string;
}

/**
 * The best of these lower bounds on s, each elementary [EST]:
 *  - volume: P pieces of volume v fit only if the container's volume is at least P v: s >= (3 P v / (4 pi))^(1/3)
 *    for a ball container, s >= (P v)^(1/3) for a cube;
 *  - one piece: a ball container holds a solid only if s >= its circumradius (the vertex centroid of a regular
 *    solid is its circumcentre, the centre of its smallest enclosing ball); a cube holds a unit ball only if s >= 2;
 *  - two pieces (P >= 2): two disjoint unit balls have centres at least 2 apart, inside the ball of radius s - 1
 *    (s >= 2) or the cube of edge s - 2, whose diameter is (s - 2) sqrt 3 (s >= 2 + 2 / sqrt 3). Two disjoint
 *    solids contain disjoint balls of their inradius r about their centres, so a ball container has s >= 2 r.
 */
export function ballsBound(problem: BallsProblem, P: number): BallsBound {
  const v = pieceVolume(problem);
  const volume = problem.container === "ball" ? Math.cbrt((3 * P * v) / (4 * Math.PI)) : Math.cbrt(P * v);
  const cands: BallsBound[] = [
    {
      value: volume,
      kind: "volume",
      label: `[EST] volume bound: the pieces' total volume ${P} x ${v.toPrecision(6)} is at most the container's`,
    },
  ];
  if (problem.piece === "ball") {
    if (problem.container === "ball") {
      cands.push({ value: 1, kind: "one piece", label: "[EST] a unit ball needs s >= 1" });
      if (P >= 2)
        cands.push({
          value: 2,
          kind: "two pieces",
          label: "[EST] two unit balls have centres at least 2 apart in the ball of radius s - 1, so s >= 2",
        });
    } else {
      cands.push({ value: 2, kind: "one piece", label: "[EST] a unit ball needs an edge s >= 2" });
      if (P >= 2)
        cands.push({
          value: 2 + 2 / Math.sqrt(3),
          kind: "two pieces",
          label:
            "[EST] two unit balls have centres at least 2 apart in the cube of edge s - 2, whose diameter is (s - 2) sqrt 3, so s >= 2 + 2 / sqrt 3",
        });
    }
  } else {
    const S = getSolid(problem.piece);
    cands.push({
      value: S.circumradius,
      kind: "one piece",
      label: `[EST] a ${S.title} needs a ball of at least its circumradius ${S.circumradius.toPrecision(7)}`,
    });
    if (P >= 2)
      cands.push({
        value: 2 * S.inradius,
        kind: "two pieces",
        label: `[EST] two ${PLURAL[problem.piece]} contain disjoint balls of their inradius ${S.inradius.toPrecision(7)}, so s >= twice that`,
      });
  }
  return cands.reduce((a, b) => (b.value > a.value ? b : a));
}
