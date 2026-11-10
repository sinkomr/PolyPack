import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { SPACE_DOMAINS, type SpacesIndex, buildSpaceCatalogue } from "@polypack/spaces";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { Gate, SNAPSHOT_FILES_PER_HOUR } from "../src/limits";
import {
  SNAPSHOT_FORMAT,
  SPACE_RECORD_FIELDS,
  buildSnapshot,
  cleanSnapshotDir,
  isComplete,
  readManifest,
  scheduleSnapshots,
  snapshotSource,
  snapshotSpaces,
} from "../src/snapshot";
import { SqliteStore } from "../src/sqlite-store";
import type { SpaceStore, Store } from "../src/store";

const freshDir = () => mkdtempSync(join(tmpdir(), "polypack-snapshot-"));
// the closed problem of these tests: 4 squares in a square
const closed = (N: number, M: number, P: number) => N === 4 && M === 4 && P === 4;
const tick = () => new Promise<void>((r) => setImmediate(r));
const until = async (check: () => boolean, ms = 5000) => {
  for (const t0 = Date.now(); !check(); await tick()) if (Date.now() - t0 > ms) throw new Error("timed out");
};

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

/** What a pair's file holds for the entries `ids`, written out from the stored entries as the format says. */
async function expectedPair(store: SqliteStore, N: number, M: number, ids: number[]): Promise<string> {
  const lines: string[] = [];
  for (const id of ids) {
    const s = (await store.get(id))!;
    lines.push(
      JSON.stringify({
        P: s.P,
        score: s.score,
        id: s.id,
        name: s.name,
        found_with: s.found_with,
        verification: s.verification,
        created_at: s.created_at,
        container_phi: s.container_phi,
        pieces: s.pieces.map((p) => [p.x, p.y, p.theta]),
      }),
    );
  }
  return `{"format":${SNAPSHOT_FORMAT},"N":${N},"M":${M},"records":[${lines.length ? "\n" : ""}${lines.join(",\n")}\n]}\n`;
}

/** The fingerprint of the leaders `ids` as the format defines it. */
async function expectedFingerprint(store: SqliteStore, ids: number[]): Promise<string> {
  const h = createHash("sha256").update(`format ${SNAPSHOT_FORMAT}\n`);
  for (const id of ids) {
    const s = (await store.get(id))!;
    h.update(JSON.stringify([s.P, s.id, s.name, s.found_with, s.verification]) + "\n");
  }
  return h.digest("hex");
}

async function download(app: ReturnType<typeof createApp>, name: string) {
  const r = await app.request(`/api/snapshot/${name}`);
  const body = Buffer.from(await r.arrayBuffer());
  return { r, body, text: r.status === 200 ? gunzipSync(body).toString("utf8") : "" };
}

/** A clock that gives one more minute at each reading. */
function clock(start = "2026-11-07T11:00:00Z") {
  let t = Date.parse(start);
  return () => new Date((t += 60_000));
}

