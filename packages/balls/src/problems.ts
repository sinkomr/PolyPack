/**
 * The problems of the balls space with their geometry: the piece solid (the polyhedra space's unit-edge solids,
 * centred at their vertex centroid) and the lower bounds of the score.
 *
 * Units: balls have radius BALL_RADIUS = 1/2, diameter 1 (catalogue.ts); solids have the polyhedra space's canonical size (edge 1 for
 * the Platonic, Archimedean, prism and antiprism solids). The container is s times the canonical container, centred
 * at the origin: the ball of diameter s (radius s / 2), or the canonical solid scaled by s (the cube [-s/2, s/2]^3 with its faces
 * normal to the axes, the polyhedra space's unit cube scaled by s). The score is s: the container ball's diameter, or
 * the scale of the solid (the cube's edge). A ball of radius r lies in s C iff its centre has N_f . c <= s b_f - r
 * for every face f (container.ts).
 */
import { SOLID_NAMES_LIST, pluralTitle } from "@polypack/polyhedra/catalogue";
import { getSolid, type Solid } from "@polypack/polyhedra";
import {
  BALLS_MAX_P,
  BALLS_MIN_P,
  BALLS_ORIGINAL_CODES,
  BALLS_PROBLEMS,
  BALL_DIAMETER,
  BALL_RADIUS,
  type BallsProblem,
  ballContainerScore,
  ballsProblemOf,
  formatBallsId,
} from "./catalogue";
import { containerKind, containerOfProblem } from "./container";

export type { BallsProblem };

const TITLES = new Map(SOLID_NAMES_LIST.map((s) => [s.name, s.title]));

/** The pieces' name in the plural: "balls", "tetrahedra", "triangular prisms of height 1.5". */
export function pluralOf(piece: BallsProblem["piece"]): string {
  return piece === "ball" ? "balls" : pluralTitle(TITLES.get(piece) ?? piece);
}

/** The problem of a code, or null. */
export const getBallsProblem = ballsProblemOf;

/** The solid of a problem's pieces, or null for balls. */
export function pieceSolid(problem: BallsProblem): Solid | null {
  return problem.piece === "ball" ? null : getSolid(problem.piece);
}

/** Volume of one piece: 4 pi r^3 / 3 for a ball of radius r = BALL_RADIUS. */
export function pieceVolume(problem: BallsProblem): number {
  return problem.piece === "ball" ? (4 * Math.PI * BALL_RADIUS ** 3) / 3 : getSolid(problem.piece).volume;
}

export interface BallsBound {
  value: number;
  /** "volume", "two-piece" or "one piece": which of the bounds below is the largest (a listing says "two piece bound"). */
  kind: "volume" | "two-piece" | "one piece";
  /** What it rests on, with its label. */
  label: string;
}

/**
 * The best of these lower bounds on s, each elementary [EST]. A ball container is scored by its diameter s = 2 rho, rho its
 * radius: the bounds below are on rho (rho = s / 2), converted once at the end of the function:
 *  - volume: P pieces of volume v fit only if the container's volume is at least P v: s >= (3 P v / (4 pi))^(1/3)
 *    for a ball container, s >= (P v / V)^(1/3) for the canonical solid of volume V (the cube has V = 1);
 *  - one piece: a ball container holds a solid only if rho >= its circumradius (the vertex centroid of each of the
 *    solids is the centre of its smallest enclosing ball, container.ts); a solid container s C holds a ball of radius
 *    r only if s >= r / rho, rho the inradius of C (the centroid is the centre of the largest inscribed ball);
 *  - two pieces (P >= 2): two disjoint balls of radius r have centres at least 2 r apart, inside the container
 *    shrunk by r: the ball of radius rho - r (rho >= 2 r), or, for a solid C with all faces at its inradius rho (the
 *    tangential solids, among them the cube), the solid (s - r / rho) C, whose diameter is (s - r / rho) D, so
 *    s >= r / rho + 2 r / D; for any C the shrunk container's width in each direction is the container's less 2 r
 *    (its support function is the container's less r on each side), so a pair of centres 2 r apart needs a direction
 *    of width 4 r in s C: s >= 4 r / D. Two disjoint solids contain disjoint balls of their inradius r, so a ball
 *    container has rho >= 2 r.
 */
