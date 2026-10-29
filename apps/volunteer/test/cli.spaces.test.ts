/**
 * End to end, the optional spaces mode: the client's main loop against the in-process fake
 * server with its spaces endpoints, with real worker threads. Nothing here talks to a real server.
 *
 * Space problems run the real space engine for 3 s of search; the fixtures are research records
 * made 1 % worse with the same poses, which the first job's tight-size step already beats, so the
 * outcome does not depend on the machine's speed. The nofold problem runs a one-job stand-in for
 * the polygon engine, as test/cli.test.ts does.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MainDeps, main } from "../src/main";
import type { searchSpaceProblem } from "../src/spaces/engine";
import { checkSpaceConfig, parseSpaceId } from "../src/spaces/model";
import type { Job, SearchProblem } from "../src/types";
import { SOFTWARE } from "../src/version";
import { type FakeServer, LOOSE_SQUARES, startFakeServer } from "./fake-server";
import { enlarged, fixture, recordConfig } from "./spaces-fixtures";

let dir: string;
let server: FakeServer | null = null;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pv-spaces-cli-"));
});
afterEach(async () => {
  await server?.close();
  server = null;
  rmSync(dir, { recursive: true, force: true });
});

/** One evaluation-capped asc job through the real pool (the polygon engine's stand-in). */
const oneJob: SearchProblem = async (input, runJob, control) => {
  const job: Job = {
    problem: input.problem,
    method: "asc",
    seed: 1,
    budget: { time_s: 300, evals: 20_000 },
    kind: "fresh",
  };
  const r = await runJob(job, control);
  const best =
    r.valid && r.strict && r.best && r.score !== null
      ? { config: r.best, score: r.score, strict: true, job, params: r.params }
      : null;
  input.onResult?.(r, best);
  return { best, jobs: 1, stopped: control.aborted ? "aborted" : "time", memory: input.memory ?? null };
};

async function client(argv: string[], deps: MainDeps = {}) {
  const lines: string[] = [];
  const code = await main(
    [
      "--base",
      server!.url,
      "--state",
      join(dir, "state"),
      "--cores",
      "2",
      "--minutes-per-problem",
      "0.05",
      "--priority",
      "normal",
      "--no-battery-pause",
      ...argv,
    ],
    {
      out: (l) => lines.push(l),
      err: (l) => lines.push(l),
      signals: false,
      searchProblem: oneJob,
      kinds: server!.kinds(),
      ...deps,
    },
  );
  return { code, output: lines.join("\n") };
}

