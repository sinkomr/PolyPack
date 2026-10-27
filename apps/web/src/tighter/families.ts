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
  /** The word for the score: "radius" when the container is a circle, else "side" (a space's: "edge", "scale"). */
  scoreWord(p: ProblemKey): string;
  /** Weight w of the problem's shape in the points. */
  weight(p: ProblemKey): number;
  /** Lower bound of the gap term: a polygon's areaLowerBound, a space problem's from the server (ProblemState.bound). */
  bound(p: ProblemKey & { bound?: number | null }): number | null;
  /**
   * Kernel evaluations of the space's search that one game evaluation is, sized to the CPU time of
   * a 2D evaluation (about 5 ms); 1 for polygons.
   */
  unitsPerEvaluation(p: ProblemKey): number;
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
  if ((m = /^balls\/([a-z]+)\/(\d+)$/.exec(id))) return { family: "balls", code: m[1], P: Number(m[2]) };
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
      return f.M === 0 ? "radius" : "side";
    case "sphere":
      return "radius";
    case "torus":
      return "side";
    case "polyhedra":
      return "scale";
    case "balls":
      // the container of a code `<piece>in<container>`: a cube ends in "cub", a ball in "ball"
      return f.code.endsWith("cub") ? "edge" : "radius";
  }
}

// ---------- weights ----------

/**
 * The family factor D_f of the shape weight [SPEC]: every family counts as much as a polygon
 * problem of the same distinctness for now.
 */
export const FAMILY_FACTOR: Readonly<Record<Family, number>> = {
  polygon: 1,
  curved: 1,
  surface: 1,
  sphere: 1,
  torus: 1,
  polyhedra: 1,
  balls: 1,
};

/** The weight of a space problem: d(N) for polygon pieces (and d(M) for a polygon container), 1 for solids and balls, times D_f. */
function spaceWeight(p: SpaceKey): number {
  const f = fieldsOf(p);
  let w = 1;
  if (f.family === "surface" || f.family === "sphere" || f.family === "torus") w = distinctness(f.N);
  if (f.family === "curved") w = distinctness(f.N) * distinctness(f.M);
  return w * FAMILY_FACTOR[p.family];
}

// ---------- units per evaluation ----------

/**
 * Kernel evaluations per game evaluation at P = 20, by family (the bench, scratchpad r3 [CALC]).
 * The kernels' evaluations cost very different times, so a game evaluation is as many of them as
 * come to about the 5 ms a 2D evaluation takes.
 */
export const UNITS_AT_20: Readonly<Record<string, number>> = {
  sphere: 400,
  torus: 600,
  "balls:ball": 1000,
  "balls:solid": 8,
  curved: 40,
  "surface:fold": 6,
  "surface:nofold": 60,
  polyhedra: 30,
};

/** The row of UNITS_AT_20 a space problem is in. */
export function unitsRow(p: SpaceKey): string {
  const f = fieldsOf(p);
  if (f.family === "surface") return `surface:${f.mode}`;
  if (f.family === "balls") return f.code.startsWith("ball") ? "balls:ball" : "balls:solid";
  return f.family;
}

/** U = max(1, round(base × 20 / P)): fewer pieces make a kernel evaluation cheaper, so more of them make a game evaluation. */
export const unitsFor = (base: number, P: number): number => Math.max(1, Math.round((base * 20) / Math.max(1, P)));

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
  scoreWord: (p) => (needPolygon(p, "score word").M === 0 ? "radius" : "side"),
  weight: (p) => {
    const q = needPolygon(p, "shape weight");
    return shapeWeight(q.N, q.M);
  },
  bound: (p) => {
    const q = needPolygon(p, "bound");
    return areaLowerBound(q.N, q.M, q.P);
  },
  unitsPerEvaluation: () => 1,
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
      return unitsFor(UNITS_AT_20[unitsRow(q)], q.P);
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
