import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import { SCORE_TIE } from "@polypack/geometry";
import {
  SPACE_NAMES,
  SPACE_STRICT_REASON,
  SpaceName,
  SpaceProblemResponse,
  SpaceRecordsResponse,
  SpaceSubmitResponse,
  SpaceTargetsResponse,
  SpacesIndex,
  SpacesResponse,
  acceptsSubmissions,
  buildSpaceCatalogue,
  validateSpaceSubmission,
} from "@polypack/spaces";
import { loadSpacesIndex } from "@polypack/spaces/load";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { MAX_BODY_BYTES } from "../src/limits";
import type { LoadStats } from "../src/load";
import {
  SPACE_GAP_CAP,
  SPACE_SETTLED_GAP,
  SPACE_TARGETS_DEFAULT_LIMIT,
  SPACE_TARGETS_MAX_LIMIT,
  acceptsGzip,
  spaceTargetWeight,
} from "../src/spaces";
import { SqliteStore } from "../src/sqlite-store";

const root = resolve(__dirname, "../../..");
const index = loadSpacesIndex(root);

const L2 = 2 * Math.SQRT2;
/** Two disks on the square torus: touching at k = 1, scaled up (valid, worse) for k > 1. */
const twoDisks = (k = 1) => ({
  lattice: { L: L2 * k },
  poses: [
    [0, 0, 0],
    [Math.SQRT2 * k, Math.SQRT2 * k, 0],
  ],
});

/** An index whose torus/sq/0/2 research record is far worse than it really is, so that site entries can beat it. */
function weakTorusIndex(): SpacesIndex {
  const file = {
    generated: "test",
    records: [
      {
        problem: "torus/sq/0/2",
        family: "sq",
        N: 0,
        P: 2,
        score_cert: 3,
        display: "3.000000",
        status: "best_known",
        configuration: twoDisks(3 / L2),
        bound: { value: L2, label: "a test bound" },
      },
      {
        problem: "torus/sq/0/1",
        family: "sq",
        N: 0,
        P: 1,
        score_cert: 2.000000000002,
        display: "2.000001",
        status: "best_known",
        configuration: { lattice: { L: 2 }, poses: [[0, 0, 0]] },
        bound: { value: 2, label: "one disk" },
      },
    ],
  };
  return { torus: buildSpaceCatalogue("torus", file) };
}

/**
 * The real catalogues, but with torus/sq/0/2's research record made much worse (size 3, against
 * the optimum 2 sqrt 2), so that site entries can beat it: an entry is kept only when it does.
 */
function weakenedIndex(): SpacesIndex {
  const file = JSON.parse(readFileSync(join(root, "data/torus/records.json"), "utf8"));
  for (const r of file.records)
    if (r.problem === "torus/sq/0/2")
      Object.assign(r, { score_cert: 3, display: "3.000000", configuration: twoDisks(3 / L2) });
  return { ...index, torus: buildSpaceCatalogue("torus", file) };
}
const testIndex = weakenedIndex();

let store: SqliteStore;
let app: ReturnType<typeof createApp>;
let logs: string[];
let ip = "1.1.1.1";

function makeApp(
  extra: Partial<Parameters<typeof createApp>[0]> = {},
  spaces: SpacesIndex = testIndex,
  gzip?: (text: string) => Uint8Array<ArrayBuffer>,
) {
  store = new SqliteStore(":memory:");
  logs = [];
  app = createApp({
    store,
    records: [],
    adminToken: "secret",
    clientIp: () => ip,
    log: (m) => logs.push(m),
    spaces: { index: spaces, store, gzip },
    ...extra,
  });
}

/** A record's configuration shrunk by the factor f about the origin, sizes included (sphere: rho only). */
function shrunk(space: SpaceName, c: any, f: number): any {
  switch (space) {
    case "surface":
      return { s: c.s * f, pieces: c.pieces.map((q: any) => ({ ...q, x: q.x * f, y: q.y * f })) };
    case "curved":
      return { size: c.size * f, pieces: c.pieces.map((q: any) => ({ ...q, x: q.x * f, y: q.y * f })) };
    case "sphere":
      return { rho: c.rho * f, pieces: c.pieces };
    case "torus": {
      const L = c.lattice;
      const lattice =
        "L" in L ? { L: L.L * f } : { b1: L.b1.map((x: number) => x * f), b2: L.b2.map((x: number) => x * f) };
      return { lattice, poses: c.poses.map(([x, y, t]: number[]) => [x * f, y * f, t]) };
    }
  }
}

beforeEach(() => {
  ip = "1.1.1.1";
  makeApp();
});

