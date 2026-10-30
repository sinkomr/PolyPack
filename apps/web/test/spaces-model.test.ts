import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type CertifiedStatus, SURFACE_JOHNSON, type SpaceName, type SpaceProblemSummary } from "@polypack/spaces";
import { SOLID_FACES as SEARCH_FACES } from "@polypack/spaces/search";
import { describe, expect, it } from "vitest";
import {
  ALL,
  SOLID_FACES,
  SPACE_FIELDS,
  configUrl,
  day,
  downloadName,
  entriesText,
  fieldValues,
  filterProblems,
  formatK,
  nofoldFaceProblem,
  nofoldNote,
  parseHash,
  pieceName,
  problemStatus,
  round6,
  sentence,
  settleFilters,
  solidGroup,
  solidTitle,
  shownFields,
  siteBelowCertified,
  stateHash,
  statusLabel,
  summaryText,
  plainBoundLabel,
} from "../src/spaces-model";

/** A listed problem as the server sends it; the fields follow from the id. */
function problem(
  id: string,
  opts: { cert?: number | null; status?: CertifiedStatus; site?: number; open?: boolean; bound?: number } = {},
): SpaceProblemSummary {
  const space = id.split("/")[0] as SpaceName;
  const P = Number(id.split("/").at(-1));
  const status = opts.status ?? "best_known";
  const certified = opts.cert === null ? null : { score: opts.cert ?? P, display: round6(opts.cert ?? P), status };
  const site_best =
    opts.site === undefined ? null : { id: 1, score: opts.site, name: "A", created_at: "2026-10-24T10:00:00Z" };
  const scores = [certified?.score, site_best?.score].filter((v): v is number => v !== undefined);
  return {
    space,
    id,
    fields: {},
    P,
    certified,
    bound: opts.bound === undefined ? null : { value: opts.bound, label: "area" },
    site_best,
    best_score: scores.length ? Math.min(...scores) : null,
    accepts_submissions: opts.open ?? status === "best_known",
  };
}

describe("names and numbers", () => {
  it("names pieces and curvatures", () => {
    expect(pieceName(0)).toBe("disk");
    expect(pieceName("4")).toBe("square");
    expect(pieceName(12)).toBe("12-gon");
    expect(formatK("-1")).toBe("−1");
    expect(formatK(1)).toBe("1");
    expect(formatK("0.000001")).toBe("10⁻⁶");
    expect(formatK("-0.000001")).toBe("−10⁻⁶");
    expect(formatK(2.5e-5)).toBe("2.5 × 10⁻⁵");
    expect(formatK("1.225778283313099")).toBe("1.225778");
    expect(formatK("-6.519717439579256")).toBe("−6.519717");
    expect(formatK("x")).toBe("x");
  });

  it("shows scores and bounds at 6 decimals, an exact value without a trailing digit", () => {
    expect(round6(1.7320508075706091)).toBe("1.732051");
    // certified sizes sit a hair above an exact value: 2 (1 + 1e-12) shows as 2, not 2.000001
    expect(round6(2.000000000002)).toBe("2.000000");
    expect(round6(1.0000000000170126)).toBe("1.000000");
    expect(round6(0.9999999999879088)).toBe("1.000000");
    expect(round6(2.8284271247490187)).toBe("2.828427");
    for (const v of [2, 0.29, 1.5, 0.636619]) expect(round6(v)).toBe(v.toFixed(6));
  });

  it("tells the status of a problem, an infeasible one included", () => {
    expect(problemStatus(problem("sphere/0/5", { status: "proven" }))).toBe("proven");
    expect(problemStatus(problem("curved/1/0/0/2", { cert: null, open: false }))).toBe("infeasible");
    expect(problemStatus(problem("curved/1/0/0/3", { cert: null, open: true }))).toBeNull();
    // the status the server sends leads
    expect(problemStatus({ ...problem("curved/1/0/0/2", { cert: null, open: false }), status: "infeasible" })).toBe(
      "infeasible",
    );
    expect(problemStatus({ ...problem("sphere/0/5"), status: "proven" })).toBe("proven");
  });

  it("says whether a problem takes entries, and why not when the server says", () => {
    expect(entriesText(problem("torus/sq/0/5"))).toEqual({ text: "open", why: null });
    expect(entriesText(problem("sphere/0/5", { status: "proven" }))).toEqual({ text: "closed", why: null });
    const closed = { ...problem("sphere/0/5", { status: "proven" }), closed_reason: "Proven optimum (Rankin 1955). " };
    expect(entriesText(closed)).toEqual({ text: "closed", why: "Proven optimum (Rankin 1955)." });
    expect(entriesText({ ...closed, closed_reason: null })).toEqual({ text: "closed", why: null });
    expect(entriesText({ ...closed, closed_reason: "its optimum 0.636620 is proven" }).why).toBe(
      "Its optimum 0.636620 is proven",
    );
    expect(statusLabel("best_known")).toBe("best known");
    expect(statusLabel("infeasible")).toBe("no packing exists");
    expect(statusLabel(null)).toBe("—");
  });

  it("says when the site's best is below the certified value", () => {
    expect(siteBelowCertified(problem("torus/sq/0/5", { cert: 4.5, site: 4.4 }))).toBe(true);
    expect(siteBelowCertified(problem("torus/sq/0/5", { cert: 4.5, site: 4.6 }))).toBe(false);
    expect(siteBelowCertified(problem("torus/sq/0/5", { cert: 4.5 }))).toBe(false);
  });

  it("builds problem addresses, file names, dates and sentences", () => {
    expect(configUrl("curved", "curved/-1/3/4/7")).toBe("/api/spaces/curved/problems/curved/-1/3/4/7");
    expect(configUrl("curved", "curved/1.225778283313099/3/5/5")).toBe(
      "/api/spaces/curved/problems/curved/1.225778283313099/3/5/5",
    );
    expect(downloadName("torus/hex/0/7")).toBe("torus_hex_0_7.json");
    expect(downloadName("curved/-1/3/4/7")).toBe("curved_-1_3_4_7.json");
    expect(day("2026-10-24T10:00:00Z")).toBe("2026-10-24");
    expect(day("yesterday")).toBe("yesterday");
    expect(sentence("smaller is better")).toBe("smaller is better.");
    expect(sentence("Smaller is better. ")).toBe("Smaller is better.");
  });
});

