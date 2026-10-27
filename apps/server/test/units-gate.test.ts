import { join, resolve } from "node:path";
import { loadSpacesIndex } from "@polypack/spaces/load";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { SqliteStore } from "../src/sqlite-store";
import {
  CONVENTIONS_VERSION,
  VOLUNTEER_MIN_VERSION,
  isOldVolunteer,
  oldClientMayRead,
  volunteerVersion,
} from "../src/units-gate";

const root = resolve(import.meta.dirname, "../../..");
const index = loadSpacesIndex(root);
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  const store = new SqliteStore(":memory:");
  app = createApp({ store, records: [], clientIp: () => "1.1.1.1", log: () => {}, spaces: { index, store } });
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const get = (path: string, userAgent?: string) =>
  app.request(path, { headers: userAgent ? { "user-agent": userAgent } : {} });

/** Two disks of diameter 1 in a circle of diameter 2. */
const disks = (extra: object = {}) => ({
  N: 0,
  M: 0,
  P: 2,
  pieces: [
    { x: -0.5, y: 0, theta: 0 },
    { x: 0.5, y: 0, theta: 0 },
  ],
  container_phi: 0,
  name: "ann",
  ...extra,
});
const squares = {
  N: 4,
  M: 4,
  P: 2,
  pieces: [
    { x: 0, y: 0, theta: Math.PI / 4 },
    { x: 1, y: 0, theta: Math.PI / 4 },
  ],
  container_phi: 0,
  name: "ann",
};

describe("the units gate", () => {
  it("says conventions version 2 and the units in GET /api/problems", async () => {
    const body = (await (await get("/api/problems/0/0/5")).json()) as { conventions: Record<string, unknown> };
    expect(body.conventions.version).toBe(CONVENTIONS_VERSION);
    expect(CONVENTIONS_VERSION).toBe(2);
    expect(body.conventions.units).toMatch(/diameter 1/);
    expect(body.conventions.score).toMatch(/diameter \(circle\)/);
  });

  it("answers 426 with an explanation to a disk packing without units, and stores nothing", async () => {
    const r = await post("/api/submit", disks());
    expect(r.status).toBe(426);
    const body = (await r.json()) as { valid: boolean; reasons: string[] };
    expect(body.valid).toBe(false);
    expect(body.reasons[0]).toMatch(/"units": "diameter"/);
    expect(body.reasons[0]).toMatch(/diameter 1 \(radius 1\/2\)/);
    expect(body.reasons[0]).toContain(VOLUNTEER_MIN_VERSION);
    expect(await (await get("/api/leaderboard/0/0/2")).json()).toMatchObject({ total: 0 });
  });

  it("accepts it with units, scoring the circle by its diameter, and refuses another value with 400", async () => {
    const r = await post("/api/submit", disks({ units: "diameter" }));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { score: number; leader: boolean };
    expect(body.score).toBeCloseTo(2, 12);
    expect(body.leader).toBe(true);
    for (const units of ["radius", 1, null, "Diameter"]) {
      const bad = await post("/api/submit", disks({ units, name: "bob" }));
      expect(bad.status, String(units)).toBe(400);
    }
  });

  it("also asks for units for a circle container of polygons, and not for polygons in polygons", async () => {
    const hexagons = {
      N: 6,
      M: 0,
      P: 1,
      pieces: [{ x: 0, y: 0, theta: 0 }],
      container_phi: 0,
      name: "ann",
    };
    expect((await post("/api/submit", hexagons)).status).toBe(426);
    expect((await post("/api/submit", { ...hexagons, units: "diameter" })).status).toBe(200);
    expect((await post("/api/submit", squares)).status).toBe(200);
  });

  it("asks for units on the spaces' disk and ball problems only", async () => {
    const disksOnTorus = (extra: object = {}) => ({
      space: "torus",
      id: "torus/sq/0/2",
      config: { lattice: { L: 2 }, poses: [[0, 0, 0], [Math.SQRT2 / 2, Math.SQRT2 / 2, 0]] },
      name: "ann",
      ...extra,
    });
    const missing = await post("/api/spaces/submit", disksOnTorus());
    // the problem may be closed (a proven optimum) before the gate would matter: the gate comes first
    expect(missing.status).toBe(426);
    expect(((await missing.json()) as { reasons: string[] }).reasons[0]).toMatch(/"units": "diameter"/);
    expect((await post("/api/spaces/submit", disksOnTorus({ units: "radius" }))).status).toBe(400);
    const ball = await post("/api/spaces/submit", { space: "balls", id: "balls/ballinball/2", config: { s: 2, pieces: [[0.5, 0, 0], [-0.5, 0, 0]] }, name: "ann" });
    expect(ball.status).toBe(426);
    expect(
      (await post("/api/spaces/submit", { space: "balls", id: "balls/ballinball/2", units: "diameter", config: { s: 2, pieces: [[0.5, 0, 0], [-0.5, 0, 0]] }, name: "ann" })).status,
    ).toBe(200);
    // a polygon problem on a torus is untouched by the unit change
    const polygon = await post("/api/spaces/submit", { space: "torus", id: "torus/sq/4/2", config: { lattice: { L: 1 }, poses: [] }, name: "ann" });
    expect(polygon.status).not.toBe(426);
  });

  it("can be switched off", async () => {
    const store = new SqliteStore(":memory:");
    app = createApp({ store, records: [], clientIp: () => "1.1.1.1", log: () => {}, unitsGate: false });
    expect((await post("/api/submit", disks())).status).toBe(200);
  });
});

