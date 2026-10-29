import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { LiteratureRecord } from "@polypack/geometry";
import { hasRecord, parseSpaceId, problemOf } from "@polypack/spaces";
import { loadSpacesIndex } from "@polypack/spaces/load";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { LEADERS_MAX_KEYS, LEADERS_MAX_URL, RESEARCH_RECORD_NAME } from "../src/leaders";
import { SqliteStore } from "../src/sqlite-store";
import { NewSubmission } from "../src/store";

const index = loadSpacesIndex(resolve(__dirname, "../../.."));

const published = (N: number, M: number, P: number, status: LiteratureRecord["status"]): LiteratureRecord => ({
  N,
  M,
  P,
  value: 5,
  display: "5.00",
  display_precision: 2,
  status,
  source_name: "test",
  source_url: "https://example.invalid",
  accessed: "2026-10-07",
  conversion_note: "none",
});
const entry = (N: number, M: number, P: number, score: number, name: string): NewSubmission => ({
  N,
  M,
  P,
  score,
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
  created_at: "2026-10-12T00:00:00.000Z",
  verification: "none",
  literature_value: null,
  strict_check: null,
});
const spaceEntry = (problem: string, score: number, name: string) => ({
  space: problem.split("/")[0]!,
  problem,
  score,
  name,
  agent_note: "",
  software: null,
  method: null,
  seed: null,
  config: "{}",
  created_at: "t",
});

// a sphere problem that keeps its record, one that a site entry beats, a closed torus problem, and a
// torus problem of the domain without a record
const SPHERE_RECORD = "sphere/3/6";
const SPHERE_BEATEN = "sphere/3/7";
const CLOSED = "torus/sq/0/2";
const NO_RECORD = (() => {
  for (let P = 2; P < 200; P++) {
    const id = `torus/sq/0/${P}`;
    const parsed = parseSpaceId("torus", id);
    const p = typeof parsed === "string" ? null : problemOf(index.torus!, parsed);
    if (p && !hasRecord(p)) return id;
  }
  throw new Error("no torus problem without a record");
})();

let app: ReturnType<typeof createApp>;
let store: SqliteStore;
let ids: { poly: number; beaten: number };

beforeEach(async () => {
  store = new SqliteStore(":memory:");
  app = createApp({
    store,
    records: [published(4, 4, 3, "best_known"), published(5, 5, 2, "proven")],
    spaces: { index, store },
  });
  ids = { poly: await store.insert(entry(4, 7, 2, 2.5, "ada")), beaten: 0 };
  await store.insert(entry(5, 5, 2, 3, "ghost")); // kept in the database, but its problem is closed
  const rec = index.sphere!.byId.get(SPHERE_RECORD)!.certified!.score;
  await store.spaceSubmit(spaceEntry(SPHERE_RECORD, rec * 1.5, "worse")); // behind the record
  ids.beaten = (await store.spaceSubmit(spaceEntry(SPHERE_BEATEN, index.sphere!.byId.get(SPHERE_BEATEN)!.certified!.score * 0.5, "bea"))).id;
  await store.spaceSubmit(spaceEntry(CLOSED, 100, "late"));
});

const leaders = async (keys: string[] | string, headers?: Record<string, string>) => {
  const q = typeof keys === "string" ? keys : keys.join(",");
  const r = await app.request(`/api/leaders?keys=${q}`, { headers });
  return { status: r.status, body: (await r.json()) as any, headers: r.headers };
};