describe("the surface solids' titles and groups", () => {
  it("names each solid by its family, the Johnson solids as J<n> <name>", () => {
    expect(solidTitle("square_pyramid")).toBe("J1 square pyramid");
    expect(solidTitle("triangular_hebesphenorotunda")).toBe("J92 triangular hebesphenorotunda");
    expect(solidTitle("prism5")).toBe("pentagonal prism");
    expect(solidTitle("rhombic_dodecahedron")).toBe("rhombic dodecahedron");
    expect(solidGroup("cube")).toBe("Platonic solids");
    expect(solidGroup("snub_cube")).toBe("Archimedean solids");
    expect(solidGroup("rhombic_triacontahedron")).toBe("Catalan solids");
    expect(solidGroup("antiprism4")).toBe("Antiprisms");
    expect(solidGroup("prism7")).toBe("Prisms");
    expect(solidGroup("gyrobifastigium")).toBe("Johnson solids");
    const johnson = SURFACE_JOHNSON.map(solidGroup);
    expect(new Set(johnson)).toEqual(new Set(["Johnson solids"]));
    expect(SURFACE_JOHNSON).toHaveLength(92);
    expect(new Set(SURFACE_JOHNSON.map(solidTitle)).size).toBe(92);
    expect(SURFACE_JOHNSON.every((n, i) => solidTitle(n).startsWith(`J${i + 1} `))).toBe(true);
  });
});

describe("bound labels", () => {
  it("keeps what a bound rests on and drops the research tags", () => {
    expect(plainBoundLabel("area bound; [CALC]")).toBe("area bound");
    expect(plainBoundLabel("one piece bound; [CALC]")).toBe("one piece bound");
    expect(plainBoundLabel("[CALC] one disk: the shortest lattice vector L must be >= 2")).toBe(
      "one disk: the shortest lattice vector L must be >= 2",
    );
    expect(plainBoundLabel("CALC from EST theorem: Fejes Toth 1943 bound on the minimal angle")).toBe(
      "Fejes Toth 1943 bound on the minimal angle",
    );
    expect(plainBoundLabel("EST: published Tammes optimum, rho >= 2/theta_P")).toBe(
      "published Tammes optimum, rho >= 2/theta_P",
    );
    expect(plainBoundLabel("area; [CALC] rigorous (interval arithmetic)")).toBe("area; rigorous (interval arithmetic)");
    expect(plainBoundLabel("plain words")).toBe("plain words");
  });
});