async function submit(body: unknown): Promise<{ status: number; body: SpaceSubmitResponse }> {
  const r = await app.request("/api/spaces/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as SpaceSubmitResponse };
}
const get = async (path: string, headers?: Record<string, string>) => {
  const r = await app.request(path, { headers });
  return { status: r.status, body: (await r.json()) as any, headers: r.headers };
};
const admin = (path: string, body: unknown, token = "secret") =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
const torusEntry = (k = 1, extra: object = {}) => ({
  space: "torus",
  id: "torus/sq/0/2",
  config: twoDisks(k),
  name: "ann",
  ...extra,
});

describe("GET /api/spaces", () => {
  it("lists the four spaces with their catalogues and the curvature sweeps", async () => {
    const { status, body } = await get("/api/spaces");
    expect(status).toBe(200);
    const r = body as SpacesResponse;
    expect(r.spaces.map((s) => [s.space, s.problems])).toEqual([
      ["surface", 2038],
      ["curved", 334],
      ["sphere", 166],
      ["torus", 544],
    ]);
    for (const s of r.spaces) {
      expect(s.viewer).toBe(`/spaces/${s.space}.html`);
      expect(s.docs).toMatch(/^https:\/\/github\.com\/sinkomr\/PolyPack\/blob\/main\/docs\/spaces\/\w+\.md$/);
      expect(s.conventions.configuration).toBeTruthy();
    }
    expect(r.exhibits).toEqual([
      expect.objectContaining({
        name: "sweep",
        viewer: "/spaces/sweep.html",
        docs: "https://github.com/sinkomr/PolyPack/blob/main/docs/spaces/CURVED_SWEEP.md",
      }),
    ]);
  });

  it("shows the curvature sweeps only when a space is loaded", async () => {
    makeApp({}, {});
    expect((await get("/api/spaces")).body).toEqual({ spaces: [], exhibits: [] });
  });

  it("is absent from a server without spaces, and every other route is unchanged", async () => {
    app = createApp({ store: new SqliteStore(":memory:"), records: [] });
    expect((await get("/api/spaces")).status).toBe(404);
    expect((await get("/api/spaces/torus/records")).status).toBe(404);
    expect((await get("/api/health")).body).toEqual({ ok: true });
  });
});

describe("GET /api/spaces/:space/records", () => {
  it("lists every problem with its research record and no configurations", async () => {
    const { status, body } = await get("/api/spaces/curved/records");
    expect(status).toBe(200);
    const r = body as SpaceRecordsResponse;
    expect(r.space).toBe("curved");
    expect(r.problems.length).toBe(334);
    expect(JSON.stringify(r)).not.toMatch(/_config|"pieces"|"poses"/);
    const infeasible = r.problems.find((p) => p.id === "curved/1/0/0/2")!;
    expect(infeasible).toMatchObject({
      status: "infeasible",
      certified: null,
      accepts_submissions: false,
      best_score: null,
    });
    expect(infeasible.closed_reason).toMatch(/^no packing exists/);
    const open = r.problems.find((p) => p.id === "curved/-1/0/0/2")!;
    expect(open).toMatchObject({
      status: "best_known",
      accepts_submissions: true,
      closed_reason: null,
      site_best: null,
    });
    expect(open.best_score).toBe(open.certified!.score);
    expect(open.fields).toEqual({ K: -1, N: 0, M: 0, P: 2 });
  });

  it("answers 404 for an unknown space and compresses for clients that accept it", async () => {
    expect((await get("/api/spaces/plane/records")).status).toBe(404);
    const r = await app.request("/api/spaces/surface/records", { headers: { "accept-encoding": "gzip" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-encoding")).toBe("gzip");
  });

  it("is compressed once and kept with its gzip bytes, served plain to clients that do not accept gzip", async () => {
    let gzips = 0;
    makeApp({}, testIndex, (text) => {
      gzips++;
      return new Uint8Array(gzipSync(text));
    });
    const zipped = async (path: string) => {
      const r = await app.request(path, { headers: { "accept-encoding": "gzip, deflate, br" } });
      expect(r.headers.get("content-encoding")).toBe("gzip");
      expect(r.headers.get("vary")).toBe("Accept-Encoding");
      return gunzipSync(Buffer.from(await r.arrayBuffer())).toString("utf8");
    };
    const plain = async (path: string, accept?: string) => {
      const r = await app.request(path, accept === undefined ? {} : { headers: { "accept-encoding": accept } });
      expect(r.headers.get("content-encoding")).toBeNull();
      return r.text();
    };
    const a = await zipped("/api/spaces/surface/records");
    const b = await zipped("/api/spaces/surface/records");
    expect(b).toBe(a);
    expect(gzips).toBe(1);
    expect(await plain("/api/spaces/surface/records")).toBe(a);
    expect(await plain("/api/spaces/surface/records", "identity")).toBe(a);
    expect(await plain("/api/spaces/surface/records", "gzip;q=0")).toBe(a);
    expect(gzips).toBe(1);
    const t1 = await zipped("/api/spaces/targets?limit=50");
    expect(await zipped("/api/spaces/targets?limit=50")).toBe(t1);
    expect(gzips).toBe(2);
    expect(await plain("/api/spaces/targets?limit=50")).toBe(t1);
    await zipped("/api/spaces/targets?limit=51");
    expect(gzips).toBe(3);
    // an entry of the surface space would clear its listing; a torus entry clears the torus listing and the targets
    await zipped("/api/spaces/torus/records");
    expect(gzips).toBe(4);
    expect((await submit(torusEntry())).body.leader).toBe(true);
    await zipped("/api/spaces/surface/records");
    expect(gzips).toBe(4);
    const torus = JSON.parse(await zipped("/api/spaces/torus/records")) as SpaceRecordsResponse;
    expect(torus.problems.find((p) => p.id === "torus/sq/0/2")!.site_best!.score).toBe(L2);
    expect(JSON.parse(await zipped("/api/spaces/targets?limit=50")).generated_at).not.toBe(JSON.parse(t1).generated_at);
    expect(gzips).toBe(6);
  });

  it("reads Accept-Encoding as clients write it", () => {
    for (const h of ["gzip", "GZIP", "deflate, gzip;q=0.5", "*", "br;q=1, *;q=0.1", "x-gzip"])
      expect(acceptsGzip(h), h).toBe(true);
    for (const h of [undefined, "", "identity", "deflate", "gzip;q=0", "*;q=0", "br, gzip;q=0"])
      expect(acceptsGzip(h), String(h)).toBe(false);
  });

  it("is kept until an entry of its space changes", async () => {
    const before = (await get("/api/spaces/torus/records")).body as SpaceRecordsResponse;
    const again = (await get("/api/spaces/torus/records")).body as SpaceRecordsResponse;
    expect(again.generated_at).toBe(before.generated_at);
    await get("/api/spaces/sphere/records");
    const r = await submit(torusEntry());
    expect(r.body.leader).toBe(true);
    const after = (await get("/api/spaces/torus/records")).body as SpaceRecordsResponse;
    const p = after.problems.find((q) => q.id === "torus/sq/0/2")!;
    expect(p.site_best).toMatchObject({ id: r.body.id, score: L2, name: "ann" });
    expect(p.best_score).toBe(L2);
  });
});

describe("GET /api/spaces/:space/problems/<id>", () => {
  it("answers one problem with both configurations; the id is the rest of the path", async () => {
    const { status, body } = await get("/api/spaces/curved/problems/curved/-1/3/4/7");
    expect(status).toBe(200);
    const r = body as SpaceProblemResponse;
    expect(r.id).toBe("curved/-1/3/4/7");
    expect(r.conventions.pose).toMatch(/geodesic distance/);
    expect(r.certified_config).toEqual(JSON.parse(index.curved!.byId.get("curved/-1/3/4/7")!.config!));
    expect(r.site_config).toBeNull();
    const k = (await get("/api/spaces/curved/problems/curved/-1e-06/4/4/5")).body as SpaceProblemResponse;
    expect(k.fields).toEqual({ K: -1e-6, N: 4, M: 4, P: 5 });
    expect((await get("/api/spaces/curved/problems/curved/1/0/0/2")).body.certified_config).toBeNull();
  });

  it("shows the leading site entry's configuration", async () => {
    const r = await submit(torusEntry(1.05));
    const p = (await get("/api/spaces/torus/problems/torus/sq/0/2")).body as SpaceProblemResponse;
    expect(p.site_best!.id).toBe(r.body.id);
    expect(p.site_config).toEqual(twoDisks(1.05));
    expect(p.best_score).toBe(L2 * 1.05);
  });

  it("answers 400 for an id not of the space's form and 404 for one not in the catalogue", async () => {
    expect((await get("/api/spaces/torus/problems/sphere/0/2")).status).toBe(400);
    expect((await get("/api/spaces/torus/problems/torus/sq/00/2")).status).toBe(400);
    expect((await get("/api/spaces/curved/problems/curved/1.0/0/0/2")).body.error).toMatch(/written 1/);
    expect((await get("/api/spaces/torus/problems/torus/sq/0/99")).status).toBe(404);
    expect((await get("/api/spaces/cone/problems/cone/1")).status).toBe(404);
    expect((await get("/api/spaces/torus/problems/%E0%A4%A")).status).toBe(400);
  });
});

describe("POST /api/spaces/submit", () => {
  it("accepts a valid configuration at the size it states and keeps it when it beats the best value", async () => {
    const r = await submit(
      torusEntry(1, { software: "test 1.0", method: "by hand", seed: 3, agent_note: "<b>note</b>" }),
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      valid: true,
      reasons: [],
      score: L2,
      leader: true,
      best_score: L2,
      id: r.body.id,
      beats_certified: true,
    });
    const e = await get(`/api/spaces/entries/${r.body.id}`);
    expect(e.status).toBe(200);
    expect(e.body).toEqual({
      id: r.body.id,
      space: "torus",
      problem: "torus/sq/0/2",
      score: L2,
      name: "ann",
      agent_note: "b note /b",
      software: "test 1.0",
      method: "by hand",
      seed: 3,
      created_at: e.body.created_at,
      config: twoDisks(),
    });
  });

  it("stores a free torus in a reduced, right-handed basis: the same lattice, poses and score", async () => {
    const file = {
      generated: "test",
      records: [
        {
          problem: "torus/free/0/2",
          family: "free",
          N: 0,
          P: 2,
          score_cert: 3,
          display: "3.000000",
          status: "best_known",
          configuration: {
            lattice: { b1: [3, 0], b2: [0, 3] },
            poses: [
              [0, 0, 0],
              [1.5, 1.5, 0],
            ],
          },
          bound: { value: 2.5, label: "a test bound" },
        },
      ],
    };
    makeApp({}, { torus: buildSpaceCatalogue("torus", file) });
    const poses = [
      [0, 0, 0],
      [Math.SQRT2, Math.SQRT2, 0],
    ];
    // the square lattice of side 2 sqrt 2, written as b2 + 100 b1 and left-handed
    const sent = { lattice: { b1: [L2, 0], b2: [-100 * L2, -L2] }, poses };
    const r = await submit({ space: "torus", id: "torus/free/0/2", config: sent, name: "ann" });
    expect(r.status).toBe(200);
    expect(r.body.leader).toBe(true);
    expect(r.body.score).toBeCloseTo(L2, 12);
    const e = (await get(`/api/spaces/entries/${r.body.id}`)).body;
    const { b1, b2 } = e.config.lattice;
    expect(b1[0] * b2[1] - b1[1] * b2[0]).toBeGreaterThan(0);
    expect(Math.hypot(...b1)).toBeCloseTo(L2, 12);
    expect(Math.hypot(...b2)).toBeCloseTo(L2, 12);
    expect(e.config.poses).toEqual(poses);
    expect(e.score).toBe(r.body.score);
    const p = (await get("/api/spaces/torus/problems/torus/free/0/2")).body as SpaceProblemResponse;
    expect(p.site_config).toEqual(e.config);
    const v = validateSpaceSubmission("torus", "torus/free/0/2", e.config, { bound: 2.5, certified: 3 });
    expect(v.valid).toBe(true);
    expect(Math.abs(v.score! - r.body.score!)).toBeLessThanOrEqual(1e-12 * L2);
  });

  it("stores the configuration with its known fields only", async () => {
    const config = { ...twoDisks(), extra: "x".repeat(100), score: 0.1 };
    const r = await submit({ ...torusEntry(), config, container: { size: 0.1 } });
    expect(r.body.score).toBe(L2);
    expect((await get(`/api/spaces/entries/${r.body.id}`)).body.config).toEqual(twoDisks());
  });

  it("refuses closed problems with 409 before looking at the packing, and stores nothing", async () => {
    const proven = await submit({ space: "sphere", id: "sphere/0/2", config: { rho: 1, pieces: [] }, name: "x" });
    expect(proven.status).toBe(409);
    expect(proven.body.reasons[0]).toMatch(/^this problem is closed: its optimum 0\.636620 is proven \(R\. A\. Rankin/);
    const infeasible = await submit({ space: "curved", id: "curved/1/0/0/2", config: "anything", name: "x" });
    expect(infeasible.status).toBe(409);
    expect(infeasible.body.reasons[0]).toMatch(/no packing exists/);
    expect(await store.spaceLeaders()).toEqual([]);
  });

  it("answers 422 with reasons for an invalid packing, a wrong count or a size below the bound", async () => {
    const overlap = await submit({
      ...torusEntry(),
      config: {
        lattice: { L: L2 },
        poses: [
          [0, 0, 0],
          [1.4, 1.4, 0],
        ],
      },
    });
    expect(overlap.status).toBe(422);
    expect(overlap.body.reasons[0]).toMatch(/pieces 0 and 1 overlap/);
    expect(overlap.body).toMatchObject({ valid: false, score: null, id: null, leader: false });
    const count = await submit({ ...torusEntry(), config: { lattice: { L: L2 }, poses: [[0, 0, 0]] } });
    expect(count.status).toBe(422);
    expect(count.body.reasons[0]).toMatch(/expected 2 pieces/);
    const small = await submit({
      space: "torus",
      id: "torus/sq/0/1",
      config: { lattice: { L: 1.9 }, poses: [[0, 0, 0]] },
      name: "a",
    });
    expect(small.status).toBe(422);
    expect(small.body.reasons[0]).toMatch(/below the lower bound/);
    expect(await store.spaceLeaders()).toEqual([]);
  });

  it("answers 400 for malformed bodies", async () => {
    const cases: [unknown, RegExp][] = [
      ["{nope", /not valid JSON/],
      [[1, 2], /must be an object/],
      [{ ...torusEntry(), space: "plane" }, /space must be one of surface, curved, sphere, torus/],
      [{ ...torusEntry(), id: "torus/sq/0/02" }, /not a torus problem id/],
      [{ ...torusEntry(), id: "torus/sq/0/40" }, /not in the torus catalogue/],
      [{ ...torusEntry(), name: "  " }, /name is required/],
      [{ ...torusEntry(), name: 5 }, /name is required/],
      [{ ...torusEntry(), seed: -1 }, /seed must be a non-negative integer/],
      [{ ...torusEntry(), seed: 1.5 }, /seed must be a non-negative integer/],
      [{ ...torusEntry(), software: "x".repeat(81) }, /software must be at most 80 characters/],
      [{ ...torusEntry(), method: 7 }, /method must be a string/],
      [{ ...torusEntry(), agent_note: {} }, /agent_note must be a string/],
      [{ ...torusEntry(), config: undefined }, /config is required/],
      [
        {
          ...torusEntry(),
          config: {
            lattice: { L: L2 },
            poses: [
              [0, 0, 0],
              [1, "1", 0],
            ],
          },
        },
        /poses\[1\]\[1\] must be a finite number/,
      ],
      [
        {
          ...torusEntry(),
          config: {
            lattice: { L: 1e300 },
            poses: [
              [0, 0, 0],
              [1, 1, 0],
            ],
          },
        },
        /at most 1000000/,
      ],
      [
        {
          ...torusEntry(),
          config: {
            lattice: { L: L2 },
            poses: [
              [0, 0, 0],
              [1e5, 1, 0],
            ],
          },
        },
        /at most 10000/,
      ],
    ];
    for (const [body, reason] of cases) {
      const r = await submit(body);
      expect(r.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(r.body.reasons.join("; ")).toMatch(reason);
    }
    expect(await store.spaceLeaders()).toEqual([]);
  });

  it("caps the body size", async () => {
    const big = { ...torusEntry(), agent_note: "x".repeat(300 * 1024) };
    const r = await submit(big);
    expect(r.status).toBe(413);
    expect(r.body.reasons).toEqual(["request body too large"]);
  });

  it("keeps an entry only when it beats the problem's best value by more than the tie tolerance", async () => {
    makeApp({}, index);
    // the research record of torus/sq/0/2 is 2 sqrt 2 to 1e-12: an entry at 2 sqrt 2 only ties it
    const cert = index.torus!.byId.get("torus/sq/0/2")!.certified!.score;
    const tie = await submit(torusEntry());
    expect(tie.body).toEqual({
      valid: true,
      reasons: [],
      score: L2,
      leader: false,
      best_score: cert,
      id: null,
      beats_certified: false,
    });
    // a poor entry is valid and not kept, whatever its name
    const sphere = index.sphere!.byId.get("sphere/3/6")!;
    const poor = await submit({
      space: "sphere",
      id: sphere.id,
      config: { rho: 999999, pieces: JSON.parse(sphere.config!).pieces },
      name: "Spam Corp",
    });
    expect(poor.body).toMatchObject({ valid: true, leader: false, id: null, best_score: sphere.certified!.score });
    expect(await store.spaceLeaders()).toEqual([]);
    const listing = (await get("/api/spaces/sphere/records")).body as SpaceRecordsResponse;
    expect(listing.problems.every((p) => p.site_best === null)).toBe(true);
  });

  it("keeps the earliest of equally good entries and only the leader", async () => {
    const a = await submit(torusEntry(1.001));
    expect(a.body.leader).toBe(true);
    // equal, and better only within the tie tolerance: not kept
    const b = await submit(torusEntry(1.001, { name: "bob" }));
    expect(b.body).toMatchObject({ valid: true, leader: false, id: null });
    const c = await submit(torusEntry(1.001 * (1 - SCORE_TIE / 2), { name: "cy" }));
    expect(c.body).toMatchObject({ valid: true, leader: false, id: null });
    expect(c.body.best_score).toBe(L2 * 1.001);
    expect((await get(`/api/spaces/entries/${a.body.id}`)).status).toBe(200);
    // better by more than the tolerance: the new leader; the old one is deleted
    const d = await submit(torusEntry(1.0001, { name: "dee" }));
    expect(d.body).toMatchObject({ leader: true, id: expect.any(Number), best_score: L2 * 1.0001 });
    expect((await get(`/api/spaces/entries/${a.body.id}`)).status).toBe(404);
    expect(await store.spaceLeaders()).toEqual([
      expect.objectContaining({ id: d.body.id, name: "dee", problem: "torus/sq/0/2" }),
    ]);
    // worse: valid, not kept
    const e = await submit(torusEntry(1.01, { name: "eve" }));
    expect(e.body).toMatchObject({ valid: true, leader: false, id: null, best_score: L2 * 1.0001 });
    const listing = (await get("/api/spaces/torus/records")).body as SpaceRecordsResponse;
    expect(listing.problems.find((p) => p.id === "torus/sq/0/2")!.site_best!.name).toBe("dee");
  });

  it("keeps an entry that beats the research record, says so and logs it", async () => {
    makeApp({}, weakTorusIndex());
    const r = await submit(torusEntry(1.01));
    expect(r.body).toMatchObject({ valid: true, leader: true, beats_certified: true, best_score: L2 * 1.01 });
    expect(
      logs.some((l) =>
        /^\[spaces\] entry \d+ by "ann" leads torus\/sq\/0\/2: score .* below the certified 3 \(best_known\)/.test(l),
      ),
    ).toBe(true);
    // a worse entry does not lead; best_score stays the site leader's
    const worse = await submit(torusEntry(1.02));
    expect(worse.body).toMatchObject({ leader: false, beats_certified: true, best_score: L2 * 1.01 });
    // within the tie tolerance of the record it does not beat it, and is not kept
    makeApp({}, weakTorusIndex());
    const tie = await submit(torusEntry((3 / L2) * (1 - SCORE_TIE / 2)));
    expect(tie.body).toMatchObject({ valid: true, leader: false, id: null, beats_certified: false, best_score: 3 });
    expect(tie.body.score).toBeLessThan(3);
    expect(logs).toEqual([]);
  });

  it("does not let a record be beaten by the float tolerance alone (strict check at 1e-11)", async () => {
    makeApp({}, index);
    // the research record's own configuration shrunk by 1.05e-9: valid at the touching tolerance,
    // and smaller than the record by more than the tie tolerance, but its pieces overlap
    for (const id of ["torus/sq/3/2", "sphere/3/5", "curved/-1/3/0/2", "surface/tetrahedron/fold/3/5"]) {
      const space = id.split("/")[0] as SpaceName;
      const p = (await get(`/api/spaces/${space}/problems/${id}`)).body as SpaceProblemResponse;
      const copy = shrunk(space, p.certified_config, 1 - 1.05e-9);
      expect(validateSpaceSubmission(space, id, copy, { bound: p.bound!.value }).valid, id).toBe(true);
      const r = await submit({ space, id, config: copy, name: "copycat" });
      expect(r.status, id).toBe(422);
      expect(r.body.reasons[0]).toBe(SPACE_STRICT_REASON);
      expect(r.body).toMatchObject({ valid: false, beats_certified: false, id: null });
      const after = (await get(`/api/spaces/${space}/problems/${id}`)).body as SpaceProblemResponse;
      expect(after.best_score).toBe(p.certified!.score);
      expect(after.site_best).toBeNull();
    }
    expect(logs).toEqual([]);
    // a record with real slack (about 1e-8 here) can be beaten by a hair, legitimately
    const p = (await get("/api/spaces/torus/problems/torus/sq/8/16")).body as SpaceProblemResponse;
    const better = await submit({
      space: "torus",
      id: p.id,
      config: shrunk("torus", p.certified_config, 1 - 1.05e-9),
      name: "polisher",
    });
    expect(better.body).toMatchObject({ valid: true, leader: true, beats_certified: true });
  });

  it("counts a change of leader in the minute's load line", async () => {
    let changes = 0;
    const stats = { submission: () => {}, leaderChanged: () => changes++ } as unknown as LoadStats;
    makeApp({ stats });
    await submit(torusEntry(1.02));
    expect(changes).toBe(1);
    await submit(torusEntry(1.03));
    await submit(torusEntry(1.02));
    expect(changes).toBe(1);
    await submit(torusEntry(1.01));
    expect(changes).toBe(2);
  });

  it("reads a chunked body only up to the limit, on this route and on /api/submit", async () => {
    const chunk = new TextEncoder().encode(" ".repeat(16384));
    for (const path of ["/api/spaces/submit", "/api/submit"]) {
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= 8 * 1024 * 1024) return controller.close();
          sent += chunk.length;
          controller.enqueue(chunk);
        },
      });
      const r = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit);
      expect(r.status, path).toBe(413);
      expect(((await r.json()) as { reasons: string[] }).reasons).toEqual(["request body too large"]);
      expect(sent, path).toBeLessThanOrEqual(MAX_BODY_BYTES + 4 * chunk.length);
    }
    // a chunked body within the limit is read as usual
    const text = new TextEncoder().encode(JSON.stringify(torusEntry()));
    const parts = [text.slice(0, 40), text.slice(40)];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const part = parts.shift();
        if (part) controller.enqueue(part);
        else controller.close();
      },
    });
    const r = await app.request("/api/spaces/submit", { method: "POST", body, duplex: "half" } as RequestInit);
    expect(r.status).toBe(200);
    expect(((await r.json()) as SpaceSubmitResponse).leader).toBe(true);
  });

  it("shares the rate limit with /api/submit", async () => {
    makeApp({ limits: { perIp: 3 } });
    const polygon = {
      N: 4,
      M: 4,
      P: 2,
      pieces: [
        { x: 0, y: 0, theta: Math.PI / 4 },
        { x: 1, y: 0, theta: Math.PI / 4 },
      ],
      name: "ann",
    };
    const post = (path: string, body: unknown) =>
      app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post("/api/submit", polygon)).status).toBe(200);
    expect((await submit(torusEntry())).status).toBe(200);
    expect((await post("/api/submit", polygon)).status).toBe(200);
    const fourth = await submit(torusEntry());
    expect(fourth.status).toBe(429);
    expect(fourth.body.reasons[0]).toMatch(/too many submissions/);
    expect((await post("/api/submit", polygon)).status).toBe(429);
    ip = "2.2.2.2";
    expect((await submit(torusEntry())).status).toBe(200);
  });

  it("shares the verification time budget with /api/submit", async () => {
    // a budget so small that any one check uses it up
    makeApp({ limits: { verifyMsPerMinute: 1e-6 } });
    const polygon = {
      N: 4,
      M: 4,
      P: 2,
      pieces: [
        { x: 0, y: 0, theta: Math.PI / 4 },
        { x: 1, y: 0, theta: Math.PI / 4 },
      ],
      name: "ann",
    };
    expect((await submit(torusEntry())).status).toBe(200);
    const r = await app.request("/api/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(polygon),
    });
    expect(r.status).toBe(429);
    expect(((await r.json()) as { reasons: string[] }).reasons[0]).toMatch(/too much verification work/);
    const s = await submit(torusEntry());
    expect(s.status).toBe(429);
    expect(s.body.reasons[0]).toMatch(/too much verification work/);
    // the other way round
    makeApp({ limits: { verifyMsPerMinute: 1e-6 } });
    expect(
      (
        await app.request("/api/submit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(polygon),
        })
      ).status,
    ).toBe(200);
    expect((await submit(torusEntry())).status).toBe(429);
  });

  it("is refused while the server is overloaded", async () => {
    makeApp({ limits: { overloadDelayMs: 100 }, loopDelay: () => 500 });
    const r = await submit(torusEntry());
    expect(r.status).toBe(503);
    expect(r.body.reasons[0]).toMatch(/busy/);
    expect(await store.spaceLeaders()).toEqual([]);
  });

  it("writes the load line of each submission", async () => {
    const lines: string[] = [];
    const { LoadStats } = await import("../src/load");
    makeApp({ stats: new LoadStats((l) => lines.push(l)) });
    await submit(torusEntry());
    await submit({ space: "sphere", id: "sphere/0/2", config: {}, name: "x" });
    expect(lines[0]).toMatch(/^\[submit\] 200 torus\/sq\/0\/2 .* verification /);
    expect(lines[1]).toMatch(/^\[submit\] 409 sphere\/0\/2 /);
  });
});

