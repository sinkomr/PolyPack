/**
 * The boundary space ("3D on 4D") through the server's spaces routes, with the real catalogues and
 * an in-memory store: listing, records, problems, submissions, entries and targets. Nothing here
 * talks to a live server.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  SPACE_NAMES,
  SpaceProblemResponse,
  SpaceRecordsResponse,
  SpaceSubmitResponse,
  SpaceTargetsResponse,
  SpacesIndex,
  SpacesResponse,
  buildSpaceCatalogue,
} from "@polypack/spaces";
import { loadSpacesIndex } from "@polypack/spaces/load";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { SqliteStore } from "../src/sqlite-store";

const root = resolve(__dirname, "../../..");
const index = loadSpacesIndex(root);
const file = JSON.parse(readFileSync(join(root, "data/boundary/records.json"), "utf8"));
const record = (id: string) => file.records.find((r: any) => r.id === id);
/** A configuration scaled about the cells' centres by f, its edge included. */
const scaled = (c: any, f: number) => ({
  s: c.s * f,
  pieces: c.pieces.map((q: any) => ({ ...q, u: q.u.map((x: number) => x * f) })),
});

/**
 * The real catalogues, with ball/9's research record replaced by its own configuration grown by 1%
 * (valid, and worse), so that the real record's configuration beats it and is kept.
 */
function weakenedIndex(): SpacesIndex {
  const copy = structuredClone(file);
  const r = copy.records.find((q: any) => q.id === "boundary/tesseract/ball/9");
  r.config = scaled(r.config, 1.01);
  r.score_cert = r.config.s;
  r.display = r.config.s.toFixed(6);
  return { ...index, boundary: buildSpaceCatalogue("boundary", copy) };
}

let store: SqliteStore;
let app: ReturnType<typeof createApp>;
let logs: string[];

function makeApp(spaces: SpacesIndex = index) {
  store = new SqliteStore(":memory:");
  logs = [];
  app = createApp({
    store,
    records: [],
    adminToken: "secret",
    clientIp: () => "1.1.1.1",
    log: (m) => logs.push(m),
    spaces: { index: spaces, store },
  });
}

beforeEach(() => makeApp());

