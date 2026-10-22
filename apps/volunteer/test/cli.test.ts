/**
 * End to end: the client's main loop with --once against the in-process fake server, with real
 * worker threads and the engine of src/engine. Nothing here talks to a real server.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MainDeps, main } from "../src/main";
import type { HistoryLine } from "../src/state";
import { SOFTWARE } from "../src/version";
import { type FakeProblem, type FakeServer, LOOSE_SQUARES, scoreOf, startFakeServer } from "./fake-server";

let dir: string;
let server: FakeServer | null = null;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pv-cli-"));
});
afterEach(async () => {
  await server?.close();
  server = null;
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Runs the client in this process; its output is collected instead of printed. Unless `deps`
 * gives a battery check, the battery is not watched.
 */
async function clientWith(argv: string[], deps: MainDeps = {}) {
  const lines: string[] = [];
  const code = await main(
    [
      "--base",
      server!.url,
      "--state",
      join(dir, "state"),
      "--cores",
      "2",
      ...(argv.includes("--minutes-per-problem") ? [] : ["--minutes-per-problem", "0.05"]),
      // a low priority could not be raised again for the rest of the test run
      "--priority",
      "normal",
      ...(deps.checkBattery ? [] : ["--no-battery-pause"]),
      ...argv,
    ],
    { out: (l) => lines.push(l), err: (l) => lines.push(l), signals: false, ...deps },
  );
  return { code, output: lines.join("\n") };
}
const client = (...argv: string[]) => clientWith(argv);

/** A problem that keeps asc busy for its whole budget, with an easy leader to beat. */
const PENTAGONS: FakeProblem = {
  N: 5,
  M: 5,
  P: 20,
  leader: {
    name: "Someone",
    container_phi: 0,
    pieces: Array.from({ length: 20 }, (_, i) => ({ x: 2 * i, y: 0, theta: 0 })),
  },
};

