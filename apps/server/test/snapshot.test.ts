import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { SPACE_DOMAINS, type SpacesIndex, buildSpaceCatalogue } from "@polypack/spaces";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import {
  SPACE_RECORD_FIELDS,
  type SnapshotSource,
  buildSnapshot,
  isComplete,
  readManifest,
  scheduleSnapshots,
  snapshotSource,
  snapshotSpaces,
} from "../src/snapshot";
import { SqliteStore } from "../src/sqlite-store";
import type { SpaceStore, Store } from "../src/store";

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
  it("is format 2 with its units in the manifest, and a format 1 build is not kept: every file is written again", async () => {
    const store = new SqliteStore(":memory:");
    const dir = freshDir();
    await add(store, 0, 0, 2, 3);
    await add(store, 4, 4, 2, 2.5);
    expect(await buildSnapshot({ store, dir, closed, pause: noPause })).toEqual({ built: 2, kept: 0, removed: 0 });
    expect(readManifest(dir)).toMatchObject({ format: 2, units: "diameter" });
    // the night's manifest from before the unit change: same leaders, but its files hold radius-1 disks
    const old = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    delete old.units;
    old.format = 1;
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(old));
    expect(readManifest(dir)).toBeNull();
    expect(await buildSnapshot({ store, dir, closed, pause: noPause })).toEqual({ built: 2, kept: 0, removed: 0 });
    expect(readManifest(dir)).toMatchObject({ format: 2, units: "diameter" });
    expect(readPair(dir, "0-0.json.gz")).toMatchObject({ format: 2, N: 0, M: 0 });
  });

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
    expect(squares).toMatchObject({ format: 2, N: 4, M: 4 });
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
    const leaders = await store.bestPerP(4, 4);
    const better = await add(store, 4, 4, 2, 2.4);
    await store.prune(4, 4, 2); // as after every submission: the old leader is deleted
    expect(await store.get(old)).toBeNull();
    // the build read the leaders before the new entry arrived
    const view = new Proxy(store, {
      get: (t, k) => (k === "bestPerP" ? async () => leaders : Reflect.get(t, k).bind(t)),
    }) as Store;
    await buildSnapshot({ store: view, dir, closed, pause: noPause });
    expect(readPair(dir, "4-4.json.gz").records.map((r: { id: number }) => r.id)).toEqual([better]);
    // the fingerprint is of what was written, so the next build finds the pair unchanged
    expect(await buildSnapshot({ store, dir, closed, pause: noPause })).toMatchObject({ built: 0, kept: 1 });
  });

  it("removes files it does not list, also those an interrupted build left behind", async () => {
    const store = new SqliteStore(":memory:");
    const dir = freshDir();
    await add(store, 4, 4, 2, 2.5);
    await buildSnapshot({ store, dir, closed, pause: noPause });
    writeFileSync(join(dir, "7-7.json.gz"), "an orphan");
    expect(await buildSnapshot({ store, dir, closed, pause: noPause })).toEqual({ built: 0, kept: 1, removed: 1 });
    expect(readdirSync(dir).sort()).toEqual(["4-4.json.gz", "manifest.json"]);
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

// Two spaces' research records, read as the server reads them: sphere/0/2 is proven (closed).
const root = join(__dirname, "../../..");
const catalogue = (space: "sphere" | "boundary") =>
  buildSpaceCatalogue(space, JSON.parse(readFileSync(join(root, "data", space, "records.json"), "utf8")));
const index: SpacesIndex = { sphere: catalogue("sphere"), boundary: catalogue("boundary") };

function addSpace(store: SqliteStore, problem: string, score: number, name = "Ada") {
  return store
    .spaceSubmit({
      space: problem.split("/")[0],
      problem,
      score,
      name,
      agent_note: "a note",
      software: "polypack-volunteer 1.0",
      method: "boundary compression search",
      seed: 3,
      // awkward doubles: they must come back bit for bit
      config: JSON.stringify({ s: score, pieces: [{ cell: 0, u: [0.1 + 0.2, -1 / 3, 1e-17] }] }),
      created_at: "2026-10-25T00:00:00Z",
    })
    .then((r) => r.id);
}

describe("the spaces in the snapshot", () => {
  it("place entries on problems of a space's domain without a record, after the records", () => {
    const domain = { ...SPACE_DOMAINS.polyhedra!, info: SPACE_DOMAINS.polyhedra!.info };
    const records = buildSpaceCatalogue("polyhedra", null, domain);
    const { place } = snapshotSpaces({ polyhedra: records } as never, new SqliteStore(":memory:"));
    expect(place("polyhedra", "polyhedra/kttinpkd/7")).toEqual({ P: 7, order: records.problems.length + 7 });
    expect(place("polyhedra", "polyhedra/cubincub/300")).toEqual({ P: 300, order: records.problems.length + 300 });
    expect(place("polyhedra", "polyhedra/kttinpkd/501")).toBeNull();
    expect(place("polyhedra", "polyhedra/kttinxyz/7")).toBeNull();
    expect(place("sphere", "sphere/4/12")).toBeNull();
  });

  it("hold every open space problem's leader with its configuration, one file per space, listed apart", async () => {
    const store = new SqliteStore(":memory:");
    const dir = freshDir();
    await add(store, 4, 4, 2, 2.5);
    const cube = await addSpace(store, "boundary/tesseract/cube/12", 1.24);
    const ball = await addSpace(store, "boundary/tesseract/ball/9", 2.1);
    await addSpace(store, "boundary/tesseract/ball/9", 2.2, "Bob"); // not the leader
    const sphere = await addSpace(store, "sphere/4/12", 3.1);
    await addSpace(store, "sphere/0/2", 1); // closed: left out
    await addSpace(store, "boundary/tesseract/ball/99", 5); // not in the catalogue: left out

    const spaces = snapshotSpaces(index, store);
    expect(spaces.names).toEqual(["sphere", "boundary"]);
    expect(await buildSnapshot({ store, dir, closed, spaces, pause: noPause })).toEqual({
      built: 3,
      kept: 0,
      removed: 0,
    });
    const m = readManifest(dir)!;
    // the pairs alone in `files` and in the totals
    expect(m.files.map((f) => f.file)).toEqual(["4-4.json.gz"]);
    expect([m.records, m.pieces]).toEqual([1, 2]);
    expect(m.spaces!.map((f) => [f.space, f.file, f.records, f.pieces])).toEqual([
      ["sphere", "space-sphere.json.gz", 1, 12],
      ["boundary", "space-boundary.json.gz", 2, 21],
    ]);
    for (const f of m.spaces!) {
      const bytes = readFileSync(join(dir, f.file));
      expect(f.bytes).toBe(bytes.length);
      expect(f.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    }

    const boundary = readPair(dir, "space-boundary.json.gz");
    expect(boundary).toMatchObject({ format: 2, space: "boundary" });
    // in catalogue order: balls before cubes
    expect(boundary.records.map((r: { id: number }) => r.id)).toEqual([ball, cube]);
    const stored = (await store.spaceGet(cube))!;
    expect(boundary.records[1]).toEqual({
      problem: "boundary/tesseract/cube/12",
      P: 12,
      score: 1.24,
      id: cube,
      name: "Ada",
      software: "polypack-volunteer 1.0",
      method: "boundary compression search",
      created_at: "2026-10-25T00:00:00Z",
      config: JSON.parse(stored.config),
    });
    expect(boundary.records[1].config.pieces[0].u).toEqual([0.1 + 0.2, -1 / 3, 1e-17]);
    expect(Object.keys(boundary.records[1])).toEqual([...SPACE_RECORD_FIELDS]);
    expect(readPair(dir, "space-sphere.json.gz").records.map((r: { id: number }) => r.id)).toEqual([sphere]);
  });

  it("rebuild only the spaces whose leaders changed, and remove a space's file once it has no open leader", async () => {
    const store = new SqliteStore(":memory:");
    const dir = freshDir();
    const spaces = snapshotSpaces(index, store);
    const ball = await addSpace(store, "boundary/tesseract/ball/9", 2.1);
    const sphere = await addSpace(store, "sphere/4/12", 3.1);
    await buildSnapshot({ store, dir, closed, spaces, pause: noPause });
    const before = readManifest(dir)!.spaces!;

    expect(await buildSnapshot({ store, dir, closed, spaces, pause: noPause })).toEqual({
      built: 0,
      kept: 2,
      removed: 0,
    });
    expect(readManifest(dir)!.spaces).toEqual(before);

    // a new leader in one space
    await addSpace(store, "boundary/tesseract/ball/9", 2.05);
    expect(await buildSnapshot({ store, dir, closed, spaces, pause: noPause })).toEqual({
      built: 1,
      kept: 1,
      removed: 0,
    });
    expect(readPair(dir, "space-boundary.json.gz").records[0].score).toBe(2.05);
    expect(await store.spaceGet(ball)).toBeNull();

    // an edited name changes the file too
    await store.spaceEdit(sphere, { name: "Cy" });
    expect(await buildSnapshot({ store, dir, closed, spaces, pause: noPause })).toMatchObject({ built: 1, kept: 1 });
    expect(readPair(dir, "space-sphere.json.gz").records[0].name).toBe("Cy");

    // a space whose last entry is removed loses its file
    await store.spaceRemove(sphere);
    expect(await buildSnapshot({ store, dir, closed, spaces, pause: noPause })).toEqual({
      built: 0,
      kept: 1,
      removed: 1,
    });
    expect(existsSync(join(dir, "space-sphere.json.gz"))).toBe(false);
    expect(readManifest(dir)!.spaces!.map((f) => f.file)).toEqual(["space-boundary.json.gz"]);

    // a build without the spaces drops theirs, and an orphan space file goes too
    writeFileSync(join(dir, "space-torus.json.gz"), "an orphan");
    expect(await buildSnapshot({ store, dir, closed, pause: noPause })).toEqual({ built: 0, kept: 0, removed: 2 });
    expect(readManifest(dir)!.spaces).toEqual([]);
    expect(readdirSync(dir)).toEqual(["manifest.json"]);
  });

  it("take the new leader of a problem whose leader was overtaken during the build", async () => {
    const store = new SqliteStore(":memory:");
    const dir = freshDir();
    await addSpace(store, "boundary/tesseract/ball/9", 2.1);
    const leaders = await store.spaceBest("boundary");
    // the new entry prunes the old leader at once
    const better = await addSpace(store, "boundary/tesseract/ball/9", 2.05);
    // the build read the leaders before the new entry arrived
    const view = new Proxy(store, {
      get: (t, k) => (k === "spaceBest" ? async () => leaders : Reflect.get(t, k).bind(t)),
    }) as SpaceStore;
    await buildSnapshot({ store, dir, closed, spaces: { ...snapshotSpaces(index, view) }, pause: noPause });
    expect(readPair(dir, "space-boundary.json.gz").records.map((r: { id: number }) => r.id)).toEqual([better]);
    // the fingerprint is of what was written, so the next build finds the space unchanged
    const spaces = snapshotSpaces(index, store);
    expect(await buildSnapshot({ store, dir, closed, spaces, pause: noPause })).toMatchObject({ built: 0, kept: 1 });
  });

  it("pause inside a large space's file as between pairs, and after it", async () => {
    const store = new SqliteStore(":memory:");
    const dir = freshDir();
    // 32 problems: two parts of 25 entries
    for (const p of index.boundary!.problems) await addSpace(store, p.id, 1e3);
    const spaces = snapshotSpaces(index, store);
    const pauses: number[] = [];
    const pause = async (ms: number) => void pauses.push(ms);
    await buildSnapshot({ store, dir, closed, spaces, pause, pauseEveryPieces: 1 });
    expect(pauses).toHaveLength(2);
    expect(readPair(dir, "space-boundary.json.gz").records).toHaveLength(32);
    // by default, one pause after this small file
    pauses.length = 0;
    await addSpace(store, "boundary/tesseract/ball/1", 999);
    await buildSnapshot({ store, dir, closed, spaces, pause });
    expect(pauses).toHaveLength(1);
  });

  it("refuse a manifest whose `spaces` is not a list: nothing is served from it, and the next build replaces it", async () => {
    const store = new SqliteStore(":memory:");
    const dir = freshDir();
    await addSpace(store, "sphere/4/12", 3.1);
    const spaces = snapshotSpaces(index, store);
    await buildSnapshot({ store, dir, closed, spaces, pause: noPause });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...readManifest(dir)!, spaces: {} }));
    expect(readManifest(dir)).toBeNull();
    expect(snapshotSource(dir).file("space-sphere.json.gz")).toBeNull();
    expect(await buildSnapshot({ store, dir, closed, spaces, pause: noPause })).toEqual({
      built: 1,
      kept: 0,
      removed: 0,
    });
    expect(readManifest(dir)!.spaces!.map((f) => f.file)).toEqual(["space-sphere.json.gz"]);
  });

  it("read a manifest written before the spaces were added, and add them to it", async () => {
    const store = new SqliteStore(":memory:");
    const dir = freshDir();
    await add(store, 4, 4, 2, 2.5);
    await buildSnapshot({ store, dir, closed, pause: noPause });
    const old = readManifest(dir)!;
    delete old.spaces;
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(old));
    await addSpace(store, "sphere/4/12", 3.1);
    const spaces = snapshotSpaces(index, store);
    expect(await buildSnapshot({ store, dir, closed, spaces, pause: noPause })).toEqual({
      built: 1,
      kept: 1,
      removed: 0,
    });
    expect(readManifest(dir)!.spaces!.map((f) => f.file)).toEqual(["space-sphere.json.gz"]);
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

    // a space's file, listed apart
    await addSpace(store, "sphere/4/12", 3.1);
    await buildSnapshot({ store, dir, closed, spaces: snapshotSpaces(index, store), pause: noPause });
    r = await app.request("/api/snapshot/space-sphere.json.gz");
    expect(r.status).toBe(200);
    expect(Buffer.from(await r.arrayBuffer()).equals(readFileSync(join(dir, "space-sphere.json.gz")))).toBe(true);
    expect(r.headers.get("etag")).toBe(`"${readManifest(dir)!.spaces![0].sha256}"`);

    writeFileSync(join(dir, "9-9.json.gz"), "not listed");
    writeFileSync(join(dir, "space-torus.json.gz"), "not listed");
    for (const name of [
      "9-9.json.gz",
      "space-torus.json.gz",
      "space-Sphere.json.gz",
      "space-.json.gz",
      "manifest.json",
      "4-4.json",
      "04-4.json.gz",
      "..%2F4-4.json.gz",
      "space-..%2Fmanifest.json.gz",
    ]) {
      const res = await app.request(`/api/snapshot/${name}`);
      expect(res.status, name).toBe(404);
    }
  });

  // Hono answers HEAD with the GET handler and drops its body: a file opened for it was never closed.
  it("answers HEAD without opening the file, and leaks no file descriptor", async () => {
    const store = new SqliteStore(":memory:");
    const dir = freshDir();
    await add(store, 4, 4, 2, 2.5);
    await buildSnapshot({ store, dir, closed, pause: noPause });
    const source = snapshotSource(dir);
    let opened = 0;
    const counting: SnapshotSource = {
      manifest: source.manifest,
      file: (name) => {
        const f = source.file(name);
        return f && { ...f, open: () => (opened++, f.open()) };
      },
    };
    const app = createApp({ store, records: [], snapshots: counting });
    const head = await app.request("/api/snapshot/4-4.json.gz", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(readManifest(dir)!.files[0].bytes));
    expect(opened).toBe(0);
    expect((await app.request("/api/snapshot/9-9.json.gz", { method: "HEAD" })).status).toBe(404);

    const fds = () => readdirSync("/dev/fd").length;
    const real = createApp({ store, records: [], snapshots: source });
    const before = fds();
    for (let i = 0; i < 50; i++) await real.request("/api/snapshot/4-4.json.gz", { method: "HEAD" });
    expect(fds() - before).toBeLessThan(5);
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
    for (const t0 = Date.now(); !check();) {
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

  it("builds soon after startup when the last build was cut short", async () => {
    const store = new SqliteStore(":memory:");
    const dir = freshDir();
    await add(store, 4, 4, 2, 2.5);
    await buildSnapshot({ store, dir, closed, pause: noPause });
    const m = readManifest(dir)!;
    // as a build leaves it after some pairs
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ ...m, generated_at: new Date(Date.parse(m.generated_at) + 60_000).toISOString() }),
    );
    expect(isComplete(readManifest(dir))).toBe(false);
    stops.push(scheduleSnapshots({ store, dir, closed, pause: noPause, hourUtc: 11, startDelayMs: 1 }).stop);
    await waitFor(() => isComplete(readManifest(dir)));
  });

  it("builds soon after startup when a recent snapshot lacks the spaces' files the server asks for", async () => {
    const store = new SqliteStore(":memory:");
    const dir = freshDir();
    await add(store, 4, 4, 2, 2.5);
    await addSpace(store, "sphere/4/12", 3.1);
    await buildSnapshot({ store, dir, closed, pause: noPause });
    // as written before the space files existed
    const old = readManifest(dir)!;
    delete old.spaces;
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(old));
    // without `spaces`, such a manifest is recent enough
    const quiet = scheduleSnapshots({ store, dir, closed, pause: noPause, hourUtc: 11, startDelayMs: 1 });
    await new Promise((r) => setTimeout(r, 200));
    quiet.stop();
    expect(readManifest(dir)!.spaces).toBeUndefined();
    const spaces = snapshotSpaces(index, store);
    stops.push(scheduleSnapshots({ store, dir, closed, spaces, pause: noPause, hourUtc: 11, startDelayMs: 1 }).stop);
    await waitFor(() => (readManifest(dir)?.spaces?.length ?? 0) === 1);
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
