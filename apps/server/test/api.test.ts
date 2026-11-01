import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AtlasResponse,
  Holder,
  HolderPair,
  HolderResponse,
  HoldersResponse,
  LEADERBOARD_SIZE,
  LiteratureRecord,
  PackingConfig,
  SCORE_TIE,
  SubmitResponse,
  areaLowerBound,
  beatsLiterature,
  closedToSubmissions,
  evaluate,
  improvesOn,
  isProven,
  reachesLiterature,
} from "@polypack/geometry";
import { registry } from "@polypack/solver";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ATLAS_MAX_PIECES,
  ATLAS_MAX_SPAN,
  AppOptions,
  HOLDERS_CHUNK,
  HOLDER_CHUNK,
  atlasSource,
  createApp,
  holderShare,
} from "../src/app";
import { SOLVER_METHODS } from "../src/docs";
import { SqliteStore } from "../src/sqlite-store";
import { GET_MANY_LIMIT, NewSubmission, ProblemLeader } from "../src/store";
import { withUnits } from "./units";

const SQ = Math.PI / 4;
const row = (n: number, gap = 1): PackingConfig["pieces"] =>
  Array.from({ length: n }, (_, i) => ({ x: i * gap, y: 0, theta: SQ }));

// A made-up published value, far above what three squares need, to trigger the review path.
const fakeRecord: LiteratureRecord = {
  N: 4,
  M: 4,
  P: 3,
  value: 5,
  display: "5.00",
  display_precision: 2,
  status: "best_known",
  source_name: "test",
  source_url: "https://example.invalid",
  accessed: "2026-10-07",
  conversion_note: "none",
};

let app: ReturnType<typeof createApp>;
let logs: string[];
let ip = "1.1.1.1";

beforeEach(() => {
  logs = [];
  ip = "1.1.1.1";
  app = createApp({
    store: new SqliteStore(":memory:"),
    records: [fakeRecord],
    adminToken: "secret",
    clientIp: () => ip,
    log: (m) => logs.push(m),
    limits: { perIp: 8 },
  });
});

async function submit(body: unknown): Promise<{ status: number; body: SubmitResponse }> {
  const r = await app.request("/api/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(withUnits(body)),
  });
  return { status: r.status, body: (await r.json()) as SubmitResponse };
}
const get = async (path: string, headers?: Record<string, string>) => {
  const r = await app.request(path, { headers });
  // responses differ per route; the assertions below check the fields they use
  return { status: r.status, body: (await r.json()) as any };
};
const squares = (P: number, extra: object = {}) => ({
  N: 4,
  M: 4,
  P,
  pieces: row(P),
  container_phi: 0,
  name: "ann",
  ...extra,
});

describe("POST /api/submit", () => {
  it("accepts a valid packing and stores the server-computed score", async () => {
    const r = await submit(squares(2, { score: 0.001, container: { size: 0.001 } }));
    expect(r.status).toBe(200);
    expect(r.body.valid).toBe(true);
    expect(r.body.score).toBeCloseTo(2, 9);
    expect(r.body.rank).toBe(1);
    expect(r.body.leader).toBe(true);
    expect(r.body.leader_score).toBe(r.body.score);
    const lb = await get("/api/leaderboard/4/4/2");
    expect(lb.body.entries[0].score).toBe(r.body.score);
    expect(lb.body.total).toBe(1);
    expect(lb.body.accepts_submissions).toBe(true);
  });

  it("scores the container at the phi sent and does not look for a better one", async () => {
    // two squares side by side fit a square of side 2 at phi = 0; turned by 0.3 it must be larger
    const turned = squares(2, { container_phi: 0.3 });
    const r = await submit(turned);
    expect(r.body.score).toBe(evaluate(turned).score);
    expect(r.body.container).toEqual(evaluate(turned).container);
    expect(r.body.container!.phi).toBe(0.3);
    expect(r.body.score!).toBeGreaterThan(2.1);
    // the better orientation was there to be found, by the client
    const oriented = evaluate(turned, { autoOrient: true });
    expect(oriented.score).toBeCloseTo(2, 9);
    expect((await submit({ ...turned, container_phi: oriented.container!.phi })).body.score).toBe(oriented.score);
    // without container_phi, at 0
    const { container_phi: _phi, ...unturned } = squares(2, { name: "bob" });
    const zero = await submit(unturned);
    expect(zero.body.container!.phi).toBe(0);
    expect(zero.body.score).toBe(evaluate(squares(2)).score);
  });

  it("rejects overlaps, wrong counts and malformed bodies with reasons", async () => {
    const overlap = await submit({ ...squares(2), pieces: row(2, 0.9) });
    expect(overlap.status).toBe(422);
    expect(overlap.body.reasons[0]).toMatch(/overlapping/);
    expect(overlap.body).toMatchObject({ rank: null, leader: false, leader_score: null, id: null });
    const count = await submit({ ...squares(3), pieces: row(2) });
    expect(count.status).toBe(422);
    expect(count.body.reasons[0]).toMatch(/exactly 3 pieces/);
    expect((await submit("{nope")).status).toBe(400);
    expect((await submit({ ...squares(2), N: 2 })).status).toBe(400);
    expect((await submit({ ...squares(2), P: 501 })).status).toBe(400);
    expect((await submit({ ...squares(2), name: "  " })).body.reasons).toEqual(["name is required"]);
    expect(
      (
        await submit({
          ...squares(2),
          pieces: [
            { x: 0, y: 0, theta: 0 },
            { x: "1", y: 0, theta: 0 },
          ],
        })
      ).status,
    ).toBe(400);
    expect((await get("/api/leaderboard/4/4/2")).body.total).toBe(0);
  });

  it("caps the payload size", async () => {
    const r = await submit(squares(2, { agent_note: "x".repeat(300_000) }));
    expect(r.status).toBe(413);
  });

  it("sanitizes names and notes", async () => {
    await submit(
      squares(2, {
        name: "  <b>Bob</b>\u0000\n  the   builder ",
        agent_note: "<script>x</script>",
        found_with: "external",
        software: " <i>my</i>\ttool ",
      }),
    );
    const e = (await get("/api/leaderboard/4/4/2")).body.entries[0];
    expect(e.name).toBe("b Bob /b the builder");
    expect(e.agent_note).not.toMatch(/[<>]/);
    expect((await get(`/api/submissions/${e.id}`)).body.software).toBe("i my /i tool");
  });

  it("rate-limits by address, not by name", async () => {
    for (let i = 0; i < 8; i++) expect((await submit(squares(2))).status).toBe(200);
    expect((await submit(squares(2, { name: "fresh" }))).status).toBe(429);
    ip = "2.2.2.2";
    expect((await submit(squares(2))).status).toBe(200);
  });
});

describe("how a submission was found", () => {
  const run = {
    method: "basin_hopping",
    method_params: { iterations: 200, stepScale: 0.25, operators: ["shift", "swap"] },
    seed: 7,
    budget: { evals: 20000, time_s: 20 },
  };
  const stored = async (id: number | null) => (await get(`/api/submissions/${id}`)).body;
  let sent = 0;
  const reasons = async (extra: object) => {
    // a fresh address each time: the rate limit is not under test here
    ip = `10.0.0.${++sent}`;
    const r = await submit(squares(2, extra));
    expect(r.status).toBe(400);
    expect(r.body.valid).toBe(false);
    return r.body.reasons.join("; ");
  };

  it("stores the method and its settings, and returns them only with the full entry", async () => {
    const r = await submit(squares(2, { found_with: "optimizer", ...run }));
    expect(r.status).toBe(200);
    const s = await stored(r.body.id);
    expect(s).toMatchObject({ found_with: "optimizer", ...run, software: null, agent_note: "" });
    expect(s).not.toHaveProperty("agent");
    // the listings carry found_with only
    const listed = [
      (await get("/api/leaderboard/4/4/2")).body.entries[0],
      (await get("/api/problems/4/4/2")).body.site_best,
      (await get("/api/records?N=4&M=4")).body.site[0],
    ];
    for (const e of listed) {
      expect(e.found_with).toBe("optimizer");
      for (const key of ["agent", "method", "method_params", "seed", "budget", "software"])
        expect(e).not.toHaveProperty(key);
    }
  });

  it("records an edited optimizer result, one's own software and a hand-made entry", async () => {
    const edited = await submit(squares(2, { found_with: "optimizer_edited", method: "asc" }));
    expect(await stored(edited.body.id)).toMatchObject({
      found_with: "optimizer_edited",
      method: "asc",
      method_params: null,
      seed: null,
      budget: null,
      software: null,
    });
    const own = await submit(squares(3, { found_with: "external", software: "my packer 2.1" }));
    expect(await stored(own.body.id)).toMatchObject({
      found_with: "external",
      software: "my packer 2.1",
      method: null,
    });
    // without found_with, an entry counts as found by hand
    const hand = await submit(squares(4));
    expect(await stored(hand.body.id)).toMatchObject({ found_with: "hand", method: null, seed: null });
    expect((await get("/api/leaderboard/4/4/4")).body.entries[0].found_with).toBe("hand");
  });

  it("records the client that ran a PolyPack optimizer", async () => {
    const volunteer = await submit(
      squares(2, { found_with: "optimizer", ...run, software: "polypack-volunteer/0.1.0" }),
    );
    expect(volunteer.status).toBe(200);
    expect(await stored(volunteer.body.id)).toMatchObject({
      found_with: "optimizer",
      ...run,
      software: "polypack-volunteer/0.1.0",
    });
    const game = await submit(
      squares(3, { found_with: "optimizer_edited", method: "shrink_repair", software: " Tighter <1.2> " }),
    );
    expect(await stored(game.body.id)).toMatchObject({
      found_with: "optimizer_edited",
      method: "shrink_repair",
      software: "Tighter 1.2",
    });
    // the listings still carry found_with only
    expect((await get("/api/leaderboard/4/4/2")).body.entries[0]).not.toHaveProperty("software");
  });

  it("accepts the legacy agent field unchanged and ignores it", async () => {
    // the body the batch runner sent before found_with existed
    const legacy = await submit(
      squares(2, { agent: "ai", agent_note: "cloud pilot asc, seed 2, 20000 evaluations / 15 s" }),
    );
    expect(legacy.status).toBe(200);
    expect(legacy.body.valid).toBe(true);
    const s = await stored(legacy.body.id);
    // an AI entry without found_with may or may not come from an optimizer: not recorded
    expect(s).toMatchObject({ found_with: null, agent_note: "cloud pilot asc, seed 2, 20000 evaluations / 15 s" });
    expect(s).not.toHaveProperty("agent");
    expect((await get("/api/leaderboard/4/4/2")).body.entries[0]).not.toHaveProperty("agent");
    // "human" was the old default; any other value is ignored too
    expect((await stored((await submit(squares(3, { agent: "human" }))).body.id)).found_with).toBe("hand");
    ip = "10.0.2.1";
    expect((await submit(squares(4, { agent: "robot" }))).status).toBe(200);
    expect(
      (await stored((await submit(squares(5, { agent: "ai", found_with: "optimizer", method: "asc" }))).body.id))
        .found_with,
    ).toBe("optimizer");
  });

  it("accepts every registered method with its default parameters", async () => {
    let n = 0;
    for (const m of registry.list()) {
      ip = `10.0.3.${++n}`;
      const r = await submit(
        squares(2, {
          found_with: "optimizer",
          method: m.name,
          method_params: m.defaults,
          seed: 0,
          budget: { evals: 1 },
        }),
      );
      expect([m.name, r.status]).toEqual([m.name, 200]);
    }
  });

  it("refuses wrong values with a reason and stores nothing", async () => {
    expect(await reasons({ found_with: "magic" })).toMatch(/found_with must be one of "hand", "optimizer"/);
    expect(await reasons({ found_with: 1 })).toMatch(/found_with must be one of/);
    expect(await reasons({ found_with: "optimizer", method: "simulated_annealing" })).toMatch(
      /method must be the name of a registered search method/,
    );
    expect(await reasons({ found_with: "optimizer", method: 3 })).toMatch(/method must be the name/);
    expect(await reasons({ found_with: "optimizer" })).toMatch(/method is required when found_with is "optimizer"/);
    expect(await reasons({ found_with: "optimizer_edited", seed: 1 })).toMatch(/method is required/);
    expect(await reasons({ found_with: "optimizer", method: "asc", method_params: [1, 2] })).toMatch(
      /method_params must be a JSON object/,
    );
    expect(await reasons({ found_with: "optimizer", method: "asc", method_params: null })).toMatch(
      /method_params must be a JSON object/,
    );
    expect(
      await reasons({ found_with: "optimizer", method: "asc", method_params: { blob: "x".repeat(4100) } }),
    ).toMatch(/method_params must be at most 4096 bytes/);
    for (const seed of [1.5, -1, "1", 2 ** 60])
      expect(await reasons({ found_with: "optimizer", method: "asc", seed })).toMatch(
        /seed must be a non-negative integer/,
      );
    for (const budget of [
      20000,
      {},
      { evals: 0 },
      { evals: 1.5 },
      { time_s: "15" },
      { time_s: -1 },
      { evals: 10, steps: 3 },
      null,
    ])
      expect(await reasons({ found_with: "optimizer", method: "asc", budget })).toMatch(/budget must be/);
    expect(await reasons({ found_with: "external", software: 7 })).toMatch(/software must be a string/);
    expect(await reasons({ found_with: "external", software: "x".repeat(81) })).toMatch(/at most 80 characters/);
    // fields that contradict found_with
    expect(await reasons({ method: "asc" })).toMatch(/need found_with "optimizer" or "optimizer_edited"/);
    expect(await reasons({ found_with: "external", method: "asc", seed: 2 })).toMatch(/method, seed describe/);
    // software names a program, so a packing made by hand, or not said to be made otherwise, has none
    expect(await reasons({ found_with: "hand", software: "x" })).toMatch(
      /software needs found_with "external", "optimizer" or "optimizer_edited"/,
    );
    expect(await reasons({ software: "x" })).toMatch(/software needs found_with "external"/);
    expect(await reasons({ agent: "ai", software: "x" })).toMatch(/software needs found_with "external"/);
    expect(await reasons({ found_with: "optimizer", method: "asc", software: 7 })).toMatch(/software must be a string/);
    // configuration errors and provenance errors are reported together
    ip = "10.0.1.1";
    const both = await submit({ ...squares(2), P: 0, found_with: "nope" });
    expect(both.body.reasons.join("; ")).toMatch(/P must be.*found_with must be/);
    expect((await get("/api/leaderboard/4/4/2")).body.total).toBe(0);
  });
});

describe("GET /api", () => {
  it("serves the documentation page", async () => {
    const r = await app.request("/api");
    expect(r.status).toBe(200);
    const html = await r.text();
    for (const part of [
      "POST /api/submit",
      "GET /api/problems/{N}/{M}/{P}",
      "Example in Python",
      "Example with curl",
      "derived-records",
      "GET /api/leaderboard/{N}/{M}/{P}",
      "GET /api/submissions/{id}",
      "GET /api/records?N=&amp;M=",
      "GET /api/records/pairs",
      "GET /api/events",
      "GET /api/health",
      "GET /api/admin/pending",
      "POST /api/admin/review",
      "POST /api/admin/remove",
      "Authorization: Bearer",
      "accepts_submissions",
      "leader_score",
      "<td>409</td>",
      `score ≤ min · (1 + ${SCORE_TIE})`,
      'id="automated-search"',
      "examples/solve-and-submit.ts",
      "https://github.com/sinkomr/PolyPack",
      // the scoring rule, plainly, with the default
      "The score is computed at the <code>container_phi</code> you send</strong> (0 when it is missing)",
      "does not search for a better one",
      'href="#orientation">orient your board before submitting',
    ]) {
      expect(html).toContain(part);
    }
    // and in the conventions every problem description carries
    const { conventions } = (await get("/api/problems/4/4/2")).body;
    expect(conventions.scoring).toMatch(
      /^the server scores the container at the container_phi sent \(0 when it is missing\) and does not search for a better orientation/,
    );
    // nothing is left of the three-row leaderboard
    expect(html).not.toMatch(/top[- ]3|top three/i);
  });

  it("lists exactly the registered search methods", async () => {
    expect(SOLVER_METHODS.map(([name]) => name)).toEqual(registry.list().map((m) => m.name));
    const html = await (await app.request("/api")).text();
    for (const m of registry.list()) expect(html).toContain(`<td><code>${m.name}</code></td>`);
  });
});

