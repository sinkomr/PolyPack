/** Range domains for curved, whole-sphere and flat-torus pieces. Research records are independent. */
import { CURVED_MAX_P, curvedBoundOf, curvedMaxP, curvedWhyNot, pieceExists } from "@polypack/curved";
import { MAX_SIDES } from "@polypack/geometry";
import { areaBound } from "@polypack/sphere";
import { areaScoreBound, TORUS_MAX_P, type TorusFamily } from "@polypack/torus";
import type { SpaceDomain, SpaceDomainField } from "./domain";
import { formatCurvature, TORUS_FAMILIES } from "./ids";

export const PIECE_NS: readonly number[] = [0, ...Array.from({ length: 98 }, (_, i) => i + 3)];
/**
 * The curvatures of the curved domain (2026-11-05): the published sweep's ±1 and ±1e-6, 0.5 to 0.0001 of both signs, and
 * the six curvatures of the {3,q} tilings (q = 5, 7, 8, 9, 10, 12), which hold research records, in numeric order.
 */
export const CURVED_MENU_KS: readonly number[] = [
  -1, -0.5, -0.25, -0.1, -0.01, -0.001, -0.0001, -1e-6, 1e-6, 0.0001, 0.001, 0.01, 0.1, 0.25, 0.5, 1,
];
/** The menu's curvatures as ids write them (formatCurvature). */
export const CURVED_MENU_K_IDS: readonly string[] = CURVED_MENU_KS.map(formatCurvature);
/** The tiling curvatures: in the domain with their records, API problems and entries, but not in the board's menu. */
export const CURVED_TILING_KS: readonly number[] = [
  -6.519717439579256, -4.50521902808615, -3.4413111779836725, -2.3365290558829845, -1.1892985685754194, 1.225778283313099,
];
export const CURVED_KS: readonly number[] = [...CURVED_MENU_KS, ...CURVED_TILING_KS].sort((a, b) => a - b);
/** Containers: disks and every regular M-gon the geometry package allows, as 2D in 2D. */
export const CURVED_MS: readonly number[] = [0, ...Array.from({ length: MAX_SIDES - 2 }, (_, i) => i + 3)];
const pieces: SpaceDomainField = {
  key: "N",
  label: "Piece (N)",
  values: PIECE_NS.map(String),
  titles: Object.fromEntries(PIECE_NS.map((N) => [N, N === 0 ? "Disk (N = 0)" : `${N}-gon`])),
};
const count: SpaceDomainField = { key: "P", label: "Pieces (P)", min: 1, max: 100 };
/** Curved pieces run to 500, as 2D in 2D does (the board offers the P that can exist: curvedMaxP). */
const curvedCount: SpaceDomainField = { key: "P", label: "Pieces (P)", min: 1, max: CURVED_MAX_P };
/** Torus pieces run to TORUS_MAX_P = 500 (a lattice start is offered above P = 100); the others stop at 100. */
const torusCount: SpaceDomainField = { key: "P", label: "Pieces (P)", min: 1, max: TORUS_MAX_P };
const shape = (n: unknown): n is number => typeof n === "number" && PIECE_NS.includes(n);
const countOK = (p: number) => Number.isInteger(p) && p >= 1 && p <= 100;

function sample(prefixes: readonly string[], limit: number): string[] {
  const out: string[] = [];
  // New shapes first, so that the bounded work list (removed 2026-10-29) offered problems without records.
  const order = [7, 12, 20, 100, ...PIECE_NS.filter((n) => ![7, 12, 20, 100].includes(n))];
  for (let P = 2; P <= 100; P++)
    for (const N of order)
      for (const prefix of prefixes) {
        if (out.length >= limit) return out;
        out.push(prefix.replace("<N>", String(N)) + `/${P}`);
      }
  return out;
}

