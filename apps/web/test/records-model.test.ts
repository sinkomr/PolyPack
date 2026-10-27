import type { CertifiedStatus, SpaceInfo, SpaceName, SpaceTarget } from "@polypack/spaces";
import { describe, expect, it } from "vitest";
import {
  chartPoints,
  chartScale,
  domainPRange,
  entryOnlyIds,
  holderText,
  kindHref,
  pTicks,
  parseRecordsHash,
  pickers,
  plotted,
  pointLines,
  recordsHash,
  seriesNote,
  seriesProblems,
  seriesSize,
  seriesTitle,
  settleSeries,
  tabModel,
} from "../src/records-model";
import { DIMENSIONS } from "../src/dimension-table";
import { ListedProblem, SPACE_FIELDS } from "../src/spaces-model";

function problem(
  id: string,
  opts: { cert?: number; status?: CertifiedStatus; site?: number; bound?: number } = {},
): ListedProblem {
  const space = id.split("/")[0] as SpaceName;
  const P = Number(id.split("/").at(-1));
  const cert =
    opts.cert === undefined
      ? null
      : { score: opts.cert, display: opts.cert.toFixed(6), status: opts.status ?? "best_known" };
  const site =
    opts.site === undefined ? null : { id: 1, score: opts.site, name: "Ada", created_at: "2026-10-24T10:00:00Z" };
  const scores = [cert?.score, site?.score].filter((v): v is number => v !== undefined);
  return {
    space,
    id,
    fields: {},
    P,
    certified: cert,
    bound: opts.bound === undefined ? null : { value: opts.bound, label: "area bound; [CALC]" },
    site_best: site,
    best_score: scores.length ? Math.min(...scores) : null,
    accepts_submissions: opts.status !== "proven",
    status: cert ? cert.status : "no_record",
  };
}

const torus = [
  problem("torus/sq/0/1", { cert: 2, bound: 2 }),
  problem("torus/sq/0/2", { cert: 3.5, bound: 3.4, status: "proven" }),
  problem("torus/sq/0/4", { cert: 4.1, bound: 4, site: 4.05 }),
  problem("torus/sq/4/1", { cert: 1.5, bound: 1.2 }),
  problem("torus/hex/0/1", { cert: 2.1, bound: 2 }),
];

describe("tabs", () => {
  it("links each dimension to its first available kind, and the polygons to their own page", () => {
    expect(kindHref("polygon")).toBe("/browse.html");
    expect(kindHref("torus")).toBe("/records.html#space=torus");
    const { dimensions, kinds } = tabModel("polygon");
    expect(dimensions.map((d) => d.text)).toEqual(DIMENSIONS.map((d) => d.label));
    expect(dimensions[0]).toMatchObject({ href: "/browse.html", current: true });
    expect(dimensions[1]).toMatchObject({ href: "/records.html#space=surface", current: false });
    expect(kinds.map((k) => [k.text, k.current])).toEqual([
      ["Flat", true],
      ["Curved", false],
    ]);
  });

  it("lists the kinds of the current dimension only when it has several", () => {
    expect(tabModel("torus").kinds.map((k) => k.text)).toEqual(["Surfaces", "Sphere", "Torus"]);
    expect(tabModel("boundary").kinds).toEqual([]);
    expect(
      tabModel("boundary")
        .dimensions.filter((d) => d.current)
        .map((d) => d.text),
    ).toEqual(["3D on 4D"]);
  });
});

describe("the address", () => {
  const spaces: SpaceName[] = ["curved", "torus"];
  it("round-trips a state, and reads the dimensions page's hash", () => {
    const state = { space: "torus" as const, filters: { family: "hex", N: "0" }, all: true };
    expect(recordsHash(state)).toBe("#space=torus&family=hex&N=0&all=1");
    expect(parseRecordsHash(recordsHash(state), spaces)).toEqual(state);
    expect(parseRecordsHash("#space=torus&family=sq&N=all", spaces)).toMatchObject({
      filters: { family: "sq", N: "all" },
      all: false,
    });
  });
  it("falls back to the first kind, and to none when nothing is offered", () => {
    expect(parseRecordsHash("", spaces)?.space).toBe("curved");
    expect(parseRecordsHash("#space=nowhere", spaces)?.space).toBe("curved");
    expect(parseRecordsHash("#space=torus", [])).toBeNull();
  });
});

