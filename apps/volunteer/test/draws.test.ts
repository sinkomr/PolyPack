/**
 * The draws, pinned: the default draw over every flat problem with a seeded random source, and the
 * client's own draws among a fake server's problems from one run to the next (test/draw-harness.ts).
 * A change that alters the draws, their number or the history's fields fails here.
 */
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/main";
import { drawProblem, drawnKey, kindsFor } from "../src/pick";
import { DRAW_PROBLEMS, defaultDraws, mulberry32 } from "./draw-harness";
import { type FakeServer, startFakeServer } from "./fake-server";
import { fixture } from "./spaces-fixtures";

/** N-M-P: mostly many-sided pieces and containers and large P, as a uniform draw over the 4,900,500 problems gives. */
const DEFAULT_DRAWS: string[] = [
  "46-86-335",
  "54-29-313",
  "48-26-442",
  "32-21-251",
  "62-0-236",
  "7-60-16",
  "8-20-392",
  "4-19-422",
  "82-33-225",
  "7-57-299",
];

const SNAPSHOT = {
  picks: [
    "0 N=0 M=4 P=9",
    "0 N=8 M=8 P=3",
    "0 N=3 M=6 P=10",
    "0 N=7 M=5 P=4",
    "0 N=5 M=5 P=13",
    "0 N=5 M=0 P=6",
    "0 N=3 M=3 P=5",
    "0 N=4 M=0 P=12",
    "0 N=0 M=0 P=11",
    "0 N=4 M=4 P=7",
  ],
  draws: 56,
  keys: [
    "time,N,M,P,reason,priority,leader_before,leader_after,published,best,jobs,stopped,active_s,engine_seed,dry_run,submitted,decision,status,response,version",
  ],
};

let server: FakeServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe("the draws", () => {
  it("over every flat problem, by default, are the same from one version to the next", () => {
    const random = mulberry32(42);
    const kinds = kindsFor({ N: null, M: null, maxP: null, spaces: null, onlySpaces: false });
    const picks = Array.from({ length: 10 }, () =>
      drawnKey(drawProblem(kinds, { recent: new Map(), skip: new Set(), now: 0, random })!),
    );
    expect(picks).toEqual(DEFAULT_DRAWS);
  });

  it(
    "among a server's problems prefer those not searched yet, and ask nothing about the spaces without --dimensions",
    { timeout: 120_000 },
    async () => {
      // the server also has a space problem: without --dimensions it is never asked about
      server = await startFakeServer({ problems: DRAW_PROBLEMS, spaces: [fixture("sphere", "sphere/3/13")] });
      const r = await defaultDraws(main as never, server.url, 10, server.kinds());
      expect(r).toEqual(SNAPSHOT);
      // ten dry runs, ten different problems: each prefers one not searched here yet
      expect(new Set(r.picks).size).toBe(10);
      expect(server.requests.filter((q) => q.path.startsWith("/api/spaces"))).toEqual([]);
    },
  );
});
