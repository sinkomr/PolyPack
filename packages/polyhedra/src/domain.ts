/**
 * Solid pairs and piece ranges, independent of the research records: every ordered pair of the 94 solids, P = 2 to
 * 500. The board picks the piece and the container in two menus (grouped by the solids' families); the code of the
 * problem is the two solids' codes joined by "in" (catalogue.ts).
 */
import { PAIR_COUNT, PROBLEM_ORDER, SOLIDS_BY_GROUP, SOLID_GROUPS } from "./catalogue";
import { POLYHEDRA_MAX_P } from "./info";
import { getProblem, volumeBound } from "./problems";

/** The values of the piece and the container menus: the solids' codes, by family. */
const SOLID_VALUES = {
  values: SOLIDS_BY_GROUP.map((s) => s.code),
  titles: Object.fromEntries(SOLIDS_BY_GROUP.map((s) => [s.code, s.title])),
  groups: Object.fromEntries(SOLIDS_BY_GROUP.map((s) => [s.code, SOLID_GROUPS[s.family]])),
};

export const polyhedraDomain = {
  info: {
    // written from the two menus; a page loaded before the pairs (which builds the id from the fields' names) still composes it
    id: "polyhedra/<piece>in<container>/<P>",
    fields: [
      { key: "piece", label: "Piece", ...SOLID_VALUES },
      { key: "container", label: "Container", ...SOLID_VALUES },
      { key: "P", label: "Pieces (P)", min: 2, max: POLYHEDRA_MAX_P },
    ],
    joined: [{ key: "code", parts: ["piece", "container"], separator: "in" }],
    problems: PAIR_COUNT * (POLYHEDRA_MAX_P - 1),
  },
  bound(id: { fields: Readonly<Record<string, string | number>>; P: number }) {
    const p = getProblem(String(id.fields.code));
    if (!p || !Number.isInteger(id.P) || id.P < 2 || id.P > POLYHEDRA_MAX_P) return undefined;
    return { value: volumeBound(p, id.P), label: "volume bound; [CALC]" };
  },
  /**
   * Only the unrecorded range of the 150 problems of the research records, small P first, as the volunteers' work list
   * offered them until it was removed on 2026-10-29. Every pair is open to entries, and the volunteer client now draws
   * from all of them at random.
   */
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
