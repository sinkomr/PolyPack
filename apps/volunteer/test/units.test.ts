import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Api } from "../src/http";
import { main } from "../src/main";
import { StateDir, bestFileOf } from "../src/state";
import { migrateStateUnits } from "../src/state-units";
import { planarFactors, spaceScoreFactor } from "../src/units";
import { STATE_VERSION, UNITS, VERSION } from "../src/version";
import { spacePlan } from "../../server/src/units-migration";
import { startFakeServer, type FakeServer } from "./fake-server";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pv-units-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const A = 0.1 + 0.2;
const B = 1 / 3;
const write = (path: string, value: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
};
const read = (...parts: string[]) => JSON.parse(readFileSync(join(dir, ...parts), "utf8"));

const bestOld = (N: number, M: number, P: number, score: number) => ({
  N,
  M,
  P,
  score,
  strict: true,
  method: "harden",
  seed: 1,
  budget: { time_s: 10 },
  kind: "fresh",
  found_at: "2026-10-20T00:00:00Z",
  version: "0.1.0",
  config: {
    N,
    M,
    P,
    container_phi: 0.25,
    pieces: Array.from({ length: P }, (_, i) => ({ x: A * (i + 1), y: B * i, theta: 0.7 * i })),
  },
});

describe("the client's units", () => {
  it("is version 0.3.1, sends units and works with the state it writes", () => {
    expect(VERSION).toBe("0.3.1");
    expect(UNITS).toBe("diameter");
    expect(STATE_VERSION).toBe(2);
  });

  it("classifies the flat problems and the spaces' problems as the server does", () => {
    expect(planarFactors(0, 0)).toEqual({ len: 0.5, score: 1 });
    expect(planarFactors(0, 5)).toEqual({ len: 0.5, score: 0.5 });
    expect(planarFactors(7, 0)).toEqual({ len: 1, score: 2 });
    expect(planarFactors(7, 3)).toBeNull();
    const ids = [
      "surface/cube/fold/0/3",
      "surface/cube/fold/4/3",
      "sphere/0/3",
      "sphere/5/3",
      "torus/sq/0/2",
      "torus/hex/6/2",
      "boundary/tesseract/ball/3",
      "boundary/tesseract/cube/3",
      "balls/ballinball/3",
      "balls/ballincub/3",
      "balls/cubinball/3",
      "balls/tetinball/3",
      "curved/0/0/0/2",
      "curved/0/0/4/2",
      "curved/1/0/0/2",
      "curved/-1/0/4/2",
      "curved/-1/3/0/2",
      "curved/1/3/4/2",
      "curved/-1e-06/0/0/2",
      "polyhedra/cubincub/8",
    ];
    for (const id of ids) {
      const space = id.split("/")[0];
      const mine = spaceScoreFactor(space, id);
      const server = spacePlan(space, id);
      if (server === null) expect(mine, id).toBeNull();
      else if (server === "archive") expect(mine, id).toBe("set-aside");
      else expect(mine, id).toBe(server.score);
    }
  });

  it("answers 426 by stopping with the way to upgrade, without sending anything", async () => {
    let server: FakeServer | null = await startFakeServer({
      problems: [],
      upgradeRequired: "Disk and ball pieces now have diameter 1.",
    });
    try {
      const lines: string[] = [];
      const code = await main(["--base", server.url, "--state", join(dir, "state"), "--once", "--name", "x", "--cores", "1", "--no-battery-pause"], {
        out: (l) => lines.push(l),
        err: (l) => lines.push(l),
        signals: false,
      });
      expect(code).toBe(1);
      const text = lines.join("\n");
      expect(text).toMatch(/out of date: Disk and ball pieces now have diameter 1\./);
      expect(text).toContain("polypack.fly.dev/volunteer.html");
      expect(server.submissions).toHaveLength(0);
    } finally {
      await server.close();
      server = null;
    }
  });

  it("reports a 426 from the server once through the callback and returns the answer", async () => {
    const seen: string[] = [];
    const api = new Api("http://x", {
      fetch: async () => new Response(JSON.stringify({ error: "update" }), { status: 426 }),
      onUpgradeRequired: (m) => seen.push(m),
    });
    expect((await api.get("/api/problems/4/4/3"))?.status).toBe(426);
    expect((await api.get("/api/problems/4/4/3"))?.status).toBe(426);
    expect(seen).toEqual(["update"]);
  });
});

