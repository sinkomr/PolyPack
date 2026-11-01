/**
 * The nD in nD space on the server: the listing, the records, submissions (valid, invalid, malformed, bounds, the
 * record margin) and the heavy-check queue.
 */
import { resolve } from "node:path";
import { loadPolytope } from "@polypack/ndim";
import { SpaceProblemResponse, SpaceRecordsResponse, SpaceSubmitResponse, SpacesResponse } from "@polypack/spaces";
import { loadSpacesIndex } from "@polypack/spaces/load";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { SqliteStore } from "../src/sqlite-store";
import { withUnits } from "./units";

const root = resolve(__dirname, "../../..");
const index = loadSpacesIndex(root);

/** P balls, or P unit hypercubes, of the 2 x ... x 2 grid in the hypercube of edge 2 + 2 gap. */
function grid(d: number, kind: "ball" | "cube", P: number, gap = 1e-7) {
  const pieces: number[][] = [];
  for (let k = 0; k < P; k++) {
    const t = Array.from({ length: d }, (_, i) => (((k >> i) & 1) - 0.5) * (1 + gap));
    pieces.push(kind === "ball" ? t : [...t, ...new Array((d * (d - 1)) / 2).fill(0), 0]);
  }
  return { s: 2 + 2 * gap, pieces };
}

let app: ReturnType<typeof createApp>;
let requests = 0;
let checks: { workMs: number; slices: number; longestSliceMs: number }[] = [];
beforeAll(async () => {
  await loadPolytope("8:421");
});
beforeEach(() => {
  checks = [];
  const store = new SqliteStore(":memory:");
  app = createApp({
    store,
    records: [],
    adminToken: "secret",
    clientIp: () => `10.0.${Math.floor(++requests / 200)}.${requests % 200}`,
    log: () => {},
    spaces: { index, store, onCheck: (c) => checks.push(c) },
  });
});
const get = async (path: string) => {
  const r = await app.request(path);
  return { status: r.status, body: (await r.json()) as any };
};
async function submit(
  id: string,
  config: unknown,
  extra: object = {},
): Promise<{ status: number; body: SpaceSubmitResponse }> {
  const r = await app.request("/api/spaces/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(withUnits({ space: "ndim", id, config, name: "ann", ...extra })),
  });
  return { status: r.status, body: (await r.json()) as SpaceSubmitResponse };
}