/** Reads the event stream of the current app; `count` is the number of leaderboard events seen so far. */
async function listen() {
  const res = await app.request("/api/events");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  const until = async (needle: string) => {
    while (!seen.includes(needle)) seen += decoder.decode((await reader.read()).value);
  };
  await until("hello");
  return { until, count: () => seen.split("event: leaderboard").length - 1, close: () => reader.cancel() };
}

/** Two disks of diameter 1 with centres `d` apart in a circle: the score (the circle's diameter) is 1 + d. */
const twoCircles = (score: number, name: string) => ({
  N: 0,
  M: 0,
  P: 2,
  pieces: [
    { x: 0, y: 0, theta: 0 },
    { x: score - 1, y: 0, theta: 0 },
  ],
  container_phi: 0,
  name,
});

describe("leaderboard", () => {
  it("keeps and shows only the best entry, and counts every submission", async () => {
    expect(LEADERBOARD_SIZE).toBe(1);
    const gaps = [1.5, 1.2, 1.0, 1.3, 1.1];
    const answers: SubmitResponse[] = [];
    for (const [i, gap] of gaps.entries()) {
      answers.push((await submit({ ...squares(2, { name: `p${i}` }), pieces: row(2, gap) })).body);
    }
    // a rank counts the entries stored when the entry arrived: by then only the leader
    expect(answers.map((a) => a.rank)).toEqual([1, 1, 1, 2, 2]);
    expect(answers.map((a) => a.leader)).toEqual([true, true, true, false, false]);
    // each answer names the score to beat, which is the entry's own when it leads
    const best = answers[2].score;
    expect(answers.map((a) => a.leader_score)).toEqual([answers[0].score, answers[1].score, best, best, best]);
    const lb = (await get("/api/leaderboard/4/4/2")).body;
    expect(lb.total).toBe(5);
    expect(lb.entries.map((e: { name: string }) => e.name)).toEqual(["p2"]);
    const problem = (await get("/api/problems/4/4/2")).body;
    expect(problem.site_best.name).toBe("p2");
    expect(problem.accepts_submissions).toBe(true);
    expect(problem.area_bound).toBeCloseTo(Math.SQRT2, 12);
    const stored = (await get(`/api/submissions/${problem.site_best.id}`)).body;
    expect(stored.pieces).toEqual(row(2, 1.0));
    // the overtaken leaders were deleted, and the entries that never led were not kept
    expect(answers.map((a) => a.id)).toEqual([1, 2, 3, null, null]);
    for (const id of [1, 2, 4, 5]) expect((await get(`/api/submissions/${id}`)).status).toBe(404);
    const records = (await get("/api/records?N=4&M=4")).body;
    expect(records.site.map((s: { P: number }) => s.P)).toEqual([2]);
    expect(records.site[0].name).toBe("p2");
    expect(records.literature).toHaveLength(1);
  });

  it("sends a live event when a problem gets a new leader", async () => {
    const events = await listen();
    await submit(squares(2));
    await events.until("event: leaderboard");
    await events.until('"rank":1');
    await events.close();
  });

  it("keeps the earliest of equally good entries as the leader", async () => {
    expect(improvesOn(1 - 2 * SCORE_TIE, 1)).toBe(true);
    expect(improvesOn(1 - SCORE_TIE / 2, 1)).toBe(false);
    expect(improvesOn(1, 1)).toBe(false);
    expect(improvesOn(1 + 2 * SCORE_TIE, 1)).toBe(false);

    const events = await listen();
    const leaderOf = async () => (await get("/api/leaderboard/0/0/2")).body.entries.map((e: { id: number }) => e.id);
    const first = (await submit(twoCircles(2.5, "first"))).body;
    expect(first).toMatchObject({ valid: true, rank: 1, leader: true, leader_score: first.score });
    expect(first.score).toBeCloseTo(2.5, 12);

    // an identical score
    const equal = (await submit(twoCircles(2.5, "equal"))).body;
    expect(equal.score).toBe(first.score);
    expect(equal).toMatchObject({ valid: true, rank: 2, leader: false, leader_score: first.score });
    expect(await leaderOf()).toEqual([first.id]);

    // a smaller score, but by less than the tolerance: nothing is strictly ahead of it, yet it does not lead
    const hair = (await submit(twoCircles(2.5 * (1 - SCORE_TIE / 2), "hair"))).body;
    expect(hair.score!).toBeLessThan(first.score!);
    expect(improvesOn(hair.score!, first.score!)).toBe(false);
    expect(hair).toMatchObject({ valid: true, rank: 2, leader: false, leader_score: first.score });
    expect(await leaderOf()).toEqual([first.id]);
    expect((await get("/api/problems/0/0/2")).body.site_best.id).toBe(first.id);
    expect((await get("/api/records?N=0&M=0")).body.site).toEqual([expect.objectContaining({ P: 2, id: first.id })]);

    // a worse score; the two before were not kept, so it is second among what is stored
    const worse = (await submit(twoCircles(2.6, "worse"))).body;
    expect(worse).toMatchObject({ valid: true, rank: 2, leader: false, leader_score: first.score, id: null });

    // better by more than the tolerance: the lead changes
    const better = (await submit(twoCircles(2.5 * (1 - 3 * SCORE_TIE), "better"))).body;
    expect(improvesOn(better.score!, first.score!)).toBe(true);
    expect(better).toMatchObject({ valid: true, rank: 1, leader: true, leader_score: better.score });
    expect(await leaderOf()).toEqual([better.id]);

    // and the new leader is as safe from a later tie as the first one was
    const again = (await submit(twoCircles(2.5 * (1 - 3 * SCORE_TIE), "again"))).body;
    expect(again).toMatchObject({ valid: true, rank: 2, leader: false, leader_score: better.score });
    expect(await leaderOf()).toEqual([better.id]);
    expect((await get("/api/leaderboard/0/0/2")).body.total).toBe(6);

    // six submissions, two changes of leader, two events; a third problem's event closes the count
    const other = (await submit(squares(2))).body;
    await events.until(`"id":${other.id},`);
    expect(events.count()).toBe(3);
    await events.until(`"id":${first.id},`);
    await events.until(`"id":${better.id},`);
    await events.close();

    // only the leader was kept, so when it is taken off the site the problem has no entry
    const removed = await app.request("/api/admin/remove", {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ id: better.id }),
    });
    expect(removed.status).toBe(200);
    expect(await leaderOf()).toEqual([]);
    expect((await get("/api/leaderboard/0/0/2")).body.total).toBe(6);
  });

  it("measures a new entry against the leader alone, since nothing else is kept", async () => {
    // Three scores, each within the tolerance of the next but the last not of the first. The
    // second does not lead and is not kept, so no chain of near ties forms: the third is better
    // than the leader by more than the tolerance, and takes the lead.
    const events = await listen();
    const a = (await submit(twoCircles(2.5, "a"))).body;
    const b = (await submit(twoCircles(2.5 * (1 - 0.6 * SCORE_TIE), "b"))).body;
    expect(b).toMatchObject({ leader: false, id: null });
    const c = (await submit(twoCircles(2.5 * (1 - 1.2 * SCORE_TIE), "c"))).body;
    expect(improvesOn(c.score!, a.score!)).toBe(true);
    expect(c).toMatchObject({ valid: true, rank: 1, leader: true, leader_score: c.score });
    expect((await get("/api/leaderboard/0/0/2")).body.entries.map((e: { id: number }) => e.id)).toEqual([c.id]);
    await events.until(`"id":${a.id},`);
    await events.until(`"id":${c.id},`);
    expect(events.count()).toBe(2);
    await events.close();
  });
});

describe("store: the leader per problem", () => {
  const entry = (P: number, score: number, verification: NewSubmission["verification"] = "none"): NewSubmission => ({
    N: 4,
    M: 4,
    P,
    score,
    name: `P${P}`,
    agent_note: "",
    found_with: "hand",
    method: null,
    method_params: null,
    seed: null,
    budget: null,
    software: null,
    pieces: [],
    container_phi: 0,
    created_at: "2026-10-12T00:00:00.000Z",
    verification,
    literature_value: null,
    strict_check: null,
  });

  it("applies the tie rule to every P, with and without pending entries", async () => {
    const store = new SqliteStore(":memory:");
    const id: Record<string, number> = {};
    const add = async (key: string, s: NewSubmission) => {
      id[key] = await store.insert(s);
    };
    // P = 2: equal scores
    await add("2a", entry(2, 2));
    await add("2b", entry(2, 2));
    // P = 3: the later one is smaller by less than the tolerance
    await add("3a", entry(3, 3));
    await add("3b", entry(3, 3 * (1 - SCORE_TIE / 2)));
    // P = 4: two equal claims awaiting review ahead of an ordinary entry
    await add("4a", entry(4, 4));
    await add("4b", entry(4, 3.9, "pending"));
    await add("4c", entry(4, 3.9, "pending"));
    // P = 5: nothing but a claim
    await add("5a", entry(5, 5, "pending"));
    // P = 6: a rejected entry is never the minimum that the others are measured against
    await add("6a", entry(6, 6));
    await add("6b", entry(6, 5, "rejected"));
    await add("6c", entry(6, 6));
    // P = 7: a real improvement, and a confirmed entry counts as reviewed
    await add("7a", entry(7, 7));
    await add("7b", entry(7, 6.99, "confirmed"));
    await add("7c", entry(7, 6.99));
    // another problem with a smaller score is not mixed in
    await add("x", { ...entry(2, 1.5), M: 5 });

    const leaders = async (verifiedOnly?: boolean) =>
      Object.fromEntries((await store.bestPerP(4, 4, verifiedOnly)).map((e) => [e.P, e.id]));
    expect(await leaders()).toEqual({ 2: id["2a"], 3: id["3a"], 4: id["4b"], 5: id["5a"], 6: id["6a"], 7: id["7b"] });
    expect(await leaders(true)).toEqual({ 2: id["2a"], 3: id["3a"], 4: id["4a"], 6: id["6a"], 7: id["7b"] });
    expect((await store.bestPerP(4, 4)).map((e) => e.P)).toEqual([2, 3, 4, 5, 6, 7]);
    expect((await store.bestPerP(4, 4))[0]).toEqual({
      P: 2,
      id: id["2a"],
      name: "P2",
      found_with: "hand",
      agent_note: "",
      score: 2,
      created_at: "2026-10-12T00:00:00.000Z",
      verification: "none",
    });
    // the single-problem query agrees, and so does the listing of every problem
    for (const e of await store.bestPerP(4, 4)) expect((await store.leader(4, 4, e.P))!.id).toBe(e.id);
    expect(await store.leaders()).toEqual([
      ...(await store.bestPerP(4, 4)).map(({ P, id: leaderId, name, score, verification }) => ({
        N: 4,
        M: 4,
        P,
        id: leaderId,
        name,
        score,
        verification,
      })),
      { N: 4, M: 5, P: 2, id: id["x"], name: "P2", score: 1.5, verification: "none" },
    ]);
    expect((await store.leader(4, 5, 2))!.id).toBe(id["x"]);
    expect(await store.pairs()).toEqual([
      { N: 4, M: 4 },
      { N: 4, M: 5 },
    ]);
    expect(await store.leader(4, 4, 8)).toBeNull();
    expect(await store.bestPerP(3, 3)).toEqual([]);
    // rejecting a leader hands the lead to the earliest of the remaining best
    expect(await store.remove(id["7b"])).toBe(true);
    expect((await store.leader(4, 4, 7))!.id).toBe(id["7c"]);
    expect((await leaders())[7]).toBe(id["7c"]);
    // the count is of submissions received, not of what is still listed
    expect(await store.count(4, 4, 7)).toBe(3);
  });

  it("lists the leaders in pages that join up to the listing of all of them", async () => {
    const store = new SqliteStore(":memory:");
    expect(await store.leadersAfter(null, 5)).toEqual([]);
    // entries as an older server left them: several to a problem, ties, claims and rejected rows
    let seed = 7;
    const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    for (let k = 0; k < 400; k++)
      await store.insert({
        ...entry(
          1 + Math.floor(rand() * 5),
          pick([1, 2, 3, 4, 2.5, 2.5 * (1 - SCORE_TIE / 2)]),
          pick(["none", "none", "pending", "confirmed", "rejected"] as const),
        ),
        N: pick([0, 3, 4, 12]),
        M: pick([0, 4, 5]),
        name: pick(["a", "b", "c"]),
      });
    const all = await store.leaders();
    expect(all.length).toBeGreaterThan(40);
    for (const limit of [1, 2, 3, 7, 40, all.length - 1, all.length, all.length + 1, 1000]) {
      const pages: ProblemLeader[][] = [];
      for (let after: ProblemLeader | null = null; ;) {
        const page: ProblemLeader[] = await store.leadersAfter(after, limit);
        pages.push(page);
        // a short page is the last
        if (page.length < limit) break;
        after = page[page.length - 1]!;
      }
      expect(pages.slice(0, -1).every((page) => page.length === limit)).toBe(true);
      expect(pages.flat()).toEqual(all);
    }
    // from a problem that has no entry, the next one that has
    const gap = { N: 3, M: 5, P: 99 };
    const beyond = (l: ProblemLeader) =>
      l.N > gap.N || (l.N === gap.N && (l.M > gap.M || (l.M === gap.M && l.P > gap.P)));
    expect(all.some((l) => !beyond(l))).toBe(true);
    expect(await store.leadersAfter(gap, 1)).toEqual([all.find(beyond)]);
    expect(await store.leadersAfter(all[all.length - 1]!, 10)).toEqual([]);
    await expect(store.leadersAfter(null, 0)).rejects.toThrow(RangeError);
    await expect(store.leadersAfter(null, 1.5)).rejects.toThrow(RangeError);
  });

  it("keeps the leader alone, also when it is not first by score", async () => {
    const store = new SqliteStore(":memory:");
    // the second is within the tolerance of the first, so the first stays leader though it is larger
    const ids: number[] = [];
    for (const score of [3, 3 * (1 - SCORE_TIE / 2), 3.2, 3.1, 3.3]) ids.push(await store.insert(entry(9, score)));
    // the others go in order of score
    expect(await store.prune(4, 4, 9)).toEqual([ids[1], ids[3], ids[2], ids[4]]);
    expect((await store.leader(4, 4, 9))!.id).toBe(ids[0]);
    expect((await store.getMany(ids)).map((s) => s.id)).toEqual([ids[0]]);
    expect(await store.count(4, 4, 9)).toBe(5);
    expect(await store.prune(4, 4, 9)).toEqual([]);
  });

  it("prunes a database written before pruning existed, keeping its counts", () => {
    const path = join(mkdtempSync(join(tmpdir(), "polypack-prune-")), "old.sqlite");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, n INTEGER NOT NULL, m INTEGER NOT NULL,
      p INTEGER NOT NULL, score REAL NOT NULL, name TEXT NOT NULL, agent TEXT NOT NULL, agent_note TEXT NOT NULL,
      pieces TEXT NOT NULL, container_phi REAL NOT NULL, created_at TEXT NOT NULL,
      verification TEXT NOT NULL DEFAULT 'none', literature_value REAL, strict_check TEXT)`);
    const add = old.prepare(
      `INSERT INTO submissions (n, m, p, score, name, agent, agent_note, pieces, container_phi, created_at, verification)
       VALUES (4, 4, ?, ?, 'x', 'human', '', '[]', 0, '2026-10-12', ?)`,
    );
    for (const score of [5, 4, 6, 3, 7]) add.run(2, score, "none");
    add.run(2, 1, "rejected");
    add.run(3, 9, "none");
    old.close();

    const store = new SqliteStore(path);
    return Promise.all([store.count(4, 4, 2), store.count(4, 4, 3), store.getMany([1, 2, 3, 4, 5, 6, 7])]).then(
      ([two, three, rows]) => {
        expect(two).toBe(5);
        expect(three).toBe(1);
        // the leaders remain (3, and 9 for P = 3); the rest is gone, the rejected row included
        expect(rows.map((r) => r.score).sort()).toEqual([3, 9]);
      },
    );
  });
  it("adds the found-with columns to a database created before them; old rows read back as not recorded", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "polypack-found-")), "old.sqlite");
    // the schema as deployed before found_with existed, tallies included
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, n INTEGER NOT NULL, m INTEGER NOT NULL,
      p INTEGER NOT NULL, score REAL NOT NULL, name TEXT NOT NULL, agent TEXT NOT NULL, agent_note TEXT NOT NULL,
      pieces TEXT NOT NULL, container_phi REAL NOT NULL, created_at TEXT NOT NULL,
      verification TEXT NOT NULL DEFAULT 'none', literature_value REAL, strict_check TEXT);
      CREATE TABLE tallies (n INTEGER NOT NULL, m INTEGER NOT NULL, p INTEGER NOT NULL, accepted INTEGER NOT NULL,
      PRIMARY KEY (n, m, p));
      INSERT INTO tallies VALUES (4, 4, 2, 1);`);
    old
      .prepare(
        `INSERT INTO submissions (n, m, p, score, name, agent, agent_note, pieces, container_phi, created_at)
         VALUES (4, 4, 2, 2, 'old', 'ai', 'annealing', '[]', 0, '2026-10-12')`,
      )
      .run();
    old.close();

    const columns = (db: DatabaseSync) =>
      (db.prepare("PRAGMA table_info(submissions)").all() as { name: string }[]).map((c) => c.name);
    const store = new SqliteStore(path);
    const first = await store.get(1);
    expect(first).toMatchObject({
      name: "old",
      agent_note: "annealing",
      found_with: null,
      method: null,
      method_params: null,
      seed: null,
      budget: null,
      software: null,
    });
    expect(first).not.toHaveProperty("agent");
    expect((await store.leader(4, 4, 2))!.found_with).toBeNull();
    // a new row goes into the old table, whose agent column is NOT NULL without a default
    const id = await store.insert({
      N: 4,
      M: 4,
      P: 3,
      score: 3,
      name: "new",
      agent_note: "",
      found_with: "optimizer",
      method: "asc",
      method_params: { a: 1 },
      seed: 4294967295,
      budget: { evals: 5 },
      software: null,
      pieces: [],
      container_phi: 0,
      created_at: "2026-10-13",
      verification: "none",
      literature_value: null,
      strict_check: null,
    });
    expect(await store.get(id)).toMatchObject({
      found_with: "optimizer",
      method_params: { a: 1 },
      seed: 4294967295,
      budget: { evals: 5 },
    });
    // opening it again changes nothing, and the old count is kept
    const again = new SqliteStore(path);
    expect(await again.count(4, 4, 2)).toBe(1);
    const db = new DatabaseSync(path);
    const names = columns(db);
    expect(names.filter((n) => n === "found_with")).toHaveLength(1);
    expect(names).toEqual(
      expect.arrayContaining(["agent", "found_with", "method", "method_params", "seed", "budget", "software"]),
    );
    expect(db.prepare("SELECT agent FROM submissions WHERE id = ?").get(id)).toEqual({ agent: "" });
    db.close();
  });
});

