import { areaLowerBound } from "@polypack/geometry";
import { ballsTitle } from "@polypack/balls/catalogue";
import { problemTitle as polyhedraTitle } from "@polypack/polyhedra/catalogue";
import { formatK, pieceName, solidTitle } from "../spaces-model";
import {
  DimensionId,
  Family,
  ProblemKey,
  SpaceFamily,
  SpaceKey,
  familyDimension,
  isPolygon,
  needPolygon,
  problemTitle as polygonTitle,
} from "./frontier";
import { distinctness, shapeWeight } from "./points";
import type { EvolveMethod } from "./upgrades";

/**
 * What the points, the rank, the dealer and the texts need to know of a problem's family. The
 * polygon family and the six space families (packages/spaces ids) are all here.
 */
export interface FamilyRules {
  family: Family;
  dimension: DimensionId;
  title(p: ProblemKey): string;
  /**
   * The word for the score: "diameter" when the container is a circle or a ball, else "side" (a space's:
   * "edge", "scale", or "radius" for a sphere's radius).
   */
  scoreWord(p: ProblemKey): string;
  /** Weight w of the problem's shape in the points. */
  weight(p: ProblemKey): number;
  /** Lower bound of the gap term: a polygon's areaLowerBound, a space problem's from the server (ProblemState.bound). */
  bound(p: ProblemKey & { bound?: number | null }): number | null;
  /**
   * Kernel evaluations of the space's search that one game evaluation is, sized to the CPU time of
   * a 2D evaluation with as many pieces (unitsFor); 1 for polygons.
   */
  unitsPerEvaluation(p: ProblemKey): number;
  /** The cost in ms of one game evaluation, from a fixed model and not the player's machine: what pay scales with. */
  evalMs(p: ProblemKey): number;
  /** The generic methods the family offers (the player also owns the card: upgrades.ts), mc_compress first; "seed" is left out, as in the 2D game's Method list. */
  methods: readonly EvolveMethod[];
}

// ---------- the space problem's id ----------

/** The fields of a space problem's catalogue id, read as the packages write them (packages/spaces ids.ts). */
export type SpaceFields =
  | { family: "surface"; solid: string; mode: "fold" | "nofold"; N: number; P: number }
  | { family: "curved"; K: string; N: number; M: number; P: number }
  | { family: "sphere"; N: number; P: number }
  | { family: "torus"; lattice: "sq" | "hex" | "free"; N: number; P: number }
  | { family: "polyhedra"; code: string; P: number }
  | { family: "balls"; code: string; P: number };

/** The fields of an id, or null for one that is not a space problem's. */
export function spaceFields(id: string): SpaceFields | null {
  let m: RegExpExecArray | null;
  if ((m = /^surface\/([a-z0-9_]+)\/(fold|nofold)\/(\d+)\/(\d+)$/.exec(id)))
    return { family: "surface", solid: m[1], mode: m[2] as "fold" | "nofold", N: Number(m[3]), P: Number(m[4]) };
  if ((m = /^curved\/(-?[0-9.e+-]+)\/(\d+)\/(\d+)\/(\d+)$/.exec(id)))
    return { family: "curved", K: m[1], N: Number(m[2]), M: Number(m[3]), P: Number(m[4]) };
  if ((m = /^sphere\/(\d+)\/(\d+)$/.exec(id))) return { family: "sphere", N: Number(m[1]), P: Number(m[2]) };
  if ((m = /^torus\/(sq|hex|free)\/(\d+)\/(\d+)$/.exec(id)))
    return { family: "torus", lattice: m[1] as "sq" | "hex" | "free", N: Number(m[2]), P: Number(m[3]) };
  if ((m = /^polyhedra\/([a-z0-9]+)\/(\d+)$/.exec(id))) return { family: "polyhedra", code: m[1], P: Number(m[2]) };
  if ((m = /^balls\/([a-z0-9]+)\/(\d+)$/.exec(id))) return { family: "balls", code: m[1], P: Number(m[2]) };
  return null;
}

function fieldsOf(p: SpaceKey): SpaceFields {
  const f = spaceFields(p.id);
  if (!f || f.family !== p.family) throw new Error(`not a ${p.family} problem id: ${p.id}`);
  return f;
}

// ---------- titles ----------

const plural = (name: string) => `${name}s`;
const article = (name: string) => (/^[aeiou]/.test(name) ? `an ${name}` : `a ${name}`);
const count = (P: number, name: string) => `${P} ${P === 1 ? name : plural(name)}`;
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const TORUS_NAMES = { sq: "square torus", hex: "hexagonal torus", free: "free-lattice torus" } as const;