export const sphereDomain: SpaceDomain = {
  info: { id: "sphere/<N>/<P>", fields: [pieces, count], problems: PIECE_NS.length * 100 },
  bound({ fields: { N }, P }) {
    if (!shape(N) || !countOK(P)) return undefined;
    return { value: areaBound(N, P) * (1 - 1e-12), label: "area / existence bound; [CALC]" };
  },
  sample: (limit) => sample(["sphere/<N>"], limit),
};
export const torusDomain: SpaceDomain = {
  info: {
    id: "torus/<family>/<N>/<P>",
    fields: [{ key: "family", label: "Torus", values: [...TORUS_FAMILIES] }, pieces, torusCount],
    problems: TORUS_FAMILIES.length * PIECE_NS.length * TORUS_MAX_P,
  },
  bound({ fields: { family, N }, P }) {
    if (!TORUS_FAMILIES.includes(family as TorusFamily) || !shape(N) || !Number.isInteger(P) || P < 1 || P > TORUS_MAX_P)
      return undefined;
    return { value: areaScoreBound(family as TorusFamily, N, P) * (1 - 1e-12), label: "area bound; [CALC]" };
  },
  sample: (limit) =>
    sample(
      TORUS_FAMILIES.map((f) => `torus/${f}/<N>`),
      limit,
    ),
};
const curvedPieces: SpaceDomainField = {
  ...pieces,
  // a unit piece exists at every K <= 0; at K > 0 the larger pieces do not (listed by K, the others have them all)
  dependent: {
    on: "K",
    values: Object.fromEntries(
      CURVED_KS.filter((K) => K > 0).map((K) => [formatCurvature(K), PIECE_NS.filter((N) => pieceExists(N, K)).map(String)]),
    ),
  },
};
const curvedKey = (fields: Readonly<Record<string, string>>) => ({
  K: Number(fields.K),
  N: Number(fields.N),
  M: Number(fields.M),
});
let curvedProblems: number | undefined;
/** The problems that can exist: for every curvature, piece and container, P = 1 up to curvedMaxP (about 0.1 s; computed once). */
function curvedProblemCount(): number {
  if (curvedProblems === undefined) {
    let n = 0;
    for (const K of CURVED_KS) for (const N of PIECE_NS) for (const M of CURVED_MS) n += curvedMaxP(K, N, M);
    curvedProblems = n;
  }
  return curvedProblems;
}
export const curvedDomain: SpaceDomain = {
  info: {
    id: "curved/<K>/<N>/<M>/<P>",
    fields: [
      { key: "K", label: "Curvature", values: CURVED_KS.map(formatCurvature), unlisted: CURVED_TILING_KS.map(formatCurvature) },
      curvedPieces,
      { key: "M", label: "Container", values: CURVED_MS.map(String) },
      curvedCount,
    ],
    get problems() {
      return curvedProblemCount();
    },
  },
  bound({ fields: { K, N, M }, P }) {
    if (!CURVED_KS.includes(K as number) || !shape(N) || !CURVED_MS.includes(M as number) || !Number.isInteger(P) || P < 1 || P > CURVED_MAX_P)
      return undefined;
    // null for an id in the ranges that cannot exist (the piece is absent at K, or no container below the limit holds P)
    const value = curvedBoundOf(K as number, N, M as number, P);
    return value === null ? null : { value, label: "area / one piece bound; [CALC]" };
  },
  menu(key, chosen) {
    const { K, N, M } = curvedKey(chosen);
    // the containers that hold at least one such piece, and P up to the area limit
    if (key === "M") return { values: CURVED_MS.filter((m) => curvedMaxP(K, N, m, 1) >= 1).map(String) };
    if (key === "P") return { range: [1, curvedMaxP(K, N, M)] };
    return undefined;
  },
  impossible({ fields: { K, N, M }, P }) {
    return curvedWhyNot(K as number, N as number, M as number, P);
  },
  sample: (limit) =>
    sample(
      CURVED_KS.flatMap((K) => CURVED_MS.map((M) => `curved/${formatCurvature(K)}/<N>/${M}`)),
      limit,
    ),
};
