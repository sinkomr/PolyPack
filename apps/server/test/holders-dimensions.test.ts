import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HolderRow, HoldersResponse, dimensionRank, problemDimension } from "@polypack/geometry";
import {
  SpaceName,
  SpaceProblemEntry,
  SpacesIndex,
  acceptsSubmissions,
  buildSpaceCatalogue,
  parseSpaceId,
  problemOf,
} from "@polypack/spaces";
import { loadSpacesIndex } from "@polypack/spaces/load";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp, spaceHolderShare } from "../src/app";
import { SqliteStore } from "../src/sqlite-store";
import { NewSpaceEntry, NewSubmission } from "../src/store";
import { withUnits } from "./units";

// The record holders' counts over every Dimension: the polygon problems of 2D in 2D and the problems of the spaces.

const root = resolve(__dirname, "../../..");
const index = loadSpacesIndex(root);
const L2 = Math.SQRT2;

/** Two disks of diameter 1 on the square torus of side L2 k: valid for k >= 1, with the score L2 k. */
const twoDisks = (k = 1) => ({
  lattice: { L: L2 * k },
  poses: [
    [0, 0, 0],
    [(Math.SQRT2 / 2) * k, (Math.SQRT2 / 2) * k, 0],
  ],
});
/** The real catalogues with torus/sq/0/2 open and its research record made much worse (3), so that entries beat it. */
const testIndex: SpacesIndex = (() => {
  const file = JSON.parse(readFileSync(join(root, "data/torus/records.json"), "utf8"));
  for (const r of file.records)
    if (r.problem === "torus/sq/0/2")
      Object.assign(r, {
        status: "best_known",
        bound: { value: L2, label: "a test bound" },
        score_cert: 3,
        display: "3.000000",
        configuration: twoDisks(3 / L2),
      });
  return { ...index, torus: buildSpaceCatalogue("torus", file) };
})();
const TORUS = "torus/sq/0/2";

/** The first problem of a space's catalogue that takes entries and has a positive research record. */
const open = (space: SpaceName): SpaceProblemEntry =>
  index[space]!.problems.find((p) => acceptsSubmissions(p) && (p.certified?.score ?? 0) > 0)!;
/** A problem of a space's catalogue that takes no entries. */
const closed = (space: SpaceName): SpaceProblemEntry => testIndex[space]!.problems.find((p) => !acceptsSubmissions(p))!;

const flat = (P: number, name: string): NewSubmission => ({
  N: 4,
  M: 4,
  P,
  score: 10,
  name,
  agent_note: "",
  found_with: "hand",
  method: null,
  method_params: null,
  seed: null,
  budget: null,
  software: null,
  pieces: [],
  container_phi: 0,
  created_at: "2026-11-20T00:00:00.000Z",
  verification: "none",
  literature_value: null,
  strict_check: null,
});
const spaceRow = (space: string, problem: string, score: number, name: string): NewSpaceEntry => ({
  space,
  problem,
  score,
  name,
  agent_note: "",
  software: null,
  method: null,
  seed: null,
  config: "{}",
  created_at: "2026-11-20T00:00:00.000Z",
});

let store: SqliteStore;
let app: ReturnType<typeof createApp>;
const makeApp = (chunk?: number) =>
  (app = createApp({
    store,
    records: [],
    adminToken: "secret",
    clientIp: () => "1.1.1.1",
    log: () => {},
    spaces: { index: testIndex, store },
    holdersChunk: chunk,
  }));
beforeEach(() => {
  store = new SqliteStore(":memory:");
  makeApp();
});

const holders = async (): Promise<HolderRow[]> =>
  ((await (await app.request("/api/holders")).json()) as HoldersResponse).holders;
const row = (rows: HolderRow[], name: string) => rows.find((h) => h.name === name);
const admin = (path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer secret" },
    body: JSON.stringify(body),
  });
const submitTorus = async (name: string, k = 1) =>
  (await (
    await app.request("/api/spaces/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(withUnits({ space: "torus", id: TORUS, config: twoDisks(k), name })),
    })
  ).json()) as { valid: boolean; leader: boolean; id: number | null };
/** The answer without the peaks, which depend on the history of the counts. */
const withoutPeaks = (rows: HolderRow[]) => rows.filter((h) => h.site_bests > 0).map(({ peak: _peak, ...h }) => h);
/** What a server started now counts: the leaders of every problem, read anew. */
const fresh = async () => {
  const kept = app;
  makeApp();
  const rows = await holders();
  app = kept;
  return withoutPeaks(rows);
};

