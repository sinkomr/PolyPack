/**
 * Every ordered pair of the 186 solids is a problem (catalogue.ts problemNameOf): codes that parse back, titles,
 * the domain's menus, the volume bound, a lattice start and the search on a sample of pairs from every family of
 * piece and of container. P is 2 or 3 and the budgets are short: properties, not bit-exact results.
 */
import { describe, expect, it } from "vitest";
import {
  PAIR_CACHE,
  PAIR_COUNT,
  PROBLEM_NAMES,
  SOLIDS_BY_GROUP,
  SOLID_GROUPS,
  SOLID_NAMES_LIST,
  pairCode,
  problemNameOf,
  problemTitle,
} from "../src/catalogue";
import {
  POLYHEDRA_MAX_COORD,
  POLYHEDRA_MAX_P,
  POLYHEDRA_MAX_SIZE,
  getProblem,
  latticeStart,
  parsePolyhedraId,
  polyhedraDomain,
  searchPolyhedra,
  solidNameOfCode,
  validatePolyhedra,
  volumeBound,
} from "../src";

describe("the problems of every pair of solids", () => {
  it("name 34,596 pairs by their solids' codes, each code once and read back as the same pair", () => {
    expect(SOLID_NAMES_LIST.length).toBe(186);
    expect(PAIR_COUNT).toBe(34596);
    const seen = new Set<string>();
    for (const a of SOLID_NAMES_LIST)
      for (const b of SOLID_NAMES_LIST) {
        const code = `${a.code}in${b.code}`;
        expect(seen.has(code), code).toBe(false);
        seen.add(code);
        const p = problemNameOf(code)!;
        expect(p, code).not.toBeNull();
        expect([p.code, p.piece, p.container]).toEqual([code, a.name, b.name]);
        expect(pairCode(a.name, b.name)).toBe(code);
        expect(solidNameOfCode(a.code)).toBe(a.name);
      }
    expect(seen.size).toBe(34596);
    // the 150 problems of the records keep their families, wiki flags and titles
    for (const q of PROBLEM_NAMES) {
      expect(problemNameOf(q.code)).toBe(q);
      expect(q.family).not.toBe("pairs");
    }
    expect(PROBLEM_NAMES.length).toBe(150);
    expect(PROBLEM_NAMES.filter((q) => q.wiki).length).toBe(86);
  });

  it("have titles made from the solids' names, one per pair", () => {
    expect(problemNameOf("kttinpkd")).toMatchObject({
      piece: "triakis_tetrahedron",
      container: "pentakis_dodecahedron",
      family: "pairs",
      wiki: false,
      title: "Triakis tetrahedra in a pentakis dodecahedron",
    });
    expect(problemTitle("pr12l3inbp7")).toBe("Dodecagonal prisms of height 3 in a heptagonal bipyramid");
    expect(problemTitle("tz4inico")).toBe("Square trapezohedra in an icosahedron");
    expect(problemTitle("cubintet")).toBe("Cubes in a tetrahedron");
    expect(problemTitle("nonsense")).toBe("nonsense");
    const titles = new Set<string>();
    for (const a of SOLID_NAMES_LIST) for (const b of SOLID_NAMES_LIST) titles.add(problemTitle(`${a.code}in${b.code}`));
    expect(titles.size).toBe(34596);
  });

  it("refuse what is not a pair", () => {
    for (const code of ["", "in", "cub", "cubin", "incub", "cubincubin", "cubincu", "cubinxyz", "CUBINCUB", "cub in cub", "x".repeat(40)])
      expect(problemNameOf(code), code).toBeNull();
    expect(getProblem("tz3incub")).toBeNull();
    expect(parsePolyhedraId("polyhedra/kttinpkd/7")).toMatchObject({ code: "kttinpkd", P: 7 });
    expect(parsePolyhedraId("polyhedra/kttinpkd/0")).toBe("P must be at least 1");
    expect(typeof parsePolyhedraId("polyhedra/kttinxx/7")).toBe("string");
  });

  it("keep no memory of what is not a pair, so that junk ids cannot grow it", () => {
    problemNameOf("kttinpkd");
    const size = PAIR_CACHE.size;
    expect(size).toBeLessThanOrEqual(34446);
    for (let i = 0; i < 20_000; i++) {
      expect(problemNameOf(`junk${i}in${i * 7}`)).toBeNull();
      problemNameOf(`cubin${i}`);
    }
    expect(PAIR_CACHE.size).toBe(size);
  });

  it("are offered in two menus of 186 solids, grouped by family, that make the codes", () => {
    const d = polyhedraDomain.info;
    type Field = { key: string; values?: string[]; titles?: Record<string, string>; groups?: Record<string, string>; min?: number; max?: number };
    const [piece, container, P] = d.fields as Field[];
    expect([piece.key, container.key, P.key]).toEqual(["piece", "container", "P"]);
    expect(piece.values).toEqual(SOLIDS_BY_GROUP.map((s) => s.code));
    expect(new Set(piece.values).size).toBe(186);
    expect(container.values).toEqual(piece.values);
    // the pattern names the two menus, so that a page that knows only fields by name composes the id
    expect(d.id).toBe("polyhedra/<piece>in<container>/<P>");
    expect(d.joined).toEqual([{ key: "code", parts: ["piece", "container"], separator: "in" }]);
    expect(d.problems).toBe(34596 * (POLYHEDRA_MAX_P - 1));
    expect([P.min, P.max]).toEqual([2, 500]);
    // the groups come in runs, one per family, so that the menu has one heading for each
    const runs: string[] = [];
    for (const v of piece.values!) {
      const g = piece.groups![v];
      if (runs.at(-1) !== g) runs.push(g);
    }
    // the Johnson solids have a group but no solid in the menus yet
    expect(runs).toEqual(Object.values(SOLID_GROUPS));
    expect(piece.titles!.pr12l3).toBe("dodecagonal prism of height 3");
    // prisms come by their number of sides, the prisms of height 1.5, 2 and 3 after them
    const order = piece.values!;
    expect(order.indexOf("pr7")).toBe(order.indexOf("pr6") + 1);
    expect(order.indexOf("pr3l2")).toBe(order.indexOf("pr3l15") + 1);
  });

  it("have the volume bound of the existing ones, and it is the domain's bound", () => {
    const p = getProblem("tdoinktt")!;
    const v = volumeBound(p, 7);
    expect(v).toBeGreaterThan(0);
    expect(polyhedraDomain.bound({ fields: { code: "tdoinktt" }, P: 7 })).toEqual({ value: v, label: "volume bound; [CALC]" });
    expect(polyhedraDomain.bound({ fields: { code: "tdoinktt" }, P: 501 })).toBeUndefined();
    expect(polyhedraDomain.bound({ fields: { code: "tdoinktt" }, P: 1 })).toBeUndefined();
    expect(polyhedraDomain.bound({ fields: { code: "tdoinxx" }, P: 5 })).toBeUndefined();
  });

  it("keep the volunteers' sample to the 150 problems of the records", () => {
    const codes = new Set(PROBLEM_NAMES.map((q) => q.code));
    for (const id of polyhedraDomain.sample(2000)) expect(codes.has(id.split("/")[1]), id).toBe(true);
  });
});

