import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import { SCORE_TIE } from "@polypack/geometry";
import {
  SPACE_BOUND_SLACK,
  TORUS_MAX_TRANSLATES,
  SPACE_NAMES,
  SURFACE_CATALAN,
  SURFACE_ARCHIMEDEAN,
  SPACE_RECORD_MARGIN,
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
  type ParsedSpaceId,
  parseSpaceId,
  problemOf,
  validateSpaceSubmission,
} from "@polypack/spaces";
import { loadSpacesIndex, readEntryConfigSync } from "@polypack/spaces/load";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { MAX_BODY_BYTES } from "../src/limits";
import { getProblem, latticeStart } from "@polypack/polyhedra";
import { maxImageCandidates, torusLatticeStart } from "@polypack/torus";
import type { LoadStats } from "../src/load";
import {
  SPACES_CHECKED_ONLY_IF_KEPT,
  SPACE_HEAVY_CHECKS_WAITING,
  SPACE_HEAVY_CHECK_P,
  SPACE_DOMAIN_TARGETS,
  domainTargetIds,
  SPACE_GAP_CAP,
  SPACE_SETTLED_GAP,
  SPACE_TARGETS_DEFAULT_LIMIT,
  SPACE_TARGETS_CACHE_BYTES,
  SPACE_TARGETS_MAX_LIMIT,
  SpacesOptions,
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
 * An index whose sphere/3/6 research record is three times larger than it really is, so that site entries can
 * beat it. The sphere is a space whose checks are always run: its "valid, not kept" answers are the generic ones.
 */
function weakSphereIndex(): SpacesIndex {
  const file = JSON.parse(readFileSync(join(root, "data/sphere/records.json"), "utf8"));
  const r = file.records.find((x: { id: string }) => x.id === "sphere/3/6");
  Object.assign(r, { status: "best_known", score_cert: r.score_cert * 3, display: "weak", config: { ...r.config, rho: r.config.rho * 3 } });
  return { ...index, sphere: buildSpaceCatalogue("sphere", file) };
}
/** The sphere/3/6 record's pieces on a sphere k times its radius: valid, with the score rho0 k. */
const SPHERE_RHO0 = (index.sphere!.byId.get("sphere/3/6")!.certified!.score);
const sphereEntry = (k = 1, extra: object = {}) => ({
  space: "sphere",
  id: "sphere/3/6",
  config: { rho: SPHERE_RHO0 * k, pieces: JSON.parse(index.sphere!.byId.get("sphere/3/6")!.config!).pieces },
  name: "ann",
  ...extra,
});

/**
 * The real catalogues with torus/sq/0/2 open: its research record is proven optimal (Brandt et al.
 * 2019), so the real catalogue closes it. `change` alters that record further.
 */
function openedIndex(change: object = {}): SpacesIndex {
  const file = JSON.parse(readFileSync(join(root, "data/torus/records.json"), "utf8"));
  for (const r of file.records) if (r.problem === "torus/sq/0/2") Object.assign(r, { status: "best_known" }, change);
  return { ...index, torus: buildSpaceCatalogue("torus", file) };
}
/**
 * The real catalogues, but with torus/sq/0/2 open and its research record made much worse (size 3,
 * against the optimum 2 sqrt 2), so that site entries can beat it: an entry is kept only when it does.
 */
const testIndex = openedIndex({ score_cert: 3, display: "3.000000", configuration: twoDisks(3 / L2) });

let store: SqliteStore;
let app: ReturnType<typeof createApp>;
let logs: string[];
let ip = "1.1.1.1";

function makeApp(
  extra: Partial<Parameters<typeof createApp>[0]> = {},
  spaces: SpacesIndex = testIndex,
  gzip?: (data: Uint8Array) => Uint8Array<ArrayBuffer>,
  spacesExtra: Partial<SpacesOptions> = {},
) {
  store = new SqliteStore(":memory:");
  logs = [];
  app = createApp({
    store,
    records: [],
    adminToken: "secret",
    clientIp: () => ip,
    log: (m) => logs.push(m),
    spaces: { index: spaces, store, gzip, ...spacesExtra },
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
    case "boundary":
      return { s: c.s * f, pieces: c.pieces.map((q: any) => ({ ...q, u: q.u.map((x: number) => x * f) })) };
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
  it("lists the seven spaces with their catalogues and the curvature sweeps", async () => {
    makeApp({}, index);
    const { status, body } = await get("/api/spaces");
    expect(status).toBe(200);
    const r = body as SpacesResponse;
    // surface: the problems of its domain, 2038 of them with a record
    expect(r.spaces.find((s) => s.space === "surface")!.records).toBe(2038);
    expect(r.spaces.map((s) => [s.space, s.problems])).toEqual([
      ["surface", 970200],
      ["curved", 990000],
      ["sphere", 9900],
      ["torus", 148500],
      ["boundary", 32],
      ["polyhedra", 4409164],
      ["balls", 18711],
    ]);
    for (const s of r.spaces) {
      // the balls space has no standalone viewer: its problems are drawn on the board
      expect(s.viewer).toBe(s.space === "balls" ? "/#space=balls" : `/spaces/${s.space}.html`);
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
    // the targets: the default 500, 2000, 10000 and the whole list are kept compressed; other limits are served plain
    const t1 = await zipped("/api/spaces/targets");
    expect(await zipped("/api/spaces/targets?limit=500")).toBe(t1);
    expect(gzips).toBe(2);
    expect(await plain("/api/spaces/targets")).toBe(t1);
    await zipped("/api/spaces/targets?limit=2000");
    expect(gzips).toBe(3);
    // an older volunteer client's limit, below the whole list since PolyPack's prism and antiprism problems joined
    expect(JSON.parse(await zipped("/api/spaces/targets?limit=10000")).targets.length).toBe(10000);
    expect(gzips).toBe(4);
    const odd = await app.request("/api/spaces/targets?limit=51", { headers: { "accept-encoding": "gzip" } });
    expect(odd.headers.get("content-encoding")).toBeNull();
    expect(JSON.parse(await odd.text()).targets).toEqual(JSON.parse(t1).targets.slice(0, 51));
    expect(gzips).toBe(4);
    // an entry of the surface space would clear its listing; a torus entry clears the torus listing and the targets
    await zipped("/api/spaces/torus/records");
    expect(gzips).toBe(5);
    expect((await submit(torusEntry())).body.leader).toBe(true);
    await zipped("/api/spaces/surface/records");
    expect(gzips).toBe(5);
    const torus = JSON.parse(await zipped("/api/spaces/torus/records")) as SpaceRecordsResponse;
    expect(torus.problems.find((p) => p.id === "torus/sq/0/2")!.site_best!.score).toBe(L2);
    expect(JSON.parse(await zipped("/api/spaces/targets")).generated_at).not.toBe(JSON.parse(t1).generated_at);
    expect(gzips).toBe(7);
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
    expect((await get("/api/spaces/torus/problems/torus/sq/0/101")).status).toBe(404);
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
    const opened = openedIndex();
    makeApp({}, opened);
    // an entry that only ties the research record is valid and not kept (on a space whose entries are always checked)
    const cert = index.sphere!.byId.get("sphere/3/6")!.certified!.score;
    const tie = await submit(sphereEntry(1));
    expect(tie.body).toEqual({
      valid: true,
      reasons: [],
      score: cert,
      leader: false,
      best_score: cert,
      id: null,
      beats_certified: false,
    });
    // the torus answers the same entry without checking it
    const torusCert = opened.torus!.byId.get("torus/sq/0/2")!.certified!.score;
    const torusTie = await submit(torusEntry());
    expect(torusTie.status).toBe(200);
    expect(torusTie.body).toMatchObject({
      valid: false,
      score: L2,
      leader: false,
      best_score: torusCert,
      id: null,
      beats_certified: false,
      checked: false,
    });
    expect(torusTie.body.reasons[0]).toMatch(/^not checked: a size of .* cannot be kept/);
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
    makeApp({}, weakSphereIndex());
    const a = await submit(sphereEntry(1.001));
    expect(a.body.leader).toBe(true);
    // equal, and better only within the tie tolerance: not kept
    const b = await submit(sphereEntry(1.001, { name: "bob" }));
    expect(b.body).toMatchObject({ valid: true, leader: false, id: null });
    const c = await submit(sphereEntry(1.001 * (1 - SCORE_TIE / 2), { name: "cy" }));
    expect(c.body).toMatchObject({ valid: true, leader: false, id: null });
    expect(c.body.best_score).toBe(SPHERE_RHO0 * 1.001);
    expect((await get(`/api/spaces/entries/${a.body.id}`)).status).toBe(200);
    // better by more than the tolerance: the new leader; the old one is deleted
    const d = await submit(sphereEntry(1.0001, { name: "dee" }));
    expect(d.body).toMatchObject({ leader: true, id: expect.any(Number), best_score: SPHERE_RHO0 * 1.0001 });
    expect((await get(`/api/spaces/entries/${a.body.id}`)).status).toBe(404);
    expect(await store.spaceLeaders()).toEqual([
      expect.objectContaining({ id: d.body.id, name: "dee", problem: "sphere/3/6" }),
    ]);
    // worse: valid, not kept
    const e = await submit(sphereEntry(1.01, { name: "eve" }));
    expect(e.body).toMatchObject({ valid: true, leader: false, id: null, best_score: SPHERE_RHO0 * 1.0001 });
    const listing = (await get("/api/spaces/sphere/records")).body as SpaceRecordsResponse;
    expect(listing.problems.find((p) => p.id === "sphere/3/6")!.site_best!.name).toBe("dee");
  });

  it("answers a torus entry that is no better than the best without checking it, and keeps the earliest", async () => {
    makeApp({}, testIndex);
    const a = await submit(torusEntry(1.001));
    expect(a.body.leader).toBe(true);
    const notKept = async (k: number, name: string, best: number) => {
      const r = await submit(torusEntry(k, { name }));
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        valid: false,
        score: L2 * k,
        leader: false,
        best_score: best,
        id: null,
        beats_certified: false,
        checked: false,
      });
      expect(r.body.reasons[0]).toMatch(/^not checked: a size of .* cannot be kept/);
    };
    // equal, better only within the tie tolerance, and worse
    await notKept(1.001, "bob", L2 * 1.001);
    await notKept(1.001 * (1 - SCORE_TIE / 2), "cy", L2 * 1.001);
    await notKept(1.01, "eve", L2 * 1.001);
    expect((await get(`/api/spaces/entries/${a.body.id}`)).status).toBe(200);
    // better by more than the tolerance: checked and kept, and the old leader is deleted
    const d = await submit(torusEntry(1.0001, { name: "dee" }));
    expect(d.body).toMatchObject({ valid: true, leader: true, id: expect.any(Number), best_score: L2 * 1.0001 });
    expect(d.body.checked).toBeUndefined();
    expect((await get(`/api/spaces/entries/${a.body.id}`)).status).toBe(404);
    expect(await store.spaceLeaders()).toEqual([
      expect.objectContaining({ id: d.body.id, name: "dee", problem: "torus/sq/0/2" }),
    ]);
  });

  it("checks a torus entry that beats the best in full, and refuses an invalid one", async () => {
    makeApp({}, testIndex);
    // beats the research record (3) but overlaps: two disks a distance sqrt 2 apart on the torus of size 2 sqrt 2
    const overlapping = { lattice: { L: L2 }, poses: [[0, 0, 0], [1, 1, 0]] };
    const bad = await submit(torusEntry(1, { config: overlapping }));
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ valid: false, leader: false, id: null });
    expect(bad.body.checked).toBeUndefined();
    expect(bad.body.reasons[0]).toMatch(/overlap/);
    expect(await store.spaceLeaders()).toEqual([]);
    // the same with a site leader to beat
    expect((await submit(torusEntry(1.01))).body).toMatchObject({ valid: true, leader: true });
    const worseBad = await submit(torusEntry(1, { config: overlapping, name: "bob" }));
    expect(worseBad.status).toBe(422);
    expect(worseBad.body.checked).toBeUndefined();
    const good = await submit(torusEntry(1.001, { name: "cy" }));
    expect(good.body).toMatchObject({ valid: true, leader: true, beats_certified: true });
    expect(good.body.checked).toBeUndefined();
    expect(await store.spaceLeaders()).toEqual([expect.objectContaining({ name: "cy" })]);
  });

  it("keeps an entry that beats the research record, says so and logs it", async () => {
    makeApp({}, weakSphereIndex());
    const weak = SPHERE_RHO0 * 3;
    const r = await submit(sphereEntry(1.01));
    expect(r.body).toMatchObject({ valid: true, leader: true, beats_certified: true, best_score: SPHERE_RHO0 * 1.01 });
    expect(
      logs.some((l) =>
        /^\[spaces\] entry \d+ by "ann" leads sphere\/3\/6: score .* below the certified [\d.]+ \(best_known\)/.test(l),
      ),
    ).toBe(true);
    // a worse entry does not lead; best_score stays the site leader's
    const worse = await submit(sphereEntry(1.02));
    expect(worse.body).toMatchObject({ leader: false, beats_certified: true, best_score: SPHERE_RHO0 * 1.01 });
    // within the tie tolerance of the record it does not beat it, and is not kept
    makeApp({}, weakSphereIndex());
    const tie = await submit(sphereEntry(3 * (1 - SCORE_TIE / 2)));
    expect(tie.body).toMatchObject({ valid: true, leader: false, id: null, beats_certified: false, best_score: weak });
    expect(tie.body.score).toBeLessThan(weak);
    expect(logs).toEqual([]);
    // the torus answers such entries without a check, and keeps one that beats the record
    makeApp({}, weakTorusIndex());
    const kept = await submit(torusEntry(1.01));
    expect(kept.body).toMatchObject({ valid: true, leader: true, beats_certified: true, best_score: L2 * 1.01 });
    const torusWorse = await submit(torusEntry(1.02));
    expect(torusWorse.body).toMatchObject({ valid: false, leader: false, id: null, best_score: L2 * 1.01, checked: false });
    makeApp({}, weakTorusIndex());
    const torusTie = await submit(torusEntry((3 / L2) * (1 - SCORE_TIE / 2)));
    expect(torusTie.body).toMatchObject({ valid: false, leader: false, id: null, beats_certified: false, best_score: 3, checked: false });
    expect(torusTie.body.score).toBeLessThan(3);
  });

  it("does not let a record be beaten by the float tolerance alone (strict check at 1e-11)", async () => {
    makeApp({}, index);
    // the research record's own configuration shrunk by 1.05e-9: valid at the touching tolerance,
    // and smaller than the record by more than the tie tolerance, but its pieces overlap
    for (const id of [
      "torus/sq/3/2",
      "sphere/3/5",
      "curved/-1/3/0/2",
      "surface/tetrahedron/fold/3/5",
      "boundary/tesseract/cube/4",
    ]) {
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

describe("POST /api/spaces/submit: boundary records are beaten by the tie tolerance", () => {
  /** The real catalogues, with a boundary research record certified at its configuration's s times `f`. */
  function boundaryIndex(id: string, f: number): SpacesIndex {
    const file = JSON.parse(readFileSync(resolve(root, "data/boundary/records.json"), "utf8"));
    const rec = file.records.find((r: { id: string }) => r.id === id);
    const cert = rec.config.s * f;
    const records = [{ ...rec, score_cert: cert, score_float: cert, display: cert.toFixed(6) }];
    return { ...index, boundary: buildSpaceCatalogue("boundary", { ...file, records }) };
  }

  it("does not keep an entry 1e-12 below a boundary record, and keeps one 2e-9 below", async () => {
    const id = "boundary/tesseract/cube/4";
    const config = JSON.parse(index.boundary!.byId.get(id)!.config!);
    const entry = { space: "boundary", id, config, name: "ann" };
    // the record's own configuration, 1e-12 below the record: a tie
    makeApp({}, boundaryIndex(id, 1 + 1e-12));
    const tie = await submit(entry);
    expect(tie.status).toBe(200);
    expect(tie.body).toMatchObject({ valid: true, leader: false, id: null, beats_certified: false });
    // 2e-9 below: kept, after the strict check
    makeApp({}, boundaryIndex(id, 1 / (1 - 2e-9)));
    const kept = await submit(entry);
    expect(kept.body).toMatchObject({ valid: true, leader: true, beats_certified: true });
    expect(kept.body.id).not.toBeNull();
  });
});

describe("POST /api/spaces/submit: torus (2D on 3D) up to 500 pieces", () => {
  const fullPrecision = (config: { lattice: unknown; poses: number[][] }) =>
    `{"lattice":${JSON.stringify(config.lattice)},"poses":[${config.poses.map((q) => `[${q.map((v) => v.toExponential(16)).join(",")}]`).join(",")}]}`;
  const configOf = (family: "sq" | "hex" | "free", N: number, P: number) => {
    const k = torusLatticeStart({ family, N, P });
    const lattice =
      family === "free"
        ? { b1: [...k.lattice.b1], b2: [...k.lattice.b2] }
        : { L: Math.hypot(k.lattice.b1[0], k.lattice.b1[1]) };
    return { lattice, poses: k.poses.map((q) => [q.x, q.y, q.theta]) };
  };

  it.each([
    ["sq", 0],
    ["hex", 6],
    ["free", 100],
    ["free", 3],
  ] as const)("accepts the lattice start of torus/%s/%i/500 without a record, in short slices", async (family, N) => {
    const id = `torus/${family}/${N}/500`;
    const checks: { workMs: number; slices: number; longestSliceMs: number }[] = [];
    makeApp({}, index, undefined, { onCheck: (c) => checks.push(c) });
    const p = (await get(`/api/spaces/torus/problems/${id}`)).body as SpaceProblemResponse;
    expect(p).toMatchObject({ status: "no_record", certified: null, certified_config: null, best_score: null });
    const body = `{"space":"torus","id":"${id}","name":"ann","config":${fullPrecision(configOf(family, N, 500))}}`;
    expect(Buffer.byteLength(body)).toBeGreaterThan(30000);
    expect(Buffer.byteLength(body)).toBeLessThan(MAX_BODY_BYTES);
    const r = await app.request("/api/spaces/submit", { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ valid: true, leader: true, beats_certified: false });
    expect(checks).toHaveLength(1);
    expect(checks[0].slices).toBeGreaterThan(1);
    expect(checks[0].longestSliceMs).toBeLessThan(250);
    console.log(`[CALC] server ${id}: ${checks[0].workMs.toFixed(1)} ms work, max slice ${checks[0].longestSliceMs.toFixed(1)} ms, body ${Buffer.byteLength(body)} bytes`);
  });

  it("checks a skewed basis at the translate limit of 500 disks in short slices", async () => {
    const id = "torus/free/0/500";
    const base = configOf("free", 0, 500);
    const { b1, b2 } = base.lattice as { b1: number[]; b2: number[] };
    // the unreduced basis (b1, b2 + m b1) with the most candidates per pair that the server allows
    const translates = (m: number) =>
      maxImageCandidates({ b1: [b1[0], b1[1]], b2: [b2[0] + m * b1[0], b2[1] + m * b1[1]] }, 2 + 2e-7);
    let lo = 0;
    let hi = 1e5;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (translates(mid) <= TORUS_MAX_TRANSLATES) lo = mid;
      else hi = mid;
    }
    const config = { lattice: { b1, b2: [b2[0] + lo * b1[0], b2[1] + lo * b1[1]] }, poses: base.poses };
    const checks: { workMs: number; slices: number; longestSliceMs: number }[] = [];
    makeApp({}, index, undefined, { onCheck: (c) => checks.push(c) });
    // a leader 1% larger, so that the skewed entries (the same area, a smaller size) can be kept and are checked
    const larger = {
      lattice: { b1: b1.map((v) => v * 1.01), b2: b2.map((v) => v * 1.01) },
      poses: base.poses.map(([x, y, t]) => [x * 1.01, y * 1.01, t]),
    };
    expect((await submit({ space: "torus", id, name: "cy", config: larger })).body).toMatchObject({ valid: true, leader: true });
    // one translate more is refused before any pair is checked
    const more = { lattice: { b1, b2: [b2[0] + (lo + 1) * b1[0], b2[1] + (lo + 1) * b1[1]] }, poses: base.poses };
    const refused = await submit({ space: "torus", id, name: "bob", config: more });
    expect(refused.status).toBe(422);
    expect(refused.body.reasons[0]).toMatch(/too skewed/);
    const checked = checks.length;
    const r = await submit({ space: "torus", id, name: "ann", config });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ valid: true, leader: true });
    expect(r.body.checked).toBeUndefined();
    const run = checks[checked];
    expect(checks).toHaveLength(checked + 1);
    expect(run.slices).toBeGreaterThan(5);
    expect(run.longestSliceMs).toBeLessThan(250);
    console.log(`[CALC] server ${id} at ${Math.ceil(translates(lo))} translates per pair: ${run.workMs.toFixed(0)} ms work (strict pass included), max slice ${run.longestSliceMs.toFixed(1)} ms`);
    // with that leader in place the same two skewed entries cannot be kept: answered quickly, without a check
    for (const [name, skewed] of [["dee", { lattice: config.lattice, poses: base.poses }], ["eve", more]] as const) {
      const t0 = performance.now();
      const answered = await submit({ space: "torus", id, name, config: skewed });
      expect(performance.now() - t0).toBeLessThan(50);
      expect(answered.status).toBe(200);
      expect(answered.body).toMatchObject({ valid: false, leader: false, id: null, checked: false });
      expect(answered.body.reasons[0]).toMatch(/^not checked: a size of .* cannot be kept/);
    }
    expect(checks).toHaveLength(checked + 1);
  }, 30000);

  it("refuses P = 501 and an overlap at P = 500", async () => {
    makeApp({}, index);
    const big = await submit({ space: "torus", id: "torus/sq/0/501", name: "ann", config: configOf("sq", 0, 500) });
    expect(big.status).toBe(400);
    const squeezed = configOf("sq", 0, 500);
    squeezed.poses[1] = [...squeezed.poses[0]];
    const over = await submit({ space: "torus", id: "torus/sq/0/500", name: "ann", config: squeezed });
    expect(over.status).toBe(422);
    expect(over.body.reasons[0]).toMatch(/overlap/);
  });
});

describe("POST /api/spaces/submit: polyhedra (3D in 3D)", () => {
  it.each(["cubincub", "tetintet", "tidintid", "dtcindtc", "pr12l3incub"])("accepts %s/500 without a record in short slices", async (code) => {
    const id = `polyhedra/${code}/500`;
    const config = latticeStart(getProblem(code)!, 500);
    const checks: { workMs: number; slices: number; longestSliceMs: number }[] = [];
    makeApp({}, index, undefined, { onCheck: (c) => checks.push(c) });
    const p = (await get(`/api/spaces/polyhedra/problems/${id}`)).body as SpaceProblemResponse;
    expect(p).toMatchObject({ status: "no_record", certified: null, certified_config: null, best_score: null });
    // Full-precision numeric spelling models a large entry, including all seven numbers per pose.
    const rawConfig = `{"s":${config.s.toExponential(16)},"pieces":[${config.pieces.map((pose) => `[${pose.map((v) => v.toExponential(16)).join(",")}]`).join(",")}]}`;
    const body = `{"space":"polyhedra","id":"${id}","name":"ann","config":${rawConfig}}`;
    expect(Buffer.byteLength(body)).toBeGreaterThan(70000);
    expect(Buffer.byteLength(body)).toBeLessThan(MAX_BODY_BYTES);
    const r = await app.request("/api/spaces/submit", { method: "POST", headers: { "content-type": "application/json" }, body });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ valid: true, leader: true, beats_certified: false });
    expect(checks).toHaveLength(1);
    if (code === "tidintid" || code === "dtcindtc") {
      expect(checks[0].slices).toBeGreaterThan(2);
      expect(checks[0].longestSliceMs).toBeLessThan(checks[0].workMs / 2);
    }
    console.log(`[CALC] server ${code}/500: ${checks[0].workMs.toFixed(1)} ms work, max slice ${checks[0].longestSliceMs.toFixed(1)} ms, body ${Buffer.byteLength(body)} bytes`);
  });

  it.each(["kttinpkd", "pr12l3intet", "bp12inap4"])("takes %s, a pair without a record, as a problem of the domain", async (code) => {
    const id = `polyhedra/${code}/7`;
    makeApp({}, index);
    const p = (await get(`/api/spaces/polyhedra/problems/${id}`)).body as SpaceProblemResponse;
    expect(p).toMatchObject({ id, status: "no_record", certified: null, certified_config: null, best_score: null });
    expect(p.bound!.label).toBe("volume bound; [CALC]");
    const config = latticeStart(getProblem(code)!, 7);
    const r = await submit({ space: "polyhedra", id, config, name: "ann" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ valid: true, leader: true, beats_certified: false });
    // below the volume bound: refused
    const low = await submit({ space: "polyhedra", id, config: { ...config, s: p.bound!.value * 0.9 }, name: "ann" });
    expect(low.status).toBe(422);
    // a code that is no pair is no problem
    expect((await get("/api/spaces/polyhedra/problems/polyhedra/kttinxyz/7")).status).toBe(400);
    // the domain tells the board its two menus, not 8,836 codes
    const listing = (await get("/api/spaces")).body as { spaces: { space: string; domain?: { fields: { key: string }[]; problems: number } }[] };
    const d = listing.spaces.find((x) => x.space === "polyhedra")!.domain!;
    expect(d.fields.map((f) => f.key)).toEqual(["piece", "container", "P"]);
    expect(d.problems).toBe(94 * 94 * 499);
  });

  /** Two unit cubes side by side along x, `gap` apart (negative: overlapping), in a cube of edge s. */
  const cubes = (s: number, gap = 0) => ({
    s,
    pieces: [
      [-0.5 - gap / 2, 0, 0, 1, 0, 0, 0],
      [0.5 + gap / 2, 0, 0, 1, 0, 0, 0],
    ],
  });
  const entry = (config: unknown, id = "polyhedra/cubincub/2") => ({ space: "polyhedra", id, config, name: "ann" });
  /** The real catalogues, with one polyhedra record replaced: certified at `cert` with configuration `config`. */
  function replaced(id: string, cert: number, config: { s: number; pieces: number[][] }): SpacesIndex {
    const p = index.polyhedra!.byId.get(id)!;
    const file = {
      generated: "test",
      records: index.polyhedra!.problems.map((q) => {
        const fields = q.fields as { code: string; piece: string; container: string };
        const base = { id: q.id, code: fields.code, piece: fields.piece, container: fields.container, P: q.P };
        const family = "platonic";
        if (q.id !== p.id) {
          // the others keep their place in the files of configurations
          return {
            ...base,
            family,
            score_float: q.certified!.score,
            score_cert: q.certified!.score,
            display: q.certified!.display,
            status: q.status,
            config_at: q.configAt,
            bound: { value: q.bound!.value, kind: "volume" },
          };
        }
        return {
          ...base,
          family,
          score_float: cert,
          score_cert: cert,
          display: cert.toFixed(6),
          status: "best_known",
          config,
          bound: { value: q.bound!.value, kind: "volume" },
        };
      }),
    };
    return { ...index, polyhedra: buildSpaceCatalogue("polyhedra", file) };
  }
  /** The real catalogues, with polyhedra/cubincub/2's research record made worse: certified at `cert`. */
  const polyhedraIndex = (cert: number) => replaced("polyhedra/cubincub/2", cert, cubes(cert, cert - 2));
  /** P unit cubes in a row along x, `gap` apart, in a cube of edge s. */
  const row = (P: number, s: number, gap = 0) => ({
    s,
    pieces: Array.from({ length: P }, (_, i) => [(i - (P - 1) / 2) * (1 + gap), 0, 0, 1, 0, 0, 0]),
  });

  it("checks an entry that could be kept, and refuses an overlapping or protruding one, with reasons", async () => {
    makeApp({}, polyhedraIndex(2.1));
    const over = await submit(entry(cubes(2, -1e-6)));
    expect(over.status).toBe(422);
    expect(over.body.reasons[0]).toMatch(/pieces 0 and 1 overlap by/);
    const out = await submit(entry(cubes(2 - 2e-6)));
    expect(out.status).toBe(422);
    expect(out.body.reasons[0]).toMatch(/sticks out of the container/);
    expect(await store.spaceLeaders()).toEqual([]);
    // two touching cubes in a cube of edge 2, below the record of 2.1: valid and kept
    const touching = await submit(entry(cubes(2)));
    expect(touching.status).toBe(200);
    expect(touching.body).toMatchObject({
      valid: true,
      reasons: [],
      score: 2,
      leader: true,
      best_score: 2,
      beats_certified: true,
    });
  });

  it("answers an entry that cannot be kept without checking it: the research record posted back", async () => {
    makeApp({}, index);
    const id = "polyhedra/tidintid/100";
    const p = (await get(`/api/spaces/polyhedra/problems/${id}`)).body as SpaceProblemResponse;
    const t0 = performance.now();
    const r = await submit(entry(p.certified_config, id));
    expect(performance.now() - t0).toBeLessThan(50);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      valid: false,
      score: p.certified!.score,
      leader: false,
      best_score: p.certified!.score,
      id: null,
      beats_certified: false,
      checked: false,
    });
    expect(r.body.reasons[0]).toMatch(/^not checked: a size of .* cannot be kept/);
    // an overlap at an unkeepable size is not looked at either; malformed input is still refused
    expect((await submit(entry(cubes(2.5, -0.5)))).body).toMatchObject({ checked: false });
    expect((await submit(entry({ s: 2, pieces: [[0, 0, 0, 1, 0, 0]] }))).status).toBe(400);
    // the other kinds keep answering "valid, not kept" for such an entry
    expect(SPACES_CHECKED_ONLY_IF_KEPT).toEqual(new Set(["polyhedra", "torus"]));
  });

  it("keeps an entry only below the research record by more than a relative 1e-6, then by the tie rule", async () => {
    makeApp({}, polyhedraIndex(2.00001));
    // 5e-7 below the record: not kept, and so not checked
    const near = await submit(entry(cubes(2.000009, 0.000009)));
    expect(near.body).toMatchObject({
      valid: false,
      checked: false,
      leader: false,
      id: null,
      beats_certified: false,
      best_score: 2.00001,
    });
    // 4.25e-6 below: kept, and it beats the record
    const kept = await submit(entry(cubes(2.0000015, 0.0000015)));
    expect(kept.body).toMatchObject({ valid: true, leader: true, beats_certified: true, best_score: 2.0000015 });
    expect(kept.body.id).not.toBeNull();
    expect(logs.some((l) => l.includes("leads polyhedra/cubincub/2"))).toBe(true);
    // against the site leader, the tie tolerance: 5e-10 below is a tie, 5e-8 below is kept
    const tieS = 2.0000015 * (1 - 5e-10);
    const tie = await submit(entry(cubes(tieS, tieS - 2)));
    expect(tie.body).toMatchObject({ valid: false, checked: false, leader: false, id: null, best_score: 2.0000015 });
    const better = await submit(entry(cubes(2.0000014, 0.0000014)));
    expect(better.body).toMatchObject({ valid: true, leader: true, beats_certified: true });
    const listing = (await get("/api/spaces/polyhedra/records")).body as SpaceRecordsResponse;
    const p = listing.problems.find((x) => x.id === "polyhedra/cubincub/2")!;
    expect(p.site_best?.score).toBe(2.0000014);
    expect(p.best_score).toBe(2.0000014);
  });

  it("refuses malformed configurations, a P above the catalogue's and oversized bodies", async () => {
    makeApp({}, index);
    const bad = async (config: unknown, id?: string) => (await submit(entry(config, id))).status;
    expect(
      await bad({
        s: 2,
        pieces: [
          [-0.5, 0, 0, 1e101, 0, 0, 0],
          [0.5, 0, 0, 1, 0, 0, 0],
        ],
      }),
    ).toBe(400);
    expect(
      await bad({
        s: 2,
        pieces: [
          [-0.5, 0, 0, 1, 0, 0],
          [0.5, 0, 0, 1, 0, 0, 0],
        ],
      }),
    ).toBe(400);
    expect(await bad({ s: "2", pieces: cubes(2).pieces })).toBe(400);
    expect(
      await bad({
        s: 2,
        pieces: [
          [-0.5, 0, 0, 0, 0, 0, 0],
          [0.5, 0, 0, 1, 0, 0, 0],
        ],
      }),
    ).toBe(400);
    // a wrong count is an invalid packing, not a malformed body
    expect(await bad({ s: 3, pieces: cubes(3).pieces }, "polyhedra/cubincub/3")).toBe(422);
    const big = await submit(entry(row(501, 600), "polyhedra/cubincub/501"));
    expect(big.status).toBe(400);
    expect(big.body.reasons[0]).toMatch(/is not in the polyhedra catalogue/);
    const huge = await submit({ ...entry(cubes(2)), agent_note: "x".repeat(300 * 1024) });
    expect(huge.status).toBe(413);
    expect(await store.spaceLeaders()).toEqual([]);
  });

  it("checks P = 100: an overlap is refused, 100 cubes in a row below a record of 101 are kept", async () => {
    const id = "polyhedra/cubincub/100";
    makeApp({}, replaced(id, 101, row(100, 101, 0.01)));
    const over = await submit(entry(row(100, 100, -1e-6), id));
    expect(over.status).toBe(422);
    expect(over.body.reasons[0]).toMatch(/overlap by/);
    const ok = await submit(entry(row(100, 100), id));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ valid: true, score: 100, leader: true, beats_certified: true });
  });

  it("checks 100 of the largest solids in short slices of work, one heavy check at a time", async () => {
    // the record of polyhedra/tidintid/100, below a record made 0.1 % worse: checked at the touching
    // tolerance and again at the strict one, then kept
    const id = "polyhedra/tidintid/100";
    const real = index.polyhedra!.byId.get(id)!;
    const config = JSON.parse(readEntryConfigSync(root, index.polyhedra!, real)!);
    const checks: { workMs: number; slices: number; longestSliceMs: number }[] = [];
    makeApp(
      {},
      replaced(id, real.certified!.score * 1.001, { ...config, s: real.certified!.score * 1.001 }),
      undefined,
      {
        onCheck: (c) => checks.push(c),
      },
    );
    const r = await submit(entry(config, id));
    expect(r.body).toMatchObject({ valid: true, leader: true, beats_certified: true });
    // [CALC] about 0.3 s of work for both checks, in slices of 20 ms measured inside the slicer: one block of
    // a whole check (about 0.15 s) would fail this, a loaded machine does not
    expect(checks).toHaveLength(1);
    expect(checks[0].slices).toBeGreaterThan(5);
    expect(checks[0].longestSliceMs).toBeLessThan(100);
  });

  it("checks one entry at a time per address, and the heavy checks one at a time", async () => {
    const id = "polyhedra/tidintid/500";
    const config = latticeStart(getProblem("tidintid")!, 500);
    // No record: a complete near-pair scan is required, then the duplicate is refused.
    const forged = { ...config, pieces: [...config.pieces.slice(0, 499), [...config.pieces[0]]] };
    const checks: { workMs: number }[] = [];
    makeApp({ clientIp: (c) => c.req.header("x-test-ip") ?? ip }, index, undefined, { onCheck: (c) => checks.push(c) });
    const from = async (address: string) => {
      const r = await app.request("/api/spaces/submit", {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-ip": address },
        body: JSON.stringify(entry(forged, id)),
      });
      return { status: r.status, body: (await r.json()) as SpaceSubmitResponse };
    };
    // eight at once from one address: one is checked, the others are told to wait
    const one = await Promise.all(Array.from({ length: 8 }, () => from("3.3.3.3")));
    expect(one.map((a) => a.status).sort()).toEqual([422, 429, 429, 429, 429, 429, 429, 429]);
    expect(one.find((a) => a.status === 429)!.body.reasons[0]).toMatch(/still being checked/);
    expect(checks).toHaveLength(1);
    // eight addresses at once: all are checked, in turn
    const many = await Promise.all(Array.from({ length: 8 }, (_, k) => from(`2.2.2.${k}`)));
    expect(many.map((a) => a.status)).toEqual(Array(8).fill(422));
    expect(checks).toHaveLength(9);
    expect(SPACE_HEAVY_CHECK_P).toBe(30);
    expect(SPACE_HEAVY_CHECKS_WAITING).toBe(8);
  }, 30000);

  it("refuses a malformed heavy body before the heavy queue and the address's one check", async () => {
    const id = "polyhedra/tidintid/500";
    const config = latticeStart(getProblem("tidintid")!, 500);
    const checks: { workMs: number }[] = [];
    makeApp({ clientIp: () => "4.4.4.4" }, index, undefined, { onCheck: (c) => checks.push(c) });
    const post = async (cfg: unknown) => {
      const r = await app.request("/api/spaces/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(entry(cfg, id)),
      });
      return r.status;
    };
    const bad = [
      { ...config, s: "big" },
      { ...config, pieces: [...config.pieces.slice(0, 499), [NaN, 0, 0, 1, 0, 0, 0]] },
      { ...config, pieces: config.pieces.slice(0, 10) },
      "nope",
    ];
    // all at once from one address: none is told to wait (none took the address's slot), none reached the check
    const statuses = await Promise.all(bad.map(post));
    expect(statuses.every((s) => s === 400 || s === 422)).toBe(true);
    expect(checks).toHaveLength(0);
  });

  it("serves a research configuration kept apart, read on demand, the same as its file", async () => {
    makeApp({}, index);
    const id = "polyhedra/phcinphc/100";
    const entryOf = index.polyhedra!.byId.get(id)!;
    expect(entryOf.config).toBeNull();
    expect(entryOf.configApart).toBe(true);
    const r = await get(`/api/spaces/polyhedra/problems/${id}`);
    expect(r.status).toBe(200);
    const body = r.body as SpaceProblemResponse;
    const [offset, length] = entryOf.configAt!;
    const file = readFileSync(resolve(root, "data/polyhedra/configs/phcinphc.jsonl"));
    expect(body.certified_config).toEqual(JSON.parse(file.subarray(offset, offset + length).toString("utf8")).config);
    expect((body.certified_config as { pieces: unknown[] }).pieces).toHaveLength(100);
    // and again, from the cache
    expect(((await get(`/api/spaces/polyhedra/problems/${id}`)).body as SpaceProblemResponse).certified_config).toEqual(
      body.certified_config,
    );
  });
});