describe("problemDimension", () => {
  it("places every kind of problem in its Dimension, by the ids of the records pages", () => {
    expect(problemDimension(null, "")).toBe("2-in-2");
    expect(problemDimension("curved", "curved/-1/0/0/12")).toBe("2-in-2");
    for (const space of ["surface", "sphere", "torus"]) expect(problemDimension(space, `${space}/x/1`)).toBe("2-on-3");
    for (const space of ["polyhedra", "balls"]) expect(problemDimension(space, `${space}/x/1`)).toBe("3-in-3");
    for (const p of ["tesseract", "5cell", "16cell", "24cell", "120cell", "600cell"])
      expect(problemDimension("boundary", `boundary/${p}/ball/9`)).toBe("3-on-4");
    expect(problemDimension("boundary", "boundary/5cube/ball/9")).toBe("4-on-5");
    expect(problemDimension("boundary", "boundary/10orthoplex/ball/3")).toBe("9-on-10");
    expect(problemDimension("ndim", "ndim/4/cube/ball/3")).toBe("4-in-4");
    expect(problemDimension("ndim", "ndim/10/cube/cube/12")).toBe("10-in-10");
    expect(problemDimension("ndim", "ndim/x/cube/cube/12")).toBeNull();
    expect(problemDimension("nowhere", "nowhere/1")).toBeNull();
  });

  it("orders the Dimensions by the pieces' dimension, in before on", () => {
    const ids = ["10-in-10", "3-on-4", "2-on-3", "9-on-10", "4-in-4", "2-in-2", "3-in-3"];
    expect([...ids].sort((a, b) => dimensionRank(a) - dimensionRank(b))).toEqual([
      "2-in-2",
      "2-on-3",
      "3-in-3",
      "3-on-4",
      "4-in-4",
      "9-on-10",
      "10-in-10",
    ]);
  });
});

describe("spaceHolderShare", () => {
  const p = open("sphere");
  const lead = (score: number) => ({ id: 1, space: "sphere", problem: p.id, score, name: "ann", created_at: "t" });
  const cert = p.certified!.score;
  it("is a record below the research record, beating it; otherwise a site best only", () => {
    expect(spaceHolderShare(lead(cert / 2), p)).toEqual({
      name: "ann",
      records: 1,
      beat_published: 1,
      site_bests: 1,
      pending: 0,
      dimension: "2-on-3",
    });
    expect(spaceHolderShare(lead(cert), p)).toMatchObject({ records: 0, beat_published: 0, site_bests: 1 });
    expect(spaceHolderShare(lead(cert * 2), p)).toMatchObject({ records: 0, beat_published: 0, site_bests: 1 });
  });
  it("is a record without beating anything where there is no research record", () => {
    expect(spaceHolderShare(lead(cert * 2), { ...p, status: "no_record", certified: null })).toMatchObject({
      records: 1,
      beat_published: 0,
    });
  });
  it("is nothing for a closed problem or one outside the catalogue", () => {
    expect(spaceHolderShare(lead(1), closed("torus"))).toBeNull();
    expect(spaceHolderShare(lead(1), null)).toBeNull();
  });
});

