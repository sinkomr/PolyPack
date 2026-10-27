import { areaLowerBound } from "@polypack/geometry";
import { DimensionId, Family, ProblemKey, familyDimension, isPolygon, needPolygon, problemTitle } from "./frontier";
import { shapeWeight } from "./points";

/**
 * What the points, the rank, the dealer and the texts need to know of a problem's family. Only the
 * polygon family is implemented: the others throw "not yet" until their packages fill them in.
 */
export interface FamilyRules {
  family: Family;
  dimension: DimensionId;
  title(p: ProblemKey): string;
  /** The word for the score: "radius" when the container is a circle, else "side". */
  scoreWord(p: ProblemKey): string;
  /** Weight w of the problem's shape in the points. */
  weight(p: ProblemKey): number;
  /** Lower bound of the gap term: a polygon's areaLowerBound, a space problem's from the server (ProblemState.bound). */
  bound(p: ProblemKey & { bound?: number | null }): number | null;
}

const POLYGON_RULES: FamilyRules = {
  family: "polygon",
  dimension: "2-in-2",
  title: (p) => problemTitle(needPolygon(p, "title")),
  scoreWord: (p) => (needPolygon(p, "score word").M === 0 ? "radius" : "side"),
  weight: (p) => {
    const q = needPolygon(p, "shape weight");
    return shapeWeight(q.N, q.M);
  },
  bound: (p) => {
    const q = needPolygon(p, "bound");
    return areaLowerBound(q.N, q.M, q.P);
  },
};

/** The rules of a problem's family; a family that is not implemented yet throws. */
export function rulesOf(p: ProblemKey): FamilyRules {
  if (isPolygon(p)) return POLYGON_RULES;
  throw new Error(`not yet: family rules for ${p.family}`);
}

export { familyDimension };