describe("GET /api/spaces/targets", () => {
  /** The work list as the rule says it should be, from the research records alone (no site entries). */
  function expected(): Map<string, { space: SpaceName; P: number; raw: number }> {
    const out = new Map<string, { space: SpaceName; P: number; raw: number }>();
    for (const space of SPACE_NAMES)
      for (const p of index[space]!.problems) {
        if (!acceptsSubmissions(p) || (space === "surface" && p.fields.mode === "nofold")) continue;
        const gap = (p.certified!.score - p.bound!.value) / p.certified!.score;
        const w = spaceTargetWeight(p.P);
        if (gap > SPACE_SETTLED_GAP && w > 0) out.set(p.id, { space, P: p.P, raw: Math.min(gap, SPACE_GAP_CAP) * w });
      }
    return out;
  }

  it("lists every open problem with room above its bound, all within the largest limit", async () => {
    makeApp({}, index);
    const r = (await get(`/api/spaces/targets?limit=${SPACE_TARGETS_MAX_LIMIT}`)).body as SpaceTargetsResponse;
    const want = expected();
    expect(r.targets.length).toBe(want.size);
    expect(r.targets.length).toBeLessThan(SPACE_TARGETS_MAX_LIMIT);
    expect(new Set(r.targets.map((t) => t.id))).toEqual(new Set(want.keys()));
    for (let i = 1; i < r.targets.length; i++)
      expect(r.targets[i].priority).toBeLessThanOrEqual(r.targets[i - 1].priority);
    // closed problems, problems at their bound, P = 1 and the surface's nofold problems never
    const ids = new Set(r.targets.map((t) => t.id));
    for (const id of ["sphere/0/2", "curved/1/0/0/2", "torus/sq/0/2", "torus/free/3/1", "surface/cube/nofold/4/12"])
      expect(ids.has(id), id).toBe(false);
    expect(r.targets.some((t) => t.P === 1 || t.id.includes("/nofold/"))).toBe(false);
    for (const t of r.targets) {
      const p = index[t.space]!.byId.get(t.id)!;
      expect(t).toMatchObject({
        leader: "certified",
        leader_id: null,
        best_score: p.certified!.score,
        bound: p.bound!.value,
      });
    }
  });

  it("gives every space an equal share of the priority: capped gap times min(1, (P - 1) / 5), scaled per space", async () => {
    makeApp({}, index);
    const r = (await get(`/api/spaces/targets?limit=${SPACE_TARGETS_MAX_LIMIT}`)).body as SpaceTargetsResponse;
    const want = expected();
    const sums = new Map<SpaceName, number>();
    for (const v of want.values()) sums.set(v.space, (sums.get(v.space) ?? 0) + v.raw);
    expect([...sums.keys()].sort()).toEqual([...SPACE_NAMES].sort());
    const share = new Map<SpaceName, number>();
    for (const t of r.targets) {
      const v = want.get(t.id)!;
      expect(t.priority / (v.raw / (4 * sums.get(t.space)!)), t.id).toBeCloseTo(1, 12);
      share.set(t.space, (share.get(t.space) ?? 0) + t.priority);
    }
    for (const s of SPACE_NAMES) expect(share.get(s), s).toBeCloseTo(0.25, 12);
    expect(spaceTargetWeight(1)).toBe(0);
    expect(spaceTargetWeight(2)).toBeCloseTo(0.2, 15);
    expect(spaceTargetWeight(6)).toBe(1);
    expect(spaceTargetWeight(40)).toBe(1);
    // the default list holds problems of all four spaces
    const first = (await get("/api/spaces/targets")).body as SpaceTargetsResponse;
    expect(first.targets.length).toBe(SPACE_TARGETS_DEFAULT_LIMIT);
    expect(new Set(first.targets.map((t) => t.space))).toEqual(new Set(SPACE_NAMES));
  });

  it("filters by space and P and caps the answer", async () => {
    const r = (await get("/api/spaces/targets?spaces=torus,sphere&max_P=5&limit=1000")).body as SpaceTargetsResponse;
    expect(r.targets.length).toBeGreaterThan(10);
    expect(r.targets.every((t) => (t.space === "torus" || t.space === "sphere") && t.P <= 5)).toBe(true);
    expect((await get("/api/spaces/targets?spaces=all&limit=3")).body.targets.length).toBe(3);
    const surface = (await get("/api/spaces/targets?spaces=surface&max_P=3&limit=2000")).body as SpaceTargetsResponse;
    expect(surface.targets.length).toBeGreaterThan(0);
    expect(surface.targets.every((t) => t.space === "surface" && t.P <= 3)).toBe(true);
    expect((await get("/api/spaces/targets?max_P=1")).body.targets).toEqual([]);
  });

  it("parses its query strictly", async () => {
    for (const q of [
      "limit=0",
      `limit=${SPACE_TARGETS_MAX_LIMIT + 1}`,
      "limit=1e2",
      "max_P=0",
      "max_P=x",
      "spaces=plane",
      "spaces=torus,",
      "N=3",
      "limit=5&limit=6",
    ]) {
      const r = await get(`/api/spaces/targets?${q}`);
      expect(r.status, q).toBe(400);
      expect(r.body.error).toBeTruthy();
    }
  });

  it("follows the site entries: a site leader that beats the record leads the target", async () => {
    makeApp({}, weakTorusIndex());
    const before = (await get("/api/spaces/targets")).body as SpaceTargetsResponse;
    // the only target, so it has the whole of the priority
    expect(before.targets).toEqual([
      {
        space: "torus",
        id: "torus/sq/0/2",
        P: 2,
        priority: 1,
        best_score: 3,
        bound: L2,
        leader: "certified",
        leader_id: null,
      },
    ]);
    const r = await submit(torusEntry(1.01));
    const after = (await get("/api/spaces/targets")).body as SpaceTargetsResponse;
    expect(after.targets).toEqual([
      {
        space: "torus",
        id: "torus/sq/0/2",
        P: 2,
        priority: 1,
        best_score: L2 * 1.01,
        bound: L2,
        leader: "site",
        leader_id: r.body.id,
      },
    ]);
    // an entry that meets the bound settles the problem
    await submit(torusEntry(1));
    expect(((await get("/api/spaces/targets")).body as SpaceTargetsResponse).targets).toEqual([]);
    // removing it brings the problem back
    const leader = (await store.spaceLeaders())[0];
    expect((await admin("/api/admin/spaces/remove", { id: leader.id })).status).toBe(200);
    expect(((await get("/api/spaces/targets")).body as SpaceTargetsResponse).targets[0]).toMatchObject({
      leader: "certified",
      best_score: 3,
    });
  });
});