describe("the records snapshot", () => {
  it("is a manifest of format 3, with each file's counts and fingerprint but no bytes or hash, and nothing else on disk", async () => {
    const store = new SqliteStore(":memory:");
    const dir = freshDir();
    const a = await add(store, 4, 4, 2, 2.5);
    await add(store, 4, 4, 2, 2.6, "Bob"); // not the leader
    await add(store, 4, 4, 4, 2); // closed: left out
    const b = await add(store, 0, 3, 3, 4.1);

    const r = await buildSnapshot({ store, dir, closed });
    expect(r).toMatchObject({ changed: 2, kept: 0, dropped: 0 });
    const m = readManifest(dir)!;
    expect(m).toMatchObject({ format: 3, units: "diameter", records: 2, pieces: 5, spaces: [] });
    expect(m.files).toEqual([
      {
        N: 0,
        M: 3,
        file: "0-3.json.gz",
        records: 1,
        pieces: 3,
        as_of: expect.any(String),
        fingerprint: await expectedFingerprint(store, [b]),
      },
      {
        N: 4,
        M: 4,
        file: "4-4.json.gz",
        records: 1,
        pieces: 2,
        as_of: expect.any(String),
        fingerprint: await expectedFingerprint(store, [a]),
      },
    ]);
    expect(Object.keys(m.files[0])).not.toContain("bytes");
    expect(Object.keys(m.files[0])).not.toContain("sha256");
    expect(isComplete(m)).toBe(true);
    // no file but the manifest
    expect(readdirSync(dir)).toEqual(["manifest.json"]);
  });

  it("does not reuse a manifest of format 2 or 1", async () => {
    const store = new SqliteStore(":memory:");
    const dir = freshDir();
    await add(store, 0, 0, 2, 3);
    await add(store, 4, 4, 2, 2.5);
    await buildSnapshot({ store, dir, closed });
    const as_of = readManifest(dir)!.files.map((f) => f.as_of);
    const old = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    for (const format of [2, 1]) {
      writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...old, format }));
      expect(readManifest(dir)).toBeNull();
      expect(await buildSnapshot({ store, dir, closed, now: clock() })).toMatchObject({ changed: 2, kept: 0 });
      expect(readManifest(dir)).toMatchObject({ format: 3, units: "diameter" });
      expect(readManifest(dir)!.files.map((f) => f.as_of)).not.toEqual(as_of);
    }
  });

  it("keeps the entry, and its as_of, of a pair whose leaders are unchanged, and renews the others", async () => {
    const store = new SqliteStore(":memory:");
    const dir = freshDir();
    await add(store, 4, 4, 2, 2.5);
    const circles = await add(store, 0, 3, 3, 4.1);
    const now = clock();
    await buildSnapshot({ store, dir, closed, now });
    const before = readManifest(dir)!;

    const same = await buildSnapshot({ store, dir, closed, now });
    expect(same).toMatchObject({ changed: 0, kept: 2, dropped: 0 });
    const kept = readManifest(dir)!;
    expect(kept.files).toEqual(before.files);
    expect(kept.generated_at > before.generated_at).toBe(true);

    // a new leader in one pair
    await add(store, 4, 4, 3, 3);
    expect(await buildSnapshot({ store, dir, closed, now })).toMatchObject({ changed: 1, kept: 1 });
    const after = readManifest(dir)!;
    expect(after.files[0]).toEqual(before.files[0]);
    expect(after.files[1]).toMatchObject({ records: 2, pieces: 5 });
    expect(after.files[1].fingerprint).not.toBe(before.files[1].fingerprint);
    expect(after.files[1].as_of > before.files[1].as_of).toBe(true);
    expect([after.records, after.pieces]).toEqual([3, 8]);

    // an edited name changes the fingerprint, though no count
    await store.edit(circles, { name: "Cy" });
    expect(await buildSnapshot({ store, dir, closed, now })).toMatchObject({ changed: 1, kept: 1 });
    const renamed = readManifest(dir)!;
    expect(renamed.files[0].fingerprint).toBe(await expectedFingerprint(store, [circles]));
    expect(renamed.files[0].fingerprint).not.toBe(after.files[0].fingerprint);
    expect(renamed.files[1]).toEqual(after.files[1]);

    // a pair whose last entry is removed leaves the manifest
    await store.remove(circles);
    expect(await buildSnapshot({ store, dir, closed, now })).toMatchObject({ changed: 0, kept: 1, dropped: 1 });
    expect(readManifest(dir)!.files.map((f) => f.file)).toEqual(["4-4.json.gz"]);
  });

  it("marks the manifest unfinished while it runs, with the last build's completed_at, and complete at the end", async () => {
    const store = new SqliteStore(":memory:");
    const dir = freshDir();
    await add(store, 4, 4, 2, 2.5);
    await add(store, 0, 3, 3, 4.1);
    const now = clock();
    await buildSnapshot({ store, dir, closed, now });
    const first = readManifest(dir)!;
    expect(isComplete(first)).toBe(true);

    const seen: (typeof first)[] = [];
    const view = new Proxy(store, {
      get: (t, k) =>
        k === "bestPerP"
          ? async (N: number, M: number) => (seen.push(readManifest(dir)!), t.bestPerP(N, M))
          : Reflect.get(t, k).bind(t),
    }) as Store;
    await buildSnapshot({ store: view, dir, closed, now });
    expect(seen).toHaveLength(2);
    for (const m of seen) {
      expect(isComplete(m)).toBe(false);
      expect(m.completed_at).toBe(first.completed_at);
      expect(m.generated_at > first.generated_at).toBe(true);
      // what the mirror reads in the meantime is the last build's list
      expect(m.files).toEqual(first.files);
    }
    const last = readManifest(dir)!;
    expect(isComplete(last)).toBe(true);
    expect(last.completed_at! > first.completed_at!).toBe(true);
  });

  it("reads no entry and writes no file while it builds", async () => {
    const store = new SqliteStore(":memory:");
    const dir = freshDir();
    await add(store, 4, 4, 2, 2.5);
    await addSpace(store, "sphere/4/12", 3.1);
    const used: string[] = [];
    const view = new Proxy(store, {
      get: (t, k) => {
        if (typeof k === "string" && /^(get|getMany|leader|spaceGet|spaceLeader)$/.test(k)) used.push(k);
        return Reflect.get(t, k).bind(t);
      },
    }) as SqliteStore;
    await buildSnapshot({ store: view, dir, closed, spaces: snapshotSpaces(index, view) });
    expect(used).toEqual([]);
    expect(readdirSync(dir)).toEqual(["manifest.json"]);
  });

  it("deletes the files an older server stored, and what an interrupted build left, once it has built", async () => {
    const store = new SqliteStore(":memory:");
    const dir = freshDir();
    await add(store, 4, 4, 2, 2.5);
    writeFileSync(join(dir, "4-4.json.gz"), "stored".repeat(100));
    writeFileSync(join(dir, "7-7.json.gz"), "an orphan");
    writeFileSync(join(dir, "space-sphere.json.gz"), "a space");
    writeFileSync(join(dir, ".4-4.json.gz.tmp"), "left over");
    mkdirSync(join(dir, "kept.json.gz"));
    const log: string[] = [];
    const r = await buildSnapshot({ store, dir, closed, log: (m) => log.push(m) });
    expect(r.cleaned).toEqual({ files: 4, bytes: 600 + 9 + 7 + 9 });
    expect(readdirSync(dir).sort()).toEqual(["kept.json.gz", "manifest.json"]);
    expect(log).toContain("[snapshot] 4 stored file(s) removed, 625 bytes freed");
  });

  it("cleans a directory a batch at a time, keeping the manifest, and lets the event loop in between", async () => {
    const dir = freshDir();
    writeFileSync(join(dir, "manifest.json"), "{}");
    for (let i = 0; i < 25; i++) writeFileSync(join(dir, `${i}-1.json.gz`), "x".repeat(i + 1));
    writeFileSync(join(dir, ".manifest.json.tmp"), "y");
    let turns = 0;
    let running = true;
    const spin = (async () => {
      while (running) {
        turns++;
        await tick();
      }
    })();
    const r = await cleanSnapshotDir(dir, () => {}, 5);
    running = false;
    await spin;
    expect(r).toEqual({ files: 26, bytes: (25 * 26) / 2 + 1 });
    expect(turns).toBeGreaterThanOrEqual(5);
    expect(readdirSync(dir)).toEqual(["manifest.json"]);
    // a directory that is not there is nothing to clean
    expect(await cleanSnapshotDir(join(dir, "none"))).toEqual({ files: 0, bytes: 0 });
  });
});

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

  it("are listed apart with their counts and fingerprint, one entry per space with an open leader", async () => {
    const store = new SqliteStore(":memory:");
    const dir = freshDir();
    await add(store, 4, 4, 2, 2.5);
    await addSpace(store, "boundary/tesseract/cube/12", 1.24);
    await addSpace(store, "boundary/tesseract/ball/9", 2.1);
    await addSpace(store, "boundary/tesseract/ball/9", 2.2, "Bob"); // not the leader
    await addSpace(store, "sphere/4/12", 3.1);
    await addSpace(store, "sphere/0/2", 1); // closed: left out
    await addSpace(store, "boundary/tesseract/ball/99", 5); // not in the catalogue: left out

    const spaces = snapshotSpaces(index, store);
    expect(spaces.names).toEqual(["sphere", "boundary"]);
    expect(await buildSnapshot({ store, dir, closed, spaces })).toMatchObject({ changed: 3, kept: 0, dropped: 0 });
    const m = readManifest(dir)!;
    // the pairs alone in `files` and in the totals
    expect(m.files.map((f) => f.file)).toEqual(["4-4.json.gz"]);
    expect([m.records, m.pieces]).toEqual([1, 2]);
    expect(m.spaces!.map((f) => [f.space, f.file, f.records, f.pieces])).toEqual([
      ["sphere", "space-sphere.json.gz", 1, 12],
      ["boundary", "space-boundary.json.gz", 2, 21],
    ]);
    for (const f of m.spaces!)
      expect(Object.keys(f).sort()).toEqual(["as_of", "file", "fingerprint", "pieces", "records", "space"]);
    expect(readdirSync(dir)).toEqual(["manifest.json"]);
  });

  it("keep the entry of a space whose leaders are unchanged, and renew the others", async () => {
    const store = new SqliteStore(":memory:");
    const dir = freshDir();
    const spaces = snapshotSpaces(index, store);
    const now = clock();
    await addSpace(store, "boundary/tesseract/ball/9", 2.1);
    const sphere = await addSpace(store, "sphere/4/12", 3.1);
    await buildSnapshot({ store, dir, closed, spaces, now });
    const before = readManifest(dir)!.spaces!;

    expect(await buildSnapshot({ store, dir, closed, spaces, now })).toMatchObject({ changed: 0, kept: 2, dropped: 0 });
    expect(readManifest(dir)!.spaces).toEqual(before);

    // a new leader in one space
    await addSpace(store, "boundary/tesseract/ball/9", 2.05);
    expect(await buildSnapshot({ store, dir, closed, spaces, now })).toMatchObject({ changed: 1, kept: 1 });
    const after = readManifest(dir)!.spaces!;
    expect(after[0]).toEqual(before[0]);
    expect(after[1].fingerprint).not.toBe(before[1].fingerprint);
    expect(after[1].as_of > before[1].as_of).toBe(true);

    // an edited name changes the fingerprint too
    await store.spaceEdit(sphere, { name: "Cy" });
    expect(await buildSnapshot({ store, dir, closed, spaces, now })).toMatchObject({ changed: 1, kept: 1 });
    expect(readManifest(dir)!.spaces![0].fingerprint).not.toBe(after[0].fingerprint);

    // a space whose last entry is removed leaves the manifest
    await store.spaceRemove(sphere);
    expect(await buildSnapshot({ store, dir, closed, spaces, now })).toMatchObject({ changed: 0, kept: 1, dropped: 1 });
    expect(readManifest(dir)!.spaces!.map((f) => f.file)).toEqual(["space-boundary.json.gz"]);

    // a build without the spaces drops theirs
    expect(await buildSnapshot({ store, dir, closed, now })).toMatchObject({ changed: 0, kept: 0, dropped: 1 });
    expect(readManifest(dir)!.spaces).toEqual([]);
  });

  it("refuse a manifest whose `spaces` is not a list: nothing is served from it, and the next build replaces it", async () => {
    const store = new SqliteStore(":memory:");
    const dir = freshDir();
    await addSpace(store, "sphere/4/12", 3.1);
    const spaces = snapshotSpaces(index, store);
    await buildSnapshot({ store, dir, closed, spaces });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...readManifest(dir)!, spaces: {} }));
    expect(readManifest(dir)).toBeNull();
    const source = snapshotSource({ dir, store, closed, spaces });
    expect(source.has("space-sphere.json.gz")).toBe(false);
    expect(await source.generate("space-sphere.json.gz")).toBeNull();
    expect(await buildSnapshot({ store, dir, closed, spaces })).toMatchObject({ changed: 1, kept: 0 });
    expect(readManifest(dir)!.spaces!.map((f) => f.file)).toEqual(["space-sphere.json.gz"]);
  });
});