describe("GET /api/leaders", () => {
  it("answers polygon and space keys mixed, with no leader as null", async () => {
    const keys = ["4/7/2", "3/3/5", "4/4/3", SPHERE_BEATEN, SPHERE_RECORD, NO_RECORD];
    const { status, body } = await leaders(keys);
    expect(status).toBe(200);
    expect(Object.keys(body.leaders)).toEqual(keys);
    expect(body.leaders["4/7/2"]).toEqual({ score: 2.5, name: "ada", id: ids.poly });
    expect(body.leaders["3/3/5"]).toBeNull(); // no entry, no published value
    expect(body.leaders["4/4/3"]).toBeNull(); // a published value only: /api/problems shows no site entry either
    expect(body.leaders[SPHERE_BEATEN]).toMatchObject({ name: "bea", id: ids.beaten });
    expect(body.leaders[NO_RECORD]).toBeNull();
    expect(body.unknown).toEqual([]);
  });

  it("shows a research record with id null, as the game reads it", async () => {
    const { body } = await leaders([SPHERE_RECORD, CLOSED, "5/5/2"]);
    const rec = index.sphere!.byId.get(SPHERE_RECORD)!.certified!.score;
    expect(body.leaders[SPHERE_RECORD]).toEqual({ score: rec, name: RESEARCH_RECORD_NAME, id: null, research: true });
    // closed: the entry kept in the database is not shown; the space's record stands, the polygon has none to show
    expect(body.leaders[CLOSED]).toMatchObject({ id: null, research: true });
    expect(body.leaders["5/5/2"]).toBeNull();
  });

  it("lists unknown and malformed keys without failing, and answers duplicates once", async () => {
    const bad = ["", "x", "4/7", "04/7/2", "1/7/2", "4/7/0", "4/7/99999999", "4/7/2/1", "sphere/0", "nowhere/1/2", "sphere/3/6/9", " 4/7/2"];
    const { status, body } = await leaders(["4/7/2", ...bad.map(encodeURIComponent), "4/7/2", "4/7/2", ...bad.slice(0, 2).map(encodeURIComponent)]);
    expect(status).toBe(200);
    expect(Object.keys(body.leaders)).toEqual(["4/7/2"]);
    expect(body.unknown).toEqual(bad);
  });

  it("takes 200 keys and refuses 201, an empty or repeated list and other parameters", async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `3/3/${i + 1}`);
    const ok = await leaders(many(LEADERS_MAX_KEYS));
    expect(ok.status).toBe(200);
    expect(Object.keys(ok.body.leaders)).toHaveLength(200);
    expect((await leaders(many(LEADERS_MAX_KEYS + 1))).status).toBe(400);
    expect((await leaders("")).status).toBe(400);
    expect((await app.request("/api/leaders")).status).toBe(400);
    expect((await app.request("/api/leaders?keys=3/3/5&keys=3/3/6")).status).toBe(400);
    expect((await app.request("/api/leaders?keys=3/3/5&limit=1")).status).toBe(400);
  });

  it("refuses an over-long URL", async () => {
    const r = await app.request(`/api/leaders?keys=${"3/3/5,".repeat(LEADERS_MAX_URL / 6 + 1)}`);
    expect(r.status).toBe(414);
  });

  it("agrees with /api/problems and /api/spaces for the same problems", async () => {
    const polygons = ["4/7/2", "3/3/5", "4/4/3", "5/5/2"];
    const spaces = [SPHERE_RECORD, SPHERE_BEATEN, CLOSED, NO_RECORD];
    const { body } = await leaders([...polygons, ...spaces]);
    for (const k of polygons) {
      const p = (await (await app.request(`/api/problems/${k}`)).json()) as any;
      const b = p.site_best;
      expect(body.leaders[k]).toEqual(b ? { score: b.score, name: b.name, id: b.id } : null);
    }
    for (const k of spaces) {
      const space = k.split("/")[0];
      const p = (await (await app.request(`/api/spaces/${space}/problems/${k}`)).json()) as any;
      // the game's rule: the research record when it is at least as good as the site entry
      const cert = p.certified?.score ?? null;
      const site = p.site_best;
      const expected =
        cert !== null && (!site || cert <= site.score)
          ? { score: cert, id: null }
          : site
            ? { score: site.score, id: site.id, name: site.name }
            : null;
      if (expected) expect(body.leaders[k]).toMatchObject(expected);
      else expect(body.leaders[k]).toBeNull();
    }
  });

  it("is compressed for clients that accept it", async () => {
    const keys = Array.from({ length: 200 }, (_, i) => `3/3/${i + 1}`);
    const r = await app.request(`/api/leaders?keys=${keys.join(",")}`, { headers: { "accept-encoding": "gzip" } });
    expect(r.headers.get("content-encoding")).toBe("gzip");
    expect(JSON.parse(gunzipSync(Buffer.from(await r.arrayBuffer())).toString()).unknown).toEqual([]);
  });

  it("lists space keys as unknown on a server without spaces", async () => {
    app = createApp({ store: new SqliteStore(":memory:"), records: [] });
    const { body } = await leaders(["3/3/5", SPHERE_RECORD]);
    expect(body).toEqual({ leaders: { "3/3/5": null }, unknown: [SPHERE_RECORD] });
  });
});