describe("admin routes for space entries", () => {
  it("need the token", async () => {
    const r = await submit(torusEntry());
    expect((await admin("/api/admin/spaces/remove", { id: r.body.id }, "wrong")).status).toBe(401);
    expect((await admin("/api/admin/spaces/edit", { id: r.body.id, name: "x" }, "wrong")).status).toBe(401);
    makeApp({ adminToken: undefined });
    expect((await admin("/api/admin/spaces/remove", { id: 1 })).status).toBe(503);
  });

  it("remove an entry, which leaves the research record alone on its problem", async () => {
    const r = await submit(torusEntry());
    await get("/api/spaces/torus/records");
    const res = await admin("/api/admin/spaces/remove", { id: r.body.id });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(logs).toContain(`[spaces] entry ${r.body.id} (torus/sq/0/2) removed`);
    expect((await get(`/api/spaces/entries/${r.body.id}`)).status).toBe(404);
    const listing = (await get("/api/spaces/torus/records")).body as SpaceRecordsResponse;
    expect(listing.problems.find((p) => p.id === "torus/sq/0/2")!.site_best).toBeNull();
    expect((await admin("/api/admin/spaces/remove", { id: r.body.id })).status).toBe(404);
    expect((await admin("/api/admin/spaces/remove", { id: "1" })).status).toBe(400);
  });

  it("edit an entry's name and note, never its configuration", async () => {
    const r = await submit(torusEntry());
    await get("/api/spaces/torus/records");
    const res = await admin("/api/admin/spaces/edit", {
      id: r.body.id,
      name: "Ann <B>",
      agent_note: "fixed",
      config: { lattice: { L: 1 } },
    });
    expect(res.status).toBe(200);
    const e = (await get(`/api/spaces/entries/${r.body.id}`)).body;
    expect(e).toMatchObject({ name: "Ann B", agent_note: "fixed", config: twoDisks() });
    const listing = (await get("/api/spaces/torus/records")).body as SpaceRecordsResponse;
    expect(listing.problems.find((p) => p.id === "torus/sq/0/2")!.site_best!.name).toBe("Ann B");
    expect(logs.some((l) => l === `[spaces] entry ${r.body.id} (torus/sq/0/2) edited: name, agent_note`)).toBe(true);
    expect((await admin("/api/admin/spaces/edit", { id: r.body.id, name: " " })).status).toBe(400);
    expect((await admin("/api/admin/spaces/edit", { id: r.body.id, agent_note: 3 })).status).toBe(400);
    expect((await admin("/api/admin/spaces/edit", { id: 999, name: "x" })).status).toBe(404);
    expect((await admin("/api/admin/spaces/edit", { name: "x" })).status).toBe(400);
  });
});