export function ballsBound(problem: BallsProblem, P: number): BallsBound {
  const v = pieceVolume(problem);
  const kind = containerKind(problem);
  const C = kind === "polyhedron" ? containerOfProblem(problem) : null;
  const volume =
    kind === "ball" ? Math.cbrt((3 * P * v) / (4 * Math.PI)) : C ? Math.cbrt((P * v) / C.volume) : Math.cbrt(P * v);
  const cands: BallsBound[] = [
    {
      value: volume,
      kind: "volume",
      label: `[EST] the pieces' total volume ${P} x ${v.toPrecision(6)} is at most the container's`,
    },
  ];
  const R = BALL_RADIUS;
  if (problem.piece === "ball") {
    if (kind === "ball") {
      cands.push({
        value: R,
        kind: "one piece",
        label: `[EST] a ball of diameter ${BALL_DIAMETER} needs a container of diameter s >= ${BALL_DIAMETER}`,
      });
      if (P >= 2)
        cands.push({
          value: BALL_DIAMETER,
          kind: "two-piece",
          label: `[EST] two balls of diameter ${BALL_DIAMETER} have centres at least ${BALL_DIAMETER} apart in the ball of radius s / 2 - ${R}, so s / 2 >= ${BALL_DIAMETER} and s >= ${2 * BALL_DIAMETER}`,
        });
    } else if (kind === "cube") {
      cands.push({ value: BALL_DIAMETER, kind: "one piece", label: `[EST] a ball of diameter ${BALL_DIAMETER} needs an edge s >= ${BALL_DIAMETER}` });
      if (P >= 2)
        cands.push({
          value: BALL_DIAMETER + BALL_DIAMETER / Math.sqrt(3),
          kind: "two-piece",
          label: `[EST] two balls of diameter ${BALL_DIAMETER} have centres at least ${BALL_DIAMETER} apart in the cube of edge s - ${BALL_DIAMETER}, whose diameter is (s - ${BALL_DIAMETER}) sqrt 3, so s >= ${BALL_DIAMETER} + ${BALL_DIAMETER} / sqrt 3`,
        });
    } else {
      const title = TITLES.get(problem.container) ?? problem.container;
      cands.push({
        value: R / C!.inradius,
        kind: "one piece",
        label: `[EST] a ball of diameter ${BALL_DIAMETER} needs a scale s >= ${R} / ${C!.inradius.toPrecision(7)}, the inradius of the ${title}`,
      });
      if (P >= 2) {
        if (C!.tangential)
          cands.push({
            value: R / C!.inradius + BALL_DIAMETER / C!.diameter,
            kind: "two-piece",
            label: `[EST] two balls of diameter ${BALL_DIAMETER} have centres at least ${BALL_DIAMETER} apart in the ${title} of scale s - ${R} / ${C!.inradius.toPrecision(7)}, whose diameter is that times ${C!.diameter.toPrecision(7)}`,
          });
        cands.push({
          value: (2 * BALL_DIAMETER) / C!.diameter,
          kind: "two-piece",
          label: `[EST] two balls of diameter ${BALL_DIAMETER} have centres ${BALL_DIAMETER} apart in a container shrunk by ${R}, whose width in each direction is the ${title}'s less ${BALL_DIAMETER}, so s times its diameter ${C!.diameter.toPrecision(7)} is at least ${2 * BALL_DIAMETER}`,
        });
      }
    }
  } else {
    const S = getSolid(problem.piece);
    cands.push({
      value: S.circumradius,
      kind: "one piece",
      label: `[EST] a ${S.title} needs a ball of radius at least its circumradius ${S.circumradius.toPrecision(7)}, so a diameter s of at least twice that`,
    });
    if (P >= 2)
      cands.push({
        value: 2 * S.inradius,
        kind: "two-piece",
        label: `[EST] two ${pluralOf(problem.piece)} contain disjoint balls of their inradius ${S.inradius.toPrecision(7)}, so s >= twice that`,
      });
  }
  // a ball container is scored by its diameter: the bounds on its radius are converted once, here
  if (kind === "ball") for (const c of cands) c.value = ballContainerScore(c.value);
  return cands.reduce((a, b) => (b.value > a.value ? b : a));
}

/**
 * The domain of the space (packages/spaces domain.ts): the 189 codes and P = BALLS_MIN_P to BALLS_MAX_P, each problem
 * with its elementary bound as a listing shows it ("volume bound; [EST] ..."). The space ships no research records,
 * so every problem starts without one. The board's menu groups the codes (BallsProblem.group). Its sample for the
 * volunteers' work list takes small P first, the space's first 7 codes (BALLS_ORIGINAL_CODES) in their first order:
 * the other problems are not offered to the volunteers' default draw.
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
        groups: Object.fromEntries(BALLS_PROBLEMS.map((p) => [p.code, p.group])),
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
      for (const code of BALLS_ORIGINAL_CODES) if (out.length < limit) out.push(formatBallsId(code, P));
    return out;
  },
};