function spaceTitle(p: SpaceKey): string {
  const f = fieldsOf(p);
  switch (f.family) {
    case "surface":
      return (
        `${count(f.P, pieceName(f.N))} on ${article(solidTitle(f.solid))}, ` +
        (f.mode === "fold" ? "folded over its edges" : "kept inside its faces")
      );
    case "curved":
      return `${count(f.P, pieceName(f.N))} in ${article(pieceName(f.M))} at curvature ${formatK(f.K)}`;
    case "sphere":
      return `${count(f.P, pieceName(f.N))} on a sphere`;
    case "torus":
      return `${count(f.P, pieceName(f.N))} on ${article(TORUS_NAMES[f.lattice])}`;
    case "polyhedra":
      return `${f.P} ${lowerFirst(polyhedraTitle(f.code))}`;
    case "balls":
      return `${f.P} ${lowerFirst(ballsTitle(f.code))}`;
  }
}

function spaceScoreWord(p: SpaceKey): string {
  const f = fieldsOf(p);
  switch (f.family) {
    case "surface":
      return "edge";
    case "curved":
      return f.M === 0 ? "diameter" : "side";
    case "sphere":
      return "radius";
    case "torus":
      return "side";
    case "polyhedra":
      return "scale";
    case "balls":
      // the container of a code `<piece>in<container>`: a cube ends in "cub", a ball in "ball", and
      // any other solid is scored by its scale
      return f.code.endsWith("ball") ? "diameter" : f.code.endsWith("cub") ? "edge" : "scale";
  }
}

// ---------- weights ----------

/** The premium that problems outside 2D in 2D pay over 2D in 2D for the same solver time [SPEC]. */
export const PREMIUM = 1.2;

/**
 * The level of each row, to be fitted by a measurement of how much solver time each row's problems
 * take to improve. All 1 for now.
 */
export const LEVEL: Record<string, number> = {
  sphere: 1,
  torus: 1,
  curved: 1,
  "surface:fold": 1,
  "surface:nofold": 1,
  polyhedra: 1,
  "balls:ball": 1,
  "balls:solid": 1,
};

/** The family factor D_f of the shape weight [SPEC]: PREMIUM times the row's LEVEL; 1 for polygons. As the table was at load (spaceWeight reads PREMIUM and LEVEL themselves). */
export const FAMILY_FACTOR: Readonly<Record<string, number>> = {
  polygon: 1,
  ...Object.fromEntries(Object.entries(LEVEL).map(([row, level]) => [row, PREMIUM * level])),
};

/** The weight of a space problem: d(N) for polygon pieces (and d(M) for a polygon container), 1 for solids and balls, times D_f. */
function spaceWeight(p: SpaceKey): number {
  const f = fieldsOf(p);
  let w = 1;
  if (f.family === "surface" || f.family === "sphere" || f.family === "torus") w = distinctness(f.N);
  if (f.family === "curved") w = distinctness(f.N) * distinctness(f.M);
  return w * PREMIUM * LEVEL[unitsRow(p)];
}

// ---------- cost of an evaluation ----------

/** Median ms of one mc_compress evaluation (open run, after Compact) by N+M+P, measured 2026-10-20 [CALC]. */
export const COST_TABLE: readonly (readonly [number, number])[] = [
  [18, 0.22],
  [24, 0.31],
  [33, 0.45],
  [54, 0.87],
  [64, 1.31],
  [85, 1.77],
  [180, 7.35],
  [326, 22.8],
  [500, 52.3],
];

/** A table's value at x, interpolated on log-log axes and extrapolated at the ends along the end segments. */
function logLog(T: readonly (readonly [number, number])[], x: number): number {
  let i = 0;
  while (i < T.length - 2 && x > T[i + 1][0]) i++;
  const [x0, y0] = T[i];
  const [x1, y1] = T[i + 1];
  const slope = Math.log(y1 / y0) / Math.log(x1 / x0);
  return y0 * Math.pow(x / x0, slope);
}

/** The cost of one evaluation at size N+M+P, interpolated on log-log axes (extrapolated at the ends). */
export function msPerEval(total: number): number {
  return logLog(COST_TABLE, Math.max(2, total));
}

/**
 * Median ms of one kernel evaluation by row and P, measured 2026-11-03 on an M1 Pro [CALC]
 * (scratchpad dim-pay2/stage1.json). surface:nofold was not measured (the game never offers it): a
 * tenth of surface:fold, the ratio of their units before.
 */