describe("old volunteer clients", () => {
  it("reads the version from the User-Agent", () => {
    expect(volunteerVersion("polypack-volunteer/0.1.3")).toEqual([0, 1, 3]);
    expect(volunteerVersion("polypack-volunteer/1.0")).toEqual([1, 0, 0]);
    expect(volunteerVersion("curl/8")).toBeNull();
    expect(isOldVolunteer("polypack-volunteer/0.1.9")).toBe(true);
    expect(isOldVolunteer("polypack-volunteer/0.2.0")).toBe(false);
    expect(isOldVolunteer("polypack-volunteer/0.10.0")).toBe(false);
    expect(isOldVolunteer("polypack-volunteer/1.0.0")).toBe(false);
    expect(isOldVolunteer(undefined)).toBe(false);
  });

  it("get 426 from every route that could mislead them, with the way to upgrade", async () => {
    const old = "polypack-volunteer/0.1.4";
    for (const path of [
      "/api/problems/0/0/5",
      "/api/problems/0/4/5",
      "/api/problems/7/0/5",
      "/api/leaderboard/0/0/5",
      "/api/targets",
      "/api/records?N=0&M=0",
      "/api/spaces/targets",
      "/api/spaces/torus/problems/torus/sq/0/2",
    ]) {
      const r = await get(path, old);
      expect(r.status, path).toBe(426);
      const body = (await r.json()) as { error: string };
      expect(body.error, path).toMatch(/0\.2\.0/);
      expect(body.error, path).toMatch(/diameter 1/);
    }
    const submit = await post("/api/submit", disks({ units: "diameter" }), { "user-agent": old });
    expect(submit.status).toBe(426);
    expect(await (await get("/api/leaderboard/0/0/2")).json()).toMatchObject({ total: 0 });
  });

  it("may still read the index, health, the snapshot and the problems the change did not touch", async () => {
    const old = "polypack-volunteer/0.1.4";
    expect((await get("/api", old)).status).toBe(200);
    expect((await get("/api/health", old)).status).toBe(200);
    expect((await get("/api/problems/4/4/5", old)).status).toBe(200);
    expect((await get("/api/leaderboard/4/4/5", old)).status).toBe(200);
    expect((await get("/api/snapshot", old)).status).toBe(404);
    expect((await get("/api/spaces/torus/problems/torus/sq/4/5", old)).status).not.toBe(426);
    expect(oldClientMayRead("POST", "/api/submit")).toBe(false);
  });

  it("are not hindered once they are 0.2.0, and nor are other clients", async () => {
    for (const ua of ["polypack-volunteer/0.2.0", "polypack-volunteer/0.3.1", "curl/8.4", "Mozilla/5.0"]) {
      expect((await get("/api/problems/0/0/5", ua)).status, ua).toBe(200);
      expect((await get("/api/targets?limit=1", ua)).status, ua).toBe(200);
    }
  });
});