describe("the nD in nD space on the server", () => {
  it("is listed with its domain, its records and its conventions", async () => {
    const r = (await get("/api/spaces")).body as SpacesResponse;
    const s = r.spaces.find((x) => x.space === "ndim")!;
    expect(s).toMatchObject({ problem_id: "ndim/<d>/<piece>/<container>/<P>", problems: 6131, records: 1886 });
    expect(s.domain!.fields.map((f) => f.key)).toEqual(["d", "piece", "container", "P"]);
    expect(s.conventions.pose).toMatch(/Cayley|\(I - S\)/);
  });

  it("answers an imported record with its configuration, and a problem without a record with its bound", async () => {
    const rec = (await get("/api/spaces/ndim/problems/ndim/4/cube/cube/16")).body as SpaceProblemResponse;
    expect(rec).toMatchObject({ status: "best_known", accepts_submissions: true });
    expect(rec.certified!.score).toBeGreaterThanOrEqual(2);
    expect(rec.certified!.score).toBeLessThan(2.0000005);
    expect((rec.certified_config as any).pieces).toHaveLength(16);
    expect(rec.bound!.value).toBeCloseTo(2, 9);
    const none = (await get("/api/spaces/ndim/problems/ndim/9/ball/cube/10")).body as SpaceProblemResponse;
    expect(none).toMatchObject({ status: "no_record", certified: null, certified_config: null });
    expect(none.bound!.value).toBeGreaterThan(0.5);
    // outside the domain: P above the dimension's range, a shape the dimension lacks, a malformed id
    expect((await get("/api/spaces/ndim/problems/ndim/7/cube/cube/21")).status).toBe(404);
    expect((await get("/api/spaces/ndim/problems/ndim/4/demi/cube/5")).status).toBe(400);
    expect((await get("/api/spaces/ndim/problems/ndim/4/cube/cube/05")).status).toBe(400);
    const listing = (await get("/api/spaces/ndim/records")).body as SpaceRecordsResponse;
    expect(listing.problems).toHaveLength(1886);
  });

  it("keeps the first valid entry of a problem without a record, in every dimension, and checks it strictly", async () => {
    for (const d of [4, 5, 6, 7, 8, 9, 10]) {
      const P = Math.min(2 ** d, d === 4 ? 16 : 20);
      for (const kind of ["ball", "cube"] as const) {
        // hypercubes in a hypercube have records in 4D to 6D (the wiki's)
        if (kind === "cube" && d <= 6) continue;
        const id = `ndim/${d}/${kind}/cube/${P}`;
        const first = await submit(id, grid(d, kind, P));
        expect(first.status, id).toBe(200);
        expect(first.body, id).toMatchObject({ valid: true, leader: true, beats_certified: false });
        expect(first.body.id).not.toBeNull();
      }
    }
    // a second, not better: answered "not kept" without a check (SPACES_CHECKED_ONLY_IF_KEPT), the status 200
    const again = await submit("ndim/4/ball/cube/16", grid(4, "ball", 16));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ valid: false, leader: false, id: null, checked: false });
    expect(again.body.reasons[0]).toMatch(/not checked: a size of .* cannot be kept/);
    // a better one is checked and kept
    const better = await submit("ndim/4/ball/cube/16", grid(4, "ball", 16, 5e-8));
    expect(better.body).toMatchObject({ valid: true, leader: true });
  });

  it("rejects an invalid packing with reasons (422), malformed input (400), a size below the bound, and a wrong P", async () => {
    const id = "ndim/5/ball/cube/8";
    const g = grid(5, "ball", 8);
    const tight = await submit(id, { ...g, s: 1.9 });
    expect(tight.status).toBe(422);
    expect(tight.body.reasons.length).toBeGreaterThan(0);
    expect(tight.body.reasons.length).toBeLessThanOrEqual(5);
    const below = await submit(id, { ...g, s: 1.0 });
    expect(below.status).toBe(422);
    expect(below.body.reasons[0]).toMatch(/below the lower bound/);
    for (const bad of [{ ...g, s: -1 }, { s: 2 }, { ...g, pieces: g.pieces.map(() => [NaN]) }, "x", null])
      expect((await submit(id, bad)).status, JSON.stringify(bad)?.slice(0, 40)).toBe(400);
    expect((await submit(id, { ...g, pieces: g.pieces.slice(1) })).status).toBe(422);
    expect((await submit("ndim/5/ball/cube/33", g)).status).toBe(400);
    expect((await submit("ndim/5/24cell/cube/8", g)).status).toBe(400);
    expect((await submit(id, g, { space: "polyhedra" })).status).toBe(400);
    // two pieces on top of each other
    const piled = { ...g, pieces: g.pieces.map((p, i) => (i === 1 ? g.pieces[0] : p)) };
    const out = await submit(id, piled);
    expect(out.status).toBe(422);
    expect(out.body.reasons.join(" ")).toMatch(/pieces 0 and 1 overlap by/);
  });

  it("keeps a record only when an entry is below it by more than a relative 1e-6", async () => {
    const id = "ndim/4/cube/cube/16";
    const rec = ((await get(`/api/spaces/ndim/problems/${id}`)).body as SpaceProblemResponse).certified!.score;
    // the exact grid at the record's own size is valid and not kept; a size 1e-8 below it is not "better" either
    const gap = (rec - 2) / 2;
    const same = await submit(id, grid(4, "cube", 16, gap));
    expect(same.body).toMatchObject({ valid: false, checked: false, id: null });
    // the grid with no clearance at all, s = 2: valid within the touching tolerance but not strictly: refused by the strict check
    const touching = await submit(id, grid(4, "cube", 16, 0));
    expect(touching.status).toBe(200);
    expect(touching.body).toMatchObject({ id: null, leader: false });
    // a configuration of another problem's size is a 400 or 422, never a crash
    const wrong = await submit(id, { s: rec, pieces: grid(4, "cube", 16).pieces.slice(0, 15) });
    expect(wrong.status).toBe(422);
  });

  it("runs the checks in slices, a heavy one (large container) through the queue", async () => {
    // 20 balls in the 4_21 polytope of 8D: 19,440 facets, a heavy check
    const id = "ndim/8/ball/421/20";
    const pieces = Array.from({ length: 20 }, (_, i) => [1.1 * i - 10, 0, 0, 0, 0, 0, 0, 0]);
    const r = await submit(id, { s: 60, pieces });
    expect(r.status).toBe(200);
    expect(checks.length).toBeGreaterThan(0);
    expect(checks[0].slices).toBeGreaterThanOrEqual(1);
    expect(r.body.valid).toBe(true);
  });

  it("refuses a heavy check with 503 once the queue is full", async () => {
    const id = "ndim/8/421/421/20";
    // an invalid 20-piece packing is refused at the parse, before the queue; a form that passes the parse is queued
    const piece = [...new Array(8).fill(0), ...new Array(28).fill(0), 0];
    const pieces = Array.from({ length: 20 }, (_, i) => piece.map((v, k) => (k === 0 ? i * 3 : v)));
    const bodies = Array.from({ length: 16 }, () => submit(id, { s: 100, pieces }));
    const answers = await Promise.all(bodies);
    const statuses = answers.map((a) => a.status);
    // all are answered; none hangs, and those past the queue (one running, 8 waiting) get 503 or 429 (one check per address)
    expect(statuses.every((s) => [200, 422, 503].includes(s))).toBe(true);
    expect(statuses).toContain(503);
  });
});
