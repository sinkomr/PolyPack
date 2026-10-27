import { faceAreaLowerBound } from "./disk";
import { getSolid, isSolidName, type Solid } from "./solids";
import planarData from "./planar-values.data";

const names: Record<number, string> = {
  0: "disk",
  3: "triangle",
  4: "square",
  5: "pentagon",
  6: "hexagon",
  7: "heptagon",
  8: "octagon",
};
const pieceName = (N: number) => names[N] ?? `${N}-gon`;
const plural = (s: string) => `${s}s`;

/** The faces of each Platonic solid: how many there are (F) and their number of sides (M). */
export const SOLID_FACES: Readonly<Record<string, { F: number; M: number }>> = {
  tetrahedron: { F: 4, M: 3 },
  cube: { F: 6, M: 4 },
  octahedron: { F: 8, M: 3 },
  dodecahedron: { F: 12, M: 5 },
  icosahedron: { F: 20, M: 3 },
};

/** A surface nofold problem and the 2D in 2D problem it is the same as. */
export interface FaceProblem {
  /** The surface problem's pieces, and its solid's faces. */
  P: number;
  F: number;
  /** The 2D in 2D problem: k pieces of shape N (0 for a disk) in a regular M-gon, the face. */
  N: number;
  M: number;
  k: number;
  /** The polygon board's address of that problem. */
  href: string;
}

/**
 * Without folding, each face holds its pieces on its own, and some face holds at least
 * k = ceil(P / F) of them; a k-piece packing of the face on every face holds P. So the best edge of
 * surface/<solid>/nofold/<N>/<P> is the best side of k pieces in the face polygon:
 * s_nofold(solid, N, P) = s2(N, M, k) (docs/spaces/SURFACE.md, 2.1). The 2D in 2D problem of a
 * nofold id, or null for any other id.
 */
export function nofoldFaceProblem(id: string): FaceProblem | null {
  const m = /^surface\/([a-z]+)\/nofold\/(0|[1-9]\d*)\/([1-9]\d*)$/.exec(id);
  if (!m || !Object.hasOwn(SOLID_FACES, m[1])) return null;
  const { F, M } = SOLID_FACES[m[1]];
  const N = Number(m[2]);
  const P = Number(m[3]);
  const k = Math.ceil(P / F);
  return { P, F, N, M, k, href: `/#p=${N},${M},${k}` };
}

/** "3 squares in a square", "1 disk in a triangle": the face problem in words. */
export const faceProblemText = (f: FaceProblem): string =>
  `${f.k} ${f.k === 1 ? pieceName(f.N) : plural(pieceName(f.N))} in a ${pieceName(f.M)}`;

/** "the 2D in 2D problem N = 4, M = 4, P = 3": the text of a link to the face problem. */
export const faceProblemName = (f: FaceProblem): string => `the 2D in 2D problem N = ${f.N}, M = ${f.M}, P = ${f.k}`;

/**
 * The board's note on a nofold problem, in two sentences around a link to the face problem:
 * the text before the link, the link's text and the text after it.
 */
export function nofoldNote(f: FaceProblem): [before: string, link: string, after: string] {
  return [
    `Without folding, each face holds its pieces on its own, and one of the ${f.F} faces must hold at least ` +
      `⌈${f.P} / ${f.F}⌉ = ${f.k} of them. So this is the same as packing ${faceProblemText(f)}, `,
    faceProblemName(f),
    ".",
  ];
}

export interface FaceKind {
  M: number;
  F: number;
}
export interface PlanarValue {
  N: number;
  M: number;
  k: number;
  value: number;
  printed?: { display: string; precision: number; name: string; href: string };
}
/**
 * The 2D in 2D values the notes quote, in site units (disks of diameter 1). The index is generated from
 * data/records.json (packages/surface/scripts/build-planar-values.ts), which is in site units.
 */
export const PLANAR_VALUES: readonly PlanarValue[] = planarData;

