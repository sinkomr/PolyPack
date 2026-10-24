import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { buildSnapshot, readManifest, scheduleSnapshots, snapshotSource } from "../src/snapshot";
import { SqliteStore } from "../src/sqlite-store";
import type { Store } from "../src/store";

const freshDir = () => mkdtempSync(join(tmpdir(), "polypack-snapshot-"));
const noPause = async () => {};
// the closed problem of these tests: 4 squares in a square
const closed = (N: number, M: number, P: number) => N === 4 && M === 4 && P === 4;

function add(store: SqliteStore, N: number, M: number, P: number, score: number, name = "Ada") {
  return store.insert({
    N,
    M,
    P,
    score,
    name,
    agent_note: "a note",
    found_with: "optimizer",
    method: "harden",
    method_params: null,
    seed: 1,
    budget: { time_s: 1 },
    software: null,
    // awkward doubles: they must come back bit for bit
    pieces: Array.from({ length: P }, (_, i) => ({ x: i + 0.1 + 1e-17 * i, y: -1 / 3, theta: Math.PI / (i + 7) })),
    container_phi: 0.1 + 0.2,
    created_at: "2026-10-23T00:00:00Z",
    verification: "none",
    literature_value: null,
    strict_check: null,
  });
}

function readPair(dir: string, file: string) {
  return JSON.parse(gunzipSync(readFileSync(join(dir, file))).toString("utf8"));
}