describe("pickers and series", () => {
  it("offers the values the records have, and chooses a family that has records", () => {
    const list = pickers("torus", torus);
    expect(list.map((p) => p.spec.key)).toEqual(["family", "N"]);
    expect(list[0].options.map((o) => o.value)).toEqual(["sq", "hex"]);
    // the start value is a disk (N = 0); a wish for a value the records do not have is dropped
    expect(settleSeries(list, torus)).toEqual({ family: "sq", N: "0" });
    expect(settleSeries(list, torus, { family: "sq", N: "4" })).toEqual({ family: "sq", N: "4" });
    expect(settleSeries(list, torus, { family: "free", N: "9" })).toEqual({ family: "sq", N: "0" });
  });

  it("moves a later field on to a value the earlier choices have records for", () => {
    const list = pickers("torus", torus);
    // hex has records for disks only: the wished squares do not exist there, so the start value stays
    expect(settleSeries(list, torus, { family: "hex", N: "4" })).toEqual({ family: "hex", N: "4" });
    const onlyHexDisks = torus.filter((p) => p.id !== "torus/sq/4/1");
    expect(settleSeries(pickers("torus", onlyHexDisks), onlyHexDisks, { family: "hex" })).toEqual({
      family: "hex",
      N: "0",
    });
  });

  it("offers every value of a domain, with the server's names and groups, and the family of its start", () => {
    const info = {
      space: "surface",
      domain: {
        id: "surface/<solid>/<mode>/<N>/<P>",
        problems: 8,
        fields: [
          {
            key: "solid",
            label: "Solid",
            values: ["cube", "prism5"],
            titles: { cube: "Cube", prism5: "Pentagonal prism" },
            groups: { cube: "Platonic solids", prism5: "Prisms" },
          },
          {
            key: "mode",
            label: "Folding",
            values: ["fold", "nofold"],
            titles: { fold: "Fold over edges", nofold: "No fold" },
          },
          { key: "N", label: "Piece (N)", values: ["0", "4"] },
          { key: "P", label: "Pieces (P)", min: 1, max: 100 },
        ],
      },
    } as unknown as SpaceInfo;
    const list = pickers("surface", [], info);
    expect(list[0].options).toEqual([
      { value: "cube", text: "Cube", group: "Platonic solids" },
      { value: "prism5", text: "Pentagonal prism", group: "Prisms" },
    ]);
    expect(list[1].options[1].text).toBe("No fold");
    // N falls back to the field's own names
    expect(list[2].options[1].text).toBe("Squares (N = 4)");
    expect(settleSeries(list, [])).toEqual({ solid: "cube", mode: "fold", N: "4" });
    expect(domainPRange(info)).toEqual([1, 100]);
    expect(seriesSize(info, 3)).toBe(100);
    expect(seriesSize(undefined, 3)).toBe(3);
  });

  it("takes the problems of one family in order of P", () => {
    const specs = SPACE_FIELDS.torus;
    const shuffled = [torus[2], torus[0], torus[4], torus[1]];
    expect(seriesProblems(specs, shuffled, { family: "sq", N: "0" }).map((p) => p.P)).toEqual([1, 2, 4]);
    expect(seriesTitle(specs, { family: "hex", N: "4" })).toBe("hexagonal, square");
  });

  it("says how many problems have a record, and what the kind holds in all", () => {
    const info = { space: "torus", problems: 544, records: 544 } as SpaceInfo;
    const series = seriesProblems(SPACE_FIELDS.torus, torus, { family: "sq", N: "0" });
    expect(seriesNote(info, series, 544, 544)).toBe(
      "3 of this family's 3 problems have a record or an entry. The kind has 544 problems, all with a research record.",
    );
    const domain = {
      space: "surface",
      problems: 712800,
      records: 2038,
      domain: { id: "", problems: 712800, fields: [{ key: "P", label: "P", min: 1, max: 100 }] },
    } as unknown as SpaceInfo;
    expect(seriesNote(domain, [], 2038, 712800)).toBe(
      "None of this family's 100 problems have a record or an entry yet. 2,038 of the kind's 712,800 problems have a research record.",
    );
    const infeasible = problem("curved/-1/3/4/2");
    infeasible.status = "infeasible";
    expect(seriesNote(undefined, [infeasible], 1, 1)).toContain("1 is proved to have no packing");
  });
});