describe("GET /api/holders over every Dimension", () => {
  it("counts the leaders of every Dimension under their names, with the records by Dimension", async () => {
    const sphere = open("sphere");
    const polyhedra = open("polyhedra");
    // the balls have no research records: a problem of their domain
    const parsedBalls = parseSpaceId("balls", "balls/ballinball/13");
    const balls = typeof parsedBalls === "string" ? null : problemOf(index.balls!, parsedBalls);
    expect(balls?.status).toBe("no_record");
    const boundary = open("boundary");
    const ndim = open("ndim");
    const curved = open("curved");
    for (const [i, name] of ["ann", "ann", "bob"].entries()) await store.insert(flat(i + 1, name));
    for (const [space, p, factor, name] of [
      ["sphere", sphere, 0.5, "ann"],
      ["torus", testIndex.torus!.byId.get(TORUS)!, 0.5, "ann"],
      // worse than the research record: a site best, not a record
      ["polyhedra", polyhedra, 2, "bob"],
      ["balls", { ...balls!, certified: { score: 8 } }, 0.5, "bob"],
      ["boundary", boundary, 0.5, "cat"],
      ["ndim", ndim, 0.5, "cat"],
      ["curved", curved, 0.5, "cat"],
    ] as const)
      await store.spaceSubmit(spaceRow(space, p.id, p.certified!.score * factor, name));
    // a closed problem counts for no one
    const shut = closed("torus");
    await store.spaceSubmit(spaceRow("torus", shut.id, 1, "dan"));

    const rows = await holders();
    expect(rows.map((h) => h.name)).toEqual(["ann", "cat", "bob"]);
    expect(row(rows, "ann")).toEqual({
      name: "ann",
      records: 4,
      beat_published: 2,
      site_bests: 4,
      pending: 0,
      peak: 4,
      dimensions: { "2-in-2": 2, "2-on-3": 2 },
    });
    expect(row(rows, "bob")).toEqual({
      name: "bob",
      records: 2,
      beat_published: 0,
      site_bests: 3,
      pending: 0,
      peak: 2,
      dimensions: { "2-in-2": 1, "3-in-3": 1 },
    });
    const ndimD = Number(ndim.id.split("/")[1]);
    expect(row(rows, "cat")).toEqual({
      name: "cat",
      records: 3,
      beat_published: 3,
      site_bests: 3,
      pending: 0,
      peak: 3,
      // in the order of the Dimensions, whatever the order of the entries
      dimensions: Object.fromEntries(
        [
          ["2-in-2", 1],
          [problemDimension("boundary", boundary.id)!, 1],
          [`${ndimD}-in-${ndimD}`, 1],
        ].sort(([a], [b]) => dimensionRank(a as string) - dimensionRank(b as string)),
      ),
    });
    expect(Object.keys(row(rows, "cat")!.dimensions)[0]).toBe("2-in-2");
    // the per-name page still counts the polygon problems only
    const page = (await (await app.request("/api/holder?name=ann")).json()) as { records: number; peak: number };
    expect(page.records).toBe(2);
    expect(page.peak).toBe(4);
  });

  it("moves a record with each submission, rename and removal of a space entry, and raises the peak", async () => {
    await store.insert(flat(1, "ann"));
    expect(withoutPeaks(await holders())).toEqual([
      { name: "ann", records: 1, beat_published: 0, site_bests: 1, pending: 0, dimensions: { "2-in-2": 1 } },
    ]);
    const first = await submitTorus("ann", 1.5);
    expect(first.leader).toBe(true);
    let rows = await holders();
    expect(row(rows, "ann")).toMatchObject({
      records: 2,
      beat_published: 1,
      peak: 2,
      dimensions: { "2-in-2": 1, "2-on-3": 1 },
    });
    expect(withoutPeaks(rows)).toEqual(await fresh());

    // a better entry of another name takes the lead
    const better = await submitTorus("bob", 1.2);
    expect(better.leader).toBe(true);
    rows = await holders();
    expect(row(rows, "ann")).toMatchObject({ records: 1, peak: 2, dimensions: { "2-in-2": 1 } });
    expect(row(rows, "bob")).toMatchObject({ records: 1, beat_published: 1, dimensions: { "2-on-3": 1 } });
    expect(withoutPeaks(rows)).toEqual(await fresh());

    // renamed by an administrator: the record goes with the new name
    expect((await admin("/api/admin/spaces/edit", { id: better.id, name: "cat" })).status).toBe(200);
    rows = await holders();
    expect(row(rows, "cat")).toMatchObject({ records: 1, dimensions: { "2-on-3": 1 } });
    // bob held a record, so it stays listed at zero
    expect(row(rows, "bob")).toMatchObject({ records: 0, site_bests: 0, peak: 1, dimensions: {} });
    expect(withoutPeaks(rows)).toEqual(await fresh());
    // a new note moves nothing
    expect((await admin("/api/admin/spaces/edit", { id: better.id, agent_note: "x" })).status).toBe(200);
    expect(withoutPeaks(await holders())).toEqual(await fresh());

    // removed: the problem has no entry left (only its leader was kept)
    expect((await admin("/api/admin/spaces/remove", { id: better.id })).status).toBe(200);
    rows = await holders();
    expect(row(rows, "cat")).toMatchObject({ records: 0, site_bests: 0, peak: 1 });
    expect(withoutPeaks(rows)).toEqual(await fresh());
  });

  for (const ticks of [0, 1, 3, 10, 40])
    it(`counts a space submission made while the counts are built once (after ${ticks} turns of the event loop)`, async () => {
      for (let P = 1; P <= 6; P++) await store.insert(flat(P, P % 2 ? "ann" : "bob"));
      for (const p of index
        .sphere!.problems.filter((q) => acceptsSubmissions(q) && (q.certified?.score ?? 0) > 0)
        .slice(0, 4))
        await store.spaceSubmit(spaceRow("sphere", p.id, p.certified!.score / 2, "cat"));
      await store.spaceSubmit(spaceRow("torus", TORUS, 2, "ann"));
      makeApp(1);
      const building = holders();
      for (let i = 0; i < ticks; i++) await new Promise<void>((done) => setImmediate(done));
      expect((await submitTorus("dan")).leader).toBe(true);
      await building;
      const rows = await holders();
      expect(row(rows, "dan")).toMatchObject({ records: 1, dimensions: { "2-on-3": 1 } });
      expect(withoutPeaks(rows)).toEqual(await fresh());
    });

  it("lists a problem of a space whose id its catalogue does not know for no one", async () => {
    await store.spaceSubmit(spaceRow("sphere", "sphere/9/99999", 1, "ann"));
    await store.spaceSubmit(spaceRow("nowhere", "nowhere/1", 1, "ann"));
    expect(await holders()).toEqual([]);
    const parsed = parseSpaceId("sphere", "sphere/9/99999");
    expect(typeof parsed === "string" || problemOf(index.sphere!, parsed) === null).toBe(true);
  });
});
