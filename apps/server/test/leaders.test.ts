import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { LiteratureRecord } from "@polypack/geometry";
import { hasRecord, parseSpaceId, problemOf } from "@polypack/spaces";
import { loadSpacesIndex } from "@polypack/spaces/load";
import { beforeEach, describe, expect, it } from "vitest";
import { readSpaceBody } from "../../web/src/tighter/space-submission";
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
    expect(body.leaders["4/7/2"]).toEqual({ score: 2.5, name: "ada", id: ids.poly, verification: "none" });
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

describe("GET /api/leaders against the per-problem endpoints and the game's reading", () => {
  const sph = (id: string) => index.sphere!.byId.get(id)!.certified!.score as number;
  it("agrees on ties, pending leaders, removals, edits, records, closed problems and disk and circle problems", async () => {
    const st = new SqliteStore(":memory:");
    const a = createApp({
      store: st,
      records: [published(4, 4, 3, "best_known"), published(5, 5, 2, "proven"), published(3, 3, 1, "proven")],
      spaces: { index, store: st },
    });
    const ins = (N: number, M: number, P: number, score: number, name: string, v: NewSubmission["verification"] = "none") =>
      st.insert({ ...entry(N, M, P, score, name), verification: v });
    await ins(4, 7, 2, 2.5, "ada");
    await ins(4, 7, 3, 3 * (1 + 5e-10), "early"); // a tie within the tolerance: the earlier entry leads
    await ins(4, 7, 3, 3, "late");
    await ins(4, 7, 4, 4, "confirmed", "confirmed"); // a pending leader with a confirmed entry behind it
    await ins(4, 7, 4, 3.9, "pending", "pending");
    await ins(4, 7, 5, 4.5, "ok");
    await ins(4, 7, 5, 4.0, "rej", "rejected"); // a row an older version left
    await st.remove(await ins(4, 7, 6, 5, "gone"));
    await st.edit(await ins(4, 7, 7, 5, "before"), { name: "after" });
    await ins(4, 4, 3, 4.9, "beats"); // under a published value that stands
    await ins(5, 5, 2, 3, "ghost"); // closed
    await ins(0, 4, 3, 1.1, "disks");
    await ins(0, 0, 7, 3, "circles");

    const ids = [...index.sphere!.byId.keys()].slice(0, 12);
    const sub = (problem: string, score: number, name: string) => st.spaceSubmit(spaceEntry(problem, score, name));
    const cases: string[] = [ids[0]!, ids[1]!, ids[2]!, ids[3]!, ids[4]!, ids[5]!, ids[6]!, ids[7]!];
    await sub(ids[0]!, sph(ids[0]!) * 1.5, "worse");
    await sub(ids[1]!, sph(ids[1]!) * 0.5, "better");
    await sub(ids[2]!, sph(ids[2]!), "equal"); // exactly the research record: the record is shown
    await sub(ids[3]!, sph(ids[3]!) * (1 + 5e-10), "within-tie"); // within the tolerance, slightly worse: the record
    await sub(ids[4]!, sph(ids[4]!) * 0.5 * (1 + 5e-10), "tie-early");
    await sub(ids[4]!, sph(ids[4]!) * 0.5, "tie-late");
    await st.spaceRemove((await sub(ids[5]!, sph(ids[5]!) * 0.5, "removed")).id);
    await st.spaceEdit((await sub(ids[6]!, sph(ids[6]!) * 0.5, "old-name")).id, { name: "new-name" });
    // closed, infeasible and open problems of every space, the closed ones with a late entry the site hides
    for (const cat of Object.values(index)) {
      let closed = 0;
      let open = 0;
      for (const p of cat?.problems ?? []) {
        if (p.closed_reason !== null && closed < 2) {
          closed++;
          cases.push(p.id);
          await sub(p.id, (p.certified?.score ?? 10) * 0.5, "late-closed");
        } else if (p.closed_reason === null && open < 2) {
          open++;
          cases.push(p.id);
        }
      }
    }
    for (const p of index.sphere!.problems) if (p.status === "infeasible") cases.push(p.id);
    cases.push(NO_RECORD);
    await sub(NO_RECORD, 9, "torus-site");

    const polygons = ["4/7/2", "4/7/3", "4/7/4", "4/7/5", "4/7/6", "4/7/7", "4/4/3", "5/5/2", "3/3/1", "0/4/3", "0/0/7", "3/3/5"];
    const keys = [...new Set([...polygons, ...cases])];
    const r = await a.request(`/api/leaders?keys=${keys.map(encodeURIComponent).join(",")}`);
    const body = (await r.json()) as any;
    expect(r.status).toBe(200);
    expect(body.unknown).toEqual([]);

    for (const k of polygons) {
      const b = ((await (await a.request(`/api/problems/${k}`)).json()) as any).site_best;
      expect(body.leaders[k], k).toEqual(
        b ? { score: b.score, name: b.name, id: b.id, verification: b.verification } : null,
      );
    }
    expect(body.leaders["4/7/4"]).toMatchObject({ name: "pending", verification: "pending" });
    expect(body.leaders["4/7/3"].name).toBe("early");
    for (const k of cases) {
      const space = k.split("/")[0];
      const read = readSpaceBody(k, await (await a.request(`/api/spaces/${space}/problems/${k}`)).json());
      expect(read, k).not.toBeNull();
      const l = read!.leader;
      // the game's own reading of the problem, with the flag a research record carries here
      expect(body.leaders[k], k).toEqual(
        l ? (l.id === null ? { ...l, research: true } : l) : null,
      );
    }
    expect(body.leaders[ids[2]!]).toEqual({ score: sph(ids[2]!), name: RESEARCH_RECORD_NAME, id: null, research: true });
    // site leaders carry no research flag, and some problems of the set are led by a site entry
    const sites = Object.values<any>(body.leaders).filter((l) => l && l.id !== null);
    expect(sites.length).toBeGreaterThan(5);
    for (const l of sites) expect(l).not.toHaveProperty("research");
  });
});