describe("filters", () => {
  const surface = [
    problem("surface/icosahedron/fold/4/2"),
    problem("surface/cube/nofold/4/10"),
    problem("surface/cube/fold/4/10"),
    problem("surface/cube/fold/4/9"),
    problem("surface/cube/fold/0/3"),
    problem("surface/tetrahedron/fold/4/1"),
  ];

  it("lists the values of a field in its order", () => {
    const [solid, mode, N] = SPACE_FIELDS.surface;
    expect(fieldValues(surface, solid)).toEqual(["tetrahedron", "cube", "icosahedron"]);
    expect(fieldValues(surface, mode)).toEqual(["fold", "nofold"]);
    expect(fieldValues(surface, N)).toEqual(["0", "4"]);
    const curved = [problem("curved/1/0/0/1"), problem("curved/-1/0/5/1"), problem("curved/-0.000001/0/0/2")];
    expect(fieldValues(curved, SPACE_FIELDS.curved[0])).toEqual(["-1", "-0.000001", "1"]);
  });

  it("starts from each space's default, and keeps a wish only when the data has it", () => {
    expect(settleFilters("surface", surface)).toEqual({ solid: "cube", mode: "fold", N: "4" });
    expect(settleFilters("surface", surface, { solid: "icosahedron", N: ALL })).toEqual({
      solid: "icosahedron",
      mode: "fold",
      N: ALL,
    });
    expect(settleFilters("surface", surface, { solid: "octahedron", mode: "sideways" })).toEqual({
      solid: "cube",
      mode: "fold",
      N: "4",
    });
    // a default the data does not have shows every value
    expect(settleFilters("torus", [problem("torus/hex/3/2")])).toEqual({ family: ALL, N: ALL });
  });

  it("keeps the problems that pass, sorted by the id's fields and then by P", () => {
    const rows = filterProblems("surface", surface, { solid: "cube", mode: "fold", N: ALL });
    expect(rows.map((p) => p.id)).toEqual(["surface/cube/fold/0/3", "surface/cube/fold/4/9", "surface/cube/fold/4/10"]);
    expect(filterProblems("surface", surface, { solid: ALL, mode: ALL, N: ALL }).map((p) => p.id)).toEqual([
      "surface/tetrahedron/fold/4/1",
      "surface/cube/fold/0/3",
      "surface/cube/fold/4/9",
      "surface/cube/fold/4/10",
      "surface/cube/nofold/4/10",
      "surface/icosahedron/fold/4/2",
    ]);
    expect(filterProblems("surface", surface, { solid: "cube", mode: "nofold", N: "0" })).toEqual([]);
  });

  it("shows a column only for the fields a filter leaves open", () => {
    expect(shownFields("curved", { K: "-1", N: ALL, M: ALL }).map((f) => f.key)).toEqual(["N", "M"]);
    expect(shownFields("sphere", { N: "0" })).toEqual([]);
  });

  it("names every option of every space", () => {
    expect(SPACE_FIELDS.surface[1].option("fold")).toBe("Fold over edges");
    expect(SPACE_FIELDS.surface[2].option("0")).toBe("Disks (N = 0)");
    expect(SPACE_FIELDS.curved[0].option("-1")).toBe("K = −1");
    expect(SPACE_FIELDS.curved[2].option("0")).toBe("Disk (M = 0)");
    expect(SPACE_FIELDS.torus[0].option("hex")).toBe("Hexagonal (hex)");
    expect(SPACE_FIELDS.torus[0].cell("free")).toBe("free lattice");
  });

  it("sums up a table in one line", () => {
    expect(summaryText([])).toBe("No problems match these filters.");
    expect(
      summaryText([
        problem("curved/1/0/0/1"),
        problem("curved/1/0/0/2", { cert: null, open: false }),
        problem("curved/1/0/0/3", { cert: null, open: false }),
      ]),
    ).toBe("3 problems: 1 best known, 2 where no packing exists. No site entries yet.");
    expect(
      summaryText([
        problem("sphere/0/2", { status: "proven" }),
        problem("sphere/0/15", { cert: 3, site: 2.9 }),
        problem("sphere/0/16", { cert: 3, site: 3.1 }),
      ]),
    ).toBe("3 problems: 1 proven optimal, 2 best known. 2 have site entries, 1 below the certified value.");
    expect(summaryText([problem("sphere/0/15", { cert: 3, site: 3 })])).toBe(
      "1 problem: 1 best known. 1 has a site entry.",
    );
  });
});