const history = () =>
  readFileSync(join(dir, "state", "history.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
const paths = () => server!.requests.map((r) => `${r.method} ${r.path}`);

const SPHERE = fixture("sphere", "sphere/3/13");

describe("the client with the spaces option", () => {
  // Real solver work: the polygon stand-in's one job.
  it("never asks for the spaces without --spaces", { timeout: 60_000 }, async () => {
    server = await startFakeServer({ problems: [LOOSE_SQUARES], spaces: [SPHERE] });
    const { code, output } = await client(["--once", "--name", "Test volunteer"]);
    expect(code, output).toBe(0);
    expect(paths().filter((p) => p.includes("/api/spaces"))).toEqual([]);
    expect(server.spaceSubmissions).toEqual([]);
    expect(server.submissions).toHaveLength(1);
    expect(existsSync(join(dir, "state", "best", "spaces"))).toBe(false);
    expect(output).not.toMatch(/new spaces|--spaces/);
  });

  // Real space search: about 3 s on two threads.
  // Real space search with a generic method: about 3 s on two threads.
  it(
    "runs --space-method with --space-params, names them in the log, the entry, the best file and the history",
    { timeout: 60_000 },
    async () => {
      server = await startFakeServer({ problems: [], spaces: [SPHERE] });
      const { code, output } = await client([
        "--once",
        "--only-spaces",
        "--spaces",
        "sphere",
        "--name",
        "Test volunteer",
        "--space-method",
        "penalty",
        "--space-params",
        '{"seedShare": 0.25}',
      ]);
      expect(code, output).toBe(0);
      expect(output).toContain('method sphere penalty {"seedShare":0.25}; up to');
      const [body] = server.spaceSubmissions;
      expect(body).toMatchObject({ space: "sphere", id: "sphere/3/13", method: 'sphere penalty {"seedShare":0.25}' });
      expect(checkSpaceConfig("sphere", "sphere/3/13", body.config).valid).toBe(true);
      const kept = JSON.parse(readFileSync(join(dir, "state", "best", "spaces", "sphere_3_13.json"), "utf8"));
      expect(kept).toMatchObject({ method: "sphere penalty", params: { seedShare: 0.25 } });
      expect(history()[0].best).toMatchObject({ method: "sphere penalty", params: { seedShare: 0.25 } });
    },
  );

  // A nofold problem's one stand-in job, and about 3 s of the boundary search.
  it(
    "says when nofold problems ignore the method, and when a problem does not offer it",
    { timeout: 60_000 },
    async () => {
      server = await startFakeServer({ problems: [], spaces: [fixture("surface", "surface/cube/nofold/4/7", 1.05)] });
      const nofold = await client(["--once", "--only-spaces", "--spaces", "surface", "--space-method", "penalty"]);
      expect(nofold.output).toContain("method the polygon engine's methods");
      expect(nofold.output).toContain(
        "--space-method penalty does not apply here: nofold problems run the polygon engine's own methods",
      );
      await server.close();
      // cubes have no soft shapes, which harden needs
      server = await startFakeServer({ problems: [], spaces: [fixture("boundary", "boundary/tesseract/cube/4", 1)] });
      const cubes = await client(["--once", "--only-spaces", "--spaces", "boundary", "--space-method", "harden"]);
      expect(cubes.output).toContain("method boundary compression search; up to");
      expect(cubes.output).toMatch(
        /boundary\/tesseract\/cube\/4 does not offer harden \(harden needs a kernel capability \(shape\).*\), so it runs auto/,
      );
    },
  );

  it("searches a sphere problem and submits a better configuration", { timeout: 60_000 }, async () => {
    server = await startFakeServer({ problems: [], spaces: [SPHERE] });
    const { code, output } = await client([
      "--once",
      "--only-spaces",
      "--spaces",
      "sphere",
      "--name",
      "Test volunteer",
      "--note",
      "e2e",
    ]);
    expect(code, output).toBe(0);
    expect(paths()).toEqual([
      "GET /api/spaces/sphere/problems/sphere/3/13",
      "GET /api/spaces/sphere/problems/sphere/3/13", // the best again, just before submitting
      "POST /api/spaces/submit",
    ]);
    const [body] = server.spaceSubmissions;
    expect(body).toMatchObject({
      space: "sphere",
      id: "sphere/3/13",
      name: "Test volunteer",
      agent_note: "e2e",
      software: SOFTWARE,
      method: "sphere basin hopping",
    });
    expect(Number.isSafeInteger(body.seed)).toBe(true);
    const check = checkSpaceConfig(parseSpaceId("sphere/3/13")!.space, "sphere/3/13", body.config);
    expect(check.valid).toBe(true);
    expect(check.score!).toBeLessThan(SPHERE.certified!.score * (1 - 1e-9));
    expect(server.spaceBest("sphere/3/13")!.site!.name).toBe("Test volunteer");

    const state = join(dir, "state");
    expect(readdirSync(state).sort()).toEqual(["best", "history.jsonl", "memory.json", "state.json"]);
    const kept = JSON.parse(readFileSync(join(state, "best", "spaces", "sphere_3_13.json"), "utf8"));
    expect(kept).toMatchObject({ space: "sphere", id: "sphere/3/13", P: 13, method: "sphere basin hopping" });
    const [line] = history();
    expect(line).toMatchObject({
      space: "sphere",
      id: "sphere/3/13",
      P: 13,
      leader_before: { id: null, source: "certified", score: SPHERE.certified!.score },
      leader_after: { source: "site", name: "Test volunteer" },
      submitted: true,
      dry_run: false,
      decision: "better than the problem's best",
      status: 200,
      response: { valid: true, leader: true, beats_certified: true },
    });
    expect(line).not.toHaveProperty("M");
    expect(output).toMatch(/Searches only problems of these kinds: sphere \(--dimensions\)/);
    expect(output).toMatch(/Searching sphere\/3\/13: .*starting from the research record/);
    expect(output).toMatch(
      /Finished sphere\/3\/13 .*submitted: HTTP 200, the new leader of the site's entries \(#\d+\), below the research record/,
    );

    // the problem now has this machine's entry as its best; with no other problem it is searched again
    const again = await client(["--once", "--only-spaces", "--spaces", "sphere", "--name", "Test volunteer"]);
    expect(again.code, again.output).toBe(0);
    expect(again.output).toMatch(/Searching sphere\/3\/13: best /);
    expect(history()).toHaveLength(2);
  });

  // Real space search, as above.
  it(
    "in a dry run over flat and space problems, says what it would submit and sends nothing",
    { timeout: 60_000 },
    async () => {
      server = await startFakeServer({ problems: [LOOSE_SQUARES], spaces: [fixture("torus", "torus/sq/0/7")] });
      // one flat problem and one torus problem: 0.9 draws the torus one
      const { code, output } = await client(["--once", "--spaces", "all", "--max-P", "10"], { random: () => 0.9 });
      expect(code, output).toBe(0);
      expect(paths()[0]).toBe("GET /api/spaces/torus/problems/torus/sq/0/7");
      expect(server.spaceSubmissions).toEqual([]);
      expect(server.submissions).toEqual([]);
      expect(history()[0]).toMatchObject({
        space: "torus",
        id: "torus/sq/0/7",
        submitted: false,
        dry_run: true,
        decision: "dry run: would submit",
      });
      expect(output).toMatch(
        /Also searches problems of these kinds: surface, curved, sphere, torus, boundary, polyhedra, balls \(--dimensions\)/,
      );
      // the dry run's best is kept for a real run
      expect(existsSync(join(dir, "state", "best", "spaces", "torus_sq_0_7.json"))).toBe(true);

      // 0.1: the flat one
      const polygon = await client(["--once", "--spaces", "all"], { random: () => 0.1 });
      expect(polygon.code, polygon.output).toBe(0);
      expect(polygon.output).toMatch(/Searching N=4 M=4 P=3/);
    },
  );

  // Real solver work: the stand-in's one asc job on two squares in a square face.
  it("searches a nofold surface problem as a planar packing of one face", { timeout: 60_000 }, async () => {
    const NOFOLD = fixture("surface", "surface/cube/nofold/4/7", 1.05);
    server = await startFakeServer({ problems: [], spaces: [NOFOLD] });
    const { code, output } = await client([
      "--once",
      "--only-spaces",
      "--spaces",
      "surface",
      "--name",
      "Test volunteer",
    ]);
    expect(code, output).toBe(0);
    expect(output).toMatch(/as a planar packing of one face/);
    const [body] = server.spaceSubmissions;
    expect(body).toMatchObject({
      space: "surface",
      id: "surface/cube/nofold/4/7",
      method: "nofold face packing: asc",
      seed: 1,
    });
    const check = checkSpaceConfig(
      parseSpaceId("surface/cube/nofold/4/7")!.space,
      "surface/cube/nofold/4/7",
      body.config,
    );
    expect(check.valid).toBe(true);
    expect(check.score!).toBeLessThan(NOFOLD.certified!.score * (1 - 1e-9));
  });

  // Real space search, as above.
  for (const [status, reason] of [
    [422, "pieces 2 and 5 overlap"],
    [409, "this problem is closed"],
  ] as const) {
    it(`reports a ${status} with the server's reasons`, { timeout: 60_000 }, async () => {
      server = await startFakeServer({
        problems: [],
        spaces: [SPHERE],
        afterSpaceSubmit: () => ({ status, body: { valid: false, reasons: [reason] } }),
      });
      const { code, output } = await client([
        "--once",
        "--only-spaces",
        "--spaces",
        "sphere",
        "--name",
        "Test volunteer",
      ]);
      expect(code, output).toBe(0);
      expect(output).toMatch(new RegExp(`refused: HTTP ${status}: ${reason}`));
      expect(history()[0]).toMatchObject({ submitted: true, status, response: { valid: false, reasons: [reason] } });
      expect(server.spaceSubmissions).toHaveLength(1);
    });
  }

  // Real space search from a new arrangement: a problem without a research record (status no_record).
  it(
    "searches a problem without a research record from a new arrangement and submits it",
    { timeout: 60_000 },
    async () => {
      server = await startFakeServer({ problems: [], spaces: [{ id: "sphere/0/5", certified: null, bound: 0.6 }] });
      const { code, output } = await client([
        "--once",
        "--only-spaces",
        "--spaces",
        "sphere",
        "--name",
        "Test volunteer",
      ]);
      expect(code, output).toBe(0);
      expect(paths()).toEqual([
        "GET /api/spaces/sphere/problems/sphere/0/5",
        "GET /api/spaces/sphere/problems/sphere/0/5",
        "POST /api/spaces/submit",
      ]);
      const [body] = server.spaceSubmissions;
      expect(body).toMatchObject({ space: "sphere", id: "sphere/0/5", name: "Test volunteer" });
      // the server's rule for such a problem: strictly valid
      expect(checkSpaceConfig("sphere", "sphere/0/5", body.config, { noRecord: true }).valid).toBe(true);
      expect(server.spaceBest("sphere/0/5")!.site!.name).toBe("Test volunteer");
      const [line] = history();
      expect(line).toMatchObject({ space: "sphere", id: "sphere/0/5", leader_before: null });
    },
  );

  // Real space search, as above.
  it("does not send again when a 503 came but the configuration was stored", { timeout: 60_000 }, async () => {
    server = await startFakeServer({
      problems: [],
      spaces: [SPHERE],
      afterSpaceSubmit: (n) => (n === 0 ? { status: 503, body: { error: "busy" } } : undefined),
    });
    const { code, output } = await client([
      "--once",
      "--only-spaces",
      "--spaces",
      "sphere",
      "--name",
      "Test volunteer",
    ]);
    expect(code, output).toBe(0);
    expect(server.spaceSubmissions).toHaveLength(1);
    expect(output).toMatch(/no answer came \(HTTP 503 .*\), but the problem now shows it as the site's leader/);
    // review D4: it beat the research record by 1 %, which the history says although the answer was lost
    expect(history()[0]).toMatchObject({
      submitted: true,
      status: null,
      response: { valid: true, leader: true, beats_certified: true },
    });
  });

  // Review D3. A stand-in engine that finds nothing: what is offered comes from best/spaces.
  it("does not offer a kept configuration that the server's strict rule refuses", { timeout: 60_000 }, async () => {
    const id = "sphere/3/8";
    const record = recordConfig("sphere", id);
    const certified = checkSpaceConfig("sphere", id, record).score!;
    // 2e-9 smaller: valid at the tolerance 1e-9, not at the strict 1e-11 that beating the record needs
    const shrunk = enlarged("sphere", record, 1 - 2e-9);
    expect(checkSpaceConfig("sphere", id, shrunk).valid).toBe(true);
    expect(checkSpaceConfig("sphere", id, shrunk, { certified }).valid).toBe(false);
    server = await startFakeServer({ problems: [], spaces: [{ id, certified: { score: certified, config: record } }] });
    mkdirSync(join(dir, "state", "best", "spaces"), { recursive: true });
    const kept = {
      space: "sphere",
      id,
      P: 8,
      score: shrunk.rho,
      method: "sphere basin hopping",
      seed: 1,
      budget: { time_s: 1 },
      kind: "iterate",
      found_at: "2026-10-24T00:00:00.000Z",
      version: "test",
      config: shrunk,
    };
    writeFileSync(join(dir, "state", "best", "spaces", "sphere_3_8.json"), JSON.stringify(kept));
    const none: typeof searchSpaceProblem = async () => ({ best: null, jobs: 0, stopped: "time" });
    for (let visit = 0; visit < 2; visit++) {
      const { code, output } = await client(
        ["--once", "--only-spaces", "--spaces", "sphere", "--name", "Test volunteer"],
        {
          searchSpace: none,
          // the second visit comes 8 days later, past the 7-day skip
          now: () => Date.now() + visit * 8 * 86_400_000,
        },
      );
      expect(code, output).toBe(0);
      expect(output).toMatch(/sphere_3_8\.json does not pass the check now; it is not offered/);
      expect(output).toMatch(/Finished sphere\/3\/8 .*no valid configuration; nothing to submit/);
    }
    expect(server.spaceSubmissions).toEqual([]);
  });

  // Review D5. Real space search, as above.
  it("waits a minute after 20 problems in a row that the server does not know", { timeout: 60_000 }, async () => {
    server = await startFakeServer({ problems: [], noSpaces: true });
    // a fake clock that sleeps at once: the minute's wait ends the run at its --hours limit (36 s)
    let offset = 0;
    const { code, output } = await client(["--only-spaces", "--spaces", "sphere", "--name", "Test volunteer", "--hours", "0.01"], {
      // the real draw, over sphere's 9,900 problems, none of which this server knows
      kinds: undefined,
      now: () => Date.now() + offset,
      sleep: async (ms, signal) => {
        if (signal?.aborted) throw new Error("aborted");
        offset += ms;
      },
    });
    expect(code, output).toBe(0);
    expect(output).toMatch(/20 problems in a row were closed or unknown to the server; drawing again in 1m00s/);
    expect(server.requests).toHaveLength(20);
    expect(server.spaceSubmissions).toEqual([]);
  });

  it("skips for good a problem the server does not know", { timeout: 60_000 }, async () => {
    server = await startFakeServer({ problems: [], spaces: [SPHERE], noSpaces: true });
    const { code, output } = await client([
      "--once",
      "--only-spaces",
      "--spaces",
      "sphere",
      "--name",
      "Test volunteer",
    ]);
    // skipped, and then there is nothing else to draw
    expect(code, output).toBe(0);
    expect(output).toMatch(/Could not read sphere\/3\/13 \(HTTP 404: not found\); skipping it$/m);
    expect(output).toMatch(/Nothing to search: every problem drawn was closed/);
    expect(server.requests).toHaveLength(1);
    expect(server.spaceSubmissions).toEqual([]);
  });
});