describe("entries on problems without a record", () => {
  const t = (id: string, P: number, leader: SpaceTarget["leader"]): SpaceTarget =>
    ({ space: "balls", id, P, priority: 1, best_score: 1, bound: null, leader, leader_id: null }) as SpaceTarget;
  it("picks the site-led problems that the listing lacks, smallest P first, up to a cap", () => {
    const targets = [
      t("balls/a/9", 9, "site"),
      t("balls/a/3", 3, "site"),
      t("balls/a/5", 5, "none"),
      t("balls/a/4", 4, "certified"),
      t("balls/a/7", 7, "site"),
    ];
    expect(entryOnlyIds(targets, new Set(["balls/a/7"]), 5)).toEqual(["balls/a/3", "balls/a/9"]);
    expect(entryOnlyIds(targets, new Set(), 1)).toEqual(["balls/a/3"]);
  });
});

describe("chart data", () => {
  const series = seriesProblems(SPACE_FIELDS.torus, torus, { family: "sq", N: "0" });
  it("keeps the problems with a record or an entry, with the smaller score as the record", () => {
    const pts = chartPoints([...series, problem("torus/sq/0/8")]);
    expect(pts.map((p) => [p.P, p.record])).toEqual([
      [1, 2],
      [2, 3.5],
      [4, 4.05],
    ]);
    expect(pts[1].certified?.status).toBe("proven");
    expect(pts[2].site?.name).toBe("Ada");
    expect(pts[0].boundLabel).toBe("area bound");
  });

  it("plots sizes, or the distance above the bound", () => {
    const [a, , c] = chartPoints(series);
    expect(plotted("size", 4.05, c)).toBe(4.05);
    expect(plotted("gap", 4.05, c)).toBeCloseTo(0.05, 12);
    expect(plotted("gap", 2, a)).toBe(0);
    expect(plotted("gap", 2, { bound: null })).toBeNull();
  });

  it("scales to hold every score and bound, with finer labels for small gaps", () => {
    const pts = chartPoints(series);
    const size = chartScale(pts, "size")!;
    expect(size.yMin).toBeCloseTo(2 * 0.97, 12);
    expect(size.yMax).toBeCloseTo(4.1 * 1.03, 12);
    expect(size.digits).toBe(2);
    const gap = chartScale(pts, "gap")!;
    expect(gap.yMin).toBeLessThan(0);
    expect(gap.yMax).toBeGreaterThan(0.1);
    expect(gap.digits).toBe(3);
    expect(chartScale([], "size")).toBeNull();
    expect(chartScale([{ ...pts[0], bound: null, record: null, certified: null, site: null }], "size")).toBeNull();
  });

  it("labels round values of P", () => {
    expect(pTicks(1, 10)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(pTicks(1, 100)).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(pTicks(2, 100).length).toBeLessThanOrEqual(17);
  });

  it("describes a point at six decimals, rounded to the nearest", () => {
    const c = chartPoints(series)[2];
    const { head, lines } = pointLines("square torus, disk", c);
    expect(head).toBe("square torus, disk, P = 4");
    expect(lines).toEqual([
      ["record", "4.050000"],
      ["research record", "4.100000 (best known)"],
      ["site best", "4.050000 by Ada"],
      ["lower bound", "4.000000 (area bound)"],
      ["gap", "0.050000 above the bound"],
    ]);
    expect(pointLines("t", { ...c, record: 1.0000005, certified: null, site: null, bound: null }).lines[0]).toEqual([
      "record",
      "1.000001",
    ]);
  });
});

describe("table", () => {
  it("names who holds a record", () => {
    expect(holderText(problem("torus/sq/0/4", { cert: 4.1, site: 4.05 }))).toBe("Site entry");
    expect(holderText(problem("torus/sq/0/4", { cert: 4.1 }))).toBe("Research record");
    expect(holderText(problem("balls/ballinball/4", { site: 3 }))).toBe("Site entry");
    expect(holderText(problem("balls/ballinball/5"))).toBe("—");
  });
});
