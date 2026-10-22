/**
 * The single-file bundle, built into a temporary directory outside the repository and run there
 * with plain node: its search threads must come from the same file, and nothing else must be
 * needed. Runs against the in-process fake server only.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBundle } from "../build";
import { type FakeServer, startFakeServer } from "./fake-server";

let dir: string;
let bundle: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pv-bundle-"));
  bundle = await buildBundle(join(dir, "polypack-volunteer.mjs"));
}, 60_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Runs the bundle with node from the temporary directory; resolves with its exit code and output. */
function runBundle(args: string[], onLine?: (line: string, child: ChildProcess) => void) {
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn(process.execPath, [bundle, ...args], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const take = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      for (const line of text.split("\n")) if (line) onLine?.(line, child);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("close", (code) => resolve({ code, output }));
  });
}

const commonArgs = (server: FakeServer, state: string) => [
  "--base",
  server.url,
  "--state",
  state,
  "--cores",
  "2",
  "--priority",
  "normal",
  "--no-battery-pause",
];

describe("the single-file bundle", () => {
  it("prints its help with plain node and no repository", { timeout: 30_000 }, async () => {
    const { code, output } = await runBundle(["--help"]);
    expect(code).toBe(0);
    expect(output).toMatch(/^polypack-volunteer \d+\.\d+\.\d+/);
    expect(output).toContain("--minutes-per-problem");
    expect(readFileSync(bundle, "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
  });

  // Real solver work in the bundle's own threads, for up to 3 s.
  it("searches one problem in a dry run", { timeout: 60_000 }, async () => {
    const { LOOSE_SQUARES } = await import("./fake-server");
    const server = await startFakeServer({ problems: [LOOSE_SQUARES] });
    try {
      const { code, output } = await runBundle([
        ...commonArgs(server, join(dir, "state-dry")),
        "--once",
        "--minutes-per-problem",
        "0.05",
      ]);
      expect(code, output).toBe(0);
      expect(output).toMatch(/Finished N=4 M=4 P=3 .*dry run: would submit/);
      expect(server.submissions).toEqual([]);
    } finally {
      await server.close();
    }
  });

  // Real solver work: a problem that keeps asc busy for its whole 30 s budget, stopped by SIGINT
  // after 2 s. The client must abort the jobs, submit the best so far and exit 0 well within 30 s.
  it("on SIGINT, submits the best so far and exits 0", { timeout: 60_000 }, async () => {
    const server = await startFakeServer({
      problems: [
        {
          N: 5,
          M: 5,
          P: 20,
          // any valid packing is a leader to beat: twenty pentagons in a row
          leader: {
            name: "Someone",
            container_phi: 0,
            pieces: Array.from({ length: 20 }, (_, i) => ({ x: 2 * i, y: 0, theta: 0 })),
          },
        },
      ],
    });
    try {
      let signalled = 0;
      const started = Date.now();
      const { code, output } = await runBundle(
        [...commonArgs(server, join(dir, "state-signal")), "--name", "Signal test", "--minutes-per-problem", "0.5"],
        (line, child) => {
          if (/Searching N=5 M=5 P=20/.test(line) && !signalled++) setTimeout(() => child.kill("SIGINT"), 2000);
        },
      );
      expect(code, output).toBe(0);
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(output).toMatch(/SIGINT: stopping/);
      expect(output).toMatch(/Finished N=5 M=5 P=20 .*\(aborted\).*submitted: HTTP 200, the new leader/);
      expect(server.submissions).toHaveLength(1);
      expect(server.leaderOf(5, 5, 20)!.name).toBe("Signal test");
      const line = JSON.parse(readFileSync(join(dir, "state-signal", "history.jsonl"), "utf8").trim());
      expect(line).toMatchObject({ stopped: "aborted", submitted: true, status: 200 });
    } finally {
      await server.close();
    }
  });
});