describe("a state directory from before the unit change", () => {
  it("converts saved packings exactly, sets aside what it cannot convert, and marks the directory", () => {
    write(join(dir, "best", "0-0-3.json"), bestOld(0, 0, 3, 5 + A));
    write(join(dir, "best", "0-6-3.json"), bestOld(0, 6, 3, 7 + B));
    write(join(dir, "best", "5-0-3.json"), bestOld(5, 0, 3, 4 + A));
    write(join(dir, "best", "4-4-3.json"), bestOld(4, 4, 3, 3 + B));
    write(join(dir, "best", "0-9-3.json"), "{not json");
    write(join(dir, "best", "spaces", "torus_sq_0_2.json"), {
      space: "torus", id: "torus/sq/0/2", P: 2, score: 4, method: "m", seed: 1, budget: { time_s: 1 }, kind: "fresh",
      found_at: "x", version: "0.1.0", config: { lattice: { L: 4 }, poses: [[0, 0, 0], [A, B, 1]] },
    });
    write(join(dir, "best", "spaces", "curved_1_0_0_2.json"), {
      space: "curved", id: "curved/1/0/0/2", P: 2, score: 2, method: "m", seed: 1, budget: { time_s: 1 }, kind: "fresh",
      found_at: "x", version: "0.1.0", config: { size: 2, pieces: [{ x: 0, y: 0, theta: 0 }] },
    });
    write(join(dir, "best", "spaces", "balls_cubinball_2.json"), {
      space: "balls", id: "balls/cubinball/2", P: 2, score: 1.4, method: "m", seed: 1, budget: { time_s: 1 }, kind: "fresh",
      found_at: "x", version: "0.1.0", config: { s: 1.4, pieces: [[0.6, 0, 0, 1, 0, 0, 0]] },
    });
    write(join(dir, "best", "spaces", "sphere_5_3.json"), {
      space: "sphere", id: "sphere/5/3", P: 3, score: 1.5, method: "m", seed: 1, budget: { time_s: 1 }, kind: "fresh",
      found_at: "x", version: "0.1.0", config: { rho: 1.5, pieces: [] },
    });
    const line = (o: object) => JSON.stringify(o) + "\n";
    write(
      join(dir, "history.jsonl"),
      line({ N: 0, M: 6, P: 3, leader_before: { id: 1, score: 8 }, leader_after: { id: 2, score: 6 }, best: { score: 6 }, response: { score: 6, leader_score: 6 } }) +
        line({ N: 4, M: 4, P: 3, leader_before: { id: 1, score: 8 } }) +
        line({ space: "sphere", id: "sphere/0/3", P: 3, bound: 2, leader_before: { id: null, score: 3 }, best: { score: 2.5 }, response: { score: 2.5, best_score: 2.5 } }) +
        "{cut short",
    );
    write(join(dir, "memory.json"), { version: 1, used: 3, families: {} });

    const logs: string[] = [];
    const report = migrateStateUnits(dir, (m) => logs.push(m));
    expect(report).toMatchObject({ already: false, convertedBest: 3, convertedSpaceBest: 2, setAside: 2, historyLines: 2 });
    expect(logs[0]).toMatch(/converted/);

    const disks = read("best", "0-0-3.json");
    expect(disks.score).toBe(5 + A); // disks in a circle: the diameter is the old radius
    expect(disks.config.pieces).toEqual(bestOld(0, 0, 3, 0).config.pieces.map((p) => ({ ...p, x: p.x / 2, y: p.y / 2 })));
    expect(disks.config.container_phi).toBe(0.25);
    expect(disks.units).toBe("diameter");
    expect(read("best", "0-6-3.json").score).toBe((7 + B) / 2);
    const polygons = read("best", "5-0-3.json");
    expect(polygons.score).toBe(2 * (4 + A));
    expect(polygons.config.pieces).toEqual(bestOld(5, 0, 3, 0).config.pieces);
    expect(read("best", "4-4-3.json")).toEqual(bestOld(4, 4, 3, 3 + B));
    expect(read("best", "spaces", "torus_sq_0_2.json")).toMatchObject({
      score: 2,
      units: "diameter",
      config: { lattice: { L: 2 }, poses: [[0, 0, 0], [A / 2, B / 2, 1]] },
    });
    expect(read("best", "spaces", "balls_cubinball_2.json")).toMatchObject({ score: 2.8, config: { s: 2.8 } });
    expect(read("best", "spaces", "sphere_5_3.json").score).toBe(1.5);
    // set aside, not deleted: the curved disks at K = 1, and the file that was not JSON
    expect(readdirSync(join(dir, "best-old-units", "spaces"))).toEqual(["curved_1_0_0_2.json"]);
    expect(readdirSync(join(dir, "best-old-units")).sort()).toEqual(["0-9-3.json", "spaces"]);
    expect(readdirSync(join(dir, "best", "spaces")).sort()).toEqual(["balls_cubinball_2.json", "sphere_5_3.json", "torus_sq_0_2.json"]);

    const history = readFileSync(join(dir, "history.jsonl"), "utf8").split("\n");
    expect(JSON.parse(history[0])).toMatchObject({ leader_before: { score: 4 }, leader_after: { score: 3 }, best: { score: 3 }, response: { score: 3, leader_score: 3 } });
    expect(JSON.parse(history[1])).toEqual({ N: 4, M: 4, P: 3, leader_before: { id: 1, score: 8 } });
    expect(JSON.parse(history[2])).toMatchObject({ bound: 1, leader_before: { score: 1.5 }, best: { score: 1.25 }, response: { score: 1.25, best_score: 1.25 } });
    expect(history[3]).toBe("{cut short");
    expect(read("memory.json")).toEqual({ version: 1, used: 3, families: {} });
    expect(read("state.json")).toEqual({ state_version: 2, units: "diameter" });

    // done once: a second start changes nothing
    const again = migrateStateUnits(dir);
    expect(again.already).toBe(true);
    expect(read("best", "0-6-3.json").score).toBe((7 + B) / 2);
  });

  it("is converted by StateDir.open, and a new directory is only marked", () => {
    write(join(dir, "old", "best", "0-4-2.json"), bestOld(0, 4, 2, 6));
    const logs: string[] = [];
    const state = StateDir.open(join(dir, "old"), { log: (m) => logs.push(m) });
    state.close();
    expect(JSON.parse(readFileSync(join(dir, "old", "best", "0-4-2.json"), "utf8")).score).toBe(3);
    expect(logs).toHaveLength(1);

    const fresh = StateDir.open(join(dir, "new"), { log: (m) => logs.push(m) });
    fresh.close();
    expect(read("new", "state.json")).toEqual({ state_version: 2, units: "diameter" });
    expect(logs).toHaveLength(1);
  });

  it("writes new best files with their units", () => {
    const f = bestFileOf(
      { config: bestOld(0, 4, 2, 3).config as never, score: 3, strict: true, job: { problem: { N: 0, M: 4, P: 2 }, method: "m", seed: 1, budget: { time_s: 1 }, kind: "fresh" } },
      VERSION,
    );
    expect(f.units).toBe("diameter");
  });
});
