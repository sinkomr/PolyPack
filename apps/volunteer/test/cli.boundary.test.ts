/**
 * End to end, the boundary space ("3D on 4D") in the client's main loop, against the in-process
 * fake server with real worker threads. Nothing here talks to a real server.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/main";
import { checkSpaceConfig } from "../src/spaces/model";
import { type FakeServer, startFakeServer } from "./fake-server";
import { fixture } from "./spaces-fixtures";

let dir: string;
let server: FakeServer | null = null;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pv-boundary-cli-"));
});
afterEach(async () => {
  await server?.close();
  server = null;
  rmSync(dir, { recursive: true, force: true });
});

async function client(argv: string[]) {
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
    { out: (l) => lines.push(l), err: (l) => lines.push(l), signals: false },
  );
  return { code, output: lines.join("\n") };
}

const history = () =>
  readFileSync(join(dir, "state", "history.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
const paths = () => server!.requests.map((r) => `${r.method} ${r.path}`);

describe("the client with --dimensions boundary", () => {
  // Real boundary search: about 3 s on two threads.
  it("searches a 3D on 4D problem and submits a better configuration", { timeout: 60_000 }, async () => {
    const BALLS = fixture("boundary", "boundary/tesseract/ball/9");
    server = await startFakeServer({ problems: [], spaces: [BALLS] });
    const { code, output } = await client(["--once", "--only-dimensions", "--dimensions", "boundary", "--name", "Test volunteer"]);
    expect(code, output).toBe(0);
    expect(paths()).toEqual([
      "GET /api/spaces/targets?spaces=boundary&limit=20000",
      "GET /api/spaces/boundary/problems/boundary/tesseract/ball/9",
      "GET /api/spaces/boundary/problems/boundary/tesseract/ball/9",
      "POST /api/spaces/submit",
    ]);
    const [body] = server.spaceSubmissions;
    expect(body).toMatchObject({ space: "boundary", id: "boundary/tesseract/ball/9", method: "boundary compression search" });
    const check = checkSpaceConfig("boundary", "boundary/tesseract/ball/9", body.config);
    expect(check.valid).toBe(true);
    expect(check.score!).toBeLessThan(BALLS.certified!.score * (1 - 1e-9));
    expect(history()[0]).toMatchObject({ space: "boundary", id: "boundary/tesseract/ball/9", P: 9, submitted: true });
    expect(output).toMatch(/Searches only problems of the new spaces: boundary/);
  });

  it("stops a problem whose best is at the search's floor after its first job", { timeout: 60_000 }, async () => {
    const CUBES = fixture("boundary", "boundary/tesseract/cube/4", 1);
    server = await startFakeServer({ problems: [], spaces: [CUBES] });
    const { code, output } = await client(["--once", "--only-dimensions", "--dimensions", "boundary", "--name", "Test volunteer"]);
    expect(code, output).toBe(0);
    expect(server.spaceSubmissions).toEqual([]);
    // one job per lane (two), then no more
    const [line] = history();
    expect(line).toMatchObject({ id: "boundary/tesseract/cube/4", stopped: "bound", submitted: false });
    expect(line.jobs).toBeLessThanOrEqual(2);
  });
});