describe("problems with a proven optimum", () => {
  const rec = (P: number, status: LiteratureRecord["status"], extra: Partial<LiteratureRecord> = {}) => ({
    ...fakeRecord,
    P,
    value: 2,
    display: "2",
    display_precision: 6,
    status,
    ...extra,
  });
  // squares in a square: 2 proven with coordinates, 4 a tiling without, 5 proven but unrefereed, 3 best known
  const records: LiteratureRecord[] = [
    rec(2, "proven", { pieces: row(2), container_phi: 0 }),
    rec(4, "trivial_tiling"),
    rec(5, "proven_unrefereed", { value: 2.707107, display: "2.707107" }),
    fakeRecord,
  ];
  let store: SqliteStore;
  const withRecords = (list: LiteratureRecord[]) =>
    createApp({
      store,
      records: list,
      adminToken: "secret",
      clientIp: () => ip,
      log: (m) => logs.push(m),
      limits: { perIp: 8 },
    });

  beforeEach(() => {
    store = new SqliteStore(":memory:");
    app = withRecords(records);
  });

  it("closes proven records and tilings, and nothing else", () => {
    expect(closedToSubmissions(rec(2, "proven"))).toBe(true);
    expect(closedToSubmissions(rec(2, "trivial_tiling"))).toBe(true);
    expect(closedToSubmissions(rec(2, "proven_unrefereed"))).toBe(false);
    expect(closedToSubmissions(rec(2, "best_known"))).toBe(false);
    expect(closedToSubmissions(null)).toBe(false);
    expect(closedToSubmissions(undefined)).toBe(false);
    // the display helper keeps counting an unrefereed proof as proven
    expect(isProven("proven_unrefereed")).toBe(true);
  });

  it("refuses submissions with 409 and stores nothing", async () => {
    const events = await listen();
    for (const P of [2, 4]) {
      const r = await submit(squares(P));
      expect(r.status).toBe(409);
      expect(r.body).toEqual({
        valid: false,
        reasons: ["this problem is closed: its optimum 2 is proven (test)"],
        score: null,
        rank: null,
        leader: false,
        leader_score: null,
        id: null,
        container: null,
        pending_verification: false,
        strict_check: null,
      });
      expect((await get(`/api/leaderboard/4/4/${P}`)).body).toMatchObject({
        entries: [],
        total: 0,
        accepts_submissions: false,
      });
      const problem = (await get(`/api/problems/4/4/${P}`)).body;
      expect(problem.accepts_submissions).toBe(false);
      expect(problem.site_best).toBeNull();
      expect(problem.literature.status).toBe(P === 2 ? "proven" : "trivial_tiling");
    }
    expect(await store.count(4, 4, 2)).toBe(0);
    expect(await store.get(1)).toBeNull();
    // the packing is not examined: an overlapping one gets the same answer, not 422
    expect((await submit({ ...squares(2), pieces: row(2, 0.5) })).status).toBe(409);
    // refusals do not use up the allowance of the name (5 a minute here)
    for (let i = 0; i < 3; i++) expect((await submit(squares(2))).status).toBe(409);
    const open = await submit(squares(6));
    expect(open.status).toBe(200);
    // the only event is the one of the open problem
    await events.until(`"id":${open.body.id},`);
    expect(events.count()).toBe(1);
    await events.close();
    // the address limit is checked first and does count them (8 a minute here)
    expect((await submit(squares(2))).status).toBe(409);
    expect((await submit(squares(2))).status).toBe(429);
  });

  it("leaves unrefereed proofs, best-known values and problems without a record open", async () => {
    for (const P of [5, 3, 6]) {
      expect((await get(`/api/problems/4/4/${P}`)).body.accepts_submissions).toBe(true);
      const r = await submit(squares(P));
      expect([P, r.status]).toEqual([P, 200]);
      expect(r.body.leader).toBe(true);
      expect((await get(`/api/leaderboard/4/4/${P}`)).body).toMatchObject({
        entries: [{ id: r.body.id }],
        total: 1,
        accepts_submissions: true,
      });
    }
    expect((await get("/api/records?N=4&M=4")).body.site.map((e: { P: number }) => e.P)).toEqual([3, 5, 6]);
  });

  it("no longer lists entries that were stored before the problem was closed", async () => {
    // the same database, first without the records that close P = 2 and P = 4
    app = withRecords([fakeRecord]);
    const two = await submit(squares(2));
    const four = await submit(squares(4));
    const six = await submit(squares(6));
    // an unreviewed claim against the made-up record for P = 3, and a reviewed entry behind it
    const loose = await submit({ ...squares(3, { name: "lou" }), pieces: row(3, 4) });
    const claim = await submit(squares(3));
    expect([two, four, six, loose, claim].map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(claim.body.pending_verification).toBe(true);
    expect((await get("/api/records?N=4&M=4")).body.site.map((e: { P: number }) => e.P)).toEqual([2, 3, 4, 6]);
    expect((await get("/api/atlas?N=4&M=4")).body.tiles.map((t: { P: number }) => t.P)).toEqual([2, 3, 4, 6]);

    app = withRecords([...records.filter((r) => r.P !== 3), { ...fakeRecord, status: "proven" }]);
    for (const [P, total] of [
      [2, 1],
      [3, 2],
      [4, 1],
    ]) {
      // `total` still counts what is stored; nothing of it is shown
      expect((await get(`/api/leaderboard/4/4/${P}`)).body).toMatchObject({
        entries: [],
        total,
        accepts_submissions: false,
      });
      expect((await get(`/api/problems/4/4/${P}`)).body.site_best).toBeNull();
    }
    const listing = (await get("/api/records?N=4&M=4")).body;
    expect(listing.site.map((e: { P: number }) => e.P)).toEqual([6]);
    expect(listing.site_verified).toEqual([]);
    expect(listing.literature.map((r: { P: number }) => r.P)).toEqual([2, 3, 4, 5]);
    // the atlas draws the published packing where there is one, and no site entry of a closed problem
    const tiles = (await get("/api/atlas?N=4&M=4")).body.tiles;
    expect(tiles).toEqual([
      { P: 2, source: "literature", score: 2, pieces: row(2), container_phi: 0 },
      expect.objectContaining({ P: 6, source: "site", id: six.body.id }),
    ]);
    // the stored packings stay reachable by id, so links to them keep working
    expect((await get(`/api/submissions/${two.body.id}`)).body.pieces).toEqual(row(2));
    expect((await get(`/api/submissions/${four.body.id}`)).status).toBe(200);
  });
});

describe("submissions that beat the literature", () => {
  it("are accepted as pending, logged, strictly re-verified and reviewable", async () => {
    const r = await submit(squares(3));
    expect(r.body.valid).toBe(true);
    expect(r.body.pending_verification).toBe(true);
    expect(r.body.strict_check!.ok).toBe(true);
    expect(r.body.strict_check!.certifiedSize).toBeGreaterThan(r.body.score!);
    expect(logs[0]).toMatch(/\[review\] submission 1 .* below the published 5/);
    expect((await get("/api/leaderboard/4/4/3")).body.entries[0].verification).toBe("pending");

    expect((await get("/api/admin/pending")).status).toBe(401);
    const auth = { authorization: "Bearer secret" };
    expect((await get("/api/admin/pending", auth)).body.pending).toHaveLength(1);
    const review = await app.request("/api/admin/review", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ id: 1, decision: "rejected" }),
    });
    expect(review.status).toBe(200);
    // `total` counts submissions received, so a rejection does not lower it
    expect((await get("/api/leaderboard/4/4/3")).body.entries).toEqual([]);
    expect((await get("/api/leaderboard/4/4/3")).body.total).toBe(1);
    expect((await get("/api/submissions/1")).status).toBe(404);
  });

  it("lets the admin correct an entry's name, note and provenance, never its packing", async () => {
    const auth = { authorization: "Bearer secret", "content-type": "application/json" };
    const edit = (body: unknown, headers: Record<string, string> = auth) =>
      app.request("/api/admin/edit", { method: "POST", headers, body: JSON.stringify(body) });
    const r = await submit(squares(2, { name: "bot batch", agent: "ai", agent_note: "harden, seed 2, 20000 evals" }));
    const id = r.body.id!;
    expect((await edit({ id, name: "x" }, { "content-type": "application/json" })).status).toBe(401);
    expect((await edit({ id, method: "harden" })).status).toBe(400);
    expect((await edit({ id, found_with: "optimizer" })).status).toBe(400);
    expect((await edit({ id, found_with: "optimizer", method: "no-such-method" })).status).toBe(400);
    expect((await edit({ id, name: "   " })).status).toBe(400);
    expect((await edit({ id: id + 99, name: "x" })).status).toBe(404);

    const ok = await edit({
      id,
      name: "Bot 1",
      agent_note: "",
      found_with: "optimizer",
      method: "harden",
      seed: 2,
      budget: { evals: 20000, time_s: 15 },
    });
    expect(ok.status).toBe(200);
    const stored = (await get(`/api/submissions/${id}`)).body;
    expect(stored).toMatchObject({
      name: "Bot 1",
      agent_note: "",
      found_with: "optimizer",
      method: "harden",
      seed: 2,
      budget: { evals: 20000, time_s: 15 },
      method_params: null,
      score: r.body.score,
    });
    expect((await get("/api/leaderboard/4/4/2")).body.entries[0]).toMatchObject({
      id,
      name: "Bot 1",
      found_with: "optimizer",
    });
    // a name alone leaves the provenance as it is
    expect((await edit({ id, name: "Bot 2" })).status).toBe(200);
    expect((await get(`/api/submissions/${id}`)).body).toMatchObject({ name: "Bot 2", method: "harden" });
  });

  it("lets the admin remove an ordinary entry, which no review applies to", async () => {
    const send = (headers: Record<string, string>, body: unknown) =>
      app.request("/api/admin/remove", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const auth = { authorization: "Bearer secret" };
    const r = await submit(squares(2, { name: "test entry" }));
    expect(r.body.pending_verification).toBe(false);
    const id = r.body.id!;
    expect((await get("/api/leaderboard/4/4/2")).body.total).toBe(1);

    expect((await send({}, { id })).status).toBe(401);
    expect((await send(auth, { id: "1" })).status).toBe(400);
    expect((await send(auth, { id: id + 1 })).status).toBe(404);
    expect((await get("/api/leaderboard/4/4/2")).body.total).toBe(1);

    expect((await send(auth, { id })).status).toBe(200);
    expect((await get("/api/leaderboard/4/4/2")).body.entries).toEqual([]);
    expect((await get("/api/leaderboard/4/4/2")).body.total).toBe(1);
    expect((await get(`/api/submissions/${id}`)).status).toBe(404);
    // a removed entry is no longer listed, so there is nothing left to remove
    expect((await send(auth, { id })).status).toBe(404);
  });
});