describe("GET /api/spaces/entries/:id", () => {
  it("answers 404 for unknown and malformed ids", async () => {
    expect((await get("/api/spaces/entries/1")).status).toBe(404);
    expect((await get("/api/spaces/entries/abc")).status).toBe(404);
    expect((await get("/api/spaces/entries/1.5")).status).toBe(404);
  });
});

describe("the space entries table", () => {
  it("is added to an existing database without touching its other tables", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "polypack-spaces-")), "old.sqlite");
    const first = new SqliteStore(path);
    await first.submit({
      N: 4,
      M: 4,
      P: 1,
      score: 1,
      name: "old",
      agent_note: "",
      pieces: [{ x: 0, y: 0, theta: Math.PI / 4 }],
      container_phi: 0,
      created_at: "2026-10-01T00:00:00.000Z",
      verification: "none",
      literature_value: null,
      strict_check: null,
      found_with: "hand",
      method: null,
      method_params: null,
      seed: null,
      budget: null,
      software: null,
    });
    // a database as it was before the spaces
    const raw = new DatabaseSync(path);
    raw.exec("DROP TABLE space_entries");
    const schemaBefore = raw
      .prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'space%' ORDER BY name")
      .all();
    raw.close();
    const reopened = new SqliteStore(path);
    expect((await reopened.leader(4, 4, 1))!.name).toBe("old");
    const s = await reopened.spaceSubmit({
      space: "torus",
      problem: "torus/sq/0/2",
      score: 3,
      name: "new",
      agent_note: "",
      software: null,
      method: null,
      seed: null,
      config: "{}",
      created_at: "2026-10-24T00:00:00.000Z",
    });
    expect(s.kept).toBe(true);
    const db = new DatabaseSync(path);
    expect(db.prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'space%' ORDER BY name").all()).toEqual(
      schemaBefore,
    );
    db.close();
    // and opened again, the entries are still there
    expect((await new SqliteStore(path).spaceLeader("torus", "torus/sq/0/2"))!.name).toBe("new");
  });

  it("applies the tie rule to every problem when listing leaders", async () => {
    const st = new SqliteStore(":memory:");
    const add = (problem: string, score: number, name: string) =>
      st.spaceSubmit({
        space: "sphere",
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
    await add("sphere/4/5", 2, "a");
    await add("sphere/4/5", 2 * (1 - SCORE_TIE / 2), "b");
    await add("sphere/4/6", 3, "c");
    await add("sphere/4/6", 2.5, "d");
    expect((await st.spaceBest("sphere")).map((l) => [l.problem, l.name])).toEqual([
      ["sphere/4/5", "a"],
      ["sphere/4/6", "d"],
    ]);
    expect((await st.spaceBest("torus")).length).toBe(0);
    expect((await st.spaceLeaders()).length).toBe(2);
  });
});