describe("the records snapshot", () => {
  it("holds every open problem's leader with its coordinates, one file per shape pair", async () => {
    const store = new SqliteStore(":memory:");
    const dir = freshDir();
    const a = await add(store, 4, 4, 2, 2.5);
    await add(store, 4, 4, 2, 2.6, "Bob"); // not the leader
    await add(store, 4, 4, 4, 2); // closed: left out
    const b = await add(store, 0, 3, 3, 4.1);

    expect(await buildSnapshot({ store, dir, closed, pause: noPause })).toEqual({ built: 2, kept: 0, removed: 0 });
    const m = readManifest(dir)!;
    expect(m.files.map((f) => [f.file, f.records, f.pieces])).toEqual([
      ["0-3.json.gz", 1, 3],
      ["4-4.json.gz", 1, 2],
    ]);
    expect([m.records, m.pieces, m.completed_at !== null]).toEqual([2, 5, true]);
    for (const f of m.files) {
      const bytes = readFileSync(join(dir, f.file));
      expect(f.bytes).toBe(bytes.length);
      expect(f.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    }

    const squares = readPair(dir, "4-4.json.gz");
    expect(squares).toMatchObject({ format: 1, N: 4, M: 4 });
    expect(squares.records).toHaveLength(1);
    const stored = (await store.get(a))!;
    expect(squares.records[0]).toEqual({
      P: 2,
      score: 2.5,
      id: a,
      name: "Ada",
      found_with: "optimizer",
      verification: "none",
      created_at: "2026-10-23T00:00:00Z",
      container_phi: stored.container_phi,
      pieces: stored.pieces.map((p) => [p.x, p.y, p.theta]),
    });
    expect(readPair(dir, "0-3.json.gz").records[0].id).toBe(b);
  });

  it("rebuilds only the pairs whose leaders changed, and keeps the others byte for byte", async () => {
    const store = new SqliteStore(":memory:");
    const dir = freshDir();
    await add(store, 4, 4, 2, 2.5);
    const circles = await add(store, 0, 3, 3, 4.1);
    await buildSnapshot({ store, dir, closed, pause: noPause });
    const before = readManifest(dir)!;

    expect(await buildSnapshot({ store, dir, closed, pause: noPause })).toEqual({ built: 0, kept: 2, removed: 0 });
    expect(readManifest(dir)!.files).toEqual(before.files);

    // a new leader in one pair
    await add(store, 4, 4, 3, 3);
    expect(await buildSnapshot({ store, dir, closed, pause: noPause })).toEqual({ built: 1, kept: 1, removed: 0 });
    const after = readManifest(dir)!;
    expect(after.files[0]).toEqual(before.files[0]);
    expect(after.files[1].sha256).not.toBe(before.files[1].sha256);
    expect(readPair(dir, "4-4.json.gz").records.map((r: { P: number }) => r.P)).toEqual([2, 3]);

    // an edited name changes the file too
    await store.edit(circles, { name: "Cy" });
    expect(await buildSnapshot({ store, dir, closed, pause: noPause })).toMatchObject({ built: 1, kept: 1 });
    expect(readPair(dir, "0-3.json.gz").records[0].name).toBe("Cy");

    // a pair whose last entry is removed loses its file
    await store.remove(circles);
    expect(await buildSnapshot({ store, dir, closed, pause: noPause })).toEqual({ built: 0, kept: 1, removed: 1 });
    expect(existsSync(join(dir, "0-3.json.gz"))).toBe(false);
    expect(readManifest(dir)!.files.map((f) => f.file)).toEqual(["4-4.json.gz"]);
  });

  it("rebuilds a pair whose file went missing, and clears what an interrupted build left", async () => {
    const store = new SqliteStore(":memory:");
    const dir = freshDir();
    await add(store, 4, 4, 2, 2.5);
    await buildSnapshot({ store, dir, closed, pause: noPause });
    writeFileSync(join(dir, "4-4.json.gz"), "truncated");
    writeFileSync(join(dir, ".4-4.json.gz.tmp"), "left over");
    expect(await buildSnapshot({ store, dir, closed, pause: noPause })).toMatchObject({ built: 1 });
    expect(existsSync(join(dir, ".4-4.json.gz.tmp"))).toBe(false);
    expect(readPair(dir, "4-4.json.gz").records).toHaveLength(1);
  });

  it("takes the new leader of a problem whose leader was overtaken during the build", async () => {
    const store = new SqliteStore(":memory:");
    const dir = freshDir();
    const old = await add(store, 4, 4, 2, 2.5);
    const leaders = await store.leaders();
    const better = await add(store, 4, 4, 2, 2.4);
    await store.prune(4, 4, 2); // as after every submission: the old leader is deleted
    expect(await store.get(old)).toBeNull();
    // the build read the leaders before the new entry arrived
    const view = new Proxy(store, {
      get: (t, k) => (k === "leaders" ? async () => leaders : Reflect.get(t, k).bind(t)),
    }) as Store;
    await buildSnapshot({ store: view, dir, closed, pause: noPause });
    expect(readPair(dir, "4-4.json.gz").records.map((r: { id: number }) => r.id)).toEqual([better]);
  });

  it("pauses after each pair it builds, in proportion to the work", async () => {
    const store = new SqliteStore(":memory:");
    const dir = freshDir();
    await add(store, 4, 4, 2, 2.5);
    await add(store, 0, 3, 3, 4.1);
    const pauses: number[] = [];
    await buildSnapshot({ store, dir, closed, pause: async (ms) => void pauses.push(ms) });
    expect(pauses).toHaveLength(2);
    pauses.length = 0;
    await buildSnapshot({ store, dir, closed, pause: async (ms) => void pauses.push(ms) });
    expect(pauses).toEqual([]);
  });
});

describe("GET /api/snapshot", () => {
  it("serves the manifest and the files it lists, and nothing else", async () => {
    const store = new SqliteStore(":memory:");
    const dir = freshDir();
    await add(store, 4, 4, 2, 2.5);
    const app = createApp({ store, records: [], snapshots: snapshotSource(dir) });

    let r = await app.request("/api/snapshot");
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "no snapshot has been built yet" });

    await buildSnapshot({ store, dir, closed, pause: noPause });
    r = await app.request("/api/snapshot");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(readManifest(dir));

    r = await app.request("/api/snapshot/4-4.json.gz");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/gzip");
    const body = Buffer.from(await r.arrayBuffer());
    expect(body.equals(readFileSync(join(dir, "4-4.json.gz")))).toBe(true);
    expect(r.headers.get("content-length")).toBe(String(body.length));
    expect(r.headers.get("etag")).toBe(`"${readManifest(dir)!.files[0].sha256}"`);

    writeFileSync(join(dir, "9-9.json.gz"), "not listed");
    for (const name of ["9-9.json.gz", "manifest.json", "4-4.json", "04-4.json.gz", "..%2F4-4.json.gz"]) {
      const res = await app.request(`/api/snapshot/${name}`);
      expect(res.status, name).toBe(404);
    }
  });

  it("answers 404 on a server that builds no snapshots", async () => {
    const app = createApp({ store: new SqliteStore(":memory:"), records: [] });
    const r = await app.request("/api/snapshot");
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "this server builds no snapshots" });
    expect((await app.request("/api/snapshot/4-4.json.gz")).status).toBe(404);
  });
});

describe("the nightly schedule", () => {
  const stops: (() => void)[] = [];
  afterEach(() => stops.splice(0).forEach((stop) => stop()));
  const waitFor = async (check: () => boolean, ms = 5000) => {
    for (const t0 = Date.now(); !check(); ) {
      if (Date.now() - t0 > ms) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it("builds soon after startup when there is no snapshot", async () => {
    const store = new SqliteStore(":memory:");
    const dir = freshDir();
    await add(store, 4, 4, 2, 2.5);
    stops.push(scheduleSnapshots({ store, dir, closed, pause: noPause, hourUtc: 11, startDelayMs: 1 }).stop);
    await waitFor(() => readManifest(dir)?.completed_at != null);
  });

  it("does not build at startup when the last build is recent", async () => {
    const store = new SqliteStore(":memory:");
    const dir = freshDir();
    await add(store, 4, 4, 2, 2.5);
    await buildSnapshot({ store, dir, closed, pause: noPause });
    const done = readManifest(dir)!.generated_at;
    await add(store, 4, 4, 3, 3);
    stops.push(scheduleSnapshots({ store, dir, closed, pause: noPause, hourUtc: 11, startDelayMs: 1 }).stop);
    await new Promise((r) => setTimeout(r, 200));
    expect(readManifest(dir)!.generated_at).toBe(done);
  });
});