describe("only the leader is kept", () => {
  const admin = (path: string, body: object) =>
    app.request(path, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const status = async (id: number | null) => (await get(`/api/submissions/${id}`)).status;
  const piecesOf = async (id: number | null) => (await get(`/api/submissions/${id}`)).body.pieces;
  const drawn = async (N: number, M: number, P: number) =>
    (await get(`/api/atlas?N=${N}&M=${M}&from=${P}&to=${P}`)).body.tiles.map((t: { id?: number }) => t.id);
  const leaderOf = async (N: number, M: number, P: number) =>
    (await get(`/api/leaderboard/${N}/${M}/${P}`)).body.entries[0]?.id;
  // three squares in a row, far apart: valid, and above the made-up published 5 for P = 3, so not pending
  const loose = (gap: number, name: string) => ({ ...squares(3, { name }), pieces: row(3, gap) });
  // three squares in a corner of a square of side 2: a claim that beats the row of three squares
  const corner = (name: string) => ({
    ...squares(3, { name }),
    pieces: [
      { x: 0, y: 0, theta: SQ },
      { x: 1, y: 0, theta: SQ },
      { x: 0, y: 1, theta: SQ },
    ],
  });

  it("leaves a problem that loses its only entry to its published value, in every listing", async () => {
    const published: LiteratureRecord = {
      ...fakeRecord,
      P: 2,
      value: 2,
      display: "2",
      display_precision: 6,
      status: "proven_unrefereed",
      pieces: row(2),
      container_phi: 0,
    };
    app = createApp({
      store: new SqliteStore(":memory:"),
      records: [fakeRecord, published],
      adminToken: "secret",
      clientIp: () => ip,
      log: (m) => logs.push(m),
    });
    // as good as the published value, so not pending, and drawn instead of it
    const e = (await submit(squares(2, { name: "ann" }))).body;
    expect(e).toMatchObject({ leader: true, pending_verification: false });
    expect(await drawn(4, 4, 2)).toEqual([e.id]);

    expect((await admin("/api/admin/remove", { id: e.id })).status).toBe(200);
    expect((await get("/api/leaderboard/4/4/2")).body).toMatchObject({ entries: [], total: 1 });
    const problem = (await get("/api/problems/4/4/2")).body;
    expect(problem.site_best).toBeNull();
    expect(problem.literature.value).toBe(2);
    const records = (await get("/api/records?N=4&M=4")).body;
    expect(records.site).toEqual([]);
    expect(records.site_verified).toEqual([]);
    expect(records.literature.map((r: { P: number; has_coordinates: boolean }) => [r.P, r.has_coordinates])).toEqual([
      [2, true],
      [3, false],
    ]);
    expect((await get("/api/atlas?N=4&M=4&from=2&to=2")).body.tiles).toEqual([
      { P: 2, source: "literature", score: 2, pieces: row(2), container_phi: 0 },
    ]);
    expect(await status(e.id)).toBe(404);
    // and the next entry is the leader again
    const next = (await submit(squares(2, { name: "bea" }))).body;
    expect(next).toMatchObject({ leader: true, rank: 1 });
    expect(await leaderOf(4, 4, 2)).toBe(next.id);
  });

  it("keeps the best reviewed entry behind a pending leader, which leads again when the claim is rejected", async () => {
    const a = (await submit(loose(4, "a"))).body;
    const b = (await submit(loose(4.5, "b"))).body;
    expect(b).toMatchObject({ leader: false, id: null });
    const x = (await submit(squares(3, { name: "x" }))).body;
    expect(x).toMatchObject({ leader: true, pending_verification: true });
    expect(x.id).not.toBeNull();
    expect(await leaderOf(4, 4, 3)).toBe(x.id);
    expect(await piecesOf(a.id)).toEqual(row(3, 4));
    // the claim is listed with the reviewed record beside it, and the atlas draws the reviewed one
    const records = (await get("/api/records?N=4&M=4")).body;
    expect(records.site).toEqual([expect.objectContaining({ P: 3, id: x.id, verification: "pending" })]);
    expect(records.site_verified).toEqual([expect.objectContaining({ P: 3, id: a.id })]);
    expect(await drawn(4, 4, 3)).toEqual([a.id]);
    // the reviewer sees the claim's arrangement
    const pending = (await get("/api/admin/pending", { authorization: "Bearer secret" })).body.pending;
    expect(pending.map((p: { id: number; pieces: unknown }) => [p.id, p.pieces])).toEqual([[x.id, row(3)]]);

    expect((await admin("/api/admin/review", { id: x.id, decision: "rejected" })).status).toBe(200);
    expect(await status(x.id)).toBe(404);
    expect(await leaderOf(4, 4, 3)).toBe(a.id);
    expect(await drawn(4, 4, 3)).toEqual([a.id]);
    expect((await get("/api/records?N=4&M=4")).body.site).toEqual([expect.objectContaining({ P: 3, id: a.id })]);
    expect((await get("/api/admin/pending", { authorization: "Bearer secret" })).body.pending).toEqual([]);
    // the rejected claim is gone, so it cannot be reviewed again
    expect((await admin("/api/admin/review", { id: x.id, decision: "confirmed" })).status).toBe(404);
    expect((await get("/api/leaderboard/4/4/3")).body.total).toBe(3);
  });

  it("keeps the confirmed claim alone", async () => {
    const a = (await submit(loose(4, "a"))).body;
    const x = (await submit(squares(3, { name: "x" }))).body;
    expect(await status(a.id)).toBe(200);
    expect((await admin("/api/admin/review", { id: x.id, decision: "confirmed" })).status).toBe(200);
    expect(await status(a.id)).toBe(404);
    expect(await leaderOf(4, 4, 3)).toBe(x.id);
    expect(await piecesOf(x.id)).toEqual(row(3));
    expect(await drawn(4, 4, 3)).toEqual([x.id]);
    expect((await get("/api/records?N=4&M=4")).body.site_verified).toEqual([]);
  });

  it("keeps one claim at a time, the leading one, with the reviewed entry behind it", async () => {
    const a = (await submit(loose(4, "a"))).body;
    const x1 = (await submit(squares(3, { name: "x1" }))).body;
    // a second, worse claim does not lead, so it is not kept for review
    const x2 = (await submit({ ...squares(3, { name: "x2" }), pieces: row(3, 1.05) })).body;
    expect(x2).toMatchObject({ pending_verification: true, leader: false, id: null });
    const pending = async () =>
      (await get("/api/admin/pending", { authorization: "Bearer secret" })).body.pending.map(
        (p: { id: number }) => p.id,
      );
    expect(await pending()).toEqual([x1.id]);
    // a better claim takes the lead; the one it overtook goes unreviewed, the reviewed entry stays
    const x3 = (await submit(corner("x3"))).body;
    expect(x3).toMatchObject({ pending_verification: true, leader: true });
    expect(await status(x1.id)).toBe(404);
    expect(await pending()).toEqual([x3.id]);
    expect(await piecesOf(a.id)).toEqual(row(3, 4));
    expect(await drawn(4, 4, 3)).toEqual([a.id]);
    expect((await admin("/api/admin/review", { id: x3.id, decision: "rejected" })).status).toBe(200);
    expect(await leaderOf(4, 4, 3)).toBe(a.id);
    expect(await drawn(4, 4, 3)).toEqual([a.id]);
  });

  it("follows the tie rule in what it keeps", async () => {
    // without a claim: an equal score, and a smaller one within the tolerance, do not lead and are not kept
    const L = (await submit(twoCircles(2.5, "L"))).body;
    const E = (await submit(twoCircles(2.5, "E"))).body;
    const H = (await submit(twoCircles(2.5 * (1 - 0.5 * SCORE_TIE), "H"))).body;
    expect(H.score!).toBeLessThan(L.score!);
    expect([E.id, H.id]).toEqual([null, null]);
    expect(await leaderOf(0, 0, 2)).toBe(L.id);

    // behind a claim: an entry as good as the kept one does not replace it; a better one does
    const a = (await submit(loose(4, "a"))).body;
    const x = (await submit(squares(3, { name: "x" }))).body;
    const same = (await submit(loose(4, "same"))).body;
    expect(same).toMatchObject({ score: a.score, leader: false, id: null });
    const closer = (await submit(loose(3.9, "closer"))).body;
    expect(closer.pending_verification).toBe(false);
    expect(closer.score!).toBeLessThan(a.score! * (1 - SCORE_TIE));
    expect(closer).toMatchObject({ leader: false, rank: 2 });
    expect(closer.id).not.toBeNull();
    expect(await status(a.id)).toBe(404);
    expect(await leaderOf(4, 4, 3)).toBe(x.id);
    expect(await drawn(4, 4, 3)).toEqual([closer.id]);
  });
});

describe("GET /api/atlas", () => {
  const lit = (P: number, value: number, extra: Partial<LiteratureRecord> = {}): LiteratureRecord => ({
    ...fakeRecord,
    P,
    value,
    display: String(value),
    display_precision: 6,
    ...extra,
  });
  // 2 squares with published coordinates, 3 and 5 squares with a value only, and a long run of
  // (made-up) circle records that is larger than one response may carry
  const circles = (P: number) => Array.from({ length: P }, (_, i) => ({ x: 2 * i, y: 0, theta: 0 }));
  const records: LiteratureRecord[] = [
    // an unrefereed proof, so that the problem still takes the entries submitted below
    lit(2, 2, { status: "proven_unrefereed", pieces: row(2), container_phi: 0 }),
    fakeRecord,
    lit(5, 2.707107),
    lit(6, 9, { pieces: row(6), container_phi: 0 }),
    ...Array.from({ length: 16 }, (_, i) => lit(450 + i, 900 + 2 * i, { N: 0, M: 0, pieces: circles(450 + i) })),
  ];
  const atlas = async (query: string) => {
    const r = await get(`/api/atlas?${query}`);
    return { status: r.status, body: r.body as AtlasResponse & { error?: string } };
  };

  beforeEach(() => {
    app = createApp({
      store: new SqliteStore(":memory:"),
      records,
      adminToken: "secret",
      clientIp: () => ip,
      log: (m) => logs.push(m),
    });
  });

  it("prefers a verified site entry only when it is at least as good as the published value", () => {
    const rec = lit(7, 3, { pieces: [] });
    expect(atlasSource(undefined, undefined)).toBeNull();
    expect(atlasSource(undefined, lit(7, 3))).toBeNull();
    expect(atlasSource(undefined, rec)).toBe("literature");
    expect(atlasSource({ score: 9 }, undefined)).toBe("verified");
    expect(atlasSource({ score: 2.9 }, rec)).toBe("verified");
    expect(atlasSource({ score: 3.0000000000000004 }, { ...rec, display_precision: 14 })).toBe("verified");
    expect(atlasSource({ score: 3.0000005 }, rec)).toBe("verified"); // within the 6 printed decimals
    expect(atlasSource({ score: 3.00001 }, rec)).toBe("literature");
    expect(atlasSource({ score: 3.00001 }, lit(7, 3))).toBe("verified"); // nothing else to draw
  });

  it("draws a pending entry only when nothing else can be drawn", () => {
    const pending = { score: 2.5 };
    expect(atlasSource(undefined, lit(7, 3), pending)).toBe("pending");
    expect(atlasSource(undefined, undefined, pending)).toBe("pending");
    // published coordinates and verified entries always come first, however good the claim
    expect(atlasSource(undefined, lit(7, 3, { pieces: [] }), pending)).toBe("literature");
    expect(atlasSource({ score: 3 }, lit(7, 3), pending)).toBe("verified");
    expect(atlasSource({ score: 3.4 }, lit(7, 3), pending)).toBe("verified");
    expect(atlasSource({ score: 3.4 }, lit(7, 3, { pieces: [] }), pending)).toBe("literature");
  });

  it("returns the single best drawable packing per P", async () => {
    // only published coordinates so far
    let a = await atlas("N=4&M=4&from=1&to=10");
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ N: 4, M: 4, from: 1, to: 10, next: null });
    expect(a.body.tiles).toEqual([
      { P: 2, source: "literature", score: 2, pieces: row(2), container_phi: 0 },
      { P: 6, source: "literature", score: 9, pieces: row(6), container_phi: 0 },
    ]);

    // a worse site entry does not replace published coordinates, a matching one does
    await submit({ ...squares(2), pieces: row(2, 1.5) });
    expect((await atlas("N=4&M=4&from=2&to=2")).body.tiles[0].source).toBe("literature");
    const match = await submit(squares(2, { name: "bea" }));
    a = await atlas("N=4&M=4&from=2&to=2");
    expect(a.body.tiles).toEqual([
      {
        P: 2,
        source: "site",
        score: match.body.score,
        pieces: row(2),
        container_phi: match.body.container!.phi,
        id: match.body.id,
        verification: "none",
        found_with: "hand",
      },
    ]);

    // no published value (P = 4), and a published value without coordinates that the entry does not reach (P = 5)
    await submit(squares(4, { name: "cy" }));
    await submit(squares(5, { name: "di" }));
    a = await atlas("N=4&M=4");
    expect(a.body.tiles.map((t) => [t.P, t.source])).toEqual([
      [2, "site"],
      [4, "site"],
      [5, "site"],
      [6, "literature"],
    ]);
    expect(a.body.tiles[2].score).toBeGreaterThan(2.71); // auto-oriented row of five, still above the published value
    expect(a.body.tiles.every((t) => t.pieces.length === t.P)).toBe(true);
    // other shapes are not mixed in
    expect((await atlas("N=4&M=3")).body.tiles).toEqual([]);
  });

  const review = (id: number | null, decision: "confirmed" | "rejected") =>
    app.request("/api/admin/review", {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ id, decision }),
    });

  it("marks pending entries and never shows rejected ones", async () => {
    const r = await submit(squares(3));
    expect(r.body.pending_verification).toBe(true);
    let a = await atlas("N=4&M=4&from=3&to=3");
    expect(a.body.tiles[0]).toMatchObject({ P: 3, source: "site", id: r.body.id, verification: "pending" });
    expect((await review(r.body.id, "rejected")).status).toBe(200);
    a = await atlas("N=4&M=4&from=3&to=3");
    expect(a.body.tiles).toEqual([]);
    expect(JSON.stringify((await atlas("N=4&M=4")).body)).not.toContain(`"id":${r.body.id}`);
  });

  it("never lets a pending entry stand in for a verified one", async () => {
    // three squares far apart: a valid entry well above the made-up published value of 5, so not pending
    const loose = await submit({ ...squares(3, { name: "lou" }), pieces: row(3, 4) });
    expect(loose.body.pending_verification).toBe(false);
    expect(loose.body.score).toBeGreaterThan(5);
    const claim = await submit(squares(3, { name: "pat" }));
    expect(claim.body.pending_verification).toBe(true);

    // the listing shows the claim as the site's best entry and the reviewed one beside it
    let records = (await get("/api/records?N=4&M=4")).body;
    expect(records.site.find((e: { P: number }) => e.P === 3)).toMatchObject({
      id: claim.body.id,
      verification: "pending",
    });
    expect(records.site_verified).toEqual([expect.objectContaining({ P: 3, id: loose.body.id, verification: "none" })]);
    // the atlas draws the reviewed entry, although the claim is smaller
    let a = await atlas("N=4&M=4&from=3&to=3");
    expect(a.body.tiles).toEqual([
      expect.objectContaining({ P: 3, source: "site", id: loose.body.id, verification: "none" }),
    ]);

    // a claim against a published value with coordinates is not drawn either (the record for P = 6 is made up)
    const six = await submit(squares(6, { name: "pat" }));
    expect(six.body.pending_verification).toBe(true);
    a = await atlas("N=4&M=4&from=6&to=6");
    expect(a.body.tiles).toEqual([expect.objectContaining({ P: 6, source: "literature", score: 9 })]);
    records = (await get("/api/records?N=4&M=4")).body;
    expect(records.site_verified.map((e: { P: number }) => e.P)).toEqual([3]);

    // once confirmed, the claim is a verified entry like any other
    expect((await review(claim.body.id, "confirmed")).status).toBe(200);
    a = await atlas("N=4&M=4&from=3&to=3");
    expect(a.body.tiles).toEqual([
      expect.objectContaining({ P: 3, source: "site", id: claim.body.id, verification: "confirmed" }),
    ]);
    records = (await get("/api/records?N=4&M=4")).body;
    expect(records.site_verified.map((e: { P: number }) => e.P)).toEqual([]);
    // without anything pending the field is still there, and empty
    expect((await get("/api/records?N=4&M=3")).body.site_verified).toEqual([]);
  });

  it("keeps the records listing current although answers are cached", async () => {
    const admin = (path: string, body: object) =>
      app.request(path, {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const listed = async () =>
      (await get("/api/records?N=4&M=4")).body.site.map((e: { P: number; name: string }) => `${e.P}:${e.name}`);
    expect(await listed()).toEqual([]);
    const loose = await submit({ ...squares(2, { name: "ann" }), pieces: row(2, 3) });
    expect(await listed()).toEqual(["2:ann"]);
    // another pair's listing is not touched by an entry of this one, nor the other way round
    expect((await get("/api/records?N=4&M=3")).body.site).toEqual([]);
    const tight = await submit(squares(2, { name: "bob" }));
    expect(await listed()).toEqual(["2:bob"]);
    expect((await admin("/api/admin/edit", { id: tight.body.id, name: "Bob", found_with: "hand" })).status).toBe(200);
    expect(await listed()).toEqual(["2:Bob"]);
    // ann's entry was deleted when bob's overtook it, so after the removal nothing is listed
    expect((await admin("/api/admin/remove", { id: tight.body.id })).status).toBe(200);
    expect(await listed()).toEqual([]);
    expect((await get(`/api/submissions/${loose.body.id}`)).status).toBe(404);
  });

  it("bounds the range and the payload", async () => {
    for (const bad of [
      "M=4",
      "N=4&M=2",
      "N=4&M=4&from=0",
      "N=4&M=4&from=5&to=4",
      "N=4&M=4&from=1.5&to=3",
      "N=4&M=4&from=x",
      "N=4&M=4&to=501",
      `N=4&M=4&from=1&to=${ATLAS_MAX_SPAN + 1}`,
      // empty values are not circles, and only plain decimal integers are numbers here
      "N=&M=",
      "N=4&M=",
      "N=&M=4",
      "N=4&M=4&from=",
      "N=4&M=4&to=",
      "N=4&M=4&from=0x10",
      "N=4&M=4&from=1e2",
      "N=4&M=4&to=1e1",
      "N=4.0&M=4",
      "N=+4&M=4",
      "N=4&M=4&from=-1",
      "N=4&M=4&from=%201",
    ]) {
      const r = await atlas(bad);
      expect([bad, r.status]).toEqual([bad, 400]);
      expect(r.body.error).toBeTruthy();
    }
    expect((await atlas(`N=4&M=4&from=401&to=${400 + ATLAS_MAX_SPAN}`)).status).toBe(200);
    // the default range ends at the largest P
    expect((await atlas("N=0&M=0&from=450")).body.to).toBe(500);

    // sixteen drawings of 450 to 465 circles: more than one answer may carry
    const count = (t: AtlasResponse) => t.tiles.reduce((n, tile) => n + tile.pieces.length, 0);
    const seen: number[] = [];
    let from: number | null = 440;
    let answers = 0;
    while (from !== null) {
      const part: { body: AtlasResponse } = await atlas(`N=0&M=0&from=${from}&to=470`);
      answers++;
      expect(part.body.tiles.length).toBeGreaterThan(0);
      expect(count(part.body)).toBeLessThanOrEqual(ATLAS_MAX_PIECES);
      // an answer is cut only when the next drawing would not fit
      if (part.body.next !== null) {
        expect(part.body.next).toBe(part.body.tiles[part.body.tiles.length - 1].P + 1);
        expect(count(part.body) + part.body.next).toBeGreaterThan(ATLAS_MAX_PIECES);
      }
      seen.push(...part.body.tiles.map((t) => t.P));
      from = part.body.next;
    }
    expect(answers).toBeGreaterThan(1);
    expect(seen).toEqual(Array.from({ length: 16 }, (_, i) => 450 + i));
  });

  it("caps the ids of one store lookup", async () => {
    const store = new SqliteStore(":memory:");
    expect(await store.getMany([])).toEqual([]);
    expect(await store.getMany(Array.from({ length: GET_MANY_LIMIT }, (_, i) => i + 1))).toEqual([]);
    await expect(store.getMany(Array.from({ length: GET_MANY_LIMIT + 1 }, (_, i) => i + 1))).rejects.toThrow(
      RangeError,
    );
  });

  it("compresses the coordinates for clients that accept it", async () => {
    const plain = await app.request("/api/atlas?N=0&M=0&from=450&to=455");
    expect(plain.headers.get("content-encoding")).toBeNull();
    const text = await plain.text();
    const packed = await app.request("/api/atlas?N=0&M=0&from=450&to=455", { headers: { "accept-encoding": "gzip" } });
    expect(packed.headers.get("content-encoding")).toBe("gzip");
    const bytes = new Uint8Array(await packed.arrayBuffer());
    expect(bytes.length).toBeLessThan(text.length / 3);
    const unpacked = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
    expect(unpacked).toBe(text);
  });

  it("is documented", async () => {
    const html = await (await app.request("/api")).text();
    expect(html).toContain("GET /api/atlas?N=&amp;M=&amp;from=&amp;to=");
    expect(html).toContain(`at most ${ATLAS_MAX_SPAN} values`);
  });
});

