/**
 * Problems without a research record (status no_record): listed with their bound, answered with no certified value
 * or configuration, open to entries, the first valid one kept, every one strictly checked, and in the targets.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  SPACE_STRICT_NO_RECORD_REASON,
  SpaceDomain,
  SpaceRecordsResponse,
  SpaceSubmitResponse,
  SpacesIndex,
  SpacesResponse,
  buildSpaceCatalogue,
} from "@polypack/spaces";
import { loadSpacesIndex } from "@polypack/spaces/load";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { SqliteStore } from "../src/sqlite-store";
import { withUnits } from "./units";

const root = resolve(__dirname, "../../..");
const index = loadSpacesIndex(root);
// two disks of diameter 1 on the square torus touch at the side sqrt 2
const L2 = Math.SQRT2;
const ID = "torus/sq/0/2";

/**
 * A test domain of the torus: every torus id is in it (so that the real records stay), with a bound for
 * torus/sq/0/2 only; its sample offers torus/sq/0/2 and torus/sq/0/49, which have no record.
 */
const domain: SpaceDomain = {
  info: {
    id: "torus/<family>/<N>/<P>",
    fields: [
      { key: "family", label: "Torus", values: ["sq", "hex", "free"] },
      { key: "N", label: "Piece (N)", values: ["0", "3", "4", "5", "6"] },
      { key: "P", label: "Pieces (P)", min: 1, max: 49 },
    ],
    problems: 735,
  },
  bound: (id) => (id.P > 49 ? undefined : id.id === ID ? { value: L2, label: "area bound; a test bound" } : null),
  sample: (limit) => [ID, "torus/sq/0/49"].slice(0, limit),
};

/** The real catalogues, with torus/sq/0/2's record taken out and the torus given the test domain. */
function withoutRecord(): SpacesIndex {
  const file = JSON.parse(readFileSync(join(root, "data/torus/records.json"), "utf8"));
  file.records = file.records.filter((r: { problem: string }) => r.problem !== ID);
  return { ...index, torus: buildSpaceCatalogue("torus", file, domain) };
}

/** Two disks of diameter 1 on the square torus, touching at k = 1 (the optimum sqrt 2), apart for k > 1, overlapping below. */
const twoDisks = (k = 1) => ({
  lattice: { L: L2 * Math.max(k, 1) },
  poses: [
    [0, 0, 0],
    [(Math.SQRT2 / 2) * k, (Math.SQRT2 / 2) * k, 0],
  ],
});
const entry = (config: unknown) => ({ space: "torus", id: ID, config, name: "ann" });

let app: ReturnType<typeof createApp>;
beforeEach(() => {
  const store = new SqliteStore(":memory:");
  app = createApp({
    store,
    records: [],
    adminToken: "secret",
    clientIp: () => "1.1.1.1",
    log: () => {},
    spaces: { index: withoutRecord(), store },
  });
});
const get = async (path: string) => {
  const r = await app.request(path);
  return { status: r.status, body: (await r.json()) as any };
};
async function submit(body: unknown): Promise<{ status: number; body: SpaceSubmitResponse }> {
  const r = await app.request("/api/spaces/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(withUnits(body)),
  });
  return { status: r.status, body: (await r.json()) as SpaceSubmitResponse };
}