describe("GET /api/snapshot", () => {
  it("serves the manifest, and answers 404 before the first build and on a server that builds none", async () => {
    const store = new SqliteStore(":memory:");
    const dir = freshDir();
    await add(store, 4, 4, 2, 2.5);
    const app = createApp({ store, records: [], snapshots: snapshotSource({ dir, store, closed }) });

    let r = await app.request("/api/snapshot");
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "no snapshot has been built yet" });
    expect((await app.request("/api/snapshot/4-4.json.gz")).status).toBe(404);

    await buildSnapshot({ store, dir, closed });
    r = await app.request("/api/snapshot");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-cache");
    expect(await r.json()).toEqual(readManifest(dir));

    const none = createApp({ store, records: [] });
    r = await none.request("/api/snapshot");
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "this server builds no snapshots" });
    expect((await none.request("/api/snapshot/4-4.json.gz")).status).toBe(404);
  });
});

describe("GET /api/snapshot/{file}", () => {
  async function setup() {
    const store = new SqliteStore(":memory:");
    const dir = freshDir();
    const ids = {
      p2: await add(store, 4, 4, 2, 2.5),
      p3: await add(store, 4, 4, 3, 3),
      circle: await add(store, 0, 3, 3, 4.1),
    };
    await add(store, 4, 4, 2, 2.6, "Bob"); // not the leader
    await add(store, 4, 4, 4, 2); // closed: left out
    const spaces = snapshotSpaces(index, store);
    await buildSnapshot({ store, dir, closed, spaces });
    const app = createApp({ store, records: [], snapshots: snapshotSource({ dir, store, closed, spaces }) });
    return { store, dir, ids, spaces, app };
  }

  it("generates the file from the leaders, line for line, with the headers the route has always sent", async () => {
    const { store, dir, ids, app } = await setup();
    const { r, body, text } = await download(app, "4-4.json.gz");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/gzip");
    expect(r.headers.get("content-disposition")).toBe('attachment; filename="4-4.json.gz"');
    expect(r.headers.get("cache-control")).toBe("public, max-age=300");
    expect(r.headers.get("content-length")).toBe(String(body.length));
    expect(text).toBe(await expectedPair(store, 4, 4, [ids.p2, ids.p3]));
    // one record per line
    expect(text.split("\n")).toHaveLength(5);
    const doc = JSON.parse(text);
    expect(doc).toMatchObject({ format: 3, N: 4, M: 4 });
    expect(doc.records[0].pieces[1][0]).toBe(1 + 0.1 + 1e-17); // full precision survives
    // the fingerprint of what was written is the manifest's, since nothing changed
    const m = readManifest(dir)!;
    expect(r.headers.get("x-snapshot-fingerprint")).toBe(m.files[1].fingerprint);
    expect(r.headers.get("x-snapshot-fingerprint")).toBe(await expectedFingerprint(store, [ids.p2, ids.p3]));
    expect(r.headers.get("x-snapshot-records")).toBe("2");
    expect((await download(app, "0-3.json.gz")).text).toBe(await expectedPair(store, 0, 3, [ids.circle]));
    // nothing was stored by the request
    expect(readdirSync(dir)).toEqual(["manifest.json"]);
  });

  it("does not send a stored file, whatever the directory holds", async () => {
    const { store, dir, ids, app } = await setup();
    writeFileSync(join(dir, "4-4.json.gz"), "stale bytes");
    expect((await download(app, "4-4.json.gz")).text).toBe(await expectedPair(store, 4, 4, [ids.p2, ids.p3]));
  });

  it("answers 404 for any name the manifest does not list", async () => {
    const { store, dir, app } = await setup();
    await add(store, 9, 9, 2, 2); // a pair that came after the manifest
    writeFileSync(join(dir, "9-9.json.gz"), "not listed");
    writeFileSync(join(dir, "space-torus.json.gz"), "not listed");
    for (const name of [
      "9-9.json.gz",
      "4-5.json.gz",
      "space-torus.json.gz",
      "space-sphere.json.gz", // no entry in this store: not in the manifest
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
      expect(await res.json()).toEqual({ error: "no such snapshot file" });
    }
  });

  it("shows a leader that changed after the manifest was built, and says so in the fingerprint", async () => {
    const { store, dir, ids, app } = await setup();
    const built = readManifest(dir)!.files[1];
    // a better leader for P = 2 and a new P, both after the manifest
    const better = await add(store, 4, 4, 2, 2.4, "Cy");
    const p5 = await add(store, 4, 4, 5, 5);
    await store.edit(ids.p3, { name: "Di" });
    const { r, text } = await download(app, "4-4.json.gz");
    expect(r.status).toBe(200);
    expect(text).toBe(await expectedPair(store, 4, 4, [better, ids.p3, p5]));
    expect(JSON.parse(text).records.map((x: { name: string }) => x.name)).toEqual(["Cy", "Di", "Ada"]);
    expect(r.headers.get("x-snapshot-records")).toBe("3");
    expect(r.headers.get("x-snapshot-fingerprint")).toBe(await expectedFingerprint(store, [better, ids.p3, p5]));
    expect(r.headers.get("x-snapshot-fingerprint")).not.toBe(built.fingerprint);
    // the manifest still lists the file, with the old counts, until the next build
    expect(readManifest(dir)!.files[1]).toEqual(built);
    await buildSnapshot({ store, dir, closed });
    expect(readManifest(dir)!.files[1].fingerprint).toBe(r.headers.get("x-snapshot-fingerprint"));
  });

  it("writes the fingerprint of the entries it wrote when a leader was overtaken while it read", async () => {
    const { store, dir, ids } = await setup();
    const stale = await store.bestPerP(4, 4);
    const better = await add(store, 4, 4, 2, 2.4);
    await store.prune(4, 4, 2); // as after every submission: the old leader is deleted
    expect(await store.get(ids.p2)).toBeNull();
    // the leaders were read before the new entry arrived
    const view = new Proxy(store, {
      get: (t, k) =>
        k === "bestPerP" ? async () => stale.filter((e) => !closed(4, 4, e.P)) : Reflect.get(t, k).bind(t),
    }) as Store;
    const source = snapshotSource({ dir, store: view, closed });
    const file = (await source.generate("4-4.json.gz"))!;
    expect(gunzipSync(file.body).toString("utf8")).toBe(await expectedPair(store, 4, 4, [better, ids.p3]));
    expect(file.fingerprint).toBe(await expectedFingerprint(store, [better, ids.p3]));
  });

  it("generates the file of a space, with its entries' configurations as stored", async () => {
    const store = new SqliteStore(":memory:");
    const dir = freshDir();
    await add(store, 4, 4, 2, 2.5);
    const cube = await addSpace(store, "boundary/tesseract/cube/12", 1.24);
    const ball = await addSpace(store, "boundary/tesseract/ball/9", 2.1);
    await addSpace(store, "boundary/tesseract/ball/9", 2.2, "Bob"); // not the leader
    const sphere = await addSpace(store, "sphere/4/12", 3.1);
    await addSpace(store, "sphere/0/2", 1); // closed: left out
    const spaces = snapshotSpaces(index, store);
    await buildSnapshot({ store, dir, closed, spaces });
    const app = createApp({ store, records: [], snapshots: snapshotSource({ dir, store, closed, spaces }) });

    const { r, text } = await download(app, "space-boundary.json.gz");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/gzip");
    const doc = JSON.parse(text);
    expect(doc).toMatchObject({ format: 3, space: "boundary" });
    // in catalogue order: balls before cubes, one record per line
    expect(doc.records.map((x: { id: number }) => x.id)).toEqual([ball, cube]);
    expect(text.split("\n")).toHaveLength(5);
    const stored = (await store.spaceGet(cube))!;
    expect(doc.records[1]).toEqual({
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
    expect(text).toContain(`"config":${stored.config}}`);
    expect(Object.keys(doc.records[1])).toEqual([...SPACE_RECORD_FIELDS]);
    expect(doc.records[1].config.pieces[0].u).toEqual([0.1 + 0.2, -1 / 3, 1e-17]);
    const m = readManifest(dir)!;
    expect(r.headers.get("x-snapshot-fingerprint")).toBe(m.spaces!.find((f) => f.space === "boundary")!.fingerprint);
    expect(r.headers.get("x-snapshot-records")).toBe("2");
    expect((await download(app, "space-sphere.json.gz")).text).toContain(`"id":${sphere}`);

    // a better entry after the manifest is in the file, and changes the fingerprint
    const better = await addSpace(store, "boundary/tesseract/ball/9", 2.05, "Cy");
    const later = await download(app, "space-boundary.json.gz");
    expect(JSON.parse(later.text).records.map((x: { id: number }) => x.id)).toEqual([better, cube]);
    expect(later.r.headers.get("x-snapshot-fingerprint")).not.toBe(r.headers.get("x-snapshot-fingerprint"));
    await buildSnapshot({ store, dir, closed, spaces });
    expect(readManifest(dir)!.spaces!.find((f) => f.space === "boundary")!.fingerprint).toBe(
      later.r.headers.get("x-snapshot-fingerprint"),
    );
  });

  it("takes the new leader of a space problem overtaken while it read", async () => {
    const store = new SqliteStore(":memory:");
    const dir = freshDir();
    await addSpace(store, "boundary/tesseract/ball/9", 2.1);
    const spaces = snapshotSpaces(index, store);
    await buildSnapshot({ store, dir, closed, spaces });
    const leaders = await store.spaceBest("boundary");
    const better = await addSpace(store, "boundary/tesseract/ball/9", 2.05); // prunes the old leader at once
    const view = new Proxy(store, {
      get: (t, k) => (k === "spaceBest" ? async () => leaders : Reflect.get(t, k).bind(t)),
    }) as SpaceStore;
    const source = snapshotSource({ dir, store, closed, spaces: snapshotSpaces(index, view) });
    const file = (await source.generate("space-boundary.json.gz"))!;
    expect(JSON.parse(gunzipSync(file.body).toString("utf8")).records.map((r: { id: number }) => r.id)).toEqual([
      better,
    ]);
  });

  it("answers HEAD without generating anything, and counts it for no limit", async () => {
    const { store, dir, spaces } = await setup();
    let reads = 0;
    const view = new Proxy(store, {
      get: (t, k) =>
        k === "bestPerP" ? async (N: number, M: number) => (reads++, t.bestPerP(N, M)) : Reflect.get(t, k).bind(t),
    }) as Store;
    const app = createApp({
      store,
      records: [],
      limits: { snapshotFilesPerHour: 1 },
      snapshots: snapshotSource({ dir, store: view, closed, spaces }),
    });
    for (let i = 0; i < 5; i++) {
      const head = await app.request("/api/snapshot/4-4.json.gz", { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-type")).toBe("application/gzip");
    }
    expect(reads).toBe(0);
    expect((await app.request("/api/snapshot/9-9.json.gz", { method: "HEAD" })).status).toBe(404);
    expect((await app.request("/api/snapshot/4-4.json.gz")).status).toBe(200);
    expect(reads).toBe(1);
  });

  it("limits the files one address may fetch an hour, counting the files it generates and not the 404s", async () => {
    const { store, dir, spaces } = await setup();
    const app = createApp({
      store,
      records: [],
      limits: { snapshotFilesPerHour: 3 },
      clientIp: (c) => c.req.header("x-test-ip") ?? "1.1.1.1",
      snapshots: snapshotSource({ dir, store, closed, spaces }),
    });
    const get = (name: string, ip?: string) =>
      app.request(`/api/snapshot/${name}`, ip ? { headers: { "x-test-ip": ip } } : undefined);
    for (let i = 0; i < 3; i++) expect((await get("4-4.json.gz")).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await get("9-9.json.gz")).status).toBe(404);
    const over = await get("0-3.json.gz");
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe("60");
    // the manifest and other addresses are not held back
    expect((await app.request("/api/snapshot")).status).toBe(200);
    expect((await get("0-3.json.gz", "2.2.2.2")).status).toBe(200);
  });

  it("lets the mirror's first run through: every pair file and a second run's, sequentially, within an hour", async () => {
    // 99 piece shapes of 99 container shapes: 9,801 pairs, and the spaces
    expect(SNAPSHOT_FILES_PER_HOUR).toBeGreaterThanOrEqual(2 * (99 * 99 + 6));
    const { store, dir, spaces } = await setup();
    const app = createApp({ store, records: [], snapshots: snapshotSource({ dir, store, closed, spaces }) });
    for (let i = 0; i < 300; i++) expect((await app.request("/api/snapshot/0-3.json.gz")).status).toBe(200);
  });

  it("generates at most two files at once and the others in order of arrival, without failing any", async () => {
    const { store, dir, spaces } = await setup();
    const started: string[] = [];
    const release = new Map<string, () => void>();
    const view = new Proxy(store, {
      get: (t, k) =>
        k === "bestPerP"
          ? async (N: number, M: number) => {
              const key = `${N}-${M}`;
              started.push(key);
              await new Promise<void>((resolve) => release.set(key, resolve));
              return t.bestPerP(N, M);
            }
          : Reflect.get(t, k).bind(t),
    }) as Store;
    await add(store, 5, 5, 2, 2);
    await add(store, 6, 6, 2, 2);
    await buildSnapshot({ store, dir, closed, spaces });
    const app = createApp({ store, records: [], snapshots: snapshotSource({ dir, store: view, closed, spaces }) });

    const names = ["4-4.json.gz", "0-3.json.gz", "5-5.json.gz", "6-6.json.gz"];
    const responses: Promise<Response>[] = [];
    for (const name of names) {
      responses.push(Promise.resolve(app.request(`/api/snapshot/${name}`)));
      await tick();
      await tick();
    }
    await tick();
    expect(started).toEqual(["4-4", "0-3"]);
    release.get("0-3")!();
    await until(() => started.length === 3);
    expect(started).toEqual(["4-4", "0-3", "5-5"]);
    release.get("5-5")!();
    release.get("4-4")!();
    await until(() => started.length === 4);
    expect(started).toEqual(["4-4", "0-3", "5-5", "6-6"]);
    release.get("6-6")!();
    const done = await Promise.all(responses);
    expect(done.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    for (const r of done) expect(gunzipSync(Buffer.from(await r.arrayBuffer())).length).toBeGreaterThan(10);
  });
});

describe("a Gate", () => {
  it("passes a place to the first waiting when a job ends, also a job that fails", async () => {
    const gate = new Gate(1);
    const order: string[] = [];
    const a = gate.run(async () => {
      order.push("a");
      await tick();
      throw new Error("boom");
    });
    const b = gate.run(async () => void order.push("b"));
    const c = gate.run(async () => void order.push("c"));
    await expect(a).rejects.toThrow("boom");
    await Promise.all([b, c]);
    expect(order).toEqual(["a", "b", "c"]);
  });
});

describe("generating a large pair", () => {
  it("lets the event loop in often: no gap longer than 30 ms while a full pair of 500 records is generated", async () => {
    const store = new SqliteStore(":memory:");
    const dir = freshDir();
    // P from 1 to 500, as many records as a pair can hold (125,250 pieces)
    // with coordinates that do not compress away, as real ones do
    let seed = 12345;
    const random = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296) * 20 - 10;
    for (let P = 1; P <= 500; P++)
      await store.insert({
        N: 4,
        M: 4,
        P,
        score: 1 + P,
        name: "Ada",
        agent_note: "",
        found_with: "optimizer",
        method: "harden",
        method_params: null,
        seed: 1,
        budget: { time_s: 1 },
        software: null,
        pieces: Array.from({ length: P }, () => ({ x: random(), y: random(), theta: random() })),
        container_phi: 0.1,
        created_at: "2026-10-23T00:00:00Z",
        verification: "none",
        literature_value: null,
        strict_check: null,
      });
    await buildSnapshot({ store, dir, closed: () => false });
    const m = readManifest(dir)!;
    expect(m.files[0]).toMatchObject({ records: 500, pieces: 125_250 });
    const source = snapshotSource({ dir, store, closed: () => false });
    const app = createApp({ store, records: [], snapshots: source });

    // warm up the code paths, then measure
    await (await app.request("/api/snapshot/4-4.json.gz")).arrayBuffer();
    let stop = false;
    let last = performance.now();
    let longest = 0;
    const watch = (async () => {
      while (!stop) {
        await tick();
        const t = performance.now();
        longest = Math.max(longest, t - last);
        last = t;
      }
    })();
    const started = performance.now();
    last = started;
    const r = await app.request("/api/snapshot/4-4.json.gz");
    const body = Buffer.from(await r.arrayBuffer());
    const took = performance.now() - started;
    stop = true;
    await watch;
    // after the measure: unzipping the answer is a long step of its own
    console.log(
      `[snapshot] full pair, 500 records and 125,250 pieces: ${took.toFixed(0)} ms to generate ` +
        `${(body.length / 1e6).toFixed(2)} MB gzipped (${(gunzipSync(body).length / 1e6).toFixed(1)} MB of JSON); ` +
        `longest event-loop gap ${longest.toFixed(1)} ms`,
    );
    expect(r.headers.get("x-snapshot-records")).toBe("500");
    expect(JSON.parse(gunzipSync(body).toString("utf8")).records).toHaveLength(500);
    expect(longest).toBeLessThan(30);
  }, 120_000);
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

  it("deletes the stored files at startup, before any build, and keeps the manifest", async () => {
    const store = new SqliteStore(":memory:");
    const dir = freshDir();
    await add(store, 4, 4, 2, 2.5);
    await buildSnapshot({ store, dir, closed });
    const manifest = readFileSync(join(dir, "manifest.json"), "utf8");
    writeFileSync(join(dir, "4-4.json.gz"), "stored");
    writeFileSync(join(dir, "space-sphere.json.gz"), "stored");
    writeFileSync(join(dir, ".4-4.json.gz.tmp"), "left over");
    const log: string[] = [];
    // recent: no build soon
    const schedule = scheduleSnapshots({ store, dir, closed, hourUtc: 11, startDelayMs: 1, log: (m) => log.push(m) });
    stops.push(schedule.stop);
    expect(await schedule.cleaned).toEqual({ files: 3, bytes: 6 + 6 + 9 });
    expect(readdirSync(dir)).toEqual(["manifest.json"]);
    expect(readFileSync(join(dir, "manifest.json"), "utf8")).toBe(manifest);
    expect(log).toEqual(["[snapshot] 3 stored file(s) removed, 21 bytes freed"]);
  });

  it("builds soon after startup when there is no snapshot", async () => {
    const store = new SqliteStore(":memory:");
    const dir = freshDir();
    await add(store, 4, 4, 2, 2.5);
    stops.push(scheduleSnapshots({ store, dir, closed, hourUtc: 11, startDelayMs: 1 }).stop);
    await waitFor(() => readManifest(dir)?.completed_at != null);
  });

  it("builds soon after startup when the stored snapshot is of format 2", async () => {
    const store = new SqliteStore(":memory:");
    const dir = freshDir();
    await add(store, 4, 4, 2, 2.5);
    await buildSnapshot({ store, dir, closed });
    const m = readManifest(dir)!;
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...m, format: 2 }));
    writeFileSync(join(dir, "4-4.json.gz"), "stored by format 2");
    stops.push(scheduleSnapshots({ store, dir, closed, hourUtc: 11, startDelayMs: 1 }).stop);
    await waitFor(() => readManifest(dir)?.completed_at != null);
    expect(readdirSync(dir)).toEqual(["manifest.json"]);
  });

  it("builds soon after startup when the last build was cut short", async () => {
    const store = new SqliteStore(":memory:");
    const dir = freshDir();
    await add(store, 4, 4, 2, 2.5);
    await buildSnapshot({ store, dir, closed });
    const m = readManifest(dir)!;
    // as a build leaves it when it is cut short
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ ...m, generated_at: new Date(Date.parse(m.generated_at) + 60_000).toISOString() }),
    );
    expect(isComplete(readManifest(dir))).toBe(false);
    stops.push(scheduleSnapshots({ store, dir, closed, hourUtc: 11, startDelayMs: 1 }).stop);
    await waitFor(() => isComplete(readManifest(dir)));
  });

  it("does not build at startup when the last build is recent", async () => {
    const store = new SqliteStore(":memory:");
    const dir = freshDir();
    await add(store, 4, 4, 2, 2.5);
    await buildSnapshot({ store, dir, closed });
    const done = readManifest(dir)!.generated_at;
    await add(store, 4, 4, 3, 3);
    stops.push(scheduleSnapshots({ store, dir, closed, hourUtc: 11, startDelayMs: 1 }).stop);
    await new Promise((r) => setTimeout(r, 200));
    expect(readManifest(dir)!.generated_at).toBe(done);
    expect(existsSync(join(dir, "manifest.json"))).toBe(true);
  });
});