describe("GET /api/holders", () => {
  const rec = (
    P: number,
    value: number,
    display_precision: number,
    status: LiteratureRecord["status"] = "best_known",
  ) => ({
    ...fakeRecord,
    P,
    value,
    display: value.toFixed(display_precision),
    display_precision,
    status,
  });
  const entry = (
    M: number,
    P: number,
    score: number,
    name: string,
    verification: NewSubmission["verification"] = "none",
  ): NewSubmission => ({
    N: 4,
    M,
    P,
    score,
    name,
    agent_note: "",
    found_with: "hand",
    method: null,
    method_params: null,
    seed: null,
    budget: null,
    software: null,
    pieces: [],
    container_phi: 0,
    created_at: "2026-10-21T00:00:00.000Z",
    verification,
    literature_value: null,
    strict_check: null,
  });
  const holders = async () => (await get("/api/holders")).body.holders;

  it("counts the leader of every open problem by its exact name", async () => {
    const store = new SqliteStore(":memory:");
    // squares in a square: 2 proven, 3 published as 5.00, 4 as 3.5, 6 as 4, 7 as 5.00
    const records = [rec(2, 2, 6, "proven"), fakeRecord, rec(4, 3.5, 6), rec(6, 4, 6), rec(7, 5, 2)];
    for (const e of [
      // no published value: the lead is the record
      entry(4, 1, 1, "ann"),
      // a closed problem is left out
      entry(4, 2, 2, "ann"),
      // reaches 3.5 to the six printed decimals
      entry(4, 4, 3.5000000001, "ann"),
      // below 5.00 by more than its precision, and confirmed
      entry(4, 3, 4.9, "bob", "confirmed"),
      entry(4, 5, 6, "bob"),
      // worse than the published 4: a site best, not a record
      entry(4, 6, 4.5, "cat"),
      // a claim awaiting review, with the reviewed entry kept behind it, which leads nothing
      entry(4, 7, 5.5, "eve"),
      entry(4, 7, 4, "dan", "pending"),
      // another case is another name
      entry(3, 1, 1, "Ann"),
      // equal scores: the earlier entry leads
      entry(5, 1, 1, "fay"),
      entry(5, 1, 1, "gus"),
    ])
      await store.insert(e);
    app = createApp({ store, records, adminToken: "secret", clientIp: () => ip, log: (m) => logs.push(m) });
    const row = (name: string, records: number, beat_published: number, site_bests: number, pending = 0) => ({
      name,
      records,
      beat_published,
      site_bests,
      pending,
    });
    // most records first, then most site bests, then by name, capitals first
    expect(await holders()).toEqual([
      row("ann", 2, 0, 2),
      row("bob", 2, 1, 2),
      row("Ann", 1, 0, 1),
      row("fay", 1, 0, 1),
      row("cat", 0, 0, 1),
      row("dan", 0, 0, 1, 1),
    ]);
  });

  it("follows every change although answers are kept", async () => {
    const admin = (path: string, body: object) =>
      app.request(path, {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const names = async () =>
      (await holders()).map((h: { name: string; site_bests: number }) => `${h.name}:${h.site_bests}`);
    expect(await holders()).toEqual([]);
    const two = await submit(squares(2, { name: "ann" }));
    await submit(squares(4, { name: "ann" }));
    expect(await names()).toEqual(["ann:2"]);
    // a lead taken in another pair of shapes
    await submit({ ...squares(2, { name: "bob" }), M: 5 });
    expect(await names()).toEqual(["ann:2", "bob:1"]);
    // a pending claim (three squares against the made-up 5.00) is a site best, not yet a record
    const claim = await submit(squares(3, { name: "bob" }));
    expect(claim.body.pending_verification).toBe(true);
    expect((await holders())[1]).toEqual({ name: "bob", records: 1, beat_published: 0, site_bests: 2, pending: 1 });
    expect((await admin("/api/admin/review", { id: claim.body.id, decision: "confirmed" })).status).toBe(200);
    // level with ann now, and after her by name
    expect((await holders())[1]).toEqual({ name: "bob", records: 2, beat_published: 1, site_bests: 2, pending: 0 });
    expect((await admin("/api/admin/edit", { id: two.body.id, name: "Ann" })).status).toBe(200);
    expect(await names()).toEqual(["bob:2", "Ann:1", "ann:1"]);
    expect((await admin("/api/admin/remove", { id: two.body.id })).status).toBe(200);
    expect(await names()).toEqual(["bob:2", "ann:1"]);
  });

  it("is documented, as current", async () => {
    const html = await (await app.request("/api")).text();
    expect(html).toContain("GET /api/holders");
    expect(html).toContain("The counts follow every entry as it changes, so the answer is current.");
    // the counts are current; it is the page of one name (GET /api/holder, the next section) that is kept for a while
    const section = html.slice(html.indexOf('id="holders"'), html.indexOf('id="holder"'));
    expect(section).toContain("GET /api/holders");
    expect(section).not.toContain("15 minutes");
  });
});

// The record holders' counts are kept by the server: built once, in steps, and moved by every change of an
// entry (see createApp). Each test below holds them to the count the route gave before they were kept: the
// leaders of all problems, read at once and counted in one pass.
describe("GET /api/holders: the counts kept", () => {
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const adminPost = (path: string, body: object) =>
    app.request(path, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const published = (
    M: number,
    P: number,
    value: number,
    status: LiteratureRecord["status"] = "best_known",
  ): LiteratureRecord => ({
    ...fakeRecord,
    N: 4,
    M,
    P,
    value,
    display: value.toFixed(6),
    display_precision: 6,
    status,
  });
  // an entry for the store itself, without a packing
  const raw = (
    M: number,
    P: number,
    score: number,
    name: string,
    verification: NewSubmission["verification"] = "none",
  ): NewSubmission => ({
    N: 4,
    M,
    P,
    score,
    name,
    agent_note: "",
    found_with: "hand",
    method: null,
    method_params: null,
    seed: null,
    budget: null,
    software: null,
    pieces: [],
    container_phi: 0,
    created_at: "2026-10-21T00:00:00.000Z",
    verification,
    literature_value: null,
    strict_check: null,
  });
  // the count as it was before the counts were kept: every leader read at once, counted in one pass
  const counted = (all: ProblemLeader[], records: LiteratureRecord[]): string => {
    const literature = new Map(records.map((r) => [`${r.N}/${r.M}/${r.P}`, r]));
    const byName = new Map<string, Holder>();
    for (const e of all) {
      const lit = literature.get(`${e.N}/${e.M}/${e.P}`);
      if (closedToSubmissions(lit)) continue;
      let h = byName.get(e.name);
      if (!h) byName.set(e.name, (h = { name: e.name, records: 0, beat_published: 0, site_bests: 0, pending: 0 }));
      h.site_bests++;
      if (e.verification === "pending") h.pending++;
      else if (!lit || reachesLiterature(e.score, lit)) {
        h.records++;
        if (lit && beatsLiterature(e.score, lit)) h.beat_published++;
      }
    }
    const list = [...byName.values()].sort(
      (a, b) =>
        b.records - a.records || b.site_bests - a.site_bests || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    return JSON.stringify({ holders: list } satisfies HoldersResponse);
  };
  const prng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // The store as the app sees it: every call counted, and with `hosted` each one answering after a turn of the
  // event loop on either side, as a store over a network does.
  const watched = (store: SqliteStore, hosted = false) => {
    const calls: Record<string, number> = {};
    const seen = new Proxy(store, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function" || typeof key !== "string") return value;
        return async (...args: unknown[]) => {
          calls[key] = (calls[key] ?? 0) + 1;
          if (hosted) await tick();
          const result = await value.apply(target, args);
          if (hosted) await tick();
          return result;
        };
      },
    });
    return { seen, calls };
  };
  const text = async () => (await app.request("/api/holders")).text();
  const NAMES = ["ann", "Ann", "bob", "cat", "dan", "eve", "fay"];

  // A store with entries as an older server left them, among them claims awaiting review and entries of closed
  // problems, an app on it, and a random walk of changes through the routes: submissions (new problems,
  // improvements, ties, claims that beat a published value), reviews, removals and renames.
  const world = async (seed: number, o: { chunk: number; hosted?: boolean }) => {
    const rand = prng(seed);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const GAPS = [1, 1.05, 1.1, 1.15, 1.2, 1.3];
    const row4 = (M: number, P: number, gap: number) =>
      evaluate({ ...squares(P), M, pieces: row(P, gap) }).score as number;
    // squares in a row in a container of M sides: of the problems that arrive through the routes, some have no
    // published value, some one the closest rows reach or beat, some one a loose row does not, some are closed
    const records: LiteratureRecord[] = [];
    for (const M of [4, 0, 5])
      for (let P = 1; P <= 6; P++) {
        const kind = (M + 2 * P) % 4;
        if (kind === 1) records.push(published(M, P, row4(M, P, 1.15)));
        if (kind === 2) records.push(published(M, P, row4(M, P, 1), "proven"));
        if (kind === 3) records.push(published(M, P, row4(M, P, 1.3)));
      }
    const store = new SqliteStore(":memory:");
    for (let k = 0; k < 24; k++)
      await store.insert(
        raw(
          pick([4, 0, 5, 6, 7, 8]),
          1 + Math.floor(rand() * 8),
          1 + rand() * 20,
          pick(NAMES),
          pick(["none", "none", "none", "pending", "confirmed"] as const),
        ),
      );
    const { seen, calls } = watched(store, o.hosted);
    app = createApp({
      store: seen,
      records,
      adminToken: "secret",
      clientIp: () => ip,
      log: () => {},
      limits: { perIp: 1_000_000, verifyMsPerMinute: 1e9 },
      holdersChunk: o.chunk,
    });
    const done = { submitted: 0, confirmed: 0, rejected: 0, removed: 0, renamed: 0 };
    let fresh = 0;
    const step = async () => {
      const r = rand();
      if (r < 0.55) {
        const P = 1 + Math.floor(rand() * 6);
        const name = rand() < 0.1 ? `new${fresh++}` : pick(NAMES);
        const sent = await submit({ ...squares(P, { name }), M: pick([4, 0, 5]), pieces: row(P, pick(GAPS)) });
        if (sent.status === 200) done.submitted++;
        return;
      }
      const leaders = await store.leaders();
      const some = () => (leaders.length ? pick(leaders).id : 1);
      // an id that is no longer listed, now and then
      const id = rand() < 0.1 ? 1 + Math.floor(rand() * 400) : some();
      let answer: Response;
      if (r < 0.7) {
        const claims = await store.pending();
        const decision = pick(["confirmed", "rejected"] as const);
        answer = await adminPost("/api/admin/review", { id: claims.length ? pick(claims).id : id, decision });
        if (answer.status === 200) done[decision]++;
      } else if (r < 0.82) {
        answer = await adminPost("/api/admin/remove", { id });
        if (answer.status === 200) done.removed++;
      } else {
        // a new name, an old one in other letters, or a note only
        const change =
          rand() < 0.25 ? { agent_note: "checked" } : { name: rand() < 0.2 ? `new${fresh++}` : pick(NAMES) };
        answer = await adminPost("/api/admin/edit", { id, ...change });
        if (answer.status === 200 && "name" in change) done.renamed++;
      }
      expect(answer.status).toBeLessThan(500);
    };
    const truth = async () => counted(await store.leaders(), records);
    return { store, records, calls, done, step, truth };
  };

  it("equals the count of all leaders at once after every few changes", async () => {
    const seen = { claim: false, beat: false, lead: false, gone: false };
    const total = { submitted: 0, confirmed: 0, rejected: 0, removed: 0, renamed: 0 };
    // seeds 7 and 8 on a store that answers after a round trip; the first count begins at a different step of each
    for (const [seed, begins] of [
      [1, 0],
      [2, 7],
      [3, 19],
      [4, 31],
      [5, 2],
      [6, 53],
      [7, 0],
      [8, 11],
    ] as const) {
      const w = await world(seed, { chunk: 3, hosted: seed >= 7 });
      let before = "";
      for (let i = 0; i < 120; i++) {
        // the steps that follow go on while the first count runs
        const counting = i === begins ? text() : null;
        await w.step();
        if (i >= begins && i % 3 === 2) {
          const answer = await text();
          const truth = await w.truth();
          expect(answer).toBe(truth);
          const list = (JSON.parse(truth) as HoldersResponse).holders;
          seen.claim ||= list.some((h) => h.pending > 0);
          seen.beat ||= list.some((h) => h.beat_published > 0);
          seen.lead ||= list.some((h) => h.site_bests > h.records);
          seen.gone ||= before !== "" && list.length < (JSON.parse(before) as HoldersResponse).holders.length;
          before = truth;
        }
        await counting;
      }
      for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += w.done[k];
    }
    // the walk did what it is meant to: every kind of change happened, and the states they make
    for (const n of Object.values(total)) expect(n).toBeGreaterThan(5);
    expect(seen).toEqual({ claim: true, beat: true, lead: true, gone: true });
  });

  it("reads no table again once the counts are built, however entries keep changing", async () => {
    const w = await world(11, { chunk: 5 });
    expect(await text()).toBe(await w.truth());
    const pages = w.calls.leadersAfter!;
    // 24 entries of the store, in a few problems, five at a page
    expect(pages).toBeGreaterThan(1);
    expect(w.calls.leaders).toBeUndefined();
    for (let i = 0; i < 40; i++) {
      await w.step();
      if (i % 4 === 0) expect(await text()).toBe(await w.truth());
    }
    expect(w.calls.leadersAfter).toBe(pages);
    expect(w.calls.leaders).toBeUndefined();
    expect(w.calls.pairs).toBeUndefined();
    // an administrator's change reads its problem's leader before and after, whatever the size of the table
    expect(w.calls.get).toBeGreaterThan(5);
    expect(w.calls.leadersOf).toBeLessThanOrEqual(2 * w.calls.get!);
  });

  it("keeps the answer until the counts change", async () => {
    const stringified = vi.spyOn(JSON, "stringify");
    try {
      const answers = () =>
        stringified.mock.calls.filter(([v]) => typeof v === "object" && v !== null && "holders" in v).length;
      const names = async () => JSON.parse(await text()).holders.map((h: Holder) => `${h.name}:${h.site_bests}`);
      expect(await names()).toEqual([]);
      expect(await names()).toEqual([]);
      expect(answers()).toBe(1);
      // a first lead
      expect((await submit(squares(2, { name: "ann", pieces: row(2, 1.1) }))).body.leader).toBe(true);
      expect(await names()).toEqual(["ann:1"]);
      expect(await names()).toEqual(["ann:1"]);
      expect(answers()).toBe(2);
      // entries that change no one's counts: a worse one, a tie, a better one by the same name, a note
      expect((await submit(squares(2, { name: "bob", pieces: row(2, 1.2) }))).body.rank).toBe(2);
      expect((await submit(squares(2, { name: "bob", pieces: row(2, 1.1) }))).body.rank).toBe(2);
      const better = await submit(squares(2, { name: "ann", pieces: row(2, 1.05) }));
      expect(better.body.leader).toBe(true);
      expect((await adminPost("/api/admin/edit", { id: better.body.id, agent_note: "checked" })).status).toBe(200);
      expect(await names()).toEqual(["ann:1"]);
      expect(answers()).toBe(2);
      // the lead taken by another name, and that entry renamed
      const taken = await submit(squares(2, { name: "bob", pieces: row(2, 1.001) }));
      expect(taken.body.leader).toBe(true);
      expect(await names()).toEqual(["bob:1"]);
      expect(await names()).toEqual(["bob:1"]);
      expect(answers()).toBe(3);
      expect((await adminPost("/api/admin/edit", { id: taken.body.id, name: "Bob" })).status).toBe(200);
      expect(await names()).toEqual(["Bob:1"]);
      expect(answers()).toBe(4);
    } finally {
      stringified.mockRestore();
    }
  });

  it("builds in steps that let the event loop in between, and requests that arrive meanwhile share them", async () => {
    // 47 pairs of 50 problems: five steps of the default size
    const store = new SqliteStore(":memory:");
    for (let M = 4; M < 51; M++) for (let P = 1; P <= 50; P++) await store.insert(raw(M, P, P, `n${(M * P) % 7}`));
    const problems = 47 * 50;
    const { seen, calls } = watched(store);
    app = createApp({ store: seen, records: [], adminToken: "secret", clientIp: () => ip, log: () => {} });
    const events: string[] = [];
    const real = store.leadersAfter.bind(store);
    vi.spyOn(store, "leadersAfter").mockImplementation(async (after, limit) => {
      expect(limit).toBe(HOLDERS_CHUNK);
      events.push("step");
      return real(after, limit);
    });
    let ticking = true;
    const beat = () => {
      if (!ticking) return;
      events.push("tick");
      setImmediate(beat);
    };
    // three requests, and a callback scheduled just after the build began
    const answers = [text(), text(), text()];
    setImmediate(beat);
    const bodies = await Promise.all(answers);
    ticking = false;
    expect(bodies[1]).toBe(bodies[0]);
    expect(bodies[2]).toBe(bodies[0]);
    expect(bodies[0]).toBe(counted(await store.leaders(), []));
    const steps = events.filter((e) => e === "step").length;
    expect(steps).toBe(Math.floor(problems / HOLDERS_CHUNK) + 1);
    expect(calls.leadersAfter).toBe(steps);
    // the callback ran before the build was over, and the loop got a turn between every two steps
    expect(events.indexOf("tick")).toBeLessThan(events.lastIndexOf("step"));
    expect(events.join(" ")).not.toMatch(/step step/);
    expect(events[0]).toBe("step");
  });

  it("counts a change made during the build once, where the build has been, is, and has yet to go", async () => {
    // 4/4 with P = 1 .. 8 but 3, then 4/5 with P = 1 .. 4; two problems to a step, so six steps
    const store = new SqliteStore(":memory:");
    const id = new Map<string, number>();
    for (const [M, P] of [
      [4, 1],
      [4, 2],
      [4, 4],
      [4, 5],
      [4, 6],
      [4, 7],
      [4, 8],
      [5, 1],
      [5, 2],
      [5, 3],
      [5, 4],
    ] as const)
      id.set(
        `${M}/${P}`,
        await store.insert(
          raw(M, P, 100 + P, M === 4 && P <= 5 ? "ann" : "bob", P === 7 || (M === 5 && P === 4) ? "pending" : "none"),
        ),
      );
    app = createApp({
      store,
      records: [],
      adminToken: "secret",
      clientIp: () => ip,
      log: () => {},
      holdersChunk: 2,
    });
    // the third step reads its rows at once and gives them when the gate opens, as a store does after a round trip
    const real = store.leadersAfter.bind(store);
    let steps = 0;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let reached!: () => void;
    const inFlight = new Promise<void>((resolve) => (reached = resolve));
    vi.spyOn(store, "leadersAfter").mockImplementation(async (after, limit) => {
      const rows = await real(after, limit);
      if (++steps === 3) {
        reached();
        await gate;
      }
      return rows;
    });
    const counting = text();
    await inFlight;
    // The build holds 4/4/1 .. 4/4/5; the step in flight has read 4/4/6 and 4/4/7; the rest is to come.
    const changes = [
      // where it has been: a better entry, a problem emptied, a problem that had nothing
      submit(squares(1, { name: "cat" })),
      adminPost("/api/admin/remove", { id: id.get("4/2") }),
      submit(squares(3, { name: "dan" })),
      // where it is: a better entry; a claim renamed
      submit(squares(6, { name: "eve" })),
      adminPost("/api/admin/edit", { id: id.get("4/7"), name: "fay" }),
      // where it has yet to go: a better entry, a claim confirmed, a problem that has nothing yet
      submit({ ...squares(3, { name: "gus" }), M: 5 }),
      adminPost("/api/admin/review", { id: id.get("5/4"), decision: "confirmed" }),
      submit({ ...squares(9, { name: "hal" }), M: 5, pieces: row(9) }),
    ];
    await settle();
    open();
    for (const answer of await Promise.all(changes)) expect(answer.status).toBe(200);
    const answer = await counting;
    expect(answer).toBe(counted(await store.leaders(), []));
    expect(steps).toBeGreaterThanOrEqual(6);
    // and the counts stand as the changes left them
    const holders = (JSON.parse(answer) as HoldersResponse).holders;
    const who = (name: string, records: number, site_bests: number, pending = 0) => ({
      name,
      records,
      beat_published: 0,
      site_bests,
      pending,
    });
    expect(holders).toContainEqual(who("ann", 2, 2));
    expect(holders).toContainEqual(who("bob", 4, 4));
    expect(holders).toContainEqual(who("fay", 0, 1, 1));
    expect(holders).toContainEqual(who("cat", 1, 1));
    expect(await text()).toBe(answer);
  });

  it("counts changes that arrive together while a store over a network is read", async () => {
    let during = 0;
    for (const seed of [21, 22, 23, 24]) {
      const w = await world(seed, { chunk: 2, hosted: true });
      let over = false;
      const counting = text().then(() => (over = true));
      for (let round = 0; round < 6; round++) {
        await Promise.all([w.step(), w.step(), w.step(), w.step()]);
        if (!over) during += 4;
      }
      await counting;
      expect(await text()).toBe(await w.truth());
    }
    // some of the changes came while the build was running
    expect(during).toBeGreaterThan(0);
  });

  it("counts again from the start after a change it could not follow", async () => {
    const w = await world(31, { chunk: 4 });
    expect(await text()).toBe(await w.truth());
    const pages = w.calls.leadersAfter!;
    // the entry is removed, then the leader of its problem cannot be read
    const store = w.store;
    const leader = (await store.leaders()).find((l) => l.verification === "none")!;
    const real = store.leadersOf.bind(store);
    let reads = 0;
    vi.spyOn(store, "leadersOf").mockImplementation(async (problems) => {
      if (++reads === 2) throw new Error("the disk is gone");
      return real(problems);
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await adminPost("/api/admin/remove", { id: leader.id })).status).toBe(500);
    } finally {
      quiet.mockRestore();
    }
    expect(await store.get(leader.id)).toBeNull();
    // the next request counts the table again, and the answer is right
    expect(await text()).toBe(await w.truth());
    expect(w.calls.leadersAfter).toBeGreaterThan(pages);
  });

  it("gives a leader's share of its name's counts", () => {
    const lead = (score: number, verification: ProblemLeader["verification"] = "none"): ProblemLeader => ({
      N: 4,
      M: 4,
      P: 3,
      id: 1,
      name: "ann",
      score,
      verification,
    });
    const share = (records: number, beat_published: number, pending = 0) => ({
      name: "ann",
      records,
      beat_published,
      site_bests: 1,
      pending,
    });
    // a published value of 5 to six decimals
    const lit = published(4, 3, 5);
    expect(holderShare(lead(4.9), lit)).toEqual(share(1, 1));
    expect(holderShare(lead(5.0000005), lit)).toEqual(share(1, 0));
    expect(holderShare(lead(5.1), lit)).toEqual(share(0, 0));
    // until it is reviewed, a claim is not the record
    expect(holderShare(lead(4.9, "pending"), lit)).toEqual(share(0, 0, 1));
    expect(holderShare(lead(4.9, "confirmed"), lit)).toEqual(share(1, 1));
    // no published value: the lead is the record, and there is nothing to beat
    expect(holderShare(lead(40), undefined)).toEqual(share(1, 0));
    expect(holderShare(lead(40, "pending"), undefined)).toEqual(share(0, 0, 1));
    // a closed problem counts for no one
    expect(holderShare(lead(4.9), published(4, 3, 5, "proven"))).toBeNull();
    expect(holderShare(lead(4.9), published(4, 3, 5, "trivial_tiling"))).toBeNull();
  });
});

// What one name holds (GET /api/holder): the problems it leads, by pair of shapes. The totals are the name's row of
// GET /api/holders. The answers are kept per name (see createApp), so most of the tests below are about when a kept
// answer may still be given.
describe("GET /api/holder", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const adminPost = (path: string, body: object) =>
    app.request(path, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const published = (
    M: number,
    P: number,
    value: number,
    status: LiteratureRecord["status"] = "best_known",
  ): LiteratureRecord => ({
    ...fakeRecord,
    N: 4,
    M,
    P,
    value,
    display: value.toFixed(6),
    display_precision: 6,
    status,
  });
  // an entry for the store itself, without a packing
  const raw = (
    N: number,
    M: number,
    P: number,
    score: number,
    name: string,
    verification: NewSubmission["verification"] = "none",
  ): NewSubmission => ({
    N,
    M,
    P,
    score,
    name,
    agent_note: "",
    found_with: "hand",
    method: null,
    method_params: null,
    seed: null,
    budget: null,
    software: null,
    pieces: [],
    container_phi: 0,
    created_at: "2026-10-21T00:00:00.000Z",
    verification,
    literature_value: null,
    strict_check: null,
  });
  const prng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /** The clock of the app, which the tests move: milliseconds since the epoch. */
  const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
  let now = T0;
  /**
   * An app on `store` (the one `get` and `submit` talk to), with a count of the reads that answers make:
   * `names` answers begun (a first page), `pages` pages of problems read.
   */
  const open = (store: SqliteStore, records: LiteratureRecord[] = [], more: Partial<AppOptions> = {}) => {
    const reads = { names: 0, pages: 0 };
    const seen = new Proxy(store, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (key === "problemsNamed") {
            reads.pages++;
            if (args[1] === null) reads.names++;
          }
          return value.apply(target, args);
        };
      },
    });
    now = T0;
    app = createApp({
      store: seen,
      records,
      adminToken: "secret",
      clientIp: () => ip,
      log: () => {},
      limits: { perIp: 1_000_000, verifyMsPerMinute: 1e9 },
      clock: () => now,
      ...more,
    });
    return reads;
  };
  const holder = (name: string) => get(`/api/holder?name=${encodeURIComponent(name)}`);
  const zero = (name: string, computed_at = new Date(T0).toISOString()) => ({
    name,
    records: 0,
    beat_published: 0,
    site_bests: 0,
    pending: 0,
    computed_at,
    pairs: [],
  });
  const pair = (N: number, M: number, P: number[], records = P.length, beat_published = 0, pending = 0) => ({
    N,
    M,
    P,
    records,
    beat_published,
    pending,
  });

  it("gives what a name leads by pair of shapes, with the totals of its row in /api/holders", async () => {
    const store = new SqliteStore(":memory:");
    // squares in a square: 2 is proven, 3 published as 5, 4 as 3.5, 6 as 4, 7 as 5
    const records = [
      published(4, 2, 2, "proven"),
      published(4, 3, 5),
      published(4, 4, 3.5),
      published(4, 6, 4),
      published(4, 7, 5),
    ];
    for (const e of [
      // ann: no published value; a closed problem, left out; one that reaches the published value; and more
      raw(4, 4, 1, 1, "ann"),
      raw(4, 4, 2, 2, "ann"),
      raw(4, 4, 4, 3.5000000001, "ann"),
      raw(4, 5, 1, 1, "ann"),
      raw(4, 5, 2, 1, "ann"),
      raw(4, 5, 3, 1, "ann"),
      raw(0, 4, 1, 1, "ann"),
      // a pair with a smaller N, and as many problems as (4, 4) has
      raw(3, 3, 1, 1, "ann"),
      raw(3, 3, 2, 1, "ann"),
      // bob: below the published 5, and confirmed; worse than the published 4, a lead and no record; and an entry
      // behind ann's, which leads
      raw(4, 4, 3, 4.9, "bob", "confirmed"),
      raw(4, 4, 6, 9, "bob"),
      raw(4, 5, 2, 2, "bob"),
      // a claim awaiting review, with the reviewed entry kept behind it, which leads nothing
      raw(4, 4, 7, 5.5, "eve"),
      raw(4, 4, 7, 4, "dan", "pending"),
    ])
      await store.insert(e);
    open(store, records);
    expect((await holder("ann")).body).toEqual({
      name: "ann",
      records: 8,
      beat_published: 0,
      site_bests: 8,
      pending: 0,
      computed_at: new Date(T0).toISOString(),
      // most problems first, then by N, then by M
      pairs: [pair(4, 5, [1, 2, 3]), pair(3, 3, [1, 2]), pair(4, 4, [1, 4]), pair(0, 4, [1])],
    });
    expect((await holder("bob")).body).toEqual({
      name: "bob",
      records: 1,
      beat_published: 1,
      site_bests: 2,
      pending: 0,
      computed_at: new Date(T0).toISOString(),
      pairs: [pair(4, 4, [3, 6], 1, 1)],
    });
    // the claim leads, and is not a record until it is confirmed; the entry behind it leads nothing
    expect((await holder("dan")).body).toEqual({
      name: "dan",
      records: 0,
      beat_published: 0,
      site_bests: 1,
      pending: 1,
      computed_at: new Date(T0).toISOString(),
      pairs: [pair(4, 4, [7], 0, 0, 1)],
    });
    expect((await holder("eve")).body).toEqual(zero("eve"));
    // every row of /api/holders is the totals of the answer, and the pairs add up to them
    const rows = (await get("/api/holders")).body.holders as Holder[];
    expect(rows.map((h) => h.name).sort()).toEqual(["ann", "bob", "dan"]);
    for (const h of rows) {
      const body = (await holder(h.name)).body as HolderResponse;
      expect({ name: body.name, records: body.records, beat_published: body.beat_published }).toEqual({
        name: h.name,
        records: h.records,
        beat_published: h.beat_published,
      });
      expect([body.site_bests, body.pending]).toEqual([h.site_bests, h.pending]);
      const sum = (key: "records" | "beat_published" | "pending") => body.pairs.reduce((n, p) => n + p[key], 0);
      expect(body.pairs.reduce((n, p) => n + p.P.length, 0)).toBe(h.site_bests);
      expect([sum("records"), sum("beat_published"), sum("pending")]).toEqual([h.records, h.beat_published, h.pending]);
    }
  });

  it("does not give a problem to a name that has an entry in it but does not lead it", async () => {
    const store = new SqliteStore(":memory:");
    for (const e of [
      // the claim leads, and the record it displaced is kept behind it
      raw(4, 4, 1, 3, "ann"),
      raw(4, 4, 1, 2, "bob", "pending"),
      // a near tie: the earlier entry leads although the later one is smaller, by less than the tolerance
      raw(4, 5, 1, 1 + SCORE_TIE / 4, "early"),
      raw(4, 5, 1, 1, "late"),
      // beyond the tolerance, the smaller leads
      raw(4, 6, 1, 1 + 4 * SCORE_TIE, "slow"),
      raw(4, 6, 1, 1, "quick"),
    ])
      await store.insert(e);
    open(store);
    expect((await holder("ann")).body).toEqual(zero("ann"));
    expect((await holder("bob")).body).toEqual({
      ...zero("bob"),
      site_bests: 1,
      pending: 1,
      pairs: [pair(4, 4, [1], 0, 0, 1)],
    });
    expect((await holder("late")).body).toEqual(zero("late"));
    expect((await holder("early")).body).toEqual({
      ...zero("early"),
      records: 1,
      site_bests: 1,
      pairs: [pair(4, 5, [1])],
    });
    expect((await holder("slow")).body).toEqual(zero("slow"));
    expect((await holder("quick")).body).toEqual({
      ...zero("quick"),
      records: 1,
      site_bests: 1,
      pairs: [pair(4, 6, [1])],
    });
    // and /api/holders agrees on who leads
    const names = ((await get("/api/holders")).body.holders as Holder[]).map((h) => h.name);
    expect(names.sort()).toEqual(["bob", "early", "quick"]);
  });

  it("matches the name exactly, whatever its characters", async () => {
    const store = new SqliteStore(":memory:");
    const names = [
      "ann",
      "Ann",
      "ANN",
      "ann ",
      "Ann Lee",
      "Zoë Ångström ☃ 数学",
      "é",
      "a/b",
      "../a",
      "a+b",
      "a&b=c",
      "100% sure",
      "#1 ?x",
      "50%25",
      "%E2%98%83",
      "a\\b",
      "'; DROP TABLE submissions; --",
      "a_",
      "a%",
    ];
    for (const [i, name] of names.entries()) await store.insert(raw(4, 4, i + 1, 1, name));
    open(store);
    for (const [i, name] of names.entries()) {
      const { status, body } = await holder(name);
      expect(status).toBe(200);
      expect(body).toEqual({ ...zero(name), records: 1, site_bests: 1, pairs: [pair(4, 4, [i + 1])] });
    }
    // not a part of a name, another normalisation of it, or an escaped one
    for (const name of ["an", "nn", "ann  ", "Ann  Lee", "é", "e", "a", "%", "a b", "ann\0", "%61nn"])
      expect((await holder(name)).body).toEqual(zero(name));
    // an address that does not decode is a name like any other
    const odd = await get("/api/holder?name=%E0%A4%A");
    expect(odd.status).toBe(200);
    // the name is not a path segment
    expect((await get("/api/holder/ann")).status).toBe(404);
  });

  it("answers an unknown name with zeros, and refuses a missing, empty or too long one", async () => {
    open(new SqliteStore(":memory:"));
    expect(await holder("nobody")).toEqual({ status: 200, body: zero("nobody") });
    const refused = [
      "/api/holder",
      "/api/holder?name=",
      "/api/holder?name",
      "/api/holder?other=ann",
      `/api/holder?name=${"a".repeat(41)}`,
      `/api/holder?name=${"é".repeat(41)}`,
    ];
    for (const path of refused) {
      const { status, body } = await get(path);
      expect([path, status]).toEqual([path, 400]);
      expect(typeof body.error).toBe("string");
    }
    // 40 characters is the longest name there is
    expect((await holder("a".repeat(40))).status).toBe(200);
    expect((await holder("é".repeat(40))).status).toBe(200);
  });

  it("is documented, with its age", async () => {
    const html = await (await app.request("/api")).text();
    expect(html).toContain("GET /api/holder?name=");
    expect(html).toContain("The answer can be up to 15 minutes old");
    expect(html).toContain("<code>computed_at</code>");
    expect(html).toContain("compressed for clients that send");
  });

  it("compresses a long answer for clients that accept it", async () => {
    const store = new SqliteStore(":memory:");
    for (let P = 1; P <= 300; P++) await store.insert(raw(4, 4, P, P, "ann"));
    open(store);
    const path = "/api/holder?name=ann";
    const plain = await app.request(path);
    expect(plain.headers.get("content-encoding")).toBeNull();
    const text = await plain.text();
    expect(text.length).toBeGreaterThan(1024);
    const packed = await app.request(path, { headers: { "accept-encoding": "gzip" } });
    expect(packed.headers.get("content-encoding")).toBe("gzip");
    const bytes = new Uint8Array(await packed.arrayBuffer());
    const unpacked = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
    expect(unpacked).toBe(text);
  });

  describe("the answers that are kept", () => {
    const MINUTE = 60_000;
    // Problems 1 to 4 of 4 sides in 4 are led by ann, 5 and 6 by bob, 7 by cat; dan leads nothing. The scores are
    // large, so that a packing sent through the routes takes the lead.
    const seeded = async () => {
      const store = new SqliteStore(":memory:");
      const led = [
        [1, "ann"],
        [2, "ann"],
        [3, "ann"],
        [4, "ann"],
        [5, "bob"],
        [6, "bob"],
        [7, "cat"],
      ] as const;
      for (const [P, name] of led) await store.insert(raw(4, 4, P, 100, name));
      return store;
    };
    const leads = async (name: string): Promise<number[]> =>
      ((await holder(name)).body.pairs as HolderPair[])[0]?.P ?? [];
    /** P squares in a row `gap` apart: the smaller the gap, the better the packing. */
    const send = (P: number, name: string, gap = 3) => submit({ ...squares(P, { name }), M: 4, pieces: row(P, gap) });

    it("are given as they were made for 15 minutes, whatever is submitted meanwhile, then made again once", async () => {
      const reads = open(await seeded());
      const text = async () => (await app.request("/api/holder?name=ann")).text();
      const first = await text();
      expect(JSON.parse(first)).toMatchObject({ name: "ann", site_bests: 4, computed_at: new Date(T0).toISOString() });
      expect(reads.names).toBe(1);
      // ann takes problem 5 from bob and improves problem 1
      now = T0 + 1000;
      expect((await send(5, "ann")).body.leader).toBe(true);
      expect((await send(1, "ann")).body.leader).toBe(true);
      expect((await get("/api/holders")).body.holders.find((h: Holder) => h.name === "ann").site_bests).toBe(5);
      for (const at of [1000, 5 * MINUTE, 15 * MINUTE - 1]) {
        now = T0 + at;
        expect(await text()).toBe(first);
      }
      expect(reads.names).toBe(1);
      // then it is made again, once, however many ask, and says when
      now = T0 + 15 * MINUTE;
      const together = await Promise.all([holder("ann"), holder("ann"), holder("ann")]);
      for (const { body } of together) {
        expect(body.pairs[0].P).toEqual([1, 2, 3, 4, 5]);
        expect(body.computed_at).toBe(new Date(now).toISOString());
      }
      expect(reads.names).toBe(2);
      // and it is given as it is made for 15 minutes more
      now += 14 * MINUTE;
      expect((await holder("ann")).body).toEqual(together[0]!.body);
      expect(reads.names).toBe(2);
    });

    it("are given when another name has taken a lead, until they are older than 15 minutes", async () => {
      const reads = open(await seeded());
      for (const name of ["ann", "bob", "cat", "dan"]) await holder(name);
      expect(reads.names).toBe(4);
      // cat takes problem 5 from bob
      expect((await send(5, "cat")).body.leader).toBe(true);
      now = T0 + 14 * MINUTE;
      expect(await leads("bob")).toEqual([5, 6]);
      expect(await leads("cat")).toEqual([7]);
      expect(reads.names).toBe(4);
      now = T0 + 15 * MINUTE;
      expect(await leads("bob")).toEqual([6]);
      expect(await leads("cat")).toEqual([5, 7]);
      expect(reads.names).toBe(6);
      expect(await leads("ann")).toEqual([1, 2, 3, 4]);
      expect(await leads("dan")).toEqual([]);
      expect(reads.names).toBe(8);
    });

    it("are made again once in 15 minutes for a name that submits all the time", async () => {
      const reads = open(await seeded());
      for (let i = 0; i < 60; i++) {
        // every half minute for half an hour, ann improves problem 2 and someone looks at her page
        now = T0 + 30_000 * (i + 1);
        expect((await send(2, "ann", 3 - i / 100)).body.leader).toBe(true);
        expect(await leads("ann")).toEqual([1, 2, 3, 4]);
      }
      // made at 0:30, and at 15:30: twice, not 60 times
      expect(reads.names).toBe(2);
    });

    it("are forgotten at once, for every name, when an administrator reviews, edits or removes an entry", async () => {
      const store = new SqliteStore(":memory:");
      for (const [P, name, verification] of [
        [1, "ann", "none"],
        [2, "ann", "none"],
        [3, "bob", "pending"],
        [4, "cat", "none"],
      ] as const)
        await store.insert(raw(4, 4, P, 10, name, verification));
      const reads = open(store);
      const idOf = async (P: number) => (await store.leader(4, 4, P))!.id;
      const asked = async () => {
        const out: Record<string, HolderResponse> = {};
        for (const name of ["ann", "bob", "cat", "dan"]) out[name] = (await holder(name)).body;
        return out;
      };
      let answers = await asked();
      expect(reads.names).toBe(4);
      expect(answers.bob).toMatchObject({ pending: 1, records: 0 });
      // answers made again are the same, with their time
      expect(await asked()).toEqual(answers);
      expect(reads.names).toBe(4);

      // a review: the claim is a record at once
      expect((await adminPost("/api/admin/review", { id: await idOf(3), decision: "confirmed" })).status).toBe(200);
      answers = await asked();
      expect(reads.names).toBe(8);
      expect(answers.bob).toMatchObject({ pending: 0, records: 1 });

      // a rename: the name that lost the entry, and the one that has it now
      expect((await adminPost("/api/admin/edit", { id: await idOf(2), name: "dan" })).status).toBe(200);
      answers = await asked();
      expect(reads.names).toBe(12);
      expect(answers.ann.pairs).toEqual([pair(4, 4, [1])]);
      expect(answers.dan.pairs).toEqual([pair(4, 4, [2])]);

      // a note only: nothing a page shows changes, and every answer is made again all the same
      const unchanged = answers;
      expect((await adminPost("/api/admin/edit", { id: await idOf(4), agent_note: "checked" })).status).toBe(200);
      answers = await asked();
      expect(reads.names).toBe(16);
      expect(answers).toEqual(unchanged);

      // a removal: the entry is gone from its name's page
      expect((await adminPost("/api/admin/remove", { id: await idOf(4) })).status).toBe(200);
      answers = await asked();
      expect(reads.names).toBe(20);
      expect(answers.cat).toEqual(zero("cat", new Date(T0).toISOString()));

      // the clock did not move: none of it waited for the age of an answer
      expect(now).toBe(T0);
    });

    it("are made once for the requests that arrive while they are made", async () => {
      const store = new SqliteStore(":memory:");
      // 1,200 problems of ann, in three pages; bob has an entry behind one of them
      for (let M = 3; M < 15; M++) for (let P = 1; P <= 100; P++) await store.insert(raw(4, M, P, 1, "ann"));
      await store.insert(raw(4, 3, 1, 2, "bob"));
      const reads = open(store);
      const together = await Promise.all([holder("ann"), holder("ann"), holder("bob"), holder("ann"), holder("bob")]);
      expect(together[0]!.body.site_bests).toBe(1200);
      expect(together[1]!.body).toEqual(together[0]!.body);
      expect(together[3]!.body).toEqual(together[0]!.body);
      expect(together[2]!.body).toEqual(zero("bob", new Date(T0).toISOString()));
      expect(together[4]!.body).toEqual(together[2]!.body);
      // ann: pages of 500, 500 and 200 problems; bob: one page of one problem
      expect(reads.pages).toBe(3 + 1);
      expect(reads.names).toBe(2);
      // and they are kept
      await holder("ann");
      expect(reads.pages).toBe(4);
    });

    it("are 32 at most, the ones asked longest ago going first", async () => {
      const store = new SqliteStore(":memory:");
      for (let i = 0; i < 40; i++) await store.insert(raw(4, 4, i + 1, 1, `n${i}`));
      const reads = open(store);
      for (let i = 0; i < 32; i++) await holder(`n${i}`);
      expect(reads.names).toBe(32);
      // asking n0 again makes it one of the newest
      await holder("n0");
      expect(reads.names).toBe(32);
      // so n1 goes when n32 comes, and n0 stays
      await holder("n32");
      expect(reads.names).toBe(33);
      await holder("n0");
      expect(reads.names).toBe(33);
      await holder("n1");
      expect(reads.names).toBe(34);
      for (let i = 33; i < 40; i++) await holder(`n${i}`);
      expect(reads.names).toBe(41);
      // 32 are kept, and n10 is the oldest of them
      await holder("n10");
      expect(reads.names).toBe(41);
      await holder("n9");
      expect(reads.names).toBe(42);
    });

    it("are given as they were made when a submission came while one was made", async () => {
      const store = new SqliteStore(":memory:");
      for (let P = 1; P <= 8; P++) await store.insert(raw(4, 4, P, 100, "ann"));
      const reads = open(store, [], { holderChunk: 1 });
      const real = store.problemsNamed.bind(store);
      let steps = 0;
      let sent: Promise<unknown> | null = null;
      vi.spyOn(store, "problemsNamed").mockImplementation(async (name, after, limit) => {
        // bob takes problem 1 after the first step has read it
        if (++steps === 2 && name === "ann") sent = send(1, "bob", 2);
        return real(name, after, limit);
      });
      expect(await leads("ann")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      await sent;
      expect((await get("/api/leaderboard/4/4/1")).body.entries[0].name).toBe("bob");
      now = T0 + 15 * MINUTE - 1;
      expect(await leads("ann")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(reads.names).toBe(1);
      now = T0 + 15 * MINUTE;
      expect(await leads("ann")).toEqual([2, 3, 4, 5, 6, 7, 8]);
      expect(reads.names).toBe(2);
    });

    describe("when an administrator's change comes while one is made", () => {
      // Eight problems of ann, one to a step; the second step has the removal of problem 1 (read by the first) follow it
      // in the turns. `during` runs once the removal is over, while the answer is still being made.
      const walk = async (during?: () => void) => {
        const store = new SqliteStore(":memory:");
        for (let P = 1; P <= 8; P++) await store.insert(raw(4, 4, P, 10, "ann"));
        const reads = open(store, [], { holderChunk: 1 });
        const real = store.problemsNamed.bind(store);
        let steps = 0;
        let removal: Promise<Response> | null = null;
        let removed = false;
        let ran = false;
        let doneAt = 0;
        vi.spyOn(store, "problemsNamed").mockImplementation(async (name, after, limit) => {
          steps++;
          if (steps === 2)
            removal = (async () => {
              const r = await adminPost("/api/admin/remove", { id: 1 });
              removed = true;
              return r;
            })();
          if (removed && !ran) {
            ran = true;
            doneAt = steps;
            during?.();
          }
          return real(name, after, limit);
        });
        return { reads, removal: () => removal!, ran: () => ran, doneAt: () => doneAt };
      };

      it("do not keep the answer being made", async () => {
        const w = await walk();
        const early = (await holder("ann")).body as HolderResponse;
        expect((await w.removal()).status).toBe(200);
        // the removal came in the middle of the walk, so that problem 1 was read before it
        expect(w.ran()).toBe(true);
        expect(w.doneAt()).toBeGreaterThan(2);
        expect(early.pairs[0]!.P).toContain(1);
        // that answer was not kept: the next request makes another, and problem 1 is not in it
        const pages = w.reads.pages;
        const late = (await holder("ann")).body as HolderResponse;
        expect(w.reads.pages).toBeGreaterThan(pages);
        expect(late.pairs[0]!.P).toEqual([2, 3, 4, 5, 6, 7, 8]);
        // and this one is kept
        const kept = w.reads.pages;
        expect((await holder("ann")).body).toEqual(late);
        expect(w.reads.pages).toBe(kept);
      });

      it("are not waited for by a request that comes after the change", async () => {
        let late: Promise<{ body: HolderResponse }> | null = null;
        const w = await walk(() => {
          late = holder("ann");
        });
        const early = (await holder("ann")).body as HolderResponse;
        expect((await w.removal()).status).toBe(200);
        expect(w.ran()).toBe(true);
        // the request that began before the change was given the problem; the one after it makes its own answer
        expect(early.pairs[0]!.P).toContain(1);
        const after = (await late!).body;
        expect(after.pairs[0]!.P).toEqual([2, 3, 4, 5, 6, 7, 8]);
        expect(w.reads.names).toBe(2);
        // which is the one kept
        await settle();
        const pages = w.reads.pages;
        expect((await holder("ann")).body).toEqual(after);
        expect(w.reads.pages).toBe(pages);
      });
    });

    it("let the event loop in between pages", async () => {
      const store = new SqliteStore(":memory:");
      for (let M = 3; M < 15; M++) for (let P = 1; P <= 100; P++) await store.insert(raw(4, M, P, 1, "ann"));
      open(store);
      const events: string[] = [];
      const real = store.problemsNamed.bind(store);
      vi.spyOn(store, "problemsNamed").mockImplementation(async (name, after, limit) => {
        expect(limit).toBe(HOLDER_CHUNK);
        events.push("page");
        return real(name, after, limit);
      });
      let ticking = true;
      const beat = () => {
        if (!ticking) return;
        events.push("tick");
        setImmediate(beat);
      };
      const answer = holder("ann");
      setImmediate(beat);
      expect((await answer).body.site_bests).toBe(1200);
      ticking = false;
      // three pages, and the loop got a turn between every two
      expect(events.filter((e) => e === "page")).toHaveLength(3);
      expect(events.join(" ")).not.toMatch(/page page/);
      expect(events.indexOf("tick")).toBeLessThan(events.lastIndexOf("page"));
    });

    it("equal the rows of /api/holders after a random walk of submissions and changes", async () => {
      const rand = prng(5);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
      const NAMES = ["ann", "Ann", "bob", "cat", "dan", "eve", "e v e", "a/b"];
      const records: LiteratureRecord[] = [];
      for (const M of [4, 0, 5])
        for (let P = 1; P <= 6; P++) {
          const kind = (M + 2 * P) % 4;
          const value = (gap: number) => evaluate({ ...squares(P), M, pieces: row(P, gap) }).score as number;
          if (kind === 1) records.push(published(M, P, value(1.15)));
          if (kind === 2) records.push(published(M, P, value(1), "proven"));
          if (kind === 3) records.push(published(M, P, value(1.3)));
        }
      const store = new SqliteStore(":memory:");
      for (let k = 0; k < 30; k++)
        await store.insert(
          raw(
            4,
            pick([4, 0, 5, 6, 7]),
            1 + Math.floor(rand() * 8),
            1 + rand() * 20,
            pick(NAMES),
            pick(["none", "none", "none", "pending", "confirmed"] as const),
          ),
        );
      // pages of three problems
      open(store, records, { holderChunk: 3 });
      /** After a change of an administrator the answers are right at once; after a submission, once they are old. */
      const check = async (afterAdmin: boolean) => {
        if (!afterAdmin) now += 16 * MINUTE;
        const rows = (await get("/api/holders")).body.holders as Holder[];
        let leads = 0;
        for (const name of NAMES) {
          const { pairs, computed_at, ...totals } = (await holder(name)).body as HolderResponse;
          expect(totals).toEqual(
            rows.find((r) => r.name === name) ?? { name, records: 0, beat_published: 0, site_bests: 0, pending: 0 },
          );
          expect(new Date(computed_at).getTime()).toBeLessThanOrEqual(now);
          expect(pairs.reduce((n, p) => n + p.P.length, 0)).toBe(totals.site_bests);
          for (const p of pairs) expect(p.P).toEqual([...p.P].sort((a, b) => a - b));
          leads += totals.site_bests;
        }
        return leads;
      };
      expect(await check(false)).toBeGreaterThan(0);
      let admin = false;
      for (let i = 0; i < 60; i++) {
        const r = rand();
        admin = r >= 0.6;
        if (!admin) {
          const P = 1 + Math.floor(rand() * 6);
          await submit({
            ...squares(P, { name: pick(NAMES) }),
            M: pick([4, 0, 5]),
            pieces: row(P, pick([1, 1.05, 1.2, 1.3])),
          });
        } else {
          const leaders = await store.leaders();
          const id = leaders.length ? pick(leaders).id : 1;
          if (r < 0.7) await adminPost("/api/admin/review", { id, decision: pick(["confirmed", "rejected"]) });
          else if (r < 0.85) await adminPost("/api/admin/remove", { id });
          else await adminPost("/api/admin/edit", { id, name: pick(NAMES) });
        }
        if (i % 4 === 3) await check(admin);
      }
      await check(false);
    });
  });
});

