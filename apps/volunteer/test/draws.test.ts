/**
 * The default polygon queue is the one the client had before the spaces option. The snapshot was
 * taken with test/draw-harness.ts from the client of commit a3ae095 (the last one without spaces)
 * and is the same at this version; a change that alters the default draws, their number or the
 * history's fields fails here.
 */
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/main";
import { DRAW_PROBLEMS, defaultDraws } from "./draw-harness";
import { type FakeServer, startFakeServer } from "./fake-server";
import { fixture } from "./spaces-fixtures";

const SNAPSHOT = {
  picks: [
    "0 N=6 M=6 P=8",
    "0 N=0 M=0 P=11",
    "0 N=8 M=8 P=3",
    "0 N=0 M=4 P=9",
    "0 N=3 M=3 P=5",
    "0 N=3 M=6 P=10",
    "0 N=4 M=4 P=7",
    "0 N=7 M=5 P=4",
    "0 N=5 M=5 P=13",
    "0 N=5 M=0 P=6",
  ],
  draws: 10,
  keys: [
    "time,N,M,P,reason,priority,leader_before,leader_after,published,best,jobs,stopped,active_s,engine_seed,dry_run,submitted,decision,status,response,version",
  ],
};

let server: FakeServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe("the default queue", () => {
  it(
    "draws the same problems as the client before the spaces option, and asks nothing about them",
    { timeout: 120_000 },
    async () => {
      // the server also has a space problem: without --spaces it is never asked about
      server = await startFakeServer({ problems: DRAW_PROBLEMS, spaces: [fixture("sphere", "sphere/3/13")] });
      const r = await defaultDraws(main as never, server.url, 10);
      expect(r).toEqual(SNAPSHOT);
      expect(server.requests.filter((q) => q.path.startsWith("/api/spaces"))).toEqual([]);
    },
  );
});
