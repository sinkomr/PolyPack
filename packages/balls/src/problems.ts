/**
 * The problems of the balls space with their geometry: the piece solid (the polyhedra space's unit-edge
 * Platonic solids, centred at their vertex centroid) and the lower bounds of the score.
 *
 * Units: balls have radius 1; Platonic solids have edge 1. The container is s times the canonical container,
 * centred at the origin: the ball of radius s, or the cube [-s/2, s/2]^3 with its faces normal to the axes (the
 * polyhedra space's unit cube scaled by s). The score is s: the container ball's radius, or the cube's edge.
 */
import { getSolid, type Solid } from "@polypack/polyhedra";
import {
  BALLS_MAX_P,
  BALLS_MIN_P,
  BALLS_PROBLEMS,
  type BallsProblem,
  ballsProblemOf,
  formatBallsId,
} from "./catalogue";

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
  /** "volume", "two-piece" or "one piece": which of the bounds below is the largest (a listing says "two piece bound"). */
  kind: "volume" | "two-piece" | "one piece";
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
          kind: "two-piece",
          label: "[EST] two unit balls have centres at least 2 apart in the ball of radius s - 1, so s >= 2",
        });
    } else {
      cands.push({ value: 2, kind: "one piece", label: "[EST] a unit ball needs an edge s >= 2" });
      if (P >= 2)
        cands.push({
          value: 2 + 2 / Math.sqrt(3),
          kind: "two-piece",
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
        kind: "two-piece",
        label: `[EST] two ${PLURAL[problem.piece]} contain disjoint balls of their inradius ${S.inradius.toPrecision(7)}, so s >= twice that`,
      });
  }
  return cands.reduce((a, b) => (b.value > a.value ? b : a));
}

/**
 * The domain of the space (packages/spaces domain.ts): the 7 codes and P = BALLS_MIN_P to BALLS_MAX_P, each problem
 * with its elementary bound as a listing shows it ("volume bound; [EST] ..."). The space ships no research records,
 * so every problem starts without one. Its sample for the volunteers' work list takes small P first, the codes in
 * catalogue order.
 */
export const ballsDomain = {
  info: {
    id: "balls/<code>/<P>",
    fields: [
      {
        key: "code",
        label: "Problem",
        values: [...BALLS_PROBLEMS.map((p) => p.code)],
        titles: Object.fromEntries(BALLS_PROBLEMS.map((p) => [p.code, p.title])),
      },
      { key: "P", label: "Pieces (P)", min: BALLS_MIN_P, max: BALLS_MAX_P },
    ],
    problems: BALLS_PROBLEMS.length * (BALLS_MAX_P - BALLS_MIN_P + 1),
  },
  bound(id: { fields: Readonly<Record<string, string | number>>; P: number }) {
    const problem = ballsProblemOf(String(id.fields.code));
    if (!problem || !(id.P >= BALLS_MIN_P && id.P <= BALLS_MAX_P)) return undefined;
    const b = ballsBound(problem, id.P);
    return { value: b.value, label: `${b.kind.replace("-", " ")} bound; ${b.label}` };
  },
  sample(limit: number): string[] {
    const out: string[] = [];
    for (let P = BALLS_MIN_P; P <= BALLS_MAX_P && out.length < limit; P++)
      for (const p of BALLS_PROBLEMS) if (out.length < limit) out.push(formatBallsId(p.code, P));
    return out;
  },
};