describe("the API page", () => {
  it("documents the snapshot and invites volunteers, with a link to their page", async () => {
    const page = await (await createApp({ store: new SqliteStore(":memory:"), records: [] }).request("/api")).text();
    expect(page).toContain('<h3 id="snapshot"><code>GET /api/snapshot</code></h3>');
    expect(page).toContain('<a href="/volunteer.html">volunteer client</a>');
    expect(page).toContain('<a href="/volunteer.html">Volunteer</a>');
  });
});

describe("the volunteer work list", () => {
  it("was removed: GET /api/targets is not a route", async () => {
    expect((await app.request("/api/targets")).status).toBe(404);
    expect((await app.request("/api/targets?limit=10")).status).toBe(404);
  });
});

// The corpus holds saved configurations with their score at their own container_phi and after an
// orientation search. Client and server share one scoring routine; this guards the shared routine
// against drift and checks that the HTTP path returns exactly what the client computes.
describe("client and server agree on the corpus", () => {
  const dir = resolve(import.meta.dirname, "../../../data/corpus");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    it(file, async () => {
      const saved = JSON.parse(readFileSync(resolve(dir, file), "utf8"));
      ip = file;
      // sent as saved: scored at its own phi
      const asSaved = await submit({ ...saved.config, name: file });
      expect(asSaved.body.score).toBe(evaluate(saved.config).score);
      expect(asSaved.body.score).toBeCloseTo(saved.expected_score, 9);
      // turned first, as every client does: exactly the client's score
      const client = evaluate(saved.config, { autoOrient: true });
      expect(client.valid).toBe(true);
      expect(client.score).toBeCloseTo(saved.oriented_score, 9);
      const turned = await submit({ ...saved.config, container_phi: client.container!.phi, name: file });
      expect(turned.body.score).toBe(client.score);
    });
  }
});