const history = (): HistoryLine[] =>
  readFileSync(join(dir, "state", "history.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

describe("the client, end to end", () => {
  // Real solver work on two threads for up to 3 s of search, plus building the thread bundle.
  it("searches one problem and submits a result that beats the leader", { timeout: 60_000 }, async () => {
    server = await startFakeServer({ problems: [LOOSE_SQUARES], refuseSoftware: true });
    const before = server.leaderOf(4, 4, 3)!;
    expect(before.score).toBeCloseTo(2.5, 9);

    const { code, output } = await client("--once", "--name", "Test volunteer", "--note", "e2e");
    expect(code, output).toBe(0);

    const paths = server.requests.map((r) => `${r.method} ${r.path}`);
    expect(paths).toEqual([
      "GET /api/targets",
      "GET /api/problems/4/4/3",
      `GET /api/submissions/${before.id}`,
      "GET /api/problems/4/4/3", // the leader again, just before submitting
      "POST /api/submit",
      "POST /api/submit", // without `software`, which this server refuses
    ]);
    const [first, second] = server.submissions;
    expect(first.software).toBe(SOFTWARE);
    expect(second).not.toHaveProperty("software");
    expect(second).toMatchObject({
      N: 4,
      M: 4,
      P: 3,
      name: "Test volunteer",
      agent_note: "e2e",
      found_with: "optimizer",
      method: expect.any(String),
      seed: expect.any(Number),
      budget: { time_s: expect.any(Number) },
    });
    const sent = scoreOf(second as never)!;
    expect(sent).toBeLessThan(2.1);
    expect(server.leaderOf(4, 4, 3)!.name).toBe("Test volunteer");

    // the state directory
    const state = join(dir, "state");
    expect(readdirSync(state).sort()).toEqual(["best", "history.jsonl", "memory.json"]); // the lock is gone
    const best = JSON.parse(readFileSync(join(state, "best", "4-4-3.json"), "utf8"));
    expect(best).toMatchObject({ N: 4, M: 4, P: 3, strict: true, method: second.method, seed: second.seed });
    const [line] = history();
    expect(line).toMatchObject({
      N: 4,
      M: 4,
      P: 3,
      leader_before: { id: before.id, score: before.score },
      submitted: true,
      decision: "better than the leader",
      status: 200,
      response: { valid: true, leader: true },
    });
    expect(line.leader_after?.id).toBe(server.leaderOf(4, 4, 3)!.id);
    expect(output).toMatch(/Searching N=4 M=4 P=3/);
    expect(output).toMatch(/sending again without it/);
    expect(output).toMatch(/Finished N=4 M=4 P=3 .*submitted: HTTP 200, the new leader/);
  });

  // Real solver work, as above.
  it("in a dry run, says what it would submit and sends nothing", { timeout: 60_000 }, async () => {
    server = await startFakeServer({ problems: [LOOSE_SQUARES] });
    const { code, output } = await client("--once");
    expect(code, output).toBe(0);
    expect(output).toMatch(/dry run: nothing is submitted, because no --name was given/);
    expect(output).toMatch(/dry run: would submit/);
    expect(server.submissions).toEqual([]);
    expect(history()[0]).toMatchObject({ submitted: false, decision: "dry run: would submit" });
  });

  // Real solver work, as above.
  it("does not submit when the leader is better, and skips the problem next time", { timeout: 60_000 }, async () => {
    // three squares cannot beat side 2; a leader of side 2 cannot be improved
    const optimal = {
      ...LOOSE_SQUARES,
      leader: {
        ...LOOSE_SQUARES.leader!,
        pieces: [
          { x: 0, y: 0, theta: Math.PI / 4 },
          { x: 1, y: 0, theta: Math.PI / 4 },
          { x: 0, y: 1, theta: Math.PI / 4 },
        ],
      },
    };
    server = await startFakeServer({ problems: [optimal] });
    const first = await client("--once", "--name", "Test volunteer");
    expect(first.code, first.output).toBe(0);
    expect(server.submissions).toEqual([]);
    expect(history()[0]).toMatchObject({ submitted: false, decision: "not better than the leader" });

    const second = await client("--once", "--name", "Test volunteer");
    expect(second.code).toBe(0);
    expect(second.output).toMatch(/Nothing to search/);
    expect(history()).toHaveLength(1);
  });

  // Real solver work: the engine on twenty pentagons for 1.8 s of active time, with a 1 s battery
  // pause. How far it gets before the pause depends on the machine, so the lines are matched loosely.
  it("pauses on battery power, without counting the pause, and prints status lines", { timeout: 60_000 }, async () => {
    server = await startFakeServer({ problems: [PENTAGONS] });
    const t0 = Date.now();
    // on battery from 0.8 s to 1.8 s after the start
    const checkBattery = async () => Date.now() - t0 > 800 && Date.now() - t0 < 1800;
    const { code, output } = await clientWith(["--once", "--minutes-per-problem", "0.03"], {
      checkBattery,
      batteryEveryMs: 50,
      statusEveryMs: 300,
    });
    const wall = (Date.now() - t0) / 1000;
    expect(code, output).toBe(0);
    expect(output).toMatch(/On battery power: paused/);
    expect(output).toMatch(/On AC power: resuming/);
    expect(output).toMatch(
      /Status: N=5 M=5 P=20, \d+s of 2s; best .* vs leader \d+\.\d{6}.*; \d+ job\(s\) run; threads 0 busy, 2 paused, 0 idle; 0 submission\(s\) accepted; paused on battery power/,
    );
    expect(output).toMatch(/Status: N=5 M=5 P=20, .*threads 2 busy, 0 paused, 0 idle/);
    const [line] = history();
    // the engine's time excludes the pause: the search took about 1.8 s of active time
    expect(line.active_s).toBeLessThan(wall - 0.7);
    expect(wall).toBeGreaterThan(2.5);
  });

  // Real solver work: the --hours limit (about 1 s) ends a search that would take 60 s.
  it("stops at the --hours limit and submits what it has", { timeout: 60_000 }, async () => {
    server = await startFakeServer({ problems: [PENTAGONS] });
    const t0 = Date.now();
    const { code, output } = await client(
      "--name",
      "Test volunteer",
      "--minutes-per-problem",
      "1",
      "--hours",
      "0.0003",
    );
    expect(code, output).toBe(0);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(output).toMatch(/The --hours limit \(0.0003 h\) is reached: stopping/);
    expect(history()).toHaveLength(1);
    expect(server.submissions).toHaveLength(1);
  });

  it("explains a server without a work list and exits non-zero", { timeout: 30_000 }, async () => {
    server = await startFakeServer({ problems: [LOOSE_SQUARES], noTargets: true });
    const { code, output } = await client("--once", "--name", "Test volunteer");
    expect(code).toBe(1);
    expect(output).toMatch(/GET \/api\/targets answered 404/);
    expect(server.submissions).toEqual([]);
  });

  it("refuses to share its state directory with a running copy", { timeout: 30_000 }, async () => {
    server = await startFakeServer({ problems: [LOOSE_SQUARES] });
    const { StateDir } = await import("../src/state");
    const other = StateDir.open(join(dir, "state"));
    try {
      const { code, output } = await client("--once");
      expect(code).toBe(1);
      expect(output).toMatch(/Another copy of the client is using/);
      expect(server.requests).toEqual([]);
    } finally {
      other.close();
    }
    expect(existsSync(join(dir, "state", "lock"))).toBe(false);
  });

  it("refuses bad options with exit code 2", async () => {
    const lines: string[] = [];
    const code = await main(["--cores", "zero"], { out: (l) => lines.push(l), err: (l) => lines.push(l) });
    expect(code).toBe(2);
    expect(lines.join("\n")).toMatch(/--cores/);
  });
});