export const KERNEL_MS: Readonly<Record<string, readonly (readonly [number, number])[]>> = {
  sphere: [[12, 0.0211], [24, 0.0719], [48, 0.266], [100, 1.39]],
  torus: [[12, 0.0397], [24, 0.118], [48, 0.379], [100, 1.64], [200, 6.54], [500, 45.1]],
  curved: [[12, 0.218], [24, 0.735], [48, 3.01], [100, 12.7]],
  "surface:fold": [[12, 0.495], [24, 0.987], [48, 2.15], [100, 6.3]],
  "surface:nofold": [[12, 0.0495], [24, 0.0987], [48, 0.215], [100, 0.63]],
  polyhedra: [[12, 0.0754], [24, 0.16], [48, 0.355], [100, 1.11], [200, 2.47], [500, 8.19]],
  "balls:ball": [[12, 0.00303], [24, 0.00665], [48, 0.0159], [100, 0.0536]],
  "balls:solid": [[12, 0.0777], [24, 0.25], [48, 0.504], [100, 1.2]],
};

/** The row of KERNEL_MS, LEVEL and FAMILY_FACTOR a space problem is in. */
export function unitsRow(p: SpaceKey): string {
  const f = fieldsOf(p);
  if (f.family === "surface") return `surface:${f.mode}`;
  if (f.family === "balls") return f.code.startsWith("ball") ? "balls:ball" : "balls:solid";
  return f.family;
}

/** The cost of one kernel evaluation of a space problem's row at P pieces. */
export const kernelMs = (row: string, P: number): number => logLog(KERNEL_MS[row], Math.max(2, P));

/**
 * U = max(1, round(msPerEval(P + 8) / kernelMs)): a game evaluation costs about what one costs on a
 * board of P squares in a square (N + M + P = P + 8), or one kernel evaluation when that costs more.
 */
export const unitsFor = (row: string, P: number): number =>
  Math.max(1, Math.round(msPerEval(P + 8) / kernelMs(row, P)));

// ---------- the rules ----------

/** The generic methods every space offers, mc_compress first (packages/spaces kernels). */
export const SPACE_METHODS: readonly EvolveMethod[] = [
  "mc_compress",
  "penalty",
  "asc",
  "basin_hopping",
  "shrink_repair",
  "harden",
  "morph",
];

const POLYGON_METHODS: readonly EvolveMethod[] = [...SPACE_METHODS, "ls_growth"];

const POLYGON_RULES: FamilyRules = {
  family: "polygon",
  dimension: "2-in-2",
  title: (p) => polygonTitle(needPolygon(p, "title")),
  scoreWord: (p) => (needPolygon(p, "score word").M === 0 ? "diameter" : "side"),
  weight: (p) => {
    const q = needPolygon(p, "shape weight");
    return shapeWeight(q.N, q.M);
  },
  bound: (p) => {
    const q = needPolygon(p, "bound");
    return areaLowerBound(q.N, q.M, q.P);
  },
  unitsPerEvaluation: () => 1,
  evalMs: (p) => {
    const q = needPolygon(p, "evaluation cost");
    return msPerEval(q.N + q.M + q.P);
  },
  methods: POLYGON_METHODS,
};

function spaceOnly(p: ProblemKey, family: SpaceFamily): SpaceKey {
  if (isPolygon(p) || p.family !== family) throw new Error(`not a ${family} problem`);
  return p;
}

function spaceRules(family: SpaceFamily): FamilyRules {
  return {
    family,
    dimension: familyDimension(family),
    title: (p) => spaceTitle(spaceOnly(p, family)),
    scoreWord: (p) => spaceScoreWord(spaceOnly(p, family)),
    weight: (p) => spaceWeight(spaceOnly(p, family)),
    bound: (p) => {
      spaceOnly(p, family);
      const b = p.bound;
      return typeof b === "number" && b > 0 ? b : null;
    },
    unitsPerEvaluation: (p) => {
      const q = spaceOnly(p, family);
      return unitsFor(unitsRow(q), q.P);
    },
    evalMs: (p) => {
      const q = spaceOnly(p, family);
      const row = unitsRow(q);
      return unitsFor(row, q.P) * kernelMs(row, q.P);
    },
    methods: SPACE_METHODS,
  };
}

const SPACE_RULES: Readonly<Record<SpaceFamily, FamilyRules>> = {
  curved: spaceRules("curved"),
  surface: spaceRules("surface"),
  sphere: spaceRules("sphere"),
  torus: spaceRules("torus"),
  polyhedra: spaceRules("polyhedra"),
  balls: spaceRules("balls"),
};

/** The rules of a problem's family. */
export function rulesOf(p: ProblemKey): FamilyRules {
  return isPolygon(p) ? POLYGON_RULES : SPACE_RULES[p.family];
}

/** A problem's name in the player's words: "60-gons in a 47-gon, 80 pieces", "30 squares on a cube, folded over its edges". */
export const problemTitle = (p: ProblemKey): string => rulesOf(p).title(p);

export { familyDimension };