describe("GET /api/records/pairs", () => {
  it("lists the pairs with a published value or a listed entry, and follows new entries", async () => {
    expect((await get("/api/records/pairs")).body).toEqual({ pairs: [{ N: 4, M: 4, published: 1, site: false }] });
    expect((await submit({ ...squares(2), N: 4, M: 0, pieces: row(2) })).status).toBe(200);
    expect((await submit(squares(2))).status).toBe(200);
    expect((await get("/api/records/pairs")).body.pairs).toEqual([
      { N: 4, M: 0, published: 0, site: true },
      { N: 4, M: 4, published: 1, site: true },
    ]);
  });

  // The route keeps the pairs with a listed entry in memory (see createApp). Each test below builds its own
  // app on a store whose `pairs` is counted: that is the one query that scans every entry.
  const admin = (path: string, body: object) =>
    app.request(path, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const pairsApp = (records: LiteratureRecord[] = [fakeRecord], store = new SqliteStore(":memory:")) => {
    const reads = vi.spyOn(store, "pairs");
    app = createApp({ store, records, adminToken: "secret", clientIp: () => ip, log: (m) => logs.push(m) });
    return { store, reads };
  };
  const pairsText = async () => (await app.request("/api/records/pairs")).text();
  const sites = async () =>
    Object.fromEntries(
      (await get("/api/records/pairs")).body.pairs.map((p: { N: number; M: number; site: boolean }) => [
        `${p.N}/${p.M}`,
        p.site,
      ]),
    );
  // an entry for the store itself, without a packing: one problem (P = 1) of the pair N/M
  const seedEntry = (N: number, M: number): NewSubmission => ({
    N,
    M,
    P: 1,
    score: 1,
    name: "ann",
    agent_note: "",
    found_with: "hand",
    method: null,
    method_params: null,
    seed: null,
    budget: null,
    software: null,
    pieces: [],
    container_phi: 0,
    created_at: "2026-10-21T00:00:00.000Z",
    verification: "none",
    literature_value: null,
    strict_check: null,
  });
  // two or more squares in a row in a circle: an entry of the pair 4/0, which has no published value
  const circle = (P: number, name = "ann") => ({ ...squares(P, { name }), M: 0 });
  // three squares in a corner of a square of side 2: a claim that beats the published 5 of fakeRecord
  const claim = (name: string) => ({
    ...squares(3, { name }),
    pieces: [
      { x: 0, y: 0, theta: SQ },
      { x: 1, y: 0, theta: SQ },
      { x: 0, y: 1, theta: SQ },
    ],
  });

  it("reads the store once, however many entries arrive after", async () => {
    const { reads } = pairsApp();
    expect(await sites()).toEqual({ "4/4": false });
    expect(reads).toHaveBeenCalledTimes(1);
    // entries of a pair that has one already, of new pairs, and an entry that is deleted at once
    for (const body of [squares(2), squares(4), circle(2), circle(2, "bob"), squares(2, { name: "cat" })]) {
      expect((await submit(body)).status).toBe(200);
      await get("/api/records/pairs");
    }
    expect(await sites()).toEqual({ "4/0": true, "4/4": true });
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it("is told of a pair that had nothing by its first entry", async () => {
    const { reads } = pairsApp();
    expect(await sites()).toEqual({ "4/4": false });
    // a pair with a published value gains its site entry, and a pair without anything appears
    expect((await submit(squares(2))).status).toBe(200);
    expect(await sites()).toEqual({ "4/4": true });
    expect((await submit(circle(2))).status).toBe(200);
    expect((await get("/api/records/pairs")).body).toEqual({
      pairs: [
        { N: 4, M: 0, published: 0, site: true },
        { N: 4, M: 4, published: 1, site: true },
      ],
    });
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it("reads the store again only where an entry can leave the listing", async () => {
    const { reads } = pairsApp();
    const lone = (await submit(circle(2))).body.id;
    const pending = (await submit(claim("dan"))).body;
    expect(pending.pending_verification).toBe(true);
    expect(await sites()).toEqual({ "4/0": true, "4/4": true });
    expect(reads).toHaveBeenCalledTimes(1);

    // an edit and a confirmation leave every entry where it was
    expect((await admin("/api/admin/edit", { id: lone, name: "ann the second" })).status).toBe(200);
    expect((await admin("/api/admin/review", { id: pending.id, decision: "confirmed" })).status).toBe(200);
    expect(await sites()).toEqual({ "4/0": true, "4/4": true });
    expect(reads).toHaveBeenCalledTimes(1);

    // the only entry of a pair removed: the pair goes, the published pair stays, without a site entry
    expect((await admin("/api/admin/remove", { id: lone })).status).toBe(200);
    expect(await sites()).toEqual({ "4/4": true });
    expect(reads).toHaveBeenCalledTimes(2);
    expect((await admin("/api/admin/remove", { id: pending.id })).status).toBe(200);
    expect((await get("/api/records/pairs")).body).toEqual({ pairs: [{ N: 4, M: 4, published: 1, site: false }] });
    expect(reads).toHaveBeenCalledTimes(3);

    // a rejected claim, the pair's only entry
    const second = (await submit(claim("eve"))).body;
    expect(await sites()).toEqual({ "4/4": true });
    expect((await admin("/api/admin/review", { id: second.id, decision: "rejected" })).status).toBe(200);
    expect(await sites()).toEqual({ "4/4": false });
    expect(reads).toHaveBeenCalledTimes(4);

    // nothing was changed by a refused request
    expect((await admin("/api/admin/remove", { id: second.id })).status).toBe(404);
    expect((await admin("/api/admin/review", { id: second.id, decision: "rejected" })).status).toBe(404);
    expect(await sites()).toEqual({ "4/4": false });
    expect(reads).toHaveBeenCalledTimes(4);
  });

  it("keeps a pair whose entry was removed while another stays", async () => {
    pairsApp();
    const first = (await submit(circle(2))).body.id;
    // another problem of the same pair
    expect((await submit(circle(3))).status).toBe(200);
    expect(await sites()).toEqual({ "4/0": true, "4/4": false });
    expect((await admin("/api/admin/remove", { id: first })).status).toBe(200);
    expect(await sites()).toEqual({ "4/0": true, "4/4": false });
  });

  it("gives the answer the route gave when every request read the store", async () => {
    // a few published pairs, with entries on some of them and on pairs with nothing published; 10 and 12
    // sort after 4 as numbers and before it as text
    const rec = (N: number, M: number, P: number): LiteratureRecord => ({ ...fakeRecord, N, M, P });
    const records = [rec(4, 4, 3), rec(4, 4, 5), rec(3, 3, 2), rec(0, 4, 1), rec(12, 5, 7), rec(10, 3, 1)];
    // the route as it was: the published counts and one query for every answer
    const before = async (store: SqliteStore) => {
      const published = new Map<string, number>();
      for (const r of records) published.set(`${r.N}/${r.M}`, (published.get(`${r.N}/${r.M}`) ?? 0) + 1);
      const site = new Set((await store.pairs()).map(({ N, M }) => `${N}/${M}`));
      const keys = new Set([...published.keys(), ...site]);
      const pairs = [...keys]
        .map((k) => k.split("/").map(Number) as [number, number])
        .sort((a, b) => a[0] - b[0] || a[1] - b[1])
        .map(([N, M]) => ({ N, M, published: published.get(`${N}/${M}`) ?? 0, site: site.has(`${N}/${M}`) }));
      return JSON.stringify({ pairs });
    };
    const store = new SqliteStore(":memory:");
    const ids = new Map<string, number>();
    for (const [N, M] of [
      [4, 4],
      [10, 3],
      [3, 3],
      [5, 12],
      [11, 11],
      [0, 0],
      [20, 3],
    ])
      ids.set(`${N}/${M}`, await store.insert(seedEntry(N, M)));
    pairsApp(records, store);
    expect(await pairsText()).toBe(await before(store));
    // entries through the API, on a pair with nothing and on one with a published value
    expect((await submit(circle(2))).status).toBe(200);
    expect((await submit({ ...squares(2), N: 4, M: 5, pieces: row(2) })).status).toBe(200);
    expect(await pairsText()).toBe(await before(store));
    expect((await get("/api/records/pairs")).body.pairs.length).toBeGreaterThan(8);
    // and after entries leave
    for (const key of ["10/3", "0/0"])
      expect((await admin("/api/admin/remove", { id: ids.get(key) })).status).toBe(200);
    expect(await pairsText()).toBe(await before(store));
    const shown = (await get("/api/records/pairs")).body.pairs.map((p: { N: number; M: number }) => `${p.N}/${p.M}`);
    expect(shown).toEqual(["0/4", "3/3", "4/0", "4/4", "4/5", "5/12", "10/3", "11/11", "12/5", "20/3"]);
  });

  // A store that answers when it is told to, as a hosted one does after a network round trip.
  const slowReading = (reads: ReturnType<typeof pairsApp>["reads"], store: SqliteStore) => {
    const real = SqliteStore.prototype.pairs.bind(store);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // the first reading takes its rows at once and returns them when the gate opens
    reads.mockImplementationOnce(async () => {
      const rows = await real();
      await gate;
      return rows;
    });
    return release;
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it("lets requests that arrive during a reading share it", async () => {
    const { store, reads } = pairsApp();
    const release = slowReading(reads, store);
    const answers = [1, 2, 3].map(() => pairsText());
    await settle();
    expect(reads).toHaveBeenCalledTimes(1);
    release();
    const [a, b, c] = await Promise.all(answers);
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it("does not lose an entry added during a reading", async () => {
    const { store, reads } = pairsApp();
    const release = slowReading(reads, store);
    const answer = pairsText();
    await settle();
    // the reading holds the rows from before this entry
    expect((await submit(circle(2))).status).toBe(200);
    release();
    expect(JSON.parse(await answer).pairs).toEqual([
      { N: 4, M: 0, published: 0, site: true },
      { N: 4, M: 4, published: 1, site: false },
    ]);
    expect(await sites()).toEqual({ "4/0": true, "4/4": false });
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it("does not keep a pair removed during a reading", async () => {
    const store = new SqliteStore(":memory:");
    const gone = await store.insert(seedEntry(4, 0));
    const { reads } = pairsApp([fakeRecord], store);
    const release = slowReading(reads, store);
    const answer = pairsText();
    await settle();
    // the reading holds the rows from before the removal
    expect((await admin("/api/admin/remove", { id: gone })).status).toBe(200);
    release();
    expect(JSON.parse(await answer).pairs).toEqual([{ N: 4, M: 4, published: 1, site: false }]);
    expect(await sites()).toEqual({ "4/4": false });
    // the reading that overlapped the removal was done again
    expect(reads).toHaveBeenCalledTimes(2);
  });
});