/** A piece of each family against a container of another family: 16 pairs, with a long prism in a small solid. */
const FAMILY_REPS = ["tet", "tte", "ktt", "pr7", "ap9", "pr3l15", "bp5", "tz6"];
const SAMPLE: string[] = [
  ...FAMILY_REPS.flatMap((a, i) => [1, 3].map((k) => `${a}in${FAMILY_REPS[(i + k) % FAMILY_REPS.length]}`)),
  "pr12l3intet",
  "tidinktt",
  "bp12inap4",
  "dtcinpr3l15",
];

describe("a sample of pairs from every family combination", () => {
  it("has a lattice start that is strictly valid, inside the server's limits, above the volume bound", () => {
    for (const code of SAMPLE) {
      const p = getProblem(code)!;
      for (const P of [2, 3, 40]) {
        const c = latticeStart(p, P);
        expect(c.s, code).toBeGreaterThan(0);
        expect(c.s, code).toBeLessThan(POLYHEDRA_MAX_SIZE);
        expect(c.s, code).toBeGreaterThanOrEqual(volumeBound(p, P));
        for (const q of c.pieces) for (let i = 0; i < 3; i++) expect(Math.abs(q[i]), code).toBeLessThan(POLYHEDRA_MAX_COORD);
        const v = validatePolyhedra(p, c, { tol: 0 });
        expect(v.valid, `${code} P=${P}: ${v.errors[0]}`).toBe(true);
      }
    }
  });

  it("is searched from scratch into valid packings, above the volume bound", () => {
    for (const [i, code] of SAMPLE.entries()) {
      const p = getProblem(code)!;
      const P = 2 + (i % 2);
      const r = searchPolyhedra(p, P, { seed: 3, maxEvals: 3_000 });
      expect(r.config, code).not.toBeNull();
      expect(validatePolyhedra(p, r.config!, { tol: 0 }).valid, code).toBe(true);
      expect(r.score, code).toBeGreaterThanOrEqual(volumeBound(p, P) * (1 - 1e-9));
      expect(r.evaluations, code).toBeLessThanOrEqual(3_000);
    }
  });
});
