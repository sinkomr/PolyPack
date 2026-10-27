import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { type PackingConfig, type Pose, evaluate, findFreeSpot } from "@polypack/geometry";
import { describe, expect, it } from "vitest";
import { createApp } from "../../server/src/app";
import { SqliteStore } from "../../server/src/sqlite-store";
import { Board } from "../src/board";
import { orientBoard, submissionBody } from "../src/tighter/submission";

// The server scores a submission at the container_phi it is sent and does not search for a better
// orientation (decided 2026-10-21). Every client of ours turns the container to its best
// orientation first, with the same geometry code, so that nothing is lost. These tests find every
// place that sends a board and check that it does.

const ROOT = resolve(import.meta.dirname, "../../..");
const source = (path: string) => readFileSync(resolve(ROOT, path), "utf8");

function files(dir: string): string[] {
  return readdirSync(resolve(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory()) return e.name === "test" || e.name === "node_modules" ? [] : files(path);
    return /\.(ts|mts|py)$/.test(e.name) ? [path] : [];
  });
}

/** The part of `text` from `start` to the first `end` after it. */
function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  const to = text.indexOf(end, from + start.length);
  expect(to).toBeGreaterThan(from);
  return text.slice(from, to);
}

function server() {
  return createApp({ store: new SqliteStore(":memory:"), records: [], log: () => {}, limits: { perIp: 1e9 } });
}
async function scoreOnServer(app: ReturnType<typeof createApp>, body: object): Promise<number> {
  const r = await app.request("/api/submit", { method: "POST", body: JSON.stringify(body) });
  const answer = (await r.json()) as { score: number };
  expect(r.status).toBe(200);
  return answer.score;
}

/** P pieces placed by findFreeSpot, with the container turned away from its best orientation. */
function compact(N: number, M: number, P: number, phi: number): PackingConfig {
  const pieces: Pose[] = [];
  for (let i = 0; i < P; i++) pieces.push(findFreeSpot(N, pieces, 0, 0));
  return { N, M, P, pieces, container_phi: phi };
}

describe("every path that sends a board to POST /api/submit", () => {
  it("is one of the known ones", () => {
    // a request to the submit route, in a string the code sends: "/api/submit" or `${base}/api/submit`
    const sends = /["'`](?:\$\{[^}]+\})?\/api\/submit["'`]/;
    const senders = ["apps/web/src", "packages/geometry/src", "packages/solver/src", "scripts", "examples"]
      .flatMap(files)
      .filter((f) => sends.test(source(f)))
      .sort();
    expect(senders).toEqual([
      "apps/web/src/api.ts",
      "examples/solve-and-submit.ts",
      "examples/submit.py",
      "scripts/batch-search.ts",
      "scripts/trim-down.ts",
    ]);
    // and in the site, api.ts's two functions are called from the board and from Tighter only
    const callers = files("apps/web/src")
      .filter((f) => /\bapi\.(submit|postSubmission)\(/.test(source(f)))
      .sort();
    expect(callers).toEqual(["apps/web/src/main.ts", "apps/web/src/tighter/main.ts"]);
  });

  it("on the board turns the container first, and the server then scores what the board shows", async () => {
    const handler = between(source("apps/web/src/main.ts"), '$("submit").addEventListener', "\n});\n");
    // the turn joins the latest undo step (false), so Undo after Submit undoes the last edit
    expect(handler.indexOf("board.autoOrient(false)")).toBeGreaterThan(0);
    expect(handler.indexOf("board.autoOrient(false)")).toBeLessThan(handler.indexOf("api.submit("));
    expect(handler).toContain("...board.toConfig(),");

    const app = server();
    const board = new Board();
    expect(board.load(compact(7, 9, 12, 0.4), false)).toBeNull();
    const shown = board.container!.size;
    const undoable = board.canUndo;
    expect(board.autoOrient(false)).toBe(true);
    expect(board.canUndo).toBe(undoable);
    expect(board.container!.size).toBeLessThan(shown);
    expect(board.container!.size).toBe(evaluate(board.toConfig(), { autoOrient: true }).score);
    // nothing better is left to find, and the server's score is the board's, to the bit
    expect(board.autoOrient()).toBe(false);
    expect(await scoreOnServer(app, { ...board.toConfig(), name: "board" })).toBe(board.container!.size);
  });

  it("in Tighter turns the container before every send, and the server then scores the board's best", async () => {
    const send = between(source("apps/web/src/tighter/main.ts"), "async function submit(p: ProblemState)", "\n}\n");
    expect(send.indexOf("orient(p);")).toBeGreaterThan(0);
    expect(send.indexOf("orient(p);")).toBeLessThan(send.indexOf("api.postSubmission("));
    // what goes is the board as orient left it, and its score is the one compared with the leader
    expect(send.indexOf("orient(p);")).toBeLessThan(send.indexOf("structuredClone(p.board!)"));
    expect(send.indexOf("orient(p);")).toBeLessThan(send.indexOf("const best = p.best!"));
    expect(between(source("apps/web/src/tighter/main.ts"), "function orient(p: ProblemState)", "\n}\n")).toContain(
      "orientBoard(current, p.best)",
    );

    const app = server();
    const board = compact(24, 30, 40, 0.3);
    const best = evaluate(board).score!;
    const turned = orientBoard(board, best)!;
    expect(turned.score).toBeLessThan(best);
    expect(orientBoard(turned.board, turned.score)).toBeNull();
    const run = { method: "mc_compress", params: {}, seed: 1, budget: { evals: 100 } };
    expect(await scoreOnServer(app, submissionBody(turned.board, "Tighter", run))).toBe(turned.score);
  });

  it("from the solver, the examples and the scripts sends results that are oriented already", () => {
    // run() ends with an orientation search of its best (packages/solver/test/review.test.ts sends
    // results to the server and gets exactly their scores); these send that result unchanged
    expect(source("examples/solve-and-submit.ts")).toMatch(/body: JSON\.stringify\(\{\s*\.\.\.result\.best,/);
    expect(source("scripts/batch-search.ts")).toMatch(/config: r\.best,/);
    expect(source("scripts/batch-search/lib.ts")).toContain("const { N, M, P, pieces, container_phi } = best.config;");
    // the nightly free improvements send only packings made by trimTo and growByStrip, which orient
    // their result (scripts/test/trim-down.test.ts checks the score at the phi they return)
    expect(between(source("scripts/trim-down.ts"), "const offer = (", "};")).toContain(
      "const { pieces, container_phi } = made;",
    );
    // the Python example sends an axis-aligned grid, which is at its best orientation at phi = 0
    const grid = {
      N: 4,
      M: 4,
      P: 11,
      container_phi: 0,
      pieces: Array.from({ length: 11 }, (_, i) => ({ x: i % 4, y: Math.floor(i / 4), theta: Math.PI / 4 })),
    };
    expect(source("examples/submit.py")).toContain('"container_phi": 0.0,');
    expect(evaluate(grid).score).toBe(evaluate(grid, { autoOrient: true }).score);
  });
});