describe("the API page", () => {
  it("documents the spaces, their endpoints and what certified means", async () => {
    const html = await (await app.request("/api")).text();
    for (const part of [
      'id="spaces"',
      "GET /api/spaces</code>",
      "GET /api/spaces/{space}/records",
      "GET /api/spaces/{space}/problems/{id}",
      "GET /api/spaces/targets?spaces=&amp;max_P=&amp;limit=",
      "POST /api/spaces/submit",
      "GET /api/spaces/entries/{id}",
      "POST /api/admin/spaces/remove",
      "Research records and site entries",
      "never merged",
      "shared with <code>/api/submit</code>",
      "/spaces/surface.html",
      "/spaces/sweep.html",
      "https://github.com/sinkomr/PolyPack/blob/main/docs/spaces/TORUS.md",
      'id="spaces-kept"',
      "<code>score &lt; best_score · (1 − 1e-9)</code>",
      'id="spaces-strict"',
      "overlaps of at most 1e-11 instead of 1e-9",
      SPACE_STRICT_REASON,
      'id="spaces-priority"',
      "w = min(1, (P − 1) / 5)",
      "g = min((best_score − bound) / best_score, 0.25)",
      "the priorities of each space sum to 1 / n",
      "nofold",
      "a quaternion's norm is at least 1e-6",
      '<pre tabindex="0">',
      "surface/&lt;solid&gt;/&lt;mode&gt;/&lt;N&gt;/&lt;P&gt;",
    ])
      expect(html).toContain(part);
  });
});