const get = async (path: string) => {
  const r = await app.request(path);
  return { status: r.status, body: (await r.json()) as any };
};
async function submit(body: unknown): Promise<{ status: number; body: SpaceSubmitResponse }> {
  const r = await app.request("/api/spaces/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as SpaceSubmitResponse };
}
const entry = (id: string, config: unknown, extra: object = {}) => ({
  space: "boundary",
  id,
  config,
  name: "ann",
  ...extra,
});

describe("the boundary space in the listing and its records", () => {
  it("is listed last, with its title, viewer, notes, conventions and 32 problems", async () => {
    const r = (await get("/api/spaces")).body as SpacesResponse;
    expect(r.spaces.map((s) => s.space)).toEqual([...SPACE_NAMES]);
    const b = r.spaces.find((s) => s.space === "boundary")!;
    expect(b).toMatchObject({
      title: "Polytope boundaries",
      problems: 32,
      viewer: "/spaces/boundary.html",
      docs: "https://github.com/sinkomr/PolyPack/blob/main/docs/spaces/BOUNDARY.md",
      problem_id: "boundary/<polytope>/<piece>/<P>",
    });
    expect(b.conventions.configuration).toBe("{s, pieces: [{cell, u, q?}, ...]} with P pieces");
  });

  it("lists every problem with its research record, bound and nofold extras, and no configurations", async () => {
    const { status, body } = await get("/api/spaces/boundary/records");
    expect(status).toBe(200);
    const r = body as SpaceRecordsResponse;
    expect(r.space).toBe("boundary");
    expect(r.problems.length).toBe(32);
    expect(JSON.stringify(r)).not.toMatch(/_config|"pieces"/);
    const p = r.problems.find((q) => q.id === "boundary/tesseract/ball/9")!;
    const raw = record(p.id);
    expect(p).toEqual({
      space: "boundary",
      id: "boundary/tesseract/ball/9",
      fields: { polytope: "tesseract", piece: "ball", P: 9 },
      P: 9,
      status: "best_known",
      certified: { score: raw.score_cert, display: raw.display, status: "best_known" },
      bound: { value: raw.bound.value, label: raw.bound.label },
      site_best: null,
      best_score: raw.score_cert,
      accepts_submissions: true,
      closed_reason: null,
      extra: { nofold: { value: raw.nofold.value, label: raw.nofold.source }, fold_gain: raw.fold_gain },
    });
    expect(r.problems.every((q) => q.extra && q.extra.nofold && typeof q.extra.fold_gain === "number")).toBe(true);
    // the other spaces send no extras
    const sphere = (await get("/api/spaces/sphere/records")).body as SpaceRecordsResponse;
    expect(sphere.problems.some((q) => "extra" in q)).toBe(false);
  });
});

describe("GET /api/spaces/boundary/problems/<id>", () => {
  it("answers a problem with its certified configuration and the space's conventions", async () => {
    const { status, body } = await get("/api/spaces/boundary/problems/boundary/tesseract/cube/12");
    expect(status).toBe(200);
    const r = body as SpaceProblemResponse;
    expect(r.id).toBe("boundary/tesseract/cube/12");
    expect(r.fields).toEqual({ polytope: "tesseract", piece: "cube", P: 12 });
    expect(r.certified_config).toEqual(record(r.id).config);
    expect(r.certified_config!.s).toBe(r.certified!.score);
    expect(r.site_config).toBeNull();
    expect(r.conventions.cells).toMatch(/^cell 2 i \+ \(sigma > 0\)/);
    expect(r.extra!.nofold!.value).toBe(2);
  });

  it("answers 400 for an id not in its one form and 404 for a P outside the catalogue", async () => {
    for (const id of ["boundary/tesseract/ball/09", "boundary/tesseract/sphere/9", "boundary/tesseract/ball", "sphere/4/12"]) {
      const r = await get(`/api/spaces/boundary/problems/${id}`);
      expect(r.status, id).toBe(400);
      expect(r.body.error).toBeTruthy();
    }
    expect((await get("/api/spaces/boundary/problems/boundary/tesseract/ball/09")).body.error).toMatch(/leading zeros/);
    const missing = await get("/api/spaces/boundary/problems/boundary/tesseract/ball/17");
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe("boundary/tesseract/ball/17 is not in the boundary catalogue");
  });
});

describe("POST /api/spaces/submit for boundary problems", () => {
  it("answers the research record's own configuration as valid but not kept", async () => {
    const id = "boundary/tesseract/ball/9";
    const r = await submit(entry(id, record(id).config, { method: "boundary compression search", seed: 1 }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      valid: true,
      reasons: [],
      score: record(id).score_cert,
      leader: false,
      best_score: record(id).score_cert,
      id: null,
      beats_certified: false,
    });
    expect(await store.spaceLeaders()).toEqual([]);
  });

  it("answers 422 with reasons for an invalid packing, a wrong number of pieces or an edge below the bound", async () => {
    const id = "boundary/tesseract/ball/9";
    const invalid = await submit(entry(id, scaled(record(id).config, 1 - 1e-6)));
    expect(invalid.status).toBe(422);
    expect(invalid.body.valid).toBe(false);
    expect(invalid.body.reasons[0]).toMatch(/from an edge of the tesseract|overlap/);
    const count = await submit(entry(id, record("boundary/tesseract/ball/10").config));
    expect(count.status).toBe(422);
    expect(count.body.reasons).toEqual(["expected 9 pieces for this problem, got 10"]);
    const small = await submit(entry(id, { ...record(id).config, s: record(id).bound.value * 0.9 }));
    expect(small.status).toBe(422);
    expect(small.body.reasons[0]).toMatch(/below the lower bound/);
    // four unit cubes at the centres of cells of edge 1 - 1.05e-9: they poke through their cells'
    // faces by about 5e-10, within the touching tolerance only, and below the record (at least 1)
    const cube = "boundary/tesseract/cube/4";
    const pieces = [0, 1, 2, 3].map((cell) => ({ cell, u: [0, 0, 0] }));
    const strict = await submit(entry(cube, { s: 1 - 1.05e-9, pieces }));
    expect(strict.status).toBe(422);
    expect(strict.body.reasons[0]).toMatch(/^beats the research record only within the float tolerance/);
    expect(await store.spaceLeaders()).toEqual([]);
  });

  it("answers 400 for malformed configurations, ids that are not of the catalogue and the wrong space", async () => {
    const id = "boundary/tesseract/ball/3";
    const c = record(id).config;
    const cases: [unknown, RegExp][] = [
      [entry(id, { ...c, pieces: c.pieces.map((q: any) => ({ ...q, cell: 8 })) }), /cell must be an integer from 0 to 7/],
      [entry(id, { ...c, pieces: c.pieces.map((q: any) => ({ ...q, q: [1, 0, 0, 0] })) }), /is a ball and has no rotation q/],
      [entry(id, { ...c, s: "2" }), /s must be a finite number/],
      [entry(id, null), /config must be an object/],
      [entry("boundary/tesseract/ball/09", c), /leading zeros/],
      [entry("boundary/tesseract/ball/17", c), /is not in the boundary catalogue/],
      [entry("boundary/tesseract/ball/65", c), /is not in the boundary catalogue/],
      [{ ...entry(id, c), space: "tesseract" }, /space must be one of surface, curved, sphere, torus, boundary/],
      [{ ...entry(id, c), space: "sphere" }, /the id of a sphere problem starts with "sphere\/"/],
    ];
    for (const [body, reason] of cases) {
      const r = await submit(body);
      expect(r.status, JSON.stringify(body).slice(0, 100)).toBe(400);
      expect(r.body.reasons.join("; ")).toMatch(reason);
    }
    expect(await store.spaceLeaders()).toEqual([]);
  });

  it("keeps an entry that beats the research record, as sent, and serves it from the problem and its share link", async () => {
    makeApp(weakenedIndex());
    const id = "boundary/tesseract/ball/9";
    const before = (await get(`/api/spaces/boundary/problems/${id}`)).body as SpaceProblemResponse;
    const sent = record(id).config;
    const r = await submit(entry(id, sent, { method: "boundary compression search", seed: 7, software: "test 1" }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ valid: true, leader: true, beats_certified: true, score: sent.s, best_score: sent.s });
    expect(typeof r.body.id).toBe("number");
    expect(logs.join("\n")).toMatch(/leads boundary\/tesseract\/ball\/9: score .* is below the certified/);
    const after = (await get(`/api/spaces/boundary/problems/${id}`)).body as SpaceProblemResponse;
    expect(after.site_best).toMatchObject({ id: r.body.id, score: sent.s, name: "ann" });
    expect(after.best_score).toBe(sent.s);
    expect(after.site_config).toEqual(sent);
    expect(after.certified).toEqual(before.certified);
    expect(after.extra).toEqual(before.extra);
    const share = (await get(`/api/spaces/entries/${r.body.id}`)).body;
    expect(share).toMatchObject({ space: "boundary", problem: id, score: sent.s, method: "boundary compression search", seed: 7 });
    expect(share.config).toEqual(sent);
    const listing = (await get("/api/spaces/boundary/records")).body as SpaceRecordsResponse;
    expect(listing.problems.find((p) => p.id === id)!.site_best!.id).toBe(r.body.id);
  });
});

describe("GET /api/spaces/targets for boundary problems", () => {
  it("lists the open boundary problems with room above their bound, which share the priority equally with the other spaces", async () => {
    const all = (await get("/api/spaces/targets?limit=2000")).body as SpaceTargetsResponse;
    const mine = all.targets.filter((t) => t.space === "boundary");
    const share = mine.reduce((sum, t) => sum + t.priority, 0);
    expect(share).toBeCloseTo(1 / SPACE_NAMES.length, 12);
    const only = (await get("/api/spaces/targets?spaces=boundary&limit=2000")).body as SpaceTargetsResponse;
    expect(only.targets.map((t) => t.id)).toEqual(mine.map((t) => t.id));
    // P = 1, and the problems whose record meets its bound (balls 2 at sqrt 2, cubes 8 at 1), are left out
    const open = file.records.filter((r: any) => r.P > 1 && (r.score_cert - r.bound.value) / r.score_cert > 1e-9);
    expect(new Set(only.targets.map((t) => t.id))).toEqual(new Set(open.map((r: any) => r.id)));
    expect(open.length).toBeLessThanOrEqual(28);
    const ids = new Set(only.targets.map((t) => t.id));
    for (const id of ["boundary/tesseract/ball/1", "boundary/tesseract/ball/2", "boundary/tesseract/cube/1", "boundary/tesseract/cube/8"])
      expect(ids.has(id), id).toBe(false);
    for (const t of only.targets) {
      const raw = record(t.id);
      expect(t).toMatchObject({ space: "boundary", P: raw.P, best_score: raw.score_cert, bound: raw.bound.value, leader: "certified", leader_id: null });
    }
    // a filter picks targets and keeps their priorities
    expect(only.targets.map((t) => t.priority)).toEqual(mine.map((t) => t.priority));
    const small = (await get("/api/spaces/targets?spaces=boundary,torus&max_P=4&limit=2000")).body as SpaceTargetsResponse;
    expect(small.targets.some((t) => t.space === "boundary")).toBe(true);
    expect(small.targets.every((t) => (t.space === "boundary" || t.space === "torus") && t.P <= 4)).toBe(true);
  });
});

describe("the API page", () => {
  it("documents the boundary space, its extras and its work limits", async () => {
    const html = await (await app.request("/api")).text();
    for (const part of [
      "3D on 4D",
      "<code>boundary</code>",
      "/spaces/boundary.html",
      "https://github.com/sinkomr/PolyPack/blob/main/docs/spaces/BOUNDARY.md",
      "boundary/&lt;polytope&gt;/&lt;piece&gt;/&lt;P&gt;",
      'id="spaces-extra"',
      "<code>{nofold, fold_gain}</code>",
      "boundary 64",
      "one piece may cross at most 1024 chains of cells",
      "the full domains are never enumerated",
      "/api/spaces/boundary/problems/boundary/tesseract/ball/9",
    ])
      expect(html).toContain(part);
  });
});