describe("a problem without a research record", () => {
  it("is counted in its domain, left out of the listing of records, and answered with its bound", async () => {
    const spaces = (await get("/api/spaces")).body as SpacesResponse;
    const torus = spaces.spaces.find((s) => s.space === "torus")!;
    expect(torus.problems).toBe(735);
    expect(torus.records).toBe(index.torus!.problems.length - 1);
    expect(torus.domain).toEqual(domain.info);
    for (const path of ["/api/spaces/torus/problems", "/api/spaces/torus/records"]) {
      const listing = (await get(path)).body as SpaceRecordsResponse;
      expect(listing.problems.find((x) => x.id === ID)).toBeUndefined();
      expect(listing.problems.length).toBe(torus.records);
    }
    const one = await get(`/api/spaces/torus/problems/${ID}`);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({
      status: "no_record",
      certified: null,
      certified_config: null,
      site_config: null,
      best_score: null,
      accepts_submissions: true,
      closed_reason: null,
      bound: { value: L2 },
    });
    // any id of the domain, with no bound known
    expect((await get("/api/spaces/torus/problems/torus/hex/5/48")).body).toMatchObject({
      status: "no_record",
      bound: null,
    });
    // outside the domain
    expect((await get("/api/spaces/torus/problems/torus/sq/0/50")).status).toBe(404);
  });

  it("is listed with its site entry by /site-only, a page at a time, and not before it has one", async () => {
    expect((await get("/api/spaces/torus/site-only")).body).toMatchObject({ space: "torus", problems: [], next: null });
    await submit(entry(twoDisks(1)));
    const page = (await get("/api/spaces/torus/site-only")).body;
    expect(page.problems.map((p: { id: string }) => p.id)).toEqual([ID]);
    expect(page.problems[0]).toMatchObject({
      status: "no_record",
      certified: null,
      bound: { value: L2 },
      site_best: { name: "ann" },
    });
    expect(page.problems[0].site_best.score).toBeCloseTo(L2, 12);
    expect(page.next).toBeNull();
    // after the last id of a page comes the rest; problems with a research record are never listed
    expect((await get(`/api/spaces/torus/site-only?after=${ID}`)).body.problems).toEqual([]);
    expect((await get("/api/spaces/torus/site-only?limit=1")).body.next).toBeNull();
    for (const bad of ["limit=0", "limit=5001", "limit=1&limit=2", "since=1"])
      expect((await get(`/api/spaces/torus/site-only?${bad}`)).status).toBe(400);
    expect((await get("/api/spaces/nowhere/site-only")).status).toBe(404);
  });

  it("keeps the first valid entry, then only better ones, and refuses one valid only within the tolerance", async () => {
    // 2e-10 too close: an overlap of 2e-10, within the touching tolerance but not the strict one
    const loose = await submit(entry(twoDisks(1 - 2e-10)));
    expect(loose.status).toBe(422);
    expect(loose.body.reasons[0]).toBe(SPACE_STRICT_NO_RECORD_REASON);
    const first = await submit(entry(twoDisks(1.01)));
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ valid: true, leader: true, beats_certified: false });
    expect(first.body.id).not.toBeNull();
    expect(first.body.best_score).toBeCloseTo(L2 * 1.01, 12);
    // a worse entry is answered "not checked": the torus checks only entries that can be kept
    const worse = await submit(entry(twoDisks(1.02)));
    expect(worse.status).toBe(200);
    expect(worse.body).toMatchObject({ valid: false, leader: false, id: null, checked: false });
    expect(worse.body.best_score).toBeCloseTo(L2 * 1.01, 12);
    const better = await submit(entry(twoDisks(1)));
    expect(better.body).toMatchObject({ valid: true, leader: true });
    const one = await get(`/api/spaces/torus/problems/${ID}`);
    expect(one.body.best_score).toBeCloseTo(L2, 12);
    expect(one.body.site_config).toEqual(twoDisks(1));
    expect(one.body.status).toBe("no_record");
  });

  it("takes an entry for any problem of its domain, as a random draw offers it", async () => {
    // 48 disks on a grid: torus/sq/0/48 has neither a research record nor an entry
    const grid = {
      lattice: { L: 16 },
      poses: Array.from({ length: 48 }, (_, i) => [2 * (i % 8), 2 * Math.floor(i / 8), 0]),
    };
    const kept = await submit({ ...entry(grid), id: "torus/sq/0/48" });
    expect(kept.body).toMatchObject({ valid: true, leader: true });
    const one = await get("/api/spaces/torus/problems/torus/sq/0/48");
    expect(one.body).toMatchObject({ status: "no_record", best_score: 16 });
  });
});

describe("a balls entry", () => {
  /** Two balls of diameter 1 on the x axis at +-h in a ball of diameter s (touching at h = 1/2, s = 2). */
  const two = (h: number, s: number) => ({
    s,
    pieces: [
      [h, 0, 0],
      [-h, 0, 0],
    ],
  });
  const balls = (id: string, config: unknown) => ({ space: "balls", id, config, name: "ann" });

  it("is strictly checked, the first valid one kept, then only better ones", async () => {
    // 5e-10 of overlap: valid within the touching tolerance, not at the strict one
    const loose = await submit(balls("balls/ballinball/2", two(0.5 - 1.25e-10, 2 - 2.5e-10)));
    expect(loose.status).toBe(422);
    expect(loose.body.reasons[0]).toBe(SPACE_STRICT_NO_RECORD_REASON);
    const first = await submit(balls("balls/ballinball/2", two(0.505, 2.01)));
    expect(first.body).toMatchObject({ valid: true, leader: true });
    expect(first.body.id).not.toBeNull();
    const worse = await submit(balls("balls/ballinball/2", two(0.51, 2.02)));
    expect(worse.body).toMatchObject({ valid: true, leader: false, id: null });
    const better = await submit(balls("balls/ballinball/2", two(0.5, 2)));
    expect(better.body).toMatchObject({ valid: true, leader: true });
    const one = await get("/api/spaces/balls/problems/balls/ballinball/2");
    expect(one.body).toMatchObject({ status: "no_record", certified: null, best_score: 2 });
    // outside the domain
    expect((await submit(balls("balls/ballinball/101", two(0.5, 2)))).status).toBe(400);
  });

  it("of Platonic solids is checked by their faces", async () => {
    // two unit cubes, face to face 0.2 apart, in a ball of diameter 2.8, radius 1.4 (their far corners lie at sqrt 1.71)
    const cubes = (x: number) => ({
      s: 2.8,
      pieces: [
        [x, 0, 0, 1, 0, 0, 0],
        [-x, 0, 0, 1, 0, 0, 0],
      ],
    });
    expect((await submit(balls("balls/cubinball/2", cubes(0.45)))).status).toBe(422);
    expect((await submit(balls("balls/cubinball/2", cubes(0.6)))).body).toMatchObject({ valid: true, leader: true });
  });
});
