/**
 * The open problems Tighter deals: the curated frontier of design.md §6. Swap this module to change
 * the list; nothing else in the game names a problem.
 *
 * N, M ∈ FRONTIER_SIDES (neighbours differ by at most 14 %) and P ∈ FRONTIER_P: 17 · 17 · 9 = 2,601
 * problems. All have N or M above 20, so the site's nightly free-improvements job (N, M <= 20) never
 * touches them, and none has a published value.
 */
export const FRONTIER_SIDES = [21, 24, 27, 30, 33, 36, 40, 44, 47, 50, 55, 60, 66, 72, 80, 90, 100] as const;
export const FRONTIER_P = [40, 60, 80, 100, 120, 150, 200, 250, 300] as const;

export type SpaceFamily = "curved" | "surface" | "sphere" | "torus" | "polyhedra" | "balls";
export type Family = "polygon" | SpaceFamily;
/** The site's Dimensions (apps/web/src/dimension-table.ts ids). */
export type DimensionId = "2-in-2" | "2-on-3" | "3-in-3" | "3-on-4";
export interface PolygonKey {
  family: "polygon";
  N: number;
  M: number;
  P: number;
}
/** A problem of /api/spaces, by its catalogue id ("sphere/0/12", "surface/cube/fold/7/20", "polyhedra/<code>/<P>"). */
export interface SpaceKey {
  family: SpaceFamily;
  id: string;
  P: number;
}
export type ProblemKey = PolygonKey | SpaceKey;
export const isPolygon = <T extends ProblemKey>(p: T): p is T & PolygonKey => p.family === "polygon";

const SPACE_FAMILIES: readonly string[] = ["curved", "surface", "sphere", "torus", "polyhedra", "balls"];

/** The Dimension a family belongs to. */
export function familyDimension(f: Family): DimensionId {
  switch (f) {
    case "polygon":
    case "curved":
      return "2-in-2";
    case "surface":
    case "sphere":
    case "torus":
      return "2-on-3";
    default:
      return "3-in-3";
  }
}

export const poly = (N: number, M: number, P: number): PolygonKey => ({ family: "polygon", N, M, P });

/** The polygon problem, or "not yet" for a family whose code is still to come (`what`: the thing that is polygon-only). */
export function needPolygon<T extends ProblemKey>(p: T, what: string): T & PolygonKey {
  if (!isPolygon(p)) throw new Error(`not yet: ${what} for ${p.family}`);
  return p;
}

/** Just the identity of a problem: what a ProblemState or a candidate carries beside its fields, left out. */
export const keyPart = (p: ProblemKey): ProblemKey =>
  isPolygon(p) ? poly(p.N, p.M, p.P) : { family: p.family, id: p.id, P: p.P };

export const keyOf = (p: ProblemKey): string => (isPolygon(p) ? `${p.N}/${p.M}/${p.P}` : p.id);

export function parseKey(key: string): ProblemKey | null {
  const m = /^(\d+)\/(\d+)\/(\d+)$/.exec(key);
  if (m) return poly(Number(m[1]), Number(m[2]), Number(m[3]));
  const parts = key.split("/");
  if (parts.length < 2 || !SPACE_FAMILIES.includes(parts[0]!)) return null;
  const last = parts[parts.length - 1]!;
  if (!/^\d+$/.test(last)) return null;
  return { family: parts[0] as SpaceFamily, id: key, P: Number(last) };
}

function product(sides: readonly number[], ps: readonly number[]): PolygonKey[] {
  const out: PolygonKey[] = [];
  for (const N of sides) for (const M of sides) for (const P of ps) out.push(poly(N, M, P));
  return out;
}

/** All 2,601 frontier problems, in a fixed order (N, then M, then P). */
export const FRONTIER: readonly PolygonKey[] = product(FRONTIER_SIDES, FRONTIER_P);

/**
 * The first problem of a new game comes from a smaller corner of the frontier [SPEC]: few sides and
 * few pieces, so that Compact takes about a second and the shape weight w = (20/N)(20/M) is at least
 * 0.31, which makes the first record pay for the first upgrade (5 RP). 6 · 6 · 3 = 108 problems.
 */
export const STARTER: readonly PolygonKey[] = product([21, 24, 27, 30, 33, 36], [40, 60, 80]);

/** Shape names as the site writes them: "60-gons in a 47-gon". */
export function shapeName(n: number, plural: boolean): string {
  if (n === 0) return plural ? "circles" : "circle";
  const names: Record<number, string> = {
    3: "triangle",
    4: "square",
    5: "pentagon",
    6: "hexagon",
    7: "heptagon",
    8: "octagon",
    9: "nonagon",
    10: "decagon",
    12: "dodecagon",
  };
  const base = names[n] ?? `${n}-gon`;
  return plural ? `${base}s` : base;
}

export function problemTitle(p: ProblemKey): string {
  const q = needPolygon(p, "problem title");
  const container = shapeName(q.M, false);
  const article = /^[aeiou8]|^1[18]-/.test(container) ? "an" : "a";
  return `${shapeName(q.N, true)} in ${article} ${container}, ${q.P} pieces`;
}