/** Group regular faces by polygon, regardless of the solid's family or number of face kinds. */
export function regularFaceKinds(solid: Pick<Solid, "sides" | "regular">): FaceKind[] | null {
  if (!solid.regular.every(Boolean)) return null;
  const counts = new Map<number, number>();
  for (const M of solid.sides) counts.set(M, (counts.get(M) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => a - b).map(([M, F]) => ({ M, F }));
}

export interface SplitFace extends FaceKind {
  N: number;
  k: number;
  value: number;
  lowerBound: boolean;
  printed?: PlanarValue["printed"];
  href: string;
}
export interface FaceSplit {
  faces: SplitFace[];
  value: number;
}

/**
 * Minimise max of the face values subject to sum(F_i k_i) >= P. Capping capacity at P
 * makes this a small dynamic program for any number of regular face kinds. Larger stored
 * packings are also considered: current best values need not be monotone in k.
 * Missing values use the area lower bound, so that a split using one is not an upper bound.
 */
export function bestFaceSplit(N: number, P: number, kinds: readonly FaceKind[], values = PLANAR_VALUES): FaceSplit {
  let states = new Map<number, FaceSplit>([[0, { faces: [], value: 0 }]]);
  for (const { M, F } of kinds) {
    const known = new Map(values.filter((v) => v.N === N && v.M === M).map((v) => [v.k, v]));
    const limit = Math.max(P, ...known.keys());
    const next = new Map<number, FaceSplit>();
    for (const [capacity, state] of states) {
      for (let k = 0; k <= limit; k++) {
        const record = known.get(k);
        if (k > P && !record) continue;
        const value = k === 0 ? 0 : (record?.value ?? faceAreaLowerBound(N, M, k));
        const score = Math.max(state.value, value);
        const filled = Math.min(P, capacity + F * k);
        if (next.has(filled) && next.get(filled)!.value <= score) continue;
        next.set(filled, {
          value: score,
          faces: [
            ...state.faces,
            {
              N,
              M,
              F,
              k,
              value,
              lowerBound: k > 0 && !record,
              printed: record?.printed,
              href: `/#p=${N},${M},${k}`,
            },
          ],
        });
      }
    }
    states = next;
  }
  return states.get(P)!;
}

export type NotePart = string | { text: string; href: string };

/** The source's printed precision (including a trailing '+') is kept in the note. */
export function printedValueNote(record: PlanarValue | SplitFace | undefined, drawableScore?: number): NotePart[] {
  const printed = record?.printed;
  if (!printed) return [];
  // A surface packing also gives coordinates for its fullest face. Do not call the
  // best value printed-only when those coordinates already reach its printed precision.
  if (drawableScore !== undefined && drawableScore <= record!.value + Math.max(10 ** -printed.precision, 1e-9))
    return [];
  const name = printed.name.startsWith("Erich Friedman") ? "Friedman" : printed.name;
  return [
    " ",
    { text: name, href: printed.href },
    ` publishes ${printed.display} for this 2D problem, without coordinates.`,
  ];
}

/** Shared player text for the board, records page and standalone viewer. */
export function surfaceNofoldNote(id: string, drawableScore?: number, compact = false): NotePart[] {
  const face = nofoldFaceProblem(id);
  if (face) {
    const [before, text, after] = nofoldNote(face);
    const record = PLANAR_VALUES.find((v) => v.N === face.N && v.M === face.M && v.k === face.k);
    const same: NotePart[] = compact
      ? [{ text: `Same as N = ${face.N}, M = ${face.M}, P = ${face.k}`, href: face.href }, "."]
      : [before, { text, href: face.href }, after];
    return [...same, ...printedValueNote(record, drawableScore)];
  }
  const match = /^surface\/([^/]+)\/nofold\/(0|[3-9]|[1-9]\d+)\/([1-9]\d*)$/.exec(id);
  if (!match || !isSolidName(match[1])) return [];
  const kinds = regularFaceKinds(getSolid(match[1]));
  if (!kinds?.length) return [];
  const N = Number(match[2]),
    P = Number(match[3]);
  const split = bestFaceSplit(N, P, kinds);
  const parts: NotePart[] = [
    "Without folding, each split across face kinds needs its largest 2D in 2D value. Take the smallest over all splits. Best split by current 2D values: ",
  ];
  split.faces.forEach((f, i) => {
    if (i) parts.push("; ");
    parts.push(`${f.F} ${plural(pieceName(f.M))}: `);
    if (f.k === 0) parts.push("empty");
    else
      parts.push(
        { text: `N = ${N}, M = ${f.M}, P = ${f.k}`, href: f.href },
        ` (${f.printed?.display ?? Number(f.value.toFixed(6))}${f.lowerBound ? ", lower bound; no 2D value" : ""})`,
      );
  });
  parts.push(".");
  if (split.faces.some((f) => f.lowerBound)) parts.push(" This split uses lower bounds where 2D values are missing.");
  for (const f of split.faces)
    if (f.k > 0 && f.printed) {
      // Identify the 2D problem when more than one face kind has a printed value.
      parts.push(
        ...printedValueNote(f).map((p) =>
          typeof p === "string" ? p.replace("this 2D problem", `N = ${N}, M = ${f.M}, P = ${f.k}`) : p,
        ),
      );
    }
  return parts;
}