describe("the address", () => {
  const spaces: SpaceName[] = ["surface", "curved", "sphere", "torus"];

  it("reads the space and its filters from the hash", () => {
    expect(parseHash("#space=torus&family=hex&N=0&solid=cube", spaces)).toEqual({
      space: "torus",
      filters: { family: "hex", N: "0" },
    });
    expect(parseHash("", spaces)).toEqual({ space: "surface", filters: {} });
    expect(parseHash("#space=plane", spaces)).toEqual({ space: "surface", filters: {} });
    expect(parseHash("#space=torus", [])).toBeNull();
  });

  it("writes it back so that it reads the same", () => {
    const state = { space: "curved" as const, filters: { K: "-0.000001", N: "4", M: ALL } };
    expect(stateHash(state)).toBe("#space=curved&K=-0.000001&N=4&M=all");
    expect(parseHash(stateHash(state), spaces)).toEqual(state);
  });
});

describe("a nofold surface problem is a 2D in 2D problem", () => {
  const root = resolve(__dirname, "../../..");

  it("knows each solid's faces as the surface tables and the search do", () => {
    const solids = JSON.parse(readFileSync(resolve(root, "data/surface/solids.json"), "utf8")).solids as Record<
      string,
      { F: number; M: number; faces: number[][] }
    >;
    // the Platonic solids, whose faces are all one regular M-gon (the other solids list their faces' sides)
    const platonic = Object.entries(solids).filter(([, s]) => s.M !== undefined);
    expect(platonic.length).toBe(5);
    expect(Object.keys(SOLID_FACES).sort()).toEqual(platonic.map(([name]) => name).sort());
    for (const [name, s] of platonic) {
      expect(SOLID_FACES[name], name).toEqual({ F: s.F, M: s.M });
      expect(s.faces.length, name).toBe(s.F);
      expect(SEARCH_FACES[name as keyof typeof SEARCH_FACES], name).toEqual(SOLID_FACES[name]);
    }
  });

  it("names the face problem: k = ceil(P / F) pieces of the same shape in the face polygon", () => {
    expect(nofoldFaceProblem("surface/cube/nofold/4/13")).toEqual({
      P: 13,
      F: 6,
      N: 4,
      M: 4,
      k: 3,
      href: "/#p=4,4,3",
    });
    // disks keep N = 0, as on the polygon board; P = F and P below F need one piece per face
    expect(nofoldFaceProblem("surface/icosahedron/nofold/0/20")).toMatchObject({ N: 0, M: 3, k: 1, href: "/#p=0,3,1" });
    expect(nofoldFaceProblem("surface/dodecahedron/nofold/5/13")).toMatchObject({ M: 5, k: 2, href: "/#p=5,5,2" });
    expect(nofoldFaceProblem("surface/tetrahedron/nofold/8/1")?.href).toBe("/#p=8,3,1");
    for (const id of [
      "surface/cube/fold/4/13",
      "surface/prism/nofold/4/13",
      "surface/constructor/nofold/4/13",
      "surface/cube/nofold/4/0",
      "surface/cube/nofold/04/13",
      "torus/sq/4/13",
    ])
      expect(nofoldFaceProblem(id), id).toBeNull();
  });

  it("matches every nofold research record: its fullest face holds ceil(P / F) pieces", () => {
    const records = JSON.parse(readFileSync(resolve(root, "data/surface/records.json"), "utf8")).records as {
      id: string;
      mode: string;
      P: number;
      k_per_face: number;
      pieces: { face: number }[];
    }[];
    const nofold = records.filter((r) => r.mode === "nofold");
    expect(nofold.length).toBeGreaterThan(0);
    for (const r of nofold) {
      const face = nofoldFaceProblem(r.id)!;
      expect(face, r.id).not.toBeNull();
      const counts = new Map<number, number>();
      for (const q of r.pieces) counts.set(q.face, (counts.get(q.face) ?? 0) + 1);
      expect(Math.max(...counts.values()), r.id).toBe(face.k);
      expect(r.k_per_face, r.id).toBeGreaterThanOrEqual(face.k);
    }
  });

  it("says so in two plain sentences around the link", () => {
    const [before, link, after] = nofoldNote(nofoldFaceProblem("surface/cube/nofold/4/13")!);
    expect(before + link + after).toBe(
      "Without folding, each face holds its pieces on its own, and one of the 6 faces must hold at least " +
        "⌈13 / 6⌉ = 3 of them. So this is the same as packing 3 squares in a square, " +
        "the 2D in 2D problem N = 4, M = 4, P = 3.",
    );
    expect(link).toBe("the 2D in 2D problem N = 4, M = 4, P = 3");
    expect(nofoldNote(nofoldFaceProblem("surface/octahedron/nofold/0/5")!)[0]).toContain(
      "⌈5 / 8⌉ = 1 of them. So this is the same as packing 1 disk in a triangle, ",
    );
  });
});
