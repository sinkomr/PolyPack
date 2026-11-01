/**
 * The domain of the nD in nD space for the spaces listing (packages/spaces domain.ts): every ordered pair of a dimension's
 * shapes with the dimension's P range. Problems are defined by ranges and never enumerated here except by `sample`.
 */
import {
  ND_DIMENSIONS,
  ND_MAX_P,
  ND_P_RANGE,
  ND_PROBLEM_COUNT,
  ND_SHAPE_NAMES,
  formatNdId,
  ndInRange,
  ndShapeTitle,
  ndShapes,
} from "./catalogue";
import { ndBoundEntry } from "./bounds";

const shapeValues = {
  values: ND_SHAPE_NAMES,
  titles: Object.fromEntries(ND_SHAPE_NAMES.map((n) => [n, ndShapeTitle(n)])),
  // a field whose values depend on the dimension (the shapes of each, the P range of each)
  dependent: { on: "d", values: Object.fromEntries(ND_DIMENSIONS.map((d) => [String(d), ndShapes(d)])) },
};

export const ndimDomain = {
  info: {
    id: "ndim/<d>/<piece>/<container>/<P>",
    fields: [
      { key: "d", label: "Dimension", values: ND_DIMENSIONS.map(String) },
      { key: "piece", label: "Piece", ...shapeValues },
      { key: "container", label: "Container", ...shapeValues },
      {
        key: "P",
        label: "Pieces (P)",
        min: 2,
        max: ND_MAX_P,
        dependent: {
          on: "d",
          ranges: Object.fromEntries(ND_DIMENSIONS.map((d) => [String(d), ND_P_RANGE[d]])),
        },
      },
    ],
    problems: ND_PROBLEM_COUNT,
  },
  bound(id: { fields: Readonly<Record<string, string | number>>; P: number }) {
    const d = Number(id.fields.d);
    const piece = String(id.fields.piece);
    const container = String(id.fields.container);
    const shapes = ndShapes(d);
    if (!shapes.includes(piece) || !shapes.includes(container) || !ndInRange(d, id.P)) return undefined;
    return ndBoundEntry({ d, piece, container }, id.P);
  },
  /** Small P first, dimension by dimension: the first problems of each dimension's pairs. */
  sample(limit: number): string[] {
    const out: string[] = [];
    for (let P = 2; P <= ND_MAX_P; P++)
      for (const d of ND_DIMENSIONS) {
        if (!ndInRange(d, P)) continue;
        for (const a of ndShapes(d))
          for (const b of ndShapes(d)) {
            if (out.length >= limit) return out;
            out.push(formatNdId(d, a, b, P));
          }
      }
    return out;
  },
};