describe("range-domain submissions", () => {
  it("serves new problems without records and keeps a first valid entry with its lower bound", async () => {
    makeApp({}, index);
    const cases = [
      { space: "curved", id: "curved/-1e-06/100/0/1", config: { size: 20, pieces: [{ x: 0, y: 0, theta: 0 }] } },
      { space: "sphere", id: "sphere/100/1", config: { rho: 100, pieces: [{ q: [1, 0, 0, 0] }] } },
      { space: "torus", id: "torus/hex/100/1", config: { lattice: { L: 100 }, poses: [[0, 0, 0]] } },
    ];
    for (const c of cases) {
      const p = await get(`/api/spaces/${c.space}/problems/${c.id}`);
      expect(p.body).toMatchObject({
        status: "no_record",
        certified: null,
        certified_config: null,
        accepts_submissions: true,
      });
      expect(p.body.bound.value).toBeGreaterThan(0);
      const r = await submit({ ...c, name: "new shape" });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toMatchObject({ valid: true, leader: true, beats_certified: false });
    }
  });
  it("includes reduced-basis storage rechecks of 100 free-torus pieces in the sliced check", async () => {
    const checks: { slices: number }[] = [];
    makeApp({}, index, undefined, { onCheck: (c) => checks.push(c) });
    const step = 1 / Math.tan(Math.PI / 100) + 1e-7,
      L = 10 * step;
    const id = "torus/free/100/100";
    const config = {
      lattice: { b1: [L, 0], b2: [0, -L] },
      poses: Array.from({ length: 100 }, (_, i) => [
        step * ((i % 10) - 4.5),
        step * (Math.floor(i / 10) - 4.5),
        Math.PI / 100,
      ]),
    };
    const r = await submit({ space: "torus", id, config, name: "large torus" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(checks).toHaveLength(1);
    expect(checks[0].slices).toBeGreaterThan(3);
    const stored = (await get(`/api/spaces/torus/problems/${id}`)).body.site_config.lattice;
    expect(stored.b1[0] * stored.b2[1] - stored.b1[1] * stored.b2[0]).toBeGreaterThan(0);
  });
  it("shares the heavy queue across all three spaces, including many-sided sphere pairs at small P", async () => {
    const checks: unknown[] = [];
    makeApp({ clientIp: (c) => c.req.header("x-test-ip") ?? ip }, index, undefined, { onCheck: (c) => checks.push(c) });
    const cases = Array.from({ length: 11 }, (_, i) => {
      if (i % 3 === 0) {
        const P = i === 0 ? 100 : 2;
        return {
          space: "sphere",
          id: `sphere/100/${P}`,
          config: { rho: 100, pieces: Array.from({ length: P }, () => ({ q: [1, 0, 0, 0] })) },
        };
      }
      if (i % 3 === 1)
        return {
          space: "curved",
          id: "curved/-1e-06/100/0/100",
          config: { size: 1000, pieces: Array.from({ length: 100 }, () => ({ x: 0, y: 0, theta: 0 })) },
        };
      return {
        space: "torus",
        id: "torus/sq/100/100",
        config: { lattice: { L: 1000 }, poses: Array.from({ length: 100 }, () => [0, 0, 0]) },
      };
    });
    const results = await Promise.all(
      cases.map(async (c, i) => {
        const r = await app.request("/api/spaces/submit", {
          method: "POST",
          headers: { "content-type": "application/json", "x-test-ip": `7.7.7.${i}` },
          body: JSON.stringify({ ...c, name: "overlap" }),
        });
        return r.status;
      }),
    );
    expect(results.filter((s) => s === 503)).toHaveLength(2);
    expect(results.filter((s) => s === 422)).toHaveLength(9);
    expect(checks).toHaveLength(9);
  });
});

describe("GET /api/spaces/targets", () => {
  /** The work list as the rule says it should be, from the research records alone (no site entries). */
  function expected(): Map<string, { space: SpaceName; P: number; raw: number }> {
    const out = new Map<string, { space: SpaceName; P: number; raw: number }>();
    for (const space of SPACE_NAMES) {
      // a space with a domain: its records and the first SPACE_DOMAIN_TARGETS of its sample (no site entries here)
      const cat = index[space]!;
      const problems = [...cat.problems];
      for (const id of domainTargetIds(cat, [], SPACE_DOMAIN_TARGETS)) {
        const parsed = parseSpaceId(space, id);
        if (typeof parsed !== "string" && !cat.byId.has(id)) problems.push(problemOf(cat, parsed)!);
      }
      for (const p of problems) {
        // nofold problems are 2D in 2D problems, except on the Catalan solids (irregular faces)
        const nofold2D =
          space === "surface" && p.fields.mode === "nofold" && !SURFACE_CATALAN.includes(String(p.fields.solid));
        if (!acceptsSubmissions(p) || nofold2D) continue;
        const w = spaceTargetWeight(p.P);
        // a problem without a record (and without site entries here) has the largest room
        if (p.status === "no_record") {
          if (w > 0) out.set(p.id, { space, P: p.P, raw: SPACE_GAP_CAP * w });
          continue;
        }
        const gap = (p.certified!.score - p.bound!.value) / p.certified!.score;
        // a record within its space's margin of the lower bound cannot be beaten by a kept entry
        const unbeatable = !(
          p.certified!.score * (1 - SPACE_RECORD_MARGIN[space]) >
          p.bound!.value * (1 - SPACE_BOUND_SLACK)
        );
        if (gap > SPACE_SETTLED_GAP && w > 0 && !unbeatable)
          out.set(p.id, { space, P: p.P, raw: Math.min(gap, SPACE_GAP_CAP) * w });
      }
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
    // closed problems, problems at their bound, P = 1 and the surface's nofold problems that are 2D in 2D never
    const ids = new Set(r.targets.map((t) => t.id));
    for (const id of ["sphere/0/2", "curved/1/0/0/2", "torus/sq/0/2", "torus/free/3/1", "surface/cube/nofold/4/12"])
      expect(ids.has(id), id).toBe(false);
    expect(r.targets.some((t) => t.P === 1)).toBe(false);
    const nofold = r.targets.filter((t) => t.id.includes("/nofold/"));
    expect(nofold.length).toBeGreaterThan(0);
    expect(nofold.every((t) => SURFACE_CATALAN.includes(t.id.split("/")[1]))).toBe(true);
    // polyhedra records at their volume bound to within the record margin: nothing can be kept below them
    for (const id of ["cubincub/8", "cubincub/27", "cubincub/64", "pr3inpr3/8", "pr3inpr3/27", "pr3inpr3/64"])
      expect(ids.has(`polyhedra/${id}`), id).toBe(false);
    // the margin rule leaves the spaces whose margin is the tie tolerance as they were
    expect(r.targets.filter((t) => t.space === "boundary").length).toBe(28);
    for (const t of r.targets) {
      const p = problemOf(index[t.space]!, parseSpaceId(t.space, t.id) as ParsedSpaceId)!;
      // a problem without a record (the balls space) and without entries has no best and no leader yet
      expect(t).toMatchObject({
        leader: p.certified ? "certified" : "none",
        leader_id: null,
        best_score: p.certified ? p.certified.score : null,
        bound: p.bound?.value ?? null,
      });
    }
    // the balls space's domain is sampled, never listed whole: small P first
    const balls = r.targets.filter((t) => t.space === "balls");
    expect(balls.length).toBe(SPACE_DOMAIN_TARGETS);
    expect(balls.every((t) => t.P <= 73)).toBe(true);
  });

  it("offers Archimedean fold targets and excludes nofold even with site entries", async () => {
    makeApp({}, index);
    const packings = JSON.parse(readFileSync(join(root, "python/surface/fixtures/archimedean_packings.json"), "utf8")).packings;
    for (const p of packings.filter((p: { N: number }) => p.N === 0)) {
      const before = await get(`/api/spaces/surface/problems/${p.id}`);
      expect(before.status).toBe(200);
      expect(before.body.status).toBe("no_record");
      expect(before.body.certified_config).toBeNull();
      expect((await submit({ space: "surface", id: p.id, config: { s: p.s, pieces: p.pieces }, name: "test" })).status).toBe(200);
    }
    const r = (await get(`/api/spaces/targets?spaces=surface&limit=${SPACE_TARGETS_MAX_LIMIT}`)).body as SpaceTargetsResponse;
    const ids = new Set(r.targets.map((t) => t.id));
    for (const p of packings.filter((p: { N: number }) => p.N === 0)) expect(ids.has(p.id), p.id).toBe(p.mode === "fold");
    for (const solid of SURFACE_ARCHIMEDEAN) expect(ids.has(`surface/${solid}/fold/0/2`), solid).toBe(true);
    expect(r.targets.some((t) => t.id.includes("/nofold/") && SURFACE_ARCHIMEDEAN.includes(t.id.split("/")[1]))).toBe(false);
  });

  it("gives every space an equal share of the priority: capped gap times min(1, (P - 1) / 5), scaled per space", async () => {
    makeApp({}, index);
    const r = (await get(`/api/spaces/targets?limit=${SPACE_TARGETS_MAX_LIMIT}`)).body as SpaceTargetsResponse;
    const want = expected();
    const sums = new Map<SpaceName, number>();
    for (const v of want.values()) sums.set(v.space, (sums.get(v.space) ?? 0) + v.raw);
    expect([...sums.keys()].sort()).toEqual([...SPACE_NAMES].sort());
    const share = new Map<SpaceName, number>();
    const n = SPACE_NAMES.length;
    for (const t of r.targets) {
      const v = want.get(t.id)!;
      expect(t.priority / (v.raw / (n * sums.get(t.space)!)), t.id).toBeCloseTo(1, 12);
      share.set(t.space, (share.get(t.space) ?? 0) + t.priority);
    }
    for (const s of SPACE_NAMES) expect(share.get(s), s).toBeCloseTo(1 / n, 12);
    expect(spaceTargetWeight(1)).toBe(0);
    expect(spaceTargetWeight(2)).toBeCloseTo(0.2, 15);
    expect(spaceTargetWeight(6)).toBe(1);
    expect(spaceTargetWeight(40)).toBe(1);
    // the default list is the head of the whole list and holds problems of every space but polyhedra and balls:
    // polyhedra's 14,850 problems share one space's share of the priority, so they come after the others' head;
    // balls' 500 sampled problems all have the largest room, so their shares are about even and none is among the
    // 500 largest
    const first = (await get("/api/spaces/targets")).body as SpaceTargetsResponse;
    expect(first.targets.length).toBe(SPACE_TARGETS_DEFAULT_LIMIT);
    expect(first.targets.map((t) => t.id)).toEqual(r.targets.slice(0, SPACE_TARGETS_DEFAULT_LIMIT).map((t) => t.id));
    expect(new Set(first.targets.map((t) => t.space))).toEqual(
      new Set(SPACE_NAMES.filter((s) => s !== "polyhedra" && s !== "balls")),
    );
    const balls = (await get("/api/spaces/targets?spaces=balls")).body as SpaceTargetsResponse;
    expect(balls.targets.length).toBe(SPACE_TARGETS_DEFAULT_LIMIT);
    expect(balls.targets.every((t) => t.space === "balls")).toBe(true);
    const polyhedra = (await get("/api/spaces/targets?spaces=polyhedra")).body as SpaceTargetsResponse;
    expect(polyhedra.targets.length).toBe(SPACE_TARGETS_DEFAULT_LIMIT);
    expect(polyhedra.targets.every((t) => t.space === "polyhedra")).toBe(true);
  });

  it("keeps its answers within a bound in bytes, and one answer for the queries that give it", async () => {
    expect(SPACE_TARGETS_CACHE_BYTES).toBe(16_000_000);
    const bound = 5_000_000;
    let most = 0;
    let gzips = 0;
    makeApp({}, index, (text) => (gzips++, new Uint8Array(gzipSync(text))), {
      targetsCacheBytes: bound,
      onTargetsCache: (bytes) => (most = Math.max(most, bytes)),
    });
    // 256 queries of the whole list under different max_P and limit: one answer, compressed once
    const whole = (await get(`/api/spaces/targets?limit=${SPACE_TARGETS_MAX_LIMIT}`)).body as SpaceTargetsResponse;
    for (let k = 0; k < 256; k++) {
      const r = await app.request(`/api/spaces/targets?limit=${SPACE_TARGETS_MAX_LIMIT - (k % 150)}&max_P=${500 + k}`, {
        headers: { "accept-encoding": "gzip" },
      });
      const body = JSON.parse(gunzipSync(Buffer.from(await r.arrayBuffer())).toString("utf8")) as SpaceTargetsResponse;
      expect(body.targets.length).toBe(whole.targets.length);
    }
    expect(gzips).toBe(1);
    // 256 distinct answers, with and without gzip: the cache stays within its bound
    for (let k = 0; k < 256; k++) {
      const q = `/api/spaces/targets?limit=${5000 + k}&max_P=${1 + (k % 99)}`;
      const r = await app.request(q, k % 2 ? { headers: { "accept-encoding": "gzip" } } : {});
      expect(r.status).toBe(200);
      await r.arrayBuffer();
    }
    expect(most).toBeGreaterThan(1_000_000);
    expect(most).toBeLessThanOrEqual(bound);
    // answers drawn from the cache are still right
    const small = (await get("/api/spaces/targets?max_P=5&limit=10000")).body as SpaceTargetsResponse;
    expect(small.targets.length).toBeGreaterThan(0);
    expect(small.targets.every((t) => t.P <= 5)).toBe(true);
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
      "GET /api/spaces/{space}/problems</code> (also <code>/records</code>)",
      "GET /api/spaces/{space}/problems/{id}",
      'id="spaces-no-record"',
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
      // the site's words: kinds filed under dimensions, which the API calls spaces
      '<a href="/dimensions.html">Dimensions</a>',
      "The API calls a dimension's kinds <em>spaces</em>",
      "2D on 3D",
    ])
      expect(html).toContain(part);
    expect(html).not.toContain("/spaces.html");
  });
});
