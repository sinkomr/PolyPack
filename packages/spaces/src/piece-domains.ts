/** Range domains for curved, whole-sphere and flat-torus pieces. Research records are independent. */
import { curvedBound, makeSpace } from "@polypack/curved";
import { areaBound } from "@polypack/sphere";
import { areaScoreBound, TORUS_MAX_P, type TorusFamily } from "@polypack/torus";
import type { SpaceDomain, SpaceDomainField } from "./domain";
import { formatCurvature, TORUS_FAMILIES } from "./ids";

export const PIECE_NS: readonly number[] = [0, ...Array.from({ length: 98 }, (_, i) => i + 3)];
/** Existing curvature and container choices, including the curvature sweep's published values. */
export const CURVED_KS: readonly number[] = [
  -6.519717439579256, -4.50521902808615, -3.4413111779836725, -2.3365290558829845, -1.1892985685754194, -1, -1e-6, 1e-6,
  1, 1.225778283313099,
];
export const CURVED_MS: readonly number[] = [0, 3, 4, 5, 6, 7, 8, 9, 10, 12];
const pieces: SpaceDomainField = {
  key: "N",
  label: "Piece (N)",
  values: PIECE_NS.map(String),
  titles: Object.fromEntries(PIECE_NS.map((N) => [N, N === 0 ? "Disk (N = 0)" : `${N}-gon`])),
};
const count: SpaceDomainField = { key: "P", label: "Pieces (P)", min: 1, max: 100 };
/** Torus pieces run to TORUS_MAX_P = 500 (a lattice start is offered above P = 100); the others stop at 100. */
const torusCount: SpaceDomainField = { key: "P", label: "Pieces (P)", min: 1, max: TORUS_MAX_P };
const shape = (n: unknown): n is number => typeof n === "number" && PIECE_NS.includes(n);
const countOK = (p: number) => Number.isInteger(p) && p >= 1 && p <= 100;

function sample(prefixes: readonly string[], limit: number): string[] {
  const out: string[] = [];
  // New shapes first so the bounded work list actually offers problems without records.
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
export const curvedDomain: SpaceDomain = {
  info: {
    id: "curved/<K>/<N>/<M>/<P>",
    fields: [
      { key: "K", label: "Curvature", values: CURVED_KS.map(formatCurvature) },
      pieces,
      { key: "M", label: "Container", values: CURVED_MS.map(String) },
      count,
    ],
    problems: CURVED_KS.length * CURVED_MS.length * PIECE_NS.length * 100,
  },
  bound({ fields: { K, N, M }, P }) {
    if (!CURVED_KS.includes(K as number) || !shape(N) || !CURVED_MS.includes(M as number) || !countOK(P))
      return undefined;
    try {
      const value = curvedBound(makeSpace(K as number, N, M as number), P);
      return value === null ? null : { value, label: "area / one piece bound; [CALC]" };
    } catch {
      // At positive curvature some unit pieces do not exist. The validator rejects them;
      // there is no finite score or configuration to manufacture for such a problem.
      return null;
    }
  },
  sample: (limit) =>
    sample(
      CURVED_KS.flatMap((K) => CURVED_MS.map((M) => `curved/${formatCurvature(K)}/<N>/${M}`)),
      limit,
    ),
};
