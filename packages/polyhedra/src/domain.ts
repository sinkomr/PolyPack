/** Solid pairs and piece ranges, independent of the research records. */
import { PROBLEM_NAMES, PROBLEM_ORDER } from "./catalogue";
import { POLYHEDRA_MAX_P } from "./info";
import { getProblem, volumeBound } from "./problems";

const FAMILY: Record<string, string> = {
  platonic: "Platonic", archimedean: "Archimedean", catalan: "Catalan",
  prisms: "Prisms and antiprisms", bipyramids: "Bipyramids", trapezohedra: "Trapezohedra",
};

export const polyhedraDomain = {
  info: {
    id: "polyhedra/<code>/<P>",
    fields: [
      {
        key: "code", label: "Problem", values: PROBLEM_ORDER,
        titles: Object.fromEntries(PROBLEM_NAMES.map((p) => [p.code, p.title])),
        groups: Object.fromEntries(PROBLEM_NAMES.map((p) => [p.code, FAMILY[p.family]])),
      },
      { key: "P", label: "Pieces (P)", min: 2, max: POLYHEDRA_MAX_P },
    ],
    problems: PROBLEM_NAMES.length * (POLYHEDRA_MAX_P - 1),
  },
  bound(id: { fields: Readonly<Record<string, string | number>>; P: number }) {
    const p = getProblem(String(id.fields.code));
    if (!p || !Number.isInteger(id.P) || id.P < 2 || id.P > POLYHEDRA_MAX_P) return undefined;
    return { value: volumeBound(p, id.P), label: "volume bound; [CALC]" };
  },
  /** Only the unrecorded range, small P first; the work list adds the records separately. */
  sample(limit: number): string[] {
    const out: string[] = [];
    for (let P = 101; P <= POLYHEDRA_MAX_P; P++)
      for (const code of PROBLEM_ORDER) {
        if (out.length >= limit) return out;
        out.push(`polyhedra/${code}/${P}`);
      }
    return out;
  },
};
